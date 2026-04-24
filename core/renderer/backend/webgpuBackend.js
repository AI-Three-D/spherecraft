
// backend/webgpuBackend.js

import { Backend } from './backend.js';
import { TextureFormat, TextureFilter, TextureWrap, Texture } from '../resources/texture.js';
import { Logger } from '../../../shared/Logger.js';
import { gpuFormatSampleType } from '../resources/texture.js';
export class WebGPUBackend extends Backend {
    constructor(canvas) {
        super(canvas);
        this.device = null;
        this.adapter = null;
        this.context = null;
        this.format = null;
        // When postprocessing is active, scene geometry renders to an HDR
        // off-screen target. Set this to override the format used for
        // material pipeline compilation (falls back to this.format).
        this.sceneFormat = null;
        this.supportsIndirectFirstInstance = null;

        this._currentRenderTarget = null;
        // When set, setRenderTarget(null) falls back to this instead of
        // the swap chain. Used by the postprocessing pipeline so that
        // renderers calling setRenderTarget(null) to "return to screen"
        // actually return to the HDR off-screen target.
        this._defaultRenderTarget = null;
        this._currentPipeline = null;
        this._currentBindGroups = new Map();
        this._commandEncoder = null;
        this._renderPassEncoder = null;

        this._bufferCache = new Map();
        this._textureCache = new Map();
        this._pipelineCache = new Map();
        this._bindGroupLayoutCache = new Map();
        this._samplerCache = new Map();
        this._bindGroupCache = new Map();
        this._pendingBufferDestroys = [];
        this._pendingTextureDestroys = [];

        this._depthTexture = null;
        this._clearColor = { r: 0, g: 0, b: 0, a: 1 };
        this._viewport = { x: 0, y: 0, width: 0, height: 0 };
        this._dummyTexture = null;
        this._dummyTextureView = null;
        this._dummyArrayTexture = null;
        this._dummyArrayTextureView = null;
        this._dummyStorageBuffer = null;
        this._dummyStorageTexture = null;
        this._dummyStorageTextureView = null;

        this._terrainVertexUniformScratch = {
            buffer: new ArrayBuffer(82 * 4),
            f32: null,
            i32: null
        };
        this._terrainVertexUniformScratch.f32 = new Float32Array(this._terrainVertexUniformScratch.buffer);
        this._terrainVertexUniformScratch.i32 = new Int32Array(this._terrainVertexUniformScratch.buffer);

        this._terrainFragmentUniformScratch = {
            buffer: new ArrayBuffer(512),
            f32: null,
            i32: null
        };
        this._terrainFragmentUniformScratch.f32 = new Float32Array(this._terrainFragmentUniformScratch.buffer);
        this._terrainFragmentUniformScratch.i32 = new Int32Array(this._terrainFragmentUniformScratch.buffer);

        this._textureUploadSkip = new Set([
            'clusterDataTexture',
            'lightDataTexture',
            'lightIndicesTexture',
            'shadowMapCascade0',
            'shadowMapCascade1',
            'shadowMapCascade2'
        ]);
        this._chunkTextureNames = [
            'heightTexture',
            'normalTexture',
            'tileTexture',
            'splatDataMap',
            'splatIndexMap',
            'macroMaskTexture',
        ];  
        
        this._atlasTextureNames = ['atlasTexture', 'level2AtlasTexture', 'tileTypeLookup', 'macroTileTypeLookup', 'numVariantsTex'];
        this._lightingTextureNames = [
        'shadowMapCascade0', 'shadowMapCascade1', 'shadowMapCascade2',
            'clusterDataTexture', 'lightDataTexture', 'lightIndicesTexture'
        ];
    }


    /**
     * Draw terrain using instancing.
     * @param {Object} geometry - Shared geometry for LOD
     * @param {Object} material - Terrain material
     * @param {Object} uniforms - Global uniforms
     * @param {GPUBuffer} instanceBuffer - Storage buffer with instance data
     * @param {number} instanceCount - Number of instances to draw
     */
    drawInstanced(geometry, material, uniforms, instanceBuffer, instanceCount) {
        if (!this._renderPassEncoder) this.clear(true, true, false);
        if (material._needsCompile || !material._gpuPipeline) this.compileShader(material);

    const allUniforms = { ...material.uniforms, ...uniforms };
        this._ensureTexturesUploaded(allUniforms);

        this._renderPassEncoder.setPipeline(material._gpuPipeline.pipeline);

        // Set the instance buffer on the material's storage buffers
        material.storageBuffers = material.storageBuffers || {};
        material.storageBuffers.chunkInstances = { gpuBuffer: instanceBuffer };

    const bindGroups = this._createBindGroups(material, allUniforms, geometry);
        bindGroups.forEach((bg, i) => this._renderPassEncoder.setBindGroup(i, bg));

        // Set vertex buffers
    const vertexLayouts = material._gpuPipeline.vertexBufferLayouts || material.vertexLayout;
        if (vertexLayouts) {
            for (let slot = 0; slot < vertexLayouts.length; slot++) {
            const layout = vertexLayouts[slot];
                if (layout.stepMode === 'instance') continue; // Skip instance buffers (handled via storage)

                let attributeName = null;
                if (layout.attributes?.[0]) {
                const location = layout.attributes[0].shaderLocation;
                    switch(location) {
                        case 0: attributeName = 'position'; break;
                        case 1: attributeName = 'normal'; break;
                        case 2: attributeName = 'uv'; break;
                    }
                }

                if (attributeName) {
                const attr = geometry.attributes.get(attributeName);
                    if (attr?.gpuBuffer) {
                        this._renderPassEncoder.setVertexBuffer(slot, attr.gpuBuffer, attr.gpuBufferOffset || 0);
                    } else if (attr?.data) {
                    const buf = this._getOrCreateAttributeBuffer(geometry, attr.data, false, attributeName);
                        this._renderPassEncoder.setVertexBuffer(slot, buf.gpuBuffer);
                    } else {
                    const dummyBuffer = this._getOrCreateDummyVertexBuffer(layout.arrayStride || 16);
                        this._renderPassEncoder.setVertexBuffer(slot, dummyBuffer);
                    }
                }
            }
        }

        // Get draw count
        let count = geometry.drawRange.count;
        if (count === Infinity) {
            if (geometry.index) count = geometry.index.count;
            else if (geometry.attributes.get('position')) count = geometry.attributes.get('position').count;
            else count = 0;
        }

        if (count === 0 || instanceCount === 0) return;

        // Issue instanced draw call
        if (geometry.index) {
        const iBuf = this._getOrCreateAttributeBuffer(geometry, geometry.index.data, true, 'index');
            this._renderPassEncoder.setIndexBuffer(
                iBuf.gpuBuffer,
                geometry.index.data instanceof Uint32Array ? 'uint32' : 'uint16'
            );
            this._renderPassEncoder.drawIndexed(count, instanceCount, geometry.drawRange.start, 0, 0);
        } else {
            this._renderPassEncoder.draw(count, instanceCount, geometry.drawRange.start, 0);
        }

        // Log instancing stats periodically
        if (!this._instancedDrawCount) this._instancedDrawCount = 0;
        this._instancedDrawCount += instanceCount;
    }

    async initialize() {
        if (this.device) {

            return;
        }

        if (!navigator.gpu) {
            throw new Error('WebGPU not supported');
        }

        this.adapter = await navigator.gpu.requestAdapter({
            powerPreference: 'high-performance'
        });

        if (!this.adapter) {
            throw new Error('Failed to get WebGPU adapter');
        }

        // Request higher limits for large planets with many chunks
        const adapterLimits = this.adapter.limits;
        const requiredLimits = {};

        // Request max buffer size the adapter supports (up to 4GB)
        if (adapterLimits.maxBufferSize) {
            requiredLimits.maxBufferSize = Math.min(adapterLimits.maxBufferSize, 4294967296);
        }

        // Request higher storage buffer binding size for terrain data
        if (adapterLimits.maxStorageBufferBindingSize) {
            requiredLimits.maxStorageBufferBindingSize = Math.min(adapterLimits.maxStorageBufferBindingSize, 1073741824);
        }

        // Mid-near scatter compute path uses 9 storage buffers in a single stage.
        if (adapterLimits.maxStorageBuffersPerShaderStage) {
            requiredLimits.maxStorageBuffersPerShaderStage =
                Math.min(adapterLimits.maxStorageBuffersPerShaderStage, 10);
        }

        // Request more bind groups for complex terrain materials
        if (adapterLimits.maxBindGroups) {
            requiredLimits.maxBindGroups = Math.min(adapterLimits.maxBindGroups, 8);
        }
        // Terrain may use many sampled textures (atlas + shadow + optional AO).
        if (adapterLimits.maxSampledTexturesPerShaderStage) {
            requiredLimits.maxSampledTexturesPerShaderStage = Math.min(adapterLimits.maxSampledTexturesPerShaderStage, 32);
        }
        if (adapterLimits.maxTextureArrayLayers) {
            requiredLimits.maxTextureArrayLayers = Math.min(adapterLimits.maxTextureArrayLayers, 2048);
        }

        // Request higher texture dimension limits for large atlases
        if (adapterLimits.maxTextureDimension2D) {
            requiredLimits.maxTextureDimension2D = Math.min(adapterLimits.maxTextureDimension2D, 16384);
        }

        const requiredFeatures = [];
        this.supportsIndirectFirstInstance = this.adapter.features?.has?.('indirect-first-instance') === true;
        if (this.supportsIndirectFirstInstance) {
            requiredFeatures.push('indirect-first-instance');
        } else {
            Logger.warn('[WebGPU] Adapter missing indirect-first-instance; indirect draws will ignore firstInstance.');
        }

        this.device = await this.adapter.requestDevice({
            requiredFeatures,
            requiredLimits,
        });
        Logger.info(`[WebGPU] Feature indirect-first-instance=${this.supportsIndirectFirstInstance ? 'yes' : 'no'}`);

        this.device.lost.then((info) => {

        });

        this.context = this.canvas.getContext('webgpu');
        this.format = navigator.gpu.getPreferredCanvasFormat();

        this.context.configure({
            device: this.device,
            format: this.format,
            alphaMode: 'opaque'
        });

        this._viewport = {
            x: 0,
            y: 0,
            width: this.canvas.width,
            height: this.canvas.height
        };

        this._createDepthTexture();
        this._createDefaultSamplers();


    }

    _packAtmosphereUniforms(uniforms) {
        const data = new Float32Array(16);

        data[0] = uniforms.atmospherePlanetRadius?.value ?? 50000;
        data[1] = uniforms.atmosphereRadius?.value ?? 55000;
        data[2] = uniforms.atmosphereScaleHeightRayleigh?.value ?? 800;
        data[3] = uniforms.atmosphereScaleHeightMie?.value ?? 120;

        const rayleigh = uniforms.atmosphereRayleighScattering?.value;
        data[4] = rayleigh?.x ?? 5.5e-5;
        data[5] = rayleigh?.y ?? 13.0e-5;
        data[6] = rayleigh?.z ?? 22.4e-5;
        data[7] = uniforms.atmosphereMieScattering?.value ?? 21e-5;

        const ozone = uniforms.atmosphereOzoneAbsorption?.value;
        data[8] = ozone?.x ?? 0.65e-6;
        data[9] = ozone?.y ?? 1.881e-6;
        data[10] = ozone?.z ?? 0.085e-6;
        data[11] = uniforms.atmosphereMieAnisotropy?.value ?? 0.8;

        data[12] = uniforms.atmosphereGroundAlbedo?.value ?? 0.3;
        data[13] = uniforms.atmosphereSunIntensity?.value ?? 20.0;
        data[14] = uniforms.viewerAltitude?.value ?? 0.0;
        data[15] = 0.0;

        return data;
    }

    _createDepthTexture() {
        if (this._depthTexture) {
            this._queueTextureDestroy(this._depthTexture);
        }
    
        this._depthTexture = this.device.createTexture({
            size: [this._viewport.width || this.canvas.width, this._viewport.height || this.canvas.height],
            format: 'depth24plus',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
        });
        
        // Create and cache the view for sampling
        this._depthTextureView = this._depthTexture.createView();
    }
    _createDefaultSamplers() {
        this._samplerCache.set('linear-repeat', this.device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            mipmapFilter: 'linear',
            addressModeU: 'repeat',
            addressModeV: 'repeat',
            addressModeW: 'repeat'
        }));
        this._samplerCache.set('linear', this.device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            mipmapFilter: 'linear',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge'
        }));

        this._samplerCache.set('nearest', this.device.createSampler({
            magFilter: 'nearest',
            minFilter: 'nearest',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge'
        }));

        this._samplerCache.set('repeat', this.device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            mipmapFilter: 'linear',
            addressModeU: 'repeat',
            addressModeV: 'repeat'
        }));

        this._samplerCache.set('shadow', this.device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge'
        }));
        this._samplerCache.set('shadow-comparison', this.device.createSampler({
            label: 'ShadowComparisonSampler',
            compare: 'less',
            magFilter: 'linear',
            minFilter: 'linear',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge'
        }));
    }

    _padTextureData(data, width, height, format) {
        const bytesPerPixel = this._getBytesPerPixel(format);
        const bytesPerRow = width * bytesPerPixel;

        if (bytesPerRow % 256 === 0) {
            return { data, bytesPerRow };
        }

        const alignedBytesPerRow = Math.ceil(bytesPerRow / 256) * 256;
        const paddedSize = alignedBytesPerRow * height;
        const paddedData = new Uint8Array(paddedSize);

        const srcBuffer = new Uint8Array(data.buffer || data, data.byteOffset, data.byteLength);

        for (let y = 0; y < height; y++) {
            const srcOffset = y * bytesPerRow;
            const dstOffset = y * alignedBytesPerRow;
            if (srcOffset + bytesPerRow <= srcBuffer.length) {
                paddedData.set(srcBuffer.subarray(srcOffset, srcOffset + bytesPerRow), dstOffset);
            }
        }

        return { data: paddedData, bytesPerRow: alignedBytesPerRow };
    }

    _getOrCreateDummyTexture() {
        if (!this._dummyTexture) {
            this._dummyTexture = this.device.createTexture({
                size: [1, 1],
            format: 'rgba8unorm',
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
            });

            const whitePixel = new Uint8Array([255, 255, 255, 255]);
            const { data, bytesPerRow } = this._padTextureData(whitePixel, 1, 1, TextureFormat.RGBA8);

            this.device.queue.writeTexture(
                { texture: this._dummyTexture },
            data,
                { bytesPerRow: bytesPerRow },
                [1, 1]
            );
        }
        if (!this._dummyTextureView) {
            this._dummyTextureView = this._dummyTexture.createView();
        }
        return this._dummyTexture;
    }

    _getOrCreateDummyTextureView() {
        this._getOrCreateDummyTexture();
        return this._dummyTextureView || this._dummyTexture.createView();
    }

    _getOrCreateDummyArrayTextureView() {
        if (!this._dummyArrayTexture) {
            this._dummyArrayTexture = this.device.createTexture({
                size: [1, 1, 1],
            format: 'rgba8unorm',
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
            });

            const whitePixel = new Uint8Array([255, 255, 255, 255]);
            const { data, bytesPerRow } = this._padTextureData(whitePixel, 1, 1, TextureFormat.RGBA8);
            this.device.queue.writeTexture(
                { texture: this._dummyArrayTexture },
            data,
                { bytesPerRow: bytesPerRow },
                [1, 1, 1]
            );
        }
        if (!this._dummyArrayTextureView) {
            this._dummyArrayTextureView = this._dummyArrayTexture.createView({ dimension: '2d-array' });
        }
        return this._dummyArrayTextureView;
    }

    _getOrCreateDummy3DTextureView() {
        if (!this._dummy3DTexture) {
            this._dummy3DTexture = this.device.createTexture({
                size: [1, 1, 1],
            dimension: '3d',
                format: 'rgba8unorm',
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
            });

            const whitePixel = new Uint8Array([255, 255, 255, 255]);
            const { data, bytesPerRow } = this._padTextureData(whitePixel, 1, 1, TextureFormat.RGBA8);
            this.device.queue.writeTexture(
                { texture: this._dummy3DTexture },
            data,
                { bytesPerRow: bytesPerRow },
                [1, 1, 1]
            );
        }
        if (!this._dummy3DTextureView) {
            this._dummy3DTextureView = this._dummy3DTexture.createView({ dimension: '3d' });
        }
        return this._dummy3DTextureView;
    }

    _getOrCreateDummyStorageTextureView(viewDimension = '2d') {
        if (!this._dummyStorageTexture) {
            this._dummyStorageTexture = this.device.createTexture({
                size: [1, 1, 1],
                format: 'rgba8unorm',
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING
            });
            this._dummyStorageTextureView = this._dummyStorageTexture.createView({ dimension: '2d' });
        }

        if (viewDimension === '3d') {
            return this._dummyStorageTexture.createView({ dimension: '3d' });
        }
        if (viewDimension === '2d-array') {
            return this._dummyStorageTexture.createView({ dimension: '2d-array' });
        }

        return this._dummyStorageTextureView;
    }

    _getOrCreateDummyStorageBuffer() {
        if (!this._dummyStorageBuffer) {
            // 256 bytes: satisfies all pipeline minimum binding sizes (terrain needs ≥64).
            this._dummyStorageBuffer = this.device.createBuffer({
                size: 256,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
            });
        }
        return this._dummyStorageBuffer;
    }

    createTexture(texture) {
        const format = this._getTextureFormat(texture.format);
  
        if (texture._gpuTexture && texture._gpuTexture.texture) {
            
            texture._gpuTexture.texture.destroy();
        }
    
        const depth = texture.depth || 1;
        const isArray = texture._isArray && depth > 1;
    
        // Mipmap eligibility: filterable formats only, and not raw data textures.
        const MIPMAPPABLE = new Set(['rgba8unorm', 'bgra8unorm', 'rgba16float']);
        const shouldGenerateMipmaps =
            texture.generateMipmaps === true &&
            MIPMAPPABLE.has(format);
    
        const mipLevelCount = shouldGenerateMipmaps
            ? Math.floor(Math.log2(Math.max(texture.width, texture.height))) + 1
            : 1;
 
        const gpuTexture = this.device.createTexture({
            size: [texture.width, texture.height, depth],
            format: format,
            // WebGPU only accepts '2d' or '3d' here; array-ness is in the view.
            dimension: '2d',
            usage:
                GPUTextureUsage.TEXTURE_BINDING |
                GPUTextureUsage.COPY_DST |
                GPUTextureUsage.RENDER_ATTACHMENT,
            mipLevelCount: mipLevelCount
        });
    
        if (texture.data) {
            if (isArray) {
                // Each layer is width × height × bytesPerPixel.  Upload one at a time
                // so that origin.z selects the correct layer.
                const bytesPerPixel = this._getBytesPerPixel(texture.format);
                const layerSize = texture.width * texture.height * bytesPerPixel;
    
                for (let layer = 0; layer < depth; layer++) {
                    const layerData = texture.data.subarray(
                        layer * layerSize,
                        (layer + 1) * layerSize
                    );
                    const { data, bytesPerRow } = this._padTextureData(
                        layerData, texture.width, texture.height, texture.format
                    );
                    this.device.queue.writeTexture(
                        { texture: gpuTexture, origin: { x: 0, y: 0, z: layer } },
                        data,
                        { bytesPerRow },
                        [texture.width, texture.height, 1]
                    );
                }
            } else {
                const { data, bytesPerRow } = this._padTextureData(
                    texture.data, texture.width, texture.height, texture.format
                );
                this.device.queue.writeTexture(
                    { texture: gpuTexture, mipLevel: 0 },
                    data,
                    { bytesPerRow },
                    [texture.width, texture.height, depth]
                );
            }
        } else if (texture.image) {
            this.device.queue.copyExternalImageToTexture(
                { source: texture.image },
                { texture: gpuTexture, mipLevel: 0 },
                [texture.width, texture.height, depth]
            );
        }
    
        // Generate mipmaps after base level(s) are uploaded.
        // layerCount > 1 makes it iterate every layer independently.
        if (shouldGenerateMipmaps && mipLevelCount > 1) {
            this._generateMipmaps(
                gpuTexture, format,
                texture.width, texture.height,
                mipLevelCount,
                isArray ? depth : 1          // ← new parameter
            );
        }
    
        const dimension = isArray ? '2d-array' : '2d';
        const view = gpuTexture.createView({ dimension });
        const viewKey = `_view_${dimension}`;
        texture._gpuTexture = {
            texture: gpuTexture,
            view: view,
            format: format,
            [viewKey]: view,
            mipLevelCount: mipLevelCount
        };
        texture._needsUpload = false;
        return texture._gpuTexture;
    }

    /**
 * Lazily create (and cache per-format) the full-screen blit pipeline used
 * to down-sample each mip level from the one above it.
 */
_ensureMipmapPipeline(format) {
    if (!this._mipmapPipelines) this._mipmapPipelines = new Map();
    if (this._mipmapPipelines.has(format)) return this._mipmapPipelines.get(format);

    const vertexShader = `
    struct VertexOutput {
        @builtin(position) position: vec4<f32>,
        @location(0) uv: vec2<f32>,
    }

    const positions = array<vec2<f32>, 6>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>( 1.0, -1.0),
        vec2<f32>(-1.0,  1.0),
        vec2<f32>(-1.0,  1.0),
        vec2<f32>( 1.0, -1.0),
        vec2<f32>( 1.0,  1.0)
    );

    @vertex
    fn main(@builtin(vertex_index) i: u32) -> VertexOutput {
        let p = positions[i];
        var output: VertexOutput;
        output.position = vec4<f32>(p, 0.0, 1.0);
        output.uv = p * 0.5 + 0.5;
        return output;
    }
`;
    const fragmentShader = `
        @group(0) @binding(0) var srcTex: texture_2d<f32>;
        @group(0) @binding(1) var srcSamp: sampler;

        @fragment
        fn main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
            return textureSample(srcTex, srcSamp, uv);
        }
    `;

    const vertexModule  = this.device.createShaderModule({ label: 'Mipmap-VS', code: vertexShader });
    const fragmentModule = this.device.createShaderModule({ label: 'Mipmap-FS', code: fragmentShader });

    const bindGroupLayout = this.device.createBindGroupLayout({
        label: 'Mipmap-BGL',
        entries: [
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} }
        ]
    });

    const pipeline = this.device.createRenderPipeline({
        label: `Mipmap-${format}`,
        layout: this.device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
        vertex:   { module: vertexModule,  entryPoint: 'main' },
        fragment: {
            module: fragmentModule,
            entryPoint: 'main',
            targets: [{ format }]      // must match the texture being mipmapped
        },
        primitive: { topology: 'triangle-list' }
    });

    const entry = { pipeline, bindGroupLayout };
    this._mipmapPipelines.set(format, entry);
    return entry;
}

_generateMipmaps(gpuTexture, format, width, height, mipLevelCount, layerCount = 1) {
    const { pipeline, bindGroupLayout } = this._ensureMipmapPipeline(format);
    const sampler = this._samplerCache.get('linear');
    const encoder = this.device.createCommandEncoder({ label: 'MipmapGeneration' });

    for (let layer = 0; layer < layerCount; layer++) {
        for (let level = 1; level < mipLevelCount; level++) {
            const srcView = gpuTexture.createView({
                dimension:      '2d',
                baseMipLevel:   level - 1,
                mipLevelCount:  1,
                baseArrayLayer: layer,
                arrayLayerCount: 1
            });
            const dstView = gpuTexture.createView({
                dimension:      '2d',
                baseMipLevel:   level,
                mipLevelCount:  1,
                baseArrayLayer: layer,
                arrayLayerCount: 1
            });

            const bindGroup = this.device.createBindGroup({
                layout: bindGroupLayout,
                entries: [
                    { binding: 0, resource: srcView },
                    { binding: 1, resource: sampler }
                ]
            });

            const mipWidth  = Math.max(1, width  >> level);
            const mipHeight = Math.max(1, height >> level);

            const renderPass = encoder.beginRenderPass({
                colorAttachments: [{
                    view:       dstView,
                    loadOp:     'clear',
                    storeOp:    'store',
                    clearValue: { r: 0, g: 0, b: 0, a: 0 }
                }]
            });

            renderPass.setPipeline(pipeline);
            renderPass.setBindGroup(0, bindGroup);
            renderPass.setViewport(0, 0, mipWidth, mipHeight, 0, 1);
            renderPass.draw(6);
            renderPass.end();
        }
    }

    this.device.queue.submit([encoder.finish()]);
}
updateTexture(texture) {

    if (!texture._gpuTexture) return this.createTexture(texture);

    if (texture.data) {
        const depth = texture.depth || 1;
        const isArray = texture._isArray && depth > 1;

        if (isArray) {
            const bytesPerPixel = this._getBytesPerPixel(texture.format);
            const layerSize = texture.width * texture.height * bytesPerPixel;
            for (let layer = 0; layer < depth; layer++) {
                const layerData = texture.data.subarray(
                    layer * layerSize, (layer + 1) * layerSize
                );
                const { data, bytesPerRow } = this._padTextureData(
                    layerData, texture.width, texture.height, texture.format
                );
                this.device.queue.writeTexture(
                    { texture: texture._gpuTexture.texture, origin: { x: 0, y: 0, z: layer } },
                    data,
                    { bytesPerRow },
                    [texture.width, texture.height, 1]
                );
            }
        } else {
            const { data, bytesPerRow } = this._padTextureData(
                texture.data, texture.width, texture.height, texture.format
            );
            this.device.queue.writeTexture(
                { texture: texture._gpuTexture.texture, mipLevel: 0 },
                data,
                { bytesPerRow },
                [texture.width, texture.height, depth]
            );
        }

        const mipLevelCount = texture._gpuTexture.mipLevelCount || 1;
        if (mipLevelCount > 1) {
            this._generateMipmaps(
                texture._gpuTexture.texture,
                texture._gpuTexture.format,
                texture.width, texture.height,
                mipLevelCount,
                isArray ? depth : 1
            );
        }
    }
    texture._needsUpload = false;
}
    createStorageTexture(width, height, format) {
        const gpuFormat = this._getTextureFormat({ format });

        const texture = this.device.createTexture({
            size: [width, height],
        format: gpuFormat,
            usage: GPUTextureUsage.STORAGE_BINDING |
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.COPY_SRC
        });

        return {
            texture: texture,
            view: texture.createView(),
            format: gpuFormat,
            width: width,
            height: height
        };
    }

    deleteStorageTexture(gpuTexture) {
        if (gpuTexture && gpuTexture.texture) {
            gpuTexture.texture.destroy();
        }
    }

    createComputePipeline(descriptor) {
        const shaderModule = this.device.createShaderModule({
            label: descriptor.label || 'Compute Shader',
            code: descriptor.shaderSource
        });

        const bindGroupLayoutEntries = descriptor.bindGroupLayouts[0].entries.map(entry => {
            const layoutEntry = {
            binding: entry.binding,
            visibility: GPUShaderStage.COMPUTE
            };

        if (entry.type === 'uniform') {
            layoutEntry.buffer = { type: 'uniform' };
        } else if (entry.type === 'storageTexture') {
            layoutEntry.storageTexture = {
                access: entry.access === 'read' ? 'read-only' : 'write-only',
                format: entry.format,
                viewDimension: '2d'
                };
        } else if (entry.type === 'texture') {
            layoutEntry.texture = { sampleType: 'float' };
        } else if (entry.type === 'sampler') {
            layoutEntry.sampler = { type: 'filtering' };
        }

        return layoutEntry;
        });

        const bindGroupLayout = this.device.createBindGroupLayout({
            entries: bindGroupLayoutEntries
        });

        const pipeline = this.device.createComputePipeline({
            label: descriptor.label,
            layout: this.device.createPipelineLayout({
            bindGroupLayouts: [bindGroupLayout]
            }),
        compute: {
            module: shaderModule,
                entryPoint: 'main'
        }
        });

        return { pipeline, bindGroupLayout };
    }

    createBindGroup(layout, entries) {
        const bindGroupEntries = entries.map(entry => {
            const bgEntry = { binding: entry.binding };

        if (entry.resource.gpuBuffer) {
            bgEntry.resource = { buffer: entry.resource.gpuBuffer };
        } else if (entry.resource.view) {
            bgEntry.resource = entry.resource.view;
        } else if (entry.resource.texture) {
            bgEntry.resource = entry.resource.texture.createView();
        } else {
            bgEntry.resource = entry.resource;
        }

        return bgEntry;
        });

        return this.device.createBindGroup({
            layout: layout,
            entries: bindGroupEntries
        });
    }

    dispatchCompute(pipeline, bindGroup, workgroupsX, workgroupsY = 1, workgroupsZ = 1) {
        const commandEncoder = this.device.createCommandEncoder();
        const computePass = commandEncoder.beginComputePass();

        computePass.setPipeline(pipeline);
        computePass.setBindGroup(0, bindGroup);
        computePass.dispatchWorkgroups(workgroupsX, workgroupsY, workgroupsZ);

        computePass.end();
        this.device.queue.submit([commandEncoder.finish()]);
    }

    createBuffer(data, usage = 'static') {
        const isIndexBuffer = data instanceof Uint16Array || data instanceof Uint32Array;
        let gpuUsage = GPUBufferUsage.COPY_DST;
        if (isIndexBuffer) gpuUsage |= GPUBufferUsage.INDEX;
        else gpuUsage |= GPUBufferUsage.VERTEX;

        if (usage === 'uniform') gpuUsage = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
        else if (usage === 'storage') gpuUsage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;

        const alignedSize = Math.ceil(data.byteLength / 4) * 4;
        const buffer = this.device.createBuffer({
            size: alignedSize,
            usage: gpuUsage,
            mappedAtCreation: true
        });

        const mapping = new (data.constructor)(buffer.getMappedRange());
        mapping.set(data);
        buffer.unmap();

        return {
            gpuBuffer: buffer,
            size: data.byteLength,
            isIndex: isIndexBuffer,
            elementType: data instanceof Uint32Array ? 'uint32' : data instanceof Uint16Array ? 'uint16' : 'float32'
        };
    }

    updateBuffer(buffer, data, offset = 0) {
        this.device.queue.writeBuffer(buffer.gpuBuffer, offset, data);
    }

    deleteBuffer(buffer) {
        if (buffer && buffer.gpuBuffer) buffer.gpuBuffer.destroy();
    }

    deleteTexture(texture) {
        if (texture._gpuTexture) {
            texture._gpuTexture.texture.destroy();
            texture._gpuTexture = null;
        }
    }

    deleteShader(material) {
        material._gpuPipeline = null;
    }

    _getVertexBufferLayouts(material) {
        if (material.vertexLayout) {
            return material.vertexLayout;
        }

        const vs = material.vertexShader;
        const vertexInputMatch = vs.match(/struct\s+VertexInput\s*\{([^}]*)\}/s);

        if (!vertexInputMatch) {

        return this._getDefaultVertexLayout();
    }

        const inputBlock = vertexInputMatch[1];
        const locationRegex = /@location\((\d+)\)\s+(\w+)\s*:\s*([^,;\n]+)/g;
        const locations = [];

    let match;
        while ((match = locationRegex.exec(inputBlock)) !== null) {
            const location = parseInt(match[1]);
            const name = match[2];
            const type = match[3].trim();
        locations.push({ location, name, type });
    }

        if (locations.length === 0) {

        return this._getDefaultVertexLayout();
    }

        locations.sort((a, b) => a.location - b.location);

        const layouts = [];

        for (const attr of locations) {
            const format = this._getVertexFormat(attr.type);
            const size = this._getVertexSize(attr.type);

        layouts.push({
            arrayStride: size,
            stepMode: 'vertex',
            attributes: [{
            shaderLocation: attr.location,
                offset: 0,
                format: format
        }]
            });
    }

        if (inputBlock.includes('instanceMatrix')) {
            const instanceStartLocation = locations.length;
        layouts.push({
            arrayStride: 64,
            stepMode: 'instance',
            attributes: [
        { shaderLocation: instanceStartLocation + 0, offset: 0,  format: 'float32x4' },
        { shaderLocation: instanceStartLocation + 1, offset: 16, format: 'float32x4' },
        { shaderLocation: instanceStartLocation + 2, offset: 32, format: 'float32x4' },
        { shaderLocation: instanceStartLocation + 3, offset: 48, format: 'float32x4' },
                ]
            });
    }

        return layouts;
}

_getDefaultVertexLayout() {
    return [
    { arrayStride: 12, stepMode: 'vertex', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
    { arrayStride: 12, stepMode: 'vertex', attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
    { arrayStride: 8,  stepMode: 'vertex', attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x2' }] }
        ];
}

_getVertexFormat(wgslType) {
        const formatMap = {
        'vec3<f32>': 'float32x3',
        'vec2<f32>': 'float32x2',
        'vec4<f32>': 'float32x4',
        'f32': 'float32',
        'vec3<u32>': 'uint32x3',
        'vec2<u32>': 'uint32x2',
        'u32': 'uint32',
        'vec3<i32>': 'sint32x3',
        'vec2<i32>': 'sint32x2',
        'i32': 'sint32',
        };
    return formatMap[wgslType] || 'float32x3';
}

_getVertexSize(wgslType) {
        const sizeMap = {
        'vec3<f32>': 12,
        'vec2<f32>': 8,
        'vec4<f32>': 16,
        'f32': 4,
        'vec3<u32>': 12,
        'vec2<u32>': 8,
        'u32': 4,
        'vec3<i32>': 12,
        'vec2<i32>': 8,
        'i32': 4,
        };
    return sizeMap[wgslType] || 12;
}

compileShader(material) {
    const materialType = (material.name || 'unknown').toLowerCase().trim();
    const baseType = materialType.replace(/[0-9_-]/g, '');

    const layoutVersion = materialType.includes('terrain') ? 'v18' : 'v1';
    const layoutKeyRaw = material.vertexLayout ?
        JSON.stringify(material.vertexLayout.map(l => ({
            stride: l.arrayStride,
            step: l.stepMode,
            attrs: l.attributes.length
        }))) :
        `default_${layoutVersion}`;
    const layoutKey = materialType.includes('terrain')
        ? `${layoutKeyRaw}_v${layoutVersion}`
        : layoutKeyRaw;

    const shaderHash = this._hashCode(material.vertexShader.substring(0, 200) +
        material.fragmentShader.substring(0, 200));

    const arrayFlag = material.defines?.USE_TEXTURE_ARRAYS ? 'arr' : '2d';
    const fmtFlag = material.targetFormat || this.sceneFormat || '';

    // Chunk texture formats affect the bind group layout sampleTypes.
    // Two terrain materials differing only in normal format must get
    // distinct pipelines.
    const chunkFmts = material._chunkTextureFormats || {};
    const chunkFmtKey = ['height','normal','tile','splatData','splatIndex','macro','terrainAO','groundField']
        .map(t => chunkFmts[t] || '')
        .join('|');

    const cacheKey = `${baseType}_${shaderHash}_${layoutKey}_${arrayFlag}_${fmtFlag}_cf${chunkFmtKey}`;

    if (this._pipelineCache.has(cacheKey)) {
        material._gpuPipeline = this._pipelineCache.get(cacheKey);
        material._needsCompile = false;

        return material._gpuPipeline;
    }

        

        const vertexModule = this.device.createShaderModule({
        label: `Vertex-${materialType}`,
    code: material.vertexShader
        });
        const fragmentModule = this.device.createShaderModule({
        label: `Fragment-${materialType}`,
    code: material.fragmentShader
        });

        const logCompilationInfo = async (module, stageLabel) => {
            if (!module.getCompilationInfo) return;
            const info = await module.getCompilationInfo();
            if (info.messages?.length) {
                console.error(`[WebGPU][${material.name}] ${stageLabel} compilation messages:`);
                for (const msg of info.messages) {
                    console.error(`  ${stageLabel}:${msg.lineNum ?? ''}:${msg.linePos ?? ''} ${msg.message}`);
                }
            }
        };

        const bindGroupLayouts = this._createBindGroupLayouts(material);


        const pipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts });

        const vertexBufferLayouts = material.vertexLayout || this._getVertexBufferLayouts(material);

    try {
            // Validation scopes to surface errors clearly
            this.device.pushErrorScope('validation');
            this.device.pushErrorScope('internal');
            const pipeline = this.device.createRenderPipeline({
            label: material.name || 'Material',
            layout: pipelineLayout,
            vertex: {
            module: vertexModule,
                entryPoint: 'main',
                buffers: vertexBufferLayouts
        },
        fragment: {
            module: fragmentModule,
                entryPoint: 'main',
                targets: [{
                format: material.targetFormat || this.sceneFormat || this.format,
                    blend: material.transparent ? (
                    material.blending === 'premultiplied' ? {
                        color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
                    } : {
                        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
                    }) : undefined
            }]
        },
        primitive: {
            topology: 'triangle-list',
                cullMode: material.side === 'double' ? 'none' : material.side === 'back' ? 'front' : 'back',
                frontFace: 'ccw'
        },
        depthStencil: material.depthTest ? {
            format: 'depth24plus',
            depthWriteEnabled: material.depthWrite,
            depthCompare: material.depthCompare || 'less'
        } : undefined
            }
        );
        this.device.popErrorScope().then(err => {
            if (err) {
                console.error(`[WebGPU][${material.name}] Pipeline internal error:`, err.message || err);
            }
        });

            // Pop validation errors
            this.device.popErrorScope().then(err => {
                if (err) {
                    console.error(`[WebGPU][${material.name}] Pipeline validation error:`, err.message || err);
                }
            });
  
            // Also log async shader compilation warnings
            logCompilationInfo(vertexModule, 'vertex');
            logCompilationInfo(fragmentModule, 'fragment');

        material._gpuPipeline = { pipeline, bindGroupLayouts, pipelineLayout, vertexBufferLayouts };
        this._pipelineCache.set(cacheKey, material._gpuPipeline);
        material._needsCompile = false;


        return material._gpuPipeline;
    } catch (error) {
        console.error(`[WebGPU][${material.name}] pipeline creation threw:`, error?.message || error);
        throw error;
    }
}

_hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
}

_describeLayouts(layouts) {
    return layouts.map((layout, i) => `Group${i}`);
}

_createOrbitalSphereLayouts() {
        const layouts = [];
    
        const group0 = this.device.createBindGroupLayout({
        label: 'OrbitalSphere-Group0-Uniforms',
        entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }
            ]
        });
    layouts.push(group0);
    
        const group1 = this.device.createBindGroupLayout({
        label: 'OrbitalSphere-Group1-Textures',
        entries: [
    {
        binding: 0,
            visibility: GPUShaderStage.FRAGMENT,
        texture: {
        sampleType: 'float',
            viewDimension: '2d',
            multisampled: false
    }
    },
    {
        binding: 1,
            visibility: GPUShaderStage.FRAGMENT,
        sampler: {
        type: 'filtering'
    }
    },
    {
        binding: 2,
            visibility: GPUShaderStage.FRAGMENT,
        texture: {
        sampleType: 'float',
            viewDimension: '2d',
            multisampled: false
    }
    }
            ]
        });
    layouts.push(group1);

    return layouts;
}

_createBindGroupLayouts(material) {
    const materialName = (material.name || '').toLowerCase();
    const useArrayTextures = !!material.defines?.USE_TEXTURE_ARRAYS;

    if (materialName.includes('shadow') || materialName.includes('depth')) {
        return this._createShadowLayouts();
    }
    if (materialName.includes('orbital') || materialName.includes('sphere')) {
        return this._createOrbitalSphereLayouts();
    }
    if (material.bindGroupLayoutSpec) {
        return this._buildLayoutsFromSpec(material.bindGroupLayoutSpec);
    }
    const shaderContent = (material.fragmentShader || '').toLowerCase();
    if (shaderContent.includes('planettexture')) {
        return this._createOrbitalSphereLayouts();
    }

    const includeTerrainAO = !!material.defines?.USE_TERRAIN_AO;
    const includeGroundField = !!material.defines?.USE_GROUND_FIELD;
    // Full per-slot format map. Missing keys default to rgba32float.
    const chunkFormats = material._chunkTextureFormats || {};
    return this._createTerrainBindGroupLayouts(
        useArrayTextures,
        includeTerrainAO,
        includeGroundField,
        chunkFormats
    );
}


_createTerrainBindGroupLayouts(
    useArrayTextures = false,
    includeTerrainAO = false,
    includeGroundField = false,
    chunkFormats = {}
) {
    const layouts = [];
    const chunkViewDimension = useArrayTextures ? '2d-array' : '2d';

    // Slot → texture type mapping (fixed order, matches shader bindings)
// Slot → texture type mapping (fixed order, matches shader bindings)
const slotTypes = ['height', 'normal', 'tile', 'splatData', 'splatIndex', 'macro'];
const slotSampleType = (type) =>
    gpuFormatSampleType(chunkFormats[type] || 'rgba32float');

    // Group 0 — uniforms
    layouts.push(this.device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: GPUShaderStage.VERTEX,                          buffer: { type: 'uniform' } },
            { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }
        ]
    }));

    // Group 1 — chunk data textures. Every slot derives its sampleType
    // from the actual format, so when any slot moves to a filterable
    // format, it gets sampleType:'float' automatically.
    const group1Entries = [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          texture: { sampleType: slotSampleType('height'),     viewDimension: chunkViewDimension } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: slotSampleType('normal'),     viewDimension: chunkViewDimension } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: slotSampleType('tile'),       viewDimension: chunkViewDimension } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: slotSampleType('splatData'),  viewDimension: chunkViewDimension } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: slotSampleType('splatIndex'), viewDimension: chunkViewDimension } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: slotSampleType('macro'),      viewDimension: chunkViewDimension } },
    ];
    if (includeTerrainAO) {
        group1Entries.push({
            binding: 6, visibility: GPUShaderStage.FRAGMENT,
            texture: { sampleType: slotSampleType('terrainAO'), viewDimension: chunkViewDimension }
        });
    } else if (includeGroundField) {
        group1Entries.push({
            binding: 6, visibility: GPUShaderStage.FRAGMENT,
            texture: { sampleType: slotSampleType('terrainAO'), viewDimension: chunkViewDimension }
        });
    }
    if (includeGroundField) {
        group1Entries.push({
            binding: 7, visibility: GPUShaderStage.FRAGMENT,
            texture: { sampleType: slotSampleType('groundField'), viewDimension: chunkViewDimension }
        });
    }
    layouts.push(this.device.createBindGroupLayout({ entries: group1Entries }));

    layouts.push(this.device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
            { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
            { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
            { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
            { binding: 6, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
            { binding: 7, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
            // Clamp-to-edge + trilinear. Used by chunk textures (normal map
            // today) that have their own mip chain. textureSampler at binding 5
            // is repeat-mode for atlas tiling and would wrap across tile edges
            // at mip levels > 0.
            { binding: 8, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        ]
    }));

    layouts.push(this.device.createBindGroupLayout({
        label: 'Terrain-Group3-Storage-Atmo-Lights-Shadows',
        entries: [
            { binding: 0,  visibility: GPUShaderStage.VERTEX,   buffer:  { type: 'read-only-storage' } },
            { binding: 7,  visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
            { binding: 8,  visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
            { binding: 1,  visibility: GPUShaderStage.FRAGMENT, buffer:  { type: 'read-only-storage' } },
            { binding: 2,  visibility: GPUShaderStage.FRAGMENT, buffer:  { type: 'read-only-storage' } },
            { binding: 3,  visibility: GPUShaderStage.FRAGMENT, buffer:  { type: 'read-only-storage' } },
            { binding: 4,  visibility: GPUShaderStage.FRAGMENT, buffer:  { type: 'uniform' } },
            { binding: 5,  visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
            { binding: 6,  visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
            { binding: 9,  visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
            { binding: 10, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
            { binding: 11, visibility: GPUShaderStage.FRAGMENT, buffer:  { type: 'uniform' } },
        ]
    }));

    Logger.info(`[WebGPU] Terrain bind group layouts created: count=${layouts.length} chunkFormats=${JSON.stringify(chunkFormats)}`);
    return layouts;
}

_buildClusterBindGroup(material, uniforms) {
    const clusterBuffers = uniforms._clusterBuffers?.value;
    const dummy = this._getOrCreateDummyStorageBuffer();

    const lightBuf   = clusterBuffers?.lightBuffer    || dummy;
    const clusterBuf = clusterBuffers?.clusterBuffer  || dummy;
    const indexBuf   = clusterBuffers?.lightIndexBuffer || dummy;
    const paramBuf   = clusterBuffers?.paramBuffer;

    // Param buffer needs to be a real uniform; fall back to a small zero buffer
    const paramGpu = paramBuf || this._getOrCreateUniformBuffer(
        '_cluster_params_dummy', new Float32Array(16)
    );

    const layout = material._gpuPipeline.bindGroupLayouts[4];
    if (!layout) return null;

    return this.device.createBindGroup({
        label: 'Terrain-ClusteredLights',
        layout,
        entries: [
            { binding: 0, resource: { buffer: lightBuf   } },
            { binding: 1, resource: { buffer: clusterBuf } },
            { binding: 2, resource: { buffer: indexBuf   } },
            { binding: 3, resource: { buffer: paramGpu   } },
        ]
    });
}

_createShadowLayouts() {
        const layouts = [];
    layouts.push(this.device.createBindGroupLayout({
        entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }
            ]
        }));
    return layouts;
}

_buildLayoutsFromSpec(spec) {
    return spec.map((group, idx) => this.device.createBindGroupLayout({
        label: group.label || `CustomGroup${idx}`,
    entries: group.entries.map(e => ({
        binding: e.binding,
        visibility: this._mapVisibility(e.visibility),
        buffer: e.buffer,
        sampler: e.sampler,
        texture: e.texture
            }))
        }));
}

_mapVisibility(v) {
    if (!v) return GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    if (typeof v === 'number') return v;
        const parts = Array.isArray(v) ? v : v.toString().toLowerCase().split('|');
    let mask = 0;
    for (const p of parts) {
        if (p.includes('vertex')) mask |= GPUShaderStage.VERTEX;
        if (p.includes('fragment')) mask |= GPUShaderStage.FRAGMENT;
        if (p.includes('compute')) mask |= GPUShaderStage.COMPUTE;
    }
    return mask || (GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT);
}

_createBindGroups(material, uniforms, geometry = null) {
        const groups = [];
        const materialName = (material.name || '').toLowerCase();

    if (materialName.includes('instanceddebug') && material.bindGroupLayoutSpec) {
            const packed = this._packDebugUniforms(uniforms);
            const buf = this._getOrCreateUniformBuffer(`instanced_${material.id}`, packed);
        groups.push(this.device.createBindGroup({
            layout: material._gpuPipeline.bindGroupLayouts[0],
            entries: [{ binding: 0, resource: { buffer: buf } }]
            }));
        return groups;
    }

    if (material.bindGroupLayoutSpec && !materialName.includes('orbital') && !materialName.includes('sphere')) {
        return this._createBindGroupsFromSpec(material, uniforms);
    }

    if (materialName.includes('orbital') || materialName.includes('sphere')) {
        return this._createOrbitalSphereBindGroups(material, uniforms);
    }

    return this._createTerrainBindGroups(material, uniforms, geometry);
}

_createBindGroupsFromSpec(material, uniforms) {
        const groups = [];

        const resolveSampler = (name, samplerDesc) => {
            const explicit = (uniforms[name]?.value ?? uniforms[name]);
        if (explicit && this._samplerCache.has(explicit)) return this._samplerCache.get(explicit);
        if (samplerDesc?.type === 'nearest') return this._samplerCache.get('nearest');
        if (samplerDesc?.type === 'shadow') return this._samplerCache.get('shadow');
        if (samplerDesc?.type === 'non-filtering') return this._samplerCache.get('nearest');
        return this._samplerCache.get('linear');
    };

    material.bindGroupLayoutSpec.forEach((groupSpec, gi) => {
            const entries = [];

    for (const entry of groupSpec.entries) {
                const name = entry.name || entry.label || `binding${entry.binding}`;
        if (entry.buffer) {
                    const bufferType = entry.buffer?.type || 'uniform';
                    const wantsStorage = typeof bufferType === 'string' && bufferType.includes('storage');

                    if (wantsStorage) {
                        const storageHandle = material.storageBuffers?.[name];
                        const explicit = (uniforms[name]?.value ?? uniforms[name]);
                        const storageBuffer =
                            storageHandle?.gpuBuffer ||
                            storageHandle ||
                            explicit?.gpuBuffer ||
                            explicit ||
                            this._getOrCreateDummyStorageBuffer();

                        entries.push({ binding: entry.binding, resource: { buffer: storageBuffer } });
                    } else {
                        const data = this._resolveUniformData(uniforms, name);
                        const buf = this._getOrCreateUniformBuffer(`${material.id}_g${gi}_b${entry.binding}`, data);
                        entries.push({ binding: entry.binding, resource: { buffer: buf } });
                    }
        } else if (entry.texture) {
                    const tex = this._resolveUniformTexture(uniforms, name);
                    const viewDimension = entry.texture.viewDimension || '2d';
            let view = null;
            // Check if tex is a GPUTextureView (native WebGPU object)
                    const isGPUTextureView = tex && (
                tex._isGPUTextureView ||
                    tex.constructor?.name === 'GPUTextureView' ||
                tex[Symbol.toStringTag] === 'GPUTextureView' ||
                (tex.label !== undefined && typeof tex.label === 'string' && !tex._gpuTexture)
                    );
            if (isGPUTextureView) {
                view = tex._isGPUTextureView ? tex.view : tex;
            } else if (tex?._gpuTexture?.texture) {
                        const viewKey = `_view_${viewDimension}`;
                if (!tex._gpuTexture[viewKey]) {
                    try {
                        tex._gpuTexture[viewKey] = tex._gpuTexture.texture.createView({ dimension: viewDimension });
                    } catch (_) {}
                }
                view = tex._gpuTexture[viewKey];
            }
            if (!view) {
                if (viewDimension === '3d') {
                    view = this._getOrCreateDummy3DTextureView();
                } else if (viewDimension === '2d-array') {
                    view = this._getOrCreateDummyArrayTextureView();
                } else {
                    view = this._getOrCreateDummyTextureView();
                }
            }
            entries.push({ binding: entry.binding, resource: view });
        } else if (entry.sampler) {
            entries.push({ binding: entry.binding, resource: resolveSampler(name, entry.sampler) });
        }
    }

    groups.push(this.device.createBindGroup({
        layout: material._gpuPipeline.bindGroupLayouts[gi],
        entries
            }));
        });

    return groups;
}

_resolveUniformData(uniforms, name) {
    let data = name ? (uniforms[name]?.value ?? uniforms[name]) : null;
    if (data instanceof Float32Array) return data;
    if (data?.elements) return new Float32Array(data.elements);
    if (Array.isArray(data)) return new Float32Array(data);
    if (typeof data === 'number') return new Float32Array([data, 0, 0, 0]);
    return new Float32Array(16);
}

_resolveUniformTexture(uniforms, name) {
        const tex = name ? (uniforms[name]?.value ?? uniforms[name]) : null;
    if (tex && tex._gpuTexture) return tex;
    return tex;
}

_getMaterialBindGroupCache(material) {
    let entry = this._bindGroupCache.get(material);
    if (!entry) {
        entry = { pipeline: material._gpuPipeline, groups: new Map() };
        this._bindGroupCache.set(material, entry);
    } else if (entry.pipeline !== material._gpuPipeline) {
        entry.pipeline = material._gpuPipeline;
        entry.groups.clear();
    }
    return entry.groups;
}

_getGeometryBindGroupCache(geometry) {
    if (!geometry) return new Map();
    if (!geometry._bindGroupCache) geometry._bindGroupCache = new Map();
    return geometry._bindGroupCache;
}

_buildTextureKey(uniforms, names) {
    return names.map(name => {
            const tex = uniforms[name]?.value ?? uniforms[name];
    return tex?.id ?? 0;
        }).join('|');
}

// In webgpuBackend.js, update _createOrbitalSphereBindGroups()

_createOrbitalSphereBindGroups(material, uniforms) {
    const materialCache = this._getMaterialBindGroupCache(material);

    const vertU = this._getOrCreateUniformBuffer(`vert_orbital_${material.id}`, this._packVertexUniforms(uniforms));
    const fragU = this._getOrCreateUniformBuffer(`frag_orbital_${material.id}`, this._packFragmentUniforms(uniforms));

    const planetTex = uniforms.planetTexture?.value;
    const normalTex = uniforms.planetNormalMap?.value;
    
    const texID = planetTex ? (planetTex.id || planetTex.uuid || 'valid') : 'dummy';
    const normalID = normalTex ? (normalTex.id || normalTex.uuid || 'valid') : 'dummy';
    const cacheKey = `orbital_groups_${texID}_${normalID}`;

    if (materialCache.has(cacheKey)) {
        return materialCache.get(cacheKey);
    }

    const groups = [];

    // Group 0: Uniforms
    const group0 = this.device.createBindGroup({
        label: 'OrbitalSphere-BindGroup0',
        layout: material._gpuPipeline.bindGroupLayouts[0],
        entries: [
    { binding: 0, resource: { buffer: vertU } },
    { binding: 1, resource: { buffer: fragU } }
        ]
    });
    groups.push(group0);

    // Group 1: Textures
    let colorTextureView = null;
    if (planetTex && planetTex._gpuTexture && planetTex._gpuTexture.texture) {
        if (!planetTex._gpuTexture._view_2d) {
            try {
                planetTex._gpuTexture._view_2d = planetTex._gpuTexture.texture.createView({ dimension: '2d' });
            } catch (e) {}
        }
        colorTextureView = planetTex._gpuTexture._view_2d;
    }
    if (!colorTextureView) {
        colorTextureView = this._getOrCreateDummyTextureView();
    }

    let normalTextureView = null;
    if (normalTex && normalTex._gpuTexture && normalTex._gpuTexture.texture) {
        if (!normalTex._gpuTexture._view_2d) {
            try {
                normalTex._gpuTexture._view_2d = normalTex._gpuTexture.texture.createView({ dimension: '2d' });
            } catch (e) {}
        }
        normalTextureView = normalTex._gpuTexture._view_2d;
    }
    if (!normalTextureView) {
        normalTextureView = this._getOrCreateDummyTextureView();
    }

    const sampler = this._samplerCache.get('linear');

    const group1 = this.device.createBindGroup({
        label: 'OrbitalSphere-BindGroup1',
        layout: material._gpuPipeline.bindGroupLayouts[1],
        entries: [
    { binding: 0, resource: colorTextureView },
    { binding: 1, resource: sampler },
    { binding: 2, resource: normalTextureView }
        ]
    });
    groups.push(group1);

    materialCache.set(cacheKey, groups);
    return groups;
}
_packOrbitalVertexUniforms(uniforms) {
        const data = new Float32Array(64);
    let offset = 0;

        const writeMat = (m) => {
    if (m?.elements) {
        data.set(m.elements, offset);
    } else {
        data.set([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1], offset);
    }
    offset += 16;
        };

    writeMat(uniforms.modelMatrix?.value);
    writeMat(uniforms.viewMatrix?.value);
    writeMat(uniforms.projectionMatrix?.value);

        const origin = uniforms.planetOrigin?.value;
    data[offset++] = origin?.x ?? 0;
    data[offset++] = origin?.y ?? 0;
    data[offset++] = origin?.z ?? 0;
    data[offset++] = uniforms.planetRadius?.value ?? 50000;

    return data;
}

_packOrbitalFragmentUniforms(uniforms) {
        const data = new Float32Array(16);
    let offset = 0;

        const sunDir = uniforms.sunDirection?.value;
    data[offset++] = sunDir?.x ?? 0.5;
    data[offset++] = sunDir?.y ?? 0.5;
    data[offset++] = sunDir?.z ?? 0.5;
    data[offset++] = uniforms.opacity?.value ?? 1.0;

        const camPos = uniforms.cameraPosition?.value;
    data[offset++] = camPos?.x ?? 0.0;
    data[offset++] = camPos?.y ?? 0.0;
    data[offset++] = camPos?.z ?? 0.0;
    data[offset++] = uniforms.atmospherePlanetRadius?.value ?? uniforms.planetRadius?.value ?? 50000;

    data[offset++] = uniforms.atmosphereRadius?.value ?? 60000;
    data[offset++] = uniforms.atmosphereMieScattering?.value ?? 21e-5;
    data[offset++] = 0.0;
    data[offset++] = 0.0;

        const rayleigh = uniforms.atmosphereRayleighScattering?.value;
    data[offset++] = rayleigh?.x ?? 5.5e-5;
    data[offset++] = rayleigh?.y ?? 13.0e-5;
    data[offset++] = rayleigh?.z ?? 22.4e-5;
    data[offset++] = 0.0;

    return data;
}

_getOrCreateDummyDepthTextureView() {
    if (!this._dummyDepthTexture) {
        this._dummyDepthTexture = this.device.createTexture({
            label: 'DummyDepthTexture',
            size: [1, 1],
            format: 'depth32float',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
        });
        this._dummyDepthTextureView = this._dummyDepthTexture.createView();

        // Clear the dummy depth texture to 1.0
        const enc = this.device.createCommandEncoder();
        const pass = enc.beginRenderPass({
            colorAttachments: [],
            depthStencilAttachment: {
                view: this._dummyDepthTextureView,
                depthClearValue: 1.0,
                depthLoadOp: 'clear',
                depthStoreOp: 'store'
            }
        });
        pass.end();
        this.device.queue.submit([enc.finish()]);
    }
    return this._dummyDepthTextureView;
}

_getOrCreateDefaultComparisonSampler() {
    if (!this._samplerCache.has('shadow-comparison')) {
        this._samplerCache.set('shadow-comparison', this.device.createSampler({
            compare: 'less',
            magFilter: 'linear',
            minFilter: 'linear',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge'
        }));
    }
    return this._samplerCache.get('shadow-comparison');
}
_createTerrainBindGroups(material, uniforms, geometry) {
        const groups = [];
        const materialCache = this._getMaterialBindGroupCache(material);
        const geometryCache = this._getGeometryBindGroupCache(geometry);
        const needArray = !!material.defines?.USE_TEXTURE_ARRAYS;
        const ensureView = (tex, dimension) => {
        if (tex && tex._gpuTexture) {
                const depth = tex.depth || tex._gpuTexture.texture?.depthOrArrayLayers || 1;
                const isArray = depth > 1 || tex._isArray;
            if (dimension === '2d-array' && !isArray) {
                return null;
            }
                const wantDimension = dimension || (needArray && isArray ? '2d-array' : '2d');
                const viewKey = `_view_${wantDimension}`;
            if (!tex._gpuTexture[viewKey]) {
                try {
                        const viewDesc = { dimension: wantDimension };
                    if (wantDimension === '2d' && isArray) {
                        viewDesc.baseArrayLayer = 0;
                        viewDesc.arrayLayerCount = 1;
                    }
                    tex._gpuTexture[viewKey] = tex._gpuTexture.texture.createView(viewDesc);
                } catch (_) {}
            }
            if (tex._gpuTexture[viewKey]) return tex._gpuTexture[viewKey];
        }
        return null;
    };
        const getView = (name, dimension) => {
            const tex = uniforms[name]?.value;
            const view = ensureView(tex, dimension);
        if (view) return view;
        if (dimension === '2d-array') return this._getOrCreateDummyArrayTextureView();
        return this._getOrCreateDummyTextureView();
    };

        const vertKey = `vert_${material.id}`;
        const fragKey = `frag_${material.id}`;
        const vertU = this._getOrCreateUniformBuffer(vertKey, this._packVertexUniforms(uniforms));
        const fragU = this._getOrCreateUniformBuffer(fragKey, this._packFragmentUniforms(uniforms));

    let g0Record = materialCache.get('terrain_g0');
    if (!g0Record || g0Record.vert !== vertU || g0Record.frag !== fragU) {
            const group = this.device.createBindGroup({
            layout: material._gpuPipeline.bindGroupLayouts[0],
            entries: [
        { binding: 0, resource: { buffer: vertU } },
        { binding: 1, resource: { buffer: fragU } }
                ]
            });
        g0Record = { group, vert: vertU, frag: fragU };
        materialCache.set('terrain_g0', g0Record);
    }


    
    groups.push(g0Record.group);

        const chunkTextureNames = [...this._chunkTextureNames];
        if (material.defines?.USE_TERRAIN_AO || material.defines?.USE_GROUND_FIELD) {
            chunkTextureNames.push('terrainAOMask');
        }
        if (material.defines?.USE_GROUND_FIELD) {
            chunkTextureNames.push('groundFieldMask');
        }
        const g1Key = this._buildTextureKey(uniforms, chunkTextureNames);
        const g1CacheKey = `terrain_g1_${needArray ? 'arr' : '2d'}_${g1Key}`;
        const g1ViewDimension = needArray ? '2d-array' : '2d';
        const g1Views = chunkTextureNames.map(name => getView(name, g1ViewDimension));
    let g1Record = geometryCache.get(g1CacheKey);
        const g1ViewsChanged = g1Record?.views?.some((view, idx) => view !== g1Views[idx]);
        const g1PipelineChanged = g1Record?.pipeline !== material._gpuPipeline;
    const shouldLogNewQt = !this._newQtTerrainBindLog || g1ViewsChanged || !g1Record;

    if (!g1Record || g1Record.key !== g1Key || g1ViewsChanged || g1PipelineChanged) {
            const entries = g1Views.map((view, i) => ({ binding: i, resource: view }));
            const group = this.device.createBindGroup({
            layout: material._gpuPipeline.bindGroupLayouts[1],
            entries
            });
        g1Record = { group, key: g1Key, views: g1Views, pipeline: material._gpuPipeline };
        geometryCache.set(g1CacheKey, g1Record);
    }
    groups.push(g1Record.group);

        const g2Key = this._buildTextureKey(uniforms, this._atlasTextureNames);
        const g2CacheKey = `terrain_g2_${needArray ? 'arr' : '2d'}_${g2Key}`;
    let g2Record = materialCache.get(g2CacheKey);
    const g2Views = [
        getView('atlasTexture',       '2d-array'),   // ← was '2d'
        getView('level2AtlasTexture', '2d-array'),   // ← was '2d'
        getView('tileTypeLookup',     '2d'),
        getView('macroTileTypeLookup','2d'),
        getView('numVariantsTex',     '2d'),
    ];
    const blendModeView = getView('blendModeTable', '2d');

    const g2ViewsChanged = g2Record?.views?.some((view, idx) => view !== g2Views[idx]);
    if (!g2Record || g2ViewsChanged) {
        const entries = [
            { binding: 0, resource: g2Views[0] },
            { binding: 1, resource: g2Views[1] },
            { binding: 2, resource: g2Views[2] },
            { binding: 3, resource: g2Views[3] },
            { binding: 4, resource: g2Views[4] },
            { binding: 5, resource: this._samplerCache.get('linear-repeat') },
            { binding: 6, resource: this._samplerCache.get('nearest') },
            { binding: 7, resource: blendModeView },
            { binding: 8, resource: this._samplerCache.get('linear') },  // ← clamp, trilinear
        ];
        const group = this.device.createBindGroup({
            layout: material._gpuPipeline.bindGroupLayouts[2],
            entries
        });
        g2Record = { group, key: g2Key, views: g2Views };
        materialCache.set(g2CacheKey, g2Record);
    }
    groups.push(g2Record.group);
    
    const storageHandle = material.storageBuffers?.chunkInstances;
    const storageBuffer = storageHandle?.gpuBuffer || storageHandle || this._getOrCreateDummyStorageBuffer();
    const g3Key = this._buildTextureKey(uniforms, ['transmittanceLUT']);
    const g3View = getView('transmittanceLUT', '2d');

    // Get cluster buffers (or dummies)
    const clusterBuffers = uniforms._clusterBuffers?.value;
    const dummyStorage = this._getOrCreateDummyStorageBuffer();
    const dummyUniform = this._getOrCreateUniformBuffer('_cluster_params_dummy', new Float32Array(16));

    const lightBuf   = clusterBuffers?.lightBuffer      || dummyStorage;
    const clusterBuf = clusterBuffers?.clusterBuffer    || dummyStorage;
    const indexBuf   = clusterBuffers?.lightIndexBuffer || dummyStorage;
    const paramBuf   = clusterBuffers?.paramBuffer      || dummyUniform;


    // Shadow resources
    const shadowRenderer = uniforms._shadowRenderer?.value;
    const dummyDepthView = this._getOrCreateDummyDepthTextureView();
    const shadowCascade0 = shadowRenderer?.getShadowDepthView(0) || dummyDepthView;
    const shadowCascade1 = shadowRenderer?.getShadowDepthView(1) || dummyDepthView;
    const shadowCascade2 = shadowRenderer?.getShadowDepthView(2) || dummyDepthView;
    const shadowSampler = shadowRenderer?.getComparisonSampler() ||
        this._samplerCache.get('shadow-comparison') ||
        this._getOrCreateDefaultComparisonSampler();
    const shadowUniformBuf = shadowRenderer?.getCascadeUniformBuffer() || dummyUniform;

    const clusterKey = clusterBuffers ? 'real' : 'dummy';

    // Build cache key including shadow state
    const shadowKey = shadowRenderer ? 'shadow' : 'noshadow';
    const g3CacheKey = `terrain_g3_${needArray ? 'arr' : '2d'}_${g3Key}_${clusterKey}_${shadowKey}`;

    let g3Record = materialCache.get(g3CacheKey);
    const g3PipelineChanged = g3Record?.pipeline !== material._gpuPipeline;
    const g3ViewChanged = g3Record?.view !== g3View;
    const g3BufferChanged = g3Record?.buffer !== storageBuffer;

    if (!g3Record || g3ViewChanged || g3BufferChanged || g3PipelineChanged) {
        const entries = [
            { binding: 0, resource: { buffer: storageBuffer } },
            { binding: 7, resource: g3View },
            { binding: 8, resource: this._samplerCache.get('linear') },
            { binding: 1, resource: { buffer: lightBuf } },
            { binding: 2, resource: { buffer: clusterBuf } },
            { binding: 3, resource: { buffer: indexBuf } },
            { binding: 4, resource: { buffer: paramBuf } },
            // Shadow entries
            { binding: 5,  resource: shadowCascade0 },
            { binding: 6,  resource: shadowCascade1 },
            { binding: 9,  resource: shadowCascade2 },
            { binding: 10, resource: shadowSampler },
            { binding: 11, resource: { buffer: shadowUniformBuf } },
        ];
        const group = this.device.createBindGroup({
            layout: material._gpuPipeline.bindGroupLayouts[3],
            entries
        });
        g3Record = {
            group,
            key: g3Key,
            view: g3View,
            buffer: storageBuffer,
            pipeline: material._gpuPipeline
        };
        materialCache.set(g3CacheKey, g3Record);
    }
    groups.push(g3Record.group);
    return groups;
}

_packVertexUniforms(uniforms) {
    // Fixed-size packing for terrain uniforms (80 floats / 320 bytes), including useInstancing slot
        const data = this._terrainVertexUniformScratch.f32;
        const intView = this._terrainVertexUniformScratch.i32;
    let offset = 0;

        const writeMat = (m) => {
    if (m && m.elements) {
        data.set(m.elements, offset);
    } else {
        data.set([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1], offset);
    }
    offset += 16;
        };

    writeMat(uniforms.modelMatrix?.value);
    writeMat(uniforms.viewMatrix?.value);
    writeMat(uniforms.projectionMatrix?.value);

    data[offset++] = uniforms.chunkOffset?.value?.x || 0;
    data[offset++] = uniforms.chunkOffset?.value?.y || 0;
    data[offset++] = uniforms.chunkSize?.value || 128;
    data[offset++] = uniforms.macroScale?.value || 0.25;

    data[offset++] = uniforms.planetRadius?.value || 50000;
    data[offset++] = 0;
    data[offset++] = 0;
    data[offset++] = 0;

        const origin = uniforms.planetOrigin?.value;
    data[offset++] = origin?.x || 0;
    data[offset++] = origin?.y || 0;
    data[offset++] = origin?.z || 0;
    data[offset++] = 0;

    intView[offset] = (uniforms.chunkFace?.value ?? -1);
    offset++;
    data[offset++] = 0;
    data[offset++] = uniforms.chunkLocation?.value?.x || 0;
    data[offset++] = uniforms.chunkLocation?.value?.y || 0;
    data[offset++] = uniforms.chunkSizeUV?.value || 0.0625;

    data[offset++] = uniforms.useAtlasMode?.value || 0;
    data[offset++] = uniforms.atlasUVOffset?.value?.x || 0;
    data[offset++] = uniforms.atlasUVOffset?.value?.y || 0;
    data[offset++] = uniforms.atlasUVScale?.value || 1.0;
    data[offset++] = uniforms.useInstancing?.value || 0;

    data[offset++] = requireNumber(uniforms.heightScale?.value, 'uniforms.heightScale');
        const atlasSizeVal = uniforms.atlasTextureSize?.value;
    data[offset++] = typeof atlasSizeVal === 'object' ? (atlasSizeVal?.x || atlasSizeVal?.width || 129) : (atlasSizeVal || 129);
    data[offset++] = requireInt(uniforms.chunksPerFace?.value, 'uniforms.chunksPerFace', 1);
    data[offset++] = 0; // _pad5

    // geometryLOD, lodMorph fields (offsets 74-77)
    intView[offset] = uniforms.geometryLOD?.value ?? 0;
    offset++;
    data[offset++] = uniforms.lodMorphStart?.value ?? 0.7;
    data[offset++] = uniforms.lodMorphEnd?.value ?? 0.9;
    data[offset++] = 0; // _padMorph

    // cameraPosition + pad (offsets 78-81)
        const camPos = uniforms.cameraPosition?.value;
    data[offset++] = camPos?.x ?? 0;
    data[offset++] = camPos?.y ?? 0;
    data[offset++] = camPos?.z ?? 0;
    data[offset++] = 0; // _pad6

    return data;
}


_packFragmentUniforms(uniforms) {
        const f32 = this._terrainFragmentUniformScratch.f32;
        const i32 = this._terrainFragmentUniformScratch.i32;
    
        const cam = uniforms.cameraPosition?.value;
    f32[0] = cam?.x ?? 0;
    f32[1] = cam?.y ?? 0;
    f32[2] = cam?.z ?? 0;
    f32[3] = uniforms.time?.value ?? 0;

    f32[4] = uniforms.chunkOffset?.value?.x ?? 0;
    f32[5] = uniforms.chunkOffset?.value?.y ?? 0;
    f32[6] = uniforms.chunkWidth?.value ?? uniforms.chunkSize?.value ?? 128;
    f32[7] = uniforms.chunkHeight?.value ?? uniforms.chunkSize?.value ?? 128;
    
        const sunDir = uniforms.sunLightDirection?.value;
    f32[8] = sunDir?.x ?? 0;
    f32[9] = sunDir?.y ?? 1;
    f32[10] = sunDir?.z ?? 0;
    f32[11] = uniforms.sunLightIntensity?.value ?? 1.0; // ADD: Sun intensity
    
        const sunCol = uniforms.sunLightColor?.value;
        f32[12] = sunCol?.r ?? 1;
        f32[13] = sunCol?.g ?? 1;
        f32[14] = sunCol?.b ?? 1;
        f32[15] = uniforms.terrainAODirectStrength?.value ?? 0.55; 
        const amb = uniforms.ambientLightColor?.value;
    f32[16] = amb?.r ?? 0.3;
    f32[17] = amb?.g ?? 0.3;
    f32[18] = amb?.b ?? 0.4;
    f32[19] = uniforms.ambientLightIntensity?.value ?? 0.8; // CHANGE: This should be intensity, not enableSplatLayer

    f32[20] = uniforms.enableSplatLayer?.value ?? 1; // MOVE: enableSplatLayer here
    f32[21] = uniforms.enableMacroLayer?.value ?? 1; // SHIFT: Move everything down
    i32[22] = uniforms.geometryLOD?.value ?? 0;
    i32[23] = uniforms.currentSeason?.value ?? 0;

    i32[24] = uniforms.nextSeason?.value ?? 1;
    f32[25] = uniforms.seasonTransition?.value ?? 0;
    const atlasSize = uniforms.atlasTextureSize?.value;
    f32[26] = typeof atlasSize === 'object'
            ? (atlasSize?.x ?? atlasSize?.width ?? 1024)
            : (atlasSize ?? 1024);
    f32[27] = uniforms.terrainAOStrength?.value ?? 1.0;  
    
        const atlasOffset = uniforms.atlasUVOffset?.value;
    f32[28] = atlasOffset?.x ?? 0;
    f32[29] = atlasOffset?.y ?? 0;
    f32[30] = uniforms.atlasUVScale?.value ?? 1;
    i32[31] = uniforms.useAtlasMode?.value ?? 0;

    f32[32] = uniforms.isFeature?.value ?? 0;
    f32[33] = uniforms.aerialPerspectiveEnabled?.value ?? 1.0;
    f32[34] = uniforms.macroScale?.value ?? 0.25;
    i32[35] = uniforms.macroMaxLOD?.value ?? 0;
    
        const planetCenter = uniforms.planetCenter?.value;
    f32[36] = planetCenter?.x ?? 0;
    f32[37] = planetCenter?.y ?? 0;
    f32[38] = planetCenter?.z ?? 0;
    f32[39] = uniforms.atmospherePlanetRadius?.value ?? 50000;

    f32[40] = uniforms.atmosphereRadius?.value ?? 60000;
    f32[41] = uniforms.atmosphereScaleHeightRayleigh?.value ?? 800;
    f32[42] = uniforms.atmosphereScaleHeightMie?.value ?? 120;
    f32[43] = uniforms.atmosphereMieAnisotropy?.value ?? 0.8;
    
        const rayleigh = uniforms.atmosphereRayleighScattering?.value;
    f32[44] = rayleigh?.x ?? 5.5e-5;
    f32[45] = rayleigh?.y ?? 13.0e-5;
    f32[46] = rayleigh?.z ?? 22.4e-5;
    f32[47] = uniforms.atmosphereMieScattering?.value ?? 21e-5;

    f32[48] = uniforms.atmosphereSunIntensity?.value ?? 20.0;
    f32[49] = uniforms.fogDensity?.value ?? 0.00005;
    f32[50] = uniforms.fogScaleHeight?.value ?? 1200;
    f32[51] = uniforms.level2Blend?.value ?? 0.7;

    const fogCol = uniforms.fogColor?.value;
    f32[52] = fogCol?.r ?? 0.7;
    f32[53] = fogCol?.g ?? 0.8;
    f32[54] = fogCol?.b ?? 1.0;
    f32[55] = uniforms.macroNoiseWeight?.value ?? 0.5;
    i32[56] = uniforms.terrainDebugMode?.value ?? 0;
    i32[57] = uniforms.terrainLayerViewMode?.value ?? 0;
    i32[58] = 0;
    i32[59] = 0;

    i32[60] = uniforms.terrainHoverFace?.value ?? -1;
    i32[61] = uniforms.terrainHoverFlags?.value ?? 0;
    f32[62] = 0.0;
    f32[63] = 0.0;

    const microRect = uniforms.terrainHoverMicroRect?.value;
    f32[64] = microRect?.x ?? 0.0;
    f32[65] = microRect?.y ?? 0.0;
    f32[66] = microRect?.z ?? 0.0;
    f32[67] = microRect?.w ?? 0.0;

    const macroRect = uniforms.terrainHoverMacroRect?.value;
    f32[68] = macroRect?.x ?? 0.0;
    f32[69] = macroRect?.y ?? 0.0;
    f32[70] = macroRect?.z ?? 0.0;
    f32[71] = macroRect?.w ?? 0.0;

    const microColor = uniforms.terrainHoverMicroColor?.value;
    f32[72] = microColor?.x ?? 1.0;
    f32[73] = microColor?.y ?? 0.42;
    f32[74] = microColor?.z ?? 0.42;
    f32[75] = microColor?.w ?? 1.5;

    const macroColor = uniforms.terrainHoverMacroColor?.value;
    f32[76] = macroColor?.x ?? 0.42;
    f32[77] = macroColor?.y ?? 0.64;
    f32[78] = macroColor?.z ?? 1.0;
    f32[79] = macroColor?.w ?? 2.0;

    return f32;
}
_packDebugUniforms(uniforms) {
        const data = new Float32Array(32);
    let offset = 0;
        const writeMat = (m) => {
    if (m?.elements) data.set(m.elements, offset);
            else data.set([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1], offset);
    offset += 16;
        };
    writeMat(uniforms.viewMatrix?.value);
    writeMat(uniforms.projectionMatrix?.value);
    return data;
}

_getOrCreateBuffer(name, data) { return this._getOrCreateUniformBuffer(name, data); }

_getOrCreateUniformBuffer(name, data) {
        const alignedSize = Math.ceil(data.byteLength / 256) * 256;
        const key = name;
    let record = this._bufferCache.get(key);
    if (!record || record.size < alignedSize) {
        if (record?.gpuBuffer) this._pendingBufferDestroys.push(record.gpuBuffer);
            const buffer = this.device.createBuffer({ size: alignedSize, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        record = { gpuBuffer: buffer, size: alignedSize };
        this._bufferCache.set(key, record);
    }
    this.device.queue.writeBuffer(record.gpuBuffer, 0, data);
    return record.gpuBuffer;
}

_ensureTexturesUploaded(uniforms) {
        const check = (name) => {
    if (this._textureUploadSkip.has(name)) return;
            const tex = uniforms[name]?.value;
    if (!tex) return;

    if (tex._gpuTexture && tex._gpuTexture.texture && tex._gpuTexture.view) {
        return;
    }

    if (tex._needsUpload && (tex.data || tex.image)) {
        this.updateTexture(tex);
    } else if (!tex._gpuTexture) {

    }
        };

    this._chunkTextureNames.forEach(check);
    this._atlasTextureNames.forEach(check);
    this._lightingTextureNames.forEach(check);
    check('planetTexture');
}


draw(geometry, material, uniforms = {}) {
    if (!this._renderPassEncoder) this.clear(true, true, false);
        if (material._needsCompile || !material._gpuPipeline) this.compileShader(material);
    
        const allUniforms = { ...material.uniforms, ...uniforms };
    this._ensureTexturesUploaded(allUniforms);
    
        this._renderPassEncoder.setPipeline(material._gpuPipeline.pipeline);
    
        const bindGroups = this._createBindGroups(material, allUniforms, geometry);
        bindGroups.forEach((bg, i) => this._renderPassEncoder.setBindGroup(i, bg));

    // CRITICAL FIX: Set vertex buffers based on what the shader expects
    const vertexLayouts = material._gpuPipeline.vertexBufferLayouts || material.vertexLayout;
        
        if (vertexLayouts) {
    // Use the explicit vertex layout from the material
    for (let slot = 0; slot < vertexLayouts.length; slot++) {
    const layout = vertexLayouts[slot];

// Map slot to attribute name based on shader location
let attributeName = null;
                if (layout.attributes && layout.attributes[0]) {
    const location = layout.attributes[0].shaderLocation;
// Standard mapping
                    switch(location) {
    case 0: attributeName = 'position'; break;
    case 1: attributeName = 'normal'; break;
    case 2: attributeName = 'uv'; break;
    case 3: attributeName = 'color'; break;
default:
    // Check for instance attributes
    if (layout.stepMode === 'instance') {
attributeName = `instanceData${location - 3}`;
    }
    break;
    }
    }

    if (attributeName) {
    const attr = geometry.attributes.get(attributeName);
                    if (attr) {
    if (attr.gpuBuffer) {
    const offset = attr.gpuBufferOffset || 0;
    this._renderPassEncoder.setVertexBuffer(slot, attr.gpuBuffer, offset);
                        } else if (attr.data) {
    const buf = this._getOrCreateAttributeBuffer(geometry, attr.data, false, attributeName);
                            this._renderPassEncoder.setVertexBuffer(slot, buf.gpuBuffer);
                        }
                            } else {
                            // CRITICAL: Create dummy buffer for missing attributes
                            // This prevents the validation error
                            const dummyBuffer = this._getOrCreateDummyVertexBuffer(layout.arrayStride || 16);
                        this._renderPassEncoder.setVertexBuffer(slot, dummyBuffer);
                    }
                        }
                        }
                        } else {
                        // Fallback to old method (shouldn't happen with proper materials)

                        const setVBuf = (slot, attr, name) => {
    if (attr) {
    if (attr.gpuBuffer) {
    const offset = attr.gpuBufferOffset || 0;
    this._renderPassEncoder.setVertexBuffer(slot, attr.gpuBuffer, offset);
                    } else {
                        const buf = this._getOrCreateAttributeBuffer(geometry, attr.data, false, name);
                        this._renderPassEncoder.setVertexBuffer(slot, buf.gpuBuffer);
                    }
                        }
                        };
setVBuf(0, geometry.attributes.get('position'), 'position');
setVBuf(1, geometry.attributes.get('normal'), 'normal');
setVBuf(2, geometry.attributes.get('uv'), 'uv');
    }

// Handle drawing
let count = geometry.drawRange.count;
        if (count === Infinity) {
    if (geometry.index) count = geometry.index.count;
            else if (geometry.attributes.get('position')) count = geometry.attributes.get('position').count;
            else count = 0;
    }

    if (count === 0) {
geometry._needsUpload = false;
    return;
    }

    const instanceCount = geometry.instanceCount || 1;
    const instanceStart = geometry.instanceStart || 0;

    if (geometry.index) {
    const iBuf = this._getOrCreateAttributeBuffer(geometry, geometry.index.data, true, 'index');
            this._renderPassEncoder.setIndexBuffer(iBuf.gpuBuffer, geometry.index.data instanceof Uint32Array ? 'uint32' : 'uint16');
            this._renderPassEncoder.drawIndexed(count, instanceCount, geometry.drawRange.start, 0, instanceStart);
        } else {
            this._renderPassEncoder.draw(count, instanceCount, geometry.drawRange.start, instanceStart);
        }

geometry._needsUpload = false;
    }

// Add this helper method to WebGPUBackend:
_getOrCreateDummyVertexBuffer(size = 16) {
        const key = `dummy_vertex_${size}`;
    if (!this._bufferCache.has(key)) {
            const buffer = this.device.createBuffer({
            size: size,
            usage: GPUBufferUsage.VERTEX,
            mappedAtCreation: true
            });
        // Fill with zeros
        new Float32Array(buffer.getMappedRange()).fill(0);
        buffer.unmap();
        this._bufferCache.set(key, { gpuBuffer: buffer, size });
    }
    return this._bufferCache.get(key).gpuBuffer;
}

drawIndexedIndirect(geometry, material, indirectBuffer, indirectOffset = 0, uniforms = {}) {
    if (!this._renderPassEncoder) this.clear(true, true, false);
    if (material._needsCompile || !material._gpuPipeline) this.compileShader(material);

    const allUniforms = { ...material.uniforms, ...uniforms };
    this._ensureTexturesUploaded(allUniforms);

    this._renderPassEncoder.setPipeline(material._gpuPipeline.pipeline);

    const bindGroups = this._createBindGroups(material, allUniforms, geometry);
    bindGroups.forEach((bg, i) => this._renderPassEncoder.setBindGroup(i, bg));

    const vertexLayouts = material._gpuPipeline.vertexBufferLayouts || material.vertexLayout;
    if (vertexLayouts) {
        for (let slot = 0; slot < vertexLayouts.length; slot++) {
            const layout = vertexLayouts[slot];
            let attributeName = null;
            if (layout.attributes && layout.attributes[0]) {
                const location = layout.attributes[0].shaderLocation;
                switch(location) {
                    case 0: attributeName = 'position'; break;
                    case 1: attributeName = 'normal'; break;
                    case 2: attributeName = 'uv'; break;
                    case 3: attributeName = 'color'; break;
                    default:
                        if (layout.stepMode === 'instance') {
                            attributeName = `instanceData${location - 3}`;
                        }
                        break;
                }
            }
            if (attributeName) {
                const attr = geometry.attributes.get(attributeName);
                if (attr) {
                    if (attr.gpuBuffer) {
                        const offset = attr.gpuBufferOffset || 0;
                        this._renderPassEncoder.setVertexBuffer(slot, attr.gpuBuffer, offset);
                    } else if (attr.data) {
                        const buf = this._getOrCreateAttributeBuffer(geometry, attr.data, false, attributeName);
                        this._renderPassEncoder.setVertexBuffer(slot, buf.gpuBuffer);
                    }
                } else {
                    const dummyBuffer = this._getOrCreateDummyVertexBuffer(layout.arrayStride || 16);
                    this._renderPassEncoder.setVertexBuffer(slot, dummyBuffer);
                }
            }
        }
    } else {
        const setVBuf = (slot, attr, name) => {
            if (attr) {
                if (attr.gpuBuffer) {
                    const offset = attr.gpuBufferOffset || 0;
                    this._renderPassEncoder.setVertexBuffer(slot, attr.gpuBuffer, offset);
                } else {
                    const buf = this._getOrCreateAttributeBuffer(geometry, attr.data, false, name);
                    this._renderPassEncoder.setVertexBuffer(slot, buf.gpuBuffer);
                }
            }
        };
        setVBuf(0, geometry.attributes.get('position'), 'position');
        setVBuf(1, geometry.attributes.get('normal'), 'normal');
        setVBuf(2, geometry.attributes.get('uv'), 'uv');
    }

    if (!geometry.index) return;
    const iBuf = this._getOrCreateAttributeBuffer(geometry, geometry.index.data, true, 'index');
    this._renderPassEncoder.setIndexBuffer(
        iBuf.gpuBuffer,
        geometry.index.data instanceof Uint32Array ? 'uint32' : 'uint16'
    );
    this._renderPassEncoder.drawIndexedIndirect(indirectBuffer, indirectOffset);
}
_getOrCreateAttributeBuffer(geometry, data, isIndex = false, cacheKey = '') {
    if (!geometry._gpuBuffers) geometry._gpuBuffers = new Map();
        const key = cacheKey || (isIndex ? 'index' : 'attr');
    let record = geometry._gpuBuffers.get(key);

        const alignedSize = Math.ceil(data.byteLength / 4) * 4;
        const needsNewBuffer = !record || record.size < alignedSize;

    if (needsNewBuffer) {
        if (record?.gpuBuffer) this._pendingBufferDestroys.push(record.gpuBuffer);
            const usage = isIndex
            ? GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
            : GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST;
            const buffer = this.device.createBuffer({ size: alignedSize, usage });
        record = { gpuBuffer: buffer, size: alignedSize };
        geometry._gpuBuffers.set(key, record);
    }

    if (geometry._needsUpload || needsNewBuffer) {
        this.device.queue.writeBuffer(record.gpuBuffer, 0, data);
    }

    return record;
}

setRenderTarget(rt) {
    this._endCurrentRenderPass();
    if (rt) {
        if (!rt._gpuRenderTarget || rt._needsSetup) this.createRenderTarget(rt);
        this._currentRenderTarget = rt;
    } else {
        // When a default render target is set (e.g. HDR postprocessing),
        // "return to screen" actually returns to the off-screen HDR target.
        this._currentRenderTarget = this._defaultRenderTarget || null;
    }
}
// Add this new method to expose the depth texture view
getDepthTextureView() {
    return this._depthTextureView || null;
}

getDepthTexture() {
    return this._depthTexture || null;
}
createRenderTarget(rt) {
    const createView = (tex) => {
        if (!tex._gpuTexture) this.createTexture(tex);
        return tex._gpuTexture.view;
    };
    
    const cViews = rt.colorAttachments.map(createView);
    let dView = null;
    
    if (rt.depthAttachment) {
        dView = createView(rt.depthAttachment);
    } else if (rt._depthBuffer) {
        // Create a depth texture using the RT's format
        // Add TEXTURE_BINDING if the RT requests sampleable depth
        const usage = GPUTextureUsage.RENDER_ATTACHMENT | 
            (rt._sampleableDepth ? GPUTextureUsage.TEXTURE_BINDING : 0);
        
        const dTex = this.device.createTexture({ 
            size: [rt.width, rt.height], 
            format: 'depth24plus', 
            usage: usage
        });
        dView = dTex.createView();
        rt._gpuRenderTarget = { 
            colorViews: cViews, 
            depthView: dView, 
            depthTexture: dTex 
        };
        return;
    }
    
    rt._gpuRenderTarget = { colorViews: cViews, depthView: dView };
}
deleteRenderTarget(rt) {
    if (rt._gpuRenderTarget?.depthTexture) this._queueTextureDestroy(rt._gpuRenderTarget.depthTexture);
    rt._gpuRenderTarget = null;
}

clear(color = true, depth = true) {
    this._ensureCommandEncoder();
    const colorAttachments = [];
    
    let depthView = null;
    let hasDepth = false;
    
    if (this._currentRenderTarget) {
        // Use render target's depth (if any)
        depthView = this._currentRenderTarget._gpuRenderTarget?.depthView;
        hasDepth = !!depthView;
    } else {
        // Use main depth buffer
        depthView = this._depthTexture.createView();
        hasDepth = true;
    }
    
    const depthAttachment = hasDepth ? {
        view: depthView,
        depthClearValue: 1.0,
        depthLoadOp: depth ? 'clear' : 'load',
        depthStoreOp: 'store'
    } : undefined;

    if (this._currentRenderTarget) {
        this._currentRenderTarget._gpuRenderTarget.colorViews.forEach(view => {
            colorAttachments.push({
                view, 
                clearValue: this._clearColor, 
                loadOp: color ? 'clear' : 'load', 
                storeOp: 'store'
            });
        });
    } else {
        colorAttachments.push({
            view: this.context.getCurrentTexture().createView(),
            clearValue: this._clearColor, 
            loadOp: color ? 'clear' : 'load', 
            storeOp: 'store'
        });
    }

    const rpDesc = hasDepth 
        ? { colorAttachments, depthStencilAttachment: depthAttachment } 
        : { colorAttachments };
        
    this._renderPassEncoder = this._commandEncoder.beginRenderPass(rpDesc);
    this._renderPassEncoder.setViewport(
        this._viewport.x, 
        this._viewport.y, 
        this._viewport.width, 
        this._viewport.height, 
        0, 
        1
    );
}
_ensureCommandEncoder() {
    if (!this._commandEncoder) this._commandEncoder = this.device.createCommandEncoder();
}

getCommandEncoder() {
    this._ensureCommandEncoder();
    return this._commandEncoder;
}

endRenderPassForCompute() {
    this._endCurrentRenderPass();
}

resumeRenderPass() {
    if (this._renderPassEncoder) return;
    this._ensureCommandEncoder();
    
    let depthView = null;
    let hasDepth = false;
    
    if (this._currentRenderTarget) {
        depthView = this._currentRenderTarget._gpuRenderTarget?.depthView;
        hasDepth = !!depthView;
    } else {
        depthView = this._depthTexture.createView();
        hasDepth = true;
    }
    
    const depthAttachment = hasDepth ? {
        view: depthView,
        depthClearValue: 1.0,
        depthLoadOp: 'load',
        depthStoreOp: 'store'
    } : undefined;
    
    const colorAttachments = [];
    if (this._currentRenderTarget) {
        this._currentRenderTarget._gpuRenderTarget.colorViews.forEach(view => {
            colorAttachments.push({ 
                view, 
                clearValue: this._clearColor, 
                loadOp: 'load', 
                storeOp: 'store' 
            });
        });
    } else {
        colorAttachments.push({
            view: this.context.getCurrentTexture().createView(),
            clearValue: this._clearColor, 
            loadOp: 'load', 
            storeOp: 'store'
        });
    }
    
    const rpDesc = hasDepth 
        ? { colorAttachments, depthStencilAttachment: depthAttachment } 
        : { colorAttachments };
        
    this._renderPassEncoder = this._commandEncoder.beginRenderPass(rpDesc);
    this._renderPassEncoder.setViewport(
        this._viewport.x, 
        this._viewport.y, 
        this._viewport.width, 
        this._viewport.height, 
        0, 
        1
    );
}

_endCurrentRenderPass() {
    if (this._renderPassEncoder) {
        this._renderPassEncoder.end();
        this._renderPassEncoder = null;
    }
}

submitCommands() {
    this._endCurrentRenderPass();
    if (this._commandEncoder) {
        this.device.queue.submit([this._commandEncoder.finish()]);
        this._commandEncoder = null;
    }
    if (this._pendingBufferDestroys.length) {
        this._pendingBufferDestroys.forEach(buf => buf.destroy?.());
        this._pendingBufferDestroys = [];
    }
    if (this._pendingTextureDestroys.length) {
        this._pendingTextureDestroys.forEach(tex => tex.destroy?.());
        this._pendingTextureDestroys = [];
    }
}

readPixels() {

    return new Float32Array(0);
}

setClearColor(r,g,b,a) {
    this._clearColor = {r,g,b,a};
}

setViewport(x,y,w,h) {
    this._viewport = {x,y,width:w,height:h};
    // Always recreate depth texture when size changes (like reference does).
    // But first end any active render pass to avoid "destroyed texture used in submit" error.
    if (!this._depthTexture) {
        this._endCurrentRenderPass();
        this._createDepthTexture();
        return;
    }
    if (w !== this._depthTexture.width || h !== this._depthTexture.height) {
        this._endCurrentRenderPass();
        this._createDepthTexture();
    }
}

_getBytesPerPixel(format) {
    const map = {
        [TextureFormat.RGBA8]: 4,
        [TextureFormat.RGBA16F]: 8,
        [TextureFormat.RGBA32F]: 16,
        [TextureFormat.RGBA32UINT]: 16,    // NEW
        [TextureFormat.R8]: 1,
        [TextureFormat.R16F]: 2,
        [TextureFormat.R32F]: 4
    };
    return map[format] || 4;
}

_getTextureFormat(fmt) {
    const key = typeof fmt === 'string' ? fmt : fmt?.format;
    const map = {
        [TextureFormat.RGBA8]: 'rgba8unorm',
        'bgra8unorm': 'bgra8unorm',
        'bgra8': 'bgra8unorm',
        [TextureFormat.RGBA16F]: 'rgba16float',
        [TextureFormat.RGBA32F]: 'rgba32float',
        [TextureFormat.RGBA32UINT]: 'rgba32uint',  // NEW
        [TextureFormat.R8]: 'r8unorm',
        [TextureFormat.R16F]: 'r16float',
        [TextureFormat.R32F]: 'r32float',
        [TextureFormat.DEPTH24]: 'depth24plus',
        [TextureFormat.DEPTH32F]: 'depth32float',
        'rgba16float': 'rgba16float',
        'rgba16f': 'rgba16float',
        'rgba32uint': 'rgba32uint',                // NEW: passthrough
        'bgra8unorm': 'bgra8unorm'
    };
    return map[key] || 'rgba8unorm';
}

getAPIName() {
    return 'webgpu';
}

dispose() {
    if (this._depthTexture) {
        this._depthTexture.destroy();
        this._depthTexture = null;
    }

    if (this._dummyTexture) {
        this._dummyTexture.destroy();
        this._dummyTexture = null;
    }
    this._dummyTextureView = null;

    this._pendingBufferDestroys = [];
    if (this._mipmapPipelines) {
        this._mipmapPipelines.clear();
        this._mipmapPipelines = null;
    }
    for (const buffer of this._bufferCache.values()) {
        if (buffer.gpuBuffer) buffer.gpuBuffer.destroy();
    }
    this._bufferCache.clear();

    this._samplerCache.clear();
    this._pipelineCache.clear();
    this._bindGroupLayoutCache.clear();
    this._bindGroupCache.clear();
    this._pendingBufferDestroys.forEach(buf => buf.destroy?.());
    this._pendingBufferDestroys = [];
    this._pendingTextureDestroys.forEach(tex => tex.destroy?.());
    this._pendingTextureDestroys = [];

}

    _queueTextureDestroy(texture) {
        if (!texture) return;
        // Defer to end of submit to avoid "destroyed texture used in submit".
        this._pendingTextureDestroys.push(texture);
    }
}

function requireNumber(value, name) {
    if (!Number.isFinite(value)) {
        throw new Error(`WebGPUBackend missing required number: ${name}`);
    }
    return value;
}

function requireInt(value, name, min = null) {
    if (!Number.isFinite(value)) {
        throw new Error(`WebGPUBackend missing required integer: ${name}`);
    }
    const n = Math.floor(value);
    if (min !== null && n < min) {
        throw new Error(`WebGPUBackend ${name} must be >= ${min}`);
    }
    return n;
}
