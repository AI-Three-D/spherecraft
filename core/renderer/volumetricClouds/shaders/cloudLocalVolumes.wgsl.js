import {
    CLOUD_ATMOSPHERE_WGSL, CLOUD_MATH_WGSL, CLOUD_SHADOW_LOOKUP_WGSL, CLOUD_SHAPE_SIGNAL_WGSL, CLOUD_UNIFORMS_WGSL, NOISE_ROTATIONS_WGSL,
} from './cloudCommon.wgsl.js';
import { CLOUD_HAZE_LOOKUP_WGSL, CLOUD_HAZE_STRUCT_WGSL } from './cloudCompositeParts.wgsl.js';
import { CLOUD_COMPOSITE_UNIFORMS_WGSL } from './cloudCompositeUniforms.wgsl.js';
import { CLOUD_LAND_SHADE_LOOKUP_WGSL, LAND_FRAME_WGSL } from './cloudLandMap.wgsl.js';

export const LOCAL_VOLUME_UNIFORMS_WGSL = /* wgsl */`
struct LocalVolumes {
    fog: vec4f,   // fog on mountains: amount in wet weather (0..1), extinction (1/km), reach (km), opacity at most
    mist: vec4f,  // amount, extinction (1/km), reach (km), first slice (km)
    mist2: vec4f, // wetland, forest and hollow share, time of day factor
    mist3: vec4f, // x opacity at most, y first distance of the fog's slices (km), z mist banks on any ground, w life of a wisp (s)
    wind: vec4f,  // xyz wind near the ground, level at the camera (km/s), w clock of the wisps (lives)
    drift: vec4f, // xyz how far that wind has carried the patches (km), w clouds on summits in fair weather (0..1)
}
`;

const LAND_LOOKUP_WGSL = /* wgsl */`
// Sunlight below the clouds and over the land. The shadow map is gone with the sun at the horizon, where the strength of the deck stands in:
// without it the fog shone under a dark sky at dusk.
fn sunlightAt(p: vec3f, r: f32) -> vec3f {
    let mu = dot(p / r, u.sun.xyz);
    let light = sunTransmittance(cloudLightLut, linearSampler, r, mu, u.planet.x, u.planet.w) * u.sun.w;
    let under = mix(1.0, 0.1, deckCover());
    return light * (mix(under, cloudShadowAt(p, 1.0), smoothstep(0.06, 0.16, mu)) * smoothstep(-0.06, 0.08, mu) * sunOverLand(p, r));
}

fn deckCover() -> f32 {
    return smoothstep(0.3, 0.8, u.weatherStyle.y) * u.weatherStyle.x * saturate(1.6 * u.deckStyle.x * u.deckStyle.y);
}

// Light from all around, as the ground mist has it (cloudCompositeParts): sky by day, moon and night fill.
fn skyLight(p: vec3f, r: f32) -> vec3f {
    let up = p / r;
    let mu = dot(up, u.sun.xyz);
    // A deck dims and greys it.
    let grey = deckCover();
    let sky = mix(vec3f(0.61, 0.75, 1.0), vec3f(0.46, 0.475, 0.50), grey) * (0.045 * u.sun.w * smoothstep(-0.2, 0.35, mu));
    return sky + vec3f(0.08, 0.10, 0.15) * (u.moon.w * smoothstep(-0.08, 0.25, dot(up, u.moon.xyz))) + u.ambientFloor.rgb;
}

// Wisps live and die: two sets take turns, each carried along by the wind while it shows, and started over somewhere else
// while the other one shows. So they can follow any wind without ever being stretched. The phases go by place, or the whole
// field would pulse.
struct Wisps {
    age: vec2f,   // 0 forming .. 1 gone
    share: vec2f,
    first: vec3f, // offsets of the two sets
    second: vec3f,
}

fn wispsAt(place: f32) -> Wisps {
    let clock = local.wind.w + place;
    let seed = vec3f(0.37, 0.71, 0.19);
    var w: Wisps;
    w.age = fract(vec2f(clock, clock + 0.5));
    w.share = 1.0 - abs(2.0 * w.age - 1.0);
    w.first = fract(seed * floor(clock));
    w.second = fract(seed * floor(clock + 0.5) + 0.5);
    return w;
}
`;

// Low clouds on mountains, in a volume over screen and distance (rgb light with the haze before it, a transmittance up to the
// slice), over the slopes of the wide and middle land maps. In wet weather torn fog in patches of uneven depth, with clear
// slopes between; in fair weather now and then a small cloud on the lee of a summit. The wind carries its wisps up the near
// side, around the flanks and down the lee, where they dissolve. No history and no jitter: its depth is integrated exactly
// over each cell and the noise is filtered to the cells, so nothing slices or flickers.
export const CLOUD_MOUNTAIN_FOG_WGSL = /* wgsl */`
${CLOUD_UNIFORMS_WGSL}${CLOUD_MATH_WGSL}${CLOUD_ATMOSPHERE_WGSL}${LAND_FRAME_WGSL}${LOCAL_VOLUME_UNIFORMS_WGSL}${CLOUD_COMPOSITE_UNIFORMS_WGSL}
@group(0) @binding(0) var<uniform> u: CloudUniforms;
@group(0) @binding(1) var shapeTex: texture_3d<f32>;
@group(0) @binding(2) var noiseSampler: sampler;
@group(0) @binding(3) var linearSampler: sampler;
@group(0) @binding(4) var cloudLightLut: texture_2d<f32>;
@group(0) @binding(5) var shadowMap: texture_2d<f32>;
@group(0) @binding(6) var wideMap: texture_2d<f32>;
@group(0) @binding(7) var<uniform> wide: LandFrame;
@group(0) @binding(8) var<uniform> local: LocalVolumes;
@group(0) @binding(9) var outFog: texture_storage_3d<rgba16float, write>;
@group(0) @binding(10) var middleMap: texture_2d<f32>;
@group(0) @binding(11) var<uniform> middle: LandFrame;
@group(0) @binding(12) var reliefMap: texture_2d<f32>;
@group(0) @binding(13) var<uniform> cu: CompositeUniforms;
@group(0) @binding(14) var hazeRadiance: texture_3d<f32>;
@group(0) @binding(15) var hazeTransmittance: texture_3d<f32>;
@group(0) @binding(16) var landShade: texture_2d<f32>;
${CLOUD_SHADOW_LOOKUP_WGSL}${CLOUD_LAND_SHADE_LOOKUP_WGSL}${LAND_LOOKUP_WGSL}${NOISE_ROTATIONS_WGSL}${CLOUD_SHAPE_SIGNAL_WGSL}${CLOUD_HAZE_STRUCT_WGSL}${CLOUD_HAZE_LOOKUP_WGSL}
// How far away the wisps are carried along (km). Farther off they only drift.
override FLOW_REACH: f32 = 8.0;

// Beyond this height above the slope (km) there is nothing.
const TOP: f32 = 0.85;

struct Slope {
    above: f32,  // height above the slope, along its normal (km)
    weight: f32, // share of fog that may lie here
    part: f32,   // height on what stands out of the land: 0 its foot, 1 its top
    tilt: vec3f, // uphill, kilometres per kilometre
}

fn slopeAt(p: vec3f) -> Slope {
    let altitude = length(p) - wide.up.w;
    var height = 0.0;
    var weight = 0.0;
    var tilt = vec3f(0.0);
    let uv = landUv(middle, p);
    let far = landUv(wide, p);
    let edge = min(min(far.x, 1.0 - far.x), min(far.y, 1.0 - far.y));
    // Near the camera, not near the map's middle: the map moves in steps.
    let inner = middle.info.w * (1.0 - smoothstep(4.0, 6.0, distance(p, u.camPos.xyz)))
        * smoothstep(0.0, 0.02, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));
    if (inner < 1.0) {
        let m = textureSampleLevel(wideMap, linearSampler, far, 0.0);
        height = m.x + wide.e2.w;
        weight = m.y * smoothstep(0.0, 0.06, edge);
        tilt = wide.e1.xyz * m.z + wide.e2.xyz * m.w;
    }
    if (inner > 0.0) {
        let m = textureSampleLevel(middleMap, linearSampler, uv, 0.0);
        height = mix(height, m.x + middle.e2.w, inner);
        weight = mix(weight, m.y, inner);
        tilt = mix(tilt, middle.e1.xyz * m.z + middle.e2.xyz * m.w, inner);
    }
    var part = 0.0;
    if (weight > 0.0) {
        let relief = textureSampleLevel(reliefMap, linearSampler, far, 0.0).xy + wide.e2.w;
        part = (altitude - relief.y) / max(relief.x - relief.y, 0.05);
    }
    let drop = altitude - height;
    return Slope(drop / sqrt(1.0 + dot(tilt, tilt)), weight, part, tilt);
}

// The wind near a slope (km/s). The mountain holds up what blows into it, so more goes around; the rest follows the ground.
fn slopeWind(up: vec3f, tilt: vec3f, above: f32) -> vec3f {
    let wind = local.wind.xyz - up * dot(local.wind.xyz, up);
    let steep = length(tilt);
    let uphill = tilt / max(steep, 1.0e-3);
    let close = exp(-max(above, 0.0) / 0.3);
    let held = 0.7 * close * smoothstep(0.1, 0.8, steep);
    let level = wind - uphill * (dot(wind, uphill) * held);
    return level + up * (dot(level, tilt) * close);
}

struct Fog {
    density: f32, // 0 to 1, apart from its profile out from the slope
    depth: f32,   // scale of that profile
    lift: f32,    // and how far it is raised (km)
}

fn fogAt(p: vec3f, r: f32, slope: Slope, t: f32, footprint: f32) -> Fog {
    var fog = Fog(0.0, 1.0, 0.0);
    let amount = local.fog.x;
    // Fair weather leaves only the summits.
    if (slope.weight < 0.01 || (amount <= 0.02 && slope.part < 0.55)) { return fog; }
    let up = p / r;
    // Some mountains have fog now, others less.
    let chosen = textureSampleLevel(shapeTex, noiseSampler, ROT_LARGE * ((p - local.drift.xyz) / 37.0) + vec3f(0.21, 0.57, 0.36), 2.0);
    let wet = amount * smoothstep(0.2, 0.5, chosen.r + 0.3 * amount);
    let capped = local.drift.w * smoothstep(0.5, 0.62, chosen.g) * smoothstep(0.55, 0.9, slope.part);
    if (max(wet, capped) < 0.02) { return fog; }
    let tile = 2.9;
    let q = p - local.drift.xyz;
    let n = textureSampleLevel(shapeTex, noiseSampler, ROT_REGIONAL * (q / tile) + vec3f(0.13, 0.71, 0.45),
        max(0.0, log2(footprint / tile * SHAPE_TEXELS)));
    // Rising air makes it, sinking air dissolves it.
    let wind = local.wind.xyz / max(length(local.wind.xyz), 1.0e-4);
    let rising = dot(wind, slope.tilt) / (0.35 + length(slope.tilt));
    let larger = shapeSignal(n);
    // Wet weather: patches at their own heights, dense in the middle and torn at the edges.
    let body = larger + 0.15 * rising + 0.3 * (wet - 1.0);
    let zone = smoothstep(0.02, 0.4, slope.part - 0.55 * (n.b - 0.35)) * (1.0 - 0.75 * smoothstep(0.75, 1.15, slope.part + 0.9 * (n.g - 0.6)));
    let patched = smoothstep(0.5, 1.05, body) * zone;
    // Fair weather: on the lee of the summit, denser, with clearer edges.
    let lee = smoothstep(0.45, -0.15, rising) * capped;
    if (wet * patched <= 0.002 && lee <= 0.1) { return fog; }
    // Wisps: drawn out along the level, bent by the larger pattern, carried by the wind along the slope.
    let small = 1.8;
    let base = ROT_SYSTEM * ((p + up * (1.1 * (r - wide.up.w) + u.lod.y * 0.1)) / small) + (n.gba - 0.5) * 0.5;
    let lod = max(0.0, log2(2.1 * footprint / small * SHAPE_TEXELS));
    let far = smoothstep(0.5, 1.0, t / FLOW_REACH);
    let wisps = wispsAt(1.7 * n.a);
    // Far off one set only drifts. The two patterns are blended: no offset that keeps growing may vary over space.
    var n2 = vec4f(0.0);
    if (far < 1.0) {
        let carry = ROT_SYSTEM * (slopeWind(up, slope.tilt, slope.above) * (local.mist3.w / small));
        // They spread as they age.
        n2 = textureSampleLevel(shapeTex, noiseSampler, base - carry * (wisps.age.x - 0.5) + wisps.first, lod + wisps.age.x) * wisps.share.x
            + textureSampleLevel(shapeTex, noiseSampler, base - carry * (wisps.age.y - 0.5) + wisps.second, lod + wisps.age.y) * wisps.share.y;
    }
    if (far > 0.0) { n2 = mix(n2, textureSampleLevel(shapeTex, noiseSampler, base - ROT_SYSTEM * (local.drift.xyz / small), lod), far); }
    let fine = shapeSignal(n2) - 0.55;
    let torn = smoothstep(0.3, 0.95, patched + 0.9 * fine) * smoothstep(0.0, 0.25, patched);
    let cap = smoothstep(0.35, 0.9, 0.75 * lee * smoothstep(0.35, 0.95, larger) + 1.2 * fine) * smoothstep(0.1, 0.4, lee);
    fog.density = slope.weight * max(wet * torn * torn, 0.8 * cap);
    fog.depth = mix(mix(0.4, 1.5, smoothstep(0.35, 0.8, n.b)), 0.6, smoothstep(0.0, 0.3, cap - torn));
    fog.lift = mix(0.09, 0.3, saturate(4.0 * (cap - torn))) * (n2.g - 0.5);
    return fog;
}

// Profile out from the slope: most of it a little above, with a long soft end.
const MIDDLE: f32 = 0.09;
const DEPTH: f32 = 0.17;

fn depthProfile(x: f32, scale: f32) -> f32 {
    let c = 1.0 / cosh(clamp((x - MIDDLE * scale) / (DEPTH * scale), -9.0, 9.0));
    return c * c;
}

// Its mean over a step whose height above the slope goes evenly from a to b.
fn depthMean(a: f32, b: f32, scale: f32) -> f32 {
    let depth = DEPTH * scale;
    if (abs(b - a) < 0.1 * depth) { return depthProfile(0.5 * (a + b), scale); }
    return depth * (tanh((b - MIDDLE * scale) / depth) - tanh((a - MIDDLE * scale) / depth)) / (b - a);
}

fn fogLight(p: vec3f, r: f32, rd: vec3f, tilt: vec3f, above: f32, density: f32) -> vec3f {
    let up = p / r;
    let mu = dot(rd, u.sun.xyz);
    // The mountain shades the fog on its far side.
    let facing = dot(normalize(up - tilt), u.sun.xyz);
    let sun = sunlightAt(p, r) * smoothstep(-0.35, 0.35, facing);
    // Thin and wet: bright against the sun.
    let phase = mix(henyeyGreenstein(mu, 0.6), henyeyGreenstein(mu, -0.2), 0.45);
    // Its upper side is lit, what lies under it less, and the thick parts shade themselves.
    let height = smoothstep(-0.02, 0.3, above);
    let open = mix(1.0, mix(0.45, 1.0, height), saturate(1.4 * density));
    return sun * ((phase * 0.25 + 0.036) * open) + skyLight(p, r) * (0.8 * mix(1.0, open, 0.6));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(outFog);
    if (any(id.xy >= size.xy)) { return; }
    let uv = (vec2f(id.xy) + 0.5) / vec2f(size.xy);
    let ro = u.camPos.xyz;
    let rd = cameraRay(uv, vec2f(1.0), u.camRight, u.camUp, u.camBack, u.frameInfo.x);
    let cellAngle = 2.0 / (u.camUp.w * f32(size.y));
    let top = wide.up.w + wide.info.x + TOP;
    let shell = raySphere(ro, rd, top);
    let ground = raySphere(ro, rd, u.planet.x - 1.0);
    var last = max(shell.y, 0.0);
    if (ground.x < ground.y && ground.x > 0.0) { last = min(last, ground.x); }
    var T = 1.0;
    var light = vec3f(0.0);
    var t0 = 0.0;
    var a = slopeAt(ro);
    textureStore(outFog, vec3u(id.xy, 0u), vec4f(0.0, 0.0, 0.0, 1.0));
    for (var slice = 1u; slice < size.z; slice++) {
        let t1 = local.mist3.y * (exp2(f32(slice) / f32(size.z - 1u) * log2(1.0 + local.fog.z / local.mist3.y)) - 1.0);
        if (t0 < last && T > 0.02) {
            let b = slopeAt(ro + rd * t1);
            if (max(a.weight, b.weight) > 0.002 && min(a.above, b.above) < TOP && max(a.above, b.above) > -TOP) {
                // Where in the cell most of the fog is.
                let near = vec2f(depthProfile(a.above, 1.5), depthProfile(b.above, 1.5)) + 1.0e-3;
                let share = (0.25 * near.x + 0.75 * near.y) / (near.x + near.y);
                let t = mix(t0, t1, share);
                let p = ro + rd * t;
                let r = length(p);
                let fade = (1.0 - smoothstep(0.7, 1.0, t / local.fog.z)) * smoothstep(0.0, 0.3, t);
                let under = 1.0 - smoothstep(0.55, TOP, mix(a.above, b.above, share));
                if (depthMean(a.above, b.above, 1.5) * fade * under > 4.0e-3) {
                    let tilt = mix(a.tilt, b.tilt, share);
                    let slope = Slope(mix(a.above, b.above, share), mix(a.weight, b.weight, share) * fade, mix(a.part, b.part, share), tilt);
                    let fog = fogAt(p, r, slope, t, max(0.7 * t * cellAngle, 0.5 * (t1 - t0)));
                    let tau = fog.density * depthMean(a.above - fog.lift, b.above - fog.lift, fog.depth)
                        * under * local.fog.y * (t1 - t0);
                    if (tau > 1.0e-4) {
                        let w = T * (1.0 - exp(-tau));
                        let haze = lookupHaze(uv, t);
                        light += w * (fogLight(p, r, rd, tilt, slope.above, fog.density) * haze.T + haze.L);
                        T -= w;
                    }
                }
            }
            a = b;
        }
        t0 = t1;
        textureStore(outFog, vec3u(id.xy, slice), vec4f(light, T));
    }
}
`;

// Mist lying on marsh, in woods and in hollows near the camera, in a volume over screen and distance (rgb light, a
// transmittance up to the slice). Its height is integrated over each cell, so thin layers neither flicker nor band.
export const CLOUD_LOCAL_MIST_WGSL = /* wgsl */`
${CLOUD_UNIFORMS_WGSL}${CLOUD_MATH_WGSL}${CLOUD_ATMOSPHERE_WGSL}${LAND_FRAME_WGSL}${LOCAL_VOLUME_UNIFORMS_WGSL}
@group(0) @binding(0) var<uniform> u: CloudUniforms;
@group(0) @binding(1) var shapeTex: texture_3d<f32>;
@group(0) @binding(2) var noiseSampler: sampler;
@group(0) @binding(3) var linearSampler: sampler;
@group(0) @binding(4) var cloudLightLut: texture_2d<f32>;
@group(0) @binding(5) var shadowMap: texture_2d<f32>;
@group(0) @binding(6) var landMap: texture_2d<f32>;
@group(0) @binding(7) var<uniform> land: LandFrame;
@group(0) @binding(8) var<uniform> local: LocalVolumes;
@group(0) @binding(9) var outMist: texture_storage_3d<rgba16float, write>;
@group(0) @binding(10) var landShade: texture_2d<f32>;
${CLOUD_SHADOW_LOOKUP_WGSL}${CLOUD_LAND_SHADE_LOOKUP_WGSL}${LAND_LOOKUP_WGSL}

// Integral of the height profile: falling off over H above the ground, and over a quarter of H below it, where the map and
// the drawn ground may differ a little. Cells behind a hillside must not fill with mist from inside it.
fn heightIntegral(h: f32, H: f32) -> f32 {
    return select(-H * exp(-h / H), 0.25 * H * exp(4.0 * h / H) - 1.25 * H, h < 0.0);
}

fn heightMean(h: f32, span: f32, H: f32) -> f32 {
    let w = max(span, 0.25 * H);
    return (heightIntegral(h + 0.5 * w, H) - heightIntegral(h - 0.5 * w, H)) / w;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(outMist);
    if (any(id.xy >= size.xy)) { return; }
    let ro = u.camPos.xyz;
    let rd = cameraRay((vec2f(id.xy) + 0.5) / vec2f(size.xy), vec2f(1.0), u.camRight, u.camUp, u.camBack, u.frameInfo.x);
    let cellAngle = 2.0 / (u.camUp.w * f32(size.y));
    let mu = dot(rd, u.sun.xyz);
    let phase = mix(henyeyGreenstein(mu, 0.6), 1.0 / (4.0 * PI), 0.5);
    var T = 1.0;
    var light = vec3f(0.0);
    var previous = 0.0;
    textureStore(outMist, vec3u(id.xy, 0u), vec4f(0.0, 0.0, 0.0, 1.0));
    for (var slice = 1u; slice < size.z; slice++) {
        let t = local.mist.w * (exp2(f32(slice) / f32(size.z - 1u) * log2(1.0 + local.mist.z / local.mist.w)) - 1.0);
        let mid = 0.5 * (previous + t);
        let dt = t - previous;
        previous = t;
        let p = ro + rd * mid;
        let r = length(p);
        let uv = landUv(land, p);
        let edge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
        if (edge > 0.0 && T > 0.005) {
            let m = textureSampleLevel(landMap, linearSampler, uv, 0.0);
            let h = r - land.up.w - (m.r + land.e2.w);
            if (h < 0.12) {
                let up = p / r;
                let span = abs(dot(rd, up)) * dt + mid * cellAngle;
                // Patches of some hundred metres, so that only parts of a wood have mist, and wisps inside them, which the
                // wind carries along and disperses near the camera. The ground holds it back: less of it low down.
                let patch_ = textureSampleLevel(shapeTex, noiseSampler, (p - local.drift.xyz * 0.25) / 1.3 + vec3f(0.37, 0.11, 0.83), 1.0);
                let chosen = smoothstep(0.56, 0.88, patch_.r + 0.1 * (local.mist.x - 0.5));
                let wet = smoothstep(0.1, 0.8, m.g) * local.mist2.x * (0.3 + 0.7 * chosen);
                let forest = smoothstep(0.02, 0.8, m.b) * local.mist2.y * chosen;
                let hollow = smoothstep(0.004, 0.03, m.a) * local.mist2.z * chosen;
                // Wet weather drives banks of it over any ground.
                let bank = local.mist3.z * smoothstep(0.5, 0.85, 0.55 * patch_.r + 0.45 * patch_.g);
                if (wet + forest + hollow + bank <= 0.004) { textureStore(outMist, vec3u(id.xy, slice), vec4f(light, T)); continue; }
                let lives = wispsAt(1.7 * patch_.a);
                let far = smoothstep(0.3, 0.6, mid);
                let wind = local.wind.xyz - up * dot(local.wind.xyz, up);
                let wispLod = max(0.0, log2(mid * cellAngle / 0.34 * 128.0));
                let at = p / 0.34 + vec3f(0.05, 0.62, 0.29);
                var wisp = vec2f(0.0);
                if (far < 1.0) {
                    let carry = (wind * (0.25 + 4.0 * clamp(h, 0.0, 0.06)) + (patch_.gba - 0.5) * 0.002) * (local.mist3.w / 0.34);
                    wisp = textureSampleLevel(shapeTex, noiseSampler, at - carry * (lives.age.x - 0.5) + lives.first, wispLod + lives.age.x).rg * lives.share.x
                        + textureSampleLevel(shapeTex, noiseSampler, at - carry * (lives.age.y - 0.5) + lives.second, wispLod + lives.age.y).rg * lives.share.y;
                }
                if (far > 0.0) { wisp = mix(wisp, textureSampleLevel(shapeTex, noiseSampler, at - local.drift.xyz * (0.25 / 0.34), wispLod).rg, far); }
                let wisps = 0.25 + 0.75 * smoothstep(0.3, 0.9, 0.6 * wisp.x + 0.4 * wisp.y);
                let banks = bank * wisps;
                let density = wet * heightMean(h, span, 0.008 + 0.004 * wisps) + forest * heightMean(h, span, 0.012)
                    + hollow * heightMean(h, span, 0.009) + banks * heightMean(h, span, 0.02);
                let fade = smoothstep(0.0, 0.1, edge) * (1.0 - smoothstep(0.55, 1.0, mid / local.mist.z));
                let ext = density * wisps * fade * local.mist.x * local.mist.y * local.mist2.w;
                if (ext > 1.0e-4) {
                    let stepT = exp(-ext * dt);
                    let sun = sunlightAt(p, r);
                    light += T * (1.0 - stepT) * (sun * (phase * 0.4 + 0.022) + skyLight(p, r) * 0.7);
                    T *= stepT;
                }
            }
        }
        textureStore(outMist, vec3u(id.xy, slice), vec4f(light, T));
    }
}
`;

// Requires: localMist (texture_3d), linearSampler, local (LocalVolumes).
export const LOCAL_MIST_LOOKUP_WGSL = /* wgsl */`
fn localMistTo(uv: vec2f, km: f32) -> vec4f {
    let count = f32(textureDimensions(localMist).z);
    let x = log2(1.0 + min(km, local.mist.z) / local.mist.w) / log2(1.0 + local.mist.z / local.mist.w);
    let mist = textureSampleLevel(localMist, linearSampler, vec3f(uv, (0.5 + x * (count - 1.0)) / count), 0.0);
    // A thin veil, however long the way through it.
    return vec4f(mist.rgb * local.mist3.x, 1.0 - (1.0 - mist.a) * local.mist3.x);
}

// Fog on mountains up to a distance. Requires mountainFog (texture_3d). It never hides what is behind it.
fn mountainFogTo(uv: vec2f, km: f32) -> vec4f {
    let count = f32(textureDimensions(mountainFog).z);
    let x = log2(1.0 + min(km, local.fog.z) / local.mist3.y) / log2(1.0 + local.fog.z / local.mist3.y);
    let z = (0.5 + x * (count - 1.0)) / count;
    // Cubic between the cells (four reads, each among four cells). Along a slope a row covers a long stretch of ground, and
    // beside a steep hillside a column does: straight lines between them step as teeth, and wobble as the ground moves across.
    let cells = vec2f(textureDimensions(mountainFog).xy);
    let at = uv * cells - 0.5;
    let f = fract(at);
    let g = 1.0 - f;
    let w0 = g * g * g / 6.0;
    let w1 = (4.0 - 6.0 * f * f + 3.0 * f * f * f) / 6.0;
    let w3 = f * f * f / 6.0;
    let upper = 1.0 - w0 - w1;
    let first = (floor(at) - 0.5 + w1 / (w0 + w1)) / cells;
    let second = (floor(at) + 1.5 + w3 / upper) / cells;
    let fog = mix(
        mix(textureSampleLevel(mountainFog, linearSampler, vec3f(first.x, first.y, z), 0.0),
            textureSampleLevel(mountainFog, linearSampler, vec3f(second.x, first.y, z), 0.0), upper.x),
        mix(textureSampleLevel(mountainFog, linearSampler, vec3f(first.x, second.y, z), 0.0),
            textureSampleLevel(mountainFog, linearSampler, vec3f(second.x, second.y, z), 0.0), upper.x), upper.y);
    return vec4f(fog.rgb * local.fog.w, 1.0 - (1.0 - fog.a) * local.fog.w);
}

// Adds it to a premultiplied cloud colour (rgb, a transmittance) at cloudKm, before a scene at sceneKm.
fn addMountainFog(cloud: vec4f, uv: vec2f, sceneKm: f32, cloudKm: f32) -> vec4f {
    let all = mountainFogTo(uv, sceneKm);
    if (all.a > 0.9995) { return cloud; }
    var front = all;
    if (cloud.a < 0.999) { front = mountainFogTo(uv, cloudKm); }
    return vec4f(front.rgb + front.a * cloud.rgb + cloud.a * (all.rgb - front.rgb), cloud.a * all.a);
}
`;
