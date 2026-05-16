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
    @location(13) @interpolate(flat) sliceWeight: f32,
    @location(14) @interpolate(flat) camDist: f32,
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
    let sliceWeight = 1.0;

    let radiusA = max(2.0, p.size);
    let radiusB = max(2.0, p.size * max(td.horizontalScale, 0.05));
    var halfHeight = max(1.5, p.size * max(td.verticalScale, 0.01));
    let centerLiftScale = clamp(td.centerLiftScale, 0.0, 1.0);
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
    out.sliceWeight     = sliceWeight;
    out.camDist         = length(volumeCenter - globals.cameraPos);
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
               radiusA: f32, radiusB: f32, halfHeight: f32) -> f32 {
    let localUp = resolveLocalUp(center);
    let basis = stableTangentBasis(localUp, phase);
    let offset = worldPos - center;
    let lx = dot(offset, basis.a) / max(radiusA, 0.001);
    let lz = dot(offset, basis.b) / max(radiusB, 0.001);
    let ly = dot(offset, localUp) / max(halfHeight, 0.001);
    let d = sqrt(lx * lx + lz * lz + ly * ly);
    let ellipsoid = 1.0 - smoothstep(0.72, 1.0, d);
    let floorFade = smoothstep(-1.0, -0.86, ly);
    let topFade = 1.0 - smoothstep(0.50, 0.94, ly);
    return clamp(ellipsoid * floorFade * topFade, 0.0, 1.0);
}

// Exact ellipsoid intersection — avoids wasted steps in the sphere-overestimate zone.
// Returns t-values in original ray space; scale 1.15 pads for the smoothstep edge.
fn rayEllipsoidIntersect(ro: vec3<f32>, rd: vec3<f32>, center: vec3<f32>,
                          phase: vec3<f32>, rA: f32, rB: f32, hH: f32) -> vec2<f32> {
    let localUp = resolveLocalUp(center);
    let basis   = stableTangentBasis(localUp, phase);
    let oc      = ro - center;
    let sA = rA * 1.15;  let sH = hH * 1.15;  let sB = rB * 1.15;
    let oc_s = vec3<f32>(dot(oc, basis.a) / sA, dot(oc, localUp) / sH, dot(oc, basis.b) / sB);
    let rd_s = vec3<f32>(dot(rd, basis.a) / sA, dot(rd, localUp) / sH, dot(rd, basis.b) / sB);
    let A    = dot(rd_s, rd_s);
    let B    = dot(oc_s, rd_s);
    let C    = dot(oc_s, oc_s) - 1.0;
    let disc = B * B - A * C;
    if (disc < 0.0) { return vec2<f32>(-1.0, -1.0); }
    let sq = sqrt(disc);
    return vec2<f32>((-B - sq) / A, (-B + sq) / A);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    // Distance-gated step count — flat varying so no intra-instance divergence.
    var steps: i32 = 2;
    if      (in.camDist < 40.0)  { steps = 6; }
    else if (in.camDist < 80.0)  { steps = 5; }
    else if (in.camDist < 200.0) { steps = 4; }

    let ro  = globals.cameraPos;
    let rd  = normalize(in.worldPos - ro);
    // Exact ellipsoid bounds — every step lands inside the actual volume.
    let hit = rayEllipsoidIntersect(ro, rd, in.particleCenter, in.noisePhase,
                                    in.radiusA, in.radiusB, in.halfHeight);
    if (hit.y < 0.0 || hit.x > hit.y) { discard; }

    let tStart   = max(hit.x, 0.001);
    let tEnd     = hit.y;
    let stepSize = (tEnd - tStart) / f32(steps);

    var accumulated = 0.0;
    for (var i: i32 = 0; i < 6; i++) {
        if (i >= steps) { break; }
        // Centred sampling within each step interval — no jitter needed.
        let t  = tStart + (f32(i) + 0.5) * stepSize;
        let wp = ro + rd * t;

        let shape = volumeShape(wp, in.particleCenter, in.noisePhase,
                                in.radiusA, in.radiusB, in.halfHeight);
        if (shape < 0.01) { continue; }

        let noiseCoord = wp * in.noiseScale + in.noisePhase +
            vec3<f32>(globals.time * in.noiseSpeed, 0.0, globals.time * in.noiseSpeed * 0.7);
        let n1 = textureSampleLevel(noiseBase, noiseSampler, fract(noiseCoord), 0.0).r;
        // Skip detail noise for far particles — saves one texture fetch per step.
        var noise = n1;
        if (in.camDist < 200.0) {
            let n2 = textureSampleLevel(noiseDetail, noiseSampler,
                fract(noiseCoord * 2.7 + vec3<f32>(0.3, 0.7, 0.1)), 1.0).r;
            noise = n1 * 0.7 + n2 * 0.3;
        }

        let density = smoothstep(in.densityThreshold, 1.0, noise) * shape;
        // Normalise by step count so opacity is independent of particle size.
        accumulated += density / f32(steps);
        if (accumulated > 0.95) { break; }
    }

    if (accumulated < 0.003) { discard; }

    let depthDims    = textureDimensions(depthTexture);
    let clampedCoord = sceneDepthCoord(in.clipPos.xy, depthDims);
    let sceneDepthRaw = textureLoad(depthTexture, clampedCoord, 0);
    let linearScene  = linearizeDepth(sceneDepthRaw, globals.nearPlane, globals.farPlane);
    let linearFrag   = linearizeDepth(in.clipPos.z,  globals.nearPlane, globals.farPlane);
    let softDist     = max(in.particleSize * 0.30, 14.0);
    let depthBias    = max(in.particleSize * 0.05,  1.25);
    let depthFade    = clamp((linearScene - linearFrag + depthBias) / softDist, 0.0, 1.0);

    let alpha    = clamp(accumulated, 0.0, 1.0) * depthFade * in.opacity * in.color.a;
    if (alpha < 0.003) { discard; }
    let litColor = in.color.rgb * resolveFogLighting(in.particleCenter);
    return vec4<f32>(litColor * alpha, alpha);
}
`;
}
