// core/world/terrain-generator/terrainFeatureToggles.js
//
// On/off switches for the terms of the earthLike terrain height function,
// for judging which features earn their keep. One table drives everything:
// - config: planet terrain `features` (world/terrain.json "features": {
//   "mountains": false, ... }); unknown keys are reported and ignored;
// - runtime: qtDiag.setTerrainFeatures({ mountains: false }) regenerates the
//   visible terrain (WebGPUTerrainGenerator.setTerrainFeatures +
//   GPUQuadtreeTerrain.refreshTiles);
// - shader: a set bit in Uniforms.featureDisableMask switches the term off
//   (terrainFeatureOn(TF_*) in templates/terrain-shaders), in the plain and
//   the dual-number height paths alike.
// Startup-only consumers (hydrology precompute, erosion-seed lakes) are not
// recomputed by a runtime toggle.

export const TERRAIN_FEATURES = Object.freeze([
    { key: 'continentRelief', wgsl: 'TF_CONTINENT_RELIEF', about: 'Regional base elevation of the land (continental shelf, plates).' },
    { key: 'mountains', wgsl: 'TF_MOUNTAINS', about: 'Mountain ranges: foothills, ridge cores, peaks (whole feature).' },
    { key: 'mountainDetail', wgsl: 'TF_MOUNTAIN_DETAIL', about: 'Mountain slope roughness: 2 octaves at 4 km, 120 m.' },
    { key: 'mountainPeaks', wgsl: 'TF_MOUNTAIN_PEAKS', about: 'Exceptional towering peaks inside ranges (very rare).' },
    { key: 'meso1', wgsl: 'TF_MESO1', about: 'Meso detail 80 m wavelength, 25 m (with erosion: added on top, faded where erosion is strong).' },
    { key: 'meso2', wgsl: 'TF_MESO2', about: 'Meso detail 750 m wavelength, 135 m (with erosion: added on top, faded where erosion is strong).' },
    { key: 'meso3', wgsl: 'TF_MESO3', about: 'Meso detail 4 km wavelength, 150 m.' },
    { key: 'highlands', wgsl: 'TF_HIGHLANDS', about: 'Plateaus, five rarity tiers (5-70 km).' },
    { key: 'loneHillsCommon', wgsl: 'TF_LONE_HILLS_COMMON', about: 'Lone hills tier 1: common round domes, 0.8 / 1.6 km.' },
    { key: 'loneHillsUncommon', wgsl: 'TF_LONE_HILLS_UNCOMMON', about: 'Lone hills tier 2: uncommon domes, 2.5 km.' },
    { key: 'loneHillsVeryRare', wgsl: 'TF_LONE_HILLS_VERY_RARE', about: 'Lone hills tier 4: very rare irregular dome, 10 km.' },
    { key: 'loneHillsLandmark', wgsl: 'TF_LONE_HILLS_LANDMARK', about: 'Lone hills tier 5: two-peak landmark massif, 18 km.' },
    { key: 'rollingHills', wgsl: 'TF_ROLLING_HILLS', about: 'Rolling hill chains (beads on a 4 km path).' },
    { key: 'loneHillCuts', wgsl: 'TF_LONE_HILL_CUTS', about: 'Slope cuts on tiers 4/5 and the landmark detail noise (replaced by the erosion filter when it is on).' },
    { key: 'riverCarve', wgsl: 'TF_RIVER_CARVE', about: 'Demo river channel carved from uniforms.' },
    { key: 'erosionSeeds', wgsl: 'TF_EROSION_SEEDS', about: 'Erosion-seed pits (the demo lakes sit in them).' },
    { key: 'inlandUplift', wgsl: 'TF_INLAND_UPLIFT', about: 'Uniform uplift of continental interiors.' },
    { key: 'oceanFloor', wgsl: 'TF_OCEAN_FLOOR', about: 'Ocean-floor noise (off: flat floor at the ocean base depth).' },
    { key: 'erosionFilter', wgsl: 'TF_EROSION_FILTER', about: 'RuneVision erosion filter (only if terrain.erosionFilter.enabled compiled it in). Off restores the lone-hill cuts and full meso1/meso2.' },
    { key: 'microDetail', wgsl: 'TF_MICRO_DETAIL', about: 'Per-tile micro displacement by surface type (final height pass).' },
]);

const BIT_BY_KEY = new Map(TERRAIN_FEATURES.map((f, i) => [f.key, 1 << i]));

/**
 * Normalizes a features map against the table: every known key is present
 * (true unless explicitly false); unknown keys are returned separately.
 */
export function normalizeTerrainFeatures(features = {}, base = null) {
    const out = {};
    for (const f of TERRAIN_FEATURES) {
        const prev = base ? base[f.key] !== false : true;
        out[f.key] = Object.prototype.hasOwnProperty.call(features ?? {}, f.key)
            ? features[f.key] !== false
            : prev;
    }
    const unknown = Object.keys(features ?? {}).filter(k => !BIT_BY_KEY.has(k));
    return { features: out, unknown };
}

/** Bitmask with a bit set for every disabled feature. */
export function terrainFeatureDisableMask(features = {}) {
    let mask = 0;
    for (const f of TERRAIN_FEATURES) {
        if (features[f.key] === false) mask |= BIT_BY_KEY.get(f.key);
    }
    return mask >>> 0;
}

/** WGSL: one TF_* bit constant per feature, and terrainFeatureOn(). */
export function createTerrainFeatureToggleWgsl() {
    const consts = TERRAIN_FEATURES
        .map((f, i) => `const ${f.wgsl}: u32 = ${(1 << i) >>> 0}u;`)
        .join('\n');
    return `
// Terrain feature toggles (core/world/terrain-generator/terrainFeatureToggles.js).
${consts}
fn terrainFeatureOn(bit: u32) -> bool {
    return (uniforms.featureDisableMask & bit) == 0u;
}
`;
}

/** Rows for console.table: key, on/off, description. */
export function describeTerrainFeatures(features = {}) {
    return TERRAIN_FEATURES.map(f => ({ feature: f.key, on: features[f.key] !== false, about: f.about }));
}
