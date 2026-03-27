// js/renderer/streamer/archetype/RenderArchetype.js
//
// A RenderArchetype is a rendering identity shared by many variants.
// It decides: which geometry builder, which pipeline, how many LODs,
// how many instance slots in the pool.
//
// It does NOT decide: where to place, how dense, what colour, what
// texture layer. Those are PlacementFamily / AssetVariant concerns.
//
// Archetype index 0 MUST be tree_standard — hard invariant.
// closeTreeTracker.wgsl and TreeDetailSystem._buildSourceBands compute
// tree band offsets as CAT_TREES(=0) * LODS_PER_CATEGORY = 0. If trees
// ever move off index 0, every tree sub-system's band math silently
// addresses the wrong instance ranges. ArchetypeRegistry._validateModel
// enforces this with a throw.

/**
 * @typedef {'externalPipeline'|'tint_blade_cutout'|'albedo_blade_cutout'|'albedo_static'} PipelineKey
 *
 *   externalPipeline
 *     Not drawn by the generic scatter-draw loop. A dedicated sub-system
 *     (BranchRenderer + TreeMidNearSystem + LeafStreamer) owns all
 *     visuals. Scatter still WRITES instances for that sub-system to
 *     consume. Replaces the _suppressAllTreeScatter bool in Inc 2.
 *
 *   tint_blade_cutout
 *     Vertex-colour tint (no albedo texture), alpha-tested blade
 *     geometry, wind sway. Grass.
 *
 *   albedo_blade_cutout
 *     Albedo-textured, alpha-tested blade, wind sway. Ferns.
 *
 *   albedo_static
 *     Albedo-textured, opaque, no wind. Rocks, mushrooms, logs, stumps.
 */

export class RenderArchetype {
    /**
     * @param {object} def
     * @param {string} def.name                Unique key, e.g. 'tree_standard'
     * @param {number} def.index               Explicit index. Tree MUST be 0.
     * @param {PipelineKey} def.pipelineKey
     * @param {string} def.geometryBuilder     GeometryFactory dispatch key (Inc 2)
     * @param {number} [def.lodCount=5]
     * @param {number} [def.maxInstances=0]
     *        Pool slot budget summed across all LODs. 0 = inactive.
     *        In Inc 1 this is a flag only (pool still uses TOTAL_BANDS);
     *        Inc 2 feeds it into AssetInstancePool bandDescriptors.
     * @param {number} [def.shadowLodThreshold=2]
     *        LODs below this get the shadow-receiving pipeline variant.
     * @param {number[]} [def.lodDistances]
     *        Far edge (metres) per LOD. If absent, pulled from first
     *        migrated variant (Inc 1) or explicitly set (Inc 2+).
     */
    constructor(def) {
        this.name            = def.name;
        this.index           = def.index;
        this.pipelineKey     = def.pipelineKey;
        this.geometryBuilder = def.geometryBuilder;
        this.lodCount        = def.lodCount ?? 5;
        this.maxInstances    = def.maxInstances ?? 0;
        this.shadowLodThreshold = def.shadowLodThreshold ?? 2;
        this.lodDistances    = def.lodDistances ? [...def.lodDistances] : null;
        this.hasWind      = def.hasWind      === true;
        this.hasBillboard = def.hasBillboard === true;
        this.hasFarDim    = def.hasFarDim    === true;
        // Set by ArchetypeRegistry after all archetypes are registered
        // and band ranges computed (Inc 2). Null until then.
        this._bandStart = null;
    }

    /** Drawn by a dedicated sub-system, skipped in the generic draw loop. */
    get isExternal() {
        return this.pipelineKey === 'externalPipeline';
    }

    /** Gets pool bands and participates in scatter. Inc 1: flag only. */
    get isActive() {
        return this.maxInstances > 0;
    }

    /** First band index in the flattened band list. Inc 2+. */
    get bandStart() {
        return this._bandStart;
    }

    /** Band range [start, start+lodCount). Inc 2+. */
    get bandEnd() {
        return this._bandStart == null ? null : this._bandStart + this.lodCount;
    }
        /**
     * Packed u32 for ARCHETYPE_FLAGS[] in assetVertex/assetFragment WGSL.
     * Bit layout must match ARCH_FLAG_* consts in those shaders.
     */
        get shaderFlags() {
            return (this.hasWind      ? 0x01 : 0)
                 | (this.hasBillboard ? 0x02 : 0)
                 | (this.hasFarDim    ? 0x04 : 0);
        }
}