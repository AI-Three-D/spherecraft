/**
 * Grass feature class for representing grass instances in the world
 */
export class GrassFeature {
    /**
     * Create a new grass feature
     * @param {Object} params - Grass parameters
     * @param {string} params.subtype - Grass type (MEADOW_GRASS, TALL_GRASS, etc.)
     * @param {number} params.variant - Visual variant index
     * @param {Object} params.position - World position {x, y, z}
     * @param {number} params.rotation - Rotation around Y axis in radians
     * @param {number} params.scale - Scale multiplier
     * @param {number} params.shapeSeed - Seed for procedural shape generation
     * @param {number} [params.clumpIndex] - Index within a grass clump (for grouped grass)
     */
    constructor(params) {
        this.type = 'grass';
        this.subtype = params.subtype || 'MEADOW_GRASS';
        this.variant = params.variant || 0;
        this.position = params.position;
        this.rotation = { x: 0, y: params.rotation || 0, z: 0 };
        this.scale = { x: params.scale || 1, y: params.scale || 1, z: params.scale || 1 };
        this.shapeSeed = params.shapeSeed;
        this.clumpIndex = params.clumpIndex || 0;
        
        // Feature properties
        this.isStatic = true;
        this.isProp = true;
        this.isInstanced = true;
        
        // For compatibility with existing systems
        this.parameters = { 
            variant: this.variant,
            clumpIndex: this.clumpIndex
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
        return `grass_${this.subtype}_${this.variant}_${this.shapeSeed}_${this.clumpIndex}`;
    }
    
    /**
     * Create a grass clump with multiple grass instances
     * @param {Object} params - Clump parameters
     * @param {Object} params.centerPosition - Center position of clump
     * @param {string} params.grassType - Type of grass
     * @param {number} params.clumpSize - Number of grass instances in clump
     * @param {number} params.clumpRadius - Radius of clump
     * @param {number} params.baseSeed - Base seed for generation
     * @returns {Array<GrassFeature>} Array of grass features forming a clump
     * @static
     */
    static createGrassClump(params) {
        const {
            centerPosition,
            grassType = 'MEADOW_GRASS',
            clumpSize = 5,
            clumpRadius = 0.3,
            baseSeed
        } = params;
        
        const clump = [];
        
        // Create seeded random function
        const seededRandom = (seed) => {
            const x = Math.sin(seed) * 10000;
            return x - Math.floor(x);
        };
        
        for (let i = 0; i < clumpSize; i++) {
            const seed = baseSeed + i;
            
            // Random position within clump radius
            const angle = seededRandom(seed) * Math.PI * 2;
            const distance = seededRandom(seed + 1000) * clumpRadius;
            
            const position = {
                x: centerPosition.x + Math.cos(angle) * distance,
                y: centerPosition.y,
                z: centerPosition.z + Math.sin(angle) * distance
            };
            
            const grass = new GrassFeature({
                subtype: grassType,
                variant: Math.floor(seededRandom(seed + 2000) * 4), // 4 variants
                position: position,
                rotation: seededRandom(seed + 3000) * Math.PI * 2,
                scale: 0.8 + seededRandom(seed + 4000) * 0.4, // Scale variation
                shapeSeed: Math.floor(seed + 5000),
                clumpIndex: i
            });
            
            clump.push(grass);
        }
        
        return clump;
    }
}
