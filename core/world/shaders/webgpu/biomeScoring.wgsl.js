/**
 * biomeScoring.wgsl.js — Generates WGSL functions for biome scoring.
 *
 * Produces a data-driven biome selection function that consumes biome
 * definitions from a uniform buffer. This replaces the old hard-coded
 * tile-type selection logic with a configurable probability-based system.
 *
 * The generated shader provides:
 *   - scoreBiomeSignal()    — per-signal scoring
 *   - scoreBiomeEnv()       — weighted environmental suitability
 *   - selectBiomeFromDefs() — full pipeline: score → normalize → select
 */

/**
 * Build the WGSL biome scoring and selection functions.
 *
 * @param {object} options
 * @param {number} options.maxBiomes  Maximum biome count supported (compile-time constant)
 * @returns {string}  WGSL source
 */
export function createBiomeScoringWGSL(options = {}) {
    const maxBiomes = options.maxBiomes ?? 16;

    return /* wgsl */`
// ── Biome definition structs (populated from uniform buffer) ────────

const MAX_BIOMES: u32 = ${maxBiomes}u;
const SIGNAL_DITHER_SEED_ELEVATION: u32 = 101u;
const SIGNAL_DITHER_SEED_HUMIDITY: u32 = 211u;
const SIGNAL_DITHER_SEED_TEMPERATURE: u32 = 307u;
const SIGNAL_DITHER_SEED_SLOPE: u32 = 401u;
const BIOME_NOISE_MODE_SIMPLEX: u32 = 0u;
const BIOME_NOISE_MODE_PERLIN: u32 = 1u;
const BIOME_NOISE_MODE_FBM: u32 = 2u;
const BIOME_NOISE_MODE_RIDGED_FBM: u32 = 3u;
const BIOME_REGIONAL_OCTAVES: i32 = 3;
const BIOME_NOISE_LACUNARITY: f32 = 2.0;
const BIOME_NOISE_GAIN: f32 = 0.5;
const BIOME_RIDGED_OFFSET: f32 = 1.0;
const SIMPLEX_F2: f32 = 0.3660254037844386;
const SIMPLEX_G2: f32 = 0.21132486540518713;

struct BiomeSignalRule {
    min_val:          f32,
    max_val:          f32,
    transitionWidth:  f32,
    preference:       f32,   // 0=low, 0.5=mid, 1=high
    ditherScale:      f32,
    ditherStrength:   f32,
    weight:           f32,
    _pad:             f32,
};

struct BiomeDef {
    baseWeight:    f32,
    tileId:        u32,     // TILE_TYPES integer for this biome
    noiseType:     u32,     // 0=simplex, 1=perlin, 2=fbm, 3=ridged_fbm
    noiseScale:    f32,
    noiseStrength: f32,
    seedOffset:    u32,
    _pad0:         f32,
    _pad1:         f32,
    elevation:     BiomeSignalRule,
    humidity:      BiomeSignalRule,
    temperature:   BiomeSignalRule,
    slope:         BiomeSignalRule,
};

struct BiomeUniforms {
    biomeCount:    u32,
    worldSeed:     u32,
    _pad0:         u32,
    _pad1:         u32,
    biomes:        array<BiomeDef, MAX_BIOMES>,
};

// ── Signal scoring ──────────────────────────────────────────────────

fn biomeValueNoise(wx: f32, wy: f32, scale: f32, seed: u32) -> f32 {
    if (scale <= 0.0) { return 0.0; }

    let sx = wx * scale;
    let sy = wy * scale;
    let ix = i32(floor(sx));
    let iy = i32(floor(sy));
    let fx = sx - floor(sx);
    let fy = sy - floor(sy);

    let n00 = biomeHashFromCells(ix, iy, seed) * 2.0 - 1.0;
    let n10 = biomeHashFromCells(ix + 1, iy, seed) * 2.0 - 1.0;
    let n01 = biomeHashFromCells(ix, iy + 1, seed) * 2.0 - 1.0;
    let n11 = biomeHashFromCells(ix + 1, iy + 1, seed) * 2.0 - 1.0;

    let u = fx * fx * (3.0 - 2.0 * fx);
    let v = fy * fy * (3.0 - 2.0 * fy);
    let x0 = mix(n00, n10, u);
    let x1 = mix(n01, n11, u);
    return clamp(mix(x0, x1, v), -1.0, 1.0);
}

fn biomeFadeQuintic(t: f32) -> f32 {
    return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

fn biomeGrad2(hash: u32, x: f32, y: f32) -> f32 {
    let g = hash & 7u;
    let u = select(y, x, g < 4u);
    let v = select(x, y, g < 4u);
    let su = select(-u, u, (g & 1u) == 0u);
    let sv = select(-v, v, (g & 2u) == 0u);
    return su + sv;
}

fn biomePerlinNoise(wx: f32, wy: f32, scale: f32, seed: u32) -> f32 {
    if (scale <= 0.0) { return 0.0; }

    let sx = wx * scale;
    let sy = wy * scale;
    let ix = i32(floor(sx));
    let iy = i32(floor(sy));
    let fx = sx - f32(ix);
    let fy = sy - f32(iy);
    let u = biomeFadeQuintic(fx);
    let v = biomeFadeQuintic(fy);

    let n00 = biomeGrad2(biomeHashUint(ix, iy, seed), fx, fy);
    let n10 = biomeGrad2(biomeHashUint(ix + 1, iy, seed), fx - 1.0, fy);
    let n01 = biomeGrad2(biomeHashUint(ix, iy + 1, seed), fx, fy - 1.0);
    let n11 = biomeGrad2(biomeHashUint(ix + 1, iy + 1, seed), fx - 1.0, fy - 1.0);

    let x0 = mix(n00, n10, u);
    let x1 = mix(n01, n11, u);
    return clamp(mix(x0, x1, v), -1.0, 1.0);
}

fn biomeSimplexNoise(wx: f32, wy: f32, scale: f32, seed: u32) -> f32 {
    if (scale <= 0.0) { return 0.0; }

    let sx = wx * scale;
    let sy = wy * scale;
    let skew = (sx + sy) * SIMPLEX_F2;
    let i = i32(floor(sx + skew));
    let j = i32(floor(sy + skew));
    let unskew = f32(i + j) * SIMPLEX_G2;
    let x0 = sx - (f32(i) - unskew);
    let y0 = sy - (f32(j) - unskew);
    let lowerTriangle = x0 > y0;
    let i1 = select(0i, 1i, lowerTriangle);
    let j1 = select(1i, 0i, lowerTriangle);
    let x1 = x0 - f32(i1) + SIMPLEX_G2;
    let y1 = y0 - f32(j1) + SIMPLEX_G2;
    let x2 = x0 - 1.0 + 2.0 * SIMPLEX_G2;
    let y2 = y0 - 1.0 + 2.0 * SIMPLEX_G2;

    var n0 = 0.0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0.0) {
        let t0sq = t0 * t0;
        n0 = t0sq * t0sq * biomeGrad2(biomeHashUint(i, j, seed), x0, y0);
    }

    var n1 = 0.0;
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0.0) {
        let t1sq = t1 * t1;
        n1 = t1sq * t1sq * biomeGrad2(biomeHashUint(i + i1, j + j1, seed), x1, y1);
    }

    var n2 = 0.0;
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0.0) {
        let t2sq = t2 * t2;
        n2 = t2sq * t2sq * biomeGrad2(biomeHashUint(i + 1, j + 1, seed), x2, y2);
    }

    return clamp((n0 + n1 + n2) * 70.0, -1.0, 1.0);
}

fn biomeFbmNoise(wx: f32, wy: f32, scale: f32, seed: u32) -> f32 {
    if (scale <= 0.0) { return 0.0; }

    var value = 0.0;
    var amp = 1.0;
    var freq = 1.0;
    var sumAmp = 0.0;

    // Keep authored regional variation cheap enough for per-biome O(n) scoring.
    for (var octave = 0; octave < BIOME_REGIONAL_OCTAVES; octave++) {
        value += biomePerlinNoise(wx, wy, scale * freq, seed + u32(octave)) * amp;
        sumAmp += amp;
        amp *= BIOME_NOISE_GAIN;
        freq *= BIOME_NOISE_LACUNARITY;
    }

    return clamp(value / max(sumAmp, 1e-6), -1.0, 1.0);
}

fn biomeRidgedFbmNoise(wx: f32, wy: f32, scale: f32, seed: u32) -> f32 {
    if (scale <= 0.0) { return 0.0; }

    var value = 0.0;
    var amplitude = 1.0;
    var frequency = 1.0;
    var weight = 1.0;
    var sumAmp = 0.0;

    for (var octave = 0; octave < BIOME_REGIONAL_OCTAVES; octave++) {
        var signal = biomePerlinNoise(wx, wy, scale * frequency, seed + u32(octave));
        signal = BIOME_RIDGED_OFFSET - abs(signal);
        signal = signal * signal;
        signal *= weight;

        weight = clamp(signal * amplitude, 0.0, 1.0);
        value += signal * amplitude;
        sumAmp += amplitude;

        amplitude *= BIOME_NOISE_GAIN;
        frequency *= BIOME_NOISE_LACUNARITY;
    }

    let normalized = clamp(value / max(sumAmp, 1e-6), 0.0, 1.0);
    return normalized * 2.0 - 1.0;
}

fn scoreBiomeSignal(value: f32, rule: BiomeSignalRule, wx: f32, wy: f32, seed: u32) -> f32 {
    if (rule.weight <= 0.0) { return 1.0; }

    let tw = max(rule.transitionWidth, 0.001);
    var edgeValue = value;
    if (rule.ditherScale > 0.0 && rule.ditherStrength > 0.0) {
        edgeValue += biomeValueNoise(wx, wy, rule.ditherScale, seed) * tw * rule.ditherStrength;
    }

    var band: f32;
    if (edgeValue < rule.min_val) {
        band = max(0.0, 1.0 - (rule.min_val - edgeValue) / tw);
    } else if (edgeValue > rule.max_val) {
        band = max(0.0, 1.0 - (edgeValue - rule.max_val) / tw);
    } else {
        band = 1.0;
    }

    let range = rule.max_val - rule.min_val;
    var pref = 1.0;
    if (range > 0.001) {
        let t = clamp((value - rule.min_val) / range, 0.0, 1.0);
        if (rule.preference < 0.25) {
            // low preference
            pref = 1.0 - t * 0.5;
        } else if (rule.preference > 0.75) {
            // high preference
            pref = 0.5 + t * 0.5;
        }
        // mid: flat 1.0
    }

    return band * pref;
}

// ── Environmental suitability ───────────────────────────────────────

fn scoreBiomeEnv(
    elevation: f32, humidity: f32, temperature: f32, slope: f32,
    def: BiomeDef, wx: f32, wy: f32, seed: u32
) -> f32 {
    var totalWeight = 0.0;
    var weightedSum = 0.0;
    let biomeSeed = seed + def.seedOffset;

    let se = scoreBiomeSignal(elevation, def.elevation, wx, wy, biomeSeed + SIGNAL_DITHER_SEED_ELEVATION);
    weightedSum += se * def.elevation.weight;
    totalWeight += def.elevation.weight;

    let sh = scoreBiomeSignal(humidity, def.humidity, wx, wy, biomeSeed + SIGNAL_DITHER_SEED_HUMIDITY);
    weightedSum += sh * def.humidity.weight;
    totalWeight += def.humidity.weight;

    let st = scoreBiomeSignal(temperature, def.temperature, wx, wy, biomeSeed + SIGNAL_DITHER_SEED_TEMPERATURE);
    weightedSum += st * def.temperature.weight;
    totalWeight += def.temperature.weight;

    let ss = scoreBiomeSignal(slope, def.slope, wx, wy, biomeSeed + SIGNAL_DITHER_SEED_SLOPE);
    weightedSum += ss * def.slope.weight;
    totalWeight += def.slope.weight;

    if (totalWeight <= 0.0) { return 1.0; }
    return weightedSum / totalWeight;
}

// ── Deterministic seeded hash ───────────────────────────────────────

fn biomeHashUint(cellX: i32, cellY: i32, seed: u32) -> u32 {
    var h = seed;
    h ^= bitcast<u32>(cellX) * 0x27d4eb2du;
    h ^= bitcast<u32>(cellY) * 0x165667b1u;
    h = ((h >> 15u) ^ h) * 0x85ebca6bu;
    h = ((h >> 13u) ^ h) * 0xc2b2ae35u;
    h = ((h >> 16u) ^ h) * 0x45d9f3bu;
    h = ((h >> 16u) ^ h) * 0x45d9f3bu;
    return (h >> 16u) ^ h;
}

fn biomeHashFromCells(cellX: i32, cellY: i32, seed: u32) -> f32 {
    let h = biomeHashUint(cellX, cellY, seed);
    return f32(h & 0x7FFFFFFFu) / f32(0x7FFFFFFF);
}

fn biomeSelectionHash(wx: f32, wy: f32, seed: u32) -> f32 {
    let cellX = i32(floor(wx * 0.125));
    let cellY = i32(floor(wy * 0.125));
    return biomeHashFromCells(cellX, cellY, seed + 99999u);
}

// ── Regional variation noise ─────────────────────────────────────────

fn biomeRegionalNoise(wx: f32, wy: f32, def: BiomeDef, seed: u32) -> f32 {
    if (def.noiseStrength <= 0.0 || def.noiseScale <= 0.0) { return 0.0; }

    let s = seed + def.seedOffset;
    if (def.noiseType == BIOME_NOISE_MODE_PERLIN) {
        return biomePerlinNoise(wx, wy, def.noiseScale, s);
    }
    if (def.noiseType == BIOME_NOISE_MODE_FBM) {
        return biomeFbmNoise(wx, wy, def.noiseScale, s);
    }
    if (def.noiseType == BIOME_NOISE_MODE_RIDGED_FBM) {
        return biomeRidgedFbmNoise(wx, wy, def.noiseScale, s);
    }
    return biomeSimplexNoise(wx, wy, def.noiseScale, s);
}

// ── Full biome selection ────────────────────────────────────────────

struct BiomeResult {
    tileId: u32,
    score:  f32,
};

fn selectBiomeFromDefs(
    elevation: f32, humidity: f32, temperature: f32, slope: f32,
    wx: f32, wy: f32, biomeUniforms: BiomeUniforms
) -> BiomeResult {
    let count = min(biomeUniforms.biomeCount, MAX_BIOMES);
    let seed = biomeUniforms.worldSeed;

    // Compute final scores
    var scores: array<f32, MAX_BIOMES>;
    var totalScore = 0.0;

    for (var i = 0u; i < count; i++) {
        let def = biomeUniforms.biomes[i];
        let envScore = scoreBiomeEnv(elevation, humidity, temperature, slope, def, wx, wy, seed);
        let noise = biomeRegionalNoise(wx, wy, def, seed);
        let regional = max(0.0, 1.0 + noise * def.noiseStrength);
        let final_score = envScore * def.baseWeight * regional;
        scores[i] = final_score;
        totalScore += final_score;
    }

    // Normalize and deterministic selection
    var result: BiomeResult;
    result.tileId = 10u; // fallback: GRASS_SHORT_1
    result.score = 0.0;

    if (totalScore <= 0.0 || count == 0u) { return result; }

    let r = biomeSelectionHash(wx, wy, seed);
    var cumulative = 0.0;

    for (var i = 0u; i < count; i++) {
        let prob = scores[i] / totalScore;
        cumulative += prob;
        if (r <= cumulative) {
            result.tileId = biomeUniforms.biomes[i].tileId;
            result.score = prob;
            return result;
        }
    }

    // Fallback: highest score
    var bestIdx = 0u;
    var bestScore = 0.0;
    for (var i = 0u; i < count; i++) {
        if (scores[i] > bestScore) {
            bestScore = scores[i];
            bestIdx = i;
        }
    }
    result.tileId = biomeUniforms.biomes[bestIdx].tileId;
    result.score = scores[bestIdx] / totalScore;
    return result;
}
`;
}
