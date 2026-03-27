// js/world/shaders/webgpu/terrain/features/featureMountains.wgsl.js
//
// Mountain range features using line-based paths (similar to rolling hills)
// with wide gentle foothills and sharp ridge contours at the peak.
//
// Heights in METERS, planet-independent via maxTerrainHeightM().

export function createTerrainFeatureMountains() {
  return `
// ==================== Feature: Mountains ====================

fn featureMountainsHeight(
    wx: f32, wy: f32, unitDir: vec3<f32>, seed: i32,
    regional: RegionalInfo, profile: TerrainProfile, amp: TerrainAmplitudes
) -> f32 {
    let mtnAmp = amp.mountainBase;
    if (mtnAmp < 0.001) { return 0.0; }

    let maxH = maxTerrainHeightM();
    let activity = clamp(regional.tectonicActivity, 0.0, 1.0);
    let ridgeSharp = clamp(profile.ridgeSharpness, 0.0, 1.0);

    // === Rarity mask: mountains only in tectonically active zones ===
    let rangeMask = rarityMaskAuto(
        wx, wy, unitDir,
        clampMacroScaleToPlanet(SCALE_MOUNTAIN_RANGES),
        seed + 1650,
        RARITY_UNCOMMON,
        profile.rareBoost
    );

    if (rangeMask < 0.01) { return 0.0; }

    // === Domain warp so paths aren't clean isolines ===
    let wPath = wavelength_m(SCALE_MOUNTAIN_RANGES * 0.5, GEOLOGY_SCALE);
    let pw = warpFlatAuto(wx, wy, unitDir, SCALE_MOUNTAIN_RANGES * 0.3, wPath * 0.07, seed + 1605);

    // === Distance-to-path field (line-based mountain ranges) ===
    // Two overlapping path layers create branching / converging ranges.
    let pathN1 = fbmAuto(pw.x, pw.y, unitDir,
        clampMacroScaleToPlanet(SCALE_MOUNTAIN_RANGES), 2, seed + 1600, 2.0, 0.5);
    let pathN2 = fbmAuto(pw.x, pw.y, unitDir,
        clampMacroScaleToPlanet(SCALE_MOUNTAIN_RANGES * 0.55), 2, seed + 1610, 2.0, 0.5);

    let kAbs = 0.015;
    let d1 = smoothAbs(pathN1, kAbs);
    let d2 = smoothAbs(pathN2, kAbs);

    let kMin = 0.03;
    let pathDist = smoothMin(d1, d2, kMin);

    // === Width variation along the range ===
    let widthN = fbmAuto(pw.x, pw.y, unitDir,
        SCALE_MOUNTAIN_RANGES * 0.2, 2, seed + 1620, 2.0, 0.5);

    // Foothill width (wide apron of gentle slopes)
    let foothillWidth = mix(0.22, 0.42, smoothstep(-0.4, 0.4, widthN));
    // Core ridge width (narrow, sharp)
    let coreWidth = foothillWidth * 0.30;

    // === Foothill envelope (wide, gentle dome) ===
    let fhR = 1.0 - pathDist / max(foothillWidth, 1e-4);
    let fhC = clamp(fhR, 0.0, 1.0);
    let foothillEnv = fhC * fhC * fhC * (fhC * (fhC * 6.0 - 15.0) + 10.0);

    // === Core ridge envelope (narrow, sharp peak via high exponent) ===
    let coreR = 1.0 - pathDist / max(coreWidth, 1e-4);
    let coreC = clamp(coreR, 0.0, 1.0);
    let coreQ = coreC * coreC * coreC * (coreC * (coreC * 6.0 - 15.0) + 10.0);
    // Sharp peak: ridgeSharpness 0 → exponent 1.8, 1 → exponent 3.5
    let peakExpo = mix(1.8, 3.5, ridgeSharp);
    let coreEnv = pow(coreQ, peakExpo);

    // === Peak modulation: break continuous ridge into individual peaks ===
    let peakN = fbmAuto(pw.x, pw.y, unitDir,
        SCALE_MOUNTAIN_PEAKS, 2, seed + 1800, 2.0, 0.5);
    let peaks = smoothstep(-0.15, 0.60, peakN);

    // === Ridge detail texture (ridged noise for craggy character) ===
    let ridgeOffset = mix(0.6, 1.2, ridgeSharp);
    let ridgeN = ridgedAuto(wx, wy, unitDir,
        SCALE_MOUNTAIN_RIDGES, 3, seed + 1700, 2.0, 0.5, ridgeOffset);

    // === Small-scale slope roughness ===
    let detailN = fbmAuto(wx, wy, unitDir,
        SCALE_MOUNTAIN_DETAIL, 2, seed + 1900, 2.0, 0.5);

    // === Compose heights ===

    // Foothills: gentle wide base
    let foothillH = foothillEnv * (HEIGHT_MOUNTAIN_FOOTHILL / maxH);

    // Core peaks: sharp ridge, modulated by peak spacing and ridge texture
    let coreMod = (0.35 + 0.65 * peaks) * (0.70 + 0.30 * ridgeN);
    let coreH = coreEnv * coreMod * (HEIGHT_MOUNTAIN_CORE / maxH);

    // Small detail adds roughness to all mountain slopes
    let detailH = foothillEnv * detailN * (HEIGHT_MOUNTAIN_DETAIL / maxH);

    // Smooth union so foothills blend seamlessly into core peaks
    var h = smoothMax(foothillH, coreH, 0.003) + detailH;

    // Slightly tighten the whole feature so it reads as a range, not a plateau
    h *= pow(foothillEnv, 0.15);

    // === Exceptional peaks (very rare, towering) ===
    let exceptMask = rarityMaskAuto(
        wx, wy, unitDir,
        clampMacroScaleToPlanet(SCALE_MOUNTAIN_RANGES * 1.5),
        seed + 2200,
        RARITY_EXCEPTIONAL,
        profile.rareBoost
    );

    if (exceptMask > 0.01) {
        let exceptN = fbmAuto(wx, wy, unitDir,
            SCALE_MOUNTAIN_PEAKS * 1.5, 1, seed + 2220, 2.0, 0.5);
        let exceptBump = loneHillDome(exceptN, 0.55);
        let exceptH = exceptBump * exceptMask * (HEIGHT_MOUNTAIN_EXCEPTIONAL / maxH);
        h += exceptH * coreEnv;
    }

    return h * mtnAmp * activity * rangeMask;
}

// ==================== Mountain Surface ====================

fn featureMountainsSurface(
    wx: f32, wy: f32, unitDir: vec3<f32>, seed: i32,
    slope: f32, elevation: f32,
    regional: RegionalInfo, profile: TerrainProfile,
    featureWeight: f32
) -> SurfaceWeights {
    var weights = zeroSurfaceWeights();

    if (featureWeight < 0.01) {
        return weights;
    }

    // Mountains are rocky, especially on steep slopes
    let slopeRock = slopeRockWeight(slope);

    // Additional rock on ridges and peaks
    let ridgeNoise = ridgedAuto(wx, wy, unitDir, SCALE_MOUNTAIN_RIDGES * 0.5, 2, seed + 8500, 2.0, 0.5, 1.0);
    let ridgeRock = smoothstep(0.4, 0.7, ridgeNoise) * 0.4;

    // Exposed rock faces
    let faceNoise = fbmAuto(wx, wy, unitDir, SCALE_MOUNTAIN_RANGES * 0.3, 2, seed + 8510, 2.0, 0.5);
    let faceRock = smoothstep(0.3, 0.5, faceNoise) * 0.3;

    weights.rock = (slopeRock * 0.7 + ridgeRock + faceRock) * featureWeight;

    // Grass in valleys and gentler slopes
    let grassBase = slopeGrassWeight(slope);
    let elevationReduction = smoothstep(0.5, 0.8, elevation);
    weights.grass = grassBase * (1.0 - elevationReduction * 0.6) * featureWeight * 0.5;

    // Dirt/scree on moderate slopes
    weights.dirt = slopeDirtWeight(slope) * featureWeight * 0.3;

    // Extra rock on very steep high-altitude areas
    let stoneCondition = smoothstep(0.7, 0.9, slope) * smoothstep(0.6, 0.85, elevation);
    weights.rock += stoneCondition * featureWeight * 0.4;

    // Snow at high elevations
    let snowElevation = smoothstep(0.75, 0.95, elevation);
    let snowSlope = 1.0 - smoothstep(0.6, 0.85, slope);
    weights.snow = snowElevation * snowSlope * featureWeight * 0.5;

    return weights;
}
`;
}
