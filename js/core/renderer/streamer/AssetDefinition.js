// js/renderer/streamer/AssetDefinition.js
//
// Data class representing a single streamable asset type.
// Assets are selected based on tile type + climate conditions.

/**
 * @typedef {object} ClimateRange
 * @property {[number, number]} temperature - [min, max] normalized 0-1 (0=freezing, 1=hot)
 * @property {[number, number]} precipitation - [min, max] normalized 0-1 (0=arid, 1=wet)
 */

/**
 * @typedef {object} SizeRange
 * @property {[number, number]} width - [min, max] in meters
 * @property {[number, number]} height - [min, max] in meters
 */

import { ASSET_DEF_FLOATS, LODS_PER_CATEGORY } from './streamerConfig.js';
import { ASSET_SELF_OCCLUSION } from './streamerConfig.js';

const DEFAULT_LOD_DISTANCES = [100, 300, 800];
const DEFAULT_DENSITIES = [0.01, 0.005, 0.001];

function normalizeDistances(values) {
    const out = Array.isArray(values) ? values.slice() : [];
    if (out.length === 0) out.push(DEFAULT_LOD_DISTANCES[0]);
    while (out.length < LODS_PER_CATEGORY) {
        const last = out[out.length - 1];
        out.push(last + 1);
    }
    if (out.length > LODS_PER_CATEGORY) out.length = LODS_PER_CATEGORY;
    return out;
}

function normalizeDensities(values) {
    const out = Array.isArray(values) ? values.slice() : [];
    if (out.length === 0) out.push(DEFAULT_DENSITIES[0]);
    while (out.length < LODS_PER_CATEGORY) {
        out.push(0.0);
    }
    if (out.length > LODS_PER_CATEGORY) out.length = LODS_PER_CATEGORY;
    return out;
}

export class AssetDefinition {
    /**
     * @param {object} def
     * @param {string} def.id - Unique identifier (e.g., 'pine', 'oak', 'cactus')
     * @param {string} def.category - 'tree' | 'groundCover' | 'plant'
     * @param {string} def.name - Human-readable name
     * @param {string} def.geometryType - Geometry builder key (e.g., 'conifer', 'deciduous', 'palm')
     * @param {number[]} def.tileTypes - Array of tile type IDs that can spawn this asset
     * @param {ClimateRange} def.climateRange - Temperature and precipitation ranges
     * @param {[number, number]} [def.elevationRange] - [min, max] normalized height (0-1)
     * @param {[number, number]} [def.slopeRange] - [min, max] (0=flat, 1=vertical)
     * @param {number[]} def.lodDistances - LOD transition distances in meters
     * @param {number[]} def.densities - Instances per m² at each LOD
     * @param {SizeRange} def.sizeRange - Width and height ranges
     * @param {[number, number, number]} def.baseColor - [r, g, b] base tint (0-1)
     * @param {[number, number, number]} def.tipColor - [r, g, b] tip/highlight tint (0-1)
     * @param {number} [def.priority] - Selection priority when multiple assets match (higher = preferred)
     */
    constructor(def) {
        // Required fields
        if (!def.id) throw new Error('AssetDefinition requires id');
        if (!def.category) throw new Error('AssetDefinition requires category');
        if (!def.geometryType) throw new Error('AssetDefinition requires geometryType');
        if (!def.tileTypes || def.tileTypes.length === 0) {
            throw new Error('AssetDefinition requires at least one tileType');
        }

        this.id = def.id;
        this.category = def.category;
        this.name = def.name || def.id;
        this.geometryType = def.geometryType;
        this.tileTypes = [...def.tileTypes];

        // Climate range with defaults (full range = no restriction)
        const climate = def.climateRange || {};
        this.climateRange = {
            temperature: climate.temperature || [0.0, 1.0],
            precipitation: climate.precipitation || [0.0, 1.0]
        };

        // Elevation and slope ranges (defaults allow all)
        this.elevationRange = def.elevationRange || [0.0, 1.0];
        this.slopeRange = def.slopeRange || [0.0, 1.0];

        // LOD configuration
        const baseDistances = def.lodDistances || DEFAULT_LOD_DISTANCES;
        const baseDensities = def.densities || DEFAULT_DENSITIES;
        this.lodDistances = normalizeDistances(baseDistances);
        this.densities = normalizeDensities(baseDensities);

        // Size
        this.sizeRange = {
            width: def.sizeRange?.width || [1.0, 2.0],
            height: def.sizeRange?.height || [2.0, 5.0]
        };

        // Colors
        this.baseColor = def.baseColor || [0.3, 0.3, 0.3];
        this.tipColor = def.tipColor || [0.5, 0.5, 0.5];

        // Selection priority (higher = more likely when multiple match)
        this.priority = def.priority ?? 1.0;

        const soGlobal = ASSET_SELF_OCCLUSION;
        const soCategoryKey = this._getSelfOcclusionCategoryKey();
        const soCategory = soGlobal[soCategoryKey] || soGlobal.default;
        const soAsset = def.selfOcclusion || {};

        this.selfOcclusion = {
            gradientWidth:    soAsset.gradientWidth    ?? soCategory.gradientWidth,
            strengthMul:      soAsset.strengthMul      ?? soCategory.strengthMul,
            terrainEmbedding: soAsset.terrainEmbedding ?? soCategory.terrainEmbedding,
            darkening:        soAsset.darkening         ?? soCategory.darkening,
        };

        // Computed: category index for GPU
        this._categoryIndex = this._getCategoryIndex();
    }

        /**
     * Map asset id / category to self-occlusion config key.
     * Allows per-asset-id overrides (e.g. grass_tall) with category fallback.
     * @returns {string}
     */
        _getSelfOcclusionCategoryKey() {
            // Check if there's a direct match by asset id first
            if (ASSET_SELF_OCCLUSION[this.id]) return this.id;
    
            // Map category to config key
            switch (this.category) {
                case 'tree': return 'tree';
                case 'groundCover': return 'groundCover';
                case 'plant': return 'default';
                default: return 'default';
            }
        }

    _getCategoryIndex() {
        switch (this.category) {
            case 'tree': return 0;
            case 'groundCover': return 1;
            case 'plant': return 2;
            default: return 2; // Default to plants
        }
    }

    /**
     * Compute fitness score for given environmental conditions.
     * Returns 0-1 where 1 = perfect match, 0 = cannot spawn.
     * 
     * @param {number} temperature - Normalized temperature (0-1)
     * @param {number} precipitation - Normalized precipitation (0-1)
     * @param {number} elevation - Normalized elevation (0-1)
     * @param {number} slope - Normalized slope (0=flat, 1=vertical)
     * @returns {number} Fitness score 0-1
     */
    computeFitness(temperature, precipitation, elevation, slope) {
        const tempFit = this._smoothRange(temperature, this.climateRange.temperature);
        const precipFit = this._smoothRange(precipitation, this.climateRange.precipitation);
        const elevFit = this._smoothRange(elevation, this.elevationRange);
        const slopeFit = this._smoothRange(slope, this.slopeRange);

        // Multiplicative combination - all conditions must be met
        return tempFit * precipFit * elevFit * slopeFit;
    }

    /**
     * Smooth range function with falloff at edges.
     * Returns 1.0 in center of range, falls to 0 outside range.
     * 
     * @param {number} value 
     * @param {[number, number]} range - [min, max]
     * @returns {number} 0-1
     */
    _smoothRange(value, range) {
        const [minVal, maxVal] = range;
        const rangeSize = maxVal - minVal;
        
        if (rangeSize <= 0) {
            // Point range - exact match only
            return Math.abs(value - minVal) < 0.01 ? 1.0 : 0.0;
        }

        // 20% fade zone at edges
        const fadeZone = rangeSize * 0.2;
        const innerMin = minVal + fadeZone;
        const innerMax = maxVal - fadeZone;

        if (value < minVal || value > maxVal) return 0.0;
        if (value >= innerMin && value <= innerMax) return 1.0;

        // Smooth falloff in fade zones
        if (value < innerMin) {
            return this._smoothstep(minVal, innerMin, value);
        } else {
            return 1.0 - this._smoothstep(innerMax, maxVal, value);
        }
    }

    _smoothstep(edge0, edge1, x) {
        const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
        return t * t * (3 - 2 * t);
    }

    /**
     * Get LOD level for given distance.
     * @param {number} distance - Distance from camera in meters
     * @returns {number} LOD level (0=nearest, -1=out of range)
     */
    getLodLevel(distance) {
        for (let i = 0; i < this.lodDistances.length; i++) {
            if (distance < this.lodDistances[i]) return i;
        }
        return -1;
    }

    /**
     * Get density for given LOD level.
     * @param {number} lodLevel 
     * @returns {number} Instances per m²
     */
    getDensity(lodLevel) {
        if (lodLevel < 0 || lodLevel >= this.densities.length) return 0;
        return this.densities[lodLevel] ?? 0;
    }

    /**
     * Get maximum render distance.
     * @returns {number}
     */
    get maxDistance() {
        return this.lodDistances[this.lodDistances.length - 1];
    }

    /**
     * Get maximum density across all LODs.
     * @returns {number}
     */
    get maxDensity() {
        return Math.max(...this.densities);
    }

    /**
     * Serialize to GPU-compatible format (for upload to storage buffer).
     * Returns flat array of floats/uints matching shader struct layout.
     * 
     * Layout:
     *   [0-3]:   tempMin, tempMax, precipMin, precipMax
     *   [4-7]:   elevMin, elevMax, slopeMin, slopeMax
     *   [8-11]:  widthMin, widthMax, heightMin, heightMax
     *   [12-15]: baseR, baseG, baseB, tipR
     *   [16-17]: tipG, tipB
     *   [18..]:  lodDistances (LODS_PER_CATEGORY)
     *   [...]:   densities (LODS_PER_CATEGORY)
     *   [...]:   categoryIndex, priority, geometryIndex, _pad
     * 
     * @param {number} geometryIndex - Index into geometry atlas
     * @returns {Float32Array}
     */
    toGPUData(geometryIndex = 0) {
        const data = new Float32Array(ASSET_DEF_FLOATS);
        
        // Climate ranges
        data[0] = this.climateRange.temperature[0];
        data[1] = this.climateRange.temperature[1];
        data[2] = this.climateRange.precipitation[0];
        data[3] = this.climateRange.precipitation[1];

        // Elevation/slope ranges
        data[4] = this.elevationRange[0];
        data[5] = this.elevationRange[1];
        data[6] = this.slopeRange[0];
        data[7] = this.slopeRange[1];

        // Size ranges
        data[8] = this.sizeRange.width[0];
        data[9] = this.sizeRange.width[1];
        data[10] = this.sizeRange.height[0];
        data[11] = this.sizeRange.height[1];

        // Colors
        data[12] = this.baseColor[0];
        data[13] = this.baseColor[1];
        data[14] = this.baseColor[2];
        data[15] = this.tipColor[0];
        data[16] = this.tipColor[1];
        data[17] = this.tipColor[2];

        let offset = 18;
        for (let i = 0; i < LODS_PER_CATEGORY; i++) {
            data[offset + i] = this.lodDistances[i];
        }
        offset += LODS_PER_CATEGORY;
        for (let i = 0; i < LODS_PER_CATEGORY; i++) {
            data[offset + i] = this.densities[i];
        }
        offset += LODS_PER_CATEGORY;

        // Indices and priority
        data[offset] = this._categoryIndex;
        data[offset + 1] = this.priority;
        data[offset + 2] = geometryIndex;
        data[offset + 3] = 0; // padding
        data[offset + 4] = this.selfOcclusion.gradientWidth;
        data[offset + 5] = this.selfOcclusion.strengthMul;
        data[offset + 6] = this.selfOcclusion.terrainEmbedding;
        data[offset + 7] = this.selfOcclusion.darkening;

        return data;
        
        return data;
    }
}
