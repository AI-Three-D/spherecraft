import { describe, expect, it, vi } from 'vitest';
import { TileStreamer } from './tileStreamer.js';
import { TileAddress } from './tileAddress.js';

// In-place regeneration of resident tiles (TileStreamer.regenerateTiles),
// without a GPU: generation and the array pool are stubs.

const R = 131072;

function makeStreamer() {
    const quadtreeGPU = { maxDepth: 11, lodFactor: 1173, faceSize: 2 * R, lodErrorThreshold: 512 };
    const ts = new TileStreamer({ limits: { maxTextureArrayLayers: 2048 } }, null, quadtreeGPU, {
        tileTextureSize: 128,
        tilePoolSize: 64,
        requiredTypes: ['height', 'normal', 'tile', 'splatData'],
        textureFormats: { height: 'r32float', normal: 'rgba8unorm', tile: 'r8unorm', splatData: 'rgba8unorm' },
        enableSplat: true,
    });
    ts.terrainGenerator = { waterCarveVersion: 1 };
    ts.arrayPool = { queueCopyToLayer: vi.fn() };
    ts.tileGenerator = { generateTile: vi.fn(async (addr, telemetry, types) => Object.fromEntries(types.map(t => [t, { t }]))) };
    return ts;
}

function makeResident(ts, tile, layer) {
    const key = tile.toString();
    ts._tileInfo.set(key, { layer, face: tile.face, depth: tile.depth, x: tile.x, y: tile.y, keyLo: 0, keyHi: 0, slot: -1, lastUsed: 0 });
    ts._tileState.set(key, 'REFINED');
    return key;
}

async function runQueued(ts, key) {
    const entry = ts._regenQueue.pending.get(key);
    expect(entry).toBeTruthy();
    ts._regenQueue.tick();
    return entry.promise;
}

describe('TileStreamer.regenerateTiles', () => {
    it('queues only the resident tiles the predicate picks', () => {
        const ts = makeStreamer();
        const a = new TileAddress(4, 10, 512, 512), b = new TileAddress(4, 10, 600, 512);
        makeResident(ts, a, 3); makeResident(ts, b, 4);
        const n = ts.regenerateTiles((face, depth, x) => x < 550);
        expect(n).toBe(1);
        expect(ts._regenQueue.pending.has(a.toString())).toBe(true);
        expect(ts._regenQueue.pending.has(b.toString())).toBe(false);
    });

    it('generates every output type and copies them into the tile\'s own layer', async () => {
        const ts = makeStreamer();
        const a = new TileAddress(4, 10, 512, 512);
        const key = makeResident(ts, a, 7);
        ts.regenerateTiles(() => true);
        expect(await runQueued(ts, key)).toBe(true);
        const types = ts.tileGenerator.generateTile.mock.calls[0][2];
        expect(new Set(types)).toEqual(new Set([...ts._geometryTypes, ...ts._refinementTypesFor(a)]));
        const [textures, layer, opts] = ts.arrayPool.queueCopyToLayer.mock.calls[0];
        expect(layer).toBe(7);
        expect(Object.keys(textures).sort()).toEqual([...types].sort());
        expect(opts.completesMaterial).toBe(true);
        expect(ts._tileInfo.get(key).carveVersion).toBe(1);
        expect(ts._tileInfo.get(key).layer).toBe(7);               // still the same resident tile
        expect(ts.drainAOCommitQueue()).toEqual([{ face: 4, depth: 10, x: 512, y: 512, layer: 7 }]);
    });

    it('drops the work for a tile evicted meanwhile', async () => {
        const ts = makeStreamer();
        const a = new TileAddress(4, 10, 512, 512);
        const key = makeResident(ts, a, 2);
        ts.regenerateTiles(() => true);
        ts.tileGenerator.generateTile.mockImplementationOnce(async () => { ts._tileInfo.delete(key); return { height: {} }; });
        ts._destroyGeneratedTextures = vi.fn();
        expect(await runQueued(ts, key)).toBe(false);
        expect(ts.arrayPool.queueCopyToLayer).not.toHaveBeenCalled();
        expect(ts._destroyGeneratedTextures).toHaveBeenCalled();
    });

    it('goes again when the terrain changed during the generation', async () => {
        vi.useFakeTimers();
        try {
            const ts = makeStreamer();
            const a = new TileAddress(4, 10, 512, 512);
            const key = makeResident(ts, a, 5);
            ts.regenerateTiles(() => true);
            ts.tileGenerator.generateTile.mockImplementationOnce(async (addr, tel, types) => {
                ts.terrainGenerator.waterCarveVersion = 2;
                return Object.fromEntries(types.map(t => [t, {}]));
            });
            expect(await runQueued(ts, key)).toBe(true);
            expect(ts._tileInfo.get(key).carveVersion).toBe(1);
            await vi.runAllTimersAsync();
            expect(ts._regenQueue.pending.has(key)).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });
});
