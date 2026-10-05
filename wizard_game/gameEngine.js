// js/wizard_game/gameEngine.js

import { Frontend } from '../core/renderer/frontend/frontend.js';
import { Camera } from '../core/Camera.js';
import { GameTime } from './gameTime.js';
import { EnvironmentState } from '../core/environment/EnvironmentState.js';
import { Vector3 } from '../shared/math/index.js';
import { TextureAtlasManager } from '../core/texture/TextureManager.js';
import { Spaceship } from './game/spaceShip.js';
import { SpaceshipModel } from './game/spaceShipModel.js';
import { AltitudeController } from './game/altitudeController.js';
import { GameInputManager } from './GameInputManager.js';
import { TextureCache } from '../core/texture/textureCache.js';
import { AltitudeZoneManager } from '../core/planet/altitudeZoneManager.js';
import { PlanetConfig } from '../templates/configs/planetConfig.js';
import { SphericalChunkMapper } from '../core/planet/sphericalChunkMapper.js';
import { StarSystem } from '../core/celestial/StarSystem.js';
import { EngineConfig } from '../core/EngineConfig.js';
import { GameDataConfig } from './GameDataConfig.js';
import { Logger } from '../shared/Logger.js';
import { GameUI } from './ui/GameUI.js';
import { WebGPUTerrainGenerator } from '../core/world/webgpuTerrainGenerator.js';
import { ProceduralTextureGenerator } from '../core/texture/webgpu/textureGenerator.js';
import { PropTextureManager } from '../core/texture/PropTextureManager.js';
import { PropMaterialFactory } from '../core/renderer/streamer/species/PropMaterialFactory.js';
import { getCloudLayers } from '../templates/clouds/cloudTypeDefinitions.js';
import {
    TEXTURE_LEVELS,
    ATLAS_CONFIG,
    TextureConfigHelper,
    SEASONS,
    TILE_CONFIG
} from '../templates/configs/TileConfig.js';
import { TEXTURE_CONFIG } from '../templates/configs/atlasConfig.js';
import { NightSkyGameConfig, getNightSkyDetailPreset, NightSkyDetailLevel } from '../templates/configs/nightSkyConfig.js';
import { TILE_TYPES, TILE_CATEGORIES, NUM_TILE_CATEGORIES, buildTileCategoryLookupWGSL } from '../templates/configs/tileTypes.js';
import { createTerrainThemeForPlanet } from './TerrainThemeFactory.js';
import { createTerrainCommon } from '../templates/terrain-shaders/terrainCommon.wgsl.js';
import { createSurfaceCommon } from '../templates/terrain-shaders/surfaceCommon.wgsl.js';
import { createTerrainFeatureContinents } from '../templates/terrain-shaders/features/featureContinents.wgsl.js';
import { createTerrainFeaturePlains } from '../templates/terrain-shaders/features/featurePlains.wgsl.js';
import { createTerrainFeatureHills } from '../templates/terrain-shaders/features/featureHills.wgsl.js';
import { createTerrainFeatureMountains } from '../templates/terrain-shaders/features/featureMountains.wgsl.js';
import { createTerrainFeatureCanyons } from '../templates/terrain-shaders/features/featureCanyons.wgsl.js';
import { createTerrainFeatureLoneHills } from '../templates/terrain-shaders/features/featureLoneHills.wgsl.js';
import { createTerrainFeatureMicro } from '../templates/terrain-shaders/features/featureMicro.wgsl.js';
import { createTerrainFeatureMesoDetail } from '../templates/terrain-shaders/features/featureMesoDetail.wgsl.js';
import { createTerrainFeatureHighlands } from '../templates/terrain-shaders/features/featureHighlands.wgsl.js';
import { createTerrainFeatureRivers } from '../templates/terrain-shaders/features/featureRivers.wgsl.js';
import { createTerrainFeatureErosionSeeds } from '../templates/terrain-shaders/features/featureErosionSeeds.wgsl.js';
import { createTerrainFeatureErosionFilter } from '../templates/terrain-shaders/features/featureErosionFilter.wgsl.js';
import { createEarthlikeConstants, createEarthlikeBase } from '../templates/terrain-shaders/base/earthLikeBase.wgsl.js';
import { HydrologyPrecompute } from '../core/world/hydrology/HydrologyPrecompute.js';
import { WaterService } from '../core/world/hydrology/WaterService.js';
import { WaterGpuData, tilesTouchingCells } from '../core/world/water/WaterGpuData.js';
import { WaterSimSite } from '../core/world/water/WaterSimSite.js';
import { ErosionSeedVerifier } from '../core/world/hydrology/ErosionSeedVerifier.js';
import { computeSurfaceTangentFrame } from '../core/planet/surfaceFrame.js';
import { TILE_LAYER_HEIGHTS, TILE_TRANSITION_RULES } from '../templates/configs/tileTransitionConfig.js';
import {
    validateTierRanges,
    TREE_TIER_RANGES,
    MID_TIER_CONFIG,
    SPECIES_CANOPY_PROFILES,
} from '../templates/streamer/treeTierConfig.js';
import { TEXTURE_LAYER_MAPPING, ARCHETYPE_DEFINITIONS } from '../templates/streamer/archetype/archetypeDefinitions.js';
import { DEFAULT_ASSET_DEFINITIONS } from '../templates/streamer/AssetDefinitions.js';
import { getSpeciesRegistry } from '../templates/streamer/species/SpeciesRegistry.js';
import { PlacementFamily } from '../templates/streamer/archetype/PlacementFamily.js';
import { AssetVariant } from '../templates/streamer/archetype/AssetVariant.js';
import { RockGeometryBuilder } from '../templates/streamer/archetype/geometry/RockGeometryBuilder.js';
import { FernGeometryBuilder } from '../templates/streamer/archetype/geometry/FernGeometryBuilder.js';
import { SansevieriaGeometryBuilder } from '../templates/streamer/archetype/geometry/SansevieriaGeometryBuilder.js';
import { MushroomGeometryBuilder } from '../templates/streamer/archetype/geometry/MushroomGeometryBuilder.js';
import { DeadwoodGeometryBuilder } from '../templates/streamer/archetype/geometry/DeadwoodGeometryBuilder.js';
import { BirchBranchGenerator } from '../templates/streamer/branch/species/BirchBranchGenerator.js';
import {
    ASSET_SELF_OCCLUSION,
    ASSET_DEF_FLOATS,
    ENABLE_SCATTER_DENSITY_GROUPS,
    ENABLE_SCATTER_ELIGIBILITY_GATE,
    LODS_PER_CATEGORY,
    QUALITY_PRESETS,
    SCATTER_DENSITY_GROUPS,
    SCATTER_POLICY_GROUPS,
    CAT_TREES,
    TREE_VISIBILITY,
    TREE_FADE_START_RATIO,
    TREE_FADE_END_RATIO,
    TREE_BILLBOARD_LOD_START,
    TREE_BILLBOARD_LOD_END,
    TREE_DENSITY_SCALE,
    TREE_CELL_SIZE,
    TREE_MAX_PER_CELL,
    TREE_CLUSTER_PROBABILITY,
    TREE_JITTER_SCALE,
    TERRAIN_AO_CONFIG,
    GROUND_FIELD_BAKE_CONFIG,
    GROUND_PROP_BAKE_CONFIG,
    TREE_SOURCE_BAKE_CONFIG,
} from '../templates/streamer/streamerConfig.js';

const STREAMER_THEME = {
    validateTierRanges,
    TREE_TIER_RANGES,
    MID_TIER_CONFIG,
    SPECIES_CANOPY_PROFILES,
    TEXTURE_LAYER_MAPPING,
    ARCHETYPE_DEFINITIONS,
    DEFAULT_ASSET_DEFINITIONS,
    getSpeciesRegistry,
    PlacementFamily,
    AssetVariant,
    RockGeometryBuilder,
    FernGeometryBuilder,
    SansevieriaGeometryBuilder,
    MushroomGeometryBuilder,
    DeadwoodGeometryBuilder,
    BirchBranchGenerator,
    ASSET_SELF_OCCLUSION,
    ASSET_DEF_FLOATS,
    ENABLE_SCATTER_DENSITY_GROUPS,
    ENABLE_SCATTER_ELIGIBILITY_GATE,
    LODS_PER_CATEGORY,
    QUALITY_PRESETS,
    SCATTER_DENSITY_GROUPS,
    SCATTER_POLICY_GROUPS,
    CAT_TREES,
    TREE_VISIBILITY,
    TREE_FADE_START_RATIO,
    TREE_FADE_END_RATIO,
    TREE_BILLBOARD_LOD_START,
    TREE_BILLBOARD_LOD_END,
    TREE_DENSITY_SCALE,
    TREE_CELL_SIZE,
    TREE_MAX_PER_CELL,
    TREE_CLUSTER_PROBABILITY,
    TREE_JITTER_SCALE,
    TERRAIN_AO_CONFIG,
    GROUND_FIELD_BAKE_CONFIG,
    GROUND_PROP_BAKE_CONFIG,
    TREE_SOURCE_BAKE_CONFIG,
};

const NIGHT_SKY_THEME = {
    NightSkyGameConfig,
    getNightSkyDetailPreset,
    NightSkyDetailLevel,
};

const TERRAIN_SHADER_BUNDLE = {
    createTerrainCommon,
    createSurfaceCommon,
    createTerrainFeatureContinents,
    createTerrainFeaturePlains,
    createTerrainFeatureHills,
    createTerrainFeatureMountains,
    createTerrainFeatureCanyons,
    createTerrainFeatureLoneHills,
    createTerrainFeatureMicro,
    createTerrainFeatureMesoDetail,
    createTerrainFeatureHighlands,
    createTerrainFeatureRivers,
    createTerrainFeatureErosionSeeds,
    createTerrainFeatureErosionFilter,
    baseGenerators: {
        earthLike: {
            constants: createEarthlikeConstants,
            base: createEarthlikeBase,
        },
    },
};

// Walking-skeleton demo river's fixed world-space placement — MUST exactly
// match wizard_game/runtimeConfigs.js's `terrain.river.anchorDir`/
// `channelDir` (that's what the terrain generator carves into real height
// at generation time, see templates/terrain-shaders/features/
// featureRivers.wgsl.js). Duplicated rather than imported only because this
// is a hardcoded demo with no authoring system yet — see
// RIVER_WALKING_SKELETON_LOG.md, Session 4.
const DEMO_RIVER_ANCHOR_DIR = { x: -1, y: 0, z: 0 };

const TERRAIN_THEME = {
    TILE_TYPES,
    TILE_CATEGORIES,
    NUM_TILE_CATEGORIES,
    buildTileCategoryLookupWGSL,
    terrainShaderBundle: TERRAIN_SHADER_BUNDLE,
};

function updateCanvasResolution(canvas) {
    const displayWidth = canvas.clientWidth;
    const displayHeight = canvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;

    const width = Math.max(1, Math.floor(displayWidth * dpr));
    const height = Math.max(1, Math.floor(displayHeight * dpr));

    if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        return { width, height, changed: true };
    }

    return { width, height, changed: false };
}

export class GameEngine {
    constructor(canvasId, engineConfig, gameDataConfig) {
        this.canvas = document.getElementById(canvasId);
        if (!this.canvas) {
            throw new Error('Canvas element not found');
        }

        if (!(engineConfig instanceof EngineConfig)) {
            throw new Error('GameEngine requires an EngineConfig');
        }
        if (!(gameDataConfig instanceof GameDataConfig)) {
            throw new Error('GameEngine requires a GameDataConfig');
        }

        this.engineConfig = engineConfig;
        this.gameDataConfig = gameDataConfig;

        // Apply log level from config
        Logger.setLevel(this.engineConfig.logLevel);

        updateCanvasResolution(this.canvas);
        this.chunkSize = this.engineConfig.chunkSizeMeters;

        this.textureCache = new TextureCache();

        // UI manager
        this.ui = this._createGameUI();

        window.gameEngine = this;

        this._fps = 0;
        this._fpsFrames = 0;
        this._fpsLastSample = performance.now();
        this._manualShiftMultiplier = 1;
        this._lastUIUpdate = 0;
        this._uiUpdateIntervalMs = this.engineConfig.ui.updateIntervalMs;
        this._renderInFlight = false;
        this._resizePending = false;
        this._initialLoadState = null;
    }

    toggleCameraMode() {
        const modes = this.actorManager ? ['manual', 'character'] : ['manual', 'follow'];
        const i = modes.indexOf(this.cameraMode);
        this.cameraMode = modes[(i + 1) % modes.length];
        if (this.cameraMode === 'character') {
            this.actorManager?.cameraController?.snap();
        } else if (this.cameraMode === 'follow') {
            this.camera.follow(this.spaceship);
            this.camera.resetOrbit();
        } else {
            this.camera.unfollow();
        }
        Logger.info(`[GameEngine] Camera mode: ${this.cameraMode}`);
    }

    _cycleCirrusQuality() {
        const cloudRenderer = this.renderer?.cloudRenderer;
        if (!cloudRenderer) return;

        const options = ['low', 'medium', 'high', 'ultra'];
        const currentRaw = `${cloudRenderer.config?.cirrusQuality ?? 'high'}`.toLowerCase();
        const currentIndex = options.indexOf(currentRaw);
        const next = options[(currentIndex + 1) % options.length];

        if (typeof cloudRenderer.setCirrusQuality === 'function') {
            cloudRenderer.setCirrusQuality(next);
        } else if (cloudRenderer.config) {
            cloudRenderer.config.cirrusQuality = next;
        }

        Logger.info(`[Clouds] Cirrus quality: ${next}`);
    }

    _computeSpawn() {
        const spawnConfig = this.gameDataConfig?.spawn;
        if (!spawnConfig) {
            return { x: 0, y: 0, z: 0 };
        }

        let spawnX = spawnConfig.defaultX;
        let spawnY = spawnConfig.defaultY;
        let spawnZ = spawnConfig.defaultZ;

        if (!this.planetConfig) {
            return { x: spawnX, y: spawnY, z: spawnZ };
        }

        const spawnHeight = spawnConfig.height;
        const radius = this.planetConfig.radius;
        const origin = this.planetConfig.origin || { x: 0, y: 0, z: 0 };

        if (
            spawnConfig.spawnOnSunSide &&
            this.starSystem &&
            this.starSystem.currentBody &&
            this.starSystem.primaryStar
        ) {
            this.starSystem.update(0);

            const starInfo = this.starSystem.currentBody.getStarDirection(
                this.starSystem.primaryStar,
                origin
            );
            const sunDir = starInfo?.direction;

            if (sunDir) {
                const spawnRadius = radius + spawnHeight;
                return {
                    x: origin.x + sunDir.x * spawnRadius,
                    y: origin.y + sunDir.y * spawnRadius,
                    z: origin.z + sunDir.z * spawnRadius,
                };
            }
        }

        return {
            x: origin.x,
            y: origin.y + radius + spawnHeight,
            z: origin.z,
        };
    }

    _createInitialLoadState() {
        const config = this.engineConfig?.ui?.initialLoad ?? {};
        const enabled = config.enabled !== false && this.renderer?.isGPUQuadtreeActive?.() === true;
        const startedAt = performance.now();
        return {
            enabled,
            active: enabled,
            complete: !enabled,
            phase: enabled ? 'warming-quadtree' : 'ready',
            title: enabled ? 'Stabilizing the first terrain pass' : 'Ready',
            detail: enabled ? 'Preparing the first resident quadtree shell.' : 'Ready',
            progress: enabled ? 0.02 : 1,
            startedAt,
            finishedAt: enabled ? 0 : startedAt,
            stableFrames: 0,
            stableFramesRequired: Math.max(1, config.stableFramesRequired ?? 12),
            revealStarted: false,
            stats: null,
        };
    }

    _completeInitialLoad(finalDetail = 'Terrain ready.') {
        if (!this._initialLoadState || this._initialLoadState.complete) return;
        this._initialLoadState.active = false;
        this._initialLoadState.complete = true;
        this._initialLoadState.phase = 'ready';
        this._initialLoadState.title = 'Planetfall ready';
        this._initialLoadState.detail = finalDetail;
        this._initialLoadState.progress = 1;
        this._initialLoadState.finishedAt = performance.now();
    }

    _tickInitialLoadState() {
        const state = this._initialLoadState;
        if (!state?.active) return state;

        const config = this.engineConfig?.ui?.initialLoad ?? {};
        const stats = this.renderer?.getInitialLoadStatus?.() ?? null;
        state.stats = stats;

        if (!stats?.hasVisibleReadback) {
            state.phase = 'surveying';
            state.title = 'Surveying the horizon';
            state.detail = 'Waiting for the first quadtree visibility pass.';
            state.progress = Math.max(state.progress, 0.08);
        } else {
            const visibleTarget = Math.max(1, Math.min(stats.visibleTiles, config.minVisibleTiles ?? 48));
            const visibleCoverage = Math.min(1, stats.residentVisibleTiles / visibleTarget);
            const exactCoverage = Math.min(
                1,
                stats.exactVisibleRatio / Math.max(0.0001, config.exactVisibleRatio ?? 0.55)
            );
            const queueBudget = Math.max(
                1,
                (config.maxPendingGenerations ?? 24) +
                (config.maxActiveGenerations ?? 8) +
                Math.max(1, config.maxPendingCopies ?? 0)
            );
            const queuePressure = Math.min(
                1,
                (stats.pendingGenerations + stats.activeGenerations + stats.pendingCopies) / queueBudget
            );
            const queueSettled = 1 - queuePressure;
            const rawProgress = 0.12 + (visibleCoverage * 0.5) + (exactCoverage * 0.22) + (queueSettled * 0.16);
            state.progress = Math.max(state.progress, Math.min(0.98, rawProgress));

            const residentReady = stats.residentVisibleRatio >= (config.residentVisibleRatio ?? 0.92);
            const exactReady = stats.exactVisibleRatio >= (config.exactVisibleRatio ?? 0.55);
            const visibleReady = stats.visibleTiles >= (config.minVisibleTiles ?? 48);
            const queueReady =
                stats.pendingGenerations <= (config.maxPendingGenerations ?? 24) &&
                stats.activeGenerations <= (config.maxActiveGenerations ?? 8) &&
                stats.pendingCopies <= (config.maxPendingCopies ?? 0);

            if (residentReady && exactReady && visibleReady && queueReady) {
                state.stableFrames++;
                state.phase = 'locking';
                state.title = 'Locking terrain residency';
                state.detail = `Holding ${state.stableFrames}/${state.stableFramesRequired} stable frames before reveal.`;
                state.progress = Math.max(
                    state.progress,
                    0.9 + 0.08 * Math.min(1, state.stableFrames / state.stableFramesRequired)
                );
            } else {
                state.stableFrames = 0;
                if (stats.pendingGenerations + stats.activeGenerations > 0) {
                    state.phase = 'streaming';
                    state.title = 'Streaming terrain tiles';
                    state.detail = `${stats.residentVisibleTiles}/${stats.visibleTiles} visible tiles resident, ${stats.pendingGenerations + stats.activeGenerations} generations in flight.`;
                } else if (stats.exactVisibleRatio < (config.exactVisibleRatio ?? 0.55)) {
                    state.phase = 'refining';
                    state.title = 'Refining first-ring detail';
                    state.detail = 'Replacing fallback ancestors with exact tiles.';
                } else {
                    state.phase = 'settling';
                    state.title = 'Settling the first frame';
                    state.detail = 'Waiting for copies and residency updates to finish.';
                }
            }
        }

        const elapsedMs = performance.now() - state.startedAt;
        const minOverlayMs = Math.max(0, config.minOverlayMs ?? 0);
        const maxWaitMs = Math.max(minOverlayMs + 1, config.maxWaitMs ?? 12000);
        const stableReady = state.stableFrames >= state.stableFramesRequired;

        if (stableReady && elapsedMs >= minOverlayMs) {
            this._completeInitialLoad('Initial terrain residency is stable.');
        } else if (elapsedMs >= maxWaitMs) {
            this._completeInitialLoad('Initial load timed out; revealing with current terrain residency.');
        }

        return state;
    }

    getLoadingStatus() {
        return this._tickInitialLoadState();
    }

    isInitialLoadComplete() {
        return this.getLoadingStatus()?.complete !== false;
    }

    updateManualCamera(deltaTime, keys, mouseDelta) {
        const manualConfig = this.engineConfig.manualCamera;

        if (keys['Shift']) {
            this._manualShiftMultiplier = Math.min(
                manualConfig.maxBoost,
                this._manualShiftMultiplier + manualConfig.accelerationRate * deltaTime
            );
        } else {
            this._manualShiftMultiplier = Math.max(
                1,
                this._manualShiftMultiplier - manualConfig.decelerationRate * deltaTime
            );
        }
        const moveSpeed = manualConfig.baseSpeed * this._manualShiftMultiplier * deltaTime;

        let forward = 0, right = 0, up = 0;

        if (keys['w'] || keys['W']) forward += moveSpeed;
        if (keys['s'] || keys['S']) forward -= moveSpeed;
        if (keys['a'] || keys['A']) right -= moveSpeed;
        if (keys['d'] || keys['D']) right += moveSpeed;
        if (keys['q'] || keys['Q']) up -= moveSpeed;
        if (keys['e'] || keys['E']) up += moveSpeed;

        if (forward !== 0 || right !== 0 || up !== 0) {
            this.camera.moveRelative(forward, right, up);
        }

        if (this.inputManager.isLeftDragging()) {
            this.camera.handleManualLook(mouseDelta.x, mouseDelta.y);
        }
    }


    async start() {
        const vertexSpacingMeters = this.engineConfig.vertexSpacingMeters;
        const chunkSegments = this.engineConfig.chunkSegments;
        const surfaceChunkSize = this.engineConfig.chunkSizeMeters;
        this.chunkSize = surfaceChunkSize;

        if (!Number.isFinite(this.chunkSize) || this.chunkSize <= 0) {
            throw new Error(`Invalid chunkSize: ${this.chunkSize}`);
        }

        const enabledPlanets = this.gameDataConfig.planets.filter((planet) => planet.enabled);
        if (enabledPlanets.length !== 1) {
            throw new Error('GameEngine requires exactly one enabled planet in starSystem.planets');
        }
        const activePlanet = enabledPlanets[0];

        const planetOptions = this.gameDataConfig.buildPlanetOptions(
            { surfaceChunkSize },
            activePlanet.id
        );

        this.planetConfig = new PlanetConfig({
            ...planetOptions,
            engineConfig: this.engineConfig
        });
        this.terrainTheme = createTerrainThemeForPlanet(TERRAIN_THEME, this.planetConfig);

        const worldAuthoringSummary = this.planetConfig?.worldAuthoring?.summary;
        const shouldLogWorldAuthoring = !!worldAuthoringSummary && (
            worldAuthoringSummary.biomeCount > 0 ||
            worldAuthoringSummary.assetProfileCount > 0 ||
            worldAuthoringSummary.tileCatalogTileCount > 0 ||
            worldAuthoringSummary.unresolvedTileRefCount > 0 ||
            worldAuthoringSummary.outOfTextureRangeTileRefCount > 0 ||
            worldAuthoringSummary.unknownAssetBiomeRefCount > 0 ||
            worldAuthoringSummary.tileCatalogWarningCount > 0
        );
        if (shouldLogWorldAuthoring) {
            Logger.info(
                `[GameEngine] Planet "${this.planetConfig.name}" authoring: ` +
                `${worldAuthoringSummary.biomeCount} biomes, ` +
                `${worldAuthoringSummary.assetProfileCount} asset profiles, ` +
                `${worldAuthoringSummary.tileCatalogTileCount ?? 0} tile refs`
            );
        }

        this.altitudeZoneManager = new AltitudeZoneManager(this.planetConfig);
        this.planetConfig.altitudeZoneManager = this.altitudeZoneManager;

        // Keep engine chunkSize synced to planet’s surfaceChunkSize
        this.chunkSize = this.planetConfig.surfaceChunkSize;

        this.sphericalMapper = new SphericalChunkMapper(this.planetConfig);

        if (this.planetConfig) {
            const starSystemOptions = this.gameDataConfig.buildStarSystemOptions(this.planetConfig);
            this.starSystem = StarSystem.createTestSystem(this.planetConfig, starSystemOptions);
        }

        updateCanvasResolution(this.canvas);

        this.inputManager = new GameInputManager(this.canvas);

        // Initialize GameTime with configuration
        this.gameTime = new GameTime();
        this.gameTime.dayDurationMs = this.gameDataConfig.time.dayDurationMs;
        this.gameTime.startDay = this.gameDataConfig.time.startDay;
        this.gameTime.currentDay = this.gameDataConfig.time.startDay;
        const startHour = this.gameDataConfig.time.startHour;
        const offsetMs = (startHour / 24) * this.gameTime.dayDurationMs;
        this.gameTime.dayStartTime = Date.now() - offsetMs;

        if (this.starSystem) {
            this.starSystem.autoTimeScale = this.gameDataConfig.starSystem.autoTimeScale;
            this.starSystem.useGameTimeRotation = this.gameDataConfig.starSystem.useGameTimeRotation;
            this._syncStarSystemTimeScale();
        }

        this.renderer = new Frontend(this.canvas, {
            textureCache: this.textureCache,
            chunkSize: this.chunkSize,
            lodDistances: this.engineConfig.lod.distancesMeters,
            engineConfig: this.engineConfig,
            gpuQuadtree: this.engineConfig.gpuQuadtree,
            streamerTheme: STREAMER_THEME,
            nightSkyTheme: NIGHT_SKY_THEME,
            terrainTheme: this.terrainTheme,
            particleAuthoring: this.gameDataConfig.particleAuthoring,
        });
        await this.renderer.initialize(this.planetConfig, this.sphericalMapper, {
            weatherConfig: {
                ...(this.engineConfig.weather || {}),
                cloudLayerProvider: getCloudLayers
            }
        });

Logger.info('[GameEngine] Renderer using WebGPU backend');

const gpuDevice = this.renderer.backend.device;

// ── Shared procedural texture generator ───────────────────────────────
// Created once here, injected into both terrain-atlas and prop-atlas
// managers. setSize() is called by consumers before generation, so the
// initial 128×128 is just a default.
this.proceduralTextureGenerator = new ProceduralTextureGenerator(gpuDevice, 128, 128);
await this.proceduralTextureGenerator.initialize();

// ── Terrain texture atlas ─────────────────────────────────────────────
this.textureManager = new TextureAtlasManager(false, gpuDevice, this.proceduralTextureGenerator, {
    TILE_CONFIG: this.planetConfig.tileConfig || TILE_CONFIG,
    TEXTURE_LEVELS,
    ATLAS_CONFIG,
    TEXTURE_CONFIG: this.planetConfig.atlasConfig || TEXTURE_CONFIG,
    TextureConfigHelper,
    SEASONS,
    TILE_LAYER_HEIGHTS,
    TILE_TRANSITION_RULES
});
this.textureManager.backend = this.renderer.backend;
this.renderer.textureManager = this.textureManager;

await this.textureManager.initializeAtlases(true);

// ── Prop texture atlas (for streamed assets) ──────────────────────────
this.propTextureManager = new PropTextureManager({
    gpuDevice,
    proceduralTextureGenerator: this.proceduralTextureGenerator,
    backend: this.renderer.backend,
    textureSize: 512,
    seamlessConfig: {
        enabled: true,
        blendRadius: 24,      // wider margin — dashes can reach edges
        blendStrength: 0.85,
        method: 'wrap',
        cornerBlend: false
    }
});

const propDefinitions = PropMaterialFactory.buildAllPropDefinitions({
    baseSeed: this.engineConfig.seed ?? 12345,
    getSpeciesRegistry: STREAMER_THEME.getSpeciesRegistry,
});
await this.propTextureManager.buildPropAtlas(propDefinitions);

// ── Leaf albedo atlas (birch variants) ───────────────────────────────
this.leafAlbedoTextureManager = new PropTextureManager({
    gpuDevice,
    proceduralTextureGenerator: this.proceduralTextureGenerator,
    backend: this.renderer.backend,
    textureSize: 512,
    seamlessConfig: {
        enabled: true,
        blendRadius: 16,
        blendStrength: 0.85,
        method: 'wrap',
        cornerBlend: false
    }
});
const leafAlbedoDefinitions = PropMaterialFactory.buildBirchLeafAlbedoDefinitions({
    baseSeed: (this.engineConfig.seed ?? 12345) + 100000,
    variantCount: 12
});
await this.leafAlbedoTextureManager.buildPropAtlas(leafAlbedoDefinitions);

// ── Leaf normal atlas (birch variants) ───────────────────────────────
this.leafNormalTextureManager = new PropTextureManager({
    gpuDevice,
    proceduralTextureGenerator: this.proceduralTextureGenerator,
    backend: this.renderer.backend,
    textureSize: 512,
    seamlessConfig: {
        enabled: true,
        blendRadius: 16,
        blendStrength: 0.85,
        method: 'wrap',
        cornerBlend: false
    }
});
const leafNormalDefinitions = PropMaterialFactory.buildBirchLeafNormalDefinitions({
    baseSeed: (this.engineConfig.seed ?? 12345) + 200000,
    variantCount: 12
});
await this.leafNormalTextureManager.buildPropAtlas(leafNormalDefinitions);

this.renderer.propTextureManager = this.propTextureManager;
this.renderer.leafAlbedoTextureManager = this.leafAlbedoTextureManager;
this.renderer.leafNormalTextureManager = this.leafNormalTextureManager;

        this.terrainGenerator = new WebGPUTerrainGenerator(
            this.renderer.backend.device,
            this.engineConfig.seed,
            this.chunkSize,
            this.engineConfig.macroConfig,
            this.engineConfig.splatConfig,
            this.textureCache,
            {
                planetConfig: this.planetConfig,
                terrainTheme: this.terrainTheme,
            }

        );
        await this.terrainGenerator.initialize();

        console.log('WebGPUTerrainGenerator initialized', this.terrainGenerator);
        if (this.engineConfig.gpuQuadtree?.enabled) {
            await this.renderer.initializeGPUQuadtree( this.terrainGenerator);
        }

        // Initialize EnvironmentState (Dumb Container)
        this.environmentState = new EnvironmentState(this.gameTime, this.planetConfig);

        this.spaceship = new Spaceship();
        this.spaceshipModel = new SpaceshipModel();
        this.altitudeController = new AltitudeController(this.spaceship);

        this.cameraMode = 'manual';

        const cameraConfig = this.engineConfig.camera;

        this.camera = new Camera({
            aspect: this.canvas.width / this.canvas.height,
            fov: cameraConfig.fov,
            near: cameraConfig.near,
            far: cameraConfig.far,
            cameraDistance: cameraConfig.distance,
            cameraHeight: cameraConfig.height,
            lookAtSmoothing: cameraConfig.lookAtSmoothing,
            lookAheadDistance: cameraConfig.lookAheadDistance,
            lookAheadHeight: cameraConfig.lookAheadHeight
        });

        if (this.planetConfig) {
            const origin = this.planetConfig.origin;
            this.camera.setPlanetCenter({
                x: origin.x,
                y: origin.y,
                z: origin.z
            });
        }

        if (this.renderer && this.renderer.backend) {
            await this.spaceshipModel.initialize(this.renderer.backend);

            if (this.renderer.genericMeshRenderer) {
                await this.renderer.genericMeshRenderer.addModel('spaceship', this.spaceshipModel);
            }
        }

        window.addEventListener('keydown', (e) => {
            if (e.key === 'b') {
                const cc = this.actorManager?.cameraController;
                if (cc) {
                    cc.setSnapBackMode(!cc.snapBackOnRelease);
                    Logger.info(`[GameEngine] Camera snap-back: ${cc.snapBackOnRelease}`);
                }
            }
            if (e.key === 'v') {
                this.toggleCameraMode();
            }
            if (e.key === 'c') {
                if (this.environmentState) {
                    this.environmentState.disableClouds = !this.environmentState.disableClouds;
                }
            }
            if (e.key === 'o') {
                const ocean = this.renderer?.globalOceanRenderer;
                if (ocean) {
                    ocean.enabled = !ocean.enabled;
                }
            }
            if (e.key === 'k') {
                this._cycleCirrusQuality();
            }
            if (e.key === 'l') {
                const streamer = this.renderer?.assetStreamer;
                if (streamer) {
                    streamer.triggerLODTestKey();
                } else {
                    Logger.warn('[GameEngine] LOD test unavailable');
                }
            }

        });

        this._resizeHandler = () => this.handleResize();
        this.isGameActive = false;
        this.gameState = null;

        this.ui.setup(this);

        this.camera.follow(this.spaceship);

        this.inputManager.start();
        this.isGameActive = true;

        let { x: spawnX, y: spawnY, z: spawnZ } = this._computeSpawn();

        if (this.renderer?.placeDemoRiver && this.planetConfig?.origin && Number.isFinite(this.planetConfig?.radius)) {
            // Fixed direction, NOT derived from spawnX/Y/Z: the terrain
            // generator carves the river's channel into real height at a
            // fixed world-space anchor (DEMO_RIVER_ANCHOR_DIR, matching
            // wizard_game/runtimeConfigs.js's terrain.river.anchorDir) that's
            // baked in once per tile and never invalidated — the water
            // simulation's own tangent frame has to line up with that same
            // fixed point, not wherever the (sun-relative) spawn happens to
            // land. See RIVER_WALKING_SKELETON_LOG.md, Session 4.
            const origin = this.planetConfig.origin;
            let dir = new Vector3(DEMO_RIVER_ANCHOR_DIR.x, DEMO_RIVER_ANCHOR_DIR.y, DEMO_RIVER_ANCHOR_DIR.z).normalize();
            let anchorPos = new Vector3(origin.x, origin.y, origin.z).add(dir.clone().multiplyScalar(this.planetConfig.radius));

            // Find an actual valley-following channel instead of using the
            // fixed straight line: sample real terrain height over a region
            // around the demo point, route flow by steepest descent, and
            // trace a path from wherever the most drainage area accumulates.
            // Must run — and planetConfig.terrainGeneration.river must be
            // updated — before any tile near here generates, since a tile's
            // height is baked once and never invalidated. See
            // RIVER_CARVE_ZERO_HEIGHT_BUG.md and RIVER_WALKING_SKELETON_LOG.md.
            const terrainGenerator = this.renderer?.quadtreeTileManager?.tileStreamer?.terrainGenerator;
            const device = this.renderer?.backend?.device;
            // Whether a real, terrain-following channel was found near the
            // demo point. No channel found is a legitimate outcome, not a
            // failure — see the "if the river does not have anywhere to
            // flow from there, no river forms" rule from the river/lake
            // design. Confirmed live: this specific fixed demo point can
            // have essentially zero landform gradient for well over a
            // kilometer in every direction (baseElevation identical to
            // float32 precision out to 128m, pure noise-floor jitter out to
            // 1km) — there's no slope to trace a channel along there, and
            // no amount of trace-algorithm robustness can recover a signal
            // that isn't present in the data. Previously this fell back to
            // drawing the old fixed straight-line demo river anyway, which
            // visibly contradicted the "no river forms" rule (a water patch
            // sitting on an un-carved hillside). Now: no channel found means
            // no river is placed at all.
            let riverFound = false;
            // The walking-skeleton demo river (carve + water patch) runs only
            // when terrain.river.enabled; off by default since 2026-10-04 (its
            // straight 16-point carve read as a ditch; the water graph will
            // provide real rivers).
            const demoRiverEnabled = this.planetConfig?.terrainGeneration?.river?.enabled === true;
            if (demoRiverEnabled && terrainGenerator && device) {
                try {
                    const frame = computeSurfaceTangentFrame(anchorPos, origin);
                    const hydrology = new HydrologyPrecompute(device);
                    const result = await hydrology.run({
                        terrainGenerator,
                        origin,
                        regionAnchor: anchorPos,
                        regionRight: frame.right,
                        regionForward: frame.forward,
                        gridW: 256,
                        gridL: 256,
                        // 4km x 4km region at 16m/cell. Sampling only the
                        // broad landform noise (not full detailed height,
                        // see HydrologyPrecompute.js) is smooth enough that
                        // finer resolution isn't needed for valley detection.
                        cellSize: 16.0,
                        radius: this.planetConfig.radius,
                    });
                    if (result) {
                        this.planetConfig.terrainGeneration.river.anchorDir = result.anchorDir;
                        this.planetConfig.terrainGeneration.river.channelDir = result.channelDir;
                        this.planetConfig.terrainGeneration.river.path = result.path;
                        dir = new Vector3(result.anchorDir.x, result.anchorDir.y, result.anchorDir.z).normalize();
                        anchorPos = new Vector3(origin.x, origin.y, origin.z).add(dir.clone().multiplyScalar(this.planetConfig.radius));
                        riverFound = true;
                    } else {
                        Logger.info('[Hydrology] no real channel near the demo point — no river placed there (working as designed, not a fallback)');
                    }
                } catch (err) {
                    Logger.warn(`[Hydrology] precompute failed, no river placed: ${err?.message || err}`);
                }
            }

            // Stage 2 of the river/lake design: verify the level-1 nudge
            // candidates (featureErosionSeeds.wgsl.js) near the same
            // reference point, and upgrade whichever ones are confirmed
            // real basins. Must run — and terrainGeneration.erosionSeeds
            // must be updated — before any tile near here generates, same
            // constraint as the river path above. Skipped when the pits are
            // off (terrain.features.erosionSeeds: false): the lake meshes
            // would sit on ground without a pit under them.
            const erosionSeedsOn = this.planetConfig?.terrainGeneration?.features?.erosionSeeds !== false;
            if (erosionSeedsOn && terrainGenerator && device) {
                try {
                    const refForward = new Vector3(
                        this.planetConfig.terrainGeneration.river.channelDir.x,
                        this.planetConfig.terrainGeneration.river.channelDir.y,
                        this.planetConfig.terrainGeneration.river.channelDir.z
                    ).normalize();
                    const verifier = new ErosionSeedVerifier(device);
                    const confirmed = await verifier.run({
                        terrainGenerator,
                        refDir: dir.clone(),
                        refForward,
                        radius: this.planetConfig.radius,
                    });
                    this.planetConfig.terrainGeneration.erosionSeeds.confirmed = confirmed;
                    this.renderer.setLakes?.(confirmed);
                } catch (err) {
                    Logger.warn(`[ErosionSeedVerify] verification failed, all candidates stay at level-1 nudge size: ${err?.message || err}`);
                }
            }

            // Spawn above wherever the river actually ended up, not the
            // independent default spawn config: the fixed straight-line
            // demo only ever looked connected because DEMO_RIVER_ANCHOR_DIR
            // and the spawn config happened to be manually kept pointed at
            // the same spot. Hydrology can place the channel anywhere in a
            // multi-km search area, so without this the player spawns with
            // no way to find it. See RIVER_CARVE_ZERO_HEIGHT_BUG.md.
            const spawnHeight = this.gameDataConfig?.spawn?.height ?? 800;
            const spawnPos = new Vector3(origin.x, origin.y, origin.z)
                .add(dir.clone().multiplyScalar(this.planetConfig.radius + spawnHeight));
            spawnX = spawnPos.x; spawnY = spawnPos.y; spawnZ = spawnPos.z;

            if (riverFound) {
                this.renderer.placeDemoRiver(anchorPos, this.planetConfig.terrainGeneration.river.channelDir);
            }

            // The demo spawns the player instantly on top of this fixed
            // point (no gradual approach), so the normal reactive/predictive
            // streaming paths never get a chance to deepen residency here in
            // time: predictive streaming only engages above a minimum camera
            // speed (it exists to avoid pop-in ahead of a fast-moving ship,
            // not to warm a stationary spawn), and reactive per-frame
            // refinement climbing from depth 0 to max depth one level at a
            // time is far slower than the initial-load loading screen's
            // wait budget. Without this, the river's carved channel (a
            // narrow, fine-scale feature) is still coarse/flat when the
            // world is revealed. See RIVER_WALKING_SKELETON_LOG.md, Session 4.
            this.renderer.quadtreeTileManager?.prewarmWorldPosition?.(anchorPos);
        }

        this.spaceship.reset(spawnX, spawnY, spawnZ);
        this.camera.follow(this.spaceship);

        this.inputManager.start();
        this.isGameActive = true;


        if (this.renderer?.isGPUQuadtreeActive()) {
            const { ActorManager } = await import('./actors/ActorManager.js');
            this._actorManagerCtor = { ActorManager };

            const assetStreamer = this.renderer.assetStreamer || null;
            let treeDetailSystem = null;
            if (assetStreamer) {
                treeDetailSystem =
                    (typeof assetStreamer.getTreeDetailSystem === 'function'
                        ? assetStreamer.getTreeDetailSystem()
                        : assetStreamer._treeDetailSystem) || null;
            }
            if (treeDetailSystem) {
                Logger.info(`[GameEngine] TreeDetailSystem found — maxCloseTrees=${treeDetailSystem.maxCloseTrees}`);
            } else {
                Logger.warn('[GameEngine] TreeDetailSystem NOT found — tree collision/nav disabled');
            }

            this.actorManager = this._createActorManager({
                device: this.renderer.backend.device,
                backend: this.renderer.backend,
                planetConfig: this.planetConfig,
                quadtreeGPU: this.renderer.quadtreeTileManager?.quadtreeGPU,
                tileStreamer: this.renderer.quadtreeTileManager?.tileStreamer,
                engineConfig: this.engineConfig,
                skinnedMeshRenderer: this.renderer.skinnedMeshRenderer,
                genericMeshRenderer: this.renderer.genericMeshRenderer,
                assetStreamer: assetStreamer,
                treeDetailSystem: treeDetailSystem,
            });
            await this.actorManager.initialize();
            const playerCharacterUrl = this.gameDataConfig?.playerCharacterUrl
                ?? '../assets/characters/player.char.json';
            await this.actorManager.createPlayer(
                playerCharacterUrl,
                { x: spawnX, y: spawnY, z: spawnZ }
            );
            this.renderer.setActorManager(this.actorManager);
            this.cameraMode = 'character';

            // Place a persistent campfire at the player's ground-snapped
            // position. The initial worldPos is a placeholder; the particle
            // system calls getActor() ~10 frames after registration to copy
            // the GPU-ground-snapped position.
            this._registerAmbiance({ spawnX, spawnY, spawnZ });

            // Wire click-to-move input
            this.canvas.addEventListener('click', (e) => {
                if (this.cameraMode !== 'character') return;
                if (!this.actorManager) return;
                this.actorManager._pendingScreenClick = {
                    x: e.offsetX * (window.devicePixelRatio || 1),
                    y: e.offsetY * (window.devicePixelRatio || 1),
                };
            });
            await this._registerNPCs();
        }
        this._initialLoadState = this._createInitialLoadState();
        Logger.info('[GameEngine] Initialization complete');
    }

    stop() {
        this.isGameActive = false;
        this.waterService?.dispose();
        this.waterService = null;
        this.inputManager.stop();
        if (this._resizeHandler) {
            window.removeEventListener('resize', this._resizeHandler);
            this._resizeHandler = null;
        }
    }

    update(deltaTime) {
        if (!this.isGameActive) return;
        deltaTime = Math.min(deltaTime, 0.1);
        this._fpsFrames++;
        const nowMs = performance.now();
        if (nowMs - this._fpsLastSample >= 500) {
            this._fps = (this._fpsFrames * 1000) / (nowMs - this._fpsLastSample);
            this._fpsFrames = 0;
            this._fpsLastSample = nowMs;
        }

        const keys = this.inputManager.getKeys();
        const mouseDelta = this.inputManager.getMouseDelta();
        const wheelDelta = this.inputManager.getWheelDelta();

        if (!this.isInitialLoadComplete()) {
            this._tickInitialLoadState();
            this.gameTime.update();
            this._syncStarSystemTimeScale();
            if (this.starSystem) {
                this.starSystem.update(deltaTime);
            }
            this._syncStarSystemRotation();

            if (this.altitudeZoneManager) {
                this.altitudeZoneManager.update(
                    new Vector3(this.camera.position.x, this.camera.position.y, this.camera.position.z),
                    deltaTime
                );
            }

            if (this.cameraMode === 'character' && this.actorManager) {
                const neutralInputState = {
                    keys: {},
                    mouseDelta: { x: 0, y: 0 },
                    isLeftDragging: false,
                    isRightDragging: false,
                    clickTarget: null,
                };
                this.actorManager.update(deltaTime, neutralInputState);
                const camState = this.actorManager.getCameraState(
                    deltaTime,
                    false,
                    neutralInputState.mouseDelta,
                    0
                );
                if (camState) {
                    this.camera.position.x = camState.position.x;
                    this.camera.position.y = camState.position.y;
                    this.camera.position.z = camState.position.z;
                    this.camera.target.x = camState.target.x;
                    this.camera.target.y = camState.target.y;
                    this.camera.target.z = camState.target.z;
                }
            } else if (this.cameraMode === 'follow') {
                this.camera.update();
            }

            this.gameState = {
                time: performance.now(),
                player: this.spaceship,
                spaceship: this.spaceship,
                objects: new Map(),
                camera: this.camera,
                altitudeZoneManager: this.altitudeZoneManager
            };
            this.updateUI();
            return;
        }

        if (this.inputManager.consumeKeyPress('KeyU')) {
            const result = this.renderer?.toggleTerrainManualDiagnosticSnapshot?.('key:u');
            if (!result) {
                Logger.warn('[GameEngine] Terrain manual snapshot unavailable');
            }
        }

        const terrainSnapshotFrozen = this.renderer?.isTerrainManualDiagnosticFrozen?.() === true;
        if (terrainSnapshotFrozen) {
            this.gameState = {
                time: performance.now(),
                player: this.spaceship,
                spaceship: this.spaceship,
                objects: new Map(),
                camera: this.camera,
                altitudeZoneManager: this.altitudeZoneManager
            };
            this.updateUI();
            return;
        }

        this.gameTime.update();
        this._syncStarSystemTimeScale();

        if (this.starSystem) {
            this.starSystem.update(deltaTime);
        }
        this._syncStarSystemRotation();

        // Update firefly glow from local sun visibility at the player/camera
        // position after the star system has been advanced for this frame.
        if (this.renderer?.particleSystem) {
            let daylightVisibility = 1.0;
            const samplePosition =
                this.actorManager?.playerActor?.position ||
                this.camera?.position ||
                null;

            if (
                samplePosition &&
                this.starSystem?.currentBody &&
                this.starSystem?.primaryStar &&
                this.planetConfig?.origin
            ) {
                const starInfo = this.starSystem.currentBody.getStarDirection(
                    this.starSystem.primaryStar,
                    this.planetConfig.origin
                );
                const sunDir = starInfo?.direction;
                if (sunDir) {
                    const ox = this.planetConfig.origin.x || 0;
                    const oy = this.planetConfig.origin.y || 0;
                    const oz = this.planetConfig.origin.z || 0;
                    const ux = (samplePosition.x || 0) - ox;
                    const uy = (samplePosition.y || 0) - oy;
                    const uz = (samplePosition.z || 0) - oz;
                    const lenSq = ux * ux + uy * uy + uz * uz;
                    if (lenSq > 1e-8) {
                        const invLen = 1.0 / Math.sqrt(lenSq);
                        const upx = ux * invLen;
                        const upy = uy * invLen;
                        const upz = uz * invLen;
                        const sunDotUp = upx * sunDir.x + upy * sunDir.y + upz * sunDir.z;
                        const daylightStartDot = -0.18;
                        const daylightFullDot = 0.28;
                        const t = Math.max(
                            0,
                            Math.min(1, (sunDotUp - daylightStartDot) / (daylightFullDot - daylightStartDot))
                        );
                        daylightVisibility = t * t * (3 - 2 * t);
                    }
                }
            }

            this.renderer.particleSystem.setFireflyTimeOfDay(daylightVisibility);
        }

        const cameraRenderPos = new Vector3(
            this.camera.position.x,
            this.camera.position.y,
            this.camera.position.z
        );

        if (this.altitudeZoneManager) {
            this.altitudeZoneManager.update(cameraRenderPos, deltaTime);
        }

        if (this.cameraMode === 'character' && this.actorManager) {
            const inputState = {
                keys, mouseDelta,
                isLeftDragging: this.inputManager.isLeftDragging(),
                isRightDragging: this.inputManager.isRightDragging(),
                clickTarget: null,
            };
            this.actorManager.update(deltaTime, inputState);
        
            const camState = this.actorManager.getCameraState(
                deltaTime,
                inputState.isLeftDragging,
                mouseDelta,
                wheelDelta
            );
            if (camState) {
                this.camera.position.x = camState.position.x;
                this.camera.position.y = camState.position.y;
                this.camera.position.z = camState.position.z;
                this.camera.target.x = camState.target.x;
                this.camera.target.y = camState.target.y;
                this.camera.target.z = camState.target.z;
            }
        } else if (this.cameraMode === 'manual') {
            this.updateManualCamera(deltaTime, keys, mouseDelta);
        } else {
            this.altitudeController.update(deltaTime, keys);


            if (this.inputManager.isLeftDragging()) {
                this.camera.handleOrbitInput(mouseDelta.x, mouseDelta.y);
            }

            if (wheelDelta !== 0) {
                this.camera.handleZoom(wheelDelta);
            }

            this.camera.update();
        }

        this._tickWater();

        this.gameState = {
            time: performance.now(),
            player: this.spaceship,
            spaceship: this.spaceship,
            objects: new Map(),
            camera: this.camera,
            altitudeZoneManager: this.altitudeZoneManager
        };

        // NOTE: Weather/Environment updates are now driven by the Frontend's WeatherController
        // during the render pass. We do NOT call environmentState.update() here anymore.
        if (this.actorManager) {
            this.actorManager.processNPCSpawns().catch((e) => {
                Logger.warn(`[GameEngine] NPC spawn processing failed: ${e?.message || e}`);
            });
        }
        this.updateUI();
    }

    _syncStarSystemTimeScale() {
        if (!this.starSystem || !this.gameTime || !this.starSystem.autoTimeScale) return;
        const daySeconds = Math.max(1, (this.gameTime.dayDurationMs) / 1000);
        const targetScale = 86400 / daySeconds;
        if (Number.isFinite(targetScale)) {
            this.starSystem.timeScale = targetScale;
        }
    }

    _syncStarSystemRotation() {
        if (!this.starSystem || !this.gameTime || !this.starSystem.useGameTimeRotation) return;
        if (!this.starSystem.currentBody || !Number.isFinite(this.gameTime.timeOfDay)) return;
        const dayFraction = (this.gameTime.timeOfDay % 24) / 24;
        this.starSystem.currentBody.currentRotation = dayFraction * Math.PI * 2;
    }

 

    async render(deltaTime) {
        if (!this.isGameActive) return;
        if (this._renderInFlight) return;

        if (this._resizePending) {
            this._resizePending = false;
            this.handleResize();
        }

        this._renderInFlight = true;
        const clampedDelta = Math.min(Math.max(Number.isFinite(deltaTime) ? deltaTime : 0, 0), 0.1);
        const terrainSnapshotFrozen = this.renderer?.isTerrainManualDiagnosticFrozen?.() === true;
        if (this.renderer && this.gameState) {
            try {
                // We pass environmentState to renderer, where WeatherController picks it up.
                await this.renderer.render(
                    this.gameState,
                    this.environmentState,
                    terrainSnapshotFrozen ? 0 : clampedDelta,
                    this.planetConfig,
                    this.sphericalMapper,
                    this.starSystem
                );
            } finally {
                this._renderInFlight = false;
            }
        } else {
            this._renderInFlight = false;
        }
    }

    onCrash() {
        this.ui.showCrashScreen();

        setTimeout(() => {
            this.resetGame();
        }, 3000);
    }

    resetGame() {
        const { x, y, z } = this._computeSpawn();
        this.spaceship.reset(x, y, z);
        this.ui.hideCrashScreen();
    }

    updateUI() {
        const now = performance.now();
        if (now - this._lastUIUpdate < this._uiUpdateIntervalMs) {
            return;
        }
        this._lastUIUpdate = now;

        const shipState = this.spaceship.getState();
        const zoneInfo = this.altitudeZoneManager?.getDebugInfo();
        const perfHud = this.renderer?.quadtreeTileManager?.getPerfHudSnapshot?.() ?? null;

        this.ui.update({
            fps: this._fps,
            cameraMode: this.cameraMode,
            shipState: shipState,
            zoneInfo: zoneInfo,
            playerStatus: this.actorManager?.getPlayerCombatState?.() ?? null,
            perfHud,
        });
    }

    debugSpawnGoblinGroup(options = {}) {
        const ok = this.actorManager?.npcManager?.requestDebugSpawnNearPlayer?.(options) === true;
        if (!ok) {
            Logger.warn('[GameEngine] Debug goblin spawn is disabled or unavailable');
        }
        return ok;
    }

    /**
     * Checkpoint-1 lake-height diagnostic (see CODEX_RIVER_LAKE_HANDOFF.md):
     * samples the resident final height texture at a confirmed lake's
     * center and planned water outline, and compares it to the old
     * standalone naturalElevationNorm probe. Read-only — does not touch
     * LakeWaterSystem. window.lakeHeightDiag() in standalone.html.
     */
    async debugLakeHeightProbe(lakeIndex = 0) {
        const { runLakeHeightDiagnostic } = await import('../core/renderer/lakes/lakeHeightDiagnostic.js');
        return runLakeHeightDiagnostic({
            device: this.renderer?.backend?.device,
            quadtreeGPU: this.renderer?.quadtreeTileManager?.quadtreeGPU,
            tileStreamer: this.renderer?.quadtreeTileManager?.tileStreamer,
            quadtreeTileManager: this.renderer?.quadtreeTileManager,
            planetConfig: this.planetConfig,
            confirmedLakes: this.planetConfig?.terrainGeneration?.erosionSeeds?.confirmed,
            lakeIndex,
        });
    }

    teleportToLatLon(latDeg, lonDeg, options = {}) {
        if (!this.planetConfig || !this.camera) return;

        const radius = this.planetConfig.radius;
        const origin = this.planetConfig.origin || { x: 0, y: 0, z: 0 };
        const fallbackAlt = this.gameDataConfig?.spawn?.height ?? 800;
        const altitude = Number.isFinite(options.altitude) ? options.altitude : fallbackAlt;

        const latRad = (latDeg * Math.PI) / 180;
        const lonRad = (lonDeg * Math.PI) / 180;
        const cosLat = Math.cos(latRad);
        const sinLat = Math.sin(latRad);
        const cosLon = Math.cos(lonRad);
        const sinLon = Math.sin(lonRad);

        const r = radius + altitude;
        const worldX = origin.x + r * cosLat * cosLon;
        const worldY = origin.y + r * sinLat;
        const worldZ = origin.z + r * cosLat * sinLon;

        if (this.spaceship?.reset) {
            // Ship uses Z-up while world uses Y-up; swap Y/Z for follow mode.
            const shipX = worldX;
            const shipY = worldZ;
            const shipZ = worldY;
            this.spaceship.reset(shipX, shipY, shipZ);
        }

        if (this.cameraMode === 'follow') {
            this.camera.follow(this.spaceship);
            this.camera.resetOrbit();
        } else {
            this.camera.setPosition(worldX, worldY, worldZ);
            this.camera.lookAt(origin.x, origin.y, origin.z);
        }
    }

    /**
     * Wayfinding helper: erosion-seed lakes are real-scale (2m carve depth)
     * and easy to miss on a 131km-radius planet even when nearby — hovers
     * the player directly above a confirmed, resident-placement-ready lake
     * instead. window.flyToLake(readyIndex) in standalone.html.
     * @param {number} readyIndex - index into the READY lakes only (0-based).
     * @param {number} hoverAltitudeM - height above the water surface to hover at.
     */
    debugFlyToLake(readyIndex = 0, hoverAltitudeM = 60) {
        const ready = this.renderer?.lakeWaterSystem?.getReadyLakeCenters?.() || [];
        const lake = ready[readyIndex];
        if (!lake) {
            Logger.warn(`[GameEngine] flyToLake(${readyIndex}): no ready lake at that index (${ready.length} ready)`);
            return null;
        }

        const origin = this.planetConfig?.origin || { x: 0, y: 0, z: 0 };
        const originV = new Vector3(origin.x, origin.y, origin.z);
        const centerV = new Vector3(lake.center.x, lake.center.y, lake.center.z);
        const unitDir = new Vector3().subVectors(centerV, originV).normalize();
        const hoverPos = centerV.clone().add(unitDir.multiplyScalar(hoverAltitudeM));

        if (this.spaceship?.reset) {
            // Ship uses Z-up while world uses Y-up; swap Y/Z for follow mode (see teleportToLatLon above).
            this.spaceship.reset(hoverPos.x, hoverPos.z, hoverPos.y);
        }
        if (this.cameraMode === 'follow') {
            this.camera.follow(this.spaceship);
            this.camera.resetOrbit();
        } else {
            this.camera.setPosition(hoverPos.x, hoverPos.y, hoverPos.z);
            this.camera.lookAt(centerV.x, centerV.y, centerV.z);
        }
        Logger.info(`[GameEngine] flew to lake region (${lake.regionX},${lake.regionY}), hovering ${hoverAltitudeM}m above water`);
        return { regionX: lake.regionX, regionY: lake.regionY, center: lake.center };
    }

    /**
     * Water system (core/world/hydrology/WaterService.js): starts in the
     * background once the initial terrain load is done (terrain never waits),
     * then refines lakes near the camera. terrain.waterGraph.enabled.
     */
    _tickWater() {
        if (this.planetConfig?.terrainGeneration?.waterGraph?.enabled !== true) return;
        if (!this.waterService) {
            if (!this.isInitialLoadComplete()) return;
            const terrainGenerator = this.renderer?.quadtreeTileManager?.tileStreamer?.terrainGenerator;
            const device = this.renderer?.backend?.device;
            if (!terrainGenerator || !device) return;
            this.waterService = new WaterService({
                device,
                terrainGenerator,
                planetConfig: this.planetConfig,
                // One GPU sampling dispatch per frame.
                yieldBetween: () => new Promise(resolve => requestAnimationFrame(() => resolve())),
            });
            this.waterService.start();
            // Lakes and rivers drawn in the terrain shading (core/world/water/waterWgsl.js).
            const cfg = this.waterService.config;
            this.waterGpuData = new WaterGpuData(device, {
                gridN: cfg.gridN, planetRadius: this.planetConfig.radius,
                carve: terrainGenerator.waterCarve ? cfg.carve : null,
            });
            this.renderer?.setWaterData?.(this.waterGpuData);
            // River channels carved into tiles generated from now on, and into
            // the simulation's bed (core/world/water/riverCarve.wgsl.js).
            if (terrainGenerator.waterCarve) {
                terrainGenerator.setWaterCarveResources(this.waterGpuData.resources);
                this.waterService.setWaterCarveResources(this.waterGpuData.resources);
                this._waterCarveGenerator = terrainGenerator;
            }
            return;
        }
        this.waterService.update(this.camera?.position);
        const cam = this.camera?.position, origin = this.planetConfig.origin || { x: 0, y: 0, z: 0 };
        if (cam && this.waterGpuData) {
            const rel = { x: cam.x - origin.x, y: cam.y - origin.y, z: cam.z - origin.z };
            this._tickWaterSim(rel);
            this.waterGpuData.update(this.waterService, rel, performance.now() / 1000);
            // Where rivers changed the carve changed: regenerate those tiles in
            // place (tiles still generating with the old data notice the version).
            const changed = this.waterGpuData.takeChangedCells();
            if (changed && this._waterCarveGenerator) {
                this._waterCarveGenerator.markWaterCarveChanged();
                const queued = this.renderer?.quadtreeTileManager?.regenerateTiles?.(tilesTouchingCells(changed, this.waterGpuData.N)) ?? 0;
                Logger.debug(`[Water] rivers changed in ${changed.size} cells: ${queued} resident tiles regenerating`);
            }
        }
    }

    /**
     * Near-field water simulation (core/world/water/WaterSimSite.js), like
     * Whitewater simulating only around the boat: a site follows the camera
     * while it is low and near a lake or river (terrain.waterGraph.sim).
     * Steps in its own submit before the frame renders.
     */
    _tickWaterSim(camRel) {
        const cfg = this.planetConfig?.terrainGeneration?.waterGraph?.sim ?? {};
        const svc = this.waterService, gpu = this.waterGpuData;
        if (cfg.enabled === false || svc?.state !== 'ready' || !gpu?._ready) return;
        const r = Math.hypot(camRel.x, camRel.y, camRel.z) || 1;
        const dir = [camRel.x / r, camRel.y / r, camRel.z / r];
        const altitude = r - this.planetConfig.radius - svc.groundHeightAt(dir);
        const want = altitude < (cfg.activateAltitudeM ?? 400) && gpu.hasWaterNear(dir, cfg.waterSearchM ?? 300);
        let site = this.waterSimSite;
        if (!site) {
            if (!want) return;
            const { enabled: _e, activateAltitudeM: _a, waterSearchM: _w, recenterFraction: _r, ...siteCfg } = cfg;
            site = this.waterSimSite = new WaterSimSite({ device: this.renderer.backend.device, sampler: svc._sampler, waterGpu: gpu, radius: this.planetConfig.radius, config: siteCfg });
            this.renderer?.setWaterSimSite?.(site, gpu.look);
        }
        if (!want) {
            site.deactivate();
            gpu.site = null;
            return;
        }
        const recenter = (cfg.recenterFraction ?? 0.25) * site.n * site.config.dx;
        if (site.state !== 'placing' && (site.state === 'idle' || site.distanceTo(dir) > recenter)) {
            site.place(dir).catch(err => Logger.warn(`[Water] simulation site failed: ${err?.message || err}`));
        }
        if (site.state === 'warming' || site.state === 'running') {
            const device = this.renderer.backend.device;
            const enc = device.createCommandEncoder({ label: 'WaterSimSite' });
            site.encode(enc, performance.now() / 1000);
            device.queue.submit([enc.finish()]);
        }
        gpu.site = site.coverage;
    }

    /** qtDiag.water.carve(): the river carve (core/world/water/riverCarve.wgsl.js) and the in-place tile regeneration it drives. */
    waterCarveStatus() {
        const gen = this.renderer?.quadtreeTileManager?.tileStreamer?.terrainGenerator;
        if (!gen?.waterCarve) return { state: 'off (terrain.waterGraph.enabled or .carve.enabled false)' };
        return {
            state: gen.waterCarveBound ? 'bound' : 'waiting for the water system',
            version: gen.waterCarveVersion ?? 0,
            rivers: this.waterGpuData?._appliedRivers?.size ?? 0,
            regeneration: this.renderer?.quadtreeTileManager?.tileStreamer?.getRegenerationStats?.() ?? null,
        };
    }

    /** qtDiag.water.sim(): the near-field simulation site. */
    waterSimStatus() {
        const site = this.waterSimSite;
        if (!site) return { state: 'none (camera not low near water yet, or terrain.waterGraph.sim.enabled false)' };
        const cam = this.camera?.position, o = this.planetConfig.origin || { x: 0, y: 0, z: 0 };
        const rel = cam ? [cam.x - o.x, cam.y - o.y, cam.z - o.z] : null;
        const l = rel ? Math.hypot(...rel) : 1;
        return {
            state: site.state, fade: +site.fade.toFixed(2), cells: site.n, dx: site.config.dx,
            sizeM: site.n * site.config.dx, cameraOffsetM: rel ? +site.distanceTo(rel.map(v => v / l)).toFixed(0) : null,
        };
    }

    /**
     * qtDiag.water.tint(mode): 0 water; 1 lakes coloured by id, rivers red;
     * 2 as 1 plus grid cells: lake cells blue, cells with traced river
     * segments red, graph river cells not traced yet orange; 3 water depth.
     */
    setWaterDebugMode(mode = 0) {
        if (!this.waterGpuData) return null;
        this.waterGpuData.debugMode = mode | 0;
        return this.waterGpuData.debugMode;
    }

    /** qtDiag.water.look({ deepColor, reflection, absorption, rippleFadeM, shoreSoftM, enabled }) */
    setWaterLook(look = {}) {
        if (!this.waterGpuData) return null;
        const { enabled, ...rest } = look;
        if (enabled !== undefined) this.waterGpuData.enabled = !!enabled;
        Object.assign(this.waterGpuData.look, rest);
        return { enabled: this.waterGpuData.enabled, ...this.waterGpuData.look };
    }

    /** qtDiag.water.stats() */
    waterSummary() {
        return this.waterService?.summary() ?? { state: 'off (terrain.waterGraph.enabled false, or not started yet)' };
    }

    /** qtDiag.water.near(n): lakes nearest the camera. */
    waterLakesNear(count = 10) {
        const svc = this.waterService;
        if (svc?.state !== 'ready' || !this.camera?.position) return [];
        return svc.lakesNear(this.camera.position, count).map(({ lake, distanceM }) => {
            const r = svc.refined.get(lake.id);
            return {
                id: lake.id, distanceKm: +(distanceM / 1000).toFixed(2),
                levelM: +(r?.level ?? lake.level).toFixed(1), graphLevelM: +lake.level.toFixed(1),
                areaKm2: r ? +(r.areaM2 / 1e6).toFixed(2) : null, maxDepthM: +(r?.maxDepth ?? lake.maxDepth).toFixed(0),
                refined: !!r, river: lake.river >= 0,
                downstream: (r?.downstream ?? lake.downstream)?.type === 'lake' ? `lake ${(r?.downstream ?? lake.downstream).id}` : 'sea',
            };
        });
    }

    /**
     * qtDiag.water.goto(lakeId): free camera hovering over a lake, looking
     * across it. Switch back with the camera-mode key.
     */
    gotoWaterLake(lakeId, hoverAltitudeM = 300) {
        const svc = this.waterService;
        const lake = svc?.lakes?.[svc.rep(lakeId)];
        if (!lake || !this.camera) {
            Logger.warn(`[GameEngine] water lake ${lakeId} not available (water state: ${svc?.state ?? 'off'})`);
            return null;
        }
        const r = svc.refined.get(lake.id);
        const level = r?.level ?? lake.level;
        const R = this.planetConfig.radius;
        const origin = this.planetConfig.origin || { x: 0, y: 0, z: 0 };
        const c = lake.centreDir, e1 = lake.frame.e1;
        const eye = R + level + hoverAltitudeM;
        // Look 2 km across the lake, at its level.
        const lookDir = new Vector3(c[0] + e1[0] * 2000 / R, c[1] + e1[1] * 2000 / R, c[2] + e1[2] * 2000 / R).normalize();
        if (this.cameraMode !== 'manual') {
            this.cameraMode = 'manual';
            this.camera.unfollow?.();
        }
        this.camera.setPosition(origin.x + c[0] * eye, origin.y + c[1] * eye, origin.z + c[2] * eye);
        this.camera.lookAt(origin.x + lookDir.x * (R + level), origin.y + lookDir.y * (R + level), origin.z + lookDir.z * (R + level));
        Logger.info(`[GameEngine] water lake ${lake.id}: level ${level.toFixed(1)} m${r ? '' : ' (graph level, not refined yet)'}, camera ${hoverAltitudeM} m above`);
        return { id: lake.id, level, refined: !!r };
    }

    async setTerrainDebugMode(mode) {
        const debug = this.engineConfig?.debug;
        if (!debug || !Number.isFinite(mode)) return;
        const nextMode = Math.max(0, Math.floor(mode));
        const { generatorMode, fragmentMode } = this._resolveTerrainDebugModes(nextMode);
        const previousGeneratorMode = debug.terrainGeneratorDebugMode ?? 0;

        debug.terrainGeneratorDebugMode = generatorMode;
        debug.terrainFragmentDebugMode = fragmentMode;

        this.terrainGenerator?.setDebugMode?.(generatorMode);
        await this.renderer?.setTerrainDebugMode?.(fragmentMode);
        if (previousGeneratorMode !== generatorMode) {
            this.renderer?.refreshTerrainTiles?.();
        }
        this.ui?.updateDebugModeDisplay(nextMode, this._getTerrainDebugModeName(nextMode));
    }

    _resolveTerrainDebugModes(mode) {
        // 90-99 reserved for fragment-only diagnostics (mode 90: geometryLOD
        // color, 91-95: NdotL/worldNormal/detailNormal/normalMapBlend/
        // lightDirection — see terrainChunkFragmentShaderBuilder.js; 99 was
        // already named 'Fragment Test' below but this upper bound excluded
        // it too before this fix). 100-109: LOD4/5 seam investigation
        // (100: edge highlight, 101: distance gradient, 102: force LOD4
        // through LOD5's resolvedColor path) — extended range for the same
        // reason 90-99 was reserved.
        if ((mode >= 25 && mode <= 89) || (mode >= 90 && mode <= 109)) {
            return { generatorMode: 0, fragmentMode: mode };
        }
        if (mode === 0) {
            return { generatorMode: 0, fragmentMode: 0 };
        }
        return { generatorMode: mode, fragmentMode: 30 };
    }

    _getTerrainDebugModeName(mode) {
        const names = {
            0: 'Normal',
            25: 'Splat Grid + Weight',
            26: 'Splat BiomeA',
            27: 'Splat BiomeB',
            28: 'Tile Category',
            29: 'Splat Pair Change Mask',
            30: 'Raw Height',
            31: 'Splat Raw Weight',
            32: 'Splat Bilinear Valid',
            33: 'Fallback / Stitch Risk',
            34: 'Atlas Bleed Risk',
            35: 'LOD Edge Fade',
            36: 'Resolved Color',
            37: 'Non-Resolved Color',
            38: 'Resolved vs Non-Resolved',
            39: 'Resolved Color + Chunk Grid',
            40: 'Resolved Color Mip0',
            41: 'Resolved Implicit vs Mip0',
            42: 'Resolved Nearest Mip0',
            43: 'Base Before Macro',
            44: 'Base After Macro',
            45: 'Final Albedo Before Lighting',
            46: 'Path Diagnostic (splat/prebake/raw)',
            47: 'Splat Category Blend',
            48: 'Splat Reconstruction Delta',
            49: 'Stored Splat Texel Blend',
            50: 'Stored Splat Minority Heat',
            51: 'Forced Fast Splat Blend',
            52: 'Forced Union Splat Blend',
            53: 'Tile vs Splat Dominant',
            54: 'Splat ID-Slot Validity',
            55: 'Prod vs Union Weight Delta',
            56: 'Prod vs Union Material Delta',
            57: 'Fast vs Union Weight Delta',
            58: 'Fast vs Union Material Delta',
            59: 'Splat ID-Set Mismatch Type',
            60: 'Splat Dominant Verdict',
            61: 'Production Full Material',
            62: 'Union Full Material',
            63: 'Forced Fast Full Material',
            64: 'Stored Splat Full Material',
            65: 'Production Shortcut Delta',
            66: 'Validity Texture Agreement',
            67: 'Delta Branch Attribution',
            68: 'Union Minority Luma Effect',
            69: 'Union vs Raw Tile Delta',
            70: 'Splat Reconstruction Verdict',
            71: 'Pre-Fog Lit Color',
            72: 'Normal Lighting Delta',
            73: 'Lit No Shadow/AO',
            74: 'Shadow Factor Heat',
            75: 'AO Factor Heat',
            76: 'Raw AO Mask Heat',
            77: 'Post-Fade AO Heat',
            78: 'AO Neutral Fade',
            79: 'Splat AO Fade',
            80: 'LOD Edge AO Fade',
            81: 'Aerial/Fog Delta Heat',
            82: 'Lighting Delta Heat',
            87: 'Union Fallback Only',
            88: 'Union Fast Only',
            89: 'BilinearValid Branch Map',
            99: 'Fragment Test'
        };
        return names[mode] ?? 'Debug';
    }

    setupAudioInput(pitchCallback) {
        this.altitudeController.setupPitchInput(pitchCallback);
    }

    onPitchDetected(noteEvent, intensity) {
        this.altitudeController.onPitchEvent(noteEvent, intensity);
    }

    handleResize() {
        if (this._renderInFlight) {
            this._resizePending = true;
            return;
        }

        const result = updateCanvasResolution(this.canvas);

        if (result.changed) {
            this._applyResize(result.width, result.height);
        }
    }

    _applyResize(width, height) {
        const safeWidth = Math.max(1, Math.floor(width));
        const safeHeight = Math.max(1, Math.floor(height));
        const aspect = safeWidth / safeHeight;

        if (this.camera) {
            this.camera.aspect = aspect;
        }

        if (this.renderer?.handleResize) {
            this.renderer.handleResize(safeWidth, safeHeight);
        } else if (this.renderer?.backend) {
            this.renderer.backend.setViewport(0, 0, safeWidth, safeHeight);
        }
    }

    getStats() {
        return {

        };
    }

    printPlanetConfig() {
        if (!this.planetConfig) {
            return;
        }
    }

    // ── Game-specific overridable hooks ────────────────────────────────
    // These exist so subclasses (platform_game, future games) can opt out
    // of wizard_game ambiance without forking the entire engine shell.

    /** Build the HUD. Subclasses return their own UI implementation. */
    _createGameUI() {
        return new GameUI();
    }

    /**
     * Register per-spawn ambient effects (campfire, fireflies, distortion).
     * Wizard_game default: the campfire + firefly package the player needs
     * to survive the night. Subclasses can override to return a no-op.
     */
    _registerAmbiance({ spawnX, spawnY, spawnZ }) {
        if (!this.renderer?.particleSystem) return;
        const actorManager = this.actorManager;
        const campfireEmitter = this.renderer.particleSystem.addCampfire(
            { x: spawnX, y: spawnY, z: spawnZ },
            { getActor: () => actorManager?.playerActor, snapSettleFrames: 30 }
        );
        this.renderer.particleSystem.addCampfireCoals(
            { x: spawnX, y: spawnY, z: spawnZ },
            { getActor: () => actorManager?.playerActor, snapSettleFrames: 30 }
        );
        Logger.info('[GameEngine] Campfire + coal emitters registered at spawn');

        this.renderer.addDistortionSource({
            type: 'heatHaze',
            position: { x: spawnX, y: spawnY, z: spawnZ },
            getPosition: () => campfireEmitter?.position,
            distanceCutoff: this.engineConfig.rendering?.distortion?.sourceCutoffs?.campfire ?? 10.0,
        });

        const leafFall = this.gameDataConfig.particleAuthoring?.ambientEmitters?.leafFall;
        const leafEmitters = leafFall?.enabled !== false && Array.isArray(leafFall?.emitters)
            ? leafFall.emitters
            : [];
        const getActor = () => actorManager?.playerActor;
        if (leafFall?.enabled !== false && leafFall?.source === 'detailed_leaf_anchors') {
            const assetStreamer = this.renderer.assetStreamer || null;
            const treeDetailSystem = assetStreamer?.getTreeDetailSystem?.()
                ?? assetStreamer?._treeDetailSystem
                ?? null;
            const templateLibrary = assetStreamer?.getTreeTemplateLibrary?.()
                ?? assetStreamer?._templateLibrary
                ?? null;
            this.renderer.particleSystem.setLeafAnchorSource({
                treeDetailSystem,
                templateLibrary,
                config: leafFall.anchorSelection,
            });
            Logger.info(
                `[GameEngine] Leaf fall registered from particle authoring ` +
                `(source=detailed_leaf_anchors, maxEmitters=${leafFall.anchorSelection?.maxEmitters ?? 0})`
            );
        } else {
            for (const off of leafEmitters) {
                this.renderer.particleSystem.addLeafEmitter(
                    { x: spawnX, y: spawnY, z: spawnZ },
                    {
                        getActor,
                        snapSettleFrames: 30,
                        surfaceOffset: off,
                        heightOffset: off.heightOffset,
                        spawnBudgetPerFrame: off.spawnBudgetPerFrame,
                    }
                );
            }
        }
        if (leafFall?.source !== 'detailed_leaf_anchors' && leafEmitters.length > 0) {
            Logger.info(
                `[GameEngine] Leaf emitters registered from particle authoring ` +
                `(${leafEmitters.length}, source=${leafFall?.source ?? 'spawn_offsets'})`
            );
        }

        this.renderer.particleSystem.addFireflySwarm(
            { x: spawnX + 2, y: spawnY + 2, z: spawnZ + 2 },
            {
                swarmSize: 10,
                getActor: () => actorManager?.playerActor,
                snapSettleFrames: 30,
                followSideOffset: 2.5,
                followHeightOffset: 2.0,
            }
        );
        Logger.info('[GameEngine] Firefly swarm registered near player');
    }

    /** Register NPC manager. Subclasses can override to skip or plug in their own. */
    async _registerNPCs() {
        try {
            const { NPCManager } = await import('./actors/NPCManager.js');
            const { DEFAULT_NPC_SPAWN_CONFIG } = await import('./actors/NPCSpawnConfig.js');
            const npcManager = new NPCManager(this.actorManager, DEFAULT_NPC_SPAWN_CONFIG);
            await npcManager.initialize();
            this.actorManager.setNPCManager(npcManager);
            Logger.info('[GameEngine] NPC spawning system initialized');
        } catch (e) {
            Logger.warn(`[GameEngine] NPC system init failed: ${e?.message || e}`);
        }
    }

    /**
     * Overridable hook — subclasses (e.g. platform_game) return a custom
     * ActorManager (with their own player controller + rendering).
     * Must be synchronous; gets all the wiring as an options object.
     */
    _createActorManager(options) {
        const { ActorManager } = this._actorManagerCtor ?? {};
        if (!ActorManager) {
            // The default path dynamically imports ActorManager above and
            // captures the ctor here before this hook is called.
            throw new Error('_createActorManager: no ActorManager ctor captured');
        }
        return new ActorManager(options);
    }
}


window.planetInfo = () => {
    if (window.gameEngine) {
        window.gameEngine.printPlanetConfig();
    }
};
