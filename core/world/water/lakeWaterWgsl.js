// core/world/water/lakeWaterWgsl.js
//
// Lake water for shaders: which lake covers a point, at what level, and how
// the water looks there. Shared WGSL, so the terrain shader can draw far
// water in its own shading now (owner 2026-10-05: performance first, far
// water simplified) and a water-surface pass can reuse it later.
//
// GPU data (LakeGpuData.js):
// - waterLakeIndex: one u32 per cell of the water graph's cube grid
//   (6 x N x N, cell id = face * N * N + j * N + i): lake slot A + 1 in
//   bits 0..14, slot B + 1 in bits 15..29 (0 = none), bit 30 = river cell;
// - waterLakes: per lake, its level and, once refined, its mask layer and
//   tangent-plane frame (lakeRefine.js);
// - waterLakeMasks: r8 layers, 1 where the lake's water may show;
// - waterParams: switches, grid size, colours.
// A point is lake water when a lake in its cell has a level above the
// point's height and (refined lakes) the mask allows water there. The
// shoreline is therefore exact per pixel: it is where the terrain height
// crosses the level.

export const LAKE_WATER_BINDINGS = Object.freeze({ index: 12, lakes: 13, masks: 14, params: 15 });

// WaterLake: 4 x vec4 (64 bytes). WaterParams: 4 x vec4 (64 bytes).
export const LAKE_RECORD_FLOATS = 16;
export const LAKE_PARAMS_FLOATS = 16;

/**
 * @param {object} [o]
 * @param {number} [o.group=3]   bind group of the four lake bindings
 * @returns {string} WGSL: structs, bindings, waterLakeLevelAt(), applyLakeWater()
 */
export function createLakeWaterWgsl({ group = 3 } = {}) {
    const B = LAKE_WATER_BINDINGS;
    return /* wgsl */`
// ==================== Lake water (core/world/water/lakeWaterWgsl.js) ====
struct WaterLake {
    level: f32, maskLayer: i32, sizeX: f32, sizeY: f32,
    c: vec3<f32>, x0: f32,
    e1: vec3<f32>, y0: f32,
    e2: vec3<f32>, _pad: f32,
};
struct WaterParams {
    gridN: u32, enabled: u32, debugMode: u32, lakeCount: u32,
    planetRadius: f32, time: f32, rippleFade: f32, shoreSoftM: f32,
    deepColor: vec4<f32>,      // rgb; a = reflection strength
    absorption: vec4<f32>,     // rgb per metre of water path; a unused
};
@group(${group}) @binding(${B.index}) var<storage, read> waterLakeIndex: array<u32>;
@group(${group}) @binding(${B.lakes}) var<storage, read> waterLakes: array<WaterLake>;
@group(${group}) @binding(${B.masks}) var waterLakeMasks: texture_2d_array<f32>;
@group(${group}) @binding(${B.params}) var<uniform> waterParams: WaterParams;

const WATER_NO_LAKE: f32 = -1.0e30;

// Cube-grid cell of a unit direction; same mapping as waterGraph.js dirToCell.
fn waterDirToCell(d: vec3<f32>, n: u32) -> u32 {
    let a = abs(d);
    var face = 0u;
    var x = 0.0;
    var y = 0.0;
    if (a.x >= a.y && a.x >= a.z) {
        if (d.x > 0.0) { face = 0u; x = -d.z / d.x; y = d.y / d.x; }
        else { face = 1u; x = d.z / -d.x; y = d.y / -d.x; }
    } else if (a.y >= a.z) {
        if (d.y > 0.0) { face = 2u; x = d.x / d.y; y = -d.z / d.y; }
        else { face = 3u; x = d.x / -d.y; y = d.z / -d.y; }
    } else if (d.z > 0.0) {
        face = 4u; x = d.x / d.z; y = d.y / d.z;
    } else {
        face = 5u; x = -d.x / -d.z; y = d.y / -d.z;
    }
    let fn_ = f32(n);
    let i = u32(clamp(floor((x + 1.0) * 0.5 * fn_), 0.0, fn_ - 1.0));
    let j = u32(clamp(floor((y + 1.0) * 0.5 * fn_), 0.0, fn_ - 1.0));
    return face * n * n + j * n + i;
}

// Level of lake slot s (1-based, 0 = none) if it covers dir at heightM.
fn waterLakeLevelIn(slot: u32, dir: vec3<f32>, heightM: f32, samp: sampler) -> f32 {
    if (slot == 0u) { return WATER_NO_LAKE; }
    let lake = waterLakes[slot - 1u];
    if (heightM >= lake.level) { return WATER_NO_LAKE; }
    if (lake.maskLayer < 0) { return lake.level; }
    let k = dot(dir, lake.c);
    if (k <= 0.0) { return WATER_NO_LAKE; }
    let px = dot(dir, lake.e1) / k * waterParams.planetRadius;
    let py = dot(dir, lake.e2) / k * waterParams.planetRadius;
    let uv = vec2<f32>((px - lake.x0) / lake.sizeX, (py - lake.y0) / lake.sizeY);
    if (any(uv < vec2<f32>(0.0)) || any(uv > vec2<f32>(1.0))) { return WATER_NO_LAKE; }
    let m = textureSampleLevel(waterLakeMasks, samp, uv, lake.maskLayer, 0.0).r;
    return select(WATER_NO_LAKE, lake.level, m >= 0.5);
}

// Water level over a point (unit direction, height above the sphere), or
// WATER_NO_LAKE.
fn waterLakeLevelAt(dir: vec3<f32>, heightM: f32, samp: sampler) -> f32 {
    let e = waterLakeIndex[waterDirToCell(dir, waterParams.gridN)];
    let a = waterLakeLevelIn(e & 0x7fffu, dir, heightM, samp);
    if (a > WATER_NO_LAKE) { return a; }
    return waterLakeLevelIn((e >> 15u) & 0x7fffu, dir, heightM, samp);
}

fn waterHash(p: vec2<f32>) -> f32 {
    var p3 = fract(vec3<f32>(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
fn waterNoise(p: vec2<f32>) -> f32 {
    let i = floor(p); let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    return mix(mix(waterHash(i), waterHash(i + vec2<f32>(1.0, 0.0)), u.x),
               mix(waterHash(i + vec2<f32>(0.0, 1.0)), waterHash(i + vec2<f32>(1.0, 1.0)), u.x), u.y);
}

// Shades a terrain fragment that lies under lake water: the bed colour seen
// through the water column along the view ray, the sky reflection (Fresnel)
// and the sun glint. Returns the colour unchanged above water.
fn applyLakeWater(
    bedColor: vec3<f32>, worldPos: vec3<f32>, cameraPos: vec3<f32>, planetCenter: vec3<f32>,
    lightDir: vec3<f32>, sunRadiance: vec3<f32>, skyRadiance: vec3<f32>, samp: sampler,
) -> vec3<f32> {
    if (waterParams.enabled == 0u) { return bedColor; }
    let rel = worldPos - planetCenter;
    let r = length(rel);
    let up = rel / r;
    let heightM = r - waterParams.planetRadius;
    let level = waterLakeLevelAt(up, heightM, samp);
    if (level <= WATER_NO_LAKE) {
        if (waterParams.debugMode == 2u) {
            let e = waterLakeIndex[waterDirToCell(up, waterParams.gridN)];
            if ((e & 0x7fffu) != 0u) { return mix(bedColor, vec3<f32>(0.1, 0.4, 1.0), 0.35); }
            if (((e >> 30u) & 1u) != 0u) { return mix(bedColor, vec3<f32>(1.0, 0.1, 0.05), 0.5); }
        }
        return bedColor;
    }
    let depthM = level - heightM;

    if (waterParams.debugMode == 1u || waterParams.debugMode == 2u) {
        let e = waterLakeIndex[waterDirToCell(up, waterParams.gridN)];
        let id = f32(e & 0x7fffu);
        let tint = fract(vec3<f32>(id * 0.618034, id * 0.381966 + 0.3, id * 0.7548777 + 0.6));
        return mix(tint, vec3<f32>(0.0, 0.1, 0.6), clamp(depthM / 40.0, 0.0, 0.8));
    }
    if (waterParams.debugMode == 3u) {
        let t = clamp(depthM / 50.0, 0.0, 1.0);
        return mix(vec3<f32>(0.6, 1.0, 1.0), vec3<f32>(0.0, 0.0, 0.3), t);
    }

    let toCam = cameraPos - worldPos;
    let dist = length(toCam);
    let V = toCam / dist;
    let cosV = max(dot(V, up), 0.02);
    // Light through the water column from the surface down to the bed.
    let path = depthM / cosV;
    let transmit = exp(-path * waterParams.absorption.rgb);
    let sunUp = max(dot(up, lightDir), 0.0);
    let deep = waterParams.deepColor.rgb * (skyRadiance + sunRadiance * sunUp);
    var body = mix(deep, bedColor, transmit);

    // Ripples near the camera only (far water reads flat).
    var N = up;
    let ripple = 1.0 - smoothstep(0.0, waterParams.rippleFade, dist);
    if (ripple > 0.001) {
        let t1 = normalize(cross(up, vec3<f32>(0.0, 1.0, 0.0001)));
        let t2 = cross(up, t1);
        let q = vec2<f32>(dot(worldPos, t1), dot(worldPos, t2)) * 0.35;
        let tm = waterParams.time;
        let e = 0.05;
        let n0 = vec2<f32>(q.x + tm * 0.11, q.y - tm * 0.07);
        let gx = waterNoise(n0 + vec2<f32>(e, 0.0)) - waterNoise(n0 - vec2<f32>(e, 0.0));
        let gy = waterNoise(n0 + vec2<f32>(0.0, e)) - waterNoise(n0 - vec2<f32>(0.0, e));
        N = normalize(up + (t1 * gx + t2 * gy) * (0.08 / e) * ripple * 0.25);
    }
    let fres = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
    let R = reflect(-V, N);
    let spec = pow(max(dot(R, lightDir), 0.0), 600.0) * 3.0;
    var col = mix(body, skyRadiance * waterParams.deepColor.a, fres) + sunRadiance * spec;
    // Soft waterline: the first centimetres of depth fade in.
    col = mix(bedColor, col, smoothstep(0.0, waterParams.shoreSoftM, depthM));
    return col;
}
`;
}
