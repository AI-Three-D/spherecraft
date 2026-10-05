// core/world/hydrology/riverRefine.js
//
// Fine river trace: where a river really runs, from its source lake's sill
// to the water it ends in. Pure JS (worker-friendly), deterministic.
//
// Why: the water graph's rivers are 512 m cell paths, and the refined lakes
// (lakeRefine.js) are smaller or larger than their cells and can drain out
// of another side, so graph rivers start or end on dry ground (owner,
// 2026-10-05: "they have to always connect lakes or lake to ocean").
//
// Method, on a tangent-plane height patch (frame as in lakeRefine.js):
// - corridor: cells within corridorM of the routed coarse path (from the
//   source's fine exit down the graph's drainage to the destination);
// - seeds: corridor cells under the destination's water (below the
//   destination lake's level inside its cells, or below sea level);
// - priority flood from the seeds inside the corridor; every corridor cell
//   gets a drainage path to the destination and its spill level (fill);
// - trace from the source cell down the drainage: the path ends in the
//   destination's water by construction, and fill never rises along it.
// The trace is then smoothed, resampled, and given width, depth and flow
// speed from the catchment, a water level cut into the ground (riverLevels)
// and its pools (riverPools): the terrain is shaped around it
// (riverCarve.wgsl.js).

import { MinHeap } from './waterGraph.js';

const NB8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];

/**
 * Corridor mask: cells within corridorM of the polyline (plane coords).
 * @returns {Uint8Array} nx * ny
 */
export function corridorMask(frame, polyline, corridorM) {
    const { nx, ny, x0, y0, spacing } = frame;
    const mask = new Uint8Array(nx * ny);
    const D2 = corridorM * corridorM;
    const stamp = (ax, ay, bx, by) => {
        const minX = Math.min(ax, bx) - corridorM, maxX = Math.max(ax, bx) + corridorM;
        const minY = Math.min(ay, by) - corridorM, maxY = Math.max(ay, by) + corridorM;
        const i0 = Math.max(0, Math.floor((minX - x0) / spacing)), i1 = Math.min(nx - 1, Math.ceil((maxX - x0) / spacing));
        const j0 = Math.max(0, Math.floor((minY - y0) / spacing)), j1 = Math.min(ny - 1, Math.ceil((maxY - y0) / spacing));
        const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
        for (let j = j0; j <= j1; j++) {
            const py = y0 + (j + 0.5) * spacing;
            for (let i = i0; i <= i1; i++) {
                const k = j * nx + i;
                if (mask[k]) continue;
                const px = x0 + (i + 0.5) * spacing;
                const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
                const qx = ax + t * dx - px, qy = ay + t * dy - py;
                if (qx * qx + qy * qy <= D2) mask[k] = 1;
            }
        }
    };
    if (polyline.length === 1) stamp(polyline[0][0], polyline[0][1], polyline[0][0], polyline[0][1]);
    for (let s = 0; s + 1 < polyline.length; s++) stamp(polyline[s][0], polyline[s][1], polyline[s + 1][0], polyline[s + 1][1]);
    return mask;
}

/**
 * Priority flood from the seeds inside the corridor, then the drainage
 * path from the source to a seed.
 * @returns {{ path: Int32Array, fill: Float64Array } | null}  null when the
 *   source cannot reach a seed inside the corridor.
 */
export function traceRiverPatch({ heights, nx, ny, corridor, seeds, source }) {
    const n = nx * ny;
    const fill = new Float64Array(n);
    const parent = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const heap = new MinHeap(n);
    for (let k = 0; k < n; k++) {
        if (seeds[k] && corridor[k]) { closed[k] = 1; fill[k] = heights[k]; heap.push(heights[k], k); }
    }
    if (heap.size === 0 || !corridor[source]) return null;
    while (heap.size > 0) {
        const id = heap.pop(), i = id % nx, j = (id - i) / nx;
        for (const [di, dj] of NB8) {
            const ii = i + di, jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
            const nb = jj * nx + ii;
            if (closed[nb] || !corridor[nb]) continue;
            closed[nb] = 1;
            fill[nb] = Math.max(heights[nb], fill[id]);
            parent[nb] = id;
            heap.push(fill[nb], nb);
        }
    }
    if (!closed[source]) return null;
    const path = [];
    for (let c = source; c !== -1; c = parent[c]) path.push(c);
    const f = new Float64Array(path.length);
    for (let k = 0; k < path.length; k++) f[k] = fill[path[k]];
    return { path: Int32Array.from(path), fill: f };
}

/**
 * Smooths a traced cell path and resamples it by arc length. The water
 * level along it never rises downstream (running minimum).
 * @param {Float64Array} xs, ys  plane coords of the path cells
 * @param {Float64Array} fill    spill level per path cell
 * @returns {{ x: number[], y: number[], fill: number[], s: number[] }}
 */
export function smoothRiverPath(xs, ys, fill, { window = 4, stepM = 24 } = {}) {
    if (xs.length < 2) return { x: [xs[0], xs[0]], y: [ys[0], ys[0]], fill: [fill[0], fill[0]], s: [0, 0] };
    const n = xs.length;
    const sx = new Float64Array(n), sy = new Float64Array(n);
    for (let k = 0; k < n; k++) {
        // Shrinking window at the ends keeps both end points in place.
        const w = Math.min(window, k, n - 1 - k);
        let ax = 0, ay = 0;
        for (let m = k - w; m <= k + w; m++) { ax += xs[m]; ay += ys[m]; }
        sx[k] = ax / (2 * w + 1); sy[k] = ay / (2 * w + 1);
    }
    const arc = new Float64Array(n);
    for (let k = 1; k < n; k++) arc[k] = arc[k - 1] + Math.hypot(sx[k] - sx[k - 1], sy[k] - sy[k - 1]);
    const total = arc[n - 1];
    const count = Math.max(2, Math.ceil(total / stepM) + 1);
    const out = { x: [], y: [], fill: [], s: [] };
    let seg = 0, run = Infinity;
    for (let q = 0; q < count; q++) {
        const s = q === count - 1 ? total : (q * total) / (count - 1);
        while (seg < n - 2 && arc[seg + 1] < s) seg++;
        const span = arc[seg + 1] - arc[seg];
        const t = span > 0 ? (s - arc[seg]) / span : 0;
        out.x.push(sx[seg] + t * (sx[seg + 1] - sx[seg]));
        out.y.push(sy[seg] + t * (sy[seg + 1] - sy[seg]));
        run = Math.min(run, fill[seg] + t * (fill[seg + 1] - fill[seg]));
        out.fill.push(run);
        out.s.push(s);
    }
    return out;
}

// Floats per river point (waterWorkerCore.js solveRiver): dir.xyz, level,
// half-width, water depth at the thalweg, speed, Q, spill level, pool reach,
// skew, foam.
export const RIVER_POINT_STRIDE = 12;

export const RIVER_SHAPE_DEFAULTS = Object.freeze({
    // Discharge (m^3/s) per km^2 of precipitation-weighted catchment.
    runoffM3sPerKm2: 0.03,
    // Owner 2026-10-05: rivers at least 3x wider than the first version
    // (10 m, 4 Q^0.5). Whitewater's rivers are 11-24 m wide, 1-2.3 m deep.
    widthCoef: 12.0,      // width = widthCoef * Q^0.5 (m), at least minWidthM
    widthExp: 0.5,
    minWidthM: 30,
    // Bank-full depth D (thalweg to the channel's edge); the water fills
    // waterFrac of it (RIVER_LEVEL_DEFAULTS).
    depthCoef: 0.6,       // D = depthCoef * Q^0.4 (m), at least minDepthM
    depthExp: 0.4,
    minDepthM: 1.4,
    manning: 0.035,
});

/**
 * Width, bank-full depth D (m) and flow speed (m/s) of a river with
 * discharge Q (m^3/s) and surface slope S; speed from Manning's equation at
 * the water depth waterFrac x D.
 */
export function riverShape(Qm3s, slope, P = RIVER_SHAPE_DEFAULTS, waterFrac = 0.75) {
    const width = Math.max(P.minWidthM, P.widthCoef * Math.pow(Math.max(Qm3s, 0), P.widthExp));
    const depth = Math.max(P.minDepthM, P.depthCoef * Math.pow(Math.max(Qm3s, 0), P.depthExp));
    const speed = Math.max(0.3, Math.min(3.5, Math.pow(waterFrac * depth, 2 / 3) * Math.sqrt(Math.max(slope, 1e-5)) / P.manning));
    return { width, depth, speed };
}

export const RIVER_LEVEL_DEFAULTS = Object.freeze({
    // Water fills this fraction of the bank-full depth (Whitewater: 0.75).
    waterFrac: 0.75,
    // Bank rise beyond the channel's edge (riverCarve.wgsl.js). The river is
    // cut into the ground: its bank crest, (1 - waterFrac) D + bankH above
    // the water, sits at the trace's spill level (the natural ground)...
    bankH: 1.5,
    // ...reached over the first rampM from the source (no step at the outlet).
    rampM: 120,
});

/**
 * Least-squares non-increasing fit of values (pool adjacent violators):
 * runs of equal level where the data would rise, means of the data there.
 * @param {ArrayLike<number>} v
 * @param {ArrayLike<number>} [w]  weights (default 1)
 * @returns {Float64Array}
 */
export function fitNonIncreasing(v, w = null) {
    const n = v.length, mean = [], weight = [], size = [];
    for (let k = 0; k < n; k++) {
        let m = v[k], wt = w ? w[k] : 1, sz = 1;
        while (mean.length && mean[mean.length - 1] < m) {
            const pm = mean.pop(), pw = weight.pop(), ps = size.pop();
            m = (pm * pw + m * wt) / (pw + wt); wt += pw; sz += ps;
        }
        mean.push(m); weight.push(wt); size.push(sz);
    }
    const out = new Float64Array(n);
    let k = 0;
    for (let b = 0; b < mean.length; b++) for (let q = 0; q < size[b]; q++) out[k++] = mean[b];
    return out;
}

/**
 * Water level and thalweg (deepest bed) along a traced river, for the
 * terrain carve (riverCarve.wgsl.js). The river is cut into the ground: the
 * level is the least-squares non-increasing fit (fitNonIncreasing) of the
 * ground along it minus incision = (1 - waterFrac) D + bankH, so on
 * average the bank crest lands on the natural ground, rims get cut and
 * hollows filled by similar amounts (lab 2026-10-05: following the spill
 * level instead left the river above most of its surroundings, 20-40 m of
 * fill in hollows), and level runs with drops between them read as pools
 * and riffles. Ramped in from the source lake's level over rampM; never
 * above the source lake, never below the destination's water; a running
 * minimum keeps it from rising downstream (the river never flows
 * backwards). thalweg = eta - waterFrac D may rise again where a deeper
 * section gets shallower (owner 2026-10-05: that just holds water).
 * @param {ArrayLike<number>} ground  natural ground along the river (m)
 * @param {ArrayLike<number>} s       distance from the source (m)
 * @param {ArrayLike<number>} depth   bank-full depth D (riverShape)
 * @param {ArrayLike<number>} [lakeAt]  per point the level of the lake it lies in (NaN: none):
 *   there the river's level is the lake's (weight 20 in the fit; the lake bed is not ground)
 * @returns {{eta: Float64Array, bed: Float64Array}}  bed = thalweg
 */
export function riverLevels(ground, s, depth, { srcLevel, destLevel }, P = RIVER_LEVEL_DEFAULTS, lakeAt = null) {
    const n = ground.length, eta = new Float64Array(n), bed = new Float64Array(n);
    const target = new Float64Array(n), weight = new Float64Array(n);
    for (let k = 0; k < n; k++) {
        const lake = lakeAt ? lakeAt[k] : NaN;
        target[k] = Number.isFinite(lake) ? lake : ground[k] - ((1 - P.waterFrac) * depth[k] + P.bankH);
        weight[k] = Number.isFinite(lake) ? 20 : 1;
    }
    const fit = fitNonIncreasing(target, weight);
    let runEta = Infinity;
    for (let k = 0; k < n; k++) {
        const x = Math.min(1, Math.max(0, s[k] / Math.max(P.rampM, 1e-6)));
        const ramp = x * x * (3 - 2 * x);
        const level = srcLevel + (Math.min(fit[k], srcLevel) - srcLevel) * ramp;
        runEta = Math.min(runEta, Math.min(srcLevel, Math.max(destLevel, level)));
        eta[k] = runEta;
        bed[k] = runEta - P.waterFrac * depth[k];
    }
    return { eta, bed };
}

/**
 * Hollows along a river: ground below its water level that would take the
 * river's water (lab 2026-10-05: on the lumpy terrain most of a river's
 * length passes such hollows, many m deep). The carve fills them up to the
 * river's floodplain (riverCarve.wgsl.js), like Whitewater's valley floor.
 * On a patch grid (heights, corridor mask), every corridor cell takes the
 * river point nearest to it (propagated outward from the line); a cell is
 * under the river's water when it lies below that point's level (minus
 * 0.25 m), within maxReachM of it and not in a lake (lake mask: the source
 * and destination lakes, drawn as lakes); a hollow is the set of such cells
 * connected to the river line. Returns per point the hollow's reach: the
 * farthest of its hollow cells from it (0: none; -1: the point lies in a
 * lake). Smoothed with a running maximum over +-2 points (lake points stay -1).
 * @param {object} p
 * @param {Float32Array} p.heights   nx * ny (m)
 * @param {Uint8Array|null} p.corridor  nx * ny, 1 = inside (null: the whole patch)
 * @param {number} p.nx, p.ny, p.x0, p.y0, p.spacing   patch grid
 * @param {ArrayLike<number>} p.px, p.py   river points (plane coords)
 * @param {ArrayLike<number>} p.eta        water level per point
 * @param {Uint8Array} [p.lake]    nx * ny, 1 = lake cell
 * @param {number} [p.maxReachM=300]
 * @param {boolean} [p.withMasks]  also return { reach, inPool, nearest } (lab)
 * @returns {Float64Array}
 */
export function riverPools({ heights, corridor, nx, ny, x0, y0, spacing, px, py, eta, lake = null, maxReachM = 300, withMasks = false }) {
    const n = px.length, cells = nx * ny;
    corridor ??= new Uint8Array(cells).fill(1);
    const nearest = new Int32Array(cells).fill(-1);
    // Float64: a value rounded on store would look improved on every revisit.
    const dist2 = new Float64Array(cells).fill(Infinity);
    const cx = (c) => x0 + ((c % nx) + 0.5) * spacing, cy = (c) => y0 + (Math.floor(c / nx) + 0.5) * spacing;
    const cellAt = (x, y) => {
        const i = Math.floor((x - x0) / spacing), j = Math.floor((y - y0) / spacing);
        return i >= 0 && j >= 0 && i < nx && j < ny ? j * nx + i : -1;
    };
    // Seeds: cells along the line, each owned by the nearer end of its segment.
    let queue = [];
    const seeds = [];
    for (let k = 0; k + 1 < n || (k === 0 && n === 1); k++) {
        const bx = n > 1 ? px[k + 1] : px[k], by = n > 1 ? py[k + 1] : py[k];
        const len = Math.hypot(bx - px[k], by - py[k]), steps = Math.max(1, Math.ceil(len / (0.5 * spacing)));
        for (let q = 0; q <= steps; q++) {
            const t = q / steps, c = cellAt(px[k] + t * (bx - px[k]), py[k] + t * (by - py[k]));
            if (c < 0 || !corridor[c]) continue;
            const own = t < 0.5 || n === 1 ? k : k + 1;
            const d2 = (cx(c) - px[own]) ** 2 + (cy(c) - py[own]) ** 2;
            if (d2 < dist2[c]) { dist2[c] = d2; nearest[c] = own; queue.push(c); seeds.push(c); }
        }
        if (n === 1) break;
    }
    // Nearest point for every corridor cell (brushfire propagation).
    const NB = [1, -1, nx, -nx, nx + 1, nx - 1, -nx + 1, -nx - 1];
    while (queue.length) {
        const next = [];
        for (const c of queue) {
            const ci = c % nx, k = nearest[c];
            for (const o of NB) {
                const m = c + o;
                if (m < 0 || m >= cells || !corridor[m]) continue;
                const mi = m % nx;
                if (Math.abs(mi - ci) > 1) continue;   // wrapped across a row end
                const d2 = (cx(m) - px[k]) ** 2 + (cy(m) - py[k]) ** 2;
                if (d2 < dist2[m]) { dist2[m] = d2; nearest[m] = k; next.push(m); }
            }
        }
        queue = next;
    }
    // Underwater cells connected to the line.
    const maxD2 = maxReachM * maxReachM;
    const under = (c) => nearest[c] >= 0 && dist2[c] <= maxD2 && !(lake && lake[c]) && heights[c] < eta[nearest[c]] - 0.25;
    // Hollow cells connected to the line.
    const inPool = new Uint8Array(cells);
    let stack = seeds.filter(under);
    for (const c of stack) inPool[c] = 1;
    while (stack.length) {
        const c = stack.pop(), ci = c % nx;
        for (const o of NB) {
            const m = c + o;
            if (m < 0 || m >= cells || inPool[m] || !corridor[m]) continue;
            if (Math.abs((m % nx) - ci) > 1 || !under(m)) continue;
            inPool[m] = 1;
            stack.push(m);
        }
    }
    const reach = new Float64Array(n);
    for (let c = 0; c < cells; c++) {
        if (!inPool[c]) continue;
        const k = nearest[c], r = Math.sqrt(dist2[c]) + 0.5 * spacing;
        if (r > reach[k]) reach[k] = r;
    }
    const inLake = (k) => { const c = cellAt(px[k], py[k]); return !!(lake && c >= 0 && lake[c]); };
    const out = new Float64Array(n);
    for (let k = 0; k < n; k++) {
        if (inLake(k)) { out[k] = -1; continue; }
        let m = 0;
        for (let q = Math.max(0, k - 2); q <= Math.min(n - 1, k + 2); q++) m = Math.max(m, reach[q]);
        out[k] = m;
    }
    return withMasks ? { reach: out, inPool, nearest } : out;
}

/**
 * Grid cells a river segment's carve can reach: the rectangle around its
 * capsule (the segment from (ax, ay) to (bx, by), plane coords, radius
 * reachM), widened by marginM and probed every stepM. A cell (much larger
 * than stepM) that touches the capsule then contains a probe.
 * @param {(x: number, y: number) => number} cellAt  grid cell of a plane point
 * @returns {Set<number>}
 */
export function segmentCells(ax, ay, bx, by, reachM, cellAt, { stepM = 10, marginM = 15 } = {}) {
    const len = Math.hypot(bx - ax, by - ay);
    const ux = len > 0 ? (bx - ax) / len : 1, uy = len > 0 ? (by - ay) / len : 0;
    const r = reachM + marginM;
    const na = Math.max(1, Math.ceil((len + 2 * r) / stepM)), nc = Math.max(1, Math.ceil(2 * r / stepM));
    const cells = new Set();
    for (let i = 0; i <= na; i++) {
        const a = -r + (i / na) * (len + 2 * r);
        for (let j = 0; j <= nc; j++) {
            const c = -r + (j / nc) * 2 * r;
            cells.add(cellAt(ax + a * ux - c * uy, ay + a * uy + c * ux));
        }
    }
    return cells;
}
