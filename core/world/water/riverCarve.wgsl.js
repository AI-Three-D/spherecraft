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
// The ground is the river cross-section (riverSection.js riverSection_d):
// the channel, then each side's bank (cut bank, ledge or none, chosen by the
// bends and long-wavelength noise) out to where it meets the natural ground.
// It only cuts: lower natural ground is preserved. Next to a lake a bank
// keeps its rim (riverSection.js riverBankRim).
// The closest traced segment is shared with waterRiverAt; width, depth and
// the centre's wobble interpolate along the river.
// Dual numbers vec4(height, d/d unitDir) as in the height function,
// including the centre's wobble and the width's change along the river;
// skew and the bank types are taken as constant along it (they vary slowly).

import { createWaterCommonWgsl, RIVER_MAX_SEGS_PER_CELL } from './waterWgsl.js';
import { RIVER_SECTION, createRiverSectionWgsl } from './riverSection.js';

// Group 1 of the terrain generator's pipelines (binding 0 is its biome uniform).
export const RIVER_CARVE_GROUP = 1;
export const RIVER_CARVE_BINDINGS = Object.freeze({ index: 1, params: 2, rivers: 3 });
// Terrain micro detail returns over this far (m) beyond a river's half-width.
const MICRO_RETURN_M = 8;
// The cut fades out over this far (m) behind a river's first point.
const START_FADE_M = 30;

/**
 * @param {object} [o]
 * @param {boolean} [o.enabled=true]  false: pass-through stubs (no bindings)
 * @param {boolean} [o.bankDetail=false] compile the shore materials
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
${createWaterCommonWgsl(RIVER_CARVE_GROUP, RIVER_CARVE_BINDINGS)}
${createRiverSectionWgsl({ scalar: false, dual: true })}

// River segments that can reach unitDir: first << 8 | count (count 0: none).
fn riverCarveCellEntry(unitDir: vec3<f32>) -> u32 {
    if (waterParams.gridN == 0u || waterParams.carve.x < 0.5 || !terrainFeatureOn(TF_WATER_CARVE)) { return 0u; }
    return waterRiverList(unitDir);
}

// How far the segment acts: channel, banks, blend into the terrain.
fn riverCarveReach(p: WaterRiverPt) -> f32 {
    return p.hw + ${RIVER_SECTION.reachM.toFixed(1)};
}

// The nearest segment's cross-section at unitDir over the natural ground h0, as a height dual.
fn riverCarveSegment_d(s: WaterRiverSeg, p: WaterRiverPt, unitDir: vec3<f32>, h0: vec4<f32>) -> vec4<f32> {
    let R = waterParams.planetRadius;
    let ab = s.p1 - s.p0;
    // d(t)/d unitDir inside the segment (t is fixed past its ends); arc
    // length s = mix(s0, s1, t). Offset from the channel's centre:
    // n = side x (distance from the line) - wobble(s).
    let tg = select(vec3<f32>(0.0), ab / max(dot(ab, ab), 1.0e-20), p.tRaw > 0.0 && p.tRaw < 1.0);
    let sGrad = (s.s1 - s.s0) * tg;
    let lineGrad = p.v * (R * R / max(p.dLine, 1.0e-3));
    let nD = vec4<f32>(p.n, p.nSign * lineGrad - p.dOff * sGrad);
    let hwD = vec4<f32>(p.hw, p.dHw * sGrad);
    let eta = vec4<f32>(p.eta, (s.eta1 - s.eta0) * tg);
    let bed = vec4<f32>(p.bed, (s.bed1 - s.bed0) * tg);
    let D = (eta - bed) * (1.0 / max(waterParams.carve.w, 0.05));
    // Each bank keeps the rim of drawn water next to it (riverBankRim): cut
    // below a lake's level, banks left the lake hanging over lower ground (v85).
    let left = waterRiverBank(p, true);
    let right = waterRiverBank(p, false);
    let fullL = bed.x + riverSideDepth(D.x, left.freeboard);
    let fullR = bed.x + riverSideDepth(D.x, right.freeboard);
    let h = riverSection_d(nD, hwD, bed, D, p.skew, h0, riverBankRim(left, p.rimL, fullL), riverBankRim(right, p.rimR, fullR));
    // Behind the river's first point (in its source lake) the cut fades out
    // over ${START_FADE_M} m. Ending it on a line there stepped up to 2.4 m where
    // the line reached land (water-look v76); a full rounded cap made a false inlet.
    if (s.s0 > 0.0 || p.tRaw >= 0.0) { return h; }
    let L = length(ab) * R;
    let behind = vec4<f32>(-p.tRaw * L, ab * (-L / max(dot(ab, ab), 1.0e-20)));
    let w = dConst(1.0) - dSmoothstep(0.0, ${START_FADE_M.toFixed(1)}, behind);
    return h0 + dMul(h - h0, w);
}

// Each river's section from its closest traced segment (as waterRiverAt),
// the lowest of the rivers'. Every section only cuts, so the ground stays
// continuous where two rivers' banks meet; the closest river's section alone
// stepped along the line where the closest river changes (4 m where a
// tributary hangs above its trunk, water-look v70). Blending endpoint caps
// by radial distance made the terrain depend on sampling density: extra
// short waterfall segments pulled upstream banks below their water. A
// cell's list holds each river's segments together (WaterGpuData.js).
fn riverCarve_d(hd: vec4<f32>, unitDir: vec3<f32>) -> vec4<f32> {
    let e = riverCarveCellEntry(unitDir);
    let count = min(e & 0xffu, ${RIVER_MAX_SEGS_PER_CELL}u);
    if (count == 0u) { return hd; }
    let first = e >> 8u;
    let maxH = maxTerrainHeightM();
    let h0 = hd * maxH;
    var h = h0;
    var k = 0u;
    loop {
        if (k >= count) { break; }
        let river = waterRivers[first + k].river;
        var bestK = first + k;
        var bestD = 1.0e30;
        loop {
            if (k >= count) { break; }
            let sg = waterRivers[first + k];
            if (sg.river != river) { break; }
            let ab = sg.p1 - sg.p0;
            let t = clamp(dot(unitDir - sg.p0, ab) / max(dot(ab, ab), 1.0e-20), 0.0, 1.0);
            let dd = length(unitDir - (sg.p0 + ab * t));
            if (dd < bestD) { bestD = dd; bestK = first + k; }
            k++;
        }
        let s = waterRivers[bestK];
        let reach = max(s.hw0, s.hw1) * (1.0 + waterParams.shape.y) + ${RIVER_SECTION.reachM.toFixed(1)} + 1.0;
        if (bestD * waterParams.planetRadius >= reach) { continue; }
        let p = waterRiverPoint(s, unitDir);
        if (p.d >= riverCarveReach(p)) { continue; }
        let c = riverCarveSegment_d(s, p, unitDir, h0);
        if (c.x < h.x) { h = c; }
    }
    return h / maxH;
}

// Share of the per-tile micro detail kept at unitDir: 0 in the channel, back
// to 1 by MICRO_RETURN_M beyond it (the banks keep the terrain's detail).
fn riverCarveMicroKeep(unitDir: vec3<f32>) -> f32 {
    let e = riverCarveCellEntry(unitDir);
    let count = min(e & 0xffu, ${RIVER_MAX_SEGS_PER_CELL}u);
    if (count == 0u) { return 1.0; }
    let first = e >> 8u;
    var keep = 1.0;
    for (var k = 0u; k < count; k++) {
        let p = waterRiverPoint(waterRivers[first + k], unitDir);
        keep = min(keep, smoothstep(p.hw + ${(MICRO_RETURN_M * 0.5).toFixed(1)}, p.hw + ${MICRO_RETURN_M.toFixed(1)}, p.d));
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
// Bars (no bank) get wide sediment beaches, cut banks narrow rock faces.
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
    let tau = riverBankType(p.s, p.river, p.n >= 0.0, p.kappa);
    let extent = mix(14.0, 3.0, tau * 0.5) * (0.8 + 0.6 * shoreNoise);
    let across = 1.0 - smoothstep(p.hw + extent * 0.3, p.hw + max(extent, 0.5), p.d);
    let above = heightM - p.wl;
    let vertical = 1.0 - smoothstep(0.15, 1.0 + 0.75 * (2.0 - tau), above);
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
