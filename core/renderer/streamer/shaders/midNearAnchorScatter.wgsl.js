// js/renderer/streamer/shaders/midNearAnchorScatter.wgsl.js

export function buildMidNearTrunkScatterShader(config = {}) {
    const MAX_TREES = config.maxTrees ?? 7000;
    const cfg = config.midNearConfig ?? {};
    const fmt = (v, fb) => Number(Number.isFinite(v) ? v : fb).toFixed(4);

    return /* wgsl */`

const MAX_MIDNEAR_TREES: u32 = ${MAX_TREES}u;
const TRUNK_HEIGHT_FRAC: f32 = ${fmt(cfg.trunkVisibleHeightFrac, 0.40)};
const TRUNK_RADIUS_FRAC: f32 = ${fmt(cfg.trunkBaseRadiusFrac, 0.025)};
const TRUNK_RADIUS_MIN:  f32 = 0.06;
const TRUNK_RADIUS_MAX:  f32 = 0.40;

struct MidNearTreeInfo {
    worldPosX: f32, worldPosY: f32, worldPosZ: f32, rotation: f32,
    scaleX: f32, scaleY: f32, scaleZ: f32, distanceToCamera: f32,
    speciesIndex: u32, variantSeed: u32, subBand: u32, subBandBlendBits: u32,
    foliageR: f32, foliageG: f32, foliageB: f32, foliageA: f32,
    anchorStart: u32, anchorCount: u32, templateIndex: u32, impostorCount: u32,
    sourceIndex: u32, _res0: u32, tileTypeId: u32, _res1: u32,
    windPhase: f32, health: f32, age: f32, tierFade: f32,
    _res2: u32, _res3: u32, _res4: u32, _res5: u32,
}

struct TrunkInstance {
    baseX: f32, baseY: f32, baseZ: f32, rotation: f32,
    trunkHeight: f32, trunkRadius: f32, distanceToCamera: f32, tierFade: f32,
    barkR: f32, barkG: f32, barkB: f32, speciesF: f32,
}

@group(0) @binding(0) var<storage, read>       midNearTrees: array<MidNearTreeInfo>;
@group(0) @binding(1) var<storage, read>       midNearTreeCount: array<u32>;
@group(0) @binding(2) var<storage, read_write> trunkInstances: array<TrunkInstance>;

fn getSpeciesBarkColor(speciesIndex: u32) -> vec3<f32> {
    switch (speciesIndex) {
        case 0u: { return vec3<f32>(0.25, 0.18, 0.12); }
        case 1u: { return vec3<f32>(0.40, 0.28, 0.18); }
        // Birch bark kept bright but not glowing at night.
        case 2u: { return vec3<f32>(0.68, 0.66, 0.62); }
        case 3u: { return vec3<f32>(0.35, 0.28, 0.22); }
        case 4u: { return vec3<f32>(0.30, 0.22, 0.15); }
        case 5u: { return vec3<f32>(0.50, 0.48, 0.45); }
        case 6u: { return vec3<f32>(0.45, 0.35, 0.25); }
        case 7u: { return vec3<f32>(0.40, 0.32, 0.22); }
        case 8u: { return vec3<f32>(0.55, 0.48, 0.40); }
        case 9u: { return vec3<f32>(0.20, 0.35, 0.18); }
        default: { return vec3<f32>(0.35, 0.25, 0.18); }
    }
}

@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let treeIdx = gid.x;
    let treeCount = min(midNearTreeCount[0], MAX_MIDNEAR_TREES);
    if (treeIdx >= treeCount) { return; }

    let tree = midNearTrees[treeIdx];
    let bark = getSpeciesBarkColor(tree.speciesIndex);
    let trunkH = tree.scaleY * TRUNK_HEIGHT_FRAC;
    let trunkR = clamp(tree.scaleX * TRUNK_RADIUS_FRAC, TRUNK_RADIUS_MIN, TRUNK_RADIUS_MAX);

    trunkInstances[treeIdx] = TrunkInstance(
        tree.worldPosX, tree.worldPosY, tree.worldPosZ, tree.rotation,
        trunkH, trunkR, tree.distanceToCamera, tree.tierFade,
        bark.r, bark.g, bark.b, f32(tree.speciesIndex)
    );
}
`;
}


export function buildMidNearImpostorScatterShader(config = {}) {
    const WORKGROUP_SIZE = config.workgroupSize ?? 128;
    const MAX_TREES      = config.maxTrees      ?? 7000;
    const MAX_IMPOSTORS  = config.maxImpostors  ?? 60000;
    const SUB_BAND_COUNT = 3;
    
    // Fixed budget estimate for stability (prevents flicker from treeCount jitter)
    const BUDGET_TREE_ESTIMATE = config.budgetTreeEstimate ?? 1500;

    const cfg = config.midNearConfig ?? {};
    const fmt = (v, fb) => Number(Number.isFinite(v) ? v : fb).toFixed(4);
    const arr4 = (a, fb) => {
        const src = Array.isArray(a) ? a : [];
        const out = [];
        for (let i = 0; i < 4; i++) out.push(fmt(src[i], fb));
        return out.join(', ');
    };
    const arr4u = (a, fb) => {
        const src = Array.isArray(a) ? a : [];
        const out = [];
        for (let i = 0; i < 4; i++) out.push(`${(src[i] ?? fb) >>> 0}u`);
        return out.join(', ');
    };

    return /* wgsl */`

const WORKGROUP_SIZE: u32 = ${WORKGROUP_SIZE}u;
const MAX_MIDNEAR_TREES: u32 = ${MAX_TREES}u;
const MAX_IMPOSTORS: u32 = ${MAX_IMPOSTORS}u;
const SUB_BAND_COUNT: u32 = ${SUB_BAND_COUNT}u;
const BUDGET_TREE_ESTIMATE: u32 = ${BUDGET_TREE_ESTIMATE}u;

const ANCHOR_TIERS:       array<u32, 4> = array<u32, 4>(${arr4u(cfg.anchorTiers, 2)});
const ANCHOR_KEEP_FRACS:  array<f32, 4> = array<f32, 4>(${arr4(cfg.anchorKeepFracs, 1.0)});
const IMP_WEIGHT_STARTS:  array<f32, 4> = array<f32, 4>(${arr4(cfg.impWeightStarts, 0.5)});
const IMP_WEIGHT_ENDS:    array<f32, 4> = array<f32, 4>(${arr4(cfg.impWeightEnds, 0.9)});
const IMP_CARD_SCALE_W:   array<f32, 4> = array<f32, 4>(${arr4(cfg.impCardScaleW, 1.0)});
const IMP_CARD_SCALE_H:   array<f32, 4> = array<f32, 4>(${arr4(cfg.impCardScaleH, 1.2)});

const SUB_BAND_STARTS: array<f32, 4> = array<f32, 4>(${arr4(cfg.subBandStarts, 999.0)});
const SUB_BAND_ENDS:   array<f32, 4> = array<f32, 4>(${arr4(cfg.subBandEnds,   999.0)});

const NEAR_HANDOFF_END: f32 = ${fmt(cfg.nearTierHandoffEnd, 82.0)};
const DISABLE_IMPOSTORS: u32 = ${(cfg.disableMidNearImpostors ?? 0) ? 1 : 0}u;
const SPREAD_WORLD_MIN: f32 = 0.24;
const SPREAD_WORLD_MAX: f32 = 2.40;

struct ScatterParams {
    cameraPosition: vec3<f32>,
    _pad0:          f32,
    planetOrigin:   vec3<f32>,
    planetRadius:   f32,
    birchTemplateStart: u32,
    birchTemplateCount: u32,
    _pad1:          u32,
    _pad2:          u32,
}

struct MidNearTreeInfo {
    worldPosX: f32, worldPosY: f32, worldPosZ: f32, rotation: f32,
    scaleX: f32, scaleY: f32, scaleZ: f32, distanceToCamera: f32,
    speciesIndex: u32, variantSeed: u32, subBand: u32, subBandBlendBits: u32,
    foliageR: f32, foliageG: f32, foliageB: f32, foliageA: f32,
    anchorStart: u32, anchorCount: u32, templateIndex: u32, impostorCount: u32,
    sourceIndex: u32, _res0: u32, tileTypeId: u32, _res1: u32,
    windPhase: f32, health: f32, age: f32, tierFade: f32,
    _res2: u32, _res3: u32, _res4: u32, _res5: u32,
}

struct AnchorInstance {
    posX: f32, posY: f32, posZ: f32, rotation: f32,
    sizeA: f32, sizeB: f32, upX: f32, upY: f32,
    upZ: f32, subBand: u32, weightBits: u32, hangBits: u32,
    colorR: f32, colorG: f32, colorB: f32, anchorSeedBits: u32,
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

struct FamilyDescriptor {
    posX: f32, posY: f32, posZ: f32, spread: f32,
    dirX: f32, dirY: f32, dirZ: f32, tipDepth: f32,
    childCount: u32, seed: u32, _pad0: u32, _pad1: u32,
}

struct SubBandMeta {
    baseOffset: u32,
    capacity:   u32,
    _pad0: u32,
    _pad1: u32,
}

@group(0) @binding(0) var<uniform>             params: ScatterParams;
@group(0) @binding(1) var<storage, read_write> midNearTrees: array<MidNearTreeInfo>;
@group(0) @binding(2) var<storage, read>       midNearTreeCount: array<u32>;
@group(0) @binding(3) var<storage, read_write> impostorInstances: array<AnchorInstance>;
@group(0) @binding(4) var<storage, read_write> impostorCounters:  array<atomic<u32>, SUB_BAND_COUNT>;
@group(0) @binding(5) var<uniform>             impostorMeta:      array<SubBandMeta, SUB_BAND_COUNT>;
@group(0) @binding(6) var<storage, read>       anchors:       array<AnchorPoint>;
@group(0) @binding(7) var<storage, read>       templateInfos: array<TemplateInfo>;
@group(0) @binding(8) var<storage, read>       families:      array<FamilyDescriptor>;

fn pcg(v: u32) -> u32 {
    var s = v * 747796405u + 2891336453u;
    let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
    return (w >> 22u) ^ w;
}
fn pcgF(v: u32) -> f32 { return f32(pcg(v)) / 4294967296.0; }
fn pcg2(a: u32, b: u32) -> u32 { return pcg(a ^ (b * 1664525u + 1013904223u)); }
fn pcg3(a: u32, b: u32, c: u32) -> u32 { return pcg(pcg2(a, b) ^ (c * 2654435761u)); }

@compute @workgroup_size(WORKGROUP_SIZE)
fn main(
    @builtin(workgroup_id) wgId: vec3<u32>,
    @builtin(local_invocation_index) localIdx: u32
) {
    let treeIdx = wgId.x;
    let treeCount = min(midNearTreeCount[0], MAX_MIDNEAR_TREES);
    if (treeIdx >= treeCount) { return; }

    let tree = midNearTrees[treeIdx];

    if (params.birchTemplateStart == 0xFFFFFFFFu || params.birchTemplateCount == 0u) {
        return;
    }
    let variantLocal = pcg(tree.variantSeed) % params.birchTemplateCount;
    let templateIndex = params.birchTemplateStart + variantLocal;
    let info = templateInfos[templateIndex];

    let subBand = tree.subBand;
    let subBandBlend = bitcast<f32>(tree.subBandBlendBits);
    let tierFade = tree.tierFade;
    let dist = tree.distanceToCamera;

    // Hull anchor tier: medium first (stable silhouette), then coarse fallback.
    var hullTierStart: u32; var hullTierCount: u32;
    if (info.mediumCount > 0u) {
        hullTierStart = info.mediumStart; hullTierCount = info.mediumCount;
    } else if (info.coarseCount > 0u) {
        hullTierStart = info.coarseStart; hullTierCount = info.coarseCount;
    } else {
        hullTierStart = 0u; hullTierCount = info.anchorCount;
    }

    // Thread 0: write back anchor info so hull VS can find anchors.
    if (localIdx == 0u) {
        midNearTrees[treeIdx].anchorStart = info.anchorStart + hullTierStart;
        midNearTrees[treeIdx].anchorCount = hullTierCount;
        midNearTrees[treeIdx].templateIndex = templateIndex;
    }

    if (DISABLE_IMPOSTORS > 0u) { return; }

    let familyCount = info.familyCount;
    if (familyCount == 0u) { return; }

    // ═══════════════════════════════════════════════════════════════════════
    // Stable quota math:
    // - fixed tree estimate keeps quotas frame-stable (no treeCount jitter)
    // - conservative strand estimate + safety headroom keeps atomic overflow
    //   low even with denser multi-strand impostors
    // ═══════════════════════════════════════════════════════════════════════
    let budgetDen = max(1024u, BUDGET_TREE_ESTIMATE);
    let perTreeBudget = max(8u, (MAX_IMPOSTORS * 84u) / max(1u, budgetDen * 100u));
    var meanStrands = 6u;
    if (subBand == 0u) {
        meanStrands = 7u;
    } else if (subBand == 2u) {
        meanStrands = 5u;
    }
    let familyCap = min(familyCount, max(2u, perTreeBudget / meanStrands));

    // ═══════════════════════════════════════════════════════════════════════
    // FIX 2: Stratified family selection
    // Previously: threads 0..familyCap processed families 0..familyCap
    // This biased toward lower canopy (families generated bottom-to-top).
    // 
    // Now: threads are spread evenly across the full family range.
    // Thread i processes family floor(i * familyCount / familiesToProcess)
    // This ensures upper canopy families get representation.
    // ═══════════════════════════════════════════════════════════════════════
    let familiesToProcess = min(familyCount, familyCap);
    if (localIdx >= familiesToProcess) { return; }

    // Stratified mapping: spread thread indices evenly across family index range
    let familyLocal = (localIdx * familyCount) / familiesToProcess;
    
    let family = families[info.familyStart + familyLocal];
    let familySeed = pcg3(tree.variantSeed, family.seed ^ familyLocal, 0x7E1D00F5u);

    // Handoff zone marker
    let inHandoffZone = dist < NEAR_HANDOFF_END;
    let fadeMul = 1.0;

    var emitBand = subBand;
    if (subBandBlend > 0.0 && subBand < 2u) {
        if (pcgF(familySeed ^ 0xC0055u) < subBandBlend) {
            emitBand = subBand + 1u;
        }
    }

    var keepFrac = ANCHOR_KEEP_FRACS[emitBand];
    if (emitBand <= 1u) {
        let handoffStart = SUB_BAND_STARTS[0];
        let handoffSpan = max(1.0, NEAR_HANDOFF_END - handoffStart);
        let overlapT = clamp((dist - handoffStart) / handoffSpan, 0.0, 1.0);
        var handoffKeep = mix(0.96, 1.00, overlapT);
        if (!inHandoffZone) { handoffKeep = 1.00; }
        keepFrac = max(keepFrac, handoffKeep);
    }
    let rearEnd = SUB_BAND_ENDS[2];
    let rearSpan = max(1.0, rearEnd - NEAR_HANDOFF_END);
    let rearT = clamp((dist - NEAR_HANDOFF_END) / rearSpan, 0.0, 1.0);
    let rearScale = mix(1.0, select(0.82, 0.94, emitBand <= 1u), rearT);
    keepFrac = keepFrac * rearScale;
    let densityMul = clamp(keepFrac * fadeMul, 0.0, 1.0);
    if (densityMul <= 0.001) { return; }

    // World-space anchor position
    let treePos = vec3<f32>(tree.worldPosX, tree.worldPosY, tree.worldPosZ);
    let sphereDir = normalize(treePos - params.planetOrigin);
    var refDir = vec3<f32>(0.0, 1.0, 0.0);
    if (abs(dot(sphereDir, refDir)) > 0.99) { refDir = vec3<f32>(1.0, 0.0, 0.0); }
    let tangent   = normalize(cross(sphereDir, refDir));
    let bitangent = normalize(cross(sphereDir, tangent));
    let cosR = cos(tree.rotation);
    let sinR = sin(tree.rotation);
    let rotT =  tangent * cosR + bitangent * sinR;
    let rotB = -tangent * sinR + bitangent * cosR;

    let srcPos = vec3<f32>(family.posX, family.posY, family.posZ);
    let scaledAnchor = vec3<f32>(
        srcPos.x * tree.scaleX,
        srcPos.y * tree.scaleY,
        srcPos.z * tree.scaleZ
    );
    var worldAnchor = treePos
                    + rotT      * scaledAnchor.x
                    + sphereDir * scaledAnchor.y
                    + rotB      * scaledAnchor.z;
    var localDir = vec3<f32>(family.dirX, family.dirY, family.dirZ);
    if (length(localDir) < 1e-4) {
        localDir = vec3<f32>(0.0, -1.0, 0.0);
    }
    localDir = normalize(localDir);
    let worldDirRaw = normalize(
        rotT      * localDir.x +
        sphereDir * localDir.y +
        rotB      * localDir.z
    );
    let familyChildren = max(1u, family.childCount);
    let hangByDir = clamp((-localDir.y + 0.10) / 1.10, 0.0, 1.0);
    let hangByFamily = clamp(0.56 + f32(min(8u, familyChildren)) * 0.05, 0.0, 0.98);
    var hang = max(hangByDir, hangByFamily);
    let gravityDown = -sphereDir;
    var dropAlign = clamp(0.62 + hang * 0.34, 0.0, 1.0);
    dropAlign = max(dropAlign, 0.90);
    let droopDir = normalize(mix(worldDirRaw, gravityDown, dropAlign));
    let worldUp = droopDir;

    let radialScale = max(0.001, (tree.scaleX + tree.scaleZ) * 0.5);
    let familySpreadBoost = clamp(1.0 + f32(max(0u, familyChildren - 1u)) * 0.05, 1.0, 1.45);
    let spreadRaw = family.spread * radialScale * familySpreadBoost;
    let spreadWorld = clamp(spreadRaw, SPREAD_WORLD_MIN, SPREAD_WORLD_MAX);
    let sizeJitter = 0.92 + pcgF(familySeed ^ 0x515E00u) * 0.16;
    let spreadFinal = spreadWorld * sizeJitter;
    let tipWorld = clamp(family.tipDepth * tree.scaleY, 0.12, 2.80);

    let sbStart = SUB_BAND_STARTS[emitBand];
    let sbEnd   = SUB_BAND_ENDS[emitBand];
    let sbT = clamp((dist - sbStart) / max(1.0, sbEnd - sbStart), 0.0, 1.0);
    let impostorW = mix(IMP_WEIGHT_STARTS[emitBand], IMP_WEIGHT_ENDS[emitBand], sbT);

    let cVar = (pcgF(familySeed ^ 0xC01000u) - 0.5) * 0.10;
    let shadeVar = 0.88 + pcgF(familySeed ^ 0xC01337u) * 0.16;
    let childDensity = clamp(f32(min(8u, familyChildren)) / 8.0, 0.0, 1.0);
    let densityShade = mix(1.02, 0.82, childDensity);
    let greenBias = mix(0.84, 0.97, pcgF(familySeed ^ 0xC0FFEEu));
    var foliage = vec3<f32>(tree.foliageR, tree.foliageG, tree.foliageB);
    foliage = foliage * vec3<f32>(0.96, 0.88, 0.94) * shadeVar * densityShade;
    foliage = foliage + vec3<f32>(cVar * 0.60, cVar * 0.25, cVar * 0.35);
    foliage = vec3<f32>(foliage.x, foliage.y * greenBias, foliage.z);
    foliage = clamp(foliage, vec3<f32>(0.0), vec3<f32>(1.0));

    let hangStretch = mix(1.00, 1.22, hang);
    let hangNarrow = mix(1.02, 0.86, hang);
    var baseCardW = spreadFinal * IMP_CARD_SCALE_W[emitBand] * hangNarrow;
    var baseCardH = spreadFinal * IMP_CARD_SCALE_H[emitBand] * hangStretch;
    baseCardH = max(baseCardH, tipWorld * 0.72);
    baseCardH = min(baseCardH, tipWorld * 1.26);
    let droopMask = smoothstep(0.18, 0.70, hang);
    baseCardH = baseCardH * mix(1.02, 1.16, droopMask);
    baseCardW = baseCardW * mix(0.94, 1.02, droopMask);

    let toCam = normalize(params.cameraPosition - worldAnchor);
    var latAxis = cross(droopDir, toCam);
    if (length(latAxis) < 1e-4) { latAxis = cross(droopDir, rotT); }
    if (length(latAxis) < 1e-4) { latAxis = cross(droopDir, rotB); }
    if (length(latAxis) < 1e-4) { latAxis = tangent; }
    latAxis = normalize(latAxis);

    let tipWorldForStrand = max(tipWorld, baseCardH * 0.72);
    let alongBase = min(spreadFinal * 0.08, tipWorldForStrand * 0.20);
    worldAnchor = worldAnchor + droopDir * alongBase;

    var strandCount = clamp(2u + familyChildren / 2u, 3u, 10u);
    if (emitBand == 0u) {
        strandCount = min(12u, strandCount + 2u);
    } else if (emitBand == 1u) {
        strandCount = min(9u, strandCount);
    } else {
        strandCount = max(2u, strandCount - 1u);
    }

    let metab = impostorMeta[emitBand];
    for (var seg = 0u; seg < strandCount; seg++) {
        let segT = select(0.0, f32(seg) / max(1.0, f32(strandCount - 1u)), strandCount > 1u);
        let segSeed = pcg3(familySeed, seg, 0xD02A5EEDu);
        let segJ = pcgF(segSeed);

        let segAlong = segT * min(tipWorldForStrand * 0.90, baseCardH * 0.95);
        let sideJitter = (segJ - 0.5) * baseCardW * mix(0.040, 0.016, segT);
        let segPos = worldAnchor + droopDir * segAlong + latAxis * sideJitter;

        let tuft = exp(-pow((segT - 0.40) / 0.30, 2.0));
        let segW = baseCardW * mix(1.00, 0.72, segT) * (0.96 + tuft * 0.20);
        let segH = baseCardH * mix(1.04, 0.80, segT) * (0.98 + tuft * 0.14);
        let segHang = clamp(hang * mix(1.0, 1.06, segT), 0.0, 1.0);
        let handoffFill = select(1.0, 1.06, inHandoffZone);
        let segWeight = impostorW * mix(0.88, 1.00, droopMask) * mix(1.0, 0.96, segT) * handoffFill * densityMul;
        let segRot = tree.rotation +
            (pcgF(segSeed ^ 0x93A1u) - 0.5) * (0.07 + 0.10 * (1.0 - hang)) +
            (segT - 0.5) * 0.05;

        let idx = atomicAdd(&impostorCounters[emitBand], 1u);
        if (idx < metab.capacity) {
            impostorInstances[metab.baseOffset + idx] = AnchorInstance(
                segPos.x, segPos.y, segPos.z, segRot,
                segW, segH, worldUp.x, worldUp.y,
                worldUp.z, emitBand, bitcast<u32>(segWeight), bitcast<u32>(segHang),
                foliage.r, foliage.g, foliage.b, familySeed
            );
        }
    }
}
`;
}

// ═════════════════════════════════════════════════════════════════════════
// Indirect-args builder
// ═════════════════════════════════════════════════════════════════════════

export function buildMidNearIndirectShader(config = {}) {
    const SUB_BAND_COUNT = 3;
    const hullIndexCount  = config.hullIndexCount  ?? 0;
    const trunkIndexCount = config.trunkIndexCount ?? 0;
    const MAX_TREES = config.maxTrees ?? 7000;

    const impRanges = config.impostorShapeRanges ?? [
        { firstIndex: 0, indexCount: 18 },
        { firstIndex: 18, indexCount: 12 },
        { firstIndex: 30, indexCount: 6 },
    ];
    const impShapes = config.impostorShapes ?? [0, 1, 2];
    const impFirst = [0,0,0].map((_, i) => impRanges[impShapes[i] ?? 2]?.firstIndex  ?? 0);
    const impCount = [0,0,0].map((_, i) => impRanges[impShapes[i] ?? 2]?.indexCount ?? 6);

    return /* wgsl */`

const SUB_BAND_COUNT: u32 = ${SUB_BAND_COUNT}u;
const HULL_INDEX_COUNT:  u32 = ${hullIndexCount}u;
const TRUNK_INDEX_COUNT: u32 = ${trunkIndexCount}u;
const MAX_TREES: u32 = ${MAX_TREES}u;

const IMP_FIRST_INDEX: array<u32, 3> = array<u32, 3>(${impFirst.map(v=>`${v}u`).join(', ')});
const IMP_INDEX_COUNT: array<u32, 3> = array<u32, 3>(${impCount.map(v=>`${v}u`).join(', ')});

struct SubBandMeta {
    baseOffset: u32, capacity: u32, _pad0: u32, _pad1: u32,
}

@group(0) @binding(0) var<storage, read>       impostorCounters: array<u32, SUB_BAND_COUNT>;
@group(0) @binding(1) var<uniform>             impostorMeta:     array<SubBandMeta, SUB_BAND_COUNT>;
@group(0) @binding(2) var<storage, read_write> impostorIndirect: array<u32>;
@group(0) @binding(3) var<storage, read>       treeCount:        array<u32>;
@group(0) @binding(4) var<storage, read_write> trunkIndirect:    array<u32>;
@group(0) @binding(5) var<storage, read_write> hullIndirect:     array<u32>;

@compute @workgroup_size(1)
fn main() {
    let tc = min(treeCount[0], MAX_TREES);

    // Impostor draws (per sub-band)
    for (var sb = 0u; sb < SUB_BAND_COUNT; sb++) {
        let iCount = min(impostorCounters[sb], impostorMeta[sb].capacity);
        let iBase  = sb * 5u;
        impostorIndirect[iBase + 0u] = IMP_INDEX_COUNT[sb];
        impostorIndirect[iBase + 1u] = iCount;
        impostorIndirect[iBase + 2u] = IMP_FIRST_INDEX[sb];
        impostorIndirect[iBase + 3u] = 0u;
        impostorIndirect[iBase + 4u] = impostorMeta[sb].baseOffset;
    }

    // Trunk: one draw, instanceCount = treeCount
    trunkIndirect[0] = TRUNK_INDEX_COUNT;
    trunkIndirect[1] = tc;
    trunkIndirect[2] = 0u;
    trunkIndirect[3] = 0u;
    trunkIndirect[4] = 0u;

    // Hull: one draw, instanceCount = treeCount
    hullIndirect[0] = HULL_INDEX_COUNT;
    hullIndirect[1] = tc;
    hullIndirect[2] = 0u;
    hullIndirect[3] = 0u;
    hullIndirect[4] = 0u;
}
`;
}
