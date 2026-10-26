// tools/perf/riverBanks/catalogProbe.js
//
// Page side (pageProbe.mjs): the terrain generator's active tile catalog,
// whether the bed materials' tile ids are in it, and the material families.

export function catalogProbe() {
    const t = window.gameEngine.terrainGenerator;
    const cats = (t.tileCategories ?? []).map(c => ({ name: c.name ?? c.id, ranges: c.ranges }));
    const inCatalog = (id) => cats.some(c => (c.ranges ?? []).some(([lo, hi]) => id >= lo && id <= hi));
    const ids = { GRASS_SHORT_1: 10, SAND_COARSE_1: 30, ROCK_OUTCROP_1: 42, SWAMP_1: 82, DIRT_DRY_1: 94, DIRT_LOAM_1: 98, MUD_WET_1: 106, MUD_SILT_1: 110 };
    return {
        categories: cats,
        bedIds: Object.fromEntries(Object.entries(ids).map(([k, v]) => [k, inCatalog(v)])),
        fixedMaterialFamilies: t.fixedMaterialFamiliesEnabled ?? t.options?.fixedMaterialFamiliesEnabled ?? null,
        keys: Object.keys(t).filter(k => /family|families|catalog|tile/i.test(k)),
    };
}
