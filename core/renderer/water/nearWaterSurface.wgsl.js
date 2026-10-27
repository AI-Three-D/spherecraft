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
// Rivers: ribbons flat across at the river's water level (built on the CPU,
// core/world/water/riverRibbon.js), read from storage per vertex, out to
// just inside the banks' containment crest. A ribbon gives way where a
// lake's mask covers the point (the lake's surface is drawn there) and
// where another river is nearer (confluences: the terrain shading's rule,
// waterRiverAt).
//
// Nearby water blends reflection and depth-dependent absorption over the
// terrain bed. Opaque scene depth supplies both shoreline contact and the
// distance travelled through the water.

import { createWaterWgsl } from '../../world/water/waterWgsl.js';
import { RIVER_SECTION } from '../../world/water/riverSection.js';
import { getAerialPerspectiveWGSL } from '../atmosphere/shaders/aerialPerspectiveCommon.js';

// A river's surface ends this far (m) beyond its channel's edge, half a
// metre inside the banks' containment crest.
const SURFACE_EDGE_M = RIVER_SECTION.contain.crestM - 0.5;

export const NEAR_WATER_MAX_LAKES = 16;
export const NEAR_WATER_UNIFORM_FLOATS = 16 + 16 + 4 + 4 + 4 + NEAR_WATER_MAX_LAKES + 7 * 4;
export const NEAR_WATER_SAMPLER_BINDING = 17;
export const NEAR_WATER_TRANSMITTANCE_BINDING = 18;
export const NEAR_WATER_SCENE_DEPTH_BINDING = 19;
// Ribbon storage (group 2): points (2 x vec4 each, riverRibbon.js), quads.
export const NEAR_RIVER_POINTS_BINDING = 0;
export const NEAR_RIVER_QUADS_BINDING = 1;

export function commonWgsl() {
    return createWaterWgsl({ group: 1 }) + /* wgsl */`
struct NearWaterU {
    viewMatrix: mat4x4<f32>,
    projectionMatrix: mat4x4<f32>,
    origin: vec3<f32>, R: f32,           // planet centre, radius (m)
    cameraPos: vec3<f32>, extentM: f32,  // world; the grid's half-size (m)
    grid: vec4<f32>,                     // vertices per side, aerial perspective on (1) or fog (0), unused
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
@group(0) @binding(0) var<uniform> U: NearWaterU;
@group(1) @binding(${NEAR_WATER_SAMPLER_BINDING}) var nearWaterSampler: sampler;

struct NearWaterVOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) wp: vec3<f32>,
    @location(1) @interpolate(flat) lake: u32,
};

// Where a lake's mask covers a river: the river's surface's share by how
// far (m) its level is above the lake's, the lake sheet's the rest. Switched
// at one level instead, any mismatch between the two surfaces' tests drew
// a line: a gap (brown) or both surfaces (bright), metres wide where the
// river is nearly level with the lake (owner 2026-10-26).
fn nearRiverOverLake(above: f32) -> f32 { return smoothstep(0.0, 0.1, above); }
// The river's share where a lake's mask covers it, cover 0..1 over the
// mask's last metres (WaterLakeHit.cover): switched at the edge, the two
// surfaces tested it at points a little apart (the river's higher, nearer
// along the view) and left a thin gap that aliased into a dotted line
// across the river (owner 2026-10-26).
fn nearRiverShare(above: f32, cover: f32) -> f32 { return mix(1.0, nearRiverOverLake(above), cover); }
// How far (m) a river's near surface runs past its channel's edge: to just
// inside the banks' containment crest, narrowing over a metre of level as
// the river reaches a lake beside it: its banks are not raised there, and
// beyond the channel it lay as a film over grass a few centimetres under it
// (owner 2026-10-25); switched at 0.5 m, its outline stepped across the
// river (owner 2026-10-26).
fn nearRiverEdge(hit: WaterRiverHit) -> f32 {
    return ${SURFACE_EDGE_M.toFixed(2)} * mix(1.0, smoothstep(0.5, 1.5, hit.etaM - hit.lakeGuard), hit.lakeGuardW);
}
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
    o.pos = U.projectionMatrix * (U.viewMatrix * vec4<f32>(wp, 1.0));
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

// plane: the surface's normal for telling its top from its underside (the
// planet's up for lakes; a river's is tilted by its fall).
fn nearWaterShade(wp: vec3<f32>, pixel: vec2<f32>, plane: vec3<f32>) -> vec4<f32> {
    let dist = length(U.cameraPos - wp);
    let w = waterNearWeight(dist);
    if (w <= 0.0) { return vec4<f32>(0.0); }
    let up = normalize(wp - U.origin);
    let L = normalize(U.sunDir);
    let sun = U.sunColor * U.sunIntensity;
    let sky = U.ambientColor * U.ambientIntensity;
    let facing = up * select(-1.0, 1.0, dot(U.cameraPos - wp, plane) >= 0.0);
    let s = waterSurfaceTerms(wp, facing, U.cameraPos, L, sun, sky);

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
    let above = dot(V, plane) >= 0.0;
    let path = select(0.0, behind, above);
    let extinction = dot(waterParams.absorption.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
    let transmission = exp(-path * extinction);
    // Continuous contact removes opaque depth-fighting speckles at grazing
    // shores. Foreground opaque geometry still completely hides the water.
    let contact = smoothstep(0.0, waterParams.shoreSoftM, behind * max(abs(dot(V, up)), 0.05));
    let body = waterParams.deepColor.rgb * (sky + sun * max(dot(up, L), 0.0));
    let a = (1.0 - transmission * (1.0 - s.a)) * w * contact;
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
    return commonWgsl() + shadeWgsl() + /* wgsl */`
@fragment
fn main(in: NearWaterVOut) -> @location(0) vec4<f32> {
    let lake = waterLakes[in.lake];
    var sheetW = 1.0;
    // The mask at the fragment's own direction, projected as waterLakeHitIn
    // (the river surfaces' test) does.
    let dir = normalize(in.wp - U.origin);
    let kd = max(dot(dir, lake.c), 1.0e-6);
    let uv = (vec2<f32>(dot(dir, lake.e1), dot(dir, lake.e2)) / kd * waterParams.planetRadius - vec2<f32>(lake.x0, lake.y0))
        / vec2<f32>(lake.sizeX, lake.sizeY);
    let m = select(waterLakeMaskSample(lake,uv,nearWaterSampler),waterLakeMaskSampleSmooth(lake,uv,nearWaterSampler),lake.surfaceDepthRangeM<0.0);
    if (lake.surfaceDepthRangeM < 0.0) {
        // Signed-distance mask (lakeMaskSdf.js): the sheet ends half a solve
        // cell beyond the solved water, where the ground is at or above the
        // level, instead of over lower ground past a sill (floating edges).
        let F = m * 255.0 - 128.0;
        if (F <= lake.surfaceDepthRangeM) { discard; }
        let river = waterRiverAt(normalize(in.wp - U.origin), lake.level);
        // The lake gives way to a lower river in the band (waterLakeBelowRiver),
        // and within a river's surface the two cross-fade (nearRiverShare),
        // by the same cover as the river surfaces' lookup (WaterLakeHit).
        let below = select(0.0, waterLakeGiveWay(lake, river, F), F < 0.0);
        if (river.near && river.distM < river.halfWidthM + nearRiverEdge(river)) {
            sheetW = 1.0 - nearRiverShare(river.etaM - lake.level, waterLakeEdgeCover(lake, F) * (1.0 - below));
        } else {
            sheetW = 1.0 - below;
        }
    } else {
        if (m < select(0.5,63.5/255.0,lake.surfaceDepthRangeM>0.0)) { discard; }
        if (lake.surfaceDepthRangeM<=0.0 && m < 0.75) {
            let river = waterRiverAt(normalize(in.wp - U.origin), lake.level);
            if (river.near && river.distM < river.halfWidthM && river.etaM < lake.level - 0.02) { discard; }
        }
    }
    if (sheetW <= 0.0) { discard; }
    let c = nearWaterShade(in.wp, in.pos.xy, normalize(in.wp - U.origin)) * sheetW;
    if (c.a <= 0.0) { discard; }
    // Water debug views 6 and 7 (waterWgsl.js applyWater): alpha 0 adds
    // the flat colour to what is below (premultiplied blending).
    if (waterParams.debugMode == 6u) { discard; }
    if (waterParams.debugMode == 7u) { return vec4<f32>(0.0, 0.0, WATER_OWNER_ON, 0.0); }
    return c;
}
`;
}


const RIVER_VOUT = /* wgsl */`
struct NearRiverVOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) wp: vec3<f32>,
    @location(1) level: f32,
    @location(2) @interpolate(flat) river: f32,
};
@group(2) @binding(${NEAR_RIVER_POINTS_BINDING}) var<storage, read> ribbonPoints: array<vec4<f32>>;
@group(2) @binding(${NEAR_RIVER_QUADS_BINDING}) var<storage, read> ribbonQuads: array<u32>;
`;

export function buildNearRiverVertexShader() {
    return commonWgsl() + RIVER_VOUT + /* wgsl */`
@vertex
fn main(@builtin(vertex_index) vi: u32) -> NearRiverVOut {
    // Quad from point k to k + 1: (k, left) (k + 1, left) (k, right), (k, right) (k + 1, left) (k + 1, right).
    let c = vi % 6u;
    let p = ribbonQuads[vi / 6u] + select(0u, 1u, c == 1u || c == 4u || c == 5u);
    let a = ribbonPoints[2u * p];
    let b = ribbonPoints[2u * p + 1u];
    let wp = select(a.xyz, b.xyz, c == 2u || c == 3u || c == 5u);
    var o: NearRiverVOut;
    o.pos = U.projectionMatrix * (U.viewMatrix * vec4<f32>(wp, 1.0));
    o.wp = wp;
    o.level = b.w;
    o.river = a.w;
    return o;
}
`;
}

export function buildNearRiverFragmentShader() {
    return commonWgsl() + RIVER_VOUT + shadeWgsl() + /* wgsl */`
@fragment
fn main(in: NearRiverVOut) -> @location(0) vec4<f32> {
    let up = normalize(in.wp - U.origin);
    // The surface's own plane (a river falling toward the camera is tilted
    // by its fall), taken before any discard.
    let gn = cross(dpdx(in.wp), dpdy(in.wp));
    let hit = waterRiverAt(up, in.level);
    // A lake's mask covers the point: the river's surface fades out as it
    // comes down to the lake's and toward the mask's edge (nearRiverShare),
    // tested where its sheet is on this pixel (waterLakeHitOnRay).
    let lh = waterLakeHitOnRay(U.origin, U.cameraPos, in.wp, nearWaterSampler);
    let riverW = select(1.0, nearRiverShare(hit.etaM - lh.level, lh.cover), lh.level > WATER_NO_LAKE);
    if (riverW <= 0.0) { discard; }
    // Another river is nearer (confluences). The surface ends inside the
    // banks' containment crest (riverSection.js contain): the ground there
    // is above the water, so the depth test draws the shoreline where the
    // water meets the actual ground. (Clipping it at the designed channel
    // drew a canal edge with a step at every ribbon row.) Beside a lake at
    // the river's level the carve raises no bank on ground below the lake's
    // level, so there it ends at the channel's edge (nearRiverEdge).
    let edge = nearRiverEdge(hit);
    if (!hit.near || hit.distM >= hit.halfWidthM + edge || abs(hit.river - in.river) > 0.5) { discard; }
    // A downstream observer can be below an upstream river's elevation
    // while viewing its top/front surface. Radial lake underside rejection
    // would hide that waterfall; raster face/depth tests handle its geometry.
    let plane = select(up, normalize(gn) * sign(dot(gn, up)), dot(gn, gn) > 1.0e-12);
    var c = nearWaterShade(in.wp, in.pos.xy, plane) * (1.0 - waterSimCover(hit));
    if (riverW < 1.0) {
        // Cross-fading with the lake sheet drawn before (its share 1 - riverW):
        // the two semi-transparent layers over each other covered less than
        // either, a band of bed across the mouth (owner 2026-10-26). Drawn so
        // the result is their linear mix over what lies below: the sheet's
        // shading here, then this layer's colour and coverage solved for it.
        let lk = nearWaterShade(in.wp, in.pos.xy, up);
        let al = lk.a * (1.0 - riverW);
        let mixA = al + c.a * riverW;
        let a = 1.0 - (1.0 - mixA) / max(1.0 - al, 1.0e-4);
        c = vec4<f32>(c.rgb * riverW + lk.rgb * (1.0 - riverW) * a, a);
    }
    if (c.a <= 0.0) { discard; }
    // Water debug views 6 and 7, as the lake sheets.
    if (waterParams.debugMode == 6u) { return vec4<f32>(0.0, WATER_OWNER_ON, 0.0, 0.0); }
    if (waterParams.debugMode == 7u) { discard; }
    return c;
}
`;
}
