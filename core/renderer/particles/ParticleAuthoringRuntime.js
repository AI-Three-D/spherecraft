import {
    PARTICLE_CONFIG,
    PARTICLE_EMITTER_PRESETS,
} from '../../../templates/configs/particleConfig.js';
import { PARTICLE_TYPES } from './ParticleTypes.js';

const DEFAULT_LEAF_FALL_AUTHORING = Object.freeze({
    enabled: true,
    source: 'spawn_offsets',
    anchorSelection: Object.freeze({
        source: 'detailed_leaf_anchors',
        probability: 0.08,
        maxAnchorsPerTree: 1,
        maxEmitters: 3,
        maxReadTrees: 48,
        refreshIntervalSeconds: 1.0,
        spawnIntervalSeconds: Object.freeze([1.0, 4.0]),
        spawnBudgetPerEvent: 1,
        distanceCutoff: 65.0,
        lodNearDistance: 16.0,
        lodFarDistance: 50.0,
        lodMinScale: 1.0,
        pending: false,
    }),
    emitters: Object.freeze([
        Object.freeze({ tangent: 10, bitangent: 6 }),
        Object.freeze({ tangent: -8, bitangent: 12 }),
        Object.freeze({ tangent: 14, bitangent: -4 }),
    ]),
});

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

function normalizeParticleTypeId(value) {
    if (Number.isInteger(value) && value >= 0) return value;
    if (typeof value !== 'string') return null;
    const numeric = Number(value);
    if (Number.isInteger(numeric) && numeric >= 0) return numeric;
    const key = value.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    return Object.prototype.hasOwnProperty.call(PARTICLE_TYPES, key)
        ? PARTICLE_TYPES[key]
        : null;
}

function normalizeRange(raw, fallback = [0, 0]) {
    if (!Array.isArray(raw)) return fallback.slice();
    const min = clampNumber(raw[0], fallback[0]);
    const max = clampNumber(raw[1], fallback[1]);
    return [Math.min(min, max), Math.max(min, max)];
}

function normalizeSecondsRange(raw, fallback = [1, 4]) {
    const source = Array.isArray(raw) ? raw : fallback;
    const min = clampNumber(source?.[0], fallback[0], 0.05, 60);
    const max = clampNumber(source?.[1], fallback[1], 0.05, 60);
    return [Math.min(min, max), Math.max(min, max)];
}

function normalizeColor(raw, fallback) {
    const source = Array.isArray(raw) ? raw : fallback;
    return [
        clampNumber(source?.[0], fallback[0], 0, 8),
        clampNumber(source?.[1], fallback[1], 0, 8),
        clampNumber(source?.[2], fallback[2], 0, 8),
        clampNumber(source?.[3], fallback[3], 0, 1),
    ];
}

function mergeParticleType(base = {}, override = {}) {
    const merged = cloneValue(base);
    if (!override || typeof override !== 'object') return merged;

    if (override.blend != null) merged.blend = override.blend === 'additive' ? 'additive' : 'alpha';
    if (override.lifetime) merged.lifetime = {
        min: clampNumber(override.lifetime.min, merged.lifetime?.min ?? 1, 0.001, 600),
        max: clampNumber(override.lifetime.max, merged.lifetime?.max ?? 1, 0.001, 600),
    };
    if (merged.lifetime?.min > merged.lifetime?.max) {
        [merged.lifetime.min, merged.lifetime.max] = [merged.lifetime.max, merged.lifetime.min];
    }
    if (override.size) merged.size = {
        start: clampNumber(override.size.start, merged.size?.start ?? 0.1, 0.001, 100),
        end: clampNumber(override.size.end, merged.size?.end ?? 0.1, 0.001, 100),
    };
    if (override.velocity) merged.velocity = {
        x: normalizeRange(override.velocity.x, merged.velocity?.x ?? [0, 0]),
        y: normalizeRange(override.velocity.y, merged.velocity?.y ?? [0, 0]),
        z: normalizeRange(override.velocity.z, merged.velocity?.z ?? [0, 0]),
    };
    if (override.spawnOffset) merged.spawnOffset = {
        radius: clampNumber(override.spawnOffset.radius, merged.spawnOffset?.radius ?? 0, 0, 1000),
        heightMin: clampNumber(override.spawnOffset.heightMin, merged.spawnOffset?.heightMin ?? 0, -1000, 1000),
        heightMax: clampNumber(override.spawnOffset.heightMax, merged.spawnOffset?.heightMax ?? 0, -1000, 1000),
    };
    if (merged.spawnOffset?.heightMin > merged.spawnOffset?.heightMax) {
        [merged.spawnOffset.heightMin, merged.spawnOffset.heightMax] =
            [merged.spawnOffset.heightMax, merged.spawnOffset.heightMin];
    }

    for (const key of ['gravity', 'drag', 'upwardBias', 'lateralNoise', 'emissive', 'bloomWeight', 'spawnWeight']) {
        if (Number.isFinite(override[key])) merged[key] = override[key];
    }
    if (override.colorStart) merged.colorStart = normalizeColor(override.colorStart, merged.colorStart ?? [1, 1, 1, 1]);
    if (override.colorMid) merged.colorMid = normalizeColor(override.colorMid, merged.colorMid ?? merged.colorStart ?? [1, 1, 1, 1]);
    if (override.colorEnd) merged.colorEnd = normalizeColor(override.colorEnd, merged.colorEnd ?? [0, 0, 0, 0]);
    if (override.flags && typeof override.flags === 'object') {
        merged.flags = { ...(merged.flags ?? {}), ...override.flags };
    }
    if (typeof override.bloomEnabled === 'boolean') merged.bloomEnabled = override.bloomEnabled;
    return merged;
}

function normalizeParticleTypes(rawTypes = {}, warnings) {
    const particleConfig = cloneValue(PARTICLE_CONFIG);
    if (!rawTypes || typeof rawTypes !== 'object') {
        return particleConfig;
    }

    for (const [key, override] of Object.entries(rawTypes)) {
        const typeId = normalizeParticleTypeId(override?.typeId ?? override?.type ?? key);
        if (typeId == null || !particleConfig[typeId]) {
            warnings.unknownParticleTypes.push({ key });
            continue;
        }
        particleConfig[typeId] = mergeParticleType(particleConfig[typeId], override);
    }
    return particleConfig;
}

function normalizeEmitterPresets(rawPresets = {}) {
    const presets = cloneValue(PARTICLE_EMITTER_PRESETS);
    if (!rawPresets || typeof rawPresets !== 'object') return presets;

    for (const [name, override] of Object.entries(rawPresets)) {
        const base = presets[name] ?? {};
        const merged = { ...cloneValue(base) };
        if (Array.isArray(override?.types)) {
            merged.types = override.types
                .map(normalizeParticleTypeId)
                .filter((id) => Number.isInteger(id))
                .slice(0, 4);
        }
        if (override?.weights && typeof override.weights === 'object') {
            merged.weights = {};
            for (const [typeKey, weight] of Object.entries(override.weights)) {
                const typeId = normalizeParticleTypeId(typeKey);
                if (typeId != null) merged.weights[typeId] = clampNumber(weight, 1, 0, 1000);
            }
        }
        for (const key of ['spawnBudgetPerFrame', 'distanceCutoff', 'lodNearDistance', 'lodFarDistance', 'lodMinScale']) {
            if (Number.isFinite(override?.[key])) merged[key] = override[key];
        }
        presets[name] = merged;
    }
    return presets;
}

function normalizeLeafFall(raw = {}) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const fallback = DEFAULT_LEAF_FALL_AUTHORING;
    const emitters = Array.isArray(source.emitters)
        ? source.emitters
            .map((emitter) => ({
                tangent: clampNumber(emitter?.tangent, 0, -1000, 1000),
                bitangent: clampNumber(emitter?.bitangent, 0, -1000, 1000),
                heightOffset: Number.isFinite(emitter?.heightOffset)
                    ? clampNumber(emitter.heightOffset, 0, -1000, 1000)
                    : undefined,
                spawnBudgetPerFrame: Number.isFinite(emitter?.spawnBudgetPerFrame)
                    ? clampInt(emitter.spawnBudgetPerFrame, 1, 0, 128)
                    : undefined,
            }))
        : fallback.emitters.map(cloneValue);
    const anchorSelection = source.anchorSelection && typeof source.anchorSelection === 'object'
        ? source.anchorSelection
        : fallback.anchorSelection;

    return {
        enabled: source.enabled !== false,
        source: typeof source.source === 'string' ? source.source : fallback.source,
        anchorSelection: {
            source: typeof anchorSelection.source === 'string' ? anchorSelection.source : fallback.anchorSelection.source,
            probability: clampNumber(anchorSelection.probability, fallback.anchorSelection.probability, 0, 1),
            maxAnchorsPerTree: clampInt(anchorSelection.maxAnchorsPerTree, fallback.anchorSelection.maxAnchorsPerTree, 0, 1024),
            maxEmitters: clampInt(anchorSelection.maxEmitters, fallback.anchorSelection.maxEmitters, 0, 128),
            maxReadTrees: clampInt(anchorSelection.maxReadTrees, fallback.anchorSelection.maxReadTrees, 1, 512),
            refreshIntervalSeconds: clampNumber(
                anchorSelection.refreshIntervalSeconds,
                fallback.anchorSelection.refreshIntervalSeconds,
                0.1,
                30
            ),
            spawnIntervalSeconds: normalizeSecondsRange(
                anchorSelection.spawnIntervalSeconds,
                fallback.anchorSelection.spawnIntervalSeconds
            ),
            spawnBudgetPerEvent: clampInt(
                anchorSelection.spawnBudgetPerEvent,
                fallback.anchorSelection.spawnBudgetPerEvent,
                1,
                16
            ),
            distanceCutoff: clampNumber(anchorSelection.distanceCutoff, fallback.anchorSelection.distanceCutoff, 1, 500),
            lodNearDistance: clampNumber(anchorSelection.lodNearDistance, fallback.anchorSelection.lodNearDistance, 0, 500),
            lodFarDistance: clampNumber(anchorSelection.lodFarDistance, fallback.anchorSelection.lodFarDistance, 0, 500),
            lodMinScale: clampNumber(anchorSelection.lodMinScale, fallback.anchorSelection.lodMinScale, 0, 1),
            pending: anchorSelection.pending === true,
        },
        emitters: emitters.filter((emitter) =>
            Number.isFinite(emitter.tangent) && Number.isFinite(emitter.bitangent)
        ),
    };
}

export function buildParticleAuthoringRuntime(rawDocument = {}) {
    const raw = rawDocument && typeof rawDocument === 'object' ? rawDocument : {};
    const warnings = {
        unknownParticleTypes: [],
    };
    const rawTypes = raw.types ?? raw.particleTypes ?? raw.particleConfig;
    const rawEmitterPresets = raw.emitterPresets;
    const particleConfig = normalizeParticleTypes(rawTypes, warnings);
    const emitterPresets = normalizeEmitterPresets(rawEmitterPresets);
    const leafFall = normalizeLeafFall(raw.ambientEmitters?.leafFall ?? raw.leafFall);
    const leafEmitterCount = leafFall.enabled
        ? (leafFall.source === 'detailed_leaf_anchors'
            ? leafFall.anchorSelection.maxEmitters
            : leafFall.emitters.length)
        : 0;

    return {
        particleConfig,
        emitterPresets,
        ambientEmitters: {
            leafFall,
        },
        summary: {
            typeOverrideCount: rawTypes && typeof rawTypes === 'object' ? Object.keys(rawTypes).length : 0,
            emitterPresetOverrideCount: rawEmitterPresets && typeof rawEmitterPresets === 'object'
                ? Object.keys(rawEmitterPresets).length
                : 0,
            leafEmitterCount,
            leafSource: leafFall.source,
            warningCount: warnings.unknownParticleTypes.length,
        },
        warnings,
    };
}

export function cloneParticleAuthoringRuntime(runtime = buildParticleAuthoringRuntime()) {
    return buildParticleAuthoringRuntime({
        types: cloneValue(runtime?.particleConfig ?? PARTICLE_CONFIG),
        emitterPresets: cloneValue(runtime?.emitterPresets ?? PARTICLE_EMITTER_PRESETS),
        ambientEmitters: cloneValue(runtime?.ambientEmitters ?? {}),
    });
}
