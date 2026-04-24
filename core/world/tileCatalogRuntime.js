import {
    clampCatalogTileId,
    cloneCatalogValue,
    mergeCatalogRanges,
    normalizeCatalogCategoryName,
    normalizeCatalogName,
    normalizeCatalogRange,
} from './tileCatalogUtils.js';

function addRange(categoryRanges, categoryName, range) {
    if (!range) return;
    if (!categoryRanges.has(categoryName)) {
        categoryRanges.set(categoryName, []);
    }
    categoryRanges.get(categoryName).push(range);
}

function normalizeRawDocument(rawTileCatalog, fallbackDocument) {
    const raw = rawTileCatalog && typeof rawTileCatalog === 'object' ? rawTileCatalog : null;
    if (raw?.tileCatalog && typeof raw.tileCatalog === 'object') {
        return raw.tileCatalog;
    }
    if (Array.isArray(raw?.tiles) || Array.isArray(raw?.categories)) {
        return raw;
    }
    return fallbackDocument && typeof fallbackDocument === 'object' ? fallbackDocument : {};
}

export function buildTileCategoryLookupWGSLForCategories(tileCategories = []) {
    const allRanges = [];
    for (const cat of Array.isArray(tileCategories) ? tileCategories : []) {
        for (const [lo, hi] of Array.isArray(cat?.ranges) ? cat.ranges : []) {
            allRanges.push({ lo, hi, id: cat.id, name: cat.name });
        }
    }
    allRanges.sort((a, b) => a.lo - b.lo || a.hi - b.hi);

    const lines = ['fn tileCategory(t: u32) -> u32 {'];
    for (const range of allRanges) {
        lines.push(
            `    if (t >= ${range.lo}u && t <= ${range.hi}u) { return ${range.id}u; } // ${range.name}`
        );
    }
    lines.push('    return 255u;');
    lines.push('}');
    return lines.join('\n');
}

export function buildTileCatalogRuntime(rawTileCatalog = {}, options = {}) {
    const raw = normalizeRawDocument(rawTileCatalog, options.fallbackDocument);
    const rawTiles = Array.isArray(raw.tiles) ? raw.tiles : [];
    const rawCategories = Array.isArray(raw.categories) ? raw.categories : [];

    const tileTypes = {};
    const tileNameById = {};
    const tiles = [];
    const categoryRanges = new Map();
    const warnings = {
        duplicateTileNames: [],
        duplicateTileIds: [],
        invalidTiles: [],
        invalidRanges: [],
    };

    for (let index = 0; index < rawTiles.length; index++) {
        const source = rawTiles[index] ?? {};
        const name = normalizeCatalogName(source.name ?? source.id);
        const tileId = clampCatalogTileId(source.tileId ?? source.value ?? source.id, NaN);
        if (!name || !Number.isFinite(tileId)) {
            warnings.invalidTiles.push({ index, name: source.name ?? source.id ?? null, tileId: source.tileId ?? source.id ?? null });
            continue;
        }
        if (Object.prototype.hasOwnProperty.call(tileTypes, name)) {
            warnings.duplicateTileNames.push({ name, ignoredTileId: tileId, keptTileId: tileTypes[name] });
            continue;
        }
        if (Object.prototype.hasOwnProperty.call(tileNameById, tileId)) {
            warnings.duplicateTileIds.push({ tileId, ignoredName: name, keptName: tileNameById[tileId] });
            continue;
        }

        const category = normalizeCatalogCategoryName(source.category);
        const tile = {
            name,
            id: tileId,
            category,
            displayName: typeof source.displayName === 'string' && source.displayName.trim()
                ? source.displayName.trim()
                : name,
            tags: Array.isArray(source.tags)
                ? source.tags.filter((tag) => typeof tag === 'string' && tag.trim()).map((tag) => tag.trim())
                : [],
        };

        tiles.push(tile);
        tileTypes[name] = tileId;
        tileNameById[tileId] = name;
        addRange(categoryRanges, category, [tileId, tileId]);
    }

    const categoryOrder = [];
    const requestedRangesByName = new Map();
    for (let index = 0; index < rawCategories.length; index++) {
        const source = rawCategories[index] ?? {};
        const name = normalizeCatalogCategoryName(source.name ?? source.id ?? `CATEGORY_${index}`);
        if (!categoryOrder.includes(name)) {
            categoryOrder.push(name);
        }
        const ranges = Array.isArray(source.ranges) ? source.ranges : [];
        for (const range of ranges) {
            const normalized = normalizeCatalogRange(range);
            if (normalized) {
                addRange(requestedRangesByName, name, normalized);
            } else {
                warnings.invalidRanges.push({ category: name, range: cloneCatalogValue(range) });
            }
        }
    }

    for (const tile of tiles) {
        if (!categoryOrder.includes(tile.category)) {
            categoryOrder.push(tile.category);
        }
    }

    const tileCategories = [];
    for (const name of categoryOrder) {
        const requested = requestedRangesByName.get(name) ?? [];
        const inferred = categoryRanges.get(name) ?? [];
        const ranges = mergeCatalogRanges([...requested, ...inferred]);
        if (ranges.length === 0) continue;
        tileCategories.push({
            id: tileCategories.length,
            name,
            ranges,
        });
    }

    return {
        tiles: tiles.sort((a, b) => a.id - b.id || a.name.localeCompare(b.name)),
        tileTypes,
        tileNameById,
        tileCategories,
        numTileCategories: tileCategories.length,
        buildTileCategoryLookupWGSL: () => buildTileCategoryLookupWGSLForCategories(tileCategories),
        summary: {
            tileCount: tiles.length,
            categoryCount: tileCategories.length,
            warningCount:
                warnings.duplicateTileNames.length +
                warnings.duplicateTileIds.length +
                warnings.invalidTiles.length +
                warnings.invalidRanges.length,
        },
        warnings,
    };
}
