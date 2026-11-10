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
import { RIVER_SHAPE_DEFAULTS, riverReachShape } from './riverRefine.js';

export const LAKE_CELL_RIVER_OPTIONS = Object.freeze({ enabled: true, carve: true,
    // Flood: grid cell (m, at a face centre), tile edge (cells), the drop to
    // a receiving lake, lakes too small for a river (shape extent, m), and
    // budgets per river; the flood yields after sliceMs.
    cellM: 128, tileCells: 32, minimumDropM: 2, minLakeExtentM: 350, maxLengthM: 40000, maxVisited: 200000,
    // Discharge (relative): a lake's own share (its half-length in km,
    // squared: its catchment, roughly) plus the rivers flowing into it. A
    // river reaches no farther than lengthPerSqrtQ x sqrt(Q) (minLengthM up)
    // and is 2 x (halfWidthMinM + halfWidthPerSqrtQ x sqrt(Q)) wide, up to
    // halfWidthMaxM: small lakes feed short narrow rivers, the width stops
    // growing at medium lakes, chains of small lakes carry their inflow on
    // (owner 2026-11-09: tiny lakes cannot drain 10+ km, rivers in
    // proportion to their lakes).
    lengthPerSqrtQ: 6000, minLengthM: 800,
    // A lake that cannot drain takes no river bigger than its own share x
    // sinkShare: rivers end in lakes large enough for them.
    sinkShare: 1,
    // Lakes planned when within this of the camera, nearest first.
    planRadiusM: 40000,
    sliceMs: 4, maxTiles: 2000,
    // Records of its own lake table (the generator's pipelines, its own
    // records: planning never evicts what terrain tiles are about to read).
    tableRecords: 32768,
    // 2.5 times v1's (2, 5, 8): narrower than the terrain tiles' vertices a
    // few hundred metres off (12.6 m, then 50 m), coarse triangles stood in the water
    // in teeth along the banks (owner 2026-11-09: rivers were narrow anyway;
    // past the rocks fieldWaterSurface.wgsl.js covers what remains).
    halfWidthMinM: 5, halfWidthPerSqrtQ: 12.5, halfWidthMaxM: 20,
    // Along a river (riverReachShape, as the pre-Codex tracer): constrictions
    // to minReachWidth of its width at least, mouths flared junctionWidthScale
    // times, islands rare (islandThreshold of the reach noise, 0..1).
    minReachWidth: 0.6, junctionWidthScale: 1.6, islandThreshold: 0.8,
    // Rapids: rapidShare of the rivers with rapidMinDropM of drop or more
    // take part of it (rapidDropShare, at most rapidMaxDropM, within the cut
    // budget) in one steep reach of rapidLengthM, early in their course, and
    // run under the land after it until it comes down to them.
    rapidShare: 0.4, rapidMinDropM: 4, rapidDropShare: 0.55, rapidMaxDropM: 14, rapidLengthM: [120, 300], rapidRecoverM: 400,
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

// Smooth value noise along a river (-1..1), x in wavelengths.
function lakeRiverNoise(x, seed) {
    const h = i => { let v = Math.imul((i | 0) ^ Math.imul(seed | 0, 0x27d4eb2d), 0x9e3779b1); v ^= v >>> 15; v = Math.imul(v, 0x85ebca6b); v ^= v >>> 13; return ((v >>> 0) / 4294967296) * 2 - 1; };
    const i = Math.floor(x), f = x - i, t = f * f * (3 - 2 * f);
    return h(i) + (h(i + 1) - h(i)) * t;
}

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
        this.byKey = new Map();       // source lake key -> { river, dest, q } | { none } | { failed }
        this.inflowQ = new Map();     // lake key -> discharge of the rivers ending in it
        this.changes = 0;             // rivers planned or withdrawn (publication)
        this.riverCells = new Map();  // grid cell -> { key, level, dir }: where earlier rivers run
        this.stats = { planned: 0, byDest: { lake: 0, sea: 0, river: 0 }, none: {}, failed: 0, lastError: null,
            lengthsM: [], floodCells: 0, floodCellsByOutcome: {}, ms: 0, longestSliceMs: 0, longestCourseMs: 0, longestIndexMs: 0 };
    }

    // A lake's own discharge share, and with its inflow.
    _ownQ(lake) { return (lake.shape.extent / 1000) ** 2; }
    _q(lake) { return this._ownQ(lake) + (this.inflowQ.get(lake.key) ?? 0); }
    _halfWidth(q) {
        const o = this.options;
        return Math.min(o.halfWidthMaxM, o.halfWidthMinM + o.halfWidthPerSqrtQ * Math.sqrt(q));
    }

    // Plans rivers for up to `budget` lakes without one: within planRadiusM
    // of nearDir (a unit direction), nearest first, or else highest first.
    // Returns how many lakes it took.
    /** Its lake table, once made. */
    ready() {
        return this._ready;
    }

    // Plans rivers for up to `budget` lakes without one, highest first (a
    // lake's inflow is known before it drains); within planRadiusM of
    // nearDir (a unit direction) when given. Returns how many it took.
    async plan(lakes, budget = 6, nearDir = null) {
        await this._ready;
        this.grid ??= new RiverHeightGrid(this.table, this.R, this.options);
        const o = this.options, R = this.R;
        let todo = lakes.filter(l => !this.byKey.has(l.key));
        if (nearDir) {
            const dist = l => Math.acos(Math.min(1, l.centre[0] * nearDir[0] + l.centre[1] * nearDir[1] + l.centre[2] * nearDir[2])) * R;
            todo = todo.filter(l => dist(l) <= o.planRadiusM);
        }
        todo = todo.sort((a, b) => b.level - a.level).slice(0, budget);
        for (const src of todo) {
            const inflow = this.inflowQ.get(src.key) ?? 0;
            if (src.shape.extent < o.minLakeExtentM && !inflow) { this.byKey.set(src.key, { none: 'small' }); this._none('small'); continue; }
            const t0 = performance.now(), q = this._q(src);
            try {
                const flood = await this._flood(src, q);
                if (flood.none) {
                    this.byKey.set(src.key, { none: flood.none }); this._none(flood.none);
                    // A lake that cannot drain keeps no river bigger than itself.
                    if (inflow > o.sinkShare * this._ownQ(src)) this._withdrawInto(src.key);
                    continue;
                }
                const built = await this._build(src, flood, lakes, q);
                this.byKey.set(src.key, built);
                this.changes++;
                this.stats.planned++;
                this.stats.byDest[built.dest.kind]++;
                this.stats.lengthsM.push(Math.round(built.river.lengthM));
                this._markRiver(src.key, built.river);
                // Its water flows on into the receiving lake (a lake still to
                // plan, or planned without it, plans again with it).
                const into = built.dest.kind === 'lake' ? built.dest.key : null;
                if (into) {
                    this.inflowQ.set(into, (this.inflowQ.get(into) ?? 0) + q);
                    if (this.byKey.get(into) && !this.byKey.get(into).river) this.byKey.delete(into);
                }
            } catch (e) {
                this.byKey.set(src.key, { failed: true });
                this.stats.failed++;
                this.stats.lastError = String(e?.message ?? e);
                if (inflow > o.sinkShare * this._ownQ(src)) this._withdrawInto(src.key);
            } finally { this.stats.ms += performance.now() - t0; this.grid.trim(); }
        }
        return todo.length;
    }

    // Withdraws the rivers ending in a lake that cannot carry them on, and,
    // the same way, those ending in their source lakes when these are left
    // too small for what flows into them.
    _withdrawInto(key) {
        const o = this.options;
        for (const [src, v] of this.byKey) {
            if (!v.river || v.dest.kind !== 'lake' || v.dest.key !== key) continue;
            this.byKey.set(src, { none: 'smallSink' });
            this._none('smallSink');
            this.stats.planned--;
            this.stats.byDest.lake--;
            this.changes++;
            this.inflowQ.set(key, Math.max(0, (this.inflowQ.get(key) ?? 0) - v.q));
            for (const [cell, r] of this.riverCells) if (r.key === src) this.riverCells.delete(cell);
            const inflow = this.inflowQ.get(src) ?? 0, lake = v.lake;
            if (inflow > o.sinkShare * (lake ? this._ownQ(lake) : 0)) this._withdrawInto(src);
        }
    }

    _none(why) { this.stats.none[why] = (this.stats.none[why] ?? 0) + 1; }

    // The flood from the lake's water: { path (cells, lake to receiver),
    // kind, level, ... } or { none: why }.
    async _flood(src, q) {
        const g = this.grid, o = this.options, R = this.R, sea = this.seaLevelM;
        const maxLengthM = Math.min(o.maxLengthM, Math.max(o.minLengthM, o.lengthPerSqrtQ * Math.sqrt(q)));
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
    async _build(src, flood, lakes, q) {
        const g = this.grid, o = this.options, R = this.R, halfWidthM = this._halfWidth(q), t0 = performance.now();
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
        this._shapeRiver(river, src.key, halfWidthM, portals.source.arcM, flood.kind === 'river' ? null : portals.receiver.arcM);
        await this._rapids(river, src.key, portals.source.arcM, flood.kind === 'river' ? null : portals.receiver.arcM);
        return { river, dest, q, lake: src };
    }

    // Per point, as the pre-Codex tracer (waterWorkerCore.js solveRiver):
    // width and depth varied along the river (riverReachShape: wider pools,
    // constrictions, flared mouths, a rare island), the bends' curvature
    // (riverField.js bank types: cut banks outside), the thalweg toward the
    // outer bank, foam where steeper, speed from slope and depth. Codex's
    // packing left these constant: one width, one bank, foam down the middle
    // (owner 2026-11-09).
    _shapeRiver(river, key, halfWidthM, sourceS, destS) {
        const o = this.options, P = river.points, st = river.stride, n = P.length / st, R = this.R;
        let seed = 2166136261;
        for (let i = 0; i < key.length; i++) seed = Math.imul(seed ^ key.charCodeAt(i), 16777619);
        const rid = (seed >>> 0) % 1000003;
        const dir = k => [P[k * st], P[k * st + 1], P[k * st + 2]];
        const s = new Float64Array(n);
        for (let k = 1; k < n; k++) { const a = dir(k - 1), b = dir(k); s[k] = s[k - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) * R; }
        const kappaRaw = new Float64Array(n);
        for (let k = 1; k + 1 < n; k++) {
            const a = dir(k - 1), d = dir(k), b = dir(k + 1);
            const f0 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]], f1 = [b[0] - d[0], b[1] - d[1], b[2] - d[2]];
            const l0 = Math.hypot(...f0), l1 = Math.hypot(...f1);
            if (!(l0 > 0 && l1 > 0)) continue;
            const cr = [f0[1] * f1[2] - f0[2] * f1[1], f0[2] * f1[0] - f0[0] * f1[2], f0[0] * f1[1] - f0[1] * f1[0]];
            kappaRaw[k] = ((cr[0] * d[0] + cr[1] * d[1] + cr[2] * d[2]) / (l0 * l1)) / (0.5 * (l0 + l1) * R);
        }
        const slopeAt = k => {
            let k0 = k, k1 = k;
            while (k0 > 0 && s[k] - s[k0] < 100) k0--;
            while (k1 < n - 1 && s[k1] - s[k] < 100) k1++;
            return Math.max(0, (P[k0 * st + 3] - P[k1 * st + 3]) / Math.max(1, s[k1] - s[k0]));
        };
        const width0 = 2 * halfWidthM;
        const reachP = { ...RIVER_SHAPE_DEFAULTS, minWidthM: 0, minReachWidthM: o.minReachWidth * width0, thinShare: 0,
            junctionStartM: sourceS, junctionEndM: destS ?? s[n - 1], junctionWidthScale: o.junctionWidthScale,
            typicalWidthM: width0, deltaLake: false, islands: true, islandThreshold: o.islandThreshold };
        for (let k = 0; k < n; k++) {
            const a = k * st, slope = slopeAt(k), depth0 = P[a + 5];
            const sh = riverReachShape({ width: width0, depth: depth0, slope }, s[k], s[n - 1], rid, reachP);
            let kappa = 0, m = 0;
            for (let q = Math.max(0, k - 3); q <= Math.min(n - 1, k + 3); q++) { kappa += kappaRaw[q]; m++; }
            kappa /= m;
            // Pools and constrictions at walking scale too (80-400 m), its own
            // per river: the reach shape alone varied over kilometres, and a
            // 2-3 km river read as one width (owner 2026-11-09).
            const local = Math.exp(0.38 * lakeRiverNoise(s[k] / (220 + 180 * ((rid % 97) / 97)), rid) + 0.2 * lakeRiverNoise(s[k] / 85, rid + 7));
            const fade = Math.min(1, Math.min(s[k] - sourceS, (destS ?? s[n - 1]) - s[k]) / 60);
            const hw = sh.width / 2 * Math.min(1.8, Math.max(0.55, 1 + (local - 1) * Math.max(0, fade))), inLake = P[a + 9] < 0;
            P[a + 4] = hw;
            P[a + 5] = sh.depth;
            P[a + 6] = Math.max(0.3, Math.min(3.5, Math.pow(0.75 * sh.depth, 2 / 3) * Math.sqrt(Math.max(slope, 1e-5)) / 0.035));
            // Discharge (m^3/s) of that width by the old law (riverShape: width 12 Q^0.5).
            P[a + 7] = (hw / 6) ** 2;
            P[a + 10] = Math.max(-0.35, Math.min(0.35, -0.7 * kappa * hw));
            P[a + 11] = Math.max(0, Math.min(1, (slope - 0.004) / 0.03));
            P[a + 12] = kappa;
            P[a + 17] = sh.depth;
            P[a + 19] = inLake ? 0 : sh.island;
        }
    }

    // A rapid on some rivers (rapidShare, by hash): part of the drop in one
    // steep reach, the water under the land after it (more cut, within the
    // budget, measured on the natural heights). Levels stay non-increasing and
    // end at the receiver's. river.rapid: { startM, lengthM, dropM } or none.
    async _rapids(river, key, sourceS, destS) {
        const o = this.options, P = river.points, st = river.stride, n = P.length / st, R = this.R;
        let h = 2166136261;
        for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
        const r = k => { let v = Math.imul((h ^ (k * 0x9e3779b1)) >>> 0, 0x85ebca6b); v ^= v >>> 13; return (v >>> 0) / 4294967296; };
        if (r(1) >= o.rapidShare) return;
        const s = new Float64Array(n);
        for (let k = 1; k < n; k++) s[k] = s[k - 1] + Math.hypot(P[k * st] - P[(k - 1) * st], P[k * st + 1] - P[(k - 1) * st + 1], P[k * st + 2] - P[(k - 1) * st + 2]) * R;
        const end = destS ?? s[n - 1], span = end - sourceS, lvl = k => P[k * st + 3];
        const drop = lvl(0) - lvl(n - 1);
        if (drop < o.rapidMinDropM || span < 600) return;
        const len = o.rapidLengthM[0] + (o.rapidLengthM[1] - o.rapidLengthM[0]) * r(2);
        const s0 = sourceS + span * (0.15 + 0.35 * r(3));
        if (s0 + len > end - 150) return;
        // Natural ground at the points: the cut may grow by the budget's rest.
        const d4 = new Float32Array(n * 4);
        for (let k = 0; k < n; k++) d4.set([P[k * st], P[k * st + 1], P[k * st + 2], 0], k * 4);
        const nat = await this.table.sampleHeights(d4);
        let room = Infinity;
        for (let k = 0; k < n; k++) if (s[k] >= s0 && s[k] <= end) room = Math.min(room, o.maxChannelCutM - (nat[k] - lvl(k) + P[k * st + 5]));
        const levelAt0 = (() => { let k = 0; while (k + 1 < n && s[k + 1] < s0) k++; return lvl(k); })();
        const target = lvl(n - 1);
        // No more than the land itself falls within rapidRecoverM below the
        // rapid: after it the water comes back to the land's slope (holding
        // it D under to the end ran a trench of up to 14 m for kilometres).
        const levelAfter = (() => { let k = 0; while (k + 1 < n && s[k] < s0 + len + o.rapidRecoverM) k++; return lvl(k); })();
        const D = Math.min(o.rapidMaxDropM, o.rapidDropShare * (levelAt0 - target), room, levelAt0 - levelAfter);
        if (!(D >= 2)) return;
        let prev = Infinity;
        for (let k = 0; k < n; k++) {
            if (s[k] <= s0 || P[k * st + 9] < 0) { prev = Math.min(prev, lvl(k)); continue; }
            const t = Math.min(1, (s[k] - s0) / len), up = t * t * (3 - 2 * t);
            const r2 = Math.min(1, Math.max(0, (s[k] - s0 - len) / o.rapidRecoverM)), down = 1 - r2 * r2 * (3 - 2 * r2);
            const next = Math.max(target, Math.min(prev, lvl(k) - D * up * down));
            const dl = lvl(k) - next;
            for (const j of [3, 8, 16]) P[k * st + j] -= dl;
            prev = next;
            if (t < 1) { P[k * st + 4] *= 0.8; P[k * st + 11] = Math.max(P[k * st + 11], 0.8); P[k * st + 6] = Math.max(P[k * st + 6], 2.5); }
        }
        river.rapid = { startM: s0, lengthM: len, dropM: D };
        this.stats.rapids = (this.stats.rapids ?? 0) + 1;
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
