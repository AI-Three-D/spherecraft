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

import { createWaterCommonWgsl, createWaterLookupWgsl, RIVER_MAX_SEGS_PER_CELL } from './waterWgsl.js';
import { RIVER_SECTION, createRiverSectionWgsl } from './riverSection.js';

// Group 1 of the terrain generator's pipelines (binding 0 is its biome uniform).
// lakes, masks and sampler: the lake lookup of the shore materials (bankDetail).
export const RIVER_CARVE_GROUP = 1;
export const RIVER_CARVE_BINDINGS = Object.freeze({ index: 1, params: 2, rivers: 3, lakes: 7, masks: 8, sampler: 9 });
// Terrain micro detail returns over this far (m) beyond a river's half-width.
const MICRO_RETURN_M = 8;
// The cut fades out over this far (m) behind a river's first point.
const START_FADE_M = 30;
// Rivers per point whose containment floor is kept (riverSection.js contain).
const MAX_FLOORS = 6;
const CONTAIN = RIVER_SECTION.contain;

/**
 * @param {object} [o]
 * @param {boolean} [o.enabled=true]  false: pass-through stubs (no bindings)
 * @param {boolean} [o.bankDetail=false] compile the shore materials
 * @returns {string} WGSL: riverCarveTerrain_d(natural, excavated, unitDir), riverCarveMicroKeep(unitDir)
 */
export function createRiverCarveWgsl({ enabled = true, bankDetail = false } = {}) {
    if (!enabled) {
        return /* wgsl */`
// River carve off in this shader (riverCarve.wgsl.js).
fn riverCarve_d(hd: vec4<f32>, unitDir: vec3<f32>) -> vec4<f32> { return hd; }
fn riverCarveTerrain_d(natural: vec4<f32>, excavated: vec4<f32>, unitDir: vec3<f32>) -> vec4<f32> { return excavated; }
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

// A segment's values at unitDir as height duals (d/d unitDir): offset n
// from the channel's centre, half-width, level, thalweg, bank-full depth D
// and the water's level.
struct RiverCarveDuals { n: vec4<f32>, hw: vec4<f32>, eta: vec4<f32>, bed: vec4<f32>, D: vec4<f32>, wl: vec4<f32>, };
fn riverCarveDuals(s: WaterRiverSeg, p: WaterRiverPt) -> RiverCarveDuals {
    let R = waterParams.planetRadius;
    let ab = s.p1 - s.p0;
    // d(t)/d unitDir inside the segment (t is fixed past its ends); arc
    // length s = mix(s0, s1, t). Offset from the channel's centre:
    // n = side x (distance from the line) - wobble(s).
    let tg = select(vec3<f32>(0.0), ab / max(dot(ab, ab), 1.0e-20), p.tRaw > 0.0 && p.tRaw < 1.0);
    let sGrad = (s.s1 - s.s0) * tg;
    let lineGrad = p.v * (R * R / max(p.dLine, 1.0e-3));
    var c: RiverCarveDuals;
    c.n = vec4<f32>(p.n, p.nSign * lineGrad - p.dOff * sGrad);
    c.hw = vec4<f32>(p.hw, p.dHw * sGrad);
    c.eta = vec4<f32>(p.eta, (s.eta1 - s.eta0) * tg);
    c.bed = vec4<f32>(p.bed, (s.bed1 - s.bed0) * tg);
    c.D = (c.eta - c.bed) * (1.0 / max(waterParams.carve.w, 0.05));
    c.wl = vec4<f32>(p.wl, (s.wl1 - s.wl0) * tg);
    return c;
}

// The containment floor of the segment at unitDir (riverSection.js
// riverContainFloor), and how much of its fill applies (0..1): none where
// the river is in a lake, none behind its first point; riverCarveTerrain_d
// adds none on ground below a nearby lake's level (lakeGuard: lake bed and
// shore band, the lake's water covers it). Gating on the river's level
// near the lake instead raised a lake's shallow edge at a mouth above its
// water (the river's level ramps down to the lake's there).
fn riverCarveFloor_d(c: RiverCarveDuals, p: WaterRiverPt) -> vec4<f32> {
    return riverContainFloor_d(c.n, c.hw, c.bed, c.D, p.skew, c.wl, waterRiverBank(p, true), waterRiverBank(p, false));
}
fn riverCarveFloorWeight(s: WaterRiverSeg, p: WaterRiverPt) -> f32 {
    if (s.s0 <= 0.0 && p.tRaw < 0.0) { return 0.0; }
    return clamp(1.0 + p.pool, 0.0, 1.0);
}

// The nearest segment's cross-section at unitDir over the natural ground h0, as a height dual.
fn riverCarveSegment_d(s: WaterRiverSeg, p: WaterRiverPt, unitDir: vec3<f32>, h0: vec4<f32>) -> vec4<f32> {
    let c = riverCarveDuals(s, p);
    let nD = c.n;
    let hwD = c.hw;
    let bed = c.bed;
    let D = c.D;
    let ab = s.p1 - s.p0;
    let R = waterParams.planetRadius;
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
fn riverCarveTerrain_d(natural: vec4<f32>, hd: vec4<f32>, unitDir: vec3<f32>) -> vec4<f32> {
    let e = riverCarveCellEntry(unitDir);
    let count = min(e & 0xffu, ${RIVER_MAX_SEGS_PER_CELL}u);
    if (count == 0u) { return hd; }
    let first = e >> 8u;
    let maxH = maxTerrainHeightM();
    let h0 = hd * maxH;
    var h = h0;
    let original = natural * maxH;
    var fine = original;
    var valleyWeight = dConst(1.0);
    let excavated = h0.x < original.x;
    // Each river's containment floor, its weight, and how far the point is
    // beyond its channel's edge (a floor never fills another river's channel).
    var floors: array<vec4<f32>, ${MAX_FLOORS}>;
    var floorWater: array<vec4<f32>, ${MAX_FLOORS}>;
    var floorWeight: array<f32, ${MAX_FLOORS}>;
    var floorLake: array<f32, ${MAX_FLOORS}>;
    var beyond: array<f32, ${MAX_FLOORS}>;
    var nFloors = 0u;
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
        if (nFloors < ${MAX_FLOORS}u) {
            let cd = riverCarveDuals(s, p);
            floors[nFloors] = riverCarveFloor_d(cd, p);
            floorWater[nFloors] = cd.wl;
            floorWeight[nFloors] = riverCarveFloorWeight(s, p);
            floorLake[nFloors] = p.lakeGuard;
            beyond[nFloors] = p.d - p.hw;
            nFloors++;
        }
        if (excavated) {
            // The coarse valley field can interpolate a downstream cut into
            // an upstream bank. Near the channel, use the fine section cut
            // from the original terrain instead. This restores excavation;
            // it never constructs a bank above the original ground.
            let section = riverCarveSegment_d(s, p, unitDir, original);
            if (section.x < fine.x) { fine = section; }
            let ab = s.p1 - s.p0;
            let tg = select(vec3<f32>(0.0), ab / max(dot(ab, ab), 1.0e-20), p.tRaw > 0.0 && p.tRaw < 1.0);
            let sg = (s.s1 - s.s0) * tg;
            let lineGrad = p.v * (waterParams.planetRadius * waterParams.planetRadius / max(p.dLine, 1.0e-3));
            let grad = sign(p.n) * (p.nSign * lineGrad - p.dOff * sg) - p.dHw * sg;
            let edge = vec4<f32>(p.d - p.hw, grad);
            let weight = dSmoothstep(${(MICRO_RETURN_M * 0.5).toFixed(1)}, ${MICRO_RETURN_M.toFixed(1)}, edge);
            if (weight.x < valleyWeight.x) { valleyWeight = weight; }
        }
    }
    if (excavated) { h = fine + dMul(h - fine, valleyWeight); }
    // Containment (riverSection.js riverContainedHeight): raise the ground
    // toward the highest floor, where it applies. The weights are taken as
    // constant (their change along a river and across a junction is slow).
    var fill = dConst(0.0);
    for (var i = 0u; i < nFloors; i++) {
        let lake = floorLake[i];
        var w = floorWeight[i] * select(smoothstep(lake - 0.1, lake + 0.2, h.x), 1.0, lake < -1.0e10);
        for (var j = 0u; j < nFloors; j++) {
            if (j != i) { w = min(w, smoothstep(0.0, ${CONTAIN.riseM.toFixed(1)}, beyond[j])); }
        }
        if (w <= 0.0) { continue; }
        let f = riverContainFill_d(floors[i], h, floorWater[i]) * w;
        if (f.x > fill.x) { fill = f; }
    }
    return (h + fill) / maxH;
}

fn riverCarve_d(hd: vec4<f32>, unitDir: vec3<f32>) -> vec4<f32> {
    return riverCarveTerrain_d(hd, hd, unitDir);
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

${bankDetail ? `${createWaterLookupWgsl(RIVER_CARVE_GROUP, RIVER_CARVE_BINDINGS)}
@group(${RIVER_CARVE_GROUP}) @binding(${RIVER_CARVE_BINDINGS.sampler}) var riverCarveLakeSampler: sampler;

fn riverCarveShoreEnabled() -> bool { return waterParams.bank.w > 0.0 && waterParams.enabled != 0u; }
fn riverCarveShoreNoise(dir: vec3<f32>) -> f32 {
    let R = waterParams.planetRadius;
    return waterBankNoise((dir.x + dir.z * 0.31) * R * 0.08, (dir.y + dir.z * 0.73) * R * 0.08, 927.0).x;
}
// Bed / rock (none) / wet toe. This only controls existing splat materials;
// it neither paints a solid colour nor changes water ownership. River and
// lake beds are the same mud (owner 2026-10-25), so a river's bed runs on
// into its lake's.
fn riverCarveShoreWeights(dir: vec3<f32>, heightM: f32, slope: f32) -> vec3<f32> {
    if (!riverCarveShoreEnabled()) { return vec3<f32>(0.0); }
    return max(riverCarveRiverShore(dir, heightM, slope), vec3<f32>(riverCarveLakeBed(dir, heightM), 0.0, 0.0));
}

// Ground below a lake's level, over 0.3 m of depth. Lakes without a solved
// shore yet count by level (their cells), as the lake renderer draws them.
fn riverCarveLakeBed(dir: vec3<f32>, heightM: f32) -> f32 {
    let level = waterLakeLevelAt(dir, heightM, riverCarveLakeSampler);
    return select(0.0, smoothstep(0.0, 0.3, level - heightM), level > WATER_NO_LAKE);
}

// The bed and a narrow strip above the waterline are mud (owner 2026-10-24:
// the mixed gravel, dirt and rock bed read as a tiled road).
fn riverCarveRiverShore(dir: vec3<f32>, heightM: f32, slope: f32) -> vec3<f32> {
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
    // Into a lake (pool -1 there) the bed fades out over the segment where
    // the flag changes, into the lake's (riverCarveLakeBed); cut at the
    // first lake point, it ended in a straight line across the channel
    // (owner 2026-10-24).
    let inLake = clamp(-p.pool, 0.0, 1.0);
    if (inLake >= 1.0 || p.d > riverCarveReach(p)) { return vec3<f32>(0.0); }
    // Mud over the channel and out onto the banks, its reach and its blend
    // varied organically: how far it goes beyond the channel's edge (0-8 m,
    // ~75 m and ~15 m along the river), how wide it blends into the
    // ground (1.5-5 m, ~30 m), and its edge broken into lobes (~6 m and ~3 m
    // across both ways). A constant edge read as a clean line (owner
    // 2026-10-26); edges by height or over the outer 15 % of the half-width
    // were finer than the splat grid and drew in teeth. No rock: its texture
    // showed a grid of 1 m tiles in the bed (owner 2026-10-25).
    let nLong = waterBankNoise(p.s * 0.04, p.n * 0.075, p.river + 17.0).x;
    let nMid = waterBankNoise(p.s * 0.2, p.n * 0.2, p.river + 31.0).x;
    let nBlend = waterBankNoise(p.s * 0.1, p.n * 0.1, p.river + 47.0).x;
    let lobes = 1.5 * waterBankNoise(p.s * 0.5, p.n * 0.5, p.river + 59.0).x
        + 0.6 * waterBankNoise(p.s * 1.0, p.n * 1.0, p.river + 73.0).x;
    let reach = clamp(2.5 + 2.5 * nLong + 1.5 * nMid, 0.0, 8.0);
    let blend = 3.25 + 1.75 * nBlend;
    let edge = p.hw + reach;
    // The channel itself stays mud: the lobes act beyond its edge.
    let dEdge = p.d + lobes * smoothstep(p.hw - 1.0, p.hw + 1.0, p.d);
    let mud = 1.0 - smoothstep(max(p.hw - 0.5, edge - 0.5 * blend), edge + 0.5 * blend, dEdge);
    return vec3<f32>(mud, 0.0, mud * 0.15) * (1.0 - inLake);
}` : `fn riverCarveShoreEnabled() -> bool { return false; }
fn riverCarveShoreNoise(dir: vec3<f32>) -> f32 { return 0.0; }
fn riverCarveShoreWeights(dir: vec3<f32>, heightM: f32, slope: f32) -> vec3<f32> { return vec3<f32>(0.0); }`}
`;
}
