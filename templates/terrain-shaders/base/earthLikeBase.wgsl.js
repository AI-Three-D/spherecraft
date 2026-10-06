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

// Foothills scale
const SCALE_FOOTHILLS: f32 = 3.0;     // 3 km rolling hills

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
const SCALE_LONE_HILL_HUGE: f32 = 10.0;       // 10km - very rare (mesas)
const SCALE_LONE_HILL_LANDMARK: f32 = 18.0;   // 18km - exceptional (dramatic mesas)
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
const AMP_CANYON_DEPTH: f32 = 0.45;

const MICRO_HEIGHT_GAIN: f32 = 0.002;

// Lone hill heights in METERS (planet-independent via maxTerrainHeight conversion).
// These are peak heights before dome/modulation attenuation.
// Typical visible hills are ~25-50% of these values.
const HEIGHT_LONE_HILL_VERY_RARE: f32 = 1200.0;      // effective ~200-500m
const HEIGHT_LONE_HILL_EXCEPTIONAL: f32 = 1600.0;    // effective ~500-1200m (max ~1.8km)

// Rolling hill chain height
const HEIGHT_ROLLING_HILLS: f32 = 500.0;             // effective ~25-60m per bump

// ---- Meso / micro2 detail (KNOBS — adjust displacement in meters) ----
const SCALE_MICRO2: f32 = 0.008;     // 8 m wavelength  (5–10 m range)
const SCALE_MESO2: f32 = 0.75;       // 750 m wavelength

const DISP_MICRO2: f32 = 0.0;        // disabled for now (micro handled per-tile)
const DISP_MESO2: f32 = 135.0;       // amplitude (m) before the roughness/patch modulation

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

// ---- Land regions (KNOBS — meters, planet-independent) ----
// landRegions_d: a 100 km field (fbm, p10..p90 about -0.23..0.23) plus the
// inland lean; region coordinate = (field - REGION_PLAIN_TOP) /
// REGION_HINGE (one unit ~12 km at the median field gradient). Plains
// below 0; highland climb over REGION_CLIMB units from
// REGION_HIGHLAND_START to a plateau HEIGHT_PLATEAU1 up, a second climb from
// REGION_PLATEAU2_START to a high plateau HEIGHT_PLATEAU2 higher.
const SCALE_REGION_FIELD: f32 = 100.0;   // 100 km
const REGION_INLAND_BIAS: f32 = 0.15;    // field += bias x (regional base 0..1 - 0.5)
const REGION_PLAIN_TOP: f32 = -0.12;
const REGION_HINGE: f32 = 0.10;
const REGION_ROUGH_PLAIN: f32 = 0.15;    // local relief kept on the plains ..
const REGION_ROUGH_FULL: f32 = 1.5;      // .. full from here (region units)
const REGION_HIGHLAND_START: f32 = 2.0;
const REGION_CLIMB: f32 = 1.2;
const REGION_PLATEAU2_START: f32 = 4.0;
const HEIGHT_PLATEAU1: f32 = 350.0;
const HEIGHT_PLATEAU2: f32 = 350.0;
// Lake basins: hollows where a 6 km fbm exceeds LAKE_BASIN_FROM, full depth
// from LAKE_BASIN_FULL; ramping in over LAKE_BASIN_RISE region units above
// the plains.
const SCALE_LAKE_BASIN: f32 = 6.0;
const LAKE_BASIN_FROM: f32 = 0.10;
const LAKE_BASIN_FULL: f32 = 0.30;
const LAKE_BASIN_RISE: f32 = 0.8;
const HEIGHT_LAKE_BASIN: f32 = 25.0;     // metres

// ---- Mountains (KNOBS — meters, planet-independent) ----
// featureMountains: densities per km² of surface where the region is
// highland; elsewhere x *_LOWLAND_CHANCE (landmarks and ranges: anywhere),
// height x MTN_LOWLAND_HEIGHT (landmarks and ranges: x 0.85).
// Cells (one candidate each) are about *_CELL_M across; footprints must fit.
const MTN_EPS: f32 = 0.06;               // summit rounding (fraction of radius)
const MTN_TAPER_Q0: f32 = 0.45;          // base taper from (0.67 r)^2 to r
const MTN_LOWLAND_HEIGHT: f32 = 0.7;
const MTN_EROSION_START_M: f32 = 300.0;  // erosion variation raised from here ..
const MTN_EROSION_FULL_M: f32 = 1200.0;  // .. to full (mountain height)
// Uncommon mountains: a peak and 3 spurs.
const MTN_CELL_M: f32 = 45000.0;
const MTN_DENSITY_PER_KM2: f32 = 1.0 / 3000.0;
const MTN_LOWLAND_CHANCE: f32 = 0.3;
const MTN_H_MIN: f32 = 1100.0;
const MTN_H_MAX: f32 = 2200.0;
const MTN_R_MIN: f32 = 3500.0;
const MTN_R_MAX: f32 = 6000.0;
const MTN_K: f32 = 2.4;                  // flank concavity
// Landmark massif: a peak, 4 spurs and a broad base.
const MTN_LANDMARK_CELL_M: f32 = 140000.0;
const MTN_LANDMARK_DENSITY_PER_KM2: f32 = 1.0 / 50000.0;
const MTN_LANDMARK_LOWLAND_CHANCE: f32 = 1.0;
const MTN_LANDMARK_H_MIN: f32 = 2800.0;
const MTN_LANDMARK_H_MAX: f32 = 3800.0;
const MTN_LANDMARK_R_MIN: f32 = 8000.0;
const MTN_LANDMARK_R_MAX: f32 = 11000.0;
const MTN_LANDMARK_K: f32 = 2.8;
// Mountain ranges.
const MTN_RANGE_CELL_M: f32 = 220000.0;
const MTN_RANGE_DENSITY_PER_KM2: f32 = 1.0 / 50000.0;
const MTN_RANGE_LOWLAND_CHANCE: f32 = 1.0;
const MTN_RANGE_LEN_MIN: f32 = 40000.0;
const MTN_RANGE_LEN_MAX: f32 = 75000.0;
const MTN_RANGE_HALF_W_MIN: f32 = 4500.0;
const MTN_RANGE_HALF_W_MAX: f32 = 6500.0;
const MTN_RANGE_H_MIN: f32 = 1600.0;
const MTN_RANGE_H_MAX: f32 = 2600.0;
const MTN_RANGE_K: f32 = 1.8;
const MTN_RANGE_WIDTH_WAVE: f32 = 23000.0;   // backbone width varies along the spine
const MTN_RANGE_SUMMIT_WAVE1: f32 = 9000.0;  // summits and saddles along the crest
const MTN_RANGE_SUMMIT_WAVE2: f32 = 5300.0;
const MTN_RANGE_SPUR_SPACING: f32 = 4500.0;  // side spurs (jittered, ~75 % of slots)

// ---- Foothills (KNOBS — meters, planet-independent) ----
// 3 km hills; height x amp.mountainHeight (mountainBias, erosion rate).
const HEIGHT_FOOTHILLS: f32 = 165.0;
// Foothill band in regional terrainType. On land terrainType is mostly
// 0.34-0.50 (p10-p90), so this covers roughly the top quarter of land.
const FOOTHILL_TT_START: f32 = 0.45;
const FOOTHILL_TT_FULL: f32 = 0.56;
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
    amp.mountainHeight = profile.mountainBias;
    amp.canyonDepth = AMP_CANYON_DEPTH * profile.canyonBias;
    amp.microGain = MICRO_HEIGHT_GAIN * profile.microGain;

    let erosion = clamp(uniforms.erosionParams.y, 0.0, 1.0);
    amp.mountainHeight *= (1.0 - erosion * 0.2);
    amp.hillsHeight *= (1.0 - erosion * 0.1);
    amp.canyonDepth *= (1.0 + erosion * 0.25);

    amp.loneHillsHeight = 1.0 * profile.hillBias;
    amp.loneHillsHeight *= (1.0 - erosion * 0.15);

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
// Last step: the river channels (core/world/water/riverCarve.wgsl.js; a
// pass-through where the shader is built without them).
fn calculateTerrainHeightD(seed: i32, unitDir: vec3<f32>) -> vec4<f32> {
    return riverCarve_d(calculateTerrainHeightBaseD(seed, unitDir), unitDir);
}

// The terrain before the river carve.
fn calculateTerrainHeightBaseD(seed: i32, unitDir: vec3<f32>) -> vec4<f32> {
    let profile = getTerrainProfile();
    let amp = getTerrainAmplitudes(profile);

    let regional = getRegionalCharacter_d(unitDir, seed, profile);
    let landBlend = dSmoothstep(0.15, 0.45, regional.landMask);

    var landHeight = dConst(0.0);
    if (landBlend.x > 0.0) {
        // River valleys (core/world/water/riverValley.wgsl.js): shaped into
        // the landform before erosion and again after the detail added
        // after it; a pass-through where the shader is built without them.
        let vly = valleyShapeAt(unitDir);
        landHeight = select(dConst(0.0), regional.baseElevation * amp.continentalShelf, terrainFeatureOn(TF_CONTINENT_RELIEF));

        // Regional landform: plains / uplands / highlands (see
        // landRegions_d); its relief multiplier damps the local detail.
        var region: LandRegionD;
        region.coord = dConst(REGION_HIGHLAND_START);
        region.height = dConst(0.0);
        region.rough = dConst(1.0);
        if (terrainFeatureOn(TF_LAND_REGIONS)) {
            region = landRegions_d(unitDir, seed, regional);
            landHeight += region.height;
        }

        // Erosion style by location, 0 = rounded .. 1 = jagged (strength
        // and rounding of the erosion filter).
        let style = terrainStyle_d(unitDir);

        // Foothills: 3 km hills over the most rugged quarter of the land.
        // Slope-continuous, so part of the erosion input, and counted as
        // relief.
        var foothillsH = dConst(0.0);
        if (terrainFeatureOn(TF_FOOTHILLS)) {
            let footBand = dSmoothstep(FOOTHILL_TT_START, FOOTHILL_TT_FULL, regional.terrainType);
            if (footBand.x > 0.0) {
                let hillN = fbmAuto_d(unitDir, SCALE_FOOTHILLS, 3, seed + 1950, 2.0, 0.5);
                foothillsH = dMul(footBand, dSmoothstep(-0.3, 0.6, hillN)) * ((HEIGHT_FOOTHILLS / maxTerrainHeightM()) * amp.mountainHeight);
                landHeight += foothillsH;
            }
        }

        {
            // The filter reads a slope-continuous landform (every term here
            // is C1), and its height change is added to the terrain. Relief,
            // which sets the strength, is the large landforms only. The
            // carved features (river channel, erosion-seed pits) come after,
            // so erosion does not fill them.
            let bigHillsH = featureBigHillsHeight_d(unitDir, seed, amp);
            let mountainsH = featureMountainsHeight_d(unitDir, seed);
            let relief = foothillsH + bigHillsH + mountainsH;
            landHeight += bigHillsH + mountainsH;
            // Mountains are always carved: erosion's regional variation is
            // raised to full from MTN_EROSION_FULL_M of mountain height.
            let mtnCarve = dQuintic(dClamp((mountainsH * maxTerrainHeightM() - dConst(MTN_EROSION_START_M)) * (1.0 / (MTN_EROSION_FULL_M - MTN_EROSION_START_M)), 0.0, 1.0));
            landHeight = valleyApplyPre_d(vly, landHeight);
            let er = erosionFilterLand_d(unitDir, landHeight, relief, style, mtnCarve);
            landHeight += er.delta;
            // Rolling hill chains are added after erosion: eroding their steep
            // corridor walls cut thin grooves along them.
            landHeight += dMul(featureRollingHillsHeight_d(unitDir, seed, regional, profile, amp), region.rough);
            // meso2 goes on top of the eroded terrain, faded where erosion is
            // strong. micro2 (DISP_MICRO2 = 0) contributes nothing; see
            // featureMesoDetail_d.
            if (terrainFeatureOn(TF_MESO2)) {
                let mesoRoughness = dSmoothMax(regional.terrainType, regional.ruggedness * 0.5, 0.02);
                let meso2 = featureMesoDetail_d(unitDir, seed, profile, mesoRoughness);
                let mesoW = dMul(dConst(1.0) - er.amount * (1.0 - EROSION_MESO_KEEP), region.rough);
                landHeight += dMul(meso2, mesoW) * (DISP_MESO2 / maxTerrainHeightM());
            }
        }
        if (terrainFeatureOn(TF_LAKE_BASINS)) {
            landHeight += featureLakeBasinsHeight_d(unitDir, seed, region);
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
        landHeight = valleyApply_d(vly, landHeight);
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
