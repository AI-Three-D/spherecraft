// js/world/quadtree/TileCache.js
//
// Texture storage for the tile-based quadtree system.
//
// Responsibilities:
//   • Store generated textures keyed by (TileAddress, textureType).
//   • Track memory usage and enforce a byte budget via LRU eviction.
//   • Apply depth-based residency bias: coarser tiles (low depth) are
//     retained longer because they cover more world-space area and
//     leaving them missing produces visibly large holes.
//   • Defer GPU texture destruction by a few frames to avoid
//     "destroyed texture used in a pending command buffer" errors.
//
// Relationship to existing TextureCache:
//   TileCache is the canonical store for the GPU quadtree path.
//   During the transition period (Iteration 10), any tile that is
//   also needed by legacy code can be bridged through TextureCache
//   via an optional writeThrough callback. Once the CPU path is
//   fully retired the bridge can be removed.

import { Logger } from '../../config/Logger.js';

// ─── Entry stored per (tileAddress, type) ────────────────────────────────────

class TileCacheEntry {
    /**
     * @param {object} texture     The Texture resource (has _gpuTexture, dispose)
     * @param {number} sizeBytes   GPU memory footprint in bytes
     * @param {number} depth       Quadtree depth of the owning tile (for residency)
     */
    constructor(texture, sizeBytes, depth) {
        this.texture       = texture;
        this.sizeBytes     = sizeBytes;
        this.depth         = depth;
        this.lastAccessed  = performance.now();
        this.created       = performance.now();
    }
}

// ─── Main cache ───────────────────────────────────────────────────────────────

export class TileCache {
    /**
     * @param {object} [options]
     * @param {number}   [options.maxBytes=2GB]         Total GPU budget in bytes
     * @param {string[]} [options.requiredTypes]        Types that must all be present
     *                                                  for hasComplete() to return true
     * @param {number[]} [options.residencyMs]          Per-depth minimum retention time
     *                                                  (index = depth).  Entries younger
     *                                                  than their residency window are
     *                                                  effectively pinned.
     * @param {Function} [options.onEvict]              Called with (tileAddr, type, entry)
     *                                                  just before an entry is removed.
     *                                                  Useful for bridge callbacks.
     * @param {Function} [options.writeThrough]         Called with (tileAddr, type, texture,
     *                                                  sizeBytes) on every set(). Use to
     *                                                  mirror into legacy TextureCache.
     */
    constructor(options = {}) {
        this.maxBytes        = options.maxBytes        ?? 2 * 1024 * 1024 * 1024;
        this.requiredTypes   = options.requiredTypes   ?? ['height', 'tile', 'normal', 'splatData'];
        this._residencyMs    = options.residencyMs     ?? TileCache._defaultResidency();
        this._onEvict        = options.onEvict         ?? null;
        this._writeThrough   = options.writeThrough    ?? null;

        /** @type {Map<string, TileCacheEntry>} */
        this._cache = new Map();

        /** Current total bytes held */
        this._currentBytes = 0;

        // ── Deferred destruction ──────────────────────────────────────────────
        // GPU commands referencing a texture may still be in flight when the
        // cache evicts it.  Queue destructions and process them a few frames
        // later so the GPU has time to finish.
        /** @type {Array<{texture: object, framesRemaining: number}>} */
        this._pendingDestructions = [];
        this._destructionDelayFrames = 3;

        // ── Logging ───────────────────────────────────────────────────────────
        this._logStatsEnabled = options.logStats === true;
        this._logFrame    = 0;
        this._logInterval = 180;  // frames between periodic stat logs

        // ── Stats ─────────────────────────────────────────────────────────────
        this._stats = { hits: 0, misses: 0, evictions: 0 };
    }

    // ─── Core operations ────────────────────────────────────────────────────

    /**
     * Store a texture for the given tile and type.
     * Replaces any existing entry for the same key (old texture is deferred-destroyed).
     *
     * @param {TileAddress} tileAddr
     * @param {string}      type      e.g. 'height', 'tile', 'normal', 'splatData'
     * @param {object}      texture   Texture resource
     * @param {number}      sizeBytes GPU footprint
     */
    set(tileAddr, type, texture, sizeBytes) {
        const key = this._makeKey(tileAddr, type);

        // Evict old occupant if present
        const old = this._cache.get(key);
        if (old) {
            this._currentBytes -= old.sizeBytes;
            this._deferDestroy(old.texture);
        }

        const entry = new TileCacheEntry(texture, sizeBytes, tileAddr.depth);
        this._cache.set(key, entry);
        this._currentBytes += sizeBytes;

        // Optional write-through to legacy cache
        if (this._writeThrough) {
            this._writeThrough(tileAddr, type, texture, sizeBytes);
        }

        this._evictIfNeeded();
    }

    /**
     * Retrieve a texture.
     * Updates the LRU timestamp on hit.
     *
     * @param {TileAddress} tileAddr
     * @param {string}      type
     * @returns {object|null}  Texture or null
     */
    get(tileAddr, type) {
        const key = this._makeKey(tileAddr, type);
        const entry = this._cache.get(key);

        if (!entry) {
            this._stats.misses++;
            return null;
        }

        entry.lastAccessed = performance.now();
        this._stats.hits++;
        return entry.texture;
    }

    /**
     * Check whether a single (tile, type) entry exists.
     *
     * @param {TileAddress} tileAddr
     * @param {string}      type
     * @returns {boolean}
     */
    has(tileAddr, type) {
        return this._cache.has(this._makeKey(tileAddr, type));
    }

    /**
     * Check whether ALL required types are present for this tile.
     *
     * @param {TileAddress} tileAddr
     * @returns {boolean}
     */
    hasComplete(tileAddr) {
        for (const type of this.requiredTypes) {
            if (!this._cache.has(this._makeKey(tileAddr, type))) return false;
        }
        return true;
    }

    /**
     * Return the list of required types that are missing for this tile.
     * Empty array means the tile is complete.
     *
     * @param {TileAddress} tileAddr
     * @returns {string[]}
     */
    getMissingTypes(tileAddr) {
        const missing = [];
        for (const type of this.requiredTypes) {
            if (!this._cache.has(this._makeKey(tileAddr, type))) {
                missing.push(type);
            }
        }
        return missing;
    }

    // ─── LRU management ─────────────────────────────────────────────────────

    /**
     * Refresh the LRU timestamp for all types of this tile.
     * Called by the instance buffer writer when a tile is rendered.
     *
     * @param {TileAddress} tileAddr
     */
    touch(tileAddr) {
        const now = performance.now();
        for (const type of this.requiredTypes) {
            const entry = this._cache.get(this._makeKey(tileAddr, type));
            if (entry) entry.lastAccessed = now;
        }
    }

    /**
     * Mark a tile as no longer actively needed.
     * Pushes lastAccessed into the past so the tile becomes eligible for
     * eviction on the next budget sweep, respecting the depth-residency floor.
     *
     * The tile is NOT removed immediately — it stays cached in case the
     * camera returns to this area soon (hysteresis).
     *
     * @param {TileAddress} tileAddr
     */
    release(tileAddr) {
        const now = performance.now();
        for (const type of this.requiredTypes) {
            const entry = this._cache.get(this._makeKey(tileAddr, type));
            if (entry) {
                const residency = this._getResidencyMs(entry.depth);
                // Push lastAccessed back past the residency window
                entry.lastAccessed = now - residency - 1000;
            }
        }
    }

    // ─── Deferred destruction ─────────────────────────────────────────────

    /**
     * Process pending texture destructions.
     * Must be called once per frame (e.g. at the top of Frontend.render()).
     */
    processDeferredDestructions() {
        const remaining = [];
        for (const item of this._pendingDestructions) {
            item.framesRemaining--;
            if (item.framesRemaining <= 0) {
                this._destroyTexture(item.texture);
            } else {
                remaining.push(item);
            }
        }
        this._pendingDestructions = remaining;
    }

    // ─── Periodic logging ─────────────────────────────────────────────────

    /**
     * Call once per frame.  Logs cache stats at a throttled interval.
     */
    tick() {
        this.processDeferredDestructions();
        if (!this._logStatsEnabled) return;

        this._logFrame++;
        if (this._logFrame >= this._logInterval) {
            this._logFrame = 0;
            this._logStats();
        }
    }

    // ─── Stats ────────────────────────────────────────────────────────────

    /**
     * @returns {object} Snapshot of cache statistics
     */
    getStats() {
        const totalLookups = this._stats.hits + this._stats.misses;
        return {
            hits:      this._stats.hits,
            misses:    this._stats.misses,
            evictions: this._stats.evictions,
            entries:   this._cache.size,
            bytesUsed: this._currentBytes,
            bytesMax:  this.maxBytes,
            hitRate:   totalLookups > 0 ? (this._stats.hits / totalLookups) : 0,
            pendingDestructions: this._pendingDestructions.length
        };
    }

    /**
     * Destroy all cached textures and reset state.
     */
    clear() {
        for (const entry of this._cache.values()) {
            this._destroyTexture(entry.texture);
        }
        this._cache.clear();
        this._currentBytes = 0;

        for (const item of this._pendingDestructions) {
            this._destroyTexture(item.texture);
        }
        this._pendingDestructions = [];
    }

    // ─── Internal ─────────────────────────────────────────────────────────

    /**
     * Flat string key for Map lookups.
     * Format: "{tileAddr.toString()}:{type}"
     * e.g.    "f2:d3:4,5:height"
     */
    _makeKey(tileAddr, type) {
        return `${tileAddr.toString()}:${type}`;
    }

    /**
     * Look up the residency window for a given depth.
     * Clamps to the last element if depth exceeds the array length.
     */
    _getResidencyMs(depth) {
        const idx = Math.min(depth, this._residencyMs.length - 1);
        return this._residencyMs[idx];
    }

    /**
     * Evict entries until we are at or below the budget target.
     *
     * Strategy:
     *   1. Sort all entries by eviction priority (higher = evict first).
     *   2. Entries within their residency window get priority −∞ (pinned).
     *   3. Beyond residency, priority = age + depth × depthPenalty.
     *      Deeper (finer) tiles accumulate priority faster → evict sooner.
     *   4. Evict until currentBytes ≤ 85% of maxBytes (hysteresis band).
     */
    _evictIfNeeded() {
        if (this._currentBytes <= this.maxBytes) return;

        const now    = performance.now();
        const target = this.maxBytes * 0.85;
        const DEPTH_PENALTY = 5000; // ms added per depth level

        // Build candidate list with eviction priority
        const candidates = [];
        for (const [key, entry] of this._cache) {
            const residencyMs = this._getResidencyMs(entry.depth);
            const age         = now - entry.lastAccessed;

            let priority;
            if (age < residencyMs) {
                // Within residency window — effectively pinned
                priority = -1e15;
            } else {
                // Eligible: older + deeper = higher eviction priority
                priority = age + entry.depth * DEPTH_PENALTY;
            }

            candidates.push({ key, entry, priority });
        }

        // Highest priority first (most evictable)
        candidates.sort((a, b) => b.priority - a.priority);

        while (this._currentBytes > target && candidates.length > 0) {
            const { key, entry, priority } = candidates.shift();

            // Stop if all remaining candidates are pinned
            if (priority < 0) break;

            // Notify callback before removal
            if (this._onEvict) {
                this._onEvict(key, entry);
            }

            // Defer texture destruction
            this._deferDestroy(entry.texture);

            this._cache.delete(key);
            this._currentBytes -= entry.sizeBytes;
            this._stats.evictions++;
        }
    }

    /**
     * Queue a texture for destruction after a few frames.
     */
    _deferDestroy(texture) {
        if (!texture) return;
        this._pendingDestructions.push({
            texture,
            framesRemaining: this._destructionDelayFrames
        });
    }

    /**
     * Actually destroy a texture's GPU resources.
     */
    _destroyTexture(texture) {
        if (!texture) return;
        try {
            if (texture._gpuTexture && texture._gpuTexture.texture) {
                texture._gpuTexture.texture.destroy();
            }
        } catch (_) { /* ignore — may already be destroyed */ }
        try {
            if (typeof texture.dispose === 'function') texture.dispose();
        } catch (_) { /* ignore */ }
    }

    /**
     * Periodic stats log.
     */
    _logStats() {
        const s = this.getStats();
        const usedMB = (s.bytesUsed / (1024 * 1024)).toFixed(1);
        const maxMB  = (s.bytesMax  / (1024 * 1024)).toFixed(1);
        Logger.info(
            `[TileCache] entries=${s.entries} | ` +
            `used=${usedMB}MB / ${maxMB}MB | ` +
            `hits=${s.hits} misses=${s.misses} evictions=${s.evictions} | ` +
            `hitRate=${(s.hitRate * 100).toFixed(1)}% | ` +
            `pendingDestroy=${s.pendingDestructions}`
        );
    }

    // ─── Static helpers ─────────────────────────────────────────────────────

    /**
     * Default per-depth residency windows (milliseconds).
     *
     * Logic: coarser tiles cover exponentially more area, so evicting one
     * leaves a proportionally larger visual hole.  The decay is geometric:
     * each depth level roughly halves the retention time, floored at 2 seconds
     * to avoid pathological churn on the finest tiles.
     *
     * Depth 0  (whole face)     : 120 s
     * Depth 5  (~13% of face)   : ~25 s
     * Depth 10 (~0.1% of face)  : ~7 s
     * Depth 14 (finest tile)    : 2 s
     *
     * @returns {number[]}  Array indexed by depth
     */
    static _defaultResidency() {
        const result = [];
        for (let d = 0; d <= 20; d++) {
            // 120 seconds at depth 0, decay factor 0.75 per depth
            result.push(Math.max(2000, Math.round(120000 * Math.pow(0.75, d))));
        }
        return result;
    }
}
