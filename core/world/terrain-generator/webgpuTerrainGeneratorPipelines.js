import { gpuFormatBytesPerTexel, gpuFormatSampleType, gpuFormatToWrapperFormat } from '../../renderer/resources/texture.js';
import { Logger } from '../../../shared/Logger.js';
import { getPackedBiomeUniformByteSize, packBiomeUniformData } from '../biomeRuntime.js';
import { createAdvancedTerrainComputeShader } from '../shaders/webgpu/advancedTerrainCompute.wgsl.js';
import { createResolvedTerrainColorComputeShader } from '../shaders/webgpu/resolvedTerrainColorCompute.wgsl.js';
import { createSplatComputeShader } from '../shaders/webgpu/splatCompute.wgsl.js';
import { createSplatPaletteComputeShader } from '../shaders/webgpu/splatPaletteCompute.wgsl.js';
import { createSplatValidityComputeShader } from '../shaders/webgpu/splatValidityCompute.wgsl.js';

const SPLAT_STEP_PREFIX = '[TerrainStep] [SplatStep]';

export function installWebGPUTerrainGeneratorPipelineMethods(WebGPUTerrainGenerator) {
    Object.defineProperties(
        WebGPUTerrainGenerator.prototype,
        Object.getOwnPropertyDescriptors({
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
                                     viewDimension: '2d' } },
                        { binding: 6, visibility: GPUShaderStage.COMPUTE,
                          texture: { sampleType: gpuFormatSampleType('rgba8unorm'),
                                     viewDimension: '2d' } },
                        { binding: 7, visibility: GPUShaderStage.COMPUTE,
                          texture: { sampleType: gpuFormatSampleType('rgba8unorm'),
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
                                            viewDimension: '2d' } },
                        { binding: 3, visibility: GPUShaderStage.COMPUTE,
                          texture: { sampleType: gpuFormatSampleType('rgba8unorm'),
                                     viewDimension: '2d' } },
                        { binding: 4, visibility: GPUShaderStage.COMPUTE,
                          texture: { sampleType: gpuFormatSampleType('rgba8unorm'),
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
                for (let i = 0; i < 8; i++) {
                    this._batchTerrainUniforms.push(this.device.createBuffer({
                        label: `TerrainBatchUniform-${i}`,
                        size: 512,
                        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
                    }));
                }
                this._terrainUniformScratch = new ArrayBuffer(512);
            },

        _getHeightInputPipelineCacheKey(format, heightFormat = 'r32float') {
                return `${format || 'rgba32float'}|h:${gpuFormatSampleType(heightFormat || 'r32float')}`;
            },

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
            },

        _getMicroPipelineCacheKey(format, heightFormat = 'r32float', tileFormat = 'r32float') {
                return `${format || 'rgba32float'}|h:${gpuFormatSampleType(heightFormat || 'r32float')}|t:${gpuFormatSampleType(tileFormat || 'r32float')}`;
            },

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
            },

        _getSplatPipelineCacheKey(heightFormat = 'r32float', tileFormat = 'r32float') {
                return `h:${gpuFormatSampleType(heightFormat || 'r32float')}|t:${gpuFormatSampleType(tileFormat || 'r32float')}`;
            },

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
                        },
                        {
                            binding: 6,
                            visibility: GPUShaderStage.COMPUTE,
                            texture: {
                                sampleType: gpuFormatSampleType('rgba8unorm'),
                                viewDimension: '2d'
                            }
                        },
                        {
                            binding: 7,
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
            },

        _getSplatPalettePipelineCacheKey(tileFormat = 'r32float') {
                return `t:${gpuFormatSampleType(tileFormat || 'r32float')}`;
            },

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
                        },
                        {
                            binding: 3,
                            visibility: GPUShaderStage.COMPUTE,
                            texture: {
                                sampleType: gpuFormatSampleType('rgba8unorm'),
                                viewDimension: '2d'
                            }
                        },
                        {
                            binding: 4,
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
                    compute: { module: this.splatPaletteShaderModule, entryPoint: 'main' }
                });

                if (!this._splatPalettePipelineCache) {
                    this._splatPalettePipelineCache = new Map();
                }
                const record = { pipeline, bindGroupLayout };
                this._splatPalettePipelineCache.set(cacheKey, record);
                return record;
            },

        _getSplatValidityPipelineCacheKey(indexFormat = 'rgba8unorm', maskFormat = 'rgba8unorm') {
                return `i:${gpuFormatSampleType(indexFormat || 'rgba8unorm')}|m:${maskFormat || 'rgba8unorm'}`;
            },

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
            },

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
            },

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
            },

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
            },

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
            },

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
            },

        getStorageTextureWriteFormat(format = 'rgba32float') {
                if (format === 'r8unorm') return 'rgba8unorm';
                return format;
            },

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
            },

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
            },

        createSampledGPUTexture(width, height, format = 'rgba32float') {
                return this.createGPUTexture(
                    width,
                    height,
                    format,
                    GPUTextureUsage.TEXTURE_BINDING |
                    GPUTextureUsage.COPY_SRC |
                    GPUTextureUsage.COPY_DST
                );
            },

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
            },

        _mapTextureFormat(formatOverride) {
                return gpuFormatToWrapperFormat(formatOverride);
            },

        _setTerrainBiomeBindGroup(pass) {
                if (pass && this.biomeBindGroup) {
                    pass.setBindGroup(1, this.biomeBindGroup);
                }
            },

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
            },

        _uploadPackedBiomeUniforms() {
                if (!this.biomeUniformBuffer || !this._packedBiomeUniforms?.data) return;
                this.device.queue.writeBuffer(this.biomeUniformBuffer, 0, this._packedBiomeUniforms.data);
            }
        })
    );
}
