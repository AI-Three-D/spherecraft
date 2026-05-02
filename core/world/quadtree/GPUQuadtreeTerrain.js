// js/world/quadtree/GPUQuadtreeTerrain.js
//
// Manages GPU-driven quadtree traversal + tile streaming.
// Pure data/selection concern: decides which tiles are visible and
// streams their data into GPU tile pools.
//
// Rendering is handled by renderer/terrain/QuadtreeTerrainRenderer.

import { QuadtreeGPU } from './QuadtreeGPU.js';
import { TileStreamer } from './tileStreamer.js';
import { TileAddress } from './tileAddress.js';
import { TerrainGeometryBuilder } from '../../renderer/terrain/geometry/terrainGeometryBuilder.js';
import { Logger } from '../../../shared/Logger.js';
import { installQuadtreeTileManagerDiagnostics } from './gpuQuadtreeTerrainDiagnostics.js';

const TERRAIN_MANUAL_TAG = '[QTManual]';


// GPUQuadtreeTerrain.js



export class QuadtreeTileManager {
    constructor(options = {}) {
        this._prevCameraPos = null;
        this._prevFrameTime = 0;
        this._lodSpeedScale = 1.0;
        this._lodSpeedScaleTarget = 1.0;
        this._adaptiveLodConfig = null;
        this.backend = options.backend || null;
        this.device = this.backend?.device || null;
        this.engineConfig = options.engineConfig || null;
        this.planetConfig = options.planetConfig || null;
        this.terrainGenerator = options.terrainGenerator || null;
        this.textureManager = options.textureManager || null;
        this._initialized = false;
        this._maxGeomLOD = 14;

        this.quadtreeGPU = null;
        this.tileStreamer = null;

        this._visibleReadbackFrame = 0;
        this._visibleReadbackPending = false;
        this._diagFrame = 0;
        this._diagInterval = 0;         // set from config in initialize()
        this._diagReadInstances = true; // enable instance sampling
        this._lastVisibleTiles = null;
        this._stitchDiagFrame = 0;
        this._stitchDiagPending = false;
        this._diagLodSegments = [128, 64, 32, 16, 8, 4, 2];
        this._seamDiagTick = 0;
        this._seamDiagSeen = new Map();
        this._deepSeamDiagTick = 0;
        this._lastDeepSeamKey = '';
        this._lightDiagFrame = 0;
        this._manualDiagId = 0;
        this._manualDiagState = {
            status: 'idle',
            requested: false,
            frozen: false,
            running: false,
            completed: false,
            reason: '',
            snapshotId: 0,
            requestedAt: 0,
            startedAt: 0,
            finishedAt: 0,
            durationMs: 0,
            lastSummary: null,
            error: ''
        };
        this._manualDiagRunPending = false;

        // ── Debug profiling state ────────────────────────────────────
        this._profileFrame = 0;
        this._profileFrozen = false;
        this._profileFpsAccum = 0;
        this._profileFpsSamples = 0;
        this._profileLastTime = 0;
        this._profileLogInterval = 60; // log FPS every 60 frames

        // ── Predictive streaming state ───────────────────────────────
        // Raw velocity is written by _updateAdaptiveLodScale and read here.
        this._rawCamVelocity = null;
        this._lodVisibleScale = 1.0;
        // EMA-smoothed velocity (world units / second).
        this._predictState = { smoothVelX: 0, smoothVelY: 0, smoothVelZ: 0 };
    }

    async initialize() {
        if (this._initialized) return;
        if (!this.device || !this.backend) {
            throw new Error('QuadtreeTileManager requires a WebGPU backend');
        }
        if (!this.engineConfig?.gpuQuadtree) {
            throw new Error('QuadtreeTileManager requires engineConfig.gpuQuadtree');
        }
        if (!this.planetConfig) {
            throw new Error('QuadtreeTileManager requires planetConfig');
        }


        const qt = this.engineConfig.gpuQuadtree;
        const al = qt.adaptiveLod || {};
        this._adaptiveLodConfig = {
            enabled: al.enabled !== false,
            // no adaptation below this speed
            speedFloorMps: al.speedFloorMps ?? 150,
            // each +speedRefMps over the floor adds +1.0 to the scale
            speedRefMps: al.speedRefMps ?? 600,
            maxScale: al.maxScale ?? 3.0,
            // Keep visible traversal stable by default. Scaling the traversal
            // threshold with speed makes fine/coarse leaves pop while moving.
            // The full speed scale is still tracked for diagnostics and
            // predictive streaming.
            visibleSelectionMaxScale: Math.max(1.0, al.visibleSelectionMaxScale ?? 1.0),
            // asymmetric smoothing: ramp up fast (protect GPU),
            // ease down slow (avoid request burst on deceleration)
            smoothUp: al.smoothUp ?? 0.15,
            smoothDown: al.smoothDown ?? 0.03,
            // hold elevated scale while GPU still has a backlog
            holdWhenGpuBacklogged: al.holdWhenGpuBacklogged !== false
        };

        this._diagInterval = qt.diagnosticSnapshotIntervalFrames ?? 0;
        const planetRadius = this.planetConfig.radius;
        const planetOrigin = this.planetConfig.origin;

        // Compute maxGeomLOD from segment config (needed by QuadtreeGPU for indirect args)
        const baseSegments = this.engineConfig.chunkSegments;
        const lodSegments = TerrainGeometryBuilder.buildSegmentArray(baseSegments);
        this._diagLodSegments = Array.isArray(lodSegments) && lodSegments.length > 0
            ? [...lodSegments]
            : this._diagLodSegments;
        this._maxGeomLOD = Math.max(0, lodSegments.length - 1);
        const maxAbsNormalized = 1.8; // max(|-1.1|, |1.8|)
        const maxHeightDisplacement = maxAbsNormalized * this.planetConfig.maxTerrainHeight;

        this.quadtreeGPU = new QuadtreeGPU(this.device, {
            maxHeightDisplacement: maxHeightDisplacement,
            planetRadius: planetRadius,
            planetOrigin: planetOrigin,
            minTileSize: qt.minTileSizeMeters,
            maxVisibleTiles: qt.maxVisibleTiles,
            queueCapacity: qt.queueCapacity,
            screenHeight: this.backend.canvas?.height || 1080,
            fovDegrees: this.engineConfig.camera?.fov ?? 75,
            lodErrorThreshold: qt.lodErrorThreshold,
            workgroupSize: qt.workgroupSize,
            maxGeomLOD: this._maxGeomLOD,
            visibleTableCapacity: qt.visibleTableCapacity,
            loadedTableCapacity: qt.tileHashCapacity,
            maxFeedback: qt.feedbackCapacity,
            enableFrustumCulling: qt.enableFrustumCulling,
            enableHorizonCulling: qt.enableHorizonCulling,
            horizonGroundCos: qt.horizonCulling?.groundCos,
            horizonBlendScale: qt.horizonCulling?.blendScale,
            logStats: qt.logStats === true
        });

        await this.quadtreeGPU.initialize();

        const terrainShaderConfig = this.engineConfig?.rendering?.terrainShader ?? {};
        const resolvedColorStartLod = Number.isFinite(terrainShaderConfig.resolvedColorStartLod)
            ? Math.floor(terrainShaderConfig.resolvedColorStartLod)
            : 0;
        const hasResolvedColorInputs =
            !!this.textureManager?.getAtlasTexture?.('micro')?._gpuTexture?.texture &&
            !!this.textureManager?.getLookupTables?.()?.tileTypeLookup?._gpuTexture?.texture;
        const enableResolvedColor =
            terrainShaderConfig.resolvedColorEnabled !== false &&
            resolvedColorStartLod >= 0 &&
            hasResolvedColorInputs;
        const requiredTypes = ['height', 'normal', 'tile', 'splatData', 'scatter', 'climate'];
        if (enableResolvedColor) {
            requiredTypes.push('resolvedColor');
        }
        const textureFormats = {
            height:    'r32float',
            normal:    'rgba8unorm',
            tile:      'r8unorm',
            splatData: 'rgba8unorm',
            splatIndex: 'rgba8unorm',
            splatValid: 'rgba8unorm',
            resolvedColor: 'rgba8unorm',
            scatter:   'r8unorm',
            climate:   'rgba8unorm',
            ...(qt.textureFormats || {})
        };
        this.tileStreamer = new TileStreamer(
          this.device,
          this.terrainGenerator,
          this.quadtreeGPU,
          {
              tileTextureSize: qt.tileTextureSize,
              tilePoolSize: qt.tilePoolSize,
              maxPoolBytes: qt.tilePoolMaxBytes,
              tileHashCapacity: qt.tileHashCapacity,
              maxFeedback: qt.feedbackCapacity,
              queueConfig: this.engineConfig.generationQueue,
              requiredTypes,
              textureFormats,
              textureManager: this.textureManager,
              enableSplat: true,
              enableTileCacheBridge: false,
              feedbackReadbackInterval: qt.feedbackReadbackInterval,
              feedbackReadbackRingSize: qt.feedbackReadbackRingSize,
              gpuBackpressureLimit: qt.gpuBackpressureLimit ?? 4,   // NEW
              logStats: qt.logStats === true
          }
      );
        await this.tileStreamer.initialize();

        this._initialized = true;
        Logger.info('[QuadtreeTileManager] Initialized');
    }

    _updateAdaptiveLodScale(camera) {
        const cfg = this._adaptiveLodConfig;
        if (!cfg?.enabled || !camera?.position) {
            this._lodSpeedScale = 1.0;
            this._lodVisibleScale = 1.0;
            return;
        }

        const now = performance.now();
        const pos = camera.position;

        if (this._prevCameraPos && this._prevFrameTime > 0) {
            const dt = (now - this._prevFrameTime) / 1000;
            // Ignore degenerate dt: first frame, long pause, tab switch.
            if (dt > 0.001 && dt < 0.5) {
                const dx = pos.x - this._prevCameraPos.x;
                const dy = pos.y - this._prevCameraPos.y;
                const dz = pos.z - this._prevCameraPos.z;
                const speed = Math.hypot(dx, dy, dz) / dt;

                // Store raw velocity for predictive streaming.
                this._rawCamVelocity = { x: dx / dt, y: dy / dt, z: dz / dt };

                const excess = Math.max(0, speed - cfg.speedFloorMps);
                const rawScale = 1.0 + excess / Math.max(cfg.speedRefMps, 1);
                this._lodSpeedScaleTarget = Math.min(rawScale, cfg.maxScale);
            }
        }

        // Smooth toward target. Asymmetric: fast up, slow down.
        const delta = this._lodSpeedScaleTarget - this._lodSpeedScale;
        let smooth = delta > 0 ? cfg.smoothUp : cfg.smoothDown;

        // Don't lower the scale while the GPU is still digesting.
        // Otherwise deceleration triggers an immediate request burst
        // right when the queue is deepest.
        if (cfg.holdWhenGpuBacklogged && delta < 0) {
            const gpuInFlight =
                this.tileStreamer?.tileGenerator?._gpuFencesInFlight ?? 0;
            const gpuLimit = this.tileStreamer?._gpuBackpressureLimit ?? 4;
            if (gpuInFlight >= gpuLimit) {
                smooth = 0;
            }
        }

        this._lodSpeedScale = Math.max(1.0, this._lodSpeedScale + delta * smooth);
        this._lodVisibleScale = Math.min(this._lodSpeedScale, cfg.visibleSelectionMaxScale);

        this._prevCameraPos = { x: pos.x, y: pos.y, z: pos.z };
        this._prevFrameTime = now;
    }

    // ── Predictive tile streaming ────────────────────────────────────────────
    //
    // Each frame, extrapolates the camera position forward along its
    // EMA-smoothed velocity and pre-queues tiles at the predicted location
    // before the GPU feedback pipeline would discover them.
    //
    // Design constraints:
    //   - Conservative: look-ahead time scales with speed, capped at 1.5 s.
    //   - Responsive: EMA alpha of 0.15 gives ~7-frame (115 ms) response,
    //     fast enough to track airplane-speed turns (several seconds).
    //   - Safe: tiles already loaded or generating are skipped; the
    //     generation queue handles priority and deduplication.
    //
    // Controlled by engineConfig.gpuQuadtree.predictiveStreaming.enabled.
    _updatePredictiveStreaming(camera) {
        const cfg = this.engineConfig?.gpuQuadtree?.predictiveStreaming;
        if (!cfg?.enabled) return;
        if (!camera?.position) return;
        if (!this.tileStreamer?.hashTable || !this.tileStreamer?.tileGenerator) return;
        if (!this.quadtreeGPU) return;

        const pos = camera.position;
        const ps  = this._predictState;

        // ── 1. Smooth velocity ───────────────────────────────────────
        // Raw velocity is written by _updateAdaptiveLodScale (same frame,
        // runs just before this method).  If the camera hasn't moved yet,
        // keep the previous smoothed value.
        const rawVx = this._rawCamVelocity?.x ?? 0;
        const rawVy = this._rawCamVelocity?.y ?? 0;
        const rawVz = this._rawCamVelocity?.z ?? 0;

        const alpha = cfg.velocitySmoothAlpha ?? 0.15;
        ps.smoothVelX += alpha * (rawVx - ps.smoothVelX);
        ps.smoothVelY += alpha * (rawVy - ps.smoothVelY);
        ps.smoothVelZ += alpha * (rawVz - ps.smoothVelZ);

        const speed = Math.hypot(ps.smoothVelX, ps.smoothVelY, ps.smoothVelZ);
        if (speed < (cfg.speedThresholdMps ?? 50)) return;

        // ── 2. Compute predicted world position ──────────────────────
        const lookAheadMax   = cfg.lookAheadTimeMaxSec  ?? 1.5;
        const lookAheadScale = cfg.lookAheadSpeedScale  ?? 0.0025;
        const lookAheadSec   = Math.min(speed * lookAheadScale, lookAheadMax);

        const predX = pos.x + ps.smoothVelX * lookAheadSec;
        const predY = pos.y + ps.smoothVelY * lookAheadSec;
        const predZ = pos.z + ps.smoothVelZ * lookAheadSec;

        // ── 3. Map predicted position → face + tile UV ───────────────
        // Inline sphereToCube: normalize the direction from planet origin,
        // then project onto the dominant cube face (same math as
        // CubeSphereCoords.sphereToCube / worldPositionToFaceUV).
        const originX = this.planetConfig?.origin?.x ?? 0;
        const originY = this.planetConfig?.origin?.y ?? 0;
        const originZ = this.planetConfig?.origin?.z ?? 0;
        const relX = predX - originX;
        const relY = predY - originY;
        const relZ = predZ - originZ;

        const len = Math.hypot(relX, relY, relZ);
        if (len < 1e-10) return;
        const nx = relX / len, ny = relY / len, nz = relZ / len;

        const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
        let face, cubeU, cubeV;
        if (ax >= ay && ax >= az) {
            // Face 0 (+X) or 1 (-X)
            face = nx > 0 ? 0 : 1;
            const s = 1 / ax;
            cubeU = nx > 0 ? -nz * s : nz * s;
            cubeV = ny * s;
        } else if (ay >= ax && ay >= az) {
            // Face 2 (+Y) or 3 (-Y)
            face = ny > 0 ? 2 : 3;
            const s = 1 / ay;
            cubeU = nx * s;
            cubeV = ny > 0 ? -nz * s : nz * s;
        } else {
            // Face 4 (+Z) or 5 (-Z)
            face = nz > 0 ? 4 : 5;
            const s = 1 / az;
            cubeU = nz > 0 ? nx * s : -nx * s;
            cubeV = ny * s;
        }

        // Cube UV in [-1, 1] → tile UV in [0, 1] (matches TileAddress.fromFaceUV)
        const tileU = (cubeU + 1) * 0.5;
        const tileV = (cubeV + 1) * 0.5;

        // ── 4. Queue tiles at each depth in the configured range ─────
        //
        // Neighbor radius shrinks with depth so the queued world-space
        // footprint stays roughly constant across LOD levels.  At the
        // coarsest depth we use neighborRadiusCoarse (default 4 → 9×9);
        // each extra level halves the radius because tiles are half the size.
        //   radius(d) = max(1, round(radiusCoarse / 2^(d - depthMin)))
        // Example (depthMin=4, coarse=4):
        //   depth 4 → 4  (9×9 — wide frustum sweep)
        //   depth 6 → 1  (3×3)
        //   depth 8+ → 1

        const maxDepth     = this.quadtreeGPU.maxDepth;
        const depthMin     = Math.min(cfg.depthMin         ?? 4,  maxDepth);
        const depthMax     = Math.min(cfg.depthMax         ?? 11, maxDepth);
        const radiusCoarse = cfg.neighborRadiusCoarse ?? (cfg.neighborRadius ?? 4);

        const hashTable    = this.tileStreamer.hashTable;
        const tileGenerator = this.tileStreamer.tileGenerator;

        for (let depth = depthMin; depth <= depthMax; depth++) {
            const gs = 1 << depth;
            const centerX = Math.max(0, Math.min(gs - 1, Math.floor(tileU * gs)));
            const centerY = Math.max(0, Math.min(gs - 1, Math.floor(tileV * gs)));

            const neighborRadius = Math.max(1, Math.round(radiusCoarse / Math.pow(2, depth - depthMin)));

            for (let dy = -neighborRadius; dy <= neighborRadius; dy++) {
                for (let dx = -neighborRadius; dx <= neighborRadius; dx++) {
                    const tx = centerX + dx;
                    const ty = centerY + dy;
                    if (tx < 0 || tx >= gs || ty < 0 || ty >= gs) continue;

                    // Skip if the tile is already resident in the GPU pool.
                    const keyLo = hashTable.makeKeyLo(tx, ty);
                    const keyHi = hashTable.makeKeyHi(face, depth);
                    if (hashTable.findSlot(keyLo, keyHi) >= 0) continue;

                    // Skip if generation is already in progress.
                    const addr = new TileAddress(face, depth, tx, ty);
                    if (tileGenerator.isGenerating(addr)) continue;

                    this.tileStreamer._queueTile(addr);
                }
            }
        }
    }

    toggleManualDiagnosticSnapshot(reason = 'manual') {
        if (this._manualDiagState.frozen) {
            if (this._manualDiagState.running) {
                Logger.warn(
                    `${TERRAIN_MANUAL_TAG} snapshot still running id=${this._manualDiagState.snapshotId}`
                );
                return this.getManualDiagnosticState();
            }
            this._releaseManualDiagnosticSnapshot();
            return this.getManualDiagnosticState();
        }
        if (this._manualDiagState.requested || this._manualDiagState.running) {
            Logger.warn(
                `${TERRAIN_MANUAL_TAG} snapshot busy status=${this._manualDiagState.status} ` +
                `id=${this._manualDiagState.snapshotId}`
            );
            return this.getManualDiagnosticState();
        }
        this._manualDiagId += 1;
        this._manualDiagState = {
            ...this._manualDiagState,
            status: 'requested',
            requested: true,
            frozen: false,
            running: false,
            completed: false,
            reason,
            snapshotId: this._manualDiagId,
            requestedAt: performance.now(),
            startedAt: 0,
            finishedAt: 0,
            durationMs: 0,
            error: ''
        };
        Logger.warn(
            `${TERRAIN_MANUAL_TAG} snapshot requested id=${this._manualDiagState.snapshotId} reason=${reason}`
        );
        return this.getManualDiagnosticState();
    }

    getManualDiagnosticState() {
        const state = this._manualDiagState;
        return state ? {
            status: state.status,
            requested: state.requested,
            frozen: state.frozen,
            running: state.running,
            completed: state.completed,
            reason: state.reason,
            snapshotId: state.snapshotId,
            requestedAt: state.requestedAt,
            startedAt: state.startedAt,
            finishedAt: state.finishedAt,
            durationMs: state.durationMs,
            error: state.error,
            lastSummary: state.lastSummary
        } : null;
    }

    isManualDiagnosticFrozen() {
        return this._manualDiagState?.frozen === true;
    }

    _releaseManualDiagnosticSnapshot() {
        const snapshotId = this._manualDiagState?.snapshotId ?? 0;
        this._manualDiagState = {
            ...this._manualDiagState,
            status: 'idle',
            requested: false,
            frozen: false,
            running: false,
            completed: false,
            reason: '',
            requestedAt: 0,
            startedAt: 0,
            finishedAt: 0,
            durationMs: 0,
            error: ''
        };
        this._manualDiagRunPending = false;
        Logger.warn(`${TERRAIN_MANUAL_TAG} snapshot released id=${snapshotId}`);
    }

    _activateManualDiagnosticSnapshotFreeze() {
        if (!this._manualDiagState?.requested || this._manualDiagState.frozen) {
            return;
        }
        this._manualDiagState = {
            ...this._manualDiagState,
            status: 'frozen',
            requested: false,
            frozen: true,
            running: false,
            completed: false,
            startedAt: 0,
            finishedAt: 0,
            durationMs: 0,
            error: ''
        };
        this._manualDiagRunPending = true;
        Logger.warn(
            `${TERRAIN_MANUAL_TAG} snapshot frozen id=${this._manualDiagState.snapshotId} ` +
            `reason=${this._manualDiagState.reason}`
        );
    }

    _queueManualDiagnosticRun() {
        if (!this._manualDiagState?.frozen || !this._manualDiagRunPending || this._manualDiagState.running) {
            return;
        }
        this._manualDiagRunPending = false;
        queueMicrotask(() => {
            this._runManualDiagnosticSnapshot().catch((err) => {
                this._manualDiagState = {
                    ...this._manualDiagState,
                    status: 'frozen',
                    running: false,
                    completed: true,
                    finishedAt: performance.now(),
                    durationMs: this._manualDiagState.startedAt > 0
                        ? performance.now() - this._manualDiagState.startedAt
                        : 0,
                    error: err?.message ?? String(err)
                };
                Logger.error(
                    `${TERRAIN_MANUAL_TAG} snapshot failed id=${this._manualDiagState.snapshotId} ` +
                    `${err?.stack ?? err}`
                );
            });
        });
    }

    get maxGeomLOD() {
        return this._maxGeomLOD;
    }

    isReady() {
        return this._initialized && this.quadtreeGPU?.isReady();
    }

    /** Called by the renderer after building geometries, so indirect args get correct index counts. */
    updateLodIndexCounts(counts) {
        this.quadtreeGPU.updateLodIndexCounts(counts);
    }
    async debugReadIndirectArgs() {
        if (!this.quadtreeGPU?._metaBuffer) return null;

        const device = this.backend.device;
        const lodLevels = this.quadtreeGPU.lodLevels;
        const argsStartU32 = lodLevels * 3;
        const argsBytes = lodLevels * 5 * 4;
        const argsOffsetBytes = argsStartU32 * 4;

        const staging = device.createBuffer({
            label: 'IndirectArgsStaging',
            size: argsBytes,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        });

        const encoder = device.createCommandEncoder();
        encoder.copyBufferToBuffer(
            this.quadtreeGPU._metaBuffer, argsOffsetBytes,
            staging, 0,
            argsBytes
        );
        device.queue.submit([encoder.finish()]);

        await staging.mapAsync(GPUMapMode.READ);
        const data = new Uint32Array(staging.getMappedRange());

        const result = [];
        for (let lod = 0; lod < lodLevels; lod++) {
            const base = lod * 5;
            result.push({
                lod,
                indexCount: data[base],
                instanceCount: data[base + 1],
                firstIndex: data[base + 2],
                baseVertex: data[base + 3],
                firstInstance: data[base + 4]
            });
        }

        staging.unmap();
        staging.destroy();
        return result;
    }

    update(camera, commandEncoder) {
        if (!this.isReady()) return;
        if (!camera || !commandEncoder) return;

        this._lastCamera = camera;
        if (this._manualDiagState?.requested) {
            this._activateManualDiagnosticSnapshotFreeze();
        }
        if (this._manualDiagState?.frozen) {
            this._queueManualDiagnosticRun();
            return;
        }

        const dp = this.engineConfig?.gpuQuadtree?.debugProfile;
        const profilingEnabled = dp?.enabled === true;
        this._profileFrame++;

        // ── Debug profile: FPS measurement ───────────────────────────
        if (profilingEnabled) {
            const now = performance.now();
            if (this._profileLastTime > 0) {
                const dt = now - this._profileLastTime;
                if (dt > 0) {
                    this._profileFpsAccum += 1000 / dt;
                    this._profileFpsSamples++;
                }
            }
            this._profileLastTime = now;
        }

        const warmup = profilingEnabled ? (dp.warmupFrames ?? 300) : Infinity;
        const frozen = profilingEnabled && this._profileFrame > warmup;

        // ── Freeze activation log (once) ─────────────────────────────
        if (frozen && !this._profileFrozen) {
            this._profileFrozen = true;
            const flags = [];
            if (dp.freezeGeneration) flags.push('generation');
            if (dp.freezeFeedback)   flags.push('feedback');
            if (dp.freezeTraversal)  flags.push('traversal');
            if (dp.freezeInstances)  flags.push('instances');
            if (dp.freezeUniforms)   flags.push('uniforms');
            const avgFps = this._profileFpsSamples > 0
                ? (this._profileFpsAccum / this._profileFpsSamples).toFixed(1)
                : '?';
            Logger.warn(
                `[QT-Profile] FREEZE activated at frame ${this._profileFrame} | ` +
                `warmup avg FPS: ${avgFps} | frozen: [${flags.join(', ')}]`
            );
            // Reset FPS counters to measure post-freeze
            this._profileFpsAccum = 0;
            this._profileFpsSamples = 0;
        }

        // ── Periodic FPS log while profiling ─────────────────────────
        if (profilingEnabled && this._profileFpsSamples > 0 &&
            this._profileFrame % this._profileLogInterval === 0) {
            const avgFps = (this._profileFpsAccum / this._profileFpsSamples).toFixed(1);
            const phase = frozen ? 'FROZEN' : 'WARMUP';
            Logger.info(`[QT-Profile] ${phase} frame=${this._profileFrame} avgFPS=${avgFps}`);
            this._profileFpsAccum = 0;
            this._profileFpsSamples = 0;
        }

        // ── (A) Tile streamer flush + generation ─────────────────────
        // Always flush pending copies/hash uploads so in-flight tasks
        // that completed can become GPU-visible.
        this.tileStreamer.tickFlush();
        if (!frozen || !dp.freezeGeneration) {
            this.tileStreamer.tickGeneration();
        }

        this._updateAdaptiveLodScale(camera);
        this._updatePredictiveStreaming(camera);

        // ── (B) Uniform update ───────────────────────────────────────
        if (!frozen || !dp.freezeUniforms) {
            const baseThreshold = this.engineConfig.gpuQuadtree.lodErrorThreshold;
            const visibleLodScale = Number.isFinite(this._lodVisibleScale)
                ? this._lodVisibleScale
                : this._lodSpeedScale;
            this.quadtreeGPU.updateUniforms(camera, {
                screenHeight: this.backend.canvas?.height || 1080,
                lodErrorThreshold: baseThreshold * visibleLodScale
            });
        }

        // ── (C) GPU traversal ────────────────────────────────────────
        if (!frozen || !dp.freezeTraversal) {
            this.quadtreeGPU.traverse(commandEncoder);
        }

        // ── (D) GPU instance building ────────────────────────────────
        if (!frozen || !dp.freezeInstances) {
            this.quadtreeGPU.buildInstances(commandEncoder);
        }

        // ── (E) Feedback readback initiation ─────────────────────────
        if (!frozen || !dp.freezeFeedback) {
            this.tileStreamer.beginFeedbackReadback(commandEncoder);
        }

        this.quadtreeGPU.tick();
        this._maybeReadbackVisibleTiles();
        this._maybeLogLightweightDiagnostics();
    }

    resolveFeedbackReadback() {
        if (!this.isReady()) return;
        if (this._manualDiagState?.frozen) return;
        const dp = this.engineConfig?.gpuQuadtree?.debugProfile;
        const frozen = dp?.enabled === true && this._profileFrame > (dp.warmupFrames ?? 300);
        if (frozen && dp.freezeFeedback) return;
        this.tileStreamer?.resolveFeedbackReadback?.();
    }

    refreshTiles() {
        if (!this.isReady()) return;
        this.tileStreamer?.resetTiles?.({ reseedRootTiles: true });
    }

    // ── Buffer / texture accessors for the renderer ──────────────────────

    getInstanceBuffer() {
        return this.quadtreeGPU.getInstanceBuffer();
    }

    getIndirectArgsBuffer() {
        return this.quadtreeGPU.getIndirectArgsBuffer();
    }

    getIndirectArgsOffsetBytes(lod) {
        return this.quadtreeGPU.getIndirectArgsOffsetBytes(lod);
    }

    getArrayTextures() {
        return this.tileStreamer.getArrayTextures();
    }

    getInitialLoadStatus() {
        const tileStreamer = this.tileStreamer;
        const visibleTiles = Array.isArray(this._lastVisibleTiles) ? this._lastVisibleTiles : [];
        const now = performance.now();

        let residentVisibleTiles = 0;
        let exactVisibleTiles = 0;
        let ancestorVisibleTiles = 0;

        if (tileStreamer && visibleTiles.length > 0) {
            for (const tile of visibleTiles) {
                if (!tile) continue;

                const exactLayer = tileStreamer.getLoadedLayer(tile.face, tile.depth, tile.x, tile.y);
                if (Number.isInteger(exactLayer) && exactLayer >= 0) {
                    residentVisibleTiles++;
                    exactVisibleTiles++;
                    continue;
                }

                let depth = tile.depth;
                let x = tile.x;
                let y = tile.y;
                while (depth > 0) {
                    depth--;
                    x >>= 1;
                    y >>= 1;
                    const ancestorLayer = tileStreamer.getLoadedLayer(tile.face, depth, x, y);
                    if (Number.isInteger(ancestorLayer) && ancestorLayer >= 0) {
                        residentVisibleTiles++;
                        ancestorVisibleTiles++;
                        break;
                    }
                }
            }
        }

        const totalVisibleTiles = visibleTiles.length;
        const generationQueue = tileStreamer?._generationQueue;
        const pendingGenerations = generationQueue?.queue?.length ?? 0;
        const activeGenerations = generationQueue?.active ?? 0;
        const pendingCopies = tileStreamer?.arrayPool?._pendingCopies?.length ?? 0;
        const loadedTiles = tileStreamer?._tileInfo?.size ?? 0;
        const freeLayers = tileStreamer?.arrayPool?.freeLayers?.length ?? 0;
        const lastVisibleReadbackTime = tileStreamer?._lastVisibleReadbackTime ?? 0;
        const visibleReadbackAgeMs = lastVisibleReadbackTime > 0 ? Math.max(0, now - lastVisibleReadbackTime) : null;

        return {
            hasVisibleReadback: totalVisibleTiles > 0,
            visibleTiles: totalVisibleTiles,
            residentVisibleTiles,
            exactVisibleTiles,
            ancestorVisibleTiles,
            residentVisibleRatio: totalVisibleTiles > 0 ? residentVisibleTiles / totalVisibleTiles : 0,
            exactVisibleRatio: totalVisibleTiles > 0 ? exactVisibleTiles / totalVisibleTiles : 0,
            loadedTiles,
            freeLayers,
            pendingGenerations,
            activeGenerations,
            pendingCopies,
            dirtySlots: tileStreamer?._dirtySlots?.size ?? 0,
            visibleReadbackAgeMs,
        };
    }

}

installQuadtreeTileManagerDiagnostics(QuadtreeTileManager);
