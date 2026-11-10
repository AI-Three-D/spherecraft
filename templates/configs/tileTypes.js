import {
    buildTileCatalogRuntime,
    buildTileCategoryLookupWGSLForCategories,
} from '../../core/world/tileCatalogRuntime.js';
import { DEFAULT_TILE_CATALOG } from './defaultTileCatalog.js';

const DEFAULT_TILE_CATALOG_RUNTIME = buildTileCatalogRuntime(DEFAULT_TILE_CATALOG);

// Compatibility exports. The authored/default catalog is the source of truth;
// existing template systems still consume the generated integer protocol.
export const TILE_TYPES = Object.freeze({ ...DEFAULT_TILE_CATALOG_RUNTIME.tileTypes });
export const TILE_CATEGORIES = Object.freeze(
    DEFAULT_TILE_CATALOG_RUNTIME.tileCategories.map((category) => Object.freeze({
        id: category.id,
        name: category.name,
        ranges: category.ranges.map((range) => Object.freeze(range.slice())),
    }))
);
export const NUM_TILE_CATEGORIES = TILE_CATEGORIES.length;

/**
 * Generate a WGSL function `tileCategory(t: u32) -> u32` that maps
 * a tile type ID to its material category index.
 * Returns 255 for unmapped IDs.
 */
export function buildTileCategoryLookupWGSL(tileCategories = TILE_CATEGORIES) {
    return buildTileCategoryLookupWGSLForCategories(tileCategories);
}
