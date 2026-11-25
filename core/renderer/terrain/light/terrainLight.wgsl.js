// The light the land's own shape leaves at a place (TerrainLightMap.js): sun over the mountains, open sky.
// Four maps around the camera, each four times as wide as the last, as layers of one texture array.

export const TERRAIN_LIGHT_LEVELS = 4;
export const TERRAIN_LIGHT_LEVEL_FLOATS = 16;
export const TERRAIN_LIGHT_FRAME_FLOATS = TERRAIN_LIGHT_LEVELS * TERRAIN_LIGHT_LEVEL_FLOATS + 8;

const FRAMES_WGSL = /* wgsl */`
struct LightLevel {
    e1: vec4<f32>,   // axis, extent (m)
    e2: vec4<f32>,   // axis, 1 when the map can be read
    up: vec4<f32>,   // direction of the middle, planet radius (m)
    sun: vec4<f32>,  // x share of the newer of the two suns in the map
};
struct LightFrame {
    levels: array<LightLevel, ${TERRAIN_LIGHT_LEVELS}>,
    sun: vec4<f32>,   // direction, w half the width of the shadows' edge (rad)
    info: vec4<f32>,  // x texels, y height scale (m), z level being made, w overall share
};
fn lightUv(l: LightLevel, p: vec3<f32>) -> vec2<f32> {
    let q = p * (l.up.w / max(dot(p, l.up.xyz), 1.0));
    return vec2<f32>(dot(q, l.e1.xyz), dot(q, l.e2.xyz)) / l.e1.w + 0.5;
}
fn lightDirection(l: LightLevel, uv: vec2<f32>) -> vec3<f32> {
    let xy = (uv - 0.5) * l.e1.w;
    return normalize(l.up.xyz * l.up.w + l.e1.xyz * xy.x + l.e2.xyz * xy.y);
}
`;

/** Draws the loaded tiles that touch a map, the finest last: height (m over the planet's radius). */
export const TERRAIN_LIGHT_HEIGHT_WGSL = /* wgsl */`${FRAMES_WGSL}
struct Tile { layer: u32, place: u32, xy: vec2<u32>, bounds: vec4<f32> };
@group(0) @binding(0) var<uniform> frame: LightFrame;
@group(0) @binding(1) var<storage, read> tiles: array<Tile>;
@group(0) @binding(2) var heights: texture_2d_array<f32>;
struct VsOut { @builtin(position) pos: vec4<f32>, @location(0) @interpolate(flat) index: u32 };
@vertex
fn vsMain(@builtin(vertex_index) i: u32, @builtin(instance_index) index: u32) -> VsOut {
    let corner = vec2<f32>(f32(i == 1u || i == 2u || i == 4u), f32(i == 2u || i == 4u || i == 5u));
    let b = tiles[index].bounds;
    let uv = clamp(mix(b.xy, b.zw, corner), vec2<f32>(0.0), vec2<f32>(1.0));
    return VsOut(vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - 2.0 * uv.y, 0.0, 1.0), index);
}
fn faceOf(d: vec3<f32>) -> u32 {
    let a = abs(d);
    if (a.x >= a.y && a.x >= a.z) { return select(1u, 0u, d.x > 0.0); }
    if (a.y >= a.z) { return select(3u, 2u, d.y > 0.0); }
    return select(5u, 4u, d.z > 0.0);
}
fn faceUv(face: u32, d: vec3<f32>) -> vec2<f32> {
    var s = 0.0; var t = 0.0;
    switch (face) {
        case 0u: { s = -d.z / abs(d.x); t = d.y / abs(d.x); }
        case 1u: { s = d.z / abs(d.x); t = d.y / abs(d.x); }
        case 2u: { s = d.x / abs(d.y); t = d.z / abs(d.y); }
        case 3u: { s = d.x / abs(d.y); t = -d.z / abs(d.y); }
        case 4u: { s = d.x / abs(d.z); t = d.y / abs(d.z); }
        default: { s = -d.x / abs(d.z); t = d.y / abs(d.z); }
    }
    return vec2<f32>(s, t) * 0.5 + 0.5;
}
@fragment
fn fsMain(in: VsOut) -> @location(0) vec4<f32> {
    let direction = lightDirection(frame.levels[u32(frame.info.z)], in.pos.xy / frame.info.x);
    let tile = tiles[in.index];
    let face = tile.place & 0xffu;
    let local = faceUv(face, direction) * f32(1u << (tile.place >> 8u)) - vec2<f32>(tile.xy);
    if (faceOf(direction) != face || any(local < vec2<f32>(0.0)) || any(local >= vec2<f32>(1.0))) { discard; }
    let last = vec2<i32>(textureDimensions(heights)) - 1;
    let at = local * vec2<f32>(last);
    let i = vec2<i32>(floor(at));
    let f = at - floor(at);
    let layer = i32(tile.layer);
    let h0 = mix(textureLoad(heights, i, layer, 0).r, textureLoad(heights, min(i + vec2<i32>(1, 0), last), layer, 0).r, f.x);
    let h1 = mix(textureLoad(heights, min(i + vec2<i32>(0, 1), last), layer, 0).r, textureLoad(heights, min(i + 1, last), layer, 0).r, f.x);
    return vec4<f32>(mix(h0, h1, f.y) * frame.info.y, 0.0, 0.0, 0.0);
}
`;

const MARCH_WGSL = /* wgsl */`${FRAMES_WGSL}
@group(0) @binding(0) var<uniform> frame: LightFrame;
@group(0) @binding(1) var heights: texture_2d_array<f32>;
@group(0) @binding(2) var<storage, read_write> state: array<vec4<f32>>;  // sky, older sun, newer sun
fn texel(uv: vec2<f32>, level: i32) -> f32 {
    let n = i32(frame.info.x);
    let at = uv * f32(n) - 0.5;
    let i = vec2<i32>(floor(at));
    let f = at - floor(at);
    let a = clamp(i, vec2<i32>(0), vec2<i32>(n - 1));
    let b = clamp(i + 1, vec2<i32>(0), vec2<i32>(n - 1));
    return mix(mix(textureLoad(heights, a, level, 0).r, textureLoad(heights, vec2<i32>(b.x, a.y), level, 0).r, f.x),
        mix(textureLoad(heights, vec2<i32>(a.x, b.y), level, 0).r, textureLoad(heights, b, level, 0).r, f.x), f.y);
}
// Land height (m) under a direction, from the finest map no finer than wanted that reaches there.
fn landHeight(p: vec3<f32>, wanted: i32) -> vec2<f32> {
    for (var l = wanted; l < ${TERRAIN_LIGHT_LEVELS}; l++) {
        if (frame.levels[l].e2.w < 0.5) { continue; }
        let uv = lightUv(frame.levels[l], p);
        if (all(uv > vec2<f32>(0.004)) && all(uv < vec2<f32>(0.996))) { return vec2<f32>(texel(uv, l), 1.0); }
    }
    return vec2<f32>(0.0, 0.0);
}
// How much the land rises over the level line, as a slope, at distance d along t from the place p (on the sphere, h high).
fn rise(p: vec3<f32>, h: f32, t: vec3<f32>, d: f32, first: i32) -> f32 {
    let radius = frame.levels[0].up.w;
    let base = frame.levels[0].e1.w / frame.info.x;
    let level = max(first, i32(floor(log2(max(d / (5.0 * base), 1.0)) * 0.5)));
    let q = normalize(p + t * (d / radius));
    let land = landHeight(q, min(level, ${TERRAIN_LIGHT_LEVELS - 1}));
    if (land.y < 0.5) { return -1.0; }
    // The planet falls away under the level line.
    return (land.x - h) / d - 0.5 * d / radius;
}
`;

/** Open sky, for one map; made when the land under it changes. */
export const TERRAIN_LIGHT_SKY_WGSL = /* wgsl */`${MARCH_WGSL}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let n = u32(frame.info.x);
    let level = i32(frame.info.z);
    let l = frame.levels[level];
    let p = lightDirection(l, (vec2<f32>(id.xy) + 0.5) / f32(n));
    let h = texel((vec2<f32>(id.xy) + 0.5) / f32(n), level);
    let step0 = l.e1.w / f32(n);
    var open = 0.0;
    for (var k = 0; k < 8; k++) {
        let a = (f32(k) + 0.5) * 0.785398163;
        var t = cos(a) * l.e1.xyz + sin(a) * l.e2.xyz;
        t = normalize(t - p * dot(t, p));
        var top = 0.0;
        var d = step0 * 1.2;
        for (var j = 0; j < 12; j++) {
            top = max(top, rise(p, h, t, d, level));
            d *= 1.62;
        }
        open += 1.0 / (1.0 + top * top);
    }
    let at = u32(level) * n * n + id.y * n + id.x;
    state[at] = vec4<f32>(open / 8.0, state[at].yz, 0.0);
}
`;

/** The sun over the land, for one map, and the texture the terrain reads. */
export const TERRAIN_LIGHT_SUN_WGSL = /* wgsl */`${MARCH_WGSL}
@group(0) @binding(3) var light: texture_storage_2d_array<rgba8unorm, write>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let n = u32(frame.info.x);
    let level = i32(frame.info.z);
    let l = frame.levels[level];
    let uv = (vec2<f32>(id.xy) + 0.5) / f32(n);
    let p = lightDirection(l, uv);
    let h = texel(uv, level);
    let sine = dot(frame.sun.xyz, p);
    var t = frame.sun.xyz - p * sine;
    let flat = length(t);
    t = t / max(flat, 1.0e-4);
    let slope = sine / max(flat, 1.0e-4);
    let step0 = l.e1.w / f32(n);
    var seen = 1.0;
    // Nothing on the map is this much higher than its surroundings.
    if (slope < 1.6 && slope > -0.5) {
        var d = step0 * 1.1;
        var top = -1.0;
        for (var j = 0; j < 22; j++) {
            let r = rise(p, h, t, d, level);
            // Edges soften with the distance to what casts them.
            top = max(top, r - frame.sun.w * min(1.0, step0 / d));
            d *= 1.42;
            if (d > 48000.0) { break; }
        }
        let soft = frame.sun.w * (1.0 + slope * slope);
        seen = smoothstep(-soft, soft, slope - top);
    } else if (slope <= -0.5) { seen = 0.0; }
    let at = u32(level) * n * n + id.y * n + id.x;
    let old = state[at];
    // A fresh place has no older sun.
    let before = select(old.z, seen, l.sun.y > 0.5);
    state[at] = vec4<f32>(old.x, before, seen, 0.0);
    textureStore(light, id.xy, level, vec4<f32>(before, seen, old.x, 1.0));
}
`;

/** For the terrain shader: x the sun over the land, y open sky. */
export function buildTerrainLightWGSL(group, frameBinding, textureBinding) {
    return /* wgsl */`${FRAMES_WGSL}
@group(${group}) @binding(${frameBinding}) var<uniform> landLight: LightFrame;
@group(${group}) @binding(${textureBinding}) var landLightMap: texture_2d_array<f32>;
fn landLightAt(p: vec3<f32>, s: sampler) -> vec2<f32> {
    var out = vec2<f32>(1.0, 1.0);
    var left = landLight.info.w;
    if (left <= 0.0) { return out; }
    var sum = vec2<f32>(0.0);
    for (var i = 0; i < ${TERRAIN_LIGHT_LEVELS}; i++) {
        let l = landLight.levels[i];
        if (l.e2.w < 0.5) { continue; }
        let uv = lightUv(l, p);
        let edge = max(abs(uv.x - 0.5), abs(uv.y - 0.5));
        if (edge >= 0.49 || dot(p, l.up.xyz) < 0.0) { continue; }
        let share = left * (1.0 - smoothstep(0.40, 0.485, edge));
        let m = textureSampleLevel(landLightMap, s, uv, i, 0.0);
        sum += share * vec2<f32>(mix(m.x, m.y, l.sun.x), m.z);
        left -= share;
        if (left < 0.004) { break; }
    }
    return sum + (left + 1.0 - landLight.info.w) * out;
}
`;
}
