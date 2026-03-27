
import { TILE_CATEGORIES } from '../types.js';
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

const RAW_TEXTURE_CONFIG = [
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

function getTextureCategoryKey(tileId) {
  for (const category of TILE_CATEGORIES) {
    for (const [minTileId, maxTileId] of category.ranges) {
      if (tileId >= minTileId && tileId <= maxTileId) {
        return `category:${category.id}`;
      }
    }
  }
  return `tile:${tileId}`;
}

function cloneTextureValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => cloneTextureValue(item));
  }
  if (value && typeof value === 'object') {
    return { ...value };
  }
  return value;
}

function collapseLevelVariants(levelVariants) {
  if (!Array.isArray(levelVariants) || levelVariants.length === 0) {
    return [];
  }
  return [cloneTextureValue(levelVariants[0])];
}

function collapseSeasonTextures(seasonTextures = {}) {
  const collapsed = {};
  for (const [level, variants] of Object.entries(seasonTextures)) {
    collapsed[level] = collapseLevelVariants(variants);
  }
  return collapsed;
}

function collapseTileVariantTextures(textureConfig) {
  const canonicalByCategory = new Map();

  return textureConfig.map((entry) => {
    const categoryKey = getTextureCategoryKey(entry.id);
    if (!canonicalByCategory.has(categoryKey)) {
      canonicalByCategory.set(categoryKey, entry);
    }

    const canonical = canonicalByCategory.get(categoryKey);
    const baseTextures = canonical?.textures?.base ?? {};
    const collapsedBase = {};

    for (const [season, seasonTextures] of Object.entries(baseTextures)) {
      collapsedBase[season] = collapseSeasonTextures(seasonTextures);
    }

    return {
      ...entry,
      textures: {
        // Keep tile IDs/styles distinct, but collapse every tile inside a
        // top-level terrain category onto that category's first texture set.
        ...entry.textures,
        base: collapsedBase,
      },
    };
  });
}

export const TEXTURE_CONFIG = collapseTileVariantTextures(RAW_TEXTURE_CONFIG);

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
