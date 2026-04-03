// js/renderer/streamer/BranchRenderer.js
//
// Changes:
//   • _createRenderPipeline passes branchLOD config to vertex shader.
//   • The vertex shader collapses vertices whose hierarchy level exceeds
//     the distance-dependent maximum to degenerate triangles.

import { Logger } from '../../../shared/Logger.js';
import { TreeTrunkGeometryBuilder } from './TreeTrunkGeometryBuilder.js';
import {
    buildBranchVertexShader,
    buildBranchFragmentShader,
    buildBranchSortAndIndirectShader
} from './shaders/branchRender.wgsl.js';


export class BranchRenderer {
    constructor(device, streamer, config = {}) {
        this.propTextureManager = config.propTextureManager || null;
        this.device   = device;
        this.streamer = streamer;
        const streamerTheme = streamer?._streamerTheme;
        if (!streamerTheme) {
            throw new Error('[BranchRenderer] requires streamer with _streamerTheme');
        }
        this._streamerTheme = streamerTheme;
        this.ASSET_SELF_OCCLUSION = streamerTheme.ASSET_SELF_OCCLUSION;

        this.lodController = config.lodController;
        if (!this.lodController) {
            throw new Error('[BranchRenderer] lodController is required');
        }
        const lc = this.lodController;

        this.maxCloseTrees        = lc.maxCloseTrees;
        this.maxBranchDetailLevel = lc.maxBranchDetailLevel;
        this.enableBranchWind     = config.enableBranchWind === true;

        this._variantCount = 0;
        this._posBuffer    = null;
        this._normBuffer   = null;
        this._uvBuffer     = null;
        this._levelBuffer  = null;
        this._idxBuffer    = null;

        this._variantMeta = [];

        this._variantMetaBuffer = null;
        this._indirectBuffer    = null;
        this._sortedTreeBuffer  = null;
        this._sortedCountBuffer = null;
        this._sortParamBuffer   = null;

        this._sortPipeline = null;
        this._sortBGL      = null;
        this._sortBG       = null;
        this._sortBGDirty  = true;

        this._renderPipeline = null;
        this._renderBGLs     = [];
        this._renderBGs      = [];
        this._renderBGsDirty = true;

        this._initialized = false;
        this._frameCount  = 0;
    }

    async initialize(templateLibrary) {
        if (this._initialized) return;

        this._buildVariantGeometries(templateLibrary);

        if (this._variantCount === 0) {
            Logger.warn('[BranchRenderer] No variant geometries — skipping init');
            return;
        }

        this._createBuffers();
        this._createSortPipeline();
        this.propTextureManager = this.streamer.propTextureManager || this.propTextureManager;
        this._createRenderPipeline();

        this._initialized = true;

        const totalTris = this._variantMeta.reduce((s, m) => s + m.indexCount / 3, 0);
        Logger.info(
            `[BranchRenderer] Initialized: ${this._variantCount} variants, ` +
            `${totalTris} total tris, ` +
            `max ${totalTris * this.maxCloseTrees} tris/frame`
        );
    }

    _buildVariantGeometries(templateLibrary) {
        const geoList = [];

        const treeTypes = ['birch'];

        for (const treeType of treeTypes) {
            const variants = templateLibrary.getVariants(treeType);
            for (const template of variants) {
                const lods = TreeTrunkGeometryBuilder.buildFromTemplate(template, {
                    trunkRadialSegments: 10,
                    branchRadialSegments: 6
                });
                geoList.push(lods[0]);
            }
        }

        if (geoList.length === 0) {
            const lods = TreeTrunkGeometryBuilder.buildDeciduousLODs();
            this._packGeometries([lods[0]]);
            return;
        }

        this._packGeometries(geoList);
    }

    _packGeometries(geoList) {
        let totalVerts = 0;
        let totalIndices = 0;
        const metas = [];

        for (const geo of geoList) {
            if (!geo || !geo.positions || geo.positions.length === 0) continue;
            const vertCount = geo.positions.length / 3;
            const idxCount  = geo.indices?.length ?? geo.indexCount ?? 0;
            metas.push({
                vertexOffset: totalVerts,
                indexStart:   totalIndices,
                indexCount:   idxCount,
                vertCount,
            });
            totalVerts   += vertCount;
            totalIndices += idxCount;
        }

        if (metas.length === 0) {
            this._variantCount = 0;
            return;
        }

        const positions = new Float32Array(totalVerts * 3);
        const normals   = new Float32Array(totalVerts * 3);
        const uvs       = new Float32Array(totalVerts * 2);
        const levels    = new Float32Array(totalVerts);
        const indices   = new Uint32Array(totalIndices);

        let metaIdx = 0;
        for (let g = 0; g < geoList.length; g++) {
            const geo = geoList[g];
            if (!geo || !geo.positions || geo.positions.length === 0) continue;
            const meta = metas[metaIdx++];

            positions.set(geo.positions, meta.vertexOffset * 3);
            normals.set(geo.normals,     meta.vertexOffset * 3);
            uvs.set(geo.uvs,             meta.vertexOffset * 2);

            if (geo.levels && geo.levels.length === meta.vertCount) {
                levels.set(geo.levels, meta.vertexOffset);
            }

            for (let i = 0; i < (geo.indices?.length ?? 0); i++) {
                indices[meta.indexStart + i] = geo.indices[i] + meta.vertexOffset;
            }
        }

        this._posBuffer   = this._mkBuffer(positions, 'BranchPacked-Pos',
            GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST);
        this._normBuffer  = this._mkBuffer(normals,   'BranchPacked-Norm',
            GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST);
        this._uvBuffer    = this._mkBuffer(uvs,       'BranchPacked-UV',
            GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST);
        this._levelBuffer = this._mkBuffer(levels,    'BranchPacked-Level',
            GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST);

        const idxAligned = Math.max(16, indices.byteLength);
        const idxBuf = this.device.createBuffer({
            label: 'BranchPacked-Idx',
            size: idxAligned,
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true,
        });
        new Uint32Array(idxBuf.getMappedRange(0, indices.byteLength)).set(indices);
        idxBuf.unmap();
        this._idxBuffer = idxBuf;

        this._variantMeta  = metas;
        this._variantCount = metas.length;
    }

    _mkBuffer(data, label, usage) {
        const buf = this.device.createBuffer({
            label,
            size: Math.max(16, data.byteLength),
            usage: usage | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true
        });
        const Ctor = data instanceof Uint32Array ? Uint32Array : Float32Array;
        new Ctor(buf.getMappedRange(0, data.byteLength)).set(data);
        buf.unmap();
        return buf;
    }

    _createBuffers() {
        const vc = this._variantCount;
        const maxClose = this.maxCloseTrees;

        const metaData = new Uint32Array(vc * 4);
        for (let i = 0; i < vc; i++) {
            const m = this._variantMeta[i];
            metaData[i * 4 + 0] = m.indexStart;
            metaData[i * 4 + 1] = m.indexCount;
            metaData[i * 4 + 2] = 0;
            metaData[i * 4 + 3] = 0;
        }
        this._variantMetaBuffer = this.device.createBuffer({
            label: 'Branch-VariantMeta',
            size: Math.max(256, metaData.byteLength),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(this._variantMetaBuffer, 0, metaData);

        this._indirectBuffer = this.device.createBuffer({
            label: 'Branch-IndirectArgs',
            size: Math.max(256, vc * 5 * 4),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
        });

        this._sortedTreeBuffer = this.device.createBuffer({
            label: 'Branch-SortedTrees',
            size: Math.max(256, vc * maxClose * 4),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        this._sortedCountBuffer = this.device.createBuffer({
            label: 'Branch-SortedCounts',
            size: Math.max(256, vc * 4),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        this._sortParamBuffer = this.device.createBuffer({
            label: 'Branch-SortParams',
            size: 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
    }

    _createSortPipeline() {
        const code = buildBranchSortAndIndirectShader({
            variantCount:         this._variantCount,
            maxCloseTrees:        this.maxCloseTrees,
            maxBranchDetailLevel: this.maxBranchDetailLevel,
        });

        const mod = this.device.createShaderModule({ label: 'BranchSort-SM', code });

        this._sortBGL = this.device.createBindGroupLayout({
            label: 'BranchSort-BGL',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE,
                  buffer: { type: 'read-only-storage' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE,
                  buffer: { type: 'read-only-storage' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE,
                  buffer: { type: 'read-only-storage' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE,
                  buffer: { type: 'storage' } },
                { binding: 4, visibility: GPUShaderStage.COMPUTE,
                  buffer: { type: 'storage' } },
                { binding: 5, visibility: GPUShaderStage.COMPUTE,
                  buffer: { type: 'storage' } },
                { binding: 6, visibility: GPUShaderStage.COMPUTE,
                  buffer: { type: 'uniform' } },
            ],
        });

        this._sortPipeline = this.device.createComputePipeline({
            label: 'BranchSort-Pipeline',
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [this._sortBGL] }),
            compute: { module: mod, entryPoint: 'main' },
        });
    }

    _createRenderPipeline() {
        const hasBarkTexture = this.propTextureManager?.isReady() === true;

        const soConfig = this.streamer?._assetRegistry?.getAllAssets?.()
            ?.find(a => a.category === 'tree')?.selfOcclusion || {};
        const globalSO = this.ASSET_SELF_OCCLUSION || {};

        // ── Pass branch LOD config to the vertex shader ───────────────────
        const branchLODConfig = this.lodController.getBranchLODShaderConfig();

        const vsCode = buildBranchVertexShader({
            variantCount: this._variantCount,
            enableWind:   this.enableBranchWind,
            ...branchLODConfig,
        });

        const fsCode = buildBranchFragmentShader({
            fadeStart:         this.lodController.branchFadeStart,
            fadeEnd:           this.lodController.branchFadeEnd,
            enableBarkTexture: hasBarkTexture,
            birchBranchColor:  [0.18, 0.12, 0.08],
            // Blend zone ±0.30 around the trunk/primary junction (level 1.0).
            // Covers ~5-15 cm of attachment zone at typical birch scale.
            // Higher-level junctions are NOT blended.
            seamHalfWidth: 0.30,
            selfOcclusion: {
                enabled:          globalSO.enabled !== false,
                masterStrength:   globalSO.masterStrength ?? 1.0,
                ambientStrength:  globalSO.ambientStrength ?? 1.0,
                directStrength:   globalSO.directStrength ?? 0.4,
                gradientWidth:    soConfig.gradientWidth ?? globalSO.tree?.gradientWidth ?? 0.12,
                darkening:        soConfig.darkening ?? globalSO.tree?.darkening ?? 0.35,
                terrainEmbedding: soConfig.terrainEmbedding ?? globalSO.tree?.terrainEmbedding ?? 0.02,
                strengthMul:      soConfig.strengthMul ?? globalSO.tree?.strengthMul ?? 0.8,
            },
        });

        const vsMod = this.device.createShaderModule({ label: 'BranchVS', code: vsCode });
        const fsMod = this.device.createShaderModule({ label: 'BranchFS', code: fsCode });

        const group0 = this.device.createBindGroupLayout({
            label: 'Branch-RG0',
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX,
                  buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.VERTEX,
                  buffer: { type: 'read-only-storage' } },
                { binding: 2, visibility: GPUShaderStage.VERTEX,
                  buffer: { type: 'read-only-storage' } },
            ],
        });

        const group1Entries = [
            { binding: 0, visibility: GPUShaderStage.FRAGMENT,
              buffer: { type: 'uniform' } },
        ];
        if (hasBarkTexture) {
            group1Entries.push(
                { binding: 1, visibility: GPUShaderStage.FRAGMENT,
                  texture: { sampleType: 'float', viewDimension: '2d-array' } },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT,
                  sampler: { type: 'filtering' } },
            );
        }
        const group1 = this.device.createBindGroupLayout({
            label: 'Branch-RG1',
            entries: group1Entries,
        });

        this._renderBGLs = [group0, group1];
        this._hasBarkTexture = hasBarkTexture;

        const canvasFormat = navigator.gpu.getPreferredCanvasFormat();

        this._renderPipeline = this.device.createRenderPipeline({
            label: 'Branch-RenderPipeline',
            layout: this.device.createPipelineLayout({ bindGroupLayouts: this._renderBGLs }),
            vertex: {
                module: vsMod,
                entryPoint: 'main',
                buffers: [
                    { arrayStride: 12, stepMode: 'vertex',
                      attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
                    { arrayStride: 12, stepMode: 'vertex',
                      attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
                    { arrayStride: 8, stepMode: 'vertex',
                      attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x2' }] },
                    { arrayStride: 4, stepMode: 'vertex',
                      attributes: [{ shaderLocation: 3, offset: 0, format: 'float32' }] },
                ],
            },
            fragment: {
                module: fsMod,
                entryPoint: 'main',
                targets: [{
                    format: canvasFormat,
                    blend: {
                        color: { srcFactor: 'one', dstFactor: 'zero', operation: 'add' },
                        alpha: { srcFactor: 'one', dstFactor: 'zero', operation: 'add' },
                    },
                }],
            },
            primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
            depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
        });
    }

    _maybeRebuildSortBG() {
        if (!this._sortBGDirty) return;

        const tds = this.streamer._treeDetailSystem;
        if (!tds) return;
        const ctBuf  = tds.getCloseTreeBuffer();
        const ctcBuf = tds.getCloseTreeCountBuffer();
        if (!ctBuf || !ctcBuf) return;

        this._sortBG = this.device.createBindGroup({
            layout: this._sortBGL,
            entries: [
                { binding: 0, resource: { buffer: ctBuf } },
                { binding: 1, resource: { buffer: ctcBuf } },
                { binding: 2, resource: { buffer: this._variantMetaBuffer } },
                { binding: 3, resource: { buffer: this._sortedTreeBuffer } },
                { binding: 4, resource: { buffer: this._sortedCountBuffer } },
                { binding: 5, resource: { buffer: this._indirectBuffer } },
                { binding: 6, resource: { buffer: this._sortParamBuffer } },
            ],
        });

        this._sortBGDirty = false;
    }

    _maybeRebuildRenderBGs() {
        if (!this._renderBGsDirty) return;

        const s = this.streamer;
        const tds = s._treeDetailSystem;
        if (!s._uniformBuffer || !s._fragUniformBuffer || !tds) return;

        const ctBuf = tds.getCloseTreeBuffer();
        if (!ctBuf) return;

        const g0 = this.device.createBindGroup({
            layout: this._renderBGLs[0],
            entries: [
                { binding: 0, resource: { buffer: s._uniformBuffer } },
                { binding: 1, resource: { buffer: ctBuf } },
                { binding: 2, resource: { buffer: this._sortedTreeBuffer } },
            ]
        });

        const g1Entries = [
            { binding: 0, resource: { buffer: s._fragUniformBuffer } }
        ];

        if (this._hasBarkTexture && this.propTextureManager?.isReady()) {
            const tex = this.propTextureManager.getPropTexture();
            if (tex?._gpuTexture?.texture) {
                const viewKey = '_view_2d-array';
                if (!tex._gpuTexture[viewKey]) {
                    tex._gpuTexture[viewKey] = tex._gpuTexture.texture.createView({
                        dimension: '2d-array'
                    });
                }
                const barkView = tex._gpuTexture[viewKey];

                if (!this._barkSampler) {
                    this._barkSampler = this.device.createSampler({
                        magFilter: 'linear',
                        minFilter: 'linear',
                        mipmapFilter: 'linear',
                        addressModeU: 'repeat',
                        addressModeV: 'repeat',
                    });
                }

                g1Entries.push(
                    { binding: 1, resource: barkView },
                    { binding: 2, resource: this._barkSampler }
                );
            }
        }

        const g1 = this.device.createBindGroup({
            layout: this._renderBGLs[1],
            entries: g1Entries
        });

        this._renderBGs = [g0, g1];
        this._renderBGsDirty = false;
    }

    _updateSortParams(camera) {
        const data = new Float32Array(20);

        if (camera?.matrixWorldInverse && camera?.projectionMatrix) {
            const v = camera.matrixWorldInverse.elements;
            const p = camera.projectionMatrix.elements;
            for (let c = 0; c < 4; c++) {
                for (let r = 0; r < 4; r++) {
                    let sum = 0;
                    for (let k = 0; k < 4; k++) {
                        sum += p[r + k * 4] * v[k + c * 4];
                    }
                    data[c * 4 + r] = sum;
                }
            }
        } else {
            data[0] = 1; data[5] = 1; data[10] = 1; data[15] = 1;
        }

        this.device.queue.writeBuffer(this._sortParamBuffer, 0, data);
    }

    update(commandEncoder, camera) {
        if (!this._initialized) return;
        this._frameCount++;

        this._updateSortParams(camera);
        this._maybeRebuildSortBG();
        if (!this._sortBG) return;

        this.device.queue.writeBuffer(
            this._sortedCountBuffer, 0,
            new Uint32Array(this._variantCount)
        );

        const pass = commandEncoder.beginComputePass({ label: 'BranchSort' });
        pass.setPipeline(this._sortPipeline);
        pass.setBindGroup(0, this._sortBG);
        pass.dispatchWorkgroups(1);
        pass.end();
    }

    render(encoder) {
        if (!this._initialized || this._variantCount === 0) return;
        if (!encoder) return;

        this._maybeRebuildRenderBGs();
        if (this._renderBGs.length === 0) return;

        encoder.setPipeline(this._renderPipeline);
        for (let i = 0; i < this._renderBGs.length; i++) {
            encoder.setBindGroup(i, this._renderBGs[i]);
        }

        encoder.setVertexBuffer(0, this._posBuffer);
        encoder.setVertexBuffer(1, this._normBuffer);
        encoder.setVertexBuffer(2, this._uvBuffer);
        encoder.setVertexBuffer(3, this._levelBuffer);
        encoder.setIndexBuffer(this._idxBuffer, 'uint32');

        for (let v = 0; v < this._variantCount; v++) {
            encoder.drawIndexedIndirect(this._indirectBuffer, v * 5 * 4);
        }
    }

    dispose() {
        this._barkSampler = null;
        this._indirectBuffer?.destroy();
        this._sortedTreeBuffer?.destroy();
        this._sortedCountBuffer?.destroy();
        this._sortParamBuffer?.destroy();
        this._variantMetaBuffer?.destroy();
        this._posBuffer?.destroy();
        this._normBuffer?.destroy();
        this._uvBuffer?.destroy();
        this._levelBuffer?.destroy();
        this._idxBuffer?.destroy();
        this._initialized = false;
    }
}