// core/renderer/water/waterSimSurface.wgsl.js
//
// Surface of the near-field water simulation (core/world/water/
// WaterRiverSim.js: a strip of cells along a river), adapted from
// Whitewater's vsWater/fsWater (../whitewater/js/shaders.js): one vertex per
// cell read from the simulation buffers, normal from neighbouring surface
// heights, small turbulence waves; flow-advected ripples (two phases), foam
// from the simulation's foam field, Fresnel sky reflection, sun glint, alpha
// from depth. SphereCraft: cells sit on the sphere along the river (row
// frames: centre direction and left normal per row, rows in a ring like the
// simulation's), dry cells keep the bed height and fragments below hmin are
// discarded (soft wet/dry edge); ripple coordinates are the offset across
// and the arc length along the river, so the pattern stays on the ground as
// the strip scrolls; the surface fades out at the strip's ends, where the
// terrain shader's static water takes over.

export function buildWaterSimVertexShader() {
    return /* wgsl */`
struct SimVU {
    viewMatrix: mat4x4<f32>,
    projectionMatrix: mat4x4<f32>,
    origin: vec3<f32>, R: f32,
    dx: f32, W: f32, L: f32, rowBase: f32,
    hmin: f32, time: f32, fade: f32, endFade: f32,
    waveAmp: f32, _p0: f32, _p1: f32, _p2: f32,
};
@group(0) @binding(0) var<uniform> V: SimVU;
@group(1) @binding(0) var<storage, read> B: array<f32>;
@group(1) @binding(1) var<storage, read> S: array<vec4<f32>>;
@group(1) @binding(2) var<storage, read> K: array<f32>;
@group(1) @binding(3) var<storage, read> ROWS: array<vec4<f32>>;   // per row: centre, left normal, (hw, thalweg, s, valid)

fn phys(j: i32) -> u32 {
    let r = u32(clamp(j, 0, i32(V.L) - 1)) + u32(V.rowBase);
    return select(r, r - u32(V.L), r >= u32(V.L));
}
fn ci(i: i32, j: i32) -> u32 {
    return phys(j) * u32(V.W) + u32(clamp(i, 0, i32(V.W) - 1));
}
fn etaN(i: i32, j: i32, eta0: f32) -> f32 {
    let s = S[ci(i, j)];
    return select(eta0, B[ci(i, j)] + s.x, s.x > V.hmin);
}

struct SimVOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) wp: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) hv: vec4<f32>,        // h, velocity across, along, foam
    @location(3) k: f32,
    @location(4) local: vec2<f32>,     // across (m), arc length along the river (m)
    @location(5) edge: f32,            // end fade x strip fade
    @location(6) e1: vec3<f32>,        // across (left)
    @location(7) e2: vec3<f32>,        // along (downstream)
};

@vertex
fn main(@builtin(vertex_index) vi: u32) -> SimVOut {
    let n = i32(V.W);
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
    let pr = phys(j);
    let c = ROWS[pr * 3u].xyz;
    let left = ROWS[pr * 3u + 1u].xyz;
    let sArc = ROWS[pr * 3u + 2u].z;
    let x = (f32(i) + 0.5 - 0.5 * V.W) * V.dx;
    let dir = normalize(c + left * (x / V.R));
    let along = normalize(cross(left, dir));
    let amp = V.waveAmp * k * smoothstep(0.0, 0.35, h);
    let wave = amp * (sin(x * 2.3 + sArc * 0.9 - V.time * 6.0) + sin(-x * 1.1 + sArc * 2.4 - V.time * 4.7)
                     + 0.6 * sin(x * 3.9 + sArc * 3.3 - V.time * 8.1));
    let surf = select(eta + wave, b, h <= V.hmin);
    let worldPos = V.origin + dir * (V.R + surf);
    let gx = (eR - eL) / (2.0 * V.dx);
    let gy = (eU - eD) / (2.0 * V.dx);
    let toEnd = f32(min(j, i32(V.L) - 1 - j)) * V.dx;
    let toSide = f32(min(i, n - 1 - i)) * V.dx;
    var o: SimVOut;
    o.pos = V.projectionMatrix * (V.viewMatrix * vec4<f32>(worldPos, 1.0));
    o.wp = worldPos;
    o.normal = normalize(dir - left * gx - along * gy);
    o.hv = vec4<f32>(h, uc, vc, s.w);
    o.k = k;
    o.local = vec2<f32>(x, sArc);
    o.edge = V.fade * smoothstep(0.0, V.endFade, toEnd) * smoothstep(0.0, 2.0 * V.dx, toSide);
    o.e1 = left;
    o.e2 = along;
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
    @location(6) e1: vec3<f32>,
    @location(7) e2: vec3<f32>,
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
    let N = normalize(up - (normalize(e1) * g.x + normalize(e2) * g.y) * str);

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
