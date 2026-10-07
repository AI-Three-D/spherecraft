// C2 sampling of cached hill, excavation and drainage fields. Hill heights
// and excavation enter before the existing Runevision erosion pass.
// No bank fill or corridor-wide terrain uplift.

import { RIVER_CARVE_GROUP } from './riverCarve.wgsl.js';

// Group 1 of the terrain generator's pipelines (riverCarve.wgsl.js uses 0..3).
export const RIVER_VALLEY_BINDINGS = Object.freeze({ pages: 4, texels: 5, params: 6 });

/**
 * @param {object} [o]
 * @param {boolean} [o.enabled=true]  false: pass-through stubs (no bindings)
 * @param {number} [o.page=32]        texels per page side (riverValley.js)
 * @returns {string} WGSL: ValleyShape, valleyShapeAt(unitDir), valleyApplyPre_d(shape, hNorm)
 *   (before erosion)
 */
export function createRiverValleyWgsl({ enabled = true, page = 32 } = {}) {
    if (!enabled) {
        return /* wgsl */`
// River valleys off in this shader (riverValley.wgsl.js).
struct ValleyShape { isOn: bool, erosionRelief: vec4<f32>, erosionFloor: vec4<f32>, erosionAmount: vec4<f32>, erosionDepth: vec4<f32>, erosionRidge: vec4<f32>, }
fn valleyShapeAt(unitDir: vec3<f32>) -> ValleyShape { var s: ValleyShape; s.isOn = false; return s; }
fn valleyApplyPre_d(s: ValleyShape, hNorm: vec4<f32>) -> vec4<f32> { return hNorm; }
fn valleyBoundBanks_d(s: ValleyShape, hNorm: vec4<f32>) -> vec4<f32> { return hNorm; }
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
        let v0 = vec4<f32>(dw.x, bitcast<f32>(q.x), dw.y, select(0.0, 1.0, q.w != 0u));
        let v1 = vec4<f32>(unpack2x16float(q.z).x, f32(q.z >> 31u), bitcast<f32>(q.w), unpack2x16float((q.z >> 16u) & 0x7fffu).x);
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
    erosionStrength: f32, erosionDepthFraction: f32, erosionRidgeFraction: f32, reserved0: f32,
    reserved1: vec4<f32>,
    reserved2: vec3<f32>, erosionReliefScale: f32,
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

struct ValleyShape {
    isOn: bool,
    hill: vec4<f32>,
    cut: vec4<f32>,
    erosionRelief: vec4<f32>,
    erosionFloor: vec4<f32>,
    erosionAmount: vec4<f32>,
    erosionDepth: vec4<f32>,
    erosionRidge: vec4<f32>,
    bankReference: vec4<f32>,
    bankClearance: vec4<f32>,
    bankCoverage: vec4<f32>,
}

// The cached landforms at a direction (once per height evaluation).
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
    // Sparse morphology: independent hill footprints minus cut-only bank
    // retreat. The existing erosion pass sees the actual excavated landform.
    let hill = vec4<f32>(a0.x, ax0.x * gtx + ay0.x * gty);
    let cut = vec4<f32>(a0.y, ax0.y * gtx + ay0.y * gty);
    let hillErode = vec4<f32>(a0.z, ax0.z * gtx + ay0.z * gty);
    let cutErode = vec4<f32>(a1.x, ax1.x * gtx + ay1.x * gty);
    let lakeGuard = vec4<f32>(a1.y, ax1.y * gtx + ay1.y * gty);
    let coverage = vec4<f32>(a0.w, ax0.w * gtx + ay0.w * gty);
    let reference = vec4<f32>(a1.z, ax1.z * gtx + ay1.z * gty);
    let clearance = vec4<f32>(a1.w, ax1.w * gtx + ay1.w * gty);
    let keep = dConst(1.0) - dQuintic(dClamp(lakeGuard * 8.0, 0.0, 1.0));
    s.isOn = hill.x + cut.x > 0.001;
    s.hill = dMul(hill, keep);
    s.cut = dMul(cut, keep);
    let erodibleRelief = hillErode + cutErode;
    s.erosionRelief = dMul(erodibleRelief, keep) * valleyP.erosionReliefScale;
    s.erosionFloor = dMul(dSmoothstep(2.0, 30.0, erodibleRelief), keep) * 0.5;
    // River banks do not need mountain-sized relief before they can erode.
    // Their material controls the local amount, while the actual terrain
    // slope still gates the same Runevision call. No extra erosion pass.
    let physicalRelief = s.hill + s.cut;
    let material = dClamp(dDiv(dMul(erodibleRelief, keep), physicalRelief + dConst(0.01)), 0.0, 1.0);
    s.erosionAmount = dMul(dSmoothstep(2.0, 20.0, physicalRelief), material) * valleyP.erosionStrength;
    s.erosionDepth = physicalRelief * valleyP.erosionDepthFraction;
    s.erosionRidge = physicalRelief * valleyP.erosionRidgeFraction;
    if (coverage.x > 0.001) {
        s.bankReference = dDiv(reference, coverage);
        s.bankClearance = dDiv(clearance, coverage);
        s.bankCoverage = dMul(dSmoothstep(0.1, 0.9, coverage), keep);
    }
    return s;
}

// The landform (normalized height dual) shaped toward the valley before erosion.
fn valleyApplyPre_d(s: ValleyShape, hNorm: vec4<f32>) -> vec4<f32> {
    if (!s.isOn) { return hNorm; }
    return hNorm + (s.hill - s.cut) / maxTerrainHeightM();
}

// Changing the slope changes the filter's gully pattern. Keep those changes
// relative to the sampled, excavated bank, rather than letting mountain-scale
// amplitude flood low banks. This never adds a ridge above natural ground:
// its positive budget is only a fraction of material already excavated.
fn valleyBoundBanks_d(s: ValleyShape, hNorm: vec4<f32>) -> vec4<f32> {
    if (!s.isOn || s.bankCoverage.x <= 0.001) { return hNorm; }
    let maxH = maxTerrainHeightM();
    let reference = s.bankReference / maxH;
    let diff = hNorm - reference;
    var budget = s.cut * valleyP.erosionRidgeFraction / maxH;
    if (diff.x < 0.0) {
        budget = s.bankClearance * valleyP.erosionDepthFraction / maxH;
    }
    budget += dConst(0.01 / maxH);
    // Smooth saturation, with analytic derivatives and no hard contour shelf.
    let ratio = dDiv(diff, budget);
    let limited = reference + dDiv(diff, dSqrt(dConst(1.0) + dMul(ratio, ratio)));
    return hNorm + dMul(limited - hNorm, s.bankCoverage);
}
`;
}
