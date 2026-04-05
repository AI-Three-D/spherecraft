// js/renderer/streamer/AssetRegistry.js
//
// Central registry for all asset definitions.
// Provides efficient lookup by tile type and category.

import { AssetDefinition } from './AssetDefinition.js';
import { Logger } from '../../../shared/Logger.js';

export class AssetRegistry {
    /**
     * @param {object[]} definitions - Array of raw asset definition objects
     * @param {object} streamerTheme - Theme bundle providing template constants
     */
    constructor(definitions = [], streamerTheme) {
        if (!streamerTheme) {
            throw new Error('AssetRegistry requires streamerTheme');
        }
        this._streamerTheme = streamerTheme;
        this.ASSET_DEF_FLOATS = streamerTheme.ASSET_DEF_FLOATS;
        this.LODS_PER_CATEGORY = streamerTheme.LODS_PER_CATEGORY;

        /** @type {Map<string, AssetDefinition>} */
        this._byId = new Map();

        /** @type {Map<number, AssetDefinition[]>} - tileTypeId → assets */
        this._byTileType = new Map();

        /** @type {Map<string, AssetDefinition[]>} - category → assets */
        this._byCategory = new Map();

        /** @type {Map<string, number>} - geometryType → index */
        this._geometryIndices = new Map();

        /** @type {string[]} - ordered list of unique geometry types */
        this._geometryTypes = [];

        this._maxDensity = 0;
        this._maxDistance = 0;

        for (const def of definitions) {
            this.register(def);
        }

        this._computeAggregates();

        Logger.info(
            `[AssetRegistry] Initialized with ${this._byId.size} assets, ` +
            `${this._geometryTypes.length} geometry types, ` +
            `${this._byTileType.size} tile type mappings`
        );
    }

    /**
     * Register a new asset definition.
     * @param {object|AssetDefinition} def 
     */
    register(def) {
        const asset = def instanceof AssetDefinition ? def : new AssetDefinition(def, this._streamerTheme);

        if (this._byId.has(asset.id)) {
            Logger.warn(`[AssetRegistry] Duplicate asset id: ${asset.id}`);
            return;
        }

        this._byId.set(asset.id, asset);

        // Index by tile type
        for (const tileType of asset.tileTypes) {
            if (!this._byTileType.has(tileType)) {
                this._byTileType.set(tileType, []);
            }
            this._byTileType.get(tileType).push(asset);
        }

        // Index by category
        if (!this._byCategory.has(asset.category)) {
            this._byCategory.set(asset.category, []);
        }
        this._byCategory.get(asset.category).push(asset);

        // Track geometry types
        if (!this._geometryIndices.has(asset.geometryType)) {
            const index = this._geometryTypes.length;
            this._geometryTypes.push(asset.geometryType);
            this._geometryIndices.set(asset.geometryType, index);
        }
    }

    /**
     * Get all assets that can spawn on a given tile type.
     * @param {number} tileTypeId 
     * @returns {AssetDefinition[]}
     */
    getAssetsForTileType(tileTypeId) {
        return this._byTileType.get(tileTypeId) || [];
    }

    /**
     * Get all assets in a category.
     * @param {string} category - 'tree' | 'groundCover' | 'plant'
     * @returns {AssetDefinition[]}
     */
    getAssetsForCategory(category) {
        return this._byCategory.get(category) || [];
    }

    /**
     * Get asset by id.
     * @param {string} id 
     * @returns {AssetDefinition|null}
     */
    getById(id) {
        return this._byId.get(id) || null;
    }

    /**
     * Get all registered assets.
     * @returns {AssetDefinition[]}
     */
    getAllAssets() {
        return Array.from(this._byId.values());
    }

    /**
     * Get the geometry index for a geometry type.
     * @param {string} geometryType 
     * @returns {number}
     */
    getGeometryIndex(geometryType) {
        return this._geometryIndices.get(geometryType) ?? 0;
    }

    /**
     * Get ordered list of geometry types.
     * @returns {string[]}
     */
    getGeometryTypes() {
        return [...this._geometryTypes];
    }

    /**
     * Get number of unique geometry types.
     * @returns {number}
     */
    get geometryTypeCount() {
        return this._geometryTypes.length;
    }

    /**
     * Get maximum density across all assets.
     * @returns {number}
     */
    get maxDensity() {
        return this._maxDensity;
    }

    /**
     * Get maximum render distance across all assets.
     * @returns {number}
     */
    get maxDistance() {
        return this._maxDistance;
    }

    /**
     * Get all unique tile types that have assets.
     * @returns {number[]}
     */
    getMappedTileTypes() {
        return Array.from(this._byTileType.keys());
    }

    /**
     * Select best matching assets for given conditions.
     * Returns assets sorted by fitness (highest first).
     * 
     * @param {number} tileTypeId 
     * @param {number} temperature - Normalized 0-1
     * @param {number} precipitation - Normalized 0-1
     * @param {number} elevation - Normalized 0-1
     * @param {number} slope - Normalized 0-1
     * @param {number} [minFitness=0.1] - Minimum fitness threshold
     * @returns {{asset: AssetDefinition, fitness: number}[]}
     */
    selectAssets(tileTypeId, temperature, precipitation, elevation, slope, minFitness = 0.1) {
        const candidates = this.getAssetsForTileType(tileTypeId);
        const results = [];

        for (const asset of candidates) {
            const fitness = asset.computeFitness(temperature, precipitation, elevation, slope);
            if (fitness >= minFitness) {
                results.push({ asset, fitness: fitness * asset.priority });
            }
        }

        // Sort by fitness descending
        results.sort((a, b) => b.fitness - a.fitness);
        return results;
    }

    /**
     * Build tile type → asset indices mapping for GPU upload.
     * 
     * @param {number} maxAssetsPerTile - Maximum assets to include per tile type
     * @returns {{data: Uint32Array, maxTileType: number}}
     */
    buildTileAssetMap(maxAssetsPerTile = 16) {
        // Find max tile type to size the array
        let maxTileType = 0;
        for (const tileType of this._byTileType.keys()) {
            maxTileType = Math.max(maxTileType, tileType);
        }

        // Each tile type entry: [count, asset0, asset1, ..., assetN-1]
        // Padded to maxAssetsPerTile + 1 per entry
        const entrySize = maxAssetsPerTile + 1;
        const data = new Uint32Array((maxTileType + 1) * entrySize);
        data.fill(0);

        // Build asset index map
        const assetIndices = new Map();
        let idx = 0;
        for (const asset of this._byId.values()) {
            assetIndices.set(asset.id, idx++);
        }

        // Fill mapping
        for (const [tileType, assets] of this._byTileType) {
            const baseOffset = tileType * entrySize;
            const count = Math.min(assets.length, maxAssetsPerTile);
            data[baseOffset] = count;

            for (let i = 0; i < count; i++) {
                data[baseOffset + 1 + i] = assetIndices.get(assets[i].id);
            }
        }

        return { data, maxTileType, entrySize };
    }

    /**
     * Build GPU buffer data for all asset definitions.
     * @returns {Float32Array}
     */
    buildAssetDefBuffer() {
        const assets = this.getAllAssets();
        const floatsPerAsset = this.ASSET_DEF_FLOATS;
        const data = new Float32Array(assets.length * floatsPerAsset);

        for (let i = 0; i < assets.length; i++) {
            const asset = assets[i];
            const geomIndex = this.getGeometryIndex(asset.geometryType);
            const assetData = asset.toGPUData(geomIndex);
            data.set(assetData, i * floatsPerAsset);
        }

        return data;
    }

    _computeAggregates() {
        for (const asset of this._byId.values()) {
            this._maxDensity = Math.max(this._maxDensity, asset.maxDensity);
            this._maxDistance = Math.max(this._maxDistance, asset.maxDistance);
        }
    }

    /**
     * Validate all definitions and report issues.
     * @returns {{valid: boolean, errors: string[], warnings: string[]}}
     */
    validate() {
        const errors = [];
        const warnings = [];

        for (const asset of this._byId.values()) {
            // Check climate ranges
            if (asset.climateRange.temperature[0] > asset.climateRange.temperature[1]) {
                errors.push(`${asset.id}: temperature min > max`);
            }
            if (asset.climateRange.precipitation[0] > asset.climateRange.precipitation[1]) {
                errors.push(`${asset.id}: precipitation min > max`);
            }

            // Check size ranges
            if (asset.sizeRange.width[0] > asset.sizeRange.width[1]) {
                errors.push(`${asset.id}: width min > max`);
            }
            if (asset.sizeRange.height[0] > asset.sizeRange.height[1]) {
                errors.push(`${asset.id}: height min > max`);
            }

            // Check LOD distances are increasing
            if (asset.lodDistances.length !== this.LODS_PER_CATEGORY) {
                warnings.push(`${asset.id}: LOD distance count should be ${this.LODS_PER_CATEGORY}`);
            }
            if (asset.densities.length !== this.LODS_PER_CATEGORY) {
                warnings.push(`${asset.id}: density count should be ${this.LODS_PER_CATEGORY}`);
            }
            for (let i = 1; i < asset.lodDistances.length; i++) {
                if (asset.lodDistances[i] <= asset.lodDistances[i - 1]) {
                    warnings.push(`${asset.id}: LOD distances should be strictly increasing`);
                    break;
                }
            }

            // Check densities are positive
            if (asset.densities.some(d => d < 0)) {
                errors.push(`${asset.id}: densities must be non-negative`);
            }
        }

        // Check for orphan tile types (tiles with no assets)
        // This is just a warning since some tiles might intentionally have no vegetation

        return {
            valid: errors.length === 0,
            errors,
            warnings
        };
    }
}
