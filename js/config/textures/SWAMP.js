import { TILE_TYPES } from '../../types.js';
import { TEXTURE_LEVELS } from '../TileConfig.js';
import { sameForAllSeasons, withSeed } from './reusable/shared.js';
import { SWAMP_MICRO_A, SWAMP_MICRO_B, SWAMP_MACRO } from './reusable/swampTextures.js';

function makeSwamp(id, name, seedOffset) {
  return {
    id,
    name,
    textures: {
      base: sameForAllSeasons({
        [TEXTURE_LEVELS.MICRO]: [
          withSeed(SWAMP_MICRO_A, seedOffset),
          withSeed(SWAMP_MICRO_B, seedOffset),
        ],
        [TEXTURE_LEVELS.MACRO]: [SWAMP_MACRO],
      }),
    },
  };
}

export const SWAMP_TILES = [
  makeSwamp(TILE_TYPES.SWAMP_MARSH_1, 'SWAMP_MARSH_1', 10),
  makeSwamp(TILE_TYPES.SWAMP_MARSH_2, 'SWAMP_MARSH_2', 20),
  makeSwamp(TILE_TYPES.SWAMP_MARSH_3, 'SWAMP_MARSH_3', 30),
  makeSwamp(TILE_TYPES.SWAMP_MARSH_4, 'SWAMP_MARSH_4', 40),

  makeSwamp(TILE_TYPES.SWAMP_BOG_1, 'SWAMP_BOG_1', 110),
  makeSwamp(TILE_TYPES.SWAMP_BOG_2, 'SWAMP_BOG_2', 120),
  makeSwamp(TILE_TYPES.SWAMP_BOG_3, 'SWAMP_BOG_3', 130),
  makeSwamp(TILE_TYPES.SWAMP_BOG_4, 'SWAMP_BOG_4', 140),

  makeSwamp(TILE_TYPES.SWAMP_MANGROVE_1, 'SWAMP_MANGROVE_1', 210),
  makeSwamp(TILE_TYPES.SWAMP_MANGROVE_2, 'SWAMP_MANGROVE_2', 220),
  makeSwamp(TILE_TYPES.SWAMP_MANGROVE_3, 'SWAMP_MANGROVE_3', 230),
  makeSwamp(TILE_TYPES.SWAMP_MANGROVE_4, 'SWAMP_MANGROVE_4', 240),
];

export default SWAMP_TILES;
