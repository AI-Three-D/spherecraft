// js/renderer/streamer/shaders/midTreeTracker.wgsl.js
//
// Tracker for the hull-only mid tier.
//
// Differs from midNearTreeTracker in that this one ALSO resolves the
// template, iterates anchors, and computes canopy bounds. The bounds
// are stored in MidTreeInfo so the VS doesn't have to recompute them
// per-vertex. This is the single biggest perf win in the new system.
//
// One thread per LIVE pool instance. Most threads early-out on the
// range check. For in-range trees, the anchor loop runs once
// (up to MAX_ANCHORS_FOR_BOUNDS iterations).

export function buildMidTreeTrackerShader(config = {}) {
    const WORKGROUP_SIZE = config.workgroupSize ?? 256;
    const MAX_TREES = config.maxTrees ?? 12000;
    const ASSET_COUNT = config.assetCount ?? 0;
    const MAX_ANCHORS_FOR_BOUNDS = config.maxAnchorsForBounds ?? 32;

    const srcBandIds = Array.isArray(config.treeSourceBandIds) && config.treeSourceBandIds.length > 0
        ? config.treeSourceBandIds : [0];
    const srcBandBases = Array.isArray(config.treeSourceBandBases) && config.treeSourceBandBases.length > 0
        ? config.treeSourceBandBases : [0];
    const srcBandCaps = Array.isArray(config.treeSourceBandCaps) && config.treeSourceBandCaps.length > 0
        ? config.treeSourceBandCaps : [0];
    const SOURCE_BAND_COUNT = srcBandIds.length;

    // Bake species canopy profiles as constant arrays. Indexed by species ID.
    // TODO: lift to a storage buffer once species count grows.
    const profiles = config.speciesProfiles ?? {};
    const MAX_SPECIES = 10;
    const profArr = [];
    for (let i = 0; i < MAX_SPECIES; i++) {
        const p = profiles[i] ?? profiles.default ?? { heightFracStart: 0.28, heightFracEnd: 0.95, radialFrac: 0.32 };
        profArr.push(p);
    }
    const fmt = (v) => Number(v).toFixed(4);

    return /* wgsl */`

const WORKGROUP_SIZE: u32 = ${WORKGROUP_SIZE}u;
const MAX_MID_TREES: u32 = ${MAX_TREES}u;
const ASSET_COUNT: u32 = ${ASSET_COUNT}u;
const MAX_ANCHORS_FOR_BOUNDS: u32 = ${MAX_ANCHORS_FOR_BOUNDS}u;

const SOURCE_BAND_COUNT: u32 = ${SOURCE_BAND_COUNT}u;
const SOURCE_BAND_IDS:   array<u32, SOURCE_BAND_COUNT> = array<u32, SOURCE_BAND_COUNT>(${srcBandIds.map(v => `${v >>> 0}u`).join(', ')});
const SOURCE_BAND_BASES: array<u32, SOURCE_BAND_COUNT> = array<u32, SOURCE_BAND_COUNT>(${srcBandBases.map(v => `${v >>> 0}u`).join(', ')});
const SOURCE_BAND_CAPS:  array<u32, SOURCE_BAND_COUNT> = array<u32, SOURCE_BAND_COUNT>(${srcBandCaps.map(v => `${v >>> 0}u`).join(', ')});

// Species canopy profile: [heightFracStart, heightFracEnd, radialFrac, conicalFlag]
// Fallback ellipsoid when anchors unavailable or template missing.
const SPECIES_PROFILES: array<vec4<f32>, ${MAX_SPECIES}> = array<vec4<f32>, ${MAX_SPECIES}>(
${profArr.map(p =>
    `    vec4<f32>(${fmt(p.heightFracStart)}, ${fmt(p.heightFracEnd)}, ${fmt(p.radialFrac)}, ${p.conical ? '1.0' : '0.0'})`
).join(',\n')}
);

struct TrackerParams {
    cameraPosition: vec3<f32>,
    rangeStart: f32,
    planetOrigin: vec3<f32>,
    planetRadius: f32,
    rangeEnd: f32,
    fadeInWidth: f32,
    fadeOutWidth: f32,
    birchTemplateStart: u32,
    birchTemplateCount: u32,
    _pad0: u32, _pad1: u32, _pad2: u32,
}

struct AssetInstance {
    posX: f32, posY: f32, posZ: f32, rotation: f32,
    width: f32, height: f32,
    tileTypeId: u32, bandIndex: u32,
    colorR: f32, colorG: f32, colorB: f32, colorA: f32,
    surfaceNX: f32, surfaceNY: f32, surfaceNZ: f32, _pad0: f32,
}

// 128 bytes. Canopy bounds precomputed here so the VS doesn't repeat
// the anchor iteration per-vertex.
struct MidTreeInfo {
    // Row 0
    worldPosX: f32, worldPosY: f32, worldPosZ: f32, rotation: f32,
    // Row 1
    scaleX: f32, scaleY: f32, scaleZ: f32, distanceToCamera: f32,
    // Row 2
    speciesIndex: u32, variantSeed: u32, templateIndex: u32, tierFadeBits: u32,
    // Row 3
    foliageR: f32, foliageG: f32, foliageB: f32, foliageA: f32,
    // Row 4 — anchor range (for VS residual deform)
    anchorStart: u32, anchorCount: u32, _r40: u32, _r41: u32,
    // Row 5 — precomputed canopy center in tree-local space
    canopyCenterX: f32, canopyCenterY: f32, canopyCenterZ: f32, _r5: f32,
    // Row 6 — precomputed canopy half-extents
    canopyExtentX: f32, canopyExtentY: f32, canopyExtentZ: f32, _r6: f32,
    // Row 7 — reserved
    _r70: f32, _r71: f32, _r72: f32, _r73: f32,
}

struct AnchorPoint {
    posX: f32, posY: f32, posZ: f32, spread: f32,
    dirX: f32, dirY: f32, dirZ: f32, density: f32,
    tier: u32, childStart: u32, childCount: u32, parentIdx: u32,
}

struct TemplateInfo {
    anchorStart: u32, anchorCount: u32,
    fineStart: u32, fineCount: u32,
    mediumStart: u32, mediumCount: u32,
    coarseStart: u32, coarseCount: u32,
    familyStart: u32, familyCount: u32, _pad0: u32, _pad1: u32,
}

@group(0) @binding(0) var<uniform>             params: TrackerParams;
@group(0) @binding(1) var<storage, read>       treeInstances: array<AssetInstance>;
@group(0) @binding(2) var<storage, read>       treeIndirectArgs: array<u32>;
@group(0) @binding(3) var<storage, read_write> midTrees: array<MidTreeInfo>;
@group(0) @binding(4) var<storage, read_write> midTreeCount: array<atomic<u32>, 1>;
@group(0) @binding(5) var<storage, read>       assetSpeciesMap: array<u32>;
@group(0) @binding(6) var<storage, read>       anchors: array<AnchorPoint>;
@group(0) @binding(7) var<storage, read>       templateInfos: array<TemplateInfo>;

fn pcg(v: u32) -> u32 {
    var s = v * 747796405u + 2891336453u;
    let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
    return (w >> 22u) ^ w;
}
fn pcgF(v: u32) -> f32 { return f32(pcg(v)) / 4294967296.0; }
fn pcg3(a: u32, b: u32, c: u32) -> u32 {
    return pcg(pcg(a ^ (b * 1664525u + 1013904223u)) ^ (c * 2654435761u));
}

fn selectSpeciesForAsset(assetIdx: u32) -> u32 {
    if (assetIdx < ASSET_COUNT) { return assetSpeciesMap[assetIdx]; }
    return 2u;   // default birch
}

fn getSpeciesFoliageColor(speciesIndex: u32, variation: f32) -> vec3<f32> {
    var base: vec3<f32>; var tip: vec3<f32>;
    switch (speciesIndex) {
        case 0u: { base = vec3<f32>(0.05, 0.15, 0.05); tip = vec3<f32>(0.08, 0.25, 0.08); }
        case 1u: { base = vec3<f32>(0.08, 0.18, 0.06); tip = vec3<f32>(0.12, 0.28, 0.10); }
        case 2u: { base = vec3<f32>(0.15, 0.35, 0.10); tip = vec3<f32>(0.25, 0.50, 0.15); }
        case 3u: { base = vec3<f32>(0.12, 0.28, 0.08); tip = vec3<f32>(0.20, 0.42, 0.12); }
        case 4u: { base = vec3<f32>(0.10, 0.22, 0.06); tip = vec3<f32>(0.18, 0.35, 0.12); }
        case 5u: { base = vec3<f32>(0.08, 0.20, 0.05); tip = vec3<f32>(0.15, 0.32, 0.10); }
        default: { base = vec3<f32>(0.10, 0.25, 0.08); tip = vec3<f32>(0.18, 0.38, 0.12); }
    }
    return mix(base, tip, variation);
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let threadIdx = gid.x;

    // ── Map thread → (band, local index) using LIVE counts ──────────────
    var totalLive: u32 = 0u;
    for (var b = 0u; b < SOURCE_BAND_COUNT; b++) {
        let bandId = SOURCE_BAND_IDS[b];
        totalLive += min(treeIndirectArgs[bandId * 5u + 1u], SOURCE_BAND_CAPS[b]);
    }
    if (threadIdx >= totalLive) { return; }

    var bandSlot: u32 = 0u;
    var localIdx: u32 = threadIdx;
    for (var b = 0u; b < SOURCE_BAND_COUNT; b++) {
        let bandId = SOURCE_BAND_IDS[b];
        let bandCount = min(treeIndirectArgs[bandId * 5u + 1u], SOURCE_BAND_CAPS[b]);
        if (localIdx < bandCount) { bandSlot = b; break; }
        localIdx = localIdx - bandCount;
    }

    let tree = treeInstances[SOURCE_BAND_BASES[bandSlot] + localIdx];
    let treePos = vec3<f32>(tree.posX, tree.posY, tree.posZ);

    if (dot(treePos, treePos) < 0.001) { return; }

    // ── Distance to trunk axis, not base ─────────────────────────────────
    let trunkUp = normalize(treePos - params.planetOrigin);
    let toCam = params.cameraPosition - treePos;
    let alongTrunk = clamp(dot(toCam, trunkUp), 0.0, tree.height);
    let closestOnTrunk = treePos + trunkUp * alongTrunk;
    let dist = length(params.cameraPosition - closestOnTrunk);

    if (dist < params.rangeStart || dist > params.rangeEnd) { return; }

    let slot = atomicAdd(&midTreeCount[0], 1u);
    if (slot >= MAX_MID_TREES) { return; }

    // ── Species + seed ───────────────────────────────────────────────────
    let posSeed = pcg3(
        bitcast<u32>(tree.posX),
        bitcast<u32>(tree.posY),
        bitcast<u32>(tree.posZ)
    );
    let speciesIdx = selectSpeciesForAsset(tree.tileTypeId);
    let colorVar = pcgF(posSeed ^ 0x12345678u);
    let foliageColor = getSpeciesFoliageColor(speciesIdx, colorVar);

    // ── Tier fade ────────────────────────────────────────────────────────
    let fadeInEnd = params.rangeStart + params.fadeInWidth;
    let fadeOutStart = params.rangeEnd - params.fadeOutWidth;
    let fadeIn = smoothstep(params.rangeStart, fadeInEnd, dist);
    let fadeOut = 1.0 - smoothstep(fadeOutStart, params.rangeEnd, dist);
    let tierFade = fadeIn * fadeOut;

    // ── Template resolution ──────────────────────────────────────────────
    // For now: only birch has templates. Other species fall back to the
    // species profile ellipsoid. TODO: per-species template lookup.
    var templateIndex: u32 = 0xFFFFFFFFu;
    var hullAnchorStart: u32 = 0u;
    var hullAnchorCount: u32 = 0u;

    if (params.birchTemplateStart != 0xFFFFFFFFu && params.birchTemplateCount > 0u) {
        let variantLocal = pcg(posSeed) % params.birchTemplateCount;
        templateIndex = params.birchTemplateStart + variantLocal;
        let info = templateInfos[templateIndex];

        // Use medium anchor tier for bounds — it's the stable silhouette
        // tier. Fine anchors are numerous and noisy; coarse is too sparse.
        if (info.mediumCount > 0u) {
            hullAnchorStart = info.anchorStart + info.mediumStart;
            hullAnchorCount = info.mediumCount;
        } else if (info.coarseCount > 0u) {
            hullAnchorStart = info.anchorStart + info.coarseStart;
            hullAnchorCount = info.coarseCount;
        } else {
            hullAnchorStart = info.anchorStart;
            hullAnchorCount = info.anchorCount;
        }
    }

    // ── Compute canopy bounds ────────────────────────────────────────────
    // This is THE precomputation. Prior system did this per-vertex in VS.
    // Bounds are in tree-local space (scaled by tree dimensions).
    var bmin = vec3<f32>( 1e6);
    var bmax = vec3<f32>(-1e6);

    let scaleVec = vec3<f32>(tree.width, tree.height, tree.width);

    if (hullAnchorCount > 0u) {
        // Anchor-driven bounds. Sample stratified subset if we have more
        // anchors than the iteration budget.
        let sampleCount = min(hullAnchorCount, MAX_ANCHORS_FOR_BOUNDS);
        for (var i = 0u; i < sampleCount; i++) {
            var sampleOffset = i;
            if (hullAnchorCount > sampleCount) {
                sampleOffset = (i * hullAnchorCount) / sampleCount;
            }
            let a = anchors[hullAnchorStart + sampleOffset];
            let localPos = vec3<f32>(a.posX, a.posY, a.posZ) * scaleVec;

            // Spread expands bounds. Asymmetric: less upward (leaves hang),
            // more downward.
            let spreadBase = max(0.001, a.spread);
            let spreadR = clamp(spreadBase * (scaleVec.x + scaleVec.z) * 0.5, 0.05, 2.0);
            let spreadY = spreadR * 0.5;

            bmin = min(bmin, localPos - vec3<f32>(spreadR, spreadY * 0.9, spreadR));
            bmax = max(bmax, localPos + vec3<f32>(spreadR, spreadY * 0.4, spreadR));
        }
    } else {
        // Fallback: species-profile ellipsoid. No anchor data available.
        let profileIdx = min(speciesIdx, ${MAX_SPECIES - 1}u);
        let prof = SPECIES_PROFILES[profileIdx];
        let y0 = prof.x * scaleVec.y;
        let y1 = prof.y * scaleVec.y;
        let r  = prof.z * scaleVec.x;
        bmin = vec3<f32>(-r, y0, -r);
        bmax = vec3<f32>( r, y1,  r);
    }

    // Safety clamp for degenerate cases.
    bmin = min(bmin, vec3<f32>(-0.1, 0.1, -0.1) * scaleVec);
    bmax = max(bmax, vec3<f32>( 0.1, 0.9,  0.1) * scaleVec);

    let canopyCenter = (bmax + bmin) * 0.5;
    let canopyExtent = max((bmax - bmin) * 0.5, vec3<f32>(0.05, 0.10, 0.05));

    // ── Write ────────────────────────────────────────────────────────────
    midTrees[slot] = MidTreeInfo(
        treePos.x, treePos.y, treePos.z, tree.rotation,
        tree.width, tree.height, tree.width, dist,
        speciesIdx, posSeed, templateIndex, bitcast<u32>(tierFade),
        foliageColor.r, foliageColor.g, foliageColor.b, 1.0,
        hullAnchorStart, hullAnchorCount, 0u, 0u,
        canopyCenter.x, canopyCenter.y, canopyCenter.z, 0.0,
        canopyExtent.x, canopyExtent.y, canopyExtent.z, 0.0,
        0.0, 0.0, 0.0, 0.0
    );
}
`;
}