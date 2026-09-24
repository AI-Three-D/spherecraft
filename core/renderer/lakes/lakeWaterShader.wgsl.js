// core/renderer/lakes/lakeWaterShader.wgsl.js
//
// Water surface shader for the erosion-seed lakes (LakeWaterSystem). Each
// lake is a small, static, flat-plane mesh (a tangent-plane approximation
// is fine at this scale — same trick riverWaterShader.wgsl.js uses for its
// patch) rather than a simulated grid: real vertex positions instead of
// storage-buffer reconstruction, since there's no flow simulation driving
// these. Lighting/fresnel/fog structure borrows from riverWaterShader.wgsl.js
// for a consistent look, simplified (no flow velocity, no foam — lakes
// don't flow).

import { RIVER_WGSL_NOISE } from '../rivers/shaders/riverNoise.wgsl.js';

export function buildLakeWaterVertexShader() {
    return /* wgsl */`
struct LakeVertexUniforms {
    viewMatrix:       mat4x4<f32>,
    projectionMatrix: mat4x4<f32>,
    center:  vec3<f32>, time: f32,
    right:   vec3<f32>, rippleStrength: f32,
    forward: vec3<f32>, rippleFreq: f32,
    up:      vec3<f32>, _pad0: f32,
}
@group(0) @binding(0) var<uniform> V: LakeVertexUniforms;

struct VertexInput {
    @location(0) position: vec3<f32>, // local tangent-plane offset from center: x=right, y=forward, z unused
}

struct LVOut {
    @builtin(position) pos: vec4f,
    @location(0) wp: vec3f,
    @location(1) n: vec3f,
    @location(2) localXY: vec2f,
};

@vertex
fn main(input: VertexInput) -> LVOut {
    let localX = input.position.x;
    let localY = input.position.y;
    let r = length(vec2f(localX, localY));

    // Cheap radial ripple, fading in from the shore (r=0) and modulated by
    // rippleStrength — the system anneals this to 0 with camera distance,
    // so a far lake reads as a flat textured plane without a second shader.
    let ripple = V.rippleStrength * 0.12 * sin(r * V.rippleFreq - V.time * 1.6) * smoothstep(0.0, 6.0, r);

    let worldPos = V.center + V.right * localX + V.forward * localY + V.up * ripple;

    var o: LVOut;
    o.pos = V.projectionMatrix * (V.viewMatrix * vec4f(worldPos, 1.0));
    o.wp = worldPos;
    o.n = V.up;
    o.localXY = vec2f(localX, localY);
    return o;
}
`;
}

export function buildLakeWaterFragmentShader() {
    return RIVER_WGSL_NOISE + /* wgsl */`
struct LakeFragmentUniforms {
    sunDirection:   vec3<f32>, sunIntensity: f32,
    sunColor:       vec3<f32>, ambientIntensity: f32,
    ambientColor:   vec3<f32>, fogDensity: f32,
    fogColor:       vec3<f32>, time: f32,
    waterTint:      vec3<f32>, clarity: f32,
    cameraPosition: vec3<f32>, rippleStrength: f32,
}
@group(0) @binding(1) var<uniform> F: LakeFragmentUniforms;

@fragment
fn main(
    @location(0) wp: vec3f,
    @location(1) n: vec3f,
    @location(2) localXY: vec2f,
) -> @location(0) vec4f {
    let t = F.time;
    let e = 0.08; let freq = 0.12;
    let uv = localXY * freq + vec2f(t * 0.02, t * 0.015);
    let g2 = vec2f(
        noise2(uv + vec2f(e, 0.0)) - noise2(uv - vec2f(e, 0.0)),
        noise2(uv + vec2f(0.0, e)) - noise2(uv - vec2f(0.0, e))
    ) / (2.0 * e);
    let str = 0.18 * clamp(F.rippleStrength, 0.0, 1.0);
    let nrm = normalize(n + vec3f(g2.x * str, 0.0, g2.y * str));

    let V3 = normalize(F.cameraPosition - wp);
    let R = reflect(-V3, nrm);
    let fres = 0.02 + 0.98 * pow(1.0 - max(dot(nrm, V3), 0.0), 5.0);

    let NdotL = max(dot(nrm, F.sunDirection), 0.0);
    let spec = pow(max(dot(R, F.sunDirection), 0.0), 180.0) * 1.2 * clamp(F.rippleStrength, 0.15, 1.0);

    let lighting = F.ambientColor * F.ambientIntensity + F.sunColor * NdotL * F.sunIntensity;
    let reflectionTint = mix(F.waterTint, F.fogColor, 0.35);
    let skyReflection = reflectionTint * (0.25 + 0.45 * NdotL);

    var col = mix(F.waterTint * lighting, skyReflection, fres);
    col += spec * F.sunColor * F.sunIntensity;

    let dist = length(F.cameraPosition - wp);
    let fogF = clamp(1.0 - exp(-F.fogDensity * dist), 0.0, 1.0);
    col = mix(col, F.fogColor, fogF);

    return vec4f(col, 0.88);
}
`;
}
