import { TILE_TYPES } from '../../shared/types.js';
import { TEXTURE_LEVELS } from '../configs/TileConfig.js';
import { sameForAllSeasons, withSeed } from './reusable/shared.js';
import { MUD_MICRO_A, MUD_MICRO_B, MUD_MACRO } from './reusable/mudTextures.js';

function makeMud(id, name, seedOffset) {
  return {
    id,
    name,
    textures: {
      base: sameForAllSeasons({
        [TEXTURE_LEVELS.MICRO]: [
          withSeed(MUD_MICRO_A, seedOffset),
          withSeed(MUD_MICRO_B, seedOffset),
        ],
        [TEXTURE_LEVELS.MACRO]: [MUD_MACRO],
      }),
    },
  };
}

export const MUD_TILES = [
  makeMud(TILE_TYPES.MUD_WET_1, 'MUD_WET_1', 10),
  makeMud(TILE_TYPES.MUD_WET_2, 'MUD_WET_2', 20),
  makeMud(TILE_TYPES.MUD_WET_3, 'MUD_WET_3', 30),
  makeMud(TILE_TYPES.MUD_WET_4, 'MUD_WET_4', 40),

  makeMud(TILE_TYPES.MUD_SILT_1, 'MUD_SILT_1', 110),
  makeMud(TILE_TYPES.MUD_SILT_2, 'MUD_SILT_2', 120),
  makeMud(TILE_TYPES.MUD_SILT_3, 'MUD_SILT_3', 130),
  makeMud(TILE_TYPES.MUD_SILT_4, 'MUD_SILT_4', 140),

  makeMud(TILE_TYPES.MUD_PEAT_1, 'MUD_PEAT_1', 210),
  makeMud(TILE_TYPES.MUD_PEAT_2, 'MUD_PEAT_2', 220),
  makeMud(TILE_TYPES.MUD_PEAT_3, 'MUD_PEAT_3', 230),
  makeMud(TILE_TYPES.MUD_PEAT_4, 'MUD_PEAT_4', 240),
];

export default MUD_TILES;
