// core/renderer/postprocessing/shaders/distortion.wgsl.js
//
// Screen-space distortion pass. Reads a 2-channel distortion map (rg16float)
// and offsets UV coordinates to warp the HDR scene image.

import { fullscreenQuadVertexWGSL } from './fullscreenQuad.wgsl.js';

export function buildDistortionWGSL() {
    return /* wgsl */`
${fullscreenQuadVertexWGSL}

struct DistortionParams {
    strength: f32,    // global distortion strength multiplier
    _pad0: f32,
    _pad1: f32,
    _pad2: f32,
};

@group(0) @binding(0) var sceneTexture:      texture_2d<f32>;
@group(0) @binding(1) var distortionMap:     texture_2d<f32>;
@group(0) @binding(2) var texSampler:        sampler;
@group(0) @binding(3) var<uniform> params:   DistortionParams;

@fragment
fn fs_distortion(in: FullscreenVsOut) -> @location(0) vec4<f32> {
    // Sample distortion offset (stored in RG channels, signed values).
    let distortion = textureSample(distortionMap, texSampler, in.uv).rg;
    let offset = distortion * params.strength;

    // Clamp warped UV to prevent sampling outside the texture.
    let warpedUV = clamp(in.uv + offset, vec2<f32>(0.0), vec2<f32>(1.0));

    return textureSample(sceneTexture, texSampler, warpedUV);
}
`;
}
