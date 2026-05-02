import { buildTileCategoryLookupWGSLForCategories } from '../core/world/tileCatalogRuntime.js';

export function createTerrainThemeForPlanet(baseTheme, planetConfig) {
    const tileCatalog = planetConfig?.tileCatalog ?? planetConfig?.worldAuthoring?.tileCatalog;
    const tileCategories = Array.isArray(tileCatalog?.tileCategories) ? tileCatalog.tileCategories : null;
    const tileTypes = tileCatalog?.tileTypes && typeof tileCatalog.tileTypes === 'object'
        ? tileCatalog.tileTypes
        : null;

    if (!tileCategories || tileCategories.length === 0) {
        return baseTheme;
    }

    return {
        ...(baseTheme ?? {}),
        TILE_TYPES: tileTypes ?? baseTheme?.TILE_TYPES,
        TILE_CATEGORIES: tileCategories,
        NUM_TILE_CATEGORIES: tileCategories.length,
        buildTileCategoryLookupWGSL: () => buildTileCategoryLookupWGSLForCategories(tileCategories),
    };
}
