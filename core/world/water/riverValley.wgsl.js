// C2 sampling of cached bank excavation. Applied after the existing terrain
// stack: no added hills, bank fill or river-specific erosion changes.

import { RIVER_CARVE_GROUP } from './riverCarve.wgsl.js';

// Group 1 of the terrain generator's pipelines (riverCarve.wgsl.js uses 0..3).
export const RIVER_VALLEY_BINDINGS = Object.freeze({ pages: 4, texels: 5, params: 6 });

/**
 * @param {object} [o]
 * @param {boolean} [o.enabled=true]  false: pass-through stubs (no bindings)
 * @param {number} [o.page=32]        texels per page side (riverValley.js)
 * @returns {string} WGSL: ValleyShape, valleyShapeAt(unitDir), valleyApply_d(shape, hNorm)
 */
export function createRiverValleyWgsl({ enabled = true, page = 32 } = {}) {
    if (!enabled) {
        return /* wgsl */`
// River valleys off in this shader (riverValley.wgsl.js).
struct ValleyShape { isOn: bool, cut: vec4<f32>, }
fn valleyShapeAt(unitDir: vec3<f32>) -> ValleyShape { var s: ValleyShape; s.isOn = false; return s; }
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
        let v = vec2<f32>(bitcast<f32>(q.x), f32(q.z >> 31u));
        let w = wx.${cx} * wy.${cy};
        let wdx = dwx.${cx} * wy.${cy};
        let wdy = wx.${cx} * dwy.${cy};
        a += v * w; ax += v * wdx; ay += v * wdy;
    }`;
    }
    return /* wgsl */`
// ==================== River valleys (core/world/water/riverValley.wgsl.js) ====
struct ValleyParams {
    texels: f32, pageSize: u32, pagesPerEdge: u32, on: u32,
    reserved0: vec4<f32>, reserved1: vec4<f32>, reserved2: vec4<f32>,
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

struct ValleyShape { isOn: bool, cut: vec4<f32>, }

// The cached cut at a direction (once per height evaluation).
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
    var a = vec2<f32>(0.0); var ax = vec2<f32>(0.0); var ay = vec2<f32>(0.0);
    ${taps}
    let gtx = fu.gx * (0.5 * T);
    let gty = fu.gy * (0.5 * T);
    let cut = vec4<f32>(a.x, ax.x * gtx + ay.x * gty);
    let lakeGuard = vec4<f32>(a.y, ax.y * gtx + ay.y * gty);
    let keep = dConst(1.0) - dQuintic(dClamp(lakeGuard * 8.0, 0.0, 1.0));
    s.cut = dMul(cut, keep);
    s.isOn = s.cut.x > 0.0;
    return s;
}

// Nonnegative cut depths and positive B-spline weights only lower terrain.
// Nothing feeds back into Runevision or changes the natural terrain outside banks.
fn valleyApply_d(s: ValleyShape, hNorm: vec4<f32>) -> vec4<f32> {
    if (!s.isOn) { return hNorm; }
    return hNorm - s.cut / maxTerrainHeightM();
}
`;
}
