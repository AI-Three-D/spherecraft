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

// ---- Dual-number versions (sphere only; see terrainCommon) ----

struct RegionalInfoD {
    isLand: bool,
    landMask: vec4<f32>,
    terrainType: vec4<f32>,
    tectonicActivity: vec4<f32>,
    ruggedness: vec4<f32>,
    baseElevation: vec4<f32>,
};

fn getContinentalMask_d(unitDir: vec3<f32>, seed: i32, profile: TerrainProfile) -> vec4<f32> {
    let enabled = clamp(uniforms.continentParams.x, 0.0, 1.0);
    if (enabled < 0.01) {
        return dConst(0.5);
    }

    let baseScale = clampMacroScaleToPlanet(SCALE_CONTINENTAL_BASE);
    let detailScale = clampMacroScaleToPlanet(SCALE_CONTINENTAL_DETAIL);
    let shelfScale = clampMacroScaleToPlanet(SCALE_CONTINENTAL_SHELF);

    let warpStrength = 0.08 + 0.12 * profile.warpStrength;
    let warp = warpDirAuto_d(unitDir, 2.0, warpStrength, seed + 140);
    let dir = warp.d;

    // Gradients below are with respect to the warped direction; pulled back
    // to unitDir at the end.
    let continental = fbmAuto_d(dir, baseScale, 5, seed + 100, 2.0, 0.5);
    let detail = fbmAuto_d(dir, detailScale, 4, seed + 200, 2.1, 0.5) * 0.35;
    let shelf = fbmAuto_d(dir, shelfScale, 3, seed + 250, 2.0, 0.55) * 0.2;

    let coastalComplexity = clamp(uniforms.continentParams.w, 0.0, 1.0);
    let coastScale = mix(detailScale * 0.5, detailScale * 2.5, coastalComplexity);
    let coastNoise = fbmAuto_d(dir, coastScale, 3, seed + 260, 2.2, 0.5) * (0.15 + 0.35 * coastalComplexity);

    let combined = continental + detail + shelf + coastNoise;

    let avgSize = clamp(uniforms.continentParams.z, 0.05, 0.9);
    let coverage = mix(0.25, 0.75, avgSize);
    let threshold = coverageThreshold(coverage);
    var mask = dSmoothstep(threshold - 0.12, threshold + 0.12, combined);

    let basinMask = sparseMaskAuto_d(dir, baseScale * 0.55, seed + 320, 0.35, 0.18);
    mask = dMul(mask, dMix(dConst(0.35), dConst(1.0), basinMask));

    let result = dMix(dConst(0.5), mask, dConst(enabled));
    return vec4<f32>(result.x, pullbackWarp(warp, result.yzw));
}

fn getRegionalCharacter_d(unitDir: vec3<f32>, seed: i32, profile: TerrainProfile) -> RegionalInfoD {
    var info: RegionalInfoD;

    if (smallPlanetMode()) {
        let landNoise = fbmAuto_d(unitDir, clampMacroScaleToPlanet(SCALE_REGIONAL_ZONES), 4, seed + 7000, 2.0, 0.5);
        let landMask = dSmoothstep(-0.18, 0.22, landNoise);

        info.isLand = landMask.x > 0.4;
        info.landMask = landMask;
        info.baseElevation = (landMask - dConst(0.5)) * 1.6;

        let rugged = dAbs(fbmAuto_d(unitDir, clampMacroScaleToPlanet(SCALE_REGIONAL_VARIATION), 3, seed + 7100, 2.0, 0.5));
        info.ruggedness = rugged;
        info.tectonicActivity = dClamp(dConst(0.3) + dAbs(landNoise) * 0.5, 0.0, 1.0);
        info.terrainType = dClamp(dConst(0.25) + rugged * 0.6 + info.tectonicActivity * 0.2, 0.0, 1.2);
        return info;
    }

    let continental = getContinentalMask_d(unitDir, seed, profile);
    info.landMask = continental;
    let landThreshold: f32 = 0.32;
    let landT = dClamp((continental - dConst(landThreshold)) / (1.0 - landThreshold), 0.0, 1.0);
    info.isLand = continental.x > landThreshold;
    info.baseElevation = landT * 1.0;

    let tectonicScale = clampMacroScaleToPlanet(SCALE_TECTONIC_PLATES);
    let zoneScale = clampMacroScaleToPlanet(SCALE_REGIONAL_ZONES);
    let variationScale = clampMacroScaleToPlanet(SCALE_REGIONAL_VARIATION);

    let plateNoise = dAbs(fbmAuto_d(unitDir, tectonicScale, 4, seed + 300, 2.0, 0.5));
    info.tectonicActivity = dSmoothstep(0.2, 0.75, plateNoise);

    let zoneNoise = fbmAuto_d(unitDir, zoneScale, 4, seed + 400, 2.0, 0.5);
    let variationNoise = fbmAuto_d(unitDir, variationScale, 3, seed + 500, 2.0, 0.5) * 0.4;
    let ruggedNoise = fbmAuto_d(unitDir, variationScale * 0.8, 3, seed + 520, 2.0, 0.5);
    info.ruggedness = dClamp(dSmoothstep(-0.2, 0.6, ruggedNoise), 0.0, 1.0);

    let zoneBase = dClamp(zoneNoise * 0.5 + dConst(0.25), 0.0, 0.8);
    let baseType = zoneBase + variationNoise * 0.15 + info.ruggedness * 0.25;
    let tectonicBoost = info.tectonicActivity * 0.35 * max(profile.mountainBias, 0.2);
    info.terrainType = dClamp(baseType + tectonicBoost, 0.0, 1.2);

    let landInfluence = dSmoothstep(0.1, 0.5, continental);
    info.terrainType = dMul(info.terrainType, landInfluence);
    info.tectonicActivity = dMul(info.tectonicActivity, landInfluence);
    info.ruggedness = dMul(info.ruggedness, landInfluence);

    return info;
}

// ==================== Land regions ====================
// One large field (SCALE_REGION_FIELD) sorts the land into lowland plains
// (flat: little local relief), uplands and highlands. Only the highlands
// rise above the regional base (continentRelief: low coasts, rising
// inland): a very gradual climb (REGION_CLIMB of the region coordinate,
// ~15 km) up to a broad plateau and, where the field is highest, a second
// climb to a high plateau. Plains and uplands follow the base. The raised
// parts are sparse, so the land between them stays connected and drains to
// the sea (an elevation field of large amplitude makes deep closed basins
// at its low spots, flooded as lakes up to 400 m deep). The field leans low
// at the coast and high inland (REGION_INLAND_BIAS): plains are mostly
// coastal, highlands inland.

// Region coordinate without the inland lean (plain f32; at a mountain's
// centre, where the continental mask is not at hand).
fn landRegionCoordNoLean(unitDir: vec3<f32>, seed: i32) -> f32 {
    let e = fbmAuto(unitDir.x, unitDir.z, unitDir, clampMacroScaleToPlanet(SCALE_REGION_FIELD), 3, seed + 8000, 2.0, 0.5);
    return (e - REGION_PLAIN_TOP) * (1.0 / REGION_HINGE);
}

struct LandRegionD {
    // Region coordinate (dual): <= 0 plains, then uplands; the highland
    // climb from REGION_HIGHLAND_START.
    coord: vec4<f32>,
    // Highland rise (dual, normalized), part of the erosion input (not of
    // its relief: the slopes are gentle).
    height: vec4<f32>,
    // Local relief multiplier: REGION_ROUGH_PLAIN on the plains .. 1.
    rough: vec4<f32>,
}

fn landRegions_d(unitDir: vec3<f32>, seed: i32, regional: RegionalInfoD) -> LandRegionD {
    var out: LandRegionD;
    let e = fbmAuto_d(unitDir, clampMacroScaleToPlanet(SCALE_REGION_FIELD), 3, seed + 8000, 2.0, 0.5)
        + (regional.baseElevation - dConst(0.5)) * REGION_INLAND_BIAS;
    out.coord = (e - dConst(REGION_PLAIN_TOP)) * (1.0 / REGION_HINGE);
    // Highland climbs: quintic ramps, level below and above (C2).
    let climb1 = dQuintic(dClamp((out.coord - dConst(REGION_HIGHLAND_START)) * (1.0 / REGION_CLIMB), 0.0, 1.0));
    let climb2 = dQuintic(dClamp((out.coord - dConst(REGION_PLATEAU2_START)) * (1.0 / REGION_CLIMB), 0.0, 1.0));
    out.height = (climb1 * HEIGHT_PLATEAU1 + climb2 * HEIGHT_PLATEAU2) * (1.0 / maxTerrainHeightM());
    out.rough = dConst(REGION_ROUGH_PLAIN) + dQuintic(dClamp(out.coord * (1.0 / REGION_ROUGH_FULL), 0.0, 1.0)) * (1.0 - REGION_ROUGH_PLAIN);
    return out;
}

// Lake basins (dual, normalized, <= 0): shallow flat-floored hollows on the
// uplands and plateaus (fading out toward the plains). They hold lakes
// where the ground around is gentle enough; on climbs they spill.
fn featureLakeBasinsHeight_d(unitDir: vec3<f32>, seed: i32, region: LandRegionD) -> vec4<f32> {
    let w = dQuintic(dClamp(region.coord * (1.0 / LAKE_BASIN_RISE), 0.0, 1.0));
    if (w.x <= 0.0) { return dConst(0.0); }
    let n = fbmAuto_d(unitDir, SCALE_LAKE_BASIN, 2, seed + 8200, 2.0, 0.5);
    let hollow = dQuintic(dClamp((n - dConst(LAKE_BASIN_FROM)) * (1.0 / (LAKE_BASIN_FULL - LAKE_BASIN_FROM)), 0.0, 1.0));
    return dMul(hollow, w) * (-HEIGHT_LAKE_BASIN / maxTerrainHeightM());
}
`;
}
