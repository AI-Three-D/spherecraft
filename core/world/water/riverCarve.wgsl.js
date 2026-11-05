// core/world/water/riverCarve.wgsl.js
//
// Rivers in the terrain height function: the last step of
// calculateTerrainHeightD (earthLikeBase.wgsl.js) adds the baked river
// field's ground change Δ (riverField.js, riverField.wgsl.js), so every
// consumer of the height gets the same river: tiles at every LOD, normals,
// the water simulation's bed. The hydrology sampler compiles the terrain
// without it (the rivers are traced and the field baked on the natural
// terrain). Micro detail is held against the field's water level; bed
// materials follow the depth under it, and the lakes' own rule elsewhere.

import { createWaterCommonWgsl, createWaterLookupWgsl } from './waterWgsl.js';
import { RIVER_SECTION } from './riverSection.js';
import { createRiverFieldWgsl } from './riverField.wgsl.js';
import { RIVER_FIELD } from './riverField.js';

// Group 1 of the terrain generator's pipelines (binding 0 is its biome uniform).
// lakes, masks and sampler: the lake lookup of the shore materials (bankDetail).
export const RIVER_CARVE_GROUP = 1;
export const RIVER_CARVE_BINDINGS = Object.freeze({ index: 1, params: 2, lakes: 7, masks: 8, sampler: 9 });
// Near water the micro detail may not cross its level (riverCarveMicroAt):
// within MICRO_LEVEL_REACH_M of the water's edge (none beyond twice that, which
// is as far as the field's signed distance goes: any more and it held
// everywhere, flattening patches far from a river along its level's contour), a
// dip stops MICRO_LEVEL_MARGIN_M above the level and a bump as far below it,
// both rounded over MICRO_LEVEL_SOFT_M; the detail fades out within
// MICRO_LEVEL_FADE_M (height) of the level, so the shoreline stays where the
// field put it (puddles beside the channel, islands in it otherwise).
const MICRO_LEVEL_REACH_M = RIVER_FIELD.sdfM / 2;
const MICRO_LEVEL_MARGIN_M = 0.1;
const MICRO_LEVEL_SOFT_M = 0.25;
const MICRO_LEVEL_FADE_M = 0.35;

/**
 * @param {object} [o]
 * @param {boolean} [o.enabled=true]  false: pass-through stubs (no bindings)
 * @param {boolean} [o.bankDetail=false] compile the shore materials
 * @returns {string} WGSL: riverCarveTerrain_d(hd, unitDir), riverCarveMicroAt(unitDir, heightM, microM), riverCarveShoreWeights(dir, heightM, slope)
 */
export function createRiverCarveWgsl({ enabled = true, bankDetail = false } = {}) {
    if (!enabled) {
        return /* wgsl */`
// Rivers off in this shader (riverCarve.wgsl.js).
fn riverCarveTerrain_d(hd: vec4<f32>, unitDir: vec3<f32>) -> vec4<f32> { return hd; }
fn riverCarveMicroAt(unitDir: vec3<f32>, heightM: f32, microM: f32) -> f32 { return microM; }
fn riverCarveShoreWeights(dir: vec3<f32>, heightM: f32, slope: f32) -> vec3<f32> { return vec3<f32>(0.0); }
fn riverCarveShoreEnabled() -> bool { return false; }
fn riverCarveShoreNoise(dir: vec3<f32>) -> f32 { return 0.0; }
`;
    }
    return /* wgsl */`
// ==================== Rivers in the terrain (core/world/water/riverCarve.wgsl.js) ====
${createWaterCommonWgsl(RIVER_CARVE_GROUP, RIVER_CARVE_BINDINGS)}
${createRiverFieldWgsl({ group: RIVER_CARVE_GROUP })}

fn riverCarveTerrain_d(hd: vec4<f32>, unitDir: vec3<f32>) -> vec4<f32> {
    if (!terrainFeatureOn(TF_WATER_CARVE)) { return hd; }
    return hd + riverFieldDelta_d(unitDir) / maxTerrainHeightM();
}

fn riverMicroSmin(a: f32, b: f32, k: f32) -> f32 {
    let h = max(k - abs(a - b), 0.0) / k;
    return min(a, b) - h * h * k * 0.25;
}

// The per-tile micro detail (microM, m) at unitDir over ground at heightM.
fn riverCarveMicroAt(unitDir: vec3<f32>, heightM: f32, microM: f32) -> f32 {
    let f = riverFieldAt(unitDir);
    if (!f.found) { return microM; }
    let hold = 1.0 - smoothstep(${MICRO_LEVEL_REACH_M.toFixed(1)}, ${(2 * MICRO_LEVEL_REACH_M).toFixed(1)}, -f.value.z);
    if (hold <= 0.0) { return microM; }
    let d = heightM - f.value.y;
    let room = max(abs(d) - ${MICRO_LEVEL_MARGIN_M.toFixed(2)}, 0.0);
    // Above the water a dip stops short of it; below, a bump.
    var held = select(-riverMicroSmin(-microM, room, ${MICRO_LEVEL_SOFT_M.toFixed(2)}), riverMicroSmin(microM, room, ${MICRO_LEVEL_SOFT_M.toFixed(2)}), d < 0.0);
    held *= smoothstep(0.0, ${MICRO_LEVEL_FADE_M.toFixed(2)}, abs(d));
    return mix(microM, held, hold);
}

${bankDetail ? `${createWaterLookupWgsl(RIVER_CARVE_GROUP, RIVER_CARVE_BINDINGS)}
@group(${RIVER_CARVE_GROUP}) @binding(${RIVER_CARVE_BINDINGS.sampler}) var riverCarveLakeSampler: sampler;

fn riverCarveShoreEnabled() -> bool { return waterParams.bank.w > 0.0 && waterParams.enabled != 0u; }

// Mud belongs below the water: the visible waterline stays grassy, then
// the bed turns to the shared mud over submerged depth (owner 2026-10-25,
// 10-29); nothing on dry ground.
fn riverCarveShoreProfile(inlandM: f32, depthM: f32, variation: f32) -> vec3<f32> {
    let v = clamp(0.5 + 0.5 * variation, 0.0, 1.0);
    let start = mix(${RIVER_SECTION.shore.mudStartDepthM[0].toFixed(2)}, ${RIVER_SECTION.shore.mudStartDepthM[1].toFixed(2)}, v);
    let full = mix(${RIVER_SECTION.shore.mudFullDepthM[0].toFixed(2)}, ${RIVER_SECTION.shore.mudFullDepthM[1].toFixed(2)}, v);
    let mud = smoothstep(start, full, depthM) * (1.0 - smoothstep(0.0, 0.25, inlandM));
    return vec3<f32>(mud, 0.0, 0.0);
}
// Broad noise varies the depth of the submerged transition.
fn riverCarveShoreVariation(dir: vec3<f32>) -> f32 {
    let R = waterParams.planetRadius;
    let nReach = waterBankNoise((dir.x + dir.z * 0.31) * R * 0.08, (dir.y + dir.z * 0.73) * R * 0.08, 101.0).x;
    let nBlend = waterBankNoise((dir.y + dir.x * 0.47) * R * 0.1, (dir.z + dir.x * 0.29) * R * 0.1, 113.0).x;
    return 0.65 * nReach + 0.35 * nBlend;
}
// Broad noise of the regional lakes' shore material (surfaceCommon.wgsl.js).
fn riverCarveShoreNoise(dir: vec3<f32>) -> f32 {
    let R = waterParams.planetRadius;
    return waterBankNoise((dir.x + dir.z * 0.31) * R * 0.08, (dir.y + dir.z * 0.73) * R * 0.08, 927.0).x;
}
// Bed mud / rock (none) / reserved (zero). This controls existing splat
// materials; it neither paints a solid colour nor changes where water is.
// In the river field's pages by depth under its level within its connected
// water; elsewhere under a lake, distance from the waterline being depth
// over the ground's gradient (lakes without a solved shore count by level,
// looked up 3 m lower so the shore just above the water finds its lake).
fn riverCarveShoreWeights(dir: vec3<f32>, heightM: f32, slope: f32) -> vec3<f32> {
    if (!riverCarveShoreEnabled()) { return vec3<f32>(0.0); }
    let field = riverFieldAt(dir);
    // The mud starts from where the water does (waterShoreM): lake water only, a
    // river's own level being off the lake's.
    let shoreM = waterShoreM(dir, 0.0);
    let lake = waterLakeHitView(dir, heightM - 3.0, riverCarveLakeSampler, true);
    if (field.found) {
        let onLake = select(0.0, 1.0 - smoothstep(0.05, 0.4, abs(field.value.y - lake.level)), lake.level > WATER_NO_LAKE);
        return riverCarveShoreProfile(-field.value.z, field.value.y - heightM - shoreM * onLake, riverCarveShoreVariation(dir));
    }
    if (lake.level <= WATER_NO_LAKE) { return vec3<f32>(0.0); }
    let s = clamp(slope, 0.0, 0.99);
    let fromShore = (lake.level - heightM) / max(s / sqrt(1.0 - s * s), 0.02);
    return riverCarveShoreProfile(-fromShore, lake.level - heightM - shoreM, riverCarveShoreVariation(dir)) * lake.cover;
}` : `fn riverCarveShoreEnabled() -> bool { return false; }
fn riverCarveShoreNoise(dir: vec3<f32>) -> f32 { return 0.0; }
fn riverCarveShoreWeights(dir: vec3<f32>, heightM: f32, slope: f32) -> vec3<f32> { return vec3<f32>(0.0); }`}
`;
}
