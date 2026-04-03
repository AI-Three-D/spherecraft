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
import { TreeMidSystem } from './TreeMidSystem.js';
import { ClusterTreeSystem } from './ClusterTreeSystem.js';
import { validateTierRanges } from './treeTierConfig.js';
import { TEXTURE_LAYER_MAPPING } from './archetype/archetypeDefinitions.js';
import { LeafMaskBaker } from './LeafMaskBaker.js';
import { Logger } from '../../config/Logger.js';
import { AssetInstancePool } from './AssetInstancePool.js';
import { ArchetypeRegistry } from './archetype/ArchetypeRegistry.js';
import { ARCHETYPE_DEFINITIONS } from './archetype/archetypeDefinitions.js';
import { AssetSelectionBuffer } from './AssetSelectionBuffer.js';
import { DEFAULT_ASSET_DEFINITIONS } from './AssetDefinitions.js';
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
import { getSpeciesRegistry } from './species/SpeciesRegistry.js';
import { TreeTemplateLibrary } from './TreeTemplateLibrary.js';
import { TreeTrunkGeometryBuilder } from './TreeTrunkGeometryBuilder.js';
import { BranchRenderer } from './BranchRenderer.js';
import { TreeLODController } from './TreeLODController.js';
import { TreeMidNearSystem } from './TreeMidNearSystem.js';
import { GeometryFactory } from './archetype/GeometryFactory.js';
import { ASSET_SELF_OCCLUSION } from './streamerConfig.js';
import { PlacementDensityBuffer } from './archetype/PlacementDensityBuffer.js';
import { AssetBakePolicy, ASSET_BAKE_REPRESENTATION } from './baking/AssetBakePolicy.js';
import { BakedAssetTileCache } from './baking/BakedAssetTileCache.js';
import { GroundFieldBaker } from './GroundFieldBaker.js';
import { GroundPropCache } from './GroundPropCache.js';
import { TreeSourceCache } from './TreeSourceCache.js';
import { gpuFormatSampleType } from '../resources/texture.js';
import {
    ENABLE_SCATTER_DENSITY_GROUPS,
    ENABLE_SCATTER_ELIGIBILITY_GATE,
    LODS_PER_CATEGORY,
    QUALITY_PRESETS,
    SCATTER_DENSITY_GROUPS,
    SCATTER_POLICY_GROUPS,
    CAT_TREES,
    TREE_VISIBILITY,
    TREE_FADE_START_RATIO,
    TREE_FADE_END_RATIO,
    TREE_BILLBOARD_LOD_START,
    TREE_BILLBOARD_LOD_END,
    TREE_DENSITY_SCALE,
    TREE_CELL_SIZE,
    TREE_MAX_PER_CELL,
    TREE_CLUSTER_PROBABILITY,
    TREE_JITTER_SCALE,
    TERRAIN_AO_CONFIG,
    GROUND_FIELD_BAKE_CONFIG,
    GROUND_PROP_BAKE_CONFIG,
    TREE_SOURCE_BAKE_CONFIG,
} from './streamerConfig.js';
import { TerrainAOBaker } from './TerrainAOBaker.js';

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
        this._treeConfig = this.engineConfig?.trees || {};
        this._treeMidNearSystem = null;
        this._aoBaker = null;
        this._groundFieldBaker = null;
        this._groundPropCache = null;
        this._treeSourceCache = null;
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
        this._qualityConfig = QUALITY_PRESETS[this._quality] || QUALITY_PRESETS.medium;

        this._treeConfig = this.engineConfig?.trees || {};
const tc       = this._treeConfig;
const tcFlags  = tc.flags    || {};
const tcNear   = tc.nearTier || {};

this._useMidTier        = tcFlags.useMidTier        ?? true;
this._keepLegacyMidNear = tcFlags.keepLegacyMidNear ?? false;
this.enableLeafRendering =
    tcFlags.enableLeafRendering ?? (options.enableLeafRendering !== false);

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
    maxTotalLeaves:       options.maxTotalLeaves ?? tcNear.maxTotalLeaves,
    branchLODBands:       tcNear.branchLODBands,
    branchFadeMargin:     tcNear.branchFadeMargin,
    birch:                tcNear.birch,
    leafCounts:           tcNear.leafCounts,
    leafSizeScale:        tcNear.leafSizeScale,
    leafFadeStartRatio:   tcNear.leafFadeStartRatio,
});

        Object.defineProperty(this, 'treeDetailBands', {
            get: () => this._lodController.getLegacyBands(),
            configurable: true,
        });

        this._debugConfig = options.debug || {};
        this._debugReadbackEnabled = this._debugConfig.readback === true;
        this._treeMidSystem = null; 
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
            options.assetDefinitions || DEFAULT_ASSET_DEFINITIONS,
            this._treeConfig
        );
        this._assetRegistry = new ArchetypeRegistry(                    // ◄── INC 1
            this._assetDefinitions,
            options.archetypeDefinitions || ARCHETYPE_DEFINITIONS        // ◄── INC 1
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
        this._enableScatterDensityGroups = ENABLE_SCATTER_DENSITY_GROUPS === true;
        this._enableScatterEligibilityGate = ENABLE_SCATTER_ELIGIBILITY_GATE !== false;
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
            tileMapDescriptors: this._buildScatterTileMapDescriptors()
        });
        if (this.propTextureManager?.isReady()) {
            this._assetRegistry.assignTextureLayerIndices(
                this.propTextureManager,
                TEXTURE_LAYER_MAPPING
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
        if (GROUND_PROP_BAKE_CONFIG.enabled) {
            this._groundPropCache = new GroundPropCache(this.device, {
                assetRegistry: this._assetRegistry,
                tilePoolSize: this.tileStreamer.tilePoolSize,
                fieldArchetypeIndices: this._fieldArchetypeIndexSet,
                propConfig: this.engineConfig?.groundPropBake,
            });
            this._groundPropCache.initialize(this._bakedAssetTileCache);
        }
        if (TREE_SOURCE_BAKE_CONFIG.enabled) {
            this._treeSourceCache = new TreeSourceCache(this.device, {
                assetRegistry: this._assetRegistry,
                tilePoolSize: this.tileStreamer.tilePoolSize,
                treeConfig: this.engineConfig?.trees?.sourceBake,
            });
            this._treeSourceCache.initialize(this._bakedAssetTileCache);
        }
        if (this._treeConfig?.farTreeTier || this._treeConfig?.clusterTier) {
            this._clusterTreeSystem = new ClusterTreeSystem(this.device, this, {
                treeConfig: this._treeConfig,
            });
            await this._clusterTreeSystem.initialize(this._bakedAssetTileCache);
        }
        this._createScatterGroupMaskResources();
        this._seedScatterGroupPolicyMasks();
        if (this._usesLegacyScatterPath() && this._enableScatterEligibilityGate) {
            this._seedScatterGroupPendingLayers();
        }

        // ═══ Template library (before geometry building) ═══════════════════
        this._speciesRegistry = getSpeciesRegistry();
        this._templateLibrary = new TreeTemplateLibrary({
            variantsPerType: 4,
            baseSeed: this.engineConfig.seed ?? 12345,
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

        // ═══ Terrain AO baker ═══════════════════════════════════════════════
        if (TERRAIN_AO_CONFIG.enabled) {
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
                logDispatches:   TERRAIN_AO_CONFIG.logDispatches !== true ? false : true,
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

        if (false) { //GROUND_FIELD_BAKE_CONFIG.enabled) {
            this._groundFieldBaker = new GroundFieldBaker(this.device, {
                assetRegistry: this._assetRegistry,
                tilePoolSize: this.tileStreamer.tilePoolSize,
                tileTypeCount: this._densityLutTileCount,
                textureFormats: this.tileStreamer?.textureFormats,
                seed: this.engineConfig.seed,
                fieldConfig: this.engineConfig?.groundFieldBake,
                logDispatches: GROUND_FIELD_BAKE_CONFIG.logDispatches !== true ? false : true,
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

        this._treeDetailSystem = new TreeDetailSystem(this.device, this, {
            lodController:    this._lodController,
            maxTotalLeaves:   tcNear.maxTotalLeaves   ?? 600000,
            maxTotalClusters: tcNear.maxTotalClusters ?? 50000,
            debugReadback:    this._debugReadbackEnabled,
        });
        await this._treeDetailSystem.initialize();

        this._leafMaskBaker = new LeafMaskBaker(this.device);
        await this._leafMaskBaker.initialize();



// ═══ Tree mid-tier systems ═══════════════════════════════════════════
const tierRanges = this._treeConfig.tierRanges || {};
const tierWarnings = validateTierRanges(
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
            `${this._aoBaker?.enabled ? `, AO=${TERRAIN_AO_CONFIG.resolution}px` : ''}` +
            `${this._groundFieldBaker?.enabled ? `, field=${this._groundFieldBaker.resolution}px` : ''})`
        );
        Logger.info(`${this._logTag} Legacy climate scatter disabled; using baked field/prop/tree sources`);
        this._bakedAssetTileCache?.logSummary(`${this._logTag} Bake cache`);
    }

    /** @returns {TreeDetailSystem|null} */
    getTreeDetailSystem() {
        return this._treeDetailSystem || null;
    }

    _buildScatterGroups() {
        const runtimeDefs = [...SCATTER_DENSITY_GROUPS]
            .sort((a, b) => b.minDensity - a.minDensity)
            .map((def) => ({
                key: `runtime-${def.name}`,
                name: def.name,
                label: def.name,
                mode: 'runtime',
                minDensity: def.minDensity,
                variantIndices: [],
                variantIndexSet: new Set(),
                archetypeIndexSet: new Set(),
                maxDensity: 0.000001,
                tileMapKey: `scatter-group-${def.name}`,
            }));
        const runtimeDefsByName = new Map(runtimeDefs.map((group) => [group.name, group]));

        const policyDefs = (Array.isArray(SCATTER_POLICY_GROUPS) ? SCATTER_POLICY_GROUPS : [])
            .map((def) => {
                const archetypeName = def?.archetypeName;
                const archetype = archetypeName
                    ? this._assetRegistry.getArchetype?.(archetypeName)
                    : null;
                if (!archetype?.isActive) return null;
                return {
                    key: `policy-${archetype.name}`,
                    name: def.name || `${archetype.name}-runtime`,
                    label: def.name || `${archetype.name}-runtime`,
                    mode: 'policy-runtime',
                    maskArchetypeName: archetype.name,
                    maskArchetypeIndex: archetype.index,
                    runtimeHoldDistance: Number.isFinite(def.runtimeHoldDistance)
                        ? Math.max(0, def.runtimeHoldDistance)
                        : null,
                    runtimeHoldScale: Number.isFinite(def.runtimeHoldScale)
                        ? Math.max(1.0, def.runtimeHoldScale)
                        : 1.0,
                    minDensity: 0.0,
                    variantIndices: [],
                    variantIndexSet: new Set(),
                    archetypeIndexSet: new Set([archetype.index]),
                    maxDensity: 0.000001,
                    maxScatterTileWorldSize: Number.isFinite(def.maxScatterTileWorldSize)
                        ? Math.max(8, def.maxScatterTileWorldSize)
                        : null,
                    scatterCellOversample: Number.isFinite(def.scatterCellOversample)
                        ? Math.max(1, Math.floor(def.scatterCellOversample))
                        : null,
                    tileMapKey: `scatter-group-policy-${archetype.name}`,
                };
            })
            .filter(Boolean);
        const policyDefsByArchetype = new Map(
            policyDefs.map((group) => [group.maskArchetypeName, group])
        );

        const fieldChannels = Array.isArray(GROUND_FIELD_BAKE_CONFIG.channels)
            ? GROUND_FIELD_BAKE_CONFIG.channels
            : [];
        const fieldDefs = fieldChannels
            .map((channel, channelIndex) => {
                const archetypeName = channel?.archetypeName;
                const archetype = archetypeName
                    ? this._assetRegistry.getArchetype?.(archetypeName)
                    : null;
                if (!archetype?.isActive) return null;
                return {
                    key: `field-${archetype.name}`,
                    name: `${channel.name || archetype.name}-field`,
                    label: `${channel.name || archetype.name}-field`,
                    mode: 'field',
                    fieldArchetypeName: archetype.name,
                    fieldArchetypeIndex: archetype.index,
                    fieldChannelIndex: channelIndex,
                    maskArchetypeName: archetype.name,
                    maskArchetypeIndex: archetype.index,
                    runtimeHoldDistance: Number.isFinite(channel.runtimeHoldDistance)
                        ? Math.max(0, channel.runtimeHoldDistance)
                        : null,
                    runtimeHoldScale: Number.isFinite(channel.runtimeHoldScale)
                        ? Math.max(1.0, channel.runtimeHoldScale)
                        : 1.0,
                    fieldDensityScale: Number.isFinite(channel.scatterDensityScale)
                        ? Math.max(0.0, channel.scatterDensityScale)
                        : 1.0,
                    minDensity: 0.0,
                    variantIndices: [],
                    variantIndexSet: new Set(),
                    archetypeIndexSet: new Set([archetype.index]),
                    maxDensity: 0.000001,
                    maxScatterDistance: 0.0,
                    tileMapKey: `scatter-group-field-${archetype.name}`,
                };
            })
            .filter(Boolean);
        const fieldDefsByArchetype = new Map(
            fieldDefs.map((group) => [group.fieldArchetypeName, group])
        );

        for (const variant of this._assetRegistry.getAllVariants()) {
            if (!variant?.archetype?.isActive) continue;
            if (variant.archetype.index === 0) continue;

            const fieldGroup = fieldDefsByArchetype.get(variant.archetype.name) || null;
            let group = fieldGroup;

            if (!group) {
                group = policyDefsByArchetype.get(variant.archetype.name) || null;
            }

            if (!group) {
                const explicitGroup = variant.scatterGroupName || variant.family?.scatterGroup || null;
                if (explicitGroup) {
                    group = runtimeDefsByName.get(explicitGroup) || null;
                }
                if (!group) {
                    const density = Math.max(0, ...(variant.densities ?? [0]));
                    group = runtimeDefs.find(def => density >= def.minDensity)
                        ?? runtimeDefs[runtimeDefs.length - 1];
                }
            }

            group.variantIndices.push(variant.index);
            group.variantIndexSet.add(variant.index);
            group.archetypeIndexSet.add(variant.archetype.index);
            const variantMaxDensity = Math.max(0.000001, ...(variant.densities ?? [0.000001]));
            const variantMaxDistance = Math.max(0.0, ...(variant.lodDistances ?? [0.0]));
            group.maxDensity = Math.max(group.maxDensity, variantMaxDensity);
            if (group.mode === 'field') {
                group.maxScatterDistance = Math.max(group.maxScatterDistance ?? 0.0, variantMaxDistance);
            }
        }

        const groups = [...fieldDefs, ...policyDefs, ...runtimeDefs]
            .filter(group => group.variantIndices.length > 0)
            .map((group, index) => ({
                ...group,
                id: index,
                bit: 1 << index,
            }));

        return groups;
    }

    _buildScatterTileMapDescriptors() {
        const descriptors = [{
            key: this._scatterTreeTileMapKey,
            includeVariant: (variant) => variant?.archetype?.index === 0
        }];

        if (GROUND_PROP_BAKE_CONFIG.enabled) {
            descriptors.push({
                key: this._groundPropTileMapKey,
                includeVariant: (variant) => this._isBakedGroundPropVariant(variant),
            });
        }

        if (!this._enableScatterDensityGroups) {
            return descriptors;
        }

        for (const group of this._scatterGroups) {
            descriptors.push({
                key: group.tileMapKey,
                includeVariant: (variant) => group.variantIndexSet.has(variant.index)
            });
        }

        return descriptors;
    }

    _isBakedGroundPropVariant(variant) {
        if (!variant?.archetype?.isActive) return false;
        if (variant.archetype.index === 0) return false;
        return true;
    }

    _getMaxVariantDistance(includeVariant, fallback = 0.0) {
        let maxDistance = Number.isFinite(fallback) ? fallback : 0.0;
        for (const variant of this._assetRegistry?.getAllVariants?.() ?? []) {
            if (!variant || !includeVariant?.(variant)) continue;
            const variantDistance = Math.max(0.0, ...(variant.lodDistances ?? [0.0]));
            maxDistance = Math.max(maxDistance, variantDistance);
        }
        return maxDistance;
    }

    _createScatterGroupMaskResources() {
        const tilePoolSize = Math.max(1, this.tileStreamer?.tilePoolSize ?? 1);
        let defaultGroupMask = 0;

        if (this._usesLegacyScatterPath() && this._enableScatterEligibilityGate) {
            const tileTypeMaskData = new Uint32Array(this._densityLutTileCount);

            for (const group of this._scatterGroups) {
                defaultGroupMask |= group.bit;
                for (const variantIndex of group.variantIndices) {
                    const variant = this._assetRegistry.getVariantByIndex(variantIndex);
                    if (!variant) continue;
                    let tileTypes = variant.tileTypes;
                    if ((!tileTypes || tileTypes.length === 0) && variant.family?.tileTypes) {
                        tileTypes = variant.family.tileTypes;
                    }
                    if (!tileTypes || tileTypes.length === 0) continue;
                    for (const tileType of tileTypes) {
                        if (tileType >= 0 && tileType < tileTypeMaskData.length) {
                            tileTypeMaskData[tileType] |= group.bit;
                        }
                    }
                }
            }

            this._tileTypeScatterGroupMaskBuffer = this.device.createBuffer({
                label: 'Asset-ScatterGroupTileTypeMask',
                size: Math.max(256, tileTypeMaskData.byteLength),
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            });
            this.device.queue.writeBuffer(this._tileTypeScatterGroupMaskBuffer, 0, tileTypeMaskData);
        }

        if (defaultGroupMask === 0) {
            defaultGroupMask = 0xFFFFFFFF;
        }
        this._scatterGroupDefaultMask = defaultGroupMask >>> 0;
        this._scatterGroupPolicyMasksCPU = new Uint32Array(tilePoolSize).fill(this._scatterGroupDefaultMask);
        this._fieldRenderMasksCPU = new Uint32Array(tilePoolSize);
        this._fieldActiveLayersCPU = new Uint32Array(tilePoolSize);
        this._fieldLayerMetaCPU = new Uint32Array(tilePoolSize * FIELD_LAYER_META_U32_STRIDE);

        this._fieldRenderMaskBuffer = this.device.createBuffer({
            label: 'Asset-FieldRenderMask',
            size: Math.max(256, tilePoolSize * Uint32Array.BYTES_PER_ELEMENT),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(
            this._fieldRenderMaskBuffer,
            0,
            this._fieldRenderMasksCPU
        );

        this._fieldActiveLayerBuffer = this.device.createBuffer({
            label: 'Asset-FieldActiveLayers',
            size: Math.max(256, this._fieldActiveLayersCPU.byteLength),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(
            this._fieldActiveLayerBuffer,
            0,
            this._fieldActiveLayersCPU
        );

        this._fieldLayerMetaBuffer = this.device.createBuffer({
            label: 'Asset-FieldLayerMeta',
            size: Math.max(256, this._fieldLayerMetaCPU.byteLength),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(
            this._fieldLayerMetaBuffer,
            0,
            this._fieldLayerMetaCPU
        );

        if (!this._usesLegacyScatterPath() || !this._enableScatterEligibilityGate) {
            return;
        }

        this._scatterGroupMaskBuffer = this.device.createBuffer({
            label: 'Asset-ScatterGroupLayerMask',
            size: Math.max(256, tilePoolSize * Uint32Array.BYTES_PER_ELEMENT),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(
            this._scatterGroupMaskBuffer,
            0,
            new Uint32Array(tilePoolSize).fill(defaultGroupMask)
        );

        this._scatterGroupPolicyMaskBuffer = this.device.createBuffer({
            label: 'Asset-ScatterGroupPolicyMask',
            size: Math.max(256, tilePoolSize * Uint32Array.BYTES_PER_ELEMENT),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(
            this._scatterGroupPolicyMaskBuffer,
            0,
            this._scatterGroupPolicyMasksCPU
        );

        this._scatterGroupMaskBakeConfigBuffer = this.device.createBuffer({
            label: 'Asset-ScatterGroupMaskBakeConfig',
            size: 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this._scatterGroupPendingLayersBuffer = this.device.createBuffer({
            label: 'Asset-ScatterGroupPendingLayers',
            size: Math.max(256, tilePoolSize * Uint32Array.BYTES_PER_ELEMENT),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        const module = this.device.createShaderModule({
            label: 'Asset-ScatterGroupMaskBake',
            code: buildAssetScatterGroupMaskBakeShader({
                workgroupSize: this._qualityConfig.scatterWorkgroupSize ?? 64,
            })
        });

        const tileSampleType = gpuFormatSampleType(
            this.tileStreamer?.textureFormats?.tile || 'r8unorm'
        );

        this._scatterGroupMaskBakeBindGroupLayout = this.device.createBindGroupLayout({
            label: 'Asset-ScatterGroupMaskBakeLayout',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: tileSampleType, viewDimension: '2d-array' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
            ]
        });

        this._scatterGroupMaskBakePipeline = this.device.createComputePipeline({
            label: 'Asset-ScatterGroupMaskBakePipeline',
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [this._scatterGroupMaskBakeBindGroupLayout]
            }),
            compute: { module, entryPoint: 'main' }
        });
    }

    _seedScatterGroupPendingLayers() {
        if (!this._usesLegacyScatterPath()) return;
        for (const info of this.tileStreamer?._tileInfo?.values?.() ?? []) {
            if (info?.layer == null) continue;
            this._scatterGroupPendingLayers.add(info.layer);
        }
        if (this._scatterGroupPendingLayers.size > 0) {
            this._forceScatter = true;
        }
    }

    _createScatterDispatchPipeline() {
        const maxVisibleTiles = this.quadtreeGPU.maxVisibleTiles;
    
        const shaderSource = /* wgsl */`
    // Reads the actual visible tile count from the quadtree counter buffer
    // and writes a clamped (count, 1, 1) indirect dispatch argument.
    
    @group(0) @binding(0) var<storage, read>       qtCounters:   array<u32, 4>;
    @group(0) @binding(1) var<storage, read_write> dispatchArgs: array<u32, 3>;
    
    @compute @workgroup_size(1)
    fn main() {
        let count = min(qtCounters[2], ${maxVisibleTiles}u);
        dispatchArgs[0] = count;
        dispatchArgs[1] = 1u;
        dispatchArgs[2] = 1u;
    }
    `;
    
        const module = this.device.createShaderModule({
            label: 'Asset-ScatterDispatch',
            code: shaderSource,
        });
    
        const bindGroupLayout = this.device.createBindGroupLayout({
            label: 'Asset-ScatterDispatch-Layout',
            entries: [
                {
                    binding:    0,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer:     { type: 'read-only-storage' },
                },
                {
                    binding:    1,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer:     { type: 'storage' },
                },
            ],
        });
    
        this._scatterDispatchPipeline = this.device.createComputePipeline({
            label:  'Asset-ScatterDispatch-Pipeline',
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [bindGroupLayout],
            }),
            compute: { module, entryPoint: 'main' },
        });
    
        // 12 bytes: 3 × u32 (x, y, z workgroup counts)
        // Needs STORAGE (written by the dispatch shader) and INDIRECT (read by
        // dispatchWorkgroupsIndirect). Initialise to (0, 1, 1) so that if the
        // fill pass hasn't run yet no work is dispatched.
        this._scatterDispatchArgsBuffer = this.device.createBuffer({
            label: 'Asset-ScatterDispatchArgs',
            size:  12,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
        });
        const initial = new Uint32Array([0, 1, 1]);
        this.device.queue.writeBuffer(this._scatterDispatchArgsBuffer, 0, initial);
    
        this._scatterDispatchBindGroup = this.device.createBindGroup({
            label:  'Asset-ScatterDispatch-BG',
            layout: bindGroupLayout,
            entries: [
                {
                    binding:  0,
                    resource: { buffer: this.quadtreeGPU.getCounterBuffer() },
                },
                {
                    binding:  1,
                    resource: { buffer: this._scatterDispatchArgsBuffer },
                },
            ],
        });
    }
        /**
     * Band 0 trees are also drawn by BranchRenderer with detailed per-variant
     * geometry + bark textures. We suppress band 0's scatter draw to avoid
     * a duplicate, untextured tree appearing inside each detailed one.
     *
     * This is safe ONLY if every band-0 tree is also branch-rendered, i.e.:
     *   lodDistances[0] ≤ treeDetailBands.l{maxBranchDetailLevel}
     *
     * If that invariant breaks, trees in the gap range silently disappear.
     * This method logs a clear warning so a misconfiguration is caught.
     */
        _verifyTreeBandAlignment() {
            this._suppressTreeBand0 = false;
    
            if (!this._branchRenderer?._initialized) return;
    
            const assets = this._assetRegistry?.getAllAssets?.() || [];
            const treeAsset = assets.find(a => a.category === 'tree');
            const lod0 = treeAsset?.lodDistances?.[0];
            if (!Number.isFinite(lod0)) {
                this._suppressTreeBand0 = true;
                Logger.warn(
                    `${this._logTag} Could not read tree lodDistances[0]; ` +
                    `suppressing band 0 scatter draw anyway.`
                );
                return;
            }
    
            // Single source of truth — no more manually indexing l0/l1/l2.
            const branchCutoff = this._lodController.getBranchCutoff();
    
            if (lod0 <= branchCutoff) {
                this._suppressTreeBand0 = true;
                Logger.info(
                    `${this._logTag} Tree band 0 (0..${lod0}m) fully covered by ` +
                    `BranchRenderer (0..${branchCutoff}m) — suppressing band 0 scatter draw.`
                );
            } else {
                this._suppressTreeBand0 = true;
                Logger.warn(
                    `${this._logTag} LOD CONFIG MISMATCH: ` +
                    `tree "${treeAsset.id}" lodDistances[0]=${lod0}m > ` +
                    `BranchRenderer coverage ${branchCutoff}m. ` +
                    `Trees at ${branchCutoff}..${lod0}m will NOT render. ` +
                    `Fix: lower lodDistances[0] or raise TreeLODController.maxBranchDetailLevel.`
                );
            }
    
            const maxClose = this._lodController.maxCloseTrees;
            const band0Cap = this._pool?.getBandCapacity(CAT_TREES * LODS_PER_CATEGORY) ?? 0;
            if (band0Cap > maxClose) {
                Logger.info(
                    `${this._logTag} Note: band 0 capacity (${band0Cap}) > ` +
                    `maxCloseTrees (${maxClose}). Overflow trees within ` +
                    `${lod0}m would be invisible.`
                );
            }
        }
    _getActiveTreeTypes() {
        const treeTypeSet = new Set();
        const assets = this._assetRegistry?.getAllAssets?.() || [];

        for (const asset of assets) {
            if (asset.category !== 'tree') continue;

            const geomType = (asset.geometryType || '').toLowerCase();
            // Map geometry types to template tree types
            const mapping = {
                'deciduous': 'birch',
                'deciduous_broad': 'oak',
                'deciduous_tall': 'eucalyptus',
                'palm': 'palm'
            };
            const treeType = mapping[geomType] || geomType;
            if (treeType) treeTypeSet.add(treeType);
        }

        // Always include birch since it's our focus
        if (treeTypeSet.size === 0) {
            treeTypeSet.add('birch');
        }

        return Array.from(treeTypeSet);
    }

    setLeafRenderingEnabled(enabled) {
        this.enableLeafRendering = enabled !== false;
    }

    setTreeDetailBands(bands = {}) {
        const arr = Array.isArray(bands)
            ? bands
            : [bands.l0, bands.l1, bands.l2];
        this._lodController.setDetailBands(arr);

        // Propagate. TreeDetailSystem re-reads on next update (it holds
        // a controller ref). LeafStreamer caches fade distances in its
        // pipeline, so it needs an explicit nudge.
        this._leafStreamer?.setLeafDistanceRange?.(
            this._lodController.leafFadeStart,
            this._lodController.leafFadeEnd
        );
    }

    dispose() {
        this._treeMidSystem?.dispose();
        this._scatterDispatchArgsBuffer?.destroy();
        this._scatterDispatchArgsBuffer = null;
        this._scatterDispatchPipeline   = null;
        this._scatterDispatchBindGroup  = null;
        this._scatterPipelines = [];
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
        this._groundPropBakeParamBuffer?.destroy();
        this._groundPropBakeTileBuffer?.destroy();
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
        this._treeSourceBakeParamBuffer?.destroy();
        this._treeSourceBakeTileBuffer?.destroy();
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
        this._producerDebugPoolReadbackBuffer?.destroy();
        this._producerDebugGroundPropReadbackBuffer?.destroy();
        this._producerDebugPoolReadbackBuffer = null;
        this._producerDebugGroundPropReadbackBuffer = null;
        this._producerDebugQueued = false;
        this._producerDebugPending = false;
        this._producerDebugHasGroundPropSnapshot = false;
        this._scatterGroupMaskBakePipeline = null;
        this._scatterGroupMaskBakeBindGroupLayout = null;
        this._scatterGroupMaskBakeBindGroup = null;
        this._scatterGroupMaskBakeBindGroupCache = { tileTex: null, bindGroup: null };
        this._leafMaskBaker?.dispose();  
        this._aoBaker?.dispose();    
        this._groundFieldBaker?.dispose();
        this._groundPropCache?.dispose();
        this._treeSourceCache?.dispose();
        this._clusterTreeSystem?.dispose();
        this._pool?.dispose();
        this._treeDetailSystem?.dispose();
        this._branchRenderer?.dispose();
        this._templateLibrary?.dispose();
        this._assetSelectionBuffer?.dispose();
        this._densityLUT?.dispose();    
        this._scatterParamBuffer?.destroy();
        this._climateUniformBuffer?.destroy();
        this._uniformBuffer?.destroy();
        this._fragUniformBuffer?.destroy();
        this._lodIndexCountBuffer?.destroy();
        this._loadedTableParamsBuffer?.destroy();
        this._scatterGroupMaskBuffer?.destroy();
        this._scatterGroupPolicyMaskBuffer?.destroy();
        this._fieldRenderMaskBuffer?.destroy();
        this._fieldActiveLayerBuffer?.destroy();
        this._fieldLayerMetaBuffer?.destroy();
        this._scatterGroupMaskBakeConfigBuffer?.destroy();
        this._scatterGroupPendingLayersBuffer?.destroy();
        this._tileTypeScatterGroupMaskBuffer?.destroy();
        this._dummyStorageBuffer?.destroy();
        this._dummyUniformBuffer?.destroy();
        for (const geo of this._geometries) {
            geo?.positionBuffer?.destroy();
            geo?.normalBuffer?.destroy();
            geo?.uvBuffer?.destroy();
            geo?.indexBuffer?.destroy();
        }
        this._leafStreamer?.dispose();
        this._scatterGroupPendingLayers.clear();
        this._deferredScatterCommits = [];
        this._scatterGroupPolicyMasksCPU = null;
        this._scatterGroupPolicyMaskBuffer = null;
        this._fieldRenderMasksCPU = null;
        this._fieldRenderMaskBuffer = null;
        this._fieldActiveLayersCPU = null;
        this._fieldLayerMetaCPU = null;
        this._fieldActiveLayerBuffer = null;
        this._fieldLayerMetaBuffer = null;
        this._fieldActiveLayerCount = 0;
        this._scatterGroupActiveBits = 0;
        this._scatterGroupActivityDirty = true;
        this._fieldActiveBits = 0;
        this._fieldActivityDirty = true;
        this._bakedAssetTileCache = null;
        this._assetBakePolicy = null;
        this._groundFieldBaker = null;
        this._groundPropCache = null;
        this._treeSourceCache = null;
        this._clusterTreeSystem = null;
        this._aoBaker = null;
        this._initialized = false;
    }

    // ──────────────────────────────────────────────────────────────────────
    // Per-frame: compute (scatter + indirect)
    // ──────────────────────────────────────────────────────────────────────



update(commandEncoder, camera) {
    if (!this._initialized) return;
    this._frameCount++;

    if ((this._frameCount % 120) === 1) {
        this._bakedAssetTileCache?.syncFromTileStreamer(this.tileStreamer);
        this._groundPropCache?.syncFromTileCache(this._bakedAssetTileCache, false);
        this._treeSourceCache?.syncFromTileCache(this._bakedAssetTileCache, false);
        this._clusterTreeSystem?.syncFromTileCache(this._bakedAssetTileCache, false);
        this._seedScatterGroupPolicyMasks();
        this._forceScatter = true;
    }

    this._maybeRebuildScatterBindGroups();
    this._maybeRebuildFieldScatterBindGroups();
    this._maybeRebuildGroundPropBakeBindGroup();
    this._maybeRebuildGroundPropGatherBindGroup();
    this._maybeRebuildTreeSourceBakeBindGroup();
    this._maybeRebuildTreeSourceGatherBindGroup();
    this._maybeRebuildIndirectBindGroup();

    const runtimeScatterReady = this._scatterPipelines.length === 0
        || this._scatterPipelines.every(pass => pass.bindGroup);
    const fieldScatterReady = this._fieldScatterPipelines.every(pass => pass.bindGroup);
    const groundPropReady = !this._groundPropCache?.enabled
        || (this._groundPropBakeBindGroup && this._groundPropGatherBindGroup);
    const treeSourceReady = !this._treeSourceCache?.enabled
        || (this._treeSourceBakeBindGroup && this._treeSourceGatherBindGroup);
    if (!runtimeScatterReady || !fieldScatterReady || !groundPropReady || !treeSourceReady || !this._indirectBindGroup) {
        // Zero indirect args so stale draw counts don't execute.
        this.device.queue.writeBuffer(this._pool.indirectBuffer, 0, this._indirectZeros);
        return;
    }

    this._drainAOCommits();
    this._drainScatterGroupCommits();
    this._treeSourceCache?.refreshVisibleOwnerLayers(this.tileStreamer);
    this._dispatchScatterGroupMaskBakes(commandEncoder);
    const bakedGroundFieldThisFrame = this._dispatchGroundFieldBakes(commandEncoder);
    const bakedGroundPropsThisFrame = this._dispatchGroundPropBakes(commandEncoder);
    const bakedTreesThisFrame = this._dispatchTreeSourceBakes(commandEncoder);
    const bakeDrivenScatter = bakedGroundFieldThisFrame || bakedGroundPropsThisFrame || bakedTreesThisFrame;
    if (bakeDrivenScatter) {
        this._forceScatter = true;
    }

    if (!bakeDrivenScatter && !this._shouldUpdateScatter(camera)) {
        if (this._treeDetailSystem)  this._treeDetailSystem.update(commandEncoder, camera);
        if (this._treeMidSystem)     this._treeMidSystem.update(commandEncoder, camera);
        if (this._clusterTreeSystem) this._clusterTreeSystem.update(commandEncoder, camera);
        if (this._branchRenderer)    this._branchRenderer.update(commandEncoder, camera);
        if (this._leafStreamer && this.enableLeafRendering) {
            this._leafStreamer.update(commandEncoder, camera);
        }
        this._dispatchAOBakes(commandEncoder);
        return;
    }

    this._updateScatterParams(camera);
    this._updateClimateUniforms();
    this._pool.resetCounters();
    this._refreshActiveScatterGroupBits();
    this._refreshActiveFieldBits();

    if (this._scatterPipelines.length > 0) {
        const fillPass = commandEncoder.beginComputePass({ label: 'AssetScatterDispatchFill' });
        fillPass.setPipeline(this._scatterDispatchPipeline);
        fillPass.setBindGroup(0, this._scatterDispatchBindGroup);
        fillPass.dispatchWorkgroups(1);
        fillPass.end();
    }
    {
        for (const fieldPass of this._fieldScatterPipelines) {
            if (!this._shouldDispatchFieldScatterPass(fieldPass)) continue;
            const pass = commandEncoder.beginComputePass({ label: `AssetFieldScatter-${fieldPass.label}` });
            pass.setPipeline(fieldPass.pipeline);
            pass.setBindGroup(0, fieldPass.bindGroup);
            pass.dispatchWorkgroups(this._fieldActiveLayerCount);
            pass.end();
        }
    }
    {
        for (const scatterPass of this._scatterPipelines) {
            if (!this._shouldDispatchScatterPass(scatterPass)) continue;
            const pass = commandEncoder.beginComputePass({ label: `AssetScatter-${scatterPass.label}` });
            pass.setPipeline(scatterPass.pipeline);
            pass.setBindGroup(0, scatterPass.bindGroup);
            pass.dispatchWorkgroupsIndirect(this._scatterDispatchArgsBuffer, 0);
            pass.end();
        }
    }
    {
        if (this._shouldDispatchTreeSourceGather()) {
            const pass = commandEncoder.beginComputePass({ label: 'TreeSource-Gather' });
            pass.setPipeline(this._treeSourceGatherPipeline);
            pass.setBindGroup(0, this._treeSourceGatherBindGroup);
            pass.dispatchWorkgroups(this._treeSourceCache.activeLayerCount);
            pass.end();
        }
    }
    {
        if (this._shouldDispatchGroundPropGather()) {
            const pass = commandEncoder.beginComputePass({ label: 'GroundProp-Gather' });
            pass.setPipeline(this._groundPropGatherPipeline);
            pass.setBindGroup(0, this._groundPropGatherBindGroup);
            pass.dispatchWorkgroups(this._groundPropCache.activeLayerCount);
            pass.end();
        }
    }
    {
        const pass = commandEncoder.beginComputePass({ label: 'AssetIndirectBuilder' });
        pass.setPipeline(this._indirectPipeline);
        pass.setBindGroup(0, this._indirectBindGroup);
        pass.dispatchWorkgroups(1);
        pass.end();
    }
    this._queueProducerDebugReadback(commandEncoder);
/*
    if (this._treeDetailSystem)  this._treeDetailSystem.update(commandEncoder, camera);
    if (this._treeMidNearSystem) this._treeMidNearSystem.update(commandEncoder, camera);
    if (this._branchRenderer)    this._branchRenderer.update(commandEncoder, camera);
*/
        if (this._treeDetailSystem)  this._treeDetailSystem.update(commandEncoder, camera);
       // if (this._treeMidNearSystem) this._treeMidNearSystem.update(commandEncoder, camera); 
        if (this._treeMidSystem)     this._treeMidSystem.update(commandEncoder, camera);    
        if (this._clusterTreeSystem) this._clusterTreeSystem.update(commandEncoder, camera);
        if (this._branchRenderer)    this._branchRenderer.update(commandEncoder, camera);
        if (this._leafStreamer && this.enableLeafRendering) {
            this._leafStreamer.update(commandEncoder, camera);
        }

    this._dispatchAOBakes(commandEncoder);

    this._lastScatterFrame = this._frameCount;
    if (camera?.position) {
        this._lastScatterPosition = {
            x: camera.position.x, y: camera.position.y, z: camera.position.z,
        };
    }
    this._lastScatterDirection = this._getCameraForward(camera);
    this._forceScatter = false;
}

/**
 * Pull newly-committed tiles from TileStreamer and push them into the
 * AO bake queue. The queue is deduped by layer in the baker so eviction
 * + re-commit to the same layer doesn't produce stale bakes.
 */
_drainAOCommits() {
    if (!this._aoBaker?.enabled) return;

    const commits = this.tileStreamer.drainAOCommitQueue?.();
    if (!commits || commits.length === 0) return;

    for (const c of commits) {
        this._aoBaker.enqueueBake(c.face, c.depth, c.x, c.y, c.layer);

        // Re-bake same-depth neighbors so they pick up this tile's layer
        // for cross-tile AO sampling.
        const offsets = [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[1,-1],[-1,1],[1,1]];
        const gridSize = 1 << c.depth;
        for (const [dx, dy] of offsets) {
            const nx = c.x + dx, ny = c.y + dy;
            if (nx < 0 || nx >= gridSize || ny < 0 || ny >= gridSize) continue;
            const nLayer = this.tileStreamer?.getLoadedLayer?.(c.face, c.depth, nx, ny);
            if (nLayer != null && nLayer >= 0) {
                this._aoBaker.enqueueBake(c.face, c.depth, nx, ny, nLayer);
            }
        }
    }
}

_drainScatterGroupCommits() {
    // Process commits from the current frame immediately (no 1-frame deferral).
    // Previously this deferred one frame to avoid bind group churn, but that
    // added a guaranteed 16 ms latency to every tile commit. The bake
    // dispatches triggered here are enqueued, not immediately submitted, so
    // there is no read-while-rendering hazard.
    this._deferredScatterCommits = [];
    const commits = this.tileStreamer.drainScatterCommitQueue?.() ?? [];
    if (!commits || commits.length === 0) return;

    this._bakedAssetTileCache?.applyCommitBatch(commits);
    this._groundPropCache?.applyCommitBatch(this._bakedAssetTileCache);
    this._treeSourceCache?.applyCommitBatch(this._bakedAssetTileCache);
    this._clusterTreeSystem?.applyCommitBatch(this._bakedAssetTileCache);
    this._scatterGroupActivityDirty = true;
    this._fieldActivityDirty = true;
    this._enqueueGroundFieldBakeBatch(commits);
    for (const commit of commits) {
        const entry = this._bakedAssetTileCache?.getLayerEntry?.(commit.layer);
        if (!entry) continue;
        this._updateScatterGroupPolicyForEntry(entry);
    }

    if (!this._enableScatterEligibilityGate || !this._hasLegacyRuntimeGroundScatter()) {
        return;
    }

    for (const commit of commits) {
        this._scatterGroupPendingLayers.add(commit.layer);
    }

    this._forceScatter = true;
}

    _seedGroundFieldBakes() {
        if (!this._groundFieldBaker?.enabled) return;
        const entries = this._bakedAssetTileCache?.getEntries?.() ?? [];
        for (const entry of entries) {
            this._enqueueGroundFieldBakeForEntry(entry);
        }
    }

    _seedScatterGroupPolicyMasks() {
        this._rebuildScatterGroupPolicyState(true);
    }

    _enqueueGroundFieldBakeBatch(commits) {
        if (!this._groundFieldBaker?.enabled) return;
        for (const commit of commits) {
            const entry = this._bakedAssetTileCache?.getLayerEntry?.(commit.layer);
        if (!entry) continue;
        this._enqueueGroundFieldBakeForEntry(entry);
    }
}

_enqueueGroundFieldBakeForEntry(entry) {
    if (!this._groundFieldBaker?.enabled || !entry) return;
    const hasFieldArchetype = this._computeFieldRenderMask(entry) !== 0;
    this._groundFieldBaker.enqueueBake(
        entry.face,
        entry.depth,
        entry.x,
        entry.y,
        entry.layer,
        hasFieldArchetype
        );
    }

    _rebuildScatterGroupPolicyState(enqueueLayers = false) {
        if (!this._scatterGroupPolicyMasksCPU) {
            this._scatterGroupActiveBits = 0;
            this._scatterGroupActivityDirty = false;
            this._fieldActiveBits = 0;
            this._fieldActivityDirty = false;
            this._fieldActiveLayerCount = 0;
            return;
        }

        this._scatterGroupPolicyMasksCPU.fill(this._scatterGroupDefaultMask >>> 0);
        if (this._fieldRenderMasksCPU) {
            this._fieldRenderMasksCPU.fill(0);
        }

        const entries = this._bakedAssetTileCache?.getEntries?.() ?? [];
        let activeBits = 0;
        let fieldActiveBits = 0;

        for (const entry of entries) {
            if (!entry) continue;
            const layer = entry.layer >>> 0;
            if (layer >= this._scatterGroupPolicyMasksCPU.length) continue;

            const mask = this._computeScatterGroupPolicyMask(entry);
            const fieldMask = this._computeFieldRenderMask(entry);
            this._scatterGroupPolicyMasksCPU[layer] = mask;
            if (this._fieldRenderMasksCPU) {
                this._fieldRenderMasksCPU[layer] = fieldMask;
            }
            activeBits |= mask;
            fieldActiveBits |= fieldMask;

            if (enqueueLayers && this._usesLegacyScatterPath()) {
                this._scatterGroupPendingLayers.add(layer);
            }
        }

        this._scatterGroupActiveBits = activeBits >>> 0;
        this._scatterGroupActivityDirty = false;
        this._fieldActiveBits = fieldActiveBits >>> 0;
        this._fieldActivityDirty = false;

        if (this._scatterGroupPolicyMaskBuffer) {
            this.device.queue.writeBuffer(
                this._scatterGroupPolicyMaskBuffer,
                0,
                this._scatterGroupPolicyMasksCPU
            );
        }
        if (this._fieldRenderMaskBuffer && this._fieldRenderMasksCPU) {
            this.device.queue.writeBuffer(
                this._fieldRenderMaskBuffer,
                0,
                this._fieldRenderMasksCPU
            );
        }

        this._rebuildFieldLayerState();
    }

    _computeScatterGroupPolicyMask(entry) {
        let mask = this._scatterGroupDefaultMask >>> 0;
        if (!entry || !this._groundFieldBaker?.enabled) {
            return mask;
        }
        for (const group of this._scatterGroups) {
            const maskIndex = Number.isInteger(group.maskArchetypeIndex)
                ? group.maskArchetypeIndex
                : (Number.isInteger(group.fieldArchetypeIndex) ? group.fieldArchetypeIndex : -1);
            if (maskIndex < 0) continue;

            const rep = entry.archetypeRepresentations?.[maskIndex];
            if (!rep || rep === ASSET_BAKE_REPRESENTATION.INSTANCES) continue;

            const meta = this._assetBakePolicy?.getArchetypeMetadataByIndex?.(maskIndex) ?? null;
            const baseHoldDistance = Number.isFinite(group.runtimeHoldDistance)
                ? group.runtimeHoldDistance
                : (meta?.individualMaxDistance ?? 0);
            const holdScale = Number.isFinite(group.runtimeHoldScale)
                ? Math.max(1.0, group.runtimeHoldScale)
                : 1.0;
            const holdDistance = Math.max(0, baseHoldDistance * holdScale);
            const nominalDistance = Number.isFinite(entry.nominalDistance)
                ? entry.nominalDistance
                : 0;

            if (holdDistance > 0 && nominalDistance < holdDistance) {
                continue;
            }

            if (rep !== ASSET_BAKE_REPRESENTATION.INSTANCES) {
                mask = mask & (~group.bit >>> 0);
            }
        }
        return mask >>> 0;
    }

    _computeFieldRenderMask(entry) {
        let mask = 0;
        if (!entry || !this._groundFieldBaker?.enabled) {
            return mask;
        }
        for (const group of this._scatterGroups) {
            if (group.mode !== 'field') continue;
            const maskIndex = Number.isInteger(group.maskArchetypeIndex)
                ? group.maskArchetypeIndex
                : (Number.isInteger(group.fieldArchetypeIndex) ? group.fieldArchetypeIndex : -1);
            if (maskIndex < 0) continue;
            const rep = entry.archetypeRepresentations?.[maskIndex];
            if (
                rep === ASSET_BAKE_REPRESENTATION.INSTANCES ||
                rep === ASSET_BAKE_REPRESENTATION.FIELD
            ) {
                mask |= group.bit;
            }
        }
        return mask >>> 0;
    }

    _updateScatterGroupPolicyForEntry(entry, enqueueLayer = true) {
        if (
            !this._scatterGroupPolicyMasksCPU ||
            !this._fieldRenderMaskBuffer ||
            !this._fieldRenderMasksCPU ||
            !entry
        ) {
            return;
        }
        const layer = entry.layer >>> 0;
        if (layer >= this._scatterGroupPolicyMasksCPU.length) {
            return;
        }
        const mask = this._computeScatterGroupPolicyMask(entry);
        const fieldMask = this._computeFieldRenderMask(entry);
        if (
            this._scatterGroupPolicyMasksCPU[layer] === mask &&
            this._fieldRenderMasksCPU[layer] === fieldMask
        ) {
            return;
        }
        this._scatterGroupPolicyMasksCPU[layer] = mask;
        this._fieldRenderMasksCPU[layer] = fieldMask;
        if (this._scatterGroupPolicyMaskBuffer) {
            this.device.queue.writeBuffer(
                this._scatterGroupPolicyMaskBuffer,
                layer * Uint32Array.BYTES_PER_ELEMENT,
                new Uint32Array([mask])
            );
        }
        this.device.queue.writeBuffer(
            this._fieldRenderMaskBuffer,
            layer * Uint32Array.BYTES_PER_ELEMENT,
            new Uint32Array([fieldMask])
        );
        if (enqueueLayer && this._usesLegacyScatterPath()) {
            this._scatterGroupPendingLayers.add(layer);
        }
        this._scatterGroupActivityDirty = true;
        this._fieldActivityDirty = true;
        this._rebuildFieldLayerState();
    }

    _rebuildFieldLayerState() {
        if (!this._fieldActiveLayersCPU || !this._fieldLayerMetaCPU || !this._fieldRenderMasksCPU) {
            this._fieldActiveLayerCount = 0;
            return;
        }

        this._fieldActiveLayersCPU.fill(0);
        this._fieldLayerMetaCPU.fill(0);

        const entries = this._bakedAssetTileCache?.getEntries?.() ?? [];
        let activeLayerCount = 0;
        let activeBits = 0;

        for (const entry of entries) {
            if (!entry) continue;
            const layer = entry.layer >>> 0;
            if (layer >= this._fieldRenderMasksCPU.length) continue;

            const fieldMask = this._fieldRenderMasksCPU[layer] >>> 0;
            if (fieldMask === 0) continue;

            this._fieldActiveLayersCPU[activeLayerCount++] = layer;
            activeBits |= fieldMask;

            const base = layer * FIELD_LAYER_META_U32_STRIDE;
            this._fieldLayerMetaCPU[base + 0] = entry.face >>> 0;
            this._fieldLayerMetaCPU[base + 1] = entry.depth >>> 0;
            this._fieldLayerMetaCPU[base + 2] = entry.x >>> 0;
            this._fieldLayerMetaCPU[base + 3] = entry.y >>> 0;
            this._fieldLayerMetaCPU[base + 4] = 1;
        }

        this._fieldActiveLayerCount = activeLayerCount;
        this._fieldActiveBits = activeBits >>> 0;
        this._fieldActivityDirty = false;

        if (this._fieldActiveLayerBuffer) {
            this.device.queue.writeBuffer(this._fieldActiveLayerBuffer, 0, this._fieldActiveLayersCPU);
        }
        if (this._fieldLayerMetaBuffer) {
            this.device.queue.writeBuffer(this._fieldLayerMetaBuffer, 0, this._fieldLayerMetaCPU);
        }
    }

_dispatchScatterGroupMaskBakes(commandEncoder) {
    if (!this._hasLegacyRuntimeGroundScatter()) return;
    if (!this._scatterGroupMaskBakePipeline || !this._scatterGroupMaskBakeBindGroup) return;
    if (this._scatterGroupPendingLayers.size === 0) return;

    const pendingLayers = Uint32Array.from(this._scatterGroupPendingLayers);
    this._scatterGroupPendingLayers.clear();

    this.device.queue.writeBuffer(this._scatterGroupPendingLayersBuffer, 0, pendingLayers);
    this.device.queue.writeBuffer(
        this._scatterGroupMaskBakeConfigBuffer,
        0,
        new Uint32Array([pendingLayers.length, this._assetSelectionBuffer.maxTileType, 0, 0])
    );

    const pass = commandEncoder.beginComputePass({ label: 'AssetScatterGroupMaskBake' });
    pass.setPipeline(this._scatterGroupMaskBakePipeline);
    pass.setBindGroup(0, this._scatterGroupMaskBakeBindGroup);
    pass.dispatchWorkgroups(pendingLayers.length);
    pass.end();
}

/**
 * Dispatch queued AO bakes. Needs the scatter + tile textures for the
 * bake bind group; those are the same GPU textures the scatter pass uses
 * so we just pull them from the tile streamer.
 */
_dispatchAOBakes(commandEncoder) {
    if (!this._aoBaker?.enabled) return;
    if (this._aoBaker.pendingBakes === 0) return;

    const arr = this.tileStreamer.getArrayTextures();
    const scatterGPU = arr?.scatter?._gpuTexture?.texture;
    const tileGPU    = arr?.tile?._gpuTexture?.texture;

    this._aoBaker.update(commandEncoder, scatterGPU, tileGPU);
}

_dispatchGroundFieldBakes(commandEncoder) {
    if (!this._groundFieldBaker?.enabled) return false;
    if (this._groundFieldBaker.pendingBakes === 0) return false;

    const arr = this.tileStreamer.getArrayTextures();
    const climateGPU = arr?.climate?._gpuTexture?.texture;
    const tileGPU = arr?.tile?._gpuTexture?.texture;
    if (!climateGPU || !tileGPU) return false;

    this._groundFieldBaker.update(commandEncoder, climateGPU, tileGPU);
    return true;
}

_dispatchGroundPropBakes(commandEncoder) {
    if (!this._groundPropCache?.enabled) return false;
    if (!this._groundPropBakePipeline || !this._groundPropBakeBindGroup) return false;
    if (this._groundPropCache.pendingBakes === 0) return false;

    const batch = this._groundPropCache.popBakeBatch();
    if (!batch || batch.length === 0) return false;

    const data = new Uint32Array(batch.length * 8);
    for (let i = 0; i < batch.length; i++) {
        const offset = i * 8;
        const tile = batch[i];
        data[offset + 0] = tile.face >>> 0;
        data[offset + 1] = tile.depth >>> 0;
        data[offset + 2] = tile.tileX >>> 0;
        data[offset + 3] = tile.tileY >>> 0;
        data[offset + 4] = tile.layer >>> 0;
        data[offset + 5] = tile.flags >>> 0;
        data[offset + 6] = 0;
        data[offset + 7] = 0;
    }
    this.device.queue.writeBuffer(this._groundPropBakeTileBuffer, 0, data);

    const paramData = new ArrayBuffer(256);
    const f32 = new Float32Array(paramData);
    const u32 = new Uint32Array(paramData);
    f32[0] = this.planetConfig.origin?.x ?? 0;
    f32[1] = this.planetConfig.origin?.y ?? 0;
    f32[2] = this.planetConfig.origin?.z ?? 0;
    // Matches the existing ScatterParams packing used successfully elsewhere:
    // vec3 + scalar share one 16-byte block.
    f32[3] = this.planetConfig.radius ?? 0;
    f32[4] = this.planetConfig.heightScale ?? this.planetConfig.maxHeight ?? 0;
    f32[5] = this.quadtreeGPU?.faceSize ?? (this.planetConfig.radius * 2);
    u32[6] = this.engineConfig.seed >>> 0;
    u32[7] = batch.length >>> 0;
    this.device.queue.writeBuffer(this._groundPropBakeParamBuffer, 0, paramData);

    const pass = commandEncoder.beginComputePass({ label: 'GroundProp-Bake' });
    pass.setPipeline(this._groundPropBakePipeline);
    pass.setBindGroup(0, this._groundPropBakeBindGroup);
    pass.dispatchWorkgroups(batch.length);
    pass.end();
    return true;
}

_dispatchTreeSourceBakes(commandEncoder) {
    if (!this._treeSourceCache?.enabled) return false;
    if (!this._treeSourceBakePipeline || !this._treeSourceBakeBindGroup) return false;
    if (this._treeSourceCache.pendingBakes === 0) return false;

    const batch = this._treeSourceCache.popBakeBatch();
    if (!batch || batch.length === 0) return false;

    const data = new Uint32Array(batch.length * 8);
    for (let i = 0; i < batch.length; i++) {
        const offset = i * 8;
        const tile = batch[i];
        data[offset + 0] = tile.face >>> 0;
        data[offset + 1] = tile.depth >>> 0;
        data[offset + 2] = tile.tileX >>> 0;
        data[offset + 3] = tile.tileY >>> 0;
        data[offset + 4] = tile.layer >>> 0;
        data[offset + 5] = tile.flags >>> 0;
        data[offset + 6] = 0;
        data[offset + 7] = 0;
    }
    this.device.queue.writeBuffer(this._treeSourceBakeTileBuffer, 0, data);

    const paramData = new ArrayBuffer(256);
    const f32 = new Float32Array(paramData);
    const u32 = new Uint32Array(paramData);
    f32[0] = this.planetConfig.origin?.x ?? 0;
    f32[1] = this.planetConfig.origin?.y ?? 0;
    f32[2] = this.planetConfig.origin?.z ?? 0;
    f32[3] = this.planetConfig.radius ?? 0;
    f32[4] = this.planetConfig.heightScale ?? this.planetConfig.maxHeight ?? 0;
    f32[5] = this.quadtreeGPU?.faceSize ?? (this.planetConfig.radius * 2);
    u32[6] = this.engineConfig.seed >>> 0;
    u32[7] = batch.length >>> 0;
    this.device.queue.writeBuffer(this._treeSourceBakeParamBuffer, 0, paramData);

    const pass = commandEncoder.beginComputePass({ label: 'TreeSource-Bake' });
    pass.setPipeline(this._treeSourceBakePipeline);
    pass.setBindGroup(0, this._treeSourceBakeBindGroup);
    pass.dispatchWorkgroups(batch.length);
    pass.end();
    this._treeSourceCache.markBakeBatchSubmitted(batch);
    return true;
}

/**
 * Exposed for asset self-occlusion later: asset shaders can sample this
 * same mask at their instance's face-UV to darken leaves/bark under
 * neighbouring canopies.
 */
getTerrainAOTexture() {
    return this._aoBaker?.getAOTextureWrapper() ?? null;
}

getGroundFieldTexture() {
    return this._groundFieldBaker?.getFieldTextureWrapper() ?? null;
}

    _refreshActiveScatterGroupBits() {
        if (!this._hasLegacyRuntimeGroundScatter()) {
            this._scatterGroupActiveBits = 0;
            this._scatterGroupActivityDirty = false;
            return;
        }
        if (!this._scatterGroupActivityDirty) return;
        const entries = this._bakedAssetTileCache?.getEntries?.() ?? [];
        let activeBits = 0;
        for (const entry of entries) {
            if (!entry) continue;
            activeBits |= this._computeScatterGroupPolicyMask(entry);
        }
        this._scatterGroupActiveBits = activeBits >>> 0;
        this._scatterGroupActivityDirty = false;
    }

    _refreshActiveFieldBits() {
        if (!this._fieldActivityDirty) return;
        this._rebuildFieldLayerState();
    }

    _shouldDispatchScatterPass(scatterPass) {
        if (!scatterPass) return false;
        if (!scatterPass.enableGroundPass) return true;
        if (!this._enableScatterDensityGroups) return true;
        if (!scatterPass.scatterGroupBit) return true;
        return (this._scatterGroupActiveBits & scatterPass.scatterGroupBit) !== 0;
    }

    _shouldDispatchFieldScatterPass(fieldPass) {
        if (!fieldPass?.bindGroup) return false;
        if (this._fieldActiveLayerCount <= 0) return false;
        if (!fieldPass.bit) return true;
        return (this._fieldActiveBits & fieldPass.bit) !== 0;
    }

    _usesLegacyScatterPath() {
        return false;
    }

    _hasLegacyRuntimeGroundScatter() {
        return this._usesLegacyScatterPath() && this._scatterPipelines.some(pass => pass?.enableGroundPass);
    }

    _shouldDispatchGroundPropGather() {
        return !!(
            this._groundPropCache?.enabled &&
            this._groundPropGatherPipeline &&
            this._groundPropGatherBindGroup &&
            this._groundPropCache.activeLayerCount > 0
        );
    }

    _shouldDispatchTreeSourceGather() {
        return !!(
            this._treeSourceCache?.enabled &&
            this._treeSourceGatherPipeline &&
            this._treeSourceGatherBindGroup &&
            this._treeSourceCache.activeLayerCount > 0
        );
    }

    _queueProducerDebugReadback(commandEncoder) {
        if (!this._producerDebugEnabled || !commandEncoder || !this._pool?.counterBuffer) return;
        if (this._producerDebugPending) return;

        if (this._producerDebugQueued) {
            this._kickProducerDebugReadback();
            return;
        }

        if ((this._frameCount % this._producerDebugInterval) !== 0) return;

        this._ensureProducerDebugReadbackBuffers();
        if (!this._producerDebugPoolReadbackBuffer) return;

        const poolBytes = Math.max(4, this._totalBands * Uint32Array.BYTES_PER_ELEMENT);
        commandEncoder.copyBufferToBuffer(
            this._pool.counterBuffer,
            0,
            this._producerDebugPoolReadbackBuffer,
            0,
            poolBytes
        );

        this._producerDebugHasGroundPropSnapshot = false;
        if (
            this._groundPropCache?.enabled &&
            this._groundPropCache.counterBuffer &&
            this._producerDebugGroundPropReadbackBuffer
        ) {
            const propBytes = Math.max(
                4,
                (this.tileStreamer?.tilePoolSize ?? 1) * Uint32Array.BYTES_PER_ELEMENT
            );
            commandEncoder.copyBufferToBuffer(
                this._groundPropCache.counterBuffer,
                0,
                this._producerDebugGroundPropReadbackBuffer,
                0,
                propBytes
            );
            this._producerDebugHasGroundPropSnapshot = true;
        }

        this._producerDebugQueued = true;
    }

    _ensureProducerDebugReadbackBuffers() {
        if (!this._producerDebugPoolReadbackBuffer) {
            this._producerDebugPoolReadbackBuffer = this.device.createBuffer({
                label: 'AssetStreamer-ProducerDebug-Pool',
                size: Math.max(256, this._totalBands * Uint32Array.BYTES_PER_ELEMENT),
                usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
            });
        }
        if (this._groundPropCache?.enabled && !this._producerDebugGroundPropReadbackBuffer) {
            this._producerDebugGroundPropReadbackBuffer = this.device.createBuffer({
                label: 'AssetStreamer-ProducerDebug-GroundProp',
                size: Math.max(
                    256,
                    (this.tileStreamer?.tilePoolSize ?? 1) * Uint32Array.BYTES_PER_ELEMENT
                ),
                usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
            });
        }
    }

    _kickProducerDebugReadback() {
        if (!this._producerDebugQueued || this._producerDebugPending || !this._producerDebugPoolReadbackBuffer) {
            return;
        }

        const mapPromises = [this._producerDebugPoolReadbackBuffer.mapAsync(GPUMapMode.READ)];
        if (this._producerDebugHasGroundPropSnapshot && this._producerDebugGroundPropReadbackBuffer) {
            mapPromises.push(this._producerDebugGroundPropReadbackBuffer.mapAsync(GPUMapMode.READ));
        }

        this._producerDebugPending = true;
        Promise.all(mapPromises).then(() => {
            const poolBytes = Math.max(4, this._totalBands * Uint32Array.BYTES_PER_ELEMENT);
            const poolData = new Uint32Array(
                this._producerDebugPoolReadbackBuffer.getMappedRange(0, poolBytes).slice(0)
            );

            let groundPropSum = 0;
            if (this._producerDebugHasGroundPropSnapshot && this._producerDebugGroundPropReadbackBuffer) {
                const propBytes = Math.max(
                    4,
                    (this.tileStreamer?.tilePoolSize ?? 1) * Uint32Array.BYTES_PER_ELEMENT
                );
                const propData = new Uint32Array(
                    this._producerDebugGroundPropReadbackBuffer.getMappedRange(0, propBytes).slice(0)
                );
                for (let i = 0; i < propData.length; i++) {
                    groundPropSum += propData[i] >>> 0;
                }
            }

            const archetypeTotals = new Map();
            for (const bd of this._bandDescriptors ?? []) {
                if (!bd) continue;
                const key = bd.archetypeName || `band${bd.band}`;
                archetypeTotals.set(key, (archetypeTotals.get(key) ?? 0) + (poolData[bd.band] >>> 0));
            }

            const treeBandBase = CAT_TREES * LODS_PER_CATEGORY;
            const treeBandParts = [];
            let treeRawTotal = 0;
            let treeCapTotal = 0;
            let treeOverflowTotal = 0;
            let treeMaxOverflowBand = -1;
            let treeMaxOverflowCount = 0;
            for (let lod = 0; lod < LODS_PER_CATEGORY; lod++) {
                const band = treeBandBase + lod;
                const raw = poolData[band] >>> 0;
                const cap = this._pool?.getBandCapacity(band) ?? 0;
                const overflow = Math.max(0, raw - cap);
                treeRawTotal += raw;
                treeCapTotal += cap;
                treeOverflowTotal += overflow;
                if (overflow > treeMaxOverflowCount) {
                    treeMaxOverflowCount = overflow;
                    treeMaxOverflowBand = band;
                }
                treeBandParts.push(`b${band}=${raw}/${cap}`);
            }

            let fieldLayerCount = 0;
            if (this._fieldRenderMasksCPU) {
                for (let i = 0; i < this._fieldRenderMasksCPU.length; i++) {
                    if (this._fieldRenderMasksCPU[i] !== 0) fieldLayerCount++;
                }
            }

            const grass = archetypeTotals.get('grass_tuft') ?? 0;
            const rocks = archetypeTotals.get('rock_small') ?? 0;
            const fern = archetypeTotals.get('fern') ?? 0;
            const mushroom = archetypeTotals.get('mushroom_capped') ?? 0;
            const logs = archetypeTotals.get('fallen_log') ?? 0;
            const stumps = archetypeTotals.get('tree_stump') ?? 0;
            const nonTreePoolTotal = grass + rocks + fern + mushroom + logs + stumps;

            const shouldProbeGrass = grass === 0 && fieldLayerCount > 0;
            const shouldLog =
                nonTreePoolTotal === 0 ||
                shouldProbeGrass ||
                groundPropSum > 0 ||
                (this._frameCount % (this._producerDebugInterval * 2)) === 0;

            if (shouldLog) {
                Logger.warn(
                    `${this._logTag} [BakeDiag] pool(` +
                    `grass=${grass} rock=${rocks} fern=${fern} ` +
                    `mushroom=${mushroom} log=${logs} stump=${stumps}) ` +
                    `fieldLayers=${fieldLayerCount} activeFieldLayers=${this._fieldActiveLayerCount} ` +
                    `fieldBits=0x${this._fieldActiveBits.toString(16)} ` +
                    `propLayers=${this._groundPropCache?.activeLayerCount ?? 0} ` +
                    `bakedPropInstances=${groundPropSum} ` +
                    `pendingField=${this._groundFieldBaker?.pendingBakes ?? 0} ` +
                    `pendingProp=${this._groundPropCache?.pendingBakes ?? 0}`
                );

                if (nonTreePoolTotal === 0 || shouldProbeGrass) {
                    this._kickProducerTextureProbe();
                }
            }

            const shouldLogTrees =
                treeOverflowTotal > 0 ||
                treeRawTotal === 0 ||
                (this._frameCount % (this._producerDebugInterval * 2)) === 0;

            if (true || shouldLogTrees) {
                Logger.info(
                    `${this._logTag} [TreePool] ` +
                    `${treeBandParts.join(' ')} ` +
                    `total=${treeRawTotal}/${treeCapTotal} ` +
                    `overflow=${treeOverflowTotal}` +
                    (treeMaxOverflowBand >= 0 ? ` maxOverflowBand=${treeMaxOverflowBand}` : '') +
                    ` sourceLayers=${this._treeSourceCache?.activeLayerCount ?? 0}`
                );
            }

            this._producerDebugPoolReadbackBuffer.unmap();
            if (this._producerDebugHasGroundPropSnapshot && this._producerDebugGroundPropReadbackBuffer) {
                this._producerDebugGroundPropReadbackBuffer.unmap();
            }
            this._producerDebugQueued = false;
            this._producerDebugPending = false;
            this._producerDebugHasGroundPropSnapshot = false;
        }).catch((err) => {
            Logger.warn(`${this._logTag} [BakeDiag] readback failed: ${err?.message || err}`);
            try { this._producerDebugPoolReadbackBuffer?.unmap(); } catch (_) {}
            try { this._producerDebugGroundPropReadbackBuffer?.unmap(); } catch (_) {}
            this._producerDebugQueued = false;
            this._producerDebugPending = false;
            this._producerDebugHasGroundPropSnapshot = false;
        });
    }

    // ──────────────────────────────────────────────────────────────────────
    // Per-frame: render (TOTAL_BANDS indirect indexed draws)
    // ──────────────────────────────────────────────────────────────────────
    render(camera, viewMatrix, projectionMatrix) {
        if (!this._initialized) return;
        if (!this.backend._renderPassEncoder) return;

        this._updateRenderUniforms(camera, viewMatrix, projectionMatrix);
        this._maybeRebuildRenderBindGroups();

        const encoder = this.backend._renderPassEncoder;
        let currentPipeline = null;

        // ═══ INC 2: bandDescriptor-driven loop ═════════════════════════════
        // Replaces `for band < TOTAL_BANDS` + category-range suppression.
        // `isExternal` subsumes `_suppressAllTreeScatter` — tree_standard
        // has pipelineKey='externalPipeline', so its 5 bands skip here.
        // `capacity === 0` short-circuits all the Inc-3-pending archetypes.
        for (const bd of this._bandDescriptors) {
            if (bd.isExternal)      continue;
            if (bd.capacity === 0)  continue;

            const geo = this._geometries[bd.band];
            if (!geo) continue;

            // Per-archetype shadow threshold replaces global band<2 gate.
            // grass_tuft has shadowLodThreshold=0 → never gets shadow
            // (parity with pre-Inc-2; grass was at bands 10-14, threshold 2).
            const wantShadow = bd.lod < bd.shadowLodThreshold;
            const wantPipeline = wantShadow ? this._renderPipeline : this._renderPipelineNoShadow;
            if (currentPipeline !== wantPipeline) {
                currentPipeline = wantPipeline;
                encoder.setPipeline(currentPipeline);
                const groups = wantShadow ? this._renderBindGroups : this._noShadowBindGroups;
                for (let i = 0; i < groups.length; i++) encoder.setBindGroup(i, groups[i]);
            }

            encoder.setVertexBuffer(0, geo.positionBuffer);
            encoder.setVertexBuffer(1, geo.normalBuffer);
            encoder.setVertexBuffer(2, geo.uvBuffer);
            encoder.setIndexBuffer(geo.indexBuffer, 'uint16');
            encoder.drawIndexedIndirect(this._pool.indirectBuffer, this._pool.getIndirectOffset(bd.band));
        }
/*
        if (this._branchRenderer)    this._branchRenderer.render(encoder);
        if (this._treeMidNearSystem) this._treeMidNearSystem.render(encoder);
        if (this._leafStreamer && this.enableLeafRendering) this._leafStreamer.render(encoder);
        if (this._treeDetailSystem)  this._treeDetailSystem.render(encoder, camera, viewMatrix, projectionMatrix);
*/
if (this._branchRenderer)    this._branchRenderer.render(encoder);
//if (this._treeMidNearSystem) this._treeMidNearSystem.render(encoder);  
if (this._treeMidSystem)     this._treeMidSystem.render(encoder);    
if (this._clusterTreeSystem) this._clusterTreeSystem.render(encoder, camera, viewMatrix, projectionMatrix);
if (this._leafStreamer && this.enableLeafRendering) this._leafStreamer.render(encoder);

        const lodTest = this._treeDetailSystem?.getLeafLODTestSuite();
        if (lodTest?.isLocked()) lodTest.renderOverlay(encoder);
        if (lodTest?.getState() === 'capEncoded') {
            const rpe = this.backend._renderPassEncoder;
            if (rpe) { rpe.end(); this.backend._renderPassEncoder = null; }
            lodTest.renderDiagnosticAndCopy(this.backend.getCommandEncoder());
            this.backend.resumeRenderPass();
        }
    }

    _kickProducerTextureProbe() {
        if (this._producerTextureProbePending) return;
        if (!this.tileStreamer?.debugReadArrayLayerStats) return;

        let fieldLayer = -1;
        if (this._fieldRenderMasksCPU) {
            for (let i = 0; i < this._fieldRenderMasksCPU.length; i++) {
                if (this._fieldRenderMasksCPU[i] !== 0) {
                    fieldLayer = i;
                    break;
                }
            }
        }

        let propLayer = -1;
        const propRecords = this._groundPropCache?._records ?? null;
        if (propRecords) {
            for (let i = 0; i < propRecords.length; i++) {
                if (propRecords[i]?.active) {
                    propLayer = i;
                    break;
                }
            }
        }

        if (fieldLayer < 0 && propLayer < 0) return;

        const fieldEntry = fieldLayer >= 0
            ? this._bakedAssetTileCache?.getLayerEntry?.(fieldLayer) ?? null
            : null;
        const propEntry = propLayer >= 0
            ? this._bakedAssetTileCache?.getLayerEntry?.(propLayer) ?? null
            : null;

        const describeEntry = (entry, layer) => {
            if (!entry) return `layer=${layer}`;
            return `layer=${layer} f${entry.face} d${entry.depth} (${entry.x},${entry.y})`;
        };
        const fmtStats = (stats) => {
            if (!stats) return 'n/a';
            const mean = Array.isArray(stats.mean)
                ? stats.mean.map(v => Number.isFinite(v) ? v.toFixed(3) : 'nan').join(',')
                : 'n/a';
            const max = Array.isArray(stats.max)
                ? stats.max.map(v => Number.isFinite(v) ? v.toFixed(3) : 'nan').join(',')
                : 'n/a';
            const zero = Number.isFinite(stats.zeroCount) ? stats.zeroCount : 'n/a';
            return `mean=[${mean}] max=[${max}] zero=${zero}`;
        };

        this._producerTextureProbePending = true;
        Promise.all([
            fieldLayer >= 0 ? this.tileStreamer.debugReadArrayLayerStats('groundField', fieldLayer, 8) : Promise.resolve(null),
            fieldLayer >= 0 ? this.tileStreamer.debugReadArrayLayerStats('climate', fieldLayer, 8) : Promise.resolve(null),
            fieldLayer >= 0 ? this.tileStreamer.debugReadArrayLayerStats('tile', fieldLayer, 8) : Promise.resolve(null),
            propLayer >= 0 ? this.tileStreamer.debugReadArrayLayerStats('climate', propLayer, 8) : Promise.resolve(null),
            propLayer >= 0 ? this.tileStreamer.debugReadArrayLayerStats('tile', propLayer, 8) : Promise.resolve(null),
        ]).then(([fieldStats, fieldClimate, fieldTile, propClimate, propTile]) => {
            if (fieldLayer >= 0) {
                Logger.warn(
                    `${this._logTag} [BakeProbe] field ${describeEntry(fieldEntry, fieldLayer)} ` +
                    `field=${fmtStats(fieldStats)} climate=${fmtStats(fieldClimate)} tile=${fmtStats(fieldTile)}`
                );
            }
            if (propLayer >= 0) {
                Logger.warn(
                    `${this._logTag} [BakeProbe] prop ${describeEntry(propEntry, propLayer)} ` +
                    `climate=${fmtStats(propClimate)} tile=${fmtStats(propTile)}`
                );
            }
        }).catch((err) => {
            Logger.warn(`${this._logTag} [BakeProbe] failed: ${err?.message || err}`);
        }).finally(() => {
            this._producerTextureProbePending = false;
        });
    }
    triggerLODTestKey() {
        this._treeDetailSystem?.getLeafLODTestSuite()?.handleKeyPress();
    }
    triggerLODTestCapture() {
        this._treeDetailSystem?.triggerLODTestCapture();
    }
    
    setLeafLODTestEnabled(enabled) {
        if (this._treeDetailSystem) {
            this._treeDetailSystem.setTestSuiteEnabled(enabled);
        }
    }

    setMidNearRenderingEnabled(enabled) {
        this._treeMidNearSystem?.setEnabled(enabled !== false);
    }
    isLeafLODTestEnabled() {
        return this._treeDetailSystem?.isTestSuiteEnabled() ?? false;
    }
    _buildGeometries() {
        // ═══ Tree template LODs (same as before, just extracted inline) ════
        let treeLODs = null;
        if (this._templateLibrary?.templateCount > 0) {
            let repTpl = null;
            for (const tt of ['birch']) {
                const v = this._templateLibrary.getVariants(tt);
                if (v?.length) { repTpl = v[0]; break; }
            }
            if (!repTpl) {
                for (const tt of this._getActiveTreeTypes()) {
                    const v = this._templateLibrary.getVariants(tt);
                    if (v?.length) { repTpl = v[0]; break; }
                }
            }
            if (repTpl) {
                const all = TreeTrunkGeometryBuilder.buildFromTemplate(
                    repTpl, { trunkRadialSegments: 10, branchRadialSegments: 6 }
                );
                treeLODs = all.slice(0, LODS_PER_CATEGORY);
                Logger.info(
                    `${this._logTag} Tree geometry from template "${repTpl.id}" — ` +
                    `LOD0: ${treeLODs[0]?.indices?.length / 3 | 0} tris`
                );
                this._bandTemplateId = repTpl.id;
            }
        }

        // ═══ INC 2: archetype-driven build ═════════════════════════════════
        // One geometry per band. GeometryFactory dispatches by builder key.
        // Inactive archetypes (rock, fern, …) get degenerate meshes — their
        // bands exist in the indirect buffer but instanceCount stays 0.
        const ctx = { treeLODs };
        this._geometries = [];
        this._lodIndexCounts = [];

        for (const bd of this._bandDescriptors) {
            const mesh = GeometryFactory.build(bd.geometryBuilder, bd.lod, ctx);
            const indexCount = mesh.indexCount ?? mesh.indices?.length ?? 0;

            this._lodIndexCounts[bd.band] = indexCount;
            this._geometries[bd.band] = {
                positionBuffer: this._createVertexBuffer(mesh.positions, `Geo-Pos-${bd.archetypeName}-${bd.lod}`),
                normalBuffer:   this._createVertexBuffer(mesh.normals,   `Geo-Nrm-${bd.archetypeName}-${bd.lod}`),
                uvBuffer:       this._createVertexBuffer(mesh.uvs,       `Geo-UV-${bd.archetypeName}-${bd.lod}`),
                indexBuffer:    this._createIndexBuffer(mesh.indices,    `Geo-Idx-${bd.archetypeName}-${bd.lod}`),
                indexCount,
            };
        }

        // Upload per-band index counts for the indirect-args builder
        const vec4Count = Math.ceil(this._totalBands / 4);
        const countData = new Uint32Array(vec4Count * 4);
        for (let i = 0; i < this._totalBands; i++) countData[i] = this._lodIndexCounts[i] ?? 0;
        this.device.queue.writeBuffer(this._lodIndexCountBuffer, 0, countData);
    }
    _createVertexBuffer(data, label) {
        const byteLength = data?.byteLength ?? 0;
        const size = Math.max(16, byteLength);
        const buf = this.device.createBuffer({
            label,
            size,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true
        });
        const mapped = new Float32Array(buf.getMappedRange());
        if (data?.length) mapped.set(data, 0);
        buf.unmap();
        return buf;
    }

    _createIndexBuffer(data, label) {
        const byteLength = data?.byteLength ?? 0;
        const alignedSize = Math.max(16, Math.ceil(byteLength / 4) * 4);
        const buf = this.device.createBuffer({
            label,
            size: alignedSize,
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true
        });
        const mapped = new Uint16Array(buf.getMappedRange());
        if (data?.length) mapped.set(data, 0);
        buf.unmap();
        return buf;
    }

    // ──────────────────────────────────────────────────────────────────────
    // Internal: uniform buffers
    // ──────────────────────────────────────────────────────────────────────

    _createUniformBuffers() {
        // Scatter params: 16 floats padded to 256
        this._scatterParamBuffer = this.device.createBuffer({
            label: 'Asset-ScatterParams',
            size: 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });

        // Climate uniforms (shared model with terrain)
        this._climateUniformBuffer = this.device.createBuffer({
            label: 'Asset-ClimateUniforms',
            size: 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });

        // Vertex uniforms (view + proj + camera + planet + wind = ~48 floats)
        this._uniformBuffer = this.device.createBuffer({
            label: 'Asset-VertexUniforms',
            size: 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });

        // Fragment uniforms
        this._fragUniformBuffer = this.device.createBuffer({
            label: 'Asset-FragUniforms',
            size: 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });

        const vec4Count = Math.ceil(this._totalBands / 4);
        const lodIndexBytes = Math.max(256, vec4Count * 16);
        // Per-band index counts: vec4<u32> buckets
        this._lodIndexCountBuffer = this.device.createBuffer({
            label: 'Asset-LodIndexCounts',
            size: lodIndexBytes,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });

        // Loaded-table lookup params
        this._loadedTableParamsBuffer = this.device.createBuffer({
            label: 'Asset-LoadedTableParams',
            size: 8,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });

        const ltParams = new Uint32Array([
            this.quadtreeGPU.loadedTableMask,
            this.quadtreeGPU.loadedTableCapacity
        ]);
        this.device.queue.writeBuffer(this._loadedTableParamsBuffer, 0, ltParams);
    }
    _updateScatterParams(camera) {
        const data = new Float32Array(32);
        const camPos = this.uniformManager?.camera?.position || camera?.position || { x: 0, y: 0, z: 0 };
        data[0] = camPos.x;
        data[1] = camPos.y;
        data[2] = camPos.z;
        data[3] = 0;
    
        data[4] = this.planetConfig.origin.x;
        data[5] = this.planetConfig.origin.y;
        data[6] = this.planetConfig.origin.z;
        data[7] = this.planetConfig.radius;
    
        data[8] = this.planetConfig.heightScale;
    
        const maxDensity = this._assetRegistry?.maxDensity ?? 0.000001;
        data[9] = maxDensity;
    
        const quadtreeFaceSize = this.quadtreeGPU?.faceSize;
        const minTileSize = this.engineConfig?.gpuQuadtree?.minTileSizeMeters;
        const maxDepth = this.quadtreeGPU?.maxDepth;
        data[10] = Number.isFinite(quadtreeFaceSize)
            ? quadtreeFaceSize
            : (Number.isFinite(minTileSize) && Number.isFinite(maxDepth)
                ? minTileSize * Math.pow(2, maxDepth)
                : this.planetConfig.radius * 2); // faceSize
    
        const u32View = new Uint32Array(data.buffer);
        u32View[11] = this.engineConfig.seed;
    
        data[12] = performance.now() / 1000.0;
        u32View[13] = this.quadtreeGPU.maxVisibleTiles;
        data[14] = 0;
        data[15] = 0;
    
        // View-projection matrix (offsets 16-31)
        if (camera?.matrixWorldInverse && camera?.projectionMatrix) {
            const v = camera.matrixWorldInverse.elements;
            const p = camera.projectionMatrix.elements;
            for (let c = 0; c < 4; c++) {
                for (let r = 0; r < 4; r++) {
                    let sum = 0;
                    for (let k = 0; k < 4; k++) {
                        sum += p[r + k * 4] * v[k + c * 4];
                    }
                    data[16 + c * 4 + r] = sum;
                }
            }
        } else {
            for (let i = 16; i < 32; i++) data[i] = 0;
            data[16] = 1; data[21] = 1; data[26] = 1; data[31] = 1;
        }
    
        this.device.queue.writeBuffer(this._scatterParamBuffer, 0, data);
    }

    _updateClimateUniforms() {
        if (!this._climateUniformBuffer) return;

        const tg = this.tileStreamer?.terrainGenerator;
        const uniforms = tg?._getTerrainShaderUniforms?.() || {};
        const data = new Float32Array(48); // 12 vec4s
        let offset = 0;

        const pushVec4 = (arr) => {
            const v = Array.isArray(arr) ? arr : [0.0, 0.0, 0.0, 0.0];
            data.set(v, offset);
            offset += 4;
        };

        pushVec4(uniforms.climateParams);
        pushVec4(uniforms.climateZone0);
        pushVec4(uniforms.climateZone0Extra);
        pushVec4(uniforms.climateZone1);
        pushVec4(uniforms.climateZone1Extra);
        pushVec4(uniforms.climateZone2);
        pushVec4(uniforms.climateZone2Extra);
        pushVec4(uniforms.climateZone3);
        pushVec4(uniforms.climateZone3Extra);
        pushVec4(uniforms.climateZone4);
        pushVec4(uniforms.climateZone4Extra);

        const noiseRef = Number.isFinite(tg?.noiseReferenceRadiusM)
            ? tg.noiseReferenceRadiusM
            : (this.planetConfig?.radius ?? 6371000);
        const maxTerrainHeight = Number.isFinite(this.planetConfig?.maxTerrainHeight)
            ? this.planetConfig.maxTerrainHeight
            : 2000.0;
        data[offset + 0] = noiseRef;
        data[offset + 1] = maxTerrainHeight;
        data[offset + 2] = 0.0;
        data[offset + 3] = 0.0;

        this.device.queue.writeBuffer(this._climateUniformBuffer, 0, data);
    }
    _updateRenderUniforms(camera, viewMatrix, projectionMatrix) {
        const data = new Float32Array(48);
    
        // [0..15]  viewMatrix  (bytes 0–63)
        if (viewMatrix?.elements) data.set(viewMatrix.elements, 0);
    
        // [16..31] projectionMatrix  (bytes 64–127)
        if (projectionMatrix?.elements) data.set(projectionMatrix.elements, 16);
    
        // [32..34] cameraPosition  (bytes 128–139)
        data[32] = camera.position.x;
        data[33] = camera.position.y;
        data[34] = camera.position.z;
    
        // [35]     time — packs right after cameraPosition.z  (byte 140)
        data[35] = performance.now() / 1000.0;
    
        // [36..38] planetOrigin  (bytes 144–155)
        data[36] = this.planetConfig.origin.x;
        data[37] = this.planetConfig.origin.y;
        data[38] = this.planetConfig.origin.z;
    
        // [39]     planetRadius — packs right after planetOrigin.z  (byte 156)
        data[39] = this.planetConfig.radius;
    
        // [40..41] windDirection  (bytes 160–167)
        const envState = this.uniformManager?.currentEnvironmentState;
        data[40] = envState?.windDirection?.x ?? 1.0;
        data[41] = envState?.windDirection?.y ?? 0.0;
    
        // [42]     windStrength  (byte 168)
        data[42] = (envState?.windSpeed ?? 5.0) / 10.0;
    
        // [43]     windSpeed  (byte 172)
        data[43] = envState?.windSpeed ?? 5.0;
    
        this.device.queue.writeBuffer(this._uniformBuffer, 0, data);
    
        // ── Fragment uniforms (unchanged) ─────────────────────────────
        const fragData = new Float32Array(16);
        const u = this.uniformManager?.uniforms;
    
        fragData[0]  = u?.sunLightDirection?.value?.x ?? 0;
        fragData[1]  = u?.sunLightDirection?.value?.y ?? 1;
        fragData[2]  = u?.sunLightDirection?.value?.z ?? 0;
        fragData[3]  = u?.sunLightIntensity?.value ?? 1.0;
    
        fragData[4]  = u?.sunLightColor?.value?.r ?? 1;
        fragData[5]  = u?.sunLightColor?.value?.g ?? 1;
        fragData[6]  = u?.sunLightColor?.value?.b ?? 1;
        fragData[7]  = 0;
    
        fragData[8]  = u?.ambientLightColor?.value?.r ?? 0.3;
        fragData[9]  = u?.ambientLightColor?.value?.g ?? 0.3;
        fragData[10] = u?.ambientLightColor?.value?.b ?? 0.4;
        fragData[11] = u?.ambientLightIntensity?.value ?? 0.8;
    
        fragData[12] = u?.fogColor?.value?.r ?? 0.7;
        fragData[13] = u?.fogColor?.value?.g ?? 0.8;
        fragData[14] = u?.fogColor?.value?.b ?? 1.0;
        fragData[15] = u?.fogDensity?.value ?? 0.00005;
    
        this.device.queue.writeBuffer(this._fragUniformBuffer, 0, fragData);
    }
    
    
    _createScatterPipelines() {
        this._scatterWorkgroupSize = this._qualityConfig.scatterWorkgroupSize ?? 64;
        this._scatterBindGroupLayout = null;
        this._scatterPipelines = [];
    }

    _createFieldScatterPipelines() {
        this._fieldScatterPipelines = [];
        this._fieldScatterBindGroupLayout = null;
    }

    _createGroundPropPipelines() {
        if (!this._groundPropCache?.enabled) {
            this._groundPropBakePipeline = null;
            this._groundPropBakeBindGroupLayout = null;
            this._groundPropGatherPipeline = null;
            this._groundPropGatherBindGroupLayout = null;
            return;
        }

        const heightSampleType = gpuFormatSampleType(
            this.tileStreamer?.textureFormats?.height || 'r32float'
        );
        const tileSampleType = gpuFormatSampleType(
            this.tileStreamer?.textureFormats?.tile || 'r32float'
        );
        const normalSampleType = gpuFormatSampleType(
            this.tileStreamer?.textureFormats?.normal || 'rg8unorm'
        );
        const climateSampleType = gpuFormatSampleType(
            this.tileStreamer?.textureFormats?.climate || 'rgba8unorm'
        );

        const eligibleVariants = this._assetRegistry.getAllVariants()
            .filter(variant => this._isBakedGroundPropVariant(variant));
        const maxDensity = eligibleVariants.reduce((best, variant) => {
            return Math.max(best, Math.max(0.000001, ...(variant?.densities ?? [0.000001])));
        }, 0.000001);

        const bakeBatchSize = this._groundPropCache.maxBakesPerFrame;
        this._groundPropBakeParamBuffer = this.device.createBuffer({
            label: 'GroundProp-BakeParams',
            size: 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this._groundPropBakeTileBuffer = this.device.createBuffer({
            label: 'GroundProp-BakeTiles',
            size: Math.max(256, bakeBatchSize * 8 * Uint32Array.BYTES_PER_ELEMENT),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        this._groundPropBakeBindGroupLayout = this.device.createBindGroupLayout({
            label: 'GroundProp-BakeLayout',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 4, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: heightSampleType, viewDimension: '2d-array' } },
                { binding: 5, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: tileSampleType, viewDimension: '2d-array' } },
                { binding: 6, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: normalSampleType, viewDimension: '2d-array' } },
                { binding: 7, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: climateSampleType, viewDimension: '2d-array' } },
                { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 9, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 10, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 11, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
            ]
        });

        const bakeModule = this.device.createShaderModule({
            label: 'GroundProp-BakeShader',
            code: buildGroundPropBakeShader({
                workgroupSize: this._scatterWorkgroupSize || (this._qualityConfig.scatterWorkgroupSize ?? 64),
                lodsPerCategory: LODS_PER_CATEGORY,
                maxScatterTileWorldSize: this._groundPropCache.maxScatterTileWorldSize,
                scatterCellOversample: this._groundPropCache.scatterCellOversample,
                maxDensity,
                perLayerCapacity: this._groundPropCache.perLayerCapacity,
                densityLutTileCount: this._densityLutTileCount,
            }),
        });

        this._groundPropBakePipeline = this.device.createComputePipeline({
            label: 'GroundProp-BakePipeline',
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [this._groundPropBakeBindGroupLayout]
            }),
            compute: { module: bakeModule, entryPoint: 'main' }
        });

        this._groundPropGatherBindGroupLayout = this.device.createBindGroupLayout({
            label: 'GroundProp-GatherLayout',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
            ]
        });

        const maxScatterDistance = this._getMaxVariantDistance(
            (variant) => this._isBakedGroundPropVariant(variant),
            200.0
        );
        const gatherModule = this.device.createShaderModule({
            label: 'GroundProp-GatherShader',
            code: buildGroundPropGatherShader({
                workgroupSize: this._scatterWorkgroupSize || (this._qualityConfig.scatterWorkgroupSize ?? 64),
                totalBands: this._totalBands,
                lodsPerCategory: LODS_PER_CATEGORY,
                maxScatterDistance,
                perLayerCapacity: this._groundPropCache.perLayerCapacity,
            }),
        });

        this._groundPropGatherPipeline = this.device.createComputePipeline({
            label: 'GroundProp-GatherPipeline',
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [this._groundPropGatherBindGroupLayout]
            }),
            compute: { module: gatherModule, entryPoint: 'main' }
        });
    }

    _createTreeSourcePipelines() {
        if (!this._treeSourceCache?.enabled) {
            this._treeSourceBakePipeline = null;
            this._treeSourceBakeBindGroupLayout = null;
            this._treeSourceGatherPipeline = null;
            this._treeSourceGatherBindGroupLayout = null;
            return;
        }

        const heightSampleType = gpuFormatSampleType(
            this.tileStreamer?.textureFormats?.height || 'r32float'
        );
        const tileSampleType = gpuFormatSampleType(
            this.tileStreamer?.textureFormats?.tile || 'r32float'
        );
        const scatterSampleType = gpuFormatSampleType(
            this.tileStreamer?.textureFormats?.scatter || 'r32float'
        );

        const bakeBatchSize = this._treeSourceCache.maxBakesPerFrame;
        this._treeSourceBakeParamBuffer = this.device.createBuffer({
            label: 'TreeSource-BakeParams',
            size: 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this._treeSourceBakeTileBuffer = this.device.createBuffer({
            label: 'TreeSource-BakeTiles',
            size: Math.max(256, bakeBatchSize * 8 * Uint32Array.BYTES_PER_ELEMENT),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        this._treeSourceBakeBindGroupLayout = this.device.createBindGroupLayout({
            label: 'TreeSource-BakeLayout',
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
        const tcScatter    = this._treeConfig.scatter    || {};
        const tcBillboards = this._treeConfig.billboards || {};

        const treeVisibility = this._treeConfig._derived?.gatherCullRadius
            ?? (this._treeConfig.tierRanges?.mid?.end ?? 800);

        const bakeModule = this.device.createShaderModule({
            label: 'TreeSource-BakeShader',
            code: buildTreeSourceBakeShader({
                workgroupSize: this._scatterWorkgroupSize || (this._qualityConfig.scatterWorkgroupSize ?? 64),
                perLayerCapacity: this._treeSourceCache.perLayerCapacity,
                treeCellSize:           tcScatter.cellSize           ?? 16.0,
                treeMaxPerCell:         tcScatter.maxPerCell         ?? 4,
                treeClusterProbability: tcScatter.clusterProbability ?? 0.95,
                treeJitterScale:        tcScatter.jitterScale        ?? 0.85,
                treeDensityScale:       tcScatter.densityScale       ?? 1.0,
            }),
        });
        this._treeSourceBakePipeline = this.device.createComputePipeline({
            label: 'TreeSource-BakePipeline',
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [this._treeSourceBakeBindGroupLayout]
            }),
            compute: { module: bakeModule, entryPoint: 'main' }
        });

        this._treeSourceGatherBindGroupLayout = this.device.createBindGroupLayout({
            label: 'TreeSource-GatherLayout',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
            ]
        });
        const gatherModule = this.device.createShaderModule({
            label: 'TreeSource-GatherShader',
            code: buildTreeSourceGatherShader({
                workgroupSize: this._scatterWorkgroupSize || (this._qualityConfig.scatterWorkgroupSize ?? 64),
                totalBands: this._totalBands,
                lodsPerCategory: LODS_PER_CATEGORY,
                perLayerCapacity: this._treeSourceCache.perLayerCapacity,
                treeVisibility,
            }),
        });

        this._treeSourceGatherPipeline = this.device.createComputePipeline({
            label: 'TreeSource-GatherPipeline',
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [this._treeSourceGatherBindGroupLayout]
            }),
            compute: { module: gatherModule, entryPoint: 'main' }
        });
    }


    _createIndirectPipeline() {
        const shaderSource = buildAssetIndirectShader({ totalBands: this._totalBands });
        const module = this.device.createShaderModule({
            label: 'Asset-IndirectShader',
            code: shaderSource
        });

        this._indirectBindGroupLayout = this.device.createBindGroupLayout({
            label: 'Asset-IndirectLayout',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
            ]
        });

        this._indirectPipeline = this.device.createComputePipeline({
            label: 'Asset-IndirectPipeline',
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [this._indirectBindGroupLayout]
            }),
            compute: { module, entryPoint: 'main' }
        });
    }
    _createRenderPipeline() {


        // ── Build per-band self-occlusion parameters ─────────────────
        const soConfig = ASSET_SELF_OCCLUSION || {};
        const perBandSO = [];

        if (soConfig.enabled !== false) {

            // Build a map from band index to the dominant asset's self-occlusion config.
            // For simplicity, use the first asset that maps to each category.
            const perBandSO = new Array(this._totalBands);
            if (soConfig.enabled !== false) {
                const variants = this._assetRegistry.getAllVariants();
                const def = soConfig.default || {};
                for (const bd of this._bandDescriptors) {
                    const repVariant = variants.find(v => v?.archetypeName === bd.archetypeName);
                    const so = repVariant?.selfOcclusion ?? def;
                    perBandSO[bd.band] = {
                        gradientWidth:    so.gradientWidth    ?? def.gradientWidth    ?? 0.10,
                        strengthMul:      so.strengthMul      ?? def.strengthMul      ?? 0.7,
                        terrainEmbedding: so.terrainEmbedding ?? def.terrainEmbedding ?? 0.02,
                        darkening:        so.darkening        ?? def.darkening        ?? 0.30,
                    };
                }
            }
        }

        const tcBillboards = this._treeConfig.billboards || {};
        const treeLodDistances = this._treeConfig._derived?.treeAssetLodDistances
            || this._treeConfig.scatter?.lodDistances
            || [20, 100, 150, 380, 500];
        const treeVisibility = treeLodDistances[treeLodDistances.length - 1];

const treeFadeStart = treeVisibility * (tcBillboards.fadeStartRatio ?? 0.7);
const treeFadeEnd   = treeVisibility * (tcBillboards.fadeEndRatio   ?? 1.0);


        const vsSource = buildAssetVertexShader({
            windMaxDistance:       30,
            windFadeDistance:      10,
            lodsPerArchetype:      LODS_PER_CATEGORY,            // all archetypes have lodCount=5
            treeBillboardLodStart: tcBillboards.lodStart ?? 3,
            archetypeFlags:        this._archetypeFlags,
        });

        const maxDist       = this._assetRegistry?.maxDistance ?? 800;


        const fragConfig = {
            fadeStart:        maxDist * 0.75,
            fadeEnd:          maxDist * 0.95,
            treeFadeStart,
            treeFadeEnd,
            treeFarBand: tcBillboards.lodEnd ?? 4,        // still band 4 (tree LOD 4)
            totalBands:       this._totalBands,
            lodsPerArchetype: LODS_PER_CATEGORY,
            archetypeFlags:   this._archetypeFlags,
            selfOcclusion: {
                enabled:         soConfig.enabled !== false,
                masterStrength:  soConfig.masterStrength ?? 1.0,
                ambientStrength: soConfig.ambientStrength ?? 1.0,
                directStrength:  soConfig.directStrength ?? 0.4,
                perBand:         perBandSO,
            },
        };

        // Two fragment shader variants: with and without shadows
        const fsShadowSource   = buildAssetFragmentShader({ ...fragConfig, enableShadows: true });
        const fsNoShadowSource = buildAssetFragmentShader({ ...fragConfig, enableShadows: false });

        const vsModule         = this.device.createShaderModule({ label: 'Asset-VS', code: vsSource });
        const fsShadowModule   = this.device.createShaderModule({ label: 'Asset-FS-Shadow', code: fsShadowSource });
        const fsNoShadowModule = this.device.createShaderModule({ label: 'Asset-FS-NoShadow', code: fsNoShadowSource });

        const group0Layout = this.device.createBindGroupLayout({
            label: 'Asset-RenderGroup0',
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
            ]
        });

        const group1Layout = this.device.createBindGroupLayout({
            label: 'Asset-RenderGroup1',
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            ]
        });

        // Group 2 with shadow bindings (close bands)
        const group2ShadowLayout = this.device.createBindGroupLayout({
            label: 'Asset-RenderGroup2-Shadow',
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
                { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
                { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
                { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
                { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
                { binding: 7, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
                { binding: 8, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            ]
        });

        // Group 2 without shadow bindings (far bands)
        const group2NoShadowLayout = this.device.createBindGroupLayout({
            label: 'Asset-RenderGroup2-NoShadow',
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
                { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            ]
        });

        const group3Layout = this.device.createBindGroupLayout({
            label: 'AssetStreamer-PropTex-Layout',
            entries: [
                {   // prop atlas (2d array)
                    binding: 0,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: { sampleType: 'float', viewDimension: '2d-array' },
                },
                {   // linear repeating sampler
                    binding: 1,
                    visibility: GPUShaderStage.FRAGMENT,
                    sampler: { type: 'filtering' },
                },
                {   // variant def storage (same buffer scatter reads)
                    binding: 2,
                    visibility: GPUShaderStage.FRAGMENT,
                    buffer: { type: 'read-only-storage' },
                },
            ],
        });
        this._propTexGroupLayout = group3Layout;

        this._renderBindGroupLayouts = [group0Layout, group1Layout, group2ShadowLayout, group3Layout];
        this._noShadowBindGroupLayouts = [group0Layout, group1Layout, group2NoShadowLayout, group3Layout];

        const canvasFormat = navigator.gpu.getPreferredCanvasFormat();

        const depthState = { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' };

        const vertexState = {
            module: vsModule,
            entryPoint: 'main',
            buffers: [
                { arrayStride: 12, stepMode: 'vertex', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
                { arrayStride: 12, stepMode: 'vertex', attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
                { arrayStride: 8,  stepMode: 'vertex', attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x2' }] },
            ]
        };

        const fragmentTargets = [{
            format: canvasFormat,
            blend: {
                color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                alpha: { srcFactor: 'one',       dstFactor: 'one-minus-src-alpha', operation: 'add' }
            }
        }];

        const primitiveState = { topology: 'triangle-list', cullMode: 'none', frontFace: 'ccw' };

        // Pipeline with shadows (close bands 0-1)
        this._renderPipeline = this.device.createRenderPipeline({
            label: 'Asset-RenderPipeline-Shadow',
            layout: this.device.createPipelineLayout({ bindGroupLayouts: this._renderBindGroupLayouts }),
            vertex: vertexState,
            fragment: { module: fsShadowModule, entryPoint: 'main', targets: fragmentTargets },
            primitive: primitiveState,
            depthStencil: depthState
        });

        // Pipeline without shadows (far bands 2+)
        this._renderPipelineNoShadow = this.device.createRenderPipeline({
            label: 'Asset-RenderPipeline-NoShadow',
            layout: this.device.createPipelineLayout({ bindGroupLayouts: this._noShadowBindGroupLayouts }),
            vertex: vertexState,
            fragment: { module: fsNoShadowModule, entryPoint: 'main', targets: fragmentTargets },
            primitive: primitiveState,
            depthStencil: depthState
        });

    }

    _maybeRebuildScatterBindGroups() {
        if (!this._scatterPipelines.length || !this._scatterBindGroupLayout) {
            return;
        }
        const arrayTextures = this.tileStreamer.getArrayTextures();
        const heightTex = arrayTextures?.height;
        const normalTex = arrayTextures?.normal;
        const tileTex   = arrayTextures?.tile;
        const scatterTex = arrayTextures?.scatter;

        const heightGPU = heightTex?._gpuTexture?.texture;
        const normalGPU = normalTex?._gpuTexture?.texture;
        const tileGPU   = tileTex?._gpuTexture?.texture;
        const scatterGPU = scatterTex?._gpuTexture?.texture;
        if (!heightGPU || !normalGPU || !tileGPU || !scatterGPU) return;
        if (!this._assetSelectionBuffer || !this._assetSelectionBuffer.isReady()) return;

        if (this._scatterBindGroupCache.heightTex === heightGPU &&
            this._scatterBindGroupCache.normalTex === normalGPU &&
            this._scatterBindGroupCache.tileTex   === tileGPU &&
            this._scatterBindGroupCache.scatterTex === scatterGPU &&
            this._scatterBindGroupCache.bindGroups.size === this._scatterPipelines.length &&
            (!this._scatterGroupMaskBakePipeline || (
                this._scatterGroupMaskBakeBindGroupCache.tileTex === tileGPU &&
                this._scatterGroupMaskBakeBindGroupCache.bindGroup !== null
            ))) {
            for (const scatterPass of this._scatterPipelines) {
                scatterPass.bindGroup = this._scatterBindGroupCache.bindGroups.get(scatterPass.key) ?? null;
            }
            if (this._scatterGroupMaskBakePipeline) {
                this._scatterGroupMaskBakeBindGroup = this._scatterGroupMaskBakeBindGroupCache.bindGroup;
            }
            return;
        }

        const heightView = heightGPU.createView({ dimension: '2d-array' });
        const normalView = normalGPU.createView({ dimension: '2d-array' });
        const tileView   = tileGPU.createView({ dimension: '2d-array' });
        const scatterView = scatterGPU.createView({ dimension: '2d-array' });
        const bindGroups = new Map();
        for (const scatterPass of this._scatterPipelines) {
            const tileMapBuffer = this._assetSelectionBuffer.getTileMapBuffer(scatterPass.tileMapKey);
            if (!tileMapBuffer) continue;

            scatterPass.bindGroup = this.device.createBindGroup({
                layout: this._scatterBindGroupLayout,
                entries: [
                    { binding: 0, resource: { buffer: this._scatterParamBuffer } },
                    { binding: 1, resource: { buffer: this.quadtreeGPU.getVisibleTileBuffer() } },
                    { binding: 2, resource: { buffer: this._pool.instanceBuffer } },
                    { binding: 3, resource: { buffer: this._pool.counterBuffer } },
                    { binding: 4, resource: { buffer: this._pool.bandMetaBuffer } },
                    { binding: 5, resource: heightView },
                    { binding: 6, resource: tileView },
                    { binding: 7, resource: { buffer: this.quadtreeGPU.getLoadedTileTableBuffer() } },
                    { binding: 8, resource: { buffer: this._loadedTableParamsBuffer } },
                    { binding: 9, resource: { buffer: this.quadtreeGPU.getCounterBuffer() } },
                    { binding: 10, resource: { buffer: this._assetSelectionBuffer.getAssetDefBuffer() } },
                    { binding: 11, resource: { buffer: tileMapBuffer } },
                    { binding: 12, resource: { buffer: this._assetSelectionBuffer.getConfigBuffer() } },
                    { binding: 13, resource: { buffer: this._climateUniformBuffer } },
                    { binding: 14, resource: scatterView },
                    { binding: 15, resource: { buffer: this._densityLUT.getBuffer() } },
                    { binding: 16, resource: normalView },
                    { binding: 17, resource: { buffer: this._scatterGroupMaskBuffer } },
                ]
            });
            bindGroups.set(scatterPass.key, scatterPass.bindGroup);
        }

        if (this._scatterGroupMaskBakePipeline) {
            this._scatterGroupMaskBakeBindGroup = this.device.createBindGroup({
                layout: this._scatterGroupMaskBakeBindGroupLayout,
                entries: [
                    { binding: 0, resource: tileView },
                    { binding: 1, resource: { buffer: this._scatterGroupPendingLayersBuffer } },
                    { binding: 2, resource: { buffer: this._scatterGroupMaskBakeConfigBuffer } },
                    { binding: 3, resource: { buffer: this._tileTypeScatterGroupMaskBuffer } },
                    { binding: 4, resource: { buffer: this._scatterGroupPolicyMaskBuffer } },
                    { binding: 5, resource: { buffer: this._scatterGroupMaskBuffer } },
                ]
            });
        }

        this._scatterBindGroupCache.heightTex = heightGPU;
        this._scatterBindGroupCache.normalTex = normalGPU;
        this._scatterBindGroupCache.tileTex   = tileGPU;
        this._scatterBindGroupCache.scatterTex = scatterGPU;
        this._scatterBindGroupCache.bindGroups = bindGroups;
        this._scatterGroupMaskBakeBindGroupCache.tileTex = tileGPU;
        this._scatterGroupMaskBakeBindGroupCache.bindGroup = this._scatterGroupMaskBakeBindGroup;
        this._forceScatter = true;
        Logger.info(`${this._logTag} Scatter bind groups rebuilt (texture change)`);
    }

    _maybeRebuildFieldScatterBindGroups() {
        if (!this._fieldScatterPipelines.length || !this._fieldScatterBindGroupLayout) {
            return;
        }

        const arrayTextures = this.tileStreamer.getArrayTextures();
        const heightTex = arrayTextures?.height;
        const normalTex = arrayTextures?.normal;
        const tileTex = arrayTextures?.tile;
        const climateTex = arrayTextures?.climate;
        const fieldTex = this._groundFieldBaker?.getFieldTextureWrapper?.() ?? null;

        const heightGPU = heightTex?._gpuTexture?.texture;
        const normalGPU = normalTex?._gpuTexture?.texture;
        const tileGPU = tileTex?._gpuTexture?.texture;
        const climateGPU = climateTex?._gpuTexture?.texture;
        const fieldGPU = fieldTex?._gpuTexture?.texture;
        if (!heightGPU || !normalGPU || !tileGPU || !climateGPU || !fieldGPU) return;
        if (!this._assetSelectionBuffer || !this._assetSelectionBuffer.isReady()) return;
        if (!this._fieldActiveLayerBuffer || !this._fieldLayerMetaBuffer || !this._fieldRenderMaskBuffer) return;

        if (
            this._fieldScatterBindGroupCache.heightTex === heightGPU &&
            this._fieldScatterBindGroupCache.normalTex === normalGPU &&
            this._fieldScatterBindGroupCache.tileTex === tileGPU &&
            this._fieldScatterBindGroupCache.climateTex === climateGPU &&
            this._fieldScatterBindGroupCache.fieldTex === fieldGPU &&
            this._fieldScatterBindGroupCache.bindGroups.size === this._fieldScatterPipelines.length
        ) {
            for (const fieldPass of this._fieldScatterPipelines) {
                fieldPass.bindGroup = this._fieldScatterBindGroupCache.bindGroups.get(fieldPass.key) ?? null;
            }
            return;
        }

        const heightView = heightGPU.createView({ dimension: '2d-array' });
        const normalView = normalGPU.createView({ dimension: '2d-array' });
        const tileView = tileGPU.createView({ dimension: '2d-array' });
        const climateView = climateGPU.createView({ dimension: '2d-array' });
        const fieldView = fieldGPU.createView({ dimension: '2d-array' });
        const bindGroups = new Map();

        for (const fieldPass of this._fieldScatterPipelines) {
            const tileMapBuffer = this._assetSelectionBuffer.getTileMapBuffer(fieldPass.tileMapKey);
            if (!tileMapBuffer) continue;

            fieldPass.bindGroup = this.device.createBindGroup({
                layout: this._fieldScatterBindGroupLayout,
                entries: [
                    { binding: 0, resource: { buffer: this._scatterParamBuffer } },
                    { binding: 1, resource: { buffer: this._fieldActiveLayerBuffer } },
                    { binding: 2, resource: { buffer: this._pool.instanceBuffer } },
                    { binding: 3, resource: { buffer: this._pool.counterBuffer } },
                    { binding: 4, resource: { buffer: this._pool.bandMetaBuffer } },
                    { binding: 5, resource: heightView },
                    { binding: 6, resource: tileView },
                    { binding: 7, resource: { buffer: this._fieldLayerMetaBuffer } },
                    { binding: 8, resource: { buffer: this._assetSelectionBuffer.getAssetDefBuffer() } },
                    { binding: 9, resource: { buffer: tileMapBuffer } },
                    { binding: 10, resource: { buffer: this._assetSelectionBuffer.getConfigBuffer() } },
                    { binding: 11, resource: fieldView },
                    { binding: 12, resource: normalView },
                    { binding: 13, resource: climateView },
                    { binding: 14, resource: { buffer: this._fieldRenderMaskBuffer } },
                ]
            });
            bindGroups.set(fieldPass.key, fieldPass.bindGroup);
        }

        this._fieldScatterBindGroupCache.heightTex = heightGPU;
        this._fieldScatterBindGroupCache.normalTex = normalGPU;
        this._fieldScatterBindGroupCache.tileTex = tileGPU;
        this._fieldScatterBindGroupCache.climateTex = climateGPU;
        this._fieldScatterBindGroupCache.fieldTex = fieldGPU;
        this._fieldScatterBindGroupCache.bindGroups = bindGroups;
        this._forceScatter = true;
        Logger.info(`${this._logTag} Field scatter bind groups rebuilt (texture change)`);
    }

    _maybeRebuildGroundPropBakeBindGroup() {
        if (!this._groundPropBakePipeline || !this._groundPropBakeBindGroupLayout || !this._groundPropCache?.enabled) {
            return;
        }

        const arrayTextures = this.tileStreamer.getArrayTextures();
        const heightTex = arrayTextures?.height;
        const normalTex = arrayTextures?.normal;
        const tileTex = arrayTextures?.tile;
        const climateTex = arrayTextures?.climate;

        const heightGPU = heightTex?._gpuTexture?.texture;
        const normalGPU = normalTex?._gpuTexture?.texture;
        const tileGPU = tileTex?._gpuTexture?.texture;
        const climateGPU = climateTex?._gpuTexture?.texture;
        if (!heightGPU || !normalGPU || !tileGPU || !climateGPU) return;
        if (!this._assetSelectionBuffer?.isReady?.()) return;

        const instanceBuffer = this._groundPropCache.instanceBuffer;
        if (
            this._groundPropBakeBindGroupCache.heightTex === heightGPU &&
            this._groundPropBakeBindGroupCache.normalTex === normalGPU &&
            this._groundPropBakeBindGroupCache.tileTex === tileGPU &&
            this._groundPropBakeBindGroupCache.climateTex === climateGPU &&
            this._groundPropBakeBindGroupCache.instanceBuffer === instanceBuffer &&
            this._groundPropBakeBindGroupCache.bindGroup
        ) {
            this._groundPropBakeBindGroup = this._groundPropBakeBindGroupCache.bindGroup;
            return;
        }

        const tileMapBuffer = this._assetSelectionBuffer.getTileMapBuffer(this._groundPropTileMapKey);
        if (!tileMapBuffer) return;

        this._groundPropBakeBindGroup = this.device.createBindGroup({
            layout: this._groundPropBakeBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this._groundPropBakeParamBuffer } },
                { binding: 1, resource: { buffer: this._groundPropBakeTileBuffer } },
                { binding: 2, resource: { buffer: instanceBuffer } },
                { binding: 3, resource: { buffer: this._groundPropCache.counterBuffer } },
                { binding: 4, resource: heightGPU.createView({ dimension: '2d-array' }) },
                { binding: 5, resource: tileGPU.createView({ dimension: '2d-array' }) },
                { binding: 6, resource: normalGPU.createView({ dimension: '2d-array' }) },
                { binding: 7, resource: climateGPU.createView({ dimension: '2d-array' }) },
                { binding: 8, resource: { buffer: this._assetSelectionBuffer.getAssetDefBuffer() } },
                { binding: 9, resource: { buffer: tileMapBuffer } },
                { binding: 10, resource: { buffer: this._assetSelectionBuffer.getConfigBuffer() } },
                { binding: 11, resource: { buffer: this._densityLUT.getBuffer() } },
            ]
        });

        this._groundPropBakeBindGroupCache.heightTex = heightGPU;
        this._groundPropBakeBindGroupCache.normalTex = normalGPU;
        this._groundPropBakeBindGroupCache.tileTex = tileGPU;
        this._groundPropBakeBindGroupCache.climateTex = climateGPU;
        this._groundPropBakeBindGroupCache.instanceBuffer = instanceBuffer;
        this._groundPropBakeBindGroupCache.bindGroup = this._groundPropBakeBindGroup;
        this._forceScatter = true;
    }

    _maybeRebuildTreeSourceBakeBindGroup() {
        if (!this._treeSourceBakePipeline || !this._treeSourceBakeBindGroupLayout || !this._treeSourceCache?.enabled) {
            return;
        }

        const arrayTextures = this.tileStreamer.getArrayTextures();
        const heightTex = arrayTextures?.height;
        const tileTex = arrayTextures?.tile;
        const scatterTex = arrayTextures?.scatter;

        const heightGPU = heightTex?._gpuTexture?.texture;
        const tileGPU = tileTex?._gpuTexture?.texture;
        const scatterGPU = scatterTex?._gpuTexture?.texture;
        if (!heightGPU || !tileGPU || !scatterGPU) return;
        if (!this._assetSelectionBuffer?.isReady?.()) return;

        const instanceBuffer = this._treeSourceCache.instanceBuffer;
        if (
            this._treeSourceBakeBindGroupCache.heightTex === heightGPU &&
            this._treeSourceBakeBindGroupCache.tileTex === tileGPU &&
            this._treeSourceBakeBindGroupCache.scatterTex === scatterGPU &&
            this._treeSourceBakeBindGroupCache.instanceBuffer === instanceBuffer &&
            this._treeSourceBakeBindGroupCache.bindGroup
        ) {
            this._treeSourceBakeBindGroup = this._treeSourceBakeBindGroupCache.bindGroup;
            return;
        }

        const tileMapBuffer = this._assetSelectionBuffer.getTileMapBuffer(this._scatterTreeTileMapKey);
        if (!tileMapBuffer) return;

        this._treeSourceBakeBindGroup = this.device.createBindGroup({
            layout: this._treeSourceBakeBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this._treeSourceBakeParamBuffer } },
                { binding: 1, resource: { buffer: this._treeSourceBakeTileBuffer } },
                { binding: 2, resource: { buffer: instanceBuffer } },
                { binding: 3, resource: { buffer: this._treeSourceCache.counterBuffer } },
                { binding: 4, resource: heightGPU.createView({ dimension: '2d-array' }) },
                { binding: 5, resource: tileGPU.createView({ dimension: '2d-array' }) },
                { binding: 6, resource: scatterGPU.createView({ dimension: '2d-array' }) },
                { binding: 7, resource: { buffer: this._assetSelectionBuffer.getAssetDefBuffer() } },
                { binding: 8, resource: { buffer: tileMapBuffer } },
                { binding: 9, resource: { buffer: this._assetSelectionBuffer.getConfigBuffer() } },
            ]
        });

        this._treeSourceBakeBindGroupCache.heightTex = heightGPU;
        this._treeSourceBakeBindGroupCache.tileTex = tileGPU;
        this._treeSourceBakeBindGroupCache.scatterTex = scatterGPU;
        this._treeSourceBakeBindGroupCache.instanceBuffer = instanceBuffer;
        this._treeSourceBakeBindGroupCache.bindGroup = this._treeSourceBakeBindGroup;
        this._forceScatter = true;
    }

    _maybeRebuildGroundPropGatherBindGroup() {
        if (!this._groundPropGatherPipeline || !this._groundPropGatherBindGroupLayout || !this._groundPropCache?.enabled) {
            return;
        }
        if (!this._assetSelectionBuffer?.isReady?.()) return;

        const instanceBuffer = this._groundPropCache.instanceBuffer;
        const activeLayerBuffer = this._groundPropCache.activeLayerBuffer;
        const layerMetaBuffer = this._groundPropCache.layerMetaBuffer;
        const counterBuffer = this._groundPropCache.counterBuffer;
        if (!instanceBuffer || !activeLayerBuffer || !layerMetaBuffer || !counterBuffer) return;

        if (
            this._groundPropGatherBindGroupCache.instanceBuffer === instanceBuffer &&
            this._groundPropGatherBindGroupCache.activeLayerBuffer === activeLayerBuffer &&
            this._groundPropGatherBindGroupCache.layerMetaBuffer === layerMetaBuffer &&
            this._groundPropGatherBindGroupCache.counterBuffer === counterBuffer &&
            this._groundPropGatherBindGroupCache.bindGroup
        ) {
            this._groundPropGatherBindGroup = this._groundPropGatherBindGroupCache.bindGroup;
            return;
        }

        this._groundPropGatherBindGroup = this.device.createBindGroup({
            layout: this._groundPropGatherBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this._scatterParamBuffer } },
                { binding: 1, resource: { buffer: activeLayerBuffer } },
                { binding: 2, resource: { buffer: layerMetaBuffer } },
                { binding: 3, resource: { buffer: instanceBuffer } },
                { binding: 4, resource: { buffer: counterBuffer } },
                { binding: 5, resource: { buffer: this._pool.instanceBuffer } },
                { binding: 6, resource: { buffer: this._pool.counterBuffer } },
                { binding: 7, resource: { buffer: this._pool.bandMetaBuffer } },
                { binding: 8, resource: { buffer: this._assetSelectionBuffer.getAssetDefBuffer() } },
            ]
        });

        this._groundPropGatherBindGroupCache.instanceBuffer = instanceBuffer;
        this._groundPropGatherBindGroupCache.activeLayerBuffer = activeLayerBuffer;
        this._groundPropGatherBindGroupCache.layerMetaBuffer = layerMetaBuffer;
        this._groundPropGatherBindGroupCache.counterBuffer = counterBuffer;
        this._groundPropGatherBindGroupCache.bindGroup = this._groundPropGatherBindGroup;
        this._forceScatter = true;
    }

    _maybeRebuildTreeSourceGatherBindGroup() {
        if (!this._treeSourceGatherPipeline || !this._treeSourceGatherBindGroupLayout || !this._treeSourceCache?.enabled) {
            return;
        }
        if (!this._assetSelectionBuffer?.isReady?.()) return;

        const instanceBuffer = this._treeSourceCache.instanceBuffer;
        const activeLayerBuffer = this._treeSourceCache.activeLayerBuffer;
        const layerMetaBuffer = this._treeSourceCache.layerMetaBuffer;
        const counterBuffer = this._treeSourceCache.counterBuffer;
        if (!instanceBuffer || !activeLayerBuffer || !layerMetaBuffer || !counterBuffer) return;

        if (
            this._treeSourceGatherBindGroupCache.instanceBuffer === instanceBuffer &&
            this._treeSourceGatherBindGroupCache.activeLayerBuffer === activeLayerBuffer &&
            this._treeSourceGatherBindGroupCache.layerMetaBuffer === layerMetaBuffer &&
            this._treeSourceGatherBindGroupCache.counterBuffer === counterBuffer &&
            this._treeSourceGatherBindGroupCache.bindGroup
        ) {
            this._treeSourceGatherBindGroup = this._treeSourceGatherBindGroupCache.bindGroup;
            return;
        }

        this._treeSourceGatherBindGroup = this.device.createBindGroup({
            layout: this._treeSourceGatherBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this._scatterParamBuffer } },
                { binding: 1, resource: { buffer: activeLayerBuffer } },
                { binding: 2, resource: { buffer: layerMetaBuffer } },
                { binding: 3, resource: { buffer: instanceBuffer } },
                { binding: 4, resource: { buffer: counterBuffer } },
                { binding: 5, resource: { buffer: this._pool.instanceBuffer } },
                { binding: 6, resource: { buffer: this._pool.counterBuffer } },
                { binding: 7, resource: { buffer: this._pool.bandMetaBuffer } },
                { binding: 8, resource: { buffer: this._assetSelectionBuffer.getAssetDefBuffer() } },
            ]
        });

        this._treeSourceGatherBindGroupCache.instanceBuffer = instanceBuffer;
        this._treeSourceGatherBindGroupCache.activeLayerBuffer = activeLayerBuffer;
        this._treeSourceGatherBindGroupCache.layerMetaBuffer = layerMetaBuffer;
        this._treeSourceGatherBindGroupCache.counterBuffer = counterBuffer;
        this._treeSourceGatherBindGroupCache.bindGroup = this._treeSourceGatherBindGroup;
        this._forceScatter = true;
    }

        /**
     * Get the live LOD controller (for debug panels).
     * @returns {TreeLODController}
     */
        getLODController() {
            return this._lodController;
        }

    getAssetBakePolicy() {
        return this._assetBakePolicy;
    }

    getBakedAssetTileCache() {
        return this._bakedAssetTileCache;
    }
    
        /**
         * Hot-reload mid-near pipelines after LOD controller config changes.
         * Called by the debug panel.
         * @param {object} [options]
         * @param {boolean} [options.rebuildGeometry=false]
         */
        rebuildMidNearPipelines(options = {}) {
            if (this._treeMidNearSystem) {
                this._treeMidNearSystem.rebuildPipelines(options);
            }
        }
    _getCameraForward(camera) {
        if (!camera?.position || !camera?.target) return null;
        const dx = camera.target.x - camera.position.x;
        const dy = camera.target.y - camera.position.y;
        const dz = camera.target.z - camera.position.z;
        const lenSq = dx * dx + dy * dy + dz * dz;
        if (lenSq <= 1e-8) return null;
        const invLen = 1.0 / Math.sqrt(lenSq);
        return { x: dx * invLen, y: dy * invLen, z: dz * invLen };
    }

    _shouldUpdateScatter(camera) {
        if (this._forceScatter) return true;
    
        const interval = this._qualityConfig.scatterInterval ?? 2;
        const minMove = this._qualityConfig.scatterMinMove ?? 0.0;
        const minTurnAngleDeg = this._qualityConfig.scatterMinTurnAngleDeg ?? 1.5;
    
        if (interval <= 1 && minMove <= 0.0 && minTurnAngleDeg <= 0.0) return true;
    
        const frameDelta = this._lastScatterFrame < 0
            ? interval
            : (this._frameCount - this._lastScatterFrame);
        if (frameDelta >= interval) return true;
    
        if (minMove > 0.0 && this._lastScatterPosition && camera?.position) {
            const dx = camera.position.x - this._lastScatterPosition.x;
            const dy = camera.position.y - this._lastScatterPosition.y;
            const dz = camera.position.z - this._lastScatterPosition.z;
            if ((dx * dx + dy * dy + dz * dz) >= (minMove * minMove)) {
                return true;
            }
        }

        if (minTurnAngleDeg > 0.0) {
            const currentForward = this._getCameraForward(camera);
            const previousForward = this._lastScatterDirection;
            if (currentForward && previousForward) {
                const dot =
                    currentForward.x * previousForward.x +
                    currentForward.y * previousForward.y +
                    currentForward.z * previousForward.z;
                const clampedDot = Math.max(-1.0, Math.min(1.0, dot));
                const angleDeg = Math.acos(clampedDot) * (180.0 / Math.PI);
                if (angleDeg >= minTurnAngleDeg) {
                    return true;
                }
            } else if (currentForward || previousForward) {
                return true;
            }
        }
    
        return false;
    }

    _maybeRebuildIndirectBindGroup() {
        if (this._indirectBindGroupBuilt) return;

        this._indirectBindGroup = this.device.createBindGroup({
            layout: this._indirectBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this._pool.counterBuffer } },
                { binding: 1, resource: { buffer: this._pool.bandMetaBuffer } },
                { binding: 2, resource: { buffer: this._pool.indirectBuffer } },
                { binding: 3, resource: { buffer: this._lodIndexCountBuffer } },
            ]
        });

        this._indirectBindGroupBuilt = true;
    }

    _maybeRebuildRenderBindGroups() {
        const clusterBuffers = this._clusterLightBuffers;
        const shadowRenderer = this._shadowRenderer;
        const clusterKey = clusterBuffers ? 'real' : 'dummy';
        const shadowKey = shadowRenderer ? 'shadow' : 'noshadow';
        const combinedKey = `${clusterKey}_${shadowKey}`;

        if (this._renderBindGroupsBuilt && this._lastBindGroupKey === combinedKey) {
            return;
        }

        // Group 0 + 1 shared by both pipelines
        const group0 = this.device.createBindGroup({
            layout: this._renderBindGroupLayouts[0],
            entries: [
                { binding: 0, resource: { buffer: this._uniformBuffer } },
                { binding: 1, resource: { buffer: this._pool.instanceBuffer } },
            ]
        });

        const group1 = this.device.createBindGroup({
            layout: this._renderBindGroupLayouts[1],
            entries: [
                { binding: 0, resource: { buffer: this._fragUniformBuffer } },
            ]
        });

        // Clustered light resources (shared)
        const dummyStorage = this._getOrCreateDummyStorageBuffer();
        const dummyUniform = this._getOrCreateDummyUniformBuffer();

        const lightBuf   = clusterBuffers?.lightBuffer      || dummyStorage;
        const clusterBuf = clusterBuffers?.clusterBuffer    || dummyStorage;
        const indexBuf   = clusterBuffers?.lightIndexBuffer || dummyStorage;
        const paramBuf   = clusterBuffers?.paramBuffer      || dummyUniform;

        // Group 2 WITH shadows (for shadow pipeline)
        const dummyDepthView = this._getOrCreateDummyDepthTextureView();
        const shadowCascade0 = shadowRenderer?.getShadowDepthView(0) || dummyDepthView;
        const shadowCascade1 = shadowRenderer?.getShadowDepthView(1) || dummyDepthView;
        const shadowCascade2 = shadowRenderer?.getShadowDepthView(2) || dummyDepthView;
        const shadowSampler = shadowRenderer?.getComparisonSampler() ||
            this._getOrCreateDefaultComparisonSampler();
        const shadowUniformBuf = shadowRenderer?.getCascadeUniformBuffer() || dummyUniform;

        const group2Shadow = this.device.createBindGroup({
            layout: this._renderBindGroupLayouts[2],
            entries: [
                { binding: 0, resource: { buffer: lightBuf } },
                { binding: 1, resource: { buffer: clusterBuf } },
                { binding: 2, resource: { buffer: indexBuf } },
                { binding: 3, resource: { buffer: paramBuf } },
                { binding: 4, resource: shadowCascade0 },
                { binding: 5, resource: shadowCascade1 },
                { binding: 6, resource: shadowCascade2 },
                { binding: 7, resource: shadowSampler },
                { binding: 8, resource: { buffer: shadowUniformBuf } },
            ]
        });

        // Group 2 WITHOUT shadows (for no-shadow pipeline)
        const group2NoShadow = this.device.createBindGroup({
            layout: this._noShadowBindGroupLayouts[2],
            entries: [
                { binding: 0, resource: { buffer: lightBuf } },
                { binding: 1, resource: { buffer: clusterBuf } },
                { binding: 2, resource: { buffer: indexBuf } },
                { binding: 3, resource: { buffer: paramBuf } },
            ]
        });
        if (!this._propSampler) {
            this._propSampler = this.device.createSampler({
                label: 'AssetStreamer-PropSampler',
                magFilter:    'linear',
                minFilter:    'linear',
                mipmapFilter: 'linear',
                addressModeU: 'repeat',
                addressModeV: 'repeat',
            });
        }

        // Prefer the real atlas; fall back to a 1×1×1 dummy so the
        // pipeline binds cleanly even if the manager isn't wired yet.
        let propView;
        if (this.propTextureManager?.isReady()) {
            const tex = this.propTextureManager.getPropTexture();
            // PropTextureManager wraps the GPU texture; unwrap for view.
            propView = tex._gpuTexture.texture.createView({
                dimension: '2d-array',
            });
        } else {
            if (!this._dummyPropArrayTex) {
                this._dummyPropArrayTex = this.device.createTexture({
                    label:     'AssetStreamer-DummyPropArray',
                    size:      [1, 1, 1],
                    format:    'rgba8unorm',
                    usage:     GPUTextureUsage.TEXTURE_BINDING,
                    dimension: '2d',
                });
            }
            propView = this._dummyPropArrayTex.createView({
                dimension: '2d-array',
            });
        }

        // Same buffer the scatter shader reads — already has STORAGE usage.
        // If getAssetDefBuffer() returns a wrapper, adjust to ._gpuBuffer.
        const defBuffer = this._assetSelectionBuffer.getAssetDefBuffer();

        this._renderBindGroup3 = this.device.createBindGroup({
            label:  'AssetStreamer-PropTex-BG',
            layout: this._propTexGroupLayout,
            entries: [
                { binding: 0, resource: propView },
                { binding: 1, resource: this._propSampler },
                { binding: 2, resource: { buffer: defBuffer } },
            ],
        });
        this._renderBindGroups = [group0, group1, group2Shadow, this._renderBindGroup3];
        this._noShadowBindGroups = [group0, group1, group2NoShadow, this._renderBindGroup3];
        this._renderBindGroupsBuilt = true;
        this._lastBindGroupKey = combinedKey;
    }

    // Add dummy depth texture helper:
    _getOrCreateDummyDepthTextureView() {
        if (!this._dummyDepthTexture) {
            this._dummyDepthTexture = this.device.createTexture({
                label: 'Asset-DummyDepthTex',
                size: [1, 1],
                format: 'depth32float',
                usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
            });
            this._dummyDepthTextureView = this._dummyDepthTexture.createView();
            // Clear to 1.0
            const enc = this.device.createCommandEncoder();
            enc.beginRenderPass({
                colorAttachments: [],
                depthStencilAttachment: {
                    view: this._dummyDepthTextureView,
                    depthClearValue: 1.0,
                    depthLoadOp: 'clear',
                    depthStoreOp: 'store'
                }
            }).end();
            this.device.queue.submit([enc.finish()]);
        }
        return this._dummyDepthTextureView;
    }

    _getOrCreateDefaultComparisonSampler() {
        if (!this._defaultComparisonSampler) {
            this._defaultComparisonSampler = this.device.createSampler({
                compare: 'less',
                magFilter: 'linear',
                minFilter: 'linear',
                addressModeU: 'clamp-to-edge',
                addressModeV: 'clamp-to-edge'
            });
        }
        return this._defaultComparisonSampler;
    }

    // Add setter for shadow renderer:
    setShadowRenderer(renderer) {
        if (this._shadowRenderer !== renderer) {
            this._shadowRenderer = renderer;
            this._renderBindGroupsBuilt = false;
        }
    }
    // ──────────────────────────────────────────────────────────────────────
    // Helpers
    // ──────────────────────────────────────────────────────────────────────
    _getOrCreateDummyStorageBuffer() {
        if (!this._dummyStorageBuffer) {
            this._dummyStorageBuffer = this.device.createBuffer({
                label: 'Asset-DummyStorage',
                size: 256,
                usage: GPUBufferUsage.STORAGE
            });
        }
        return this._dummyStorageBuffer;
    }
    
    _getOrCreateDummyUniformBuffer() {
        if (!this._dummyUniformBuffer) {
            this._dummyUniformBuffer = this.device.createBuffer({
                label: 'Asset-DummyUniform',
                size: 256,
                usage: GPUBufferUsage.UNIFORM
            });
        }
        return this._dummyUniformBuffer;
    }
    setClusterLightBuffers(buffers) {
        if (this._clusterLightBuffers !== buffers) {
            this._clusterLightBuffers = buffers;
            this._renderBindGroupsBuilt = false; // Force rebuild
        }
    }
    _getMaxTileWorldSize() {
        const cap = this._qualityConfig?.maxScatterTileWorldSize;
        if (Number.isFinite(cap) && cap > 0) return cap;
        return this.engineConfig.gpuQuadtree.minTileSizeMeters;
    }

}
