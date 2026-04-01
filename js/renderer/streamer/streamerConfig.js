// js/renderer/streamer/streamerConfig.js
//
// Add these EXPORTS near the top after the existing tile arrays:

// ═══════════════════════════════════════════════════════════════════════
// Inc 3: Exported tile type collections for archetypeDefinitions.js
// ═══════════════════════════════════════════════════════════════════════
import { TILE_TYPES } from '../../types.js';

export { FOREST_TILES };

export const ROCKY_TILES = [
    TILE_TYPES.ROCK_OUTCROP_1,
    TILE_TYPES.ROCK_SLAB_1,
    TILE_TYPES.ROCK_BOULDER_1,
];

export const DAMP_FOREST_TILES = [
    TILE_TYPES.FOREST_DENSE_SINGLE_1,
    TILE_TYPES.FOREST_DENSE_MIXED_1,
    TILE_TYPES.FOREST_RAINFOREST_1,
    TILE_TYPES.FOREST_JUNGLE_1,
];


export const NUM_CATEGORIES = 3;
export const LODS_PER_CATEGORY = 5;
export const TOTAL_BANDS = NUM_CATEGORIES * LODS_PER_CATEGORY; // 15

const DESERT_TREE_TILES = [
    TILE_TYPES.DESERT_TREES_DRY_1,
    TILE_TYPES.DESERT_TREES_DRY_2,
    TILE_TYPES.DESERT_TREES_DRY_3,
    TILE_TYPES.DESERT_TREES_DRY_4,
    TILE_TYPES.DESERT_TREES_SEMI_ARID_1,
    TILE_TYPES.DESERT_TREES_SEMI_ARID_2,
    TILE_TYPES.DESERT_TREES_SEMI_ARID_3,
    TILE_TYPES.DESERT_TREES_SEMI_ARID_4,
];

const DESERT_TILES = [
    TILE_TYPES.DESERT_DRY_1,
    TILE_TYPES.DESERT_DRY_2,
    TILE_TYPES.DESERT_DRY_3,
    TILE_TYPES.DESERT_DRY_4,
    TILE_TYPES.DESERT_SEMI_ARID_1,
    TILE_TYPES.DESERT_SEMI_ARID_2,
    TILE_TYPES.DESERT_SEMI_ARID_3,
    TILE_TYPES.DESERT_SEMI_ARID_4,
];

const ALL_GRASS_TILES = [
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
    TILE_TYPES.GRASS_MEADOW_1,
    TILE_TYPES.GRASS_MEADOW_2,
    TILE_TYPES.GRASS_MEADOW_3,
    TILE_TYPES.GRASS_MEADOW_4,
    TILE_TYPES.GRASS_FLOWER_FIELD_1,
    TILE_TYPES.GRASS_FLOWER_FIELD_2,
    TILE_TYPES.GRASS_FLOWER_FIELD_3,
    TILE_TYPES.GRASS_FLOWER_FIELD_4,
];

const FOREST_TILES = [
    TILE_TYPES.FOREST_DENSE_SINGLE_1,
    TILE_TYPES.FOREST_SPARSE_SINGLE_1,
    TILE_TYPES.FOREST_DENSE_MIXED_1,
    TILE_TYPES.FOREST_SPARSE_MIXED_1,
    TILE_TYPES.FOREST_RAINFOREST_1,
    TILE_TYPES.FOREST_JUNGLE_1,
];

// Category IDs
export const CAT_TREES = 0;
export const CAT_GROUND_COVER = 1;
export const CAT_PLANTS = 2;
// TOTAL_BANDS / NUM_CATEGORIES — no longer authoritative. Band count is now
//   ArchetypeRegistry.totalBands (7 archetypes × 5 LODs = 35). AssetInstancePool
//   takes bandDescriptors; shaders receive totalBands via config. These exports
//   stay only to avoid breaking unknown importers; AssetStreamer no longer reads
//   them. The value 15 is WRONG for the new layout — don't rely on it.
//
// CAT_GROUND_COVER / CAT_PLANTS — replaced by archetype indices (grass moved
//   from CAT_PLANTS=2 to grass_tuft archetype=1).
//
// CAT_TREES and LODS_PER_CATEGORY remain LIVE: TreeDetailSystem._buildSourceBands
//   computes `CAT_TREES * LODS_PER_CATEGORY = 0 * 5 = 0` and that file is frozen.
//   tree_standard is archetype 0 with lodCount 5 → bands 0-4. Hard invariant.

// LOD configuration
export const TREE_LOD_DISTANCES = [20, 100, 150, 380, 500];
export const TREE_DENSITIES = [0.0072, 0.0024, 0.00072, 0.00036, 0.00018];

// Tree scatter controls
export const TREE_CELL_SIZE = 16.0;
export const TREE_MAX_PER_CELL = 4;
export const TREE_CLUSTER_PROBABILITY = 0.95;
export const TREE_JITTER_SCALE = 0.85;
export const TREE_DENSITY_SCALE = 1.0;

// Bounded non-tree scatter groups. These stay stable as content grows,
// while membership is derived from actual variant densities at init time.
export const SCATTER_DENSITY_GROUPS = [
    { name: 'dense', minDensity: 0.5 },
    { name: 'medium', minDensity: 0.05 },
    { name: 'sparse', minDensity: 0.0 },
];

// Dedicated runtime scatter groups whose visibility is governed by the
// bake policy instead of pure density grouping. This keeps the expensive
// archetypes isolated so coarse-tile downgrades can suppress them without
// disturbing unrelated runtime groups.
export const SCATTER_POLICY_GROUPS = [
    {
        name: 'rocks-runtime',
        archetypeName: 'rock_small',
        runtimeHoldDistance: 140.0,
        runtimeHoldScale: 1.0,
        maxScatterTileWorldSize: 32,
        scatterCellOversample: 1,
    },
];

// Experimental split non-tree scatter path. Keep this easy to toggle while
// evaluating mixed-content worlds and future content sets.
export const ENABLE_SCATTER_DENSITY_GROUPS = true;
export const ENABLE_SCATTER_ELIGIBILITY_GATE = true;

export const TREE_INSTANCE_MULTIPLIER = 3;

const TREE_INSTANCE_BASE = {
    low: [50000, 40000, 30000, 20000, 20000],
    medium: [100000, 80000, 60000, 60000, 40000],
    high: [240000, 180000, 120000, 90000, 60000],
};

const scaleInstances = (arr, mul) => arr.map((v) => Math.round(v * mul));
export const TREE_BILLBOARD_LOD_START = 3;
export const TREE_BILLBOARD_LOD_END = 4;

export const GROUND_COVER_LOD_DISTANCES = [25, 65, 130, 220, 320];
export const GROUND_COVER_DENSITIES = [0.03, 0.012, 0.003, 0.0, 0.0];

export const PLANT_LOD_DISTANCES = [20, 45, 75, 140, 220];
export const PLANT_DENSITIES = [0.45, 0.20, 0.08, 0.025, 0.008];

// Tree-specific visibility and fade tuning
export const TREE_VISIBILITY = TREE_LOD_DISTANCES[TREE_LOD_DISTANCES.length - 1];
export const TREE_FADE_START_RATIO = 0.7;
export const TREE_FADE_END_RATIO = 1.0;

export const ASSET_DEF_HEADER_FLOATS = 18;
export const ASSET_DEF_TRAILER_FLOATS = 20;
export const ASSET_DEF_FLOATS =
    ASSET_DEF_HEADER_FLOATS + LODS_PER_CATEGORY * 2 + ASSET_DEF_TRAILER_FLOATS; 

export const DEFAULT_CATEGORIES = [
    // CAT_TREES (0)
    {
        id: CAT_TREES,
        name: 'trees',
        tileTypes: [
            ...FOREST_TILES,
            ...DESERT_TREE_TILES
        ],
        lodDistances: TREE_LOD_DISTANCES,
        densities: TREE_DENSITIES,
        sizeRange: { width: [7.0, 12.5], height: [20.0, 50.0] },
        baseColor: [0.25, 0.18, 0.08],
        tipColor: [0.15, 0.45, 0.12],
    },
    // CAT_GROUND_COVER (1) — small rocks, roots, stones
    {
        id: CAT_GROUND_COVER,
        name: 'groundCover',
        tileTypes: [TILE_TYPES.ROCK_OUTCROP_1, TILE_TYPES.ROCK_SLAB_1, TILE_TYPES.ROCK_BOULDER_1],
        lodDistances: GROUND_COVER_LOD_DISTANCES,
        densities: GROUND_COVER_DENSITIES,
        sizeRange: { width: [0.25, 0.9], height: [0.15, 0.6] },
        baseColor: [0.45, 0.42, 0.38],
        tipColor: [0.55, 0.52, 0.48],
    },
    // CAT_PLANTS (2) — grass tufts, ferns, flowers
    {
        id: CAT_PLANTS,
        name: 'plants',
        tileTypes: [
            ...ALL_GRASS_TILES,
            ...FOREST_TILES,
            ...DESERT_TILES,
            ...DESERT_TREE_TILES
        ],
        lodDistances: PLANT_LOD_DISTANCES,
        densities: PLANT_DENSITIES,
        sizeRange: { width: [0.3, 0.9], height: [0.3, 2.4] },
        baseColor: [0.08, 0.15, 0.05],
        tipColor: [0.2, 0.55, 0.12],
    },
];


export const QUALITY_PRESETS = {
    low: {
        maxInstances: [
            scaleInstances(TREE_INSTANCE_BASE.low, TREE_INSTANCE_MULTIPLIER),  // [0] tree_standard
            [40000, 30000, 20000, 15000, 10000],                                // [1] grass_tuft
            [4000, 3000, 2000, 1000, 500],                                      // [2] rock_small
            [8000, 5000, 3000, 2000, 1000],                                     // [3] fern
            [1500, 1000, 700, 400, 200],                                        // [4] mushroom_capped
            [300, 200, 150, 100, 50],                                           // [5] fallen_log
            [500, 400, 300, 200, 100],                                          // [6] tree_stump
        ],
        maxScatterTileWorldSize: 32,
        scatterCellOversample: 1,
        scatterInterval: 2,
        scatterMinMove: 1.0,
        scatterWorkgroupSize: 64,
    },
    medium: {
        maxInstances: [
            scaleInstances(TREE_INSTANCE_BASE.medium, TREE_INSTANCE_MULTIPLIER),
            [60000, 45000, 30000, 20000, 15000],
            [6000, 4500, 3000, 1500, 800],                                      // [2] rock_small
            [12000, 8000, 5000, 3000, 1500],                                    // [3] fern
            [2500, 1800, 1200, 700, 400],                                       // [4] mushroom_capped
            [400, 300, 200, 150, 80],                                           // [5] fallen_log
            [800, 600, 400, 300, 150],                                          // [6] tree_stump
        ],
        maxScatterTileWorldSize: 48,
        scatterCellOversample: 2,
        scatterInterval: 2,
        scatterMinMove: 1.0,
        scatterWorkgroupSize: 64,
    },
    high: {
        maxInstances: [
            scaleInstances(TREE_INSTANCE_BASE.high, TREE_INSTANCE_MULTIPLIER),
            [100000, 70000, 45000, 30000, 20000],
            [10000, 7000, 4500, 2500, 1200],                                    // [2] rock_small
            [18000, 12000, 8000, 5000, 2500],                                   // [3] fern
            [4000, 2800, 1800, 1000, 500],                                      // [4] mushroom_capped
            [600, 450, 300, 200, 100],                                          // [5] fallen_log
            [1200, 900, 600, 400, 200],                                         // [6] tree_stump
        ],
        maxScatterTileWorldSize: 64,
        scatterCellOversample: 2,
        scatterInterval: 2,
        scatterMinMove: 1.0,
        scatterWorkgroupSize: 128,
    },
};


export const TERRAIN_AO_CONFIG = {
    enabled: true,
    resolution: 64,
    // 24 instead of 8: AO bakes cascade (each new tile re-bakes up to 8
    // neighbors), so a burst of 20 forest tiles queues ~180 AO bakes.
    // At 8/frame that stalls for 22+ frames; 24/frame brings it to ~7.
    maxBakesPerFrame: 24,
    logDispatches: false,
    aoFloor: 0.30,
    // Lower bound for AO-applied ambient in terrain shading.
    // Helps prevent terrain from going near-black at night while
    // foliage remains readable from its own shading path.
    ambientFloor: 0.65,

    // ── Split strength: ambient vs direct ───────────────────────────────
    // Ambient gets full AO. Direct gets partial AO — this represents
    // canopy scatter/attenuation on the direct beam, which shadow maps
    // can't model because it's sub-texel-frequency occlusion. Without
    // this, AO is invisible under bright sun regardless of how dark the
    // mask is, because ambient is a tiny fraction of total light.
    //
  
    ambientStrength: 1.9,
    directStrength:  1.5,

    // Old single-knob field kept for backward compat with the
    // terrainAOStrength uniform slot; now only used as a master dial
    // that scales both. Leave at 1.0 unless you want to fade the
    // entire effect globally.
    sampleStrength: 1.0,

    tree: {
        radiusMeters:     7.5,
        strength:         0.55,
        innerRatio:       0.18,
        cellSearchRadius: 1,
    },

    groundCover: {
        enable:           true,
        radiusMeters:     1.4,
        strength:         0.14,
        keepProbability:  0.30,
        cellSearchRadius: 2,
    },
};

export const GROUND_FIELD_BAKE_CONFIG = {
    enabled: false,
    resolution: 32,
    maxBakesPerFrame: 16,
    logDispatches: false,
    runtimeScatterOversample: 1,
    channels: [
        {
            name: 'grass',
            familyName: 'grassland_common',
            archetypeName: 'grass_tuft',
            runtimeHoldScale: 2.0,
            scatterDensityScale: 4.0,
        },
        {
            name: 'fern',
            familyName: 'forest_floor_fern',
            archetypeName: 'fern',
            runtimeHoldScale: 2.0,
            scatterDensityScale: 2.5,
        },
    ],
    terrainFallback: {
        enabled: true,
        tintStrength: 0.32,
        grassTint: [0.22, 0.33, 0.12],
        fernTint: [0.10, 0.24, 0.07],
    },
};

export const GROUND_PROP_BAKE_CONFIG = {
    enabled: true,
    perLayerCapacity: 1024,
    maxBakesPerFrame: 16,
    maxScatterTileWorldSize: 32,
    scatterCellOversample: 2,
    logDispatches: false,
};

export const TREE_SOURCE_BAKE_CONFIG = {
    enabled: true,
    perLayerCapacity: 1024,
    maxBakesPerFrame: 16,
    logDispatches: false,
};

export const ASSET_SELF_OCCLUSION = {
    enabled: true,

    // Master strength multiplier applied to all assets. Scales both
    // ambient and direct contributions. Set to 0 to disable globally.
    masterStrength: 1.0,

    // How much self-occlusion darkens ambient light (0 = none, 1 = full).
    ambientStrength: 0.9,

    // How much self-occlusion darkens direct (sun) light.
    // Typically lower than ambient — direct light punches through thin
    // geometry more than ambient does.
    directStrength: 0.6,

    // Per-asset-category overrides. Each category can specify:
    //   gradientWidth:    normalized [0,1] — how far up the mesh the
    //                     darkening extends (in UV-Y space)
    //   strengthMul:      multiplier on masterStrength for this category
    //   terrainEmbedding: how far below ground the mesh bottom sits,
    //                     in normalized UV-Y. The gradient origin is
    //                     shifted up by this amount so darkening starts
    //                     at the terrain surface, not at the buried base.
    //   darkening:        maximum darkening factor at the very base
    //                     (0 = no darkening, 1 = fully black)

    // Trees: moderate gradient, some trunk is below ground
    tree: {
        gradientWidth: 0.12,
        strengthMul: 0.8,
        terrainEmbedding: 0.02,
        darkening: 0.35,
    },

    // Ground cover (rocks): rocks often intersect terrain significantly.
    // Wide gradient because the occlusion wraps around the buried portion.
    groundCover: {
        gradientWidth: 0.25,
        strengthMul: 1.0,
        terrainEmbedding: 0.15,
        darkening: 0.45,
    },

    // Short grasses: narrow, subtle darkening
    grass_short: {
        gradientWidth: 0.4,
        strengthMul: 20.6,
        terrainEmbedding: 0.01,
        darkening: 0.95,
    },

    // Medium grasses
    grass_medium: {
        gradientWidth: 0.4,
        strengthMul: 20.7,
        terrainEmbedding: 0.01,
        darkening: 0.90,
    },

    // Tall grasses: wider gradient, more self-occlusion from dense blades
    grass_tall: {
        gradientWidth: 0.48,
        strengthMul: 30.9,
        terrainEmbedding: 0.02,
        darkening: 0.90,
    },

    // Dry grasses: sparse, less occlusion
    grass_dry: {
        gradientWidth: 0.46,
        strengthMul: 20.5,
        terrainEmbedding: 0.01,
        darkening: 0.9,
    },

    // Default fallback for any unspecified asset
    default: {
        gradientWidth: 0.10,
        strengthMul: 0.7,
        terrainEmbedding: 0.02,
        darkening: 0.30,
    },
};
