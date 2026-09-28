// Explicit terrain output vocabulary (SphereCraft_Architecture_Direction.md
// §5, SphereCraft_Optimization_Implementation_Plan.md §2.1-2.2).
//
// Type strings match the existing texture-type names used throughout
// tileGenerator.js/tileStreamer.js ('tile' = classification, etc.) rather
// than inventing a parallel naming scheme — this is the same vocabulary the
// rest of the codebase already speaks, just given explicit preset grouping.
//
// GEOMETRY_TYPES is the "fast path": the minimum a tile needs before it can
// go resident and be sampled by the renderer (plan §2.3 — "a tile should
// become visually useful as soon as its minimum geometry data is ready").
// Everything else is generated afterward, in the background, as a
// refinement pass against the tile's existing array-pool layer.

export const GEOMETRY_TYPES = Object.freeze(['height', 'normal', 'tile']);

// Splat's three textures (data/index/valid) are always generated together —
// see TileGenerator's enableSplat handling — so they're grouped as one unit
// here rather than split across presets.
export const OUTPUT_PRESETS = Object.freeze({
    EMERGENCY: Object.freeze(['height']),
    GEOMETRY: GEOMETRY_TYPES,
    MATERIAL: Object.freeze(['height', 'normal', 'tile', 'splatData', 'splatIndex', 'splatValid']),
    FULL: Object.freeze([
        'height', 'normal', 'tile',
        'splatData', 'splatIndex', 'splatValid',
        'climate', 'scatter', 'resolvedColor', 'macro'
    ])
});

/**
 * Split a configured full output-type list into a geometry (fast-path) set
 * and a refinement (background) set. Order-preserving; unknown/extra types
 * (e.g. a future output not yet categorized) fall into refinement rather
 * than being silently dropped.
 *
 * @param {string[]} allTypes  e.g. streamedTypes from TileStreamer config
 * @returns {{ geometryTypes: string[], refinementTypes: string[] }}
 */
export function splitOutputTypes(allTypes) {
    const geometryTypes = [];
    const refinementTypes = [];
    for (const type of allTypes) {
        if (GEOMETRY_TYPES.includes(type)) geometryTypes.push(type);
        else refinementTypes.push(type);
    }
    return { geometryTypes, refinementTypes };
}
