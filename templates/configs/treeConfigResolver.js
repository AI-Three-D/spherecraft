import { Logger } from '../../shared/Logger.js';

const TAG = '[treeConfigResolver]';

const DEFAULT_REQUESTED_TREE_DENSITY = 0.0072;
const TREE_LOD_DENSITY_PROFILE = [1.0, 1.0 / 3.0, 0.1, 0.05, 0.025];
const DEFAULT_SOURCE_RANGE_MULTIPLIER = 1.2;
const DEFAULT_NEAR_QUOTA_HEADROOM = 1.35;
const DEFAULT_MID_QUOTA_HEADROOM = 1.2;
const DEFAULT_LEAF_QUOTA_HEADROOM = 1.25;
const MIN_OUTER_BAND_LEAVES = 256;

/**
 * Normalizes the raw `trees` config so tier ranges and a single
 * master density drive the scatter profile, LOD distances, and quotas.
 *
 * Legacy scatter.lodDistances / scatter.densities remain accepted as
 * compatibility inputs, but they are no longer authoritative.
 */
export function resolveTreeConfig(raw) {
    if (!raw?.tierRanges?.near || !raw?.tierRanges?.mid) {
        Logger.warn(`${TAG} missing tierRanges; returning raw config unchanged`);
        return raw;
    }

    const nearEnd = raw.tierRanges.near.end;
    const midEnd = raw.tierRanges.mid.end;
    const renderHorizon = Math.max(nearEnd, midEnd);
    const gatherCullRadius = midEnd + (raw.tierRanges.mid.fadeOutWidth ?? 0);

    const branchLODBands = normalizeBranchBands(
        raw.nearTier?.branchLODBands ?? [],
        nearEnd,
        raw.nearTier?.branchTerminalLevel ?? 2
    );
    const branchFadeMargin = raw.nearTier?.branchFadeMargin ?? nearEnd * 0.15;

    const leafBands = normalizeLeafBands(raw.nearTier?.leafBands ?? [], nearEnd);
    const birch = resolveBirch(raw.nearTier?.birch ?? {}, nearEnd);
    const leafCounts = normalizeLeafCounts(
        raw.nearTier?.leafCounts ?? { generic: [6000, 3000, 1500, 1500] },
        leafBands.length
    );

    const scatterRaw = raw.scatter ?? {};
    const densityRaw = raw.density ?? {};
    const theoreticalMaxDensity = computeTheoreticalTreeDensity(scatterRaw);
    const requestedMaxDensity = deriveRequestedTreeDensity(raw, theoreticalMaxDensity);
    const practicalMaxDensity = Math.min(requestedMaxDensity, theoreticalMaxDensity);
    const densityScale = theoreticalMaxDensity > 1e-6
        ? requestedMaxDensity / theoreticalMaxDensity
        : 0.0;

    const treeAssetLodDistances = deriveTreeAssetLodDistances(nearEnd, gatherCullRadius);
    const treeAssetDensities = deriveTreeAssetDensities(practicalMaxDensity);

    const sourceRangeMultiplier = sanitizeHeadroom(
        densityRaw.sourceRangeMultiplier,
        DEFAULT_SOURCE_RANGE_MULTIPLIER
    );
    const sourceNominalRange = Number.isFinite(raw.sourceNominalRange)
        ? raw.sourceNominalRange
        : Math.ceil(gatherCullRadius * sourceRangeMultiplier);

    const nearQuotaHeadroom = sanitizeHeadroom(
        densityRaw.nearQuotaHeadroom,
        DEFAULT_NEAR_QUOTA_HEADROOM
    );
    const midQuotaHeadroom = sanitizeHeadroom(
        densityRaw.midQuotaHeadroom,
        DEFAULT_MID_QUOTA_HEADROOM
    );
    const leafQuotaHeadroom = sanitizeHeadroom(
        densityRaw.leafQuotaHeadroom,
        DEFAULT_LEAF_QUOTA_HEADROOM
    );

    const nearTreeEstimate = Math.PI * nearEnd * nearEnd * practicalMaxDensity;
    const midTreeEstimate = Math.PI * Math.max(0, (midEnd * midEnd) - (nearEnd * nearEnd)) * practicalMaxDensity;
    const autoMaxCloseTrees = ceilPowerOfTwo(nearTreeEstimate * nearQuotaHeadroom, 256);
    const autoMaxMidTrees = ceilPowerOfTwo(midTreeEstimate * midQuotaHeadroom, 1024);

    const leafEstimate = estimateLeafDemand({
        leafBands,
        leafCounts,
        birch,
        practicalMaxDensity,
    });
    const autoMaxTotalLeaves = ceilPowerOfTwo(
        leafEstimate.totalLeaves * leafQuotaHeadroom,
        131072
    );

    const scatter = {
        ...scatterRaw,
        densityScale,
        lodDistances: treeAssetLodDistances,
        densities: treeAssetDensities,
    };

    if (requestedMaxDensity > theoreticalMaxDensity + 1e-6) {
        Logger.warn(
            `${TAG} density.maxTreesPerSquareMeter=${requestedMaxDensity.toFixed(5)} exceeds ` +
            `scatter ceiling ${theoreticalMaxDensity.toFixed(5)}; runtime quotas use the practical ceiling.`
        );
    }

    const coarseRange = raw.tierRanges.farTrees ?? raw.tierRanges.cluster ?? {};
    const clusterStart = coarseRange.start ?? 800;
    const clusterEnd = coarseRange.end ?? 2000;

    const farTreeTierRaw = raw.farTreeTier ?? raw.clusterTier ?? {};
    const cBake = farTreeTierRaw?.bake ?? {};
    const cNomRange = farTreeTierRaw?.sourceNominalRange ?? {};
    const clusterNominalStart = Number.isFinite(cNomRange.start)
        ? cNomRange.start
        : Math.floor(clusterStart * 0.8);
    const clusterNominalEnd = Number.isFinite(cNomRange.end)
        ? cNomRange.end
        : Math.ceil(clusterEnd * 1.5);

    const fr = raw.tierRanges.far ?? {};
    const farStart = fr.start ?? clusterEnd;
    const farEnd = fr.end ?? Math.ceil(clusterEnd * 4.0);
    const farNominalStart = Number.isFinite(fr.nominalStart)
        ? fr.nominalStart
        : Math.floor(farStart * 0.8);
    const farNominalEnd = Number.isFinite(fr.nominalEnd)
        ? fr.nominalEnd
        : Math.ceil(farEnd * 1.5);

    const gridTable = buildClusterGridTable(
        cBake.gridByTileSize ?? [],
        cBake.minGridDim ?? 3,
        cBake.maxGridDim ?? 8
    );

    const resolved = {
        ...raw,
        density: {
            ...densityRaw,
            maxTreesPerSquareMeter: requestedMaxDensity,
        },
        scatter,
        nearTier: {
            ...raw.nearTier,
            maxCloseTrees: Number.isFinite(raw.nearTier?.maxCloseTrees)
                ? raw.nearTier.maxCloseTrees
                : autoMaxCloseTrees,
            maxTotalLeaves: Number.isFinite(raw.nearTier?.maxTotalLeaves)
                ? raw.nearTier.maxTotalLeaves
                : autoMaxTotalLeaves,
            branchLODBands,
            branchFadeMargin,
            leafBands,
            leafCounts,
            birch,
            birchLadder: undefined,
            birchTransition: undefined,
            leafSizeMin: undefined,
            leafSizeMax: undefined,
            genericLeafCounts: undefined,
            speciesLeafCounts: undefined,
        },
        midTier: {
            ...raw.midTier,
            maxTrees: Number.isFinite(raw.midTier?.maxTrees)
                ? raw.midTier.maxTrees
                : autoMaxMidTrees,
        },
        farTreeTier: {
            ...farTreeTierRaw,
            bake: {
                ...cBake,
                _gridTable: gridTable,
            },
        },
        clusterTier: {
            ...farTreeTierRaw,
            bake: {
                ...cBake,
                _gridTable: gridTable,
            },
        },
        _derived: {
            nearEnd,
            midEnd,
            renderHorizon,
            sourceNominalRange,
            trackerCullRadius: nearEnd,
            gatherCullRadius,
            requestedMaxDensity,
            theoreticalMaxDensity,
            practicalMaxDensity,
            treeAssetLodDistances,
            treeAssetDensities,
            nearTreeEstimate,
            midTreeEstimate,
            leafDemandEstimate: leafEstimate.totalLeaves,
            leafDemandPerBand: leafEstimate.perBand,
            settledBirchLeafEstimate: leafEstimate.settledBirchLeaves,
            autoMaxCloseTrees,
            autoMaxMidTrees,
            autoMaxTotalLeaves,

            clusterStart,
            clusterEnd,
            clusterNominalStart,
            clusterNominalEnd,
            clusterGatherRadius: clusterEnd + (coarseRange.fadeOutWidth ?? 0),
            farTreeStart: clusterStart,
            farTreeEnd: clusterEnd,
            farStart,
            farEnd,
            farNominalStart,
            farNominalEnd,
        },
    };

    logSummary(resolved);
    return resolved;
}

function resolveBirch(rawBirch, nearEnd) {
    const nearDistance = rawBirch.nearDistance ?? 20.0;
    const closeSize = rawBirch.closeSize ?? 0.36;
    const settledSize = rawBirch.settledSize ?? 0.55;
    const aspect = rawBirch.aspect ?? 1.5;

    if (nearDistance >= nearEnd) {
        Logger.warn(
            `${TAG} birch.nearDistance=${nearDistance} >= near.end=${nearEnd}; ` +
            `size ramp will never complete.`
        );
    }

    return {
        nearDistance,
        closeSize,
        settledSize,
        aspect,
        closeLeaves: rawBirch.closeLeaves ?? 4000,
        closeCardsPerAnchor: rawBirch.closeCardsPerAnchor ?? 10,
        settledCardsPerAnchor: rawBirch.settledCardsPerAnchor ?? 1,
        l0SettledLeaves: rawBirch.l0SettledLeaves ?? 1200,
        l1CardsPerAnchor: rawBirch.l1CardsPerAnchor ?? 4,
        l2CardsPerAnchor: rawBirch.l2CardsPerAnchor ?? 2,
        l3CardsPerAnchor: rawBirch.l3CardsPerAnchor ?? 2,
        fadeDistance: nearEnd,
        closeW: closeSize,
        closeH: closeSize * aspect,
        settledW: settledSize,
        settledH: settledSize * aspect,
    };
}

function normalizeBranchBands(bands, nearEnd, terminalLevel) {
    const out = [];
    for (const b of bands) {
        if (b.distance >= nearEnd) {
            Logger.warn(
                `${TAG} branchLODBands distance=${b.distance} >= near.end=${nearEnd}; ` +
                `clamping and dropping terminal append.`
            );
            out.push({ distance: nearEnd, maxLevel: b.maxLevel });
            return out;
        }
        out.push({ ...b });
    }
    out.push({ distance: nearEnd, maxLevel: terminalLevel });
    return out;
}

function normalizeLeafBands(bands, nearEnd) {
    if (bands.length === 0) return [{ start: 0, end: nearEnd }];
    return bands.map((b, i) => {
        const isLast = i === bands.length - 1;
        let end = b.end;
        if (isLast) {
            if (end != null && end !== nearEnd) {
                Logger.warn(
                    `${TAG} leafBands final end=${end} != near.end=${nearEnd}; overriding.`
                );
            }
            end = nearEnd;
        } else if (end == null || end > nearEnd) {
            Logger.warn(`${TAG} leafBands[${i}].end=${end} invalid; clamping to near.end`);
            end = nearEnd;
        }
        return { start: b.start, end };
    });
}

function normalizeLeafCounts(counts, bandCount) {
    const out = {};
    for (const [key, arr] of Object.entries(counts)) {
        if (!Array.isArray(arr) || arr.length === 0) continue;
        if (arr.length < bandCount) {
            const padded = [...arr];
            while (padded.length < bandCount) padded.push(arr[arr.length - 1]);
            out[key] = padded;
            Logger.warn(
                `${TAG} leafCounts.${key} has ${arr.length} entries but ${bandCount} bands; padded.`
            );
        } else {
            out[key] = arr.slice(0, bandCount);
        }
    }
    if (!out.generic) {
        out.generic = Array(bandCount).fill(1500);
        if (bandCount > 0) out.generic[0] = 6000;
        if (bandCount > 1) out.generic[1] = 3000;
        Logger.warn(`${TAG} leafCounts.generic missing; defaulted.`);
    }
    return out;
}

function sanitizeHeadroom(value, fallback) {
    if (!Number.isFinite(value)) return fallback;
    return Math.max(1.0, value);
}

function ceilPowerOfTwo(value, minValue = 1) {
    let target = Math.max(minValue, Math.ceil(value));
    let out = 1;
    while (out < target && out < 0x40000000) out <<= 1;
    return out < target ? target : out;
}

function computeTheoreticalTreeDensity(scatter) {
    const cellSize = Number.isFinite(scatter?.cellSize) ? Math.max(1.0, scatter.cellSize) : 16.0;
    const maxPerCell = Number.isFinite(scatter?.maxPerCell) ? Math.max(1, Math.floor(scatter.maxPerCell)) : 4;
    const clusterProbability = Number.isFinite(scatter?.clusterProbability)
        ? Math.max(0.0, Math.min(1.0, scatter.clusterProbability))
        : 0.95;
    const expectedTreesPerActiveCell = (maxPerCell + 1) * 0.5;
    return (clusterProbability * expectedTreesPerActiveCell) / (cellSize * cellSize);
}

function deriveRequestedTreeDensity(raw, theoreticalMaxDensity) {
    const explicit = raw?.density?.maxTreesPerSquareMeter;
    if (Number.isFinite(explicit) && explicit > 0) return explicit;

    const legacyDensities = raw?.scatter?.densities;
    if (Array.isArray(legacyDensities) && Number.isFinite(legacyDensities[0]) && legacyDensities[0] > 0) {
        return legacyDensities[0];
    }

    const legacyDensityScale = raw?.scatter?.densityScale;
    if (Number.isFinite(legacyDensityScale) && legacyDensityScale > 0 && theoreticalMaxDensity > 0) {
        return theoreticalMaxDensity * legacyDensityScale;
    }

    return DEFAULT_REQUESTED_TREE_DENSITY;
}

function deriveTreeAssetLodDistances(nearEnd, gatherCullRadius) {
    const d0 = Math.max(8, nearEnd * 0.10);
    const d1 = Math.max(d0 + 1, nearEnd * 0.50);
    const d2 = Math.max(d1 + 1, nearEnd * 0.75);
    const d3 = Math.max(d2 + 1, nearEnd + Math.max(0, gatherCullRadius - nearEnd) * 0.35);
    const d4 = Math.max(d3 + 1, gatherCullRadius);
    return makeIncreasingIntegers([d0, d1, d2, d3, d4], 8);
}

function deriveTreeAssetDensities(practicalMaxDensity) {
    return TREE_LOD_DENSITY_PROFILE.map((weight) => practicalMaxDensity * weight);
}

function makeIncreasingIntegers(values, minValue = 1) {
    const out = [];
    let prev = minValue - 1;
    for (const value of values) {
        const next = Math.max(prev + 1, Math.round(value));
        out.push(next);
        prev = next;
    }
    return out;
}

function estimateLeafDemand({ leafBands, leafCounts, birch, practicalMaxDensity }) {
    const generic = Array.isArray(leafCounts?.generic)
        ? leafCounts.generic
        : [6000, 3000, 1500, 1500];
    const settledBirchLeaves = Math.max(
        MIN_OUTER_BAND_LEAVES,
        Math.round(
            (birch.closeLeaves ?? 4000) /
            Math.max(1, birch.closeCardsPerAnchor ?? 10)
        ) * Math.max(1, birch.settledCardsPerAnchor ?? 1)
    );

    const segments = buildNonOverlappingLeafSegments(leafBands);
    const perBand = [];
    let totalLeaves = 0;

    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        const trees = Math.PI * Math.max(0, (segment.end * segment.end) - (segment.start * segment.start)) * practicalMaxDensity;
        const leavesPerTree = i < 3
            ? (generic[i] ?? generic[generic.length - 1] ?? 1500)
            : settledBirchLeaves;
        const leaves = trees * leavesPerTree;
        totalLeaves += leaves;
        perBand.push({
            start: segment.start,
            end: segment.end,
            trees,
            leavesPerTree,
            leaves,
        });
    }

    return {
        totalLeaves,
        settledBirchLeaves,
        perBand,
    };
}

function buildNonOverlappingLeafSegments(leafBands) {
    const segments = [];
    let cursor = 0;
    for (const band of leafBands) {
        const end = Math.max(cursor, band?.end ?? cursor);
        segments.push({ start: cursor, end });
        cursor = end;
    }
    return segments;
}

function logSummary(r) {
    const d = r._derived;
    const b = r.nearTier.birch;
    const farSegment = d.farEnd > d.farStart
        ? ` legacyFar=[${d.farStart},${d.farEnd}]`
        : '';
    Logger.info(
        `${TAG} resolved - near=[0,${d.nearEnd}] mid=[${r.tierRanges.mid.start},${d.midEnd}] ` +
        `farTier=[${d.clusterStart},${d.clusterEnd}]${farSegment} ` +
        `sourceNominal=${d.sourceNominalRange} trackerCull=${d.trackerCullRadius} gatherCull=${d.gatherCullRadius}`
    );
    Logger.info(
        `${TAG}   density: requested=${d.requestedMaxDensity.toFixed(5)} ` +
        `practical=${d.practicalMaxDensity.toFixed(5)} theoreticalMax=${d.theoreticalMaxDensity.toFixed(5)} ` +
        `scale=${r.scatter.densityScale.toFixed(3)}`
    );
    Logger.info(
        `${TAG}   budgets: near=${r.nearTier.maxCloseTrees} (est ${Math.round(d.nearTreeEstimate)}) ` +
        `mid=${r.midTier.maxTrees} (est ${Math.round(d.midTreeEstimate)}) ` +
        `leaves=${r.nearTier.maxTotalLeaves} (est ${Math.round(d.leafDemandEstimate)})`
    );
    Logger.info(
        `${TAG}   treeLods: [${d.treeAssetLodDistances.join(', ')}] ` +
        `treeDensities=[${d.treeAssetDensities.map(v => v.toFixed(5)).join(', ')}]`
    );
    Logger.info(
        `${TAG}   branches: ${r.nearTier.branchLODBands.map(x => `${x.distance}m@L${x.maxLevel}`).join(' -> ')} ` +
        `meshLOD=${r.nearTier.branchGeometryLOD ?? 0}`
    );
    Logger.info(
        `${TAG}   leafBands: ${r.nearTier.leafBands.map(x => `[${x.start},${x.end}]`).join(' ')}`
    );
    Logger.info(
        `${TAG}   birch: size ${b.closeSize}->${b.settledSize} over ${b.nearDistance}m ` +
        `(aspect ${b.aspect}), cards L0 ${b.closeLeaves}->${b.l0SettledLeaves}, ` +
        `L1 anchorsx${b.l1CardsPerAnchor}, L2 anchorsx${b.l2CardsPerAnchor}, ` +
        `L3 anchorsx${b.l3CardsPerAnchor} over ${b.fadeDistance}m`
    );
}

function buildClusterGridTable(entries, minG, maxG) {
    const table = {};
    const sorted = [...entries].sort((a, b) => a.tileSize - b.tileSize);
    const sizes = [128, 256, 512, 1024, 2048, 4096, 8192];
    for (const ts of sizes) {
        let best = sorted[0];
        for (const e of sorted) {
            if (e.tileSize <= ts) best = e; else break;
        }
        table[ts] = Math.max(minG, Math.min(maxG, best?.gridDim ?? minG));
    }
    return table;
}
