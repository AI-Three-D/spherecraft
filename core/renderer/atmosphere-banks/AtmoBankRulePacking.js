import {
    ATMO_SCATTER_RULE_CAPACITY,
    ATMO_SCATTER_RULE_STRIDE,
} from './AtmoBankTypes.js';

export const ATMO_SCATTER_RULE_FLAGS = Object.freeze({
    HAS_TILE_CATEGORIES: 1 << 0,
    HAS_ELEVATION: 1 << 1,
    HAS_SLOPE: 1 << 2,
    HAS_TERRAIN_SHAPE: 1 << 3,
});

export const ATMO_TERRAIN_SHAPE_KIND = Object.freeze({
    NONE: 0,
    DEPRESSION: 1,
    HIGHLAND: 2,
});

const FLOATS_PER_RULE = ATMO_SCATTER_RULE_STRIDE / 4;

function normalizeName(value) {
    if (typeof value !== 'string') return '';
    return value.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
}

function categorySignature(tileCategories = []) {
    if (!Array.isArray(tileCategories) || tileCategories.length === 0) return '';
    return tileCategories
        .map((category) => {
            const ranges = Array.isArray(category?.ranges)
                ? category.ranges.map((range) => Array.isArray(range) ? `${range[0]}-${range[1]}` : '').join(',')
                : '';
            return `${category?.id ?? ''}:${normalizeName(category?.name)}:${ranges}`;
        })
        .join('|');
}

function buildCategoryIndex(tileCategories = []) {
    const byName = new Map();
    const byTileId = new Map();
    for (const category of Array.isArray(tileCategories) ? tileCategories : []) {
        const id = Number.isInteger(category?.id) ? category.id : null;
        if (id == null) continue;
        const name = normalizeName(category?.name);
        if (name) byName.set(name, id);
        for (const range of Array.isArray(category.ranges) ? category.ranges : []) {
            if (!Array.isArray(range) || range.length < 2) continue;
            const lo = Math.trunc(Number(range[0]));
            const hi = Math.trunc(Number(range[1]));
            if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
            for (let tileId = Math.min(lo, hi); tileId <= Math.max(lo, hi); tileId++) {
                byTileId.set(tileId, id);
            }
        }
    }
    return { byName, byTileId };
}

function categoryMaskForNames(names = [], categoryIndex, warnings, ruleId, field) {
    let mask = 0;
    let count = 0;
    let unresolved = 0;
    for (const rawName of Array.isArray(names) ? names : []) {
        const name = normalizeName(rawName);
        if (!name) continue;
        const categoryId = categoryIndex.byName.get(name);
        if (!Number.isInteger(categoryId)) {
            warnings.unknownCategories.push({ ruleId, field, name });
            unresolved++;
            continue;
        }
        if (categoryId < 0 || categoryId >= 32) {
            warnings.categoryMaskOverflow.push({ ruleId, field, name, categoryId });
            unresolved++;
            continue;
        }
        mask |= (1 << categoryId) >>> 0;
        count++;
    }
    return { mask: mask >>> 0, count, unresolved };
}

function categoryMaskForBiomeRefs(rule, biomeDefinitions, categoryIndex, warnings, ruleId) {
    const biomeIds = new Set(Array.isArray(rule?.biomeIds) ? rule.biomeIds : []);
    const biomeTags = new Set(Array.isArray(rule?.biomeTags) ? rule.biomeTags : []);
    if (biomeIds.size === 0 && biomeTags.size === 0) {
        return { mask: 0, count: 0, unresolved: 0 };
    }

    let mask = 0;
    let count = 0;
    let unresolved = 0;
    for (const biome of Array.isArray(biomeDefinitions) ? biomeDefinitions : []) {
        const idMatches = biomeIds.has(biome?.id);
        const tags = Array.isArray(biome?.tags) ? biome.tags : [];
        const tagMatches = tags.some((tag) => biomeTags.has(tag));
        if (!idMatches && !tagMatches) continue;

        const tileId = Number.isInteger(biome?.tileIds?.micro)
            ? biome.tileIds.micro
            : biome?.tileIds?.macro;
        const categoryId = categoryIndex.byTileId.get(tileId);
        if (!Number.isInteger(categoryId)) {
            warnings.unresolvedBiomeRefs.push({ ruleId, biomeId: biome?.id ?? null, tileId });
            unresolved++;
            continue;
        }
        if (categoryId < 0 || categoryId >= 32) {
            warnings.categoryMaskOverflow.push({ ruleId, field: 'biomeRefs', biomeId: biome?.id ?? null, categoryId });
            unresolved++;
            continue;
        }
        mask |= (1 << categoryId) >>> 0;
        count++;
    }

    if (count === 0) {
        warnings.unresolvedBiomeRefs.push({
            ruleId,
            biomeIds: Array.from(biomeIds),
            biomeTags: Array.from(biomeTags),
        });
        unresolved++;
    }

    return { mask: mask >>> 0, count, unresolved };
}

function normalizeShape(rule) {
    const shape = rule?.terrainShape;
    if (!shape || typeof shape !== 'object') {
        return {
            kind: ATMO_TERRAIN_SHAPE_KIND.NONE,
            radiusTexels: 1,
            param0: 0,
            param1: 1,
        };
    }

    const kind = typeof shape.kind === 'string' ? shape.kind.trim().toLowerCase() : '';
    if (kind === 'depression' || kind === 'valley' || kind === 'crevice') {
        return {
            kind: ATMO_TERRAIN_SHAPE_KIND.DEPRESSION,
            radiusTexels: Math.max(1, Math.min(16, Math.trunc(Number(shape.neighborRadiusTexels) || 3))),
            param0: Number.isFinite(shape.minDepthMeters) ? shape.minDepthMeters : 3,
            param1: Number.isFinite(shape.maxDepthMeters) ? shape.maxDepthMeters : 10,
        };
    }
    if (kind === 'highland' || kind === 'peak' || kind === 'mountain_peak') {
        return {
            kind: ATMO_TERRAIN_SHAPE_KIND.HIGHLAND,
            radiusTexels: 1,
            param0: Number.isFinite(shape.minElevationNormalized) ? shape.minElevationNormalized : 0.55,
            param1: Number.isFinite(shape.fadeElevationNormalized) ? shape.fadeElevationNormalized : 0.2,
        };
    }

    return {
        kind: ATMO_TERRAIN_SHAPE_KIND.NONE,
        radiusTexels: 1,
        param0: 0,
        param1: 1,
    };
}

function signalBand(rule, key, fallbackMin, fallbackMax) {
    const band = rule?.[key];
    if (!band || typeof band !== 'object') {
        return { enabled: false, min: fallbackMin, max: fallbackMax };
    }
    const min = Number.isFinite(band.min) ? band.min : fallbackMin;
    const max = Number.isFinite(band.max) ? band.max : fallbackMax;
    return {
        enabled: true,
        min: Math.min(min, max),
        max: Math.max(min, max),
    };
}

export function getAtmoScatterRuleCategorySignature(tileCategories = []) {
    return categorySignature(tileCategories);
}

export function packAtmoScatterRules(scatterRules = [], options = {}) {
    const tileCategories = Array.isArray(options.tileCategories) ? options.tileCategories : [];
    const biomeDefinitions = Array.isArray(options.biomeDefinitions) ? options.biomeDefinitions : [];
    const categoryIndex = buildCategoryIndex(tileCategories);
    const data = new Float32Array(ATMO_SCATTER_RULE_CAPACITY * FLOATS_PER_RULE);
    const dataU32 = new Uint32Array(data.buffer);
    const warnings = {
        droppedRules: [],
        unknownCategories: [],
        categoryMaskOverflow: [],
        unresolvedBiomeRefs: [],
    };

    let count = 0;
    for (let sourceIndex = 0; sourceIndex < scatterRules.length; sourceIndex++) {
        const rule = scatterRules[sourceIndex];
        if (!rule || rule.enabled === false) continue;
        if (count >= ATMO_SCATTER_RULE_CAPACITY) {
            warnings.droppedRules.push({ ruleId: rule.id ?? `rule_${sourceIndex}`, reason: 'capacity' });
            continue;
        }

        const ruleId = rule.id ?? `rule_${sourceIndex}`;
        const includeMask = categoryMaskForNames(rule.tileCategories, categoryIndex, warnings, ruleId, 'tileCategories');
        const biomeMask = categoryMaskForBiomeRefs(rule, biomeDefinitions, categoryIndex, warnings, ruleId);
        const excludeMask = categoryMaskForNames(rule.excludeTileCategories, categoryIndex, warnings, ruleId, 'excludeTileCategories');
        const elevation = signalBand(rule, 'elevation', 0, 1);
        const slope = signalBand(rule, 'slope', 0, 1);
        const shape = normalizeShape(rule);
        const requestedIncludeFilters =
            (Array.isArray(rule.tileCategories) ? rule.tileCategories.length : 0) +
            (Array.isArray(rule.biomeIds) ? rule.biomeIds.length : 0) +
            (Array.isArray(rule.biomeTags) ? rule.biomeTags.length : 0);
        if (
            (requestedIncludeFilters > 0 && (includeMask.count + biomeMask.count) === 0) ||
            includeMask.unresolved > 0 ||
            biomeMask.unresolved > 0 ||
            excludeMask.unresolved > 0
        ) {
            warnings.droppedRules.push({ ruleId, reason: 'unresolved-category-filter' });
            continue;
        }

        let flags = 0;
        const tileCategoryMask = (includeMask.mask | biomeMask.mask) >>> 0;
        if ((includeMask.count + biomeMask.count) > 0) flags |= ATMO_SCATTER_RULE_FLAGS.HAS_TILE_CATEGORIES;
        if (elevation.enabled) flags |= ATMO_SCATTER_RULE_FLAGS.HAS_ELEVATION;
        if (slope.enabled) flags |= ATMO_SCATTER_RULE_FLAGS.HAS_SLOPE;
        if (shape.kind !== ATMO_TERRAIN_SHAPE_KIND.NONE) flags |= ATMO_SCATTER_RULE_FLAGS.HAS_TERRAIN_SHAPE;

        const base = count * FLOATS_PER_RULE;
        dataU32[base + 0] = (rule.typeId ?? 0) >>> 0;
        dataU32[base + 1] = flags >>> 0;
        dataU32[base + 2] = tileCategoryMask >>> 0;
        dataU32[base + 3] = excludeMask.mask >>> 0;
        dataU32[base + 4] = Math.max(0, Math.trunc(rule.spawnBudget ?? 3)) >>> 0;
        dataU32[base + 5] = shape.kind >>> 0;
        dataU32[base + 6] = shape.radiusTexels >>> 0;
        dataU32[base + 7] = 0;
        data[base + 8] = Number.isFinite(rule.probability) ? rule.probability : 0.25;
        data[base + 9] = Number.isFinite(rule.weatherWeight) ? rule.weatherWeight : 1;
        data[base + 10] = Number.isFinite(rule.fogWeight) ? rule.fogWeight : 1;
        data[base + 11] = 0;
        data[base + 12] = elevation.min;
        data[base + 13] = elevation.max;
        data[base + 14] = slope.min;
        data[base + 15] = slope.max;
        data[base + 16] = shape.param0;
        data[base + 17] = shape.param1;
        data[base + 18] = 0;
        data[base + 19] = 0;
        count++;
    }

    return {
        data,
        count,
        capacity: ATMO_SCATTER_RULE_CAPACITY,
        strideBytes: ATMO_SCATTER_RULE_STRIDE,
        tileCategoryCount: tileCategories.length,
        warnings,
    };
}
