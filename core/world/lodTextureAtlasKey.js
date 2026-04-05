// js/world/lodTextureAtlasKey.js
// Atlas key with LOD level support

export class LODTextureAtlasKey {
    constructor(atlasX, atlasY, lod, face = null, config = null) {
        if (typeof atlasX !== 'number' || isNaN(atlasX)) {
            throw new Error('LODTextureAtlasKey: Invalid atlasX: ' + atlasX);
        }
        if (typeof atlasY !== 'number' || isNaN(atlasY)) {
            throw new Error('LODTextureAtlasKey: Invalid atlasY: ' + atlasY);
        }
        if (typeof lod !== 'number' || lod < 0) {
            throw new Error('LODTextureAtlasKey: Invalid lod: ' + lod);
        }
        if (!config) {
            throw new Error('LODTextureAtlasKey: config is required');
        }
        
        this.atlasX = atlasX;
        this.atlasY = atlasY;
        this.lod = lod;
        this.face = face;
        this.config = config;
        
        this.lodConfig = config.getConfigForLOD(lod);
        
        this._worldMinX = atlasX * config.worldCoverage;
        this._worldMaxX = this._worldMinX + config.worldCoverage;
        this._worldMinY = atlasY * config.worldCoverage;
        this._worldMaxY = this._worldMinY + config.worldCoverage;
    }
    
    toString() {
        const sizeStr = this.lodConfig.textureSize;
        if (this.face === null) {
            return `lod${this.lod}_atlas_${this.atlasX},${this.atlasY}_${sizeStr}`;
        }
        return `lod${this.lod}_atlas_f${this.face}_${this.atlasX},${this.atlasY}_${sizeStr}`;
    }
    
    static fromChunkCoords(chunkX, chunkY, lod, face = null, config = null) {
        if (!config) {
            throw new Error('LODTextureAtlasKey.fromChunkCoords requires config');
        }
        const worldX = chunkX * config.baseChunkSize;
        const worldY = chunkY * config.baseChunkSize;
        const { atlasX, atlasY } = config.getAtlasCoords(worldX, worldY);
        
        return new LODTextureAtlasKey(atlasX, atlasY, lod, face, config);
    }
    
    static fromWorldPosition(worldX, worldY, distance, face = null, config = null) {
        if (!config) {
            throw new Error('LODTextureAtlasKey.fromWorldPosition requires config');
        }
        const lod = config.getLODForDistance(distance);
        const { atlasX, atlasY } = config.getAtlasCoords(worldX, worldY);
        
        return new LODTextureAtlasKey(atlasX, atlasY, lod, face, config);
    }
    
    static fromString(keyString, config = null) {
        if (!config) {
            throw new Error('LODTextureAtlasKey.fromString requires config');
        }
        // Format: "lod0_atlas_0,0_1024" or "lod0_atlas_f0_0,0_1024"
        const lodMatch = keyString.match(/^lod(\d+)_atlas_/);
        if (!lodMatch) {
            throw new Error('LODTextureAtlasKey.fromString: Invalid format: ' + keyString);
        }
        
        const lod = parseInt(lodMatch[1], 10);
        const remainder = keyString.substring(lodMatch[0].length);
        
        let face = null;
        let coordsPart;
        
        if (remainder.startsWith('f')) {
            const faceEnd = remainder.indexOf('_');
            face = parseInt(remainder.substring(1, faceEnd), 10);
            coordsPart = remainder.substring(faceEnd + 1);
        } else {
            coordsPart = remainder;
        }
        
        const [coords] = coordsPart.split('_');
        const [atlasX, atlasY] = coords.split(',').map(Number);
        
        return new LODTextureAtlasKey(atlasX, atlasY, lod, face, config);
    }
    
    getChunkUVTransform(chunkX, chunkY) {
        return this.config.getChunkUVTransform(chunkX, chunkY);
    }
    
    containsWorldPosition(worldX, worldY) {
        return worldX >= this._worldMinX && worldX < this._worldMaxX &&
               worldY >= this._worldMinY && worldY < this._worldMaxY;
    }
    
    containsChunk(chunkX, chunkY) {
        const worldX = chunkX * this.config.baseChunkSize;
        const worldY = chunkY * this.config.baseChunkSize;
        return this.containsWorldPosition(worldX, worldY);
    }
    
    getWorldBounds() {
        return {
            minX: this._worldMinX,
            maxX: this._worldMaxX,
            minY: this._worldMinY,
            maxY: this._worldMaxY,
            width: this.config.worldCoverage,
            height: this.config.worldCoverage
        };
    }
    
    getCoveredChunks() {
        const chunks = [];
        const baseChunkX = this.atlasX * this.config.chunksPerAtlas;
        const baseChunkY = this.atlasY * this.config.chunksPerAtlas;
        
        for (let y = 0; y < this.config.chunksPerAtlas; y++) {
            for (let x = 0; x < this.config.chunksPerAtlas; x++) {
                chunks.push({
                    chunkX: baseChunkX + x,
                    chunkY: baseChunkY + y
                });
            }
        }
        
        return chunks;
    }
    
    equals(other) {
        if (!(other instanceof LODTextureAtlasKey)) return false;
        return this.atlasX === other.atlasX &&
               this.atlasY === other.atlasY &&
               this.lod === other.lod &&
               this.face === other.face;
    }
    
    atLOD(newLOD) {
        return new LODTextureAtlasKey(
            this.atlasX,
            this.atlasY,
            newLOD,
            this.face,
            this.config
        );
    }
}
