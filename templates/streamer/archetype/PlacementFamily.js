// js/renderer/streamer/archetype/PlacementFamily.js
//
// A PlacementFamily groups variants that spawn together: same tile-type
// whitelist, same climate/slope filter, same density LUT row.
//
// Family ↔ Archetype is many-to-one: you could have two log families
// (taiga_deadwood, tropical_deadwood) both feeding fallen_log with
// different tile lists and densities.
//
// Family index becomes GPU variant-record float [30] and the ROW index
// into the dense per-tile-density LUT (Increment 5). Indices are
// hand-assigned in archetypeDefinitions.js — stability matters, append
// only.

export class PlacementFamily {
    /**
     * @param {object} def
     * @param {string} def.name
     * @param {number} def.index       Explicit. GPU float [30] + LUT row.
     * @param {string} def.archetype   RenderArchetype name.
     * @param {number[]} [def.tileTypes]
     *        Tile-type IDs where variants in this family may spawn.
     *        For Inc-1-migrated families (forest_canopy, grassland_common)
     *        this stays empty — the per-variant legacy tileTypes are still
     *        authoritative until Inc 2 hoists them here.
     * @param {Object<number,number>} [def.perTileDensityScale]
     *        Sparse { tileTypeId → multiplier }. Expanded into a dense
     *        Float32Array[familyCount × maxTileTypeId] by
     *        PlacementDensityBuffer (Inc 5). Absent keys default to 1.0.
     * @param {{temperature:[number,number], precipitation:[number,number]}} [def.climateRange]
     * @param {{min:number, max:number}} [def.slopeRange]
     */
    constructor(def) {
        this.name          = def.name;
        this.index         = def.index;
        this.archetypeName = def.archetype;

        this.tileTypes = def.tileTypes ? [...def.tileTypes] : [];
        this.scatterGroup = def.scatterGroup ?? null;

        this.perTileDensityScale = def.perTileDensityScale
            ? { ...def.perTileDensityScale }
            : null;

        this.climateRange = def.climateRange ? {
            temperature:   [...(def.climateRange.temperature   ?? [0, 1])],
            precipitation: [...(def.climateRange.precipitation ?? [0, 1])],
        } : null;

        this.slopeRange = def.slopeRange
            ? { min: def.slopeRange.min ?? 0, max: def.slopeRange.max ?? 1 }
            : null;

        /** @type {import('../../../core/renderer/streamer/archetype/RenderArchetype.js').RenderArchetype|null} Resolved post-build. */
        this.archetype = null;
    }
}
