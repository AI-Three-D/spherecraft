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
import { junctionFieldLookupWgsl } from '../../world/water/junctionField.wgsl.js';
import { RIBBON_POINT_FLOATS } from '../../world/water/riverRibbon.js';
import { getAerialPerspectiveWGSL } from '../atmosphere/shaders/aerialPerspectiveCommon.js';

// A river's surface ends this far (m) beyond its channel's edge, half a
// metre inside the banks' containment crest.
const SURFACE_EDGE_M = RIVER_SECTION.contain.crestM - 0.5;

export const NEAR_WATER_MAX_LAKES = 16;
export const NEAR_WATER_UNIFORM_FLOATS = 16 + 16 + 4 + 4 + 4 + NEAR_WATER_MAX_LAKES + 7 * 4 + NEAR_WATER_MAX_LAKES;
export const NEAR_WATER_SAMPLER_BINDING = 17;
export const NEAR_WATER_TRANSMITTANCE_BINDING = 18;
export const NEAR_WATER_SCENE_DEPTH_BINDING = 19;
// Ribbon storage (group 2): point rows (riverRibbon.js), quads.
export const NEAR_RIVER_POINTS_BINDING = 0;
export const NEAR_RIVER_QUADS_BINDING = 1;

export function commonWgsl() {
    return createWaterWgsl({ group: 1 }) + /* wgsl */`
struct NearWaterU {
    viewMatrix: mat4x4<f32>,
    projectionMatrix: mat4x4<f32>,
    origin: vec3<f32>, R: f32,           // planet centre, radius (m)
    cameraPos: vec3<f32>, extentM: f32,  // world; the grid's half-size (m)
    grid: vec4<f32>,                     // vertices per side, atmosphere on, single-basin field mask, unused
    lakes: array<vec4<f32>, ${NEAR_WATER_MAX_LAKES / 4}>,   // lake table slot per instance
    // Lighting and atmosphere as the terrain shading has them.
    sunDir: vec3<f32>, sunIntensity: f32,
    sunColor: vec3<f32>, ambientIntensity: f32,
    ambientColor: vec3<f32>, atmoPlanetRadius: f32,
    rayleigh: vec3<f32>, mieScattering: f32,
    atmo: vec4<f32>,                     // atmosphere radius, scale heights (Rayleigh, Mie), Mie anisotropy
    fog: vec4<f32>,                      // fog colour, density (aerial perspective off)
    ap: vec4<f32>,                       // atmosphere sun intensity, fade start, fade end (m), unused
    junctionMasks: array<vec4<f32>, ${NEAR_WATER_MAX_LAKES / 4}>,
};
@group(0) @binding(0) var<uniform> U: NearWaterU;
@group(1) @binding(${NEAR_WATER_SAMPLER_BINDING}) var nearWaterSampler: sampler;

struct NearWaterVOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) wp: vec3<f32>,
    @location(1) @interpolate(flat) lake: u32,
    @location(2) @interpolate(flat) junctionMask: u32,
};

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

// Where a lake's mask covers a river: the river's surface's share by how
// far (m) its level is above the lake's, the lake sheet's the rest. Switched
// at one level instead, any mismatch between the two surfaces' tests drew
// a line: a gap (brown) or both surfaces (bright), metres wide where the
// river is nearly level with the lake (owner 2026-10-26).
// A few centimetres of height mismatch should still use the lake sheet.
// Otherwise rounded mouths expose the ribbon's edge in shallow water.
fn nearRiverOverLake(above: f32) -> f32 { return smoothstep(${RIVER_SECTION.mouth.sheetTransitionM[0].toFixed(2)}, ${RIVER_SECTION.mouth.sheetTransitionM[1].toFixed(2)}, above); }
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
fn nearRiverEdge(hit: WaterRiverSurface) -> f32 {
    return ${SURFACE_EDGE_M.toFixed(2)} * mix(1.0, smoothstep(0.5, 1.5, hit.etaM - hit.lakeGuard), hit.lakeGuardW);
}
// The river's shallow side hands over before the ribbon ends. Both sheets
// use the same share, so a raised film cannot end in a straight cyan edge.
fn nearRiverLakeShare(hit: WaterRiverSurface, level: f32, cover: f32) -> f32 {
    let lateral = 1.0 - smoothstep(max(0.0, hit.halfWidthM - ${RIVER_SECTION.mouth.sheetEdgeBlendM.toFixed(2)}), hit.halfWidthM + nearRiverEdge(hit), hit.distM);
    return nearRiverShare(hit.etaM - level, cover) * mix(1.0, lateral, cover);
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
    o.pos = nearWaterRasterPosition(wp);
    o.wp = wp;
    o.lake = slot;
    o.junctionMask = u32(U.junctionMasks[ii/4u][ii%4u]);
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

// Opaque depth converted to distance behind this point along the view ray.
fn nearWaterBehind(wp:vec3<f32>,pixel:vec2<f32>)->f32 {
    let dimensions=vec2<i32>(textureDimensions(nearWaterSceneDepth));
    let xy=clamp(vec2<i32>(pixel),vec2<i32>(0),dimensions-vec2<i32>(1));
    let depth=textureLoad(nearWaterSceneDepth,xy,0);
    let viewZ=(U.viewMatrix*vec4<f32>(wp,1.0)).z;
    let bedZ=-U.projectionMatrix[3].z/(depth+U.projectionMatrix[2].z);
    return max((viewZ-bedZ)*length(U.cameraPos-wp)/max(-viewZ,.001),0.0);
}
// An opaque point above the entire river cannot expose any of its surface.
// The source ceiling is conservative even while refining a steep ribbon ray.
fn nearOpaqueAboveRiver(wp:vec3<f32>,pixel:vec2<f32>,maxLevel:f32)->bool {
    let dimensions=vec2<i32>(textureDimensions(nearWaterSceneDepth));
    let xy=clamp(vec2<i32>(pixel),vec2<i32>(0),dimensions-vec2<i32>(1));
    let depth=textureLoad(nearWaterSceneDepth,xy,0);
    if(depth>=1.0) {return false;}
    let viewZ=(U.viewMatrix*vec4<f32>(wp,1.0)).z;
    let bedZ=-U.projectionMatrix[3].z/(depth+U.projectionMatrix[2].z);
    let bed=U.cameraPos+(wp-U.cameraPos)*(-bedZ/max(-viewZ,.001));
    return length(bed-U.origin)>U.R+maxLevel+.1;
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

export function buildNearWaterFragmentShader({junctionFields=false}={}) {
    return commonWgsl() + shadeWgsl() + (junctionFields?junctionFieldLookupWgsl(3):'') + /* wgsl */`
@fragment
fn main(in: NearWaterVOut) -> @location(0) vec4<f32> {
    if(nearWaterBehind(in.wp,in.pos.xy)<=0.0) {discard;}
    ${junctionFields?`
    let junction=junctionLocateMasked(normalize(in.wp-U.origin),in.junctionMask);
    if(junction.found) {
        let value=junctionValue(junction);
        if(value.z>.999&&junctionSet.records[junction.slot].range.z==in.lake+1u&&value.w>0.0&&abs(value.x-waterLakes[in.lake].level)<.05) {
            let color=nearWaterShade(in.wp,in.pos.xy,normalize(in.wp-U.origin));
            if(color.a<=0.0||waterParams.debugMode==6u){discard;}
            if(waterParams.debugMode==7u){return vec4<f32>(0.0,0.0,WATER_OWNER_ON,0.0);}
            return color;
        }
    }
    `:''}
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
        // Past the shoreline transition the flat lake owns the surface.
        // Avoid a river search for every pixel of its interior.
        if(F<${RIVER_SECTION.mouth.sheetCoreM.toFixed(2)}) {
            let river = waterRiverSurfaceAt(normalize(in.wp - U.origin));
            // The lake gives way to a lower river in the band (waterLakeBelowRiver),
            // and within a river's surface the two cross-fade (nearRiverShare),
            // by the same cover as the river surfaces' lookup (WaterLakeHit).
            let below = select(0.0, waterLakeGiveWay(lake, river, F), F < 0.0);
            if (river.near && river.distM < river.halfWidthM + nearRiverEdge(river)) {
                sheetW = 1.0 - nearRiverLakeShare(river, lake.level, waterLakeEdgeCover(lake, F) * (1.0 - below));
            } else {
                sheetW = 1.0 - below;
            }
        }
    } else {
        if (m < select(0.5,63.5/255.0,lake.surfaceDepthRangeM>0.0)) { discard; }
        if (lake.surfaceDepthRangeM<=0.0 && m < 0.75) {
            let river = waterRiverSurfaceAt(normalize(in.wp - U.origin));
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
    @location(3) @interpolate(flat) maxLevel: f32,
    @location(4) @interpolate(flat) junctionMask: u32,
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
    let a = ribbonPoints[${RIBBON_POINT_FLOATS/4}u * p];
    let b = ribbonPoints[${RIBBON_POINT_FLOATS/4}u * p + 1u];
    let wp = select(a.xyz, b.xyz, c == 2u || c == 3u || c == 5u);
    var o: NearRiverVOut;
    o.pos = nearWaterRasterPosition(wp);
    o.wp = wp;
    o.level = b.w;
    o.river = a.w;
    o.maxLevel = ribbonPoints[${RIBBON_POINT_FLOATS/4}u*p+2u].x;
    o.junctionMask = u32(U.grid.z);
    return o;
}
`;
}

export function buildNearRiverFragmentShader({junctionFields=false}={}) {
    return commonWgsl() + RIVER_VOUT + shadeWgsl() + (junctionFields?junctionFieldLookupWgsl(3):'') + /* wgsl */`

fn nearRiverLevel(k:u32,first:u32,end:u32,dir:vec3<f32>,extend:bool)->vec4<f32> {
    let s=waterRivers[k];let ab=s.p1-s.p0;
    let raw=dot(dir-s.p0,ab)/max(dot(ab,ab),1.0e-20);
    let t=select(clamp(raw,0.0,1.0),raw,extend);
    let values=waterRiverValuesAt(k,first,end,mix(s.s0,s.s1,t));
    let grad=select(vec3<f32>(0.0),ab*((s.s1-s.s0)*values.m.x/max(dot(ab,ab),1.0e-20)),raw==t);
    return vec4<f32>(values.v.x,grad);
}
fn nearRiverLevelField(k:u32,first:u32,end:u32,dir:vec3<f32>)->vec4<f32> {
    let js=waterRiverJoints(k,first,end,waterRivers[k],dir);
    let own=nearRiverLevel(k,first,end,dir,js.up.w>0.0||js.down.w>0.0);
    var level=own;
    if(js.up.w>0.0) {
        let d=nearRiverLevel(js.up.k,first,end,dir,true)-own;
        level+=d*js.up.w+vec4<f32>(0.0,js.up.dw*d.x);
    }
    if(js.down.w>0.0) {
        let d=nearRiverLevel(js.down.k,first,end,dir,true)-own;
        level+=d*js.down.w+vec4<f32>(0.0,js.down.dw*d.x);
    }
    return level;
}

@fragment
fn main(in: NearRiverVOut) -> @location(0) vec4<f32> {
    if(nearOpaqueAboveRiver(in.wp,in.pos.xy,in.maxLevel)) {discard;}
    ${junctionFields?`
    let junction=junctionLocateMasked(normalize(in.wp-U.origin),in.junctionMask);
    if(junction.found&&junctionSet.records[junction.slot].range.z>0u) {
        let value=junctionValue(junction);if(value.z>.999&&value.w>0.0){discard;}
    }
    `:''}
    var wp=in.wp;
    var up=normalize(wp-U.origin);
    var hit=waterRiverSurfaceAt(up);
    if(!hit.near) {discard;}
    let edge = nearRiverEdge(hit);
    if(hit.distM>=hit.halfWidthM+edge || abs(hit.river-in.river)>.5) {discard;}
    // Reject lake-owned pixels before refining the river plane. The view
    // ray is unchanged by that refinement, so this mask query is reusable.
    var lh=WaterLakeHit(WATER_NO_LAKE,0.0,0.0,0.0);
    if(hit.hasLake) {
        lh=waterLakeHitOnRay(U.origin,U.cameraPos,wp,nearWaterSampler,hit);
    }
    let riverW=select(1.0,nearRiverLakeShare(hit, lh.level, lh.cover),lh.level>WATER_NO_LAKE);
    if(riverW<=0.0) {discard;}
    let first=hit.listFirst;
    let end=hit.listEnd;
    let index=u32(hit.seg);
    let ray=normalize(wp-U.cameraPos);
    var plane=up;
    // One Newton step against the continuous bed-design surface. Interpolated
    // ribbon triangles alone intersect steep banks in a tooth at each row.
    {
        let level=nearRiverLevelField(index,first,end,up);
        let grad=level.yzw;
        let radius=length(wp-U.origin);
        plane=up-(grad-up*dot(grad,up))/radius;
        let denom=dot(ray,plane);
        if(abs(denom)>.05) {wp-=ray*clamp((radius-U.R-level.x)/denom,-30.0,30.0);}
        up=normalize(wp-U.origin);
    }
    plane=normalize(plane);
    // A downstream observer can be below an upstream river's elevation
    // while viewing its top/front surface. Radial lake underside rejection
    // would hide that waterfall; raster face/depth tests handle its geometry.

    var c = nearWaterShade(wp, in.pos.xy, plane) * (1.0 - waterSimCover(hit));
    if (riverW < 1.0) {
        // Cross-fading with the lake sheet drawn before (its share 1 - riverW):
        // the two semi-transparent layers over each other covered less than
        // either, a band of bed across the mouth (owner 2026-10-26). Drawn so
        // the result is their linear mix over what lies below: the sheet's
        // shading here, then this layer's colour and coverage solved for it.
        let lk = nearWaterShade(wp, in.pos.xy, up);
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
