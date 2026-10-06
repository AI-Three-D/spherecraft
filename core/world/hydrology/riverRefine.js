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
// speed from the catchment, a smooth falling water level (riverValleyLevels)
// and its valley (riverValleyShape): the terrain is shaped around it
// (riverValley.wgsl.js, riverCarve.wgsl.js).

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
 * level along it never rises downstream (running minimum). passes: binomial
 * [1 2 1] smoothing passes after resampling (end points kept), so the line
 * bends in curves rather than corners (owner 2026-10-05: straight pieces
 * read as a dug moat); arc lengths are measured on the result.
 * @param {Float64Array} xs, ys  plane coords of the path cells
 * @param {Float64Array} fill    spill level per path cell
 * @returns {{ x: number[], y: number[], fill: number[], s: number[] }}
 */
export function smoothRiverPath(xs, ys, fill, { window = 4, stepM = 24, passes = 0 } = {}) {
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
    const m = out.x.length;
    for (let p = 0; p < passes && m > 2; p++) {
        const x = out.x.slice(), y = out.y.slice();
        for (let k = 1; k + 1 < m; k++) {
            out.x[k] = 0.25 * x[k - 1] + 0.5 * x[k] + 0.25 * x[k + 1];
            out.y[k] = 0.25 * y[k - 1] + 0.5 * y[k] + 0.25 * y[k + 1];
        }
    }
    if (passes > 0) for (let k = 1; k < m; k++) out.s[k] = out.s[k - 1] + Math.hypot(out.x[k] - out.x[k - 1], out.y[k] - out.y[k - 1]);
    return out;
}

// Floats per river point (waterWorkerCore.js solveRiver): dir.xyz, design
// level (the channel's waterline: carve and valley), half-width, design
// water depth at the thalweg, mean flow speed, Q, spill level of the trace,
// pool (-1: the point lies in a lake), skew, foam; the valley
// (riverValley.js): floor level, floor half-width, fill weight, wall slope;
// the water (riverWaterLevel): its level (normal depth of Q in the channel),
// its depth at the thalweg; two unused.
export const RIVER_POINT_STRIDE = 20;

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
    // Bank rise beyond the channel's edge (riverCarve.wgsl.js); with
    // (1 - waterFrac) D it is the bank crest, which the valley floor meets.
    bankH: 1.5,
    // The level falls at least this much per metre (owner 2026-10-05: the
    // level staircase made the water crawl).
    minSlope: 3e-4,
    // Share of the river where the floor may sit above the natural ground
    // beside it (fill); the rest is cut into it (a valley).
    tauFill: 0.2,
    // The floor stays this far below that ground where it can.
    marginM: 0.5,
    // One-sided (downstream) smoothing of the fitted level: drops become
    // rapids, never extra fill.
    levelSmoothM: 400,
    // The level meets the lake or sea over this at the river's ends.
    endRampM: 120,
    // The floor's height above the water ramps in over this from the source
    // (at the sill the floor is the lake's level); the fill ramps in over
    // outletFillM. The lake's rim is kept by the valley field (riverValley.js:
    // near lake water the cut stops at its level; no fill on lake water).
    outletRampM: 150,
    outletFillM: 40,
    // Floor half-width = floorScale x channel half-width + floorExtraM.
    floorScale: 1.5,
    floorExtraM: 15,
    // Valley wall slope: wallFrac of the natural rise wallProbeM past the
    // floor's edge, within [wallMin, wallMax].
    wallFrac: 0.7, wallMin: 0.1, wallMax: 0.7, wallProbeM: 300,
});

const quintic01 = (t) => { const x = Math.max(0, Math.min(1, t)); return x * x * x * (x * (x * 6 - 15) + 10); };

/**
 * Non-increasing weighted tau-quantile fit (pool adjacent violators with
 * block quantiles): minimises sum w (tau (v - f)+ + (1 - tau) (f - v)+),
 * so about a share tau of the values ends up below the fit.
 * @param {ArrayLike<number>} v
 * @param {ArrayLike<number>} w  weights
 * @param {number} tau
 * @returns {Float64Array}
 */
export function fitNonIncreasingQuantile(v, w, tau) {
    const blocks = [];
    const quantile = (vals) => {
        let tot = 0; for (const [, ww] of vals) tot += ww;
        let acc = 0;
        for (const [vv, ww] of vals) { acc += ww; if (acc >= tau * tot) return vv; }
        return vals[vals.length - 1][0];
    };
    const mergeSorted = (a, b) => {
        const out = []; let i = 0, j = 0;
        while (i < a.length || j < b.length) out.push(j >= b.length || (i < a.length && a[i][0] <= b[j][0]) ? a[i++] : b[j++]);
        return out;
    };
    for (let k = 0; k < v.length; k++) {
        let blk = { vals: [[v[k], w[k]]], size: 1, value: v[k] };
        while (blocks.length && blocks[blocks.length - 1].value < blk.value) {
            const p = blocks.pop();
            const vals = mergeSorted(p.vals, blk.vals);
            blk = { vals, size: p.size + blk.size, value: quantile(vals) };
        }
        blocks.push(blk);
    }
    const out = new Float64Array(v.length);
    let k = 0;
    for (const b of blocks) for (let q = 0; q < b.size; q++) out[k++] = b.value;
    return out;
}

/**
 * Water level along a river for the valley (riverValley.js): a smooth
 * curve falling at least minSlope per metre from the source lake's level
 * to the destination's, below the natural ground beside the river where it
 * can be (floor = level + freeboard stays marginM under it; fill on about
 * a share tauFill of the river): the non-increasing tau-quantile fit of
 * (ground - freeboard - margin + minSlope s), smoothed looking downstream
 * only (so never above the fit), C2 ramps onto both end levels.
 * @param {object} p
 * @param {ArrayLike<number>} p.s       arc length per point (m)
 * @param {ArrayLike<number>} p.ground  natural ground beside the line (lowest within the floor)
 * @param {ArrayLike<number>} p.free    floor height above the water per point (m)
 * @param {number} p.srcLevel, p.destLevel
 * @returns {{ eta: Float64Array, minSlope: number }}
 */
export function riverValleyLevels({ s, ground, free, srcLevel, destLevel }, P = RIVER_LEVEL_DEFAULTS) {
    const n = s.length, L = s[n - 1];
    let S = P.minSlope;
    if (srcLevel - destLevel < S * L * 1.05) S = Math.max(0, ((srcLevel - destLevel) / Math.max(L, 1)) * 0.5);
    const zt = new Float64Array(n), w = new Float64Array(n).fill(1);
    for (let k = 0; k < n; k++) zt[k] = ground[k] - free[k] - P.marginM + S * s[k];
    const zSrc = srcLevel, zDst = destLevel + S * L;
    zt[0] = zSrc; w[0] = 1e9;
    zt[n - 1] = zDst; w[n - 1] = 1e9;
    const z = fitNonIncreasingQuantile(zt, w, P.tauFill);
    for (let k = 0; k < n; k++) z[k] = Math.min(zSrc, Math.max(zDst, z[k]));
    const step = L / Math.max(1, n - 1), m = Math.max(1, Math.round(P.levelSmoothM / Math.max(step, 1e-6)));
    const K = []; let Ks = 0;
    for (let j = 0; j <= m; j++) { const kv = Math.sin(Math.PI * (j + 0.5) / (m + 1)) ** 2; K.push(kv); Ks += kv; }
    const zs = new Float64Array(n);
    for (let k = 0; k < n; k++) {
        let a = 0;
        for (let j = 0; j <= m; j++) a += K[j] * z[Math.min(n - 1, k + j)];
        zs[k] = a / Ks;
    }
    const R0 = Math.min(P.endRampM, 0.3 * L);
    for (let k = 0; k < n; k++) {
        zs[k] = zSrc + (zs[k] - zSrc) * quintic01(s[k] / R0);
        zs[k] = zs[k] + (zDst - zs[k]) * quintic01((s[k] - (L - R0)) / R0);
    }
    const eta = new Float64Array(n);
    for (let k = 0; k < n; k++) eta[k] = zs[k] - S * s[k];
    return { eta, minSlope: S };
}

/**
 * Normal depth (m) of discharge Q (m^3/s) in the carved channel (Whitewater's
 * profile D (1 - (1 - u^2)^1.5), u = x / half-width; riverCarve.wgsl.js) on
 * slope S, Manning's n: the depth at which uniform flow carries Q. Capped at
 * D (bank-full). Also the wetted area (m^2).
 */
export function riverNormalDepth(Qm3s, S, hw, D, manning) {
    const sq = Math.sqrt(Math.max(S, 1e-6));
    const flow = (h) => {
        // Wetted half-width (fraction of hw) where the profile reaches h.
        const uw = Math.sqrt(Math.max(0, 1 - Math.pow(Math.max(0, 1 - h / D), 2 / 3)));
        let A = 0, Pw = 0;
        const m = 16;
        for (let i = 0; i < m; i++) {
            const u0 = (i / m) * uw, u1 = ((i + 1) / m) * uw;
            const z0 = D * (1 - Math.pow(1 - u0 * u0, 1.5)), z1 = D * (1 - Math.pow(Math.max(0, 1 - u1 * u1), 1.5));
            A += 0.5 * ((h - z0) + (h - z1)) * (u1 - u0) * hw;
            Pw += Math.hypot((u1 - u0) * hw, z1 - z0);
        }
        A *= 2; Pw *= 2;
        return { Q: Pw > 0 ? (A * Math.pow(A / Pw, 2 / 3) * sq) / manning : 0, A };
    };
    const full = flow(D);
    if (full.Q <= Qm3s) return { h: D, A: full.A };
    let lo = 0.005, hi = D;
    for (let it = 0; it < 40; it++) {
        const mid = 0.5 * (lo + hi);
        if (flow(mid).Q < Qm3s) lo = mid; else hi = mid;
    }
    const h = 0.5 * (lo + hi);
    return { h, A: flow(h).A };
}

/** Bank crest above the water: (1 - waterFrac) D + the bank's rise at its crest (riverCarve.wgsl.js). */
export function riverCrestAbove(depth, P = RIVER_LEVEL_DEFAULTS) {
    return (1 - P.waterFrac) * depth + P.bankH * (1 - Math.exp(-2));
}

/**
 * The valley along a river (riverValley.js), per point: floor level (the
 * level plus its freeboard), fill weight, wall slope. The fill ramps in over
 * outletFillM from the source and fades out toward the end (the
 * destination's water); none where the point lies in a lake.
 * @param {object} p
 * @param {ArrayLike<number>} p.s, p.eta, p.free, p.wc   per point
 * @param {ArrayLike<number>} p.rise   natural ground wallProbeM past the floor's edge (higher side)
 * @param {ArrayLike<boolean>} p.inLake
 */
export function riverValleyShape({ s, eta, free, wc, rise, inLake }, P = RIVER_LEVEL_DEFAULTS) {
    const n = s.length, L = s[n - 1];
    const F = new Float64Array(n), wFill = new Float64Array(n), raw = new Float64Array(n), sWall = new Float64Array(n);
    for (let k = 0; k < n; k++) {
        F[k] = eta[k] + free[k];
        wFill[k] = inLake[k] ? 0 : Math.min(quintic01(s[k] / P.outletFillM), quintic01((L - s[k]) / P.endRampM - 0.25));
        raw[k] = Math.min(P.wallMax, Math.max(P.wallMin, P.wallFrac * Math.max(0, rise[k] - F[k]) / P.wallProbeM));
    }
    for (let k = 0; k < n; k++) {
        let a = 0, m = 0;
        for (let q = Math.max(0, k - 15); q <= Math.min(n - 1, k + 15); q++) { a += raw[q]; m++; }
        sWall[k] = a / m;
    }
    return { F, wFill, sWall };
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
