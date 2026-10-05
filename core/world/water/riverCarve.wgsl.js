// core/world/water/riverCarve.wgsl.js
//
// River channels carved into the terrain height function, from the traced
// rivers' segments (WaterGpuData.js, waterWorkerCore.js solveRiver). It is
// the last step of calculateTerrainHeightD (earthLikeBase.wgsl.js), so every
// consumer of the height gets the same channel: tiles at every LOD (tile
// edges stay stitched), normals, the water simulation's bed. The hydrology
// sampler compiles the terrain without it (it traces the rivers on the
// uncarved terrain).
//
// Along a segment the water level eta and the bed interpolate; both only
// fall downstream. Across it, at distance d from the line (half-width hw,
// depth = eta - bed):
// - profile P(d) = bed + depth (d / hw)^2 in the channel (d <= hw), and
//   eta + a x + c x^2 on the banks (x = d - hw; a = 2 depth / hw keeps the
//   slope continuous at the waterline; c = bank curvature): the banks rise
//   until they meet the terrain; over the outer half of the bank width P
//   also rises by a wall (200 m), so it ends above any terrain at the
//   segment's reach;
// - several segments nearby: the lowest profile (continuous; cut and fill
//   against one profile, so neighbouring segments never undo each other);
// - cut: terrain above the profile comes down to it (smooth min);
// - fill: in the channel, hollows below the profile up to fill x depth deep
//   are raised to it; deeper ones stay as ponds (the river's water fills them).
// Dual numbers vec4(height, d/d unitDir) as in the height function; the
// gradient of the half-width along the river is left out (it varies slowly).

import { createWaterCommonWgsl, RIVER_MAX_SEGS_PER_CELL } from './waterWgsl.js';

// Group 1 of the terrain generator's pipelines (binding 0 is its biome uniform).
export const RIVER_CARVE_GROUP = 1;
export const RIVER_CARVE_BINDINGS = Object.freeze({ index: 1, params: 2, rivers: 3 });
// Rise of the profile over the outer half of the banks (m), and the smoothing
// of the cut's and fill's edges (m).
export const RIVER_CARVE_WALL_M = 200;
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
// ==================== River carve (core/world/water/riverCarve.wgsl.js) ====
${createWaterCommonWgsl(RIVER_CARVE_GROUP, RIVER_CARVE_BINDINGS)}

// River segments that can reach unitDir: first << 8 | count (count 0: none).
fn riverCarveCellEntry(unitDir: vec3<f32>) -> u32 {
    if (waterParams.gridN == 0u || waterParams.carve.x < 0.5 || !terrainFeatureOn(TF_WATER_CARVE)) { return 0u; }
    return waterRiverList(unitDir);
}

// Profile of segment s at unitDir as a dual (see the header); t, tRaw: the
// position along it, v: unitDir minus its nearest point, d: distance (m).
fn riverCarveProfile_d(s: WaterRiverSeg, unitDir: vec3<f32>, tRaw: f32, t: f32, v: vec3<f32>, d: f32, hw: f32) -> vec4<f32> {
    let R = waterParams.planetRadius;
    let bank = waterParams.carve.y;
    let ab = s.p1 - s.p0;
    // d(t)/d unitDir inside the segment; d(d^2)/d unitDir = 2 R^2 v
    // (v is perpendicular to the segment there, and t is fixed past its ends).
    let tg = select(vec3<f32>(0.0), ab / max(dot(ab, ab), 1.0e-20), tRaw > 0.0 && tRaw < 1.0);
    let d2D = vec4<f32>(d * d, v * (2.0 * R * R));
    let dD = vec4<f32>(d, d2D.yzw * (0.5 / max(d, 1.0e-3)));
    let eta = vec4<f32>(mix(s.eta0, s.eta1, t), (s.eta1 - s.eta0) * tg);
    let bed = vec4<f32>(mix(s.bed0, s.bed1, t), (s.bed1 - s.bed0) * tg);
    let depth = eta - bed;
    var P: vec4<f32>;
    if (d <= hw) {
        P = bed + dMul(depth, d2D) * (1.0 / (hw * hw));
    } else {
        let x = dD - dConst(hw);
        P = eta + dMul(depth, x) * (2.0 / hw) + dMul(x, x) * waterParams.carve.z;
    }
    return P + dSmoothstep(hw + 0.5 * bank, hw + bank, dD) * ${RIVER_CARVE_WALL_M.toFixed(1)};
}

// hd: normalized terrain height dual; returns the carved one. Each segment's
// profile and channel weight are found as plain values first; the dual
// (gradient) is only built for the segment that wins.
fn riverCarve_d(hd: vec4<f32>, unitDir: vec3<f32>) -> vec4<f32> {
    let e = riverCarveCellEntry(unitDir);
    let count = min(e & 0xffu, ${RIVER_MAX_SEGS_PER_CELL}u);
    if (count == 0u) { return hd; }
    let first = e >> 8u;
    let maxH = maxTerrainHeightM();
    let h0 = hd * maxH;
    let R = waterParams.planetRadius;
    let bank = waterParams.carve.y;
    let curv = waterParams.carve.z;
    let fillF = waterParams.carve.w;
    var prof = vec4<f32>(1.0e30, 0.0, 0.0, 0.0);   // lowest profile
    var inChannel = dConst(0.0);                    // channel weight (largest)
    var fillMax = 0.0;
    for (var k = 0u; k < count; k++) {
        let s = waterRivers[first + k];
        let ab = s.p1 - s.p0;
        let tRaw = dot(unitDir - s.p0, ab) / max(dot(ab, ab), 1.0e-20);
        let t = clamp(tRaw, 0.0, 1.0);
        let hw = max(mix(s.hw0, s.hw1, t), 0.5);
        let reach = hw + bank;
        let v = unitDir - (s.p0 + ab * t);
        let d2 = dot(v, v) * R * R;
        if (d2 >= reach * reach) { continue; }
        let d = sqrt(d2);
        let eta = mix(s.eta0, s.eta1, t);
        let depth = eta - mix(s.bed0, s.bed1, t);
        let x = d - hw;
        var p = eta - depth + depth * d2 / (hw * hw);
        if (d > hw) { p = eta + depth * x * (2.0 / hw) + x * x * curv; }
        p += smoothstep(hw + 0.5 * bank, reach, d) * ${RIVER_CARVE_WALL_M.toFixed(1)};
        if (p < prof.x) { prof = riverCarveProfile_d(s, unitDir, tRaw, t, v, d, hw); }
        let w = 1.0 - smoothstep(hw, hw + 0.25 * bank, d);
        if (w > inChannel.x) {
            let dD = vec4<f32>(d, v * (R * R / max(d, 1.0e-3)));
            inChannel = dConst(1.0) - dSmoothstep(hw, hw + 0.25 * bank, dD);
        }
        fillMax = max(fillMax, fillF * max(depth, 0.1) * w);
    }
    if (prof.x > 1.0e29) { return hd; }
    let kk = ${RIVER_CARVE_SMOOTH_M.toFixed(2)};
    let cut = dSmoothMin(h0, prof, kk);
    let gap = prof - h0;
    let shallow = dConst(1.0) - dSmoothstep(0.5 * fillMax, max(fillMax, 1.0e-3), gap);
    let lift = dMul(dMul(inChannel, shallow), dSmoothMax(dConst(0.0), gap, kk));
    return (cut + lift) * (1.0 / maxH);
}

// Share of the per-tile micro detail kept at unitDir: 0 in the channel,
// back to 1 over the inner half of the bank (the bed stays the carved one).
fn riverCarveMicroKeep(unitDir: vec3<f32>) -> f32 {
    let e = riverCarveCellEntry(unitDir);
    let count = min(e & 0xffu, ${RIVER_MAX_SEGS_PER_CELL}u);
    if (count == 0u) { return 1.0; }
    let first = e >> 8u;
    let R = waterParams.planetRadius;
    let bank = waterParams.carve.y;
    var keep = 1.0;
    for (var k = 0u; k < count; k++) {
        let s = waterRivers[first + k];
        let ab = s.p1 - s.p0;
        let t = clamp(dot(unitDir - s.p0, ab) / max(dot(ab, ab), 1.0e-20), 0.0, 1.0);
        let hw = max(mix(s.hw0, s.hw1, t), 0.5);
        let d = length(unitDir - (s.p0 + ab * t)) * R;
        keep = min(keep, smoothstep(hw, hw + 0.5 * bank, d));
    }
    return keep;
}
`;
}
