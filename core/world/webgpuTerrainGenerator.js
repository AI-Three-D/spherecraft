// js/world/webgpuTerrainGenerator.js

import { Logger } from '../../shared/Logger.js';
import { clamp01 } from '../../shared/math/index.js';
import { installWebGPUTerrainGeneratorAtlasMethods } from './terrain-generator/webgpuTerrainGeneratorAtlas.js';
import { installWebGPUTerrainGeneratorBatchMethods } from './terrain-generator/webgpuTerrainGeneratorBatching.js';
import { installWebGPUTerrainGeneratorPipelineMethods } from './terrain-generator/webgpuTerrainGeneratorPipelines.js';
import { requireInt, requireNumber, requireObject } from './terrain-generator/webgpuTerrainGeneratorDebugUtils.js';



export class WebGPUTerrainGenerator {
    constructor(device, seed, chunkSize, macroConfig, splatConfig, textureCache, options = {}) {
        if (!options.terrainTheme) {
            throw new Error('WebGPUTerrainGenerator requires options.terrainTheme (TILE_CATEGORIES, buildTileCategoryLookupWGSL, terrainShaderBundle)');
        }
        if (!options.terrainTheme.terrainShaderBundle) {
            throw new Error('WebGPUTerrainGenerator requires options.terrainTheme.terrainShaderBundle');
        }
        this.terrainTheme = options.terrainTheme;
        this.tileTypes = options.terrainTheme.TILE_TYPES ?? {};
        this.tileCategories = options.terrainTheme.TILE_CATEGORIES;
        this.buildTileCategoryLookupWGSL = options.terrainTheme.buildTileCategoryLookupWGSL;
        this.terrainShaderBundle = options.terrainTheme.terrainShaderBundle;

        this.debugMode = 0;

        this.device = requireObject(device, 'device');
        this.seed = requireInt(seed, 'seed', 0);
        this.chunkSize = requireNumber(chunkSize, 'chunkSize');
        const macro = requireObject(macroConfig, 'macroConfig');
        this.macroConfig = {
            biomeScale: requireNumber(macro.biomeScale, 'macroConfig.biomeScale'),
            regionScale: requireNumber(macro.regionScale, 'macroConfig.regionScale')
        };
        const splat = requireObject(splatConfig, 'splatConfig');
        this.splatDensity = requireInt(splat.splatDensity, 'splatConfig.splatDensity', 1);
        this.splatKernelSize = requireInt(splat.splatKernelSize, 'splatConfig.splatKernelSize', 1);
        this.splatSlotSupportExpansionTexels = Math.max(
            0.0,
            requireNumber(
                splat.slotSupportExpansionTexels ?? 1.5,
                'splatConfig.slotSupportExpansionTexels'
            )
        );
        this.splatTransitionSharpness = Math.max(
            1.0,
            requireNumber(
                splat.transitionSharpness ?? 1.9,
                'splatConfig.transitionSharpness'
            )
        );
        this.splatTransitionDominanceStart = clamp01(
            requireNumber(
                splat.transitionDominanceStart ?? 0.55,
                'splatConfig.transitionDominanceStart'
            )
        );
        this.splatTransitionDominanceEnd = Math.max(
            this.splatTransitionDominanceStart + 0.001,
            clamp01(
                requireNumber(
                    splat.transitionDominanceEnd ?? 0.9,
                    'splatConfig.transitionDominanceEnd'
                )
            )
        );
        this.splatCenterCategoryBias = Math.max(
            0.0,
            requireNumber(
                splat.centerCategoryBias ?? 0.0,
                'splatConfig.centerCategoryBias'
            )
        );
        this.splatTransitionBreakupScale = Math.max(
            0.0,
            requireNumber(
                splat.transitionBreakupScale ?? 0.018,
                'splatConfig.transitionBreakupScale'
            )
        );
        this.splatTransitionBreakupWarpScale = Math.max(
            0.0,
            requireNumber(
                splat.transitionBreakupWarpScale ?? 0.055,
                'splatConfig.transitionBreakupWarpScale'
            )
        );
        this.splatTransitionBreakupWarpStrength = Math.max(
            0.0,
            requireNumber(
                splat.transitionBreakupWarpStrength ?? 0.65,
                'splatConfig.transitionBreakupWarpStrength'
            )
        );
        this.splatTransitionBreakupStrength = Math.max(
            0.0,
            requireNumber(
                splat.transitionBreakupStrength ?? 0.10,
                'splatConfig.transitionBreakupStrength'
            )
        );
        this.splatChunkPaletteEnabled = splat.chunkPaletteEnabled !== false;
        this.splatChunkPaletteMinCoverage = clamp01(
            Number.isFinite(splat.chunkPaletteMinCoverage)
                ? splat.chunkPaletteMinCoverage
                : 0.9
        );
        this.splatChunkPaletteBorderTexels = Math.max(
            0,
            requireInt(
                splat.chunkPaletteBorderTexels ?? 2,
                'splatConfig.chunkPaletteBorderTexels',
                0
            )
        );
        this.textureCache = requireObject(textureCache, 'textureCache');
        this.arrayPools = new Map();
        this.useTextureArrays = true;
        this.maxArrayBytesPerType = 512 * 1024 * 1024;
        this.maxGpuBiomes = Math.max(1, requireInt(options.maxGpuBiomes ?? 16, 'maxGpuBiomes', 1));

        this.detailScale = 0.08;
        this.ridgeScale = 0.02;
        this.plateauScale = 0.005;
        this.valleyScale = 0.012;

        this.streamedTypes = new Map();
        this.initializeStreamedTypes();
        this.initialized = false;
        this._continentsEnabled = true;
        this._useSmallPlanetMode = false;
        this.smallPlanetRadiusThreshold = requireNumber(
            options.smallPlanetRadiusThreshold ?? 500000,
            'smallPlanetRadiusThreshold'
        );
        this.planetConfig = requireObject(options.planetConfig, 'planetConfig');
        this.setPlanetConfig(this.planetConfig);

        this._debugAtlasLogCount = 0;
        this._debugAtlasLogBudget = 24;

        this.debugMode = 0;
        this._logUniformsOnNextPass = false;
        this._packedBiomeUniforms = null;
        this.biomeUniformBuffer = null;
        this.biomeBindGroupLayout = null;
        this.biomeBindGroup = null;
    }


















    setPlanetConfig(config) {
        const planetConfig = requireObject(config, 'planetConfig');
        this.planetConfig = planetConfig;
        this.terrainConfig = requireObject(planetConfig.terrainGeneration, 'planetConfig.terrainGeneration');
        this.baseGenerator = this.terrainConfig?.baseGenerator ?? 'earthLike';
        this.worldScale = requireNumber(planetConfig.radius, 'planetConfig.radius');
        const radiusM = this.worldScale;
        const continentsEnabled = this.terrainConfig?.continents?.enabled ?? true;
        this._useSmallPlanetMode = radiusM < this.smallPlanetRadiusThreshold;
        // Continents only for larger planets; small planets use alternate path in shader.
        this._continentsEnabled = continentsEnabled && !this._useSmallPlanetMode;
        const refRadius = this.terrainConfig.noiseReferenceRadiusM;
        const baseReference = Number.isFinite(refRadius) ? refRadius : radiusM;
        this.noiseReferenceRadiusM = radiusM >= 50000
            ? Math.min(baseReference, radiusM * 1.5)
            : baseReference;
        // The packed data is cached here even before the GPU buffer exists.
        // initializePipelines uploads it once biomeUniformBuffer is allocated.
        this._refreshPackedBiomeUniforms();
        Logger.info(`WebGPUTerrainGenerator: Set worldScale to planet radius ${this.worldScale}`);
        Logger.info(`WebGPUTerrainGenerator: noiseReferenceRadiusM ${this.noiseReferenceRadiusM}`);
        if (this._useSmallPlanetMode) {
            Logger.info(`WebGPUTerrainGenerator: small planet mode enabled (radius ${radiusM} < ${this.smallPlanetRadiusThreshold})`);
        }
    }

    setDebugMode(mode) {
        this.debugMode = mode;
    }

    /**
     * Request logging of uniforms on the next height map generation pass.
     * The flag is cleared after logging.
     */
    requestUniformLogging() {
        this._logUniformsOnNextPass = true;

    }


    async initialize() {
        if (this.initialized) return;
        await this.initializePipelines();
        this.initialized = true;
    }

    initializeStreamedTypes() {

    }

}

installWebGPUTerrainGeneratorBatchMethods(WebGPUTerrainGenerator);
installWebGPUTerrainGeneratorPipelineMethods(WebGPUTerrainGenerator);
installWebGPUTerrainGeneratorAtlasMethods(WebGPUTerrainGenerator);
