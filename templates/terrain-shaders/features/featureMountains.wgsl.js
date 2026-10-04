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
    let pw = warpFlatForNoise(wx, wy, unitDir, SCALE_MOUNTAIN_RANGES * 0.3, wPath * 0.07, seed + 1605);

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
    var detailN = 0.0;
    if (terrainFeatureOn(TF_MOUNTAIN_DETAIL)) {
        detailN = fbmAuto(wx, wy, unitDir, SCALE_MOUNTAIN_DETAIL, 2, seed + 1900, 2.0, 0.5);
    }

    // === Compose heights ===

    // Foothills: gentle wide base
    let foothillH = foothillEnv * (HEIGHT_MOUNTAIN_FOOTHILL / maxH);

    // Core peaks: sharp ridge, modulated by peak spacing and ridge texture
    let coreMod = (0.35 + 0.65 * peaks) * (0.70 + 0.30 * ridgeN);
    let coreH = coreEnv * coreMod * (HEIGHT_MOUNTAIN_CORE / maxH);

    // Small detail adds roughness to all mountain slopes
    let detailH = foothillEnv * detailN * (HEIGHT_MOUNTAIN_DETAIL / maxH);

    // Smooth union so foothills blend seamlessly into core peaks
    let blendH = select(smoothMaxLegacy(foothillH, coreH, 0.003), smoothMax(foothillH, coreH, 0.003), TERRAIN_FIX_SMOOTH_MAX);
    var h = blendH + detailH;

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

    if (exceptMask > 0.01 && terrainFeatureOn(TF_MOUNTAIN_PEAKS)) {
        let exceptN = fbmAuto(wx, wy, unitDir,
            SCALE_MOUNTAIN_PEAKS * 1.5, 1, seed + 2220, 2.0, 0.5);
        let exceptBump = loneHillDome(exceptN, 0.55);
        let exceptW = select(exceptMask, gateRamp(exceptMask, 0.01), TERRAIN_FIX_MOUNTAIN_GATES);
        let exceptH = exceptBump * exceptW * (HEIGHT_MOUNTAIN_EXCEPTIONAL / maxH);
        h += exceptH * coreEnv;
    }

    // Ramp from the rangeMask < 0.01 gate (no step at the range edge).
    let rangeW = select(rangeMask, gateRamp(rangeMask, 0.01), TERRAIN_FIX_MOUNTAIN_GATES);
    return h * mtnAmp * activity * rangeW;
}

struct MountainHeightD {
    // The mountain height (dual), as featureMountainsHeight.
    full: vec4<f32>,
    // A slope-continuous version for the erosion filter's input: no ridged
    // texture (its crests and clamps are slope kinks), no slope roughness, and
    // a wider foothill/core blend. The filter's gullies follow this field's
    // slope; a kink in it becomes a step in the eroded terrain.
    smoothed: vec4<f32>,
}

// Analytic-derivative twin of featureMountainsHeight (sphere).
fn featureMountainsHeight_d(
    unitDir: vec3<f32>, seed: i32,
    regional: RegionalInfoD, profile: TerrainProfile, amp: TerrainAmplitudes
) -> vec4<f32> {
    return featureMountainsHeight2_d(unitDir, seed, regional, profile, amp).full;
}

// The domain warp is skipped exactly as warpFlatForNoise skips it on the sphere.
fn featureMountainsHeight2_d(
    unitDir: vec3<f32>, seed: i32,
    regional: RegionalInfoD, profile: TerrainProfile, amp: TerrainAmplitudes
) -> MountainHeightD {
    var out: MountainHeightD;
    out.full = dConst(0.0);
    out.smoothed = dConst(0.0);
    let mtnAmp = amp.mountainBase;
    if (mtnAmp < 0.001) { return out; }

    let maxH = maxTerrainHeightM();
    let activity = dClamp(regional.tectonicActivity, 0.0, 1.0);
    let ridgeSharp = clamp(profile.ridgeSharpness, 0.0, 1.0);

    let rangeMask = rarityMaskAuto_d(
        unitDir,
        clampMacroScaleToPlanet(SCALE_MOUNTAIN_RANGES),
        seed + 1650,
        RARITY_UNCOMMON,
        profile.rareBoost
    );
    if (rangeMask.x < 0.01) { return out; }

    let pathN1 = fbmAuto_d(unitDir, clampMacroScaleToPlanet(SCALE_MOUNTAIN_RANGES), 2, seed + 1600, 2.0, 0.5);
    let pathN2 = fbmAuto_d(unitDir, clampMacroScaleToPlanet(SCALE_MOUNTAIN_RANGES * 0.55), 2, seed + 1610, 2.0, 0.5);

    let d1 = dSmoothAbs(pathN1, 0.015);
    let d2 = dSmoothAbs(pathN2, 0.015);
    let pathDist = dSmoothMin(d1, d2, 0.03);

    let widthN = fbmAuto_d(unitDir, SCALE_MOUNTAIN_RANGES * 0.2, 2, seed + 1620, 2.0, 0.5);
    let foothillWidth = dMix(dConst(0.22), dConst(0.42), dSmoothstep(-0.4, 0.4, widthN));
    let coreWidth = foothillWidth * 0.30;

    // max(width, 1e-4) never binds: widths are >= 0.066.
    let fhR = dConst(1.0) - dDiv(pathDist, vec4<f32>(max(foothillWidth.x, 1e-4), foothillWidth.yzw));
    let foothillEnv = dQuintic(dClamp(fhR, 0.0, 1.0));

    let coreR = dConst(1.0) - dDiv(pathDist, vec4<f32>(max(coreWidth.x, 1e-4), coreWidth.yzw));
    let coreQ = dQuintic(dClamp(coreR, 0.0, 1.0));
    let peakExpo = mix(1.8, 3.5, ridgeSharp);
    let coreEnv = dPow(coreQ, peakExpo);

    let peakN = fbmAuto_d(unitDir, SCALE_MOUNTAIN_PEAKS, 2, seed + 1800, 2.0, 0.5);
    let peaks = dSmoothstep(-0.15, 0.60, peakN);

    let ridgeOffset = mix(0.6, 1.2, ridgeSharp);
    let ridgeN = ridgedAuto_d(unitDir, SCALE_MOUNTAIN_RIDGES, 3, seed + 1700, 2.0, 0.5, ridgeOffset);

    var detailN = dConst(0.0);
    if (terrainFeatureOn(TF_MOUNTAIN_DETAIL)) {
        detailN = fbmAuto_d(unitDir, SCALE_MOUNTAIN_DETAIL, 2, seed + 1900, 2.0, 0.5);
    }

    let foothillH = foothillEnv * (HEIGHT_MOUNTAIN_FOOTHILL / maxH);
    let coreMod = dMul(dConst(0.35) + peaks * 0.65, dConst(0.70) + ridgeN * 0.30);
    let coreH = dMul(coreEnv, coreMod) * (HEIGHT_MOUNTAIN_CORE / maxH);
    let detailH = dMul(foothillEnv, detailN) * (HEIGHT_MOUNTAIN_DETAIL / maxH);

    let blendH = select(dSmoothMaxLegacy(foothillH, coreH, 0.003), dSmoothMax(foothillH, coreH, 0.003), TERRAIN_FIX_SMOOTH_MAX);
    let tighten = dPow(foothillEnv, 0.15);
    var h = blendH + detailH;
    h = dMul(h, tighten);

    // Smooth landform: ridge texture at a nominal 0.5, wider blend, no detail.
    let coreHs = dMul(coreEnv, dConst(0.35) + peaks * 0.65) * (0.85 * HEIGHT_MOUNTAIN_CORE / maxH);
    var hs = dMul(select(dSmoothMaxLegacy(foothillH, coreHs, 0.02), dSmoothMax(foothillH, coreHs, 0.02), TERRAIN_FIX_SMOOTH_MAX), tighten);

    let exceptMask = rarityMaskAuto_d(
        unitDir,
        clampMacroScaleToPlanet(SCALE_MOUNTAIN_RANGES * 1.5),
        seed + 2200,
        RARITY_EXCEPTIONAL,
        profile.rareBoost
    );
    if (exceptMask.x > 0.01 && terrainFeatureOn(TF_MOUNTAIN_PEAKS)) {
        let exceptN = fbmAuto_d(unitDir, SCALE_MOUNTAIN_PEAKS * 1.5, 1, seed + 2220, 2.0, 0.5);
        let exceptBump = loneHillDome_d(exceptN, 0.55);
        let exceptW = select(exceptMask, dGateRamp(exceptMask, 0.01), TERRAIN_FIX_MOUNTAIN_GATES);
        let exceptH = dMul(exceptBump, exceptW) * (HEIGHT_MOUNTAIN_EXCEPTIONAL / maxH);
        h += dMul(exceptH, coreEnv);
        hs += dMul(exceptH, coreEnv);
    }

    let rangeW = select(rangeMask, dGateRamp(rangeMask, 0.01), TERRAIN_FIX_MOUNTAIN_GATES);
    let scaleD = dMul(activity, rangeW) * mtnAmp;
    out.full = dMul(h, scaleD);
    out.smoothed = dMul(hs, scaleD);
    return out;
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
