// core/world/water/waterWgsl.js
//
// Lakes and rivers for shaders: which water covers a point, at what level,
// and how it looks. Shared WGSL, so the terrain shader draws water in its
// own shading now (owner 2026-10-05: performance first, far water
// simplified) and a water-surface pass can reuse it later.
//
// GPU data (WaterGpuData.js):
// - waterIndex: two halves of one u32 per cell of the water graph's cube
//   grid (6 x N x N cells, cell id = face * N * N + j * N + i):
//   [0, cells): lake slot A + 1 in bits 0..14, slot B + 1 in bits 15..29
//   (0 = none), bit 30 = a graph river cell not traced yet (debug view);
//   [cells, 2 cells): river segments in the cell: first << 8 | count;
// - waterLakes: per lake, its level and, once refined, its mask layer and
//   tangent-plane frame (lakeRefine.js);
// - waterLakeMasks: r8 layers, 1 where the lake's water may show;
// - waterRivers: river segments (riverRefine.js), listed per cell;
// - waterParams: switches, grid size, colours.
// A point is lake water when a lake in its cell has a level above the
// point's height and (refined lakes) the mask allows water there. It is
// river water when it lies in a river's channel (half-width from the
// traced line), or beside it below the river's level, which drops by
// spreadSlope per metre away from the channel. Shorelines are exact per
// pixel: where the terrain height crosses the level.

export const WATER_BINDINGS = Object.freeze({ index: 12, lakes: 13, masks: 14, params: 15, rivers: 16 });

// WaterLake: 4 x vec4 (64 bytes). WaterParams: 4 x vec4. WaterRiverSeg: 3 x vec4 (48 bytes).
export const LAKE_RECORD_FLOATS = 16;
export const LAKE_PARAMS_FLOATS = 16;
export const RIVER_SEG_FLOATS = 12;
export const RIVER_MAX_SEGS_PER_CELL = 64;

/**
 * @param {object} [o]
 * @param {number} [o.group=3]   bind group of the water bindings
 * @returns {string} WGSL: structs, bindings, waterLakeLevelAt(), waterRiverAt(), applyWater()
 */
export function createWaterWgsl({ group = 3 } = {}) {
    const B = WATER_BINDINGS;
    return /* wgsl */`
// ==================== Water (core/world/water/waterWgsl.js) ====
struct WaterLake {
    level: f32, maskLayer: i32, sizeX: f32, sizeY: f32,
    c: vec3<f32>, x0: f32,
    e1: vec3<f32>, y0: f32,
    e2: vec3<f32>, _pad: f32,
};
struct WaterParams {
    gridN: u32, enabled: u32, debugMode: u32, riverCount: u32,
    planetRadius: f32, time: f32, rippleFade: f32, shoreSoftM: f32,
    deepColor: vec4<f32>,      // rgb; a = reflection strength
    absorption: vec4<f32>,     // rgb per metre of water path; a = river spread slope (m/m)
};
struct WaterRiverSeg {
    p0: vec3<f32>, eta0: f32,  // unit direction, water level (m)
    p1: vec3<f32>, eta1: f32,
    hw0: f32, hw1: f32, depth: f32, speed: f32,
};
@group(${group}) @binding(${B.index}) var<storage, read> waterIndex: array<u32>;
@group(${group}) @binding(${B.lakes}) var<storage, read> waterLakes: array<WaterLake>;
@group(${group}) @binding(${B.masks}) var waterLakeMasks: texture_2d_array<f32>;
@group(${group}) @binding(${B.params}) var<uniform> waterParams: WaterParams;
@group(${group}) @binding(${B.rivers}) var<storage, read> waterRivers: array<WaterRiverSeg>;

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
    let e = waterIndex[waterDirToCell(dir, waterParams.gridN)];
    let a = waterLakeLevelIn(e & 0x7fffu, dir, heightM, samp);
    if (a > WATER_NO_LAKE) { return a; }
    return waterLakeLevelIn((e >> 15u) & 0x7fffu, dir, heightM, samp);
}

struct WaterRiverHit {
    found: bool,
    depthM: f32,          // water depth at the point
    distM: f32,           // distance from the river line
    halfWidthM: f32,
    flow: vec3<f32>,      // flow direction (unit, along the line)
    speed: f32,
};

// The river (if any) at a point: nearest segment among those listed in its cell.
fn waterRiverAt(dir: vec3<f32>, heightM: f32) -> WaterRiverHit {
    var hit: WaterRiverHit;
    hit.found = false;
    let n = waterParams.gridN;
    let e = waterIndex[6u * n * n + waterDirToCell(dir, n)];
    let count = min(e & 0xffu, ${RIVER_MAX_SEGS_PER_CELL}u);
    if (count == 0u) { return hit; }
    let first = e >> 8u;
    var best = 1.0e30;
    var eta = 0.0;
    for (var k = 0u; k < count; k++) {
        let s = waterRivers[first + k];
        let ab = s.p1 - s.p0;
        let t = clamp(dot(dir - s.p0, ab) / max(dot(ab, ab), 1.0e-20), 0.0, 1.0);
        let dist = length(dir - (s.p0 + ab * t)) * waterParams.planetRadius;
        if (dist < best) {
            best = dist;
            eta = mix(s.eta0, s.eta1, t);
            hit.halfWidthM = mix(s.hw0, s.hw1, t);
            hit.flow = ab;
            hit.speed = s.speed;
            hit.depthM = s.depth;
        }
    }
    let hw = hit.halfWidthM;
    if (best > hw + 200.0) { return hit; }
    // Channel: parabolic cross-section of the river's depth; beside it the
    // level drops with distance, so water spreads only into low ground.
    let channel = hit.depthM * max(0.0, 1.0 - (best / hw) * (best / hw));
    let etaSide = eta - max(0.0, best - hw) * waterParams.absorption.a;
    let depthM = max(channel, etaSide - heightM);
    hit.found = depthM > 0.0;
    hit.depthM = depthM;
    hit.distM = best;
    let along = hit.flow - dir * dot(hit.flow, dir);
    hit.flow = select(normalize(cross(dir, vec3<f32>(0.0, 1.0, 0.0001))), normalize(along), dot(along, along) > 1.0e-24);
    return hit;
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
fn waterNoiseGrad(p: vec2<f32>) -> vec2<f32> {
    let e = 0.05;
    return vec2<f32>(waterNoise(p + vec2<f32>(e, 0.0)) - waterNoise(p - vec2<f32>(e, 0.0)),
                     waterNoise(p + vec2<f32>(0.0, e)) - waterNoise(p - vec2<f32>(0.0, e))) / (2.0 * e);
}

// Water colour over a bed: the bed seen through the water column along
// the view ray, sky reflection (Fresnel), sun glint, ripples near the
// camera; for rivers the ripples move with the flow (two phases blended,
// as Whitewater's flow-mapped water does).
fn waterSurfaceColor(
    bedColor: vec3<f32>, depthM: f32, worldPos: vec3<f32>, up: vec3<f32>, cameraPos: vec3<f32>,
    lightDir: vec3<f32>, sunRadiance: vec3<f32>, skyRadiance: vec3<f32>,
    flow: vec3<f32>, speed: f32, rippleGain: f32,
) -> vec3<f32> {
    let toCam = cameraPos - worldPos;
    let dist = length(toCam);
    let V = toCam / dist;
    let cosV = max(dot(V, up), 0.02);
    let transmit = exp(-(depthM / cosV) * waterParams.absorption.rgb);
    let sunUp = max(dot(up, lightDir), 0.0);
    let deep = waterParams.deepColor.rgb * (skyRadiance + sunRadiance * sunUp);
    let body = mix(deep, bedColor, transmit);

    var N = up;
    let ripple = (1.0 - smoothstep(0.0, waterParams.rippleFade, dist)) * rippleGain;
    if (ripple > 0.001) {
        // Frame along the flow (rivers) or a fixed tangent (lakes).
        var t1 = flow;
        if (speed <= 0.0) { t1 = normalize(cross(up, vec3<f32>(0.0, 1.0, 0.0001))); }
        let t2 = cross(up, t1);
        let q = vec2<f32>(dot(worldPos, t1), dot(worldPos, t2)) * 0.35;
        let tm = waterParams.time;
        var g = vec2<f32>(0.0);
        if (speed > 0.0) {
            let T = 2.0;
            let ph0 = fract(tm / T);
            let ph1 = fract(tm / T + 0.5);
            let blend = abs(2.0 * ph0 - 1.0);
            let ga = waterNoiseGrad(q - vec2<f32>(speed * 0.35 * ph0 * T, 0.0));
            let gb = waterNoiseGrad(q - vec2<f32>(speed * 0.35 * ph1 * T, 0.0) + vec2<f32>(37.0, 11.0));
            g = mix(ga, gb, blend) * vec2<f32>(0.6, 1.0);
        } else {
            g = waterNoiseGrad(q + vec2<f32>(tm * 0.11, -tm * 0.07));
        }
        N = normalize(up + (t1 * g.x + t2 * g.y) * 0.08 * ripple);
    }
    let fres = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
    let R = reflect(-V, N);
    let spec = pow(max(dot(R, lightDir), 0.0), 600.0) * 3.0;
    var col = mix(body, skyRadiance * waterParams.deepColor.a, fres) + sunRadiance * spec;
    // Soft waterline: the first centimetres of depth fade in.
    return mix(bedColor, col, smoothstep(0.0, waterParams.shoreSoftM, depthM));
}

fn waterTint(id: f32) -> vec3<f32> {
    return fract(vec3<f32>(id * 0.618034, id * 0.381966 + 0.3, id * 0.7548777 + 0.6));
}

// Shades a terrain fragment under lake or river water; unchanged elsewhere.
fn applyWater(
    bedColor: vec3<f32>, worldPos: vec3<f32>, cameraPos: vec3<f32>, planetCenter: vec3<f32>,
    lightDir: vec3<f32>, sunRadiance: vec3<f32>, skyRadiance: vec3<f32>, samp: sampler,
) -> vec3<f32> {
    if (waterParams.enabled == 0u) { return bedColor; }
    let rel = worldPos - planetCenter;
    let r = length(rel);
    let up = rel / r;
    let heightM = r - waterParams.planetRadius;
    let dbg = waterParams.debugMode;

    let level = waterLakeLevelAt(up, heightM, samp);
    if (level > WATER_NO_LAKE) {
        let depthM = level - heightM;
        if (dbg == 1u || dbg == 2u) {
            let e = waterIndex[waterDirToCell(up, waterParams.gridN)];
            return mix(waterTint(f32(e & 0x7fffu)), vec3<f32>(0.0, 0.1, 0.6), clamp(depthM / 40.0, 0.0, 0.8));
        }
        if (dbg == 3u) { return mix(vec3<f32>(0.6, 1.0, 1.0), vec3<f32>(0.0, 0.0, 0.3), clamp(depthM / 50.0, 0.0, 1.0)); }
        return waterSurfaceColor(bedColor, depthM, worldPos, up, cameraPos, lightDir, sunRadiance, skyRadiance, up, 0.0, 1.0);
    }

    let river = waterRiverAt(up, heightM);
    if (river.found) {
        if (dbg == 1u || dbg == 2u) { return mix(vec3<f32>(1.0, 0.15, 0.1), vec3<f32>(0.3, 0.0, 0.5), clamp(river.depthM / 5.0, 0.0, 1.0)); }
        if (dbg == 3u) { return mix(vec3<f32>(0.6, 1.0, 1.0), vec3<f32>(0.0, 0.0, 0.3), clamp(river.depthM / 50.0, 0.0, 1.0)); }
        return waterSurfaceColor(bedColor, river.depthM, worldPos, up, cameraPos, lightDir, sunRadiance, skyRadiance, river.flow, river.speed, 1.6);
    }

    if (dbg == 2u) {
        let cell = waterDirToCell(up, waterParams.gridN);
        let e = waterIndex[cell];
        let n = waterParams.gridN;
        if ((e & 0x7fffu) != 0u) { return mix(bedColor, vec3<f32>(0.1, 0.4, 1.0), 0.35); }
        if ((waterIndex[6u * n * n + cell] & 0xffu) != 0u) { return mix(bedColor, vec3<f32>(1.0, 0.1, 0.05), 0.3); }
        if (((e >> 30u) & 1u) != 0u) { return mix(bedColor, vec3<f32>(1.0, 0.6, 0.0), 0.45); }
    }
    return bedColor;
}
`;
}
