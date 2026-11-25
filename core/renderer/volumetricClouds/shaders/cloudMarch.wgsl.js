import {
    CLOUD_ATMOSPHERE_WGSL, CLOUD_DENSITY_WGSL, CLOUD_LAYER_BLEND_WGSL, CLOUD_MATH_WGSL,
    CLOUD_SHADOW_LOOKUP_WGSL, CLOUD_UNIFORMS_WGSL, buildCloudRayInput,
} from './cloudCommon.wgsl.js';
import { CLOUD_DENSITY_CLOSURE_WGSL } from '../neural/densityClosure.js';
import { CLOUD_RAY_PAIR_ENTRIES_WGSL } from './cloudRayPairs.wgsl.js';
import {
    CLOUD_NEURAL_LIGHT_LOOKUP_WGSL, CLOUD_TOP_WGSL, CLOUD_VIEW_FIELDS_WGSL, CLOUD_WEATHER_ATLAS_LOOKUP_WGSL,
} from './cloudViewFields.wgsl.js';

// The group sums live across the whole march. In 16 bits they cost fewer registers, which limit this shader
// more than arithmetic does (about 5-8 % of the march on an M1 Pro, within 1/255 for 99 % of pixels).
function sumTypes(halfFloats) {
    const f = halfFloats ? 'f16' : 'f32';
    return `alias Sum3 = vec3<${f}>;\nalias Sum4 = vec4<${f}>;\nalias LightSum = mat3x4<${f}>;`;
}

/** halfFloats: the device has shader-f16. */
export function buildCloudMarch(halfFloats = false) {
    return /* wgsl */`${halfFloats ? 'enable f16;' : ''}
${sumTypes(halfFloats)}
${CLOUD_UNIFORMS_WGSL}${CLOUD_MATH_WGSL}${CLOUD_ATMOSPHERE_WGSL}${CLOUD_LAYER_BLEND_WGSL}
@group(0) @binding(0) var<uniform> u: CloudUniforms;
@group(0) @binding(1) var shapeTex: texture_3d<f32>;
@group(0) @binding(2) var detailTex: texture_3d<f32>;
@group(0) @binding(3) var weatherTex: texture_3d<f32>;
@group(0) @binding(4) var noiseSampler: sampler;
@group(0) @binding(5) var cloudLightLut: texture_2d<f32>;
@group(0) @binding(6) var depthSampler: sampler;
@group(0) @binding(7) var linearSampler: sampler;
@group(0) @binding(8) var outColor: texture_storage_2d<rgba16float, write>;
@group(0) @binding(9) var outDepth: texture_storage_2d<r32float, write>;
@group(0) @binding(10) var sceneDepth: texture_depth_2d;
@group(0) @binding(11) var shadowMap: texture_2d<f32>;
@group(0) @binding(12) var weatherField: texture_cube<f32>;
@group(0) @binding(13) var weatherShift: texture_cube<f32>;
${CLOUD_DENSITY_WGSL}${buildCloudRayInput(true)}${CLOUD_SHADOW_LOOKUP_WGSL}
${CLOUD_VIEW_FIELDS_WGSL}${CLOUD_WEATHER_ATLAS_LOOKUP_WGSL}${CLOUD_DENSITY_CLOSURE_WGSL}${CLOUD_NEURAL_LIGHT_LOOKUP_WGSL}
// Coarser sampling for the lower detail tiers (cloudDetailTiers.js): spacing of the samples within 22 km in broken weather
// and in decks, and beyond 22 km; the first distance band that broken weather widens further; the width of the density
// filter. Wide samples near the camera draw teeth along the edges of small clouds.
override PITCH_SCALE: f32 = 1.0;
override DECK_PITCH_SCALE: f32 = 1.0;
override FAR_PITCH_SCALE: f32 = 1.0;
override BROKEN_BAND: u32 = 2u;
override FILTER_SCALE: f32 = 1.0;
// Smallest filter of the density probes of the far light (km). Narrow ones draw lines where a ray slips past a cloud edge.
override FAR_LIGHT_FILTER: f32 = 0.3;
// Broad masses mixed into the far clouds of broken weather.
override DISTANT_BANKS: bool = true;

// Cached light averaged over one depth group of the ray, in place of a point lookup.
var<private> groupLight: vec4f;
var<private> useGroupLight: bool;

struct CloudLight {
    single: vec3f,
    multiple: vec3f,
    sky: vec3f,
}

${CLOUD_TOP_WGSL}
fn fitted(c: mat3x4f, a: vec4f, b: vec4f, d: vec4f) -> f32 {
    return exp(clamp(dot(c[0], a) + dot(c[1], b) + dot(c[2], d), -20.0, 1.0));
}

// Light outside the cache: bounce, sky and direct sun (albedo in the first two), fitted to the path tracer from
// the column above, a short sun probe, the sun height and the height in the layer (tools/neural/far_light.py,
// held-out errors about 0.37, 0.15, 0.41 against 0.54, 0.23, 0.68). The hand-set terms were 5-15x too bright under
// thick decks with the sun below 15 degrees. The sun is held at 6 degrees or higher, where there is data:
// the fit turns black and speckled at the horizon.
fn fittedLight(p: vec3f, footprint: f32, mu: f32) -> vec3f {
    let radius = length(p);
    let up = p / radius;
    let weather = atlasWeather(p);
    let sun = normalize(u.sun.xyz + up * max(0.0, 0.1 - mu));
    let q = p + sun * 0.3;
    let local = 0.45 * u.density.x * cloudBaseWithWeather(q, heightFraction(length(q)), weather, max(FAR_LIGHT_FILTER, footprint)).density;
    let above = max(0.0, cumulusTop() - radius);
    var column = 0.0;
    if (above > 0.02) {
        let fp = max(max(0.4, FAR_LIGHT_FILTER), above * 0.17);
        for (var i = 0; i < 3; i++) {
            let s = p + up * (above * (f32(i) + 0.5) / 3.0);
            column += cloudBaseWithWeather(s, heightFraction(length(s)), weather, fp).density;
        }
        column *= above / 3.0;
    }
    if (u.alto.x > 0.0 && radius < u.alto.z) {
        let r = mix(max(radius, u.alto.y), u.alto.z, 0.5);
        column += altoDensity(up * r, r, weather, 0.4) * (u.alto.z - max(radius, u.alto.y));
    }
    let U = log(1.0 + min(column * u.density.x, 60.0));
    let L = log(1.0 + min(local, 6.0));
    let m = clamp(mu, 0.1, 1.0);
    let h = saturate(heightFraction(radius));
    let a = vec4f(1.0, U, L, m);
    let b = vec4f(h, U * m, U * U, m * m);
    let d = vec4f(L * m, U * h, U * sqrt(m), sqrt(m));
    // Fair weather and decks are fitted apart: one fit for both was 1.2x too bright in fair weather at high sun.
    let deck = smoothstep(0.3, 0.6, u.weatherStyle.y);
    let fair = vec3f(
        fitted(mat3x4f(vec4f(-4.10535, -0.73603, -0.07248, -0.35892), vec4f(0.92471, -1.70561, -0.34050, -0.82699), vec4f(0.27661, -0.35232, 3.45410, 1.65548)), a, b, d),
        fitted(mat3x4f(vec4f(-1.27050, 0.73696, 0.20181, 0.53476), vec4f(1.41751, 0.24291, -0.34146, -0.41172), vec4f(-0.39044, -1.77474, 0.10231, -0.04039)), a, b, d),
        fitted(mat3x4f(vec4f(-1.60307, -2.27983, -2.09382, -3.53448), vec4f(1.46532, -9.36200, -0.66683, 1.39922), vec4f(1.91700, -5.47239, 13.24128, 3.01962)), a, b, d));
    let overcast = vec3f(
        fitted(mat3x4f(vec4f(-3.96890, -3.13186, -0.65961, -6.58844), vec4f(-1.77693, -4.62340, 0.01067, 2.12990), vec4f(0.85546, 3.89956, 6.23380, 7.16823)), a, b, d),
        fitted(mat3x4f(vec4f(-0.30092, -0.88122, 0.14067, 0.82573), vec4f(0.13608, -0.34290, -0.05866, -0.32228), vec4f(-0.01542, 1.74219, 0.43409, -0.55695)), a, b, d),
        fitted(mat3x4f(vec4f(-0.72038, -2.58371, -1.44115, -4.19850), vec4f(-0.74490, -6.81504, -0.84128, 1.47079), vec4f(1.21238, -1.95957, 10.34808, 3.71284)), a, b, d));
    return min(mix(fair, overcast, deck), vec3f(1.0));
}

fn sourceAt(p: vec3f, rd: vec3f, footprint: f32, opacity: f32, low: bool) -> CloudLight {
    let up = normalize(p);
    let radius = length(p);
    let mu = dot(up, u.sun.xyz);
    let moonMu = dot(up, u.moon.xyz);
    let atmosphere = sunTransmittance(cloudLightLut, linearSampler, radius, mu, u.planet.x, u.planet.w);
    let sun = atmosphere * u.sun.w;
    let scattering = mix(henyeyGreenstein(dot(rd, u.sun.xyz), u.phase.x),
        henyeyGreenstein(dot(rd, u.sun.xyz), u.phase.y), u.phase.z);
    var moon = vec3f(0.0);
    if (u.moon.w > 0.0) {
        moon = sunTransmittance(cloudLightLut, linearSampler, radius, moonMu, u.planet.x, u.planet.w) * u.moon.w;
        if (!low) {
            // Moonlight as a directional light, with the same local probe and terms as the analytic sun. As a
            // constant it lit every side of every cloud equally, which read as flat grey.
            let q = p + u.moon.xyz * 0.45;
            let shade = 0.45 * cloudBaseWithWeather(q, heightFraction(length(q)), atlasWeather(q), max(0.20, footprint)).density * u.density.x;
            let lobe = mix(henyeyGreenstein(dot(rd, u.moon.xyz), u.phase.x), henyeyGreenstein(dot(rd, u.moon.xyz), u.phase.y), u.phase.z);
            moon *= exp(-shade) * lobe * 0.38 + (0.055 + 0.034 * smoothstep(-0.2, 0.6, moonMu)) * exp(-shade * 0.22);
        } else {
            moon *= 0.06;
        }
    }
    let baseAmbient = moon + u.ambientFloor.rgb;
    if (low) {
        // The deck above dims this layer about 10x in rain and storms. Fitted to the path tracer's points
        // in the low layer from the optical depth along the sun (the projected shadow map); held-out error
        // 0.41 for the bounce, against 8x too bright unshadowed. Near sunset the map is missing, so the
        // deck strength stands in. Targets include albedo.
        let mapDepth = -log(max(cloudShadowAt(p, 1.0), 1.0e-5));
        let deckDepth = 22.0 * smoothstep(0.3, 0.8, u.weatherStyle.y);
        let L = log(1.0 + min(mix(deckDepth, mapDepth, smoothstep(0.06, 0.16, mu)), 80.0));
        let hLow = saturate((radius - u.lowCloud.x) / max(u.lowCloud.y - u.lowCloud.x, 0.01));
        let m = clamp(mu, 0.0, 1.0);
        let albedo = max(u.density.w, 0.001);
        let rain = 1.0 - 0.44 * u.weatherStyle.z;
        let bounceLow = exp(-2.442 - 0.510 * L - 0.049 * m + 0.423 * hLow);
        let skyLow = min(1.0, exp(0.164 - 0.523 * L - 1.227 * m + 0.705 * hLow));
        let directLow = min(1.0, exp(-0.827 - 0.959 * L + 0.331 * m + 1.726 * hLow));
        return CloudLight(sun * (directLow * scattering * rain), sun * (bounceLow / albedo * rain),
            (baseAmbient + vec3f(0.61, 0.75, 1.0) * (u.look5.z * u.sun.w * smoothstep(-0.25, 0.35, mu) * skyLow / albedo)) * rain);
    }
    let daylight = vec3f(0.61, 0.75, 1.0) * (u.look5.z * u.sun.w * smoothstep(-0.25, 0.35, mu));
    let rainBase = 1.0 - u.weatherStyle.z * mix(0.44, 0.12, saturate(heightFraction(radius)));
    var blend = 0.0;
    var learned = CloudLight(vec3f(0.0), vec3f(0.0), vec3f(0.0));
    let albedo = max(u.density.w, 0.001);
    if (u.sun.w > 0.0) {
        var lighting = groupLight;
        if (!useGroupLight) { lighting = cachedLight(p, radius); }
        blend = neuralEdgeBlend(lighting.w, opacity);
        let terms = lighting.xyz / max(lighting.w, 0.001);
        // The trained targets include one collision's albedo. The final ray integration applies it.
        let bounce = terms.x * bouncedSunScale(mu, u.weatherStyle.z, terms.z);
        learned = CloudLight(sun * (terms.z * scattering * rainBase), sun * (bounce * rainBase / albedo),
            (moon + (u.ambientFloor.rgb + daylight) * (terms.y / albedo)) * rainBase);
        if (blend >= 1.0) { return learned; }
    }
    let light = fittedLight(p, footprint, mu);
    let fill = light.y / albedo;
    let fitted = CloudLight(sun * (light.z * scattering * rainBase), sun * (light.x / albedo * rainBase),
        (moon + (u.ambientFloor.rgb + daylight) * fill) * rainBase);
    return CloudLight(mix(fitted.single, learned.single, blend), mix(fitted.multiple, learned.multiple, blend),
        mix(fitted.sky, learned.sky, blend));
}

fn mainDensity(p: vec3f, t: f32, rd: vec3f, footprint: f32, weather: Weather) -> f32 {
    if (weather.coverage <= 0.001) { return 0.0; }
    let r = length(p);
    let h = heightFraction(r);
    // Distant banks are a spatial LOD. Changing their density with camera height
    // made the same bank thicken or disappear during a climb.
    var bankWeight = 0.0;
    if (DISTANT_BANKS) { bankWeight = 0.336 * u.banks.x * (1.0 - u.weatherStyle.y) * smoothstep(u.banks.y, u.banks.z, t); }
    var local = 0.0;
    if (bankWeight < 0.999) {
        // Only unresolved background rays fade to the density average. The sample interval
        // no longer feeds this filter, so a shell entry or eye-height change cannot turn on a sheet.
        let filtered = farAverageWeight(p, rd, footprint) * smoothstep(28.0, 58.0, t);
        if (filtered < 0.999) {
            let base = cloudBaseWithWeather(p, h, weather, footprint);
            // Clear samples and distant banks need no fine erosion lookup.
            if (base.density > 0.0) {
                local = cloudDetail(p, base, max(footprint, t * u.march2.y * u.look3.y));
                // Thin the sample to the average of the full-detail cloud it
                // stands for. It may only thin: where the filtered cloud is empty, a trace of average
                // density drew ghost patches in clear sky. Near samples resolve the detail already.
                // An even sheet has no detail to lose.
                let near = smoothstep(0.8, 3.0, t) * (1.0 - base.stratiform * u.deckStyle.z);
                if (near > 0.0 && local > 0.0) {
                    local = mix(local, min(local, densityClosure(local, base.density, log2(footprint / 0.06),
                        base.localH, base.h, base.stratiform)), near);
                }
            }
        }
        if (filtered > 0.001) { local = mix(local, meanCloudDensity(weather, h), filtered); }
    }
    var bank = 0.0;
    if (bankWeight > 0.001) { bank = distantBankDensity(p, h, weather, footprint); }
    return mix(local, bank, bankWeight) + altoDensity(p, r, weather, footprint);
}

fn shellSegments(ro: vec3f, rd: vec3f, bottom: f32, top: f32, limit: f32) -> mat2x2f {
    let outer = raySphere(ro, rd, top);
    let first = max(0.0, outer.x);
    let last = min(limit, outer.y);
    if (last <= first) { return mat2x2f(vec2f(0.0), vec2f(0.0)); }
    let inner = raySphere(ro, rd, bottom);
    let split = inner.x < inner.y && inner.y > first;
    let starts = vec2f(first, select(last, max(first, inner.y), split));
    let ends = max(starts, vec2f(select(last, min(last, inner.x), split), last));
    return mat2x2f(starts, ends);
}

fn densityAt(ro: vec3f, rd: vec3f, t: f32, footprint: f32, low: bool) -> f32 {
    let p = ro + rd * t;
    let weather = atlasWeather(p);
    if (low) { return lowCloudDensity(p, length(p), weather, footprint); }
    return mainDensity(p, t, rd, footprint, weather);
}

// One distance stands for everything along a ray when the composite hazes it. Averaged as what the air lets through, a near
// cloud keeps its own haze when something far off shows behind it; the plain mean turned it paler along the horizon.
fn airReach() -> f32 {
    return 1.0 / max(u.atmoRayleigh.y * exp(-1.5 / u.atmoRayleigh.w) + u.atmoMie.y * exp(-1.5 / u.atmoMie.z), 1.0e-3);
}

fn hazeDepth(seen: f32) -> f32 {
    return -airReach() * log(max(seen, 1.0e-20));
}

// Far end and sample spacing (km) of each distance band of the low layer.
fn lowBandStop(band: u32) -> f32 {
    let stops = select(vec4f(62.0, FAR_DEPTH, FAR_DEPTH, FAR_DEPTH), vec4f(2.0, 6.0, 14.0, 30.0), band < 4u);
    return stops[band & 3u];
}

fn lowBandPitch(band: u32) -> f32 {
    let pitches = select(vec4f(2.0, 3.5, 3.5, 3.5), vec4f(0.18, 0.26, 0.46, 1.0), band < 4u);
    return pitches[band & 3u];
}

// Samples on planes fixed in the world, with linear density between them, as in marchStable. Spread over the path of each ray,
// they moved with the camera's height and jumped at the horizon, where the path suddenly doubles: both cut the clouds into discs.
fn marchLowShell(ro: vec3f, rd: vec3f, scene: f32, ground: f32) -> MarchResult {
    var result = MarchResult(vec4f(0.0, 0.0, 0.0, 1.0), scene);
    let clip = min(ground, scene);
    let segments = shellSegments(ro, rd, u.lowCloud.x, u.lowCloud.y, clip);
    let forward = abs(rd);
    var axis = 0u;
    if (forward.y > max(forward.x, forward.z)) { axis = 1u; }
    else if (forward.z > forward.x) { axis = 2u; }
    let axisRate = max(abs(rd[axis]), 0.40);
    let anchor = ro[axis] * sign(rd[axis]) / axisRate;
    // The faint layer in rain needs fewer samples.
    let faint = mix(1.9, 1.0, smoothstep(0.1, 0.5, u.weatherStyle.w));
    // Shaded in groups by distance (groupShares), at their own heights: one point for all of them fell into the empty air
    // between a near and a far cloud and drew grey outlines.
    var groupOpacity = Sum3(0.0);
    var groupDepth = Sum3(0.0);
    var groupHeight = Sum3(0.0);
    var transmittance = 1.0;
    for (var leg = 0u; leg < 2u; leg++) {
        var a = segments[0][leg];
        let limit = segments[1][leg];
        if (a >= limit || transmittance < 0.01) { continue; }
        if (result.depth >= scene) { result.depth = 0.5 * (a + limit); }
        var previousT = a;
        var previousD = select(0.0, -1.0, a <= 0.0);
        for (var band = 0u; band < 6u; band++) {
            let hi = min(limit, lowBandStop(band));
            if (a >= hi) { continue; }
            let width = lowBandPitch(band) * DECK_PITCH_SCALE * faint / axisRate;
            var edge = a + width * (1.0 - fract((a + anchor) / width));
            for (var interval = 0; interval < 48; interval++) {
                let b = min(edge, hi);
                if (b > a) {
                    let t = 0.5 * (a + b);
                    let d = densityAt(ro, rd, t, max(t * u.march2.y, 0.45 * width), true);
                    let d0 = select(previousD, d, previousD < 0.0);
                    let depthKm = 0.5 * (d0 + d) * (t - previousT);
                    if (depthKm > 0.0) {
                        let weight = transmittance * (1.0 - exp(-depthKm * u.density.x));
                        let at = mix(previousT, t, (d0 + 2.0 * d) / max(3.0 * (d0 + d), 1.0e-6));
                        let shares = weight * groupShares(at, vec3f(groupDepth));
                        let grown = vec3f(groupOpacity) + shares;
                        let part = Sum3(shares / max(grown, vec3f(1.0e-9)));
                        groupDepth += Sum3(at - vec3f(groupDepth)) * part;
                        groupHeight += Sum3(lowHeight(ro + rd * at) - vec3f(groupHeight)) * part;
                        groupOpacity = Sum3(grown);
                        transmittance -= weight;
                    }
                    previousT = t;
                    previousD = d;
                }
                a = b;
                if (a >= hi || transmittance < 0.01) { break; }
                edge += width;
            }
            if (a >= limit || transmittance < 0.01) { break; }
        }
        if (previousD > 0.0 && transmittance >= 0.01) {
            // To the end of the ray: as dense as the last sample where terrain ends it, else falling to nothing.
            let weight = transmittance * (1.0 - exp(-previousD * (limit - previousT) * select(0.5, 1.0, limit >= clip) * u.density.x));
            let at = 0.5 * (previousT + limit);
            let shares = weight * groupShares(at, vec3f(groupDepth));
            let grown = vec3f(groupOpacity) + shares;
            let part = Sum3(shares / max(grown, vec3f(1.0e-9)));
            groupDepth += Sum3(at - vec3f(groupDepth)) * part;
            groupHeight += Sum3(lowHeight(ro + rd * at) - vec3f(groupHeight)) * part;
            groupOpacity = Sum3(grown);
            transmittance -= weight;
        }
    }
    let opacity = 1.0 - transmittance;
    if (opacity <= 1.0e-5) { return result; }
    var radiance = vec3f(0.0);
    var shaded = 0.0;
    var seen = 0.0;
    for (var k = 0; k < 3; k++) {
        let share = f32(groupOpacity[k]);
        if (share <= min(0.003, opacity * 0.3)) { continue; }
        let t = f32(groupDepth[k]);
        let p = normalize(ro + rd * t) * mix(u.lowCloud.x, u.lowCloud.y, f32(groupHeight[k]));
        let source = sourceAt(p, rd, max(t * u.march2.y, 0.1), 1.0, true);
        radiance += (source.single + source.multiple + source.sky) * share;
        seen += exp(-t / airReach()) * share;
        shaded += share;
    }
    result.color = vec4f(radiance * (opacity / max(shaded, 1.0e-5) * u.density.w), transmittance);
    result.depth = hazeDepth(seen / max(shaded, 1.0e-5));
    return result;
}

fn lowHeight(p: vec3f) -> f32 {
    return (length(p) - u.lowCloud.x) / (u.lowCloud.y - u.lowCloud.x);
}

// One shading point at the ray's mean depth slides through empty air where a near cloud fades in over a
// far one. That drew grey veins by day and bright-dark lines at dusk, when sun colour changes quickly with depth.
// Here the ray is split softly by depth into up to three groups. Each is shaded inside its own cloud.
// The split is continuous in depth and weight, so it has no threshold to draw a contour along.
fn shadeGroups(integrated: MarchResult, ro: vec3f, rd: vec3f, transmittance: f32,
    groupOpacity: Sum3, groupDepth: Sum3, groupLit: Sum3, light: LightSum) -> MarchResult {
    var result = integrated;
    let opacity = 1.0 - transmittance;
    if (opacity <= 1.0e-5) { return result; }
    var radiance = vec3f(0.0);
    var shaded = 0.0;
    var seen = 0.0;
    for (var k = 0; k < 3; k++) {
        let share = f32(groupOpacity[k]);
        // Three groups cannot all fall below a third of a faint ray's opacity.
        if (share <= min(0.003, opacity * 0.3)) { continue; }
        let t = f32(groupDepth[k]);
        groupLight = vec4f(light[k]) / max(f32(groupLit[k]), 1.0e-6);
        useGroupLight = f32(groupLit[k]) > 1.0e-5;
        let source = sourceAt(ro + rd * t, rd, max(t * u.march2.y, (0.06 + 0.012 * t) * FILTER_SCALE), 1.0, false);
        radiance += (source.single + source.multiple + source.sky) * share;
        seen += exp(-t / airReach()) * share;
        shaded += share;
    }
    useGroupLight = false;
    result.depth = hazeDepth(seen / max(shaded, 1.0e-5));
    result.color = vec4f(radiance * (opacity / max(shaded, 1.0e-5) * u.density.w), transmittance);
    return result;
}

// Far end and sample spacing (km) of each distance band. Functions, because indexing a local array spills it to memory.
fn bandStop(band: u32) -> f32 {
    let stops = select(vec4f(62.0, 90.0, FAR_DEPTH, FAR_DEPTH), vec4f(3.0, 10.0, 22.0, 38.0), band < 4u);
    return stops[band & 3u];
}

fn bandPitch(band: u32) -> f32 {
    let pitches = select(vec4f(0.42, 0.80, 1.30, 1.30), vec4f(0.105, 0.135, 0.185, 0.26), band < 4u);
    return pitches[band & 3u];
}

// How a sample divides over the three depth groups, given the depths so far (0 for an empty group).
fn groupShares(at: f32, depths: vec3f) -> vec3f {
    let behindFirst = select(0.0, smoothstep(0.8, 2.5, at - depths.x), depths.x > 0.0);
    let behindSecond = select(0.0, smoothstep(0.8, 2.5, at - depths.y), depths.y > 0.0);
    return vec3f(1.0 - behindFirst, behindFirst * (1.0 - behindSecond), behindFirst * behindSecond);
}

fn marchStable(ro: vec3f, rd: vec3f, scene: f32, ground: f32, pixel: vec2u) -> MarchResult {
    var result = MarchResult(vec4f(0.0, 0.0, 0.0, 1.0), scene);
    var phaseOffset = 0.0;
    if (u.historyMotion.z >= 1.5 && scene >= FAR_DEPTH) {
        // A small, stratified phase breaks up coherent slices without shifting the ray.
        // With linear density a smooth deck takes a wide shift quietly, and it hides the sample planes there.
        // Small puffs in broken weather flickered with it.
        let spread = mix(0.1, 0.8, smoothstep(0.3, 0.6, u.weatherStyle.y));
        phaseOffset = (fract(ign(vec2f(pixel)) + u.frameInfo.y * 0.61803398875) - 0.5) * spread;
    }
    let motion = length(cross(rd, u.prevInfo.yzw));
    let turn = length(u.camBack.xyz - u.prevBack.xyz);
    var top = cumulusTop();
    if (u.alto.x > 0.0) { top = max(top, u.alto.z); }
    top = min(top, u.planet.z);
    let clip = min(ground, scene);
    let segments = shellSegments(ro, rd, u.planet.y, top, clip);
    let forward = abs(rd);
    var axis = 0u;
    if (forward.y > max(forward.x, forward.z)) { axis = 1u; }
    else if (forward.z > forward.x) { axis = 2u; }
    let axisRate = max(abs(rd[axis]), 0.40);
    let anchor = ro[axis] * sign(rd[axis]) / axisRate;
    let orbitScale = 64.0 / max(u.budget.y, 16.0);
    var groupOpacity = Sum3(0.0);
    var groupDepth = Sum3(0.0);
    var groupLit = Sum3(0.0);
    var light = LightSum(Sum4(0.0), Sum4(0.0), Sum4(0.0));
    var transmittance = 1.0;
    var previousT = 0.0;
    var previousD = 0.0;
    for (var leg = 0u; leg < 2u; leg++) {
        var a = segments[0][leg];
        let limit = segments[1][leg];
        if (a >= limit || transmittance < 0.01) { continue; }
        if (result.depth >= scene) { result.depth = 0.5 * (a + limit); }
        previousT = a;
        // The layer starts empty at its boundary. Inside it, the first sample stands for the gap before it.
        previousD = select(0.0, -1.0, a <= 0.0);
        for (var band = 0u; band < 7u; band++) {
            let hi = min(limit, bandStop(band));
            if (a >= hi) { continue; }
            let farLimit = max(0.0, hi - 90.0) / 40.0;
            // Closure averages are smooth, so broken clouds tolerate wider far samples, which pays for the
            // longer rays through thinner clouds. A smooth deck shows wider samples as contour lines.
            let broken = select(0.0, 1.0 - smoothstep(0.3, 0.55, u.weatherStyle.y), band >= BROKEN_BAND);
            // Linear density also tolerates wider steps near the camera; a deck shows stripes from about 1.2.
            let nearPitch = mix(1.2, 1.15, smoothstep(0.3, 0.55, u.weatherStyle.y));
            let tierPitch = select(mix(PITCH_SCALE, DECK_PITCH_SCALE, smoothstep(0.3, 0.55, u.weatherStyle.y)), FAR_PITCH_SCALE, band >= 3u);
            let width = max(bandPitch(band) * tierPitch * mix(nearPitch, 1.6, broken) * orbitScale / axisRate, farLimit);
            let flow = (motion / max(1.0, a) + turn) / u.march2.y;
            let phase = 0.5 + phaseOffset * (1.0 - smoothstep(0.28, 0.78, flow));
            var edge = a + width * (1.0 - fract((a + anchor) / width));
            // Interval endpoints are fixed in world space within each distance band.
            for (var interval = 0; interval < 84; interval++) {
                let b = min(edge, hi);
                if (b > a) {
                    let t = mix(a, b, phase);
                    let footprint = max(t * u.march2.y, (0.06 + 0.012 * t) * FILTER_SCALE);
                    let d = densityAt(ro, rd, t, footprint, false);
                    // Linear density between samples. One value per step jumped with the step in which a
                    // ray met a deck base, and the fixed sample planes showed as stripes.
                    let d0 = select(previousD, d, previousD < 0.0);
                    let depthKm = 0.5 * (d0 + d) * (t - previousT);
                    let at = mix(previousT, t, (d0 + 2.0 * d) / max(3.0 * (d0 + d), 1.0e-6));
                    previousT = t;
                    previousD = d;
                    if (depthKm > 0.0) {
                        let weight = transmittance * (1.0 - exp(-depthKm * u.density.x));
                        // Running means. As moment over opacity, a nearly clear first contact got a depth near
                        // zero, so the rest of that cloud fell into the next group and drew speckles.
                        let shares = weight * groupShares(at, vec3f(groupDepth));
                        let grown = vec3f(groupOpacity) + shares;
                        groupDepth += Sum3((at - vec3f(groupDepth)) * (shares / max(grown, vec3f(1.0e-9))));
                        groupOpacity = Sum3(grown);
                        if (weight > 0.006) {
                            let q = ro + rd * at;
                            let sampleLight = Sum4(cachedLight(q, length(q)));
                            let lit = Sum3(shares);
                            groupLit += lit;
                            light[0] += sampleLight * lit.x;
                            light[1] += sampleLight * lit.y;
                            light[2] += sampleLight * lit.z;
                        }
                        transmittance -= weight;
                    }
                }
                a = b;
                if (a >= hi || transmittance < 0.01) { break; }
                edge += width;
            }
            if (a >= limit || transmittance < 0.01) { break; }
        }
        if (previousD > 0.0 && transmittance >= 0.01) {
            // From the last sample to the end of the ray: as dense as that sample where terrain ends it, else falling to
            // nothing at the layer's edge. Without it the opacity at a ridge jumped with the sample planes.
            let at = 0.5 * (previousT + limit);
            let weight = transmittance * (1.0 - exp(-previousD * (limit - previousT) * select(0.5, 1.0, limit >= clip) * u.density.x));
            let shares = weight * groupShares(at, vec3f(groupDepth));
            let grown = vec3f(groupOpacity) + shares;
            groupDepth += Sum3((at - vec3f(groupDepth)) * (shares / max(grown, vec3f(1.0e-9))));
            groupOpacity = Sum3(grown);
            transmittance -= weight;
        }
    }
    return shadeGroups(result, ro, rd, transmittance, groupOpacity, groupDepth, groupLit, light);
}

fn traceAndStore(pixel: vec2u, ray: CloudRay, texel: vec2u) {
    let ro = u.camPos.xyz;
    let rd = ray.direction;
    let scene = ray.sceneDistance;
    let planet = raySphere(ro, rd, u.planet.x);
    var ground = FAR_DEPTH;
    if (planet.x < planet.y && planet.y > 0.0) { ground = max(0.0, planet.x); }
    let limb = -dot(ro, rd);
    let thickness = u.planet.z - u.planet.y;
    let orbit = smoothstep(3.0 * thickness, 9.0 * thickness, length(ro) - u.planet.z);
    if (orbit > 0.0 && limb > 0.0) {
        // At orbit the front half of the layer is enough, even along a ray that barely
        // misses the planet. This keeps the rear layer from flashing in at the limb.
        let outer = raySphere(ro, rd, u.planet.z);
        ground = min(ground, mix(max(limb, outer.y), limb, orbit));
    }
    let occupied = u.weatherStyle.x > 0.001
        && (u.coverage.x > 0.001 || u.coverage.y != 0.0 || u.weatherStyle.y > 0.001);
    var result = MarchResult(vec4f(0.0, 0.0, 0.0, 1.0), min(scene, FAR_DEPTH));
    if (occupied) { result = marchStable(ro, rd, scene, ground, pixel); }
    let intermediate = u.march4.y > 0.5;
    if (!intermediate && u.weatherStyle.w > 0.001) {
        let low = marchLowShell(ro, rd, scene, ground);
        // Below the main layer the low one always comes first.
        let lowFirst = length(ro) < u.planet.y || low.depth < result.depth;
        if (low.color.a < 0.9999) {
            let front = select(result.color, low.color, lowFirst);
            let back = select(low.color, result.color, lowFirst);
            let depths = select(vec2f(result.depth, low.depth), vec2f(low.depth, result.depth), lowFirst);
            let shares = vec2f(1.0 - front.a, front.a * (1.0 - back.a));
            let seen = dot(shares, exp(-depths / airReach())) / max(shares.x + shares.y, 1.0e-5);
            result = MarchResult(vec4f(front.rgb + front.a * back.rgb, front.a * back.a), hazeDepth(seen));
        }
    }
    let depth = min(result.depth, FAR_DEPTH);
    textureStore(outColor, vec2i(texel), result.color);
    textureStore(outDepth, vec2i(texel), vec4f(select(depth, -max(depth, 0.001), !intermediate && scene < FAR_DEPTH)));
}

@compute @workgroup_size(8, 4)
fn main(@builtin(global_invocation_id) id: vec3u) {
    if (any(id.xy >= textureDimensions(outColor))) { return; }
    traceAndStore(id.xy, cloudRay(id.xy), id.xy);
}
${CLOUD_RAY_PAIR_ENTRIES_WGSL}
`;
}

// Optical depth of the clouds along the sun, for rays from a plane under the camera. From the weather cube the marcher draws:
// with the live weather it evolved away from the visible clouds, at 0.02 km/s in the game.
export const CLOUD_SHADOW_WGSL = /* wgsl */`
${CLOUD_UNIFORMS_WGSL}${CLOUD_MATH_WGSL}
@group(0) @binding(0) var<uniform> u: CloudUniforms;
@group(0) @binding(1) var shapeTex: texture_3d<f32>;
@group(0) @binding(2) var detailTex: texture_3d<f32>;
@group(0) @binding(3) var weatherTex: texture_3d<f32>;
@group(0) @binding(4) var noiseSampler: sampler;
@group(0) @binding(5) var outShadow: texture_storage_2d<rgba16float, write>;
@group(0) @binding(6) var linearSampler: sampler;
@group(0) @binding(7) var weatherField: texture_cube<f32>;
@group(0) @binding(8) var weatherShift: texture_cube<f32>;
${CLOUD_DENSITY_WGSL}${CLOUD_WEATHER_ATLAS_LOOKUP_WGSL}
${CLOUD_TOP_WGSL}
fn shadowDensity(p: vec3f, r: f32, footprint: f32) -> f32 {
    let h = heightFraction(r);
    let inLowLayer = u.weatherStyle.w > 0.001 && r > u.lowCloud.x && r < u.lowCloud.y;
    if (h <= 0.0 && !inLowLayer) { return 0.0; }
    let weather = atlasWeather(p);
    if (h <= 0.0) { return lowCloudDensity(p, r, weather, footprint); }
    return cloudBaseWithWeather(p, h, weather, footprint).density + altoDensity(p, r, weather, footprint);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(outShadow);
    let texel = vec2u(id.x, id.y + u32(u.lowCloud.w));
    if (any(texel >= size)) { return; }
    let uv = (vec2f(texel) + 0.5) / vec2f(size) - 0.5;
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
            let footprint = 1.5 * extent / f32(size.x);
            var top = cumulusTop();
            if (u.alto.x > 0.0) { top = max(top, u.alto.z); }
            for (var i = 0; i < n; i++) {
                let p = origin + s * (t0 + (f32(i) + 0.5) * dt);
                let r = length(p);
                // The ray climbs, so nothing is left above the highest cloud.
                if (r >= top && dot(p, s) > 0.0) { break; }
                od += shadowDensity(p, r, footprint) * dt;
            }
        }
    }
    textureStore(outShadow, vec2i(texel), vec4f(od, 0.0, 0.0, 1.0));
}
`;

export const CLOUD_WEATHER_CUBE_WGSL = /* wgsl */`
${CLOUD_UNIFORMS_WGSL}${CLOUD_MATH_WGSL}
@group(0) @binding(0) var<uniform> u: CloudUniforms;
@group(0) @binding(1) var shapeTex: texture_3d<f32>;
@group(0) @binding(2) var detailTex: texture_3d<f32>;
@group(0) @binding(3) var weatherTex: texture_3d<f32>;
@group(0) @binding(4) var noiseSampler: sampler;
@group(0) @binding(5) var outWeather: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(6) var outShift: texture_storage_2d_array<rgba16float, write>;
${CLOUD_DENSITY_WGSL}

// Match the coordinate system of filtered cube sampling.
fn faceDirection(face: u32, uv: vec2f) -> vec3f {
    switch face {
        case 0u: { return vec3f(1.0, -uv.y, -uv.x); }
        case 1u: { return vec3f(-1.0, -uv.y, uv.x); }
        case 2u: { return vec3f(uv.x, 1.0, uv.y); }
        case 3u: { return vec3f(uv.x, -1.0, -uv.y); }
        case 4u: { return vec3f(uv.x, -uv.y, 1.0); }
        default: { return vec3f(-uv.x, -uv.y, -1.0); }
    }
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let dim = textureDimensions(outWeather);
    if (any(id.xy >= dim) || id.z >= 6u) { return; }
    let uv = (vec2f(id.xy) + 0.5) * (2.0 / vec2f(dim)) - 1.0;
    let field = sampleWeatherField(faceDirection(id.z, uv), 0.0, vec3f(0.0), 0.0);
    textureStore(outWeather, vec2i(id.xy), i32(id.z), field.shape);
    textureStore(outShift, vec2i(id.xy), i32(id.z), vec4f(field.shift, 0.0));
}
`;
