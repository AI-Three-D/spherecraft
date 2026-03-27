import { TILE_TYPES } from '../../types.js';
import { TEXTURE_LEVELS } from '../TileConfig.js';
import { sameForAllSeasons, withSeed } from './reusable/shared.js';
import { DIRT_MICRO_A, DIRT_MACRO } from './reusable/dirtTextures.js';

function makeDirt(id, name, seedOffset) {
  return {
    id,
    name,
    textures: {
      base: sameForAllSeasons({
        [TEXTURE_LEVELS.MICRO]: [
          withSeed(DIRT_MICRO_A, seedOffset),
        ],
        [TEXTURE_LEVELS.MACRO]: [DIRT_MACRO],
      }),
    },
  };
}

export const DIRT_TILES = [
  makeDirt(TILE_TYPES.DIRT_DRY_1, 'DIRT_DRY_1', 10),
  makeDirt(TILE_TYPES.DIRT_DRY_2, 'DIRT_DRY_2', 20),
  makeDirt(TILE_TYPES.DIRT_DRY_3, 'DIRT_DRY_3', 30),
  makeDirt(TILE_TYPES.DIRT_DRY_4, 'DIRT_DRY_4', 40),

  makeDirt(TILE_TYPES.DIRT_LOAM_1, 'DIRT_LOAM_1', 110),
  makeDirt(TILE_TYPES.DIRT_LOAM_2, 'DIRT_LOAM_2', 120),
  makeDirt(TILE_TYPES.DIRT_LOAM_3, 'DIRT_LOAM_3', 130),
  makeDirt(TILE_TYPES.DIRT_LOAM_4, 'DIRT_LOAM_4', 140),

  makeDirt(TILE_TYPES.DIRT_CLAY_1, 'DIRT_CLAY_1', 210),
  makeDirt(TILE_TYPES.DIRT_CLAY_2, 'DIRT_CLAY_2', 220),
  makeDirt(TILE_TYPES.DIRT_CLAY_3, 'DIRT_CLAY_3', 230),
  makeDirt(TILE_TYPES.DIRT_CLAY_4, 'DIRT_CLAY_4', 240),
];

export default DIRT_TILES;
