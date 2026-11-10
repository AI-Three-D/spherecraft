// core/renderer/water/fieldWaterSurface.wgsl.js
//
// Near water drawn from the baked river field (core/world/water/riverField.js):
// one small grid per field page with water, at the field's level W (rivers
// and the lakes' water inside the pages), cut by the terrain's depth (the
// shoreline is where W meets the ground) and kept only where the field's
// connected water is (no puddles in hollows beside it). Same shading as the
// lake sheets (nearWaterSurface.wgsl.js nearWaterShade), so where a lake's
// water continues past the field's pages nothing changes but who draws it.
// Where the baked flow moves, and on any water close to the camera, the surface is
// whitewater's middle tier: still geometry, animated (whitewaterLook.wgsl.js). Where
// the near simulation draws (WhitewaterSim.js, whiteCover) this mesh gives way.

import { commonWgsl, shadeWgsl } from './nearWaterSurface.wgsl.js';
import { WHITE_UNIFORMS_WGSL, WHITE_FLAG_LOOK, WHITE_FLAG_NEAR, whitewaterLookWgsl } from './whitewaterLook.wgsl.js';
import { createRiverFieldWgsl } from '../../world/water/riverField.wgsl.js';
import { RIVER_FIELD } from '../../world/water/riverField.js';

// Vertices per page side: every texelStep texels.
export const FIELD_WATER_STEP = 2;
export const FIELD_WATER_GRID = RIVER_FIELD.page / FIELD_WATER_STEP + 1;
// Water is kept this far (m) beyond the field's connected water (its
// signed distance is texel-accurate; the depth test draws the shoreline).
const KEEP_M = 1.5;
// Coarse tiles' triangles across a river (fieldWaterOverTooth): ground at
// most TOOTH_AHEAD_M in front of the water along the ray (also the depth
// test's reserve: hardware rejects only what is further in front), at most
// TOOTH_RISE_M over the water, TOOTH_PAST_ROCKS_M (ramp, m) beyond where the
// rocks in the rivers are drawn (WhitewaterSim rockDrawM, at least
// TOOTH_NEAR_M; across the planet); the surface drawn over it up to
// TOOTH_KEEP_M past the water's edge.
const TOOTH_AHEAD_M = 120;
const TOOTH_RISE_M = 6;
const TOOTH_NEAR_M = 40;
const TOOTH_PAST_ROCKS_M = [10, 60];
const TOOTH_DEPTH_M = 1.5;
const TOOTH_KEEP_M = 12;
export const FIELD_WATER_GROUP = 3;
export const FIELD_WATER_BINDINGS = Object.freeze({ table: 0, texels: 1, params: 2, flow: 3 });

const FIELD_VOUT = /* wgsl */`
struct FieldWaterVOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) wp: vec3<f32>,
    @location(1) sdf: f32,
    @location(2) xy: vec2<f32>,
    @location(3) flow: vec4<f32>,
    @location(4) plane: vec3<f32>,
};
@group(2) @binding(0) var<storage, read> fieldWaterPages: array<vec4<u32>>;
@group(2) @binding(1) var<uniform> W: WhiteU;
${WHITE_UNIFORMS_WGSL}
`;

export function fieldWaterLookupWgsl() {
    return createRiverFieldWgsl({ group: FIELD_WATER_GROUP, b: FIELD_WATER_BINDINGS, page: RIVER_FIELD.page, apron: RIVER_FIELD.apron });
}

export function buildFieldWaterVertexShader() {
    return commonWgsl() + FIELD_VOUT + fieldWaterLookupWgsl() + /* wgsl */`
@vertex
fn main(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> FieldWaterVOut {
    // Page: face, pi, pj, slot.
    let pg = fieldWaterPages[ii];
    let n = ${FIELD_WATER_GRID}u;
    let P = f32(riverFieldP.P);
    let tx = f32(pg.y) * P + f32((vi % n) * ${FIELD_WATER_STEP}u);
    let ty = f32(pg.z) * P + f32((vi / n) * ${FIELD_WATER_STEP}u);
    let v = riverFieldInPage(pg.w, pg.y, pg.z, tx, ty);
    let dir = riverFieldDir(pg.x, tx, ty);
    let wp = U.origin + dir * (U.R + v.y);
    var o: FieldWaterVOut;
    o.pos = nearWaterRasterPositionReserve(wp, ${TOOTH_AHEAD_M.toFixed(1)});
    o.wp = wp;
    o.sdf = v.z;
    o.xy = whiteFrameXY(dir);
    let fl = riverFlowInPage(pg.w, pg.y, pg.z, tx, ty);
    let vel = riverFlowWorld(pg.x, tx, ty, fl.x, fl.y);
    o.flow = vec4<f32>(dot(vel, W.e1), dot(vel, W.e2), fl.z, fl.w);
    // The surface's own plane, tilted by its fall: water falling toward the camera stands
    // above its eye, and by the planet's up alone that is the water's underside: no body,
    // the bed showing through beyond a line at eye height (owner 2026-11-05).
    let run = ${FIELD_WATER_STEP}.0;
    let a = riverFieldInPage(pg.w, pg.y, pg.z, tx + run, ty);
    let b = riverFieldInPage(pg.w, pg.y, pg.z, tx, ty + run);
    let e1 = normalize(riverFieldDir(pg.x, tx + run, ty) - dir);
    let e2 = normalize(riverFieldDir(pg.x, tx, ty + run) - dir);
    let m = run * ${RIVER_FIELD.texelM.toFixed(1)};
    o.plane = normalize(dir - e1 * ((a.y - v.y) / m) - e2 * ((b.y - v.y) / m));
    return o;
}
`;
}

export function buildFieldWaterFragmentShader() {
    return commonWgsl() + FIELD_VOUT + shadeWgsl() + fieldWaterLookupWgsl() + whitewaterLookWgsl() + /* wgsl */`
@group(2) @binding(2) var<storage, read> whiteCover: array<u32>;
// Ground ahead (m along the ray) in front of this water: a coarse tile's triangle standing in
// the river? Its bed's distance behind the surface along the ray if so, else -1. A few hundred
// metres off the tiles' vertices are 12.6 m apart (geometry LOD 2; 50 m at LOD 3), the rivers 6-16 m wide: a
// triangle from a bank vertex over the channel stands above the water where the fine ground is
// under it, and its edges cut the flat water in teeth along the banks (owner 2026-11-09; gone
// with rivers 2.5 times as wide). Such ground is inside the field's water, at its level, a few
// metres up; the near bank, hills and islands are outside it. The water is drawn over it at the
// depth the channel's toe has there. Only past the rocks (fieldWaterCoarse): rocks and the
// player in the water pass the same tests; nearer, rivers are wide enough for the tiles there
// (lakeCellRivers.js halfWidthMinM).
fn fieldWaterOverTooth(wp: vec3<f32>, ahead: f32) -> f32 {
    if (ahead > ${TOOTH_AHEAD_M.toFixed(1)}) { return -1.0; }
    let V = normalize(U.cameraPos - wp);
    let g = wp + V * ahead;
    let ramp = fieldWaterCoarse(g);
    if (ramp <= 0.0) { return -1.0; }
    let up = normalize(g - U.origin);
    let f = riverFieldWater(up);
    let rise = length(g - U.origin) - U.R - f.y;
    let level = length(wp - U.origin) - U.R;
    if (f.x < 0.5 || f.z <= 0.0 || rise > ${TOOTH_RISE_M.toFixed(1)} || abs(f.y - level) > 1.0 + 0.1 * ahead) { return -1.0; }
    return fieldWaterToe(f.z, V, up, ramp);
}
// Whether (0..1) the ground here may be taken for a coarse tile's: past the rocks standing in
// the water (they are scene depth for the water too, and pass every other test; covered,
// they sank under foam), measured as their list is (WhitewaterSim.js, rockDrawM).
fn fieldWaterCoarse(p: vec3<f32>) -> f32 {
    let start = max(W.rockDrawM, ${TOOTH_NEAR_M.toFixed(1)});
    // Without whitewater its frame is zeros (NearWaterRenderer's spare uniforms): no rocks either.
    let d = select(length(U.cameraPos - p), length(whiteFrameXY(normalize(p - U.origin)) - W.cameraXY), W.R > 0.0);
    return smoothstep(start + ${TOOTH_PAST_ROCKS_M[0].toFixed(1)}, start + ${TOOTH_PAST_ROCKS_M[1].toFixed(1)}, d);
}
// The bed's distance behind the surface along the ray V where the tiles cannot draw it: the
// channel's toe at sdf (m) inside the water's edge, at most TOOTH_DEPTH_M deep, by ramp.
fn fieldWaterToe(sdf: f32, V: vec3<f32>, up: vec3<f32>, ramp: f32) -> f32 {
    let depth = min(max(sdf, 0.0) * ${RIVER_FIELD.toeSlopeMax.toFixed(3)}, ${TOOTH_DEPTH_M.toFixed(2)}) * ramp;
    return depth / max(abs(dot(V, up)), 0.05);
}
// Whether the near simulation's mesh draws here. Its vertices sit on cell centres,
// so a block's mesh spans half a cell further than the block.
fn whiteCovered(xy: vec2<f32>) -> bool {
    if ((W.flags & ${WHITE_FLAG_NEAR}u) == 0u) { return false; }
    let size = W.dx * f32(W.blockCells);
    let b = vec2<i32>(floor((xy - 0.5 * W.dx) / size));
    let r = b - W.originBlock;
    let G = i32(W.gridBlocks);
    if (r.x < 0 || r.y < 0 || r.x >= G || r.y >= G) { return false; }
    let rx = ((b.x % G) + G) % G; let ry = ((b.y % G) + G) % G;
    return whiteCover[ry * G + rx] != 0u;
}
@fragment
fn main(in: FieldWaterVOut) -> @location(0) vec4<f32> {
    let front = nearWaterFront(in.wp, in.pos.xy);
    var keep = ${KEEP_M.toFixed(2)};
    if (front <= 0.0) {
        let over = fieldWaterOverTooth(in.wp, -front);
        if (over < 0.0) { discard; }
        nearWaterBedOverride = over;
        // Behind a tooth on the far bank the ray comes down to the water's level past its edge.
        keep = ${TOOTH_KEEP_M.toFixed(1)};
    } else {
        // Where the tiles are coarse the bed under the water is their triangles' too: at least
        // the toe's depth, or the shallow facets beside a covered tooth read as stripes.
        let ramp = fieldWaterCoarse(in.wp);
        if (ramp > 0.0) {
            nearWaterBedOverride = max(front, fieldWaterToe(in.sdf, normalize(U.cameraPos - in.wp), normalize(in.wp - U.origin), ramp));
        }
    }
    if (whiteCovered(in.xy)) { discard; }
    let dir = normalize(in.wp - U.origin);
    // The signed distance comes from the vertices: no field lookup per fragment.
    if (in.sdf < -keep) { discard; }
    if (waterParams.debugMode == 6u) { return vec4<f32>(0.0, WATER_OWNER_ON, 0.0, 0.0); }
    if (waterParams.debugMode == 7u) { return vec4<f32>(0.0, 0.0, WATER_OWNER_ON, 0.0); }
    if (waterParams.debugMode >= 11u && waterParams.debugMode <= 15u) {
        return whiteDebug(waterParams.debugMode, in.flow.xy, in.flow.z, in.flow.z * 0.6, 1.0, vec3<f32>(0.1, 0.9, 0.25));
    }
    var c: vec4<f32>;
    let foam = whiteBakedFoam(in.flow.z, in.xy) * smoothstep(0.0, 2.5, in.sdf);
    if ((W.flags & ${WHITE_FLAG_LOOK}u) != 0u && (foam > 0.003 || dot(in.flow.xy, in.flow.xy) > 0.01 || length(U.cameraPos - in.wp) < waterParams.lakeDetailM)) {
        let turb = clamp(foam * 0.9 + 0.12 * length(in.flow.xy), 0.0, 1.0);
        c = nearWaterCompose(in.wp, dir, whiteSurface(in.wp, dir, in.xy, in.flow.xy, foam, turb, in.pos.xy), in.pos.xy, in.plane);
    } else {
        c = nearWaterShade(in.wp, in.pos.xy, in.plane);
    }
    if (c.a <= 0.0) { discard; }
    return c;
}
`;
}
