// core/renderer/postprocessing/shaders/bloomUpsample.wgsl.js
//
// Progressive upsample with 9-tap tent filter. Blends the upsampled lower mip
// additively with the current mip level.

import { fullscreenQuadVertexWGSL } from './fullscreenQuad.wgsl.js';

export function buildBloomUpsampleWGSL() {
    return /* wgsl */`
${fullscreenQuadVertexWGSL}

struct BloomUpsampleParams {
    texelSize: vec2<f32>,   // 1.0 / source (lower-mip) resolution
    blendFactor: f32,       // mix factor for progressive upsample (typically 0.5-0.7)
    _pad0: f32,
};

@group(0) @binding(0) var srcTexture: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;
@group(0) @binding(2) var<uniform> params: BloomUpsampleParams;

@fragment
fn fs_upsample(in: FullscreenVsOut) -> @location(0) vec4<f32> {
    let uv = in.uv;
    let ts = params.texelSize;

    // 9-tap tent filter for smooth upsampling.
    var color = vec3<f32>(0.0);
    color += textureSample(srcTexture, srcSampler, uv + vec2<f32>(-1.0, -1.0) * ts).rgb * (1.0 / 16.0);
    color += textureSample(srcTexture, srcSampler, uv + vec2<f32>( 0.0, -1.0) * ts).rgb * (2.0 / 16.0);
    color += textureSample(srcTexture, srcSampler, uv + vec2<f32>( 1.0, -1.0) * ts).rgb * (1.0 / 16.0);
    color += textureSample(srcTexture, srcSampler, uv + vec2<f32>(-1.0,  0.0) * ts).rgb * (2.0 / 16.0);
    color += textureSample(srcTexture, srcSampler, uv                              ).rgb * (4.0 / 16.0);
    color += textureSample(srcTexture, srcSampler, uv + vec2<f32>( 1.0,  0.0) * ts).rgb * (2.0 / 16.0);
    color += textureSample(srcTexture, srcSampler, uv + vec2<f32>(-1.0,  1.0) * ts).rgb * (1.0 / 16.0);
    color += textureSample(srcTexture, srcSampler, uv + vec2<f32>( 0.0,  1.0) * ts).rgb * (2.0 / 16.0);
    color += textureSample(srcTexture, srcSampler, uv + vec2<f32>( 1.0,  1.0) * ts).rgb * (1.0 / 16.0);

    return vec4<f32>(color * params.blendFactor, 1.0);
}
`;
}
