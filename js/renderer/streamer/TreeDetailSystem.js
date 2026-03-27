// js/renderer/streamer/TreeDetailSystem.js
//
// UPDATED - Adds close tree tracking compute pass

import { Logger } from '../../config/Logger.js';
import { getSpeciesRegistry } from './species/SpeciesRegistry.js';
import { buildCloseTreeTrackerShader } from './shaders/closeTreeTracker.wgsl.js';
import { LODS_PER_CATEGORY, CAT_TREES } from './streamerConfig.js';
import { LeafLODTestSuite } from './LeafLODTestSuite.js';
const CLOSE_TREE_BYTES = 128;  // Per CloseTreeInfo struct

export class TreeDetailSystem {
    /**
     * @param {GPUDevice} device
     * @param {import('./AssetStreamer.js').AssetStreamer} assetStreamer
     * @param {object} [config]
     */
    constructor(device, assetStreamer, config = {}) {
        this.device = device;
        this.streamer = assetStreamer;
        this.speciesRegistry = getSpeciesRegistry();

        // All distances and caps flow from here now.
        this.lodController = config.lodController;
        if (!this.lodController) {
            throw new Error('[TreeDetailSystem] lodController is required');
        }

     
        this._trackerDispatchArgsBuffer   = null;
        this._trackerDispatchArgsPipeline = null;
        this._trackerDispatchArgsBG       = null;
        this._trackerDispatchArgsBGDirty  = true;

        // Preallocated counter reset
        this._countReset = new Uint32Array([0]);

        this._leafLODTestSuite = null;
        this._testSuiteEnabled = false;
        this.maxCloseTrees    = this.lodController.maxCloseTrees;
        this.maxTotalLeaves   = config.maxTotalLeaves   ?? 600_000;
        this.maxTotalClusters = config.maxTotalClusters ??  50_000;

        // GPU buffers
        this._closeTreeBuffer        = null;
        this._closeTreeCountBuffer   = null;
        this._trackerParamBuffer     = null;
        this._assetSpeciesBuffer     = null;
        this._assetSpeciesCount      = 0;
        this._leafDispatchArgsBuffer = null;

        this._trackerPipeline   = null;
        this._trackerBGL        = null;
        this._trackerBG         = null;
        this._trackerBGDirty    = true;
        this._trackerWorkgroups = 0;
        this._sourceBands       = [];
        this._sourceCapacity    = 0;
        this._workgroupSize     = 256;

        this._dispatchArgsPipeline = null;
        this._dispatchArgsBG       = null;

        this._leafRenderer    = null;
        this._clusterRenderer = null;

        this._initialized = false;
        this._enabled     = true;
        this._frameCount  = 0;
        this._lastCloseTreeCount = 0;
    }

    async initialize() {
        if (this._initialized) return;

        this._buildAssetSpeciesMap();
        this._createBuffers();
        this._buildSourceBands();
        this._createTrackerPipeline();
        this._createTrackerDispatchArgsPipeline();   
        this._createDispatchArgsPipeline();

        this._initialized = true;

        this._leafLODTestSuite = new LeafLODTestSuite(this.device, this.streamer, {
            lodController: this.lodController,
        });
        await this._leafLODTestSuite.initialize();

        const bands = this.lodController.detailBands;
        Logger.info(
            `[TreeDetailSystem] Initialized: ` +
            `maxTrees=${this.maxCloseTrees}, ` +
            `range=${this.lodController.detailRange}m, ` +
            `bands=[${bands.join('/')}]m, ` +
            `sourceBands=${this._sourceBands.map(b => b.band).join('/')}, ` +
            `dispatch=${this._trackerWorkgroups} wgs`
        );
    }
    /**
     * Toggle the LOD test suite on/off.
     * Called from GameEngine via AssetStreamer.
     */
    setTestSuiteEnabled(enabled) {
        this._testSuiteEnabled = !!enabled;
        if (this._leafLODTestSuite) {
            this._leafLODTestSuite.setEnabled(this._testSuiteEnabled);
        }
    }

        /**
     * Trigger a single LOD test capture. Called from GameEngine on key press.
     */
        triggerLODTestCapture() {
            this._leafLODTestSuite?.triggerCapture();
        }
    
        getLeafLODTestSuite() {
            return this._leafLODTestSuite;
        }

    isTestSuiteEnabled() {
        return this._testSuiteEnabled;
    }

    getLeafLODTestSuite() {
        return this._leafLODTestSuite;
    }
    _buildSourceBands() {
        const pool = this.streamer._pool;
        this._sourceBands = [];
        if (!pool) return;

        const treeBandBase = CAT_TREES * LODS_PER_CATEGORY;
        for (let lod = 0; lod < LODS_PER_CATEGORY; lod++) {
            const band = treeBandBase + lod;
            const capacity = pool.getBandCapacity(band) >>> 0;
            if (capacity === 0) continue;
            const base = pool.getBandBase(band) >>> 0;
            this._sourceBands.push({ band, base, capacity });
        }
    }

    _createDispatchArgsPipeline() {
        // Runs after the tracker's atomics have settled. Reads the raw
        // count, clamps to maxCloseTrees (the atomic can overshoot when
        // more trees are in range than slots — only the first N slots
        // are valid), and writes [N, 1, 1] for dispatchWorkgroupsIndirect.
        const code = /* wgsl */`
            @group(0) @binding(0) var<storage, read>       closeTreeCount: array<u32>;
            @group(0) @binding(1) var<storage, read_write> dispatchArgs:   array<u32>;

            const MAX_CLOSE_TREES: u32 = ${this.maxCloseTrees}u;

            @compute @workgroup_size(1)
            fn main() {
                let n = min(closeTreeCount[0], MAX_CLOSE_TREES);
                dispatchArgs[0] = n;
                dispatchArgs[1] = 1u;
                dispatchArgs[2] = 1u;
            }
        `;

        const mod = this.device.createShaderModule({
            label: 'TreeDetail-DispatchArgs-SM',
            code,
        });

        const bgl = this.device.createBindGroupLayout({
            label: 'TreeDetail-DispatchArgs-BGL',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE,
                  buffer: { type: 'read-only-storage' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE,
                  buffer: { type: 'storage' } },
            ],
        });

        this._dispatchArgsPipeline = this.device.createComputePipeline({
            label: 'TreeDetail-DispatchArgs-Pipeline',
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
            compute: { module: mod, entryPoint: 'main' },
        });

        this._dispatchArgsBG = this.device.createBindGroup({
            label: 'TreeDetail-DispatchArgs-BG',
            layout: bgl,
            entries: [
                { binding: 0, resource: { buffer: this._closeTreeCountBuffer } },
                { binding: 1, resource: { buffer: this._leafDispatchArgsBuffer } },
            ],
        });
    }

    _createBuffers() {
        this._closeTreeBuffer = this.device.createBuffer({
            label: 'TreeDetail-CloseTrees',
            size: Math.max(256, this.maxCloseTrees * CLOSE_TREE_BYTES),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });

        this._closeTreeCountBuffer = this.device.createBuffer({
            label: 'TreeDetail-CloseTreeCount',
            size: 256,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });

        this._trackerParamBuffer = this.device.createBuffer({
            label: 'TreeDetail-TrackerParams',
            size: 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this._trackerDispatchArgsBuffer = this.device.createBuffer({
            label: 'TreeDetail-TrackerDispatchArgs',
            size: 12,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT,
        });
        // [workgroupsX, workgroupsY, workgroupsZ] = [clampedTreeCount, 1, 1]
        // Written by the dispatch-args pass after the tracker; consumed
        // by LeafStreamer's dispatchWorkgroupsIndirect.
        this._leafDispatchArgsBuffer = this.device.createBuffer({
            label: 'TreeDetail-LeafDispatchArgs',
            size: 16,  // 3×u32 + pad
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT,
        });
    }

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

            let species = 2; // default: birch-like broadleaf
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

        if (!this._assetSpeciesBuffer) {
            this._assetSpeciesBuffer = this.device.createBuffer({
                label: 'TreeDetail-AssetSpeciesMap',
                size: Math.max(256, map.byteLength),
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
            });
        }
        this.device.queue.writeBuffer(this._assetSpeciesBuffer, 0, map);
    }
    _createTrackerDispatchArgsPipeline() {
        const bandIds = this._sourceBands.map(b => b.band);
        if (bandIds.length === 0) return;

        // Sums live instance counts across source bands from
        // treeIndirectArgs[band*5+1], writes ceil(total/WG) as dispatch X.
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
            label: 'TreeDetail-TrackerDispatchArgs-SM', code,
        });

        const bgl = this.device.createBindGroupLayout({
            label: 'TreeDetail-TrackerDispatchArgs-BGL',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
            ],
        });

        this._trackerDispatchArgsPipeline = this.device.createComputePipeline({
            label: 'TreeDetail-TrackerDispatchArgs-Pipeline',
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
            compute: { module: mod, entryPoint: 'main' },
        });

        this._trackerDispatchArgsBGL = bgl;
    }

    _maybeRebuildTrackerDispatchArgsBG() {
        if (!this._trackerDispatchArgsBGDirty) return;
        if (!this._trackerDispatchArgsBGL) return;

        const pool = this.streamer._pool;
        if (!pool?.indirectBuffer) return;

        this._trackerDispatchArgsBG = this.device.createBindGroup({
            label: 'TreeDetail-TrackerDispatchArgs-BG',
            layout: this._trackerDispatchArgsBGL,
            entries: [
                { binding: 0, resource: { buffer: pool.indirectBuffer } },
                { binding: 1, resource: { buffer: this._trackerDispatchArgsBuffer } },
            ],
        });
        this._trackerDispatchArgsBGDirty = false;
    }

    _createTrackerPipeline() {
        const speciesCount = this.speciesRegistry.getSpeciesIds().length;
        const code = buildCloseTreeTrackerShader({
            workgroupSize: this._workgroupSize,
            maxCloseTrees: this.maxCloseTrees,
            speciesCount,
            assetCount: this._assetSpeciesCount,
            treeSourceBandIds: this._sourceBands.map(b => b.band),
            treeSourceBandBases: this._sourceBands.map(b => b.base),
        });

        const mod = this.device.createShaderModule({ 
            label: 'CloseTreeTracker-SM', 
            code 
        });

        this._trackerBGL = this.device.createBindGroupLayout({
            label: 'CloseTreeTracker-BGL',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
            ]
        });

        this._trackerPipeline = this.device.createComputePipeline({
            label: 'CloseTreeTracker-Pipeline',
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [this._trackerBGL] }),
            compute: { module: mod, entryPoint: 'main' }
        });
    }

    _updateTrackerParams(camera) {
        const s    = this.streamer;
        const cam  = s.uniformManager?.camera?.position || camera?.position || { x: 0, y: 0, z: 0 };
        const pc   = s.planetConfig;
        const lc   = this.lodController;
    
        // 20 words = 80 bytes. Layout must match TrackerParams in the shader.
        //   [0-3]   cameraPosition.xyz + detailRange
        //   [4-7]   planetOrigin.xyz + planetRadius
        //   [8-11]  time (f32) + reserved u32/u32/u32
        //   [12-15] bandStarts (vec4)
        //   [16-19] bandEnds   (vec4)
        const data = new Float32Array(20);
        const u32  = new Uint32Array(data.buffer);
    
        data[0] = cam.x;
        data[1] = cam.y;
        data[2] = cam.z;
        data[3] = lc.detailRange;
    
        data[4] = pc.origin.x;
        data[5] = pc.origin.y;
        data[6] = pc.origin.z;
        data[7] = pc.radius;
    
        data[8]  = performance.now() / 1000.0;
        u32[9]   = 0;
        u32[10]  = 0;
        u32[11]  = 0;
    
        // Band boundaries — overlapping ranges for stochastic transition.
        // vec4-packed; shader indexes with runtime u32.
        data.set(lc.leafBandStarts, 12);
        data.set(lc.leafBandEnds,   16);
    
        this.device.queue.writeBuffer(this._trackerParamBuffer, 0, data);
    }
    _maybeRebuildTrackerBG() {
        if (!this._trackerBGDirty) return;
        
        const pool = this.streamer._pool;
        if (!pool) return;
        if (!this._assetSpeciesBuffer) return;

        this._trackerBG = this.device.createBindGroup({
            layout: this._trackerBGL,
            entries: [
                { binding: 0, resource: { buffer: this._trackerParamBuffer } },
                { binding: 1, resource: { buffer: pool.instanceBuffer } },
                { binding: 2, resource: { buffer: pool.indirectBuffer } },
                { binding: 3, resource: { buffer: this._closeTreeBuffer } },
                { binding: 4, resource: { buffer: this._closeTreeCountBuffer } },
                { binding: 5, resource: { buffer: this._assetSpeciesBuffer } },
            ]
        });

        this._trackerBGDirty = false;
    }
    update(commandEncoder, camera) {
        if (!this._initialized || !this._enabled) return;
        if (this._sourceBands.length === 0) return;

        this._frameCount++;

        this._updateTrackerParams(camera);
        this._maybeRebuildTrackerBG();
        this._maybeRebuildTrackerDispatchArgsBG();

        if (!this._trackerBG || !this._trackerDispatchArgsBG) return;

        this.device.queue.writeBuffer(this._closeTreeCountBuffer, 0, this._countReset);

        // ── Build tracker dispatch args from LIVE band counts ───────────
        // Scatter wrote treeIndirectArgs earlier in this encoder; those
        // writes are visible here because compute passes are ordered.
        {
            const pass = commandEncoder.beginComputePass({ label: 'TrackerDispatchArgs' });
            pass.setPipeline(this._trackerDispatchArgsPipeline);
            pass.setBindGroup(0, this._trackerDispatchArgsBG);
            pass.dispatchWorkgroups(1);
            pass.end();
        }

        // ── Tracker: one thread per LIVE tree instance ──────────────────
        {
            const pass = commandEncoder.beginComputePass({ label: 'CloseTreeTracker' });
            pass.setPipeline(this._trackerPipeline);
            pass.setBindGroup(0, this._trackerBG);
            pass.dispatchWorkgroupsIndirect(this._trackerDispatchArgsBuffer, 0);
            pass.end();
        }

        // ── Leaf dispatch-args builder (unchanged) ──────────────────────
        {
            const pass = commandEncoder.beginComputePass({ label: 'LeafDispatchArgs' });
            pass.setPipeline(this._dispatchArgsPipeline);
            pass.setBindGroup(0, this._dispatchArgsBG);
            pass.dispatchWorkgroups(1);
            pass.end();
        }

        if (this._leafLODTestSuite?.isActive()) {
            this._leafLODTestSuite.update(commandEncoder, camera);
        }
    }
    /**
     * Render detailed trees.
     * @param {GPURenderPassEncoder} encoder
     * @param {object} camera
     * @param {Float32Array} viewMatrix
     * @param {Float32Array} projectionMatrix
     */
    render(encoder, camera, viewMatrix, projectionMatrix) {
        if (!this._initialized || !this._enabled) return;
        
        // Future: render branches, leaves, clusters
    }

    getCloseTreeBuffer() {
        return this._closeTreeBuffer;
    }

    getCloseTreeCountBuffer() {
        return this._closeTreeCountBuffer;
    }

    setEnabled(enabled) {
        this._enabled = enabled;
    }

    getLeafDispatchArgsBuffer() {
        return this._leafDispatchArgsBuffer;
    }

    isReady() {
        return this._initialized && this._enabled;
    }

    getStats() {
        return {
            closeTrees: this._lastCloseTreeCount,
            enabled: this._enabled
        };
    }

    dispose() {
        this._trackerDispatchArgsBuffer?.destroy();
        this._leafLODTestSuite?.dispose();
        this._leafLODTestSuite?.dispose();
        this._closeTreeBuffer?.destroy();
        this._closeTreeCountBuffer?.destroy();
        this._trackerParamBuffer?.destroy();
        this._leafDispatchArgsBuffer?.destroy();
        this._assetSpeciesBuffer?.destroy();
        this._leafRenderer?.dispose?.();
        this._clusterRenderer?.dispose?.();
        this._initialized = false;
    }
}
