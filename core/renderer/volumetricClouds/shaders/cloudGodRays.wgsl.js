import { AERIAL_PERSPECTIVE_WGSL } from '../../atmosphere/shaders/aerialPerspectiveCommon.js';
import { CLOUD_ATMOSPHERE_WGSL, CLOUD_MATH_WGSL, CLOUD_SHADOW_LOOKUP_WGSL, CLOUD_UNIFORMS_WGSL } from './cloudCommon.wgsl.js';
import { CLOUD_COMPOSITE_UNIFORMS_WGSL } from './cloudCompositeUniforms.wgsl.js';

/**
 * table: distances in the shadow map by angles around the camera (distances a multiple of 16). filtered: half of both, by
 * width of the average over the angles. volume: screen cells by slices of distance.
 */
export const GOD_RAY_SIZES = Object.freeze({
    high: Object.freeze({ table: [512, 512], volume: [160, 90, 28] }),
    medium: Object.freeze({ table: [256, 512], volume: [112, 63, 20] }),
});
/** Averages of the filtered table: over 2, 4, ... 64 angles of the table. */
export const GOD_RAY_LEVELS = 6;
/** Distance covered by the table (km in the shadow map's plane). */
const TABLE_REACH = 110;

const COMMON_WGSL = /* wgsl */`
${CLOUD_UNIFORMS_WGSL}${CLOUD_MATH_WGSL}${CLOUD_COMPOSITE_UNIFORMS_WGSL}
@group(0) @binding(0) var<uniform> u: CloudUniforms;
@group(0) @binding(1) var<uniform> cu: CompositeUniforms;
@group(0) @binding(4) var linearSampler: sampler;
const REACH: f32 = ${TABLE_REACH}.0;

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

// Part 2. The table averaged over ever wider ranges of angles. Towards the sun a cell of the volume spans many angles: taken
// at single ones, the edges of the beams came out as teeth. r: shadowed kilometres, averaged over the level's angles;
// g: over about 20 degrees either way. What differs from that is a beam or a gap. Sums over all angles of a distance give
// every average from two reads, whatever its width.
export function buildRayFilterShader(rows) {
    return /* wgsl */`
const REACH: f32 = ${TABLE_REACH}.0;
const ROWS: u32 = ${rows}u;
const PARTS: u32 = 64u;
const PART: u32 = ${rows / 64}u;
@group(0) @binding(0) var table: texture_2d<f32>;
@group(0) @binding(1) var outFiltered: texture_storage_3d<rgba16float, write>;
var<workgroup> sums: array<f32, PARTS>;
var<workgroup> before: array<f32, ${rows + 1}>;

// Sum of the rows before this one. The rows go round.
fn sumBefore(row: i32) -> f32 {
    let n = i32(ROWS);
    let turn = i32(floor(f32(row) / f32(n)));
    return before[row - turn * n] + f32(turn) * before[n];
}

fn average(middle: i32, half: i32) -> f32 {
    return (sumBefore(middle + half) - sumBefore(middle - half)) / f32(2 * half);
}

@compute @workgroup_size(PARTS)
fn main(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) part: u32) {
    let column = group.x * 2u;
    let x = f32(column) / f32(textureDimensions(table).x - 1u) * REACH;
    var values: array<f32, PART>;
    var sum = 0.0;
    for (var i = 0u; i < PART; i++) {
        values[i] = x - textureLoad(table, vec2u(column, part * PART + i), 0).r;
        sum += values[i];
    }
    sums[part] = sum;
    workgroupBarrier();
    var total = 0.0;
    for (var i = 0u; i < part; i++) { total += sums[i]; }
    for (var i = 0u; i < PART; i++) {
        before[part * PART + i] = total;
        total += values[i];
    }
    if (part == PARTS - 1u) { before[ROWS] = total; }
    workgroupBarrier();
    for (var i = 0u; i < PART / 2u; i++) {
        let row = part * (PART / 2u) + i;
        let middle = i32(2u * row + 1u);
        let around = 0.5 * (average(middle, ${Math.round(rows * 0.027)}) + average(middle, ${Math.round(rows * 0.047)}));
        for (var level = 0u; level < ${GOD_RAY_LEVELS}u; level++) {
            textureStore(outFiltered, vec3u(group.x, row, level), vec4f(average(middle, 1 << level), around, 0.0, 0.0));
        }
    }
}
`;
}

// Part 3. Light scattered towards the camera up to each slice, from the host's atmosphere (as the lit share of its haze)
// and from a thin haze below the clouds that shows the beams.
export const CLOUD_RAY_VOLUME_WGSL = /* wgsl */`
${COMMON_WGSL}${CLOUD_ATMOSPHERE_WGSL}${AERIAL_PERSPECTIVE_WGSL}
@group(0) @binding(2) var filtered: texture_3d<f32>;
@group(0) @binding(3) var outRays: texture_storage_3d<rgba16float, write>;
@group(0) @binding(5) var raySampler: sampler; // repeats along y
@group(0) @binding(6) var transmittanceLut: texture_2d<f32>;
@group(0) @binding(7) var cloudLightLut: texture_2d<f32>;

fn rayOf(cell: vec2f, cells: vec2f) -> vec3f {
    return cameraRay(cell / cells, vec2f(1.0), u.camRight, u.camUp, u.camBack, u.frameInfo.x);
}

// Lit kilometres among the first x of a direction (turns around the camera): averaged over the angles of a level, and around.
fn litLengths(x: f32, turns: f32, level: f32) -> vec2f {
    let size = vec3f(textureDimensions(filtered));
    let reached = min(x, REACH * (1.0 - 0.5 / size.x));
    let at = vec3f((reached / REACH * (size.x - 0.5) + 0.5) / size.x, turns, (level + 0.5) / size.z);
    return x - textureSampleLevel(filtered, raySampler, at, 0.0).rg;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(outRays);
    if (any(id.xy >= size.xy)) { return; }
    let rd = rayOf(vec2f(id.xy) + 0.5, vec2f(size.xy));
    let ro = u.camPos.xyz;
    let R = cu.atmo0.x;
    let Ra = cu.atmo0.y;
    let units = cu.viewport.w;
    let mapped = alongSun(rd);
    let rate = length(mapped);
    let turns = fract(atan2(mapped.y, mapped.x) / (2.0 * PI));
    // The angles that a few cells span: the darkening between the beams makes their edges steeper again.
    let across = alongSun(rayOf(vec2f(id.xy) + vec2f(1.5, 0.5), vec2f(size.xy)));
    let down = alongSun(rayOf(vec2f(id.xy) + vec2f(0.5, 1.5), vec2f(size.xy)));
    let turned = vec2f(mapped.x * across.y - mapped.y * across.x, mapped.x * down.y - mapped.y * down.x);
    let spanned = length(turned) / max(dot(mapped, mapped) * 2.0 * PI, 1.0e-9);
    let level = log2(max(4.0 * spanned * f32(textureDimensions(filtered).y), 1.0));
    // Next to the sun a cell spans more than the widest average: there only the light around is left.
    let single = 1.0 - smoothstep(f32(textureDimensions(filtered).z) - 1.0, f32(textureDimensions(filtered).z), level);
    let cosSun = dot(rd, u.sun.xyz);
    let phaseR = ap_rayleighPhase(cosSun);
    let phaseM = ap_miePhase(cosSun, cu.atmo2.x);
    let phaseBeam = mix(henyeyGreenstein(cosSun, cu.rays2.x), 1.0 / (4.0 * PI), cu.rays2.y);
    // The beams are the difference from the light around them, so that they neither veil a fair sky nor lift a grey one.
    let gain = cu.rays.x * phaseBeam * u.sun.w;
    // Towards the sun a stretch of the ray shrinks to a point of the map, so take at least a fifth of a kilometre of it.
    let here = litLengths(0.2, turns, level);
    var T = vec3f(1.0);
    var beamT = 1.0;
    var all = 0.0;
    var lit = 0.0;
    var beam = vec3f(0.0);
    var weight = vec3f(0.0);
    var previous = 0.0;
    var previousLit = vec2f(0.0);
    textureStore(outRays, vec3u(id.xy, 0u), vec4f(0.0, 0.0, 0.0, 1.0));
    for (var slice = 1u; slice < size.z; slice++) {
        let t = exp2(f32(slice) / f32(size.z - 1u) * log2(1.0 + cu.rays.z)) - 1.0;
        let litKm = litLengths(rate * t, turns, level);
        let span = rate * (t - previous);
        let near = max(0.0, 0.2 - span) * 5.0;
        let shares = saturate((litKm - previousLit + near * here) / max(span, 0.2));
        let around = shares.y;
        let reached = mix(around, shares.x, single);
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
        // Darker than average counts as haze that the sun does not reach.
        let dark = saturate(-beam.g / max(weight.g, 1.0e-9));
        let litShare = select(1.0, lit / all, all > 1.0e-9) * (1.0 - min(0.9, cu.rays2.w * dark));
        textureStore(outRays, vec3u(id.xy, slice), vec4f(max(beam, vec3f(0.0)) * gain, litShare));
    }
}
`;
