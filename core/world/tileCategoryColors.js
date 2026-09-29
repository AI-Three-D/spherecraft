// A flat, coherent color derived purely from a tile's raw classification id,
// with no atlas/texture sampling, no splat, no blending — the cheapest
// possible "roughly what kind of ground this is" representation. Paired with
// the shared lighting pipeline (ambient/diffuse/shadow/AO, real per-tile
// normal), this is enough to show slope-based shading and mountain
// silhouettes at extreme distance without any refinement-stage generation
// at all: it only needs the geometry pass's own `tile` output, which is
// always ready with zero refinement wait.
//
// Colors are keyed by category *name* (not hardcoded ids/ranges), matching
// whatever tileCategories the running planet config actually authored —
// default catalog or custom — via a keyword match against the category
// name. This stays correct if the catalog changes; it never depends on a
// hand-copied numeric range table that could silently drift out of sync.
import { buildTileCategoryLookupWGSLForCategories } from './tileCatalogRuntime.js';

// Order matters only if a category name could match multiple keywords
// (e.g. a hypothetical "FOREST_SWAMP"); more specific/compound names should
// precede broader ones. The current default catalog's names
// (WATER/GRASS/SAND/ROCK/TUNDRA/FOREST/SWAMP/DIRT/MUD/VOLCANIC/SNOW/DESERT)
// have no such overlaps.
// Darkened relative to a first, never-visually-tested guess (2026-09-29):
// under this engine's real ambient+diffuse lighting, a flat color reads much
// brighter than the same nominal albedo does on a real (variation-breaking)
// texture — confirmed too light by direct observation at LOD6. Snow/ice are
// deliberately left bright (that's correct for them); everything else scaled
// down roughly 0.55-0.65x.
const KEYWORD_COLORS = Object.freeze([
    ['WATER', [0.04, 0.20, 0.36]],
    ['ICE', [0.75, 0.88, 0.93]],
    ['SNOW', [0.92, 0.94, 0.96]],
    ['VOLCANIC', [0.18, 0.09, 0.08]],
    ['ROCK', [0.27, 0.26, 0.24]],
    ['TUNDRA', [0.33, 0.34, 0.29]],
    ['DESERT', [0.43, 0.35, 0.21]],
    ['SAND', [0.46, 0.40, 0.26]],
    ['SWAMP', [0.16, 0.18, 0.10]],
    ['MUD', [0.19, 0.14, 0.09]],
    ['DIRT', [0.22, 0.16, 0.10]],
    ['FOREST', [0.06, 0.16, 0.07]],
    ['GRASS', [0.13, 0.28, 0.10]],
]);

// Reached whenever the raw tile id falls outside every configured
// category's ranges — confirmed via debug-mode isolation (2026-09-29) that
// this, not GRASS, is what LOD6 was actually showing: this catalog's real
// computed ranges (WATER 0-3, GRASS 10-29, ROCK 42-53, FOREST 66-81/142-149,
// SNOW 130-141, DESERT 150-165) leave a real 48-id gap (82-129) with no
// category at all, and darkening GRASS earlier had no visible effect
// because the pixels in question were never using it. Darkened to match
// the rest of the palette (was the original, never-tested [0.38,0.38,0.34]
// — same mistake as the rest of the table, just missed the first pass).
const FALLBACK_COLOR = Object.freeze([0.19, 0.20, 0.17]);

function colorForCategoryName(name) {
    const upper = typeof name === 'string' ? name.toUpperCase() : '';
    for (const [keyword, color] of KEYWORD_COLORS) {
        if (upper.includes(keyword)) return color;
    }
    return FALLBACK_COLOR;
}

function wgslVec3(color) {
    return `vec3<f32>(${color[0]}, ${color[1]}, ${color[2]})`;
}

/**
 * Generates the WGSL for flat-color rendering: the existing
 * tileCategory(t: u32) -> u32 lookup (raw id -> category id, 255 if
 * unmatched), a categoryFlatColor(categoryId) -> vec3<f32> table built from
 * the same tileCategories the rest of the material shader already receives,
 * and a coarseTileColor(tileId: f32) -> vec3<f32> convenience wrapper.
 *
 * @param {Array<{id:number,name:string,ranges:number[][]}>} tileCategories
 * @returns {string} WGSL source to splice into the fragment shader
 */
export function buildCoarseCategoryColorFragmentWGSL(tileCategories = []) {
    const categories = Array.isArray(tileCategories) ? tileCategories : [];
    // Temporary: print exactly what this function actually receives at
    // runtime — two separate color-value edits produced zero visible change,
    // which means the wrong data (or wrong shape) may be reaching here
    // rather than the color values themselves being off.
    // eslint-disable-next-line no-console
    console.log('[CoarseColorDebug] tileCategories received:', JSON.stringify(categories));
    const categoryLookupWGSL = buildTileCategoryLookupWGSLForCategories(categories);

    const colorLines = ['fn categoryFlatColor(categoryId: u32) -> vec3<f32> {'];
    for (const category of categories) {
        if (!Number.isFinite(category?.id)) continue;
        const color = colorForCategoryName(category.name);
        colorLines.push(
            `    if (categoryId == ${Math.trunc(category.id)}u) { return ${wgslVec3(color)}; } // ${category.name}`
        );
    }
    colorLines.push(`    return ${wgslVec3(FALLBACK_COLOR)};`);
    colorLines.push('}');

    return [
        categoryLookupWGSL,
        colorLines.join('\n'),
        'fn coarseTileColor(tileId: f32) -> vec3<f32> {',
        '    let catId = tileCategory(u32(round(tileId)));',
        '    return categoryFlatColor(catId);',
        '}',
    ].join('\n\n');
}
