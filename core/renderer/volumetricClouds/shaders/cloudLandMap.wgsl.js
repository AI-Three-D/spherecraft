/** A map of the land around the camera: tangent plane at an anchor, gnomonic, so a point maps by its direction alone. */
export const LAND_FRAME_WGSL = /* wgsl */`
struct LandFrame {
    e1: vec4f,   // xyz axis, w extent (km)
    e2: vec4f,   // xyz axis, w height of the stored zero (km above the planet radius)
    up: vec4f,   // xyz anchor direction, w planet radius (km)
    info: vec4f, // x terrain height scale (km), y size (texels), w valid
}

fn landUv(frame: LandFrame, p: vec3f) -> vec2f {
    let q = p * (frame.up.w / max(dot(p, frame.up.xyz), 1.0e-3));
    return vec2f(dot(q, frame.e1.xyz), dot(q, frame.e2.xyz)) / frame.e1.w + 0.5;
}

fn landDirection(frame: LandFrame, uv: vec2f) -> vec3f {
    let xy = (uv - 0.5) * frame.e1.w;
    return normalize(frame.up.xyz * frame.up.w + frame.e1.xyz * xy.x + frame.e2.xyz * xy.y);
}
`;

const ranges = (tile, list) => list.map(([lo, hi]) => `(${tile} >= ${lo}u && ${tile} <= ${hi}u)`).join(' || ') || 'false';

// Draws every loaded tile that touches the map, the finest last: height (km above the stored zero), wetland, forest, loaded.
/** wet, forest: lists of [first, last] tile ids. */
export function buildLandMapShader({ wet, forest }) {
    return /* wgsl */`${LAND_FRAME_WGSL}
struct Tile {
    layer: u32,
    place: u32, // face | depth << 8
    xy: vec2u,
    bounds: vec4f, // on the map
}
@group(0) @binding(0) var<uniform> frame: LandFrame;
@group(0) @binding(1) var<storage, read> tiles: array<Tile>;
@group(0) @binding(2) var heights: texture_2d_array<f32>;
@group(0) @binding(3) var tileIds: texture_2d_array<f32>;

struct VsOut {
    @builtin(position) pos: vec4f,
    @location(0) @interpolate(flat) index: u32,
}

@vertex
fn vsMain(@builtin(vertex_index) i: u32, @builtin(instance_index) index: u32) -> VsOut {
    let corner = vec2f(f32(i == 1u || i == 2u || i == 4u), f32(i == 2u || i == 4u || i == 5u));
    let bounds = tiles[index].bounds;
    let uv = clamp(mix(bounds.xy, bounds.zw, corner), vec2f(0.0), vec2f(1.0));
    return VsOut(vec4f(uv.x * 2.0 - 1.0, 1.0 - 2.0 * uv.y, 0.0, 1.0), index);
}

fn faceOf(d: vec3f) -> u32 {
    let a = abs(d);
    if (a.x >= a.y && a.x >= a.z) { return select(1u, 0u, d.x > 0.0); }
    if (a.y >= a.z) { return select(3u, 2u, d.y > 0.0); }
    return select(5u, 4u, d.z > 0.0);
}

fn faceUv(face: u32, d: vec3f) -> vec2f {
    var s = 0.0;
    var t = 0.0;
    switch (face) {
        case 0u: { s = -d.z / abs(d.x); t = d.y / abs(d.x); }
        case 1u: { s = d.z / abs(d.x); t = d.y / abs(d.x); }
        case 2u: { s = d.x / abs(d.y); t = d.z / abs(d.y); }
        case 3u: { s = d.x / abs(d.y); t = -d.z / abs(d.y); }
        case 4u: { s = d.x / abs(d.z); t = d.y / abs(d.z); }
        default: { s = -d.x / abs(d.z); t = d.y / abs(d.z); }
    }
    return vec2f(s, t) * 0.5 + 0.5;
}

@fragment
fn fsMain(input: VsOut) -> @location(0) vec4f {
    let direction = landDirection(frame, input.pos.xy / frame.info.y);
    let tile = tiles[input.index];
    let face = tile.place & 0xffu;
    if (faceOf(direction) != face) { discard; }
    let local = faceUv(face, direction) * f32(1u << (tile.place >> 8u)) - vec2f(tile.xy);
    if (any(local < vec2f(0.0)) || any(local >= vec2f(1.0))) { discard; }
    // The terrain's vertices sample from the first texel to the last.
    let last = vec2i(textureDimensions(heights)) - 1;
    let at = local * vec2f(last);
    let i = vec2i(floor(at));
    let f = at - floor(at);
    let layer = i32(tile.layer);
    let h0 = mix(textureLoad(heights, i, layer, 0).r, textureLoad(heights, min(i + vec2i(1, 0), last), layer, 0).r, f.x);
    let h1 = mix(textureLoad(heights, min(i + vec2i(0, 1), last), layer, 0).r, textureLoad(heights, min(i + 1, last), layer, 0).r, f.x);
    let height = mix(h0, h1, f.y) * frame.info.x;
    let id = u32(textureLoad(tileIds, vec2i(local * vec2f(textureDimensions(tileIds))), layer, 0).r * 255.0 + 0.5);
    let wet = ${ranges('id', wet)};
    let forest = ${ranges('id', forest)};
    return vec4f(height - frame.e2.w, f32(wet), f32(forest), 1.0);
}
`;
}

const FILTER_HEADER_WGSL = /* wgsl */`${LAND_FRAME_WGSL}
@group(0) @binding(0) var<uniform> frame: LandFrame;
@group(0) @binding(1) var raw: texture_2d<f32>;
@group(0) @binding(2) var outMap: texture_storage_2d<rgba16float, write>;

fn at(p: vec2i) -> vec4f { return textureLoad(raw, clamp(p, vec2i(0), vec2i(textureDimensions(raw)) - 1), 0); }
`;

// Near map: height averaged over 3 x 3 texels, wetland and forest over about 80 m, hollows (km below the surroundings).
export const CLOUD_LAND_GROUND_WGSL = /* wgsl */`${FILTER_HEADER_WGSL}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let p = vec2i(id.xy);
    if (any(id.xy >= textureDimensions(raw))) { return; }
    var sum = vec4f(0.0);
    var weight = 0.0;
    for (var y = -4; y <= 4; y++) {
        for (var x = -4; x <= 4; x++) {
            let r2 = f32(x * x + y * y);
            if (r2 > 17.0) { continue; }
            let w = exp(-r2 / 8.0);
            sum += at(p + vec2i(x, y)) * w;
            weight += w;
        }
    }
    sum /= weight;
    var ring = 0.0;
    for (var i = 0; i < 12; i++) {
        let angle = f32(i) * 0.5236;
        ring += at(p + vec2i(round(vec2f(cos(angle), sin(angle)) * 12.0))).r / 12.0;
    }
    let near = (at(p).r * 2.0 + at(p + vec2i(1, 0)).r + at(p - vec2i(1, 0)).r + at(p + vec2i(0, 1)).r + at(p - vec2i(0, 1)).r) / 6.0;
    textureStore(outMap, p, vec4f(near, sum.g, sum.b, max(0.0, ring - sum.r) * at(p).a));
}
`;

// Wide map: x the peaks (soft maximum within about 2 km), y the land around (mean over 4 to 8 km).
export const CLOUD_LAND_RELIEF_WGSL = /* wgsl */`${FILTER_HEADER_WGSL}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let p = vec2i(id.xy);
    if (any(id.xy >= textureDimensions(raw))) { return; }
    var mean = 0.0;
    var weight = 0.0;
    var peak = 0.0;
    var peakWeight = 0.0;
    for (var y = -4; y <= 4; y++) {
        for (var x = -4; x <= 4; x++) {
            let r2 = f32(x * x + y * y);
            if (r2 > 17.0) { continue; }
            let height = at(p + vec2i(x, y)).r;
            let w = exp(-r2 / 8.0);
            mean += height * w;
            weight += w;
            // Smooth where the highest sample changes.
            let pw = exp(6.0 * height) * w;
            peak += height * pw;
            peakWeight += pw;
        }
    }
    var ring = 0.0;
    for (var i = 0; i < 12; i++) {
        let angle = f32(i) * 0.5236;
        ring += at(p + vec2i(round(vec2f(cos(angle), sin(angle)) * (8.0 + 8.0 * f32(i & 1))))).r / 12.0;
    }
    textureStore(outMap, p, vec4f(peak / peakWeight, mix(ring, mean / weight, 0.3), 0.0, 0.0));
}
`;

// Mountains: x height, y how much fog may lie there, zw slope (km per km along the axes of the frame).
export const CLOUD_LAND_SLOPES_WGSL = /* wgsl */`${FILTER_HEADER_WGSL}
@group(0) @binding(3) var<uniform> wide: LandFrame;
@group(0) @binding(4) var relief: texture_2d<f32>;
@group(0) @binding(5) var linearSampler: sampler;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let p = vec2i(id.xy);
    let size = textureDimensions(raw);
    if (any(id.xy >= size)) { return; }
    let texel = frame.e1.w / frame.info.y;
    let left = at(p - vec2i(1, 0)).r;
    let right = at(p + vec2i(1, 0)).r;
    let above = at(p - vec2i(0, 1)).r;
    let below = at(p + vec2i(0, 1)).r;
    let height = at(p).r;
    let slope = vec2f(right - left, below - above) / (2.0 * texel);
    let uv = landUv(wide, landDirection(frame, (vec2f(id.xy) + 0.5) / vec2f(size)) * wide.up.w);
    let around = textureSampleLevel(relief, linearSampler, uv, 0.0).xy + wide.e2.w - frame.e2.w;
    let tall = around.x - around.y;
    let part = (height - around.y) / max(tall, 0.05);
    // On what stands out of the land, from its foot up. How high up decides where the fog lies (slopeAt).
    let weight = smoothstep(0.25, 0.6, tall) * smoothstep(-0.25, 0.05, part) * at(p).a;
    textureStore(outMap, p, vec4f(height, weight, slope));
}
`;
