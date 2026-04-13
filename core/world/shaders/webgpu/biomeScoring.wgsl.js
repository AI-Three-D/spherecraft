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
    noiseType:     u32,     // Reserved for future multi-mode biome noise selection.
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

fn scoreBiomeSignal(value: f32, rule: BiomeSignalRule) -> f32 {
    if (rule.weight <= 0.0) { return 1.0; }

    let tw = max(rule.transitionWidth, 0.001);
    var band: f32;
    if (value < rule.min_val) {
        band = max(0.0, 1.0 - (rule.min_val - value) / tw);
    } else if (value > rule.max_val) {
        band = max(0.0, 1.0 - (value - rule.max_val) / tw);
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
    def: BiomeDef
) -> f32 {
    var totalWeight = 0.0;
    var weightedSum = 0.0;

    let se = scoreBiomeSignal(elevation, def.elevation);
    weightedSum += se * def.elevation.weight;
    totalWeight += def.elevation.weight;

    let sh = scoreBiomeSignal(humidity, def.humidity);
    weightedSum += sh * def.humidity.weight;
    totalWeight += def.humidity.weight;

    let st = scoreBiomeSignal(temperature, def.temperature);
    weightedSum += st * def.temperature.weight;
    totalWeight += def.temperature.weight;

    let ss = scoreBiomeSignal(slope, def.slope);
    weightedSum += ss * def.slope.weight;
    totalWeight += def.slope.weight;

    if (totalWeight <= 0.0) { return 1.0; }
    return weightedSum / totalWeight;
}

// ── Deterministic seeded hash ───────────────────────────────────────

fn biomeHashFromCells(cellX: i32, cellY: i32, seed: u32) -> f32 {
    var h = seed;
    h ^= bitcast<u32>(cellX) * 0x27d4eb2du;
    h ^= bitcast<u32>(cellY) * 0x165667b1u;
    h = ((h >> 15u) ^ h) * 0x85ebca6bu;
    h = ((h >> 13u) ^ h) * 0xc2b2ae35u;
    h = ((h >> 16u) ^ h) * 0x45d9f3bu;
    h = ((h >> 16u) ^ h) * 0x45d9f3bu;
    h = (h >> 16u) ^ h;
    return f32(h & 0x7FFFFFFFu) / f32(0x7FFFFFFF);
}

fn biomeSelectionHash(wx: f32, wy: f32, seed: u32) -> f32 {
    let cellX = i32(floor(wx * 0.125));
    let cellY = i32(floor(wy * 0.125));
    return biomeHashFromCells(cellX, cellY, seed + 99999u);
}

// ── Regional variation noise (simple value noise) ───────────────────

fn biomeRegionalNoise(wx: f32, wy: f32, def: BiomeDef, seed: u32) -> f32 {
    if (def.noiseStrength <= 0.0) { return 0.0; }
    // noiseType is packed already so the JS/WGSL buffer layout stays stable.
    // This increment still uses the same value-noise path for all authored modes.

    let sx = wx * def.noiseScale;
    let sy = wy * def.noiseScale;
    let s = seed + def.seedOffset;

    let ix = i32(floor(sx));
    let iy = i32(floor(sy));
    let fx = sx - floor(sx);
    let fy = sy - floor(sy);

    let n00 = biomeHashFromCells(ix, iy, s) * 2.0 - 1.0;
    let n10 = biomeHashFromCells(ix + 1, iy, s) * 2.0 - 1.0;
    let n01 = biomeHashFromCells(ix, iy + 1, s) * 2.0 - 1.0;
    let n11 = biomeHashFromCells(ix + 1, iy + 1, s) * 2.0 - 1.0;

    let u = fx * fx * (3.0 - 2.0 * fx);
    let v = fy * fy * (3.0 - 2.0 * fy);

    let x0 = mix(n00, n10, u);
    let x1 = mix(n01, n11, u);
    return mix(x0, x1, v);
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
        let envScore = scoreBiomeEnv(elevation, humidity, temperature, slope, def);
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
