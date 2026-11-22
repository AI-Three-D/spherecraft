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

export const CLOUD_SKY_PROBES = /* wgsl */`
// Trace two upward samples and three world-aligned side samples so cloud
// creases stay shaded as the camera turns.
fn probeSkyVisibility(p: vec3f, weather: Weather, footprint: f32) -> f32 {
    let up = normalize(p);
    let a = p + up * 0.25;
    let b = p + up * 0.8;
    let da = cloudBaseWithWeather(a, heightFraction(length(a)), weather, max(footprint, 0.125)).density;
    let db = cloudBaseWithWeather(b, heightFraction(length(b)), weather, max(footprint, 0.4)).density;
    var dl = 0.0;
    if (u.look.y > 0.0) {
        let east = normalize(cross(select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(up.y) > 0.9), up));
        let north = cross(up, east);
        let angles = array<vec2f, 3>(vec2f(1.0, 0.0), vec2f(-0.5, 0.8660254), vec2f(-0.5, -0.8660254));
        for (var k = 0; k < 3; k++) {
            let ang = f32(k) * 2.0943951;
            let direction = select(vec2f(cos(ang), sin(ang)), angles[k], SKIP_UNUSED_DENSITY);
            let q = p + (east * direction.x * 0.87 + north * direction.y * 0.87 + up * 0.5) * 0.35;
            dl += cloudBaseWithWeather(q, heightFraction(length(q)), weather, max(footprint, 0.15)).density;
        }
    }
    let od = (da * 0.4 + db * 0.6 + dl * 0.45 * u.look.y) * u.density.x;
    return mix(select(0.25, 0.15, u.look.y > 0.0), 1.0, exp(-od * 0.35));
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

export const CLOUD_TRANSPORT_BAKE_WGSL = /* wgsl */`${header}${CLOUD_LIGHT_PROBES}${CLOUD_SKY_PROBES}
@group(0) @binding(5) var transportOut: texture_storage_3d<rgba16float, write>;

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(transportOut);
    if (any(id >= size)) { return; }
    let uvw = (vec3f(id) + 0.5) / vec3f(size);
    let p = cachePosition(uvw.xy, u.cacheGrid.w, mix(u.planet.y, u.planet.z, uvw.z));
    let weather = sampleWeather(p, 0.0);
    let steps = i32(u.quality.w);
    let sun = probeLight(p, 0.0, weather, u.sun.xyz, 0, steps, 1.0);
    let sky = probeSkyVisibility(p, weather, 0.0);
    var moon = 0.0;
    if (u.moon.w > 0.0) {
        moon = probeLight(p, 0.0, weather, u.moon.xyz, 0, steps, 1.0);
    }
    textureStore(transportOut, id, vec4f(sun, sky, moon, 0.0));
}
`;
