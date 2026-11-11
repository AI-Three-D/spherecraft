import { TerrainModule } from '../renderer/terrain/TerrainModule.js';
import { QuadtreeTileManager } from './quadtree/GPUQuadtreeTerrain.js';
import { QuadtreeTerrainRenderer } from '../renderer/terrain/QuadtreeTerrainRenderer.js';
import { NearWaterRenderer } from '../renderer/water/NearWaterRenderer.js';

/**
 * The sea's switches. The sea is drawn as the lakes are, from the water data
 * (WaterGpuData.sea): the terrain shading far away, NearWaterRenderer's sea pass
 * close by and where it is deep. enabled: the 'o' key. legacy: the old global
 * ocean renderer instead (globalOceanRenderer.js), kept only to compare with.
 */
export class SeaControl {
    constructor(module) {
        this.module = module;
        this._enabled = true;
        this._legacy = false;
        /** The old renderer, created when legacy is first asked for. */
        this.legacyRenderer = null;
    }
    get enabled() { return this._enabled; }
    set enabled(on) { this._enabled = !!on; this.module._applySea(); }
    get legacy() { return this._legacy; }
    set legacy(on) {
        this._legacy = !!on;
        if (this._legacy && !this.legacyRenderer) {
            this._legacyPending ??= this.module.initializeLegacyOcean().catch(err => console.warn('[Ocean] legacy renderer:', err));
        }
        this.module._applySea();
    }
    /** Whether the planet has a sea. */
    get available() { return this.module.options.planetConfig.terrainGeneration?.water?.hasOceans !== false; }
    isReady() { return this.available; }
    dispose() { this.legacyRenderer?.dispose(); this.legacyRenderer = null; }
}

/**
 * Production composition of a planetary terrain world and its water layers.
 * This is the only assembly point that knows both the world implementation and
 * the terrain/water draw implementations. Assets, actors and sky belong to the app.
 * For a small fixture, use TerrainModule directly with a different TerrainSource.
 */
export class PlanetTerrainModule extends TerrainModule {
    constructor(options) {
        const { backend, engineConfig, planetConfig, terrainGenerator, textureManager,
            uniformManager, terrainAODefaults, groundFieldDefaults, tileCategories } = options;
        const source = new QuadtreeTileManager({
            backend, engineConfig, planetConfig, terrainGenerator, textureManager,
            terrainAODefaults, tileCategories,
        });
        const renderer = new QuadtreeTerrainRenderer({
            backend, engineConfig, planetConfig, terrainGenerator, textureManager,
            uniformManager, terrainAODefaults, groundFieldDefaults, tileCategories,
            tileManager: source,
        });
        renderer.setAtmosphereLUT(options.atmosphereLUT ?? null);
        super({ source, renderer, ownsSource: true, initializeSource: true });
        this.options = options;
        // The sea (SeaControl; its water is drawn by the water data's layers).
        this.ocean = new SeaControl(this);
        this.lakes = null;
        this.nearWater = null;
        this.environmentState = null;

        const render = (target, frame) => target?.render(
            frame.camera, frame.camera.matrixWorldInverse, frame.camera.projectionMatrix
        );
        this.waterLayers = [
            {
                setWaterData: () => this._applySea(),
                // Only the old renderer draws here; the sea itself is the near water's pass.
                render: frame => {
                    const sea = this.ocean, old = sea?.legacyRenderer;
                    if (!sea?.legacy || !sea.enabled || !old?.isReady()) return;
                    old.render(frame.camera, frame.camera.matrixWorldInverse, frame.camera.projectionMatrix,
                        source.getInstanceBuffer(), source.getIndirectArgsBuffer(), frame.deltaTime);
                },
                dispose: () => { this.ocean?.dispose(); },
            },
            {
                initialize: () => this.initializeLakes(),
                compute: frame => this.lakes?.update(frame.deltaTime),
                render: frame => render(this.lakes, frame),
                dispose: () => { this.lakes?.dispose(); this.lakes = null; },
            },
            {
                setWaterData: data => {
                    if (data && !this.nearWater) this.nearWater = new NearWaterRenderer(this.options);
                    this.nearWater?.setWaterData(data);
                },
                render: frame => render(this.nearWater, frame),
                dispose: () => { this.nearWater?.dispose(); this.nearWater = null; },
            },
        ];
    }

    /** The sea in the water data follows the switches (SeaControl). */
    _applySea() {
        const sea = this.waterData?.sea, ctl = this.ocean;
        if (sea && ctl) sea.enabled = sea.available && ctl.enabled && !ctl.legacy;
    }

    /** The old global ocean renderer, for comparison only (SeaControl.legacy). */
    async initializeLegacyOcean() {
        const { backend, planetConfig, uniformManager } = this.options;
        const water = planetConfig.terrainGeneration?.water ?? {};
        if (water.hasOceans === false || this.ocean.legacyRenderer) return;
        const { GlobalOceanRenderer } = await import('../renderer/water/globalOceanRenderer.js');
        const depth = Number.isFinite(water.averageOceanDepth) ? water.averageOceanDepth : 2000;
        const heightScale = planetConfig.heightScale ?? 2000;
        const old = new GlobalOceanRenderer({
            backend, planetConfig, uniformManager,
            quadtreeGPU: this.source.quadtreeGPU,
            terrainGeometries: this.renderer.geometries,
            heightTexture: this.source.getArrayTextures().height ?? null,
            maxGeomLOD: this.source.maxGeomLOD,
            waterConfig: {
                oceanLevel: (water.oceanLevel ?? 0) * heightScale,
                depthRange: water.visualDepthRange ?? Math.max(40, Math.min(600, depth * 0.12)),
                waveHeight: water.waveHeight ?? 0.35,
                waveFrequency: 0.8, windDirection: [1, 0], windSpeed: 5,
                foamIntensity: 0.6, foamDepthStart: 0, foamDepthEnd: 2.5, foamTiling: 0.06,
                shallowAlpha: 0.14, deepAlpha: 0.85,
                colorShallow: 0x154550, colorDeep: 0x001525, maxWaveLOD: 5, maxFoamLOD: 4,
            },
        });
        await old.initialize();
        this.ocean.legacyRenderer = old;
        if (this.environmentState) this.setEnvironmentState(this.environmentState);
    }

    async initializeLakes() {
        if (this.options.engineConfig.features?.lakes === false) return;
        const { LakeWaterSystem } = await import('../renderer/lakes/lakeWaterSystem.js');
        this.lakes = new LakeWaterSystem({
            ...this.options,
            device: this.options.backend.device,
            quadtreeGPU: this.source.quadtreeGPU,
            tileStreamer: this.source.tileStreamer,
            quadtreeTileManager: this.source,
        });
    }

    setEnvironmentState(state) {
        this.environmentState = state;
        const old = this.ocean?.legacyRenderer;
        if (!state?.water || !old) return;
        old.setWaterConfig({
            windDirection: [state.windDirection.x, state.windDirection.y],
            windSpeed: state.windSpeed,
            waveHeight: state.water.waveHeight,
            waveFrequency: state.water.waveFrequency,
            foamIntensity: state.water.foamIntensity,
            foamDepthEnd: state.water.foamDepthEnd,
        });
    }


    setLakes(lakes) { this.lakes?.setLakes(lakes); }
}
