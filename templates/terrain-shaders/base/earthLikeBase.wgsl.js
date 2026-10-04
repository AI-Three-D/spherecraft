// js/world/shaders/webgpu/terrain/base/earthLikeBase.wgsl.js

export function createEarthlikeConstants() {
  return `
// ==================== Terrain Constants (Earthlike) ====================
// NOTE: These scales are in GEOLOGY units. GEOLOGY_SCALE converts to meters.

const GEOLOGY_SCALE: f32 = 1000.0;
const MIN_MACRO_CYCLES: f32 = 4.0;

// Macro / continental scales
const SCALE_CONTINENTAL_BASE: f32 = 2200.0;
const SCALE_CONTINENTAL_DETAIL: f32 = 650.0;
const SCALE_CONTINENTAL_SHELF: f32 = 220.0;

// Regional / tectonic scales
const SCALE_TECTONIC_PLATES: f32 = 320.0;
const SCALE_REGIONAL_ZONES: f32 = 160.0;
const SCALE_REGIONAL_VARIATION: f32 = 80.0;

// Mountain scales
const SCALE_MOUNTAIN_RANGES: f32 = 90.0;
const SCALE_MOUNTAIN_RIDGES: f32 = 35.0;
const SCALE_MOUNTAIN_PEAKS: f32 = 12.0;
const SCALE_MOUNTAIN_DETAIL: f32 = 4.0;
const SCALE_MOUNTAIN_FOOTHILLS: f32 = 3.0;     // 3 km rolling foothill hills

// Hill scales
const SCALE_HILLS_LARGE: f32 = 18.0;
const SCALE_HILLS_MEDIUM: f32 = 7.0;
const SCALE_HILLS_SMALL: f32 = 2.5;

// Plains scales
const SCALE_PLAINS_VAST: f32 = 120.0;
const SCALE_PLAINS_LARGE: f32 = 30.0;
const SCALE_PLAINS_MEDIUM: f32 = 8.0;
const SCALE_PLAINS_SMALL: f32 = 2.0;
const SCALE_PLAINS_MICRO: f32 = 0.6;

// Canyon / valley scales
const SCALE_CANYON_MAIN: f32 = 60.0;
const SCALE_CANYON_BRANCH: f32 = 20.0;
const SCALE_CANYON_DETAIL: f32 = 6.0;

// Micro detail scales (5-500m)
const SCALE_MICRO_5: f32 = 0.005;
const SCALE_MICRO_15: f32 = 0.015;
const SCALE_MICRO_50: f32 = 0.050;
const SCALE_MICRO_120: f32 = 0.120;
const SCALE_MICRO_300: f32 = 0.300;
const SCALE_MICRO_500: f32 = 0.500;

// Lone hill feature scales (isolated hill placement)
const SCALE_LONE_HILL_SMALL: f32 = 0.8;       // 800m - common round domes
const SCALE_LONE_HILL_MEDIUM: f32 = 2.5;      // 2.5km - uncommon hills
const SCALE_LONE_HILL_LARGE: f32 = 5.0;       // 5km - rare (mini volcanoes)
const SCALE_LONE_HILL_HUGE: f32 = 10.0;       // 10km - very rare (mesas)
const SCALE_LONE_HILL_LANDMARK: f32 = 18.0;   // 18km - exceptional (dramatic mesas)
const SCALE_LONE_HILL_DENSITY: f32 = 120.0;   // 120km - regional density modulation
const SCALE_LONE_HILL_SIZE_VAR: f32 = 70.0;   // 70km - regional size modulation

// Rolling hill chain scales
const SCALE_ROLLING_HILL_PATH: f32 = 4.0;     // 4km - chain path wavelength
const SCALE_ROLLING_HILL_BUMP: f32 = 0.8;     // 800m - individual bump wavelength
const SCALE_ROLLING_HILL_DENSITY: f32 = 30.0; // 30km - where rolling hills appear

// Amplitude tuning (normalized height space)
const AMP_OCEAN_DEPTH: f32 = -0.6;
const AMP_CONTINENT_SHELF: f32 = 0.14;
const AMP_PLAINS: f32 = 0.20;
const AMP_HILLS: f32 = 0.38;
const AMP_MOUNTAIN_BASE: f32 = 0.75;
const AMP_MOUNTAIN_PEAKS: f32 = 1.05;
const AMP_EXCEPTIONAL_PEAKS: f32 = 1.45;
const AMP_CANYON_DEPTH: f32 = 0.45;

const MICRO_HEIGHT_GAIN: f32 = 0.002;

// Lone hill heights in METERS (planet-independent via maxTerrainHeight conversion).
// These are peak heights before dome/modulation attenuation.
// Typical visible hills are ~25-50% of these values.
const HEIGHT_LONE_HILL_COMMON: f32 = 200.0;        // effective ~20-60m typical
const HEIGHT_LONE_HILL_UNCOMMON: f32 = 300.0;       // effective ~50-120m
const HEIGHT_LONE_HILL_RARE: f32 = 800.0;           // effective ~100-250m
const HEIGHT_LONE_HILL_VERY_RARE: f32 = 1200.0;      // effective ~200-500m
const HEIGHT_LONE_HILL_EXCEPTIONAL: f32 = 1600.0;    // effective ~500-1200m (max ~1.8km)

// Rolling hill chain height
const HEIGHT_ROLLING_HILLS: f32 = 500.0;             // effective ~25-60m per bump

// ---- Meso / micro2 detail (KNOBS — adjust displacement in meters) ----
const SCALE_MICRO2: f32 = 0.008;     // 8 m wavelength  (5–10 m range)
const SCALE_MESO1: f32 = 0.08;      // 80 m wavelength (15–30 m range)
const SCALE_MESO2: f32 = 0.75;      // 150 m wavelength (40–70 m range)
const SCALE_MESO3: f32 = 4.0;       // 8 km wavelength (80–120 m range)

const DISP_MICRO2: f32 = 0.0;        // disabled for now (micro handled per-tile)
const DISP_MESO1: f32 = 25.0;         // ±6 m max displacement
const DISP_MESO2: f32 =  135.0 ;        // ±70 m max displacement
const DISP_MESO3: f32 = 150.0;        // ±10 m max displacement

// ---- Surface-type micro2 parameters (KNOBS) ----
// Sand: directional aeolian ripple patterns
const SCALE_SAND_WIND_DIR: f32 = 50.0;       // 50 km — wind direction wavelength
const SCALE_SAND_RIPPLE: f32 = 0.008;         // 8 m ripple wavelength
const SAND_RIPPLE_STRETCH: f32 = 3.5;         // elongation ratio along wind
const SCALE_SAND_DUNE_ENVELOPE: f32 = 1.0;    // 1 km — individual dune shapes
const SCALE_SAND_FIELD_ENVELOPE: f32 = 5.0;   // 5 km — dune field extent

// Rock: sharp ridged features with geological strata
const SCALE_ROCK_MICRO: f32 = 0.9;          // 8 m rock features
const SCALE_ROCK_STRATA_DIR: f32 = 30.0;      // 30 km — strata direction wavelength
const ROCK_MICRO_STRETCH: f32 = 2.0;          // mild elongation for layered rock
const SCALE_ROCK_CHARACTER: f32 = 3.0;        // 3 km — smooth vs jagged variation

// General: improved multi-character micro (not golf ball)
const SCALE_GENERAL_CHARACTER: f32 = 2.0;     // 2 km — noise character variation
const SCALE_GENERAL_SHAPE: f32 = 8.0;         // 8 km — broad shape modulation

// ---- Mountain line heights (KNOBS — meters, planet-independent) ----
const HEIGHT_MOUNTAIN_FOOTHILL: f32 = 500.0;      // gentle foothill apron (~100-250 m effective)
const HEIGHT_MOUNTAIN_CORE: f32 = 4000.0;         // main ridge peaks (~1000-3000 m effective)
const HEIGHT_MOUNTAIN_DETAIL: f32 = 120.0;        // small-scale slope roughness
const HEIGHT_MOUNTAIN_FOOTHILLS: f32 = 220.0;     // foothill hills (x mountain amplitude)
// Foothill band in regional terrainType. On land terrainType is mostly
// 0.34-0.50 (p10-p90); mountains start at 0.55, so this covers roughly the
// top quarter of land and ramps into the mountain regions.
const FOOTHILL_TT_START: f32 = 0.45;
const FOOTHILL_TT_FULL: f32 = 0.56;
const HEIGHT_MOUNTAIN_EXCEPTIONAL: f32 = 7000.0;  // rare towering peaks (~3000-5000 m)

// ---- Highland feature scales & heights (KNOBS) ----
const SCALE_HIGHLAND_COMMON: f32 = 5.0;         // 5 km — common plateaus
const SCALE_HIGHLAND_UNCOMMON: f32 = 12.0;      // 12 km
const SCALE_HIGHLAND_RARE: f32 = 25.0;          // 25 km
const SCALE_HIGHLAND_VERY_RARE: f32 = 45.0;     // 45 km
const SCALE_HIGHLAND_EXCEPTIONAL: f32 = 70.0;   // 70 km — massive plateaus

const HEIGHT_HIGHLAND_COMMON: f32 = 100.0;        // 40–60 m effective
const HEIGHT_HIGHLAND_UNCOMMON: f32 = 1200.0;     // ~80–120 m
const HEIGHT_HIGHLAND_RARE: f32 = 1500.0;         // ~150–250 m
const HEIGHT_HIGHLAND_VERY_RARE: f32 = 1600.0;    // ~300–500 m
const HEIGHT_HIGHLAND_EXCEPTIONAL: f32 = 2000.0;  // ~500–800 m
`;
}

export function createEarthlikeBase() {
  return `
// ==================== Base: Earthlike ====================

fn getTerrainAmplitudes(profile: TerrainProfile) -> TerrainAmplitudes {
    var amp: TerrainAmplitudes;

    amp.oceanDepth = AMP_OCEAN_DEPTH;
    amp.continentalShelf = AMP_CONTINENT_SHELF * profile.baseBias;
    amp.plainsVariation = AMP_PLAINS * profile.baseBias;
    amp.hillsHeight = AMP_HILLS * profile.hillBias;
    amp.mountainBase = AMP_MOUNTAIN_BASE * profile.mountainBias;
    amp.mountainPeaks = AMP_MOUNTAIN_PEAKS * profile.mountainBias;
    amp.exceptionalPeaks = AMP_EXCEPTIONAL_PEAKS * profile.mountainBias;
    amp.canyonDepth = AMP_CANYON_DEPTH * profile.canyonBias;
    amp.microGain = MICRO_HEIGHT_GAIN * profile.microGain;

    let erosion = clamp(uniforms.erosionParams.y, 0.0, 1.0);
    amp.mountainBase *= (1.0 - erosion * 0.2);
    amp.mountainPeaks *= (1.0 - erosion * 0.5);
    amp.exceptionalPeaks *= (1.0 - erosion * 0.7);
    amp.hillsHeight *= (1.0 - erosion * 0.1);
    amp.canyonDepth *= (1.0 + erosion * 0.25);

    amp.loneHillsHeight = 1.0 * profile.hillBias;
    amp.loneHillsHeight *= (1.0 - erosion * 0.15);

    amp.highlandsHeight = 1.0 * profile.baseBias;
    amp.highlandsHeight *= (1.0 - erosion * 0.1);

    return amp;
}

// Terrain height (normalized) at unitDir: the value of calculateTerrainHeightD.
// The sphere terrain is eroded, and erosion needs the landform's gradient, so
// there is a single implementation (the dual-number one). wx, wy are unused;
// the parameters stay for the many callers.
fn calculateTerrainHeight(wx: f32, wy: f32, seed: i32, unitDir: vec3<f32>) -> f32 {
    return calculateTerrainHeightD(seed, unitDir).x;
}

// Height and its gradient in one evaluation (sphere, face >= 0):
// vec4(height, d height / d unitDir). Same terms, order and land/ocean
// skips as calculateTerrainHeight, so the height matches it (to float
// rounding where the compiler fuses differently); the gradient is analytic.
// Callers project the gradient onto the tangent plane (terrainSurfaceGradient).
fn calculateTerrainHeightD(seed: i32, unitDir: vec3<f32>) -> vec4<f32> {
    let profile = getTerrainProfile();
    let amp = getTerrainAmplitudes(profile);

    let regional = getRegionalCharacter_d(unitDir, seed, profile);
    let landBlend = dSmoothstep(0.15, 0.45, regional.landMask);
    let mountainness = dSmoothstep(0.55, 0.8, regional.terrainType);

    var landHeight = dConst(0.0);
    if (landBlend.x > 0.0) {
        landHeight = select(dConst(0.0), regional.baseElevation * amp.continentalShelf, terrainFeatureOn(TF_CONTINENT_RELIEF));

        // Mountain style by location, 0 = rounded .. 1 = jagged (erosion
        // strength and rounding, mountain shape and height).
        let style = terrainStyle_d(unitDir);

        // Mountains: the full height, and the slope-continuous version that
        // drives the erosion filter (MountainHeightD). Rounded ranges are
        // their smooth shape, jagged ones the ridged one, scaled by
        // styleMountainHeight.
        var mountainsH = dConst(0.0);
        var mountainsSmooth = dConst(0.0);
        if (mountainness.x > 0.01 && terrainFeatureOn(TF_MOUNTAINS)) {
            let mountainW = dMul(dGateRamp(mountainness, 0.01), styleMountainHeight_d(style));
            let m = featureMountainsHeight2_d(unitDir, seed, regional, profile, amp);
            mountainsH = dMul(dMix(m.smoothed, m.full, style), mountainW);
            mountainsSmooth = dMul(m.smoothed, mountainW);
            landHeight += mountainsH;
        }

        // Foothills (see calculateTerrainHeight). Slope-continuous, so part
        // of the erosion input, and counted as relief.
        var foothillsH = dConst(0.0);
        if (terrainFeatureOn(TF_MOUNTAIN_FOOTHILLS)) {
            let footBand = dSmoothstep(FOOTHILL_TT_START, FOOTHILL_TT_FULL, regional.terrainType);
            if (footBand.x > 0.0) {
                let hillN = fbmAuto_d(unitDir, SCALE_MOUNTAIN_FOOTHILLS, 3, seed + 1950, 2.0, 0.5);
                foothillsH = dMul(footBand, dSmoothstep(-0.3, 0.6, hillN)) * ((HEIGHT_MOUNTAIN_FOOTHILLS / maxTerrainHeightM()) * amp.mountainBase);
                landHeight += foothillsH;
            }
        }

        // micro2 (DISP_MICRO2 = 0) contributes nothing; see featureMesoDetail_d.
        let mesoRoughness = dSmoothMax(regional.terrainType, regional.ruggedness * 0.5, 0.02);
        let meso = featureMesoDetail_d(unitDir, seed, profile, mesoRoughness);
        let mesoMaxH = maxTerrainHeightM();
        // meso1/meso2 go on top of the eroded terrain (below), faded where
        // erosion is strong; meso3 is part of the eroded landform.
        if (terrainFeatureOn(TF_MESO3)) { landHeight += meso.meso3 * (DISP_MESO3 / mesoMaxH); }

        var highlandsH = dConst(0.0);
        if (terrainFeatureOn(TF_HIGHLANDS)) {
            highlandsH = featureHighlandsHeight_d(unitDir, seed, regional, profile, amp);
            landHeight += highlandsH;
        }
        {
            // The filter reads a slope-continuous landform (mountains swapped
            // for their smooth version; every other term here is C1), and its
            // height change is added to the full terrain. Relief, which sets
            // the strength, is the large landforms only. The carved features
            // (river channel, erosion-seed pits) come after, so erosion does
            // not fill them.
            let bigHillsH = featureLoneHillsHeight_d(unitDir, seed, regional, profile, amp, LONE_HILLS_BIG);
            let relief = mountainsSmooth + foothillsH + highlandsH + bigHillsH;
            // Rolling hill chains are added after erosion: eroding their steep
            // corridor walls cut thin grooves along them.
            // The small domes (common, uncommon) are a low-relief feature and
            // fade out with (1 - erosion's relief ramp)^2. On mountains and big hills,
            // full-strength gullies carved their flanks while their flat tops
            // stayed, leaving a sunken top inside a crown of ridges.
            let smallHillsRaw = featureLoneHillsHeight_d(unitDir, seed, regional, profile, amp, LONE_HILLS_SMALL);
            let lowRelief = dConst(1.0) - erosionReliefRamp_d(relief);
            let smallHillsH = dMul(smallHillsRaw, dMul(lowRelief, lowRelief));
            landHeight += bigHillsH + smallHillsH;
            let erosionInput = landHeight - mountainsH + mountainsSmooth;
            let er = erosionFilterLand_d(unitDir, erosionInput, relief, style);
            landHeight += er.delta;
            landHeight += featureLoneHillsHeight_d(unitDir, seed, regional, profile, amp, LONE_HILLS_ROLLING);
            let mesoW = dConst(1.0) - er.amount * (1.0 - EROSION_MESO_KEEP);
            if (terrainFeatureOn(TF_MESO1)) { landHeight += dMul(meso.meso1, mesoW) * (DISP_MESO1 / mesoMaxH); }
            if (terrainFeatureOn(TF_MESO2)) { landHeight += dMul(meso.meso2, mesoW) * (DISP_MESO2 / mesoMaxH); }
        }
        if (terrainFeatureOn(TF_RIVER_CARVE)) {
            landHeight += featureRiverHeight_d(unitDir, seed, regional, profile, amp);
        }
        if (terrainFeatureOn(TF_EROSION_SEEDS)) {
            landHeight += featureErosionSeedsHeight_d(unitDir, seed, regional, profile, amp);
        }

        if (terrainFeatureOn(TF_INLAND_UPLIFT)) {
            let interior = dSmoothstep(0.55, 0.85, regional.landMask);
            let detailBudget = amp.microGain + 0.005;
            landHeight += interior * detailBudget;
        }
    }
    if (landBlend.x >= 1.0) {
        return softClampHeight_d(landHeight, -1.1, 1.8, 0.25);
    }

    var oceanVariation = dConst(0.0);
    if (terrainFeatureOn(TF_OCEAN_FLOOR)) {
        let n500m = fbmAuto_d(unitDir, 0.5, 4, seed + 1000, 2.0, 0.5);
        let n100m = fbmAuto_d(unitDir, 0.1, 4, seed + 2000, 2.0, 0.5);
        let n20m = fbmAuto_d(unitDir, 0.02, 3, seed + 3000, 2.0, 0.5);
        oceanVariation = n500m * 0.05 + n100m * 0.02 + n20m * 0.005;
    }
    let oceanBase = uniforms.waterParams.y + amp.oceanDepth;
    let oceanHeight = dConst(oceanBase) + oceanVariation;

    let height = dMix(oceanHeight, landHeight, landBlend);
    return softClampHeight_d(height, -1.1, 1.8, 0.25);
}

// Tangential gradient of a terrainHeightD-style dual, in normalized height
// per metre of surface at sea level: drop the radial part of d/d(unitDir)
// and divide by the planet's noise reference radius (unitDir moves 1/R per
// metre along the surface).
fn terrainSurfaceGradient(hd: vec4<f32>, unitDir: vec3<f32>) -> vec3<f32> {
    let g = hd.yzw;
    return (g - unitDir * dot(unitDir, g)) / noiseReferenceRadiusM();
}
`;
}
