// js/world/quadtree/tileStreamer.js
//
// CPU-side streaming for GPU quadtree tiles:
//   - reads feedback buffer
//   - schedules tile generation
//   - copies generated textures into array layers
//   - updates the GPU residency hash table
//
// Changes vs. original:
//   - _uploadFullHashTable replaced with _uploadDirtyHashSlots: maintains a
//     Set of dirty slot indices and uploads only the 16-byte entries that
//     actually changed.  Falls back to a full upload if the dirty set
//     exceeds 25 % of capacity (at that point a single writeBuffer is
//     cheaper than many small ones).
class FeedbackDedupeSet {
    constructor(capacity) {
        // Round up to power of 2 for fast masking
        let cap = 16;
        while (cap < capacity * 2) cap <<= 1;
        this.capacity = cap;
        this.mask = cap - 1;
        // Each slot: 2 u32 (keyLo, keyHi). Empty = 0xFFFFFFFF in keyHi.
        this.data = new Uint32Array(cap * 2);
        this.count = 0;
    }

    clear() {
        this.data.fill(0xFFFFFFFF);
        this.count = 0;
    }

    _hash(keyLo, keyHi) {
        const h = (Math.imul(keyLo, 1664525) + Math.imul(keyHi, 1013904223)) >>> 0;
        return h & this.mask;
    }

    /** Returns true if the key was newly inserted, false if it already existed. */
    insert(face, depth, x, y) {
        const keyLo = (x & 0xFFFF) | ((y & 0xFFFF) << 16);
        const keyHi = (depth & 0xFFFF) | ((face & 0xFFFF) << 16);

        let idx = this._hash(keyLo, keyHi);
        for (let i = 0; i < this.capacity; i++) {
            const base = idx * 2;
            const hi = this.data[base + 1];
            if (hi === 0xFFFFFFFF) {
                // Empty slot — insert
                this.data[base] = keyLo;
                this.data[base + 1] = keyHi;
                this.count++;
                return true;
            }
            if (hi === keyHi && this.data[base] === keyLo) {
                // Already exists
                return false;
            }
            idx = (idx + 1) & this.mask;
        }
        // Table full (shouldn't happen if sized correctly)
        return false;
    }

    /** Iterate all inserted keys. Callback receives (face, depth, x, y). */
    forEach(callback) {
        for (let i = 0; i < this.capacity; i++) {
            const base = i * 2;
            const keyHi = this.data[base + 1];
            if (keyHi === 0xFFFFFFFF) continue;
            const keyLo = this.data[base];
            const x = keyLo & 0xFFFF;
            const y = (keyLo >>> 16) & 0xFFFF;
            const depth = keyHi & 0xFFFF;
            const face = (keyHi >>> 16) & 0xFFFF;
            callback(face, depth, x, y);
        }
    }
}
import { gpuFormatToWrapperFormat } from '../../renderer/resources/texture.js';
import { MipmapGenerator } from '../../texture/MipmapGenerator.js';
import { gpuFormatBytesPerTexel } from '../../renderer/resources/texture.js';
import { AsyncGenerationQueue } from '../asyncGenerationQueue.js';
import { TileAddress } from './tileAddress.js';
import { TileGenerator } from './tileGenerator.js';
import { TileCache } from './tileCache.js';
import {
    Texture, TextureFormat, TextureFilter, TextureWrap,
    gpuFormatIsFilterable
} from '../../renderer/resources/texture.js';
import { Logger } from '../../config/Logger.js';

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


class TileArrayPool {
    constructor(device, tileSize, capacity, types, formats, mipTypes = null) {
        this.device = device;
        this.tileSize = tileSize;
        this.capacity = capacity;
        this.types = types.slice();
        this.formats = formats || {};
        this.textures = new Map();
        this.wrappers = new Map();
        this.freeLayers = [];

        // Which types get a mip chain. Default: any filterable type that
        // isn't semantically discrete. In practice today: normal.
        // Caller can override explicitly.
        this.mipTypes = new Set(mipTypes || []);
        this.mipLevelCounts = new Map();   // type → mipLevelCount
        this._mipGen = null;               // lazy — only if any type is mipped

        for (var i = 0; i < this.capacity; i++) {
            this.freeLayers.push(i);
        }

        const wantsNearestByType = (type) =>
            type === 'height' || type === 'tile' || type === 'scatter';

        const fullMipCount = Math.floor(Math.log2(tileSize)) + 1;

        for (const type of this.types) {
            const format = this.formats[type] || 'rgba32float';
            const filterable = gpuFormatIsFilterable(format);

            // Auto-enable mips for filterable, non-discrete types when
            // caller didn't specify a mipTypes set.
            const autoMip = mipTypes === null
                && filterable && !wantsNearestByType(type);
            const hasMips = autoMip || this.mipTypes.has(type);
            const mipLevelCount = hasMips ? fullMipCount : 1;
            this.mipLevelCounts.set(type, mipLevelCount);
            if (hasMips) this.mipTypes.add(type);

            let usage = GPUTextureUsage.TEXTURE_BINDING
                      | GPUTextureUsage.COPY_DST
                      | GPUTextureUsage.COPY_SRC;
            if (hasMips) {
                // Needed for render-pass blit into each mip level.
                usage |= GPUTextureUsage.RENDER_ATTACHMENT;
            }

            const gpuTexture = device.createTexture({
                size: [tileSize, tileSize, capacity],
                format,
                mipLevelCount,
                usage
            });
            this.textures.set(type, gpuTexture);

            const useNearest = wantsNearestByType(type) || !filterable;
            // Mip-aware min filter. The wrapper enum is advisory — the
            // actual sampler used by the shader is what matters — but
            // keep it truthful.
            const minFilter = useNearest
                ? TextureFilter.NEAREST
                : (hasMips ? TextureFilter.LINEAR_MIPMAP_LINEAR
                           : TextureFilter.LINEAR);
            const magFilter = useNearest
                ? TextureFilter.NEAREST : TextureFilter.LINEAR;

            const wrap = new Texture({
                width: tileSize,
                height: tileSize,
                depth: capacity,
                format: gpuFormatToWrapperFormat(format),
                minFilter,
                magFilter,
                wrapS: TextureWrap.CLAMP,
                wrapT: TextureWrap.CLAMP,
                generateMipmaps: false   // we do it ourselves, post-copy
            });
            wrap._gpuTexture = {
                texture: gpuTexture,
                view: gpuTexture.createView({ dimension: '2d-array' }),
                format
            };
            wrap._needsUpload = false;
            wrap._isArray = true;
            wrap._isGPUOnly = true;
            wrap._gpuFormat = format;
            wrap._isFilterable = filterable;
            wrap._hasMips = hasMips;
            wrap._mipLevelCount = mipLevelCount;

            this.wrappers.set(type, wrap);
        }

        if (this.mipTypes.size > 0) {
            this._mipGen = new MipmapGenerator(device);
        }

        this._pendingCopies = [];
    }
    queueCopyToLayer(textures, layer) {
        this._pendingCopies.push({ textures, layer });
    }

    flushPendingCopies() {
        const count = this._pendingCopies.length;
        if (count === 0) return 0;
    
        const encoder = this.device.createCommandEncoder({ label: 'QT-TileCopyBatch' });
    
        // Collect layers for post-copy mip generation. Set dedupes
        // in the unlikely case the same layer is queued twice.
        const touchedLayers = new Set();
    
        for (let i = 0; i < count; i++) {
            const { textures, layer } = this._pendingCopies[i];
            touchedLayers.add(layer);
            for (const type of this.types) {
                const src = textures[type]?._gpuTexture?.texture;
                const dst = this.textures.get(type);
                if (!src || !dst) continue;
                // copyTextureToTexture defaults to mipLevel 0 for both
                // sides — exactly what we want; mip generation fills
                // the rest of the chain below.
                encoder.copyTextureToTexture(
                    { texture: src },
                    { texture: dst, origin: { x: 0, y: 0, z: layer } },
                    [this.tileSize, this.tileSize, 1]
                );
            }
        }
    
        // Mip generation happens in the same command buffer after all
        // copies, so ordering is guaranteed without a separate submit.
        if (this._mipGen && touchedLayers.size > 0) {
            const layers = Array.from(touchedLayers);
            for (const type of this.mipTypes) {
                const tex = this.textures.get(type);
                const fmt = this.formats[type] || 'rgba32float';
                const mips = this.mipLevelCounts.get(type);
                if (!tex || mips <= 1) continue;
                this._mipGen.generateArrayLayers(encoder, tex, fmt, layers, mips);
            }
        }
    
        this.device.queue.submit([encoder.finish()]);
        this._pendingCopies.length = 0;
        return count;
    }
    
    allocateLayer() {
        if (this.freeLayers.length > 0) return this.freeLayers.pop();
        return null;
    }

    releaseLayer(layer) {
        this.freeLayers.push(layer);
    }

    getWrapper(type) {
        return this.wrappers.get(type) || null;
    }

    getWrappers() {
        const out = {};
        for (const type of this.types) {
            out[type] = this.wrappers.get(type) || null;
        }
        return out;
    }

    copyTexturesToLayer(textures, layer) {
        const encoder = this.device.createCommandEncoder();
        for (const type of this.types) {
            const src = textures[type]?._gpuTexture?.texture;
            const dst = this.textures.get(type);
            if (!src || !dst) continue;
            encoder.copyTextureToTexture(
                { texture: src },
                { texture: dst, origin: { x: 0, y: 0, z: layer } },
                [this.tileSize, this.tileSize, 1]
            );
        }
        this.device.queue.submit([encoder.finish()]);
    }
}

// ─── TileHashTable ────────────────────────────────────────────────────────────
// Unchanged from original.

class TileHashTable {
    constructor(capacity) {
        this.capacity = nextPow2(capacity);
        this.mask = this.capacity - 1;
        this.entries = new Uint32Array(this.capacity * 4);
        this.clear();
    }

    clear() {
        this.entries.fill(0xFFFFFFFF);
    }

    makeKeyLo(x, y) {
        return (x & 0xFFFF) | ((y & 0xFFFF) << 16);
    }

    makeKeyHi(face, depth) {
        return (depth & 0xFFFF) | ((face & 0xFFFF) << 16);
    } 

    hash(keyLo, keyHi) {
        const h = (Math.imul(keyLo, 1664525) + Math.imul(keyHi, 1013904223)) >>> 0;
        return h & this.mask;
    }

    findSlot(keyLo, keyHi) {
        let idx = this.hash(keyLo, keyHi);
        for (var i = 0; i < this.capacity; i++) {
            const base = idx * 4;
            const hi = this.entries[base + 1];
            if (hi === 0xFFFFFFFF) return -1;
            if (hi === keyHi && this.entries[base] === keyLo) return idx;
            idx = (idx + 1) & this.mask;
        }
        return -1;
    }

    insert(keyLo, keyHi, layer) {
        let idx = this.hash(keyLo, keyHi);
        for (var i = 0; i < this.capacity; i++) {
            const base = idx * 4;
            const hi = this.entries[base + 1];
            if (hi === 0xFFFFFFFF || (hi === keyHi && this.entries[base] === keyLo)) {
                this.entries[base]     = keyLo;
                this.entries[base + 1] = keyHi;
                this.entries[base + 2] = layer >>> 0;
                this.entries[base + 3] = 0;
                return idx;
            }
            idx = (idx + 1) & this.mask;
        }
        return -1;
    }

    remove(keyLo, keyHi) {
        const slot = this.findSlot(keyLo, keyHi);
        if (slot < 0) return -1;

        const emptyBase = slot * 4;
        this.entries[emptyBase]     = 0xFFFFFFFF;
        this.entries[emptyBase + 1] = 0xFFFFFFFF;
        this.entries[emptyBase + 2] = 0xFFFFFFFF;
        this.entries[emptyBase + 3] = 0xFFFFFFFF;

        // Rehash the cluster that follows
        let idx = (slot + 1) & this.mask;
        for (var i = 0; i < this.capacity; i++) {
            const base = idx * 4;
            const hi = this.entries[base + 1];
            if (hi === 0xFFFFFFFF) break;
            const lo    = this.entries[base];
            const layer = this.entries[base + 2];
            this.entries[base]     = 0xFFFFFFFF;
            this.entries[base + 1] = 0xFFFFFFFF;
            this.entries[base + 2] = 0xFFFFFFFF;
            this.entries[base + 3] = 0xFFFFFFFF;
            this.insert(lo, hi, layer);
            idx = (idx + 1) & this.mask;
        }

        return slot;
    }
}

// ─── TileStreamer ─────────────────────────────────────────────────────────────

export class TileStreamer {

    constructor(device, terrainGenerator, quadtreeGPU, options = {}) {
        this.device = device;
        this._aoCommitQueue = [];
        this._scatterCommitQueue = [];
        this._externalArrayTextures = null;
        this.terrainGenerator = terrainGenerator;
        this.quadtreeGPU = quadtreeGPU;
        this._lastVisibleTilesList = null;  
        this.tileTextureSize = options.tileTextureSize ?? 1024;
        this.requiredTypes   = options.requiredTypes   ?? ['height', 'normal', 'tile'];
        this.enableSplat     = options.enableSplat     ?? this.requiredTypes.includes('splatData');
        this.textureFormats  = options.textureFormats  ?? {
            height: 'r32float', normal: 'rgba32float', tile: 'r8unorm',
            macro: 'rgba8unorm', splatData: 'rgba8unorm', scatter: 'r8unorm'  // was 'rgba32float'
        };
        this.tilePoolSize      = options.tilePoolSize      ?? 2048;
        this.maxPoolBytes      = Number.isFinite(options.maxPoolBytes)
            ? Math.max(16 * 1024 * 1024, Math.floor(options.maxPoolBytes))
            : 512 * 1024 * 1024;
        this.tileHashCapacity  = options.tileHashCapacity  ?? (this.tilePoolSize * 2);
        this.maxFeedback       = options.maxFeedback       ?? 4096;
        this.queueConfig       = options.queueConfig       ?? {};

        const maxLayers = this.device.limits?.maxTextureArrayLayers ?? this.tilePoolSize;
        let layerSetBytes = 0;
        for (const type of this.requiredTypes) {
            const format = this.textureFormats[type] || 'rgba32float';
            layerSetBytes += this.tileTextureSize * this.tileTextureSize *
                             gpuFormatBytesPerTexel(format);
        }
        const maxLayersByBudget = Math.max(1, Math.floor(this.maxPoolBytes / Math.max(layerSetBytes, 1)));
        const clampedPool = Math.min(this.tilePoolSize, maxLayers, maxLayersByBudget);
        if (clampedPool !== this.tilePoolSize) {
            Logger.warn(
                `[TileStreamer] Clamping tilePoolSize ${this.tilePoolSize} → ${clampedPool} ` +
                `(budget ${(this.maxPoolBytes / 1024 / 1024).toFixed(0)}MB)`
            );
        }
        this.tilePoolSize = clampedPool;

        this.arrayPool = null;
        this.tileCache = null;
        this.hashTable = null;
        this.enableTileCacheBridge = options.enableTileCacheBridge === true;

        this._tileInfo    = new Map();   // keyStr → { layer, depth, keyLo, keyHi, slot, lastUsed }
        this._layerToKey  = new Map();
        this._protectedKeys = new Set();

        // ── Dirty-slot tracking for incremental hash uploads ────────────
        // Each element is a slot index into hashTable.entries.
        this._dirtySlots = new Set();
        this._dirtySortBuffer = null;  // Created in initialize()

        this._feedbackReadbackInterval = options.feedbackReadbackInterval ?? 1;
        this._feedbackRingSize = Math.max(1, options.feedbackReadbackRingSize ?? 3);
        this._feedbackRing = [];            // Created in initialize()
        this._feedbackRingWriteIndex = 0;
        this._feedbackFrameCounter = 0;


        this._feedbackDedupeSet = null;  // Created in initialize()

        this._pendingDestructions   = [];
        this._destructionDelayFrames = 3;
        this._pendingCopyTextures = [];

        this._generationQueue = new AsyncGenerationQueue({
            maxInFlight:     options.queueConfig?.maxConcurrentTasks  ?? 12,
            maxPerFrame:     options.queueConfig?.maxStartsPerFrame   ?? 6,
            timeBudgetMs:    options.queueConfig?.timeBudgetMs        ?? 6,
            maxQueueSize:    options.queueConfig?.maxQueueSize        ?? 2048,
            minStartIntervalMs: options.queueConfig?.minStartIntervalMs ?? 0
        });
        this._generationEpoch = 0;
    }
    /**
 * Register an externally-owned array texture to be returned alongside the
 * tile pool textures from getArrayTextures(). Lets systems like the AO
 * baker slot their output into the terrain material without teaching
 * TileStreamer about AO specifically.
 */
setExternalArrayTexture(name, wrapper) {
    if (!this._externalArrayTextures) this._externalArrayTextures = {};
    this._externalArrayTextures[name] = wrapper;
}

/**
 * Drain the tile-commit queue. Returns an array of
 * {face, depth, x, y, layer} for every tile that committed since the
 * last drain. Caller takes ownership of the returned array.
 */
drainAOCommitQueue() {
    if (this._aoCommitQueue.length === 0) return null;
    const q = this._aoCommitQueue;
    this._aoCommitQueue = [];
    return q;
}

drainScatterCommitQueue() {
    if (this._scatterCommitQueue.length === 0) return null;
    const q = this._scatterCommitQueue;
    this._scatterCommitQueue = [];
    return q;
}
    // ── Lifecycle ───────────────────────────────────────────────────────────

    async initialize() {
        if (!this.terrainGenerator) {
            throw new Error('TileStreamer: terrainGenerator is required');
        }

        this.arrayPool = new TileArrayPool(
            this.device, this.tileTextureSize, this.tilePoolSize,
            this.requiredTypes, this.textureFormats
        );

        if (this.enableTileCacheBridge) {
            this.tileCache = new TileCache({ maxBytes: Number.MAX_SAFE_INTEGER, requiredTypes: this.requiredTypes });
        }

        this.hashTable = new TileHashTable(
            this.quadtreeGPU?.getLoadedTileTableCapacity?.() || this.tileHashCapacity
        );
        // First frame: upload the fully-cleared table
        this._uploadFullHashTable();

        this.tileGenerator = new TileGenerator(this.terrainGenerator, {
            textureSize:    this.tileTextureSize,
            requiredTypes:  this.requiredTypes,
            textureFormats: this.textureFormats,
            enableSplat:    this.enableSplat
        });

        this._seedRootTiles();
        this._createFeedbackRing();
        // Create reusable dedupe set for feedback processing (allocation-free)
        this._feedbackDedupeSet = new FeedbackDedupeSet(this.maxFeedback);

        // Pre-allocate sort buffer for batched hash uploads
        this._dirtySortBuffer = new Uint32Array(Math.min(this.hashTable.capacity, 4096));
    }

    _seedRootTiles() {
        for (let face = 0; face < 6; face++) {
            for (let depth = 0; depth <= 2; depth++) {
                const gridSize = 1 << depth;
                for (let y = 0; y < gridSize; y++) {
                    for (let x = 0; x < gridSize; x++) {
                        const addr = new TileAddress(face, depth, x, y);
                        if (this._tileInfo.has(addr.toString())) continue;
                        if (this.tileGenerator.isGenerating(addr)) continue;
                        this._queueTile(addr);
                    }
                }
            }
        }
    }
    _createFeedbackRing() {
        const feedbackBytes = this.maxFeedback * 16;
        this._feedbackRing = [];
        for (let i = 0; i < this._feedbackRingSize; i++) {
            this._feedbackRing.push({
                feedbackStaging: this.device.createBuffer({
                    label: `QT-FeedbackStaging-${i}`,
                    size: feedbackBytes,
                    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
                }),
                metaStaging: this.device.createBuffer({
                    label: `QT-MetaStaging-${i}`,
                    size: 4,
                    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
                }),
                state: 'idle'   // 'idle' | 'copying' | 'mapping'
            });
        }
    }
    // ── Per-frame ───────────────────────────────────────────────────────────


    getArrayTextures() {
        const base = this.arrayPool ? this.arrayPool.getWrappers() : {};
        if (!this._externalArrayTextures) return base;
        return { ...base, ...this._externalArrayTextures };
    }

    tick() {
        this.tickFlush();
        this.tickGeneration();
    }

    resetTiles({ reseedRootTiles = true } = {}) {
        this._generationEpoch++;
        this._generationQueue.clearPending?.(null);

        if (this.arrayPool?._pendingCopies) {
            this.arrayPool._pendingCopies.length = 0;
        }

        if (this.tileCache?.clear) {
            this.tileCache.clear();
        }

        for (const info of this._tileInfo.values()) {
            this.arrayPool?.releaseLayer?.(info.layer);
        }

        this._tileInfo.clear();
        this._layerToKey.clear();
        this._aoCommitQueue = [];
        this._scatterCommitQueue = [];
        this._pendingCopyTextures = [];
        this._lastVisibleTilesList = null;
        this._lastVisibleReadbackTime = 0;
        this._lastVisibleKeySet?.clear?.();
        this._prevVisibleKeySet?.clear?.();
        this._protectedKeys?.clear?.();
        this._recentlyExitedKeys?.clear?.();
        this._recentEvictions?.clear?.();
        this._feedbackDedupeSet?.clear?.();

        if (this.hashTable) {
            this.hashTable.clear();
            this._dirtySlots.clear();
            this._uploadFullHashTable();
        }

        if (reseedRootTiles) {
            this._seedRootTiles();
        }
    }

    /** Flush completed work: texture copies, hash uploads, deferred destructions. */
    tickFlush() {
        if (!this._evictFeedbackFrame) this._evictFeedbackFrame = 0;
        this._evictFeedbackFrame++;
        if (this._evictFeedbackFrame % 300 === 0 && this._evictFeedbackStats?.count > 0) {
            const s = this._evictFeedbackStats;
            Logger.warn(
                `[QT-Stitch-EvictFeedback] Summary: evict→feedback events=${s.count} ` +
                `avgAgeMs=${(s.totalAgeMs / s.count).toFixed(0)} ` +
                `minMs=${s.minAgeMs.toFixed(0)} maxMs=${s.maxAgeMs.toFixed(0)}`
            );
            // Reset for next window
            this._evictFeedbackStats = { count: 0, totalAgeMs: 0, minAgeMs: Infinity, maxAgeMs: 0 };
        }
        // H1: Pipeline race periodic stats
        if (!this._pipelineRaceStatsFrame) this._pipelineRaceStatsFrame = 0;
        this._pipelineRaceStatsFrame++;
        if (this._pipelineRaceStatsFrame % 300 === 0 && this._pipelineRaceStats?.total > 0) {
            const s = this._pipelineRaceStats;
            const pctSame = ((s.sameFrame / s.total) * 100).toFixed(1);
            const pctNext = ((s.nextFrame / s.total) * 100).toFixed(1);
            const depthStr = Object.entries(s.byDepth)
                .sort((a, b) => +a[0] - +b[0])
                .map(([d, c]) => `d${d}:${c}`)
                .join(' ');
            Logger.warn(
                `[QT-Pipeline-Stats] evict→feedback total=${s.total} ` +
                `sameFrame(<50ms)=${s.sameFrame}(${pctSame}%) ` +
                `nextFrame(50-200ms)=${s.nextFrame}(${pctNext}%) ` +
                `delayed(>200ms)=${s.delayed} ` +
                `byDepth=[${depthStr}]`
            );
            this._pipelineRaceStats = {
                total: 0, sameFrame: 0, nextFrame: 0, delayed: 0, byDepth: {}
            };
        }

        if (this._fallbackEvictStats && this._fallbackEvictStats.total > 0) {
            if (!this._fallbackStatsFrame) this._fallbackStatsFrame = 0;
            this._fallbackStatsFrame++;
            
            if (this._fallbackStatsFrame % 300 === 0) {
                const s = this._fallbackEvictStats;
                const pctWithDeps = ((s.withDependents / s.total) * 100).toFixed(1);
                const avgDeps = s.withDependents > 0 
                    ? (s.totalDependents / s.withDependents).toFixed(1) 
                    : '0';
                
                Logger.warn(
                    `[QT-FallbackEvict-Stats] evictions=${s.total} ` +
                    `withFallbackDependents=${s.withDependents} (${pctWithDeps}%) ` +
                    `avgDependentsWhenPresent=${avgDeps} maxDependents=${s.maxDependents}`
                );
                
                // Reset for next window
                this._fallbackEvictStats = { 
                    total: 0, 
                    withDependents: 0, 
                    totalDependents: 0,
                    maxDependents: 0 
                };
            }
        }
        // H4: Log commits that arrived since last flush (these tiles were
        // CPU-committed but GPU-invisible for at least one full frame)
        if (this._commitsSinceLastFlush > 0) {
            if (!this._commitLagStats) {
                this._commitLagStats = { commits: 0, pendingAtFlush: 0, maxPendingAtFlush: 0 };
            }
            this._commitLagStats.pendingAtFlush += this._commitsSinceLastFlush;
            this._commitLagStats.maxPendingAtFlush = Math.max(
                this._commitLagStats.maxPendingAtFlush, this._commitsSinceLastFlush
            );
            this._commitsSinceLastFlush = 0;
        }
        if (this._pipelineRaceStatsFrame % 300 === 0 && this._commitLagStats?.commits > 0) {
            const cl = this._commitLagStats;
            Logger.warn(
                `[QT-Pipeline-GenLag] commits=${cl.commits} ` +
                `pendingAtFlush=${cl.pendingAtFlush} ` +
                `maxPendingPerFlush=${cl.maxPendingAtFlush} ` +
                `(each was GPU-invisible for ≥1 frame)`
            );
            this._commitLagStats = { commits: 0, pendingAtFlush: 0, maxPendingAtFlush: 0 };
        }

        if (this.arrayPool) {
            const copyCount = this.arrayPool.flushPendingCopies();
            if (copyCount > 0 && this._pendingCopyTextures.length > 0) {
                const textures = this._pendingCopyTextures.flat();
                this._pendingCopyTextures.length = 0;

                const entry = {
                    textures,
                    framesRemaining: this._destructionDelayFrames,
                    fenceResolved: false
                };
                this.device.queue.onSubmittedWorkDone()
                    .then(() => { entry.fenceResolved = true; })
                    .catch(() => { entry.fenceResolved = true; });
                this._pendingDestructions.push(entry);
            }
        }

        if (this._dirtySlots.size > 0) {
            this._uploadDirtyHashSlots();
        }

        this.tileCache?.tick?.();

        // Deferred texture destructions
        if (this._pendingDestructions.length > 0) {
            for (let i = this._pendingDestructions.length - 1; i >= 0; i--) {
                const entry = this._pendingDestructions[i];
                if (entry.fenceResolved === false) continue;
                entry.framesRemaining--;
                if (entry.framesRemaining > 0) continue;
                this._pendingDestructions.splice(i, 1);
                for (const tex of entry.textures) {
                    try { if (tex?._gpuTexture?.texture) tex._gpuTexture.texture.destroy(); } catch (_) {}
                    try { if (typeof tex.dispose === 'function') tex.dispose(); } catch (_) {}
                }
            }
        }
    }

    /** Start new tile generation tasks from the queue. */
    tickGeneration() {
        this._generationQueue.tick();
        this.tileGenerator?.tick?.();
    }

    // ── Feedback ────────────────────────────────────────────────────────────
    beginFeedbackReadback(commandEncoder) {
        if (!commandEncoder) return;

        // Throttle: only initiate readback every N frames
        const interval = this._feedbackReadbackInterval;
        if (interval <= 0) return;
        this._feedbackFrameCounter = (this._feedbackFrameCounter + 1) % interval;
        if (this._feedbackFrameCounter !== 0) return;

        // Find an idle ring slot
        let slot = null;
        for (let i = 0; i < this._feedbackRingSize; i++) {
            const idx = (this._feedbackRingWriteIndex + i) % this._feedbackRingSize;
            if (this._feedbackRing[idx].state === 'idle') {
                slot = this._feedbackRing[idx];
                this._feedbackRingWriteIndex = (idx + 1) % this._feedbackRingSize;
                break;
            }
        }
        if (!slot) return; // All slots in flight — skip this frame

        const metaBuffer     = this.quadtreeGPU.getIndirectArgsBuffer();
        const feedbackBuffer = this.quadtreeGPU.getFeedbackBuffer();
        const feedbackOffset = this.quadtreeGPU.getMetaFeedbackOffsetBytes();
        if (!metaBuffer || !feedbackBuffer) return;

        const feedbackBytes = this.maxFeedback * 16;
        commandEncoder.copyBufferToBuffer(metaBuffer, feedbackOffset, slot.metaStaging, 0, 4);
        commandEncoder.copyBufferToBuffer(feedbackBuffer, 0, slot.feedbackStaging, 0, feedbackBytes);

        slot.state = 'copying';
    }
    resolveFeedbackReadback() {
        for (const slot of this._feedbackRing) {
            if (slot.state !== 'copying') continue;

            slot.state = 'mapping';

            Promise.all([
                slot.metaStaging.mapAsync(GPUMapMode.READ),
                slot.feedbackStaging.mapAsync(GPUMapMode.READ)
            ]).then(() => {
                this._processFeedbackSlot(slot);
            }).catch(() => {
                slot.state = 'idle';
            });
        }
    }
    _processFeedbackSlot(slot) {
        try {
            const countView = new Uint32Array(slot.metaStaging.getMappedRange());
            let count = countView[0] || 0;
            slot.metaStaging.unmap();

            if (count > this.maxFeedback) count = this.maxFeedback;
            if (count === 0) {
                slot.feedbackStaging.unmap();
                slot.state = 'idle';
                return;
            }

            const data = new Uint32Array(slot.feedbackStaging.getMappedRange(0, count * 16));

            // Deduplicate using allocation-free hash set
            this._feedbackDedupeSet.clear();
            for (let i = 0; i < count; i++) {
                const base = i * 4;
                this._feedbackDedupeSet.insert(data[base], data[base + 1], data[base + 2], data[base + 3]);
            }

            slot.feedbackStaging.unmap();
            slot.state = 'idle';

            // Process unique tiles (no string allocation)
            this._feedbackDedupeSet.forEach((face, depth, x, y) => {
                const keyLo = this.hashTable.makeKeyLo(x, y);
                const keyHi = this.hashTable.makeKeyHi(face, depth);
                const slot = this.hashTable.findSlot(keyLo, keyHi);
                if (slot >= 0) return; // Already loaded
            
                // NEW: Check if this requested tile was recently evicted
                const key = this._makeKey(face, depth, x, y);
                if (this._recentEvictions?.has(key)) {
                    const evInfo = this._recentEvictions.get(key);
                    const ageMs = performance.now() - evInfo.evictedAt;

                    if (!this._evictFeedbackStats) {
                        this._evictFeedbackStats = { count: 0, totalAgeMs: 0, minAgeMs: Infinity, maxAgeMs: 0 };
                    }
                    this._evictFeedbackStats.count++;
                    this._evictFeedbackStats.totalAgeMs += ageMs;
                    this._evictFeedbackStats.minAgeMs = Math.min(this._evictFeedbackStats.minAgeMs, ageMs);
                    this._evictFeedbackStats.maxAgeMs = Math.max(this._evictFeedbackStats.maxAgeMs, ageMs);

                    // H1: Frame-pipeline race classification
                    if (!this._pipelineRaceStats) {
                        this._pipelineRaceStats = {
                            total: 0, sameFrame: 0, nextFrame: 0, delayed: 0, byDepth: {}
                        };
                    }
                    this._pipelineRaceStats.total++;
                    if (ageMs < 50) this._pipelineRaceStats.sameFrame++;
                    else if (ageMs < 200) this._pipelineRaceStats.nextFrame++;
                    else this._pipelineRaceStats.delayed++;

                    const d = evInfo.depth;
                    this._pipelineRaceStats.byDepth[d] =
                        (this._pipelineRaceStats.byDepth[d] || 0) + 1;

                    // Log individual same-frame events (< 50ms = under 3 frames at 60fps)
                    if (ageMs < 50) {
                        if (!this._pipelineRaceLogCount) this._pipelineRaceLogCount = 0;
                        if (this._pipelineRaceLogCount < 20) {
                            this._pipelineRaceLogCount++;
                            Logger.warn(
                                `[QT-Pipeline-SameFrame] key=${key} depth=${d} ` +
                                `ageMs=${ageMs.toFixed(1)} (evicted and re-requested within one frame)`
                            );
                        }
                    }

                    // Log first occurrences and periodic summaries
                    if (!this._evictFeedbackLogCount) this._evictFeedbackLogCount = 0;
                    if (this._evictFeedbackLogCount < 20) {
                        this._evictFeedbackLogCount++;
                        Logger.warn(
                            `[QT-EvictFeedback] Evicted tile immediately re-requested: ` +
                            `${key} depth=${depth} ageMs=${ageMs.toFixed(0)} ` +
                            `(eviction count so far: ${this._evictFeedbackStats.count})`
                        );
                    }
                }
            
                const addr = new TileAddress(face, depth, x, y);
                if (this.tileGenerator.isGenerating(addr)) return;
                this._queueTile(addr);
            });
            // Queue missing parents (still needs string keys for _tileInfo lookup,
            // but this is a much smaller set and not per-tile)
            this._queueMissingParentsNumeric();

        } catch (e) {
            slot.state = 'idle';
        }
    }

    _queueMissingParentsNumeric() {
        // Iterate the dedupe set and queue parents up to depth 3
        this._feedbackDedupeSet.forEach((face, depth, x, y) => {
            let d = depth;
            let px = x;
            let py = y;

            while (d > 3) {
                d--;
                px >>>= 1;
                py >>>= 1;

                // Check if parent is already loaded (numeric lookup)
                const keyLo = this.hashTable.makeKeyLo(px, py);
                const keyHi = this.hashTable.makeKeyHi(face, d);
                if (this.hashTable.findSlot(keyLo, keyHi) >= 0) break;

                // Check if already in dedupe set (avoid re-queueing)
                if (!this._feedbackDedupeSet.insert(face, d, px, py)) break;

                const addr = new TileAddress(face, d, px, py);
                if (!this.tileGenerator.isGenerating(addr)) {
                    this._queueTile(addr);
                }
            }
        });
    }
    // ── Tile lifecycle ──────────────────────────────────────────────────────

    _queueTile(tileAddr) {
        const key = tileAddr.toString();
        const depthPriority = 100000 - tileAddr.depth * 500;
        const generationEpoch = this._generationEpoch;
        this._generationQueue.request(key, depthPriority, async () => {
            const textures = await this.tileGenerator.generateTile(tileAddr);
            if (generationEpoch !== this._generationEpoch) {
                this._destroyGeneratedTextures(textures);
                return false;
            }
            await this._commitTile(tileAddr, textures);
            return true;
        });
    }

 // In _evictTile(), add age and visibility logging:
_evictTile(key) {
    const info = this._tileInfo.get(key);
    if (!info) return;

    const now = performance.now();
    
    // NEW: Check if any visible tile would use this as a fallback
    let fallbackDependents = 0;
    let dependentDepths = [];
    
    if (this._lastVisibleTilesList) {
        for (const tile of this._lastVisibleTilesList) {
            // Check if this visible tile's data is loaded
            const visKey = this._makeKey(tile.face, tile.depth, tile.x, tile.y);
            const visInfo = this._tileInfo.get(visKey);
            
            if (visInfo) {
                // Tile has its own data loaded - no fallback needed
                continue;
            }
            
            // Tile needs a fallback - check if evicted tile is an ancestor
            if (tile.face !== info.face) continue;  // Different face, can't be ancestor
            
            // Walk up the ancestor chain from the visible tile
            let d = tile.depth;
            let x = tile.x;
            let y = tile.y;
            
            while (d > info.depth) {
                d--;
                x >>= 1;
                y >>= 1;
            }
            
            // Check if we landed on the evicted tile
            if (d === info.depth) {
                const evictedX = parseInt(key.split(':')[2].split(',')[0]);
                const evictedY = parseInt(key.split(':')[2].split(',')[1]);
                
                if (x === evictedX && y === evictedY) {
                    fallbackDependents++;
                    dependentDepths.push(tile.depth);
                }
            }
        }
    }

    // Log eviction with fallback dependency info
    if (!this._evictFallbackLogCount) this._evictFallbackLogCount = 0;
    if (this._evictFallbackLogCount < 50 || fallbackDependents > 0) {
        this._evictFallbackLogCount++;
        
        const depthHist = {};
        for (const d of dependentDepths) {
            depthHist[d] = (depthHist[d] || 0) + 1;
        }
        const depthStr = Object.entries(depthHist)
            .sort((a, b) => +a[0] - +b[0])
            .map(([d, c]) => `d${d}:${c}`)
            .join(' ');
        
        Logger.warn(
            `[QT-FallbackEvict-Dependency] key=${key} depth=${info.depth} ` +
            `fallbackDependents=${fallbackDependents} ` +
            `dependentDepths=[${depthStr}]`
        );
    }
    
    // Track statistics
    if (!this._fallbackEvictStats) {
        this._fallbackEvictStats = { 
            total: 0, 
            withDependents: 0, 
            totalDependents: 0,
            maxDependents: 0 
        };
    }
    this._fallbackEvictStats.total++;
    if (fallbackDependents > 0) {
        this._fallbackEvictStats.withDependents++;
        this._fallbackEvictStats.totalDependents += fallbackDependents;
        this._fallbackEvictStats.maxDependents = Math.max(
            this._fallbackEvictStats.maxDependents, 
            fallbackDependents
        );
    }
    const age = now - info.lastUsed;
    
    // Check if evicted tile was in the last visible readback
    const wasVisible = this._lastVisibleKeySet?.has(key) ?? false;
    const readbackAge = this._lastVisibleReadbackTime 
        ? (now - this._lastVisibleReadbackTime).toFixed(0) 
        : 'never';

    // Find the LRU score spread: what's the youngest eligible eviction candidate?
    let youngestAge = Infinity;
    let oldestAge = -Infinity;
    let eligibleCount = 0;
    for (const [k, i] of this._tileInfo) {
        if (i.depth <= 2) continue;
        const a = now - i.lastUsed;
        if (a < youngestAge) youngestAge = a;
        if (a > oldestAge) oldestAge = a;
        eligibleCount++;
    }

    if (!this._evictDetailLogCount) this._evictDetailLogCount = 0;
    if (this._evictDetailLogCount < 30 || wasVisible) {
        this._evictDetailLogCount++;
        Logger.warn(
            `[QT-VisMarkD3-EvictDetail] key=${key} depth=${info.depth} ` +
            `age=${age.toFixed(0)}ms wasInReadback=${wasVisible} ` +
            `readbackAge=${readbackAge}ms ` +
            `poolAgeSpread=[${youngestAge.toFixed(0)}..${oldestAge.toFixed(0)}ms] ` +
            `eligible=${eligibleCount}`
        );
    }
    
        if (!this._recentEvictions) this._recentEvictions = new Map();
        this._recentEvictions.set(key, {
            evictedAt: performance.now(),
            depth: info.depth,
            layer: info.layer,
            keyLo: info.keyLo,
            keyHi: info.keyHi
        });
        // Prune old records (keep last 10 seconds)
        const cutoff = performance.now() - 10000;
        for (const [k, v] of this._recentEvictions) {
            if (v.evictedAt < cutoff) this._recentEvictions.delete(k);
        }
    

        if (!this._evictLogCount) this._evictLogCount = 0;
        if (this._evictLogCount < 50 || this._evictLogCount % 100 === 0) {
            this._evictLogCount++;
            Logger.warn(
                `[QT-Stitch-Evict] key=${key} layer=${info.layer} depth=${info.depth} ` +
                `slot=${info.slot} dirtyBefore=${this._dirtySlots.size}`
            );
        }
    
        const slot = this.hashTable.remove(info.keyLo, info.keyHi);
        
        // NEW: Track all affected slots during rehash
        const affectedSlots = new Set();
        if (slot >= 0) {
            affectedSlots.add(slot);
            this._dirtySlots.add(slot);
            
            // Walk the ENTIRE potential cluster, not just until empty
            let idx = (slot + 1) & this.hashTable.mask;
            let rehashCount = 0;
            for (let i = 0; i < this.hashTable.capacity; i++) {
                const base = idx * 4;
                const hi = this.hashTable.entries[base + 1];
                if (hi === 0xFFFFFFFF) break;
                
                // Check if this entry WOULD hash to a slot <= the evicted slot
                const lo = this.hashTable.entries[base];
                const naturalSlot = this.hashTable.hash(lo, hi);
                
                // Entry needs rehash if its natural slot is at or before the gap
                const needsRehash = this._slotInRange(naturalSlot, slot, idx);
                if (needsRehash) {
                    affectedSlots.add(idx);
                    this._dirtySlots.add(idx);
                    rehashCount++;
                }
                idx = (idx + 1) & this.hashTable.mask;
            }
            
            // NEW: Log rehash scope
            if (rehashCount > 0 && this._evictLogCount < 50) {
                Logger.warn(
                    `[QT-Stitch-Evict] Rehash affected ${rehashCount} slots, ` +
                    `dirtyAfter=${this._dirtySlots.size}`
                );
            }
        }
    
        this._tileInfo.delete(key);
        this._layerToKey.delete(info.layer);
        this.arrayPool.releaseLayer(info.layer);
    }


async _commitTile(tileAddr, textures) {
    if (!this.arrayPool) { this._destroyGeneratedTextures(textures); return; }

    const key = tileAddr.toString();
    if (this._tileInfo.has(key)) { this._destroyGeneratedTextures(textures); return; }

    let layer = this.arrayPool.allocateLayer();
    if (layer === null) {
        const evictedKey = this._selectEvictionCandidate();
        if (evictedKey) {
            this._evictTile(evictedKey);
            layer = this.arrayPool.allocateLayer();
        }
    }
    if (layer === null) {
        Logger.warn('[TileStreamer] Pool full, cannot allocate layer');
        this._destroyGeneratedTextures(textures);
        return;
    }

    this.arrayPool.queueCopyToLayer(textures, layer);
    this._destroyGeneratedTextures(textures);

    const keyLo = this.hashTable.makeKeyLo(tileAddr.x, tileAddr.y);
    const keyHi = this.hashTable.makeKeyHi(tileAddr.face, tileAddr.depth);
    const slot  = this.hashTable.insert(keyLo, keyHi, layer);
    if (slot < 0) {
        Logger.warn('[TileStreamer] Hash insert failed');
        this.arrayPool.releaseLayer(layer);
        return;
    }

    this._tileInfo.set(key, {
        layer, depth: tileAddr.depth, keyLo, keyHi, slot,
        lastUsed: performance.now()
    });
    this._layerToKey.set(layer, key);
    this._dirtySlots.add(slot);

    if (!this._commitLagStats) {
        this._commitLagStats = { commits: 0, pendingAtFlush: 0, maxPendingAtFlush: 0 };
    }
    this._commitLagStats.commits++;
    if (!this._commitsSinceLastFlush) this._commitsSinceLastFlush = 0;
    this._commitsSinceLastFlush++;

    // Push BEFORE the tile-cache bridge so even if the bridge throws,
    // the AO queue is consistent with what actually made it into the pool.
    this._aoCommitQueue.push({
        face: tileAddr.face, depth: tileAddr.depth,
        x: tileAddr.x, y: tileAddr.y, layer,
    });
    this._scatterCommitQueue.push({
        face: tileAddr.face, depth: tileAddr.depth,
        x: tileAddr.x, y: tileAddr.y, layer,
    });

    if (this.tileCache && this.enableTileCacheBridge) {
        for (const type of this.requiredTypes) {
            const texture = this.arrayPool.getWrapper(type);
            if (texture && !this.tileCache.has(tileAddr, type)) {
                this.tileCache.set(tileAddr, type, texture, 0);
            }
        }
    }
}

    _selectEvictionCandidate() {
        let bestKey = null, bestScore = -Infinity;
        const now = performance.now();
        for (const [key, info] of this._tileInfo) {
            if (info.depth <= 2) continue; // never evict coarse fallbacks
            if (this._protectedKeys?.has(key)) continue;
            // LRU-only: depth bias here caused high-LOD tiles to churn even when visible.
            const score = (now - info.lastUsed);
            if (score > bestScore) { bestScore = score; bestKey = key; }
        }
        return bestKey;
    }

// In TileStreamer, add a Set to track tiles from the most recent readback
markTilesVisible(tiles) {

    if (!tiles || tiles.length === 0) return;
    const now = performance.now();
        // Store full tile list for fallback analysis
        this._lastVisibleTilesList = tiles;
        this._lastVisibleReadbackTime = now;
    
        
    // NEW: Build a fast lookup of what was visible in this readback
    if (!this._lastVisibleKeySet) this._lastVisibleKeySet = new Set();
    this._lastVisibleKeySet.clear();
    this._protectedKeys.clear();
    this._lastVisibleReadbackTime = now;
    
    for (const tile of tiles) {
        const visibleKey = this._makeKey(tile.face, tile.depth, tile.x, tile.y);
        this._lastVisibleKeySet.add(visibleKey);

        // Protect the visible tile itself if resident.
        if (this._tileInfo.has(visibleKey)) {
            this._protectedKeys.add(visibleKey);
        }

        // Protect the nearest loaded ancestor currently acting as fallback.
        let depth = tile.depth;
        let x = tile.x;
        let y = tile.y;
        while (depth > 0) {
            depth--;
            x >>= 1;
            y >>= 1;
            const ancestorKey = this._makeKey(tile.face, depth, x, y);
            if (!this._tileInfo.has(ancestorKey)) continue;
            this._protectedKeys.add(ancestorKey);
            break;
        }
    }
    
    // H2: Track LOD boundary oscillation — tiles entering/exiting visible set
    if (!this._prevVisibleKeySet) this._prevVisibleKeySet = new Set();

    let entered = 0, exited = 0;
    const oscillating = [];

    for (const key of this._prevVisibleKeySet) {
        if (!this._lastVisibleKeySet.has(key)) {
            exited++;
            if (!this._recentlyExitedKeys) this._recentlyExitedKeys = new Map();
            this._recentlyExitedKeys.set(key, performance.now());
        }
    }
    for (const key of this._lastVisibleKeySet) {
        if (!this._prevVisibleKeySet.has(key)) {
            entered++;
            if (this._recentlyExitedKeys?.has(key)) {
                oscillating.push(key);
            }
        }
    }

    // Prune old recently-exited entries (keep last 5 readbacks worth ~ 500ms)
    if (this._recentlyExitedKeys) {
        const cutoff = performance.now() - 500;
        for (const [k, t] of this._recentlyExitedKeys) {
            if (t < cutoff) this._recentlyExitedKeys.delete(k);
        }
    }

    if (!this._oscillationStats) {
        this._oscillationStats = { readbacks: 0, totalEntered: 0, totalExited: 0, totalOscillating: 0 };
    }
    this._oscillationStats.readbacks++;
    this._oscillationStats.totalEntered += entered;
    this._oscillationStats.totalExited += exited;
    this._oscillationStats.totalOscillating += oscillating.length;

    if (this._oscillationStats.readbacks % 10 === 0) {
        const depthCounts = {};
        for (const key of oscillating) {
            const info = this._tileInfo.get(key);
            if (info) depthCounts[info.depth] = (depthCounts[info.depth] || 0) + 1;
        }
        const depthStr = Object.entries(depthCounts)
            .sort((a, b) => +a[0] - +b[0])
            .map(([d, c]) => `d${d}:${c}`)
            .join(' ');

        if (oscillating.length > 0 || this._oscillationStats.totalOscillating > 0) {
            Logger.warn(
                `[QT-Pipeline-Oscillation] last10: oscillating=${this._oscillationStats.totalOscillating} ` +
                `entered=${this._oscillationStats.totalEntered} exited=${this._oscillationStats.totalExited} ` +
                `thisReadback: oscillating=${oscillating.length} byDepth=[${depthStr}]`
            );
        }
        this._oscillationStats = { readbacks: 0, totalEntered: 0, totalExited: 0, totalOscillating: 0 };
    }

    this._prevVisibleKeySet = new Set(this._lastVisibleKeySet);

    // NEW: Count how many pooled d3 tiles are currently visible
    let d3Total = 0, d3Visible = 0;
    for (const [key, info] of this._tileInfo) {
        if (info.depth !== 3) continue;
        d3Total++;
        if (this._lastVisibleKeySet.has(key)) d3Visible++;
    }


    if (d3Total > 0) {
        Logger.info(
            `[QT-VisMarkD3] depth=3 in pool: ${d3Total}, ` +
            `in visible readback: ${d3Visible}, ` +
            `NOT in readback: ${d3Total - d3Visible}`
        );
    }

    // ... existing lastUsed update logic unchanged ...
    for (const tile of tiles) {
        let { face, depth, x, y } = tile;
        let key = this._makeKey(face, depth, x, y);
        let info = this._tileInfo.get(key);
        if (info) info.lastUsed = now;
        while (depth > 0) {
            depth--; x >>= 1; y >>= 1;
            key = this._makeKey(face, depth, x, y);
            info = this._tileInfo.get(key);
            if (info) info.lastUsed = now;
        }
    }
}

    // Helper: Check if slot is in circular range [start, end)
    _slotInRange(slot, start, end) {
        if (start <= end) {
            return slot >= start && slot < end;
        }
        // Wrapped around
        return slot >= start || slot < end;
    }
    _uploadDirtyHashSlots() {
        const buffer = this.quadtreeGPU?.getLoadedTileTableBuffer?.();
        if (!buffer) return;
    
        const dirtyCount = this._dirtySlots.size;
        if (dirtyCount === 0) return;
    
        // NEW: Log upload statistics
        if (!this._uploadStats) {
            this._uploadStats = { total: 0, batched: 0, full: 0, maxDirty: 0 };
        }
        this._uploadStats.total++;
        this._uploadStats.maxDirty = Math.max(this._uploadStats.maxDirty, dirtyCount);
    
        const FULL_UPLOAD_THRESHOLD = this.hashTable.capacity * 0.25;
    
        if (dirtyCount > FULL_UPLOAD_THRESHOLD) {
            this._uploadStats.full++;
            
            // NEW: Log when falling back to full upload
            if (this._uploadStats.full % 10 === 1) {
                Logger.warn(
                    `[QT-Stitch-Hash] Full upload triggered: dirty=${dirtyCount}/${this.hashTable.capacity} ` +
                    `(${(dirtyCount / this.hashTable.capacity * 100).toFixed(1)}%) ` +
                    `fullUploads=${this._uploadStats.full}/${this._uploadStats.total}`
                );
            }
            
            this.device.queue.writeBuffer(buffer, 0, this.hashTable.entries);
            this._dirtySlots.clear();
            return;
        }
    
        this._uploadStats.batched++;
        // Grow sort buffer if needed (rare one-time reallocation)
        if (this._dirtySortBuffer.length < dirtyCount) {
            this._dirtySortBuffer = new Uint32Array(dirtyCount * 2);
        }

        // Copy dirty slots into sort buffer, filtering invalid indices
        let validCount = 0;
        for (const slot of this._dirtySlots) {
            if (slot >= 0 && slot < this.hashTable.capacity) {
                this._dirtySortBuffer[validCount++] = slot;
            }
        }
        this._dirtySlots.clear();

        if (validCount === 0) return;

        // Sort to find contiguous runs
        const sorted = this._dirtySortBuffer.subarray(0, validCount);
        sorted.sort();

        // Upload each contiguous run as a single writeBuffer call
        let runStart = 0;
        for (let i = 1; i <= validCount; i++) {
            if (i < validCount && sorted[i] === sorted[i - 1] + 1) continue;

            // Run covers sorted[runStart] .. sorted[i-1]
            const firstSlot = sorted[runStart];
            const slotCount = i - runStart;

            this.device.queue.writeBuffer(
                buffer,
                firstSlot * 16,            // destination byte offset in GPU buffer
                this.hashTable.entries.buffer,
                this.hashTable.entries.byteOffset + (firstSlot * 16),
                slotCount * 16
            );

            runStart = i;
        }
    }

    _logHashUploadStats() {
        if (!this._uploadStats || this._uploadStats.total === 0) return;
        
        const s = this._uploadStats;
        Logger.info(
            `[QT-Stitch-Hash] Upload stats: total=${s.total} batched=${s.batched} ` +
            `full=${s.full} (${(s.full / s.total * 100).toFixed(1)}%) maxDirty=${s.maxDirty}`
        );
    }

    _uploadFullHashTable() {
        const buffer = this.quadtreeGPU?.getLoadedTileTableBuffer?.();
        if (!buffer) {
            Logger.warn('[TileStreamer-T] Cannot upload hash table: buffer not available');
            return;
        }
        
        // ADD THIS: Verify we're writing the right data
        let nonEmpty = 0;
        for (let i = 0; i < this.hashTable.capacity; i++) {
            if (this.hashTable.entries[i * 4 + 1] !== 0xFFFFFFFF) nonEmpty++;
        }
        //Logger.warn('[QT-DIAG] FULL hash upload');
        this.device.queue.writeBuffer(buffer, 0, this.hashTable.entries);

        this._dirtySlots.clear();

        this.quadtreeGPU._createInstanceBindGroup();
    }

    // ── Debug / diagnostics ───────────────────────────────────────────────

    _makeKey(face, depth, x, y) {
        return `f${face}:d${depth}:${x},${y}`;
    }

    getHashTableStats() {
        let totalEntries = 0;
        const byDepth = {};
        const sampleEntries = [];

        for (const [key, info] of this._tileInfo) {
            totalEntries++;
            byDepth[info.depth] = (byDepth[info.depth] || 0) + 1;
            if (sampleEntries.length < 10 && info.depth <= 2) {
                const slot = this.hashTable.findSlot(info.keyLo, info.keyHi);
                sampleEntries.push({ key, depth: info.depth, layer: info.layer,
                    keyLo: info.keyLo, keyHi: info.keyHi, slotFound: slot >= 0, actualSlot: slot });
            }
        }

        const gpuCap  = this.quadtreeGPU?.loadedTableCapacity ?? 0;
        const gpuMask = this.quadtreeGPU?.loadedTableMask     ?? 0;

        return {
            totalEntries, byDepth,
            hashTableCapacity: this.hashTable.capacity,
            hashTableMask:     this.hashTable.mask,
            gpuTableCapacity:  gpuCap,
            gpuTableMask:      gpuMask,
            capacityMatch:     this.hashTable.capacity === gpuCap,
            maskMatch:         this.hashTable.mask      === gpuMask,
            sampleEntries
        };
    }

    debugLookup(face, depth, x, y) {
        const keyLo = this.hashTable.makeKeyLo(x, y);
        const keyHi = this.hashTable.makeKeyHi(face, depth);
        const hash  = this.hashTable.hash(keyLo, keyHi);

        const probePath = [];
        let idx = hash;
        for (let i = 0; i < this.hashTable.capacity; i++) {
            const base = idx * 4;
            const hi   = this.hashTable.entries[base + 1];
            probePath.push({ idx, hi: hi.toString(16), lo: this.hashTable.entries[base].toString(16) });
            if (hi === 0xFFFFFFFF)
                return { found: false, keyLo, keyHi, hash, probePath: probePath.slice(0, 5) };
            if (hi === keyHi && this.hashTable.entries[base] === keyLo)
                return { found: true, layer: this.hashTable.entries[base + 2], keyLo, keyHi, hash, slot: idx, probePath: probePath.slice(0, 5) };
            idx = (idx + 1) & this.hashTable.mask;
        }
        return { found: false, keyLo, keyHi, hash, probePath: probePath.slice(0, 5) };
    }

    async debugReadArrayLayerStats(type, layer, sampleSize = 8, threshold = null) {
        if (!this.arrayPool || layer === null || layer === undefined) return null;
        const texture = this.arrayPool.textures.get(type);
        if (!texture) return null;

        const format = this.textureFormats[type] || this.arrayPool.formats?.[type] || 'rgba32float';
        const texelBytes = gpuFormatBytesPerTexel(format);
        const size = Math.max(1, Math.min(sampleSize, this.tileTextureSize));
        const bytesPerRow = alignTo(size * texelBytes, 256);
        const bufferSize = bytesPerRow * size;

        const staging = this.device.createBuffer({
            size: bufferSize,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        });

        const encoder = this.device.createCommandEncoder();
        encoder.copyTextureToBuffer(
            { texture: texture, origin: { x: 0, y: 0, z: layer } },
            { buffer: staging, bytesPerRow: bytesPerRow },
            [size, size, 1]
        );
        this.device.queue.submit([encoder.finish()]);
        await this.device.queue.onSubmittedWorkDone();

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
            type,
            layer,
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

    async debugReadArrayLayerTexels(type, layer, texelCoords = []) {
        if (!this.arrayPool || layer === null || layer === undefined) return null;
        const texture = this.arrayPool.textures.get(type);
        if (!texture) return null;

        const format = this.textureFormats[type] || this.arrayPool.formats?.[type] || 'rgba32float';
        const texelBytes = gpuFormatBytesPerTexel(format);
        if (!Number.isFinite(texelBytes) || texelBytes <= 0) return null;

        const coords = Array.isArray(texelCoords) ? texelCoords : [];
        const size = this.tileTextureSize;
        const results = [];

        for (const coord of coords) {
            const x = Math.max(0, Math.min(size - 1, Math.floor(coord?.x ?? 0)));
            const y = Math.max(0, Math.min(size - 1, Math.floor(coord?.y ?? 0)));
            const bytesPerRow = 256;
            const bufferSize = bytesPerRow;

            const staging = this.device.createBuffer({
                size: bufferSize,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
            });

            const encoder = this.device.createCommandEncoder();
            encoder.copyTextureToBuffer(
                { texture, origin: { x, y, z: layer } },
                { buffer: staging, bytesPerRow },
                [1, 1, 1]
            );
            this.device.queue.submit([encoder.finish()]);
            await this.device.queue.onSubmittedWorkDone();
            await staging.mapAsync(GPUMapMode.READ);

            const buffer = staging.getMappedRange();
            const dv = new DataView(buffer);
            const values = readTexel(dv, 0, format);
            staging.unmap();
            staging.destroy();

            results.push({ x, y, values });
        }

        return {
            type,
            layer,
            format,
            texels: results
        };
    }

    _destroyGeneratedTextures(textures) {
        const list = [];
        for (const type of Object.keys(textures)) {
            if (textures[type]) list.push(textures[type]);
        }
        if (list.length) {
            if (!this.arrayPool) {
                for (const tex of list) {
                    try { if (tex?._gpuTexture?.texture) tex._gpuTexture.texture.destroy(); } catch (_) {}
                    try { if (typeof tex.dispose === 'function') tex.dispose(); } catch (_) {}
                }
                return;
            }
            this._pendingCopyTextures.push(list);
        }
    }
}
