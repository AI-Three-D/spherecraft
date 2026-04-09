// core/renderer/postprocessing/shaders/bloomComposite.wgsl.js
//
// Samples the bloom texture and returns only the bloom contribution.
// The render pipeline applies additive blending onto the HDR scene target.

import { fullscreenQuadVertexWGSL } from './fullscreenQuad.wgsl.js';

export function buildBloomCompositeWGSL() {
    return /* wgsl */`
${fullscreenQuadVertexWGSL}

struct BloomCompositeParams {
    intensity: f32,
    _pad0: f32,
    _pad1: f32,
    _pad2: f32,
};

@group(0) @binding(0) var bloomTexture: texture_2d<f32>;
@group(0) @binding(1) var texSampler: sampler;
@group(0) @binding(2) var<uniform> params: BloomCompositeParams;

@fragment
fn fs_composite(in: FullscreenVsOut) -> @location(0) vec4<f32> {
    let bloom = textureSample(bloomTexture, texSampler, in.uv).rgb;
    return vec4<f32>(bloom * params.intensity, 1.0);
}
`;
}
