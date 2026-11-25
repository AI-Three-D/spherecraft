import {
    CLOUD_ATMOSPHERE_WGSL, CLOUD_DENSITY_WGSL, CLOUD_LAYER_BLEND_WGSL, CLOUD_MATH_WGSL, CLOUD_UNIFORMS_WGSL, buildCloudRayInput,
} from './cloudCommon.wgsl.js';
import { CLOUD_VIEW_FIELDS_WGSL } from './cloudViewFields.wgsl.js';

/**
 * The clouds from far above: a few slabs per ray. blend: crossfades from the raymarch, whose result it reads, by lod.x.
 * Each slab is a horizontal layer lit through the column above it, integrated analytically so the bright sunlit skin
 * survives the long slab, plus one density sample towards the sun so clouds keep a lit and a shaded side.
 */
export function buildOrbitShader(blend = false) {
    return /* wgsl */`${CLOUD_UNIFORMS_WGSL}${CLOUD_MATH_WGSL}${CLOUD_ATMOSPHERE_WGSL}
@group(0) @binding(0) var<uniform> u: CloudUniforms;
@group(0) @binding(1) var shapeTex: texture_3d<f32>;
@group(0) @binding(2) var detailTex: texture_3d<f32>;
@group(0) @binding(3) var weatherTex: texture_3d<f32>;
@group(0) @binding(4) var noiseSampler: sampler;
@group(0) @binding(5) var cloudLightLut: texture_2d<f32>;
@group(0) @binding(6) var ambientLut: texture_2d<f32>;
@group(0) @binding(7) var lutSampler: sampler;
@group(0) @binding(8) var outColor: texture_storage_2d<rgba16float, write>;
@group(0) @binding(9) var outDepth: texture_storage_2d<r32float, write>;
@group(0) @binding(10) var sceneDepth: texture_depth_2d;
${blend ? /* wgsl */`@group(0) @binding(11) var marchColor: texture_2d<f32>;
@group(0) @binding(12) var marchDepth: texture_2d<f32>;` : ''}
${CLOUD_DENSITY_WGSL}${buildCloudRayInput()}${CLOUD_LAYER_BLEND_WGSL}${CLOUD_VIEW_FIELDS_WGSL}
fn cloudPhase(cosTheta: f32, scale: f32) -> f32 {
    let forward = henyeyGreenstein(cosTheta, u.phase.x * scale);
    let back = henyeyGreenstein(cosTheta, u.phase.y * scale);
    return mix(forward, back, u.phase.z);
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

fn clearWeather() -> bool {
    return u.weatherStyle.x <= 0.001 || (u.coverage.x <= 0.001 && u.coverage.y == 0.0 && u.weatherStyle.y <= 0.001);
}

const SLAB_SUN_KM: f32 = 0.7;

fn slabLayer(ro: vec3f, rd: vec3f, tScene: f32) -> MarchResult {
    var res: MarchResult;
    res.color = vec4f(0.0, 0.0, 0.0, 1.0);
    res.depth = FAR_DEPTH;
    let outer = raySphere(ro, rd, u.planet.z);
    if (outer.x > outer.y || outer.y <= 0.0) { return res; }
    let inner = raySphere(ro, rd, u.planet.y);
    let t0 = max(outer.x, 0.0);
    var t1 = outer.y;
    if (inner.x < inner.y && inner.x > t0) { t1 = inner.x; }
    t1 = min(t1, tScene);
    if (t1 <= t0) {
        res.depth = tScene;
        return res;
    }
    res.depth = t0 + min(0.5 * (t1 - t0), u.planet.z - u.planet.y);
    if (clearWeather()) { return res; }

    let cameraRadius = length(ro);
    let cameraSun = dot(ro / cameraRadius, u.sun.xyz);
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
    let slabs = i32(u.look3.z);
    let dt = (t1 - t0) / f32(slabs);

    var T = 1.0;
    var L = vec3f(0.0);
    var depthSum = 0.0;
    var weightSum = 0.0;
    var odUp = 0.0;
    let upPerView = max(-dot(rd, up), 0.05);
    for (var i = 0; i < slabs; i++) {
        let t = t0 + (f32(i) + 0.5) * dt;
        let p = ro + rd * t;
        // Noise blur capped at about what the raymarch uses out here. Coverage is a
        // threshold on the noise, so a blurrier lookup (a quarter of a multi-km slab) thinned the
        // clouds out and the far view no longer matched the raymarch from the same place.
        let footprint = max(t * u.march2.y, min(dt * 0.25, 0.3));
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
            let sp = p + dirs[li] * SLAB_SUN_KM;
            let sideR = length(sp);
            let side = cloudBaseWithWeather(sp, heightFraction(sideR), weather, footprint).density
                + altoDensity(sp, sideR, weather, footprint);
            let odL = odAbove[li] + side * u.density.x * SLAB_SUN_KM;
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
            let density = lowCloudDensity(p, r, weather, footprint);
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

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    if (any(id.xy >= textureDimensions(outColor))) { return; }
    let ray = cloudRay(id.xy);
    let tScene = ray.sceneDistance;
    var result = slabLayer(u.camPos.xyz, ray.direction, tScene);
    ${blend ? /* wgsl */`
    let position = vec2i(id.xy);
    result = MarchResult(mix(textureLoad(marchColor, position, 0), result.color, u.lod.x),
        mix(textureLoad(marchDepth, position, 0).x, result.depth, u.lod.x));
    ` : ''}
    if (u.weatherStyle.w > 0.001) {
        let low = marchLowClouds(u.camPos.xyz, ray.direction, tScene);
        if (low.depth < result.depth) { result = blendCloudLayers(low, result); }
        else { result = blendCloudLayers(result, low); }
    }
    textureStore(outColor, vec2i(id.xy), result.color);
    // Negative depth: an opaque surface lay under this texel and its ray stopped there. The composite
    // upsamples such texels only into opaque pixels, and sky texels only into sky pixels.
    let depth = select(result.depth, -max(result.depth, 1.0e-3), tScene < 1.0e29);
    textureStore(outDepth, vec2i(id.xy), vec4f(depth, 0.0, 0.0, 0.0));
}
`;
}

export const CLOUD_ORBIT_WGSL = buildOrbitShader();
export const CLOUD_ORBIT_BLEND_WGSL = buildOrbitShader(true);
