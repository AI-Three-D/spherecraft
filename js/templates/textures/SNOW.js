import { TILE_TYPES } from '../../shared/types.js';
import { TEXTURE_LEVELS } from '../configs/TileConfig.js';
import { sameForAllSeasons, withSeed } from './reusable/shared.js';
import { SNOW_MICRO_A, SNOW_MICRO_B, SNOW_MACRO } from './reusable/snowTextures.js';

function makeSnow(id, name, seedOffset) {
  return {
    id,
    name,
    textures: {
      base: sameForAllSeasons({
        [TEXTURE_LEVELS.MICRO]: [
          withSeed(SNOW_MICRO_A, seedOffset),
          withSeed(SNOW_MICRO_B, seedOffset),
        ],
        [TEXTURE_LEVELS.MACRO]: [SNOW_MACRO],
      }),
    },
  };
}

export const SNOW_TILES = [
  makeSnow(TILE_TYPES.SNOW_FRESH_1, 'SNOW_FRESH_1', 10),
  makeSnow(TILE_TYPES.SNOW_FRESH_2, 'SNOW_FRESH_2', 20),
  makeSnow(TILE_TYPES.SNOW_FRESH_3, 'SNOW_FRESH_3', 30),
  makeSnow(TILE_TYPES.SNOW_FRESH_4, 'SNOW_FRESH_4', 40),

  makeSnow(TILE_TYPES.SNOW_PACK_1, 'SNOW_PACK_1', 110),
  makeSnow(TILE_TYPES.SNOW_PACK_2, 'SNOW_PACK_2', 120),
  makeSnow(TILE_TYPES.SNOW_PACK_3, 'SNOW_PACK_3', 130),
  makeSnow(TILE_TYPES.SNOW_PACK_4, 'SNOW_PACK_4', 140),

  makeSnow(TILE_TYPES.SNOW_ICE_1, 'SNOW_ICE_1', 210),
  makeSnow(TILE_TYPES.SNOW_ICE_2, 'SNOW_ICE_2', 220),
  makeSnow(TILE_TYPES.SNOW_ICE_3, 'SNOW_ICE_3', 230),
  makeSnow(TILE_TYPES.SNOW_ICE_4, 'SNOW_ICE_4', 240),
];

export default SNOW_TILES;
