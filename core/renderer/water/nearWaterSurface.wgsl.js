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
// core/world/water/riverRibbon.js), read from storage per vertex. A ribbon
// gives way where a lake's mask covers the point (the lake's surface is
// drawn there) and where another river is nearer (confluences: the terrain
// shading's rule, waterRiverAt).
//
// Near water draws its body on the actual surface geometry using the
// existing deep colour, reflection and light. Only the distance handover
// is transparent. Fresnel-only blending over coloured bed polygons made
// submerged bank faces appear as floating sheets and uphill water.

import { createWaterWgsl } from '../../world/water/waterWgsl.js';
import { getAerialPerspectiveWGSL } from '../atmosphere/shaders/aerialPerspectiveCommon.js';

export const NEAR_WATER_MAX_LAKES = 16;
export const NEAR_WATER_UNIFORM_FLOATS = 16 + 16 + 4 + 4 + 4 + NEAR_WATER_MAX_LAKES + 7 * 4;
export const NEAR_WATER_SAMPLER_BINDING = 17;
export const NEAR_WATER_TRANSMITTANCE_BINDING = 18;
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
    @location(1) uv: vec2<f32>,          // in the lake's mask
    @location(2) @interpolate(flat) lake: u32,
};
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
    o.uv = (p - lo) / size;
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

fn nearWaterShade(wp: vec3<f32>, level: f32, flatLake: bool) -> vec4<f32> {
    let dist = length(U.cameraPos - wp);
    let w = waterNearWeight(dist);
    // Seen from below (camera under the level): the underside comes with diving.
    if (w <= 0.0 || (flatLake && length(U.cameraPos - U.origin) < U.R + level)) { return vec4<f32>(0.0); }
    let up = normalize(wp - U.origin);
    let L = normalize(U.sunDir);
    let sun = U.sunColor * U.sunIntensity;
    let sky = U.ambientColor * U.ambientIntensity;
    let s = waterSurfaceTerms(wp, up, U.cameraPos, L, sun, sky);

    return nearWaterCompose(wp, up, s);
}

// Shared premultiplied surface/body and atmosphere treatment. Simulation
// supplies flow normals and foam but keeps the same lighting and handover.
fn nearWaterCompose(wp: vec3<f32>, up: vec3<f32>, s: vec4<f32>) -> vec4<f32> {
    let dist = length(U.cameraPos - wp);
    let w = waterNearWeight(dist);
    let L = normalize(U.sunDir);
    let sun = U.sunColor * U.sunIntensity;
    let sky = U.ambientColor * U.ambientIntensity;

    // The body must live on the surface geometry too. Compositing only
    // Fresnel over water-coloured bed polygons exposes their steep edges as
    // floating sheets and makes the bed's uphill pools look like water slopes.
    // Use the existing deep-water colour until bed refraction is implemented.
    let body = waterParams.deepColor.rgb * (sky + sun * max(dot(up, L), 0.0));
    let a = w;
    let add = (body * (1.0 - s.a) + s.rgb) * a;

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
    let m = waterLakeMaskSample(lake,in.uv,nearWaterSampler);
    if (m < select(0.5,63.5/255.0,lake.surfaceDepthRangeM>0.0)) { discard; }
    if (lake.surfaceDepthRangeM<=0.0 && m < 0.75) {
        let river = waterRiverAt(normalize(in.wp - U.origin), lake.level);
        if (river.near && river.distM < river.halfWidthM && river.etaM < lake.level - 0.02) { discard; }
    }
    let c = nearWaterShade(in.wp, lake.level, true);
    if (c.a <= 0.0) { discard; }
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
    // This mesh is double-sided. Classify its local sloped surface before
    // divergent clipping, instead of comparing two planet-wide elevations.
    let geometricNormal=cross(dpdx(in.wp),dpdy(in.wp));
    let surfaceNormal=geometricNormal*select(-1.0,1.0,dot(geometricNormal,up)>=0.0);
    if(dot(surfaceNormal,U.cameraPos-in.wp)<=0.0) { discard; }
    // A lake's mask covers the point: the lake's surface is drawn there.
    if (waterLakeLevelView(up, -1.0e30, nearWaterSampler, false) > WATER_NO_LAKE) { discard; }
    // Another river is nearer (confluences).
    let hit = waterRiverAt(up, in.level);
    if (!hit.near || hit.distM >= hit.halfWidthM || abs(hit.river - in.river) > 0.5) { discard; }
    // A downstream observer can be below an upstream river's elevation
    // while viewing its top/front surface. Radial lake underside rejection
    // would hide that waterfall; raster face/depth tests handle its geometry.
    let c = nearWaterShade(in.wp, in.level, false) * (1.0 - waterSimCover(hit));
    if (c.a <= 0.0) { discard; }
    return c;
}
`;
}
