/**
 * ChunkCullingManager - Handles ONLY visibility/culling logic
 * LOD is now handled by LODManager
 */
export class ChunkCullingManager {
    constructor(config) {
        this.chunkSize = config.chunkSize;
        this.viewDistance = config.viewDistance;
        this.margin = config.margin;
        
        // Distance thresholds
        this.loadDistance = this.viewDistance;
        this.unloadDistance = this.viewDistance + this.margin;
        
        
    }

    updateVisibleChunks(terrain, cameraPosition) {
        const viewDistance = this.viewDistance;
        const margin = this.margin;
        
        // Use different distances for load/unload to prevent flickering
        const loadDistance = viewDistance;
        const unloadDistance = viewDistance + margin;
        
        const visibleChunks = new Set();
        const chunksToStay = new Set();
        
        const minChunkX = Math.floor((cameraPosition.x - loadDistance) / this.chunkSize);
        const maxChunkX = Math.ceil((cameraPosition.x + loadDistance) / this.chunkSize);
        const minChunkZ = Math.floor((cameraPosition.z - loadDistance) / this.chunkSize);
        const maxChunkZ = Math.ceil((cameraPosition.z + loadDistance) / this.chunkSize);
        
        // Visible chunks (for loading)
        for (let cx = minChunkX; cx <= maxChunkX; cx++) {
            for (let cz = minChunkZ; cz <= maxChunkZ; cz++) {
                const chunkKey = `${cx},${cz}`;
                if (terrain.has(chunkKey)) {
                    visibleChunks.add(chunkKey);
                }
            }
        }
        
        // Chunks to stay (use larger distance)
        const minStayX = Math.floor((cameraPosition.x - unloadDistance) / this.chunkSize);
        const maxStayX = Math.ceil((cameraPosition.x + unloadDistance) / this.chunkSize);
        const minStayZ = Math.floor((cameraPosition.z - unloadDistance) / this.chunkSize);
        const maxStayZ = Math.ceil((cameraPosition.z + unloadDistance) / this.chunkSize);
        
        for (let cx = minStayX; cx <= maxStayX; cx++) {
            for (let cz = minStayZ; cz <= maxStayZ; cz++) {
                const chunkKey = `${cx},${cz}`;
                if (terrain.has(chunkKey)) {
                    chunksToStay.add(chunkKey);
                }
            }
        }
        
        return { visibleChunks, chunksToStay };
    }

    /**
     * Get world-space position of chunk's origin (bottom-left corner)
     */
    _getChunkWorldPosition(chunk) {
        return {
            x: chunk.chunkX * chunk.size,
            z: chunk.chunkY * chunk.size
        };
    }

    /**
     * Calculate distance from camera to nearest point on chunk
     * Uses AABB (axis-aligned bounding box) distance
     */
    _calculateDistanceToChunk(camX, camZ, chunkWorldPos, chunkSize) {
        const minX = chunkWorldPos.x;
        const maxX = chunkWorldPos.x + chunkSize;
        const minZ = chunkWorldPos.z;
        const maxZ = chunkWorldPos.z + chunkSize;

        // Clamp camera position to chunk bounds
        const clampedX = Math.max(minX, Math.min(camX, maxX));
        const clampedZ = Math.max(minZ, Math.min(camZ, maxZ));
        
        // Distance to nearest point
        const dx = clampedX - camX;
        const dz = clampedZ - camZ;
        
        return Math.sqrt(dx * dx + dz * dz);
    }
    
    /**
     * Get distance to chunk center (alternative calculation)
     * Useful for LOD that wants to consider chunk center
     */
    getDistanceToChunkCenter(chunk, cameraPosition) {
        const centerX = (chunk.chunkX + 0.5) * chunk.size;
        const centerZ = (chunk.chunkY + 0.5) * chunk.size;
        
        const dx = centerX - cameraPosition.x;
        const dz = centerZ - cameraPosition.z;
        
        return Math.sqrt(dx * dx + dz * dz);
    }
    
    /**
     * Check if camera is inside a chunk
     */
    isCameraInChunk(chunk, cameraPosition) {
        const minX = chunk.chunkX * chunk.size;
        const maxX = (chunk.chunkX + 1) * chunk.size;
        const minZ = chunk.chunkY * chunk.size;
        const maxZ = (chunk.chunkY + 1) * chunk.size;
        
        return cameraPosition.x >= minX && 
               cameraPosition.x <= maxX && 
               cameraPosition.z >= minZ && 
               cameraPosition.z <= maxZ;
    }
    
    /**
     * Get chunk coordinates from world position
     */
    worldToChunkCoords(worldX, worldZ) {
        return {
            chunkX: Math.floor(worldX / this.chunkSize),
            chunkY: Math.floor(worldZ / this.chunkSize)
        };
    }
    
    /**
     * Get chunk key from world position
     */
    worldToChunkKey(worldX, worldZ) {
        const coords = this.worldToChunkCoords(worldX, worldZ);
        return `${coords.chunkX},${coords.chunkY}`;
    }
}
