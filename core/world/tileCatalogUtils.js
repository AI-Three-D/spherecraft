export const DEFAULT_TILE_CATEGORY_NAME = 'UNMAPPED';
export const MAX_TILE_ID = 65535;

export function cloneCatalogValue(value) {
    if (Array.isArray(value)) {
        return value.map(cloneCatalogValue);
    }
    if (value && typeof value === 'object') {
        const out = {};
        for (const [key, nested] of Object.entries(value)) {
            out[key] = cloneCatalogValue(nested);
        }
        return out;
    }
    return value;
}

export function clampCatalogTileId(value, fallback, min = 0, max = MAX_TILE_ID) {
    const numeric = Number.isFinite(value) ? Math.trunc(value) : fallback;
    return Math.max(min, Math.min(max, numeric));
}

export function normalizeCatalogName(value, fallback = '') {
    const normalized = typeof value === 'string'
        ? value.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_')
        : '';
    return normalized || fallback;
}

export function normalizeCatalogCategoryName(value, fallback = DEFAULT_TILE_CATEGORY_NAME) {
    return normalizeCatalogName(value, fallback);
}

export function normalizeCatalogRange(range) {
    if (!Array.isArray(range) || range.length < 2) return null;
    const low = clampCatalogTileId(range[0], NaN);
    const high = clampCatalogTileId(range[1], NaN);
    if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
    return [Math.min(low, high), Math.max(low, high)];
}

export function mergeCatalogRanges(ranges) {
    if (!Array.isArray(ranges) || ranges.length === 0) return [];
    const sorted = ranges
        .filter(Boolean)
        .map(([low, high]) => [low, high])
        .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

    const merged = [];
    for (const [low, high] of sorted) {
        const last = merged[merged.length - 1];
        if (last && low <= last[1] + 1) {
            last[1] = Math.max(last[1], high);
        } else {
            merged.push([low, high]);
        }
    }
    return merged;
}
