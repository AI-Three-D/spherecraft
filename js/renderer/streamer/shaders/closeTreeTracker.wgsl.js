export function buildCloseTreeTrackerShader(config = {}) {
    const WORKGROUP_SIZE = config.workgroupSize ?? 256;
    const MAX_CLOSE_TREES = config.maxCloseTrees ?? 512;
    const SPECIES_COUNT = config.speciesCount ?? 11;
    const ASSET_COUNT = config.assetCount ?? 0;
    const srcBandIds = Array.isArray(config.treeSourceBandIds) && config.treeSourceBandIds.length > 0
        ? config.treeSourceBandIds
        : [0];
    const srcBandBases = Array.isArray(config.treeSourceBandBases) && config.treeSourceBandBases.length === srcBandIds.length
        ? config.treeSourceBandBases
        : [0];
    const srcBandCaps = Array.isArray(config.treeSourceBandCaps) && config.treeSourceBandCaps.length === srcBandIds.length
        ? config.treeSourceBandCaps
        : [0];
    const SOURCE_BAND_COUNT = srcBandIds.length;


    return /* wgsl */`

const WORKGROUP_SIZE: u32 = ${WORKGROUP_SIZE}u;
const MAX_CLOSE_TREES: u32 = ${MAX_CLOSE_TREES}u;
const SPECIES_COUNT: u32 = ${SPECIES_COUNT}u;
const ASSET_COUNT: u32 = ${ASSET_COUNT}u;
const SOURCE_BAND_COUNT: u32 = ${SOURCE_BAND_COUNT}u;

const SOURCE_BAND_IDS: array<u32, SOURCE_BAND_COUNT> = array<u32, SOURCE_BAND_COUNT>(${srcBandIds.map(v => `${v >>> 0}u`).join(', ')});
const SOURCE_BAND_BASES: array<u32, SOURCE_BAND_COUNT> = array<u32, SOURCE_BAND_COUNT>(${srcBandBases.map(v => `${v >>> 0}u`).join(', ')});


// ── Structs ──────────────────────────────────────────────────────────────

// Leaf-card LOD band boundaries. Bands overlap; the assignBand loop
// picks the LOWEST band that still contains the distance and computes
// a 0..1 blend across the overlap with the next band. The scatter
// shader does the actual stochastic transition.
//
// Four bands currently (L0–L3). L4+ is a separate far-band system;
// trees beyond L3's end fall out of detailRange and aren't tracked here.
struct TrackerParams {
    cameraPosition: vec3<f32>,
    detailRange:    f32,
    planetOrigin:   vec3<f32>,
    planetRadius:   f32,
    time:           f32,
    _res0:          u32,
    _res1:          u32,
    _pad0:          u32,
    bandStarts:     vec4<f32>,   // [L0, L1, L2, L3] start distances
    bandEnds:       vec4<f32>,   // [L0, L1, L2, L3] end distances
}

struct AssetInstance {
    posX: f32, posY: f32, posZ: f32, rotation: f32,
    width: f32, height: f32,
    tileTypeId: u32, bandIndex: u32,
    colorR: f32, colorG: f32, colorB: f32, colorA: f32,
    surfaceNX: f32, surfaceNY: f32, surfaceNZ: f32, _pad0: f32,
}

// 128 bytes (8 × 16B rows). Row 8 is new: bandBlend + reserved.
struct CloseTreeInfo {
    worldPosX: f32, worldPosY: f32, worldPosZ: f32, rotation: f32,
    scaleX: f32, scaleY: f32, scaleZ: f32, distanceToCamera: f32,
    speciesIndex: u32, variantSeed: u32, detailLevel: u32, sourceIndex: u32,
    foliageR: f32, foliageG: f32, foliageB: f32, foliageA: f32,
    barkR: f32, barkG: f32, barkB: f32, barkA: f32,
    leafStart: u32, leafCount: u32, clusterStart: u32, clusterCount: u32,
    windPhase: f32, health: f32, age: f32, tileTypeId: u32,
    bandBlend: f32, _res0: f32, _res1: f32, _res2: f32,
}

// ── Bindings ─────────────────────────────────────────────────────────────

@group(0) @binding(0) var<uniform>             params: TrackerParams;
@group(0) @binding(1) var<storage, read>       treeInstances: array<AssetInstance>;
@group(0) @binding(2) var<storage, read>       treeIndirectArgs: array<u32>;
@group(0) @binding(3) var<storage, read_write> closeTrees: array<CloseTreeInfo>;
@group(0) @binding(4) var<storage, read_write> closeTreeCount: array<atomic<u32>, 1>;
@group(0) @binding(5) var<storage, read>       assetSpeciesMap: array<u32>;

// ── PCG ──────────────────────────────────────────────────────────────────

fn pcg(v: u32) -> u32 {
    var s = v * 747796405u + 2891336453u;
    let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
    return (w >> 22u) ^ w;
}
fn pcgF(v: u32) -> f32 { return f32(pcg(v)) / 4294967296.0; }
fn pcg2(a: u32, b: u32) -> u32 { return pcg(a ^ (b * 1664525u + 1013904223u)); }
fn pcg3(a: u32, b: u32, c: u32) -> u32 { return pcg(pcg2(a, b) ^ (c * 2654435761u)); }

// ── Species ──────────────────────────────────────────────────────────────

fn selectSpeciesForAsset(assetIdx: u32) -> u32 {
    if (assetIdx < ASSET_COUNT) { return assetSpeciesMap[assetIdx]; }
    return 4u;
}

// ── Band assignment with overlap blend ───────────────────────────────────
// Returns (band, blend). band is the LOWEST band whose end > dist.
// If dist is in the overlap with band+1 (i.e. dist >= bandStarts[band+1]),
// blend ramps 0→1 across [bandStarts[band+1], bandEnds[band]].
// Outside any overlap, blend = 0.
//
// The scatter shader uses blend for stochastic per-anchor transitions:
// at blend=0.5, half the anchors emit as band N, half as band N+1.
struct BandAssign { level: u32, blend: f32 }

fn assignBand(dist: f32) -> BandAssign {
    var out: BandAssign;
    out.level = 3u;   // fallback: last band (L3). Beyond that, tree
    out.blend = 0.0;  // wouldn't be in detailRange anyway.

    for (var b = 0u; b < 4u; b++) {
        if (dist < params.bandEnds[b]) {
            out.level = b;
            if (b < 3u) {
                let nextStart = params.bandStarts[b + 1u];
                if (dist >= nextStart) {
                    let overlapW = max(0.001, params.bandEnds[b] - nextStart);
                    out.blend = clamp((dist - nextStart) / overlapW, 0.0, 1.0);
                }
            }
            break;
        }
    }
    return out;
}

// ── Species colours (unchanged from current) ─────────────────────────────
${/* ... keep getSpeciesFoliageColor and getSpeciesBarkColor exactly as-is ... */''}

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

fn getSpeciesBarkColor(speciesIndex: u32, variation: f32) -> vec4<f32> {
    var color: vec3<f32>;
    switch (speciesIndex) {
        case 0u: { color = vec3<f32>(0.25, 0.18, 0.12); }
        case 1u: { color = vec3<f32>(0.4, 0.28, 0.18); }
        case 2u: { color = vec3<f32>(1.0, 1.0, 1.0); }
        case 3u: { color = vec3<f32>(0.35, 0.28, 0.22); }
        case 4u: { color = vec3<f32>(0.3, 0.22, 0.15); }
        case 5u: { color = vec3<f32>(0.5, 0.48, 0.45); }
        case 6u: { color = vec3<f32>(0.45, 0.35, 0.25); }
        case 7u: { color = vec3<f32>(0.4, 0.32, 0.22); }
        case 8u: { color = vec3<f32>(0.55, 0.48, 0.4); }
        case 9u: { color = vec3<f32>(0.2, 0.35, 0.18); }
        default: { color = vec3<f32>(0.35, 0.25, 0.18); }
    }
    if (speciesIndex != 2u) { color = color + (variation - 0.5) * 0.05; }
    return vec4<f32>(clamp(color, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}

// ── Main ─────────────────────────────────────────────────────────────────

@compute @workgroup_size(WORKGROUP_SIZE)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let threadIdx = gid.x;

    // Map flat thread index → (sourceBand, localIndexWithinBand) using
    // LIVE instance counts from treeIndirectArgs, not static capacities.
    // Dispatch is sized to ceil(sum(liveCounts)/WG), so threads past the
    // sum fall through the loop without matching and return.
    var bandSlot: u32 = 0xFFFFFFFFu;
    var localIdx: u32 = threadIdx;
    for (var b = 0u; b < SOURCE_BAND_COUNT; b++) {
        let count = treeIndirectArgs[SOURCE_BAND_IDS[b] * 5u + 1u];
        if (localIdx < count) {
            bandSlot = b;
            break;
        }
        localIdx = localIdx - count;
    }
    if (bandSlot == 0xFFFFFFFFu) { return; }

    let bandId = SOURCE_BAND_IDS[bandSlot];

    let tree = treeInstances[SOURCE_BAND_BASES[bandSlot] + localIdx];
    let treePos = vec3<f32>(tree.posX, tree.posY, tree.posZ);

    if (dot(treePos, treePos) < 0.001) { return; }

    // ── Distance to trunk segment, not base ─────────────────────────
    // Root cause of the climb-the-trunk LOD pop: distance was measured
    // to the tree BASE. Climb alongside a 20m trunk → base-distance
    // grows past 15m while the canopy is at eye level → detailLevel
    // jumps to L2+. Measure to the nearest point on the trunk axis
    // [base, base + up * height] instead. On a spherical planet, "up"
    // for this tree is radially outward from planet centre.
    let trunkUp = normalize(treePos - params.planetOrigin);
    let toCam   = params.cameraPosition - treePos;
    let alongTrunk     = clamp(dot(toCam, trunkUp), 0.0, tree.height);
    let closestOnTrunk = treePos + trunkUp * alongTrunk;
    let dist = length(params.cameraPosition - closestOnTrunk);

    if (dist > params.detailRange) { return; }

    let slot = atomicAdd(&closeTreeCount[0], 1u);
    if (slot >= MAX_CLOSE_TREES) { return; }

    let posSeed = pcg3(
        bitcast<u32>(tree.posX),
        bitcast<u32>(tree.posY),
        bitcast<u32>(tree.posZ)
    );

    let speciesIdx = selectSpeciesForAsset(tree.tileTypeId);
    let colorVar = pcgF(posSeed ^ 0x12345678u);
    let barkVar  = pcgF(posSeed ^ 0x87654321u);
    let ageVar   = pcgF(posSeed ^ 0xDEADBEEFu);

    // ── Band + blend in one pass ────────────────────────────────────
    let band = assignBand(dist);

    let foliageColor = getSpeciesFoliageColor(speciesIdx, colorVar);
    let barkColor    = getSpeciesBarkColor(speciesIdx, barkVar);
    let windPhase    = pcgF(posSeed ^ 0xCAFEBABEu) * 6.2831853;

    closeTrees[slot] = CloseTreeInfo(
        treePos.x, treePos.y, treePos.z, tree.rotation,
        tree.width, tree.height, tree.width, dist,
        speciesIdx, posSeed, band.level, SOURCE_BAND_BASES[bandSlot] + localIdx,
        foliageColor.r, foliageColor.g, foliageColor.b, foliageColor.a,
        barkColor.r, barkColor.g, barkColor.b, barkColor.a,
        0u, 0u, 0u, 0u,                          // leafStart/Count set by scatter writeback
        windPhase, 0.8 + ageVar * 0.2, 0.3 + ageVar * 0.7, tree.tileTypeId,
        band.blend, 0.0, 0.0, 0.0                // bandBlend + reserved
    );
}
`;
}
