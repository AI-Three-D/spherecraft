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

import { Logger } from '../../config/Logger.js';
import { gpuFormatBytesPerTexel } from '../../renderer/resources/texture.js';

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

        this.terrainGen   = terrainGenerator;
        this.textureSize  = options.textureSize     ?? 1024;
        this.requiredTypes = options.requiredTypes  ?? ['height', 'normal', 'tile'];
        this.enableSplat  = options.enableSplat     ?? this.requiredTypes.includes('splatData');
        this.splatKernelSize = options.splatKernelSize ?? 3;
        this.textureFormats = options.textureFormats ?? {
            height: 'r32float',
            normal: 'rgba32float',
            tile: 'r8unorm',
            macro: 'rgba8unorm',
            splatData: 'rgba8unorm',   // was 'rgba32float'
            scatter: 'r8unorm'
        };

        // Track in-progress generations to avoid duplicate requests
        this._inProgress = new Map();  // tileAddr.toString() -> Promise

        // Stats
        this._stats = {
            totalGenerated: 0,
            totalTimeMs:    0,
            byDepth:        new Map()  // depth -> { count, totalMs }
        };

        this._logFrame    = 0;
        this._logInterval = 300;  // frames between stat logs
    }

    /**
     * Generate all required textures for a tile.
     * Returns a cached promise if generation is already in progress.
     *
     * @param {TileAddress} tileAddr
     * @returns {Promise<object>}  Resolves to { height, normal, tile, macro, splatData }
     *                              Each value is a Texture resource.
     */
    async generateTile(tileAddr) {
        const key = tileAddr.toString();

        // Reuse in-progress generation
        const existing = this._inProgress.get(key);
        if (existing) return existing;
  
        const promise = this._generateTileInternal(tileAddr)
            .finally(() => this._inProgress.delete(key));

        this._inProgress.set(key, promise);
        return promise;
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
        this._logFrame++;
        if (this._logFrame >= this._logInterval) {
            this._logFrame = 0;
            this._logStats();
        }
    }

    async _generateTileInternal(tileAddr) {
        const startTime = performance.now();
    
        const gridSize = 1 << tileAddr.depth;
        const textures = {};
    
        const heightFormat = this.textureFormats.height || 'r32float';
        const normalFormat = this.textureFormats.normal || 'rgba32float';
        const tileFormat = this.textureFormats.tile || 'r8unorm';
        const macroFormat = this.textureFormats.macro || 'rgba8unorm';
        const scatterFormat = this.textureFormats.scatter || 'r8unorm';
    
        const needsFinalHeight =
            this.requiredTypes.includes('height')
            || this.requiredTypes.includes('normal')
            || (this.enableSplat && this.requiredTypes.includes('splatData'))
            || this.requiredTypes.includes('scatter');
        const needsTile = this.requiredTypes.includes('tile') || needsFinalHeight;
        const needsBaseHeight = needsTile;
    
        let gpuHeightBase = null;
        let gpuHeight = null;
        let gpuNormal = null;
        let gpuTile = null;
        let gpuMacro = null;
        let tileTarget = null;
    
        if (needsBaseHeight) {
            gpuHeightBase = this._createGPUTexture(
                this.textureSize, this.textureSize, heightFormat);
        }
        if (needsTile) {
            tileTarget = this.terrainGen.createStorageBackedOutputTarget(
                this.textureSize, this.textureSize, tileFormat);
            gpuTile = tileTarget.finalTexture;
        }
        if (needsFinalHeight) {
            gpuHeight = this._createGPUTexture(
                this.textureSize, this.textureSize, heightFormat);
        }
        if (this.requiredTypes.includes('normal')) {
            gpuNormal = this._createGPUTexture(
                this.textureSize, this.textureSize, normalFormat);
        }
        if (this.requiredTypes.includes('macro')) {
            gpuMacro = this._createGPUTexture(
                this.textureSize, this.textureSize, macroFormat);
        }
    
        // ── Build terrain passes in dependency order ───────────────
        const terrainPasses = [];
        if (gpuHeightBase) {
            terrainPasses.push({
                outputType: 0,
                texture: gpuHeightBase,
                format: heightFormat,
                textureSize: this.textureSize
            });
        }
        if (gpuTile) {
            terrainPasses.push({
                outputType: 2,
                texture: tileTarget.storageTexture,
                format: tileTarget.storageFormat,
                textureSize: this.textureSize,
                heightTexture: gpuHeightBase,
                heightTextureFormat: heightFormat,
                resolveToTexture: tileTarget.requiresResolve ? gpuTile : null,
                resolveToFormat: tileTarget.requiresResolve ? tileTarget.finalFormat : null
            });
        }
        if (gpuHeight) {
            terrainPasses.push({
                outputType: 4,
                texture: gpuHeight,
                format: heightFormat,
                textureSize: this.textureSize,
                heightTexture: gpuHeightBase,
                tileTexture: gpuTile,
                heightTextureFormat: heightFormat,
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
                heightTextureFormat: heightFormat
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
        if (this.requiredTypes.includes('scatter') && gpuHeight && gpuTile) {
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
        if (this.requiredTypes.includes('climate') && gpuHeight && gpuTile) {
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
    
        if (this.enableSplat && this.requiredTypes.includes('splatData')) {
            const splatFormat = this.textureFormats.splatData || 'rgba32float';
            gpuSplatData = this._createGPUTexture(
                this.textureSize, this.textureSize, splatFormat);

            if (gpuHeight && gpuTile) {
                const chunksPerAtlas = Math.max(1,
                    Math.floor(this.textureSize / this.terrainGen.chunkSize));
                const splatChunkSizeTex = Math.max(1,
                    Math.floor(this.textureSize / chunksPerAtlas));

                splatPass = {
                    heightTex: gpuHeight,
                    tileTex: gpuTile,
                    heightFormat,
                    tileFormat,
                    splatTex: gpuSplatData,
                    textureSize: this.textureSize,
                    chunkSizeTex: splatChunkSizeTex
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

        const temporaryTextures = [gpuHeightBase];
        if (tileTarget?.requiresResolve) {
            temporaryTextures.push(tileTarget.storageTexture);
        }
        if (scatterTarget?.requiresResolve) {
            temporaryTextures.push(scatterTarget.storageTexture);
        }
        if (climateTarget?.requiresResolve) {
            temporaryTextures.push(climateTarget.storageTexture);
        }
        // These textures are still referenced by the submitted command buffer.
        // Destroy them only after the queue finishes; immediate destroy can
        // corrupt the tile/tile+height dependent passes.
        const queue = this.terrainGen?.device?.queue;
        if (queue?.onSubmittedWorkDone) {
            queue.onSubmittedWorkDone()
                .then(() => {
                    for (const tempTex of temporaryTextures) {
                        if (!tempTex) continue;
                        try { tempTex.destroy(); } catch {}
                    }
                })
                .catch(() => {});
        }
    
        // ── Wrap GPU textures ─────────────────────────────────────
        if (this.requiredTypes.includes('height') && gpuHeight) {
            textures.height = this._wrapGPUTexture(
                gpuHeight, this.textureSize, heightFormat, true);
        }
        if (this.requiredTypes.includes('normal') && gpuNormal) {
            textures.normal = this._wrapGPUTexture(
                gpuNormal, this.textureSize, normalFormat, false);
        }
        if (this.requiredTypes.includes('tile') && gpuTile) {
            textures.tile = this._wrapGPUTexture(
                gpuTile, this.textureSize, tileFormat, true);
        }
        if (this.requiredTypes.includes('macro') && gpuMacro) {
            textures.macro = this._wrapGPUTexture(
                gpuMacro, this.textureSize, macroFormat, false);
        }
        if (gpuSplatData) {
            const splatFormat = this.textureFormats.splatData || 'rgba32float';
            textures.splatData = this._wrapGPUTexture(
                gpuSplatData, this.textureSize, splatFormat, false);
        }
        if (gpuScatter) {
            textures.scatter = this._wrapGPUTexture(
                gpuScatter, this.textureSize, scatterFormat, true);
        }
        if (gpuClimate) {
            textures.climate = this._wrapGPUTexture(
                gpuClimate, this.textureSize, climateFormat, false);
        }
    
        // ── Update stats ──────────────────────────────────────────
        const elapsed = performance.now() - startTime;
        this._stats.totalGenerated++;
        this._stats.totalTimeMs += elapsed;
    
        if (!this._stats.byDepth.has(tileAddr.depth)) {
            this._stats.byDepth.set(tileAddr.depth, { count: 0, totalMs: 0 });
        }
        const depthStats = this._stats.byDepth.get(tileAddr.depth);
        depthStats.count++;
        depthStats.totalMs += elapsed;
    
        return textures;
    }
    /**
     * Create a GPU-only texture (no CPU-side data).
     */
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
            [size, size, 1]
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
