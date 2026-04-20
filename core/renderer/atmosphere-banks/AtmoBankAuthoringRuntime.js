import { ATMO_BANK_TYPES, ATMO_TYPE_CAPACITY } from './AtmoBankTypes.js';

export const DEFAULT_ATMO_BANK_CONFIG = Object.freeze({
    [ATMO_BANK_TYPES.VALLEY_MIST]: Object.freeze({
        id: 'valley_mist',
        type: 'VALLEY_MIST',
        displayName: 'Valley Mist',
        noiseScale: 0.008,
        noiseSpeed: 0.02,
        densityBase: 0.72,
        windResponse: 0.1,
        lifetime: Object.freeze({ min: 60, max: 120 }),
        size: Object.freeze({ min: 28, max: 260 }),
        color: Object.freeze([0.75, 0.78, 0.82, 0.40]),
        fadeNearStart: 20.0,
        fadeFarStart: 1200.0,
        fadeFarEnd: 2000.0,
        densityThreshold: 0.26,
    }),
    [ATMO_BANK_TYPES.FOG_POCKET]: Object.freeze({
        id: 'fog_pocket',
        type: 'FOG_POCKET',
        displayName: 'Fog Pocket',
        noiseScale: 0.02,
        noiseSpeed: 0.04,
        densityBase: 0.82,
        windResponse: 0.15,
        lifetime: Object.freeze({ min: 30, max: 80 }),
        size: Object.freeze({ min: 16, max: 210 }),
        color: Object.freeze([0.72, 0.75, 0.80, 0.44]),
        fadeNearStart: 10.0,
        fadeFarStart: 800.0,
        fadeFarEnd: 1500.0,
        densityThreshold: 0.24,
    }),
    [ATMO_BANK_TYPES.LOW_CLOUD]: Object.freeze({
        id: 'low_cloud',
        type: 'LOW_CLOUD',
        displayName: 'Low Cloud',
        noiseScale: 0.006,
        noiseSpeed: 0.015,
        densityBase: 0.62,
        windResponse: 0.3,
        lifetime: Object.freeze({ min: 90, max: 180 }),
        size: Object.freeze({ min: 46, max: 360 }),
        color: Object.freeze([0.82, 0.84, 0.88, 0.32]),
        fadeNearStart: 30.0,
        fadeFarStart: 1500.0,
        fadeFarEnd: 2500.0,
        densityThreshold: 0.32,
    }),
});

export const DEFAULT_ATMO_PLACEMENT_CONFIG = Object.freeze({
    cellSize: 400,
    scanRadius: 7,
    maxRenderDist: 2000,
    baseSpawnBudget: 3,
    lodNearDistance: 200,
    lodFarDistance: 1500,
    lodMinScale: 0.1,
    distanceCutoff: 2000,
    spawnProbability: 0.35,
});

const ATMO_TYPE_BY_NAME = Object.freeze(Object.fromEntries(
    Object.entries(ATMO_BANK_TYPES).map(([name, typeId]) => [name, typeId])
));
const ATMO_TYPE_NAME_BY_ID = Object.freeze(Object.fromEntries(
    Object.entries(ATMO_BANK_TYPES).map(([name, typeId]) => [typeId, name])
));

function cloneValue(value) {
    if (Array.isArray(value)) return value.map(cloneValue);
    if (value && typeof value === 'object') {
        const out = {};
        for (const [key, nested] of Object.entries(value)) out[key] = cloneValue(nested);
        return out;
    }
    return value;
}

function clampNumber(value, fallback, min = -Infinity, max = Infinity) {
    const n = Number.isFinite(value) ? value : fallback;
    return Math.max(min, Math.min(max, n));
}

function clampInt(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
    return Math.trunc(clampNumber(value, fallback, min, max));
}

function normalizeName(value, fallback = '') {
    if (typeof value !== 'string') return fallback;
    const normalized = value.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    return normalized || fallback;
}

function normalizeTypeId(value, fallback = null) {
    if (Number.isInteger(value) && value >= 0 && value < ATMO_TYPE_CAPACITY) {
        return value;
    }
    const key = normalizeName(value);
    if (Object.prototype.hasOwnProperty.call(ATMO_TYPE_BY_NAME, key)) {
        return ATMO_TYPE_BY_NAME[key];
    }
    return fallback;
}

function normalizeRange(raw = {}, fallback = {}, min = 0, max = Infinity) {
    const lo = clampNumber(raw.min, fallback.min, min, max);
    const hi = clampNumber(raw.max, fallback.max, min, max);
    return { min: Math.min(lo, hi), max: Math.max(lo, hi) };
}

function normalizeColor(raw, fallback) {
    const source = Array.isArray(raw) ? raw : fallback;
    return [
        clampNumber(source?.[0], fallback[0], 0, 1),
        clampNumber(source?.[1], fallback[1], 0, 1),
        clampNumber(source?.[2], fallback[2], 0, 1),
        clampNumber(source?.[3], fallback[3], 0, 1),
    ];
}

function normalizeTypeDef(raw = {}, fallback = {}, typeId = 0) {
    const typeName = ATMO_TYPE_NAME_BY_ID[typeId] ?? `TYPE_${typeId}`;
    return {
        id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : (fallback.id ?? typeName.toLowerCase()),
        type: typeName,
        typeId,
        displayName: typeof raw.displayName === 'string' && raw.displayName.trim()
            ? raw.displayName.trim()
            : (fallback.displayName ?? typeName),
        noiseScale: clampNumber(raw.noiseScale, fallback.noiseScale ?? 0.01, 0, 1),
        noiseSpeed: clampNumber(raw.noiseSpeed, fallback.noiseSpeed ?? 0.02, 0, 1),
        densityBase: clampNumber(raw.densityBase, fallback.densityBase ?? 0.5, 0, 4),
        windResponse: clampNumber(raw.windResponse, fallback.windResponse ?? 0.1, 0, 4),
        lifetime: normalizeRange(raw.lifetime, fallback.lifetime ?? { min: 30, max: 90 }, 0.1, 600),
        size: normalizeRange(raw.size, fallback.size ?? { min: 20, max: 80 }, 0.1, 5000),
        color: normalizeColor(raw.color, fallback.color ?? [0.8, 0.8, 0.85, 0.5]),
        fadeNearStart: clampNumber(raw.fadeNearStart, fallback.fadeNearStart ?? 15, 0, 100000),
        fadeFarStart: clampNumber(raw.fadeFarStart, fallback.fadeFarStart ?? 1000, 0, 100000),
        fadeFarEnd: clampNumber(raw.fadeFarEnd, fallback.fadeFarEnd ?? 2000, 0, 100000),
        densityThreshold: clampNumber(raw.densityThreshold, fallback.densityThreshold ?? 0.35, 0, 1),
    };
}

function collectTypeOverrides(rawTypes, warnings) {
    const overrides = new Map();
    if (Array.isArray(rawTypes)) {
        for (let index = 0; index < rawTypes.length; index++) {
            const entry = rawTypes[index] ?? {};
            const typeId = normalizeTypeId(entry.typeId ?? entry.type ?? entry.id, null);
            if (typeId == null) {
                warnings.unknownTypes.push({ index, type: entry.type ?? entry.id ?? null });
                continue;
            }
            overrides.set(typeId, entry);
        }
    } else if (rawTypes && typeof rawTypes === 'object') {
        for (const [key, entry] of Object.entries(rawTypes)) {
            const typeId = normalizeTypeId(entry?.typeId ?? entry?.type ?? key, null);
            if (typeId == null) {
                warnings.unknownTypes.push({ key });
                continue;
            }
            overrides.set(typeId, entry);
        }
    }
    return overrides;
}

function normalizePlacement(raw = {}, fallback = DEFAULT_ATMO_PLACEMENT_CONFIG) {
    return {
        cellSize: clampNumber(raw.cellSize, fallback.cellSize, 1, 100000),
        scanRadius: clampInt(raw.scanRadius, fallback.scanRadius, 1, 65),
        maxRenderDist: clampNumber(raw.maxRenderDist, fallback.maxRenderDist, 1, 1000000),
        baseSpawnBudget: clampInt(raw.baseSpawnBudget, fallback.baseSpawnBudget, 0, 128),
        lodNearDistance: clampNumber(raw.lodNearDistance, fallback.lodNearDistance, 0, 1000000),
        lodFarDistance: clampNumber(raw.lodFarDistance, fallback.lodFarDistance, 0, 1000000),
        lodMinScale: clampNumber(raw.lodMinScale, fallback.lodMinScale, 0, 1),
        distanceCutoff: clampNumber(raw.distanceCutoff, fallback.distanceCutoff, 1, 1000000),
        spawnProbability: clampNumber(raw.spawnProbability, fallback.spawnProbability, 0, 1),
    };
}

function normalizeOptionalSignalBand(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const min = Number.isFinite(raw.min) ? raw.min : -Infinity;
    const max = Number.isFinite(raw.max) ? raw.max : Infinity;
    const weight = clampNumber(raw.weight, 1, 0, 16);
    return { min: Math.min(min, max), max: Math.max(min, max), weight };
}

function normalizeScatterRule(raw = {}, index = 0, warnings) {
    const typeId = normalizeTypeId(raw.typeId ?? raw.type, null);
    if (typeId == null) {
        warnings.invalidScatterRules.push({ index, id: raw.id ?? null, reason: 'unknown-type' });
        return null;
    }
    return {
        id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `atmo_rule_${index + 1}`,
        enabled: raw.enabled !== false,
        type: ATMO_TYPE_NAME_BY_ID[typeId] ?? `TYPE_${typeId}`,
        typeId,
        spawnBudget: clampInt(raw.spawnBudget, 3, 0, 128),
        probability: clampNumber(raw.probability, 0.25, 0, 1),
        weatherWeight: clampNumber(raw.weatherWeight, 1, 0, 4),
        fogWeight: clampNumber(raw.fogWeight, 1, 0, 4),
        tileCategories: Array.isArray(raw.tileCategories)
            ? raw.tileCategories.map((name) => normalizeName(name)).filter(Boolean)
            : [],
        biomeIds: Array.isArray(raw.biomeIds)
            ? raw.biomeIds.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim())
            : [],
        biomeTags: Array.isArray(raw.biomeTags)
            ? raw.biomeTags.filter((tag) => typeof tag === 'string' && tag.trim()).map((tag) => tag.trim())
            : [],
        elevation: normalizeOptionalSignalBand(raw.elevation),
        slope: normalizeOptionalSignalBand(raw.slope),
        terrainShape: raw.terrainShape && typeof raw.terrainShape === 'object'
            ? cloneValue(raw.terrainShape)
            : null,
    };
}

export function buildAtmoBankAuthoringRuntime(rawDocument = {}, options = {}) {
    const raw = rawDocument && typeof rawDocument === 'object' ? rawDocument : {};
    const warnings = {
        unknownTypes: [],
        invalidScatterRules: [],
    };
    const fallbackTypes = options.fallbackTypes ?? DEFAULT_ATMO_BANK_CONFIG;
    const typeOverrides = collectTypeOverrides(raw.types ?? raw.bankTypes ?? raw.typeDefs, warnings);
    const typeDefs = {};

    for (let typeId = 0; typeId < ATMO_TYPE_CAPACITY; typeId++) {
        const fallback = fallbackTypes[typeId] ?? DEFAULT_ATMO_BANK_CONFIG[typeId];
        if (!fallback && !typeOverrides.has(typeId)) continue;
        typeDefs[typeId] = normalizeTypeDef(typeOverrides.get(typeId) ?? {}, fallback ?? {}, typeId);
    }

    const scatterRules = (Array.isArray(raw.scatterRules) ? raw.scatterRules : [])
        .map((rule, index) => normalizeScatterRule(rule, index, warnings))
        .filter(Boolean);

    const runtime = {
        typeDefs,
        placement: normalizePlacement(raw.placement ?? {}, options.fallbackPlacement ?? DEFAULT_ATMO_PLACEMENT_CONFIG),
        scatterRules,
        summary: {
            typeCount: Object.keys(typeDefs).length,
            scatterRuleCount: scatterRules.length,
            warningCount: warnings.unknownTypes.length + warnings.invalidScatterRules.length,
        },
        warnings,
    };
    return runtime;
}

export function cloneAtmoBankAuthoringRuntime(runtime = buildAtmoBankAuthoringRuntime()) {
    return buildAtmoBankAuthoringRuntime({
        types: cloneValue(runtime?.typeDefs ?? runtime?.types ?? DEFAULT_ATMO_BANK_CONFIG),
        placement: cloneValue(runtime?.placement ?? DEFAULT_ATMO_PLACEMENT_CONFIG),
        scatterRules: cloneValue(runtime?.scatterRules ?? []),
    });
}
