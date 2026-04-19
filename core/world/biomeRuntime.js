import { computeBiomeTreeWeights } from './biomeAuthoringDerived.js';
import { buildTileCatalogRuntime } from './tileCatalogRuntime.js';
import { MAX_TILE_ID } from './tileCatalogUtils.js';

const DEFAULT_BIOME_FALLBACK_TILE_ID = 10;
const BIOME_FALLBACK_TILE_NAMES = Object.freeze([
    'GRASS_SHORT_1',
    'GRASS_MEDIUM_1',
    'GRASS_TALL_1',
]);
const BIOME_FALLBACK_CATEGORY_NAMES = Object.freeze([
    'GRASS',
    'FOREST',
    'DESERT',
    'SNOW',
    'ROCK',
    'SAND',
    'TUNDRA',
    'DIRT',
    'MUD',
    'SWAMP',
    'VOLCANIC',
    'WATER',
]);

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

const VALID_NOISE_TYPES = new Set(['simplex', 'perlin', 'fbm', 'ridged_fbm']);
const MAX_BIOME_BASE_WEIGHT = 16.0;
export const GPU_BIOME_SIGNAL_RULE_SIZE_BYTES = 32;
export const GPU_BIOME_DEF_SIZE_BYTES = 160;
export const GPU_BIOME_UNIFORM_HEADER_BYTES = 16;

export function createDefaultWorldAuthoringRuntime() {
    return {
        biomes: [],
        biomeIds: [],
        biomeIndexById: {},
        assetProfiles: [],
        summary: {
            biomeCount: 0,
            assetProfileCount: 0,
            tileCatalogTileCount: 0,
            tileCatalogCategoryCount: 0,
            unresolvedTileRefCount: 0,
            unknownAssetBiomeRefCount: 0,
            tileCatalogWarningCount: 0,
        },
        warnings: {
            unresolvedTileRefs: [],
            unknownAssetBiomeRefs: [],
            tileCatalog: buildTileCatalogRuntime().warnings,
        },
        tileCatalog: buildTileCatalogRuntime(),
    };
}

function encodePreference(preference) {
    switch (preference) {
        case 'low':
            return 0.0;
        case 'high':
            return 1.0;
        case 'mid':
        default:
            return 0.5;
    }
}

function encodeNoiseType(noiseType) {
    switch (noiseType) {
        case 'perlin':
            return 1;
        case 'fbm':
            return 2;
        case 'ridged_fbm':
            return 3;
        case 'simplex':
        default:
            return 0;
    }
}

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

function normalizeSignalRule(rule = {}, fallback = DEFAULT_SIGNAL_RULES.elevation, bounds = {}) {
    const minValue = clampNumber(rule.min, fallback.min, bounds.min, bounds.max);
    const maxValue = clampNumber(rule.max, fallback.max, bounds.min, bounds.max);
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

function normalizeRegionalVariation(regionalVariation = {}, biomeId = 'unknown') {
    const requestedNoiseType = typeof regionalVariation.noiseType === 'string'
        ? regionalVariation.noiseType.trim().toLowerCase()
        : '';
    const noiseType = VALID_NOISE_TYPES.has(requestedNoiseType)
        ? requestedNoiseType
        : DEFAULT_REGIONAL_VARIATION.noiseType;
    if (requestedNoiseType && !VALID_NOISE_TYPES.has(requestedNoiseType)) {
        console.warn(
            `[BiomeRuntime] Biome "${biomeId}" requested unknown noise type ` +
            `"${regionalVariation.noiseType}". Falling back to "${DEFAULT_REGIONAL_VARIATION.noiseType}".`
        );
    }

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

function isValidTileId(value) {
    return Number.isInteger(value) && value >= 0 && value <= MAX_TILE_ID;
}

function firstTileIdForCategory(tileCatalog, categoryName) {
    const categories = Array.isArray(tileCatalog?.tileCategories) ? tileCatalog.tileCategories : [];
    for (const category of categories) {
        if (category?.name !== categoryName) continue;
        const ranges = Array.isArray(category.ranges) ? category.ranges : [];
        for (const range of ranges) {
            const tileId = Array.isArray(range) ? range[0] : null;
            if (isValidTileId(tileId)) return tileId;
        }
    }
    return null;
}

function firstCatalogTileId(tileCatalog) {
    const tiles = Array.isArray(tileCatalog?.tiles) ? tileCatalog.tiles : [];
    for (const tile of tiles) {
        if (isValidTileId(tile?.id)) return tile.id;
    }
    return null;
}

function resolveBiomeFallbackTileId(worldAuthoring = {}, options = {}) {
    if (isValidTileId(options.fallbackTileId)) {
        return options.fallbackTileId;
    }

    const tileCatalog = worldAuthoring?.tileCatalog;
    const tileTypes = tileCatalog?.tileTypes && typeof tileCatalog.tileTypes === 'object'
        ? tileCatalog.tileTypes
        : {};
    for (const tileName of BIOME_FALLBACK_TILE_NAMES) {
        const tileId = tileTypes[tileName];
        if (isValidTileId(tileId)) return tileId;
    }
    for (const categoryName of BIOME_FALLBACK_CATEGORY_NAMES) {
        const tileId = firstTileIdForCategory(tileCatalog, categoryName);
        if (isValidTileId(tileId)) return tileId;
    }

    return firstCatalogTileId(tileCatalog) ?? DEFAULT_BIOME_FALLBACK_TILE_ID;
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
            baseWeight: clampNumber(biome.baseWeight, 1.0, 0.0, MAX_BIOME_BASE_WEIGHT),
            tileRef: {
                micro: microTileName,
                macro: macroTileName,
            },
            tileIds: {
                micro: microTileId,
                macro: macroTileId,
            },
            signals: {
                elevation: normalizeSignalRule(
                    biome?.signals?.elevation,
                    DEFAULT_SIGNAL_RULES.elevation,
                    { min: -Infinity, max: Infinity }
                ),
                humidity: normalizeSignalRule(
                    biome?.signals?.humidity,
                    DEFAULT_SIGNAL_RULES.humidity,
                    { min: 0.0, max: 1.0 }
                ),
                temperature: normalizeSignalRule(
                    biome?.signals?.temperature,
                    DEFAULT_SIGNAL_RULES.temperature,
                    { min: 0.0, max: 1.0 }
                ),
                slope: normalizeSignalRule(
                    biome?.signals?.slope,
                    DEFAULT_SIGNAL_RULES.slope,
                    { min: 0.0, max: 1.0 }
                ),
            },
            regionalVariation: normalizeRegionalVariation(biome.regionalVariation, biomeId),
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
            density: clampNumber(profile.density, 0.5, 0.0, MAX_BIOME_BASE_WEIGHT),
            probability: clampNumber(profile.probability, 0.5, 0.0, 1.0),
            variation: clampNumber(profile.variation, 0.3, 0.0, 1.0),
        });
    }

    return { profiles, unknownBiomeRefs };
}

export function buildWorldAuthoringRuntime(rawBiomeDocument = {}, rawAssetDocument = {}, options = {}) {
    let tileCatalog = buildTileCatalogRuntime(
        rawBiomeDocument?.tileCatalog,
        { fallbackDocument: options.tileCatalog }
    );
    if (!(tileCatalog.summary?.tileCount > 0) && options.tileTypes && typeof options.tileTypes === 'object') {
        tileCatalog = {
            ...tileCatalog,
            tileTypes: options.tileTypes,
            tileNameById: Object.fromEntries(
                Object.entries(options.tileTypes)
                    .filter(([, id]) => Number.isInteger(id))
                    .map(([name, id]) => [id, name])
            ),
        };
    }
    const tileTypes = tileCatalog.tileTypes ?? {};
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
            tileCatalogTileCount: tileCatalog.summary?.tileCount ?? 0,
            tileCatalogCategoryCount: tileCatalog.summary?.categoryCount ?? 0,
            unresolvedTileRefCount: biomeConfig.unresolvedTileRefs.length,
            unknownAssetBiomeRefCount: assetConfig.unknownBiomeRefs.length,
            tileCatalogWarningCount: tileCatalog.summary?.warningCount ?? 0,
        },
        warnings: {
            unresolvedTileRefs: biomeConfig.unresolvedTileRefs,
            unknownAssetBiomeRefs: assetConfig.unknownBiomeRefs,
            tileCatalog: tileCatalog.warnings,
        },
        tileCatalog,
    };
}

export function getPackedBiomeUniformByteSize(maxBiomes = 16) {
    return GPU_BIOME_UNIFORM_HEADER_BYTES + GPU_BIOME_DEF_SIZE_BYTES * Math.max(0, Math.trunc(maxBiomes));
}

export function packBiomeUniformData(worldAuthoring = createDefaultWorldAuthoringRuntime(), worldSeed = 0, options = {}) {
    const maxBiomes = Math.max(0, Math.trunc(options.maxBiomes ?? 16));
    const fallbackTileId = resolveBiomeFallbackTileId(worldAuthoring, options);
    const sourceBiomes = Array.isArray(worldAuthoring?.biomes) ? worldAuthoring.biomes : [];
    const treeWeightsByBiomeId = computeBiomeTreeWeights(
        sourceBiomes,
        Array.isArray(worldAuthoring?.assetProfiles) ? worldAuthoring.assetProfiles : []
    );
    const biomeCount = Math.min(sourceBiomes.length, maxBiomes);
    const data = new ArrayBuffer(getPackedBiomeUniformByteSize(maxBiomes));
    const view = new DataView(data);

    view.setUint32(0, biomeCount >>> 0, true);
    view.setUint32(4, (Number.isInteger(worldSeed) ? worldSeed : 0) >>> 0, true);
    view.setUint32(8, 0, true);
    view.setUint32(12, 0, true);

    for (let index = 0; index < biomeCount; index++) {
        const biome = sourceBiomes[index] ?? {};
        const biomeOffset = GPU_BIOME_UNIFORM_HEADER_BYTES + index * GPU_BIOME_DEF_SIZE_BYTES;
        const tileId = Number.isInteger(biome?.tileIds?.micro) ? biome.tileIds.micro : fallbackTileId;
        const regionalVariation = biome.regionalVariation ?? {};
        const treeWeight = treeWeightsByBiomeId.get(biome.id) ?? 0.0;

        view.setFloat32(biomeOffset + 0, clampNumber(biome.baseWeight, 1.0, 0.0, MAX_BIOME_BASE_WEIGHT), true);
        view.setUint32(biomeOffset + 4, tileId >>> 0, true);
        view.setUint32(biomeOffset + 8, encodeNoiseType(regionalVariation.noiseType), true);
        view.setFloat32(biomeOffset + 12, clampNumber(regionalVariation.noiseScale, DEFAULT_REGIONAL_VARIATION.noiseScale, 0.0, 1.0), true);
        view.setFloat32(biomeOffset + 16, clampNumber(regionalVariation.noiseStrength, DEFAULT_REGIONAL_VARIATION.noiseStrength, 0.0, 1.0), true);
        view.setUint32(biomeOffset + 20, Math.trunc(clampNumber(regionalVariation.seedOffset, 0, 0, 0x7fffffff)) >>> 0, true);
        view.setFloat32(biomeOffset + 24, treeWeight, true);
        view.setFloat32(biomeOffset + 28, 0.0, true);

        writeSignalRule(view, biomeOffset + 32, biome?.signals?.elevation, DEFAULT_SIGNAL_RULES.elevation);
        writeSignalRule(view, biomeOffset + 64, biome?.signals?.humidity, DEFAULT_SIGNAL_RULES.humidity);
        writeSignalRule(view, biomeOffset + 96, biome?.signals?.temperature, DEFAULT_SIGNAL_RULES.temperature);
        writeSignalRule(view, biomeOffset + 128, biome?.signals?.slope, DEFAULT_SIGNAL_RULES.slope);
    }

    return {
        data,
        biomeCount,
        maxBiomes,
        fallbackTileId,
        truncatedBiomeCount: Math.max(0, sourceBiomes.length - biomeCount),
        biomeIds: sourceBiomes.slice(0, biomeCount).map((biome) => biome.id ?? 'unknown'),
        treeWeightedBiomeCount: sourceBiomes
            .slice(0, biomeCount)
            .filter((biome) => (treeWeightsByBiomeId.get(biome.id) ?? 0.0) > 0.0)
            .length,
    };
}

function writeSignalRule(view, offset, rule = {}, fallback = DEFAULT_SIGNAL_RULES.elevation) {
    const normalizedRule = {
        min: Number.isFinite(rule.min) ? rule.min : fallback.min,
        max: Number.isFinite(rule.max) ? rule.max : fallback.max,
        transitionWidth: clampNumber(rule.transitionWidth, fallback.transitionWidth, 0.001, 1.0),
        preference: normalizePreference(rule.preference ?? fallback.preference),
        ditherScale: clampNumber(rule.ditherScale, fallback.ditherScale, 0.0, 1.0),
        ditherStrength: clampNumber(rule.ditherStrength, fallback.ditherStrength, 0.0, 1.0),
        weight: clampNumber(rule.weight, fallback.weight, 0.0, 4.0),
    };

    view.setFloat32(offset + 0, normalizedRule.min, true);
    view.setFloat32(offset + 4, normalizedRule.max, true);
    view.setFloat32(offset + 8, normalizedRule.transitionWidth, true);
    view.setFloat32(offset + 12, encodePreference(normalizedRule.preference), true);
    view.setFloat32(offset + 16, normalizedRule.ditherScale, true);
    view.setFloat32(offset + 20, normalizedRule.ditherStrength, true);
    view.setFloat32(offset + 24, normalizedRule.weight, true);
    view.setFloat32(offset + 28, 0.0, true);
}
