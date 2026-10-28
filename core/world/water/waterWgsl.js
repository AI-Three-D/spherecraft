// core/world/water/waterWgsl.js
//
// Lakes and rivers for shaders: which water covers a point, at what level,
// and how it looks. Shared WGSL, so the terrain shader draws water in its
// own shading now (owner 2026-10-05: performance first, far water
// simplified) and a water-surface pass can reuse it later.
//
// GPU data (WaterGpuData.js):
// - waterIndex: two halves of one u32 per cell of the water graph's cube
//   grid (6 x N x N cells, cell id = face * N * N + j * N + i):
//   [0, cells): lake slot A + 1 in bits 0..14, slot B + 1 in bits 15..29
//   (0 = none), bit 30 = a graph river cell not traced yet (debug view);
//   [cells, 2 cells): rivers in the cell: its sub-list block + 1 (0 = none);
//   [2 cells, ...): sub-list blocks, one per river cell: for each of its
//   4 x 4 sub-cells, the river segments reaching it: first << 8 | count;
// - waterLakes: per lake, its level and, once refined, its mask layer and
//   tangent-plane frame (lakeRefine.js);
// - waterLakeMasks: r8 layers, 1 where ordinary lake water may show;
//   generation-owned surface fields pack signed bed depth in the same bytes
//   (lakeSurfaceField.js, range in the lake record). They survive coarse LOD;
// - waterRivers: river segments (riverRefine.js), listed per cell;
// - waterParams: switches, grid size, colours, river carve parameters.
// A point is lake water when a lake in its cell has a level above the
// point's height and (refined lakes) the mask allows water there. It is
// river water when it lies below the river's level inside the river's
// channel zone (riverCarve.wgsl.js shapes the terrain there from the same
// segments for its cut-only channel correction).
// Shorelines are exact per pixel: where the terrain height crosses the level.

import { createRiverNoiseWgsl } from './riverShapeNoise.js';
import { createRiverSectionWgsl } from './riverSection.js';

export const WATER_BINDINGS = Object.freeze({ index: 12, lakes: 13, masks: 14, params: 15, rivers: 16 });

// WaterLake: 4 x vec4 (64 bytes). WaterParams: 11 x vec4. WaterRiverSeg: 9 x vec4 (144 bytes).
export const LAKE_RECORD_FLOATS = 16;
export const LAKE_PARAMS_FLOATS = 44;
export const RIVER_SEG_FLOATS = 36;
export const RIVER_MAX_SEGS_PER_CELL = 255;
// River segment lists per 4 x 4 sub-cells of a grid cell (~100 m at gridN
// 512): a terrain point only walks the segments that can reach it.
export const RIVER_SUB = 4;
// Narrow reaches (mountain lakes' streams, 8 m wide; the graph's rivers are
// 30 m or wider): half-width below this. Drawn from their channel profile
// wherever the triangles miss their cut (waterRiverAtView), and listed only
// within NARROW_RIVER_DRAW_M of the camera (WaterGpuData._rebuildRivers).
export const NARROW_RIVER_HW_M = 10;
// Extra apparent depth of far lake water per metre past the near/far switch
// (applyWater): 0.05 adds 20 m by 400 m past it, where the bed's green
// shows through at under 2 %. 0.0125 left 5 m at 2 km altitude: the bed
// still showed through at 40-50 % and blurred (owner 2026-10-12, v20).
export const LAKE_FAR_DEPTH_PER_M = 0.05;
export const NARROW_RIVER_DRAW_M = 12000;
// Water debug view without any water (qtDiag.water.tint, URL water=off): the
// terrain shading returns the ground, near and simulated surfaces are not
// drawn. Beds, banks and their materials stay as generated.
export const WATER_DEBUG_DRY = 10;
// Lake sheets and river surfaces hand over across this much (m) of a lake
// mask's edge (waterLakeEdgeCover, waterLakeGiveWay).
const LAKE_EDGE_RAMP_M = 3;

/**
 * WGSL shared by the water lookup and the river carve: WaterParams,
 * WaterRiverSeg, the params / index / rivers bindings, waterDirToCell().
 * @param {number} group
 * @param {{index: number, params: number, rivers: number}} b  binding numbers
 */
export function createWaterCommonWgsl(group, b) {
    return createRiverNoiseWgsl() + createRiverSectionWgsl() + /* wgsl */`
struct WaterParams {
    gridN: u32, enabled: u32, debugMode: u32, riverCount: u32,
    planetRadius: f32, time: f32, rippleFade: f32, shoreSoftM: f32,
    deepColor: vec4<f32>,      // rgb; a = reflection strength
    absorption: vec4<f32>,     // rgb per metre of water path; a unused
    // Active simulation strip (WaterRiverSim.js): along it the simulated
    // surface draws the water, so the static water fades out (waterSimCover).
    simRiver: vec4<f32>,       // river id, arc lengths s0, s1 of the window (m), half-width (m)
    simFade: vec4<f32>,        // end fade, side fade, dry-bank cut cap (m), simulation fade 0..1
    // x, y, z unused; w: unsolved lakes are not drawn
    // closer than this (m) (their grid-cell outline and coarse level look
    // wrong up close).
    riverLook: vec4<f32>,
    // River cross-section (waterRiverProfile, riverCarve.wgsl.js), x = metres
    // beyond the channel's edge: carve = (on 0/1, bankW: the terrain is the
    // cross-section for x < bankW, blendW: then blends into the natural
    // terrain, waterFrac: water fills this part of the bank-full depth);
    // bank = (bankH: rise beyond the edge, bankSoftM: over ~2x this,
    // bankGrade: further rise per metre, w: bounded bank detail 0..1). These describe a
    // cut ceiling; lower natural terrain is never raised to this profile.
    // shape = (widthVar, wobble, bankVar: riverShapeNoise.js, island height).
    carve: vec4<f32>,
    bank: vec4<f32>,
    shape: vec4<f32>,
    // Near water (WaterGpuData.near): closer than near.y (m) a mesh draws
    // the lakes' surface (core/renderer/water/NearWaterRenderer.js) and the
    // terrain shading keeps only the water's body, faded in from near.x;
    // z = 1 on, 0 off (the terrain shading draws all of the water).
    near: vec4<f32>,
};
// A piece of a traced river between two points (unit directions); values
// interpolate along it: design level (the channel's waterline) and thalweg
// (m above the sphere), half-width (channel edge), pool (< 0 = in a lake:
// no fill), thalweg skew toward the outer bank (+ = left of the flow), mean
// flow speed, foam hint, arc length along the river (m), the river's id,
// and the water's level (normal depth of the river's discharge: what is
// drawn and simulated; at or below the design level); the lake rims of the
// left and right banks (riverSection.js riverBankRim).
struct WaterRiverSeg {
    p0: vec3<f32>, eta0: f32,
    p1: vec3<f32>, eta1: f32,
    hw0: f32, hw1: f32, bed0: f32, bed1: f32,
    pool0: f32, pool1: f32, skew0: f32, skew1: f32,
    speed0: f32, speed1: f32, foam0: f32, foam1: f32,
    s0: f32, s1: f32, river: f32, _pad: f32,
    wl0: f32, wl1: f32, lakeGuard0: f32, lakeGuard1: f32,
    island0: f32, island1: f32, kappa0: f32, kappa1: f32,
    rimL0: f32, rimL1: f32, rimR0: f32, rimR1: f32,
};
@group(${group}) @binding(${b.index}) var<storage, read> waterIndex: array<u32>;
@group(${group}) @binding(${b.params}) var<uniform> waterParams: WaterParams;
@group(${group}) @binding(${b.rivers}) var<storage, read> waterRivers: array<WaterRiverSeg>;

const WATER_RIVER_SUB: u32 = ${RIVER_SUB}u;

// Cube-grid cell of a unit direction and its sub-cell (0 .. SUB^2 - 1);
// same mapping as waterGraph.js dirToCell / dirToCellSub.
fn waterDirToCellSub(d: vec3<f32>, n: u32) -> vec2<u32> {
    let a = abs(d);
    var face = 0u;
    var x = 0.0;
    var y = 0.0;
    if (a.x >= a.y && a.x >= a.z) {
        if (d.x > 0.0) { face = 0u; x = -d.z / d.x; y = d.y / d.x; }
        else { face = 1u; x = d.z / -d.x; y = d.y / -d.x; }
    } else if (a.y >= a.z) {
        if (d.y > 0.0) { face = 2u; x = d.x / d.y; y = -d.z / d.y; }
        else { face = 3u; x = d.x / -d.y; y = d.z / -d.y; }
    } else if (d.z > 0.0) {
        face = 4u; x = d.x / d.z; y = d.y / d.z;
    } else {
        face = 5u; x = -d.x / -d.z; y = d.y / -d.z;
    }
    let fn_ = f32(n);
    let fx = (x + 1.0) * 0.5 * fn_;
    let fy = (y + 1.0) * 0.5 * fn_;
    let i = u32(clamp(floor(fx), 0.0, fn_ - 1.0));
    let j = u32(clamp(floor(fy), 0.0, fn_ - 1.0));
    let sub = f32(WATER_RIVER_SUB);
    let si = u32(clamp(floor((fx - f32(i)) * sub), 0.0, sub - 1.0));
    let sj = u32(clamp(floor((fy - f32(j)) * sub), 0.0, sub - 1.0));
    return vec2<u32>(face * n * n + j * n + i, sj * WATER_RIVER_SUB + si);
}

fn waterDirToCell(d: vec3<f32>, n: u32) -> u32 {
    return waterDirToCellSub(d, n).x;
}

// The nearest point of a river segment to a unit direction, and the
// segment's values there. The half-width varies along a river in the trace
// (riverSection.js riverWidthFactor); here only the channel's centre wanders
// a little off the traced line (the wobble, riverShapeNoise.js), and the
// bend's curvature picks each side's bank (riverSection.js riverBankType).
struct WaterRiverPt {
    d: f32,          // distance from the channel's centre (m)
    n: f32,          // signed offset from it, + left of the flow
    nSign: f32,      // side of the traced line (+1 left, -1 right)
    dLine: f32,      // distance from the traced line (m)
    t: f32,          // position along the segment (0..1)
    tRaw: f32,       // unclamped
    v: vec3<f32>,    // the direction minus the nearest point of the line
    eta: f32, bed: f32, hw: f32, pool: f32, skew: f32, speed: f32, foam: f32,
    wl: f32,         // the water's level (m)
    s: f32,          // arc length along the river (m)
    river: f32,      // the river's id
    dOff: f32,       // d(centre offset)/ds
    dHw: f32,        // d(half-width)/ds
    dEta: f32, dBed: f32, dWl: f32,  // d(design level, thalweg, water level)/ds
    kappa: f32,      // the bend's signed curvature (1/m, + turning left)
    lakeGuard: f32,  // nearby lake level: terrain below it must not be filled
    guardW: f32,     // how much the guard applies, 0..1 along the segment (an end without one: 0)
    island: f32, dIsland: f32,
    rimL: f32, rimR: f32,  // lake rims of the banks (riverBankRim)
};

fn waterRiverPoint(s: WaterRiverSeg, dir: vec3<f32>) -> WaterRiverPt {
    return waterRiverPointOn(s, dir, false);
}
// extend: on the segment's line past its ends, its values extrapolated (the
// river carve's blend across a joint; riverCarve.wgsl.js riverCarveJoint),
// instead of a rounded cap with the end's values.
fn waterRiverPointOn(s: WaterRiverSeg, dir: vec3<f32>, extend: bool) -> WaterRiverPt {
    var p: WaterRiverPt;
    let ab = s.p1 - s.p0;
    p.tRaw = dot(dir - s.p0, ab) / max(dot(ab, ab), 1.0e-20);
    p.t = select(clamp(p.tRaw, 0.0, 1.0), p.tRaw, extend);
    p.v = dir - (s.p0 + ab * p.t);
    p.dLine = length(p.v) * waterParams.planetRadius;
    let left = cross(dir, ab);
    p.nSign = select(-1.0, 1.0, dot(p.v, left) >= 0.0);
    p.eta = mix(s.eta0, s.eta1, p.t);
    p.bed = mix(s.bed0, s.bed1, p.t);
    p.pool = mix(s.pool0, s.pool1, p.t);
    p.skew = mix(s.skew0, s.skew1, p.t);
    p.speed = mix(s.speed0, s.speed1, p.t);
    p.foam = mix(s.foam0, s.foam1, p.t);
    p.wl = mix(s.wl0, s.wl1, p.t);
    p.kappa = mix(s.kappa0, s.kappa1, p.t);
    p.rimL = mix(s.rimL0, s.rimL1, p.t);
    p.rimR = mix(s.rimR0, s.rimR1, p.t);
    p.lakeGuard = max(s.lakeGuard0, s.lakeGuard1);
    // Per segment the guard switched on where the nearest segment changes:
    // a step in the banks across the river (owner 2026-10-26).
    p.guardW = mix(select(0.0, 1.0, s.lakeGuard0 > -1.0e10), select(0.0, 1.0, s.lakeGuard1 > -1.0e10), clamp(p.t, 0.0, 1.0));
    p.island = mix(s.island0, s.island1, p.t);
    p.dIsland = (s.island1 - s.island0) / max(s.s1 - s.s0, 0.001);
    p.s = mix(s.s0, s.s1, p.t);
    p.river = s.river;
    p.hw = max(mix(s.hw0, s.hw1, p.t), 0.5);
    let m = waterRiverSlopes(s);
    p.dWl = m.x; p.dEta = m.y; p.dBed = m.z; p.dHw = m.w;
    waterRiverWobble(&p);
    return p;
}

// The channel's centre off the traced line (the wobble, riverShapeNoise.js)
// for the point's half-width.
fn waterRiverWobble(p: ptr<function, WaterRiverPt>) {
    let on = waterRiverNoise((*p).s, (*p).river, 1u);
    (*p).dOff = waterParams.shape.y * ((*p).dHw * on.x + (*p).hw * on.y);
    (*p).n = (*p).nSign * (*p).dLine - waterParams.shape.y * (*p).hw * on.x;
    (*p).d = abs((*p).n);
}

// Per metre along a segment: water level, design level, thalweg, half-width.
fn waterRiverSlopes(s: WaterRiverSeg) -> vec4<f32> {
    return vec4<f32>(s.wl1 - s.wl0, s.eta1 - s.eta0, s.bed1 - s.bed0, s.hw1 - s.hw0) / max(s.s1 - s.s0, 0.001);
}
// Segment a runs on into segment b (same river, adjacent arc).
fn waterRiverRunsInto(a: WaterRiverSeg, b: WaterRiverSeg) -> bool {
    return a.river == b.river && abs(a.s1 - b.s0) <= 0.5;
}

// waterRiverPointOn of segment k of the list [listStart, listEnd), its
// levels, thalweg and half-width the trace's piecewise-linear values
// averaged over a window of half the shorter segment at each joint
// (riverRibbon.js riverJointValue): their slopes change linearly from one
// segment's to the next's. Through the trace's points instead, a C1 curve
// overshoots in slope every segment: bands across steep beds, banks bulging
// once a segment (owner 2026-10-26, "stairs"). On an extended line past the
// segment's end the neighbour's values hold, so both sides of a joint agree.
fn waterRiverPointAt(k: u32, listStart: u32, listEnd: u32, dir: vec3<f32>, extend: bool) -> WaterRiverPt {
    var p = waterRiverPointOn(waterRivers[k], dir, extend);
    var g = k;
    var sg = waterRivers[k];
    let u = p.s;
    if (u < sg.s0 && g > listStart && waterRiverRunsInto(waterRivers[g - 1u], sg)) { g = g - 1u; sg = waterRivers[g]; }
    else if (u > sg.s1 && g + 1u < listEnd && waterRiverRunsInto(sg, waterRivers[g + 1u])) { g = g + 1u; sg = waterRivers[g]; }
    let L = max(sg.s1 - sg.s0, 0.001);
    let t = (u - sg.s0) / L;
    var v = vec4<f32>(mix(sg.wl0, sg.wl1, t), mix(sg.eta0, sg.eta1, t), mix(sg.bed0, sg.bed1, t), mix(sg.hw0, sg.hw1, t));
    var m = waterRiverSlopes(sg);
    if (sg.s1 - u < u - sg.s0) {
        if (g + 1u < listEnd && waterRiverRunsInto(sg, waterRivers[g + 1u])) {
            let o = waterRivers[g + 1u];
            let b = 0.5 * min(L, o.s1 - o.s0);
            let a = max(sg.s1 - u, 0.0);
            if (a < b) {
                let dm = waterRiverSlopes(o) - m;
                v += dm * ((b - a) * (b - a) / (4.0 * b));
                m += dm * ((b - a) / (2.0 * b));
            }
        }
    } else if (g > listStart && waterRiverRunsInto(waterRivers[g - 1u], sg)) {
        let o = waterRivers[g - 1u];
        let b = 0.5 * min(L, o.s1 - o.s0);
        let a = max(u - sg.s0, 0.0);
        if (a < b) {
            let dm = m - waterRiverSlopes(o);
            v += dm * ((b - a) * (b - a) / (4.0 * b));
            m -= dm * ((b - a) / (2.0 * b));
        }
    }
    p.wl = v.x; p.eta = v.y; p.bed = v.z; p.hw = max(v.w, 0.5);
    p.dWl = m.x; p.dEta = m.y; p.dBed = m.z; p.dHw = m.w;
    waterRiverWobble(&p);
    return p;
}

// The segments across segment k's joints (its neighbours in the list
// [listStart, listEnd): same river, adjacent arc), each with its weight and
// the weight's gradient (d/d dir): by the signed distance a from the
// joint's bisector plane into segment k's side, 1/2 on the plane, 0 from
// a = b (half the shorter segment) and 1 at a = -b, so either segment's
// weight gives the same mix wherever the nearest segment switches. Each
// segment's section alone changed the banks' slope at every joint: bands
// across the river (owner 2026-10-26, "scales", "stairs"). Measured along
// the segment instead, the weights did not add up to 1 where the nearest
// segment switches on the inner side of bends: the banks jogged there; with
// one neighbour by the half of the segment, the mix jumped at mid-segment
// deep inside tight bends. All are taken on their lines extended past the
// joints
// (waterRiverPointOn): a rounded cap there is shallower.
struct WaterRiverJoint { k: u32, w: f32, dw: vec3<f32>, };
// The neighbour across the joint at segment k's end (next) or start, weight 0
// when there is none or the point is past b on k's side.
fn waterRiverJointAt(k: u32, listStart: u32, listEnd: u32, s: WaterRiverSeg, dir: vec3<f32>, next: bool) -> WaterRiverJoint {
    var j = WaterRiverJoint(k, 0.0, vec3<f32>(0.0));
    if ((next && k + 1u >= listEnd) || (!next && k <= listStart)) { return j; }
    let ko = select(k - 1u, k + 1u, next);
    let o = waterRivers[ko];
    if (o.river != s.river || abs(select(o.s1 - s.s0, o.s0 - s.s1, next)) > 0.5) { return j; }
    let band = 0.5 * min(s.s1 - s.s0, o.s1 - o.s0);
    if (band <= 0.0) { return j; }
    // Bisector plane through the joint: normal along the mean direction.
    let joint = select(s.p0, s.p1, next);
    let us = normalize(s.p1 - s.p0);
    let uo = normalize(o.p1 - o.p0);
    // Off at joints that barely turn (a third turn under 1 degree): no
    // crease to hide there, and each blend evaluates another section
    // (tile generation 3.0 -> 3.35 ms a tile with every joint blended).
    // 1 - cos: 0.3 degrees 1.4e-5, 1 degree 1.5e-4.
    let turnW = smoothstep(1.4e-5, 1.5e-4, 1.0 - dot(us, uo));
    if (turnW <= 0.0) { return j; }
    let nb = normalize(us + uo) * select(1.0, -1.0, next);
    let R = waterParams.planetRadius;
    let a = dot(dir - joint, nb) * R;
    let x = clamp(a / band, -1.0, 1.0);
    // 1/2 - (3 x |x| - 2 x^3) / 2: C1, odd about the plane.
    j.k = ko;
    j.w = turnW * (0.5 - 0.5 * (3.0 * x * abs(x) - 2.0 * x * x * x));
    j.dw = turnW * select(vec3<f32>(0.0), nb * (R / band) * (-0.5 * (6.0 * abs(x) - 6.0 * x * x)), abs(a) < band);
    return j;
}
// Both joints of segment k: upstream (.x) and downstream (.y).
struct WaterRiverJoints { up: WaterRiverJoint, down: WaterRiverJoint, };
fn waterRiverJoints(k: u32, listStart: u32, listEnd: u32, s: WaterRiverSeg, dir: vec3<f32>) -> WaterRiverJoints {
    return WaterRiverJoints(waterRiverJointAt(k, listStart, listEnd, s, dir, false), waterRiverJointAt(k, listStart, listEnd, s, dir, true));
}

// A point plus w times (b - a), field by field (waterRiverJoints' blend; a's
// side and lake guard).
fn waterRiverPtAdd(p0: WaterRiverPt, a: WaterRiverPt, b: WaterRiverPt, w: f32) -> WaterRiverPt {
    var p = p0;
    let q = waterRiverPtMix(a, b, w);
    p.n += q.n - a.n; p.dLine += q.dLine - a.dLine; p.eta += q.eta - a.eta; p.bed += q.bed - a.bed;
    p.hw += q.hw - a.hw; p.pool += q.pool - a.pool; p.skew += q.skew - a.skew; p.speed += q.speed - a.speed;
    p.foam += q.foam - a.foam; p.wl += q.wl - a.wl; p.kappa += q.kappa - a.kappa; p.rimL += q.rimL - a.rimL;
    p.rimR += q.rimR - a.rimR; p.island += q.island - a.island; p.s += q.s - a.s; p.dHw += q.dHw - a.dHw;
    p.dEta += q.dEta - a.dEta; p.dBed += q.dBed - a.dBed; p.dWl += q.dWl - a.dWl;
    p.guardW += q.guardW - a.guardW;
    p.lakeGuard = max(p.lakeGuard, select(-1.0e20, b.lakeGuard, w > 0.0));
    p.d = abs(p.n);
    return p;
}
// Segment k's point (waterRiverPointAt) blended into its neighbours' across
// its joints (waterRiverJoints), as the carve blends their sections.
fn waterRiverBlended(k: u32, listStart: u32, listEnd: u32, dir: vec3<f32>) -> WaterRiverPt {
    let joints = waterRiverJoints(k, listStart, listEnd, waterRivers[k], dir);
    if (joints.up.w <= 0.0 && joints.down.w <= 0.0) { return waterRiverPointAt(k, listStart, listEnd, dir, false); }
    let own = waterRiverPointAt(k, listStart, listEnd, dir, true);
    var p = own;
    if (joints.up.w > 0.0) { p = waterRiverPtAdd(p, own, waterRiverPointAt(joints.up.k, listStart, listEnd, dir, true), joints.up.w); }
    if (joints.down.w > 0.0) { p = waterRiverPtAdd(p, own, waterRiverPointAt(joints.down.k, listStart, listEnd, dir, true), joints.down.w); }
    return p;
}
fn waterRiverPtMix(a: WaterRiverPt, b: WaterRiverPt, w: f32) -> WaterRiverPt {
    var p = a;
    p.n = mix(a.n, b.n, w);
    p.d = abs(p.n);
    p.dLine = mix(a.dLine, b.dLine, w);
    p.eta = mix(a.eta, b.eta, w);
    p.bed = mix(a.bed, b.bed, w);
    p.hw = mix(a.hw, b.hw, w);
    p.pool = mix(a.pool, b.pool, w);
    p.skew = mix(a.skew, b.skew, w);
    p.speed = mix(a.speed, b.speed, w);
    p.foam = mix(a.foam, b.foam, w);
    p.wl = mix(a.wl, b.wl, w);
    p.kappa = mix(a.kappa, b.kappa, w);
    p.rimL = mix(a.rimL, b.rimL, w);
    p.rimR = mix(a.rimR, b.rimR, w);
    p.island = mix(a.island, b.island, w);
    p.s = mix(a.s, b.s, w);
    p.dHw = mix(a.dHw, b.dHw, w);
    p.dEta = mix(a.dEta, b.dEta, w);
    p.dBed = mix(a.dBed, b.dBed, w);
    p.dWl = mix(a.dWl, b.dWl, w);
    p.guardW = mix(a.guardW, b.guardW, w);
    p.lakeGuard = max(a.lakeGuard, select(-1.0e20, b.lakeGuard, w > 0.0));
    return p;
}

// Each side's bank (riverSection.js): left, then right. Toward a lake beside
// the river (guardW) it lowers to the type without a step: a cut bank's wall
// ran on to the lake's shore and turned along it in a corner (owner
// 2026-10-26, a notch at a mouth). The lake's rim still holds it up where
// the lake would spill into the channel (riverBankRim).
fn waterRiverBank(p: WaterRiverPt, left: bool) -> RiverBank {
    let b = riverBankParams(riverBankType(p.s, p.river, left, p.kappa), p.river);
    return riverBankMix(b, riverBankParams(0.0, p.river), clamp(p.guardW, 0.0, 1.0));
}

// Height (m) of the river's channel at a point inside it (d < hw): the
// section's bed (riverSection.js riverChannel), the side of the thalweg
// with its bank's freeboard. D = (level - thalweg) / waterFrac.
fn waterRiverProfile(p: WaterRiverPt) -> f32 {
    let D = (p.eta - p.bed) / max(waterParams.carve.w, 0.05);
    let side = p.n >= p.skew * p.hw;
    let depth = riverSideDepth(D, waterRiverBank(p, side).freeboard);
    return riverChannel(p.n, p.hw, p.bed, depth, depth, p.skew);
}

// River segments listed at a unit direction: first << 8 | count (0: none).
fn waterRiverList(d: vec3<f32>) -> u32 {
    let n = waterParams.gridN;
    let cs = waterDirToCellSub(d, n);
    // The cell's second word: its river block (+1) below bit 17, a third lake above.
    let block = waterIndex[6u * n * n + cs.x] & 0x1ffffu;
    if (block == 0u) { return 0u; }
    return waterIndex[12u * n * n + (block - 1u) * WATER_RIVER_SUB * WATER_RIVER_SUB + cs.y];
}
`;
}

/**
 * Lake and river lookups (waterLakeLevelAt, waterLakeHitView, waterRiverAt):
 * the lake table and masks, on the bindings of createWaterCommonWgsl (which
 * the caller includes). The water rendering (createWaterWgsl) and the terrain
 * generator's lake beds (riverCarve.wgsl.js) share them.
 * @param {number} group
 * @param {{lakes: number, masks: number}} b  binding numbers
 */
export function createWaterLookupWgsl(group, b) {
    return /* wgsl */`
struct WaterLake {
    level: f32, maskLayer: i32, sizeX: f32, sizeY: f32,
    c: vec3<f32>, x0: f32,
    e1: vec3<f32>, y0: f32,
    e2: vec3<f32>, surfaceDepthRangeM: f32,
};
@group(${group}) @binding(${b.lakes}) var<storage, read> waterLakes: array<WaterLake>;
@group(${group}) @binding(${b.masks}) var waterLakeMasks: texture_2d_array<f32>;

const WATER_NO_LAKE: f32 = -1.0e30;
// cover: how far inside its mask's edge the point is, 0..1 over its last
// metres (signed-distance masks, waterLakeEdgeCover; 1 otherwise): river surfaces hand over to the
// lake's by it (nearWaterSurface.wgsl.js). insideM: metres inside that edge
// (signed-distance masks; 1000 otherwise, 0 for none).
struct WaterLakeHit { level: f32, depthM: f32, cover: f32, insideM: f32, }

fn waterLakeCandidateCount(cell: u32) -> u32 {
    let e = waterIndex[cell];
    if ((e & 0x80000000u) != 0u) { return waterIndex[e & 0x3fffffffu]; }
    return 3u;
}
fn waterLakeCandidate(cell: u32, k: u32) -> u32 {
    let e = waterIndex[cell];
    if ((e & 0x80000000u) != 0u) { return waterIndex[(e & 0x3fffffffu) + 1u + k]; }
    if (k == 0u) { return e & 0x7fffu; }
    if (k == 1u) { return (e >> 15u) & 0x7fffu; }
    return waterIndex[6u * waterParams.gridN * waterParams.gridN + cell] >> 17u;
}

// Structured planets keep every immutable lake mask resident. Several masks
// share an array layer; clamp to texel centres to prevent adjacent-tile bleed.
fn waterLakeMaskSample(lake: WaterLake, uv: vec2<f32>, samp: sampler) -> f32 {
    let code=u32(lake.maskLayer);let tiles=max(1u,code>>16u);
    let tile=vec2<f32>(f32((code>>8u)&15u),f32((code>>12u)&15u));
    let size=vec2<f32>(textureDimensions(waterLakeMasks))/f32(tiles);
    let local=clamp(uv,0.5/size,vec2<f32>(1.0)-0.5/size);
    return textureSampleLevel(waterLakeMasks,samp,(tile+local)/f32(tiles),i32(code&255u),0.0).r;
}

// The same, with a cubic B-spline (4 bilinear taps), for the signed-distance
// masks: their shore as a smooth curve. Bilinear between texels (32 m on the
// big lakes) drew it in scallops, one per texel (owner 2026-10-14, the
// "sine-wave" bank; water-look v104).
fn waterLakeMaskSampleSmooth(lake: WaterLake, uv: vec2<f32>, samp: sampler) -> f32 {
    let code=u32(lake.maskLayer);let tiles=max(1u,code>>16u);
    let tile=vec2<f32>(f32((code>>8u)&15u),f32((code>>12u)&15u));
    let size=vec2<f32>(textureDimensions(waterLakeMasks))/f32(tiles);
    let p=clamp(uv,0.5/size,vec2<f32>(1.0)-0.5/size)*size-0.5;
    let i=floor(p);let f=p-i;let f2=f*f;let f3=f2*f;
    let w0=(1.0-3.0*f+3.0*f2-f3)/6.0;let w1=(4.0-6.0*f2+3.0*f3)/6.0;
    let w2=(1.0+3.0*f+3.0*f2-3.0*f3)/6.0;let w3=f3/6.0;
    let g0=w0+w1;let g1=w2+w3;
    let lo=clamp((i+0.5-1.0+w1/g0)/size,0.5/size,vec2<f32>(1.0)-0.5/size);
    let hi=clamp((i+0.5+1.0+w3/g1)/size,0.5/size,vec2<f32>(1.0)-0.5/size);
    let L=i32(code&255u);let T=f32(tiles);
    let a=textureSampleLevel(waterLakeMasks,samp,(tile+lo)/T,L,0.0).r;
    let b=textureSampleLevel(waterLakeMasks,samp,(tile+vec2<f32>(hi.x,lo.y))/T,L,0.0).r;
    let c=textureSampleLevel(waterLakeMasks,samp,(tile+vec2<f32>(lo.x,hi.y))/T,L,0.0).r;
    let d=textureSampleLevel(waterLakeMasks,samp,(tile+hi)/T,L,0.0).r;
    return g0.y*(g0.x*a+g1.x*b)+g1.y*(g0.x*c+g1.x*d);
}

// Outside the solved water (signed-distance band), how far the lake gives
// way to a river below its level: over 2-12 cm of level and the channel's
// last metre across. Switched at 2 cm and the channel's edge, the river and
// lake surfaces tested it at points a little apart and left gaps along it, a
// dotted line across an outlet (owner 2026-10-26). The lake sheets use it
// too (nearWaterSurface.wgsl.js).
fn waterLakeBelowRiver(lake: WaterLake, river: WaterRiverHit) -> f32 {
    if (!river.near) { return 0.0; }
    return smoothstep(0.02, 0.12, lake.level - river.etaM) * (1.0 - smoothstep(river.halfWidthM - 1.0, river.halfWidthM, river.distM));
}
// A signed-distance mask's edge (F, m): the share of it covering the point
// over its last ${LAKE_EDGE_RAMP_M} m, and how far the lake gives way to a river below it
// there (waterLakeBelowRiver), fading out over the same before its solved
// water. Over 1 m, and switched off at the solved water, the river's and the
// lake's surfaces handed over in a line across an outlet where the river
// had fallen below the lake (owner 2026-10-27). The lake sheets use them too.
fn waterLakeEdgeCover(lake: WaterLake, F: f32) -> f32 {
    return smoothstep(lake.surfaceDepthRangeM, lake.surfaceDepthRangeM + ${LAKE_EDGE_RAMP_M.toFixed(1)}, F);
}
fn waterLakeGiveWay(lake: WaterLake, river: WaterRiverHit, F: f32) -> f32 {
    return waterLakeBelowRiver(lake, river) * (1.0 - smoothstep(-${LAKE_EDGE_RAMP_M.toFixed(1)}, 0.0, F));
}

// Level of lake slot s (1-based, 0 = none) if it covers dir at heightM.
// levelOnly: lakes without a solved shore (no mask layer) count too.
// giveWay: the lake gives way to a river below it (waterLakeGiveWay): which
// water is drawn there, not where the lake's bed lies (riverCarve.wgsl.js).
fn waterLakeHitIn(slot: u32, dir: vec3<f32>, heightM: f32, samp: sampler, levelOnly: bool, giveWay: bool) -> WaterLakeHit {
    let miss=WaterLakeHit(WATER_NO_LAKE,0.0,0.0,0.0);
    if (slot == 0u) { return miss; }
    let lake = waterLakes[slot - 1u];
    if (lake.surfaceDepthRangeM<=0.0 && heightM >= lake.level) { return miss; }
    if (lake.maskLayer < 0) {
        if(levelOnly && heightM<lake.level) { return WaterLakeHit(lake.level,lake.level-heightM,1.0,1000.0); }
        return miss;
    }
    let k = dot(dir, lake.c);
    if (k <= 0.0) { return miss; }
    let px = dot(dir, lake.e1) / k * waterParams.planetRadius;
    let py = dot(dir, lake.e2) / k * waterParams.planetRadius;
    let uv = vec2<f32>((px - lake.x0) / lake.sizeX, (py - lake.y0) / lake.sizeY);
    if (any(uv < vec2<f32>(0.0)) || any(uv > vec2<f32>(1.0))) { return miss; }
    let m = select(waterLakeMaskSample(lake,uv,samp),waterLakeMaskSampleSmooth(lake,uv,samp),lake.surfaceDepthRangeM<0.0);
    if(lake.surfaceDepthRangeM>0.0) {
        // The generation-owned bed field keeps small lakes visible when
        // coarse render triangles miss their depression. Real water level
        // remains unchanged; sampled depth affects only coverage/shading.
        let depth=(m*255.0-128.0)*(lake.surfaceDepthRangeM/127.0);
        if(depth<=0.0) { return miss; }
        return WaterLakeHit(lake.level,depth,1.0,1000.0);
    }
    // Signed-distance masks (lakeMaskSdf.js): water within -range metres of
    // the solved water, and the rendered ground below the level (above).
    if(lake.surfaceDepthRangeM<0.0) {
        let F=m*255.0-128.0;
        if(F<=lake.surfaceDepthRangeM) { return miss; }
        var cover = waterLakeEdgeCover(lake, F);
        if(giveWay && F<0.0) { cover *= 1.0 - waterLakeGiveWay(lake, waterRiverAt(dir, heightM), F); }
        if(cover <= 0.0) { return miss; }
        return WaterLakeHit(lake.level,lake.level-heightM,cover,F-lake.surfaceDepthRangeM);
    }
    // The shore band is render coverage, not lake water. Once excavation
    // lowers an outlet, the band's flat lake sheet must give way to the
    // descending river; otherwise it hangs over the channel as a wedge.
    if (m >= 0.5 && m < 0.75) {
        let river = waterRiverAt(dir, heightM);
        if (river.near && river.distM < river.halfWidthM && river.etaM < lake.level - 0.02) { return miss; }
    }
    if(m>=0.5) { return WaterLakeHit(lake.level,lake.level-heightM,1.0,1000.0); }
    return miss;
}

// Water level over a point (unit direction, height above the sphere), or
// WATER_NO_LAKE.
fn waterLakeLevelAt(dir: vec3<f32>, heightM: f32, samp: sampler) -> f32 {
    return waterLakeLevelView(dir, heightM, samp, true);
}
fn waterLakeLevelView(dir: vec3<f32>, heightM: f32, samp: sampler, levelOnly: bool) -> f32 {
    return waterLakeHitView(dir,heightM,samp,levelOnly,true).level;
}
// The lake as its sheet sees it on the view ray from cam through wp (world
// positions, planet centre origin): each candidate tested where the ray
// meets its level. A river surface a little above or below that level
// tested the mask a little apart, at a grazing view tens of centimetres, and
// over the mask's last metre the river's and the lake's shares overlapped:
// a line across an outlet (owner 2026-10-27).
fn waterLakeHitOnRay(origin: vec3<f32>, cam: vec3<f32>, wp: vec3<f32>, samp: sampler) -> WaterLakeHit {
    let up = normalize(wp - origin);
    let cell = waterDirToCell(up, waterParams.gridN);
    let ray = normalize(wp - cam);
    let o = cam - origin;
    let b = dot(o, ray);
    let count = waterLakeCandidateCount(cell);
    for (var k = 0u; k < count; k++) {
        let slot = waterLakeCandidate(cell, k);
        if (slot == 0u) { continue; }
        let r = waterParams.planetRadius + waterLakes[slot - 1u].level;
        let disc = b * b - dot(o, o) + r * r;
        var dir = up;
        if (disc > 0.0) {
            let near = -b - sqrt(disc);
            let t = select(-b + sqrt(disc), near, near > 0.0);
            if (t > 0.0) { dir = normalize(o + ray * t); }
        }
        let h = waterLakeHitIn(slot, dir, -1.0e30, samp, false, true);
        if (h.level > WATER_NO_LAKE) { return h; }
    }
    return WaterLakeHit(WATER_NO_LAKE, 0.0, 0.0, 0.0);
}
fn waterLakeHitView(dir: vec3<f32>, heightM: f32, samp: sampler, levelOnly: bool, giveWay: bool) -> WaterLakeHit {
    let n = waterParams.gridN;
    let cell = waterDirToCell(dir, n);
    let e = waterIndex[cell];
    // Crowded cells keep every candidate in a sparse overflow list. The
    // lake renderer draws these sheets too; silently dropping a fourth
    // candidate left an overlapping river surface visible through them.
    if ((e & 0x80000000u) != 0u) {
        let at = e & 0x3fffffffu;
        let count = waterIndex[at];
        for (var k = 0u; k < count; k++) {
            let h = waterLakeHitIn(waterIndex[at + 1u + k], dir, heightM, samp, levelOnly, giveWay);
            if (h.level > WATER_NO_LAKE) { return h; }
        }
        return WaterLakeHit(WATER_NO_LAKE, 0.0, 0.0, 0.0);
    }
    let a = waterLakeHitIn(e & 0x7fffu, dir, heightM, samp, levelOnly, giveWay);
    if (a.level > WATER_NO_LAKE) { return a; }
    let b = waterLakeHitIn((e >> 15u) & 0x7fffu, dir, heightM, samp, levelOnly, giveWay);
    if (b.level > WATER_NO_LAKE) { return b; }
    // A third lake in the cell (in its second word, above the river block).
    return waterLakeHitIn(waterIndex[6u * n * n + cell] >> 17u, dir, heightM, samp, levelOnly, giveWay);
}

struct WaterRiverHit {
    found: bool,          // water at the point
    near: bool,           // within the channel zone (channel + bankW) of a river
    constructedSurface: bool, // coarse cut contract supplies coverage, not a sampled bed
    opaqueBody: bool,     // structured or narrow reach: shade the body without the coarse ground below
    depthM: f32,          // water depth at the point
    distM: f32,           // distance from the river line
    halfWidthM: f32,
    profileM: f32,        // the carved channel's height at the point (in the channel; 1e30 beyond)
    etaM: f32,            // the water's level there
    flow: vec3<f32>,      // flow direction (unit, along the line)
    speed: f32,
    foam: f32,
    sM: f32,              // arc length along the river (m)
    nM: f32,              // offset across (m, + left of the flow)
    river: f32,           // the river's id
    pool: f32,            // < 0 inside a lake
    seg: f32,             // index of the nearest traced segment (debug view 5)
    slope: f32,           // descending water-surface slope, including waterfall lips
    lakeGuard: f32,       // level of a lake beside the river (WaterRiverPt.lakeGuard)
    lakeGuardW: f32,      // how much it applies (WaterRiverPt.guardW)
};

// Close queries use actual terrain. A flagged, island-free structured segment
// also defines a cut-only bed upper bound inside its full-cut channel core.
// The distant renderer may use that field when coarse triangles miss the cut.
fn waterRiverAt(dir: vec3<f32>, heightM: f32) -> WaterRiverHit {
    return waterRiverAtView(dir,heightM,false);
}
fn waterRiverAtView(dir: vec3<f32>, heightM: f32, coarseSurface: bool) -> WaterRiverHit {
    var hit: WaterRiverHit;
    hit.found = false;
    hit.near = false;
    let e = waterRiverList(dir);
    let count = min(e & 0xffu, ${RIVER_MAX_SEGS_PER_CELL}u);
    if (count == 0u) { return hit; }
    let first = e >> 8u;
    // Nearest by the traced line (cheap); its shape only for that one.
    var bestK = first;
    var bestD = 1.0e30;
    for (var k = 0u; k < count; k++) {
        let sg = waterRivers[first + k];
        let ab = sg.p1 - sg.p0;
        let t = clamp(dot(dir - sg.p0, ab) / max(dot(ab, ab), 1.0e-20), 0.0, 1.0);
        let dd = length(dir - (sg.p0 + ab * t));
        if (dd < bestD) { bestD = dd; bestK = first + k; }
    }
    let s = waterRivers[bestK];
    // Per frame the nearest segment alone (the carve, made once per tile,
    // blends across joints and filters the values: waterRiverBlended). The
    // blend here cost 3-8 ms a frame; the near surfaces draw the water's
    // level from their own (filtered) rows.
    let best = waterRiverPoint(s, dir);
    let zone = best.hw + waterParams.carve.y;
    if (best.d > zone) { return hit; }
    hit.near = true;
    hit.sM = best.s;
    hit.lakeGuard = best.lakeGuard;
    hit.lakeGuardW = best.guardW;
    hit.nM = best.n;
    hit.river = best.river;
    hit.pool = best.pool;
    hit.seg = f32(bestK);
    hit.distM = best.d;
    hit.halfWidthM = best.hw;
    hit.profileM = select(1.0e30, waterRiverProfile(best), best.d < best.hw);
    hit.etaM = best.wl;
    hit.speed = best.speed;
    hit.foam = best.foam;
    // Waterline of the channel profile at the water's depth h (of the
    // bank-full D): 1 - (1 - u^2)^1.5 = h / D. Only in the channel: carved
    // banks rise above the level beyond it, and terrain not carved yet must
    // not flood out to the zone's straight edge (owner 2026-10-05).
    // The actual terrain is authoritative: painting an assumed parabola
    // over dry terrain hid islands and flooded banks before regeneration.
    var depthM = select(0.0, max(best.wl - heightM, 0.0), best.d < best.hw);
    let flagged=s._pad>0.5 && waterParams.carve.x>0.5;
    // Narrow reaches (NARROW_RIVER_HW_M) take their water from the carved
    // channel's profile at every distance, not from the triangles: an 8 m
    // channel is finer than them. Drawn from the triangles, the stream read
    // as a dry trench from ~0.5 km (lake-recovery run 22), and with banks
    // only 0.2 m above the water the triangles dipped under it in flakes
    // near the camera (owner 2026-10-12, "shards"; water-look v38, v53).
    // Wider rivers keep the terrain authoritative near the camera.
    let narrow=flagged && best.hw<${NARROW_RIVER_HW_M.toFixed(1)};
    hit.constructedSurface=(coarseSurface && flagged) || narrow;
    // Structured reaches (flag 2) and narrow ones shade an opaque body at
    // every distance it is drawn from the profile; other traced reaches
    // (flag 1) blend into it from their near colour model (applyWater),
    // since an opaque body right at the switch made a step.
    hit.opaqueBody=hit.constructedSurface && (s._pad>1.5 || narrow);
    if(hit.constructedSurface) {
        depthM=0.0;
        // Below .85*width the terrain cut has full weight, and final micro
        // is suppressed. No island endpoints are flagged. Preserve the
        // first point's backward cap exclusion and allow scalar error.
        if(best.d<best.hw*0.85 && !(s.s0<=0.0 && best.tRaw<0.0)) {
            depthM=max(best.wl-hit.profileM-0.25,0.0);
        }
    }
    hit.found = depthM > 0.0;
    hit.depthM = depthM;
    // The water level's fall per metre along the flow, as the carve's (smooth across joints).
    hit.slope = max(0.0, -best.dWl);
    let ab = s.p1 - s.p0;
    let along = ab - dir * dot(ab, dir);
    let left = normalize(cross(dir, ab));
    let split = left * select(-1.0, 1.0, best.n >= 0.0) * best.dIsland * best.hw * 0.35;
    hit.flow = select(normalize(cross(dir, vec3<f32>(0.0, 1.0, 0.0001))), normalize(along + split * length(along)), dot(along, along) > 1.0e-24);
    return hit;
}
`;
}

/**
 * @param {object} [o]
 * @param {number} [o.group=3]   bind group of the water bindings
 * @returns {string} WGSL: structs, bindings, waterLakeLevelAt(), waterRiverAt(), applyWater()
 */
export function createWaterWgsl({ group = 3 } = {}) {
    const B = WATER_BINDINGS;
    return /* wgsl */`
// ==================== Water (core/world/water/waterWgsl.js) ====
${createWaterCommonWgsl(group, B)}
${createWaterLookupWgsl(group, B)}
// Debug views 6 and 7 (applyWater): a channel that is on; tone mapping saturates it.
const WATER_OWNER_ON: f32 = 64.0;

// Debug view 9: why a signed-distance lake draws or not here (the terms of
// waterLakeHitIn, terrain shading only): white the ground is above the
// level, red outside the band (F <= range), blue the lake gives way to a
// lower river, magenta drawn in the band, cyan drawn in the solved water.
fn waterLakeDebugWhy(slot: u32, dir: vec3<f32>, heightM: f32, samp: sampler) -> vec4<f32> {
    if (slot == 0u) { return vec4<f32>(0.0); }
    let lake = waterLakes[slot - 1u];
    if (lake.surfaceDepthRangeM >= 0.0 || lake.maskLayer < 0) { return vec4<f32>(0.0); }
    let k = dot(dir, lake.c);
    if (k <= 0.0) { return vec4<f32>(0.0); }
    let px = dot(dir, lake.e1) / k * waterParams.planetRadius;
    let py = dot(dir, lake.e2) / k * waterParams.planetRadius;
    let uv = vec2<f32>((px - lake.x0) / lake.sizeX, (py - lake.y0) / lake.sizeY);
    if (any(uv < vec2<f32>(0.0)) || any(uv > vec2<f32>(1.0))) { return vec4<f32>(0.0); }
    let F = waterLakeMaskSampleSmooth(lake, uv, samp) * 255.0 - 128.0;
    if (heightM >= lake.level) { return vec4<f32>(1.0, 1.0, 1.0, 1.0); }
    if (F <= lake.surfaceDepthRangeM) { return vec4<f32>(1.0, 0.0, 0.0, 1.0); }
    if (F < 0.0) {
        let river = waterRiverAt(dir, heightM);
        if (river.near && river.distM < river.halfWidthM && river.etaM < lake.level - 0.02) { return vec4<f32>(0.0, 0.0, 1.0, 1.0); }
        return vec4<f32>(1.0, 0.0, 1.0, 1.0);
    }
    return vec4<f32>(0.0, 1.0, 1.0, 1.0);
}

fn waterHash(p: vec2<f32>) -> f32 {
    var p3 = fract(vec3<f32>(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
fn waterNoise(p: vec2<f32>) -> f32 {
    let i = floor(p); let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    return mix(mix(waterHash(i), waterHash(i + vec2<f32>(1.0, 0.0)), u.x),
               mix(waterHash(i + vec2<f32>(0.0, 1.0)), waterHash(i + vec2<f32>(1.0, 1.0)), u.x), u.y);
}
fn waterNoiseGrad(p: vec2<f32>) -> vec2<f32> {
    let e = 0.05;
    return vec2<f32>(waterNoise(p + vec2<f32>(e, 0.0)) - waterNoise(p - vec2<f32>(e, 0.0)),
                     waterNoise(p + vec2<f32>(0.0, e)) - waterNoise(p - vec2<f32>(0.0, e))) / (2.0 * e);
}

// The water's body over a bed, without its surface: the bed seen through
// the water column along the view ray (V: toward the camera), toward the
// deep water's colour.
fn waterBodyColor(
    bedColor: vec3<f32>, depthM: f32, V: vec3<f32>, up: vec3<f32>,
    lightDir: vec3<f32>, sunRadiance: vec3<f32>, skyRadiance: vec3<f32>,
) -> vec3<f32> {
    let cosV = max(dot(V, up), 0.02);
    let transmit = exp(-(depthM / cosV) * waterParams.absorption.rgb);
    let sunUp = max(dot(up, lightDir), 0.0);
    let deep = waterParams.deepColor.rgb * (skyRadiance + sunRadiance * sunUp);
    return mix(deep, bedColor, transmit);
}

// The water's surface over its body: sky reflection (Fresnel), sun glint,
// ripples near the camera. Lakes and rivers alike (owner 2026-10-06: the
// same water everywhere first; the flow's look comes with the simulation).
// rgb is added over the body, a (the Fresnel term) is how much of the body
// it hides: colour = body (1 - a) + rgb. Also drawn by the near water
// meshes (core/renderer/water/nearWaterSurface.wgsl.js).
fn waterSurfaceTerms(
    worldPos: vec3<f32>, up: vec3<f32>, cameraPos: vec3<f32>,
    lightDir: vec3<f32>, sunRadiance: vec3<f32>, skyRadiance: vec3<f32>,
) -> vec4<f32> {
    let toCam = cameraPos - worldPos;
    let dist = length(toCam);
    let V = toCam / dist;
    var N = up;
    let ripple = 1.0 - smoothstep(0.0, waterParams.rippleFade, dist);
    if (ripple > 0.001) {
        let t1 = normalize(cross(up, vec3<f32>(0.0, 1.0, 0.0001)));
        let t2 = cross(up, t1);
        let q = vec2<f32>(dot(worldPos, t1), dot(worldPos, t2)) * 0.35;
        let tm = waterParams.time;
        let g = waterNoiseGrad(q + vec2<f32>(tm * 0.11, -tm * 0.07));
        N = normalize(up + (t1 * g.x + t2 * g.y) * 0.08 * ripple);
    }
    let fres = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
    let R = reflect(-V, N);
    let spec = pow(max(dot(R, lightDir), 0.0), 600.0) * 3.0;
    return vec4<f32>(skyRadiance * waterParams.deepColor.a * fres + sunRadiance * spec, fres);
}

// Water colour over a bed: its body (the bed seen through the water column
// along the view ray) under its surface.
fn waterSurfaceColor(
    bedColor: vec3<f32>, depthM: f32, worldPos: vec3<f32>, up: vec3<f32>, cameraPos: vec3<f32>,
    lightDir: vec3<f32>, sunRadiance: vec3<f32>, skyRadiance: vec3<f32>,
) -> vec3<f32> {
    let body = waterBodyColor(bedColor, depthM, normalize(cameraPos - worldPos), up, lightDir, sunRadiance, skyRadiance);
    let s = waterSurfaceTerms(worldPos, up, cameraPos, lightDir, sunRadiance, skyRadiance);
    let col = body * (1.0 - s.a) + s.rgb;
    // Soft waterline: the first centimetres of depth fade in.
    return mix(bedColor, col, smoothstep(0.0, waterParams.shoreSoftM, depthM));
}

fn waterTint(id: f32) -> vec3<f32> {
    return fract(vec3<f32>(id * 0.618034, id * 0.381966 + 0.3, id * 0.7548777 + 0.6));
}

// How much of the static water the simulation site replaces at dir (0..1).
// How much of the static water the simulation strip replaces at a point
// (0..1), from the river there (waterRiverAt): its river, inside the
// strip's window along it and across it.
fn waterSimCover(river: WaterRiverHit) -> f32 {
    let fade = waterParams.simFade.w;
    if (fade <= 0.0 || !river.near || abs(river.river - waterParams.simRiver.x) > 0.5) { return 0.0; }
    let s0 = waterParams.simRiver.y;
    let s1 = waterParams.simRiver.z;
    let endFade = max(waterParams.simFade.x, 1.0);
    let along = smoothstep(s0, s0 + endFade, river.sM) * (1.0 - smoothstep(s1 - endFade, s1, river.sM));
    let half = waterParams.simRiver.w;
    let across = 1.0 - smoothstep(half - max(waterParams.simFade.y, 0.5), half, river.distM);
    return fade * along * across;
}

// Share of a lake's surface the near mesh draws at a camera distance (m):
// 1 closer than near.x, 0 beyond near.y, 0 with the near mesh off.
fn waterNearWeight(dist: f32) -> f32 {
    if (waterParams.near.z < 0.5) { return 0.0; }
    return 1.0 - smoothstep(waterParams.near.x, max(waterParams.near.y, waterParams.near.x + 1.0), dist);
}

// Water over a bed at a camera distance: far, the whole water; near, only
// its body (the near meshes draw the surface over it), blended by nearW.
fn waterNearFarColor(
    bedColor: vec3<f32>, depthM: f32, worldPos: vec3<f32>, up: vec3<f32>, cameraPos: vec3<f32>, dist: f32, nearW: f32,
    lightDir: vec3<f32>, sunRadiance: vec3<f32>, skyRadiance: vec3<f32>,
) -> vec3<f32> {
    var col = bedColor;
    if (nearW < 1.0) {
        col = waterSurfaceColor(bedColor, depthM, worldPos, up, cameraPos, lightDir, sunRadiance, skyRadiance);
    }
    if (nearW > 0.0) {
        col = mix(col, bedColor, nearW);
    }
    return col;
}

// Debug view 4: who draws the surface, cyan the terrain shading, magenta the near meshes.
fn waterOwnerTint(nearW: f32, depthM: f32) -> vec3<f32> {
    return mix(vec3<f32>(0.1, 0.75, 1.0), vec3<f32>(1.0, 0.2, 0.85), nearW) * mix(1.0, 0.4, clamp(depthM / 20.0, 0.0, 1.0));
}

// Shades a terrain fragment under lake or river water; unchanged elsewhere.
fn applyWater(
    bedColor: vec3<f32>, worldPos: vec3<f32>, cameraPos: vec3<f32>, planetCenter: vec3<f32>,
    lightDir: vec3<f32>, sunRadiance: vec3<f32>, skyRadiance: vec3<f32>, samp: sampler,
) -> vec3<f32> {
    if (waterParams.enabled == 0u || waterParams.debugMode == ${WATER_DEBUG_DRY}u) { return bedColor; }
    let rel = worldPos - planetCenter;
    let r = length(rel);
    let up = rel / r;
    let heightM = r - waterParams.planetRadius;
    let dbg = waterParams.debugMode;

    let dist = length(cameraPos - worldPos);
    // Close water is drawn at its surface, with transmission from scene depth.
    // The bed stays terrain, including when the camera is underwater.
    if (dbg == 0u && waterNearWeight(dist) >= 1.0) { return bedColor; }
    let river = waterRiverAtView(up,heightM,waterParams.riverLook.x>0.5 && dist>max(waterParams.near.y,waterParams.riverLook.z));
    // The near surfaces retain the bed/body underneath. Simulation replaces
    // the ribbon surface, rather than clearing the terrain colour to dry land.

    // Legacy bank tint. Organic banks already use the terrain's lit splat
    // materials; a post-lighting colour override would hide those textures.
    var ground = bedColor;
    if (river.near && waterParams.bank.w <= 0.0) {
        let lum = dot(bedColor, vec3<f32>(0.30, 0.59, 0.11));
        let soil = vec3<f32>(0.42, 0.33, 0.24) * (lum / 0.33);
        let crest = river.halfWidthM + 2.0 * waterParams.bank.y;
        let w = (1.0 - smoothstep(river.halfWidthM, crest, river.distM)) * smoothstep(-1.0, 0.0, river.pool);
        let wet = 1.0 - 0.35 * (1.0 - smoothstep(0.0, 0.6, heightM - river.etaM));
        ground = mix(bedColor, soil * wet, 0.8 * w);
    }

    // Debug view 5: within a river's zone, alternate colours per nearest
    // traced segment (the carve picks the same segment).
    if (dbg == 5u && river.near) {
        let odd = fract(river.seg * 0.5) > 0.25;
        return mix(bedColor, select(vec3<f32>(1.0, 0.25, 0.1), vec3<f32>(0.1, 0.4, 1.0), odd), 0.55);
    }
    if (dbg == 9u) {
        let c9 = waterDirToCell(up, waterParams.gridN);
        var w9 = vec4<f32>(0.0);
        for (var k9 = 0u; k9 < waterLakeCandidateCount(c9); k9++) {
            w9 = waterLakeDebugWhy(waterLakeCandidate(c9, k9), up, heightM, samp);
            if (w9.a >= 0.5) { break; }
        }
        if (w9.a < 0.5) { return bedColor * 0.25; }
        return w9.rgb * 0.85;
    }
    let lakeHit=waterLakeHitView(up,heightM,samp,dist>waterParams.riverLook.w,true);
    let level = lakeHit.level;
    // Debug views 6 and 7 (river redesign R1): who draws the water, in flat
    // colours. The terrain shader returns them before aerial perspective;
    // the near meshes keep drawing in these views (NearWaterRenderer.js)
    // and add theirs (nearWaterSurface.wgsl.js), so overlaps light more
    // than one channel. 6: red this shading draws river water here, green a
    // river ribbon, blue the simulated surface (not wired: riverSim stays
    // off until R7). 7: red within a river's zone, green the ground below
    // that river's water, blue lake water (this shading or a lake sheet).
    if (dbg == 6u) { return vec3<f32>(select(0.0, WATER_OWNER_ON, level <= WATER_NO_LAKE && river.found), 0.0, 0.0); }
    if (dbg == 7u) {
        return vec3<f32>(select(0.0, WATER_OWNER_ON, river.near), select(0.0, WATER_OWNER_ON, river.near && heightM < river.etaM),
            select(0.0, WATER_OWNER_ON, level > WATER_NO_LAKE));
    }
    if (level > WATER_NO_LAKE) {
        let depthM = lakeHit.depthM;
        if (dbg == 1u || dbg == 2u) {
            let slot = waterLakeCandidate(waterDirToCell(up, waterParams.gridN), 0u);
            return mix(waterTint(f32(slot)), vec3<f32>(0.0, 0.1, 0.6), clamp(depthM / 40.0, 0.0, 0.8));
        }
        if (dbg == 3u) { return mix(vec3<f32>(0.6, 1.0, 1.0), vec3<f32>(0.0, 0.0, 0.3), clamp(depthM / 50.0, 0.0, 1.0)); }
        // Near the camera the near mesh draws the surface (reflection, glint,
        // ripples) over this; here only the water's body, the same maths.
        let nearW = waterNearWeight(dist);
        if (dbg == 4u) { return waterOwnerTint(nearW, depthM); }
        // Far away the depth comes from coarse triangles interpolated over
        // hundreds of metres: a see-through body showed their facets and
        // shoals as blurred shores, islands and dirty spots (owner
        // 2026-10-12, depth tint water-look v2). Past the near/far switch the
        // water reads as deeper than those triangles by LAKE_FAR_DEPTH_PER_M
        // per metre, so the bed fades out within a few hundred metres (a 2.5x
        // blend alone left the shores blurred at 2.5 km, v15), and the body
        // turns opaque by 1.5x the switch distance.
        // Both start where the near mesh starts handing over (near.x,
        // 1 km), not at the switch (1.6 km): from 1.2-1.9 km neither the
        // mesh nor this fade covered the coarse depth, and the islands and
        // shores blurred there (owner 2026-10-12, camera ~1.55 km above the
        // lake, v20/v21).
        let switchM=max(waterParams.near.y,waterParams.riverLook.z);
        let farStartM=select(switchM,waterParams.near.x,waterParams.near.z>0.5);
        let farDepthM=depthM+max(dist-farStartM,0.0)*${LAKE_FAR_DEPTH_PER_M};
        var lakeCol = waterNearFarColor(ground, farDepthM, worldPos, up, cameraPos, dist, nearW, lightDir, sunRadiance, skyRadiance);
        let wFar=smoothstep(farStartM,switchM*1.5,dist);
        if(wFar>0.0) {
            let surface=waterSurfaceTerms(worldPos,up,cameraPos,lightDir,sunRadiance,skyRadiance);
            let body=waterParams.deepColor.rgb*(skyRadiance+sunRadiance*max(dot(up,lightDir),0.0));
            let opaque=mix(ground,body*(1.0-surface.a)+surface.rgb,smoothstep(0.0,waterParams.shoreSoftM,depthM));
            lakeCol=mix(lakeCol,opaque,wFar);
        }
        return lakeCol;
    }

    if (river.found) {
        if (dbg == 1u || dbg == 2u) { return mix(vec3<f32>(1.0, 0.15, 0.1), vec3<f32>(0.3, 0.0, 0.5), clamp(river.depthM / 5.0, 0.0, 1.0)); }
        if (dbg == 3u) { return mix(vec3<f32>(0.6, 1.0, 1.0), vec3<f32>(0.0, 0.0, 0.3), clamp(river.depthM / 50.0, 0.0, 1.0)); }
        // The lakes' water over the bank's soil; near the camera the river
        // ribbons draw the surface (NearWaterRenderer.js).
        let nearW = waterNearWeight(dist);
        if (dbg == 4u) { return waterOwnerTint(nearW, river.depthM); }
        var riverCol: vec3<f32>;
        if(river.constructedSurface && waterParams.riverLook.y>0.5) {
            // Coarse triangles can sit on dry land above the carved bed.
            // Transmitting their colour through an assumed shallow depth
            // paints a brown/green "river". Match the near ribbon's body
            // until a real submerged-bed representation is available.
            let surface=waterSurfaceTerms(worldPos,up,cameraPos,lightDir,sunRadiance,skyRadiance);
            let body=waterParams.deepColor.rgb*(skyRadiance+sunRadiance*max(dot(up,lightDir),0.0));
            riverCol=body*(1.0-surface.a)+surface.rgb;
            // Traced reaches start from their near colour model (ground seen
            // through the profile depth) at the near/far switch and reach the
            // opaque body by 2.5x its distance: no colour step there, and
            // water-coloured rivers from the air (owner 2026-10-11).
            if(!river.opaqueBody) {
                let switchM=max(waterParams.near.y,waterParams.riverLook.z);
                let w=smoothstep(switchM,switchM*2.5,dist);
                if(w<1.0) {
                    riverCol=mix(waterNearFarColor(ground,river.depthM,worldPos,up,cameraPos,dist,nearW,lightDir,sunRadiance,skyRadiance),riverCol,w);
                }
            }
        } else {
            riverCol=waterNearFarColor(ground,river.depthM,worldPos,up,cameraPos,dist,nearW,lightDir,sunRadiance,skyRadiance);
        }
        return riverCol;
    }
    if (river.near && dbg == 0u) { return ground; }
    if (dbg == 2u) {
        let cell = waterDirToCell(up, waterParams.gridN);
        let e = waterIndex[cell];
        let n = waterParams.gridN;
        if (waterLakeCandidate(cell, 0u) != 0u) { return mix(bedColor, vec3<f32>(0.1, 0.4, 1.0), 0.35); }
        if ((waterIndex[6u * n * n + cell] & 0x1ffffu) != 0u) { return mix(bedColor, vec3<f32>(1.0, 0.1, 0.05), 0.3); }
        if (((e >> 30u) & 1u) != 0u) { return mix(bedColor, vec3<f32>(1.0, 0.6, 0.0), 0.45); }
    }
    return bedColor;
}
`;
}
