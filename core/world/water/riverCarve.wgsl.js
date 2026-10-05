// core/world/water/riverCarve.wgsl.js
//
// River corridors shaped into the terrain height function, from the traced
// rivers' segments (WaterGpuData.js, waterWorkerCore.js solveRiver). It is
// the last step of calculateTerrainHeightD (earthLikeBase.wgsl.js), so every
// consumer of the height gets the same river: tiles at every LOD (tile
// edges stay stitched), normals, the water simulation's bed. The hydrology
// sampler compiles the terrain without it (it traces the rivers on the
// natural terrain).
//
// Like Whitewater (its river.js builds the terrain from the river), every
// cross-section rises on both sides of the water, so the water has no route
// out (owner 2026-10-05: "water flows where it has a route"). The
// cross-section is waterRiverProfile (waterWgsl.js): channel, then the bank
// rising bankH beyond the channel's edge; the river is cut into the ground
// so the bank crest meets the natural terrain (waterWorkerCore.js levels).
// With x = metres beyond the channel's edge:
// - x < bankW: the terrain is the cross-section: cut where the ground is
//   higher, raised (a levee) where it is lower (not in the lakes at the
//   river's ends: pool < 0);
// - bankW .. bankW + blendW: cut and levee fade out to the natural terrain;
// - hollows beside the river below its level (worker: riverPools; lab
//   2026-10-05: most of a river's length passes them, often metres deep)
//   are filled to the floodplain: the bank zone's end level, rising
//   floodGrade per metre, out to their reach, fading over poolFadeM;
// - each segment shapes the terrain on its own; the shapes are blended by
//   distance, the nearest dominating (riverCarve_d).
// Smooth min + smooth max: where both weights are 1 (the bank zone) the
// result is the cross-section exactly (smin + smax = a + b).
// Dual numbers vec4(height, d/d unitDir) as in the height function; the
// gradients of half-width, pool and skew along the river are left out
// (they vary slowly).

import { createWaterCommonWgsl, RIVER_MAX_SEGS_PER_CELL } from './waterWgsl.js';

// Group 1 of the terrain generator's pipelines (binding 0 is its biome uniform).
export const RIVER_CARVE_GROUP = 1;
export const RIVER_CARVE_BINDINGS = Object.freeze({ index: 1, params: 2, rivers: 3 });
// Blending of the segments' shapes by distance (m), the fade-in (m) of a
// segment's weight at its reach, and the smoothing (m) of cut and fill edges.
export const RIVER_CARVE_BLEND_M = 2;
export const RIVER_CARVE_ENTRY_M = 6;
export const RIVER_CARVE_SMOOTH_M = 0.5;

/**
 * @param {object} [o]
 * @param {boolean} [o.enabled=true]  false: pass-through stubs (no bindings)
 * @returns {string} WGSL: riverCarve_d(hd, unitDir), riverCarveMicroKeep(unitDir)
 */
export function createRiverCarveWgsl({ enabled = true } = {}) {
    if (!enabled) {
        return /* wgsl */`
// River carve off in this shader (riverCarve.wgsl.js).
fn riverCarve_d(hd: vec4<f32>, unitDir: vec3<f32>) -> vec4<f32> { return hd; }
fn riverCarveMicroKeep(unitDir: vec3<f32>) -> f32 { return 1.0; }
`;
    }
    return /* wgsl */`
// ==================== River corridors (core/world/water/riverCarve.wgsl.js) ====
${createWaterCommonWgsl(RIVER_CARVE_GROUP, RIVER_CARVE_BINDINGS)}

// River segments that can reach unitDir: first << 8 | count (count 0: none).
fn riverCarveCellEntry(unitDir: vec3<f32>) -> u32 {
    if (waterParams.gridN == 0u || waterParams.carve.x < 0.5 || !terrainFeatureOn(TF_WATER_CARVE)) { return 0u; }
    return waterRiverList(unitDir);
}

// How far the segment acts: its cross-section (channel, banks, blend into
// the terrain) and the hollows beside it that it fills.
fn riverCarveReach(p: WaterRiverPt) -> f32 {
    let zone = p.hw + waterParams.carve.y + waterParams.carve.z;
    return max(zone, select(0.0, p.pool + waterParams.flood.x, p.pool > 0.0)) + 1.0;
}

// The cross-section of segment s at unitDir as a dual (p: its nearest
// point); flat = true: the floodplain the hollows are filled to (the
// cross-section up to the bank zone's end, then rising floodGrade per metre).
fn riverCarveProfile_d(s: WaterRiverSeg, p: WaterRiverPt, unitDir: vec3<f32>, flat: bool) -> vec4<f32> {
    let R = waterParams.planetRadius;
    let ab = s.p1 - s.p0;
    // d(t)/d unitDir inside the segment; d(d)/d unitDir = R^2 v / d (v is
    // perpendicular to the segment there, and t is fixed past its ends).
    let tg = select(vec3<f32>(0.0), ab / max(dot(ab, ab), 1.0e-20), p.tRaw > 0.0 && p.tRaw < 1.0);
    let dGrad = p.v * (R * R / max(p.d, 1.0e-3));
    let dD = vec4<f32>(p.d, dGrad);
    let eta = vec4<f32>(p.eta, (s.eta1 - s.eta0) * tg);
    let bed = vec4<f32>(p.bed, (s.bed1 - s.bed0) * tg);
    let D = (eta - bed) * (1.0 / max(waterParams.carve.w, 0.05));
    let edge = p.hw + waterParams.carve.y;
    if (p.d < p.hw) {
        let u = vec4<f32>(p.n, select(-dGrad, dGrad, p.n >= 0.0)) * (1.0 / p.hw);
        let de = (u - dConst(p.skew)) * select(1.0 / (1.0 - p.skew), 1.0 / (1.0 + p.skew), u.x < p.skew);
        let q = dConst(1.0) - dMul(de, de);
        return bed + dMul(D, dConst(1.0) - dPow(vec4<f32>(max(q.x, 0.0), q.yzw), 1.5));
    }
    let soft = max(waterParams.bank.y, 0.1);
    let beyond = flat && p.d > edge;
    let xs = select(dD - dConst(p.hw), dConst(edge - p.hw), beyond);
    let ex = exp(-xs.x / soft);
    let E = vec4<f32>(ex, xs.yzw * (-ex / soft));
    let bank = (dConst(1.0) - E) * waterParams.bank.x + xs * waterParams.bank.z;
    var P = bed + D + dMul(bank, dSmoothstep(0.0, soft, xs));
    if (beyond) { P += (dD - dConst(edge)) * waterParams.flood.y; }
    return P;
}

// The terrain (m, dual) as segment s alone shapes it: cut toward its
// cross-section, fill toward its floodplain; both 1 in the bank zone
// (there the result is the cross-section: smin + smax = a + b), the cut
// fading over the blend, the fill over the blend (levee) or out to its
// hollows' reach and over poolFadeM; no fill in lakes (pool < 0). It is the
// natural terrain h0 at the segment's reach.
fn riverCarveSegment_d(s: WaterRiverSeg, p: WaterRiverPt, unitDir: vec3<f32>, h0: vec4<f32>) -> vec4<f32> {
    let R = waterParams.planetRadius;
    let dD = vec4<f32>(p.d, p.v * (R * R / max(p.d, 1.0e-3)));
    let edge = p.hw + waterParams.carve.y;
    let wz = dConst(1.0) - dSmoothstep(edge, edge + max(waterParams.carve.z, 1.0), dD);
    let wp = select(dConst(0.0), dConst(1.0) - dSmoothstep(p.pool, p.pool + max(waterParams.flood.x, 1.0), dD), p.pool > 0.0);
    let wf = select(select(wp, wz, wz.x >= wp.x), dConst(0.0), p.pool < 0.0);
    let kk = ${RIVER_CARVE_SMOOTH_M.toFixed(2)};
    let cut = dSmoothMin(h0, riverCarveProfile_d(s, p, unitDir, false), kk) - h0;
    var fill = dConst(0.0);
    if (wf.x > 0.0) { fill = dSmoothMax(h0, riverCarveProfile_d(s, p, unitDir, true), kk) - h0; }
    return h0 + dMul(wz, cut) + dMul(wf, fill);
}

// hd: normalized terrain height dual; returns the shaped one: the segments'
// shapes (riverCarveSegment_d) blended by distance, the nearest dominating
// (weight e^(-(d - dmin) / ${RIVER_CARVE_BLEND_M} m), fading out at each segment's reach), so
// one river part decides where it is nearest and the result stays smooth
// where parts meet (a minimum or maximum over segments let a downstream
// segment's lower floodplain undercut the river beside it: lab 2026-10-05).
// The gradient leaves out the weights' own change (small but for the
// narrow zones where two parts of rivers blend).
fn riverCarve_d(hd: vec4<f32>, unitDir: vec3<f32>) -> vec4<f32> {
    let e = riverCarveCellEntry(unitDir);
    let count = min(e & 0xffu, ${RIVER_MAX_SEGS_PER_CELL}u);
    if (count == 0u) { return hd; }
    let first = e >> 8u;
    var dmin = 1.0e30;
    for (var k = 0u; k < count; k++) {
        let p = waterRiverPoint(waterRivers[first + k], unitDir);
        if (p.d < riverCarveReach(p)) { dmin = min(dmin, p.d); }
    }
    if (dmin > 1.0e29) { return hd; }
    let maxH = maxTerrainHeightM();
    let h0 = hd * maxH;
    var acc = vec4<f32>(0.0);
    var wsum = 0.0;
    for (var k = 0u; k < count; k++) {
        let s = waterRivers[first + k];
        let p = waterRiverPoint(s, unitDir);
        let reach = riverCarveReach(p);
        if (p.d >= reach) { continue; }
        let a = exp(-(p.d - dmin) / ${RIVER_CARVE_BLEND_M.toFixed(1)}) * (1.0 - smoothstep(reach - ${RIVER_CARVE_ENTRY_M.toFixed(1)}, reach, p.d));
        if (a < 1.0e-3) { continue; }
        acc += riverCarveSegment_d(s, p, unitDir, h0) * a;
        wsum += a;
    }
    if (wsum <= 0.0) { return hd; }
    return acc * (1.0 / (wsum * maxH));
}

// Share of the per-tile micro detail kept at unitDir: 0 in the channel and
// on the banks, back to 1 by the end of the bank zone (bankW).
fn riverCarveMicroKeep(unitDir: vec3<f32>) -> f32 {
    let e = riverCarveCellEntry(unitDir);
    let count = min(e & 0xffu, ${RIVER_MAX_SEGS_PER_CELL}u);
    if (count == 0u) { return 1.0; }
    let first = e >> 8u;
    let bankW = waterParams.carve.y;
    var keep = 1.0;
    for (var k = 0u; k < count; k++) {
        let p = waterRiverPoint(waterRivers[first + k], unitDir);
        keep = min(keep, smoothstep(p.hw + 0.5 * bankW, p.hw + bankW, p.d));
    }
    return keep;
}
`;
}
