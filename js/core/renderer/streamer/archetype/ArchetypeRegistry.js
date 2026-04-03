// js/renderer/streamer/archetype/ArchetypeRegistry.js
//
// Replaces AssetRegistry as the streamer's asset database.
//
// ═══ INCREMENT-1 STRATEGY: EXTEND, DON'T REPLACE ═══════════════════════
//
//   This class extends AssetRegistry. Every inherited method —
//   getAllAssets(), buildAssetDefBuffer(), buildTileAssetMap(),
//   maxDensity, maxDistance — runs on the SAME AssetDefinition objects
//   the old registry built. AssetSelectionBuffer, the scatter shader,
//   and all tree sub-systems see zero change.
//
//   The archetype/family/variant model is built ALONGSIDE and validated
//   but nothing in the render path reads it yet. Increment 2 flips
//   buildAssetDefBuffer() to variants (28→44 floats) and drops the
//   `extends`.
//
// ═══ LEGACY MIGRATION ══════════════════════════════════════════════════
//
//   Each legacy AssetDefinition becomes an AssetVariant.
//   variant.index == legacy getAllAssets() array position == the
//   tileTypeId that scatter writes and closeTreeTracker.wgsl reads.
//   New variants (rock, fern, …) get indices AFTER legacy assets.
//
// ═══ HARD INVARIANTS (throw on violation) ══════════════════════════════
//
//   • Archetype index 0 is 'tree_standard'
//   • Variant index 0 belongs to tree_standard
//   • Archetype and family index ranges are dense (no gaps)

import { AssetRegistry } from '../AssetRegistry.js';
import { Logger } from '../../../../shared/Logger.js';
import { RenderArchetype } from './RenderArchetype.js';
import { PlacementFamily } from './PlacementFamily.js';
import { AssetVariant } from './AssetVariant.js';
import { ASSET_DEF_FLOATS } from '../streamerConfig.js';
const TAG = '[ArchetypeRegistry]';

export class ArchetypeRegistry extends AssetRegistry {
    /**
     * @param {object[]} legacyDefinitions
     *        Same as DEFAULT_ASSET_DEFINITIONS. Passed straight to
     *        AssetRegistry — legacy path unchanged.
     * @param {object} config — see archetypeDefinitions.js
     * @param {object[]} config.archetypes
     * @param {object[]} config.families
     * @param {object[]} config.variants
     * @param {object}   config.legacyMigration
     */
    constructor(legacyDefinitions, config) {
        super(legacyDefinitions);

        if (!config) {
            throw new Error(`${TAG} archetype config is required`);
        }

        /** @type {Map<string, RenderArchetype>} */
        this._archetypes = new Map();
        /** @type {RenderArchetype[]} — indexed by archetype.index */
        this._archetypesByIndex = [];

        /** @type {Map<string, PlacementFamily>} */
        this._families = new Map();
        /** @type {PlacementFamily[]} — indexed by family.index */
        this._familiesByIndex = [];

        /** @type {Map<string, AssetVariant>} */
        this._variants = new Map();
        /**
         * @type {AssetVariant[]}
         * Indexed by variant.index. THIS ORDER == GPU VARIANT BUFFER ORDER
         * == instance.tileTypeId value. Legacy-migrated variants occupy
         * indices [0, legacyCount); new variants follow.
         */
        this._variantsByIndex = [];

        this._buildArchetypes(config.archetypes || []);
        this._buildFamilies(config.families || []);
        this._migrateLegacyAssets(config.legacyMigration || {});
        this._buildExplicitVariants(config.variants || []);
        this._resolveReferences();
        this._validateModel();

        const active = this._archetypesByIndex.filter(a => a?.isActive).length;
        Logger.info(
            `${TAG} ` +
            `${this._archetypesByIndex.length} archetypes (${active} active), ` +
            `${this._familiesByIndex.length} families, ` +
            `${this._variantsByIndex.length} variants. ` +
            `Legacy path inherited (${this.getAllAssets().length} legacy assets).`
        );
    }

    // ═══════════════════════════════════════════════════════════════════
    // NEW-MODEL ACCESSORS (Inc 2+ callers; unused in Inc 1 render path)
    // ═══════════════════════════════════════════════════════════════════

    getArchetype(name)      { return this._archetypes.get(name); }
    getArchetypeByIndex(i)  { return this._archetypesByIndex[i]; }
    getAllArchetypes()      { return [...this._archetypesByIndex]; }
    get archetypeCount()    { return this._archetypesByIndex.length; }

    getFamily(name)         { return this._families.get(name); }
    getFamilyByIndex(i)     { return this._familiesByIndex[i]; }
    getAllFamilies()        { return [...this._familiesByIndex]; }
    get familyCount()       { return this._familiesByIndex.length; }

    getVariant(name)        { return this._variants.get(name); }
    getVariantByIndex(i)    { return this._variantsByIndex[i]; }
    getAllVariants()        { return [...this._variantsByIndex]; }
    get variantCount()      { return this._variantsByIndex.length; }

    /** Variants whose archetype has maxInstances > 0. */
    getActiveVariants() {
        return this._variantsByIndex.filter(v => v?.archetype?.isActive);
    }

    get totalBands() {
        let n = 0;
        for (const a of this._archetypesByIndex) if (a) n += a.lodCount;
        return n;
    }
        /**
     * Compute per-band layout from archetypes + quality budget.
     * SIDE EFFECT: sets archetype._bandStart.
     *
     * @param {number[][]} perArchetypeBudget
     *        Outer index = archetype index. Inner = per-LOD capacity.
     *        This is QUALITY_PRESETS[q].maxInstances — now archetype-keyed.
     * @returns {BandDescriptor[]} Ordered [0..totalBands). Each entry:
     *        { band, archetypeIndex, archetypeName, geometryBuilder,
     *          pipelineKey, isExternal, shadowLodThreshold, shaderFlags,
     *          lod, capacity, baseOffset }
     *
     * Band ordering is archetype-major (arch 0 LODs 0-4, then arch 1 LODs
     * 0-4, ...). With tree_standard at archetype 0 and lodCount 5, trees
     * land at bands 0-4 — the hard invariant TreeDetailSystem depends on.
     */
        computeBandDescriptors(perArchetypeBudget) {
            const out = [];
            let baseOffset = 0;
            let bandIdx = 0;
    
            for (const arch of this._archetypesByIndex) {
                if (!arch) continue;  // validation ensures density, but be safe
    
                arch._bandStart = bandIdx;
    
                const budget = perArchetypeBudget?.[arch.index] ?? [];
                for (let lod = 0; lod < arch.lodCount; lod++) {
                    const capacity = (budget[lod] ?? 0) >>> 0;
                    out.push({
                        band: bandIdx,
                        archetypeIndex: arch.index,
                        archetypeName: arch.name,
                        geometryBuilder: arch.geometryBuilder,
                        pipelineKey: arch.pipelineKey,
                        isExternal: arch.isExternal,
                        shadowLodThreshold: arch.shadowLodThreshold,
                        shaderFlags: arch.shaderFlags,
                        lod,
                        capacity,
                        baseOffset,
                    });
                    baseOffset += capacity;
                    bandIdx++;
                }
            }
    
            return out;
        }
    
           /**
     * Resolve prop-texture-id strings → atlas layer indices and write
     * them into each variant's textureLayer* fields. Call AFTER the prop
     * atlas is built (getLayerIndex returns valid indices) and BEFORE
     * AssetSelectionBuffer.upload() — or call upload() again after.
     *
     * @param {object} propTextureManager  — has getLayerIndex(id): number
     * @param {object} mapping — { variantName: { albedo?, secondary?, overlay?, normal?, detail? } }
     *        Each field is a string prop-texture-id (e.g. 'bark_birch').
     */
    assignTextureLayerIndices(propTextureManager, mapping) {
        if (!propTextureManager?.getLayerIndex) {
            Logger.warn(`${TAG} assignTextureLayerIndices: no texture manager`);
            return;
        }

        let assigned = 0, missing = 0;
        const resolve = (variant, field, propId) => {
            const idx = propTextureManager.getLayerIndex(propId);
            if (idx >= 0) {
                variant[field] = idx;
                assigned++;
            } else {
                missing++;
                Logger.warn(
                    `${TAG} variant "${variant.name}".${field}="${propId}" ` +
                    `not in atlas — layer stays -1 (vertex color fallback)`
                );
            }
        };

        for (const [variantName, slots] of Object.entries(mapping || {})) {
            const variant = this._variants.get(variantName);
            if (!variant) {
                Logger.warn(`${TAG} texture mapping for unknown variant "${variantName}"`);
                continue;
            }
            if (slots.albedo)    resolve(variant, 'textureLayerAlbedo',    slots.albedo);
            if (slots.secondary) resolve(variant, 'textureLayerSecondary', slots.secondary);
            if (slots.overlay)   resolve(variant, 'textureLayerOverlay',   slots.overlay);
            if (slots.normal)    resolve(variant, 'textureLayerNormal',    slots.normal);
            if (slots.detail)    resolve(variant, 'textureLayerDetail',    slots.detail);
        }

        Logger.info(
            `${TAG} assigned ${assigned} texture layer indices` +
            (missing ? ` (${missing} missing)` : '')
        );
    }
        /**
         * 44-float-per-row variant-def buffer, in _variantsByIndex order.
         * Variant index == row index == instance.tileTypeId (for trees) ==
         * tileAssetMap value (for all). New variants occupy rows after the
         * migrated legacy ones; they're in the buffer but never selected
         * (not in tileAssetMap) until Inc 3 populates their tile types.
         *
         * Gap rows (legacy category with no migration rule) are zero-filled.
         * archetypeIndex=0 at [28] on a zero row would route to tree bands
         * IF selected — but gaps aren't in the tile map either, so safe.
         */
        buildVariantDefBuffer() {
            const n = this._variantsByIndex.length;
            const data = new Float32Array(n * ASSET_DEF_FLOATS);
    
            for (let i = 0; i < n; i++) {
                const v = this._variantsByIndex[i];
                if (!v) continue;  // gap — leave zeros
                data.set(v.toGPUData(), i * ASSET_DEF_FLOATS);
            }
    
            return data;
        }
    
        /**
         * Per-archetype shader flag bitfields for the vertex/fragment WGSL
         * ARCHETYPE_FLAGS constant array. Index = archetype index.
         */
        getShaderFlagsArray() {
            return this._archetypesByIndex.map(a => a?.shaderFlags ?? 0);
        }

    // ═══════════════════════════════════════════════════════════════════
    // INHERITED FROM AssetRegistry — DOCUMENTED, NOT OVERRIDDEN
    //
    //   getAllAssets()        → AssetDefinition[]   (legacy objects)
    //   maxDensity            → number
    //   maxDistance           → number
    //   buildAssetDefBuffer() → Float32Array        (28-float records)
    //   buildTileAssetMap()   → { data, maxTileType, entrySize }
    //   getGeometryIndex()    → number
    //   getAssetsForTileType  getAssetsForCategory  getById  validate
    //
    //   Callers and what they read:
    //     AssetSelectionBuffer.upload     — buildAssetDefBuffer, buildTileAssetMap
    //     TreeDetailSystem._buildAssetSpeciesMap — getAllAssets → id, geometryType
    //     BranchRenderer._createRenderPipeline   — getAllAssets → category, selfOcclusion
    //     TreeMidNearSystem                      — getAllAssets
    //     AssetStreamer._verifyTreeBandAlignment — getAllAssets → category, lodDistances, id
    //     AssetStreamer._getActiveTreeTypes      — getAllAssets → category, geometryType
    //     AssetStreamer._createRenderPipeline    — getAllAssets → category, selfOcclusion
    //     AssetStreamer._updateScatterParams     — maxDensity
    //     AssetStreamer._createScatterPipeline   — maxDistance, maxDensity
    //     AssetStreamer initialize (AO baker)    — maxDensity
    // ═══════════════════════════════════════════════════════════════════

    // ═══════════════════════════════════════════════════════════════════
    // BUILD PHASES
    // ═══════════════════════════════════════════════════════════════════

    _buildArchetypes(defs) {
        for (const def of defs) {
            if (this._archetypes.has(def.name)) {
                Logger.warn(`${TAG} duplicate archetype "${def.name}" — keeping first`);
                continue;
            }
            const arch = new RenderArchetype(def);
            if (this._archetypesByIndex[arch.index]) {
                throw new Error(
                    `${TAG} archetype index collision at ${arch.index}: ` +
                    `"${this._archetypesByIndex[arch.index].name}" vs "${arch.name}"`
                );
            }
            this._archetypes.set(arch.name, arch);
            this._archetypesByIndex[arch.index] = arch;
        }
    }

    _buildFamilies(defs) {
        for (const def of defs) {
            if (this._families.has(def.name)) {
                Logger.warn(`${TAG} duplicate family "${def.name}" — keeping first`);
                continue;
            }
            const fam = new PlacementFamily(def);
            if (this._familiesByIndex[fam.index]) {
                throw new Error(
                    `${TAG} family index collision at ${fam.index}: ` +
                    `"${this._familiesByIndex[fam.index].name}" vs "${fam.name}"`
                );
            }
            this._families.set(fam.name, fam);
            this._familiesByIndex[fam.index] = fam;
        }
    }

    /**
     * Convert each legacy AssetDefinition into an AssetVariant.
     * variant.index = legacy getAllAssets() position = tileTypeId.
     */
    _migrateLegacyAssets(migration) {
        const catToArch = migration.categoryToArchetype || {};
        const catToFam  = migration.categoryToFamily    || {};

        const legacyAssets = this.getAllAssets(); // Map insertion order

        for (let i = 0; i < legacyAssets.length; i++) {
            const la = legacyAssets[i];
            const archName = catToArch[la.category];
            const famName  = catToFam[la.category];

            if (!archName) {
                Logger.warn(
                    `${TAG} legacy asset "${la.id}" (category=${la.category}) ` +
                    `has no archetype migration rule. It remains in the ` +
                    `legacy GPU path but has NO variant. Index ${i} is ` +
                    `reserved but empty in the variant table.`
                );
                // Reserve the slot so explicit variants can't take it.
                this._variantsByIndex[i] = undefined;
                continue;
            }

            const variant = new AssetVariant({
                name:      la.id,
                index:     i,
                archetype: archName,
                family:    famName,
                _legacyId: la.id,
            });
            variant._adoptLegacyData(la);

            this._variants.set(variant.name, variant);
            this._variantsByIndex[i] = variant;
        }
    }

    /**
     * Add explicitly-defined variants from archetypeDefinitions.js.
     * Three cases per def:
     *   (a) _overlayOnly && match exists  → overlay new-model fields
     *   (b) _overlayOnly && no match      → warn + skip
     *   (c) !_overlayOnly                 → new variant, index after legacy
     */
    _buildExplicitVariants(defs) {
        let nextIndex = this._variantsByIndex.length;

        for (const def of defs) {
            const existing = this._variants.get(def.name);

            if (existing) {
                // Overlay explicit fields onto the migrated variant.
                // For migrated legacy assets, explicit defs are now the live
                // tuning source when they provide placement data.
                this._overlayExplicitFields(existing, def);
                continue;
            }

            if (def._overlayOnly) {
                Logger.warn(
                    `${TAG} overlay variant "${def.name}" has no migrated ` +
                    `legacy match — skipping. Check that the name matches ` +
                    `AssetDefinition.id in DEFAULT_ASSET_DEFINITIONS.`
                );
                continue;
            }

            const index = Number.isFinite(def.index) ? def.index : nextIndex++;
            if (this._variantsByIndex[index] !== undefined) {
                // Note: !== undefined, not truthy check — a reserved-but-empty
                // slot from a failed migration is `undefined` and OK to fill,
                // but a real variant or an explicitly reserved slot is not.
                // (Currently reserved slots are also `undefined`, so this
                // check only catches actual collisions. Good enough for Inc 1.)
                const occ = this._variantsByIndex[index];
                throw new Error(
                    `${TAG} variant index collision at ${index}: ` +
                    `"${occ?.name ?? '(reserved)'}" vs "${def.name}"`
                );
            }

            const variant = new AssetVariant({ ...def, index });
            this._variants.set(variant.name, variant);
            this._variantsByIndex[index] = variant;

            if (index >= nextIndex) nextIndex = index + 1;
        }
    }

    _overlayExplicitFields(variant, def) {
        if (Array.isArray(def.lodDistances)) variant.lodDistances = [...def.lodDistances];
        if (Array.isArray(def.densities)) variant.densities = [...def.densities];
        if (Array.isArray(def.tileTypes)) variant.tileTypes = [...def.tileTypes];
        if (def.scatterGroup != null) variant.scatterGroupName = def.scatterGroup;
        if (def.sizeRange) {
            variant.sizeRange = {
                width: [...(def.sizeRange.width ?? [1, 1])],
                height: [...(def.sizeRange.height ?? [1, 1])],
            };
        }
        if (def.climateRange) {
            variant.climateRange = {
                temperature: [...(def.climateRange.temperature ?? [0, 1])],
                precipitation: [...(def.climateRange.precipitation ?? [0, 1])],
            };
        }
        if (def.elevationRange != null) {
            variant.elevationRange = Array.isArray(def.elevationRange)
                ? { min: def.elevationRange[0] ?? 0, max: def.elevationRange[1] ?? 1 }
                : { min: def.elevationRange.min ?? 0, max: def.elevationRange.max ?? 1 };
        }
        if (def.slopeRange != null) {
            variant.slopeRange = Array.isArray(def.slopeRange)
                ? { min: def.slopeRange[0] ?? 0, max: def.slopeRange[1] ?? 1 }
                : { min: def.slopeRange.min ?? 0, max: def.slopeRange.max ?? 1 };
        }
        if (Array.isArray(def.baseColor)) variant.baseColor = [...def.baseColor];
        if (Array.isArray(def.tipColor)) variant.tipColor = [...def.tipColor];
        if (def.priority != null) variant.priority = def.priority;
        if (def.selfOcclusion) variant.selfOcclusion = { ...def.selfOcclusion };

        if (def.collisionClass   != null) variant.collisionClass   = def.collisionClass;
        if (def.blockedByClasses != null) variant.blockedByClasses = def.blockedByClasses;
        if (def.footprintRadius  != null) variant.footprintRadius  = def.footprintRadius;

        if (def.textureLayerAlbedo    != null) variant.textureLayerAlbedo    = def.textureLayerAlbedo;
        if (def.textureLayerSecondary != null) variant.textureLayerSecondary = def.textureLayerSecondary;
        if (def.textureLayerOverlay   != null) variant.textureLayerOverlay   = def.textureLayerOverlay;
        if (def.overlayStrength  != null) variant.overlayStrength  = def.overlayStrength;
        if (def.textureLayerNormal    != null) variant.textureLayerNormal    = def.textureLayerNormal;
        if (def.textureLayerDetail    != null) variant.textureLayerDetail    = def.textureLayerDetail;
        if (def.normalStrength        != null) variant.normalStrength        = def.normalStrength;
        if (def.detailStrength        != null) variant.detailStrength        = def.detailStrength;
        if (def.uvRegionSplit    != null) variant.uvRegionSplit    = def.uvRegionSplit;
        if (def.auxParam0        != null) variant.auxParam0        = def.auxParam0;

        // Allow the overlay to confirm/correct archetype+family assignment
        // in case the category→archetype rule was too coarse.
        if (def.archetype && def.archetype !== variant.archetypeName) {
            Logger.info(
                `${TAG} overlay "${def.name}" reassigns archetype ` +
                `${variant.archetypeName} → ${def.archetype}`
            );
            variant.archetypeName = def.archetype;
        }
        if (def.family && def.family !== variant.familyName) {
            variant.familyName = def.family;
        }
    }

    _resolveReferences() {
        for (const fam of this._familiesByIndex) {
            if (!fam) continue;
            fam.archetype = this._archetypes.get(fam.archetypeName) ?? null;
            if (!fam.archetype) {
                Logger.warn(
                    `${TAG} family "${fam.name}" → unknown archetype ` +
                    `"${fam.archetypeName}"`
                );
            }
        }
        for (const v of this._variantsByIndex) {
            if (!v) continue;
            v.archetype = this._archetypes.get(v.archetypeName) ?? null;
            v.family    = this._families.get(v.familyName)      ?? null;
            if (!v.archetype) {
                Logger.warn(
                    `${TAG} variant "${v.name}" → unknown archetype ` +
                    `"${v.archetypeName}"`
                );
            }
        }
    }

    _validateModel() {
        const errors = [];
        const warns  = [];

        // ── HARD: archetype 0 is tree_standard ─────────────────────────
        const arch0 = this._archetypesByIndex[0];
        if (!arch0 || arch0.name !== 'tree_standard') {
            errors.push(
                `archetype index 0 must be "tree_standard" ` +
                `(got "${arch0?.name ?? 'undefined'}"). ` +
                `closeTreeTracker.wgsl computes tree source bands from ` +
                `CAT_TREES*LODS_PER_CATEGORY = 0*5 = band 0.`
            );
        }

        // ── HARD: variant 0 is a tree ──────────────────────────────────
        // Scatter writes variant index → instance.tileTypeId.
        // closeTreeTracker reads tileTypeId from tree-band instances.
        // TreeDetailSystem._buildAssetSpeciesMap indexes its species map
        // by getAllAssets() position. If legacy asset 0 isn't a tree,
        // tree instances carry tileTypeId=0 which maps to a non-tree
        // species — leaves and branches pick the wrong template.
        const var0 = this._variantsByIndex[0];
        if (!var0) {
            errors.push(
                `variant index 0 is empty. The first legacy asset in ` +
                `DEFAULT_ASSET_DEFINITIONS must be the tree.`
            );
        } else if (var0.archetypeName !== 'tree_standard') {
            errors.push(
                `variant index 0 is "${var0.name}" ` +
                `(archetype=${var0.archetypeName}, ` +
                `legacy category=${var0._legacyCategory}) but must be ` +
                `tree_standard. Reorder DEFAULT_ASSET_DEFINITIONS so the ` +
                `tree asset comes first, or fix legacyMigration.categoryToArchetype.`
            );
        }

        // ── HARD: dense archetype indices ──────────────────────────────
        for (let i = 0; i < this._archetypesByIndex.length; i++) {
            if (!this._archetypesByIndex[i]) {
                errors.push(`archetype index gap at ${i}`);
            }
        }

        // ── HARD: dense family indices ─────────────────────────────────
        for (let i = 0; i < this._familiesByIndex.length; i++) {
            if (!this._familiesByIndex[i]) {
                errors.push(`family index gap at ${i}`);
            }
        }

        // ── SOFT: variant index gaps ───────────────────────────────────
        for (let i = 0; i < this._variantsByIndex.length; i++) {
            if (!this._variantsByIndex[i]) {
                warns.push(
                    `variant index gap at ${i} (legacy asset with no ` +
                    `migration rule). Inc-2 GPU buffer needs a dummy row here.`
                );
            }
        }

        // ── SOFT: active archetypes have variants ──────────────────────
        for (const arch of this._archetypesByIndex) {
            if (!arch?.isActive) continue;
            const hasVariant = this._variantsByIndex.some(
                v => v?.archetypeName === arch.name
            );
            if (!hasVariant) {
                warns.push(
                    `active archetype "${arch.name}" has no variants — ` +
                    `it will allocate pool bands (Inc 2) but never get instances.`
                );
            }
        }

        // ── SOFT: active-archetype variants have placement data ────────
        for (const v of this._variantsByIndex) {
            if (!v || !v.archetype?.isActive) continue;
            if (!Array.isArray(v.lodDistances) || v.lodDistances.length === 0) {
                warns.push(
                    `variant "${v.name}" (active archetype ${v.archetypeName}) ` +
                    `has no lodDistances — migration may have failed.`
                );
            }
        }

        for (const w of warns) Logger.warn(`${TAG} ${w}`);
        if (errors.length > 0) {
            for (const e of errors) Logger.error(`${TAG} ${e}`);
            throw new Error(
                `${TAG} model validation failed (${errors.length} error(s)). ` +
                `These cause silent rendering corruption — refusing to continue.`
            );
        }
    }


    /**
     * Maximum density across ALL variants (legacy + new).
     * Used by scatter shader to size candidate grids.
     * @override
     */
    get maxDensity() {
        let max = super.maxDensity;  // legacy
        for (const v of this._variantsByIndex) {
            if (!v?.densities) continue;
            for (const d of v.densities) {
                if (d > max) max = d;
            }
        }
        return max;
    }

    /**
     * Maximum LOD distance across ALL variants.
     * Used by scatter shader to set culling range.
     * @override
     */
    get maxDistance() {
        let max = super.maxDistance;  // legacy
        for (const v of this._variantsByIndex) {
            if (!v?.lodDistances) continue;
            const last = v.lodDistances[v.lodDistances.length - 1];
            if (last > max) max = last;
        }
        return max;
    }

    /**
     * Build tile-type → variant-index map for GPU.
     *
     * Format: for each tile type 0..maxTileType, a fixed-size entry:
     *   [count, idx0, idx1, ..., idx(entrySize-2)]
     *
     * Merges legacy mappings with new variant tileTypes.
     *
     * @override
     * @returns {{ data: Uint32Array, maxTileType: number, entrySize: number }}
     */
    buildTileAssetMap(maxAssetsPerTile = 7, options = {}) {
        const ENTRY_SIZE = maxAssetsPerTile + 1;  
        const includeVariant = typeof options.includeVariant === 'function'
            ? options.includeVariant
            : null;

        // ── Collect tile → variants mapping ────────────────────────────
        const tileToVariants = new Map();

        // From new variants (explicit tileTypes or inherited from family)
        for (const v of this._variantsByIndex) {
            if (!v) continue;
            if (includeVariant && !includeVariant(v)) continue;

            // Get tile types: prefer variant's own, fallback to family's
            let tiles = v.tileTypes;
            if ((!tiles || tiles.length === 0) && v.family?.tileTypes) {
                tiles = v.family.tileTypes;
            }
            if (!tiles || tiles.length === 0) continue;

            for (const tileId of tiles) {
                if (!tileToVariants.has(tileId)) {
                    tileToVariants.set(tileId, []);
                }
                const list = tileToVariants.get(tileId);
                if (!list.includes(v.index)) {
                    list.push(v.index);
                }
            }
        }

        // ── Find max tile type ─────────────────────────────────────────
        let maxTileType = 0;
        for (const tileId of tileToVariants.keys()) {
            if (tileId > maxTileType) maxTileType = tileId;
        }
        // Also check legacy (parent might have higher tile types)
        const legacyMap = super.buildTileAssetMap();
        if (legacyMap.maxTileType > maxTileType) {
            maxTileType = legacyMap.maxTileType;
        }

        // ── Build flat buffer ──────────────────────────────────────────
        const numTiles = maxTileType + 1;
        const data = new Uint32Array(numTiles * ENTRY_SIZE);

        for (let t = 0; t <= maxTileType; t++) {
            const variants = tileToVariants.get(t) || [];
            const count = Math.min(variants.length, ENTRY_SIZE - 1);
            const offset = t * ENTRY_SIZE;

            data[offset] = count;
            for (let i = 0; i < count; i++) {
                data[offset + 1 + i] = variants[i];
            }
        }

        return { data, maxTileType, entrySize: ENTRY_SIZE };
    }
}
