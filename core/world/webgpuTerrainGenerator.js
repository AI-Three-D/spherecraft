// js/world/webgpuTerrainGenerator.js

import { createSplatComputeShader } from './shaders/webgpu/splatCompute.wgsl.js';
import { createSplatPaletteComputeShader } from './shaders/webgpu/splatPaletteCompute.wgsl.js';
import { createSplatValidityComputeShader } from './shaders/webgpu/splatValidityCompute.wgsl.js';
import { createResolvedTerrainColorComputeShader } from './shaders/webgpu/resolvedTerrainColorCompute.wgsl.js';
import { getPackedBiomeUniformByteSize, packBiomeUniformData } from './biomeRuntime.js';

import { Texture, TextureFormat, TextureFilter, gpuFormatIsFilterable, gpuFormatBytesPerTexel, gpuFormatToWrapperFormat, gpuFormatSampleType } from '../renderer/resources/texture.js';

import { Logger } from '../../shared/Logger.js';
import { clamp01, clampInt, clampByte } from '../../shared/math/index.js';
import { createAdvancedTerrainComputeShader } from './shaders/webgpu/advancedTerrainCompute.wgsl.js';

const TERRAIN_STEP_LOG_TAG = '[TerrainStep]';
const SPLAT_STEP_LOG_TAG = '[SplatStep]';
const SPLAT_STEP_PREFIX = `${TERRAIN_STEP_LOG_TAG} ${SPLAT_STEP_LOG_TAG}`;

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



    _runBatchedLODTerrainPasses({
        gpuHeightBase, gpuHeight, gpuNormal, gpuTile, gpuMacro,
        chunkCoordX, chunkCoordY, chunkSizeTex, chunkGridSize,
        face, textureSize,
        formats = {}
    }) {
        if (this._lodPassLogCount === undefined) this._lodPassLogCount = 0;
        if (this._lodPassLogCount < 3) {
            this._lodPassLogCount++;
            const u = this._getTerrainShaderUniforms();
            console.log(
                `[TerrainDebug] _runBatchedLODTerrainPasses: ` +
                `chunkSizeTex=${chunkSizeTex}, chunkGridSize=${chunkGridSize}, ` +
                `textureSize=${textureSize}, face=${face}, ` +
                `chunkCoord=(${chunkCoordX},${chunkCoordY})`
            );
            console.log(
                `[TerrainDebug] noiseProfileA=${JSON.stringify(u.noiseProfileA)}, ` +
                `noiseRefRadius=${this.noiseReferenceRadiusM}, ` +
                `worldScale=${this.worldScale}`
            );
        }
        if (this._logUniformsOnNextPass) {
            this._logUniformsOnNextPass = false;
            const u = this._getTerrainShaderUniforms();
            console.log(
                `[TerrainDebug] Uniforms: chunkCoord=(${chunkCoordX},${chunkCoordY}), ` +
                `chunkSize=${chunkSizeTex}, chunkGridSize=${chunkGridSize}, face=${face}`
            );
            console.log(
                `[TerrainDebug] noiseProfileA=[${u.noiseProfileA}], ` +
                `noiseProfileB=[${u.noiseProfileB}]`
            );
        }

        const scratchView = this._fillTerrainUniformScratch(
            chunkCoordX, chunkCoordY, chunkSizeTex, chunkGridSize, face
        );

        const fmt = (name) => formats[name] || 'rgba32float';
        const heightFmt = fmt('height');
        const tileFmt   = fmt('tile');

        // heightBase is scratch and now carries stable slope in G — force rgba32float.
        // (The final height texture keeps whatever format the pool wants.)
        const heightBaseFmt = 'rgba32float';

        const passes = [
            { type: 0, outTex: gpuHeightBase, format: heightBaseFmt },
            { type: 2, outTex: gpuTile,   format: tileFmt,
              heightTex: gpuHeightBase, heightFormat: heightBaseFmt },
            { type: 4, outTex: gpuHeight, format: heightFmt,
              heightTex: gpuHeightBase, tileTex: gpuTile,
              heightFormat: heightBaseFmt, tileFormat: tileFmt },
            { type: 1, outTex: gpuNormal, format: fmt('normal'),
              heightTex: gpuHeight, heightFormat: heightFmt },
            { type: 3, outTex: gpuMacro,  format: fmt('macro') }
        ];


        // ── 2. Encode all passes into one command buffer ───────────
        const enc = this.device.createCommandEncoder({
            label: 'LODTerrainBatch'
        });

        const wgX = Math.ceil(textureSize / 8);
        const wgY = wgX;

        for (let i = 0; i < passes.length; i++) {
            const p = passes[i];
            const isMicroPass = (p.type === 4 || p.type === 5 || p.type === 6) && p.heightTex && p.tileTex;
            const isHeightInputPass =
                !isMicroPass && (p.type === 1 || p.type === 2) && p.heightTex;

            let pipeline, bindGroupLayout, entries;

            if (isMicroPass) {
                ({ pipeline, bindGroupLayout } =
                    this._getMicroPipelineForFormat(
                        p.format,
                        p.heightFormat,
                        p.tileFormat
                    ));
                entries = [
                    { binding: 0, resource: { buffer: this._batchTerrainUniforms[i] } },
                    { binding: 1, resource: p.outTex.createView() },
                    { binding: 2, resource: p.heightTex.createView() },
                    { binding: 3, resource: p.tileTex.createView() }
                ];
            } else if (isHeightInputPass) {
                ({ pipeline, bindGroupLayout } =
                    this._getHeightInputPipelineForFormat(
                        p.format,
                        p.heightFormat
                    ));
                entries = [
                    { binding: 0, resource: { buffer: this._batchTerrainUniforms[i] } },
                    { binding: 1, resource: p.outTex.createView() },
                    { binding: 2, resource: p.heightTex.createView() }
                ];
            } else {
                ({ pipeline, bindGroupLayout } =
                    this._getTerrainPipelineForFormat(p.format));
                entries = [
                    { binding: 0, resource: { buffer: this._batchTerrainUniforms[i] } },
                    { binding: 1, resource: p.outTex.createView() }
                ];
            }

            const pass = enc.beginComputePass();
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, this.device.createBindGroup({
                layout: bindGroupLayout,
                entries
            }));
            this._setTerrainBiomeBindGroup(pass);
            pass.dispatchWorkgroups(wgX, wgY);
            pass.end();
        }

        // ── 3. Single submit ────────────────────────────────────────
        this.device.queue.submit([enc.finish()]);
    }
    _getTerrainShaderUniforms() {
        const uniforms = requireObject(this.terrainConfig, 'terrainConfig').toShaderUniforms();
        if (!this._continentsEnabled && Array.isArray(uniforms.continentParams)) {
            uniforms.continentParams[0] = 0.0;
        }
        return uniforms;
    }

    _writeTerrainPaddingUniforms(v, uniforms) {
        const profileA = Array.isArray(uniforms.noiseProfileA) ? uniforms.noiseProfileA : [1.0, 1.0, 1.0, 1.0];
        const profileB = Array.isArray(uniforms.noiseProfileB) ? uniforms.noiseProfileB : [1.0, 1.0, 1.0, 1.0];
        const surfaceParams = Array.isArray(uniforms.surfaceParams) ? uniforms.surfaceParams : [0.05, 0.25, 0.25, 0.60];
        const pA0 = Number.isFinite(profileA[0]) ? profileA[0] : 1.0;
        const pA1 = Number.isFinite(profileA[1]) ? profileA[1] : 1.0;
        const pA2 = Number.isFinite(profileA[2]) ? profileA[2] : 1.0;
        const pA3 = Number.isFinite(profileA[3]) ? profileA[3] : 1.0;
        const pB0 = Number.isFinite(profileB[0]) ? profileB[0] : 1.0;
        const pB1 = Number.isFinite(profileB[1]) ? profileB[1] : 1.0;
        const pB2 = Number.isFinite(profileB[2]) ? profileB[2] : 1.0;
        const pB3 = Number.isFinite(profileB[3]) ? profileB[3] : 1.0;
        const sP0 = Number.isFinite(surfaceParams[0]) ? surfaceParams[0] : 0.05;
        const sP1 = Number.isFinite(surfaceParams[1]) ? surfaceParams[1] : 0.25;
        const sP2 = Number.isFinite(surfaceParams[2]) ? surfaceParams[2] : 0.25;
        const sP3 = Number.isFinite(surfaceParams[3]) ? surfaceParams[3] : 0.60;

        v.setFloat32(176, requireNumber(this.noiseReferenceRadiusM, 'noiseReferenceRadiusM'), true);
        v.setFloat32(180, this._useSmallPlanetMode ? 1.0 : 0.0, true);
        v.setFloat32(184, this.planetConfig?.maxTerrainHeight ?? 2000.0, true);
        v.setFloat32(188, 0.0, true);

        v.setFloat32(192, pA0, true);
        v.setFloat32(196, pA1, true);
        v.setFloat32(200, pA2, true);
        v.setFloat32(204, pA3, true);

        v.setFloat32(208, pB0, true);
        v.setFloat32(212, pB1, true);
        v.setFloat32(216, pB2, true);
        v.setFloat32(220, pB3, true);

        v.setFloat32(224, sP0, true);
        v.setFloat32(228, sP1, true);
        v.setFloat32(232, sP2, true);
        v.setFloat32(236, sP3, true);
    }

    _writeClimateZoneUniforms(v, uniforms) {
        const z0 = Array.isArray(uniforms.climateZone0) ? uniforms.climateZone0 : [0.0, 0.0, 0.0, 0.0];
        const z0e = Array.isArray(uniforms.climateZone0Extra) ? uniforms.climateZone0Extra : [0.0, 0.0, 0.0, 0.0];
        const z1 = Array.isArray(uniforms.climateZone1) ? uniforms.climateZone1 : [0.0, 0.0, 0.0, 0.0];
        const z1e = Array.isArray(uniforms.climateZone1Extra) ? uniforms.climateZone1Extra : [0.0, 0.0, 0.0, 0.0];
        const z2 = Array.isArray(uniforms.climateZone2) ? uniforms.climateZone2 : [0.0, 0.0, 0.0, 0.0];
        const z2e = Array.isArray(uniforms.climateZone2Extra) ? uniforms.climateZone2Extra : [0.0, 0.0, 0.0, 0.0];
        const z3 = Array.isArray(uniforms.climateZone3) ? uniforms.climateZone3 : [0.0, 0.0, 0.0, 0.0];
        const z3e = Array.isArray(uniforms.climateZone3Extra) ? uniforms.climateZone3Extra : [0.0, 0.0, 0.0, 0.0];
        const z4 = Array.isArray(uniforms.climateZone4) ? uniforms.climateZone4 : [0.0, 0.0, 0.0, 0.0];
        const z4e = Array.isArray(uniforms.climateZone4Extra) ? uniforms.climateZone4Extra : [0.0, 0.0, 0.0, 0.0];

        v.setFloat32(240, Number.isFinite(z0[0]) ? z0[0] : 0.0, true);
        v.setFloat32(244, Number.isFinite(z0[1]) ? z0[1] : 0.0, true);
        v.setFloat32(248, Number.isFinite(z0[2]) ? z0[2] : 0.0, true);
        v.setFloat32(252, Number.isFinite(z0[3]) ? z0[3] : 0.0, true);

        v.setFloat32(256, Number.isFinite(z0e[0]) ? z0e[0] : 0.0, true);
        v.setFloat32(260, Number.isFinite(z0e[1]) ? z0e[1] : 0.0, true);
        v.setFloat32(264, Number.isFinite(z0e[2]) ? z0e[2] : 0.0, true);
        v.setFloat32(268, Number.isFinite(z0e[3]) ? z0e[3] : 0.0, true);

        v.setFloat32(272, Number.isFinite(z1[0]) ? z1[0] : 0.0, true);
        v.setFloat32(276, Number.isFinite(z1[1]) ? z1[1] : 0.0, true);
        v.setFloat32(280, Number.isFinite(z1[2]) ? z1[2] : 0.0, true);
        v.setFloat32(284, Number.isFinite(z1[3]) ? z1[3] : 0.0, true);

        v.setFloat32(288, Number.isFinite(z1e[0]) ? z1e[0] : 0.0, true);
        v.setFloat32(292, Number.isFinite(z1e[1]) ? z1e[1] : 0.0, true);
        v.setFloat32(296, Number.isFinite(z1e[2]) ? z1e[2] : 0.0, true);
        v.setFloat32(300, Number.isFinite(z1e[3]) ? z1e[3] : 0.0, true);

        v.setFloat32(304, Number.isFinite(z2[0]) ? z2[0] : 0.0, true);
        v.setFloat32(308, Number.isFinite(z2[1]) ? z2[1] : 0.0, true);
        v.setFloat32(312, Number.isFinite(z2[2]) ? z2[2] : 0.0, true);
        v.setFloat32(316, Number.isFinite(z2[3]) ? z2[3] : 0.0, true);

        v.setFloat32(320, Number.isFinite(z2e[0]) ? z2e[0] : 0.0, true);
        v.setFloat32(324, Number.isFinite(z2e[1]) ? z2e[1] : 0.0, true);
        v.setFloat32(328, Number.isFinite(z2e[2]) ? z2e[2] : 0.0, true);
        v.setFloat32(332, Number.isFinite(z2e[3]) ? z2e[3] : 0.0, true);

        v.setFloat32(336, Number.isFinite(z3[0]) ? z3[0] : 0.0, true);
        v.setFloat32(340, Number.isFinite(z3[1]) ? z3[1] : 0.0, true);
        v.setFloat32(344, Number.isFinite(z3[2]) ? z3[2] : 0.0, true);
        v.setFloat32(348, Number.isFinite(z3[3]) ? z3[3] : 0.0, true);

        v.setFloat32(352, Number.isFinite(z3e[0]) ? z3e[0] : 0.0, true);
        v.setFloat32(356, Number.isFinite(z3e[1]) ? z3e[1] : 0.0, true);
        v.setFloat32(360, Number.isFinite(z3e[2]) ? z3e[2] : 0.0, true);
        v.setFloat32(364, Number.isFinite(z3e[3]) ? z3e[3] : 0.0, true);

        v.setFloat32(368, Number.isFinite(z4[0]) ? z4[0] : 0.0, true);
        v.setFloat32(372, Number.isFinite(z4[1]) ? z4[1] : 0.0, true);
        v.setFloat32(376, Number.isFinite(z4[2]) ? z4[2] : 0.0, true);
        v.setFloat32(380, Number.isFinite(z4[3]) ? z4[3] : 0.0, true);

        v.setFloat32(384, Number.isFinite(z4e[0]) ? z4e[0] : 0.0, true);
        v.setFloat32(388, Number.isFinite(z4e[1]) ? z4e[1] : 0.0, true);
        v.setFloat32(392, Number.isFinite(z4e[2]) ? z4e[2] : 0.0, true);
        v.setFloat32(396, Number.isFinite(z4e[3]) ? z4e[3] : 0.0, true);
    }

    _computeSplatPaddingTexels() {
        const kernelRadius = Math.max(0.5, 0.5 * Math.max(this.splatKernelSize, 1));
        return Math.ceil(kernelRadius) + 1;
    }

    _getSplatPaletteDimensions(innerWidth, innerHeight, chunkSizeTex) {
        const chunkSpan = Math.max(1, chunkSizeTex | 0);
        return {
            width: Math.max(1, Math.ceil(Math.max(1, innerWidth | 0) / chunkSpan)),
            height: Math.max(1, Math.ceil(Math.max(1, innerHeight | 0) / chunkSpan))
        };
    }

    _fillTerrainUniformScratch(chunkCoordX, chunkCoordY, chunkSizeTex, chunkGridSize, face) {
        const buf = this._terrainUniformScratch;
        const v = new DataView(buf);

        v.setInt32(0, chunkCoordX | 0, true);
        v.setInt32(4, chunkCoordY | 0, true);
        v.setInt32(8, chunkSizeTex | 0, true);
        v.setInt32(12, chunkGridSize | 0, true);
        v.setInt32(16, this.seed, true);

        v.setFloat32(20, this.macroConfig.biomeScale, true);
        v.setFloat32(24, this.macroConfig.regionScale, true);
        v.setFloat32(28, this.detailScale, true);
        v.setFloat32(32, this.ridgeScale, true);
        v.setFloat32(36, this.valleyScale, true);
        v.setFloat32(40, this.plateauScale, true);
        v.setFloat32(44, this.worldScale, true);

        // outputType (offset 48) left for caller to patch per pass
        v.setInt32(48, 0, true);
        v.setInt32(52, face !== null && face !== undefined ? (face | 0) : -1, true);

        v.setInt32(56, this.debugMode, true);
        v.setInt32(60, 0, true);
        v.setFloat32(64, 0.0, true);
        v.setFloat32(68, 0.0, true);

        const uniforms = this._getTerrainShaderUniforms();

        v.setFloat32(80, uniforms.continentParams[0], true);
        v.setFloat32(84, uniforms.continentParams[1], true);
        v.setFloat32(88, uniforms.continentParams[2], true);
        v.setFloat32(92, uniforms.continentParams[3], true);

        v.setFloat32(96, uniforms.tectonicParams[0], true);
        v.setFloat32(100, uniforms.tectonicParams[1], true);
        v.setFloat32(104, uniforms.tectonicParams[2], true);
        v.setFloat32(108, uniforms.tectonicParams[3], true);

        v.setFloat32(112, uniforms.waterParams[0], true);
        v.setFloat32(116, uniforms.waterParams[1], true);
        v.setFloat32(120, uniforms.waterParams[2], true);
        v.setFloat32(124, uniforms.waterParams[3], true);

        v.setFloat32(128, uniforms.erosionParams[0], true);
        v.setFloat32(132, uniforms.erosionParams[1], true);
        v.setFloat32(136, uniforms.erosionParams[2], true);
        v.setFloat32(140, uniforms.erosionParams[3], true);

        v.setFloat32(144, uniforms.volcanicParams[0], true);
        v.setFloat32(148, uniforms.volcanicParams[1], true);
        v.setFloat32(152, uniforms.volcanicParams[2], true);
        v.setFloat32(156, uniforms.volcanicParams[3], true);

        v.setFloat32(160, uniforms.climateParams[0], true);
        v.setFloat32(164, uniforms.climateParams[1], true);
        v.setFloat32(168, uniforms.climateParams[2], true);
        v.setFloat32(172, uniforms.climateParams[3], true);

        this._writeTerrainPaddingUniforms(v, uniforms);
        this._writeClimateZoneUniforms(v, uniforms);

        return v;
    }

    _runPaddedQuadtreeSplatPass(
        splatPass, chunkCoordX, chunkCoordY, chunkGridSize, face
    ) {
        const innerSize = Math.max(1, splatPass.textureSize | 0);
        const padding = this._computeSplatPaddingTexels();
        const paddedSize = innerSize + padding * 2;
        const splatIndexTex = splatPass.splatIndexTex;
        const splatValidTex = splatPass.splatValidTex;
        if (!splatIndexTex) {
            throw new Error('Splat pass requires splatIndexTex for top-4 sparse splat output');
        }
        if (!splatValidTex) {
            throw new Error('Splat pass requires splatValidTex for bilinear-valid mask output');
        }

        const shouldPrimeSplat = (this._quadtreeSplatPrimeCount ?? 0) < 3;
        const shouldRunProbePasses = (this._quadtreeSplatProbePassCount ?? 0) < 3;
        const shouldCaptureValidationError = shouldRunProbePasses && typeof this.device.pushErrorScope === 'function';
        const splatPrimePattern = [17, 34, 51, 68];
        if (shouldPrimeSplat) {
            this._quadtreeSplatPrimeCount = (this._quadtreeSplatPrimeCount ?? 0) + 1;
            this._fillTextureRGBA8Unorm(
                splatPass.splatTex,
                innerSize,
                innerSize,
                splatPrimePattern
            );
            this._fillTextureRGBA8Unorm(
                splatIndexTex,
                innerSize,
                innerSize,
                [255, 255, 255, 255]
            );
            this._fillTextureRGBA8Unorm(
                splatValidTex,
                innerSize,
                innerSize,
                [0, 0, 0, 255]
            );
        }

        if (this._quadtreePaddedSplatLogCount === undefined) {
            this._quadtreePaddedSplatLogCount = 0;
        }
        if (this._quadtreePaddedSplatLogCount < 4) {
            this._quadtreePaddedSplatLogCount++;
            Logger.info(
                `${SPLAT_STEP_PREFIX} [SplatDebug] padded quadtree splat: inner=${innerSize}, ` +
                `padding=${padding}, padded=${paddedSize}, kernel=${this.splatKernelSize}`
            );
        }

        const paddedTileMap = this.createGPUTexture(paddedSize, paddedSize, 'rgba8unorm');
        const paletteSize = this._getSplatPaletteDimensions(
            innerSize,
            innerSize,
            splatPass.chunkSizeTex
        );
        const splatPaletteTex = this.createGPUTexture(
            paletteSize.width,
            paletteSize.height,
            'rgba8unorm'
        );
        let debugProbeTextures = null;
        if (shouldRunProbePasses) {
            this._quadtreeSplatProbePassCount = (this._quadtreeSplatProbePassCount ?? 0) + 1;
            debugProbeTextures = {
                constantWrite: this.createGPUTexture(innerSize, innerSize, 'rgba8unorm'),
                tileEcho: this.createGPUTexture(innerSize, innerSize, 'rgba8unorm'),
                categoryEcho: this.createGPUTexture(innerSize, innerSize, 'rgba8unorm')
            };
        }
        // _padTileUniformBuffer is still used by debug probe passes (tileEcho/categoryEcho)
        // when debugProbeTextures is active — keep the write unconditionally as it is cheap.
        const padTileParams = new Uint32Array([
            padding >>> 0,
            innerSize >>> 0,
            innerSize >>> 0,
            0
        ]);
        this.device.queue.writeBuffer(this._padTileUniformBuffer, 0, padTileParams);

        this._writeSplatUniformBuffer({
            chunkCoordX,
            chunkCoordY,
            chunkSizeTex: splatPass.chunkSizeTex,
            inputPadding: padding,
        });

        // Build the padded tileMap by running the terrain generation shader over
        // the extended region (innerSize + padding on each side) instead of
        // edge-replicating the tile's own border.  The uvOffset shifts the
        // pixel→faceUV mapping so that pixel `padding` maps to the tile origin
        // and pixels 0..(padding-1) map to the genuine neighbouring tile area.
        const uvShift = -padding / Math.max(innerSize - 1, 1) / Math.max(chunkGridSize, 1);
        this._fillTerrainUniformScratch(chunkCoordX, chunkCoordY, innerSize, chunkGridSize, face);
        {
            const v = new DataView(this._terrainUniformScratch);
            v.setInt32(48, 2, true);        // outputType = 2 (tile IDs)
            v.setFloat32(64, uvShift, true); // uvOffset.x
            v.setFloat32(68, uvShift, true); // uvOffset.y
        }
        if (!this._paddedTileGenUniformBuffer) {
            this._paddedTileGenUniformBuffer = this.device.createBuffer({
                label: 'PaddedTileGenUniform',
                size: this._terrainUniformScratch.byteLength,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
            });
        }
        this.device.queue.writeBuffer(this._paddedTileGenUniformBuffer, 0, this._terrainUniformScratch);

        const { pipeline: tileGenPipeline, bindGroupLayout: tileGenBindGroupLayout } =
            this._getTerrainPipelineForFormat('rgba8unorm');
        const { pipeline: splatPalettePipeline, bindGroupLayout: splatPaletteBindGroupLayout } =
            this._getSplatPalettePipelineForFormat('rgba8unorm');
        const { pipeline: splatPipeline, bindGroupLayout: splatBindGroupLayout } =
            this._getSplatPipelineForFormats(
                splatPass.heightFormat || 'r32float',
                'rgba8unorm'
            );
        const { pipeline: splatValidityPipeline, bindGroupLayout: splatValidityBindGroupLayout } =
            this._getSplatValidityPipelineForFormats('rgba8unorm', 'rgba8unorm');
        const constantProbePipeline = debugProbeTextures
            ? this._getSplatDebugProbePipeline('constantWrite')
            : null;
        const tileEchoProbePipeline = debugProbeTextures
            ? this._getSplatDebugProbePipeline('tileEcho')
            : null;
        const categoryEchoProbePipeline = debugProbeTextures
            ? this._getSplatDebugProbePipeline('categoryEcho')
            : null;

        if (shouldCaptureValidationError) {
            this.device.pushErrorScope('validation');
        }

        const enc = this.device.createCommandEncoder({ label: 'PaddedQuadtreeSplat' });

        {
            const pass = enc.beginComputePass({ label: 'GenPaddedTileMap' });
            pass.setPipeline(tileGenPipeline);
            pass.setBindGroup(0, this.device.createBindGroup({
                layout: tileGenBindGroupLayout,
                entries: [
                    { binding: 0, resource: { buffer: this._paddedTileGenUniformBuffer } },
                    { binding: 1, resource: paddedTileMap.createView() }
                ]
            }));
            this._setTerrainBiomeBindGroup(pass);
            pass.dispatchWorkgroups(
                Math.ceil(paddedSize / 8),
                Math.ceil(paddedSize / 8)
            );
            pass.end();
        }

        {
            const pass = enc.beginComputePass({ label: 'ComputePaddedSplatPalette' });
            pass.setPipeline(splatPalettePipeline);
            pass.setBindGroup(0, this.device.createBindGroup({
                layout: splatPaletteBindGroupLayout,
                entries: [
                    { binding: 0, resource: { buffer: this.splatUniformBuffer } },
                    { binding: 1, resource: paddedTileMap.createView() },
                    { binding: 2, resource: splatPaletteTex.createView() }
                ]
            }));
            pass.dispatchWorkgroups(
                Math.ceil(paletteSize.width / 8),
                Math.ceil(paletteSize.height / 8)
            );
            pass.end();
        }

        {
            const pass = enc.beginComputePass({ label: 'ComputePaddedSplat' });
            pass.setPipeline(splatPipeline);
            pass.setBindGroup(0, this.device.createBindGroup({
                layout: splatBindGroupLayout,
                entries: [
                    { binding: 0, resource: { buffer: this.splatUniformBuffer } },
                    { binding: 1, resource: splatPass.heightTex.createView() },
                    { binding: 2, resource: paddedTileMap.createView() },
                    { binding: 3, resource: splatPass.splatTex.createView() },
                    { binding: 4, resource: splatIndexTex.createView() },
                    { binding: 5, resource: splatPaletteTex.createView() }
                ]
            }));
            pass.dispatchWorkgroups(
                Math.ceil(innerSize / 8),
                Math.ceil(innerSize / 8)
            );
            pass.end();
        }

        {
            const pass = enc.beginComputePass({ label: 'ComputePaddedSplatValidity' });
            pass.setPipeline(splatValidityPipeline);
            pass.setBindGroup(0, this.device.createBindGroup({
                layout: splatValidityBindGroupLayout,
                entries: [
                    { binding: 0, resource: splatIndexTex.createView() },
                    { binding: 1, resource: splatValidTex.createView() }
                ]
            }));
            pass.dispatchWorkgroups(
                Math.ceil(innerSize / 8),
                Math.ceil(innerSize / 8)
            );
            pass.end();
        }

        if (
            splatPass.resolvedColorTex &&
            splatPass.tileTex &&
            splatPass.atlasTexture &&
            splatPass.tileTypeLookup
        ) {
            this._writeResolvedColorUniformBuffer({
                chunkCoordX,
                chunkCoordY,
                chunkSizeTex: innerSize,
                chunkGridSize,
                face,
                season: splatPass.resolvedColorSeason ?? 0
            });
            const pass = enc.beginComputePass({ label: 'ComputeResolvedTerrainColor' });
            pass.setPipeline(this.resolvedColorPipeline);
            pass.setBindGroup(0, this.device.createBindGroup({
                layout: this.resolvedColorBindGroupLayout,
                entries: [
                    { binding: 0, resource: { buffer: this.resolvedColorUniformBuffer } },
                    { binding: 1, resource: splatPass.resolvedColorTex.createView() },
                    { binding: 2, resource: splatPass.splatTex.createView() },
                    { binding: 3, resource: splatIndexTex.createView() },
                    { binding: 4, resource: splatPass.tileTex.createView() },
                    { binding: 5, resource: splatPass.atlasTexture.createView({ dimension: '2d-array' }) },
                    { binding: 6, resource: splatPass.tileTypeLookup.createView() },
                    { binding: 7, resource: this.resolvedColorAtlasSampler }
                ]
            }));
            pass.dispatchWorkgroups(
                Math.ceil(innerSize / 8),
                Math.ceil(innerSize / 8)
            );
            pass.end();

            if (splatPass.resolvedColorResolveToTexture && splatPass.resolvedColorResolveToFormat) {
                this.resolveTexture2D(
                    enc,
                    splatPass.resolvedColorTex,
                    'rgba8unorm',
                    splatPass.resolvedColorResolveToTexture,
                    splatPass.resolvedColorResolveToFormat,
                    innerSize,
                    innerSize
                );
            }
        }


        if (debugProbeTextures) {
            {
                const pass = enc.beginComputePass({ label: 'DebugSplatConstantWrite' });
                pass.setPipeline(constantProbePipeline.pipeline);
                pass.setBindGroup(0, this.device.createBindGroup({
                    layout: constantProbePipeline.bindGroupLayout,
                    entries: [
                        { binding: 0, resource: debugProbeTextures.constantWrite.createView() }
                    ]
                }));
                pass.dispatchWorkgroups(
                    Math.ceil(innerSize / 8),
                    Math.ceil(innerSize / 8)
                );
                pass.end();
            }

            {
                const pass = enc.beginComputePass({ label: 'DebugSplatTileEcho' });
                pass.setPipeline(tileEchoProbePipeline.pipeline);
                pass.setBindGroup(0, this.device.createBindGroup({
                    layout: tileEchoProbePipeline.bindGroupLayout,
                    entries: [
                        { binding: 0, resource: { buffer: this._padTileUniformBuffer } },
                        { binding: 1, resource: paddedTileMap.createView() },
                        { binding: 2, resource: debugProbeTextures.tileEcho.createView() }
                    ]
                }));
                pass.dispatchWorkgroups(
                    Math.ceil(innerSize / 8),
                    Math.ceil(innerSize / 8)
                );
                pass.end();
            }

            {
                const pass = enc.beginComputePass({ label: 'DebugSplatCategoryEcho' });
                pass.setPipeline(categoryEchoProbePipeline.pipeline);
                pass.setBindGroup(0, this.device.createBindGroup({
                    layout: categoryEchoProbePipeline.bindGroupLayout,
                    entries: [
                        { binding: 0, resource: { buffer: this._padTileUniformBuffer } },
                        { binding: 1, resource: paddedTileMap.createView() },
                        { binding: 2, resource: debugProbeTextures.categoryEcho.createView() }
                    ]
                }));
                pass.dispatchWorkgroups(
                    Math.ceil(innerSize / 8),
                    Math.ceil(innerSize / 8)
                );
                pass.end();
            }
        }

        this.device.queue.submit([enc.finish()]);
        const validationErrorPromise = shouldCaptureValidationError
            ? this.device.popErrorScope().catch(() => null)
            : Promise.resolve(null);

        Promise.all([
            this.device.queue.onSubmittedWorkDone().catch(() => null),
            validationErrorPromise
        ])
            .then(async ([, validationError]) => {
                try {
                    await this._debugAnalyzeQuadtreeSplatPass(
                        splatPass,
                        paddedTileMap,
                        innerSize,
                        paddedSize,
                        padding,
                        chunkCoordX,
                        chunkCoordY,
                        chunkGridSize,
                        face,
                        shouldPrimeSplat ? splatPrimePattern : null,
                        debugProbeTextures,
                        validationError
                    );
                } catch (err) {
                    Logger.warn(`${SPLAT_STEP_PREFIX} [SplatDebug] quadtree splat diagnostics failed: ${err?.message || err}`);
                }
                try { paddedTileMap.destroy(); } catch (_) {}
                try { splatPaletteTex.destroy(); } catch (_) {}
                if (debugProbeTextures) {
                    try { debugProbeTextures.constantWrite.destroy(); } catch (_) {}
                    try { debugProbeTextures.tileEcho.destroy(); } catch (_) {}
                    try { debugProbeTextures.categoryEcho.destroy(); } catch (_) {}
                }
            })
            .catch(() => {});
    }

    runBatchedTilePasses(config) {
        const {
            chunkCoordX, chunkCoordY, chunkSizeTex,
            chunkGridSize, face, terrainPasses, splatPass
        } = config;

        // 1. Fill common terrain uniforms once
        const scratchView = this._fillTerrainUniformScratch(
            chunkCoordX, chunkCoordY, chunkSizeTex, chunkGridSize, face
        );

        for (let i = 0; i < terrainPasses.length; i++) {
            scratchView.setInt32(48, terrainPasses[i].outputType, true);
            this.device.queue.writeBuffer(
                this._batchTerrainUniforms[i], 0,
                this._terrainUniformScratch
            );
        }

        // 3. Encode all terrain passes
        const enc = this.device.createCommandEncoder({ label: 'TerrainBatch' });

        for (let i = 0; i < terrainPasses.length; i++) {
            const tp = terrainPasses[i];

            const isMicroPass =
                (tp.outputType === 4 || tp.outputType === 5 || tp.outputType === 6)
                && tp.heightTexture && tp.tileTexture;
            const isHeightInputPass =
                !isMicroPass
                && (tp.outputType === 1 || tp.outputType === 2)
                && tp.heightTexture;

            let pipeline, bindGroupLayout, entries;

            if (isMicroPass) {
                ({ pipeline, bindGroupLayout } =
                    this._getMicroPipelineForFormat(
                        tp.format, tp.heightTextureFormat, tp.tileTextureFormat));
                entries = [
                    { binding: 0, resource: { buffer: this._batchTerrainUniforms[i] } },
                    { binding: 1, resource: tp.texture.createView() },
                    { binding: 2, resource: tp.heightTexture.createView() },
                    { binding: 3, resource: tp.tileTexture.createView() }
                ];
            } else if (isHeightInputPass) {
                ({ pipeline, bindGroupLayout } =
                    this._getHeightInputPipelineForFormat(
                        tp.format, tp.heightTextureFormat));
                entries = [
                    { binding: 0, resource: { buffer: this._batchTerrainUniforms[i] } },
                    { binding: 1, resource: tp.texture.createView() },
                    { binding: 2, resource: tp.heightTexture.createView() }
                ];
            } else {
                ({ pipeline, bindGroupLayout } =
                    this._getTerrainPipelineForFormat(tp.format));
                entries = [
                    { binding: 0, resource: { buffer: this._batchTerrainUniforms[i] } },
                    { binding: 1, resource: tp.texture.createView() }
                ];
            }

            const pass = enc.beginComputePass();
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, this.device.createBindGroup({ layout: bindGroupLayout, entries }));
            this._setTerrainBiomeBindGroup(pass);
            pass.dispatchWorkgroups(
                Math.ceil(tp.textureSize / 8),
                Math.ceil(tp.textureSize / 8)
            );
            pass.end();

            if (tp.resolveToTexture && tp.resolveToFormat) {
                this.resolveTexture2D(
                    enc, tp.texture, tp.format,
                    tp.resolveToTexture, tp.resolveToFormat,
                    tp.textureSize, tp.textureSize
                );
            }
        }

        // 4. Submit terrain passes before splat generation.
        this.device.queue.submit([enc.finish()]);

        // 5. Bilinear splat compute with small-kernel search fallback.
        if (splatPass) {
            this._runPaddedQuadtreeSplatPass(
                splatPass,
                chunkCoordX,
                chunkCoordY,
                chunkGridSize,
                face
            );
        }
    }

    _writeSplatUniformBuffer({
        chunkCoordX = 0,
        chunkCoordY = 0,
        chunkSizeTex,
        inputPadding = 0,
    }) {
        const data = new ArrayBuffer(80);
        const view = new DataView(data);
        view.setInt32(0, chunkCoordX | 0, true);
        view.setInt32(4, chunkCoordY | 0, true);
        view.setInt32(8, chunkSizeTex | 0, true);
        view.setInt32(12, this.seed, true);
        view.setInt32(16, this.splatDensity, true);
        view.setInt32(20, this.splatKernelSize, true);
        view.setInt32(24, inputPadding | 0, true);
        view.setInt32(
            28,
            this.splatChunkPaletteEnabled ? (this.splatChunkPaletteBorderTexels | 0) : 0,
            true
        );
        view.setFloat32(32, this.splatTransitionSharpness, true);
        view.setFloat32(36, this.splatTransitionDominanceStart, true);
        view.setFloat32(40, this.splatTransitionDominanceEnd, true);
        view.setFloat32(44, this.splatCenterCategoryBias, true);
        view.setFloat32(48, this.splatTransitionBreakupScale, true);
        view.setFloat32(52, this.splatTransitionBreakupWarpScale, true);
        view.setFloat32(56, this.splatTransitionBreakupWarpStrength, true);
        view.setFloat32(60, this.splatTransitionBreakupStrength, true);
        view.setFloat32(
            64,
            this.splatChunkPaletteEnabled ? this.splatChunkPaletteMinCoverage : 2.0,
            true
        );
        view.setFloat32(68, 0.0, true);
        view.setFloat32(72, 0.0, true);
        view.setFloat32(76, 0.0, true);
        this.device.queue.writeBuffer(this.splatUniformBuffer, 0, data);
    }

    _writeResolvedColorUniformBuffer({
        chunkCoordX = 0,
        chunkCoordY = 0,
        chunkSizeTex = 1,
        chunkGridSize = 1,
        face = 0,
        season = 0,
    } = {}) {
        const data = new ArrayBuffer(64);
        const view = new DataView(data);
        view.setInt32(0, chunkCoordX | 0, true);
        view.setInt32(4, chunkCoordY | 0, true);
        view.setInt32(8, Math.max(1, chunkSizeTex | 0), true);
        view.setInt32(12, Math.max(1, chunkGridSize | 0), true);
        view.setInt32(16, this.seed | 0, true);
        view.setInt32(20, face | 0, true);
        view.setInt32(24, season | 0, true);
        view.setInt32(28, 0, true);
        view.setFloat32(32, Number.isFinite(this.worldScale) ? this.worldScale : 1.0, true);
        this.device.queue.writeBuffer(this.resolvedColorUniformBuffer, 0, data);
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

    async initializePipelines() {

        // ── Standard terrain shader (base height / macro) ─────────
        const terrainShaderCode = createAdvancedTerrainComputeShader({
            baseGenerator: this.baseGenerator,
            maxBiomes: this.maxGpuBiomes,
            terrainShaderBundle: this.terrainShaderBundle,
            tileCategories: this.tileCategories,
            tileTypes: this.tileTypes,
        });
        this.terrainShaderModule = this.device.createShaderModule({
            label: 'Advanced Terrain Compute',
            code: terrainShaderCode
        });

        // ── Height-input terrain shader (normal + tile from height) ─
        const heightInputShaderCode = createAdvancedTerrainComputeShader({
            baseGenerator: this.baseGenerator,
            hasHeightBindings: true,
            maxBiomes: this.maxGpuBiomes,
            terrainShaderBundle: this.terrainShaderBundle,
            tileCategories: this.tileCategories,
            tileTypes: this.tileTypes,
        });
        this.heightInputShaderModule = this.device.createShaderModule({
            label: 'Height Input Terrain Compute',
            code: heightInputShaderCode
        });

        // ── Micro terrain shader (height + tile inputs) ────────────
        const microShaderCode = createAdvancedTerrainComputeShader({
            baseGenerator: this.baseGenerator,
            hasHeightBindings: true,
            hasTileBindings: true,
            maxBiomes: this.maxGpuBiomes,
            terrainShaderBundle: this.terrainShaderBundle,
            tileCategories: this.tileCategories,
            tileTypes: this.tileTypes,
        });
        this.microShaderModule = this.device.createShaderModule({
            label: 'Micro Terrain Compute',
            code: microShaderCode
        });

        // ── Splat shader ──────────────────────────────────────────
        const splatShaderCode = createSplatComputeShader({
            tileCategories: this.tileCategories,
            buildTileCategoryLookupWGSL: this.buildTileCategoryLookupWGSL,
        });
        this.splatShaderModule = this.device.createShaderModule({
            label: 'Splat Compute',
            code: splatShaderCode
        });
        const splatPaletteShaderCode = createSplatPaletteComputeShader({
            tileCategories: this.tileCategories,
            buildTileCategoryLookupWGSL: this.buildTileCategoryLookupWGSL,
        });
        this.splatPaletteShaderModule = this.device.createShaderModule({
            label: 'Splat Palette Compute',
            code: splatPaletteShaderCode
        });
        const splatValidityShaderCode = createSplatValidityComputeShader();
        this.splatValidityShaderModule = this.device.createShaderModule({
            label: 'Splat Validity Compute',
            code: splatValidityShaderCode
        });
        const resolvedColorShaderCode = createResolvedTerrainColorComputeShader();
        this.resolvedColorShaderModule = this.device.createShaderModule({
            label: 'Resolved Terrain Color Compute',
            code: resolvedColorShaderCode
        });
        if (typeof this.splatShaderModule.getCompilationInfo === 'function') {
            this.splatShaderModule.getCompilationInfo()
                .then((info) => {
                    const messages = Array.isArray(info?.messages) ? info.messages : [];
                    if (messages.length === 0) {
                        Logger.info(`${SPLAT_STEP_PREFIX} [SplatDebug] shader compilation info: no messages`);
                        return;
                    }
                    for (const msg of messages.slice(0, 12)) {
                        Logger.warn(
                            `${SPLAT_STEP_PREFIX} [SplatDebug] shader compilation ${msg.type || 'info'} ` +
                            `line=${msg.lineNum ?? '?'} pos=${msg.linePos ?? '?'} len=${msg.length ?? '?'}: ${msg.message}`
                        );
                    }
                    if (messages.length > 12) {
                        Logger.warn(`${SPLAT_STEP_PREFIX} [SplatDebug] shader compilation messages truncated: ${messages.length}`);
                    }
                })
                .catch(() => {});
        }

        // ── Uniform buffers ───────────────────────────────────────
        this.terrainUniformBuffer = this.device.createBuffer({
            size: 512,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });
        this.splatUniformBuffer = this.device.createBuffer({
            size: 80,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });
        this.resolvedColorUniformBuffer = this.device.createBuffer({
            size: 64,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });
        this.resolvedColorAtlasSampler = this.device.createSampler({
            addressModeU: 'repeat',
            addressModeV: 'repeat',
            magFilter: 'linear',
            minFilter: 'linear'
        });
        this.biomeUniformBuffer = this.device.createBuffer({
            size: getPackedBiomeUniformByteSize(this.maxGpuBiomes),
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });
        this.biomeBindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: 'uniform' }
                }
            ]
        });
        this.biomeBindGroup = this.device.createBindGroup({
            layout: this.biomeBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.biomeUniformBuffer } }
            ]
        });
        this._uploadPackedBiomeUniforms();

        // ── Standard terrain bind group layout (bindings 0,1) ──────
        this.terrainBindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE,
                  buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE,
                  storageTexture: { access: 'write-only',
                                    format: 'rgba32float',
                                    viewDimension: '2d' } }
            ]
        });
        this.terrainPipeline = this.device.createComputePipeline({
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [this.terrainBindGroupLayout, this.biomeBindGroupLayout]
            }),
            compute: { module: this.terrainShaderModule, entryPoint: 'main' }
        });

        // ── Height-input bind group layout (bindings 0,1,2) ────────
        this.heightInputBindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE,
                  buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE,
                  storageTexture: { access: 'write-only',
                                    format: 'rgba32float',
                                    viewDimension: '2d' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE,
                  texture: { sampleType: 'unfilterable-float',
                             viewDimension: '2d' } }
            ]
        });
        this.heightInputPipeline = this.device.createComputePipeline({
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [this.heightInputBindGroupLayout, this.biomeBindGroupLayout]
            }),
            compute: { module: this.heightInputShaderModule, entryPoint: 'main' }
        });

        // ── Micro bind group layout (bindings 0,1,2,3) ─────────────
        this.microBindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE,
                  buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE,
                  storageTexture: { access: 'write-only',
                                    format: 'rgba32float',
                                    viewDimension: '2d' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE,
                  texture: { sampleType: 'unfilterable-float',
                             viewDimension: '2d' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE,
                  texture: { sampleType: 'unfilterable-float',
                             viewDimension: '2d' } }
            ]
        });
        this.microPipeline = this.device.createComputePipeline({
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [this.microBindGroupLayout, this.biomeBindGroupLayout]
            }),
            compute: { module: this.microShaderModule, entryPoint: 'main' }
        });

        // ── Pipeline caches ───────────────────────────────────────
        this._terrainPipelineCache = new Map();
        this._terrainPipelineCache.set('rgba32float', {
            pipeline: this.terrainPipeline,
            bindGroupLayout: this.terrainBindGroupLayout
        });

        // Height-input cache (keyed by output format)
        this._heightInputPipelineCache = new Map();
        this._heightInputPipelineCache.set(
            this._getHeightInputPipelineCacheKey('rgba32float', 'r32float'),
            {
                pipeline: this.heightInputPipeline,
                bindGroupLayout: this.heightInputBindGroupLayout
            }
        );

        // Micro cache (keyed by output format)
        this._microPipelineCache = new Map();
        this._microPipelineCache.set(
            this._getMicroPipelineCacheKey('rgba32float', 'r32float', 'r32float'),
            {
                pipeline: this.microPipeline,
                bindGroupLayout: this.microBindGroupLayout
            }
        );

        // ── Splat pipeline ────────────────────────────────────────
        this.splatBindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE,
                  buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE,
                  texture: { sampleType: 'unfilterable-float',
                             viewDimension: '2d' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE,
                  texture: { sampleType: 'unfilterable-float',
                             viewDimension: '2d' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE,
                  storageTexture: { access: 'write-only',
                                    format: 'rgba8unorm',
                                    viewDimension: '2d' } },
                { binding: 4, visibility: GPUShaderStage.COMPUTE,
                  storageTexture: { access: 'write-only',
                                    format: 'rgba8unorm',
                                    viewDimension: '2d' } },
                { binding: 5, visibility: GPUShaderStage.COMPUTE,
                  texture: { sampleType: 'float',
                             viewDimension: '2d' } }
            ]
        });
        this.splatPipeline = this.device.createComputePipeline({
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [this.splatBindGroupLayout]
            }),
            compute: { module: this.splatShaderModule, entryPoint: 'main' }
        });
        this.splatPaletteBindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE,
                  buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE,
                  texture: { sampleType: 'unfilterable-float',
                             viewDimension: '2d' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE,
                  storageTexture: { access: 'write-only',
                                    format: 'rgba8unorm',
                                    viewDimension: '2d' } }
            ]
        });
        this.splatPalettePipeline = this.device.createComputePipeline({
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [this.splatPaletteBindGroupLayout]
            }),
            compute: { module: this.splatPaletteShaderModule, entryPoint: 'main' }
        });
        this.splatValidityBindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    texture: {
                        sampleType: gpuFormatSampleType('rgba8unorm'),
                        viewDimension: '2d'
                    }
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.COMPUTE,
                    storageTexture: {
                        access: 'write-only',
                        format: 'rgba8unorm',
                        viewDimension: '2d'
                    }
                }
            ]
        });
        this.splatValidityPipeline = this.device.createComputePipeline({
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [this.splatValidityBindGroupLayout]
            }),
            compute: { module: this.splatValidityShaderModule, entryPoint: 'main' }
        });
        this.resolvedColorBindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE,
                  buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE,
                  storageTexture: { access: 'write-only',
                                    format: 'rgba8unorm',
                                    viewDimension: '2d' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE,
                  texture: { sampleType: gpuFormatSampleType('rgba8unorm'),
                             viewDimension: '2d' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE,
                  texture: { sampleType: gpuFormatSampleType('rgba8unorm'),
                             viewDimension: '2d' } },
                { binding: 4, visibility: GPUShaderStage.COMPUTE,
                  texture: { sampleType: gpuFormatSampleType('r8unorm'),
                             viewDimension: '2d' } },
                { binding: 5, visibility: GPUShaderStage.COMPUTE,
                  texture: { sampleType: 'float',
                             viewDimension: '2d-array' } },
                { binding: 6, visibility: GPUShaderStage.COMPUTE,
                  texture: { sampleType: 'unfilterable-float',
                             viewDimension: '2d' } },
                { binding: 7, visibility: GPUShaderStage.COMPUTE,
                  sampler: { type: 'filtering' } },
            ]
        });
        this.resolvedColorPipeline = this.device.createComputePipeline({
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [this.resolvedColorBindGroupLayout]
            }),
            compute: { module: this.resolvedColorShaderModule, entryPoint: 'main' }
        });
        this._splatPipelineCache = new Map();
        this._splatPipelineCache.set(
            this._getSplatPipelineCacheKey('r32float', 'r32float'),
            {
                pipeline: this.splatPipeline,
                bindGroupLayout: this.splatBindGroupLayout
            }
        );
        this._splatPalettePipelineCache = new Map();
        this._splatPalettePipelineCache.set(
            this._getSplatPalettePipelineCacheKey('r32float'),
            {
                pipeline: this.splatPalettePipeline,
                bindGroupLayout: this.splatPaletteBindGroupLayout
            }
        );
        this._splatValidityPipelineCache = new Map();
        this._splatValidityPipelineCache.set(
            this._getSplatValidityPipelineCacheKey('rgba8unorm', 'rgba8unorm'),
            {
                pipeline: this.splatValidityPipeline,
                bindGroupLayout: this.splatValidityBindGroupLayout
            }
        );
        this._padTilePipelineCache = new Map();
        this._splatDebugProbePipelineCache = new Map();
        this._padTileUniformBuffer = this.device.createBuffer({
            label: 'PadTile-Params',
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });
        this._r8ResolvePipelineCache = new Map();
        this._r8ResolveScratchBuffer = null;
        this._r8ResolveScratchSize = 0;
        this._r8ResolveParamsBuffer = this.device.createBuffer({
            label: 'ResolveR8-Params',
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });

        // ── Batched tile generation resources ─────────────────────
        this._batchTerrainUniforms = [];
        for (let i = 0; i < 6; i++) {
            this._batchTerrainUniforms.push(this.device.createBuffer({
                label: `TerrainBatchUniform-${i}`,
                size: 512,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
            }));
        }
        this._terrainUniformScratch = new ArrayBuffer(512);
    }

    // ================================================================
    //  Height-input pipeline (normal/tile from height texture)
    // ================================================================
    _getHeightInputPipelineCacheKey(format, heightFormat = 'r32float') {
        return `${format || 'rgba32float'}|h:${gpuFormatSampleType(heightFormat || 'r32float')}`;
    }

    _getHeightInputPipelineForFormat(format, heightFormat = 'r32float') {
        const fmt = format || 'rgba32float';
        const inputFmt = heightFormat || 'r32float';
        const cacheKey = this._getHeightInputPipelineCacheKey(fmt, inputFmt);
        const cached = this._heightInputPipelineCache?.get(cacheKey);
        if (cached) return cached;

        const shaderCode = createAdvancedTerrainComputeShader({
            baseGenerator: this.baseGenerator,
            outputFormat: fmt,
            hasHeightBindings: true,
            maxBiomes: this.maxGpuBiomes,
            terrainShaderBundle: this.terrainShaderBundle,
            tileCategories: this.tileCategories,
            tileTypes: this.tileTypes,
        });
        const shaderModule = this.device.createShaderModule({
            label: `Height Input Terrain Compute (${fmt})`,
            code: shaderCode
        });

        const bindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: 'uniform' }
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.COMPUTE,
                    storageTexture: {
                        access: 'write-only',
                        format: fmt,
                        viewDimension: '2d'
                    }
                },
                {
                    binding: 2,
                    visibility: GPUShaderStage.COMPUTE,
                    texture: {
                        sampleType: gpuFormatSampleType(inputFmt),
                        viewDimension: '2d'
                    }
                }
            ]
        });

        const pipeline = this.device.createComputePipeline({
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [bindGroupLayout, this.biomeBindGroupLayout]
            }),
            compute: { module: shaderModule, entryPoint: 'main' }
        });

        if (!this._heightInputPipelineCache) {
            this._heightInputPipelineCache = new Map();
        }
        const record = { pipeline, bindGroupLayout };
        this._heightInputPipelineCache.set(cacheKey, record);
        return record;
    }

    // ================================================================
    //  Micro pipeline (height + tile inputs)
    // ================================================================
    _getMicroPipelineCacheKey(format, heightFormat = 'r32float', tileFormat = 'r32float') {
        return `${format || 'rgba32float'}|h:${gpuFormatSampleType(heightFormat || 'r32float')}|t:${gpuFormatSampleType(tileFormat || 'r32float')}`;
    }

    _getMicroPipelineForFormat(format, heightFormat = 'r32float', tileFormat = 'r32float') {
        const fmt = format || 'rgba32float';
        const hFmt = heightFormat || 'r32float';
        const tFmt = tileFormat || 'r32float';
        const cacheKey = this._getMicroPipelineCacheKey(fmt, hFmt, tFmt);
        const cached = this._microPipelineCache?.get(cacheKey);
        if (cached) return cached;

        const shaderCode = createAdvancedTerrainComputeShader({
            baseGenerator: this.baseGenerator,
            outputFormat: fmt,
            hasHeightBindings: true,
            hasTileBindings: true,
            maxBiomes: this.maxGpuBiomes,
            terrainShaderBundle: this.terrainShaderBundle,
            tileCategories: this.tileCategories,
            tileTypes: this.tileTypes,
        });
        const shaderModule = this.device.createShaderModule({
            label: `Micro Terrain Compute (${fmt})`,
            code: shaderCode
        });

        const bindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE,
                  buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE,
                  storageTexture: { access: 'write-only',
                                    format: fmt,
                                    viewDimension: '2d' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE,
                  texture: { sampleType: gpuFormatSampleType(hFmt),
                             viewDimension: '2d' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE,
                  texture: { sampleType: gpuFormatSampleType(tFmt),
                             viewDimension: '2d' } }
            ]
        });

        const pipeline = this.device.createComputePipeline({
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [bindGroupLayout, this.biomeBindGroupLayout]
            }),
            compute: { module: shaderModule, entryPoint: 'main' }
        });

        if (!this._microPipelineCache) this._microPipelineCache = new Map();
        const record = { pipeline, bindGroupLayout };
        this._microPipelineCache.set(cacheKey, record);
        return record;
    }

    _getSplatPipelineCacheKey(heightFormat = 'r32float', tileFormat = 'r32float') {
        return `h:${gpuFormatSampleType(heightFormat || 'r32float')}|t:${gpuFormatSampleType(tileFormat || 'r32float')}`;
    }

    _getSplatPipelineForFormats(heightFormat = 'r32float', tileFormat = 'r32float') {
        const hFmt = heightFormat || 'r32float';
        const tFmt = tileFormat || 'r32float';
        const cacheKey = this._getSplatPipelineCacheKey(hFmt, tFmt);
        const cached = this._splatPipelineCache?.get(cacheKey);
        if (cached) return cached;
    
        const bindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: 'uniform' }
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.COMPUTE,
                    texture: {
                        sampleType: gpuFormatSampleType(hFmt),
                        viewDimension: '2d'
                    }
                },
                {
                    binding: 2,
                    visibility: GPUShaderStage.COMPUTE,
                    texture: {
                        sampleType: gpuFormatSampleType(tFmt),
                        viewDimension: '2d'
                    }
                },
                {
                    binding: 3,
                    visibility: GPUShaderStage.COMPUTE,
                    storageTexture: {
                        access: 'write-only',
                        format: 'rgba8unorm',
                        viewDimension: '2d'
                    }
                },
                {
                    binding: 4,
                    visibility: GPUShaderStage.COMPUTE,
                    storageTexture: {
                        access: 'write-only',
                        format: 'rgba8unorm',
                        viewDimension: '2d'
                    }
                },
                {
                    binding: 5,
                    visibility: GPUShaderStage.COMPUTE,
                    texture: {
                        sampleType: gpuFormatSampleType('rgba8unorm'),
                        viewDimension: '2d'
                    }
                }
            ]
        });
    
        const pipeline = this.device.createComputePipeline({
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [bindGroupLayout]
            }),
            compute: { module: this.splatShaderModule, entryPoint: 'main' }
        });
    
        if (!this._splatPipelineCache) {
            this._splatPipelineCache = new Map();
        }
        const record = { pipeline, bindGroupLayout };
        this._splatPipelineCache.set(cacheKey, record);
        return record;
    }

    _getSplatPalettePipelineCacheKey(tileFormat = 'r32float') {
        return `t:${gpuFormatSampleType(tileFormat || 'r32float')}`;
    }

    _getSplatPalettePipelineForFormat(tileFormat = 'r32float') {
        const tFmt = tileFormat || 'r32float';
        const cacheKey = this._getSplatPalettePipelineCacheKey(tFmt);
        const cached = this._splatPalettePipelineCache?.get(cacheKey);
        if (cached) return cached;

        const bindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: 'uniform' }
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.COMPUTE,
                    texture: {
                        sampleType: gpuFormatSampleType(tFmt),
                        viewDimension: '2d'
                    }
                },
                {
                    binding: 2,
                    visibility: GPUShaderStage.COMPUTE,
                    storageTexture: {
                        access: 'write-only',
                        format: 'rgba8unorm',
                        viewDimension: '2d'
                    }
                }
            ]
        });

        const pipeline = this.device.createComputePipeline({
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [bindGroupLayout]
            }),
            compute: { module: this.splatPaletteShaderModule, entryPoint: 'main' }
        });

        if (!this._splatPalettePipelineCache) {
            this._splatPalettePipelineCache = new Map();
        }
        const record = { pipeline, bindGroupLayout };
        this._splatPalettePipelineCache.set(cacheKey, record);
        return record;
    }

    _getSplatValidityPipelineCacheKey(indexFormat = 'rgba8unorm', maskFormat = 'rgba8unorm') {
        return `i:${gpuFormatSampleType(indexFormat || 'rgba8unorm')}|m:${maskFormat || 'rgba8unorm'}`;
    }

    _getSplatValidityPipelineForFormats(indexFormat = 'rgba8unorm', maskFormat = 'rgba8unorm') {
        const iFmt = indexFormat || 'rgba8unorm';
        const mFmt = maskFormat || 'rgba8unorm';
        const cacheKey = this._getSplatValidityPipelineCacheKey(iFmt, mFmt);
        const cached = this._splatValidityPipelineCache?.get(cacheKey);
        if (cached) return cached;

        const bindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    texture: {
                        sampleType: gpuFormatSampleType(iFmt),
                        viewDimension: '2d'
                    }
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.COMPUTE,
                    storageTexture: {
                        access: 'write-only',
                        format: mFmt,
                        viewDimension: '2d'
                    }
                }
            ]
        });

        const pipeline = this.device.createComputePipeline({
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [bindGroupLayout]
            }),
            compute: { module: this.splatValidityShaderModule, entryPoint: 'main' }
        });

        if (!this._splatValidityPipelineCache) {
            this._splatValidityPipelineCache = new Map();
        }
        const record = { pipeline, bindGroupLayout };
        this._splatValidityPipelineCache.set(cacheKey, record);
        return record;
    }
    _getPadTilePipelineForFormat(tileFormat = 'r8unorm') {
        const sampleType = gpuFormatSampleType(tileFormat || 'r8unorm');
        const cacheKey = `${tileFormat || 'r8unorm'}|${sampleType}`;
        const cached = this._padTilePipelineCache?.get(cacheKey);
        if (cached) return cached;

        const shaderModule = this.device.createShaderModule({
            label: `PadTile (${cacheKey})`,
            code: /* wgsl */`
struct PadTileParams {
    padding: u32,
    sourceWidth: u32,
    sourceHeight: u32,
    _pad0: u32,
};

@group(0) @binding(0) var<uniform> params: PadTileParams;
@group(0) @binding(1) var sourceTileTex: texture_2d<f32>;
@group(0) @binding(2) var paddedTileTex: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let outSize = textureDimensions(paddedTileTex);
    if (global_id.x >= outSize.x || global_id.y >= outSize.y) {
        return;
    }

    let sourceSize = vec2<i32>(
        i32(max(params.sourceWidth, 1u)),
        i32(max(params.sourceHeight, 1u))
    );
    let srcCoord = clamp(
        vec2<i32>(global_id.xy) - vec2<i32>(i32(params.padding)),
        vec2<i32>(0),
        sourceSize - vec2<i32>(1)
    );
    let sample = textureLoad(sourceTileTex, srcCoord, 0);
    textureStore(
        paddedTileTex,
        vec2<i32>(global_id.xy),
        vec4<f32>(sample.r, 0.0, 0.0, 1.0)
    );
}
`
        });

        const bindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE,
                  buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE,
                  texture: { sampleType: sampleType, viewDimension: '2d' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE,
                  storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d' } }
            ]
        });

        const pipeline = this.device.createComputePipeline({
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [bindGroupLayout]
            }),
            compute: { module: shaderModule, entryPoint: 'main' }
        });

        const record = { pipeline, bindGroupLayout };
        this._padTilePipelineCache.set(cacheKey, record);
        return record;
    }

    _getSplatDebugProbePipeline(mode = 'constantWrite') {
        const cacheKey = mode || 'constantWrite';
        const cached = this._splatDebugProbePipelineCache?.get(cacheKey);
        if (cached) return cached;

        const categoryCount = this.tileCategories.length;
        const tileCategoryWGSL = this.buildTileCategoryLookupWGSL();
        const representativeLines = ['fn categoryRepresentativeTileId(categoryId: u32) -> u32 {'];
        for (const category of this.tileCategories) {
            representativeLines.push(
                `    if (categoryId == ${category.id}u) { return ${category.ranges[0][0]}u; } // ${category.name}`
            );
        }
        representativeLines.push('    return 255u;');
        representativeLines.push('}');
        const categoryRepresentativeWGSL = representativeLines.join('\n');

        let code = '';
        let bindGroupLayout = null;

        if (mode === 'constantWrite') {
            code = /* wgsl */`
@group(0) @binding(0) var outTex: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let outSize = textureDimensions(outTex);
    if (global_id.x >= outSize.x || global_id.y >= outSize.y) {
        return;
    }
    textureStore(outTex, vec2<i32>(global_id.xy), vec4<f32>(1.0, 0.0, 0.0, 1.0));
}
`;
            bindGroupLayout = this.device.createBindGroupLayout({
                entries: [
                    {
                        binding: 0,
                        visibility: GPUShaderStage.COMPUTE,
                        storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d' }
                    }
                ]
            });
        } else {
            code = /* wgsl */`
struct ProbeParams {
    padding: u32,
    innerWidth: u32,
    innerHeight: u32,
    _pad0: u32,
};

@group(0) @binding(0) var<uniform> params: ProbeParams;
@group(0) @binding(1) var tileMap: texture_2d<f32>;
@group(0) @binding(2) var outTex: texture_storage_2d<rgba8unorm, write>;

const INVALID_TILE_ID: u32 = 255u;
const INVALID_CATEGORY_ID: u32 = 255u;
const CATEGORY_SCORE_COUNT: u32 = ${categoryCount}u;

fn decodeTileIdRaw(tileSample: vec4<f32>) -> u32 {
    let rawR = tileSample.r;
    let tileIdF = select(rawR * 255.0, rawR, rawR > 1.0);
    return u32(tileIdF + 0.5);
}

${tileCategoryWGSL}

${categoryRepresentativeWGSL}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let outSize = textureDimensions(outTex);
    if (global_id.x >= outSize.x || global_id.y >= outSize.y) {
        return;
    }

    let tileMapSize = textureDimensions(tileMap);
    let maxCoord = vec2<i32>(tileMapSize) - vec2<i32>(1);
    let paddedInset = vec2<u32>(params.padding);
    let innerTileMapSize = max(tileMapSize - paddedInset * 2u, vec2<u32>(1u));
    let sourcePos =
        vec2<f32>(paddedInset)
        +
        (vec2<f32>(global_id.xy) + vec2<f32>(0.5))
        * vec2<f32>(innerTileMapSize)
        / vec2<f32>(outSize);
    let centerCoord = clamp(vec2<i32>(floor(sourcePos)), vec2<i32>(0), maxCoord);
    let sample = textureLoad(tileMap, centerCoord, 0);
    let tileId = decodeTileIdRaw(sample);
`;
            if (mode === 'tileEcho') {
                code += /* wgsl */`
    textureStore(
        outTex,
        vec2<i32>(global_id.xy),
        vec4<f32>(sample.r, sample.r, 1.0, 1.0)
    );
}
`;
            } else {
                code += /* wgsl */`
    let categoryId = tileCategory(tileId);
    var categoryRepresentative = INVALID_TILE_ID;
    if (categoryId < CATEGORY_SCORE_COUNT) {
        categoryRepresentative = categoryRepresentativeTileId(categoryId);
    }
    let categoryEncoded = select(0.0, f32(categoryId) / 255.0, categoryId < CATEGORY_SCORE_COUNT);
    let representativeEncoded = select(
        0.0,
        f32(categoryRepresentative) / 255.0,
        categoryRepresentative < INVALID_TILE_ID
    );
    textureStore(
        outTex,
        vec2<i32>(global_id.xy),
        vec4<f32>(representativeEncoded, categoryEncoded, 1.0, 1.0)
    );
}
`;
            }

            bindGroupLayout = this.device.createBindGroupLayout({
                entries: [
                    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                    { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float', viewDimension: '2d' } },
                    {
                        binding: 2,
                        visibility: GPUShaderStage.COMPUTE,
                        storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d' }
                    }
                ]
            });
        }

        const shaderModule = this.device.createShaderModule({
            label: `SplatDebugProbe (${cacheKey})`,
            code
        });
        const pipeline = this.device.createComputePipeline({
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [bindGroupLayout]
            }),
            compute: { module: shaderModule, entryPoint: 'main' }
        });

        const record = { pipeline, bindGroupLayout };
        this._splatDebugProbePipelineCache.set(cacheKey, record);
        return record;
    }

    _getResolveR8PipelineForSampleType(sampleType = 'float') {
        const key = sampleType || 'float';
        const cached = this._r8ResolvePipelineCache?.get(key);
        if (cached) return cached;

        const shaderModule = this.device.createShaderModule({
            label: `ResolveR8 (${key})`,
            code: /* wgsl */`
struct ResolveParams {
    width: u32,
    height: u32,
    wordsPerRow: u32,
    strideWords: u32,
};

@group(0) @binding(0) var sourceTex: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> outWords: array<u32>;
@group(0) @binding(2) var<uniform> params: ResolveParams;

fn packUnorm8(v: f32) -> u32 {
    return u32(clamp(v, 0.0, 1.0) * 255.0 + 0.5);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let wordX = gid.x;
    let y = gid.y;
    if (wordX >= params.wordsPerRow || y >= params.height) { return; }

    let baseX = wordX * 4u;
    var packed = 0u;
    for (var lane = 0u; lane < 4u; lane++) {
        let srcX = baseX + lane;
        if (srcX >= params.width) { break; }
        let sample = textureLoad(sourceTex, vec2<i32>(i32(srcX), i32(y)), 0).r;
        packed = packed | (packUnorm8(sample) << (lane * 8u));
    }

    let dstIndex = y * params.strideWords + wordX;
    outWords[dstIndex] = packed;
}
`
        });

        const bindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE,
                  texture: { sampleType: key, viewDimension: '2d' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE,
                  buffer: { type: 'storage' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE,
                  buffer: { type: 'uniform' } }
            ]
        });

        const pipeline = this.device.createComputePipeline({
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [bindGroupLayout]
            }),
            compute: { module: shaderModule, entryPoint: 'main' }
        });

        if (!this._r8ResolvePipelineCache) this._r8ResolvePipelineCache = new Map();
        const record = { pipeline, bindGroupLayout };
        this._r8ResolvePipelineCache.set(key, record);
        return record;
    }

    _ensureResolveR8Scratch(width, height) {
        const bytesPerRow = Math.ceil((width * gpuFormatBytesPerTexel('r8unorm')) / 256) * 256;
        const requiredSize = bytesPerRow * height;
        if (!this._r8ResolveScratchBuffer || this._r8ResolveScratchSize < requiredSize) {
            if (this._r8ResolveScratchBuffer) {
                this._r8ResolveScratchBuffer.destroy();
            }
            this._r8ResolveScratchBuffer = this.device.createBuffer({
                label: 'ResolveR8-Scratch',
                size: requiredSize,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
            });
            this._r8ResolveScratchSize = requiredSize;
        }
        return {
            bytesPerRow,
            wordsPerRow: Math.ceil(width / 4),
            strideWords: bytesPerRow / 4,
            buffer: this._r8ResolveScratchBuffer
        };
    }

    resolveTexture2D(encoder, sourceTexture, sourceFormat, destTexture, destFormat, width, height) {
        if (!encoder || !sourceTexture || !destTexture) return;

        if (sourceTexture === destTexture && sourceFormat === destFormat) {
            return;
        }

        if (sourceFormat === destFormat) {
            encoder.copyTextureToTexture(
                { texture: sourceTexture },
                { texture: destTexture },
                { width, height, depthOrArrayLayers: 1 }
            );
            return;
        }

        if (destFormat !== 'r8unorm') {
            throw new Error(`Unsupported resolve target format: ${destFormat}`);
        }

        const scratch = this._ensureResolveR8Scratch(width, height);
        const params = new Uint32Array([
            width >>> 0,
            height >>> 0,
            scratch.wordsPerRow >>> 0,
            scratch.strideWords >>> 0
        ]);
        this.device.queue.writeBuffer(this._r8ResolveParamsBuffer, 0, params);

        const { pipeline, bindGroupLayout } =
            this._getResolveR8PipelineForSampleType(gpuFormatSampleType(sourceFormat));

        const pass = encoder.beginComputePass({ label: `Resolve ${sourceFormat} -> ${destFormat}` });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, this.device.createBindGroup({
            layout: bindGroupLayout,
            entries: [
                { binding: 0, resource: sourceTexture.createView() },
                { binding: 1, resource: { buffer: scratch.buffer } },
                { binding: 2, resource: { buffer: this._r8ResolveParamsBuffer } }
            ]
        }));
        pass.dispatchWorkgroups(
            Math.ceil(scratch.wordsPerRow / 8),
            Math.ceil(height / 8)
        );
        pass.end();

        encoder.copyBufferToTexture(
            { buffer: scratch.buffer, bytesPerRow: scratch.bytesPerRow },
            { texture: destTexture },
            { width, height, depthOrArrayLayers: 1 }
        );
    }

    getStorageTextureWriteFormat(format = 'rgba32float') {
        if (format === 'r8unorm') return 'rgba8unorm';
        return format;
    }

    createStorageBackedOutputTarget(width, height, format = 'rgba32float') {
        const finalFormat = format || 'rgba32float';
        const storageFormat = this.getStorageTextureWriteFormat(finalFormat);
        if (storageFormat === finalFormat) {
            const texture = this.createGPUTexture(width, height, finalFormat);
            return {
                finalTexture: texture,
                storageTexture: texture,
                finalFormat,
                storageFormat,
                requiresResolve: false
            };
        }

        return {
            finalTexture: this.createSampledGPUTexture(width, height, finalFormat),
            storageTexture: this.createGPUTexture(width, height, storageFormat),
            finalFormat,
            storageFormat,
            requiresResolve: true
        };
    }

    createGPUTexture(width, height, format = 'rgba32float', usage = null) {
        return this.device.createTexture({
            size: [width, height],
            format: format,
            usage: usage ?? (
                GPUTextureUsage.STORAGE_BINDING |
                GPUTextureUsage.TEXTURE_BINDING |
                GPUTextureUsage.COPY_SRC |
                GPUTextureUsage.COPY_DST
            )
        });
    }

    createSampledGPUTexture(width, height, format = 'rgba32float') {
        return this.createGPUTexture(
            width,
            height,
            format,
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.COPY_SRC |
            GPUTextureUsage.COPY_DST
        );
    }

    estimateAtlasMemory(config) {
        const textureSize = config.textureSize;
        const heightNormalSize = textureSize;
        const tileSize = textureSize;
        const splatSize = textureSize;
        const bytesPerPixel = 16;
        const total = (heightNormalSize**2 + heightNormalSize**2 + tileSize**2 + splatSize**2 + splatSize**2 + splatSize**2) * bytesPerPixel;
        
        return { total, totalMB: (total / 1024 / 1024).toFixed(2) };
    }

  // ================================================================
    //  generateAtlasTextures
    //  Base height → tile → micro height → normal
    // ================================================================
    async generateAtlasTextures(atlasKey, config) {
        const textureSize = config.textureSize;
        const chunkSizeTex = Math.max(1,
            Math.floor(textureSize / config.chunksPerAxis));

        const atlasChunkX = atlasKey.atlasX * config.chunksPerAxis;
        const atlasChunkY = atlasKey.atlasY * config.chunksPerAxis;
        const faceIndex   = atlasKey.face !== null ? atlasKey.face : -1;

        const gpuHeight = this.getOrCreateAtlasTexture(atlasKey, 'height', textureSize);
        const gpuNormal = this.getOrCreateAtlasTexture(atlasKey, 'normal', textureSize);
        const gpuTile   = this.getOrCreateAtlasTexture(atlasKey, 'tile',   textureSize);
        const gpuHeightBase = this.createGPUTexture(textureSize, textureSize, 'rgba32float');
        let gpuSplatData = null;
        let gpuSplatIndex = null;

        await this.runTerrainPassAtlas(gpuHeightBase, atlasChunkX, atlasChunkY,
            faceIndex, 0, textureSize, textureSize, chunkSizeTex, config.gridSize);

        await this.runTerrainPassAtlas(gpuTile, atlasChunkX, atlasChunkY,
            faceIndex, 2, textureSize, textureSize, chunkSizeTex, config.gridSize,
            gpuHeightBase);

        await this.runTerrainPassAtlas(gpuHeight, atlasChunkX, atlasChunkY,
            faceIndex, 4, textureSize, textureSize, chunkSizeTex, config.gridSize,
            gpuHeightBase, gpuTile);

        await this.runTerrainPassAtlas(gpuNormal, atlasChunkX, atlasChunkY,
            faceIndex, 1, textureSize, textureSize, chunkSizeTex, config.gridSize,
            gpuHeight);

        if (true) {
            gpuSplatData = this.getOrCreateAtlasTexture(
                atlasKey, 'splat', config.splatSize);
            gpuSplatIndex = this.getOrCreateAtlasTexture(
                atlasKey, 'splatIndex', config.splatSize);
            await this.runSplatPassAtlas(
                gpuHeight,
                gpuTile,
                gpuSplatData,
                gpuSplatIndex,
                atlasChunkX,
                atlasChunkY,
                config.splatSize,
                config.splatSize,
                chunkSizeTex,
                'r32float',
                'r32float'
            );
        }

        return {
            height: gpuHeight,
            normal: gpuNormal,
            tile: gpuTile,
            splatData: gpuSplatData,
            splatIndex: gpuSplatIndex
        };
    }

    async generateLODAtlasTextures(atlasKey, config) {
        if (!this.initialized) await this.initialize();

        const lodConfig      = config.getConfigForLOD(atlasKey.lod);
        const textureSize    = lodConfig.textureSize;
        const chunksPerAtlas = requireInt(
            lodConfig.chunksPerAtlas, 'lodAtlasConfig.chunksPerAtlas', 1);
        const chunksPerFace  = requireInt(
            config.chunksPerFace, 'lodAtlasConfig.chunksPerFace', 1);
        const atlasesPerAxis = Math.max(1,
            Math.ceil(chunksPerFace / chunksPerAtlas));
        const atlasesPerFace = atlasesPerAxis * atlasesPerAxis;
        const arrayCapacity  = Math.min(128,
            Math.max(16, atlasesPerFace));

        // Per-type formats. Staging textures and pool layers must agree
        // because we copyTextureToTexture between them.
        const atlasFormats = config.atlasTextureFormats || {};
        const fmt = (name) => {
            if (name === 'splatIndex') return atlasFormats.splatIndex || 'rgba8unorm';
            return atlasFormats[name] || 'rgba32float';
        };

        if (this._atlasGenLogCount === undefined) this._atlasGenLogCount = 0;

        // ... (pool reservation probing unchanged) ...
        const hasVirtualPool =
            this.textureCache?.hasVirtualTexturePool?.() || false;
        let useTextureCachePool = hasVirtualPool;
        if (useTextureCachePool && this.textureCache?.canReservePooledLODAtlas) {
            const canReserve =
                this.textureCache.canReservePooledLODAtlas(atlasKey);
            if (!canReserve) {
                useTextureCachePool = false;
                if (!this._poolFallbackWarned) this._poolFallbackWarned = new Set();
                const warnKey = `lod${atlasKey.lod}`;
                if (!this._poolFallbackWarned.has(warnKey))
                    this._poolFallbackWarned.add(warnKey);
            }
        }

        // Staging textures: format now per-type (was hardcoded rgba32float).
        const gpuHeight    = this.createGPUTexture(textureSize, textureSize, fmt('height'));
        const gpuHeightBase = this.createGPUTexture(textureSize, textureSize, 'rgba32float');
        const gpuNormal    = this.createGPUTexture(textureSize, textureSize, fmt('normal'));
        const gpuTile      = this.createGPUTexture(textureSize, textureSize, fmt('tile'));
        const gpuMacro     = this.createGPUTexture(textureSize, textureSize, fmt('macro'));
        const gpuSplatData = this.createGPUTexture(textureSize, textureSize, fmt('splatData'));
        const gpuSplatIndex = this.createGPUTexture(textureSize, textureSize, fmt('splatIndex'));

        const chunkSizeTex  = Math.max(1, Math.floor(textureSize / chunksPerAtlas));
        const chunkCoordX   = atlasKey.atlasX * chunksPerAtlas;
        const chunkCoordY   = atlasKey.atlasY * chunksPerAtlas;
        const chunkGridSize = chunksPerFace;

        this._runBatchedLODTerrainPasses({
            gpuHeightBase, gpuHeight, gpuNormal, gpuTile, gpuMacro,
            chunkCoordX, chunkCoordY, chunkSizeTex, chunkGridSize,
            face: atlasKey.face,
            textureSize,
            formats: atlasFormats
        });

        // ... (pre-splat diagnostic unchanged) ...
        if (this._preSplatCheckCount === undefined) this._preSplatCheckCount = 0;
        if (this._preSplatCheckCount < 3) {
            this._preSplatCheckCount++;
            try {
                const tileCheck = await this.readTextureWindowR8Unorm(
                    gpuTile, 0, 0,
                    Math.min(32, textureSize),
                    Math.min(32, textureSize));
                let tileTypes = new Set();
                let nonZero = 0;
                for (let i = 0; i < tileCheck.length; i += 1) {
                    const tid = tileCheck[i];
                    tileTypes.add(tid);
                    if (tid > 0) nonZero++;
                }
                Logger.info(
                    `[SplatDebug] Pre-splat tile check: ${nonZero} non-zero pixels, ` +
                    `types={${[...tileTypes].sort((a,b)=>a-b).join(',')}}`);
                if (tileTypes.size <= 1)
                    Logger.warn(`[SplatDebug] ⚠️ Tile texture has only ${tileTypes.size} type(s)`);
                if (nonZero === 0)
                    Logger.warn(`[SplatDebug] ⚠️ Tile texture is ALL ZEROS`);
            } catch (e) {
                Logger.warn(`[SplatDebug] Pre-splat tile check failed: ${e}`);
            }
        }

        await this.runLODSplatPass(
            gpuHeight,
            gpuTile,
            gpuSplatData,
            gpuSplatIndex,
            chunkCoordX,
            chunkCoordY,
            config.worldCoverage,
            textureSize,
            atlasKey.lod,
            fmt('height'),
            fmt('tile')
        );

        // Wrap with per-type formats.
        const textures = {
            height:    this.wrapGPUTexture(gpuHeight,    textureSize, textureSize, fmt('height'), true),
            normal:    this.wrapGPUTexture(gpuNormal,    textureSize, textureSize, fmt('normal')),
            tile:      this.wrapGPUTexture(gpuTile,      textureSize, textureSize, fmt('tile')),
            macro:     this.wrapGPUTexture(gpuMacro,     textureSize, textureSize, fmt('macro')),
            splatData: this.wrapGPUTexture(gpuSplatData, textureSize, textureSize, fmt('splatData')),
            splatIndex: this.wrapGPUTexture(gpuSplatIndex, textureSize, textureSize, fmt('splatIndex'), true)
        };

        await this._debugLogAtlasStats(atlasKey, {
            height: gpuHeight, tile: gpuTile
        }, textureSize, chunkGridSize, chunkCoordX, chunkCoordY);
        // ── Pool / array upload (unchanged from previous refactor) ──
        let pooledAllocation = null;
        if (useTextureCachePool) {
            pooledAllocation =
                this.textureCache.reservePooledLODAtlas?.(atlasKey) || null;
            if (!pooledAllocation || !pooledAllocation.arrayTextures) {
                useTextureCachePool = false;
                if (!this._poolFallbackWarned)
                    this._poolFallbackWarned = new Set();
                const warnKey = `alloc_lod${atlasKey.lod}`;
                if (!this._poolFallbackWarned.has(warnKey))
                    this._poolFallbackWarned.add(warnKey);
            }
        }

        const allowArrayPools = this.useTextureArrays
            && !useTextureCachePool && !hasVirtualPool;
        const arrayInfoByType = {};
        const uploadToArray = (type, sourceTex) => {
            if (!allowArrayPools) return;
            const arrayFormat = fmt(type);
            const texelBytes = gpuFormatBytesPerTexel(arrayFormat);   // ← was local switch
            const bytesPerLayer = textureSize * textureSize * texelBytes;

            const maxLayersByBudget = Math.max(1,
                Math.floor(this.maxArrayBytesPerType / bytesPerLayer));
            const capacity = Math.max(1,
                Math.min(arrayCapacity, maxLayersByBudget));
            const poolKey = `${type}_lod${atlasKey.lod}_${textureSize}_${arrayFormat}`;
            let pool = this.arrayPools.get(poolKey);
            if (!pool) {
                const arrayTex = this.device.createTexture({
                    size:   [textureSize, textureSize, capacity],
                    format: arrayFormat,
                    usage:  GPUTextureUsage.TEXTURE_BINDING
                          | GPUTextureUsage.COPY_DST
                          | GPUTextureUsage.COPY_SRC
                });
                pool = { texture: arrayTex, capacity, nextLayer: 0,
                         freeLayers: [], size: textureSize, format: arrayFormat };
                this.arrayPools.set(poolKey, pool);
            }
            let layer = -1;
            if (pool.freeLayers.length > 0) {
                layer = pool.freeLayers.pop();
            } else if (pool.nextLayer < pool.capacity) {
                layer = pool.nextLayer++;
            } else {
                return;
            }
            const encoder = this.device.createCommandEncoder();
            encoder.copyTextureToTexture(
                { texture: sourceTex._gpuTexture.texture },
                { texture: pool.texture, origin: { x: 0, y: 0, z: layer } },
                { width: textureSize, height: textureSize, depthOrArrayLayers: 1 }
            );
            this.device.queue.submit([encoder.finish()]);
            if (!pool.wrapper) {
                const useNearest = (type === 'height' || type === 'tile' || type === 'splatData' || type === 'splatIndex');
                const filterable = gpuFormatIsFilterable(arrayFormat);
                const effectiveNearest = useNearest || !filterable;
                const filter = effectiveNearest
                    ? TextureFilter.NEAREST : TextureFilter.LINEAR;
                const wrap = new Texture({
                    width: textureSize, height: textureSize,
                    depth: pool.capacity,
                    format: gpuFormatToWrapperFormat(arrayFormat),
                    minFilter: filter, magFilter: filter,
                    generateMipmaps: false
                });
                wrap._gpuTexture = {
                    texture: pool.texture,
                    view: pool.texture.createView({ dimension: '2d-array' }),
                    format: arrayFormat
                };
                wrap._isArray = true;
                wrap._needsUpload = false;
                wrap._gpuFormat = arrayFormat;
                wrap._isFilterable = filterable;
                pool.wrapper = wrap;
            }
            arrayInfoByType[type] = {
                layer,
                arrayTexture: pool.wrapper,
                poolKey,
                release: () => {
                    if (this.arrayPools.has(poolKey)) {
                        const p = this.arrayPools.get(poolKey);
                        p.freeLayers.push(layer);
                    }
                }
            };
        };
        uploadToArray('height',     textures.height);
        uploadToArray('normal',     textures.normal);
        uploadToArray('tile',       textures.tile);
        uploadToArray('macro',      textures.macro);
        uploadToArray('splatData',  textures.splatData);
        uploadToArray('splatIndex', textures.splatIndex);

        const textureTypes = ['height', 'normal', 'tile', 'macro', 'splatData', 'splatIndex'];
        if (useTextureCachePool && pooledAllocation) {
            const encoder = this.device.createCommandEncoder();
            const layer = pooledAllocation.layer;
            const copyToPool = (type, sourceTex) => {
                const dstWrapper = pooledAllocation.arrayTextures[type];
                const dstTex = dstWrapper?._gpuTexture?.texture;
                const srcTex = sourceTex?._gpuTexture?.texture;
                if (!dstTex || !srcTex) return;
                const copySize = textureSize;
                encoder.copyTextureToTexture(
                    { texture: srcTex },
                    { texture: dstTex,
                      origin: { x: 0, y: 0, z: layer } },
                    { width: copySize, height: copySize, depthOrArrayLayers: 1 }
                );
            };
            copyToPool('height',     textures.height);
            copyToPool('normal',     textures.normal);
            copyToPool('tile',       textures.tile);
            copyToPool('macro',      textures.macro);
            copyToPool('splatData',  textures.splatData);
            copyToPool('splatIndex', textures.splatIndex);
            this.device.queue.submit([encoder.finish()]);

            for (const type of textureTypes) {
                const arrayTexture = pooledAllocation.arrayTextures[type];
                const arrayInfo = { layer, arrayTexture, isPooled: true };
                this.textureCache.setLODAtlas(
                    atlasKey, type, arrayTexture, 0, arrayInfo);
            }

            if (this.textureCache?.deferTextureDestruction) {
                for (const type of textureTypes)
                    this.textureCache.deferTextureDestruction(textures[type]);
            }
        } else {
            const skipVirtualPool = hasVirtualPool && !useTextureCachePool;
            const skipPoolInfo = skipVirtualPool ? { skipPool: true } : null;
            for (const type of textureTypes) {
                const useArray = arrayInfoByType[type]?.arrayTexture;
                const cachedTex = useArray
                    ? arrayInfoByType[type].arrayTexture
                    : textures[type];
                // Per-type size — normals at rgba8unorm are 4×
                // smaller than rgba32float, so the cache's eviction
                // watermark must see the real number.
                const typeSize = textureSize;
                const size = typeSize * typeSize
                           * gpuFormatBytesPerTexel(fmt(type));
                const arrayInfo = arrayInfoByType[type] || skipPoolInfo;
                this.textureCache.setLODAtlas(
                    atlasKey, type, cachedTex, size, arrayInfo);
            }
        }

        return {
            atlasKey:    atlasKey,
            textures:    textures,
            lod:         atlasKey.lod,
            textureSize: textureSize
        };
    }


    // ================================================================
    //  runTerrainPassAtlas
    //  Optional heightTex/tileTex for height-input and micro passes.
    // ================================================================
    async runTerrainPassAtlas(outTex, atlasChunkX, atlasChunkY, face, type,
        w, h, chunkSize, chunkGridSize,
        heightTex = null, tileTex = null) {
const data = new ArrayBuffer(512);
const v = new DataView(data);

v.setInt32(0, atlasChunkX | 0, true);
v.setInt32(4, atlasChunkY | 0, true);
v.setInt32(8, chunkSize | 0, true);
v.setInt32(12, chunkGridSize | 0, true);
v.setInt32(16, this.seed, true);

v.setFloat32(20, this.macroConfig.biomeScale, true);
v.setFloat32(24, this.macroConfig.regionScale, true);
v.setFloat32(28, this.detailScale, true);
v.setFloat32(32, this.ridgeScale, true);
v.setFloat32(36, this.valleyScale, true);
v.setFloat32(40, this.plateauScale, true);
v.setFloat32(44, this.worldScale, true);

v.setInt32(48, type, true);
v.setInt32(52, face, true);

v.setInt32(56, this.debugMode, true);
v.setInt32(60, 0, true);

const uniforms = this._getTerrainShaderUniforms();

v.setFloat32(80,  uniforms.continentParams[0], true);
v.setFloat32(84,  uniforms.continentParams[1], true);
v.setFloat32(88,  uniforms.continentParams[2], true);
v.setFloat32(92,  uniforms.continentParams[3], true);

v.setFloat32(96,  uniforms.tectonicParams[0], true);
v.setFloat32(100, uniforms.tectonicParams[1], true);
v.setFloat32(104, uniforms.tectonicParams[2], true);
v.setFloat32(108, uniforms.tectonicParams[3], true);

v.setFloat32(112, uniforms.waterParams[0], true);
v.setFloat32(116, uniforms.waterParams[1], true);
v.setFloat32(120, uniforms.waterParams[2], true);
v.setFloat32(124, uniforms.waterParams[3], true);

v.setFloat32(128, uniforms.erosionParams[0], true);
v.setFloat32(132, uniforms.erosionParams[1], true);
v.setFloat32(136, uniforms.erosionParams[2], true);
v.setFloat32(140, uniforms.erosionParams[3], true);

v.setFloat32(144, uniforms.volcanicParams[0], true);
v.setFloat32(148, uniforms.volcanicParams[1], true);
v.setFloat32(152, uniforms.volcanicParams[2], true);
v.setFloat32(156, uniforms.volcanicParams[3], true);

v.setFloat32(160, uniforms.climateParams[0], true);
v.setFloat32(164, uniforms.climateParams[1], true);
v.setFloat32(168, uniforms.climateParams[2], true);
v.setFloat32(172, uniforms.climateParams[3], true);
this._writeTerrainPaddingUniforms(v, uniforms);
this._writeClimateZoneUniforms(v, uniforms);

this.device.queue.writeBuffer(this.terrainUniformBuffer, 0, data);

const enc = this.device.createCommandEncoder();
const pass = enc.beginComputePass();

// ── Select pipeline based on required inputs ──
const isMicroPass = (type === 4 || type === 5 || type === 6) && heightTex && tileTex;
const isHeightInputPass =
    !isMicroPass && (type === 1 || type === 2) && heightTex;

if (isMicroPass) {
const { pipeline, bindGroupLayout } =
this._getMicroPipelineForFormat('rgba32float', 'r32float', 'r32float');
pass.setPipeline(pipeline);
pass.setBindGroup(0, this.device.createBindGroup({
layout: bindGroupLayout,
entries: [
{ binding: 0,
resource: { buffer: this.terrainUniformBuffer } },
{ binding: 1, resource: outTex.createView() },
{ binding: 2, resource: heightTex.createView() },
{ binding: 3, resource: tileTex.createView() }
]
}));
this._setTerrainBiomeBindGroup(pass);
} else if (isHeightInputPass) {
const { pipeline, bindGroupLayout } =
this._getHeightInputPipelineForFormat('rgba32float', 'r32float');
pass.setPipeline(pipeline);
pass.setBindGroup(0, this.device.createBindGroup({
layout: bindGroupLayout,
entries: [
{ binding: 0,
resource: { buffer: this.terrainUniformBuffer } },
{ binding: 1, resource: outTex.createView() },
{ binding: 2, resource: heightTex.createView() }
]
}));
this._setTerrainBiomeBindGroup(pass);
} else {
pass.setPipeline(this.terrainPipeline);
pass.setBindGroup(0, this.device.createBindGroup({
layout: this.terrainBindGroupLayout,
entries: [
{ binding: 0,
resource: { buffer: this.terrainUniformBuffer } },
{ binding: 1, resource: outTex.createView() }
]
}));
this._setTerrainBiomeBindGroup(pass);
}

pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
pass.end();
this.device.queue.submit([enc.finish()]);
}

    // ================================================================
    //  runLODTerrainPass
    //  Optional heightTex/tileTex for height-input and micro passes.
    // ================================================================
    async runLODTerrainPass(outTex, chunkCoordX, chunkCoordY,
        chunkSizeTex, chunkGridSize, face, type,
        textureSize, outputFormat = 'rgba32float',
        heightTex = null, tileTex = null) {
if (this._lodPassLogCount === undefined) this._lodPassLogCount = 0;
if (this._lodPassLogCount < 3 && type === 0) {
this._lodPassLogCount++;
const uniforms = this._getTerrainShaderUniforms();
console.log(`[TerrainDebug] runLODTerrainPass: chunkSizeTex=${chunkSizeTex}, chunkGridSize=${chunkGridSize}, textureSize=${textureSize}, face=${face}, chunkCoord=(${chunkCoordX},${chunkCoordY})`);
console.log(`[TerrainDebug] noiseProfileA=${JSON.stringify(uniforms.noiseProfileA)}, noiseRefRadius=${this.noiseReferenceRadiusM}, worldScale=${this.worldScale}`);
}

const data = new ArrayBuffer(512);
const v = new DataView(data);

v.setInt32(0,  chunkCoordX | 0, true);
v.setInt32(4,  chunkCoordY | 0, true);
v.setInt32(8,  chunkSizeTex | 0, true);
v.setInt32(12, chunkGridSize | 0, true);
v.setInt32(16, this.seed, true);

v.setFloat32(20, this.macroConfig.biomeScale, true);
v.setFloat32(24, this.macroConfig.regionScale, true);
v.setFloat32(28, this.detailScale, true);
v.setFloat32(32, this.ridgeScale, true);
v.setFloat32(36, this.valleyScale, true);
v.setFloat32(40, this.plateauScale, true);
v.setFloat32(44, this.worldScale, true);

v.setInt32(48, type, true);
v.setInt32(52, face !== null ? (face | 0) : -1, true);

v.setInt32(56, this.debugMode, true);
v.setInt32(60, 0, true);

const uniforms = this._getTerrainShaderUniforms();

v.setFloat32(80,  uniforms.continentParams[0], true);
v.setFloat32(84,  uniforms.continentParams[1], true);
v.setFloat32(88,  uniforms.continentParams[2], true);
v.setFloat32(92,  uniforms.continentParams[3], true);

v.setFloat32(96,  uniforms.tectonicParams[0], true);
v.setFloat32(100, uniforms.tectonicParams[1], true);
v.setFloat32(104, uniforms.tectonicParams[2], true);
v.setFloat32(108, uniforms.tectonicParams[3], true);

v.setFloat32(112, uniforms.waterParams[0], true);
v.setFloat32(116, uniforms.waterParams[1], true);
v.setFloat32(120, uniforms.waterParams[2], true);
v.setFloat32(124, uniforms.waterParams[3], true);

v.setFloat32(128, uniforms.erosionParams[0], true);
v.setFloat32(132, uniforms.erosionParams[1], true);
v.setFloat32(136, uniforms.erosionParams[2], true);
v.setFloat32(140, uniforms.erosionParams[3], true);

v.setFloat32(144, uniforms.volcanicParams[0], true);
v.setFloat32(148, uniforms.volcanicParams[1], true);
v.setFloat32(152, uniforms.volcanicParams[2], true);
v.setFloat32(156, uniforms.volcanicParams[3], true);

v.setFloat32(160, uniforms.climateParams[0], true);
v.setFloat32(164, uniforms.climateParams[1], true);
v.setFloat32(168, uniforms.climateParams[2], true);
v.setFloat32(172, uniforms.climateParams[3], true);
this._writeTerrainPaddingUniforms(v, uniforms);
this._writeClimateZoneUniforms(v, uniforms);

if (this._logUniformsOnNextPass && type === 0) {
this._logUniformsOnNextPass = false;
console.log(`[TerrainDebug] Uniforms: chunkCoord=(${chunkCoordX},${chunkCoordY}), chunkSize=${chunkSizeTex}, chunkGridSize=${chunkGridSize}, face=${face}`);
console.log(`[TerrainDebug] noiseProfileA=[${uniforms.noiseProfileA}], noiseProfileB=[${uniforms.noiseProfileB}]`);
}

this.device.queue.writeBuffer(this.terrainUniformBuffer, 0, data);

const enc = this.device.createCommandEncoder();
const pass = enc.beginComputePass();

// ── Select pipeline based on required inputs ──
const isMicroPass = (type === 4 || type === 5 || type === 6) && heightTex && tileTex;
const isHeightInputPass =
    !isMicroPass && (type === 1 || type === 2) && heightTex;

if (isMicroPass) {
const { pipeline, bindGroupLayout } =
this._getMicroPipelineForFormat(outputFormat);
pass.setPipeline(pipeline);
pass.setBindGroup(0, this.device.createBindGroup({
layout: bindGroupLayout,
entries: [
{ binding: 0,
 resource: { buffer: this.terrainUniformBuffer } },
{ binding: 1, resource: outTex.createView() },
{ binding: 2, resource: heightTex.createView() },
{ binding: 3, resource: tileTex.createView() }
]
}));
this._setTerrainBiomeBindGroup(pass);
} else if (isHeightInputPass) {
const { pipeline, bindGroupLayout } =
this._getHeightInputPipelineForFormat(outputFormat);
pass.setPipeline(pipeline);
pass.setBindGroup(0, this.device.createBindGroup({
layout: bindGroupLayout,
entries: [
{ binding: 0,
 resource: { buffer: this.terrainUniformBuffer } },
{ binding: 1, resource: outTex.createView() },
{ binding: 2, resource: heightTex.createView() }
]
}));
this._setTerrainBiomeBindGroup(pass);
} else {
const { pipeline, bindGroupLayout } =
this._getTerrainPipelineForFormat(outputFormat);
pass.setPipeline(pipeline);
pass.setBindGroup(0, this.device.createBindGroup({
layout: bindGroupLayout,
entries: [
{ binding: 0,
 resource: { buffer: this.terrainUniformBuffer } },
{ binding: 1, resource: outTex.createView() }
]
}));
this._setTerrainBiomeBindGroup(pass);
}

pass.dispatchWorkgroups(
Math.ceil(textureSize / 8),
Math.ceil(textureSize / 8));
pass.end();
this.device.queue.submit([enc.finish()]);
}
    
    async runSplatPassAtlas(hTex, tTex, splatDataTex, splatIndexTex, atlasChunkX, atlasChunkY, w, h, chunkSize, heightFormat = 'r32float', tileFormat = 'r32float') {
        this._writeSplatUniformBuffer({
            chunkCoordX: atlasChunkX,
            chunkCoordY: atlasChunkY,
            chunkSizeTex: chunkSize,
            inputPadding: 0,
        });

        const paletteSize = this._getSplatPaletteDimensions(w, h, chunkSize);
        const splatPaletteTex = this.createGPUTexture(
            paletteSize.width,
            paletteSize.height,
            'rgba8unorm'
        );
        const { pipeline: palettePipeline, bindGroupLayout: paletteBindGroupLayout } =
            this._getSplatPalettePipelineForFormat(tileFormat);
        const { pipeline, bindGroupLayout } =
            this._getSplatPipelineForFormats(heightFormat, tileFormat);
        const enc = this.device.createCommandEncoder();
        {
            const pass = enc.beginComputePass();
            pass.setPipeline(palettePipeline);
            pass.setBindGroup(0, this.device.createBindGroup({
                layout: paletteBindGroupLayout,
                entries: [
                    { binding: 0, resource: { buffer: this.splatUniformBuffer } },
                    { binding: 1, resource: tTex.createView() },
                    { binding: 2, resource: splatPaletteTex.createView() }
                ]
            }));
            pass.dispatchWorkgroups(
                Math.ceil(paletteSize.width / 8),
                Math.ceil(paletteSize.height / 8)
            );
            pass.end();
        }
        {
            const pass = enc.beginComputePass();
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, this.device.createBindGroup({
                layout: bindGroupLayout,
                entries: [
                    { binding: 0, resource: { buffer: this.splatUniformBuffer } },
                    { binding: 1, resource: hTex.createView() },
                    { binding: 2, resource: tTex.createView() },
                    { binding: 3, resource: splatDataTex.createView() },
                    { binding: 4, resource: splatIndexTex.createView() },
                    { binding: 5, resource: splatPaletteTex.createView() }
                ]
            }));
            
            pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
            pass.end();
        }
        this.device.queue.submit([enc.finish()]);
        this.device.queue.onSubmittedWorkDone()
            .then(() => { try { splatPaletteTex.destroy(); } catch (_) {} })
            .catch(() => {});
    }

    async runLODSplatPass(hTex, tTex, splatDataTex, splatIndexTex, chunkCoordX, chunkCoordY, worldCoverage, textureSize, lod, heightFormat = 'r32float', tileFormat = 'r32float') {
        const chunksPerAtlas = Math.max(1, Math.floor(worldCoverage / this.chunkSize));
        const chunkSizeTex = Math.max(1, Math.floor(textureSize / chunksPerAtlas));
    
        // ──────────────────────────────────────────────────────────────
        // DIAGNOSTIC: Log splat pass parameters
        // ──────────────────────────────────────────────────────────────
        if (this._splatPassLogCount === undefined) this._splatPassLogCount = 0;
        if (this._splatPassLogCount < 5) {
            this._splatPassLogCount++;
            Logger.info(`[SplatDebug] ═══════════════════════════════════════════════`);
            Logger.info(`[SplatDebug] runLODSplatPass #${this._splatPassLogCount}`);
            Logger.info(`[SplatDebug]   chunkCoord=(${chunkCoordX}, ${chunkCoordY})`);
            Logger.info(`[SplatDebug]   worldCoverage=${worldCoverage}`);
            Logger.info(`[SplatDebug]   this.chunkSize=${this.chunkSize}`);
            Logger.info(`[SplatDebug]   chunksPerAtlas=${chunksPerAtlas}`);
            Logger.info(`[SplatDebug]   chunkSizeTex=${chunkSizeTex}`);
            Logger.info(`[SplatDebug]   textureSize=${textureSize}`);
            Logger.info(`[SplatDebug]   lod=${lod}`);
            Logger.info(`[SplatDebug]   splatDensity=${this.splatDensity}`);
            Logger.info(`[SplatDebug]   splatKernelSize=${this.splatKernelSize}`);
            Logger.info(`[SplatDebug]   heightTex size=${hTex.width}x${hTex.height}`);
            Logger.info(`[SplatDebug]   tileTex size=${tTex.width}x${tTex.height}`);
            Logger.info(`[SplatDebug]   splatOutTex size=${splatDataTex.width}x${splatDataTex.height}`);
            
            // Critical check: is chunkSizeTex == textureSize? 
            // If so, useAtlas in shader will be FALSE, and UV math changes completely
            const useAtlasExpected = (textureSize > chunkSizeTex);
            Logger.info(`[SplatDebug]   shader useAtlas will be: ${useAtlasExpected}`);
            Logger.info(`[SplatDebug]   perChunkDim = chunkSizeTex * splatDensity = ${chunkSizeTex * this.splatDensity}`);
            
            if (chunkSizeTex >= textureSize) {
                Logger.warn(`[SplatDebug]   ⚠️ chunkSizeTex >= textureSize! Only 1 chunk in atlas.`);
                Logger.warn(`[SplatDebug]   ⚠️ Shader will treat entire texture as single chunk.`);
            }
            if (chunkSizeTex < 2) {
                Logger.warn(`[SplatDebug]   ⚠️ chunkSizeTex < 2! Tile sampling will collapse.`);
            }
        }
    
        this._writeSplatUniformBuffer({
            chunkCoordX,
            chunkCoordY,
            chunkSizeTex,
            inputPadding: 0,
        });

        const paletteSize = this._getSplatPaletteDimensions(textureSize, textureSize, chunkSizeTex);
        const splatPaletteTex = this.createGPUTexture(
            paletteSize.width,
            paletteSize.height,
            'rgba8unorm'
        );
        const { pipeline: palettePipeline, bindGroupLayout: paletteBindGroupLayout } =
            this._getSplatPalettePipelineForFormat(tileFormat);
        const { pipeline, bindGroupLayout } =
            this._getSplatPipelineForFormats(heightFormat, tileFormat);
        const enc = this.device.createCommandEncoder();
        {
            const pass = enc.beginComputePass();
            pass.setPipeline(palettePipeline);
            pass.setBindGroup(0, this.device.createBindGroup({
                layout: paletteBindGroupLayout,
                entries: [
                    { binding: 0, resource: { buffer: this.splatUniformBuffer } },
                    { binding: 1, resource: tTex.createView() },
                    { binding: 2, resource: splatPaletteTex.createView() }
                ]
            }));
            pass.dispatchWorkgroups(
                Math.ceil(paletteSize.width / 8),
                Math.ceil(paletteSize.height / 8)
            );
            pass.end();
        }
        {
            const pass = enc.beginComputePass();
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, this.device.createBindGroup({
                layout: bindGroupLayout,
                entries: [
                    { binding: 0, resource: { buffer: this.splatUniformBuffer } },
                    { binding: 1, resource: hTex.createView() },
                    { binding: 2, resource: tTex.createView() },
                    { binding: 3, resource: splatDataTex.createView() },
                    { binding: 4, resource: splatIndexTex.createView() },
                    { binding: 5, resource: splatPaletteTex.createView() }
                ]
            }));
    
            // Dispatch must cover the full splat output texture, not just the tile map
            const splatW = splatDataTex.width || textureSize;
            const splatH = splatDataTex.height || textureSize;
            pass.dispatchWorkgroups(Math.ceil(splatW / 8), Math.ceil(splatH / 8));
            pass.end();
        }
        this.device.queue.submit([enc.finish()]);
        this.device.queue.onSubmittedWorkDone()
            .then(() => { try { splatPaletteTex.destroy(); } catch (_) {} })
            .catch(() => {});

        // ──────────────────────────────────────────────────────────────
        // DIAGNOSTIC: Read back splat data and verify contents
        // ──────────────────────────────────────────────────────────────
        if (this._splatReadbackCount === undefined) this._splatReadbackCount = 0;
        if (this._splatReadbackCount < 3) {
            this._splatReadbackCount++;
            try {
                await this._debugValidateSplatOutput(splatDataTex, tTex, textureSize, chunkSizeTex);
            } catch (err) {
                Logger.warn(`[SplatDebug] Readback failed: ${err.message || err}`);
            }
        }
    }
    
    /**
     * Read back splat and tile textures to verify the compute shader produced valid data.
     */
    async _debugValidateSplatOutput(splatGpuTex, tileGpuTex, textureSize, chunkSizeTex) {
        const sampleSize = Math.min(64, textureSize);
        const regions = [
            { x: 0, y: 0, label: 'top-left' },
            { x: Math.max(0, Math.floor(textureSize / 2) - sampleSize / 2),
              y: Math.max(0, Math.floor(textureSize / 2) - sampleSize / 2),
              label: 'center' },
            { x: Math.max(0, textureSize - sampleSize),
              y: Math.max(0, textureSize - sampleSize),
              label: 'bottom-right' }
        ];
    
        for (const region of regions) {
            const splatData = await this.readTextureWindowRGBA8Unorm(
                splatGpuTex, region.x, region.y, sampleSize, sampleSize
            );
            const tileData = await this.readTextureWindowR8Unorm(
                tileGpuTex, region.x, region.y, sampleSize, sampleSize
            );
    
            let zeroCount = 0;
            let validCount = 0;
            let boundaryCount = 0;
            let primaryMin = Infinity, primaryMax = -Infinity;
            let type1Set = new Set();
            let type2Set = new Set();
            let splatSamples = [];
    
            for (let i = 0; i < splatData.length; i += 4) {
                const type1 = splatData[i];
                const type2 = splatData[i + 1];
                const weight = splatData[i + 2] / 255;
                const hasBoundary =  splatData[i + 3] > 127;

                if (!hasBoundary && weight > 0.999 && type1 === type2) {
                    zeroCount++;
                } else {
                    validCount++;
                    if (hasBoundary) boundaryCount++;
                    primaryMin = Math.min(primaryMin, weight);
                    primaryMax = Math.max(primaryMax, weight);
                    type1Set.add(type1);
                    type2Set.add(type2);
                }
    
                if (splatSamples.length < 5) {
                    splatSamples.push({
                        type1,
                        type2,
                        hasBoundary,
                        weight
                    });
                }
            }
    
            let tileTypeSet = new Set();
            let tileSamples = [];
            for (let i = 0; i < tileData.length; i += 1) {
                const tileId = tileData[i];
                tileTypeSet.add(tileId);
                if (tileSamples.length < 5) {
                    tileSamples.push({ raw: tileId, decoded: tileId });
                }
            }
    
            const totalPixels = sampleSize * sampleSize;
            const zeroPercent = ((zeroCount / totalPixels) * 100).toFixed(1);
    /*
            Logger.info(`[SplatDebug] ── Region: ${region.label} (${region.x},${region.y}) ${sampleSize}x${sampleSize} ──`);
            Logger.info(`[SplatDebug]   Splat: ${validCount} valid, ${zeroCount} zero (${zeroPercent}% empty)`);
    
            if (validCount > 0) {
                Logger.info(`[SplatDebug]   primary range: [${primaryMin.toFixed(4)}, ${primaryMax.toFixed(4)}]`);
                Logger.info(`[SplatDebug]   boundary texels: ${boundaryCount}`);
                Logger.info(`[SplatDebug]   type1 values: {${[...type1Set].sort((a,b)=>a-b).join(', ')}}`);
                Logger.info(`[SplatDebug]   type2 values: {${[...type2Set].sort((a,b)=>a-b).join(', ')}}`);
            } else {
                Logger.warn(`[SplatDebug]   ⚠️ ALL PIXELS ARE ZERO — splat compute produced no data!`);
            }
    
            Logger.info(`[SplatDebug]   Tile types in region: {${[...tileTypeSet].sort((a,b)=>a-b).join(', ')}}`);
            Logger.info(`[SplatDebug]   Sample splat pixels:`);
            for (const s of splatSamples) {
                Logger.info(
                    `[SplatDebug]     type1=${s.type1} type2=${s.type2} boundary=${s.hasBoundary} ` +
                    `weight=${s.weight.toFixed(3)}`
                );
            }
            Logger.info(`[SplatDebug]   Sample tile pixels:`);
            for (const t of tileSamples) {
                Logger.info(`[SplatDebug]     raw=${t.raw} decoded=${t.decoded}`);
            }
    
            // ── Critical diagnostics ──
            if (validCount > 0 && type1Set.size === 1 && type2Set.size <= 1) {
                const onlyType = [...type1Set][0];
                Logger.warn(`[SplatDebug]   ⚠️ Splat has only ONE tile type (${onlyType}) — no blending possible`);
                Logger.warn(`[SplatDebug]   ⚠️ This suggests tile map sampling is collapsed to one texel`);
            }
    
            if (tileTypeSet.size <= 1) {
                Logger.warn(`[SplatDebug]   ⚠️ Tile map has only ${tileTypeSet.size} type(s) in this region`);
                Logger.warn(`[SplatDebug]   ⚠️ Splat blending requires tile boundaries — check terrain generation`);
            }*/
        }
    }

    async _debugAnalyzeQuadtreeSplatPass(
        splatPass,
        paddedTileGpuTex,
        innerSize,
        paddedSize,
        padding,
        chunkCoordX,
        chunkCoordY,
        chunkGridSize,
        face,
        splatPrimePattern = null,
        debugProbeTextures = null,
        validationError = null
    ) {
        if (this._quadtreeSplatDiagCount === undefined) {
            this._quadtreeSplatDiagCount = 0;
        }
        if (this._quadtreeSplatDiagCount >= 3) {
            return;
        }
        this._quadtreeSplatDiagCount++;

        const sourceTile = await this._readTileTextureBytes(
            splatPass.tileTex,
            splatPass.tileFormat || 'r8unorm',
            0,
            0,
            innerSize,
            innerSize
        );
        const paddedTileRaw = await this.readTextureWindowRGBA8Unorm(
            paddedTileGpuTex,
            0,
            0,
            paddedSize,
            paddedSize
        );
        const splatData = await this.readTextureWindowRGBA8Unorm(
            splatPass.splatTex,
            0,
            0,
            innerSize,
            innerSize
        );

        let mismatchCount = 0;
        const mismatchSamples = [];
        const paddedInnerTile = new Uint8Array(innerSize * innerSize);
        for (let y = 0; y < innerSize; y++) {
            for (let x = 0; x < innerSize; x++) {
                const srcIdx = y * innerSize + x;
                const padIdx = ((y + padding) * paddedSize + (x + padding)) * 4;
                const paddedValue = paddedTileRaw[padIdx];
                paddedInnerTile[srcIdx] = paddedValue;
                if (paddedValue !== sourceTile[srcIdx]) {
                    mismatchCount++;
                    if (mismatchSamples.length < 6) {
                        mismatchSamples.push(
                            `(${x},${y}) src=${sourceTile[srcIdx]} pad=${paddedValue}`
                        );
                    }
                }
            }
        }

        const sourceCategories = summarizeTileCategoryHistogram(sourceTile, this.tileCategories);
        const paddedCategories = summarizeTileCategoryHistogram(paddedInnerTile, this.tileCategories);
        const splatSummary = summarizeSplatData(splatData, innerSize);
        const emulatedSplatData = emulateSplatOutputFromPaddedTile(
            paddedTileRaw,
            paddedSize,
            innerSize,
            padding,
            this.splatKernelSize,
            this.tileCategories
        );
        const emulatedSummary = summarizeSplatData(emulatedSplatData, innerSize);
        const compareSummary = compareSplatOutputs(
            splatData,
            emulatedSplatData,
            innerSize,
            splatPrimePattern
        );
        let constantWriteProbeSummary = null;
        let tileEchoProbeSummary = null;
        let categoryEchoProbeSummary = null;
        if (debugProbeTextures) {
            const constantWriteBytes = await this.readTextureWindowRGBA8Unorm(
                debugProbeTextures.constantWrite,
                0,
                0,
                innerSize,
                innerSize
            );
            const tileEchoBytes = await this.readTextureWindowRGBA8Unorm(
                debugProbeTextures.tileEcho,
                0,
                0,
                innerSize,
                innerSize
            );
            const categoryEchoBytes = await this.readTextureWindowRGBA8Unorm(
                debugProbeTextures.categoryEcho,
                0,
                0,
                innerSize,
                innerSize
            );
            constantWriteProbeSummary = summarizeRGBA8Pixels(constantWriteBytes);
            tileEchoProbeSummary = summarizeRGBA8Pixels(tileEchoBytes);
            categoryEchoProbeSummary = summarizeRGBA8Pixels(categoryEchoBytes);
        }

        Logger.info(
            `${SPLAT_STEP_PREFIX} [SplatDebug] Quadtree tile f${face} d≈${Math.round(Math.log2(Math.max(chunkGridSize, 1)))} ` +
            `coord=(${chunkCoordX},${chunkCoordY}) inner=${innerSize} padded=${paddedSize} padding=${padding}`
        );
        Logger.info(
            `${SPLAT_STEP_PREFIX} [SplatDebug]   source categories: ${formatCategorySummary(sourceCategories)}`
        );
        Logger.info(
            `${SPLAT_STEP_PREFIX} [SplatDebug]   padded-inner categories: ${formatCategorySummary(paddedCategories)}`
        );
        Logger.info(
            `${SPLAT_STEP_PREFIX} [SplatDebug]   padded-inner mismatches=${mismatchCount}/${innerSize * innerSize}` +
            `${mismatchSamples.length ? ` samples=${mismatchSamples.join(' ; ')}` : ''}`
        );
        Logger.info(
            `${SPLAT_STEP_PREFIX} [SplatDebug]   splat pairs: ${formatPairSummary(splatSummary.topPairs)} ` +
            `boundary=${splatSummary.boundaryPct.toFixed(1)}% ` +
            `stable4=${splatSummary.stable4Pct.toFixed(1)}% ` +
            `weight=[${splatSummary.weightMin.toFixed(3)}, ${splatSummary.weightMax.toFixed(3)}] ` +
            `avg=${splatSummary.weightMean.toFixed(3)}`
        );
        Logger.info(
            `${SPLAT_STEP_PREFIX} [SplatDebug]   emulated pairs: ${formatPairSummary(emulatedSummary.topPairs)} ` +
            `boundary=${emulatedSummary.boundaryPct.toFixed(1)}% ` +
            `stable4=${emulatedSummary.stable4Pct.toFixed(1)}% ` +
            `weight=[${emulatedSummary.weightMin.toFixed(3)}, ${emulatedSummary.weightMax.toFixed(3)}] ` +
            `avg=${emulatedSummary.weightMean.toFixed(3)}`
        );
        Logger.info(
            `${SPLAT_STEP_PREFIX} [SplatDebug]   compare: sentinel=${compareSummary.sentinelCount}/${compareSummary.totalPixels} ` +
            `zero=${compareSummary.zeroCount}/${compareSummary.totalPixels} ` +
            `fallback=${compareSummary.fallbackCount}/${compareSummary.totalPixels} ` +
            `mismatch=${compareSummary.mismatchCount}/${compareSummary.totalPixels}` +
            `${compareSummary.samples.length ? ` samples=${compareSummary.samples.join(' ; ')}` : ''}`
        );
        if (constantWriteProbeSummary) {
            Logger.info(
                `${SPLAT_STEP_PREFIX} [SplatDebug]   probe constant: ${formatRGBA8PixelSummary(constantWriteProbeSummary)}`
            );
        }
        if (tileEchoProbeSummary) {
            Logger.info(
                `${SPLAT_STEP_PREFIX} [SplatDebug]   probe tile-echo: ${formatRGBA8PixelSummary(tileEchoProbeSummary)}`
            );
        }
        if (categoryEchoProbeSummary) {
            Logger.info(
                `${SPLAT_STEP_PREFIX} [SplatDebug]   probe category-echo: ${formatRGBA8PixelSummary(categoryEchoProbeSummary)}`
            );
        }
        if (validationError) {
            Logger.warn(
                `${SPLAT_STEP_PREFIX} [SplatDebug]   validation error: ${validationError.message || validationError}`
            );
        }
    }

    async extractChunkDataFromAtlas(atlasKey, chunkX, chunkY, config, face = null) {
        const lod = atlasKey?.lod ?? 0;
        const heightAtlasData =
            this.textureCache.getLODAtlasForChunk?.(chunkX, chunkY, 'height', lod, face, config) ||
            this.textureCache.getAtlasForChunk?.(chunkX, chunkY, 'height', config, face);
        const tileAtlasData =
            this.textureCache.getLODAtlasForChunk?.(chunkX, chunkY, 'tile', lod, face, config) ||
            this.textureCache.getAtlasForChunk?.(chunkX, chunkY, 'tile', config, face);
        
        if (!heightAtlasData || !tileAtlasData) return null;

        const localPos = config.getLocalChunkPosition(chunkX, chunkY);
        const gpuHeightTex = heightAtlasData.texture._gpuTexture?.texture;
        const gpuTileTex = tileAtlasData.texture._gpuTexture?.texture;
        if (!gpuHeightTex || !gpuTileTex) return null;

        // Determine per-chunk texel dimensions for this LOD
        const lodCfg = config.getConfigForLOD ? config.getConfigForLOD(lod) : null;
        const atlasTextureSize = lodCfg
            ? requireNumber(lodCfg.textureSize, 'lodAtlasConfig.textureSize')
            : requireNumber(config.textureSize, 'config.textureSize');
        const chunksPerAtlas = lodCfg
            ? requireInt(lodCfg.chunksPerAtlas, 'lodAtlasConfig.chunksPerAtlas', 1)
            : requireInt(config.chunksPerAtlas, 'config.chunksPerAtlas', 1);
        const texelsPerChunk = Math.max(1, Math.floor(atlasTextureSize / chunksPerAtlas));

        const offsetX = localPos.localX * texelsPerChunk;
        const offsetY = localPos.localY * texelsPerChunk;

        try {
            const heightData = await this.readTextureSubregion(
                gpuHeightTex,
                offsetX,
                offsetY,
                Math.min(texelsPerChunk + 1, atlasTextureSize - offsetX),
                Math.min(texelsPerChunk + 1, atlasTextureSize - offsetY),
                atlasTextureSize
            );
            const tileData = await this.readTextureSubregion(
                gpuTileTex,
                offsetX,
                offsetY,
                Math.min(texelsPerChunk, atlasTextureSize - offsetX),
                Math.min(texelsPerChunk, atlasTextureSize - offsetY),
                atlasTextureSize
            );
            return { heightData, tileData };
        } catch(e) { return null; }
    }
    
    async readTextureSubregion(gpuTex, offsetX, offsetY, width, height, textureWidth) {
        const textureHeight = textureWidth; 
        // RGBA32F = 16 bytes per pixel
        const bytesPerRow = textureWidth * 16;
        const alignedBytesPerRow = Math.ceil(bytesPerRow / 256) * 256;
        const bufferSize = alignedBytesPerRow * textureHeight;
        
        const readBuffer = this.device.createBuffer({
            size: bufferSize,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        });
        
        const encoder = this.device.createCommandEncoder();
        encoder.copyTextureToBuffer(
            { texture: gpuTex },
            { buffer: readBuffer, bytesPerRow: alignedBytesPerRow },
            { width: textureWidth, height: textureHeight, depthOrArrayLayers: 1 }
        );
        this.device.queue.submit([encoder.finish()]);
        
        await readBuffer.mapAsync(GPUMapMode.READ);
        const fullData = new Float32Array(readBuffer.getMappedRange());
        const subregion = new Float32Array(width * height * 4);
        
        for (let y = 0; y < height; y++) {
            const srcRow = offsetY + y;
            const srcRowOffset = (srcRow * alignedBytesPerRow) / 4; 
            for (let x = 0; x < width; x++) {
                const srcIdx = srcRowOffset + (offsetX + x) * 4;
                const dstIdx = (y * width + x) * 4;
                subregion.set(fullData.subarray(srcIdx, srcIdx + 4), dstIdx);
            }
        }
        
        readBuffer.unmap();
        readBuffer.destroy();
        return subregion;
    }

    async readTextureWindowR8Unorm(gpuTex, offsetX, offsetY, width, height) {
        const bytesPerPixel = 1;
        const rowStride = Math.ceil(width * bytesPerPixel / 256) * 256;
        const bufferSize = rowStride * height;
        const readBuffer = this.device.createBuffer({
            size: bufferSize,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        });

        const encoder = this.device.createCommandEncoder();
        encoder.copyTextureToBuffer(
            { texture: gpuTex, origin: { x: offsetX, y: offsetY, z: 0 } },
            { buffer: readBuffer, bytesPerRow: rowStride, rowsPerImage: height },
            { width, height, depthOrArrayLayers: 1 }
        );
        this.device.queue.submit([encoder.finish()]);

        await readBuffer.mapAsync(GPUMapMode.READ);
        const mapped = new Uint8Array(readBuffer.getMappedRange());
        const result = new Uint8Array(width * height);

        for (let y = 0; y < height; y++) {
            const srcRowOffset = y * rowStride;
            const dstRowOffset = y * width;
            result.set(mapped.subarray(srcRowOffset, srcRowOffset + width), dstRowOffset);
        }

        readBuffer.unmap();
        readBuffer.destroy();
        return result;
    }

    async readTextureWindowRGBA8Unorm(gpuTex, offsetX, offsetY, width, height) {
        const bytesPerPixel = 4;
        const rowStride = Math.ceil(width * bytesPerPixel / 256) * 256;
        const bufferSize = rowStride * height;
        const readBuffer = this.device.createBuffer({
            size: bufferSize,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        });

        const encoder = this.device.createCommandEncoder();
        encoder.copyTextureToBuffer(
            { texture: gpuTex, origin: { x: offsetX, y: offsetY, z: 0 } },
            { buffer: readBuffer, bytesPerRow: rowStride, rowsPerImage: height },
            { width, height, depthOrArrayLayers: 1 }
        );
        this.device.queue.submit([encoder.finish()]);

        await readBuffer.mapAsync(GPUMapMode.READ);
        const mapped = new Uint8Array(readBuffer.getMappedRange());
        const result = new Uint8Array(width * height * 4);

        for (let y = 0; y < height; y++) {
            const srcRowOffset = y * rowStride;
            const dstRowOffset = y * width * 4;
            result.set(
                mapped.subarray(srcRowOffset, srcRowOffset + width * 4),
                dstRowOffset
            );
        }

        readBuffer.unmap();
        readBuffer.destroy();
        return result;
    }

    async _readTileTextureBytes(gpuTex, format, offsetX, offsetY, width, height) {
        if ((format || 'r8unorm') === 'rgba8unorm') {
            const rgba = await this.readTextureWindowRGBA8Unorm(
                gpuTex,
                offsetX,
                offsetY,
                width,
                height
            );
            const result = new Uint8Array(width * height);
            for (let i = 0; i < result.length; i++) {
                result[i] = rgba[i * 4];
            }
            return result;
        }
        return this.readTextureWindowR8Unorm(gpuTex, offsetX, offsetY, width, height);
    }

    _fillTextureRGBA8Unorm(gpuTex, width, height, rgba) {
        const bytesPerPixel = 4;
        const rowStride = Math.ceil((width * bytesPerPixel) / 256) * 256;
        const bufferSize = rowStride * height;
        const upload = new Uint8Array(bufferSize);
        const r = rgba?.[0] ?? 0;
        const g = rgba?.[1] ?? 0;
        const b = rgba?.[2] ?? 0;
        const a = rgba?.[3] ?? 0;

        for (let y = 0; y < height; y++) {
            const rowOffset = y * rowStride;
            for (let x = 0; x < width; x++) {
                const i = rowOffset + x * 4;
                upload[i] = r;
                upload[i + 1] = g;
                upload[i + 2] = b;
                upload[i + 3] = a;
            }
        }

        this.device.queue.writeTexture(
            { texture: gpuTex },
            upload,
            { offset: 0, bytesPerRow: rowStride, rowsPerImage: height },
            { width, height, depthOrArrayLayers: 1 }
        );
    }

    async readTextureWindow(gpuTex, offsetX, offsetY, width, height) {
        const bytesPerPixel = 16; // rgba32float
        const rowStride = Math.ceil(width * bytesPerPixel / 256) * 256;
        const bufferSize = rowStride * height;
        const readBuffer = this.device.createBuffer({
            size: bufferSize,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        });

        const encoder = this.device.createCommandEncoder();
        encoder.copyTextureToBuffer(
            { texture: gpuTex, origin: { x: offsetX, y: offsetY, z: 0 } },
            { buffer: readBuffer, bytesPerRow: rowStride, rowsPerImage: height },
            { width, height, depthOrArrayLayers: 1 }
        );
        this.device.queue.submit([encoder.finish()]);

        await readBuffer.mapAsync(GPUMapMode.READ);
        const mapped = new Float32Array(readBuffer.getMappedRange());
        const result = new Float32Array(width * height * 4);

        for (let y = 0; y < height; y++) {
            const srcRowOffset = (y * rowStride) / 4;
            const dstRowOffset = y * width * 4;
            result.set(mapped.subarray(srcRowOffset, srcRowOffset + width * 4), dstRowOffset);
        }

        readBuffer.unmap();
        readBuffer.destroy();
        return result;
    }

    async _debugLogAtlasStats(atlasKey, gpuTextures, textureSize, chunkGridSize, chunkCoordX, chunkCoordY) {
        if (this._debugAtlasLogCount >= this._debugAtlasLogBudget) return;
        this._debugAtlasLogCount++;

        const windowSize = Math.min(32, textureSize);
        const half = Math.floor(windowSize / 2);
        const offsets = [
            { x: 0, y: 0, label: 'top-left' },
            { x: Math.max(0, textureSize - windowSize), y: Math.max(0, textureSize - windowSize), label: 'bottom-right' },
            { x: Math.max(0, Math.floor(textureSize / 2) - half), y: Math.max(0, Math.floor(textureSize / 2) - half), label: 'center' }
        ];

        const stats = [];
        for (const off of offsets) {
            try {
                const hData = await this.readTextureWindow(gpuTextures.height, off.x, off.y, windowSize, windowSize);
                const tData = await this.readTextureWindowR8Unorm(gpuTextures.tile, off.x, off.y, windowSize, windowSize);

                let hMin = Infinity, hMax = -Infinity;
                for (let i = 0; i < hData.length; i += 4) {
                    const h = hData[i];
                    if (h < hMin) hMin = h;
                    if (h > hMax) hMax = h;
                }

                let tileMin = 255, tileMax = 0;
                let waterCount = 0, landCount = 0;
                for (let i = 0; i < tData.length; i += 1) {
                    const v = tData[i];
                    tileMin = Math.min(tileMin, v);
                    tileMax = Math.max(tileMax, v);
                    if (v === 2 || v === 1) waterCount++;
                    else landCount++;
                }

                stats.push({
                    label: off.label,
                    hMin, hMax,
                    tileMin, tileMax,
                    waterCount, landCount
                });
            } catch (err) {
                Logger.warn(`[TerrainDebug] Failed to sample atlas ${atlasKey.toString()} window ${off.label}: ${err}`);
            }
        }

        const uniformSnapshot = this._getTerrainShaderUniforms();
        Logger.info(`[TerrainDebug] Atlas ${atlasKey.toString()} texSize=${textureSize} chunksPerFace=${chunkGridSize} chunkCoord=(${chunkCoordX},${chunkCoordY}) ` +
            `biomeScale=${this.macroConfig.biomeScale} regionScale=${this.macroConfig.regionScale} detailScale=${this.detailScale} ` +
            `ridgeScale=${this.ridgeScale} plateauScale=${this.plateauScale} valleyScale=${this.valleyScale} worldScale=${this.worldScale} ` +
            `uniforms.continents=${uniformSnapshot.continentParams?.join(',')} smallPlanet=${this._useSmallPlanetMode}`);
        stats.forEach(s => {
            Logger.info(`[TerrainDebug]   window=${s.label} height[min,max]=[${s.hMin.toFixed(4)}, ${s.hMax.toFixed(4)}] ` +
                `tile[min,max]=[${s.tileMin}, ${s.tileMax}] water=${s.waterCount} land=${s.landCount}`);
        });
    }

    wrapGPUTexture(gpuTex, w, h, formatOverride = 'rgba32float', useNearest = false) {
        const fmt = this._mapTextureFormat(formatOverride);
        const filterable = gpuFormatIsFilterable(formatOverride);
        // Caller's useNearest intent wins, but we also demote to nearest
        // if the format isn't hardware-filterable.
        const effectiveNearest = useNearest || !filterable;
        const filter = effectiveNearest ? TextureFilter.NEAREST : TextureFilter.LINEAR;
        const t = new Texture({
            width: w, height: h,
            format: fmt,
            minFilter: filter,
            magFilter: filter
        });
        t._gpuTexture = { texture: gpuTex, view: gpuTex.createView(), format: formatOverride };
        t._needsUpload = false;
        t._isGPUOnly = true;
        t._gpuFormat = formatOverride;
        t._isFilterable = filterable;
        return t;
    }

    _getTerrainPipelineForFormat(format) {
        const fmt = format || 'rgba32float';
        const cached = this._terrainPipelineCache?.get(fmt);
        if (cached) return cached;

        const shaderCode = createAdvancedTerrainComputeShader({
            baseGenerator: this.baseGenerator,
            outputFormat: fmt,
            maxBiomes: this.maxGpuBiomes,
            terrainShaderBundle: this.terrainShaderBundle,
            tileCategories: this.tileCategories,
            tileTypes: this.tileTypes,
        });
        const shaderModule = this.device.createShaderModule({
            label: `Terrain Compute (${fmt})`,
            code: shaderCode
        });

        const bindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                {
                    binding: 1,
                    visibility: GPUShaderStage.COMPUTE,
                    storageTexture: { access: 'write-only', format: fmt, viewDimension: '2d' }
                }
            ]
        });

        const pipeline = this.device.createComputePipeline({
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout, this.biomeBindGroupLayout] }),
            compute: { module: shaderModule, entryPoint: 'main' }
        });

        if (!this._terrainPipelineCache) {
            this._terrainPipelineCache = new Map();
        }
        const record = { pipeline, bindGroupLayout };
        this._terrainPipelineCache.set(fmt, record);
        return record;
    }

    _mapTextureFormat(formatOverride) {
        return gpuFormatToWrapperFormat(formatOverride);
    }

    _setTerrainBiomeBindGroup(pass) {
        if (pass && this.biomeBindGroup) {
            pass.setBindGroup(1, this.biomeBindGroup);
        }
    }

    _refreshPackedBiomeUniforms() {
        this._packedBiomeUniforms = packBiomeUniformData(
            this.planetConfig?.worldAuthoring,
            this.seed,
            {
                maxBiomes: this.maxGpuBiomes,
            }
        );

        const packed = this._packedBiomeUniforms;
        if (packed.biomeCount > 0 || packed.truncatedBiomeCount > 0) {
            Logger.info(
                `[BiomeRuntime] Packed ${packed.biomeCount}/${this.maxGpuBiomes} biome defs ` +
                `for terrain compute upload`
            );
        }
        if (packed.biomeCount > 0) {
            const activeNoiseModes = Array.from(new Set(
                (this.planetConfig?.worldAuthoring?.biomes ?? [])
                    .map((biome) => biome?.regionalVariation?.noiseType || 'simplex')
            ));
            Logger.info(
                '[BiomeRuntime] Terrain compute is using authored biome selection ' +
                `with tile-catalog fallback tile ${packed.fallbackTileId}`
            );
            Logger.info(
                `[BiomeRuntime] Authored biome stochasticity is sampling metric space ` +
                `(noiseReferenceRadiusM=${this.noiseReferenceRadiusM})`
            );
            Logger.info(
                `[BiomeRuntime] Authored biome regional noise modes: ${activeNoiseModes.join(', ')}`
            );
            if (packed.outOfTextureRangePackedTileCount > 0) {
                Logger.warn(
                    `[BiomeRuntime] Packed ${packed.outOfTextureRangePackedTileCount} biome tile ` +
                    `ref(s) above the current texture lookup max ` +
                    `${packed.textureLookupMaxTileId}; affected tile IDs may not render correctly`
                );
            }
            if (packed.treeWeightedBiomeCount > 0) {
                Logger.info(
                    `[BiomeRuntime] Authored tree eligibility weights active for ` +
                    `${packed.treeWeightedBiomeCount}/${packed.biomeCount} biomes`
                );
            }
        }
        if (packed.truncatedBiomeCount > 0) {
            Logger.warn(
                `[BiomeRuntime] Truncated ${packed.truncatedBiomeCount} biome defs ` +
                `to fit MAX_BIOMES=${this.maxGpuBiomes}`
            );
        }

        this._uploadPackedBiomeUniforms();
    }

    _uploadPackedBiomeUniforms() {
        if (!this.biomeUniformBuffer || !this._packedBiomeUniforms?.data) return;
        this.device.queue.writeBuffer(this.biomeUniformBuffer, 0, this._packedBiomeUniforms.data);
    }

}

function requireObject(value, name) {
    if (!value || typeof value !== 'object') {
        throw new Error(`WebGPUTerrainGenerator missing required object: ${name}`);
    }
    return value;
}

function tileCategoryIndex(tileId, tileCategories) {
    for (let i = 0; i < tileCategories.length; i++) {
        const category = tileCategories[i];
        for (const [lo, hi] of category.ranges) {
            if (tileId >= lo && tileId <= hi) {
                return i;
            }
        }
    }
    return -1;
}

function summarizeTileCategoryHistogram(tileBytes, tileCategories) {
    const counts = new Array(tileCategories.length).fill(0);
    let unknown = 0;
    for (let i = 0; i < tileBytes.length; i++) {
        const idx = tileCategoryIndex(tileBytes[i], tileCategories);
        if (idx >= 0) counts[idx]++;
        else unknown++;
    }
    const total = Math.max(tileBytes.length, 1);
    const summary = [];
    for (let i = 0; i < counts.length; i++) {
        if (counts[i] <= 0) continue;
        summary.push({
            name: tileCategories[i].name,
            count: counts[i],
            pct: (counts[i] * 100) / total
        });
    }
    if (unknown > 0) {
        summary.push({ name: 'UNKNOWN', count: unknown, pct: (unknown * 100) / total });
    }
    summary.sort((a, b) => b.count - a.count);
    return summary;
}

function formatCategorySummary(summary, limit = 6) {
    if (!Array.isArray(summary) || summary.length === 0) {
        return 'none';
    }
    return summary
        .slice(0, limit)
        .map((entry) => `${entry.name}:${entry.pct.toFixed(1)}%`)
        .join(', ');
}

function summarizeSplatData(splatBytes, size) {
    let boundaryCount = 0;
    let weightMin = Infinity;
    let weightMax = -Infinity;
    let weightSum = 0;
    const pairCounts = new Map();

    for (let i = 0; i < splatBytes.length; i += 4) {
        const a = splatBytes[i];
        const b = splatBytes[i + 1];
        const weight = splatBytes[i + 2] / 255;
        const boundary = splatBytes[i + 3] > 127;
        if (boundary) boundaryCount++;
        weightMin = Math.min(weightMin, weight);
        weightMax = Math.max(weightMax, weight);
        weightSum += weight;
        const key = `${a}/${b}`;
        pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
    }

    let stable4Count = 0;
    let stable4Total = 0;
    if (size > 1) {
        for (let y = 0; y < size - 1; y++) {
            for (let x = 0; x < size - 1; x++) {
                const idx00 = (y * size + x) * 4;
                const idx10 = (y * size + x + 1) * 4;
                const idx01 = ((y + 1) * size + x) * 4;
                const idx11 = ((y + 1) * size + x + 1) * 4;
                const a0 = splatBytes[idx00];
                const b0 = splatBytes[idx00 + 1];
                const stable =
                    splatBytes[idx10] === a0 && splatBytes[idx10 + 1] === b0 &&
                    splatBytes[idx01] === a0 && splatBytes[idx01 + 1] === b0 &&
                    splatBytes[idx11] === a0 && splatBytes[idx11 + 1] === b0;
                stable4Total++;
                if (stable) stable4Count++;
            }
        }
    }

    const totalPixels = Math.max(1, splatBytes.length / 4);
    const topPairs = [...pairCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([pair, count]) => ({
            pair,
            pct: (count * 100) / totalPixels
        }));

    return {
        topPairs,
        boundaryPct: (boundaryCount * 100) / totalPixels,
        stable4Pct: stable4Total > 0 ? (stable4Count * 100) / stable4Total : 0,
        weightMin: Number.isFinite(weightMin) ? weightMin : 0,
        weightMax: Number.isFinite(weightMax) ? weightMax : 0,
        weightMean: weightSum / totalPixels
    };
}

function formatPairSummary(pairs) {
    if (!Array.isArray(pairs) || pairs.length === 0) {
        return 'none';
    }
    return pairs
        .map((entry) => `${entry.pair}:${entry.pct.toFixed(1)}%`)
        .join(', ');
}

function summarizeRGBA8Pixels(rgbaBytes) {
    const totalPixels = Math.max(1, rgbaBytes.length / 4);
    let zeroPixels = 0;
    const pixelCounts = new Map();

    for (let i = 0; i < rgbaBytes.length; i += 4) {
        const r = rgbaBytes[i];
        const g = rgbaBytes[i + 1];
        const b = rgbaBytes[i + 2];
        const a = rgbaBytes[i + 3];
        if (r === 0 && g === 0 && b === 0 && a === 0) {
            zeroPixels++;
        }
        const key = `${r}/${g}/${b}/${a}`;
        pixelCounts.set(key, (pixelCounts.get(key) || 0) + 1);
    }

    const topPixels = [...pixelCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([pixel, count]) => ({
            pixel,
            pct: (count * 100) / totalPixels
        }));

    return {
        totalPixels,
        zeroPixels,
        topPixels
    };
}

function formatRGBA8PixelSummary(summary) {
    if (!summary) {
        return 'none';
    }
    const topPixels = Array.isArray(summary.topPixels) && summary.topPixels.length > 0
        ? summary.topPixels
            .map((entry) => `${entry.pixel}:${entry.pct.toFixed(1)}%`)
            .join(', ')
        : 'none';
    return `zero=${summary.zeroPixels}/${summary.totalPixels} top=${topPixels}`;
}

function emulateSplatOutputFromPaddedTile(paddedTileRaw, paddedSize, innerSize, padding, kernelSize, tileCategories) {
    const output = new Uint8Array(innerSize * innerSize * 4);
    const kernelRadius = Math.max(0.5, 0.5 * Math.max(kernelSize, 1));
    const scoreCount = tileCategories.length;

    for (let y = 0; y < innerSize; y++) {
        for (let x = 0; x < innerSize; x++) {
            const sourcePosX = padding + ((x + 0.5) * innerSize) / Math.max(innerSize, 1);
            const sourcePosY = padding + ((y + 0.5) * innerSize) / Math.max(innerSize, 1);
            const minX = Math.max(0, Math.floor(sourcePosX - kernelRadius));
            const maxX = Math.min(paddedSize - 1, Math.ceil(sourcePosX + kernelRadius) - 1);
            const minY = Math.max(0, Math.floor(sourcePosY - kernelRadius));
            const maxY = Math.min(paddedSize - 1, Math.ceil(sourcePosY + kernelRadius) - 1);
            const centerX = clampInt(Math.floor(sourcePosX), 0, paddedSize - 1);
            const centerY = clampInt(Math.floor(sourcePosY), 0, paddedSize - 1);
            const centerTileId = paddedTileRaw[(centerY * paddedSize + centerX) * 4];

            const categoryScores = new Array(scoreCount).fill(0);
            for (let sy = minY; sy <= maxY; sy++) {
                for (let sx = minX; sx <= maxX; sx++) {
                    const weight = radialKernelWeightJS(
                        sourcePosX,
                        sourcePosY,
                        sx + 0.5,
                        sy + 0.5,
                        kernelRadius
                    );
                    if (weight <= 0) continue;
                    const tileId = paddedTileRaw[(sy * paddedSize + sx) * 4];
                    const categoryId = tileCategoryIndex(tileId, tileCategories);
                    if (categoryId < 0) continue;
                    categoryScores[categoryId] += weight;
                }
            }

            let top0Category = -1;
            let top1Category = -1;
            let top0Score = 0;
            let top1Score = 0;
            for (let categoryId = 0; categoryId < categoryScores.length; categoryId++) {
                const score = categoryScores[categoryId];
                if (score <= 0) continue;
                if (
                    score > top0Score ||
                    (score === top0Score && (top0Category < 0 || categoryId < top0Category))
                ) {
                    top1Category = top0Category;
                    top1Score = top0Score;
                    top0Category = categoryId;
                    top0Score = score;
                } else if (
                    score > top1Score ||
                    (score === top1Score && (top1Category < 0 || categoryId < top1Category))
                ) {
                    top1Category = categoryId;
                    top1Score = score;
                }
            }

            const outIdx = (y * innerSize + x) * 4;
            if (top0Category < 0 || top0Score <= 1e-5) {
                output[outIdx] = 0;
                output[outIdx + 1] = 0;
                output[outIdx + 2] = 255;
                output[outIdx + 3] = 0;
                continue;
            }

            const top0Representative = categoryRepresentativeTileIdJS(top0Category, tileCategories);
            const top1Representative = categoryRepresentativeTileIdJS(top1Category, tileCategories);
            const centerCategory = tileCategoryIndex(centerTileId, tileCategories);
            const interiorTileId =
                centerCategory >= 0 && centerCategory === top0Category
                    ? centerTileId
                    : top0Representative;

            if (top1Category < 0 || top1Score <= 1e-5) {
                output[outIdx] = interiorTileId;
                output[outIdx + 1] = interiorTileId;
                output[outIdx + 2] = 255;
                output[outIdx + 3] = 0;
                continue;
            }

            const topPairSum = top0Score + top1Score;
            if (topPairSum <= 1e-5) {
                output[outIdx] = interiorTileId;
                output[outIdx + 1] = interiorTileId;
                output[outIdx + 2] = 255;
                output[outIdx + 3] = 0;
                continue;
            }

            let biomeA = top0Representative;
            let biomeB = top1Representative;
            let weightOfBiomeA = top0Score / topPairSum;
            if (top1Representative < top0Representative) {
                biomeA = top1Representative;
                biomeB = top0Representative;
                weightOfBiomeA = top1Score / topPairSum;
            }

            output[outIdx] = biomeA;
            output[outIdx + 1] = biomeB;
            output[outIdx + 2] = clampByte(Math.round(clamp01(weightOfBiomeA) * 255));
            output[outIdx + 3] = 255;
        }
    }

    return output;
}

function compareSplatOutputs(actual, expected, innerSize, sentinelPattern = null) {
    let mismatchCount = 0;
    let sentinelCount = 0;
    let zeroCount = 0;
    let fallbackCount = 0;
    const samples = [];
    const totalPixels = Math.max(1, actual.length / 4);

    for (let i = 0; i < actual.length; i += 4) {
        const pixelIndex = i / 4;
        const x = pixelIndex % innerSize;
        const y = Math.floor(pixelIndex / innerSize);
        const isSentinel =
            Array.isArray(sentinelPattern) &&
            actual[i] === sentinelPattern[0] &&
            actual[i + 1] === sentinelPattern[1] &&
            actual[i + 2] === sentinelPattern[2] &&
            actual[i + 3] === sentinelPattern[3];
        if (isSentinel) sentinelCount++;
        if (
            actual[i] === 0 &&
            actual[i + 1] === 0 &&
            actual[i + 2] === 0 &&
            actual[i + 3] === 0
        ) {
            zeroCount++;
        }
        if (
            actual[i] === 0 &&
            actual[i + 1] === 0 &&
            actual[i + 2] === 255 &&
            actual[i + 3] === 0
        ) {
            fallbackCount++;
        }

        const mismatch =
            actual[i] !== expected[i] ||
            actual[i + 1] !== expected[i + 1] ||
            actual[i + 2] !== expected[i + 2] ||
            actual[i + 3] !== expected[i + 3];
        if (mismatch) {
            mismatchCount++;
            if (samples.length < 6) {
                samples.push(
                    `(${x},${y}) act=${actual[i]}/${actual[i + 1]}/${actual[i + 2]}/${actual[i + 3]} ` +
                    `exp=${expected[i]}/${expected[i + 1]}/${expected[i + 2]}/${expected[i + 3]}`
                );
            }
        }
    }

    return {
        totalPixels,
        mismatchCount,
        sentinelCount,
        zeroCount,
        fallbackCount,
        samples
    };
}

function radialKernelWeightJS(cx, cy, sx, sy, radius) {
    if (!(radius > 0)) return 0;
    const dx = cx - sx;
    const dy = cy - sy;
    const distanceToSample = Math.sqrt(dx * dx + dy * dy);
    if (distanceToSample >= radius) return 0;
    const normalized = distanceToSample / radius;
    const falloff = 1 - normalized * normalized;
    return falloff * falloff;
}

function categoryRepresentativeTileIdJS(categoryId, tileCategories) {
    if (!(categoryId >= 0 && categoryId < tileCategories.length)) {
        return 255;
    }
    return tileCategories[categoryId]?.ranges?.[0]?.[0] ?? 255;
}

function requireNumber(value, name) {
    if (!Number.isFinite(value)) {
        throw new Error(`WebGPUTerrainGenerator missing required number: ${name}`);
    }
    return value;
}

function requireInt(value, name, min = null) {
    if (!Number.isFinite(value)) {
        throw new Error(`WebGPUTerrainGenerator missing required integer: ${name}`);
    }
    const n = Math.floor(value);
    if (min !== null && n < min) {
        throw new Error(`WebGPUTerrainGenerator ${name} must be >= ${min}`);
    }
    return n;
}
