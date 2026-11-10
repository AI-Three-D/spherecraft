export class TerrainFeature {
    constructor(candidate, shapeSeed, globalId, boundingBox, worldPos, chunkX, chunkY, chunkSize, tiles, isStatic = false) {
        this.shapeSeed = shapeSeed;
        this.globalId = globalId;
        this.boundingBox = boundingBox; // expect minX/maxX/minY/maxY with NO padding
        this.chunkX = chunkX;
        this.chunkY = chunkY;
        this.chunkSize = chunkSize;
        this.type = candidate?.type ?? 'unknown';
        this.priority = candidate?.priority ?? 0;
        this.position = worldPos;
        this.tiles = tiles; // Uint32Array of width*height, ordered [y * width + x]
        this.rotation = { x: 0, y: 0, z: 0 };
        this.scale = { x: 1, y: 1, z: 1 };
        this.affectedTiles = [];
        this.heightmapData = null;
        this.candidate = candidate; 
        this.isStatic = isStatic;
        this.regionMinX = boundingBox.minX;
        this.regionMinY = boundingBox.minY;
        this.regionWidth = this.width;
        this.regionHeight = this.height;
        this.blendWidth = 0;
        this.blendHeight = 0;
        this.splatDensity = 4;
        this.isWalkable = false;
        this.isInstanced = false;
        this.requiresTerrainRimNormals = true;
    }

    // Rectangle grid dimensions (always non-padded)
    get width()  { return this.boundingBox.maxX - this.boundingBox.minX + 1; }
    get height() { return this.boundingBox.maxY - this.boundingBox.minY + 1; }
    get size()   { return this.width; } // for backward compat


        // Helper to get splat data at a specific splat coordinate
        getSplatData(splatX, splatY) {
            if (!this.blendWeights || !this.blendTypes) return null;
            
            const { width, height } = this.getSplatDimensions();
            if (splatX < 0 || splatX >= width || splatY < 0 || splatY >= height) return null;
            
            const idx = splatY * width + splatX;
            const weights = [];
            const types = [];
            
            for (let ch = 0; ch < 4; ch++) {
                weights.push(this.blendWeights[idx * 4 + ch] || 0);
                types.push(this.blendTypes[idx * 4 + ch] || 0);
            }
            
            return { weights, types };
        }
    getSplatDimensions() {
        return {
            width: this.blendWidth || (this.width - 1) * this.splatDensity,
            height: this.blendHeight || (this.height - 1) * this.splatDensity
        };
    }

    getShapeSeed() { return this.shapeSeed; }
    getGlobalId()  { return this.globalId; }

    // Tile accessor in local coordinates (no offset, no padding)
    getTile(x, y) {
        if (!this.tiles) return 0;
        if (x < 0 || x >= this.width || y < 0 || y >= this.height) return 0;
        return this.tiles[y * this.width + x] ?? 0;
    }

    setTile(x, y, tileId) {
        if (!this.tiles) return false;
        if (x < 0 || x >= this.width || y < 0 || y >= this.height) return false;
        this.tiles[y * this.width + x] = tileId;
        return true;
    }

    // Heightmap accessor (no offset, no padding)
    getHeight(x, y) {
        if (!this.heightmapData) return 0;
        if (x < 0 || x >= this.width || y < 0 || y >= this.height) return 0;
        return this.heightmapData[y * this.width + x];
    }

    setHeightmapData(heightmapData) {
        this.heightmapData = heightmapData;
    }

    attachTerrainAccessor(accessorFn) { this._terrainAccessor = accessorFn; }
    getTerrainAccessor() { return this._terrainAccessor; }
}