// js/renderer/environment/shaders/weatherCompute.wgsl.js
export function createWeatherComputeShader() {
    return /* wgsl */`
struct WeatherParams {
    size: u32,
    layers: u32,
    _pad0: u32,
    _pad1: u32,
    time: f32,
    dt: f32,
    advection: f32,
    diffusion: f32,
    windStrength: f32,
    precipitationRate: f32,
    evaporation: f32,
    noiseScale: f32,
    seed: i32,
    _pad2: vec3<f32>,
};

@group(0) @binding(0) var<uniform> params: WeatherParams;
@group(0) @binding(1) var prevWeather: texture_2d_array<f32>;
@group(0) @binding(2) var weatherSampler: sampler;
@group(0) @binding(3) var outWeather: texture_storage_2d_array<rgba8unorm, write>;

fn hash21(p: vec2<f32>) -> f32 {
    let h = dot(p, vec2<f32>(127.1, 311.7));
    return fract(sin(h) * 43758.5453123);
}

fn noise2D(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let a = hash21(i);
    let b = hash21(i + vec2<f32>(1.0, 0.0));
    let c = hash21(i + vec2<f32>(0.0, 1.0));
    let d = hash21(i + vec2<f32>(1.0, 1.0));
    let u = f * f * (3.0 - 2.0 * f);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn fbm2(p: vec2<f32>) -> f32 {
    var value = 0.0;
    var amp = 0.5;
    var freq = 1.0;
    for (var i = 0; i < 4; i++) {
        value += noise2D(p * freq) * amp;
        freq *= 2.0;
        amp *= 0.5;
    }
    return value;
}

fn cubeUVToDir(face: u32, uv: vec2<f32>) -> vec3<f32> {
    let a = uv * 2.0 - vec2<f32>(1.0, 1.0);
    if (face == 0u) { return normalize(vec3<f32>(1.0, -a.y, -a.x)); }
    if (face == 1u) { return normalize(vec3<f32>(-1.0, -a.y, a.x)); }
    if (face == 2u) { return normalize(vec3<f32>(a.x, 1.0, a.y)); }
    if (face == 3u) { return normalize(vec3<f32>(a.x, -1.0, -a.y)); }
    if (face == 4u) { return normalize(vec3<f32>(a.x, -a.y, 1.0)); }
    return normalize(vec3<f32>(-a.x, -a.y, -1.0));
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let size = params.size;
    if (gid.x >= size || gid.y >= size || gid.z >= params.layers) {
        return;
    }

    let uv = (vec2<f32>(gid.xy) + 0.5) / f32(size);
    let face = gid.z;

    let prev = textureSampleLevel(prevWeather, weatherSampler, uv, i32(face), 0.0);
    var wind = prev.ba * 2.0 - vec2<f32>(1.0, 1.0);

    // Advect previous state
    let advUV = clamp(uv - wind * params.advection * params.dt / f32(size), vec2<f32>(0.0), vec2<f32>(1.0));
    let adv = textureSampleLevel(prevWeather, weatherSampler, advUV, i32(face), 0.0);

    let dir = cubeUVToDir(face, uv);
    let lat = abs(dir.y);
    let moisture = mix(0.2, 1.0, 1.0 - lat);

    let n = fbm2(uv * params.noiseScale + vec2<f32>(f32(face) * 1.7, params.time * 0.01));
    let n2 = fbm2(uv * (params.noiseScale * 0.5) + vec2<f32>(params.time * 0.02, f32(face) * 2.3));

    var coverage = adv.r;
    var precip = adv.g;

    coverage += (n - 0.5) * params.diffusion * params.dt;
    coverage += moisture * 0.05 * params.dt;
    coverage -= precip * params.evaporation * params.dt;
    coverage = clamp(coverage, 0.0, 1.0);

    precip += max(coverage - 0.6, 0.0) * params.precipitationRate * params.dt;
    precip -= params.evaporation * 0.5 * params.dt;
    precip = clamp(precip, 0.0, 1.0);

    let angle = n2 * 6.283185 + dir.y * 0.5;
    let targetWind = vec2<f32>(cos(angle), sin(angle)) * params.windStrength;
    let windLerp = clamp(params.dt * 0.5, 0.0, 1.0);
    wind = normalize(mix(wind, targetWind, windLerp));

    let outWind = wind * 0.5 + vec2<f32>(0.5, 0.5);
    textureStore(outWeather, vec2<i32>(gid.xy), i32(face), vec4<f32>(coverage, precip, outWind.x, outWind.y));
}
`;
}
