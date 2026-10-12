// core/world/terrain-generator/terrainFeatureToggles.js
//
// On/off switches for the terms of the earthLike terrain height function,
// for judging which features earn their keep. One table drives everything:
// - config: planet terrain `features` (world/terrain.json "features": {
//   "rollingHills": false, ... }); unknown keys are reported and ignored;
// - runtime: qtDiag.setTerrainFeatures({ rollingHills: false }) regenerates the
//   visible terrain (WebGPUTerrainGenerator.setTerrainFeatures +
//   GPUQuadtreeTerrain.refreshTiles);
// - shader: a set bit in Uniforms.featureDisableMask switches the term off
//   (terrainFeatureOn(TF_*) in templates/terrain-shaders), in the plain and
//   the dual-number height paths alike.
// Startup-only consumers (hydrology precompute, erosion-seed lakes) are not
// recomputed by a runtime toggle.

export const TERRAIN_FEATURES = Object.freeze([
    { key: 'continentRelief', wgsl: 'TF_CONTINENT_RELIEF', about: 'Regional base elevation of the land (continental shelf, plates).' },
    { key: 'landRegions', wgsl: 'TF_LAND_REGIONS', about: 'Regional landform (100 km field): flat lowland plains (little local relief), gradually rising uplands with flatter shelves, highlands.' },
    { key: 'lakeBasins', wgsl: 'TF_LAKE_BASINS', about: 'Shallow flat-floored hollows (6 km field, 25 m) on the uplands, where lakes collect.' },
    { key: 'mountains', wgsl: 'TF_MOUNTAINS', about: 'Uncommon mountains: a peak with 3 spur ridges, 1.1-2.2 km, mostly in the highlands.' },
    { key: 'mountainLandmark', wgsl: 'TF_MOUNTAIN_LANDMARK', about: 'Rare landmark massif: 2.8-3.8 km, 4 spur ridges and a broad base.' },
    { key: 'mountainRange', wgsl: 'TF_MOUNTAIN_RANGE', about: 'Mountain range: a 40-75 km bowed ridge with summits along the crest, 1.6-2.6 km.' },
    { key: 'foothills', wgsl: 'TF_FOOTHILLS', about: 'Foothills: 3 km rolling hills over the most rugged quarter of the land (terrainType 0.45-0.56), 165 m x mountainBias.' },
    { key: 'meso2', wgsl: 'TF_MESO2', about: 'Meso detail 750 m wavelength, 135 m; added on top of the eroded terrain, faded where erosion is strong.' },
    { key: 'loneHillsVeryRare', wgsl: 'TF_LONE_HILLS_VERY_RARE', about: 'Very rare irregular dome, 10 km.' },
    { key: 'loneHillsLandmark', wgsl: 'TF_LONE_HILLS_LANDMARK', about: 'Two-peak landmark massif, 18 km.' },
    { key: 'rollingHills', wgsl: 'TF_ROLLING_HILLS', about: 'Rolling hill chains (beads on a 4 km path).' },
    { key: 'riverCarve', wgsl: 'TF_RIVER_CARVE', about: 'Demo river channel carved from uniforms.' },
    { key: 'erosionSeeds', wgsl: 'TF_EROSION_SEEDS', about: 'Erosion-seed pits (the demo lakes sit in them).' },
    { key: 'inlandUplift', wgsl: 'TF_INLAND_UPLIFT', about: 'Uniform uplift of continental interiors.' },
    { key: 'oceanFloor', wgsl: 'TF_OCEAN_FLOOR', about: 'Ocean-floor noise (off: flat floor at the ocean base depth).' },
    { key: 'microDetail', wgsl: 'TF_MICRO_DETAIL', about: 'Per-tile micro displacement by surface type (final height pass).' },
    { key: 'waterCarve', wgsl: 'TF_WATER_CARVE', about: 'River channels carved along the traced rivers (riverCarve.wgsl.js; terrain.waterGraph.carve).' },
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
