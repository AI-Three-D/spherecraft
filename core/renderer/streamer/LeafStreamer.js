// js/renderer/streamer/LeafStreamer.js
//
// UPDATED - Uses CloseTreeBuffer for enhanced leaf generation.
// Mask is now sampled from a pre-baked texture atlas (LeafMaskBaker)
// instead of evaluated procedurally per-fragment. See leafRender.wgsl.js
// header for the before/after.

import { Logger } from '../../../shared/Logger.js';

import { buildLeafBudgetPrepassShader } from './shaders/leafBudgetPrepass.wgsl.js';
import { buildLeafScatterDetailedShader } from './shaders/leafScatterDetailed.wgsl.js';
import { buildLeafVertexShader, buildLeafFragmentShader } from './shaders/leafRender.wgsl.js';
import {  buildLeafDrawArgsShader } from './shaders/leafScatterDetailed.wgsl.js';
import {
    BIRCH_MASK_VARIANTS,
    SPRUCE_MASK_VARIANTS,
    SPRUCE_MASK_LAYER_OFFSET,
} from './LeafMaskBaker.js';

const INSTANCE_BYTES = 64;


export class LeafStreamer {
    /**
     * @param {GPUDevice} device
     * @param {import('./AssetStreamer.js').AssetStreamer} assetStreamer
     * @param {object} [config]
     * @param {import('./LeafMaskBaker.js').LeafMaskBaker} config.leafMaskBaker
     *        Required. Provides the pre-baked mask atlas + sampler.
     */
    constructor(device, assetStreamer, config = {}) {
        this._counterReset = new Uint32Array([0]);
        this._requestSummaryReset = new Uint32Array(8);
        this.device   = device;
        this.streamer = assetStreamer;
        this.propTextureManager = config.propTextureManager || assetStreamer?.propTextureManager || null;
        this.leafAlbedoTextureManager = config.leafAlbedoTextureManager || assetStreamer?.leafAlbedoTextureManager || null;
        this.leafNormalTextureManager = config.leafNormalTextureManager || assetStreamer?.leafNormalTextureManager || null;

        this.lodController = config.lodController;
        if (!this.lodController) {
            throw new Error('[LeafStreamer] lodController is required');
        }
        const lc = this.lodController;

        // Everything distance- and budget-related comes from the
        // controller now. The individual-field constructor knobs are
        // gone — there's one place to tune this, and it isn't here.
        this.maxLeaves     = lc.maxTotalLeaves;
        this.maxCloseTrees = lc.maxCloseTrees;
        this.leafRange     = lc.leafFadeEnd;
        this.leafFadeStart = lc.leafFadeStart;
        this.leafMinSize   = lc.leafSizeMin;
        this.leafMaxSize   = lc.leafSizeMax;

        this.enableLeafWind = config.enableLeafWind === true;
        this.enableLeafAlbedoTexture = config.enableLeafAlbedoTexture === true;
        this.enableLeafNormalTexture = config.enableLeafNormalTexture === true;

        this.birchTemplateStart = config.birchTemplateStart ?? 0xFFFFFFFF;
        this.birchTemplateCount = Math.max(0, config.birchTemplateCount ?? 0);

        this._leafMaskBaker = config.leafMaskBaker ?? null;
        this._budgetReadbackEnabled = true;

        // GPU resources (unchanged)
        this._leafBuffer     = null;
        this._counterBuffer  = null;
        this._indirectBuffer = null;
        this._paramBuffer    = null;
        this._requestSummaryBuffer = null;
        this._budgetReadbackBuffer = null;
        this._budgetReadbackQueued = false;
        this._budgetReadbackPending = false;
        this._budgetLogSamples = 0;

        this._quadPosBuffer  = null;
        this._quadNormBuffer = null;
        this._quadUVBuffer   = null;
        this._quadIdxBuffer  = null;
        this._quadIdxCount   = 6;

        this._scatterPipeline = null;
        this._scatterBGL = null;
        this._scatterBG = null;
        this._scatterBGDirty = true;
        this._prepassPipeline = null;
        this._prepassBGL = null;
        this._prepassBG = null;
        this._prepassBGDirty = true;

        this._drawArgsPipeline = null;
        this._drawArgsBGL = null;
        this._drawArgsBG = null;
        this._drawArgsBGDirty = true;

        this._renderPipeline = null;
        this._renderBGLs = [];
        this._renderBGs = [];
        this._renderBGsDirty = true;
        this._hasLeafAlbedoTexture = false;
        this._hasLeafNormalTexture = false;
        this._leafTexSampler = null;
        this._leafAlbedoTexBase = 0;
        this._leafAlbedoTexCount = BIRCH_MASK_VARIANTS;
        this._leafNormalTexBase = 0;
        this._leafNormalTexCount = BIRCH_MASK_VARIANTS;

        this._workgroupSize = 256;

        this._initialized = false;
        this._frameCount = 0;
        this._lastLeafCount = 0;
    }

    async initialize() {
        if (this._initialized) return;

        if (!this._leafMaskBaker) {
            Logger.warn('[LeafStreamer] No leafMaskBaker — leaf rendering disabled.');
        }

        this._createBuffers();
        this._createLeafQuad();
        this._createPrepassPipeline();
        this._createScatterPipeline();
        this._createDrawArgsPipeline();
        this._createRenderPipeline();

        this._initialized = true;

        const cfg = this.lodController.getLeafScatterShaderConfig();
        Logger.info(
            `[LeafStreamer] Initialized (baked-mask, indirect-dispatch): ` +
            `maxLeaves=${this.maxLeaves}, maxCloseTrees=${this.maxCloseTrees}, ` +
            `generic=[${cfg.l0Leaves}/${cfg.l1Leaves}/${cfg.l2Leaves}] ` +
            `birch=${cfg.birchCloseLeaves}->${cfg.birchL0SettledLeaves} ` +
            `bands=[${(cfg.leafBandBudgetFractions || []).map(v => v.toFixed(2)).join('/')}]`
        );
    }
    _createBuffers() {
        this._leafBuffer = this.device.createBuffer({
            label: 'Leaf-Instances',
            size: Math.max(256, this.maxLeaves * INSTANCE_BYTES),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
    
        this._counterBuffer = this.device.createBuffer({
            label: 'Leaf-Counter',
            size: 256,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });
    
        // Per-tree drawIndexedIndirect args: 5 u32 × maxCloseTrees.
        // Replaces the old single-draw indirect buffer.
        this._drawArgsBuffer = this.device.createBuffer({
            label: 'Leaf-DrawArgs',
            size: 20,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
        });
    
        this._paramBuffer = this.device.createBuffer({
            label: 'Leaf-Params',
            size: 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this._requestSummaryBuffer = this.device.createBuffer({
            label: 'Leaf-RequestSummary',
            size: 256,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });
    }
    _createLeafQuad() {
        // Simple quad for leaf billboard
        const pos = new Float32Array([
            -0.5, 0, 0,   0.5, 0, 0,   0.5, 1, 0,   -0.5, 1, 0,
        ]);
        const nrm = new Float32Array([
            0, 0, 1,  0, 0, 1,  0, 0, 1,  0, 0, 1,
        ]);
        const uv = new Float32Array([0, 0,  1, 0,  1, 1,  0, 1]);
        const idx = new Uint16Array([0, 1, 2, 0, 2, 3]);

        const mkVB = (data, label) => {
            const b = this.device.createBuffer({
                label, size: data.byteLength,
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
                mappedAtCreation: true,
            });
            new Float32Array(b.getMappedRange()).set(data);
            b.unmap();
            return b;
        };

        this._quadPosBuffer = mkVB(pos, 'LeafQuad-Pos');
        this._quadNormBuffer = mkVB(nrm, 'LeafQuad-Norm');
        this._quadUVBuffer = mkVB(uv, 'LeafQuad-UV');

        const ib = this.device.createBuffer({
            label: 'LeafQuad-Idx',
            size: Math.ceil(idx.byteLength / 4) * 4,
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true,
        });
        new Uint16Array(ib.getMappedRange(0, idx.byteLength)).set(idx);
        ib.unmap();
        this._quadIdxBuffer = ib;
        this._quadIdxCount = 6;
    }
    _createPrepassPipeline() {
        const code = buildLeafBudgetPrepassShader({
            ...this.lodController.getLeafScatterShaderConfig(),
        });

        const mod = this.device.createShaderModule({ label: 'LeafBudgetPrepass-SM', code });

        this._prepassBGL = this.device.createBindGroupLayout({
            label: 'LeafBudgetPrepass-BGL',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
            ],
        });

        this._prepassPipeline = this.device.createComputePipeline({
            label: 'LeafBudgetPrepass-Pipeline',
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [this._prepassBGL] }),
            compute: { module: mod, entryPoint: 'main' },
        });
    }
    _createScatterPipeline() {
        const code = buildLeafScatterDetailedShader({
            workgroupSize: this._workgroupSize,
            ...this.lodController.getLeafScatterShaderConfig(),
        });
    
        const mod = this.device.createShaderModule({ label: 'LeafScatterDetailed-SM', code });
    
        this._scatterBGL = this.device.createBindGroupLayout({
            label: 'LeafScatterDetailed-BGL',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                // read_write now — scatter writes back leafStart/leafCount
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
            ],
        });
    
        this._scatterPipeline = this.device.createComputePipeline({
            label: 'LeafScatterDetailed-Pipeline',
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [this._scatterBGL] }),
            compute: { module: mod, entryPoint: 'main' },
        });
    }
    _createDrawArgsPipeline() {
        const code = buildLeafDrawArgsShader({
            quadIndexCount: this._quadIdxCount,
            maxLeaves:      this.maxLeaves,
        });
        const mod = this.device.createShaderModule({ label: 'LeafDrawArgs-SM', code });

        this._drawArgsBGL = this.device.createBindGroupLayout({
            label: 'LeafDrawArgs-BGL',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
            ],
        });

        this._drawArgsPipeline = this.device.createComputePipeline({
            label: 'LeafDrawArgs-Pipeline',
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [this._drawArgsBGL] }),
            compute: { module: mod, entryPoint: 'main' },
        });
    }

    _createRenderPipeline() {
        const albedoMgr = this.leafAlbedoTextureManager || this.propTextureManager;
        const normalMgr = this.leafNormalTextureManager || null;

        const hasAlbedoAtlas = albedoMgr?.isReady?.() === true;
        const hasNormalAtlas = normalMgr?.isReady?.() === true;
        const hasLeafAlbedoTexture = this.enableLeafAlbedoTexture && hasAlbedoAtlas;
        const hasLeafNormalTexture = this.enableLeafNormalTexture && hasNormalAtlas;

        this._leafAlbedoTexBase = 0;
        this._leafAlbedoTexCount = BIRCH_MASK_VARIANTS;
        this._leafNormalTexBase = 0;
        this._leafNormalTexCount = BIRCH_MASK_VARIANTS;

        if (hasLeafAlbedoTexture) {
            const first = albedoMgr.getLayerIndex?.('leaf_birch_albedo_0') ?? -1;
            if (first >= 0) this._leafAlbedoTexBase = first;
            let count = 0;
            for (let i = 0; i < BIRCH_MASK_VARIANTS; i++) {
                if ((albedoMgr.getLayerIndex?.(`leaf_birch_albedo_${i}`) ?? -1) >= 0) count++;
            }
            this._leafAlbedoTexCount = Math.max(1, count);
        }
        if (hasLeafNormalTexture) {
            const first = normalMgr.getLayerIndex?.('leaf_birch_normal_0') ?? -1;
            if (first >= 0) this._leafNormalTexBase = first;
            let count = 0;
            for (let i = 0; i < BIRCH_MASK_VARIANTS; i++) {
                if ((normalMgr.getLayerIndex?.(`leaf_birch_normal_${i}`) ?? -1) >= 0) count++;
            }
            this._leafNormalTexCount = Math.max(1, count);
        }

        const vsCode = buildLeafVertexShader({ enableWind: this.enableLeafWind });
        const fsCode = buildLeafFragmentShader({
            fadeStart:             this.leafFadeStart,
            fadeEnd:               this.leafRange,
            birchMaskVariants:     BIRCH_MASK_VARIANTS,
            spruceMaskVariants:    SPRUCE_MASK_VARIANTS,
            spruceMaskLayerOffset: SPRUCE_MASK_LAYER_OFFSET,
            connectorStrength:     0.32,
            enableOrientationDebug: false,
            enableAlbedoTexture:   hasLeafAlbedoTexture,
            enableNormalTexture:   hasLeafNormalTexture,
            birchL0TexBase: this._leafAlbedoTexBase,
            birchL0TexCount: this._leafAlbedoTexCount,
            birchL1TexBase: this._leafAlbedoTexBase,
            birchL1TexCount: this._leafAlbedoTexCount,
            birchL2TexBase: this._leafAlbedoTexBase,
            birchL2TexCount: this._leafAlbedoTexCount,
            birchL3TexBase: this._leafAlbedoTexBase,
            birchL3TexCount: this._leafAlbedoTexCount,
            birchNormalTexBase: this._leafNormalTexBase,
            birchNormalTexCount: this._leafNormalTexCount,
            // Feature gating:
            // veinLODThreshold=0  → veins only at band 0 (closest)
            // lightLODThreshold=1 → dir lighting at bands 0 and 1
            veinLODThreshold:  0,
            lightLODThreshold: 1,
        });

        const vsMod = this.device.createShaderModule({ label: 'LeafVS', code: vsCode });
        const fsMod = this.device.createShaderModule({ label: 'LeafFS', code: fsCode });

        const group0 = this.device.createBindGroupLayout({
            label: 'Leaf-RG0',
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
            ],
        });

        const group1 = this.device.createBindGroupLayout({
            label: 'Leaf-RG1',
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT,
                  texture: { sampleType: 'float', viewDimension: '2d-array' } },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
                ...(hasLeafAlbedoTexture ? [{
                    binding: 3, visibility: GPUShaderStage.FRAGMENT,
                    texture: { sampleType: 'float', viewDimension: '2d-array' }
                }, {
                    binding: 4, visibility: GPUShaderStage.FRAGMENT,
                    sampler: { type: 'filtering' }
                }] : []),
                ...(hasLeafNormalTexture ? [{
                    binding: 5, visibility: GPUShaderStage.FRAGMENT,
                    texture: { sampleType: 'float', viewDimension: '2d-array' }
                }] : []),
            ],
        });

        this._renderBGLs = [group0, group1];
        this._hasLeafAlbedoTexture = hasLeafAlbedoTexture;
        this._hasLeafNormalTexture = hasLeafNormalTexture;
        const canvasFormat = this.streamer?.backend?.sceneFormat || navigator.gpu.getPreferredCanvasFormat();

        this._renderPipeline = this.device.createRenderPipeline({
            label: 'Leaf-RenderPipeline',
            layout: this.device.createPipelineLayout({ bindGroupLayouts: this._renderBGLs }),
            vertex: {
                module: vsMod, entryPoint: 'main',
                buffers: [
                    { arrayStride: 12, stepMode: 'vertex', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
                    { arrayStride: 12, stepMode: 'vertex', attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
                    { arrayStride: 8,  stepMode: 'vertex', attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x2' }] },
                ],
            },
            fragment: {
                module: fsMod, entryPoint: 'main',
                targets: [{ format: canvasFormat }],
            },
            primitive: { topology: 'triangle-list', cullMode: 'none', frontFace: 'ccw' },
            depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
        });
    }
    _updateParams(camera) {
        const s = this.streamer;
        const cam = s.uniformManager?.camera?.position || camera?.position || { x: 0, y: 0, z: 0 };
        const pc = s.planetConfig;
        const envState = s.uniformManager?.currentEnvironmentState;

        const data = new Float32Array(16);
        data[0] = cam.x;
        data[1] = cam.y;
        data[2] = cam.z;
        data[3] = performance.now() / 1000.0;
        data[4] = pc.origin.x;
        data[5] = pc.origin.y;
        data[6] = pc.origin.z;
        data[7] = pc.radius;
        data[8] = this.leafMinSize;
        data[9] = this.leafMaxSize;
        data[10] = (envState?.windSpeed ?? 5.0) / 10.0;
        data[11] = 0;
        data[12] = 0;
        data[13] = 0;
        data[14] = 0;
        data[15] = 0;

        const u32View = new Uint32Array(data.buffer);
        u32View[11] = this.birchTemplateStart >>> 0;
        u32View[12] = this.birchTemplateCount >>> 0;
        u32View[13] = 0xFFFFFFFF;
        u32View[14] = 0;

        this.device.queue.writeBuffer(this._paramBuffer, 0, data);
    }

    _maybeRebuildScatterBG() {
        if (!this._scatterBGDirty) return;

        const tds = this.streamer._treeDetailSystem;
        if (!tds) return;

        const closeTreeBuffer = tds.getCloseTreeBuffer();
        const closeTreeCountBuffer = tds.getCloseTreeCountBuffer();
        if (!closeTreeBuffer || !closeTreeCountBuffer) return;

        const templateLib = this.streamer._templateLibrary;
        const anchorBuffer = templateLib?.getAnchorBuffer?.();
        const templateInfoBuffer = templateLib?.getTemplateInfoBuffer?.();
        if (!anchorBuffer || !templateInfoBuffer) return;

        this._scatterBG = this.device.createBindGroup({
            layout: this._scatterBGL,
            entries: [
                { binding: 0, resource: { buffer: this._paramBuffer } },
                { binding: 1, resource: { buffer: closeTreeBuffer } },
                { binding: 2, resource: { buffer: closeTreeCountBuffer } },
                { binding: 3, resource: { buffer: this._leafBuffer } },
                { binding: 4, resource: { buffer: this._counterBuffer } },
                { binding: 5, resource: { buffer: anchorBuffer } },
                { binding: 6, resource: { buffer: templateInfoBuffer } },
                { binding: 7, resource: { buffer: this._requestSummaryBuffer } },
            ]
        });

        this._scatterBGDirty = false;
    }

    _maybeRebuildPrepassBG() {
        if (!this._prepassBGDirty) return;

        const tds = this.streamer._treeDetailSystem;
        if (!tds) return;

        const closeTreeBuffer = tds.getCloseTreeBuffer();
        const closeTreeCountBuffer = tds.getCloseTreeCountBuffer();
        if (!closeTreeBuffer || !closeTreeCountBuffer) return;

        const templateLib = this.streamer._templateLibrary;
        const templateInfoBuffer = templateLib?.getTemplateInfoBuffer?.();
        if (!templateInfoBuffer) return;

        this._prepassBG = this.device.createBindGroup({
            layout: this._prepassBGL,
            entries: [
                { binding: 0, resource: { buffer: this._paramBuffer } },
                { binding: 1, resource: { buffer: closeTreeBuffer } },
                { binding: 2, resource: { buffer: closeTreeCountBuffer } },
                { binding: 3, resource: { buffer: this._requestSummaryBuffer } },
                { binding: 4, resource: { buffer: templateInfoBuffer } },
            ],
        });

        this._prepassBGDirty = false;
    }

    _maybeRebuildDrawArgsBG() {
        if (!this._drawArgsBGDirty) return;

        this._drawArgsBG = this.device.createBindGroup({
            layout: this._drawArgsBGL,
            entries: [
                { binding: 0, resource: { buffer: this._counterBuffer } },
                { binding: 1, resource: { buffer: this._drawArgsBuffer } },
            ],
        });

        this._drawArgsBGDirty = false;
    }

    _maybeRebuildRenderBGs() {
        if (!this._renderBGsDirty) return;

        const s = this.streamer;
        if (!s._uniformBuffer || !s._fragUniformBuffer) return;

        // Atlas is mandatory for the baked-mask path. If it's not ready
        // yet (shouldn't happen — AssetStreamer awaits it before us),
        // skip and retry next frame.
        if (!this._leafMaskBaker?.isReady()) return;
        const maskView = this._leafMaskBaker.getTextureView();
        const maskSamp = this._leafMaskBaker.getSampler();
        if (!maskView || !maskSamp) return;

        const g0 = this.device.createBindGroup({
            layout: this._renderBGLs[0],
            entries: [
                { binding: 0, resource: { buffer: s._uniformBuffer } },
                { binding: 1, resource: { buffer: this._leafBuffer } },
            ]
        });

        const g1 = this.device.createBindGroup({
            layout: this._renderBGLs[1],
            entries: [
                { binding: 0, resource: { buffer: s._fragUniformBuffer } },
                { binding: 1, resource: maskView },
                { binding: 2, resource: maskSamp },
                ...(this._hasLeafAlbedoTexture ? (() => {
                    const albedoMgr = this.leafAlbedoTextureManager || this.propTextureManager;
                    const normalMgr = this.leafNormalTextureManager || null;

                    const albedoTex = albedoMgr?.getPropTexture?.();
                    const albedoGpu = albedoTex?._gpuTexture?.texture;
                    if (!albedoGpu) return [];
                    const viewKey = '_view_2d-array';
                    if (!albedoTex._gpuTexture[viewKey]) {
                        albedoTex._gpuTexture[viewKey] = albedoGpu.createView({ dimension: '2d-array' });
                    }
                    if (!this._leafTexSampler) {
                        this._leafTexSampler = this.device.createSampler({
                            magFilter: 'linear',
                            minFilter: 'linear',
                            mipmapFilter: 'linear',
                            addressModeU: 'repeat',
                            addressModeV: 'repeat',
                        });
                    }
                    const albedoEntries = [
                        { binding: 3, resource: albedoTex._gpuTexture[viewKey] },
                        { binding: 4, resource: this._leafTexSampler },
                    ];
                    if (this._hasLeafNormalTexture) {
                        const normalTex = normalMgr?.getPropTexture?.();
                        const normalGpu = normalTex?._gpuTexture?.texture;
                        if (!normalGpu) return albedoEntries;
                        if (!normalTex._gpuTexture[viewKey]) {
                            normalTex._gpuTexture[viewKey] = normalGpu.createView({ dimension: '2d-array' });
                        }
                        albedoEntries.push({ binding: 5, resource: normalTex._gpuTexture[viewKey] });
                    }
                    return albedoEntries;
                })() : []),
            ]
        });

        this._renderBGs = [g0, g1];
        this._renderBGsDirty = false;
    }

    update(commandEncoder, camera) {
        if (!this._initialized) return;
        this._frameCount++;
        this._kickBudgetReadback();
    
        const tds = this.streamer._treeDetailSystem;
        if (!tds || !tds.isReady()) return;
    
        const dispatchArgs = tds.getLeafDispatchArgsBuffer();
        if (!dispatchArgs) return;
    
        this._updateParams(camera);
        this._maybeRebuildPrepassBG();
        this._maybeRebuildScatterBG();
        this._maybeRebuildDrawArgsBG();
    
        if (!this._prepassBG || !this._scatterBG || !this._drawArgsBG) return;
    
        this.device.queue.writeBuffer(this._counterBuffer, 0, this._counterReset);
        this.device.queue.writeBuffer(this._requestSummaryBuffer, 0, this._requestSummaryReset);

        {
            const pass = commandEncoder.beginComputePass({ label: 'LeafBudgetPrepass' });
            pass.setPipeline(this._prepassPipeline);
            pass.setBindGroup(0, this._prepassBG);
            pass.dispatchWorkgroupsIndirect(dispatchArgs, 0);
            pass.end();
        }
    
        // ── Scatter: one workgroup per close tree ───────────────────────
        {
            const pass = commandEncoder.beginComputePass({ label: 'LeafScatterDetailed' });
            pass.setPipeline(this._scatterPipeline);
            pass.setBindGroup(0, this._scatterBG);
            pass.dispatchWorkgroupsIndirect(dispatchArgs, 0);
            pass.end();
        }
    
        {
            const pass = commandEncoder.beginComputePass({ label: 'LeafDrawArgs' });
            pass.setPipeline(this._drawArgsPipeline);
            pass.setBindGroup(0, this._drawArgsBG);
            pass.dispatchWorkgroups(1);
            pass.end();
        }

        this._queueBudgetReadback(commandEncoder);
    }
    render(renderPassEncoder) {
        if (!this._initialized) return;
        if (!renderPassEncoder) return;

        this._maybeRebuildRenderBGs();
        if (this._renderBGs.length === 0) return;

        renderPassEncoder.setPipeline(this._renderPipeline);
        for (let i = 0; i < this._renderBGs.length; i++) {
            renderPassEncoder.setBindGroup(i, this._renderBGs[i]);
        }

        renderPassEncoder.setVertexBuffer(0, this._quadPosBuffer);
        renderPassEncoder.setVertexBuffer(1, this._quadNormBuffer);
        renderPassEncoder.setVertexBuffer(2, this._quadUVBuffer);
        renderPassEncoder.setIndexBuffer(this._quadIdxBuffer, 'uint16');

        // Single draw over the full contiguous leaf range. Scatter
        // guarantees no gaps (see gap-free invariant in
        // leafScatterDetailed.wgsl). Per-tree leafStart/leafCount are
        // still written back to CloseTreeInfo for future use.
        renderPassEncoder.drawIndexedIndirect(this._drawArgsBuffer, 0);
    }
    getStats() {
        return {
            leafCount: this._lastLeafCount,
            maxLeaves: this.maxLeaves
        };
    }

    setLeafDistanceRange(fadeStart, fadeEnd) {
        const start = Number.isFinite(fadeStart) ? fadeStart : this.leafFadeStart;
        const endCandidate = Number.isFinite(fadeEnd) ? fadeEnd : this.leafRange;
        const end = Math.max(start + 1.0, endCandidate);

        this.leafFadeStart = start;
        this.leafRange = end;

        if (!this._initialized) return;
        this._createRenderPipeline();
        this._renderBGsDirty = true;
    }

    _ensureBudgetReadbackBuffer() {
        if (this._budgetReadbackBuffer) return;
        this._budgetReadbackBuffer = this.device.createBuffer({
            label: 'Leaf-BudgetReadback',
            size: 256,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });
    }

    _queueBudgetReadback(commandEncoder) {
        if (!commandEncoder || this._budgetReadbackQueued || this._budgetReadbackPending) return;
        const shouldSample = this._frameCount === 60 || (this._frameCount % 240) === 0;
        if (!shouldSample) return;

        this._ensureBudgetReadbackBuffer();
        if (!this._budgetReadbackBuffer) return;

        commandEncoder.copyBufferToBuffer(
            this._requestSummaryBuffer,
            0,
            this._budgetReadbackBuffer,
            0,
            32
        );
        commandEncoder.copyBufferToBuffer(
            this._counterBuffer,
            0,
            this._budgetReadbackBuffer,
            32,
            4
        );
        this._budgetReadbackQueued = true;
    }

    _kickBudgetReadback() {
        if (!this._budgetReadbackEnabled) return;
        if (!this._budgetReadbackQueued || this._budgetReadbackPending || !this._budgetReadbackBuffer) return;

        this._budgetReadbackPending = true;
        this._budgetReadbackBuffer.mapAsync(GPUMapMode.READ).then(() => {
            const data = new Uint32Array(this._budgetReadbackBuffer.getMappedRange(0, 36).slice(0));
            const requested = data[0] >>> 0;
            const foliageTrees = data[1] >>> 0;
            const maxPerTree = data[2] >>> 0;
            const treeCount = data[3] >>> 0;
            const band0 = data[4] >>> 0;
            const band1 = data[5] >>> 0;
            const band2 = data[6] >>> 0;
            const band3 = data[7] >>> 0;
            const emitted = data[8] >>> 0;
            const scale = Math.min(1.0, this.maxLeaves / Math.max(1, requested));

            this._lastLeafCount = emitted;
            this._budgetLogSamples++;
            if (requested > this.maxLeaves || emitted >= this.maxLeaves || this._budgetLogSamples <= 2) {
                Logger.info(
                    `[LeafStreamer] budget trees=${treeCount} foliageTrees=${foliageTrees} ` +
                    `requested=${requested} emitted=${emitted}/${this.maxLeaves} ` +
                    `maxTree=${maxPerTree} scale=${scale.toFixed(3)} ` +
                    `bands=[${band0}/${band1}/${band2}/${band3}]`
                );
            }

            this._budgetReadbackBuffer.unmap();
            this._budgetReadbackQueued = false;
            this._budgetReadbackPending = false;
        }).catch((err) => {
            Logger.warn(`[LeafStreamer] budget readback failed: ${err?.message || err}`);
            try { this._budgetReadbackBuffer?.unmap(); } catch (_) {}
            this._budgetReadbackQueued = false;
            this._budgetReadbackPending = false;
        });
    }

    dispose() {
        this._leafBuffer?.destroy();
        this._counterBuffer?.destroy();
        this._indirectBuffer?.destroy();
        this._paramBuffer?.destroy();
        this._requestSummaryBuffer?.destroy();
        this._budgetReadbackBuffer?.destroy();
        this._drawArgsBuffer?.destroy();
        this._quadPosBuffer?.destroy();
        this._quadNormBuffer?.destroy();
        this._quadUVBuffer?.destroy();
        this._quadIdxBuffer?.destroy();
        this._initialized = false;
    }
}
