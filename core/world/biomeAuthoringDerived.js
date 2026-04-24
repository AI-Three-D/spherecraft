export const CLUSTER_TREE_METADATA_STRIDE_FLOATS = 8;
export const CLUSTER_TREE_DEFAULT_TILE_COUNT = 256;

export function clamp01(value, fallback = 0.0) {
    const numeric = Number.isFinite(value) ? value : fallback;
    return Math.max(0.0, Math.min(1.0, numeric));
}

export function clampRange(value, min, max, fallback = min) {
    const numeric = Number.isFinite(value) ? value : fallback;
    return Math.max(min, Math.min(max, numeric));
}

export function normalizeArchetypeRef(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function signalCenter(biome, signalKey, fallback = 0.5) {
    const rule = biome?.signals?.[signalKey];
    if (!rule) return fallback;
    const minValue = Number.isFinite(rule.min) ? rule.min : fallback;
    const maxValue = Number.isFinite(rule.max) ? rule.max : fallback;
    return clamp01((minValue + maxValue) * 0.5, fallback);
}

export function biomeTextIncludes(biome, needles) {
    const haystack = [
        biome?.id,
        biome?.displayName,
        ...(Array.isArray(biome?.tags) ? biome.tags : []),
    ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
    return needles.some((needle) => haystack.includes(needle));
}

export function collectTreeProfileWeights(assetProfiles = []) {
    const weightsByBiomeId = new Map();
    let treeProfileCount = 0;
    let maxWeight = 0.0;

    for (const profile of assetProfiles) {
        if (normalizeArchetypeRef(profile?.archetypeRef) !== 'tree') continue;
        treeProfileCount++;
        const density = Math.max(0.0, Number.isFinite(profile?.density) ? profile.density : 0.5);
        const probability = Math.max(0.0, Number.isFinite(profile?.probability) ? profile.probability : 0.5);
        const profileWeight = density * probability;
        const biomeIds = Array.isArray(profile?.biomeIds) ? profile.biomeIds : [];
        for (const biomeId of biomeIds) {
            if (typeof biomeId !== 'string' || !biomeId) continue;
            const nextWeight = (weightsByBiomeId.get(biomeId) ?? 0.0) + profileWeight;
            weightsByBiomeId.set(biomeId, nextWeight);
            maxWeight = Math.max(maxWeight, nextWeight);
        }
    }

    return { weightsByBiomeId, treeProfileCount, maxWeight };
}

export function biomeTreeSuitabilityBias(biome) {
    const humidity = signalCenter(biome, 'humidity', 0.5);
    const woodland = biomeTextIncludes(biome, ['forest', 'woodland', 'jungle', 'rainforest']);
    const arid = biomeTextIncludes(biome, ['arid', 'desert']) || humidity < 0.25;
    if (woodland) return 1.0;
    return clampRange(0.28 + humidity * 0.24 - (arid ? 0.15 : 0.0), 0.18, 1.0, 0.28);
}

export function computeBiomeTreeProfileHint(biome, rawTreeWeight, maxTreeWeight) {
    const normalizedProfileWeight = maxTreeWeight > 0.0
        ? clamp01(rawTreeWeight / maxTreeWeight, 0.0)
        : 0.0;
    const humidity = signalCenter(biome, 'humidity', 0.5);
    const temperature = signalCenter(biome, 'temperature', 0.5);
    const elevation = signalCenter(biome, 'elevation', 0.3);
    const woodland = biomeTextIncludes(biome, ['forest', 'woodland', 'jungle', 'rainforest']);
    const arid = biomeTextIncludes(biome, ['arid', 'desert']) || humidity < 0.25;
    const cold = biomeTextIncludes(biome, ['cold', 'polar', 'snow', 'ice']) || temperature < 0.35;

    const tileWeight = clamp01(normalizedProfileWeight * biomeTreeSuitabilityBias(biome), 0.0);

    const conifer = clamp01(
        0.18 +
        (1.0 - temperature) * 0.45 +
        elevation * 0.25 +
        (woodland ? 0.12 : 0.0) +
        (cold ? 0.20 : 0.0) -
        (arid ? 0.25 : 0.0) -
        humidity * 0.05
    );

    const foliage = [
        clamp01(0.09 + humidity * 0.08 + temperature * 0.04 - (arid ? 0.03 : 0.0)),
        clamp01(0.18 + humidity * 0.18 + temperature * 0.05 + (woodland ? 0.04 : 0.0) - (arid ? 0.08 : 0.0)),
        clamp01(0.06 + humidity * 0.05 - (arid ? 0.02 : 0.0)),
    ];

    return { tileWeight, conifer, foliage };
}

export function computeBiomeTreeWeights(biomes = [], assetProfiles = []) {
    const { weightsByBiomeId, maxWeight } = collectTreeProfileWeights(assetProfiles);
    const normalizedWeights = new Map();
    if (maxWeight <= 0.0) return normalizedWeights;

    for (const biome of biomes) {
        const rawTreeWeight = weightsByBiomeId.get(biome?.id) ?? 0.0;
        if (rawTreeWeight <= 0.0) continue;
        normalizedWeights.set(
            biome.id,
            computeBiomeTreeProfileHint(biome, rawTreeWeight, maxWeight).tileWeight
        );
    }
    return normalizedWeights;
}
