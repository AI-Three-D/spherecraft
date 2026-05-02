export function buildLeafBudgetPrepassShader(config = {}) {
    const fmtF = (v, fallback) => {
        const n = Number(v);
        const f = Number.isFinite(n) ? n : fallback;
        return f.toFixed(3);
    };

    const MAX_CLOSE_TREES = config.maxCloseTrees ?? 512;
    const L0_LEAVES  = config.l0Leaves       ?? 6000;
    const L1_LEAVES  = config.l1Leaves       ?? 3000;
    const L2_LEAVES  = config.l2Leaves       ?? 1500;
    const SPRUCE_L0  = config.spruceL0Leaves ?? 3000;
    const SPRUCE_L1  = config.spruceL1Leaves ?? 1500;
    const SPRUCE_L2  = config.spruceL2Leaves ?? 700;

    const B_NEAR_DISTANCE = config.birchNearDistance ?? 20.0;
    const B_FADE_DISTANCE = config.birchFadeDistance ?? 80.0;
    const B_CLOSE_LEAVES  = config.birchCloseLeaves  ?? config.birchNearLeaves ?? 4000;
    const B_CLOSE_CARDS   = config.birchCloseCards   ?? 10;
    const B_SETTLED_CARDS = config.birchSettledCards ?? config.birchL0Cards ?? 1;
    const B_L0_SETTLED_LEAVES = config.birchL0SettledLeaves ?? 1200;
    const B_L1_CARDS = config.birchL1Cards ?? 4;
    const B_L2_CARDS = config.birchL2Cards ?? 2;
    const B_L3_CARDS = config.birchL3Cards ?? 2;

    return /* wgsl */`
const MAX_CLOSE_TREES: u32 = ${MAX_CLOSE_TREES}u;

const L0_LEAVES: u32 = ${L0_LEAVES}u;
const L1_LEAVES: u32 = ${L1_LEAVES}u;
const L2_LEAVES: u32 = ${L2_LEAVES}u;
const SPRUCE_L0: u32 = ${SPRUCE_L0}u;
const SPRUCE_L1: u32 = ${SPRUCE_L1}u;
const SPRUCE_L2: u32 = ${SPRUCE_L2}u;

const BIRCH_NEAR_DISTANCE: f32 = ${fmtF(B_NEAR_DISTANCE, 20.0)};
const BIRCH_FADE_DISTANCE: f32 = ${fmtF(B_FADE_DISTANCE, 80.0)};
const BIRCH_CLOSE_LEAVES:  f32 = ${fmtF(B_CLOSE_LEAVES, 4000.0)};
const BIRCH_CLOSE_CARDS:   f32 = ${fmtF(B_CLOSE_CARDS, 10.0)};
const BIRCH_SETTLED_CARDS: u32 = ${B_SETTLED_CARDS}u;
const BIRCH_L0_SETTLED_LEAVES: u32 = ${B_L0_SETTLED_LEAVES}u;
const BIRCH_L1_CARDS: u32 = ${B_L1_CARDS}u;
const BIRCH_L2_CARDS: u32 = ${B_L2_CARDS}u;
const BIRCH_L3_CARDS: u32 = ${B_L3_CARDS}u;

struct LeafParams {
    cameraPosition: vec3<f32>, time: f32,
    planetOrigin: vec3<f32>,   planetRadius: f32,
    leafMinSize: f32, leafMaxSize: f32, windStrength: f32,
    birchTemplateStart: u32, birchTemplateCount: u32,
    spruceTemplateStart: u32, spruceTemplateCount: u32,
    _pad0: u32,
}

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

struct TemplateInfo {
    anchorStart: u32, anchorCount: u32,
    fineStart: u32, fineCount: u32,
    mediumStart: u32, mediumCount: u32,
    coarseStart: u32, coarseCount: u32,
    _pad0: u32, _pad1: u32, _pad2: u32, _pad3: u32,
}

@group(0) @binding(0) var<uniform>             params: LeafParams;
@group(0) @binding(1) var<storage, read>       closeTrees: array<CloseTreeInfo>;
@group(0) @binding(2) var<storage, read>       closeTreeCount: array<u32>;
@group(0) @binding(3) var<storage, read_write> leafRequestSummary: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read>       templateInfos: array<TemplateInfo>;

fn pcg(v: u32) -> u32 {
    var s = v * 747796405u + 2891336453u;
    let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
    return (w >> 22u) ^ w;
}

fn birchCountForBand(info: TemplateInfo, band: u32) -> u32 {
    let fine = select(info.anchorCount, info.fineCount, info.fineCount > 0u);
    let medium = select(fine, info.mediumCount, info.mediumCount > 0u);
    let coarse = select(medium, info.coarseCount, info.coarseCount > 0u);
    if (band == 0u) { return fine; }
    if (band <= 2u) { return medium; }
    return coarse;
}

fn birchCardsForBand(band: u32) -> u32 {
    if (band == 0u) { return 1u; }
    if (band == 1u) { return max(1u, BIRCH_L1_CARDS); }
    if (band == 2u) { return max(1u, BIRCH_L2_CARDS); }
    return max(1u, BIRCH_L3_CARDS);
}

fn birchTargetForBand(info: TemplateInfo, band: u32, dist: f32) -> u32 {
    let anchorCount = max(1u, birchCountForBand(info, band));
    if (band == 0u) {
        let settled = min(anchorCount, max(1u, BIRCH_L0_SETTLED_LEAVES));
        let nearT = smoothstep(0.0, BIRCH_NEAR_DISTANCE, dist);
        return max(1u, u32(round(mix(BIRCH_CLOSE_LEAVES, f32(settled), nearT))));
    }
    return max(1u, anchorCount * birchCardsForBand(band));
}

fn computeTargetLeaves(tree: CloseTreeInfo) -> u32 {
    let B = tree.detailLevel;
    let isSpruce  = (tree.speciesIndex == 0u) || (tree.speciesIndex == 1u);
    let isBirch   = (tree.speciesIndex == 2u);
    let isSaguaro = (tree.speciesIndex == 9u);

    var targetLeaves: u32 = 0u;

    if (isBirch && B <= 3u
        && params.birchTemplateStart != 0xFFFFFFFFu
        && params.birchTemplateCount > 0u) {

        let variantLocal = pcg(tree.variantSeed) % params.birchTemplateCount;
        let info = templateInfos[params.birchTemplateStart + variantLocal];

        if (info.anchorCount > 0u) {
            let band = min(B, 3u);
            let nextBand = min(band + 1u, 3u);
            let currentTarget = birchTargetForBand(info, band, tree.distanceToCamera);
            let nextTarget = birchTargetForBand(info, nextBand, tree.distanceToCamera);
            let desired = mix(f32(currentTarget), f32(nextTarget), tree.bandBlend) * tree.health;
            targetLeaves = u32(clamp(round(desired), 0.0, 4294967295.0));
        }

    } else if (isSpruce && B <= 2u
               && params.spruceTemplateStart != 0xFFFFFFFFu
               && params.spruceTemplateCount > 0u) {
        let variantLocal = pcg(tree.variantSeed) % params.spruceTemplateCount;
        let info = templateInfos[params.spruceTemplateStart + variantLocal];
        if (info.anchorCount > 0u) {
            var spruceCardsPerAnchor: u32 = 1u;
            if (B == 0u) { spruceCardsPerAnchor = 3u; targetLeaves = SPRUCE_L0; }
            else if (B == 1u) { spruceCardsPerAnchor = 2u; targetLeaves = SPRUCE_L1; }
            else { spruceCardsPerAnchor = 1u; targetLeaves = SPRUCE_L2; }

            targetLeaves = u32(f32(targetLeaves) * tree.health);
            let cpg = max(spruceCardsPerAnchor, 1u);
            targetLeaves = (targetLeaves / cpg) * cpg;
        }

    } else if (!isSaguaro && B <= 2u) {
        switch (B) {
            case 0u: { targetLeaves = L0_LEAVES; }
            case 1u: { targetLeaves = L1_LEAVES; }
            default: { targetLeaves = L2_LEAVES; }
        }
        targetLeaves = u32(f32(targetLeaves) * tree.health);
    }

    return targetLeaves;
}

@compute @workgroup_size(1)
fn main(@builtin(workgroup_id) wgId: vec3<u32>) {
    let treeIdx = wgId.x;
    let treeCount = min(closeTreeCount[0], MAX_CLOSE_TREES);
    if (treeIdx >= treeCount) { return; }

    if (treeIdx == 0u) {
        atomicStore(&leafRequestSummary[3], treeCount);
    }

    let targetLeaves = computeTargetLeaves(closeTrees[treeIdx]);
    if (targetLeaves == 0u) { return; }

    atomicAdd(&leafRequestSummary[0], targetLeaves);
    atomicAdd(&leafRequestSummary[1], 1u);
    atomicMax(&leafRequestSummary[2], targetLeaves);
    atomicAdd(&leafRequestSummary[4u + min(closeTrees[treeIdx].detailLevel, 3u)], targetLeaves);
}
`;
}
