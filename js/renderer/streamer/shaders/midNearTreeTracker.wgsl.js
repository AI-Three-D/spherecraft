// js/renderer/streamer/shaders/midNearTreeTracker.wgsl.js

export function buildMidNearTreeTrackerShader(config = {}) {
    const WORKGROUP_SIZE = config.workgroupSize ?? 256;
    const MAX_TREES      = config.maxTrees      ?? 7000;
    const ASSET_COUNT    = config.assetCount    ?? 0;

    const srcBandIds   = Array.isArray(config.treeSourceBandIds)   && config.treeSourceBandIds.length   > 0 ? config.treeSourceBandIds   : [0];
    const srcBandBases = Array.isArray(config.treeSourceBandBases) && config.treeSourceBandBases.length > 0 ? config.treeSourceBandBases : [0];
    const srcBandCaps  = Array.isArray(config.treeSourceBandCaps)  && config.treeSourceBandCaps.length  > 0 ? config.treeSourceBandCaps  : [0];
    const SOURCE_BAND_COUNT = srcBandIds.length;
    const cfg = config.midNearConfig ?? {};
    const sbStarts = cfg.subBandStarts ?? [55, 100, 160, 99999];
    const sbEnds   = cfg.subBandEnds   ?? [100, 160, 220, 99999];

    const fmt = (v) => Number(v).toFixed(2);

    return /* wgsl */`

const WORKGROUP_SIZE: u32 = ${WORKGROUP_SIZE}u;
const MAX_MIDNEAR_TREES: u32 = ${MAX_TREES}u;
const ASSET_COUNT: u32 = ${ASSET_COUNT}u;
const SOURCE_BAND_COUNT: u32 = ${SOURCE_BAND_COUNT}u;
const SOURCE_BAND_IDS:   array<u32, SOURCE_BAND_COUNT> = array<u32, SOURCE_BAND_COUNT>(${srcBandIds.map(v => `${v >>> 0}u`).join(', ')});
const SOURCE_BAND_BASES: array<u32, SOURCE_BAND_COUNT> = array<u32, SOURCE_BAND_COUNT>(${srcBandBases.map(v => `${v >>> 0}u`).join(', ')});
const SOURCE_BAND_CAPS:  array<u32, SOURCE_BAND_COUNT> = array<u32, SOURCE_BAND_COUNT>(${srcBandCaps.map(v => `${v >>> 0}u`).join(', ')});

struct TrackerParams {
    cameraPosition: vec3<f32>,
    rangeStart:     f32,
    planetOrigin:   vec3<f32>,
    planetRadius:   f32,
    rangeEnd:       f32,
    subBandOverlap: f32,
    _pad0:          f32,
    _pad1:          f32,
    subBandStarts:  vec4<f32>,
    subBandEnds:    vec4<f32>,
}

struct AssetInstance {
    posX: f32, posY: f32, posZ: f32, rotation: f32,
    width: f32, height: f32,
    tileTypeId: u32, bandIndex: u32,
    colorR: f32, colorG: f32, colorB: f32, colorA: f32,
    surfaceNX: f32, surfaceNY: f32, surfaceNZ: f32, _pad0: f32,
}

struct MidNearTreeInfo {
    worldPosX: f32, worldPosY: f32, worldPosZ: f32, rotation: f32,
    scaleX: f32, scaleY: f32, scaleZ: f32, distanceToCamera: f32,
    speciesIndex: u32, variantSeed: u32, subBand: u32, subBandBlendBits: u32,
    foliageR: f32, foliageG: f32, foliageB: f32, foliageA: f32,
    // Row 4: hull writeback (scatter sets anchorStart/Count, templateIndex)
    anchorStart: u32, anchorCount: u32, templateIndex: u32, impostorCount: u32,
    sourceIndex: u32, _res0: u32, tileTypeId: u32, _res1: u32,
    windPhase: f32, health: f32, age: f32, tierFade: f32,
    _res2: u32, _res3: u32, _res4: u32, _res5: u32,
}

@group(0) @binding(0) var<uniform>             params: TrackerParams;
@group(0) @binding(1) var<storage, read>       treeInstances: array<AssetInstance>;
@group(0) @binding(2) var<storage, read>       treeIndirectArgs: array<u32>;
@group(0) @binding(3) var<storage, read_write> midNearTrees: array<MidNearTreeInfo>;
@group(0) @binding(4) var<storage, read_write> midNearTreeCount: array<atomic<u32>, 1>;
@group(0) @binding(5) var<storage, read>       assetSpeciesMap: array<u32>;

fn pcg(v: u32) -> u32 {
    var s = v * 747796405u + 2891336453u;
    let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
    return (w >> 22u) ^ w;
}
fn pcgF(v: u32) -> f32 { return f32(pcg(v)) / 4294967296.0; }
fn pcg2(a: u32, b: u32) -> u32 { return pcg(a ^ (b * 1664525u + 1013904223u)); }
fn pcg3(a: u32, b: u32, c: u32) -> u32 { return pcg(pcg2(a, b) ^ (c * 2654435761u)); }

fn selectSpeciesForAsset(assetIdx: u32) -> u32 {
    if (assetIdx < ASSET_COUNT) { return assetSpeciesMap[assetIdx]; }
    return 4u;
}

fn getSpeciesFoliageColor(speciesIndex: u32, variation: f32) -> vec4<f32> {
    var base: vec3<f32>; var tip: vec3<f32>;
    switch (speciesIndex) {
        case 0u: { base = vec3<f32>(0.05, 0.15, 0.05); tip = vec3<f32>(0.08, 0.25, 0.08); }
        case 1u: { base = vec3<f32>(0.08, 0.18, 0.06); tip = vec3<f32>(0.12, 0.28, 0.1); }
        case 2u: { base = vec3<f32>(0.15, 0.35, 0.1);  tip = vec3<f32>(0.25, 0.5, 0.15); }
        case 3u: { base = vec3<f32>(0.12, 0.28, 0.08); tip = vec3<f32>(0.2, 0.42, 0.12); }
        case 4u: { base = vec3<f32>(0.1, 0.22, 0.06);  tip = vec3<f32>(0.18, 0.35, 0.12); }
        case 5u: { base = vec3<f32>(0.08, 0.2, 0.05);  tip = vec3<f32>(0.15, 0.32, 0.1); }
        case 6u: { base = vec3<f32>(0.1, 0.35, 0.08);  tip = vec3<f32>(0.15, 0.5, 0.12); }
        case 7u: { base = vec3<f32>(0.12, 0.3, 0.08);  tip = vec3<f32>(0.2, 0.45, 0.15); }
        case 8u: { base = vec3<f32>(0.15, 0.28, 0.1);  tip = vec3<f32>(0.22, 0.4, 0.15); }
        case 9u: { base = vec3<f32>(0.18, 0.32, 0.18); tip = vec3<f32>(0.25, 0.42, 0.22); }
        default: { base = vec3<f32>(0.1, 0.25, 0.08);  tip = vec3<f32>(0.18, 0.38, 0.12); }
    }
    return vec4<f32>(mix(base, tip, variation), 1.0);
}

struct SubBandAssign { band: u32, blend: f32 }

fn assignSubBand(dist: f32) -> SubBandAssign {
    var out: SubBandAssign;
    out.band = 2u;
    out.blend = 0.0;
    let halfOverlap = params.subBandOverlap * 0.5;
    for (var b = 0u; b < 3u; b++) {
        if (dist < params.subBandEnds[b]) {
            out.band = b;
            if (b < 2u) {
                let nextStart = params.subBandStarts[b + 1u] - halfOverlap;
                if (dist >= nextStart) {
                    let overlapW = max(0.001, params.subBandOverlap);
                    out.blend = clamp((dist - nextStart) / overlapW, 0.0, 1.0);
                }
            }
            break;
        }
    }
    return out;
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let threadIdx = gid.x;
    var totalLive: u32 = 0u;
    for (var b = 0u; b < SOURCE_BAND_COUNT; b++) {
        let bandId = SOURCE_BAND_IDS[b];
        let bandCount = treeIndirectArgs[bandId * 5u + 1u];
        totalLive += min(bandCount, SOURCE_BAND_CAPS[b]);
    }
    if (threadIdx >= totalLive) { return; }

    var bandSlot: u32 = 0u;
    var localIdx: u32 = threadIdx;
    for (var b = 0u; b < SOURCE_BAND_COUNT; b++) {
        let bandId = SOURCE_BAND_IDS[b];
        let bandCount = min(treeIndirectArgs[bandId * 5u + 1u], SOURCE_BAND_CAPS[b]);
        if (localIdx < bandCount) {
            bandSlot = b;
            break;
        }
        localIdx = localIdx - bandCount;
    }

    let tree = treeInstances[SOURCE_BAND_BASES[bandSlot] + localIdx];
    let treePos = vec3<f32>(tree.posX, tree.posY, tree.posZ);

    if (dot(treePos, treePos) < 0.001) { return; }

    let trunkUp = normalize(treePos - params.planetOrigin);
    let toCam   = params.cameraPosition - treePos;
    let alongTrunk     = clamp(dot(toCam, trunkUp), 0.0, tree.height);
    let closestOnTrunk = treePos + trunkUp * alongTrunk;
    let dist = length(params.cameraPosition - closestOnTrunk);

    if (dist < params.rangeStart || dist > params.rangeEnd) { return; }

    let slot = atomicAdd(&midNearTreeCount[0], 1u);
    if (slot >= MAX_MIDNEAR_TREES) { return; }

    let posSeed = pcg3(
        bitcast<u32>(tree.posX),
        bitcast<u32>(tree.posY),
        bitcast<u32>(tree.posZ)
    );

    let speciesIdx = selectSpeciesForAsset(tree.tileTypeId);
    let colorVar = pcgF(posSeed ^ 0x12345678u);
    let ageVar   = pcgF(posSeed ^ 0xDEADBEEFu);

    let sba = assignSubBand(dist);
    let foliageColor = getSpeciesFoliageColor(speciesIdx, colorVar);
    let windPhase = pcgF(posSeed ^ 0xCAFEBABEu) * 6.2831853;

    let fadeInEnd    = ${fmt(cfg.fadeInEnd    ?? 68)};
    let fadeOutStart = ${fmt(cfg.fadeOutStart ?? 200)};
    let fadeIn  = smoothstep(params.rangeStart, fadeInEnd, dist);
    let fadeOut = 1.0 - smoothstep(fadeOutStart, params.rangeEnd, dist);
    let tierFade = fadeIn * fadeOut;

    midNearTrees[slot] = MidNearTreeInfo(
        treePos.x, treePos.y, treePos.z, tree.rotation,
        tree.width, tree.height, tree.width, dist,
        speciesIdx, posSeed, sba.band, bitcast<u32>(sba.blend),
        foliageColor.r, foliageColor.g, foliageColor.b, foliageColor.a,
        0u, 0u, 0xFFFFFFFFu, 0u,
        SOURCE_BAND_BASES[bandSlot] + localIdx, 0u, tree.tileTypeId, 0u,
        windPhase, 0.8 + ageVar * 0.2, 0.3 + ageVar * 0.7, tierFade,
        0u, 0u, 0u, 0u
    );
}
`;
}
