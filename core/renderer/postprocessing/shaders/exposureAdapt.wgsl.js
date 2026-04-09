// core/renderer/postprocessing/shaders/exposureAdapt.wgsl.js
//
// Converts measured log luminance into an adapted exposure value.

import { fullscreenQuadVertexWGSL } from './fullscreenQuad.wgsl.js';

export function buildExposureAdaptWGSL() {
    return /* wgsl */`
${fullscreenQuadVertexWGSL}

struct ExposureAdaptParams {
    dt: f32,
    middleGray: f32,
    minExposure: f32,
    maxExposure: f32,
    exposureCompensation: f32,
    speedUp: f32,
    speedDown: f32,
    resetHistory: f32,
};

@group(0) @binding(0) var measuredTexture: texture_2d<f32>;
@group(0) @binding(1) var previousExposureTexture: texture_2d<f32>;
@group(0) @binding(2) var exposureSampler: sampler;
@group(0) @binding(3) var<uniform> params: ExposureAdaptParams;

@fragment
fn fs_adapt(_in: FullscreenVsOut) -> @location(0) vec4<f32> {
    let uv = vec2<f32>(0.5, 0.5);
    let measuredLogLum = textureSample(measuredTexture, exposureSampler, uv).r;
    let avgLum = exp(measuredLogLum);
    let desiredExposure = clamp(
        (params.middleGray / max(avgLum, 1e-4)) * exp2(params.exposureCompensation),
        params.minExposure,
        params.maxExposure
    );

    var exposure = desiredExposure;
    if (params.resetHistory < 0.5) {
        let previousExposure = textureSample(previousExposureTexture, exposureSampler, uv).r;
        let rate = select(params.speedDown, params.speedUp, desiredExposure > previousExposure);
        let adaptT = clamp(1.0 - exp(-max(rate, 0.0) * max(params.dt, 0.0)), 0.0, 1.0);
        exposure = mix(previousExposure, desiredExposure, adaptT);
    }

    return vec4<f32>(exposure, exposure, exposure, 1.0);
}
`;
}
