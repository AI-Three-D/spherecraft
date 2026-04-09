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
import {
    TEXTURE_LEVELS, ATLAS_CONFIG, TextureConfigHelper, SEASONS, TILE_CONFIG
} from '../../templates/configs/TileConfig.js';
import { TEXTURE_CONFIG }        from '../../templates/configs/atlasConfig.js';
import { TILE_LAYER_HEIGHTS, TILE_TRANSITION_RULES } from '../../templates/configs/tileTransitionConfig.js';
import { WebGPUTerrainGenerator } from '../../core/world/webgpuTerrainGenerator.js';

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
            terrainTheme:   this._terrainTheme,
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
            TILE_CONFIG, TEXTURE_LEVELS, ATLAS_CONFIG, TEXTURE_CONFIG,
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
            { planetConfig: this.planetConfig, terrainTheme: this._terrainTheme }
        );
        await this.terrainGenerator.initialize();

        if (engineConfig.gpuQuadtree?.enabled) {
            await this.renderer.initializeGPUQuadtree(this.terrainGenerator);
        }

        // ── Environment ──────────────────────────────────────────────
        this.environmentState = new EnvironmentState(this.gameTime, this.planetConfig);

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

        // Place camera at spawn — explicit spawnConfig wins, otherwise use
        // gameDataConfig.spawn (same defaults as the wizard game).
        if (this._spawnConfig) {
            const { position, target } = this._spawnConfig;
            this.camera.setPosition(position.x, position.y, position.z);
            if (target) {
                this.camera.lookAt(target.x, target.y, target.z);
            } else {
                // Look horizontally toward +Z if no target given
                this.camera.lookAt(position.x, position.y, position.z + 100);
            }
        } else {
            const sp = gameDataConfig.spawn;
            const sx = origin.x + (sp?.defaultX ?? 0);
            const sy = origin.y + radius + (sp?.height ?? 800);
            const sz = origin.z + (sp?.defaultZ ?? 0);
            this.camera.setPosition(sx, sy, sz);
            // Look toward the horizon (same horizontal plane, offset in +Z)
            this.camera.lookAt(sx, sy, sz + 100);
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
        // TODO: destroy GPU resources
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

    // ── Helpers ───────────────────────────────────────────────────────

    _updateCanvasSize() {
        const dpr = window.devicePixelRatio || 1;
        const w   = Math.floor(this.canvas.clientWidth  * dpr);
        const h   = Math.floor(this.canvas.clientHeight * dpr);
        if (this.canvas.width !== w) this.canvas.width  = w;
        if (this.canvas.height !== h) this.canvas.height = h;
    }

    _applyFreeFlyToCamera() {
        if (!this.camera) return;
        const { forward } = this._getCameraAxes();
        // Camera.position and .target are plain {x,y,z} objects — assign directly.
        // Frontend reads these each frame to build the view matrix internally.
        const p = this.camera.position;
        p.x = this._camPos.x;
        p.y = this._camPos.y;
        p.z = this._camPos.z;
        const t = this.camera.target;
        t.x = this._camPos.x + forward.x * 10;
        t.y = this._camPos.y + forward.y * 10;
        t.z = this._camPos.z + forward.z * 10;
    }

    _getWorldUp() {
        // World up = direction away from planet center
        const origin = this.planetConfig?.origin ?? { x: 0, y: 0, z: 0 };
        const up = new Vector3(
            this._camPos.x - origin.x,
            this._camPos.y - origin.y,
            this._camPos.z - origin.z,
        );
        const len = up.length() || 1;
        up.x /= len; up.y /= len; up.z /= len;
        return up;
    }

    /** Vector3 has no addScaled — inline the math here. */
    _addScaled(v, s) {
        this._camPos.x += v.x * s;
        this._camPos.y += v.y * s;
        this._camPos.z += v.z * s;
    }

    _getCameraAxes() {
        // Derive forward/right/up from yaw/pitch
        const cosP = Math.cos(this._pitch);
        const sinP = Math.sin(this._pitch);
        const cosY = Math.cos(this._yaw);
        const sinY = Math.sin(this._yaw);

        // World-relative forward based on planet-surface up
        const worldUp = this._getWorldUp();
        // Build a local tangent frame aligned to the planet surface
        // right = worldUp × (0,0,1) normalised, forward = right × worldUp
        let tx = -worldUp.z, ty = 0, tz = worldUp.x;
        const tlen = Math.sqrt(tx*tx + tz*tz) || 1;
        tx /= tlen; tz /= tlen;
        // Forward in tangent plane (yaw)
        const fwdX = cosY * tx + sinY * worldUp.x;
        const fwdY = cosY * ty + sinY * worldUp.y;
        const fwdZ = cosY * tz + sinY * worldUp.z;
        // Apply pitch: blend forward with worldUp
        const forward = new Vector3(
            fwdX * cosP + worldUp.x * sinP,
            fwdY * cosP + worldUp.y * sinP,
            fwdZ * cosP + worldUp.z * sinP,
        );
        // Right = forward × worldUp
        const right = new Vector3(
            forward.y * worldUp.z - forward.z * worldUp.y,
            forward.z * worldUp.x - forward.x * worldUp.z,
            forward.x * worldUp.y - forward.y * worldUp.x,
        );
        const rlen = right.length() || 1;
        right.x /= rlen; right.y /= rlen; right.z /= rlen;

        return { forward, right, up: worldUp };
    }
}
