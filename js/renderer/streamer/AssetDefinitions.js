// js/renderer/streamer/assetDefinitions.js

import { TILE_TYPES } from '../../types.js';
import { TREE_DENSITIES, TREE_LOD_DISTANCES } from './streamerConfig.js';

export const FOREST_TILES = [
    TILE_TYPES.FOREST_DENSE_SINGLE_1,
    TILE_TYPES.FOREST_SPARSE_SINGLE_1,
    TILE_TYPES.FOREST_DENSE_MIXED_1,
    TILE_TYPES.FOREST_SPARSE_MIXED_1,
    TILE_TYPES.FOREST_RAINFOREST_1,
    TILE_TYPES.FOREST_JUNGLE_1
];

export const GRASS_TILES = [
    TILE_TYPES.GRASS_SHORT_1,
    TILE_TYPES.GRASS_SHORT_2,
    TILE_TYPES.GRASS_SHORT_3,
    TILE_TYPES.GRASS_SHORT_4,
    TILE_TYPES.GRASS_MEDIUM_1,
    TILE_TYPES.GRASS_MEDIUM_2,
    TILE_TYPES.GRASS_MEDIUM_3,
    TILE_TYPES.GRASS_MEDIUM_4,
    TILE_TYPES.GRASS_TALL_1,
    TILE_TYPES.GRASS_TALL_2,
    TILE_TYPES.GRASS_TALL_3,
    TILE_TYPES.GRASS_TALL_4,
];

export const DESERT_TILES = [
    TILE_TYPES.DESERT_DRY_1,
    TILE_TYPES.DESERT_DRY_2,
    TILE_TYPES.DESERT_DRY_3,
    TILE_TYPES.DESERT_DRY_4,
    TILE_TYPES.DESERT_SEMI_ARID_1,
    TILE_TYPES.DESERT_SEMI_ARID_2,
    TILE_TYPES.DESERT_SEMI_ARID_3,
    TILE_TYPES.DESERT_SEMI_ARID_4,
];

export const DESERT_TREE_TILES = [
    TILE_TYPES.DESERT_TREES_DRY_1,
    TILE_TYPES.DESERT_TREES_DRY_2,
    TILE_TYPES.DESERT_TREES_DRY_3,
    TILE_TYPES.DESERT_TREES_DRY_4,
    TILE_TYPES.DESERT_TREES_SEMI_ARID_1,
    TILE_TYPES.DESERT_TREES_SEMI_ARID_2,
    TILE_TYPES.DESERT_TREES_SEMI_ARID_3,
    TILE_TYPES.DESERT_TREES_SEMI_ARID_4,
];

// Legacy migration fallback only.
// Live grass placement/tint tuning now lives in
// js/renderer/streamer/archetype/archetypeDefinitions.js overlay variants.
// These values remain here only so the legacy asset migration path still has
// sane defaults if the explicit overlay is missing.
// LOD 0-2 remain geometry-heavy; LOD 3-4 are billboard/impostor tiers.
const GRASS_LOD_DISTANCES = [60, 130, 190, 230, 260];
//const GRASS_DENSITIES     = [1.2, 0.65, 0.20, 0.020, 0.0025];
const GRASS_DENSITIES     = [0.2, 0.2, 0.20, 0.020, 0.0025];

export const DEFAULT_ASSET_DEFINITIONS = [
    // ════════════════════════════════════════════════════════════════════════
    // TREES
    // ════════════════════════════════════════════════════════════════════════

    {
        id: 'birch',
        category: 'tree',
        name: 'Birch',
        geometryType: 'deciduous',
        tileTypes: FOREST_TILES,
        climateRange: {
            temperature: [0.2, 0.5],
            precipitation: [0.4, 0.8]
        },
        elevationRange: [0.38, 0.62],
        slopeRange: [0.0, 0.3],
        lodDistances: TREE_LOD_DISTANCES,
        densities: TREE_DENSITIES,
        sizeRange: {
            width: [5.0, 9.0],
            height: [6.0, 20.0]
        },
        baseColor: [1.0, 1.0, 1.0],
        tipColor: [0.25, 0.45, 0.15],
        priority: 1.0,
        selfOcclusion: {
            gradientWidth: 0.5,
            strengthMul: 1.0,
            terrainEmbedding: 0.02,
            darkening: 0.9,
        },
    },

    // ════════════════════════════════════════════════════════════════════════
    // PLANTS — grass tufts (category 'plant' → CAT_PLANTS)
    // ════════════════════════════════════════════════════════════════════════

    {
        id: 'grass_short',
        category: 'plant',
        name: 'Short Grass',
        geometryType: 'grass_tuft',
        tileTypes: [...GRASS_TILES, ...FOREST_TILES],
        climateRange: {
            temperature: [0.0, 0.9],
            precipitation: [0.1, 0.9]
        },
        elevationRange: [0.35, 0.62],
        slopeRange: [0.0, 0.5],
        lodDistances: GRASS_LOD_DISTANCES,
        densities: GRASS_DENSITIES,
        sizeRange: {
            width: [0.3, 0.7],
            height: [0.3, 0.9]
        },
        baseColor: [0.18, 0.28, 0.08],
        tipColor: [0.35, 0.55, 0.15],
        priority: 1.0,
        selfOcclusion: {
            gradientWidth: 0.1,
            strengthMul: 1.0,
            terrainEmbedding: 0.01,
            darkening: 0.5,
        },
    },

    {
        id: 'grass_medium',
        category: 'plant',
        name: 'Medium Grass',
        geometryType: 'grass_tuft',
        tileTypes: [...GRASS_TILES, ...FOREST_TILES],
        climateRange: {
            temperature: [0.1, 0.85],
            precipitation: [0.2, 0.9]
        },
        elevationRange: [0.35, 0.60],
        slopeRange: [0.0, 0.45],
        lodDistances: GRASS_LOD_DISTANCES,
        densities: [0.9, 0.5, 0.15, 0.016, 0.0020],
        sizeRange: {
            width: [0.35, 0.8],
            height: [0.5, 1.4]
        },
        baseColor: [0.15, 0.25, 0.06],
        tipColor: [0.30, 0.50, 0.12],
        priority: 0.9,
        selfOcclusion: {
            gradientWidth: 0.2,
            strengthMul: 1.0,
            terrainEmbedding: 0.01,
            darkening: 0.6,
        },
    },

    {
        id: 'grass_tall',
        category: 'plant',
        name: 'Tall Grass',
        geometryType: 'grass_tuft',
        tileTypes: [...GRASS_TILES],
        climateRange: {
            temperature: [0.15, 0.8],
            precipitation: [0.3, 0.95]
        },
        elevationRange: [0.36, 0.58],
        slopeRange: [0.0, 0.35],
        lodDistances: GRASS_LOD_DISTANCES,
        densities: [0.6, 0.33, 0.11, 0.013, 0.0015],
        sizeRange: {
            width: [0.4, 0.9],
            height: [0.8, 2.2]
        },
        baseColor: [0.12, 0.22, 0.05],
        tipColor: [0.28, 0.48, 0.10],
        priority: 0.8,
        selfOcclusion: {
            gradientWidth: 0.3,
            strengthMul: 1.0,
            terrainEmbedding: 0.02,
            darkening: 0.75,
        },
    },

    {
        id: 'grass_dry',
        category: 'plant',
        name: 'Dry Grass',
        geometryType: 'grass_tuft',
        tileTypes: [...GRASS_TILES, ...DESERT_TILES, ...DESERT_TREE_TILES],
        climateRange: {
            temperature: [0.2, 0.95],
            precipitation: [0.05, 0.4]
        },
        elevationRange: [0.34, 0.62],
        slopeRange: [0.0, 0.5],
        lodDistances: GRASS_LOD_DISTANCES,
        densities: [0.75, 0.42, 0.14, 0.016, 0.0020],
        sizeRange: {
            width: [0.25, 0.6],
            height: [0.2, 0.7]
        },
        baseColor: [0.45, 0.38, 0.18],
        tipColor: [0.60, 0.52, 0.28],
        priority: 0.85,
        selfOcclusion: {
            gradientWidth: 0.36,
            strengthMul: 1.0,
            terrainEmbedding: 0.01,
            darkening: 0.90,
        },
    },
];

export function getDefinitionsByCategory(category) {
    return DEFAULT_ASSET_DEFINITIONS.filter(d => d.category === category);
}

export function getUniqueGeometryTypes() {
    const types = new Set();
    for (const def of DEFAULT_ASSET_DEFINITIONS) {
        types.add(def.geometryType);
    }
    return Array.from(types);
}
