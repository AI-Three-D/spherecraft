import { describe, expect, it, vi } from 'vitest';
import { TERRAIN_FIX_PROTOTYPES, applyTerrainFixLive, applyTerrainFixToConfig, terrainFixIndexOf } from './terrainFixPrototypes.js';
import { createEngineConfig } from './runtimeConfigs.js';

function fakeEngine(ts) {
    const tileStreamer = { tileGenerator: { coarseColorSource: ts.coarseColorSource ?? 'window' } };
    return {
        engineConfig: { rendering: { terrainShader: ts } },
        renderer: {
            quadtreeTileManager: { tileStreamer, refreshTiles: vi.fn() },
            quadtreeTerrainRenderer: { rebuildMaterials: vi.fn(async () => {}) },
        },
    };
}

describe('terrain fix prototypes', () => {
    it('the runtime defaults are prototype 2', () => {
        expect(terrainFixIndexOf(createEngineConfig().rendering.terrainShader)).toBe(2);
    });

    it('an unset config reads as the baseline', () => {
        expect(terrainFixIndexOf({})).toBe(0);
        const ts = {};
        applyTerrainFixToConfig(ts, 3);
        expect(terrainFixIndexOf(ts)).toBe(3);
    });

    it('rebuilds for shader settings, regenerates for the bake source, live for the fade distances', async () => {
        const engine = fakeEngine({ ...TERRAIN_FIX_PROTOTYPES[0].settings });
        const tm = engine.renderer.quadtreeTileManager;
        const tr = engine.renderer.quadtreeTerrainRenderer;

        expect(await applyTerrainFixLive(engine, 1)).toMatchObject({ regenerated: true, rebuilt: false });
        expect(tm.tileStreamer.tileGenerator.coarseColorSource).toBe('draw');

        expect(await applyTerrainFixLive(engine, 2)).toMatchObject({ regenerated: false, rebuilt: true });
        expect(await applyTerrainFixLive(engine, 3)).toMatchObject({ regenerated: false, rebuilt: false });
        expect(engine.engineConfig.rendering.terrainShader.solidColorTierDistanceFadeBandFraction).toBe(0.5);

        expect(await applyTerrainFixLive(engine, 0)).toMatchObject({ regenerated: true, rebuilt: true });
        expect(tm.refreshTiles).toHaveBeenCalledTimes(2);
        expect(tr.rebuildMaterials).toHaveBeenCalledTimes(2);
    });
});
