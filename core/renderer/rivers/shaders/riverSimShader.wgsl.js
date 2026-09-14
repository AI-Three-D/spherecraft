// core/renderer/rivers/shaders/riverSimShader.wgsl.js
//
// GPU shallow-water solver, ported from whitewater's WGSL_SIM
// (whitewater/js/shaders.js). Trimmed for the walking-skeleton increment:
//   - no scrolling window (jOffset removed, full grid every dispatch)
//   - no vortex forcing (vortexVel() and its call sites removed)
// Everything else (advect/height/momentum, boundary inflow, foam/turbulence
// source terms) is unchanged from the original.

import { RIVER_WGSL_NOISE } from './riverNoise.wgsl.js';

export const RIVER_WGSL_SIM = RIVER_WGSL_NOISE + /* wgsl */`
struct SimU {
  W: u32, L: u32, dx: f32, dt: f32,
  g: f32, manning: f32, hmin: f32, umax: f32,
  time: f32, inEta: f32, inQ: f32, inVelScale: f32,
  turbA: f32, turbL: f32, turbT: f32, foamDecay: f32,
  kDecay: f32, macCormack: f32, kGen: f32, foamGen: f32,
  maxRise: f32, maxFall: f32, _pad0: f32, _pad1: f32,
};
@group(0) @binding(0) var<uniform> P: SimU;
@group(0) @binding(1) var<storage, read> B: array<f32>;
@group(0) @binding(2) var<storage, read> SI: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> SO: array<vec4f>;
@group(0) @binding(4) var<storage, read> KI: array<f32>;
@group(0) @binding(5) var<storage, read_write> KO: array<f32>;
fn ci(i: i32, j: i32) -> u32 {
  let ii = clamp(i, 0, i32(P.W) - 1);
  let jj = clamp(j, 0, i32(P.L) - 1);
  return u32(jj) * P.W + u32(ii);
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
fn velAt(p: vec2f) -> vec2f {
  return vec2f(bilinU(p.x / P.dx, p.y / P.dx - 0.5), bilinV(p.x / P.dx - 0.5, p.y / P.dx));
}
fn facePosU(i: i32, j: i32) -> vec2f { return vec2f(f32(i) * P.dx, (f32(j) + 0.5) * P.dx); }
fn facePosV(i: i32, j: i32) -> vec2f { return vec2f((f32(i) + 0.5) * P.dx, f32(j) * P.dx); }
fn advU(p: vec2f) -> f32 { let pb = p - P.dt * velAt(p); return bilinU(pb.x / P.dx, pb.y / P.dx - 0.5); }
fn advV(p: vec2f) -> f32 { let pb = p - P.dt * velAt(p); return bilinV(pb.x / P.dx - 0.5, pb.y / P.dx); }
@compute @workgroup_size(8, 8)
fn advect(@builtin(global_invocation_id) gid: vec3u) {
  let i = i32(gid.x); let j = i32(gid.y);
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
    let ub = mix(mix(advU(facePosU(i0,j0)), advU(facePosU(i0+1,j0)), fx),
                 mix(advU(facePosU(i0,j0+1)), advU(facePosU(i0+1,j0+1)), fx), fy);
    let pb = pu - dt * vu;
    let bi = i32(floor(pb.x / dx)); let bj = i32(floor(pb.y / dx - 0.5));
    let a0 = SI[ci(bi,bj)].y; let a1 = SI[ci(bi+1,bj)].y; let a2 = SI[ci(bi,bj+1)].y; let a3 = SI[ci(bi+1,bj+1)].y;
    u = clamp(u + 0.5 * (s.y - ub), min(min(a0,a1),min(a2,a3)), max(max(a0,a1),max(a2,a3)));
    let vv = velAt(pv);
    let pfv = pv + dt * vv;
    gx = pfv.x / dx - 0.5; gy = pfv.y / dx;
    x0 = floor(gx); y0 = floor(gy); fx = gx - x0; fy = gy - y0; i0 = i32(x0); j0 = i32(y0);
    let vb = mix(mix(advV(facePosV(i0,j0)), advV(facePosV(i0+1,j0)), fx),
                 mix(advV(facePosV(i0,j0+1)), advV(facePosV(i0+1,j0+1)), fx), fy);
    let pbv = pv - dt * vv;
    let q0 = i32(floor(pbv.x / dx - 0.5)); let q1 = i32(floor(pbv.y / dx));
    let c0 = SI[ci(q0,q1)].z; let c1 = SI[ci(q0+1,q1)].z; let c2 = SI[ci(q0,q1+1)].z; let c3 = SI[ci(q0+1,q1+1)].z;
    v = clamp(v + 0.5 * (s.z - vb), min(min(c0,c1),min(c2,c3)), max(max(c0,c1),max(c2,c3)));
  }
  let pc = vec2f((f32(i) + 0.5) * dx, (f32(j) + 0.5) * dx);
  let pcb = pc - dt * velAt(pc);
  let gcx = pcb.x / dx - 0.5; let gcy = pcb.y / dx - 0.5;
  SO[id] = vec4f(s.x, u, v, bilinF(gcx, gcy));
  KO[id] = bilinK(gcx, gcy);
}
fn outScale(i: i32, j: i32) -> f32 {
  let s = SI[ci(i, j)];
  var uR = SI[ci(i+1, j)].y; if (i >= i32(P.W) - 1) { uR = 0.0; }
  var uL = s.y;              if (i <= 0) { uL = 0.0; }
  var vT = SI[ci(i, j+1)].z; if (j >= i32(P.L) - 1) { vT = s.z; }
  let vB = s.z;
  let outf = max(uR, 0.0) + max(-uL, 0.0) + max(vT, 0.0) + max(-vB, 0.0);
  let lim = 0.8 * P.dx / P.dt;
  return select(1.0, lim / outf, outf > lim);
}
@compute @workgroup_size(8, 8)
fn height(@builtin(global_invocation_id) gid: vec3u) {
  let i = i32(gid.x); let j = i32(gid.y);
  if (i >= i32(P.W) || j >= i32(P.L)) { return; }
  let id = ci(i, j);
  let s = SI[id];
  let h = s.x;
  var uL = s.y;              if (i == 0) { uL = 0.0; }
  var uR = SI[ci(i+1, j)].y; if (i == i32(P.W) - 1) { uR = 0.0; }
  let vB = s.z;
  var vT = SI[ci(i, j+1)].z; if (j == i32(P.L) - 1) { vT = s.z; }
  let hL = SI[ci(i-1, j)].x; let hR = SI[ci(i+1, j)].x;
  let hB = SI[ci(i, j-1)].x; let hT = SI[ci(i, j+1)].x;
  let sc = outScale(i, j);
  let FL = select(uL * h * sc, uL * hL * outScale(i-1, j), uL > 0.0);
  let FR = select(uR * hR * outScale(i+1, j), uR * h * sc, uR > 0.0);
  let FB = select(vB * h * sc, vB * hB * outScale(i, j-1), vB > 0.0);
  let FT = select(vT * hT * outScale(i, j+1), vT * h * sc, vT > 0.0);
  let hRaw = max(0.0, h - P.dt / P.dx * (FR - FL + FT - FB));
  // rate-limit depth change per substep: outScale above caps drain but not fill, so a cell below a steep drop can otherwise spike
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
@compute @workgroup_size(8, 8)
fn momentum(@builtin(global_invocation_id) gid: vec3u) {
  let i = i32(gid.x); let j = i32(gid.y);
  if (i >= i32(P.W) || j >= i32(P.L)) { return; }
  let id = ci(i, j);
  let s = SI[id];
  let h = s.x; let b = B[id];
  let dx = P.dx; let dt = P.dt; let g = P.g;
  // inflow: prescribed level, velocity from the target discharge (see inVelScale)
  if (j <= 1) {
    let hin = max(0.0, P.inEta - b);
    var vin = 0.0; var hh = hin;
    if (hin > 0.05) { vin = P.inQ * P.inVelScale * pow(hin, 0.6667); } else { hh = 0.0; }
    SO[id] = vec4f(hh, 0.0, vin, 0.0);
    KO[id] = 0.12;
    return;
  }
  let sL = SI[ci(i-1, j)]; let hL = sL.x; let bL = B[ci(i-1, j)];
  var u = s.y;
  if (i == 0) { u = 0.0; } else {
    let wetL = hL > P.hmin; let wetR = h > P.hmin;
    let etaL = bL + hL; let etaR = b + h;
    if (!wetL && !wetR) { u = 0.0; }
    else if (wetL && wetR) { u -= g * dt * (etaR - etaL) / dx; }
    else if (wetL) { if (etaL <= b) { u = 0.0; } else { u -= g * dt * (b - etaL) / dx; u = max(u, 0.0); } }
    else { if (etaR <= bL) { u = 0.0; } else { u -= g * dt * (etaR - bL) / dx; u = min(u, 0.0); } }
    let vavg = 0.25 * (sL.z + SI[ci(i-1, j+1)].z + s.z + SI[ci(i, j+1)].z);
    let hf = max(0.5 * (hL + h), P.hmin);
    let spd = sqrt(u * u + vavg * vavg);
    u = u / (1.0 + dt * g * P.manning * P.manning * spd / pow(hf, 1.3333));
    let kf = 0.5 * (KI[ci(i-1, j)] + KI[id]);
    if (P.turbA > 1e-4 && kf > 0.02 && wetL && wetR) {
      let gr = noiseGrad(facePosU(i, j), P.time);
      u += dt * P.turbA * clamp(kf, 0.0, 1.0) * gr.y;
    }
    u = clamp(u, -P.umax, P.umax);
  }
  let sB = SI[ci(i, j-1)]; let hB = sB.x; let bB = B[ci(i, j-1)];
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
    v = v / (1.0 + dt * g * P.manning * P.manning * spd / pow(hf, 1.3333));
    let kf = 0.5 * (KI[ci(i, j-1)] + KI[id]);
    if (P.turbA > 1e-4 && kf > 0.02 && wetB && wetT) {
      let gr = noiseGrad(facePosV(i, j), P.time);
      v += dt * P.turbA * clamp(kf, 0.0, 1.0) * (-gr.x);
    }
    v = clamp(v, -P.umax, P.umax);
  }
  var foam = s.w; var k = KI[id];
  if (h > P.hmin) {
    let sR = SI[ci(i+1, j)]; let sT = SI[ci(i, j+1)];
    let bR = B[ci(i+1, j)]; let bT = B[ci(i, j+1)];
    let uc = 0.5 * (s.y + sR.y); let vc = 0.5 * (s.z + sT.z);
    let spd = length(vec2f(uc, vc));
    let Fr = spd / sqrt(g * h);
    let div = (sR.y - s.y + sT.z - s.z) / dx;
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
    let kSrc = P.kGen * (shear * 0.4 + max(0.0, Fr - 0.6) * 0.6 + rock * 0.8 + max(0.0, -div) * 0.5
                         + 0.12 * min(spd * spd / 16.0, 1.0));
    k = min(1.0, k * exp(-P.kDecay * dt) + dt * kSrc);
  } else { foam *= 0.9; k *= 0.8; }
  SO[id] = vec4f(h, u, v, foam);
  KO[id] = k;
}
`;
