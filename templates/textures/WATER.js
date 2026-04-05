import { TILE_TYPES } from '../configs/tileTypes.js';
import { TEXTURE_LEVELS } from '../configs/TileConfig.js';
import { sameForAllSeasons, withSeed } from './reusable/shared.js';
import { WATER_MICRO_A, WATER_MACRO } from './reusable/waterTextures.js';

export const WATER_TILES = [
  {
    id: TILE_TYPES.WATER_1,
    name: 'WATER_1',
    textures: {
      base: sameForAllSeasons({
        [TEXTURE_LEVELS.MICRO]: [withSeed(WATER_MICRO_A, 0)],
        [TEXTURE_LEVELS.MACRO]: [WATER_MACRO],
      }),
    },
  },
  {
    id: TILE_TYPES.WATER_2,
    name: 'WATER_2',
    textures: {
      base: sameForAllSeasons({
        [TEXTURE_LEVELS.MICRO]: [withSeed(WATER_MICRO_A, 10)],
        [TEXTURE_LEVELS.MACRO]: [WATER_MACRO],
      }),
    },
  },
  {
    id: TILE_TYPES.WATER_3,
    name: 'WATER_3',
    textures: {
      base: sameForAllSeasons({
        [TEXTURE_LEVELS.MICRO]: [withSeed(WATER_MICRO_A, 20)],
        [TEXTURE_LEVELS.MACRO]: [WATER_MACRO],
      }),
    },
  },
  {
    id: TILE_TYPES.WATER_4,
    name: 'WATER_4',
    textures: {
      base: sameForAllSeasons({
        [TEXTURE_LEVELS.MICRO]: [withSeed(WATER_MICRO_A, 30)],
        [TEXTURE_LEVELS.MACRO]: [WATER_MACRO],
      }),
    },
  },
];

export default WATER_TILES;
