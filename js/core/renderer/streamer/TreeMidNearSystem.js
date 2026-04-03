// js/renderer/streamer/TreeMidNearSystem.js

import { Logger } from '../../../shared/Logger.js';
import { LODS_PER_CATEGORY, CAT_TREES } from './streamerConfig.js';
import { MidNearGeometryBuilder } from './MidNearGeometryBuilder.js';
import { MidNearTextureBaker, MIDNEAR_IMPOSTOR_VARIANTS, MIDNEAR_CANOPY_LAYERS } from './MidNearTextureBaker.js';
import { BIRCH_MASK_VARIANTS } from './LeafMaskBaker.js';
import { buildMidNearTreeTrackerShader } from './shaders/midNearTreeTracker.wgsl.js';
import {
    buildMidNearTrunkScatterShader,
    buildMidNearImpostorScatterShader,
    buildMidNearIndirectShader,
} from './shaders/midNearAnchorScatter.wgsl.js';
import {
    buildMidNearTrunkVertexShader,
    buildMidNearTrunkFragmentShader,
    buildMidNearCanopyHullVertexShader,
    buildMidNearCanopyHullFragmentShader,
    buildMidNearImpostorVertexShader,
    buildMidNearImpostorFragmentShader,
} from './shaders/midNearRender.wgsl.js';

const MIDNEAR_TREE_BYTES     = 128;
const ANCHOR_INSTANCE_BYTES  = 64;
const TRUNK_INSTANCE_BYTES   = 48;
const SUB_BAND_COUNT         = 3;

export class TreeMidNearSystem {
    constructor(device, assetStreamer, config = {}) {
        this.device   = device;
        this.streamer = assetStreamer;
        this._debugReadbackEnabled = this.streamer?._debugReadbackEnabled === true;

        this.lodController = config.lodController;
        if (!this.lodController) {
            throw new Error('[TreeMidNearSystem] lodController is required');
        }

        const mc = this.lodController.getMidNearShaderConfig();
        this.maxTrees     = mc.maxTrees;
        this.maxImpostors = mc.maxImpostors;

        // GPU buffers
        this._treeBuffer        = null;
        this._treeCountBuffer   = null;
        this._trackerParamBuffer = null;
        this._scatterParamBuffer = null;
        this._assetSpeciesBuffer = null;
        this._assetSpeciesCount  = 0;
        this._dispatchArgsBuffer = null;
        this._trackerDispatchArgsBuffer = null;

        // Trunk
        this._trunkInstBuffer     = null;
        this._trunkIndirectBuffer = null;

        // Impostor
        this._impInstBuffer    = null;
        this._impCounterBuffer = null;
        this._impMetaBuffer    = null;
        this._impIndirectBuffer = null;
        this._debugReadbackBuffer = null;
        this._debugReadPending = false;
        this._debugReadQueued = false;
        this._debugZeroData = new Uint32Array(8);

        // Hull
        this._hullIndirectBuffer = null;

        // Geometry
        this._hullGeo  = null;
        this._trunkGeo = null;
        this._impGeo   = null;

        // Textures
        this._texBaker = null;

        // Pipelines
        this._trackerPipeline    = null;
        this._trackerBGL = null;
        this._trackerBG  = null;
        this._trackerBGDirty = true;
        this._trackerWorkgroups = 0;
        this._sourceBands   = [];
        this._sourceCapacity = 0;
        this._workgroupSize = 256;

        this._dispatchArgsPipeline = null;
        this._dispatchArgsBG       = null;
        this._trackerDispatchArgsPipeline = null;
        this._trackerDispatchArgsBGL = null;
        this._trackerDispatchArgsBG = null;
        this._trackerDispatchArgsBGDirty = true;

        this._trunkScatterPipeline = null;
        this._trunkScatterBGL = null;
        this._trunkScatterBG  = null;
        this._trunkScatterBGDirty = true;

        this._impScatterPipeline = null;
        this._impScatterBGL = null;
        this._impScatterBG  = null;
        this._impScatterBGDirty = true;

        this._indirectPipeline = null;
        this._indirectBG = null;

        this._trunkPipeline = null;
        this._trunkBGLs = [];
        this._trunkBGs  = [];
        this._trunkBGsDirty = true;

        this._hullPipeline = null;
        this._hullBGLs = [];
        this._hullBGs  = [];
        this._hullBGsDirty = true;

        this._impPipeline = null;
        this._impBGLs = [];
        this._impBGs  = [];
        this._impBGsDirty = true;
        this._impUseLeafMask = null;

        this._initialized = false;
        this._enabled     = true;
        this._frameCount  = 0;
    }

    async initialize() {
        if (this._initialized) return;

        this._buildAssetSpeciesMap();
        this._buildSourceBands();
        this._createBuffers();
        this._buildGeometry();
        await this._bakeTextures();
        this._createTrackerPipeline();
        this._createTrackerDispatchArgsPipeline();
        this._createDispatchArgsPipeline();
        this._createTrunkScatterPipeline();
        this._createImpostorScatterPipeline();
        this._createIndirectPipeline();
        this._createRenderPipelines();

        this._initialized = true;

        const mc = this.lodController.getMidNearShaderConfig();
        Logger.info(
            `[TreeMidNearSystem] Initialized: ` +
            `range=[${mc.rangeStart}..${mc.rangeEnd}]m ` +
            `fade=[${mc.fadeInStart}→${mc.fadeInEnd} | ${mc.fadeOutStart}→${mc.fadeOutEnd}]m ` +
            `handoffEnd=${mc.nearTierHandoffEnd}m ` +
            `maxTrees=${this.maxTrees} impostors=${this.maxImpostors} ` +
            `hull=${mc.hullLon}×${mc.hullLat} dispatch=${this._trackerWorkgroups}wg`
        );
        Logger.warn('[Impostor][TreeMidNearSystem] Debug stats instrumentation active');
    }

        // ═══════════════════════════════════════════════════════════════════════
    // Hot-reload: rebuild GPU pipelines after LOD controller config changes
    // ═══════════════════════════════════════════════════════════════════════

    rebuildPipelines(options = {}) {
        if (!this._initialized) return;

        const rebuildGeometry = options.rebuildGeometry === true;

        // 1) Optionally rebuild geometry (hull resolution or trunk taper changed)
        if (rebuildGeometry) {
            for (const geo of [this._hullGeo, this._trunkGeo, this._impGeo]) {
                if (!geo) continue;
                geo.posBuffer?.destroy();
                geo.normBuffer?.destroy();
                geo.uvBuffer?.destroy();
                geo.idxBuffer?.destroy();
            }
            this._hullGeo = null;
            this._trunkGeo = null;
            this._impGeo = null;
            this._buildGeometry();
        }

        // 2) Rebuild all compute pipelines (re-reads lodController config)
        this._createTrackerPipeline();
        this._createTrackerDispatchArgsPipeline();
        this._createDispatchArgsPipeline();
        this._createTrunkScatterPipeline();
        this._createImpostorScatterPipeline();
        this._createIndirectPipeline();

        // 3) Rebuild all render pipelines
        this._createRenderPipelines();

        // 4) Mark all lazily-created bind groups as dirty
        this._trackerBGDirty = true;
        this._trackerDispatchArgsBGDirty = true;
        this._trunkScatterBGDirty = true;
        this._impScatterBGDirty = true;
        this._trunkBGsDirty = true;
        this._hullBGsDirty = true;
        this._impBGsDirty = true;

        Logger.info(
            `[TreeMidNearSystem] Pipelines rebuilt` +
            `${rebuildGeometry ? ' (with geometry)' : ''}`
        );
    }
    // ═══════════════════════════════════════════════════════════════════════
    // Buffer / geometry setup
    // ═══════════════════════════════════════════════════════════════════════

    _buildAssetSpeciesMap() {
        const registry = this.streamer?._assetRegistry;
        const assets = registry?.getAllAssets?.() || [];
        this._assetSpeciesCount = assets.length;
        if (this._assetSpeciesCount === 0) return;

        const map = new Uint32Array(this._assetSpeciesCount);
        for (let i = 0; i < assets.length; i++) {
            const asset = assets[i];
            const id = (asset?.id || '').toLowerCase();
            const geom = (asset?.geometryType || '').toLowerCase();
            let species = 2;
            if (id.includes('birch')) species = 2;
            else if (id.includes('alder')) species = 3;
            else if (id.includes('oak')) species = 4;
            else if (id.includes('beech')) species = 5;
            else if (id.includes('palm')) species = 6;
            else if (id.includes('teak')) species = 7;
            else if (id.includes('baobab')) species = 8;
            else if (id.includes('saguaro') || id.includes('cactus')) species = 9;
            else if (geom === 'conifer') species = 2;
            else if (geom === 'palm') species = 6;
            else if (geom === 'cactus') species = 9;
            else if (geom === 'deciduous_broad') species = 4;
            else if (geom === 'deciduous') species = 2;
            else if (geom === 'deciduous_tall') species = 4;
            else if (geom === 'deciduous_sparse') species = 4;
            map[i] = species;
        }

        this._assetSpeciesBuffer = this.device.createBuffer({
            label: 'MidNear-AssetSpeciesMap',
            size: Math.max(256, map.byteLength),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(this._assetSpeciesBuffer, 0, map);
    }

    _buildSourceBands() {
        const pool = this.streamer._pool;
        this._sourceBands = [];
        this._sourceCapacity = 0;
        if (!pool) return;

        const treeBandBase = CAT_TREES * LODS_PER_CATEGORY;
        for (let lod = 0; lod < LODS_PER_CATEGORY; lod++) {
            const band = treeBandBase + lod;
            const capacity = pool.getBandCapacity(band) >>> 0;
            if (capacity === 0) continue;
            const base = pool.getBandBase(band) >>> 0;
            this._sourceBands.push({ band, base, capacity });
            this._sourceCapacity += capacity;
        }
        this._trackerWorkgroups = Math.ceil(this._sourceCapacity / this._workgroupSize);
    }

    _createBuffers() {
        this._treeBuffer = this.device.createBuffer({
            label: 'MidNear-Trees',
            size: Math.max(256, this.maxTrees * MIDNEAR_TREE_BYTES),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });

        this._treeCountBuffer = this.device.createBuffer({
            label: 'MidNear-TreeCount',
            size: 256,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });

        this._trackerParamBuffer = this.device.createBuffer({
            label: 'MidNear-TrackerParams',
            size: 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this._scatterParamBuffer = this.device.createBuffer({
            label: 'MidNear-ScatterParams',
            size: 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this._dispatchArgsBuffer = this.device.createBuffer({
            label: 'MidNear-DispatchArgs',
            size: 16,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT,
        });

        this._trackerDispatchArgsBuffer = this.device.createBuffer({
            label: 'MidNear-TrackerDispatchArgs',
            size: 16,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT,
        });

        // Trunk — direct-indexed by tree slot
        this._trunkInstBuffer = this.device.createBuffer({
            label: 'MidNear-TrunkInstances',
            size: Math.max(256, this.maxTrees * TRUNK_INSTANCE_BYTES),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this._trunkIndirectBuffer = this.device.createBuffer({
            label: 'MidNear-TrunkIndirect',
            size: Math.max(256, 5 * 4),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
        });

        // Hull indirect (same tree count as trunk)
        this._hullIndirectBuffer = this.device.createBuffer({
            label: 'MidNear-HullIndirect',
            size: Math.max(256, 5 * 4),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
        });


        // Sub-band capacity split.
        // Keep a larger far-band reserve to avoid saturation flicker when SB2
        // receives blended families from SB1 at distance transitions.
        const impW = [0.40, 0.25, 0.35];

        const impCap0 = Math.max(1, Math.floor(this.maxImpostors * impW[0]));
        const impCap1 = Math.max(1, Math.floor(this.maxImpostors * impW[1]));
        const impCap2 = Math.max(1, this.maxImpostors - impCap0 - impCap1);
        this._impBandCaps  = [impCap0, impCap1, impCap2];
        
        this._impBandBases = [];
        let iOff = 0;
        for (let sb = 0; sb < SUB_BAND_COUNT; sb++) {
            this._impBandBases.push(iOff);
            iOff += this._impBandCaps[sb];
        }

        this._impInstBuffer = this.device.createBuffer({
            label: 'MidNear-ImpInstances',
            size: Math.max(256, iOff * ANCHOR_INSTANCE_BYTES),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this._impCounterBuffer = this.device.createBuffer({
            label: 'MidNear-ImpCounters',
            size: Math.max(256, SUB_BAND_COUNT * 4),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });
        this._impMetaBuffer = this.device.createBuffer({
            label: 'MidNear-ImpMeta',
            size: Math.max(256, SUB_BAND_COUNT * 16),
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this._impIndirectBuffer = this.device.createBuffer({
            label: 'MidNear-ImpIndirect',
            size: Math.max(256, SUB_BAND_COUNT * 5 * 4),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
        });
        this._debugReadbackBuffer = this.device.createBuffer({
            label: 'MidNear-DebugStats-Readback',
            size: 256,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });

        this._uploadMeta(this._impMetaBuffer, this._impBandBases, this._impBandCaps);
    }

    _uploadMeta(buffer, bases, caps) {
        const data = new Uint32Array(SUB_BAND_COUNT * 4);
        for (let i = 0; i < SUB_BAND_COUNT; i++) {
            data[i * 4 + 0] = bases[i];
            data[i * 4 + 1] = caps[i];
        }
        this.device.queue.writeBuffer(buffer, 0, data);
    }

    _buildGeometry() {
        const mc = this.lodController.getMidNearShaderConfig();

        const hull  = MidNearGeometryBuilder.buildCanopyHull(mc.hullLon, mc.hullLat);
        const trunk = MidNearGeometryBuilder.buildTrunkCylinder({
            taperTop:  mc.trunkTaperTop,
            embedFrac: 0.08,
        });
        const imp = MidNearGeometryBuilder.buildImpostorCardSet();

        const mkVB = (data, label) => {
            const b = this.device.createBuffer({
                label, size: Math.max(16, data.byteLength),
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
                label, size: Math.max(16, aligned),
                usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
                mappedAtCreation: true,
            });
            new Uint16Array(b.getMappedRange(0, data.byteLength)).set(data);
            b.unmap();
            return b;
        };

        this._hullGeo = {
            posBuffer:  mkVB(hull.positions, 'MidNearHull-Pos'),
            normBuffer: mkVB(hull.normals,   'MidNearHull-Norm'),
            uvBuffer:   mkVB(hull.uvs,       'MidNearHull-UV'),
            idxBuffer:  mkIB(hull.indices,   'MidNearHull-Idx'),
            idxCount:   hull.indexCount,
        };

        this._trunkGeo = {
            posBuffer:  mkVB(trunk.positions, 'MidNearTrunk-Pos'),
            normBuffer: mkVB(trunk.normals,   'MidNearTrunk-Norm'),
            uvBuffer:   mkVB(trunk.uvs,       'MidNearTrunk-UV'),
            idxBuffer:  mkIB(trunk.indices,   'MidNearTrunk-Idx'),
            idxCount:   trunk.indexCount,
        };

        this._impGeo = {
            posBuffer:   mkVB(imp.positions, 'MidNearImp-Pos'),
            normBuffer:  mkVB(imp.normals,   'MidNearImp-Norm'),
            uvBuffer:    mkVB(imp.uvs,       'MidNearImp-UV'),
            idxBuffer:   mkIB(imp.indices,   'MidNearImp-Idx'),
            idxCount:    imp.indexCount,
            shapeRanges: imp.shapeRanges,
        };
    }

    async _bakeTextures() {
        const procGen = this.streamer?.propTextureManager?.proceduralTextureGenerator ?? null;
        this._texBaker = new MidNearTextureBaker(this.device, procGen, {
            textureSize: 512,
            seed: (this.streamer.engineConfig?.seed ?? 12345) ^ 0x71D5EED,
        });
        await this._texBaker.initialize();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Pipeline creation
    // ═══════════════════════════════════════════════════════════════════════

    _createTrackerPipeline() {
        const code = buildMidNearTreeTrackerShader({
            workgroupSize: this._workgroupSize,
            maxTrees: this.maxTrees,
            assetCount: this._assetSpeciesCount,
            treeSourceBandIds:   this._sourceBands.map(b => b.band),
            treeSourceBandBases: this._sourceBands.map(b => b.base),
            treeSourceBandCaps:  this._sourceBands.map(b => b.capacity),
            midNearConfig: this.lodController.getMidNearShaderConfig(),
        });

        const mod = this.device.createShaderModule({ label: 'MidNearTracker-SM', code });

        this._trackerBGL = this.device.createBindGroupLayout({
            label: 'MidNearTracker-BGL',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
            ],
        });

        this._trackerPipeline = this.device.createComputePipeline({
            label: 'MidNearTracker-Pipeline',
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [this._trackerBGL] }),
            compute: { module: mod, entryPoint: 'main' },
        });
    }

    _createDispatchArgsPipeline() {
        const code = /* wgsl */`
            @group(0) @binding(0) var<storage, read>       treeCount: array<u32>;
            @group(0) @binding(1) var<storage, read_write> dispatchArgs: array<u32>;
            const MAX_TREES: u32 = ${this.maxTrees}u;
            @compute @workgroup_size(1)
            fn main() {
                let n = min(treeCount[0], MAX_TREES);
                dispatchArgs[0] = n;
                dispatchArgs[1] = 1u;
                dispatchArgs[2] = 1u;
            }
        `;
        const mod = this.device.createShaderModule({ label: 'MidNearDispatch-SM', code });
        const bgl = this.device.createBindGroupLayout({
            label: 'MidNearDispatch-BGL',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
            ],
        });
        this._dispatchArgsPipeline = this.device.createComputePipeline({
            label: 'MidNearDispatch-Pipeline',
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
            compute: { module: mod, entryPoint: 'main' },
        });
        this._dispatchArgsBG = this.device.createBindGroup({
            label: 'MidNearDispatch-BG',
            layout: bgl,
            entries: [
                { binding: 0, resource: { buffer: this._treeCountBuffer } },
                { binding: 1, resource: { buffer: this._dispatchArgsBuffer } },
            ],
        });
    }

    _createTrackerDispatchArgsPipeline() {
        const bandIds = this._sourceBands.map(b => b.band);
        if (bandIds.length === 0) return;

        const code = /* wgsl */`
            const SOURCE_BAND_COUNT: u32 = ${bandIds.length}u;
            const WORKGROUP_SIZE:    u32 = ${this._workgroupSize}u;
            const SOURCE_BAND_IDS: array<u32, SOURCE_BAND_COUNT> =
                array<u32, SOURCE_BAND_COUNT>(${bandIds.map(v => `${v >>> 0}u`).join(', ')});

            @group(0) @binding(0) var<storage, read>       treeIndirectArgs: array<u32>;
            @group(0) @binding(1) var<storage, read_write> dispatchArgs:     array<u32>;

            @compute @workgroup_size(1)
            fn main() {
                var total: u32 = 0u;
                for (var b = 0u; b < SOURCE_BAND_COUNT; b++) {
                    total += treeIndirectArgs[SOURCE_BAND_IDS[b] * 5u + 1u];
                }
                dispatchArgs[0] = (total + WORKGROUP_SIZE - 1u) / WORKGROUP_SIZE;
                dispatchArgs[1] = 1u;
                dispatchArgs[2] = 1u;
            }
        `;

        const mod = this.device.createShaderModule({
            label: 'MidNear-TrackerDispatchArgs-SM',
            code,
        });

        this._trackerDispatchArgsBGL = this.device.createBindGroupLayout({
            label: 'MidNear-TrackerDispatchArgs-BGL',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
            ],
        });

        this._trackerDispatchArgsPipeline = this.device.createComputePipeline({
            label: 'MidNear-TrackerDispatchArgs-Pipeline',
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [this._trackerDispatchArgsBGL] }),
            compute: { module: mod, entryPoint: 'main' },
        });
    }

    _createTrunkScatterPipeline() {
        // 3 bindings: trees (read), treeCount (read), trunkInstances (write)
        const code = buildMidNearTrunkScatterShader({
            maxTrees: this.maxTrees,
            midNearConfig: this.lodController.getMidNearShaderConfig(),
        });
        const mod = this.device.createShaderModule({ label: 'MidNearTrunkScatter-SM', code });

        this._trunkScatterBGL = this.device.createBindGroupLayout({
            label: 'MidNearTrunkScatter-BGL',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
            ],
        });

        this._trunkScatterPipeline = this.device.createComputePipeline({
            label: 'MidNearTrunkScatter-Pipeline',
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [this._trunkScatterBGL] }),
            compute: { module: mod, entryPoint: 'main' },
        });
    }


    _createImpostorScatterPipeline() {
        const code = buildMidNearImpostorScatterShader({
            workgroupSize: 128,
            maxTrees:     this.maxTrees,
            maxImpostors: this.maxImpostors,
            midNearConfig: this.lodController.getMidNearShaderConfig(),
            budgetTreeEstimate: 1500,
        });

        const mod = this.device.createShaderModule({ label: 'MidNearImpScatter-SM', code });

        this._impScatterBGL = this.device.createBindGroupLayout({
            label: 'MidNearImpScatter-BGL',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
            ],
        });

        this._impScatterPipeline = this.device.createComputePipeline({
            label: 'MidNearImpScatter-Pipeline',
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [this._impScatterBGL] }),
            compute: { module: mod, entryPoint: 'main' },
        });
    }

    _createIndirectPipeline() {
        const mc = this.lodController.getMidNearShaderConfig();
        const code = buildMidNearIndirectShader({
            hullIndexCount:  this._hullGeo.idxCount,
            trunkIndexCount: this._trunkGeo.idxCount,
            maxTrees: this.maxTrees,
            impostorShapeRanges: this._impGeo.shapeRanges,
            impostorShapes: mc.impostorShapes.slice(0, 3),
        });

        const mod = this.device.createShaderModule({ label: 'MidNearIndirect-SM', code });
        const bgl = this.device.createBindGroupLayout({
            label: 'MidNearIndirect-BGL',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },  // impCounters
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },           // impMeta
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },           // impIndirect
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },  // treeCount
                { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },           // trunkIndirect
                { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },           // hullIndirect
            ],
        });

        this._indirectPipeline = this.device.createComputePipeline({
            label: 'MidNearIndirect-Pipeline',
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
            compute: { module: mod, entryPoint: 'main' },
        });

        this._indirectBG = this.device.createBindGroup({
            label: 'MidNearIndirect-BG',
            layout: bgl,
            entries: [
                { binding: 0, resource: { buffer: this._impCounterBuffer } },
                { binding: 1, resource: { buffer: this._impMetaBuffer } },
                { binding: 2, resource: { buffer: this._impIndirectBuffer } },
                { binding: 3, resource: { buffer: this._treeCountBuffer } },
                { binding: 4, resource: { buffer: this._trunkIndirectBuffer } },
                { binding: 5, resource: { buffer: this._hullIndirectBuffer } },
            ],
        });
    }

    _createRenderPipelines() {
        const mc = this.lodController.getMidNearShaderConfig();
        const fadeBounds = {
            fadeInStart:  mc.fadeInStart,
            fadeInEnd:    mc.fadeInEnd,
            fadeOutStart: mc.fadeOutStart,
            fadeOutEnd:   mc.fadeOutEnd,
        };
        const hasTex = this._texBaker?.isReady() === true;
        const canvasFormat = navigator.gpu.getPreferredCanvasFormat();

        // Helper for standard group0 (uniform + storage read)
        const mkGroup0 = (label) => this.device.createBindGroupLayout({
            label,
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
            ],
        });
        const mkGroup1 = (label, withTex) => this.device.createBindGroupLayout({
            label,
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
                ...(withTex ? [
                    { binding: 1, visibility: GPUShaderStage.FRAGMENT,
                      texture: { sampleType: 'float', viewDimension: '2d-array' } },
                    { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
                ] : []),
            ],
        });

        const triListCCWBack = { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' };
        const triListCCWNone = { topology: 'triangle-list', cullMode: 'none', frontFace: 'ccw' };
        const depthLess = { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' };

        // ── Trunk pipeline ─────────────────────────────────────────────────
        {
            const vsMod = this.device.createShaderModule({
                label: 'MidNearTrunk-VS',
                code: buildMidNearTrunkVertexShader({}),
            });
            const fsMod = this.device.createShaderModule({
                label: 'MidNearTrunk-FS',
                code: buildMidNearTrunkFragmentShader(fadeBounds),
            });

            const g0 = mkGroup0('MidNearTrunk-G0');
            const g1 = mkGroup1('MidNearTrunk-G1', false);
            this._trunkBGLs = [g0, g1];

            this._trunkPipeline = this.device.createRenderPipeline({
                label: 'MidNearTrunk-Pipeline',
                layout: this.device.createPipelineLayout({ bindGroupLayouts: this._trunkBGLs }),
                vertex: {
                    module: vsMod, entryPoint: 'main',
                    buffers: [
                        { arrayStride: 12, stepMode: 'vertex',
                          attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
                        { arrayStride: 12, stepMode: 'vertex',
                          attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
                        { arrayStride: 8,  stepMode: 'vertex',
                          attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x2' }] },
                    ],
                },
                fragment: { module: fsMod, entryPoint: 'main', targets: [{ format: canvasFormat }] },
                primitive: triListCCWBack,
                depthStencil: depthLess,
            });
        }

        // ── Hull pipeline ──────────────────────────────────────────────────
        // Group 0: uniform + trees(read) + anchors(read) — three bindings
        {
            const vsMod = this.device.createShaderModule({
                label: 'MidNearHull-VS',
                code: buildMidNearCanopyHullVertexShader({
                    maxAnchorsPerTree: mc.maxAnchorsPerTree,
                    hullInflation: mc.hullInflation,
                    hullShrinkWrap: mc.hullShrinkWrap,
                    hullVerticalBias: mc.hullVerticalBias,
                    hullSpreadRadialScale: mc.hullSpreadRadialScale,
                    hullSpreadVerticalScale: mc.hullSpreadVerticalScale,
                    hullThinBase: mc.hullThinBase,
                    hullTopShrinkStart: mc.hullTopShrinkStart,
                    hullTopShrinkEnd: mc.hullTopShrinkEnd,
                    hullTopShrinkStrength: mc.hullTopShrinkStrength,
                }),
            });
            const fsMod = this.device.createShaderModule({
                label: 'MidNearHull-FS',
                code: buildMidNearCanopyHullFragmentShader({
                    ...fadeBounds,
                    enableCanopyTexture: hasTex,
                    maxAnchorsPerTree: mc.maxAnchorsPerTree,
                    hullInflation: mc.hullInflation,
                    hullShrinkWrap: mc.hullShrinkWrap,
                    hullVerticalBias: mc.hullVerticalBias,
                    hullSpreadRadialScale: mc.hullSpreadRadialScale,
                    hullSpreadVerticalScale: mc.hullSpreadVerticalScale,
                    canopyEnvelopeExpand: mc.canopyEnvelopeExpand,
                    canopyEnvelopeSoftness: mc.canopyEnvelopeSoftness,
                    canopyBumpStrength: mc.canopyBumpStrength,
                    canopyCutoutStrength: mc.canopyCutoutStrength,
                    canopyBrightness: mc.canopyBrightness,
                    canopyFieldThreshold: mc.canopyFieldThreshold,
                    canopyFieldSoftness: mc.canopyFieldSoftness,
                    canopyFieldGain: mc.canopyFieldGain,
                }),
            });

            const hullG0 = this.device.createBindGroupLayout({
                label: 'MidNearHull-G0',
                entries: [
                    { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
                    { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
                    { binding: 2, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
                ],
            });
            const g1 = mkGroup1('MidNearHull-G1', hasTex);
            this._hullBGLs = [hullG0, g1];

            this._hullPipeline = this.device.createRenderPipeline({
                label: 'MidNearHull-Pipeline',
                layout: this.device.createPipelineLayout({ bindGroupLayouts: this._hullBGLs }),
                vertex: {
                    module: vsMod, entryPoint: 'main',
                    buffers: [
                        { arrayStride: 12, stepMode: 'vertex',
                          attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
                        { arrayStride: 12, stepMode: 'vertex',
                          attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
                        { arrayStride: 8,  stepMode: 'vertex',
                          attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x2' }] },
                    ],
                },
                fragment: { module: fsMod, entryPoint: 'main', targets: [{ format: canvasFormat }] },
                primitive: triListCCWBack,
                depthStencil: depthLess,
            });
        }

        // ── Impostor pipeline ──────────────────────────────────────────────
        {
            const vsMod = this.device.createShaderModule({
                label: 'MidNearImp-VS',
                code: buildMidNearImpostorVertexShader({}),
            });
            const fsMod = this.device.createShaderModule({
                label: 'MidNearImp-FS',
                code: buildMidNearImpostorFragmentShader({
                    ...fadeBounds,
                    enableImpostorTexture: hasTex,
                    impostorTexVariants: this.streamer?._leafMaskBaker?.isReady?.()
                        ? BIRCH_MASK_VARIANTS
                        : MIDNEAR_IMPOSTOR_VARIANTS,
                    impostorAlphaFromMaskRG: this.streamer?._leafMaskBaker?.isReady?.() === true,
                }),
            });

            const g0 = mkGroup0('MidNearImp-G0');
            const g1 = mkGroup1('MidNearImp-G1', hasTex);
            this._impBGLs = [g0, g1];

            this._impPipeline = this.device.createRenderPipeline({
                label: 'MidNearImp-Pipeline',
                layout: this.device.createPipelineLayout({ bindGroupLayouts: this._impBGLs }),
                vertex: {
                    module: vsMod, entryPoint: 'main',
                    buffers: [
                        { arrayStride: 12, stepMode: 'vertex',
                          attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
                        { arrayStride: 12, stepMode: 'vertex',
                          attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
                        { arrayStride: 8,  stepMode: 'vertex',
                          attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x2' }] },
                    ],
                },
                fragment: { module: fsMod, entryPoint: 'main', targets: [{ format: canvasFormat }] },
                primitive: triListCCWNone,
                depthStencil: depthLess,
            });
        }

        this._hasTex = hasTex;
        Logger.info(`[TreeMidNearSystem] mid-near canopyTex=${hasTex ? 'enabled' : 'disabled'}`);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Per-frame uniform + bind group updates
    // ═══════════════════════════════════════════════════════════════════════

    _updateTrackerParams(camera) {
        const s = this.streamer;
        const cam = s.uniformManager?.camera?.position || camera?.position || { x: 0, y: 0, z: 0 };
        const pc = s.planetConfig;
        const mc = this.lodController.getMidNearShaderConfig();

        const data = new Float32Array(20);
        data[0] = cam.x; data[1] = cam.y; data[2] = cam.z;
        data[3] = mc.rangeStart;
        data[4] = pc.origin.x; data[5] = pc.origin.y; data[6] = pc.origin.z;
        data[7] = pc.radius;
        data[8] = mc.rangeEnd;
        data[9] = mc.subBandOverlap;
        data.set(mc.subBandStarts, 12);
        data.set(mc.subBandEnds,   16);

        this.device.queue.writeBuffer(this._trackerParamBuffer, 0, data);
    }

    _updateScatterParams(camera) {
        const s = this.streamer;
        const cam = s.uniformManager?.camera?.position || camera?.position || { x: 0, y: 0, z: 0 };
        const pc = s.planetConfig;

        const birchStart = s._templateLibrary?.getTypeStartIndex('birch') ?? 0xFFFFFFFF;
        const birchCount = s._templateLibrary?.getVariants('birch')?.length ?? 0;

        const data = new Float32Array(12);
        const u32 = new Uint32Array(data.buffer);
        data[0] = cam.x; data[1] = cam.y; data[2] = cam.z;
        data[4] = pc.origin.x; data[5] = pc.origin.y; data[6] = pc.origin.z;
        data[7] = pc.radius;
        u32[8] = birchStart >>> 0;
        u32[9] = birchCount >>> 0;

        this.device.queue.writeBuffer(this._scatterParamBuffer, 0, data);
    }

    _maybeRebuildTrackerBG() {
        if (!this._trackerBGDirty) return;
        const pool = this.streamer._pool;
        if (!pool || !this._assetSpeciesBuffer) return;

        this._trackerBG = this.device.createBindGroup({
            layout: this._trackerBGL,
            entries: [
                { binding: 0, resource: { buffer: this._trackerParamBuffer } },
                { binding: 1, resource: { buffer: pool.instanceBuffer } },
                { binding: 2, resource: { buffer: pool.indirectBuffer } },
                { binding: 3, resource: { buffer: this._treeBuffer } },
                { binding: 4, resource: { buffer: this._treeCountBuffer } },
                { binding: 5, resource: { buffer: this._assetSpeciesBuffer } },
            ],
        });
        this._trackerBGDirty = false;
    }

    _maybeRebuildTrunkScatterBG() {
        if (!this._trunkScatterBGDirty) return;
        this._trunkScatterBG = this.device.createBindGroup({
            layout: this._trunkScatterBGL,
            entries: [
                { binding: 0, resource: { buffer: this._treeBuffer } },
                { binding: 1, resource: { buffer: this._treeCountBuffer } },
                { binding: 2, resource: { buffer: this._trunkInstBuffer } },
            ],
        });
        this._trunkScatterBGDirty = false;
    }

    _maybeRebuildImpScatterBG() {
        if (!this._impScatterBGDirty) return;
        const templateLib = this.streamer._templateLibrary;
        const anchorBuffer = templateLib?.getAnchorBuffer?.();
        const templateInfoBuffer = templateLib?.getTemplateInfoBuffer?.();
        const familyBuffer = templateLib?.getFamilyBuffer?.();
        if (!anchorBuffer || !templateInfoBuffer || !familyBuffer) return;

        this._impScatterBG = this.device.createBindGroup({
            layout: this._impScatterBGL,
            entries: [
                { binding: 0, resource: { buffer: this._scatterParamBuffer } },
                { binding: 1, resource: { buffer: this._treeBuffer } },
                { binding: 2, resource: { buffer: this._treeCountBuffer } },
                { binding: 3, resource: { buffer: this._impInstBuffer } },
                { binding: 4, resource: { buffer: this._impCounterBuffer } },
                { binding: 5, resource: { buffer: this._impMetaBuffer } },
                { binding: 6, resource: { buffer: anchorBuffer } },
                { binding: 7, resource: { buffer: templateInfoBuffer } },
                { binding: 8, resource: { buffer: familyBuffer } },
            ],
        });
        this._impScatterBGDirty = false;
    }

    _kickDebugReadback() {
        if (!this._debugReadbackEnabled) return;
        if (!this._debugReadbackBuffer || this._debugReadPending) return;
        this._debugReadPending = true;
        this._debugReadbackBuffer.mapAsync(GPUMapMode.READ).then(() => {
            const data = new Uint32Array(this._debugReadbackBuffer.getMappedRange(0, 32));
            const totalFamilies = data[3] >>> 0;
            const processedFamilies = data[4] >>> 0;
            const familyCapSkipped = data[5] >>> 0;
            const atomicOverflows = data[6] >>> 0;
            const shouldLog =
                atomicOverflows > 0 ||
                familyCapSkipped > 0 ||
                (this._frameCount % 120 === 0);
            if (shouldLog) {
                Logger.warn(
                    `[Impostor][TreeMidNearSystem] MidNear family stats ` +
                    `total=${totalFamilies} processed=${processedFamilies} ` +
                    `familyCapSkipped=${familyCapSkipped} atomicOverflows=${atomicOverflows}`
                );
            }
            this._debugReadbackBuffer.unmap();
            this._debugReadPending = false;
        }).catch((err) => {
            Logger.warn(`[Impostor][TreeMidNearSystem] Debug readback failed: ${err?.message || err}`);
            try { this._debugReadbackBuffer.unmap(); } catch (_) {}
            this._debugReadPending = false;
        });
    }

    _maybeRebuildTrackerDispatchArgsBG() {
        if (!this._trackerDispatchArgsBGDirty) return;
        if (!this._trackerDispatchArgsBGL) return;

        const pool = this.streamer._pool;
        if (!pool?.indirectBuffer) return;

        this._trackerDispatchArgsBG = this.device.createBindGroup({
            label: 'MidNear-TrackerDispatchArgs-BG',
            layout: this._trackerDispatchArgsBGL,
            entries: [
                { binding: 0, resource: { buffer: pool.indirectBuffer } },
                { binding: 1, resource: { buffer: this._trackerDispatchArgsBuffer } },
            ],
        });
        this._trackerDispatchArgsBGDirty = false;
    }

    _maybeRebuildRenderBGs() {
        const desiredImpLeafMask = this.streamer?._leafMaskBaker?.isReady?.() === true;
        if (this._impUseLeafMask !== desiredImpLeafMask) {
            this._impUseLeafMask = desiredImpLeafMask;
            this._impBGsDirty = true;
        }
        if (!this._trunkBGsDirty && !this._hullBGsDirty && !this._impBGsDirty) return;

        const s = this.streamer;
        if (!s._uniformBuffer || !s._fragUniformBuffer) return;

        const texView = this._hasTex ? this._texBaker.getTextureView() : null;
        const texSamp = this._hasTex ? this._texBaker.getSampler()     : null;

        // Trunk
        if (this._trunkBGsDirty) {
            this._trunkBGs = [
                this.device.createBindGroup({
                    layout: this._trunkBGLs[0],
                    entries: [
                        { binding: 0, resource: { buffer: s._uniformBuffer } },
                        { binding: 1, resource: { buffer: this._trunkInstBuffer } },
                    ],
                }),
                this.device.createBindGroup({
                    layout: this._trunkBGLs[1],
                    entries: [
                        { binding: 0, resource: { buffer: s._fragUniformBuffer } },
                    ],
                }),
            ];
            this._trunkBGsDirty = false;
        }

        // Hull
        if (this._hullBGsDirty) {
            const templateLib = this.streamer._templateLibrary;
            const anchorBuffer = templateLib?.getAnchorBuffer?.();
            if (anchorBuffer) {
                const g1Entries = [
                    { binding: 0, resource: { buffer: s._fragUniformBuffer } },
                ];
                if (this._hasTex && texView && texSamp) {
                    g1Entries.push(
                        { binding: 1, resource: texView },
                        { binding: 2, resource: texSamp },
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
                    this.device.createBindGroup({
                        layout: this._hullBGLs[1],
                        entries: g1Entries,
                    }),
                ];
                this._hullBGsDirty = false;
            }
        }

        // Impostor
        if (this._impBGsDirty) {
            const g1Entries = [
                { binding: 0, resource: { buffer: s._fragUniformBuffer } },
            ];
            if (this._hasTex && texView && texSamp) {
                // Prefer template-derived near leaf masks when available
                // (same family as near-tier visuals), fallback to mid-near atlas.
                const maskBaker = this.streamer?._leafMaskBaker;
                const useLeafMask = maskBaker?.isReady?.() === true;
                let impView = null;
                let impSamp = null;
                if (useLeafMask) {
                    impView = maskBaker.getTextureView();
                    impSamp = maskBaker.getSampler();
                } else {
                    if (!this._impTexView) {
                        this._impTexView = this._texBaker._texture.createView({
                            dimension: '2d-array',
                            baseArrayLayer: MIDNEAR_CANOPY_LAYERS,
                            arrayLayerCount: MIDNEAR_IMPOSTOR_VARIANTS,
                        });
                    }
                    impView = this._impTexView;
                    impSamp = texSamp;
                }
                g1Entries.push(
                    { binding: 1, resource: impView },
                    { binding: 2, resource: impSamp },
                );
            }
            this._impBGs = [
                this.device.createBindGroup({
                    layout: this._impBGLs[0],
                    entries: [
                        { binding: 0, resource: { buffer: s._uniformBuffer } },
                        { binding: 1, resource: { buffer: this._impInstBuffer } },
                    ],
                }),
                this.device.createBindGroup({
                    layout: this._impBGLs[1],
                    entries: g1Entries,
                }),
            ];
            this._impBGsDirty = false;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Update / render
    // ═══════════════════════════════════════════════════════════════════════

    update(commandEncoder, camera) {
        if (!this._initialized || !this._enabled) return;
        if (this._trackerWorkgroups === 0) return;

        this._frameCount++;

        this._updateTrackerParams(camera);
        this._updateScatterParams(camera);
        this._maybeRebuildTrackerBG();
        this._maybeRebuildTrackerDispatchArgsBG();
        this._maybeRebuildTrunkScatterBG();
        this._maybeRebuildImpScatterBG();

        if (!this._trackerBG || !this._trackerDispatchArgsBG || !this._trunkScatterBG || !this._impScatterBG) return;

        // Reset counters
        this.device.queue.writeBuffer(this._treeCountBuffer, 0, new Uint32Array([0]));
        this.device.queue.writeBuffer(this._impCounterBuffer, 0, this._debugZeroData);

        // Pass 1: Build tracker dispatch args from live source-band counts
        {
            const pass = commandEncoder.beginComputePass({ label: 'MidNearTrackerDispatchArgs' });
            pass.setPipeline(this._trackerDispatchArgsPipeline);
            pass.setBindGroup(0, this._trackerDispatchArgsBG);
            pass.dispatchWorkgroups(1);
            pass.end();
        }

        // Pass 2: Tracker
        {
            const pass = commandEncoder.beginComputePass({ label: 'MidNearTracker' });
            pass.setPipeline(this._trackerPipeline);
            pass.setBindGroup(0, this._trackerBG);
            pass.dispatchWorkgroupsIndirect(this._trackerDispatchArgsBuffer, 0);
            pass.end();
        }

        // Pass 3: Dispatch args
        {
            const pass = commandEncoder.beginComputePass({ label: 'MidNearDispatch' });
            pass.setPipeline(this._dispatchArgsPipeline);
            pass.setBindGroup(0, this._dispatchArgsBG);
            pass.dispatchWorkgroups(1);
            pass.end();
        }

        // Pass 4: Trunk scatter (1 thread per tree)
        {
            const pass = commandEncoder.beginComputePass({ label: 'MidNearTrunkScatter' });
            pass.setPipeline(this._trunkScatterPipeline);
            pass.setBindGroup(0, this._trunkScatterBG);
            pass.dispatchWorkgroupsIndirect(this._dispatchArgsBuffer, 0);
            pass.end();
        }

        // Pass 5: Impostor scatter (workgroup per tree, threads walk anchors)
        {
            const pass = commandEncoder.beginComputePass({ label: 'MidNearImpScatter' });
            pass.setPipeline(this._impScatterPipeline);
            pass.setBindGroup(0, this._impScatterBG);
            pass.dispatchWorkgroupsIndirect(this._dispatchArgsBuffer, 0);
            pass.end();
        }

        // Pass 6: Indirect args
        {
            const pass = commandEncoder.beginComputePass({ label: 'MidNearIndirect' });
            pass.setPipeline(this._indirectPipeline);
            pass.setBindGroup(0, this._indirectBG);
            pass.dispatchWorkgroups(1);
            pass.end();
        }

        // Two-phase readback:
        // 1) encode GPU copy in one frame
        // 2) map/read in a later frame
        // This avoids submitting commands that touch a mapped buffer.
        if (this._debugReadbackEnabled && !this._debugReadPending) {
            if (this._debugReadQueued) {
                this._kickDebugReadback();
                this._debugReadQueued = false;
            } else {
                commandEncoder.copyBufferToBuffer(this._impCounterBuffer, 0, this._debugReadbackBuffer, 0, 32);
                this._debugReadQueued = true;
            }
        }
    }

    render(encoder) {
        if (!this._initialized || !this._enabled) return;
        if (!encoder) return;

        this._maybeRebuildRenderBGs();
        if (this._trunkBGs.length === 0 || this._hullBGs.length === 0 || this._impBGs.length === 0) return;

        // Order: trunk → hull → impostor
        // Trunk first, hull depth-occludes upper trunk.
        // Hull before impostors so impostor cards fill in
        // texture detail inside the hull silhouette.

        // Trunk
        encoder.setPipeline(this._trunkPipeline);
        encoder.setBindGroup(0, this._trunkBGs[0]);
        encoder.setBindGroup(1, this._trunkBGs[1]);
        encoder.setVertexBuffer(0, this._trunkGeo.posBuffer);
        encoder.setVertexBuffer(1, this._trunkGeo.normBuffer);
        encoder.setVertexBuffer(2, this._trunkGeo.uvBuffer);
        encoder.setIndexBuffer(this._trunkGeo.idxBuffer, 'uint16');
        encoder.drawIndexedIndirect(this._trunkIndirectBuffer, 0);

        // Hull
        encoder.setPipeline(this._hullPipeline);
        encoder.setBindGroup(0, this._hullBGs[0]);
        encoder.setBindGroup(1, this._hullBGs[1]);
        encoder.setVertexBuffer(0, this._hullGeo.posBuffer);
        encoder.setVertexBuffer(1, this._hullGeo.normBuffer);
        encoder.setVertexBuffer(2, this._hullGeo.uvBuffer);
        encoder.setIndexBuffer(this._hullGeo.idxBuffer, 'uint16');
        encoder.drawIndexedIndirect(this._hullIndirectBuffer, 0);

        // Impostors
        encoder.setPipeline(this._impPipeline);
        encoder.setBindGroup(0, this._impBGs[0]);
        encoder.setBindGroup(1, this._impBGs[1]);
        encoder.setVertexBuffer(0, this._impGeo.posBuffer);
        encoder.setVertexBuffer(1, this._impGeo.normBuffer);
        encoder.setVertexBuffer(2, this._impGeo.uvBuffer);
        encoder.setIndexBuffer(this._impGeo.idxBuffer, 'uint16');
        for (let sb = 0; sb < SUB_BAND_COUNT; sb++) {
            encoder.drawIndexedIndirect(this._impIndirectBuffer, sb * 20);
        }
    }

    setEnabled(enabled) { this._enabled = enabled; }
    isReady() { return this._initialized && this._enabled; }

    dispose() {
        this._texBaker?.dispose();
        const bufs = [
            this._treeBuffer, this._treeCountBuffer,
            this._trackerParamBuffer, this._scatterParamBuffer,
            this._assetSpeciesBuffer, this._dispatchArgsBuffer, this._trackerDispatchArgsBuffer,
            this._trunkInstBuffer, this._trunkIndirectBuffer,
            this._hullIndirectBuffer,
            this._impInstBuffer, this._impCounterBuffer,
            this._impMetaBuffer, this._impIndirectBuffer,
            this._debugReadbackBuffer,
        ];
        for (const b of bufs) b?.destroy();
        for (const geo of [this._hullGeo, this._trunkGeo, this._impGeo]) {
            if (!geo) continue;
            geo.posBuffer?.destroy();
            geo.normBuffer?.destroy();
            geo.uvBuffer?.destroy();
            geo.depthBuffer?.destroy();
            geo.idxBuffer?.destroy();
        }
        this._initialized = false;
    }
}
