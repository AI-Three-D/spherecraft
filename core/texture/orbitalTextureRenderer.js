import { Texture, TextureFormat, TextureFilter } from '../renderer/resources/texture.js';
import { TEXTURE_LOOKUP_TILE_COUNT } from './tileTextureLimits.js';

/**
 * Renders final orbital planet textures by compositing:
 * - Tile data textures (from world generator)
 * - Tile atlas textures (from TextureAtlasManager)
 * - Height data for normal map generation
 */
export class OrbitalTextureRenderer {
    constructor(backend, textureAtlasManager) {
        this.backend = backend;
        this.textureAtlasManager = textureAtlasManager;

        this.device = backend?.device || null;

        // Rendered textures (color + normal) for each face
        this.faceTextures = new Map();

        // Resolution for final orbital textures
        this.outputResolution = 1024;

        // WebGPU resources
        this.compositePipeline = null;
        this.compositeBindGroupLayout = null;
        this.compositeUniformBuffer = null;

        this.normalPipeline = null;
        this.normalBindGroupLayout = null;
        this.normalUniformBuffer = null;

        this.avgColorPipeline = null;
        this.avgColorBindGroupLayout = null;
        this.avgColorUniformBuffer = null;

        // Samplers
        this.atlasSampler = null;
        this.dataSampler = null;

        // Pre-computed average colors texture
        this.tileAverageColorTexture = null;

        this.initialized = false;
    }

    async initialize() {
        if (this.initialized) return;

        console.log('[OrbitalTextureRenderer] Initializing...');

        if (!this.device) {
            console.warn('[OrbitalTextureRenderer] No WebGPU device available');
            return;
        }

        // Create samplers
        this.atlasSampler = this.device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            mipmapFilter: 'linear',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
        });

        this.dataSampler = this.device.createSampler({
            magFilter: 'nearest',
            minFilter: 'nearest',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
        });

        // Create all pipelines
        await this._createTileAverageColorPipeline();
        await this._createCompositePipeline();
        await this._createNormalPipeline();

        // Pre-compute tile average colors after pipelines are ready
        await this.computeTileAverageColors();

        this.initialized = true;
        console.log('[OrbitalTextureRenderer] Initialized');
    }

    // ========================================================================
    // Tile Average Color Pipeline
    // ========================================================================

    async _createTileAverageColorPipeline() {
        const shaderCode = `
            struct Uniforms {
                atlasSize: vec2<f32>,
                outputWidth: f32,
                outputHeight: f32,
                sampleGridSize: f32,
                _pad1: f32,
                _pad2: f32,
                _pad3: f32,
            }

            @group(0) @binding(0) var<uniform> uniforms: Uniforms;
            @group(0) @binding(1) var atlasTexture: texture_2d_array<f32>;
            @group(0) @binding(2) var atlasSampler: sampler;
            @group(0) @binding(3) var tileTypeLookup: texture_2d<f32>;
            @group(0) @binding(4) var outputTexture: texture_storage_2d<rgba8unorm, write>;

            fn getTileBaseColor(tileType: u32) -> vec3<f32> {
                if (tileType == 0u) { return vec3<f32>(0.16, 0.31, 0.63); } // WATER
                if (tileType >= 10u && tileType <= 29u) { return vec3<f32>(0.24, 0.55, 0.20); } // GRASS
                if (tileType >= 30u && tileType <= 41u) { return vec3<f32>(0.76, 0.68, 0.45); } // SAND
                if (tileType >= 42u && tileType <= 53u) { return vec3<f32>(0.35, 0.31, 0.27); } // ROCK
                if (tileType >= 54u && tileType <= 65u) { return vec3<f32>(0.45, 0.50, 0.42); } // TUNDRA
                if (tileType >= 66u && tileType <= 81u) { return vec3<f32>(0.20, 0.35, 0.18); } // FOREST FLOOR
                if (tileType >= 142u && tileType <= 149u) { return vec3<f32>(0.18, 0.38, 0.20); } // RAINFOREST / JUNGLE
                if (tileType >= 142u && tileType <= 149u) { return vec3<f32>(0.18, 0.38, 0.20); } // RAINFOREST / JUNGLE
                if (tileType >= 82u && tileType <= 93u) { return vec3<f32>(0.18, 0.30, 0.18); } // SWAMP
                if (tileType >= 94u && tileType <= 105u) { return vec3<f32>(0.46, 0.36, 0.24); } // DIRT
                if (tileType >= 106u && tileType <= 117u) { return vec3<f32>(0.32, 0.25, 0.18); } // MUD
                if (tileType >= 118u && tileType <= 129u) { return vec3<f32>(0.20, 0.18, 0.18); } // VOLCANIC
                if (tileType >= 130u && tileType <= 141u) { return vec3<f32>(0.90, 0.92, 0.96); } // SNOW
                if (tileType >= 150u && tileType <= 165u) { return vec3<f32>(0.78, 0.68, 0.45); } // DESERT
                return vec3<f32>(0.5, 0.5, 0.5);
            }

            @compute @workgroup_size(8, 8)
            fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
                let outputWidth = u32(uniforms.outputWidth);
                let outputHeight = u32(uniforms.outputHeight);

                if (globalId.x >= outputWidth || globalId.y >= outputHeight) {
                    return;
                }

                let season = globalId.x;
                let tileType = globalId.y;

                let lookupSize = textureDimensions(tileTypeLookup);
                let maxVariants = lookupSize.x / 4u;
                let variant = 0u;

                let lookupX = i32(season * maxVariants + variant);
                let lookupY = i32(tileType);

                if (lookupX >= i32(lookupSize.x) || lookupY >= i32(lookupSize.y)) {
                    textureStore(outputTexture, vec2<i32>(globalId.xy), vec4<f32>(getTileBaseColor(tileType), 1.0));
                    return;
                }

                let lookupData = textureLoad(tileTypeLookup, vec2<i32>(lookupX, lookupY), 0);
                let atlasLayer = i32(round(lookupData.x));

                let sampleGrid = i32(uniforms.sampleGridSize);
                var colorSum = vec3<f32>(0.0);
                var sampleCount = 0.0;

                for (var sy = 0; sy < sampleGrid; sy++) {
                    for (var sx = 0; sx < sampleGrid; sx++) {
                        let localU = (f32(sx) + 0.5) / f32(sampleGrid);
                        let localV = (f32(sy) + 0.5) / f32(sampleGrid);

                        let sampleUv = vec2<f32>(localU, localV);
                        let sampleColor = textureSampleLevel(atlasTexture, atlasSampler, sampleUv, atlasLayer, 0.0);
                        colorSum += sampleColor.rgb;
                        sampleCount += 1.0;
                    }
                }

                var avgColor = colorSum / max(sampleCount, 1.0);
                avgColor = clamp(avgColor, vec3<f32>(0.0), vec3<f32>(1.0));

                textureStore(outputTexture, vec2<i32>(globalId.xy), vec4<f32>(avgColor, 1.0));
            }
        `;

        const shaderModule = this.device.createShaderModule({
            label: 'Tile Average Color Compute Shader',
            code: shaderCode
        });

        this.avgColorUniformBuffer = this.device.createBuffer({
            size: 48,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });

        this.avgColorBindGroupLayout = this.device.createBindGroupLayout({
            label: 'Tile Average Color Bind Group Layout',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float', viewDimension: '2d-array' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
                { binding: 4, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
            ]
        });

        this.avgColorPipeline = this.device.createComputePipeline({
            label: 'Tile Average Color Pipeline',
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [this.avgColorBindGroupLayout]
            }),
            compute: {
                module: shaderModule,
                entryPoint: 'main'
            }
        });
    }

    async computeTileAverageColors() {
        if (!this.textureAtlasManager) {
            console.warn('[OrbitalTextureRenderer] No texture atlas manager available');
            return null;
        }

        const atlasTexture = this.textureAtlasManager.getAtlasTexture('micro');
        if (!atlasTexture?._gpuTexture?.texture) {
            console.warn('[OrbitalTextureRenderer] Atlas texture not ready');
            return null;
        }

        const maxTileTypes = TEXTURE_LOOKUP_TILE_COUNT;
        const numSeasons = 4;

        return await this._computeTileAverageColorsGPU(atlasTexture, maxTileTypes, numSeasons);
    }

    async _computeTileAverageColorsGPU(atlasTexture, maxTileTypes, numSeasons) {
        const lookupTexture = this.textureAtlasManager?.lookupTables?.tileTypeLookup;

        if (!atlasTexture?._gpuTexture?.texture || !lookupTexture?._gpuTexture?.texture || !this.avgColorPipeline) {
            return this._createFallbackAverageColors(maxTileTypes, numSeasons);
        }

        const outputWidth = numSeasons;
        const outputHeight = maxTileTypes;
        const sampleGridSize = 8;

        const outputGPUTexture = this.device.createTexture({
            size: [outputWidth, outputHeight],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC
        });

        const uniformData = new Float32Array([
            atlasTexture.width || 2048,
            atlasTexture.height || 2048,
            outputWidth,
            outputHeight,
            sampleGridSize,
            0, 0, 0,
            0, 0, 0, 0
        ]);
        this.device.queue.writeBuffer(this.avgColorUniformBuffer, 0, uniformData);

        const bindGroup = this.device.createBindGroup({
            layout: this.avgColorBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.avgColorUniformBuffer } },
                { binding: 1, resource: atlasTexture._gpuTexture.texture.createView({ dimension: '2d-array' }) },
                { binding: 2, resource: this.atlasSampler },
                { binding: 3, resource: lookupTexture._gpuTexture.texture.createView() },
                { binding: 4, resource: outputGPUTexture.createView() },
            ]
        });

        const commandEncoder = this.device.createCommandEncoder();
        const passEncoder = commandEncoder.beginComputePass();
        passEncoder.setPipeline(this.avgColorPipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.dispatchWorkgroups(Math.ceil(outputWidth / 8), Math.ceil(outputHeight / 8));
        passEncoder.end();
        this.device.queue.submit([commandEncoder.finish()]);

        const texture = new Texture({
            width: outputWidth,
            height: outputHeight,
            format: TextureFormat.RGBA8,
            minFilter: TextureFilter.NEAREST,
            magFilter: TextureFilter.NEAREST,
        });
        texture._gpuTexture = {
            texture: outputGPUTexture,
            view: outputGPUTexture.createView(),
            format: 'rgba8unorm'
        };
        texture._needsUpload = false;
        texture._isGPUOnly = true;

        this.tileAverageColorTexture = texture;
        console.log(`[OrbitalTextureRenderer] Computed average colors: ${outputWidth}x${outputHeight}`);

        return texture;
    }

    _createFallbackAverageColors(maxTileTypes, numSeasons) {
        const width = numSeasons;
        const height = maxTileTypes;
        const data = new Uint8Array(width * height * 4);

        const tileColors = {
            0: [41, 79, 161],
            10: [61, 140, 51],
            40: [89, 79, 69],
            41: [89, 79, 69],
            42: [89, 79, 69],
        };

        for (let tileType = 0; tileType < maxTileTypes; tileType++) {
            const color = tileColors[tileType] || [128, 128, 128];
            for (let season = 0; season < numSeasons; season++) {
                const idx = (tileType * width + season) * 4;
                data[idx] = color[0];
                data[idx + 1] = color[1];
                data[idx + 2] = color[2];
                data[idx + 3] = 255;
            }
        }

        const texture = new Texture({
            width, height,
            format: TextureFormat.RGBA8,
            minFilter: TextureFilter.NEAREST,
            magFilter: TextureFilter.NEAREST,
            data: data
        });

        this.backend.createTexture(texture);
        this.tileAverageColorTexture = texture;
        return texture;
    }

    // ========================================================================
    // Color Composite Pipeline
    // ========================================================================

    async _createCompositePipeline() {
        const shaderCode = this._getCompositeShaderCode();

        const shaderModule = this.device.createShaderModule({
            label: 'Orbital Composite Shader',
            code: shaderCode
        });

        this.compositeUniformBuffer = this.device.createBuffer({
            size: 64,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });

        this.compositeBindGroupLayout = this.device.createBindGroupLayout({
            label: 'Orbital Composite Bind Group Layout',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
            ]
        });

        this.compositePipeline = this.device.createComputePipeline({
            label: 'Orbital Composite Pipeline',
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [this.compositeBindGroupLayout]
            }),
            compute: {
                module: shaderModule,
                entryPoint: 'compositeMain'
            }
        });
    }

    _getCompositeShaderCode() {
        return `
            struct CompositeUniforms {
                outputSize: vec2<f32>,
                face: f32,
                currentSeason: f32,
                debugMode: f32,
                _pad1: f32,
                _pad2: f32,
                _pad3: f32,
            }

            @group(0) @binding(0) var<uniform> uniforms: CompositeUniforms;
            @group(0) @binding(1) var tileDataTex: texture_2d<f32>;
            @group(0) @binding(2) var tileAverageColors: texture_2d<f32>;
            @group(0) @binding(3) var outputTexture: texture_storage_2d<rgba8unorm, write>;

            fn getTileBaseColor(tileType: u32) -> vec3<f32> {
                if (tileType == 0u) { return vec3<f32>(0.16, 0.31, 0.63); } // WATER
                if (tileType >= 10u && tileType <= 29u) { return vec3<f32>(0.24, 0.55, 0.20); } // GRASS
                if (tileType >= 30u && tileType <= 41u) { return vec3<f32>(0.76, 0.68, 0.45); } // SAND
                if (tileType >= 42u && tileType <= 53u) { return vec3<f32>(0.35, 0.31, 0.27); } // ROCK
                if (tileType >= 54u && tileType <= 65u) { return vec3<f32>(0.45, 0.50, 0.42); } // TUNDRA
                if (tileType >= 66u && tileType <= 81u) { return vec3<f32>(0.20, 0.35, 0.18); } // FOREST FLOOR
                if (tileType >= 82u && tileType <= 93u) { return vec3<f32>(0.18, 0.30, 0.18); } // SWAMP
                if (tileType >= 94u && tileType <= 105u) { return vec3<f32>(0.46, 0.36, 0.24); } // DIRT
                if (tileType >= 106u && tileType <= 117u) { return vec3<f32>(0.32, 0.25, 0.18); } // MUD
                if (tileType >= 118u && tileType <= 129u) { return vec3<f32>(0.20, 0.18, 0.18); } // VOLCANIC
                if (tileType >= 130u && tileType <= 141u) { return vec3<f32>(0.90, 0.92, 0.96); } // SNOW
                if (tileType >= 150u && tileType <= 165u) { return vec3<f32>(0.78, 0.68, 0.45); } // DESERT
                return vec3<f32>(0.5, 0.5, 0.5);
            }

            fn hash12(p: vec2<f32>) -> f32 {
                var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
                p3 = p3 + dot(p3, p3.yzx + 33.33);
                return fract((p3.x + p3.y) * p3.z);
            }

            fn getAverageColor(tileType: u32, season: u32) -> vec3<f32> {
                let avgSize = textureDimensions(tileAverageColors);
                
                if (season >= avgSize.x || tileType >= avgSize.y) {
                    return getTileBaseColor(tileType);
                }

                // Note: texture is (season, tileType) so x=season, y=tileType
                let avgColor = textureLoad(tileAverageColors, vec2<i32>(i32(season), i32(tileType)), 0);
                
                if (avgColor.a < 0.5) {
                    return getTileBaseColor(tileType);
                }
                
                return avgColor.rgb;
            }

            @compute @workgroup_size(8, 8)
            fn compositeMain(@builtin(global_invocation_id) globalId: vec3<u32>) {
                let outputSize = vec2<u32>(uniforms.outputSize);

                if (globalId.x >= outputSize.x || globalId.y >= outputSize.y) {
                    return;
                }

                let uv = vec2<f32>(f32(globalId.x) + 0.5, f32(globalId.y) + 0.5) / uniforms.outputSize;
                let dataCoord = vec2<i32>(globalId.xy);

                let tileData = textureLoad(tileDataTex, dataCoord, 0);

                var tileType: u32;
                if (tileData.r <= 1.0) {
                    tileType = u32(tileData.r * 255.0 + 0.5);
                } else {
                    tileType = u32(tileData.r + 0.5);
                }

                // Debug: show tile types
                if (uniforms.debugMode > 0.5 && uniforms.debugMode < 1.5) {
                    let debugColor = getTileBaseColor(tileType);
                    textureStore(outputTexture, vec2<i32>(globalId.xy), vec4<f32>(debugColor, 1.0));
                    return;
                }

                tileType = clamp(tileType, 0u, 255u);
                let season = u32(uniforms.currentSeason);

                var color = getAverageColor(tileType, season);

                // Subtle variation
                let variation = hash12(uv * 500.0 + vec2<f32>(f32(tileType), uniforms.face));
                color = color * (0.94 + variation * 0.12);

                color = clamp(color, vec3<f32>(0.0), vec3<f32>(1.0));

                textureStore(outputTexture, vec2<i32>(globalId.xy), vec4<f32>(color, 1.0));
            }
        `;
    }

    // ========================================================================
    // Normal Map Pipeline
    // ========================================================================

    async _createNormalPipeline() {
        const shaderCode = this._getNormalShaderCode();

        const shaderModule = this.device.createShaderModule({
            label: 'Orbital Normal Shader',
            code: shaderCode
        });

        this.normalUniformBuffer = this.device.createBuffer({
            size: 48,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });

        this.normalBindGroupLayout = this.device.createBindGroupLayout({
            label: 'Orbital Normal Bind Group Layout',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
            ]
        });

        this.normalPipeline = this.device.createComputePipeline({
            label: 'Orbital Normal Pipeline',
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [this.normalBindGroupLayout]
            }),
            compute: {
                module: shaderModule,
                entryPoint: 'normalMain'
            }
        });
    }

    _getNormalShaderCode() {
        return `
            struct NormalUniforms {
                outputSize: vec2<f32>,
                heightScale: f32,
                face: f32,
                planetRadius: f32,
                _pad1: f32,
                _pad2: f32,
                _pad3: f32,
            }

            @group(0) @binding(0) var<uniform> uniforms: NormalUniforms;
            @group(0) @binding(1) var heightDataTex: texture_2d<f32>;
            @group(0) @binding(2) var outputTexture: texture_storage_2d<rgba8unorm, write>;

            fn sampleHeight(coord: vec2<i32>) -> f32 {
                let texSize = vec2<i32>(textureDimensions(heightDataTex));
                let clampedCoord = clamp(coord, vec2<i32>(0), texSize - vec2<i32>(1));
                return textureLoad(heightDataTex, clampedCoord, 0).r;
            }

            // Convert face UV to sphere direction
            fn getSpherePoint(face: i32, u: f32, v: f32) -> vec3<f32> {
                var cubePos: vec3<f32>;
                let x = u * 2.0 - 1.0;
                let y = v * 2.0 - 1.0;

                if (face == 0) { cubePos = vec3<f32>( 1.0, y, -x); }
                else if (face == 1) { cubePos = vec3<f32>(-1.0, y,  x); }
                else if (face == 2) { cubePos = vec3<f32>( x,  1.0, -y); }
                else if (face == 3) { cubePos = vec3<f32>( x, -1.0,  y); }
                else if (face == 4) { cubePos = vec3<f32>( x,  y,  1.0); }
                else { cubePos = vec3<f32>(-x,  y, -1.0); }

                return normalize(cubePos);
            }

            @compute @workgroup_size(8, 8)
            fn normalMain(@builtin(global_invocation_id) globalId: vec3<u32>) {
                let outputSize = vec2<u32>(uniforms.outputSize);

                if (globalId.x >= outputSize.x || globalId.y >= outputSize.y) {
                    return;
                }

                let coord = vec2<i32>(globalId.xy);
                let uv = vec2<f32>(f32(globalId.x) + 0.5, f32(globalId.y) + 0.5) / uniforms.outputSize;

                // Sample heights for Sobel-like gradient
                let hL = sampleHeight(coord + vec2<i32>(-1, 0));
                let hR = sampleHeight(coord + vec2<i32>(1, 0));
                let hD = sampleHeight(coord + vec2<i32>(0, -1));
                let hU = sampleHeight(coord + vec2<i32>(0, 1));

                // Also sample diagonals for smoother results
                let hLD = sampleHeight(coord + vec2<i32>(-1, -1));
                let hRD = sampleHeight(coord + vec2<i32>(1, -1));
                let hLU = sampleHeight(coord + vec2<i32>(-1, 1));
                let hRU = sampleHeight(coord + vec2<i32>(1, 1));

                // Sobel operator for gradients
                let dX = (hR - hL) * 2.0 + (hRU - hLU) + (hRD - hLD);
                let dY = (hU - hD) * 2.0 + (hLU - hLD) + (hRU - hRD);

                // Scale gradients based on height scale and texture resolution
                let gradientScale = uniforms.heightScale * 4.0;
                let scaledDX = dX * gradientScale;
                let scaledDY = dY * gradientScale;

                // For spherical terrain, we need to transform the normal to tangent space
                let face = i32(uniforms.face);
                let sphereDir = getSpherePoint(face, uv.x, uv.y);

                // Build tangent space basis
                var up = sphereDir;
                var reference = vec3<f32>(0.0, 1.0, 0.0);
                if (abs(dot(up, reference)) > 0.99) {
                    reference = vec3<f32>(1.0, 0.0, 0.0);
                }
                let tangent = normalize(cross(up, reference));
                let bitangent = normalize(cross(up, tangent));

                // Compute normal in tangent space then transform
                let tangentNormal = normalize(vec3<f32>(-scaledDX, -scaledDY, 1.0));

                // Transform to world space (for storage, we keep it in tangent space encoded)
                // Store as tangent-space normal for the fragment shader to use
                let encoded = tangentNormal * 0.5 + 0.5;

                textureStore(outputTexture, coord, vec4<f32>(encoded, 1.0));
            }
        `;
    }

    // ========================================================================
    // Rendering Methods
    // ========================================================================

    async renderFaceTextures(face, tileDataTexture, heightDataTexture) {
        if (!this.initialized) {
            await this.initialize();
        }

        if (!tileDataTexture) {
            console.warn(`[OrbitalTextureRenderer] No tile data for face ${face}`);
            return null;
        }

        const colorTexture = await this._compositeColorTexture(face, tileDataTexture);
        const normalTexture = await this._generateNormalMap(face, heightDataTexture);

        const result = { color: colorTexture, normal: normalTexture };
        this.faceTextures.set(face, result);

        return result;
    }

    async renderAllFaces(getDataTexture) {
        if (!this.initialized) {
            await this.initialize();
        }

        console.log('[OrbitalTextureRenderer] Rendering all faces...');

        for (let face = 0; face < 6; face++) {
            const tileData = getDataTexture(face, 'tile');
            const heightData = getDataTexture(face, 'height');

            if (!tileData) {
                console.warn(`[OrbitalTextureRenderer] No tile data for face ${face}, creating placeholder`);
                await this._createPlaceholderFace(face);
                continue;
            }

            // Align output resolution with incoming data to avoid sampling mismatch
            if (tileData?.width && tileData?.height) {
                this.outputResolution = tileData.width;
            }

            await this.renderFaceTextures(face, tileData, heightData);
        }

        // Build array textures for seamless sampling on the orbital sphere
        await this._buildArrayTextures();

        console.log('[OrbitalTextureRenderer] All faces rendered');
        return this.faceTextures;
    }

    async _buildArrayTextures() {
        if (!this.device) return;
        const size = this.outputResolution;

        const colorArray = this.device.createTexture({
            size: [size, size, 6],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
        });
        const normalArray = this.device.createTexture({
            size: [size, size, 6],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
        });

        const enc = this.device.createCommandEncoder();
        for (let face = 0; face < 6; face++) {
            const faceTex = this.faceTextures.get(face);
            if (!faceTex) continue;
            const colorGPU = faceTex.color?._gpuTexture?.texture;
            const normalGPU = faceTex.normal?._gpuTexture?.texture;
            if (colorGPU) {
                enc.copyTextureToTexture(
                    { texture: colorGPU },
                    { texture: colorArray, origin: { x: 0, y: 0, z: face } },
                    [size, size, 1]
                );
            }
            if (normalGPU) {
                enc.copyTextureToTexture(
                    { texture: normalGPU },
                    { texture: normalArray, origin: { x: 0, y: 0, z: face } },
                    [size, size, 1]
                );
            }
        }
        this.device.queue.submit([enc.finish()]);

        // Wrap for renderer consumption
        const wrap = (gpuTex) => {
            const tex = new Texture({
                width: size,
                height: size,
                depth: 6,
                format: TextureFormat.RGBA8,
                minFilter: TextureFilter.LINEAR,
                magFilter: TextureFilter.LINEAR,
                generateMipmaps: false
            });
            tex._gpuTexture = {
                texture: gpuTex,
                view: gpuTex.createView({ dimension: '2d-array' }),
                format: 'rgba8unorm'
            };
            tex._needsUpload = false;
            tex._isArray = true;
            tex._isGPUOnly = true;
            return tex;
        };

        this.colorArrayTexture = wrap(colorArray);
        this.normalArrayTexture = wrap(normalArray);
    }

    getArrayTextures() {
        return { color: this.colorArrayTexture, normal: this.normalArrayTexture };
    }

    async _compositeColorTexture(face, tileDataTexture) {
        const size = this.outputResolution;

        const outputGPUTexture = this.device.createTexture({
            size: [size, size],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC
        });

        const tileDataGPU = tileDataTexture._gpuTexture?.texture;
        if (!tileDataGPU) {
            return this._createFallbackColorTexture(face, tileDataTexture);
        }

        if (!this.tileAverageColorTexture?._gpuTexture?.texture) {
            await this.computeTileAverageColors();
        }

        if (!this.tileAverageColorTexture?._gpuTexture?.texture) {
            return this._createFallbackColorTexture(face, tileDataTexture);
        }

        const currentSeason = this.textureAtlasManager?.currentSeason || 0;

        const uniformData = new Float32Array([
            size, size,
            face,
            currentSeason,
            0,  // debugMode
            0, 0, 0,
            0, 0, 0, 0,
            0, 0, 0, 0
        ]);

        this.device.queue.writeBuffer(this.compositeUniformBuffer, 0, uniformData);

        const bindGroup = this.device.createBindGroup({
            layout: this.compositeBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.compositeUniformBuffer } },
                { binding: 1, resource: tileDataGPU.createView() },
                { binding: 2, resource: this.tileAverageColorTexture._gpuTexture.texture.createView() },
                { binding: 3, resource: outputGPUTexture.createView() },
            ]
        });

        const commandEncoder = this.device.createCommandEncoder();
        const passEncoder = commandEncoder.beginComputePass();
        passEncoder.setPipeline(this.compositePipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.dispatchWorkgroups(Math.ceil(size / 8), Math.ceil(size / 8));
        passEncoder.end();
        this.device.queue.submit([commandEncoder.finish()]);

        const texture = new Texture({
            width: size,
            height: size,
            format: TextureFormat.RGBA8,
            minFilter: TextureFilter.LINEAR,
            magFilter: TextureFilter.LINEAR,
        });
        texture._gpuTexture = {
            texture: outputGPUTexture,
            view: outputGPUTexture.createView(),
            format: 'rgba8unorm'
        };
        texture._needsUpload = false;
        texture._isGPUOnly = true;

        return texture;
    }

    async _generateNormalMap(face, heightDataTexture) {
        const size = this.outputResolution;

        const outputGPUTexture = this.device.createTexture({
            size: [size, size],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC
        });

        const heightDataGPU = heightDataTexture?._gpuTexture?.texture;
        if (!heightDataGPU) {
            return this._createFlatNormalMap(size);
        }

        const uniformData = new Float32Array([
            size, size,
            0.5,   // heightScale - controls normal intensity
            face,
            50000, // planetRadius (default, could be passed in)
            0, 0, 0,
            0, 0, 0, 0
        ]);
        this.device.queue.writeBuffer(this.normalUniformBuffer, 0, uniformData);

        const bindGroup = this.device.createBindGroup({
            layout: this.normalBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.normalUniformBuffer } },
                { binding: 1, resource: heightDataGPU.createView() },
                { binding: 2, resource: outputGPUTexture.createView() },
            ]
        });

        const commandEncoder = this.device.createCommandEncoder();
        const passEncoder = commandEncoder.beginComputePass();
        passEncoder.setPipeline(this.normalPipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.dispatchWorkgroups(Math.ceil(size / 8), Math.ceil(size / 8));
        passEncoder.end();
        this.device.queue.submit([commandEncoder.finish()]);

        const texture = new Texture({
            width: size,
            height: size,
            format: TextureFormat.RGBA8,
            minFilter: TextureFilter.LINEAR,
            magFilter: TextureFilter.LINEAR,
        });
        texture._gpuTexture = {
            texture: outputGPUTexture,
            view: outputGPUTexture.createView(),
            format: 'rgba8unorm'
        };
        texture._needsUpload = false;
        texture._isGPUOnly = true;

        return texture;
    }

    // ========================================================================
    // Fallback / Placeholder Methods
    // ========================================================================

    _createFallbackColorTexture(face, tileDataTexture) {
        const size = this.outputResolution;
        const data = new Uint8Array(size * size * 4);

        const tileColors = {
            0: [40, 80, 160, 255],
            10: [60, 140, 50, 255],
            40: [90, 80, 70, 255],
            41: [90, 80, 70, 255],
            42: [90, 80, 70, 255],
        };

        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const i = (y * size + x) * 4;
                const u = x / size;
                const v = y / size;
                const noise = Math.sin(u * 10 + face * 2) * Math.cos(v * 10) * 0.5 + 0.5;

                let tileType = 10;
                if (noise < 0.3) tileType = 0;
                else if (noise > 0.7) tileType = 40;

                const color = tileColors[tileType] || [128, 128, 128, 255];
                data[i] = color[0];
                data[i + 1] = color[1];
                data[i + 2] = color[2];
                data[i + 3] = color[3];
            }
        }

        const texture = new Texture({
            width: size,
            height: size,
            format: TextureFormat.RGBA8,
            minFilter: TextureFilter.LINEAR,
            magFilter: TextureFilter.LINEAR,
            data: data
        });

        this.backend.createTexture(texture);
        return texture;
    }

    _createFlatNormalMap(size) {
        const data = new Uint8Array(size * size * 4);

        for (let i = 0; i < size * size; i++) {
            const idx = i * 4;
            data[idx] = 128;
            data[idx + 1] = 128;
            data[idx + 2] = 255;
            data[idx + 3] = 255;
        }

        const texture = new Texture({
            width: size,
            height: size,
            format: TextureFormat.RGBA8,
            minFilter: TextureFilter.LINEAR,
            magFilter: TextureFilter.LINEAR,
            data: data
        });

        this.backend.createTexture(texture);
        return texture;
    }

    async _createPlaceholderFace(face) {
        const colorTexture = this._createFallbackColorTexture(face, null);
        const normalTexture = this._createFlatNormalMap(this.outputResolution);

        this.faceTextures.set(face, {
            color: colorTexture,
            normal: normalTexture
        });
    }

    // ========================================================================
    // Accessors
    // ========================================================================

    getFaceTextures(face) {
        return this.faceTextures.get(face) || null;
    }

    getAllFaceTextures() {
        return this.faceTextures;
    }

    // ========================================================================
    // Cleanup
    // ========================================================================

    dispose() {
        for (const faceData of this.faceTextures.values()) {
            if (faceData?.color?._gpuTexture?.texture) {
                faceData.color._gpuTexture.texture.destroy();
            }
            if (faceData?.normal?._gpuTexture?.texture) {
                faceData.normal._gpuTexture.texture.destroy();
            }
        }
        this.faceTextures.clear();

        if (this.compositeUniformBuffer) {
            this.compositeUniformBuffer.destroy();
        }
        if (this.normalUniformBuffer) {
            this.normalUniformBuffer.destroy();
        }
        if (this.avgColorUniformBuffer) {
            this.avgColorUniformBuffer.destroy();
        }
        if (this.tileAverageColorTexture?._gpuTexture?.texture) {
            this.tileAverageColorTexture._gpuTexture.texture.destroy();
        }

        this.initialized = false;
    }
}
