/**
 * BiomeScoring — JS-side biome scoring model for Studio diagnostics.
 *
 * Mirrors the scoring logic that runs on the GPU in the terrain shader.
 * Given environmental signals at a point and a set of biome definitions,
 * computes the probability distribution and selected biome.
 *
 * Used by:
 *   - Studio biome diagnostics overlay (cursor hover)
 *   - Studio biome preview (what-if analysis)
 *
 * The GPU shader should produce identical results for the same inputs.
 */

/**
 * Compute the score for a single signal rule.
 * @param {number} value   Sampled signal value (0..1)
 * @param {object} rule    { min, max, transitionWidth, preference, weight }
 * @returns {number}       Score in 0..1
 */
export function scoreSignal(value, rule) {
    if (!rule) return 1.0;

    const { min, max, transitionWidth = 0.1, preference = 'mid' } = rule;

    // Core band membership with soft transitions
    let band;
    if (value < min) {
        band = Math.max(0, 1 - (min - value) / Math.max(transitionWidth, 0.001));
    } else if (value > max) {
        band = Math.max(0, 1 - (value - max) / Math.max(transitionWidth, 0.001));
    } else {
        band = 1.0;
    }

    // Linear preference curve within the band
    let pref = 1.0;
    if (preference === 'low') {
        const range = max - min;
        if (range > 0.001) {
            pref = 1 - Math.max(0, Math.min(1, (value - min) / range)) * 0.5;
        }
    } else if (preference === 'high') {
        const range = max - min;
        if (range > 0.001) {
            pref = 0.5 + Math.max(0, Math.min(1, (value - min) / range)) * 0.5;
        }
    }
    // 'mid' = flat 1.0

    return band * pref;
}

/**
 * Compute a biome's environmental suitability from all its defined signals.
 * @param {object} signals       { elevation, humidity, temperature, slope } — sampled values
 * @param {object} biomeSignals  The biome's signal rules from biomes.json
 * @returns {number}             Normalized suitability score 0..1
 */
export function computeEnvironmentalScore(signals, biomeSignals) {
    if (!biomeSignals) return 1.0;

    let totalWeight = 0;
    let weightedSum = 0;

    for (const [key, rule] of Object.entries(biomeSignals)) {
        const value = signals[key];
        if (value == null || !rule) continue;

        const w = rule.weight ?? 1.0;
        const s = scoreSignal(value, rule);
        weightedSum += s * w;
        totalWeight += w;
    }

    return totalWeight > 0 ? weightedSum / totalWeight : 1.0;
}

/**
 * Simple seeded hash for deterministic selection.
 * @param {number} x
 * @param {number} y
 * @param {number} seed
 * @returns {number} 0..1
 */
export function seededHash(x, y, seed) {
    let h = seed + Math.floor(x * 73856093) + Math.floor(y * 19349663);
    h = ((h >>> 16) ^ h) * 0x45d9f3b | 0;
    h = ((h >>> 16) ^ h) * 0x45d9f3b | 0;
    h = (h >>> 16) ^ h;
    return (h & 0x7FFFFFFF) / 0x7FFFFFFF;
}

/**
 * Simple noise approximation for regional variation (JS side).
 * Uses a low-frequency hash-based noise.
 * @param {number} x      World X
 * @param {number} y      World Y
 * @param {object} rv     Regional variation config { noiseScale, noiseStrength, seedOffset }
 * @param {number} seed   World seed
 * @returns {number}       -1..1
 */
export function regionalNoise(x, y, rv, seed) {
    if (!rv || rv.noiseStrength === 0) return 0;
    const scale = rv.noiseScale ?? 0.001;
    const sx = x * scale;
    const sy = y * scale;
    const seedOff = rv.seedOffset ?? 0;
    // Simple value noise approximation
    const ix = Math.floor(sx);
    const iy = Math.floor(sy);
    const fx = sx - ix;
    const fy = sy - iy;

    const n00 = seededHash(ix, iy, seed + seedOff) * 2 - 1;
    const n10 = seededHash(ix + 1, iy, seed + seedOff) * 2 - 1;
    const n01 = seededHash(ix, iy + 1, seed + seedOff) * 2 - 1;
    const n11 = seededHash(ix + 1, iy + 1, seed + seedOff) * 2 - 1;

    // Bilinear interpolation with smoothstep
    const u = fx * fx * (3 - 2 * fx);
    const v = fy * fy * (3 - 2 * fy);

    const x0 = n00 * (1 - u) + n10 * u;
    const x1 = n01 * (1 - u) + n11 * u;
    return x0 * (1 - v) + x1 * v;
}

/**
 * Compute final occurrence scores for all biomes at a world position.
 *
 * @param {Array<object>} biomeDefs   Array of biome definitions from biomes.json
 * @param {object} signals            { elevation, humidity, temperature, slope }
 * @param {number} worldX             World X position
 * @param {number} worldY             World Y position
 * @param {number} seed               World seed
 * @returns {Array<{biome: object, envScore: number, regionalFactor: number, finalScore: number, probability: number}>}
 */
export function scoreBiomes(biomeDefs, signals, worldX, worldY, seed) {
    if (!biomeDefs || biomeDefs.length === 0) return [];

    const scores = biomeDefs.map(biome => {
        const envScore = computeEnvironmentalScore(signals, biome.signals);
        const rv = biome.regionalVariation;
        const noise = regionalNoise(worldX, worldY, rv, seed);
        const regionalFactor = 1 + noise * (rv?.noiseStrength ?? 0);
        const baseWeight = biome.baseWeight ?? 1.0;
        const finalScore = envScore * baseWeight * Math.max(0, regionalFactor);

        return { biome, envScore, regionalFactor, finalScore, probability: 0 };
    });

    // Normalize to probability distribution
    const total = scores.reduce((s, e) => s + e.finalScore, 0);
    if (total > 0) {
        for (const entry of scores) {
            entry.probability = entry.finalScore / total;
        }
    }

    // Sort by probability descending
    scores.sort((a, b) => b.probability - a.probability);

    return scores;
}

/**
 * Select a biome deterministically based on position and seed.
 *
 * @param {Array<object>} biomeDefs
 * @param {object} signals
 * @param {number} worldX
 * @param {number} worldY
 * @param {number} seed
 * @returns {{ biome: object, scores: Array<object> } | null}
 */
export function selectBiome(biomeDefs, signals, worldX, worldY, seed) {
    const scores = scoreBiomes(biomeDefs, signals, worldX, worldY, seed);
    if (scores.length === 0) return null;

    // Deterministic selection from probability distribution
    const r = seededHash(worldX * 137, worldY * 311, seed + 99999);
    let cumulative = 0;
    for (const entry of scores) {
        cumulative += entry.probability;
        if (r <= cumulative) {
            return { biome: entry.biome, scores };
        }
    }

    // Fallback to highest probability
    return { biome: scores[0].biome, scores };
}
