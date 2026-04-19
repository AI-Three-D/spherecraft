/**
 * StudioWorldEngine — lightweight world renderer for Spherecraft Studio.
 *
 * This is NOT the game engine. It has:
 *   - Full terrain rendering (same GPU pipeline as the game)
 *   - Free-fly camera: WASD + mouse look (no pointer lock needed)
 *   - Star / sun system for lighting
 *   - No game logic: no characters, no inventory, no NPCs
 *
 * Usage:
 *   const engine = new StudioWorldEngine(canvas, {
 *       engineConfig,
 *       gameDataConfig,
 *       terrainTheme,        // required: TERRAIN_SHADER_BUNDLE
 *       streamerTheme,       // required: full streamer theme
 *       nightSkyTheme,       // optional
 *       cloudLayerProvider,  // optional
 *   });
 *   await engine.start();
 *   // Then in your RAF loop:
 *   engine.update(dt, keysHeld, mouseDelta);
 *   await engine.render(dt);
 *   // When done:
 *   engine.dispose();
 *
 * All heavy imports come from core/ and templates/ which are stable.
 * wizard_game/ is never imported here — the caller provides configs.
 */

import { Frontend }              from '../../core/renderer/frontend/frontend.js';
import { Camera }                from '../../core/Camera.js';
import { PlanetConfig }          from '../../templates/configs/planetConfig.js';
import { SphericalChunkMapper }  from '../../core/planet/sphericalChunkMapper.js';
import { StarSystem }            from '../../core/celestial/StarSystem.js';
import { AltitudeZoneManager }   from '../../core/planet/altitudeZoneManager.js';
import { EnvironmentState }      from '../../core/environment/EnvironmentState.js';
import { GameTime }              from '../../wizard_game/gameTime.js';
import { TextureCache }          from '../../core/texture/textureCache.js';
import { TextureAtlasManager }   from '../../core/texture/TextureManager.js';
import { ProceduralTextureGenerator } from '../../core/texture/webgpu/textureGenerator.js';
import { Vector3 }               from '../../shared/math/index.js';
import { PlanetAtmosphereSettings } from '../../templates/configs/planetAtmosphereSettings.js';
import {
    TEXTURE_LEVELS, ATLAS_CONFIG, TextureConfigHelper, SEASONS, TILE_CONFIG
} from '../../templates/configs/TileConfig.js';
import { TEXTURE_CONFIG }        from '../../templates/configs/atlasConfig.js';
import { TILE_LAYER_HEIGHTS, TILE_TRANSITION_RULES } from '../../templates/configs/tileTransitionConfig.js';
import { WebGPUTerrainGenerator } from '../../core/world/webgpuTerrainGenerator.js';
import { TerrainRaycaster }      from '../../wizard_game/actors/nav/TerrainRaycaster.js';
import { BiomeQuery }            from '../../core/world/BiomeQuery.js';
import { createTerrainThemeForPlanet } from '../../wizard_game/TerrainThemeFactory.js';

export class StudioWorldEngine {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {object} options
     * @param {import('../../core/EngineConfig.js').EngineConfig} options.engineConfig
     * @param {object} options.gameDataConfig
     * @param {object} options.terrainTheme
     * @param {object} options.streamerTheme
     * @param {object} [options.nightSkyTheme]
     * @param {function} [options.cloudLayerProvider]
     */
    constructor(canvas, options = {}) {
        this.canvas         = canvas;
        this.engineConfig   = options.engineConfig;
        this.gameDataConfig = options.gameDataConfig;
        this._terrainTheme  = options.terrainTheme  ?? null;
        this._streamerTheme = options.streamerTheme ?? null;
        this._nightSkyTheme = options.nightSkyTheme ?? null;
        this._cloudLayerProvider = options.cloudLayerProvider ?? null;

        /**
         * Optional explicit spawn override.
         * Shape: { position: {x,y,z}, target: {x,y,z} }
         * If omitted, spawn is derived from gameDataConfig.spawn (same as the wizard game).
         */
        this._spawnConfig = options.spawnConfig ?? null;

        this.renderer     = null;
        this.camera       = null;
        this.starSystem   = null;
        this.planetConfig = null;
        this.gameTime     = null;
        this.environmentState = null;

        this._isRunning   = false;
        this._gameState   = null;

        // Camera position mirror — kept in sync for altitudeZoneManager / player state.
        this._camPos = new Vector3(0, 1000, 0);

        // Boost state (Shift to speed up)
        this._moveSpeed  = 80;    // m/s base
        this._boostMult  = 1;
        this._boostRate  = 8;
        this._terrainMaterialRefreshTimer = null;

        if (!this.engineConfig.rendering) this.engineConfig.rendering = {};
        this.engineConfig.rendering.terrainShader = {
            ...(this.engineConfig.rendering.terrainShader || {}),
            // Studio needs runtime layer switching without rebuilding materials.
            forceMacroOverlay: true,
        };
    }

    // ── Initialization ────────────────────────────────────────────────

    async start() {
        const { engineConfig, gameDataConfig, canvas } = this;

        this._updateCanvasSize();

        // ── Planet config ────────────────────────────────────────────
        const enabledPlanets = gameDataConfig.planets.filter(p => p.enabled);
        if (!enabledPlanets.length) throw new Error('StudioWorldEngine: no enabled planet in gameDataConfig');
        const activePlanet = enabledPlanets[0];

        const planetOptions = gameDataConfig.buildPlanetOptions(
            { surfaceChunkSize: engineConfig.chunkSizeMeters },
            activePlanet.id
        );
        this.planetConfig = new PlanetConfig({ ...planetOptions, engineConfig });
        this._runtimeTerrainTheme = createTerrainThemeForPlanet(this._terrainTheme, this.planetConfig);
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
            console.info(
                `[StudioWorldEngine] Planet "${this.planetConfig.name}" authoring: ` +
                `${worldAuthoringSummary.biomeCount} biomes, ` +
                `${worldAuthoringSummary.assetProfileCount} asset profiles, ` +
                `${worldAuthoringSummary.tileCatalogTileCount ?? 0} tile refs`
            );
        }
        this.altitudeZoneManager = new AltitudeZoneManager(this.planetConfig);
        this.planetConfig.altitudeZoneManager = this.altitudeZoneManager;
        this.sphericalMapper = new SphericalChunkMapper(this.planetConfig);

        // ── Star system ──────────────────────────────────────────────
        const starOpts = gameDataConfig.buildStarSystemOptions(this.planetConfig);
        this.starSystem = StarSystem.createTestSystem(this.planetConfig, starOpts);
        this.starSystem.autoTimeScale = gameDataConfig.starSystem.autoTimeScale ?? true;
        this.starSystem.update(0);

        // ── Game time ────────────────────────────────────────────────
        this.gameTime = new GameTime();
        this.gameTime.dayDurationMs = gameDataConfig.time.dayDurationMs;
        this.gameTime.startDay      = gameDataConfig.time.startDay;
        this.gameTime.currentDay    = gameDataConfig.time.startDay;
        const startHour = gameDataConfig.time.startHour ?? 12;
        this.gameTime.dayStartTime = Date.now() - (startHour / 24) * this.gameTime.dayDurationMs;

        // ── Renderer ─────────────────────────────────────────────────
        this.textureCache = new TextureCache();
        this.renderer = new Frontend(canvas, {
            textureCache:   this.textureCache,
            chunkSize:      engineConfig.chunkSizeMeters,
            lodDistances:   engineConfig.lod.distancesMeters,
            engineConfig,
            gpuQuadtree:    engineConfig.gpuQuadtree,
            streamerTheme:  this._streamerTheme,
            nightSkyTheme:  this._nightSkyTheme,
            terrainTheme:   this._runtimeTerrainTheme,
        });
        await this.renderer.initialize(this.planetConfig, this.sphericalMapper, {
            weatherConfig: {
                cloudLayerProvider: this._cloudLayerProvider ?? (() => [])
            }
        });

        // ── Texture atlas ────────────────────────────────────────────
        const gpuDevice = this.renderer.backend.device;
        this.proceduralTexGen = new ProceduralTextureGenerator(gpuDevice, 128, 128);
        await this.proceduralTexGen.initialize();

        this.textureManager = new TextureAtlasManager(false, gpuDevice, this.proceduralTexGen, {
            TILE_CONFIG: this.planetConfig.tileConfig || TILE_CONFIG,
            TEXTURE_LEVELS,
            ATLAS_CONFIG,
            TEXTURE_CONFIG: this.planetConfig.atlasConfig || TEXTURE_CONFIG,
            TextureConfigHelper, SEASONS, TILE_LAYER_HEIGHTS, TILE_TRANSITION_RULES
        });
        this.textureManager.backend = this.renderer.backend;
        this.renderer.textureManager = this.textureManager;
        await this.textureManager.initializeAtlases(true);

        // ── Terrain generator ────────────────────────────────────────
        this.terrainGenerator = new WebGPUTerrainGenerator(
            gpuDevice,
            engineConfig.seed,
            engineConfig.chunkSizeMeters,
            engineConfig.macroConfig,
            engineConfig.splatConfig,
            this.textureCache,
            { planetConfig: this.planetConfig, terrainTheme: this._runtimeTerrainTheme }
        );
        await this.terrainGenerator.initialize();

        if (engineConfig.gpuQuadtree?.enabled) {
            await this.renderer.initializeGPUQuadtree(this.terrainGenerator);
        }

        // ── Environment ──────────────────────────────────────────────
        this.environmentState = new EnvironmentState(this.gameTime, this.planetConfig);

        // ── Terrain raycaster & biome query ──────────────────────────
        try {
            const tileManager = this.renderer?.quadtreeTileManager;
            const ts = tileManager?.tileStreamer;
            if (ts && gpuDevice) {
                this._terrainRaycaster = new TerrainRaycaster(gpuDevice, ts);
                this._terrainRaycaster.initialize();
                this._biomeQuery = new BiomeQuery(gpuDevice, ts);
                this._biomeQuery.initialize();
                console.info('[StudioWorldEngine] Biome hover query is sampling tile/height/normal/climate textures');
            }
        } catch (e) {
            console.warn('[StudioWorldEngine] Could not init terrain raycaster/biome query:', e.message);
        }

        // ── Camera ───────────────────────────────────────────────────
        const origin = this.planetConfig.origin;
        const radius = this.planetConfig.radius;

        this.camera = new Camera({
            aspect: canvas.width / canvas.height,
            fov:    engineConfig.camera?.fov  ?? 75,
            near:   engineConfig.camera?.near ?? 0.1,
            far:    engineConfig.camera?.far  ?? 150000,
            cameraDistance: 0,
            cameraHeight: 0,
            lookAtSmoothing: 0,
            lookAheadDistance: 0,
            lookAheadHeight: 0,
        });
        this.camera.setPlanetCenter({ x: origin.x, y: origin.y, z: origin.z });

        // Place camera at spawn — explicit spawnConfig wins, otherwise mirror
        // the wizard game's _computeSpawn() logic exactly.
        const spawnPos = this._spawnConfig
            ? this._spawnConfig.position
            : this._computeSpawn(gameDataConfig.spawn, origin, radius);

        this.camera.setPosition(spawnPos.x, spawnPos.y, spawnPos.z);

        // Target: use explicit target or look toward the planet's horizon (+Z tangent)
        if (this._spawnConfig?.target) {
            this.camera.lookAt(
                this._spawnConfig.target.x,
                this._spawnConfig.target.y,
                this._spawnConfig.target.z,
            );
        } else {
            // Build a tangent vector so the camera looks at the terrain, not into space
            const toSurface = {
                x: spawnPos.x - origin.x,
                y: spawnPos.y - origin.y,
                z: spawnPos.z - origin.z,
            };
            const len = Math.sqrt(toSurface.x**2 + toSurface.y**2 + toSurface.z**2) || 1;
            const up = { x: toSurface.x/len, y: toSurface.y/len, z: toSurface.z/len };
            // Pick a tangent direction perpendicular to up
            const ref = Math.abs(up.y) < 0.9 ? { x:0, y:1, z:0 } : { x:1, y:0, z:0 };
            const tangent = {
                x: up.y*ref.z - up.z*ref.y,
                y: up.z*ref.x - up.x*ref.z,
                z: up.x*ref.y - up.y*ref.x,
            };
            const tlen = Math.sqrt(tangent.x**2 + tangent.y**2 + tangent.z**2) || 1;
            this.camera.lookAt(
                spawnPos.x + tangent.x/tlen * 200,
                spawnPos.y + tangent.y/tlen * 200,
                spawnPos.z + tangent.z/tlen * 200,
            );
        }

        // Mirror initial position into _camPos for altitudeZoneManager
        this._camPos.set(
            this.camera.position.x,
            this.camera.position.y,
            this.camera.position.z,
        );

        this._isRunning = true;
    }

    // ── Per-frame ─────────────────────────────────────────────────────

    /**
     * @param {number}  dt            seconds since last frame
     * @param {object}  keys          key-held map { 'w':true, ... }
     * @param {{ x:number, y:number }} mouseDelta  accumulated mouse delta this frame
     * @param {boolean} [isLeftDragging]  true while left mouse button held (enables look)
     * @param {boolean} [shiftHeld]
     */
    update(dt, keys = {}, mouseDelta = { x: 0, y: 0 }, isLeftDragging = false, shiftHeld = false) {
        if (!this._isRunning) return;
        dt = Math.min(dt, 0.1);

        // ── Boost ────────────────────────────────────────────────────
        if (shiftHeld) {
            this._boostMult = Math.min(8, this._boostMult + this._boostRate * dt);
        } else {
            this._boostMult = Math.max(1, this._boostMult - this._boostRate * dt);
        }

        // ── Mouse look (left drag only, same as wizard game) ─────────
        if (isLeftDragging) {
            this.camera.handleManualLook(mouseDelta.x, mouseDelta.y);
        }

        // ── WASD movement via Camera.moveRelative ────────────────────
        const speed = this._moveSpeed * this._boostMult * dt;
        let fwd = 0, right = 0, up = 0;
        if (keys['w'] || keys['W']) fwd   += speed;
        if (keys['s'] || keys['S']) fwd   -= speed;
        if (keys['a'] || keys['A']) right -= speed;
        if (keys['d'] || keys['D']) right += speed;
        if (keys['e'] || keys['E']) up    += speed;
        if (keys['q'] || keys['Q']) up    -= speed;
        if (fwd !== 0 || right !== 0 || up !== 0) {
            this.camera.moveRelative(fwd, right, up);
        }

        // ── Keep _camPos in sync for altitudeZoneManager/player ──────
        this._camPos.set(
            this.camera.position.x,
            this.camera.position.y,
            this.camera.position.z,
        );

        // ── Time + star system ───────────────────────────────────────
        this.gameTime.update();
        if (this.starSystem) {
            const dayFraction = (this.gameTime.timeOfDay % 24) / 24;
            if (this.starSystem.currentBody) {
                this.starSystem.currentBody.currentRotation = dayFraction * Math.PI * 2;
            }
            this.starSystem.update(dt);
        }

        if (this.altitudeZoneManager) {
            this.altitudeZoneManager.update(this._camPos, dt);
        }

        this._gameState = {
            time:    performance.now(),
            player:  { position: this._camPos },
            camera:  this.camera,
            altitudeZoneManager: this.altitudeZoneManager,
        };
    }

    async render(dt) {
        if (!this._isRunning || !this._gameState) return;
        if (this._renderInFlight) return;
        this._renderInFlight = true;
        try {
            await this.renderer.render(
                this._gameState,
                this.environmentState,
                Math.min(dt, 0.1),
                this.planetConfig,
                this.sphericalMapper,
                this.starSystem
            );
        } finally {
            this._renderInFlight = false;
        }
    }

    dispose() {
        this._isRunning = false;
        if (this._terrainMaterialRefreshTimer != null) {
            clearTimeout(this._terrainMaterialRefreshTimer);
            this._terrainMaterialRefreshTimer = null;
        }
        this._terrainRaycaster?.dispose();
        this._biomeQuery?.dispose();
    }

    // ── Terrain raycaster & biome query ──────────────────────────────

    /** @returns {TerrainRaycaster|null} */
    get terrainRaycaster() { return this._terrainRaycaster ?? null; }

    /** @returns {BiomeQuery|null} */
    get biomeQuery() { return this._biomeQuery ?? null; }

    /**
     * Get the GPU resources needed for terrain queries.
     * @returns {{textures: object, hashBuf: GPUBuffer, quadtreeGPU: object}|null}
     */
    getQueryResources() {
        const tileManager = this.renderer?.quadtreeTileManager;
        if (!tileManager) return null;
        const ts = tileManager.tileStreamer;
        const qgpu = tileManager.quadtreeGPU ?? ts?.quadtreeGPU;
        if (!ts || !qgpu) return null;

        const textures = ts.getArrayTextures?.() ?? {};
        const hashBuf = qgpu.getLoadedTileTableBuffer?.() ?? null;
        if (!hashBuf) return null;

        return {
            textures,
            hashBuf,
            quadtreeGPU: {
                faceSize: qgpu.faceSize ?? (this.planetConfig?.radius * 2),
                loadedTableMask: qgpu.loadedTableMask ?? 0,
                loadedTableCapacity: qgpu.loadedTableCapacity ?? 0,
                maxDepth: qgpu.maxDepth ?? 12,
                tileTextureSize: ts.tileTextureSize ?? 128,
            },
        };
    }

    /**
     * Create a GPU command encoder, suitable for dispatch + submit.
     * @returns {GPUCommandEncoder}
     */
    createCommandEncoder() {
        return this.renderer?.backend?.device?.createCommandEncoder({ label: 'Studio-Query' }) ?? null;
    }

    /**
     * Submit a GPU command encoder.
     * @param {GPUCommandEncoder} encoder
     */
    submitEncoder(encoder) {
        this.renderer?.backend?.device?.queue?.submit([encoder.finish()]);
    }

    /**
     * Build a screen-space ray from a pixel position on the canvas.
     * @param {number} screenX
     * @param {number} screenY
     * @returns {{origin:{x,y,z}, dir:{x,y,z}}}
     */
    screenToRay(screenX, screenY) {
        if (!this.camera) return null;
        const dpr = window.devicePixelRatio || 1;
        const w = this.canvas.clientWidth;
        const h = this.canvas.clientHeight;
        const ndcX = (screenX / w) * 2 - 1;
        const ndcY = 1 - (screenY / h) * 2;

        const cam = this.camera;
        const fov = cam.fov ?? 75;
        const aspect = w / h;
        const tanHalf = Math.tan((fov * Math.PI / 180) / 2);

        // Camera basis vectors
        const fwd = cam.getForward ? cam.getForward() : this._cameraForward();
        const right = cam.getRight ? cam.getRight() : this._cameraRight(fwd);
        const up = this._cross(right, fwd);

        const dir = {
            x: fwd.x + right.x * ndcX * tanHalf * aspect + up.x * ndcY * tanHalf,
            y: fwd.y + right.y * ndcX * tanHalf * aspect + up.y * ndcY * tanHalf,
            z: fwd.z + right.z * ndcX * tanHalf * aspect + up.z * ndcY * tanHalf,
        };
        const len = Math.sqrt(dir.x ** 2 + dir.y ** 2 + dir.z ** 2) || 1;

        return {
            origin: { x: cam.position.x, y: cam.position.y, z: cam.position.z },
            dir: { x: dir.x / len, y: dir.y / len, z: dir.z / len },
        };
    }

    _cameraForward() {
        const cam = this.camera;
        if (cam._forward) return { x: cam._forward.x, y: cam._forward.y, z: cam._forward.z };
        if (cam.target && cam.position) {
            const dx = cam.target.x - cam.position.x;
            const dy = cam.target.y - cam.position.y;
            const dz = cam.target.z - cam.position.z;
            const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
            return { x: dx / len, y: dy / len, z: dz / len };
        }
        return { x: 0, y: 0, z: -1 };
    }

    _cameraRight(fwd) {
        const upWorld = this._surfaceUp();
        return this._cross(fwd, upWorld);
    }

    _surfaceUp() {
        const o = this.planetConfig?.origin || { x: 0, y: 0, z: 0 };
        const p = this.camera?.position || { x: 0, y: 1, z: 0 };
        const dx = p.x - o.x, dy = p.y - o.y, dz = p.z - o.z;
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
        return { x: dx / len, y: dy / len, z: dz / len };
    }

    _cross(a, b) {
        const cx = a.y * b.z - a.z * b.y;
        const cy = a.z * b.x - a.x * b.z;
        const cz = a.x * b.y - a.y * b.x;
        const len = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1;
        return { x: cx / len, y: cy / len, z: cz / len };
    }

    // ── Realtime param setters ────────────────────────────────────────

    get postProcessing() { return this.renderer?.postProcessing ?? null; }

    /** @param {number} v */
    set exposure(v) {
        const pp = this.postProcessing;
        if (pp?.toneMappingPass) pp.toneMappingPass.exposure = v;
    }

    setBloom({ threshold, knee, intensity, blendFactor }) {
        const pp = this.postProcessing;
        if (!pp?.bloomPass) return;
        if (threshold   != null) pp.bloomPass.threshold   = threshold;
        if (knee        != null) pp.bloomPass.knee        = knee;
        if (intensity   != null) pp.bloomPass.intensity   = intensity;
        if (blendFactor != null) pp.bloomPass.blendFactor = blendFactor;
    }

    /**
     * Apply ambient lighting config to the running renderer.
     * @param {object} ambient  { intensityMultiplier, minIntensity, maxIntensity, ... }
     */
    setAmbientLighting(ambient) {
        const um = this.renderer?.uniformManager;
        if (um?.applyAmbientConfig) um.applyAmbientConfig(ambient);
        const lc = this.renderer?.lightingController;
        if (lc && um?.updateFromLightingController) um.updateFromLightingController(lc);
    }

    /**
     * Apply fog config to the running renderer.
     * @param {object} fog  { densityMultiplier, maxBaseDensity, dayDensityScale, nightDensityScale, ... }
     */
    setFog(fog) {
        const um = this.renderer?.uniformManager;
        if (um?.applyFogConfig) um.applyFogConfig(fog);
        const lc = this.renderer?.lightingController;
        if (lc && um?.updateFromLightingController) um.updateFromLightingController(lc);
    }

    /**
     * Apply terrain shader config to the running renderer.
     * @param {object} ts  { ambientScale, aerialFadeStartMeters, aerialFadeEndMeters, ... }
     */
    setTerrainShader(ts) {
        if (!ts || typeof ts !== 'object') return;
        if (!this.engineConfig?.rendering) this.engineConfig.rendering = {};
        this.engineConfig.rendering.terrainShader = {
            ...(this.engineConfig.rendering.terrainShader || {}),
            ...ts,
        };
        this._scheduleTerrainMaterialRefresh();
    }

    /**
     * Apply terrain AO config to the running renderer.
     * @param {object} terrainAO  { sampleStrength, directStrength, ambientFloor }
     */
    setTerrainAO(terrainAO) {
        if (!terrainAO || typeof terrainAO !== 'object') return;
        this.engineConfig.terrainAO = {
            ...(this.engineConfig.terrainAO || {}),
            ...terrainAO,
        };
        this._scheduleTerrainMaterialRefresh();
    }

    setTerrainHoverOverlay(overlay) {
        this.renderer?.quadtreeTerrainRenderer?.setTerrainHoverOverlay?.(overlay ?? null);
    }

    setTerrainLayerViewMode(mode = 0) {
        this.renderer?.quadtreeTerrainRenderer?.setTerrainLayerViewMode?.(mode ?? 0);
    }

    /**
     * Update atmosphere scattering options in the running renderer.
     * This regenerates the atmosphere LUT which is a fast GPU operation.
     * @param {object} opts  { visualDensity, sunIntensity, mieAnisotropy, scaleHeightRayleighRatio, scaleHeightMieRatio }
     */
    setAtmosphere(opts) {
        if (!opts || typeof opts !== 'object' || !this.planetConfig) return;

        Object.assign(this.planetConfig.atmosphereOptions, {
            ...opts,
            atmosphereThickness: this.planetConfig.atmosphereHeight,
            densityFalloffRayleigh: opts.scaleHeightRayleighRatio ?? this.planetConfig.atmosphereOptions.densityFalloffRayleigh,
            densityFalloffMie: opts.scaleHeightMieRatio ?? this.planetConfig.atmosphereOptions.densityFalloffMie,
        });

        if (Number.isFinite(opts.scaleHeightRayleighRatio)) {
            this.planetConfig.atmosphereOptions.densityFalloffRayleigh = opts.scaleHeightRayleighRatio;
        }
        if (Number.isFinite(opts.scaleHeightMieRatio)) {
            this.planetConfig.atmosphereOptions.densityFalloffMie = opts.scaleHeightMieRatio;
        }

        this.planetConfig.atmosphereSettings = PlanetAtmosphereSettings.createForPlanet(
            this.planetConfig.radius,
            this.planetConfig.atmosphereOptions
        );
        this.renderer.atmosphereSettings = this.planetConfig.atmosphereSettings;
        this.renderer.uniformManager?.updateFromPlanetConfig(this.planetConfig);
        this.renderer.atmosphereLUT?.invalidate?.();
    }

    async refreshTextureConfig(textureConfig) {
        if (!textureConfig || !this.textureManager || !this.renderer?.quadtreeTerrainRenderer) return;

        this.planetConfig.atlasConfig = textureConfig;
        this.textureManager.TEXTURE_CONFIG = textureConfig;

        for (const atlas of this.textureManager.atlases.values()) {
            atlas.texture = null;
            atlas.canvas = null;
            atlas.context = null;
            atlas.layout = null;
            atlas.textureMap.clear();
            atlas.seasonalTextureMap.clear();
        }

        this.textureManager.loaded = false;
        await this.textureManager.initializeAtlases(true);
        await this.renderer.quadtreeTerrainRenderer.rebuildMaterials();
    }

    _scheduleTerrainMaterialRefresh() {
        if (this._terrainMaterialRefreshTimer != null) {
            clearTimeout(this._terrainMaterialRefreshTimer);
        }
        this._terrainMaterialRefreshTimer = window.setTimeout(() => {
            this._terrainMaterialRefreshTimer = null;
            this.renderer?.quadtreeTerrainRenderer?.rebuildMaterials?.().catch((error) => {
                console.warn('[StudioWorldEngine] Failed to rebuild terrain materials:', error);
            });
        }, 80);
    }

    // ── Helpers ───────────────────────────────────────────────────────

    /**
     * Mirror of GameEngine._computeSpawn() — places the camera on the sun-facing
     * side of the planet when spawnOnSunSide is true.
     */
    _computeSpawn(spawnConfig, origin, radius) {
        const sp     = spawnConfig ?? {};
        const height = sp.height  ?? 800;

        if (
            sp.spawnOnSunSide &&
            this.starSystem?.currentBody &&
            this.starSystem?.primaryStar
        ) {
            this.starSystem.update(0);
            const starInfo = this.starSystem.currentBody.getStarDirection(
                this.starSystem.primaryStar,
                origin,
            );
            const sunDir = starInfo?.direction;
            if (sunDir) {
                const r = radius + height;
                return {
                    x: origin.x + sunDir.x * r,
                    y: origin.y + sunDir.y * r,
                    z: origin.z + sunDir.z * r,
                };
            }
        }

        // Fallback: same as gameEngine fallback
        return {
            x: origin.x + (sp.defaultX ?? 0),
            y: origin.y + radius + height,
            z: origin.z + (sp.defaultZ ?? 0),
        };
    }

    _updateCanvasSize() {
        const dpr = window.devicePixelRatio || 1;
        const w   = Math.floor(this.canvas.clientWidth  * dpr);
        const h   = Math.floor(this.canvas.clientHeight * dpr);
        if (this.canvas.width !== w) this.canvas.width  = w;
        if (this.canvas.height !== h) this.canvas.height = h;
    }
}
