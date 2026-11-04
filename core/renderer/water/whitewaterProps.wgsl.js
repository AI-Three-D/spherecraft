// core/renderer/water/whitewaterProps.wgsl.js
//
// What stands in and flies off the whitewater (WhitewaterSim.js):
// - rocks: every river rock (riverFlow.js), the same domes the solver's bed
//   holds, as meshes shaped in the vertex shader (one grid, a shape per seed), so
//   the tiles need not hold them and the switch can take them away at once;
// - spray: Whitewater's ambient spray, thrown up where the water foams, plus a
//   wider and fainter mist where it is thickest. Whitewater's are hard white
//   dots; these are soft and take the sky and the sun.

import { getAerialPerspectiveWGSL } from '../atmosphere/shaders/aerialPerspectiveCommon.js';
import { NEAR_WATER_U_WGSL, NEAR_WATER_RASTER_WGSL } from './nearWaterSurface.wgsl.js';
import { WHITE_UNIFORMS_WGSL } from './whitewaterLook.wgsl.js';

export const ROCK_GRID = [30, 17];
export const WHITE_SPRAY_PARTICLES = 8192;
const SPRAY_SEC = 32;   // bytes a particle

const HEAD = /* wgsl */`
${NEAR_WATER_U_WGSL}
@group(0) @binding(0) var<uniform> U: NearWaterU;
${NEAR_WATER_RASTER_WGSL}
${WHITE_UNIFORMS_WGSL}
@group(1) @binding(0) var<uniform> W: WhiteU;
`;

const ATMOSPHERE = /* wgsl */`
@group(1) @binding(3) var transmittanceLUT: texture_2d<f32>;
@group(1) @binding(4) var propSampler: sampler;
// Lit colour through the air, as the water's own (nearWaterCompose).
fn propAerial(col: vec3<f32>, wp: vec3<f32>) -> vec3<f32> {
    let dist = length(U.cameraPos - wp);
    let L = normalize(U.sunDir);
    let up = normalize(wp - U.origin);
    if (U.grid.y > 0.5) {
        let b = smoothstep(U.ap.y, U.ap.z, dist);
        if (b <= 0.001) { return col; }
        var ap = ap_computeSimple(transmittanceLUT, propSampler, wp, U.cameraPos, L, U.origin,
            U.atmoPlanetRadius, U.atmo.x, U.atmo.y, U.atmo.z, U.rayleigh, U.mieScattering, U.atmo.w, U.ap.x);
        ap.inscatter *= mix(0.2, 1.0, smoothstep(0.0, 0.2, dot(up, L)));
        return col * mix(vec3<f32>(1.0), ap.transmittance, b) + ap.inscatter * b;
    }
    return mix(col, U.fog.rgb, clamp(1.0 - exp(-dist * U.fog.w), 0.0, 1.0));
}
`;

const NOISE = /* wgsl */`
fn pHash(p: vec3<f32>) -> f32 {
    var q = fract(p * 0.1031);
    q += dot(q, q.zyx + 31.32);
    return fract((q.x + q.y) * q.z);
}
fn pNoise(p: vec3<f32>) -> f32 {
    let i = floor(p); let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(pHash(i), pHash(i + vec3<f32>(1.0, 0.0, 0.0)), u.x), mix(pHash(i + vec3<f32>(0.0, 1.0, 0.0)), pHash(i + vec3<f32>(1.0, 1.0, 0.0)), u.x), u.y),
               mix(mix(pHash(i + vec3<f32>(0.0, 0.0, 1.0)), pHash(i + vec3<f32>(1.0, 0.0, 1.0)), u.x), mix(pHash(i + vec3<f32>(0.0, 1.0, 1.0)), pHash(i + vec3<f32>(1.0, 1.0, 1.0)), u.x), u.y), u.z);
}
`;

const ROCK_VOUT = /* wgsl */`
struct RockVOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) wp: vec3<f32>,
    @location(1) local: vec3<f32>,
    @location(2) @interpolate(flat) seed: f32,
    @location(3) above: f32,
    @location(4) dome: vec3<f32>,
};
@group(1) @binding(1) var<storage, read> ROCKS: array<vec4<f32>>;
@group(1) @binding(2) var<storage, read> ROCK_LIST: array<u32>;
`;

export function buildRockVertexShader() {
    return HEAD + ROCK_VOUT + NOISE + /* wgsl */`
// A lumpy dome: a unit direction's radius (Whitewater's boulder: broad lumps, then roughness).
fn rockRadius(d: vec3<f32>, seed: f32) -> f32 {
    let s = seed * 37.0;
    return 0.82 + 0.34 * pNoise(d * 1.4 + s) + 0.16 * pNoise(d * 3.6 + s + 5.0) + 0.05 * pNoise(d * 9.0 + s + 11.0);
}
@vertex
fn main(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> RockVOut {
    let q = i32(ROCK_LIST[ii]);
    let a = ROCKS[q * 2]; let b = ROCKS[q * 2 + 1];
    let n = ${ROCK_GRID[0]}u;
    let ring = f32(vi % n) / f32(n - 1u); let lat = f32(vi / n) / ${(ROCK_GRID[1] - 1).toFixed(1)};
    // From the top down to a little under the base, where it is in the bed.
    let az = ring * 6.2831853 + b.y * 6.2831853;
    let pol = lat * 1.85;
    var d = vec3<f32>(sin(pol) * cos(az), cos(pol), sin(pol) * sin(az));
    let s = rockRadius(d, b.y);
    let cam = distance(a.xy, W.cameraXY);
    // Far ones sink out of sight rather than pop.
    let sink = 1.0 - smoothstep(W.rockDrawM * 0.8, W.rockDrawM, cam);
    let h = max(a.w - b.x, 0.3);
    let xy = a.xy + vec2<f32>(d.x, d.z) * (a.z * s * 1.12);
    let dir = whiteFrameDir(xy);
    let z = b.x + d.y * s * h * 1.08 - (1.0 - sink) * (h + 1.0);
    let wp = U.origin + dir * (U.R + z);
    var o: RockVOut;
    o.pos = U.projectionMatrix * (U.viewMatrix * vec4<f32>(wp, 1.0));
    // Metres from the rock's centre (x, height, y): small numbers. Screen
    // derivatives of world positions are noise at planet radius in f32.
    o.wp = wp; o.local = vec3<f32>(xy.x - a.x, z - b.x, xy.y - a.y); o.seed = b.y; o.above = z - b.z;
    // The dome's own normal (x, height, y): lumps come from the fragment's detail.
    o.dome = normalize(vec3<f32>(d.x / max(a.z, 0.1), d.y / h, d.z / max(a.z, 0.1)));
    return o;
}
`;
}

export function buildRockFragmentShader() {
    return HEAD + getAerialPerspectiveWGSL() + ATMOSPHERE + ROCK_VOUT + NOISE + /* wgsl */`
@fragment
fn main(in: RockVOut) -> @location(0) vec4<f32> {
    // Smooth dome, roughened by the gradient of the stone's own noise: mesh
    // triangles do not show, whatever the distance (screen derivatives gave
    // facets near and black streaks far).
    let up = normalize(in.wp - U.origin);
    let dist = length(U.cameraPos - in.wp);
    let q = in.local * 0.9 + in.seed * 23.0;
    let e = 0.12;
    let n0 = pNoise(q) + 0.5 * pNoise(q * 2.7);
    let gx = pNoise(q + vec3<f32>(e, 0.0, 0.0)) + 0.5 * pNoise((q + vec3<f32>(e, 0.0, 0.0)) * 2.7) - n0;
    let gy = pNoise(q + vec3<f32>(0.0, e, 0.0)) + 0.5 * pNoise((q + vec3<f32>(0.0, e, 0.0)) * 2.7) - n0;
    let gz = pNoise(q + vec3<f32>(0.0, 0.0, e)) + 0.5 * pNoise((q + vec3<f32>(0.0, 0.0, e)) * 2.7) - n0;
    let bump = (1.0 - smoothstep(60.0, 260.0, dist)) * 0.5;
    let n = normalize(in.dome - vec3<f32>(gx, gy, gz) / e * 0.25 * bump);
    let N = normalize(W.e1 * n.x + up * n.y + W.e2 * n.z);
    let L = normalize(U.sunDir);
    let sun = U.sunColor * U.sunIntensity;
    let sky = U.ambientColor * U.ambientIntensity;
    let p = in.local * 1.3 + in.seed * 19.0;
    let grain = 0.5 * pNoise(p) + 0.3 * pNoise(p * 3.1) + 0.2 * pNoise(p * 9.0);
    var albedo = mix(vec3<f32>(0.055, 0.052, 0.05), vec3<f32>(0.15, 0.14, 0.125), grain);
    // Wet up to a little over the water, with a dark tide line.
    let wetness = 1.0 - smoothstep(0.05, 0.55, in.above);
    albedo *= mix(1.0, 0.45, wetness);
    let skyLight = 1.5 + 0.3 * dot(N, up);
    let col = albedo * (sky * skyLight + sun * max(dot(N, L), 0.0));
    return vec4<f32>(propAerial(col, in.wp), 1.0);
}
`;
}

// Spray. Particle: position (frame x, y, height), life; velocity, size.
export const WHITE_SPRAY_WGSL = (block) => /* wgsl */`
struct Particle { pos: vec3f, life: f32, vel: vec3f, size: f32 };
struct SprayU { time: f32, dt: f32, dx: f32, N: i32, count: u32, hmin: f32, rate: f32, pad: f32 };
@group(0) @binding(0) var<uniform> P: SprayU;
@group(0) @binding(1) var<storage, read> ST: array<vec4f>;
@group(0) @binding(2) var<storage, read> S: array<vec4f>;
@group(0) @binding(3) var<storage, read> BLOCKS: array<vec4i>;
@group(0) @binding(4) var<storage, read_write> PT: array<Particle>;
fn wrapC(a: i32) -> i32 { return select(select(a, a - P.N, a >= P.N), a + P.N, a < 0); }
fn ci(i: i32, j: i32) -> u32 { return u32(wrapC(j)) * u32(P.N) + u32(wrapC(i)); }
fn hash31(p: vec3f) -> f32 {
    var p3 = fract(p * 0.1031);
    p3 += dot(p3, p3.zyx + 31.32);
    return fract((p3.x + p3.y) * p3.z);
}
fn rnd(i: u32, k: f32) -> f32 { return hash31(vec3f(f32(i) * 0.0137 + k * 7.13, P.time * 2.17 + k * 1.91, k * 3.77 + 0.5)); }
@compute @workgroup_size(64)
fn spray(@builtin(global_invocation_id) gid: vec3u) {
    let i = gid.x;
    if (i >= arrayLength(&PT)) { return; }
    var p = PT[i];
    let dt = P.dt;
    if (p.life > 0.0) {
        p.life -= dt;
        p.vel.z -= 9.81 * dt * select(1.0, 0.25, p.size > 0.25);
        p.vel *= exp(-select(1.8, 3.6, p.size > 0.25) * dt);
        p.pos += p.vel * dt;
        p.size *= 1.0 + dt * select(0.2, 0.9, p.size > 0.25);
    } else if (P.count > 0u && rnd(i, 11.0) < P.rate) {
        // A random cell of a random stepped block; spawns only where it foams.
        let blk = BLOCKS[min(u32(rnd(i, 12.0) * f32(P.count)), P.count - 1u)];
        let lx = i32(rnd(i, 13.0) * ${block}.0); let ly = i32(rnd(i, 14.0) * ${block}.0);
        let id = ci(blk.z * ${block} + lx, blk.w * ${block} + ly);
        let s = S[id];
        if (s.x > 0.08 && s.w > 0.45) {
            let x = (f32(blk.x * ${block} + lx) + 0.5) * P.dx; let y = (f32(blk.y * ${block} + ly) + 0.5) * P.dx;
            let mist = rnd(i, 19.0) < 0.22;
            let burst = 0.6 + 2.4 * min(s.w, 1.3) * rnd(i, 15.0);
            p.pos = vec3f(x, y, ST[id * 2u].x + s.x + 0.05);
            p.vel = vec3f(s.y * 0.8 + (rnd(i, 16.0) - 0.5) * 1.4, s.z * 0.8 + (rnd(i, 17.0) - 0.5) * 1.4, burst);
            p.life = select(0.35 + 0.85 * rnd(i, 18.0), 0.9 + 1.4 * rnd(i, 18.0), mist);
            p.size = select(0.035 + 0.1 * rnd(i, 20.0), 0.3 + 0.55 * rnd(i, 20.0), mist);
        }
    }
    PT[i] = p;
}
`;

const SPRAY_VOUT = /* wgsl */`
struct SprayVOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) a: f32,
    @location(2) wp: vec3<f32>,
    @location(3) mist: f32,
};
`;

export function buildSprayVertexShader() {
    return HEAD + SPRAY_VOUT + /* wgsl */`
struct Particle { pos: vec3<f32>, life: f32, vel: vec3<f32>, size: f32 };
@group(1) @binding(1) var<storage, read> PT: array<Particle>;
@vertex
fn main(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> SprayVOut {
    var corners = array<vec2<f32>, 4>(vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, 1.0));
    let p = PT[ii];
    var o: SprayVOut;
    o.uv = vec2<f32>(0.0); o.a = 0.0; o.wp = vec3<f32>(0.0); o.mist = 0.0;
    if (p.life <= 0.0) { o.pos = vec4<f32>(0.0, 0.0, 2.0, 1.0); return o; }
    let c = corners[vi];
    let dir = whiteFrameDir(p.pos.xy);
    let centre = U.origin + dir * (U.R + p.pos.z);
    let V = normalize(U.cameraPos - centre);
    let right = normalize(cross(dir, V));
    let upv = cross(V, right);
    let wp = centre + (right * c.x + upv * c.y) * p.size;
    let view = U.viewMatrix * vec4<f32>(wp, 1.0);
    o.pos = U.projectionMatrix * view;
    o.uv = c; o.wp = wp;
    o.mist = select(0.0, 1.0, p.size > 0.25);
    o.a = clamp(p.life * 2.5, 0.0, 1.0) * (1.0 - smoothstep(W.nearFadeM.x, W.nearFadeM.y, distance(p.pos.xy, W.cameraXY)));
    return o;
}
`;
}

export function buildSprayFragmentShader() {
    return HEAD + SPRAY_VOUT + /* wgsl */`
// No atmosphere: spray ends with the simulation, under 150 m away.
@fragment
fn main(in: SprayVOut) -> @location(0) vec4<f32> {
    let d2 = dot(in.uv, in.uv);
    if (d2 > 1.0 || in.a <= 0.001) { discard; }
    let soft = exp(-d2 * 3.5) * (1.0 - d2);
    let a = in.a * soft * mix(0.42, 0.075, in.mist);
    let L = normalize(U.sunDir);
    let up = normalize(in.wp - U.origin);
    let col = vec3<f32>(0.95, 0.97, 1.0) * 0.5 * (U.ambientColor * U.ambientIntensity * 0.9 + U.sunColor * U.sunIntensity * (0.35 + 0.4 * max(dot(up, L), 0.0)));
    return vec4<f32>(col * a, a);
}
`;
}
export const WHITE_SPRAY_BYTES = WHITE_SPRAY_PARTICLES * SPRAY_SEC;
