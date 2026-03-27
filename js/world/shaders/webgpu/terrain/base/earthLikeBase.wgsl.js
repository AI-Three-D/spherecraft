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

fn calculateTerrainHeight(wx: f32, wy: f32, seed: i32, unitDir: vec3<f32>) -> f32 {
    let profile = getTerrainProfile();
    let amp = getTerrainAmplitudes(profile);

    // ==================== Regional Character ====================
    let regional = getRegionalCharacter(wx, wy, unitDir, seed, profile);
    let landBlend = smoothstep(0.15, 0.45, regional.landMask);

    // Feature type weights (kept for when features are re-enabled)
    let plainness = smoothstep(0.4, 0.2, regional.terrainType);
    let hillness = smoothstep(0.25, 0.5, regional.terrainType) *
                   smoothstep(0.75, 0.5, regional.terrainType);
    let mountainness = smoothstep(0.55, 0.8, regional.terrainType);

    // ==================== Land Height: BASELINE (flat + micro only) ====================
    var landHeight = regional.baseElevation * amp.continentalShelf;

    // --- FEATURES DISABLED: re-enable one-by-one after baseline is satisfactory ---
    // landHeight += featurePlainsHeight(wx, wy, unitDir, seed, profile, amp) * plainness;
    // landHeight += featureHillsHeight(wx, wy, unitDir, seed, profile, amp) * hillness;

    // ==================== Mountains (line-based ranges with foothills) ====================
    if (mountainness > 0.01) {
        landHeight += featureMountainsHeight(wx, wy, unitDir, seed, regional, profile, amp) * mountainness;
    }

    // let canyonBlend = mix(0.3, 1.0, regional.tectonicActivity);
    // landHeight += featureCanyonHeight(wx, wy, unitDir, seed, regional, profile, amp) * canyonBlend * landBlend;

    // ==================== Micro Detail ====================
    // NOTE: Micro detail is now applied in a later pass based on tile type.

    // ==================== Meso Detail (micro2 + meso1–3) ====================
    let mesoRoughness = max(regional.terrainType, regional.ruggedness * 0.5);
    let meso = featureMesoDetail(wx, wy, unitDir, seed, profile, mesoRoughness, landHeight);
    let mesoMaxH = maxTerrainHeightM();
    landHeight += meso.x * (DISP_MICRO2 / mesoMaxH);
    landHeight += meso.y * (DISP_MESO1  / mesoMaxH);
    landHeight += meso.z * (DISP_MESO2  / mesoMaxH);
    landHeight += meso.w * (DISP_MESO3  / mesoMaxH);

    // ==================== Highlands (additive plateaus) ====================
    landHeight += featureHighlandsHeight(wx, wy, unitDir, seed, regional, profile, amp);

    // ==================== Lone Hills (additive feature) ====================
    landHeight += featureLoneHillsHeight(wx, wy, unitDir, seed, regional, profile, amp);

    // ==================== Inland Uplift ====================
    let interior = smoothstep(0.55, 0.85, regional.landMask);
    let detailBudget = amp.microGain + 0.005;
    landHeight += interior * detailBudget;

    // ==================== Ocean Floor ====================
    let n500m = fbmAuto(wx, wy, unitDir, 0.5, 4, seed + 1000, 2.0, 0.5);
    let n100m = fbmAuto(wx, wy, unitDir, 0.1, 4, seed + 2000, 2.0, 0.5);
    let n20m = fbmAuto(wx, wy, unitDir, 0.02, 3, seed + 3000, 2.0, 0.5);
    let oceanBase = uniforms.waterParams.y + amp.oceanDepth;
    let oceanVariation = n500m * 0.05 + n100m * 0.02 + n20m * 0.005;
    let oceanHeight = oceanBase + oceanVariation;

    // ==================== Blend Land and Ocean ====================
    var height = mix(oceanHeight, landHeight, landBlend);

    return softClampHeight(height, -1.1, 1.8, 0.25);
}
`;
}
