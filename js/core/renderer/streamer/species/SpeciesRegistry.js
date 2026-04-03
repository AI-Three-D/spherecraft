// js/renderer/streamer/species/SpeciesRegistry.js
//
// Central registry for all tree and plant species.
// Species define visual characteristics, climate preferences, and LOD parameters.

import { Logger } from '../../../../shared/Logger.js';

/**
 * @typedef {object} TreeSpeciesDefinition
 * @property {string} id - Unique identifier
 * @property {string} name - Display name
 * @property {string} category - Climate category
 * @property {string} geometryType - Base geometry type for asset system
 * @property {object} climate - { temperature: [min,max], precipitation: [min,max] }
 * @property {object} size - { trunk: {radius,height}, canopy: {radius,height}, heightRange: [min,max] }
 * @property {object} foliage - { type, density, color: {base,tip,variation} }
 * @property {object} bark - { color, roughness }
 * @property {number[]} lodDistances - Per-detail-level distances
 * @property {object} leafParams - { shape, size, density, clustering }
 */

export const TREE_CATEGORIES = {
    CONIFEROUS: {
        climate: { temperature: [0.0, 0.45], precipitation: [0.25, 0.8] },
        species: ['spruce', 'pine']
    },
    NORTHERN_DECIDUOUS: {
        climate: { temperature: [0.15, 0.5], precipitation: [0.35, 0.75] },
        species: ['birch', 'alder']
    },
    TEMPERATE_DECIDUOUS: {
        climate: { temperature: [0.35, 0.7], precipitation: [0.3, 0.75] },
        species: ['oak', 'beech']
    },
    TROPICAL: {
        climate: { temperature: [0.7, 1.0], precipitation: [0.6, 1.0] },
        species: ['palm_coconut', 'teak']
    },
    DESERT_ARID: {
        climate: { temperature: [0.5, 1.0], precipitation: [0.0, 0.35] },
        species: ['baobab', 'saguaro']
    }
};

/**
 * Detail levels for progressive tree rendering.
 * Each level defines the rendering approach at a distance range.
 */
export const TREE_DETAIL_LEVELS = {
    L0_INSPECTION: { 
        index: 0, 
        name: 'Inspection',
        maxDistance: 15,
        useBranches: true,
        useClusters: true,
        useCanopy: false
    },
    L1_CLOSE: { 
        index: 1, 
        name: 'Close',
        maxDistance: 70,
        useBranches: true,
        useClusters: true,
        useCanopy: false
    },
    L2_MEDIUM: { 
        index: 2, 
        name: 'Medium',
        maxDistance: 150,
        useBranches: false,
        useClusters: true,
        useCanopy: true,
        canopyBlend: 0.5
    },
    L3_STANDARD: { 
        index: 3, 
        name: 'Standard',
        maxDistance: 800,
        useBranches: false,
        useClusters: false,
        useCanopy: true
    },
    L4_FAR: { 
        index: 4, 
        name: 'Far',
        maxDistance: 2000,
        useBranches: false,
        useClusters: false,
        useCanopy: true,
        useBillboard: true
    },
    L5_DISTANT: { 
        index: 5, 
        name: 'Distant',
        maxDistance: 6000,
        useBranches: false,
        useClusters: false,
        useCanopy: false,
        useBillboard: true
    }
};

/**
 * Default species definitions.
 * These define the visual and behavioral characteristics of each tree type.
 */
const DEFAULT_SPECIES = [
    // ═══════════════════════════════════════════════════════════════════════
    // CONIFEROUS
    // ═══════════════════════════════════════════════════════════════════════
    {
        id: 'spruce',
        name: 'Spruce',
        category: 'CONIFEROUS',
        geometryType: 'conifer',
        climate: { temperature: [0.05, 0.35], precipitation: [0.3, 0.7] },
        size: {
            trunk: { radiusBase: 0.3, radiusTop: 0.08, height: 0.35 },
            canopy: { radius: 0.35, heightStart: 0.15, heightEnd: 1.0 },
            heightRange: [14, 30]
        },
        foliage: {
            type: 'needle',
            density: 1.2,
            color: { base: [0.05, 0.15, 0.05], tip: [0.08, 0.25, 0.08], variation: 0.1 }
        },
        bark: { color: [0.25, 0.18, 0.12], roughness: 0.8 },
        leafParams: {
            shape: 'needle_cluster',
            size: [0.15, 0.4],
            density: 1.2,
            clustering: 0.7
        }
    },
    {
        id: 'pine',
        name: 'Pine',
        category: 'CONIFEROUS',
        geometryType: 'conifer',
        climate: { temperature: [0.1, 0.45], precipitation: [0.25, 0.65] },
        size: {
            trunk: { radiusBase: 0.35, radiusTop: 0.1, height: 0.4 },
            canopy: { radius: 0.3, heightStart: 0.25, heightEnd: 1.0 },
            heightRange: [15, 35]
        },
        foliage: {
            type: 'needle',
            density: 0.9,
            color: { base: [0.08, 0.18, 0.06], tip: [0.12, 0.28, 0.1], variation: 0.12 }
        },
        bark: { color: [0.4, 0.28, 0.18], roughness: 0.9 },
        leafParams: {
            shape: 'needle_long',
            size: [0.2, 0.5],
            density: 0.9,
            clustering: 0.5
        }
    },

    // ═══════════════════════════════════════════════════════════════════════
    // NORTHERN DECIDUOUS
    // ═══════════════════════════════════════════════════════════════════════
    {
        id: 'birch',
        name: 'Birch',
        category: 'NORTHERN_DECIDUOUS',
        geometryType: 'deciduous',
        climate: { temperature: [0.15, 0.45], precipitation: [0.4, 0.75] },
        size: {
            trunk: { radiusBase: 0.15, radiusTop: 0.06, height: 0.45 },
            canopy: { radius: 0.3, heightStart: 0.35, heightEnd: 1.0 },
            heightRange: [15, 30]
        },
        foliage: {
            type: 'broad_small',
            density: 1.0,
            color: { base: [0.15, 0.35, 0.1], tip: [0.25, 0.5, 0.15], variation: 0.15 }
        },
        bark: { color: [1.0, 1.0, 1.0], roughness: 0.3 },
        leafParams: {
            shape: 'oval_small',
            size: [0.08, 0.15],
            density: 1.1,
            clustering: 0.4
        }
    },
    {
        id: 'alder',
        name: 'Alder',
        category: 'NORTHERN_DECIDUOUS',
        geometryType: 'deciduous',
        climate: { temperature: [0.2, 0.5], precipitation: [0.45, 0.8] },
        size: {
            trunk: { radiusBase: 0.2, radiusTop: 0.08, height: 0.35 },
            canopy: { radius: 0.35, heightStart: 0.3, heightEnd: 0.95 },
            heightRange: [12, 25]
        },
        foliage: {
            type: 'broad_medium',
            density: 1.1,
            color: { base: [0.12, 0.28, 0.08], tip: [0.2, 0.42, 0.12], variation: 0.1 }
        },
        bark: { color: [0.35, 0.28, 0.22], roughness: 0.6 },
        leafParams: {
            shape: 'oval_medium',
            size: [0.1, 0.18],
            density: 1.0,
            clustering: 0.5
        }
    },

    // ═══════════════════════════════════════════════════════════════════════
    // TEMPERATE DECIDUOUS
    // ═══════════════════════════════════════════════════════════════════════
    {
        id: 'oak',
        name: 'Oak',
        category: 'TEMPERATE_DECIDUOUS',
        geometryType: 'deciduous_broad',
        climate: { temperature: [0.35, 0.65], precipitation: [0.35, 0.7] },
        size: {
            trunk: { radiusBase: 0.5, radiusTop: 0.25, height: 0.3 },
            canopy: { radius: 0.5, heightStart: 0.25, heightEnd: 1.0 },
            heightRange: [18, 35]
        },
        foliage: {
            type: 'broad_lobed',
            density: 1.3,
            color: { base: [0.1, 0.22, 0.06], tip: [0.18, 0.35, 0.12], variation: 0.12 }
        },
        bark: { color: [0.3, 0.22, 0.15], roughness: 0.85 },
        leafParams: {
            shape: 'lobed',
            size: [0.12, 0.22],
            density: 1.2,
            clustering: 0.6
        }
    },
    {
        id: 'beech',
        name: 'Beech',
        category: 'TEMPERATE_DECIDUOUS',
        geometryType: 'deciduous_broad',
        climate: { temperature: [0.3, 0.6], precipitation: [0.4, 0.75] },
        size: {
            trunk: { radiusBase: 0.4, radiusTop: 0.2, height: 0.35 },
            canopy: { radius: 0.45, heightStart: 0.3, heightEnd: 1.0 },
            heightRange: [20, 40]
        },
        foliage: {
            type: 'broad_oval',
            density: 1.4,
            color: { base: [0.08, 0.2, 0.05], tip: [0.15, 0.32, 0.1], variation: 0.08 }
        },
        bark: { color: [0.5, 0.48, 0.45], roughness: 0.25 },
        leafParams: {
            shape: 'oval_large',
            size: [0.1, 0.2],
            density: 1.3,
            clustering: 0.55
        }
    },

    // ═══════════════════════════════════════════════════════════════════════
    // TROPICAL
    // ═══════════════════════════════════════════════════════════════════════
    {
        id: 'palm_coconut',
        name: 'Coconut Palm',
        category: 'TROPICAL',
        geometryType: 'palm',
        climate: { temperature: [0.75, 1.0], precipitation: [0.6, 1.0] },
        size: {
            trunk: { radiusBase: 0.2, radiusTop: 0.15, height: 0.9 },
            canopy: { radius: 0.35, heightStart: 0.85, heightEnd: 1.0 },
            heightRange: [15, 30]
        },
        foliage: {
            type: 'frond',
            density: 0.8,
            color: { base: [0.1, 0.35, 0.08], tip: [0.15, 0.5, 0.12], variation: 0.1 }
        },
        bark: { color: [0.45, 0.35, 0.25], roughness: 0.7 },
        leafParams: {
            shape: 'frond',
            size: [0.3, 0.8],
            density: 0.6,
            clustering: 0.9  // Fronds cluster tightly
        }
    },
    {
        id: 'teak',
        name: 'Teak',
        category: 'TROPICAL',
        geometryType: 'deciduous_tall',
        climate: { temperature: [0.7, 0.95], precipitation: [0.5, 0.9] },
        size: {
            trunk: { radiusBase: 0.35, radiusTop: 0.15, height: 0.4 },
            canopy: { radius: 0.4, heightStart: 0.35, heightEnd: 1.0 },
            heightRange: [25, 45]
        },
        foliage: {
            type: 'broad_large',
            density: 1.0,
            color: { base: [0.12, 0.3, 0.08], tip: [0.2, 0.45, 0.15], variation: 0.1 }
        },
        bark: { color: [0.4, 0.32, 0.22], roughness: 0.65 },
        leafParams: {
            shape: 'oval_large',
            size: [0.25, 0.45],
            density: 0.8,
            clustering: 0.5
        }
    },

    // ═══════════════════════════════════════════════════════════════════════
    // DESERT/ARID
    // ═══════════════════════════════════════════════════════════════════════
    {
        id: 'baobab',
        name: 'Baobab',
        category: 'DESERT_ARID',
        geometryType: 'deciduous_sparse',
        climate: { temperature: [0.6, 0.95], precipitation: [0.1, 0.4] },
        size: {
            trunk: { radiusBase: 1.2, radiusTop: 0.4, height: 0.5 },
            canopy: { radius: 0.5, heightStart: 0.45, heightEnd: 1.0 },
            heightRange: [10, 25]
        },
        foliage: {
            type: 'broad_sparse',
            density: 0.5,
            color: { base: [0.15, 0.28, 0.1], tip: [0.22, 0.4, 0.15], variation: 0.15 }
        },
        bark: { color: [0.55, 0.48, 0.4], roughness: 0.5 },
        leafParams: {
            shape: 'palmate',
            size: [0.15, 0.3],
            density: 0.4,
            clustering: 0.3
        }
    },
    {
        id: 'saguaro',
        name: 'Saguaro Cactus',
        category: 'DESERT_ARID',
        geometryType: 'cactus',
        climate: { temperature: [0.7, 1.0], precipitation: [0.0, 0.25] },
        size: {
            trunk: { radiusBase: 0.25, radiusTop: 0.2, height: 0.85 },
            canopy: { radius: 0.0, heightStart: 1.0, heightEnd: 1.0 },  // No canopy
            heightRange: [8, 18]
        },
        foliage: {
            type: 'none',  // Cacti don't have leaves in the traditional sense
            density: 0.0,
            color: { base: [0.18, 0.32, 0.18], tip: [0.25, 0.42, 0.22], variation: 0.05 }
        },
        bark: { color: [0.2, 0.35, 0.18], roughness: 0.4 },
        leafParams: {
            shape: 'spine',
            size: [0.02, 0.05],
            density: 2.0,  // Dense spines
            clustering: 0.1
        }
    }
];

export class SpeciesRegistry {
    constructor() {
        /** @type {Map<string, object>} */
        this._species = new Map();
        
        /** @type {Map<string, string[]>} */
        this._byCategory = new Map();
        
        /** @type {Map<string, object>} */
        this._categories = new Map();
        
        this._initialized = false;
    }

    /**
     * Initialize with default species.
     */
    initialize() {
        if (this._initialized) return;

        // Register categories
        for (const [catId, catDef] of Object.entries(TREE_CATEGORIES)) {
            this._categories.set(catId, catDef);
            this._byCategory.set(catId, []);
        }

        // Register species
        for (const specDef of DEFAULT_SPECIES) {
            this.registerSpecies(specDef);
        }

        this._initialized = true;
        
        Logger.info(
            `[SpeciesRegistry] Initialized: ${this._species.size} species across ` +
            `${this._categories.size} categories`
        );
    }

    /**
     * Register a species definition.
     * @param {object} def
     */
    registerSpecies(def) {
        if (!def.id) {
            Logger.warn('[SpeciesRegistry] Species missing id');
            return;
        }

        this._species.set(def.id, def);

        // Index by category
        const category = def.category;
        if (category && this._byCategory.has(category)) {
            this._byCategory.get(category).push(def.id);
        }
    }

    /**
     * Get species by id.
     * @param {string} id
     * @returns {object|null}
     */
    getSpecies(id) {
        return this._species.get(id) || null;
    }

    /**
     * Get all species in a category.
     * @param {string} category
     * @returns {object[]}
     */
    getSpeciesInCategory(category) {
        const ids = this._byCategory.get(category) || [];
        return ids.map(id => this._species.get(id)).filter(Boolean);
    }

    /**
     * Get all species.
     * @returns {object[]}
     */
    getAllSpecies() {
        return Array.from(this._species.values());
    }

    /**
     * Get species ids.
     * @returns {string[]}
     */
    getSpeciesIds() {
        return Array.from(this._species.keys());
    }

    /**
     * Get category definition.
     * @param {string} category
     * @returns {object|null}
     */
    getCategory(category) {
        return this._categories.get(category) || null;
    }

    /**
     * Find species suitable for given climate conditions.
     * @param {number} temperature - 0-1
     * @param {number} precipitation - 0-1
     * @param {number} [minFitness=0.3]
     * @returns {{species: object, fitness: number}[]}
     */
    findSuitableSpecies(temperature, precipitation, minFitness = 0.3) {
        const results = [];

        for (const species of this._species.values()) {
            const climate = species.climate;
            if (!climate) continue;

            const tempFit = this._rangeFitness(temperature, climate.temperature);
            const precipFit = this._rangeFitness(precipitation, climate.precipitation);
            const fitness = tempFit * precipFit;

            if (fitness >= minFitness) {
                results.push({ species, fitness });
            }
        }

        results.sort((a, b) => b.fitness - a.fitness);
        return results;
    }

    /**
     * Calculate fitness for a value within a range.
     * @private
     */
    _rangeFitness(value, range) {
        if (!range || range.length < 2) return 1.0;
        const [min, max] = range;
        if (value < min || value > max) return 0.0;

        const center = (min + max) / 2;
        const halfRange = (max - min) / 2;
        const dist = Math.abs(value - center) / halfRange;
        return 1.0 - dist * 0.3;  // Slight falloff toward edges
    }

    /**
     * Get detail level for a given distance.
     * @param {number} distance
     * @returns {object}
     */
    getDetailLevel(distance) {
        for (const level of Object.values(TREE_DETAIL_LEVELS)) {
            if (distance < level.maxDistance) {
                return level;
            }
        }
        return TREE_DETAIL_LEVELS.L5_DISTANT;
    }

    /**
     * Get detail level by index.
     * @param {number} index
     * @returns {object|null}
     */
    getDetailLevelByIndex(index) {
        for (const level of Object.values(TREE_DETAIL_LEVELS)) {
            if (level.index === index) return level;
        }
        return null;
    }
}

// Singleton instance
let _registryInstance = null;

/**
 * Get the global species registry instance.
 * @returns {SpeciesRegistry}
 */
export function getSpeciesRegistry() {
    if (!_registryInstance) {
        _registryInstance = new SpeciesRegistry();
        _registryInstance.initialize();
    }
    return _registryInstance;
}
