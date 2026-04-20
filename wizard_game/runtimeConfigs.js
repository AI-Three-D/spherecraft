import { EngineConfig } from '../core/EngineConfig.js';
import { GameDataConfig } from './GameDataConfig.js';
import { LogLevel } from '../shared/Logger.js';
import { TerrainGenerationConfig } from '../templates/configs/terrainGenerationConfig.js';
import { TILE_CONFIG } from '../templates/configs/TileConfig.js';
import { TEXTURE_CONFIG } from '../templates/configs/atlasConfig.js';
import { GRASS_QUALITY_LEVELS, GRASS_TYPES } from '../templates/configs/grassConfig.js';
import { TILE_LAYER_HEIGHTS, TILE_TRANSITION_RULES } from '../templates/configs/tileTransitionConfig.js';
import { resolveTreeConfig } from '../templates/configs/treeConfigResolver.js';
import { WEATHER_CONFIG } from '../templates/configs/weatherConfig.js';

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
          minIntensity: 0.028,
          maxIntensity: 0.30,
          sunContributionScale: 0.22,
          moonContributionScale: 0.05,
          moonNormalizationIntensity: 0.15
        },
        sun: {
          // Keep dawn/dusk readable for the neutral baseline without
          // turning nights into a full-time blue fill light.
          twilightStartDot: -0.14,
          twilightEndDot: 0.04
        },
        fog: {
          densityMultiplier: 0.40,
          maxBaseDensity: 0.00055,
          dayDensityScale: 0.85,
          nightDensityScale: 0.42,
          minBrightness: 0.05,
          maxBrightness: 0.82,
          moonBrightnessScale: 0.10,
          sunTintStrength: 0.12
        }
      },
      distortion: {
        sourceCutoffs: {
          // Third-person camera starts around 7.8 m but zoom/orbit pushes the
          // effective camera-to-fire distance higher, so 10 m was too brittle.
          campfire: 30.0,
          shockwave: 200.0
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
        normalMapMaxLod: 3,
        altitudeNormalMinMeters: 8000,
        altitudeShadowMinMeters: 12000,
        shadowDistanceMaxMeters: 1000,
        ambientScale: 1.3,
        sunWrap: 0.18
      }
    },

    ui: {
      updateIntervalMs: 250,
      initialLoad: {
        enabled: true,
        minOverlayMs: 1800,
        maxWaitMs: 14000,
        stableFramesRequired: 16,
        residentVisibleRatio: 0.94,
        exactVisibleRatio: 0.62,
        minVisibleTiles: 64,
        maxPendingGenerations: 20,
        maxActiveGenerations: 6,
        maxPendingCopies: 0
      }
    },

    player: {
      baseMoveSpeed: 4.0,
      sprintMultiplier: 1.7,
      staminaMax: 100,
      staminaRegenPerSec: 5.5,
      staminaSprintDrainPerSec: 16,
      staminaTemperaturePenaltyMax: 3.5,
      sprintResumeThreshold: 12,
      hungerMax: 100,
      hungerDrainPerSec: 0.08,
      temperatureMin: 0,
      temperatureMax: 100,
      temperatureNeutral: 50,
      temperatureRecoverPerSec: 0.6,
      temperatureColdWarn: 35,
      temperatureColdDanger: 20,
      temperatureHotWarn: 65,
      temperatureHotDanger: 80,
      exhaustedAnimationSpeed: 1.0,
      exhaustedFallbackDurationSec: 1.6,
      exhaustedRegenMultiplier: 2.5
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
      characterFollow: {
        followHeight: 6,
        followDistance: 5,
        walkFollowPitchDeg: 30,
        walkPitchApproachSpeed: 0.8,
        stopPitchApproachSpeed: 0.4,
        stopPitchReturnFraction: 0.2,
        snapBackOnRelease: true,
        snapBackSpeed: 3.0,
        orbitSensitivity: 0.005,
        smoothing: 8.0,
        maxTotalPitchDeg: 75
      },
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
      tilePoolSize: 2048,           // was 1024 — halves eviction pressure at high speed
      tileHashCapacity: 8192 * 4,   // keep (already 2× pool, which is fine)
      feedbackReadbackInterval: 1,  // was 2 — halves feedback latency
      visibleReadbackInterval: 2,

      tilePoolMaxBytes: 512 * 1024 * 1024 * 4,

      visibleTableCapacity: 2048,
      feedbackCapacity: 4096,
      lodErrorThreshold:  512,  //512,
      workgroupSize: 128,

      // 8 instead of 4: allows more tile generations to be in-flight
      // simultaneously, cutting burst latency roughly in half.
      gpuBackpressureLimit: 8,

      // ── Speed-adaptive LOD ────────────────────────────────────
      // Scales lodErrorThreshold with camera speed. Higher threshold
      // → shallower subdivision → fewer tile requests.
      adaptiveLod: {
          enabled: true,
          speedFloorMps: 150,   // no adaptation below this speed
          speedRefMps: 600,     // each +600 m/s over floor → +1.0 scale
          maxScale: 3.0,        // cap: threshold never > 3× base
          smoothUp: 0.15,       // speeding up: respond in ~7 frames
          smoothDown: 0.03,     // slowing: ease back over ~30 frames
          holdWhenGpuBacklogged: true
      },

      enableFrustumCulling: true,
      // Horizon culling hides tiles below the geometric horizon.
      enableHorizonCulling: true,
      horizonCulling: {
        groundCos: 1.0,
        blendScale: 1.25
      },

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
      // ── Predictive tile streaming ─────────────────────────────────
      // Pre-queues tiles in the direction of camera movement so they are
      // ready before the GPU feedback pipeline discovers them.
      //
      // Neighborhood sizing: the neighbor radius is not fixed — it shrinks
      // as depth increases so that the queued world-space footprint stays
      // roughly constant across LOD levels.  At coarse depths (few tiles
      // cover the whole frustum) a radius of 4-5 is needed; at fine depths
      // radius 1-2 is sufficient.  The runtime computes:
      //   radius(depth) = round(neighborRadiusCoarse * 2^(depthMin-depth))
      // clamped to [1, neighborRadiusCoarse].
      predictiveStreaming: {
          enabled: true,

          // Minimum speed before any prefetching is done (m/s).
          speedThresholdMps: 50,

          // Maximum look-ahead time (seconds).
          // At 600 m/s: 1.5 s × 600 = 900 m ahead.
          lookAheadTimeMaxSec: 1.5,

          // lookAheadSec = speed × this, clamped to lookAheadTimeMaxSec.
          // 0.0025: at 600 m/s → 1.5 s, at 300 m/s → 0.75 s.
          lookAheadSpeedScale: 0.0025,

          // EMA weight for velocity smoothing (~7-frame / 115 ms response).
          // Tracks airplane-speed turns (several seconds) without jitter.
          velocitySmoothAlpha: 0.15,

          // Tile neighborhood radius at the coarsest prefetch depth.
          // Shrinks automatically for deeper (finer) depths so the queued
          // world-space footprint stays roughly constant.
          // 4 → 9×9 patch at depthMin covers a wide frustum sweep.
          neighborRadiusCoarse: 4,

          // Quadtree depth range to prefetch.
          // depthMax is clamped to quadtreeGPU.maxDepth at runtime.
          // Using maxDepth-2 as default so we don't over-queue leaf tiles.
          depthMin: 4,
          depthMax: 11,
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
      logStats: false,
    },
    generationQueue: {
      maxConcurrentTasks: 32,
      // 16 instead of 8: a burst of 50 tiles entering the frustum at once
      // now takes 3 frames to fully start instead of 6.
      maxStartsPerFrame: 16,
      timeBudgetMs: 8,
      maxQueueSize: 1024,
      minStartIntervalMs: 0
    },
    weather: WEATHER_CONFIG,

    trees: resolveTreeConfig({
      flags: {
          useMidTier: true,
          keepLegacyMidNear: false,
          useFarTierClone: true,
          useClusterFarTier: false,
          enableLeafRendering: true,
          enableLeafWind: false,
          enableBranchWind: false,
      },

      // ═══════════════════════════════════════════════════════════════
      //  TIER RANGES — master distance bands
      // ═══════════════════════════════════════════════════════════════
      //  Individual-tree tiers (near + mid) share one source pipeline.
      //  The coarse far-tree tier reuses the old cluster producer, but it
      //  renders packed low-res canopy hulls instead of blob coverage.
      //
      //  Everything under nearTier.* derives its outer cutoff from near.end.
      //  Tree LOD distances and quotas are derived from these ranges.
      tierRanges: {
          // Near tier now runs 20m farther and crossfades with the mid hull
          // across an 80m handoff window [140, 220].
          near:    { start: 0,    end: 220,  fadeOutWidth: 80 },
          mid:     { start: 140,  end: 700, fadeInWidth: 80,  fadeOutWidth: 320 },
          farTrees:{ start: 500,  end: 4000, fadeInWidth: 200, fadeOutWidth: 300 },
          // Legacy tree far patch tier disabled. Tree rendering now stops
          // at the simplified far hull tier instead of switching to blobs.
          far:     { start: 0,    end: 0,    fadeInWidth: 0,   fadeOutWidth: 0 },
      },

      // ── Individual-tree source baking range (nominal tile distance) ───
      // null → auto-derived from the actual gather radius, not a separate
      // hand-tuned distance ladder.
      sourceNominalRange: null,

      // ── Master tree density ───────────────────────────────────────────
      // Single source of truth for practical tree density. The resolver
      // converts this into:
      //   - source-bake densityScale
      //   - tree LOD distances
      //   - per-LOD legacy densities
      //   - near / mid / foliage quotas
      density: {
          maxTreesPerSquareMeter: 0.0072,
      },

      // ── Individual-tree scatter (feeds near + mid ONLY) ──────────────
      // These are the low-level bake-pattern controls only. Runtime LOD
      // bands, densities, and quotas are derived from `density` plus the
      // tier ranges above.
      scatter: {
          cellSize: 16.0,
          maxPerCell: 4,
          clusterProbability: 0.95,
          jitterScale: 0.85,
      },

      sourceBake: {
          enabled: true,
          perLayerCapacity: 1024,
          maxBakesPerFrame: 16,
          logDispatches: false,
      },

      billboards: {
          lodStart: 3, lodEnd: 4,
          fadeStartRatio: 0.7, fadeEndRatio: 1.0,
      },

      // ─── Near tier ────────────────────────────────────────────────────
      // null budgets are auto-derived from `density`.
      nearTier: {
          maxCloseTrees: null,
          maxTotalLeaves: null,
          maxTotalClusters: 10000000,

          maxBranchDetailLevel: 3,
          branchLODBands: [{ distance: 50, maxLevel: 4 }],
          branchTerminalLevel: 2,
          branchFadeMargin: null,

          leafBands: [
              { start:  0, end:  8 },
              { start:  7, end: 20 },
              { start: 19, end: 30 },
              { start: 25 },
          ],
          // 220m range with an 80m fade window means the near leaf fade
          // starts at 140m so the handoff matches the mid-tier fade-in.
          leafFadeStartRatio: 140 / 220,

          leafCounts: {
              generic: [6000, 3000, 1500, 1500],
              0:       [3000, 1500,  700,  700],
              1:       [3000, 1500,  700,  700],
          },
          leafSizeScale: [1.0, 1.36, 2.0, 2.0],

          birch: {
              nearDistance: 20.0,
              closeSize: 0.36, settledSize: 0.55, aspect: 1.5,
              closeLeaves: 4000,
              closeCardsPerAnchor: 10,
              settledCardsPerAnchor: 1,
          },
      },

      // ─── Mid tier ─────────────────────────────────────────────────────
      midTier: {
          maxTrees: null,
          // 1.0 = no distance thinning. 0.5 = keep about half as many
          // trees by the far end of the mid tier, with a linear ramp.
          endDensityScale: 0.1,
          hull: {
              lonSegments: 12, latSegments: 8,
              vsAnchorSamples: 8, inflation: 0.95, shrinkWrap: 0.55,
              verticalBias: 1.15, topShrinkStart: 0.60, topShrinkStrength: 0.35,
              gapShrink: 0.68,
              lumpNearScale: 1.8,
              lumpFarScale: 1.0,
              lumpNearDistance: 250,
              lumpFarDistance: 550,
          },
          hullFrag: {
            // ── [TIER 1] Sub-band coverage ────────────────────────────────
            // Near sub-band (~180–450m) gets noticeably lower base coverage
            // — this is the single biggest "too solid" fix. Far sub-band
            // (~450–1000m) stays close to the old 0.72: tiny trees at 800m
            // alias if they're too porous.
            //
            // Backward compat: if you revert to a single `baseCoverage` field,
            // the shader builder treats both near and far as that value and
            // the sub-band gradient becomes a no-op.
            baseCoverageNear: 0.56,
            baseCoverageFar:  0.74,
            subbandSplit: 450,         // m; centre of the near→far transition
            subbandBlend: 120,         // m; width of the transition
            subbandFarDamp: 0.65,      // how much to damp near-only effects at far (0 = no damping)

            // Existing noise/lighting knobs — unchanged.
            coverageNoiseAmp: 0.25,
            coverageNoiseScale: 2.8,
            bumpStrength: 0.12,
            brightness: 1.05,

            // ── [TIER 1] Macro-gap noise ──────────────────────────────────
            // Very low frequency holes faking anchor-sparse regions. One
            // cycle is roughly canopy-sized at the default scale. Set
            // strength = 0 to disable.
            macroGapScale: 0.55,
            macroGapStrength: 0.22,

            // ── [TIER 1] Noise-modulated edge erosion ─────────────────────
            // Erosion threshold varies per-fragment: [edgeStartBase,
            // edgeStartBase + edgeNoiseAmp]. Old fixed behaviour ≈
            // { edgeStartBase: 0.58, edgeNoiseAmp: 0.0, edgeBaseThin: 0.05 }.
            // Lower base = erosion reaches deeper into the canopy; higher
            // amp = more irregular silhouette boundary.
            edgeStartBase: 0.40,
            edgeNoiseAmp:  0.22,
            edgeBaseThin:  0.12,
            edgeRimBoost:  0.14,       // extra bite at the very rim

            // ── [TIER 1] Bottom breakup ───────────────────────────────────
            // Ragged lowest-branch zone. Set to 0 to disable.
            bottomBreak: 0.14,
        },
          trunk: {
              visibleHeightFrac: 0.38, baseRadiusFrac: 0.025,
              taperTop: 0.60, fadeEnd: 400,
          },
      },
      // Coarse far-tree tier. Internally this still reuses the cluster
      // producer/cache, but each instance now draws packed low-res canopy
      // hulls instead of terrain-scale grove blobs.
      farTreeTier: {
        maxInstances: 120000,
        densityMatchScale: 1.0,
        endDensityScale: 1.0,

        // ── Which tiles get far-hull instances ─────────────────────
        // Nominal tile-distance gate (same units as sourceNominalRange).
        // null → auto-derived from tierRanges.farTrees.
        //   start: farTrees.start × 0.8  (pre-bake before reaching range)
        //   end:   farTrees.end   × 1.5  (cover subdivision latency)
        sourceNominalRange: { start: null, end: null },

        // ── Bake grid: LOD-scaled ─────────────────────────────────
        // gridDim × gridDim cells per tile. One cell becomes one far-tree
        // instance, and each instance can pack several low-res hull trees.
        // Keep this materially denser than the old blob settings.
        bake: {
            gridByTileSize: [
                { tileSize:  128, gridDim: 12 },  //  11m cells
                { tileSize:  256, gridDim: 12 },  //  21m cells
                { tileSize:  512, gridDim: 12 },  //  43m cells
                { tileSize: 1024, gridDim: 10 },  // 102m cells
                { tileSize: 2048, gridDim:  8 },  // 256m cells
                { tileSize: 4096, gridDim:  6 },  // 683m cells
            ],
            minGridDim: 5,
            maxGridDim: 12,

            // Forest eligibility (coarse re-evaluation; same logic as
            // fine scatter, sampled at cell positions)
            maxAltitude: 2200.0,
            maxSlope:    0.65,
            minDensity:  0.05,   // keep sparse far hulls from collapsing into holes

            // When a tile has individual-tree scatter already baked
            // (RUNTIME_TREE representation), sample that eligibility
            // signal and weight far-hull emission by it. Biases far trees
            // toward the same high-density regions as mid-tier trees.
            // Tiles without scatter data fall back to pure eligibility.
            useEligibilityWeighting: true,
            eligibilityWeight: 0.6,   // 0 = ignore, 1 = full gate

            // Placement and packing controls for the baked far instances.
            jitterScale: 0.72,
            neighborhoodRadius: 1.6,
            gradientNudge: 0.08,
            canopyFootprintMinScale: 0.90,
            canopyFootprintMaxScale: 1.14,
            groupRadiusMinFrac: 0.05,
            groupRadiusMaxFrac: 0.10,

            perLayerCapacity: 160,
            maxBakesPerFrame: 8,
        },

        // ── Hull geometry ─────────────────────────────────────────
        // Same hull builder as the mid tier, but lower resolution and a
        // much simpler shader. Several separate trees can be packed into a
        // single far instance.
        hull: {
            lonSegments: 6,
            latSegments: 4,
            maxPackedTrees: 4,

            // Silhouette blend endpoints (lerp by coniferFrac)
            coniferTopSharpness: 0.65,   // 0=dome, 1=perfect cone
            coniferTaper:        0.35,   // base narrowing
            deciduousSpread:     0.18,   // mid-height bulge

            // Canopy sits on an implied trunk. Fraction of total height
            // that is trunk (invisible — just an offset).
            trunkHeightFrac:  0.10,
            sideLobeAmp: 0.16,
        },

        frag: {
            ambient:     0.34,
            sunStrength: 0.60,
            topTint:     0.08,
            distDesat:   0.10,
        },

        // Tree size derivation. Height varies with altitude; width
        // derived from height × species ratio.
        heightRange: { min: 8.0, max: 22.0 },
        widthToHeightRatio: { conifer: 0.25, deciduous: 0.45 },
    },

    // ─── Patch tier: one volumetric instance per tile ─────────────────
    // At 2.5–12km, individual clusters are sub-pixel. The patch tier
    // renders forest as a terrain-following shell: tile geometry
    // extruded upward by local canopy height, masked by forest coverage.
    //
    // Source: per-tile statistics baked during terrain generation
    // (parallel to LayerMeta). No separate cache — stats are tiny.
    //
    // Render: separate pipeline from cluster. Tessellated shell over
    // tile; VS extrudes by coverage × height; FS discards below
    // coverage threshold. Terrain-following → no altitude issues.
    //
    // Implementation deferred — this section defines what stats the
    // terrain gen pass needs to produce so we can wire it later.
    patchTier: {
        maxPatches: 512,

        // Per-tile stats (baked alongside terrain, stored in/near LayerMeta)
        statsSchema: {
            forestCoverage:   'f32',   // fraction [0,1] of tile with trees
            coniferFraction:  'f32',   // shape/color blend
            meanCanopyHeight: 'f32',   // extrusion amplitude
            // Coarse coverage grid for shell masking. 8×8 = 64 texels.
            // Packed into a small per-tile texture or storage array.
            coverageGridRes:  8,
        },

        shell: {
            // Shell tessellation over tile footprint
            tessSegments: 16,
            // Silhouette softening at forest edges
            edgeFadeWidthFrac: 0.1,
        },
    },
      speciesProfiles: {
          0: { heightFracStart: 0.08, heightFracEnd: 0.98, radialFrac: 0.22, label: 'spruce', conical: true },
          1: { heightFracStart: 0.12, heightFracEnd: 0.98, radialFrac: 0.20, label: 'pine',   conical: true },
          2: { heightFracStart: 0.32, heightFracEnd: 0.98, radialFrac: 0.26, label: 'birch' },
          3: { heightFracStart: 0.25, heightFracEnd: 0.92, radialFrac: 0.30, label: 'alder' },
          4: { heightFracStart: 0.20, heightFracEnd: 0.95, radialFrac: 0.42, label: 'oak' },
          5: { heightFracStart: 0.22, heightFracEnd: 0.96, radialFrac: 0.38, label: 'beech' },
          default: { heightFracStart: 0.28, heightFracEnd: 0.95, radialFrac: 0.32, label: 'generic' },
      },
  }),
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
          macroTileSpan: 16,   // macro texture covers 16x16 micro tiles (macroScale = 1/macroTileSpan)
          macroMaxLOD: 3,     // upper LOD bound for macro overlay (lower bound in rendering.terrainShader.macroStartLod)
          // ── Tile transition blend rules ──────────────────────────────────────
          // Each entry selects which blend algorithm to use when two tile types
          // meet.  Pairs not listed here default to blend_soft.
          // `mode` must be one of: 'blend_soft' | 'blend_hard' | 'step_overlay' | 'stochastic'
          tileTransitionRules: TILE_TRANSITION_RULES,

          // ── Per-tile layer heights ───────────────────────────────────────────
          // Used only by the step_overlay blend mode.  Each key is a tile type
          // integer (from the authored/default tile catalog). Value is a normalized height in [0, 1]
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
