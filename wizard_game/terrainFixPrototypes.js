// Prototypes for the far-terrain fixes (TERRAIN_FLAT_TIER_FINDINGS.md),
// cycled with G in standalone.html, or picked at start with ?terrainFix=N.
//
// All settings live under engineConfig.rendering.terrainShader:
// - coarseColorSource ('window' | 'draw'): how the flat-tier color is baked.
//   'draw' = the expected colour of the dithered tile draw, a function of position
//   only (no tile-edge seams, the same at every LOD). Generator side: the
//   resident tiles are regenerated on a change.
// - solidColorTierEdgeBlendEnabled: the in-tile ramp toward a flat-tier
//   neighbour (a per-tile blend that switches when a neighbour splits).
//   Shader side: rebuilt.
// - solidColorTierDistanceFadeEndSafety / ...BandFraction: where the
//   camera-distance blend from detail to flat color ends and how long it is.
//   Read every frame.

export const TERRAIN_FIX_PROTOTYPES = Object.freeze([
    {
        name: 'baseline',
        text: 'as before: flat color = 1434 m jittered window clamped at tile edges; near blend = distance ramp plus in-tile edge ramp',
        settings: {
            coarseColorSource: 'window',
            solidColorTierEdgeBlendEnabled: true, solidColorTierDistanceFadeEndSafety: 0.5, solidColorTierDistanceFadeBandFraction: 0.3,
        },
    },
    {
        name: 'draw color',
        text: 'flat color = expected colour of the dithered tile draw (no window, no noise, same at every LOD and on both sides of every tile edge); near blend as before',
        settings: {
            coarseColorSource: 'draw',
            solidColorTierEdgeBlendEnabled: true, solidColorTierDistanceFadeEndSafety: 0.5, solidColorTierDistanceFadeBandFraction: 0.3,
        },
    },
    {
        name: 'draw color + distance-only blend',
        text: 'as 1, and the detail-to-flat blend is by camera distance only: it always ends before the first flat tile can appear, no per-tile edge ramp',
        settings: {
            coarseColorSource: 'draw',
            solidColorTierEdgeBlendEnabled: false, solidColorTierDistanceFadeEndSafety: 1.0, solidColorTierDistanceFadeBandFraction: 0.3,
        },
    },
    {
        name: 'draw color + wider distance blend',
        text: 'as 2 with a blend zone about 1.7x as long (smoother, starts nearer the camera)',
        settings: {
            coarseColorSource: 'draw',
            solidColorTierEdgeBlendEnabled: false, solidColorTierDistanceFadeEndSafety: 1.0, solidColorTierDistanceFadeBandFraction: 0.5,
        },
    },
]);

const BASELINE = TERRAIN_FIX_PROTOTYPES[0].settings;
const SETTING_KEYS = Object.freeze(Object.keys(BASELINE));
const SHADER_KEYS = Object.freeze(['solidColorTierEdgeBlendEnabled']);

const current = (ts, k) => ts?.[k] ?? BASELINE[k];

/** Index of the prototype whose settings the config holds, or -1. */
export function terrainFixIndexOf(terrainShaderConfig) {
    return TERRAIN_FIX_PROTOTYPES.findIndex(p =>
        SETTING_KEYS.every(k => current(terrainShaderConfig, k) === p.settings[k]));
}

/** Writes prototype `index` into a terrainShader config (before the engine starts). */
export function applyTerrainFixToConfig(terrainShaderConfig, index) {
    const proto = TERRAIN_FIX_PROTOTYPES[index];
    if (!proto || !terrainShaderConfig) return null;
    Object.assign(terrainShaderConfig, proto.settings);
    return proto;
}

/**
 * Switches a running engine to prototype `index`: rebuilds the terrain
 * materials when a shader setting changed and regenerates the resident tiles
 * when the bake source changed. Returns { proto, regenerated, rebuilt }.
 */
export async function applyTerrainFixLive(gameEngine, index) {
    const proto = TERRAIN_FIX_PROTOTYPES[index];
    const ts = gameEngine?.engineConfig?.rendering?.terrainShader;
    if (!proto || !ts) throw new Error('terrain fix prototypes: engine config not ready');
    const tileManager = gameEngine.renderer?.quadtreeTileManager;
    const tileStreamer = tileManager?.tileStreamer;
    const tileGenerator = tileStreamer?.tileGenerator;
    const terrainRenderer = gameEngine.renderer?.quadtreeTerrainRenderer;
    if (!tileGenerator || !terrainRenderer) {
        throw new Error('terrain fix prototypes: terrain not ready');
    }
    const s = proto.settings;
    const rebuilt = SHADER_KEYS.some(k => current(ts, k) !== s[k]);
    const regenerated = (tileGenerator.coarseColorSource ?? 'window') !== s.coarseColorSource;

    Object.assign(ts, s);
    tileGenerator.coarseColorSource = s.coarseColorSource;
    tileStreamer._coarseColorSource = s.coarseColorSource;
    if (rebuilt) await terrainRenderer.rebuildMaterials();
    if (regenerated) tileManager.refreshTiles();
    return { proto, regenerated, rebuilt };
}
