import { Vector3, Vector4, MathUtils } from '../../shared/math/index.js';

/**
 * Manages the 3D cluster grid for clustered forward rendering
 */
export class ClusterGrid {
    constructor(options = {}) {
        // Grid dimensions (in clusters)
        this.gridSizeX = options.gridSizeX || 16;
        this.gridSizeY = options.gridSizeY || 8;
        this.gridSizeZ = options.gridSizeZ || 24;
        
        // View parameters (will be updated each frame)
        this.nearPlane = 0.1;
        this.farPlane = 1000;
        this.fieldOfView = 75;
        this.aspectRatio = 1.0;
        
        // Cluster data
        this.totalClusters = this.gridSizeX * this.gridSizeY * this.gridSizeZ;
        this.clusterDimensions = new Vector3(this.gridSizeX, this.gridSizeY, this.gridSizeZ);
        
        // Depth slicing (logarithmic by default)
        this.useLogarithmicDepth = options.useLogarithmicDepth !== false;
        this.depthSlices = new Float32Array(this.gridSizeZ + 1);
        
        // Cluster AABBs in view space

        
        this.clusterAABBs = new Float32Array(this.totalClusters * 6);
        
    }

    
    /**
     * Update grid based on camera parameters
     */
    updateFromCamera(camera) {
        this.nearPlane = camera.near;
        this.farPlane = camera.far;
        this.fieldOfView = camera.fov;
        this.aspectRatio = camera.aspect;
        
        // Recalculate depth slices
        this.calculateDepthSlices();
        
        // Rebuild cluster AABBs
        this.buildClusterAABBs(camera);
    }
    
    /**
     * Calculate depth slice positions (logarithmic or linear distribution)
     */
    calculateDepthSlices() {
        const near = this.nearPlane;
        const far = this.farPlane;
        
        for (let i = 0; i <= this.gridSizeZ; i++) {
            const t = i / this.gridSizeZ;
            
            if (this.useLogarithmicDepth) {
                // Logarithmic distribution for better near-plane precision
                this.depthSlices[i] = near * Math.pow(far / near, t);
            } else {
                // Linear distribution
                this.depthSlices[i] = near + t * (far - near);
            }
        }
    }
    
    buildClusterAABBs(camera) {
        const tanHalfFov = Math.tan(MathUtils.degToRad(this.fieldOfView * 0.5));
        
        for (let z = 0; z < this.gridSizeZ; z++) {
            // Get near and far depths for this slice (positive values)
            const nearDepth = this.depthSlices[z];
            const farDepth = this.depthSlices[z + 1];
            
            // In view space, we look down -Z, so these are negative
            const nearZ = -nearDepth;
            const farZ = -farDepth;
            
            // Calculate frustum dimensions at these depths
            const nearHeight = nearDepth * tanHalfFov * 2.0;
            const nearWidth = nearHeight * this.aspectRatio;
            const farHeight = farDepth * tanHalfFov * 2.0;
            const farWidth = farHeight * this.aspectRatio;
            
            for (let y = 0; y < this.gridSizeY; y++) {
                // Y bounds in NDC space
                const yNDCMin = (y / this.gridSizeY) * 2.0 - 1.0;
                const yNDCMax = ((y + 1) / this.gridSizeY) * 2.0 - 1.0;
                
                for (let x = 0; x < this.gridSizeX; x++) {
                    // X bounds in NDC space
                    const xNDCMin = (x / this.gridSizeX) * 2.0 - 1.0;
                    const xNDCMax = ((x + 1) / this.gridSizeX) * 2.0 - 1.0;
                    
                    // Convert NDC to view space at near and far planes
                    const xMinNear = xNDCMin * nearWidth * 0.5;
                    const xMaxNear = xNDCMax * nearWidth * 0.5;
                    const yMinNear = yNDCMin * nearHeight * 0.5;
                    const yMaxNear = yNDCMax * nearHeight * 0.5;
                    
                    const xMinFar = xNDCMin * farWidth * 0.5;
                    const xMaxFar = xNDCMax * farWidth * 0.5;
                    const yMinFar = yNDCMin * farHeight * 0.5;
                    const yMaxFar = yNDCMax * farHeight * 0.5;
                    
                    // Get AABB that contains the frustum slice
                    const clusterIdx = this.getClusterIndex(x, y, z);
                    const baseIdx = clusterIdx * 6;
                    
                    // AABB minimum
                    this.clusterAABBs[baseIdx + 0] = Math.min(xMinNear, xMinFar);
                    this.clusterAABBs[baseIdx + 1] = Math.min(yMinNear, yMinFar);
                    this.clusterAABBs[baseIdx + 2] = farZ; // More negative
                    
                    // AABB maximum
                    this.clusterAABBs[baseIdx + 3] = Math.max(xMaxNear, xMaxFar);
                    this.clusterAABBs[baseIdx + 4] = Math.max(yMaxNear, yMaxFar);
                    this.clusterAABBs[baseIdx + 5] = nearZ; // Less negative
                }
            }
        }
    }
    
    /**
     * Get cluster index from grid coordinates
     */
    getClusterIndex(x, y, z) {
        return z * (this.gridSizeX * this.gridSizeY) + y * this.gridSizeX + x;
    }
    
    /**
     * Get cluster coordinates from world position
     */
    worldToCluster(worldPos, camera) {
        // Transform world position to view space
        const viewPos = new Vector3();
        viewPos.copy(worldPos);
        viewPos.applyMatrix4(camera.matrixWorldInverse);

        // Get depth slice
        const depth = -viewPos.z; // View space looks down -Z
        let z = 0;
        for (let i = 1; i <= this.gridSizeZ; i++) {
            if (depth < this.depthSlices[i]) {
                z = i - 1;
                break;
            }
        }
        z = Math.min(z, this.gridSizeZ - 1);

        // Project to NDC
        const projMatrix = camera.projectionMatrix;
        const ndcPos = new Vector4(viewPos.x, viewPos.y, viewPos.z, 1.0);
        ndcPos.applyMatrix4(projMatrix);
        if (ndcPos.w !== 0) {
            ndcPos.x /= ndcPos.w;
            ndcPos.y /= ndcPos.w;
        }
        
        // NDC to cluster grid
        const x = Math.floor((ndcPos.x + 1.0) * 0.5 * this.gridSizeX);
        const y = Math.floor((ndcPos.y + 1.0) * 0.5 * this.gridSizeY);
        
        return {
            x: Math.max(0, Math.min(x, this.gridSizeX - 1)),
            y: Math.max(0, Math.min(y, this.gridSizeY - 1)),
            z: z,
            index: this.getClusterIndex(x, y, z)
        };
    }
    
    /**
     * Get AABB for a specific cluster
     */
    getClusterAABB(x, y, z) {
        const idx = this.getClusterIndex(x, y, z);
        const baseIdx = idx * 6;
        
        return {
            min: new Vector3(
                this.clusterAABBs[baseIdx + 0],
                this.clusterAABBs[baseIdx + 1],
                this.clusterAABBs[baseIdx + 2]
            ),
            max: new Vector3(
                this.clusterAABBs[baseIdx + 3],
                this.clusterAABBs[baseIdx + 4],
                this.clusterAABBs[baseIdx + 5]
            )
        };
    }

buildClusterDataTexture() {
    // Pack cluster data: 2 pixels per cluster
    // Pixel 0: min.xyz, near_depth
    // Pixel 1: max.xyz, far_depth
    
    const data = new Float32Array(this.totalClusters * 8);
    
    for (let i = 0; i < this.totalClusters; i++) {
        const baseIdx = i * 6;
        const texIdx = i * 8;
        
        // First pixel: min + near depth
        data[texIdx + 0] = this.clusterAABBs[baseIdx + 0];
        data[texIdx + 1] = this.clusterAABBs[baseIdx + 1];
        data[texIdx + 2] = this.clusterAABBs[baseIdx + 2];
        data[texIdx + 3] = this.clusterAABBs[baseIdx + 5]; // near Z
        
        // Second pixel: max + far depth  
        data[texIdx + 4] = this.clusterAABBs[baseIdx + 3];
        data[texIdx + 5] = this.clusterAABBs[baseIdx + 4];
        data[texIdx + 6] = this.clusterAABBs[baseIdx + 5]; // far Z
        data[texIdx + 7] = 0; // reserved
    }
    

    const texture = new Texture({
        width: this.totalClusters * 2,
        height: 1,
        format: TextureFormat.RGBA32F,
        minFilter: TextureFilter.NEAREST,
        magFilter: TextureFilter.NEAREST,
        wrapS: TextureWrap.CLAMP,
        wrapT: TextureWrap.CLAMP,
        generateMipmaps: false,
        data: data
    });
    
    return texture;
}
    /**
     * Get memory usage stats
     */
    getStats() {
        return {
            clusters: this.totalClusters,
            gridSize: `${this.gridSizeX}x${this.gridSizeY}x${this.gridSizeZ}`,
            memoryBytes: this.clusterAABBs.byteLength + this.depthSlices.byteLength
        };
    }
    
    /**
     * Cleanup
     */
    cleanup() {

    }
}
