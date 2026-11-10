// js/renderer/streamer/AssetSelectionBuffer.js
//
// Manages GPU buffers for asset selection data.
// Uploads asset definitions and tile-to-asset mappings for shader access.

import { Logger } from '../../../shared/Logger.js';

/**
 * GPU buffer layout for asset definitions.
 *
 * Each asset: ASSET_DEF_FLOATS floats
 *   [0-3]:   tempMin, tempMax, precipMin, precipMax
 *   [4-7]:   elevMin, elevMax, slopeMin, slopeMax
 *   [8-11]:  widthMin, widthMax, heightMin, heightMax
 *   [12-15]: baseR, baseG, baseB, tipR
 *   [16-17]: tipG, tipB
 *   [18..]:  lodDistances (LODS_PER_CATEGORY)
 *   [...]:   densities (LODS_PER_CATEGORY)
 *   [...]:   categoryIndex, priority, geometryTypeIndex, _pad
 */

/**
 * GPU buffer layout for tile-to-asset mapping.
 *
 * Each tile type entry: [assetCount, asset0, asset1, ..., assetN, padding...]
 * Fixed size per entry for easy indexing.
 */
const MAX_ASSETS_PER_TILE = 16;
const UINTS_PER_TILE_ENTRY = MAX_ASSETS_PER_TILE + 1;  // count + indices

export class AssetSelectionBuffer {
    /**
     * @param {GPUDevice} device
     * @param {import('./AssetRegistry.js').AssetRegistry} registry
     */
    constructor(device, registry, options = {}) {
        if (!options.streamerTheme) {
            throw new Error('AssetSelectionBuffer requires options.streamerTheme');
        }
        this._streamerTheme = options.streamerTheme;
        this.ASSET_DEF_FLOATS = options.streamerTheme.ASSET_DEF_FLOATS;

        this.device = device;
        this.registry = registry;
        this._tileMapDescriptors = Array.isArray(options.tileMapDescriptors)
            ? options.tileMapDescriptors
            : [];

        this._assetDefBuffer = null;
        this._tileMapBuffer = null;
        this._tileMapBuffers = new Map();
        this._configBuffer = null;

        this._assetCount = 0;
        this._maxTileType = 0;

        this._isUploaded = false;
    }

    /**
     * Upload all buffers to GPU.
     */
    upload() {
        if (this._isUploaded) return;

        this._uploadAssetDefinitions();
        this._uploadTileMappings();
        this._uploadConfig();

        this._isUploaded = true;

        Logger.info(
            `[AssetSelectionBuffer] Uploaded: ` +
            `${this._assetCount} assets, ` +
            `${this._maxTileType + 1} tile type entries`
        );
    }
    _uploadAssetDefinitions() {

        const data = this.registry.buildVariantDefBuffer();
        this._assetCount = this.registry.variantCount;

        const bufferSize = Math.max(256, data.byteLength);
        this._assetDefBuffer = this.device.createBuffer({
            label: 'AssetSelection-Definitions',
            size: bufferSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(this._assetDefBuffer, 0, data);
    }

    _uploadTileMap(key, mapping) {
        const bufferSize = Math.max(256, mapping.data.byteLength);
        const buffer = this.device.createBuffer({
            label: `AssetSelection-TileMap-${key}`,
            size: bufferSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        });
        this.device.queue.writeBuffer(buffer, 0, mapping.data);
        return buffer;
    }

    _uploadTileMappings() {
        const mapping = this.registry.buildTileAssetMap(MAX_ASSETS_PER_TILE);
        this._maxTileType = mapping.maxTileType;
        this._tileMapBuffer = this._uploadTileMap('default', mapping);
        this._tileMapBuffers.set('default', this._tileMapBuffer);

        for (const descriptor of this._tileMapDescriptors) {
            if (!descriptor?.key || typeof descriptor.includeVariant !== 'function') continue;
            const groupMapping = this.registry.buildTileAssetMap(MAX_ASSETS_PER_TILE, {
                includeVariant: descriptor.includeVariant
            });
            this._tileMapBuffers.set(
                descriptor.key,
                this._uploadTileMap(descriptor.key, groupMapping)
            );
        }
    }

    _uploadConfig() {
        // Configuration uniform: asset count, max tile type, max assets per tile, floats per asset
        const data = new Uint32Array([
            this._assetCount,
            this._maxTileType,
            MAX_ASSETS_PER_TILE,
            this.ASSET_DEF_FLOATS
        ]);

        this._configBuffer = this.device.createBuffer({
            label: 'AssetSelection-Config',
            size: 256,  // Padded for uniform buffer alignment
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });
        this.device.queue.writeBuffer(this._configBuffer, 0, data);
    }

    /**
     * Get the asset definitions buffer (storage, read-only in shader).
     * @returns {GPUBuffer|null}
     */
    getAssetDefBuffer() {
        return this._assetDefBuffer;
    }

    /**
     * Get the tile mapping buffer (storage, read-only in shader).
     * @returns {GPUBuffer|null}
     */
    getTileMapBuffer(key = 'default') {
        return this._tileMapBuffers.get(key) ?? null;
    }

    /**
     * Get the config uniform buffer.
     * @returns {GPUBuffer|null}
     */
    getConfigBuffer() {
        return this._configBuffer;
    }

    /**
     * Check if buffers are ready.
     * @returns {boolean}
     */
    isReady() {
        return this._isUploaded && this._assetDefBuffer !== null;
    }

    get assetCount() { return this._assetCount; }
    get maxTileType() { return this._maxTileType; }

    dispose() {
        this._assetDefBuffer?.destroy();
        for (const buffer of this._tileMapBuffers.values()) {
            buffer?.destroy();
        }
        this._configBuffer?.destroy();

        this._assetDefBuffer = null;
        this._tileMapBuffer = null;
        this._tileMapBuffers.clear();
        this._configBuffer = null;

        this._isUploaded = false;
    }
}

/**
 * Build WGSL code for asset selection.
 *
 * @param {object} config
 * @returns {string} WGSL code
 */
export function buildAssetSelectionWGSL(config = {}) {
    if (config.assetDefFloats == null) {
        throw new Error('buildAssetSelectionWGSL requires config.assetDefFloats');
    }
    if (config.lodsPerCategory == null) {
        throw new Error('buildAssetSelectionWGSL requires config.lodsPerCategory');
    }
    const maxAssetsPerTile = MAX_ASSETS_PER_TILE;
    const floatsPerAsset = config.assetDefFloats;
    const LODS_PER_CATEGORY = config.lodsPerCategory;

    return /* wgsl */`
// ═══════════════════════════════════════════════════════════════════════════
// Asset Selection Structures and Functions
// ═══════════════════════════════════════════════════════════════════════════

const MAX_ASSETS_PER_TILE: u32 = ${maxAssetsPerTile}u;
const FLOATS_PER_ASSET: u32 = ${floatsPerAsset}u;
const LODS_PER_CATEGORY: u32 = ${LODS_PER_CATEGORY}u;
const TILE_ENTRY_SIZE: u32 = ${maxAssetsPerTile + 1}u;

struct AssetSelectionConfig {
    assetCount: u32,
    maxTileType: u32,
    maxAssetsPerTile: u32,
    floatsPerAsset: u32,
}

// Asset definition unpacked from buffer
struct AssetDef {
    tempMin: f32,
    tempMax: f32,
    precipMin: f32,
    precipMax: f32,
    elevMin: f32,
    elevMax: f32,
    slopeMin: f32,
    slopeMax: f32,
    widthMin: f32,
    widthMax: f32,
    heightMin: f32,
    heightMax: f32,
    baseColor: vec3<f32>,
    tipColor: vec3<f32>,
    lodDistances: array<f32, LODS_PER_CATEGORY>,
    densities: array<f32, LODS_PER_CATEGORY>,
    archetypeIndex: u32,
    priority: f32,
    placementFamilyIndex: u32,
}

fn loadAssetDef(assetDefs: ptr<storage, array<f32>, read>, index: u32) -> AssetDef {
    var def: AssetDef;
    let base = index * FLOATS_PER_ASSET;

    def.tempMin = assetDefs[base + 0u];
    def.tempMax = assetDefs[base + 1u];
    def.precipMin = assetDefs[base + 2u];
    def.precipMax = assetDefs[base + 3u];

    def.elevMin = assetDefs[base + 4u];
    def.elevMax = assetDefs[base + 5u];
    def.slopeMin = assetDefs[base + 6u];
    def.slopeMax = assetDefs[base + 7u];

    def.widthMin = assetDefs[base + 8u];
    def.widthMax = assetDefs[base + 9u];
    def.heightMin = assetDefs[base + 10u];
    def.heightMax = assetDefs[base + 11u];

    def.baseColor = vec3<f32>(
        assetDefs[base + 12u],
        assetDefs[base + 13u],
        assetDefs[base + 14u]
    );
    def.tipColor = vec3<f32>(
        assetDefs[base + 15u],
        assetDefs[base + 16u],
        assetDefs[base + 17u]
    );

    let lodBase = base + 18u;
    for (var i: u32 = 0u; i < LODS_PER_CATEGORY; i++) {
        def.lodDistances[i] = assetDefs[lodBase + i];
    }
    let densBase = lodBase + LODS_PER_CATEGORY;
    for (var i: u32 = 0u; i < LODS_PER_CATEGORY; i++) {
        def.densities[i] = assetDefs[densBase + i];
    }

    let tail = densBase + LODS_PER_CATEGORY;
    def.archetypeIndex = u32(assetDefs[tail + 0u]);
    def.priority = assetDefs[tail + 1u];
    def.placementFamilyIndex = u32(assetDefs[tail + 2u]);

    return def;
}

fn getTileAssetCount(tileMap: ptr<storage, array<u32>, read>, tileType: u32, maxTileType: u32) -> u32 {
    if (tileType > maxTileType) {
        return 0u;
    }
    let entryBase = tileType * TILE_ENTRY_SIZE;
    return tileMap[entryBase];
}

fn getTileAssetIndex(tileMap: ptr<storage, array<u32>, read>, tileType: u32, idx: u32) -> u32 {
    let entryBase = tileType * TILE_ENTRY_SIZE;
    return tileMap[entryBase + 1u + idx];
}

// Smooth range evaluation with edge falloff
fn evaluateRange(value: f32, minVal: f32, maxVal: f32) -> f32 {
    let rangeSize = maxVal - minVal;
    if (rangeSize <= 0.0) {
        // Point range
        return select(0.0, 1.0, abs(value - minVal) < 0.01);
    }

    let fadeZone = rangeSize * 0.2;
    let innerMin = minVal + fadeZone;
    let innerMax = maxVal - fadeZone;

    if (value < minVal || value > maxVal) {
        return 0.0;
    }
    if (value >= innerMin && value <= innerMax) {
        return 1.0;
    }

    if (value < innerMin) {
        return smoothstep(minVal, innerMin, value);
    } else {
        return 1.0 - smoothstep(innerMax, maxVal, value);
    }
}

// Compute fitness score for an asset given environmental conditions
fn computeAssetFitness(def: AssetDef, temperature: f32, precipitation: f32, elevation: f32, slope: f32) -> f32 {
    let tempFit = evaluateRange(temperature, def.tempMin, def.tempMax);
    let precipFit = evaluateRange(precipitation, def.precipMin, def.precipMax);
    let elevFit = evaluateRange(elevation, def.elevMin, def.elevMax);
    let slopeFit = evaluateRange(slope, def.slopeMin, def.slopeMax);
    
    // Multiplicative: all conditions must be met
    return tempFit * precipFit * elevFit * slopeFit;
}

// Select best matching asset from candidates using weighted random selection
// Returns asset index or 0xFFFFFFFF if none selected
fn selectAsset(
    assetDefs: ptr<storage, array<f32>, read>,
    tileMap: ptr<storage, array<u32>, read>,
    tileType: u32,
    maxTileType: u32,
    temperature: f32,
    precipitation: f32,
    elevation: f32,
    slope: f32,
    randomValue: f32  // 0-1 random for selection
) -> u32 {
    let candidateCount = getTileAssetCount(tileMap, tileType, maxTileType);
    if (candidateCount == 0u) {
        return 0xFFFFFFFFu;
    }

    // Compute fitness for each candidate
    var totalWeight: f32 = 0.0;
    var weights: array<f32, ${maxAssetsPerTile}>;
    var indices: array<u32, ${maxAssetsPerTile}>;
    var validCount: u32 = 0u;

    for (var i: u32 = 0u; i < candidateCount && i < MAX_ASSETS_PER_TILE; i++) {
        let assetIdx = getTileAssetIndex(tileMap, tileType, i);
        let def = loadAssetDef(assetDefs, assetIdx);
        let fitness = computeAssetFitness(def, temperature, precipitation, elevation, slope);

        if (fitness > 0.05) {  // Minimum fitness threshold
            let weight = fitness * def.priority;
            weights[validCount] = weight;
            indices[validCount] = assetIdx;
            totalWeight += weight;
            validCount++;
        }
    }

    if (validCount == 0u || totalWeight <= 0.0) {
        return 0xFFFFFFFFu;
    }

    // Weighted random selection
    let weightTarget = randomValue * totalWeight;
    var accumulated: f32 = 0.0;

    for (var i: u32 = 0u; i < validCount; i++) {
        accumulated += weights[i];
        if (accumulated >= weightTarget) {
            return indices[i];
        }
    }

    // Fallback to last valid
    return indices[validCount - 1u];
}

// Get LOD level and density for selected asset at given distance
struct AssetLODInfo {
    lodLevel: u32,      // 0..LODS_PER_CATEGORY-1, or 0xFFFFFFFF if out of range
    density: f32,
    bandIndex: u32,     // category * LODS_PER_CATEGORY + lodLevel
}

fn getAssetLODInfo(def: AssetDef, distance: f32) -> AssetLODInfo {
    var info: AssetLODInfo;
    info.lodLevel = 0xFFFFFFFFu;
    info.density = 0.0;
    info.bandIndex = 0xFFFFFFFFu;

    for (var i: u32 = 0u; i < LODS_PER_CATEGORY; i++) {
        if (distance < def.lodDistances[i]) {
            info.lodLevel = i;
            info.density = def.densities[i];
            info.bandIndex = def.archetypeIndex * LODS_PER_CATEGORY + info.lodLevel;
            return info;
        }
    }

    return info;
}
`;
}
