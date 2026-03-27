// js/config/textures/reusable/shared.js
// Shared helpers for procedural texture layer stacks (no seasonal variants).

import { SEASONS, TEXTURE_LEVELS } from '../../TileConfig.js';

// Helper: map a {MICRO:[...], MACRO:[...]} levels object to all seasons.
export function sameForAllSeasons(levelsByName) {
  const out = {};
  for (const season of Object.values(SEASONS)) {
    out[season] = {
      [TEXTURE_LEVELS.MICRO]: levelsByName[TEXTURE_LEVELS.MICRO] ?? [],
      [TEXTURE_LEVELS.MACRO]: levelsByName[TEXTURE_LEVELS.MACRO] ?? []
    };
  }
  return out;
}

// Slightly vary a base seed per tile id + variant index so tiles don’t look identical.
export function withSeed(layerSet, seedOffset) {
  return layerSet.map((layer) => {
    if (typeof layer.seed !== 'number') return layer;
    return { ...layer, seed: layer.seed + seedOffset };
  });
}
