// Prototypes for the sea and the far water (WATER_STATUS.md, "Ocean"), cycled
// with H in standalone.html, or picked at start with ?waterFix=N.
//
// Two switches, both live (no shader rebuild, no tile regeneration):
// - sea: 'lakes' = the sea drawn as the lakes are (WaterGpuData.sea:
//   the terrain shading far away, NearWaterRenderer's sea pass close by and
//   where it is deep, seaSurface.wgsl.js); 'legacy' = the old global ocean
//   renderer (globalOceanRenderer.js), as before.
// - farTexelCover: past the near meshes, which ground is under water comes from
//   the tiles' height texture (true) or from their triangles (false, as before;
//   far tiles have a few triangles over a hundred texels, so lake beds' mud showed).

export const WATER_FIX_PROTOTYPES = Object.freeze([
    {
        name: 'baseline',
        text: 'as before: the old ocean renderer; far lakes and rivers covered where the tile triangles are below the water',
        settings: { sea: 'legacy', farTexelCover: false },
    },
    {
        name: 'sea as lakes + texel cover',
        text: 'the sea drawn as the lakes are; past 1-1.6 km the ground under water is read from the tiles\' height texture',
        settings: { sea: 'lakes', farTexelCover: true },
    },
    {
        name: 'sea as lakes, triangle cover',
        text: 'the sea drawn as the lakes are; far water covered by the tile triangles\' height as before (shows the mud the texture fixes)',
        settings: { sea: 'lakes', farTexelCover: false },
    },
]);

/** The default (runtime) prototype. */
export const WATER_FIX_DEFAULT = 1;

function parts(gameEngine) {
    return { water: gameEngine?.waterGpuData ?? null, sea: gameEngine?.renderer?.terrainModule?.ocean ?? null };
}

/** Index of the prototype the running engine shows, or -1 (not ready or custom). */
export function waterFixIndexOf(gameEngine) {
    const { water, sea } = parts(gameEngine);
    if (!water || !sea) return -1;
    const now = { sea: sea.legacy ? 'legacy' : 'lakes', farTexelCover: water.look.farTexelCover === true };
    return WATER_FIX_PROTOTYPES.findIndex(p => p.settings.sea === now.sea && p.settings.farTexelCover === now.farTexelCover);
}

/** Switches a running engine to prototype `index`. Throws until the water data exists. */
export function applyWaterFixLive(gameEngine, index) {
    const proto = WATER_FIX_PROTOTYPES[index];
    const { water, sea } = parts(gameEngine);
    if (!proto) throw new Error(`water fix prototypes: no prototype ${index} (0-${WATER_FIX_PROTOTYPES.length - 1})`);
    if (!water || !sea) throw new Error('water fix prototypes: water not ready');
    water.look.farTexelCover = proto.settings.farTexelCover;
    sea.legacy = proto.settings.sea === 'legacy';
    return proto;
}
