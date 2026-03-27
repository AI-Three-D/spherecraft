

import WATER_TILES from './textures/WATER.js';

import GRASS_TILES from './textures/GRASS.js';
import SAND_TILES from './textures/SAND.js';
import ROCK_TILES from './textures/ROCK.js';
import TUNDRA_TILES from './textures/TUNDRA.js';
import FOREST_FLOOR_TILES from './textures/FOREST_FLOOR.js';
import SWAMP_TILES from './textures/SWAMP.js';
import DIRT_TILES from './textures/DIRT.js';
import MUD_TILES from './textures/MUD.js';
import VOLCANIC_TILES from './textures/VOLCANIC.js';
import SNOW_TILES from './textures/SNOW.js';
import DESERT_TILES from './textures/DESERT.js';

export const TEXTURE_CONFIG = [
  ...WATER_TILES,

  ...GRASS_TILES,
  ...SAND_TILES,
  ...ROCK_TILES,

  ...TUNDRA_TILES,
  ...FOREST_FLOOR_TILES,
  ...SWAMP_TILES,

  ...DIRT_TILES,
  ...MUD_TILES,
  ...VOLCANIC_TILES,
  ...SNOW_TILES,
  ...DESERT_TILES,
];

export function getAllVariantsForTileLevel(tileType, level) {
  const tile = TEXTURE_CONFIG.find(t => t.id === tileType);
  if (!tile || !tile.textures || !tile.textures.base) return [];
  const map = [];
  for (const season of Object.keys(tile.textures.base)) {
    const variants = tile.textures.base[season][level] || [];
    for (let i = 0; i < variants.length; ++i) {
      map.push({ season, variant: i, layers: variants[i] });
    }
  }
  return map;
}

export function getVariantsFromConfig(tileType, level, season) {
  const tile = TEXTURE_CONFIG.find(t => t.id === tileType);
  if (!tile) return [];
  return (
    tile.textures &&
    tile.textures.base &&
    tile.textures.base[season] &&
    tile.textures.base[season][level]
  ) ? tile.textures.base[season][level] : [];
}
