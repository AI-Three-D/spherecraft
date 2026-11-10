// core/renderer/postprocessing/shaders/bloomDownsample.wgsl.js
//
// Progressive downsample with a centered Gaussian-style filter.
// The first mip also applies a luminance threshold with soft knee.

import { fullscreenQuadVertexWGSL } from './fullscreenQuad.wgsl.js';

export function buildBloomDownsampleWGSL() {
    return /* wgsl */`
${fullscreenQuadVertexWGSL}

struct BloomDownsampleParams {
    texelSize: vec2<f32>,   // 1.0 / source resolution
    threshold: f32,
    knee: f32,
    isFirstPass: u32,       // 1 = apply threshold, 0 = just downsample
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
};

@group(0) @binding(0) var srcTexture: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;
@group(0) @binding(2) var<uniform> params: BloomDownsampleParams;

fn bloomBrightness(c: vec3<f32>) -> f32 {
    return max(max(c.r, c.g), c.b);
}

// Soft threshold with knee for smooth falloff.
fn thresholdFilter(color: vec3<f32>, threshold: f32, knee: f32) -> vec3<f32> {
    let brightness = bloomBrightness(color);
    let soft = brightness - threshold + knee;
    let soft2 = clamp(soft, 0.0, 2.0 * knee);
    let softContribution = (soft2 * soft2) / (4.0 * knee + 1e-6);
    let hardContribution = brightness - threshold;
    let contribution = select(
        max(softContribution, hardContribution),
        hardContribution,
        knee <= 0.0
    );
    let weight = max(contribution, 0.0) / max(brightness, 1e-6);
    return color * weight;
}

fn sampleBloomSource(uv: vec2<f32>, ts: vec2<f32>, offset: vec2<f32>) -> vec3<f32> {
    let color = textureSample(srcTexture, srcSampler, uv + offset * ts).rgb;
    if (params.isFirstPass == 1u) {
        // Extract highlights before the blur spreads them into neighboring pixels.
        return thresholdFilter(color, params.threshold, params.knee);
    }
    return color;
}

@fragment
fn fs_downsample(in: FullscreenVsOut) -> @location(0) vec4<f32> {
    let uv = in.uv;
    let ts = params.texelSize;

    let a = sampleBloomSource(uv, ts, vec2<f32>(-1.0, -1.0));
    let b = sampleBloomSource(uv, ts, vec2<f32>( 0.0, -1.0));
    let c = sampleBloomSource(uv, ts, vec2<f32>( 1.0, -1.0));
    let d = sampleBloomSource(uv, ts, vec2<f32>(-1.0,  0.0));
    let e = sampleBloomSource(uv, ts, vec2<f32>( 0.0,  0.0));
    let f = sampleBloomSource(uv, ts, vec2<f32>( 1.0,  0.0));
    let g = sampleBloomSource(uv, ts, vec2<f32>(-1.0,  1.0));
    let h = sampleBloomSource(uv, ts, vec2<f32>( 0.0,  1.0));
    let i = sampleBloomSource(uv, ts, vec2<f32>( 1.0,  1.0));

    // Centered 3x3 kernel. This is intentionally conservative: it produces
    // a stable glow rather than the multi-lobed ghosting the previous
    // off-center filter created around tiny bright sources.
    let color =
        (a + c + g + i) * (1.0 / 16.0) +
        (b + d + f + h) * (2.0 / 16.0) +
        e * (4.0 / 16.0);

    return vec4<f32>(color, 1.0);
}
`;
}
