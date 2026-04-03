// js/world/chunkKey.js
// Unified chunk key system supporting both flat and spherical modes
// with proper atlas key integration and Morton-code addressing

import { TextureAtlasKey } from './textureAtlasKey.js';

export const COORD_BITS = 28;
export const COORD_MAX = (1 << COORD_BITS) - 1;
export const COORD_BIAS = 1 << (COORD_BITS - 1);
export const FLAT_FACE = 7;
export const FACE_SHIFT = 61n;
export const LOD_SHIFT = 56n;
export const MORTON_MASK = (1n << 56n) - 1n;

const FACE_MASK = 0x7n;
const LOD_MASK = 0x1fn;

export function isMortonKey(key) {
    return typeof key === 'bigint';
}

function clampCoord(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(COORD_MAX, Math.floor(value)));
}

function encodeCoord(faceBits, value) {
    if (faceBits === FLAT_FACE) {
        return clampCoord(value + COORD_BIAS);
    }
    return clampCoord(value);
}

function decodeCoord(faceBits, value) {
    return faceBits === FLAT_FACE ? value - COORD_BIAS : value;
}

export function mortonEncode(x, y) {
    let result = 0n;
    const ix = clampCoord(x);
    const iy = clampCoord(y);
    for (let i = 0; i < COORD_BITS; i++) {
        result |= BigInt((ix >> i) & 1) << BigInt(2 * i);
        result |= BigInt((iy >> i) & 1) << BigInt(2 * i + 1);
    }
    return result;
}

export function mortonDecode(code) {
    let x = 0;
    let y = 0;
    for (let i = 0; i < COORD_BITS; i++) {
        x |= Number((code >> BigInt(2 * i)) & 1n) << i;
        y |= Number((code >> BigInt(2 * i + 1)) & 1n) << i;
    }
    return { x, y };
}

export function createChunkKey(face, level, x, y) {
    const faceBits = face === null || face === undefined || face < 0 ? FLAT_FACE : Math.max(0, Math.min(7, face | 0));
    const lod = Math.max(0, Math.min(31, level | 0));
    const encX = encodeCoord(faceBits, x);
    const encY = encodeCoord(faceBits, y);
    const morton = mortonEncode(encX, encY);
    return (BigInt(faceBits) << FACE_SHIFT) | (BigInt(lod) << LOD_SHIFT) | morton;
}

export function parseChunkKey(key) {
    if (isMortonKey(key)) {
        const faceBits = Number((key >> FACE_SHIFT) & FACE_MASK);
        const level = Number((key >> LOD_SHIFT) & LOD_MASK);
        const morton = key & MORTON_MASK;
        const decoded = mortonDecode(morton);
        const isFlat = faceBits === FLAT_FACE;
        return {
            face: isFlat ? null : faceBits,
            level,
            x: decodeCoord(faceBits, decoded.x),
            y: decodeCoord(faceBits, decoded.y),
            isFlat,
            morton
        };
    }

    if (typeof key !== 'string') {
        throw new Error('parseChunkKey: Expected bigint or string');
    }

    if (key.includes(':')) {
        const parts = key.split(':');
        const face = parseInt(parts[0], 10);
        const coords = parts[1].split(',');
        const x = parseInt(coords[0], 10);
        const y = parseInt(coords[1], 10);
        const level = parseInt(parts[2] || '0', 10);
        if (Number.isNaN(face) || Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(level)) {
            throw new Error('parseChunkKey: Invalid spherical key');
        }
        return { face, level, x, y, isFlat: false, morton: null };
    }

    const coords = key.split(',');
    const x = parseInt(coords[0], 10);
    const y = parseInt(coords[1], 10);
    if (Number.isNaN(x) || Number.isNaN(y)) {
        throw new Error('parseChunkKey: Invalid flat key');
    }
    return { face: null, level: 0, x, y, isFlat: true, morton: null };
}

export function chunkKeyToString(key) {
    if (typeof key === 'string') return key;
    const parsed = parseChunkKey(key);
    if (parsed.face === null || parsed.face === undefined) {
        return `${parsed.x},${parsed.y}`;
    }
    return `${parsed.face}:${parsed.x},${parsed.y}:${parsed.level}`;
}


export class ChunkKey {
    /**
     * @param {number} x - Chunk X coordinate
     * @param {number} y - Chunk Y coordinate  
     * @param {number|null} face - Cube face for spherical terrain (0-5), null for flat
     * @param {number} lod - Level of detail (default 0)
     */
    constructor(x, y, face = null, lod = 0) {
        // Validate inputs
        if (typeof x !== 'number' || isNaN(x)) {
            throw new Error('ChunkKey: Invalid x coordinate: ' + x);
        }
        if (typeof y !== 'number' || isNaN(y)) {
            throw new Error('ChunkKey: Invalid y coordinate: ' + y);
        }
        if (face !== null && (typeof face !== 'number' || face < 0 || face > 5)) {
            throw new Error('ChunkKey: Invalid face: ' + face + ' (must be 0-5 or null)');
        }
        
        this.x = x;
        this.y = y;
        this.face = face;  // null for flat terrain, 0-5 for cube faces
        this.lod = lod;
    }
    
    /**
     * Generate string key for Map lookups
     * Flat:      "x,y"
     * Spherical: "face:x,y:lod"
     */
    toString() {
        if (this.face === null) {
            return this.x + ',' + this.y;
        }
        return this.face + ':' + this.x + ',' + this.y + ':' + this.lod;
    }
    
    /**
     * Parse key string back to ChunkKey object
     * @param {string|bigint} keyString - Key like "17,5", "2:17,5:0", or Morton bigint
     * @returns {ChunkKey}
     */
    static fromString(keyString) {
        return ChunkKey.fromKey(keyString);
    }

    /**
     * Parse string or Morton bigint into a ChunkKey
     * @param {string|bigint} key - Key like "17,5", "2:17,5:0", or Morton bigint
     * @returns {ChunkKey}
     */
    static fromKey(key) {
        const parsed = parseChunkKey(key);
        return new ChunkKey(parsed.x, parsed.y, parsed.face, parsed.level);
    }

    /**
     * Convert this ChunkKey to a Morton bigint
     */
    toMortonKey() {
        return createChunkKey(this.face, this.lod, this.x, this.y);
    }
    
    /**
     * Check if this is a flat terrain chunk
     */
    isFlat() {
        return this.face === null;
    }
    
    /**
     * Check if this is a spherical chunk
     */
    isSpherical() {
        return this.face !== null;
    }
    
    /**
     * Convert chunk key to TextureAtlasKey for texture caching.
     * This is the KEY METHOD for atlas system integration.
     * 
     * @param {DataTextureConfig} config - Atlas configuration
     * @returns {TextureAtlasKey}
     * 
     * Example:
     *   const chunk = new ChunkKey(17, 5);
     *   const atlas = chunk.toAtlasKey(config);
     *   // With chunksPerAxis=16: atlas represents (1,0) containing chunks [16-31, 0-15]
     */
    toAtlasKey(config) {
        if (!config) {
            throw new Error('ChunkKey.toAtlasKey requires config');
        }
        // Delegate to TextureAtlasKey's fromChunkCoords which handles the math
        const atlasKey = TextureAtlasKey.fromChunkCoords(
            this.x, 
            this.y, 
            this.face, 
            config
        );
        
        
        return atlasKey;
    }
    
    /**
     * Get the UV transform for this chunk within its atlas
     * @param {DataTextureConfig} config - Atlas configuration
     * @returns {{offsetX: number, offsetY: number, scale: number}}
     */
    getUVTransform(config) {
        if (!config) {
            throw new Error('ChunkKey.getUVTransform requires config');
        }
        return config.getChunkUVTransform(this.x, this.y);
    }
    
    /**
     * Get all chunk keys that share the same atlas as this chunk
     * @param {DataTextureConfig} config - Atlas configuration
     * @returns {ChunkKey[]}
     */
    getSiblingChunks(config) {
        if (!config) {
            throw new Error('ChunkKey.getSiblingChunks requires config');
        }
        const atlasKey = this.toAtlasKey(config);
        const covered = atlasKey.getCoveredChunks();
        
        return covered.map(function(c) {
            return new ChunkKey(c.chunkX, c.chunkY, this.face, this.lod);
        }, this);
    }
    
    /**
     * Legacy method for backward compatibility
     * @deprecated Use toAtlasKey() instead
     */
    getTextureCacheKey() {
        return this.x + ',' + this.y;
    }
    
    /**
     * Check equality with another ChunkKey
     */
    equals(other) {
        if (!(other instanceof ChunkKey)) return false;
        return this.x === other.x && 
               this.y === other.y && 
               this.face === other.face && 
               this.lod === other.lod;
    }
    
    /**
     * Create a copy of this chunk key
     */
    clone() {
        return new ChunkKey(this.x, this.y, this.face, this.lod);
    }
    
    /**
     * Get chunk at relative offset
     * @param {number} dx - X offset
     * @param {number} dy - Y offset
     * @returns {ChunkKey}
     */
    offset(dx, dy) {
        return new ChunkKey(this.x + dx, this.y + dy, this.face, this.lod);
    }
}
