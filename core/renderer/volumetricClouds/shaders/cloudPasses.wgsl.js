import {
    CLOUD_UNIFORMS_WGSL, CLOUD_MATH_WGSL, CLOUD_ATMOSPHERE_WGSL, CLOUD_DENSITY_WGSL, CLOUD_RAY_INPUT_WGSL, CLOUD_LAYER_BLEND_WGSL,
} from './cloudCommon.wgsl.js';
import { CLOUD_CACHE_COORDS, CLOUD_LIGHT_PROBES } from './cloudCaches.wgsl.js';

const HEADER = `${CLOUD_UNIFORMS_WGSL}${CLOUD_MATH_WGSL}${CLOUD_ATMOSPHERE_WGSL}`;

const NOISE_BINDINGS = /* wgsl */`
@group(0) @binding(0) var<uniform> u: CloudUniforms;
@group(0) @binding(1) var shapeTex: texture_3d<f32>;
@group(0) @binding(2) var detailTex: texture_3d<f32>;
@group(0) @binding(3) var weatherTex: texture_3d<f32>;
@group(0) @binding(4) var noiseSampler: sampler;
`;

export const TRANSMITTANCE_LUT_WGSL = /* wgsl */`${HEADER}
@group(0) @binding(0) var<uniform> u: CloudUniforms;
@group(0) @binding(1) var outLut: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var outCloudLight: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    if (id.x >= 256u || id.y >= 64u) { return; }
    let R = u.planet.x;
    let Rt = u.planet.w;
    let x = vec2f(id.xy) / (TRANSMITTANCE_LUT_SIZE - 1.0);
    let H = sqrt((Rt - R) * (Rt + R));
    let rho = H * x.y;
    let r = sqrt(rho * rho + R * R);
    let dMin = Rt - r;
    let dMax = rho + H;
    let d = dMin + x.x * (dMax - dMin);
    var mu = 1.0;
    if (d > 1.0e-4) { mu = clamp((H * H - rho * rho - d * d) / (2.0 * r * d), -1.0, 1.0); }
    let steps = 48;
    let dt = d / f32(steps);
    var od = vec3f(0.0);
    for (var i = 0; i < steps; i++) {
        let t = (f32(i) + 0.5) * dt;
        let ri = sqrt(r * r + t * t + 2.0 * r * mu * t);
        od += atmoMedium(ri - R).extinction * dt;
    }
    // Sunset depth (march3.w; 1 = physical). Scaled down to this planet, the air reddens a low sun far
    // less than Earth's (horizon optical depth ~0.6 in blue, Earth ~7), so clouds stayed pale at dusk
    // while the sky drew an orange twilight. Extra depth for a low sun only; from ~12 deg up unchanged (from 30 deg clouds turned pink at mid-afternoon).
    let k = select(1.0, u.march3.w, u.march3.w > 0.0);
    let lowSun = 1.0 - smoothstep(0.0, 0.2, mu);
    let depthScale = mix(1.0, k, lowSun);
    let transmittance = exp(-od * depthScale);
    let physical = exp(-od);
    textureStore(outLut, vec2i(id.xy), vec4f(physical, 1.0));
    // Recover most of the brightness lost to deeper dusk tint, keeping the hue. Bake
    // this once per atmosphere edit instead of applying the power curve at every lit sample.
    var cloudLight = transmittance;
    if (depthScale > 1.001) {
        let lumW = vec3f(0.2126, 0.7152, 0.0722);
        cloudLight *= pow(dot(physical, lumW) / max(dot(transmittance, lumW), 1.0e-6), 0.8);
    }
    textureStore(outCloudLight, vec2i(id.xy), vec4f(cloudLight, dot(physical, vec3f(0.2126, 0.7152, 0.0722))));
}
`;

// Average incoming radiance per unit sun illuminance, as a function of sun zenith.
export const AMBIENT_LUT_WGSL = /* wgsl */`${HEADER}
@group(0) @binding(0) var<uniform> u: CloudUniforms;
@group(0) @binding(1) var transLut: texture_2d<f32>;
@group(0) @binding(2) var lutSampler: sampler;
@group(0) @binding(3) var outLut: texture_storage_2d<rgba16float, write>;

fn skyRadiance(ro: vec3f, rd: vec3f, sunDir: vec3f) -> vec3f {
    let R = u.planet.x;
    let Rt = u.planet.w;
    let atmo = raySphere(ro, rd, Rt);
    let ground = raySphere(ro, rd, R);
    let hitGround = ground.x < ground.y && ground.x > 0.0;
    var tEnd = atmo.y;
    if (hitGround) { tEnd = ground.x; }
    let steps = 24;
    let dt = tEnd / f32(steps);
    let cosTheta = dot(rd, sunDir);
    let pr = rayleighPhase(cosTheta);
    let pm = henyeyGreenstein(cosTheta, u.atmoMie.w);
    var L = vec3f(0.0);
    var T = vec3f(1.0);
    for (var i = 0; i < steps; i++) {
        let p = ro + rd * ((f32(i) + 0.5) * dt);
        let r = length(p);
        let m = atmoMedium(r - R);
        let sunT = sunTransmittance(transLut, lutSampler, r, dot(p / r, sunDir), R, Rt);
        let S = sunT * (m.rayleigh * pr + m.mie * pm);
        let stepT = exp(-m.extinction * dt);
        L += T * (S - S * stepT) / max(m.extinction, vec3f(1.0e-7));
        T *= stepT;
    }
    if (hitGround) {
        let n = normalize(ro + rd * tEnd);
        let muS = dot(n, sunDir);
        let sunT = sunTransmittance(transLut, lutSampler, R, muS, R, Rt);
        L += T * (u.atmoExtra.y / PI) * sunT * max(muS, 0.0);
    }
    return L;
}

@compute @workgroup_size(64, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
    if (id.x >= 64u || id.y >= 3u) { return; }
    let R = u.planet.x;
    let mu = mix(AMBIENT_MU_MIN, 1.0, f32(id.x) / (AMBIENT_LUT_WIDTH - 1.0));
    let sunDir = vec3f(sqrt(max(0.0, 1.0 - mu * mu)), mu, 0.0);
    var altitude = 0.5 * (u.planet.y + u.planet.z) - R;
    if (id.y == 2u) { altitude = 0.002; }
    let ro = vec3f(0.0, R + altitude, 0.0);
    let downward = id.y == 1u;
    var sum = vec3f(0.0);
    let nTheta = 8;
    let nPhi = 16;
    for (var i = 0; i < nTheta; i++) {
        let z = (f32(i) + 0.5) / f32(nTheta);
        let s = sqrt(1.0 - z * z);
        for (var j = 0; j < nPhi; j++) {
            let phi = (f32(j) + 0.5) / f32(nPhi) * 2.0 * PI;
            var dir = vec3f(s * cos(phi), z, s * sin(phi));
            if (downward) { dir.y = -dir.y; }
            sum += skyRadiance(ro, dir, sunDir);
        }
    }
    textureStore(outLut, vec2i(id.xy), vec4f(sum / f32(nTheta * nPhi), 1.0));
}
`;

// Optical depth of the cloud layer along the sun direction, on a sun-facing plane around the camera.
export const CLOUD_SHADOW_WGSL = /* wgsl */`${HEADER}${NOISE_BINDINGS}
@group(0) @binding(5) var outShadow: texture_storage_2d<rgba16float, write>;
${CLOUD_DENSITY_WGSL}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(outShadow);
    if (id.x >= size.x || id.y >= size.y) { return; }
    let uv = (vec2f(id.xy) + 0.5) / vec2f(size) - 0.5;
    let extent = u.shadowE1.w;
    let s = u.sun.xyz;
    let origin = u.shadowE1.xyz * (u.shadowE2.w + uv.x * extent)
        + u.shadowE2.xyz * (u.shadowInfo.x + uv.y * extent)
        + cross(u.shadowE1.xyz, u.shadowE2.xyz) * u.shadowInfo.y;
    let outer = raySphere(origin, s, u.planet.z);
    var od = 0.0;
    if (outer.x < outer.y) {
        var t0 = outer.x;
        let ground = raySphere(origin, s, u.planet.x);
        if (ground.x < ground.y) { t0 = max(t0, ground.y); }
        let t1 = outer.y;
        if (t1 > t0) {
            let n = 24;
            let dt = (t1 - t0) / f32(n);
            // Half a mip blurrier than the texel: detail the map cannot hold would only alias.
            let footprint = 1.5 * extent / f32(size.x);
            for (var i = 0; i < n; i++) {
                let p = origin + s * (t0 + (f32(i) + 0.5) * dt);
                od += cloudDensity(p, footprint, false) * dt;
            }
        }
    }
    textureStore(outShadow, vec2i(id.xy), vec4f(od, 0.0, 0.0, 1.0));
}
`;

const REUSE_RAY_WGSL = /* wgsl */`
fn historyPixel(direction: vec3f, depth: f32, offset: vec3f) -> vec2f {
    let v = direction * depth + offset;
    let viewZ = -dot(v, u.prevBack.xyz);
    if (viewZ < 1.0e-4) { return vec2f(-1.0e6); }
    let ndc = vec2f(
        u.prevRight.w * dot(v, u.prevRight.xyz) - u.prevBack.w * viewZ,
        u.prevUp.w * dot(v, u.prevUp.xyz) - u.prevInfo.x * viewZ
    ) / viewZ;
    return (ndc * vec2f(0.5, -0.5) + 0.5) * u.frameInfo.zw;
}

fn reuseRay(id: vec2i, ray: CloudRay) -> bool {
    // Fresh terrain rays handle disocclusions and opaque depth changes.
    if (ray.sceneDistance < 1.0e29) { return false; }
    let depth = textureLoad(marchDepth, id, 0).x;
    if (depth <= 0.0) { return false; }
    let color = textureLoad(marchColor, id, 0);
    let offset = u.prevInfo.yzw + u.historyWind.xyz;
    let tolerance = mix(0.10, 0.24, clamp((0.3 - color.a) / 0.25, 0.0, 1.0));
    var testDepth = depth;
    if (depth >= FAR_DEPTH * 0.5) {
        testDepth = u.historyMotion.y;
    }
    let nearMotion = length(historyPixel(ray.direction, testDepth, offset) - ray.pixel);
    let farMotion = length(historyPixel(ray.direction, FAR_DEPTH, vec3f(0.0)) - ray.pixel);
    let fieldMotion = u.historyWind.w * u.prevUp.w * (u.frameInfo.w * 0.5) / testDepth;
    if (max(nearMotion, farMotion) + fieldMotion > tolerance) { return false; }
    // Keep the same raw sample when it maps back within a fraction of a pixel.
    // No re-filtering, and this half of the grid is always refreshed next frame.
    textureStore(outColor, id, color);
    textureStore(outDepth, id, vec4f(depth, 0.0, 0.0, 0.0));
    return true;
}
`;

const WEATHER_CACHE_WGSL = /* wgsl */`
@group(0) @binding(11) var cachedWeather: texture_2d<f32>;
@group(0) @binding(12) var cachedShift: texture_2d<f32>;

fn rayWeather(p: vec3f, footprint: f32) -> Weather {
    let firstMip = 1.0 / (2.0 * WEATHER_TEXELS * max(u.scales.z, max(u.scales.w, u.systems.x)));
    if (footprint > firstMip) { return sampleWeather(p, footprint); }
    let plane = cachePlane(p);
    let uv = (plane.xy - u.cacheGrid.xy) / u.cacheGrid.z + 0.5;
    let weight = cacheWeight(plane, uv) * (1.0 - smoothstep(0.85, 1.0, footprint / firstMip));
    if (weight <= 0.0) { return sampleWeather(p, footprint); }
    let data = textureSampleLevel(cachedWeather, lutSampler, uv, 0.0);
    let shift = textureSampleLevel(cachedShift, lutSampler, uv, 0.0).xyz;
    var weather = Weather(data.x, data.y, data.z, data.w, shift);
    if (weight < 1.0) {
        let live = sampleWeather(p, footprint);
        weather.coverage = mix(live.coverage, weather.coverage, weight);
        weather.kind = mix(live.kind, weather.kind, weight);
        weather.lift = mix(live.lift, weather.lift, weight);
        weather.stretch = mix(live.stretch, weather.stretch, weight);
        weather.shift = mix(live.shift, weather.shift, weight);
    }
    return weather;
}
`;

const LIGHT_CACHE_WGSL = /* wgsl */`
@group(0) @binding(11) var cachedLight: texture_3d<f32>;

fn lightOpticalDepth(p: vec3f, footprint: f32, weather: Weather, dir: vec3f, sun: bool) -> f32 {
    let end = i32(u.quality.w);
    let h = heightFraction(length(p));
    let firstMip = 1.0 / (2.0 * WEATHER_TEXELS * max(u.scales.z, max(u.scales.w, u.systems.x)));
    let maxFootprint = min(u.march2.x * exp2(f32(LIVE_SUN_PROBES - 1)), firstMip);
    var weight = 0.0;
    var far = 0.0;
    if (sun && end > LIVE_SUN_PROBES && h >= 0.0 && h <= 1.0 && footprint <= maxFootprint) {
        let plane = cachePlane(p);
        let uv = (plane.xy - u.cacheGrid.xy) / u.cacheGrid.w + 0.5;
        weight = cacheWeight(plane, uv);
        // Fade out at the boundary of the footprint range as well as the spatial patch.
        weight *= 1.0 - smoothstep(0.85, 1.0, footprint / maxFootprint);
        if (weight > 0.0) { far = textureSampleLevel(cachedLight, lutSampler, vec3f(uv, h), 0.0).x * weight; }
    }
    return probeLight(p, footprint, weather, dir, 0, select(end, LIVE_SUN_PROBES, weight >= 1.0), 1.0 - weight) + far;
}
`;

function cloudRaymarchShader({ blendProxy = false, reuse = false, cache = '', budgetStage = '' } = {}) {
    return /* wgsl */`${HEADER}${NOISE_BINDINGS}
@group(0) @binding(5) var cloudLightLut: texture_2d<f32>;
@group(0) @binding(6) var ambientLut: texture_2d<f32>;
@group(0) @binding(7) var lutSampler: sampler;
@group(0) @binding(8) var outColor: texture_storage_2d<${budgetStage === 'near' ? 'rgba32float' : 'rgba16float'}, write>;
@group(0) @binding(9) var outDepth: texture_storage_2d<${budgetStage === 'near' ? 'rg32float' : 'r32float'}, write>;
@group(0) @binding(10) var sceneDepth: texture_depth_2d;
${blendProxy || reuse ? /* wgsl */`
@group(0) @binding(11) var marchColor: texture_2d<f32>;
@group(0) @binding(12) var marchDepth: texture_2d<f32>;
` : ''}
${budgetStage === 'finish' ? /* wgsl */`
@group(0) @binding(11) var nearColor: texture_2d<f32>;
@group(0) @binding(12) var nearRay: texture_2d<f32>;
` : ''}
${CLOUD_DENSITY_WGSL}${CLOUD_RAY_INPUT_WGSL}${CLOUD_LAYER_BLEND_WGSL}
${reuse ? REUSE_RAY_WGSL : ''}
${CLOUD_LIGHT_PROBES}${cache ? CLOUD_CACHE_COORDS : ''}
${cache === 'weather' ? WEATHER_CACHE_WGSL : /* wgsl */`
fn rayWeather(p: vec3f, footprint: f32) -> Weather { return sampleWeather(p, footprint); }
`}
${cache === 'light' ? LIGHT_CACHE_WGSL : /* wgsl */`
fn lightOpticalDepth(p: vec3f, footprint: f32, weather: Weather, dir: vec3f, sun: bool) -> f32 {
    return probeLight(p, footprint, weather, dir, 0, i32(u.quality.w), 1.0);
}
`}

fn cloudPhase(cosTheta: f32, scale: f32) -> f32 {
    let forward = henyeyGreenstein(cosTheta, u.phase.x * scale);
    let back = henyeyGreenstein(cosTheta, u.phase.y * scale);
    return mix(forward, back, u.phase.z);
}

override CACHE_SCATTERING_PHASE: bool = false;
override INTERPOLATE_SHARED_LIGHT: bool = false;

struct RayScattering {
    sunCosine: f32,
    sunPowder: f32,
    sunWeights: vec4f,
    moonWeights: vec4f,
}

fn scatteringWeights(cosine: f32) -> vec4f {
    var weights: vec4f;
    var scattering = 1.0;
    var phase = 1.0;
    for (var k = 0; k < 4; k++) {
        weights[k] = scattering * cloudPhase(cosine, phase);
        scattering *= u.light.z;
        phase *= u.light.w;
    }
    return weights;
}

fn rayScattering(rd: vec3f) -> RayScattering {
    var phase: RayScattering;
    phase.sunCosine = dot(rd, u.sun.xyz);
    phase.sunPowder = u.phase.w * saturate(0.6 - 0.6 * phase.sunCosine);
    if (CACHE_SCATTERING_PHASE) {
        phase.sunWeights = scatteringWeights(phase.sunCosine);
        if (u.moon.w > 0.0) { phase.moonWeights = scatteringWeights(dot(rd, u.moon.xyz)); }
    }
    return phase;
}

// Fraction of sky light reaching p: base density 0.25 and 0.8 km straight up, and 0.35 km out in three
// directions 120 deg apart, 30 deg up. The sideways samples darken folds between cloud heads, which are
// surrounded by cloud on the sides too (sampling only upward lit grooves like bulges: flat-looking cumulus).
// The directions are fixed in the local world frame, so the darkening does not crawl as the view turns.
fn skyVisibility(p: vec3f, weather: Weather, footprint: f32) -> f32 {
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

// Weight (0..1) of a sample's switch from individual clouds to their average density. Far away and
// at grazing angles, adjacent pixels' rays cross the thin layer kilometres apart (the pixel's
// footprint along the layer grows as 1 / sin of the grazing angle), so each pixel hits a different
// sub-pixel cloud and any camera move changes which one: the far band flickered when climbing.
// Steps each march segment keeps in reserve to reach the end of the layer (see the march loop).
const MARCH_TAIL_STEPS: i32 = 6;

fn farAverageWeight(p: vec3f, rd: vec3f, footprint: f32) -> f32 {
    if (u.extra.z <= 0.0) { return 0.0; }
    let graze = max(abs(dot(rd, normalize(p))), 0.06);
    return smoothstep(u.extra.y, u.extra.z, footprint / graze);
}

// Expected density at height fraction h for this weather: the fraction of the shape field above
// the coverage threshold (about coverage²) times the mean of the remapped values above it, with
// the height profile, density scale and a share for detail erosion.
fn meanCloudDensity(weather: Weather, h: f32) -> f32 {
    if (h <= 0.0 || h >= 1.0 || weather.coverage <= 0.001) { return 0.0; }
    let profile = heightProfile((h - weather.lift) / (1.0 - weather.lift), weather.kind, weather.coverage);
    let c = saturate(weather.coverage * profile * 1.4);
    let dh = deckHeight(h, weather);
    let deck = smoothstep(0.0, 0.21, dh) * (1.0 - smoothstep(0.42, 0.87, dh));
    return 0.5 * c * c * mix(0.6, 1.0, weather.coverage) * u.extra.w
        + deck * u.weatherStyle.y * weather.coverage * 0.11;
}

fn distantBankWeight(t: f32, cameraRadius: f32) -> f32 {
    let inside = (cameraRadius - u.planet.y) / (u.planet.z - u.planet.y);
    return u.banks.x * (1.0 - u.weatherStyle.y) * smoothstep(u.banks.y, u.banks.z, t)
        * (1.0 - smoothstep(0.0, 0.45, inside));
}

// The detailed layer loses its small puffs over distance. Filter broader masses in
// planet-relative space so the replacement retains clear gaps at grazing angles.
fn distantBankDensity(p: vec3f, h: f32, weather: Weather, footprint: f32) -> f32 {
    let localH = (h - weather.lift) / (1.0 - weather.lift);
    if (localH <= 0.0 || localH >= 0.52) { return 0.0; }
    let surface = normalize(p) * u.planet.y;
    let advected = mix(surface, p, 0.55) + u.windShape.xyz;
    let q = (ROT_LARGE * advected) * (vec3f(0.58, 1.0, 1.0) * u.banks.w) + weather.shift * 0.37;
    let lod = max(0.0, log2(footprint * u.banks.w * SHAPE_TEXELS));
    let n = textureSampleLevel(shapeTex, noiseSampler, q, lod);
    let coverage = smoothstep(0.02, 0.26, weather.coverage);
    let billows = shapeSignal(n) + 0.17 * (n.b - 0.65);
    let core = smoothstep(mix(0.92, 0.66, coverage), mix(1.16, 0.93, coverage), billows);
    let top = 0.11 + 0.32 * core * mix(0.55, 1.0, weather.kind);
    let profile = smoothstep(0.0, 0.04, localH) * (1.0 - smoothstep(top * 0.65, top, localH));
    return core * core * profile * coverage * 0.085;
}

// Radius at which a cloud's sunlight colour is read (look.w; 1 = physical). The air thins out within a
// few km on a small planet (scale height ~2.6 km), so clouds at 6-12 km sit above almost all of it and
// a low sun stayed white on them; read lower, they redden at dusk as Earth's clouds do.
fn cloudLightR(r: f32) -> f32 {
    return u.planet.x + (r - u.planet.x) * select(1.0, u.look.w, u.look.w > 0.0);
}

// Use a common hue through the local twilight sky. On a 131 km planet the
// zenith direction can rotate tens of degrees across one view. Actual planet
// occlusion still uses the height and sun angle of each sample.
fn cloudSunHueAngle(mu: f32, cameraSun: f32, cameraRadius: f32) -> f32 {
    let twilight = 1.0 - smoothstep(0.14, 0.38, abs(cameraSun));
    let high = smoothstep(u.planet.y + 1.0, u.planet.z, cameraRadius);
    return mix(mu, cameraSun, u.look4.x * 0.77 * twilight * (1.0 - high));
}

// Sunlight reaching a cloud at radius r for sun zenith cosine mu, including the planet's penumbra.
fn cloudLightTransmittance(r: f32, mu: f32, hueAngle: f32, solar: bool) -> vec3f {
    let R = u.planet.x;
    let Rt = u.planet.w;
    let rc = clamp(cloudLightR(r), R, Rt);
    // Changing the optical depth for a hue also moved the old cloud shadow
    // boundary. The planet only blocks a light according to the true height.
    let sinHorizon = R / clamp(r, R, Rt);
    let muHorizon = -sqrt(max(0.0, 1.0 - sinHorizon * sinHorizon));
    let visibility = smoothstep(-u.atmoExtra.z, u.atmoExtra.z, mu - muHorizon);
    if (visibility <= 0.0) { return vec3f(0.0); }
    let sampleR = select(clamp(r, R, Rt), rc, solar);
    let light = textureSampleLevel(cloudLightLut, lutSampler, transmittanceUv(sampleR, mu, R, Rt), 0.0);
    if (!solar) { return vec3f(light.a) * visibility; }
    let sunset = 1.0 - smoothstep(0.035, 0.29, hueAngle);
    let peach = mix(vec3f(1.0, 0.34, 0.14), vec3f(1.0, 0.84, 0.61), smoothstep(-0.025, 0.29, hueAngle));
    let warm = peach * mix(0.66, 1.10, smoothstep(-0.28, 0.09, hueAngle));
    return mix(light.rgb, warm, u.look4.x * sunset) * visibility;
}

fn daylightSunGain(mu: f32, cosTheta: f32) -> vec3f {
    // The forward phase already gives backlit edges a strong silver lining.
    let gain = (u.look5.w - 1.0) * smoothstep(-0.1, 0.35, mu)
        * (1.0 - 0.55 * smoothstep(0.7, 0.98, cosTheta));
    let sunset = smoothstep(-0.26, 0.0, mu) * (1.0 - smoothstep(0.06, 0.34, mu));
    return vec3f(1.0 + u.look4.x * 0.82 * sunset) + gain * vec3f(1.14, 1.0, 0.83);
}

// Broad sky fill restores the blue light missing in the thin atmosphere. The existing
// occlusion still gives creases and bases their depth. Moonlight uses its own fill.
fn daylightSkyFill(mu: f32, skyVis: f32, skyMix: f32) -> vec3f {
    let day = mix(smoothstep(-0.17, 0.16, mu), smoothstep(-0.11, 0.23, mu), u.look4.x);
    let blue = mix(vec3f(0.57, 0.70, 1.0), vec3f(0.76, 0.87, 1.0), smoothstep(0.0, 0.55, mu));
    return blue * (u.look5.z * u.sun.w * day * skyVis * mix(0.45, 1.0, skyMix));
}

fn twilightSkyFill(mu: f32, hueAngle: f32, skyVis: f32) -> vec3f {
    let duskW = (1.0 - smoothstep(0.025, 0.30, hueAngle)) * smoothstep(-0.29, -0.06, hueAngle);
    let localDaylight = mix(0.25, 1.0, smoothstep(-0.42, -0.15, mu));
    let fill = vec3f(0.36, 0.45, 0.63) * mix(0.27, 1.0, skyVis);
    return fill * (duskW * localDaylight * u.look2.z * 0.065 * u.sun.w);
}

fn rainCloudRadiance(light: vec3f, localH: f32, sunAngle: f32) -> vec3f {
    let rain = u.weatherStyle.z;
    let underside = 1.0 - smoothstep(0.12, 0.82, localH);
    let contrast = 1.0 - rain * mix(0.12, 0.52, underside);
    // The darker base is usually lit by the cool diffuse sky. A low sun and
    // moonlight have their own colours, so the cool bias recedes at night.
    let cool = rain * underside * smoothstep(-0.06, 0.37, sunAngle);
    return light * contrast * mix(vec3f(1.0), vec3f(0.83, 0.93, 1.0), cool);
}

// Horizon Zero Dawn's in-scattering probability (Schneider, Nubis 2017): light scattered toward the
// eye is less likely where the cloud is thin, increasingly so toward its top (exponent 0.5 -> 2), and
// near its base. Darkens the grooves between billows and the undersides: the HZD cumulus look.
// localH is the height within this cloud (0 base, 1 top), density normalised to 0..1.
fn inScatterProbability(localH: f32, density: f32) -> f32 {
    let depthP = 0.05 + pow(saturate(density), remapSat(localH, 0.3, 0.85, 0.5, 2.0));
    let vertP = pow(remapSat(localH, 0.07, 0.14, 0.1, 1.0), 0.8);
    return depthP * vertP;
}

// Light from one direction (sun or moon) reaching p: light march plus Wrenninge-style
// multiple-scattering octaves and the powder term.
fn directLight(p: vec3f, footprint: f32, weather: Weather, dir: vec3f, lightT: vec3f, cosTheta: f32,
               sigmaT: f32, powderWeight: f32, weights: vec4f, sun: bool) -> vec3f {
    let od = lightOpticalDepth(p, footprint, weather, dir, sun) * u.density.x;
    var a = 1.0;
    var b = 1.0;
    var c = 1.0;
    var ms = 0.0;
    for (var k = 0; k < 4; k++) {
        var weight = weights[k];
        if (!CACHE_SCATTERING_PHASE) { weight = b * cloudPhase(cosTheta, c); }
        ms += weight * exp(-od * a);
        a *= u.light.y;
        b *= u.light.z;
        c *= u.light.w;
    }
    let powder = 1.0 - exp(-sigmaT * 0.12);
    return lightT * ms * mix(1.0, powder, powderWeight);
}

// Light scattered toward the camera per unit length at p (sun, moon, sky and ground light), shared
// by the march and the near-ground proxy so both light clouds identically.
fn cloudSource(p: vec3f, rd: vec3f, footprint: f32, weather: Weather, base: CloudBase, density: f32,
               phase: RayScattering, cameraRadius: f32, cameraSun: f32) -> vec3f {
    let r = length(p);
    let muS = dot(p / r, u.sun.xyz);
    let sigmaT = density * u.density.x;
    let sigmaS = sigmaT * u.density.w;
    let hueAngle = cloudSunHueAngle(muS, cameraSun, cameraRadius);
    let sunT = cloudLightTransmittance(r, muS, hueAngle, true) * u.sun.w;
    let sunMax = max(sunT.r, max(sunT.g, sunT.b));
    var sunL = vec3f(0.0);
    if (sunMax > 1.0e-5) {
        sunL = directLight(p, footprint, weather, u.sun.xyz,
            sunT * daylightSunGain(hueAngle, phase.sunCosine), phase.sunCosine, sigmaT, phase.sunPowder, phase.sunWeights, true);
    }
    let skyAmb = textureSampleLevel(ambientLut, lutSampler, ambientUv(muS, 0.0), 0.0).rgb;
    let groundAmb = textureSampleLevel(ambientLut, lutSampler, ambientUv(muS, 1.0), 0.0).rgb;
    // In-scattering probability (u.look.x strength, 0 = off) for the sun and moon terms.
    // Gain (look.z): the probability is well below 1 over most of a cloud's visible skin; HZD lit
    // its clouds with a correspondingly brighter sun.
    var inScatter = 1.0;
    if (u.look.x > 0.0) {
        let probe = inScatterProbability(base.localH, density / mix(0.6, 1.0, weather.coverage));
        inScatter = mix(1.0, probe * u.look.z, u.look.x);
    }
    // Sky versus ground-bounce ambient by height: in the layer (h), or within the cloud with HZD
    // lighting (bases lit mostly by the ground, tops by the sky).
    let skyMix = saturate(0.25 + mix(base.h, base.localH * 0.75, u.look.x));
    // Sky light is blocked by the cloud above: two cheap upward samples darken crevices,
    // undersides and the insides of towers, so cloud relief shows even without direct light
    // (at night with the moon down the clouds otherwise looked like flat sheets).
    let skyVis = skyVisibility(p, weather, footprint);
    var amb = mix(groundAmb, skyAmb * skyVis, skyMix) * (u.sun.w * u.light.x)
        + u.ambientFloor.rgb * skyVis + daylightSkyFill(hueAngle, skyVis, skyMix);
    // Dusk sky light (look2.z): with the sun low, the direct light is red and dim while the whole sky
    // still lights the shaded sides blue-lavender. This planet's thin air gives almost no sky light
    // (the ambient LUT is small even by day; cloud shading comes from light scattered inside them), so
    // at dusk the red inner light alone made shadows muddy brown or black. Adds a twilight-sky fill in
    // units of the sun's illuminance, peaking around sunset and gone by ~7 deg below the horizon.
    amb += twilightSkyFill(muS, hueAngle, skyVis);
    // Moonlight: a second directional light with its own light march and moonlit sky,
    // evaluated only while the sun is dim (no extra cost by day). Without it, night clouds
    // only had a uniform fill and read as flat grey from above.
    if (u.moon.w > 0.0) {
        let muM = dot(p / r, u.moon.xyz);
        let moonT = cloudLightTransmittance(r, muM, muM, false) * u.moon.w;
        let moonMax = max(moonT.r, max(moonT.g, moonT.b));
        if (moonMax > 1.0e-5 && sunMax < moonMax * 20.0) {
            let cosM = dot(rd, u.moon.xyz);
            let powderM = u.phase.w * saturate(0.6 - 0.6 * cosM);
            sunL += directLight(p, footprint, weather, u.moon.xyz, moonT, cosM, sigmaT, powderM, phase.moonWeights, false);
            let skyAmbM = textureSampleLevel(ambientLut, lutSampler, ambientUv(muM, 0.0), 0.0).rgb;
            let groundAmbM = textureSampleLevel(ambientLut, lutSampler, ambientUv(muM, 1.0), 0.0).rgb;
            amb += mix(groundAmbM, skyAmbM * skyVis, skyMix) * (u.moon.w * u.light.x);
        }
    }
    let S = rainCloudRadiance(sunL * inScatter + amb, base.localH, hueAngle) * sigmaS;
    return S;
}

// One sun-facing probe lights the shadows in the two broader cloud fields.
// Return radiance per unit extinction, matching the detailed march integrator.
fn backdropLight(p: vec3f, weather: Weather, footprint: f32, cosTheta: f32,
                 cameraRadius: f32, cameraSun: f32, shares: vec2f) -> vec3f {
    let r = length(p);
    let up = p / r;
    let muS = dot(up, u.sun.xyz);
    let hue = cloudSunHueAngle(muS, cameraSun, cameraRadius);
    let sunT = cloudLightTransmittance(r, muS, hue, true) * u.sun.w;
    let q = p + u.sun.xyz * 1.1;
    let probeRadius = length(q);
    var od = 0.0;
    if (shares.x > 0.001) { od += 18.0 * distantBankDensity(q, heightFraction(probeRadius), weather, footprint); }
    if (shares.y > 0.001) {
        let near = p + u.sun.xyz * 0.38;
        od += 16.0 * altoDensity(near, length(near), weather, footprint)
            + 12.0 * altoDensity(q, probeRadius, weather, footprint);
    }
    let shade = exp(-od);
    let rim = clamp(cloudPhase(cosTheta, 1.0), 0.03, 0.4);
    let daylight = daylightSkyFill(hue, shade, 0.6);
    let twilight = twilightSkyFill(muS, hue, shade);
    var moon = vec3f(0.0);
    if (u.moon.w > 0.0) {
        let muM = dot(up, u.moon.xyz);
        moon = cloudLightTransmittance(r, muM, muM, false) * (u.moon.w * 0.06);
    }
    let light = sunT * (0.037 + 0.52 * rim) * shade + daylight + twilight + moon + u.ambientFloor.rgb;
    return rainCloudRadiance(light, heightFraction(r), hue) * u.density.w;
}



fn clearWeather() -> bool {
    return u.weatherStyle.x <= 0.001 || (u.coverage.x <= 0.001 && u.coverage.y == 0.0 && u.weatherStyle.y <= 0.001);
}

// Integral of 1/step for a step that grows with distance and is clamped to [minimum, cap].
fn stepCountAt(t: f32, minimum: f32, cap: f32, growth: f32) -> f32 {
    let nearEnd = minimum / growth;
    let farStart = cap / growth;
    return min(t, nearEnd) / minimum
        + log(max(1.0, min(t, farStart) / nearEnd)) / growth
        + max(0.0, t - farStart) / cap;
}

struct ViewDensity {
    weather: Weather,
    base: CloudBase,
    density: f32,
    backdropShare: vec2f, // stratocumulus, altocumulus
}

// Relative optical densities of the main field and the two broader cloud fields.
fn layerDensities(p: vec3f, r: f32, weather: Weather, footprint: f32, bankW: f32, detailed: f32) -> vec3f {
    var bank = 0.0;
    if (bankW > 0.001) { bank = distantBankDensity(p, heightFraction(r), weather, footprint) * bankW; }
    return vec3f(detailed * (1.0 - bankW), bank, altoDensity(p, r, weather, footprint));
}

fn viewDensity(p: vec3f, rd: vec3f, t: f32, footprint: f32, farStep: f32, tail: bool, T: f32,
               cameraRadius: f32) -> ViewDensity {
    var sample: ViewDensity;
    sample.weather = rayWeather(p, footprint);
    let r = length(p);
    let h = heightFraction(r);
    sample.base.h = h;
    if (sample.weather.coverage <= 0.001) { return sample; }
    let bankW = distantBankWeight(t, cameraRadius);
    var detailed = 0.0;
    if (bankW < 0.999) {
        let farW = select(farAverageWeight(p, rd, max(t * u.march2.y, farStep * 0.35)), 1.0, tail);
        var mean = 0.0;
        if (farW > 0.001) { mean = meanCloudDensity(sample.weather, h); }
        if (farW < 0.999 || u.look.x > 0.0) {
            sample.base = cloudBaseWithWeather(p, h, sample.weather, footprint);
        }
        if (sample.base.density > 0.0 && farW < 0.999) {
            let detailFp = max(footprint, t * u.march2.y * u.look3.y);
            detailed = sample.base.density;
            if (T > u.look4.y) { detailed = cloudDetail(p, sample.base, detailFp); }
        }
        detailed = mix(detailed, mean, farW);
    }
    let layers = layerDensities(p, r, sample.weather, footprint, bankW, detailed);
    sample.density = layers.x + layers.y + layers.z;
    sample.backdropShare = layers.yz / max(sample.density, 1.0e-6);
    return sample;
}

fn viewCloudLight(sample: ViewDensity, p: vec3f, rd: vec3f, footprint: f32, phase: RayScattering,
                  cameraRadius: f32, cameraSun: f32) -> vec3f {
    let backdrop = sample.backdropShare.x + sample.backdropShare.y;
    let detailed = 1.0 - backdrop;
    var light = vec3f(0.0);
    if (detailed > 0.001) {
        let density = sample.density * detailed;
        light = cloudSource(p, rd, footprint, sample.weather, sample.base, density,
            phase, cameraRadius, cameraSun) / max(density * u.density.x, 1.0e-5) * detailed;
    }
    if (backdrop > 0.001) {
        light += backdropLight(p, sample.weather, footprint, phase.sunCosine, cameraRadius, cameraSun, sample.backdropShare) * backdrop;
    }
    return light;
}

fn march(ro: vec3f, rd: vec3f, tScene: f32) -> MarchResult {
    var res: MarchResult;
    res.color = vec4f(0.0, 0.0, 0.0, 1.0);
    res.depth = FAR_DEPTH;

    let outer = raySphere(ro, rd, u.planet.z);
    if (outer.x > outer.y || outer.y <= 0.0) { return res; }
    let inner = raySphere(ro, rd, u.planet.y);
    let ground = raySphere(ro, rd, u.planet.x);
    var tGround = tScene;
    if (ground.x < ground.y && ground.y > 0.0) { tGround = min(tGround, max(ground.x, 0.0)); }

    // The shell can be crossed twice by a ray grazing the cloud base.
    var segs: array<vec2f, 2>;
    var segCount = 0;
    let s0 = max(outer.x, 0.0);
    let s1 = min(outer.y, tGround);
    if (inner.x < inner.y && inner.y > 0.0) {
        let a = vec2f(s0, min(s1, inner.x));
        if (a.y > a.x) { segs[segCount] = a; segCount++; }
        let b = vec2f(max(s0, inner.y), s1);
        if (b.y > b.x) { segs[segCount] = b; segCount++; }
    } else if (s1 > s0) {
        segs[0] = vec2f(s0, s1);
        segCount = 1;
    }

    // Rays without cloud report the layer or opaque surface depth for reprojection.
    if (tGround < 1.0e29) { res.depth = tGround; }
    if (segCount > 0) {
        let first = segs[0];
        res.depth = first.x + min(0.5 * (first.y - first.x), u.planet.z - u.planet.y);
    } else if (u.march2.w < 0.5) {
        return res;
    }
    if (clearWeather() && u.march2.w < 0.5) { return res; }

    let phase = rayScattering(rd);
    let cameraRadius = length(ro);
    let cameraSun = dot(ro / cameraRadius, u.sun.xyz);
    let maxSteps = i32(u.march.x);
    // Fit a shared spacing to both visible legs. Their total length is
    // continuous at the base tangent, where the clear gap shrinks to zero.
    // The foreground leg then leaves enough samples for the distant layer.
    var cloudPath = segs[0].y - segs[0].x;
    if (segCount == 2) { cloudPath += segs[1].y - segs[1].x; }
    let minimum = u.march.y;
    let maxStep = max(u.march.w, cloudPath / max(u.march.x * 0.5, 1.0));
    var cap = maxStep;
    if (u.shadowInfo.w > 0.0) { cap = min(cap, cloudPath / (u.march.x * u.shadowInfo.w)); }
    cap = max(minimum, cap);
    let growth = max(u.march.z, 1.0e-5);
    var estimate = stepCountAt(segs[0].y, minimum, cap, growth) - stepCountAt(segs[0].x, minimum, cap, growth);
    if (segCount == 2) {
        estimate += stepCountAt(segs[1].y, minimum, cap, growth) - stepCountAt(segs[1].x, minimum, cap, growth);
    }
    let stride = max(1.0, estimate / f32(max(maxSteps - MARCH_TAIL_STEPS, 1)));
    var T = 1.0;
    var L = vec3f(0.0);
    var depthSum = 0.0;
    var weightSum = 0.0;
    var steps = 0;
    // Light sharing (march3.x): light per unit extinction, computed fresh at the first cloud sample
    // after clear air and then every lightReuse-th sample, reused in between. The visible skin is
    // always lit fresh; deeper samples sit behind it.
    let lightReuse = max(i32(u.march3.x), 1);
    let cutoff = 0.01;
    var J = vec3f(0.0);
    var lightAge = 0;   // cloud samples since J was computed; 0 forces a fresh one
    var lightT = 0.0;   // where along the ray J was computed
    var lightMoment = 0.0;
    for (var si = 0; si < segCount; si++) {
        let seg = segs[si];
        let segLimit = maxSteps - (segCount - 1 - si) * MARCH_TAIL_STEPS;
        // Anchor the intervals at each visible entry. Adaptive refinement
        // leaves the subsequent interval positions fixed.
        var t = seg.x;
        let firstStep = min(clamp(t * growth, minimum, maxStep), cap) * stride;
        let firstFp = max(t * u.march2.y, firstStep * u.ambientFloor.w * 0.75);
        let p0 = ro + rd * t;
        let front = viewDensity(p0, rd, t, firstFp, firstStep, false, T, cameraRadius);
        var previousDensity = front.density;
        var previousBase = front.base.density;
        var previousLight = vec3f(0.0);
        if (previousDensity > 0.0) {
            previousLight = viewCloudLight(front, p0, rd, firstFp, phase, cameraRadius, cameraSun);
        }
        lightAge = 0;
        lightMoment = 0.0;
        loop {
            if (t >= seg.y || steps >= segLimit || T < cutoff) { break; }
            steps++;
            let tail = steps > segLimit - MARCH_TAIL_STEPS;
            let stepWidth = clamp(t * growth, minimum, cap) * stride;
            let cellEnd = min(t + max(stepWidth, 1.0e-4), seg.y);
            let end = select(cellEnd, t + (seg.y - t) / f32(segLimit - steps + 1), tail);
            let dt = end - t;
            let footprint = max(end * u.march2.y, max(stepWidth, dt) * u.ambientFloor.w * 0.75);
            let bound = viewDensity(ro + rd * end, rd, end, footprint,
                clamp(end * growth, minimum, maxStep), tail, T, cameraRadius);
            // Resolve the lit skin inside its coarse interval. Refinement never changes the
            // next interval's position, even when a small wisp enters or leaves the view.
            let subdivisions = select(1, 4, !tail && T > 0.06 && previousBase + bound.base.density > 0.0);
            let subDt = dt / f32(subdivisions);
            for (var substep = 1; substep <= subdivisions; substep++) {
                if (T < cutoff) { break; }
                let sampleT = mix(t, end, f32(substep) / f32(subdivisions));
                let p = ro + rd * sampleT;
                var current = bound;
                if (substep < subdivisions) {
                    current = viewDensity(p, rd, sampleT, footprint,
                        clamp(sampleT * growth, minimum, maxStep), tail, T, cameraRadius);
                }
                let density = current.density;
                let densitySum = previousDensity + density;
                if (densitySum > 0.0) {
                    let shareBack = density / densitySum;
                    let stepT = exp(-densitySum * (0.5 * u.density.x * subDt));
                    let w = T * (1.0 - stepT);
                    var light = previousLight;
                    if (density > 0.0) {
                        // Share lighting only behind the visible skin. The endpoints of a
                        // visible interval each contribute in proportion to their density.
                        if (lightAge == 0 || lightAge >= lightReuse || sampleT - lightT > u.march3.y || T > u.march4.x) {
                            let nextLight = viewCloudLight(current, p, rd, footprint, phase, cameraRadius, cameraSun);
                            if (INTERPOLATE_SHARED_LIGHT && lightAge > 1) {
                                // The earlier samples used a constant source. Once the next
                                // source is available, correct their weighted sum to the line
                                // between the two sources. Density and opacity stay per sample.
                                let span = sampleT - lightT;
                                let frontMoment = max(span - subDt, 0.0) * w * (1.0 - shareBack);
                                L += (nextLight - J) * ((lightMoment + frontMoment) / max(span, 1.0e-5));
                            }
                            J = nextLight;
                            lightAge = 0;
                            lightT = sampleT;
                            lightMoment = 0.0;
                        } else if (INTERPOLATE_SHARED_LIGHT) {
                            let span = sampleT - lightT;
                            lightMoment += mix(max(span - subDt, 0.0), span, shareBack) * w;
                        }
                        lightAge++;
                        light = J;
                    }
                    L += mix(previousLight, light, shareBack) * w;
                    depthSum += (sampleT - subDt * ((2.0 - shareBack) / 3.0)) * w;
                    weightSum += w;
                    T *= stepT;
                    previousLight = light;
                }
                if (density <= 0.0) {
                    lightAge = 0;
                    previousLight = vec3f(0.0);
                }
                previousDensity = density;
            }
            previousBase = bound.base.density;
            t = end;
        }
    }

    res.color = vec4f(L, T);
    if (weightSum > 1.0e-4) { res.depth = depthSum / weightSum; }
    if (u.march2.w > 0.5) {
        let k = f32(steps) / max(u.march.x, 1.0);
        res.color = vec4f(k, 1.0 - abs(k * 2.0 - 1.0), 1.0 - k, 0.0) * 0.5;
    }
    return res;
}

// Far LOD, for a camera well above the layer, where the layer is thin next to the viewing distance.
// The path through the shell is cut into PROXY_SLABS slabs, each sampled once (stratified jitter,
// averaged by the temporal pass like the march), with one weather lookup per pixel. Sunlight has no
// light march: each slab is a horizontal layer lit through the column above it, integrated
// analytically so the bright sunlit skin survives the long slab, plus one density sample towards
// the sun so clouds keep a lit and a shaded side.
const PROXY_SLABS: i32 = 8;
// Below the clouds, use short ray intervals with several density samples per
// lighting evaluation. A fixed number of spherical slices produced horizontal ribs.
const GROUND_INTERVALS: i32 = 32;
const PROXY_SUBSAMPLES: i32 = 4;
const PROXY_SUN_KM: f32 = 0.7;

fn proxyLayer(ro: vec3f, rd: vec3f, tScene: f32) -> MarchResult {
    var res: MarchResult;
    res.color = vec4f(0.0, 0.0, 0.0, 1.0);
    res.depth = FAR_DEPTH;
    let outer = raySphere(ro, rd, u.planet.z);
    if (outer.x > outer.y || outer.y <= 0.0) { return res; }
    let inner = raySphere(ro, rd, u.planet.y);
    var t0 = max(outer.x, 0.0);
    // From below the layer, the path through it starts where the ray leaves the base sphere.
    if (dot(ro, ro) < u.planet.y * u.planet.y) { t0 = max(t0, inner.y); }
    var t1 = outer.y;
    if (inner.x < inner.y && inner.x > t0) { t1 = inner.x; }
    t1 = min(t1, tScene);
    if (t1 <= t0) {
        res.depth = tScene;
        return res;
    }
    res.depth = t0 + min(0.5 * (t1 - t0), u.planet.z - u.planet.y);
    if (u.march2.w > 0.5) {
        res.color = vec4f(0.45, 0.0, 0.45, 0.0);
        return res;
    }
    if (clearWeather()) { return res; }

    let cameraRadius = length(ro);
    let cameraSun = dot(ro / cameraRadius, u.sun.xyz);
    // From below the layer, anchor intervals at the ray's entry into the cloud
    // volume and use the main march's lighting. The interval lengths vary
    // continuously with the camera. At the horizon that avoids the long jumps
    // between adjacent samples of a fixed-height slice.
    if (dot(ro, ro) < u.planet.y * u.planet.y) {
        // Stop at the planet as well as the scene depth (water does not write depth): rays that
        // pointed down otherwise passed through the planet and showed the layer on the far side.
        var tEnd = t1;
        let ground = raySphere(ro, rd, u.planet.x);
        if (ground.x < ground.y && ground.y > 0.0) { tEnd = min(tEnd, max(ground.x, 0.0)); }
        let phase = rayScattering(rd);
        let interval = max(tEnd - t0, 0.0) / f32(GROUND_INTERVALS);
        if (interval <= 0.0) { return res; }
        let sub = interval / f32(PROXY_SUBSAMPLES);
        var T = 1.0;
        var L = vec3f(0.0);
        var depthSum = 0.0;
        var weightSum = 0.0;
        for (var k = 0; k < GROUND_INTERVALS; k++) {
            if (T < 0.003) { break; }
            let a = t0 + f32(k) * interval;
            let t = a + 0.5 * interval;
            let footprint = max(t * u.march2.y, sub * 0.85);
            let weather = sampleWeather(ro + rd * t, t * u.march2.y);
            // Bank weight grows along this ray. A fully replaced interval has no detailed light contribution.
            let bankOnly = distantBankWeight(a, cameraRadius) >= 1.0;
            // Light the samples together at their extinction-weighted position.
            let tIn = T;
            var tSum = 0.0;
            var densitySum = 0.0;
            var heightSum = 0.0;
            var backdropSum = vec2f(0.0);
            var wSum = 0.0;
            for (var i = 0; i < PROXY_SUBSAMPLES; i++) {
                let ti = a + (f32(i) + 0.5) * sub;
                let p = ro + rd * ti;
                let r = length(p);
                let bankW = distantBankWeight(ti, cameraRadius);
                var localH = 0.0;
                var detailed = 0.0;
                if (!bankOnly) {
                    let base = cloudBaseWithWeather(p, heightFraction(r), weather, footprint);
                    localH = base.localH;
                    let farW = farAverageWeight(p, rd, ti * u.march2.y);
                    if (base.density > 0.0 && farW < 0.999) { detailed = cloudDetail(p, base, footprint); }
                    if (farW > 0.0) { detailed = mix(detailed, meanCloudDensity(weather, base.h), farW); }
                }
                let layers = layerDensities(p, r, weather, footprint, bankW, detailed);
                let density = layers.x + layers.y + layers.z;
                if (density <= 0.0) { continue; }
                let stepT = exp(-density * u.density.x * sub);
                let w = T * (1.0 - stepT);
                tSum += ti * w;
                densitySum += density * w;
                heightSum += localH * w;
                backdropSum += layers.yz * w;
                wSum += w;
                T *= stepT;
            }
            depthSum += tSum;
            weightSum += wSum;
            if (wSum <= 1.0e-6) { continue; }
            let pL = ro + rd * (tSum / wSum);
            var sample: ViewDensity;
            sample.weather = weather;
            sample.density = densitySum / wSum;
            sample.base.h = heightFraction(length(pL));
            sample.base.localH = heightSum / wSum;
            sample.backdropShare = backdropSum / densitySum;
            L += viewCloudLight(sample, pL, rd, footprint, phase, cameraRadius, cameraSun) * (tIn - T);
        }
        res.color = vec4f(L, T);
        if (weightSum > 1.0e-4) { res.depth = depthSum / weightSum; }
        return res;
    }
    let mid = ro + rd * (0.5 * (t0 + t1));
    let rMid = length(mid);
    let up = mid / rMid;
    let muS = dot(up, u.sun.xyz);
    let solarHue = cloudSunHueAngle(muS, cameraSun, cameraRadius);
    // Lights: [0] sun, [1] moon (only while the sun is dim).
    var dirs = array<vec3f, 2>(u.sun.xyz, u.moon.xyz);
    var lightT = array<vec3f, 2>(vec3f(0.0), vec3f(0.0));
    var perView = array<f32, 2>(0.0, 0.0);
    var odAbove = array<f32, 2>(0.0, 0.0);
    var cosL = array<f32, 2>(0.0, 0.0);
    var powderW = array<f32, 2>(0.0, 0.0);
    var amb = u.ambientFloor.rgb;
    var ambSky = vec3f(0.0);
    var ambGround = vec3f(0.0);
    let illum = array<f32, 2>(u.sun.w, u.moon.w);
    for (var li = 0; li < 2; li++) {
        let mu = dot(up, dirs[li]);
        lightT[li] = cloudLightTransmittance(rMid, mu, select(mu, solarHue, li == 0), li == 0) * illum[li];
        // Sun path length per unit of view path inside a horizontal slab.
        perView[li] = max(-dot(rd, up), 0.05) / max(mu, 0.05);
        cosL[li] = dot(rd, dirs[li]);
        powderW[li] = u.phase.w * saturate(0.6 - 0.6 * cosL[li]);
        ambSky += textureSampleLevel(ambientLut, lutSampler, ambientUv(mu, 0.0), 0.0).rgb * illum[li];
        ambGround += textureSampleLevel(ambientLut, lutSampler, ambientUv(mu, 1.0), 0.0).rgb * illum[li];
    }
    let sunMax = max(lightT[0].r, max(lightT[0].g, lightT[0].b));
    let moonMax = max(lightT[1].r, max(lightT[1].g, lightT[1].b));
    if (!(moonMax > 1.0e-5 && sunMax < moonMax * 20.0)) { lightT[1] = vec3f(0.0); }
    lightT[0] *= daylightSunGain(solarHue, cosL[0]);
    let dt = (t1 - t0) / f32(PROXY_SLABS);

    var T = 1.0;
    var L = vec3f(0.0);
    var depthSum = 0.0;
    var weightSum = 0.0;
    var odUp = 0.0;
    let upPerView = max(-dot(rd, up), 0.05);
    for (var i = 0; i < PROXY_SLABS; i++) {
        let t = t0 + (f32(i) + 0.5) * dt;
        let p = ro + rd * t;
        // Noise blur capped at what the raymarch uses (half its 0.6 km max step). Coverage is a
        // threshold on the noise, so a blurrier lookup (a quarter of a multi-km slab) thinned the
        // clouds out and the far view no longer matched the raymarch from the same place.
        let footprint = max(t * u.march2.y, min(dt * 0.25, u.march.w * 0.5));
        // Weather at this slab's position and pixel size, as the raymarch reads it. One lookup at the
        // path's middle blurred over the whole path averaged the pattern away, so from orbit the
        // clouds were fewer and in other places than in the raymarch from the same spot.
        let weather = sampleWeather(p, t * u.march2.y);
        let base = cloudBaseWithWeather(p, heightFraction(length(p)), weather, footprint);
        let farW = farAverageWeight(p, rd, t * u.march2.y);
        var density = 0.0;
        if (base.density > 0.0 && farW < 0.999) { density = cloudDetail(p, base, footprint); }
        density = mix(density, meanCloudDensity(weather, base.h), farW) + altoDensity(p, length(p), weather, footprint);
        if (density <= 0.0) { continue; }
        let sigmaT = density * u.density.x;
        let sigmaS = sigmaT * u.density.w;
        let stepT = exp(-sigmaT * dt);
        var directL = vec3f(0.0);
        for (var li = 0; li < 2; li++) {
            if (max(lightT[li].r, max(lightT[li].g, lightT[li].b)) <= 1.0e-5) { continue; }
            let sp = p + dirs[li] * PROXY_SUN_KM;
            let sideR = length(sp);
            let side = cloudBaseWithWeather(sp, heightFraction(sideR), weather, footprint).density
                + altoDensity(sp, sideR, weather, footprint);
            let odL = odAbove[li] + side * u.density.x * PROXY_SUN_KM;
            var a = 1.0;
            var b = 1.0;
            var c = 1.0;
            var lightL = vec3f(0.0);
            for (var k = 0; k < 4; k++) {
                // Integral over the slab of view transmittance times light transmittance (octave k).
                let kk = 1.0 + a * perView[li];
                let slab = (1.0 - exp(-sigmaT * dt * kk)) / (sigmaT * kk);
                lightL += lightT[li] * (b * cloudPhase(cosL[li], c) * exp(-odL * a) * slab);
                a *= u.light.y;
                b *= u.light.z;
                c *= u.light.w;
            }
            let powder = 1.0 - exp(-sigmaT * 0.12);
            directL += lightL * mix(1.0, powder, powderW[li]);
        }
        let skyVis = mix(0.25, 1.0, exp(-odUp * 0.35));
        let skyMix = saturate(0.25 + base.h);
        let ambient = mix(ambGround, ambSky * skyVis, skyMix) * u.light.x + amb * skyVis
            + daylightSkyFill(solarHue, skyVis, skyMix) + twilightSkyFill(muS, solarHue, skyVis);
        L += T * sigmaS * rainCloudRadiance(directL + ambient * (1.0 - stepT) / sigmaT, base.localH, solarHue);
        let w = T * (1.0 - stepT);
        depthSum += t * w;
        weightSum += w;
        T *= stepT;
        odAbove[0] += sigmaT * dt * perView[0];
        odAbove[1] += sigmaT * dt * perView[1];
        odUp += sigmaT * dt * upPerView;
    }
    res.color = vec4f(L, T);
    if (weightSum > 1.0e-4) { res.depth = depthSum / weightSum; }
    return res;
}

// A second spherical stratus volume. It uses the same scene depth as the
// high banks, so peaks can project through it and slopes inside it are muted.
fn marchLowClouds(ro: vec3f, rd: vec3f, tScene: f32) -> MarchResult {
    var result = MarchResult(vec4f(0.0, 0.0, 0.0, 1.0), FAR_DEPTH);
    let outer = raySphere(ro, rd, u.lowCloud.y);
    if (outer.x >= outer.y || outer.y <= 0.0) { return result; }
    let ground = raySphere(ro, rd, u.planet.x);
    var limit = min(outer.y, tScene);
    if (ground.x < ground.y && ground.y > 0.0) { limit = min(limit, max(ground.x, 0.0)); }
    let inner = raySphere(ro, rd, u.lowCloud.x);
    let start = max(0.0, outer.x);
    let splits = inner.x < inner.y && inner.y > start;
    let ends = vec2f(select(limit, min(limit, inner.x), splits), limit);
    let starts = vec2f(start, select(limit, max(start, inner.y), splits));
    let viewSun = clamp(cloudPhase(dot(rd, u.sun.xyz), 1.0), 0.045, 0.23);
    var depth = 0.0;
    for (var leg = 0; leg < 2; leg++) {
        let dt = (ends[leg] - starts[leg]) / 24.0;
        if (dt <= 0.0 || result.color.a < 0.004) { continue; }
        let middle = ro + rd * (0.5 * (ends[leg] + starts[leg]));
        let radius = length(middle);
        let up = middle / radius;
        let muS = dot(up, u.sun.xyz);
        let muM = dot(up, u.moon.xyz);
        let cameraRadius = length(ro);
        let hue = cloudSunHueAngle(muS, dot(ro / cameraRadius, u.sun.xyz), cameraRadius);
        let sun = cloudLightTransmittance(radius, muS, hue, true) * (u.sun.w * (1.0 - 0.58 * u.weatherStyle.y));
        let moon = cloudLightTransmittance(radius, muM, muM, false) * (u.moon.w * 0.075);
        let diffuse = daylightSkyFill(hue, 0.82, 0.7) + twilightSkyFill(muS, hue, 0.7)
            + u.ambientFloor.rgb + moon;
        let footprint = max((starts[leg] + 12.0 * dt) * u.march2.y, dt * 0.62);
        var weather: Weather;
        for (var i = 0; i < 24; i++) {
            let t = starts[leg] + (f32(i) + 0.5) * dt;
            let p = ro + rd * t;
            if (i % 4 == 0) { weather = sampleWeather(ro + rd * min(t + 1.5 * dt, ends[leg]), footprint); }
            let r = length(p);
            let density = lowStratusDensity(p, r, weather, footprint);
            if (density <= 0.0) { continue; }
            let localH = saturate((r - u.lowCloud.x) / (u.lowCloud.y - u.lowCloud.x));
            let selfShade = exp(-density * (1.0 - localH) * 7.0);
            let light = rainCloudRadiance(sun * (0.046 + 0.38 * viewSun) * selfShade + diffuse, localH, hue);
            let T = exp(-density * u.density.x * dt);
            let absorbed = (1.0 - T) * result.color.a;
            result.color = vec4f(result.color.rgb + light * absorbed, result.color.a * T);
            depth += t * absorbed;
            if (result.color.a < 0.004) { break; }
        }
    }
    if (result.color.a < 0.9999) { result.depth = depth / (1.0 - result.color.a); }
    return result;
}



// For a radius squared that changes linearly along the column interval,
// solve the quadratic intersection with the ray's radius squared.
fn deckRadiusRoots(radiusAtStart: f32, slope: f32, start: f32, closestSq: f32) -> vec2f {
    let center = 0.5 * slope;
    let reachSq = radiusAtStart - closestSq - start * slope + center * center;
    if (reachSq <= 0.0) { return vec2f(1.0e30, -1.0e30); }
    let reach = sqrt(reachSq);
    return vec2f(center - reach, center + reach);
}

fn deckIntervalDensity(t: f32, closestSq: f32, start: f32, inverseWidth: f32, a: DeckColumn, b: DeckColumn) -> f32 {
    let fraction = (t - start) * inverseWidth;
    let floorSq = mix(a.floorSq, b.floorSq, fraction);
    let roofSq = mix(a.roofSq, b.roofSq, fraction);
    let h = saturate((closestSq - floorSq + t * t) / (roofSq - floorSq));
    return mix(a.density, b.density, fraction) * (4.0 * h * (1.0 - h));
}

fn deckIntervalIntegral(lo: f32, hi: f32, closestSq: f32, start: f32,
                        inverseWidth: f32, a: DeckColumn, b: DeckColumn) -> vec2f {
    if (hi <= lo) { return vec2f(0.0); }
    let center = 0.5 * (lo + hi);
    let offset = 0.3872983346 * (hi - lo);
    let locations = vec3f(center - offset, center, center + offset);
    // The column's vertical profile is smooth. Three-point Gaussian
    // quadrature integrates each clipped piece with no further texture reads.
    let density = vec3f(
        deckIntervalDensity(locations.x, closestSq, start, inverseWidth, a, b),
        deckIntervalDensity(locations.y, closestSq, start, inverseWidth, a, b),
        deckIntervalDensity(locations.z, closestSq, start, inverseWidth, a, b));
    let weights = vec3f(5.0, 8.0, 5.0) * ((hi - lo) / 18.0);
    return vec2f(dot(weights, density), dot(weights * locations, density));
}

fn deckColumnIntegral(lo: f32, hi: f32, closestSq: f32, a: DeckColumn, b: DeckColumn) -> vec2f {
    if (a.density + b.density <= 0.0) { return vec2f(0.0); }
    let inverseWidth = 1.0 / (hi - lo);
    let roof = deckRadiusRoots(a.roofSq, (b.roofSq - a.roofSq) * inverseWidth, lo, closestSq);
    let start = max(lo, roof.x);
    let finish = min(hi, roof.y);
    if (finish <= start) { return vec2f(0.0); }
    let floor = deckRadiusRoots(a.floorSq, (b.floorSq - a.floorSq) * inverseWidth, lo, closestSq);
    if (floor.x >= floor.y) { return deckIntervalIntegral(start, finish, closestSq, lo, inverseWidth, a, b); }
    return deckIntervalIntegral(start, min(finish, floor.x), closestSq, lo, inverseWidth, a, b)
        + deckIntervalIntegral(max(start, floor.y), finish, closestSq, lo, inverseWidth, a, b);
}

fn deckLight(p: vec3f, probe: f32, phase: f32, cameraSun: f32, cameraRadius: f32) -> vec3f {
    let r = length(p);
    let mu = dot(p / r, u.sun.xyz);
    let hue = cloudSunHueAngle(mu, cameraSun, cameraRadius);
    let shade = mix(0.42, 1.0, exp(-probe * u.density.x));
    let direct = cloudLightTransmittance(r, mu, hue, true) * (u.sun.w * shade * (0.053 + phase * 0.35));
    let ambient = daylightSkyFill(hue, 0.75, 0.65) + twilightSkyFill(mu, hue, 0.75) + u.ambientFloor.rgb;
    var moon = vec3f(0.0);
    if (u.moon.w != 0.0) {
        let moonMu = dot(p / r, u.moon.xyz);
        moon = cloudLightTransmittance(r, moonMu, moonMu, false) * (0.065 * u.moon.w);
    }
    return rainCloudRadiance(direct + ambient + moon, heightFraction(r), hue);
}

fn budgetRayColumn(p: vec3f, footprint: f32) -> DeckColumn {
    if (BUDGET_DENSE_DECK) { return deckColumn(p, footprint); }
    return budgetBankColumn(p, footprint);
}

fn broadDeck(ro: vec3f, rd: vec3f, tScene: f32, minDistance: f32) -> MarchResult {
    let empty = MarchResult(vec4f(0.0, 0.0, 0.0, 1.0), FAR_DEPTH);
    let thickness = select(min(3.7, u.planet.z - u.planet.y), budgetBankThickness(), RAY_PATH == 4u);
    let outer = raySphere(ro, rd, u.planet.y + thickness);
    let hitGround = raySphere(ro, rd, u.planet.x);
    var finish = min(tScene, outer.y);
    if (hitGround.x < hitGround.y && hitGround.y > 0.0) { finish = min(finish, max(0.0, hitGround.x)); }
    let start = max(minDistance, outer.x);
    if (finish <= start) { return empty; }
    let closest = -dot(ro, rd);
    let closestSq = max(0.0, dot(ro, ro) - closest * closest);
    let floorSq = u.planet.y * u.planet.y;
    // Keep the horizontal lattice through the base tangent. The inner gap
    // clips individual intervals instead of moving their sample positions.
    let samples = select(48, 64, RAY_PATH == 4u);
    let ds = (finish - start) / f32(samples);
    var T = 1.0;
    var depthSum = 0.0;
    var previous: DeckColumn;
    var hasColumn = false;
    for (var j = 0; j < samples; j++) {
        let a = start + f32(j) * ds - closest;
        let b = a + ds;
        if (closestSq + max(a * a, b * b) <= floorSq) {
            hasColumn = false;
            continue;
        }
        if (!hasColumn) {
            let t = closest + a;
            if (RAY_PATH == 4u) {
                previous = budgetRayColumn(ro + rd * t, max(t * u.march2.y, 0.60 * ds));
            } else {
                previous = deckColumn(ro + rd * t, max(t * u.march2.y, 0.60 * ds));
            }
        }
        let t = closest + b;
        var current: DeckColumn;
        if (RAY_PATH == 4u) {
            current = budgetRayColumn(ro + rd * t, max(t * u.march2.y, 0.60 * ds));
        } else {
            current = deckColumn(ro + rd * t, max(t * u.march2.y, 0.60 * ds));
        }
        let integral = deckColumnIntegral(a, b, closestSq, previous, current);
        previous = current;
        hasColumn = true;
        if (integral.x <= 1.0e-8) { continue; }
        let stepT = exp(-u.density.x * integral.x);
        depthSum += (closest + integral.y / integral.x) * T * (1.0 - stepT);
        T *= stepT;
        if (T < select(0.01, 0.002, RAY_PATH == 4u)) { break; }
    }
    let opacity = 1.0 - T;
    if (opacity < 1.0e-5) { return empty; }
    let depth = depthSum / opacity;
    let p = ro + rd * depth;
    let lightPoint = p + u.sun.xyz * 0.65;
    var probe: f32;
    if (RAY_PATH == 4u) {
        probe = columnDensity(dot(lightPoint, lightPoint), budgetRayColumn(lightPoint, 0.35));
    } else {
        probe = deckExperimentDensity(lightPoint, 0.35);
    }
    let phase = clamp(cloudPhase(dot(rd, u.sun.xyz), 1.0), 0.05, 0.25);
    let light = deckLight(p, probe, phase, dot(normalize(ro), u.sun.xyz), length(ro));
    return MarchResult(vec4f(light * opacity, T), depth);
}

struct BudgetNear {
    cloud: MarchResult,
    resume: f32,
}

fn traceBudgetNear(ro: vec3f, rd: vec3f, tScene: f32) -> BudgetNear {
    var near = MarchResult(vec4f(0.0, 0.0, 0.0, 1.0), FAR_DEPTH);
    if (clearWeather()) { return BudgetNear(near, -1.0); }
    let outer = raySphere(ro, rd, u.planet.z);
    let inner = raySphere(ro, rd, u.planet.y);
    let ground = raySphere(ro, rd, u.planet.x);
    var scene = tScene;
    if (ground.x < ground.y && ground.y > 0.0) { scene = min(scene, max(0.0, ground.x)); }
    var start = max(outer.x, 0.0);
    if (inner.x <= start && inner.y > start) { start = inner.y; }
    let finish = min(min(u.budget.x, scene), outer.y);
    if (finish <= start) { return BudgetNear(near, 0.0); }

    let steps = max(1, i32(u.budget.y));
    // Interval positions depend on the distance budget, with more samples
    // near the eye. The scene limits only clip the first and last intervals.
    let fine = mix(0.45, 1.0, u.budget.z);
    let growth = 1.0 - fine;
    let startRatio = start / u.budget.x;
    let fractionalStart = 2.0 * startRatio / (sqrt(fine * fine + 4.0 * growth * startRatio) + fine);
    let first = i32(floor(fractionalStart * f32(steps)));
    let phase = rayScattering(rd);
    let cameraRadius = length(ro);
    let cameraSun = dot(ro / cameraRadius, u.sun.xyz);
    let deckSun = dot(normalize(ro), u.sun.xyz);
    let deckPhase = clamp(cloudPhase(phase.sunCosine, 1.0), 0.05, 0.25);
    let fullLight = 1.0 - smoothstep(0.25, 0.85, u.weatherStyle.y);
    var depthSum = 0.0;
    var nearLight = vec3f(0.0);
    var lastLit = -4;
    for (var i = first; i < steps; i++) {
        let f = vec2f(f32(i), f32(i + 1)) / f32(steps);
        let bounds = u.budget.x * (f * fine + f * f * growth);
        let a = max(start, bounds.x);
        let b = min(finish, bounds.y);
        if (b <= a) { break; }
        let t = (a + b) * 0.5;
        let p = ro + rd * t;
        let r = length(p);
        let h = heightFraction(r);
        if (h <= 0.0 || h >= 1.0) { continue; }
        let footprint = max((bounds.y - bounds.x) * 0.8, t * u.march2.y);
        let weather = sampleWeather(p, footprint);
        let base = cloudBaseWithWeather(p, h, weather, footprint);
        var density = altoDensity(p, r, weather, footprint);
        if (base.density > 0.0) { density += cloudDetail(p, base, footprint); }
        let farWeight = smoothstep(u.budget.x * 0.55, u.budget.x, t);
        var sigma = density;
        if (farWeight > 0.0) {
            sigma = mix(density, columnDensity(r * r, budgetRayColumn(p, footprint)), farWeight);
        }
        if (sigma <= 1.0e-5) { continue; }
        let localLight = fullLight * (1.0 - farWeight) * smoothstep(0.001, 0.04, density);
        let useFullLight = BUDGET_FULL_LIGHT && !BUDGET_DENSE_DECK && localLight > 0.001;
        var source = vec3f(0.0);
        if (!useFullLight || localLight < 1.0) {
            let lightP = p + u.sun.xyz * 0.18;
            var probe = cloudBaseWithWeather(lightP, heightFraction(length(lightP)), weather, 0.25).density * 0.5;
            if (BUDGET_FULL_LIGHT) {
                let farther = p + u.sun.xyz * 0.55;
                probe = probe * 0.55 + cloudBaseWithWeather(farther, heightFraction(length(farther)), weather, 0.3).density * 0.22;
            }
            if (farWeight > 0.0) {
                let deckProbe = p + u.sun.xyz * 0.65;
                probe = mix(probe, columnDensity(dot(deckProbe, deckProbe), budgetRayColumn(deckProbe, 0.35)), farWeight);
            }
            source = deckLight(p, probe, deckPhase, deckSun, cameraRadius);
        }
        if (useFullLight) {
            if (i - lastLit >= 4) {
                nearLight = cloudSource(p, rd, footprint, weather, base, density, phase, cameraRadius, cameraSun)
                    / max(density * u.density.x, 1.0e-5);
                lastLit = i;
            }
            source = mix(source, nearLight, localLight);
        } else {
            lastLit = -4;
        }
        let stepT = exp(-u.density.x * sigma * (b - a));
        let opacity = near.color.a * (1.0 - stepT);
        near.color = vec4f(near.color.rgb + source * opacity, near.color.a * stepT);
        depthSum += t * opacity;
        if (near.color.a < 0.004) { break; }
    }
    if (near.color.a < 0.99999) { near.depth = depthSum / (1.0 - near.color.a); }
    let continuation = select(finish, -1.0, near.color.a < 0.004 || finish >= scene);
    return BudgetNear(near, continuation);
}

fn finishBudget(ro: vec3f, rd: vec3f, tScene: f32, near: BudgetNear) -> MarchResult {
    if (near.resume < 0.0) { return near.cloud; }
    return blendCloudLayers(near.cloud, broadDeck(ro, rd, tScene, near.resume));
}

override RAY_PATH: u32 = 1u; // 1 detailed march, 2 proxy, 3 broad deck, 4 budget bank
override RAY_GROUP_HEIGHT: u32 = 8u;
override RAY_GROUP_WIDTH: u32 = 8u;
override BUDGET_FULL_LIGHT: bool = false;
override BUDGET_DENSE_DECK: bool = false;

// One invocation per ray. The dispatch grid is full size, interleaved or sparse.
@compute @workgroup_size(RAY_GROUP_WIDTH, RAY_GROUP_HEIGHT)
fn main(@builtin(global_invocation_id) id: vec3u${reuse ? ', @builtin(workgroup_id) group: vec3u' : ''}) {
    let blocks = textureDimensions(outColor);
    if (id.x >= blocks.x || id.y >= blocks.y) { return; }
    let ray = cloudRay(id.xy);
    ${reuse ? /* wgsl */`
    if (((group.x ^ group.y) & 1u) == u32(u.historyMotion.x)) {
        if (reuseRay(vec2i(id.xy), ray)) { return; }
    }
    ` : ''}
    let rd = ray.direction;
    let tScene = ray.sceneDistance;
    ${budgetStage === 'near' ? /* wgsl */`
    let near = traceBudgetNear(u.camPos.xyz, rd, tScene);
    textureStore(outColor, vec2i(id.xy), near.cloud.color);
    textureStore(outDepth, vec2i(id.xy), vec4f(near.cloud.depth, near.resume, 0.0, 0.0));
}
` : /* wgsl */`
    ${budgetStage === 'finish' ? /* wgsl */`
    let position = vec2i(id.xy);
    let data = textureLoad(nearRay, position, 0).xy;
    let near = BudgetNear(MarchResult(textureLoad(nearColor, position, 0), data.x), data.y);
    let intermediate = false;
    var result = finishBudget(u.camPos.xyz, rd, tScene, near);
    ` : blendProxy ? /* wgsl */`
    let proxyWeight = u.lod.x;
    let intermediate = false;
    let proxy = proxyLayer(u.camPos.xyz, rd, tScene);
    let position = vec2i(id.xy);
    var result = MarchResult(
        mix(textureLoad(marchColor, position, 0), proxy.color, proxyWeight),
        mix(textureLoad(marchDepth, position, 0).x, proxy.depth, proxyWeight));
    ` : /* wgsl */`
    let intermediate = RAY_PATH == 1u && u.march4.y > 0.5;
    var result: MarchResult;
    if (RAY_PATH == 3u) {
        result = broadDeck(u.camPos.xyz, rd, tScene, 0.0);
    } else if (RAY_PATH == 4u) {
        result = MarchResult(vec4f(0.0, 0.0, 0.0, 1.0), FAR_DEPTH);
        if (!clearWeather()) { result = broadDeck(u.camPos.xyz, rd, tScene, 0.0); }
    } else if (RAY_PATH == 1u) {
        result = march(u.camPos.xyz, rd, tScene);
    } else {
        result = proxyLayer(u.camPos.xyz, rd, tScene);
    }
    `}
    // The low layer is composited against the final depth after the crossfade.
    if (!intermediate && u.weatherStyle.w > 0.001 && u.march2.w < 0.5) {
        let low = marchLowClouds(u.camPos.xyz, rd, tScene);
        if (low.depth < result.depth) {
            result = blendCloudLayers(low, result);
        } else {
            result = blendCloudLayers(result, low);
        }
    }
    textureStore(outColor, vec2i(id.xy), result.color);
    // Negative depth: an opaque surface lay under this texel and its ray stopped there. The composite
    // upsamples such texels only into opaque pixels, and sky texels only into sky pixels.
    let depthOut = select(result.depth, -max(result.depth, 1.0e-3), !intermediate && tScene < 1.0e29);
    textureStore(outDepth, vec2i(id.xy), vec4f(depthOut, 0.0, 0.0, 0.0));
}
`}
`;
}

export const CLOUD_RAYMARCH_WGSL = cloudRaymarchShader();
export const CLOUD_PROXY_BLEND_WGSL = cloudRaymarchShader({ blendProxy: true });
export const CLOUD_HISTORY_RAYMARCH_WGSL = cloudRaymarchShader({ reuse: true });
export const CLOUD_WEATHER_CACHE_RAYMARCH_WGSL = cloudRaymarchShader({ cache: 'weather' });
export const CLOUD_LIGHT_CACHE_RAYMARCH_WGSL = cloudRaymarchShader({ cache: 'light' });
export const CLOUD_BUDGET_NEAR_WGSL = cloudRaymarchShader({ budgetStage: 'near' });
export const CLOUD_BUDGET_FINISH_WGSL = cloudRaymarchShader({ budgetStage: 'finish' });

// Reconstruct full-size colour and depth from the spatial ray grid. On a checkerboard
// the sampled parity has a centre and diagonals; missing pixels have four axial taps.
export const CLOUD_SPATIAL_WGSL = /* wgsl */`${CLOUD_UNIFORMS_WGSL}${CLOUD_MATH_WGSL}
@group(0) @binding(0) var<uniform> u: CloudUniforms;
@group(0) @binding(1) var rayColor: texture_2d<f32>;
@group(0) @binding(2) var rayDepth: texture_2d<f32>;
@group(0) @binding(3) var sceneDepth: texture_depth_2d;
@group(0) @binding(4) var outColor: texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var outDepth: texture_storage_2d<r32float, write>;

fn isOpaque(pixel: vec2u, size: vec2u) -> bool {
    if (u.sceneDepth.w < 0.5) { return false; }
    return nearestSceneDepth(sceneDepth, pixel, pixel, size) < 1.0;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(outColor);
    if (any(id.xy >= size)) { return; }
    let p = vec2i(id.xy);
    let packed = p / vec2i(2, 1);
    let squareGrid = u.look4.z > 1.5;
    let sampled = !squareGrid && ((p.x ^ p.y) & 1) == 0;
    var coords: array<vec2i, 4>;
    var weights = vec4f(1.0);
    var sum = vec4f(0.0);
    var weight = 0.0;
    var closest = 1.0e6;
    var depthSum = 0.0;
    var depthWeight = 0.0;
    var centreDepth = 1.0e6;
    var opaque: bool;
    if (squareGrid) {
        let aboveLeft = (vec2f(p) + 0.5) / u.look4.z - 0.5;
        let q = vec2i(floor(aboveLeft));
        let f = fract(aboveLeft);
        let maxTap = vec2i(textureDimensions(rayColor)) - 1;
        coords = array<vec2i, 4>(q, q + vec2i(1, 0), q + vec2i(0, 1), q + 1);
        for (var i = 0; i < 4; i++) { coords[i] = clamp(coords[i], vec2i(0), maxTap); }
        weights = vec4f((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y), (1.0 - f.x) * f.y, f.x * f.y);
        opaque = isOpaque(id.xy, size);
    } else if (sampled) {
        coords = array<vec2i, 4>(p + vec2i(-1, -1), p + vec2i(1, -1), p + vec2i(-1, 1), p + vec2i(1, 1));
        let c = textureLoad(rayColor, packed, 0);
        centreDepth = textureLoad(rayDepth, packed, 0).r;
        opaque = centreDepth < 0.0;
        sum = c * 4.0;
        weight = 4.0;
    } else {
        coords = array<vec2i, 4>(p + vec2i(-1, 0), p + vec2i(1, 0), p + vec2i(0, -1), p + vec2i(0, 1));
        opaque = isOpaque(id.xy, size);
    }
    for (var i = 0; i < 4; i++) {
        let coord = coords[i];
        if (any(coord < vec2i(0)) || any(coord >= vec2i(size))) { continue; }
        let tap = select(coord / vec2i(2, 1), coord, squareGrid);
        let d = textureLoad(rayDepth, tap, 0).r;
        if ((d < 0.0) != opaque) { continue; }
        let c = textureLoad(rayColor, tap, 0);
        sum += c * weights[i];
        weight += weights[i];
        closest = min(closest, abs(d));
        let a = max(1.0 - c.a, 0.0) * weights[i];
        depthSum += abs(d) * a;
        depthWeight += a;
    }
    var color = vec4f(0.0, 0.0, 0.0, 1.0);
    if (weight > 0.0) { color = sum / weight; }
    var depth = select(closest, depthSum / max(depthWeight, 1.0e-5), depthWeight > 1.0e-5);
    depth = select(depth, -max(depth, 1.0e-3), opaque);
    if (sampled) { depth = centreDepth; }
    textureStore(outColor, p, color);
    textureStore(outDepth, p, vec4f(depth, 0.0, 0.0, 0.0));
}
`;

// Temporal reconstruction. The raymarch filled one pixel per k x k block; every
// target pixel reprojects history through the block's cloud depth, clips it to
// the freshly marched neighbourhood, and fresh pixels blend in their new sample.
// Without usable history the fresh samples are upsampled spatially.
export const CLOUD_TEMPORAL_WGSL = /* wgsl */`${CLOUD_UNIFORMS_WGSL}${CLOUD_MATH_WGSL}
@group(0) @binding(0) var<uniform> u: CloudUniforms;
@group(0) @binding(1) var curColor: texture_2d<f32>;
@group(0) @binding(2) var curDepth: texture_2d<f32>;
@group(0) @binding(3) var history: texture_2d<f32>;
@group(0) @binding(4) var linearSampler: sampler;
@group(0) @binding(5) var outHistory: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let size = vec2i(u.frameInfo.zw);
    let pi = vec2i(id.xy);
    if (pi.x >= size.x || pi.y >= size.y) { return; }
    let k = i32(u.quality.x);
    let blocks = vec2i(textureDimensions(curColor));
    let q = min(pi / k, blocks - 1);
    let fresh = all(pi == q * k + vec2i(u.quality.yz));
    let uv = (vec2f(pi) + 0.5) / vec2f(size);
    let cur = textureLoad(curColor, q, 0);
    var spatial = cur;
    if (!fresh) { spatial = textureSampleLevel(curColor, linearSampler, uv, 0.0); }

    let blend = u.march2.z;
    if (blend >= 0.999) {
        if (u.atmoExtra.w > 0.5 && u.windShape.w > 0.0) {
            // No temporal reconstruction: optionally soften with a 3x3 tent (spatialFilter, 0..1).
            // Samples sit at fixed midpoints then, so there is no jitter to hide and the tent only
            // blurs; at half resolution it softened distant clouds noticeably.
            var sum = vec4f(0.0);
            for (var y = -1; y <= 1; y++) {
                for (var x = -1; x <= 1; x++) {
                    let w = f32((2 - abs(x)) * (2 - abs(y)));
                    sum += textureLoad(curColor, clamp(q + vec2i(x, y), vec2i(0), blocks - 1), 0) * w;
                }
            }
            spatial = mix(cur, sum / 16.0, saturate(u.windShape.w));
        }
        textureStore(outHistory, pi, spatial);
        return;
    }
    var m1 = vec4f(0.0);
    var m2 = vec4f(0.0);
    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            let c = textureLoad(curColor, clamp(q + vec2i(x, y), vec2i(0), blocks - 1), 0);
            m1 += c;
            m2 += c * c;
        }
    }
    let mean = m1 / 9.0;
    let sigma = sqrt(max(m2 / 9.0 - mean * mean, vec4f(0.0)));

    let depth = abs(textureLoad(curDepth, q, 0).r);
    let rd = cameraRay(vec2f(pi) + 0.5, vec2f(size), u.camRight, u.camUp, u.camBack, u.frameInfo.x);
    let v = rd * depth + u.prevInfo.yzw;
    let vz = dot(v, u.prevBack.xyz);
    if (vz > -1.0e-4) {
        textureStore(outHistory, pi, spatial);
        return;
    }
    let vx = dot(v, u.prevRight.xyz);
    let vy = dot(v, u.prevUp.xyz);
    let ndc = vec2f((u.prevRight.w * vx + u.prevBack.w * vz) / -vz, (u.prevUp.w * vy + u.prevInfo.x * vz) / -vz);
    let prevUv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
    if (any(prevUv < vec2f(0.0)) || any(prevUv > vec2f(1.0))) {
        textureStore(outHistory, pi, spatial);
        return;
    }
    let hist = sampleCatmullRom(history, linearSampler, prevUv);
    let clipped = clamp(hist, mean - sigma * u.lod.w, mean + sigma * u.lod.w);
    var result = clipped;
    if (fresh) { result = mix(clipped, cur, blend); }
    textureStore(outHistory, pi, result);
}
`;
