export const CLOUD_VIEW_FIELDS_WGSL = /* wgsl */`
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
    let dh = deckHeight(h, weather, deckDepth(weather));
    let deck = smoothstep(0.0, 0.21, dh) * (1.0 - smoothstep(0.42, 0.87, dh));
    return 0.5 * c * c * mix(0.6, 1.0, weather.coverage) * u.extra.w
        + deck * u.weatherStyle.y * weather.coverage * 0.11 * u.deckStyle.y;
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

`;

export const CLOUD_TOP_WGSL = /* wgsl */`
// Radius of the highest cumulus or deck cloud.
fn cumulusTop() -> f32 {
    let smallTop = min(0.92, u.shape2.w * 1.4 * u.march3.z);
    let domeTop = mix(0.25, 1.0, smallTop);
    let deckTop = mix(0.16, 0.035, u.weatherStyle.z) + 0.08 + 0.2 * max(0.0, 1.0 - u.deckStyle.x)
        + max(0.12, mix(0.24, 0.49, u.weatherStyle.z) * u.deckStyle.x);
    return mix(u.planet.y, u.planet.z, max(domeTop, deckTop));
}
`;

export const CLOUD_WEATHER_ATLAS_LOOKUP_WGSL = /* wgsl */`
fn atlasWeather(p: vec3f) -> Weather {
    let direction = normalize(p) * u.planet.y + u.windShape.xyz * 0.8;
    let field = textureSampleLevel(weatherField, linearSampler, direction, 0.0);
    let shift = textureSampleLevel(weatherShift, linearSampler, direction, 0.0).xyz;
    return weatherFromField(WeatherField(field, shift));
}
`;

export const CLOUD_NEURAL_LIGHT_LOOKUP_WGSL = /* wgsl */`
struct LightPatch {
    axisU: vec4f,
    axisV: vec4f,
    grid: vec4f, // center.xy, extent, weight
    wind: vec4f,
}
struct LightPatchPair {
    current: LightPatch,
    previous: LightPatch,
}
@group(0) @binding(14) var lightPatch: texture_3d<f32>;
@group(0) @binding(15) var priorLightPatch: texture_3d<f32>;
@group(0) @binding(16) var<uniform> lightPatches: LightPatchPair;

fn sampleLightPatch(p: vec3f, radius: f32, region: LightPatch, tex: texture_3d<f32>) -> vec4f {
    if (region.grid.w <= 0.0) { return vec4f(0.0); }
    let projected = (p + u.windShape.xyz - region.wind.xyz) * (u.planet.x / radius);
    let xy = vec2f(dot(projected, region.axisU.xyz), dot(projected, region.axisV.xyz));
    let uv = (xy - region.grid.xy) / region.grid.z;
    let z = heightFraction(radius);
    let rim = max(abs(uv.x), abs(uv.y));
    if (rim >= 0.49 || z < 0.0 || z > 1.0 || dot(projected, cross(region.axisU.xyz, region.axisV.xyz)) < 0.0) {
        return vec4f(0.0);
    }
    let weight = region.grid.w * (1.0 - smoothstep(0.38, 0.49, rim));
    return textureSampleLevel(tex, linearSampler, vec3f(uv + 0.5, z), 0.0) * weight;
}

fn cachedLight(p: vec3f, radius: f32) -> vec4f {
    return sampleLightPatch(p, radius, lightPatches.current, lightPatch)
        + sampleLightPatch(p, radius, lightPatches.previous, priorLightPatch);
}

fn neuralEdgeBlend(confidence: f32, opacity: f32) -> f32 {
    // The probe-lit fallback is visibly brighter along the underside of a deck.
    // Below a deck, use learned light sooner. Inside the layer and above it,
    // where the ray centroid can jump between billows, retain the wider blend.
    let below = 1.0 - smoothstep(u.planet.y - 0.6, u.planet.y + 0.35, length(u.camPos.xyz));
    let deck = smoothstep(0.35, 0.72, u.weatherStyle.y) * below;
    return smoothstep(0.0, 0.65, confidence)
        * smoothstep(mix(0.15, 0.02, deck), mix(0.85, 0.30, deck), opacity);
}

fn bouncedSunScale(mu: f32, rain: f32, direct: f32) -> f32 {
    // In the low-sun storm probes both models let too much bounce through a
    // fully shadowed deck. Keep the network's variation and soften its energy
    // only for that combination of rain, sun angle, and measured shadow.
    let lateSun = 1.0 - smoothstep(0.05, 0.22, mu);
    let shielded = 1.0 - smoothstep(0.02, 0.10, direct);
    return mix(1.0, 0.33, smoothstep(0.65, 1.0, rain) * lateSun * shielded);
}
`;
