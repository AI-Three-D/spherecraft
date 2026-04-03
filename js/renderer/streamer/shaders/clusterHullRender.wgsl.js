export function buildClusterHullRenderShaders(config = {}) {
    const CONIFER_TOP = config.coniferTopSharpness ?? 0.65;
    const CONIFER_TAPER = config.coniferTaper ?? 0.35;
    const DECID_SPREAD = config.deciduousSpread ?? 0.18;
    const SIDE_LOBE_AMP = config.sideLobeAmp ?? 0.16;
    const TRUNK_FRAC = config.trunkHeightFrac ?? 0.10;
    const MAX_PACKED_TREES = Math.max(1, Math.floor(config.maxPackedTrees ?? config.packedCanopies ?? 4));

    const FRAG_BASE_COV = config.baseCoverage ?? config.fragBaseCoverage ?? 0.74;
    const FRAG_NOISE_SC = config.coverageNoiseScale ?? config.fragNoiseScale ?? 1.6;
    const FRAG_NOISE_AMP = config.coverageNoiseAmp ?? config.fragNoiseAmp ?? 0.18;
    const FRAG_DENS_TO_COV = config.densityToCoverage ?? config.fragDensityToCoverage ?? 0.18;
    const FRAG_EDGE_THIN = config.edgeThin ?? 0.10;
    const FRAG_TOP_THIN = config.topThin ?? 0.08;
    const FRAG_BOTTOM_THIN = config.bottomThin ?? 0.06;

    const fmt = (value) => Number(value).toFixed(4);

    const shared = /* wgsl */`
const CONIFER_TOP: f32 = ${fmt(CONIFER_TOP)};
const CONIFER_TAPER: f32 = ${fmt(CONIFER_TAPER)};
const DECID_SPREAD: f32 = ${fmt(DECID_SPREAD)};
const SIDE_LOBE_AMP: f32 = ${fmt(SIDE_LOBE_AMP)};
const TRUNK_FRAC: f32 = ${fmt(TRUNK_FRAC)};
const MAX_PACKED_TREES: u32 = ${MAX_PACKED_TREES}u;

struct RenderParams {
    viewProjection: mat4x4<f32>,
    cameraPosition: vec3<f32>, _pad0: f32,
    planetOrigin: vec3<f32>, _pad1: f32,
    sunDirection: vec3<f32>, _pad2: f32,
}

struct ClusterTreeRender {
    posX: f32, posY: f32, posZ: f32, rotation: f32,
    footprint: f32, height: f32, coniferFrac: f32, density: f32,
    foliageR: f32, foliageG: f32, foliageB: f32, seed: u32,
    distToCam: f32, tierFade: f32, groupRadius: f32, packedCount: f32,
}

fn pcg(v: u32) -> u32 {
    var s = v * 747796405u + 2891336453u;
    let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
    return (w >> 22u) ^ w;
}

fn pcgF(v: u32) -> f32 {
    return f32(pcg(v)) / 4294967296.0;
}

fn dirFromAngle(angle: f32) -> vec2<f32> {
    return vec2<f32>(cos(angle), sin(angle));
}

fn rotate2(v: vec2<f32>, angle: f32) -> vec2<f32> {
    let c = cos(angle);
    let s = sin(angle);
    return vec2<f32>(v.x * c - v.y * s, v.x * s + v.y * c);
}

fn hash2(p: vec2<f32>) -> f32 {
    var p3 = fract(vec3<f32>(p.xyx) * 0.1031);
    p3 = p3 + dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

fn noise2(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    return mix(
        mix(hash2(i + vec2<f32>(0.0, 0.0)), hash2(i + vec2<f32>(1.0, 0.0)), u.x),
        mix(hash2(i + vec2<f32>(0.0, 1.0)), hash2(i + vec2<f32>(1.0, 1.0)), u.x),
        u.y
    );
}

fn packedTreeCount(inst: ClusterTreeRender) -> u32 {
    return clamp(u32(inst.packedCount + 0.5), 1u, MAX_PACKED_TREES);
}

fn packedTreeOffset(seed: u32, treeIndex: u32, treeCount: u32, groupRadius: f32) -> vec2<f32> {
    if (treeCount <= 1u || groupRadius <= 0.001) {
        return vec2<f32>(0.0, 0.0);
    }
    let baseAngle = pcgF(seed ^ 0x13579BDFu) * 6.2831853;
    let jitter = (pcgF(seed ^ (treeIndex * 0x9E3779B9u + 0x7F4A7C15u)) - 0.5) * 0.35;
    let ringAngle = baseAngle + f32(treeIndex) * (6.2831853 / f32(treeCount)) + jitter;
    var radius = groupRadius * 0.72;
    if (treeCount >= 3u) {
        radius = groupRadius * 0.82;
    }
    if (treeCount >= 4u && treeIndex == 0u) {
        return vec2<f32>(0.0, 0.0);
    }
    if (treeCount >= 4u) {
        let around = f32(treeIndex - 1u) * (6.2831853 / 3.0) + baseAngle;
        return dirFromAngle(around + jitter) * groupRadius;
    }
    return dirFromAngle(ringAngle) * radius;
}

fn packedTreeScale(seed: u32, treeIndex: u32, treeCount: u32, coniferFrac: f32) -> vec2<f32> {
    var base = 1.0;
    if (treeCount > 1u && treeIndex > 0u) {
        base = 0.84;
    }
    if (treeCount > 2u && treeIndex > 1u) {
        base = 0.76;
    }
    let rand = 0.90 + pcgF(seed ^ (treeIndex * 0xBB67AE85u + 0x3C6EF372u)) * 0.18;
    let radial = base * rand * mix(1.02, 0.94, clamp(coniferFrac, 0.0, 1.0));
    let height = base * rand * mix(0.94, 1.08, clamp(coniferFrac, 0.0, 1.0));
    return vec2<f32>(radial, height);
}
`;

    const vs = /* wgsl */`
${shared}

struct VSIn {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) canopyId: f32,
}

struct VSOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) worldNormal: vec3<f32>,
    @location(1) foliageColor: vec3<f32>,
    @location(2) @interpolate(flat) seed: u32,
    @location(3) localPos: vec3<f32>,
    @location(4) shapeData: vec4<f32>,
    @location(5) distToCam: f32,
    @location(6) @interpolate(flat) activeTree: f32,
}

@group(0) @binding(0) var<uniform> params: RenderParams;
@group(0) @binding(1) var<storage, read> instances: array<ClusterTreeRender>;

@vertex
fn vsMain(in: VSIn, @builtin(instance_index) instanceIndex: u32) -> VSOut {
    let inst = instances[instanceIndex];
    let cf = clamp(inst.coniferFrac, 0.0, 1.0);
    let treeIndex = u32(in.canopyId + 0.5);
    let treeCount = packedTreeCount(inst);
    let isActive = treeIndex < treeCount;
    let activeTree = select(0.0, 1.0, isActive);
    let treeSeed = pcg(inst.seed ^ (treeIndex * 0x9E3779B9u + 0x6A09E667u));

    var dirXZ = in.position.xz;
    let dirLen = length(dirXZ);
    if (dirLen > 1e-5) {
        dirXZ = dirXZ / dirLen;
    } else {
        dirXZ = vec2<f32>(1.0, 0.0);
    }

    let treeScale = packedTreeScale(inst.seed, treeIndex, treeCount, cf);
    let treeFootprint = inst.footprint * treeScale.x;
    let treeHeight = inst.height * treeScale.y;
    let treeOffset = packedTreeOffset(inst.seed, treeIndex, treeCount, inst.groupRadius);

    let yNorm = clamp(in.position.y * 0.5 + 0.5, 0.0, 1.0);
    let decidBand = (yNorm - 0.52) / 0.64;
    let baseDecid = sqrt(max(0.0, 1.0 - decidBand * decidBand));
    let baseConif = pow(max(0.0, 1.0 - yNorm), 0.80);
    var radial = mix(
        baseDecid * (1.0 + DECID_SPREAD * sin(yNorm * 3.14159265)),
        baseConif * (1.0 - CONIFER_TAPER * yNorm * 0.34),
        cf
    );

    let trunkHeight = treeHeight * TRUNK_FRAC;
    let canopyHeight = treeHeight * (1.0 - TRUNK_FRAC);
    let shoulderBand = smoothstep(0.10, 0.26, yNorm) * (1.0 - smoothstep(0.82, 0.98, yNorm));
    let azPhase = pcgF(treeSeed ^ 0xC001D00Du) * 6.2831853;
    let azNoise = sin(dirXZ.x * 5.7 + dirXZ.y * 4.9 + azPhase);
    radial = radial * max(0.64, 1.0 + azNoise * SIDE_LOBE_AMP * 0.45 * shoulderBand);
    radial = radial * (1.0 - smoothstep(0.74, 1.0, yNorm) * mix(0.08, CONIFER_TOP * 0.40, cf));
    radial = max(radial, 0.04);

    let crownLift = shoulderBand * azNoise * canopyHeight * mix(0.03, 0.08, cf)
        + smoothstep(0.60, 1.0, yNorm) * cf * canopyHeight * 0.10;

    var canopyLocalPos = vec3<f32>(
        treeOffset.x + dirXZ.x * radial * treeFootprint,
        trunkHeight + yNorm * canopyHeight + crownLift,
        treeOffset.y + dirXZ.y * radial * treeFootprint
    );

    var treeOnlyLocal = vec3<f32>(
        dirXZ.x * radial * treeFootprint,
        trunkHeight + yNorm * canopyHeight + crownLift,
        dirXZ.y * radial * treeFootprint
    );

    var localN = normalize(vec3<f32>(
        treeOnlyLocal.x / max(treeFootprint, 0.05),
        (treeOnlyLocal.y - (trunkHeight + canopyHeight * 0.55)) / max(canopyHeight * 0.55, 0.05),
        treeOnlyLocal.z / max(treeFootprint, 0.05)
    ));

    if (!isActive) {
        canopyLocalPos = vec3<f32>(0.0, -inst.height * 2.0, 0.0);
        treeOnlyLocal = vec3<f32>(0.0);
        localN = vec3<f32>(0.0, 1.0, 0.0);
    }

    let worldBase = vec3<f32>(inst.posX, inst.posY, inst.posZ);
    let up = normalize(worldBase - params.planetOrigin);
    var refDir = vec3<f32>(0.0, 1.0, 0.0);
    if (abs(dot(up, refDir)) > 0.99) {
        refDir = vec3<f32>(1.0, 0.0, 0.0);
    }
    let tangent = normalize(cross(up, refDir));
    let bitangent = normalize(cross(up, tangent));
    let cosR = cos(inst.rotation);
    let sinR = sin(inst.rotation);
    let rotTan = tangent * cosR + bitangent * sinR;
    let rotBit = -tangent * sinR + bitangent * cosR;

    let worldPos = worldBase + rotTan * canopyLocalPos.x + up * canopyLocalPos.y + rotBit * canopyLocalPos.z;
    let worldN = normalize(rotTan * localN.x + up * localN.y + rotBit * localN.z);

    var out: VSOut;
    out.clip = params.viewProjection * vec4<f32>(worldPos, 1.0);
    out.worldNormal = worldN;
    out.foliageColor = vec3<f32>(inst.foliageR, inst.foliageG, inst.foliageB);
    out.seed = treeSeed;
    out.localPos = treeOnlyLocal;
    out.shapeData = vec4<f32>(treeFootprint, treeHeight, inst.density, inst.tierFade);
    out.distToCam = inst.distToCam;
    out.activeTree = activeTree;
    return out;
}
`;

    const fs = /* wgsl */`
${shared}

const BASE_COVERAGE: f32 = ${fmt(FRAG_BASE_COV)};
const NOISE_SCALE: f32 = ${fmt(FRAG_NOISE_SC)};
const NOISE_AMP: f32 = ${fmt(FRAG_NOISE_AMP)};
const DENS_TO_COV: f32 = ${fmt(FRAG_DENS_TO_COV)};
const EDGE_THIN: f32 = ${fmt(FRAG_EDGE_THIN)};
const TOP_THIN: f32 = ${fmt(FRAG_TOP_THIN)};
const BOTTOM_THIN: f32 = ${fmt(FRAG_BOTTOM_THIN)};

struct FSIn {
    @builtin(position) fragCoord: vec4<f32>,
    @location(0) worldNormal: vec3<f32>,
    @location(1) foliageColor: vec3<f32>,
    @location(2) @interpolate(flat) seed: u32,
    @location(3) localPos: vec3<f32>,
    @location(4) shapeData: vec4<f32>,
    @location(5) distToCam: f32,
    @location(6) @interpolate(flat) activeTree: f32,
}

@group(0) @binding(0) var<uniform> params: RenderParams;

@fragment
fn fsMain(in: FSIn) -> @location(0) vec4<f32> {
    if (in.activeTree <= 0.0) {
        discard;
    }

    let footprint = max(in.shapeData.x, 0.001);
    let height = max(in.shapeData.y, 0.001);
    let density = clamp(in.shapeData.z, 0.0, 1.0);
    let tierFade = clamp(in.shapeData.w, 0.0, 1.0);

    let canopyHeight = height * (1.0 - TRUNK_FRAC);
    let trunkHeight = height * TRUNK_FRAC;
    let localXZ = in.localPos.xz / footprint;
    let radialLen = length(localXZ);
    if (radialLen > 1.08) {
        discard;
    }
    let yNorm = clamp((in.localPos.y - trunkHeight) / max(canopyHeight, 0.001), 0.0, 1.0);

    let verticalMask = 1.0 - pow(abs(yNorm - 0.56) * 2.0, 1.62) * 0.30;
    let rimThin = smoothstep(0.74, 1.02, radialLen);
    let topThin = smoothstep(0.80, 1.0, yNorm);
    let bottomThin = 1.0 - smoothstep(0.04, 0.20, yNorm);
    let densityCoverage = (density - 0.5) * DENS_TO_COV;

    let seedOffset = vec2<f32>(pcgF(in.seed) * 50.0, pcgF(pcg(in.seed)) * 50.0);
    let noiseCoord = localXZ * NOISE_SCALE + vec2<f32>(yNorm * 0.36, yNorm * 0.22) + seedOffset;
    let coverageNoise = (noise2(noiseCoord) - 0.5) * NOISE_AMP;
    var coverage = (BASE_COVERAGE + densityCoverage + coverageNoise) * verticalMask;
    coverage = coverage - rimThin * EDGE_THIN;
    coverage = coverage - topThin * TOP_THIN;
    coverage = coverage - bottomThin * BOTTOM_THIN;
    coverage = coverage + (1.0 - rimThin) * 0.05;
    coverage = clamp(coverage, 0.05, 0.95);

    let discardNoise = noise2(localXZ * 7.0 + vec2<f32>(yNorm * 4.0, yNorm * 3.0) + seedOffset * 0.5);
    if (discardNoise > coverage * tierFade) {
        discard;
    }

    let N = normalize(in.worldNormal);
    let L = normalize(params.sunDirection);
    let wrapped = max(0.0, (dot(N, L) + 0.28) / 1.28);

    var lit = in.foliageColor * (0.30 + wrapped * 0.62);
    let topTint = mix(0.92, 1.04, smoothstep(0.35, 0.95, yNorm));
    lit = lit * topTint;

    let luma = dot(lit, vec3<f32>(0.299, 0.587, 0.114));
    let distDesat = smoothstep(900.0, 7000.0, in.distToCam) * 0.12;
    lit = mix(lit, vec3<f32>(luma), distDesat);

    return vec4<f32>(lit, 1.0);
}
`;

    return { vs, fs };
}
