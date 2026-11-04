// core/renderer/water/fieldWaterSurface.wgsl.js
//
// Near water drawn from the baked river field (core/world/water/riverField.js):
// one small grid per field page with water, at the field's level W (rivers
// and the lakes' water inside the pages), cut by the terrain's depth (the
// shoreline is where W meets the ground) and kept only where the field's
// connected water is (no puddles in hollows beside it). Same shading as the
// lake sheets (nearWaterSurface.wgsl.js nearWaterShade), so where a lake's
// water continues past the field's pages nothing changes but who draws it.

import { commonWgsl, shadeWgsl } from './nearWaterSurface.wgsl.js';
import { createRiverFieldWgsl } from '../../world/water/riverField.wgsl.js';
import { RIVER_FIELD } from '../../world/water/riverField.js';

// Vertices per page side: every texelStep texels.
export const FIELD_WATER_STEP = 2;
export const FIELD_WATER_GRID = RIVER_FIELD.page / FIELD_WATER_STEP + 1;
// Water is kept this far (m) beyond the field's connected water (its
// signed distance is texel-accurate; the depth test draws the shoreline).
const KEEP_M = 1.5;
export const FIELD_WATER_GROUP = 3;
export const FIELD_WATER_BINDINGS = Object.freeze({ table: 0, texels: 1, params: 2 });

const FIELD_VOUT = /* wgsl */`
struct FieldWaterVOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) wp: vec3<f32>,
    @location(1) sdf: f32,
};
@group(2) @binding(0) var<storage, read> fieldWaterPages: array<vec4<u32>>;
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
    o.pos = nearWaterRasterPosition(wp);
    o.wp = wp;
    o.sdf = v.z;
    return o;
}
`;
}

export function buildFieldWaterFragmentShader() {
    return commonWgsl() + FIELD_VOUT + shadeWgsl() + /* wgsl */`
@fragment
fn main(in: FieldWaterVOut) -> @location(0) vec4<f32> {
    if (nearWaterBehind(in.wp, in.pos.xy) <= 0.0) { discard; }
    let dir = normalize(in.wp - U.origin);
    // The signed distance comes from the vertices: no field lookup per fragment.
    if (in.sdf < -${KEEP_M.toFixed(2)}) { discard; }
    if (waterParams.debugMode == 6u) { return vec4<f32>(0.0, WATER_OWNER_ON, 0.0, 0.0); }
    if (waterParams.debugMode == 7u) { return vec4<f32>(0.0, 0.0, WATER_OWNER_ON, 0.0); }
    let c = nearWaterShade(in.wp, in.pos.xy, dir);
    if (c.a <= 0.0) { discard; }
    return c;
}
`;
}
