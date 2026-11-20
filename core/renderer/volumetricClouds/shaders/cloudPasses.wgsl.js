import {
    CLOUD_UNIFORMS_WGSL, CLOUD_MATH_WGSL, CLOUD_ATMOSPHERE_WGSL, CLOUD_DENSITY_WGSL,
} from './cloudCommon.wgsl.js';

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
    textureStore(outLut, vec2i(id.xy), vec4f(exp(-od * mix(1.0, k, lowSun)), 1.0));
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

export const CLOUD_RAYMARCH_WGSL = /* wgsl */`${HEADER}${NOISE_BINDINGS}
@group(0) @binding(5) var transLut: texture_2d<f32>;
@group(0) @binding(6) var ambientLut: texture_2d<f32>;
@group(0) @binding(7) var lutSampler: sampler;
@group(0) @binding(8) var outColor: texture_storage_2d<rgba16float, write>;
@group(0) @binding(9) var outDepth: texture_storage_2d<r32float, write>;
@group(0) @binding(10) var sceneDepth: texture_depth_2d;
${CLOUD_DENSITY_WGSL}

// Distance (km) along rd to the nearest opaque surface under this cloud pixel, or 1e30 for sky.
// Nearest, so cloud behind a silhouette never bleeds onto it after upsampling; the cost is a
// sub-pixel gap in the clouds right along the silhouette.
fn sceneDistance(pixel: vec2u, size: vec2u, rd: vec3f) -> f32 {
    if (u.sceneDepth.w < 0.5) { return 1.0e30; }
    let dims = textureDimensions(sceneDepth);
    let lo = (pixel * dims) / size;
    let hi = max(lo, ((pixel + 1u) * dims) / size - 1u);
    let top = dims - 1u;
    let z = min(
        min(textureLoad(sceneDepth, min(lo, top), 0), textureLoad(sceneDepth, min(vec2u(hi.x, lo.y), top), 0)),
        min(textureLoad(sceneDepth, min(vec2u(lo.x, hi.y), top), 0), textureLoad(sceneDepth, min(hi, top), 0)));
    if (z >= 1.0) { return 1.0e30; }
    // View depth from the [0, 1] perspective depth, then along the ray.
    let viewDepth = u.sceneDepth.y / (z + u.sceneDepth.x);
    return viewDepth * u.sceneDepth.z / max(-dot(rd, u.camBack.xyz), 1.0e-4);
}

fn cloudPhase(cosTheta: f32, scale: f32) -> f32 {
    let forward = henyeyGreenstein(cosTheta, u.phase.x * scale);
    let back = henyeyGreenstein(cosTheta, u.phase.y * scale);
    return mix(forward, back, u.phase.z);
}

// Cloud optical depth (unit density * km) towards the sun with doubling steps
// (6 steps reach ~3 km). Near samples reuse the primary sample's weather and
// only the first two add detail erosion.
fn lightOpticalDepth(p: vec3f, footprint: f32, weather: Weather, dir: vec3f) -> f32 {
    var od = 0.0;
    var stepLen = u.march2.x;
    var t = 0.0;
    let steps = i32(u.quality.w);
    for (var i = 0; i < steps; i++) {
        let lp = p + dir * (t + stepLen * 0.5);
        let fp = max(footprint, stepLen * 0.5);
        let h = heightFraction(length(lp));
        var b: CloudBase;
        if (i < 3) {
            b = cloudBaseWithWeather(lp, h, weather, fp);
        } else {
            b = cloudBase(lp, fp);
        }
        var d = b.density;
        if (i < 2 && d > 0.0) { d = cloudDetail(lp, b, fp); }
        od += d * stepLen;
        t += stepLen;
        stepLen *= 2.0;
    }
    return od;
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
        for (var k = 0; k < 3; k++) {
            let ang = f32(k) * 2.0943951;
            let q = p + (east * cos(ang) * 0.87 + north * sin(ang) * 0.87 + up * 0.5) * 0.35;
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
    return 0.5 * c * c * mix(0.6, 1.0, weather.coverage) * u.extra.w;
}

// Radius at which a cloud's sunlight colour is read (look.w; 1 = physical). The air thins out within a
// few km on a small planet (scale height ~2.6 km), so clouds at 6-12 km sit above almost all of it and
// a low sun stayed white on them; read lower, they redden at dusk as Earth's clouds do.
fn cloudLightR(r: f32) -> f32 {
    return u.planet.x + (r - u.planet.x) * select(1.0, u.look.w, u.look.w > 0.0);
}

// Sunlight reaching a cloud at radius r for sun zenith cosine mu, from the LUT (deepened at low sun by
// march3.w, see TRANSMITTANCE_LUT_WGSL) at cloudLightR(r). The deepening is for colour: it also dimmed
// the light, so dusk clouds turned darker than the sky behind them (sunlit ones should be brighter).
// The physical value is recoverable (T^(1/k)); most of its brightness is restored, keeping the hue.
fn cloudSunTransmittance(r: f32, mu: f32) -> vec3f {
    let R = u.planet.x;
    let Rt = u.planet.w;
    let rc = clamp(cloudLightR(r), R, Rt);
    var t = textureSampleLevel(transLut, lutSampler, transmittanceUv(rc, mu, R, Rt), 0.0).rgb;
    let k = select(1.0, mix(1.0, u.march3.w, 1.0 - smoothstep(0.0, 0.2, mu)), u.march3.w > 0.0);
    if (k > 1.001) {
        let lumW = vec3f(0.2126, 0.7152, 0.0722);
        let tp = pow(max(t, vec3f(1.0e-6)), vec3f(1.0 / k));
        t *= pow(dot(tp, lumW) / max(dot(t, lumW), 1.0e-6), 0.8);
    }
    let sinHorizon = R / rc;
    let muHorizon = -sqrt(max(0.0, 1.0 - sinHorizon * sinHorizon));
    return t * smoothstep(-u.atmoExtra.z, u.atmoExtra.z, mu - muHorizon);
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
               sigmaT: f32, powderWeight: f32) -> vec3f {
    let od = lightOpticalDepth(p, footprint, weather, dir) * u.density.x;
    var a = 1.0;
    var b = 1.0;
    var c = 1.0;
    var ms = 0.0;
    for (var k = 0; k < 4; k++) {
        ms += b * cloudPhase(cosTheta, c) * exp(-od * a);
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
               cosTheta: f32, powderWeight: f32) -> vec3f {
    let r = length(p);
    let muS = dot(p / r, u.sun.xyz);
    let sigmaT = density * u.density.x;
    let sigmaS = sigmaT * u.density.w;
    let sunT = cloudSunTransmittance(r, muS) * u.sun.w;
    let sunMax = max(sunT.r, max(sunT.g, sunT.b));
    var sunL = vec3f(0.0);
    if (sunMax > 1.0e-5) {
        sunL = directLight(p, footprint, weather, u.sun.xyz, sunT, cosTheta, sigmaT, powderWeight);
    }
    let skyAmb = textureSampleLevel(ambientLut, lutSampler, ambientUv(muS, 0.0), 0.0).rgb;
    let groundAmb = textureSampleLevel(ambientLut, lutSampler, ambientUv(muS, 1.0), 0.0).rgb;
    // In-scattering probability (u.look.x strength, 0 = off) for the sun and moon terms.
    let probe = inScatterProbability(base.localH, density / mix(0.6, 1.0, weather.coverage));
    // Gain (look.z): the probability is well below 1 over most of a cloud's visible skin; HZD lit
    // its clouds with a correspondingly brighter sun.
    let inScatter = mix(1.0, probe * u.look.z, u.look.x);
    // Sky versus ground-bounce ambient by height: in the layer (h), or within the cloud with HZD
    // lighting (bases lit mostly by the ground, tops by the sky).
    let skyMix = saturate(0.25 + mix(base.h, base.localH * 0.75, u.look.x));
    // Sky light is blocked by the cloud above: two cheap upward samples darken crevices,
    // undersides and the insides of towers, so cloud relief shows even without direct light
    // (at night with the moon down the clouds otherwise looked like flat sheets).
    let skyVis = skyVisibility(p, weather, footprint);
    var amb = mix(groundAmb, skyAmb * skyVis, skyMix) * (u.sun.w * u.light.x) + u.ambientFloor.rgb * skyVis;
    // Dusk sky light (look2.z): with the sun low, the direct light is red and dim while the whole sky
    // still lights the shaded sides blue-lavender. This planet's thin air gives almost no sky light
    // (the ambient LUT is small even by day; cloud shading comes from light scattered inside them), so
    // at dusk the red inner light alone made shadows muddy brown or black. Adds a twilight-sky fill in
    // units of the sun's illuminance, peaking around sunset and gone by ~7 deg below the horizon.
    if (u.look2.z > 0.0) {
        let duskW = (1.0 - smoothstep(0.0, 0.3, muS)) * smoothstep(-0.12, 0.0, muS);
        amb += vec3f(0.32, 0.36, 0.55) * skyVis * (duskW * u.look2.z * 0.05 * u.sun.w);
    }
    // Moonlight: a second directional light with its own light march and moonlit sky,
    // evaluated only while the sun is dim (no extra cost by day). Without it, night clouds
    // only had a uniform fill and read as flat grey from above.
    if (u.moon.w > 0.0) {
        let muM = dot(p / r, u.moon.xyz);
        let moonT = cloudSunTransmittance(r, muM) * u.moon.w;
        let moonMax = max(moonT.r, max(moonT.g, moonT.b));
        if (moonMax > 1.0e-5 && sunMax < moonMax * 20.0) {
            let cosM = dot(rd, u.moon.xyz);
            let powderM = u.phase.w * saturate(0.6 - 0.6 * cosM);
            sunL += directLight(p, footprint, weather, u.moon.xyz, moonT, cosM, sigmaT, powderM);
            let skyAmbM = textureSampleLevel(ambientLut, lutSampler, ambientUv(muM, 0.0), 0.0).rgb;
            let groundAmbM = textureSampleLevel(ambientLut, lutSampler, ambientUv(muM, 1.0), 0.0).rgb;
            amb += mix(groundAmbM, skyAmbM * skyVis, skyMix) * (u.moon.w * u.light.x);
        }
    }
    let S = (sunL * inScatter + amb) * sigmaS;
    return S;
}

struct MarchResult {
    color: vec4f,
    depth: f32,
}

// Sample offset along the ray. With temporal reconstruction a per-pixel jitter is averaged over
// frames; without it (atmoExtra.w) nothing would average it, and the screen-space pattern would
// swim over the clouds as the camera moves, so samples sit at step/slab midpoints instead.
fn sampleJitter(pix: vec2f) -> f32 {
    if (u.atmoExtra.w > 0.5) { return 0.5; }
    return rayJitter(vec2u(pix));
}

fn march(ro: vec3f, rd: vec3f, pix: vec2f, tScene: f32) -> MarchResult {
    var res: MarchResult;
    res.color = vec4f(0.0, 0.0, 0.0, 1.0);
    res.depth = FAR_DEPTH;

    let outer = raySphere(ro, rd, u.planet.z);
    if (outer.x > outer.y || outer.y <= 0.0) { return res; }
    let inner = raySphere(ro, rd, u.planet.y);
    let ground = raySphere(ro, rd, u.planet.x);
    var tGround = tScene;
    if (ground.x < ground.y && ground.y > 0.0) { tGround = min(tGround, max(ground.x, 0.0)); }

    // The shell can be crossed twice (grazing rays from above or inside the layer).
    var segs: array<vec2f, 2>;
    var segCount = 0;
    let s0 = max(outer.x, 0.0);
    if (inner.x < inner.y && inner.y > 0.0) {
        let a = vec2f(s0, min(outer.y, inner.x));
        if (a.y > a.x) { segs[segCount] = a; segCount++; }
        let b = vec2f(max(s0, inner.y), outer.y);
        if (b.y > b.x) { segs[segCount] = b; segCount++; }
    } else {
        segs[0] = vec2f(s0, outer.y);
        segCount = 1;
    }

    // Rays that find no cloud report where cloud would be (the layer, else the ground), so their
    // history and the atmosphere split move with the layer when the camera translates. Reporting
    // "infinitely far" made cloud edges ghost and snap back while climbing or descending.
    if (tGround < 1.0e29) { res.depth = tGround; }
    if (segCount > 0) {
        let first = vec2f(segs[0].x, min(segs[0].y, tGround));
        if (first.y > first.x) { res.depth = first.x + min(0.5 * (first.y - first.x), u.planet.z - u.planet.y); }
    }

    let cosTheta = dot(rd, u.sun.xyz);
    let jitter = sampleJitter(pix);
    let maxSteps = i32(u.march.x);
    // Powder darkening matters most when looking away from the sun.
    let powderWeight = u.phase.w * saturate(0.6 - 0.6 * cosTheta);
    var T = 1.0;
    var L = vec3f(0.0);
    var depthSum = 0.0;
    var weightSum = 0.0;
    var steps = 0;
    // Light sharing (march3.x): light per unit extinction, computed fresh at the first cloud sample
    // after clear air and then every lightReuse-th sample, reused in between. The visible skin is
    // always lit fresh; deeper samples sit behind it.
    let lightReuse = max(i32(u.march3.x), 1);
    var J = vec3f(0.0);
    var lightAge = 0;   // cloud samples since J was computed; 0 forces a fresh one
    var lightT = 0.0;   // where along the ray J was computed

    for (var si = 0; si < segCount; si++) {
        let seg = vec2f(segs[si].x, min(segs[si].y, tGround));
        if (seg.y <= seg.x) { continue; }
        // Steps this segment may use (a later segment keeps a tail of its own).
        let segLimit = maxSteps - (segCount - 1 - si) * MARCH_TAIL_STEPS;
        let maxStep = max(u.march.w, (seg.y - seg.x) / max(u.march.x * 0.5, 1.0));
        // Distance alone sets steps for the longest paths (horizon rays inside the layer). A ray that
        // crosses the layer in a short stretch (from above, or steeply) can afford much finer steps:
        // with shadowInfo.w > 0 the step is capped at the one that spends that fraction of the step
        // budget on this segment. From 40 km up, distance alone gave 0.56 km steps (1.1 km in clear
        // air), so small clouds were hit only where they crossed a sampled shell.
        var fitStep = 1.0e9;
        if (u.shadowInfo.w > 0.0) { fitStep = max((seg.y - seg.x) / (u.march.x * u.shadowInfo.w), u.march.y); }
        // Steps end on planes across the ray at fixed world offsets (dot(p, rd) = n * dq), with dq a
        // power-of-two multiple of the minimum step that grows with distance. Moving the camera then
        // slides each sample within its plane instead of dragging step slices through the cloud,
        // which showed as boxes up close and a crawling pattern when climbing or descending. The
        // jitter only shifts the grid's phase (per pixel and frame with temporal reconstruction).
        let rayOffset = dot(ro, rd);
        var t = seg.x;
        // Midpoint of the last empty coarse sample, and the fine-step span after a found surface.
        var lastEmpty = -1.0;
        var fineUntil = -1.0;
        var fineStep = 0.0;
        loop {
            if (t >= seg.y || steps >= segLimit || T < 0.003) { break; }
            steps++;
            // Running out of steps before the end of the layer: cover the rest in even coarse steps
            // with the far average. Stopping there left long in-layer paths near the horizon empty (a
            // band of clear sky through the clouds), and the cut moved with the camera height.
            let tail = steps > segLimit - MARCH_TAIL_STEPS;
            let wantFar = clamp(t * u.march.z, u.march.y, maxStep);
            let want = clamp(min(wantFar, fitStep), u.march.y, maxStep);
            let dq = u.march.y * exp2(floor(log2(want / u.march.y)));
            // The far-average switch keeps measuring the distance-based step, so finer steps do not
            // bring back the far grazing band it calms.
            let dqFar = u.march.y * exp2(floor(log2(wantFar / u.march.y)));
            let fine = t < fineUntil && !tail;
            var cellEnd: f32;
            if (tail) {
                cellEnd = t + (seg.y - t) / f32(segLimit - steps + 1);
            } else if (fine) {
                cellEnd = min(t + fineStep, fineUntil);
            } else {
                let phase = rayOffset + jitter * dq;
                cellEnd = dq * (floor((t + phase) / dq) + 1.0) - phase;
                if (cellEnd - t < dq * 0.01) { cellEnd += dq; }
            }
            cellEnd = min(cellEnd, seg.y);
            let dt = max(cellEnd - t, 1.0e-4);
            let tm = t + 0.5 * dt;
            let p = ro + rd * tm;
            // Prefilter to the step as well as the pixel cone, so long distant steps do not alias.
            // In the quarter steps behind a found surface (fine), blur to that step: the visible skin keeps
            // its fine billows (blurred to the coarse step they were lost, and clouds looked smooth).
            let footprint = max(tm * u.march2.y, select(select(dq, dt, tail), dt, fine) * u.ambientFloor.w);
            let weather = sampleWeather(p, footprint);
            // The far-average weight keeps its own measure (half a step), independent of the prefilter
            // width: tying it to stepFootprint switched the surface refinement below off at medium range,
            // and the step planes then cut the cloud tops into terraces that slid as moire stripes.
            let farW = select(farAverageWeight(p, rd, max(tm * u.march2.y, dqFar * 0.5)), 1.0, tail);
            var base = cloudBaseWithWeather(p, heightFraction(length(p)), weather, footprint);
            // Far, grazing samples fade from individual clouds to their average density (see
            // farAverageWeight), so the far band does not alias while the camera moves.
            let meanD = select(0.0, meanCloudDensity(weather, base.h), farW > 0.001);
            if (base.density <= 0.0 && meanD * farW <= 0.0) {
                lastEmpty = tm;
                lightAge = 0;
                t = select(cellEnd + dq, cellEnd, fine || tail);
                continue;
            }
            // Stepping from empty air into cloud on the coarse grid: bisect for the surface between the
            // two samples and march quarter steps from it for one coarse step. Coarse samples alone
            // cut a dense deck's top into terraces along the step planes, and those slid (moire) as
            // the camera moved; the skin is what shows, deeper samples sit behind opaque cloud.
            // Refine wherever a sharp top can still show (until the far average has nearly taken over).
            if (!fine && !tail && lastEmpty >= 0.0 && u.extra.x > 0.5 && farW < 0.9) {
                var lo = lastEmpty;
                var hi = tm;
                for (var b = 0; b < 5; b++) {
                    let mid = 0.5 * (lo + hi);
                    let q = ro + rd * mid;
                    if (cloudBaseWithWeather(q, heightFraction(length(q)), weather, footprint).density > 0.0) {
                        hi = mid;
                    } else {
                        lo = mid;
                    }
                }
                fineStep = dq * 0.25;
                fineUntil = lo + dq;
                t = lo;
                lastEmpty = -1.0;
                continue;
            }
            var density = 0.0;
            if (base.density > 0.0 && farW < 0.999) { density = cloudDetail(p, base, footprint); }
            density = mix(density, meanD, farW);
            if (density > 0.0) {
                let sigmaT = density * u.density.x;
                if (lightAge == 0 || lightAge >= lightReuse || tm - lightT > u.march3.y) {
                    J = cloudSource(p, rd, footprint, weather, base, density, cosTheta, powderWeight)
                        / max(sigmaT, 1.0e-5);
                    lightAge = 0;
                    lightT = tm;
                }
                lightAge++;
                let stepT = exp(-sigmaT * dt);
                L += T * J * (1.0 - stepT);
                let w = T * (1.0 - stepT);
                depthSum += tm * w;
                weightSum += w;
                T *= stepT;
            }
            t = cellEnd;
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
// Fixed-height slices of the near-ground proxy (camera below the layer).
const PROXY_SHELLS: i32 = 16;
// Density samples per shell crossing (lighting stays at one per crossing).
const PROXY_SUBSAMPLES: i32 = 4;
const PROXY_SUN_KM: f32 = 0.7;

fn proxyLayer(ro: vec3f, rd: vec3f, pix: vec2f, tScene: f32) -> MarchResult {
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

    let mid = ro + rd * (0.5 * (t0 + t1));
    let rMid = length(mid);
    let up = mid / rMid;
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
        lightT[li] = cloudSunTransmittance(rMid, mu) * illum[li];
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
    let dt = (t1 - t0) / f32(PROXY_SLABS);
    let jitter = sampleJitter(pix);

    var T = 1.0;
    var L = vec3f(0.0);
    var depthSum = 0.0;
    var weightSum = 0.0;
    var odUp = 0.0;
    let upPerView = max(-dot(rd, up), 0.05);
    // From below the layer (the near-ground proxy): one sample per fixed-height slice the ray
    // crosses, weighted by its exact length, lit with the raymarch's own cloudSource (light marches
    // toward the sun and moon, sky visibility). The slices sit at the same world heights for every
    // pixel and camera position, so shapes match the raymarch and stay put while moving; the shared
    // lighting keeps dusk and night the same (a slab model lit through the column above went dark at
    // low sun while the raymarch lights clouds through the gaps).
    if (dot(ro, ro) < u.planet.y * u.planet.y) {
        let bq = dot(ro, rd);
        let cq = dot(ro, ro);
        let dr = (u.planet.z - u.planet.y) / f32(PROXY_SHELLS);
        // Stop at the planet as well as the scene depth (water does not write depth): rays that
        // pointed down otherwise passed through the planet and showed the layer on the far side.
        var tEnd = tScene;
        let ground = raySphere(ro, rd, u.planet.x);
        if (ground.x < ground.y && ground.y > 0.0) { tEnd = min(tEnd, max(ground.x, 0.0)); }
        let cosTheta = dot(rd, u.sun.xyz);
        let powderWeight = u.phase.w * saturate(0.6 - 0.6 * cosTheta);
        var T = 1.0;
        var L = vec3f(0.0);
        var depthSum = 0.0;
        var weightSum = 0.0;
        for (var k = 0; k < PROXY_SHELLS; k++) {
            if (T < 0.003) { break; }
            let rLo = u.planet.y + f32(k) * dr;
            let rHi = rLo + dr;
            let a = max(-bq + sqrt(max(bq * bq - cq + rLo * rLo, 0.0)), 0.0);
            let b = min(-bq + sqrt(max(bq * bq - cq + rHi * rHi, 0.0)), tEnd);
            if (b <= a) { continue; }
            let len = b - a;
            let t = 0.5 * (a + b);
            // Noise blurred as the raymarch blurs it at this distance (its step times stepFootprint,
            // continuous here), so the proxy is as soft and wispy as the raymarch above it.
            let footprint = max(t * u.march2.y,
                clamp(t * u.march.z, u.march.y, u.march.w) * u.ambientFloor.w);
            let weather = sampleWeather(ro + rd * t, t * u.march2.y);
            // Density in PROXY_SUBSAMPLES stretches of the crossing (cheap: shape and detail, one weather
            // lookup), light once (cloudSource, the expensive part) at their extinction-weighted
            // position. One density sample per crossing drew each shell as a flat slice: horizontal
            // stripes and toothed outlines.
            let sub = len / f32(PROXY_SUBSAMPLES);
            let tIn = T;
            var pSum = vec3f(0.0);
            var dSum = 0.0;
            var hSum = 0.0;
            var wSum = 0.0;
            for (var i = 0; i < PROXY_SUBSAMPLES; i++) {
                let ti = a + (f32(i) + 0.5) * sub;
                let p = ro + rd * ti;
                let base = cloudBaseWithWeather(p, heightFraction(length(p)), weather, footprint);
                let farW = farAverageWeight(p, rd, ti * u.march2.y);
                var density = 0.0;
                if (base.density > 0.0 && farW < 0.999) { density = cloudDetail(p, base, footprint); }
                density = mix(density, meanCloudDensity(weather, base.h), farW);
                if (density <= 0.0) { continue; }
                let stepT = exp(-density * u.density.x * sub);
                let w = T * (1.0 - stepT);
                pSum += p * w;
                dSum += density * w;
                hSum += base.localH * w;
                wSum += w;
                depthSum += ti * w;
                weightSum += w;
                T *= stepT;
            }
            if (wSum <= 1.0e-6) { continue; }
            let pL = pSum / wSum;
            let dL = dSum / wSum;
            // cloudSource reads only the height fractions from the base.
            var baseL: CloudBase;
            baseL.h = heightFraction(length(pL));
            baseL.localH = hSum / wSum;
            let S = cloudSource(pL, rd, footprint, weather, baseL, dL, cosTheta, powderWeight);
            // S is per unit length; per unit extinction it is the source each stretch scatters with
            // weight T (1 - stepT), and those weights sum to tIn - T.
            L += S / max(dL * u.density.x, 1.0e-5) * (tIn - T);
        }
        res.color = vec4f(L, T);
        if (weightSum > 1.0e-4) { res.depth = depthSum / weightSum; }
        return res;
    }
    for (var i = 0; i < PROXY_SLABS; i++) {
        let t = t0 + (f32(i) + jitter) * dt;
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
        density = mix(density, meanCloudDensity(weather, base.h), farW);
        if (density <= 0.0) { continue; }
        let sigmaT = density * u.density.x;
        let sigmaS = sigmaT * u.density.w;
        let stepT = exp(-sigmaT * dt);
        var directL = vec3f(0.0);
        for (var li = 0; li < 2; li++) {
            if (max(lightT[li].r, max(lightT[li].g, lightT[li].b)) <= 1.0e-5) { continue; }
            let sp = p + dirs[li] * PROXY_SUN_KM;
            let side = cloudBaseWithWeather(sp, heightFraction(length(sp)), weather, footprint).density;
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
        let ambient = (mix(ambGround, ambSky * skyVis, saturate(0.25 + base.h)) * u.light.x + amb * skyVis);
        L += T * sigmaS * (directL + ambient * (1.0 - stepT) / sigmaT);
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

// One invocation per interleave block: renders this frame's pixel of the k x k block.
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let blocks = textureDimensions(outColor);
    if (id.x >= blocks.x || id.y >= blocks.y) { return; }
    let size = vec2u(u.frameInfo.zw);
    let pixel = min(id.xy * u32(u.quality.x) + vec2u(u.quality.yz), size - 1u);
    let pix = vec2f(pixel) + 0.5;
    let rd = cameraRay(pix, vec2f(size), u.camRight, u.camUp, u.camBack, u.frameInfo.x);
    // Far-proxy weight comes from camera height; both paths run only inside the crossfade band.
    let proxyWeight = u.lod.x;
    let tScene = sceneDistance(pixel, size, rd);
    var result: MarchResult;
    if (proxyWeight < 0.999) { result = march(u.camPos.xyz, rd, pix, tScene); }
    if (proxyWeight > 0.001) {
        let proxy = proxyLayer(u.camPos.xyz, rd, pix, tScene);
        if (proxyWeight >= 0.999) {
            result = proxy;
        } else {
            result.color = mix(result.color, proxy.color, proxyWeight);
            result.depth = mix(result.depth, proxy.depth, proxyWeight);
        }
    }
    textureStore(outColor, vec2i(id.xy), result.color);
    // Negative depth: an opaque surface lay under this texel and its ray stopped there. The composite
    // upsamples such texels only into opaque pixels, and sky texels only into sky pixels.
    let depthOut = select(result.depth, -max(result.depth, 1.0e-3), tScene < 1.0e29);
    textureStore(outDepth, vec2i(id.xy), vec4f(depthOut, 0.0, 0.0, 0.0));
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
        if (u.atmoExtra.w > 0.5) {
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
