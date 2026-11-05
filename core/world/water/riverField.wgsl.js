// core/world/water/riverField.wgsl.js
//
// Lookup of the baked river field (riverField.js): pages of the cube-face
// raster found through an open-addressing hash table, sampled with a cubic
// B-spline (C2, value and gradient for the height's dual numbers). The
// terrain generator binds it in group 1 (bindings 4-6); water and material
// shaders bind their own copy (group, bindings as arguments), those that need
// the flow (riverFlow.js) with b.flow.

import { RIVER_FLOW } from './riverFlow.js';

export const RIVER_FIELD_BINDINGS = Object.freeze({ table: 4, texels: 5, params: 6 });
// Encoded range of the flow word's velocity and Manning's n: riverFlow.js.
const SPEED_RANGE = RIVER_FLOW.speedRangeM.toFixed(1);
const MANNING_MIN = RIVER_FLOW.manning[0].toFixed(4);
const MANNING_LOG = Math.log(RIVER_FLOW.manning[1] / RIVER_FLOW.manning[0]).toFixed(6);
export const RIVER_FIELD_PARAMS_BYTES = 32;
// Probes before a lookup gives up (the table is at most half full).
const MAX_PROBES = 64;

/** Packed RiverFieldParams uniform. */
export function riverFieldParamsData(L, tableSize, on, sdfM = 16) {
    const buf = new ArrayBuffer(RIVER_FIELD_PARAMS_BYTES), f = new Float32Array(buf), u = new Uint32Array(buf);
    f[0] = L.T; u[1] = L.P; u[2] = L.PE; u[3] = Math.max(1, tableSize) - 1;
    u[4] = L.A; u[5] = on ? 1 : 0; f[6] = sdfM; f[7] = 0;
    return buf;
}

/** The hash of a page key, as the shader computes it. */
export function riverFieldHash(key) {
    let x = key >>> 0;
    x = (x ^ (x >>> 16)) >>> 0; x = Math.imul(x, 0x7feb352d) >>> 0;
    x = (x ^ (x >>> 15)) >>> 0; x = Math.imul(x, 0x846ca68b) >>> 0;
    return (x ^ (x >>> 16)) >>> 0;
}

/** Open-addressing table (key + 1, slot) for page keys in slot order; size a power of two >= 2 x pages. */
export function buildRiverFieldTable(keys) {
    let size = 16;
    while (size < keys.length * 2) size *= 2;
    const table = new Uint32Array(size * 2), mask = size - 1;
    keys.forEach((key, slot) => {
        let h = riverFieldHash(key) & mask;
        for (let i = 0; i < size; i++) {
            if (table[h * 2] === 0) { table[h * 2] = key + 1; table[h * 2 + 1] = slot; return; }
            h = (h + 1) & mask;
        }
        throw new Error('riverField table full');
    });
    return { table, size };
}

/**
 * @param {object} o
 * @param {number} o.group  bind group
 * @param {object} [o.b]    bindings { table, texels, params }
 * @param {number} o.page   texels per page side
 * @param {number} o.apron  apron texels
 * @returns {string} WGSL: RiverFieldSample, riverFieldAt(dir) (value of every
 *   channel), riverFieldDelta_d(dir) (Δ as a height dual, metres)
 */
export function createRiverFieldWgsl({ group, b = RIVER_FIELD_BINDINGS, page = 32, apron = 2 }) {
    const ST = page + 2 * apron;
    return /* wgsl */`
// ==================== River field (core/world/water/riverField.wgsl.js) ====
struct RiverFieldParams { T: f32, P: u32, PE: u32, mask: u32, apron: u32, on: u32, sdfM: f32, pad: f32, }
@group(${group}) @binding(${b.table}) var<storage, read> riverFieldTable: array<vec2<u32>>;
// Texels: level W (f32 bits), Δ and signed distance (f16 pair).
@group(${group}) @binding(${b.texels}) var<storage, read> riverFieldTexels: array<vec2<u32>>;
fn riverFieldTexel(i: i32) -> vec4<f32> {
    let q = riverFieldTexels[i];
    let ds = unpack2x16float(q.y);
    return vec4<f32>(ds.x, bitcast<f32>(q.x), ds.y, 0.0);
}
@group(${group}) @binding(${b.params}) var<uniform> riverFieldP: RiverFieldParams;

fn riverFieldHash(key: u32) -> u32 {
    var x = key;
    x = x ^ (x >> 16u); x = x * 0x7feb352du;
    x = x ^ (x >> 15u); x = x * 0x846ca68bu;
    return x ^ (x >> 16u);
}
// The slot of a page (face * PE^2 + pj * PE + pi), or -1.
fn riverFieldSlot(key: u32) -> i32 {
    var h = riverFieldHash(key) & riverFieldP.mask;
    for (var i = 0u; i < ${MAX_PROBES}u; i++) {
        let e = riverFieldTable[h];
        if (e.x == 0u) { return -1; }
        if (e.x == key + 1u) { return i32(e.y); }
        h = (h + 1u) & riverFieldP.mask;
    }
    return -1;
}

// Face and gnomonic coordinates of a direction with their gradients
// (waterGraph.js dirToFaceUV convention).
struct RiverFieldFace { face: i32, x: f32, y: f32, gx: vec3<f32>, gy: vec3<f32>, }
fn riverFieldFace(d: vec3<f32>) -> RiverFieldFace {
    var r: RiverFieldFace;
    let a = abs(d);
    if (a.x >= a.y && a.x >= a.z) {
        if (d.x > 0.0) { r.face = 0; let inv = 1.0 / d.x; r.x = -d.z * inv; r.y = d.y * inv;
            r.gx = vec3<f32>(-r.x, 0.0, -1.0) * inv; r.gy = vec3<f32>(-r.y, 1.0, 0.0) * inv; }
        else { r.face = 1; let inv = -1.0 / d.x; r.x = d.z * inv; r.y = d.y * inv;
            r.gx = vec3<f32>(r.x, 0.0, 1.0) * inv; r.gy = vec3<f32>(r.y, 1.0, 0.0) * inv; }
    } else if (a.y >= a.z) {
        if (d.y > 0.0) { r.face = 2; let inv = 1.0 / d.y; r.x = d.x * inv; r.y = -d.z * inv;
            r.gx = vec3<f32>(1.0, -r.x, 0.0) * inv; r.gy = vec3<f32>(0.0, -r.y, -1.0) * inv; }
        else { r.face = 3; let inv = -1.0 / d.y; r.x = d.x * inv; r.y = d.z * inv;
            r.gx = vec3<f32>(1.0, r.x, 0.0) * inv; r.gy = vec3<f32>(0.0, r.y, 1.0) * inv; }
    } else if (d.z > 0.0) {
        r.face = 4; let inv = 1.0 / d.z; r.x = d.x * inv; r.y = d.y * inv;
        r.gx = vec3<f32>(1.0, 0.0, -r.x) * inv; r.gy = vec3<f32>(0.0, 1.0, -r.y) * inv;
    } else {
        r.face = 5; let inv = -1.0 / d.z; r.x = -d.x * inv; r.y = d.y * inv;
        r.gx = vec3<f32>(-1.0, 0.0, r.x) * inv; r.gy = vec3<f32>(0.0, 1.0, r.y) * inv;
    }
    return r;
}

fn riverFieldBW(f: f32) -> vec4<f32> {
    let f2 = f * f; let f3 = f2 * f;
    return vec4<f32>(1.0 - 3.0 * f + 3.0 * f2 - f3, 4.0 - 6.0 * f2 + 3.0 * f3, 1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3, f3) * (1.0 / 6.0);
}
fn riverFieldBDW(f: f32) -> vec4<f32> {
    let f2 = f * f;
    return vec4<f32>(-3.0 + 6.0 * f - 3.0 * f2, -12.0 * f + 9.0 * f2, 3.0 + 6.0 * f - 9.0 * f2, 3.0 * f2) * (1.0 / 6.0);
}

// found: a page holds the point. value: Δ (m), water level W (m), signed
// distance to the water's edge (m, + in the water), 0. grad: the gradient
// of value.x w.r.t. the direction.
struct RiverFieldSample { found: bool, value: vec4<f32>, grad: vec3<f32>, }
fn riverFieldAt(dir: vec3<f32>) -> RiverFieldSample {
    var s: RiverFieldSample;
    s.found = false; s.value = vec4<f32>(0.0, 0.0, -riverFieldP.sdfM, 0.0); s.grad = vec3<f32>(0.0);
    if (riverFieldP.on == 0u) { return s; }
    let fu = riverFieldFace(dir);
    let T = riverFieldP.T;
    let k = 2.0 / 3.14159265358979;   // (4 / pi) / 2
    let ax = atan(fu.x); let ay = atan(fu.y);
    let tx = (ax * k + 0.5) * T - 0.5;
    let ty = (ay * k + 0.5) * T - 0.5;
    let gtx = fu.gx * (k * T / (1.0 + fu.x * fu.x));
    let gty = fu.gy * (k * T / (1.0 + fu.y * fu.y));
    let ib = i32(floor(tx)); let jb = i32(floor(ty));
    let P = i32(riverFieldP.P); let PE = i32(riverFieldP.PE);
    let pi = (ib + 1) / P; let pj = (jb + 1) / P;
    if (ib + 1 < 0 || jb + 1 < 0 || pi >= PE || pj >= PE) { return s; }
    let slot = riverFieldSlot(u32((fu.face * PE + pj) * PE + pi));
    if (slot < 0) { return s; }
    let base = slot * ${ST * ST};
    let li0 = clamp(ib + 1 - pi * P, 0, ${page});
    let lj0 = clamp(jb + 1 - pj * P, 0, ${page});
    let fx = tx - floor(tx); let fy = ty - floor(ty);
    let wx = riverFieldBW(fx); let wy = riverFieldBW(fy);
    let dwx = riverFieldBDW(fx); let dwy = riverFieldBDW(fy);
    var v = vec4<f32>(0.0); var dx = 0.0; var dy = 0.0;
    for (var jj = 0; jj < 4; jj++) {
        for (var ii = 0; ii < 4; ii++) {
            let q = riverFieldTexel(base + (lj0 + jj) * ${ST} + li0 + ii);
            let w = wx[ii] * wy[jj];
            v += q * w;
            dx += q.x * dwx[ii] * wy[jj];
            dy += q.x * wx[ii] * dwy[jj];
        }
    }
    s.found = true; s.value = v;
    s.grad = dx * gtx + dy * gty;
    return s;
}

// The values at continuous texel coordinates (tx, ty) from one page's own
// texels (its apron covers the B-spline's support up to its far edges), so
// meshes drawn per page agree with their neighbours at shared edges.
fn riverFieldInPage(slot: u32, pi: u32, pj: u32, tx: f32, ty: f32) -> vec4<f32> {
    let x = tx - 0.5; let y = ty - 0.5;
    let ib = i32(floor(x)); let jb = i32(floor(y));
    let P = i32(riverFieldP.P);
    let li0 = clamp(ib + 1 - i32(pi) * P, 0, ${page});
    let lj0 = clamp(jb + 1 - i32(pj) * P, 0, ${page});
    let wx = riverFieldBW(x - floor(x)); let wy = riverFieldBW(y - floor(y));
    let base = i32(slot) * ${ST * ST};
    var v = vec4<f32>(0.0);
    for (var jj = 0; jj < 4; jj++) {
        for (var ii = 0; ii < 4; ii++) { v += riverFieldTexel(base + (lj0 + jj) * ${ST} + li0 + ii) * (wx[ii] * wy[jj]); }
    }
    return v;
}
// Unit direction at continuous texel coordinates on a face (riverField.js fieldDir).
fn riverFieldDir(face: u32, tx: f32, ty: f32) -> vec3<f32> {
    let q = 0.78539816339745;
    let x = tan((tx / riverFieldP.T * 2.0 - 1.0) * q);
    let y = tan((ty / riverFieldP.T * 2.0 - 1.0) * q);
    var c: vec3<f32>;
    switch (face) {
        case 0u: { c = vec3<f32>(1.0, y, -x); }
        case 1u: { c = vec3<f32>(-1.0, y, x); }
        case 2u: { c = vec3<f32>(x, 1.0, -y); }
        case 3u: { c = vec3<f32>(x, -1.0, y); }
        case 4u: { c = vec3<f32>(x, y, 1.0); }
        default: { c = vec3<f32>(-x, y, -1.0); }
    }
    return normalize(c);
}

// The page holding a direction, if any: its slot (-1: none) and the texel coordinates.
struct RiverFieldSpot { slot: i32, pi: i32, pj: i32, tx: f32, ty: f32, }
fn riverFieldLocate(dir: vec3<f32>) -> RiverFieldSpot {
    var r: RiverFieldSpot;
    r.slot = -1;
    if (riverFieldP.on == 0u) { return r; }
    let fu = riverFieldFace(dir);
    let k = 2.0 / 3.14159265358979;
    r.tx = (atan(fu.x) * k + 0.5) * riverFieldP.T - 0.5;
    r.ty = (atan(fu.y) * k + 0.5) * riverFieldP.T - 0.5;
    let ib = i32(floor(r.tx)); let jb = i32(floor(r.ty));
    let P = i32(riverFieldP.P); let PE = i32(riverFieldP.PE);
    r.pi = (ib + 1) / P; r.pj = (jb + 1) / P;
    if (ib + 1 < 0 || jb + 1 < 0 || r.pi >= PE || r.pj >= PE) { return r; }
    r.slot = riverFieldSlot(u32((fu.face * PE + r.pj) * PE + r.pi));
    return r;
}
// Whether a page holds a point at continuous texel coordinates.
fn riverFieldPageAt(face: i32, cx: f32, cy: f32) -> bool {
    let P = riverFieldP.P; let PE = riverFieldP.PE;
    let pi = u32(max(cx, 0.0)) / P; let pj = u32(max(cy, 0.0)) / P;
    if (pi >= PE || pj >= PE) { return false; }
    return riverFieldSlot((u32(face) * PE + pj) * PE + pi) >= 0;
}
// True where pages' water meshes cover the direction with marginT texels to
// spare (a hash probe per corner, no texels). The meshes end on the pages' own
// edges; riverFieldLocate's page is its stencil's, half a texel lower, and a
// lake sheet giving way by that one left a gap along two sides of every page
// (owner 2026-11-03, o03-tip-sliver).
fn riverFieldHas(dir: vec3<f32>, marginT: f32) -> bool {
    if (riverFieldP.on == 0u) { return false; }
    let fu = riverFieldFace(dir);
    let k = 2.0 / 3.14159265358979;
    let cx = (atan(fu.x) * k + 0.5) * riverFieldP.T;
    let cy = (atan(fu.y) * k + 0.5) * riverFieldP.T;
    return riverFieldPageAt(fu.face, cx - marginT, cy - marginT) && riverFieldPageAt(fu.face, cx + marginT, cy + marginT)
        && riverFieldPageAt(fu.face, cx - marginT, cy + marginT) && riverFieldPageAt(fu.face, cx + marginT, cy - marginT);
}
// Water at a direction for shading: x 1 where a page holds it, y level W, z
// signed distance; bilinear (4 texels).
fn riverFieldWater(dir: vec3<f32>) -> vec3<f32> {
    let r = riverFieldLocate(dir);
    if (r.slot < 0) { return vec3<f32>(0.0); }
    let P = i32(riverFieldP.P);
    let li = clamp(i32(floor(r.tx)) + 2 - r.pi * P, 0, ${ST - 2});
    let lj = clamp(i32(floor(r.ty)) + 2 - r.pj * P, 0, ${ST - 2});
    let base = r.slot * ${ST * ST} + lj * ${ST} + li;
    let fx = r.tx - floor(r.tx); let fy = r.ty - floor(r.ty);
    let v = mix(mix(riverFieldTexel(base), riverFieldTexel(base + 1), fx),
        mix(riverFieldTexel(base + ${ST}), riverFieldTexel(base + ${ST + 1}), fx), fy);
    return vec3<f32>(1.0, v.y, v.z);
}

// Δ (m) as a height dual: vec4(value, d value / d dir).
fn riverFieldDelta_d(dir: vec3<f32>) -> vec4<f32> {
    let s = riverFieldAt(dir);
    if (!s.found) { return vec4<f32>(0.0); }
    return vec4<f32>(s.value.x, s.grad);
}
${b.flow !== undefined ? riverFlowWgsl(group, b.flow, ST) : ''}`;
}

// Flow lookup (riverFlow.js): one word a texel in the pages' slots.
function riverFlowWgsl(group, binding, ST) {
    return /* wgsl */`
@group(${group}) @binding(${binding}) var<storage, read> riverFieldFlow: array<u32>;
// x, y: velocity (m/s, along the raster's axes); z foam 0..1; w: Manning's n, or
// -1 in lake water (interpolated, how far below zero says how much of it is lake).
fn riverFlowUnpack(q: u32) -> vec4<f32> {
    let a = unpack4x8snorm(q);
    let n = f32(q >> 24u);
    return vec4<f32>(a.xy * ${SPEED_RANGE}, f32((q >> 16u) & 255u) / 255.0, select(${MANNING_MIN} * exp((n - 1.0) / 254.0 * ${MANNING_LOG}), -1.0, n < 0.5));
}
// Bilinear inside a page, at a stencil corner li, lj (apron coordinates).
fn riverFlowBilinear(slot: i32, li: i32, lj: i32, fx: f32, fy: f32) -> vec4<f32> {
    let base = slot * ${ST * ST} + lj * ${ST} + li;
    return mix(mix(riverFlowUnpack(riverFieldFlow[base]), riverFlowUnpack(riverFieldFlow[base + 1]), fx),
        mix(riverFlowUnpack(riverFieldFlow[base + ${ST}]), riverFlowUnpack(riverFieldFlow[base + ${ST + 1}]), fx), fy);
}
// The flow at a direction, zero outside the pages.
fn riverFlowAt(dir: vec3<f32>) -> vec4<f32> {
    let r = riverFieldLocate(dir);
    if (r.slot < 0) { return vec4<f32>(0.0); }
    let P = i32(riverFieldP.P);
    let li = clamp(i32(floor(r.tx)) + 2 - r.pi * P, 0, ${ST - 2});
    let lj = clamp(i32(floor(r.ty)) + 2 - r.pj * P, 0, ${ST - 2});
    return riverFlowBilinear(r.slot, li, lj, r.tx - floor(r.tx), r.ty - floor(r.ty));
}
// The flow at continuous texel coordinates from one page's own texels.
fn riverFlowInPage(slot: u32, pi: u32, pj: u32, tx: f32, ty: f32) -> vec4<f32> {
    let x = tx - 0.5; let y = ty - 0.5;
    let P = i32(riverFieldP.P);
    let li = clamp(i32(floor(x)) + 2 - i32(pi) * P, 0, ${ST - 2});
    let lj = clamp(i32(floor(y)) + 2 - i32(pj) * P, 0, ${ST - 2});
    return riverFlowBilinear(i32(slot), li, lj, x - floor(x), y - floor(y));
}
// Unit tangents of the raster's axes in world space at a direction on a face, and
// the world velocity of flow components taken as dot products with them (exact
// on the skewed axes near a cube corner).
fn riverFlowWorld(face: u32, tx: f32, ty: f32, a: f32, b: f32) -> vec3<f32> {
    let ax = normalize(riverFieldDir(face, tx + 1.0, ty) - riverFieldDir(face, tx - 1.0, ty));
    let ay = normalize(riverFieldDir(face, tx, ty + 1.0) - riverFieldDir(face, tx, ty - 1.0));
    let c = dot(ax, ay);
    return (ax * (a - c * b) + ay * (b - c * a)) / max(1.0 - c * c, 0.25);
}
`;
}
