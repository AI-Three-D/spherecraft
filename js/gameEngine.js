// js/gameEngine.js

import { Frontend } from './renderer/frontend/frontend.js';
import { Camera } from './Camera.js';
import { GameTime } from './gameTime.js';
import { EnvironmentState } from './environment/EnvironmentState.js';
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.178.0/build/three.module.js';
import { TextureAtlasManager } from './texture/TextureManager.js';
import { Spaceship } from './game/spaceShip.js';
import { SpaceshipModel } from './game/spaceShipModel.js';
import { AltitudeController } from './game/altitudeController.js';
import { GameInputManager } from './GameInputManager.js';
import { TextureCache } from './texture/textureCache.js';
import { AltitudeZoneManager } from './planet/altitudeZoneManager.js';
import { PlanetConfig } from './config/planetConfig.js';
import { SphericalChunkMapper } from './planet/sphericalChunkMapper.js';
import { StarSystem } from './celestial/StarSystem.js';
import { EngineConfig } from './config/EngineConfig.js';
import { GameDataConfig } from './config/GameDataConfig.js';
import { Logger } from './config/Logger.js';
import { GameUI } from './ui/GameUI.js';
import { WebGPUTerrainGenerator } from './world/webgpuTerrainGenerator.js';
import { ProceduralTextureGenerator } from './texture/webgpu/textureGenerator.js';
import { PropTextureManager } from './texture/PropTextureManager.js';
import { PropMaterialFactory } from './renderer/streamer/species/PropMaterialFactory.js';

function updateCanvasResolution(canvas) {
    const displayWidth = canvas.clientWidth;
    const displayHeight = canvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;

    const width = Math.floor(displayWidth * dpr);
    const height = Math.floor(displayHeight * dpr);

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
        this.ui = new GameUI();

        window.gameEngine = this;

        this._fps = 0;
        this._fpsFrames = 0;
        this._fpsLastSample = performance.now();
        this._manualShiftMultiplier = 1;
        this._lastUIUpdate = 0;
        this._uiUpdateIntervalMs = this.engineConfig.ui.updateIntervalMs;
        this._renderInFlight = false;
    }

    toggleCameraMode() {
        this.cameraMode = this.cameraMode === 'manual' ? 'follow' : 'manual';

        if (this.cameraMode === 'follow') {
            this.camera.follow(this.spaceship);
            this.camera.resetOrbit();
        } else {
            this.camera.unfollow();
        }
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

        const backendType = 'webgpu';

        this.renderer = new Frontend(this.canvas, {
            textureCache: this.textureCache,
            chunkSize: this.chunkSize,
            backendType: backendType,
            lodDistances: this.engineConfig.lod.distancesMeters,
            engineConfig: this.engineConfig,
            gpuQuadtree: this.engineConfig.gpuQuadtree
        });
        await this.renderer.initialize(this.planetConfig, this.sphericalMapper, {
            weatherConfig: this.engineConfig.weather
        });

        const actualApiName = this.renderer.getBackendType();
Logger.info(`[GameEngine] Renderer using ${actualApiName} backend`);

const gpuDevice = this.renderer.backend.device;

// ── Shared procedural texture generator ───────────────────────────────
// Created once here, injected into both terrain-atlas and prop-atlas
// managers. setSize() is called by consumers before generation, so the
// initial 128×128 is just a default.
this.proceduralTextureGenerator = new ProceduralTextureGenerator(gpuDevice, 128, 128);
await this.proceduralTextureGenerator.initialize();

// ── Terrain texture atlas ─────────────────────────────────────────────
this.textureManager = new TextureAtlasManager(false, gpuDevice, this.proceduralTextureGenerator);
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
    baseSeed: this.engineConfig.seed ?? 12345
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
            }

        );
        await this.terrainGenerator.initialize();

        console.log('WebGPUTerrainGenerator initialized', this.terrainGenerator);
        if (this.engineConfig.gpuQuadtree?.enabled && this.renderer.getBackendType() === 'webgpu') {
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

        // Calculate spawn position from configuration
        const spawnConfig = this.gameDataConfig.spawn;
        let spawnX = spawnConfig.defaultX;
        let spawnY = spawnConfig.defaultY;
        let spawnZ = spawnConfig.defaultZ;

        if (this.planetConfig) {
            const spawnHeight = spawnConfig.height;
            const radius = this.planetConfig.radius;

            if (spawnConfig.spawnOnSunSide && this.starSystem && this.starSystem.currentBody && this.starSystem.primaryStar) {
                this.starSystem.update(0);

                const starInfo = this.starSystem.currentBody.getStarDirection(
                    this.starSystem.primaryStar,
                    { x: 0, y: 0, z: 0 }
                );

                const sunDir = starInfo.direction;
                spawnX = sunDir.x * (radius + spawnHeight);
                spawnY = sunDir.y * (radius + spawnHeight);
                spawnZ = sunDir.z * (radius + spawnHeight);
            } else {
                spawnX = 0;
                spawnY = radius + spawnHeight;
                spawnZ = 0;
            }
        }

        this.spaceship.reset(spawnX, spawnY, spawnZ);
        this.camera.follow(this.spaceship);

        this.inputManager.start();
        this.isGameActive = true;

        {
            const offset = new THREE.Vector3().subVectors(
                new THREE.Vector3(spawnX, spawnY, spawnZ),
                new THREE.Vector3(
                    this.planetConfig.origin.x,
                    this.planetConfig.origin.y,
                    this.planetConfig.origin.z
                )
            ).normalize();
            const modelPos = new THREE.Vector3(
                spawnX - offset.x * 10,
                spawnY - offset.y * 10,
                spawnZ - offset.z * 10
            );
        
            this.renderer.loadGLB('/assets/test-wiz.glb', {
                position: modelPos,
                scale: 100.0
            }).then(inst => {
                if (!inst) return;
                this._glbTestInstance = inst;
                // Auto-play first animation if present
                if (inst.asset.animations.length > 0) {
                    this.renderer.playGLBAnimation(inst, 0, { speed: 1.0 });
                    Logger.info(`[GameEngine] Playing animation "${inst.asset.animations[0].name}"`);
                }
            }).catch(e => Logger.warn(`[GameEngine] GLB load failed: ${e.message}`));
        }
        Logger.info('[GameEngine] Initialization complete');
    }

    stop() {
        this.isGameActive = false;
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

        const cameraRenderPos = new THREE.Vector3(
            this.camera.position.x,
            this.camera.position.y,
            this.camera.position.z
        );

        if (this.altitudeZoneManager) {
            this.altitudeZoneManager.update(cameraRenderPos, deltaTime);
        }

        if (this.cameraMode === 'manual') {
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
        const spawnConfig = this.gameDataConfig.spawn;
        this.spaceship.reset(spawnConfig.defaultX, spawnConfig.defaultY, spawnConfig.defaultZ);
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

        this.ui.update({
            fps: this._fps,
            cameraMode: this.cameraMode,
            shipState: shipState,
            zoneInfo: zoneInfo
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
        if (mode >= 25 && mode <= 34) {
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
        const result = updateCanvasResolution(this.canvas);

        if (result.changed) {
            if (this.renderer && this.renderer.backend) {
                this.renderer.backend.setViewport(0, 0, result.width, result.height);
            }

            if (this.camera) {
                this.camera.aspect = result.width / result.height;

                if (this.renderer && this.renderer.camera) {
                    this.renderer.camera.aspect = result.width / result.height;
                    this.renderer._updateCameraMatrices();
                }
            }
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
}


window.planetInfo = () => {
    if (window.gameEngine) {
        window.gameEngine.printPlanetConfig();
    }
};
