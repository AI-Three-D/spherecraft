import { buildAtmoBankCommonWGSL } from './atmoBankCommon.wgsl.js';

export function buildAtmoBankRenderWGSL({ typeCapacity = 4, sliceCount = 5 } = {}) {
    const common = buildAtmoBankCommonWGSL({ typeCapacity });
    const volumeSliceCount = Math.max(1, Math.floor(sliceCount));

    return /* wgsl */`
${common}

const ATMO_VOLUME_SLICE_COUNT: u32 = ${volumeSliceCount}u;

@group(0) @binding(0) var<uniform>       globals   : AtmoGlobals;
@group(0) @binding(1) var<storage, read> particles : array<AtmoParticle>;
@group(0) @binding(2) var<storage, read> liveList  : array<u32>;
@group(0) @binding(3) var<uniform>       typeDefs  : array<AtmoTypeDef, ATMO_TYPE_CAPACITY>;

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
    @location(13) @interpolate(flat) sliceWeight: f32,
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

fn verticalScaleForType(ptype: u32) -> f32 {
    if (ptype == 2u) { return 0.24; }
    if (ptype == 1u) { return 0.16; }
    return 0.13;
}

fn horizontalScaleForType(ptype: u32) -> f32 {
    if (ptype == 2u) { return 0.95; }
    if (ptype == 1u) { return 0.84; }
    return 1.05;
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
    let sliceId = min(vid / 6u, ATMO_VOLUME_SLICE_COUNT - 1u);
    let denom = max(f32(ATMO_VOLUME_SLICE_COUNT - 1u), 1.0);
    let sliceT = (f32(sliceId) / denom) * 2.0 - 1.0;
    let sliceWeight = (1.0 - abs(sliceT) * 0.35) * (1.28 / f32(ATMO_VOLUME_SLICE_COUNT));

    let radiusA = max(2.0, p.size);
    let radiusB = max(2.0, p.size * horizontalScaleForType(p.ptype));
    let halfHeight = max(1.5, p.size * verticalScaleForType(p.ptype));
    let volumeCenter = p.position + localUp * halfHeight;

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
    out.sliceWeight     = sliceWeight;
    return out;
}

fn linearizeDepth(d: f32, near: f32, far: f32) -> f32 {
    return (near * far) / (far - d * (far - near));
}

fn volumeShape(worldPos: vec3<f32>, center: vec3<f32>, phase: vec3<f32>,
               radiusA: f32, radiusB: f32, halfHeight: f32) -> f32 {
    let localUp = resolveLocalUp(center);
    let basis = stableTangentBasis(localUp, phase);
    let offset = worldPos - center;
    let lx = dot(offset, basis.a) / max(radiusA, 0.001);
    let lz = dot(offset, basis.b) / max(radiusB, 0.001);
    let ly = dot(offset, localUp) / max(halfHeight, 0.001);
    let d = sqrt(lx * lx + lz * lz + ly * ly);
    let ellipsoid = 1.0 - smoothstep(0.72, 1.0, d);
    let floorFade = smoothstep(-1.0, -0.72, ly);
    return clamp(ellipsoid * floorFade, 0.0, 1.0);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    let shape = volumeShape(
        in.worldPos,
        in.particleCenter,
        in.noisePhase,
        in.radiusA,
        in.radiusB,
        in.halfHeight
    );
    if (shape <= 0.001) { discard; }

    let noiseCoord = in.worldPos * in.noiseScale + in.noisePhase +
                     vec3<f32>(globals.time * in.noiseSpeed, 0.0, globals.time * in.noiseSpeed * 0.7);

    let n1 = textureSampleLevel(noiseBase, noiseSampler, fract(noiseCoord), 0.0).r;
    let n2 = textureSampleLevel(noiseDetail, noiseSampler, fract(noiseCoord * 2.7 + vec3<f32>(0.3, 0.7, 0.1)), 1.0).r;
    let noise = n1 * 0.7 + n2 * 0.3;

    let density = smoothstep(in.densityThreshold, 1.0, noise) * shape;

    let depthDims = textureDimensions(depthTexture);
    let depthUV = vec2<i32>(in.clipPos.xy);
    let clampedCoord = clamp(depthUV, vec2<i32>(0), vec2<i32>(depthDims) - vec2<i32>(1));
    let sceneDepthRaw = textureLoad(depthTexture, clampedCoord, 0);
    let linearScene = linearizeDepth(sceneDepthRaw, globals.nearPlane, globals.farPlane);
    let linearFrag  = linearizeDepth(in.clipPos.z, globals.nearPlane, globals.farPlane);
    let softDist = max(in.particleSize * 0.30, 14.0);
    let depthBias = max(in.particleSize * 0.05, 1.25);
    let depthFade = clamp((linearScene - linearFrag + depthBias) / softDist, 0.0, 1.0);

    let alpha = density * depthFade * in.opacity * in.color.a * in.sliceWeight;
    if (alpha < 0.003) { discard; }
    let litColor = in.color.rgb * resolveFogLighting(in.particleCenter);
    return vec4<f32>(litColor * alpha, alpha);
}
`;
}
