// core/renderer/water/nearWaterSurface.wgsl.js
//
// Surface of the lakes and rivers near the camera (NearWaterRenderer.js).
//
// Lakes: one grid, drawn once per lake (instance = lake): it sits around
// the camera in the lake's tangent plane (frame as waterWgsl.js WaterLake),
// finest at the camera (offset sign(g) g^2 extent for g in -1..1), clamped
// to the lake's patch so the rest collapses to nothing, at the lake's level
// on the sphere (same arithmetic as the terrain's vertices: origin + dir
// radius). Fragments where the lake's mask is below 0.5 are discarded (the
// terrain shading's coverage test); the terrain's depth hides the
// surface where the ground rises above the level, so the shoreline is where
// the flat water meets the ground.
//
// Rivers, and lakes inside the river field's pages: fieldWaterSurface.wgsl.js.
//
// Nearby water blends reflection and depth-dependent absorption over the
// terrain bed. Opaque scene depth supplies both shoreline contact and the
// distance travelled through the water.

import { createWaterWgsl, WATER_WET_BED } from '../../world/water/waterWgsl.js';
import { RIVER_SECTION } from '../../world/water/riverSection.js';
import { RIVER_FIELD } from '../../world/water/riverField.js';
import { fieldWaterLookupWgsl } from './fieldWaterSurface.wgsl.js';
import { getAerialPerspectiveWGSL } from '../atmosphere/shaders/aerialPerspectiveCommon.js';

export const NEAR_WATER_MAX_LAKES = 16;
export const NEAR_WATER_UNIFORM_FLOATS = 16 + 16 + 4 + 4 + 4 + NEAR_WATER_MAX_LAKES + 7 * 4;
export const NEAR_WATER_SAMPLER_BINDING = 17;
export const NEAR_WATER_TRANSMITTANCE_BINDING = 18;
export const NEAR_WATER_SCENE_DEPTH_BINDING = 19;
// Height (m) a lake sheet's overlap under a field page's edge covers.
const FIELD_OVERLAP_M = 0.02;

export const NEAR_WATER_U_WGSL = /* wgsl */`
struct NearWaterU {
    viewMatrix: mat4x4<f32>,
    projectionMatrix: mat4x4<f32>,
    origin: vec3<f32>, R: f32,           // planet centre, radius (m)
    cameraPos: vec3<f32>, extentM: f32,  // world; the grid's half-size (m)
    grid: vec4<f32>,                     // vertices per side, atmosphere on, unused, unused
    lakes: array<vec4<f32>, ${NEAR_WATER_MAX_LAKES / 4}>,   // lake table slot per instance
    // Lighting and atmosphere as the terrain shading has them.
    sunDir: vec3<f32>, sunIntensity: f32,
    sunColor: vec3<f32>, ambientIntensity: f32,
    ambientColor: vec3<f32>, atmoPlanetRadius: f32,
    rayleigh: vec3<f32>, mieScattering: f32,
    atmo: vec4<f32>,                     // atmosphere radius, scale heights (Rayleigh, Mie), Mie anisotropy
    fog: vec4<f32>,                      // fog colour, density (aerial perspective off)
    ap: vec4<f32>,                       // atmosphere sun intensity, fade start, fade end (m), unused
};
`;

export const NEAR_WATER_RASTER_WGSL = /* wgsl */`
// Permit hardware rejection of hidden banks while reserving half a metre
// of view depth for the fragment's continuous-surface correction. Only the
// comparison depth moves; all physical positions and shading stay unchanged.
fn nearWaterRasterPosition(wp: vec3<f32>) -> vec4<f32> {
    var pos = U.projectionMatrix * (U.viewMatrix * vec4<f32>(wp, 1.0));
    let reserve = ${RIVER_SECTION.surfaceDepthReserveM.toFixed(2)};
    if (pos.w > 0.0) {
        pos.z = max(0.0, pos.z + U.projectionMatrix[3].z * reserve / max(pos.w - reserve, 0.01));
    }
    return pos;
}
`;

export function commonWgsl({ segments = false } = {}) {
    return createWaterWgsl({ group: 1, segments }) + /* wgsl */`
${NEAR_WATER_U_WGSL}
@group(0) @binding(0) var<uniform> U: NearWaterU;
@group(1) @binding(${NEAR_WATER_SAMPLER_BINDING}) var nearWaterSampler: sampler;

struct NearWaterVOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) wp: vec3<f32>,
    @location(1) @interpolate(flat) lake: u32,
};

${NEAR_WATER_RASTER_WGSL}
`;
}

export function buildNearWaterVertexShader() {
    return commonWgsl() + /* wgsl */`
@vertex
fn main(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> NearWaterVOut {
    let slot = u32(U.lakes[ii / 4u][ii % 4u] + 0.5);
    let lake = waterLakes[slot];
    // The camera in the lake's tangent plane.
    let camDir = normalize(U.cameraPos - U.origin);
    let k = max(dot(camDir, lake.c), 1.0e-6);
    let cam = vec2<f32>(dot(camDir, lake.e1), dot(camDir, lake.e2)) / k * U.R;
    let n = u32(U.grid.x);
    let g = vec2<f32>(f32(vi % n), f32(vi / n)) / f32(n - 1u) * 2.0 - 1.0;
    let lo = vec2<f32>(lake.x0, lake.y0);
    let size = vec2<f32>(lake.sizeX, lake.sizeY);
    let p = clamp(cam + sign(g) * g * g * U.extentM, lo, lo + size);
    let dir = normalize(lake.c + (lake.e1 * p.x + lake.e2 * p.y) / U.R);
    let wp = U.origin + dir * (U.R + lake.level);
    var o: NearWaterVOut;
    o.pos = nearWaterRasterPosition(wp);
    o.wp = wp;
    o.lake = slot;
    return o;
}
`;
}

// Fragment shading shared by lakes and rivers, with distance handover
// and aerial perspective.
// Premultiplied colour, a = 0 where nothing is drawn.
export function shadeWgsl() {
    return getAerialPerspectiveWGSL() + /* wgsl */`
@group(1) @binding(${NEAR_WATER_TRANSMITTANCE_BINDING}) var transmittanceLUT: texture_2d<f32>;
@group(1) @binding(${NEAR_WATER_SCENE_DEPTH_BINDING}) var nearWaterSceneDepth: texture_depth_2d;

// Share of this fragment that is foam (whitewaterLook.wgsl.js).
var<private> nearWaterHardShore: f32 = 0.0;
// Depth (m) at which this fragment's water starts: a lake's shore (waterShoreM), 0 for rivers.
var<private> nearWaterShoreM: f32 = 0.0;
// How full of air this water is, 0..1 (whitewaterLook.wgsl.js): fast water is not clear.
var<private> nearWaterAerated: f32 = 0.0;
// Opaque depth converted to distance behind this point along the view ray.
fn nearWaterBehind(wp:vec3<f32>,pixel:vec2<f32>)->f32 {
    let dimensions=vec2<i32>(textureDimensions(nearWaterSceneDepth));
    let xy=clamp(vec2<i32>(pixel),vec2<i32>(0),dimensions-vec2<i32>(1));
    let depth=textureLoad(nearWaterSceneDepth,xy,0);
    let viewZ=(U.viewMatrix*vec4<f32>(wp,1.0)).z;
    let bedZ=-U.projectionMatrix[3].z/(depth+U.projectionMatrix[2].z);
    return max((viewZ-bedZ)*length(U.cameraPos-wp)/max(-viewZ,.001),0.0);
}
// plane: the surface's normal for telling its top from its underside (the
// planet's up for lakes; a river's is tilted by its fall).
fn nearWaterShade(wp: vec3<f32>, pixel: vec2<f32>, plane: vec3<f32>) -> vec4<f32> {
    let dist = length(U.cameraPos - wp);
    let w = waterNearWeight(dist);
    if (w <= 0.0 || nearWaterBehind(wp,pixel)<=0.0) { return vec4<f32>(0.0); }
    let up = normalize(wp - U.origin);
    let L = normalize(U.sunDir);
    let sun = U.sunColor * U.sunIntensity;
    let sky = U.ambientColor * U.ambientIntensity;
    let s = waterSurfaceTerms(wp, up, U.cameraPos, L, sun, sky);

    return nearWaterCompose(wp, up, s, pixel, plane);
}

// Shared premultiplied surface/body and atmosphere treatment. Simulation
// supplies flow normals and foam but keeps the same lighting and handover.
fn nearWaterCompose(wp: vec3<f32>, up: vec3<f32>, s: vec4<f32>, pixel: vec2<f32>, plane: vec3<f32>) -> vec4<f32> {
    let dist = length(U.cameraPos - wp);
    let w = waterNearWeight(dist);
    let L = normalize(U.sunDir);
    let sun = U.sunColor * U.sunIntensity;
    let sky = U.ambientColor * U.ambientIntensity;

    // Reuse opaque depth in a read-only depth pass. No triangle searches,
    // colour copy or second terrain draw. Convert perspective depth to the
    // distance along this view ray, then attenuate over the submerged part.
    let dimensions = vec2<i32>(textureDimensions(nearWaterSceneDepth));
    let xy = clamp(vec2<i32>(pixel), vec2<i32>(0), dimensions - vec2<i32>(1));
    let depth = textureLoad(nearWaterSceneDepth, xy, 0);
    let viewZ = (U.viewMatrix * vec4<f32>(wp, 1.0)).z;
    let bedZ = -U.projectionMatrix[3].z / (depth + U.projectionMatrix[2].z);
    let rayScale = dist / max(-viewZ, 0.001);
    let behind = max((viewZ - bedZ) * rayScale, 0.0);
    let V = normalize(U.cameraPos - wp);
    // Seen from above the surface's plane: a river falling toward the camera
    // is above its eye height upstream, and by the planet's up alone its
    // water there was shaded as seen from below (no body): a line across the
    // river where it crosses the eye height (owner 2026-10-26, "stairs").
    // A ramp, well past edge-on: a hard test at zero turned whole mesh facets to
    // the underside wherever they leaned away, in straight-edged panels (owner
    // 2026-11-05). Only an eye clearly under the water sees its underside.
    let above = smoothstep(-0.35, -0.1, dot(V, plane));
    let path = behind * above;
    let extinction = dot(waterParams.absorption.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
    // Through clear water each cross-wave of fast shallow flow, a step in depth,
    // drew a straight line against the bed.
    let transmission = exp(-path * extinction) * mix(1.0, ${WATER_WET_BED}, above) * (1.0 - 0.85 * nearWaterAerated);
    // Continuous contact removes opaque depth-fighting speckles at grazing
    // shores. Foreground opaque geometry still completely hides the water.
    // Foam ends where it ends: faded like clear water it smeared over the bank.
    let contactDepth = behind * max(abs(dot(V, up)), 0.05);
    let waterDepth = contactDepth - nearWaterShoreM;
    let contact = mix(smoothstep(0.0, waterParams.shoreSoftM, waterDepth), smoothstep(0.0, 0.05, waterDepth), nearWaterHardShore);
    // The strip the water leaves is wet ground: black over it at this share.
    let wetFilm = select(0.0, waterShoreWet(contactDepth, nearWaterShoreM, dist) * (1.0 - contact) * w, nearWaterShoreM > 0.0);
    let body = waterBodyLight(contactDepth, dist, up, L, sun, sky);
    let aWater = (1.0 - transmission * (1.0 - s.a)) * w * contact;
    let a = aWater + wetFilm * (1.0 - aWater);
    let add = (body * (1.0 - transmission) * (1.0 - s.a) + s.rgb) * w * contact;

    // Aerial perspective (or fog), as the terrain shading applies it after
    // its water: colour T + inscatter. Over the framebuffer (already c T + S)
    // the surface adds add T + S a.
    var T = vec3<f32>(1.0);
    var S = vec3<f32>(0.0);
    if (U.grid.y > 0.5) {
        let b = smoothstep(U.ap.y, U.ap.z, dist);
        if (b > 0.001) {
            var ap = ap_computeSimple(
                transmittanceLUT, nearWaterSampler, wp, U.cameraPos, L, U.origin,
                U.atmoPlanetRadius, U.atmo.x, U.atmo.y, U.atmo.z, U.rayleigh, U.mieScattering, U.atmo.w, U.ap.x,
            );
            ap.inscatter *= mix(0.2, 1.0, smoothstep(0.0, 0.2, dot(up, L)));
            T = mix(vec3<f32>(1.0), ap.transmittance, b);
            S = ap.inscatter * b;
        }
    } else {
        let f = clamp(1.0 - exp(-dist * U.fog.w), 0.0, 1.0);
        T = vec3<f32>(1.0 - f);
        S = U.fog.rgb * f;
    }
    return vec4<f32>(add * T + S * a, a);
}
`;
}

export function buildNearWaterFragmentShader() {
    return commonWgsl() + shadeWgsl() + fieldWaterLookupWgsl() + /* wgsl */`
@fragment
fn main(in: NearWaterVOut) -> @location(0) vec4<f32> {
    if(nearWaterBehind(in.wp,in.pos.xy)<=0.0) {discard;}
    let dir = normalize(in.wp - U.origin);
    // The river field's pages draw their water themselves (fieldWaterSurface.wgsl.js).
    // The sheet runs just under their edge: world positions round to a centimetre
    // or two out here, and between two meshes that opens a gap at grazing angles.
    let grazing = max(abs(dot(normalize(U.cameraPos - in.wp), dir)), 0.02);
    if(riverFieldHas(dir, min(${FIELD_OVERLAP_M.toFixed(3)} / grazing, 1.0) / ${RIVER_FIELD.texelM.toFixed(1)})) {discard;}
    let lake = waterLakes[in.lake];
    // The mask at the fragment's own direction, projected as waterLakeHitIn does.
    let kd = max(dot(dir, lake.c), 1.0e-6);
    let uv = (vec2<f32>(dot(dir, lake.e1), dot(dir, lake.e2)) / kd * waterParams.planetRadius - vec2<f32>(lake.x0, lake.y0))
        / vec2<f32>(lake.sizeX, lake.sizeY);
    let m = select(waterLakeMaskSample(lake,uv,nearWaterSampler),waterLakeMaskSampleSmooth(lake,uv,nearWaterSampler),lake.surfaceDepthRangeM<0.0);
    if (lake.surfaceDepthRangeM < 0.0) {
        // Signed-distance mask (lakeMaskSdf.js): the sheet ends half a solve
        // cell beyond the solved water, where the ground is at or above the
        // level, instead of over lower ground past a sill (floating edges).
        if (m * 255.0 - 128.0 <= lake.surfaceDepthRangeM) { discard; }
    } else if (m < select(0.5,63.5/255.0,lake.surfaceDepthRangeM>0.0)) { discard; }
    nearWaterShoreM = waterShoreM(dir, waterFootM(length(U.cameraPos - in.wp), in.wp, U.cameraPos, dir));
    let c = nearWaterShade(in.wp, in.pos.xy, dir);
    if (c.a <= 0.0) { discard; }
    // Water debug views 6 and 7 (waterWgsl.js applyWater): alpha 0 adds
    // the flat colour to what is below (premultiplied blending).
    if (waterParams.debugMode == 6u) { discard; }
    if (waterParams.debugMode == 7u) { return vec4<f32>(0.0, 0.0, WATER_OWNER_ON, 0.0); }
    return c;
}
`;
}
