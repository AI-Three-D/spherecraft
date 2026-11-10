/**
 * Utility for generating consistent shape seeds and unique global IDs
 */
export class TerrainSeedGenerator {
    constructor(worldSeed) {
        this.worldSeed = worldSeed;
        this.globalIdCounter = 0;
        
        // Cache for shape seeds to ensure consistent reuse
        this.shapeSeedCache = new Map();
        
        // Shape variety pools - how many different shapes per feature type
        this.shapeVarietyPools = {
            'cliff': 16,   // 16 different cliff shapes
            'rock': 24,    // 24 different rock shapes
            'ravine': 8,   // 8 different ravine shapes
            'tree': 32,    // 32 different tree shapes
            'boulder': 12  // etc.
        };
    }

    /**
     * Generate a consistent shape seed based on feature characteristics
     * This ensures similar features get similar shapes
     * @param {string} featureType - Type of feature ('cliff', 'rock', etc.)
     * @param {Object} characteristics - Feature characteristics that should influence shape
     * @returns {number} Shape seed for mesh generation
     */
    generateShapeSeed(featureType, characteristics = {}) {
        // Create a deterministic hash of the characteristics
        const charKey = this.hashCharacteristics(featureType, characteristics);
        
        if (this.shapeSeedCache.has(charKey)) {
            return this.shapeSeedCache.get(charKey);
        }

        // Generate seed based on characteristics, not position
        const poolSize = this.shapeVarietyPools[featureType] || 16;
        const hash = this.simpleHash(charKey);
        const shapeSeed = this.worldSeed + (hash % poolSize) * 1000 + this.getTypeHash(featureType);
        
        this.shapeSeedCache.set(charKey, shapeSeed);
        return shapeSeed;
    }

    /**
     * Generate a globally unique ID for a feature instance
     * @returns {string} Unique global ID
     */
    generateGlobalId() {
        return `feature_${this.worldSeed}_${++this.globalIdCounter}_${Date.now()}`;
    }

    /**
     * Hash feature characteristics to create consistent grouping
     * Features with similar characteristics should get similar shapes
     */
    hashCharacteristics(featureType, characteristics) {
        const parts = [featureType];
        
        // Add relevant characteristics that should affect shape
        if (characteristics.size) {
            parts.push(`size_${Math.floor(characteristics.size)}`);
        }
        if (characteristics.steepness) {
            parts.push(`steep_${Math.floor(characteristics.steepness * 10)}`);
        }
        if (characteristics.complexity) {
            parts.push(`complex_${Math.floor(characteristics.complexity * 10)}`);
        }
        if (characteristics.biome) {
            parts.push(`biome_${characteristics.biome}`);
        }
        
        return parts.join('|');
    }

    /**
     * Simple hash function for string input
     */
    simpleHash(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        return Math.abs(hash);
    }

    /**
     * Get a consistent hash for feature type
     */
    getTypeHash(featureType) {
        const typeHashes = {
            'cliff': 100,
            'rock': 200,
            'ravine': 300,
            'tree': 400,
            'boulder': 500
        };
        return typeHashes[featureType] || 0;
    }

    /**
     * Clear the cache (call when world changes)
     */
    clearCache() {
        this.shapeSeedCache.clear();
        this.globalIdCounter = 0;
    }

    /**
     * Get statistics about shape reuse
     */
    getStats() {
        return {
            uniqueShapes: this.shapeSeedCache.size,
            globalIdCounter: this.globalIdCounter
        };
    }
}