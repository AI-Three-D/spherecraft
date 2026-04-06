// js/renderer/streamer/TreeFarSystem.js
//
// Hull-only Far-distance tree tier. Replaces TreeMidNearSystem.

import { Logger } from '../../../shared/Logger.js';
import { MidNearGeometryBuilder } from './MidNearGeometryBuilder.js';
import { MidNearTextureBaker } from './MidNearTextureBaker.js';

import {

    buildFarHullVertexShader,
    buildFarHullFragmentShader,
} from './shaders/farTreeRender.wgsl.js';

const FAR_TREE_RENDER_BYTES = 80;


function resolveMidTierConfig(midConfigOverride, midTierConfig) {
    const base = JSON.parse(JSON.stringify(midTierConfig));
    const override = midConfigOverride || {};
    return {
        ...base,
        ...override,
        hull: {
            ...base.hull,
            ...(override.hull || {}),
        },
        hullFrag: {
            ...base.hullFrag,
            ...(override.hullFrag || {}),
        },
    };
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

export class TreeFarSystem {
    constructor(device, assetStreamer, config = {}) {
        this.device = device;
        this.streamer = assetStreamer;
        const streamerTheme = assetStreamer?._streamerTheme;
        if (!streamerTheme) {
            throw new Error('[TreeFarSystem] requires assetStreamer with _streamerTheme');
        }
        this._streamerTheme = streamerTheme;
        this.LODS_PER_CATEGORY = streamerTheme.LODS_PER_CATEGORY;
        this.CAT_TREES = streamerTheme.CAT_TREES;
        this.TREE_TIER_RANGES = streamerTheme.TREE_TIER_RANGES;
        this.MID_TIER_CONFIG = streamerTheme.MID_TIER_CONFIG;
        this.SPECIES_CANOPY_PROFILES = streamerTheme.SPECIES_CANOPY_PROFILES;
        this._configOverride = {
            tierRange: config.tierRange ? { ...config.tierRange } : null,
            midConfig: config.midConfig ? JSON.parse(JSON.stringify(config.midConfig)) : null,
            speciesProfiles: config.speciesProfiles
                ? JSON.parse(JSON.stringify(config.speciesProfiles))
                : null,
        };

        
        // lodController is only used for detailRange (near-tier boundary)
        // to compute the crossfade overlap. All Far-tier config comes
        // from treeTierConfig.js.
        this.lodController = config.lodController;
        if (!this.lodController) {
            throw new Error('[TreeFarSystem] lodController is required');
        }

        // Snapshot config at construction. rebuildPipelines() re-reads.
        this._range = {
            ...(this.TREE_TIER_RANGES.farTrees || this.TREE_TIER_RANGES.mid),
            ...(this._configOverride.tierRange || {}),
        };
        this._cfg = resolveMidTierConfig(this._configOverride.midConfig, this.MID_TIER_CONFIG);
        this._speciesProfiles = {
            ...JSON.parse(JSON.stringify(this.SPECIES_CANOPY_PROFILES)),
            ...(this._configOverride.speciesProfiles || {}),
        };
        this._applyFarOverrides();
        this.maxTrees = this._cfg.maxTrees;
        // Far clone starts from Far-tier logic but should be much cheaper.
        // Keep the producer/tracker path the same; only simplify render cost.
        this._cfg.hull = {
            ...this._cfg.hull,
            lonSegments: Math.min(this._cfg.hull.lonSegments ?? 12, 6),
            latSegments: Math.min(this._cfg.hull.latSegments ?? 8, 4),
            vsAnchorSamples: Math.min(this._cfg.hull.vsAnchorSamples ?? 8, 2),
            lumpNearScale: 0.35,
            lumpFarScale: 0.15,
            lumpNearDistance: 600.0,
            lumpFarDistance: 1400.0,
            inflation: 0.92,
            shrinkWrap: 0.30,
            gapShrink: 0.82,
            verticalBias: 1.05,
            topShrinkStart: 0.72,
            topShrinkStrength: 0.18,
            
        };
        this._cfg.hull = {
            maxPackedTrees: 4,
            ...this._cfg.hull,
        };

        this._cfg.hullFrag = {
            ...this._cfg.hullFrag,
            baseCoverageNear: 0.78,
            baseCoverageFar: 0.88,
            subbandSplit: 900.0,
            subbandBlend: 240.0,
            subbandFarDamp: 0.85,
            coverageNoiseAmp: 0.10,
            coverageNoiseScale: 1.6,
            macroGapStrength: 0.06,
            edgeNoiseAmp: 0.06,
            edgeBaseThin: 0.04,
            edgeRimBoost: 0.04,
            bottomBreak: 0.03,
            bumpStrength: 0.05,
            brightness: 1.0,
        };

        // ── GPU resources ──────────────────────────────────────────────────
        this._treeBuffer = null;
        this._treeCountBuffer = null;

        this._assetSpeciesCount = 0;

        this._hullIndirectBuffer = null;

        this._hullGeo = null;
        this._texBaker = null;

        this._gatherParamBuffer = null;
        this._gatherPipeline = null;
        this._gatherBGL = null;
        this._gatherBG = null;
        this._gatherBGDirty = true;

        this._sourceCache = null;

        this._indirectPipeline = null;
        this._indirectBG = null;

        this._hullPipeline = null;
        this._hullBGLs = [];
        this._hullBGs = [];
        this._hullBGsDirty = true;

        // ── Source bands (tree pool LOD slices we scan) ────────────────────

   
        this._enabled = true;
        this._frameCount = 0;
        this._countReset = new Uint32Array([0]);
        this._countReadbackBuffer = null;
        this._countReadbackQueued = false;
        this._countReadbackPending = false;
        this._initialized = false;
    }
    async initialize() {
        if (this._initialized) return;

        // ── DBG: initialize entry ───────────────────────────────────────────
        Logger.warn(
            `[TreeFarSystem] initialize START — ` +
            `range=${JSON.stringify(this._range)} ` +
            `maxTrees=${this.maxTrees} ` +
            `hull=${this._cfg.hull.lonSegments}×${this._cfg.hull.latSegments} ` +
            `maxPackedTrees=${this._cfg.hull.maxPackedTrees} ` +
            `streamer._farTreeSourceCache=${!!this.streamer._farTreeSourceCache} ` +
            `farSourceCache.enabled=${this.streamer._farTreeSourceCache?.enabled} ` +
            `farSourceCache.initialized=${this.streamer._farTreeSourceCache?._initialized}`
        );
        // ───────────────────────────────────────────────────────────────────

        this._sourceCache = this.streamer._farTreeSourceCache;

        this._createBuffers();
        Logger.warn(`[TreeFarSystem] initialize: buffers created — treeBuffer=${!!this._treeBuffer} treeCountBuffer=${!!this._treeCountBuffer} indirectBuffer=${!!this._hullIndirectBuffer}`);

        this._buildGeometry();
        Logger.warn(`[TreeFarSystem] initialize: geometry built — idxCount=${this._hullGeo?.idxCount} posBuffer=${!!this._hullGeo?.posBuffer}`);

        await this._bakeTextures();
        Logger.warn(`[TreeFarSystem] initialize: textures baked — texBaker.isReady=${this._texBaker?.isReady?.()}`);

        this._createGatherPipeline();
        Logger.warn(`[TreeFarSystem] initialize: gather pipeline=${!!this._gatherPipeline} BGL=${!!this._gatherBGL}`);

        this._createIndirectPipeline();
        Logger.warn(`[TreeFarSystem] initialize: indirect pipeline=${!!this._indirectPipeline} BG=${!!this._indirectBG}`);

        this._createRenderPipelines();
        Logger.warn(`[TreeFarSystem] initialize: hull render pipeline=${!!this._hullPipeline} hasTex=${this._hasTex}`);

        this._initialized = true;
        Logger.warn(`[TreeFarSystem] initialize COMPLETE`);
    }

    rebuildPipelines(options = {}) {
        if (!this._initialized) return;
        this._range = {
            ...(this.TREE_TIER_RANGES.farTrees || this.TREE_TIER_RANGES.mid),
            ...(this._configOverride.tierRange || {}),
        };
        this._cfg = resolveMidTierConfig(this._configOverride.midConfig, this.MID_TIER_CONFIG);
        this._speciesProfiles = {
            ...JSON.parse(JSON.stringify(this.SPECIES_CANOPY_PROFILES)),
            ...(this._configOverride.speciesProfiles || {}),
        };
        this._applyFarOverrides();
        this.maxTrees = this._cfg.maxTrees;
        if (options.rebuildGeometry) {
            const geo = this._hullGeo;
            if (geo) {
                geo.posBuffer?.destroy();
                geo.normBuffer?.destroy();
                geo.uvBuffer?.destroy();
                geo.canopyIdBuffer?.destroy();
                geo.idxBuffer?.destroy();
            }
            this._hullGeo = null;
            this._buildGeometry();
        }
    
        this._sourceCache = this.streamer._farTreeSourceCache;
    
        this._gatherPipeline = null;
        this._gatherBGL = null;
        this._gatherBG = null;
        this._gatherBGDirty = true;
    
        this._indirectPipeline = null;
        this._indirectBG = null;
    
        this._createGatherPipeline();
        this._createIndirectPipeline();
        this._createRenderPipelines();
    
        this._hullBGsDirty = true;
    
        Logger.info(`[TreeFarSystem] Pipelines rebuilt${options.rebuildGeometry ? ' (with geometry)' : ''}`);
    }

    _createGatherPipeline() {
        // ── DBG ─────────────────────────────────────────────────────────────
        Logger.warn(
            `[TreeFarSystem] _createGatherPipeline — ` +
            `sourceCache=${!!this._sourceCache} ` +
            `sourceCache.enabled=${this._sourceCache?.enabled} ` +
            `sourceCache.initialized=${this._sourceCache?._initialized} ` +
            `sourceCache.perLayerCapacity=${this._sourceCache?.perLayerCapacity}`
        );
        // ───────────────────────────────────────────────────────────────────
        if (!this._sourceCache?.enabled) {
            Logger.warn(`[TreeFarSystem] _createGatherPipeline: SKIPPED — sourceCache not enabled`);
            this._gatherPipeline = null;
            this._gatherBGL = null;
            this._gatherBG = null;
            return;
        }
        Logger.warn(`[TreeFarSystem] _createGatherPipeline: creating gather pipeline (perLayerCapacity=${this._sourceCache.perLayerCapacity})`);
    
        const WORKGROUP_SIZE = 64;
    
        const code = /* wgsl */`
    struct GatherParams {
        cameraPosition : vec3<f32>,
        maxTrees       : u32,
    
        fadeInStart    : f32,
        fadeInEnd      : f32,
        fadeOutStart   : f32,
        fadeOutEnd     : f32,
    };
    
    struct FarTreeSource {
        // 64 B baked record from FarTreeSourceCache
        worldPosX      : f32,
        worldPosY      : f32,
        worldPosZ      : f32,
        rotation       : f32,
    
        canopyCenterX  : f32,
        canopyCenterY  : f32,
        canopyCenterZ  : f32,
        packedCount    : f32,
    
        canopyExtentX  : f32,
        canopyExtentY  : f32,
        canopyExtentZ  : f32,
        scale          : f32,
    
        foliageR       : f32,
        foliageG       : f32,
        foliageB       : f32,
        seedF          : f32,
    };
    
    struct FarTreeRender {
        // Row 0
        worldPosX      : f32,
        worldPosY      : f32,
        worldPosZ      : f32,
        rotation       : f32,
    
        // Row 1
        canopyCenterX  : f32,
        canopyCenterY  : f32,
        canopyCenterZ  : f32,
        packedCount    : f32,
    
        // Row 2
        canopyExtentX  : f32,
        canopyExtentY  : f32,
        canopyExtentZ  : f32,
        scale          : f32,
    
        // Row 3
        foliageR       : f32,
        foliageG       : f32,
        foliageB       : f32,
        seedF          : f32,
    
        // Row 4
        distToCam      : f32,
        tierFade       : f32,
        groupRadius    : f32,
        _pad0          : f32,
    };
    
    struct Counter {
        value : atomic<u32>,
    };
    
    @group(0) @binding(0) var<uniform> gatherParams : GatherParams;
    @group(0) @binding(1) var<storage, read> activeLayers : array<u32>;
    @group(0) @binding(2) var<storage, read> sourceTrees : array<FarTreeSource>;
    @group(0) @binding(3) var<storage, read> sourceCounts : array<u32>;
    @group(0) @binding(4) var<storage, read_write> renderTrees : array<FarTreeRender>;
    @group(0) @binding(5) var<storage, read_write> renderCount : Counter;

    fn saturate(x: f32) -> f32 {
        return clamp(x, 0.0, 1.0);
    }
    
    fn safeFade(startD: f32, endD: f32, d: f32) -> f32 {
        let span = max(endD - startD, 0.0001);
        return saturate((d - startD) / span);
    }
    
    fn computeTierFade(d: f32) -> f32 {
        let fadeIn = safeFade(gatherParams.fadeInStart, gatherParams.fadeInEnd, d);
        let fadeOut = 1.0 - safeFade(gatherParams.fadeOutStart, gatherParams.fadeOutEnd, d);
        return saturate(fadeIn * fadeOut);
    }
    
    fn computeGroupRadius(extentX: f32, extentZ: f32, packedCountF: f32, scale: f32) -> f32 {
        let packedCount = max(u32(packedCountF + 0.5), 1u);
        if (packedCount <= 1u) {
            return 0.0;
        }
    
        let canopyRadius = max(extentX, extentZ);
        let scaleRadius = max(scale, 0.0) * 0.35;
        return max(canopyRadius * 0.9, scaleRadius);
    }
    
    @compute @workgroup_size(${WORKGROUP_SIZE})
    fn main(
        @builtin(workgroup_id) workgroupId : vec3<u32>,
        @builtin(local_invocation_id) localId : vec3<u32>
    ) {
        let activeIdx = workgroupId.x;
        let layer = activeLayers[activeIdx];
        let srcCount = sourceCounts[layer];
        if (srcCount == 0u) {
            return;
        }
    
        let layerBase = layer * ${this._sourceCache.perLayerCapacity}u;
    
        var i = localId.x;
        loop {
            if (i >= srcCount) {
                break;
            }
    
            let src = sourceTrees[layerBase + i];
            let worldPos = vec3<f32>(src.worldPosX, src.worldPosY, src.worldPosZ);
            let dist = distance(worldPos, gatherParams.cameraPosition);
            let tierFade = computeTierFade(dist);
    
            if (tierFade > 0.0001) {
                let dstIndex = atomicAdd(&renderCount.value, 1u);
                if (dstIndex < gatherParams.maxTrees) {
                    var dst : FarTreeRender;
    
                    dst.worldPosX = src.worldPosX;
                    dst.worldPosY = src.worldPosY;
                    dst.worldPosZ = src.worldPosZ;
                    dst.rotation = src.rotation;
    
                    dst.canopyCenterX = src.canopyCenterX;
                    dst.canopyCenterY = src.canopyCenterY;
                    dst.canopyCenterZ = src.canopyCenterZ;
                    dst.packedCount = src.packedCount;
    
                    dst.canopyExtentX = src.canopyExtentX;
                    dst.canopyExtentY = src.canopyExtentY;
                    dst.canopyExtentZ = src.canopyExtentZ;
                    dst.scale = src.scale;
    
                    dst.foliageR = src.foliageR;
                    dst.foliageG = src.foliageG;
                    dst.foliageB = src.foliageB;
                    dst.seedF = src.seedF;
    
                    dst.distToCam = dist;
                    dst.tierFade = tierFade;
                    dst.groupRadius = computeGroupRadius(
                        src.canopyExtentX,
                        src.canopyExtentZ,
                        src.packedCount,
                        src.scale
                    );
                    dst._pad0 = 0.0;
    
                    renderTrees[dstIndex] = dst;
                }
            }
    
            i += ${WORKGROUP_SIZE}u;
        }
    }
    `;
    
        const mod = this.device.createShaderModule({
            label: 'FarTree-Gather-SM',
            code,
        });
    
        this._gatherBGL = this.device.createBindGroupLayout({
            label: 'FarTree-Gather-BGL',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
            ],
        });
    
        this._gatherPipeline = this.device.createComputePipeline({
            label: 'FarTree-Gather-Pipeline',
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [this._gatherBGL],
            }),
            compute: {
                module: mod,
                entryPoint: 'main',
            },
        });
    
        this._gatherBGDirty = true;
    }

    _updateGatherParams(camera) {
        if (!this._gatherParamBuffer) return;
    
        const camPos =
            this.streamer?.uniformManager?.camera?.position ||
            camera?.position || { x: 0, y: 0, z: 0 };
    
        const r = this._range || {};
        const fadeInStart = Number.isFinite(r.start) ? r.start : 0.0;
        const fadeInEnd = fadeInStart + Math.max(0.0001, r.fadeInWidth ?? 0.0);
        const fadeOutEnd = Number.isFinite(r.end) ? r.end : 1e9;
        const fadeOutStart = fadeOutEnd - Math.max(0.0001, r.fadeOutWidth ?? 0.0);
    
        const data = new ArrayBuffer(32);
        const f32 = new Float32Array(data);
        const u32 = new Uint32Array(data);
    
        f32[0] = camPos.x ?? 0;
        f32[1] = camPos.y ?? 0;
        f32[2] = camPos.z ?? 0;
        u32[3] = this.maxTrees >>> 0;
    
        f32[4] = fadeInStart;
        f32[5] = fadeInEnd;
        f32[6] = fadeOutStart;
        f32[7] = fadeOutEnd;
    
        this.device.queue.writeBuffer(this._gatherParamBuffer, 0, data);
    }


    _createBuffers() {
        this._treeBuffer = this.device.createBuffer({
            label: 'Far-Trees',
            size: Math.max(256, this.maxTrees * FAR_TREE_RENDER_BYTES),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });
    
        this._treeCountBuffer = this.device.createBuffer({
            label: 'Far-TreeCount',
            size: 256,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });
    
        this._gatherParamBuffer = this.device.createBuffer({
            label: 'FarTree-GatherParams',
            size: 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
    
        this._hullIndirectBuffer = this.device.createBuffer({
            label: 'Far-HullIndirect',
            size: Math.max(256, 5 * 4),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
        });
    }

    _buildGeometry() {
        const h = this._cfg.hull;

        const baseHull = MidNearGeometryBuilder.buildCanopyHull(h.lonSegments, h.latSegments);
        const packedHull = buildPackedCanopyGeometry(
            baseHull,
            Math.max(1, h.maxPackedTrees ?? 4)
        );

        const mkVB = (data, label) => {
            const b = this.device.createBuffer({
                label,
                size: Math.max(16, data.byteLength),
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
                mappedAtCreation: true,
            });
            new Float32Array(b.getMappedRange(0, data.byteLength)).set(data);
            b.unmap();
            return b;
        };

        const mkIB = (data, label) => {
            const aligned = Math.ceil(data.byteLength / 4) * 4;
            const b = this.device.createBuffer({
                label,
                size: Math.max(16, aligned),
                usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
                mappedAtCreation: true,
            });
            new Uint16Array(b.getMappedRange(0, data.byteLength)).set(data);
            b.unmap();
            return b;
        };

        this._hullGeo = {
            posBuffer: mkVB(packedHull.positions, 'FarHull-Pos'),
            normBuffer: mkVB(packedHull.normals, 'FarHull-Norm'),
            uvBuffer: mkVB(packedHull.uvs, 'FarHull-UV'),
            canopyIdBuffer: mkVB(packedHull.canopyIds, 'FarHull-CanopyId'),
            idxBuffer: mkIB(packedHull.indices, 'FarHull-Idx'),
            idxCount: packedHull.indexCount,
        };
    }

    async _bakeTextures() {
        // Reuse the Far-near texture baker for now. Its canopy layer 0
        // is a generic leafy noise texture which works fine for the hull FS.
        const procGen = this.streamer?.propTextureManager?.proceduralTextureGenerator ?? null;
        this._texBaker = new MidNearTextureBaker(this.device, procGen, {
            textureSize: 256,   // smaller — we sample triplanar at distance, mip does the rest
            seed: (this.streamer.engineConfig?.seed ?? 12345) ^ 0x1D7E11,
        });
        await this._texBaker.initialize();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Pipeline creation
    // ═══════════════════════════════════════════════════════════════════════

    _createIndirectPipeline() {
        const code = /* wgsl */`
            const HULL_INDEX_COUNT: u32 = ${this._hullGeo.idxCount}u;
            const MAX_TREES: u32 = ${this.maxTrees}u;

            @group(0) @binding(0) var<storage, read> treeCount: array<u32>;
            @group(0) @binding(1) var<storage, read_write> hullIndirect: array<u32>;

            @compute @workgroup_size(1)
            fn main() {
                let tc = min(treeCount[0], MAX_TREES);
                hullIndirect[0] = HULL_INDEX_COUNT;
                hullIndirect[1] = tc;
                hullIndirect[2] = 0u;
                hullIndirect[3] = 0u;
                hullIndirect[4] = 0u;
            }
        `;
        const mod = this.device.createShaderModule({ label: 'FarIndirect-SM', code });
        const bgl = this.device.createBindGroupLayout({
            label: 'FarIndirect-BGL',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
            ],
        });
        this._indirectPipeline = this.device.createComputePipeline({
            label: 'FarIndirect-Pipeline',
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
            compute: { module: mod, entryPoint: 'main' },
        });
        this._indirectBG = this.device.createBindGroup({
            label: 'FarIndirect-BG', layout: bgl,
            entries: [
                { binding: 0, resource: { buffer: this._treeCountBuffer } },
                { binding: 1, resource: { buffer: this._hullIndirectBuffer } },
            ],
        });
    }
    _applyFarOverrides() {
        this._cfg.hull = {
            ...this._cfg.hull,
            lonSegments: Math.min(this._cfg.hull.lonSegments ?? 12, 6),
            latSegments: Math.min(this._cfg.hull.latSegments ?? 8, 4),
            vsAnchorSamples: Math.min(this._cfg.hull.vsAnchorSamples ?? 8, 2),
            lumpNearScale: 0.35,
            lumpFarScale: 0.15,
            lumpNearDistance: 600.0,
            lumpFarDistance: 1400.0,
            inflation: 0.92,
            shrinkWrap: 0.30,
            gapShrink: 0.82,
            verticalBias: 1.05,
            topShrinkStart: 0.72,
            topShrinkStrength: 0.18,
        };

        this._cfg.hull = {
            maxPackedTrees: 4,
            ...this._cfg.hull,
        };

        this._cfg.hullFrag = {
            ...this._cfg.hullFrag,
            baseCoverageNear: 0.78,
            baseCoverageFar: 0.88,
            subbandSplit: 900.0,
            subbandBlend: 240.0,
            subbandFarDamp: 0.85,
            coverageNoiseAmp: 0.10,
            coverageNoiseScale: 1.6,
            macroGapStrength: 0.06,
            edgeNoiseAmp: 0.06,
            edgeBaseThin: 0.04,
            edgeRimBoost: 0.04,
            bottomBreak: 0.03,
            bumpStrength: 0.05,
            brightness: 1.0,
        };
    }

    _createRenderPipelines() {
        const hasTex = this._texBaker?.isReady() === true;
        const canvasFormat = navigator.gpu.getPreferredCanvasFormat();

        const r = this._range;
        const fadeBounds = {
            fadeInStart: r.start,
            fadeInEnd: r.start + r.fadeInWidth,
            fadeOutStart: r.end - r.fadeOutWidth,
            fadeOutEnd: r.end,
        };

        const triListCCWBack = { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' };
        const depthLess = { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' };
        const vertexBuffers = [
            { arrayStride: 12, stepMode: 'vertex', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
            { arrayStride: 12, stepMode: 'vertex', attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
            { arrayStride: 8,  stepMode: 'vertex', attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x2' }] },
            { arrayStride: 4,  stepMode: 'vertex', attributes: [{ shaderLocation: 3, offset: 0, format: 'float32' }] },
        ];

        // ── Hull ───────────────────────────────────────────────────────────
        {
            const farHullVS = buildFarHullVertexShader({
                maxPackedTrees: this._cfg.hull.maxPackedTrees,
            });

            const vsMod = this.device.createShaderModule({
                label: 'FarHull-VS',
                code: farHullVS,
            });

            const farHullFS = buildFarHullFragmentShader({
                ...fadeBounds,
                ...this._cfg.hullFrag,
                enableCanopyTexture: hasTex,
                debugMagenta: true,
            });

            const fsMod = this.device.createShaderModule({
                label: 'FarHull-FS',
                code: farHullFS,
            });

            const g0 = this.device.createBindGroupLayout({
                label: 'FarHull-G0',
                entries: [
                    { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
                    { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
                    { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
                ],
            });

            const g1Entries = [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            ];
            if (hasTex) {
                g1Entries.push(
                    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
                    { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
                );
            }

            const g1 = this.device.createBindGroupLayout({
                label: 'FarHull-G1',
                entries: g1Entries
            });

            this._hullBGLs = [g0, g1];

            this._hullPipeline = this.device.createRenderPipeline({
                label: 'FarHull-Pipeline',
                layout: this.device.createPipelineLayout({ bindGroupLayouts: this._hullBGLs }),
                vertex: { module: vsMod, entryPoint: 'main', buffers: vertexBuffers },
                fragment: { module: fsMod, entryPoint: 'main', targets: [{ format: canvasFormat }] },
                primitive: triListCCWBack,
                depthStencil: depthLess,
            });
        }

        this._hasTex = hasTex;
    }



    _maybeRebuildRenderBGs() {
        // ── DBG ─────────────────────────────────────────────────────────────
        if (this._hullBGsDirty) {
            const s = this.streamer;
            const templateLib = s._templateLibrary;
            const anchorBuffer = templateLib?.getAnchorBuffer?.();
            const texView = this._hasTex ? this._texBaker?.getTextureView?.() : '(tex disabled)';
            const sampler = this._hasTex ? this._texBaker?.getSampler?.() : '(tex disabled)';
            Logger.warn(
                `[TreeFarSystem] _maybeRebuildRenderBGs — ` +
                `uniformBuffer=${!!s._uniformBuffer} fragUniformBuffer=${!!s._fragUniformBuffer} ` +
                `templateLib=${!!templateLib} anchorBuffer=${!!anchorBuffer} ` +
                `hasTex=${this._hasTex} texView=${!!texView} sampler=${!!sampler} ` +
                `hullBGLs.length=${this._hullBGLs.length} treeBuffer=${!!this._treeBuffer}`
            );
            if (!anchorBuffer) {
                Logger.warn(`[TreeFarSystem] _maybeRebuildRenderBGs: BLOCKED — anchorBuffer is null (templateLibrary may not have uploaded GPU data yet)`);
            }
        }
        // ───────────────────────────────────────────────────────────────────
        if (!this._hullBGsDirty) return;
        const s = this.streamer;
        if (!s._uniformBuffer || !s._fragUniformBuffer) return;
        if (this._hullBGsDirty) {
            const templateLib = this.streamer._templateLibrary;
            const anchorBuffer = templateLib?.getAnchorBuffer?.();
            if (!anchorBuffer) return;

            const g1Entries = [{ binding: 0, resource: { buffer: s._fragUniformBuffer } }];
            if (this._hasTex) {
                g1Entries.push(
                    { binding: 1, resource: this._texBaker.getTextureView() },
                    { binding: 2, resource: this._texBaker.getSampler() },
                );
            }

            this._hullBGs = [
                this.device.createBindGroup({
                    layout: this._hullBGLs[0],
                    entries: [
                        { binding: 0, resource: { buffer: s._uniformBuffer } },
                        { binding: 1, resource: { buffer: this._treeBuffer } },
                        { binding: 2, resource: { buffer: anchorBuffer } },
                    ],
                }),
                this.device.createBindGroup({ layout: this._hullBGLs[1], entries: g1Entries }),
            ];
            this._hullBGsDirty = false;
        }
    }

    _maybeRebuildGatherBindGroup() {
        // ── DBG ─────────────────────────────────────────────────────────────
        if (this._gatherBGDirty) {
            Logger.warn(
                `[TreeFarSystem] _maybeRebuildGatherBindGroup — dirty=true ` +
                `sourceCache.enabled=${this._sourceCache?.enabled} ` +
                `gatherBGL=${!!this._gatherBGL} ` +
                `gatherParamBuffer=${!!this._gatherParamBuffer} ` +
                `sourceCache.activeLayerBuffer=${!!this._sourceCache?.activeLayerBuffer} ` +
                `sourceCache.instanceBuffer=${!!this._sourceCache?.instanceBuffer} ` +
                `sourceCache.counterBuffer=${!!this._sourceCache?.counterBuffer} ` +
                `treeBuffer=${!!this._treeBuffer} treeCountBuffer=${!!this._treeCountBuffer}`
            );
        }
        // ───────────────────────────────────────────────────────────────────
        if (!this._gatherBGDirty) return;
        if (!this._sourceCache?.enabled) {
            Logger.warn(`[TreeFarSystem] _maybeRebuildGatherBindGroup: BLOCKED — sourceCache not enabled`);
            return;
        }

        this._gatherBG = this.device.createBindGroup({
            layout: this._gatherBGL,
            entries: [
                { binding: 0, resource: { buffer: this._gatherParamBuffer } },
                { binding: 1, resource: { buffer: this._sourceCache.activeLayerBuffer } },
                { binding: 2, resource: { buffer: this._sourceCache.instanceBuffer } },
                { binding: 3, resource: { buffer: this._sourceCache.counterBuffer } },
                { binding: 4, resource: { buffer: this._treeBuffer } },
                { binding: 5, resource: { buffer: this._treeCountBuffer } },
            ],
        });
    
        this._gatherBGDirty = false;
    }
    update(commandEncoder, camera) {
        this._frameCount++;

        // ── DBG: full update state every N frames ────────────────────────────
        const dbgLog = this._frameCount === 1 || this._frameCount === 2 || this._frameCount === 10 || (this._frameCount % 120) === 0;
        if (dbgLog) {
            const sc = this._sourceCache;
            const camPos = this.streamer?.uniformManager?.camera?.position || camera?.position;
            const r = this._range || {};
            const fadeInEnd = (r.start ?? 0) + (r.fadeInWidth ?? 0);
            const fadeOutStart = (r.end ?? 0) - (r.fadeOutWidth ?? 0);
            Logger.warn(
                `[TreeFarSystem] UPDATE frame=${this._frameCount} ──────────────────────\n` +
                `  initialized=${this._initialized} enabled=${this._enabled}\n` +
                `  range: start=${r.start} end=${r.end} fadeIn=[${r.start}..${fadeInEnd}] fadeOut=[${fadeOutStart}..${r.end}]\n` +
                `  maxTrees=${this.maxTrees}\n` +
                `  sourceCache: ${sc ? `enabled=${sc.enabled} initialized=${sc._initialized} activeLayerCount=${sc.activeLayerCount} allActiveLayers=${sc.totalActiveLayerCount} pendingBakes=${sc.pendingBakes}` : 'NULL'}\n` +
                `  pipelines: gatherPipeline=${!!this._gatherPipeline} gatherBGL=${!!this._gatherBGL} gatherBG=${!!this._gatherBG} gatherBGDirty=${this._gatherBGDirty}\n` +
                `  pipelines: indirectPipeline=${!!this._indirectPipeline} indirectBG=${!!this._indirectBG}\n` +
                `  buffers: treeBuffer=${!!this._treeBuffer} treeCountBuffer=${!!this._treeCountBuffer} gatherParamBuffer=${!!this._gatherParamBuffer} hullIndirectBuffer=${!!this._hullIndirectBuffer}\n` +
                `  camera: ${camPos ? `x=${camPos.x?.toFixed(1)} y=${camPos.y?.toFixed(1)} z=${camPos.z?.toFixed(1)}` : 'NULL'}`
            );
        }
        // ───────────────────────────────────────────────────────────────────

        if (!this._initialized || !this._enabled || !this._sourceCache?.enabled) {
            if (dbgLog) Logger.warn(`[TreeFarSystem] UPDATE: early exit — initialized=${this._initialized} enabled=${this._enabled} sourceCache.enabled=${this._sourceCache?.enabled}`);
            return;
        }

        this._updateGatherParams(camera);
        this._maybeRebuildGatherBindGroup();
        if (!this._gatherPipeline || !this._gatherBG || !this._indirectPipeline || !this._indirectBG) {
            if (dbgLog) Logger.warn(
                `[TreeFarSystem] UPDATE: BLOCKED — ` +
                `gatherPipeline=${!!this._gatherPipeline} gatherBG=${!!this._gatherBG} ` +
                `indirectPipeline=${!!this._indirectPipeline} indirectBG=${!!this._indirectBG}`
            );
            return;
        }
        this.device.queue.writeBuffer(this._treeCountBuffer, 0, this._countReset);

        const layerCount = this._sourceCache.activeLayerCount;
        if (layerCount > 0) {
            if (dbgLog) Logger.warn(`[TreeFarSystem] UPDATE: dispatching gather — workgroups=${layerCount}`);
            const pass = commandEncoder.beginComputePass({ label: 'FarTree-Gather' });
            pass.setPipeline(this._gatherPipeline);
            pass.setBindGroup(0, this._gatherBG);
            pass.dispatchWorkgroups(layerCount);
            pass.end();
        } else {
            if (dbgLog) Logger.warn(`[TreeFarSystem] UPDATE: ⚠ activeLayerCount=0 — gather skipped, trees=0`);
        }

        {
            const pass = commandEncoder.beginComputePass({ label: 'FarTree-Indirect' });
            pass.setPipeline(this._indirectPipeline);
            pass.setBindGroup(0, this._indirectBG);
            pass.dispatchWorkgroups(1);
            pass.end();
        }

        // ── DBG: GPU readback — kick existing, queue new ─────────────────────
        this._queueCountReadback(commandEncoder);
        this._kickCountReadback();
        // ───────────────────────────────────────────────────────────────────
    }

    render(encoder) {
        // ── DBG: full render state every N frames ────────────────────────────
        const dbgRenderLog = this._frameCount === 1 || this._frameCount === 2 || this._frameCount === 10 || (this._frameCount % 120) === 0;
        if (dbgRenderLog) {
            const s = this.streamer;
            const anchorBuffer = s._templateLibrary?.getAnchorBuffer?.();
            const geo = this._hullGeo;
            Logger.warn(
                `[TreeFarSystem] RENDER frame=${this._frameCount} ──────────────────────\n` +
                `  initialized=${this._initialized} enabled=${this._enabled} encoder=${!!encoder}\n` +
                `  hullPipeline=${!!this._hullPipeline} hullGeo=${!!geo}\n` +
                `  geo: idxCount=${geo?.idxCount} posBuffer=${!!geo?.posBuffer} normBuffer=${!!geo?.normBuffer} uvBuffer=${!!geo?.uvBuffer} canopyIdBuffer=${!!geo?.canopyIdBuffer} idxBuffer=${!!geo?.idxBuffer}\n` +
                `  hullBGs.length=${this._hullBGs.length} hullBGsDirty=${this._hullBGsDirty} hullBGLs.length=${this._hullBGLs.length}\n` +
                `  streamer: uniformBuffer=${!!s._uniformBuffer} fragUniformBuffer=${!!s._fragUniformBuffer}\n` +
                `  anchorBuffer=${!!anchorBuffer} hasTex=${this._hasTex}\n` +
                `  hullIndirectBuffer=${!!this._hullIndirectBuffer}`
            );
            if (this._hullBGs.length === 0 && this._hullBGsDirty) {
                Logger.warn(`[TreeFarSystem] RENDER: ⚠ hullBGs empty — _maybeRebuildRenderBGs is blocked (check anchorBuffer / uniformBuffer above)`);
            }
        }
        // ───────────────────────────────────────────────────────────────────
        if (!this._initialized || !this._enabled || !encoder) return;
        if (!this._hullPipeline || !this._hullGeo) return;
        this._maybeRebuildRenderBGs();
        if (this._hullBGs.length === 0) return;

        encoder.setPipeline(this._hullPipeline);
        encoder.setBindGroup(0, this._hullBGs[0]);
        encoder.setBindGroup(1, this._hullBGs[1]);
        encoder.setVertexBuffer(0, this._hullGeo.posBuffer);
        encoder.setVertexBuffer(1, this._hullGeo.normBuffer);
        encoder.setVertexBuffer(2, this._hullGeo.uvBuffer);
        encoder.setVertexBuffer(3, this._hullGeo.canopyIdBuffer);
        encoder.setIndexBuffer(this._hullGeo.idxBuffer, 'uint16');
        encoder.drawIndexedIndirect(this._hullIndirectBuffer, 0);
    }

    setEnabled(enabled) { this._enabled = enabled; }
    isReady() { return this._initialized && this._enabled; }

    _ensureCountReadbackBuffer() {
        if (this._countReadbackBuffer) return;
        this._countReadbackBuffer = this.device.createBuffer({
            label: 'FarTree-CountReadback',
            size: 256,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });
    }

    _queueCountReadback(commandEncoder) {
        if (!commandEncoder || this._countReadbackQueued || this._countReadbackPending) return;
        // ── DBG: sample more frequently while investigating ──────────────────
        const shouldSample = this._frameCount === 5 || this._frameCount === 30 || this._frameCount === 60 || (this._frameCount % 120) === 0;
        // ───────────────────────────────────────────────────────────────────
        if (!shouldSample) return;

        this._ensureCountReadbackBuffer();
        if (!this._countReadbackBuffer) return;

        commandEncoder.copyBufferToBuffer(
            this._treeCountBuffer,
            0,
            this._countReadbackBuffer,
            0,
            4
        );
        this._countReadbackQueued = true;
    }

    _kickCountReadback() {
        if (!this._countReadbackQueued || this._countReadbackPending || !this._countReadbackBuffer) return;

        this._countReadbackPending = true;
        this._countReadbackBuffer.mapAsync(GPUMapMode.READ).then(() => {
            const data = new Uint32Array(this._countReadbackBuffer.getMappedRange(0, 4).slice(0));
            const count = data[0] >>> 0;
            // ── DBG ──────────────────────────────────────────────────────────
            const sc = this._sourceCache;
            Logger.warn(
                `[TreeFarSystem] GPU READBACK frame=${this._frameCount} — ` +
                `gatheredTrees=${count}/${this.maxTrees} ` +
                `(${count === 0 ? '⚠ ZERO — nothing rendered' : 'OK'}) ` +
                `activeLayers=${sc?.activeLayerCount ?? 'N/A'} allLayers=${sc?.totalActiveLayerCount ?? 'N/A'}`
            );
            // ─────────────────────────────────────────────────────────────────
            this._countReadbackBuffer.unmap();
            this._countReadbackQueued = false;
            this._countReadbackPending = false;
        }).catch((err) => {
            Logger.warn(`[TreeFarSystem] count readback failed: ${err?.message || err}`);
            try { this._countReadbackBuffer?.unmap(); } catch (_) {}
            this._countReadbackQueued = false;
            this._countReadbackPending = false;
        });
    }

    dispose() {
        this._texBaker?.dispose();
        for (const b of [
            this._treeBuffer, this._treeCountBuffer, 
    
            this._hullIndirectBuffer, this._countReadbackBuffer,
        ]) b?.destroy();
        const geo = this._hullGeo;
        if (geo) {
            geo.posBuffer?.destroy();
            geo.normBuffer?.destroy();
            geo.uvBuffer?.destroy();
            geo.canopyIdBuffer?.destroy();
            geo.idxBuffer?.destroy();
        }        
        this._initialized = false;
    }
}
