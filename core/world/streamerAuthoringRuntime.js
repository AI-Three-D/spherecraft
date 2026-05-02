import { Logger } from '../../shared/Logger.js';
import {
    CLUSTER_TREE_DEFAULT_TILE_COUNT,
    CLUSTER_TREE_METADATA_STRIDE_FLOATS,
    collectTreeProfileWeights,
    computeBiomeTreeProfileHint,
    normalizeArchetypeRef,
} from './biomeAuthoringDerived.js';

const ARCHETYPE_PROFILE_TARGETS = Object.freeze({
    tree: Object.freeze({
        legacyAssetIds: ['birch'],
        variantNames: ['birch'],
        familyNames: ['forest_canopy'],
    }),
    fern: Object.freeze({
        legacyAssetIds: [],
        variantNames: ['fern_bracken'],
        familyNames: ['forest_floor_fern'],
    }),
    rock: Object.freeze({
        legacyAssetIds: [],
        variantNames: ['granite_small'],
        familyNames: ['universal_rocky'],
    }),
    mushroom: Object.freeze({
        legacyAssetIds: [],
        variantNames: ['amanita_muscaria'],
        familyNames: ['forest_floor_fungal'],
    }),
    log: Object.freeze({
        legacyAssetIds: [],
        variantNames: ['birch_log_fresh', 'birch_log_mossy'],
        familyNames: ['forest_deadwood_log'],
    }),
    stump: Object.freeze({
        legacyAssetIds: [],
        variantNames: ['birch_stump'],
        familyNames: ['forest_deadwood_stump'],
    }),
});

function cloneValue(value) {
    if (Array.isArray(value)) {
        return value.map(cloneValue);
    }
    if (value && typeof value === 'object') {
        const out = {};
        for (const [key, nested] of Object.entries(value)) {
            out[key] = cloneValue(nested);
        }
        return out;
    }
    return value;
}

function computeTileQuartet(tileId, tileCategories = []) {
    if (!Number.isInteger(tileId)) return [];
    for (const category of tileCategories) {
        const ranges = Array.isArray(category?.ranges) ? category.ranges : [];
        for (const range of ranges) {
            const low = Number.isInteger(range?.[0]) ? range[0] : null;
            const high = Number.isInteger(range?.[1]) ? range[1] : null;
            if (low == null || high == null || tileId < low || tileId > high) continue;
            const quartetBase = low + Math.floor((tileId - low) / 4) * 4;
            const quartet = [];
            for (let offset = 0; offset < 4; offset++) {
                const candidate = quartetBase + offset;
                if (candidate <= high) quartet.push(candidate);
            }
            return quartet;
        }
    }
    return [tileId];
}

function collectBiomeTileTypes(biomes, tileCategories) {
    const tileIds = new Set();
    for (const biome of biomes) {
        const refs = [biome?.tileIds?.micro, biome?.tileIds?.macro];
        for (const tileId of refs) {
            for (const expanded of computeTileQuartet(tileId, tileCategories)) {
                tileIds.add(expanded);
            }
        }
    }
    return Array.from(tileIds).sort((a, b) => a - b);
}

function expandSignalRange(rule, minClamp = 0.0, maxClamp = 1.0) {
    if (!rule) return null;
    const minValue = Number.isFinite(rule.min) ? rule.min : minClamp;
    const maxValue = Number.isFinite(rule.max) ? rule.max : maxClamp;
    const transition = Number.isFinite(rule.transitionWidth) ? rule.transitionWidth : 0.0;
    const low = Math.max(minClamp, Math.min(maxClamp, Math.min(minValue, maxValue) - transition));
    const high = Math.max(minClamp, Math.min(maxClamp, Math.max(minValue, maxValue) + transition));
    return high >= low ? [low, high] : [minClamp, maxClamp];
}

function unionSignalRange(biomes, signalKey, minClamp = 0.0, maxClamp = 1.0) {
    let minValue = Infinity;
    let maxValue = -Infinity;

    for (const biome of biomes) {
        const range = expandSignalRange(biome?.signals?.[signalKey], minClamp, maxClamp);
        if (!range) continue;
        minValue = Math.min(minValue, range[0]);
        maxValue = Math.max(maxValue, range[1]);
    }

    if (!Number.isFinite(minValue) || !Number.isFinite(maxValue)) {
        return [minClamp, maxClamp];
    }
    return [minValue, maxValue];
}

function resolveMetadataTileCount(tileCategories, authoredTileIds) {
    let maxTileId = CLUSTER_TREE_DEFAULT_TILE_COUNT - 1;
    for (const category of tileCategories) {
        const ranges = Array.isArray(category?.ranges) ? category.ranges : [];
        for (const range of ranges) {
            if (Number.isInteger(range?.[1])) {
                maxTileId = Math.max(maxTileId, range[1]);
            }
        }
    }
    for (const tileId of authoredTileIds) {
        if (Number.isInteger(tileId)) {
            maxTileId = Math.max(maxTileId, tileId);
        }
    }
    return maxTileId + 1;
}

function buildClusterTreeTileMetadata(worldAuthoring, tileCategories) {
    const biomes = Array.isArray(worldAuthoring?.biomes) ? worldAuthoring.biomes : [];
    const assetProfiles = Array.isArray(worldAuthoring?.assetProfiles) ? worldAuthoring.assetProfiles : [];
    const { weightsByBiomeId, treeProfileCount, maxWeight } = collectTreeProfileWeights(assetProfiles);
    const biomeEntries = [];
    const authoredTileIds = new Set();

    for (const biome of biomes) {
        const rawTreeWeight = weightsByBiomeId.get(biome?.id) ?? 0.0;
        if (!(rawTreeWeight > 0.0)) continue;
        const tileTypes = collectBiomeTileTypes([biome], tileCategories);
        if (tileTypes.length === 0) continue;
        for (const tileId of tileTypes) authoredTileIds.add(tileId);
        biomeEntries.push({
            biome,
            rawTreeWeight,
            tileTypes,
            hint: computeBiomeTreeProfileHint(biome, rawTreeWeight, maxWeight),
        });
    }

    const tileCount = resolveMetadataTileCount(tileCategories, authoredTileIds);
    const data = new Float32Array(tileCount * CLUSTER_TREE_METADATA_STRIDE_FLOATS);
    let authoredTileCount = 0;

    for (const entry of biomeEntries) {
        for (const tileId of entry.tileTypes) {
            if (!Number.isInteger(tileId) || tileId < 0 || tileId >= tileCount) continue;
            const offset = tileId * CLUSTER_TREE_METADATA_STRIDE_FLOATS;
            if (data[offset + 5] >= 0.5 && data[offset + 0] >= entry.hint.tileWeight) continue;
            if (data[offset + 5] < 0.5) authoredTileCount++;
            data[offset + 0] = entry.hint.tileWeight;
            data[offset + 1] = entry.hint.conifer;
            data[offset + 2] = entry.hint.foliage[0];
            data[offset + 3] = entry.hint.foliage[1];
            data[offset + 4] = entry.hint.foliage[2];
            data[offset + 5] = 1.0;
            data[offset + 6] = 0.0;
            data[offset + 7] = 0.0;
        }
    }

    return {
        data,
        tileCount,
        authoredTileCount,
        treeProfileCount,
    };
}

function scaleDensities(densities, scale) {
    if (!Array.isArray(densities)) return densities;
    return densities.map((value) => {
        const numeric = Number.isFinite(value) ? value : 0.0;
        return Math.max(0.0, numeric * scale);
    });
}

function applyVariantProfile(definition, profileRuntime) {
    definition.tileTypes = profileRuntime.tileTypes.slice();
    definition.climateRange = cloneValue(profileRuntime.climateRange);
    definition.elevationRange = profileRuntime.elevationRange.slice();
    definition.slopeRange = profileRuntime.slopeRange.slice();
    if (Array.isArray(definition.densities)) {
        definition.densities = scaleDensities(definition.densities, profileRuntime.densityScale);
    }
    const basePriority = Number.isFinite(definition.priority) ? definition.priority : 1.0;
    definition.priority = Math.max(0.05, basePriority * profileRuntime.priorityScale);
}

function applyFamilyProfile(definition, profileRuntime) {
    definition.tileTypes = profileRuntime.tileTypes.slice();
    definition.climateRange = cloneValue(profileRuntime.climateRange);
    definition.elevationRange = profileRuntime.elevationRange.slice();
    definition.slopeRange = {
        min: profileRuntime.slopeRange[0],
        max: profileRuntime.slopeRange[1],
    };
}

function buildProfileRuntime(profileGroup, biomeIndex, tileCategories) {
    const biomes = Array.from(profileGroup.biomeIds)
        .map((biomeId) => biomeIndex.get(biomeId) ?? null)
        .filter(Boolean);
    if (biomes.length === 0) {
        return null;
    }

    const tileTypes = collectBiomeTileTypes(biomes, tileCategories);
    if (tileTypes.length === 0) {
        return null;
    }

    const densityScale = Math.max(0.05, Math.min(2.5, profileGroup.densityWeight));
    const priorityScale = Math.max(0.1, Math.min(1.0, profileGroup.maxProbability));

    return {
        tileTypes,
        climateRange: {
            temperature: unionSignalRange(biomes, 'temperature', 0.0, 1.0),
            precipitation: unionSignalRange(biomes, 'humidity', 0.0, 1.0),
        },
        elevationRange: unionSignalRange(biomes, 'elevation', 0.0, 1.0),
        slopeRange: unionSignalRange(biomes, 'slope', 0.0, 1.0),
        densityScale,
        priorityScale,
    };
}

function buildProfileGroups(assetProfiles = []) {
    const groups = new Map();

    for (const profile of assetProfiles) {
        const archetypeRef = normalizeArchetypeRef(profile?.archetypeRef);
        if (!archetypeRef) continue;

        let group = groups.get(archetypeRef);
        if (!group) {
            group = {
                archetypeRef,
                biomeIds: new Set(),
                profileIds: [],
                densityWeight: 0.0,
                maxProbability: 0.0,
            };
            groups.set(archetypeRef, group);
        }

        group.profileIds.push(profile.id ?? archetypeRef);
        const biomeIds = Array.isArray(profile?.biomeIds) ? profile.biomeIds : [];
        for (const biomeId of biomeIds) {
            if (typeof biomeId === 'string' && biomeId) {
                group.biomeIds.add(biomeId);
            }
        }

        const density = Number.isFinite(profile?.density) ? profile.density : 0.5;
        const probability = Number.isFinite(profile?.probability) ? profile.probability : 0.5;
        group.densityWeight += Math.max(0.0, density) * Math.max(0.0, probability);
        group.maxProbability = Math.max(group.maxProbability, Math.max(0.0, probability));
    }

    return groups;
}

export function buildStreamerAuthoringRuntime(worldAuthoring = null, options = {}) {
    const baseAssetDefinitions = Array.isArray(options.assetDefinitions)
        ? options.assetDefinitions
        : [];
    const baseArchetypeDefinitions = options.archetypeDefinitions ?? {};
    const tileCategories = Array.isArray(options.tileCategories) ? options.tileCategories : [];

    const runtime = {
        assetDefinitions: cloneValue(baseAssetDefinitions),
        archetypeDefinitions: cloneValue(baseArchetypeDefinitions),
        clusterTreeTileMetadata: buildClusterTreeTileMetadata(worldAuthoring, tileCategories),
        summary: {
            profileCount: 0,
            appliedProfileCount: 0,
            unsupportedProfileCount: 0,
            clusterTreeAuthoredTileCount: 0,
        },
        warnings: {
            unsupportedArchetypeRefs: [],
        },
    };

    const assetProfiles = Array.isArray(worldAuthoring?.assetProfiles) ? worldAuthoring.assetProfiles : [];
    runtime.summary.profileCount = assetProfiles.length;
    runtime.summary.clusterTreeAuthoredTileCount = runtime.clusterTreeTileMetadata.authoredTileCount;
    if (assetProfiles.length === 0) {
        return runtime;
    }

    const biomeIndex = new Map();
    const biomes = Array.isArray(worldAuthoring?.biomes) ? worldAuthoring.biomes : [];
    for (const biome of biomes) {
        if (typeof biome?.id === 'string' && biome.id) {
            biomeIndex.set(biome.id, biome);
        }
    }

    const assetDefById = new Map(runtime.assetDefinitions.map((definition) => [definition.id, definition]));
    const families = Array.isArray(runtime.archetypeDefinitions?.families)
        ? runtime.archetypeDefinitions.families
        : [];
    const variants = Array.isArray(runtime.archetypeDefinitions?.variants)
        ? runtime.archetypeDefinitions.variants
        : [];
    const familyByName = new Map(families.map((definition) => [definition.name, definition]));
    const variantByName = new Map(variants.map((definition) => [definition.name, definition]));

    for (const group of buildProfileGroups(assetProfiles).values()) {
        const targets = ARCHETYPE_PROFILE_TARGETS[group.archetypeRef];
        if (!targets) {
            runtime.summary.unsupportedProfileCount += group.profileIds.length;
            runtime.warnings.unsupportedArchetypeRefs.push({
                archetypeRef: group.archetypeRef,
                profileIds: group.profileIds.slice(),
            });
            continue;
        }

        const profileRuntime = buildProfileRuntime(group, biomeIndex, tileCategories);
        if (!profileRuntime) {
            continue;
        }

        for (const assetId of targets.legacyAssetIds) {
            const definition = assetDefById.get(assetId);
            if (definition) {
                applyVariantProfile(definition, profileRuntime);
            } else {
                Logger.warn(
                    `[AssetAuthoring] Missing legacy asset definition "${assetId}" ` +
                    `for archetypeRef "${group.archetypeRef}"`
                );
            }
        }
        for (const familyName of targets.familyNames) {
            const definition = familyByName.get(familyName);
            if (definition) {
                applyFamilyProfile(definition, profileRuntime);
            } else {
                Logger.warn(
                    `[AssetAuthoring] Missing streamer family "${familyName}" ` +
                    `for archetypeRef "${group.archetypeRef}"`
                );
            }
        }
        for (const variantName of targets.variantNames) {
            const definition = variantByName.get(variantName);
            if (definition) {
                applyVariantProfile(definition, profileRuntime);
            } else {
                Logger.warn(
                    `[AssetAuthoring] Missing streamer variant "${variantName}" ` +
                    `for archetypeRef "${group.archetypeRef}"`
                );
            }
        }

        runtime.summary.appliedProfileCount += group.profileIds.length;
    }

    return runtime;
}
