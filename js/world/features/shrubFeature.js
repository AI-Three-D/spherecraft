/**
 * Shrub feature class for representing shrubs and bushes in the world
 */
export class ShrubFeature {
    /**
     * Create a new shrub feature
     * @param {Object} params - Shrub parameters
     * @param {string} params.subtype - Shrub type (BUSH, FERN, HEATHER, etc.)
     * @param {number} params.variant - Visual variant index
     * @param {Object} params.position - World position {x, y, z}
     * @param {number} params.rotation - Rotation around Y axis in radians
     * @param {Object|number} params.scale - Scale multiplier (can be {x,y,z} or single number)
     * @param {number} params.shapeSeed - Seed for procedural shape generation
     */
    constructor(params) {
        this.type = 'shrub';
        this.subtype = params.subtype || 'BUSH';
        this.variant = params.variant || 0;
        this.position = params.position;
        this.rotation = { x: 0, y: params.rotation || 0, z: 0 };
        
        // Handle both single number and object scale
        if (typeof params.scale === 'number') {
            this.scale = { x: params.scale, y: params.scale, z: params.scale };
        } else {
            this.scale = params.scale || { x: 1, y: 1, z: 1 };
        }
        
        this.shapeSeed = params.shapeSeed;
        
        // Feature properties
        this.isStatic = true;
        this.isProp = true;
        this.isInstanced = true;
        
        // For compatibility with existing systems
        this.parameters = { 
            variant: this.variant
        };
    }
    
    /**
     * Get feature type identifier
     * @returns {string} Feature type
     */
    getType() {
        return this.type;
    }
    
    /**
     * Get shape seed for procedural generation
     * @returns {number} Shape seed
     */
    getShapeSeed() {
        return this.shapeSeed;
    }
    
    /**
     * Get global unique identifier
     * @returns {string} Global ID
     */
    getGlobalId() {
        return `shrub_${this.subtype}_${this.variant}_${this.shapeSeed}`;
    }
    

    
    /**
     * Create a shrub cluster with multiple shrub instances
     * @param {Object} params - Cluster parameters
     * @param {Object} params.centerPosition - Center position of cluster
     * @param {string} params.shrubType - Type of shrub
     * @param {number} params.clusterSize - Number of shrub instances in cluster
     * @param {number} params.clusterRadius - Radius of cluster
     * @param {number} params.baseSeed - Base seed for generation
     * @returns {Array<ShrubFeature>} Array of shrub features forming a cluster
     * @static
     */
    static createShrubCluster(params) {
        const {
            centerPosition,
            shrubType = 'BUSH',
            clusterSize = 3,
            clusterRadius = 1.5,
            baseSeed
        } = params;
        
        const cluster = [];
        
        // Create seeded random function
        const seededRandom = (seed) => {
            const x = Math.sin(seed) * 10000;
            return x - Math.floor(x);
        };
        
        for (let i = 0; i < clusterSize; i++) {
            const seed = baseSeed + i;
            
            // Random position within cluster radius
            const angle = seededRandom(seed) * Math.PI * 2;
            const distance = seededRandom(seed + 1000) * clusterRadius;
            
            const position = {
                x: centerPosition.x + Math.cos(angle) * distance,
                y: centerPosition.y,
                z: centerPosition.z + Math.sin(angle) * distance
            };
            
            const shrub = new ShrubFeature({
                subtype: shrubType,
                variant: Math.floor(seededRandom(seed + 2000) * 3), // 3 variants
                position: position,
                rotation: seededRandom(seed + 3000) * Math.PI * 2,
                scale: {
                    x: 0.7 + seededRandom(seed + 4000) * 0.6,
                    y: 0.8 + seededRandom(seed + 5000) * 0.4,
                    z: 0.7 + seededRandom(seed + 6000) * 0.6
                },
                shapeSeed: Math.floor(seed + 7000)
            });
            
            cluster.push(shrub);
        }
        
        return cluster;
    }
}
