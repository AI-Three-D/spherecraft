// core/renderer/postprocessing/shaders/bloomComposite.wgsl.js
//
// Additively blends the bloom texture onto the HDR scene buffer.

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

@group(0) @binding(0) var sceneTexture: texture_2d<f32>;
@group(0) @binding(1) var bloomTexture: texture_2d<f32>;
@group(0) @binding(2) var texSampler:   sampler;
@group(0) @binding(3) var<uniform> params: BloomCompositeParams;

@fragment
fn fs_composite(in: FullscreenVsOut) -> @location(0) vec4<f32> {
    let scene = textureSample(sceneTexture, texSampler, in.uv).rgb;
    let bloom = textureSample(bloomTexture, texSampler, in.uv).rgb;

    let result = scene + bloom * params.intensity;
    return vec4<f32>(result, 1.0);
}
`;
}
