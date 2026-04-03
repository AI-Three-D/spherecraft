export const TERRAIN_NOISE_GLSL = `
// Hash function for procedural generation
uint hash2d(ivec2 p, int seed) {
    uint h = uint(p.x) * 374761393u + uint(p.y) * 668265263u + uint(seed) * 982451653u;
    h ^= (h >> 13u);
    h *= 1274126177u;
    h ^= (h >> 16u);
    return h;
}

// Fade function for smooth interpolation
float fade(float t) { 
    return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); 
}

// Gradient function for Perlin noise
float grad(uint h, float x, float y) {
    uint g = h & 7u;
    float u = (g < 4u) ? x : y;
    float v = (g < 4u) ? y : x;
    return ((g & 1u) == 0u ? u : -u) + ((g & 2u) == 0u ? v : -v);
}

// 2D Perlin noise
float perlin2D(float x, float y, int seed) {
    int ix = int(floor(x));
    int iy = int(floor(y));
    float fx = x - float(ix);
    float fy = y - float(iy);
    float u = fade(fx);
    float v = fade(fy);

    uint a = hash2d(ivec2(ix, iy), seed);
    uint b = hash2d(ivec2(ix + 1, iy), seed);
    uint c = hash2d(ivec2(ix, iy + 1), seed);
    uint d = hash2d(ivec2(ix + 1, iy + 1), seed);

    float x1 = mix(grad(a, fx, fy), grad(b, fx - 1.0, fy), u);
    float x2 = mix(grad(c, fx, fy - 1.0), grad(d, fx - 1.0, fy - 1.0), u);
    return mix(x1, x2, v);
}

// Octave noise (fractal Brownian motion)
float octaveNoise(float x, float y, int octaves, int seed) {
    float value = 0.0;
    float amplitude = 1.0;
    float frequency = 1.0;
    float maxValue = 0.0;
    
    for (int i = 0; i < 16; i++) {
        if (i >= octaves) break;
        value += perlin2D(x * frequency, y * frequency, seed) * amplitude;
        maxValue += amplitude;
        amplitude *= 0.5;
        frequency *= 2.0;
    }
    
    return value / maxValue;
}

// Ridged noise for mountain features
float ridgedNoise(float x, float y, int octaves, int seed) {
    float value = 0.0;
    float amplitude = 1.0;
    float frequency = 1.0;
    float maxValue = 0.0;
    
    for (int i = 0; i < 16; i++) {
        if (i >= octaves) break;
        float n = 1.0 - abs(perlin2D(x * frequency, y * frequency, seed));
        value += n * n * amplitude;
        maxValue += amplitude;
        amplitude *= 0.5;
        frequency *= 2.0;
    }
    
    return value / maxValue;
}

// Biome mask for terrain blending
float biomeMask(float wx, float wy, int seed) {
    float b = octaveNoise(wx * 0.004, wy * 0.004, 3, seed);
    return clamp((b + 1.0) * 0.5, 0.0, 1.0);
}

// 45-degree rotation helper
vec2 rotate45(vec2 v) {
    float s = 0.70710678;
    return vec2(v.x * s - v.y * s, v.x * s + v.y * s);
}

// Domain warping for natural-looking terrain
vec2 warp(vec2 p, int seed) {
    float w0 = octaveNoise(p.x * 0.001, p.y * 0.001, 2, seed) * 15.0;
    float w1 = octaveNoise((p.x + 39784.0) * 0.001, (p.y - 9083.0) * 0.001, 2, seed) * 15.0;
    return p + vec2(w0, w1);
}

// Regional roughness for terrain variation
float regionRoughness(float wx, float wy, int seed) {
    float noise = octaveNoise(wx * 0.00007, wy * 0.00007, 2, seed);
    return clamp(0.25 + 0.75 * noise, 0.0, 1.0);
}

// Main terrain height function
float terrainHeight(float wx, float wy, int seed, float elevationScale, float heightScale) {
    float biome = biomeMask(wx, wy, seed);
    float plainsZone = 0.4;
    float mountainZone = 0.6;
    float blend = smoothstep(plainsZone, mountainZone, biome);

    // Plains generation
    float plainsBase = octaveNoise(wx * 0.005, wy * 0.005, 2, seed) * 0.10;
    float plainsDetail = octaveNoise(wx * 0.03, wy * 0.03, 2, seed) * 0.07;
    float plains = clamp(plainsBase + plainsDetail, -1.0, 1.0);

    // Mountain generation with domain warping
    vec2 warped = warp(vec2(wx, wy), seed);
    vec2 rotated = rotate45(warped);
    float roughness = regionRoughness(wx, wy, seed);

    float baseScale = elevationScale * mix(1.0, 0.36, roughness);
    float amplitude = mix(0.8, 1.6, roughness);
    float mountainBase = octaveNoise(rotated.x * baseScale, rotated.y * baseScale, 6, seed) * amplitude;
    float mountainRidge = ridgedNoise(rotated.x * 0.004, rotated.y * 0.004, 2, seed);
    float mountains = mix(mountainBase, mountainRidge, roughness);
    
    float elevation = mix(plains, pow((mountains + 1.0) * 0.5, 1.25), blend);

    return elevation * heightScale;
}

// Determine tile type based on height, slope, and noise
uint determineTerrain(float h, float slope, float wx, float wy, int seed) {
    if (h <= 0.0) return 0u; // WATER_1

    // Rock on steep slopes
    float rockSlope = smoothstep(0.35, 0.70, slope);
    float nLarge = octaveNoise(wx * 0.0006, wy * 0.0006, 2, seed + 7000) * 0.5 + 0.5;
    float rockProb = rockSlope * mix(0.3, 1.0, nLarge);
    if (rockProb > 0.5) return 42u; // ROCK_OUTCROP_1

    // Climate-like precipitation + temperature noise for biome selection
    float precip = octaveNoise(wx * 0.0004, wy * 0.0004, 3, seed + 5000) * 0.5 + 0.5;
    float temp = octaveNoise(wx * 0.00025, wy * 0.00025, 2, seed + 5400) * 0.5 + 0.5;
    float biomeDetail = octaveNoise(wx * 0.002, wy * 0.002, 2, seed + 6300) * 0.5 + 0.5;

    // Snow/ice in cold areas
    if (temp < 0.18) return 138u; // SNOW_ICE_1
    if (temp < 0.28) return 134u; // SNOW_PACK_1
    if (temp < 0.35 && precip > 0.4) return 130u; // SNOW_FRESH_1
    if (temp < 0.42 && precip > 0.35) return 54u; // TUNDRA_BARREN_1

    // Cold + dry dirt fields
    if (temp < 0.30 && precip < 0.25 && biomeDetail > 0.55) return 94u; // DIRT_DRY_1

    // Forest floor in wet areas
    if (precip > 0.55) {
        float forestN = octaveNoise(wx * 0.001, wy * 0.001, 3, seed + 7200) * 0.5 + 0.5;
        if (forestN > 0.45) {
            float densityN = octaveNoise(wx * 0.0007, wy * 0.0007, 2, seed + 7210) * 0.5 + 0.5;
            float mixedN = octaveNoise(wx * 0.0016, wy * 0.0016, 2, seed + 7220) * 0.5 + 0.5;
            float mixedPatch = octaveNoise(wx * 0.0035, wy * 0.0035, 2, seed + 7230) * 0.5 + 0.5;

            bool dense = (densityN + precip * 0.6) > 0.75;
            bool mixed = (mixedN + (precip - 0.5) * 0.8) > 0.55;
            if (!mixed && mixedPatch > 0.85) mixed = true; // small mixed subpatches

            // Tropical forests (hot + wet)
            if (temp > 0.70 && precip > 0.65) {
                float tropN = octaveNoise(wx * 0.0012, wy * 0.0012, 2, seed + 9360) * 0.5 + 0.5;
                if (tropN + (precip - 0.7) * 0.6 > 0.6) return 142u; // FOREST_RAINFOREST_1
                return 146u; // FOREST_JUNGLE_1
            }

            if (mixed) {
                return dense ? 74u : 78u; // FOREST_DENSE_MIXED_1 / FOREST_SPARSE_MIXED_1
            }
            return dense ? 66u : 70u; // FOREST_DENSE_SINGLE_1 / FOREST_SPARSE_SINGLE_1
        }
    }

    // Mud patches in humid areas
    if (precip > 0.7 && slope < 0.35 && biomeDetail > 0.6) return 106u; // MUD_WET_1

    // Grass in moderate+ precipitation (choose category)
    if (precip > 0.25) {
        float gLarge = octaveNoise(wx * 0.001, wy * 0.001, 2, seed + 9100) * 0.5 + 0.5;
        float gMid = octaveNoise(wx * 0.003, wy * 0.003, 2, seed + 9110) * 0.5 + 0.5;
        float gSmall = octaveNoise(wx * 0.010, wy * 0.010, 2, seed + 9120) * 0.5 + 0.5;
        float gNoise = gLarge * 0.5 + gMid * 0.3 + gSmall * 0.2;

        float meadowNoise = octaveNoise(wx * 0.0006, wy * 0.0006, 2, seed + 9135) * 0.5 + 0.5;
        float tallNoise = octaveNoise(wx * 0.004, wy * 0.004, 2, seed + 9140) * 0.5 + 0.5;
        float flowerNoise = octaveNoise(wx * 0.0016, wy * 0.0016, 2, seed + 9150) * 0.5 + 0.5;

        if (flowerNoise > 0.72) return 26u; // GRASS_FLOWER_FIELD_1
        if (tallNoise > 0.55) return 18u;   // GRASS_TALL_1
        if (meadowNoise > 0.60) return 22u; // GRASS_MEADOW_1
        if (gNoise > 0.45) return 14u;      // GRASS_MEDIUM_1
        return 10u;                         // GRASS_SHORT_1
    }

    // Dirt buffer between grass and sand (narrow band)
    if (precip > 0.20 && precip < 0.32 && biomeDetail > 0.45) return 94u; // DIRT_DRY_1

    // Hot + dry => desert sand
    if (temp > 0.7 && precip < 0.3) return 30u; // SAND_COARSE_1

    // Sand in dry areas
    return 30u; // SAND_COARSE_1
}
`;
