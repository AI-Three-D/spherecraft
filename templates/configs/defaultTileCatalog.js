const DEFAULT_TILE_GROUPS = Object.freeze([
    { category: 'WATER', start: 0, names: ['WATER_1', 'WATER_2', 'WATER_3', 'WATER_4'] },

    { category: 'GRASS', start: 10, names: ['GRASS_SHORT_1', 'GRASS_SHORT_2', 'GRASS_SHORT_3', 'GRASS_SHORT_4'] },
    { category: 'GRASS', start: 14, names: ['GRASS_MEDIUM_1', 'GRASS_MEDIUM_2', 'GRASS_MEDIUM_3', 'GRASS_MEDIUM_4'] },
    { category: 'GRASS', start: 18, names: ['GRASS_TALL_1', 'GRASS_TALL_2', 'GRASS_TALL_3', 'GRASS_TALL_4'] },
    { category: 'GRASS', start: 22, names: ['GRASS_MEADOW_1', 'GRASS_MEADOW_2', 'GRASS_MEADOW_3', 'GRASS_MEADOW_4'] },
    { category: 'GRASS', start: 26, names: ['GRASS_FLOWER_FIELD_1', 'GRASS_FLOWER_FIELD_2', 'GRASS_FLOWER_FIELD_3', 'GRASS_FLOWER_FIELD_4'] },

    { category: 'SAND', start: 30, names: ['SAND_COARSE_1', 'SAND_COARSE_2', 'SAND_COARSE_3', 'SAND_COARSE_4'] },
    { category: 'SAND', start: 34, names: ['SAND_MEDIUM_1', 'SAND_MEDIUM_2', 'SAND_MEDIUM_3', 'SAND_MEDIUM_4'] },
    { category: 'SAND', start: 38, names: ['SAND_FINE_1', 'SAND_FINE_2', 'SAND_FINE_3', 'SAND_FINE_4'] },

    { category: 'ROCK', start: 42, names: ['ROCK_OUTCROP_1', 'ROCK_OUTCROP_2', 'ROCK_OUTCROP_3', 'ROCK_OUTCROP_4'] },
    { category: 'ROCK', start: 46, names: ['ROCK_SLAB_1', 'ROCK_SLAB_2', 'ROCK_SLAB_3', 'ROCK_SLAB_4'] },
    { category: 'ROCK', start: 50, names: ['ROCK_BOULDER_1', 'ROCK_BOULDER_2', 'ROCK_BOULDER_3', 'ROCK_BOULDER_4'] },

    { category: 'TUNDRA', start: 54, names: ['TUNDRA_BARREN_1', 'TUNDRA_BARREN_2', 'TUNDRA_BARREN_3', 'TUNDRA_BARREN_4'] },
    { category: 'TUNDRA', start: 58, names: ['TUNDRA_LICHEN_1', 'TUNDRA_LICHEN_2', 'TUNDRA_LICHEN_3', 'TUNDRA_LICHEN_4'] },
    { category: 'TUNDRA', start: 62, names: ['TUNDRA_MOSS_1', 'TUNDRA_MOSS_2', 'TUNDRA_MOSS_3', 'TUNDRA_MOSS_4'] },

    { category: 'FOREST', start: 66, names: ['FOREST_DENSE_SINGLE_1', 'FOREST_DENSE_SINGLE_2', 'FOREST_DENSE_SINGLE_3', 'FOREST_DENSE_SINGLE_4'] },
    { category: 'FOREST', start: 70, names: ['FOREST_SPARSE_SINGLE_1', 'FOREST_SPARSE_SINGLE_2', 'FOREST_SPARSE_SINGLE_3', 'FOREST_SPARSE_SINGLE_4'] },
    { category: 'FOREST', start: 74, names: ['FOREST_DENSE_MIXED_1', 'FOREST_DENSE_MIXED_2', 'FOREST_DENSE_MIXED_3', 'FOREST_DENSE_MIXED_4'] },
    { category: 'FOREST', start: 78, names: ['FOREST_SPARSE_MIXED_1', 'FOREST_SPARSE_MIXED_2', 'FOREST_SPARSE_MIXED_3', 'FOREST_SPARSE_MIXED_4'] },

    { category: 'SWAMP', start: 82, names: ['SWAMP_MARSH_1', 'SWAMP_MARSH_2', 'SWAMP_MARSH_3', 'SWAMP_MARSH_4'] },
    { category: 'SWAMP', start: 86, names: ['SWAMP_BOG_1', 'SWAMP_BOG_2', 'SWAMP_BOG_3', 'SWAMP_BOG_4'] },
    { category: 'SWAMP', start: 90, names: ['SWAMP_MANGROVE_1', 'SWAMP_MANGROVE_2', 'SWAMP_MANGROVE_3', 'SWAMP_MANGROVE_4'] },

    { category: 'DIRT', start: 94, names: ['DIRT_DRY_1', 'DIRT_DRY_2', 'DIRT_DRY_3', 'DIRT_DRY_4'] },
    { category: 'DIRT', start: 98, names: ['DIRT_LOAM_1', 'DIRT_LOAM_2', 'DIRT_LOAM_3', 'DIRT_LOAM_4'] },
    { category: 'DIRT', start: 102, names: ['DIRT_CLAY_1', 'DIRT_CLAY_2', 'DIRT_CLAY_3', 'DIRT_CLAY_4'] },

    { category: 'MUD', start: 106, names: ['MUD_WET_1', 'MUD_WET_2', 'MUD_WET_3', 'MUD_WET_4'] },
    { category: 'MUD', start: 110, names: ['MUD_SILT_1', 'MUD_SILT_2', 'MUD_SILT_3', 'MUD_SILT_4'] },
    { category: 'MUD', start: 114, names: ['MUD_PEAT_1', 'MUD_PEAT_2', 'MUD_PEAT_3', 'MUD_PEAT_4'] },

    { category: 'VOLCANIC', start: 118, names: ['VOLCANIC_BASALT_1', 'VOLCANIC_BASALT_2', 'VOLCANIC_BASALT_3', 'VOLCANIC_BASALT_4'] },
    { category: 'VOLCANIC', start: 122, names: ['VOLCANIC_ASH_1', 'VOLCANIC_ASH_2', 'VOLCANIC_ASH_3', 'VOLCANIC_ASH_4'] },
    { category: 'VOLCANIC', start: 126, names: ['VOLCANIC_OBSIDIAN_1', 'VOLCANIC_OBSIDIAN_2', 'VOLCANIC_OBSIDIAN_3', 'VOLCANIC_OBSIDIAN_4'] },

    { category: 'SNOW', start: 130, names: ['SNOW_FRESH_1', 'SNOW_FRESH_2', 'SNOW_FRESH_3', 'SNOW_FRESH_4'] },
    { category: 'SNOW', start: 134, names: ['SNOW_PACK_1', 'SNOW_PACK_2', 'SNOW_PACK_3', 'SNOW_PACK_4'] },
    { category: 'SNOW', start: 138, names: ['SNOW_ICE_1', 'SNOW_ICE_2', 'SNOW_ICE_3', 'SNOW_ICE_4'] },

    { category: 'FOREST', start: 142, names: ['FOREST_RAINFOREST_1', 'FOREST_RAINFOREST_2', 'FOREST_RAINFOREST_3', 'FOREST_RAINFOREST_4'] },
    { category: 'FOREST', start: 146, names: ['FOREST_JUNGLE_1', 'FOREST_JUNGLE_2', 'FOREST_JUNGLE_3', 'FOREST_JUNGLE_4'] },

    { category: 'DESERT', start: 150, names: ['DESERT_DRY_1', 'DESERT_DRY_2', 'DESERT_DRY_3', 'DESERT_DRY_4'] },
    { category: 'DESERT', start: 154, names: ['DESERT_SEMI_ARID_1', 'DESERT_SEMI_ARID_2', 'DESERT_SEMI_ARID_3', 'DESERT_SEMI_ARID_4'] },
    { category: 'DESERT', start: 158, names: ['DESERT_TREES_DRY_1', 'DESERT_TREES_DRY_2', 'DESERT_TREES_DRY_3', 'DESERT_TREES_DRY_4'] },
    { category: 'DESERT', start: 162, names: ['DESERT_TREES_SEMI_ARID_1', 'DESERT_TREES_SEMI_ARID_2', 'DESERT_TREES_SEMI_ARID_3', 'DESERT_TREES_SEMI_ARID_4'] },
]);

const DEFAULT_TILE_CATEGORY_RANGES = Object.freeze([
    { name: 'WATER', ranges: [[0, 3]] },
    { name: 'GRASS', ranges: [[10, 29]] },
    { name: 'SAND', ranges: [[30, 41]] },
    { name: 'ROCK', ranges: [[42, 53]] },
    { name: 'TUNDRA', ranges: [[54, 65]] },
    { name: 'FOREST', ranges: [[66, 81], [142, 149]] },
    { name: 'SWAMP', ranges: [[82, 93]] },
    { name: 'DIRT', ranges: [[94, 105]] },
    { name: 'MUD', ranges: [[106, 117]] },
    { name: 'VOLCANIC', ranges: [[118, 129]] },
    { name: 'SNOW', ranges: [[130, 141]] },
    { name: 'DESERT', ranges: [[150, 165]] },
]);

function buildDefaultTileCatalog() {
    const tiles = [];
    for (const group of DEFAULT_TILE_GROUPS) {
        for (let offset = 0; offset < group.names.length; offset++) {
            tiles.push({
                name: group.names[offset],
                id: group.start + offset,
                category: group.category,
            });
        }
    }

    return {
        tiles,
        categories: DEFAULT_TILE_CATEGORY_RANGES.map((category) => ({
            name: category.name,
            ranges: category.ranges.map((range) => range.slice()),
        })),
    };
}

export const DEFAULT_TILE_CATALOG = Object.freeze(buildDefaultTileCatalog());
