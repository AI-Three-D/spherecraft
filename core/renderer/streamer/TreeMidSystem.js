// js/renderer/streamer/TreeMidSystem.js
//
// Hull-only mid-distance tree tier. Replaces TreeMidNearSystem.
//
// Key differences from TreeMidNearSystem:
//   • NO impostors. Trunk + hull only.
//   • Canopy bounds precomputed in tracker (once/tree) not VS (once/vertex).
//     This is the 18× perf win.
//   • NO per-fragment anchor density loop. Noise-only porosity.
//   • Mid tier still uses a single range, but the hull FS now has a
//     near/far sub-band treatment for coverage and breakup.
//   • Config from treeTierConfig.js, not TreeLODController's mid-near glob.
//
// Pipeline:
//   Compute:
//     1. Tracker dispatch args (reads live pool counts)
//     2. Tracker: filter by range, resolve species→template, read anchors,
//        compute canopy bounds, write MidTreeInfo (128B/tree)
//     3. Indirect builder: [hullIndexCount, treeCount, ...] + trunk equivalent
//   Render:
//     1. Trunk (one indirect draw)
//     2. Hull (one indirect draw)

import { Logger } from '../../../shared/Logger.js';
import { MidNearGeometryBuilder } from './MidNearGeometryBuilder.js';
import { MidNearTextureBaker } from './MidNearTextureBaker.js';
import { buildMidTreeTrackerShader } from './shaders/midTreeTracker.wgsl.js';
import {
    buildMidTrunkVertexShader,
    buildMidTrunkFragmentShader,
    buildMidHullVertexShader,
    buildMidHullFragmentShader,
} from './shaders/midTreeRender.wgsl.js';

const MID_TREE_BYTES = 128;
const TRUNK_INSTANCE_BYTES = 48;   // matches mid-near trunk layout — reuse scatter logic inline

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
        trunk: {
            ...base.trunk,
            ...(override.trunk || {}),
        },
    };
}

export class TreeMidSystem {
    constructor(device, assetStreamer, config = {}) {
        this.device = device;
        this.streamer = assetStreamer;
        const streamerTheme = assetStreamer?._streamerTheme;
        if (!streamerTheme) {
            throw new Error('[TreeMidSystem] requires assetStreamer with _streamerTheme');
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
        // to compute the crossfade overlap. All mid-tier config comes
        // from treeTierConfig.js.
        this.lodController = config.lodController;
        if (!this.lodController) {
            throw new Error('[TreeMidSystem] lodController is required');
        }

        // Snapshot config at construction. rebuildPipelines() re-reads.
        this._range = {
            ...this.TREE_TIER_RANGES.mid,
            ...(this._configOverride.tierRange || {}),
        };
        this._cfg = resolveMidTierConfig(this._configOverride.midConfig, this.MID_TIER_CONFIG);
        this._speciesProfiles = {
            ...JSON.parse(JSON.stringify(this.SPECIES_CANOPY_PROFILES)),
            ...(this._configOverride.speciesProfiles || {}),
        };
        this.maxTrees = this._cfg.maxTrees;

        // ── GPU resources ──────────────────────────────────────────────────
        this._treeBuffer = null;
        this._treeCountBuffer = null;
        this._trackerParamBuffer = null;
        this._assetSpeciesBuffer = null;
        this._assetSpeciesCount = 0;

        this._trackerDispatchArgsBuffer = null;
        this._trunkIndirectBuffer = null;
        this._hullIndirectBuffer = null;

        this._hullGeo = null;
        this._trunkGeo = null;
        this._texBaker = null;

        // ── Pipelines ──────────────────────────────────────────────────────
        this._trackerPipeline = null;
        this._trackerBGL = null;
        this._trackerBG = null;
        this._trackerBGDirty = true;

        this._trackerDispatchArgsPipeline = null;
        this._trackerDispatchArgsBGL = null;
        this._trackerDispatchArgsBG = null;
        this._trackerDispatchArgsBGDirty = true;

        this._indirectPipeline = null;
        this._indirectBG = null;

        this._trunkPipeline = null;
        this._trunkBGLs = [];
        this._trunkBGs = [];
        this._trunkBGsDirty = true;

        this._hullPipeline = null;
        this._hullBGLs = [];
        this._hullBGs = [];
        this._hullBGsDirty = true;

        // ── Source bands (tree pool LOD slices we scan) ────────────────────
        this._sourceBands = [];
        this._workgroupSize = 256;

        this._initialized = false;
        this._enabled = true;
        this._frameCount = 0;
        this._countReset = new Uint32Array([0]);
        this._countReadbackBuffer = null;
        this._countReadbackQueued = false;
        this._countReadbackPending = false;
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
        this._createIndirectPipeline();
        this._createRenderPipelines();

        this._initialized = true;

        const r = this._range;
        Logger.info(
            `[TreeMidSystem] Initialized: range=[${r.start}..${r.end}]m ` +
            `fadeIn=${r.fadeInWidth}m fadeOut=${r.fadeOutWidth}m ` +
            `maxTrees=${this.maxTrees} ` +
            `endDensity=${Number(this._cfg.endDensityScale ?? 1.0).toFixed(2)} ` +
            `hull=${this._cfg.hull.lonSegments}×${this._cfg.hull.latSegments} ` +
            `vsAnchors=${this._cfg.hull.vsAnchorSamples}`
        );
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Hot-reload for Task 3 tuning
    // ═══════════════════════════════════════════════════════════════════════

    rebuildPipelines(options = {}) {
        if (!this._initialized) return;

        // Re-read config module (caller may have mutated it).
        this._range = {
            ...this.TREE_TIER_RANGES.mid,
            ...(this._configOverride.tierRange || {}),
        };
        this._cfg = resolveMidTierConfig(this._configOverride.midConfig, this.MID_TIER_CONFIG);
        this._speciesProfiles = {
            ...JSON.parse(JSON.stringify(this.SPECIES_CANOPY_PROFILES)),
            ...(this._configOverride.speciesProfiles || {}),
        };

        if (options.rebuildGeometry) {
            for (const geo of [this._hullGeo, this._trunkGeo]) {
                if (!geo) continue;
                geo.posBuffer?.destroy();
                geo.normBuffer?.destroy();
                geo.uvBuffer?.destroy();
                geo.idxBuffer?.destroy();
            }
            this._hullGeo = null;
            this._trunkGeo = null;
            this._buildGeometry();
        }

        this._createTrackerPipeline();
        this._createTrackerDispatchArgsPipeline();
        this._createIndirectPipeline();
        this._createRenderPipelines();

        this._trackerBGDirty = true;
        this._trackerDispatchArgsBGDirty = true;
        this._trunkBGsDirty = true;
        this._hullBGsDirty = true;

        Logger.info(`[TreeMidSystem] Pipelines rebuilt${options.rebuildGeometry ? ' (with geometry)' : ''}`);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Setup
    // ═══════════════════════════════════════════════════════════════════════

    _buildAssetSpeciesMap() {
        // Same mapping logic as TreeMidNearSystem / TreeDetailSystem.
        // TODO: lift this into a shared helper — third copy of this code.
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
            else if (id.includes('spruce')) species = 0;
            else if (id.includes('pine')) species = 1;
            else if (geom === 'conifer') species = 0;
            else if (geom === 'deciduous_broad') species = 4;
            else if (geom === 'deciduous') species = 2;
            map[i] = species;
        }

        this._assetSpeciesBuffer = this.device.createBuffer({
            label: 'Mid-AssetSpeciesMap',
            size: Math.max(256, map.byteLength),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(this._assetSpeciesBuffer, 0, map);
    }

    _buildSourceBands() {
        const pool = this.streamer._pool;
        this._sourceBands = [];
        if (!pool) return;

        const treeBandBase = this.CAT_TREES * this.LODS_PER_CATEGORY;
        for (let lod = 0; lod < this.LODS_PER_CATEGORY; lod++) {
            const band = treeBandBase + lod;
            const capacity = pool.getBandCapacity(band) >>> 0;
            if (capacity === 0) continue;
            const base = pool.getBandBase(band) >>> 0;
            this._sourceBands.push({ band, base, capacity });
        }
    }

    _createBuffers() {
        this._treeBuffer = this.device.createBuffer({
            label: 'Mid-Trees',
            size: Math.max(256, this.maxTrees * MID_TREE_BYTES),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });

        this._treeCountBuffer = this.device.createBuffer({
            label: 'Mid-TreeCount',
            size: 256,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });

        this._trackerParamBuffer = this.device.createBuffer({
            label: 'Mid-TrackerParams',
            size: 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this._trackerDispatchArgsBuffer = this.device.createBuffer({
            label: 'Mid-TrackerDispatchArgs',
            size: 16,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT,
        });

        this._trunkIndirectBuffer = this.device.createBuffer({
            label: 'Mid-TrunkIndirect',
            size: Math.max(256, 5 * 4),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
        });

        this._hullIndirectBuffer = this.device.createBuffer({
            label: 'Mid-HullIndirect',
            size: Math.max(256, 5 * 4),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
        });
    }

    _buildGeometry() {
        const h = this._cfg.hull;
        const t = this._cfg.trunk;

        const hull = MidNearGeometryBuilder.buildCanopyHull(h.lonSegments, h.latSegments);
        const trunk = MidNearGeometryBuilder.buildTrunkCylinder({
            taperTop: t.taperTop,
            embedFrac: 0.08,
        });

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
            posBuffer: mkVB(hull.positions, 'MidHull-Pos'),
            normBuffer: mkVB(hull.normals, 'MidHull-Norm'),
            uvBuffer: mkVB(hull.uvs, 'MidHull-UV'),
            idxBuffer: mkIB(hull.indices, 'MidHull-Idx'),
            idxCount: hull.indexCount,
        };

        this._trunkGeo = {
            posBuffer: mkVB(trunk.positions, 'MidTrunk-Pos'),
            normBuffer: mkVB(trunk.normals, 'MidTrunk-Norm'),
            uvBuffer: mkVB(trunk.uvs, 'MidTrunk-UV'),
            idxBuffer: mkIB(trunk.indices, 'MidTrunk-Idx'),
            idxCount: trunk.indexCount,
        };
    }

    async _bakeTextures() {
        // Reuse the mid-near texture baker for now. Its canopy layer 0
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

    _createTrackerPipeline() {
        // Tracker does the heavy lifting: species resolve, template lookup,
        // anchor iteration for bounds. One thread per LIVE pool instance.
        const code = buildMidTreeTrackerShader({
            workgroupSize: this._workgroupSize,
            maxTrees: this.maxTrees,
            endDensityScale: this._cfg.endDensityScale,
            assetCount: this._assetSpeciesCount,
            treeSourceBandIds: this._sourceBands.map(b => b.band),
            treeSourceBandBases: this._sourceBands.map(b => b.base),
            treeSourceBandCaps: this._sourceBands.map(b => b.capacity),
            rangeStart: this._range.start,
            rangeEnd: this._range.end,
            fadeInWidth: this._range.fadeInWidth,
            fadeOutWidth: this._range.fadeOutWidth,
            // Tracker reads up to this many anchors for bounds. Bounds
            // closer birch mid trees use fine anchors, so raise the sample
            // budget enough to preserve crown breakup in the hull bounds.
            maxAnchorsForBounds: 32,
            speciesProfiles: this._speciesProfiles,
        });

        const mod = this.device.createShaderModule({ label: 'MidTracker-SM', code });

        this._trackerBGL = this.device.createBindGroupLayout({
            label: 'MidTracker-BGL',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } }, // pool instances
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } }, // pool indirect (live counts)
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },           // out: trees
                { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },           // out: count
                { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } }, // species map
                { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } }, // anchors
                { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } }, // template infos
            ],
        });

        this._trackerPipeline = this.device.createComputePipeline({
            label: 'MidTracker-Pipeline',
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [this._trackerBGL] }),
            compute: { module: mod, entryPoint: 'main' },
        });
    }

    _createTrackerDispatchArgsPipeline() {
        const bandIds = this._sourceBands.map(b => b.band);
        if (bandIds.length === 0) return;

        const code = /* wgsl */`
            const SOURCE_BAND_COUNT: u32 = ${bandIds.length}u;
            const WORKGROUP_SIZE: u32 = ${this._workgroupSize}u;
            const SOURCE_BAND_IDS: array<u32, SOURCE_BAND_COUNT> =
                array<u32, SOURCE_BAND_COUNT>(${bandIds.map(v => `${v >>> 0}u`).join(', ')});

            @group(0) @binding(0) var<storage, read>       treeIndirectArgs: array<u32>;
            @group(0) @binding(1) var<storage, read_write> dispatchArgs: array<u32>;

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

        const mod = this.device.createShaderModule({ label: 'Mid-TrackerDispatchArgs-SM', code });

        this._trackerDispatchArgsBGL = this.device.createBindGroupLayout({
            label: 'Mid-TrackerDispatchArgs-BGL',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
            ],
        });

        this._trackerDispatchArgsPipeline = this.device.createComputePipeline({
            label: 'Mid-TrackerDispatchArgs-Pipeline',
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [this._trackerDispatchArgsBGL] }),
            compute: { module: mod, entryPoint: 'main' },
        });
    }

    _createIndirectPipeline() {
        const code = /* wgsl */`
            const HULL_INDEX_COUNT: u32 = ${this._hullGeo.idxCount}u;
            const TRUNK_INDEX_COUNT: u32 = ${this._trunkGeo.idxCount}u;
            const MAX_TREES: u32 = ${this.maxTrees}u;

            @group(0) @binding(0) var<storage, read>       treeCount: array<u32>;
            @group(0) @binding(1) var<storage, read_write> trunkIndirect: array<u32>;
            @group(0) @binding(2) var<storage, read_write> hullIndirect: array<u32>;

            @compute @workgroup_size(1)
            fn main() {
                let tc = min(treeCount[0], MAX_TREES);

                trunkIndirect[0] = TRUNK_INDEX_COUNT;
                trunkIndirect[1] = tc;
                trunkIndirect[2] = 0u;
                trunkIndirect[3] = 0u;
                trunkIndirect[4] = 0u;

                hullIndirect[0] = HULL_INDEX_COUNT;
                hullIndirect[1] = tc;
                hullIndirect[2] = 0u;
                hullIndirect[3] = 0u;
                hullIndirect[4] = 0u;
            }
        `;
        const mod = this.device.createShaderModule({ label: 'MidIndirect-SM', code });
        const bgl = this.device.createBindGroupLayout({
            label: 'MidIndirect-BGL',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
            ],
        });
        this._indirectPipeline = this.device.createComputePipeline({
            label: 'MidIndirect-Pipeline',
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
            compute: { module: mod, entryPoint: 'main' },
        });
        this._indirectBG = this.device.createBindGroup({
            label: 'MidIndirect-BG', layout: bgl,
            entries: [
                { binding: 0, resource: { buffer: this._treeCountBuffer } },
                { binding: 1, resource: { buffer: this._trunkIndirectBuffer } },
                { binding: 2, resource: { buffer: this._hullIndirectBuffer } },
            ],
        });
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
        ];

        // ── Trunk ──────────────────────────────────────────────────────────
        {
            const vsMod = this.device.createShaderModule({
                label: 'MidTrunk-VS',
                code: buildMidTrunkVertexShader({
                    visibleHeightFrac: this._cfg.trunk.visibleHeightFrac,
                    baseRadiusFrac: this._cfg.trunk.baseRadiusFrac,
                }),
            });
            const fsMod = this.device.createShaderModule({
                label: 'MidTrunk-FS',
                code: buildMidTrunkFragmentShader({
                    ...fadeBounds,
                    trunkFadeEnd: this._cfg.trunk.fadeEnd,
                }),
            });

            const g0 = this.device.createBindGroupLayout({
                label: 'MidTrunk-G0',
                entries: [
                    { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
                    { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
                ],
            });
            const g1 = this.device.createBindGroupLayout({
                label: 'MidTrunk-G1',
                entries: [
                    { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
                ],
            });
            this._trunkBGLs = [g0, g1];

            this._trunkPipeline = this.device.createRenderPipeline({
                label: 'MidTrunk-Pipeline',
                layout: this.device.createPipelineLayout({ bindGroupLayouts: this._trunkBGLs }),
                vertex: { module: vsMod, entryPoint: 'main', buffers: vertexBuffers },
                fragment: { module: fsMod, entryPoint: 'main', targets: [{ format: canvasFormat }] },
                primitive: triListCCWBack,
                depthStencil: depthLess,
            });
        }

        // ── Hull ───────────────────────────────────────────────────────────
        {
            const vsMod = this.device.createShaderModule({
                label: 'MidHull-VS',
                code: buildMidHullVertexShader({
                    vsAnchorSamples: this._cfg.hull.vsAnchorSamples,
                    inflation: this._cfg.hull.inflation,
                    shrinkWrap: this._cfg.hull.shrinkWrap,
                    gapShrink: this._cfg.hull.gapShrink,
                    verticalBias: this._cfg.hull.verticalBias,
                    topShrinkStart: this._cfg.hull.topShrinkStart,
                    topShrinkStrength: this._cfg.hull.topShrinkStrength,
                    lumpNearScale: this._cfg.hull.lumpNearScale,
                    lumpFarScale: this._cfg.hull.lumpFarScale,
                    lumpNearDistance: this._cfg.hull.lumpNearDistance,
                    lumpFarDistance: this._cfg.hull.lumpFarDistance,
                }),
            });
            const fsMod = this.device.createShaderModule({
                label: 'MidHull-FS',
                code: buildMidHullFragmentShader({
                    ...fadeBounds,
                    // Spread the whole hullFrag block. New Tier 1 fields
                    // (baseCoverageNear/Far, subband*, macroGap*, edge*, bottomBreak)
                    // flow through automatically. Legacy `baseCoverage` still
                    // works via the fallback in the shader builder.
                    ...this._cfg.hullFrag,
                    // Keep this last — depends on runtime texture availability,
                    // not config. Must not be overridable by hullFrag.
                    enableCanopyTexture: hasTex,
                }),
            });
            const g0 = this.device.createBindGroupLayout({
                label: 'MidHull-G0',
                entries: [
                    { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
                    { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } }, // trees
                    { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } }, // anchors (VS only)
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
            const g1 = this.device.createBindGroupLayout({ label: 'MidHull-G1', entries: g1Entries });
            this._hullBGLs = [g0, g1];

            this._hullPipeline = this.device.createRenderPipeline({
                label: 'MidHull-Pipeline',
                layout: this.device.createPipelineLayout({ bindGroupLayouts: this._hullBGLs }),
                vertex: { module: vsMod, entryPoint: 'main', buffers: vertexBuffers },
                fragment: { module: fsMod, entryPoint: 'main', targets: [{ format: canvasFormat }] },
                primitive: triListCCWBack,
                depthStencil: depthLess,
            });
        }

        this._hasTex = hasTex;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Per-frame updates
    // ═══════════════════════════════════════════════════════════════════════

    _updateTrackerParams(camera) {
        const s = this.streamer;
        const cam = s.uniformManager?.camera?.position || camera?.position || { x: 0, y: 0, z: 0 };
        const pc = s.planetConfig;

        const birchStart = s._templateLibrary?.getTypeStartIndex('birch') ?? 0xFFFFFFFF;
        const birchCount = s._templateLibrary?.getVariants('birch')?.length ?? 0;

        // 16 floats = 64 bytes. Layout:
        //   [0-2] cameraPos  [3] rangeStart
        //   [4-6] planetOrigin [7] planetRadius
        //   [8] rangeEnd  [9] fadeInWidth  [10] fadeOutWidth
        //   [11-12] (u32) birchTemplateStart/Count  [13-15] reserved
        const data = new Float32Array(16);
        const u32 = new Uint32Array(data.buffer);
        data[0] = cam.x; data[1] = cam.y; data[2] = cam.z;
        data[3] = this._range.start;
        data[4] = pc.origin.x; data[5] = pc.origin.y; data[6] = pc.origin.z;
        data[7] = pc.radius;
        data[8] = this._range.end;
        data[9] = this._range.fadeInWidth;
        data[10] = this._range.fadeOutWidth;
        u32[11] = birchStart >>> 0;
        u32[12] = birchCount >>> 0;

        this.device.queue.writeBuffer(this._trackerParamBuffer, 0, data);
    }

    _maybeRebuildTrackerBG() {
        if (!this._trackerBGDirty) return;
        const pool = this.streamer._pool;
        if (!pool || !this._assetSpeciesBuffer) return;

        const templateLib = this.streamer._templateLibrary;
        const anchorBuffer = templateLib?.getAnchorBuffer?.();
        const templateInfoBuffer = templateLib?.getTemplateInfoBuffer?.();
        if (!anchorBuffer || !templateInfoBuffer) return;

        this._trackerBG = this.device.createBindGroup({
            layout: this._trackerBGL,
            entries: [
                { binding: 0, resource: { buffer: this._trackerParamBuffer } },
                { binding: 1, resource: { buffer: pool.instanceBuffer } },
                { binding: 2, resource: { buffer: pool.indirectBuffer } },
                { binding: 3, resource: { buffer: this._treeBuffer } },
                { binding: 4, resource: { buffer: this._treeCountBuffer } },
                { binding: 5, resource: { buffer: this._assetSpeciesBuffer } },
                { binding: 6, resource: { buffer: anchorBuffer } },
                { binding: 7, resource: { buffer: templateInfoBuffer } },
            ],
        });
        this._trackerBGDirty = false;
    }

    _maybeRebuildTrackerDispatchArgsBG() {
        if (!this._trackerDispatchArgsBGDirty || !this._trackerDispatchArgsBGL) return;
        const pool = this.streamer._pool;
        if (!pool?.indirectBuffer) return;

        this._trackerDispatchArgsBG = this.device.createBindGroup({
            label: 'Mid-TrackerDispatchArgs-BG',
            layout: this._trackerDispatchArgsBGL,
            entries: [
                { binding: 0, resource: { buffer: pool.indirectBuffer } },
                { binding: 1, resource: { buffer: this._trackerDispatchArgsBuffer } },
            ],
        });
        this._trackerDispatchArgsBGDirty = false;
    }

    _maybeRebuildRenderBGs() {
        if (!this._trunkBGsDirty && !this._hullBGsDirty) return;
        const s = this.streamer;
        if (!s._uniformBuffer || !s._fragUniformBuffer) return;

        if (this._trunkBGsDirty) {
            this._trunkBGs = [
                this.device.createBindGroup({
                    layout: this._trunkBGLs[0],
                    entries: [
                        { binding: 0, resource: { buffer: s._uniformBuffer } },
                        { binding: 1, resource: { buffer: this._treeBuffer } },
                    ],
                }),
                this.device.createBindGroup({
                    layout: this._trunkBGLs[1],
                    entries: [{ binding: 0, resource: { buffer: s._fragUniformBuffer } }],
                }),
            ];
            this._trunkBGsDirty = false;
        }

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

    // ═══════════════════════════════════════════════════════════════════════
    // Update / render
    // ═══════════════════════════════════════════════════════════════════════

    update(commandEncoder, camera) {
        if (!this._initialized || !this._enabled) return;
        if (this._sourceBands.length === 0) return;

        this._frameCount++;
        this._kickCountReadback();
        this._updateTrackerParams(camera);
        this._maybeRebuildTrackerBG();
        this._maybeRebuildTrackerDispatchArgsBG();

        if (!this._trackerBG || !this._trackerDispatchArgsBG) return;

        this.device.queue.writeBuffer(this._treeCountBuffer, 0, this._countReset);

        // Pass 1: build tracker dispatch args from live pool counts
        {
            const pass = commandEncoder.beginComputePass({ label: 'MidTrackerDispatchArgs' });
            pass.setPipeline(this._trackerDispatchArgsPipeline);
            pass.setBindGroup(0, this._trackerDispatchArgsBG);
            pass.dispatchWorkgroups(1);
            pass.end();
        }

        // Pass 2: tracker — filter + species + template + bounds, all in one
        {
            const pass = commandEncoder.beginComputePass({ label: 'MidTracker' });
            pass.setPipeline(this._trackerPipeline);
            pass.setBindGroup(0, this._trackerBG);
            pass.dispatchWorkgroupsIndirect(this._trackerDispatchArgsBuffer, 0);
            pass.end();
        }

        // Pass 3: indirect draw args
        {
            const pass = commandEncoder.beginComputePass({ label: 'MidIndirect' });
            pass.setPipeline(this._indirectPipeline);
            pass.setBindGroup(0, this._indirectBG);
            pass.dispatchWorkgroups(1);
            pass.end();
        }

        this._queueCountReadback(commandEncoder);
    }

    render(encoder) {
        if (!this._initialized || !this._enabled || !encoder) return;

        this._maybeRebuildRenderBGs();
        if (this._trunkBGs.length === 0 || this._hullBGs.length === 0) return;

        // Trunk before hull: hull occludes upper trunk via depth.
        encoder.setPipeline(this._trunkPipeline);
        encoder.setBindGroup(0, this._trunkBGs[0]);
        encoder.setBindGroup(1, this._trunkBGs[1]);
        encoder.setVertexBuffer(0, this._trunkGeo.posBuffer);
        encoder.setVertexBuffer(1, this._trunkGeo.normBuffer);
        encoder.setVertexBuffer(2, this._trunkGeo.uvBuffer);
        encoder.setIndexBuffer(this._trunkGeo.idxBuffer, 'uint16');
        encoder.drawIndexedIndirect(this._trunkIndirectBuffer, 0);

        encoder.setPipeline(this._hullPipeline);
        encoder.setBindGroup(0, this._hullBGs[0]);
        encoder.setBindGroup(1, this._hullBGs[1]);
        encoder.setVertexBuffer(0, this._hullGeo.posBuffer);
        encoder.setVertexBuffer(1, this._hullGeo.normBuffer);
        encoder.setVertexBuffer(2, this._hullGeo.uvBuffer);
        encoder.setIndexBuffer(this._hullGeo.idxBuffer, 'uint16');
        encoder.drawIndexedIndirect(this._hullIndirectBuffer, 0);
    }

    setEnabled(enabled) { this._enabled = enabled; }
    isReady() { return this._initialized && this._enabled; }

    _ensureCountReadbackBuffer() {
        if (this._countReadbackBuffer) return;
        this._countReadbackBuffer = this.device.createBuffer({
            label: 'MidTree-CountReadback',
            size: 256,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });
    }

    _queueCountReadback(commandEncoder) {
        if (!commandEncoder || this._countReadbackQueued || this._countReadbackPending) return;
        const shouldSample = this._frameCount === 60 || (this._frameCount % 240) === 0;
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
            Logger.info(`[TreeMidSystem] tracked=${count}/${this.maxTrees}`);
            this._countReadbackBuffer.unmap();
            this._countReadbackQueued = false;
            this._countReadbackPending = false;
        }).catch((err) => {
            Logger.warn(`[TreeMidSystem] count readback failed: ${err?.message || err}`);
            try { this._countReadbackBuffer?.unmap(); } catch (_) {}
            this._countReadbackQueued = false;
            this._countReadbackPending = false;
        });
    }

    dispose() {
        this._texBaker?.dispose();
        for (const b of [
            this._treeBuffer, this._treeCountBuffer, this._trackerParamBuffer,
            this._assetSpeciesBuffer, this._trackerDispatchArgsBuffer,
            this._trunkIndirectBuffer, this._hullIndirectBuffer, this._countReadbackBuffer,
        ]) b?.destroy();
        for (const geo of [this._hullGeo, this._trunkGeo]) {
            if (!geo) continue;
            geo.posBuffer?.destroy();
            geo.normBuffer?.destroy();
            geo.uvBuffer?.destroy();
            geo.idxBuffer?.destroy();
        }
        this._initialized = false;
    }
}
