import { CLOUD_MATH_WGSL, CLOUD_UNIFORMS_WGSL, buildCloudRayInput } from './cloudCommon.wgsl.js';

// Entry points of the raymarch for the two traced parts of a frame (CloudRayPairs.js): every second ray in a
// checkerboard, packed to half width, then the rays that CLOUD_RAY_PAIRS_WGSL could not fill in.
export const CLOUD_RAY_PAIR_ENTRIES_WGSL = /* wgsl */`
@group(0) @binding(18) var<storage, read> rayList: array<u32>;

@compute @workgroup_size(4, 8)
fn mainChecker(@builtin(global_invocation_id) id: vec3u) {
    let pixel = vec2u(2u * id.x + (id.y & 1u), id.y);
    if (any(pixel >= vec2u(u.frameInfo.zw))) { return; }
    traceAndStore(pixel, cloudRay(pixel), id.xy);
}

@compute @workgroup_size(32)
fn mainList(@builtin(global_invocation_id) id: vec3u) {
    if (id.x >= rayList[3]) { return; }
    let entry = rayList[4u + id.x];
    let pixel = vec2u(entry & 0xffffu, entry >> 16u);
    traceAndStore(pixel, cloudRay(pixel), pixel);
}
`;

// Fills the rays between the checkerboard. The marcher filters density over about five pixels, so most of them are
// the mean of their four neighbours. A ray is listed for tracing where the horizontal and vertical means disagree,
// the neighbours differ much in opacity, light or depth, or terrain is involved.
export const CLOUD_RAY_PAIRS_WGSL = /* wgsl */`
${CLOUD_UNIFORMS_WGSL}${CLOUD_MATH_WGSL}
@group(0) @binding(0) var<uniform> u: CloudUniforms;
@group(0) @binding(1) var colorIn: texture_2d<f32>;
@group(0) @binding(2) var depthIn: texture_2d<f32>;
@group(0) @binding(3) var sceneDepth: texture_depth_2d;
@group(0) @binding(4) var outColor: texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var outDepth: texture_storage_2d<r32float, write>;
struct RayList {
    groups: array<atomic<u32>, 3>, // indirect dispatch
    count: atomic<u32>,
    rays: array<u32>,
}
@group(0) @binding(6) var<storage, read_write> list: RayList;
@group(0) @binding(7) var depthSampler: sampler;
${buildCloudRayInput(true)}

// Error allowed in light and transmittance, as a share of a fully opaque cloud here.
override TOLERANCE: f32 = 0.015;
// Its growth per kilometre of cloud distance.
override FAR_TOLERANCE: f32 = 0.0;
override MAX_SPREAD: f32 = 0.2;
// Fills in every ray and lists none (lower detail tiers): tracing even a few more waits for the longest of them.
override FILL_ALL: bool = false;

fn maxOf(v: vec4f) -> f32 { return max(max(v.x, v.y), max(v.z, v.w)); }
fn minOf(v: vec4f) -> f32 { return min(min(v.x, v.y), min(v.z, v.w)); }
fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }

// Scene distance at the centre of a cloud pixel.
fn centreDistance(pixel: vec2u, size: vec2u) -> f32 {
    let dims = textureDimensions(sceneDepth);
    let z = textureLoad(sceneDepth, min(((2u * pixel + 1u) * dims) / (2u * size), dims - 1u), 0);
    if (z >= 1.0) { return 1.0e30; }
    return u.sceneDepth.y / (z + u.sceneDepth.x) * u.sceneDepth.z;
}

struct Neighbour {
    color: vec4f,
    depth: f32,
    weight: f32, // 0 for the other kind (sky or terrain) and outside the picture
}

fn neighbour(q: vec2i, size: vec2u, land: bool, view: f32) -> Neighbour {
    if (any(q < vec2i(0)) || any(q >= vec2i(size))) { return Neighbour(vec4f(0.0), 0.0, 0.0); }
    let packed = vec2i(q.x >> 1u, q.y);
    let depth = textureLoad(depthIn, packed, 0).r;
    if ((depth < 0.0) != land) { return Neighbour(vec4f(0.0), 0.0, 0.0); }
    var weight = 1.0;
    // Beside terrain, its distance counts as well.
    if (land) { weight = exp(-8.0 * abs(log(centreDistance(vec2u(q), size) / view))) + 1.0e-4; }
    return Neighbour(textureLoad(colorIn, packed, 0), abs(depth), weight);
}

// Two opposite neighbours; the weight is small where they differ.
fn along(a: Neighbour, b: Neighbour) -> Neighbour {
    let w = a.weight + b.weight;
    if (w <= 0.0) { return a; }
    var color = (a.color * a.weight + b.color * b.weight) / w;
    let solid = vec2f(a.weight, b.weight) * max(vec2f(1.0 - a.color.a, 1.0 - b.color.a), vec2f(1.0e-4));
    let depth = dot(solid, vec2f(a.depth, b.depth)) / (solid.x + solid.y);
    if (a.weight <= 0.0 || b.weight <= 0.0) { return Neighbour(color, depth, 0.5 * w); }
    let miss = abs(a.color - b.color);
    let scale = max(1.0e-3, luma(a.color.rgb) + luma(b.color.rgb));
    let difference = max(max(miss.r, max(miss.g, miss.b)) / scale, miss.a);
    return Neighbour(color, depth, w / (difference * difference + 1.0e-4));
}

// Fills a ray in from the traced ones of its own kind, along the direction that agrees better: averaged across a sharp
// edge, every second pixel beside it would stand out as a tooth.
fn fillOdd(pixel: vec2u, size: vec2u) {
    let pi = vec2i(pixel);
    let own = cloudRay(pixel);
    let land = own.sceneDistance < FAR_DEPTH;
    let view = own.sceneDistance * max(-dot(own.direction, u.camBack.xyz), 1.0e-4);
    let across = along(neighbour(pi - vec2i(1, 0), size, land, view), neighbour(pi + vec2i(1, 0), size, land, view));
    let down = along(neighbour(pi - vec2i(0, 1), size, land, view), neighbour(pi + vec2i(0, 1), size, land, view));
    var weights = vec2f(across.weight, down.weight);
    let gap = abs(across.color - down.color);
    if (min(weights.x, weights.y) > 0.0
        && max(gap.a, max(gap.r, max(gap.g, gap.b)) / max(1.0e-3, luma(across.color.rgb) + luma(down.color.rgb))) > 0.02) {
        // Each pair may agree with itself and not with the other: a line one ray wide. It runs along the pair that stands
        // out from the rays around, and would be a row of dots otherwise.
        var around = vec4f(0.0);
        var count = 1.0e-6;
        for (var i = 0; i < 8; i++) {
            let side = vec2i(i & 1, (i >> 1) & 1) * 2 - 1;
            let n = neighbour(pi + select(vec2i(side.x * 2, side.y), vec2i(side.x, side.y * 2), i >= 4), size, land, view);
            around += n.color * n.weight;
            count += n.weight;
        }
        let out = vec2f(distance(across.color, around / count), distance(down.color, around / count));
        weights *= out * out + 1.0e-6;
    }
    var color = across.color * weights.x + down.color * weights.y;
    var depth = across.depth * weights.x + down.depth * weights.y;
    var total = weights.x + weights.y;
    // No neighbour of the same kind: the next eight traced rays.
    for (var i = 0; i < 8 && across.weight + down.weight <= 0.0; i++) {
        let side = vec2i(i & 1, (i >> 1) & 1) * 2 - 1;
        let n = neighbour(pi + select(vec2i(side.x * 2, side.y), vec2i(side.x, side.y * 2), i >= 4), size, land, view);
        color += n.color * n.weight;
        depth += n.depth * n.weight;
        total += n.weight;
    }
    if (total <= 0.0) {
        // A lone spike of terrain, or a lone gap in it.
        color = vec4f(0.0, 0.0, 0.0, 1.0);
        depth = min(own.sceneDistance, FAR_DEPTH);
        total = 1.0;
    }
    textureStore(outColor, pi, color / total);
    textureStore(outDepth, pi, vec4f(select(depth / total, -max(depth / total, 0.001), land)));
}

// Copies a traced ray or fills one in. True if the ray has to be traced.
fn resolvePair(pixel: vec2u) -> bool {
    let size = vec2u(u.frameInfo.zw);
    if (any(pixel >= size)) { return false; }
    let pi = vec2i(pixel);
    if (((pixel.x + pixel.y) & 1u) == 0u) {
        let q = vec2i(pi.x >> 1u, pi.y);
        textureStore(outColor, pi, textureLoad(colorIn, q, 0));
        textureStore(outDepth, pi, textureLoad(depthIn, q, 0));
        return false;
    }
    if (FILL_ALL) {
        fillOdd(pixel, size);
        return false;
    }
    if (any(pixel == vec2u(0u)) || any(pixel + 1u >= size)) { return true; }
    let left = vec2i((pi.x - 1) >> 1u, pi.y);
    let right = vec2i((pi.x + 1) >> 1u, pi.y);
    let above = vec2i(pi.x >> 1u, pi.y - 1);
    let below = vec2i(pi.x >> 1u, pi.y + 1);
    let cl = textureLoad(colorIn, left, 0);
    let cr = textureLoad(colorIn, right, 0);
    let ca = textureLoad(colorIn, above, 0);
    let cb = textureLoad(colorIn, below, 0);
    let depths = vec4f(textureLoad(depthIn, left, 0).r, textureLoad(depthIn, right, 0).r,
        textureLoad(depthIn, above, 0).r, textureLoad(depthIn, below, 0).r);
    let own = cloudRay(pixel);
    let land = own.sceneDistance < FAR_DEPTH;
    if (any((depths < vec4f(0.0)) != vec4<bool>(land))) { return true; }
    if (land) {
        // Terrain cuts rays short. Fill in only where its distance is about the same around the pixel.
        let view = own.sceneDistance * max(-dot(own.direction, u.camBack.xyz), 1.0e-4);
        let near = vec4f(centreDistance(pixel - vec2u(1u, 0u), size), centreDistance(pixel + vec2u(1u, 0u), size),
            centreDistance(pixel - vec2u(0u, 1u), size), centreDistance(pixel + vec2u(0u, 1u), size));
        if (maxOf(near) > 1.25 * minOf(near) || view > 1.03 * maxOf(near) || view < 0.88 * minOf(near)) { return true; }
    }
    let T = vec4f(cl.a, cr.a, ca.a, cb.a);
    if (minOf(T) < 0.9995) {
        let light = vec4f(luma(cl.rgb), luma(cr.rgb), luma(ca.rgb), luma(cb.rgb));
        let scale = maxOf(light / max(1.0 - T, vec4f(0.05)));
        let miss = abs(cl + cr - ca - cb) * 0.5;
        let tolerance = TOLERANCE * (1.0 + FAR_TOLERANCE * min(maxOf(abs(depths)), 60.0));
        if (max(miss.r, max(miss.g, miss.b)) > tolerance * scale || miss.a > tolerance
            || maxOf(T) - minOf(T) > MAX_SPREAD || maxOf(light) - minOf(light) > MAX_SPREAD * scale) { return true; }
        if (maxOf(T) < 0.98) {
            let d = abs(depths);
            if (abs(d.x + d.y - d.z - d.w) > 0.04 * (d.x + d.y) || maxOf(d) - minOf(d) > 0.2 * maxOf(d)) { return true; }
        }
    }
    textureStore(outColor, pi, 0.25 * (cl + cr + ca + cb));
    textureStore(outDepth, pi, vec4f(0.25 * (depths.x + depths.y + depths.z + depths.w)));
    return false;
}

// Each tile appends its rays together, so that the listed rays stay coherent.
var<workgroup> tileCount: atomic<u32>;
var<workgroup> tileBase: u32;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3u, @builtin(local_invocation_index) lane: u32) {
    let listed = resolvePair(id.xy);
    var slot = 0u;
    if (listed) { slot = atomicAdd(&tileCount, 1u); }
    workgroupBarrier();
    if (lane == 0u) {
        let n = atomicLoad(&tileCount);
        if (n > 0u) {
            tileBase = atomicAdd(&list.count, n);
            atomicMax(&list.groups[0], (tileBase + n + 31u) / 32u);
        }
    }
    let base = workgroupUniformLoad(&tileBase);
    if (listed) { list.rays[base + slot] = id.x | (id.y << 16u); }
}
`;
