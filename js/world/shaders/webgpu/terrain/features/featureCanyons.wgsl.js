// js/world/shaders/webgpu/terrain/features/featureCanyons.wgsl.js

export function createTerrainFeatureCanyons() {
  return `
// ==================== Feature: Canyons / Valleys ====================

fn featureCanyonHeight(
    wx: f32, wy: f32, unitDir: vec3<f32>, seed: i32,
    regional: RegionalInfo, profile: TerrainProfile, amp: TerrainAmplitudes
) -> f32 {
    let canyonMain = ridgedAuto(wx, wy, unitDir, SCALE_CANYON_MAIN, 4, seed + 2400, 2.1, 0.5, 0.9);
    let canyonBranch = ridgedAuto(wx, wy, unitDir, SCALE_CANYON_BRANCH, 3, seed + 2500, 2.0, 0.5, 0.9) * 0.6;
    let canyonDetail = fbmAuto(wx, wy, unitDir, SCALE_CANYON_DETAIL, 2, seed + 2550, 2.0, 0.5) * 0.3;

    let patchMask = sparseMaskAuto(wx, wy, unitDir, SCALE_CANYON_MAIN * 0.7, seed + 2420, 0.25, 0.2);
    let patchBlend = mix(0.25, 1.0, patchMask);

    let rareMask = rarityMaskAuto(wx, wy, unitDir, SCALE_CANYON_MAIN * 1.1, seed + 2600, RARITY_VERY_RARE, profile.rareBoost);
    let rareCut = cellShapeAuto(wx, wy, unitDir, SCALE_CANYON_MAIN * 0.8, seed + 2620, 0.28) * rareMask;

    let activity = mix(0.4, 1.0, regional.tectonicActivity);
    let baseCanyon = (canyonMain + canyonBranch + canyonDetail) * patchBlend * 0.7;

    let depth = amp.canyonDepth * profile.canyonBias;
    var  height = -baseCanyon * depth * activity;
    height += -rareCut * depth * 1.2;

    return height;
}

// ==================== Canyon Surface ====================

fn featureCanyonSurface(
    wx: f32, wy: f32, unitDir: vec3<f32>, seed: i32,
    slope: f32, elevation: f32, localDepth: f32,
    regional: RegionalInfo, profile: TerrainProfile,
    featureWeight: f32
) -> SurfaceWeights {
    var weights = zeroSurfaceWeights();

    if (featureWeight < 0.01) {
        return weights;
    }

    // Canyon walls are rocky
    let wallRock = slopeRockWeight(slope);

    // Layered rock strata - horizontal bands on canyon walls
    let strataScale = 0.15;  // ~150m bands
    let strataNoise = fbmAuto(wx, wy, unitDir, strataScale, 2, seed + 8600, 2.0, 0.5);
    let strataPattern = smoothstep(0.3, 0.5, strataNoise) * slope;

    // Strata read as rock now that stone is removed
    weights.rock = wallRock * featureWeight * 0.6;
    weights.rock += strataPattern * featureWeight * 0.5;

    // Canyon floor - sand and dirt accumulation
    let floorFactor = 1.0 - slope;  // Flat = floor
    let depthFactor = clamp(localDepth * 2.0, 0.0, 1.0);  // Deeper = more accumulation

    // Sand in dry canyon floors
    let sandNoise = fbmAuto(wx, wy, unitDir, SCALE_CANYON_DETAIL * 0.5, 2, seed + 8610, 2.0, 0.5);
    let sandArea = smoothstep(0.35, 0.55, sandNoise) * floorFactor;
    weights.sand = sandArea * depthFactor * featureWeight * 0.7;

    // Dirt/sediment
    let dirtNoise = fbmAuto(wx, wy, unitDir, SCALE_CANYON_DETAIL * 0.8, 2, seed + 8620, 2.0, 0.5);
    let dirtArea = smoothstep(0.3, 0.5, dirtNoise) * floorFactor;
    weights.dirt = dirtArea * depthFactor * featureWeight * 0.5;

    // Some grass on canyon floors where water might collect
    let grassNoise = fbmAuto(wx, wy, unitDir, SCALE_CANYON_BRANCH * 0.3, 2, seed + 8630, 2.0, 0.5);
    let grassArea = smoothstep(0.4, 0.6, grassNoise) * floorFactor * (1.0 - slope);
   weights.grass = grassArea * featureWeight * 0.3;
  //  weights.rock = 1.0;
  //  weights.grass = 0.0;
    return weights;
}
`;
}
