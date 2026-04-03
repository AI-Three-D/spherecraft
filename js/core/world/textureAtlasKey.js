// js/world/textureAtlasKey.js
// Identifies a specific atlas by grid coordinates
// Key format uses config.textureSize for the suffix (dynamic, not hardcoded)

import { DataTextureConfig } from '../../templates/configs/dataTextureConfiguration.js';


export class TextureAtlasKey {
    /**
     * @param {number} atlasX - Atlas grid X coordinate
     * @param {number} atlasY - Atlas grid Y coordinate
     * @param {number|null} face - Cube face for spherical terrain (0-5), null for flat
     * @param {DataTextureConfig} config - Atlas configuration
     */
    constructor(atlasX, atlasY, face = null, config) {
        // Validate inputs
        if (typeof atlasX !== 'number' || isNaN(atlasX)) {
            throw new Error('TextureAtlasKey: Invalid atlasX: ' + atlasX);
        }
        if (typeof atlasY !== 'number' || isNaN(atlasY)) {
            throw new Error('TextureAtlasKey: Invalid atlasY: ' + atlasY);
        }
        if (face !== null && (typeof face !== 'number' || face < 0 || face > 5)) {
            throw new Error('TextureAtlasKey: Invalid face: ' + face + ' (must be 0-5 or null)');
        }

        const resolvedConfig = normalizeConfig(config, 'TextureAtlasKey');
        this.atlasX = atlasX;
        this.atlasY = atlasY;
        this.face = face;
        this.config = resolvedConfig;
        
        // Pre-calculate chunk range for this atlas
        this._minChunkX = atlasX * resolvedConfig.chunksPerAxis;
        this._minChunkY = atlasY * resolvedConfig.chunksPerAxis;
        this._maxChunkX = this._minChunkX + resolvedConfig.chunksPerAxis - 1;
        this._maxChunkY = this._minChunkY + resolvedConfig.chunksPerAxis - 1;
        /*
            */
    }
    
    /**
     * Generate string key for cache lookups.
     * Format: "atlas_X,Y_SIZE" or "atlas_fF_X,Y_SIZE" for spherical
     * 

     */
    toString() {
        // The suffix is DYNAMIC - it uses this.config.textureSize
        if (this.face === null) {
            return 'atlas_' + this.atlasX + ',' + this.atlasY + '_' + this.config.textureSize;
        }
        return 'atlas_f' + this.face + '_' + this.atlasX + ',' + this.atlasY + '_' + this.config.textureSize;
    }
    
    /**
     * Create TextureAtlasKey from chunk coordinates.
     * This is the primary factory method.
     * 
     * @param {number} chunkX - Chunk X coordinate
     * @param {number} chunkY - Chunk Y coordinate
     * @param {number|null} face - Cube face (null for flat terrain)
     * @param {DataTextureConfig|Object} config - Config instance or config object
     * @returns {TextureAtlasKey}
     */
    static fromChunkCoords(chunkX, chunkY, face = null, config) {
        const resolvedConfig = normalizeConfig(config, 'TextureAtlasKey.fromChunkCoords');
        // Calculate atlas coordinates using floor division
        const atlasX = Math.floor(chunkX / resolvedConfig.chunksPerAxis);
        const atlasY = Math.floor(chunkY / resolvedConfig.chunksPerAxis);
      /*  
        */
        return new TextureAtlasKey(atlasX, atlasY, face, resolvedConfig);
    }
    
    /**
     * Parse key string back to TextureAtlasKey object.
     * 
     * @param {string} keyString - Key like "atlas_0,0_2048" or "atlas_f2_1,0_2048"
     * @param {DataTextureConfig} config - Config instance (required)
     * @returns {TextureAtlasKey}
     */
    static fromString(keyString, config) {
        const resolvedConfig = normalizeConfig(config, 'TextureAtlasKey.fromString');
        
        
        
        // Remove "atlas_" prefix
        if (!keyString.startsWith('atlas_')) {
            throw new Error('TextureAtlasKey.fromString: Invalid key format (missing "atlas_" prefix): "' + keyString + '"');
        }
        
        const withoutPrefix = keyString.substring(6); // Remove "atlas_"
        
        let face = null;
        let coords, texSize;
        
        if (withoutPrefix.startsWith('f')) {
            // Spherical format: "f0_0,0_2048"
            const faceEnd = withoutPrefix.indexOf('_');
            if (faceEnd === -1) {
                throw new Error('TextureAtlasKey.fromString: Invalid spherical format: "' + keyString + '"');
            }
            
            face = parseInt(withoutPrefix.substring(1, faceEnd), 10);
            const rest = withoutPrefix.substring(faceEnd + 1);
            const parts = rest.split('_');
            
            if (parts.length !== 2) {
                throw new Error('TextureAtlasKey.fromString: Invalid format: "' + keyString + '"');
            }
            
            coords = parts[0];
            texSize = parseInt(parts[1], 10);
            
            
        } else {
            // Flat format: "0,0_2048"
            const parts = withoutPrefix.split('_');
            
            if (parts.length !== 2) {
                throw new Error('TextureAtlasKey.fromString: Invalid format: "' + keyString + '"');
            }
            
            coords = parts[0];
            texSize = parseInt(parts[1], 10);
            
            
        }
        
        const coordParts = coords.split(',');
        if (coordParts.length !== 2) {
            throw new Error('TextureAtlasKey.fromString: Invalid coordinates: "' + coords + '"');
        }
        
        const atlasX = parseInt(coordParts[0], 10);
        const atlasY = parseInt(coordParts[1], 10);
        
        if (isNaN(atlasX) || isNaN(atlasY) || isNaN(texSize)) {
            throw new Error('TextureAtlasKey.fromString: Failed to parse values from: "' + keyString + '"');
        }
        
        
        // Warn if config doesnt match parsed texture size
        if (resolvedConfig.textureSize !== texSize) {
        }
        
        return new TextureAtlasKey(atlasX, atlasY, face, resolvedConfig);
    }
    
    /**
     * Get UV transform for a specific chunk within this atlas.
     */
    getChunkUVTransform(chunkX, chunkY) {
        // Verify chunk is in this atlas
        if (!this.containsChunk(chunkX, chunkY)) {
        }
        
        return this.config.getChunkUVTransform(chunkX, chunkY);
    }
    
    /**
     * Check if this atlas contains the given chunk.
     */
    containsChunk(chunkX, chunkY) {
        return chunkX >= this._minChunkX && chunkX <= this._maxChunkX &&
               chunkY >= this._minChunkY && chunkY <= this._maxChunkY;
    }
    
    /**
     * Get all chunks covered by this atlas.
     */
    getCoveredChunks() {
        const chunks = [];
        
        for (let y = 0; y < this.config.chunksPerAxis; y++) {
            for (let x = 0; x < this.config.chunksPerAxis; x++) {
                chunks.push({
                    chunkX: this._minChunkX + x,
                    chunkY: this._minChunkY + y
                });
            }
        }
        
        return chunks;
    }
    
    /**
     * Get the chunk range covered by this atlas.
     */
    getChunkRange() {
        return {
            minChunkX: this._minChunkX,
            maxChunkX: this._maxChunkX,
            minChunkY: this._minChunkY,
            maxChunkY: this._maxChunkY
        };
    }
    
    /**
     * Check equality with another TextureAtlasKey.
     */
    equals(other) {
        if (!(other instanceof TextureAtlasKey)) return false;
        return this.atlasX === other.atlasX &&
               this.atlasY === other.atlasY &&
               this.face === other.face &&
               this.config.textureSize === other.config.textureSize;
    }
    
    /**
     * Get adjacent atlas keys.
     */
    getAdjacentAtlases() {
        return {
            left: new TextureAtlasKey(this.atlasX - 1, this.atlasY, this.face, this.config),
            right: new TextureAtlasKey(this.atlasX + 1, this.atlasY, this.face, this.config),
            top: new TextureAtlasKey(this.atlasX, this.atlasY - 1, this.face, this.config),
            bottom: new TextureAtlasKey(this.atlasX, this.atlasY + 1, this.face, this.config)
        };
    }
}

function normalizeConfig(config, source) {
    if (!config) {
        throw new Error(`${source} requires config`);
    }
    if (config instanceof DataTextureConfig) {
        return config;
    }
    if (config && typeof config === 'object') {
        return new DataTextureConfig(config);
    }
    throw new Error(`${source} requires a DataTextureConfig`);
}
