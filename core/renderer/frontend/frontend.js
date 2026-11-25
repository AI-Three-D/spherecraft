import { Vector3, Matrix4, Color } from '../../../shared/math/index.js';
import { WebGPUBackend } from '../backend/webgpuBackend.js';

import { UniformManager } from '../../lighting/uniformManager.js';
import { ClusteredLightManager } from '../../lighting/clusteredLightManager.js';
import { ClusterGrid } from '../../lighting/clusterGrid.js';

import { GenericMeshRenderer } from '../mesh/genericMeshRenderer.js';
import { LightingController } from '../../lighting/lightingController.js';
import { Logger} from '../../../shared/Logger.js'
import { WeatherController } from '../environment/WeatherController.js';
import { buildStreamerAuthoringRuntime } from '../../world/streamerAuthoringRuntime.js';
import { computeSurfaceTangentFrame } from '../../planet/surfaceFrame.js';

import { Renderer } from '../Renderer.js';
import { PostProcessingPipeline, HDR_FORMAT } from '../postprocessing/PostProcessingPipeline.js';
import { HeatHazeEmitter } from '../particles/HeatHazeEmitter.js';
import {  requireObject } from '../../../shared/requireUtil.js';
export class Frontend {
    constructor(canvas, options = {}) {

        this.skinnedMeshRenderer = null;
        this._instancingLogInterval = 120; // Log every N frames
        this._instancingLogFrame = 0;
        this.canvas = canvas;
        this.lightingController = new LightingController();
        this.backend = null;
        this.engineConfig = options.engineConfig || null;
        this.lightingController.applyConfig(this.engineConfig?.rendering?.lighting?.sun);
        this._streamerTheme = options.streamerTheme || null;
        this._nightSkyTheme = options.nightSkyTheme || null;
        this._terrainTheme = options.terrainTheme || null;
        this._particleAuthoring = options.particleAuthoring || null;
        this.gpuQuadtreeConfig = options.gpuQuadtree || this.engineConfig?.gpuQuadtree || null;
        this.gpuQuadtreeEnabled = this.gpuQuadtreeConfig?.enabled === true;
        this.terrainModule = null;
        this.rendererCore = null;
        this.textureManager = options.textureManager;
        this.propTextureManager = options.propTextureManager || null;  // NEW
        this.leafAlbedoTextureManager = options.leafAlbedoTextureManager || null;
        this.leafNormalTextureManager = options.leafNormalTextureManager || null;

        this.textureCache = options.textureCache;
        this.uniformManager = new UniformManager();
        this.uniformManager.applyAmbientConfig(this.engineConfig?.rendering?.lighting?.ambient);
        this.uniformManager.applyFogConfig(this.engineConfig?.rendering?.lighting?.fog);
        this.genericMeshRenderer = null;

        this.camera = {
            position: new Vector3(0, 50, 0),
            target: new Vector3(0, 0, 0),
            near: 0.1,
            far: 100000,
            fov: 75,
            aspect: canvas.width / canvas.height,
            matrixWorldInverse: new Matrix4(),
            projectionMatrix: new Matrix4()
        };

        this.frameCount = 0;
        this.debugMode = false;


        this._validationScopeInterval = Number.isFinite(options.validationScopeInterval)
            ? Math.max(1, Math.floor(options.validationScopeInterval))
            : 120;
        this._lastDeltaTime = 0;

        this.particleSystem = null;
        this.atmoBankSystem = null;
        this.postProcessing = null;
        this.heatHazeEmitter = null;
        this._currentEnvironmentState = null;
    }

    getBackend() {
        return this.backend;
    }

    _getAtmoBankFeatureFlags() {
        const features = this.engineConfig?.features ?? {};
        return {
            cloudParticles: features.cloudParticles !== false,
            fogParticles: features.fogParticles !== false,
        };
    }

    _shouldInitializeAtmoBankSystem() {
        if (this.engineConfig?.features?.skyEffects === false) return false;
        const flags = this._getAtmoBankFeatureFlags();
        return flags.cloudParticles || flags.fogParticles;
    }

    setActorManager(mgr) { this._actorManager = mgr; }

    // Compatibility views for existing game tools. TerrainModule owns these resources.
    get quadtreeTileManager() { return this.terrainModule?.source ?? null; }
    get quadtreeTerrainRenderer() { return this.terrainModule?.renderer ?? null; }
    get globalOceanRenderer() { return this.terrainModule?.ocean ?? null; }
    get lakeWaterSystem() { return this.terrainModule?.lakes ?? null; }
    get nearWaterRenderer() { return this.terrainModule?.nearWater ?? null; }


    setWaterData(data) {
        this._waterData = data ?? null;
        this.terrainModule?.setWaterData(this._waterData);
    }

    addDistortionSource(options = {}) {
        const type = options?.type ?? 'heatHaze';
        if (type === 'heatHaze') {
            return this.heatHazeEmitter?.addSource(options) ?? null;
        }
        Logger.warn(`[Frontend] Unsupported distortion source type: ${type}`);
        return null;
    }

    removeDistortionSource(sourceOrId) {
        return this.heatHazeEmitter?.removeSource(sourceOrId) ?? false;
    }

    // Compatibility wrapper for simple static heat distortion sources.
    addHeatSource(position, options = {}) {
        return this.addDistortionSource({
            type: 'heatHaze',
            position,
            ...options,
        });
    }

    _getRenderViewportSize() {
        const viewport = this.backend?._viewport;
        const width = viewport?.width || this.canvas?.width || 0;
        const height = viewport?.height || this.canvas?.height || 0;
        return { width, height };
    }

    _dispatchActorCompute(encoder) {
        if (!this._actorManager) return;

        const click = this._actorManager._pendingScreenClick;
        if (click) {
            const viewport = this._getRenderViewportSize();
            if (viewport.width > 0 && viewport.height > 0) {
                this._actorManager.handleScreenClick(
                    click.x,
                    click.y,
                    this.camera,
                    viewport.width,
                    viewport.height,
                    encoder
                );
                this._actorManager._pendingScreenClick = null;
            }
        }

        this._actorManager.dispatchCompute(encoder);
    }

    isGPUQuadtreeActive() {
        return !!this.quadtreeTileManager?.isReady?.();
    }

    get loadedChunks() {
        return this.masterChunkLoader?.loadedChunks || new Map();
    }

    get terrainMeshManager() {
        return this.masterChunkLoader?.terrainMeshManager || null;
    }

    async initializeGPUQuadtree(terrainGenerator) {
        if (!this.gpuQuadtreeEnabled || this.terrainModule) return;
        if (!this.rendererCore || !terrainGenerator) throw new Error('Terrain requires an initialized renderer and terrainGenerator');
        const { PlanetTerrainModule } = await import('../../world/PlanetTerrainModule.js');
        const terrain = new PlanetTerrainModule({
            backend: this.backend,
            engineConfig: this.engineConfig,
            planetConfig: this.planetConfig,
            terrainGenerator,
            textureManager: this.textureManager,
            uniformManager: this.uniformManager,
            terrainAODefaults: this._streamerTheme.TERRAIN_AO_CONFIG,
            groundFieldDefaults: this._streamerTheme.GROUND_FIELD_BAKE_CONFIG,
            tileCategories: this._terrainTheme.TILE_CATEGORIES,
            atmosphereLUT: this.atmosphereLUT,
        });
        terrain.setWaterData(this._waterData ?? null);
        await this.rendererCore.addModule(terrain);
        this.terrainModule = terrain;

        // Asset streamer: modular multi-category GPU scatter system
        // (trees, ground cover, plants — replaces single-purpose GrassRenderer)
        if (this.engineConfig?.features?.streamedAssets === false) {
            Logger.info('[Frontend] Asset streamer disabled by features.streamedAssets');
        } else
        try {
            const { AssetStreamer } = await import('../streamer/AssetStreamer.js');
            const streamerAuthoringRuntime = buildStreamerAuthoringRuntime(
                this.planetConfig?.worldAuthoring,
                {
                    assetDefinitions: this._streamerTheme.DEFAULT_ASSET_DEFINITIONS,
                    archetypeDefinitions: this._streamerTheme.ARCHETYPE_DEFINITIONS,
                    tileCategories: this._terrainTheme?.TILE_CATEGORIES,
                }
            );
            if (streamerAuthoringRuntime.summary.appliedProfileCount > 0) {
                Logger.info(
                    `[AssetAuthoring] Applied ${streamerAuthoringRuntime.summary.appliedProfileCount}/` +
                    `${streamerAuthoringRuntime.summary.profileCount} authored asset profiles ` +
                    'to streamer placement'
                );
            }
            if (streamerAuthoringRuntime.summary.clusterTreeAuthoredTileCount > 0) {
                Logger.info(
                    `[AssetAuthoring] Authored cluster tree metadata covers ` +
                    `${streamerAuthoringRuntime.summary.clusterTreeAuthoredTileCount} tile types`
                );
            }
            if (streamerAuthoringRuntime.summary.unsupportedProfileCount > 0) {
                Logger.warn(
                    `[AssetAuthoring] ${streamerAuthoringRuntime.summary.unsupportedProfileCount} ` +
                    'asset profiles use unsupported archetype refs'
                );
            }
            this.assetStreamer = new AssetStreamer({
                device:         this.backend.device,
                backend:        this.backend,
                quadtreeGPU:    this.quadtreeTileManager.quadtreeGPU,
                tileStreamer:   this.quadtreeTileManager.tileStreamer,
                planetConfig:   this.planetConfig,
                engineConfig:   this.engineConfig,
                uniformManager: this.uniformManager,
                streamerTheme:  this._streamerTheme,
                assetDefinitions: streamerAuthoringRuntime.assetDefinitions,
                archetypeDefinitions: streamerAuthoringRuntime.archetypeDefinitions,
                clusterTreeTileMetadata: streamerAuthoringRuntime.clusterTreeTileMetadata,
                propTextureManager: this.propTextureManager,
                leafAlbedoTextureManager: this.leafAlbedoTextureManager,
                leafNormalTextureManager: this.leafNormalTextureManager,
                quality:        'medium',
                debug: {
                    enabled: false,
                    readback: false,
                    interval: 120,
                    warnIfNoPlants: true,
                    forceVisible: false,
                    drawSingle: false,
                    drawSample: false,
                    drawDirect: false
                }
            });
            await this.assetStreamer.initialize();
            // Optional asset bakes attach AO/ground-field textures to the source.
            // Rebind materials while keeping terrain geometry and world ownership intact.
            await this.quadtreeTerrainRenderer.rebuildMaterials();
        } catch (e) {
            Logger.warn(`[Frontend] Asset streamer init failed: ${e?.message || e}`);
            this.assetStreamer = null;
        }

        if (this.engineConfig?.features?.shadows !== false) await this._maybeInitGPUShadows();
        this.atmoBankSystem?.setTileStreamer(this.quadtreeTileManager.tileStreamer);
    }

    async setTerrainDebugMode(mode) {
        const debug = this.engineConfig?.debug;
        if (!debug) return;
        debug.terrainFragmentDebugMode = mode;
        if (this.quadtreeTerrainRenderer?._materials) {
            for (const mat of this.quadtreeTerrainRenderer._materials.values()) {
                if (mat?.uniforms?.terrainDebugMode) {
                    mat.uniforms.terrainDebugMode.value = mode;
                }
            }
        } else if (this.quadtreeTerrainRenderer) {
            await this.quadtreeTerrainRenderer.rebuildMaterials();
        }
    }

    refreshTerrainTiles() {
        this.quadtreeTileManager?.refreshTiles?.();
    }

    toggleTerrainManualDiagnosticSnapshot(reason = 'manual') {
        return this.quadtreeTileManager?.toggleManualDiagnosticSnapshot?.(reason) ?? null;
    }

    getTerrainManualDiagnosticState() {
        return this.quadtreeTileManager?.getManualDiagnosticState?.() ?? null;
    }

    isTerrainManualDiagnosticFrozen() {
        return this.quadtreeTileManager?.isManualDiagnosticFrozen?.() === true;
    }

    getInitialLoadStatus() {
        return this.quadtreeTileManager?.getInitialLoadStatus?.() ?? null;
    }

    async updateChunks(gameState, environmentState, deltaTime, planetConfig, sphericalMapper) {
        if (this.uniformManager) {
            this.uniformManager.currentEnvironmentState = environmentState;
        }

        if (this.uniformManager) {
            this.uniformManager.updateFromEnvironmentState(environmentState);
        }

    }


    async initialize(planetConfig = null, sphericalMapper = null, options = {}) {
        this.planetConfig = planetConfig;
        this.sphericalMapper = sphericalMapper;
        if (!navigator.gpu) {
            throw new Error('[Frontend] WebGPU not available in this browser.');
        }

        this.backend = new WebGPUBackend(this.canvas, { optionalFeatures: ['shader-f16'] });
        await this.backend.initialize();
        // Set HDR scene format immediately so all renderers compile
        // their pipelines against rgba16float, not the canvas format.
        this.backend.sceneFormat = HDR_FORMAT;
        this.rendererCore = new Renderer({ canvas: this.canvas, backend: this.backend, backendInitialized: true });
        await this.rendererCore.initialize();

        if (this.backend && this.backend._pipelineCache) {
            this.backend._pipelineCache.clear();
        }

        if (this.backend?.device) {
            const limits = this.backend.device.limits;
            Logger.info(
                `[Frontend] WebGPU limits: ` +
                `maxBindGroups=${limits.maxBindGroups} ` +
                `maxBindingsPerBindGroup=${limits.maxBindingsPerBindGroup} ` +
                `maxStorageBufferBindingSize=${limits.maxStorageBufferBindingSize} ` +
                `maxStorageBuffersPerShaderStage=${limits.maxStorageBuffersPerShaderStage}`
            );
        }

        if (!this.backend) {
            throw new Error('[Frontend] Failed to initialize WebGPU backend.');
        }

        this.backend.setViewport(0, 0, this.canvas.width, this.canvas.height);
        this.genericMeshRenderer = new GenericMeshRenderer(this.backend);

        if (this.planetConfig && this.planetConfig.hasAtmosphere) {
            this.uniformManager.updateFromPlanetConfig(this.planetConfig);
            this.atmosphereSettings = requireObject(
                this.planetConfig.atmosphereSettings,
                'planetConfig.atmosphereSettings'
            );

            const { AtmosphericScatteringLUT } = await import('../atmosphere/atmosphericScatteringLUT.js');
            this.atmosphereLUT = await AtmosphericScatteringLUT.create(
                this.backend,
                this.uniformManager
            );
            this.atmosphereLUT.update();

            if (this.engineConfig?.features?.skyEffects !== false) {
                const { SkyRenderer } = await import('../sky/SkyRenderer.js');
                const spaceLODThreshold = 1000;
                this.skyRenderer = new SkyRenderer(this.backend, this.atmosphereLUT, {
                    spaceLODThreshold,
                    nightSkyTheme: this._nightSkyTheme,
                    colorContrast: this.engineConfig?.rendering?.skyColorContrast,
                });
                await this.skyRenderer.initialize();
            }
        }

        if (this.engineConfig?.features?.skyEffects !== false) {
            const { StarRenderer } = await import('../sky/StarRenderer.js');
            this.starRenderer = new StarRenderer(this.backend);
            await this.starRenderer.initialize();

            const { MoonRenderer } = await import('../sky/MoonRenderer.js');
            this.moonRenderer = new MoonRenderer(this.backend);
            await this.moonRenderer.initialize();
        } else {
            Logger.info('[Frontend] Sky effects disabled by features.skyEffects');
        }

        if (this.engineConfig?.features?.clouds !== false) {
            const features = this.engineConfig?.features ?? {};
            const cloudConfig = {
                cloudAnisotropy: 0.75,
                cirrusQuality: 'high',
                lowClouds: features.lowClouds !== false,
                midClouds: features.midClouds !== false,
                highClouds: features.highClouds !== false,
            };
            const { WebGPUCloudRenderer } = await import('../clouds/webgpuCloudRenderer.js');
            this.cloudRenderer = new WebGPUCloudRenderer(this.backend, cloudConfig);
            await this.cloudRenderer.initialize();
            if (this.planetConfig) {
                this.cloudRenderer.setPlanetConfig(this.planetConfig);
            }
            this.cloudRenderer.enabled = true;
        } else {
            Logger.info('[Frontend] Cloud layers (cirrus) disabled by features.clouds');
        }

        const weatherConfig = options.weatherConfig || {};
        this.weatherController = new WeatherController(this.backend, weatherConfig);
        await this.weatherController.initialize();

        if (this.atmosphereLUT) {
            const { AerialPerspectiveTest } = await import('../../../tools/aerialPerspectiveTest.js');
            this.aerialTest = new AerialPerspectiveTest(
                this.backend,
                this.uniformManager,
                this.atmosphereLUT
            );
            await this.aerialTest.initialize();
        }
        if (this.engineConfig?.features?.clusteredLighting !== false) {
            this.clusterGrid = new ClusterGrid({
                gridSizeX: 16, gridSizeY: 8, gridSizeZ: 24,
                useLogarithmicDepth: true
            });
            this.lightManager = new ClusteredLightManager(this.clusterGrid, {
                maxLightsPerCluster: 32,
                maxLightIndices: 8192
            });
            if (this.backend?.device) {
                const { ClusteredLightBuffers } =
                    await import('../../lighting/ClusteredLightBuffers.js');
                this.clusterLightBuffers = new ClusteredLightBuffers(
                    this.backend.device,
                    this.clusterGrid,
                    128   // maxLights
                );
            } else {
                this.clusterLightBuffers = null;
            }
        } else {
            Logger.info('[Frontend] Clustered lighting disabled by features.clusteredLighting');
        }

        if (this.backend?.device) {
            // Initialize HDR postprocessing pipeline.
            const vp = this.backend._viewport;
            this.postProcessing = new PostProcessingPipeline(this.backend.device, {
                width: vp.width,
                height: vp.height,
                outputFormat: this.backend.format,
            });
            this.postProcessing.initialize();

            if (this.engineConfig?.features?.volumetricClouds === false) {
                Logger.info('[Frontend] Volumetric clouds disabled by features.volumetricClouds');
            } else if (this.atmosphereSettings) {
                await this._initVolumetricClouds();
            }

            // Heat haze distortion emitter (renders into the distortion map).
            this.heatHazeEmitter = new HeatHazeEmitter(this.backend.device, {});
            this.heatHazeEmitter.initialize('depth24plus');

            const ambientParticles = this.engineConfig?.features?.particles !== false;
            this._weatherParticlesOnly = !ambientParticles && this.engineConfig?.features?.rainParticles === true;
            if (ambientParticles || this._weatherParticlesOnly) {
                const { ParticleSystem } = await import('../particles/ParticleSystem.js');
                this.particleSystem = new ParticleSystem({
                    device: this.backend.device,
                    backend: this.backend,
                    colorFormat: HDR_FORMAT,
                    depthFormat: 'depth24plus',
                    particleAuthoring: this._particleAuthoring,
                });
                await this.particleSystem.initialize();
                if (this.planetConfig) {
                    this.particleSystem.setPlanetConfig(this.planetConfig);
                }
                if (this.lightManager) {
                    this.particleSystem.setLightManager(this.lightManager);
                }
            } else {
                Logger.info('[Frontend] Particles disabled by features.particles');
            }

            if (this._shouldInitializeAtmoBankSystem()) {
                const atmoBankFeatureFlags = this._getAtmoBankFeatureFlags();
                const { AtmoBankSystem } = await import('../atmosphere-banks/AtmoBankSystem.js');
                this.atmoBankSystem = new AtmoBankSystem({
                    device: this.backend.device,
                    backend: this.backend,
                    colorFormat: HDR_FORMAT,
                    depthFormat: 'depth24plus',
                    atmoBankAuthoring: this.planetConfig?.atmoBankAuthoring,
                    tileCategories: this.planetConfig?.tileCatalog?.tileCategories ??
                        this.planetConfig?.worldAuthoring?.tileCatalog?.tileCategories,
                    biomeDefinitions: this.planetConfig?.biomeDefinitions ?? this.planetConfig?.worldAuthoring?.biomes,
                    featureFlags: atmoBankFeatureFlags,
                    renderConfig: this.engineConfig?.rendering?.atmoBankParticles,
                });
                await this.atmoBankSystem.initialize();
                // Bank particles shape themselves with cloud noise; the cirrus renderer supplies it each
                // frame, the volumetric module's volumes stand in when cirrus is off.
                const cloudNoise = !this.cloudRenderer && this.volumetricClouds?.getNoiseViews();
                if (cloudNoise) this.atmoBankSystem.setNoiseTextures(cloudNoise.shape, cloudNoise.detail);
                if (this.quadtreeTileManager?.tileStreamer) {
                    this.atmoBankSystem.setTileStreamer(this.quadtreeTileManager.tileStreamer);
                    Logger.info('[AtmoBank] GPU tile streamer linked');
                }
                if (typeof window !== 'undefined') {
                    window.atmoBankDiag = () => this.atmoBankSystem?.getDiagnostics?.() ?? null;
                }
            } else if (this.engineConfig?.features?.skyEffects !== false) {
                Logger.info('[Frontend] Atmospheric bank particles disabled by features.cloudParticles/features.fogParticles');
            }
        }

        if (this.engineConfig?.features?.shadows !== false) await this._maybeInitGPUShadows();

        this.uniformManager.uniforms.ambientLightIntensity.value = 0.8;
        this.uniformManager.uniforms.ambientLightColor.value.set(0xffffff);
        this.uniformManager.uniforms.skyAmbientColor.value.set(0x87ceeb);
        this.uniformManager.uniforms.groundAmbientColor.value.set(0x8b7355);
        this.uniformManager.uniforms.sunLightIntensity.value = 1.0;
        this.uniformManager.uniforms.sunLightColor.value.set(0xffffff);
        this.uniformManager.uniforms.sunLightDirection.value.set(0.5, 1.0, 0.3).normalize();


        if (this.engineConfig?.features?.actors !== false) {
            const { SkinnedMeshRenderer } = await import('../mesh/SkinnedMeshRenderer.js');
            this.skinnedMeshRenderer = new SkinnedMeshRenderer({
                backend: this.backend,
                uniformManager: this.uniformManager,
            });
            await this.skinnedMeshRenderer.initialize();
            this.skinnedMeshRenderer.setClusterLightBuffers(this.clusterLightBuffers);
            this.skinnedMeshRenderer.setShadowRenderer(this.gpuShadowRenderer);
        } else {
            Logger.info('[Frontend] Actors disabled by features.actors');
        }

        return this;
    }


    _makeSurfaceMatrix(worldPos, planetOrigin, scale) {
        const { up, right, forward } = computeSurfaceTangentFrame(worldPos, planetOrigin);

        const m = new Matrix4();
        const e = m.elements;
        // col 0 — right
        e[0] = right.x * scale;   e[1] = right.y * scale;   e[2] = right.z * scale;   e[3] = 0;
        // col 1 — up (surface normal)
        e[4] = up.x * scale;      e[5] = up.y * scale;      e[6] = up.z * scale;      e[7] = 0;
        // col 2 — forward
        e[8] = forward.x * scale; e[9] = forward.y * scale;  e[10] = forward.z * scale; e[11] = 0;
        // col 3 — position
        e[12] = worldPos.x;       e[13] = worldPos.y;        e[14] = worldPos.z;        e[15] = 1;
        return m;
    }
    _computeGLBWorldMatrix(options) {
        const scale = options.scale ?? 1;

        let pos;
        if (options.position) {
            const p = options.position;
            pos = p.isVector3 ? p : new Vector3(p.x, p.y, p.z);
        } else {
            pos = this.camera.position.clone();
        }

        if (this.planetConfig?.origin) {
            const o = this.planetConfig.origin;
            const origin = new Vector3(o.x, o.y, o.z);
            return this._makeSurfaceMatrix(pos, origin, scale);
        }
        // Flat-world fallback
        const m = new Matrix4();
        m.makeTranslation(pos.x, pos.y, pos.z);
        if (scale !== 1) m.scale(new Vector3(scale, scale, scale));
        return m;
    }
async loadGLB(url, options = {}) {
    if (!this.skinnedMeshRenderer?.isReady()) {
        Logger.warn('[Frontend] SkinnedMeshRenderer not ready');
        return null;
    }
    const { GLTFLoader } = await import('../../../shared/gltf/GLTFLoader.js');
    const loader = new GLTFLoader({ verbose: true });
    const asset  = await loader.loadFromURL(url);
    const worldMatrix = this._computeGLBWorldMatrix(options);
    return await this.skinnedMeshRenderer.addInstance(asset, worldMatrix, options);
}


_preparePerFrameLightingAndParticles(encoder) {
    // 1) Let particles update their attached point lights first.
    if (this.particleSystem) {
        this.particleSystem.update(encoder, this.camera, this._lastDeltaTime || 0, this._currentEnvironmentState);
    }

    // 2) Upload the latest light list after particle lights have moved/flickered.
    if (this.clusterGrid && this.lightManager && this.clusterLightBuffers) {
        this.clusterGrid.updateFromCamera(this.camera);
        this.clusterLightBuffers.setCamera(this.camera);
        this.clusterLightBuffers.upload(this.lightManager);
        this._pushClusterBuffersToMaterials();

        // 3) Build cluster → light lists for this exact frame.
        this.clusterLightBuffers.dispatchCompute(encoder);
    }
}
updateLighting(starSystem) {
    this._updateGlobalLighting(starSystem);
}

    _updateGlobalLighting(starSystem) {
        this.lightingController.update(
            starSystem,
            this.camera.position,
            this.planetConfig,
            this.frameCount
        );
        this.uniformManager.updateFromLightingController(this.lightingController);
    }
    addPointLight(position, color, intensity, radius, decay = 1.0) {
        if (!this.lightManager) return null;
        return this.lightManager.addLight(1, {
            position: new Vector3(position.x, position.y, position.z),
            color: new Color(color.r, color.g, color.b),
            intensity,
            radius,
            decay
        });
    }

    addSpotLight(position, direction, color, intensity, radius, angle, penumbra = 0.1) {
        if (!this.lightManager) return null;
        return this.lightManager.addLight(2, {
            position: new Vector3(position.x, position.y, position.z),
            direction: new Vector3(direction.x, direction.y, direction.z),
            color: new Color(color.r, color.g, color.b),
            intensity,
            radius,
            angle,
            penumbra
        });
    }

    removeLight(light) {
        if (!this.lightManager || !light) return;
        const idx = this.lightManager.lights.indexOf(light);
        if (idx !== -1) {
            this.lightManager.lights.splice(idx, 1);
        }
    }

    clearLights() {
        if (!this.lightManager) return;
        this.lightManager.lights = [];
        this.lightManager.pointLights = [];
        this.lightManager.spotLights = [];
    }
    _updateClusteredLighting() {
        if (!this.clusterGrid || !this.lightManager) return;

        this.clusterGrid.updateFromCamera(this.camera);

        if (!this.clusterLightBuffers) return;

        this.clusterLightBuffers.setCamera(this.camera);
        this.clusterLightBuffers.upload(this.lightManager);
        this._pushClusterBuffersToMaterials();
    }

    // Dispatches the GPU cluster-assignment compute pass.
    // Must be called with a command encoder OUTSIDE any active render pass,
    // after _updateClusteredLighting() has uploaded the light data for this frame.
    _dispatchClusterLighting(encoder) {
        if (!this.clusterLightBuffers) return;
        this.clusterLightBuffers.dispatchCompute(encoder);
    }
    _pushClusterBuffersToMaterials() {
        const buf = this.clusterLightBuffers;

        // Push to terrain materials
        if (this.quadtreeTerrainRenderer?._materials) {
            for (const mat of this.quadtreeTerrainRenderer._materials.values()) {
                mat.uniforms._clusterBuffers = { value: buf };
            }
        }

        // Push to asset streamer
        if (this.assetStreamer) {
            this.assetStreamer.setClusterLightBuffers(buf);
        }
        if (this.skinnedMeshRenderer) {
            this.skinnedMeshRenderer.setClusterLightBuffers(buf);
        }
    }



    async render(gameState, environmentState, deltaTime, planetConfig, sphericalMapper, starSystem) {

        if (this.backend.deviceLoss || (this.terrainModule && !this.textureManager?.loaded)) return;
        this._lastDeltaTime = Number.isFinite(deltaTime) ? deltaTime : 0;
        this._currentEnvironmentState = environmentState;

        if (!this._renderDiagLastWall) this._renderDiagLastWall = performance.now();
        if (!this._renderDiagCount) this._renderDiagCount = 0;
        this._renderDiagCount++;

        const wallNow = performance.now();
        const wallDelta = (wallNow - this._renderDiagLastWall) * 0.001;
        if (this._renderDiagCount % 60 === 0) {
            Logger.info(
                `[FrontendDiag] frame=${this._renderDiagCount}, ` +
                `deltaTime=${deltaTime.toFixed(6)}, ` +
                `wallDelta=${wallDelta.toFixed(6)}, ` +
                `_lastDeltaTime=${this._lastDeltaTime.toFixed(6)}, ` +
                `windSpeed=${environmentState?.windSpeed?.toFixed(2) ?? 'N/A'}, ` +
                `weatherIntensity=${environmentState?.weatherIntensity?.toFixed(3) ?? 'N/A'}`
            );
        }

        this._renderDiagLastWall = wallNow;

        if (this.atmosphereLUT && this.atmosphereSettings) {
            await this.atmosphereLUT.compute(this.atmosphereSettings);
        }
        if(this.backend.deviceLoss)return;

        const doValidationScope = this.backend.device &&
            (this.debugMode || (this._validationScopeInterval > 0 && (this.frameCount % this._validationScopeInterval) === 0));
        if (doValidationScope) {
            this.backend.device.pushErrorScope('validation');
        }

        try {
            this.frameCount++;

            if (this.textureCache?.processDeferredDestructions) {
                this.textureCache.processDeferredDestructions();
            }

            this.updateCamera(gameState);
            if (this.planetConfig && this.uniformManager.currentPlanetConfig !== this.planetConfig) {
                this.uniformManager.updateFromPlanetConfig(this.planetConfig);
            }

            await this.updateChunks(gameState, environmentState, deltaTime, planetConfig, sphericalMapper);
            if(this.backend.deviceLoss)return;

            this.updateLighting(starSystem);


            // --- UPDATED WEATHER CONTROLLER LOGIC ---
            // The WeatherController now drives the environmentState (interpolation/logic)
            if (this.weatherController && environmentState) {
                this.weatherController.update(deltaTime, environmentState);

                environmentState.weatherMap = {
                    current: this.weatherController.getCurrentView(),
                    previous: this.weatherController.getPreviousView(),
                    blend: this.weatherController.getBlend(),
                    resolution: this.weatherController.getResolution()
                };
            }

            if (this.uniformManager?.setLocalFogDensityBoost) {
                const localFogBoost = this.atmoBankSystem?.estimateLocalDistanceFogBoost?.(
                    this.camera,
                    environmentState,
                    this.planetConfig
                ) ?? 0;
                this.uniformManager.setLocalFogDensityBoost(localFogBoost);
            }

            this.terrainModule?.setEnvironmentState(environmentState);
            const frame = this.rendererCore.beginFrame({ camera: this.camera, deltaTime: this._lastDeltaTime });

            const hasPostProcessing = !!this.postProcessing;
            const postEffectsActive = !!(this.postProcessing && this.postProcessing.enabled !== false);

            // Route scene rendering through HDR postprocessing target.
            if (hasPostProcessing) {
                this.postProcessing.beginScenePass(this.backend);
            } else {
                this.backend.setRenderTarget(null);
                this.backend.setClearColor(0.0, 0.0, 0.0, 1.0);
                this.backend.clear(true, true, false);
            }

            let sunDiskFade = 1.0;
            if (this.starRenderer && starSystem?.primaryStar && starSystem.currentBody) {
                const camPos = this.camera.position;
                const starInfo = starSystem.currentBody.getStarDirection(
                    starSystem.primaryStar,
                    { x: camPos.x, y: camPos.y, z: camPos.z }
                );
                sunDiskFade = this.starRenderer.update(this.camera, starSystem.primaryStar, starInfo);
            } else if (this.starRenderer) {
                this.starRenderer.visible = false;
                this.starRenderer.opacity = 0;
            }

            if (this.moonRenderer && starSystem) {
                const camPos = this.camera.position;
                const moonInfo = starSystem.getMoonInfo({ x: camPos.x, y: camPos.y, z: camPos.z });
                const sunDir = this.lightingController.getSunDirection();
                this.moonRenderer.update(this.camera, moonInfo, sunDir);
                this.moonRenderer.render(this.camera);
            }


            if (this.skyRenderer && this.atmosphereSettings) {
                // Night look: the moonlit sky's own brightness (sky darker than the ground at night).
                this.skyRenderer.moonSkyScale = (this.nightLook ?? this.engineConfig?.rendering?.nightLook)?.sky ?? 1;
                const sunDir = environmentState?.sunLightDirection ||
                    this.uniformManager.uniforms.sunLightDirection.value;
                this.skyRenderer.render(
                    this.camera,
                    this.atmosphereSettings,
                    sunDir,
                    this.uniformManager,
                    sunDiskFade
                );
            }

            if (this.starRenderer) {
                this.starRenderer.render();
            }

            // Cirrus is drawn without depth, in two parts split at each ray's closest approach to the
            // planet. Past it the ray climbs, so it has met any cumulus and ground before the cirrus:
            // that part goes behind the scene and the volumetric clouds. Before it the ray descends and
            // meets the cirrus first: that part goes over everything, and exists only from the cirrus
            // slab upwards. (Drawing all of it on top from there put the cirrus beyond the limb over
            // the cumulus along the horizon.)
            const cirrusOn = !!(this.cloudRenderer && this.cloudRenderer.enabled && !environmentState?.disableClouds);
            const cirrusOnTop = cirrusOn && this._cameraAboveCirrus();
            const budgetTier = this.volumetricClouds?.enabled ? this.volumetricClouds.budgetTier : null;
            const cirrusShell = budgetTier?.cirrusVolume === false;
            // The lower detail tiers draw the cirrus small, in the cloud composite (_renderVolumetricClouds).
            const cirrusDraws = cirrusOn && !budgetTier?.cirrusScale;
            if (cirrusOn) {
                // Before either part, so both use this frame's camera: they meet at the split, and a
                // far part a frame behind would tear from the near part while turning.
                this.cloudRenderer.update(this.camera, budgetTier?.cirrusOnly ? this._cirrusOnlyWeather(environmentState) : environmentState, this.uniformManager);
                this.cloudRenderer.render(this.camera, environmentState, this.uniformManager);
                if (cirrusDraws) this.cloudRenderer.renderCirrus?.(this.camera, environmentState, this.uniformManager, 'far', cirrusShell);
            }

            this.renderTerrain(frame);

            if (cirrusOn) {
                if (this.atmoBankSystem && this.cloudRenderer.noiseGenerator) {
                    const ng = this.cloudRenderer.noiseGenerator;
                    this.atmoBankSystem.setNoiseTextures(
                        ng.getBaseTextureView(),
                        ng.getDetailTextureView()
                    );
                }
            }

            // The composite multiplies the scene by the cloud transmittance, so it must not run on a
            // stale output when the module is switched off.
            if (this.volumetricClouds?.enabled && !environmentState?.disableClouds) {
                this._renderVolumetricClouds(frame, environmentState, cirrusOn, cirrusOnTop);
            }

            if (cirrusOnTop && cirrusDraws) {
                this.cloudRenderer.renderCirrus?.(this.camera, environmentState, this.uniformManager, 'near', cirrusShell);
            }
            if (this._weatherParticlesOnly && this.backend._renderPassEncoder) {
                this.particleSystem.render(this.backend._renderPassEncoder);
            }

            if (postEffectsActive) {
                this.postProcessing.beginBloomSourcePass(this.backend);

                if (this.skinnedMeshRenderer?.isReady()) {
                    this.skinnedMeshRenderer.renderBloom(
                        this.camera,
                        this.camera.matrixWorldInverse,
                        this.camera.projectionMatrix
                    );
                }

                if (this.particleSystem && this.backend._renderPassEncoder) {
                    this.particleSystem.renderBloom(this.backend._renderPassEncoder);
                }
            }

            // Execute HDR postprocessing chain (bloom, distortion, tone mapping).
            if (hasPostProcessing) {
                const dp = this.postProcessing.distortionPass;
                let hazeRendered = false;

                // Render heat haze distortion sources before postprocessing.
                // Update first so callback-driven source positions are refreshed
                // before any range culling happens inside the emitter.
                if (postEffectsActive && this.heatHazeEmitter && dp) {
                    this.backend._endCurrentRenderPass();
                    this.backend._ensureCommandEncoder();
                    const enc = this.backend._commandEncoder;

                    this.heatHazeEmitter.update(
                        this._lastDeltaTime || 0,
                        this.planetConfig?.origin || null,
                        this.camera.position
                    );

                    if (this.heatHazeEmitter.hasRenderableParticles()) {
                        dp.clearDistortionMap(enc);

                        const te = this.camera.matrixWorldInverse.elements;
                        const cameraRight = [te[0], te[4], te[8]];
                        const cameraUp = [te[1], te[5], te[9]];
                        const vpMat = new Matrix4();
                        vpMat.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);

                        this.heatHazeEmitter.render(
                            enc,
                            dp.getDistortionMapView(),
                            this.postProcessing.depthTextureView,
                            vpMat.elements,
                            cameraRight,
                            cameraUp,
                            this.planetConfig?.origin || null
                        );
                        hazeRendered = true;
                    }
                }

                if (dp) dp.hasActiveSources = hazeRendered;
                // Night look (tonemap): grade strength and extra exposure at full night, from
                // rendering.nightLook; this.nightLook stays live-tunable.
                this.nightLook ??= { grade: 0, exposure: 0, ...(this.engineConfig?.rendering?.nightLook ?? {}) };
                const nightAmount = 1 - Math.max(0, Math.min(1, this.lightingController?.getSunVisibility?.() ?? 1));
                this.postProcessing.setNight?.(nightAmount, this.nightLook.grade ?? 0, this.nightLook.exposure ?? 0);
                this.postProcessing.execute(this.backend);
            }

            this.rendererCore.endFrame(frame);
            this._actorManager?.resolveReadback();
        } catch (error) {
            this.rendererCore.abortFrame();
            throw error;
        } finally {
            if (doValidationScope) await this.backend.device.popErrorScope();
        }
    }


    // From inside the lowest active cirrus layer's slab upwards, cirrus lies in front of the ground.
    // Switching at the middle of the layer hid the sheet below the camera behind the terrain there,
    // leaving only the far side of the layer in the sky between the deck's horizon and the limb.
    // The low cloud detail has no decks: thicker and darker cirrus as the weather closes in stands in for them.
    _cirrusOnlyWeather(environmentState) {
        const weather = environmentState?.weatherEffect?.clouds;
        const deck = (weather?.deck ?? 0) * (weather?.presence ?? 1);
        if (!(deck > 0) || !Array.isArray(environmentState.cloudLayers)) return environmentState;
        const cloudLayers = environmentState.cloudLayers.map(layer => layer.name !== 'high' ? layer : {
            ...layer, coverage: Math.max(layer.coverage, 0.3 + 0.5 * deck), darkness: Math.max(layer.darkness ?? 0, 0.55 * (weather.rainShade ?? 0)),
        });
        return Object.create(environmentState, { cloudLayers: { value: cloudLayers } });
    }

    _cameraAboveCirrus() {
        const layers = (this.cloudRenderer?._renderLayers ?? []).filter(l => l.coverage > 0.005 && l.altMax > l.altMin);
        if (!layers.length || !this.planetConfig) return false;
        const o = this.planetConfig.origin ?? { x: 0, y: 0, z: 0 };
        const p = this.camera.position;
        const altitude = Math.hypot(p.x - o.x, p.y - o.y, p.z - o.z) - this.planetConfig.radius;
        const slab = this.cloudRenderer?.cirrusSlabFraction ?? 0;
        return altitude > Math.min(...layers.map(l => 0.5 * (l.altMin + l.altMax) - 0.5 * slab * (l.altMax - l.altMin)));
    }

    /** Planet frame and atmosphere for the cloud module, in km, from the host's metre-based settings. */
    _cloudPlanet() {
        const a = this.atmosphereSettings;
        const o = this.planetConfig?.origin ?? { x: 0, y: 0, z: 0 };
        const r = a.rayleighScattering;
        const oz = a.ozoneAbsorption ?? { x: 6.5e-7, y: 1.881e-6, z: 8.5e-8 };
        return {
            radiusKm: a.planetRadius / 1000,
            atmosphereHeightKm: a.atmosphereHeight / 1000,
            unitsPerKm: 1000,
            center: [o.x, o.y, o.z],
            atmosphere: {
                rayleighPerKm: [r.x * 1000, r.y * 1000, r.z * 1000],
                rayleighScaleHeightKm: a.scaleHeightRayleigh / 1000,
                // The sky's transmittance LUT counts Mie extinction equal to scattering.
                miePerKm: a.mieScattering * 1000,
                mieExtinctionPerKm: a.mieScattering * 1000,
                mieScaleHeightKm: a.scaleHeightMie / 1000,
                mieG: a.mieAnisotropy,
                ozonePerKm: [oz.x * 1000, oz.y * 1000, oz.z * 1000],
                ozonePeakKm: 25,
                ozoneHalfWidthKm: 15,
                groundAlbedo: a.groundAlbedo ?? 0.3,
            },
        };
    }

    async _initVolumetricClouds() {
        const config = this.engineConfig?.rendering?.volumetricClouds ?? {};
        const vp = this.backend._viewport;
        try {
            const { VolumetricCloudsModule } = await import('../volumetricClouds/VolumetricCloudsModule.js');
            const { CloudCompositePass } = await import('../volumetricClouds/CloudCompositePass.js');
            const clouds = new VolumetricCloudsModule({ settings: config.settings, planet: this._cloudPlanet() });
            await clouds.initialize({ device: this.backend.device, viewport: { width: vp.width, height: vp.height } });
            const composite = new CloudCompositePass(clouds, {
                colorFormat: HDR_FORMAT,
                shadowStrength: config.shadowStrength,
                shadowFloor: config.shadowFloor,
            });
            await composite.initialize(this.backend.device);
            clouds.setLandSource({
                tileStreamer: () => this.quadtreeTileManager?.tileStreamer,
                heightScaleKm: (this.planetConfig?.heightScale ?? 0) / clouds.planet.unitsPerKm,
                tileCategories: this.planetConfig?.tileCatalog?.tileCategories ?? this.planetConfig?.worldAuthoring?.tileCatalog?.tileCategories,
            });
            this.volumetricClouds = clouds;
            this.cloudComposite = composite;
            this._cloudConfig = config;
            if (typeof window !== 'undefined') window.volumetricClouds = clouds;
        } catch (e) {
            Logger.warn(`[Frontend] Volumetric clouds init failed: ${e?.message || e}`);
            this.volumetricClouds = null;
            this.cloudComposite = null;
        }
    }

    // After the opaque and transparent scene: the raymarch stops at this frame's scene depth,
    // then the composite blends the clouds (and their ground shadows) into the HDR target.
    _renderVolumetricClouds(frame, environmentState, cirrusOn = false, cirrusOnTop = false) {
        const pp = this.postProcessing;
        const lutTexture = this.atmosphereLUT?.transmittanceLUT?._gpuTexture;
        if (!pp?.hdrTextureView || !pp.depthTextureView || !lutTexture?.view) return;
        const clouds = this.volumetricClouds;
        const config = this._cloudConfig;
        const a = this.atmosphereSettings;
        const vp = this.backend._viewport;

        const sun = environmentState?.sunLightDirection || this.uniformManager.uniforms.sunLightDirection.value;
        const sunLength = Math.hypot(sun.x, sun.y, sun.z) || 1;
        clouds.sunDirection = [sun.x / sunLength, sun.y / sunLength, sun.z / sunLength];
        clouds.sunIlluminance = a.sunIntensity * (config.brightness ?? 1);
        const wind = environmentState?.windDirection;
        if (wind && Math.hypot(wind.x, wind.y) > 1e-6) {
            const l = Math.hypot(wind.x, wind.y);
            clouds.windDirection = [wind.x / l, 0, wind.y / l];
        }
        if (Number.isFinite(environmentState?.windSpeed)) clouds.windSpeed = environmentState.windSpeed;
        // Night light: the moon as a directional light (shaded tops and sides, like the sun by day)
        // plus the host's night-sky ambient as a faint fill.
        const lc = this.lightingController;
        const night = 1 - Math.max(0, Math.min(1, lc.getSunVisibility?.() ?? 1));
        const ambColor = this.uniformManager.uniforms.ambientLightColor?.value;
        const ambI = (this.uniformManager.uniforms.ambientLightIntensity?.value ?? 0) * night;
        // Night look: the clouds' own share of moonlight and night fill (1 = as lit by the moon).
        const cloudNight = Math.max(0, (this.nightLook ?? this.engineConfig?.rendering?.nightLook)?.clouds ?? 1);
        clouds.ambientFloor = ['r', 'g', 'b'].map(ch => (ambColor?.[ch] ?? 0) * ambI * (config.nightAmbient ?? 1) * cloudNight);
        const moon = lc.getMoonDirection?.();
        if (moon) clouds.moonDirection = [moon.x, moon.y, moon.z];
        clouds.moonIlluminance = clouds.sunIlluminance * (lc.getMoonIntensity?.() ?? 0) * (config.moonlight ?? 1) * cloudNight;

        const weather = config.coverageFromWeather;
        if (weather && Number.isFinite(environmentState?.cloudCoverage)) {
            clouds.settings.coverage = weather.min + (weather.max - weather.min) * environmentState.cloudCoverage;
        }
        clouds.weather = environmentState?.weatherEffect?.clouds ?? null;

        clouds.update({ ...frame, viewport: { width: vp.width, height: vp.height } });
        this.backend.endRenderPassForCompute();
        const encoder = this.backend.getCommandEncoder();
        clouds.setSceneDepth(pp.depthTextureView);
        clouds.compute(frame, encoder);
        let cirrus = null;
        const cirrusScale = clouds.budgetTier?.cirrusScale;
        if (cirrusOn && cirrusScale) {
            const draw = part => this.cloudRenderer.renderCirrusTarget?.(this.camera, part, cirrusScale);
            cirrus = { far: draw('far'), near: cirrusOnTop ? draw('near') : null };
            this.backend.endRenderPassForCompute();
        }
        this.cloudComposite.render(this.backend.getCommandEncoder(), {
            colorView: pp.hdrTextureView, depthView: pp.depthTextureView, width: vp.width, height: vp.height,
        }, {
            transmittanceView: lutTexture.view,
            planetRadius: a.planetRadius,
            atmosphereRadius: a.atmosphereRadius ?? a.planetRadius + a.atmosphereHeight,
            scaleHeightRayleigh: a.scaleHeightRayleigh,
            scaleHeightMie: a.scaleHeightMie,
            rayleighScattering: [a.rayleighScattering.x, a.rayleighScattering.y, a.rayleighScattering.z],
            mieScattering: a.mieScattering,
            mieAnisotropy: a.mieAnisotropy,
            sunIntensity: a.sunIntensity,
        }, cirrus);
        this.backend.resumeRenderPass();
    }

    async _maybeInitGPUShadows() {
        if (this.gpuShadowRenderer) return;
        if (!this.gpuQuadtreeEnabled) return;
        if (!this.backend?.device) return;
        if (!this.quadtreeTileManager?.isReady?.()) {
            Logger.debug('[Frontend] GPU shadow renderer deferred: quadtree not ready');
            return;
        }
        if (!this.quadtreeTerrainRenderer) {
            Logger.debug('[Frontend] GPU shadow renderer deferred: terrain renderer missing');
            return;
        }

        try {
            const { GPUCascadedShadowRenderer } = await import('../../shadows/GPUCascadedShadowRenderer.js');
            this.gpuShadowRenderer = new GPUCascadedShadowRenderer({
                device: this.backend.device,
                backend: this.backend,
                quadtreeGPU: this.quadtreeTileManager.quadtreeGPU,
                tileManager: this.quadtreeTileManager,
                maxGeomLOD: this.quadtreeTerrainRenderer.maxGeomLOD,
                lodIndexCounts: this.quadtreeTerrainRenderer.lodIndexCounts,
                geometries: this.quadtreeTerrainRenderer.geometries,
                planetConfig: this.planetConfig,
                uniformManager: this.uniformManager,
                cascadeSplits: [40, 110, 260],
                shadowMapSizes:  [1536, 1024, 512],
                shadowBias: 0.002,
                normalBias: 0.5
            });
            await this.gpuShadowRenderer.initialize();
            Logger.info('[Frontend] GPU shadow renderer initialized');
        } catch (e) {
            Logger.warn(`[Frontend] GPU shadow renderer init failed: ${e?.message || e}`);
            this.gpuShadowRenderer = null;
            return;
        }
        if (this.skinnedMeshRenderer) {
            this.skinnedMeshRenderer.setShadowRenderer(this.gpuShadowRenderer);
        }
        if (this.assetStreamer) {
            this.assetStreamer.setShadowRenderer(this.gpuShadowRenderer);
        }
        if (this.quadtreeTerrainRenderer) {
            this.quadtreeTerrainRenderer.setShadowRenderer(this.gpuShadowRenderer);
        }
/*
        if (this.assetStreamer) {
         //   this.assetStreamer.setShadowRenderer(this.gpuShadowRenderer);
            // NEW: give shadow renderer access to asset geometry
            if (this.assetStreamer._pool && this.assetStreamer._geometries) {
                this.gpuShadowRenderer.setAssetPool(
                    this.assetStreamer._pool,
                    this.assetStreamer._geometries,
                    this.assetStreamer._lodIndexCounts
                );
            }
        }*/
    }

    _renderAtmoBanks(commandEncoder) {
        if (!this.atmoBankSystem || !this.postProcessing) return;

        const colorView = this.postProcessing.hdrTextureView;
        const depthView = this.postProcessing.depthTextureView;
        if (!colorView || !depthView) return;

        const vp = this.backend._viewport;
        if (this.atmoBankSystem.renderOffscreen?.(commandEncoder, {
            sceneColorView: colorView,
            sceneDepthView: depthView,
            sceneWidth: vp.width,
            sceneHeight: vp.height,
        })) {
            return;
        }

        const pass = commandEncoder.beginRenderPass({
            colorAttachments: [{
                view: colorView,
                loadOp: 'load',
                storeOp: 'store',
            }],
            depthStencilAttachment: {
                view: depthView,
                depthReadOnly: true,
            },
        });

        pass.setViewport(vp.x, vp.y, vp.width, vp.height, 0, 1);
        this.atmoBankSystem.render(pass, {
            targetWidth: vp.width,
            targetHeight: vp.height,
            sceneWidth: vp.width,
            sceneHeight: vp.height,
        });
        pass.end();
    }

    renderTerrain(frame) {
        const viewMatrix = this.camera.matrixWorldInverse;
        const projectionMatrix = this.camera.projectionMatrix;
        this.backend.endRenderPassForCompute();
        const encoder = this.backend.getCommandEncoder();
        this._preparePerFrameLightingAndParticles(encoder);
        this.skinnedMeshRenderer?.update(this._lastDeltaTime);
        if (this.gpuShadowRenderer?.isReady) {
            this.gpuShadowRenderer.updateCascadeParams(this.camera, encoder);
            this.gpuShadowRenderer.cullAndBuildIndirect(encoder);
            this.gpuShadowRenderer.renderShadowPasses(encoder);
            this.skinnedMeshRenderer?.renderShadowPasses(encoder, this.gpuShadowRenderer);
        }

        this.rendererCore.compute(frame);
        this.rendererCore.render(frame);

        if (this.assetStreamer || this._actorManager) {
            this.backend.endRenderPassForCompute();
            const assetEncoder = this.backend.getCommandEncoder();
            this.assetStreamer?.update(assetEncoder, this.camera);
            this._dispatchActorCompute(assetEncoder);
            this.backend.resumeRenderPass();
            this.assetStreamer?.render(this.camera, viewMatrix, projectionMatrix);
            if (this._actorManager?.destinationMarker?.active) {
                this._actorManager.renderOverlays(this.backend.getRenderPassEncoder(), this.camera, this._lastDeltaTime);
            }
        }
        if (this.skinnedMeshRenderer?.isReady()) this.skinnedMeshRenderer.render(this.camera, viewMatrix, projectionMatrix);
        if (this.genericMeshRenderer) {
            this.genericMeshRenderer.update(this.camera.position, this._lastDeltaTime);
            this.genericMeshRenderer.render(viewMatrix, projectionMatrix);
        }

        this.rendererCore.renderTransparent(frame);
        if (this.particleSystem && !this._weatherParticlesOnly && this.backend.getRenderPassEncoder()) {
            this.particleSystem.render(this.backend.getRenderPassEncoder());
        }
        if (this.atmoBankSystem) {
            this.backend.endRenderPassForCompute();
            const bankEncoder = this.backend.getCommandEncoder();
            this.atmoBankSystem.update(bankEncoder, this.camera, this._lastDeltaTime,
                this._currentEnvironmentState, this.planetConfig, this.lightingController, this.uniformManager);
            this.atmoBankSystem.setDepthTexture(this.postProcessing?.depthTextureView);
            this._renderAtmoBanks(bankEncoder);
            this.backend.resumeRenderPass();
        }
    }

    setLakes(confirmedLakes) {
        this.terrainModule?.setLakes(confirmedLakes);
    }

    playGLBAnimation(instance, animIndex, options = {}) {
        this.skinnedMeshRenderer?.playAnimation(instance, animIndex, options);
    }

    stopGLBAnimation(instance) {
        this.skinnedMeshRenderer?.stopAnimation(instance);
    }

    handleResize(width, height) {
        this.camera.aspect = width / height;
        this._updateCameraMatrices();
        this.rendererCore.resize(width, height);
        this.postProcessing?.handleResize(width, height);
    }

    async switchPlanet(planetConfig) {
        this.planetConfig = planetConfig;
        this.atmosphereSettings = requireObject(
            planetConfig.atmosphereSettings,
            'planetConfig.atmosphereSettings'
        );
        this.atmoBankSystem?.setAuthoringRuntime?.(planetConfig?.atmoBankAuthoring, {
            tileCategories: planetConfig?.tileCatalog?.tileCategories ??
                planetConfig?.worldAuthoring?.tileCatalog?.tileCategories,
            biomeDefinitions: planetConfig?.biomeDefinitions ?? planetConfig?.worldAuthoring?.biomes,
        });
        this.particleSystem?.setAuthoringRuntime?.(planetConfig?.particleAuthoring ?? null);
        if (this.atmosphereLUT) {
            this.atmosphereLUT.invalidate();
        }
        if (this.volumetricClouds) {
            Object.assign(this.volumetricClouds.planet, this._cloudPlanet());
            this.volumetricClouds.resetHistory();
        }
    }

    async switchPlanetPreset(presetName) {
        const { PlanetAtmosphereSettings } = await import(
            '../../../templates/configs/planetAtmosphereSettings.js'
        );
        this.atmosphereSettings = PlanetAtmosphereSettings.createPreset(presetName);
        if (this.atmosphereLUT) {
            this.atmosphereLUT.invalidate();
        }
    }

    dispose() {
        // App extensions first; terrain resources next; the shared device last.
        this.assetStreamer?.dispose?.();
        this.assetStreamer = null;
        this.skinnedMeshRenderer?.dispose?.();
        this.skinnedMeshRenderer = null;
        this.gpuShadowRenderer?.dispose?.();
        this.gpuShadowRenderer = null;
        this.particleSystem?.dispose?.();
        this.atmoBankSystem?.dispose?.();
        this.moonRenderer?.dispose?.();
        this.starRenderer?.dispose?.();
        this.skyRenderer?.dispose?.();
        this.cloudRenderer?.dispose?.();
        this.cloudComposite?.dispose?.();
        this.volumetricClouds?.dispose?.();
        this.heatHazeEmitter?.dispose?.();
        this.postProcessing?.dispose?.();
        this.weatherController?.dispose?.();
        this.lightManager?.cleanup();
        this.clusterLightBuffers?.dispose?.();
        this.rendererCore?.dispose?.();
        this.terrainModule = null;
        this.atmosphereLUT?.dispose?.();
        this.backend?.dispose?.();
    }

    updateCamera(gameState) {
        if (gameState.camera) {
            const camPos = gameState.camera.position;
            const camTarget = gameState.camera.target;

            if (camPos.isVector3) {
                this.camera.position.copy(camPos);
            } else {
                this.camera.position.set(camPos.x, camPos.y, camPos.z);
            }

            if (camTarget.isVector3) {
                this.camera.target.copy(camTarget);
            } else {
                this.camera.target.set(camTarget.x, camTarget.y, camTarget.z);
            }

            this._updateCameraMatrices();
        }

        this.uniformManager.updateCameraParameters(this.camera);
    }
    _updateCameraMatrices() {
        const position = this.camera.position;
        const target = this.camera.target;

        if (this.planetConfig?.radius) {
            const origin = this.planetConfig.origin || { x: 0, y: 0, z: 0 };
            const dx = position.x - origin.x;
            const dy = position.y - origin.y;
            const dz = position.z - origin.z;
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
            const radius = this.planetConfig.radius;
            const altitude = Math.max(0, dist - radius);
            const horizon = Math.sqrt(Math.max(0, dist * dist - radius * radius));
            let targetFar = Math.max(2000, Math.min(radius * 3, horizon * 2 + altitude));

            const fullSphereQuadtree = this.gpuQuadtreeEnabled &&
                this.gpuQuadtreeConfig?.enableHorizonCulling === false &&
                this.gpuQuadtreeConfig?.enableFrustumCulling === false;
            if (fullSphereQuadtree) {
                const minFar = radius * 2.2;
                if (Number.isFinite(minFar)) {
                    targetFar = Math.max(targetFar, minFar);
                }
            }
            if (Number.isFinite(targetFar)) {
                this.camera.far = targetFar;
            }

            // Dynamic near plane improves depth precision at all altitudes.
            // Scales from 0.5m at ground to ~50m at orbital altitude.
            const altitudeRatio = altitude / radius;
            this.camera.near = Math.max(0.5, Math.min(100.0,
                0.5 + altitudeRatio * altitudeRatio * 1000.0));
        }

        // View matrix (unchanged from your original)
        const zAxis = new Vector3().subVectors(position, target).normalize();
        let up = new Vector3().copy(position).normalize();
        if (up.lengthSq() < 0.0001) up.set(0, 1, 0);
        const dot = Math.abs(zAxis.dot(up));
        if (dot > 0.99) up.set(0, 0, 1);

        const xAxis = new Vector3().crossVectors(up, zAxis).normalize();
        const yAxis = new Vector3().crossVectors(zAxis, xAxis);

        const te = this.camera.matrixWorldInverse.elements;
        te[0] = xAxis.x; te[4] = xAxis.y; te[8]  = xAxis.z;
        te[1] = yAxis.x; te[5] = yAxis.y; te[9]  = yAxis.z;
        te[2] = zAxis.x; te[6] = zAxis.y; te[10] = zAxis.z;
        te[12] = -xAxis.dot(position);
        te[13] = -yAxis.dot(position);
        te[14] = -zAxis.dot(position);
        te[3] = 0; te[7] = 0; te[11] = 0; te[15] = 1;

        // -----------------------------------------------------------------------
        // Forward-Z WebGPU projection matrix.
        //
        // WebGPU NDC Z range is [0, 1]  (NOT [-1, 1] like OpenGL).
        // Near plane maps to Z=0, far plane maps to Z=1.
        //
        // Derivation from the standard perspective frustum:
        //   OpenGL:  pe[10] = -(f+n)/(f-n),  pe[14] = -2fn/(f-n)   → Z in [-1,1]
        //   WebGPU:  pe[10] =   -f/(f-n),    pe[14] =  -fn/(f-n)   → Z in [ 0,1]
        //
        // All other elements are identical between the two APIs.
        // -----------------------------------------------------------------------
        const fov    = this.camera.fov * Math.PI / 180;
        const aspect = this.camera.aspect;
        const near   = this.camera.near;
        const far    = this.camera.far;

        const f = 1.0 / Math.tan(fov / 2); // focal length

        const pe = this.camera.projectionMatrix.elements;

        // Column 0
        pe[0]  = f / aspect;
        pe[1]  = 0;
        pe[2]  = 0;
        pe[3]  = 0;

        // Column 1
        pe[4]  = 0;
        pe[5]  = f;
        pe[6]  = 0;
        pe[7]  = 0;

        // Column 2
        pe[8]  = 0;
        pe[9]  = 0;
        pe[10] = -far / (far - near);          // WebGPU forward-Z
        pe[11] = -1;                           // perspective divide (w = -z_view)

        // Column 3
        pe[12] = 0;
        pe[13] = 0;
        pe[14] = -(far * near) / (far - near); // WebGPU forward-Z
        pe[15] = 0;

        if (this.uniformManager) {
            this.uniformManager.updateCameraParameters(this.camera);
        }
    }
}
