// core/renderer/rivers/shaders/riverWaterShader.wgsl.js
//
// Water surface render shader for the river walking skeleton. Adapted from
// whitewater's WGSL_WATER (vsWater/fsWater, whitewater/js/shaders.js), with
// two structural changes:
//   - whitewater's flat (x, y, z) world reconstruction is replaced by a
//     tangent-frame transform (patchAnchor/right/up/forward), since the
//     patch sits on a sphere rather than a flat plane.
//   - whitewater's shared Cam uniform (fed by its own sky/exposure system)
//     is replaced by two small uniform buffers sourced from spherecraft's
//     UniformManager (sun/ambient/fog), following the same shape as
//     core/renderer/water/waterShader.wgsl.js.
// The wave/foam/lighting math itself is kept as close to the original as
// the different lighting model allows.

import { RIVER_WGSL_NOISE } from './riverNoise.wgsl.js';

export function buildRiverVertexShader() {
    return /* wgsl */`
struct RiverVertexUniforms {
    viewMatrix:       mat4x4<f32>,
    projectionMatrix: mat4x4<f32>,
    patchAnchor:  vec3<f32>, dx: f32,
    patchRight:   vec3<f32>, time: f32,
    patchUp:      vec3<f32>, hmin: f32,
    patchForward: vec3<f32>, waveAmp: f32,
    gridW: f32, gridL: f32, _pad0: f32, _pad1: f32,
}

@group(0) @binding(0) var<uniform> V: RiverVertexUniforms;
@group(1) @binding(0) var<storage, read> B: array<f32>;
@group(1) @binding(1) var<storage, read> S: array<vec4f>;
@group(1) @binding(2) var<storage, read> K: array<f32>;

fn ci(i: i32, j: i32) -> u32 {
    let W = i32(V.gridW); let L = i32(V.gridL);
    return u32(clamp(j, 0, L - 1)) * u32(W) + u32(clamp(i, 0, W - 1));
}

fn etaN(i: i32, j: i32, eta0: f32, hmin: f32) -> f32 {
    let sn = S[ci(i, j)];
    return select(eta0, B[ci(i, j)] + sn.x, sn.x > hmin);
}

struct RVOut {
    @builtin(position) pos: vec4f,
    @location(0) wp: vec3f,
    @location(1) n: vec3f,
    @location(2) hv: vec4f,
    @location(3) k: f32,
    @location(4) uv: vec2f,
};

@vertex
fn main(@builtin(vertex_index) vi: u32) -> RVOut {
    let W = i32(V.gridW); let dx = V.dx; let hmin = V.hmin; let t = V.time;
    let i = i32(vi) % W; let j = i32(vi) / W;
    let id = ci(i, j);
    let s = S[id]; let b = B[id]; let h = s.x;
    let eta = b + h;
    let eL = etaN(i - 1, j, eta, hmin); let eR = etaN(i + 1, j, eta, hmin);
    let eD = etaN(i, j - 1, eta, hmin); let eU = etaN(i, j + 1, eta, hmin);
    let uc = 0.5 * (s.y + S[ci(i + 1, j)].y); let vc = 0.5 * (s.z + S[ci(i, j + 1)].z);
    let k = K[id];

    let localX = (f32(i) + 0.5) * dx - 0.5 * V.gridW * dx;
    let localZ = (f32(j) + 0.5) * dx - 0.5 * V.gridL * dx;

    let amp = V.waveAmp * k * smoothstep(0.0, 0.35, h);
    let d = amp * (sin(localX * 2.3 + localZ * 0.9 - t * 6.0)
                  + sin(localX * -1.1 + localZ * 2.4 - t * 4.7)
                  + 0.6 * sin(localX * 3.9 + localZ * 3.3 - t * 8.1));
    var eEff = eta + d;
    if (h <= hmin * 0.5) { eEff = b - 0.08; }

    let nLocal = normalize(vec3f((eL - eR) / (2.0 * dx), 1.0, (eD - eU) / (2.0 * dx)));
    let worldPos = V.patchAnchor + V.patchRight * localX + V.patchForward * localZ + V.patchUp * eEff;
    let worldNormal = normalize(V.patchRight * nLocal.x + V.patchUp * nLocal.y + V.patchForward * nLocal.z);

    var o: RVOut;
    o.pos = V.projectionMatrix * (V.viewMatrix * vec4f(worldPos, 1.0));
    o.wp = worldPos; o.n = worldNormal; o.hv = vec4f(h, uc, vc, s.w); o.k = k;
    o.uv = vec2f(localX, localZ);
    return o;
}
`;
}

export function buildRiverFragmentShader() {
    return RIVER_WGSL_NOISE + /* wgsl */`
struct RiverFragmentUniforms {
    sunDirection:   vec3<f32>, sunIntensity: f32,
    sunColor:       vec3<f32>, ambientIntensity: f32,
    ambientColor:   vec3<f32>, fogDensity: f32,
    fogColor:       vec3<f32>, time: f32,
    waterTint:      vec3<f32>, clarity: f32,
    cameraPosition: vec3<f32>, hmin: f32,
    patchRight:     vec3<f32>, _pad0: f32,
    patchForward:   vec3<f32>, _pad1: f32,
}

@group(0) @binding(1) var<uniform> F: RiverFragmentUniforms;

@fragment
fn main(
    @location(0) wp: vec3f,
    @location(1) n: vec3f,
    @location(2) hv: vec4f,
    @location(3) k: f32,
    @location(4) uv: vec2f,
) -> @location(0) vec4f {
    let h = hv.x; let vel = hv.yz; let foam = hv.w;
    let fa = clamp(foam, 0.0, 1.0);

    // scrolling double-panner normal noise, in local patch-space uv (the
    // patch is a flat approximation, so this is the same trick whitewater
    // uses in world-space x/z)
    let t = F.time;
    let T = 1.5;
    let ph0 = fract(t / T); let ph1 = fract(t / T + 0.5);
    let uvA = uv - vel * ph0 * T; let uvB = uv - vel * ph1 * T + vec2f(37.0, 11.0);
    let blend = abs(2.0 * ph0 - 1.0);
    let e = 0.05; let freq = 1.6;
    let nA = vec2f(noise2(uvA * freq + vec2f(e, 0.0)) - noise2(uvA * freq - vec2f(e, 0.0)),
                    noise2(uvA * freq + vec2f(0.0, e)) - noise2(uvA * freq - vec2f(0.0, e))) / (2.0 * e);
    let nB = vec2f(noise2(uvB * freq + vec2f(e, 0.0)) - noise2(uvB * freq - vec2f(e, 0.0)),
                    noise2(uvB * freq + vec2f(0.0, e)) - noise2(uvB * freq - vec2f(0.0, e))) / (2.0 * e);
    let g2 = mix(nA, nB, blend);
    let str = 0.03 + 0.12 * k;
    let nrm = normalize(n + F.patchRight * (-g2.x * str) + F.patchForward * (-g2.y * str));

    let V3 = normalize(F.cameraPosition - wp);
    let R = reflect(-V3, nrm);
    let fres = 0.02 + 0.98 * pow(1.0 - max(dot(nrm, V3), 0.0), 5.0);

    let bedCol = vec3f(0.40, 0.35, 0.26) * (0.8 + 0.4 * noise2(uv * 1.7));
    let bedColT = mix(bedCol, F.waterTint * 1.8, 0.45);
    let absorb = exp(-h * vec3f(1.6, 0.8, 0.6) / max(F.clarity, 0.05));
    var body = mix(F.waterTint, bedColT * 0.8, absorb);
    body += F.waterTint * (1.0 - absorb.g) * 0.3;

    let NdotL = max(dot(nrm, F.sunDirection), 0.0);
    let spec = pow(max(dot(R, F.sunDirection), 0.0), 180.0) * 1.5;

    let lighting = F.ambientColor * F.ambientIntensity + F.sunColor * NdotL * F.sunIntensity;
    let reflectionTint = mix(body, F.fogColor, 0.35);
    let skyReflection = reflectionTint * (0.2 + 0.45 * NdotL);

    var col = mix(body * lighting, skyReflection, fres);

    let pat = mix(noise2(uvA * 2.2), noise2(uvB * 2.2), blend) * 0.6
            + 0.4 * mix(noise2(uvA * 6.0), noise2(uvB * 6.0), blend);
    let mask = smoothstep(0.62 - 0.55 * fa, 0.72 - 0.55 * fa, pat) * smoothstep(0.0, 0.15, fa);
    let foamCol = vec3f(0.92, 0.95, 0.97) * (0.8 + 0.4 * NdotL);
    col = mix(col, foamCol, mask);
    col += spec * F.sunColor * F.sunIntensity;

    let dist = length(F.cameraPosition - wp);
    let fogF = clamp(1.0 - exp(-F.fogDensity * dist), 0.0, 1.0);
    col = mix(col, F.fogColor, fogF);

    let present = smoothstep(0.0, 0.06, h);
    let depthT = 1.0 - exp(-h * 2.2 / max(F.clarity, 0.05));
    var alpha = present * mix(0.42, 1.0, depthT);
    alpha = max(alpha, mask * 0.35);

    return vec4f(col, clamp(alpha, 0.0, 1.0));
}
`;
}
