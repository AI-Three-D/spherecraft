/**
 * WorldConfigLoader — loads world JSON configs from a directory URL,
 * merges them with the base runtimeConfigs, and produces ready-to-use
 * engineConfig / gameDataConfig objects.
 *
 * Usage:
 *   const loader = new WorldConfigLoader('./world');
 *   const { engineConfig, gameDataConfig, postprocessing, raw } = await loader.load();
 *
 * After editing, export changed values:
 *   loader.exportJSON('terrain');   // triggers browser download
 *   loader.exportJSON('planet');
 *   loader.exportJSON('postprocessing');
 *
 * The loader does NOT write to the filesystem directly (browser constraint).
 * In dev mode, consider adding a POST /save-world endpoint to server.py.
 */

import { createEngineConfig, createGameDataConfig } from './runtimeConfigs.js';
import { TerrainGenerationConfig } from '../templates/configs/terrainGenerationConfig.js';

export class WorldConfigLoader {
    /**
     * @param {string} worldDir  URL base for the world folder, e.g. './world'
     */
    constructor(worldDir = './world') {
        this.worldDir = worldDir.replace(/\/$/, '');
        /** @type {{terrain: object, planet: object, postprocessing: object}|null} */
        this.raw = null;
    }

    // ── Load ─────────────────────────────────────────────────────────────

    async load() {
        const [terrain, planet, postprocessing, engine] = await Promise.all([
            this._fetchJSON('terrain.json'),
            this._fetchJSON('planet.json'),
            this._fetchJSON('postprocessing.json'),
            this._fetchJSON('engine.json').catch(() => ({})),  // optional
        ]);

        this.raw = { terrain, planet, postprocessing, engine };

        const engineConfig   = this._buildEngineConfig(terrain, planet, engine);
        const gameDataConfig = this._buildGameDataConfig(terrain, planet);

        return { engineConfig, gameDataConfig, postprocessing, raw: this.raw };
    }

    async _fetchJSON(filename) {
        const url = `${this.worldDir}/${filename}`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`WorldConfigLoader: failed to fetch ${url} (${resp.status})`);
        const text = await resp.text();
        // Strip single-line _comment keys before parsing (JSON5-lite)
        return JSON.parse(text);
    }

    // ── Build EngineConfig ────────────────────────────────────────────────

    _buildEngineConfig(terrain, planet, engine = {}) {
        const base = createEngineConfig();
        // Seed from terrain JSON
        if (terrain?.seed != null) base.seed = terrain.seed;
        // macroConfig
        if (engine?.macroConfig) Object.assign(base.macroConfig, engine.macroConfig);
        // nightSky
        if (engine?.nightSky) Object.assign(base.nightSky ?? {}, engine.nightSky);
        // camera
        if (engine?.camera) {
            const cam = base.manualCamera ?? {};
            if (engine.camera.moveSpeed != null) cam.baseSpeed = engine.camera.moveSpeed;
            if (engine.camera.maxBoost  != null) cam.maxBoost  = engine.camera.maxBoost;
            base.manualCamera = cam;
            const cam2 = base.camera ?? {};
            if (engine.camera.fov  != null) cam2.fov  = engine.camera.fov;
            if (engine.camera.near != null) cam2.near = engine.camera.near;
            if (engine.camera.far  != null) cam2.far  = engine.camera.far;
            base.camera = cam2;
        }
        // lighting ambient
        if (engine?.lighting?.ambient) {
            const a = base.rendering?.lighting?.ambient ?? {};
            Object.assign(a, engine.lighting.ambient);
        }
        if (engine?.lighting?.sun) {
            const s = base.rendering?.lighting?.sun ?? {};
            Object.assign(s, engine.lighting.sun);
        }
        if (engine?.lighting?.fog) {
            const f = base.rendering?.lighting?.fog ?? {};
            Object.assign(f, engine.lighting.fog);
        }
        // terrainShader overrides
        if (engine?.terrainShader) {
            const ts = base.rendering?.terrainShader ?? {};
            Object.assign(ts, engine.terrainShader);
        }
        // gpuQuadtree overrides
        if (engine?.gpuQuadtree) {
            const q = base.gpuQuadtree ?? {};
            Object.assign(q, engine.gpuQuadtree);
            base.gpuQuadtree = q;
        }
        return base;
    }

    // ── Build GameDataConfig ──────────────────────────────────────────────

    _buildGameDataConfig(terrain, planet) {
        const base = createGameDataConfig();

        // The base factory returns a GameDataConfig whose planet list we patch.
        const activePlanet = base.planets[0];
        if (!activePlanet) return base;

        // ── Terrain ──────────────────────────────────────────────────────
        const t = activePlanet.terrain;
        if (t && terrain) {
            if (terrain.noiseProfile)         Object.assign(t.noiseProfile,  terrain.noiseProfile);
            if (terrain.continents)           Object.assign(t.continents,   terrain.continents);
            if (terrain.tectonics)            Object.assign(t.tectonics,    terrain.tectonics);
            if (terrain.volcanism)            Object.assign(t.volcanism,    terrain.volcanism);
            if (terrain.erosion)              Object.assign(t.erosion,      terrain.erosion);
            if (terrain.impacts)              Object.assign(t.impacts,      terrain.impacts);
            if (terrain.water)                Object.assign(t.water,        terrain.water);
            if (terrain.surface)              Object.assign(t.surface,      terrain.surface);
        }

        // ── Planet ───────────────────────────────────────────────────────
        if (planet) {
            if (planet.maxTerrainHeight != null)       activePlanet.maxTerrainHeight    = planet.maxTerrainHeight;
            if (planet.hasAtmosphere   != null)        activePlanet.hasAtmosphere       = planet.hasAtmosphere;
            if (planet.atmosphereHeightRatio != null)  activePlanet.atmosphereHeightRatio = planet.atmosphereHeightRatio;
            if (planet.atmosphereOptions)              Object.assign(activePlanet.atmosphereOptions ?? {}, planet.atmosphereOptions);
            if (planet.macroTileSpan   != null)        activePlanet.macroTileSpan       = planet.macroTileSpan;
            if (planet.macroMaxLOD     != null)        activePlanet.macroMaxLOD         = planet.macroMaxLOD;
            if (planet.altitudeZones)                  Object.assign(activePlanet.altitudeZones, planet.altitudeZones);
            if (planet.starSystem?.sunIntensity != null) {
                // Propagate sun intensity through the star system config
                base.starSystem.sunIntensity = planet.starSystem.sunIntensity;
            }
        }

        // ── Time / spawn ─────────────────────────────────────────────────
        if (planet?.time) {
            Object.assign(base.time, planet.time);
        }
        if (planet?.spawn) {
            Object.assign(base.spawn, planet.spawn);
        }

        return base;
    }

    // ── Patch a running engine with real-time-safe values ────────────────

    /**
     * Apply real-time (no-regen) overrides to a running GameEngine instance.
     * Safe to call while the world is rendered.
     *
     * @param {object} gameEngine  Running GameEngine instance
     * @param {object} [postprocessing]  Postprocessing JSON (uses this.raw if omitted)
     * @param {object} [planet]          Planet JSON (uses this.raw if omitted)
     * @param {object} [engine]          Engine JSON (uses this.raw if omitted)
     */
    applyRealtime(gameEngine, postprocessing, planet, engine) {
        postprocessing = postprocessing ?? this.raw?.postprocessing;
        planet         = planet         ?? this.raw?.planet;
        engine         = engine         ?? this.raw?.engine;

        // ── Post-processing ──────────────────────────────────────────────
        const pp = gameEngine?.renderer?.postProcessing;
        if (pp && postprocessing) {
            if (postprocessing.exposure != null) {
                pp.exposure = postprocessing.exposure;
            }
            if (postprocessing.autoExposure && pp.exposurePass) {
                const ae = postprocessing.autoExposure;
                if (ae.enabled != null) pp.autoExposureEnabled = ae.enabled;
                if (ae.compensation != null) pp.exposurePass.exposureCompensation = ae.compensation;
                if (ae.minExposure != null) pp.exposurePass.minExposure = ae.minExposure;
                if (ae.maxExposure != null) pp.exposurePass.maxExposure = ae.maxExposure;
                if (ae.speedUp != null) pp.exposurePass.speedUp = ae.speedUp;
                if (ae.speedDown != null) pp.exposurePass.speedDown = ae.speedDown;
                if (ae.middleGray != null) pp.exposurePass.middleGray = ae.middleGray;
            }
            if (postprocessing.bloom) {
                const b = postprocessing.bloom;
                if (b.threshold   != null) pp.bloomPass.threshold   = b.threshold;
                if (b.knee        != null) pp.bloomPass.knee        = b.knee;
                if (b.intensity   != null) pp.bloomPass.intensity   = b.intensity;
                if (b.blendFactor != null) pp.bloomPass.blendFactor = b.blendFactor;
            }
            if (postprocessing.tonemapping && pp.toneMappingPass) {
                const t = postprocessing.tonemapping;
                if (t.contrast != null) pp.toneMappingPass.contrast = t.contrast;
                if (t.toe != null) pp.toneMappingPass.toe = t.toe;
                if (t.shoulder != null) pp.toneMappingPass.shoulder = t.shoulder;
                if (t.whitePoint != null) pp.toneMappingPass.whitePoint = t.whitePoint;
                if (t.highlightSaturation != null) {
                    pp.toneMappingPass.highlightSaturation = t.highlightSaturation;
                }
            }
        }

        const renderer = gameEngine?.renderer;
        const uniformManager = renderer?.uniformManager;
        const lightingController = renderer?.lightingController;
        if (uniformManager && engine?.lighting) {
            if (engine.lighting.ambient) {
                uniformManager.applyAmbientConfig(engine.lighting.ambient);
            }
            if (engine.lighting.sun && lightingController) {
                lightingController.applyConfig(engine.lighting.sun);
            }
            if (engine.lighting.fog) {
                uniformManager.applyFogConfig(engine.lighting.fog);
            }
            if (lightingController) {
                uniformManager.updateFromLightingController(lightingController);
            }
        }

        // ── Atmosphere ───────────────────────────────────────────────────
        // TODO: expose atmosphere uniform updates when Frontend supports them
        // const atmo = gameEngine?.renderer?.atmospherePass;
        // if (atmo && planet?.atmosphereOptions) { ... }
    }

    // ── Export helpers ────────────────────────────────────────────────────

    /**
     * Download one of the three JSON config files via browser download.
     * @param {'terrain'|'planet'|'postprocessing'|'engine'} key
     * @param {object} [data]  Override data to export (defaults to this.raw[key])
     */
    exportJSON(key, data) {
        const content = data ?? this.raw?.[key];
        if (!content) { console.warn(`WorldConfigLoader.exportJSON: no data for '${key}'`); return; }
        const json = JSON.stringify(content, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url  = URL.createObjectURL(blob);
        const a    = Object.assign(document.createElement('a'), {
            href: url,
            download: `${key}.json`
        });
        a.click();
        URL.revokeObjectURL(url);
    }
}
