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
// Fallback guesses used only when no real texture-average color is available
// for a category (see buildCoarseCategoryColorFragmentWGSL's tileAverageColors
// param). Darkened relative to a first, never-visually-tested guess: under
// this engine's real ambient+diffuse lighting, a flat color reads much
// brighter than the same nominal albedo does on a real (variation-breaking)
// texture. Snow/ice deliberately left bright; everything else scaled down
// roughly 0.55-0.65x.
const KEYWORD_COLORS = Object.freeze([
    ['WATER', [0.05, 0.10, 0.22]],
    ['ICE', [0.75, 0.82, 0.88]],
    ['SNOW', [0.85, 0.87, 0.90]],
    ['VOLCANIC', [0.10, 0.06, 0.05]],
    ['ROCK', [0.16, 0.155, 0.14]],
    ['TUNDRA', [0.25, 0.26, 0.22]],
    ['DESERT', [0.45, 0.35, 0.20]],
    ['SAND', [0.50, 0.42, 0.28]],
    ['SWAMP', [0.14, 0.16, 0.10]],
    ['MUD', [0.20, 0.15, 0.10]],
    ['DIRT', [0.22, 0.16, 0.11]],
    ['FOREST', [0.08, 0.16, 0.06]],
    ['GRASS', [0.023, 0.065, 0.025]],
   // ['GRASS', [0.13, 0.28, 0.10]],
]);

// Reached whenever the raw tile id falls outside every configured
// category's ranges (e.g. this catalog's real 48-id gap, 82-129, with no
// category at all). A neutral dirt-like tone rather than a diagnostic color
// now that the "edits have no visual effect" mystery is resolved (it wasn't
// this fallback path — see git history for the magenta diagnostic).
const FALLBACK_COLOR = Object.freeze([0.20, 0.17, 0.13]);

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
 * When `tileAverageColors` provides a real computed average (from
 * TextureAtlasManager.getCategoryAverageColorMap, sampled from the same
 * generated textures the normal detail tiers render), that value is used in
 * place of the hand-picked KEYWORD_COLORS guess for that category — it's
 * already correctly calibrated for this lighting pipeline since it's the
 * true average tone of the texture that pipeline already renders correctly.
 * The hand-picked table remains only as a fallback for categories with no
 * matching generated tile (e.g. the unmatched-id fallback color).
 *
 * @param {Array<{id:number,name:string,ranges:number[][]}>} tileCategories
 * @param {Map<number, [number,number,number]>|null} tileAverageColors
 * @returns {string} WGSL source to splice into the fragment shader
 */
let _loggedColorSources = false;

export function buildCoarseCategoryColorFragmentWGSL(tileCategories = [], tileAverageColors = null) {
    const categories = Array.isArray(tileCategories) ? tileCategories : [];
    const categoryLookupWGSL = buildTileCategoryLookupWGSLForCategories(categories);

    const colorLines = ['fn categoryFlatColor(categoryId: u32) -> vec3<f32> {'];
    const resolvedForLog = [];
    for (const category of categories) {
        if (!Number.isFinite(category?.id)) continue;
        const averageColor = tileAverageColors instanceof Map
            ? tileAverageColors.get(category.id)
            : null;
        const color = averageColor || colorForCategoryName(category.name);
        const source = averageColor ? 'texture average' : 'hand-picked fallback';
        colorLines.push(
            `    if (categoryId == ${Math.trunc(category.id)}u) { return ${wgslVec3(color)}; } // ${category.name} (${source})`
        );
        resolvedForLog.push({ id: category.id, name: category.name, color, source });
    }
    colorLines.push(`    return ${wgslVec3(FALLBACK_COLOR)};`);
    colorLines.push('}');

    if (!_loggedColorSources) {
        _loggedColorSources = true;
        console.info('[SolidColorTier] category colors resolved:', resolvedForLog);
    }

    return [
        categoryLookupWGSL,
        colorLines.join('\n'),
        'fn coarseTileColor(tileId: f32) -> vec3<f32> {',
        '    let catId = tileCategory(u32(round(tileId)));',
        '    return categoryFlatColor(catId);',
        '}',
    ].join('\n\n');
}
