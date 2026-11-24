import {
    CLOUD_ATMOSPHERE_WGSL, CLOUD_MATH_WGSL, CLOUD_SHADOW_LOOKUP_WGSL, CLOUD_SHAPE_SIGNAL_WGSL, CLOUD_UNIFORMS_WGSL, NOISE_ROTATIONS_WGSL,
} from './cloudCommon.wgsl.js';
import { CLOUD_HAZE_LOOKUP_WGSL, CLOUD_HAZE_STRUCT_WGSL } from './cloudCompositeParts.wgsl.js';
import { CLOUD_COMPOSITE_UNIFORMS_WGSL } from './cloudCompositeUniforms.wgsl.js';
import { LAND_FRAME_WGSL } from './cloudLandMap.wgsl.js';

export const LOCAL_VOLUME_UNIFORMS_WGSL = /* wgsl */`
struct LocalVolumes {
    fog: vec4f,   // fog on mountains: amount (0..1), extinction (1/km), reach (km), opacity at most
    mist: vec4f,  // amount, extinction (1/km), reach (km), first slice (km)
    mist2: vec4f, // wetland, forest and hollow share, time of day factor
    mist3: vec4f, // x opacity at most, y first distance of the fog's slices (km)
}
`;

const LAND_LOOKUP_WGSL = /* wgsl */`
fn sunlightAt(p: vec3f, r: f32) -> vec3f {
    return sunTransmittance(cloudLightLut, linearSampler, r, dot(p / r, u.sun.xyz), u.planet.x, u.planet.w) * u.sun.w;
}

// Light from all around, as the ground mist has it (cloudCompositeParts): sky by day, moon and night fill.
fn skyLight(p: vec3f, r: f32) -> vec3f {
    let up = p / r;
    let mu = dot(up, u.sun.xyz);
    // A deck dims and greys it.
    let grey = u.weatherStyle.y * u.weatherStyle.x;
    let sky = mix(vec3f(0.61, 0.75, 1.0), vec3f(0.62, 0.64, 0.67), grey) * (0.045 * u.sun.w * smoothstep(-0.2, 0.35, mu));
    return sky + vec3f(0.08, 0.10, 0.15) * (u.moon.w * smoothstep(-0.08, 0.25, dot(up, u.moon.xyz))) + u.ambientFloor.rgb;
}
`;

// Fog around the upper part of mountains: a soft shell some 300 m deep over their slopes (the wide and middle land maps), in a
// volume over screen and distance (rgb light with the haze before it, a transmittance up to the slice). It drifts with the
// wind, changes as it goes and creeps downhill. No history and no jitter: its depth is integrated exactly over each cell and
// the noise is filtered to the cells, so nothing slices or flickers.
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
${CLOUD_SHADOW_LOOKUP_WGSL}${LAND_LOOKUP_WGSL}${NOISE_ROTATIONS_WGSL}${CLOUD_SHAPE_SIGNAL_WGSL}${CLOUD_HAZE_STRUCT_WGSL}${CLOUD_HAZE_LOOKUP_WGSL}
// The higher tier lets it roll downhill.
override ROLLING: bool = true;

// Beyond this height above the slope (km) there is nothing.
const TOP: f32 = 0.7;

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

// How dense the fog is here (0 to 1), apart from its profile out from the slope.
fn fogAt(p: vec3f, r: f32, weight: f32, part: f32, tilt: vec3f, footprint: f32) -> f32 {
    let up = p / r;
    let wind = u.windShape.xyz;
    // Some mountains have fog now, others less.
    let chosen = textureSampleLevel(shapeTex, noiseSampler, ROT_LARGE * ((p + wind * 0.35) / 37.0) + vec3f(0.21, 0.57, 0.36), 2.0).r;
    var coverage = local.fog.x * weight * smoothstep(0.24, 0.56, chosen + 0.24 * local.fog.x) * smoothstep(-0.05, 0.1, part);
    if (coverage <= 0.005) { return 0.0; }
    let tile = 2.9;
    let n = textureSampleLevel(shapeTex, noiseSampler, ROT_REGIONAL * ((p + wind * 0.34) / tile) + vec3f(0.13, 0.71, 0.45),
        max(0.0, log2(footprint / tile * SHAPE_TEXELS)));
    // Around the upper part of the mountain, with an uneven lower edge.
    coverage *= smoothstep(0.1, 0.85, part + 0.7 * (n.g - 0.55));
    // A smaller layer at another speed, sinking: between the two the wisps form and dissolve. Drawn out along the level,
    // and bent by the larger one.
    let small = 1.3;
    let q = p + up * (1.5 * (r - wide.up.w) + u.lod.y * 0.16) + wind * 0.55;
    let warp = (n.gba - 0.5) * 0.55;
    let lod = max(0.0, log2(2.6 * footprint / small * SHAPE_TEXELS));
    var n2: vec4f;
    if (ROLLING) {
        // It also rolls down the slope. Two copies take turns, each carried some way downhill and then started over while
        // the other one shows, so that the pattern never stretches.
        let down = -tilt / max(length(tilt), 0.45);
        let clock = u.lod.y * 0.8;
        let phases = fract(vec2f(clock, clock + 0.5));
        let turn = 1.0 - abs(2.0 * phases - 1.0);
        let carried = (phases - 0.5) * 0.4;
        let restart = vec3f(0.37, 0.71, 0.19) * floor(clock);
        let restart1 = vec3f(0.37, 0.71, 0.19) * floor(clock + 0.5) + 0.5;
        n2 = textureSampleLevel(shapeTex, noiseSampler, ROT_SYSTEM * ((q - down * carried.x) / small) + warp + restart, lod) * turn.x
            + textureSampleLevel(shapeTex, noiseSampler, ROT_SYSTEM * ((q - down * carried.y) / small) + warp + restart1, lod) * turn.y;
    } else {
        n2 = textureSampleLevel(shapeTex, noiseSampler, ROT_SYSTEM * (q / small) + warp, lod);
    }
    // Single wisps in fair weather, more of an even veil in wet weather.
    let low = mix(0.5, 0.24, saturate(local.fog.x));
    let wisp = smoothstep(low, low + 0.62, 0.5 * shapeSignal(n) + 0.5 * shapeSignal(n2));
    return coverage * (0.07 * local.fog.x + wisp * wisp * (1.5 - 0.5 * wisp));
}

// Profile out from the slope: most of it a little above, with a long soft end.
const MIDDLE: f32 = 0.09;
const DEPTH: f32 = 0.17;

fn depthProfile(x: f32) -> f32 {
    let c = 1.0 / cosh(clamp((x - MIDDLE) / DEPTH, -9.0, 9.0));
    return c * c;
}

// Its mean over a step whose height above the slope goes evenly from a to b.
fn depthMean(a: f32, b: f32) -> f32 {
    if (abs(b - a) < 0.1 * DEPTH) { return depthProfile(0.5 * (a + b)); }
    return DEPTH * (tanh((b - MIDDLE) / DEPTH) - tanh((a - MIDDLE) / DEPTH)) / (b - a);
}

fn fogLight(p: vec3f, r: f32, rd: vec3f, tilt: vec3f) -> vec3f {
    let up = p / r;
    let mu = dot(rd, u.sun.xyz);
    // The mountain shades the fog on its far side.
    let facing = dot(normalize(up - tilt), u.sun.xyz);
    let sun = sunlightAt(p, r) * cloudShadowAt(p, 1.0) * smoothstep(-0.35, 0.35, facing);
    // Thin and wet: bright against the sun.
    let phase = mix(henyeyGreenstein(mu, 0.6), henyeyGreenstein(mu, -0.2), 0.45);
    return sun * (phase * 0.25 + 0.032) + skyLight(p, r) * 0.7;
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
                let near = vec2f(depthProfile(a.above), depthProfile(b.above)) + 1.0e-3;
                let share = (0.25 * near.x + 0.75 * near.y) / (near.x + near.y);
                let t = mix(t0, t1, share);
                let p = ro + rd * t;
                let r = length(p);
                let tilt = mix(a.tilt, b.tilt, share);
                let fade = (1.0 - smoothstep(0.7, 1.0, t / local.fog.z)) * smoothstep(0.0, 0.3, t);
                let profile = depthMean(a.above, b.above);
                if (profile * fade > 2.0e-3) {
                    let fog = fogAt(p, r, mix(a.weight, b.weight, share) * fade, mix(a.part, b.part, share), tilt,
                        max(0.7 * t * cellAngle, 0.5 * (t1 - t0)));
                    let tau = fog * profile * local.fog.y * (t1 - t0);
                    if (tau > 1.0e-4) {
                        let w = T * (1.0 - exp(-tau));
                        let haze = lookupHaze(uv, t);
                        light += w * (fogLight(p, r, rd, tilt) * haze.T + haze.L);
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
${CLOUD_SHADOW_LOOKUP_WGSL}${LAND_LOOKUP_WGSL}

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
                let drift = p + u.windShape.xyz * 0.06;
                // Patches of some hundred metres, so that only parts of a wood have mist, and wisps inside them.
                let patch_ = textureSampleLevel(shapeTex, noiseSampler, drift / 1.3 + vec3f(0.37, 0.11, 0.83), 1.0).r;
                let wisp = textureSampleLevel(shapeTex, noiseSampler, drift / 0.34 + vec3f(0.05, 0.62, 0.29),
                    max(0.0, log2(mid * cellAngle / 0.34 * 128.0))).rg;
                let chosen = smoothstep(0.56, 0.88, patch_ + 0.1 * (local.mist.x - 0.5));
                let wisps = 0.25 + 0.75 * smoothstep(0.3, 0.9, 0.6 * wisp.x + 0.4 * wisp.y);
                let wet = smoothstep(0.1, 0.8, m.g) * local.mist2.x * (0.3 + 0.7 * chosen);
                let forest = smoothstep(0.02, 0.8, m.b) * local.mist2.y * chosen;
                let hollow = smoothstep(0.004, 0.03, m.a) * local.mist2.z * chosen;
                let density = wet * heightMean(h, span, 0.008 + 0.004 * wisps) + forest * heightMean(h, span, 0.012)
                    + hollow * heightMean(h, span, 0.009);
                let fade = smoothstep(0.0, 0.1, edge) * (1.0 - smoothstep(0.55, 1.0, mid / local.mist.z));
                let ext = density * wisps * fade * local.mist.x * local.mist.y * local.mist2.w;
                if (ext > 1.0e-4) {
                    let stepT = exp(-ext * dt);
                    let sun = sunlightAt(p, r) * cloudShadowAt(p, 1.0);
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
    // Cubic between the rows (two reads, each between two rows): along a slope a row covers a long stretch of ground, and
    // straight lines between the rows would wobble as the ground moves across them.
    let rows = f32(textureDimensions(mountainFog).y);
    let y = uv.y * rows - 0.5;
    let f = fract(y);
    let g = 1.0 - f;
    let w = vec4f(g * g * g, 4.0 - 6.0 * f * f + 3.0 * f * f * f, 4.0 - 6.0 * g * g + 3.0 * g * g * g, f * f * f) / 6.0;
    let upper = w.z + w.w;
    let at = (floor(y) + vec2f(-0.5 + w.y / (w.x + w.y), 1.5 + w.w / upper)) / rows;
    let fog = mix(textureSampleLevel(mountainFog, linearSampler, vec3f(uv.x, at.x, z), 0.0),
        textureSampleLevel(mountainFog, linearSampler, vec3f(uv.x, at.y, z), 0.0), upper);
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
