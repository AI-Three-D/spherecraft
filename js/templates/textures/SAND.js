import { TILE_TYPES } from '../../shared/types.js';
import { TEXTURE_LEVELS } from '../configs/TileConfig.js';
import { sameForAllSeasons, withSeed } from './reusable/shared.js';
import { SAND_MICRO_A, SAND_MACRO } from './reusable/sandTextures.js';

function makeSand(id, name, seedOffset) {
  return {
    id,
    name,
    textures: {
      base: sameForAllSeasons({
        [TEXTURE_LEVELS.MICRO]: [
          withSeed(SAND_MICRO_A, seedOffset),
      
        ],
        [TEXTURE_LEVELS.MACRO]: [SAND_MACRO],
      }),
    },
  };
}

export const SAND_TILES = [
  makeSand(TILE_TYPES.SAND_COARSE_1, 'SAND_COARSE_1', 10),
  makeSand(TILE_TYPES.SAND_COARSE_2, 'SAND_COARSE_2', 20),
  makeSand(TILE_TYPES.SAND_COARSE_3, 'SAND_COARSE_3', 30),
  makeSand(TILE_TYPES.SAND_COARSE_4, 'SAND_COARSE_4', 40),

  makeSand(TILE_TYPES.SAND_MEDIUM_1, 'SAND_MEDIUM_1', 110),
  makeSand(TILE_TYPES.SAND_MEDIUM_2, 'SAND_MEDIUM_2', 120),
  makeSand(TILE_TYPES.SAND_MEDIUM_3, 'SAND_MEDIUM_3', 130),
  makeSand(TILE_TYPES.SAND_MEDIUM_4, 'SAND_MEDIUM_4', 140),

  makeSand(TILE_TYPES.SAND_FINE_1, 'SAND_FINE_1', 210),
  makeSand(TILE_TYPES.SAND_FINE_2, 'SAND_FINE_2', 220),
  makeSand(TILE_TYPES.SAND_FINE_3, 'SAND_FINE_3', 230),
  makeSand(TILE_TYPES.SAND_FINE_4, 'SAND_FINE_4', 240),
];

export default SAND_TILES;
