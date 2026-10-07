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
// The cached incision prepares the broad banks. This final cut clears the
// channel at its solved water level without rebuilding or raising the banks.
// The closest traced segment is shared with waterRiverAt; width, depth and
// centre variation interpolate along the river.
// Dual numbers vec4(height, d/d unitDir) as in the height function,
// including the centre's wobble and the width's change along the river;
// skew and bank height are taken as constant along it (they vary slowly).

import { createWaterCommonWgsl, RIVER_MAX_SEGS_PER_CELL } from './waterWgsl.js';

// Group 1 of the terrain generator's pipelines (binding 0 is its biome uniform).
export const RIVER_CARVE_GROUP = 1;
export const RIVER_CARVE_BINDINGS = Object.freeze({ index: 1, params: 2, rivers: 3 });
// Smoothing of the final excavation edge (m).
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

// How far the segment acts: channel, banks, blend into the terrain.
fn riverCarveReach(p: WaterRiverPt) -> f32 {
    return p.hw + waterParams.carve.y + waterParams.carve.z + 1.0;
}

// The nearest segment's channel and low bank toe, as a height dual.
fn riverCarveProfile_d(s: WaterRiverSeg, p: WaterRiverPt, unitDir: vec3<f32>) -> vec4<f32> {
    let R = waterParams.planetRadius;
    let ab = s.p1 - s.p0;
    // d(t)/d unitDir inside the segment (t is fixed past its ends); arc
    // length s = mix(s0, s1, t). Offset from the channel's centre:
    // n = side x (distance from the line) - wobble(s).
    let tg = select(vec3<f32>(0.0), ab / max(dot(ab, ab), 1.0e-20), p.tRaw > 0.0 && p.tRaw < 1.0);
    let sGrad = (s.s1 - s.s0) * tg;
    let lineGrad = p.v * (R * R / max(p.dLine, 1.0e-3));
    let nD = vec4<f32>(p.n, p.nSign * lineGrad - p.dOff * sGrad);
    let dD = nD * select(-1.0, 1.0, p.n >= 0.0);
    let hwD = vec4<f32>(p.hw, p.dHw * sGrad);
    let eta = vec4<f32>(p.eta, (s.eta1 - s.eta0) * tg);
    let bed = vec4<f32>(p.bed, (s.bed1 - s.bed0) * tg);
    let D = (eta - bed) * (1.0 / max(waterParams.carve.w, 0.05));
    if (p.d < p.hw) {
        let u = dDiv(nD, hwD);
        let de = (u - dConst(p.skew)) * select(1.0 / (1.0 - p.skew), 1.0 / (1.0 + p.skew), u.x < p.skew);
        let q = dConst(1.0) - dMul(de, de);
        let channel = bed + dMul(D, dConst(1.0) - dPow(vec4<f32>(max(q.x, 0.0), q.yzw), 1.5));
        // A tapered mid-channel bar leaves two connected arms around it.
        // One profile and one ribbon suffice; terrain depth clips the island.
        if (p.island > 0.0) {
            let iq = dConst(1.0) - dMul(u, u) * (1.0 / (0.34 * 0.34));
            if (iq.x > 0.0) {
                let mask = vec4<f32>(p.island, p.dIsland * sGrad);
                let bar = bed + dMul(dMul(mask, dMul(iq, iq)), eta - bed + dConst(waterParams.shape.w));
                return dSmoothMax(channel, bar, 0.15);
            }
        }
        return channel;
    }
    let soft = max(waterParams.bank.y, 0.1);
    let x = dD - hwD;
    let on = dSmoothstep(0.0, soft, x);
    let ex = exp(-x.x / soft);
    let E = vec4<f32>(ex, x.yzw * (-ex / soft));
    let bank = (dConst(1.0) - E) * p.bankH + x * waterParams.bank.z;
    let hillside = dMul(x, x) * (0.5 / max(waterParams.carve.z, soft));
    return bed + D + dMul(bank, on) + hillside;
}

// Final cut only. Broad bank retreat is already baked into the terrain field.
fn riverCarveSegment_d(s: WaterRiverSeg, p: WaterRiverPt, unitDir: vec3<f32>, h0: vec4<f32>) -> vec4<f32> {
    // The first point overlaps the lake; the lake supplies water behind it.
    // Excavating a rounded cap backwards into its shoreline made a false inlet.
    if (s.s0 <= 0.0 && p.tRaw < 0.0) { return h0; }
    let R = waterParams.planetRadius;
    let ab = s.p1 - s.p0;
    let tg = select(vec3<f32>(0.0), ab / max(dot(ab, ab), 1.0e-20), p.tRaw > 0.0 && p.tRaw < 1.0);
    let sGrad = (s.s1 - s.s0) * tg;
    let dD = vec4<f32>(p.n, p.v * (R * R / max(p.dLine, 1.0e-3)) * p.nSign - p.dOff * sGrad) * select(-1.0, 1.0, p.n >= 0.0);
    // The broad bank retreat was baked from the sampled terrain. Only clear the wet
    // channel here, fading to the surviving bank rather than rebuilding it.
    let edge = vec4<f32>(p.hw * 0.85, p.dHw * sGrad * 0.85);
    let wz = dConst(1.0) - dQuintic(dClamp(dDiv(dD - edge, vec4<f32>(p.hw * 0.15 + waterParams.carve.y, p.dHw * sGrad * 0.15)), 0.0, 1.0));
    let kk = ${RIVER_CARVE_SMOOTH_M.toFixed(2)};
    let cut = dSmoothMin(h0, riverCarveProfile_d(s, p, unitDir), kk) - h0;
    // No fill: low ground, lake water and open floodplains keep their height.
    return h0 + dMul(wz, cut);
}

// Use the same closest traced segment as waterRiverAt. Blending endpoint
// caps by radial distance made the terrain depend on sampling density:
// extra short waterfall segments pulled upstream banks below their water.
// Width, depth and noise still interpolate continuously along each reach.
fn riverCarve_d(hd: vec4<f32>, unitDir: vec3<f32>) -> vec4<f32> {
    let e = riverCarveCellEntry(unitDir);
    let count = min(e & 0xffu, ${RIVER_MAX_SEGS_PER_CELL}u);
    if (count == 0u) { return hd; }
    let first = e >> 8u;
    var bestK = first;
    var bestD = 1.0e30;
    for (var k = 0u; k < count; k++) {
        let sg = waterRivers[first + k];
        let ab = sg.p1 - sg.p0;
        let t = clamp(dot(unitDir - sg.p0, ab) / max(dot(ab, ab), 1.0e-20), 0.0, 1.0);
        let dd = length(unitDir - (sg.p0 + ab * t));
        if (dd < bestD) { bestD = dd; bestK = first + k; }
    }
    let s = waterRivers[bestK];
    let reach = max(s.hw0, s.hw1) * (1.0 + waterParams.shape.x + waterParams.shape.y) + waterParams.carve.y + waterParams.carve.z + 1.0;
    if (bestD * waterParams.planetRadius >= reach) { return hd; }
    let p = waterRiverPoint(s, unitDir);
    if (p.d >= riverCarveReach(p)) { return hd; }
    let maxH = maxTerrainHeightM();
    return riverCarveSegment_d(s, p, unitDir, hd * maxH) / maxH;
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
