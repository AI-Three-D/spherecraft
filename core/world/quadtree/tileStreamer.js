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
import { computeTileWorldCenter } from './gpuQuadtreeDiagnosticHelpers.js';
import { splitOutputTypes } from './terrainOutputs.js';
import {
    Texture, TextureFormat, TextureFilter, TextureWrap,
    gpuFormatIsFilterable
} from '../../renderer/resources/texture.js';
import { Logger } from '../../../shared/Logger.js';

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

// ─── PercentileWindow ───────────────────────────────────────────────────────
// Raw-sample latency tracker for a single pipeline stage (Phase 0 of
// SphereCraft_Optimization_Implementation_Plan.md, §0.4). Samples accumulate
// between consume() calls; percentiles are computed on read, not on push, so
// the hot path (push) stays a single array append.
class PercentileWindow {
    constructor() {
        this.samples = [];
    }

    push(value) {
        if (Number.isFinite(value)) this.samples.push(value);
    }

    consume() {
        const n = this.samples.length;
        if (n === 0) {
            return { count: 0, p50: 0, p95: 0, p99: 0, max: 0 };
        }
        const sorted = this.samples.slice().sort((a, b) => a - b);
        const at = (p) => sorted[Math.min(n - 1, Math.floor(p * n))];
        const result = { count: n, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted[n - 1] };
        this.samples.length = 0;
        return result;
    }
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
        // isn't semantically discrete or already prebaked at chunk scale.
        // Caller can override explicitly.
        this.mipTypes = new Set(mipTypes || []);
        this.mipLevelCounts = new Map();   // type → mipLevelCount
        this._mipGen = null;               // lazy — only if any type is mipped

        for (var i = 0; i < this.capacity; i++) {
            this.freeLayers.push(i);
        }

        const wantsNearestByType = (type) =>
            type === 'height' ||
            type === 'tile' ||
            type === 'scatter' ||
            type === 'splatData' ||
            type === 'splatIndex' ||
            type === 'splatValid';
        const neverMipmapByType = (type) =>
            wantsNearestByType(type) ||
            type === 'resolvedColor';

        const fullMipCount = Math.floor(Math.log2(tileSize)) + 1;

        for (const type of this.types) {
            const format = this.formats[type] || 'rgba32float';
            const filterable = gpuFormatIsFilterable(format);

            // Auto-enable mips for filterable, non-discrete types when
            // caller didn't specify a mipTypes set.
            const neverMipmap = neverMipmapByType(type);
            if (neverMipmap) this.mipTypes.delete(type);
            const autoMip = mipTypes === null
                && filterable && !neverMipmap;
            const hasMips = !neverMipmap && (autoMip || this.mipTypes.has(type));
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
        this._zeroTextures = new Map();   // format -> lazily-created zero source
        this._splatIndexSentinel = null;  // lazily-created "not ready" marker
    }

    // A never-written texture is zero-initialized by WebGPU, so a single
    // 1-layer texture per format, created once and only ever read from,
    // works as a shared "zero" copy source for every type of that format.
    _getZeroSourceTexture(format) {
        let tex = this._zeroTextures.get(format);
        if (!tex) {
            tex = this.device.createTexture({
                size: [this.tileSize, this.tileSize, 1],
                format,
                usage: GPUTextureUsage.COPY_SRC
            });
            this._zeroTextures.set(format, tex);
        }
        return tex;
    }

    // splatIndex specifically must NOT zero-fill: decodeTileId(0) is a real,
    // valid tile id (id 0 happens to be WATER_1 in this catalog — see
    // wizard_game/world/biomes.json), so a plain zero-filled layer decodes
    // to "this whole tile is water" instead of "no data yet". Confirmed via
    // debug-mode elimination that this — not the queue-drop bug fixed
    // separately in _queueRefinement — is what painted resident-but-not-
    // yet-refined tiles as flat dark blue: sampleSplatData's topSum<=0.0001
    // fallback (terrainChunkFragmentShaderBuilder.js) still reads
    // centerIds from the zero-filled splatIndexMap even when weights are
    // zero, and nothing downstream re-checks id validity once a "dominant"
    // id is picked from an all-zero-weight tie. 255 is already treated as
    // out-of-range/invalid wherever this codebase decodes a splat tile id
    // (decodeSplatTileId(...) < 255), so filling every texel with 255 gives
    // an unambiguous "no real splat yet" signal that degrades correctly to
    // the geometry pass's own raw tile color instead of a fake material.
    _getSplatIndexSentinelTexture(format) {
        if (this._splatIndexSentinel) return this._splatIndexSentinel;
        Logger.info(`[SplatSentinel] creating splatIndex sentinel texture, format=${format}, tileSize=${this.tileSize}`);
        const tex = this.device.createTexture({
            size: [this.tileSize, this.tileSize, 1],
            format,
            usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST
        });
        const bytesPerRow = alignTo(this.tileSize * 4, 256);
        const data = new Uint8Array(bytesPerRow * this.tileSize).fill(255);
        this.device.queue.writeTexture(
            { texture: tex },
            data,
            { bytesPerRow, rowsPerImage: this.tileSize },
            { width: this.tileSize, height: this.tileSize, depthOrArrayLayers: 1 }
        );
        this._splatIndexSentinel = tex;
        return tex;
    }

    // zeroFillMissing: when true, every type this pool manages but that
    // isn't present in `textures` gets its layer copy-cleared instead of
    // being skipped. Needed for a Phase 2 geometry-only commit
    // (SphereCraft_Optimization_Implementation_Plan.md §2.3): array-pool
    // layers are reused across evictions, so without this a tile that skips
    // e.g. splat generation would render with whatever *previous* tile's
    // stale splat data happens to still occupy that layer — exactly the
    // kind of silent visual-correctness bug this codebase has been burned
    // by before. splatIndex gets the explicit 255 sentinel (see
    // _getSplatIndexSentinelTexture — a plain zero decodes to a real tile
    // id, id 0, which is WATER_1); every other type gets genuine zero,
    // which the terrain shader already degrades safely (they're not decoded
    // as an id the way splatIndex is).
    // completesMaterial: once this copy has been submitted, the layer holds
    // the tile's finished material (refinement output, or a single-stage
    // full tile). TileStreamer._flushArrayPoolCopies uses it to flag the
    // tile complete for the GPU only after the data is really in the layer.
    queueCopyToLayer(textures, layer, { zeroFillMissing = false, completesMaterial = false } = {}) {
        if (!zeroFillMissing) {
            this._pendingCopies.push({ textures, layer, completesMaterial });
            return;
        }
        const filled = { ...textures };
        for (const type of this.types) {
            if (filled[type]) continue;
            const format = this.formats[type] || 'rgba32float';
            const source = (type === 'splatIndex')
                ? this._getSplatIndexSentinelTexture(format)
                : this._getZeroSourceTexture(format);
            filled[type] = {
                _gpuTexture: { texture: source },
                _isZeroFillPlaceholder: true
            };
        }
        this._pendingCopies.push({ textures: filled, layer, completesMaterial });
    }

    // maxCount caps how many queued copies get flushed this call (plan §1.1
    // maxCopyOperationsPerFrame); any remainder stays queued (FIFO order) for
    // the next flush. Returns { count, textures } where `textures` is the
    // flat list of source texture wrappers whose copy was actually submitted
    // this call — the ONLY textures safe to schedule for destruction (a
    // deferred/not-yet-flushed entry's source must survive until its own
    // copy is actually submitted; see TileStreamer._flushArrayPoolCopies).
    flushPendingCopies(maxCount = Infinity) {
        const total = this._pendingCopies.length;
        if (total === 0) return { count: 0, textures: [] };
        const count = Math.max(0, Math.min(total, maxCount));
        if (count === 0) return { count: 0, textures: [] };

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
                    { width: this.tileSize, height: this.tileSize, depthOrArrayLayers: 1 }
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
        const flushed = this._pendingCopies.splice(0, count);
        const textures = [];
        for (const entry of flushed) {
            for (const type of Object.keys(entry.textures)) {
                const tex = entry.textures[type];
                // Never schedule the shared zero-fill source for destruction
                // — it's reused across every geometry-only commit.
                if (tex && !tex._isZeroFillPlaceholder) textures.push(tex);
            }
        }
        return { count, textures };
    }

    allocateLayer() {
        if (this.freeLayers.length > 0) return this.freeLayers.pop();
        return null;
    }

    releaseLayer(layer) {
        // Purge any still-pending copy targeting this layer before freeing
        // it for reuse. flushPendingCopies() writes directly to a stored
        // layer index with no check that the layer still belongs to the
        // tile that queued the copy — without this purge, a tile evicted
        // after its refinement copy was queued but before that copy
        // flushed would leave a "ghost" write sitting in _pendingCopies;
        // once this layer is handed to a brand-new tile and THAT tile
        // commits its own (correct) data, the ghost copy can still flush
        // afterward and silently overwrite it with the evicted tile's
        // stale textures. Confirmed plausible root cause (2026-10-01) of
        // resolvedColor reading as permanently invalid on tiles that
        // recently reused a layer, and of the reported "high-res tile
        // briefly flickers back to low-res" symptom — both match a tile's
        // freshly-correct data being overwritten by a stale ghost write
        // from an unrelated, already-evicted tile.
        if (this._pendingCopies && this._pendingCopies.length > 0) {
            const kept = [];
            for (const entry of this._pendingCopies) {
                if (entry.layer !== layer) {
                    kept.push(entry);
                    continue;
                }
                for (const type of Object.keys(entry.textures)) {
                    const tex = entry.textures[type];
                    if (tex && !tex._isZeroFillPlaceholder) {
                        try { tex.destroy?.(); } catch { /* ignore cleanup failure */ }
                    }
                }
            }
            this._pendingCopies = kept;
        }
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
                { width: this.tileSize, height: this.tileSize, depthOrArrayLayers: 1 }
            );
        }
        this.device.queue.submit([encoder.finish()]);
    }
}

// Per-tile flag bits in the 4th word of a hash entry (GPU: LoadedEntry._pad).
// Must match LOADED_FLAG_MATERIAL_COMPLETE in instanceBufferBuilder.wgsl.js.
const TILE_FLAG_MATERIAL_COMPLETE = 1;

// Refinement outputs that only the detail tiers (live splat / prebaked
// color) read. Tiles of the flat solid-color tier skip them.
const DETAIL_MATERIAL_TYPES = new Set(['splatData', 'splatIndex', 'splatValid', 'resolvedColor']);

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

    // The 4th word of an entry carries per-tile flags for the GPU (read as
    // LoadedEntry._pad by instanceBufferBuilder.wgsl.js). A new insert
    // starts with no flags; remove()'s cluster rehash carries them over.
    insert(keyLo, keyHi, layer, flags = 0) {
        let idx = this.hash(keyLo, keyHi);
        for (var i = 0; i < this.capacity; i++) {
            const base = idx * 4;
            const hi = this.entries[base + 1];
            if (hi === 0xFFFFFFFF || (hi === keyHi && this.entries[base] === keyLo)) {
                this.entries[base]     = keyLo;
                this.entries[base + 1] = keyHi;
                this.entries[base + 2] = layer >>> 0;
                this.entries[base + 3] = flags >>> 0;
                return idx;
            }
            idx = (idx + 1) & this.mask;
        }
        return -1;
    }

    setFlags(slot, flags) {
        if (slot < 0 || slot >= this.capacity) return;
        this.entries[slot * 4 + 3] = flags >>> 0;
    }

    getFlags(slot) {
        if (slot < 0 || slot >= this.capacity) return 0;
        return this.entries[slot * 4 + 3];
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
            const flags = this.entries[base + 3];
            this.entries[base]     = 0xFFFFFFFF;
            this.entries[base + 1] = 0xFFFFFFFF;
            this.entries[base + 2] = 0xFFFFFFFF;
            this.entries[base + 3] = 0xFFFFFFFF;
            if (touchedSlots) touchedSlots.push(idx);
            const newSlot = this.insert(lo, hi, layer, flags);
            if (touchedSlots && newSlot >= 0) touchedSlots.push(newSlot);
            idx = (idx + 1) & this.mask;
        }

        return slot;
    }
}

// ─── TileStreamer ─────────────────────────────────────────────────────────────

export class TileStreamer {

    constructor(device, terrainGenerator, quadtreeGPU, options = {}) {
        // ── Phase 1 admission budgets (SphereCraft_Optimization_Implementation_Plan.md §1) ──
        // Named explicitly per the plan so they can be tuned from measured
        // Phase 0 data rather than guessed.
        const admission = options.admissionBudgets ?? {};
        this._admissionBudgets = {
            maxNewTilesPerFrame: admission.maxNewTilesPerFrame
                ?? options.queueConfig?.maxStartsPerFrame ?? 6,
            maxConcurrentGenerations: admission.maxConcurrentGenerations
                ?? options.queueConfig?.maxConcurrentTasks ?? 12,
            maxCpuGenerationTimeMs: admission.maxCpuGenerationTimeMs
                ?? options.queueConfig?.timeBudgetMs ?? 6,
            maxGpuFencesInFlight: admission.maxGpuFencesInFlight
                ?? options.gpuBackpressureLimit ?? 4,
            maxCopyOperationsPerFrame: admission.maxCopyOperationsPerFrame ?? 8,
            // Small always-available reserve so top-of-queue urgent
            // (VISIBLE/FEEDBACK) work isn't starved indefinitely once the
            // GPU fence budget saturates during sustained fast flight.
            // Predictive/speculative entries self-gate below via canStart
            // against the hard fence limit, so this reserve is a no-op
            // unless genuinely urgent work is waiting (plan §1.3).
            urgentReserveSlots: admission.urgentReserveSlots ?? 1,
            // Phase 2: background material/refinement work for already-
            // resident tiles. Deliberately smaller than maxNewTilesPerFrame,
            // and subordinate to geometry admission in general — but plan
            // §1.2 explicitly ranks refinement of a nearby tile above
            // predictive/speculative geometry. Without a dedicated reserve,
            // sustained predictive demand during continuous exploration can
            // starve refinement indefinitely, leaving on-screen tiles stuck
            // with flat placeholder material — visible as hard material
            // seams against already-refined neighbors and multi-tile
            // features "growing into shape" with a delay (confirmed by
            // observation). Capped by the same overshoot logic as
            // urgentReserveSlots, so it's a bounded cushion, not a trickle.
            maxRefinementsPerFrame: admission.maxRefinementsPerFrame ?? 4,
            refinementUrgentReserveSlots: admission.refinementUrgentReserveSlots ?? 1,
            // Distance threshold (in tile-widths) within which a tile's
            // refinement is treated as urgent enough to use the reserve
            // above. Tuned directly from user observation: the geometry-
            // then-material pop was "acceptable twice as far [away]" but
            // "a bit too visible nearby" at the previous (unconditional)
            // behavior — i.e. distance-scale the urgency instead of a flat
            // visible/not-visible split, spending the reserve where the pop
            // is actually objectionable and letting distant tiles pop
            // without extra GPU cost.
            refinementNearDistanceTileWidths: admission.refinementNearDistanceTileWidths ?? 6
        };
        this._gpuBackpressureLimit = this._admissionBudgets.maxGpuFencesInFlight;
        this._gpuBackpressureSkipCount = 0;
        // Flag tiles "material complete" in the GPU lookup table once their
        // finished material has been copied into their layer. The instance
        // builder then draws the nearest complete layer (own or ancestor), so
        // a visible tile never switches from finished material back to a
        // geometry-only placeholder. false = previous behaviour (nearest
        // resident layer, finished or not).
        this._preferCompleteMaterialLayers = options.preferCompleteMaterialLayers !== false;
        this._tilesStartedWindowCount = 0;

        // ── Phase 0 instrumentation state (plan §0) ──────────────────────
        this._cameraContext = { position: null, velocity: null, speed: 0, planetConfig: null };
        this._telemetryByKey = new Map();
        this._stageLatency = {
            queueWait: new PercentileWindow(),        // request -> generationStart
            startToSubmit: new PercentileWindow(),     // generationStart -> computeSubmitted
            submitToFence: new PercentileWindow(),     // computeSubmitted -> gpuFenceComplete
            requestToResident: new PercentileWindow()  // request -> resident (end-to-end)
        };
        this._requestedTilesWindowCount = 0;
        this._newlyVisibleTilesWindowCount = 0;
        this._wastedGenerationsWindowCount = 0;
        this._computeSubmissionsWindowCount = 0;
        this._copyOperationsWindowCount = 0;
        this.device = device;
        this._aoCommitQueue = [];
        this._scatterCommitQueue = [];
        this._externalArrayTextures = null;
        this.terrainGenerator = terrainGenerator;
        this.quadtreeGPU = quadtreeGPU;
        this.textureManager = options.textureManager ?? null;
        this._lastVisibleTilesList = null;  
        this.tileTextureSize = options.tileTextureSize ?? 1024;
        this.requiredTypes   = options.requiredTypes   ?? ['height', 'normal', 'tile'];
        this.enableSplat     = options.enableSplat     ?? this.requiredTypes.includes('splatData');
        this.streamedTypes = this.requiredTypes.slice();
        if (this.enableSplat && this.streamedTypes.includes('splatData') && !this.streamedTypes.includes('splatIndex')) {
            this.streamedTypes.push('splatIndex');
        }
        if (this.enableSplat && this.streamedTypes.includes('splatData') && !this.streamedTypes.includes('splatValid')) {
            this.streamedTypes.push('splatValid');
        }

        // Phase 2 (geometry-first residency, plan §2): split the configured
        // output set into a fast geometry-only pass and a background
        // refinement pass. If everything configured is already a geometry
        // type (e.g. a minimal ['height','normal','tile'] setup),
        // refinementTypes is empty and the refinement stage is simply
        // never scheduled — no behavior change from before Phase 2.
        const { geometryTypes, refinementTypes } = splitOutputTypes(this.streamedTypes);
        this._geometryTypes = geometryTypes;
        this._refinementTypes = refinementTypes;
        // Tiles drawn by the flat solid-color tier (geometry LOD >=
        // solidTierStartLod) never sample the splat maps or the prebaked
        // color: the tier's color comes from the geometry pass's tile ids.
        // Their refinement skips those outputs (the splat step is ~12 of the
        // ~17.5 ms GPU per refinement) and keeps the rest (scatter/climate,
        // used by vegetation and ground-field bakes at every depth). Such a
        // layer is never flagged material-complete, so detail tiers never
        // pick it as a material source; the detail shaders draw the flat
        // color for a tile whose drawn layer has no detail material.
        // null/undefined = refine every tile fully (previous behaviour).
        this._solidTierStartLod = Number.isFinite(options.solidTierStartLod)
            ? Math.max(0, Math.floor(options.solidTierStartLod))
            : null;
        this._coarseRefinementTypes = refinementTypes.filter(type => !DETAIL_MATERIAL_TYPES.has(type));
        this._tileState = new Map();   // key -> 'REQUESTED'|'QUEUED'|'GENERATING'|'GEOMETRY_READY'|'RESIDENT'|'REFINING'|'REFINED'

        this.textureFormats  = {
            ...DEFAULT_TEXTURE_FORMATS,
            ...(options.textureFormats || {})
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
        for (const type of this.streamedTypes) {
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

        // Keys queued via a one-shot prewarm call (e.g. GPUQuadtreeTerrain's
        // prewarmWorldPosition), never dropped by the freshness check below.
        // Prewarm requests don't flow through the per-frame camera-feedback
        // path that normally refreshes _requestFreshness, so without this
        // exemption a deep prewarm-queued tile reliably goes "stale" and
        // gets purged before its turn, once real background streaming
        // traffic is sharing the same queue — confirmed live: a 71-tile
        // prewarm batch left droppedCount at 86 with depth 10/11 residency
        // near the anchor never completing. See RIVER_WALKING_SKELETON_LOG.md.
        this._prewarmKeys = new Set();


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
            maxInFlight:     this._admissionBudgets.maxConcurrentGenerations,
            maxPerFrame:     this._admissionBudgets.maxNewTilesPerFrame,
            timeBudgetMs:    this._admissionBudgets.maxCpuGenerationTimeMs,
            maxQueueSize:    options.queueConfig?.maxQueueSize        ?? 2048,
            minStartIntervalMs: options.queueConfig?.minStartIntervalMs ?? 0,
            shouldDrop: (entry) => {
                // Never drop prewarm-sourced requests — see _prewarmKeys above.
                if (this._prewarmKeys.has(entry.key)) return false;
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
        // Refinement-drop-by-depth instrumentation (2026-10-01) — see the
        // drop site in _queueRefinement's inner task for what this counts.
        this._refinementDropByDepthWindow = new Map();

        // ── Phase 2: background refinement queue (plan §2, §3 preview) ──
        // Separate from _generationQueue so refinement admission never
        // competes with geometry admission for the same per-frame slots —
        // tickGeneration derives its own, smaller, GPU-fence-aware budget
        // for this queue (see _tickRefinement).
        this._refinementQueue = new AsyncGenerationQueue({
            maxInFlight: this._admissionBudgets.maxConcurrentGenerations,
            maxPerFrame: this._admissionBudgets.maxRefinementsPerFrame,
            timeBudgetMs: this._admissionBudgets.maxCpuGenerationTimeMs,
            maxQueueSize: options.queueConfig?.maxQueueSize ?? 2048,
            shouldDrop: (entry) => {
                // A tile can be evicted (or already refined by a prior
                // duplicate) between being queued for refinement and this
                // entry reaching the front — nothing to refine any more.
                if (!this._tileInfo.has(entry.key)) return true;
                return false;
            }
        });
        this._refinementRejectWindowCount = 0;
        // key -> tileAddr for refinement requests dropped because the queue
        // was at capacity (AsyncGenerationQueue.request() returned null).
        // Drained a few at a time by _retryDroppedRefinements(), unconditionally
        // (queue-full is orthogonal to visibility, so no extra filter needed).
        this._refinementRetryMap = new Map();
        // key -> tileAddr for refinement requests dropped because the tile
        // was no longer "relevant" (not visible, not an ancestor/descendant
        // of anything visible) at dequeue time. Separate from the map above,
        // and separate retry logic (_retryVisibleDroppedRefinements), because
        // this case needs a much stricter filter: most resident tiles are
        // "relevant" via ancestor/descendant leniency at any given moment
        // (confirmed — cached off-screen tiles vastly outnumber visible
        // ones), so retrying on mere "relevant" reintroduced a livelock
        // (confirmed via frozen refinement throughput, not guessed — see the
        // comment at the original drop site). Only tiles that are STRICTLY
        // currently visible get re-queued; everything else is cheaply
        // rechecked and left in the map rather than consuming a refinement
        // queue slot. 2026-10-01: added to fix tiles that get unluckily
        // dropped during camera movement and then stay resident-but-never-
        // refined forever even after the camera settles and they become
        // squarely visible (confirmed via debug mode 102 + idle [QTLight]
        // telemetry: resolvedColor permanently invalid on some LOD4 tiles
        // even at steady state with an empty refinement queue).
        this._refinementVisibleDropRetryMap = new Map();
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
            this.device,
            this.tileTextureSize,
            this.tilePoolSize,
            this.streamedTypes,
            this.textureFormats
        );
        this._recordPoolHeadroom();

        if (this.enableTileCacheBridge) {
            this.tileCache = new TileCache({
                maxBytes: Number.MAX_SAFE_INTEGER,
                requiredTypes: this.streamedTypes,
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
            requiredTypes:  this.streamedTypes,
            textureFormats: this.textureFormats,
            textureManager: this.textureManager,
            quadtreeMaxDepth: this.quadtreeGPU?.maxDepth,
            maxGeomLOD: this.quadtreeGPU?.maxGeomLOD,
            enableSplat:    this.enableSplat,
            logStats:       this._logStatsEnabled,
            onGenerationTelemetry: (telemetry) => this._finalizeFenceTelemetry(telemetry)
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
                        this._queueTile(addr, { reason: 'VISIBLE' });
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
        this._refinementQueue.clearPending?.(null);
        this._tileState.clear();
        this._refinementRejectWindowCount = 0;
        this._refinementRetryMap.clear();
        this._refinementVisibleDropRetryMap.clear();

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
        this._refinementDropByDepthWindow.clear();

        this._telemetryByKey.clear();
        for (const window of Object.values(this._stageLatency)) window.consume();
        this._requestedTilesWindowCount = 0;
        this._newlyVisibleTilesWindowCount = 0;
        this._wastedGenerationsWindowCount = 0;
        this._copyOperationsWindowCount = 0;

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
        this._advanceFlushStatsFrame();
        this._pruneRequestFreshness();
        this._logEvictFeedbackStats();
        this._logPipelineRaceStats();
        this._logFallbackEvictStats();
        this._recordCommitLagStats();
        this._flushArrayPoolCopies();

        if (this._needsFullHashUpload || this._dirtySlots.size > 0) {
            this._uploadDirtyHashSlots();
        }

        this.tileCache?.tick?.();
        this._destroyDeferredTextures();
    }

    _advanceFlushStatsFrame() {
        if (!this._evictFeedbackFrame) this._evictFeedbackFrame = 0;
        this._evictFeedbackFrame++;
        if (!this._pipelineRaceStatsFrame) this._pipelineRaceStatsFrame = 0;
        this._pipelineRaceStatsFrame++;
        if (!this._requestFreshness) this._requestFreshness = new Map();
    }

    _pruneRequestFreshness() {
        if (this._requestFreshness.size <= 2048) return;

        const cutoff = performance.now() - 2000;
        for (const [key, timestamp] of this._requestFreshness) {
            if (timestamp < cutoff) this._requestFreshness.delete(key);
        }
    }

    _logEvictFeedbackStats() {
        if (this._evictFeedbackFrame % 300 !== 0) return;
        if (!this._evictFeedbackStats || this._evictFeedbackStats.count <= 0) return;

        const s = this._evictFeedbackStats;
        Logger.warn(
            `[QT-Stitch-EvictFeedback] Summary: evict→feedback events=${s.count} ` +
            `avgAgeMs=${(s.totalAgeMs / s.count).toFixed(0)} ` +
            `minMs=${s.minAgeMs.toFixed(0)} maxMs=${s.maxAgeMs.toFixed(0)}`
        );
        this._evictFeedbackStats = { count: 0, totalAgeMs: 0, minAgeMs: Infinity, maxAgeMs: 0 };
    }

    _logPipelineRaceStats() {
        if (this._pipelineRaceStatsFrame % 300 !== 0) return;
        if (!this._pipelineRaceStats || this._pipelineRaceStats.total <= 0) return;

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

    _logFallbackEvictStats() {
        if (!this._fallbackEvictStats || this._fallbackEvictStats.total <= 0) return;

        if (!this._fallbackStatsFrame) this._fallbackStatsFrame = 0;
        this._fallbackStatsFrame++;
        if (this._fallbackStatsFrame % 300 !== 0) return;

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
        this._fallbackEvictStats = {
            total: 0,
            withDependents: 0,
            totalDependents: 0,
            maxDependents: 0
        };
    }

    _recordCommitLagStats() {
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

        if (this._pipelineRaceStatsFrame % 300 !== 0) return;
        if (!this._commitLagStats || this._commitLagStats.commits <= 0) return;

        const cl = this._commitLagStats;
        Logger.warn(
            `[QT-Pipeline-GenLag] commits=${cl.commits} ` +
            `pendingAtFlush=${cl.pendingAtFlush} ` +
            `maxPendingPerFlush=${cl.maxPendingAtFlush} ` +
            `(each was GPU-invisible for ≥1 frame)`
        );
        this._commitLagStats = { commits: 0, pendingAtFlush: 0, maxPendingAtFlush: 0 };
    }

    _flushArrayPoolCopies() {
        if (!this.arrayPool) return;

        const copyBudget = this._admissionBudgets.maxCopyOperationsPerFrame;
        // Snapshot for debug bookkeeping BEFORE flushing (flushPendingCopies
        // splices its own array); slicing with the same budget here mirrors
        // exactly what flushPendingCopies will actually flush.
        const flushedCopies = Array.isArray(this.arrayPool._pendingCopies)
            ? this.arrayPool._pendingCopies.slice(0, copyBudget)
            : [];
        const { count: copyCount, textures: flushedTextures } = this.arrayPool.flushPendingCopies(copyBudget);
        this._copyOperationsWindowCount += copyCount;
        this._markMaterialCompleteForFlushedCopies(flushedCopies, copyCount);
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

        // Textures destined for a copy are only ever safe to destroy once
        // flushPendingCopies() reports them as actually flushed (above) —
        // never derived from a count-based slice of _pendingCopyTextures,
        // which also holds unrelated castoffs (dup/pool-full/stale-epoch
        // tiles in _commitTile/_queueTile) that were never queued for copy
        // at all and don't correspond 1:1 with _pendingCopies.
        const castoffTextures = this._pendingCopyTextures.length > 0
            ? this._pendingCopyTextures.flat()
            : [];
        this._pendingCopyTextures.length = 0;

        const textures = [...flushedTextures, ...castoffTextures];
        if (textures.length === 0) return;

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

    // Raise the GPU "material complete" flag for tiles whose finishing copy
    // was just submitted. Runs inside tickFlush right after the copy batch's
    // queue.submit and before the dirty hash slots are uploaded, so the flag
    // reaches the GPU in the same frame as (and queue-ordered after) the
    // data it vouches for — never before. Pending copies of a released layer
    // are purged in releaseLayer, so a flushed entry always belongs to the
    // layer's current occupant.
    _markMaterialCompleteForFlushedCopies(flushedCopies, copyCount) {
        if (!this._preferCompleteMaterialLayers || copyCount <= 0) return;
        const count = Math.min(copyCount, flushedCopies.length);
        for (let i = 0; i < count; i++) {
            const entry = flushedCopies[i];
            if (!entry?.completesMaterial) continue;
            const key = this._layerToKey.get(entry.layer);
            const info = key ? this._tileInfo.get(key) : null;
            if (!info || info.layer !== entry.layer) continue;
            const slot = this.hashTable.findSlot(info.keyLo, info.keyHi);
            if (slot < 0) continue;
            const flags = this.hashTable.getFlags(slot);
            if ((flags & TILE_FLAG_MATERIAL_COMPLETE) !== 0) continue;
            this.hashTable.setFlags(slot, flags | TILE_FLAG_MATERIAL_COMPLETE);
            this._dirtySlots.add(slot);
        }
    }

    _destroyDeferredTextures() {
        if (this._pendingDestructions.length === 0) return;

        for (let i = this._pendingDestructions.length - 1; i >= 0; i--) {
            const entry = this._pendingDestructions[i];
            if (entry.fenceResolved === false) continue;
            entry.framesRemaining--;
            if (entry.framesRemaining > 0) continue;
            this._pendingDestructions.splice(i, 1);
            for (const tex of entry.textures) {
                try { if (tex?._gpuTexture?.texture) tex._gpuTexture.texture.destroy(); } catch { /* ignore cleanup failure */ }
                try { if (typeof tex.dispose === 'function') tex.dispose(); } catch { /* ignore cleanup failure */ }
            }
        }
    }
    tickGeneration() {
        // Bound outstanding GPU generation work. Each tile is ~9 ms GPU;
        // without this, movement bursts push the command queue 30+ frames
        // deep and latency spirals to 500+ ms. Budget is the headroom
        // between the limit and the current in-flight fence count.
        const gpuInFlight = this.tileGenerator?._gpuFencesInFlight ?? 0;
        const budget = Math.max(0, this._admissionBudgets.maxGpuFencesInFlight - gpuInFlight);

        // Keep a small reserve even at budget=0 so top-of-queue urgent
        // (VISIBLE/FEEDBACK) work isn't fully starved by sustained
        // predictive/GPU pressure (plan §1.3). PREDICTIVE entries carry
        // their own canStart gate against the same fence limit (see
        // _queueTile), so this reserve only ever admits genuinely urgent
        // work — if the queue is all predictive, canStart defers it and
        // nothing actually starts.
        //
        // The reserve must be measured against total overshoot already
        // granted, not handed out fresh every frame — during a sustained
        // GPU backlog (fences take 12+ frames to resolve; confirmed via
        // Phase 0 submitToFence measurements), a flat +1/frame reserve
        // compounds every frame nothing resolves, letting fences climb
        // well past the intended ceiling (measured: 8+ instead of the
        // intended maxGpuFencesInFlight + urgentReserveSlots ≈ 5).
        // Capping by remaining overshoot keeps the reserve a one-time
        // cushion, not an unbounded trickle.
        const overshoot = Math.max(0, gpuInFlight - this._admissionBudgets.maxGpuFencesInFlight);
        const reserveRemaining = Math.max(0, this._admissionBudgets.urgentReserveSlots - overshoot);
        const effectiveBudget = Math.max(budget, reserveRemaining);

        if (effectiveBudget === 0) {
            this._gpuBackpressureSkipCount++;
            this.tileGenerator?.tick?.();
            return;
        }

        // Cap this frame's starts at min(configured max, GPU budget).
        // maxPerFrame is restored immediately so config inspection
        // elsewhere still sees the real value.
        const savedMaxPerFrame = this._generationQueue.maxPerFrame;
        this._generationQueue.maxPerFrame = Math.min(savedMaxPerFrame, effectiveBudget);
        const spawned = this._generationQueue.tick() || 0;
        this._generationQueue.maxPerFrame = savedMaxPerFrame;

        this._tilesStartedWindowCount += spawned;

        this._tickRefinement(spawned);

        this.tileGenerator?.tick?.();
    }

    // Phase 2 background refinement admission (plan §1.2/§2): subordinate to
    // geometry in general — it only starts against genuine spare GPU fence
    // headroom left over after geometry admission above has already run
    // this frame, further capped by its own (smaller) maxRefinementsPerFrame
    // budget. BUT plan §1.2 ranks refinement of a nearby tile above
    // predictive/speculative geometry: when the refinement queue's next
    // candidate is within refinementNearDistanceTileWidths of the camera,
    // it gets its own small reserve too — otherwise sustained predictive
    // demand during continuous exploration can starve refinement
    // indefinitely (confirmed by observation: visible material seams where
    // an already-refined tile sits next to one stuck on flat placeholder
    // material). Scaled by distance rather than a flat visible/not-visible
    // split, per direct user feedback: the pop was "acceptable twice as far
    // [away]" but "a bit too visible nearby" — so the reserve is spent near
    // the camera, where the pop is actually objectionable, and distant
    // tiles are left to pop without extra GPU cost.
    //
    // geometrySpawnedThisFrame must be added to the live fence count by
    // hand: AsyncGenerationQueue.tick() only *schedules* admitted tasks as
    // microtasks (Promise.resolve().then(entry.task)) — they don't actually
    // run, and therefore don't increment _gpuFencesInFlight, until this
    // synchronous tickGeneration() call has fully returned. Without this,
    // refinement's budget check sees the same stale pre-tick fence count
    // geometry's own admission just used, and the two queues' combined
    // admission can roughly double the intended fence ceiling.
    _tickRefinement(geometrySpawnedThisFrame = 0) {
        // Re-offer previously-dropped refinement requests before admission
        // budgeting below — this only re-enqueues (cheap, no GPU work), the
        // actual generation start is still gated by effectiveBudget/.tick()
        // same as any other queued entry, so this can't bypass the budget.
        this._retryDroppedRefinements();
        this._retryVisibleDroppedRefinements();

        const gpuInFlight = (this.tileGenerator?._gpuFencesInFlight ?? 0) + geometrySpawnedThisFrame;
        const budget = Math.max(0, this._admissionBudgets.maxGpuFencesInFlight - gpuInFlight);

        let effectiveBudget = budget;
        const head = this._refinementQueue.queue[0];
        const headDistance = head ? this._telemetryByKey.get(head.key)?.distanceInTileWidths : null;
        // Unknown distance (no camera context yet, e.g. cold start) treated
        // as near: no reason to withhold the reserve when there's no signal
        // to scale it by, and cold start has no competing predictive demand
        // anyway.
        const headIsNear = head && (headDistance === null || headDistance === undefined
            || !Number.isFinite(headDistance)
            || headDistance <= this._admissionBudgets.refinementNearDistanceTileWidths);
        if (headIsNear) {
            // Same overshoot-capping as geometry's urgentReserveSlots (see
            // tickGeneration): a bounded one-time cushion, not a per-frame
            // trickle that could compound into unbounded fence growth.
            const overshoot = Math.max(0, gpuInFlight - this._admissionBudgets.maxGpuFencesInFlight);
            const reserveRemaining = Math.max(0, this._admissionBudgets.refinementUrgentReserveSlots - overshoot);
            effectiveBudget = Math.max(budget, reserveRemaining);
        }
        if (effectiveBudget === 0) return;

        const savedMaxPerFrame = this._refinementQueue.maxPerFrame;
        this._refinementQueue.maxPerFrame = Math.min(savedMaxPerFrame, effectiveBudget);
        this._refinementQueue.tick();
        this._refinementQueue.maxPerFrame = savedMaxPerFrame;
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
            const count = this._readFeedbackCount(slot);
            if (count === 0) {
                slot.feedbackStaging.unmap();
                slot.state = 'idle';
                return;
            }

            const data = new Uint32Array(slot.feedbackStaging.getMappedRange(0, count * 16));
            this._dedupeFeedbackData(data, count);
            slot.feedbackStaging.unmap();
            slot.state = 'idle';

            this._feedbackDedupeSet.forEach((face, depth, x, y) => {
                this._processFeedbackAddress(face, depth, x, y);
            });
            this._queueMissingParentsNumeric();

        } catch {
            slot.state = 'idle';
        }
    }

    _readFeedbackCount(slot) {
        const countView = new Uint32Array(slot.metaStaging.getMappedRange());
        const count = Math.min(countView[0] || 0, this.maxFeedback);
        slot.metaStaging.unmap();
        return count;
    }

    _dedupeFeedbackData(data, count) {
        this._feedbackDedupeSet.clear();
        for (let i = 0; i < count; i++) {
            const base = i * 4;
            this._feedbackDedupeSet.insert(data[base], data[base + 1], data[base + 2], data[base + 3]);
        }
        this._feedbackWindow.readbacks++;
        this._feedbackWindow.raw += count;
        this._feedbackWindow.unique += this._feedbackDedupeSet.count;
    }

    _processFeedbackAddress(face, depth, x, y) {
        const key = this._makeKey(face, depth, x, y);
        this._requestFreshness.set(key, performance.now());

        const keyLo = this.hashTable.makeKeyLo(x, y);
        const keyHi = this.hashTable.makeKeyHi(face, depth);
        const hashSlot = this.hashTable.findSlot(keyLo, keyHi);
        if (hashSlot >= 0) return;

        if (this._recentEvictions?.has(key)) {
            this._recordEvictFeedback(key, depth);
        }

        const addr = new TileAddress(face, depth, x, y);
        if (this.tileGenerator.isGenerating(addr)) return;
        this._queueTile(addr, { reason: 'FEEDBACK' });
    }

    _recordEvictFeedback(key, depth) {
        const evInfo = this._recentEvictions.get(key);
        const ageMs = performance.now() - evInfo.evictedAt;
        this._recordEvictFeedbackStats(ageMs);
        this._recordPipelineRaceStats(evInfo, ageMs);
        this._logImmediateEvictFeedback(key, depth, evInfo.depth, ageMs);
    }

    _recordEvictFeedbackStats(ageMs) {
        if (!this._evictFeedbackStats) {
            this._evictFeedbackStats = { count: 0, totalAgeMs: 0, minAgeMs: Infinity, maxAgeMs: 0 };
        }
        this._evictFeedbackStats.count++;
        this._evictFeedbackStats.totalAgeMs += ageMs;
        this._evictFeedbackStats.minAgeMs = Math.min(this._evictFeedbackStats.minAgeMs, ageMs);
        this._evictFeedbackStats.maxAgeMs = Math.max(this._evictFeedbackStats.maxAgeMs, ageMs);
    }

    _recordPipelineRaceStats(evInfo, ageMs) {
        if (!this._pipelineRaceStats) {
            this._pipelineRaceStats = {
                total: 0, sameFrame: 0, nextFrame: 0, delayed: 0, byDepth: {}
            };
        }
        this._pipelineRaceStats.total++;
        if (ageMs < 50) this._pipelineRaceStats.sameFrame++;
        else if (ageMs < 200) this._pipelineRaceStats.nextFrame++;
        else this._pipelineRaceStats.delayed++;

        const depth = evInfo.depth;
        this._pipelineRaceStats.byDepth[depth] =
            (this._pipelineRaceStats.byDepth[depth] || 0) + 1;
    }

    _logImmediateEvictFeedback(key, depth, evictedDepth, ageMs) {
        if (ageMs < 50) {
            if (!this._pipelineRaceLogCount) this._pipelineRaceLogCount = 0;
            if (this._pipelineRaceLogCount < 20) {
                this._pipelineRaceLogCount++;
                Logger.warn(
                    `[QT-Pipeline-SameFrame] key=${key} depth=${evictedDepth} ` +
                    `ageMs=${ageMs.toFixed(1)} (evicted and re-requested within one frame)`
                );
            }
        }

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
                    this._queueTile(addr, { reason: 'FEEDBACK' });
                }
            }
        });
    }

    // ── Phase 0 telemetry helpers ─────────────────────────────────────────
    //
    // Called once per frame by QuadtreeTileManager with the camera's current
    // world position/velocity, so _estimateRequestGeometry can compute a
    // rough distanceToCamera/velocityAlignment for each request without this
    // class needing to own planetConfig or camera state itself.
    setCameraContext({ position = null, velocity = null, planetConfig = null } = {}) {
        this._cameraContext.position = position;
        this._cameraContext.velocity = velocity;
        this._cameraContext.planetConfig = planetConfig;
        this._cameraContext.speed = velocity ? Math.hypot(velocity.x, velocity.y, velocity.z) : 0;
    }

    // Rough (base-radius, elevation-ignored) distance/alignment estimate —
    // cheap enough to compute per request, precise enough to classify
    // wasted/forward-vs-behind generation work (plan §0.1, §1.2).
    _estimateRequestGeometry(tileAddr) {
        const ctx = this._cameraContext;
        if (!ctx.position || !ctx.planetConfig) {
            return { distanceToCamera: null, velocityAlignment: null };
        }
        const world = computeTileWorldCenter(tileAddr, ctx.planetConfig);
        if (!world) return { distanceToCamera: null, velocityAlignment: null };

        const dx = world.x - ctx.position.x;
        const dy = world.y - ctx.position.y;
        const dz = world.z - ctx.position.z;
        const distanceToCamera = Math.hypot(dx, dy, dz);

        let velocityAlignment = null;
        if (ctx.velocity && ctx.speed > 1e-3 && distanceToCamera > 1e-6) {
            velocityAlignment =
                (dx * ctx.velocity.x + dy * ctx.velocity.y + dz * ctx.velocity.z) /
                (distanceToCamera * ctx.speed);
        }
        return { distanceToCamera, velocityAlignment };
    }

    // Rough world-space width of a tile at a given quadtree depth — a cube
    // face spans a diameter of ~2*radius in cube-space, split gridSize ways.
    // Ignores cube-to-sphere warping (a small correction); precise enough
    // for a "how many tile-widths away is the camera" priority heuristic,
    // not for rendering.
    _estimateTileWorldSize(depth) {
        const radius = this._cameraContext.planetConfig?.radius;
        if (!Number.isFinite(radius)) return null;
        const gridSize = 1 << depth;
        return (2 * radius) / gridSize;
    }

    // Called from TileGenerator once the GPU fence for a tile's submission
    // resolves — the only point at which gpuFenceComplete/submitToFence are
    // knowable, which is after this class has already committed the tile
    // (residency is marked at copy-submit time, not GPU-copy-complete time;
    // see _commitTile). This is therefore also telemetry's final cleanup point.
    _finalizeFenceTelemetry(telemetry) {
        if (!telemetry) return;
        if (Number.isFinite(telemetry.gpuFenceComplete) && Number.isFinite(telemetry.computeSubmitted)) {
            this._stageLatency.submitToFence.push(telemetry.gpuFenceComplete - telemetry.computeSubmitted);
        }
        // Identity check, not just key: a world reset (resetTiles) clears
        // _telemetryByKey and can re-seed the same key before this stale
        // generation's fence resolves — don't let its delayed cleanup evict
        // a newer, still-live telemetry record for that key.
        if (this._telemetryByKey.get(telemetry.key) === telemetry) {
            this._telemetryByKey.delete(telemetry.key);
        }
    }

    _queueTile(tileAddr, { prewarm = false, reason = 'FEEDBACK' } = {}) {
        const key = tileAddr.toString();
        if (!this._requestTimestamps.has(key)) {
            this._requestTimestamps.set(key, performance.now());
        }
        if (prewarm) this._prewarmKeys.add(key);
        this._requestedTilesWindowCount++;

        let telemetry = this._telemetryByKey.get(key);
        if (!telemetry) {
            const geom = this._estimateRequestGeometry(tileAddr);
            telemetry = {
                key,
                face: tileAddr.face, depth: tileAddr.depth, x: tileAddr.x, y: tileAddr.y,
                reason,
                priority: null,
                distanceToCamera: geom.distanceToCamera,
                velocityAlignment: geom.velocityAlignment,
                // Phase 2: every tile's first pass requests only the
                // geometry preset; remaining configured types (if any)
                // follow as a separate background refinement pass.
                generationTier: this._refinementTypes.length > 0 ? 'geometry' : 'full',
                outputMask: this._geometryTypes,
                resolution: this.tileTextureSize,
                requestTime: performance.now(),
                queueTime: null,
                generationStart: null,
                computeSubmitted: null,
                gpuFenceComplete: null,
                copySubmitted: null,
                residentTime: null
            };
            this._telemetryByKey.set(key, telemetry);
            this._tileState.set(key, 'REQUESTED');
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

        // Directional bias for predictive work only (plan §1.2: forward
        // predictive geometry must outrank behind-camera predictive
        // geometry). Small enough (±400) to never outrank real
        // visible/feedback demand, which is what distanceBias already
        // dominates with above.
        let directionalBias = 0;
        if (reason === 'PREDICTIVE' && Number.isFinite(telemetry.velocityAlignment)) {
            directionalBias = telemetry.velocityAlignment * 400;
        }

        const priority = depthPriority + distanceBias + directionalBias;
        telemetry.priority = priority;

        // Phase 1 admission control (plan §1.3/§1.4): predictive/speculative
        // work individually respects the hard GPU fence budget, so it backs
        // off under pressure without needing to touch the frame-level
        // maxNewTilesPerFrame clamp in tickGeneration(). VISIBLE/FEEDBACK
        // requests are left ungated here — they're covered instead by
        // tickGeneration()'s urgent reserve, so real on-screen geometry
        // keeps making progress even while predictive work is fully stalled.
        const canStart = (reason === 'PREDICTIVE')
            ? () => (this.tileGenerator?._gpuFencesInFlight ?? 0) < this._admissionBudgets.maxGpuFencesInFlight
            : null;

        const generationEpoch = this._generationEpoch;
        const request = this._generationQueue.request(key, priority, async () => {
            const now = performance.now();
            telemetry.queueTime = now;
            telemetry.generationStart = now;
            this._tileState.set(key, 'GENERATING');
            this._stageLatency.queueWait.push(now - telemetry.requestTime);

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
                // Geometry preset only (plan §2.1/§2.3) — the minimum a tile
                // needs to become resident and visually useful. Any
                // remaining configured types follow as a background
                // refinement pass once this commits.
                const textures = await this.tileGenerator.generateTile(tileAddr, telemetry, this._geometryTypes);
                if (Number.isFinite(telemetry.computeSubmitted)) {
                    this._stageLatency.startToSubmit.push(telemetry.computeSubmitted - telemetry.generationStart);
                }
                if (generationEpoch !== this._generationEpoch) {
                    this._requestTimestamps.delete(key);
                    this._prewarmKeys.delete(key);
                    this._tileState.delete(key);
                    this._destroyGeneratedTextures(textures);
                    this._wastedGenerationsWindowCount++;
                    return false;
                }
                this._tileState.set(key, 'GEOMETRY_READY');
                const committed = await this._commitTile(tileAddr, textures, telemetry);
                const stillRelevant = this._describeTileDemandState(tileAddr, key).relevant;
                if (!committed || !stillRelevant) {
                    this._wastedGenerationsWindowCount++;
                }
                if (!committed) {
                    this._requestTimestamps.delete(key);
                    this._tileState.delete(key);
                } else {
                    this._tileState.set(key, 'RESIDENT');
                    if (this._refinementTypes.length > 0) {
                        this._queueRefinement(tileAddr);
                    }
                }
                this._prewarmKeys.delete(key);
                return committed;
            } catch (error) {
                this._requestTimestamps.delete(key);
                this._prewarmKeys.delete(key);
                this._telemetryByKey.delete(key);
                this._tileState.delete(key);
                throw error;
            }
        }, canStart);
        if (request === null) {
            this._queueRejectWindowCount++;
            this._requestTimestamps.delete(key);
            this._prewarmKeys.delete(key);
            this._telemetryByKey.delete(key);
            this._tileState.delete(key);
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
        this._tileState.delete(key);
        this.arrayPool.releaseLayer(info.layer);
        this._recordPoolHeadroom();
    }


async _commitTile(tileAddr, textures, telemetry = null) {
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

    // zeroFillMissing: this is a geometry-only commit (plan §2) — any
    // configured type not generated yet (splat/climate/scatter/...) gets
    // its layer explicitly zeroed rather than left with whatever the
    // *previous* occupant of this (possibly reused) layer wrote there.
    // A geometry-only commit completes the tile's material only when nothing
    // is left to refine (single-stage configuration).
    this.arrayPool.queueCopyToLayer(textures, layer, {
        zeroFillMissing: true,
        completesMaterial: this._refinementTypes.length === 0
    });
    if (telemetry) telemetry.copySubmitted = performance.now();
    this._debugRegisterQueuedCopy(tileAddr, layer, textures);
    // Do NOT schedule these for destruction here: arrayPool._pendingCopies
    // (just queued above) still needs them until the copy is actually
    // flushed, which may be a later frame under maxCopyOperationsPerFrame
    // (plan §1.1). flushPendingCopies() returns exactly the textures whose
    // copy it submitted; TileStreamer._flushArrayPoolCopies schedules those
    // for delayed destruction once it has that list.

    const keyLo = this.hashTable.makeKeyLo(tileAddr.x, tileAddr.y);
    const keyHi = this.hashTable.makeKeyHi(tileAddr.face, tileAddr.depth);
    // With preferCompleteMaterialLayers off, every resident layer counts as
    // a material source right away (previous behaviour: nearest resident).
    const initialFlags = this._preferCompleteMaterialLayers ? 0 : TILE_FLAG_MATERIAL_COMPLETE;
    const slot  = this.hashTable.insert(keyLo, keyHi, layer, initialFlags);
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
    if (telemetry) {
        telemetry.residentTime = performance.now();
        this._stageLatency.requestToResident.push(telemetry.residentTime - telemetry.requestTime);
    }

    // AO only needs height/normal (both geometry-stage), so it's safe to
    // bake immediately. Scatter needs the actual scatter texture, which is
    // now a refinement-stage output (plan §2) — its commit queue push moves
    // to _commitRefinement, once real (non-zero-filled) scatter data exists.
    this._aoCommitQueue.push({
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

// ── Phase 2: background refinement (plan §2, lightly previews §3) ─────────
//
// Queues generation of whatever configured output types weren't part of
// the geometry preset (splat/climate/scatter/...) for a tile that's already
// resident. Runs on a separate, smaller-budget queue so it never competes
// with new-tile admission for the same per-frame slots (plan §1.2: visible/
// predictive geometry always outranks refinement).
// True when the tile at this depth is drawn by the flat solid-color tier.
_isSolidTierDepth(depth) {
    if (this._solidTierStartLod === null) return false;
    const maxDepth = this.quadtreeGPU?.maxDepth;
    if (!Number.isFinite(maxDepth)) return false;
    return (maxDepth - depth) >= this._solidTierStartLod;
}

// Refinement outputs for a tile: the full set for detail tiers, the set
// without splat/prebaked color for the flat tier (see constructor).
_refinementTypesFor(tileAddr) {
    return this._isSolidTierDepth(tileAddr.depth)
        ? this._coarseRefinementTypes
        : this._refinementTypes;
}

_queueRefinement(tileAddr) {
    const key = tileAddr.toString();
    if (!this._tileInfo.has(key)) return; // evicted before refinement could even be queued
    const refinementTypes = this._refinementTypesFor(tileAddr);
    if (refinementTypes.length === 0) {
        this._tileState.set(key, 'REFINED');
        return;
    }

    // Distance normalized by the tile's own world-space size ("how many
    // tile-widths away is the camera") rather than raw meters, so one
    // threshold works consistently across LOD depths. Driven directly by
    // user observation: the geometry-then-material pop is tolerable at
    // typical viewing distance but too visible up close — "acceptable
    // twice as far [away]. Now it's a bit too visible nearby."
    const geom = this._estimateRequestGeometry(tileAddr);
    const tileWidth = this._estimateTileWorldSize(tileAddr.depth);
    const distanceInTileWidths = (Number.isFinite(geom.distanceToCamera) && tileWidth > 0)
        ? geom.distanceToCamera / tileWidth
        : null;

    const telemetry = {
        key,
        face: tileAddr.face, depth: tileAddr.depth, x: tileAddr.x, y: tileAddr.y,
        reason: 'REFINEMENT',
        priority: null,
        distanceToCamera: geom.distanceToCamera,
        distanceInTileWidths,
        velocityAlignment: null,
        generationTier: 'refinement',
        outputMask: refinementTypes,
        resolution: this.tileTextureSize,
        requestTime: performance.now(),
        queueTime: null,
        generationStart: null,
        computeSubmitted: null,
        gpuFenceComplete: null,
        copySubmitted: null,
        residentTime: null
    };
    this._telemetryByKey.set(key, telemetry);

    // This priority only orders candidates *within* _refinementQueue — it
    // is never compared against _generationQueue's (geometry's) priority
    // numbers directly, since the two queues are admitted separately (see
    // tickGeneration/_tickRefinement). What actually matters for plan
    // §1.2's "visible refinement outranks predictive geometry" is the
    // *admission* side: _tickRefinement grants a near tile's refinement
    // its own small reserve, independent of whatever geometry is doing.
    // Here, just make sure that reserve (when available) and any leftover
    // shared budget both go to the closest candidates first — continuous
    // by distance, not a binary near/far split, so even among "far" tiles
    // the closest still refines first when there's spare budget.
    const priority = Number.isFinite(distanceInTileWidths)
        ? -distanceInTileWidths
        : 0; // unknown camera context (e.g. cold start) — neutral, not pushed to the back

    const request = this._refinementQueue.request(key, priority, async () => {
        const now = performance.now();
        telemetry.queueTime = now;
        telemetry.generationStart = now;
        this._tileState.set(key, 'REFINING');

        // A tile can go irrelevant (camera moved on) while sitting in the
        // refinement queue. It's still resident (ancestor-fallback-quality,
        // via its geometry), so there's no correctness issue — just don't
        // spend GPU time refining something nobody's looking at right now.
        //
        // NOT re-queued unconditionally here (that caused a confirmed
        // livelock before — see _refinementVisibleDropRetryMap's comment in
        // the constructor). Instead, added to a separate retry map that
        // _retryVisibleDroppedRefinements() only acts on once the tile is
        // STRICTLY visible again — cheap to recheck repeatedly, and only
        // consumes a real refinement queue slot for the much smaller
        // currently-visible subset, which is what actually needs healing
        // (a tile stuck resident-but-never-refined forever after the camera
        // settles on it — confirmed via debug mode 102 + idle telemetry).
        if (!this._describeTileDemandState(tileAddr, key).relevant) {
            this._telemetryByKey.delete(key);
            this._tileState.set(key, 'RESIDENT');
            this._refinementVisibleDropRetryMap.set(key, tileAddr);
            // Instrumentation (2026-10-01): counts refinement drops by tile
            // depth, to test whether LOD4-depth tiles are disproportionately
            // dropped here before ever completing refinement — the leading
            // hypothesis for why resolvedColor reads as permanently invalid
            // (alpha<0.5) on LOD4 (confirmed via debug mode 102: LOD4 forced
            // through LOD5's exact resolvedColor path still always falls
            // back, everywhere, not just at the seam). See consumePressureWindow().
            this._refinementDropByDepthWindow.set(
                tileAddr.depth,
                (this._refinementDropByDepthWindow.get(tileAddr.depth) || 0) + 1
            );
            return false;
        }

        try {
            const textures = await this.tileGenerator.generateTile(tileAddr, telemetry, refinementTypes);
            if (Number.isFinite(telemetry.computeSubmitted)) {
                this._stageLatency.startToSubmit.push(telemetry.computeSubmitted - telemetry.generationStart);
            }
            if (!this._tileInfo.has(key)) {
                // Evicted while refinement was generating.
                this._destroyGeneratedTextures(textures);
                this._telemetryByKey.delete(key);
                return false;
            }
            const committed = this._commitRefinement(tileAddr, textures, telemetry);
            this._tileState.set(key, committed ? 'REFINED' : 'RESIDENT');
            return committed;
        } catch (error) {
            this._telemetryByKey.delete(key);
            this._tileState.set(key, 'RESIDENT');
            throw error;
        }
    });
    if (request === null) {
        // AsyncGenerationQueue.request() returns null when the refinement
        // queue is at capacity (maxQueueSize). Previously this just counted
        // the rejection and moved on — nothing ever asked again, so a tile
        // unlucky enough to arrive during a full queue stayed resident with
        // its material permanently zero-filled (black terrain, confirmed via
        // debug-mode elimination: geometry/normals/lighting all proved
        // correct, only baseColor was ever wrong, and only for tiles stuck
        // at _tileState 'RESIDENT' with no path back to 'REFINING'). Queue
        // it for retry instead of abandoning it.
        this._telemetryByKey.delete(key);
        this._refinementRejectWindowCount++;
        this._refinementRetryMap.set(key, tileAddr);
    }
}

// Tiles whose refinement request was dropped because the queue was at
// capacity (AsyncGenerationQueue.request() returned null) get one more
// chance each tick instead of staying resident with unrefined (zero-filled)
// material forever. Bounded per tick so a large backlog drains gradually
// rather than flooding _refinementQueue back to capacity in one frame; a
// still-evicted tile is simply dropped (checked via _tileInfo, same as
// _queueRefinement's own entry guard) rather than retried indefinitely.
// Unconditional (no visibility filter) — queue-full is a capacity problem,
// not correlated with visibility, so there's no livelock risk here the way
// there is for the "not relevant" case (see _retryVisibleDroppedRefinements).
_retryDroppedRefinements() {
    if (this._refinementRetryMap.size === 0) return;
    const maxRetriesPerTick = 16;
    let attempted = 0;
    for (const [key, tileAddr] of this._refinementRetryMap) {
        if (attempted >= maxRetriesPerTick) break;
        this._refinementRetryMap.delete(key);
        attempted++;
        if (!this._tileInfo.has(key)) continue; // evicted since — nothing left to refine
        this._queueRefinement(tileAddr);
    }
}

// Tiles whose refinement request was dropped because they were no longer
// "relevant" at dequeue time (see _queueRefinement's !relevant branch).
// Unlike _retryDroppedRefinements above, this CANNOT unconditionally
// re-queue every entry — most resident tiles are "relevant" via ancestor/
// descendant leniency at any given moment (far outnumbering strictly-visible
// ones), so doing that reintroduced a confirmed livelock (frozen refinement
// throughput, proven via telemetry, not guessed).
//
// Instead: the demand-state check itself is cheap (no GPU/queue involved),
// so it's fine to recheck every entry every tick. Only entries that are
// STRICTLY visible right now (demand reason === 'visible', not merely
// ancestor/descendant-relevant) actually get pushed back into
// _queueRefinement — the one operation that consumes real refinement
// throughput. Everything else is left in the map for a future tick's
// recheck rather than being retried or dropped outright, so a tile that
// becomes visible later still eventually heals. Evicted tiles are removed.
// No per-tick cap on re-queues: in steady state only a handful of tiles are
// ever newly-visible-and-unrefined at once, so this doesn't reproduce the
// livelock's "flood the queue every tick" failure mode.
_retryVisibleDroppedRefinements() {
    if (this._refinementVisibleDropRetryMap.size === 0) return;
    for (const [key, tileAddr] of this._refinementVisibleDropRetryMap) {
        if (!this._tileInfo.has(key)) {
            this._refinementVisibleDropRetryMap.delete(key);
            continue; // evicted since — nothing left to refine
        }
        if (this._describeTileDemandState(tileAddr, key).reason !== 'visible') {
            continue; // still not strictly visible — recheck next tick
        }
        this._refinementVisibleDropRetryMap.delete(key);
        this._queueRefinement(tileAddr);
    }
}

// Writes refinement-stage textures (splat/climate/scatter/...) into a tile's
// *existing* array-pool layer — no new layer allocation, no hash-table
// change, since the tile is already resident from its geometry commit.
_commitRefinement(tileAddr, textures, telemetry = null) {
    const key = tileAddr.toString();
    const info = this._tileInfo.get(key);
    if (!info || !this.arrayPool) {
        this._destroyGeneratedTextures(textures);
        return false;
    }

    // Not zero-fill here: this commit only ever carries refinement types,
    // and the geometry types in the same layer are already correct from
    // the initial commit — copying only what's present (the existing,
    // non-zero-fill queueCopyToLayer behavior) is exactly right.
    // A flat-tier tile's refinement carries no detail material, so it never
    // makes the layer a valid material source for detail tiers.
    const solidTier = this._isSolidTierDepth(tileAddr.depth);
    this.arrayPool.queueCopyToLayer(textures, info.layer, { completesMaterial: !solidTier });
    if (telemetry) {
        telemetry.copySubmitted = performance.now();
        telemetry.residentTime = performance.now();
    }
    info.lastUsed = performance.now();

    if (this._refinementTypesFor(tileAddr).includes('scatter')) {
        this._scatterCommitQueue.push({
            face: tileAddr.face, depth: tileAddr.depth,
            x: tileAddr.x, y: tileAddr.y, layer: info.layer,
        });
    }
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
    // Tiles newly entering the visible set this readback are exactly the
    // "newlyVisibleTiles" denominator for request amplification (plan §0.2).
    this._newlyVisibleTilesWindowCount += entered;

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

        // ── Phase 0 additions: candidate-cause breakdown (plan §0.2-0.4) ──
        const stageLatency = {
            queueWait: this._stageLatency.queueWait.consume(),
            startToSubmit: this._stageLatency.startToSubmit.consume(),
            submitToFence: this._stageLatency.submitToFence.consume(),
            requestToResident: this._stageLatency.requestToResident.consume()
        };
        const requestedTiles = this._requestedTilesWindowCount;
        const newlyVisibleTiles = this._newlyVisibleTilesWindowCount;
        const requestAmplification = newlyVisibleTiles > 0
            ? requestedTiles / newlyVisibleTiles
            : null;
        const wastedGenerations = this._wastedGenerationsWindowCount;
        const computeSubmissions = this.tileGenerator?.consumeSubmissionCount?.() ?? 0;
        const copyOperations = this._copyOperationsWindowCount;
        const generationQueueDepth = this._generationQueue.queue.length;
        const generationQueueActive = this._generationQueue.active;
        const pendingCopyCount = this.arrayPool?._pendingCopies?.length ?? 0;
        const tilePoolUsed = this._tileInfo.size;
        const tilePoolCapacity = this.tilePoolSize;
        const tilePoolFree = this.arrayPool?.freeLayers?.length ?? null;

        // Phase 2: background refinement pressure, separate from geometry
        // admission above (plan §2/§1.2 — refinement is always subordinate).
        const refinementQueueDepth = this._refinementQueue.queue.length;
        const refinementQueueActive = this._refinementQueue.active;
        const refinementDropped = this._refinementQueue.consumeDroppedCount();
        const refinementRejected = this._refinementRejectWindowCount;
        let tileStateCounts = null;
        for (const state of this._tileState.values()) {
            if (!tileStateCounts) tileStateCounts = {};
            tileStateCounts[state] = (tileStateCounts[state] ?? 0) + 1;
        }

        this._requestedTilesWindowCount = 0;
        this._newlyVisibleTilesWindowCount = 0;
        this._wastedGenerationsWindowCount = 0;
        this._copyOperationsWindowCount = 0;
        this._refinementRejectWindowCount = 0;

        // Instrumentation (2026-10-01): refinement jobs dropped as "not
        // relevant" at dequeue, broken out by tile depth — tests whether
        // LOD4-depth tiles are disproportionately starved of refinement
        // (leading hypothesis for resolvedColor reading as permanently
        // invalid on LOD4; see the drop site in _queueRefinement).
        const refinementDroppedByDepth = {};
        for (const [depth, count] of this._refinementDropByDepthWindow) {
            refinementDroppedByDepth[depth] = count;
        }
        this._refinementDropByDepthWindow.clear();

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
            gpuFencesMax,
            stageLatency,
            requestedTiles,
            newlyVisibleTiles,
            requestAmplification,
            wastedGenerations,
            computeSubmissions,
            copyOperations,
            generationQueueDepth,
            generationQueueActive,
            pendingCopyCount,
            tilePoolUsed,
            tilePoolCapacity,
            tilePoolFree,
            refinementQueueDepth,
            refinementQueueActive,
            refinementDropped,
            refinementRejected,
            refinementDroppedByDepth,
            // Instrumentation (2026-10-01): direct visibility into whether
            // _retryVisibleDroppedRefinements is doing anything. Always
            // present (not just when nonzero), unlike refinementDroppedByDepth,
            // specifically so we can see it SHRINK over time (healing working)
            // vs stay flat/grow (not working) rather than just knowing it's
            // nonzero at one instant.
            refinementVisibleDropRetryMapSize: this._refinementVisibleDropRetryMap.size,
            tileStateCounts
        };
    }

    getLoadedLayer(face, depth, x, y) {
        const info = this._tileInfo.get(this._makeKey(face, depth, x, y));
        return info?.layer ?? null;
    }

    getLastVisibleTiles() {
        return Array.isArray(this._lastVisibleTilesList) ? this._lastVisibleTilesList : null;
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
        const { staging, buffer } = await this._readArrayLayerSample(
            texture,
            layer,
            size,
            bytesPerRow,
            bufferSize
        );

        const stats = this._summarizeArrayLayerStats(
            new DataView(buffer),
            format,
            size,
            bytesPerRow,
            texelBytes,
            threshold
        );
        staging.unmap();
        staging.destroy();

        return {
            type,
            layer,
            format,
            size,
            ...stats
        };
    }

    async _readArrayLayerSample(texture, layer, size, bytesPerRow, bufferSize) {
        const staging = this.device.createBuffer({
            size: bufferSize,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        });

        const encoder = this.device.createCommandEncoder();
        encoder.copyTextureToBuffer(
            { texture: texture, origin: { x: 0, y: 0, z: layer } },
            { buffer: staging, bytesPerRow: bytesPerRow },
            { width: size, height: size, depthOrArrayLayers: 1 }
        );
        this.device.queue.submit([encoder.finish()]);
        await this.device.queue.onSubmittedWorkDone();

        await staging.mapAsync(GPUMapMode.READ);
        return { staging, buffer: staging.getMappedRange() };
    }

    _summarizeArrayLayerStats(dataView, format, size, bytesPerRow, texelBytes, threshold) {
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
                const values = readTexel(dataView, offset, format);
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

        const mean = sum.map(v => (count ? v / count : 0));
        for (let c = 0; c < channels; c++) {
            if (!Number.isFinite(min[c])) { min[c] = 0; max[c] = 0; }
        }

        return {
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

    _debugArrayTextureSource(type) {
        if (!this.arrayPool) return null;

        const poolTexture = this.arrayPool.textures.get(type);
        if (poolTexture) {
            return {
                texture: poolTexture,
                format: this.textureFormats[type] || this.arrayPool.formats?.[type] || 'rgba32float',
            };
        }

        const external = this._externalArrayTextures?.[type];
        const externalTexture = external?._gpuTexture?.texture;
        if (!externalTexture) return null;

        return {
            texture: external,
            format: external?._gpuTexture?.format
                || external?._gpuFormat
                || this.textureFormats[type]
                || this.arrayPool.formats?.[type]
                || 'rgba32float',
        };
    }

    _debugTextureDimensions(textureLike) {
        return {
            width: Math.max(1, Math.floor(textureLike?.width ?? this.tileTextureSize)),
            height: Math.max(1, Math.floor(textureLike?.height ?? this.tileTextureSize)),
        };
    }

    async debugReadArrayLayerTexels(type, layer, texelCoords = []) {
        if (layer === null || layer === undefined) return null;
        const source = this._debugArrayTextureSource(type);
        if (!source) return null;

        const textureLike = source.texture;
        const texture = textureLike?._gpuTexture?.texture || textureLike;
        const { format } = source;
        if (!texture) return null;

        const texelBytes = gpuFormatBytesPerTexel(format);
        if (!Number.isFinite(texelBytes) || texelBytes <= 0) return null;

        const coords = Array.isArray(texelCoords) ? texelCoords : [];
        const { width, height } = this._debugTextureDimensions(textureLike);
        const results = [];

        for (const coord of coords) {
            const x = Math.max(0, Math.min(width - 1, Math.floor(coord?.x ?? 0)));
            const y = Math.max(0, Math.min(height - 1, Math.floor(coord?.y ?? 0)));
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
                { width: 1, height: 1, depthOrArrayLayers: 1 }
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
        if (layer === null || layer === undefined) return null;
        const source = this._debugArrayTextureSource(type);
        if (!source) return null;

        return this._debugReadTextureBuffer(source.texture, source.format, width, height, layer);
    }

    async _debugReadTextureTexels(textureLike, format, texelCoords = [], layer = null) {
        const { width, height } = this._debugTextureDimensions(textureLike);
        const texture = textureLike?._gpuTexture?.texture || textureLike;
        if (!texture) return null;

        const texelBytes = gpuFormatBytesPerTexel(format);
        if (!Number.isFinite(texelBytes) || texelBytes <= 0) return null;

        const coords = Array.isArray(texelCoords) ? texelCoords : [];
        const results = [];

        for (const coord of coords) {
            const x = Math.max(0, Math.min(width - 1, Math.floor(coord?.x ?? 0)));
            const y = Math.max(0, Math.min(height - 1, Math.floor(coord?.y ?? 0)));
            const bytesPerRow = 256;
            const staging = this.device.createBuffer({
                size: bytesPerRow,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
            });

            const encoder = this.device.createCommandEncoder();
            encoder.copyTextureToBuffer(
                { texture, origin: { x, y, z: layer ?? 0 } },
                { buffer: staging, bytesPerRow },
                { width: 1, height: 1, depthOrArrayLayers: 1 }
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
        const dimensions = this._debugTextureDimensions(textureLike);
        const texture = textureLike?._gpuTexture?.texture || textureLike;
        if (!texture) return null;

        const texelBytes = gpuFormatBytesPerTexel(format);
        if (!Number.isFinite(texelBytes) || texelBytes <= 0) return null;

        const copyWidth = Math.max(1, Math.min(dimensions.width, Math.floor(width ?? dimensions.width)));
        const copyHeight = Math.max(1, Math.min(dimensions.height, Math.floor(height ?? dimensions.height)));
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
            { width: copyWidth, height: copyHeight, depthOrArrayLayers: 1 }
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
        // eslint-disable-next-line no-unreachable
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
                    try { if (tex?._gpuTexture?.texture) tex._gpuTexture.texture.destroy(); } catch { /* ignore cleanup failure */ }
                    try { if (typeof tex.dispose === 'function') tex.dispose(); } catch { /* ignore cleanup failure */ }
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
