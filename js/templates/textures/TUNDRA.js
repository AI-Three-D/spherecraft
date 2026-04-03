import { TILE_TYPES } from '../../shared/types.js';
import { TEXTURE_LEVELS } from '../configs/TileConfig.js';
import { sameForAllSeasons, withSeed } from './reusable/shared.js';
import { TUNDRA_MICRO_A, TUNDRA_MICRO_B, TUNDRA_MACRO } from './reusable/tundraTextures.js';

function makeTundra(id, name, seedOffset) {
  return {
    id,
    name,
    textures: {
      base: sameForAllSeasons({
        [TEXTURE_LEVELS.MICRO]: [
          withSeed(TUNDRA_MICRO_A, seedOffset),
          withSeed(TUNDRA_MICRO_B, seedOffset),
        ],
        [TEXTURE_LEVELS.MACRO]: [TUNDRA_MACRO],
      }),
    },
  };
}

export const TUNDRA_TILES = [
  makeTundra(TILE_TYPES.TUNDRA_BARREN_1, 'TUNDRA_BARREN_1', 10),
  makeTundra(TILE_TYPES.TUNDRA_BARREN_2, 'TUNDRA_BARREN_2', 20),
  makeTundra(TILE_TYPES.TUNDRA_BARREN_3, 'TUNDRA_BARREN_3', 30),
  makeTundra(TILE_TYPES.TUNDRA_BARREN_4, 'TUNDRA_BARREN_4', 40),

  makeTundra(TILE_TYPES.TUNDRA_LICHEN_1, 'TUNDRA_LICHEN_1', 110),
  makeTundra(TILE_TYPES.TUNDRA_LICHEN_2, 'TUNDRA_LICHEN_2', 120),
  makeTundra(TILE_TYPES.TUNDRA_LICHEN_3, 'TUNDRA_LICHEN_3', 130),
  makeTundra(TILE_TYPES.TUNDRA_LICHEN_4, 'TUNDRA_LICHEN_4', 140),

  makeTundra(TILE_TYPES.TUNDRA_MOSS_1, 'TUNDRA_MOSS_1', 210),
  makeTundra(TILE_TYPES.TUNDRA_MOSS_2, 'TUNDRA_MOSS_2', 220),
  makeTundra(TILE_TYPES.TUNDRA_MOSS_3, 'TUNDRA_MOSS_3', 230),
  makeTundra(TILE_TYPES.TUNDRA_MOSS_4, 'TUNDRA_MOSS_4', 240),
];

export default TUNDRA_TILES;
