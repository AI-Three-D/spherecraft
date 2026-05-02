// js/texture/textureCache.js

import { TextureAtlasKey } from '../world/textureAtlasKey.js';
import { LODTextureAtlasKey } from '../world/lodTextureAtlasKey.js';
import { gpuFormatIsFilterable, gpuFormatToWrapperFormat } from '../renderer/resources/texture.js';
import { Texture, TextureFormat, TextureFilter } from '../renderer/resources/texture.js';
import { MipmapGenerator } from './MipmapGenerator.js';
class TextureArrayPool {
    constructor(device, slots, textureSize, format = 'rgba32float', type = null) {
        

        this.device = device;
        this.slots = slots;
        this.textureSize = textureSize;
        this.format = format;
        this.type = type;
        this.texture = device.createTexture({
            size: [textureSize, textureSize, slots],
            format,
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC
        });
        this.wrapper = null;
    }

    getWrapper() {
        if (!this.wrapper) {
            // Filter = type intent ∩ format capability
            const wantsNearestByType = this.type === 'height' || this.type === 'tile';
            const filterable = gpuFormatIsFilterable(this.format);
            const useNearest = wantsNearestByType || !filterable;
            const filter = useNearest ? TextureFilter.NEAREST : TextureFilter.LINEAR;

            const wrap = new Texture({
                width: this.textureSize,
                height: this.textureSize,
                depth: this.slots,
                format: gpuFormatToWrapperFormat(this.format),   // ← was TextureFormat.RGBA32F
                minFilter: filter,
                magFilter: filter,
                generateMipmaps: false
            });
            wrap._gpuTexture = {
                texture: this.texture,
                view: this.texture.createView({ dimension: '2d-array' }),
                format: this.format
            };
            wrap._needsUpload = false;
            wrap._isArray = true;
            wrap._isGPUOnly = true;
            wrap._gpuFormat = this.format;
            wrap._isFilterable = filterable;
            this.wrapper = wrap;
        }
        return this.wrapper;
    }
    copyFrom(sourceTexture, layer) {
        const src = sourceTexture?._gpuTexture?.texture || sourceTexture;
        if (!src || !this.texture) return;
        const encoder = this.device.createCommandEncoder();
        encoder.copyTextureToTexture(
            { texture: src },
            { texture: this.texture, origin: { x: 0, y: 0, z: layer } },
            { width: this.textureSize, height: this.textureSize, depthOrArrayLayers: 1 }
        );
        this.device.queue.submit([encoder.finish()]);
    }

    destroy() {
        if (this.texture) {
            try { this.texture.destroy(); } catch (_) {}
        }
        this.texture = null;
        this.wrapper = null;
    }
}

class LODAtlasPool {
    constructor(device, lod, poolConfig, types, formats = {}) {
        this.device = device;
        this.lod = lod;
        this.slots = poolConfig.slots;
        this.textureSize = poolConfig.textureSize;
        this.types = types;
        this.formats = formats;
        this.typePools = new Map();
        for (const type of types) {
            const format = formats[type] || 'rgba32float';
            this.typePools.set(type,
                new TextureArrayPool(device, this.slots, this.textureSize, format, type));
        }
        this.slotEntries = Array.from({ length: this.slots }, () => ({ atlasKeyStr: null, lastUsed: 0 }));
        this.atlasToSlot = new Map();
    }

    allocate(atlasKeyStr, canEvict = null) {
        const now = performance.now();
        if (this.atlasToSlot.has(atlasKeyStr)) {
            const slot = this.atlasToSlot.get(atlasKeyStr);
            this.slotEntries[slot].lastUsed = now;
            return { slot, evictedAtlasKeyStr: null };
        }

        let slot = -1;
        for (let i = 0; i < this.slotEntries.length; i++) {
            if (!this.slotEntries[i].atlasKeyStr) {
                slot = i;
                break;
            }
        }

        let evictedAtlasKeyStr = null;
        if (slot === -1) {
            let oldestIndex = -1;
            let oldestTime = Infinity;
            for (let i = 0; i < this.slotEntries.length; i++) {
                const candidate = this.slotEntries[i];
                if (canEvict && candidate.atlasKeyStr && !canEvict(candidate.atlasKeyStr)) {
                    continue;
                }
                if (candidate.lastUsed < oldestTime) {
                    oldestTime = candidate.lastUsed;
                    oldestIndex = i;
                }
            }
            if (oldestIndex === -1) {
                return null;
            }
            slot = oldestIndex;
            evictedAtlasKeyStr = this.slotEntries[slot].atlasKeyStr;
            if (evictedAtlasKeyStr) {
                this.atlasToSlot.delete(evictedAtlasKeyStr);
            }
        }

        this.slotEntries[slot].atlasKeyStr = atlasKeyStr;
        this.slotEntries[slot].lastUsed = now;
        this.atlasToSlot.set(atlasKeyStr, slot);
        return { slot, evictedAtlasKeyStr };
    }

    canAllocate(atlasKeyStr, canEvict = null) {
        if (this.atlasToSlot.has(atlasKeyStr)) return true;
        if (!this.slotEntries.length) return false;
        for (let i = 0; i < this.slotEntries.length; i++) {
            if (!this.slotEntries[i].atlasKeyStr) return true;
        }
        if (!canEvict) return true;
        for (let i = 0; i < this.slotEntries.length; i++) {
            const candidate = this.slotEntries[i];
            if (!candidate.atlasKeyStr) return true;
            if (canEvict(candidate.atlasKeyStr)) return true;
        }
        return false;
    }

    touch(atlasKeyStr) {
        const slot = this.atlasToSlot.get(atlasKeyStr);
        if (slot === undefined) return;
        this.slotEntries[slot].lastUsed = performance.now();
    }

    getArrayTexture(type) {
        const pool = this.typePools.get(type);
        return pool ? pool.getWrapper() : null;
    }

    getSlotForAtlas(atlasKeyStr) {
        const slot = this.atlasToSlot.get(atlasKeyStr);
        return slot === undefined ? null : slot;
    }

    copyToArray(type, sourceTexture, layer) {
        const pool = this.typePools.get(type);
        if (!pool) return;
        pool.copyFrom(sourceTexture, layer);
    }

    clearMappings() {
        for (const entry of this.slotEntries) {
            entry.atlasKeyStr = null;
            entry.lastUsed = 0;
        }
        this.atlasToSlot.clear();
    }

    destroy() {
        for (const pool of this.typePools.values()) {
            pool.destroy();
        }
        this.typePools.clear();
        this.slotEntries = [];
        this.atlasToSlot.clear();
    }
}

class VirtualTexturePool {
    constructor(device, lodAtlasConfig) {
        this.device = device;
        this.lodAtlasConfig = lodAtlasConfig;
        if (!lodAtlasConfig?.atlasTextureTypes) {
            throw new Error('VirtualTexturePool requires lodAtlasConfig.atlasTextureTypes');
        }
        this.types = lodAtlasConfig.atlasTextureTypes;
        // Optional per-type format map. Missing entries default to rgba32float
        // at the LODAtlasPool level, so existing configs keep their behaviour.
        this.formats = lodAtlasConfig.atlasTextureFormats || {};
        this.lodPools = new Map();

        const poolConfig = lodAtlasConfig?.getPoolConfig
            ? lodAtlasConfig.getPoolConfig()
            : lodAtlasConfig?.poolConfig;
        if (!poolConfig) return;

        for (let lod = 0; lod < (lodAtlasConfig?.maxLODLevels || 0); lod++) {
            const cfg = poolConfig[lod];
            if (!cfg || !cfg.slots || !cfg.textureSize) continue;
            this.lodPools.set(lod,
                new LODAtlasPool(device, lod, cfg, this.types, this.formats));
        }
    }
    allocate(atlasKey, lod, canEvict = null) {
        const pool = this.lodPools.get(lod);
        if (!pool) return null;
        const atlasKeyStr = typeof atlasKey === 'string' ? atlasKey : atlasKey.toString();
        const allocation = pool.allocate(atlasKeyStr, canEvict);
        if (!allocation) return null;
        const { slot, evictedAtlasKeyStr } = allocation;
        const arrayTextures = {};
        for (const type of this.types) {
            arrayTextures[type] = pool.getArrayTexture(type);
        }
        return { layer: slot, arrayTextures, evictedAtlasKeyStr };
    }

    canAllocate(atlasKey, lod, canEvict = null) {
        const pool = this.lodPools.get(lod);
        if (!pool) return false;
        const atlasKeyStr = typeof atlasKey === 'string' ? atlasKey : atlasKey.toString();
        return pool.canAllocate(atlasKeyStr, canEvict);
    }

    touch(atlasKeyStr, lod) {
        const pool = this.lodPools.get(lod);
        if (!pool) return;
        pool.touch(atlasKeyStr);
    }

    getPool(lod) {
        return this.lodPools.get(lod) || null;
    }

    copyToArray(type, lod, sourceTexture, layer) {
        const pool = this.lodPools.get(lod);
        if (!pool) return;
        pool.copyToArray(type, sourceTexture, layer);
    }

    clearMappings() {
        for (const pool of this.lodPools.values()) {
            pool.clearMappings();
        }
    }

    destroy() {
        for (const pool of this.lodPools.values()) {
            pool.destroy();
        }
        this.lodPools.clear();
    }
}

export class TextureCache {
    constructor(maxSizeBytes = 2 * 1024 * 1024 * 1024) {
        this.cache = new Map();
        this.maxSizeBytes = maxSizeBytes;
        this.currentSizeBytes = 0;
        this.id = Math.random().toString(36).substr(2, 9);
        
        // Track atlas usage: Map<atlasKeyString, Set<chunkKeyString>>
        this.atlasUsage = new Map();
        
        // Atlas configs must be set explicitly.
        this.atlasConfig = null;
        this.lodAtlasConfig = null;

        // LOD residency / hysteresis policy: min time in cache and eviction bias per LOD
        // Index = LOD level. Values in milliseconds / bias units added to eviction priority.
        this.lodResidencyPolicy = {
            minTTLsMs: [5000, 15000, 120000, 600000, 3600000], // keep coarse and mid LODs much longer
            bias:      [0,    1000,  8000,   25000,   60000]  // larger bias = harder to evict
        };
        
        this.stats = {
            hits: 0,
            misses: 0,
            evictions: 0,
            atlasHits: 0,
            atlasMisses: 0
        };
        

        // Deferred destruction queue to avoid destroying textures still in GPU command buffers
        this._pendingDestructions = [];
        this._destructionDelayFrames = 3;

        this.device = null;
        this.virtualTexturePool = null;
        this._virtualTexturePoolConfig = null;
        this._evictedLODAtlases = new Set();
        this.blockWhenPoolFull = false;
    }

    _deferTextureDestruction(texture) {
        if (!texture || texture._isArray) return;
        this._pendingDestructions.push({
            texture,
            framesRemaining: this._destructionDelayFrames
        });
    }

    processDeferredDestructions() {
        const remaining = [];
        for (const item of this._pendingDestructions) {
            item.framesRemaining--;
            if (item.framesRemaining <= 0) {
                try {
                    if (item.texture?._gpuTexture?.texture) {
                        item.texture._gpuTexture.texture.destroy();
                    }
                    if (item.texture?.dispose) {
                        item.texture.dispose();
                    }
                } catch (e) {}
            } else {
                remaining.push(item);
            }
        }
        this._pendingDestructions = remaining;
    }

    setDevice(device) {
        this.device = device;
    }

    initializeLODAtlasPool(device, lodAtlasConfig) {
        if (!device || !lodAtlasConfig) return;
        this.device = device;
        if (this.virtualTexturePool) {
            this.virtualTexturePool.destroy();
        }
        const maxLayers = device.limits?.maxTextureArrayLayers;
        if (Number.isFinite(maxLayers) && lodAtlasConfig.poolConfig) {
            for (const [lod, cfg] of Object.entries(lodAtlasConfig.poolConfig)) {
                if (!cfg || !Number.isFinite(cfg.slots)) continue;
                if (cfg.slots > maxLayers) {
                    cfg.slots = maxLayers;
                }
            }
        }
        this.virtualTexturePool = new VirtualTexturePool(device, lodAtlasConfig);
        this._virtualTexturePoolConfig = lodAtlasConfig;
    }

    hasVirtualTexturePool() {
        return !!this.virtualTexturePool;
    }

    reservePooledLODAtlas(atlasKey) {
        if (!this.virtualTexturePool || !atlasKey) return null;
        const atlasKeyStr = atlasKey.toString();
        const canEvict = (candidateKey) => {
            const active = this.atlasUsage.get(candidateKey);
            return !active || active.size === 0;
        };
        const allocation = this.virtualTexturePool.allocate(atlasKeyStr, atlasKey.lod, canEvict);
        if (!allocation) return null;
        if (allocation.evictedAtlasKeyStr) {
            this._evictPooledLODAtlasEntries(allocation.evictedAtlasKeyStr, atlasKey.lod);
        }
        return allocation;
    }

    canReservePooledLODAtlas(atlasKey) {
        if (!this.virtualTexturePool || !atlasKey) return true;
        const atlasKeyStr = atlasKey.toString();
        const canEvict = (candidateKey) => {
            const active = this.atlasUsage.get(candidateKey);
            return !active || active.size === 0;
        };
        return this.virtualTexturePool.canAllocate(atlasKeyStr, atlasKey.lod, canEvict);
    }

    touchLODAtlas(atlasKeyStr, lod) {
        if (!this.virtualTexturePool || !atlasKeyStr || typeof lod !== 'number') return;
        const key = typeof atlasKeyStr === 'string' ? atlasKeyStr : atlasKeyStr.toString();
        this.virtualTexturePool.touch(key, lod);
    }

    isPooledAtlasCurrent(atlasKeyStr, lod, layer) {
        if (!this.virtualTexturePool || !atlasKeyStr || typeof lod !== 'number') return true;
        const key = typeof atlasKeyStr === 'string' ? atlasKeyStr : atlasKeyStr.toString();
        const pool = this.virtualTexturePool.getPool(lod);
        if (!pool) return false;
        const slot = pool.getSlotForAtlas(key);
        if (slot === null) return false;
        return slot === layer;
    }

    consumeEvictedLODAtlases() {
        if (!this._evictedLODAtlases || this._evictedLODAtlases.size === 0) return [];
        const entries = Array.from(this._evictedLODAtlases);
        this._evictedLODAtlases.clear();
        return entries;
    }

    deferTextureDestruction(texture) {
        this._deferTextureDestruction(texture);
    }

    /**
     * Set the LOD atlas configuration
     */
    setLODAtlasConfig(config) {
        this.lodAtlasConfig = config;
        // Ensure cache budget can hold at least the top-LOD atlases for all faces (5 texture types)
        const faces = 6;
        const bytesPerPixel = 16; // rgba32float
        const types = 5;
        const topLODBytes = config.baseTextureSize * config.baseTextureSize * bytesPerPixel * faces * types;

        // Account for all LOD levels so we don't immediately evict lower LODs
        let totalLODBytes = topLODBytes;
        if (config.getConfigForLOD) {
            totalLODBytes = 0;
            for (let lod = 0; lod < (config.maxLODLevels || 1); lod++) {
                const lodTexSize = config.getConfigForLOD(lod)?.textureSize || config.baseTextureSize;
                totalLODBytes += lodTexSize * lodTexSize * bytesPerPixel * faces * types;
            }
        }

        const targetBudget = Math.max(topLODBytes, totalLODBytes) * 1.2; // 20% headroom
        if (this.maxSizeBytes < targetBudget) {
            this.maxSizeBytes = targetBudget;
        }
    }

    /**
     * Override LOD residency/hysteresis policy
     * @param {{minTTLsMs:number[], bias:number[]}} policy 
     */
    setLODResidencyPolicy(policy = {}) {
        if (policy.minTTLsMs) this.lodResidencyPolicy.minTTLsMs = policy.minTTLsMs;
        if (policy.bias) this.lodResidencyPolicy.bias = policy.bias;
        
    }

    /**
     * Set the atlas configuration for this cache
     */
    setAtlasConfig(config) {
        this.atlasConfig = config;
        
    }

    _requireAtlasConfig(config, source) {
        const cfg = config || this.atlasConfig;
        if (!cfg) {
            throw new Error(`[TextureCache] ${source} requires atlasConfig`);
        }
        return cfg;
    }

    _requireLODAtlasConfig(config, source) {
        const cfg = config || this.lodAtlasConfig;
        if (!cfg) {
            throw new Error(`[TextureCache] ${source} requires lodAtlasConfig`);
        }
        return cfg;
    }

    /**
     * Store a LOD atlas texture
     * 
     * @param {LODTextureAtlasKey} atlasKey - LOD atlas key
     * @param {string} type - Texture type (height, normal, tile, etc.)
     * @param {Texture} texture - The texture to store
     * @param {number} sizeBytes - Size in bytes
     */
    setLODAtlas(atlasKey, type, texture, sizeBytes, arrayInfo = null) {
        const atlasKeyStr = atlasKey.toString();
        const key = `${type}_${atlasKeyStr}`;

        const sourceTexture = texture;
        let usePool = !arrayInfo && this.virtualTexturePool && typeof atlasKey?.lod === 'number';
        let isPooled = !!arrayInfo?.isPooled;
        if (usePool) {
            const canEvict = (candidateKey) => {
                const active = this.atlasUsage.get(candidateKey);
                return !active || active.size === 0;
            };
            const allocation = this.virtualTexturePool.allocate(atlasKeyStr, atlasKey.lod, canEvict);
            if (!allocation || !allocation.arrayTextures?.[type]) {
                if (this.blockWhenPoolFull) {
                    if (!this._poolFallbackWarned) this._poolFallbackWarned = new Set();
                    const warnKey = `${atlasKey.lod}:${type}`;
                    if (!this._poolFallbackWarned.has(warnKey)) {
                        this._poolFallbackWarned.add(warnKey);
                        
                    }
                    if (sourceTexture && sourceTexture !== texture) {
                        this._deferTextureDestruction(sourceTexture);
                    }
                    return;
                }
                usePool = false;
                if (!this._poolFallbackWarned) this._poolFallbackWarned = new Set();
                const warnKey = `${atlasKey.lod}:${type}`;
                if (!this._poolFallbackWarned.has(warnKey)) {
                    this._poolFallbackWarned.add(warnKey);
                    
                }
            } else {
                if (allocation.evictedAtlasKeyStr) {
                    this._evictPooledLODAtlasEntries(allocation.evictedAtlasKeyStr, atlasKey.lod);
                }
                this.virtualTexturePool.copyToArray(type, atlasKey.lod, sourceTexture, allocation.layer);
                arrayInfo = {
                    layer: allocation.layer,
                    arrayTexture: allocation.arrayTextures[type],
                    isPooled: true
                };
                texture = allocation.arrayTextures[type];
                sizeBytes = 0;
                isPooled = true;
                if (sourceTexture && sourceTexture !== texture && !this._isTextureReferenced(sourceTexture)) {
                    this._deferTextureDestruction(sourceTexture);
                }
            }
        }
        
        // Handle replacement - defer destruction to avoid destroying textures still in GPU command buffers
        if (this.cache.has(key)) {
            const old = this.cache.get(key);
            this.currentSizeBytes -= old.sizeBytes;

            if (old.arrayInfo?.release && !old.arrayInfo?.isPooled) {
                try { old.arrayInfo.release(); } catch (_) {}
            }

            // Avoid destroying shared array textures (other slices may be in use)
            const isSharedArray = old.texture?._isArray && old.arrayInfo;

            // Defer texture destruction by 3 frames to ensure GPU commands complete
            if (!isSharedArray) {
                this._deferTextureDestruction(old.texture);
            }
        }
        
        const entry = {
            texture,
            sizeBytes,
            lastAccess: performance.now(),
            created: performance.now(),
            type,
            isAtlas: true,
            isLODAtlas: true,
            lod: atlasKey.lod,
            atlasKey: atlasKey,
            isGPUOnly: texture._isGPUOnly || false,
            arrayInfo: arrayInfo || null,
            isPooled: isPooled
        };
        
        this.cache.set(key, entry);
        this.currentSizeBytes += sizeBytes;
        
        // Track usage
        if (!this.atlasUsage.has(atlasKeyStr)) {
            this.atlasUsage.set(atlasKeyStr, new Set());
        }
        
        this.evictIfNeeded();
    }

    /**
     * Get LOD atlas texture for a chunk at specified LOD level
     * 
     * @param {number} chunkX - Chunk X coordinate
     * @param {number} chunkY - Chunk Y coordinate
     * @param {string} type - Texture type
     * @param {number} lod - LOD level
     * @param {number|null} face - Cube face for spherical
     * @param {Object} config - LOD atlas config
     * @returns {Object|null} {texture, atlasKey, uvTransform} or null
     */
    getLODAtlasForChunk(chunkX, chunkY, type, lod, face = null, config = null) {
        const cfg = config || this.lodAtlasConfig;
        if (!cfg) {
            
            return null;
        }
        
        // Create atlas key for this chunk at the specified LOD
        const atlasKey = LODTextureAtlasKey.fromChunkCoords(chunkX, chunkY, lod, face, cfg);
        const cacheKey = `${type}_${atlasKey.toString()}`;
        
        const entry = this.cache.get(cacheKey);
        if (!entry) {
            this.stats.atlasMisses++;
            return null;
        }
        
        this.stats.atlasHits++;
        entry.lastAccess = performance.now();
        if (entry.arrayInfo?.isPooled) {
            this.virtualTexturePool?.touch(atlasKey.toString(), lod);
        }
        
        // Calculate UV transform
        const uvTransform = cfg.getChunkUVTransform(chunkX, chunkY, lod);

        // Track usage so eviction avoids active LOD atlases
        this._trackAtlasUsage(atlasKey.toString(), this._makeChunkUsageKey(chunkX, chunkY, lod, face));
        
        return {
            texture: entry.texture,
            atlasKey: atlasKey,
            arrayInfo: entry.arrayInfo || null,
            uvTransform: uvTransform,
            lod: lod
        };
    }

    /**
     * Check if LOD atlas exists for a chunk
     */
    hasLODAtlasForChunk(chunkX, chunkY, type, lod, face = null, config = null) {
        const cfg = config || this.lodAtlasConfig;
        if (!cfg) return false;
        
        const atlasKey = LODTextureAtlasKey.fromChunkCoords(chunkX, chunkY, lod, face, cfg);
        const cacheKey = `${type}_${atlasKey.toString()}`;
        
        return this.cache.has(cacheKey);
    }

    makeKey(textureXOrAtlasKey, textureY, type) {
        // Support TextureAtlasKey objects
        if (textureXOrAtlasKey instanceof TextureAtlasKey) {
            const key = type + '_' + textureXOrAtlasKey.toString();
            return key;
        }
        
        // Legacy: chunk coordinates
        const key = type + '_' + textureXOrAtlasKey + '_' + textureY;
        return key;
    }

    /**
     * Check if texture exists for given key
     */
    has(textureXOrAtlasKey, textureY, type) {
        const key = this.makeKey(textureXOrAtlasKey, textureY, type);
        return this.cache.has(key);
    }

    /**
     * Get texture by key.
     * Supports both legacy chunk coords and TextureAtlasKey.
     */
    get(chunkXOrAtlasKey, chunkY, type) {
        const key = this.makeKey(chunkXOrAtlasKey, chunkY, type);
        const entry = this.cache.get(key);
        
        if (entry) {
            entry.lastAccess = performance.now();
            this.stats.hits++;
            return entry.texture;
        }
        
        this.stats.misses++;
        return null;
    }

    /**
     * Store texture in cache.
     * Supports both legacy chunk coords and TextureAtlasKey.
     */
    set(chunkXOrAtlasKey, chunkY, type, texture, sizeBytes) {
        const key = this.makeKey(chunkXOrAtlasKey, chunkY, type);
        
        // Warn if adding very large texture
        if (sizeBytes > 100 * 1024 * 1024) {
        }
        
        // Check if this single texture exceeds budget
        if (sizeBytes > this.maxSizeBytes * 0.5) {
            
        }
        
        // Determine if this is an atlas key
        const isAtlas = chunkXOrAtlasKey instanceof TextureAtlasKey;
        
        // If replacing existing entry, clean up old texture
        if (this.cache.has(key)) {
            const old = this.cache.get(key);
            this.currentSizeBytes -= old.sizeBytes;
            
            // Dispose old texture
            if (old.texture) {
                if (old.texture._gpuTexture && old.texture._gpuTexture.texture) {
                    old.texture._gpuTexture.texture.destroy();
                }
                if (old.texture.dispose) {
                    old.texture.dispose();
                }
            }
        }
        
        // Store the entry
        const entry = {
            texture,
            sizeBytes,
            lastAccess: performance.now(),
            created: performance.now(),
            type,
            isAtlas: isAtlas,
            isGPUOnly: texture._isGPUOnly || false
        };
        
        // Store atlas-specific metadata
        if (isAtlas) {
            entry.atlasKey = chunkXOrAtlasKey;
            entry.atlasX = chunkXOrAtlasKey.atlasX;
            entry.atlasY = chunkXOrAtlasKey.atlasY;
            entry.face = chunkXOrAtlasKey.face;
        } else {
            entry.chunkX = chunkXOrAtlasKey;
            entry.chunkY = chunkY;
        }
        
        this.cache.set(key, entry);
        this.currentSizeBytes += sizeBytes;
        
        this.evictIfNeeded();
    }

    /**
     * Get atlas texture for a specific chunk.
     * This is the primary method for atlas-based lookups.
     * 
     * @param {number} chunkX - Chunk X coordinate
     * @param {number} chunkY - Chunk Y coordinate
     * @param {string} type - Texture type (height, normal, tile, etc.)
     * @param {DataTextureConfig} config - Atlas configuration
     * @param {number|null} face - Cube face for spherical terrain
     * @returns {Object|null} - {texture, uvTransform} or null if not found
     */
    getAtlasForChunk(chunkX, chunkY, type, config = null, face = null) {
        // VALIDATION: Return null for invalid coordinates
        if (typeof chunkX !== 'number' || isNaN(chunkX) ||
            typeof chunkY !== 'number' || isNaN(chunkY)) {
            return null;
        }
        
        const cfg = this._requireAtlasConfig(config, 'hasAtlasForChunk');
        
        // Calculate which atlas contains this chunk
        const atlasKey = TextureAtlasKey.fromChunkCoords(chunkX, chunkY, face, cfg);
        const cacheKey = this.makeKey(atlasKey, null, type);
        
        const entry = this.cache.get(cacheKey);
        
        if (!entry) {
            this.stats.atlasMisses++;
            return null;
        }
        
        this.stats.atlasHits++;
        entry.lastAccess = performance.now();
        
        // Calculate UV transform for this chunk within the atlas
        const uvTransform = cfg.getChunkUVTransform(chunkX, chunkY);
        
        // Track that this chunk is using this atlas
        this._trackAtlasUsage(atlasKey.toString(), this._makeChunkUsageKey(chunkX, chunkY, null, face));
        
        return {
            texture: entry.texture,
            atlasKey: atlasKey,
            uvTransform: uvTransform
        };
    }

    /**
     * Check if atlas exists for a chunk
     */
    hasAtlasForChunk(chunkX, chunkY, type, config = null, face = null) {
        // VALIDATION: Return false for invalid coordinates instead of crashing
        if (typeof chunkX !== 'number' || isNaN(chunkX) ||
            typeof chunkY !== 'number' || isNaN(chunkY)) {
            return false;
        }
        
        const cfg = this._requireAtlasConfig(config, 'hasAtlasForChunk');
        const atlasKey = TextureAtlasKey.fromChunkCoords(chunkX, chunkY, face, cfg);
        const cacheKey = this.makeKey(atlasKey, null, type);
        return this.cache.has(cacheKey);
    }

    /**
     * Check if ALL required texture types exist for an atlas
     */
    hasCompleteAtlas(chunkX, chunkY, config = null, face = null) {
        // VALIDATION: Return false for invalid coordinates
        if (typeof chunkX !== 'number' || isNaN(chunkX) ||
            typeof chunkY !== 'number' || isNaN(chunkY)) {
            return false;
        }
        
        const cfg = this._requireAtlasConfig(config, 'hasCompleteAtlas');
        const types = cfg.atlasTextureTypes;
        
        for (const type of types) {
            if (!this.hasAtlasForChunk(chunkX, chunkY, type, cfg, face)) {
                return false;
            }
        }
        return true;
    }

    /**
     * Get all atlas textures for a chunk
     */
    getAllAtlasTexturesForChunk(chunkX, chunkY, config = null, face = null) {
        const cfg = this._requireAtlasConfig(config, 'getAllAtlasTexturesForChunk');
        const types = cfg.atlasTextureTypes;
        const result = {};
        
        for (const type of types) {
            const atlasData = this.getAtlasForChunk(chunkX, chunkY, type, cfg, face);
            if (atlasData) {
                result[type] = atlasData;
            }
        }
        
        return result;
    }

    /**
     * Track which chunks are using which atlas (for smart eviction)
     */
    _trackAtlasUsage(atlasKeyStr, chunkKeyStr) {
        if (!this.atlasUsage.has(atlasKeyStr)) {
            this.atlasUsage.set(atlasKeyStr, new Set());
        }
        this.atlasUsage.get(atlasKeyStr).add(chunkKeyStr);
    }

    _makeChunkUsageKey(chunkX, chunkY, lod = null, face = null) {
        const facePart = face === null || face === undefined ? 'flat' : `f${face}`;
        const lodPart = lod === null || lod === undefined ? 'lod?' : `lod${lod}`;
        return `${facePart}:${chunkX},${chunkY}:${lodPart}`;
    }

    /**
     * Mark a chunk as no longer using its atlas
     */
    releaseChunkFromAtlas(chunkX, chunkY, config = null, face = null) {
        const cfg = this._requireAtlasConfig(config, 'releaseChunkFromAtlas');
        const atlasKey = TextureAtlasKey.fromChunkCoords(chunkX, chunkY, face, cfg);
        const atlasKeyStr = atlasKey.toString();
        const chunkKeyStr = this._makeChunkUsageKey(chunkX, chunkY, null, face);
        
        if (this.atlasUsage.has(atlasKeyStr)) {
            this.atlasUsage.get(atlasKeyStr).delete(chunkKeyStr);
            
            // If no chunks using this atlas, it becomes eligible for eviction
            if (this.atlasUsage.get(atlasKeyStr).size === 0) {
                
            }
        }
    }

    /**
     * Release a chunk from a LOD atlas (hierarchical atlas path)
     */
    releaseLODChunkFromAtlas(chunkX, chunkY, lod = 0, config = null, face = null) {
        const cfg = this._requireLODAtlasConfig(config, 'releaseLODChunkFromAtlas');
        const atlasKey = LODTextureAtlasKey.fromChunkCoords(chunkX, chunkY, lod, face, cfg);
        const atlasKeyStr = atlasKey.toString();
        const chunkKeyStr = this._makeChunkUsageKey(chunkX, chunkY, lod, face);
        
        if (this.atlasUsage.has(atlasKeyStr)) {
            this.atlasUsage.get(atlasKeyStr).delete(chunkKeyStr);
            if (this.atlasUsage.get(atlasKeyStr).size === 0) {
                
            }
        }
    }

    /**
     * Remove a chunk's textures (legacy per-chunk mode)
     */
    removeChunk(chunkX, chunkY) {
        const types = ['height', 'normal', 'tile', 'splatWeight', 'splatType', 'splatData', 'macro'];
        
        for (const type of types) {
            const key = this.makeKey(chunkX, chunkY, type);
            const entry = this.cache.get(key);
            
            if (entry) {
                // Destroy GPU texture
                if (entry.texture && entry.texture._gpuTexture) {
                    if (entry.texture._gpuTexture.texture) {
                        entry.texture._gpuTexture.texture.destroy();
                    }
                }
                
                // Dispose wrapper
                if (entry.texture && entry.texture.dispose) {
                    entry.texture.dispose();
                }
                
                this.cache.delete(key);
                this.currentSizeBytes -= entry.sizeBytes;
            }
        }
        
        // Also release from any atlas tracking
        this.releaseChunkFromAtlas(chunkX, chunkY);
    }

    /**
     * Remove an entire atlas and all its textures
     */
    removeAtlas(atlasKey) {
        const types = this._requireAtlasConfig(null, 'getAtlasCoverage').atlasTextureTypes;
        const atlasKeyStr = atlasKey.toString();
        
        
        
        for (const type of types) {
            const key = type + '_' + atlasKeyStr;
            const entry = this.cache.get(key);
            
            if (entry) {
                // Destroy GPU texture
                if (entry.texture && entry.texture._gpuTexture) {
                    if (entry.texture._gpuTexture.texture) {
                        entry.texture._gpuTexture.texture.destroy();
                    }
                }
                
                if (entry.texture && entry.texture.dispose) {
                    entry.texture.dispose();
                }
                
                this.cache.delete(key);
                this.currentSizeBytes -= entry.sizeBytes;
            }
        }
        
        // Clear atlas usage tracking
        this.atlasUsage.delete(atlasKeyStr);
    }

    /**
     * Evict old textures if over memory budget.
     * Prioritizes evicting atlases with no active chunks.
     */
    evictIfNeeded() {
        if (this.currentSizeBytes <= this.maxSizeBytes) return;

        const now = performance.now();

        // Sort by last access time (oldest first)
        const entries = Array.from(this.cache.entries())
            .filter(([, entry]) => !entry.arrayInfo?.isPooled)
            .map(([key, entry]) => {
                // Calculate eviction priority
                // Lower = evict first
                let priority = entry.lastAccess;
                
                // If it's an atlas, check if chunks are still using it
                if (entry.isAtlas && entry.atlasKey) {
                    const atlasKeyStr = entry.atlasKey.toString();
                    const activeChunks = this.atlasUsage.get(atlasKeyStr);
                    
                    if (activeChunks && activeChunks.size > 0) {
                        // Boost priority (less likely to evict) if chunks are using it
                        priority += 1000000 * activeChunks.size;
                    }
                }

                // Apply LOD residency hysteresis for LOD atlases
                if (entry.isLODAtlas && typeof entry.lod === 'number') {
                    const minTTLs = this.lodResidencyPolicy?.minTTLsMs || [];
                    const biasArr = this.lodResidencyPolicy?.bias || [];
                    const minTTL = minTTLs[entry.lod] ?? 0;
                    const bias = biasArr[entry.lod] ?? 0;
                    const age = now - entry.lastAccess;
                    // Before minTTL, make it very unlikely to evict; after, apply bias
                    if (age < minTTL) {
                        priority += 1e12; // effectively pin unless memory crisis
                    } else {
                        priority += bias;
                    }
                }
                
                return { key, entry, priority };
            })
            .sort((a, b) => a.priority - b.priority);

        // Keep a modest headroom but avoid aggressive churn (especially for LOD atlases)
        const target = this.maxSizeBytes * 0.9;
        
        while (this.currentSizeBytes > target && entries.length > 0) {
            const { key, entry } = entries.shift();
            
            // Warn about evicting GPU-only textures
            if (entry.isGPUOnly) {
            }
            
            // Warn about evicting atlas with active chunks
            if (entry.isAtlas && entry.atlasKey) {
                const atlasKeyStr = entry.atlasKey.toString();
                const activeChunks = this.atlasUsage.get(atlasKeyStr);
                if (activeChunks && activeChunks.size > 0) {
                    
                }
            }
            
            // Defer texture destruction to avoid destroying textures still in GPU command buffers
            const isSharedArray = entry.texture?._isArray && entry.arrayInfo;

            if (entry.arrayInfo?.release && !entry.arrayInfo?.isPooled) {
                try { entry.arrayInfo.release(); } catch (_) {}
            }

            if (!isSharedArray) {
                this._deferTextureDestruction(entry.texture);
            }
            
            this.cache.delete(key);
            this.currentSizeBytes -= entry.sizeBytes;
            this.stats.evictions++;
        }
    }

    _evictPooledLODAtlasEntries(atlasKeyStr, lod) {
        const types = this._requireLODAtlasConfig(null, 'getLODAtlasCoverage').atlasTextureTypes;
        for (const type of types) {
            const key = `${type}_${atlasKeyStr}`;
            const entry = this.cache.get(key);
            if (entry && entry.arrayInfo?.isPooled) {
                this.cache.delete(key);
                this.currentSizeBytes -= entry.sizeBytes || 0;
            }
        }
        this.atlasUsage.delete(atlasKeyStr);
        this._evictedLODAtlases.add(atlasKeyStr);
    }

    _isTextureReferenced(texture) {
        for (const entry of this.cache.values()) {
            if (entry.texture === texture) return true;
        }
        return false;
    }

    /**
     * Clear all textures from cache
     */
    clear() {
        for (const entry of this.cache.values()) {
            const isPooled = entry.arrayInfo?.isPooled;
            if (entry.arrayInfo?.release && !isPooled) {
                try { entry.arrayInfo.release(); } catch (_) {}
            }

            const isSharedArray = entry.texture?._isArray && entry.arrayInfo;
            if (isSharedArray) continue;

            if (entry.texture) {
                this._deferTextureDestruction(entry.texture);
            }
        }
        this.cache.clear();
        this.atlasUsage.clear();
        this.currentSizeBytes = 0;
        this._evictedLODAtlases.clear();
        if (this.virtualTexturePool) {
            this.virtualTexturePool.clearMappings();
        }
        
    }

    /**
     * Get cache statistics
     */
    getStats() {
        const atlasCount = Array.from(this.cache.values()).filter(e => e.isAtlas).length;
        const chunkCount = Array.from(this.cache.values()).filter(e => !e.isAtlas).length;
        
        return {
            ...this.stats,
            cacheSize: this.cache.size,
            atlasCount: atlasCount,
            chunkCount: chunkCount,
            bytesUsed: this.currentSizeBytes,
            bytesMax: this.maxSizeBytes,
            hitRate: this.stats.hits / (this.stats.hits + this.stats.misses) || 0,
            atlasHitRate: this.stats.atlasHits / (this.stats.atlasHits + this.stats.atlasMisses) || 0
        };
    }

    /**
     * Get list of all cached atlas keys
     */
    getAtlasKeys() {
        const atlasKeys = new Set();
        
        for (const entry of this.cache.values()) {
            if (entry.isAtlas && entry.atlasKey) {
                atlasKeys.add(entry.atlasKey.toString());
            }
        }
        
        return Array.from(atlasKeys);
    }
}
