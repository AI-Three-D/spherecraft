// js/config/EngineConfig.js
import { DataTextureConfig } from './dataTextureConfiguration.js';
import { requireBool, requireInt, requireIntArray, requireLogLevel, requireNumber, requireNumberArray, requireObject } from '../util/requireUtil.js';


export class EngineConfig {
  constructor(options = {}) {
    this.logLevel = requireLogLevel(options.logLevel, 'logLevel');
    this.seed = requireInt(options.seed, 'seed', 0);
    const nightSky = options.nightSky || {};
    this.nightSky = {
        detailLevel: nightSky.detailLevel || 'medium'  // 'low', 'medium', 'high'
    };
    // ==================== GEOMETRY SAMPLING (AUTHORITATIVE) ====================
    // chunkSizeMeters = vertexSpacingMeters * chunkSegments
    this.vertexSpacingMeters = requireNumber(options.vertexSpacingMeters, 'vertexSpacingMeters');
    this.chunkSegments = requireInt(options.chunkSegments, 'chunkSegments', 1);

    // ==================== LOD (ENGINE-WIDE) ====================
    const lodOptions = requireObject(options.lod, 'lod');
    this.lod = {
      distancesMeters: requireNumberArray(lodOptions.distancesMeters, 'lod.distancesMeters', 1, true),
      radiusCaps: requireIntArray(lodOptions.radiusCaps, 'lod.radiusCaps', 1),
      maxChunks: requireIntArray(lodOptions.maxChunks, 'lod.maxChunks', 1),
      maxVisibleSelection: requireInt(lodOptions.maxVisibleSelection, 'lod.maxVisibleSelection', 1),
      autoScalePoolToVisible: requireBool(lodOptions.autoScalePoolToVisible, 'lod.autoScalePoolToVisible'),
      blockWhenPoolFull: requireBool(lodOptions.blockWhenPoolFull, 'lod.blockWhenPoolFull')
    };
    this.splatConfig = requireObject(options.splatConfig, 'splatConfig');
    this.macroConfig = requireObject(options.macroConfig, 'macroConfig');

    // ==================== RENDERING ====================
    const rendering = requireObject(options.rendering, 'rendering');
    const terrainShader = rendering.terrainShader || {};
    const lighting = rendering.lighting || {};
    const ambient = lighting.ambient || {};
    this.rendering = {
      preferWebGPU: requireBool(rendering.preferWebGPU, 'rendering.preferWebGPU'),
      maxPoolSlots: requireInt(rendering.maxPoolSlots, 'rendering.maxPoolSlots', 1),
      terrainShader: {
        aerialFadeStartMeters: requireInt(terrainShader.aerialFadeStartMeters ?? 0, 'rendering.terrainShader.aerialFadeStartMeters', 0),
        aerialFadeEndMeters: requireInt(terrainShader.aerialFadeEndMeters ?? 0, 'rendering.terrainShader.aerialFadeEndMeters', 0),
        fullMaxLOD: requireInt(terrainShader.fullMaxLOD ?? 0, 'rendering.terrainShader.fullMaxLOD', 0),
        nearMaxLOD: requireInt(terrainShader.nearMaxLOD ?? 2, 'rendering.terrainShader.nearMaxLOD', 0),
        midMaxLOD: requireInt(terrainShader.midMaxLOD ?? 4, 'rendering.terrainShader.midMaxLOD', 0),
        pointSampleLodStart: requireInt(terrainShader.pointSampleLodStart ?? 2, 'rendering.terrainShader.pointSampleLodStart', 0),
        macroStartLod: requireInt(terrainShader.macroStartLod ?? 2, 'rendering.terrainShader.macroStartLod', 0),
        clusteredMaxLod: requireInt(terrainShader.clusteredMaxLod ?? 1, 'rendering.terrainShader.clusteredMaxLod', 0),
        aerialMaxLod: requireInt(terrainShader.aerialMaxLod ?? 2, 'rendering.terrainShader.aerialMaxLod', 0),
        normalMapMaxLod: requireInt(terrainShader.normalMapMaxLod ?? 2, 'rendering.terrainShader.normalMapMaxLod', 0),
        altitudeNormalMinMeters: requireNumber(terrainShader.altitudeNormalMinMeters ?? 8000, 'rendering.terrainShader.altitudeNormalMinMeters'),
        altitudeShadowMinMeters: requireNumber(terrainShader.altitudeShadowMinMeters ?? 12000, 'rendering.terrainShader.altitudeShadowMinMeters'),
        shadowDistanceMaxMeters: requireNumber(terrainShader.shadowDistanceMaxMeters ?? 1000, 'rendering.terrainShader.shadowDistanceMaxMeters')
      },
      lighting: {
        ambient: {
          intensityMultiplier: requireNumber(
            ambient.intensityMultiplier ?? 1.0,
            'rendering.lighting.ambient.intensityMultiplier'
          ),
          minIntensity: requireNumber(
            ambient.minIntensity ?? 0.75,
            'rendering.lighting.ambient.minIntensity'
          ),
          maxIntensity: requireNumber(
            ambient.maxIntensity ?? 1.5,
            'rendering.lighting.ambient.maxIntensity'
          ),
          sunContributionScale: requireNumber(
            ambient.sunContributionScale ?? 0.2,
            'rendering.lighting.ambient.sunContributionScale'
          ),
          moonContributionScale: requireNumber(
            ambient.moonContributionScale ?? 0.2,
            'rendering.lighting.ambient.moonContributionScale'
          ),
          moonNormalizationIntensity: requireNumber(
            ambient.moonNormalizationIntensity ?? 0.15,
            'rendering.lighting.ambient.moonNormalizationIntensity'
          )
        }
      }
    };


    // ==================== UI ====================
    const ui = requireObject(options.ui, 'ui');
    this.ui = {
      updateIntervalMs: requireInt(ui.updateIntervalMs, 'ui.updateIntervalMs', 1)
    };

    // ==================== CAMERA ====================
    const camera = requireObject(options.camera, 'camera');
    this.camera = {
      fov: requireNumber(camera.fov, 'camera.fov'),
      near: requireNumber(camera.near, 'camera.near'),
      far: requireNumber(camera.far, 'camera.far'),
      distance: requireNumber(camera.distance, 'camera.distance'),
      height: requireNumber(camera.height, 'camera.height'),
      lookAtSmoothing: requireNumber(camera.lookAtSmoothing, 'camera.lookAtSmoothing'),
      lookAheadDistance: requireNumber(camera.lookAheadDistance, 'camera.lookAheadDistance'),
      lookAheadHeight: requireNumber(camera.lookAheadHeight, 'camera.lookAheadHeight'),
      dynamicFarPlane: (() => {
        const dyn = camera.dynamicFarPlane || {};
        return {
          enabled: requireBool(dyn.enabled ?? true, 'camera.dynamicFarPlane.enabled'),
          minMeters: requireNumber(dyn.minMeters ?? 2000, 'camera.dynamicFarPlane.minMeters'),
          horizonFactor: requireNumber(dyn.horizonFactor ?? 1.25, 'camera.dynamicFarPlane.horizonFactor'),
          altitudeFactor: requireNumber(dyn.altitudeFactor ?? 0.5, 'camera.dynamicFarPlane.altitudeFactor'),
          maxRadiusFactor: requireNumber(dyn.maxRadiusFactor ?? 2.5, 'camera.dynamicFarPlane.maxRadiusFactor')
        };
      })()
    };

    // ==================== MANUAL CAMERA ====================
    const manualCamera = requireObject(options.manualCamera, 'manualCamera');
    this.manualCamera = {
      baseSpeed: requireNumber(manualCamera.baseSpeed, 'manualCamera.baseSpeed'),
      maxBoost: requireNumber(manualCamera.maxBoost, 'manualCamera.maxBoost'),
      accelerationRate: requireNumber(manualCamera.accelerationRate, 'manualCamera.accelerationRate'),
      decelerationRate: requireNumber(manualCamera.decelerationRate, 'manualCamera.decelerationRate')
    };

    // ==================== DEBUG ====================
    const debug = requireObject(options.debug, 'debug');
    this.debug = {
      disableQuadtree: requireBool(debug.disableQuadtree, 'debug.disableQuadtree'),
      terrainFragmentDebugMode: requireInt(debug.terrainFragmentDebugMode ?? 0, 'debug.terrainFragmentDebugMode', 0),
      terrainVertexDebugMode: requireInt(debug.terrainVertexDebugMode ?? 0, 'debug.terrainVertexDebugMode', 0)
    };

    // ==================== GENERATION QUEUE (ENGINE-WIDE) ====================
    const generationQueue = requireObject(options.generationQueue, 'generationQueue');
    this.generationQueue = {
      maxConcurrentTasks: requireInt(generationQueue.maxConcurrentTasks, 'generationQueue.maxConcurrentTasks', 1),
      maxStartsPerFrame: requireInt(generationQueue.maxStartsPerFrame, 'generationQueue.maxStartsPerFrame', 1),
      timeBudgetMs: requireNumber(generationQueue.timeBudgetMs, 'generationQueue.timeBudgetMs'),
      maxQueueSize: requireInt(generationQueue.maxQueueSize, 'generationQueue.maxQueueSize', 1),
      minStartIntervalMs: requireNumber(generationQueue.minStartIntervalMs, 'generationQueue.minStartIntervalMs')
    };

    // ==================== GPU QUADTREE (WEBGPU) ====================
    const gpuQuadtree = options.gpuQuadtree || {};
    this.gpuQuadtree = {
      enabled: requireBool(gpuQuadtree.enabled ?? false, 'gpuQuadtree.enabled'),
      tileTextureSize: requireInt(gpuQuadtree.tileTextureSize ?? 1024, 'gpuQuadtree.tileTextureSize', 1),
      minTileSizeMeters: requireNumber(
        gpuQuadtree.minTileSizeMeters ?? this.lodAtlas.worldCoverage,
        'gpuQuadtree.minTileSizeMeters'
      ),
      maxVisibleTiles: requireInt(gpuQuadtree.maxVisibleTiles ?? 8192, 'gpuQuadtree.maxVisibleTiles', 1),
      queueCapacity: requireInt(gpuQuadtree.queueCapacity ?? 16384, 'gpuQuadtree.queueCapacity', 1),
      tilePoolSize: requireInt(gpuQuadtree.tilePoolSize ?? 2048, 'gpuQuadtree.tilePoolSize', 1),
      tilePoolMaxBytes: requireNumber(gpuQuadtree.tilePoolMaxBytes ?? 512 * 1024 * 1024, 'gpuQuadtree.tilePoolMaxBytes'),
      tileHashCapacity: requireInt(gpuQuadtree.tileHashCapacity ?? 4096, 'gpuQuadtree.tileHashCapacity', 1),
      visibleTableCapacity: requireInt(gpuQuadtree.visibleTableCapacity ?? 16384, 'gpuQuadtree.visibleTableCapacity', 1),
      feedbackCapacity: requireInt(gpuQuadtree.feedbackCapacity ?? 4096, 'gpuQuadtree.feedbackCapacity', 1),
      lodErrorThreshold: requireNumber(gpuQuadtree.lodErrorThreshold ?? 512, 'gpuQuadtree.lodErrorThreshold'),
      workgroupSize: requireInt(gpuQuadtree.workgroupSize ?? 64, 'gpuQuadtree.workgroupSize', 1),
      enableFrustumCulling: requireBool(gpuQuadtree.enableFrustumCulling ?? true, 'gpuQuadtree.enableFrustumCulling'),
      enableHorizonCulling: requireBool(gpuQuadtree.enableHorizonCulling ?? true, 'gpuQuadtree.enableHorizonCulling'),
      horizonCulling: (() => {
        const hc = gpuQuadtree.horizonCulling || {};
        return {
          groundCos: requireNumber(hc.groundCos ?? -0.05, 'gpuQuadtree.horizonCulling.groundCos'),
          blendScale: requireNumber(hc.blendScale ?? 1.25, 'gpuQuadtree.horizonCulling.blendScale')
        };
      })(),
      visibleReadbackInterval: requireInt(
        gpuQuadtree.visibleReadbackInterval ?? 0,
        'gpuQuadtree.visibleReadbackInterval',
        0
      ),
      visibleReadbackMax: requireInt(
        gpuQuadtree.visibleReadbackMax ?? 0,
        'gpuQuadtree.visibleReadbackMax',
        0
      ),
      feedbackReadbackInterval: requireInt(
        gpuQuadtree.feedbackReadbackInterval ?? 1,
        'gpuQuadtree.feedbackReadbackInterval',
        0
      ),
      feedbackReadbackRingSize: requireInt(
        gpuQuadtree.feedbackReadbackRingSize ?? 3,
        'gpuQuadtree.feedbackReadbackRingSize',
        1
      ),
      textureFormats: (() => {
        const tf = gpuQuadtree.textureFormats || {};
        return {
          height: tf.height || 'r32float',
          normal: tf.normal || 'rgba8unorm',
          tile: tf.tile || 'r8unorm',
          splatData: tf.splatData || 'rgba32float',
          macro: tf.macro || 'rgba8unorm',
          scatter: tf.scatter || 'r8unorm'
        };
      })(),
      diagnosticsEnabled: requireBool(
        gpuQuadtree.diagnosticsEnabled ?? false,
        'gpuQuadtree.diagnosticsEnabled'
      ),
      diagnosticsIntervalFrames: requireInt(
        gpuQuadtree.diagnosticsIntervalFrames ?? 120,
        'gpuQuadtree.diagnosticsIntervalFrames',
        1
      ),
      diagnosticSnapshotIntervalFrames: requireInt(
        gpuQuadtree.diagnosticSnapshotIntervalFrames ?? 0,
        'gpuQuadtree.diagnosticSnapshotIntervalFrames',
        0
      ),
      diagnosticsSampleInstances: requireInt(
        gpuQuadtree.diagnosticsSampleInstances ?? 64,
        'gpuQuadtree.diagnosticsSampleInstances',
        1
      ),
      // ── Performance profiling: selective feature freeze ──────────────
      // Set debugProfile.enabled = true and configure which subsystems to
      // freeze after an initial warm-up period.  See QuadtreeTileManager
      // for the runtime logic.
      debugProfile: (() => {
        const dp = gpuQuadtree.debugProfile || {};
        return {
          enabled:          !!(dp.enabled),
          warmupFrames:     Math.max(0, Math.floor(dp.warmupFrames ?? 300)),
          freezeGeneration: !!(dp.freezeGeneration),
          freezeFeedback:   !!(dp.freezeFeedback),
          freezeTraversal:  !!(dp.freezeTraversal),
          freezeInstances:  !!(dp.freezeInstances),
          freezeUniforms:   !!(dp.freezeUniforms),
        };
      })(),
    };

    // ==================== DATA TEXTURE CONFIG (ENGINE-WIDE) ====================
    const dataTextureOptions = requireObject(options.dataTexture, 'dataTexture');
    this.dataTexture = dataTextureOptions instanceof DataTextureConfig
      ? dataTextureOptions
      : new DataTextureConfig(dataTextureOptions);
  }

  // ==================== DERIVED (DO NOT SET DIRECTLY) ====================

  /** meters per chunk edge */
  get chunkSizeMeters() {
    return this.vertexSpacingMeters * this.chunkSegments;
  }

  /** vertices per chunk edge (including shared edge) */
  get chunkVertices() {
    return this.chunkSegments + 1;
  }

  /** distance->LOD helper */
  getLODForDistance(distanceMeters) {
    const d = Math.max(0, requireNumber(distanceMeters, 'distanceMeters'));
    const arr = this.lod.distancesMeters;
    for (let i = 0; i < arr.length; i++) {
      if (d < arr[i]) return i;
    }
    return Math.max(0, arr.length - 1);
  }
}
