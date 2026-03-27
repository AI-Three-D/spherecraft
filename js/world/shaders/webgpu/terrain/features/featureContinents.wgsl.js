// js/world/shaders/webgpu/terrain/features/featureContinents.wgsl.js

export function createTerrainFeatureContinents() {
  return `
// ==================== Feature: Continents / Regions ====================

fn getContinentalMask(wx: f32, wy: f32, unitDir: vec3<f32>, seed: i32, profile: TerrainProfile) -> f32 {
    let enabled = clamp(uniforms.continentParams.x, 0.0, 1.0);
    if (enabled < 0.01) {
        return 0.5;
    }

    let baseScale = clampMacroScaleToPlanet(SCALE_CONTINENTAL_BASE);
    let detailScale = clampMacroScaleToPlanet(SCALE_CONTINENTAL_DETAIL);
    let shelfScale = clampMacroScaleToPlanet(SCALE_CONTINENTAL_SHELF);

    var wxw = wx;
    var wyw = wy;
    var dir = unitDir;

    let warpStrength = 0.08 + 0.12 * profile.warpStrength;
    if (uniforms.face >= 0) {
        dir = warpDirAuto(unitDir, 2.0, warpStrength, seed + 140);
    } else {
        let warped = warpFlatAuto(wx, wy, unitDir, 2.0, warpStrength * GEOLOGY_SCALE * 0.6, seed + 140);
        wxw = warped.x;
        wyw = warped.y;
    }

    let continental = fbmAuto(wxw, wyw, dir, baseScale, 5, seed + 100, 2.0, 0.5);
    let detail = fbmAuto(wxw, wyw, dir, detailScale, 4, seed + 200, 2.1, 0.5) * 0.35;
    let shelf = fbmAuto(wxw, wyw, dir, shelfScale, 3, seed + 250, 2.0, 0.55) * 0.2;

    let coastalComplexity = clamp(uniforms.continentParams.w, 0.0, 1.0);
    let coastScale = mix(detailScale * 0.5, detailScale * 2.5, coastalComplexity);
    let coastNoise = fbmAuto(wxw, wyw, dir, coastScale, 3, seed + 260, 2.2, 0.5) * (0.15 + 0.35 * coastalComplexity);

    let combined = continental + detail + shelf + coastNoise;

    let avgSize = clamp(uniforms.continentParams.z, 0.05, 0.9);
    let coverage = mix(0.25, 0.75, avgSize);
    let threshold = coverageThreshold(coverage);
    var mask = smoothstep(threshold - 0.12, threshold + 0.12, combined);

    // Add basin noise to introduce large empty areas between continents
    var basinMask = sparseMaskAuto(wxw, wyw, dir, baseScale * 0.55, seed + 320, 0.35, 0.18);
    mask *= mix(0.35, 1.0, basinMask);

    return mix(0.5, mask, enabled);
}
fn getRegionalCharacter(wx: f32, wy: f32, unitDir: vec3<f32>, seed: i32, profile: TerrainProfile) -> RegionalInfo {
    var info: RegionalInfo;

    if (smallPlanetMode()) {
        let landNoise = fbmAuto(wx, wy, unitDir, clampMacroScaleToPlanet(SCALE_REGIONAL_ZONES), 4, seed + 7000, 2.0, 0.5);
        let landMask = smoothstep(-0.18, 0.22, landNoise);

        info.isLand = landMask > 0.4;
        info.landMask = landMask;
        info.baseElevation = (landMask - 0.5) * 1.6;

        let rugged = abs(fbmAuto(wx, wy, unitDir, clampMacroScaleToPlanet(SCALE_REGIONAL_VARIATION), 3, seed + 7100, 2.0, 0.5));
        info.ruggedness = rugged;
        info.tectonicActivity = clamp(0.3 + abs(landNoise) * 0.5, 0.0, 1.0);
        info.terrainType = clamp(0.25 + rugged * 0.6 + info.tectonicActivity * 0.2, 0.0, 1.2);
        return info;
    }

    let continental = getContinentalMask(wx, wy, unitDir, seed, profile);
    info.landMask = continental;
let landThreshold: f32 = 0.32;

// 0 at the land threshold, 1 at continental=1
let landT = clamp((continental - landThreshold) / (1.0 - landThreshold), 0.0, 1.0);

// Keep classification the same (for now)
info.isLand = continental > landThreshold;

// Base uplift: 0 at coast threshold, rises smoothly inland
info.baseElevation = landT * 1.0;  // (scale tuned later)


    let tectonicScale = clampMacroScaleToPlanet(SCALE_TECTONIC_PLATES);
    let zoneScale = clampMacroScaleToPlanet(SCALE_REGIONAL_ZONES);
    let variationScale = clampMacroScaleToPlanet(SCALE_REGIONAL_VARIATION);

    let plateNoise = abs(fbmAuto(wx, wy, unitDir, tectonicScale, 4, seed + 300, 2.0, 0.5));
    info.tectonicActivity = smoothstep(0.2, 0.75, plateNoise);

    let zoneNoise = fbmAuto(wx, wy, unitDir, zoneScale, 4, seed + 400, 2.0, 0.5);
    let variationNoise = fbmAuto(wx, wy, unitDir, variationScale, 3, seed + 500, 2.0, 0.5) * 0.4;
    
    // FIX: Use FBM for ruggedness, not ridged noise
    // Ridged noise is always "rough", FBM gives smooth and rough regions
    let ruggedNoise = fbmAuto(wx, wy, unitDir, variationScale * 0.8, 3, seed + 520, 2.0, 0.5);
    info.ruggedness = clamp(smoothstep(-0.2, 0.6, ruggedNoise), 0.0, 1.0);

    // Terrain type: linear mapping of zoneNoise so the full range is used.
    // Old smoothstep(-0.3,0.4,zoneNoise)*0.5 bottomed out at ~0.19 for average
    // noise, making plainness ≈ 0 everywhere.  Linear gives real spread:
    //   zoneNoise -0.3 → 0.10 (plains)
    //   zoneNoise  0.0 → 0.25 (plains border)
    //   zoneNoise  0.3 → 0.40 (hills)
    //   zoneNoise  0.5 → 0.50 (strong hills)
    let zoneBase = clamp(zoneNoise * 0.5 + 0.25, 0.0, 0.8);
    let baseType = zoneBase + variationNoise * 0.15 + info.ruggedness * 0.25;
    let tectonicBoost = info.tectonicActivity * 0.35 * max(profile.mountainBias, 0.2);
    info.terrainType = clamp(baseType + tectonicBoost, 0.0, 1.2);

    // Soft fade terrain features toward ocean
    let landInfluence = smoothstep(0.1, 0.5, continental);
    info.terrainType *= landInfluence;
    info.tectonicActivity *= landInfluence;
    info.ruggedness *= landInfluence;

    return info;
}
`;
}
