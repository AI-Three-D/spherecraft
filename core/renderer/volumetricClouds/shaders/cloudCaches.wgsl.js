import { CLOUD_UNIFORMS_WGSL, CLOUD_MATH_WGSL, CLOUD_DENSITY_WGSL } from './cloudCommon.wgsl.js';

export const CLOUD_CACHE_COORDS = /* wgsl */`
fn cachePlane(p: vec3f) -> vec3f {
    let g = normalize(p) * u.planet.x;
    return vec3f(dot(g, u.cacheU.xyz), dot(g, u.cacheV.xyz), dot(g, cross(u.cacheU.xyz, u.cacheV.xyz)));
}

fn cacheWeight(plane: vec3f, uv: vec2f) -> f32 {
    let edge = max(abs(uv.x - 0.5), abs(uv.y - 0.5));
    let face = plane.z - max(abs(plane.x), abs(plane.y));
    return (1.0 - smoothstep(0.40, 0.49, edge)) * smoothstep(0.0, 6.0, face);
}

fn cachePosition(uv: vec2f, extent: f32, radius: f32) -> vec3f {
    let xy = u.cacheGrid.xy + (uv - 0.5) * extent;
    let normal = cross(u.cacheU.xyz, u.cacheV.xyz);
    let z = sqrt(max(u.planet.x * u.planet.x - dot(xy, xy), 0.0));
    return (u.cacheU.xyz * xy.x + u.cacheV.xyz * xy.y + normal * z) * (radius / u.planet.x);
}
`;

export const CLOUD_LIGHT_PROBES = /* wgsl */`
const LIVE_SUN_PROBES: i32 = 3;

// The first two probes include small-scale erosion. Farther probes use base density.
fn probeLight(p: vec3f, footprint: f32, weather: Weather, dir: vec3f, first: i32, end: i32, farWeight: f32) -> f32 {
    var od = 0.0;
    var stepLen = u.march2.x * exp2(f32(first));
    var t = stepLen - u.march2.x;
    for (var i = first; i < end; i++) {
        let lp = p + dir * (t + stepLen * 0.5);
        let fp = max(footprint, stepLen * 0.5);
        let r = length(lp);
        let b = cloudBaseWithWeather(lp, heightFraction(r), weather, fp);
        var d = b.density;
        if (i < 2 && d > 0.0) { d = cloudDetail(lp, b, fp); }
        let weight = select(1.0, farWeight, i >= LIVE_SUN_PROBES);
        od += (d + altoDensity(lp, r, weather, fp)) * (stepLen * weight);
        t += stepLen;
        stepLen *= 2.0;
    }
    return od;
}
`;

const header = /* wgsl */`${CLOUD_UNIFORMS_WGSL}${CLOUD_MATH_WGSL}
@group(0) @binding(0) var<uniform> u: CloudUniforms;
@group(0) @binding(1) var shapeTex: texture_3d<f32>;
@group(0) @binding(2) var detailTex: texture_3d<f32>;
@group(0) @binding(3) var weatherTex: texture_3d<f32>;
@group(0) @binding(4) var noiseSampler: sampler;
${CLOUD_DENSITY_WGSL}${CLOUD_CACHE_COORDS}
`;

export const CLOUD_WEATHER_BAKE_WGSL = /* wgsl */`${header}
@group(0) @binding(5) var weatherOut: texture_storage_2d<rgba16float, write>;
@group(0) @binding(6) var shiftOut: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(weatherOut);
    if (any(id.xy >= size)) { return; }
    let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
    let weather = sampleWeather(cachePosition(uv, u.cacheGrid.z, u.planet.y), 0.0);
    textureStore(weatherOut, id.xy, vec4f(weather.coverage, weather.kind, weather.lift, weather.stretch));
    textureStore(shiftOut, id.xy, vec4f(weather.shift, 0.0));
}
`;

export const CLOUD_LIGHT_BAKE_WGSL = /* wgsl */`${header}${CLOUD_LIGHT_PROBES}
@group(0) @binding(5) var lightOut: texture_storage_3d<rgba16float, write>;

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(lightOut);
    if (any(id >= size)) { return; }
    let uvw = (vec3f(id) + 0.5) / vec3f(size);
    let p = cachePosition(uvw.xy, u.cacheGrid.w, mix(u.planet.y, u.planet.z, uvw.z));
    let weather = sampleWeather(p, 0.0);
    let od = probeLight(p, 0.0, weather, u.sun.xyz, LIVE_SUN_PROBES, i32(u.quality.w), 1.0);
    textureStore(lightOut, id, vec4f(od, 0.0, 0.0, 0.0));
}
`;
