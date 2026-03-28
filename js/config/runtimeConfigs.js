import { EngineConfig } from './EngineConfig.js';
import { GameDataConfig } from './GameDataConfig.js';
import { LogLevel } from './Logger.js';
import { TerrainGenerationConfig } from './terrainGenerationConfig.js';
import { TILE_CONFIG } from './TileConfig.js';
import { TEXTURE_CONFIG } from './atlasConfig.js';
import { GRASS_QUALITY_LEVELS, GRASS_TYPES } from './grassConfig.js';
import { TILE_LAYER_HEIGHTS, TILE_TRANSITION_RULES } from './tileTransitionConfig.js';

const ATLAS_TEXTURE_TYPES = ['height', 'normal', 'tile', 'splatData', 'macro'];

function  buildLodPoolConfig(baseChunkSize, worldCoverage, maxLODLevels, slotsByLod) {
  if (!Array.isArray(slotsByLod) || slotsByLod.length !== maxLODLevels) {
    throw new Error('buildLodPoolConfig requires slotsByLod for each LOD level');
  }
  const chunksPerAtlas = worldCoverage / baseChunkSize;
  const poolConfig = {};

  for (let lod = 0; lod < maxLODLevels; lod++) {
    const divisor = Math.pow(2, lod);
    const gridSegments = Math.max(4, Math.floor(baseChunkSize / divisor));
    const chunkSamples = gridSegments + 1;
    const textureSize = chunksPerAtlas * chunkSamples;
    poolConfig[lod] = {
      slots: slotsByLod[lod],
      textureSize
    };
  }

  return poolConfig; 
}
function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}
export function createEngineConfig() {
  const vertexSpacingMeters = 1;
  const chunkSegments = 128;

  const chunksPerAtlas = 8;
  const chunkSizeMeters = vertexSpacingMeters * chunkSegments; // 128 (derived)
  const samplesPerChunk = chunkSegments + 1;           // 129 (derived)
  const minAtlasSize = chunksPerAtlas * samplesPerChunk; // 1032 (derived)
  const textureSize = nextPow2(minAtlasSize);          // 2048 (derived)
  const chunkSizeTex = textureSize / chunksPerAtlas;   // 256 (derived)


  const maxLODLevels = 14;

  const worldCoverage = chunkSizeMeters * chunksPerAtlas;
  const lodDistancesMeters = [4000, 8000, 16000, 32000, 64000, 128000, 256000, 512000, 1024000, Infinity];
  const lodPoolSlots = [64, 48, 32, 24, 16, 12, 6, 6, 4, 4, 4, 4, 4, 4];
  const lodPoolConfig = buildLodPoolConfig(
    chunkSizeMeters,
    worldCoverage,
    maxLODLevels,
    lodPoolSlots
  );

  return new EngineConfig({
    logLevel: LogLevel.INFO,
    seed: 12345,
    chunkSegments,
     macroConfig: {
      biomeScale: 0.001,
      regionScale: 0.0005
    },
    nightSky: {
      detailLevel: 'low'  // or 'medium' or 'low'
    },
    vertexSpacingMeters,
    splatConfig: {
      splatDensity: 8,
      splatKernelSize: 5,
  },
    lod: {
      distancesMeters: lodDistancesMeters,
      radiusCaps: [12, 24, 48, 96, 160, 256],
      maxChunks: [512, 2048, 4096, 8192, 8192, 8192],
      maxVisibleSelection: 8192,
      autoScalePoolToVisible: false,
      blockWhenPoolFull: false
    },

    rendering: {
      preferWebGPU: true,
      maxPoolSlots: 2048,
      lighting: {
        ambient: {
          // Global ambient tuning for all terrain/asset materials.
          intensityMultiplier: 1.0,
          minIntensity: 0.95,
          maxIntensity: 1.6,
          sunContributionScale: 0.2,
          moonContributionScale: 0.35,
          moonNormalizationIntensity: 0.15
        }
      },
      terrainShader: {
        aerialFadeStartMeters: 400, 
        aerialFadeEndMeters: 600,  
        fullMaxLOD: 0,
        nearMaxLOD: 2,
        midMaxLOD: 4,
        nearToMidFadeStartChunks: 2.5,
        nearToMidFadeEndChunks: 4.0,
        pointSampleLodStart: 2,
        macroStartLod: 2,
        clusteredMaxLod: 1,
        aerialMaxLod: 2,
        normalMapMaxLod: 2,
        altitudeNormalMinMeters: 8000,
        altitudeShadowMinMeters: 12000,
        shadowDistanceMaxMeters: 1000
      }
    },

    ui: {
      updateIntervalMs: 250
    },

    camera: {
      fov: 75,
      near: 0.1,
      far: 150000,
      distance: 12,
      height: 6,
      lookAtSmoothing: 0.15,
      lookAheadDistance: 10,
      lookAheadHeight: 2,
      dynamicFarPlane: {
        enabled: true,
        minMeters: 2000,
        horizonFactor: 1.25,
        altitudeFactor: 0.5,
        maxRadiusFactor: 2.5
      }
    },

    manualCamera: {
      baseSpeed: 20,
      maxBoost: 160 ,
      accelerationRate: 8,
      decelerationRate: 8
    },

    debug: {
      disableQuadtree: false,
      terrainFragmentDebugMode: 0,
      terrainVertexDebugMode: 0,
      terrainForceDirectDraw: false,
    },
    gpuQuadtree: {
      enabled: true,
      tileTextureSize: 128,
      minTileSizeMeters: 128,
      maxVisibleTiles: 2048,//2048,
      queueCapacity: 131072,
      tilePoolSize: 1024,
      tilePoolMaxBytes: 512 * 1024 * 1024 * 4,
      tileHashCapacity: 8192 * 4,
      visibleTableCapacity: 2048,
      feedbackCapacity: 4096,
      lodErrorThreshold:  512,  //512,
      workgroupSize: 128,
      enableFrustumCulling: true,
      // Horizon culling hides tiles below the geometric horizon.
      enableHorizonCulling: true,
      horizonCulling: {
        groundCos: 1.0,
        blendScale: 1.25
      },
      // Faster readbacks keep residency/fallback decisions in sync while
      // moving quickly, reducing stale-parent rendering and eviction churn.
      visibleReadbackInterval: 4,
      feedbackReadbackInterval: 2,
      visibleReadbackMax: 8192,
      textureFormats: {
        height: 'r32float',
        normal: 'rgba8unorm',
        // r8unorm cuts resident tile/scatter bandwidth 4x. Generation
        // resolves through a storage-compatible staging texture.
        tile: 'r8unorm',
        splatData: 'rgba8unorm',
        scatter: 'r8unorm'
      },
      debugProfile: {
        enabled:          false,    // flip to true to activate
        warmupFrames:     300,      // run normally for this many frames first
        freezeGeneration: false,    // stop starting new tile generation tasks
        freezeFeedback:   false,    // stop feedback readback (no new tile requests)
        freezeTraversal:  false,    // stop GPU quadtree traversal compute
        freezeInstances:  false,    // stop GPU instance buffer building
        freezeUniforms:   false,    // stop camera/LOD uniform uploads
      },
      // ── Stitching diagnostics ─────────────────────────────────────
      // Enables targeted logging to pinpoint cracks/holes.
      diagnosticsEnabled: false,
      diagnosticsIntervalFrames: 1,
      diagnosticsSampleInstances: 64,
      // Enable heavy per-readback snapshot logging (includes ScatterDebug).
      diagnosticSnapshotIntervalFrames: 0,
    },
    generationQueue: {
      maxConcurrentTasks: 32,
      maxStartsPerFrame: 16,
      timeBudgetMs: 12,
      maxQueueSize: 4096,
      minStartIntervalMs: 0
    },
 
    lodAtlas: {
      worldCoverage,
      baseTextureSize: 128,
      baseChunkSize: chunkSizeMeters,
      maxLODLevels,
      atlasTextureTypes: ATLAS_TEXTURE_TYPES,
      poolConfig: lodPoolConfig,
      lodDistances: lodDistancesMeters
    },


    dataTexture: {
      textureSize: 2048,
      chunkSize: 128,
      atlasTextureTypes: ATLAS_TEXTURE_TYPES
    }
  });
}

export function createGameDataConfig() {
  const terrain = new TerrainGenerationConfig({
    continents: {
      enabled: true,
      count: 4,
      averageSize: 0.25,
      coastalComplexity: 0.8
    },
    tectonics: {
      enabled: true,
      plateCount: 8,
      mountainBuildingRate: 1.2,
      riftValleyDepth: 0.7
    },
    volcanism: {
      enabled: true,
      plateBoundaryActivity: 0.7,
      hotspotDensity: 0.00002,
      averageHeight: 1200
    },
	    water: {
	      hasOceans: true,
	      // NOTE: In WebGPU terrain generation, heights are normalized (~[-1.1..1.8]) and later
	      // converted to meters by multiplying with `maxTerrainHeight` (PlanetConfig.heightScale).
	      // Keep `oceanLevel` in the same normalized height units (e.g. 0.1 * 2000m = 200m).
	      oceanLevel: -0.01,
	      averageOceanDepth: 2000,
	      // Visual attenuation range for the water renderer (meters). Lower values make water
	      // become "deep"/opaque faster when looking down.
	      visualDepthRange: 240
	    },
    erosion: {
      enabled: true,
      globalRate: 0.6,
      hydraulicRate: 0.7,
      thermalRate: 0.4
    },
    impacts: {
      enabled: true,
      craterDensity: 0.0002
    },
    surface: {
      rockCoverageMin: 0.02,   // 2% minimum (rare outcrops on flat ground)
      rockCoverageMax: 0.85,   // 85% maximum (steep slopes still show some vegetation)
      rockSlopeStart: 0.35,    // Rock starts at 35% slope (~19 degrees)
      rockSlopeFull: 0.75      // Rock dominates at 75% slope (~37 degrees)
    }
  });

  return new GameDataConfig({
    starSystem: {
      name: 'TestSystem',
      timeScale: 10,
      autoTimeScale: true,
      useGameTimeRotation: true,
      sunIntensity: 20,
      planets: [
        {
          id: 'test-planet',
          enabled: true,
          name: 'TestPlanet',
          chunksPerFace: 2048,
          origin: { x: 0, y: 0, z: 0 },
          hasAtmosphere: true,
          atmosphereHeightRatio: 0.2,
          atmosphereOptions: {
            scaleHeightRayleighRatio: 0.1,  // Fraction of atmosphere thickness where density drops to 1/e
            scaleHeightMieRatio: 0.015,     // Same for Mie scattering (typically thinner)
            mieAnisotropy: 0.76,            // Forward scattering preference (0.76 = Earth-like)
            visualDensity: 0.5,             // 1.0 = Earth-like, 1.5-2 = hazier, 0.5 = thinner
            sunIntensity: 20.0              // Sun brightness multiplier
          },
          altitudeZones: {
            surface: 2000,
            low: 20000,
            transition: 100000,
            orbital: 400000
          },
          maxTerrainHeight: 5000,
          seed: 12345,
          terrain: terrain,
          tileConfig: TILE_CONFIG,
          atlasConfig: TEXTURE_CONFIG,
          grassConfig: {
            types: GRASS_TYPES,
            qualityLevels: GRASS_QUALITY_LEVELS,
            terrainShadowStrength: 0.18
          },
          macroTileSpan: 4,   // macro texture covers 16x16 micro tiles (macroScale = 1/macroTileSpan)
          macroMaxLOD: 3,     // upper LOD bound for macro overlay (lower bound in rendering.terrainShader.macroStartLod)
          // ── Tile transition blend rules ──────────────────────────────────────
          // Each entry selects which blend algorithm to use when two tile types
          // meet.  Pairs not listed here default to blend_soft.
          // `mode` must be one of: 'blend_soft' | 'blend_hard' | 'step_overlay' | 'stochastic'
          tileTransitionRules: TILE_TRANSITION_RULES,

          // ── Per-tile layer heights ───────────────────────────────────────────
          // Used only by the step_overlay blend mode.  Each key is a tile type
          // integer (from TILE_TYPES).  Value is a normalized height in [0, 1]
          // representing how far "above" ground level this surface visually sits.
          // Higher values make the tile appear to sit on top at transition edges.
          tileLayerHeights: TILE_LAYER_HEIGHTS,
        }
      ]
    },
    time: {
      dayDurationMs: 60 * 1000,
      startDay: 190,
      startHour: 12
    },
    spawn: {
      height: 800,
      spawnOnSunSide: true,
      defaultX: 0,
      defaultY: 800,
      defaultZ: 800
    }
  });
}
