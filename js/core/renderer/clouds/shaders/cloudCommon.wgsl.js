// js/renderer/clouds/shaders/cloudCommon.wgsl.js
// Shared WGSL functions for all cloud rendering tiers (volumetric, proxy, shell)

export const CLOUD_VOLUME_STRUCTS_WGSL = /* wgsl */`
// ============================================================================
// VOLUME DESCRIPTOR - Defines a localized cloud volume for tiered rendering
// ============================================================================

struct VolumeDesc {
    center: vec3<f32>,       // World-space center of the volume
    radiusH: f32,            // Horizontal radius (meters)
    radiusV: f32,            // Vertical half-height (meters)
    altitudeBase: f32,       // Base altitude above planet surface
    coverageLocal: f32,      // Local coverage modifier [0,1]
    lodBlend: f32,           // LOD blend factor: 0=volumetric, 1=proxy
    fogType: f32,            // 0=cumulus, 1=valley fog, 2=mountain cap
    densityMult: f32,        // Density multiplier for this volume
    _pad0: f32,
    _pad1: f32,
};

struct VolumeParams {
    activeCount: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
    volumes: array<VolumeDesc, 4>,
};
`;

export const CLOUD_COMMON_WGSL = /* wgsl */`
// ============================================================================
// CLOUD COMMON - Shared functions for volumetric cloud rendering
// ============================================================================

const CLOUD_PI: f32 = 3.14159265359;
const CLOUD_TIME_SCALE: f32 = 0.066;

// ----------------------------------------------------------------------------
// Utility Functions
// ----------------------------------------------------------------------------

fn cloudRemap(v: f32, lo: f32, hi: f32, newLo: f32, newHi: f32) -> f32 {
    return newLo + (v - lo) / max(hi - lo, 0.0001) * (newHi - newLo);
}

fn cloudRidgeNoise(n: f32) -> f32 {
    return 1.0 - abs(n * 2.0 - 1.0);
}

fn cloudBayer8(p: vec2<f32>) -> f32 {
    let x = u32(p.x) % 8u;
    let y = u32(p.y) % 8u;
    var m = array<u32, 64>(
        0u, 32u, 8u, 40u, 2u, 34u, 10u, 42u,
        48u, 16u, 56u, 24u, 50u, 18u, 58u, 26u,
        12u, 44u, 4u, 36u, 14u, 46u, 6u, 38u,
        60u, 28u, 52u, 20u, 62u, 30u, 54u, 22u,
        3u, 35u, 11u, 43u, 1u, 33u, 9u, 41u,
        51u, 19u, 59u, 27u, 49u, 17u, 57u, 25u,
        15u, 47u, 7u, 39u, 13u, 45u, 5u, 37u,
        63u, 31u, 55u, 23u, 61u, 29u, 53u, 21u
    );
    return f32(m[y * 8u + x]) / 64.0;
}

fn cloudSmoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
}

// ----------------------------------------------------------------------------
// Ray-Geometry Intersection
// ----------------------------------------------------------------------------

fn cloudRayPlanetIntersect(ro: vec3<f32>, rd: vec3<f32>, center: vec3<f32>, radius: f32) -> f32 {
    let oc = ro - center;
    let b = dot(oc, rd);
    let c = dot(oc, oc) - radius * radius;
    let disc = b * b - c;
    if (disc < 0.0) { return -1.0; }
    let s = sqrt(disc);
    let t0 = -b - s;
    if (t0 > 0.0) { return t0; }
    let t1 = -b + s;
    if (t1 > 0.0) { return t1; }
    return -1.0;
}

fn cloudRayShellIntersect(ro: vec3<f32>, rd: vec3<f32>, center: vec3<f32>, rInner: f32, rOuter: f32) -> vec2<f32> {
    let oc = ro - center;
    let b = dot(oc, rd);

    let c_outer = dot(oc, oc) - rOuter * rOuter;
    var disc_outer = b * b - c_outer;
    if (disc_outer < 0.0) {
        if (disc_outer > -1e-4) { disc_outer = 0.0; }
        else { return vec2<f32>(-1.0, -1.0); }
    }

    let sqrt_outer = sqrt(max(disc_outer, 0.0));
    let t_outer_near = -b - sqrt_outer;
    let t_outer_far  = -b + sqrt_outer;
    if (t_outer_far < 0.0) { return vec2<f32>(-1.0, -1.0); }

    let c_inner = dot(oc, oc) - rInner * rInner;
    var disc_inner = b * b - c_inner;
    if (disc_inner < 0.0 && disc_inner > -1e-4) { disc_inner = 0.0; }

    let dist2 = dot(oc, oc);

    var tStart: f32;
    var tEnd: f32;

    if (dist2 < rInner * rInner) {
        if (disc_inner >= 0.0) {
            tStart = -b + sqrt(max(disc_inner, 0.0));
        } else {
            tStart = max(0.0, t_outer_near);
        }
        tEnd = t_outer_far;
    } else if (dist2 > rOuter * rOuter) {
        tStart = max(0.0, t_outer_near);
        if (disc_inner >= 0.0) {
            let sqrt_inner = sqrt(max(disc_inner, 0.0));
            let t_inner_near = -b - sqrt_inner;
            if (t_inner_near > tStart) {
                tEnd = t_inner_near;
            } else {
                tStart = max(tStart, -b + sqrt_inner);
                tEnd = t_outer_far;
            }
        } else {
            tEnd = t_outer_far;
        }
    } else {
        tStart = 0.0;
        if (disc_inner >= 0.0) {
            let t_inner_near = -b - sqrt(max(disc_inner, 0.0));
            if (t_inner_near > 0.0) { tEnd = t_inner_near; }
            else { tEnd = t_outer_far; }
        } else {
            tEnd = t_outer_far;
        }
    }

    if (tEnd <= tStart) { return vec2<f32>(-1.0, -1.0); }
    return vec2<f32>(tStart, tEnd);
}

// Ray-ellipsoid intersection for localized volumes
fn cloudRayEllipsoidIntersect(ro: vec3<f32>, rd: vec3<f32>, center: vec3<f32>, radiusH: f32, radiusV: f32) -> vec2<f32> {
    // Transform ray to ellipsoid space (scale to unit sphere)
    let invScale = vec3<f32>(1.0 / radiusH, 1.0 / radiusV, 1.0 / radiusH);
    let localO = (ro - center) * invScale;
    let localD = rd * invScale;
    
    let a = dot(localD, localD);
    let b = 2.0 * dot(localO, localD);
    let c = dot(localO, localO) - 1.0;
    let disc = b * b - 4.0 * a * c;
    
    if (disc < 0.0) { return vec2<f32>(-1.0, -1.0); }
    
    let sqrtDisc = sqrt(disc);
    let t0 = (-b - sqrtDisc) / (2.0 * a);
    let t1 = (-b + sqrtDisc) / (2.0 * a);
    
    let tNear = max(t0, 0.0);
    let tFar = t1;
    
    if (tFar < 0.0) { return vec2<f32>(-1.0, -1.0); }
    
    return vec2<f32>(tNear, tFar);
}

// ----------------------------------------------------------------------------
// Noise Sampling Utilities
// ----------------------------------------------------------------------------

fn cloudSampleNoise3D(tex: texture_3d<f32>, samp: sampler, coord: vec3<f32>, lod: f32) -> vec4<f32> {
    return textureSampleLevel(tex, samp, fract(coord), lod);
}

fn cloudDomainWarp(coord: vec3<f32>, tex: texture_3d<f32>, samp: sampler, strength: f32) -> vec3<f32> {
    let warpSample = textureSampleLevel(tex, samp, fract(coord * 0.25), 2.0).xyz;
    let warp = (warpSample - vec3<f32>(0.5)) * strength;
    return coord + warp;
}

fn cloudFlowAdvect(coord: vec3<f32>, tex: texture_3d<f32>, samp: sampler, time: f32, speed: f32, strength: f32) -> vec3<f32> {
    let flowSample = textureSampleLevel(tex, samp, fract(coord * 0.12 + vec3<f32>(time * speed, 0.0, time * speed)), 1.0).xy;
    let flow = (flowSample - vec2<f32>(0.5)) * 2.0;
    return coord + vec3<f32>(flow.x, 0.0, flow.y) * strength;
}

// ----------------------------------------------------------------------------
// Coordinate Helpers
// ----------------------------------------------------------------------------

fn cloudGetLocalCoord(worldPos: vec3<f32>, planetCenter: vec3<f32>, tileSize: f32, verticalStretch: f32) -> vec3<f32> {
    let rel = worldPos - planetCenter;
    let n = normalize(rel);
    let radial = dot(rel, n);
    let baseCoord = rel / tileSize;
    let vs = max(verticalStretch, 0.1);
    let radialScale = (1.0 / vs) - 1.0;
    return baseCoord + n * (radial / tileSize) * radialScale;
}

fn cloudGetAltitude(worldPos: vec3<f32>, planetCenter: vec3<f32>, planetRadius: f32) -> f32 {
    return length(worldPos - planetCenter) - planetRadius;
}

fn cloudGetHeightFraction(worldPos: vec3<f32>, planetCenter: vec3<f32>, innerRadius: f32, outerRadius: f32) -> f32 {
    let dist = length(worldPos - planetCenter);
    return (dist - innerRadius) / max(outerRadius - innerRadius, 1.0);
}

fn cloudGetGrazingDensityFactor(worldPos: vec3<f32>, rayDir: vec3<f32>, planetCenter: vec3<f32>) -> f32 {
    let surfaceNormal = normalize(worldPos - planetCenter);
    let NdotR = abs(dot(surfaceNormal, rayDir));
    return clamp(NdotR, 0.05, 1.0);
}

// ----------------------------------------------------------------------------
// Volume-Specific Density Profiles
// ----------------------------------------------------------------------------

fn cloudCumulusProfile(localPos: vec3<f32>, heightFrac: f32) -> f32 {
    // Standard cumulus: rounded bottom, billowy top
    let bottomFade = smoothstep(0.0, 0.15, heightFrac);
    let topFade = smoothstep(1.0, 0.85, heightFrac);
    return bottomFade * topFade;
}

fn cloudValleyFogProfile(localPos: vec3<f32>, heightFrac: f32) -> f32 {
    // Valley fog: dense at bottom, exponential falloff
    return exp(-heightFrac * 3.0);
}

fn cloudMountainCapProfile(localPos: vec3<f32>, heightFrac: f32) -> f32 {
    // Mountain cap: hemisphere clinging to peak, denser at edges
    let centerDist = length(localPos.xz);
    let edgeFactor = smoothstep(0.3, 0.9, centerDist);
    let heightFactor = smoothstep(0.0, 0.4, heightFrac) * smoothstep(1.0, 0.6, heightFrac);
    return mix(heightFactor, heightFactor * 1.5, edgeFactor);
}

fn cloudGetVolumeProfile(heightFrac: f32, fogType: f32, localPos: vec3<f32>) -> f32 {
    let fogTypeInt = u32(fogType);
    switch fogTypeInt {
        case 0u: { return cloudCumulusProfile(localPos, heightFrac); }
        case 1u: { return cloudValleyFogProfile(localPos, heightFrac); }
        case 2u: { return cloudMountainCapProfile(localPos, heightFrac); }
        default: { return cloudCumulusProfile(localPos, heightFrac); }
    }
}

// ----------------------------------------------------------------------------
// Phase Functions (for lighting)
// ----------------------------------------------------------------------------

fn cloudHenyeyGreenstein(cosTheta: f32, g: f32) -> f32 {
    let g2 = g * g;
    let denom = 1.0 + g2 - 2.0 * g * cosTheta;
    return (1.0 - g2) / (4.0 * CLOUD_PI * pow(max(denom, 0.0001), 1.5));
}

fn cloudDualLobePhase(cosTheta: f32, g: f32) -> f32 {
    // Blend of forward and back scatter for cloud lighting
    let forward = cloudHenyeyGreenstein(cosTheta, g);
    let back = cloudHenyeyGreenstein(cosTheta, -g * 0.5);
    return mix(back, forward, 0.7);
}
`;

export function getCloudCommonWGSL() {
    return CLOUD_VOLUME_STRUCTS_WGSL + CLOUD_COMMON_WGSL;
}