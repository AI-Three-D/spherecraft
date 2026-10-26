const FAMILY_DEFS = Object.freeze([
    {
        name: 'ORGANIC',
        categories: ['GRASS', 'FOREST', 'SWAMP'],
        representativePreference: ['GRASS', 'FOREST', 'SWAMP'],
        fallbackTileId: 10,
    },
    {
        name: 'MINERAL',
        categories: ['ROCK', 'VOLCANIC'],
        representativePreference: ['ROCK', 'VOLCANIC'],
        fallbackTileId: 42,
    },
    {
        name: 'SOIL_ARID',
        categories: ['SAND', 'DESERT', 'DIRT', 'MUD'],
        representativePreference: ['SAND', 'DESERT', 'DIRT', 'MUD'],
        fallbackTileId: 30,
    },
    {
        name: 'COLD',
        categories: ['SNOW', 'TUNDRA'],
        representativePreference: ['SNOW', 'TUNDRA'],
        fallbackTileId: 130,
    },
]);

function normalizeCategoryName(value) {
    return typeof value === 'string'
        ? value.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_')
        : '';
}

function representativeTileForCategory(category) {
    const ranges = Array.isArray(category?.ranges) ? category.ranges : [];
    for (const range of ranges) {
        if (!Array.isArray(range) || range.length < 2) continue;
        const lo = Number.isFinite(range[0]) ? Math.trunc(range[0]) : null;
        const hi = Number.isFinite(range[1]) ? Math.trunc(range[1]) : null;
        if (lo == null || hi == null) continue;
        return Math.max(0, Math.min(lo, hi));
    }
    return null;
}

export function resolveFixedMaterialFamilies(tileCategories = []) {
    const categories = Array.isArray(tileCategories) ? tileCategories : [];
    const byName = new Map();
    for (const category of categories) {
        const name = normalizeCategoryName(category?.name);
        if (!name) continue;
        byName.set(name, category);
    }

    const categoryToFamily = new Map();
    const familyTileIds = [];

    for (let familyId = 0; familyId < FAMILY_DEFS.length; familyId++) {
        const family = FAMILY_DEFS[familyId];
        let representative = null;
        for (const categoryName of family.representativePreference) {
            const category = byName.get(categoryName);
            representative = representativeTileForCategory(category);
            if (representative != null) break;
        }
        familyTileIds.push(representative ?? family.fallbackTileId);

        for (const categoryName of family.categories) {
            const category = byName.get(categoryName);
            if (!Number.isFinite(category?.id)) continue;
            categoryToFamily.set(Math.trunc(category.id), familyId);
        }
    }

    return {
        families: FAMILY_DEFS.map((family, id) => ({
            id,
            name: family.name,
            tileId: familyTileIds[id],
        })),
        categoryToFamily,
        familyTileIds,
    };
}

// River and lake beds are MUD tiles (riverCarve.wgsl.js shore materials), a
// SOIL_ARID material its representative (desert, in a world without sand)
// would draw. In family mode the splat index texture holds no tile ids (they
// are the constants below), so splatCompute.wgsl.js writes the bed's share of
// the soil family to its red channel, and the terrain fragment shader and the
// resolved colour bake draw that share of the soil with the bed's texture.
function bedCategory(tileCategories) {
    return (Array.isArray(tileCategories) ? tileCategories : []).find(c => normalizeCategoryName(c?.name) === 'MUD') ?? null;
}

export function buildFixedMaterialFamilyComputeWGSL(tileCategories = []) {
    const { categoryToFamily } = resolveFixedMaterialFamilies(tileCategories);
    const bed = bedCategory(tileCategories);
    const mapperLines = ['fn fixedMaterialFamilyForCategory(categoryId: u32) -> u32 {'];
    for (const [categoryId, familyId] of [...categoryToFamily.entries()].sort((a, b) => a[0] - b[0])) {
        mapperLines.push(`    if (categoryId == ${categoryId}u) { return ${familyId}u; }`);
    }
    mapperLines.push('    return INVALID_CATEGORY_ID;');
    mapperLines.push('}');

    const bedLine = `const FIXED_MATERIAL_BED_CATEGORY: u32 = ${Number.isFinite(bed?.id) ? `${Math.trunc(bed.id)}u` : 'INVALID_CATEGORY_ID'};`;
    return `${mapperLines.join('\n')}\n\n${bedLine}`;
}

export function buildFixedMaterialFamilyFragmentWGSL(tileCategories = []) {
    const { familyTileIds } = resolveFixedMaterialFamilies(tileCategories);
    // The bed's tile (bedCategory), -1 without MUD.
    const mud = (bedCategory(tileCategories)?.ranges ?? []).flat().filter(Number.isFinite);
    return `const FIXED_MATERIAL_FAMILY_TILE_IDS: vec4<f32> = vec4<f32>(${familyTileIds.map((id) => `${id}.0`).join(', ')});
const FIXED_MATERIAL_BED_TILE: f32 = ${mud.length ? Math.min(...mud) : -1}.0;`;
}
