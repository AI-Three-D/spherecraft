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
    night: f32,          // 0 day .. 1 full night
    nightGrade: f32,     // how far colour moves toward night vision at full night (0..1)
    nightExposure: f32,  // exposure change at full night (+1 = twice as bright, -0.2 = 20 % darker)
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

    var exposed = hdr * params.exposure;
    // Night vision: as the light fails, colour drains and what is left shifts toward blue (the rods'
    // response peaks in blue-green and is blind to red). Without it a moonlit scene rendered as dim
    // daylight, with the warm daytime colours of clouds and ground intact.
    if (params.night > 0.0) {
        let rods = dot(exposed, vec3<f32>(0.05, 0.55, 0.40));
        let nightColor = vec3<f32>(rods) * vec3<f32>(0.70, 0.92, 1.35);
        exposed = mix(exposed, nightColor, params.night * params.nightGrade)
            * max(1.0 + params.night * params.nightExposure, 0.05);
    }
    let mapped  = acesTonemap(exposed);
    let srgb    = linearToSrgb(mapped);

    return vec4<f32>(srgb, 1.0);
}
`;
}
