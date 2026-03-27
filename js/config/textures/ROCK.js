import { TILE_TYPES } from '../../types.js';
import { TEXTURE_LEVELS } from '../TileConfig.js';
import { sameForAllSeasons, withSeed } from './reusable/shared.js';
import { ROCK_MICRO_A, ROCK_MICRO_B, ROCK_MACRO } from './reusable/rockTextures.js';

function makeRock(id, name, seedOffset) {
  return {
    id,
    name,
    textures: {
      base: sameForAllSeasons({
        [TEXTURE_LEVELS.MICRO]: [
          withSeed(ROCK_MICRO_A, seedOffset),
          withSeed(ROCK_MICRO_B, seedOffset),
        ],
        [TEXTURE_LEVELS.MACRO]: [ROCK_MACRO],
      }),
    },
  };
}

export const ROCK_TILES = [
  makeRock(TILE_TYPES.ROCK_OUTCROP_1, 'ROCK_OUTCROP_1', 10),
  makeRock(TILE_TYPES.ROCK_OUTCROP_2, 'ROCK_OUTCROP_2', 20),
  makeRock(TILE_TYPES.ROCK_OUTCROP_3, 'ROCK_OUTCROP_3', 30),
  makeRock(TILE_TYPES.ROCK_OUTCROP_4, 'ROCK_OUTCROP_4', 40),

  makeRock(TILE_TYPES.ROCK_SLAB_1, 'ROCK_SLAB_1', 110),
  makeRock(TILE_TYPES.ROCK_SLAB_2, 'ROCK_SLAB_2', 120),
  makeRock(TILE_TYPES.ROCK_SLAB_3, 'ROCK_SLAB_3', 130),
  makeRock(TILE_TYPES.ROCK_SLAB_4, 'ROCK_SLAB_4', 140),

  makeRock(TILE_TYPES.ROCK_BOULDER_1, 'ROCK_BOULDER_1', 210),
  makeRock(TILE_TYPES.ROCK_BOULDER_2, 'ROCK_BOULDER_2', 220),
  makeRock(TILE_TYPES.ROCK_BOULDER_3, 'ROCK_BOULDER_3', 230),
  makeRock(TILE_TYPES.ROCK_BOULDER_4, 'ROCK_BOULDER_4', 240),
];

export default ROCK_TILES;
