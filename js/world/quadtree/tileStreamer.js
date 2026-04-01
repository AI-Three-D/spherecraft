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
        // XOR-fold so high-16 fields (y, face) reach low bits before the multiply
        const kl = (keyLo ^ (keyLo >>> 16)) >>> 0;
        const kh = (keyHi ^ (keyHi >>> 16)) >>> 0;
        const h = (Math.imul(kl, 0x9E3779B1) ^ Math.imul(kh, 0x85EBCA77)) >>> 0;
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

const TERRAIN_STEP_LOG_TAG = '[TerrainStep]';
const REQUEST_LATENCY_BUCKET_LIMITS_MS = [50, 100, 200, 500, 1000, Infinity];
const REQUEST_LATENCY_BUCKET_LABELS = ['<50', '50-100', '100-200', '200-500', '500-1000', '1000+'];

function createRequestLatencyWindow() {
    return {
        total: 0,
        maxMs: 0,
        buckets: REQUEST_LATENCY_BUCKET_LABELS.map(() => 0)
    };
}

function createStaleStartWindow() {
    return {
        started: 0,
        stale: 0,
        visible: 0,
        ancestor: 0,
        unknown: 0
    };
}

function createFeedbackWindow() {
    return {
        readbacks: 0,
        raw: 0,
        unique: 0
    };
}

function formatRequestLatencyWindow(window) {
    if (!window || window.total <= 0) {
        return 'none';
    }
    return REQUEST_LATENCY_BUCKET_LABELS
        .map((label, index) => `${label}:${window.buckets[index]}`)
        .join(' ');
}

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
        // XOR-fold so high-16 fields (y, face) reach low bits before the multiply
        const kl = (keyLo ^ (keyLo >>> 16)) >>> 0;
        const kh = (keyHi ^ (keyHi >>> 16)) >>> 0;
        const h = (Math.imul(kl, 0x9E3779B1) ^ Math.imul(kh, 0x85EBCA77)) >>> 0;
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

    remove(keyLo, keyHi, touchedSlots = null) {
        const slot = this.findSlot(keyLo, keyHi);
        if (slot < 0) return -1;

        const emptyBase = slot * 4;
        this.entries[emptyBase]     = 0xFFFFFFFF;
        this.entries[emptyBase + 1] = 0xFFFFFFFF;
        this.entries[emptyBase + 2] = 0xFFFFFFFF;
        this.entries[emptyBase + 3] = 0xFFFFFFFF;
        if (touchedSlots) touchedSlots.push(slot);

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
            if (touchedSlots) touchedSlots.push(idx);
            const newSlot = this.insert(lo, hi, layer);
            if (touchedSlots && newSlot >= 0) touchedSlots.push(newSlot);
            idx = (idx + 1) & this.mask;
        }

        return slot;
    }
}

// ─── TileStreamer ─────────────────────────────────────────────────────────────

export class TileStreamer {

    constructor(device, terrainGenerator, quadtreeGPU, options = {}) {
        this._gpuBackpressureLimit = options.gpuBackpressureLimit ?? 4;
        this._gpuBackpressureSkipCount = 0;
        this._tilesStartedWindowCount = 0;
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
        this._logStatsEnabled  = options.logStats === true;
        this._debugReadbacksEnabled = this._logStatsEnabled;

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
        // Pure inserts can safely upload touched slots only. Any removal can
        // rehash a whole probe cluster, so evictions request a full upload on
        // the next flush instead of trying to mirror the cluster mutation
        // slot-by-slot.
        this._dirtySlots = new Set();
        this._dirtySortBuffer = null;  // Created in initialize()
        this._needsFullHashUpload = false;

        this._feedbackReadbackInterval = options.feedbackReadbackInterval ?? 1;
        this._feedbackRingSize = Math.max(1, options.feedbackReadbackRingSize ?? 3);
        this._feedbackRing = [];            // Created in initialize()
        this._feedbackRingWriteIndex = 0;
        this._feedbackFrameCounter = 0;


        this._feedbackDedupeSet = null;  // Created in initialize()
        this._requestFreshness = new Map();
        this._freshnessSkipThresholdMs = 200;
        this._freshnessMinDepth = 5;


        this._pendingDestructions   = [];
        this._destructionDelayFrames = 3;
        this._pendingCopyTextures = [];
        this._debugCopyStateByLayer = new Map();
        this._debugCopyBatchId = 0;
        this._debugCopyQueueLogCount = 0;
        this._debugCopyFlushLogCount = 0;
        this._debugCopyReadyLogCount = 0;
        this._debugCopyVerifyLogCount = 0;
        this._debugCopyVerifyCaptureCount = 0;
        this._debugVisibleCopyLogCount = 0;
        this._lastCopyVisibilitySummary = null;
        this._generationQueue = new AsyncGenerationQueue({
            maxInFlight:     options.queueConfig?.maxConcurrentTasks  ?? 12,
            maxPerFrame:     options.queueConfig?.maxStartsPerFrame   ?? 6,
            timeBudgetMs:    options.queueConfig?.timeBudgetMs        ?? 6,
            maxQueueSize:    options.queueConfig?.maxQueueSize        ?? 2048,
            minStartIntervalMs: options.queueConfig?.minStartIntervalMs ?? 0,
            shouldDrop: (entry) => {
                // Never drop coarse tiles — they serve as fallbacks
                // Parse depth from key format "f{face}:d{depth}:{x},{y}"
                const dIdx = entry.key.indexOf(':d');
                if (dIdx >= 0) {
                    const colonAfterD = entry.key.indexOf(':', dIdx + 2);
                    const depth = parseInt(entry.key.substring(dIdx + 2, colonAfterD > 0 ? colonAfterD : undefined), 10);
                    if (Number.isFinite(depth) && depth < this._freshnessMinDepth) {
                        return false;
                    }
                }
                const lastSeen = this._requestFreshness.get(entry.key);
                if (!Number.isFinite(lastSeen)) {
                    // Never appeared in feedback — was queued by seed or parent-walk.
                    // Keep it if it's young enough (just queued).
                    return (performance.now() - entry.enqueuedAt) > this._freshnessSkipThresholdMs;
                }
                return (performance.now() - lastSeen) > this._freshnessSkipThresholdMs;
            }
        });
        this._generationEpoch = 0;
        this._requestTimestamps = new Map();
        this._requestLatencyWindow = createRequestLatencyWindow();
        this._staleStartWindow = createStaleStartWindow();
        this._feedbackWindow = createFeedbackWindow();
        this._commitWindowCount = 0;
        this._queueRejectWindowCount = 0;
        this._minFreeLayersSinceLog = Number.POSITIVE_INFINITY;
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
        this._recordPoolHeadroom();

        if (this.enableTileCacheBridge) {
            this.tileCache = new TileCache({
                maxBytes: Number.MAX_SAFE_INTEGER,
                requiredTypes: this.requiredTypes,
                logStats: this._logStatsEnabled
            });
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
            enableSplat:    this.enableSplat,
            logStats:       this._logStatsEnabled
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
        this._requestFreshness.clear();
this._freshnessSkipCount = 0;
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
        this._debugCopyStateByLayer?.clear?.();
        this._lastCopyVisibilitySummary = null;
        this._lastVisibleTilesList = null;
        this._lastVisibleReadbackTime = 0;
        this._lastVisibleKeySet?.clear?.();
        this._prevVisibleKeySet?.clear?.();
        this._protectedKeys?.clear?.();
        this._recentlyExitedKeys?.clear?.();
        this._recentEvictions?.clear?.();
        this._feedbackDedupeSet?.clear?.();
        this._requestTimestamps.clear();
        this._requestLatencyWindow = createRequestLatencyWindow();
        this._staleStartWindow = createStaleStartWindow();
        this._feedbackWindow = createFeedbackWindow();
        this._commitWindowCount = 0;
        this._queueRejectWindowCount = 0;
        this._minFreeLayersSinceLog = Number.POSITIVE_INFINITY;

        if (this.hashTable) {
            this.hashTable.clear();
            this._dirtySlots.clear();
            this._needsFullHashUpload = false;
            this._uploadFullHashTable();
        }

        this._recordPoolHeadroom();

        if (reseedRootTiles) {
            this._seedRootTiles();
        }
    }

    /** Flush completed work: texture copies, hash uploads, deferred destructions. */
    tickFlush() {
        if (!this._evictFeedbackFrame) this._evictFeedbackFrame = 0;
        this._evictFeedbackFrame++;
        if (!this._requestFreshness) this._requestFreshness = new Map();

        if (this._requestFreshness.size > 2048) {
            const cutoff = performance.now() - 2000;
            for (const [k, t] of this._requestFreshness) {
                if (t < cutoff) this._requestFreshness.delete(k);
            }
        }

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
            const flushedCopies = Array.isArray(this.arrayPool._pendingCopies)
                ? this.arrayPool._pendingCopies.slice()
                : [];
            const copyCount = this.arrayPool.flushPendingCopies();
            let copyFencePromise = null;
            if (copyCount > 0) {
                const batchId = ++this._debugCopyBatchId;
                this._debugMarkSubmittedCopies(flushedCopies, batchId);
                copyFencePromise = this.device.queue.onSubmittedWorkDone()
                    .then(() => {
                        this._debugMarkReadyCopies(flushedCopies, batchId);
                        if (this._debugReadbacksEnabled) {
                            return this._debugVerifyCopiedLayers(flushedCopies, batchId);
                        }
                    })
                    .catch(() => {
                        this._debugMarkFailedCopies(flushedCopies, batchId);
                    });
            }
            if (copyCount > 0 && this._pendingCopyTextures.length > 0) {
                const textures = this._pendingCopyTextures.flat();
                this._pendingCopyTextures.length = 0;

                const entry = {
                    textures,
                    framesRemaining: this._destructionDelayFrames,
                    fenceResolved: false
                };
                const resolveFence = () => { entry.fenceResolved = true; };
                if (copyFencePromise) {
                    copyFencePromise.then(resolveFence).catch(resolveFence);
                } else {
                    this.device.queue.onSubmittedWorkDone()
                        .then(resolveFence)
                        .catch(resolveFence);
                }
                this._pendingDestructions.push(entry);
            }
        }

        if (this._needsFullHashUpload || this._dirtySlots.size > 0) {
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
    tickGeneration() {
        // Bound outstanding GPU generation work. Each tile is ~9 ms GPU;
        // without this, movement bursts push the command queue 30+ frames
        // deep and latency spirals to 500+ ms. Budget is the headroom
        // between the limit and the current in-flight fence count.
        const gpuInFlight = this.tileGenerator?._gpuFencesInFlight ?? 0;
        const budget = Math.max(0, this._gpuBackpressureLimit - gpuInFlight);

        if (budget === 0) {
            this._gpuBackpressureSkipCount++;
            this.tileGenerator?.tick?.();
            return;
        }

        // Cap this frame's starts at min(configured max, GPU budget).
        // maxPerFrame is restored immediately so config inspection
        // elsewhere still sees the real value.
        const savedMaxPerFrame = this._generationQueue.maxPerFrame;
        this._generationQueue.maxPerFrame = Math.min(savedMaxPerFrame, budget);
        const spawned = this._generationQueue.tick() || 0;
        this._generationQueue.maxPerFrame = savedMaxPerFrame;

        this._tilesStartedWindowCount += spawned;
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
            this._feedbackWindow.readbacks++;
            this._feedbackWindow.raw += count;
            this._feedbackWindow.unique += this._feedbackDedupeSet.count;

            slot.feedbackStaging.unmap();
            slot.state = 'idle';

            // Process unique tiles (no string allocation)
            this._feedbackDedupeSet.forEach((face, depth, x, y) => {
                const key = this._makeKey(face, depth, x, y);
                
                // Update freshness regardless of whether tile is loaded/generating
                this._requestFreshness.set(key, performance.now());
                
                const keyLo = this.hashTable.makeKeyLo(x, y);
                const keyHi = this.hashTable.makeKeyHi(face, depth);
                const slot = this.hashTable.findSlot(keyLo, keyHi);
                if (slot >= 0) return;
            

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
        this._feedbackDedupeSet.forEach((face, depth, x, y) => {
            let d = depth;
            let px = x;
            let py = y;
    
            while (d > 3) {
                d--;
                px >>>= 1;
                py >>>= 1;
    
                // Refresh parent freshness (child demand implies parent demand)
                this._requestFreshness.set(this._makeKey(face, d, px, py), performance.now());
    
                const keyLo = this.hashTable.makeKeyLo(px, py);
                const keyHi = this.hashTable.makeKeyHi(face, d);
                if (this.hashTable.findSlot(keyLo, keyHi) >= 0) break;
    
                if (!this._feedbackDedupeSet.insert(face, d, px, py)) break;
    
                const addr = new TileAddress(face, d, px, py);
                if (!this.tileGenerator.isGenerating(addr)) {
                    this._queueTile(addr);
                }
            }
        });
    }

    _queueTile(tileAddr) {
        const key = tileAddr.toString();
        if (!this._requestTimestamps.has(key)) {
            this._requestTimestamps.set(key, performance.now());
        }
        
        // Depth component: coarser = higher base priority (fallback safety)
        const depthPriority = 100000 - tileAddr.depth * 500;
        
        // Camera-distance component: approximate screen importance
        // Tiles nearer to camera get priority boost up to 5000
        let distanceBias = 0;
        if (this._lastVisibleTilesList && this._lastVisibleKeySet?.has(key)) {
            distanceBias = 3000; // Currently visible = high priority
        } else if (this._requestFreshness.has(key)) {
            // Recently in feedback = moderate priority
            const age = performance.now() - this._requestFreshness.get(key);
            distanceBias = Math.max(0, 2000 - age * 10); // decays over 200ms
        }
        
        const priority = depthPriority + distanceBias;
        
        const generationEpoch = this._generationEpoch;
        const request = this._generationQueue.request(key, priority, async () => {
    
            const demandState = this._describeTileDemandState(tileAddr, key);
            this._staleStartWindow.started++;
            if (!demandState.relevant) {
                this._staleStartWindow.stale++;
            } else if (demandState.reason === 'visible') {
                this._staleStartWindow.visible++;
            } else if (demandState.reason === 'ancestor') {
                this._staleStartWindow.ancestor++;
            } else {
                this._staleStartWindow.unknown++;
            }
         

            try {
                const textures = await this.tileGenerator.generateTile(tileAddr);
                if (generationEpoch !== this._generationEpoch) {
                    this._requestTimestamps.delete(key);
                    this._destroyGeneratedTextures(textures);
                    return false;
                }
                const committed = await this._commitTile(tileAddr, textures);
                if (!committed) {
                    this._requestTimestamps.delete(key);
                }
                
                return committed;
            } catch (error) {
                this._requestTimestamps.delete(key);
                throw error;
            }
        });
        if (request === null) {
            this._queueRejectWindowCount++;
            this._requestTimestamps.delete(key);
        }
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
    
        const touchedSlots = [];
        this.hashTable.remove(info.keyLo, info.keyHi, touchedSlots);
        for (const s of touchedSlots) {
            this._dirtySlots.add(s);
        }

    
        this._tileInfo.delete(key);
        this._layerToKey.delete(info.layer);
        this._debugCopyStateByLayer.delete(info.layer);
        this.arrayPool.releaseLayer(info.layer);
        this._recordPoolHeadroom();
    }


async _commitTile(tileAddr, textures) {
    if (!this.arrayPool) {
        this._destroyGeneratedTextures(textures);
        return false;
    }

    const key = tileAddr.toString();
    if (this._tileInfo.has(key)) {
        this._destroyGeneratedTextures(textures);
        return false;
    }

    let layer = this.arrayPool.allocateLayer();
    this._recordPoolHeadroom();
    if (layer === null) {
        const evictedKey = this._selectEvictionCandidate();
        if (evictedKey) {
            this._evictTile(evictedKey);
            layer = this.arrayPool.allocateLayer();
            this._recordPoolHeadroom();
        }
    }
    if (layer === null) {
        Logger.warn('[TileStreamer] Pool full, cannot allocate layer');
        this._destroyGeneratedTextures(textures);
        return false;
    }

    this.arrayPool.queueCopyToLayer(textures, layer);
    this._debugRegisterQueuedCopy(tileAddr, layer, textures);
    this._destroyGeneratedTextures(textures);

    const keyLo = this.hashTable.makeKeyLo(tileAddr.x, tileAddr.y);
    const keyHi = this.hashTable.makeKeyHi(tileAddr.face, tileAddr.depth);
    const slot  = this.hashTable.insert(keyLo, keyHi, layer);
    if (slot < 0) {
        Logger.warn('[TileStreamer] Hash insert failed');
        this._debugCopyStateByLayer.delete(layer);
        this.arrayPool.releaseLayer(layer);
        this._recordPoolHeadroom();
        return false;
    }

    this._tileInfo.set(key, {
        layer,
        face: tileAddr.face,
        depth: tileAddr.depth,
        x: tileAddr.x,
        y: tileAddr.y,
        keyLo,
        keyHi,
        slot,
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
    this._commitWindowCount++;
    const requestedAt = this._requestTimestamps.get(key);
    if (Number.isFinite(requestedAt)) {
        this._recordRequestLatency(key, performance.now() - requestedAt);
    }

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
    this._requestFreshness.delete(key);
    return true;
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

    let residentVisible = 0;
    let ownVisibleNotReady = 0;
    let fallbackVisible = 0;
    let fallbackVisibleNotReady = 0;
    const nonReadySamples = [];

    for (const tile of tiles) {
        const visibleKey = this._makeKey(tile.face, tile.depth, tile.x, tile.y);
        const residentInfo = this._tileInfo.get(visibleKey);
        if (residentInfo) {
            residentVisible++;
            const state = this._debugCopyStateByLayer.get(residentInfo.layer);
            if (state && state.state !== 'ready') {
                ownVisibleNotReady++;
                if (nonReadySamples.length < 8) {
                    nonReadySamples.push(
                        `own f${tile.face}:d${tile.depth}:${tile.x},${tile.y}->L${residentInfo.layer}:${state.state}`
                    );
                }
            }
            continue;
        }

        let depth = tile.depth;
        let x = tile.x;
        let y = tile.y;
        while (depth > 0) {
            depth--;
            x >>= 1;
            y >>= 1;
            const ancestorKey = this._makeKey(tile.face, depth, x, y);
            const ancestorInfo = this._tileInfo.get(ancestorKey);
            if (!ancestorInfo) continue;
            fallbackVisible++;
            const state = this._debugCopyStateByLayer.get(ancestorInfo.layer);
            if (state && state.state !== 'ready') {
                fallbackVisibleNotReady++;
                if (nonReadySamples.length < 8) {
                    nonReadySamples.push(
                        `fallback f${tile.face}:d${tile.depth}:${tile.x},${tile.y}->L${ancestorInfo.layer}:${state.state}`
                    );
                }
            }
            break;
        }
    }

    this._lastCopyVisibilitySummary = {
        totalVisible: tiles.length,
        residentVisible,
        ownVisibleNotReady,
        fallbackVisible,
        fallbackVisibleNotReady,
        samples: nonReadySamples,
        timestamp: now
    };

    if (
        ownVisibleNotReady > 0 ||
        fallbackVisibleNotReady > 0 ||
        this._debugVisibleCopyLogCount < 8
    ) {
        this._debugVisibleCopyLogCount++;
        Logger.info(
            `${TERRAIN_STEP_LOG_TAG} [QTCommit] visible-copy-state total=${tiles.length} ` +
            `resident=${residentVisible} ownNotReady=${ownVisibleNotReady} ` +
            `fallbackVisible=${fallbackVisible} fallbackNotReady=${fallbackVisibleNotReady}` +
            `${nonReadySamples.length ? ` samples=${nonReadySamples.join(' ; ')}` : ''}`
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

    _uploadDirtyHashSlots() {
        const buffer = this.quadtreeGPU?.getLoadedTileTableBuffer?.();
        if (!buffer) return;
    
        const dirtyCount = this._dirtySlots.size;
        if (!this._needsFullHashUpload && dirtyCount === 0) return;
    
        // NEW: Log upload statistics
        if (!this._uploadStats) {
            this._uploadStats = { total: 0, batched: 0, full: 0, maxDirty: 0 };
        }
        this._uploadStats.total++;
        this._uploadStats.maxDirty = Math.max(this._uploadStats.maxDirty, dirtyCount);
    
        const FULL_UPLOAD_THRESHOLD = this.hashTable.capacity * 0.25;
    
        if (this._needsFullHashUpload || dirtyCount > FULL_UPLOAD_THRESHOLD) {
            this._uploadStats.full++;
            
            // NEW: Log when falling back to full upload
            if (this._uploadStats.full % 10 === 1) {
                const reason = this._needsFullHashUpload ? 'rehash' : 'dirty-threshold';
                Logger.warn(
                    `[QT-Stitch-Hash] Full upload triggered (${reason}): dirty=${dirtyCount}/${this.hashTable.capacity} ` +
                    `(${(dirtyCount / this.hashTable.capacity * 100).toFixed(1)}%) ` +
                    `fullUploads=${this._uploadStats.full}/${this._uploadStats.total}`
                );
            }
            
            this.device.queue.writeBuffer(buffer, 0, this.hashTable.entries);
            this._dirtySlots.clear();
            this._needsFullHashUpload = false;
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
        this._needsFullHashUpload = false;

        this.quadtreeGPU._createInstanceBindGroup();
    }

    // ── Debug / diagnostics ───────────────────────────────────────────────

    _makeKey(face, depth, x, y) {
        return `f${face}:d${depth}:${x},${y}`;
    }

    _recordPoolHeadroom() {
        const freeLayers = this.arrayPool?.freeLayers?.length;
        if (Number.isFinite(freeLayers)) {
            this._minFreeLayersSinceLog = Math.min(this._minFreeLayersSinceLog, freeLayers);
        }
    }

    _recordRequestLatency(key, latencyMs) {
        const requestedAt = this._requestTimestamps.get(key);
        if (!Number.isFinite(requestedAt) || !Number.isFinite(latencyMs)) {
            this._requestTimestamps.delete(key);
            return;
        }

        const window = this._requestLatencyWindow;
        window.total++;
        window.maxMs = Math.max(window.maxMs, latencyMs);
        let bucketIndex = REQUEST_LATENCY_BUCKET_LIMITS_MS.length - 1;
        for (let i = 0; i < REQUEST_LATENCY_BUCKET_LIMITS_MS.length; i++) {
            if (latencyMs < REQUEST_LATENCY_BUCKET_LIMITS_MS[i]) {
                bucketIndex = i;
                break;
            }
        }
        window.buckets[bucketIndex]++;
        this._requestTimestamps.delete(key);
    }

    _describeTileDemandState(tileAddr, key = tileAddr?.toString?.()) {
        if (!tileAddr || !this._lastVisibleKeySet || !this._lastVisibleTilesList) {
            return { relevant: true, reason: 'unknown' };
        }

        if (key && this._lastVisibleKeySet.has(key)) {
            return { relevant: true, reason: 'visible' };
        }

        for (const visibleTile of this._lastVisibleTilesList) {
            if (!visibleTile || visibleTile.face !== tileAddr.face || visibleTile.depth < tileAddr.depth) {
                continue;
            }

            let depth = visibleTile.depth;
            let x = visibleTile.x;
            let y = visibleTile.y;
            while (depth > tileAddr.depth) {
                depth--;
                x >>= 1;
                y >>= 1;
            }

            if (depth === tileAddr.depth && x === tileAddr.x && y === tileAddr.y) {
                return { relevant: true, reason: 'ancestor' };
            }
        }
        let d = tileAddr.depth;
        let px = tileAddr.x;
        let py = tileAddr.y;
        while (d > 0) {
            d--;
            px >>= 1;
            py >>= 1;
            if (this._lastVisibleKeySet.has(this._makeKey(tileAddr.face, d, px, py))) {
                return { relevant: true, reason: 'descendant' };
            }
        }
        
        return { relevant: false, reason: 'stale' };
    }

    consumePressureWindow() {
        const minFreeLayers = Number.isFinite(this._minFreeLayersSinceLog)
            ? this._minFreeLayersSinceLog
            : (this.arrayPool?.freeLayers?.length ?? null);
        const requestLatency = {
            total: this._requestLatencyWindow.total,
            maxMs: this._requestLatencyWindow.maxMs,
            buckets: [...this._requestLatencyWindow.buckets],
            labels: [...REQUEST_LATENCY_BUCKET_LABELS],
            summary: formatRequestLatencyWindow(this._requestLatencyWindow)
        };
        const staleStarts = { ...this._staleStartWindow };
        const feedback = { ...this._feedbackWindow };
        const commits = this._commitWindowCount;
        const queueRejected = this._queueRejectWindowCount;
 
        const queueDropped = this._generationQueue.consumeDroppedCount();

        this._requestLatencyWindow = createRequestLatencyWindow();
        this._staleStartWindow = createStaleStartWindow();
        this._feedbackWindow = createFeedbackWindow();
        this._commitWindowCount = 0;
        this._queueRejectWindowCount = 0;
        this._freshnessSkipCount = 0;
        this._minFreeLayersSinceLog = Number.POSITIVE_INFINITY;
        this._recordPoolHeadroom();

        const gpuBackpressureSkips = this._gpuBackpressureSkipCount;
        const tilesStarted = this._tilesStartedWindowCount;
        const gpuFencesMax = this.tileGenerator?.consumeMaxGpuFences?.() ?? 0;

        this._requestLatencyWindow = createRequestLatencyWindow();
        this._staleStartWindow = createStaleStartWindow();
        this._feedbackWindow = createFeedbackWindow();
        this._commitWindowCount = 0;
        this._queueRejectWindowCount = 0;
        this._freshnessSkipCount = 0;
        this._gpuBackpressureSkipCount = 0;
        this._tilesStartedWindowCount = 0;
        this._minFreeLayersSinceLog = Number.POSITIVE_INFINITY;
        this._recordPoolHeadroom();

        return {
            requestLatency,
            staleStarts,
            feedback,
            commits,
            queueRejected,
            queueDropped,
            minFreeLayers,
            gpuBackpressureSkips,
            tilesStarted,
            gpuFencesMax
        };
    }

    getLoadedLayer(face, depth, x, y) {
        const info = this._tileInfo.get(this._makeKey(face, depth, x, y));
        return info?.layer ?? null;
    }

    getLayerDebugInfo(layer) {
        if (layer === null || layer === undefined) return null;
        return {
            layer,
            ownerKey: this._layerToKey.get(layer) ?? null,
            copyState: this._debugCopyStateByLayer.get(layer)?.state ?? 'unknown'
        };
    }

    getLoadedTiles() {
        const tiles = [];
        for (const [key, info] of this._tileInfo) {
            const parts = key.split(':');
            if (parts.length < 3) continue;
            const face = parseInt(parts[0].slice(1), 10);
            const depth = parseInt(parts[1].slice(1), 10);
            const xy = parts[2].split(',');
            if (xy.length < 2) continue;
            const x = parseInt(xy[0], 10);
            const y = parseInt(xy[1], 10);
            if (!Number.isFinite(face) || !Number.isFinite(depth) || !Number.isFinite(x) || !Number.isFinite(y)) {
                continue;
            }
            tiles.push({ face, depth, x, y, layer: info.layer });
        }
        return tiles;
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

    getCopyStateSummary() {
        const counts = {
            queued: 0,
            submitted: 0,
            ready: 0,
            failed: 0,
            unknown: 0
        };
        for (const state of this._debugCopyStateByLayer.values()) {
            const key = state?.state || 'unknown';
            if (Object.prototype.hasOwnProperty.call(counts, key)) {
                counts[key]++;
            } else {
                counts.unknown++;
            }
        }
        return {
            ...counts,
            trackedLayers: this._debugCopyStateByLayer.size,
            lastVisible: this._lastCopyVisibilitySummary
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

    async debugReadArrayLayerBuffer(type, layer, width = null, height = null) {
        if (!this.arrayPool || layer === null || layer === undefined) return null;
        const texture = this.arrayPool.textures.get(type);
        if (!texture) return null;

        const format = this.textureFormats[type] || this.arrayPool.formats?.[type] || 'rgba32float';
        return this._debugReadTextureBuffer(texture, format, width, height, layer);
    }

    async _debugReadTextureTexels(textureLike, format, texelCoords = [], layer = null) {
        const texture = textureLike?._gpuTexture?.texture || textureLike;
        if (!texture) return null;

        const texelBytes = gpuFormatBytesPerTexel(format);
        if (!Number.isFinite(texelBytes) || texelBytes <= 0) return null;

        const coords = Array.isArray(texelCoords) ? texelCoords : [];
        const size = this.tileTextureSize;
        const results = [];

        for (const coord of coords) {
            const x = Math.max(0, Math.min(size - 1, Math.floor(coord?.x ?? 0)));
            const y = Math.max(0, Math.min(size - 1, Math.floor(coord?.y ?? 0)));
            const bytesPerRow = 256;
            const staging = this.device.createBuffer({
                size: bytesPerRow,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
            });

            const encoder = this.device.createCommandEncoder();
            encoder.copyTextureToBuffer(
                { texture, origin: { x, y, z: layer ?? 0 } },
                { buffer: staging, bytesPerRow },
                [1, 1, 1]
            );
            this.device.queue.submit([encoder.finish()]);
            await this.device.queue.onSubmittedWorkDone();
            await staging.mapAsync(GPUMapMode.READ);

            const dv = new DataView(staging.getMappedRange());
            const values = readTexel(dv, 0, format);
            staging.unmap();
            staging.destroy();
            results.push({ x, y, values });
        }

        return {
            format,
            texels: results
        };
    }

    async _debugReadTextureBuffer(textureLike, format, width = null, height = null, layer = null) {
        const texture = textureLike?._gpuTexture?.texture || textureLike;
        if (!texture) return null;

        const texelBytes = gpuFormatBytesPerTexel(format);
        if (!Number.isFinite(texelBytes) || texelBytes <= 0) return null;

        const copyWidth = Math.max(1, Math.min(this.tileTextureSize, Math.floor(width ?? this.tileTextureSize)));
        const copyHeight = Math.max(1, Math.min(this.tileTextureSize, Math.floor(height ?? this.tileTextureSize)));
        const bytesPerRow = alignTo(copyWidth * texelBytes, 256);
        const bufferSize = bytesPerRow * copyHeight;

        const staging = this.device.createBuffer({
            size: bufferSize,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        });

        const encoder = this.device.createCommandEncoder();
        encoder.copyTextureToBuffer(
            { texture, origin: { x: 0, y: 0, z: layer ?? 0 } },
            { buffer: staging, bytesPerRow },
            [copyWidth, copyHeight, 1]
        );
        this.device.queue.submit([encoder.finish()]);
        await this.device.queue.onSubmittedWorkDone();
        await staging.mapAsync(GPUMapMode.READ);

        const mapped = staging.getMappedRange();
        const buffer = mapped.slice(0);
        staging.unmap();
        staging.destroy();

        return {
            format,
            width: copyWidth,
            height: copyHeight,
            texelBytes,
            bytesPerRow,
            buffer
        };
    }

    _debugRegisterQueuedCopy(tileAddr, layer, textures) {
        return;
        const types = Object.keys(textures || {}).filter((type) => textures[type]?._gpuTexture?.texture);
        const captureSources = this._debugReadbacksEnabled && this._debugCopyVerifyCaptureCount < 4;
        if (captureSources) {
            this._debugCopyVerifyCaptureCount++;
        }

        this._debugCopyStateByLayer.set(layer, {
            key: tileAddr.toString(),
            face: tileAddr.face,
            depth: tileAddr.depth,
            x: tileAddr.x,
            y: tileAddr.y,
            layer,
            state: 'queued',
            queuedAt: performance.now(),
            submittedAt: 0,
            readyAt: 0,
            batchId: 0,
            types,
            sourceTextures: captureSources ? { ...textures } : null
        });

        if (this._logStatsEnabled && this._debugCopyQueueLogCount < 12) {
            this._debugCopyQueueLogCount++;
            Logger.info(
                `${TERRAIN_STEP_LOG_TAG} [QTCommit] queued key=${tileAddr.toString()} layer=${layer} ` +
                `types=[${types.join(',')}] pendingCopies=${this.arrayPool?._pendingCopies?.length ?? 0}`
            );
        }
    }

    _debugMarkSubmittedCopies(flushedCopies, batchId) {
        const now = performance.now();
        const layerParts = [];
        for (const copy of flushedCopies) {
            const state = this._debugCopyStateByLayer.get(copy.layer);
            if (!state) continue;
            state.state = 'submitted';
            state.submittedAt = now;
            state.batchId = batchId;
            layerParts.push(`L${copy.layer}:${state.key}`);
        }

        if (this._logStatsEnabled && this._debugCopyFlushLogCount < 10) {
            this._debugCopyFlushLogCount++;
            Logger.info(
                `${TERRAIN_STEP_LOG_TAG} [QTCommit] flush batch=${batchId} copies=${flushedCopies.length} ` +
                `${layerParts.length ? `layers=${layerParts.slice(0, 6).join(', ')}` : 'layers=none'}`
            );
        }
    }

    _debugMarkReadyCopies(flushedCopies, batchId) {
        const now = performance.now();
        const readyParts = [];
        for (const copy of flushedCopies) {
            const state = this._debugCopyStateByLayer.get(copy.layer);
            if (!state) continue;
            state.state = 'ready';
            state.readyAt = now;
            state.batchId = batchId;
            state.copyLatencyMs = state.queuedAt ? (now - state.queuedAt) : 0;
            readyParts.push(`L${copy.layer}:${state.copyLatencyMs.toFixed(1)}ms`);
        }

        if (this._logStatsEnabled && this._debugCopyReadyLogCount < 10) {
            this._debugCopyReadyLogCount++;
            Logger.info(
                `${TERRAIN_STEP_LOG_TAG} [QTCommit] ready batch=${batchId} copies=${flushedCopies.length} ` +
                `${readyParts.length ? `latency=${readyParts.slice(0, 6).join(', ')}` : 'latency=none'}`
            );
        }
    }

    _debugMarkFailedCopies(flushedCopies, batchId) {
        for (const copy of flushedCopies) {
            const state = this._debugCopyStateByLayer.get(copy.layer);
            if (!state) continue;
            state.state = 'failed';
            state.batchId = batchId;
        }
        Logger.warn(
            `${TERRAIN_STEP_LOG_TAG} [QTCommit] copy fence failed batch=${batchId} copies=${flushedCopies.length}`
        );
    }

    async _debugVerifyCopiedLayers(flushedCopies, batchId) {
        if (!this._debugReadbacksEnabled) {
            return;
        }
        if (this._debugCopyVerifyLogCount >= 4) {
            return;
        }

        const coords = [
            { x: 0, y: 0 },
            { x: Math.max(0, Math.floor(this.tileTextureSize / 2)), y: Math.max(0, Math.floor(this.tileTextureSize / 2)) },
            { x: Math.max(0, this.tileTextureSize - 1), y: Math.max(0, this.tileTextureSize - 1) }
        ];

        for (const copy of flushedCopies) {
            if (this._debugCopyVerifyLogCount >= 4) {
                return;
            }
            const state = this._debugCopyStateByLayer.get(copy.layer);
            if (!state?.sourceTextures) {
                continue;
            }

            const summaries = [];
            for (const type of ['height', 'tile', 'splatData']) {
                const sourceTex = state.sourceTextures[type];
                if (!sourceTex || !this.arrayPool?.textures?.get(type)) {
                    continue;
                }
                const format = sourceTex._gpuFormat || this.textureFormats[type] || 'rgba32float';
                const sourceSamples = await this._debugReadTextureTexels(sourceTex, format, coords);
                const arraySamples = await this.debugReadArrayLayerTexels(type, copy.layer, coords);
                const comparison = compareTexelSampleSets(sourceSamples?.texels, arraySamples?.texels, format);
                summaries.push(
                    `${type}=${comparison.mismatchCount > 0 ? `mismatch(${comparison.mismatchCount}/${comparison.total})` : 'match'} ` +
                    `zeroSrc=${comparison.zeroSourceCount}/${comparison.total} ` +
                    `zeroDst=${comparison.zeroDestCount}/${comparison.total}` +
                    `${comparison.firstMismatch ? ` first=${comparison.firstMismatch}` : ''}`
                );
            }

            Logger.info(
                `${TERRAIN_STEP_LOG_TAG} [QTCommit] verify batch=${batchId} key=${state.key} layer=${copy.layer} ` +
                `${summaries.length ? summaries.join(' | ') : 'no-comparable-types'}`
            );
            state.sourceTextures = null;
            this._debugCopyVerifyLogCount++;
        }
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

function compareTexelSampleSets(sourceTexels, destTexels, format) {
    const src = Array.isArray(sourceTexels) ? sourceTexels : [];
    const dst = Array.isArray(destTexels) ? destTexels : [];
    const total = Math.max(Math.min(src.length, dst.length), 0);
    let mismatchCount = 0;
    let zeroSourceCount = 0;
    let zeroDestCount = 0;
    let firstMismatch = '';

    for (let i = 0; i < total; i++) {
        const sourceValues = Array.isArray(src[i]?.values) ? src[i].values : [];
        const destValues = Array.isArray(dst[i]?.values) ? dst[i].values : [];
        if (isZeroTexelValue(sourceValues)) zeroSourceCount++;
        if (isZeroTexelValue(destValues)) zeroDestCount++;
        if (texelValuesDiffer(sourceValues, destValues, format)) {
            mismatchCount++;
            if (!firstMismatch) {
                firstMismatch =
                    `(${src[i]?.x ?? '?'},${src[i]?.y ?? '?'}) ` +
                    `src=${formatTexelValues(sourceValues)} dst=${formatTexelValues(destValues)}`;
            }
        }
    }

    return {
        total,
        mismatchCount,
        zeroSourceCount,
        zeroDestCount,
        firstMismatch
    };
}

function isZeroTexelValue(values) {
    if (!Array.isArray(values) || values.length === 0) return true;
    for (const value of values) {
        if (Math.abs(value) > 1e-6) {
            return false;
        }
    }
    return true;
}

function texelValuesDiffer(sourceValues, destValues, format) {
    const maxLen = Math.max(sourceValues?.length ?? 0, destValues?.length ?? 0);
    const tolerance = format && format.includes('float') ? 1e-4 : 1 / 255 + 1e-6;
    for (let i = 0; i < maxLen; i++) {
        const src = Number.isFinite(sourceValues?.[i]) ? sourceValues[i] : 0;
        const dst = Number.isFinite(destValues?.[i]) ? destValues[i] : 0;
        if (Math.abs(src - dst) > tolerance) {
            return true;
        }
    }
    return false;
}

function formatTexelValues(values) {
    if (!Array.isArray(values)) return '[]';
    return `[${values.map((value) => Number.isFinite(value) ? value.toFixed(4) : 'nan').join(',')}]`;
}
