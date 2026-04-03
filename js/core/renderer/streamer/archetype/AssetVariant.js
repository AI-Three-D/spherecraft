// js/renderer/streamer/archetype/AssetVariant.js
//
// One AssetVariant = one distinct scattered asset = one row in the GPU
// variant-def buffer. Owns everything that differs between e.g.
// grass_short and grass_tall while both share archetype grass_tuft and
// family grassland_common.
//
// The variant's global index is what the scatter shader writes into
// instance.tileTypeId. For tree variants this is the FULL 32-bit index,
// never bit-packed — closeTreeTracker.wgsl reads tree.tileTypeId as a
// plain u32 and TreeDetailSystem._buildAssetSpeciesMap indexes its
// species map with it directly.
//
// INCREMENT-1 DATA FLOW
//   Legacy variants (birch, grass_*) are constructed with identity only
//   (name, archetype, family). _adoptLegacyData() then copies
//   lodDistances/densities/sizeRange/climateRange/selfOcclusion off the
//   matching legacy AssetDefinition. One source of truth until Inc 2.
//
//   New variants (rock, fern, …) carry their own values directly from
//   archetypeDefinitions.js.

import { CollisionClass } from './CollisionClasses.js';

export class AssetVariant {
    constructor(def) {
        // ── Identity ────────────────────────────────────────────────────
        this.name          = def.name;
        this.index         = def.index ?? -1;   // registry assigns if -1
        this.archetypeName = def.archetype;
        this.familyName    = def.family;

        // ── Placement (migrated from legacy in Inc 1) ───────────────────
        this.lodDistances = def.lodDistances ? [...def.lodDistances] : null;
        this.densities    = def.densities    ? [...def.densities]    : null;
        this.tileTypes    = def.tileTypes    ? [...def.tileTypes]    : null;
        this.scatterGroupName = def.scatterGroup ?? null;

        this.sizeRange = def.sizeRange ? {
            width:  [...(def.sizeRange.width  ?? [1, 1])],
            height: [...(def.sizeRange.height ?? [1, 1])],
        } : null;

        this.climateRange = def.climateRange ? {
            temperature:   [...(def.climateRange.temperature   ?? [0, 1])],
            precipitation: [...(def.climateRange.precipitation ?? [0, 1])],
        } : null;


        this.elevationRange = AssetVariant._normRange(def.elevationRange);
        // (Re-normalize slopeRange too; overwrites the line above if present)
        this.slopeRange = AssetVariant._normRange(def.slopeRange);

        // Vertex-tint colours — grass relies on these for its whole look.
        // Scatter writes mix(base, tip, rand) into instance.colorRGB.
        this.baseColor = def.baseColor ? [...def.baseColor] : null;
        this.tipColor  = def.tipColor  ? [...def.tipColor]  : null;

        this.priority = def.priority ?? 1.0;

        this.selfOcclusion = def.selfOcclusion ? { ...def.selfOcclusion } : null;

        // ── Collision (Inc 5 wire-up) ───────────────────────────────────
        this.collisionClass   = def.collisionClass   ?? CollisionClass.NONE;
        this.blockedByClasses = def.blockedByClasses ?? 0;
        this.footprintRadius  = def.footprintRadius  ?? 0;

        // ── Texture layers (Inc 4 wire-up) ──────────────────────────────
        // -1 = no texture for this slot; fragment shader checks ≥0.
        this.textureLayerAlbedo    = def.textureLayerAlbedo    ?? -1;
        this.textureLayerSecondary = def.textureLayerSecondary ?? -1;
        this.textureLayerOverlay   = def.textureLayerOverlay   ?? -1;
        this.textureLayerNormal    = def.textureLayerNormal    ?? -1;
        this.textureLayerDetail    = def.textureLayerDetail    ?? -1;
        this.overlayStrength       = def.overlayStrength       ?? 0;
        this.normalStrength        = def.normalStrength        ?? 1;
        this.detailStrength        = def.detailStrength        ?? 1;
        // Log/stump: bark on uv.y ∈ [0, split], endcap on [split, 1].
        // Mushroom: stem below, cap above.
        this.uvRegionSplit         = def.uvRegionSplit         ?? 0;

        // ── Aux (archetype-specific; GPU float [39]) ────────────────────
        // log → branch stub count; mushroom → cap/stem ratio; others TBD.
        this.auxParam0 = def.auxParam0 ?? 0;

        
        // ── Legacy-compat adapter fields ────────────────────────────────
        // Kept so toLegacyView() can return exactly what the old
        // getAllAssets() returned. For migrated variants these are copied
        // from the legacy AssetDefinition; for new variants, supplied
        // explicitly in archetypeDefinitions.js.
        this._legacyCategory     = def._legacyCategory     ?? null;
        this._legacyGeometryType = def._legacyGeometryType ?? null;
        this._legacyId           = def._legacyId           ?? def.name;

        // If true, this def is an OVERLAY for a migrated legacy variant —
        // it should add new-model fields to an existing variant, not
        // create a new one. Registry warns if no match is found.
        this._overlayOnly = def._overlayOnly === true;

        // ── Resolved refs (populated by ArchetypeRegistry) ──────────────
        /** @type {import('./RenderArchetype.js').RenderArchetype|null} */
        this.archetype = null;
        /** @type {import('./PlacementFamily.js').PlacementFamily|null} */
        this.family = null;
    }

    /**
     * Copy placement/sizing/climate data from a legacy AssetDefinition.
     * Called by ArchetypeRegistry during migration. Does NOT overwrite
     * fields already set (explicit def wins over legacy).
     */
    _adoptLegacyData(legacy) {
        if (this.lodDistances == null && Array.isArray(legacy.lodDistances)) {
            this.lodDistances = [...legacy.lodDistances];
        }
        if (this.densities == null && Array.isArray(legacy.densities)) {
            this.densities = [...legacy.densities];
        }
        if (this.tileTypes == null && Array.isArray(legacy.tileTypes)) {
            this.tileTypes = [...legacy.tileTypes];
        }
        if (this.sizeRange == null && legacy.sizeRange) {
            this.sizeRange = {
                width:  [...(legacy.sizeRange.width  ?? [1, 1])],
                height: [...(legacy.sizeRange.height ?? [1, 1])],
            };
        }
        if (this.climateRange == null && legacy.climateRange) {
            this.climateRange = {
                temperature:   [...(legacy.climateRange.temperature   ?? [0, 1])],
                precipitation: [...(legacy.climateRange.precipitation ?? [0, 1])],
            };
        }
        if (this.selfOcclusion == null && legacy.selfOcclusion) {
            this.selfOcclusion = { ...legacy.selfOcclusion };
        }
        if (this.priority === 1.0 && Number.isFinite(legacy.priority)) {
            this.priority = legacy.priority;
        }
        if (this.elevationRange == null && Array.isArray(legacy.elevationRange)) {
            this.elevationRange = { min: legacy.elevationRange[0], max: legacy.elevationRange[1] };
        }
        if (this.slopeRange == null && Array.isArray(legacy.slopeRange)) {
            this.slopeRange = { min: legacy.slopeRange[0], max: legacy.slopeRange[1] };
        }
        if (this.baseColor == null && Array.isArray(legacy.baseColor)) {
            this.baseColor = [...legacy.baseColor];
        }
        if (this.tipColor == null && Array.isArray(legacy.tipColor)) {
            this.tipColor = [...legacy.tipColor];
        }
        // Legacy-compat fields ALWAYS take the legacy value — fidelity.
        if (legacy.category)     this._legacyCategory     = legacy.category;
        if (legacy.geometryType) this._legacyGeometryType = legacy.geometryType;
    }

       /**
     * Pack this variant into one 48-float GPU record. Layout MUST match
     * loadAssetDef() in AssetSelectionBuffer's WGSL and ASSET_DEF_FLOATS
     * in streamerConfig.
     *
     * References (archetype, family) must be RESOLVED before calling —
     * ArchetypeRegistry._resolveReferences() does this at construction.
     * For gap variants (undefined slots), ArchetypeRegistry writes a zero
     * row directly; this method isn't called.
     *
     *   [0-3]   tempMin tempMax precipMin precipMax
     *   [4-7]   elevMin elevMax slopeMin slopeMax
     *   [8-11]  widthMin widthMax heightMin heightMax
     *   [12-17] baseRGB tipRGB
     *   [18-22] lodDistances[0..4]
     *   [23-27] densities[0..4]
     *   [28]    archetypeIndex              ← scatter reads this for band calc
     *   [29]    priority
     *   [30]    placementFamilyIndex        (Inc 5)
     *   [31]    collisionClass              (Inc 5)
     *   [32]    blockedByClasses            (Inc 5)
     *   [33]    footprintRadius             (Inc 5)
     *   [34]    textureLayerAlbedo          (Inc 4)
     *   [35]    textureLayerSecondary       (Inc 4)
     *   [36]    textureLayerOverlay         (Inc 4)
     *   [37]    overlayStrength             (Inc 4)
     *   [38]    uvRegionSplit               (Inc 4)
     *   [39]    auxParam0
     *   [40]    textureLayerNormal
     *   [41]    textureLayerDetail
     *   [42]    normalStrength
     *   [43]    detailStrength
     *   [44-47] selfOcclusion (gradientWidth, strengthMul, terrainEmbedding, darkening)
     */
       toGPUData() {
        const d = new Float32Array(48);

        // Defaults mirror AssetDefinition's so migrated variants with
        // partial data still produce valid records.
        const clim  = this.climateRange   ?? { temperature: [0,1], precipitation: [0,1] };
        const elev  = this.elevationRange ?? { min: 0, max: 1 };
        const slope = this.slopeRange     ?? { min: 0, max: 1 };
        const size  = this.sizeRange      ?? { width: [1,2], height: [2,5] };
        const bc    = this.baseColor      ?? [0.3, 0.3, 0.3];
        const tc    = this.tipColor       ?? [0.5, 0.5, 0.5];
        const so    = this.selfOcclusion  ?? {
            gradientWidth: 0.10, strengthMul: 0.7,
            terrainEmbedding: 0.02, darkening: 0.30,
        };
        const lodD = this.lodDistances ?? [100, 200, 400, 600, 800];
        const dens = this.densities    ?? [0, 0, 0, 0, 0];

        // Header [0-17]
        d[0]  = clim.temperature[0];   d[1]  = clim.temperature[1];
        d[2]  = clim.precipitation[0]; d[3]  = clim.precipitation[1];
        d[4]  = elev.min;  d[5]  = elev.max;
        d[6]  = slope.min; d[7]  = slope.max;
        d[8]  = size.width[0];  d[9]  = size.width[1];
        d[10] = size.height[0]; d[11] = size.height[1];
        d[12] = bc[0]; d[13] = bc[1]; d[14] = bc[2];
        d[15] = tc[0]; d[16] = tc[1]; d[17] = tc[2];

        // LOD block [18-27]
        for (let i = 0; i < 5; i++) d[18 + i] = lodD[i] ?? (lodD[lodD.length-1] ?? 0);
        for (let i = 0; i < 5; i++) d[23 + i] = dens[i] ?? 0;

        // Trailer [28-43]
        d[28] = this.archetype?.index ?? 0;   // ← drives band selection
        d[29] = this.priority;
        d[30] = this.family?.index ?? 0;
        d[31] = this.collisionClass;
        d[32] = this.blockedByClasses;
        d[33] = this.footprintRadius;
        d[34] = this.textureLayerAlbedo;
        d[35] = this.textureLayerSecondary;
        d[36] = this.textureLayerOverlay;
        d[37] = this.overlayStrength;
        d[38] = this.uvRegionSplit;
        d[39] = this.auxParam0;
        d[40] = this.textureLayerNormal;
        d[41] = this.textureLayerDetail;
        d[42] = this.normalStrength;
        d[43] = this.detailStrength;
        d[44] = so.gradientWidth;
        d[45] = so.strengthMul;
        d[46] = so.terrainEmbedding;
        d[47] = so.darkening;

        return d;
    }
    /**
     * Duck-typed view matching the shape external callers expect from the
     * old getAllAssets(). This is NOT an AssetDefinition — no toGPUData().
     * Used for cross-checking the migration (Inc 1) and will become the
     * real adapter return value when `extends AssetRegistry` is dropped
     * (Inc 2).
     */
    toLegacyView() {
        const lodDistances = this.lodDistances ?? [];
        const densities    = this.densities    ?? [];
        return {
            id:            this._legacyId,
            category:      this._legacyCategory,
            geometryType:  this._legacyGeometryType,
            lodDistances,
            densities,
            tileTypes:     this.tileTypes ?? [],
            sizeRange:     this.sizeRange,
            climateRange:  this.climateRange,
            selfOcclusion: this.selfOcclusion ?? {},
            priority:      this.priority,
            maxDensity:    Math.max(0, ...densities, 0),
            maxDistance:   lodDistances.length ? lodDistances[lodDistances.length - 1] : 0,
        };
    }
    static _normRange(r) {
        if (!r) return null;
        if (Array.isArray(r)) return { min: r[0] ?? 0, max: r[1] ?? 1 };
        return { min: r.min ?? 0, max: r.max ?? 1 };
    }
}
