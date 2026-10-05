// core/world/water/shallowWaterSim.wgsl.js
//
// Shallow-water solver (IMPLEMENTATION_PLAN 8.1), rebuilt from Whitewater's
// WGSL_SIM (../whitewater/js/shaders.js; ported once before as
// core/renderer/rivers/shaders/riverSimShader.wgsl.js). Same numerics:
// - staggered grid: h (and foam, k) at cell centres, u on the left face of
//   cell (i, j) at (i dx, (j + 0.5) dx), v on the bottom face at
//   ((i + 0.5) dx, j dx);
// - each substep: advect (semi-Lagrangian velocities, MacCormack option
//   with a min/max limiter; foam and k advected at centres), height (flux
//   form, upwind depth, outflow limited to outLimit * dx / dt per cell so h
//   stays >= 0; mass-conserving), momentum (pressure from eta = b + h with
//   wet/dry rules, semi-implicit Manning friction, turbulence forcing, foam
//   and turbulence sources).
// What changed for SphereCraft:
// - Boundaries: no hard-coded inflow rows or walls. Each domain edge is
//   closed (no flow) or open (zero gradient: the boundary face takes the
//   nearest interior face's velocity, ghost cells copy the edge cell); see
//   openMask. Per cell, a relaxation pulls (h, u, v) toward a target
//   (eta, u, v) at a rate (1/s): inflow, fixed lake/sea level, sponge.
// - The depth-change clamp (Whitewater's waterfall fix) is optional
//   (maxRise / maxFall 0 = off): it does not conserve mass where it acts.
// - No vortex.
// - Rows are a ring: logical row j lives in physical row (j + rowBase) mod L,
//   so a window moving along a river (WaterRiverSim.js) scrolls by
//   re-filling only the rows that enter; rowWorld (rows) keeps the
//   turbulence noise fixed to the ground meanwhile.
// WGSL: no ?: operator, select() only.

export const SWE_WORKGROUP = 8;

// openMask bits: which domain edges are open.
export const SWE_OPEN_LEFT = 1;    // i = 0
export const SWE_OPEN_RIGHT = 2;   // i = W
export const SWE_OPEN_BOTTOM = 4;  // j = 0
export const SWE_OPEN_TOP = 8;     // j = L

// SimParams layout (std140-compatible, 28 x 4 bytes).
export const SWE_PARAM_FLOATS = 28;

export const SHALLOW_WATER_WGSL = /* wgsl */`
struct SimParams {
  W: u32, L: u32, jOffset: u32, openMask: u32,
  dx: f32, dt: f32, g: f32, manning: f32,
  hmin: f32, umax: f32, time: f32, macCormack: f32,
  turbA: f32, turbL: f32, turbT: f32, foamDecay: f32,
  kDecay: f32, kGen: f32, foamGen: f32, maxRise: f32,
  maxFall: f32, outLimit: f32, kRelax: f32, _pad0: f32,
  rowBase: u32, rowWorld: f32, _pad1: f32, _pad2: f32,
};
@group(0) @binding(0) var<uniform> P: SimParams;
@group(0) @binding(1) var<storage, read> B: array<f32>;
@group(0) @binding(2) var<storage, read> SI: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> SO: array<vec4f>;
@group(0) @binding(4) var<storage, read> KI: array<f32>;
@group(0) @binding(5) var<storage, read_write> KO: array<f32>;
@group(0) @binding(6) var<storage, read> RX: array<vec4f>;   // (targetEta, targetU, targetV, rate 1/s)

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

fn isOpen(bit: u32) -> bool { return (P.openMask & bit) != 0u; }
// Cell index, clamped to the domain (ghost cells copy the edge cell); rows
// through the ring (rowBase).
fn ci(i: i32, j: i32) -> u32 {
  let ii = clamp(i, 0, i32(P.W) - 1);
  let r = u32(clamp(j, 0, i32(P.L) - 1)) + P.rowBase;
  return select(r, r - P.L, r >= P.L) * P.W + u32(ii);
}
// u on face i of row j (face i = left face of cell i), i in [0, W].
fn faceU(i: i32, j: i32) -> f32 {
  if (i <= 0) { return select(0.0, SI[ci(1, j)].y, isOpen(1u)); }
  if (i >= i32(P.W)) { return select(0.0, SI[ci(i32(P.W) - 1, j)].y, isOpen(2u)); }
  return SI[ci(i, j)].y;
}
// v on face j of column i (face j = bottom face of cell j), j in [0, L].
fn faceV(i: i32, j: i32) -> f32 {
  if (j <= 0) { return select(0.0, SI[ci(i, 1)].z, isOpen(4u)); }
  if (j >= i32(P.L)) { return select(0.0, SI[ci(i, i32(P.L) - 1)].z, isOpen(8u)); }
  return SI[ci(i, j)].z;
}

fn bilinU(gx: f32, gy: f32) -> f32 {
  let x0 = floor(gx); let y0 = floor(gy); let fx = gx - x0; let fy = gy - y0;
  let i0 = i32(x0); let j0 = i32(y0);
  return mix(mix(SI[ci(i0, j0)].y, SI[ci(i0 + 1, j0)].y, fx), mix(SI[ci(i0, j0 + 1)].y, SI[ci(i0 + 1, j0 + 1)].y, fx), fy);
}
fn bilinV(gx: f32, gy: f32) -> f32 {
  let x0 = floor(gx); let y0 = floor(gy); let fx = gx - x0; let fy = gy - y0;
  let i0 = i32(x0); let j0 = i32(y0);
  return mix(mix(SI[ci(i0, j0)].z, SI[ci(i0 + 1, j0)].z, fx), mix(SI[ci(i0, j0 + 1)].z, SI[ci(i0 + 1, j0 + 1)].z, fx), fy);
}
fn bilinF(gx: f32, gy: f32) -> f32 {
  let x0 = floor(gx); let y0 = floor(gy); let fx = gx - x0; let fy = gy - y0;
  let i0 = i32(x0); let j0 = i32(y0);
  return mix(mix(SI[ci(i0, j0)].w, SI[ci(i0 + 1, j0)].w, fx), mix(SI[ci(i0, j0 + 1)].w, SI[ci(i0 + 1, j0 + 1)].w, fx), fy);
}
fn bilinK(gx: f32, gy: f32) -> f32 {
  let x0 = floor(gx); let y0 = floor(gy); let fx = gx - x0; let fy = gy - y0;
  let i0 = i32(x0); let j0 = i32(y0);
  return mix(mix(KI[ci(i0, j0)], KI[ci(i0 + 1, j0)], fx), mix(KI[ci(i0, j0 + 1)], KI[ci(i0 + 1, j0 + 1)], fx), fy);
}
fn velAt(p: vec2f) -> vec2f {
  return vec2f(bilinU(p.x / P.dx, p.y / P.dx - 0.5), bilinV(p.x / P.dx - 0.5, p.y / P.dx));
}
fn facePosU(i: i32, j: i32) -> vec2f { return vec2f(f32(i) * P.dx, (f32(j) + 0.5) * P.dx); }
fn facePosV(i: i32, j: i32) -> vec2f { return vec2f((f32(i) + 0.5) * P.dx, f32(j) * P.dx); }
fn advU(p: vec2f) -> f32 { let pb = p - P.dt * velAt(p); return bilinU(pb.x / P.dx, pb.y / P.dx - 0.5); }
fn advV(p: vec2f) -> f32 { let pb = p - P.dt * velAt(p); return bilinV(pb.x / P.dx - 0.5, pb.y / P.dx); }

@compute @workgroup_size(8, 8)
fn advect(@builtin(global_invocation_id) gid: vec3u) {
  let i = i32(gid.x); let j = i32(gid.y) + i32(P.jOffset);
  if (i >= i32(P.W) || j >= i32(P.L)) { return; }
  let id = ci(i, j);
  let s = SI[id];
  let dx = P.dx; let dt = P.dt;
  let pu = facePosU(i, j);
  var u = advU(pu);
  let pv = facePosV(i, j);
  var v = advV(pv);
  if (P.macCormack > 0.5) {
    let vu = velAt(pu);
    let pf = pu + dt * vu;
    var gx = pf.x / dx; var gy = pf.y / dx - 0.5;
    var x0 = floor(gx); var y0 = floor(gy); var fx = gx - x0; var fy = gy - y0;
    var i0 = i32(x0); var j0 = i32(y0);
    let ub = mix(mix(advU(facePosU(i0, j0)), advU(facePosU(i0 + 1, j0)), fx),
                 mix(advU(facePosU(i0, j0 + 1)), advU(facePosU(i0 + 1, j0 + 1)), fx), fy);
    let pb = pu - dt * vu;
    let bi = i32(floor(pb.x / dx)); let bj = i32(floor(pb.y / dx - 0.5));
    let a0 = SI[ci(bi, bj)].y; let a1 = SI[ci(bi + 1, bj)].y; let a2 = SI[ci(bi, bj + 1)].y; let a3 = SI[ci(bi + 1, bj + 1)].y;
    u = clamp(u + 0.5 * (s.y - ub), min(min(a0, a1), min(a2, a3)), max(max(a0, a1), max(a2, a3)));
    let vv = velAt(pv);
    let pfv = pv + dt * vv;
    gx = pfv.x / dx - 0.5; gy = pfv.y / dx;
    x0 = floor(gx); y0 = floor(gy); fx = gx - x0; fy = gy - y0; i0 = i32(x0); j0 = i32(y0);
    let vb = mix(mix(advV(facePosV(i0, j0)), advV(facePosV(i0 + 1, j0)), fx),
                 mix(advV(facePosV(i0, j0 + 1)), advV(facePosV(i0 + 1, j0 + 1)), fx), fy);
    let pbv = pv - dt * vv;
    let q0 = i32(floor(pbv.x / dx - 0.5)); let q1 = i32(floor(pbv.y / dx));
    let c0 = SI[ci(q0, q1)].z; let c1 = SI[ci(q0 + 1, q1)].z; let c2 = SI[ci(q0, q1 + 1)].z; let c3 = SI[ci(q0 + 1, q1 + 1)].z;
    v = clamp(v + 0.5 * (s.z - vb), min(min(c0, c1), min(c2, c3)), max(max(c0, c1), max(c2, c3)));
  }
  let pc = vec2f((f32(i) + 0.5) * dx, (f32(j) + 0.5) * dx);
  let pcb = pc - dt * velAt(pc);
  let gcx = pcb.x / dx - 0.5; let gcy = pcb.y / dx - 0.5;
  SO[id] = vec4f(s.x, u, v, bilinF(gcx, gcy));
  KO[id] = bilinK(gcx, gcy);
}

// Scale on cell (i, j)'s outgoing fluxes so it never sends more than
// outLimit of its water per substep (keeps h >= 0). Each face flux uses
// the donor's scale on both sides, so the update conserves mass.
fn outScale(i: i32, j: i32) -> f32 {
  let outf = max(faceU(i + 1, j), 0.0) + max(-faceU(i, j), 0.0) + max(faceV(i, j + 1), 0.0) + max(-faceV(i, j), 0.0);
  let lim = P.outLimit * P.dx / P.dt;
  return select(1.0, lim / outf, outf > lim);
}

@compute @workgroup_size(8, 8)
fn height(@builtin(global_invocation_id) gid: vec3u) {
  let i = i32(gid.x); let j = i32(gid.y) + i32(P.jOffset);
  if (i >= i32(P.W) || j >= i32(P.L)) { return; }
  let id = ci(i, j);
  let s = SI[id];
  let h = s.x;
  let uL = faceU(i, j); let uR = faceU(i + 1, j);
  let vB = faceV(i, j); let vT = faceV(i, j + 1);
  let hL = SI[ci(i - 1, j)].x; let hR = SI[ci(i + 1, j)].x;
  let hB = SI[ci(i, j - 1)].x; let hT = SI[ci(i, j + 1)].x;
  let sc = outScale(i, j);
  let FL = select(uL * h * sc, uL * hL * outScale(i - 1, j), uL > 0.0);
  let FR = select(uR * hR * outScale(i + 1, j), uR * h * sc, uR > 0.0);
  let FB = select(vB * h * sc, vB * hB * outScale(i, j - 1), vB > 0.0);
  let FT = select(vT * hT * outScale(i, j + 1), vT * h * sc, vT > 0.0);
  var hNew = max(0.0, h - P.dt / P.dx * (FR - FL + FT - FB));
  // Optional depth-change cap (not mass-conserving where it acts).
  if (P.maxRise > 0.0) { hNew = min(hNew, h + P.maxRise * P.dt); }
  if (P.maxFall > 0.0) { hNew = max(hNew, h - P.maxFall * P.dt); }
  SO[id] = vec4f(hNew, s.y, s.z, s.w);
  KO[id] = KI[id];
}

fn noiseGrad(pl: vec2f, t: f32) -> vec2f {
  let e = 0.02;
  let p = pl + vec2f(0.0, P.rowWorld * P.dx);
  let n = vec3f(p / P.turbL, t / P.turbT);
  let n2 = vec3f(p / (P.turbL * 0.45) + vec2f(17.3, 9.1), t / (P.turbT * 0.6));
  let px = (noise3(n + vec3f(e, 0.0, 0.0)) - noise3(n - vec3f(e, 0.0, 0.0))) / (2.0 * e)
         + 0.5 * (noise3(n2 + vec3f(e, 0.0, 0.0)) - noise3(n2 - vec3f(e, 0.0, 0.0))) / (2.0 * e);
  let py = (noise3(n + vec3f(0.0, e, 0.0)) - noise3(n - vec3f(0.0, e, 0.0))) / (2.0 * e)
         + 0.5 * (noise3(n2 + vec3f(0.0, e, 0.0)) - noise3(n2 - vec3f(0.0, e, 0.0))) / (2.0 * e);
  return vec2f(px, py);
}

// Pressure update of a face velocity between cell a (upwind side) and cell
// b, with Whitewater's wet/dry rules: no flow between two dry cells; a wet
// cell only pushes into a dry one whose bed is below its surface.
fn pressureStep(vel: f32, ha: f32, ba: f32, hb: f32, bb: f32) -> f32 {
  let wetA = ha > P.hmin; let wetB = hb > P.hmin;
  let etaA = ba + ha; let etaB = bb + hb;
  var w = vel;
  if (!wetA && !wetB) { w = 0.0; }
  else if (wetA && wetB) { w -= P.g * P.dt * (etaB - etaA) / P.dx; }
  else if (wetA) { if (etaA <= bb) { w = 0.0; } else { w -= P.g * P.dt * (bb - etaA) / P.dx; w = max(w, 0.0); } }
  else { if (etaB <= ba) { w = 0.0; } else { w -= P.g * P.dt * (etaB - ba) / P.dx; w = min(w, 0.0); } }
  return w;
}

@compute @workgroup_size(8, 8)
fn momentum(@builtin(global_invocation_id) gid: vec3u) {
  let i = i32(gid.x); let j = i32(gid.y) + i32(P.jOffset);
  if (i >= i32(P.W) || j >= i32(P.L)) { return; }
  let id = ci(i, j);
  let s = SI[id];
  var h = s.x; let b = B[id];
  let dx = P.dx; let dt = P.dt; let g = P.g;

  // u on the left face (between cell i-1 and cell i).
  let sL = SI[ci(i - 1, j)]; let hL = sL.x; let bL = B[ci(i - 1, j)];
  var u = s.y;
  if (i == 0) {
    u = select(0.0, faceU(0, j), isOpen(1u));
  } else {
    u = pressureStep(u, hL, bL, h, b);
    let vavg = 0.25 * (sL.z + SI[ci(i - 1, j + 1)].z + s.z + SI[ci(i, j + 1)].z);
    let hf = max(0.5 * (hL + h), P.hmin);
    let spd = sqrt(u * u + vavg * vavg);
    u = u / (1.0 + dt * g * P.manning * P.manning * spd / pow(hf, 1.3333));
    let kf = 0.5 * (KI[ci(i - 1, j)] + KI[id]);
    if (P.turbA > 1e-4 && kf > 0.02 && hL > P.hmin && h > P.hmin) {
      u += dt * P.turbA * clamp(kf, 0.0, 1.0) * noiseGrad(facePosU(i, j), P.time).y;
    }
    u = clamp(u, -P.umax, P.umax);
  }

  // v on the bottom face (between cell j-1 and cell j).
  let sB = SI[ci(i, j - 1)]; let hB = sB.x; let bB = B[ci(i, j - 1)];
  var v = s.z;
  if (j == 0) {
    v = select(0.0, faceV(i, 0), isOpen(4u));
  } else {
    v = pressureStep(v, hB, bB, h, b);
    let uavg = 0.25 * (sB.y + SI[ci(i + 1, j - 1)].y + s.y + SI[ci(i + 1, j)].y);
    let hf = max(0.5 * (hB + h), P.hmin);
    let spd = sqrt(v * v + uavg * uavg);
    v = v / (1.0 + dt * g * P.manning * P.manning * spd / pow(hf, 1.3333));
    let kf = 0.5 * (KI[ci(i, j - 1)] + KI[id]);
    if (P.turbA > 1e-4 && kf > 0.02 && hB > P.hmin && h > P.hmin) {
      v += dt * P.turbA * clamp(kf, 0.0, 1.0) * (-noiseGrad(facePosV(i, j), P.time).x);
    }
    v = clamp(v, -P.umax, P.umax);
  }

  // Foam and turbulence: sources from Froude number, convergence, shear,
  // surface slope and emergent rocks (dry neighbours above the surface).
  var foam = s.w; var k = KI[id];
  if (h > P.hmin) {
    let sR = SI[ci(i + 1, j)]; let sT = SI[ci(i, j + 1)];
    let bR = B[ci(i + 1, j)]; let bT = B[ci(i, j + 1)];
    let uc = 0.5 * (s.y + faceU(i + 1, j)); let vc = 0.5 * (s.z + faceV(i, j + 1));
    let spd = length(vec2f(uc, vc));
    let Fr = spd / sqrt(g * h);
    let div = (faceU(i + 1, j) - s.y + faceV(i, j + 1) - s.z) / dx;
    let dudy = (sT.y - sB.y) / (2.0 * dx);
    let dvdx = (sR.z - sL.z) / (2.0 * dx);
    let shear = abs(dudy) + abs(dvdx);
    let eta = b + h;
    var rock = 0.0;
    if ((sR.x <= P.hmin && bR > eta) || (hL <= P.hmin && bL > eta) || (sT.x <= P.hmin && bT > eta) || (hB <= P.hmin && bB > eta)) { rock = 1.0; }
    let eR = select(eta, bR + sR.x, sR.x > P.hmin); let eL2 = select(eta, bL + hL, hL > P.hmin);
    let eT = select(eta, bT + sT.x, sT.x > P.hmin); let eB2 = select(eta, bB + hB, hB > P.hmin);
    let slopeMag = length(vec2f(eR - eL2, eT - eB2)) / (2.0 * dx);
    let foamSrc = P.foamGen * (max(0.0, Fr - 0.8) * 1.2 + max(0.0, -div) * 0.6
                               + max(0.0, slopeMag - 0.15) * 3.0 + rock * 0.8 * min(spd, 3.0) / 3.0);
    foam = min(1.5, foam * exp(-P.foamDecay * dt) + dt * foamSrc);
    // Rocks churn the water in proportion to the flow (Whitewater's
    // unscaled rock * 0.8 stirred still lakes at every shore: lab, 1.3 m/s
    // currents in a still bowl after 50 s).
    let kSrc = P.kGen * (shear * 0.4 + max(0.0, Fr - 0.6) * 0.6 + rock * 0.8 * min(spd, 3.0) / 3.0 + max(0.0, -div) * 0.5
                         + 0.12 * min(spd * spd / 16.0, 1.0));
    k = min(1.0, k * exp(-P.kDecay * dt) + dt * kSrc);
  } else { foam *= 0.9; k *= 0.8; }

  // Relaxation toward the target state (inflow, fixed level, sponge).
  let rx = RX[id];
  if (rx.w > 0.0) {
    let a = 1.0 - exp(-rx.w * dt);
    h = mix(h, max(0.0, rx.x - b), a);
    u = mix(u, rx.y, a);
    v = mix(v, rx.z, a);
    foam = foam * (1.0 - a);
    k = mix(k, P.kRelax, a);
  }
  SO[id] = vec4f(h, u, v, foam);
  KO[id] = k;
}
`;
