// js/world/shaders/webgpu/terrain/features/featureHills.wgsl.js

export function createTerrainFeatureHills() {
  return `
// ==================== Feature: Hills ====================

fn featureHillsHeight(
    wx: f32, wy: f32, unitDir: vec3<f32>, seed: i32,
    profile: TerrainProfile, amp: TerrainAmplitudes
) -> f32 {
    let large = fbmAuto(wx, wy, unitDir, SCALE_HILLS_LARGE, 4, seed + 1100, 2.0, 0.5) * 0.45;
    let medium = fbmAuto(wx, wy, unitDir, SCALE_HILLS_MEDIUM, 3, seed + 1200, 2.0, 0.5) * 0.35;
    let small = fbmAuto(wx, wy, unitDir, SCALE_HILLS_SMALL, 2, seed + 1300, 2.0, 0.5) * 0.20;

    let patchMask = sparseMaskAuto(wx, wy, unitDir, SCALE_HILLS_LARGE * 0.8, seed + 1340, 0.4, 0.16);
    let patchBlend = mix(0.3, 1.0, patchMask);

    let uncommonMask = rarityMaskAuto(wx, wy, unitDir, SCALE_HILLS_LARGE * 1.1, seed + 1360, RARITY_UNCOMMON, profile.rareBoost);
    let hillCells = cellShapeAuto(wx, wy, unitDir, SCALE_HILLS_LARGE * 0.8, seed + 1375, 0.55) * uncommonMask;

    return (large + medium + small + hillCells * 0.25) * amp.hillsHeight * profile.hillBias * patchBlend;
}

// ==================== Hills Surface ====================

fn featureHillsSurface(
    wx: f32, wy: f32, unitDir: vec3<f32>, seed: i32,
    slope: f32, elevation: f32,
    profile: TerrainProfile,
    featureWeight: f32
) -> SurfaceWeights {
    var weights = zeroSurfaceWeights();

    if (featureWeight < 0.01) {
        return weights;
    }

    // Hills are predominantly grass-covered
    let grassBase = slopeGrassWeight(slope);

    // Variation in grass coverage
    let grassNoise = fbmAuto(wx, wy, unitDir, SCALE_HILLS_MEDIUM * 0.5, 2, seed + 8700, 2.0, 0.5);
    let grassVariation = smoothstep(0.25, 0.5, grassNoise);
    weights.grass = grassBase * (0.7 + grassVariation * 0.3) * featureWeight;

    // Occasional rock outcrops on hilltops and steeper sides
    let rockNoise = fbmAuto(wx, wy, unitDir, SCALE_HILLS_LARGE * 0.4, 2, seed + 8710, 2.0, 0.5);
    let outcropChance = smoothstep(0.55, 0.75, rockNoise);  // Rare
    let slopeBoost = smoothstep(0.3, 0.5, slope);
    weights.rock = outcropChance * (0.3 + slopeBoost * 0.5) * featureWeight;

    // Dirt patches - exposed soil on slopes
    let dirtBase = slopeDirtWeight(slope);
    let dirtNoise = fbmAuto(wx, wy, unitDir, SCALE_HILLS_SMALL * 0.6, 2, seed + 8720, 2.0, 0.5);
    let dirtVariation = smoothstep(0.35, 0.55, dirtNoise);
    weights.dirt = dirtBase * dirtVariation * featureWeight * 0.4;
  //  weights.rock = 1.0;
//    weights.grass = 0.0;
    return weights;
}
`;
}
