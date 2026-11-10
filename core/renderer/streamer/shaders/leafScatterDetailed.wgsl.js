// js/renderer/streamer/shaders/leafScatterDetailed.wgsl.js
//
// Current config path:
//   runtimeConfigs -> treeConfigResolver -> AssetStreamer -> TreeLODController
//   -> LeafStreamer -> this shader builder.
//
// The authoritative near-tier birch config is the compact runtime shape:
//   birch: {
//     nearDistance, closeLeaves,
//     closeCardsPerAnchor, settledCardsPerAnchor,
//     closeW/H, settledW/H
//   }
//
// Keep compatibility fallbacks for older call sites that still pass the
// previous birchL0/birchNear/birchMid field names.

export function buildLeafScatterDetailedShader(config = {}) {
    const fmtF = (v, fallback) => {
        const n = Number(v);
        const f = Number.isFinite(n) ? n : fallback;
        return f.toFixed(3);
    };

    const WORKGROUP_SIZE  = config.workgroupSize  ?? 256;
    const MAX_CLOSE_TREES = config.maxCloseTrees  ?? 512;
    const MAX_LEAVES      = config.maxLeaves      ?? 600000;

    const L0_LEAVES  = config.l0Leaves       ?? 6000;
    const L1_LEAVES  = config.l1Leaves       ?? 3000;
    const L2_LEAVES  = config.l2Leaves       ?? 1500;
    const SPRUCE_L0  = config.spruceL0Leaves ?? 3000;
    const SPRUCE_L1  = config.spruceL1Leaves ?? 1500;
    const SPRUCE_L2  = config.spruceL2Leaves ?? 700;
    const budgetFractions = Array.isArray(config.leafBandBudgetFractions)
        ? config.leafBandBudgetFractions
        : [0.42, 0.30, 0.18, 0.10];
    const budgetSum = budgetFractions.reduce((sum, v) => {
        const n = Number(v);
        return sum + (Number.isFinite(n) && n > 0 ? n : 0);
    }, 0) || 1;
    const leafBandBudgets = [0, 1, 2, 3].map(i => {
        const n = Number(budgetFractions[i]);
        const frac = Number.isFinite(n) && n > 0 ? n / budgetSum : 0;
        return Math.max(1, Math.floor(MAX_LEAVES * frac));
    });

    const B_NEAR_DISTANCE = config.birchNearDistance ?? 20.0;
    const B_FADE_DISTANCE = config.birchFadeDistance ?? 80.0;
    const B_CLOSE_LEAVES  = config.birchCloseLeaves  ?? config.birchNearLeaves ?? 4000;
    const B_CLOSE_CARDS   = config.birchCloseCards   ?? 10;
    const B_SETTLED_CARDS = config.birchSettledCards ?? config.birchL0Cards ?? 1;
    const B_L0_SETTLED_LEAVES = config.birchL0SettledLeaves ?? 1200;
    const B_L1_CARDS = config.birchL1Cards ?? 4;
    const B_L2_CARDS = config.birchL2Cards ?? 2;
    const B_L3_CARDS = config.birchL3Cards ?? 2;
    const B_CLOSE_W       = config.birchCloseW       ?? config.birchNearW ?? 0.36;
    const B_CLOSE_H       = config.birchCloseH       ?? config.birchNearH ?? 0.54;
    const B_SETTLED_W     = config.birchSettledW     ?? config.birchMidW ?? 0.55;
    const B_SETTLED_H     = config.birchSettledH     ?? config.birchMidH ?? 0.825;

    return /* wgsl */`

const WORKGROUP_SIZE: u32  = ${WORKGROUP_SIZE}u;
const MAX_CLOSE_TREES: u32 = ${MAX_CLOSE_TREES}u;
const MAX_LEAVES: u32      = ${MAX_LEAVES}u;

const L0_LEAVES: u32 = ${L0_LEAVES}u;
const L1_LEAVES: u32 = ${L1_LEAVES}u;
const L2_LEAVES: u32 = ${L2_LEAVES}u;
const SPRUCE_L0: u32 = ${SPRUCE_L0}u;
const SPRUCE_L1: u32 = ${SPRUCE_L1}u;
const SPRUCE_L2: u32 = ${SPRUCE_L2}u;
const LEAF_BAND_BUDGETS: array<u32, 4> = array<u32, 4>(
    ${leafBandBudgets[0]}u, ${leafBandBudgets[1]}u, ${leafBandBudgets[2]}u, ${leafBandBudgets[3]}u
);

const BIRCH_NEAR_DISTANCE: f32 = ${fmtF(B_NEAR_DISTANCE, 20.0)};
const BIRCH_FADE_DISTANCE: f32 = ${fmtF(B_FADE_DISTANCE, 80.0)};
const BIRCH_CLOSE_LEAVES:  f32 = ${fmtF(B_CLOSE_LEAVES, 4000.0)};
const BIRCH_CLOSE_CARDS:   f32 = ${fmtF(B_CLOSE_CARDS, 10.0)};
const BIRCH_SETTLED_CARDS: u32 = ${B_SETTLED_CARDS}u;
const BIRCH_L0_SETTLED_LEAVES: u32 = ${B_L0_SETTLED_LEAVES}u;
const BIRCH_L1_CARDS: u32 = ${B_L1_CARDS}u;
const BIRCH_L2_CARDS: u32 = ${B_L2_CARDS}u;
const BIRCH_L3_CARDS: u32 = ${B_L3_CARDS}u;
const BIRCH_CLOSE_W:       f32 = ${fmtF(B_CLOSE_W, 0.36)};
const BIRCH_CLOSE_H:       f32 = ${fmtF(B_CLOSE_H, 0.54)};
const BIRCH_SETTLED_W:     f32 = ${fmtF(B_SETTLED_W, 0.55)};
const BIRCH_SETTLED_H:     f32 = ${fmtF(B_SETTLED_H, 0.825)};

// ── Structs ──────────────────────────────────────────────────────────────

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

struct LeafInstance {
    posX: f32, posY: f32, posZ: f32, rotation: f32,
    width: f32, height: f32,
    tileTypeId: u32, flags: u32,
    colorR: f32, colorG: f32, colorB: f32, colorA: f32,
    twigDirX: f32, twigDirY: f32, twigDirZ: f32, clusterVariant: f32,
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
    _pad0: u32, _pad1: u32, _pad2: u32, _pad3: u32,
}

// ── Bindings ─────────────────────────────────────────────────────────────

@group(0) @binding(0) var<uniform>             params: LeafParams;
@group(0) @binding(1) var<storage, read_write> closeTrees: array<CloseTreeInfo>;
@group(0) @binding(2) var<storage, read>       closeTreeCount: array<u32>;
@group(0) @binding(3) var<storage, read_write> leafInstances: array<LeafInstance>;
@group(0) @binding(4) var<storage, read_write> leafCounter: array<atomic<u32>>;

@group(0) @binding(5) var<storage, read>       anchors: array<AnchorPoint>;
@group(0) @binding(6) var<storage, read>       templateInfos: array<TemplateInfo>;
@group(0) @binding(7) var<storage, read>       leafRequestSummary: array<u32>;


// ── PCG ──────────────────────────────────────────────────────────────────

fn pcg(v: u32) -> u32 {
    var s = v * 747796405u + 2891336453u;
    let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
    return (w >> 22u) ^ w;
}
fn pcgF(v: u32) -> f32 { return f32(pcg(v)) / 4294967296.0; }
fn pcg2(a: u32, b: u32) -> u32 { return pcg(a ^ (b * 1664525u + 1013904223u)); }
fn pcg3(a: u32, b: u32, c: u32) -> u32 { return pcg(pcg2(a, b) ^ (c * 2654435761u)); }

fn safePerp(dir: vec3<f32>) -> vec3<f32> {
    var up = vec3<f32>(0.0, 1.0, 0.0);
    if (abs(dot(dir, up)) > 0.95) { up = vec3<f32>(1.0, 0.0, 0.0); }
    return normalize(cross(up, dir));
}

// ── Spruce anchor sampling (legacy, unchanged) ───────────────────────────

struct AnchorSample { pos: vec3<f32>, dir: vec3<f32>, spread: f32 }

fn sampleSpruceAnchor(templateIndex: u32, seed: u32, sequence: u32) -> AnchorSample {
    let info = templateInfos[templateIndex];
    if (info.anchorCount == 0u) {
        return AnchorSample(vec3<f32>(0.0, 0.5, 0.0), vec3<f32>(0.0, 1.0, 0.0), 0.05);
    }
    let poolStart = info.anchorStart;
    let poolCount = info.anchorCount;
    let base = pcg(seed ^ 0x3C6EF372u);
    let step = (pcg(seed ^ 0x85EBCA6Bu) | 1u);
    let pick = (base + sequence * step) % poolCount;
    let anchor = anchors[poolStart + pick];
    let anchorPos = vec3<f32>(anchor.posX, anchor.posY, anchor.posZ);
    let dir = normalize(vec3<f32>(anchor.dirX, anchor.dirY, anchor.dirZ));

    let s1 = pcg3(seed, sequence, 0xCF1BBCDDu);
    let s2 = pcg(s1); let s3 = pcg(s2);
    let tangentV = safePerp(dir);
    let bitangentV = normalize(cross(dir, tangentV));
    let alongJitter = (pcgF(s1) - 0.5) * anchor.spread * 0.8;
    let sideJitter  = (pcgF(s2) - 0.5) * anchor.spread * 0.5;
    let upJitter    = (pcgF(s3) - 0.5) * anchor.spread * 0.25;
    let jitterPos = anchorPos + dir * alongJitter + tangentV * sideJitter + bitangentV * upJitter;
    return AnchorSample(jitterPos, dir, anchor.spread);
}

// ── Generic canopy (legacy, unchanged) ───────────────────────────────────

fn getCanopyParams(speciesIndex: u32) -> vec4<f32> {
    switch (speciesIndex) {
        case 0u: { return vec4<f32>(0.15, 1.0, 0.35, 1.0); }
        case 1u: { return vec4<f32>(0.25, 1.0, 0.30, 1.0); }
        case 2u: { return vec4<f32>(0.35, 1.0, 0.30, 0.0); }
        case 3u: { return vec4<f32>(0.30, 0.95, 0.35, 0.0); }
        case 4u: { return vec4<f32>(0.25, 1.0, 0.50, 0.0); }
        case 5u: { return vec4<f32>(0.30, 1.0, 0.45, 0.0); }
        case 6u: { return vec4<f32>(0.85, 1.0, 0.35, 2.0); }
        case 7u: { return vec4<f32>(0.35, 1.0, 0.40, 0.0); }
        case 8u: { return vec4<f32>(0.45, 1.0, 0.50, 0.0); }
        case 9u: { return vec4<f32>(0.0, 0.0, 0.0, 3.0); }
        default: { return vec4<f32>(0.30, 1.0, 0.40, 0.0); }
    }
}

fn generateLeafPosition(treeSeed: u32, leafIndex: u32, cp: vec4<f32>, th: f32, tw: f32) -> vec3<f32> {
    let leafSeed = pcg3(treeSeed, leafIndex, 0x12345678u);
    let s1 = pcg(leafSeed); let s2 = pcg(s1); let s3 = pcg(s2); let s4 = pcg(s3);
    let r1 = f32(s1)/4294967296.0; let r2 = f32(s2)/4294967296.0;
    let r3 = f32(s3)/4294967296.0; let r4 = f32(s4)/4294967296.0;
    let heightStart = cp.x; let heightEnd = cp.y; let radiusScale = cp.z;
    let shapeType = u32(cp.w);
    var offset: vec3<f32>;
    if (shapeType == 1u) {
        let t = r1; let coneH = (heightEnd - heightStart) * th;
        let y = heightStart * th + t * coneH;
        let rAt = radiusScale * tw * (1.0 - t * 0.85);
        let angle = r2 * 6.2831853; let dist = pow(r3, 0.4) * rAt;
        offset = vec3<f32>(cos(angle)*dist, y, sin(angle)*dist);
    } else if (shapeType == 2u) {
        let fa = r1 * 6.2831853; let ft = 0.3 + r2 * 0.5;
        let fl = radiusScale * tw * (0.6 + r3 * 0.4); let af = r4;
        let y = heightStart * th + sin(ft) * fl * af;
        let hd = cos(ft) * fl * af;
        offset = vec3<f32>(cos(fa)*hd, y, sin(fa)*hd);
    } else if (shapeType == 3u) {
        offset = vec3<f32>(0.0);
    } else {
        let ch = (heightEnd - heightStart) * th;
        let ccy = (heightStart + heightEnd) * 0.5 * th;
        let cr = radiusScale * tw;
        let theta = r1 * 6.2831853; let phi = acos(2.0*r2-1.0);
        let sb = pow(r3, 0.35);
        offset = vec3<f32>(
            sin(phi)*cos(theta)*cr*sb,
            cos(phi)*ch*0.5*sb + ccy - heightStart*th,
            sin(phi)*sin(theta)*cr*sb
        );
        offset.y = offset.y + heightStart * th;
    }
    return offset;
}

fn getLeafSize(speciesIndex: u32, variation: f32, detailLevel: u32) -> vec2<f32> {
    var baseSize: vec2<f32>;
    switch (speciesIndex) {
        case 0u { baseSize = vec2<f32>(0.15, 0.40); }
        case 1u { baseSize = vec2<f32>(0.18, 0.45); }
        case 2u { baseSize = vec2<f32>(0.12, 0.22); }
        case 3u { baseSize = vec2<f32>(0.15, 0.26); }
        case 4u { baseSize = vec2<f32>(0.20, 0.30); }
        case 5u { baseSize = vec2<f32>(0.16, 0.28); }
        case 6u { baseSize = vec2<f32>(0.45, 1.0); }
        case 7u { baseSize = vec2<f32>(0.30, 0.55); }
        case 8u { baseSize = vec2<f32>(0.22, 0.40); }
        case 9u { baseSize = vec2<f32>(0.03, 0.06); }
        default { baseSize = vec2<f32>(0.16, 0.28); }
    }
    var cs: f32 = 3.5;
    if (detailLevel == 1u) { cs = 4.75; } else if (detailLevel >= 2u) { cs = 7.0; }
    return baseSize * (0.75 + variation * 0.5) * cs;
}

fn birchCountForBand(info: TemplateInfo, band: u32) -> u32 {
    let fine = select(info.anchorCount, info.fineCount, info.fineCount > 0u);
    let medium = select(fine, info.mediumCount, info.mediumCount > 0u);
    let coarse = select(medium, info.coarseCount, info.coarseCount > 0u);
    if (band == 0u) { return fine; }
    if (band <= 2u) { return medium; }
    return coarse;
}

fn birchStartForBand(info: TemplateInfo, band: u32) -> u32 {
    if (band == 0u && info.fineCount > 0u) {
        return info.anchorStart + info.fineStart;
    }
    if (band <= 2u && info.mediumCount > 0u) {
        return info.anchorStart + info.mediumStart;
    }
    if (info.coarseCount > 0u) {
        return info.anchorStart + info.coarseStart;
    }
    if (info.mediumCount > 0u) {
        return info.anchorStart + info.mediumStart;
    }
    if (info.fineCount > 0u) {
        return info.anchorStart + info.fineStart;
    }
    return info.anchorStart;
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

// ── Main ─────────────────────────────────────────────────────────────────

@compute @workgroup_size(WORKGROUP_SIZE)
fn main(
    @builtin(workgroup_id) wgId: vec3<u32>,
    @builtin(local_invocation_index) localIdx: u32
) {
    let treeIdx = wgId.x;
    let tree = closeTrees[treeIdx];

    let B = tree.detailLevel;
    let F = tree.bandBlend;

    let isSpruce  = (tree.speciesIndex == 0u) || (tree.speciesIndex == 1u);
    let isBirch   = (tree.speciesIndex == 2u);
    let isSaguaro = (tree.speciesIndex == 9u);

    var targetLeaves: u32 = 0u;
    var birchLadder = false;
    var spruceHierarchical = false;

    var birchTierStart: u32 = 0u;
    var birchTierCount: u32 = 1u;
    var birchCardsThis: u32 = 1u;
    var birchCardsNext: u32 = 1u;
    var birchCrossTier = false;
    var birchAnchorBase: u32 = 0u;
    var birchTemplateInfo = TemplateInfo(
        0u, 0u, 0u, 0u,
        0u, 0u, 0u, 0u,
        0u, 0u, 0u, 0u
    );

    var spruceCardsPerAnchor: u32 = 1u;
    var spruceTemplateIndex: u32 = 0xFFFFFFFFu;

    if (isBirch && B <= 3u
        && params.birchTemplateStart != 0xFFFFFFFFu
        && params.birchTemplateCount > 0u) {

        let variantLocal = pcg(tree.variantSeed) % params.birchTemplateCount;
        let info = templateInfos[params.birchTemplateStart + variantLocal];
        birchTemplateInfo = info;
        birchAnchorBase = info.anchorStart;

        if (info.anchorCount > 0u) {
            birchLadder = true;

            let band = min(B, 3u);
            let nextBand = min(band + 1u, 3u);
            birchTierStart = birchStartForBand(info, band);
            birchTierCount = birchCountForBand(info, band);
            birchCardsThis = birchCardsForBand(band);
            birchCardsNext = birchCardsForBand(nextBand);
            birchCrossTier = false;

            let currentTarget = birchTargetForBand(info, band, tree.distanceToCamera);
            let nextTarget = birchTargetForBand(info, nextBand, tree.distanceToCamera);
            let desired = mix(f32(currentTarget), f32(nextTarget), F) * tree.health;
            targetLeaves = u32(clamp(round(desired), 0.0, f32(MAX_LEAVES)));
        }

    } else if (isSpruce && B <= 2u
               && params.spruceTemplateStart != 0xFFFFFFFFu
               && params.spruceTemplateCount > 0u) {
        let variantLocal = pcg(tree.variantSeed) % params.spruceTemplateCount;
        spruceTemplateIndex = params.spruceTemplateStart + variantLocal;
        let info = templateInfos[spruceTemplateIndex];
        if (info.anchorCount > 0u) {
            spruceHierarchical = true;
            if (B == 0u) { spruceCardsPerAnchor = 3u; targetLeaves = SPRUCE_L0; }
            else if (B == 1u) { spruceCardsPerAnchor = 2u; targetLeaves = SPRUCE_L1; }
            else { spruceCardsPerAnchor = 1u; targetLeaves = SPRUCE_L2; }
            targetLeaves = u32(f32(targetLeaves) * tree.health);
            let cpg = max(spruceCardsPerAnchor, 1u);
            targetLeaves = max(1u, targetLeaves / cpg) * cpg;
        }

    } else if (!isSaguaro && B <= 2u) {
        switch (B) {
            case 0u: { targetLeaves = L0_LEAVES; }
            case 1u: { targetLeaves = L1_LEAVES; }
            default: { targetLeaves = L2_LEAVES; }
        }
        targetLeaves = u32(f32(targetLeaves) * tree.health);
    }

    let budgetBand = min(B, 3u);
    let requestedTotal = max(1u, leafRequestSummary[4u + budgetBand]);
    let leafBudgetScale = min(1.0, f32(LEAF_BAND_BUDGETS[budgetBand]) / f32(requestedTotal));
    if (targetLeaves > 0u && leafBudgetScale < 0.9999) {
        let scaled = u32(floor(f32(targetLeaves) * leafBudgetScale));
        if (spruceHierarchical) {
            let cpg = max(spruceCardsPerAnchor, 1u);
            targetLeaves = (scaled / cpg) * cpg;
        } else {
            targetLeaves = scaled;
        }
    }

    // Clear per-tree tracking (no longer meaningful with global packing)
    if (localIdx == 0u) {
        closeTrees[treeIdx].leafStart = 0u;
        closeTrees[treeIdx].leafCount = 0u;
    }

    // No block reservation — each leaf claims a global slot directly.
    // Continues naturally skip allocation; overflow is handled per-leaf.
    if (targetLeaves > 0u) {
        let leavesPerThread = (targetLeaves + WORKGROUP_SIZE - 1u) / WORKGROUP_SIZE;
        let myStart = localIdx * leavesPerThread;
        let myEnd = min(myStart + leavesPerThread, targetLeaves);

        let canopyParams = getCanopyParams(tree.speciesIndex);
        let treePos = vec3<f32>(tree.worldPosX, tree.worldPosY, tree.worldPosZ);
        let sphereDir = normalize(treePos - params.planetOrigin);
        var refDir = vec3<f32>(0.0, 1.0, 0.0);
        if (abs(dot(sphereDir, refDir)) > 0.99) { refDir = vec3<f32>(1.0, 0.0, 0.0); }
        let tangent = normalize(cross(sphereDir, refDir));
        let bitangent = normalize(cross(sphereDir, tangent));
        let cosR = cos(tree.rotation);
        let sinR = sin(tree.rotation);
        let rotTangent = tangent * cosR + bitangent * sinR;
        let rotBitangent = -tangent * sinR + bitangent * cosR;

        for (var i = myStart; i < myEnd; i++) {
            var localOffset: vec3<f32>;
            var localTwigDir = vec3<f32>(0.0, 1.0, 0.0);
            var cardW: f32 = 0.10;
            var cardH: f32 = 0.15;
            var cardAngle: f32 = 0.0;
            var useAnchors = false;
            var isNeedleCard = false;
            var clusterSeed: u32 = 0u;
            var cardIdx: u32 = 0u;
            var emitBand: u32 = B;

            // ═══ BIRCH LADDER ═════════════════════════════════════════
            if (birchLadder) {
                useAnchors = true;

                var selectedBand = min(B, 3u);
                if (F > 0.0 && selectedBand < 3u) {
                    let transitionSeed = pcg3(tree.variantSeed, i, 0x5AE75700u);
                    if (pcgF(transitionSeed) < F) {
                        selectedBand = selectedBand + 1u;
                    }
                }

                let cardsPerFamily = max(1u, birchCardsForBand(selectedBand));
                let familyBase = i / cardsPerFamily;
                // Deterministic permutation over tier anchors to avoid visible
                // "first-N" clumps when targetLeaves is below full coverage.
                let tierStart = birchStartForBand(birchTemplateInfo, selectedBand);
                let tierN = max(1u, birchCountForBand(birchTemplateInfo, selectedBand));
                let familyId = (familyBase * 2654435761u + (tree.variantSeed ^ 0x9E3779B9u)) % tierN;
                let familyCycle = familyBase / tierN;
                cardIdx = i % cardsPerFamily;
                clusterSeed = pcg3(tree.variantSeed, familyId ^ (familyCycle * 0x9E3779B9u), 0xB1A50000u);


                let anchorIdx = tierStart + familyId;
                let anchor = anchors[anchorIdx];

                var emitPos = vec3<f32>(anchor.posX, anchor.posY, anchor.posZ);
                var emitDir = normalize(vec3<f32>(anchor.dirX, anchor.dirY, anchor.dirZ));
                var emitSpread = anchor.spread;
                var emitTipDist = anchor.density;

                var shouldSkip = false;
                if (birchCrossTier) {
                    let parentLocal = anchor.parentIdx;
                    if (parentLocal != 0xFFFFFFFFu) {
                        let parent = anchors[birchAnchorBase + parentLocal];
                        let goCoarser = pcgF(pcg2(tree.variantSeed ^ 0xC0A75E00u, parentLocal)) < F;

                        if (goCoarser) {
                            let myTemplateLocal = anchorIdx - birchAnchorBase;
                            let isDesignated = (parent.childStart == myTemplateLocal);

                            if (isDesignated && cardIdx < birchCardsNext) {
                                emitBand = B + 1u;
                                emitPos = vec3<f32>(parent.posX, parent.posY, parent.posZ);
                                emitDir = normalize(vec3<f32>(parent.dirX, parent.dirY, parent.dirZ));
                                emitSpread = parent.spread;
                                emitTipDist = 1.0;
                            } else {
                                shouldSkip = true;
                            }
                        }
                    }
                }
                if (shouldSkip) { continue; }
                emitBand = selectedBand;


                localOffset = vec3<f32>(
                    emitPos.x * tree.scaleX,
                    emitPos.y * tree.scaleY,
                    emitPos.z * tree.scaleZ
                );

                // Volumetric near-canopy spread:
                // Build a local frame around the drooper direction so cards
                // occupy a 3D cloud around each anchor (better under-canopy view).
                let twigAxis = normalize(vec3<f32>(emitDir.x, emitDir.y, emitDir.z));
                let twigTan = safePerp(twigAxis);
                let twigBitan = normalize(cross(twigAxis, twigTan));
                let nearVol = 1.0 - smoothstep(0.0, 6.0, tree.distanceToCamera);
                let spreadBase = min(0.20, emitSpread * 2.0) * (0.35 + 0.65 * nearVol);
                let cardSeed0 = pcg3(clusterSeed, cardIdx, 0x4F1BBCDDu);
                let r0 = pcgF(cardSeed0);
                let r1 = pcgF(pcg(cardSeed0));
                let r2 = pcgF(pcg(pcg(cardSeed0)));
                let a = r0 * 6.2831853;
                let radial = sqrt(r1) * spreadBase;
                let axial = (r2 - 0.5) * spreadBase * 0.8;
                let volOffset = twigTan * (cos(a) * radial)
                              + twigBitan * (sin(a) * radial)
                              + twigAxis * axial;
                localOffset = localOffset + vec3<f32>(
                    volOffset.x * tree.scaleX,
                    volOffset.y * tree.scaleY,
                    volOffset.z * tree.scaleZ
                );

                // When nearLeaves exceeds unique anchor-card slots, repeated
                // cycles must not stack at identical positions. Add a tiny,
                // deterministic per-cycle jitter around the anchor.
                if (familyCycle > 0u) {
                    let cycSeed = pcg3(clusterSeed, familyCycle, 0x6E624EB7u);
                    let jitterA = pcgF(cycSeed) * 6.2831853;
                    let jitterR = sqrt(pcgF(pcg(cycSeed))) * min(0.16, emitSpread * 1.6);
                    let jitterY = (pcgF(pcg(pcg(cycSeed))) - 0.5) * min(0.05, emitSpread * 0.8);
                    let jitter = rotTangent * (cos(jitterA) * jitterR)
                               + rotBitangent * (sin(jitterA) * jitterR)
                               + sphereDir * jitterY;
                    localOffset = localOffset + vec3<f32>(
                        dot(jitter, rotTangent),
                        dot(jitter, sphereDir),
                        dot(jitter, rotBitangent)
                    );
                }

                // ── FIX: store the anchor's horizontal direction as twigDir.
                // The anchor direction emitDir often has significant Y (upward
                // or downward along the drooper), which previously caused the
                // vertex shader to build a near-horizontal card frame and
                // produce normals pointing mostly toward +Y (cards lying flat).
                // Storing the horizontal projection here means the vertex shader
                // receives a direction that lies in the local ground plane,
                // letting it build a consistently vertical card frame.
                // The vertical component is intentionally dropped — card
                // orientation around the vertical axis is all we need from
                // the anchor; the card's up axis is always sphereDir.
                let twigHoriz = emitDir - sphereDir * dot(emitDir, sphereDir);
                let twigHorizLen = length(twigHoriz);
                if (twigHorizLen > 0.05) {
                    localTwigDir = twigHoriz / twigHorizLen;
                } else {
                    // Nearly vertical anchor — use a random stable horizontal.
                    // Rotate rotTangent by familyId to spread card azimuths.
                    let ang = f32(familyId) * 2.399963; // golden-angle radians
                    localTwigDir = rotTangent * cos(ang) + rotBitangent * sin(ang);
                }

                // Near-field birch curve:
                // 0..20m: interpolate from compact close-up leaves to the
                // target mid size. >20m: hold size; 20..80m density fades out.
                let nearSizeT = smoothstep(0.0, BIRCH_NEAR_DISTANCE, tree.distanceToCamera);
                let sizeW = mix(BIRCH_CLOSE_W, BIRCH_SETTLED_W, nearSizeT);
                let sizeH = mix(BIRCH_CLOSE_H, BIRCH_SETTLED_H, nearSizeT);
                let sizeSeed = pcg3(clusterSeed, cardIdx, 0xD1F75000u);
                let sizeVar = 0.85 + pcgF(sizeSeed) * 0.30;
                if (selectedBand == 0u) {
                    cardW = sizeW * sizeVar;
                    cardH = sizeH * sizeVar;
                } else {
                    let spreadX = emitSpread * max(tree.scaleX, tree.scaleZ);
                    let spreadY = emitSpread * tree.scaleY;
                    if (selectedBand == 1u) {
                        cardW = clamp(spreadX * 1.35, 0.30, 1.05) * sizeVar;
                        cardH = clamp(spreadY * 1.05, 0.45, 1.45) * sizeVar;
                    } else if (selectedBand == 2u) {
                        cardW = clamp(spreadX * 1.65, 0.45, 1.75) * sizeVar;
                        cardH = clamp(spreadY * 1.25, 0.70, 2.35) * sizeVar;
                    } else {
                        cardW = clamp(spreadX * 2.00, 0.70, 2.80) * sizeVar;
                        cardH = clamp(spreadY * 1.45, 0.95, 3.60) * sizeVar;
                    }
                }

                // Tip clamp: only meaningful for fine-tier bands (L0/L1)
                // where emitTipDist is the drooper arc-length to tip.
                // At L2/L3 the fixed card size is already small enough
                // that overshooting is not an issue.
                if (selectedBand == 0u) {
                    let tipWorld = emitTipDist * tree.scaleY;
                    cardH = min(cardH, max(0.025, tipWorld * 1.3));
                }

                let activeCards = cardsPerFamily;
                let cardPhase = f32(cardIdx) / max(f32(activeCards), 1.0);
                let orientNear = 1.0 - smoothstep(0.0, 8.0, tree.distanceToCamera);
                let azimuthSpan = mix(3.14159265, 6.2831853, orientNear);
                let angleJitter = (pcgF(pcg(clusterSeed ^ (cardIdx * 0xAB51CE00u))) - 0.5) * 0.30;
                cardAngle = cardPhase * azimuthSpan + angleJitter;

            // ═══ SPRUCE (legacy) ══════════════════════════════════════
            } else if (spruceHierarchical) {
                useAnchors = true;
                isNeedleCard = true;

                let groupId = i / spruceCardsPerAnchor;
                cardIdx = i % spruceCardsPerAnchor;
                clusterSeed = pcg3(tree.variantSeed, groupId, 0xC0E1FE42u);

                let sample = sampleSpruceAnchor(spruceTemplateIndex, clusterSeed, groupId);
                let rootLocal = vec3<f32>(
                    sample.pos.x * tree.scaleX,
                    sample.pos.y * tree.scaleY,
                    sample.pos.z * tree.scaleZ
                );
                let rootDir = sample.dir;

                let s1 = pcg3(clusterSeed, cardIdx, 0xD1F70000u);
                let s2 = pcg(s1); let s3 = pcg(s2);
                let perpTan = safePerp(rootDir);
                let perpBitan = normalize(cross(rootDir, perpTan));
                let perpAngle = pcgF(s2) * 6.2831853;
                let perpDist = sqrt(pcgF(s3)) * sample.spread * tree.scaleY * 0.40;
                let alongFrac = (pcgF(s1) - 0.5) * sample.spread * tree.scaleY * 0.30;

                localOffset = rootLocal + rootDir * alongFrac
                            + (perpTan*cos(perpAngle) + perpBitan*sin(perpAngle)) * perpDist;
                localTwigDir = rootDir;

                let cardPhase = f32(cardIdx) / max(f32(spruceCardsPerAnchor), 1.0);
                cardAngle = cardPhase * 3.14159265 + (pcgF(pcg(clusterSeed ^ cardIdx)) - 0.5) * 0.3;

                let spreadWorld = sample.spread * tree.scaleY;
                cardW = clamp(spreadWorld * 2.8, 0.10, 0.45);
                cardH = clamp(spreadWorld * 1.4, 0.06, 0.22);
                if (B == 1u) { cardW *= 1.6; cardH *= 1.6; }
                else if (B >= 2u) { cardW *= 2.4; cardH *= 2.4; }

            // ═══ GENERIC (legacy) ═════════════════════════════════════
            } else {
                localOffset = generateLeafPosition(
                    tree.variantSeed, i, canopyParams, tree.scaleY, tree.scaleX
                );
                let ls = getLeafSize(tree.speciesIndex, pcgF(pcg(pcg3(tree.variantSeed, i, 0u))), B);
                cardW = ls.x; cardH = ls.y;
            }

            // ── World transform ───────────────────────────────────────
            let worldOffset = rotTangent * localOffset.x
                            + sphereDir  * localOffset.y
                            + rotBitangent * localOffset.z;
            let leafPos = treePos + worldOffset;
            let worldTwigDir = normalize(
                rotTangent    * localTwigDir.x
              + sphereDir     * localTwigDir.y
              + rotBitangent  * localTwigDir.z
            );

            // ── Attributes ────────────────────────────────────────────
            var leafSeed: u32; var rot: f32;
            if (useAnchors) {
                leafSeed = pcg3(clusterSeed, cardIdx, 0xABCDEF01u);
                rot = cardAngle + (pcgF(pcg(leafSeed ^ 0x77651u)) - 0.5) * 0.20;
            } else {
                leafSeed = pcg3(tree.variantSeed, i, 0xABCDEF01u);
                rot = pcgF(leafSeed) * 6.2831853;
            }

            let colorVar = pcgF(pcg(pcg(leafSeed)));
            let baseColor = vec3<f32>(tree.foliageR, tree.foliageG, tree.foliageB);
            let co = (colorVar - 0.5) * 0.15;
            var leafColor: vec3<f32>;
            if (isNeedleCard) {
                leafColor = clamp(baseColor + vec3<f32>(co*0.6, co*0.3, co*0.2),
                                  vec3<f32>(0.0), vec3<f32>(1.0));
            } else {
                leafColor = clamp(baseColor + vec3<f32>(co, co*0.5, co*0.3),
                                  vec3<f32>(0.0), vec3<f32>(1.0));
            }

            var clusterVariant: f32;
            if (useAnchors) {
                clusterVariant = pcgF(pcg(clusterSeed ^ (cardIdx * 0x9E3779B9u)));
            } else {
                clusterVariant = pcgF(pcg(leafSeed));
            }

            var flags = (emitBand & 0x7u) | (tree.speciesIndex << 8u);
            if (isNeedleCard) { flags = flags | 0x10u; }

            let slot = atomicAdd(&leafCounter[0], 1u);
            if (slot >= MAX_LEAVES) { continue; }
            leafInstances[slot] = LeafInstance(
                leafPos.x, leafPos.y, leafPos.z, rot,
                max(cardW, 0.02), max(cardH, 0.02),
                tree.tileTypeId, flags,
                leafColor.x, leafColor.y, leafColor.z, 1.0,
                worldTwigDir.x, worldTwigDir.y, worldTwigDir.z, clusterVariant
            );
        }
    }

}
`;
}

export function buildLeafDrawArgsShader(config = {}) {
    const QUAD_INDEX_COUNT = config.quadIndexCount ?? 6;
    const MAX_LEAVES       = config.maxLeaves      ?? 600000;

    return /* wgsl */`
const QUAD_INDEX_COUNT: u32 = ${QUAD_INDEX_COUNT}u;
const MAX_LEAVES:       u32 = ${MAX_LEAVES}u;

@group(0) @binding(0) var<storage, read>       leafCounter: array<u32>;
@group(0) @binding(1) var<storage, read_write> drawArgs:    array<u32>;

@compute @workgroup_size(1)
fn main() {
    let count = min(leafCounter[0], MAX_LEAVES);
    drawArgs[0] = QUAD_INDEX_COUNT;
    drawArgs[1] = count;
    drawArgs[2] = 0u;
    drawArgs[3] = 0u;
    drawArgs[4] = 0u;
}
`;
}
