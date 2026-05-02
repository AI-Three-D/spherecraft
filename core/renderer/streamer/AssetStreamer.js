// js/renderer/streamer/AssetStreamer.js
//
// Main orchestrator for the modular GPU-scattered asset streaming system.
// Replaces GrassRenderer with a multi-category (trees, ground cover, plants)
// system that supports per-category LOD zones and tile-type-driven placement.
//
// Lifecycle:
//   1. initialize() — create pool, compile pipelines, build geometries
//   2. Each frame:
//      a. update(commandEncoder, camera) — scatter compute + indirect build
//      b. render(camera, viewMatrix, projectionMatrix) — TOTAL_BANDS indirect indexed draws
//   3. dispose()
//
// Integration pattern (in frontend):
//   backend.endRenderPassForCompute();
//   assetStreamer.update(encoder, camera);
//   backend.resumeRenderPass();
//   assetStreamer.render(camera, viewMatrix, projectionMatrix);
import { buildFarTreeBakeShader } from './shaders/farTreeBake.wgsl.js';
import { FarTreeSourceCache } from './FarTreeSourceCache.js';
import { TreeMidSystem } from './TreeMidSystem.js';
import { ClusterTreeSystem } from './ClusterTreeSystem.js';
import { LeafMaskBaker } from './LeafMaskBaker.js';
import { Logger } from '../../../shared/Logger.js';
import { AssetInstancePool } from './AssetInstancePool.js';
import { ArchetypeRegistry } from './archetype/ArchetypeRegistry.js';
import { AssetSelectionBuffer } from './AssetSelectionBuffer.js';
import { buildGroundPropBakeShader } from './shaders/groundPropBake.wgsl.js';
import { buildGroundPropGatherShader } from './shaders/groundPropGather.wgsl.js';
import { buildTreeSourceBakeShader } from './shaders/treeSourceBake.wgsl.js';
import { buildTreeSourceGatherShader } from './shaders/treeSourceGather.wgsl.js';
import { buildAssetScatterGroupMaskBakeShader } from './shaders/assetScatterGroupMaskBake.wgsl.js';
import { buildAssetIndirectShader } from './shaders/assetIndirectBuilder.wgsl.js';
import { buildAssetVertexShader } from './shaders/assetVertex.wgsl.js';
import { buildAssetFragmentShader } from './shaders/assetFragment.wgsl.js';
import { LeafStreamer } from './LeafStreamer.js';
import { TreeDetailSystem } from './TreeDetailSystem.js';
import { TreeTemplateLibrary } from './TreeTemplateLibrary.js';
import { TreeTrunkGeometryBuilder } from './TreeTrunkGeometryBuilder.js';
import { BranchRenderer } from './BranchRenderer.js';
import { TreeLODController } from './TreeLODController.js';
import { TreeMidNearSystem } from './TreeMidNearSystem.js';
import { GeometryFactory } from './archetype/GeometryFactory.js';
import { PlacementDensityBuffer } from './archetype/PlacementDensityBuffer.js';
import { AssetBakePolicy, ASSET_BAKE_REPRESENTATION } from './baking/AssetBakePolicy.js';
import { BakedAssetTileCache } from './baking/BakedAssetTileCache.js';
import { GroundFieldBaker } from './GroundFieldBaker.js';
import { GroundPropCache } from './GroundPropCache.js';
import { TreeSourceCache } from './TreeSourceCache.js';
import { gpuFormatSampleType } from '../resources/texture.js';
import { TerrainAOBaker } from './TerrainAOBaker.js';
import { TreeFarSystem } from './TreeFarSystem.js';
import { installAssetStreamerBindGroupMethods } from './assetStreamer/AssetStreamerBindGroupMethods.js';
import { installAssetStreamerDebugMethods } from './assetStreamer/AssetStreamerDebugMethods.js';
import { installAssetStreamerRenderMethods } from './assetStreamer/AssetStreamerRenderMethods.js';
import { installAssetStreamerScatterMethods } from './assetStreamer/AssetStreamerScatterMethods.js';

// Set to true to enable far-tier diagnostic logging in AssetStreamer.
const FAR_TREE_DBG_ENABLED = false;
const farDbgAs = (msg) => { if (FAR_TREE_DBG_ENABLED) Logger.warn(`[TreeFarSystem] ${msg}`); };

const FIELD_LAYER_META_U32_STRIDE = 8;

function applyResolvedTreeAssetConfig(definitions, treeConfig) {
    const treeLodDistances = treeConfig?._derived?.treeAssetLodDistances;
    const treeDensities = treeConfig?._derived?.treeAssetDensities;

    if (!Array.isArray(definitions) || !Array.isArray(treeLodDistances) || !Array.isArray(treeDensities)) {
        return definitions;
    }

    return definitions.map((def) => {
        if (!def || def.category !== 'tree') return def;
        return {
            ...def,
            lodDistances: [...treeLodDistances],
            densities: [...treeDensities],
        };
    });
}

export class AssetStreamer {
    /**
     * @param {object} options
     * @param {GPUDevice}  options.device
     * @param {object}     options.backend
     * @param {object}     options.quadtreeGPU
     * @param {object}     options.tileStreamer
     * @param {object}     options.planetConfig
     * @param {object}     options.engineConfig
     * @param {object}     options.uniformManager
     * @param {string}     [options.quality='medium']
     */
    constructor(options = {}) {
        if (!options.streamerTheme) {
            throw new Error('AssetStreamer requires options.streamerTheme');
        }
        this._streamerTheme = options.streamerTheme;
        this.validateTierRanges = options.streamerTheme.validateTierRanges;
        this.TEXTURE_LAYER_MAPPING = options.streamerTheme.TEXTURE_LAYER_MAPPING;
        this.ARCHETYPE_DEFINITIONS = options.streamerTheme.ARCHETYPE_DEFINITIONS;
        this.DEFAULT_ASSET_DEFINITIONS = options.streamerTheme.DEFAULT_ASSET_DEFINITIONS;
        this.getSpeciesRegistry = options.streamerTheme.getSpeciesRegistry;
        this.ASSET_SELF_OCCLUSION = options.streamerTheme.ASSET_SELF_OCCLUSION;
        this.ENABLE_SCATTER_DENSITY_GROUPS = options.streamerTheme.ENABLE_SCATTER_DENSITY_GROUPS;
        this.ENABLE_SCATTER_ELIGIBILITY_GATE = options.streamerTheme.ENABLE_SCATTER_ELIGIBILITY_GATE;
        this.LODS_PER_CATEGORY = options.streamerTheme.LODS_PER_CATEGORY;
        this.ASSET_DEF_FLOATS = options.streamerTheme.ASSET_DEF_FLOATS;
        this.QUALITY_PRESETS = options.streamerTheme.QUALITY_PRESETS;
        this.SCATTER_DENSITY_GROUPS = options.streamerTheme.SCATTER_DENSITY_GROUPS;
        this.SCATTER_POLICY_GROUPS = options.streamerTheme.SCATTER_POLICY_GROUPS;
        this.CAT_TREES = options.streamerTheme.CAT_TREES;
        this.TREE_VISIBILITY = options.streamerTheme.TREE_VISIBILITY;
        this.TREE_FADE_START_RATIO = options.streamerTheme.TREE_FADE_START_RATIO;
        this.TREE_FADE_END_RATIO = options.streamerTheme.TREE_FADE_END_RATIO;
        this.TREE_BILLBOARD_LOD_START = options.streamerTheme.TREE_BILLBOARD_LOD_START;
        this.TREE_BILLBOARD_LOD_END = options.streamerTheme.TREE_BILLBOARD_LOD_END;
        this.TREE_DENSITY_SCALE = options.streamerTheme.TREE_DENSITY_SCALE;
        this.TREE_CELL_SIZE = options.streamerTheme.TREE_CELL_SIZE;
        this.TREE_MAX_PER_CELL = options.streamerTheme.TREE_MAX_PER_CELL;
        this.TREE_CLUSTER_PROBABILITY = options.streamerTheme.TREE_CLUSTER_PROBABILITY;
        this.TREE_JITTER_SCALE = options.streamerTheme.TREE_JITTER_SCALE;
        this.TERRAIN_AO_CONFIG = options.streamerTheme.TERRAIN_AO_CONFIG;
        this.GROUND_FIELD_BAKE_CONFIG = options.streamerTheme.GROUND_FIELD_BAKE_CONFIG;
        this.GROUND_PROP_BAKE_CONFIG = options.streamerTheme.GROUND_PROP_BAKE_CONFIG;
        this.TREE_SOURCE_BAKE_CONFIG = options.streamerTheme.TREE_SOURCE_BAKE_CONFIG;
        this._treeConfig = this.engineConfig?.trees || {};
        this._treeMidNearSystem = null;
        this._aoBaker = null;
        this._groundFieldBaker = null;
        this._groundPropCache = null;
        this._treeSourceCache = null;
        this._farTreeSourceCache = null;

        this._clusterTreeSystem = null;
        this._templateLibrary = null;
        this._branchRenderer = null;
        this._assetBakePolicy = null;
        this._bakedAssetTileCache = null;
        this.device = options.device;
        this.backend = options.backend;
        this.quadtreeGPU = options.quadtreeGPU;
        this.tileStreamer = options.tileStreamer;
        this.planetConfig = options.planetConfig;
        this.engineConfig = options.engineConfig;
        this._leafStreamer = null;

        this._leafMaskBaker = null;
        this._quality = options.quality || 'medium';
        this._qualityConfig = this.QUALITY_PRESETS[this._quality] || this.QUALITY_PRESETS.medium;

        this._treeConfig = this.engineConfig?.trees || {};
const tc       = this._treeConfig;
const tcFlags  = tc.flags    || {};
const tcNear   = tc.nearTier || {};

const featureFlags = options.engineConfig?.features || {};
this._enableNearTier    = featureFlags.treesNear    ?? true;
this._useMidTier        = (featureFlags.treesMid    ?? true) && (tcFlags.useMidTier        ?? true);
this._keepLegacyMidNear = tcFlags.keepLegacyMidNear ?? false;

this._useFarTierClone   = (featureFlags.treesFar    ?? true) && (tcFlags.useFarTierClone   ?? true);
this._useClusterFarTier = tcFlags.useClusterFarTier ?? false;

this.enableLeafRendering =
    this._enableNearTier && (tcFlags.enableLeafRendering ?? (options.enableLeafRendering !== false));

// Still honour explicit constructor override for debug tooling,
// but primary source is engineConfig.
const leafBandsFromOptions = (() => {
    const rawBands = options.treeDetailBands;
    if (Array.isArray(rawBands)) {
        if (rawBands.length > 0 && typeof rawBands[0] === 'object') return rawBands;
        return rawBands.map((end, i, ends) => ({
            start: i === 0 ? 0 : ends[i - 1] * 0.85,
            end,
        }));
    }
    return undefined;
})();

this._lodController = new TreeLODController({
    leafBands:            leafBandsFromOptions ?? tcNear.leafBands,
    maxCloseTrees:        options.maxCloseTrees ?? tcNear.maxCloseTrees,
    maxBranchDetailLevel: options.maxBranchDetailLevel ?? tcNear.maxBranchDetailLevel,
    branchGeometryLOD:    options.branchGeometryLOD ?? tcNear.branchGeometryLOD,
    branchTrunkRadialSegments:  options.branchTrunkRadialSegments ?? tcNear.branchTrunkRadialSegments,
    branchBranchRadialSegments: options.branchBranchRadialSegments ?? tcNear.branchBranchRadialSegments,
    maxTotalLeaves:       options.maxTotalLeaves ?? tcNear.maxTotalLeaves,
    branchLODBands:       tcNear.branchLODBands,
    branchFadeMargin:     tcNear.branchFadeMargin,
    birch:                tcNear.birch,
    leafCounts:           tcNear.leafCounts,
    leafSizeScale:        tcNear.leafSizeScale,
    leafBandBudgetFractions: tcNear.leafBandBudgetFractions,
    leafFadeStartRatio:   tcNear.leafFadeStartRatio,
});

        Object.defineProperty(this, 'treeDetailBands', {
            get: () => this._lodController.getLegacyBands(),
            configurable: true,
        });

        this._debugConfig = options.debug || {};
        this._debugReadbackEnabled = this._debugConfig.readback === true;
        this._treeMidSystem = null;
        this._treeFarSystem = null;
        // ═══ INC 1: ArchetypeRegistry replaces AssetRegistry ═══════════════
        // ArchetypeRegistry EXTENDS AssetRegistry and passes legacy defs to
        // super(). Every downstream consumer (AssetSelectionBuffer,
        // TreeDetailSystem, BranchRenderer, TreeMidNearSystem, and this
        // class's own _verifyTreeBandAlignment / _getActiveTreeTypes /
        // _createRenderPipeline / _updateScatterParams) sees the same
        // AssetDefinition objects via inherited getAllAssets() /
        // maxDensity / maxDistance / buildAssetDefBuffer / buildTileAssetMap.
        //
        // The new archetype/family/variant model is built alongside,
        // validated (throws if tree_standard ≠ index 0 or variant 0 ≠ tree),
        // and queryable via getAllArchetypes() / getAllVariants() — but
        // nothing in the render path reads it until Increment 2.
        this._assetDefinitions = applyResolvedTreeAssetConfig(
            options.assetDefinitions || this.DEFAULT_ASSET_DEFINITIONS,
            this._treeConfig
        );
        this._clusterTreeTileMetadata = options.clusterTreeTileMetadata ?? null;
        this._assetRegistry = new ArchetypeRegistry(                    // ◄── INC 1
            this._assetDefinitions,
            options.archetypeDefinitions || this.ARCHETYPE_DEFINITIONS,        // ◄── INC 1
            this._streamerTheme
        );
        this._assetSelectionBuffer = null;

        this._treeDetailSystem = null;
        this._speciesRegistry = null;


        this._pool = null;
        this._geometries = [];           // [band] => { positionBuffer, normalBuffer, uvBuffer, indexBuffer, indexCount }
        this._lodIndexCounts = [];       // [band] => indexCount

        // ── Scatter pipeline ──────────────────────────────────────────────
        this._scatterPipelines = [];
        this._scatterBindGroupLayout = null;
        this._scatterBindGroupCache = {
            heightTex: null,
            tileTex: null,
            normalTex: null,
            scatterTex: null,
            bindGroups: new Map(),
        };
        this._fieldScatterPipelines = [];
        this._fieldScatterBindGroupLayout = null;
        this._fieldScatterBindGroupCache = {
            heightTex: null,
            tileTex: null,
            normalTex: null,
            climateTex: null,
            fieldTex: null,
            bindGroups: new Map(),
        };
        this._groundPropBakePipeline = null;
        this._groundPropBakeBindGroupLayout = null;
        this._groundPropBakeBindGroup = null;
        this._groundPropBakeParamBuffer = null;
        this._groundPropBakeTileBuffer = null;
        this._groundPropBakeBindGroupCache = {
            heightTex: null,
            tileTex: null,
            normalTex: null,
            climateTex: null,
            instanceBuffer: null,
            bindGroup: null,
        };
        this._groundPropGatherPipeline = null;
        this._groundPropGatherBindGroupLayout = null;
        this._groundPropGatherBindGroup = null;
        this._groundPropGatherBindGroupCache = {
            instanceBuffer: null,
            activeLayerBuffer: null,
            layerMetaBuffer: null,
            counterBuffer: null,
            bindGroup: null,
        };
        this._treeSourceBakePipeline = null;
        this._treeSourceBakeBindGroupLayout = null;
        this._treeSourceBakeBindGroup = null;
        this._treeSourceBakeParamBuffer = null;
        this._treeSourceBakeTileBuffer = null;
        this._treeSourceBakeBindGroupCache = {
            heightTex: null,
            tileTex: null,
            scatterTex: null,
            instanceBuffer: null,
            bindGroup: null,
        };
        this._treeSourceGatherPipeline = null;
        this._treeSourceGatherBindGroupLayout = null;
        this._treeSourceGatherBindGroup = null;
        this._treeSourceGatherBindGroupCache = {
            instanceBuffer: null,
            activeLayerBuffer: null,
            layerMetaBuffer: null,
            counterBuffer: null,
            bindGroup: null,
        };
        this._farTreeBakePipeline = null;
        this._farTreeBakeBindGroupLayout = null;
        this._farTreeBakeBindGroup = null;
        this._farTreeBakeParamBuffer = null;
        this._farTreeBakeTileBuffer = null;
        this._farTreeBakeBindGroupCache = {
            heightTex: null,
            tileTex: null,
            scatterTex: null,
            instanceBuffer: null,
            bindGroup: null,
        };
        this._producerDebugEnabled = true;
        this._producerDebugInterval = Math.max(1, this._debugConfig.interval ?? 120);
        this._producerDebugQueued = false;
        this._producerDebugPending = false;
        this._producerDebugHasGroundPropSnapshot = false;
        this._producerDebugPoolReadbackBuffer = null;
        this._producerDebugGroundPropReadbackBuffer = null;
        this._producerTextureProbePending = false;
        this._groundPropTileMapKey = 'baked-ground-props';
        this._fieldArchetypeIndexSet = new Set();
        this._scatterGroups = [];
        this._deferredScatterCommits = [];
        this._scatterGroupMaskBakePipeline = null;
        this._scatterGroupMaskBakeBindGroupLayout = null;
        this._scatterGroupMaskBakeBindGroup = null;
        this._scatterGroupMaskBakeBindGroupCache = { tileTex: null, bindGroup: null };
        this._scatterGroupMaskBuffer = null;
        this._scatterGroupPolicyMaskBuffer = null;
        this._scatterGroupPolicyMasksCPU = null;
        this._scatterGroupDefaultMask = 0xFFFFFFFF;
        this._scatterGroupActiveBits = 0;
        this._scatterGroupActivityDirty = true;
        this._fieldRenderMaskBuffer = null;
        this._fieldRenderMasksCPU = null;
        this._fieldActiveBits = 0;
        this._fieldActivityDirty = true;
        this._fieldActiveLayersCPU = null;
        this._fieldLayerMetaCPU = null;
        this._fieldActiveLayerBuffer = null;
        this._fieldLayerMetaBuffer = null;
        this._fieldActiveLayerCount = 0;
        this._scatterGroupMaskBakeConfigBuffer = null;
        this._scatterGroupPendingLayersBuffer = null;
        this._scatterGroupPendingLayers = new Set();
        this._tileTypeScatterGroupMaskBuffer = null;
        this._scatterTreeTileMapKey = 'tree';
        this._enableScatterDensityGroups = this.ENABLE_SCATTER_DENSITY_GROUPS === true;
        this._enableScatterEligibilityGate = this.ENABLE_SCATTER_ELIGIBILITY_GATE !== false;
        this._scatterGroundEligibilityBit = 0;

        // ── Indirect-args builder pipeline ────────────────────────────────
        this._indirectPipeline = null;
        this._indirectBindGroupLayout = null;
        this._indirectBindGroup = null;
        this._indirectBindGroupBuilt = false;

        // ── Render pipelines (shadow / no-shadow) ────────────────────────
        this._renderPipeline = null;
        this._renderPipelineNoShadow = null;
        this._shadowBandThreshold = 2;
        this._renderBindGroupLayouts = [];
        this._noShadowBindGroupLayouts = [];
        this._renderBindGroups = [];
        this._noShadowBindGroups = [];
        this._renderBindGroupsBuilt = false;

        // ── Uniform / param buffers ───────────────────────────────────────
        this._uniformBuffer = null;
        this._fragUniformBuffer = null;
        this._scatterParamBuffer = null;
        this._climateUniformBuffer = null;
        this._lodIndexCountBuffer = null;
        this._loadedTableParamsBuffer = null;

        this._initialized = false;
        this._frameCount = 0;
        this._lastScatterFrame = -1;
        this._lastScatterPosition = null;
        this._lastScatterDirection = null;
        this._forceScatter = true;
        // Transitional mode: tree visuals are handled by tree sub-pipelines
        // (detail now, mid/far later). Skip all scatter-tree draw bands.
        this._suppressAllTreeScatter = true;

        this._logTag = '[ASSET STREAMER]';
        this.uniformManager = options.uniformManager;
        this.propTextureManager = options.propTextureManager || null;  // NEW — plumbing for prop textures
        this.leafAlbedoTextureManager = options.leafAlbedoTextureManager || null;
        this.leafNormalTextureManager = options.leafNormalTextureManager || null;

    }
    async initialize() {
        if (this._initialized) return;

        // ═══ INC 2: band layout computed from archetypes + quality budget ══
        // bandDescriptors drives the pool AND the render loop AND shader
        // constants. Stored on `this` so render() can iterate it without
        // re-querying the registry.
        this._bandDescriptors = this._assetRegistry.computeBandDescriptors(
            this._qualityConfig.maxInstances
        );
        this._totalBands = this._bandDescriptors.length;
        this._archetypeFlags = this._assetRegistry.getShaderFlagsArray();

        // Preallocated zero buffer for clearing indirect args when bind
        // groups aren't ready yet (early frames).
        this._indirectZeros = new Uint32Array(this._totalBands * 5);

        this._pool = new AssetInstancePool(this.device, this._bandDescriptors);

        this._createUniformBuffers();
        this._scatterGroups = (this._enableScatterDensityGroups || this._enableScatterEligibilityGate)
            ? this._buildScatterGroups()
            : [];
        this._fieldArchetypeIndexSet = new Set(
            this._scatterGroups
                .filter(group => group.mode === 'field')
                .map(group => group.fieldArchetypeIndex)
                .filter(index => Number.isInteger(index) && index >= 0)
        );
        this._scatterGroundEligibilityBit = this._scatterGroups.reduce(
            (mask, group) => (mask | group.bit),
            0
        );
        this._assetSelectionBuffer = new AssetSelectionBuffer(this.device, this._assetRegistry, {
            tileMapDescriptors: this._buildScatterTileMapDescriptors(),
            streamerTheme: this._streamerTheme,
        });
        if (this.propTextureManager?.isReady()) {
            this._assetRegistry.assignTextureLayerIndices(
                this.propTextureManager,
                this.TEXTURE_LAYER_MAPPING
            );
        } else {
            Logger.warn(
                '[AssetStreamer] propTextureManager not ready during initialize — ' +
                'props will fall back to vertex colour'
            );
        }
        this._assetSelectionBuffer.upload();
        this._densityLutTileCount = this._assetSelectionBuffer.maxTileType + 1;
        this._densityLUT = new PlacementDensityBuffer(
            this.device,
            this._assetRegistry.getAllFamilies(),
            this._densityLutTileCount,
        );
        this._densityLUT.upload();
        this._assetBakePolicy = new AssetBakePolicy({
            assetRegistry: this._assetRegistry,
            engineConfig: this.engineConfig,
            quadtreeGPU: this.quadtreeGPU,
            planetConfig: this.planetConfig,
        });
        this._bakedAssetTileCache = new BakedAssetTileCache(this._assetBakePolicy);
        this._bakedAssetTileCache.syncFromTileStreamer(this.tileStreamer);

        if (this._useFarTierClone) {
            console.log("Initializing FarTreeSourceCache (clone-based far tier)");
            this._farTreeSourceCache = new FarTreeSourceCache(this.device, {
                assetRegistry: this._assetRegistry,
                tilePoolSize: this.tileStreamer.tilePoolSize,
                farTreeConfig: this.engineConfig?.trees?.farTreeTier?.bake,
            });
            this._farTreeSourceCache.initialize(this._bakedAssetTileCache);
        }

        if (this.GROUND_PROP_BAKE_CONFIG.enabled) {
            this._groundPropCache = new GroundPropCache(this.device, {
                assetRegistry: this._assetRegistry,
                tilePoolSize: this.tileStreamer.tilePoolSize,
                fieldArchetypeIndices: this._fieldArchetypeIndexSet,
                propConfig: this.engineConfig?.groundPropBake,
                streamerTheme: this._streamerTheme,
            });
            this._groundPropCache.initialize(this._bakedAssetTileCache);
        }
        if (this.TREE_SOURCE_BAKE_CONFIG.enabled) {
            this._treeSourceCache = new TreeSourceCache(this.device, {
                assetRegistry: this._assetRegistry,
                tilePoolSize: this.tileStreamer.tilePoolSize,
                treeConfig: this.engineConfig?.trees?.sourceBake,
                streamerTheme: this._streamerTheme,
            });
            this._treeSourceCache.initialize(this._bakedAssetTileCache);
        }
        if (this._useClusterFarTier && (this._treeConfig?.farTreeTier || this._treeConfig?.clusterTier)) {
            this._clusterTreeSystem = new ClusterTreeSystem(this.device, this, {
                treeConfig: this._treeConfig,
                clusterTreeTileMetadata: this._clusterTreeTileMetadata,
            });
            await this._clusterTreeSystem.initialize(this._bakedAssetTileCache);
        }
        this._createScatterGroupMaskResources();
        this._seedScatterGroupPolicyMasks();
        if (this._usesLegacyScatterPath() && this._enableScatterEligibilityGate) {
            this._seedScatterGroupPendingLayers();
        }

        // ═══ Template library (before geometry building) ═══════════════════
        this._speciesRegistry = this.getSpeciesRegistry();
        this._templateLibrary = new TreeTemplateLibrary({
            variantsPerType: 4,
            baseSeed: this.engineConfig.seed ?? 12345,
            birchGenerator: this._streamerTheme.BirchBranchGenerator,
        });
        const treeTypes = this._getActiveTreeTypes();
        this._templateLibrary.generateTemplates(treeTypes);
        this._templateLibrary.uploadToGPU(this.device);

        this._buildGeometries();

        this._createScatterPipelines();
        this._createFieldScatterPipelines();
        this._createGroundPropPipelines();
        this._createTreeSourcePipelines();
        this._createIndirectPipeline();
        if (this._scatterPipelines.length > 0) {
            this._createScatterDispatchPipeline();
        }
        this._createRenderPipeline();

        this._createFarTreeBakePipeline();
        // ═══ Terrain AO baker ═══════════════════════════════════════════════
        if (this.TERRAIN_AO_CONFIG.enabled) {
            const maxWS   = this._qualityConfig.maxScatterTileWorldSize ?? 48;
            const maxDens = this._assetRegistry?.maxDensity ?? 0.000001;
            const over    = Math.max(1, this._qualityConfig.scatterCellOversample ?? 1);
            const baseRes = Math.max(1, Math.ceil(Math.sqrt(maxDens * maxWS * maxWS)));
            const gridRes = baseRes * over;
            const gcCellM = maxWS / gridRes;
            const faceSize = Number.isFinite(this.quadtreeGPU?.faceSize)
                ? this.quadtreeGPU.faceSize
                : (this.planetConfig.radius * 2);

            this._aoBaker = new TerrainAOBaker(this.device, {
                tilePoolSize:    this.tileStreamer.tilePoolSize,
                planetConfig:    this.planetConfig,
                faceSize,
                seed:            this.engineConfig.seed,
                gcCellWorldSize: gcCellM,
                tileLayerLookup: (face, depth, x, y) =>
                    this.tileStreamer?.getLoadedLayer?.(face, depth, x, y) ?? null,
                textureFormats:  this.tileStreamer?.textureFormats,
                aoConfig:        this.engineConfig?.terrainAO,
                logDispatches:   this.TERRAIN_AO_CONFIG.logDispatches !== true ? false : true,
                streamerTheme:   this._streamerTheme,
            });
            this._aoBaker.initialize();
            if (this._aoBaker.enabled) {
                this.tileStreamer.setExternalArrayTexture(
                    'terrainAO', this._aoBaker.getAOTextureWrapper()
                );
                const loaded = this.tileStreamer.getLoadedTiles?.() || [];
                for (const t of loaded) {
                    this._aoBaker.enqueueBake(t.face, t.depth, t.x, t.y, t.layer);
                }
            }
        }

        // eslint-disable-next-line no-constant-condition
        if (false) { //this.GROUND_FIELD_BAKE_CONFIG.enabled) {
            this._groundFieldBaker = new GroundFieldBaker(this.device, {
                assetRegistry: this._assetRegistry,
                tilePoolSize: this.tileStreamer.tilePoolSize,
                tileTypeCount: this._densityLutTileCount,
                textureFormats: this.tileStreamer?.textureFormats,
                seed: this.engineConfig.seed,
                fieldConfig: this.engineConfig?.groundFieldBake,
                logDispatches: this.GROUND_FIELD_BAKE_CONFIG.logDispatches !== true ? false : true,
                streamerTheme: this._streamerTheme,
            });
            this._groundFieldBaker.initialize();
            if (this._groundFieldBaker.enabled) {
                this._seedScatterGroupPolicyMasks();
                this.tileStreamer.setExternalArrayTexture(
                    'groundField', this._groundFieldBaker.getFieldTextureWrapper()
                );
                this._seedGroundFieldBakes();
            }
        }

        // ═══ Tree sub-systems — unchanged; they read pool bands 0-4 ═════════
        const tcNear  = this._treeConfig.nearTier || {};
        const tcFlags = this._treeConfig.flags    || {};

        if (this._enableNearTier) {
            this._treeDetailSystem = new TreeDetailSystem(this.device, this, {
                lodController:    this._lodController,
                maxTotalLeaves:   tcNear.maxTotalLeaves   ?? 600000,
                maxTotalClusters: tcNear.maxTotalClusters ?? 50000,
                debugReadback:    this._debugReadbackEnabled,
            });
            await this._treeDetailSystem.initialize();
            this._leafMaskBaker = new LeafMaskBaker(this.device);
            await this._leafMaskBaker.initialize();
        } else {
            Logger.info(`${this._logTag} Near tier disabled by features.treesNear`);
        }



// ═══ Tree mid-tier systems ═══════════════════════════════════════════
const tierRanges = this._treeConfig.tierRanges || {};
const tierWarnings = this.validateTierRanges(
    this._lodController.detailRange,
    tierRanges                                   // ← now takes ranges as arg
);
for (const w of tierWarnings) Logger.warn(`${this._logTag} ${w}`);

// Legacy mid-near: built but only active when flag is set
this._treeMidNearSystem = new TreeMidNearSystem(this.device, this, {
    lodController: this._lodController,
});


// New hull-only mid tier
if (this._useMidTier) {                          // ← was TREE_TIER_FLAGS.useMidTier
    this._treeMidSystem = new TreeMidSystem(this.device, this, {
        lodController: this._lodController,
        tierRange:     tierRanges.mid,           // ← NEW: pass range config
        midConfig:     this._treeConfig.midTier, // ← NEW: pass hull/trunk config
        speciesProfiles: this._treeConfig.speciesProfiles,
    });
    await this._treeMidSystem.initialize();
}

if (this._useFarTierClone) {
    const farTierCloneConfig = {
        ...(this._treeConfig.midTier || {}),
        maxTrees: this._treeConfig?.farTreeTier?.maxInstances
            ?? this._treeConfig?.midTier?.maxTrees
            ?? 24000,
    };

    this._treeFarSystem = new TreeFarSystem(this.device, this, {
        lodController: this._lodController,
        tierRange: tierRanges.farTrees,
        midConfig: farTierCloneConfig,
        speciesProfiles: this._treeConfig.speciesProfiles,
    });
    farDbgAs(
        `TreeFarSystem constructed — ` +
        `farTierCloneConfig=${JSON.stringify({ maxTrees: farTierCloneConfig.maxTrees })} ` +
        `tierRanges.farTrees=${JSON.stringify(tierRanges.farTrees)} ` +
        `_farTreeSourceCache=${!!this._farTreeSourceCache} ` +
        `_farTreeSourceCache.enabled=${this._farTreeSourceCache?.enabled} ` +
        `_farTreeSourceCache.initialized=${this._farTreeSourceCache?._initialized} ` +
        `_farTreeBakePipeline=${!!this._farTreeBakePipeline}`
    );
    await this._treeFarSystem.initialize();
    farDbgAs(
        `TreeFarSystem.initialize() done — ` +
        `treeFarSystem.isReady=${this._treeFarSystem?.isReady?.()}`
    );
}

if (this._enableNearTier) {
    this._branchRenderer = new BranchRenderer(this.device, this, {
        lodController:      this._lodController,
        enableBranchWind:   tcFlags.enableBranchWind ?? false,
        propTextureManager: this.propTextureManager,
    });
    await this._branchRenderer.initialize(this._templateLibrary);

    this._leafStreamer = new LeafStreamer(this.device, this, {
        lodController:            this._lodController,
        leafMaskBaker:            this._leafMaskBaker,
        leafAlbedoTextureManager: this.leafAlbedoTextureManager,
        leafNormalTextureManager: this.leafNormalTextureManager,
        enableLeafAlbedoTexture:  true,
        enableLeafNormalTexture:  true,
        birchTemplateStart: this._templateLibrary?.getTypeStartIndex('birch') ?? 0xFFFFFFFF,
        birchTemplateCount: this._templateLibrary?.getVariants('birch')?.length ?? 0,
        enableLeafWind: tcFlags.enableLeafWind ?? false,
    });
    await this._leafStreamer.initialize();
}

        this._initialized = true;
        Logger.info(
            `${this._logTag} Scatter groups: ` +
            (this._enableScatterDensityGroups
                ? this._scatterGroups.map(group =>
                    `${group.name}[variants=${group.variantIndices.length}, maxDensity=${group.maxDensity.toFixed(3)}]`
                ).join(', ')
                : `disabled (single ground pass, eligibility gate=${this._enableScatterEligibilityGate ? 'on' : 'off'})`)
        );
        Logger.info(
            `${this._logTag} Initialized ` +
            `(quality=${this._quality}, bands=${this._totalBands}, ` +
            `archetypes=${this._assetRegistry.archetypeCount}, ` +
            `detailBands=[${this._lodController.detailBands.join('/')}]m` +
            `${this._aoBaker?.enabled ? `, AO=${this.TERRAIN_AO_CONFIG.resolution}px` : ''}` +
            `${this._groundFieldBaker?.enabled ? `, field=${this._groundFieldBaker.resolution}px` : ''})`
        );
        Logger.info(`${this._logTag} Legacy climate scatter disabled; using baked field/prop/tree sources`);
        this._bakedAssetTileCache?.logSummary(`${this._logTag} Bake cache`);
    }

    _createFarTreeBakePipeline() {
        farDbgAs(
            `_createFarTreeBakePipeline — ` +
            `farTreeSourceCache=${!!this._farTreeSourceCache} ` +
            `farTreeSourceCache.enabled=${this._farTreeSourceCache?.enabled} ` +
            `farTreeSourceCache.initialized=${this._farTreeSourceCache?._initialized} ` +
            `useFarTierClone=${this._useFarTierClone}`
        );
        if (!this._farTreeSourceCache?.enabled) {
            farDbgAs(`_createFarTreeBakePipeline: SKIPPED — farTreeSourceCache not enabled`);
            this._farTreeBakePipeline = null;
            this._farTreeBakeBindGroupLayout = null;
            return;
        }
        farDbgAs(`_createFarTreeBakePipeline: creating bake pipeline`);

        const heightSampleType = gpuFormatSampleType(
            this.tileStreamer?.textureFormats?.height || 'r32float'
        );
        const tileSampleType = gpuFormatSampleType(
            this.tileStreamer?.textureFormats?.tile || 'r32float'
        );
        const scatterSampleType = gpuFormatSampleType(
            this.tileStreamer?.textureFormats?.scatter || 'r32float'
        );

        const bakeBatchSize = this._farTreeSourceCache.maxBakesPerFrame;

        this._farTreeBakeParamBuffer = this.device.createBuffer({
            label: 'FarTree-BakeParams',
            size: 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this._farTreeBakeTileBuffer = this.device.createBuffer({
            label: 'FarTree-BakeTiles',
            size: Math.max(256, bakeBatchSize * 8 * Uint32Array.BYTES_PER_ELEMENT),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        this._farTreeBakeBindGroupLayout = this.device.createBindGroupLayout({
            label: 'FarTree-BakeLayout',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 4, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: heightSampleType, viewDimension: '2d-array' } },
                { binding: 5, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: tileSampleType, viewDimension: '2d-array' } },
                { binding: 6, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: scatterSampleType, viewDimension: '2d-array' } },
                { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 9, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
            ]
        });

        const module = this.device.createShaderModule({
            label: 'FarTree-BakeShader',
            code: buildFarTreeBakeShader({
                workgroupSize: this._scatterWorkgroupSize || (this._qualityConfig.scatterWorkgroupSize ?? 64),
                perLayerCapacity: this._farTreeSourceCache.perLayerCapacity,
                lodsPerCategory: this.LODS_PER_CATEGORY,
                assetDefFloats: this.ASSET_DEF_FLOATS,
                treeCellSize: this._treeConfig.scatter?.cellSize ?? 16.0,
                treeMaxPerCell: this._treeConfig.scatter?.maxPerCell ?? 4,
                treeClusterProbability: this._treeConfig.scatter?.clusterProbability ?? 0.95,
                treeJitterScale: this._treeConfig.scatter?.jitterScale ?? 0.85,
                treeDensityScale: this._treeConfig.scatter?.densityScale ?? 1.0,
            }),
        });

        this._farTreeBakePipeline = this.device.createComputePipeline({
            label: 'FarTree-BakePipeline',
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [this._farTreeBakeBindGroupLayout]
            }),
            compute: { module, entryPoint: 'main' }
        });
    }

    _maybeRebuildFarTreeBakeBindGroup() {
        // ── DBG: log every call until bind group is built ────────────────────
        if (FAR_TREE_DBG_ENABLED && !this._farTreeBakeBindGroup) {
            const arrayTextures = this.tileStreamer.getArrayTextures();
            const heightGPU = arrayTextures?.height?._gpuTexture?.texture;
            const tileGPU   = arrayTextures?.tile?._gpuTexture?.texture;
            const scatterGPU = arrayTextures?.scatter?._gpuTexture?.texture;
            const selBufReady = this._assetSelectionBuffer?.isReady?.();
            const tileMapKey = this._scatterTreeTileMapKey;
            const tileMapBuf = selBufReady ? this._assetSelectionBuffer.getTileMapBuffer(tileMapKey) : null;
            if (!this._dbg_farBakeBGLogCount) this._dbg_farBakeBGLogCount = 0;
            this._dbg_farBakeBGLogCount++;
            if (this._dbg_farBakeBGLogCount <= 5 || (this._dbg_farBakeBGLogCount % 120) === 0) {
                farDbgAs(
                    `_maybeRebuildFarTreeBakeBindGroup #${this._dbg_farBakeBGLogCount} — ` +
                    `bakePipeline=${!!this._farTreeBakePipeline} bakeLayout=${!!this._farTreeBakeBindGroupLayout} ` +
                    `cacheEnabled=${!!this._farTreeSourceCache?.enabled}\n` +
                    `  textures: height=${!!heightGPU} tile=${!!tileGPU} scatter=${!!scatterGPU}\n` +
                    `  selectionBuffer: ready=${selBufReady} tileMapKey=${tileMapKey} tileMapBuf=${!!tileMapBuf}\n` +
                    `  instanceBuffer=${!!this._farTreeSourceCache?.instanceBuffer} ` +
                    `counterBuffer=${!!this._farTreeSourceCache?.counterBuffer}`
                );
            }
        }
        // ───────────────────────────────────────────────────────────────────
        if (!this._farTreeBakePipeline || !this._farTreeBakeBindGroupLayout || !this._farTreeSourceCache?.enabled) {
            return;
        }

        const arrayTextures = this.tileStreamer.getArrayTextures();
        const heightGPU = arrayTextures?.height?._gpuTexture?.texture;
        const tileGPU = arrayTextures?.tile?._gpuTexture?.texture;
        const scatterGPU = arrayTextures?.scatter?._gpuTexture?.texture;
        if (!heightGPU || !tileGPU || !scatterGPU) return;
        if (!this._assetSelectionBuffer?.isReady?.()) return;

        const instanceBuffer = this._farTreeSourceCache.instanceBuffer;

        if (
            this._farTreeBakeBindGroupCache.heightTex === heightGPU &&
            this._farTreeBakeBindGroupCache.tileTex === tileGPU &&
            this._farTreeBakeBindGroupCache.scatterTex === scatterGPU &&
            this._farTreeBakeBindGroupCache.instanceBuffer === instanceBuffer &&
            this._farTreeBakeBindGroupCache.bindGroup
        ) {
            this._farTreeBakeBindGroup = this._farTreeBakeBindGroupCache.bindGroup;
            return;
        }

        const tileMapBuffer = this._assetSelectionBuffer.getTileMapBuffer(this._scatterTreeTileMapKey);
        if (!tileMapBuffer) return;

        this._farTreeBakeBindGroup = this.device.createBindGroup({
            layout: this._farTreeBakeBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this._farTreeBakeParamBuffer } },
                { binding: 1, resource: { buffer: this._farTreeBakeTileBuffer } },
                { binding: 2, resource: { buffer: instanceBuffer } },
                { binding: 3, resource: { buffer: this._farTreeSourceCache.counterBuffer } },
                { binding: 4, resource: heightGPU.createView({ dimension: '2d-array' }) },
                { binding: 5, resource: tileGPU.createView({ dimension: '2d-array' }) },
                { binding: 6, resource: scatterGPU.createView({ dimension: '2d-array' }) },
                { binding: 7, resource: { buffer: this._assetSelectionBuffer.getAssetDefBuffer() } },
                { binding: 8, resource: { buffer: tileMapBuffer } },
                { binding: 9, resource: { buffer: this._assetSelectionBuffer.getConfigBuffer() } },
            ]
        });

        this._farTreeBakeBindGroupCache.heightTex = heightGPU;
        this._farTreeBakeBindGroupCache.tileTex = tileGPU;
        this._farTreeBakeBindGroupCache.scatterTex = scatterGPU;
        this._farTreeBakeBindGroupCache.instanceBuffer = instanceBuffer;
        this._farTreeBakeBindGroupCache.bindGroup = this._farTreeBakeBindGroup;
    }

}

installAssetStreamerScatterMethods(AssetStreamer, {
    ASSET_BAKE_REPRESENTATION,
    FAR_TREE_DBG_ENABLED,
    FIELD_LAYER_META_U32_STRIDE,
    Logger,
    buildAssetScatterGroupMaskBakeShader,
    farDbgAs,
    gpuFormatSampleType
});
installAssetStreamerDebugMethods(AssetStreamer, {
    Logger
});
installAssetStreamerBindGroupMethods(AssetStreamer, {
    Logger
});
installAssetStreamerRenderMethods(AssetStreamer, {
    GeometryFactory,
    Logger,
    TreeTrunkGeometryBuilder,
    buildAssetFragmentShader,
    buildAssetIndirectShader,
    buildAssetVertexShader,
    buildGroundPropBakeShader,
    buildGroundPropGatherShader,
    buildTreeSourceBakeShader,
    buildTreeSourceGatherShader,
    gpuFormatSampleType
});
