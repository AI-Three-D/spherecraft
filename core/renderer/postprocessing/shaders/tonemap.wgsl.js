// core/renderer/postprocessing/shaders/tonemap.wgsl.js
//
// Configurable filmic tone mapping + sRGB gamma. Reads an HDR rgba16float
// texture and writes LDR output suitable for the swap chain.

import { fullscreenQuadVertexWGSL } from './fullscreenQuad.wgsl.js';

export function buildTonemapWGSL() {
    return /* wgsl */`
${fullscreenQuadVertexWGSL}

struct TonemapParams {
    manualExposure: f32,
    autoExposureEnabled: f32,
    contrast: f32,
    toe: f32,
    shoulder: f32,
    whitePoint: f32,
    highlightSaturation: f32,
    _pad0: f32,
};

@group(0) @binding(0) var hdrTexture: texture_2d<f32>;
@group(0) @binding(1) var hdrSampler: sampler;
@group(0) @binding(2) var exposureTexture: texture_2d<f32>;
@group(0) @binding(3) var<uniform> params: TonemapParams;

// Narkowicz ACES fit — compact and well-behaved for real-time.
fn acesTonemap(x: vec3<f32>) -> vec3<f32> {
    let a = 2.51;
    let b = 0.03;
    let c = 2.43;
    let d = 0.59;
    let e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3(0.0), vec3(1.0));
}

fn luminance(c: vec3<f32>) -> f32 {
    return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

fn applyShoulder(x: vec3<f32>, shoulder: f32) -> vec3<f32> {
    let exponent = mix(1.35, 0.65, clamp(shoulder, 0.0, 1.0));
    return clamp(
        vec3<f32>(1.0) - pow(max(vec3<f32>(1.0) - x, vec3<f32>(0.0)), vec3<f32>(exponent)),
        vec3<f32>(0.0),
        vec3<f32>(1.0)
    );
}

fn applyToneControls(x: vec3<f32>, contrast: f32, toe: f32) -> vec3<f32> {
    let toeAmount = clamp(toe, 0.0, 0.35);
    let toeAdjusted = max(x - vec3<f32>(toeAmount), vec3<f32>(0.0))
        / max(vec3<f32>(1.0 - toeAmount), vec3<f32>(1e-4));
    let pivot = vec3<f32>(0.18);
    let contrasted = pow(
        max(toeAdjusted / pivot, vec3<f32>(1e-4)),
        vec3<f32>(max(0.5, contrast))
    ) * pivot;
    return clamp(contrasted, vec3<f32>(0.0), vec3<f32>(1.0));
}

fn applyHighlightSaturation(color: vec3<f32>, highlightSaturation: f32) -> vec3<f32> {
    let lum = luminance(color);
    let highlightMix = smoothstep(0.55, 1.0, lum);
    let saturation = clamp(highlightSaturation, 0.0, 1.25);
    let grey = vec3<f32>(lum);
    let adjusted = mix(grey, color, saturation);
    return clamp(mix(color, adjusted, highlightMix), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn linearToSrgb(c: vec3<f32>) -> vec3<f32> {
    // Piecewise sRGB transfer function.
    let linear = max(c, vec3<f32>(0.0));
    let lo = linear * 12.92;
    let hi = 1.055 * pow(linear, vec3<f32>(1.0 / 2.4)) - vec3<f32>(0.055);
    return select(hi, lo, linear <= vec3<f32>(0.0031308));
}

@fragment
fn fs_tonemap(in: FullscreenVsOut) -> @location(0) vec4<f32> {
    let hdr = max(textureSample(hdrTexture, hdrSampler, in.uv).rgb, vec3<f32>(0.0));

    var exposure = params.manualExposure;
    if (params.autoExposureEnabled > 0.5) {
        exposure = max(textureSample(exposureTexture, hdrSampler, vec2<f32>(0.5, 0.5)).r, 1e-4);
    }

    let exposed = hdr * exposure;
    let whiteScale = 4.0 / max(params.whitePoint, 0.25);
    var mapped = acesTonemap(exposed * whiteScale);
    mapped = applyShoulder(mapped, params.shoulder);
    mapped = applyToneControls(mapped, params.contrast, params.toe);
    mapped = applyHighlightSaturation(mapped, params.highlightSaturation);
    let srgb = linearToSrgb(mapped);

    return vec4<f32>(srgb, 1.0);
}
`;
}
