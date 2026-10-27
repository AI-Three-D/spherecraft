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
// The sparse landscape bake prepares the banks around this surface.

import { MinHeap } from './waterGraph.js';
import { riverHash, riverNoise } from '../water/riverShapeNoise.js';
import { RIVER_SECTION, riverWidthFactor } from '../water/riverSection.js';

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

// The nearest cell of mask to every cell (two raster passes carrying the
// nearest seed) and the distance to it (cells).
function nearestCell(mask, nx, ny) {
    const n = nx * ny, near = new Int32Array(n).fill(-1), d = new Float32Array(n).fill(Infinity);
    for (let k = 0; k < n; k++) if (mask[k]) { near[k] = k; d[k] = 0; }
    const visit = (k, i, j, o) => {
        const q = near[k + o];
        if (q < 0) return;
        const e = Math.hypot(i - q % nx, j - Math.floor(q / nx));
        if (e < d[k]) { d[k] = e; near[k] = q; }
    };
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        if (i > 0) visit(k, i, j, -1);
        if (j > 0) { visit(k, i, j, -nx); if (i > 0) visit(k, i, j, -nx - 1); if (i + 1 < nx) visit(k, i, j, -nx + 1); }
    }
    for (let j = ny - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) {
        const k = j * nx + i;
        if (i + 1 < nx) visit(k, i, j, 1);
        if (j + 1 < ny) { visit(k, i, j, nx); if (i + 1 < nx) visit(k, i, j, nx + 1); if (i > 0) visit(k, i, j, nx - 1); }
    }
    return { near, d };
}

export const RIVER_APPROACH_DEFAULTS = Object.freeze({
    // The path is re-routed from where it is this far from the lake's water
    // for good (within reachM of its end there).
    awayM: 96, reachM: 640,
    // Within bandM of the shore a step on land along it costs up to
    // 1 + bandCost (sin^2 of its angle to the shore's normal); one straight
    // toward or away from the water nothing more. In the water a step costs
    // up to 1 + bandCost near the shore, so the way keeps to the middle.
    bandM: 64, bandCost: 4,
    // Ground above the old path's spill level (at its nearest cell) costs
    // this per metre per step: a metre or so beside a lake is cut through
    // (riverCarve); the new way keeps to the old one's valley floor.
    climbCostPerM: 3,
});

/**
 * Where a traced cell path leaves its lake (atStart: an outlet, the path
 * starts in the water) or reaches it, re-routes its stretch near the lake so
 * that it meets the shore at an angle: from where the path is awayM from
 * the water for good to the nearest of its water, the cheapest way over
 * land where steps along the shore near it cost more (the way meets the
 * shore head-on), as does ground above the old path's spill level near it
 * (never below the lake's level). An outlet's way from
 * its source to there keeps to the middle of the water. The flood's path
 * ran along its lake for up to 150 m, beside a shallow arm of it or through
 * it (owner 2026-10-27: rivers meet a lake at an angle, never run along it).
 * @param {object} p
 * @param {Int32Array} p.path    cell path, source first
 * @param {Float64Array} p.fill  spill level per path cell (traceRiverPatch)
 * @param {Uint8Array} p.water   1 = this lake's water
 * @param {number} p.level       the lake's level (m)
 * @param {number} p.spacing     cell size (m)
 * @returns {{ path: Int32Array | null, why: string }}  the new path (null
 *   keeps the old) and why: ok, near (never awayM from the water), noWay
 *   (no water within the corridor), srcDry (an outlet's first cell not in
 *   the water)
 */
export function riverLakeApproach({ path, fill, heights, nx, ny, corridor, water, atStart, level, spacing }, P = RIVER_APPROACH_DEFAULTS) {
    const n = nx * ny, toWater = nearestCell(water, nx, ny), dWater = toWater.d;
    // The first (last) path cell awayM from the water after which it stays
    // away (within reachM): a path coming back to brush the lake again kept
    // that stretch.
    const away = P.awayM / spacing, m = path.length, reach = Math.round(P.reachM / spacing);
    let a = -1;
    if (atStart) {
        for (let i = 0; i < Math.min(m, reach); i++) if (dWater[path[i]] < away) a = i;
        do a++; while (a < m && dWater[path[a]] < away);
        if (a >= m) a = -1;
    } else {
        a = m;
        for (let i = m - 1; i >= Math.max(0, m - reach); i--) if (dWater[path[i]] < away) a = i;
        do a--; while (a >= 0 && dWater[path[a]] < away);
    }
    if (a < 0) return { path: null, why: 'near' };
    // The old path's spill level at its cell nearest each cell (never below
    // the lake's): against one level for all, a steep river's new way ran
    // along the hillside below it and cut a tall bank into the slope.
    const onPath = new Uint8Array(n), index = new Int32Array(n).fill(-1);
    for (let i = 0; i < m; i++) { onPath[path[i]] = 1; index[path[i]] = i; }
    const toPath = nearestCell(onPath, nx, ny);
    const ref = (c) => Math.max(level, fill[index[toPath.near[c]]]);
    const band = P.bandM / spacing;
    // The share of a step along the shore: its angle to the direction from
    // the nearest water cell (the distance's gradient vanishes along the
    // middle of a strip of land between two waters).
    const along = (c, di, dj) => {
        const q = toWater.near[c];
        if (q < 0) return 0;
        const gx = c % nx - q % nx, gy = Math.floor(c / nx) - Math.floor(q / nx), g = Math.hypot(gx, gy);
        if (!(g > 0)) return 0;
        const cr = (di * gy - dj * gx) / (g * Math.hypot(di, dj));
        return cr * cr;
    };
    const landCost = (c, di, dj) => (di && dj ? Math.SQRT2 : 1) * (1 + P.bandCost * Math.max(0, 1 - dWater[c] / band) * along(c, di, dj)
        + P.climbCostPerM * Math.max(0, heights[c] - ref(c)));
    // Cheapest ways from cell from (Dijkstra over corridor cells allowed by
    // ok) to the first cell where done: the cells, from first to last.
    const cheapest = (from, ok, stepCost, done) => {
        const cost = new Float64Array(n).fill(Infinity), parent = new Int32Array(n).fill(-1), closed = new Uint8Array(n);
        const heap = new MinHeap(n);
        cost[from] = 0; heap.push(0, from);
        while (heap.size > 0) {
            const id = heap.pop();
            if (closed[id]) continue;
            closed[id] = 1;
            if (done(id)) {
                const way = [];
                for (let c = id; c !== -1; c = parent[c]) way.push(c);
                return way.reverse();
            }
            const i = id % nx, j = (id - i) / nx;
            for (const [di, dj] of NB8) {
                const ii = i + di, jj = j + dj;
                if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
                const nb = jj * nx + ii;
                if (closed[nb] || !corridor[nb] || !ok(nb)) continue;
                const c = cost[id] + stepCost(nb, di, dj);
                if (c < cost[nb]) { cost[nb] = c; parent[nb] = id; heap.push(c, nb); }
            }
        }
        return null;
    };
    const toLake = cheapest(path[a], () => true, landCost, (c) => water[c] === 1);
    if (!toLake) return { path: null, why: 'noWay' };
    if (!atStart) return { path: Int32Array.from([...path.subarray(0, a), ...toLake]), why: 'ok' };
    // An outlet: from its source through the middle of the water to there.
    const src = path[0];
    if (!water[src]) return { path: null, why: 'srcDry' };
    const land = Uint8Array.from(water, (w) => 1 - w), dLand = nearestCell(land, nx, ny).d, target = toLake[toLake.length - 1];
    const inLake = cheapest(src, (c) => water[c] === 1,
        (c, di, dj) => (di && dj ? Math.SQRT2 : 1) * (1 + P.bandCost * Math.max(0, 1 - dLand[c] / band)), (c) => c === target);
    if (!inLake) return { path: null, why: 'srcDry' };
    return { path: Int32Array.from([...inLake.slice(0, -1), ...toLake.reverse(), ...path.subarray(a + 1)]), why: 'ok' };
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
// pool (-1: the point lies in a lake), skew, foam; the bend's signed
// curvature (1/m, + turning left; riverSection.js bank types), the ground
// the level fit saw beside the channel (its lowest, m), the lake rims left
// and right (riverLakeRims);
// the water (riverWaterLevel): its level (normal depth of Q in the channel),
// its depth at the thalweg; nearby lake level, optional island mask.
export const RIVER_POINT_STRIDE = 20;

export const RIVER_SHAPE_DEFAULTS = Object.freeze({
    // Discharge (m^3/s) per km^2 of precipitation-weighted catchment.
    runoffM3sPerKm2: 0.03,
    // Owner 2026-10-05: rivers at least 3x wider than the first version
    // (10 m, 4 Q^0.5). Whitewater's rivers are 11-24 m wide, 1-2.3 m deep.
    widthCoef: 12.0,      // width = widthCoef * Q^0.5 (m), at least minWidthM
    widthExp: 0.5,
    // Small rivers stay small (owner 2026-10-13: most rivers seen are small,
    // with some big ones 50-100+ m): as the mountain streams. Was 30 m and
    // 1.4 m, when only lakes with Q >= 1200 had rivers (waterGraph.js minRiverQ).
    // 12 m (was 8): narrower beds were one or two splat texels wide on
    // coarser tiles and drew as beads (owner 2026-10-26, 50 % wider).
    minWidthM: 12,
    // Constrictions (riverReachShape's width factor) narrow a reach to this
    // at least (they went to 3.3 m).
    minReachWidthM: 8,
    // Bank-full depth D (thalweg to the channel's edge); the water fills
    // waterFrac of it (RIVER_LEVEL_DEFAULTS). Twice the first design (0.6,
    // 0.8 m): the water was 0.4-0.6 m deep, the banks' fixed margins took
    // much of it and deltas were dry mud (owner 2026-10-26).
    depthCoef: 1.0,       // D = depthCoef * Q^0.4 (m), at least minDepthM
    depthExp: 0.4,
    minDepthM: 1.6,
    // Pools and constrictions shallow a reach to this share of minDepthM at
    // most; deltas not below minDepthM (at 60 % the mouths' water was 0.7 m
    // and read as wet mud, owner 2026-10-26).
    minReachDepthShare: 0.8,
    // Leaving its lake, a river's water deepens by at most this a point
    // (stepM, 20 m) until its own depth (waterWorkerCore.js solveRiver).
    outletDeepenM: 0.4,
    manning: 0.035,
    depthVar: 0.45,
    junctionWidthScale: 2.3,
    junctionLengthM: 180,
    // A river's delta into its destination lake (P.deltaLake; junctions and
    // outlets keep the junction flare): it widens like a trumpet over
    // lengthWidths of its typical width (at least minLengthM) before the
    // lake (growing as u^shapeExp over it), to scale x its width, bigShare
    // of the rivers to bigScale, at least minDepthM deep. Its full width is
    // at the shore
    // (waterWorkerCore.js deltaEndK): the flare centred on the coarse lake
    // entry fell mostly under the water and read as no delta at all (owner
    // 2026-10-26).
    // Its bed also deepens over that length to the lake's depth just past
    // the shore (frontDepthM of water at most, near opaque): from a shallow
    // river onto a lake shelving steeply the water's colour changed at the
    // shoreline, a muddy rim across the mouth (owner 2026-10-26).
    delta: Object.freeze({ scale: [1.6, 2.4], bigShare: 0.35, bigScale: [3, 4], lengthWidths: [6, 12], minLengthM: 100, shapeExp: 1.6, frontDepthM: 3,
        salts: Object.freeze({ big: 0x3d51, scale: 0x6a2f, length: 0x1b77 }) }),
    sourceInsetM: 100,
    islands: false,
    islandThreshold: 0.3,
    waterfalls: { enabled: false },    // riverFeatures.js RIVER_FALL_DEFAULTS overrides
});

/** How far into its delta arc length s (m) is: 0 before it, 1 at the lake entry (end). */
export function riverDeltaProgress(s, end, river, typicalWidthM, D = RIVER_SHAPE_DEFAULTS.delta) {
    const lerp = (r, t) => r[0] + (r[1] - r[0]) * t;
    const L = Math.max(D.minLengthM, typicalWidthM * lerp(D.lengthWidths, riverHash(river, D.salts.length)));
    return Math.min(1, Math.max(0, 1 - (end - s) / L));
}

/** Width factor of a river's delta at arc length s (m), its lake entry at end. */
export function riverDelta(s, end, river, typicalWidthM, D = RIVER_SHAPE_DEFAULTS.delta) {
    const lerp = (r, t) => r[0] + (r[1] - r[0]) * t;
    const big = riverHash(river, D.salts.big) < D.bigShare;
    const scale = lerp(big ? D.bigScale : D.scale, riverHash(river, D.salts.scale));
    return 1 + (scale - 1) * Math.pow(riverDeltaProgress(s, end, river, typicalWidthM, D), D.shapeExp);
}

/**
 * Baked pools/constrictions and lake mouths. Depth never sets the surface
 * slope. The width varies 2-3x along a river, more in some rivers than in
 * others, over a few of its widths (riverSection.js riverWidthFactor; P.typicalWidthM:
 * the river's typical width, one value per river).
 */
export function riverReachShape(shape, s, length, river, P = RIVER_SHAPE_DEFAULTS) {
    const reach = riverNoise(s, river, 'reach').v;
    const pool = riverNoise(s, river, 'depth').v;
    const joinM = Math.max(P.junctionLengthM, shape.width * 2);
    const start = P.junctionStartM ?? 0, end = P.junctionEndM ?? length;
    const delta = P.deltaLake ? riverDelta(s, end, river, P.typicalWidthM ?? shape.width, P.delta ?? RIVER_SHAPE_DEFAULTS.delta) : 1;
    const mouth = 1 - quintic01(Math.min(Math.abs(s - start), P.deltaLake ? Infinity : Math.abs(end - s)) / joinM);
    const width = Math.max(P.minReachWidthM ?? 0, shape.width * riverWidthFactor(s, river, P.typicalWidthM ?? shape.width).f) * (1 + (P.junctionWidthScale - 1) * mouth) * delta;
    const floor = P.minDepthM * ((P.minReachDepthShare ?? 0) + (1 - (P.minReachDepthShare ?? 0)) * Math.min(1, (delta - 1) / 0.2));
    const depth = Math.max(floor, shape.depth * Math.max(0.45, 1 + P.depthVar * pool) * Math.pow(shape.width / width * delta, 0.25));
    const island = P.islands && s > 2 * joinM && length - s > 2 * joinM
        ? quintic01((reach - P.islandThreshold) / 0.3) * (1 - quintic01(((shape.slope ?? 0) - 0.004) / 0.008)) : 0;
    return { ...shape, width, depth, island };
}

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

// Bump on any change to the river trace, levels or bank bake (river cache
// key, WaterService): 2 = bounded level smoothing and ramps, lake holds only
// at the river's ends, bank limits from the nearest channel point; 3 = width
// from riverSection.js riverWidthFactor, curvature in the record (12);
// 4 = a tributary ends at its trunk's level where it meets it (trunkLevelAt);
// 5 = a reverted lake-floor trial (water-look v82); 6 = lake rims per side
// in the record (14, 15: riverLakeRims); 7 = rims over 40 m; 8 = rapids
// instead of averaging 400 m downstream; 9 = the level fit's ground in the
// record (13); 10 = levels not smoothed; 11 = the level under the ground at
// the channel's edge (bankBandM), freeboard from the section; 12 = rims
// measured from the banks; 13 = the source lake's level held while the
// ground beside the channel is below it, at most 32 m; 14 = held while the
// lake's drawn water lies beside it (riverLakeHold); 15 = downstream of
// the hold the fit from the lake as before.
// 16 = refined lower lakes terminate reaches at their own surface;
// 17 = rivers at least 12 m wide, constrictions to 8 m (minReachWidthM);
// 18 = a share of the rivers widens to 3-4 x (riverSection.js wideShare);
// 19 = deltas into lakes (RIVER_SHAPE_DEFAULTS.delta); 20 = full at the
// shore; 21 = longer, gentler; 22 = rivers twice as deep; 23 = lake rims
// fall relative to the water (riverLakeRims wl); 24 = deltas and pools
// not as shallow; 25 = deltas deepen to the lake's depth; 26-39 = ends
// re-routed to meet their lakes head-on (riverLakeApproach), held outlets
// part of their lake (riverHeldDepth), deepening gradually (outletDeepenM).
export const RIVER_SOLVE_VERSION = 39;

export const RIVER_LEVEL_DEFAULTS = Object.freeze({
    // Water fills this fraction of the bank-full depth (Whitewater: 0.75).
    waterFrac: 0.75,
    // The level falls at least this much per metre (owner 2026-10-05: the
    // level staircase made the water crawl).
    minSlope: 3e-4,
    // Quantile of adjacent ground used to fit the surface. This is not a
    // terrain fill operation; low depressions remain untouched by carving.
    tauFill: 0,
    // The floor stays this far below that ground where it can.
    marginM: 0.5,
    // The level near the source stays at most this far above the fitted
    // surface: the ramp from the lake's level over a steep outlet held the
    // water above falling ground (floating ribbons, owner 2026-10-12).
    rampRiseM: 0.5,
    // The level meets the lake or sea over this at the river's ends.
    endRampM: 120,
    // Ramp the freeboard allowance used by the surface fit near the source.
    outletRampM: 150,
    // The level stays marginM under the ground within bankBandM of the
    // channel's edge, where the banks hold the water. The lowest ground
    // within 2 hw + 25 m put streams on cross slopes 2 m deeper (water-look v97).
    bankBandM: 4,
    // Lakes within this of the river's line (floorScale hw + floorExtraM) anchor its level.
    floorScale: 2.0,
    floorExtraM: 25,
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
 * The bank-full depth D of a river point held at its source lake's level
 * (riverLakeHold): part of the lake as far as its banks lie under the
 * level, unless the lake within 24 m is as deep as its channel. No channel along a shallow
 * arm of the lake (a full one showed as a groove for 160 m: owner
 * 2026-10-27, rivers meet a lake at an angle); the full channel between dry
 * banks (through the lake's rim; by the ground at its centre, a gully there
 * left 2 cm of water through a rim 0.5-0.9 m high, a mud band between two
 * knobs) and on through a narrow shallow edge into the deep water (without,
 * the edge drew a mud band across the outlet).
 * @param {object} p
 * @param {number} p.x, p.y, p.tx, p.ty  the point and its direction (plane, m)
 * @param {number} p.hw, p.depth          half-width, bank-full depth D (m)
 * @param {(x: number, y: number) => number} p.groundAt  natural ground (m)
 * @param {(x: number, y: number) => boolean} p.inLake  the lake's water there
 * @param {number} p.level                the lake's level (m)
 * @returns {number} D
 */
export function riverHeldDepth({ x, y, tx, ty, hw, depth, groundAt, inLake, level }, P = RIVER_LEVEL_DEFAULTS) {
    const tl = Math.hypot(tx, ty) || 1;
    // Lake water only: ground under the level past the outlet is the
    // river's own valley (counted, it cut a groove into a bay up to 24 m from it).
    const lakeDepth = (u, v) => (inLake(u, v) ? Math.max(0, level - groundAt(u, v)) : 0);
    let wet = 0, deep = 0;
    for (const side of [-1, 1]) {
        for (const d of [hw, hw + 0.5 * P.bankBandM, hw + P.bankBandM]) {
            if (lakeDepth(x - ty / tl * side * d, y + tx / tl * side * d) > 0) wet++;
        }
    }
    for (const r of [8, 16, 24]) {
        for (let q = 0; q < 8; q++) deep = Math.max(deep, lakeDepth(x + r * Math.cos(q * Math.PI / 4), y + r * Math.sin(q * Math.PI / 4)));
    }
    // Into deep water nearby (as deep as its channel): a bay as deep as half
    // its water, given that depth, kept a faint groove ending in a line.
    const water = depth * P.waterFrac, t = Math.min(1, Math.max(0, (deep - 0.5 * water) / (0.5 * water)));
    return Math.min(depth, Math.max(0.02 / P.waterFrac, depth * (1 - wet / 6), depth * t * t * (3 - 2 * t)));
}

/**
 * The levels (riverValleyLevels) with a river's start held at its source
 * lake's level: past the last point touching the lake (sourceEnd) while
 * held[k]: beside the channel the ground is below the lake's level within
 * the lake's drawn shore band, and nowhere outside it. There the lake's
 * water lies beside the river; a river dropping below it made the lake give
 * way over the river's half-width, and the banks between the river's
 * waterline and there stayed bare under both surfaces (owner 2026-10-14
 * "floating", water-look v108). Beyond, the fit from the lake as before
 * (restarted there, its ramp held the water up to 0.5 m higher over the
 * next 120 m, over lower banks: v114). Held beside land below the level
 * outside the band, the river stood above that land, nothing drawn (v113).
 * @param {object} p
 * @param {Float64Array} p.eta  levels from sourceEnd (changed in place)
 * @param {ArrayLike<number>} p.held  per point: 1 = the lake's water beside it (above)
 * @param {number} p.srcLevel
 * @param {number} p.sourceEnd  last point touching the source lake
 * @param {number} p.destStart  first point touching the destination
 * @returns {number} the last point held
 */
export function riverLakeHold({ eta, held, srcLevel, sourceEnd, destStart }) {
    let k = sourceEnd;
    while (k + 1 < destStart && held[k + 1]) eta[++k] = srcLevel;
    return k;
}

/**
 * Water level along a river for the valley (riverValley.js): a smooth
 * curve falling at least minSlope per metre from the source lake's level
 * to the destination's, below the natural ground beside the river where it
 * can be (floor = level + freeboard stays marginM under it; fill on about
 * a share tauFill of the river): the non-increasing tau-quantile fit of
 * (ground - freeboard - margin + minSlope s), not smoothed (the points
 * 20 m apart make a drop a rapid, waterfalls bake larger ones; averaging
 * 400 m downstream put every steep stream the cap of 2 m deeper, water-look
 * v96), C2 ramps onto both end levels (at most rampRiseM above the fit).
 * @param {object} p
 * @param {ArrayLike<number>} p.s       arc length per point (m)
 * @param {ArrayLike<number>} p.ground  natural ground beside the line (lowest within the floor)
 * @param {ArrayLike<number>} p.free    floor height above the water per point (m)
 * @param {number} p.srcLevel, p.destLevel
 * @returns {{ eta: Float64Array, minSlope: number }}
 */
export function riverValleyLevels({ s, ground, free, srcLevel, destLevel, sourceEnd = 0, destStart = s.length - 1 }, P = RIVER_LEVEL_DEFAULTS) {
    // Fit only between lake overlaps, which stay flat at their lake's level.
    if (sourceEnd > 0 || destStart < s.length - 1) {
        const ss = Array.from(s).slice(sourceEnd, destStart + 1).map(x => x - s[sourceEnd]);
        const fitted = riverValleyLevels({ s: ss, ground: Array.from(ground).slice(sourceEnd, destStart + 1), free: Array.from(free).slice(sourceEnd, destStart + 1), srcLevel, destLevel }, P);
        const eta = new Float64Array(s.length).fill(destLevel);
        eta.fill(srcLevel, 0, sourceEnd);
        eta.set(fitted.eta, sourceEnd);
        return { eta, minSlope: fitted.minSlope };
    }
    const n = s.length, L = s[n - 1];
    if (n < 2 || !(L > 0)) return { eta: new Float64Array(n).fill(srcLevel), minSlope: 0 };
    let S = P.minSlope;
    if (srcLevel - destLevel < S * L * 1.05) S = Math.max(0, ((srcLevel - destLevel) / Math.max(L, 1)) * 0.5);
    const zt = new Float64Array(n), w = new Float64Array(n).fill(1);
    for (let k = 0; k < n; k++) zt[k] = ground[k] - free[k] - P.marginM + S * s[k];
    const zSrc = srcLevel, zDst = destLevel + S * L;
    zt[0] = zSrc; w[0] = 1e9;
    zt[n - 1] = zDst; w[n - 1] = 1e9;
    const z = fitNonIncreasingQuantile(zt, w, P.tauFill);
    for (let k = 0; k < n; k++) z[k] = Math.min(zSrc, Math.max(zDst, z[k]));
    const zs = Float64Array.from(z);
    const R0 = Math.min(P.endRampM, 0.3 * L);
    for (let k = 0; k < n; k++) {
        zs[k] = zSrc + (zs[k] - zSrc) * quintic01(s[k] / R0);
        zs[k] = zs[k] + (zDst - zs[k]) * quintic01((s[k] - (L - R0)) / R0);
        // Every bound is non-increasing along s, so the level still falls.
        zs[k] = Math.min(zs[k], Math.max(z[k] + P.rampRiseM, zDst));
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

/**
 * Bank-full above the water: (1 - waterFrac) D (riverSection.js: banks at
 * most this high above the water at the channel's edge). The old organic
 * banks' further 0.8 m rise kept the water 0.7 m deeper (water-look v97).
 */
export function riverCrestAbove(depth, P = RIVER_LEVEL_DEFAULTS) {
    return (1 - P.waterFrac) * depth;
}

/**
 * Lake rims along a river (record 14 left, 15 right; riverSection.js
 * riverBankRim): per side, the highest level of drawn water (a solved lake or
 * the sea) near that bank, plus lakeMarginM, less lakeSlope per m of the
 * water's distance beyond lakeBandM. Distances are measured from points on
 * the bank (5 and 20 m beyond the channel's edge), so water behind or ahead
 * of the point counts for the bank it is near: from the line, by half-plane,
 * a lake just upstream of an outlet's bank was 57 m off and the bank was cut
 * below it (water-look v102). The rims fall by at most lakeSlope per m along
 * the river, so they stay continuous between points; -1e4 where no water is
 * in reach. With the river's water level (o.wl), their height above it falls
 * so instead: carried as absolute heights down a stream steeper than
 * lakeSlope, a source lake's rim stood 20 m above the water 270 m below the
 * lake and the bank cut a wall and a bench into the hillside (owner
 * 2026-10-26, "facets").
 * @param {object} o
 * @param {ArrayLike<number>} o.x, o.y, o.s  points (plane m) and arc length
 * @param {ArrayLike<number>} o.hw     half-width per point (m)
 * @param {ArrayLike<number>} o.reach  per point: how far its banks reach (m)
 * @param {Uint8Array} o.water  patch cells of drawn water; o.level their level
 * @param {ArrayLike<number>} [o.wl]  the river's water level per point (m)
 * @param {number} o.nx, o.ny, o.x0, o.y0, o.spacing  the patch grid
 * @returns {{ left: Float64Array, right: Float64Array }}
 */
export function riverLakeRims({ x, y, s, hw, reach, water, level, wl, nx, ny, x0, y0, spacing }, P = RIVER_SECTION) {
    const n = x.length, NONE = -1e4;
    const left = new Float64Array(n).fill(-Infinity), right = new Float64Array(n).fill(-Infinity);
    for (let k = 0; k < n; k++) {
        const a = Math.max(0, k - 1), b = Math.min(n - 1, k + 1);
        const tl = Math.hypot(x[b] - x[a], y[b] - y[a]) || 1, nxv = -(y[b] - y[a]) / tl, nyv = (x[b] - x[a]) / tl;
        const r = reach[k] + P.lakeBandM;
        const i0 = Math.max(0, Math.floor((x[k] - r - x0) / spacing)), i1 = Math.min(nx - 1, Math.floor((x[k] + r - x0) / spacing));
        const j0 = Math.max(0, Math.floor((y[k] - r - y0) / spacing)), j1 = Math.min(ny - 1, Math.floor((y[k] + r - y0) / spacing));
        // Bank points: left (+1) and right (-1), 5 and 20 m beyond the edge.
        const banks = [];
        for (const side of [1, -1]) for (const o of [5, 20]) banks.push([side, x[k] + nxv * side * (hw[k] + o), y[k] + nyv * side * (hw[k] + o)]);
        for (let j = j0; j <= j1; j++) {
            for (let i = i0; i <= i1; i++) {
                const c = j * nx + i;
                if (!water[c]) continue;
                const cx = x0 + (i + 0.5) * spacing, cy = y0 + (j + 0.5) * spacing;
                if (Math.hypot(cx - x[k], cy - y[k]) > r) continue;
                for (const [side, bx, by] of banks) {
                    const g = level[c] + P.lakeMarginM - P.lakeSlope * Math.max(0, Math.hypot(cx - bx, cy - by) - P.lakeBandM);
                    if (side > 0) { if (g > left[k]) left[k] = g; } else if (g > right[k]) right[k] = g;
                }
            }
        }
    }
    const base = (k) => (wl ? wl[k] : 0);
    for (const A of [left, right]) {
        for (let k = 1; k < n; k++) A[k] = Math.max(A[k], A[k - 1] - base(k - 1) + base(k) - P.lakeSlope * (s[k] - s[k - 1]));
        for (let k = n - 2; k >= 0; k--) A[k] = Math.max(A[k], A[k + 1] - base(k + 1) + base(k) - P.lakeSlope * (s[k + 1] - s[k]));
        for (let k = 0; k < n; k++) if (!(A[k] > NONE)) A[k] = NONE;
    }
    return { left, right };
}

/**
 * A trunk river's level where a tributary meets it: its design level
 * interpolated along its segment nearest to (x, y).
 * @param {Array<[number, number]>} pts  the trunk's points (plane coords)
 * @param {ArrayLike<number>} etas      its design level per point
 * @returns {{ level: number, distM: number }}
 */
export function trunkLevelAt(pts, etas, x, y) {
    let best = { level: etas[0], distM: Math.hypot(x - pts[0][0], y - pts[0][1]) };
    for (let k = 0; k + 1 < pts.length; k++) {
        const [ax, ay] = pts[k], ux = pts[k + 1][0] - ax, uy = pts[k + 1][1] - ay;
        const t = Math.max(0, Math.min(1, ((x - ax) * ux + (y - ay) * uy) / (ux * ux + uy * uy || 1e-9)));
        const d = Math.hypot(x - ax - t * ux, y - ay - t * uy);
        if (d < best.distM) best = { level: etas[k] + (etas[k + 1] - etas[k]) * t, distM: d };
    }
    return best;
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
