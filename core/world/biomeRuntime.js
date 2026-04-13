const DEFAULT_SIGNAL_RULES = Object.freeze({
    elevation: Object.freeze({
        min: 0.0,
        max: 1.0,
        transitionWidth: 0.1,
        preference: 'mid',
        ditherScale: 0.02,
        ditherStrength: 0.1,
        weight: 0.25,
    }),
    humidity: Object.freeze({
        min: 0.0,
        max: 1.0,
        transitionWidth: 0.1,
        preference: 'mid',
        ditherScale: 0.015,
        ditherStrength: 0.08,
        weight: 0.25,
    }),
    temperature: Object.freeze({
        min: 0.0,
        max: 1.0,
        transitionWidth: 0.08,
        preference: 'mid',
        ditherScale: 0.02,
        ditherStrength: 0.06,
        weight: 0.25,
    }),
    slope: Object.freeze({
        min: 0.0,
        max: 0.7,
        transitionWidth: 0.1,
        preference: 'low',
        ditherScale: 0.01,
        ditherStrength: 0.05,
        weight: 0.25,
    }),
});

const DEFAULT_REGIONAL_VARIATION = Object.freeze({
    noiseType: 'simplex',
    noiseScale: 0.001,
    noiseStrength: 0.15,
    seedOffset: 0,
});

function clampNumber(value, fallback, min = -Infinity, max = Infinity) {
    const numeric = Number.isFinite(value) ? value : fallback;
    return Math.max(min, Math.min(max, numeric));
}

function normalizePreference(value) {
    switch (value) {
        case 'low':
        case 'mid':
        case 'high':
            return value;
        default:
            return 'mid';
    }
}

function normalizeSignalRule(rule = {}, fallback = DEFAULT_SIGNAL_RULES.elevation) {
    const minValue = clampNumber(rule.min, fallback.min, 0.0, 1.0);
    const maxValue = clampNumber(rule.max, fallback.max, 0.0, 1.0);
    const orderedMin = Math.min(minValue, maxValue);
    const orderedMax = Math.max(minValue, maxValue);

    return {
        min: orderedMin,
        max: orderedMax,
        transitionWidth: clampNumber(rule.transitionWidth, fallback.transitionWidth, 0.001, 1.0),
        preference: normalizePreference(rule.preference ?? fallback.preference),
        ditherScale: clampNumber(rule.ditherScale, fallback.ditherScale, 0.0, 1.0),
        ditherStrength: clampNumber(rule.ditherStrength, fallback.ditherStrength, 0.0, 1.0),
        weight: clampNumber(rule.weight, fallback.weight, 0.0, 4.0),
    };
}

function normalizeRegionalVariation(regionalVariation = {}) {
    const noiseType = typeof regionalVariation.noiseType === 'string'
        ? regionalVariation.noiseType
        : DEFAULT_REGIONAL_VARIATION.noiseType;

    return {
        noiseType,
        noiseScale: clampNumber(regionalVariation.noiseScale, DEFAULT_REGIONAL_VARIATION.noiseScale, 0.0, 1.0),
        noiseStrength: clampNumber(regionalVariation.noiseStrength, DEFAULT_REGIONAL_VARIATION.noiseStrength, 0.0, 1.0),
        seedOffset: Math.trunc(clampNumber(regionalVariation.seedOffset, DEFAULT_REGIONAL_VARIATION.seedOffset, 0, 0x7fffffff)),
    };
}

function resolveTileId(tileTypes, tileName) {
    if (typeof tileName !== 'string') return null;
    const trimmed = tileName.trim();
    if (!trimmed) return null;
    return Number.isInteger(tileTypes?.[trimmed]) ? tileTypes[trimmed] : null;
}

function pushTileWarning(target, biomeId, layerKey, tileName) {
    target.push({
        biomeId,
        layer: layerKey,
        tileName: typeof tileName === 'string' ? tileName : null,
    });
}

function normalizeBiomeDefinitions(rawBiomeDocument = {}, tileTypes = {}) {
    const source = Array.isArray(rawBiomeDocument?.biomes) ? rawBiomeDocument.biomes : [];
    const unresolvedTileRefs = [];
    const seenBiomeIds = new Set();
    const biomes = [];

    for (let index = 0; index < source.length; index++) {
        const biome = source[index] ?? {};
        const fallbackId = `biome_${index + 1}`;
        const rawId = typeof biome.id === 'string' ? biome.id.trim() : '';
        const biomeId = rawId && !seenBiomeIds.has(rawId) ? rawId : `${fallbackId}_${index}`;
        seenBiomeIds.add(biomeId);

        const microTileName = typeof biome?.tileRef?.micro === 'string'
            ? biome.tileRef.micro.trim()
            : 'GRASS_SHORT_1';
        const macroTileName = typeof biome?.tileRef?.macro === 'string'
            ? biome.tileRef.macro.trim()
            : microTileName;

        const microTileId = resolveTileId(tileTypes, microTileName);
        const macroTileId = resolveTileId(tileTypes, macroTileName);
        if (microTileId == null) pushTileWarning(unresolvedTileRefs, biomeId, 'micro', microTileName);
        if (macroTileId == null) pushTileWarning(unresolvedTileRefs, biomeId, 'macro', macroTileName);

        biomes.push({
            id: biomeId,
            displayName: typeof biome.displayName === 'string' && biome.displayName.trim()
                ? biome.displayName.trim()
                : biomeId,
            tags: Array.isArray(biome.tags)
                ? biome.tags.filter((tag) => typeof tag === 'string' && tag.trim()).map((tag) => tag.trim())
                : [],
            baseWeight: clampNumber(biome.baseWeight, 1.0, 0.0, 16.0),
            tileRef: {
                micro: microTileName,
                macro: macroTileName,
            },
            tileIds: {
                micro: microTileId,
                macro: macroTileId,
            },
            signals: {
                elevation: normalizeSignalRule(biome?.signals?.elevation, DEFAULT_SIGNAL_RULES.elevation),
                humidity: normalizeSignalRule(biome?.signals?.humidity, DEFAULT_SIGNAL_RULES.humidity),
                temperature: normalizeSignalRule(biome?.signals?.temperature, DEFAULT_SIGNAL_RULES.temperature),
                slope: normalizeSignalRule(biome?.signals?.slope, DEFAULT_SIGNAL_RULES.slope),
            },
            regionalVariation: normalizeRegionalVariation(biome.regionalVariation),
        });
    }

    return { biomes, unresolvedTileRefs };
}

function normalizeAssetProfiles(rawAssetDocument = {}, biomeIds = []) {
    const source = Array.isArray(rawAssetDocument?.profiles) ? rawAssetDocument.profiles : [];
    const knownBiomeIds = new Set(biomeIds);
    const unknownBiomeRefs = [];
    const seenProfileIds = new Set();
    const profiles = [];

    for (let index = 0; index < source.length; index++) {
        const profile = source[index] ?? {};
        const fallbackId = `profile_${index + 1}`;
        const rawId = typeof profile.id === 'string' ? profile.id.trim() : '';
        const profileId = rawId && !seenProfileIds.has(rawId) ? rawId : `${fallbackId}_${index}`;
        seenProfileIds.add(profileId);

        const requestedBiomeIds = Array.isArray(profile.biomeIds)
            ? profile.biomeIds.filter((biomeId) => typeof biomeId === 'string' && biomeId.trim()).map((biomeId) => biomeId.trim())
            : [];
        const normalizedBiomeIds = [];
        for (const biomeId of requestedBiomeIds) {
            if (knownBiomeIds.has(biomeId)) {
                normalizedBiomeIds.push(biomeId);
            } else {
                unknownBiomeRefs.push({ profileId, biomeId });
            }
        }

        profiles.push({
            id: profileId,
            displayName: typeof profile.displayName === 'string' && profile.displayName.trim()
                ? profile.displayName.trim()
                : profileId,
            biomeIds: normalizedBiomeIds,
            archetypeRef: typeof profile.archetypeRef === 'string' ? profile.archetypeRef.trim() : '',
            density: clampNumber(profile.density, 0.5, 0.0, 16.0),
            probability: clampNumber(profile.probability, 0.5, 0.0, 1.0),
            variation: clampNumber(profile.variation, 0.3, 0.0, 1.0),
        });
    }

    return { profiles, unknownBiomeRefs };
}

export function buildWorldAuthoringRuntime(rawBiomeDocument = {}, rawAssetDocument = {}, options = {}) {
    const tileTypes = options.tileTypes ?? {};
    const biomeConfig = normalizeBiomeDefinitions(rawBiomeDocument, tileTypes);
    const assetConfig = normalizeAssetProfiles(
        rawAssetDocument,
        biomeConfig.biomes.map((biome) => biome.id)
    );

    const biomeIndexById = {};
    for (let index = 0; index < biomeConfig.biomes.length; index++) {
        biomeIndexById[biomeConfig.biomes[index].id] = index;
    }

    return {
        biomes: biomeConfig.biomes,
        biomeIds: biomeConfig.biomes.map((biome) => biome.id),
        biomeIndexById,
        assetProfiles: assetConfig.profiles,
        summary: {
            biomeCount: biomeConfig.biomes.length,
            assetProfileCount: assetConfig.profiles.length,
            unresolvedTileRefCount: biomeConfig.unresolvedTileRefs.length,
            unknownAssetBiomeRefCount: assetConfig.unknownBiomeRefs.length,
        },
        warnings: {
            unresolvedTileRefs: biomeConfig.unresolvedTileRefs,
            unknownAssetBiomeRefs: assetConfig.unknownBiomeRefs,
        },
    };
}
