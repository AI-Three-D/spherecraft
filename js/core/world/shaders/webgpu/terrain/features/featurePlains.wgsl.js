// js/world/shaders/webgpu/terrain/features/featurePlains.wgsl.js

export function createTerrainFeaturePlains() {
  return `
// ==================== Feature: Plains ====================

fn featurePlainsHeight(
    wx: f32, wy: f32, unitDir: vec3<f32>, seed: i32,
    profile: TerrainProfile, amp: TerrainAmplitudes
) -> f32 {
    let vast = fbmAuto(wx, wy, unitDir, SCALE_PLAINS_VAST, 3, seed + 600, 2.0, 0.5) * 0.35;
    let large = fbmAuto(wx, wy, unitDir, SCALE_PLAINS_LARGE, 3, seed + 700, 2.0, 0.5) * 0.30;
    let medium = fbmAuto(wx, wy, unitDir, SCALE_PLAINS_MEDIUM, 3, seed + 800, 2.0, 0.5) * 0.22;
    let small = fbmAuto(wx, wy, unitDir, SCALE_PLAINS_SMALL, 2, seed + 900, 2.0, 0.5) * 0.15;
    let micro = fbmAuto(wx, wy, unitDir, SCALE_PLAINS_MICRO, 2, seed + 1000, 2.0, 0.5) * 0.08;

    let patchMask = sparseMaskAuto(wx, wy, unitDir, SCALE_PLAINS_VAST * 0.55, seed + 1040, 0.45, 0.18);
    let patchBlend = mix(0.2, 1.0, patchMask);

    return (vast + large + medium + small + micro) * amp.plainsVariation * profile.baseBias * patchBlend;
}

// ==================== Plains Surface ====================

fn featurePlainsSurface(
    wx: f32, wy: f32, unitDir: vec3<f32>, seed: i32,
    slope: f32, elevation: f32,
    profile: TerrainProfile,
    featureWeight: f32
) -> SurfaceWeights {
    var weights = zeroSurfaceWeights();

    if (featureWeight < 0.01) {
        return weights;
    }

    // Plains are dominated by grass
    // Large scale grassland variation
    let grassLarge = fbmAuto(wx, wy, unitDir, SCALE_PLAINS_VAST * 0.4, 2, seed + 8800, 2.0, 0.5);
    let grassMedium = fbmAuto(wx, wy, unitDir, SCALE_PLAINS_LARGE * 0.5, 2, seed + 8810, 2.0, 0.5);

    // Rich grass coverage with subtle variation
    let grassBase = 0.85 + smoothstep(0.3, 0.6, grassLarge) * 0.1 + smoothstep(0.35, 0.55, grassMedium) * 0.05;
    weights.grass = grassBase * featureWeight;

    // Rare rock outcrops - scattered boulders and exposed bedrock
    // Must be very rare on plains
    let rockLarge = fbmAuto(wx, wy, unitDir, SCALE_PLAINS_LARGE * 0.3, 2, seed + 8820, 2.0, 0.5);
    let rockMedium = fbmAuto(wx, wy, unitDir, SCALE_PLAINS_MEDIUM * 0.4, 2, seed + 8830, 2.0, 0.5);

    // Rock only where both noise fields agree (multiplicative = rare)
    let rockChance = smoothstep(0.6, 0.8, rockLarge) * smoothstep(0.55, 0.75, rockMedium);
    weights.rock = rockChance * featureWeight * 0.5;

    // Dirt patches - bare soil areas
    let dirtNoise = fbmAuto(wx, wy, unitDir, SCALE_PLAINS_MEDIUM * 0.6, 2, seed + 8840, 2.0, 0.5);
    let dirtChance = smoothstep(0.5, 0.7, dirtNoise) * (1.0 - smoothstep(0.7, 0.85, dirtNoise));
    weights.dirt = dirtChance * featureWeight * 0.25;

    // Reduce grass where other surfaces appear
    weights.grass = weights.grass * (1.0 - rockChance * 0.8 - dirtChance * 0.5);
  //  weights.rock = 1.0;
//    weights.grass = 0.0;
    return weights;
}
`;
}
