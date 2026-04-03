// js/world/shaders/webgpu/terrain/climateCommon.wgsl.js
// Shared climate model for terrain + asset scattering.

export function createClimateCommon() {
  return `
// ==================== Climate Common ====================

struct ClimateInfo {
    temperature: f32,   // 0=very cold, 0.5=temperate, 1=very hot
    precipitation: f32, // 0=dry, 1=wet
    latitude: f32,      // 0-1 (abs value)
};

struct ClimateConfig {
    climateParams: vec4<f32>,
    climateZone0: vec4<f32>,
    climateZone0Extra: vec4<f32>,
    climateZone1: vec4<f32>,
    climateZone1Extra: vec4<f32>,
    climateZone2: vec4<f32>,
    climateZone2Extra: vec4<f32>,
    climateZone3: vec4<f32>,
    climateZone3Extra: vec4<f32>,
    climateZone4: vec4<f32>,
    climateZone4Extra: vec4<f32>,
};

// Get latitude from unit direction (sphere) or approximate for flat
fn getLatitude(unitDir: vec3<f32>) -> f32 {
    // unitDir.y is the vertical component (-1 to 1)
    // Convert to absolute latitude (0 at equator, 1 at poles)
    return abs(unitDir.y);
}

// Blend weight for a latitude band with soft edges (degrees).
fn climateZoneWeight(latDeg: f32, minLat: f32, maxLat: f32, blend: f32) -> f32 {
    let enter = smoothstep(minLat - blend, minLat + blend, latDeg);
    let exit = 1.0 - smoothstep(maxLat - blend, maxLat + blend, latDeg);
    return clamp(enter * exit, 0.0, 1.0);
}

// Climate-only FBM wrapper (sphere vs flat) with explicit params.
fn climateFbmAuto(
    wx: f32, wy: f32, unitDir: vec3<f32>, scale: f32,
    octaves: i32, seed: i32, lac: f32, gain: f32,
    face: i32, noiseReferenceRadiusM: f32
) -> f32 {
    if (face >= 0) {
        return fbmMetricSphere3D(unitDir, scale, GEOLOGY_SCALE, noiseReferenceRadiusM, octaves, seed, lac, gain);
    }
    return fbmMetricFlat2D(wx, wy, scale, GEOLOGY_SCALE, octaves, seed, lac, gain);
}

// Calculate climate for a location (single source of truth)
fn getClimateWithConfig(
    wx: f32,
    wy: f32,
    unitDir: vec3<f32>,
    elevation: f32,
    seed: i32,
    face: i32,
    noiseReferenceRadiusM: f32,
    maxTerrainHeightM: f32,
    cfg: ClimateConfig
) -> ClimateInfo {
    var climate: ClimateInfo;

    let lat = getLatitude(unitDir);
    climate.latitude = lat;

    // Climate disabled: return temperate defaults.
    if (cfg.climateParams.w < 0.5) {
        climate.temperature = 0.5;
        climate.precipitation = 0.5;
        return climate;
    }

    // Resolve zone based on latitude degrees using config-provided bands.
    // Blend adjacent zones to avoid hard biome cuts at latitude boundaries.
    // Add low-frequency latitude warping so temperature bands are ragged, not straight.
    let latDegBase = lat * 90.0;
    let latWarpL = climateFbmAuto(wx, wy, unitDir, 220.0, 2, seed + 5100, 2.0, 0.5, face, noiseReferenceRadiusM) * 6.0;
    let latWarpM = climateFbmAuto(wx, wy, unitDir, 80.0, 2, seed + 5110, 2.0, 0.5, face, noiseReferenceRadiusM) * 2.5;
    let latDeg = clamp(latDegBase + latWarpL + latWarpM, 0.0, 90.0);
    let blendDeg: f32 = 3.5;

    let w0 = climateZoneWeight(latDeg, cfg.climateZone0.x, cfg.climateZone0.y, blendDeg);
    let w1 = climateZoneWeight(latDeg, cfg.climateZone1.x, cfg.climateZone1.y, blendDeg);
    let w2 = climateZoneWeight(latDeg, cfg.climateZone2.x, cfg.climateZone2.y, blendDeg);
    let w3 = climateZoneWeight(latDeg, cfg.climateZone3.x, cfg.climateZone3.y, blendDeg);
    let w4 = climateZoneWeight(latDeg, cfg.climateZone4.x, cfg.climateZone4.y, blendDeg);

    let wSum = max(w0 + w1 + w2 + w3 + w4, 0.0001);

    let precipMin =
        (w0 * cfg.climateZone0.w +
         w1 * cfg.climateZone1.w +
         w2 * cfg.climateZone2.w +
         w3 * cfg.climateZone3.w +
         w4 * cfg.climateZone4.w) / wSum;

    let precipMax =
        (w0 * cfg.climateZone0Extra.x +
         w1 * cfg.climateZone1Extra.x +
         w2 * cfg.climateZone2Extra.x +
         w3 * cfg.climateZone3Extra.x +
         w4 * cfg.climateZone4Extra.x) / wSum;

    let tempModifier =
        (w0 * cfg.climateZone0.z +
         w1 * cfg.climateZone1.z +
         w2 * cfg.climateZone2.z +
         w3 * cfg.climateZone3.z +
         w4 * cfg.climateZone4.z) / wSum;

    // Base temperature from config (C) with per-zone modifier.
    let baseTempC = cfg.climateParams.y + tempModifier;
    let elevMeters = elevation * maxTerrainHeightM;
    let elevKm = elevMeters / 1000.0;
    let tempC = baseTempC + cfg.climateParams.x * elevKm;

    // Map C to normalized [0,1] bands used by biome rules.
    // -30C -> 0, 40C -> 1
    let tempNorm = (tempC + 30.0) / 70.0;
    climate.temperature = clamp(tempNorm, 0.0, 1.0);

    // Generate precipitation using large-scale noise
    let precipScale = max(cfg.climateParams.z, 0.001);
    let precipNoise = climateFbmAuto(wx, wy, unitDir, precipScale, 3, seed + 5000, 2.0, 0.5, face, noiseReferenceRadiusM);
    // Map noise (-1 to 1) to the band's precipitation range
    let precipNorm = (precipNoise + 1.0) * 0.5;  // 0-1
    climate.precipitation = mix(precipMin, precipMax, precipNorm);

    return climate;
}
`;
}
