// js/world/shaders/webgpu/terrain/surfaceCommon.wgsl.js

import { createClimateCommon } from './climateCommon.wgsl.js';

export function createSurfaceCommon() {
    return `
  // ==================== Surface Type System ====================
  // Modular surface determination that parallels the terrain height system.
  // Each terrain feature contributes surface type weights which are blended.

  // Surface type constants (matching TILE_TYPES in js/types.js)
  const SURFACE_WATER: u32 = 0u;
  const GRASS_SHORT_BASE: u32 = 10u;
  const GRASS_MEDIUM_BASE: u32 = 14u;
  const GRASS_TALL_BASE: u32 = 18u;
  const GRASS_MEADOW_BASE: u32 = 22u;
  const GRASS_FLOWER_FIELD_BASE: u32 = 26u;
  const SURFACE_GRASS_BASE: u32 = GRASS_SHORT_BASE;
  const SURFACE_SAND_BASE: u32 = 30u;      // SAND_COARSE_1
  const SURFACE_ROCK_BASE: u32 = 42u;      // ROCK_OUTCROP_1
  const SURFACE_TUNDRA_BASE: u32 = 54u;    // TUNDRA_BARREN_1
  const SURFACE_TUNDRA_LICHEN_BASE: u32 = 58u; // TUNDRA_LICHEN_1
  const SURFACE_TUNDRA_MOSS_BASE: u32 = 62u;   // TUNDRA_MOSS_1
  const FOREST_DENSE_SINGLE_BASE: u32 = 66u;
  const FOREST_SPARSE_SINGLE_BASE: u32 = 70u;
  const FOREST_DENSE_MIXED_BASE: u32 = 74u;
  const FOREST_SPARSE_MIXED_BASE: u32 = 78u;
  const SURFACE_FOREST_FLOOR_BASE: u32 = FOREST_DENSE_MIXED_BASE;
  const FOREST_RAINFOREST_BASE: u32 = 142u;
  const FOREST_JUNGLE_BASE: u32 = 146u;
  const SURFACE_SWAMP_BASE: u32 = 82u;     // SWAMP_MARSH_1
  const SURFACE_DIRT_BASE: u32 = 94u;      // DIRT_DRY_1
  const SURFACE_DIRT_LOAM_BASE: u32 = 98u; // DIRT_LOAM_1
  const SURFACE_DIRT_CLAY_BASE: u32 = 102u; // DIRT_CLAY_1
  const SURFACE_MUD_BASE: u32 = 106u;      // MUD_WET_1
  const SURFACE_MUD_SILT_BASE: u32 = 110u; // MUD_SILT_1
  const SURFACE_MUD_PEAT_BASE: u32 = 114u; // MUD_PEAT_1
  const SURFACE_VOLCANIC_BASE: u32 = 118u; // VOLCANIC_BASALT_1
  const SURFACE_SNOW_FRESH_BASE: u32 = 130u; // SNOW_FRESH_1
  const SURFACE_SNOW_PACK_BASE: u32 = 134u;  // SNOW_PACK_1
  const SURFACE_SNOW_ICE_BASE: u32 = 138u;   // SNOW_ICE_1
  const SURFACE_SNOW_BASE: u32 = SURFACE_SNOW_FRESH_BASE;
  const SURFACE_DESERT_DRY_BASE: u32 = 150u; // DESERT_DRY_1
  const SURFACE_DESERT_SEMI_ARID_BASE: u32 = 154u; // DESERT_SEMI_ARID_1
  const SURFACE_DESERT_TREES_DRY_BASE: u32 = 158u; // DESERT_TREES_DRY_1
  const SURFACE_DESERT_TREES_SEMI_ARID_BASE: u32 = 162u; // DESERT_TREES_SEMI_ARID_1

  const SURFACE_GRASS_MIN: u32 = 10u;
  const SURFACE_GRASS_MAX: u32 = 29u;
  const SURFACE_SAND_MIN: u32 = 30u;
  const SURFACE_SAND_MAX: u32 = 41u;
  const SURFACE_ROCK_MIN: u32 = 42u;
  const SURFACE_ROCK_MAX: u32 = 53u;
  const SURFACE_TUNDRA_MIN: u32 = 54u;
  const SURFACE_TUNDRA_MAX: u32 = 65u;
  const SURFACE_FOREST_FLOOR_MIN: u32 = 66u;
  const SURFACE_FOREST_FLOOR_MAX: u32 = 81u;
  const SURFACE_FOREST_TROPICAL_MIN: u32 = 142u;
  const SURFACE_FOREST_TROPICAL_MAX: u32 = 149u;
  const SURFACE_SWAMP_MIN: u32 = 82u;
  const SURFACE_SWAMP_MAX: u32 = 93u;
  const SURFACE_DIRT_MIN: u32 = 94u;
  const SURFACE_DIRT_MAX: u32 = 105u;
  const SURFACE_MUD_MIN: u32 = 106u;
  const SURFACE_MUD_MAX: u32 = 117u;
  const SURFACE_VOLCANIC_MIN: u32 = 118u;
  const SURFACE_VOLCANIC_MAX: u32 = 129u;
  const SURFACE_SNOW_MIN: u32 = 130u;
  const SURFACE_SNOW_MAX: u32 = 141u;
  const SURFACE_DESERT_MIN: u32 = 150u;
  const SURFACE_DESERT_MAX: u32 = 165u;

  // Surface weights structure - holds probability weights for each surface type
  struct SurfaceWeights {
      grass: f32,
      forestFloor: f32,
      rock: f32,
      sand: f32,
      dirt: f32,
      snow: f32,
      tundra: f32,
      mud: f32,
      swamp: f32,
      volcanic: f32,
  };

  fn isGrassTile(tileType: u32) -> bool {
      return tileType >= SURFACE_GRASS_MIN && tileType <= SURFACE_GRASS_MAX;
  }

  fn isSandTile(tileType: u32) -> bool {
      return tileType >= SURFACE_SAND_MIN && tileType <= SURFACE_SAND_MAX;
  }

  fn isRockTile(tileType: u32) -> bool {
      return tileType >= SURFACE_ROCK_MIN && tileType <= SURFACE_ROCK_MAX;
  }

  fn isTundraTile(tileType: u32) -> bool {
      return tileType >= SURFACE_TUNDRA_MIN && tileType <= SURFACE_TUNDRA_MAX;
  }

  fn isForestFloorTile(tileType: u32) -> bool {
      let temperate = tileType >= SURFACE_FOREST_FLOOR_MIN && tileType <= SURFACE_FOREST_FLOOR_MAX;
      let tropical = tileType >= SURFACE_FOREST_TROPICAL_MIN && tileType <= SURFACE_FOREST_TROPICAL_MAX;
      return temperate || tropical;
  }

  fn isSwampTile(tileType: u32) -> bool {
      return tileType >= SURFACE_SWAMP_MIN && tileType <= SURFACE_SWAMP_MAX;
  }

  fn isDirtTile(tileType: u32) -> bool {
      return tileType >= SURFACE_DIRT_MIN && tileType <= SURFACE_DIRT_MAX;
  }

  fn isMudTile(tileType: u32) -> bool {
      return tileType >= SURFACE_MUD_MIN && tileType <= SURFACE_MUD_MAX;
  }

  fn isVolcanicTile(tileType: u32) -> bool {
      return tileType >= SURFACE_VOLCANIC_MIN && tileType <= SURFACE_VOLCANIC_MAX;
  }

  fn isSnowTile(tileType: u32) -> bool {
      return tileType >= SURFACE_SNOW_MIN && tileType <= SURFACE_SNOW_MAX;
  }

  fn isDesertTile(tileType: u32) -> bool {
      return tileType >= SURFACE_DESERT_MIN && tileType <= SURFACE_DESERT_MAX;
  }

${createClimateCommon()}

// Terrain-facing wrapper that plugs terrain uniforms into the shared climate model.
fn getClimate(wx: f32, wy: f32, unitDir: vec3<f32>, elevation: f32, seed: i32) -> ClimateInfo {
    let cfg = ClimateConfig(
        uniforms.climateParams,
        uniforms.climateZone0,
        uniforms.climateZone0Extra,
        uniforms.climateZone1,
        uniforms.climateZone1Extra,
        uniforms.climateZone2,
        uniforms.climateZone2Extra,
        uniforms.climateZone3,
        uniforms.climateZone3Extra,
        uniforms.climateZone4,
        uniforms.climateZone4Extra
    );
    return getClimateWithConfig(
        wx, wy, unitDir, elevation, seed,
        uniforms.face,
        noiseReferenceRadiusM(),
        maxTerrainHeightM(),
        cfg
    );
}

// Metric cell noise (meters, planet-safe). Uses 2D on flat worlds, 3D on sphere.
fn metricCellNoise01(wx: f32, wy: f32, unitDir: vec3<f32>, scale: f32, seed: i32) -> f32 {
    if (uniforms.face < 0) {
        let ix = i32(floor(wx * scale));
        let iy = i32(floor(wy * scale));
        return hashToFloat01(hash2d(vec2<i32>(ix, iy), seed));
    }
    let R = noiseReferenceRadiusM();
    let p = unitDir * R * scale;
    let ix = i32(floor(p.x));
    let iy = i32(floor(p.y));
    let iz = i32(floor(p.z));
    return hashToFloat01(hash3d(vec3<i32>(ix, iy, iz), seed));
}

// 1-32m clustered noise for stochastic tile selection.
fn tileClusterNoise01(wx: f32, wy: f32, unitDir: vec3<f32>, seed: i32) -> f32 {
    let t1  = metricCellNoise01(wx, wy, unitDir, 1.0,     seed + 10);
    let t2  = metricCellNoise01(wx, wy, unitDir, 0.5,     seed + 20);
    let t4  = metricCellNoise01(wx, wy, unitDir, 0.25,    seed + 30);
    let t8  = metricCellNoise01(wx, wy, unitDir, 0.125,   seed + 40);
    let t16 = metricCellNoise01(wx, wy, unitDir, 0.0625,  seed + 50);
    let t32 = metricCellNoise01(wx, wy, unitDir, 0.03125, seed + 60);
    var n = mix(t1, t2, 0.35);
    n = mix(n, t4, 0.25);
    n = mix(n, t8, 0.18);
    n = mix(n, t16, 0.14);
    n = mix(n, t32, 0.10);
    return n;
}

// Multi-scale biome noise (meters -> GEOLOGY units).
fn biomeNoise(wx: f32, wy: f32, unitDir: vec3<f32>, seed: i32) -> f32 {
    let nL = fbmAuto(wx, wy, unitDir, 0.8,  3, seed + 100, 2.0, 0.5);   // ~800m+
    let nM = fbmAuto(wx, wy, unitDir, 0.2,  4, seed + 200, 2.0, 0.5);   // ~200m+
    let nS = fbmAuto(wx, wy, unitDir, 0.05, 4, seed + 300, 2.0, 0.5);   // ~50m+
    let nT = fbmAuto(wx, wy, unitDir, 0.012, 3, seed + 400, 2.0, 0.5);  // ~12m+
    let t = tileClusterNoise01(wx, wy, unitDir, seed + 500) * 2.0 - 1.0;
    let n = nL * 0.32 + nM * 0.26 + nS * 0.20 + nT * 0.12 + t * 0.35;
    return clamp(n, -1.0, 1.0);
}

// Probabilistic warm-biome weights for sand/dirt/grass.
fn computeWarmBiomeWeights(
    climate: ClimateInfo,
    wx: f32, wy: f32, unitDir: vec3<f32>,
    seed: i32
) -> SurfaceWeights {
    var w = zeroSurfaceWeights();
    let p = climate.precipitation;

    // Base scores: grass appears even in semi-arid (p~0.25+), sand only when very dry.
    var sandScore = (0.35 - p) * 2.5;
    var grassScore = (p - 0.20) * 2.0;
    var dirtScore = 0.45 - abs(p - 0.35) * 2.2;

    let trans = 1.0 - smoothstep(0.15, 0.40, abs(p - 0.35));
    let nAmp = mix(0.7, 1.7, trans);

    sandScore += biomeNoise(wx, wy, unitDir, seed + 6100) * nAmp;
    dirtScore += biomeNoise(wx, wy, unitDir, seed + 6200) * nAmp;
    grassScore += biomeNoise(wx, wy, unitDir, seed + 6300) * nAmp;

    // Softmax -> probabilities.
    let m = max(sandScore, max(dirtScore, grassScore));
    let eSand = exp(sandScore - m);
    let eDirt = exp(dirtScore - m);
    let eGrass = exp(grassScore - m);
    let inv = 1.0 / max(eSand + eDirt + eGrass, 0.0001);

    w.sand = eSand * inv;
    w.dirt = eDirt * inv;
    w.grass = eGrass * inv;

    // Keep a bit of dirt in the transition band (prevents grass/sand hard cuts).
    let dirtBoost = trans * 0.15;
    w.dirt += dirtBoost;
    let s0 = max(w.sand + w.dirt + w.grass, 0.0001);
    w.sand /= s0;
    w.dirt /= s0;
    w.grass /= s0;

    // Grass allowed at lower precipitation, sand only when dry.
    let grassGate = smoothstep(0.20, 0.40, p);
    let sandGate = 1.0 - smoothstep(0.40, 0.60, p);
    w.grass *= grassGate;
    w.sand *= sandGate;
    let s = max(w.sand + w.dirt + w.grass, 0.0001);
    w.sand /= s;
    w.dirt /= s;
    w.grass /= s;
    return w;
}

// Determine primary surface type based on climate
fn selectClimateSurface(climate: ClimateInfo) -> u32 {
    let temp = climate.temperature;
    let precip = climate.precipitation;
    
    // VERY COLD (temp < 0.2): Snow everywhere
    if (temp < 0.2) {
        return SURFACE_SNOW_BASE;
    }
    
    // COLD (temp 0.2-0.4)
    if (temp < 0.4) {
        // High precipitation: Tundra
        if (precip > 0.5) {
            return SURFACE_TUNDRA_BASE;
        }
        // Dry: Dirt
        return SURFACE_DIRT_BASE;
    }
    
    // COOL (temp 0.4-0.55)
    if (temp < 0.55) {
        // High precipitation: Tundra or grass transition
        if (precip > 0.6) {
            return SURFACE_TUNDRA_BASE;
        }
        if (precip > 0.3) {
            return SURFACE_GRASS_BASE;
        }
        // Dry: Dirt
        return SURFACE_DIRT_BASE;
    }
    
    // TEMPERATE (temp 0.55-0.75)
    if (temp < 0.75) {
        // High precipitation: Grass
        if (precip > 0.5) {
            return SURFACE_GRASS_BASE;
        }
        // Semi-arid: Dirt
        if (precip > 0.3) {
            return SURFACE_DIRT_BASE;
        }
        // Arid: Semi-arid desert
        return SURFACE_DESERT_SEMI_ARID_BASE;
    }
    
    // HOT (temp >= 0.75)
    // High precipitation: Grass
    if (precip > 0.6) {
        return SURFACE_GRASS_BASE;
    }
    // Moderate: Semi-arid desert
    if (precip > 0.3) {
        return SURFACE_DESERT_SEMI_ARID_BASE;
    }
    // Dry: Desert
    return SURFACE_DESERT_DRY_BASE;
}

// Determine secondary surface type (for mixing)
fn selectSecondaryClimateSurface(climate: ClimateInfo) -> u32 {
    let temp = climate.temperature;
    let precip = climate.precipitation;
    
    // Very cold: just snow
    if (temp < 0.2) {
        return SURFACE_SNOW_BASE;
    }
    
    // Cold to cool high precipitation: forest floor shows through
    if (temp < 0.55 && precip > 0.5) {
        return SURFACE_FOREST_FLOOR_BASE;
    }
    
    // Temperate to hot high precipitation: forest floor
    if (precip > 0.6) {
        return SURFACE_FOREST_FLOOR_BASE;
    }
    
    // Hot to temperate dry: dirt
    if (temp > 0.5 && precip < 0.5) {
        return SURFACE_DIRT_BASE;
    }
    
    // Default to primary
    return selectClimateSurface(climate);
}

// Sand climate transition: sand -> dirt -> grass with noisy, varying width.
fn computeSandTransitionWeights(
    climate: ClimateInfo,
    wx: f32, wy: f32, unitDir: vec3<f32>,
    seed: i32
) -> SurfaceWeights {
    var w = zeroSurfaceWeights();

    let p = climate.precipitation;
    // Multi-scale noise for ragged, varying-width transition.
    // Scales are in GEOLOGY units (meters / GEOLOGY_SCALE). With GEOLOGY_SCALE=1000:
    // 0.001..0.005 => 1-5m, 0.005..0.01 => 5-10m, 0.01..0.02 => 10-20m, etc.
    let nMacro  = fbmAuto(wx, wy, unitDir, 2.5, 3, seed + 6100, 2.0, 0.5);   // ~2.5km..0.6km
    let nLarge  = fbmAuto(wx, wy, unitDir, 0.60, 4, seed + 6110, 2.0, 0.5);  // ~600m..75m
    let nMid    = fbmAuto(wx, wy, unitDir, 0.18, 4, seed + 6120, 2.0, 0.5);  // ~180m..22m
    let nSmall  = fbmAuto(wx, wy, unitDir, 0.04, 5, seed + 6125, 2.0, 0.5);  // ~40m..2.5m
    let nTiny   = fbmAuto(wx, wy, unitDir, 0.01, 4, seed + 6130, 2.0, 0.5);  // ~10m..1.25m

    let bandSand = smoothstep(0.20, 0.32, p) * (1.0 - smoothstep(0.38, 0.48, p));
    let bandGrass = smoothstep(0.52, 0.62, p) * (1.0 - smoothstep(0.68, 0.80, p));
    let band = max(bandSand, bandGrass);

    let edgeNoiseBase = nMacro * 0.12 + nLarge * 0.10 + nMid * 0.08 + nSmall * 0.06 + nTiny * 0.05;
    let edgeNoise = edgeNoiseBase * mix(0.15, 0.85, band);

    // Tile-scale dither (1-16m) to create 1-4 tile patches at the smallest scales.
    // Blend cell noise with a tiny FBM to reduce grid-regularity.
    let d1 = metricCellNoise01(wx, wy, unitDir, 1.0,   seed + 6400);
    let d2 = metricCellNoise01(wx, wy, unitDir, 0.5,   seed + 6410);
    let d4 = metricCellNoise01(wx, wy, unitDir, 0.25,  seed + 6420);
    let d8 = metricCellNoise01(wx, wy, unitDir, 0.125, seed + 6430);
    let cellDither = (d1 * 0.40 + d2 * 0.26 + d4 * 0.20 + d8 * 0.14) - 0.5;
    let fbmDither = fbmAuto(wx, wy, unitDir, 0.015, 3, seed + 6435, 2.0, 0.5) * 0.5;
    let tileDither = mix(cellDither, fbmDither, 0.35);

    let m = clamp(p + edgeNoise + tileDither * mix(0.12, 0.30, band), 0.0, 1.0);

    // Per-boundary jitter (multi-scale) so the edge breaks up at many sizes.
    let tA = nMid * 0.06 + nSmall * 0.05 + nTiny * 0.04 + tileDither * 0.06;
    let tB = nMid * 0.05 - nSmall * 0.04 + nTiny * 0.04 - tileDither * 0.05;

    // Overlapping bands -> noisy mix with *narrow* dirt buffer.
    let sandW = 1.0 - smoothstep(0.32 + tA, 0.38 + tA, m);
    var dirtW = smoothstep(0.40 + tA, 0.44 + tA, m) *
                (1.0 - smoothstep(0.50 + tB, 0.54 + tB, m));
    let grassW = smoothstep(0.58 + tB, 0.64 + tB, m);

    // Per-type patch noise to create clustered, dithered edges.
    let sandPatch = (fbmAuto(wx, wy, unitDir, 0.40, 2, seed + 6200, 2.0, 0.5) + 1.0) * 0.5;
    let dirtPatch = (fbmAuto(wx, wy, unitDir, 0.28, 2, seed + 6210, 2.0, 0.5) + 1.0) * 0.5;
    let grassPatch = (fbmAuto(wx, wy, unitDir, 0.35, 2, seed + 6220, 2.0, 0.5) + 1.0) * 0.5;
    let microPatch = (fbmAuto(wx, wy, unitDir, 0.05, 2, seed + 6230, 2.0, 0.5) + 1.0) * 0.5;
    let nanoPatch  = (fbmAuto(wx, wy, unitDir, 0.01, 2, seed + 6240, 2.0, 0.5) + 1.0) * 0.5;
    let cluster = tileClusterNoise01(wx, wy, unitDir, seed + 6250);

    let sandMod = mix(0.6, 1.5, sandPatch) * mix(0.8, 1.25, microPatch) * mix(0.85, 1.15, nanoPatch) * mix(0.9, 1.1, cluster);
    let dirtMod = mix(0.4, 1.1, dirtPatch) * mix(0.7, 1.15, microPatch) * mix(0.85, 1.10, nanoPatch) * mix(0.9, 1.1, cluster);
    let grassMod = mix(0.6, 1.5, grassPatch) * mix(0.8, 1.25, microPatch) * mix(0.85, 1.15, nanoPatch) * mix(0.9, 1.1, cluster);

    var sandW2 = sandW * sandMod;
    var dirtW2 = dirtW * dirtMod;
    var grassW2 = grassW * grassMod;

    // Keep dirt strictly as a thin edge between sand and grass.
    let edgeCore = min(sandW2, grassW2);
    let edgeGate = smoothstep(0.18, 0.35, edgeCore);
    let edgeBalance = 1.0 - smoothstep(0.25, 0.55, abs(sandW2 - grassW2));
    let edgeDither = smoothstep(0.40, 0.70, tileClusterNoise01(wx, wy, unitDir, seed + 6260));
    dirtW2 = edgeGate * edgeBalance * edgeDither * 0.12;

    // Temperature + moisture gates: boost sand in hot/dry climates.
    let t = climate.temperature;
    let hot = smoothstep(0.40, 0.65, t);
    var warm = smoothstep(0.35, 0.55, t);
    let dry = 1.0 - smoothstep(0.40, 0.65, p);
    let precipGate = smoothstep(0.22, 0.42, p);

    let sandBoost = mix(0.9, 1.8, hot) * mix(0.9, 1.6, dry);
    sandW2 *= hot * dry * sandBoost;
    grassW2 *= warm * precipGate;
    // Dirt already constrained to the edge; no extra transition scaling needed.
    sandW2 *= mix(0.95, 1.45, dry);

    w.sand = sandW2;
    w.dirt = dirtW2;
    w.grass = grassW2;
    return normalizeSurfaceWeights(w);
}

// Desert = climate sand with very low precipitation.
fn isDesertClimate(climate: ClimateInfo) -> bool {
    let primary = selectClimateSurface(climate);
    return primary == SURFACE_SAND_BASE && climate.precipitation <= 0.3;
}

  // Surface parameters from uniforms._pad5:
  // x = rockCoverageMin (minimum rock coverage even on flat terrain)
  // y = rockCoverageMax (maximum rock coverage on steep/high terrain)  
  // z = rockSlopeStart (slope threshold where rock begins appearing)
  // w = rockSlopeFull (slope threshold where rock fully dominates)
  fn getSurfaceParams() -> vec4<f32> {
      return uniforms._pad5;
  }

  fn zeroSurfaceWeights() -> SurfaceWeights {
      var w: SurfaceWeights;
      w.grass = 0.0;
      w.forestFloor = 0.0;
      w.rock = 0.0;
      w.sand = 0.0;
      w.dirt = 0.0;
      w.snow = 0.0;
      w.tundra = 0.0;
      w.mud = 0.0;
      w.swamp = 0.0;
      w.volcanic = 0.0;
      return w;
  }

  fn defaultLandSurface() -> SurfaceWeights {
      var w = zeroSurfaceWeights();
      w.grass = 1.0;
      return w;
  }

  // Blend two surface weight sets
  fn blendSurfaceWeights(a: SurfaceWeights, b: SurfaceWeights, t: f32) -> SurfaceWeights {
      var result: SurfaceWeights;
      result.grass = mix(a.grass, b.grass, t);
      result.forestFloor = mix(a.forestFloor, b.forestFloor, t);
      result.rock = mix(a.rock, b.rock, t);
      result.sand = mix(a.sand, b.sand, t);
      result.dirt = mix(a.dirt, b.dirt, t);
      result.snow = mix(a.snow, b.snow, t);
      result.tundra = mix(a.tundra, b.tundra, t);
      result.mud = mix(a.mud, b.mud, t);
      result.swamp = mix(a.swamp, b.swamp, t);
      result.volcanic = mix(a.volcanic, b.volcanic, t);
      return result;
  }

  // Add surface weights (for accumulating feature contributions)
  fn addSurfaceWeights(a: SurfaceWeights, b: SurfaceWeights) -> SurfaceWeights {
      var result: SurfaceWeights;
      result.grass = a.grass + b.grass;
      result.forestFloor = a.forestFloor + b.forestFloor;
      result.rock = a.rock + b.rock;
      result.sand = a.sand + b.sand;
      result.dirt = a.dirt + b.dirt;
      result.snow = a.snow + b.snow;
      result.tundra = a.tundra + b.tundra;
      result.mud = a.mud + b.mud;
      result.swamp = a.swamp + b.swamp;
      result.volcanic = a.volcanic + b.volcanic;
      return result;
  }

  // Scale surface weights by a factor
  fn scaleSurfaceWeights(w: SurfaceWeights, s: f32) -> SurfaceWeights {
      var result: SurfaceWeights;
      result.grass = w.grass * s;
      result.forestFloor = w.forestFloor * s;
      result.rock = w.rock * s;
      result.sand = w.sand * s;
      result.dirt = w.dirt * s;
      result.snow = w.snow * s;
      result.tundra = w.tundra * s;
      result.mud = w.mud * s;
      result.swamp = w.swamp * s;
      result.volcanic = w.volcanic * s;
      return result;
  }

  // Normalize weights so they sum to 1
  fn normalizeSurfaceWeights(w: SurfaceWeights) -> SurfaceWeights {
      let total = w.grass + w.forestFloor + w.rock + w.sand + w.dirt +
                  w.snow + w.tundra + w.mud + w.swamp + w.volcanic;
      if (total < 0.0001) {
          return defaultLandSurface();
      }
      return scaleSurfaceWeights(w, 1.0 / total);
  }

  fn surfaceWeightAt(w: SurfaceWeights, idx: u32) -> f32 {
      if (idx == 0u) { return w.grass; }
      if (idx == 1u) { return w.forestFloor; }
      if (idx == 2u) { return w.rock; }
      if (idx == 3u) { return w.sand; }
      if (idx == 4u) { return w.dirt; }
      if (idx == 5u) { return w.snow; }
      if (idx == 6u) { return w.tundra; }
      if (idx == 7u) { return w.mud; }
      if (idx == 8u) { return w.swamp; }
      if (idx == 9u) { return w.volcanic; }
      return 0.0;
  }

  fn addSurfaceWeightAt(w: SurfaceWeights, idx: u32, amount: f32) -> SurfaceWeights {
      var out = w;
      if (idx == 0u) { out.grass += amount; }
      else if (idx == 1u) { out.forestFloor += amount; }
      else if (idx == 2u) { out.rock += amount; }
      else if (idx == 3u) { out.sand += amount; }
      else if (idx == 4u) { out.dirt += amount; }
      else if (idx == 5u) { out.snow += amount; }
      else if (idx == 6u) { out.tundra += amount; }
      else if (idx == 7u) { out.mud += amount; }
      else if (idx == 8u) { out.swamp += amount; }
      else if (idx == 9u) { out.volcanic += amount; }
      return out;
  }

  fn restrictToTopTwoSurfaceWeights(w: SurfaceWeights) -> SurfaceWeights {
      let normalized = normalizeSurfaceWeights(w);

      var bestIdx0 = 10u;
      var bestIdx1 = 10u;
      var bestWt0 = 0.0;
      var bestWt1 = 0.0;

      for (var i = 0u; i < 10u; i++) {
          let wt = surfaceWeightAt(normalized, i);
          if (wt > bestWt0 || (wt == bestWt0 && i < bestIdx0)) {
              bestIdx1 = bestIdx0;
              bestWt1 = bestWt0;
              bestIdx0 = i;
              bestWt0 = wt;
          } else if (wt > bestWt1 || (wt == bestWt1 && i < bestIdx1)) {
              bestIdx1 = i;
              bestWt1 = wt;
          }
      }

      var restricted = zeroSurfaceWeights();
      restricted = addSurfaceWeightAt(restricted, bestIdx0, bestWt0);
      restricted = addSurfaceWeightAt(restricted, bestIdx1, bestWt1);
      return normalizeSurfaceWeights(restricted);
  }

  // ==================== Slope-based rock probability ====================
  // Uses configurable parameters from TerrainGenerationConfig.surface
  fn calculateBaseRockProbability(slope: f32, normalizedElevation: f32) -> f32 {
    let params = getSurfaceParams();
    
    // Extract parameters with defaults
    let rockCoverageMin = select(0.02, params.x, params.x > 0.0);  // Reduced from 0.05
    let rockCoverageMax = select(0.85, params.y, params.y > 0.0);  // Increased from 0.25
    let rockSlopeStart = select(0.35, params.z, params.z > 0.0);   // Increased from 0.25
    let rockSlopeFull = select(0.75, params.w, params.w > 0.0);    // Increased from 0.60
    
    // === SLOPE FACTOR (PRIMARY) ===
    // This is the main driver - steeper slopes = more rock
    let slopeFactor = smoothstep(rockSlopeStart, rockSlopeFull, slope);
    
    // === ELEVATION FACTOR (SECONDARY) ===
    // High peaks get rock even on gentler slopes
    let elevationFactor = smoothstep(0.65, 0.90, normalizedElevation);
    
    // === BASE PROBABILITY ===
    // Start from minimum, increase with slope
    var rockProb = mix(rockCoverageMin, rockCoverageMax, slopeFactor);
    
    // === ELEVATION BOOST FOR PEAKS ===
    // High elevation adds rock even if slope is moderate
    let peakBoost = elevationFactor * (1.0 - slopeFactor) * 0.4;
    rockProb += peakBoost;
    
    // === COMBINED AMPLIFICATION ===
    // Steep AND high = guaranteed rock
    let combinedBoost = slopeFactor * elevationFactor * 0.2;
    rockProb += combinedBoost;
    
    return clamp(rockProb, 0.0, 1.0);
}

  // ==================== Noise-modulated rock placement ====================
  // Adds spatial variation so rock appears in natural patches/outcrops
  
  const SCALE_ROCK_REGION: f32 = 8.0;    // ~8km regional rocky areas
  const SCALE_ROCK_OUTCROP: f32 = 2.0;   // ~2km rock outcrops
  const SCALE_ROCK_DETAIL: f32 = 0.5;    // ~500m rock patches
  
  fn addRockNoiseVariation(
      baseProb: f32,
      wx: f32, wy: f32, unitDir: vec3<f32>,
      seed: i32
  ) -> f32 {
      // Regional variation: some areas are naturally rockier
      let regionNoise = fbmAuto(wx, wy, unitDir, SCALE_ROCK_REGION, 2, seed + 7000, 2.0, 0.5);
      let regionVariation = regionNoise * 0.12;  // ±12% variation
      
      // Outcrop variation: individual rock outcrops
      let outcropNoise = fbmAuto(wx, wy, unitDir, SCALE_ROCK_OUTCROP, 2, seed + 7100, 2.0, 0.5);
      let outcropVariation = outcropNoise * 0.08;  // ±8% variation
      
      // Detail variation: small rock patches
      let detailNoise = fbmAuto(wx, wy, unitDir, SCALE_ROCK_DETAIL, 2, seed + 7200, 2.0, 0.5);
      let detailVariation = detailNoise * 0.05;  // ±5% variation
      
      return clamp(baseProb + regionVariation + outcropVariation + detailVariation, 0.0, 1.0);
  }

  // ==================== Tile variant selection ====================
  // Selects one of 4 variants (0-3) for visual variety
  
  fn selectTileVariant(wx: f32, wy: f32, unitDir: vec3<f32>, seed: i32) -> u32 {
      // Use very small scale noise for tile-level variation
      let variantNoise = fbmAuto(wx, wy, unitDir, 0.05, 1, seed + 9000, 2.0, 0.5);
      // Map from [-1, 1] to [0, 3.99] then truncate
      return u32(clamp((variantNoise + 1.0) * 2.0, 0.0, 3.99));
  }

  // Medium grass patches inside grass regions (similar spirit to forest floor).
  fn selectGrassBase(wx: f32, wy: f32, unitDir: vec3<f32>, seed: i32) -> u32 {
      let gLarge = fbmAuto(wx, wy, unitDir, 1.0, 2, seed + 9100, 2.0, 0.5);
      let gMid = fbmAuto(wx, wy, unitDir, 0.30, 2, seed + 9110, 2.0, 0.5);
      let gSmall = fbmAuto(wx, wy, unitDir, 0.07, 2, seed + 9120, 2.0, 0.5);
      let gDither = tileClusterNoise01(wx, wy, unitDir, seed + 9130);
      let gNoise = gLarge * 0.44 + gMid * 0.32 + gSmall * 0.17 + (gDither * 2.0 - 1.0) * 0.07;

      // Medium is common inside grass.
      let mediumMask = smoothstep(-0.15, 0.30, gNoise);

      // Meadow patches: broader, softer fields.
      let meadowNoise = fbmAuto(wx, wy, unitDir, 1.8, 2, seed + 9135, 2.0, 0.5);
      let meadowMask = smoothstep(0.10, 0.55, meadowNoise);

      // Tall patches: noticeable, clustered.
      let tallNoise = fbmAuto(wx, wy, unitDir, 0.22, 2, seed + 9140, 2.0, 0.5);
      let tallMask = smoothstep(0.10, 0.50, tallNoise) * (0.55 + mediumMask * 0.65);

      // Flower fields: visible pockets, tied loosely to meadows.
      let flowerNoise = fbmAuto(wx, wy, unitDir, 0.65, 2, seed + 9150, 2.0, 0.5);
      let flowerMask = smoothstep(0.35, 0.70, flowerNoise) * (0.35 + meadowMask * 0.85);

      if (flowerMask > 0.45) { return GRASS_FLOWER_FIELD_BASE; }
      if (tallMask > 0.30) { return GRASS_TALL_BASE; }
      if (meadowMask > 0.35) { return GRASS_MEADOW_BASE; }
      if (mediumMask > 0.20) { return GRASS_MEDIUM_BASE; }
      return GRASS_SHORT_BASE;
  }

  fn selectTundraBase(
      wx: f32, wy: f32, unitDir: vec3<f32>, seed: i32, elevation: f32
  ) -> u32 {
      let climate = getClimate(wx, wy, unitDir, elevation, seed);
      let p = climate.precipitation;
      if (p < 0.35) { return SURFACE_TUNDRA_BASE; }
      if (p < 0.60) { return SURFACE_TUNDRA_LICHEN_BASE; }
      return SURFACE_TUNDRA_MOSS_BASE;
  }

  fn selectDirtBase(
      wx: f32, wy: f32, unitDir: vec3<f32>, seed: i32, elevation: f32
  ) -> u32 {
      let climate = getClimate(wx, wy, unitDir, elevation, seed);
      let p = climate.precipitation;
      if (p < 0.30) { return SURFACE_DIRT_BASE; }
      if (p < 0.55) { return SURFACE_DIRT_LOAM_BASE; }
      return SURFACE_DIRT_CLAY_BASE;
  }

  fn selectMudBase(
      wx: f32, wy: f32, unitDir: vec3<f32>, seed: i32, elevation: f32
  ) -> u32 {
      let climate = getClimate(wx, wy, unitDir, elevation, seed);
      let p = climate.precipitation;
      if (p < 0.65) { return SURFACE_MUD_BASE; }
      if (p < 0.80) { return SURFACE_MUD_SILT_BASE; }
      return SURFACE_MUD_PEAT_BASE;
  }

  fn selectSnowBase(
      wx: f32, wy: f32, unitDir: vec3<f32>, seed: i32, elevation: f32
  ) -> u32 {
      let climate = getClimate(wx, wy, unitDir, elevation, seed);
      let t = climate.temperature;
      let p = climate.precipitation;

      let iceMask = 1.0 - smoothstep(0.12, 0.24, t);
      let packMask = smoothstep(0.12, 0.32, t) * (1.0 - smoothstep(0.32, 0.48, t));

      if (iceMask > 0.55) { return SURFACE_SNOW_ICE_BASE; }
      if (p < 0.45) { return SURFACE_SNOW_PACK_BASE; }
      if (packMask > 0.50) { return SURFACE_SNOW_PACK_BASE; }
      return SURFACE_SNOW_FRESH_BASE;
  }

  fn selectSandBase(
      wx: f32, wy: f32, unitDir: vec3<f32>, seed: i32, elevation: f32, slope: f32
  ) -> u32 {
      let climate = getClimate(wx, wy, unitDir, elevation, seed);
      let t = climate.temperature;
      let p = climate.precipitation;

      let oceanLevel = uniforms.waterParams.y;
      let coastBand = smoothstep(oceanLevel, oceanLevel + 0.015, elevation) *
          (1.0 - smoothstep(oceanLevel + 0.05, oceanLevel + 0.10, elevation));
      let flat = 1.0 - smoothstep(0.18, 0.40, slope);
      let beachNoise = fbmAuto(wx, wy, unitDir, 0.9, 2, seed + 7800, 2.0, 0.5);
      let beachMask = smoothstep(0.15, 0.55, beachNoise + coastBand * 0.7) * flat;
      if (beachMask > 0.35) {
          return SURFACE_SAND_BASE;
      }

      let rareSandNoise = fbmAuto(wx, wy, unitDir, 2.4, 2, seed + 7810, 2.0, 0.5);
      let rareSandMask = smoothstep(0.78, 0.92, rareSandNoise);
      if (rareSandMask > 0.92) {
          return SURFACE_SAND_BASE;
      }

      let isDryDesert = t > 0.70 && p < 0.30;
      let isSemiArid = t > 0.55 && p < 0.45;

      let treeNoise = fbmAuto(wx, wy, unitDir, 0.35, 2, seed + 7820, 2.0, 0.5);
      let treeMask = smoothstep(0.55, 0.80, treeNoise) * (1.0 - smoothstep(0.25, 0.55, slope));

      if (isDryDesert) {
          let dryTreeGate = smoothstep(0.12, 0.22, p) * (1.0 - smoothstep(0.30, 0.42, p));
          if (treeMask * dryTreeGate > 0.25) {
              return SURFACE_DESERT_TREES_DRY_BASE;
          }
          return SURFACE_DESERT_DRY_BASE;
      }
      if (isSemiArid) {
          let semiTreeGate = smoothstep(0.25, 0.45, p);
          if (treeMask * semiTreeGate > 0.25) {
              return SURFACE_DESERT_TREES_SEMI_ARID_BASE;
          }
          return SURFACE_DESERT_SEMI_ARID_BASE;
      }

      return SURFACE_SAND_BASE;
  }

  // ==================== Main surface weight calculation ====================
  // Main surface weight calculation - climate-driven grass/dirt/sand + forest floor.
fn computeSurfaceWeights(
    slope: f32,
    elevation: f32,
    wx: f32, wy: f32, unitDir: vec3<f32>,
    seed: i32
) -> SurfaceWeights {
    let climate = getClimate(wx, wy, unitDir, elevation, seed);
    let p = climate.precipitation;
    let tBase = climate.temperature;
    let tNoiseLarge = fbmAuto(wx, wy, unitDir, 300.0, 2, seed + 5400, 2.0, 0.5);
    let tNoiseMid = fbmAuto(wx, wy, unitDir, 80.0, 2, seed + 5410, 2.0, 0.5);
    let t = clamp(tBase + tNoiseLarge * 0.08 + tNoiseMid * 0.05, 0.0, 1.0);

    // Warm transition (sand ↔ dirt ↔ grass) driven by precipitation.
    var warm = computeSandTransitionWeights(climate, wx, wy, unitDir, seed);

    // Cool transition: keep dirt out of cool climates (narrow dirt only near sand).
    var cool = zeroSurfaceWeights();
    cool.grass = 1.0;

    // Temperature gate: cold/temperate → cool weights, hot → sand/dirt/grass weights.
    let warmGate = smoothstep(0.48, 0.66, t);
    let sandTempGate = smoothstep(0.50, 0.70, t);
    let hot = smoothstep(0.55, 0.78, t);
    let dry = 1.0 - smoothstep(0.35, 0.55, p);

    warm.sand *= sandTempGate * (1.0 + hot * dry * 1.4);
    warm.grass *= 1.0 - hot * dry * 0.35;
    warm.dirt *= 1.0 - hot * dry * 0.20;
    warm = normalizeSurfaceWeights(warm);

    var mixed = blendSurfaceWeights(cool, warm, warmGate);

    // Desert patch bias: larger, hotter/drier sand fields with multi-scale variation.
    let desertLarge = fbmAuto(wx, wy, unitDir, 5.0, 2, seed + 7340, 2.0, 0.5);
    let desertMid = fbmAuto(wx, wy, unitDir, 1.8, 2, seed + 7345, 2.0, 0.5);
    let desertSmall = fbmAuto(wx, wy, unitDir, 0.55, 2, seed + 7350, 2.0, 0.5);
    let desertNoise = desertLarge * 0.55 + desertMid * 0.30 + desertSmall * 0.15;
    let desertMask = smoothstep(0.05, 0.60, desertNoise + (hot - 0.5) * 0.6 + (dry - 0.5) * 0.85);
    mixed.sand = max(mixed.sand, desertMask * hot * dry * 0.50);

    // Coastal beaches: long sand bands near ocean level.
    let oceanLevel = uniforms.waterParams.y;
    let coastBand = smoothstep(oceanLevel, oceanLevel + 0.015, elevation) *
        (1.0 - smoothstep(oceanLevel + 0.05, oceanLevel + 0.10, elevation));
    let coastNoise = fbmAuto(wx, wy, unitDir, 0.9, 2, seed + 7360, 2.0, 0.5);
    let coastMask = smoothstep(0.15, 0.55, coastNoise + coastBand * 0.8);
    let coastFlat = 1.0 - smoothstep(0.20, 0.45, slope);
    mixed.sand = max(mixed.sand, coastMask * coastFlat * 0.55);

    // Cold climate blend: snow / tundra / cold-dry dirt fields.
    let coldGate = 1.0 - smoothstep(0.35, 0.55, t);
    let coldNoise = fbmAuto(wx, wy, unitDir, 1.6, 2, seed + 7350, 2.0, 0.5);
    let coldVar = (coldNoise + 1.0) * 0.5;
    let snowCore = 1.0 - smoothstep(0.16, 0.32, t);
    let tundraCore = smoothstep(0.20, 0.42, t) * (1.0 - smoothstep(0.42, 0.58, t));

    var cold = zeroSurfaceWeights();
    cold.snow = snowCore * (0.6 + 0.4 * smoothstep(0.35, 0.70, p)) * mix(0.8, 1.2, coldVar) * 0.85;
    cold.tundra = tundraCore * (0.45 + 0.55 * smoothstep(0.25, 0.60, p)) * mix(0.8, 1.2, coldVar) * 0.75;

    let coldDry = (1.0 - smoothstep(0.22, 0.40, p)) * (1.0 - smoothstep(0.28, 0.48, t));
    let coldFieldNoise = fbmAuto(wx, wy, unitDir, 0.80, 2, seed + 7355, 2.0, 0.5);
    let coldFieldMask = smoothstep(0.45, 0.75, coldFieldNoise);
    let coldDirtSlope = smoothstep(0.20, 0.45, slope);
    cold.dirt = coldFieldMask * coldDry * coldDirtSlope * 0.45;

    cold.grass = 0.25;
    cold = normalizeSurfaceWeights(cold);
    mixed = blendSurfaceWeights(mixed, cold, coldGate);

    // Rock on steep slopes / cliffs.
    let rockNoise = fbmAuto(wx, wy, unitDir, 0.55, 2, seed + 7310, 2.0, 0.5);
    let rockVar = (rockNoise + 1.0) * 0.5;
    let cliffRock = slopeRockWeight(slope);
    let cliffBoost = smoothstep(0.55, 0.85, slope);
    let rockAmount = cliffRock * mix(0.25, 0.65, rockVar) * (0.6 + 0.4 * cliffBoost);
    mixed.rock = max(mixed.rock, rockAmount);

    // ── Forest floor generation ──────────────────────────────────
    // Multi-scale noise creates forests from small patches (tens of meters)
    // to large continuous forests (up to ~10km). Precipitation gates density.

    // Large-scale forest regions (~5-10km). These define the big continuous forests.
    let forestHuge = fbmAuto(wx, wy, unitDir, 10.0, 3, seed + 7200, 2.0, 0.5);
    let forestMacro = fbmAuto(wx, wy, unitDir, 4.0, 3, seed + 7205, 2.0, 0.5);
    // Medium forest patches (~500m - 2km)
    let forestLarge = fbmAuto(wx, wy, unitDir, 1.4, 3, seed + 7210, 2.0, 0.5);
    let forestMid = fbmAuto(wx, wy, unitDir, 0.45, 3, seed + 7220, 2.0, 0.5);
    // Small patches (~50-150m) and tiny patches (~10-40m)
    let forestSmall = fbmAuto(wx, wy, unitDir, 0.12, 2, seed + 7230, 2.0, 0.5);
    let forestTiny = fbmAuto(wx, wy, unitDir, 0.04, 2, seed + 7240, 2.0, 0.5);
    // Tile-level dither for ragged edges
    let forestDither = tileClusterNoise01(wx, wy, unitDir, seed + 7250);

    // Combine scales: big forests dominate, with detail breaking up edges.
    let forestNoise = forestHuge * 0.22 +
                      forestMacro * 0.22 +
                      forestLarge * 0.20 +
                      forestMid * 0.16 +
                      forestSmall * 0.10 +
                      forestTiny * 0.06 +
                      (forestDither * 2.0 - 1.0) * 0.04;

    // Precipitation drives forest density:
    // p < 0.3: almost no forest (just rare tiny patches)
    // p 0.3-0.5: sparse forest patches
    // p 0.5-0.7: moderate forest
    // p > 0.7: dense continuous forest
    let forestPrecipGate = smoothstep(0.28, 0.55, p);
    // Shift the threshold: more precipitation → lower threshold → more forest.
    let forestThresholdHigh = 0.45;  // dry: need strong noise to place forest
    let forestThresholdLow = -0.10;  // wet: forest almost everywhere
    let forestThreshold = mix(forestThresholdHigh, forestThresholdLow, forestPrecipGate);
    var forestMask = smoothstep(forestThreshold, forestThreshold + 0.35, forestNoise);

    // Clearings inside forests: small openings (grass/dirt patches within dense forest).
    let clearingNoise = fbmAuto(wx, wy, unitDir, 0.25, 3, seed + 7260, 2.0, 0.5);
    let clearingSmall = fbmAuto(wx, wy, unitDir, 0.06, 2, seed + 7270, 2.0, 0.5);
    let clearingCombined = clearingNoise * 0.6 + clearingSmall * 0.4;
    // Only create clearings inside dense forest areas.
    let inDenseForest = smoothstep(0.6, 0.85, forestMask);
    let clearingMask = inDenseForest * smoothstep(0.50, 0.75, clearingCombined);
    forestMask = forestMask * (1.0 - clearingMask * 0.7);

    // Cap forest extent: limit to ~10km max continuous size by fading at extreme
    // values of the huge-scale noise. Very large positive forestHuge = big forest.
    // We allow it up to ~10km but the noise naturally limits this.
    // Additional: in arid areas (p < 0.35), only allow sparse isolated patches.
    let aridForestGate = smoothstep(0.25, 0.40, p);
    let aridPatchNoise = fbmAuto(wx, wy, unitDir, 0.3, 2, seed + 7280, 2.0, 0.5);
    let aridPatchMask = smoothstep(0.55, 0.80, aridPatchNoise);
    // In arid: only tiny scattered patches. In wet: full forest mask.
    forestMask = mix(forestMask * aridPatchMask * 0.25, forestMask, aridForestGate);

    // Temperature + slope gates for forests (avoid cold zones and cliffs).
    let forestTempGate = smoothstep(0.38, 0.58, t);
    let forestSlopeGate = 1.0 - smoothstep(0.35, 0.65, slope);
    forestMask = forestMask * forestTempGate * forestSlopeGate;

    // Forest floor takes from grass proportion only (not from sand/dirt).
    let forestAmount = mixed.grass * clamp(forestMask, 0.0, 0.85);
    mixed.forestFloor = forestAmount;
    mixed.grass = max(mixed.grass - forestAmount, 0.0);

    // Swamp patches in humid temperate/cool zones (low slope, often low elevation).
    let swampTempGate = smoothstep(0.28, 0.48, t) * (1.0 - smoothstep(0.55, 0.70, t));
    let swampHumid = smoothstep(0.60, 0.85, p);
    let swampLow = 1.0 - smoothstep(oceanLevel + 0.04, oceanLevel + 0.18, elevation);
    let swampNoise = fbmAuto(wx, wy, unitDir, 0.35, 2, seed + 7370, 2.0, 0.5);
    let swampMask = smoothstep(0.55, 0.80, swampNoise) * swampTempGate * swampHumid * swampLow;
    let swampAmount = swampMask * 0.14 * (1.0 - forestMask * 0.6);
    mixed.swamp = max(mixed.swamp, swampAmount);
    mixed.grass = max(mixed.grass - swampAmount * 0.5, 0.0);

    // Mud patches in humid areas (sparingly).
    let mudHumid = smoothstep(0.60, 0.85, p);
    let mudNoise = fbmAuto(wx, wy, unitDir, 0.40, 2, seed + 7320, 2.0, 0.5);
    let mudSlopeGate = 1.0 - smoothstep(0.35, 0.60, slope);
    let mudMask = smoothstep(0.50, 0.75, mudNoise) * mudHumid * mudSlopeGate;
    let mudAmount = mudMask * 0.10 * (1.0 - forestMask * 0.6);
    mixed.mud = max(mixed.mud, mudAmount);

    // Dirt patches in drier areas (sparingly).
    let dirtDry = 1.0 - smoothstep(0.32, 0.55, p);
    let dirtNoise = fbmAuto(wx, wy, unitDir, 0.35, 2, seed + 7330, 2.0, 0.5);
    let dirtMask = smoothstep(0.55, 0.80, dirtNoise) * dirtDry;
    let dirtTempGate = smoothstep(0.32, 0.55, t);
    let dirtAmount = dirtMask * 0.08 * (1.0 - forestMask * 0.4) * dirtTempGate;
    mixed.dirt = max(mixed.dirt, dirtAmount);

    return normalizeSurfaceWeights(mixed);
}

  // Choose forest floor category: single vs mixed, dense vs sparse.
  // Mixed patches can appear inside single-type forests.
  fn selectForestFloorBase(
      wx: f32, wy: f32, unitDir: vec3<f32>, seed: i32, elevation: f32
  ) -> u32 {
      let climate = getClimate(wx, wy, unitDir, elevation, seed);
      let p = climate.precipitation;
      let t = climate.temperature;

      // Tropical floors (hot + wet) -> rainforest / jungle.
      let tropicalGate = smoothstep(0.65, 0.82, t) * smoothstep(0.60, 0.82, p);
      if (tropicalGate > 0.35) {
          let tropLarge = fbmAuto(wx, wy, unitDir, 2.0, 2, seed + 9350, 2.0, 0.5);
          let tropSmall = fbmAuto(wx, wy, unitDir, 0.55, 2, seed + 9360, 2.0, 0.5);
          let tropNoise = tropLarge * 0.65 + tropSmall * 0.35;
          let rainBias = smoothstep(0.70, 0.90, p);
          let rainMask = smoothstep(0.20, 0.55, tropNoise + rainBias * 0.35);
          if (rainMask > 0.5) {
              return FOREST_RAINFOREST_BASE;
          }
          return FOREST_JUNGLE_BASE;
      }

      let densityLarge = fbmAuto(wx, wy, unitDir, 1.6, 2, seed + 9300, 2.0, 0.5);
      let densitySmall = fbmAuto(wx, wy, unitDir, 0.45, 2, seed + 9310, 2.0, 0.5);
      let densityNoise = densityLarge * 0.6 + densitySmall * 0.4;
      let densityGate = smoothstep(0.35, 0.75, p);
      let denseMask = smoothstep(-0.05, 0.55, densityNoise + densityGate * 0.55);

      let mixedLarge = fbmAuto(wx, wy, unitDir, 2.4, 2, seed + 9400, 2.0, 0.5);
      let mixedSmall = fbmAuto(wx, wy, unitDir, 0.35, 2, seed + 9410, 2.0, 0.5);
      let mixedNoise = mixedLarge * 0.7 + mixedSmall * 0.3;
      let mixedGate = smoothstep(0.45, 0.80, p);
      var mixedMask = smoothstep(0.05, 0.60, mixedNoise + (mixedGate - 0.5) * 0.6);

      // Small mixed subpatches within single forests.
      let subPatch = fbmAuto(wx, wy, unitDir, 0.12, 2, seed + 9420, 2.0, 0.5);
      let subMask = smoothstep(0.45, 0.75, subPatch);
      mixedMask = max(mixedMask, subMask * 0.45 * (1.0 - mixedMask));

      let isMixed = mixedMask > 0.5;
      let isDense = denseMask > 0.5;

      if (isMixed) {
          return select(FOREST_SPARSE_MIXED_BASE, FOREST_DENSE_MIXED_BASE, isDense);
      }
      return select(FOREST_SPARSE_SINGLE_BASE, FOREST_DENSE_SINGLE_BASE, isDense);
  }

fn validateTileType(tileType: u32) -> u32 {
  //if (isForestFloorTile(tileType)) { return tileType; }
  // return 94u;

    if (tileType == SURFACE_WATER) { return tileType; }
    if (isGrassTile(tileType)) { return tileType; }
    if (isSandTile(tileType)) { return tileType; }
    if (isRockTile(tileType)) { return tileType; }
    if (isTundraTile(tileType)) { return tileType; }
    if (isForestFloorTile(tileType)) { return tileType; }
    if (isSwampTile(tileType)) { return tileType; }
    if (isDirtTile(tileType)) { return tileType; }
    if (isMudTile(tileType)) { return tileType; }
    if (isSnowTile(tileType)) { return tileType; }
    if (isDesertTile(tileType)) { return tileType; }
    if (isVolcanicTile(tileType)) { return tileType; }
    return SURFACE_GRASS_BASE;
}

fn resolveTileTypeFromWeights(
    weights: SurfaceWeights,
    wx: f32, wy: f32, unitDir: vec3<f32>,
    seed: i32,
    elevation: f32,
    slope: f32
) -> u32 {
    // Keep local competition limited to the two strongest biome families.
    let normalized = restrictToTopTwoSurfaceWeights(weights);
    
    // Base selector: smooth low-frequency variation (stable regions).
    let baseSelector = (fbmAuto(wx, wy, unitDir, 0.02, 1, seed + 8500, 2.0, 0.5) + 1.0) * 0.5;

    // Tile-level selector: clustered noise for ragged biome edges.
    var tileSelector = tileClusterNoise01(wx, wy, unitDir, seed + 8510);
    let microBias = (fbmAuto(wx, wy, unitDir, 0.01, 2, seed + 8560, 2.0, 0.5) + 1.0) * 0.5;
    let midBias = (fbmAuto(wx, wy, unitDir, 0.08, 3, seed + 8570, 2.0, 0.5) + 1.0) * 0.5;
    tileSelector = clamp(tileSelector + (microBias - 0.5) * 0.10 + (midBias - 0.5) * 0.12, 0.0, 1.0);

    // Apply tile-level dithering primarily where sand/dirt/grass are competing.
    let g = normalized.grass;
    let s = normalized.sand;
    let d = normalized.dirt;
    let sdg = g + s + d;
    let compGS = 1.0 - smoothstep(0.15, 0.55, abs(g - s));
    let compGD = 1.0 - smoothstep(0.15, 0.55, abs(g - d));
    let compSD = 1.0 - smoothstep(0.15, 0.55, abs(s - d));
    let comp = max(compGS, max(compGD, compSD));
    var transition = smoothstep(0.35, 0.80, sdg) * comp;
    transition = clamp(transition * 1.15, 0.0, 1.0);
    let threshold = mix(baseSelector, tileSelector, transition);
    
    // Select tile variant (0-3)
    let variant = selectTileVariant(wx, wy, unitDir, seed);
    
    // Accumulate weights and select surface type
    var cumulative = 0.0;
    var selectedType = SURFACE_GRASS_BASE;

    cumulative += normalized.rock;
    if (threshold < cumulative) {
        selectedType = SURFACE_ROCK_BASE + variant;
        return validateTileType(selectedType);
    }

    cumulative += normalized.snow;
    if (threshold < cumulative) {
        let snowBase = selectSnowBase(wx, wy, unitDir, seed, elevation);
        selectedType = snowBase + variant;
        return validateTileType(selectedType);
    }

    cumulative += normalized.tundra;
    if (threshold < cumulative) {
        let tundraBase = selectTundraBase(wx, wy, unitDir, seed, elevation);
        selectedType = tundraBase + variant;
        return validateTileType(selectedType);
    }

    cumulative += normalized.sand;
    if (threshold < cumulative) {
        let sandBase = selectSandBase(wx, wy, unitDir, seed, elevation, slope);
        selectedType = sandBase + variant;
        return validateTileType(selectedType);
    }
    
    cumulative += normalized.dirt;
    if (threshold < cumulative) {
        let dirtBase = selectDirtBase(wx, wy, unitDir, seed, elevation);
        selectedType = dirtBase + variant;
        return validateTileType(selectedType);
    }

    cumulative += normalized.mud;
    if (threshold < cumulative) {
        let mudBase = selectMudBase(wx, wy, unitDir, seed, elevation);
        selectedType = mudBase + variant;
        return validateTileType(selectedType);
    }

    cumulative += normalized.swamp;
    if (threshold < cumulative) {
        selectedType = SURFACE_SWAMP_BASE + variant;
        return validateTileType(selectedType);
    }

    cumulative += normalized.forestFloor;
    if (threshold < cumulative) {
        let forestBase = selectForestFloorBase(wx, wy, unitDir, seed, elevation);
        selectedType = forestBase + variant;
        return validateTileType(selectedType);
    }

    cumulative += normalized.volcanic;
    if (threshold < cumulative) {
        selectedType = SURFACE_VOLCANIC_BASE + variant;
        return validateTileType(selectedType);
    }
    
    // Default to grass (medium patches inside short)
    let grassBase = selectGrassBase(wx, wy, unitDir, seed);
    selectedType = grassBase + variant;
    return validateTileType(selectedType);
}
  // ==================== Legacy compatibility functions ====================
  
  fn slopeRockWeight(slope: f32) -> f32 {
      let params = getSurfaceParams();
      let start = select(0.25, params.z, params.z > 0.0);
      let full = select(0.60, params.w, params.w > 0.0);
      return smoothstep(start, full, slope);
  }

  fn slopeGrassWeight(slope: f32) -> f32 {
      return 1.0 - smoothstep(0.25, 0.60, slope);
  }

  fn slopeDirtWeight(slope: f32) -> f32 {
      let lower = smoothstep(0.20, 0.35, slope);
      let upper = 1.0 - smoothstep(0.50, 0.70, slope);
      return lower * upper;
  }
  `;
  }
