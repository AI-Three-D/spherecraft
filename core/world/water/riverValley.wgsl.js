// core/world/water/riverValley.wgsl.js
//
// River valleys in the terrain height function (riverValley.js): the
// landform is shaped toward each river's valley before the erosion filter
// (its gullies then drain into the valley), and again after the detail added
// after erosion (meso2, rolling hills, lake basins), so the floor stays
// clean. Lab: terrain-lab/valley-proto.mjs.
//
// Field: cubic B-spline of the baked texels (C2, with its gradient: the
// erosion filter's input must be C2 and needs the slope). Cross-section,
// x = metres past the floor's edge (d - floor half-width):
//   up   = floor + (vH (1 - e^(-x / vS)) + wallSlope x) q(x / wallL)
//          ground above it is cut toward it (C2 blend over kCut of height);
//   down = floor - fillSlope x q(x / fillL)
//          ground below it is raised to it where the fill weight allows;
//   near lake water the cut stops at the lake's level (its rim is kept);
//   faded out between reach0 and reach1 from the river.
// q = quintic smoothstep (C2 at the floor's edge). The cut only lowers
// ground above its target and never below it; the fill only raises ground
// below its target and never above it (riverValley valleyCutD).

import { RIVER_CARVE_GROUP } from './riverCarve.wgsl.js';

// Group 1 of the terrain generator's pipelines (riverCarve.wgsl.js uses 0..3).
export const RIVER_VALLEY_BINDINGS = Object.freeze({ pages: 4, texels: 5, params: 6 });

/**
 * @param {object} [o]
 * @param {boolean} [o.enabled=true]  false: pass-through stubs (no bindings)
 * @param {number} [o.page=32]        texels per page side (riverValley.js)
 * @returns {string} WGSL: ValleyShape, valleyShapeAt(unitDir), valleyApplyPre_d(shape, hNorm)
 *   (before erosion), valleyApply_d(shape, hNorm) (after the detail added after it)
 */
export function createRiverValleyWgsl({ enabled = true, page = 32 } = {}) {
    if (!enabled) {
        return /* wgsl */`
// River valleys off in this shader (riverValley.wgsl.js).
struct ValleyShape { isOn: bool, }
fn valleyShapeAt(unitDir: vec3<f32>) -> ValleyShape { var s: ValleyShape; s.isOn = false; return s; }
fn valleyApplyPre_d(s: ValleyShape, hNorm: vec4<f32>) -> vec4<f32> { return hNorm; }
fn valleyApply_d(s: ValleyShape, hNorm: vec4<f32>) -> vec4<f32> { return hNorm; }
`;
    }
    const B = RIVER_VALLEY_BINDINGS, G = RIVER_CARVE_GROUP;
    const ST = page + 4, TEX = ST * ST;
    let taps = '';
    for (let jj = 0; jj < 4; jj++) for (let ii = 0; ii < 4; ii++) {
        const cx = 'xyzw'[ii], cy = 'xyzw'[jj];
        taps += `
    {
        let q = valleyTexels[base + (lj0 + ${jj}) * ${ST} + li0 + ${ii}];
        let dw = unpack2x16float(q.y);
        let v0 = vec4<f32>(dw.x, bitcast<f32>(q.x), dw.y, 0.0);
        let v1 = vec4<f32>(unpack2x16float(q.z), unpack2x16float(q.w));
        let w = wx.${cx} * wy.${cy};
        let wdx = dwx.${cx} * wy.${cy};
        let wdy = wx.${cx} * dwy.${cy};
        a0 += v0 * w; ax0 += v0 * wdx; ay0 += v0 * wdy;
        a1 += v1 * w; ax1 += v1 * wdx; ay1 += v1 * wdy;
    }`;
    }
    return /* wgsl */`
// ==================== River valleys (core/world/water/riverValley.wgsl.js) ====
struct ValleyParams {
    texels: f32, pageSize: u32, pagesPerEdge: u32, on: u32,
    dBig: f32, reach0: f32, reach1: f32, kSmooth: f32,
    vH: f32, vS: f32, wallL: f32, fillSlope: f32,
    fillL: f32, kCut: f32, pad0: f32, pad1: f32,
}
@group(${G}) @binding(${B.pages}) var<storage, read> valleyPages: array<u32>;
@group(${G}) @binding(${B.texels}) var<storage, read> valleyTexels: array<vec4<u32>>;
@group(${G}) @binding(${B.params}) var<uniform> valleyP: ValleyParams;

struct ValleyFaceUV { face: i32, x: f32, y: f32, gx: vec3<f32>, gy: vec3<f32>, }

// Face and gnomonic face coordinates (x, y in -1..1) of a direction, as
// waterGraph.js dirToFaceUV, and their gradients w.r.t. the direction.
fn valleyFaceUV(d: vec3<f32>) -> ValleyFaceUV {
    var r: ValleyFaceUV;
    let a = abs(d);
    if (a.x >= a.y && a.x >= a.z) {
        if (d.x > 0.0) {
            r.face = 0; let inv = 1.0 / d.x;
            r.x = -d.z * inv; r.y = d.y * inv;
            r.gx = vec3<f32>(-r.x, 0.0, -1.0) * inv; r.gy = vec3<f32>(-r.y, 1.0, 0.0) * inv;
        } else {
            r.face = 1; let inv = -1.0 / d.x;
            r.x = d.z * inv; r.y = d.y * inv;
            r.gx = vec3<f32>(r.x, 0.0, 1.0) * inv; r.gy = vec3<f32>(r.y, 1.0, 0.0) * inv;
        }
    } else if (a.y >= a.z) {
        if (d.y > 0.0) {
            r.face = 2; let inv = 1.0 / d.y;
            r.x = d.x * inv; r.y = -d.z * inv;
            r.gx = vec3<f32>(1.0, -r.x, 0.0) * inv; r.gy = vec3<f32>(0.0, -r.y, -1.0) * inv;
        } else {
            r.face = 3; let inv = -1.0 / d.y;
            r.x = d.x * inv; r.y = d.z * inv;
            r.gx = vec3<f32>(1.0, r.x, 0.0) * inv; r.gy = vec3<f32>(0.0, r.y, 1.0) * inv;
        }
    } else if (d.z > 0.0) {
        r.face = 4; let inv = 1.0 / d.z;
        r.x = d.x * inv; r.y = d.y * inv;
        r.gx = vec3<f32>(1.0, 0.0, -r.x) * inv; r.gy = vec3<f32>(0.0, 1.0, -r.y) * inv;
    } else {
        r.face = 5; let inv = -1.0 / d.z;
        r.x = -d.x * inv; r.y = d.y * inv;
        r.gx = vec3<f32>(-1.0, 0.0, r.x) * inv; r.gy = vec3<f32>(0.0, 1.0, r.y) * inv;
    }
    return r;
}

// Cubic B-spline weights of texels -1, 0, +1, +2 around a sample, and their derivatives.
fn valleyBW(f: f32) -> vec4<f32> {
    let f2 = f * f; let f3 = f2 * f;
    return vec4<f32>(1.0 - 3.0 * f + 3.0 * f2 - f3, 4.0 - 6.0 * f2 + 3.0 * f3, 1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3, f3) * (1.0 / 6.0);
}
fn valleyBDW(f: f32) -> vec4<f32> {
    let f2 = f * f;
    return vec4<f32>(-3.0 + 6.0 * f - 3.0 * f2, -12.0 * f + 9.0 * f2, 3.0 + 6.0 * f - 9.0 * f2, 3.0 * f2) * (1.0 / 6.0);
}

// Ground h cut toward a target: h - x q(x / k), x = h - target > 0 (q the
// quintic smoothstep): only where the ground is above the target, never
// below it, C2. A blend of the two (as before) also raised ground lying just
// under the target: near lakes, whose rim level is the target, it lifted the
// lake's shallow edge above its level (owner 2026-10-06: the river stopped
// short of its source lake; lab: 2,470 m2 of lake 286 lost).
fn valleyCutD(h: vec4<f32>, goal: vec4<f32>, k: f32) -> vec4<f32> {
    let x = h - goal;
    if (x.x <= 0.0) { return h; }
    let t = min(x.x / k, 1.0);
    let q = t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
    let dq = select(30.0 * t * t * (t - 1.0) * (t - 1.0) / k, 0.0, t >= 1.0);
    return h - vec4<f32>(x.x * q, x.yzw * (q + x.x * dq));
}
// Ground h raised toward a target, the mirror image: only where it lies below.
fn valleyFillD(h: vec4<f32>, goal: vec4<f32>, k: f32) -> vec4<f32> {
    return -valleyCutD(-h, -goal, k);
}
// C2 blend toward the higher of two targets over |a - b| < k / 2 (quintic weight).
fn valleyBlendMaxD(a: vec4<f32>, b: vec4<f32>, k: f32) -> vec4<f32> {
    let t = clamp((b.x - a.x) / k + 0.5, 0.0, 1.0);
    let S = t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
    let c = (b.x - a.x) * 30.0 * t * t * (t - 1.0) * (t - 1.0) / k;
    return vec4<f32>(a.x + (b.x - a.x) * S, a.yzw * (1.0 - S - c) + b.yzw * (S + c));
}

struct ValleyShape {
    isOn: bool,
    up: vec4<f32>,      // cut target (m, dual)
    down: vec4<f32>,    // fill target (m, dual)
    wReach: vec4<f32>,  // 1 near the river .. 0 at reach1
    wFill: vec4<f32>,   // 0: no fill
    wPre: vec4<f32>,    // weight before erosion: wReach, 0 near lake water
}

// The valley's cut and fill targets at a direction (once per height evaluation).
fn valleyShapeAt(dir: vec3<f32>) -> ValleyShape {
    var s: ValleyShape;
    s.isOn = false;
    if (valleyP.on == 0u) { return s; }
    let fu = valleyFaceUV(dir);
    let T = valleyP.texels;
    let tx = (fu.x + 1.0) * 0.5 * T - 0.5;
    let ty = (fu.y + 1.0) * 0.5 * T - 0.5;
    let fxb = floor(tx); let fyb = floor(ty);
    let ib = i32(fxb); let jb = i32(fyb);
    let P = i32(valleyP.pageSize); let PE = i32(valleyP.pagesPerEdge);
    let pi = clamp((ib + 1) / P, 0, PE - 1);
    let pj = clamp((jb + 1) / P, 0, PE - 1);
    let slot = valleyPages[u32(fu.face * PE * PE + pj * PE + pi)];
    if (slot == 0u) { return s; }
    let base = i32(slot - 1u) * ${TEX};
    let li0 = clamp(ib - 1 - (pi * P - 2), 0, ${ST - 4});
    let lj0 = clamp(jb - 1 - (pj * P - 2), 0, ${ST - 4});
    let wx = valleyBW(tx - fxb); let wy = valleyBW(ty - fyb);
    let dwx = valleyBDW(tx - fxb); let dwy = valleyBDW(ty - fyb);
    var a0 = vec4<f32>(0.0); var ax0 = vec4<f32>(0.0); var ay0 = vec4<f32>(0.0);
    var a1 = vec4<f32>(0.0); var ax1 = vec4<f32>(0.0); var ay1 = vec4<f32>(0.0);
    ${taps}
    let gtx = fu.gx * (0.5 * T);
    let gty = fu.gy * (0.5 * T);
    let d = vec4<f32>(a0.x, ax0.x * gtx + ay0.x * gty);
    if (d.x >= valleyP.reach1) { return s; }
    let F = vec4<f32>(a0.y, ax0.y * gtx + ay0.y * gty);
    let wc = vec4<f32>(a0.z, ax0.z * gtx + ay0.z * gty);
    let wFill = vec4<f32>(a1.x, ax1.x * gtx + ay1.x * gty);
    let sWall = vec4<f32>(a1.y, ax1.y * gtx + ay1.y * gty);
    let wRim = dClamp(vec4<f32>(a1.z, ax1.z * gtx + ay1.z * gty), 0.0, 1.0);
    let rim = F + vec4<f32>(a1.w, ax1.w * gtx + ay1.w * gty);
    s.isOn = true;
    let xr = d - wc;
    let x = select(dConst(0.0), xr, xr.x > 0.0);
    let qOn = dQuintic(dClamp(x * (1.0 / valleyP.wallL), 0.0, 1.0));
    let ex = exp(-x.x / valleyP.vS);
    let rise = vec4<f32>(valleyP.vH * (1.0 - ex), x.yzw * (valleyP.vH / valleyP.vS * ex)) + dMul(sWall, x);
    s.up = F + dMul(rise, qOn);
    if (wRim.x > 0.0) {
        s.up = s.up + dMul(wRim, valleyBlendMaxD(s.up, rim, 1.0) - s.up);
    }
    let qF = dQuintic(dClamp(x * (1.0 / valleyP.fillL), 0.0, 1.0));
    s.down = F - dMul(x * valleyP.fillSlope, qF);
    s.wReach = dConst(1.0) - dQuintic(dClamp((d - dConst(valleyP.reach0)) * (1.0 / (valleyP.reach1 - valleyP.reach0)), 0.0, 1.0));
    s.wFill = dClamp(wFill, 0.0, 1.0);
    // Near lake water the landform before erosion is left alone: shaping it
    // there changed the erosion filter's gullies and meso2's weight, which
    // raised a lake's shallow edge above its level (lab 2026-10-06: 12,768
    // m2 of lake 286 lost). The shaping after the detail still applies.
    s.wPre = dMul(s.wReach, dConst(1.0) - wRim);
    return s;
}

fn valleyShapeWith(s: ValleyShape, hNorm: vec4<f32>, w: vec4<f32>) -> vec4<f32> {
    let maxH = maxTerrainHeightM();
    let h = hNorm * maxH;
    let cut = valleyCutD(h, s.up, valleyP.kCut);
    let filled = valleyFillD(cut, s.down, valleyP.kSmooth);
    let shaped = cut + dMul(s.wFill, filled - cut);
    return (h + dMul(w, shaped - h)) * (1.0 / maxH);
}

// The landform (normalized height dual) shaped toward the valley before erosion.
fn valleyApplyPre_d(s: ValleyShape, hNorm: vec4<f32>) -> vec4<f32> {
    if (!s.isOn) { return hNorm; }
    return valleyShapeWith(s, hNorm, s.wPre);
}

// The terrain shaped toward the valley after the detail added after erosion.
fn valleyApply_d(s: ValleyShape, hNorm: vec4<f32>) -> vec4<f32> {
    if (!s.isOn) { return hNorm; }
    return valleyShapeWith(s, hNorm, s.wReach);
}
`;
}
