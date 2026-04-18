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
 * @param {number} [worldX] Biome-space X coordinate for edge dithering
 * @param {number} [worldY] Biome-space Y coordinate for edge dithering
 * @param {number} [seed]   Stable seed for edge dithering
 * @returns {number}       Score in 0..1
 */
export function scoreSignal(value, rule, worldX = 0, worldY = 0, seed = 0) {
    if (!rule) return 1.0;

    const {
        min,
        max,
        transitionWidth = 0.1,
        preference = 'mid',
        ditherScale = 0,
        ditherStrength = 0,
    } = rule;
    const tw = Math.max(transitionWidth, 0.001);
    let edgeValue = value;
    if (ditherScale > 0 && ditherStrength > 0) {
        edgeValue += sampleValueNoise(worldX, worldY, ditherScale, seed) * tw * ditherStrength;
    }

    // Core band membership with soft transitions
    let band;
    if (edgeValue < min) {
        band = Math.max(0, 1 - (min - edgeValue) / tw);
    } else if (edgeValue > max) {
        band = Math.max(0, 1 - (edgeValue - max) / tw);
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
 * @param {number} [worldX]      Biome-space X coordinate for edge dithering
 * @param {number} [worldY]      Biome-space Y coordinate for edge dithering
 * @param {number} [seed]        World seed
 * @param {number} [biomeSeedOffset]  Stable per-biome offset used by authored dither
 * @returns {number}             Normalized suitability score 0..1
 */
export function computeEnvironmentalScore(
    signals,
    biomeSignals,
    worldX = 0,
    worldY = 0,
    seed = 0,
    biomeSeedOffset = 0
) {
    if (!biomeSignals) return 1.0;

    const baseSeed = toUint32(toUint32(seed) + toUint32(biomeSeedOffset));
    const elevation = scoreSignalContribution('elevation', signals, biomeSignals, worldX, worldY, baseSeed);
    const humidity = scoreSignalContribution('humidity', signals, biomeSignals, worldX, worldY, baseSeed);
    const temperature = scoreSignalContribution('temperature', signals, biomeSignals, worldX, worldY, baseSeed);
    const slope = scoreSignalContribution('slope', signals, biomeSignals, worldX, worldY, baseSeed);

    const weightedSum = elevation.weighted + humidity.weighted + temperature.weighted + slope.weighted;
    const totalWeight = elevation.weight + humidity.weight + temperature.weight + slope.weight;

    return totalWeight > 0 ? weightedSum / totalWeight : 1.0;
}

const SIGNAL_DITHER_SEED_OFFSETS = Object.freeze({
    elevation: 101,
    humidity: 211,
    temperature: 307,
    slope: 401,
});
const SIMPLEX_F2 = 0.3660254037844386;
const SIMPLEX_G2 = 0.21132486540518713;
const BIOME_REGIONAL_OCTAVES = 3;
const BIOME_NOISE_LACUNARITY = 2.0;
const BIOME_NOISE_GAIN = 0.5;
const BIOME_RIDGED_OFFSET = 1.0;

function toUint32(value) {
    return value >>> 0;
}

function hashStep(value, multiplier) {
    return Math.imul(value >>> 0, multiplier >>> 0) >>> 0;
}

function clamp01(value) {
    return Math.max(0, Math.min(1, value));
}

function clampSignedUnit(value) {
    return Math.max(-1, Math.min(1, value));
}

function fadeQuintic(t) {
    return t * t * t * (t * (t * 6 - 15) + 10);
}

function gradient2(hash, x, y) {
    const g = hash & 7;
    const u = g < 4 ? x : y;
    const v = g < 4 ? y : x;
    const su = (g & 1) === 0 ? u : -u;
    const sv = (g & 2) === 0 ? v : -v;
    return su + sv;
}

/**
 * Deterministic biome hash mirrored from biomeScoring.wgsl.js.
 * @param {number} cellX
 * @param {number} cellY
 * @param {number} seed
 * @returns {number} 0..1
 */
function seededHashUint(cellX, cellY, seed) {
    let h = toUint32(seed);
    h ^= hashStep(toUint32(Math.trunc(cellX)), 0x27d4eb2d);
    h ^= hashStep(toUint32(Math.trunc(cellY)), 0x165667b1);
    h = hashStep(((h >>> 15) ^ h) >>> 0, 0x85ebca6b);
    h = hashStep(((h >>> 13) ^ h) >>> 0, 0xc2b2ae35);
    h = hashStep(((h >>> 16) ^ h) >>> 0, 0x45d9f3b);
    h = hashStep(((h >>> 16) ^ h) >>> 0, 0x45d9f3b);
    return ((h >>> 16) ^ h) >>> 0;
}

export function seededHash(cellX, cellY, seed) {
    const h = seededHashUint(cellX, cellY, seed);
    return (h & 0x7fffffff) / 0x7fffffff;
}

function biomeSelectionHash(worldX, worldY, seed) {
    const cellX = Math.floor(worldX * 0.125);
    const cellY = Math.floor(worldY * 0.125);
    return seededHash(cellX, cellY, toUint32(toUint32(seed) + 99999));
}

function sampleValueNoise(x, y, scale, seed) {
    if (!(scale > 0)) return 0;

    const sx = x * scale;
    const sy = y * scale;
    const ix = Math.floor(sx);
    const iy = Math.floor(sy);
    const fx = sx - ix;
    const fy = sy - iy;

    const n00 = seededHash(ix, iy, seed) * 2 - 1;
    const n10 = seededHash(ix + 1, iy, seed) * 2 - 1;
    const n01 = seededHash(ix, iy + 1, seed) * 2 - 1;
    const n11 = seededHash(ix + 1, iy + 1, seed) * 2 - 1;

    const u = fx * fx * (3 - 2 * fx);
    const v = fy * fy * (3 - 2 * fy);
    const x0 = n00 * (1 - u) + n10 * u;
    const x1 = n01 * (1 - u) + n11 * u;
    return clampSignedUnit(x0 * (1 - v) + x1 * v);
}

function samplePerlinNoise(x, y, scale, seed) {
    if (!(scale > 0)) return 0;

    const sx = x * scale;
    const sy = y * scale;
    const ix = Math.floor(sx);
    const iy = Math.floor(sy);
    const fx = sx - ix;
    const fy = sy - iy;

    const u = fadeQuintic(fx);
    const v = fadeQuintic(fy);

    const n00 = gradient2(seededHashUint(ix, iy, seed), fx, fy);
    const n10 = gradient2(seededHashUint(ix + 1, iy, seed), fx - 1, fy);
    const n01 = gradient2(seededHashUint(ix, iy + 1, seed), fx, fy - 1);
    const n11 = gradient2(seededHashUint(ix + 1, iy + 1, seed), fx - 1, fy - 1);

    const x0 = n00 * (1 - u) + n10 * u;
    const x1 = n01 * (1 - u) + n11 * u;
    return clampSignedUnit(x0 * (1 - v) + x1 * v);
}

function sampleSimplexNoise(x, y, scale, seed) {
    if (!(scale > 0)) return 0;

    const sx = x * scale;
    const sy = y * scale;
    const skew = (sx + sy) * SIMPLEX_F2;
    const i = Math.floor(sx + skew);
    const j = Math.floor(sy + skew);
    const unskew = (i + j) * SIMPLEX_G2;
    const x0 = sx - (i - unskew);
    const y0 = sy - (j - unskew);
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + SIMPLEX_G2;
    const y1 = y0 - j1 + SIMPLEX_G2;
    const x2 = x0 - 1 + 2 * SIMPLEX_G2;
    const y2 = y0 - 1 + 2 * SIMPLEX_G2;

    let n0 = 0;
    let n1 = 0;
    let n2 = 0;

    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
        t0 *= t0;
        n0 = t0 * t0 * gradient2(seededHashUint(i, j, seed), x0, y0);
    }

    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
        t1 *= t1;
        n1 = t1 * t1 * gradient2(seededHashUint(i + i1, j + j1, seed), x1, y1);
    }

    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
        t2 *= t2;
        n2 = t2 * t2 * gradient2(seededHashUint(i + 1, j + 1, seed), x2, y2);
    }

    return clampSignedUnit((n0 + n1 + n2) * 70);
}

function sampleFbmNoise(x, y, scale, seed) {
    if (!(scale > 0)) return 0;

    let value = 0;
    let amp = 1;
    let freq = 1;
    let sumAmp = 0;

    // Keep authored regional variation cheap enough for per-biome O(n) scoring.
    for (let octave = 0; octave < BIOME_REGIONAL_OCTAVES; octave++) {
        value += samplePerlinNoise(x, y, scale * freq, toUint32(seed + octave)) * amp;
        sumAmp += amp;
        amp *= BIOME_NOISE_GAIN;
        freq *= BIOME_NOISE_LACUNARITY;
    }

    return sumAmp > 0 ? clampSignedUnit(value / sumAmp) : 0;
}

function sampleRidgedFbmNoise(x, y, scale, seed) {
    if (!(scale > 0)) return 0;

    let value = 0;
    let amplitude = 1;
    let frequency = 1;
    let weight = 1;
    let sumAmp = 0;

    for (let octave = 0; octave < BIOME_REGIONAL_OCTAVES; octave++) {
        let signal = samplePerlinNoise(x, y, scale * frequency, toUint32(seed + octave));
        signal = BIOME_RIDGED_OFFSET - Math.abs(signal);
        signal *= signal;
        signal *= weight;

        weight = clamp01(signal * amplitude);
        value += signal * amplitude;
        sumAmp += amplitude;

        amplitude *= BIOME_NOISE_GAIN;
        frequency *= BIOME_NOISE_LACUNARITY;
    }

    const normalized = sumAmp > 0 ? clamp01(value / sumAmp) : 0;
    return normalized * 2 - 1;
}

function scoreSignalContribution(key, signals, biomeSignals, worldX, worldY, baseSeed) {
    const rule = biomeSignals?.[key];
    const value = signals?.[key];
    if (value == null || !rule) {
        return { weighted: 0, weight: 0 };
    }

    const weight = rule.weight ?? 1.0;
    const ditherSeed = toUint32(baseSeed + (SIGNAL_DITHER_SEED_OFFSETS[key] ?? 0));
    const score = scoreSignal(value, rule, worldX, worldY, ditherSeed);
    return { weighted: score * weight, weight };
}

/**
 * Regional variation noise mirrored from biomeScoring.wgsl.js.
 * simple/perlin use single-octave sampling; fbm/ridged_fbm are capped to
 * a short octave chain so data-driven biome scoring stays lightweight.
 * @param {number} x      Biome-space X coordinate
 * @param {number} y      Biome-space Y coordinate
 * @param {object} rv     Regional variation config { noiseScale, noiseStrength, seedOffset }
 * @param {number} seed   World seed
 * @returns {number}       -1..1
 */
export function regionalNoise(x, y, rv, seed) {
    if (!rv || rv.noiseStrength === 0) return 0;
    const scale = rv.noiseScale ?? 0.001;
    const seedOff = rv.seedOffset ?? 0;
    const noiseSeed = toUint32(toUint32(seed) + toUint32(seedOff));
    switch (rv.noiseType) {
        case 'perlin':
            return samplePerlinNoise(x, y, scale, noiseSeed);
        case 'fbm':
            return sampleFbmNoise(x, y, scale, noiseSeed);
        case 'ridged_fbm':
            return sampleRidgedFbmNoise(x, y, scale, noiseSeed);
        case 'simplex':
        default:
            return sampleSimplexNoise(x, y, scale, noiseSeed);
    }
}

/**
 * Compute final occurrence scores for all biomes at a world position.
 *
 * @param {Array<object>} biomeDefs   Array of biome definitions from biomes.json
 * @param {object} signals            { elevation, humidity, temperature, slope }
 * @param {number} worldX             Terrain sample X coordinate (sphere: unitDir.x * noiseReferenceRadiusM, flat: world x)
 * @param {number} worldY             Terrain sample Y coordinate (sphere: unitDir.z * noiseReferenceRadiusM, flat: world y)
 * @param {number} seed               World seed
 * @returns {Array<{biome: object, envScore: number, regionalFactor: number, finalScore: number, probability: number}>}
 */
export function scoreBiomes(biomeDefs, signals, worldX, worldY, seed) {
    if (!biomeDefs || biomeDefs.length === 0) return [];

    const scores = biomeDefs.map(biome => {
        const envScore = computeEnvironmentalScore(
            signals,
            biome.signals,
            worldX,
            worldY,
            seed,
            biome?.regionalVariation?.seedOffset ?? 0
        );
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
 * @param {number} worldX             Terrain sample X coordinate (sphere: unitDir.x * noiseReferenceRadiusM, flat: world x)
 * @param {number} worldY             Terrain sample Y coordinate (sphere: unitDir.z * noiseReferenceRadiusM, flat: world y)
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
