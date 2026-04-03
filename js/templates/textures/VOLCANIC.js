import { TILE_TYPES } from '../../shared/types.js';
import { TEXTURE_LEVELS } from '../configs/TileConfig.js';
import { sameForAllSeasons, withSeed } from './reusable/shared.js';
import { VOLCANIC_MICRO_A, VOLCANIC_MICRO_B, VOLCANIC_MACRO } from './reusable/volcanicTextures.js';

function makeVolcanic(id, name, seedOffset) {
  return {
    id,
    name,
    textures: {
      base: sameForAllSeasons({
        [TEXTURE_LEVELS.MICRO]: [
          withSeed(VOLCANIC_MICRO_A, seedOffset),
          withSeed(VOLCANIC_MICRO_B, seedOffset),
        ],
        [TEXTURE_LEVELS.MACRO]: [VOLCANIC_MACRO],
      }),
    },
  };
}

export const VOLCANIC_TILES = [
  makeVolcanic(TILE_TYPES.VOLCANIC_BASALT_1, 'VOLCANIC_BASALT_1', 10),
  makeVolcanic(TILE_TYPES.VOLCANIC_BASALT_2, 'VOLCANIC_BASALT_2', 20),
  makeVolcanic(TILE_TYPES.VOLCANIC_BASALT_3, 'VOLCANIC_BASALT_3', 30),
  makeVolcanic(TILE_TYPES.VOLCANIC_BASALT_4, 'VOLCANIC_BASALT_4', 40),

  makeVolcanic(TILE_TYPES.VOLCANIC_ASH_1, 'VOLCANIC_ASH_1', 110),
  makeVolcanic(TILE_TYPES.VOLCANIC_ASH_2, 'VOLCANIC_ASH_2', 120),
  makeVolcanic(TILE_TYPES.VOLCANIC_ASH_3, 'VOLCANIC_ASH_3', 130),
  makeVolcanic(TILE_TYPES.VOLCANIC_ASH_4, 'VOLCANIC_ASH_4', 140),

  makeVolcanic(TILE_TYPES.VOLCANIC_OBSIDIAN_1, 'VOLCANIC_OBSIDIAN_1', 210),
  makeVolcanic(TILE_TYPES.VOLCANIC_OBSIDIAN_2, 'VOLCANIC_OBSIDIAN_2', 220),
  makeVolcanic(TILE_TYPES.VOLCANIC_OBSIDIAN_3, 'VOLCANIC_OBSIDIAN_3', 230),
  makeVolcanic(TILE_TYPES.VOLCANIC_OBSIDIAN_4, 'VOLCANIC_OBSIDIAN_4', 240),
];

export default VOLCANIC_TILES;
