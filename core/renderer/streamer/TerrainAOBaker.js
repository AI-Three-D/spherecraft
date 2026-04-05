// js/renderer/streamer/TerrainAOBaker.js
//
// Owns the terrain contact-AO mask texture array and the compute pipeline
// that bakes it. A bake is queued every time a tile commits to a pool
// layer; the queue is drained at maxBakesPerFrame. At steady state (no
// new tiles loading) this costs nothing.
//
// The bake shader replicates scatter placement deterministically, so the
// mask tracks *actual* asset placement without needing to read the
// per-frame (frustum-culled) instance buffer.
//
// The mask is also the data source for future asset self-occlusion — an
// asset shader can sample the same texture at its instance position.

import { Logger } from '../../../shared/Logger.js';
import { Texture, TextureFormat, TextureFilter, TextureWrap, gpuFormatSampleType } from '../resources/texture.js';
import { buildTerrainAOBakeShader } from './shaders/terrainAOBake.wgsl.js';

export class TerrainAOBaker {
    /**
     * @param {GPUDevice} device
     * @param {object}    opts
     * @param {number}    opts.tilePoolSize   — layers in the tile pool (MUST match)
     * @param {object}    opts.planetConfig
     * @param {number}    opts.faceSize       — world metres across one cube face
     * @param {number}    opts.seed           — engine seed (MUST match scatter)
     * @param {number}    opts.gcCellWorldSize — scatter GC cell size in metres
     * @param {object}    [opts.aoConfig]     — overrides this.TERRAIN_AO_CONFIG
     */
    constructor(device, opts = {}) {
        if (!opts.streamerTheme) {
            throw new Error('[TerrainAOBaker] requires opts.streamerTheme');
        }
        this._streamerTheme = opts.streamerTheme;
        this.TERRAIN_AO_CONFIG = opts.streamerTheme.TERRAIN_AO_CONFIG;
        this.TREE_CELL_SIZE = opts.streamerTheme.TREE_CELL_SIZE;
        this.TREE_MAX_PER_CELL = opts.streamerTheme.TREE_MAX_PER_CELL;
        this.TREE_CLUSTER_PROBABILITY = opts.streamerTheme.TREE_CLUSTER_PROBABILITY;
        this.TREE_JITTER_SCALE = opts.streamerTheme.TREE_JITTER_SCALE;
        this.TREE_DENSITY_SCALE = opts.streamerTheme.TREE_DENSITY_SCALE;

        this.device       = device;
        this._logTag      = '[TerrainAOBaker]';
        this._tilePoolSize = opts.tilePoolSize;
        this._planetConfig = opts.planetConfig;
        this._faceSize     = opts.faceSize;
        this._seed         = (opts.seed ?? 0) >>> 0;
        this._gcCellWorldSize = opts.gcCellWorldSize ?? 3.0;
        this._textureFormats = opts.textureFormats || {};
        this._tileLayerLookup = typeof opts.tileLayerLookup === 'function'
            ? opts.tileLayerLookup
            : null;

        const c = { ...this.TERRAIN_AO_CONFIG, ...(opts.aoConfig || {}) };
        const tree = { ...this.TERRAIN_AO_CONFIG.tree, ...(c.tree || {}) };
        const gc   = { ...this.TERRAIN_AO_CONFIG.groundCover, ...(c.groundCover || {}) };

        this._cfg = {
            enabled:          c.enabled !== false,
            resolution:       Math.max(16, c.resolution | 0),
            maxBakesPerFrame: Math.max(1, Math.min(32, c.maxBakesPerFrame | 0)),
            aoFloor:          Math.max(0, Math.min(1, c.aoFloor)),

            treeRadiusM:     tree.radiusMeters,
            treeStrength:    tree.strength,
            treeInnerRatio:  tree.innerRatio,
            treeSearch:      Math.max(1, tree.cellSearchRadius | 0),

            gcEnable:   gc.enable !== false,
            gcRadiusM:  gc.radiusMeters,
            gcStrength: gc.strength,
            gcKeepProb: gc.keepProbability,
            gcSearch:   Math.max(1, gc.cellSearchRadius | 0),
        };

        // Compile-time batch cap. Tile list storage buffer is sized to this.
        this._maxBatch = this._cfg.maxBakesPerFrame;

        this._aoTexture        = null;
        this._aoTextureWrapper = null;

        this._paramBuffer = null;
        this._tileBuffer  = null;
        this._tileStaging = null;
        this._tileStagingU32 = null;
        this._tileStagingF32 = null;

        this._bakeBGL   = null;
        this._bakePipe  = null;
        this._bakeBG    = null;
        this._bgCache   = { scatter: null, tile: null };

        this._clearPipe = null;
        this._clearBG   = null;

        // FIFO of {face, depth, tileX, tileY, layer}. Deduped by layer on push.
        this._queue = [];
        this._logDispatches   = opts.logDispatches !== false;
        this._logEveryNth     = opts.logEveryNth ?? 4;   // don't spam on warmup
        this._dispatchCount   = 0;
    
        this._initialized = false;

        this._initialized = false;
    }

    get enabled() { return this._cfg.enabled; }

    initialize() {
        if (this._initialized || !this._cfg.enabled) return;
        if (!Number.isFinite(this._tilePoolSize) || this._tilePoolSize < 1) {
            Logger.warn(`${this._logTag} invalid tilePoolSize; disabling`);
            this._cfg.enabled = false;
            return;
        }

        this._createAOTexture();
        this._createBuffers();
        this._createBakePipeline();
        this._createClearPipelineAndRun();   // one-time clear to AO=1.0

        this._initialized = true;
        Logger.info(
            `${this._logTag} ready — res=${this._cfg.resolution} ` +
            `layers=${this._tilePoolSize} mem=${this._memMB().toFixed(1)}MB ` +
            `batch=${this._maxBatch}`
        );
    }

    /** Wrapper compatible with the terrain material's array-texture bindings. */
    getAOTextureWrapper() { return this._aoTextureWrapper; }

    get pendingBakes() { return this._queue.length; }

    /**
     * Queue a tile for AO baking. Called on tile commit.
     * Dedupes by layer: if a layer is already queued, the newer commit
     * replaces it (the older tile was evicted and its bake is now stale).
     */
    enqueueBake(face, depth, tileX, tileY, layer) {
        if (!this._initialized) return;
        for (let i = this._queue.length - 1; i >= 0; i--) {
            if (this._queue[i].layer === layer) { this._queue.splice(i, 1); }
        }
        this._queue.push({ face, depth, tileX, tileY, layer });
    }

update(encoder, scatterGPU, tileGPU) {
    if (!this._initialized || !encoder) return;
    if (this._queue.length === 0) return;
    if (!scatterGPU || !tileGPU) {
        // Bakes will wait. This is normal for the first couple of frames
        // before pool textures exist — but if you NEVER see a dispatch
        // log after that, the texture handles aren't being passed in.
        if (this._logDispatches && this._dispatchCount === 0) {
            Logger.info(`${this._logTag} bake deferred — pool textures not yet available ` +
                        `(queue=${this._queue.length})`);
        }
        return;
    }

    this._rebuildBindGroupIfStale(scatterGPU, tileGPU);
    if (!this._bakeBG) return;

    const batch = this._queue.splice(0, this._maxBatch);
    this._dispatchCount++;

    // Dispatch log. Shows what depths are being baked so you can correlate
    // with the coarse-tile early-out: if every baked tile is at d≤12 and
    // your planet is Earth-sized, they're all going to produce 1.0 and
    // that's correct behaviour, not a bug.
    if (this._logDispatches &&
        (this._dispatchCount === 1 || (this._dispatchCount % this._logEveryNth) === 0)) {
        const depths = batch.map(t => t.depth);
        const dMin = Math.min(...depths);
        const dMax = Math.max(...depths);
        const layers = batch.map(t => t.layer).slice(0, 4).join(',');
        Logger.info(
            `${this._logTag} bake #${this._dispatchCount}: ` +
            `batch=${batch.length} depth=[${dMin}..${dMax}] ` +
            `layers=[${layers}${batch.length > 4 ? ',…' : ''}] ` +
            `pending=${this._queue.length}`
        );
    }

    this._uploadParams(batch.length);
    this._uploadTiles(batch);

    const res = this._cfg.resolution;
    const wg  = Math.ceil(res / 8);

    const pass = encoder.beginComputePass({ label: 'TerrainAO-Bake' });
    pass.setPipeline(this._bakePipe);
    pass.setBindGroup(0, this._bakeBG);
    pass.dispatchWorkgroups(wg, wg, batch.length);
    pass.end();

}

    dispose() {
        this._aoTexture?.destroy();
        this._paramBuffer?.destroy();
        this._tileBuffer?.destroy();
        this._aoTextureWrapper = null;
        this._bakeBG = null;
        this._clearBG = null;
        this._initialized = false;
    }

    // ── private ─────────────────────────────────────────────────────────────

    _memMB() {
        const r = this._cfg.resolution;
        return (r * r * 4 * this._tilePoolSize) / (1024 * 1024);
    }

    _createAOTexture() {
        const res = this._cfg.resolution;

        // r32float: baseline storage-binding support on every WebGPU device.
        // r8unorm/r16float would save memory but require optional features.
        this._aoTexture = this.device.createTexture({
            label: 'TerrainAO-Mask',
            size: [res, res, this._tilePoolSize],
            format: 'r32float',
            dimension: '2d',
            usage: GPUTextureUsage.STORAGE_BINDING
                 | GPUTextureUsage.TEXTURE_BINDING,
        });

        // Wrapper so the terrain material sees it like any other pool texture.
        const w = new Texture({
            width: res, height: res, depth: this._tilePoolSize,
            format: TextureFormat.R32F,
            minFilter: TextureFilter.NEAREST,
            magFilter: TextureFilter.NEAREST,
            wrapS: TextureWrap.CLAMP, wrapT: TextureWrap.CLAMP,
            generateMipmaps: false,
        });
        w._gpuTexture = {
            texture: this._aoTexture,
            view:    this._aoTexture.createView({ dimension: '2d-array' }),
            format:  'r32float',
        };
        w._needsUpload = false;
        w._isArray     = true;
        w._isGPUOnly   = true;
        this._aoTextureWrapper = w;
    }

    _createBuffers() {
        this._paramBuffer = this.device.createBuffer({
            label: 'TerrainAO-Params',
            size: 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        // 40 u32 per tile × maxBatch. Includes neighbor fallback mapping
        // (layer + uvBias/uvScale) so AO can sample across LOD borders.
        const tileStride = 40;
        const tileBytes = this._maxBatch * tileStride * 4;
        this._tileBuffer = this.device.createBuffer({
            label: 'TerrainAO-TileList',
            size: tileBytes,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this._tileStaging = new ArrayBuffer(tileBytes);
        this._tileStagingU32 = new Uint32Array(this._tileStaging);
        this._tileStagingF32 = new Float32Array(this._tileStaging);
    }

    _createBakePipeline() {
        const scatterSampleType = gpuFormatSampleType(
            this._textureFormats.scatter || 'r32float'
        );
        const tileSampleType = gpuFormatSampleType(
            this._textureFormats.tile || 'r32float'
        );
        const code = buildTerrainAOBakeShader({
            aoResolution:           this._cfg.resolution,
            maxBatchSize:           this._maxBatch,
            treeCellSize:           this.TREE_CELL_SIZE,
            treeMaxPerCell:         this.TREE_MAX_PER_CELL,
            treeClusterProbability: this.TREE_CLUSTER_PROBABILITY,
            treeJitterScale:        this.TREE_JITTER_SCALE,
            treeDensityScale:       this.TREE_DENSITY_SCALE,
            treeCellSearchRadius:   this._cfg.treeSearch,
            gcCellSearchRadius:     this._cfg.gcSearch,
        });

        const mod = this.device.createShaderModule({
            label: 'TerrainAO-BakeShader', code,
        });

        this._bakeBGL = this.device.createBindGroupLayout({
            label: 'TerrainAO-BakeBGL',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE,
                  buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE,
                  buffer: { type: 'read-only-storage' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE,
                  texture: { sampleType: scatterSampleType, viewDimension: '2d-array' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE,
                  texture: { sampleType: tileSampleType, viewDimension: '2d-array' } },
                { binding: 4, visibility: GPUShaderStage.COMPUTE,
                  storageTexture: { access: 'write-only', format: 'r32float',
                                    viewDimension: '2d-array' } },
            ],
        });

        this._bakePipe = this.device.createComputePipeline({
            label: 'TerrainAO-BakePipe',
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [this._bakeBGL],
            }),
            compute: { module: mod, entryPoint: 'bake' },
        });
    }

    /**
     * One-shot clear of the entire AO array to 1.0 (no occlusion).
     * Separate tiny shader + BGL so it can run before the scatter/tile
     * textures exist. Submits its own command buffer.
     */
    _createClearPipelineAndRun() {
        const res = this._cfg.resolution;

        const mod = this.device.createShaderModule({
            label: 'TerrainAO-ClearShader',
            code: /* wgsl */`
                @group(0) @binding(0)
                var aoOut: texture_storage_2d_array<r32float, write>;
                @compute @workgroup_size(8, 8, 1)
                fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
                    if (gid.x >= ${res}u || gid.y >= ${res}u) { return; }
                    textureStore(aoOut, vec2<i32>(gid.xy), i32(gid.z),
                                 vec4<f32>(1.0, 0.0, 0.0, 0.0));
                }
            `,
        });

        const bgl = this.device.createBindGroupLayout({
            label: 'TerrainAO-ClearBGL',
            entries: [{
                binding: 0, visibility: GPUShaderStage.COMPUTE,
                storageTexture: { access: 'write-only', format: 'r32float',
                                  viewDimension: '2d-array' },
            }],
        });

        this._clearPipe = this.device.createComputePipeline({
            label: 'TerrainAO-ClearPipe',
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
            compute: { module: mod, entryPoint: 'main' },
        });

        this._clearBG = this.device.createBindGroup({
            label: 'TerrainAO-ClearBG',
            layout: bgl,
            entries: [{
                binding: 0,
                resource: this._aoTexture.createView({ dimension: '2d-array' }),
            }],
        });

        const wg = Math.ceil(res / 8);
        const enc = this.device.createCommandEncoder({ label: 'TerrainAO-InitClear' });
        const pass = enc.beginComputePass();
        pass.setPipeline(this._clearPipe);
        pass.setBindGroup(0, this._clearBG);
        pass.dispatchWorkgroups(wg, wg, this._tilePoolSize);
        pass.end();
        this.device.queue.submit([enc.finish()]);
    }

    _rebuildBindGroupIfStale(scatterGPU, tileGPU) {
        if (this._bakeBG &&
            this._bgCache.scatter === scatterGPU &&
            this._bgCache.tile    === tileGPU) {
            return;
        }

        this._bakeBG = this.device.createBindGroup({
            label: 'TerrainAO-BakeBG',
            layout: this._bakeBGL,
            entries: [
                { binding: 0, resource: { buffer: this._paramBuffer } },
                { binding: 1, resource: { buffer: this._tileBuffer } },
                { binding: 2, resource: scatterGPU.createView({ dimension: '2d-array' }) },
                { binding: 3, resource: tileGPU.createView({ dimension: '2d-array' }) },
                { binding: 4, resource: this._aoTexture.createView({ dimension: '2d-array' }) },
            ],
        });
        this._bgCache.scatter = scatterGPU;
        this._bgCache.tile    = tileGPU;
    }

    _uploadParams(batchCount) {
        const buf = new ArrayBuffer(256);
        const f32 = new Float32Array(buf);
        const u32 = new Uint32Array(buf);
        const o   = this._planetConfig.origin;

        f32[0] = o.x; f32[1] = o.y; f32[2] = o.z;
        f32[3] = this._planetConfig.radius;

        f32[4] = this._planetConfig.heightScale;
        f32[5] = this._faceSize;
        u32[6] = this._seed;
        u32[7] = batchCount >>> 0;

        f32[8]  = this._cfg.treeRadiusM;
        f32[9]  = this._cfg.treeStrength;
        f32[10] = this._cfg.treeInnerRatio;
        f32[11] = this._cfg.aoFloor;

        u32[12] = this._cfg.gcEnable ? 1 : 0;
        f32[13] = this._cfg.gcRadiusM;
        f32[14] = this._cfg.gcStrength;
        f32[15] = this._cfg.gcKeepProb;

        f32[16] = this._gcCellWorldSize;

        this.device.queue.writeBuffer(this._paramBuffer, 0, buf);
    }

    _uploadTiles(batch) {
        const sU32 = this._tileStagingU32;
        const sF32 = this._tileStagingF32;
        sU32.fill(0);
        const stride = 40;
        for (let i = 0; i < batch.length; i++) {
            const b = i * stride;
            const t = batch[i];
            const neighbors = this._resolveNeighborInfo(t);
            sU32[b]   = t.face;
            sU32[b+1] = t.depth;
            sU32[b+2] = t.tileX;
            sU32[b+3] = t.tileY;
            sU32[b+4] = t.layer;
            sF32[b+5] = 0.0;
            sF32[b+6] = 0.0;
            sF32[b+7] = 1.0;

            this._writeNeighborInfo(sU32, sF32, b + 8,  neighbors.left);
            this._writeNeighborInfo(sU32, sF32, b + 12, neighbors.right);
            this._writeNeighborInfo(sU32, sF32, b + 16, neighbors.bottom);
            this._writeNeighborInfo(sU32, sF32, b + 20, neighbors.top);
            this._writeNeighborInfo(sU32, sF32, b + 24, neighbors.bottomLeft);
            this._writeNeighborInfo(sU32, sF32, b + 28, neighbors.bottomRight);
            this._writeNeighborInfo(sU32, sF32, b + 32, neighbors.topLeft);
            this._writeNeighborInfo(sU32, sF32, b + 36, neighbors.topRight);
        }
        this.device.queue.writeBuffer(this._tileBuffer, 0, this._tileStaging);
    }

    _writeNeighborInfo(u32View, f32View, base, info) {
        u32View[base] = info.layer >>> 0;
        f32View[base + 1] = info.uvBiasX;
        f32View[base + 2] = info.uvBiasY;
        f32View[base + 3] = info.uvScale;
    }

    _resolveNeighborInfo(tile) {
        const invalid = 0xFFFFFFFF;
        const lookup = this._tileLayerLookup;
        if (!lookup) {
            return {
                left: { layer: invalid, uvBiasX: 0, uvBiasY: 0, uvScale: 1 },
                right: { layer: invalid, uvBiasX: 0, uvBiasY: 0, uvScale: 1 },
                bottom: { layer: invalid, uvBiasX: 0, uvBiasY: 0, uvScale: 1 },
                top: { layer: invalid, uvBiasX: 0, uvBiasY: 0, uvScale: 1 },
                bottomLeft: { layer: invalid, uvBiasX: 0, uvBiasY: 0, uvScale: 1 },
                bottomRight: { layer: invalid, uvBiasX: 0, uvBiasY: 0, uvScale: 1 },
                topLeft: { layer: invalid, uvBiasX: 0, uvBiasY: 0, uvScale: 1 },
                topRight: { layer: invalid, uvBiasX: 0, uvBiasY: 0, uvScale: 1 },
            };
        }

        const gridSize = 1 << tile.depth;
        const sample = (dx, dy) => {
            const x = tile.tileX + dx;
            const y = tile.tileY + dy;
            if (x < 0 || x >= gridSize || y < 0 || y >= gridSize) {
                return { layer: invalid, uvBiasX: 0, uvBiasY: 0, uvScale: 1 };
            }
            return this._lookupLayerWithFallback(tile.face, tile.depth, x, y);
        };

        return {
            left: sample(-1, 0),
            right: sample(1, 0),
            bottom: sample(0, -1),
            top: sample(0, 1),
            bottomLeft: sample(-1, -1),
            bottomRight: sample(1, -1),
            topLeft: sample(-1, 1),
            topRight: sample(1, 1),
        };
    }

    _lookupLayerWithFallback(face, depth, x, y) {
        const invalid = 0xFFFFFFFF;
        const lookup = this._tileLayerLookup;
        const exact = lookup(face, depth, x, y);
        if (Number.isInteger(exact) && exact >= 0) {
            return { layer: exact >>> 0, uvBiasX: 0, uvBiasY: 0, uvScale: 1 };
        }

        let d = depth;
        let tx = x;
        let ty = y;
        let scale = 1.0;
        let biasX = 0.0;
        let biasY = 0.0;
        for (let step = 0; step < 16; step++) {
            if (d === 0) break;
            scale *= 0.5;
            biasX += (tx & 1) * scale;
            biasY += (ty & 1) * scale;
            tx >>= 1;
            ty >>= 1;
            d -= 1;
            const layer = lookup(face, d, tx, ty);
            if (Number.isInteger(layer) && layer >= 0) {
                return { layer: layer >>> 0, uvBiasX: biasX, uvBiasY: biasY, uvScale: scale };
            }
        }

        return { layer: invalid, uvBiasX: 0, uvBiasY: 0, uvScale: 1 };
    }
}
