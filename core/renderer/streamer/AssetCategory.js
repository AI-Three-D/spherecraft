// js/renderer/streamer/AssetCategory.js
//
// Simple data class holding per-category configuration and runtime state.
// One instance per asset category (trees, ground cover, plants).

const DEFAULT_LOD_DISTANCES = [30, 80, 200];
const DEFAULT_DENSITIES = [1, 0.5, 0.1];

function normalizeDistances(values, lodsPerCategory) {
    const out = Array.isArray(values) ? values.slice() : [];
    if (out.length === 0) out.push(DEFAULT_LOD_DISTANCES[0]);
    while (out.length < lodsPerCategory) {
        const last = out[out.length - 1];
        out.push(last + 1);
    }
    if (out.length > lodsPerCategory) out.length = lodsPerCategory;
    return out;
}

function normalizeDensities(values, lodsPerCategory) {
    const out = Array.isArray(values) ? values.slice() : [];
    if (out.length === 0) out.push(DEFAULT_DENSITIES[0]);
    while (out.length < lodsPerCategory) {
        out.push(0.0);
    }
    if (out.length > lodsPerCategory) out.length = lodsPerCategory;
    return out;
}

export class AssetCategory {
    /**
     * @param {object} def - Category definition from streamerConfig
     * @param {number} def.id - Category index (0, 1, 2)
     * @param {string} def.name - Human-readable name
     * @param {number[]} def.tileTypes - Accepted tile type IDs
     * @param {number[]} def.lodDistances - LOD transition distances
     * @param {number[]} def.densities - Instances per m² per LOD
     * @param {object}  def.sizeRange - { width: [min,max], height: [min,max] }
     * @param {number[]} def.baseColor - [r,g,b] base tint
     * @param {number[]} def.tipColor - [r,g,b] tip/highlight tint
     * @param {number} lodsPerCategory - LODS_PER_CATEGORY from streamerTheme
     */
    constructor(def, lodsPerCategory) {
        if (!Number.isInteger(lodsPerCategory) || lodsPerCategory < 1) {
            throw new Error('AssetCategory requires lodsPerCategory');
        }
        this.lodsPerCategory = lodsPerCategory;
        this.id = def.id;
        this.name = def.name;
        this.tileTypes = def.tileTypes || [];
        const baseDistances = def.lodDistances || DEFAULT_LOD_DISTANCES;
        const baseDensities = def.densities || DEFAULT_DENSITIES;
        this.lodDistances = normalizeDistances(baseDistances, lodsPerCategory);
        this.densities = normalizeDensities(baseDensities, lodsPerCategory);
        this.sizeRange = def.sizeRange || { width: [0.1, 0.5], height: [0.3, 1.0] };
        this.baseColor = def.baseColor || [0.3, 0.3, 0.3];
        this.tipColor = def.tipColor || [0.5, 0.5, 0.5];
    }

    /** Check if this category accepts the given tile type ID. */
    acceptsTileType(tileTypeId) {
        return this.tileTypes.includes(tileTypeId);
    }

    /** Given a distance in meters, return the LOD level (0=near, 1=mid, 2=far, -1=out of range). */
    getLodLevel(distance) {
        for (let i = 0; i < this.lodsPerCategory; i++) {
            if (distance < this.lodDistances[i]) return i;
        }
        return -1;
    }

    /** Return the global band index for a LOD level. */
    getBandIndex(lodLevel) {
        return this.id * this.lodsPerCategory + lodLevel;
    }

    /** Maximum density across all LODs (used for scatter grid sizing). */
    get maxDensity() {
        return Math.max(...this.densities);
    }
}
