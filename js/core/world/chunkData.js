/**
 * Enhanced ChunkData with proper typed array support and GPU compatibility
 */
export class ChunkData {
    constructor(chunkX, chunkY, size) {
        this.chunkX = chunkX;
        this.chunkY = chunkY;
        this.size = size;
        
        // Use typed arrays for better GPU compatibility
        this.tiles = new Uint32Array(size * size);
        
        // Standard heightmap for mesh vertices (size+1 x size+1)
        this.heights = new Float32Array((size + 1) * (size + 1));
        
        // Extended heightmap for normal computation (includes 2-unit padding on all sides)
        this.padding = 2;
        const extendedSize = size + 2 * this.padding;
        this.extendedHeights = new Float32Array((extendedSize + 1) * (extendedSize + 1));
        
        // Additional data
        this.entities = [];
        this.features = []; // Walkable features embedded into terrain
        this.staticFeatures = []; // Static features (rocks, trees, bushes, fences)
        this.normals = null; // Will be computed by generators
        this.macroData = null; // For biome/region data
        
        // Splat map data for terrain blending
        this.blendWeights = null;
        this.blendTypes = null;
        this.blendMapWidth = null;
    }

    // Interpolated height access (matches terrain rendering) - this should be the main method
    getHeight(x, y) {
        // Convert to floating point for interpolation
        const fx = parseFloat(x);
        const fy = parseFloat(y);
        
        // Clamp to valid range
        const u = Math.max(0, Math.min(this.size - 0.001, fx)); // Slightly less than size to avoid edge issues
        const v = Math.max(0, Math.min(this.size - 0.001, fy));
        
        // Get integer part and fractional part
        const x0 = Math.floor(u);
        const x1 = Math.min(this.size, x0 + 1); // Clamp to avoid out-of-bounds
        const y0 = Math.floor(v);
        const y1 = Math.min(this.size, y0 + 1);
        
        const tx = u - x0;
        const ty = v - y0;
        
        // Get the four corner heights
        const h00 = this.getHeightRaw(x0, y0);
        const h10 = this.getHeightRaw(x1, y0);
        const h01 = this.getHeightRaw(x0, y1);
        const h11 = this.getHeightRaw(x1, y1);
        
        // Bilinear interpolation
        const h0 = h00 * (1 - tx) + h10 * tx; // Interpolate along x for y=y0
        const h1 = h01 * (1 - tx) + h11 * tx; // Interpolate along x for y=y1
        const height = h0 * (1 - ty) + h1 * ty; // Interpolate along y
        
        return height;
    }

    // Raw height access without interpolation (for internal use)
    getHeightRaw(x, y) {
        const ix = Math.floor(x);
        const iy = Math.floor(y);
        
        if (ix < 0 || ix > this.size || iy < 0 || iy > this.size) {
            // Try to get from extended heights if available
            return this.getHeightExtended(x, y) || 0;
        }
        
        const index = iy * (this.size + 1) + ix;
        return this.heights[index];
    }

    setHeight(x, y, height) {
        if (x < 0 || x > this.size || y < 0 || y > this.size) {
            return false;
        }
        
        const index = y * (this.size + 1) + x;
        this.heights[index] = height;
        return true;
    }

    // Extended height access (for normal computation)
    getHeightExtended(x, y) {
        const ix = Math.floor(x);
        const iy = Math.floor(y);
        const extendedSize = this.size + 2 * this.padding;
        
        // Convert to extended coordinate system
        const ex = ix + this.padding;
        const ey = iy + this.padding;
        
        if (ex < 0 || ex > extendedSize || ey < 0 || ey > extendedSize) {
            return null;
        }
        
        const index = ey * (extendedSize + 1) + ex;
        return this.extendedHeights[index];
    }

    setHeightExtended(x, y, height, padding = this.padding) {
        const extendedSize = this.size + 2 * padding;
        const ex = x + padding;
        const ey = y + padding;
        
        if (ex < 0 || ex > extendedSize || ey < 0 || ey > extendedSize) {
            return false;
        }
        
        const index = ey * (extendedSize + 1) + ex;
        this.extendedHeights[index] = height;
        
        // Also set in standard height array if within bounds
        if (x >= 0 && x <= this.size && y >= 0 && y <= this.size) {
            this.setHeight(x, y, height);
        }
        
        return true;
    }

    getTile(x, y) {
        if (x < 0 || x >= this.size || y < 0 || y >= this.size) {
            return null;
        }
        
        const index = y * this.size + x;
        return this.tiles[index];
    }

    setTile(x, y, tileId) {
        if (x < 0 || x >= this.size || y < 0 || y >= this.size) {
            return false;
        }
        
        const index = y * this.size + x;
        this.tiles[index] = tileId;
        return true;
    }

    // Get macro data (biome, region info) for a specific tile
    getMacroData(x, y) {
        if (!this.macroData || x < 0 || x >= this.size || y < 0 || y >= this.size) {
            return null;
        }
        
        const index = (y * this.size + x) * 3;
        return {
            moisture: this.macroData[index],
            temperature: this.macroData[index + 1],
            elevation: this.macroData[index + 2]
        };
    }

    addEntity(entity) {
        this.entities.push(entity);
    }

    // Add a walkable feature (modifies terrain)
    addFeature(feature) {
        this.features.push(feature);
    }

    // Add a static feature (doesn't modify terrain)
    addStaticFeature(feature) {
        this.staticFeatures.push(feature);
    }

    // Get all features at a specific tile position
    getFeaturesAt(x, y) {
        const allFeatures = [];
        
        // Check walkable features
        for (const feature of this.features) {
            if (this.isInFeatureBounds(x, y, feature)) {
                allFeatures.push(feature);
            }
        }
        
        // Check static features
        for (const feature of this.staticFeatures) {
            if (this.isInFeatureBounds(x, y, feature)) {
                allFeatures.push(feature);
            }
        }
        
        return allFeatures;
    }

    // Check if a coordinate is within a feature's bounds
    isInFeatureBounds(x, y, feature) {
        if (!feature.boundingBox) return false;
        const { minX, maxX, minY, maxY } = feature.boundingBox;
        return x >= minX && x <= maxX && y >= minY && y <= maxY;
    }

    // Get all static features of a specific type
    getStaticFeaturesByType(type) {
        return this.staticFeatures.filter(f => f.type === type);
    }

    // Helper method to get tile coordinates from world position
    worldToLocal(worldX, worldY) {
        return {
            x: worldX - (this.chunkX * this.size),
            y: worldY - (this.chunkY * this.size)
        };
    }

    // Helper method to check if coordinates are within chunk bounds
    isValidCoordinate(x, y) {
        return x >= 0 && x < this.size && y >= 0 && y < this.size;
    }

    // Get vertex data for rendering (preserves typed arrays)
    getVertexData() {
        return {
            heights: this.heights,      // Float32Array
            normals: this.normals,      // Float32Array  
            tiles: this.tiles           // Uint32Array
        };
    }

    // Convert tile data to regular array if needed for compatibility
    getTilesAsArray() {
        return Array.from(this.tiles);
    }

    // Convert height data to regular array if needed for compatibility
    getHeightsAsArray() {
        return Array.from(this.heights);
    }

    // Debug info
    getDebugInfo() {
        return {
            chunkX: this.chunkX,
            chunkY: this.chunkY,
            size: this.size,
            heightsLength: this.heights.length,
            tilesLength: this.tiles.length,
            extendedHeightsLength: this.extendedHeights.length,
            normalsLength: this.normals ? this.normals.length : 0,
            entitiesCount: this.entities.length,
            featuresCount: this.features.length,
            staticFeaturesCount: this.staticFeatures.length,
            staticFeatureTypes: {
                rocks: this.getStaticFeaturesByType('rock').length,
                trees: this.getStaticFeaturesByType('tree').length,
                bushes: this.getStaticFeaturesByType('bush').length,
                fences: this.getStaticFeaturesByType('fence').length
            },
            macroDataLength: this.macroData ? this.macroData.length : 0
        };
    }
}
