// core/renderer/water/waterSimSurface.wgsl.js
//
// Surface of the near-field water simulation (core/world/water/
// WaterSimSite.js), adapted from Whitewater's vsWater/fsWater
// (../whitewater/js/shaders.js): one vertex per cell read from the
// simulation buffers, normal from neighbouring surface heights, small
// turbulence waves; flow-advected ripples (two phases), foam from the
// simulation's foam field, Fresnel sky reflection, sun glint, alpha from
// depth. Changes: cells sit on the sphere (site tangent frame, radial
// heights), dry cells keep the bed height and fragments below hmin are
// discarded (soft wet/dry edge), and the surface fades across the site's
// border band, where the terrain shader's static water takes over.

export function buildWaterSimVertexShader() {
    return /* wgsl */`
struct SimVU {
    viewMatrix: mat4x4<f32>,
    projectionMatrix: mat4x4<f32>,
    c: vec3<f32>, R: f32,
    e1: vec3<f32>, dx: f32,
    e2: vec3<f32>, n: f32,
    origin: vec3<f32>, hmin: f32,
    time: f32, fade: f32, border: f32, waveAmp: f32,
};
@group(0) @binding(0) var<uniform> V: SimVU;
@group(1) @binding(0) var<storage, read> B: array<f32>;
@group(1) @binding(1) var<storage, read> S: array<vec4<f32>>;
@group(1) @binding(2) var<storage, read> K: array<f32>;

fn ci(i: i32, j: i32) -> u32 {
    let n = i32(V.n);
    return u32(clamp(j, 0, n - 1) * n + clamp(i, 0, n - 1));
}
fn etaN(i: i32, j: i32, eta0: f32) -> f32 {
    let s = S[ci(i, j)];
    return select(eta0, B[ci(i, j)] + s.x, s.x > V.hmin);
}

struct SimVOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) wp: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) hv: vec4<f32>,        // h, velocity along e1, along e2, foam
    @location(3) k: f32,
    @location(4) local: vec2<f32>,     // site plane coords (m)
    @location(5) edge: f32,            // border fade x site fade
};

@vertex
fn main(@builtin(vertex_index) vi: u32) -> SimVOut {
    let n = i32(V.n);
    let i = i32(vi) % n;
    let j = i32(vi) / n;
    let id = ci(i, j);
    let s = S[id];
    let b = B[id];
    let h = s.x;
    let eta = b + h;
    let eL = etaN(i - 1, j, eta); let eR = etaN(i + 1, j, eta);
    let eD = etaN(i, j - 1, eta); let eU = etaN(i, j + 1, eta);
    let uc = 0.5 * (s.y + S[ci(i + 1, j)].y);
    let vc = 0.5 * (s.z + S[ci(i, j + 1)].z);
    let k = K[id];
    let x = (f32(i) + 0.5 - 0.5 * V.n) * V.dx;
    let y = (f32(j) + 0.5 - 0.5 * V.n) * V.dx;
    let amp = V.waveAmp * k * smoothstep(0.0, 0.35, h);
    let wave = amp * (sin(x * 2.3 + y * 0.9 - V.time * 6.0) + sin(-x * 1.1 + y * 2.4 - V.time * 4.7)
                     + 0.6 * sin(x * 3.9 + y * 3.3 - V.time * 8.1));
    let surf = select(eta + wave, b, h <= V.hmin);
    let dir = normalize(V.c + (x * V.e1 + y * V.e2) / V.R);
    let worldPos = V.origin + dir * (V.R + surf);
    let gx = (eR - eL) / (2.0 * V.dx);
    let gy = (eU - eD) / (2.0 * V.dx);
    let half = 0.5 * V.n * V.dx;
    var o: SimVOut;
    o.pos = V.projectionMatrix * (V.viewMatrix * vec4<f32>(worldPos, 1.0));
    o.wp = worldPos;
    o.normal = normalize(dir - V.e1 * gx - V.e2 * gy);
    o.hv = vec4<f32>(h, uc, vc, s.w);
    o.k = k;
    o.local = vec2<f32>(x, y);
    o.edge = V.fade * (1.0 - smoothstep(half - V.border, half, max(abs(x), abs(y))));
    return o;
}
`;
}

export function buildWaterSimFragmentShader() {
    return /* wgsl */`
struct SimFU {
    sunDir: vec3<f32>, sunIntensity: f32,
    sunColor: vec3<f32>, ambientIntensity: f32,
    ambientColor: vec3<f32>, time: f32,
    cameraPos: vec3<f32>, hmin: f32,
    deepColor: vec3<f32>, reflection: f32,
    absorption: vec3<f32>, _pad: f32,
    e1: vec3<f32>, _pad1: f32,
    e2: vec3<f32>, _pad2: f32,
};
@group(0) @binding(1) var<uniform> F: SimFU;

fn hash21(p: vec2<f32>) -> f32 {
    var p3 = fract(vec3<f32>(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
fn noise2(p: vec2<f32>) -> f32 {
    let i = floor(p); let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i), hash21(i + vec2<f32>(1.0, 0.0)), u.x),
               mix(hash21(i + vec2<f32>(0.0, 1.0)), hash21(i + vec2<f32>(1.0, 1.0)), u.x), u.y);
}
fn noiseGrad(p: vec2<f32>) -> vec2<f32> {
    let e = 0.05;
    return vec2<f32>(noise2(p + vec2<f32>(e, 0.0)) - noise2(p - vec2<f32>(e, 0.0)),
                     noise2(p + vec2<f32>(0.0, e)) - noise2(p - vec2<f32>(0.0, e))) / (2.0 * e);
}

@fragment
fn main(
    @location(0) wp: vec3<f32>,
    @location(1) normalIn: vec3<f32>,
    @location(2) hv: vec4<f32>,
    @location(3) k: f32,
    @location(4) local: vec2<f32>,
    @location(5) edge: f32,
) -> @location(0) vec4<f32> {
    let h = hv.x;
    if (h < F.hmin || edge <= 0.001) { discard; }
    let vel = hv.yz;
    let foam = clamp(hv.w, 0.0, 1.0);
    let up = normalize(normalIn);

    // Ripples carried by the flow: two phases of noise advected along the
    // velocity, cross-faded (Whitewater's flow-map trick).
    let T = 1.5;
    let t = F.time;
    let ph0 = fract(t / T); let ph1 = fract(t / T + 0.5);
    let blend = abs(2.0 * ph0 - 1.0);
    let uvA = local - vel * ph0 * T;
    let uvB = local - vel * ph1 * T + vec2<f32>(37.0, 11.0);
    let g = mix(noiseGrad(uvA * 1.6), noiseGrad(uvB * 1.6), blend);
    let str = 0.03 + 0.12 * k;
    let N = normalize(up - (F.e1 * g.x + F.e2 * g.y) * str);

    let toCam = F.cameraPos - wp;
    let V = normalize(toCam);
    let cosV = max(dot(V, up), 0.02);
    let sunDir = normalize(F.sunDir);
    let sun = F.sunColor * F.sunIntensity;
    let sky = F.ambientColor * F.ambientIntensity;
    let fres = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
    let R = reflect(-V, N);
    let spec = pow(max(dot(R, sunDir), 0.0), 180.0) * 1.5;
    let body = F.deepColor * (sky + sun * max(dot(up, sunDir), 0.0));
    var col = mix(body, sky * F.reflection, fres) + sun * spec;

    // Foam: patchy, stronger where the simulation made foam.
    let pat = mix(noise2(uvA * 2.2), noise2(uvB * 2.2), blend) * 0.6 + 0.4 * mix(noise2(uvA * 6.0), noise2(uvB * 6.0), blend);
    let fmask = smoothstep(0.62 - 0.55 * foam, 0.72 - 0.55 * foam, pat) * smoothstep(0.0, 0.15, foam);
    let foamCol = vec3<f32>(0.92, 0.95, 0.97) * (sky + sun * (0.4 + 0.6 * max(dot(N, sunDir), 0.0)));
    col = mix(col, foamCol, fmask);

    // See-through by the water column along the view ray (absorption).
    let opacity = 1.0 - exp(-(h / cosV) * dot(F.absorption, vec3<f32>(0.33, 0.34, 0.33)) * 3.0);
    let present = smoothstep(F.hmin, F.hmin + 0.06, h);
    let alpha = present * clamp(max(opacity, max(fres, fmask)), 0.0, 1.0) * edge;
    return vec4<f32>(col, alpha);
}
`;
}
