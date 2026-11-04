import { TerrainModule } from '../renderer/terrain/TerrainModule.js';
import { QuadtreeTileManager } from './quadtree/GPUQuadtreeTerrain.js';
import { QuadtreeTerrainRenderer } from '../renderer/terrain/QuadtreeTerrainRenderer.js';
import { NearWaterRenderer } from '../renderer/water/NearWaterRenderer.js';
import { WaterSimRenderer } from '../renderer/water/WaterSimRenderer.js';

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
        this.ocean = null;
        this.rivers = null;
        this.lakes = null;
        this.nearWater = null;
        this.simWater = null;
        this.environmentState = null;

        const render = (target, frame) => target?.render(
            frame.camera, frame.camera.matrixWorldInverse, frame.camera.projectionMatrix
        );
        this.waterLayers = [
            {
                initialize: () => this.initializeOcean(),
                render: frame => {
                    if (!this.ocean?.isReady()) return;
                    this.ocean.render(frame.camera, frame.camera.matrixWorldInverse, frame.camera.projectionMatrix,
                        source.getInstanceBuffer(), source.getIndirectArgsBuffer(), frame.deltaTime);
                },
                dispose: () => { this.ocean?.dispose(); this.ocean = null; },
            },
            {
                initialize: () => this.initializeRivers(),
                compute: (frame, encoder) => this.rivers?.update(encoder, frame.deltaTime),
                render: frame => { if (this.rivers?.isReady()) render(this.rivers, frame); },
                dispose: () => { this.rivers?.dispose(); this.rivers = null; },
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
            {
                render: frame => render(this.simWater, frame),
                dispose: () => { this.simWater?.dispose(); this.simWater = null; },
            },
        ];
    }

    async initializeOcean() {
        const { backend, planetConfig, uniformManager } = this.options;
        const water = planetConfig.terrainGeneration?.water ?? {};
        if (water.hasOceans === false) return;
        const { GlobalOceanRenderer } = await import('../renderer/water/globalOceanRenderer.js');
        const depth = Number.isFinite(water.averageOceanDepth) ? water.averageOceanDepth : 2000;
        const heightScale = planetConfig.heightScale ?? 2000;
        this.ocean = new GlobalOceanRenderer({
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
        await this.ocean.initialize();
    }

    async initializeRivers() {
        if (this.options.engineConfig.features?.rivers === false) return;
        const { RiverSystem } = await import('../renderer/rivers/riverSystem.js');
        const { DEFAULT_RIVER_CONFIG } = await import('../../templates/configs/riverConfig.js');
        this.rivers = new RiverSystem({
            ...this.options,
            device: this.options.backend.device,
            quadtreeGPU: this.source.quadtreeGPU,
            tileStreamer: this.source.tileStreamer,
            riverConfig: this.options.riverConfig ?? DEFAULT_RIVER_CONFIG,
        });
        await this.rivers.initialize();
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
        if (!state?.water || !this.ocean) return;
        this.ocean.setWaterConfig({
            windDirection: [state.windDirection.x, state.windDirection.y],
            windSpeed: state.windSpeed,
            waveHeight: state.water.waveHeight,
            waveFrequency: state.water.waveFrequency,
            foamIntensity: state.water.foamIntensity,
            foamDepthEnd: state.water.foamDepthEnd,
        });
    }

    setWaterSimSite(site, water) {
        if (!site && !this.simWater) return;
        this.simWater ??= new WaterSimRenderer(this.options);
        this.simWater.setSite(site, water);
    }

    placeRiver(position, direction = null) { this.rivers?.setAnchor(position, direction); }
    setLakes(lakes) { this.lakes?.setLakes(lakes); }
}
