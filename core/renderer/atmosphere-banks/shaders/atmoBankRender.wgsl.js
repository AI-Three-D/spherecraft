import { buildAtmoBankCommonWGSL } from './atmoBankCommon.wgsl.js';

export function buildAtmoBankRenderWGSL({ typeCapacity = 4, sliceCount = 5 } = {}) {
    const common = buildAtmoBankCommonWGSL({ typeCapacity });
    const volumeSliceCount = Math.max(1, Math.floor(sliceCount));

    return /* wgsl */`
${common}

const ATMO_VOLUME_SLICE_COUNT: u32 = ${volumeSliceCount}u;
const TYPE_VALLEY_MIST: u32 = 0u;
const TYPE_FOG_POCKET:  u32 = 1u;

@group(0) @binding(0) var<uniform>       globals   : AtmoGlobals;
@group(0) @binding(1) var<storage, read> particles : array<AtmoParticle>;
@group(0) @binding(2) var<storage, read> liveList  : array<u32>;
@group(0) @binding(3) var<uniform>       typeDefs  : array<AtmoTypeDef, ATMO_TYPE_CAPACITY>;

struct AtmoRenderParams {
    targetSize: vec2<f32>,
    sceneSize: vec2<f32>,
};

@group(0) @binding(4) var<uniform> renderParams: AtmoRenderParams;

@group(1) @binding(0) var noiseBase:   texture_3d<f32>;
@group(1) @binding(1) var noiseDetail: texture_3d<f32>;
@group(1) @binding(2) var noiseSampler: sampler;
@group(1) @binding(3) var depthTexture: texture_depth_2d;

struct VsOut {
    @builtin(position) clipPos: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) color: vec4<f32>,
    @location(2) worldPos: vec3<f32>,
    @location(3) particleCenter: vec3<f32>,
    @location(4) noisePhase: vec3<f32>,
    @location(5) @interpolate(flat) noiseScale: f32,
    @location(6) @interpolate(flat) noiseSpeed: f32,
    @location(7) @interpolate(flat) opacity: f32,
    @location(8) @interpolate(flat) particleSize: f32,
    @location(9) @interpolate(flat) densityThreshold: f32,
    @location(10) @interpolate(flat) radiusA: f32,
    @location(11) @interpolate(flat) radiusB: f32,
    @location(12) @interpolate(flat) halfHeight: f32,
    @location(13) @interpolate(flat) riseSpeed: f32,
    @location(14) @interpolate(flat) camDist: f32,
    @location(15) @interpolate(flat) topNoiseFade: f32,
};

fn quadCorner(vid: u32) -> vec2<f32> {
    let qv = vid % 6u;
    switch (qv) {
        case 0u: { return vec2<f32>(-1.0, -1.0); }
        case 1u: { return vec2<f32>( 1.0, -1.0); }
        case 2u: { return vec2<f32>(-1.0,  1.0); }
        case 3u: { return vec2<f32>(-1.0,  1.0); }
        case 4u: { return vec2<f32>( 1.0, -1.0); }
        default: { return vec2<f32>( 1.0,  1.0); }
    }
}

fn resolveLocalUp(position: vec3<f32>) -> vec3<f32> {
    let local = position - globals.planetOrigin;
    let lenSq = dot(local, local);
    if (lenSq > 1e-8) { return normalize(local); }
    return vec3<f32>(0.0, 1.0, 0.0);
}

fn safeNormalize(v: vec3<f32>, fallback: vec3<f32>) -> vec3<f32> {
    let lenSq = dot(v, v);
    if (lenSq > 1e-8) { return v * inverseSqrt(lenSq); }
    return fallback;
}

struct StableTangentBasis {
    a: vec3<f32>,
    b: vec3<f32>,
};

fn stableTangentBasis(localUp: vec3<f32>, phase: vec3<f32>) -> StableTangentBasis {
    var refAxis = vec3<f32>(0.0, 0.0, 1.0);
    if (abs(localUp.z) > 0.86) {
        refAxis = vec3<f32>(1.0, 0.0, 0.0);
    }

    let baseA = safeNormalize(cross(refAxis, localUp), vec3<f32>(1.0, 0.0, 0.0));
    let baseB = safeNormalize(cross(localUp, baseA), vec3<f32>(0.0, 0.0, 1.0));
    let angle = fract(dot(phase, vec3<f32>(0.1031, 0.1137, 0.1379))) * 6.2831853;
    let ca = cos(angle);
    let sa = sin(angle);

    var basis: StableTangentBasis;
    basis.a = baseA * ca + baseB * sa;
    basis.b = baseB * ca - baseA * sa;
    return basis;
}

fn resolveFogLighting(position: vec3<f32>) -> vec3<f32> {
    let localUp = resolveLocalUp(position);
    let sunDir = safeNormalize(globals.sunDirection, vec3<f32>(0.0, 1.0, 0.0));
    let sunDot = dot(localUp, sunDir);
    let direct = smoothstep(-0.12, 0.24, sunDot) * clamp(globals.sunVisibility, 0.0, 1.0);
    let ambient = clamp(globals.ambientIntensity * 1.20, 0.035, 0.24);
    let moon = clamp(globals.moonIntensity / 0.15, 0.0, 1.0) * 0.10;
    let lit =
        globals.ambientColor * ambient +
        globals.sunColor * (direct * 0.88) +
        vec3<f32>(0.50, 0.56, 0.70) * moon;
    return clamp(lit, vec3<f32>(0.028), vec3<f32>(1.12));
}

fn projectedExtent(axis: vec3<f32>, basis: StableTangentBasis, localUp: vec3<f32>,
                   radiusA: f32, radiusB: f32, halfHeight: f32) -> f32 {
    return abs(dot(axis, basis.a)) * radiusA +
           abs(dot(axis, basis.b)) * radiusB +
           abs(dot(axis, localUp)) * halfHeight + 1.5;
}

@vertex
fn vs_main(@builtin(vertex_index) vid: u32,
           @builtin(instance_index) iid: u32) -> VsOut {
    let slot = liveList[iid];
    let p = particles[slot];
    let td = typeDefs[p.ptype];
    let corner = quadCorner(vid);

    let localUp = resolveLocalUp(p.position);
    let basis = stableTangentBasis(localUp, p.noisePhase);
    let sliceT = 0.0;

    let radiusA = max(2.0, p.size);
    let radiusB = max(2.0, p.size * max(td.horizontalScale, 0.05));
    var halfHeight = max(1.5, p.size * max(td.verticalScale, 0.01));
    var centerLiftScale = clamp(td.centerLiftScale, 0.0, 1.0);
    if (p.ptype == TYPE_VALLEY_MIST || p.ptype == TYPE_FOG_POCKET) {
        centerLiftScale = 1.0;
    }
    if (td.heightMax > 0.0) {
        let maxHalfHeight = max(1.5, td.heightMax / max(centerLiftScale + 1.0, 0.001));
        halfHeight = min(halfHeight, maxHalfHeight);
    }
    let centerLift = halfHeight * centerLiftScale;
    let volumeCenter = p.position + localUp * centerLift;

    let viewRight = safeNormalize(globals.cameraRight, basis.a);
    let viewUp = safeNormalize(globals.cameraUp, localUp);
    let viewForward = safeNormalize(cross(viewRight, viewUp), localUp);
    let depthExtent = projectedExtent(viewForward, basis, localUp, radiusA, radiusB, halfHeight);
    let extentX = projectedExtent(viewRight, basis, localUp, radiusA, radiusB, halfHeight);
    let extentY = projectedExtent(viewUp, basis, localUp, radiusA, radiusB, halfHeight);

    let planeCenter = volumeCenter + viewForward * (sliceT * depthExtent);
    let wp = planeCenter + viewRight * (corner.x * extentX) + viewUp * (corner.y * extentY);

    var out: VsOut;
    out.clipPos         = globals.viewProj * vec4<f32>(wp, 1.0);
    out.uv              = corner * 0.5 + vec2<f32>(0.5, 0.5);
    out.color           = p.color;
    out.worldPos        = wp;
    out.particleCenter  = volumeCenter;
    out.noisePhase      = p.noisePhase;
    out.noiseScale      = td.noiseScale;
    out.noiseSpeed      = td.noiseSpeed;
    out.opacity         = p.opacity;
    out.particleSize    = p.size;
    out.densityThreshold = td.densityThreshold;
    out.radiusA         = radiusA;
    out.radiusB         = radiusB;
    out.halfHeight      = halfHeight;
    out.riseSpeed       = td.riseSpeed;
    out.camDist         = length(volumeCenter - globals.cameraPos);
    out.topNoiseFade    = td.topNoiseFade;
    return out;
}

fn linearizeDepth(d: f32, near: f32, far: f32) -> f32 {
    return (near * far) / (far - d * (far - near));
}

fn sceneDepthCoord(fragmentPosition: vec2<f32>, depthDims: vec2<u32>) -> vec2<i32> {
    let targetSize = max(renderParams.targetSize, vec2<f32>(1.0, 1.0));
    let sceneSize = max(renderParams.sceneSize, vec2<f32>(1.0, 1.0));
    let scenePosition = fragmentPosition * (sceneSize / targetSize);
    return clamp(
        vec2<i32>(scenePosition),
        vec2<i32>(0),
        vec2<i32>(depthDims) - vec2<i32>(1)
    );
}

fn volumeShape(worldPos: vec3<f32>, center: vec3<f32>, phase: vec3<f32>,
               radiusA: f32, radiusB: f32, halfHeight: f32,
               topNoiseFadeAmount: f32, riseSpeed: f32) -> f32 {
    let localUp = resolveLocalUp(center);
    let basis = stableTangentBasis(localUp, phase);
    let offset = worldPos - center;
    let lx = dot(offset, basis.a) / max(radiusA, 0.001);
    let lz = dot(offset, basis.b) / max(radiusB, 0.001);
    let ly = dot(offset, localUp) / max(halfHeight, 0.001);
    let d = sqrt(lx * lx + lz * lz + ly * ly);
    let edgeNoiseA = sin(lx * 9.1 + lz * 13.7 + ly * 5.3 + dot(phase, vec3<f32>(0.29, 0.43, 0.17)));
    let edgeNoiseB = sin(lx * -16.7 + lz * 7.9 + ly * 3.1 + dot(phase, vec3<f32>(0.61, 0.11, 0.37)));
    let edgeNoise = (edgeNoiseA + edgeNoiseB) * 0.5;
    let edgeWarp = edgeNoise * 0.22 * smoothstep(0.18, 0.96, d);
    let sphere = 1.0 - smoothstep(0.64, 1.0, d + edgeWarp);
    let topNoisePos = worldPos - localUp * globals.time * max(riseSpeed, 0.0);
    let topNoise = sin(dot(topNoisePos, vec3<f32>(0.081, 0.119, 0.067)) + dot(phase, vec3<f32>(0.37, 0.19, 0.53))) * 0.5 + 0.5;
    let topStart = mix(0.3, 0.08 + topNoise * 0.38, clamp(topNoiseFadeAmount, 0.0, 1.0));
    // World-space fades — negligible rotation artifact at 5-10 m particle scale.
    let topFade   = 1.0 - smoothstep(topStart, 1.0, ly);
    let floorFade = smoothstep(-1.0, -0.9, ly);        // soft dissolve at sphere bottom only
    return clamp(sphere * topFade * floorFade, 0.0, 1.0);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    // Single camera-facing sample — no raymarching. Particles are 5-12 m so volume
    // traversal depth is negligible and billboard rotation is imperceptible at this scale.
    let shape = volumeShape(in.worldPos, in.particleCenter, in.noisePhase,
                            in.radiusA, in.radiusB, in.halfHeight, in.topNoiseFade, in.riseSpeed);
    if (shape < 0.005) { discard; }

    let localUp = resolveLocalUp(in.particleCenter);
    let noiseCoord = in.worldPos * in.noiseScale + in.noisePhase +
        vec3<f32>(globals.time * in.noiseSpeed, 0.0, globals.time * in.noiseSpeed * 0.7) -
        localUp * globals.time * max(in.riseSpeed, 0.0);
    let n1    = textureSampleLevel(noiseBase,   noiseSampler, fract(noiseCoord), 0.0).r;
    let n2    = textureSampleLevel(noiseDetail, noiseSampler,
                    fract(noiseCoord * 2.7 + vec3<f32>(0.3, 0.7, 0.1)), 1.0).r;
    let noise   = n1 * 0.7 + n2 * 0.3;
    let density = smoothstep(in.densityThreshold, 1.0, noise) * shape;
    if (density < 0.003) { discard; }

    let depthDims     = textureDimensions(depthTexture);
    let clampedCoord  = sceneDepthCoord(in.clipPos.xy, depthDims);
    let sceneDepthRaw = textureLoad(depthTexture, clampedCoord, 0);
    let linearScene   = linearizeDepth(sceneDepthRaw, globals.nearPlane, globals.farPlane);
    let linearFrag    = linearizeDepth(in.clipPos.z,  globals.nearPlane, globals.farPlane);
    // Discard fog fragments that are behind the terrain surface.
    // Tight threshold handles height-texture LOD mismatch between scatter and renderer.
    if (linearScene < linearFrag - 0.1) { discard; }
    // Soft fade at the terrain surface intersection.
    let softDist  = max(in.particleSize * 0.4, 4.0);
    let depthFade = clamp((linearScene - linearFrag + in.particleSize * 0.3) / softDist, 0.0, 1.0);

    let alpha    = density * depthFade * in.opacity * in.color.a;
    if (alpha < 0.003) { discard; }
    let litColor = in.color.rgb * resolveFogLighting(in.particleCenter);
    return vec4<f32>(litColor * alpha, alpha);
}
`;
}
