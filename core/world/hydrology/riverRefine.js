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
// The trace is then smoothed, resampled, and given a water surface (fill +
// depth), width, depth and flow speed from the catchment.

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

export const RIVER_SHAPE_DEFAULTS = Object.freeze({
    // Discharge (m^3/s) per km^2 of precipitation-weighted catchment.
    runoffM3sPerKm2: 0.03,
    widthCoef: 4.0,       // width = widthCoef * Q^0.5 (m), at least minWidthM
    widthExp: 0.5,
    minWidthM: 10,
    depthCoef: 0.45,      // depth = depthCoef * Q^0.4 (m), at least minDepthM
    depthExp: 0.4,
    minDepthM: 0.6,
    manning: 0.035,
});

/** Width, depth (m) and flow speed (m/s) of a river with discharge Q (m^3/s) and surface slope S. */
export function riverShape(Qm3s, slope, P = RIVER_SHAPE_DEFAULTS) {
    const width = Math.max(P.minWidthM, P.widthCoef * Math.pow(Math.max(Qm3s, 0), P.widthExp));
    const depth = Math.max(P.minDepthM, P.depthCoef * Math.pow(Math.max(Qm3s, 0), P.depthExp));
    const speed = Math.max(0.3, Math.min(3.5, Math.pow(depth, 2 / 3) * Math.sqrt(Math.max(slope, 1e-5)) / P.manning));
    return { width, depth, speed };
}
