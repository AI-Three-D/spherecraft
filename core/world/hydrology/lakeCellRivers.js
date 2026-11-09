// core/world/hydrology/lakeCellRivers.js
//
// Rivers out of the lakes of the 'lakeLand' terrain (LAKE_CELLS_PLAN.md).
// Each lake drains the way its water would: a priority flood from all of its
// water over a shared height grid (cells of about cellM on the cube faces,
// sampled from the lake terrain through the lake table, a tile at a time as
// the flood reaches it), lowest ground first, cutting through rises of at
// most maxChannelCutM, until it reaches a lower lake, ground below the sea or
// an earlier river. So a river leaves its lake at the lowest point of the
// rim, follows the valleys and crosses a ridge at its lowest saddle. The
// course, profile and record come from the regional planner's steps
// (regionalRiverCourse, packRegionalRiver). Planned once per lake (by key),
// highest lakes first; a publication maps lake keys to its ids.

import { MinHeap, dirToCell, faceUVToDir } from './waterGraph.js';
import { tangentBasis, planeToDir, dirToPlane } from './lakeRefine.js';
import { regionalRiverCourse } from '../terrain-generator/regionalRiverCourse.js';
import { packRegionalRiver } from '../terrain-generator/regionalDrainage.js';
import { lakeCellMask } from '../terrain-generator/lakeCellShape.js';
import { LakeTable } from '../terrain-generator/lakeTable.js';

export const LAKE_CELL_RIVER_OPTIONS = Object.freeze({ enabled: true, carve: true,
    // Flood: grid cell (m, at a face centre), tile edge (cells), the drop to
    // a receiving lake, lakes too small for a river (shape extent, m), and
    // budgets per river; the flood yields after sliceMs.
    cellM: 128, tileCells: 32, minimumDropM: 2, minLakeExtentM: 200, maxLengthM: 40000, maxVisited: 200000,
    // A lake drains no farther than lengthPerExtent x its half-length (shape
    // extent): small lakes feed short rivers to nearby lakes, long rivers run
    // between big ones (owner 2026-11-09: tiny lakes cannot drain 10+ km).
    lengthPerExtent: 6,
    // Lakes planned when within this of the camera, nearest first.
    planRadiusM: 40000,
    sliceMs: 4, maxTiles: 2000,
    // Records of its own lake table (the generator's pipelines, its own
    // records: planning never evicts what terrain tiles are about to read).
    tableRecords: 32768,
    // Half-width by the source lake's size: min + perM x extent, up to max.
    halfWidthMinM: 3, halfWidthPerM: 0.003, halfWidthMaxM: 18,
    // The regional planner's course and profile.
    // The flood cuts at most maxChannelCutM - floodCutMarginM through rises on
    // its cells (the smoothed course and its banks cut a little more).
    floodCutMarginM: 4,
    profile: 'terrain', profileStepM: 16, maxProfilePoints: 1024, maxChannelCutM: 24, fallExtraCutM: 4, fallRunM: 1.5,
    course: 'organic', heightSource: 'natural' });

const OWN_LEVEL_EPS = 0.001;
// Flood order: ground height, then path length (1 m per km) on flats.
const LENGTH_KEY = 0.001;

const yieldFrame = () => new Promise(r => setTimeout(r, 0));

// Heights and lake water on cube-face cells, sampled in tiles on demand.
export class RiverHeightGrid {
    constructor(table, R, { cellM, tileCells, maxTiles }) {
        this.table = table;
        this.R = R;
        this.T = tileCells;
        this.N = 2 ** Math.ceil(Math.log2(2 * R / cellM));
        this.per = this.N / this.T;
        this.maxTiles = maxTiles;
        this.tiles = new Map();   // tile key -> Float32Array(T * T * 3): height, lake level, lake tier
        this.samples = 0;
    }

    id(face, i, j) { return (face * this.N + j) * this.N + i; }
    _split(id) { const N = this.N, NN = N * N; return [Math.floor(id / NN), id % N, Math.floor((id % NN) / N)]; }
    dir(id) { const [f, i, j] = this._split(id); return faceUVToDir(f, (i + 0.5) / this.N, (j + 0.5) / this.N); }
    cellOf(dir) { return dirToCell(dir, this.N); }
    _tileKey(id) {
        const [f, i, j] = this._split(id), T = this.T;
        return (f * this.per + Math.floor(j / T)) * this.per + Math.floor(i / T);
    }
    has(id) { return this.tiles.has(this._tileKey(id)); }
    _at(id) {
        const [, i, j] = this._split(id), T = this.T;
        return [this.tiles.get(this._tileKey(id)), ((j % T) * T + (i % T)) * 3];
    }
    h(id) { const [t, k] = this._at(id); return t[k]; }
    level(id) { const [t, k] = this._at(id); return t[k + 1]; }
    tier(id) { const [t, k] = this._at(id); return t[k + 2]; }

    // The eight neighbours (across face edges through their directions).
    neighbours(id) {
        const [f, i, j] = this._split(id), N = this.N, out = [];
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
            if (!di && !dj) continue;
            const ii = i + di, jj = j + dj;
            out.push(ii >= 0 && jj >= 0 && ii < N && jj < N ? this.id(f, ii, jj)
                : dirToCell(faceUVToDir(f, (ii + 0.5) / N, (jj + 0.5) / N), N));
        }
        return out;
    }

    // Loads the tiles of these cells.
    async load(ids) {
        const T = this.T, per = this.per, keys = new Set();
        for (const id of ids) keys.add(this._tileKey(id));
        const fresh = [...keys].filter(k => !this.tiles.has(k));
        if (!fresh.length) return;
        const N = this.N, dirs = new Float32Array(fresh.length * T * T * 4), areas = [];
        fresh.forEach((k, n) => {
            const f = Math.floor(k / (per * per)), tj = Math.floor((k % (per * per)) / per), ti = k % per;
            areas.push({ dir: faceUVToDir(f, (ti + 0.5) * T / N, (tj + 0.5) * T / N), radiusM: 0.75 * T * 2 * this.R / N, texelM: 0 });
            for (let j = 0; j < T; j++) for (let i = 0; i < T; i++) {
                dirs.set(faceUVToDir(f, (ti * T + i + 0.5) / N, (tj * T + j + 0.5) / N), ((n * T + j) * T + i) * 4);
            }
        });
        this.table.ensure(areas);
        const out = await this.table.sampleWater(dirs);
        this.samples += fresh.length * T * T;
        fresh.forEach((k, n) => this.tiles.set(k, out.slice(n * T * T * 3, (n + 1) * T * T * 3)));
    }

    // Past the cap, the oldest tiles go (between floods only).
    trim() {
        for (const k of this.tiles.keys()) { if (this.tiles.size <= this.maxTiles) break; this.tiles.delete(k); }
    }
}

export class LakeCellRivers {
    // table: the lake table to plan on (tests); by default its own, sharing
    // the generator's pipelines (ready()).
    constructor({ device, gen, table = null, options = {} }) {
        this.device = device;
        this.gen = gen;
        this.R = gen.planetConfig.radius;
        this.options = { ...LAKE_CELL_RIVER_OPTIONS, ...options };
        this.table = table;
        this._ready = table ? Promise.resolve(table) : (async () => {
            const t = new LakeTable(gen, { records: this.options.tableRecords });
            await t.initialize({ share: gen.lakeTable });
            return (this.table = t);
        })();
        this.grid = null;
        // Sea level, as the shader has it (HydrologyGrid): waterParams.y x maxTerrainHeightM.
        gen._fillTerrainUniformScratch(0, 0, 128, 1, 0);
        const uv = new DataView(gen._terrainUniformScratch);
        this.seaLevelM = uv.getFloat32(116, true) * Math.max(uv.getFloat32(184, true), 1);
        this.byKey = new Map();       // source lake key -> { river, dest } | { none } | { failed }
        this.riverCells = new Map();  // grid cell -> { key, level, dir }: where earlier rivers run
        this.stats = { planned: 0, byDest: { lake: 0, sea: 0, river: 0 }, none: {}, failed: 0, lastError: null,
            lengthsM: [], floodCells: 0, floodCellsByOutcome: {}, ms: 0, longestSliceMs: 0, longestCourseMs: 0, longestIndexMs: 0 };
    }

    _halfWidth(lake) {
        const o = this.options;
        return Math.min(o.halfWidthMaxM, o.halfWidthMinM + o.halfWidthPerM * lake.shape.extent);
    }

    // Plans rivers for up to `budget` lakes without one: within planRadiusM
    // of nearDir (a unit direction), nearest first, or else highest first.
    // Returns how many lakes it took.
    /** Its lake table, once made. */
    ready() {
        return this._ready;
    }

    async plan(lakes, budget = 6, nearDir = null) {
        await this._ready;
        this.grid ??= new RiverHeightGrid(this.table, this.R, this.options);
        const o = this.options, R = this.R;
        let todo = lakes.filter(l => !this.byKey.has(l.key));
        if (nearDir) {
            const dist = l => Math.acos(Math.min(1, l.centre[0] * nearDir[0] + l.centre[1] * nearDir[1] + l.centre[2] * nearDir[2])) * R;
            todo = todo.map(l => [l, dist(l)]).filter(([, d]) => d <= o.planRadiusM).sort((a, b) => a[1] - b[1]).map(([l]) => l);
        } else todo.sort((a, b) => b.level - a.level);
        todo = todo.slice(0, budget);
        for (const src of todo) {
            if (src.shape.extent < o.minLakeExtentM) { this.byKey.set(src.key, { none: 'small' }); this._none('small'); continue; }
            const t0 = performance.now();
            try {
                const flood = await this._flood(src);
                if (flood.none) { this.byKey.set(src.key, { none: flood.none }); this._none(flood.none); continue; }
                const built = await this._build(src, flood, lakes);
                this.byKey.set(src.key, built);
                this.stats.planned++;
                this.stats.byDest[built.dest.kind]++;
                this.stats.lengthsM.push(Math.round(built.river.lengthM));
                this._markRiver(src.key, built.river);
            } catch (e) {
                this.byKey.set(src.key, { failed: true });
                this.stats.failed++;
                this.stats.lastError = String(e?.message ?? e);
            } finally { this.stats.ms += performance.now() - t0; this.grid.trim(); }
        }
        return todo.length;
    }

    _none(why) { this.stats.none[why] = (this.stats.none[why] ?? 0) + 1; }

    // The flood from the lake's water: { path (cells, lake to receiver),
    // kind, level, ... } or { none: why }.
    async _flood(src) {
        const g = this.grid, o = this.options, R = this.R, sea = this.seaLevelM;
        const maxLengthM = Math.min(o.maxLengthM, o.lengthPerExtent * src.shape.extent);
        const own = lv => Math.abs(lv - src.level) < OWN_LEVEL_EPS;
        // Cells under the lake's containment area (its mask) and its centre.
        const { mask, frame } = lakeCellMask(src), cand = new Set([g.cellOf(src.centre)]);
        for (let j = 0; j < frame.ny; j++) for (let i = 0; i < frame.nx; i++) {
            if (mask[j * frame.nx + i]) cand.add(g.cellOf(planeToDir(frame.x0 + (i + 0.5) * frame.spacing, frame.y0 + (j + 0.5) * frame.spacing, frame, R)));
        }
        await g.load(cand);
        const st = new Map(), heap = new MinHeap(4096), closed = new Set();
        const push = (id, level, parent, len, h) => { st.set(id, { level, parent, len }); heap.push(h + LENGTH_KEY * len, id); };
        for (const id of cand) if (own(g.level(id)) && g.h(id) < src.level) push(id, src.level, -1, 0, g.h(id));
        if (!heap.size) { const c = g.cellOf(src.centre); push(c, src.level, -1, 0, g.h(c)); }
        let slice = performance.now();
        while (heap.size) {
            const id = heap.pop();
            if (closed.has(id)) continue;
            closed.add(id);
            this.stats.floodCells++;
            if (closed.size > o.maxVisited) return this._outcome(closed, { none: 'budget' });
            const s = st.get(id), h = g.h(id), lv = g.level(id);
            if (lv > h && !own(lv)) {
                // Another lake's water: lower ones receive, the rest block.
                if (lv < src.level - o.minimumDropM) return this._outcome(closed, { path: this._path(st, id), kind: 'lake', level: lv, tier: g.tier(id), end: id });
                continue;
            }
            if (!(lv > h) && h <= sea) return this._outcome(closed, { path: this._path(st, id), kind: 'sea', level: sea, end: id });
            // An earlier river in this cell or next to it (two courses could
            // otherwise run side by side down one valley, a cell apart).
            const nb = g.neighbours(id);
            let rv = this.riverCells.get(id);
            for (const n of nb) { const r = this.riverCells.get(n); if (r && (!rv || r.level < rv.level)) rv = r; }
            if (rv && rv.level <= s.level + 0.3 && rv.level < src.level - 0.1) return this._outcome(closed, { path: this._path(st, id), kind: 'river', level: rv.level, trunk: rv, end: id });
            const missing = nb.filter(n => !g.has(n));
            if (missing.length) {
                const ran = performance.now() - slice;
                this.stats.longestSliceMs = Math.max(this.stats.longestSliceMs, ran);
                await g.load(missing);
                slice = performance.now();
            }
            const d0 = g.dir(id);
            for (const n of nb) {
                if (closed.has(n) || st.has(n)) continue;
                const hn = g.h(n), ln = g.level(n), d1 = g.dir(n);
                const len = s.len + Math.hypot(d1[0] - d0[0], d1[1] - d0[1], d1[2] - d0[2]) * R;
                if (len > maxLengthM) continue;
                const level = ln > hn && own(ln) ? src.level : Math.max(sea, Math.min(s.level, hn + 0.2));
                if (hn - level + 1.8 > o.maxChannelCutM - o.floodCutMarginM) continue;
                push(n, level, id, len, hn);
            }
            const ran = performance.now() - slice;
            if (ran > o.sliceMs) {
                this.stats.longestSliceMs = Math.max(this.stats.longestSliceMs, ran);
                await yieldFrame();
                slice = performance.now();
            }
        }
        return this._outcome(closed, { none: 'enclosed' });
    }

    _outcome(closed, r) {
        const k = r.none ?? r.kind, b = (this.stats.floodCellsByOutcome[k] ??= { floods: 0, cells: 0, max: 0 });
        b.floods++; b.cells += closed.size; b.max = Math.max(b.max, closed.size);
        return r;
    }

    _path(st, end) {
        const path = [];
        for (let k = end; k >= 0; k = st.get(k).parent) path.push(k);
        return path.reverse();
    }

    // Course, profile and record of a flood's path.
    async _build(src, flood, lakes) {
        const g = this.grid, o = this.options, R = this.R, halfWidthM = this._halfWidth(src), t0 = performance.now();
        const cells = flood.path.slice();
        // Into the receiver past its edge (the river's end hides in its water):
        // along the lowest bed of the receiving lake or the sea.
        const inside = id => flood.kind === 'lake' ? Math.abs(g.level(id) - flood.level) < OWN_LEVEL_EPS && g.h(id) < flood.level
            : flood.kind === 'sea' && g.h(id) <= this.seaLevelM;
        for (let k = 0; flood.kind !== 'river' && k < Math.ceil(6 * halfWidthM / o.cellM) + 1; k++) {
            const last = cells.at(-1), nb = g.neighbours(last).filter(n => g.has(n) && inside(n) && !cells.includes(n));
            if (!nb.length) break;
            cells.push(nb.reduce((a, b) => (g.h(b) < g.h(a) ? b : a)));
        }
        const dirs = cells.map(id => g.dir(id));
        if (flood.kind === 'river') dirs.push(flood.trunk.dir);
        const mid = dirs[Math.floor(dirs.length / 2)];
        const frame = { c: mid, ...tangentBasis(mid) };
        const line = dirs.map(d => dirToPlane(d, frame, R));
        // Heights for the course's bends: a corridor of grid cells along the line.
        const sp = o.cellM, xs = line.map(p => p[0]), ys = line.map(p => p[1]);
        frame.spacing = sp;
        frame.x0 = Math.floor((Math.min(...xs) - 6 * sp) / sp) * sp;
        frame.y0 = Math.floor((Math.min(...ys) - 6 * sp) / sp) * sp;
        frame.nx = Math.ceil((Math.max(...xs) + 6 * sp - frame.x0) / sp) + 1;
        frame.ny = Math.ceil((Math.max(...ys) + 6 * sp - frame.y0) / sp) + 1;
        const heights = new Float32Array(frame.nx * frame.ny).fill(Infinity);
        for (const [x, y] of line) {
            const ci = Math.round((x - frame.x0) / sp), cj = Math.round((y - frame.y0) / sp);
            for (let b = -3; b <= 3; b++) for (let a = -3; a <= 3; a++) {
                const k = (cj + b) * frame.nx + ci + a;
                if (heights[k] !== Infinity) continue;
                const id = g.cellOf(planeToDir(frame.x0 + (ci + a) * sp, frame.y0 + (cj + b) * sp, frame, R));
                if (g.has(id)) heights[k] = g.h(id);
            }
        }
        let lengthLine = 0;
        for (let k = 1; k < line.length; k++) lengthLine += Math.hypot(line[k][0] - line[k - 1][0], line[k][1] - line[k - 1][1]);
        const stepM = Math.max(o.profileStepM, Math.ceil(lengthLine / (0.85 * o.maxProfilePoints)));
        this.stats.longestCorridorMs = Math.max(this.stats.longestCorridorMs ?? 0, performance.now() - t0);
        await yieldFrame();
        const t1 = performance.now();
        // Where the line leaves the lake and meets the receiver (for the bends' taper).
        let exit = 0;
        while (exit + 1 < flood.path.length && Math.abs(g.level(flood.path[exit + 1]) - src.level) < OWN_LEVEL_EPS) exit++;
        const arcTo = n => { let s = 0; for (let k = 1; k <= n; k++) s += Math.hypot(line[k][0] - line[k - 1][0], line[k][1] - line[k - 1][1]); return s; };
        const sm = regionalRiverCourse({ line, frame, heights, halfWidthM, sourceLevelM: src.level, targetLevelM: flood.level,
            sourceRadiusM: arcTo(exit), targetRadiusM: lengthLine - arcTo(flood.path.length - 1), maxChannelCutM: o.maxChannelCutM,
            stepM, maxPoints: o.maxProfilePoints });
        // The course's own wet ends, on its points (not the grid's cells): the
        // last point in the source lake's water from the start, the first in
        // the receiver's after it.
        const n = sm.s.length, cd = new Float32Array(n * 4);
        for (let k = 0; k < n; k++) cd.set([...planeToDir(sm.x[k], sm.y[k], frame, R), 0], k * 4);
        const cw = await this.table.sampleWater(cd);
        const inSource = k => Math.abs(cw[k * 3 + 1] - src.level) < OWN_LEVEL_EPS && cw[k * 3] < src.level;
        const inTarget = k => flood.kind === 'lake' ? Math.abs(cw[k * 3 + 1] - flood.level) < OWN_LEVEL_EPS && cw[k * 3] < flood.level
            : flood.kind === 'sea' && !(cw[k * 3 + 1] > cw[k * 3]) && cw[k * 3] <= this.seaLevelM;
        let ks = 0;
        while (ks + 1 < n && inSource(ks + 1)) ks++;
        let kt = n - 1;
        if (flood.kind !== 'river') for (let k = ks + 1; k < n; k++) if (inTarget(k)) { kt = k; break; }
        const sourceEndM = sm.s[ks], targetStartM = sm.s[kt];
        this.stats.longestCourseMs = Math.max(this.stats.longestCourseMs, performance.now() - t1);
        if (targetStartM - sourceEndM < 4 * halfWidthM) throw new Error('River too short between its lakes');
        if (!(flood.level < src.level - 0.1)) throw new Error('River receiver not below its source');
        // Heights for the profile: the water's surface where a lake's water
        // lies, else the ground. A lake's bed read as a bank pulled the river
        // 4.5 m below its own lake at the outlet, a step between the two
        // surfaces (owner 2026-11-09; lakeRiverEndCheck.mjs).
        const certifier = async sites => {
            const t0 = performance.now(), d4 = new Float32Array(sites.length * 4);
            sites.forEach((s, i) => d4.set([...s.centre, 0], i * 4));
            const w = await this.table.sampleWater(d4), output = new Float32Array(sites.length * 4);
            for (let i = 0; i < sites.length; i++) output[i * 4] = Math.max(w[i * 3], w[i * 3 + 1]);
            return { output, wallMs: performance.now() - t0, uploadBytes: d4.byteLength };
        };
        const dest = flood.kind === 'lake' ? { kind: 'lake', key: this._lakeKey(flood, lakes), level: flood.level, tier: flood.tier, dir: g.dir(flood.end) }
            : flood.kind === 'river' ? { kind: 'river', key: flood.trunk.key } : { kind: 'sea' };
        const { river, indexMs } = await packRegionalRiver({ gen: this.gen, frame, sm, source: { id: 0, levelM: src.level, radiusM: 0 },
            receiver: { id: 1, levelM: flood.level, radiusM: 0 },
            portals: { source: { arcM: sourceEndM, kind: 'lake-cell-water' }, receiver: { arcM: targetStartM, kind: `lake-cell-${flood.kind}` } },
            sourceEndM, targetStartM, options: { ...o, halfWidthM, riverId: 0 }, certifier, dest: { kind: flood.kind }, pause: yieldFrame });
        this.stats.longestIndexMs = Math.max(this.stats.longestIndexMs, indexMs);
        // Its mouths (riverMouth.js): where it leaves the source's water and
        // enters the receiver's. The river field bakes the lakes' water into
        // its pages from them, and carries the river on into its lakes;
        // without them the pages had no lake water (half a lake missing near
        // a river: owner 2026-11-09) and the ends just faded.
        const portals = river.course.portals, landM = Math.min(Math.max(halfWidthM * 8, 64), 144);
        river.mouths = [{ s: portals.source.arcM, level: src.level, hw: halfWidthM, sign: -1, landM }];
        if (flood.kind !== 'river') river.mouths.push({ s: portals.receiver.arcM, level: flood.level, hw: halfWidthM, sign: 1, landM });
        if (river.mouths.length === 2) for (const m of river.mouths) m.landM = Math.min(m.landM, Math.max(1, 0.45 * Math.abs(river.mouths[1].s - river.mouths[0].s)));
        return { river, dest };
    }

    // The receiving lake's key in a lake list (same level and tier, nearest), or null.
    _lakeKey(dest, lakes) {
        let best = null, bestD = Infinity;
        const d = dest.dir ?? this.grid.dir(dest.end);
        for (const l of lakes) {
            if (Math.abs(l.level - dest.level) >= OWN_LEVEL_EPS || l.tier !== dest.tier) continue;
            const dd = 1 - (l.centre[0] * d[0] + l.centre[1] * d[1] + l.centre[2] * d[2]);
            if (dd < bestD) { bestD = dd; best = l.key; }
        }
        return best;
    }

    // A planned river's cells: later rivers join it there.
    _markRiver(key, river) {
        const P = river.points, st = river.stride;
        for (let k = 0; k < P.length / st; k++) {
            const d = [P[k * st], P[k * st + 1], P[k * st + 2]], id = this.grid.cellOf(d);
            if (P[k * st + 9] < 0) continue;   // in a lake (pool)
            if (!this.riverCells.has(id)) this.riverCells.set(id, { key, level: P[k * st + 3], dir: d });
        }
    }

    // River records for a publication: lake ids are places (idOf: key -> id).
    recordsFor(idOf, lakes = []) {
        const out = [], idOfRiver = new Map();
        for (const [key, v] of this.byKey) {
            if (!v.river || !idOf.has(key)) continue;
            idOfRiver.set(key, out.length);
            out.push({ key, v });
        }
        return out.map(({ key, v }, id) => {
            let dest = { kind: v.dest.kind };
            if (v.dest.kind === 'lake') {
                v.dest.key ??= this._lakeKey(v.dest, lakes);
                dest = { kind: 'lake', id: idOf.get(v.dest.key) ?? -1 };
            } else if (v.dest.kind === 'river') dest = { kind: 'river', id: idOfRiver.get(v.dest.key) ?? -1 };
            // The same record object while nothing about it changed (applied once).
            const p = v.published;
            if (p && p.id === id && p.fromLake === idOf.get(key) && p.dest.kind === dest.kind && p.dest.id === dest.id) return p;
            return (v.published = { ...v.river, id, riverId: id, fromLake: idOf.get(key), dest });
        });
    }
}
