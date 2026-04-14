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
 *                               (Studio hover uses baked climate precipitation as humidity)
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

function toUint32(value) {
    return value >>> 0;
}

function hashStep(value, multiplier) {
    return Math.imul(value >>> 0, multiplier >>> 0) >>> 0;
}

/**
 * Deterministic biome hash mirrored from biomeScoring.wgsl.js.
 * @param {number} cellX
 * @param {number} cellY
 * @param {number} seed
 * @returns {number} 0..1
 */
export function seededHash(cellX, cellY, seed) {
    let h = toUint32(seed);
    h ^= hashStep(toUint32(Math.trunc(cellX)), 0x27d4eb2d);
    h ^= hashStep(toUint32(Math.trunc(cellY)), 0x165667b1);
    h = hashStep(((h >>> 15) ^ h) >>> 0, 0x85ebca6b);
    h = hashStep(((h >>> 13) ^ h) >>> 0, 0xc2b2ae35);
    h = hashStep(((h >>> 16) ^ h) >>> 0, 0x45d9f3b);
    h = hashStep(((h >>> 16) ^ h) >>> 0, 0x45d9f3b);
    h = ((h >>> 16) ^ h) >>> 0;
    return (h & 0x7fffffff) / 0x7fffffff;
}

function biomeSelectionHash(worldX, worldY, seed) {
    const cellX = Math.floor(worldX * 0.125);
    const cellY = Math.floor(worldY * 0.125);
    return seededHash(cellX, cellY, toUint32(toUint32(seed) + 99999));
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

    const noiseSeed = toUint32(toUint32(seed) + toUint32(seedOff));
    const n00 = seededHash(ix, iy, noiseSeed) * 2 - 1;
    const n10 = seededHash(ix + 1, iy, noiseSeed) * 2 - 1;
    const n01 = seededHash(ix, iy + 1, noiseSeed) * 2 - 1;
    const n11 = seededHash(ix + 1, iy + 1, noiseSeed) * 2 - 1;

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
 * @param {number} worldX             Terrain sample X coordinate (sphere: unitDir.x, flat: world x)
 * @param {number} worldY             Terrain sample Y coordinate (sphere: unitDir.z, flat: world y)
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

    return scores;
}

/**
 * Select a biome deterministically based on position and seed.
 *
 * @param {Array<object>} biomeDefs
 * @param {object} signals
 * @param {number} worldX             Terrain sample X coordinate (sphere: unitDir.x, flat: world x)
 * @param {number} worldY             Terrain sample Y coordinate (sphere: unitDir.z, flat: world y)
 * @param {number} seed
 * @returns {{ biome: object, scores: Array<object>, rankedScores: Array<object>, score: number } | null}
 */
export function selectBiome(biomeDefs, signals, worldX, worldY, seed) {
    const scores = scoreBiomes(biomeDefs, signals, worldX, worldY, seed);
    if (scores.length === 0) return null;

    const rankedScores = scores.slice().sort((a, b) => b.probability - a.probability);
    const r = biomeSelectionHash(worldX, worldY, seed);
    let cumulative = 0;
    for (const entry of scores) {
        cumulative += entry.probability;
        if (r <= cumulative) {
            return {
                biome: entry.biome,
                scores,
                rankedScores,
                score: entry.probability,
            };
        }
    }

    const bestEntry = scores.reduce((best, entry) => (
        entry.finalScore > best.finalScore ? entry : best
    ), scores[0]);
    return {
        biome: bestEntry.biome,
        scores,
        rankedScores,
        score: bestEntry.probability,
    };
}
