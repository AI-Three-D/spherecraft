// core/world/hydrology/mountainLakes.js
//
// Small mountain lakes: natural pockets of the terrain in high-relief land,
// which the water graph's 512-cell grid cannot see (its lakes need an 8 m
// deep core of 18 cells, ~2.5 km^2). Owner 2026-10-11: small mountain lakes
// besides the big ones, so rivers between them run down good hill gradients.
//
// Discovery floods blocks of the grid's mountain cells at 64 m (lab
// 2026-10-11, lake-recovery lab 7: 97 % of the 32 m pockets over 5 ha found,
// level within 0.1 m). A pocket is the set of cells holding water at their
// own spill level. Chosen pockets sit in a mountain setting (the ground
// rises around the shore) and spill steeply (their outflow drops within
// 1.5 km), larger first, with a minimum spacing between shores (lab 8).
// They are then solved at 32 m like every other lake.
// Pure JS (worker and main thread), deterministic.

import { MinHeap, faceUVToDir, makeNeighbors } from './waterGraph.js';
import { tangentBasis, dirToPlane, planeToDir } from './lakeRefine.js';

// Bump on any change to discovery, choice or the drainage paths (cache key).
export const MOUNTAIN_LAKE_VERSION = 4;

export const MOUNTAIN_LAKE_DEFAULTS = Object.freeze({
    enabled: true,
    reliefM: 300,          // relief over a cell's 5 x 5 grid cells (~2 km) marking mountain cells
    blockCells: 8,         // discovery blocks: grid cells a side (~3.2 km)
    marginM: 1000,         // flooded beyond the block; pockets reaching the patch border are dropped
    discoverySpacingM: 64,
    minDepthM: 3,
    minAreaKm2: 0.03,
    minEnclosureM: 20,     // median rise of the ground 64-400 m beyond the shore
    minOutflowDropM: 20,   // drop along the drainage within 1.5 km of the sill
    minSpacingM: 800,      // between the shores of chosen lakes (circle-equivalent radii)
    solveSpacingM: 32,
    solveMarginM: 500,
    // Streams: from each lake whose route reaches lower water within this
    // (lake, sea or a river); narrower than the graph's rivers (30 m minimum).
    maxStreamM: 8000,
    // Ends flare a little over a short length: the rivers' 2.3x over 180 m
    // (big rivers' mouths) made 20-26 m flat sheets at a stream's outlet and
    // junction (owner 2026-10-12, water-look v15-v17).
    streamShape: { minWidthM: 8, minDepthM: 0.8, junctionWidthScale: 1.25, junctionLengthM: 40 },
    pathStepM: 128,        // spacing of the fine drainage path's points
    streamCorridorM: 300,  // the 16 m trace stays this close to the fine path
    // A path leaving its discovery patch dry continues on patches this wide
    // ahead of its end (64 m), at most drainRounds times.
    drainPatchM: 4000,
    drainRounds: 4,
    // A stream within this of an earlier stream's route joins it (WaterService).
    joinM: 64,
    // Hollows a drainage crosses at least this deep fill into ponds (lakes
    // with their own stream on); shallower ones the stream cuts through.
    pondMinDepthM: 3,
});

/**
 * Relief of every grid cell: max - min height over its 5 x 5 cells.
 * @returns {Float32Array}
 */
export function gridRelief(heights, N) {
    const nb = makeNeighbors(N), total = heights.length;
    const r1 = new Float32Array(total), r2 = new Float32Array(total);
    for (let id = 0; id < total; id++) {
        let lo = heights[id], hi = lo;
        const { list, count } = nb(id);
        for (let k = 0; k < count; k++) { const v = heights[list[k]]; if (v < lo) lo = v; if (v > hi) hi = v; }
        r1[id] = hi - lo;
    }
    for (let id = 0; id < total; id++) {
        let m = r1[id];
        const { list, count } = nb(id);
        for (let k = 0; k < count; k++) m = Math.max(m, r1[list[k]]);
        r2[id] = m;
    }
    return r2;
}

/** Discovery blocks holding a mountain cell (land, relief over reliefM): [{ f, bi, bj }]. */
export function mountainBlocks(heights, seaLevelM, N, P = MOUNTAIN_LAKE_DEFAULTS) {
    const relief = gridRelief(heights, N), B = P.blockCells, NN = N * N, out = [];
    let cells = 0;
    for (let f = 0; f < 6; f++) for (let bj = 0; bj < N / B; bj++) for (let bi = 0; bi < N / B; bi++) {
        let m = 0;
        for (let j = bj * B; j < (bj + 1) * B; j++) for (let i = bi * B; i < (bi + 1) * B; i++) {
            const id = f * NN + j * N + i;
            if (heights[id] > seaLevelM && relief[id] > P.reliefM) m++;
        }
        if (m) { out.push({ f, bi, bj }); cells += m; }
    }
    return { blocks: out, mountainCells: cells };
}

/** Tangent-plane patch over block (f, bi, bj) plus the margin, at spacing (lakeRefine.js frames). */
export function mountainBlockFrame({ f, bi, bj }, N, R, spacing, P = MOUNTAIN_LAKE_DEFAULTS) {
    const B = P.blockCells;
    const c = faceUVToDir(f, (bi * B + B / 2) / N, (bj * B + B / 2) / N), frame0 = { c, ...tangentBasis(c) };
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0], [0, 0.5], [1, 0.5], [0.5, 1]]) {
        const [x, y] = dirToPlane(faceUVToDir(f, (bi + u) * B / N, (bj + v) * B / N), frame0, R);
        xMin = Math.min(xMin, x); xMax = Math.max(xMax, x); yMin = Math.min(yMin, y); yMax = Math.max(yMax, y);
    }
    return { ...frame0, spacing, x0: xMin - P.marginM, y0: yMin - P.marginM,
        nx: Math.ceil((xMax - xMin + 2 * P.marginM) / spacing), ny: Math.ceil((yMax - yMin + 2 * P.marginM) / spacing) };
}

const NB8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];

/**
 * Pockets of a height patch (frame as lakeRefine.js), flooded from its
 * border: { dir (deepest point), level, depth, areaKm2, enclosureM,
 * outflowDropM, corners (unit directions of the pocket's bounding box) }.
 * Pockets reaching the border, shallower than minDepthM, smaller than
 * minAreaKm2 or not above sea level are left out.
 */
// Priority flood of a patch from its border: filled heights and each
// cell's flood parent (the neighbour it was reached from).
function floodPatch(h, nx, ny) {
    const n = nx * ny;
    const fill = new Float64Array(n), closed = new Uint8Array(n), parent = new Int32Array(n).fill(-1), heap = new MinHeap(n);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        if (i && j && i < nx - 1 && j < ny - 1) continue;
        const k = j * nx + i; closed[k] = 1; fill[k] = h[k]; heap.push(h[k], k);
    }
    while (heap.size) {
        const k = heap.pop(), i = k % nx, j = (k - i) / nx;
        for (const [di, dj] of NB8) {
            const ii = i + di, jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
            const q = jj * nx + ii;
            if (closed[q]) continue;
            closed[q] = 1; fill[q] = Math.max(h[q], fill[k]); parent[q] = k; heap.push(fill[q], q);
        }
    }
    return { fill, parent };
}

// The drainage from cell q to the patch border: steepest descent on the
// filled surface; across flats (filled hollows) the flood's parent, which
// leads to their spill point. Fill never rises along either step and
// parents run in flood order, so the walk cannot cycle. (Flood parents
// alone are only a minimax path: on a plain slope they drift sideways.)
function drainCells(q, { fill, parent }, nx, ny) {
    const cells = [];
    for (let guard = 0; q !== -1 && guard < nx * ny; guard++) {
        cells.push(q);
        const i = q % nx, j = (q - i) / nx;
        if (i === 0 || j === 0 || i === nx - 1 || j === ny - 1) break;
        let best = -1, bestS = 0;
        for (const [di, dj] of NB8) {
            const k = (j + dj) * nx + i + di, s = (fill[q] - fill[k]) / (di && dj ? Math.SQRT2 : 1);
            if (s > bestS) { bestS = s; best = k; }
        }
        q = best !== -1 ? best : parent[q];
    }
    return cells;
}

/**
 * A drainage (cells from drainCells) as path points every pathStepM (the
 * first cell skipped when it is a continuation's start), the ground at
 * each, and the hollows it crosses: runs of filled cells (fill above the
 * ground by more than 0.5 m) that end before the patch border, each with
 * its filled level (the spill), depth, deepest point and the path points
 * around it (entry: last point before, exit: first point after).
 */
function drainPath(drain, { fill, h, nx, ny, frame, R, every, skipFirst = false }) {
    const at = (q) => planeToDir(frame.x0 + (q % nx + 0.5) * frame.spacing, frame.y0 + (Math.floor(q / nx) + 0.5) * frame.spacing, frame, R);
    const path = [], pathH = [], idx = new Int32Array(drain.length).fill(-1);
    drain.forEach((q, s) => {
        if ((s || !skipFirst) && (s % every === 0 || s === drain.length - 1)) { idx[s] = path.length; path.push(at(q)); pathH.push(h[q]); }
    });
    const pits = [];
    for (let s = 0; s < drain.length; s++) {
        if (!(fill[drain[s]] - h[drain[s]] > 0.5)) continue;
        let e = s, deep = s;
        while (e + 1 < drain.length && fill[drain[e + 1]] - h[drain[e + 1]] > 0.5) {
            e++;
            if (fill[drain[e]] - h[drain[e]] > fill[drain[deep]] - h[drain[deep]]) deep = e;
        }
        if (e + 1 < drain.length) {
            let entry = -1, exit = -1;
            for (let t = s; t >= 0 && entry < 0; t--) entry = idx[t];
            for (let t = e + 1; t < drain.length && exit < 0; t++) exit = idx[t];
            const q = drain[deep], last = pits.at(-1);
            // Runs at the same spill level are one hollow (the path grazed its rim).
            if (last && Math.abs(last.level - fill[q]) < 0.01) {
                if (fill[q] - h[q] > last.depth) { last.dir = at(q); last.depth = fill[q] - h[q]; }
                if (exit >= 0) last.exit = exit;
                last.cells += e - s + 1;
            } else if (exit >= 0) pits.push({ dir: at(q), level: fill[q], depth: fill[q] - h[q], entry, exit, cells: e - s + 1 });
        }
        s = e;
    }
    return { path, pathH, pits };
}

export function findPockets({ heights: h, frame, R, seaLevelM, P = MOUNTAIN_LAKE_DEFAULTS }) {
    const { nx, ny, spacing } = frame, n = nx * ny;
    const flood = floodPatch(h, nx, ny), { fill, parent } = flood;
    const comp = new Int32Array(n).fill(-1), stack = [], out = [];
    const ringSteps = Math.max(1, Math.round(400 / spacing)), outflowSteps = Math.ceil(1500 / spacing);
    let cid = 0;
    for (let k0 = 0; k0 < n; k0++) {
        if (comp[k0] !== -1 || !(fill[k0] - h[k0] > 0.5)) continue;
        const cells = [], id = cid++;
        let deepest = k0, border = false, i0 = nx, i1 = -1, j0 = ny, j1 = -1;
        comp[k0] = id; stack.push(k0);
        while (stack.length) {
            const k = stack.pop(), i = k % nx, j = (k - i) / nx;
            cells.push(k);
            if (fill[k] - h[k] > fill[deepest] - h[deepest]) deepest = k;
            if (i === 0 || j === 0 || i === nx - 1 || j === ny - 1) border = true;
            if (i < i0) i0 = i; if (i > i1) i1 = i; if (j < j0) j0 = j; if (j > j1) j1 = j;
            for (const [di, dj] of NB8) {
                const ii = i + di, jj = j + dj;
                if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
                const q = jj * nx + ii;
                if (comp[q] !== -1 || !(fill[q] - h[q] > 0.5)) continue;
                comp[q] = id; stack.push(q);
            }
        }
        const level = fill[deepest], depth = level - h[deepest], areaKm2 = cells.length * spacing * spacing / 1e6;
        if (border || depth < P.minDepthM || areaKm2 < P.minAreaKm2 || !(level > seaLevelM + 5)) continue;
        // Setting: median rise of the ground in a ring up to ~400 m beyond the shore.
        const ring = [], seen = new Set(cells);
        let front = cells;
        for (let step = 0; step < ringSteps && front.length; step++) {
            const next = [];
            for (const k of front) {
                const i = k % nx, j = (k - i) / nx;
                for (const [di, dj] of NB8) {
                    const ii = i + di, jj = j + dj;
                    if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
                    const q = jj * nx + ii;
                    if (seen.has(q)) continue;
                    seen.add(q); next.push(q); ring.push(h[q] - level);
                }
            }
            front = next;
        }
        ring.sort((a, b) => a - b);
        const enclosureM = ring.length ? ring[ring.length >> 1] : 0;
        // The fine drainage from the sill (the spill cell beyond the pocket's
        // last cell on the flood's way out) to the patch border.
        let c = deepest;
        while (parent[c] !== -1 && comp[parent[c]] === id) c = parent[c];
        const drain = drainCells(parent[c], flood, nx, ny);
        // Outflow: the drainage's lowest point within 1.5 km (or the level
        // of lower water it reaches first).
        let lowest = level;
        for (let s = 0; s < drain.length && s < outflowSteps; s++) {
            const q = drain[s];
            lowest = Math.min(lowest, h[q]);
            if (fill[q] - h[q] > 0.5 && fill[q] < level - 1) { lowest = Math.min(lowest, fill[q]); break; }
        }
        const at = (i, j) => planeToDir(frame.x0 + (i + 0.5) * spacing, frame.y0 + (j + 0.5) * spacing, frame, R);
        // Every pathStepM; streams follow it (WaterService), and the hollows
        // it crosses fill into ponds.
        const { path, pathH, pits } = drainPath(drain, { fill, h, nx, ny, frame, R, every: Math.max(1, Math.round(P.pathStepM / spacing)) });
        out.push({
            dir: at(deepest % nx, Math.floor(deepest / nx)), level, depth, areaKm2, enclosureM, outflowDropM: level - lowest,
            corners: [at(i0, j0), at(i1, j0), at(i0, j1), at(i1, j1)], sill: at(c % nx, Math.floor(c / nx)), path, pathH, pits,
        });
    }
    return out;
}

const angleM = (a, b, R) => Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])) * R;

/**
 * Patch continuing a drainage path that left its patch dry: drainPatchM
 * square at the discovery spacing, its back edge 500 m behind the path's
 * end (dirs[n - 1]), ahead along the last step.
 */
export function drainFrame(end, prev, R, P = MOUNTAIN_LAKE_DEFAULTS) {
    const frame0 = { c: end, ...tangentBasis(end) };
    const [px, py] = dirToPlane(prev, frame0, R), len = Math.hypot(px, py) || 1;
    const ahead = P.drainPatchM / 2 - 500, cx = -px / len * ahead, cy = -py / len * ahead;
    const c = planeToDir(cx, cy, frame0, R), s = P.discoverySpacingM, nx = Math.ceil(P.drainPatchM / s);
    return { c, ...tangentBasis(c), spacing: s, x0: -nx * s / 2, y0: -nx * s / 2, nx, ny: nx };
}

/**
 * The drainage from `start` (a path's end) across the patch (drainFrame):
 * its points every pathStepM after the start, to the patch border, the
 * ground height at each and the hollows it crosses (drainPath).
 * @returns {{ path: number[][], pathH: number[], pits: object[] }}
 */
export function continueDrain({ heights: h, frame, R, start, P = MOUNTAIN_LAKE_DEFAULTS }) {
    const { nx, ny, spacing } = frame;
    const [x, y] = dirToPlane(start, frame, R);
    const i = Math.max(1, Math.min(nx - 2, Math.floor((x - frame.x0) / spacing))), j = Math.max(1, Math.min(ny - 2, Math.floor((y - frame.y0) / spacing)));
    const flood = floodPatch(h, nx, ny), drain = drainCells(j * nx + i, flood, nx, ny);
    return drainPath(drain, { fill: flood.fill, h, nx, ny, frame, R, every: Math.max(1, Math.round(P.pathStepM / spacing)), skipFirst: true });
}

/**
 * Pockets that become lakes: in a mountain setting, spilling steeply,
 * larger first, at least minSpacingM between shores (circle-equivalent).
 * Deterministic for a given candidate list (ties by position).
 */
export function chooseMountainLakes(cands, R, P = MOUNTAIN_LAKE_DEFAULTS) {
    const ok = cands.filter(p => p.areaKm2 >= P.minAreaKm2 && p.enclosureM >= P.minEnclosureM && p.outflowDropM >= P.minOutflowDropM)
        .map(p => ({ ...p, r: Math.sqrt(p.areaKm2 * 1e6 / Math.PI) }))
        .sort((a, b) => b.areaKm2 - a.areaKm2 || a.dir[0] - b.dir[0] || a.dir[1] - b.dir[1] || a.dir[2] - b.dir[2]);
    if (!ok.length) return [];
    const rMax = Math.max(...ok.map(p => p.r)), cellM = P.minSpacingM + 2 * rMax;
    const key = (k) => k.join(','), lattice = new Map(), keep = [];
    for (const p of ok) {
        const k0 = p.dir.map(v => Math.floor(v * R / cellM));
        let free = true;
        for (let dx = -1; dx <= 1 && free; dx++) for (let dy = -1; dy <= 1 && free; dy++) for (let dz = -1; dz <= 1 && free; dz++) {
            for (const q of lattice.get(key([k0[0] + dx, k0[1] + dy, k0[2] + dz])) ?? []) {
                if (angleM(p.dir, q.dir, R) < P.minSpacingM + p.r + q.r) { free = false; break; }
            }
        }
        if (!free) continue;
        keep.push(p);
        const k = key(k0);
        if (!lattice.has(k)) lattice.set(k, []);
        lattice.get(k).push(p);
    }
    return keep;
}

/**
 * Patch for the 32 m solve of a chosen pocket: centred on its deepest point,
 * covering its 64 m bounding box plus solveMarginM (lakeRefine.js frame).
 */
export function pocketSolveFrame(p, R, P = MOUNTAIN_LAKE_DEFAULTS) {
    const frame0 = { c: p.dir, ...tangentBasis(p.dir) };
    let xMin = 0, xMax = 0, yMin = 0, yMax = 0;
    for (const d of p.corners) {
        const [x, y] = dirToPlane(d, frame0, R);
        xMin = Math.min(xMin, x); xMax = Math.max(xMax, x); yMin = Math.min(yMin, y); yMax = Math.max(yMax, y);
    }
    const m = P.solveMarginM + P.discoverySpacingM, s = P.solveSpacingM;
    return { ...frame0, spacing: s, x0: xMin - m, y0: yMin - m, nx: Math.ceil((xMax - xMin + 2 * m) / s), ny: Math.ceil((yMax - yMin + 2 * m) / s) };
}
