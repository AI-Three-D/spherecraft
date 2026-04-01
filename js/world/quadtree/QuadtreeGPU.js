// js/world/quadtree/QuadtreeGPU.js
//
// GPU resource manager for the quadtree traversal pipeline.
//
// Owns every GPU buffer the quadtree needs:
//   - Uniform buffer (camera, planet, LOD parameters)
//   - Two work queues for ping-pong BFS traversal
//   - Visible tile output buffer
//   - Atomic counter buffer
//   - Staging buffers for CPU readback (debug / feedback)
//
// Also creates and manages the traversal compute pipeline (iteration 5)
// and provides methods for dispatching traversal and reading results.
//
// Usage:
//   const qt = new QuadtreeGPU(device, { planetRadius: 50000 });
//   await qt.initialize();
//   // Each frame:
//   qt.updateUniforms(camera);
//   qt.traverse(commandEncoder);
//   // Periodic debug readback:
//   const results = await qt.readResults();

import { TileAddress } from './tileAddress.js';
import { Logger } from '../../config/Logger.js';
import { buildTraversalShaderSource } from './quadtreeTraversal.wgsl.js';
import { buildInstanceBuilderShaderSource } from './instanceBufferBuilder.wgsl.js';

// ─── Uniform layout constants ─────────────────────────────────────────────
// Matches the TraversalParams struct in the WGSL shader.
// Total: 32 floats = 128 bytes, padded to 256 for uniform alignment safety.

const UNIFORM_FLOATS  = 64;  // 256 bytes / 4
const UNIFORM_BYTES   = UNIFORM_FLOATS * 4;

// Float32 offsets into the uniform buffer
const U_CAMERA_POS     = 0;   // vec3 + pad
const U_PLANET_ORIGIN  = 4;   // vec3
const U_PLANET_RADIUS  = 7;
const U_VIEW_PROJ      = 8;   // mat4x4 (16 floats)
const U_FACE_SIZE      = 24;
const U_MAX_DEPTH      = 25;  // u32
const U_SCREEN_HEIGHT  = 26;
const U_TAN_HALF_FOV   = 27;
const U_LOD_FACTOR     = 28;
const U_LOD_THRESHOLD  = 29;  // f32 — lodErrorThreshold
const U_MAX_VIS_TILES  = 30;  // u32
const U_QUEUE_CAPACITY = 31;  // u32
const U_MAX_GEOM_LOD   = 32;  // u32
const U_VISIBLE_TABLE_MASK = 33; // u32
const U_VISIBLE_TABLE_CAP = 34; // u32
const U_LOADED_TABLE_MASK = 35; // u32
const U_LOADED_TABLE_CAP = 36; // u32
const U_MAX_FEEDBACK   = 37; // u32
const U_USE_FRUSTUM    = 38; // u32
const U_USE_HORIZON    = 39; // u32
const U_MAX_HEIGHT_DISP = 40; // f32
const U_HORIZON_GROUND_COS = 41; // f32
const U_HORIZON_BLEND_SCALE = 42; // f32
const U_CURRENT_EPOCH = 43;     // u32
const U_DO_VISIBLE_CLEAR = 44;  // u32

// ─── Buffer size helpers ──────────────────────────────────────────────────

const TILE_NODE_BYTES = 16;   // vec4<u32> = 4 × 4 bytes
const COUNTER_COUNT   = 4;    // 4 atomic<u32>
const COUNTER_BYTES   = COUNTER_COUNT * 4;
const DEBUG_SEED_COUNT = 16;  // Must match DEBUG_SEED_COUNT in quadtreeTraversal.wgsl.js
const DEBUG_PARAM_COUNT = 24; // Must match DEBUG_PARAM_COUNT in quadtreeTraversal.wgsl.js
const DEBUG_PARAM_BYTES = DEBUG_PARAM_COUNT * 4;
const DEBUG_COUNTER_COUNT = 8; // Must match debugCounters size in quadtreeTraversal.wgsl.js
const DEBUG_COUNTER_BYTES = DEBUG_COUNTER_COUNT * 4;

function nextPow2(value) {
    let v = Math.max(1, Math.floor(value));
    v--;
    v |= v >> 1;
    v |= v >> 2;
    v |= v >> 4;
    v |= v >> 8;
    v |= v >> 16;
    v++;
    return v;
}

export class QuadtreeGPU {
    /**
     * @param {GPUDevice} device
     * @param {object}    config
     * @param {number}      config.planetRadius       Sphere radius in world units
     * @param {object}      [config.planetOrigin]     { x, y, z } planet center
     * @param {number}      [config.maxDepth]         Override auto-computed max depth
     * @param {number}      [config.minTileSize=1024] Finest tile side in world units
     * @param {number}      [config.maxVisibleTiles=8192]
     * @param {number}      [config.queueCapacity=16384]  Nodes per work queue
     * @param {number}      [config.screenHeight=1080]
     * @param {number}      [config.fovDegrees=75]
     * @param {number}      [config.lodErrorThreshold=512]  Screen pixels to trigger split
     * @param {number}      [config.workgroupSize=64]
     * @param {number}      [config.maxGeomLOD=6]
     * @param {number}      [config.visibleTableCapacity]
     * @param {number}      [config.loadedTableCapacity]
     * @param {number}      [config.maxFeedback=4096]
     * @param {boolean}     [config.enableFrustumCulling=true]
     * @param {boolean}     [config.enableHorizonCulling=true]
     */
    constructor(device, config = {}) {
        if (!device) throw new Error('QuadtreeGPU: device is required');
        if (!Number.isFinite(config.planetRadius) || config.planetRadius <= 0) {
            throw new Error('QuadtreeGPU: planetRadius must be a positive number');
        }

        this.device = device;

        // ── Planet ──────────────────────────────────────────────────────
        this.planetRadius = config.planetRadius;
        this.planetOrigin = {
            x: config.planetOrigin?.x ?? 0,
            y: config.planetOrigin?.y ?? 0,
            z: config.planetOrigin?.z ?? 0
        };
        this.faceSize = 2.0 * this.planetRadius;

        // ── Quadtree ────────────────────────────────────────────────────
        this.maxHeightDisplacement = config.maxHeightDisplacement ?? 0;
        this.maxDepth = config.maxDepth ??
            TileAddress.computeMaxDepth(this.planetRadius, config.minTileSize ?? 1024);
        this.maxVisibleTiles = config.maxVisibleTiles ?? 8192;
        this.queueCapacity   = config.queueCapacity   ?? 16384;

        // ── LOD ─────────────────────────────────────────────────────────
        this.screenHeight      = config.screenHeight      ?? 1080;
        this.fovDegrees        = config.fovDegrees        ?? 75;
        this.lodErrorThreshold = config.lodErrorThreshold ?? 512;

        const fovRad       = this.fovDegrees * Math.PI / 180;
        this.tanHalfFov    = Math.tan(fovRad * 0.5);
        this.lodFactor     = this.screenHeight / (2.0 * this.tanHalfFov);

        
        // ── Workgroup ───────────────────────────────────────────────────
        this.workgroupSize = config.workgroupSize ?? 64;
// QuadtreeGPU.js (in constructor)
this._debugReadbackLock = Promise.resolve();
this._instanceStagePool = [];  // array of GPUBuffer
this._instanceStagePoolSize = 3;
this._instanceStageBytes = 0;

        // ── Geometry LOD mapping ───────────────────────────────────────
        this.maxGeomLOD = Number.isFinite(config.maxGeomLOD) ? Math.max(0, Math.floor(config.maxGeomLOD)) : 6;
        this.lodLevels = this.maxGeomLOD + 1;

        // ── Hash tables / feedback ─────────────────────────────────────
        this.visibleTableCapacity = nextPow2(config.visibleTableCapacity ?? (this.maxVisibleTiles * 2));
        this.visibleTableMask = this.visibleTableCapacity - 1;
        this.loadedTableCapacity = nextPow2(config.loadedTableCapacity ?? (this.maxVisibleTiles * 2));
        this.loadedTableMask = this.loadedTableCapacity - 1;
        this.maxFeedback = Number.isFinite(config.maxFeedback)
            ? Math.max(1, Math.floor(config.maxFeedback))
            : Math.max(256, Math.floor(this.maxVisibleTiles / 2));

        this.enableFrustumCulling = config.enableFrustumCulling !== false;
        this.enableHorizonCulling = config.enableHorizonCulling !== false;
        this.horizonGroundCos = Number.isFinite(config.horizonGroundCos)
            ? config.horizonGroundCos
            : -0.05;
        this.horizonBlendScale = Number.isFinite(config.horizonBlendScale)
            ? config.horizonBlendScale
            : 1.25;

        // ── GPU resources (created in initialize()) ─────────────────────
        this._uniformBuffer        = null;
        this._queueBufferA         = null;
        this._queueBufferB         = null;
        this._visibleTileBuffer    = null;
        this._counterBuffer        = null;
        this._counterStagingBuffer = null;
        this._tileStagingBuffer    = null;
        this._debugSeedsBuffer     = null;
        this._debugParamsBuffer    = null;
        this._debugCountersBuffer  = null;

        this._visibleTableBuffer   = null;
        this._loadedTableBuffer    = null;
        this._instanceBuffer       = null;
        this._metaBuffer           = null;
        this._feedbackBuffer       = null;
        this._lodIndexBuffer       = null;
        this._metaFeedbackOffsetBytes = 0;

        // ── Pipeline (created in initialize()) ──────────────────────────
        this._pipeline        = null;
        this._bindGroupLayout = null;
        this._bindGroup       = null;

        this._instancePipeline = null;
        this._instanceBindGroupLayout = null;
        this._instanceBindGroup = null;

        // ── CPU-side uniform scratch (written each frame) ───────────────
        this._uniformData = new ArrayBuffer(UNIFORM_BYTES);
        this._uniformF32  = new Float32Array(this._uniformData);
        this._uniformU32  = new Uint32Array(this._uniformData);

        // ── State ───────────────────────────────────────────────────────
        this._initialized       = false;
        this._lastVisibleCount  = 0;
        this._frameCount        = 0;
        this._logInterval       = 120;
        this._logStatsEnabled   = config.logStats === true;
        this._debugReadPending  = false;

        // ── Visible table epoch (avoids per-frame GPU clear) ────────────
        this._visibleEpoch = 0;
        this._framesSinceClear = 256; // Trigger clear on first frame
        this._visibleClearInterval = 256;

        // ── Stats ───────────────────────────────────────────────────────
        this._stats = {
            totalTraversals:  0,
            lastVisibleTiles: 0,
            avgVisibleTiles:  0,
            gpuMemoryBytes:   0
        };
    }
// QuadtreeGPU.js
async _withDebugReadbackLock(fn) {
    // Serialize all debug readbacks to avoid mapAsync overlap across different debug reads.
    const prev = this._debugReadbackLock;
    let release;
    this._debugReadbackLock = new Promise(r => (release = r));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
  
  _ensureInstanceStagePool(minBytes) {
    const bytes = Math.max(minBytes, 4096);
    if (bytes <= this._instanceStageBytes && this._instanceStagePool.length === this._instanceStagePoolSize) return;
  
    // destroy old pool
    for (const b of this._instanceStagePool) {
      try { b.destroy(); } catch {}
    }
    this._instanceStagePool = [];
    this._instanceStageBytes = bytes;
  
    for (let i = 0; i < this._instanceStagePoolSize; i++) {
      this._instanceStagePool.push(this.device.createBuffer({
        label: `QT-InstanceStage-${i}`,
        size: bytes,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      }));
    }
    this._instanceStagePoolIndex = 0;
  }
  
  _nextStageBuffer() {
    const b = this._instanceStagePool[this._instanceStagePoolIndex];
    this._instanceStagePoolIndex = (this._instanceStagePoolIndex + 1) % this._instanceStagePool.length;
    return b;
  }
  
    
    async debugReadMetaBuffer() {
        if (!this._initialized || !this._metaBuffer) return null;
    
        const maxLOD = this.maxGeomLOD + 1;
        const metaBytes = Math.ceil(((maxLOD * 8) + 5) * 4 / 256) * 256;
    
        const staging = this.device.createBuffer({
            label: 'QT-MetaDebugStaging',
            size: metaBytes,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        });
    
        const encoder = this.device.createCommandEncoder({ label: 'QT-ReadMeta' });
        encoder.copyBufferToBuffer(this._metaBuffer, 0, staging, 0, metaBytes);
        this.device.queue.submit([encoder.finish()]);
    
        await staging.mapAsync(GPUMapMode.READ);
        const data = new Uint32Array(staging.getMappedRange());
    
        const result = {
            lodCounts: [],
            lodOffsets: [],
            lodInstanceCounts: [],
            feedbackCount: 0,
            parentFallbackHits: 0,
            coveringProbeSum: 0,
            coveringProbeCount: 0,
            coveringProbeMisses: 0
        };
    
        for (let i = 0; i < maxLOD; i++) {
            result.lodCounts.push(data[i]);
            result.lodOffsets.push(data[maxLOD + i]);
    
            const argsBase = maxLOD * 3 + i * 5;
            result.lodInstanceCounts.push(data[argsBase + 1]);
        }
    
        const feedbackIndex = maxLOD * 8;
        result.feedbackCount = data[feedbackIndex];
        result.parentFallbackHits = data[feedbackIndex + 1];
        result.coveringProbeSum = data[feedbackIndex + 2] ?? 0;
        result.coveringProbeCount = data[feedbackIndex + 3] ?? 0;
        result.coveringProbeMisses = data[feedbackIndex + 4] ?? 0;
    
        staging.unmap();
        staging.destroy();
    
        const totalInstances = result.lodInstanceCounts.reduce((a, b) => a + b, 0);
    
        const avgProbe = result.coveringProbeCount > 0
            ? (result.coveringProbeSum / result.coveringProbeCount)
            : 0;

        Logger.info(
            `[QT-Meta] instancesWritten=${totalInstances} ` +
            `fallbackHits=${result.parentFallbackHits} ` +
            `coveringAvgProbes=${avgProbe.toFixed(2)} ` +
            `coveringMisses=${result.coveringProbeMisses}`
        );
    
        return result;
    }
    async initialize() {
        if (this._initialized) return;

        this._createBuffers();
        this._createPipeline();
        this._createBindGroup();
        this._createInstancePipeline();
        this._createInstanceBindGroup();

        this._initialized = true;

        Logger.info(
            `[QuadtreeGPU] Initialized | ` +
            `maxDepth=${this.maxDepth}, ` +
            `maxVisibleTiles=${this.maxVisibleTiles}, ` +
            `queueCapacity=${this.queueCapacity}, ` +
            `lodThreshold=${this.lodErrorThreshold}, ` +
            `planetRadius=${this.planetRadius}, ` +
            `faceSize=${this.faceSize}, ` +
            `gpuMem=${(this._stats.gpuMemoryBytes / 1024).toFixed(0)}KB`
        );
    }

    isReady() {
        return this._initialized;
    }

    dispose() {
        const destroy = (buf) => { if (buf) buf.destroy(); };

        destroy(this._uniformBuffer);
        destroy(this._queueBufferA);
        destroy(this._queueBufferB);
        destroy(this._visibleTileBuffer);
        destroy(this._counterBuffer);
        destroy(this._counterStagingBuffer);
        destroy(this._tileStagingBuffer);
        destroy(this._debugSeedsBuffer);
        destroy(this._debugParamsBuffer);
        destroy(this._debugCountersBuffer);
        destroy(this._visibleTableBuffer);
        destroy(this._loadedTableBuffer);
        destroy(this._instanceBuffer);
        destroy(this._metaBuffer);
        destroy(this._feedbackBuffer);
        destroy(this._lodIndexBuffer);

        this._uniformBuffer        = null;
        this._queueBufferA         = null;
        this._queueBufferB         = null;
        this._visibleTileBuffer    = null;
        this._counterBuffer        = null;
        this._counterStagingBuffer = null;
        this._tileStagingBuffer    = null;
        this._debugSeedsBuffer     = null;
        this._debugParamsBuffer    = null;
        this._debugCountersBuffer  = null;
        this._visibleTableBuffer   = null;
        this._loadedTableBuffer    = null;
        this._instanceBuffer       = null;
        this._metaBuffer           = null;
        this._feedbackBuffer       = null;
        this._lodIndexBuffer       = null;

        this._pipeline        = null;
        this._bindGroupLayout = null;
        this._bindGroup       = null;

        this._instancePipeline = null;
        this._instanceBindGroupLayout = null;
        this._instanceBindGroup = null;

        this._initialized = false;

        Logger.info('[QuadtreeGPU] Disposed');
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Per-frame uniform update
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Pack camera and LOD parameters into the uniform buffer.
     * Call once per frame before traverse().
     *
     * @param {object} camera  Must have: position {x,y,z},
     *                          matrixWorldInverse, projectionMatrix,
     *                          fov (degrees), aspect
     * @param {object} [options]
     * @param {number}   [options.screenHeight]       Override stored value
     * @param {number}   [options.lodErrorThreshold]  Override stored value
     */
    updateUniforms(camera, options = {}) {
        if (!this._initialized) return;

        const f32 = this._uniformF32;
        const u32 = this._uniformU32;

        // Update dynamic parameters if provided
        if (Number.isFinite(options.screenHeight)) {
            this.screenHeight = options.screenHeight;
            const fovRad = this.fovDegrees * Math.PI / 180;
            this.tanHalfFov = Math.tan(fovRad * 0.5);
            this.lodFactor = this.screenHeight / (2.0 * this.tanHalfFov);
        }
        if (Number.isFinite(options.lodErrorThreshold)) {
            this.lodErrorThreshold = options.lodErrorThreshold;
        }

        // ── Camera position (offset 0–3) ────────────────────────────────
        f32[U_CAMERA_POS]     = camera.position.x;
        f32[U_CAMERA_POS + 1] = camera.position.y;
        f32[U_CAMERA_POS + 2] = camera.position.z;
        f32[U_CAMERA_POS + 3] = 0; // pad

        // ── Planet origin + radius (offset 4–7) ─────────────────────────
        f32[U_PLANET_ORIGIN]     = this.planetOrigin.x;
        f32[U_PLANET_ORIGIN + 1] = this.planetOrigin.y;
        f32[U_PLANET_ORIGIN + 2] = this.planetOrigin.z;
        f32[U_PLANET_RADIUS]     = this.planetRadius;

        // ── View-projection matrix (offset 8–23) ────────────────────────
        // Reserved for iteration 6 (frustum culling).
        // Pack it now so the uniform struct is stable.
        if (camera.matrixWorldInverse && camera.projectionMatrix) {
            // VP = projection × view
            const v = camera.matrixWorldInverse.elements;
            const p = camera.projectionMatrix.elements;
            // Manual 4×4 multiply (column-major)
            for (let c = 0; c < 4; c++) {
                for (let r = 0; r < 4; r++) {
                    let sum = 0;
                    for (let k = 0; k < 4; k++) {
                        sum += p[r + k * 4] * v[k + c * 4];
                    }
                    f32[U_VIEW_PROJ + c * 4 + r] = sum;
                }
            }
        } else {
            // Identity fallback
            for (let i = 0; i < 16; i++) f32[U_VIEW_PROJ + i] = 0;
            f32[U_VIEW_PROJ]      = 1;
            f32[U_VIEW_PROJ + 5]  = 1;
            f32[U_VIEW_PROJ + 10] = 1;
            f32[U_VIEW_PROJ + 15] = 1;
        }

        // ── Traversal parameters (offset 24–31) ─────────────────────────
        f32[U_FACE_SIZE]     = this.faceSize;
        u32[U_MAX_DEPTH]     = this.maxDepth;
        f32[U_SCREEN_HEIGHT] = this.screenHeight;
        f32[U_TAN_HALF_FOV]  = this.tanHalfFov;
        f32[U_LOD_FACTOR]    = this.lodFactor;
        f32[U_LOD_THRESHOLD] = this.lodErrorThreshold;
        u32[U_MAX_VIS_TILES] = this.maxVisibleTiles;
        u32[U_QUEUE_CAPACITY]= this.queueCapacity;
        u32[U_MAX_GEOM_LOD]  = this.maxGeomLOD;
        u32[U_VISIBLE_TABLE_MASK] = this.visibleTableMask;
        u32[U_VISIBLE_TABLE_CAP]  = this.visibleTableCapacity;
        u32[U_LOADED_TABLE_MASK]  = this.loadedTableMask;
        u32[U_LOADED_TABLE_CAP]   = this.loadedTableCapacity;
        u32[U_MAX_FEEDBACK]  = this.maxFeedback;
        u32[U_USE_FRUSTUM]   = this.enableFrustumCulling ? 1 : 0;
        u32[U_USE_HORIZON]   = this.enableHorizonCulling ? 1 : 0;
        f32[U_MAX_HEIGHT_DISP] = this.maxHeightDisplacement;
        f32[U_HORIZON_GROUND_COS] = this.horizonGroundCos;
        f32[U_HORIZON_BLEND_SCALE] = this.horizonBlendScale;

        // Epoch-based visible table management
        this._framesSinceClear++;
        let doVisibleClear = 0;
        if (this._framesSinceClear >= this._visibleClearInterval) {
            this._framesSinceClear = 0;
            this._visibleEpoch = 0;
            doVisibleClear = 1;
        }
        this._visibleEpoch++;
        u32[U_CURRENT_EPOCH] = this._visibleEpoch;
        u32[U_DO_VISIBLE_CLEAR] = doVisibleClear;

        // Upload
        this.device.queue.writeBuffer(this._uniformBuffer, 0, this._uniformData);
        if (this._frameCount % 120 === 0) {
            const camPos = camera.position;
            const origin = this.planetOrigin;
            const dx = camPos.x - origin.x;
            const dy = camPos.y - origin.y;
            const dz = camPos.z - origin.z;
            const altitude = Math.sqrt(dx*dx + dy*dy + dz*dz) - this.planetRadius;
            
            Logger.info(
                `[QT-Uniforms] altitude=${altitude.toFixed(1)}m ` +
                `lodFactor=${this.lodFactor.toFixed(1)} ` +
                `lodThreshold=${this.lodErrorThreshold} ` +
                `frustumCull=${this.enableFrustumCulling} ` +
                `horizonCull=${this.enableHorizonCulling}`
            );
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Traversal dispatch
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Dispatch the quadtree traversal compute shader.
     * Must be called after updateUniforms().
     *
     * @param {GPUCommandEncoder} commandEncoder  The frame's command encoder.
     *        If null, a standalone encoder is created and submitted.
     */
    traverse(commandEncoder) {
        if (!this._initialized) return;

        const standalone = !commandEncoder;
        if (standalone) {
            commandEncoder = this.device.createCommandEncoder({
                label: 'QuadtreeGPU-Traversal'
            });
        }

        const pass = commandEncoder.beginComputePass({
            label: 'QuadtreeTraversal'
        });

        pass.setPipeline(this._pipeline);
        pass.setBindGroup(0, this._bindGroup);
        // Single workgroup dispatch — the shader handles all 6 faces internally
        pass.dispatchWorkgroups(1);
        pass.end();
        if (this._frameCount % 120 === 0) { // Every 2 seconds at 60fps
            this.readVisibleTileCount().then(count => {
                Logger.info(
                    `[QT-Traverse] Frame ${this._frameCount}: ` +
                    `visibleCount=${count} maxDepth=${this.maxDepth} ` +
                    `lodFactor=${this.lodFactor.toFixed(1)} ` +
                    `lodThreshold=${this.lodErrorThreshold}`
                );
            });
        }

        if (standalone) {
            this.device.queue.submit([commandEncoder.finish()]);
        }

        this._stats.totalTraversals++;
        this._frameCount++;
    }
// QuadtreeGPU.js
_logTraversalSeeds(seeds, tag = "QT-Seeds") {
    // seeds: array of {face, depth, x, y} or whatever your node key is
    const n = seeds?.length ?? 0;
    Logger.info(`[${tag}] count=${n}`);
    if (!n) return;
  
    const byFace = new Map();
    for (const s of seeds) {
      const f = s.face ?? 0;
      if (!byFace.has(f)) byFace.set(f, []);
      byFace.get(f).push(s);
    }
  
    for (const [face, arr] of byFace) {
      let minD=1e9, maxD=-1, minX=1e9, maxX=-1, minY=1e9, maxY=-1;
      for (const s of arr) {
        minD = Math.min(minD, s.depth);
        maxD = Math.max(maxD, s.depth);
        minX = Math.min(minX, s.x);
        maxX = Math.max(maxX, s.x);
        minY = Math.min(minY, s.y);
        maxY = Math.max(maxY, s.y);
      }
      Logger.info(
        `[${tag}] face=${face} seeds=${arr.length} depth=[${minD}..${maxD}] x=[${minX}..${maxX}] y=[${minY}..${maxY}]`
      );
      for (let i = 0; i < Math.min(8, arr.length); i++) {
        const s = arr[i];
        Logger.info(`  [${tag}]  sample${i}: f${s.face} d${s.depth} (${s.x},${s.y})`);
      }
    }
  }
  
    /**
     * Dispatch the instance buffer builder compute shader.
     * Requires traverse() to have run first in the same command encoder.
     *
     * @param {GPUCommandEncoder} commandEncoder
     */
    buildInstances(commandEncoder) {
        //Logger.warn('[QT-DIAG] buildInstances dispatch');
        if (!this._initialized) return;
        if (!commandEncoder) {
            throw new Error('QuadtreeGPU.buildInstances requires a command encoder');
        }

        const pass = commandEncoder.beginComputePass({
            label: 'QuadtreeInstanceBuilder'
        });
        pass.setPipeline(this._instancePipeline);
        pass.setBindGroup(0, this._instanceBindGroup);
        pass.dispatchWorkgroups(1);
        pass.end();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Result readback (async — for debugging / feedback)
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Read the visible tile count from the GPU.
     * Creates a staging buffer on first call.
     *
     * @returns {Promise<number>} Number of visible tiles from the last traversal
     */
    async readVisibleTileCount() {
        if (!this._initialized) return 0;

        return this._withDebugReadbackLock(async () => {
            this._ensureCounterStagingBuffer();

            const encoder = this.device.createCommandEncoder({ label: 'QT-ReadCounters' });
            encoder.copyBufferToBuffer(
                this._counterBuffer, 0,
                this._counterStagingBuffer, 0,
                COUNTER_BYTES
            );
            this.device.queue.submit([encoder.finish()]);

            await this._counterStagingBuffer.mapAsync(GPUMapMode.READ);
            const data = new Uint32Array(this._counterStagingBuffer.getMappedRange());
            const count = data[2]; // counter[2] = visible tile count
            this._counterStagingBuffer.unmap();

            this._lastVisibleCount = count;
            this._stats.lastVisibleTiles = count;

            return count;
        });
    }

    /**
     * Read all traversal counters (queueA, queueB, visible, reserved).
     * Uses a dedicated staging buffer so it can be called alongside other readbacks.
     *
     * @returns {Promise<{queueA:number, queueB:number, visible:number, reserved:number} | null>}
     */
    async readTraversalCounters() {
        return this._withDebugReadbackLock(async () => {
            if (!this._initialized) return null;

            const staging = this.device.createBuffer({
                label: 'QT-CounterDebugStaging',
                size:  COUNTER_BYTES,
                usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
            });

            const encoder = this.device.createCommandEncoder({ label: 'QT-ReadCountersAll' });
            encoder.copyBufferToBuffer(
                this._counterBuffer, 0,
                staging, 0,
                COUNTER_BYTES
            );
            this.device.queue.submit([encoder.finish()]);

            await staging.mapAsync(GPUMapMode.READ);
            const data = new Uint32Array(staging.getMappedRange());
            const result = {
                queueA: data[0],
                queueB: data[1],
                visible: data[2],
                reserved: data[3]
            };
            staging.unmap();
            staging.destroy();

            return result;
        });
    }

    /**
     * Debug: Read the first N seeded queue entries captured on the GPU.
     * @param {number} [maxEntries=DEBUG_SEED_COUNT]
     * @returns {Promise<Array<{face:number, depth:number, x:number, y:number}>>}
     */
    async debugReadTraversalSeeds(maxEntries = DEBUG_SEED_COUNT) {
        return this._withDebugReadbackLock(async () => {
            if (!this._initialized || !this._debugSeedsBuffer) return [];

            const readCount = Math.min(DEBUG_SEED_COUNT, Math.max(0, maxEntries));
            if (readCount === 0) return [];

            const readBytes = readCount * TILE_NODE_BYTES;
            const staging = this.device.createBuffer({
                label: 'QT-DebugSeedsStage',
                size:  readBytes,
                usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
            });

            const encoder = this.device.createCommandEncoder({ label: 'QT-ReadDebugSeeds' });
            encoder.copyBufferToBuffer(this._debugSeedsBuffer, 0, staging, 0, readBytes);
            this.device.queue.submit([encoder.finish()]);

            await staging.mapAsync(GPUMapMode.READ, 0, readBytes);
            const data = new Uint32Array(staging.getMappedRange(0, readBytes));

            const seeds = [];
            for (let i = 0; i < readCount; i++) {
                const base = i * 4;
                const face = data[base];
                if (face === 0xFFFFFFFF) continue;
                seeds.push({
                    face,
                    depth: data[base + 1],
                    x:     data[base + 2],
                    y:     data[base + 3]
                });
            }

            staging.unmap();
            staging.destroy();
            return seeds;
        });
    }

    /**
     * Debug: Read traversal params as seen by the GPU.
     * @returns {Promise<{
     *  queueCapacity:number, maxVisibleTiles:number, maxDepth:number,
     *  useFrustum:boolean, useHorizon:boolean, disableCulling:boolean,
     *  faceSize:number, planetRadius:number, lodFactor:number, lodErrorThreshold:number,
     *  screenHeight:number, tanHalfFov:number
     * } | null>}
     */
    async debugReadTraversalParams() {
        return this._withDebugReadbackLock(async () => {
            if (!this._initialized || !this._debugParamsBuffer) return null;

            const staging = this.device.createBuffer({
                label: 'QT-DebugParamsStage',
                size:  DEBUG_PARAM_BYTES,
                usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
            });

            const encoder = this.device.createCommandEncoder({ label: 'QT-ReadDebugParams' });
            encoder.copyBufferToBuffer(this._debugParamsBuffer, 0, staging, 0, DEBUG_PARAM_BYTES);
            this.device.queue.submit([encoder.finish()]);

            await staging.mapAsync(GPUMapMode.READ, 0, DEBUG_PARAM_BYTES);
            const data = new Uint32Array(staging.getMappedRange(0, DEBUG_PARAM_BYTES));

            const u32ToF32 = (u) => {
                const buf = new ArrayBuffer(4);
                const view = new DataView(buf);
                view.setUint32(0, u, true);
                return view.getFloat32(0, true);
            };

            const flags = data[3];
            const result = {
                queueCapacity: data[0],
                maxVisibleTiles: data[1],
                maxDepth: data[2],
                useFrustum: (flags & 0x1) !== 0,
                useHorizon: (flags & 0x2) !== 0,
                disableCulling: (flags & 0x4) !== 0,
                faceSize: u32ToF32(data[4]),
                planetRadius: u32ToF32(data[5]),
                lodFactor: u32ToF32(data[6]),
                lodErrorThreshold: u32ToF32(data[7]),
                screenHeight: u32ToF32(data[8]),
                tanHalfFov: u32ToF32(data[9]),
                sample0Dist: u32ToF32(data[10]),
                sample0Err: u32ToF32(data[11]),
                sample1Dist: u32ToF32(data[12]),
                sample1Err: u32ToF32(data[13]),
                sample2Dist: u32ToF32(data[14]),
                sample2Err: u32ToF32(data[15]),
                camFace: data[16],
                camU: u32ToF32(data[17]),
                camV: u32ToF32(data[18]),
                camDist: u32ToF32(data[19]),
                camD3X: data[20],
                camD3Y: data[21],
                camD3Err: u32ToF32(data[22]),
                camD6Err: u32ToF32(data[23])
            };

            staging.unmap();
            staging.destroy();
            return result;
        });
    }

    /**
     * Debug: Read traversal queue overflow count.
     * @returns {Promise<number|null>}
     */
    async debugReadTraversalOverflow() {
        return this._withDebugReadbackLock(async () => {
            if (!this._initialized || !this._debugCountersBuffer) return null;

            const staging = this.device.createBuffer({
                label: 'QT-DebugCountersStage',
                size:  4,
                usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
            });

            const encoder = this.device.createCommandEncoder({ label: 'QT-ReadDebugCounters' });
            encoder.copyBufferToBuffer(this._debugCountersBuffer, 0, staging, 0, 4);
            this.device.queue.submit([encoder.finish()]);

            await staging.mapAsync(GPUMapMode.READ, 0, 4);
            const data = new Uint32Array(staging.getMappedRange(0, 4));
            const count = data[0];

            staging.unmap();
            staging.destroy();
            return count;
        });
    }

    /**
     * Debug: Read traversal debug counters (processed / culled / emitted / subdivided).
     * @returns {Promise<{
     *  queueOverflow:number,
     *  nodesProcessed:number,
     *  culledFrustum:number,
     *  culledHorizon:number,
     *  emitted:number,
     *  subdivided:number,
     *  visibleOverflow:number,
     *  enqueued:number
     * } | null>}
     */
    async debugReadTraversalDebugCounters() {
        return this._withDebugReadbackLock(async () => {
            if (!this._initialized || !this._debugCountersBuffer) return null;

            const staging = this.device.createBuffer({
                label: 'QT-DebugCountersAllStage',
                size:  DEBUG_COUNTER_BYTES,
                usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
            });

            const encoder = this.device.createCommandEncoder({ label: 'QT-ReadDebugCountersAll' });
            encoder.copyBufferToBuffer(this._debugCountersBuffer, 0, staging, 0, DEBUG_COUNTER_BYTES);
            this.device.queue.submit([encoder.finish()]);

            await staging.mapAsync(GPUMapMode.READ, 0, DEBUG_COUNTER_BYTES);
            const data = new Uint32Array(staging.getMappedRange(0, DEBUG_COUNTER_BYTES));

            const result = {
                queueOverflow: data[0] ?? 0,
                nodesProcessed: data[1] ?? 0,
                culledFrustum: data[2] ?? 0,
                culledHorizon: data[3] ?? 0,
                emitted: data[4] ?? 0,
                subdivided: data[5] ?? 0,
                visibleOverflow: data[6] ?? 0,
                enqueued: data[7] ?? 0
            };

            staging.unmap();
            staging.destroy();
            return result;
        });
    }

    /**
     * Read the full visible tile list from the GPU.
     *
     * @param {number} [maxTiles]  Limit readback (default: last known count or 256)
     * @returns {Promise<Array<{face, depth, x, y}>>}
     */
    async readVisibleTiles(maxTiles) {
        if (!this._initialized) return [];

        // First get the count
        const count = await this.readVisibleTileCount();
        if (count === 0) return [];

        const readCount = Math.min(count, maxTiles ?? count, this.maxVisibleTiles);
        const readBytes = readCount * TILE_NODE_BYTES;

        this._ensureTileStagingBuffer(readBytes);

        const encoder = this.device.createCommandEncoder({ label: 'QT-ReadTiles' });
        encoder.copyBufferToBuffer(
            this._visibleTileBuffer, 0,
            this._tileStagingBuffer, 0,
            readBytes
        );
        this.device.queue.submit([encoder.finish()]);

        await this._tileStagingBuffer.mapAsync(GPUMapMode.READ);
        const data = new Uint32Array(this._tileStagingBuffer.getMappedRange(0, readBytes));

        const tiles = [];
        for (let i = 0; i < readCount; i++) {
            const base = i * 4;
            tiles.push({
                face:  data[base],
                depth: data[base + 1],
                x:     data[base + 2],
                y:     data[base + 3]
            });
        }

        this._tileStagingBuffer.unmap();
        return tiles;
    }

    async readResults() {
        const tiles = await this.readVisibleTiles();
        const count = tiles.length;
    
        // Build depth histogram
        const depthHist = {};
        const faceHist = {};
        for (const t of tiles) {
            depthHist[t.depth] = (depthHist[t.depth] || 0) + 1;
            faceHist[t.face]   = (faceHist[t.face]   || 0) + 1;
        }
    
        // Update rolling average
        const alpha = 0.1;
        this._stats.avgVisibleTiles =
            this._stats.avgVisibleTiles * (1 - alpha) + count * alpha;
    
        return { count, tiles, depthHistogram: depthHist, faceHistogram: faceHist };
    }

    /**
     * Debug: Read instance buffer data and log tile sizes.
     * Call this after buildInstances() to inspect what the GPU computed.
     *
     * @param {number} [maxInstances=20] How many instances to read
     * @returns {Promise<Array>} Instance data for debugging
     */
    async debugReadInstances(maxInstances = 20) {
        if (!this._initialized || !this._instanceBuffer) return [];
        if (this._debugReadPending) return [];
        this._debugReadPending = true;

        let count;
        try {
            count = await this.readVisibleTileCount();
        } catch (e) {
            this._debugReadPending = false;
            return [];
        }
        if (count === 0) {
            this._debugReadPending = false;
            return [];
        }

        const readCount = Math.min(count, maxInstances, this.maxVisibleTiles);
        // ChunkInstance struct is 64 bytes (16 floats)
        const INSTANCE_BYTES = 64;
        const readBytes = readCount * INSTANCE_BYTES;

        // Create staging buffer if needed
        if (!this._instanceStagingBuffer || this._instanceStagingBuffer.size < readBytes) {
            if (this._instanceStagingBuffer) this._instanceStagingBuffer.destroy();
            this._instanceStagingBuffer = this.device.createBuffer({
                label: 'QT-InstanceStaging',
                size: Math.max(readBytes, 4096),
                usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
            });
        }

        const encoder = this.device.createCommandEncoder({ label: 'QT-ReadInstances' });
        encoder.copyBufferToBuffer(
            this._instanceBuffer, 0,
            this._instanceStagingBuffer, 0,
            readBytes
        );
        this.device.queue.submit([encoder.finish()]);

        await this._instanceStagingBuffer.mapAsync(GPUMapMode.READ);
        const data = new Float32Array(this._instanceStagingBuffer.getMappedRange(0, readBytes));
        const u32View = new Uint32Array(data.buffer, data.byteOffset, data.length);

        const instances = [];
        for (let i = 0; i < readCount; i++) {
            const base = i * 16; // 16 floats per instance
            // ChunkInstance layout:
            // position: vec3<f32> (0-2), face: u32 (3)
            // chunkLocation: vec2<f32> (4-5), chunkSizeUV: f32 (6), _pad: f32 (7)
            // uvOffset: vec2<f32> (8-9), uvScale: f32 (10), lod: u32 (11)
            // neighborLODs: vec2<u32> (12-13), layer: u32 (14), edgeMask: u32 (15)
            instances.push({
                position: { x: data[base], y: data[base + 1], z: data[base + 2] },
                face: u32View[base + 3],
                chunkLocation: { x: data[base + 4], y: data[base + 5] },
                chunkSizeUV: data[base + 6],
                uvOffset: { x: data[base + 8], y: data[base + 9] },
                uvScale: data[base + 10],
                lod: u32View[base + 11],
                neighborPacked: u32View[base + 12],
                layer: u32View[base + 14]
            });
        }

        this._instanceStagingBuffer.unmap();

        // Log summary grouped by chunkSizeUV
        const sizeGroups = {};
        for (const inst of instances) {
            const sizeKey = inst.chunkSizeUV.toFixed(6);
            if (!sizeGroups[sizeKey]) {
                sizeGroups[sizeKey] = { count: 0, depth: Math.round(Math.log2(1 / inst.chunkSizeUV)) };
            }
            sizeGroups[sizeKey].count++;
        }

        Logger.info(`[QT-InstanceDebug] Read ${readCount} instances:`);
        for (const [size, info] of Object.entries(sizeGroups).sort((a, b) => parseFloat(b[0]) - parseFloat(a[0]))) {
            Logger.info(`  chunkSizeUV=${size} (depth≈${info.depth}): ${info.count} instances`);
        }

        // Log first few instances in detail
        Logger.info('[QT-InstanceDebug] Sample instances:');
        for (let i = 0; i < Math.min(5, instances.length); i++) {
            const inst = instances[i];
            Logger.info(
                `  [${i}] face=${inst.face} loc=(${inst.chunkLocation.x.toFixed(4)},${inst.chunkLocation.y.toFixed(4)}) ` +
                `sizeUV=${inst.chunkSizeUV.toFixed(6)} lod=${inst.lod} layer=${inst.layer} ` +
                `uvOffset=(${inst.uvOffset.x.toFixed(3)},${inst.uvOffset.y.toFixed(3)}) uvScale=${inst.uvScale.toFixed(3)}`
            );
        }

        this._debugReadPending = false;
        return instances;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Per-frame tick (logging)
    // ═══════════════════════════════════════════════════════════════════════

    tick() {
        if (!this._initialized) return;
        if (!this._logStatsEnabled) return;
        if (this._frameCount % this._logInterval === 0 && this._frameCount > 0) {
            this._logStats();
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Stats
    // ═══════════════════════════════════════════════════════════════════════

    getStats() {
        return {
            ...this._stats,
            maxDepth:         this.maxDepth,
            maxVisibleTiles:  this.maxVisibleTiles,
            queueCapacity:    this.queueCapacity,
            lodErrorThreshold: this.lodErrorThreshold,
            maxGeomLOD:       this.maxGeomLOD,
            visibleTableCapacity: this.visibleTableCapacity,
            loadedTableCapacity: this.loadedTableCapacity,
            maxFeedback:      this.maxFeedback
        };
    }

    /**
     * Upload per-LOD index counts used by the instance builder to fill indirect args.
     * @param {number[]} counts
     */
    updateLodIndexCounts(counts = []) {
        if (!this._initialized || !this._lodIndexBuffer) return;
        const data = new Uint32Array(this.lodLevels);
        for (let i = 0; i < this.lodLevels; i++) {
            const v = counts[i];
            data[i] = Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
        }
        this.device.queue.writeBuffer(this._lodIndexBuffer, 0, data);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Accessors for downstream consumers (instance buffer writer, etc.)
    // ═══════════════════════════════════════════════════════════════════════

    /** The output visible tile buffer (storage, read-only for subsequent passes) */
    getVisibleTileBuffer() { return this._visibleTileBuffer; }

    /** The counter buffer (storage, counter[2] = visible count) */
    getCounterBuffer() { return this._counterBuffer; }

    /** The uniform buffer (for sharing camera data with other passes) */
    getUniformBuffer() { return this._uniformBuffer; }

    /** Last known visible tile count (may be stale — see readVisibleTileCount) */
    getLastVisibleCount() { return this._lastVisibleCount; }

    /** Instance buffer (combined LODs) */
    getInstanceBuffer() { return this._instanceBuffer; }

    /** Indirect args buffer (5 u32 per LOD) */
    getIndirectArgsBuffer() { return this._metaBuffer; }

    /** Byte offset of indirect args for a given LOD */
    getIndirectArgsOffsetBytes(lod) {
        const l = Math.max(0, Math.min(lod | 0, this.lodLevels - 1));
        return (this.lodLevels * 3 + l * 5) * 4;
    }

    /** Offset (bytes) of feedbackCount in the meta buffer */
    getMetaFeedbackOffsetBytes() { return this._metaFeedbackOffsetBytes; }

    /** Feedback buffer (missing tiles) */
    getFeedbackBuffer() { return this._feedbackBuffer; }

    /** Loaded tile table buffer (CPU-updated) */
    getLoadedTileTableBuffer() { return this._loadedTableBuffer; }

    /** Loaded tile table capacity (entries) */
    getLoadedTileTableCapacity() { return this.loadedTableCapacity; }

    /** Visible tile table capacity (entries) */
    getVisibleTileTableCapacity() { return this.visibleTableCapacity; }

    // ═══════════════════════════════════════════════════════════════════════
    // Internal: buffer creation
    // ═══════════════════════════════════════════════════════════════════════

    _createBuffers() {
        let totalBytes = 0;

        // Uniform buffer (256 bytes, padded)
        this._uniformBuffer = this.device.createBuffer({
            label: 'QT-Uniforms',
            size:  UNIFORM_BYTES,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });
        totalBytes += UNIFORM_BYTES;

        // Work queues (ping-pong)
        const queueBytes = this.queueCapacity * TILE_NODE_BYTES;
        this._queueBufferA = this.device.createBuffer({
            label: 'QT-QueueA',
            size:  queueBytes,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC 
        });
        this._queueBufferB = this.device.createBuffer({
            label: 'QT-QueueB',
            size:  queueBytes,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
        });
        totalBytes += queueBytes * 2;

        // Visible tile output
        const visibleBytes = this.maxVisibleTiles * TILE_NODE_BYTES;
        this._visibleTileBuffer = this.device.createBuffer({
            label: 'QT-VisibleTiles',
            size:  visibleBytes,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
        });
        totalBytes += visibleBytes;

        // Atomic counters
        this._counterBuffer = this.device.createBuffer({
            label: 'QT-Counters',
            size:  COUNTER_BYTES,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
        });
        totalBytes += COUNTER_BYTES;

        // Debug seed buffer (first N queue entries after seeding)
        const debugSeedBytes = DEBUG_SEED_COUNT * TILE_NODE_BYTES;
        this._debugSeedsBuffer = this.device.createBuffer({
            label: 'QT-DebugSeeds',
            size:  debugSeedBytes,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        });
        totalBytes += debugSeedBytes;

        // Debug params buffer (GPU-visible traversal params)
        this._debugParamsBuffer = this.device.createBuffer({
            label: 'QT-DebugParams',
            size:  DEBUG_PARAM_BYTES,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        });
        totalBytes += DEBUG_PARAM_BYTES;

        // Debug counters buffer (overflow + traversal stats)
        this._debugCountersBuffer = this.device.createBuffer({
            label: 'QT-DebugCounters',
            size:  DEBUG_COUNTER_BYTES,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        });
        totalBytes += DEBUG_COUNTER_BYTES;

        // Visible tile hash table (per-frame)
   const visibleTableBytes = this.visibleTableCapacity * 16;
        this._visibleTableBuffer = this.device.createBuffer({
            label: 'QT-VisibleTable',
            size:  visibleTableBytes,
            usage: GPUBufferUsage.STORAGE
        });
        totalBytes += visibleTableBytes;

        // Loaded tile hash table (persistent, updated by CPU)
        const loadedTableBytes = this.loadedTableCapacity * 16;
        this._loadedTableBuffer = this.device.createBuffer({
            label: 'QT-LoadedTable',
            size:  loadedTableBytes,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
        });
        
        const empty = new Uint32Array(loadedTableBytes / 4);
        empty.fill(0xFFFFFFFF);
        this.device.queue.writeBuffer(this._loadedTableBuffer, 0, empty);

        totalBytes += loadedTableBytes;



        // Instance buffer (all LODs combined)
        const instanceBytes = this.maxVisibleTiles * 64;
        this._instanceBuffer = this.device.createBuffer({
            label: 'QT-InstanceBuffer',
            size:  instanceBytes,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
        });
        totalBytes += instanceBytes;

        // Meta buffer (counts + offsets + indirect args + feedback count + diagnostics)
        const metaU32Count = (this.lodLevels * 8) + 5;
        const metaBytes = Math.ceil((metaU32Count * 4) / 256) * 256;
        this._metaFeedbackOffsetBytes = this.lodLevels * 8 * 4;
        this._metaBuffer = this.device.createBuffer({
            label: 'QT-Meta',
            size:  metaBytes,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.INDIRECT
        });
        totalBytes += metaBytes;

        // Feedback buffer (missing tiles)
        const feedbackBytes = this.maxFeedback * TILE_NODE_BYTES;
        this._feedbackBuffer = this.device.createBuffer({
            label: 'QT-Feedback',
            size:  feedbackBytes,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        });
        totalBytes += feedbackBytes;

        // Per-LOD index counts (uploaded by CPU)
        const lodIndexBytes = this.lodLevels * 4;
        this._lodIndexBuffer = this.device.createBuffer({
            label: 'QT-LODIndexCounts',
            size:  lodIndexBytes,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
        });
        totalBytes += lodIndexBytes;

        this._stats.gpuMemoryBytes = totalBytes;

        Logger.info(
            `[QuadtreeGPU] Buffers created: ` +
            `uniform=${UNIFORM_BYTES}B, ` +
            `queues=2×${queueBytes}B, ` +
            `visible=${visibleBytes}B, ` +
            `counters=${COUNTER_BYTES}B, ` +
            `debugSeeds=${debugSeedBytes}B, ` +
            `debugParams=${DEBUG_PARAM_BYTES}B, ` +
            `debugCounters=${DEBUG_COUNTER_BYTES}B, ` +
            `visibleTable=${visibleTableBytes}B, ` +
            `loadedTable=${loadedTableBytes}B, ` +
            `instances=${instanceBytes}B, ` +
            `meta=${metaBytes}B, ` +
            `feedback=${feedbackBytes}B, ` +
            `lodIndex=${lodIndexBytes}B, ` +
            `total=${(totalBytes / 1024).toFixed(0)}KB`
        );
    }
// QuadtreeGPU.js

// QuadtreeGPU.js
async debugReadInstancesRange(firstInstance, instanceCount, maxToRead = 8) {
    return this._withDebugReadbackLock(async () => {
      if (!this._initialized || !this._instanceBuffer) return [];
  
      const readCount = Math.min(instanceCount, maxToRead);
      if (readCount <= 0) return [];
  
      const INSTANCE_BYTES = 64;
      const srcOffsetBytes = firstInstance * INSTANCE_BYTES;
      const readBytes = readCount * INSTANCE_BYTES;
  
      this._ensureInstanceStagePool(readBytes);
      const staging = this._nextStageBuffer();
  
      const encoder = this.device.createCommandEncoder({ label: 'QT-ReadInstancesRange' });
      encoder.copyBufferToBuffer(this._instanceBuffer, srcOffsetBytes, staging, 0, readBytes);
      this.device.queue.submit([encoder.finish()]);
  
      await staging.mapAsync(GPUMapMode.READ, 0, readBytes);
      const mapped = staging.getMappedRange(0, readBytes);
  
      const f32 = new Float32Array(mapped);
      const u32 = new Uint32Array(mapped);
  
      const out = [];
      for (let i = 0; i < readCount; i++) {
        const base = i * 16;
        const packed = u32[base + 12] >>> 0;
        const left = packed & 0xF;
        const right = (packed >>> 4) & 0xF;
        const bottom = (packed >>> 8) & 0xF;
        const top = (packed >>> 12) & 0xF;
        out.push({
          face: u32[base + 3],
          chunkLocation: { x: f32[base + 4], y: f32[base + 5] },
          chunkSizeUV: f32[base + 6],
          uvOffset: { x: f32[base + 8], y: f32[base + 9] },
          uvScale: f32[base + 10],
          lod: u32[base + 11],
          neighborLODs: { left, right, bottom, top },
          layer: u32[base + 14],
          edgeMask: u32[base + 15],
        });
      }
  
      staging.unmap();
      return out;
    });
  }
  
  
// QuadtreeGPU.js
async debugReadMetaRaw(maxLODLevels) {
    return this._withDebugReadbackLock(async () => {
      if (!this._initialized || !this._metaBuffer) return null;
  
      const u32Count = maxLODLevels * 8 + 5;
      const byteSize = Math.ceil((u32Count * 4) / 256) * 256;
  
      const staging = this.device.createBuffer({
        label: 'QT-MetaRawStage',
        size: byteSize,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });
  
      const encoder = this.device.createCommandEncoder({ label: 'QT-ReadMetaRaw' });
      encoder.copyBufferToBuffer(this._metaBuffer, 0, staging, 0, byteSize);
      this.device.queue.submit([encoder.finish()]);
  
      await staging.mapAsync(GPUMapMode.READ, 0, u32Count * 4);
      const data = new Uint32Array(staging.getMappedRange(0, u32Count * 4));
      const copy = new Uint32Array(data);
      staging.unmap();
      staging.destroy();
      return copy;
    });
  }
  
  
    // ═══════════════════════════════════════════════════════════════════════
    // Internal: pipeline creation
    // ═══════════════════════════════════════════════════════════════════════

    _createPipeline() {
        const shaderSource = buildTraversalShaderSource({
            workgroupSize: this.workgroupSize,
            disableCulling: !this.enableFrustumCulling && !this.enableHorizonCulling
        });
// ---- QT traversal variant probe (prints once) ----
if (!this._loggedTraversalVariant) {
    this._loggedTraversalVariant = true;
  
    const hasLeafOnly = shaderSource.includes("wantSubdivide") || shaderSource.includes("allChildrenLoaded");
    const hasEmitAlways = shaderSource.includes("Emit this tile") || shaderSource.includes("visibleTiles[visIdx] = tile");
  
    Logger.info(
      `[QT] Traversal shader variant: ` +
      `${hasLeafOnly ? "LEAF_ONLY-ish" : "NO_LEAF_ONLY"} | ` +
      `${hasEmitAlways ? "EMIT_ALWAYS-ish" : "NO_EMIT_ALWAYS"}`
    );
  }
  
        const shaderModule = this.device.createShaderModule({
            label: 'QT-TraversalShader',
            code:  shaderSource
        });

        // Bind group layout: 1 uniform + 7 storage (read_write) + 1 read-only (loadedTable)
        this._bindGroupLayout = this.device.createBindGroupLayout({
            label: 'QT-TraversalLayout',
            entries: [
                {
                    binding:    0,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer:     { type: 'uniform' }
                },
                {
                    binding:    1,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer:     { type: 'storage' }
                },
                {
                    binding:    2,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer:     { type: 'storage' }
                },
                {
                    binding:    3,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer:     { type: 'storage' }
                },
                {
                    binding:    4,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer:     { type: 'storage' }
                },
                {
                    binding:    5,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer:     { type: 'read-only-storage' }
                },
                {
                    binding:    6,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer:     { type: 'storage' }
                },
                {
                    binding:    7,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer:     { type: 'storage' }
                },
                {
                    binding:    8,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer:     { type: 'storage' }
                }
            ]
        });

        const pipelineLayout = this.device.createPipelineLayout({
            label:            'QT-TraversalPipelineLayout',
            bindGroupLayouts: [this._bindGroupLayout]
        });

        this._pipeline = this.device.createComputePipeline({
            label:   'QT-TraversalPipeline',
            layout:  pipelineLayout,
            compute: {
                module:     shaderModule,
                entryPoint: 'main'
            }
        });

        Logger.info('[QuadtreeGPU] Traversal pipeline created');
    }

    _createInstancePipeline() {
        const shaderSource = buildInstanceBuilderShaderSource({
            workgroupSize: this.workgroupSize,
            maxGeomLOD: this.maxGeomLOD
        });

        const shaderModule = this.device.createShaderModule({
            label: 'QT-InstanceBuilderShader',
            code:  shaderSource
        });

        this._instanceBindGroupLayout = this.device.createBindGroupLayout({
            label: 'QT-InstanceBuilderLayout',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } }
            ]
        });

        const pipelineLayout = this.device.createPipelineLayout({
            label:            'QT-InstanceBuilderPipelineLayout',
            bindGroupLayouts: [this._instanceBindGroupLayout]
        });

        this._instancePipeline = this.device.createComputePipeline({
            label:   'QT-InstanceBuilderPipeline',
            layout:  pipelineLayout,
            compute: {
                module:     shaderModule,
                entryPoint: 'main'
            }
        });

        Logger.info('[QuadtreeGPU] Instance builder pipeline created');
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Internal: bind group creation
    // ═══════════════════════════════════════════════════════════════════════

    _createBindGroup() {
        this._bindGroup = this.device.createBindGroup({
            label:  'QT-TraversalBindGroup',
            layout: this._bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this._uniformBuffer } },
                { binding: 1, resource: { buffer: this._queueBufferA } },
                { binding: 2, resource: { buffer: this._queueBufferB } },
                { binding: 3, resource: { buffer: this._visibleTileBuffer } },
                { binding: 4, resource: { buffer: this._counterBuffer } },
                { binding: 5, resource: { buffer: this._loadedTableBuffer } },
                { binding: 6, resource: { buffer: this._debugSeedsBuffer } },
                { binding: 7, resource: { buffer: this._debugParamsBuffer } },
                { binding: 8, resource: { buffer: this._debugCountersBuffer } }
            ]
        });
    }

    _createInstanceBindGroup() {
        this._instanceBindGroup = this.device.createBindGroup({
            label:  'QT-InstanceBuilderBindGroup',
            layout: this._instanceBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this._uniformBuffer } },
                { binding: 1, resource: { buffer: this._visibleTileBuffer } },
                { binding: 2, resource: { buffer: this._counterBuffer } },
                { binding: 3, resource: { buffer: this._visibleTableBuffer } },
                { binding: 4, resource: { buffer: this._loadedTableBuffer } },
                { binding: 5, resource: { buffer: this._instanceBuffer } },
                { binding: 6, resource: { buffer: this._metaBuffer } },
                { binding: 7, resource: { buffer: this._feedbackBuffer } },
                { binding: 8, resource: { buffer: this._lodIndexBuffer } }
            ]
        });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Internal: staging buffers (lazy creation)
    // ═══════════════════════════════════════════════════════════════════════

    _ensureCounterStagingBuffer() {
        if (this._counterStagingBuffer) return;
        this._counterStagingBuffer = this.device.createBuffer({
            label: 'QT-CounterStaging',
            size:  COUNTER_BYTES,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        });
    }

    _ensureTileStagingBuffer(minBytes) {
        if (this._tileStagingBuffer && this._tileStagingBuffer.size >= minBytes) return;

        if (this._tileStagingBuffer) {
            this._tileStagingBuffer.destroy();
        }

        // Round up to avoid frequent re-creation
        const size = Math.max(minBytes, 4096);
        this._tileStagingBuffer = this.device.createBuffer({
            label: 'QT-TileStaging',
            size:  size,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Internal: logging
    // ═══════════════════════════════════════════════════════════════════════

    _logStats() {
        const s = this._stats;
        const memKB = (s.gpuMemoryBytes / 1024).toFixed(0);
        Logger.info(
            `[QuadtreeGPU] traversals=${s.totalTraversals} | ` +
            `lastVisible=${s.lastVisibleTiles} | ` +
            `avgVisible=${s.avgVisibleTiles.toFixed(0)} | ` +
            `maxDepth=${this.maxDepth} | ` +
            `gpuMem=${memKB}KB`
        );
    }
}
