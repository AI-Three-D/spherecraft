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
// Legacy traces can supply a cached broad incision. Structured rivers also
// shape bounded, independent banks here, in the first tile-generation chain.
// Both paths only cut: lower natural ground is preserved.
// The closest traced segment is shared with waterRiverAt; width, depth and
// centre variation interpolate along the river.
// Dual numbers vec4(height, d/d unitDir) as in the height function,
// including the centre's wobble and the width's change along the river;
// skew and bank height are taken as constant along it (they vary slowly).

import { createWaterCommonWgsl, RIVER_MAX_SEGS_PER_CELL } from './waterWgsl.js';
import { RIVER_BANK_DETAIL } from './riverShapeNoise.js';

// Group 1 of the terrain generator's pipelines (binding 0 is its biome uniform).
export const RIVER_CARVE_GROUP = 1;
export const RIVER_CARVE_BINDINGS = Object.freeze({ index: 1, params: 2, rivers: 3 });
// Smoothing of the final excavation edge (m).
export const RIVER_CARVE_SMOOTH_M = 0.5;

/**
 * @param {object} [o]
 * @param {boolean} [o.enabled=true]  false: pass-through stubs (no bindings)
 * @param {boolean} [o.bankDetail=false] compile the optional organic-bank path
 * @returns {string} WGSL: riverCarve_d(hd, unitDir), riverCarveMicroKeep(unitDir)
 */
export function createRiverCarveWgsl({ enabled = true, bankDetail = false } = {}) {
    if (!enabled) {
        return /* wgsl */`
// River carve off in this shader (riverCarve.wgsl.js).
fn riverCarve_d(hd: vec4<f32>, unitDir: vec3<f32>) -> vec4<f32> { return hd; }
fn riverCarveMicroKeep(unitDir: vec3<f32>) -> f32 { return 1.0; }
fn riverCarveShoreWeights(dir: vec3<f32>, heightM: f32, slope: f32) -> vec3<f32> { return vec3<f32>(0.0); }
fn riverCarveShoreEnabled() -> bool { return false; }
fn riverCarveShoreNoise(dir: vec3<f32>) -> f32 { return 0.0; }
`;
    }
    return /* wgsl */`
// ==================== River corridors (core/world/water/riverCarve.wgsl.js) ====
${createWaterCommonWgsl(RIVER_CARVE_GROUP, RIVER_CARVE_BINDINGS, { bankDetail })}

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
    var relief = dConst(0.0);
${bankDetail ? `    if (waterParams.bank.w > 0.0 && p.d > p.hw * 0.5) {
        let noise = waterBankNoise(p.s, p.n, p.river);
        let noiseD = vec4<f32>(noise.x, noise.y * sGrad + noise.z * nD.yzw);
        let mask = dQuintic(dClamp(dDiv(dD - hwD * 0.5, hwD * 0.35), 0.0, 1.0));
        relief = dMul(mask, noiseD) * (${RIVER_BANK_DETAIL.reliefM.toFixed(2)} * waterParams.bank.w);
    }` : ''}
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
        return channel + relief;
    }
    let soft = max(waterParams.bank.y, 0.1);
    let x = dD - hwD;
${bankDetail ? `    if (waterParams.bank.w > 0.0) {
        // A low toe ends in either a broad shelf or a steep exposed bank.
        // This is a cut ceiling: where natural ground is lower it survives.
        // Continuous independent bank fields also move the wet edge; there
        // is no bank-only mask or second terrain generation to synchronize.
        let morph = vec4<f32>(p.bankMorph, p.dBankMorph * sGrad);
        let extent = riverCarveBankExtent_d(morph);
        let shelf = dConst(0.25) + extent * 0.65;
        let soft = dConst(0.5) + (dConst(1.0) - morph) * 1.8;
        let rise = dConst(1.5) + morph * 2.5 + D * 0.5;
        let step = dQuintic(dClamp(dDiv(x - shelf, soft), 0.0, 1.0));
        let roughToe = dMul(x, dConst(0.05) + morph * 0.12);
        return bed + D + roughToe + dMul(rise, step) + relief;
    }` : ''}
    let on = dSmoothstep(0.0, soft, x);
    let ex = exp(-x.x / soft);
    let E = vec4<f32>(ex, x.yzw * (-ex / soft));
    let bank = (dConst(1.0) - E) * p.bankH + x * waterParams.bank.z;
    let hillside = dMul(x, x) * (0.5 / max(waterParams.carve.z, soft));
    return bed + D + dMul(bank, on) + hillside;
}

${bankDetail ? `// Dual counterpart of waterBankExtent; the scalar uses the same physical limit.
fn riverCarveBankExtent_d(morph: vec4<f32>) -> vec4<f32> {
    return dConst(1.0) + dPow(dConst(1.0) - morph, 3.0) * (clamp(waterParams.carve.z, 1.0, ${RIVER_BANK_DETAIL.maxExtentM.toFixed(1)}) - 1.0);
}
` : ''}
// Final cut, including the optional dry-bank excavation cap.
fn riverCarveSegment_d(s: WaterRiverSeg, p: WaterRiverPt, unitDir: vec3<f32>, h0: vec4<f32>) -> vec4<f32> {
    // The first point overlaps the lake; the lake supplies water behind it.
    // Excavating a rounded cap backwards into its shoreline made a false inlet.
    if (s.s0 <= 0.0 && p.tRaw < 0.0) { return h0; }
    let R = waterParams.planetRadius;
    let ab = s.p1 - s.p0;
    let tg = select(vec3<f32>(0.0), ab / max(dot(ab, ab), 1.0e-20), p.tRaw > 0.0 && p.tRaw < 1.0);
    let sGrad = (s.s1 - s.s0) * tg;
    let dD = vec4<f32>(p.n, p.v * (R * R / max(p.dLine, 1.0e-3)) * p.nSign - p.dOff * sGrad) * select(-1.0, 1.0, p.n >= 0.0);
    // Full correction inside the wet core, fading into surviving natural banks.
    let edge = vec4<f32>(p.hw * 0.85, p.dHw * sGrad * 0.85);
    var bankExtent = dConst(waterParams.carve.y);
${bankDetail ? `    if (waterParams.bank.w > 0.0) {
        let morph = vec4<f32>(p.bankMorph, p.dBankMorph * sGrad);
        bankExtent = riverCarveBankExtent_d(morph);
    }` : ''}
    let wz = dConst(1.0) - dQuintic(dClamp(dDiv(dD - edge, vec4<f32>(p.hw * 0.15, p.dHw * sGrad * 0.15)+bankExtent), 0.0, 1.0));
    let kk = ${RIVER_CARVE_SMOOTH_M.toFixed(2)};
    var cut = dSmoothMin(h0, riverCarveProfile_d(s, p, unitDir), kk) - h0;
${bankDetail ? `    if (waterParams.bank.w > 0.0) {
        // Do not bulldoze an uphill valley wall to make a broad shelf.
        // This cap begins beyond the certified wet core. Existing lower
        // terrain still survives; maximum dry-bank excavation is configured.
        let widthD = vec4<f32>(p.hw, p.dHw * sGrad);
        let dry = dQuintic(dClamp(dDiv(dD - widthD * 0.95, widthD * 0.45), 0.0, 1.0));
        let cap = dConst(24.0) + dry * (waterParams.simFade.z - 24.0);
        cut = dSmoothMax(cut, -cap, 0.05);
    }` : ''}
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
    let reach = max(s.hw0, s.hw1) * (1.0 + waterParams.shape.x + waterParams.shape.y + ${RIVER_BANK_DETAIL.shoreFraction.toFixed(2)} * waterParams.bank.w) + waterParams.carve.y + waterParams.carve.z + 1.0;
    if (bestD * waterParams.planetRadius >= reach) { return hd; }
    let p = waterRiverPoint(s, unitDir);
    if (p.d >= riverCarveReach(p)) { return hd; }
    let maxH = maxTerrainHeightM();
    return riverCarveSegment_d(s, p, unitDir, hd * maxH) / maxH;
}

// Share of the per-tile micro detail kept at unitDir: 0 in the channel and
// at the bank toe, back to 1 by the end of the local bank extent. The
// bounded spatial relief above supplies detail where tile micro is masked.
fn riverCarveMicroKeep(unitDir: vec3<f32>) -> f32 {
    let e = riverCarveCellEntry(unitDir);
    let count = min(e & 0xffu, ${RIVER_MAX_SEGS_PER_CELL}u);
    if (count == 0u) { return 1.0; }
    let first = e >> 8u;
    let bankW = waterParams.carve.y;
    var keep = 1.0;
    for (var k = 0u; k < count; k++) {
        let p = waterRiverPoint(waterRivers[first + k], unitDir);
        let extent = ${bankDetail ? 'select(bankW, waterBankExtent(p), waterParams.bank.w > 0.0)' : 'bankW'};
        keep = min(keep, smoothstep(p.hw + 0.5 * extent, p.hw + extent, p.d));
    }
    return keep;
}

${bankDetail ? `fn riverCarveShoreEnabled() -> bool { return waterParams.bank.w > 0.0 && waterParams.enabled != 0u; }
fn riverCarveShoreNoise(dir: vec3<f32>) -> f32 {
    let R = waterParams.planetRadius;
    return waterBankNoise((dir.x + dir.z * 0.31) * R * 0.08, (dir.y + dir.z * 0.73) * R * 0.08, 927.0).x;
}
// Sediment / exposed rock / wet toe. This only controls existing splat
// materials; it neither paints a solid colour nor changes water ownership.
fn riverCarveShoreWeights(dir: vec3<f32>, heightM: f32, slope: f32) -> vec3<f32> {
    if (!riverCarveShoreEnabled()) { return vec3<f32>(0.0); }
    let e = riverCarveCellEntry(dir);
    let count = min(e & 0xffu, ${RIVER_MAX_SEGS_PER_CELL}u);
    if (count == 0u) { return vec3<f32>(0.0); }
    let first = e >> 8u;
    var best = first;
    var distance = 1.0e30;
    for (var k = 0u; k < count; k++) {
        let sg = waterRivers[first + k];
        let ab = sg.p1 - sg.p0;
        let t = clamp(dot(dir - sg.p0, ab) / max(dot(ab, ab), 1.0e-20), 0.0, 1.0);
        let d = length(dir - (sg.p0 + ab * t));
        if (d < distance) { distance = d; best = first + k; }
    }
    let p = waterRiverPoint(waterRivers[best], dir);
    if (p.pool < 0.0 || p.d > riverCarveReach(p)) { return vec3<f32>(0.0); }
    let shoreNoise = waterBankNoise(p.s * 0.04, p.n * 0.075, p.river + 17.0).x;
    let extent = waterBankExtent(p) * (0.8 + 0.6 * shoreNoise);
    let across = 1.0 - smoothstep(p.hw + extent * 0.3, p.hw + max(extent, 0.5), p.d);
    let above = heightM - p.wl;
    let vertical = 1.0 - smoothstep(0.15, 1.0 + 1.5 * (1.0 - p.bankMorph), above);
    let gravel = across * vertical * (1.0 - smoothstep(0.2, 0.65, slope)) * (0.1 + 0.9 * smoothstep(-0.1, 0.6, shoreNoise));
    // Reuse the sediment field to break up exposed faces too. A uniform
    // rock override across every steep bank makes a second artificial strip.
    let rock = across * vertical * smoothstep(0.25, 0.7, slope) * (0.4 + 0.5 * smoothstep(-0.4, 0.5, shoreNoise));
    let wet = across * (1.0 - smoothstep(0.1, 0.8, above)) * 0.15;
    return vec3<f32>(gravel, rock, wet);
}` : `fn riverCarveShoreEnabled() -> bool { return false; }
fn riverCarveShoreNoise(dir: vec3<f32>) -> f32 { return 0.0; }
fn riverCarveShoreWeights(dir: vec3<f32>, heightM: f32, slope: f32) -> vec3<f32> { return vec3<f32>(0.0); }`}
`;
}
