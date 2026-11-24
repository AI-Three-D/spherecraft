import { AERIAL_PERSPECTIVE_WGSL } from '../../atmosphere/shaders/aerialPerspectiveCommon.js';
import { CLOUD_ATMOSPHERE_WGSL, CLOUD_MATH_WGSL, CLOUD_SHADOW_LOOKUP_WGSL, CLOUD_UNIFORMS_WGSL } from './cloudCommon.wgsl.js';
import { CLOUD_COMPOSITE_UNIFORMS_WGSL } from './cloudCompositeUniforms.wgsl.js';

/**
 * table: distances in the shadow map by angles around the camera (distances a multiple of 16). mean: the same, averaged over
 * the directions around. volume: screen cells by slices of distance.
 */
export const GOD_RAY_SIZES = Object.freeze({
    high: Object.freeze({ table: [512, 512], mean: [128, 256], volume: [160, 90, 28] }),
    medium: Object.freeze({ table: [256, 512], mean: [64, 256], volume: [112, 63, 20] }),
});
/** Distance covered by the table (km in the shadow map's plane). */
const TABLE_REACH = 110;

const COMMON_WGSL = /* wgsl */`
${CLOUD_UNIFORMS_WGSL}${CLOUD_MATH_WGSL}${CLOUD_COMPOSITE_UNIFORMS_WGSL}
@group(0) @binding(0) var<uniform> u: CloudUniforms;
@group(0) @binding(1) var<uniform> cu: CompositeUniforms;
@group(0) @binding(4) var linearSampler: sampler;
const REACH: f32 = ${TABLE_REACH}.0;

// Lit kilometres among the first x of a direction (turns around the camera), from a table of them.
fn litLength(table: texture_2d<f32>, x: f32, turns: f32) -> f32 {
    let size = vec2i(textureDimensions(table));
    let column = min(x / REACH, 1.0) * f32(size.x - 1);
    let row = turns * f32(size.y) - 0.5;
    let i = min(i32(column), size.x - 2);
    let fx = column - f32(i);
    let j = i32(floor(row));
    let rows = (vec2i(j, j + 1) + size.y) % size.y;
    let a = mix(textureLoad(table, vec2i(i, rows.x), 0).r, textureLoad(table, vec2i(i + 1, rows.x), 0).r, fx);
    let b = mix(textureLoad(table, vec2i(i, rows.y), 0).r, textureLoad(table, vec2i(i + 1, rows.y), 0).r, fx);
    return mix(a, b, row - f32(j)) + max(0.0, x - REACH);
}

// A point or direction in the shadow map's plane, seen along the sun (km).
fn alongSun(v: vec3f) -> vec2f {
    let n = cross(u.shadowE1.xyz, u.shadowE2.xyz);
    let q = v - u.sun.xyz * (dot(v, n) / dot(u.sun.xyz, n));
    return vec2f(dot(q, u.shadowE1.xyz), dot(q, u.shadowE2.xyz));
}
`;

// Crepuscular rays, part 1. Along the sun, every view ray is a line through one point of the cloud shadow map: the camera's.
// So the lit kilometres among the first x in each direction around that point answer for every pixel, and two lookups
// give the lit share of any stretch of a ray. No sampling noise and no bands.
export function buildRayTableShader(columns) {
    return /* wgsl */`
${COMMON_WGSL}
@group(0) @binding(2) var shadowMap: texture_2d<f32>;
@group(0) @binding(3) var outTable: texture_storage_2d<r32float, read_write>;
${CLOUD_SHADOW_LOOKUP_WGSL}

fn litAt(uv: vec2f) -> f32 {
    let edge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
    let share = smoothstep(0.0, 0.15, edge);
    if (share <= 0.0) { return 1.0; }
    // The map ends with the sun at one degree. Fade before that, and with the map's own altitude fade.
    let sunset = smoothstep(0.02, 0.06, dot(u.sun.xyz, cross(u.shadowE1.xyz, u.shadowE2.xyz)));
    return mix(1.0, exp(-shadowDepthSmooth(uv) * u.density.x * cu.rays.w), share * u.shadowInfo.z * sunset);
}

// Blended with the table before: under a low, moving sun the shadow map changes a little everywhere from frame to frame, which
// the glow at the horizon would show as flicker. The table turns with neither the camera nor the screen.
fn keep(at: vec2u, value: f32) {
    textureStore(outTable, at, vec4f(mix(textureLoad(outTable, at).r, value, cu.rays3.y)));
}

// One row: a serial sum over it would be the slowest part of the whole effect, so sixteen parts are summed side by side.
const PARTS: u32 = 16u;
const PART: u32 = ${columns / 16}u;
var<workgroup> sums: array<f32, PARTS>;

@compute @workgroup_size(PARTS)
fn main(@builtin(workgroup_id) row: vec3u, @builtin(local_invocation_index) part: u32) {
    let size = textureDimensions(outTable);
    let angle = (f32(row.x) + 0.5) / f32(size.y) * 2.0 * PI;
    let direction = vec2f(cos(angle), sin(angle)) / u.shadowE1.w;
    let origin = shadowMapUv(u.camPos.xyz);
    let step = REACH / f32(size.x - 1u);
    var lit: array<f32, PART>;
    var sum = 0.0;
    for (var i = 0u; i < PART; i++) {
        sum += litAt(origin + direction * ((f32(part * PART + i) + 0.5) * step)) * step;
        lit[i] = sum;
    }
    sums[part] = sum;
    workgroupBarrier();
    var before = 0.0;
    for (var i = 0u; i < part; i++) { before += sums[i]; }
    if (part == 0u) { textureStore(outTable, vec2u(0u, row.x), vec4f(0.0)); }
    for (var i = 0u; i < PART; i++) {
        // Column c holds the sum of the samples before it. The last sample has no column.
        let column = part * PART + i + 1u;
        if (column < size.x) { keep(vec2u(column, row.x), before + lit[i]); }
    }
}
`;
}


// The average over the directions around, about 20 degrees either way. What differs from it is a beam or a gap.
export const CLOUD_RAY_MEAN_WGSL = /* wgsl */`
${COMMON_WGSL}
@group(0) @binding(2) var table: texture_2d<f32>;
@group(0) @binding(3) var outMean: texture_storage_2d<r32float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(outMean);
    if (any(id.xy >= size)) { return; }
    let x = f32(id.x) / f32(size.x - 1u) * REACH;
    let turns = (f32(id.y) + 0.5) / f32(size.y);
    var sum = 0.0;
    var weight = 0.0;
    for (var i = -12; i <= 12; i++) {
        let w = 1.0 - abs(f32(i)) / 13.0;
        sum += w * litLength(table, x, fract(turns + f32(i) / 216.0 + 1.0));
        weight += w;
    }
    textureStore(outMean, id.xy, vec4f(sum / weight));
}
`;

// Part 2. Light scattered towards the camera up to each slice, from the host's atmosphere (as the lit share of its haze)
// and from a thin haze below the clouds that shows the beams.
export const CLOUD_RAY_VOLUME_WGSL = /* wgsl */`
${COMMON_WGSL}${CLOUD_ATMOSPHERE_WGSL}${AERIAL_PERSPECTIVE_WGSL}
@group(0) @binding(2) var table: texture_2d<f32>;
@group(0) @binding(3) var outRays: texture_storage_3d<rgba16float, write>;
@group(0) @binding(5) var meanTable: texture_2d<f32>;
@group(0) @binding(6) var transmittanceLut: texture_2d<f32>;
@group(0) @binding(7) var cloudLightLut: texture_2d<f32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(outRays);
    if (any(id.xy >= size.xy)) { return; }
    let rd = cameraRay((vec2f(id.xy) + 0.5) / vec2f(size.xy), vec2f(1.0), u.camRight, u.camUp, u.camBack, u.frameInfo.x);
    let ro = u.camPos.xyz;
    let R = cu.atmo0.x;
    let Ra = cu.atmo0.y;
    let units = cu.viewport.w;
    let mapped = alongSun(rd);
    let rate = length(mapped);
    let turns = fract(atan2(mapped.y, mapped.x) / (2.0 * PI));
    let cosSun = dot(rd, u.sun.xyz);
    let phaseR = ap_rayleighPhase(cosSun);
    let phaseM = ap_miePhase(cosSun, cu.atmo2.x);
    let phaseBeam = mix(henyeyGreenstein(cosSun, cu.rays2.x), 1.0 / (4.0 * PI), cu.rays2.y);
    // The beams are the difference from the light around them, so that they neither veil a fair sky nor lift a grey one.
    let gain = cu.rays.x * phaseBeam * u.sun.w;
    // Towards the sun a stretch of the ray shrinks to a point of the map, so take at least a fifth of a kilometre of it.
    let litHere = litLength(table, 0.2, turns);
    let meanHere = litLength(meanTable, 0.2, turns);
    var T = vec3f(1.0);
    var beamT = 1.0;
    var all = 0.0;
    var lit = 0.0;
    var beam = vec3f(0.0);
    var weight = vec3f(0.0);
    var previous = 0.0;
    var previousLit = 0.0;
    var previousMean = 0.0;
    textureStore(outRays, vec3u(id.xy, 0u), vec4f(0.0, 0.0, 0.0, 1.0));
    for (var slice = 1u; slice < size.z; slice++) {
        let t = exp2(f32(slice) / f32(size.z - 1u) * log2(1.0 + cu.rays.z)) - 1.0;
        let litKm = litLength(table, rate * t, turns);
        let meanKm = litLength(meanTable, rate * t, turns);
        let span = rate * (t - previous);
        let near = max(0.0, 0.2 - span) * 5.0;
        let reached = saturate((litKm - previousLit + near * litHere) / max(span, 0.2));
        let around = saturate((meanKm - previousMean + near * meanHere) / max(span, 0.2));
        let p = ro + rd * (0.5 * (previous + t));
        let r = length(p);
        // The map holds the whole column, so let more sunlight in towards the top of the layer.
        let above = saturate((u.planet.z - r) / (u.planet.z - u.planet.y));
        let below = smoothstep(0.0, 0.8, above);
        let sunlit = mix(1.0, reached, below);
        let altitude = clamp(r * units - R, 0.0, Ra - R);
        let cosZenith = dot(p / r, u.sun.xyz);
        let sunT = ap_sampleTransmittance(transmittanceLut, linearSampler, altitude, cosZenith, R, Ra) * smoothstep(-0.08, 0.08, cosZenith);
        let density = ap_getDensity(altitude, cu.atmo0.z, cu.atmo0.w) * step(r * units, Ra);
        let scatR = cu.atmo1.xyz * density.x;
        let scatM = cu.atmo1.w * density.y;
        let ext = scatR + vec3f(scatM);
        let dt = (t - previous) * units;
        let stepT = exp(-ext * dt);
        let source = dot(T * (scatR * phaseR + vec3f(scatM * phaseM)) * sunT * (1.0 - stepT) / max(ext, vec3f(1.0e-12)), vec3f(0.2126, 0.7152, 0.0722));
        all += source;
        lit += source * sunlit;
        let km = altitude / units;
        let haze = exp(-km / cu.rays2.z) * (1.0 - smoothstep(u.planet.y, mix(u.planet.y, u.planet.z, 0.45), r));
        // In the sunset colours of the clouds that shape the beams.
        let sunlight = sunTransmittance(cloudLightLut, linearSampler, r, cosZenith, u.planet.x, u.planet.w);
        let share = T * sunlight * (beamT * haze * (t - previous));
        beam += share * ((reached - around) * below);
        weight += share;
        beamT *= exp(-cu.rays3.x * haze * (t - previous));
        T *= stepT;
        previous = t;
        previousLit = litKm;
        previousMean = meanKm;
        // Darker than average counts as haze that the sun does not reach.
        let dark = saturate(-beam.g / max(weight.g, 1.0e-9));
        let litShare = select(1.0, lit / all, all > 1.0e-9) * (1.0 - min(0.9, cu.rays2.w * dark));
        textureStore(outRays, vec3u(id.xy, slice), vec4f(max(beam, vec3f(0.0)) * gain, litShare));
    }
}
`;
