// js/world/baseWorldGenerator.js
// Phase 3: Atlas generation integration

import { DataTextureConfig } from '../config/dataTextureConfiguration.js';
import { TextureAtlasKey } from './textureAtlasKey.js';

export class BaseWorldGenerator {
    constructor(renderer, textureCache, chunkSize, seed, options = {}) {
        this.backend = renderer;
        this.textureCache = textureCache;
        this.chunkSize = chunkSize;
        this.seed = seed;
        this._worldOptions = options;
        
        // Atlas configuration (explicit)
        if (!Number.isFinite(options.atlasTextureSize)) {
            throw new Error('BaseWorldGenerator requires options.atlasTextureSize');
        }
        if (!Number.isFinite(options.atlasChunkSize)) {
            throw new Error('BaseWorldGenerator requires options.atlasChunkSize');
        }
        if (!Array.isArray(options.atlasTextureTypes) || options.atlasTextureTypes.length === 0) {
            throw new Error('BaseWorldGenerator requires options.atlasTextureTypes');
        }
        this.atlasConfig = new DataTextureConfig({
            textureSize: options.atlasTextureSize,
            chunkSize: options.atlasChunkSize,
            atlasTextureTypes: options.atlasTextureTypes
        });
        
        // Set the atlas config on the texture cache
        if (this.textureCache && this.textureCache.setAtlasConfig) {
            this.textureCache.setAtlasConfig(this.atlasConfig);
        }
        
        
        
        
        
        
        this.globalWaterLevel = 8.0;
        
        this.macroConfig = {
            biomeScale: 0.001,
            regionScale: 0.0005
        };
        
        this.splatConfig = {
            splatDensity: 4,
            splatKernelSize: 5
        };
        
        this.modules = {
            tiledTerrain: { enabled: true, instance: null },
            staticObjects: { enabled: true, instance: null }
        };
        
        // Track pending atlas generations to avoid duplicates
        this._pendingAtlases = new Map();
        
        this._ready = this.initialize();
    }
    
    async initialize() {
        await this.initializeAPI();
        await this.initializeModules();
    }

    getAPIName() {
        return 'Base';
    }

    async initializeAPI() {
        // Override in subclass
    }

    async initializeModules() {
        // Override in subclass
    }

    /**
     * Check if atlas exists for a chunk (all required texture types)
     */
    hasAtlasForChunk(chunkX, chunkY, face = null) {
        // Use texture cache's atlas check if available
        if (this.textureCache.hasCompleteAtlas) {
            return this.textureCache.hasCompleteAtlas(chunkX, chunkY, this.atlasConfig, face);
        }
        
        // Fallback: check manually
        const atlasKey = TextureAtlasKey.fromChunkCoords(chunkX, chunkY, face, this.atlasConfig);
        
        for (const type of this.atlasConfig.atlasTextureTypes) {
            const cacheKey = type + '_' + atlasKey.toString();
            if (!this.textureCache.cache.has(cacheKey)) {
                
                return false;
            }
        }
        
        return true;
    }
    
    /**
     * Generate atlas for a chunk's atlas region.
     * Returns immediately if atlas is already being generated.
     */
    async generateAtlasForChunk(chunkX, chunkY, face = null) {
        const atlasKey = TextureAtlasKey.fromChunkCoords(chunkX, chunkY, face, this.atlasConfig);
        const atlasKeyStr = atlasKey.toString();
        
        // Check if already being generated
        if (this._pendingAtlases.has(atlasKeyStr)) {
            
            return this._pendingAtlases.get(atlasKeyStr);
        }
        
        // Check if already exists
        if (this.hasAtlasForChunk(chunkX, chunkY, face)) {
            
            return { atlasKey: atlasKey, cached: true };
        }
        
        
        
        // Create generation promise
        const generationPromise = this._doGenerateAtlas(atlasKey);
        this._pendingAtlases.set(atlasKeyStr, generationPromise);
        
        try {
            const result = await generationPromise;
            return result;
        } finally {
            this._pendingAtlases.delete(atlasKeyStr);
        }
    }
    
    /**
     * Actually generate the atlas textures
     */
    async _doGenerateAtlas(atlasKey) {
        
        // Get covered chunks for logging
        const chunks = atlasKey.getCoveredChunks();
        
        
        // Use terrain generator to create atlas textures
        if (this.modules.tiledTerrain.enabled && this.modules.tiledTerrain.instance) {
            const generator = this.modules.tiledTerrain.instance;
            
            // Check if generator has atlas support
            if (generator.generateAtlasTextures) {
                
                const result = await generator.generateAtlasTextures(atlasKey, this.atlasConfig);
                return result;
            } else {
                
                return this._generateAtlasStub(atlasKey);
            }
        } else {
            
            return this._generateAtlasStub(atlasKey);
        }
    }
    
    /**
     * Stub atlas generation (for testing without actual GPU generation)
     */
    _generateAtlasStub(atlasKey) {
        
        for (const type of this.atlasConfig.atlasTextureTypes) {
        }
        
        return {
            atlasKey: atlasKey,
            stub: true
        };
    }
    
    /**
     * Get atlas textures for a chunk
     */
    getAtlasTexturesForChunk(chunkX, chunkY, face = null) {
        if (this.textureCache.getAllAtlasTexturesForChunk) {
            return this.textureCache.getAllAtlasTexturesForChunk(chunkX, chunkY, this.atlasConfig, face);
        }
        
        // Fallback manual lookup
        const atlasKey = TextureAtlasKey.fromChunkCoords(chunkX, chunkY, face, this.atlasConfig);
        const uvTransform = this.atlasConfig.getChunkUVTransform(chunkX, chunkY);
        const result = {};
        
        for (const type of this.atlasConfig.atlasTextureTypes) {
            const texture = this.textureCache.get(atlasKey, null, type);
            if (texture) {
                result[type] = {
                    texture: texture,
                    atlasKey: atlasKey,
                    uvTransform: uvTransform
                };
            }
        }
        
        return result;
    }

    /**
     * Release a chunk (mark it as no longer using its atlas)
     */
    releaseChunk(chunkX, chunkY, face = null, lod = 0) {
        if (this.textureCache.releaseChunkFromAtlas) {
            this.textureCache.releaseChunkFromAtlas(chunkX, chunkY, this.atlasConfig, face);
        }
        if (this.textureCache.releaseLODChunkFromAtlas && this.lodAtlasConfig) {
            this.textureCache.releaseLODChunkFromAtlas(chunkX, chunkY, lod, this.lodAtlasConfig, face);
        }
    }

    /**
     * Seeded random number generator
     */
    createSeededRandom(seed) {
        let s = seed;
        return function() {
            s = (s * 1103515245 + 12345) & 0x7fffffff;
            return s / 0x7fffffff;
        };
    }

    /**
     * Calculate terrain slope at a point
     */
    calculateSlope(chunkData, x, z) {
        const h0 = chunkData.getHeight(x, z);
        const h1 = chunkData.getHeight(Math.min(x + 1, chunkData.size - 1), z);
        const h2 = chunkData.getHeight(x, Math.min(z + 1, chunkData.size - 1));
        const dx = Math.abs(h1 - h0);
        const dz = Math.abs(h2 - h0);
        return Math.max(dx, dz);
    }

    /**
     * Set planet configuration for spherical terrain
     */
    setPlanetConfig(config) {
        const planetConfig = requireObject(config, 'planetConfig');
        this.planetConfig = planetConfig;

        // Propagate planet config to terrain generator if it exists
        if (this.modules.tiledTerrain.instance) {
            const generator = this.modules.tiledTerrain.instance;
            if (typeof generator.setPlanetConfig === 'function') {
                generator.setPlanetConfig(planetConfig);
                return;
            }
            generator.planetConfig = planetConfig;
            generator.worldScale = requireNumber(planetConfig.radius, 'planetConfig.radius');
            if (generator.terrainMaterial?.uniforms?.u_worldScale) {
                generator.terrainMaterial.uniforms.u_worldScale.value = generator.worldScale;
            }
            generator.chunksPerFace = requireInt(planetConfig.chunksPerFace, 'planetConfig.chunksPerFace', 1);
            if (generator.terrainMaterial?.uniforms?.u_chunksPerFace) {
                generator.terrainMaterial.uniforms.u_chunksPerFace.value = generator.chunksPerFace;
            }
            generator.terrainConfig = requireObject(planetConfig.terrainGeneration, 'planetConfig.terrainGeneration');
        }
    }

    dispose() {
        // Override in subclass
    }
}

function requireObject(value, name) {
    if (!value || typeof value !== 'object') {
        throw new Error(`BaseWorldGenerator missing required object: ${name}`);
    }
    return value;
}

function requireNumber(value, name) {
    if (!Number.isFinite(value)) {
        throw new Error(`BaseWorldGenerator missing required number: ${name}`);
    }
    return value;
}

function requireInt(value, name, min = null) {
    if (!Number.isFinite(value)) {
        throw new Error(`BaseWorldGenerator missing required integer: ${name}`);
    }
    const n = Math.floor(value);
    if (min !== null && n < min) {
        throw new Error(`BaseWorldGenerator ${name} must be >= ${min}`);
    }
    return n;
}
