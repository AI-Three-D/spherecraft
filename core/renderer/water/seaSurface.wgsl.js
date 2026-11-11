// core/renderer/water/seaSurface.wgsl.js
//
// The sea's surface (NearWaterRenderer.js), drawn as the lakes are: everything
// under sea level is ocean (WaterGpuData.sea). One triangle over the screen; each
// pixel's ray meets the sea's sphere (planet radius + level), so the surface is
// exact at any distance, to the horizon, with no mesh or LOD seams. There it has
// the lakes' surface (the close one within lakeDetailM, the distant statistics
// beyond) and their body, lit and hazed as they are (nearWaterComposeAs).
//
// Who draws which pixel, as for a lake:
// - closer than the near meshes' handover (WaterGpuData.near) this pass, with
//   the depth of water from the opaque depth behind the surface, as the lake
//   sheets have it, and the shore where the surface meets the ground;
// - farther, the terrain shading (waterWgsl.js applyWater), which places the
//   shore from the ground's own height: the depth buffer is metres coarse there;
// - at any distance this pass also draws water that is clearly deep (the ground
//   more than a few depth steps behind the surface) and water with no ground
//   behind it at all: a ray into the sea at a low angle can leave it again
//   without meeting a 2 km deep bed, toward the sky.
// The terrain shading takes wind, sky and sun at this same surface point.

import { commonWgsl, shadeWgsl, LAKE_WHITE_WGSL } from './nearWaterSurface.wgsl.js';
import { FIELD_WATER_KEEP_M, fieldWaterLookupWgsl } from './fieldWaterSurface.wgsl.js';
import { WHITE_FLAG_LOOK, whitewaterLookWgsl } from './whitewaterLook.wgsl.js';

// The depth buffer's step (depth24plus): a fragment is deep sea where the ground
// is more than SEA_DEEP_BASE_M + SEA_DEEP_STEPS of those steps behind it along the
// ray, fully from twice that.
export const SEA_DEPTH_QUANTUM = 1 / 16777216;
export const SEA_DEEP_BASE_M = 2;
export const SEA_DEEP_STEPS = 4;

const SEA_VOUT = /* wgsl */`
struct SeaVOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) ray: vec3<f32>,     // world direction through the pixel, not normalized
};
`;

export function buildSeaVertexShader() {
    return commonWgsl() + SEA_VOUT + /* wgsl */`
@vertex
fn main(@builtin(vertex_index) vi: u32) -> SeaVOut {
    // One triangle covering the screen.
    let ndc = vec2<f32>(f32((vi << 1u) & 2u), f32(vi & 2u)) * 2.0 - 1.0;
    // The view ray through it (on the plane z = -1 in view space), then turned
    // to world space by the view's rotation alone: no large translation in it.
    let P = U.projectionMatrix;
    let viewRay = vec3<f32>((ndc.x + P[2][0]) / P[0][0], (ndc.y + P[2][1]) / P[1][1], -1.0);
    let Vm = U.viewMatrix;
    let rot = mat3x3<f32>(Vm[0].xyz, Vm[1].xyz, Vm[2].xyz);
    var o: SeaVOut;
    o.pos = vec4<f32>(ndc, 0.0, 1.0);
    o.ray = transpose(rot) * viewRay;
    return o;
}
`;
}

export function buildSeaFragmentShader() {
    return commonWgsl() + LAKE_WHITE_WGSL + SEA_VOUT + shadeWgsl() + fieldWaterLookupWgsl() + whitewaterLookWgsl() + /* wgsl */`
// Distance along the unit ray d from the camera to the sea's sphere, or -1.
// The camera's height over it is taken first (cm-exact at any planet size);
// the near root as c / (-b + sqrt), which does not cancel.
fn seaRayHit(d: vec3<f32>) -> f32 {
    let o = U.cameraPos - U.origin;
    let rs = U.R + waterParams.sea.x;
    let r0 = length(o);
    let h = r0 - rs;
    let b = dot(o, d);
    let c = h * (r0 + rs);
    let disc = b * b - c;
    if (disc < 0.0) { return -1.0; }
    let sq = sqrt(disc);
    if (h >= 0.0) {
        if (b >= 0.0) { return -1.0; }
        return c / (-b + sq);
    }
    // Under the surface (diving): the way out, overhead.
    if (b <= 0.0) { return -b + sq; }
    return c / (-b - sq);
}

// The opaque scene's depth at a pixel (1: nothing drawn there).
fn seaSceneDepth(pixel: vec2<f32>) -> f32 {
    let dims = vec2<i32>(textureDimensions(nearWaterSceneDepth));
    return textureLoad(nearWaterSceneDepth, clamp(vec2<i32>(pixel), vec2<i32>(0), dims - vec2<i32>(1)), 0);
}

@fragment
fn main(in: SeaVOut) -> @location(0) vec4<f32> {
    if (waterParams.sea.y < 0.5) { discard; }
    let d = normalize(in.ray);
    var t = seaRayHit(d);
    if (!(t > 0.0)) {
        // Over the sea's horizon but under the sky pass's (its ground is the
        // planet's radius; this sea is lower) neither draws: a black band along
        // the horizon (50 m under it, ~5 px from 120 m up). Where no ground was
        // drawn there either, the sea as at its horizon.
        let o = U.cameraPos - U.origin;
        let b = dot(o, d);
        let groundR = select(U.R, U.atmoPlanetRadius, U.atmoPlanetRadius > 0.0);
        if (b < 0.0 && length(o - d * b) < groundR && seaSceneDepth(in.pos.xy) >= 1.0) { t = -b; }
    }
    if (!(t > 0.0)) { discard; }
    let wp = U.cameraPos + d * t;
    // The opaque scene along this ray: in front of the surface hides it.
    let behind = nearWaterFront(wp, in.pos.xy);
    if (behind <= 0.0) { discard; }
    // This pass's share: all of it close by (the near meshes' share); farther,
    // only where the ground is clearly behind the surface, past the depth
    // buffer's steps there (they grow with the square of the distance).
    let viewZ = max(-(U.viewMatrix * vec4<f32>(wp, 1.0)).z, 0.001);
    let stepM = viewZ * t * ${SEA_DEPTH_QUANTUM.toExponential(6)} / max(abs(U.projectionMatrix[3].z), 1.0e-9);
    let deepM = ${SEA_DEEP_BASE_M.toFixed(1)} + ${SEA_DEEP_STEPS.toFixed(1)} * stepM;
    let own = max(waterNearWeight(t), smoothstep(deepM, 2.0 * deepM, behind));
    if (own <= 0.0) { discard; }
    let dir = normalize(wp - U.origin);
    // Rivers' water near their mouths is the river field's (fieldWaterSurface.wgsl.js).
    let field = riverFieldWater(dir);
    if (field.x > 0.5 && field.z > -${FIELD_WATER_KEEP_M.toFixed(2)}) { discard; }

    // Close water has the surface of the lakes' (and rivers') close tier; past
    // lakeDetailM the distant one (as the lake sheets choose).
    var s: vec4<f32>;
    if ((W.flags & ${WHITE_FLAG_LOOK}u) != 0u && t < waterParams.lakeDetailM) {
        s = whiteSurface(wp, dir, whiteFrameXY(dir), vec2<f32>(0.0), 0.0, 0.0, in.pos.xy);
    } else {
        s = waterSurfaceTerms(wp, dir, U.cameraPos, normalize(U.sunDir), U.sunColor * U.sunIntensity, U.ambientColor * U.ambientIntensity);
    }
    // The far body is opaque, as the terrain shading's far water is (applyWater).
    let switchM = max(waterParams.near.y, waterParams.riverLook.z);
    let farStartM = select(switchM, waterParams.near.x, waterParams.near.z > 0.5);
    let opaque = smoothstep(farStartM, mix(farStartM, switchM * 1.5, 0.15), t);
    let c = nearWaterComposeAs(wp, dir, s, in.pos.xy, dir, own, opaque);
    if (c.a <= 0.0) { discard; }
    // Water debug views 6 and 7 (waterWgsl.js applyWater): alpha 0 adds the flat colour.
    if (waterParams.debugMode == 6u) { discard; }
    if (waterParams.debugMode == 7u) { return vec4<f32>(0.0, 0.0, WATER_OWNER_ON, 0.0); }
    return c;
}
`;
}
