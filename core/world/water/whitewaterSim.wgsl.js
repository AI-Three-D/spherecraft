// core/world/water/whitewaterSim.wgsl.js
//
// Shallow-water kernels of the near whitewater (WhitewaterSim.js), from
// Whitewater's WGSL_SIM (../whitewater/js/shaders.js). Same numerics:
// - staggered grid: h, foam and turbulence k at cell centres, u on the left face
//   of a cell, v on the bottom face;
// - each substep: advect (semi-Lagrangian, MacCormack with a min/max limiter),
//   height (flux form, upwind depth, outflow limited so h stays >= 0, rate
//   limit below steep drops), momentum (pressure from eta = b + h with wet/dry
//   rules, semi-implicit Manning friction, turbulence forcing, foam and
//   turbulence sources).
// What differs:
// - The grid is a ring of cells on a tangent plane around the camera, in blocks
//   of BLOCK x BLOCK cells. Only listed blocks step (dispatches run over the
//   list), so cost follows the moving water in view, not the window.
// - Friction is per cell (riverFlow.js): the baked state is in balance.
// - No walls and no inflow rows: every block is initialised from the baked
//   state, and a sponge pulls cells at the edge of the stepped blocks back to
//   it, which is both the inflow and the outflow, wherever the river enters
//   or leaves the window, at any angle.
// WGSL: no ?: operator, select() only.

import { createRiverFieldWgsl } from './riverField.wgsl.js';
import { RIVER_FIELD } from './riverField.js';
import { WHITE_UNIFORMS_WGSL } from '../../renderer/water/whitewaterLook.wgsl.js';

export const WHITE_BLOCK = 32;
export const WHITE_SIM_PARAM_FLOATS = 32;
// Cells farther than this (signed distance, m) outside the baked water start dry, and
// with walls on they stay dry: the solver's water stays where the bake has water.
export const WHITE_DRY_SDF = -1.5;
const WORKGROUPS_PER_BLOCK = (WHITE_BLOCK / 8) ** 2;

// The baked state's last word: foam 0..1 on river water; on lake water minus (the
// lake's share 0..1 + twice the foam in 256ths), so a plume's foam survives the lake.
export const WHITE_BAKED_WORD_WGSL = /* wgsl */`
fn bakedWord(foam: f32, lake: f32) -> f32 { return select(foam, -(lake + 2.0 * round(foam * 255.0)), lake > 0.0); }
fn bakedFoam(w: f32) -> f32 { return select(w, floor(-w * 0.5) / 255.0, w < 0.0); }
fn bakedLake(w: f32) -> f32 { return select(0.0, -w - 2.0 * floor(-w * 0.5), w < 0.0); }
`;

const SIM_PARAMS = /* wgsl */`
${WHITE_BAKED_WORD_WGSL}
struct SimP {
  N: i32, G: i32, count: u32, pad0: u32,
  dx: f32, dt: f32, g: f32, hmin: f32,
  umax: f32, time: f32, macCormack: f32, turbA: f32,
  turbL: f32, turbT: f32, foamDecay: f32, kDecay: f32,
  kGen: f32, foamGen: f32, maxRise: f32, maxFall: f32,
  sponge: f32, roughM: f32, lakeHold: f32, lakeDrag: f32,
  rockSteerRate: f32, rockMode: f32, rockDragRate: f32, levelHold: f32,
  wallSdf: f32, pad5: f32, pad6: f32, pad7: f32,
};
@group(0) @binding(0) var<uniform> P: SimP;
// n^2 is under 2; the integer part stores an 8-bit rock weight: steering, or with
// rockMode drag (2) how much rock stands in the water there.
// This keeps the solver's existing static buffer and bind-group footprint.
fn whiteFriction(encoded: f32) -> f32 { return encoded - 2.0 * floor(encoded * 0.5); }
fn whiteRockSteer(encoded: f32) -> f32 { return floor(encoded * 0.5) / 255.0; }
fn wrapC(a: i32) -> i32 { return select(select(a, a - P.N, a >= P.N), a + P.N, a < 0); }
fn ci(i: i32, j: i32) -> u32 { return u32(wrapC(j)) * u32(P.N) + u32(wrapC(i)); }
`;

const NOISE = /* wgsl */`
fn hash21(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
fn noise2(p: vec2f) -> f32 {
  let i = floor(p); let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2f(1.0, 0.0)), u.x), mix(hash21(i + vec2f(0.0, 1.0)), hash21(i + vec2f(1.0, 1.0)), u.x), u.y);
}
fn hash31(p: vec3f) -> f32 {
  var p3 = fract(p * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
fn noise3(p: vec3f) -> f32 {
  let i = floor(p); let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let n000 = hash31(i); let n100 = hash31(i + vec3f(1.0, 0.0, 0.0));
  let n010 = hash31(i + vec3f(0.0, 1.0, 0.0)); let n110 = hash31(i + vec3f(1.0, 1.0, 0.0));
  let n001 = hash31(i + vec3f(0.0, 0.0, 1.0)); let n101 = hash31(i + vec3f(1.0, 0.0, 1.0));
  let n011 = hash31(i + vec3f(0.0, 1.0, 1.0)); let n111 = hash31(i + vec3f(1.0, 1.0, 1.0));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
             mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
`;

// Stepping: ST = (bed, n^2, h0, sdf) at 2 id, (W, u0, v0, foam0) at 2 id + 1;
// foam0 is minus the share of lake water where there is any (lakes have no foam).
export const WHITE_SIM_WGSL = SIM_PARAMS + NOISE + /* wgsl */`
@group(0) @binding(1) var<storage, read> ST: array<vec4f>;
@group(0) @binding(2) var<storage, read> SI: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> SO: array<vec4f>;
@group(0) @binding(4) var<storage, read> KI: array<f32>;
@group(0) @binding(5) var<storage, read_write> KO: array<f32>;
// Stepped blocks: global block x, y, ring block x, y.
@group(0) @binding(6) var<storage, read> BLOCKS: array<vec4i>;
// Per ring block: x how fully simulated (1) or held to the baked state (0), y as drawn.
@group(0) @binding(7) var<storage, read> GRID: array<vec2f>;
// Per ring block: the mean of the level over the baked level in its baked water, this
// frame (WHITE_MEAN_WGSL); 0 where a block does not step.
@group(0) @binding(8) var<storage, read> DEV: array<f32>;

struct Cell { i: i32, j: i32, x: f32, y: f32 };
fn cellOf(wg: u32, l: vec2u) -> Cell {
  let b = BLOCKS[wg / ${WORKGROUPS_PER_BLOCK}u];
  let sub = wg % ${WORKGROUPS_PER_BLOCK}u;
  let li = i32((sub % ${WHITE_BLOCK / 8}u) * 8u + l.x);
  let lj = i32((sub / ${WHITE_BLOCK / 8}u) * 8u + l.y);
  var c: Cell;
  c.i = b.z * ${WHITE_BLOCK} + li; c.j = b.w * ${WHITE_BLOCK} + lj;
  c.x = f32(b.x * ${WHITE_BLOCK} + li) * P.dx; c.y = f32(b.y * ${WHITE_BLOCK} + lj) * P.dx;
  return c;
}
fn bilinU(gx: f32, gy: f32) -> f32 {
  let x0 = floor(gx); let y0 = floor(gy); let fx = gx - x0; let fy = gy - y0;
  let i0 = i32(x0); let j0 = i32(y0);
  return mix(mix(SI[ci(i0,j0)].y, SI[ci(i0+1,j0)].y, fx), mix(SI[ci(i0,j0+1)].y, SI[ci(i0+1,j0+1)].y, fx), fy);
}
fn bilinV(gx: f32, gy: f32) -> f32 {
  let x0 = floor(gx); let y0 = floor(gy); let fx = gx - x0; let fy = gy - y0;
  let i0 = i32(x0); let j0 = i32(y0);
  return mix(mix(SI[ci(i0,j0)].z, SI[ci(i0+1,j0)].z, fx), mix(SI[ci(i0,j0+1)].z, SI[ci(i0+1,j0+1)].z, fx), fy);
}
fn bilinF(gx: f32, gy: f32) -> f32 {
  let x0 = floor(gx); let y0 = floor(gy); let fx = gx - x0; let fy = gy - y0;
  let i0 = i32(x0); let j0 = i32(y0);
  return mix(mix(SI[ci(i0,j0)].w, SI[ci(i0+1,j0)].w, fx), mix(SI[ci(i0,j0+1)].w, SI[ci(i0+1,j0+1)].w, fx), fy);
}
fn bilinK(gx: f32, gy: f32) -> f32 {
  let x0 = floor(gx); let y0 = floor(gy); let fx = gx - x0; let fy = gy - y0;
  let i0 = i32(x0); let j0 = i32(y0);
  return mix(mix(KI[ci(i0,j0)], KI[ci(i0+1,j0)], fx), mix(KI[ci(i0,j0+1)], KI[ci(i0+1,j0+1)], fx), fy);
}
// Containment (owner 2026-11-10: water over the banks, a pit in the river). The bake
// leaves dry, on purpose, low ground connected to a river past its reach (riverField.js
// wet fill, spillM); without walls the solver's water ran into such basins, draining
// the river into a pit 1-2 m under its level, and spread over the banks wherever its
// level rose. A cell the bake keeps dry (signed distance under wallSdf) is a wall:
// velocity on its faces is zero, so no water crosses into it.
fn wallAt(i: i32, j: i32) -> bool { return ST[ci(i, j) * 2u].w < P.wallSdf; }
fn closedU(i: i32, j: i32) -> bool { return wallAt(i - 1, j) || wallAt(i, j); }
fn closedV(i: i32, j: i32) -> bool { return wallAt(i, j - 1) || wallAt(i, j); }
// Positions here are in cells of the ring.
fn velAt(p: vec2f) -> vec2f { return vec2f(bilinU(p.x, p.y - 0.5), bilinV(p.x - 0.5, p.y)); }
fn facePosU(i: i32, j: i32) -> vec2f { return vec2f(f32(i), f32(j) + 0.5); }
fn facePosV(i: i32, j: i32) -> vec2f { return vec2f(f32(i) + 0.5, f32(j)); }
fn advU(p: vec2f) -> f32 { let pb = p - (P.dt / P.dx) * velAt(p); return bilinU(pb.x, pb.y - 0.5); }
fn advV(p: vec2f) -> f32 { let pb = p - (P.dt / P.dx) * velAt(p); return bilinV(pb.x - 0.5, pb.y); }

@compute @workgroup_size(8, 8)
fn advect(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_id) l: vec3u) {
  let c = cellOf(wg.x, l.xy);
  let i = c.i; let j = c.j;
  let id = ci(i, j);
  let s = SI[id];
  let cfl = P.dt / P.dx;
  let pu = facePosU(i, j);
  var u = advU(pu);
  let pv = facePosV(i, j);
  var v = advV(pv);
  if (P.macCormack > 0.5) {
    let vu = velAt(pu);
    let pf = pu + cfl * vu;
    var gx = pf.x; var gy = pf.y - 0.5;
    var x0 = floor(gx); var y0 = floor(gy); var fx = gx - x0; var fy = gy - y0;
    var i0 = i32(x0); var j0 = i32(y0);
    let ub = mix(mix(advU(facePosU(i0,j0)), advU(facePosU(i0+1,j0)), fx),
                 mix(advU(facePosU(i0,j0+1)), advU(facePosU(i0+1,j0+1)), fx), fy);
    let pb = pu - cfl * vu;
    let bi = i32(floor(pb.x)); let bj = i32(floor(pb.y - 0.5));
    let a0 = SI[ci(bi,bj)].y; let a1 = SI[ci(bi+1,bj)].y; let a2 = SI[ci(bi,bj+1)].y; let a3 = SI[ci(bi+1,bj+1)].y;
    u = clamp(u + 0.5 * (s.y - ub), min(min(a0,a1),min(a2,a3)), max(max(a0,a1),max(a2,a3)));
    let vv = velAt(pv);
    let pfv = pv + cfl * vv;
    gx = pfv.x - 0.5; gy = pfv.y;
    x0 = floor(gx); y0 = floor(gy); fx = gx - x0; fy = gy - y0; i0 = i32(x0); j0 = i32(y0);
    let vb = mix(mix(advV(facePosV(i0,j0)), advV(facePosV(i0+1,j0)), fx),
                 mix(advV(facePosV(i0,j0+1)), advV(facePosV(i0+1,j0+1)), fx), fy);
    let pbv = pv - cfl * vv;
    let q0 = i32(floor(pbv.x - 0.5)); let q1 = i32(floor(pbv.y));
    let c0 = SI[ci(q0,q1)].z; let c1 = SI[ci(q0+1,q1)].z; let c2 = SI[ci(q0,q1+1)].z; let c3 = SI[ci(q0+1,q1+1)].z;
    v = clamp(v + 0.5 * (s.z - vb), min(min(c0,c1),min(c2,c3)), max(max(c0,c1),max(c2,c3)));
  }
  let pc = vec2f(f32(i) + 0.5, f32(j) + 0.5);
  let pcb = pc - cfl * velAt(pc);
  // Closed faces stay closed through the height pass that follows.
  u = select(u, 0.0, closedU(i, j)); v = select(v, 0.0, closedV(i, j));
  SO[id] = vec4f(s.x, u, v, bilinF(pcb.x - 0.5, pcb.y - 0.5));
  KO[id] = bilinK(pcb.x - 0.5, pcb.y - 0.5);
}

fn outScale(i: i32, j: i32) -> f32 {
  let s = SI[ci(i, j)];
  let uR = SI[ci(i+1, j)].y; let uL = s.y;
  let vT = SI[ci(i, j+1)].z; let vB = s.z;
  let outf = max(uR, 0.0) + max(-uL, 0.0) + max(vT, 0.0) + max(-vB, 0.0);
  let lim = 0.8 * P.dx / P.dt;
  return select(1.0, lim / outf, outf > lim);
}
@compute @workgroup_size(8, 8)
fn height(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_id) l: vec3u) {
  let c = cellOf(wg.x, l.xy);
  let i = c.i; let j = c.j;
  let id = ci(i, j);
  let s = SI[id];
  let h = s.x;
  let uL = s.y; let uR = SI[ci(i+1, j)].y;
  let vB = s.z; let vT = SI[ci(i, j+1)].z;
  let hL = SI[ci(i-1, j)].x; let hR = SI[ci(i+1, j)].x;
  let hB = SI[ci(i, j-1)].x; let hT = SI[ci(i, j+1)].x;
  let sc = outScale(i, j);
  let FL = select(uL * h * sc, uL * hL * outScale(i-1, j), uL > 0.0);
  let FR = select(uR * hR * outScale(i+1, j), uR * h * sc, uR > 0.0);
  let FB = select(vB * h * sc, vB * hB * outScale(i, j-1), vB > 0.0);
  let FT = select(vT * hT * outScale(i, j+1), vT * h * sc, vT > 0.0);
  let hRaw = max(0.0, h - P.dt / P.dx * (FR - FL + FT - FB));
  // Rate limit: outScale caps drain but not fill, so a cell below a steep drop can otherwise spike.
  let hNew = clamp(hRaw, h - P.maxFall * P.dt, h + P.maxRise * P.dt);
  SO[id] = vec4f(hNew, s.y, s.z, s.w);
  KO[id] = KI[id];
}

fn noiseGrad(p: vec2f, t: f32) -> vec2f {
  let e = 0.02;
  let n = vec3f(p / P.turbL, t / P.turbT);
  let n2 = vec3f(p / (P.turbL * 0.45) + vec2f(17.3, 9.1), t / (P.turbT * 0.6));
  let px = (noise3(n + vec3f(e,0.0,0.0)) - noise3(n - vec3f(e,0.0,0.0))) / (2.0 * e)
         + 0.5 * (noise3(n2 + vec3f(e,0.0,0.0)) - noise3(n2 - vec3f(e,0.0,0.0))) / (2.0 * e);
  let py = (noise3(n + vec3f(0.0,e,0.0)) - noise3(n - vec3f(0.0,e,0.0))) / (2.0 * e)
         + 0.5 * (noise3(n2 + vec3f(0.0,e,0.0)) - noise3(n2 - vec3f(0.0,e,0.0))) / (2.0 * e);
  return vec2f(px, py);
}
fn bedOf(i: i32, j: i32) -> f32 { return ST[ci(i, j) * 2u].x; }
fn frictionOf(i: i32, j: i32) -> f32 { return whiteFriction(ST[ci(i, j) * 2u].y); }
// How far a cell is held to the baked state, 0 free .. 1 held: the stepped
// blocks' weights, bilinear between block centres.
fn heldAt(i: i32, j: i32) -> f32 {
  let B = f32(${WHITE_BLOCK});
  let gx = (f32(i) + 0.5) / B - 0.5; let gy = (f32(j) + 0.5) / B - 0.5;
  let x0 = floor(gx); let y0 = floor(gy); let fx = gx - x0; let fy = gy - y0;
  let G = P.G;
  let a = i32(x0); let b = i32(y0);
  let ax = select(select(a, a - G, a >= G), a + G, a < 0); let ax1 = select(ax + 1, 0, ax + 1 >= G);
  let by = select(select(b, b - G, b >= G), b + G, b < 0); let by1 = select(by + 1, 0, by + 1 >= G);
  let w = mix(mix(GRID[by * G + ax].x, GRID[by * G + ax1].x, fx), mix(GRID[by1 * G + ax].x, GRID[by1 * G + ax1].x, fx), fy);
  return 1.0 - w;
}
// The blocks' mean level over the baked one, bilinear between block centres.
fn devAt(i: i32, j: i32) -> f32 {
  let B = f32(${WHITE_BLOCK});
  let gx = (f32(i) + 0.5) / B - 0.5; let gy = (f32(j) + 0.5) / B - 0.5;
  let x0 = floor(gx); let y0 = floor(gy); let fx = gx - x0; let fy = gy - y0;
  let G = P.G;
  let a = i32(x0); let b = i32(y0);
  let ax = select(select(a, a - G, a >= G), a + G, a < 0); let ax1 = select(ax + 1, 0, ax + 1 >= G);
  let by = select(select(b, b - G, b >= G), b + G, b < 0); let by1 = select(by + 1, 0, by + 1 >= G);
  return mix(mix(DEV[by * G + ax], DEV[by * G + ax1], fx), mix(DEV[by1 * G + ax], DEV[by1 * G + ax1], fx), fy);
}

@compute @workgroup_size(8, 8)
fn momentum(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_id) l: vec3u) {
  let c = cellOf(wg.x, l.xy);
  let i = c.i; let j = c.j;
  let id = ci(i, j);
  let s = SI[id];
  let st0 = ST[id * 2u];
  let h = s.x; let b = st0.x;
  let dx = P.dx; let dt = P.dt; let g = P.g;
  // The left and lower cells' static rows: their bed, and their signed distance for the walls.
  let stL = ST[ci(i-1, j) * 2u]; let stB = ST[ci(i, j-1) * 2u];
  let sL = SI[ci(i-1, j)]; let hL = sL.x; let bL = stL.x;
  var u = s.y;
  {
    let wetL = hL > P.hmin; let wetR = h > P.hmin;
    let etaL = bL + hL; let etaR = b + h;
    if (!wetL && !wetR) { u = 0.0; }
    else if (wetL && wetR) { u -= g * dt * (etaR - etaL) / dx; }
    else if (wetL) { if (etaL <= b) { u = 0.0; } else { u -= g * dt * (b - etaL) / dx; u = max(u, 0.0); } }
    else { if (etaR <= bL) { u = 0.0; } else { u -= g * dt * (etaR - bL) / dx; u = min(u, 0.0); } }
    let vavg = 0.25 * (sL.z + SI[ci(i-1, j+1)].z + s.z + SI[ci(i, j+1)].z);
    let hf = max(0.5 * (hL + h), P.hmin);
    let spd = sqrt(u * u + vavg * vavg);
    let n2 = 0.5 * (frictionOf(i-1, j) + whiteFriction(st0.y));
    u = u / (1.0 + dt * g * n2 * spd / pow(hf, 1.3333));
    let kf = 0.5 * (KI[ci(i-1, j)] + KI[id]);
    if (P.turbA > 1e-4 && kf > 0.02 && wetL && wetR) {
      let gr = noiseGrad(vec2f(c.x, c.y + 0.5 * dx), P.time);
      u += dt * P.turbA * clamp(kf, 0.0, 1.0) * gr.y;
    }
    u = clamp(u, -P.umax, P.umax);
  }
  let sB = SI[ci(i, j-1)]; let hB = sB.x; let bB = stB.x;
  var v = s.z;
  {
    let wetB = hB > P.hmin; let wetT = h > P.hmin;
    let etaB = bB + hB; let etaT = b + h;
    if (!wetB && !wetT) { v = 0.0; }
    else if (wetB && wetT) { v -= g * dt * (etaT - etaB) / dx; }
    else if (wetB) { if (etaB <= b) { v = 0.0; } else { v -= g * dt * (b - etaB) / dx; v = max(v, 0.0); } }
    else { if (etaT <= bB) { v = 0.0; } else { v -= g * dt * (etaT - bB) / dx; v = min(v, 0.0); } }
    let uavg = 0.25 * (sB.y + SI[ci(i+1, j-1)].y + s.y + SI[ci(i+1, j)].y);
    let hf = max(0.5 * (hB + h), P.hmin);
    let spd = sqrt(v * v + uavg * uavg);
    let n2 = 0.5 * (frictionOf(i, j-1) + whiteFriction(st0.y));
    v = v / (1.0 + dt * g * n2 * spd / pow(hf, 1.3333));
    let kf = 0.5 * (KI[ci(i, j-1)] + KI[id]);
    if (P.turbA > 1e-4 && kf > 0.02 && wetB && wetT) {
      let gr = noiseGrad(vec2f(c.x + 0.5 * dx, c.y), P.time);
      v += dt * P.turbA * clamp(kf, 0.0, 1.0) * (-gr.x);
    }
    v = clamp(v, -P.umax, P.umax);
  }
  let baked = ST[id * 2u + 1u];
  let rockSteer = whiteRockSteer(st0.y);
  if (rockSteer > 0.0 && h > P.hmin) {
    if (P.rockMode > 1.5) {
      // Drag: the rock standing in the water holds it still; the flow goes round.
      let a = exp(-P.rockDragRate * rockSteer * dt);
      u *= a; v *= a;
    } else {
      // Steer: a soft local field keeps subcritical rocks in the flow without
      // raising the solver bed into a dam. Solid rocks still use physical bed
      // obstacles. The baked target turns around the rock and rejoins downstream.
      let a = 1.0 - exp(-P.rockSteerRate * rockSteer * dt);
      u = mix(u, baked.y, a); v = mix(v, baked.z, a);
    }
  }
  var foam = s.w; var k = KI[id];
  if (h > P.hmin) {
    let sR = SI[ci(i+1, j)]; let sT = SI[ci(i, j+1)];
    let bR = bedOf(i+1, j); let bT = bedOf(i, j+1);
    let uc = 0.5 * (s.y + sR.y); let vc = 0.5 * (s.z + sT.z);
    let spd = length(vec2f(uc, vc));
    let Fr = spd / sqrt(g * h);
    let div = (sR.y - s.y + sT.z - s.z) / dx;
    let dudy = (sT.y - sB.y) / (2.0 * dx);
    let dvdx = (sR.z - sL.z) / (2.0 * dx);
    let shear = abs(dudy) + abs(dvdx);
    let eta = b + h;
    var rock = 0.0;
    // A face, not a beach: a shore rises a few centimetres a cell.
    let face = eta + 0.15;
    if ((sR.x <= P.hmin && bR > face) || (hL <= P.hmin && bL > face) || (sT.x <= P.hmin && bT > face) || (hB <= P.hmin && bB > face)) { rock = 1.0; }
    // A drag rock (rockMode drag) has no dry face: where it stands in the water.
    if (P.rockMode > 1.5) { rock = max(rock, rockSteer); }
    let eR = select(eta, bR + sR.x, sR.x > P.hmin); let eL2 = select(eta, bL + hL, hL > P.hmin);
    let eT = select(eta, bT + sT.x, sT.x > P.hmin); let eB2 = select(eta, bB + hB, hB > P.hmin);
    let slopeMag = length(vec2f(eR - eL2, eT - eB2)) / (2.0 * dx);
    // Whitewater's foam sources. Its rivers fall 3 %; here the mean fall reaches
    // 50 %, so only the fall beyond the reach's own (baked foam stands for it) counts.
    let slopeFloor = 0.15 + 0.5 * bakedFoam(baked.w);
    // Foam needs depth and a current. Thin water reads as supercritical at any
    // speed, and on a lake's beach that drew a standing line of foam along the shore,
    // half a metre out of the water (wwFoamSources: Froude term, median depth 0.16 m).
    let body = smoothstep(0.12, 0.5, h) * smoothstep(0.1, 0.5, length(baked.yz));
    let foamSrc = P.foamGen * (body * (max(0.0, Fr - 0.8) * 1.2 + max(0.0, -div) * 0.6
                               + max(0.0, slopeMag - slopeFloor) * 3.0) + rock * 0.8 * min(spd, 3.0) / 3.0);
    foam = min(1.5, foam * exp(-P.foamDecay * dt) + dt * foamSrc);
    let kSrc = P.kGen * (shear * 0.4 + max(0.0, Fr - 0.6) * 0.6 + rock * 0.8 + max(0.0, -div) * 0.5
                         + 0.12 * min(spd * spd / 16.0, 1.0));
    k = min(1.0, k * exp(-P.kDecay * dt) + dt * kSrc);
  } else { foam *= 0.9; k *= 0.8; }
  // Toward the edge of the stepped blocks the baked state takes over.
  let held = heldAt(i, j);
  let foam0 = bakedFoam(baked.w);
  var hOut = h;
  if (held > 0.001) {
    let a = 1.0 - exp(-P.sponge * held * dt);
    hOut = mix(h, st0.z, a); u = mix(u, baked.y, a); v = mix(v, baked.z, a); foam = mix(foam, foam0, a); k = mix(k, foam0 * 0.6, a);
  }
  // A lake is a reservoir: its level does not answer to a river. The baked flow stops in
  // it, and with the water kept here it piled up at the mouth on arrival and ran back up
  // the river as a surge (wwSurge: +-0.3 m for 10 s). The river's momentum dies out more slowly.
  let lake = bakedLake(baked.w);
  if (lake > 0.0) {
    hOut = mix(hOut, st0.z, 1.0 - exp(-P.lakeHold * lake * dt));
    let drag = 1.0 - exp(-P.lakeDrag * lake * dt);
    u = mix(u, baked.y, drag); v = mix(v, baked.z, drag);
    // Foam goes with it: carried on, it gathered in a line where the flow stalls at the
    // edge of the stepped blocks, across the lake.
    let fade = exp(-1.5 * P.lakeDrag * lake * dt);
    foam = mix(foam0, foam, fade); k = mix(foam0 * 0.6, k, fade);
  }
  // The level held to the baked one on average only (owner 2026-11-10: water piling against
  // rocks, flowing round them, wakes and foam are what the solver is for; a band, a monotone cap
  // and a backflow clamp per cell flattened all of it). The baked state is not quite the solver's
  // steady state: on a reach held flat at its lake's level, with rocks in the bed, the level rose
  // 0.25-0.35 m (+13 % of the water in 40 s), ran uphill along the river and over the banks. A
  // block's mean over the baked level drains at levelHold (1/s): a rock's pile-up and its wake
  // hardly move a 16 m block's mean, a whole reach's rise does. A deficit stays: rapids run
  // shallower and faster than baked (21 % less water in 40 s), their rocks out of the water, the
  // look the owner chose; filled to the baked level, those rocks sank to dark discs.
  if (P.levelHold > 0.0 && hOut > 0.0 && st0.z > 0.0) {
    hOut = max(0.0, hOut - (1.0 - exp(-P.levelHold * dt)) * max(devAt(i, j), 0.0));
  }
  // Walls hold no water, and the sponge or a lake's drag must not open their faces.
  let wall = st0.w < P.wallSdf;
  if (wall) { hOut = 0.0; }
  u = select(u, 0.0, wall || stL.w < P.wallSdf); v = select(v, 0.0, wall || stB.w < P.wallSdf);
  SO[id] = vec4f(hOut, u, v, foam);
  KO[id] = k;
}
`;

// Per stepped block, once a frame: the mean of the level over the baked level W in its
// baked water (h0 > 0, wet now), into DEV at its ring slot (WhitewaterSim.js clears DEV
// first, so blocks that do not step read 0).
export const WHITE_MEAN_WGSL = SIM_PARAMS + /* wgsl */`
@group(0) @binding(1) var<storage, read> ST: array<vec4f>;
@group(0) @binding(2) var<storage, read> S: array<vec4f>;
@group(0) @binding(3) var<storage, read> BLOCKS: array<vec4i>;
@group(0) @binding(4) var<storage, read_write> DEV: array<f32>;
var<workgroup> acc: array<vec2f, 256>;
@compute @workgroup_size(256)
fn blockMean(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) li: u32) {
  let b = BLOCKS[wg.x];
  var s = vec2f(0.0);
  for (var k = 0u; k < ${WHITE_BLOCK * WHITE_BLOCK / 256}u; k++) {
    let t = li * ${WHITE_BLOCK * WHITE_BLOCK / 256}u + k;
    let id = ci(b.z * ${WHITE_BLOCK} + i32(t % ${WHITE_BLOCK}u), b.w * ${WHITE_BLOCK} + i32(t / ${WHITE_BLOCK}u));
    let h = S[id].x; let st0 = ST[id * 2u];
    // Each cell counts at most 0.5 m either way: a few odd cells (a sliver of baked water over a
    // hollow, filled from the river) cannot move a block's mean, and drain the river with it.
    if (h > P.hmin && st0.z > 0.0) { s += vec2f(clamp(st0.x + h - ST[id * 2u + 1u].x, -0.5, 0.5), 1.0); }
  }
  acc[li] = s;
  workgroupBarrier();
  for (var w = 128u; w > 0u; w = w >> 1u) {
    if (li < w) { acc[li] += acc[li + w]; }
    workgroupBarrier();
  }
  if (li == 0u) { DEV[u32(b.w) * u32(P.G) + u32(b.z)] = select(0.0, acc[0].x / max(acc[0].y, 1.0), acc[0].y > 0.0); }
}
`;

// A batch of new blocks: their directions, then (after the terrain's height at
// them, HydrologyGrid.js) the bed and the baked state. Batch word layout: per
// block 8 i32: global x, y, ring x, y, first rock, rock count, 0, 0; the list
// of rock indices follows at wordsOffset.
export const WHITE_DIRS_WGSL = SIM_PARAMS + WHITE_UNIFORMS_WGSL + /* wgsl */`
@group(0) @binding(1) var<uniform> W: WhiteU;
@group(0) @binding(2) var<storage, read> BATCH: array<i32>;
@group(0) @binding(3) var<storage, read_write> DIRS: array<vec4f>;
@compute @workgroup_size(64)
fn dirs(@builtin(global_invocation_id) gid: vec3u) {
  let cells = ${WHITE_BLOCK * WHITE_BLOCK}u;
  let k = gid.x;
  if (k >= P.count * cells) { return; }
  let bi = k / cells; let t = k % cells;
  let gx = BATCH[bi * 8u] * ${WHITE_BLOCK} + i32(t % ${WHITE_BLOCK}u);
  let gy = BATCH[bi * 8u + 1u] * ${WHITE_BLOCK} + i32(t / ${WHITE_BLOCK}u);
  DIRS[k] = vec4f(whiteFrameDir(vec2f((f32(gx) + 0.5) * P.dx, (f32(gy) + 0.5) * P.dx)), 0.0);
}
`;

const FIELD_BINDINGS = Object.freeze({ table: 0, texels: 1, params: 2, flow: 3 });
export const WHITE_INIT_WGSL = SIM_PARAMS + NOISE + WHITE_UNIFORMS_WGSL
    + createRiverFieldWgsl({ group: 1, b: FIELD_BINDINGS, page: RIVER_FIELD.page, apron: RIVER_FIELD.apron }) + /* wgsl */`
@group(0) @binding(1) var<uniform> W: WhiteU;
@group(0) @binding(2) var<storage, read> BATCH: array<i32>;
@group(0) @binding(3) var<storage, read> HEIGHTS: array<f32>;
// Rocks in the frame: x, y, radius, top; base, seed, water level, kind (0 steered,
// 1 a wall in the bed, 2 drag: WhitewaterSim.js rockMode).
@group(0) @binding(4) var<storage, read> ROCKS: array<vec4f>;
// Water kept over a drag rock's cap (m): the cells stay wet.
const ROCK_KEEP_M: f32 = 0.1;
@group(0) @binding(5) var<storage, read_write> ST: array<vec4f>;
@group(0) @binding(6) var<storage, read_write> STATE: array<vec4f>;
@group(0) @binding(7) var<storage, read_write> KALL: array<f32>;

@compute @workgroup_size(64)
fn init(@builtin(global_invocation_id) gid: vec3u) {
  let cells = ${WHITE_BLOCK * WHITE_BLOCK}u;
  let k = gid.x;
  if (k >= P.count * cells) { return; }
  let bi = k / cells; let t = k % cells;
  let lx = i32(t % ${WHITE_BLOCK}u); let ly = i32(t / ${WHITE_BLOCK}u);
  let gx = BATCH[bi * 8u] * ${WHITE_BLOCK} + lx;
  let gy = BATCH[bi * 8u + 1u] * ${WHITE_BLOCK} + ly;
  let id = ci(BATCH[bi * 8u + 2u] * ${WHITE_BLOCK} + lx, BATCH[bi * 8u + 3u] * ${WHITE_BLOCK} + ly);
  let xy = vec2f((f32(gx) + 0.5) * P.dx, (f32(gy) + 0.5) * P.dx);
  let dir = whiteFrameDir(xy);
  let ground = HEIGHTS[k];
  let spot = riverFieldLocate(dir);
  var level = ground - 1.0; var sdf = -16.0;
  var vel = vec2f(0.0); var foam = 0.0; var manning = 0.035; var lake = 0.0;
  if (spot.slot >= 0) {
    let f = riverFieldWater(dir);
    level = f.y; sdf = f.z;
    let fl = riverFlowAt(dir);
    let fu = riverFieldFace(dir);
    let world = riverFlowWorld(u32(fu.face), spot.tx + 0.5, spot.ty + 0.5, fl.x, fl.y);
    vel = vec2f(dot(world, W.e1), dot(world, W.e2));
    foam = fl.z; manning = max(fl.w, 0.02); lake = clamp(-fl.w, 0.0, 1.0);
  }
  // The solver's own bed: the tiles' ground, roughened where the water falls
  // (submerged, so the tiles need not show it), and the rocks.
  var bed = ground;
  let rough = P.roughM * smoothstep(0.05, 0.6, foam) * smoothstep(0.2, 1.2, level - ground);
  bed += rough * ((noise2(xy * 0.31) - 0.5) * 1.4 + (noise2(xy * 0.83 + 7.0) - 0.5) * 0.7);
  let first = BATCH[bi * 8u + 4u]; let count = BATCH[bi * 8u + 5u];
  var steer = 0.0;
  for (var r = 0; r < count; r++) {
    let q = BATCH[first + r];
    let a = ROCKS[q * 2]; let b = ROCKS[q * 2 + 1];
    let d = length(xy - a.xy) / a.z;
    if (b.w > 1.5) {
      // Drag: the dome capped ROCK_KEEP_M under the water, so the cells stay wet; how far
      // the rock stands above that is its weight (the momentum step damps the flow by it).
      if (d < 1.0) {
        let dome = b.x + (a.w - b.x) * sqrt(1.0 - d * d);
        let cap = level - ROCK_KEEP_M;
        bed = max(bed, min(dome, cap));
        steer = max(steer, smoothstep(0.0, 0.25, dome - cap));
      }
    } else if (b.w > 0.5) {
      if (d < 1.0) { bed = max(bed, b.x + (a.w - b.x) * sqrt(1.0 - d * d)); }
    } else if (d < 4.0 && length(vel) > 0.05) {
      let strength = 1.0 - smoothstep(-0.15, 0.35, b.z - a.w);
      let falloff = 1.0 - smoothstep(2.0, 4.0, d);
      let direction = normalize(vel); let side = vec2f(-direction.y, direction.x);
      let relative = xy - a.xy; let x = dot(relative, direction); let y = dot(relative, side);
      let den = max(dot(relative, relative), a.z * a.z);
      let k = min(0.25, 0.25 * strength * falloff * a.z * a.z / den);
      let dx = -k * (x * x - y * y) / den; let dy = -2.0 * k * x * y / den;
      vel += length(vel) * (direction * dx + side * dy);
      steer = max(steer, strength * falloff);
    }
  }
  var h0 = 0.0;
  if (sdf > ${WHITE_DRY_SDF.toFixed(2)}) { h0 = max(level - bed, 0.0); }
  if (h0 < 0.05) { h0 = 0.0; }
  let wet = select(0.0, 1.0, h0 > 0.0);
  let state = vec4f(h0, vel.x * wet, vel.y * wet, foam * wet);
  ST[id * 2u] = vec4f(bed, manning * manning + 2.0 * round(clamp(steer, 0.0, 1.0) * 255.0), h0, sdf);
  ST[id * 2u + 1u] = vec4f(level, vel.x * wet, vel.y * wet, bakedWord(foam * wet, lake));
  STATE[id] = state;
  KALL[id] = foam * wet * 0.6;
}
`;

// The new blocks' state into the other two buffers of the ping-pong: until they
// step, their neighbours read whichever is current.
export const WHITE_SPREAD_WGSL = SIM_PARAMS + /* wgsl */`
@group(0) @binding(1) var<storage, read> BATCH: array<i32>;
@group(0) @binding(2) var<storage, read> S0: array<vec4f>;
@group(0) @binding(3) var<storage, read> K0: array<f32>;
@group(0) @binding(4) var<storage, read_write> S1: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> S2: array<vec4f>;
@group(0) @binding(6) var<storage, read_write> K1: array<f32>;
@group(0) @binding(7) var<storage, read_write> K2: array<f32>;
@compute @workgroup_size(64)
fn spread(@builtin(global_invocation_id) gid: vec3u) {
  let cells = ${WHITE_BLOCK * WHITE_BLOCK}u;
  let k = gid.x;
  if (k >= P.count * cells) { return; }
  let bi = k / cells; let t = k % cells;
  let id = ci(BATCH[bi * 8u + 2u] * ${WHITE_BLOCK} + i32(t % ${WHITE_BLOCK}u), BATCH[bi * 8u + 3u] * ${WHITE_BLOCK} + i32(t / ${WHITE_BLOCK}u));
  S1[id] = S0[id]; S2[id] = S0[id]; K1[id] = K0[id]; K2[id] = K0[id];
}
`;
