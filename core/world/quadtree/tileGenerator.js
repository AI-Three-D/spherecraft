// js/world/quadtree/TileGenerator.js
//
// Wraps WebGPUTerrainGenerator to produce tile textures on demand.
//
// Key concept: A tile at depth D is rendered at a fixed texel resolution
// (e.g. 1024×1024) but covers a world-space area that shrinks with depth.
//
// The existing terrain compute shader already supports this pattern via:
//   - chunkCoordX/Y = tile (x, y) at depth D
//   - chunkSizeTex  = textureSize (tile fills entire output texture)
//   - chunkGridSize = 2^D (tiles per face side at this depth)
//
// The shader computes faceUV = (tileCoord + texelLocalUV) / gridSize, which
// is exactly the tile's UV range on the cube face. No shader modifications needed.
//
// Memory layout:
//   All tiles at all depths use the same texture resolution (1024×1024).
//   Texel density = gridSize / textureSize texels per face-UV unit.
//   At depth 14, gridSize=16384, so density = 16 texels per face-UV unit.
//   At depth 10, gridSize=1024,  so density = 1  texel per face-UV unit.
//   This is a natural geometric LOD: coarser tiles have lower sampling density.

import { Logger } from '../../../shared/Logger.js';
import { gpuFormatBytesPerTexel } from '../../renderer/resources/texture.js';
import { buildCoarseCategoryColorFragmentWGSL } from '../tileCategoryColors.js';

function alignTo(value, alignment) {
    return Math.ceil(value / alignment) * alignment;
}



function halfToFloat(h) {
    const s = (h & 0x8000) ? -1 : 1;
    const e = (h >> 10) & 0x1f;
    const f = h & 0x03ff;
    if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
    if (e === 31) return f ? NaN : s * Infinity;
    return s * Math.pow(2, e - 15) * (1 + f / 1024);
}

function readTexel(dv, offset, format) {
    switch (format) {
        case 'r32float':
            return [dv.getFloat32(offset, true)];
        case 'rgba32float':
            return [
                dv.getFloat32(offset, true),
                dv.getFloat32(offset + 4, true),
                dv.getFloat32(offset + 8, true),
                dv.getFloat32(offset + 12, true)
            ];
        case 'r16float':
            return [halfToFloat(dv.getUint16(offset, true))];
        case 'rgba16float':
            return [
                halfToFloat(dv.getUint16(offset, true)),
                halfToFloat(dv.getUint16(offset + 2, true)),
                halfToFloat(dv.getUint16(offset + 4, true)),
                halfToFloat(dv.getUint16(offset + 6, true))
            ];
        case 'r8unorm':
            return [dv.getUint8(offset) / 255];
        case 'rgba8unorm':
            return [
                dv.getUint8(offset) / 255,
                dv.getUint8(offset + 1) / 255,
                dv.getUint8(offset + 2) / 255,
                dv.getUint8(offset + 3) / 255
            ];
        default:
            return [dv.getFloat32(offset, true)];
    }
}

const DEFAULT_TEXTURE_FORMATS = {
    height: 'r32float',
    normal: 'rgba32float',
    tile: 'r8unorm',
    macro: 'rgba8unorm',
    splatData: 'rgba8unorm',
    splatIndex: 'rgba8unorm',
    splatValid: 'rgba8unorm',
    resolvedColor: 'rgba8unorm',
    scatter: 'r8unorm'
};

export class TileGenerator {
    /**
     * @param {WebGPUTerrainGenerator} terrainGenerator  The compute-shader generator
     * @param {object} [options]
     * @param {number}   [options.textureSize=1024]      Texels per tile (all LODs)
     * @param {string[]} [options.requiredTypes]         Output texture types to generate
     * @param {boolean}  [options.enableSplat=true]      Generate splat data texture
     * @param {number}   [options.splatKernelSize=3]     Splat blur kernel (shader param)
     */
    constructor(terrainGenerator, options = {}) {
        if (!terrainGenerator) {
            throw new Error('TileGenerator: terrainGenerator is required');
        }

        this._gpuFencesInFlight = 0;
this._maxGpuFencesObserved = 0;
        this._submissionCount = 0;
        // Called once per tile, after the GPU fence for that tile's batched
        // submission resolves. Lets TileStreamer attach the final
        // gpuFenceComplete timestamp to its per-request telemetry record
        // without TileGenerator knowing anything about request tracking.
        this.onGenerationTelemetry = options.onGenerationTelemetry ?? null;

        this.terrainGen   = terrainGenerator;
        this.textureSize  = options.textureSize     ?? 1024;
        this.requiredTypes = options.requiredTypes  ?? ['height', 'normal', 'tile'];
        this.textureManager = options.textureManager ?? null;
        // Tile categories for the baked flat-tier color ('coarseColor').
        this.tileCategories = Array.isArray(options.tileCategories) ? options.tileCategories : null;
        this._coarseColorPipeline = null;
        // Window (m) of the baked flat-color average and the cube-face size,
        // matching the terrain shader's solidColorAverageWindowMeters.
        this.coarseColorWindowMeters = Number.isFinite(options.coarseColorWindowMeters) ? options.coarseColorWindowMeters : 0;
        this.coarseColorFaceSizeMeters = Number.isFinite(options.coarseColorFaceSizeMeters) ? options.coarseColorFaceSizeMeters : 0;
        this.enableSplat  = options.enableSplat     ?? this.requiredTypes.includes('splatData');
        this.splatKernelSize = options.splatKernelSize ?? 3;
        this.textureFormats = {
            ...DEFAULT_TEXTURE_FORMATS,
            ...(options.textureFormats || {})
        };
        this.quadtreeMaxDepth = Number.isFinite(options.quadtreeMaxDepth)
            ? Math.max(0, Math.floor(options.quadtreeMaxDepth))
            : null;
        this.maxGeomLOD = Number.isFinite(options.maxGeomLOD)
            ? Math.max(0, Math.floor(options.maxGeomLOD))
            : null;

        // Track in-progress generations to avoid duplicate requests
        this._inProgress = new Map();  // tileAddr.toString() -> Promise

        // Stats
        this._stats = {
            totalGenerated: 0,
            totalTimeMs:    0,
            byDepth:        new Map()  // depth -> { count, totalMs }
        };

        this._logStatsEnabled = options.logStats === true;
        this._logFrame    = 0;
        this._logInterval = 300;  // frames between stat logs
    }

    consumeMaxGpuFences() {
        const max = this._maxGpuFencesObserved;
        this._maxGpuFencesObserved = this._gpuFencesInFlight;
        return max;
    }

    /** Reset the per-window GPU submission counter and return its previous value. */
    consumeSubmissionCount() {
        const count = this._submissionCount;
        this._submissionCount = 0;
        return count;
    }

    /**
     * Generate all required textures for a tile.
     * Returns a cached promise if generation is already in progress.
     *
     * @param {TileAddress} tileAddr
     * @param {object} [telemetry]  Optional per-request telemetry record
     *   (see TileStreamer._queueTile). If provided, this call fills in
     *   computeSubmitted (synchronously, right after the batched pass
     *   submission) and gpuFenceComplete (asynchronously, once the GPU
     *   fence for that submission resolves), then invokes
     *   onGenerationTelemetry so the caller can finalize its own bookkeeping.
     * @param {string[]} [outputTypes]  Override for this.requiredTypes —
     *   lets a caller request just the geometry preset (fast path) or just
     *   the refinement remainder, per Phase 2 of the optimization plan.
     *   Defaults to this.requiredTypes (the full configured set).
     * @returns {Promise<object>}  Resolves to { height, normal, tile, macro, splatData }
     *                              Each value is a Texture resource.
     */
    // geometrySource (optional, refinement only): { arrayPool, layer } of the
    // tile's resident pool layer. Its height and tile-id layers are copied
    // in as the refinement's inputs instead of re-running the base-height,
    // tile-classification and final-height passes. The caller must ensure
    // the layer's geometry copy has already been submitted to the queue.
    async generateTile(tileAddr, telemetry = null, outputTypes = null, geometrySource = null) {
        const key = tileAddr.toString();

        // Reuse in-progress generation
        const existing = this._inProgress.get(key);
        if (existing) return existing;

        const promise = this._generateTileInternal(tileAddr, { telemetry, requiredTypes: outputTypes, geometrySource })
            .finally(() => this._inProgress.delete(key));

        this._inProgress.set(key, promise);
        return promise;
    }

    async generateDiagnosticTile(tileAddr, options = {}) {
        return this._generateTileInternal(tileAddr, {
            includeBaseHeight: options?.includeBaseHeight === true,
            trackStats: false
        });
    }

    /**
     * Check if a tile is currently being generated.
     * @param {TileAddress} tileAddr
     * @returns {boolean}
     */
    isGenerating(tileAddr) {
        return this._inProgress.has(tileAddr.toString());
    }

    /**
     * Estimate generation time in milliseconds.
     * Used by the scheduler to predict load.
     *
     * @param {TileAddress} tileAddr
     * @returns {number}  Estimated milliseconds
     */
    estimateGenerationTime(tileAddr) {
        const depthStats = this._stats.byDepth.get(tileAddr.depth);
        if (depthStats && depthStats.count > 0) {
            return depthStats.totalMs / depthStats.count;
        }

        // Fallback: assume ~12ms per tile (empirical average for depth 10–14)
        // Coarser tiles (depth < 8) are faster; finer tiles (depth > 12) similar
        return 12;
    }

    /**
     * Get current statistics.
     * @returns {object}
     */
    getStats() {
        const byDepth = {};
        for (const [depth, stats] of this._stats.byDepth) {
            byDepth[depth] = {
                count:  stats.count,
                avgMs:  stats.count > 0 ? (stats.totalMs / stats.count).toFixed(2) : 0
            };
        }

        return {
            totalGenerated: this._stats.totalGenerated,
            avgTimeMs:      this._stats.totalGenerated > 0
                ? (this._stats.totalTimeMs / this._stats.totalGenerated).toFixed(2)
                : 0,
            inProgress:     this._inProgress.size,
            byDepth
        };
    }

    /**
     * Call once per frame for periodic logging.
     */
    tick() {
        if (!this._logStatsEnabled) return;
        this._logFrame++;
        if (this._logFrame >= this._logInterval) {
            this._logFrame = 0;
            this._logStats();
        }
    }

    async _generateTileInternal(tileAddr, options = {}) {
        const startTime = performance.now();
        const includeBaseHeight = options?.includeBaseHeight === true;
        const trackStats = options?.trackStats !== false;
        const telemetry = options?.telemetry ?? null;
        // Phase 2 (geometry-first residency): callers can request a subset
        // of this.requiredTypes for a fast geometry-only pass, then a
        // separate refinement call for the remainder. Height/tile are
        // recomputed as intermediate inputs whenever splat/climate/scatter
        // are requested (see needsFinalHeight/needsTile below) even if not
        // themselves in the requested set — cheap, deterministic, and not
        // returned unless actually requested.
        const requiredTypes = options?.requiredTypes ?? this.requiredTypes;

        const gridSize = 1 << tileAddr.depth;
        const textures = {};
    
        const heightFormat = this.textureFormats.height || 'r32float';
        const normalFormat = this.textureFormats.normal || 'rgba32float';
        const tileFormat = this.textureFormats.tile || 'r8unorm';
        const macroFormat = this.textureFormats.macro || 'rgba8unorm';
        const scatterFormat = this.textureFormats.scatter || 'r8unorm';
    
        const needsFinalHeight =
            requiredTypes.includes('height')
            || requiredTypes.includes('normal')
            || (this.enableSplat && requiredTypes.includes('splatData'))
            || requiredTypes.includes('scatter');
        const needsTile = requiredTypes.includes('tile') || needsFinalHeight;

        // Refinement of a resident tile: copy its final height and tile ids
        // from its pool layer instead of recomputing them (base height +
        // stable slope, biome classification, micro height). Byte-identical
        // inputs: the pool layer holds exactly what the geometry pass made.
        const geometrySource = options?.geometrySource ?? null;
        const sourcePool = geometrySource?.arrayPool ?? null;
        const reuseResidentGeometry =
            !!sourcePool &&
            Number.isInteger(geometrySource.layer) &&
            needsTile &&
            !requiredTypes.includes('height') &&
            !requiredTypes.includes('normal') &&
            !requiredTypes.includes('tile') &&
            !requiredTypes.includes('macro') &&
            sourcePool.textures?.get?.('height') &&
            sourcePool.textures?.get?.('tile') &&
            sourcePool.formats?.height === heightFormat &&
            sourcePool.formats?.tile === tileFormat &&
            sourcePool.tileSize === this.textureSize;
        const needsBaseHeight = needsTile && !reuseResidentGeometry;
    
        let gpuHeightBase = null;
        let gpuHeight = null;
        let gpuNormal = null;
        let gpuTile = null;
        let gpuMacro = null;
        let tileTarget = null;
        // Intermediate inputs created here but not returned to the caller;
        // destroyed once the GPU work is done (previously leaked).
        const internalInputs = [];

        if (reuseResidentGeometry) {
            gpuHeight = this.terrainGen.createSampledGPUTexture(
                this.textureSize, this.textureSize, heightFormat);
            gpuTile = this.terrainGen.createSampledGPUTexture(
                this.textureSize, this.textureSize, tileFormat);
            internalInputs.push(gpuHeight, gpuTile);
            const device = this.terrainGen.device;
            const enc = device.createCommandEncoder({ label: 'RefinementInputsFromPool' });
            const extent = { width: this.textureSize, height: this.textureSize, depthOrArrayLayers: 1 };
            enc.copyTextureToTexture(
                { texture: sourcePool.textures.get('height'), origin: { x: 0, y: 0, z: geometrySource.layer } },
                { texture: gpuHeight },
                extent
            );
            enc.copyTextureToTexture(
                { texture: sourcePool.textures.get('tile'), origin: { x: 0, y: 0, z: geometrySource.layer } },
                { texture: gpuTile },
                extent
            );
            device.queue.submit([enc.finish()]);
        }

        // heightBase carries a 1-texel apron (the adjacent tiles' edge-adjacent
        // texels, see advancedTerrainCompute main) so the normal pass needs no
        // terrain evaluations for its border samples. Not when heightBase is
        // returned to the caller (diagnostics expect textureSize^2).
        const baseHeightApron = needsBaseHeight && !includeBaseHeight;
        const baseHeightSize = this.textureSize + (baseHeightApron ? 2 : 0);
        if (needsBaseHeight) {
            gpuHeightBase = this._createGPUTexture(
                baseHeightSize, baseHeightSize, 'rgba32float');
        }
        if (needsTile && !reuseResidentGeometry) {
            tileTarget = this.terrainGen.createStorageBackedOutputTarget(
                this.textureSize, this.textureSize, tileFormat);
            gpuTile = tileTarget.finalTexture;
        }
        if (needsFinalHeight && !reuseResidentGeometry) {
            gpuHeight = this._createGPUTexture(
                this.textureSize, this.textureSize, heightFormat);
        }
        if (requiredTypes.includes('normal')) {
            gpuNormal = this._createGPUTexture(
                this.textureSize, this.textureSize, normalFormat);
        }
        if (requiredTypes.includes('macro')) {
            gpuMacro = this._createGPUTexture(
                this.textureSize, this.textureSize, macroFormat);
        }
    
        // ── Build terrain passes in dependency order ───────────────
        const terrainPasses = [];
        if (gpuHeightBase) {
            terrainPasses.push({
                outputType: 0,
                texture: gpuHeightBase,
                format: 'rgba32float',
                textureSize: baseHeightSize
            });
        }
        if (gpuTile && !reuseResidentGeometry) {
            terrainPasses.push({
                outputType: 2,
                texture: tileTarget.storageTexture,
                format: tileTarget.storageFormat,
                textureSize: this.textureSize,
                heightTexture: gpuHeightBase,
                heightTextureFormat: 'rgba32float',
                resolveToTexture: tileTarget.requiresResolve ? gpuTile : null,
                resolveToFormat: tileTarget.requiresResolve ? tileTarget.finalFormat : null
            });
        }
        if (gpuHeight && !reuseResidentGeometry) {
            terrainPasses.push({
                outputType: 4,
                texture: gpuHeight,
                format: heightFormat,
                textureSize: this.textureSize,
                heightTexture: gpuHeightBase,
                tileTexture: gpuTile,
                heightTextureFormat: 'rgba32float',
                tileTextureFormat: tileFormat
            });
        }
        if (gpuNormal) {
            terrainPasses.push({
                outputType: 1,
                texture: gpuNormal,
                format: normalFormat,
                textureSize: this.textureSize,
                heightTexture: gpuHeight,
                heightTextureFormat: heightFormat,
                // Base height (heightBase.r) for the border-band normals.
                baseHeightTexture: gpuHeightBase ?? null
            });
        }
        if (gpuMacro) {
            terrainPasses.push({
                outputType: 3,
                texture: gpuMacro,
                format: macroFormat,
                textureSize: this.textureSize
            });
        }
        
        // ── Scatter eligibility pass (needs height + tile) ────────
        let gpuScatter = null;
        let scatterTarget = null;
        if (requiredTypes.includes('scatter') && gpuHeight && gpuTile) {
            scatterTarget = this.terrainGen.createStorageBackedOutputTarget(
                this.textureSize, this.textureSize, scatterFormat);
            gpuScatter = scatterTarget.finalTexture;
            terrainPasses.push({
                outputType: 5,
                texture: scatterTarget.storageTexture,
                format: scatterTarget.storageFormat,
                textureSize: this.textureSize,
                heightTexture: gpuHeight,
                tileTexture: gpuTile,
                heightTextureFormat: heightFormat,
                tileTextureFormat: tileFormat,
                resolveToTexture: scatterTarget.requiresResolve ? gpuScatter : null,
                resolveToFormat: scatterTarget.requiresResolve ? scatterTarget.finalFormat : null
            });
        }

        // ── Climate bake pass (needs height + tile) ───────────────
        let gpuClimate = null;
        let climateTarget = null;
        const climateFormat = this.textureFormats.climate || 'rgba8unorm';
        if (requiredTypes.includes('climate') && gpuHeight && gpuTile) {
            climateTarget = this.terrainGen.createStorageBackedOutputTarget(
                this.textureSize, this.textureSize, climateFormat);
            gpuClimate = climateTarget.finalTexture;
            terrainPasses.push({
                outputType: 6,
                texture: climateTarget.storageTexture,
                format: climateTarget.storageFormat,
                textureSize: this.textureSize,
                heightTexture: gpuHeight,
                tileTexture: gpuTile,
                heightTextureFormat: heightFormat,
                tileTextureFormat: tileFormat,
                resolveToTexture: climateTarget.requiresResolve ? gpuClimate : null,
                resolveToFormat: climateTarget.requiresResolve ? climateTarget.finalFormat : null
            });
        }
    
// ── Prepare splat pass (needs height + tile as inputs) ────
let splatPass = null;
let gpuSplatData = null;
let gpuSplatIndex = null;
let gpuSplatValid = null;
let gpuResolvedColor = null;
let resolvedColorTarget = null;

if (this.enableSplat && requiredTypes.includes('splatData')) {
    const splatFormat = this.textureFormats.splatData || 'rgba8unorm';
    const splatIndexFormat = this.textureFormats.splatIndex || 'rgba8unorm';
    const splatValidFormat = this.textureFormats.splatValid || 'rgba8unorm';

    gpuSplatData = this._createGPUTexture(
        this.textureSize, this.textureSize, splatFormat);
    gpuSplatIndex = this._createGPUTexture(
        this.textureSize, this.textureSize, splatIndexFormat);
    gpuSplatValid = this._createGPUTexture(
        this.textureSize, this.textureSize, splatValidFormat);
    if (requiredTypes.includes('resolvedColor')) {
        const resolvedColorFormat = this.textureFormats.resolvedColor || 'rgba8unorm';
        resolvedColorTarget = this.terrainGen.createStorageBackedOutputTarget(
            this.textureSize, this.textureSize, resolvedColorFormat);
        gpuResolvedColor = resolvedColorTarget.finalTexture;
    }

    if (gpuHeight && gpuTile) {
        const chunksPerAtlas = Math.max(1,
            Math.floor(this.textureSize / this.terrainGen.chunkSize));
        const splatChunkSizeTex = Math.max(1,
            Math.floor(this.textureSize / chunksPerAtlas));
        const atlasTexture = this.textureManager?.getAtlasTexture?.('micro')?._gpuTexture?.texture ?? null;
        const tileTypeLookup = this.textureManager?.getLookupTables?.()?.tileTypeLookup?._gpuTexture?.texture ?? null;
        const geomLOD = this.quadtreeMaxDepth !== null
            ? Math.max(0, Math.min(this.maxGeomLOD ?? 99, this.quadtreeMaxDepth - tileAddr.depth))
            : 2;
        const resolvedColorAtlasSampleLod = geomLOD <= 1 ? 0.0 : 1.0;

        splatPass = {
            heightTex: gpuHeight,
            tileTex: gpuTile,
            heightFormat,
            tileFormat,
            splatTex: gpuSplatData,
            splatIndexTex: gpuSplatIndex,
            splatValidTex: gpuSplatValid,
            textureSize: this.textureSize,
            chunkSizeTex: splatChunkSizeTex,
            resolvedColorTex: resolvedColorTarget?.storageTexture ?? null,
            resolvedColorResolveToTexture: resolvedColorTarget?.requiresResolve ? gpuResolvedColor : null,
            resolvedColorResolveToFormat: resolvedColorTarget?.requiresResolve ? resolvedColorTarget.finalFormat : null,
            atlasTexture,
            tileTypeLookup,
            // Terrain fragment uniforms currently default to season index 0.
            // Keep the prebake on the same canonical season until runtime
            // terrain season transitions are wired through the renderer.
            resolvedColorSeason: 0,
            // Near geometry LODs need the canonical tile sharpness; farther
            // resolved tiles keep a small preblur to avoid distance shimmer.
            resolvedColorAtlasSampleLod
        };
    }
}
    
        // ── Run all passes in a single GPU submission ─────────────
        this.terrainGen.runBatchedTilePasses({
            chunkCoordX: tileAddr.x,
            chunkCoordY: tileAddr.y,
            chunkSizeTex: this.textureSize,
            chunkGridSize: gridSize,
            face: tileAddr.face,
            terrainPasses,
            splatPass
        });

        // Baked flat-tier color from the tile ids just generated (queue order
        // puts this after the tile pass). The pool builds its mip chain on
        // copy, so the terrain shader averages with one filtered sample.
        let gpuCoarseColor = null;
        if (requiredTypes.includes('coarseColor') && gpuTile) {
            gpuCoarseColor = this._runCoarseColorPass(gpuTile, tileAddr);
        }

        if (telemetry) telemetry.computeSubmitted = performance.now();
        // runBatchedTilePasses always submits once for terrainPasses, plus a
        // second, separate submission for the splat pass when present (see
        // _runPaddedQuadtreeSplatPass in webgpuTerrainGeneratorBatching.js) —
        // count both so computeSubmissions reflects actual GPU submissions.
        this._submissionCount += splatPass ? 2 : 1;

        this._gpuFencesInFlight++;
        if (this._gpuFencesInFlight > this._maxGpuFencesObserved) {
            this._maxGpuFencesObserved = this._gpuFencesInFlight;
        }

        const temporaryTextures = [];
        if (gpuHeightBase && !includeBaseHeight) {
            temporaryTextures.push(gpuHeightBase);
        }
        // Final height / tile ids made only as inputs (not requested) were
        // never destroyed before. The splat debug analysis may still read
        // the tile ids of its first few tiles right after the GPU finishes,
        // so these are released slightly later than the other temporaries.
        if (gpuHeight && !requiredTypes.includes('height') && !internalInputs.includes(gpuHeight)) {
            internalInputs.push(gpuHeight);
        }
        if (gpuTile && !requiredTypes.includes('tile') && !internalInputs.includes(gpuTile)) {
            internalInputs.push(gpuTile);
        }
        if (tileTarget?.requiresResolve) {
            temporaryTextures.push(tileTarget.storageTexture);
        }
        if (scatterTarget?.requiresResolve) {
            temporaryTextures.push(scatterTarget.storageTexture);
        }
        if (climateTarget?.requiresResolve) {
            temporaryTextures.push(climateTarget.storageTexture);
        }
        if (resolvedColorTarget?.requiresResolve) {
            temporaryTextures.push(resolvedColorTarget.storageTexture);
        }

        const queue = this.terrainGen?.device?.queue;
        const releaseFence = () => {
            this._gpuFencesInFlight = Math.max(0, this._gpuFencesInFlight - 1);
        };
        const finalizeTelemetry = () => {
            if (!telemetry) return;
            telemetry.gpuFenceComplete = performance.now();
            this.onGenerationTelemetry?.(telemetry);
        };
        if (queue?.onSubmittedWorkDone) {
            queue.onSubmittedWorkDone()
                .then(() => {
                    releaseFence();
                    finalizeTelemetry();
                    for (const tempTex of temporaryTextures) {
                        if (!tempTex) continue;
                        try { tempTex.destroy(); } catch { /* ignore cleanup failure */ }
                    }
                    if (internalInputs.length > 0) {
                        setTimeout(() => {
                            for (const tex of internalInputs) {
                                try { tex.destroy(); } catch { /* ignore cleanup failure */ }
                            }
                        }, 1000);
                    }
                })
                .catch(() => { releaseFence(); finalizeTelemetry(); });
        } else {
            releaseFence();
            finalizeTelemetry();
        }

        // ── Wrap GPU textures ─────────────────────────────────────
        if (requiredTypes.includes('height') && gpuHeight) {
            textures.height = this._wrapGPUTexture(
                gpuHeight, this.textureSize, heightFormat, true);
        }
        if (includeBaseHeight && gpuHeightBase) {
            textures.baseHeight = this._wrapGPUTexture(
                gpuHeightBase, this.textureSize, heightFormat, true);
        }
        if (requiredTypes.includes('normal') && gpuNormal) {
            textures.normal = this._wrapGPUTexture(
                gpuNormal, this.textureSize, normalFormat, false);
        }
        if (requiredTypes.includes('tile') && gpuTile) {
            textures.tile = this._wrapGPUTexture(
                gpuTile, this.textureSize, tileFormat, true);
        }
        if (requiredTypes.includes('macro') && gpuMacro) {
            textures.macro = this._wrapGPUTexture(
                gpuMacro, this.textureSize, macroFormat, false);
        }
        if (requiredTypes.includes('splatData') && gpuSplatData) {
            textures.splatData = this._wrapGPUTexture(
                gpuSplatData, this.textureSize, this.textureFormats.splatData || 'rgba8unorm', true
            );
        }
        if (requiredTypes.includes('splatData') && gpuSplatIndex) {
            textures.splatIndex = this._wrapGPUTexture(
                gpuSplatIndex, this.textureSize, this.textureFormats.splatIndex || 'rgba8unorm', true
            );
        }
        if (requiredTypes.includes('splatValid') && gpuSplatValid) {
            textures.splatValid = this._wrapGPUTexture(
                gpuSplatValid, this.textureSize, this.textureFormats.splatValid || 'rgba8unorm', true
            );
        }
        if (requiredTypes.includes('resolvedColor') && gpuResolvedColor) {
            textures.resolvedColor = this._wrapGPUTexture(
                gpuResolvedColor, this.textureSize, this.textureFormats.resolvedColor || 'rgba8unorm', false
            );
        }

        if (gpuScatter) {
            textures.scatter = this._wrapGPUTexture(
                gpuScatter, this.textureSize, scatterFormat, true);
        }
        if (gpuClimate) {
            textures.climate = this._wrapGPUTexture(
                gpuClimate, this.textureSize, climateFormat, false);
        }
        if (gpuCoarseColor) {
            textures.coarseColor = this._wrapGPUTexture(
                gpuCoarseColor, this.textureSize, 'rgba8unorm', false);
        }
    
        // ── Update stats ──────────────────────────────────────────
        if (trackStats) {
            const elapsed = performance.now() - startTime;
            this._stats.totalGenerated++;
            this._stats.totalTimeMs += elapsed;
    
            if (!this._stats.byDepth.has(tileAddr.depth)) {
                this._stats.byDepth.set(tileAddr.depth, { count: 0, totalMs: 0 });
            }
            const depthStats = this._stats.byDepth.get(tileAddr.depth);
            depthStats.count++;
            depthStats.totalMs += elapsed;
        }
    
        return textures;
    }
    /**
     * Create a GPU-only texture (no CPU-side data).
     */
    // Flat (solid-tier) color per texel: the same 8x8 jittered window
    // average of category colors that the terrain shader used to compute
    // per pixel (sampleChunkAverageCoarseColorLegacy), evaluated once per
    // texel here instead — same window in metres, same jitter seed (world
    // position), same clamping at the tile edge — so the shader reads it with
    // one bilinear sample. Category colors come from the same WGSL function
    // as the shader (buildCoarseCategoryColorFragmentWGSL with the same
    // categories and atlas average colors).
    _runCoarseColorPass(tileTexture, tileAddr) {
        const device = this.terrainGen?.device;
        if (!device || !this.tileCategories) return null;
        if (!this._coarseColorPipeline) {
            const averageColors = this.textureManager?.getCategoryAverageColorMap?.(this.tileCategories) || null;
            const code = `
${buildCoarseCategoryColorFragmentWGSL(this.tileCategories, averageColors)}

struct CoarseBakeParams {
    windowUV: f32,
    tileX: f32,
    tileY: f32,
    tileUVSize: f32,
    faceSize: f32,
    _pad0: f32,
    _pad1: f32,
    _pad2: f32,
};

@group(0) @binding(0) var tileIds: texture_2d<f32>;
@group(0) @binding(1) var outColor: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> params: CoarseBakeParams;

const GRID: i32 = 8;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let size = textureDimensions(outColor);
    if (gid.x >= size.x || gid.y >= size.y) { return; }
    let maxCoord = vec2<i32>(textureDimensions(tileIds)) - vec2<i32>(1);
    // Tile textures are vertex-aligned: texel i sits at tile UV i/(size-1).
    let denom = max(f32(size.x) - 1.0, 1.0);
    let center = vec2<f32>(gid.xy) / denom;
    let worldPos = (vec2<f32>(params.tileX, params.tileY) + center) * params.tileUVSize * params.faceSize;
    var colorSum = vec3<f32>(0.0);
    for (var gy: i32 = 0; gy < GRID; gy = gy + 1) {
        for (var gx: i32 = 0; gx < GRID; gx = gx + 1) {
            let cellCenter = (vec2<f32>(f32(gx), f32(gy)) + vec2<f32>(0.5, 0.5)) / f32(GRID) - vec2<f32>(0.5, 0.5);
            let jitterSeed = worldPos * 0.173 + vec2<f32>(f32(gx) * 12.9898, f32(gy) * 78.233);
            let jx = fract(sin(dot(jitterSeed, vec2<f32>(12.9898, 78.233))) * 43758.5453) - 0.5;
            let jy = fract(sin(dot(jitterSeed, vec2<f32>(39.346, 11.135))) * 24634.6345) - 0.5;
            let sampleUV = center + (cellCenter + vec2<f32>(jx, jy) * 0.5) * params.windowUV;
            let coord = clamp(vec2<i32>(floor(sampleUV * denom + 0.5)), vec2<i32>(0), maxCoord);
            let s = textureLoad(tileIds, coord, 0);
            let tileId = select(s.r * 255.0, s.r, s.r > 1.0);
            colorSum = colorSum + coarseTileColor(tileId);
        }
    }
    textureStore(outColor, vec2<i32>(gid.xy), vec4<f32>(colorSum / f32(GRID * GRID), 1.0));
}
`;
            this._coarseColorPipeline = device.createComputePipeline({
                label: 'CoarseColorBake',
                layout: 'auto',
                compute: { module: device.createShaderModule({ label: 'CoarseColorBake', code }), entryPoint: 'main' }
            });
            this._coarseColorUsesAverageColors = !!averageColors;
            this._coarseColorParams = device.createBuffer({
                label: 'CoarseColorBakeParams',
                size: 32,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
            });
        }
        const gridSize = 1 << tileAddr.depth;
        const faceSize = this.coarseColorFaceSizeMeters;
        const tileMeters = faceSize > 0 ? faceSize / gridSize : 0;
        const windowUV = (this.coarseColorWindowMeters > 0 && tileMeters > 0)
            ? this.coarseColorWindowMeters / tileMeters
            : 0.35;
        device.queue.writeBuffer(this._coarseColorParams, 0, new Float32Array([
            windowUV, tileAddr.x, tileAddr.y, 1 / gridSize, faceSize, 0, 0, 0
        ]));
        const out = this._createGPUTexture(this.textureSize, this.textureSize, 'rgba8unorm');
        const enc = device.createCommandEncoder({ label: 'CoarseColorBake' });
        const pass = enc.beginComputePass({ label: 'CoarseColorBake' });
        pass.setPipeline(this._coarseColorPipeline);
        pass.setBindGroup(0, device.createBindGroup({
            layout: this._coarseColorPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: tileTexture.createView() },
                { binding: 1, resource: out.createView() },
                { binding: 2, resource: { buffer: this._coarseColorParams } }
            ]
        }));
        pass.dispatchWorkgroups(Math.ceil(this.textureSize / 8), Math.ceil(this.textureSize / 8));
        pass.end();
        device.queue.submit([enc.finish()]);
        return out;
    }

    _createGPUTexture(width, height, format) {
        return this.terrainGen.createGPUTexture(width, height, format || 'rgba8unorm');
    }

    /**
     * Wrap a raw GPUTexture in our Texture resource type.
     *
     * @param {GPUTexture} gpuTex
     * @param {number}     size
     * @param {boolean}    useNearest  True for height (no filtering), false otherwise
     * @returns {Texture}
     */
    _wrapGPUTexture(gpuTex, size, format, useNearest) {
        return this.terrainGen.wrapGPUTexture(gpuTex, size, size, format || 'rgba8unorm', useNearest);
    }

    async _debugReadTextureStats(gpuTex, format, sampleSize = 8, threshold = null) {
        const device = this.terrainGen?.device;
        if (!device || !gpuTex) return null;
        const texelBytes = gpuFormatBytesPerTexel(format);
        if (!Number.isFinite(texelBytes) || texelBytes <= 0) return null;

        const size = Math.max(1, Math.min(sampleSize, this.textureSize));
        const bytesPerRow = alignTo(size * texelBytes, 256);
        const bufferSize = bytesPerRow * size;

        const staging = device.createBuffer({
            size: bufferSize,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        });

        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer(
            { texture: gpuTex, origin: { x: 0, y: 0, z: 0 } },
            { buffer: staging, bytesPerRow: bytesPerRow },
            { width: size, height: size, depthOrArrayLayers: 1 }
        );
        device.queue.submit([encoder.finish()]);
        await device.queue.onSubmittedWorkDone();

        await staging.mapAsync(GPUMapMode.READ);
        const buffer = staging.getMappedRange();
        const dv = new DataView(buffer);
        const channels = format.startsWith('rgba') ? 4 : 1;
        const min = new Array(channels).fill(Infinity);
        const max = new Array(channels).fill(-Infinity);
        const sum = new Array(channels).fill(0);
        let nanCount = 0;
        let zeroCount = 0;
        let belowCount = 0;
        let count = 0;

        for (let y = 0; y < size; y++) {
            const rowStart = y * bytesPerRow;
            for (let x = 0; x < size; x++) {
                const offset = rowStart + x * texelBytes;
                const values = readTexel(dv, offset, format);
                count++;
                for (let c = 0; c < channels; c++) {
                    const v = values[c];
                    if (!Number.isFinite(v)) {
                        nanCount++;
                        continue;
                    }
                    if (c === 0 && Math.abs(v) < 1e-6) zeroCount++;
                    if (c === 0 && Number.isFinite(threshold) && v <= threshold) belowCount++;
                    if (v < min[c]) min[c] = v;
                    if (v > max[c]) max[c] = v;
                    sum[c] += v;
                }
            }
        }

        staging.unmap();
        staging.destroy();

        const mean = sum.map(v => (count ? v / count : 0));
        for (let c = 0; c < channels; c++) {
            if (!Number.isFinite(min[c])) { min[c] = 0; max[c] = 0; }
        }

        return {
            format,
            size,
            channels,
            min,
            max,
            mean,
            nanCount,
            zeroCount,
            belowCount,
            belowRatio: count ? (belowCount / count) : 0
        };
    }

    /**
     * Periodic stats log.
     */
    _logStats() {
        const s = this.getStats();
        if (s.totalGenerated === 0) return;

        const depthDetails = Object.entries(s.byDepth)
            .map(([d, stats]) => `d${d}:${stats.count}(${stats.avgMs}ms)`)
            .join(' ');

        Logger.info(
            `[TileGenerator] Total: ${s.totalGenerated} tiles, avg ${s.avgMs} ms/tile | ` +
            `In-progress: ${s.inProgress} | By-depth: ${depthDetails}`
        );
    }
}
