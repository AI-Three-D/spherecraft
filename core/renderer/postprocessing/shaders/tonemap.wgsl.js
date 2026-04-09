// core/renderer/postprocessing/shaders/tonemap.wgsl.js
//
// ACES filmic tone mapping + sRGB gamma. Reads an HDR rgba16float texture
// and writes LDR output suitable for the swap chain.

import { fullscreenQuadVertexWGSL } from './fullscreenQuad.wgsl.js';

export function buildTonemapWGSL() {
    return /* wgsl */`
${fullscreenQuadVertexWGSL}

struct TonemapParams {
    exposure: f32,
    _pad0: f32,
    _pad1: f32,
    _pad2: f32,
};

@group(0) @binding(0) var hdrTexture: texture_2d<f32>;
@group(0) @binding(1) var hdrSampler: sampler;
@group(0) @binding(2) var<uniform> params: TonemapParams;

// Narkowicz ACES fit — compact and well-behaved for real-time.
fn acesTonemap(x: vec3<f32>) -> vec3<f32> {
    let a = 2.51;
    let b = 0.03;
    let c = 2.43;
    let d = 0.59;
    let e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3(0.0), vec3(1.0));
}

fn linearToSrgb(c: vec3<f32>) -> vec3<f32> {
    // Piecewise sRGB transfer function.
    let lo = c * 12.92;
    let hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - vec3(0.055);
    return select(hi, lo, c <= vec3(0.0031308));
}

@fragment
fn fs_tonemap(in: FullscreenVsOut) -> @location(0) vec4<f32> {
    let hdr = max(textureSample(hdrTexture, hdrSampler, in.uv).rgb, vec3<f32>(0.0));

    let exposed = hdr * params.exposure;
    let mapped  = acesTonemap(exposed);
    let srgb    = linearToSrgb(mapped);

    return vec4<f32>(srgb, 1.0);
}
`;
}
