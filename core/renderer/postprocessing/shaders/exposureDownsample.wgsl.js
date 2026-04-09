// core/renderer/postprocessing/shaders/exposureDownsample.wgsl.js
//
// Builds a log-luminance mip chain from the HDR scene. The first pass samples
// the HDR scene color; later passes downsample the previous luminance mip.

import { fullscreenQuadVertexWGSL } from './fullscreenQuad.wgsl.js';

export function buildExposureDownsampleWGSL() {
    return /* wgsl */`
${fullscreenQuadVertexWGSL}

struct ExposureDownsampleParams {
    texelSize: vec2<f32>,
    isFirstPass: u32,
    _pad0: u32,
};

@group(0) @binding(0) var srcTexture: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;
@group(0) @binding(2) var<uniform> params: ExposureDownsampleParams;

fn luminance(c: vec3<f32>) -> f32 {
    return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

fn sampleValue(uv: vec2<f32>) -> f32 {
    let sampleColor = textureSample(srcTexture, srcSampler, uv).rgb;
    if (params.isFirstPass == 1u) {
        return log(max(luminance(sampleColor), 1e-4));
    }
    return sampleColor.r;
}

@fragment
fn fs_downsample(in: FullscreenVsOut) -> @location(0) vec4<f32> {
    let ts = params.texelSize;
    let uv = in.uv;

    let a = sampleValue(uv + vec2<f32>(-0.5, -0.5) * ts);
    let b = sampleValue(uv + vec2<f32>( 0.5, -0.5) * ts);
    let c = sampleValue(uv + vec2<f32>(-0.5,  0.5) * ts);
    let d = sampleValue(uv + vec2<f32>( 0.5,  0.5) * ts);
    let avg = (a + b + c + d) * 0.25;

    return vec4<f32>(avg, avg, avg, 1.0);
}
`;
}
