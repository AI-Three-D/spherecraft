// js/renderer/streamer/archetype/archetypeDefinitions.js
//
// Data for the archetype / family / variant model. Consumed once by
// ArchetypeRegistry at AssetStreamer construction.
//
// ═══ INCREMENT-3 UPDATE ════════════════════════════════════════════════
//
//   New variants now have full placement data: tileTypes, baseColor,
//   tipColor. They appear in buildTileAssetMap() and can be selected
//   by the scatter shader.
//
// ═══ INDEX STABILITY ═══════════════════════════════════════════════════
//
//   Archetype and family indices go straight into GPU buffers (variant
//   record floats [28] and [30]) and the density LUT. APPEND ONLY.

import { CollisionClass, makeBlockMask } from './CollisionClasses.js';
import { TILE_TYPES } from '../../../../shared/types.js';
import {
    FOREST_TILES,
} from '../streamerConfig.js';
import { GRASS_TILES, DESERT_TILES, DESERT_TREE_TILES } from '../AssetDefinitions.js';

// ═══════════════════════════════════════════════════════════════════════
// ARCHETYPES
// ═══════════════════════════════════════════════════════════════════════
//
// Index 0 MUST be tree_standard — see RenderArchetype.js header.

const ARCHETYPES = [
    {
        name:  'tree_standard',
        index: 0,
        pipelineKey:     'externalPipeline',
        geometryBuilder: 'tree',
        lodCount:        5,
        maxInstances:    1,
        hasBillboard:    true,
        shadowLodThreshold: 2,
    },
    {
        name:  'grass_tuft',
        index: 1,
        pipelineKey:     'tint_blade_cutout',
        geometryBuilder: 'grass',
        lodCount:        5,
        maxInstances:    1,
        hasWind:         true,
        hasFarDim:       true,
        shadowLodThreshold: 0,
    },
    {
        name: 'rock_small', index: 2,
        pipelineKey: 'albedo_static', geometryBuilder: 'rock',
        lodCount: 5, maxInstances: 1,  // Inc 3: enabled
        shadowLodThreshold: 2,
    },
    {
        name: 'fern', index: 3,
        pipelineKey: 'albedo_blade_cutout', geometryBuilder: 'fern',
        lodCount: 5, maxInstances: 1,  // Inc 3: enabled
        hasWind: true, hasFarDim: true,
        shadowLodThreshold: 2,
    },
    {
        name: 'mushroom_capped', index: 4,
        pipelineKey: 'albedo_static', geometryBuilder: 'mushroom',
        lodCount: 5, maxInstances: 1,  // Inc 3: enabled
        shadowLodThreshold: 1,
    },
    {
        name: 'fallen_log', index: 5,
        pipelineKey: 'albedo_static', geometryBuilder: 'log',
        lodCount: 5, maxInstances: 1,  // Inc 3: enabled
        shadowLodThreshold: 2,
    },
    {
        name: 'tree_stump', index: 6,
        pipelineKey: 'albedo_static', geometryBuilder: 'stump',
        lodCount: 5, maxInstances: 1,  // Inc 3: enabled
        shadowLodThreshold: 2,
    },
];

// ═══════════════════════════════════════════════════════════════════════
// PLACEMENT FAMILIES
// ═══════════════════════════════════════════════════════════════════════
//
// Family tileTypes are used when the variant doesn't specify its own.
// Inc 3: populated for new families.

const FAMILIES = [
    {
        name:  'forest_canopy',
        index: 0,
        archetype: 'tree_standard',
        tileTypes: [],   // migrated per-variant from legacy birch
    },
    {
        name:  'grassland_common',
        index: 1,
        archetype: 'grass_tuft',
        scatterGroup: 'dense',
        tileTypes: [],   // migrated per-variant from legacy grass_*
    },
    {
        name:  'forest_floor_fern',
        index: 2,
        archetype: 'fern',
        scatterGroup: 'medium',
        tileTypes: FOREST_TILES,
        climateRange: { temperature: [0.15, 0.85], precipitation: [0.25, 1.0] },
        slopeRange:   { min: 0.0, max: 0.7 },
    },
    {
        name:  'forest_floor_fungal',
        index: 3,
        archetype: 'mushroom_capped',
        scatterGroup: 'medium',
        tileTypes: FOREST_TILES,
        climateRange: { temperature: [0.15, 0.85], precipitation: [0.25, 1.0] },
        slopeRange:   { min: 0.0, max: 0.5 },
    },
    {
        name:  'universal_rocky',
        index: 4,
        archetype: 'rock_small',
        scatterGroup: 'dense',
        tileTypes: GRASS_TILES,
        perTileDensityScale: {
            [TILE_TYPES.GRASS_SHORT_1]: 2.2,
            [TILE_TYPES.GRASS_SHORT_2]: 1.8,
        },
        slopeRange: { min: 0.0, max: 1.0 },
    },
    {
        name:  'forest_deadwood_log',
        index: 5,
        archetype: 'fallen_log',
        scatterGroup: 'sparse',
        tileTypes: FOREST_TILES,
        climateRange: { temperature: [0.2, 0.8], precipitation: [0.3, 1.0] },
        slopeRange:   { min: 0.0, max: 0.35 },
    },
    {
        name:  'forest_deadwood_stump',
        index: 6,
        archetype: 'tree_stump',
        scatterGroup: 'sparse',
        tileTypes: FOREST_TILES,
        climateRange: { temperature: [0.2, 0.8], precipitation: [0.3, 1.0] },
        slopeRange:   { min: 0.0, max: 0.5 },
    },
];

// ═══════════════════════════════════════════════════════════════════════
// VARIANTS
// ═══════════════════════════════════════════════════════════════════════

const VARIANTS = [
    // ── OVERLAY: birch ──────────────────────────────────────────────────
    {
        name: 'birch',
        _overlayOnly: true,
        archetype: 'tree_standard',
        family:    'forest_canopy',

        collisionClass:   CollisionClass.TREE_TRUNK,
        blockedByClasses: makeBlockMask(CollisionClass.LANDMARK),
        footprintRadius:  0.6,
    },

    // ── OVERLAY: grass variants (live placement source of truth) ───────
    {
        name: 'grass_short',
        _overlayOnly: true,
        archetype: 'grass_tuft',
        family: 'grassland_common',
        tileTypes: [...GRASS_TILES, ...FOREST_TILES],
        lodDistances: [80, 170, 250, 330, 420],
        densities: [0.12, 0.10, 0.08, 0.012, 0.0020],
        climateRange: { temperature: [0.0, 1.0], precipitation: [0.08, 1.0] },
        elevationRange: [0.25, 0.80],
        slopeRange: [0.0, 0.75],
        sizeRange: { width: [0.3, 0.7], height: [0.3, 0.9] },
        baseColor: [0.18, 0.28, 0.08],
        tipColor: [0.35, 0.55, 0.15],
        priority: 1.0,
        selfOcclusion: {
            gradientWidth: 0.1, strengthMul: 1.0,
            terrainEmbedding: 0.01, darkening: 0.5,
        },
    },
    {
        name: 'grass_medium',
        _overlayOnly: true,
        archetype: 'grass_tuft',
        family: 'grassland_common',
        tileTypes: [...GRASS_TILES, ...FOREST_TILES],
        lodDistances: [80, 170, 250, 330, 420],
        densities: [0.08, 0.07, 0.05, 0.010, 0.0015],
        climateRange: { temperature: [0.05, 0.98], precipitation: [0.12, 1.0] },
        elevationRange: [0.25, 0.78],
        slopeRange: [0.0, 0.65],
        sizeRange: { width: [0.35, 0.8], height: [0.5, 1.4] },
        baseColor: [0.15, 0.25, 0.06],
        tipColor: [0.30, 0.50, 0.12],
        priority: 0.9,
        selfOcclusion: {
            gradientWidth: 0.2, strengthMul: 1.0,
            terrainEmbedding: 0.01, darkening: 0.6,
        },
    },
    {
        name: 'grass_tall',
        _overlayOnly: true,
        archetype: 'grass_tuft',
        family: 'grassland_common',
        tileTypes: [...GRASS_TILES],
        lodDistances: [80, 170, 250, 330, 420],
        densities: [0.04, 0.035, 0.025, 0.008, 0.0010],
        climateRange: { temperature: [0.08, 0.95], precipitation: [0.18, 1.0] },
        elevationRange: [0.25, 0.72],
        slopeRange: [0.0, 0.50],
        sizeRange: { width: [0.4, 0.9], height: [0.8, 2.2] },
        baseColor: [0.12, 0.22, 0.05],
        tipColor: [0.28, 0.48, 0.10],
        priority: 0.8,
        selfOcclusion: {
            gradientWidth: 0.3, strengthMul: 1.0,
            terrainEmbedding: 0.02, darkening: 0.75,
        },
    },
    {
        name: 'grass_dry',
        _overlayOnly: true,
        archetype: 'grass_tuft',
        family: 'grassland_common',
        tileTypes: [...GRASS_TILES, ...DESERT_TILES, ...DESERT_TREE_TILES],
        lodDistances: [80, 170, 250, 330, 420],
        densities: [0.05, 0.04, 0.03, 0.008, 0.0012],
        climateRange: { temperature: [0.15, 1.0], precipitation: [0.02, 0.65] },
        elevationRange: [0.25, 0.80],
        slopeRange: [0.0, 0.70],
        sizeRange: { width: [0.25, 0.6], height: [0.2, 0.7] },
        baseColor: [0.45, 0.38, 0.18],
        tipColor: [0.60, 0.52, 0.28],
        priority: 0.85,
        selfOcclusion: {
            gradientWidth: 0.36, strengthMul: 1.0,
            terrainEmbedding: 0.01, darkening: 0.9,
        },
    },

    // ── NEW: granite_small ──────────────────────────────────────────────
    {
        name:      'granite_small',
        archetype: 'rock_small',
        family:    'universal_rocky',

        sizeRange:    { width: [0.3, 2.9], height: [0.2, 1.2] },
        lodDistances: [15, 35, 70, 120, 180],
        densities:    [0.1, 0.10, 0.1, 0.05, 0.006],

        // Inc 3: colors for procedural shading
        baseColor: [0.48, 0.45, 0.40],   // gray rock
        tipColor:  [0.58, 0.55, 0.50],   // lighter highlights

        collisionClass:   CollisionClass.MEDIUM_PROP,
        blockedByClasses: makeBlockMask(
            CollisionClass.TREE_TRUNK,
            CollisionClass.LARGE_PROP,
            CollisionClass.LANDMARK,
        ),
        footprintRadius: 0.5,

        selfOcclusion: {
            gradientWidth: 0.15, strengthMul: 0.6,
            terrainEmbedding: 0.08, darkening: 0.25,
        },

        textureLayerAlbedo: -1,
        textureLayerNormal: -1,
        textureLayerDetail: -1,
        normalStrength: 1.35,
        detailStrength: 1.0,

        _legacyCategory:     'groundCover',
        _legacyGeometryType: 'rock',
    },

    // ── NEW: fern_bracken ───────────────────────────────────────────────
    {
        name:      'fern_bracken',
        archetype: 'fern',
        family:    'forest_floor_fern',

        sizeRange:    { width: [0.75, 1.45], height: [0.72, 1.42] },
        lodDistances: [12, 25, 45, 75, 110],
        densities:    [0.15, 0.15, 0.15, 0.15, 0.02],

        // Inc 3: green fern colors
        baseColor: [0.06, 0.20, 0.04],   // dark green stem base
        tipColor:  [0.15, 0.52, 0.10],   // bright green frond tips

        collisionClass:   CollisionClass.GROUND_CLUTTER,
        blockedByClasses: makeBlockMask(
            CollisionClass.TREE_TRUNK,
            CollisionClass.LARGE_PROP,
            CollisionClass.LANDMARK,
        ),
        footprintRadius: 0.3,

        selfOcclusion: {
            gradientWidth: 0.10, strengthMul: 0.7,
            terrainEmbedding: 0.02, darkening: 0.30,
        },

        textureLayerAlbedo: -1,

        _legacyCategory:     'plant',
        _legacyGeometryType: 'fern',
    },

    // ── NEW: amanita_muscaria ───────────────────────────────────────────
    {
        name:      'amanita_muscaria',
        archetype: 'mushroom_capped',
        family:    'forest_floor_fungal',

        sizeRange:    { width: [0.45, 0.95], height: [0.28, 0.56] },
        lodDistances: [5, 12, 22, 35, 50],
        densities:    [0.14, 0.11, 0.08, 0.025, 0.012],

        // Inc 3: cream stem → reddish cap
        baseColor: [0.75, 0.72, 0.65],   // cream/white stem
        tipColor:  [0.72, 0.18, 0.12],   // red cap (amanita!)

        collisionClass:   CollisionClass.GROUND_CLUTTER,
        blockedByClasses: makeBlockMask(
            CollisionClass.TREE_TRUNK,
            CollisionClass.MEDIUM_PROP,
            CollisionClass.LARGE_PROP,
            CollisionClass.LANDMARK,
        ),
        footprintRadius: 0.1,

        selfOcclusion: {
            gradientWidth: 0.08, strengthMul: 0.5,
            terrainEmbedding: 0.01, darkening: 0.20,
        },

        textureLayerAlbedo: -1,
        uvRegionSplit: 0.4,
        auxParam0:     0.4,

        _legacyCategory:     'plant',
        _legacyGeometryType: 'mushroom',
    },

    // ── NEW: birch_log_fresh ────────────────────────────────────────────
    {
        name:      'birch_log_fresh',
        archetype: 'fallen_log',
        family:    'forest_deadwood_log',

        sizeRange:    { width: [0.34, 0.52], height: [3.8, 5.6] },
        lodDistances: [20, 45, 85, 140, 200],
        densities:    [0.020, 0.015, 0.010, 0.0040, 0.0025],

        // Inc 3: birch bark → exposed wood
        baseColor: [0.82, 0.78, 0.72],   // birch bark (white-ish)
        tipColor:  [0.62, 0.52, 0.38],   // exposed heartwood (tan)

        collisionClass:   CollisionClass.LARGE_PROP,
        blockedByClasses: makeBlockMask(
            CollisionClass.TREE_TRUNK,
            CollisionClass.LARGE_PROP,
            CollisionClass.LANDMARK,
        ),
        footprintRadius: 2.0,

        selfOcclusion: {
            gradientWidth: 0.12, strengthMul: 0.65,
            terrainEmbedding: 0.05, darkening: 0.28,
        },

        textureLayerAlbedo:    -1,
        textureLayerSecondary: -1,
        uvRegionSplit: 0.8,
        auxParam0: 1,

        textureLayerOverlay: -1,
        overlayStrength: 0,

        _legacyCategory:     'groundCover',
        _legacyGeometryType: 'log',
    },

    // ── NEW: birch_log_mossy ────────────────────────────────────────────
    {
        name:      'birch_log_mossy',
        archetype: 'fallen_log',
        family:    'forest_deadwood_log',

        sizeRange:    { width: [0.28, 0.48], height: [2.4, 4.8] },
        lodDistances: [20, 45, 85, 140, 200],
        densities:    [0.015, 0.012, 0.008, 0.0035, 0.0020],

        // Inc 3: slightly greenish tint for moss
        baseColor: [0.72, 0.75, 0.68],   // mossy bark
        tipColor:  [0.55, 0.50, 0.42],   // weathered wood

        collisionClass:   CollisionClass.LARGE_PROP,
        blockedByClasses: makeBlockMask(
            CollisionClass.TREE_TRUNK,
            CollisionClass.LARGE_PROP,
            CollisionClass.LANDMARK,
        ),
        footprintRadius: 1.8,

        selfOcclusion: {
            gradientWidth: 0.12, strengthMul: 0.70,
            terrainEmbedding: 0.08, darkening: 0.32,
        },

        textureLayerAlbedo:    -1,
        textureLayerSecondary: -1,
        uvRegionSplit: 0.8,
        auxParam0: 1,

        textureLayerOverlay: -1,
        overlayStrength: 0.7,

        _legacyCategory:     'groundCover',
        _legacyGeometryType: 'log',
    },

    // ── NEW: birch_stump ────────────────────────────────────────────────
    {
        name:      'birch_stump',
        archetype: 'tree_stump',
        family:    'forest_deadwood_stump',

        sizeRange:    { width: [0.35, 0.65], height: [0.3, 0.7] },
        lodDistances: [18, 40, 75, 125, 180],
        densities:    [0.018, 0.014, 0.009, 0.0035, 0.0020],

        // Inc 3: birch bark → broken top
        baseColor: [0.80, 0.76, 0.70],   // birch bark
        tipColor:  [0.58, 0.48, 0.38],   // exposed rings

        collisionClass:   CollisionClass.LARGE_PROP,
        blockedByClasses: makeBlockMask(
            CollisionClass.TREE_TRUNK,
            CollisionClass.LARGE_PROP,
            CollisionClass.LANDMARK,
        ),
        footprintRadius: 0.5,

        selfOcclusion: {
            gradientWidth: 0.14, strengthMul: 0.68,
            terrainEmbedding: 0.04, darkening: 0.30,
        },

        textureLayerAlbedo:    -1,
        textureLayerSecondary: -1,
        uvRegionSplit: 0.8,
        auxParam0: 0,

        _legacyCategory:     'groundCover',
        _legacyGeometryType: 'stump',
    },
];

// ═══════════════════════════════════════════════════════════════════════
// LEGACY MIGRATION RULES
// ═══════════════════════════════════════════════════════════════════════

const LEGACY_MIGRATION = {
    categoryToArchetype: {
        tree:        'tree_standard',
        plant:       'grass_tuft',
        groundCover: 'rock_small',
    },
    categoryToFamily: {
        tree:        'forest_canopy',
        plant:       'grassland_common',
        groundCover: 'universal_rocky',
    },
};


export const TEXTURE_LAYER_MAPPING = Object.freeze({
    'granite_small':    {
        albedo: 'rock_granite',
        normal: 'rock_granite_normal',
        detail: 'rock_granite_detail',
    },
    'fern_bracken':     { albedo: 'fern_frond' },
    'amanita_muscaria': { albedo: 'mushroom_stem',
                          secondary: 'mushroom_cap_amanita' },
    'birch_log_fresh':  { albedo: 'bark_birch',
                          secondary: 'deadwood_endgrain' },
    'birch_log_mossy':  { albedo: 'bark_birch',
                          secondary: 'deadwood_endgrain',
                          overlay: 'moss_overlay' },
    'birch_stump':      { albedo: 'bark_birch',
                          secondary: 'deadwood_endgrain' },
});

export const ARCHETYPE_DEFINITIONS = Object.freeze({
    archetypes:      ARCHETYPES,
    families:        FAMILIES,
    variants:        VARIANTS,
    legacyMigration: LEGACY_MIGRATION,
});
