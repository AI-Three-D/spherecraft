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
//   [cells, 2 cells): rivers in the cell: its sub-list block + 1 (0 = none);
//   [2 cells, ...): sub-list blocks, one per river cell: for each of its
//   4 x 4 sub-cells, the river segments reaching it: first << 8 | count;
// - waterLakes: per lake, its level and, once refined, its mask layer and
//   tangent-plane frame (lakeRefine.js);
// - waterLakeMasks: r8 layers, 1 where the lake's water may show;
// - waterRivers: river segments (riverRefine.js), listed per cell;
// - waterParams: switches, grid size, colours, river carve parameters.
// A point is lake water when a lake in its cell has a level above the
// point's height and (refined lakes) the mask allows water there. It is
// river water when it lies below the river's level inside the river's
// channel zone (riverCarve.wgsl.js shapes the terrain there from the same
// segments: channel, banks above the level, hollows beside it filled).
// Shorelines are exact per pixel: where the terrain height crosses the level.

import { createRiverNoiseWgsl } from './riverShapeNoise.js';

export const WATER_BINDINGS = Object.freeze({ index: 12, lakes: 13, masks: 14, params: 15, rivers: 16 });

// WaterLake: 4 x vec4 (64 bytes). WaterParams: 11 x vec4. WaterRiverSeg: 7 x vec4 (112 bytes).
export const LAKE_RECORD_FLOATS = 16;
export const LAKE_PARAMS_FLOATS = 44;
export const RIVER_SEG_FLOATS = 28;
export const RIVER_MAX_SEGS_PER_CELL = 255;
// River segment lists per 4 x 4 sub-cells of a grid cell (~100 m at gridN
// 512): a terrain point only walks the segments that can reach it.
export const RIVER_SUB = 4;

/**
 * WGSL shared by the water lookup and the river carve: WaterParams,
 * WaterRiverSeg, the params / index / rivers bindings, waterDirToCell().
 * @param {number} group
 * @param {{index: number, params: number, rivers: number}} b  binding numbers
 */
export function createWaterCommonWgsl(group, b) {
    return createRiverNoiseWgsl() + /* wgsl */`
struct WaterParams {
    gridN: u32, enabled: u32, debugMode: u32, riverCount: u32,
    planetRadius: f32, time: f32, rippleFade: f32, shoreSoftM: f32,
    deepColor: vec4<f32>,      // rgb; a = reflection strength
    absorption: vec4<f32>,     // rgb per metre of water path; a unused
    // Active simulation strip (WaterRiverSim.js): along it the simulated
    // surface draws the water, so the static water fades out (waterSimCover).
    simRiver: vec4<f32>,       // river id, arc lengths s0, s1 of the window (m), half-width (m)
    simFade: vec4<f32>,        // fade at the window's ends (m), at its sides (m), unused, fade 0..1
    // x, y, z unused; w: lakes whose shore is not solved yet are not drawn
    // closer than this (m) (their grid-cell outline and coarse level look
    // wrong up close).
    riverLook: vec4<f32>,
    // River cross-section (waterRiverProfile, riverCarve.wgsl.js), x = metres
    // beyond the channel's edge: carve = (on 0/1, bankW: the terrain is the
    // cross-section for x < bankW, blendW: then blends into the natural
    // terrain, waterFrac: water fills this part of the bank-full depth);
    // bank = (bankH: rise beyond the edge, bankSoftM: over ~2x this,
    // bankGrade: further rise per metre, leveeGrade: where the ground is
    // lower the bank falls away by this per metre past its crest);
    // shape = (widthVar, wobble, bankVar: riverShapeNoise.js, unused).
    carve: vec4<f32>,
    bank: vec4<f32>,
    shape: vec4<f32>,
    // Near water (WaterGpuData.near): closer than near.y (m) a mesh draws
    // the lakes' surface (core/renderer/water/NearWaterRenderer.js) and the
    // terrain shading keeps only the water's body, faded in from near.x;
    // z = 1 on, 0 off (the terrain shading draws all of the water).
    near: vec4<f32>,
};
// A piece of a traced river between two points (unit directions); values
// interpolate along it: design level (the channel's waterline) and thalweg
// (m above the sphere), half-width (channel edge), pool (< 0 = in a lake:
// no fill), thalweg skew toward the outer bank (+ = left of the flow), mean
// flow speed, foam hint, arc length along the river (m), the river's id,
// and the water's level (normal depth of the river's discharge: what is
// drawn and simulated; at or below the design level).
struct WaterRiverSeg {
    p0: vec3<f32>, eta0: f32,
    p1: vec3<f32>, eta1: f32,
    hw0: f32, hw1: f32, bed0: f32, bed1: f32,
    pool0: f32, pool1: f32, skew0: f32, skew1: f32,
    speed0: f32, speed1: f32, foam0: f32, foam1: f32,
    s0: f32, s1: f32, river: f32, _pad: f32,
    wl0: f32, wl1: f32, _pad1: f32, _pad2: f32,
};
@group(${group}) @binding(${b.index}) var<storage, read> waterIndex: array<u32>;
@group(${group}) @binding(${b.params}) var<uniform> waterParams: WaterParams;
@group(${group}) @binding(${b.rivers}) var<storage, read> waterRivers: array<WaterRiverSeg>;

const WATER_RIVER_SUB: u32 = ${RIVER_SUB}u;

// Cube-grid cell of a unit direction and its sub-cell (0 .. SUB^2 - 1);
// same mapping as waterGraph.js dirToCell / dirToCellSub.
fn waterDirToCellSub(d: vec3<f32>, n: u32) -> vec2<u32> {
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
    let fx = (x + 1.0) * 0.5 * fn_;
    let fy = (y + 1.0) * 0.5 * fn_;
    let i = u32(clamp(floor(fx), 0.0, fn_ - 1.0));
    let j = u32(clamp(floor(fy), 0.0, fn_ - 1.0));
    let sub = f32(WATER_RIVER_SUB);
    let si = u32(clamp(floor((fx - f32(i)) * sub), 0.0, sub - 1.0));
    let sj = u32(clamp(floor((fy - f32(j)) * sub), 0.0, sub - 1.0));
    return vec2<u32>(face * n * n + j * n + i, sj * WATER_RIVER_SUB + si);
}

fn waterDirToCell(d: vec3<f32>, n: u32) -> u32 {
    return waterDirToCellSub(d, n).x;
}

// The nearest point of a river segment to a unit direction, and the
// segment's values there, with the river's natural irregularity along its
// length (riverShapeNoise.js): the half-width varies, the channel's centre
// wanders off the traced line, the banks rise more or less.
struct WaterRiverPt {
    d: f32,          // distance from the channel's centre (m)
    n: f32,          // signed offset from it, + left of the flow
    nSign: f32,      // side of the traced line (+1 left, -1 right)
    dLine: f32,      // distance from the traced line (m)
    t: f32,          // position along the segment (0..1)
    tRaw: f32,       // unclamped
    v: vec3<f32>,    // the direction minus the nearest point of the line
    eta: f32, bed: f32, hw: f32, pool: f32, skew: f32, speed: f32, foam: f32,
    wl: f32,         // the water's level (m)
    s: f32,          // arc length along the river (m)
    river: f32,      // the river's id
    dOff: f32,       // d(centre offset)/ds
    dHw: f32,        // d(half-width)/ds
    bankH: f32,      // bank rise beyond the edge here (m)
};

fn waterRiverPoint(s: WaterRiverSeg, dir: vec3<f32>) -> WaterRiverPt {
    var p: WaterRiverPt;
    let ab = s.p1 - s.p0;
    p.tRaw = dot(dir - s.p0, ab) / max(dot(ab, ab), 1.0e-20);
    p.t = clamp(p.tRaw, 0.0, 1.0);
    p.v = dir - (s.p0 + ab * p.t);
    p.dLine = length(p.v) * waterParams.planetRadius;
    let left = cross(dir, ab);
    p.nSign = select(-1.0, 1.0, dot(p.v, left) >= 0.0);
    p.eta = mix(s.eta0, s.eta1, p.t);
    p.bed = mix(s.bed0, s.bed1, p.t);
    p.pool = mix(s.pool0, s.pool1, p.t);
    p.skew = mix(s.skew0, s.skew1, p.t);
    p.speed = mix(s.speed0, s.speed1, p.t);
    p.foam = mix(s.foam0, s.foam1, p.t);
    p.wl = mix(s.wl0, s.wl1, p.t);
    p.s = mix(s.s0, s.s1, p.t);
    p.river = s.river;
    let hw0 = max(mix(s.hw0, s.hw1, p.t), 0.5);
    let wn = waterRiverNoise(p.s, s.river, 0u);
    let on = waterRiverNoise(p.s, s.river, 1u);
    let bn = waterRiverNoise(p.s, s.river, 2u);
    p.hw = max(hw0 * (1.0 + waterParams.shape.x * wn.x), 0.5);
    p.dHw = hw0 * waterParams.shape.x * wn.y;
    let off = waterParams.shape.y * hw0 * on.x;
    p.dOff = waterParams.shape.y * hw0 * on.y;
    p.n = p.nSign * p.dLine - off;
    p.d = abs(p.n);
    p.bankH = waterParams.bank.x * (1.0 + waterParams.shape.z * bn.x);
    return p;
}

// Height (m) of the river's cross-section at a point (Whitewater's
// river.js): channel T + D (1 - (1 - u^2)^1.5), u = offset / half-width with
// the thalweg moved toward the outer bank; beyond the edge (x m) the bank
// T + D + (bankH (1 - e^(-x / soft)) + grade x) smoothstep(0, soft, x).
// D = (level - thalweg) / waterFrac: the water fills waterFrac of it.
fn waterRiverProfile(p: WaterRiverPt) -> f32 {
    let D = (p.eta - p.bed) / max(waterParams.carve.w, 0.05);
    if (p.d < p.hw) {
        let u = p.n / p.hw;
        let de = select((u - p.skew) / (1.0 - p.skew), (u - p.skew) / (1.0 + p.skew), u < p.skew);
        return p.bed + D * (1.0 - pow(max(0.0, 1.0 - de * de), 1.5));
    }
    let x = p.d - p.hw;
    let soft = max(waterParams.bank.y, 0.1);
    return p.bed + D + (p.bankH * (1.0 - exp(-x / soft)) + waterParams.bank.z * x) * smoothstep(0.0, soft, x);
}

// River segments listed at a unit direction: first << 8 | count (0: none).
fn waterRiverList(d: vec3<f32>) -> u32 {
    let n = waterParams.gridN;
    let cs = waterDirToCellSub(d, n);
    let block = waterIndex[6u * n * n + cs.x];
    if (block == 0u) { return 0u; }
    return waterIndex[12u * n * n + (block - 1u) * WATER_RIVER_SUB * WATER_RIVER_SUB + cs.y];
}
`;
}

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
${createWaterCommonWgsl(group, B)}
@group(${group}) @binding(${B.lakes}) var<storage, read> waterLakes: array<WaterLake>;
@group(${group}) @binding(${B.masks}) var waterLakeMasks: texture_2d_array<f32>;

const WATER_NO_LAKE: f32 = -1.0e30;

// Level of lake slot s (1-based, 0 = none) if it covers dir at heightM.
// levelOnly: lakes without a solved shore (no mask layer) count too.
fn waterLakeLevelIn(slot: u32, dir: vec3<f32>, heightM: f32, samp: sampler, levelOnly: bool) -> f32 {
    if (slot == 0u) { return WATER_NO_LAKE; }
    let lake = waterLakes[slot - 1u];
    if (heightM >= lake.level) { return WATER_NO_LAKE; }
    if (lake.maskLayer < 0) { return select(WATER_NO_LAKE, lake.level, levelOnly); }
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
    return waterLakeLevelView(dir, heightM, samp, true);
}
fn waterLakeLevelView(dir: vec3<f32>, heightM: f32, samp: sampler, levelOnly: bool) -> f32 {
    let e = waterIndex[waterDirToCell(dir, waterParams.gridN)];
    let a = waterLakeLevelIn(e & 0x7fffu, dir, heightM, samp, levelOnly);
    if (a > WATER_NO_LAKE) { return a; }
    return waterLakeLevelIn((e >> 15u) & 0x7fffu, dir, heightM, samp, levelOnly);
}

struct WaterRiverHit {
    found: bool,          // water at the point
    near: bool,           // within the channel zone (channel + bankW) of a river
    depthM: f32,          // water depth at the point
    distM: f32,           // distance from the river line
    halfWidthM: f32,
    etaM: f32,            // the water's level there
    flow: vec3<f32>,      // flow direction (unit, along the line)
    speed: f32,
    foam: f32,
    sM: f32,              // arc length along the river (m)
    nM: f32,              // offset across (m, + left of the flow)
    river: f32,           // the river's id
    pool: f32,            // < 0 inside a lake
};

// The river (if any) at a point: the nearest segment among those listed
// there. Water where the terrain lies below the river's level inside its
// channel zone (the carve shapes banks above the level, and fills the
// hollows beside it). Terrain not carved yet (tiles still regenerating)
// shows the channel's water painted on.
fn waterRiverAt(dir: vec3<f32>, heightM: f32) -> WaterRiverHit {
    var hit: WaterRiverHit;
    hit.found = false;
    hit.near = false;
    let e = waterRiverList(dir);
    let count = min(e & 0xffu, ${RIVER_MAX_SEGS_PER_CELL}u);
    if (count == 0u) { return hit; }
    let first = e >> 8u;
    // Nearest by the traced line (cheap); its shape only for that one.
    var bestK = first;
    var bestD = 1.0e30;
    for (var k = 0u; k < count; k++) {
        let sg = waterRivers[first + k];
        let ab = sg.p1 - sg.p0;
        let t = clamp(dot(dir - sg.p0, ab) / max(dot(ab, ab), 1.0e-20), 0.0, 1.0);
        let dd = length(dir - (sg.p0 + ab * t));
        if (dd < bestD) { bestD = dd; bestK = first + k; }
    }
    let best = waterRiverPoint(waterRivers[bestK], dir);
    let zone = best.hw + waterParams.carve.y;
    if (best.d > zone) { return hit; }
    hit.near = true;
    hit.sM = best.s;
    hit.nM = best.n;
    hit.river = best.river;
    hit.pool = best.pool;
    hit.distM = best.d;
    hit.halfWidthM = best.hw;
    hit.etaM = best.wl;
    hit.speed = best.speed;
    hit.foam = best.foam;
    // Waterline of the channel profile at the water's depth h (of the
    // bank-full D): 1 - (1 - u^2)^1.5 = h / D. Only in the channel: carved
    // banks rise above the level beyond it, and terrain not carved yet must
    // not flood out to the zone's straight edge (owner 2026-10-05).
    let wf = clamp(waterParams.carve.w, 0.05, 0.99);
    let Dfull = max((best.eta - best.bed) / wf, 0.05);
    let hWater = clamp(best.wl - best.bed, 0.0, Dfull);
    let uw = sqrt(max(1.0 - pow(1.0 - hWater / Dfull, 2.0 / 3.0), 1.0e-4));
    let paint = hWater * max(0.0, 1.0 - (best.d / (uw * best.hw)) * (best.d / (uw * best.hw)));
    let depthM = select(0.0, max(best.wl - heightM, paint), best.d < best.hw);
    hit.found = depthM > 0.0;
    hit.depthM = depthM;
    let s = waterRivers[bestK];
    let ab = s.p1 - s.p0;
    let along = ab - dir * dot(ab, dir);
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

// The water's body over a bed, without its surface: the bed seen through
// the water column along the view ray (V: toward the camera), toward the
// deep water's colour.
fn waterBodyColor(
    bedColor: vec3<f32>, depthM: f32, V: vec3<f32>, up: vec3<f32>,
    lightDir: vec3<f32>, sunRadiance: vec3<f32>, skyRadiance: vec3<f32>,
) -> vec3<f32> {
    let cosV = max(dot(V, up), 0.02);
    let transmit = exp(-(depthM / cosV) * waterParams.absorption.rgb);
    let sunUp = max(dot(up, lightDir), 0.0);
    let deep = waterParams.deepColor.rgb * (skyRadiance + sunRadiance * sunUp);
    return mix(deep, bedColor, transmit);
}

// The water's surface over its body: sky reflection (Fresnel), sun glint,
// ripples near the camera. Lakes and rivers alike (owner 2026-10-06: the
// same water everywhere first; the flow's look comes with the simulation).
// rgb is added over the body, a (the Fresnel term) is how much of the body
// it hides: colour = body (1 - a) + rgb. Also drawn by the near water
// meshes (core/renderer/water/nearWaterSurface.wgsl.js).
fn waterSurfaceTerms(
    worldPos: vec3<f32>, up: vec3<f32>, cameraPos: vec3<f32>,
    lightDir: vec3<f32>, sunRadiance: vec3<f32>, skyRadiance: vec3<f32>,
) -> vec4<f32> {
    let toCam = cameraPos - worldPos;
    let dist = length(toCam);
    let V = toCam / dist;
    var N = up;
    let ripple = 1.0 - smoothstep(0.0, waterParams.rippleFade, dist);
    if (ripple > 0.001) {
        let t1 = normalize(cross(up, vec3<f32>(0.0, 1.0, 0.0001)));
        let t2 = cross(up, t1);
        let q = vec2<f32>(dot(worldPos, t1), dot(worldPos, t2)) * 0.35;
        let tm = waterParams.time;
        let g = waterNoiseGrad(q + vec2<f32>(tm * 0.11, -tm * 0.07));
        N = normalize(up + (t1 * g.x + t2 * g.y) * 0.08 * ripple);
    }
    let fres = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
    let R = reflect(-V, N);
    let spec = pow(max(dot(R, lightDir), 0.0), 600.0) * 3.0;
    return vec4<f32>(skyRadiance * waterParams.deepColor.a * fres + sunRadiance * spec, fres);
}

// Water colour over a bed: its body (the bed seen through the water column
// along the view ray) under its surface.
fn waterSurfaceColor(
    bedColor: vec3<f32>, depthM: f32, worldPos: vec3<f32>, up: vec3<f32>, cameraPos: vec3<f32>,
    lightDir: vec3<f32>, sunRadiance: vec3<f32>, skyRadiance: vec3<f32>,
) -> vec3<f32> {
    let body = waterBodyColor(bedColor, depthM, normalize(cameraPos - worldPos), up, lightDir, sunRadiance, skyRadiance);
    let s = waterSurfaceTerms(worldPos, up, cameraPos, lightDir, sunRadiance, skyRadiance);
    let col = body * (1.0 - s.a) + s.rgb;
    // Soft waterline: the first centimetres of depth fade in.
    return mix(bedColor, col, smoothstep(0.0, waterParams.shoreSoftM, depthM));
}

fn waterTint(id: f32) -> vec3<f32> {
    return fract(vec3<f32>(id * 0.618034, id * 0.381966 + 0.3, id * 0.7548777 + 0.6));
}

// How much of the static water the simulation site replaces at dir (0..1).
// How much of the static water the simulation strip replaces at a point
// (0..1), from the river there (waterRiverAt): its river, inside the
// strip's window along it and across it.
fn waterSimCover(river: WaterRiverHit) -> f32 {
    let fade = waterParams.simFade.w;
    if (fade <= 0.0 || !river.near || abs(river.river - waterParams.simRiver.x) > 0.5) { return 0.0; }
    let s0 = waterParams.simRiver.y;
    let s1 = waterParams.simRiver.z;
    let endFade = max(waterParams.simFade.x, 1.0);
    let along = smoothstep(s0, s0 + endFade, river.sM) * (1.0 - smoothstep(s1 - endFade, s1, river.sM));
    let half = waterParams.simRiver.w;
    let across = 1.0 - smoothstep(half - max(waterParams.simFade.y, 0.5), half, river.distM);
    return fade * along * across;
}

// Share of a lake's surface the near mesh draws at a camera distance (m):
// 1 closer than near.x, 0 beyond near.y, 0 with the near mesh off.
fn waterNearWeight(dist: f32) -> f32 {
    if (waterParams.near.z < 0.5) { return 0.0; }
    return 1.0 - smoothstep(waterParams.near.x, max(waterParams.near.y, waterParams.near.x + 1.0), dist);
}

// Water over a bed at a camera distance: far, the whole water; near, only
// its body (the near meshes draw the surface over it), blended by nearW.
fn waterNearFarColor(
    bedColor: vec3<f32>, depthM: f32, worldPos: vec3<f32>, up: vec3<f32>, cameraPos: vec3<f32>, dist: f32, nearW: f32,
    lightDir: vec3<f32>, sunRadiance: vec3<f32>, skyRadiance: vec3<f32>,
) -> vec3<f32> {
    var col = bedColor;
    if (nearW < 1.0) {
        col = waterSurfaceColor(bedColor, depthM, worldPos, up, cameraPos, lightDir, sunRadiance, skyRadiance);
    }
    if (nearW > 0.0) {
        let body = waterBodyColor(bedColor, depthM, (cameraPos - worldPos) / dist, up, lightDir, sunRadiance, skyRadiance);
        col = mix(col, mix(bedColor, body, smoothstep(0.0, waterParams.shoreSoftM, depthM)), nearW);
    }
    return col;
}

// Debug view 4: who draws the surface, cyan the terrain shading, magenta the near meshes.
fn waterOwnerTint(nearW: f32, depthM: f32) -> vec3<f32> {
    return mix(vec3<f32>(0.1, 0.75, 1.0), vec3<f32>(1.0, 0.2, 0.85), nearW) * mix(1.0, 0.4, clamp(depthM / 20.0, 0.0, 1.0));
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

    let river = waterRiverAt(up, heightM);
    // Where the simulation strip draws the water, the static water gives way.
    let cover = waterSimCover(river);

    // River bed and banks: wet brown soil, darker just above the waterline,
    // fading back to the terrain's own colour up the bank; not where the
    // river runs inside a lake (pool < 0). Under a lake's water too (at a
    // river's mouth), so the colour runs on across the lake's edge.
    var ground = bedColor;
    if (river.near) {
        let lum = dot(bedColor, vec3<f32>(0.30, 0.59, 0.11));
        let soil = vec3<f32>(0.42, 0.33, 0.24) * (lum / 0.33);
        let crest = river.halfWidthM + 2.0 * waterParams.bank.y;
        let w = (1.0 - smoothstep(river.halfWidthM, crest, river.distM)) * smoothstep(-1.0, 0.0, river.pool);
        let wet = 1.0 - 0.35 * (1.0 - smoothstep(0.0, 0.6, heightM - river.etaM));
        ground = mix(bedColor, soil * wet, 0.8 * w);
    }

    let dist = length(cameraPos - worldPos);
    let level = waterLakeLevelView(up, heightM, samp, dist > waterParams.riverLook.w);
    if (level > WATER_NO_LAKE) {
        let depthM = level - heightM;
        if (dbg == 1u || dbg == 2u) {
            let e = waterIndex[waterDirToCell(up, waterParams.gridN)];
            return mix(waterTint(f32(e & 0x7fffu)), vec3<f32>(0.0, 0.1, 0.6), clamp(depthM / 40.0, 0.0, 0.8));
        }
        if (dbg == 3u) { return mix(vec3<f32>(0.6, 1.0, 1.0), vec3<f32>(0.0, 0.0, 0.3), clamp(depthM / 50.0, 0.0, 1.0)); }
        // Near the camera the near mesh draws the surface (reflection, glint,
        // ripples) over this; here only the water's body, the same maths.
        let nearW = waterNearWeight(dist);
        if (dbg == 4u) { return waterOwnerTint(nearW, depthM); }
        let lakeCol = waterNearFarColor(ground, depthM, worldPos, up, cameraPos, dist, nearW, lightDir, sunRadiance, skyRadiance);
        return mix(lakeCol, ground, cover);
    }

    if (river.found) {
        if (dbg == 1u || dbg == 2u) { return mix(vec3<f32>(1.0, 0.15, 0.1), vec3<f32>(0.3, 0.0, 0.5), clamp(river.depthM / 5.0, 0.0, 1.0)); }
        if (dbg == 3u) { return mix(vec3<f32>(0.6, 1.0, 1.0), vec3<f32>(0.0, 0.0, 0.3), clamp(river.depthM / 50.0, 0.0, 1.0)); }
        // The lakes' water over the bank's soil; near the camera the river
        // ribbons draw the surface (NearWaterRenderer.js).
        let nearW = waterNearWeight(dist);
        if (dbg == 4u) { return waterOwnerTint(nearW, river.depthM); }
        let riverCol = waterNearFarColor(ground, river.depthM, worldPos, up, cameraPos, dist, nearW, lightDir, sunRadiance, skyRadiance);
        return mix(riverCol, ground, cover);
    }
    if (river.near && dbg == 0u) { return ground; }
    if (dbg == 2u) {
        let cell = waterDirToCell(up, waterParams.gridN);
        let e = waterIndex[cell];
        let n = waterParams.gridN;
        if ((e & 0x7fffu) != 0u) { return mix(bedColor, vec3<f32>(0.1, 0.4, 1.0), 0.35); }
        if (waterIndex[6u * n * n + cell] != 0u) { return mix(bedColor, vec3<f32>(1.0, 0.1, 0.05), 0.3); }
        if (((e >> 30u) & 1u) != 0u) { return mix(bedColor, vec3<f32>(1.0, 0.6, 0.0), 0.45); }
    }
    return bedColor;
}
`;
}
