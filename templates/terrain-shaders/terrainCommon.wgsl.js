// js/world/shaders/webgpu/terrain/terrainCommon.wgsl.js

export function createTerrainCommon() {
  return `
// ==================== Terrain Common ====================

const PI: f32 = 3.14159265;

const RARITY_COMMON: i32 = 0;
const RARITY_UNCOMMON: i32 = 1;
const RARITY_RARE: i32 = 2;
const RARITY_VERY_RARE: i32 = 3;
const RARITY_EXCEPTIONAL: i32 = 4;

// Large-scale tiers use planet-count-based rarity.
const RARITY_COUNT_SCALE_THRESHOLD: f32 = 50.0; // geology units (~50 km)
const RARITY_SOFTNESS: f32 = 0.08;

struct TerrainProfile {
    baseBias: f32,
    mountainBias: f32,
    hillBias: f32,
    canyonBias: f32,
    rareBoost: f32,
    warpStrength: f32,
    ridgeSharpness: f32,
    microGain: f32,
};

struct RegionalInfo {
    isLand: bool,
    landMask: f32,
    terrainType: f32,
    tectonicActivity: f32,
    ruggedness: f32,
    baseElevation: f32,
};

struct TerrainAmplitudes {
    oceanDepth: f32,
    continentalShelf: f32,
    plainsVariation: f32,
    hillsHeight: f32,
    loneHillsHeight: f32,
    mountainBase: f32,
    mountainPeaks: f32,
    exceptionalPeaks: f32,
    canyonDepth: f32,
    microGain: f32,
    highlandsHeight: f32,
};

fn getTerrainProfile() -> TerrainProfile {
    var profile: TerrainProfile;

    profile.baseBias = clamp(uniforms._pad3.x, 0.0, 5.0);
    profile.mountainBias = clamp(uniforms._pad3.y, 0.0, 5.0);
    profile.hillBias = clamp(uniforms._pad3.z, 0.0, 5.0);
    profile.canyonBias = clamp(uniforms._pad3.w, 0.0, 5.0);

    profile.rareBoost = clamp(uniforms._pad4.x, 0.0, 5.0);
    profile.warpStrength = clamp(uniforms._pad4.y, 0.0, 5.0);
    profile.ridgeSharpness = clamp(uniforms._pad4.z, 0.0, 5.0);
    profile.microGain = clamp(uniforms._pad4.w, 0.0, 5.0);

    return profile;
}

// ==================== Noise wrappers ====================

fn noiseReferenceRadiusM() -> f32 {
    return max(uniforms._pad2.x, 1.0);
}

fn smallPlanetMode() -> bool {
    return uniforms._pad2.y > 0.5;
}

fn maxTerrainHeightM() -> f32 {
    return max(uniforms._pad2.z, 1.0);
}

// Correct height-to-radius ratio for normal computation on the unit sphere.
// Must match the vertex shader: radius = planetRadius + height * maxTerrainHeight.
fn normalDisplacementScale() -> f32 {
    return maxTerrainHeightM() / noiseReferenceRadiusM();
}

fn saturate(x: f32) -> f32 { return clamp(x, 0.0, 1.0); }

// Adds irregular perimeter without creating a hard band.
// Works by modulating the input noise near the threshold.
fn irregularizeNoiseNearBase(n: f32, threshold: f32, edgeN: f32, strength: f32) -> f32 {
    // baseBand ~1 near the foot of the hill (where n is around threshold/threshold-extend)
    // We approximate "near base" by looking at how close n is to threshold.
    let band = 1.0 - smoothstep(0.0, 0.20, abs(n - threshold));
    return n + edgeN * strength * band;
}

// Carves cuts into the slope by subtracting from the *height* (not the noise),
// limited to mid-slope so it doesn't create a ring at the base.
fn applySlopeCuts(h: f32, cutN: f32, amount: f32) -> f32 {
    // Only affect mid-slope: not at base (h~0) and not at top (h~1)
    let band = smoothstep(0.12, 0.40, h) * (1.0 - smoothstep(0.70, 0.92, h));
    let n = saturate(cutN * 0.5 + 0.5);
    let cuts = band * amount * pow(n, 2.2);
    return max(h - cuts, 0.0);
}

// Two-peak blend: combines two domes (same underlying noise, different scales/warps)
// without multiplying unrelated fields.
fn twoPeakBlend(a: f32, b: f32) -> f32 {
    // soft max-ish blend
    let k = 0.10;
    let m = max(a, b);
    let d = abs(a - b);
    let t = saturate(d / k);
    return mix((a + b) * 0.5, m, t);
}

fn clampMacroScaleToPlanet(scale: f32) -> f32 {
    if (uniforms.face < 0) {
        return scale;
    }
    let R = noiseReferenceRadiusM();
    let maxWavelength = 6.283185307 * R / MIN_MACRO_CYCLES;
    let maxScale = maxWavelength / GEOLOGY_SCALE;
    return min(scale, maxScale);
}

fn fbmAuto(
    wx: f32, wy: f32, unitDir: vec3<f32>, scale: f32,
    octaves: i32, seed: i32, lac: f32, gain: f32
) -> f32 {
    if (uniforms.face >= 0) {
        return fbmMetricSphere3D(unitDir, scale, GEOLOGY_SCALE, noiseReferenceRadiusM(), octaves, seed, lac, gain);
    }
    return fbmMetricFlat2D(wx, wy, scale, GEOLOGY_SCALE, octaves, seed, lac, gain);
}

fn ridgedAuto(
    wx: f32, wy: f32, unitDir: vec3<f32>, scale: f32,
    octaves: i32, seed: i32, lac: f32, gain: f32, offset: f32
) -> f32 {
    if (uniforms.face >= 0) {
        return ridgedMetricSphere3D(unitDir, scale, GEOLOGY_SCALE, noiseReferenceRadiusM(), octaves, seed, lac, gain, offset);
    }
    return ridgedMetricFlat2D(wx, wy, scale, GEOLOGY_SCALE, octaves, seed, lac, gain, offset);
}

fn billowAuto(
    wx: f32, wy: f32, unitDir: vec3<f32>, scale: f32,
    octaves: i32, seed: i32, lac: f32, gain: f32
) -> f32 {
    let n = fbmAuto(wx, wy, unitDir, scale, octaves, seed, lac, gain);
    return abs(n);
}

fn warpDirAuto(unitDir: vec3<f32>, scale: f32, strength: f32, seed: i32) -> vec3<f32> {
    let wxp = fbmAuto(0.0, 0.0, unitDir, scale, 3, seed, 2.0, 0.5);
    let wyp = fbmAuto(0.0, 0.0, unitDir, scale, 3, seed + 11, 2.0, 0.5);
    let wzp = fbmAuto(0.0, 0.0, unitDir, scale, 3, seed + 23, 2.0, 0.5);
    return normalize(unitDir + vec3<f32>(wxp, wyp, wzp) * strength);
}

fn warpFlatAuto(wx: f32, wy: f32, unitDir: vec3<f32>, scale: f32, strength: f32, seed: i32) -> vec2<f32> {
    let warp = fbmAuto(wx, wy, unitDir, scale, 3, seed, 2.0, 0.5) * strength;
    return vec2<f32>(wx + warp, wy - warp);
}

// ==================== Coverage / rarity helpers ====================

fn coverageThreshold(coverage: f32) -> f32 {
    return mix(0.65, -0.65, clamp(coverage, 0.0, 1.0));
}

fn sparseMaskAuto(
    wx: f32, wy: f32, unitDir: vec3<f32>,
    scale: f32, seed: i32, coverage: f32, softness: f32
) -> f32 {
    let n = fbmAuto(wx, wy, unitDir, scale, 3, seed, 2.0, 0.5);
    let t = coverageThreshold(coverage);
    return smoothstep(t - softness, t + softness, n);
}

fn planetSurfaceArea() -> f32 {
    let R = noiseReferenceRadiusM();
    return 4.0 * PI * R * R;
}

fn coverageFromTargetCount(scale: f32, targetCount: f32) -> f32 {
    let w = wavelength_m(scale, GEOLOGY_SCALE);
    let area = planetSurfaceArea();
    let cellArea = max(w * w, 1.0);
    let cellCount = area / cellArea;
    return clamp(targetCount / max(cellCount, 1.0), 0.0, 1.0);
}

fn tierTargetCount(tier: i32) -> f32 {
    if (tier == RARITY_EXCEPTIONAL) { return 10.0; }
    if (tier == RARITY_VERY_RARE) { return 30.0; }
    if (tier == RARITY_RARE) { return 120.0; }
    if (tier == RARITY_UNCOMMON) { return 600.0; }
    return 2000.0;
}

fn tierCoverageSmall(tier: i32) -> f32 {
    if (tier == RARITY_EXCEPTIONAL) { return 0.02; }
    if (tier == RARITY_VERY_RARE) { return 0.05; }
    if (tier == RARITY_RARE) { return 0.12; }
    if (tier == RARITY_UNCOMMON) { return 0.3; }
    return 0.6;
}

fn rarityCoverage(scale: f32, tier: i32, rareBoost: f32) -> f32 {
    var coverage = 0.0;
    if (scale >= RARITY_COUNT_SCALE_THRESHOLD) {
        coverage = coverageFromTargetCount(scale, tierTargetCount(tier));
    } else {
        let baseCoverage = tierCoverageSmall(tier);
        let t = clamp(scale / RARITY_COUNT_SCALE_THRESHOLD, 0.05, 1.0);
        coverage = mix(baseCoverage * 1.2, baseCoverage, t);
    }
    return clamp(coverage * max(rareBoost, 0.001), 0.0, 1.0);
}

// ==================== Continuous rarity system ====================
// Uses noise-based thresholding instead of discrete cells to avoid hard boundaries.
// The "rarity" is controlled by how much of the noise field exceeds a threshold.

fn rarityNoiseAuto(wx: f32, wy: f32, unitDir: vec3<f32>, scale: f32, seed: i32) -> f32 {
    // Use low-octave FBM for smooth, blob-like regions
    // Add a secondary warp to break up any grid alignment
    let warpScale = scale * 1.7;
    let warpAmt = 0.3;

    var dir = unitDir;
    var wxw = wx;
    var wyw = wy;

    if (uniforms.face >= 0) {
        // Sphere mode: warp the direction slightly for more organic shapes
        let warpX = fbmAuto(0.0, 0.0, unitDir, warpScale, 2, seed + 500, 2.0, 0.5);
        let warpY = fbmAuto(0.0, 0.0, unitDir, warpScale, 2, seed + 501, 2.0, 0.5);
        let warpZ = fbmAuto(0.0, 0.0, unitDir, warpScale, 2, seed + 502, 2.0, 0.5);
        dir = normalize(unitDir + vec3<f32>(warpX, warpY, warpZ) * warpAmt);
    } else {
        // Flat mode: warp coordinates
        let warpX = fbmAuto(wx, wy, unitDir, warpScale, 2, seed + 500, 2.0, 0.5);
        let warpY = fbmAuto(wx, wy, unitDir, warpScale, 2, seed + 501, 2.0, 0.5);
        wxw = wx + warpX * scale * GEOLOGY_SCALE * warpAmt;
        wyw = wy + warpY * scale * GEOLOGY_SCALE * warpAmt;
    }

    // Main noise: 3 octaves for smooth blob shapes with some detail
    return fbmAuto(wxw, wyw, dir, scale, 3, seed, 2.0, 0.5);
}

fn rarityMaskAuto(wx: f32, wy: f32, unitDir: vec3<f32>, scale: f32, seed: i32, tier: i32, rareBoost: f32) -> f32 {
    let coverage = rarityCoverage(scale, tier, rareBoost);

    // Use continuous noise instead of discrete cells
    let n = rarityNoiseAuto(wx, wy, unitDir, scale, seed);

    // Convert coverage to threshold: higher coverage = lower threshold = more area passes
    let threshold = coverageThreshold(coverage);

    // Softness controls the transition width
    let soft = RARITY_SOFTNESS * 2.0;  // Wider transition for smoother blending
    return smoothstep(threshold - soft, threshold + soft, n);
}

// Shape mask: creates soft blob shapes at the given scale
// Uses noise to create organic "island" shapes instead of grid cells
fn cellShapeAuto(wx: f32, wy: f32, unitDir: vec3<f32>, scale: f32, seed: i32, softness: f32) -> f32 {
    // Use ridged noise to create more defined "peaks" / regions
    let n = ridgedAuto(wx, wy, unitDir, scale, 3, seed, 2.0, 0.5, 1.0);
    // Normalize ridged output (typically 0-2 range) and apply softness
    let normalized = clamp(n * 0.5, 0.0, 1.0);
    return smoothstep(1.0 - softness, 1.0, normalized);
}

// Legacy function kept for compatibility but now uses continuous noise
fn cellRandomAuto(wx: f32, wy: f32, unitDir: vec3<f32>, scale: f32, seed: i32) -> f32 {
    // Return continuous noise instead of discrete cell random
    return rarityNoiseAuto(wx, wy, unitDir, scale, seed) * 0.5 + 0.5;
}

// ==================== Height composition utilities ====================

// Soft upper clamp using tanh: smoothly compresses values above (limit - knee)
// toward limit, never exceeding it.
fn softClampMax(value: f32, limit: f32, knee: f32) -> f32 {
    let k = max(knee, 0.001);
    if (value <= limit - k) { return value; }
    let excess = (value - (limit - k)) / k;
    return (limit - k) + k * tanh(excess);
}

// Soft lower clamp: smoothly compresses values below (limit + knee)
// toward limit, never going below it.
fn softClampMin(value: f32, limit: f32, knee: f32) -> f32 {
    let k = max(knee, 0.001);
    if (value >= limit + k) { return value; }
    let deficit = ((limit + k) - value) / k;
    return (limit + k) - k * tanh(deficit);
}

// Bilateral soft clamp: applies both upper and lower soft limits.
fn softClampHeight(value: f32, minH: f32, maxH: f32, knee: f32) -> f32 {
    var h = softClampMax(value, maxH, knee);
    h = softClampMin(h, minH, knee);
    return h;
}

// ==================== Count-based rarity mask ====================
// Forces planet-count-based coverage regardless of scale.
// Use for discrete features (landmarks, hills) where you want
// a specific number of instances per planet.

fn countBasedRarityMask(
    wx: f32, wy: f32, unitDir: vec3<f32>,
    scale: f32, seed: i32, targetCount: f32, rareBoost: f32
) -> f32 {
    let coverage = clamp(
        coverageFromTargetCount(scale, targetCount) * max(rareBoost, 0.001),
        0.0, 1.0
    );
    let n = rarityNoiseAuto(wx, wy, unitDir, scale, seed);
    let threshold = coverageThreshold(coverage);
    let soft = RARITY_SOFTNESS * 2.5;
    return smoothstep(threshold - soft, threshold + soft, n);
}
`;
}
