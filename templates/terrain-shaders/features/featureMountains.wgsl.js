// js/world/shaders/webgpu/terrain/features/featureMountains.wgsl.js
//
// Mountain range features using line-based paths (similar to rolling hills)
// with wide gentle foothills and sharp ridge contours at the peak.
//
// Heights in METERS, planet-independent via maxTerrainHeightM().

export function createTerrainFeatureMountains() {
  return `
// ==================== Feature: Mountains ====================

struct MountainHeightD {
    // The mountain height (dual).
    full: vec4<f32>,
    // A slope-continuous version for the erosion filter's input: no ridged
    // texture (its crests and clamps are slope kinks), no slope roughness, and
    // a wider foothill/core blend. The filter's gullies follow this field's
    // slope; a kink in it becomes a step in the eroded terrain.
    smoothed: vec4<f32>,
}

// Mountain height and gradient (dual, sphere).
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

    let blendH = dSmoothMax(foothillH, coreH, 0.003);
    let tighten = dPow(foothillEnv, 0.15);
    var h = blendH + detailH;
    h = dMul(h, tighten);

    // Smooth landform: ridge texture at a nominal 0.5, wider blend, no detail.
    let coreHs = dMul(coreEnv, dConst(0.35) + peaks * 0.65) * (0.85 * HEIGHT_MOUNTAIN_CORE / maxH);
    var hs = dMul(dSmoothMax(foothillH, coreHs, 0.02), tighten);

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
        let exceptW = dGateRamp(exceptMask, 0.01);
        let exceptH = dMul(exceptBump, exceptW) * (HEIGHT_MOUNTAIN_EXCEPTIONAL / maxH);
        h += dMul(exceptH, coreEnv);
        hs += dMul(exceptH, coreEnv);
    }

    let rangeW = dGateRamp(rangeMask, 0.01);
    let scaleD = dMul(activity, rangeW) * mtnAmp;
    out.full = dMul(h, scaleD);
    out.smoothed = dMul(hs, scaleD);
    return out;
}

// ==================== Mountain Surface ====================

`;
}
