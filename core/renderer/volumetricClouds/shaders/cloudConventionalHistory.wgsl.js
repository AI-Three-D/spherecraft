import { CLOUD_MATH_WGSL, CLOUD_UNIFORMS_WGSL } from './cloudCommon.wgsl.js';

export const CLOUD_CONVENTIONAL_HISTORY_WGSL = /* wgsl */`
${CLOUD_UNIFORMS_WGSL}${CLOUD_MATH_WGSL}
@group(0) @binding(0) var<uniform> u: CloudUniforms;
@group(0) @binding(1) var freshColor: texture_2d<f32>;
@group(0) @binding(2) var freshDepth: texture_2d<f32>;
@group(0) @binding(3) var previousColor: texture_2d<f32>;
@group(0) @binding(4) var previousDepth: texture_2d<f32>;
@group(0) @binding(5) var resolvedColor: texture_storage_2d<rgba16float, write>;
@group(0) @binding(6) var resolvedDepth: texture_storage_2d<r32float, write>;

fn toClipSpace(c: vec4f) -> vec4f {
    let co = c.r - c.b;
    let middle = c.b + 0.5 * co;
    let cg = c.g - middle;
    return vec4f(middle + 0.5 * cg, co, cg, c.a);
}

fn fromClipSpace(c: vec4f) -> vec4f {
    let middle = c.x - 0.5 * c.z;
    let b = middle - 0.5 * c.y;
    return vec4f(max(vec3f(b + c.y, middle + c.z, b), vec3f(0.0)), c.a);
}

fn resolveCloud(pi: vec2i, size: vec2i, depth: f32, current: vec4f) -> vec4f {
    // Keep fresh samples along terrain and where a ray has lost the cloud it used to see.
    if (u.historyMotion.z < 1.5 || depth <= 0.0 || depth >= FAR_DEPTH || current.a > 0.99) { return current; }
    let pixel = vec2f(pi) + 0.5;
    let rd = cameraRay(pixel, vec2f(size), u.camRight, u.camUp, u.camBack, u.frameInfo.x);
    let v = rd * depth + u.prevInfo.yzw + u.historyWind.xyz;
    let z = -dot(v, u.prevBack.xyz);
    if (z < 0.001) { return current; }
    let ndc = vec2f(u.prevRight.w * dot(v, u.prevRight.xyz) / z - u.prevBack.w,
        u.prevUp.w * dot(v, u.prevUp.xyz) / z - u.prevInfo.x);
    let pp = (ndc * vec2f(0.5, -0.5) + 0.5) * vec2f(size);
    if (any(pp < vec2f(0.5)) || any(pp > vec2f(size) - 0.5)) { return current; }

    let flow = length(pp - pixel);
    let motionWeight = 1.0 - smoothstep(0.25, 1.0, flow);
    if (motionWeight < 0.04) { return current; }
    let expected = length(v);
    let tolerance = max(0.12, expected * 0.055);
    let origin = vec2i(floor(pp - 0.5));
    let f = fract(pp - 0.5);
    let corners = array<vec2i, 4>(vec2i(0, 0), vec2i(1, 0), vec2i(0, 1), vec2i(1, 1));
    var old = vec4f(0.0);
    var confidence = 0.0;
    for (var i = 0; i < 4; i++) {
        let corner = corners[i];
        let q = min(origin + corner, size - 1);
        let previous = textureLoad(previousDepth, q, 0).r;
        if (previous <= 0.0 || previous >= FAR_DEPTH) { continue; }
        let depthWeight = 1.0 - smoothstep(tolerance * 0.43, tolerance, abs(previous - expected));
        let w = mix(1.0 - f, f, vec2f(corner));
        let weight = w.x * w.y * depthWeight;
        if (weight <= 0.001) { continue; }
        old += textureLoad(previousColor, q, 0) * weight;
        confidence += weight;
    }
    if (confidence < 0.06) { return current; }
    old /= confidence;
    let opacityWeight = 1.0 - smoothstep(0.025, 0.16, abs(old.a - current.a));
    let weight = 0.77 * motionWeight * opacityWeight * confidence;
    if (weight < 0.025) { return current; }

    // Clamp premultiplied luminance, chroma and transmittance before blending.
    let center = toClipSpace(current);
    var total = center;
    var squares = center * center;
    var lo = center;
    var hi = center;
    let offsets = array<vec2i, 4>(vec2i(1, 0), vec2i(-1, 0), vec2i(0, 1), vec2i(0, -1));
    for (var i = 0; i < 4; i++) {
        let q = clamp(pi + offsets[i], vec2i(0), size - 1);
        let c = toClipSpace(textureLoad(freshColor, q, 0));
        total += c;
        squares += c * c;
        lo = min(lo, c);
        hi = max(hi, c);
    }
    let mean = total * 0.2;
    let spread = 1.25 * sqrt(max(squares * 0.2 - mean * mean, vec4f(0.0)));
    let clipped = clamp(toClipSpace(old), min(center, max(lo, mean - spread)), max(center, min(hi, mean + spread)));
    let movingEdge = (hi.a - lo.a) * smoothstep(0.12, 0.5, flow);
    return mix(current, fromClipSpace(clipped), weight * (1.0 - smoothstep(0.06, 0.24, movingEdge)));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let size = vec2i(textureDimensions(freshColor));
    let pi = vec2i(id.xy);
    if (any(pi >= size)) { return; }
    let depth = textureLoad(freshDepth, pi, 0).r;
    let color = textureLoad(freshColor, pi, 0);
    textureStore(resolvedDepth, pi, vec4f(depth));
    textureStore(resolvedColor, pi, resolveCloud(pi, size, depth, color));
}
`;
