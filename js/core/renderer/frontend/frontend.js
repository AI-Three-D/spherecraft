import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.178.0/build/three.module.js';
import { WebGPUBackend } from '../backend/webgpuBackend.js';

import { ChunkCullingManager } from '../chunkCullingManager.js';
import { UniformManager } from '../../lighting/uniformManager.js';
import { ClusteredLightManager } from '../../lighting/clusteredLightManager.js';
import { ClusterGrid } from '../../lighting/clusterGrid.js';

import { GenericMeshRenderer } from '../genericMeshRenderer.js';
import { LightingController } from '../../lighting/lightingController.js';
import { Logger} from '../../../shared/Logger.js'
import { WeatherController } from '../environment/WeatherController.js';
import { QuadtreeTileManager } from '../../world/quadtree/GPUQuadtreeTerrain.js';

import { QuadtreeTerrainRenderer } from '../terrain/QuadtreeTerrainRenderer.js';
import {  requireMaxFinite, requireNumber, requireNumberArray, requireObject, requireString } from '../../../shared/requireUtil.js';
export class Frontend {
    constructor(canvas, options = {}) {

        this.skinnedMeshRenderer = null;
        this._instancingLogInterval = 120; // Log every N frames
        this._instancingLogFrame = 0;
        this.canvas = canvas;
        this.lightingController = new LightingController();
        this.backend = null;
        this.backendType = requireString(options.backendType, 'backendType');
        this.engineConfig = options.engineConfig || null;
        this._streamerTheme = options.streamerTheme || null;
        this._nightSkyTheme = options.nightSkyTheme || null;
        this._terrainTheme = options.terrainTheme || null;
        this.gpuQuadtreeConfig = options.gpuQuadtree || this.engineConfig?.gpuQuadtree || null;
        this.gpuQuadtreeEnabled = this.gpuQuadtreeConfig?.enabled === true;
        this.quadtreeTileManager = null;
        this.quadtreeTerrainRenderer = null;
        this.textureManager = options.textureManager;
        this.propTextureManager = options.propTextureManager || null;  // NEW
        this.leafAlbedoTextureManager = options.leafAlbedoTextureManager || null;
        this.leafNormalTextureManager = options.leafNormalTextureManager || null;

        this.textureCache = options.textureCache;
        this.chunkSize = requireNumber(options.chunkSize, 'chunkSize');
        this.lodDistances = requireNumberArray(options.lodDistances, 'lodDistances', 1, true);
        const viewDistance = requireMaxFinite(this.lodDistances, 'lodDistances');

        this.uniformManager = new UniformManager();
        this.uniformManager.applyAmbientConfig(this.engineConfig?.rendering?.lighting?.ambient);
        this.genericMeshRenderer = null;

        this.chunkCullingManager = new ChunkCullingManager({
            chunkSize: this.chunkSize,
            viewDistance,
            margin: this.chunkSize
        });

        this._instancedTest = null;

        this.camera = {
            position: new THREE.Vector3(0, 50, 0),
            target: new THREE.Vector3(0, 0, 0),
            near: 0.1,
            far: 100000,
            fov: 75,
            aspect: canvas.width / canvas.height,
            matrixWorldInverse: new THREE.Matrix4(),
            projectionMatrix: new THREE.Matrix4()
        };

        this.frameCount = 0;
        this.debugMode = false;


        this._instanceBuffers = new Map(); 
  
        this._chunkInstanceBufferCapacity = 0;
        this._chunkInstanceStride = 64;
        this._preparedLODData = null; 
        this._lodDataVersion = 0; 
        this._lastChunkVersion = -1; 
        this._lastLodMapVersion = -1; 
        this._lastEdgeMaskVersion = -1; 
        this._lastInstanceDataVersion = -1; 
        this._atlasTouchInterval = Number.isFinite(options.atlasTouchInterval)
            ? Math.max(1, Math.floor(options.atlasTouchInterval))
            : 30;
        this._lastAtlasTouchFrame = -Infinity;
        this._validationScopeInterval = Number.isFinite(options.validationScopeInterval)
            ? Math.max(1, Math.floor(options.validationScopeInterval))
            : 120;
        this._lastDeltaTime = 0;
    }
    
    getBackend() {
        return this.backend;
    }

    getBackendType() {
        return this.backendType;
    }

    setActorManager(mgr) { this._actorManager = mgr; }

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
    
        return this.backendType === 'webgpu' &&
            this.quadtreeTileManager?.isReady?.();
    }

    get loadedChunks() {
        return this.masterChunkLoader?.loadedChunks || new Map();
    }

    get terrainMeshManager() {
        return this.masterChunkLoader?.terrainMeshManager || null;
    }

    async initializeGPUQuadtree(terrainGenerator) {
        if (!this.gpuQuadtreeEnabled) return;
        if (this.backendType !== 'webgpu' || !this.backend?.device) {
            Logger.warn('[Frontend] GPU quadtree requires WebGPU backend');
            return;
        }
        if (!this.engineConfig) {
            Logger.warn('[Frontend] GPU quadtree requires engineConfig');
            return;
        }
        if (!terrainGenerator) {
            Logger.warn('[Frontend] GPU quadtree requires terrainGenerator');
        }
        if (this.quadtreeTileManager) return;

        try {
            // 1. Tile manager: selection + streaming (world concern)
            this.quadtreeTileManager = new QuadtreeTileManager({
                backend: this.backend,
                engineConfig: this.engineConfig,
                planetConfig: this.planetConfig,
                terrainGenerator: terrainGenerator,
            });
            await this.quadtreeTileManager.initialize();
           

            // 2. Terrain renderer: geometry, materials, draw calls (renderer concern)
            this.quadtreeTerrainRenderer = new QuadtreeTerrainRenderer({
                backend: this.backend,
                tileManager: this.quadtreeTileManager,
                engineConfig: this.engineConfig,
                planetConfig: this.planetConfig,
                textureManager: this.textureManager,
                uniformManager: this.uniformManager,
                terrainGenerator: terrainGenerator,
                terrainAODefaults: this._streamerTheme.TERRAIN_AO_CONFIG,
                groundFieldDefaults: this._streamerTheme.GROUND_FIELD_BAKE_CONFIG,
                tileCategories: this._terrainTheme.TILE_CATEGORIES,
            });
            
            // Asset streamer: modular multi-category GPU scatter system
            // (trees, ground cover, plants — replaces single-purpose GrassRenderer)
            try {
                const { AssetStreamer } = await import('../streamer/AssetStreamer.js');
                this.assetStreamer = new AssetStreamer({
                    device:         this.backend.device,
                    backend:        this.backend,
                    quadtreeGPU:    this.quadtreeTileManager.quadtreeGPU,
                    tileStreamer:   this.quadtreeTileManager.tileStreamer,
                    planetConfig:   this.planetConfig,
                    engineConfig:   this.engineConfig,
                    uniformManager: this.uniformManager,
                    streamerTheme:  this._streamerTheme,
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
            } catch (e) {
                Logger.warn(`[Frontend] Asset streamer init failed: ${e?.message || e}`);
                this.assetStreamer = null;
            }
            if (this.atmosphereLUT) {
                this.quadtreeTerrainRenderer.setAtmosphereLUT(this.atmosphereLUT);
            }
            await this.quadtreeTerrainRenderer.initialize();

            await this._maybeInitGPUShadows();

            if (this.masterChunkLoader?.setStreamingEnabled) {
                this.masterChunkLoader.setStreamingEnabled(false);
            }

            // Initialize global ocean renderer (water) for GPU quadtree path
            try {
                const { GlobalOceanRenderer } = await import('../water/globalOceanRenderer.js');
                const arrayTextures = this.quadtreeTileManager?.getArrayTextures?.() || {};
                const heightTexture = arrayTextures.height || null;

                const terrainWater = this.planetConfig?.terrainGeneration?.water || {};
                const heightScale = Number.isFinite(this.planetConfig?.heightScale) ? this.planetConfig.heightScale : 2000.0;
                const oceanLevelNorm = Number.isFinite(terrainWater.oceanLevel) ? terrainWater.oceanLevel : 0.0;
                const avgOceanDepth = Number.isFinite(terrainWater.averageOceanDepth)
                    ? terrainWater.averageOceanDepth
                    : 2000.0;

                const visualDepthRange = Number.isFinite(terrainWater.visualDepthRange)
                    ? terrainWater.visualDepthRange
                    : Math.max(40.0, Math.min(600.0, avgOceanDepth * 0.12));

                const waterConfig = {
                    oceanLevel: oceanLevelNorm * heightScale,
                    depthRange: visualDepthRange,
                    waveHeight: Number.isFinite(terrainWater.waveHeight) ? terrainWater.waveHeight : 0.35,
                    waveFrequency: 0.8,
                    windDirection: [1.0, 0.0],
                    windSpeed: 5.0,
                    foamIntensity: 0.6,
                    foamDepthStart: 0.0,
                    foamDepthEnd: 2.5,
                    foamTiling: 0.06,
                    shallowAlpha: 0.14,
                    deepAlpha: 0.85, 
                    // UPDATED COLORS (Darker, more natural)
                    colorShallow: 0x154550, // Dark Teal
                    colorDeep: 0x001525,    // Dark Navy
                    maxWaveLOD: 5.0,
                    maxFoamLOD: 4.0
                };

                if (!this.globalOceanRenderer) {
                    this.globalOceanRenderer = new GlobalOceanRenderer({
                        backend: this.backend,
                        quadtreeGPU: this.quadtreeTileManager?.quadtreeGPU || null,
                        planetConfig: this.planetConfig,
                        waterConfig,
                        uniformManager: this.uniformManager,
                        terrainGeometries: this.quadtreeTerrainRenderer?.geometries || null,
                        heightTexture,
                        maxGeomLOD: this.quadtreeTileManager?.maxGeomLOD ?? 6
                    });
                    await this.globalOceanRenderer.initialize();

                    if (terrainWater.hasOceans === false) {
                        this.globalOceanRenderer.enabled = false;
                    }
                }
            } catch (e) {
                Logger.warn(`[Frontend] Global ocean init failed: ${e?.message || e}`);
                this.globalOceanRenderer = null;
            }
        } catch (error) {
            Logger.warn(`[Frontend] GPU quadtree init failed: ${error?.message || error}`);
            this.quadtreeTileManager = null;
            this.quadtreeTerrainRenderer = null;
        }    

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
        if (this.backendType !== 'webgpu') {
            throw new Error(`[Frontend] WebGPU required (requested "${this.backendType}").`);
        }
        if (!navigator.gpu) {
            throw new Error('[Frontend] WebGPU not available in this browser.');
        }

        this.backend = new WebGPUBackend(this.canvas);
        await this.backend.initialize();

        if (this.backend && this.backend._pipelineCache) {
            this.backend._pipelineCache.clear();
        }

        if (this.backendType === 'webgpu' && this.backend?.device) {
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
            if (this.atmosphereLUT && this.masterChunkLoader?.terrainMeshManager) {
                this.masterChunkLoader.terrainMeshManager.setAtmosphereLUT(this.atmosphereLUT);
            }

            const { SkyRenderer } = await import('../SkyRenderer.js');
            const spaceLODThreshold = 1000;
            this.skyRenderer = new SkyRenderer(this.backend, this.atmosphereLUT, {
                spaceLODThreshold,
                nightSkyTheme: this._nightSkyTheme,
            });
            await this.skyRenderer.initialize();
        }

        const { StarRenderer } = await import('../starRenderer.js');
        this.starRenderer = new StarRenderer(this.backend);
        await this.starRenderer.initialize();
        
        const { MoonRenderer } = await import('../MoonRenderer.js');
        this.moonRenderer = new MoonRenderer(this.backend);
        await this.moonRenderer.initialize();
        
        const cloudConfig = {
            gridDimensions: { x: 32, y: 24, z: 32 },
            cloudAnisotropy: 0.75,
            volumetricLayerMode: 'lowOnly',
            cumulusEnabled: false,
            cirrusQuality: 'high'
        };
        if (this.backendType === 'webgpu') {
            const { WebGPUCloudRenderer } = await import('../clouds/webgpuCloudRenderer.js');
            this.cloudRenderer = new WebGPUCloudRenderer(this.backend, cloudConfig);
        }
        await this.cloudRenderer.initialize();
        
        if (this.planetConfig) {
            this.cloudRenderer.setPlanetConfig(this.planetConfig);
        }
        this.cloudRenderer.enabled = true;

        if (this.backendType === 'webgpu') {
            const weatherConfig = options.weatherConfig || {};
            this.weatherController = new WeatherController(this.backend, weatherConfig);
            await this.weatherController.initialize();
        }

        if (this.atmosphereLUT) {
            const { AerialPerspectiveTest } = await import('../../../tools/aerialPerspectiveTest.js');
            this.aerialTest = new AerialPerspectiveTest(
                this.backend,
                this.uniformManager,
                this.atmosphereLUT
            );
            await this.aerialTest.initialize();
        }
        this.clusterGrid = new ClusterGrid({
            gridSizeX: 16, gridSizeY: 8, gridSizeZ: 24,
            useLogarithmicDepth: true
        });
        
        this.lightManager = new ClusteredLightManager(this.clusterGrid, {
            maxLightsPerCluster: 32,
            maxLightIndices: 8192
        });
        
        // NEW: GPU buffer layer (WebGPU only)
        if (this.backendType === 'webgpu' && this.backend?.device) {
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

        await this._maybeInitGPUShadows();

        this.uniformManager.uniforms.ambientLightIntensity.value = 0.8;
        this.uniformManager.uniforms.ambientLightColor.value.set(0xffffff);
        this.uniformManager.uniforms.skyAmbientColor.value.set(0x87ceeb);
        this.uniformManager.uniforms.groundAmbientColor.value.set(0x8b7355);
        this.uniformManager.uniforms.sunLightIntensity.value = 1.0;
        this.uniformManager.uniforms.sunLightColor.value.set(0xffffff);
        this.uniformManager.uniforms.sunLightDirection.value.set(0.5, 1.0, 0.3).normalize();


        const { SkinnedMeshRenderer } = await import('../mesh/SkinnedMeshRenderer.js');
        this.skinnedMeshRenderer = new SkinnedMeshRenderer({
            backend: this.backend,
            uniformManager: this.uniformManager,
        });
        await this.skinnedMeshRenderer.initialize();

        return this;
    }


    _makeSurfaceMatrix(worldPos, planetOrigin, scale) {
        const up = new THREE.Vector3().subVectors(worldPos, planetOrigin).normalize();
        const ref = Math.abs(up.y) > 0.99
            ? new THREE.Vector3(0, 0, 1)
            : new THREE.Vector3(0, 1, 0);
        const right   = new THREE.Vector3().crossVectors(up, ref).normalize();
        const forward = new THREE.Vector3().crossVectors(right, up);
    
        const m = new THREE.Matrix4();
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
            pos = p.isVector3 ? p : new THREE.Vector3(p.x, p.y, p.z);
        } else {
            pos = this.camera.position.clone();
        }
    
        if (this.planetConfig?.origin) {
            const o = this.planetConfig.origin;
            const origin = new THREE.Vector3(o.x, o.y, o.z);
            return this._makeSurfaceMatrix(pos, origin, scale);
        }
        // Flat-world fallback
        const m = new THREE.Matrix4();
        m.makeTranslation(pos.x, pos.y, pos.z);
        if (scale !== 1) m.scale(new THREE.Vector3(scale, scale, scale));
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
    return await this.skinnedMeshRenderer.addInstance(asset, worldMatrix);
}
    updateLighting(starSystem) {
        this._updateGlobalLighting(starSystem);
        this._updateClusteredLighting();
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
            position: new THREE.Vector3(position.x, position.y, position.z),
            color: new THREE.Color(color.r, color.g, color.b),
            intensity,
            radius,
            decay
        });
    }
    
    addSpotLight(position, direction, color, intensity, radius, angle, penumbra = 0.1) {
        if (!this.lightManager) return null;
        return this.lightManager.addLight(2, {
            position: new THREE.Vector3(position.x, position.y, position.z),
            direction: new THREE.Vector3(direction.x, direction.y, direction.z),
            color: new THREE.Color(color.r, color.g, color.b),
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
    }



    async render(gameState, environmentState, deltaTime, planetConfig, sphericalMapper, starSystem) {
        
        if (!this.textureManager?.loaded ) return;
        this._lastDeltaTime = Number.isFinite(deltaTime) ? deltaTime : 0;
        
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

        const doValidationScope = this.backendType === 'webgpu' &&
            this.backend.device &&
            (this.debugMode || (this._validationScopeInterval > 0 && (this.frameCount % this._validationScopeInterval) === 0));
        if (doValidationScope) {
            this.backend.device.pushErrorScope('validation');
        }

        this.frameCount++;

        if (this.textureCache?.processDeferredDestructions) {
            this.textureCache.processDeferredDestructions();
        }

        this.updateCamera(gameState);
        if (this.planetConfig && this.uniformManager.currentPlanetConfig !== this.planetConfig) {
            this.uniformManager.updateFromPlanetConfig(this.planetConfig);
        }

        await this.updateChunks(gameState, environmentState, deltaTime, planetConfig, sphericalMapper);
        
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

        // --- UPDATED OCEAN UPDATE LOGIC ---
        // Pass the computed values from environmentState directly to the renderer
        if (this.globalOceanRenderer && environmentState && environmentState.water) {
            const waterParams = environmentState.water;
            const windDir = environmentState.windDirection;
            
            this.globalOceanRenderer.setWaterConfig({
                windDirection: [windDir.x, windDir.y],
                windSpeed: environmentState.windSpeed,
                waveHeight: waterParams.waveHeight,
                waveFrequency: waterParams.waveFrequency,
                foamIntensity: waterParams.foamIntensity,
                foamDepthEnd: waterParams.foamDepthEnd
                // Colors are now handled by initial config, or we can expose setters in GlobalOceanRenderer
            });
        }

        this.backend.setRenderTarget(null);
        this.backend.setClearColor(0.0, 0.0, 0.0, 1.0);
        this.backend.clear(true, true, false);

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

        if (this.cloudRenderer && this.cloudRenderer.enabled && !environmentState?.disableClouds) {
            this.cloudRenderer.renderCirrus?.(this.camera, environmentState, this.uniformManager);
        }
        
        this.renderTerrain();

        if (!this.isGPUQuadtreeActive() && this.skinnedMeshRenderer?.isReady()) {
            this.skinnedMeshRenderer.render(
                this.camera,
                this.camera.matrixWorldInverse,
                this.camera.projectionMatrix
            );
        }

        if (this.genericMeshRenderer) {
            this.genericMeshRenderer.update(this.camera.position, deltaTime);
            this.genericMeshRenderer.render(
                this.camera.matrixWorldInverse,
                this.camera.projectionMatrix
            );
        }

        if (this.cloudRenderer && this.cloudRenderer.enabled && !environmentState?.disableClouds) {
            this.cloudRenderer.update(this.camera, environmentState, this.uniformManager);
            this.cloudRenderer.render(this.camera, environmentState, this.uniformManager);
        }


        if (this.backendType === 'webgpu') {
            this.backend.submitCommands();
            this._actorManager?.resolveReadback();
            if (this.quadtreeTileManager?.resolveFeedbackReadback) {
                this.quadtreeTileManager.resolveFeedbackReadback();
            }
            if (doValidationScope) {
                const error = await this.backend.device.popErrorScope();
                if (error) {
                    
                }
            }
        }
    }

    async _maybeInitGPUShadows() {
        if (this.gpuShadowRenderer) return;
        if (!this.gpuQuadtreeEnabled) return;
        if (this.backendType !== 'webgpu' || !this.backend?.device) return;
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
                cascadeSplits: [50, 150, 400],
                shadowMapSizes:  [2048, 2048, 1024],
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
/*
        if (this.assetStreamer) {
            this.assetStreamer.setShadowRenderer(this.gpuShadowRenderer);
        }
        if (this.quadtreeTerrainRenderer) {
            this.quadtreeTerrainRenderer.setShadowRenderer(this.gpuShadowRenderer);
        }*/
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

    renderTerrain() {
        const useGPUQuadtree = this.isGPUQuadtreeActive();

    if (useGPUQuadtree) {
        const viewMatrix = this.camera.matrixWorldInverse;
        const projectionMatrix = this.camera.projectionMatrix;
        
        if (this.backendType === 'webgpu' && this.quadtreeTileManager) {
            this.backend.endRenderPassForCompute();
            const encoder = this.backend.getCommandEncoder();
            
            // Dispatch clustered light assignment compute
            if (this.clusterLightBuffers) {
                this.clusterLightBuffers.dispatchCompute(encoder);
            }

            // === SHADOW PASSES ===
            if (this.gpuShadowRenderer?.isReady) {
                // Update cascade matrices based on camera and sun
                this.gpuShadowRenderer.updateCascadeParams(this.camera, encoder);
                
                // Cull visible tiles into shadow instance buffer
                this.gpuShadowRenderer.cullAndBuildIndirect(encoder);
                
                // Render depth to shadow maps
                this.gpuShadowRenderer.renderShadowPasses(encoder);
            }

            this.quadtreeTileManager.update(this.camera, encoder);
            this.backend.resumeRenderPass();
            
            // Pass shadow renderer to terrain for bind group creation
    
            this.quadtreeTerrainRenderer.render(this.camera, viewMatrix, projectionMatrix);

                if (this.globalOceanRenderer?.isReady?.()) {
                    const instanceBuffer = this.quadtreeTileManager?.getInstanceBuffer?.() || null;
                    const indirectBuffer = this.quadtreeTileManager?.getIndirectArgsBuffer?.() || null;
                    this.globalOceanRenderer.render(
                        this.camera,
                        viewMatrix,
                        projectionMatrix,
                        instanceBuffer,
                        indirectBuffer,
                        this._lastDeltaTime || 0
                    );
                }
                
                if (this.assetStreamer) {
                    this.backend.endRenderPassForCompute();
                    const encoder = this.backend.getCommandEncoder();
                    this.assetStreamer.update(encoder, this.camera);

                    // Dispatch pending click raycast
                    if (this._actorManager?._pendingClick) {
                        // _pendingClick is set by GameEngine's click handler
                        // We need access to it — GameEngine sets it on the actorManager
                    }

                    this._dispatchActorCompute(encoder);

                    this.backend.resumeRenderPass();
                    this.assetStreamer.render(this.camera, viewMatrix, projectionMatrix);

                    // Render destination marker during active render pass
                    if (this._actorManager?.destinationMarker?.active) {
                        this._actorManager.renderOverlays(
                            this.backend._renderPassEncoder,
                            this.camera,
                            this._lastDeltaTime
                        );
                    }
                } else if (this._actorManager) {
                    this.backend.endRenderPassForCompute();
                    const encoder = this.backend.getCommandEncoder();
                    this._dispatchActorCompute(encoder);
                    this.backend.resumeRenderPass();
                }   
                if (this.skinnedMeshRenderer?.isReady()) {
                    this.skinnedMeshRenderer.update(this._lastDeltaTime);
                    this.skinnedMeshRenderer.render(this.camera, viewMatrix, projectionMatrix);
                }
                
            }
            return;
        }
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
        this.backend.setViewport(0, 0, width, height);
    }

    async switchPlanet(planetConfig) {
        this.atmosphereSettings = requireObject(
            planetConfig.atmosphereSettings,
            'planetConfig.atmosphereSettings'
        );
        if (this.atmosphereLUT) {
            this.atmosphereLUT.invalidate();
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
        
        this.skinnedMeshRenderer?.dispose();
this.skinnedMeshRenderer = null;
        if (this.moonRenderer) {
            this.moonRenderer.dispose();
            this.moonRenderer = null;
        }
        if (this.gpuShadowRenderer) {
            this.gpuShadowRenderer.dispose();
            this.gpuShadowRenderer = null;
        }

        if (this.atmosphereLUT) {
            this.atmosphereLUT.dispose();
        }
        if (this.globalOceanRenderer) {
            this.globalOceanRenderer.dispose();
            this.globalOceanRenderer = null;
        }
        if (this.assetStreamer) {
            this.assetStreamer.dispose();
            this.assetStreamer = null;
        }
        this.lightManager.cleanup();
        this.shadowRenderer.cleanup();
        this.backend.dispose();
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
        const zAxis = new THREE.Vector3().subVectors(position, target).normalize();
        let up = new THREE.Vector3().copy(position).normalize();
        if (up.lengthSq() < 0.0001) up.set(0, 1, 0);
        const dot = Math.abs(zAxis.dot(up));
        if (dot > 0.99) up.set(0, 0, 1);
    
        const xAxis = new THREE.Vector3().crossVectors(up, zAxis).normalize();
        const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis);
    
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
