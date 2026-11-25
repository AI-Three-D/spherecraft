import { CLOUD_DENSITY_WGSL, CLOUD_MATH_WGSL, CLOUD_UNIFORMS_WGSL } from './cloudCommon.wgsl.js';
import { CLOUD_LIGHTING_INFERENCE_WGSL } from '../neural/lightingInference.js';
import { CLOUD_WEATHER_ATLAS_LOOKUP_WGSL } from './cloudViewFields.wgsl.js';

export const CLOUD_NEURAL_LIGHT_BAKE_WGSL = /* wgsl */`
${CLOUD_UNIFORMS_WGSL}${CLOUD_MATH_WGSL}
@group(0) @binding(0) var<uniform> u: CloudUniforms;
@group(0) @binding(1) var shapeTex: texture_3d<f32>;
@group(0) @binding(2) var detailTex: texture_3d<f32>;
@group(0) @binding(3) var weatherTex: texture_3d<f32>;
@group(0) @binding(4) var noiseSampler: sampler;
@group(0) @binding(5) var linearSampler: sampler;
@group(0) @binding(6) var weatherField: texture_cube<f32>;
@group(0) @binding(7) var weatherShift: texture_cube<f32>;
@group(0) @binding(8) var outLight: texture_storage_3d<rgba16float, write>;
@group(0) @binding(9) var<uniform> rowOffset: vec4u;

${CLOUD_DENSITY_WGSL}${CLOUD_WEATHER_ATLAS_LOOKUP_WGSL}
${CLOUD_LIGHTING_INFERENCE_WGSL}

const SUN_COLUMN_SPLIT_KM: f32 = 2.4;

fn filteredLightDensity(p: vec3f, weather: Weather, footprint: f32, detailed: bool) -> f32 {
    let r = length(p);
    let b = cloudBaseWithWeather(p, heightFraction(r), weather, footprint);
    var d = b.density;
    if (detailed && d > 0.0) { d = cloudDetail(p, b, footprint); }
    return d + altoDensity(p, r, weather, footprint);
}

fn lightColumn(p: vec3f, direction: vec3f, start: f32) -> f32 {
    let outer = raySphere(p, direction, u.planet.z);
    let inner = raySphere(p, direction, u.planet.y);
    var end = min(outer.y, start + 80.0);
    if (inner.x < inner.y && inner.x > 0.0) { end = min(end, inner.x); }
    var tau = 0.0;
    var t = start;
    for (var i = 0; i < 100 && t < end && tau < 20.0; i++) {
        // Match the teacher's near column spacing. Farther out the smooth map
        // needs fewer taps, particularly along the layer at a low sun angle.
        let step = min(end - t, min(2.0, 0.2 + 0.035 * t));
        let q = p + direction * (t + step * 0.5);
        tau += filteredLightDensity(q, atlasWeather(q), 0.4, false) * step * u.density.x;
        t += step;
    }
    return tau;
}

fn voxelPosition(voxel: vec3u, size: vec3u) -> vec3f {
    let uvw = (vec3f(voxel) + 0.5) / vec3f(size);
    let xy = u.cacheGrid.xy + (uvw.xy - 0.5) * u.cacheGrid.w;
    let normal = cross(u.cacheU.xyz, u.cacheV.xyz);
    let z = sqrt(max(u.planet.x * u.planet.x - dot(xy, xy), 0.0));
    return (u.cacheU.xyz * xy.x + u.cacheV.xyz * xy.y + normal * z) * (mix(u.planet.y, u.planet.z, uvw.z) / u.planet.x);
}

fn bakeLighting(voxel: vec3u, p: vec3f, column: f32) {
    let radius = length(p);
    let up = p / radius;
    // Below the horizon the column toward the sun ends where it leaves the cloud base, so a light front swept across the patch.
    // The sun is held at 6 degrees or higher, as in the fitted light outside the patch.
    let setSun = max(0.0, 0.1 - dot(up, u.sun.xyz));
    let sun = normalize(u.sun.xyz + up * setSun);
    let w = atlasWeather(p);
    let b = cloudBaseWithWeather(p, heightFraction(radius), w, 0.012);
    var d = b.density;
    if (d > 0.0) { d = cloudDetail(p, b, 0.012); }
    d += altoDensity(p, radius, w, 0.012);
    // Carry a confidence weight through trilinear filtering so the empty voxels
    // on the other side of a cloud edge do not bleed black into its lighting.
    let confidence = smoothstep(0.001, 0.035, d);
    if (confidence <= 0.0) {
        textureStore(outLight, vec3i(voxel), vec4f(0.0));
        return;
    }
    var samples: array<f32, 6>;
    var nearMass = 0.0;
    var step = u.march2.x;
    var t = 0.0;
    for (var i = 0; i < min(6, i32(u.quality.w)); i++) {
        let q = p + sun * (t + step * 0.5);
        let dSun = filteredLightDensity(q, w, max(0.012, step * 0.5), i < 2);
        samples[i] = dSun;
        nearMass += dSun * min(step, max(0.0, SUN_COLUMN_SPLIT_KM - t));
        t += step;
        step *= 2.0;
    }
    let east = normalize(cross(select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(up.y) > 0.9), up));
    let north = cross(up, east);
    let side = east * 0.3045;
    let otherSide = north * 0.2637047;
    let lift = p + up * 0.175;
    let skyA = cloudBaseWithWeather(p + up * 0.25, heightFraction(radius + 0.25), w, 0.125).density;
    let skyB = cloudBaseWithWeather(p + up * 0.8, heightFraction(radius + 0.8), w, 0.4).density;
    let side0 = lift + side;
    let side1 = lift - side * 0.5 + otherSide;
    let side2 = lift - side * 0.5 - otherSide;
    let farOd = lightColumn(p, sun, SUN_COLUMN_SPLIT_KM);
    // Packed in the order of the two exported models. The sky model ignores the final lane.
    let features = array<vec4f, 6>(
        vec4f(samples[0], samples[1], samples[2], samples[3]),
        vec4f(samples[4], samples[5], skyA, skyB),
        vec4f(cloudBaseWithWeather(side0, heightFraction(length(side0)), w, 0.15).density,
            cloudBaseWithWeather(side1, heightFraction(length(side1)), w, 0.15).density,
            cloudBaseWithWeather(side2, heightFraction(length(side2)), w, 0.15).density, d),
        vec4f(b.density, b.localH, b.h, b.stratiform),
        vec4f(w.coverage, w.kind, dot(up, sun), exp(-farOd)),
        vec4f(log(1.0 + column), log(1.0 + farOd), 0.0, 0.0));
    // Filter the transmitted light directly. Averaging depth before taking
    // the exponential darkens partly occluded paths between neighboring cells.
    // exp(-(near + far)) on filtered density is about 0.6x the traced transmittance
    // in daylight (gaps in a clumpy column let light through), so learned sets predict it.
    let formulaDirect = exp(-(nearMass * u.density.x + farOd));
    // bouncedSunScale reads this channel to find shielded decks in late-sun storms, and was
    // calibrated on the formula there. Keep the formula in that regime only.
    let stormKeep = smoothstep(0.65, 1.0, u.weatherStyle.z) * (1.0 - smoothstep(0.05, 0.22, dot(up, sun)));
    let direct = mix(min(inferDirectTransmittance(features), 1.0), formulaDirect, stormKeep);
    textureStore(outLight, vec3i(voxel), vec4f(inferMultipleScattering(features),
        inferSkyScattering(features), direct, 1.0) * confidence);
}


// One cooperative suffix sum per radial column. Each voxel evaluates the sky
// density once and shares it with every lower voxel in that column.
var<workgroup> skyColumn: array<f32, 128>;
@compute @workgroup_size(4, 1, 32)
fn main(@builtin(global_invocation_id) id: vec3u, @builtin(local_invocation_index) lane: u32) {
    let voxel = id + vec3u(0u, rowOffset.x, 0u);
    let size = textureDimensions(outLight);
    let valid = all(voxel < size);
    let p = voxelPosition(voxel, size);
    let thickness = (u.planet.z - u.planet.y) / f32(size.z);
    var slab = 0.0;
    if (valid) { slab = filteredLightDensity(p, atlasWeather(p), 0.4, false) * thickness * u.density.x; }
    skyColumn[lane] = slab;
    workgroupBarrier();
    for (var offset = 1u; offset < 32u; offset *= 2u) {
        var above = 0.0;
        if (id.z + offset < 32u) { above = skyColumn[lane + 4u * offset]; }
        workgroupBarrier();
        skyColumn[lane] += above;
        workgroupBarrier();
    }
    if (valid) { bakeLighting(voxel, p, skyColumn[lane] - 0.5 * slab); }
}
`;
