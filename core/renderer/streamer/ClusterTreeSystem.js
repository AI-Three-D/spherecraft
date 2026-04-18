import { Logger } from '../../../shared/Logger.js';
import { Matrix4, clampInt } from '../../../shared/math/index.js';
import { gpuFormatSampleType } from '../resources/texture.js';
import { MidNearGeometryBuilder } from './MidNearGeometryBuilder.js';
import { ClusterSourceCache, CLUSTER_SOURCE_FLAGS } from './ClusterSourceCache.js';
import { buildClusterTreeBakeShader } from './shaders/clusterTreeBake.wgsl.js';
import { buildClusterTreeGatherShader } from './shaders/clusterTreeGather.wgsl.js';
import { buildClusterHullRenderShaders } from './shaders/clusterHullRender.wgsl.js';

const CLUSTER_RENDER_STRIDE = 64;
const CLUSTER_TREE_TILE_METADATA_STRIDE_FLOATS = 8;
const ZERO_MAT4_ELEMENTS = new Float32Array(16);

function normalizeClusterTreeTileMetadata(source) {
    const sourceData = source?.data instanceof Float32Array ? source.data : null;
    const validSource = sourceData &&
        sourceData.length >= CLUSTER_TREE_TILE_METADATA_STRIDE_FLOATS &&
        sourceData.length % CLUSTER_TREE_TILE_METADATA_STRIDE_FLOATS === 0;
    if (!validSource) {
        return {
            data: new Float32Array(CLUSTER_TREE_TILE_METADATA_STRIDE_FLOATS),
            tileCount: 1,
            authoredTileCount: 0,
            treeProfileCount: 0,
        };
    }

    return {
        data: sourceData,
        tileCount: Math.floor(sourceData.length / CLUSTER_TREE_TILE_METADATA_STRIDE_FLOATS),
        authoredTileCount: Math.max(0, Math.trunc(source.authoredTileCount ?? 0)),
        treeProfileCount: Math.max(0, Math.trunc(source.treeProfileCount ?? 0)),
    };
}

function roundTileWorldSize(value) {
    if (!Number.isFinite(value) || value <= 0) return 128;
    const choices = [128, 256, 512, 1024, 2048, 4096, 8192];
    let best = choices[0];
    let bestDiff = Math.abs(value - best);
    for (const candidate of choices) {
        const diff = Math.abs(value - candidate);
        if (diff < bestDiff) {
            best = candidate;
            bestDiff = diff;
        }
    }
    return best;
}

function createVertexBuffer(device, data, label) {
    const buffer = device.createBuffer({
        label,
        size: Math.max(16, data.byteLength),
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true,
    });
    new Float32Array(buffer.getMappedRange()).set(data);
    buffer.unmap();
    return buffer;
}

function createIndexBuffer(device, data, label) {
    const alignedSize = Math.max(16, Math.ceil(data.byteLength / 4) * 4);
    const buffer = device.createBuffer({
        label,
        size: alignedSize,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true,
    });
    new Uint16Array(buffer.getMappedRange(0, data.byteLength)).set(data);
    buffer.unmap();
    return buffer;
}

function buildPackedCanopyGeometry(baseHull, canopyCount) {
    const copies = Math.max(1, canopyCount | 0);
    const positionsPerCopy = baseHull.positions.length;
    const normalsPerCopy = baseHull.normals.length;
    const uvsPerCopy = baseHull.uvs.length;
    const vertsPerCopy = positionsPerCopy / 3;
    const idxPerCopy = baseHull.indices.length;

    const positions = new Float32Array(positionsPerCopy * copies);
    const normals = new Float32Array(normalsPerCopy * copies);
    const uvs = new Float32Array(uvsPerCopy * copies);
    const canopyIds = new Float32Array(vertsPerCopy * copies);
    const indices = new Uint16Array(idxPerCopy * copies);

    for (let copy = 0; copy < copies; copy++) {
        positions.set(baseHull.positions, copy * positionsPerCopy);
        normals.set(baseHull.normals, copy * normalsPerCopy);
        uvs.set(baseHull.uvs, copy * uvsPerCopy);

        const vertBase = copy * vertsPerCopy;
        for (let v = 0; v < vertsPerCopy; v++) {
            canopyIds[vertBase + v] = copy;
        }

        const idxBase = copy * idxPerCopy;
        for (let i = 0; i < idxPerCopy; i++) {
            indices[idxBase + i] = baseHull.indices[i] + vertBase;
        }
    }

    return {
        positions,
        normals,
        uvs,
        canopyIds,
        indices,
        indexCount: indices.length,
    };
}

export class ClusterTreeSystem {
    constructor(device, assetStreamer, config = {}) {
        this.device = device;
        this.streamer = assetStreamer;
        this._logTag = '[ClusterTreeSystem]';

        const trees = config.treeConfig || assetStreamer?.engineConfig?.trees || {};
        const farTier = trees.farTreeTier || trees.clusterTier || {};
        const farBake = farTier.bake || {};
        const farRange = trees.tierRanges?.farTrees || trees.tierRanges?.cluster || {};
        const practicalDensity = Number.isFinite(trees?._derived?.practicalMaxDensity)
            ? trees._derived.practicalMaxDensity
            : (Number.isFinite(trees?.density?.maxTreesPerSquareMeter) ? trees.density.maxTreesPerSquareMeter : 0.0072);
        const midEndDensityScale = Number.isFinite(trees?.midTier?.endDensityScale)
            ? trees.midTier.endDensityScale
            : 1.0;
        const densityMatchScale = Number.isFinite(farTier.densityMatchScale)
            ? farTier.densityMatchScale
            : 1.0;

        this._tierRange = {
            start: farRange.start ?? 800,
            end: farRange.end ?? 2000,
            fadeInWidth: farRange.fadeInWidth ?? 400,
            fadeOutWidth: farRange.fadeOutWidth ?? 300,
        };
        this._cfg = {
            enabled: farTier.enabled !== false,
            maxInstances: clampInt(farTier.maxInstances ?? 16000, 128, 131072),
            perLayerCapacity: clampInt(farBake.perLayerCapacity ?? 80, 4, 512),
            maxBakesPerFrame: clampInt(farBake.maxBakesPerFrame ?? 8, 1, 64),
            minDensity: Number.isFinite(farBake.minDensity) ? Math.max(0.0, farBake.minDensity) : 0.08,
            targetTreeDensity: Math.max(0.00001, practicalDensity * midEndDensityScale * densityMatchScale),
            endDensityScale: Number.isFinite(farTier.endDensityScale) ? Math.max(0.0, Math.min(1.0, farTier.endDensityScale)) : 1.0,
            eligibilityWeight: farBake.useEligibilityWeighting === false
                ? 0.0
                : (Number.isFinite(farBake.eligibilityWeight) ? Math.max(0.0, Math.min(1.0, farBake.eligibilityWeight)) : 0.6),
            maxAltitude: Number.isFinite(farBake.maxAltitude) ? farBake.maxAltitude : 2200.0,
            maxSlope: Number.isFinite(farBake.maxSlope) ? farBake.maxSlope : 0.65,
            heightMin: Number.isFinite(farTier.heightRange?.min) ? farTier.heightRange.min : 8.0,
            heightMax: Number.isFinite(farTier.heightRange?.max) ? farTier.heightRange.max : 22.0,
            coniferWidthRatio: Number.isFinite(farTier.widthToHeightRatio?.conifer)
                ? farTier.widthToHeightRatio.conifer
                : 0.25,
            deciduousWidthRatio: Number.isFinite(farTier.widthToHeightRatio?.deciduous)
                ? farTier.widthToHeightRatio.deciduous
                : 0.45,
            gridTable: farBake._gridTable || {},
            minGridDim: clampInt(farBake.minGridDim ?? 3, 1, 16),
            maxGridDim: clampInt(farBake.maxGridDim ?? 8, 1, 32),
            maxPackedTrees: clampInt(
                farTier.hull?.maxPackedTrees ?? farTier.hull?.packedCanopies ?? 4,
                1,
                6
            ),
            jitterScale: Number.isFinite(farBake.jitterScale) ? farBake.jitterScale : 0.72,
            neighborhoodRadius: Number.isFinite(farBake.neighborhoodRadius) ? farBake.neighborhoodRadius : 1.6,
            gradientNudge: Number.isFinite(farBake.gradientNudge) ? farBake.gradientNudge : 0.08,
            canopyFootprintMinScale: Number.isFinite(farBake.canopyFootprintMinScale) ? farBake.canopyFootprintMinScale : 0.90,
            canopyFootprintMaxScale: Number.isFinite(farBake.canopyFootprintMaxScale) ? farBake.canopyFootprintMaxScale : 1.18,
            groupRadiusMinFrac: Number.isFinite(farBake.groupRadiusMinFrac) ? farBake.groupRadiusMinFrac : 0.18,
            groupRadiusMaxFrac: Number.isFinite(farBake.groupRadiusMaxFrac) ? farBake.groupRadiusMaxFrac : 0.38,
            hull: { ...(farTier.hull || {}) },
            frag: { ...(farTier.frag || {}) },
        };

        this._sourceCache = null;
        this._renderBuffer = null;
        this._renderCountBuffer = null;
        this._gatherParamBuffer = null;
        this._renderParamBuffer = null;
        this._bakeParamBuffer = null;
        this._drawIndirectBuffer = null;
        this._tileMetadata = normalizeClusterTreeTileMetadata(config.clusterTreeTileMetadata);
        this._tileMetadataBuffer = null;

        this._bakePipeline = null;
        this._bakeBindGroupLayout = null;
        this._gatherPipeline = null;
        this._gatherBindGroupLayout = null;
        this._gatherBindGroup = null;
        this._gatherBindGroupDirty = true;
        this._indirectPipeline = null;
        this._indirectBindGroup = null;
        this._renderPipeline = null;
        this._renderBindGroupLayouts = [];
        this._renderBindGroups = [];
        this._renderBindGroupsDirty = true;

        this._geometry = null;
        this._initialized = false;
        this._zeroCount = new Uint32Array([0]);
        this._zeroDraw = new Uint32Array([0, 0, 0, 0, 0]);
        this._tmpProjectionMatrix = new Matrix4();
        this._tmpViewMatrix = new Matrix4();
        this._tmpViewProjectionMatrix = new Matrix4();
    }

    get enabled() {
        return this._cfg.enabled && this._initialized;
    }

    async initialize(tileCache) {
        if (this._initialized || !this._cfg.enabled) return;

        this._sourceCache = new ClusterSourceCache(this.device, {
            assetRegistry: this.streamer?._assetRegistry,
            tilePoolSize: this.streamer?.tileStreamer?.tilePoolSize ?? 1,
            clusterConfig: {
                enabled: this._cfg.enabled,
                perLayerCapacity: this._cfg.perLayerCapacity,
                maxBakesPerFrame: this._cfg.maxBakesPerFrame,
            },
        });
        this._sourceCache.initialize(tileCache);

        this._createBuffers();
        this._createGeometry();
        this._createPipelines();
        this._initialized = true;

        Logger.info(
            `${this._logTag} ready — farTier=[${this._tierRange.start},${this._tierRange.end}]m ` +
            `cap=${this._cfg.maxInstances} tileMeta=${this._tileMetadata.authoredTileCount}/` +
            `${this._tileMetadata.tileCount}`
        );
    }

    syncFromTileCache(tileCache, enqueueAll = false) {
        this._sourceCache?.syncFromTileCache(tileCache, enqueueAll);
    }

    applyCommitBatch(tileCache) {
        this._sourceCache?.applyCommitBatch(tileCache);
    }

    _createBuffers() {
        this._renderBuffer = this.device.createBuffer({
            label: 'ClusterTree-RenderInstances',
            size: Math.max(256, this._cfg.maxInstances * CLUSTER_RENDER_STRIDE),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this._renderCountBuffer = this.device.createBuffer({
            label: 'ClusterTree-RenderCount',
            size: 256,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });
        this._gatherParamBuffer = this.device.createBuffer({
            label: 'ClusterTree-GatherParams',
            size: 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this._renderParamBuffer = this.device.createBuffer({
            label: 'ClusterTree-RenderParams',
            size: 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this._bakeParamBuffer = this.device.createBuffer({
            label: 'ClusterTree-BakeParams',
            size: 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this._drawIndirectBuffer = this.device.createBuffer({
            label: 'ClusterTree-DrawIndirect',
            size: Math.max(256, 5 * Uint32Array.BYTES_PER_ELEMENT),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
        });
        this._tileMetadataBuffer = this.device.createBuffer({
            label: 'ClusterTree-TileBiomeMetadata',
            size: Math.max(256, this._tileMetadata.data.byteLength),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(this._tileMetadataBuffer, 0, this._tileMetadata.data);
        this.device.queue.writeBuffer(this._drawIndirectBuffer, 0, this._zeroDraw);
    }

    _createGeometry() {
        const lon = clampInt(this._cfg.hull.lonSegments ?? 10, 3, 32);
        const lat = clampInt(this._cfg.hull.latSegments ?? 6, 2, 24);
        const baseHull = MidNearGeometryBuilder.buildCanopyHull(lon, lat);
        const hull = buildPackedCanopyGeometry(baseHull, this._cfg.maxPackedTrees);

        this._geometry = {
            posBuffer: createVertexBuffer(this.device, hull.positions, 'ClusterTreeHull-Pos'),
            normBuffer: createVertexBuffer(this.device, hull.normals, 'ClusterTreeHull-Norm'),
            uvBuffer: createVertexBuffer(this.device, hull.uvs, 'ClusterTreeHull-UV'),
            canopyIdBuffer: createVertexBuffer(this.device, hull.canopyIds, 'ClusterTreeHull-CanopyId'),
            idxBuffer: createIndexBuffer(this.device, hull.indices, 'ClusterTreeHull-Idx'),
            indexCount: hull.indexCount,
        };
    }

    _createPipelines() {
        const textureFormats = this.streamer?.tileStreamer?.textureFormats || {};
        const heightSampleType = gpuFormatSampleType(textureFormats.height || 'r32float');
        const tileSampleType = gpuFormatSampleType(textureFormats.tile || 'r8unorm');
        const scatterSampleType = gpuFormatSampleType(textureFormats.scatter || 'r8unorm');

        const bakeModule = this.device.createShaderModule({
            label: 'ClusterTree-BakeShader',
            code: buildClusterTreeBakeShader({
                workgroupSize: 64,
                perLayerCapacity: this._cfg.perLayerCapacity,
                targetTreeDensity: this._cfg.targetTreeDensity,
                maxPackedTrees: this._cfg.maxPackedTrees,
                jitterScale: this._cfg.jitterScale,
                neighborhoodRadius: this._cfg.neighborhoodRadius,
                gradientNudge: this._cfg.gradientNudge,
                canopyFootprintMinScale: this._cfg.canopyFootprintMinScale,
                canopyFootprintMaxScale: this._cfg.canopyFootprintMaxScale,
                groupRadiusMinFrac: this._cfg.groupRadiusMinFrac,
                groupRadiusMaxFrac: this._cfg.groupRadiusMaxFrac,
            }),
        });

        this._bakeBindGroupLayout = this.device.createBindGroupLayout({
            label: 'ClusterTree-BakeLayout',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: heightSampleType, viewDimension: '2d' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: tileSampleType, viewDimension: '2d' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: scatterSampleType, viewDimension: '2d' } },
                { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
            ],
        });

        this._bakePipeline = this.device.createComputePipeline({
            label: 'ClusterTree-BakePipeline',
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [this._bakeBindGroupLayout],
            }),
            compute: { module: bakeModule, entryPoint: 'main' },
        });

        const gatherModule = this.device.createShaderModule({
            label: 'ClusterTree-GatherShader',
            code: buildClusterTreeGatherShader({
                workgroupSize: 64,
                perLayerCapacity: this._cfg.perLayerCapacity,
                maxInstances: this._cfg.maxInstances,
                endDensityScale: this._cfg.endDensityScale,
                layerMetaStride: CLUSTER_SOURCE_FLAGS.LAYER_META_U32_STRIDE,
            }),
        });

        this._gatherBindGroupLayout = this.device.createBindGroupLayout({
            label: 'ClusterTree-GatherLayout',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
            ],
        });

        this._gatherPipeline = this.device.createComputePipeline({
            label: 'ClusterTree-GatherPipeline',
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [this._gatherBindGroupLayout],
            }),
            compute: { module: gatherModule, entryPoint: 'main' },
        });

        const indirectModule = this.device.createShaderModule({
            label: 'ClusterTree-IndirectShader',
            code: /* wgsl */`
const INDEX_COUNT: u32 = ${this._geometry.indexCount}u;
const MAX_INSTANCES: u32 = ${this._cfg.maxInstances}u;

@group(0) @binding(0) var<storage, read> renderCount: array<u32>;
@group(0) @binding(1) var<storage, read_write> drawArgs: array<u32>;

@compute @workgroup_size(1)
fn main() {
    let count = min(renderCount[0], MAX_INSTANCES);
    drawArgs[0] = INDEX_COUNT;
    drawArgs[1] = count;
    drawArgs[2] = 0u;
    drawArgs[3] = 0u;
    drawArgs[4] = 0u;
}
`,
        });

        const indirectLayout = this.device.createBindGroupLayout({
            label: 'ClusterTree-IndirectLayout',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
            ],
        });

        this._indirectPipeline = this.device.createComputePipeline({
            label: 'ClusterTree-IndirectPipeline',
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [indirectLayout],
            }),
            compute: { module: indirectModule, entryPoint: 'main' },
        });

        this._indirectBindGroup = this.device.createBindGroup({
            label: 'ClusterTree-IndirectBG',
            layout: indirectLayout,
            entries: [
                { binding: 0, resource: { buffer: this._renderCountBuffer } },
                { binding: 1, resource: { buffer: this._drawIndirectBuffer } },
            ],
        });

        const shaders = buildClusterHullRenderShaders({
            ...(this._cfg.hull || {}),
            ...(this._cfg.frag || {}),
        });
        const vsModule = this.device.createShaderModule({ label: 'ClusterTree-HullVS', code: shaders.vs });
        const fsModule = this.device.createShaderModule({ label: 'ClusterTree-HullFS', code: shaders.fs });
        const canvasFormat = this.streamer?.backend?.sceneFormat || navigator.gpu.getPreferredCanvasFormat();

        this._renderBindGroupLayouts = [
            this.device.createBindGroupLayout({
                label: 'ClusterTree-RenderG0',
                entries: [
                    { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
                    { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
                ],
            }),
        ];

        this._renderPipeline = this.device.createRenderPipeline({
            label: 'ClusterTree-RenderPipeline',
            layout: this.device.createPipelineLayout({ bindGroupLayouts: this._renderBindGroupLayouts }),
            vertex: {
                module: vsModule,
                entryPoint: 'vsMain',
                buffers: [
                    { arrayStride: 12, stepMode: 'vertex', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
                    { arrayStride: 12, stepMode: 'vertex', attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
                    { arrayStride: 8, stepMode: 'vertex', attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x2' }] },
                    { arrayStride: 4, stepMode: 'vertex', attributes: [{ shaderLocation: 3, offset: 0, format: 'float32' }] },
                ],
            },
            fragment: {
                module: fsModule,
                entryPoint: 'fsMain',
                targets: [{ format: canvasFormat }],
            },
            primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
            depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
        });
    }

    _resolveClusterGridDim(tileWorldSize) {
        const table = this._cfg.gridTable || {};
        const snapped = roundTileWorldSize(tileWorldSize);
        const resolved = table[snapped];
        if (Number.isFinite(resolved)) {
            return clampInt(resolved, this._cfg.minGridDim, this._cfg.maxGridDim);
        }
        return this._cfg.minGridDim;
    }

    _getArrayTextures() {
        const arrayTextures = this.streamer?.tileStreamer?.getArrayTextures?.();
        return {
            height: arrayTextures?.height?._gpuTexture?.texture ?? null,
            tile: arrayTextures?.tile?._gpuTexture?.texture ?? null,
            scatter: arrayTextures?.scatter?._gpuTexture?.texture ?? null,
        };
    }

    _updateBakeParams(tile) {
        const data = new Float32Array(24);
        const u32 = new Uint32Array(data.buffer);
        const gridDim = this._resolveClusterGridDim(tile.tileWorldSize);

        u32[0] = tile.face >>> 0;
        u32[1] = tile.depth >>> 0;
        u32[2] = tile.tileX >>> 0;
        u32[3] = tile.tileY >>> 0;

        data[4] = this.streamer.planetConfig.origin.x;
        data[5] = this.streamer.planetConfig.origin.y;
        data[6] = this.streamer.planetConfig.origin.z;
        data[7] = this.streamer.planetConfig.radius;

        data[8] = this.streamer.quadtreeGPU?.faceSize ?? (this.streamer.planetConfig.radius * 2);
        data[9] = this.streamer.planetConfig.heightScale
            ?? this.streamer.planetConfig.maxHeight
            ?? this.streamer.planetConfig.maxTerrainHeight
            ?? 2000.0;
        data[10] = Number.isFinite(tile.tileWorldSize) && tile.tileWorldSize > 0
            ? tile.tileWorldSize
            : ((this.streamer.quadtreeGPU?.faceSize ?? (this.streamer.planetConfig.radius * 2)) / Math.max(1, 1 << tile.depth));
        u32[11] = tile.layer >>> 0;

        u32[12] = gridDim >>> 0;
        u32[13] = tile.flags >>> 0;
        data[14] = this._cfg.minDensity;
        data[15] = this._cfg.eligibilityWeight;

        data[16] = this._cfg.maxAltitude;
        data[17] = this._cfg.maxSlope;
        data[18] = this._cfg.heightMin;
        data[19] = this._cfg.heightMax;

        data[20] = this._cfg.coniferWidthRatio;
        data[21] = this._cfg.deciduousWidthRatio;
        data[22] = 0.0;
        data[23] = 0.0;

        this.device.queue.writeBuffer(this._bakeParamBuffer, 0, data);
        return gridDim;
    }

    _dispatchBakes(commandEncoder) {
        if (!this._sourceCache?.enabled || this._sourceCache.pendingBakes === 0) {
            return false;
        }

        const gpu = this._getArrayTextures();
        if (!gpu.height || !gpu.tile || !gpu.scatter) {
            return false;
        }

        const batch = this._sourceCache.popBakeBatch(this._cfg.maxBakesPerFrame);
        if (batch.length === 0) {
            return false;
        }

        for (const tile of batch) {
            const zero = new Uint32Array([0]);
            this.device.queue.writeBuffer(
                this._sourceCache.counterBuffer,
                tile.layer * Uint32Array.BYTES_PER_ELEMENT,
                zero
            );

            const gridDim = this._updateBakeParams(tile);
            const bindGroup = this.device.createBindGroup({
                layout: this._bakeBindGroupLayout,
                entries: [
                    { binding: 0, resource: { buffer: this._bakeParamBuffer } },
                    { binding: 1, resource: gpu.height.createView({ dimension: '2d', baseArrayLayer: tile.layer, arrayLayerCount: 1 }) },
                    { binding: 2, resource: gpu.tile.createView({ dimension: '2d', baseArrayLayer: tile.layer, arrayLayerCount: 1 }) },
                    { binding: 3, resource: gpu.scatter.createView({ dimension: '2d', baseArrayLayer: tile.layer, arrayLayerCount: 1 }) },
                    { binding: 4, resource: { buffer: this._sourceCache.instanceBuffer } },
                    { binding: 5, resource: { buffer: this._sourceCache.counterBuffer } },
                    { binding: 6, resource: { buffer: this._tileMetadataBuffer } },
                ],
            });

            const pass = commandEncoder.beginComputePass({ label: `ClusterTree-Bake-L${tile.layer}` });
            pass.setPipeline(this._bakePipeline);
            pass.setBindGroup(0, bindGroup);
            pass.dispatchWorkgroups(Math.ceil((gridDim * gridDim) / 64));
            pass.end();

            if (this._cfg.logDispatches) {
                Logger.info(
                    `${this._logTag} bake f${tile.face} d${tile.depth} (${tile.tileX},${tile.tileY}) ` +
                    `layer=${tile.layer} flags=0x${tile.flags.toString(16)} grid=${gridDim}`
                );
            }
        }
        return true;
    }

    _maybeRebuildGatherBindGroup() {
        if (!this._gatherBindGroupDirty || !this._sourceCache?.enabled) return;
        this._gatherBindGroup = this.device.createBindGroup({
            layout: this._gatherBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this._gatherParamBuffer } },
                { binding: 1, resource: { buffer: this._sourceCache.activeLayerBuffer } },
                { binding: 2, resource: { buffer: this._sourceCache.layerMetaBuffer } },
                { binding: 3, resource: { buffer: this._sourceCache.counterBuffer } },
                { binding: 4, resource: { buffer: this._sourceCache.instanceBuffer } },
                { binding: 5, resource: { buffer: this._renderBuffer } },
                { binding: 6, resource: { buffer: this._renderCountBuffer } },
            ],
        });
        this._gatherBindGroupDirty = false;
    }

    _updateGatherParams(camera) {
        const cam = camera?.position || this.streamer?.uniformManager?.camera?.position || { x: 0, y: 0, z: 0 };
        const data = new Float32Array(12);
        const u32 = new Uint32Array(data.buffer);

        data[0] = cam.x;
        data[1] = cam.y;
        data[2] = cam.z;
        data[3] = 0.0;

        data[4] = this._tierRange.start;
        data[5] = this._tierRange.end;
        data[6] = this._tierRange.fadeInWidth;
        data[7] = this._tierRange.fadeOutWidth;

        u32[8] = this._sourceCache.activeLayerCount >>> 0;
        u32[9] = this._cfg.maxInstances >>> 0;
        u32[10] = 0;
        u32[11] = 0;

        this.device.queue.writeBuffer(this._gatherParamBuffer, 0, data);
    }

    _updateRenderParams(camera, viewMatrix, projectionMatrix) {
        const cam = camera?.position || { x: 0, y: 0, z: 0 };
        const sun = this.streamer?.uniformManager?.uniforms?.sunLightDirection?.value || { x: 0, y: 1, z: 0 };
        const vp = this._tmpViewProjectionMatrix.multiplyMatrices(
            this._tmpProjectionMatrix.fromArray(projectionMatrix?.elements || ZERO_MAT4_ELEMENTS),
            this._tmpViewMatrix.fromArray(viewMatrix?.elements || ZERO_MAT4_ELEMENTS)
        ).elements;

        const data = new Float32Array(28);
        data.set(vp, 0);
        data[16] = cam.x;
        data[17] = cam.y;
        data[18] = cam.z;
        data[19] = 0.0;
        data[20] = this.streamer.planetConfig.origin.x;
        data[21] = this.streamer.planetConfig.origin.y;
        data[22] = this.streamer.planetConfig.origin.z;
        data[23] = 0.0;
        data[24] = sun.x ?? 0;
        data[25] = sun.y ?? 1;
        data[26] = sun.z ?? 0;
        data[27] = 0.0;
        this.device.queue.writeBuffer(this._renderParamBuffer, 0, data);
    }

    _maybeRebuildRenderBindGroups() {
        if (!this._renderBindGroupsDirty) return;
        this._renderBindGroups = [
            this.device.createBindGroup({
                layout: this._renderBindGroupLayouts[0],
                entries: [
                    { binding: 0, resource: { buffer: this._renderParamBuffer } },
                    { binding: 1, resource: { buffer: this._renderBuffer } },
                ],
            }),
        ];
        this._renderBindGroupsDirty = false;
    }

    update(commandEncoder, camera) {
        if (!this._initialized || !this._cfg.enabled) return;

        const bakedThisFrame = this._dispatchBakes(commandEncoder);
        this._maybeRebuildGatherBindGroup();
        if (!this._gatherBindGroup || this._sourceCache.activeLayerCount === 0) {
            this.device.queue.writeBuffer(this._drawIndirectBuffer, 0, this._zeroDraw);
            return;
        }

        this.device.queue.writeBuffer(this._renderCountBuffer, 0, this._zeroCount);
        this._updateGatherParams(camera);

        {
            const pass = commandEncoder.beginComputePass({ label: 'ClusterTree-Gather' });
            pass.setPipeline(this._gatherPipeline);
            pass.setBindGroup(0, this._gatherBindGroup);
            pass.dispatchWorkgroups(this._sourceCache.activeLayerCount);
            pass.end();
        }

        {
            const pass = commandEncoder.beginComputePass({ label: 'ClusterTree-Indirect' });
            pass.setPipeline(this._indirectPipeline);
            pass.setBindGroup(0, this._indirectBindGroup);
            pass.dispatchWorkgroups(1);
            pass.end();
        }

        if (bakedThisFrame && this._cfg.logDispatches) {
            Logger.info(
                `${this._logTag} gathered ${this._sourceCache.activeLayerCount} layers ` +
                `(farTier=${this._tierRange.start}-${this._tierRange.end})`
            );
        }
    }

    render(encoder, camera, viewMatrix, projectionMatrix) {
        if (!this._initialized || !this._cfg.enabled || !encoder) return;
        this._updateRenderParams(camera, viewMatrix, projectionMatrix);
        this._maybeRebuildRenderBindGroups();
        if (this._renderBindGroups.length === 0) return;

        encoder.setPipeline(this._renderPipeline);
        encoder.setBindGroup(0, this._renderBindGroups[0]);
        encoder.setVertexBuffer(0, this._geometry.posBuffer);
        encoder.setVertexBuffer(1, this._geometry.normBuffer);
        encoder.setVertexBuffer(2, this._geometry.uvBuffer);
        encoder.setVertexBuffer(3, this._geometry.canopyIdBuffer);
        encoder.setIndexBuffer(this._geometry.idxBuffer, 'uint16');
        encoder.drawIndexedIndirect(this._drawIndirectBuffer, 0);
    }

    dispose() {
        this._sourceCache?.dispose();
        this._sourceCache = null;
        for (const buffer of [
            this._renderBuffer,
            this._renderCountBuffer,
            this._gatherParamBuffer,
            this._renderParamBuffer,
            this._bakeParamBuffer,
            this._drawIndirectBuffer,
            this._tileMetadataBuffer,
        ]) {
            buffer?.destroy();
        }

        for (const geoBuffer of [
            this._geometry?.posBuffer,
            this._geometry?.normBuffer,
            this._geometry?.uvBuffer,
            this._geometry?.canopyIdBuffer,
            this._geometry?.idxBuffer,
        ]) {
            geoBuffer?.destroy();
        }

        this._renderBuffer = null;
        this._renderCountBuffer = null;
        this._gatherParamBuffer = null;
        this._renderParamBuffer = null;
        this._bakeParamBuffer = null;
        this._drawIndirectBuffer = null;
        this._tileMetadataBuffer = null;
        this._geometry = null;
        this._initialized = false;
    }
}
