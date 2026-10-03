import { describe, expect, it, vi } from 'vitest';
import { TileStreamer } from './tileStreamer.js';
import { TileAddress } from './tileAddress.js';
import { AsyncGenerationQueue } from '../asyncGenerationQueue.js';

// Streamer-side refinement bookkeeping, exercised without a GPU: the
// constructor only reads device limits, and the paths under test only queue
// work (no generation runs because the queues are never ticked).

const R = 131072;
const PLANET = { radius: R, origin: { x: 0, y: 0, z: 0 } };
const SHADER_CONFIG = {
    solidColorTierEnabled: true,
    solidColorTierDistanceFadeEnabled: true,
    solidColorStartLod: 5,
    solidColorTierDistanceFadeBandFraction: 0.3,
    solidColorTierDistanceFadeHeightMarginMeters: 1000,
    solidColorTierDistanceFadeEndSafety: 0.5
};

function makeStreamer(flags = {}) {
    const quadtreeGPU = { maxDepth: 11, lodFactor: 1173, faceSize: 2 * R, lodErrorThreshold: 512 };
    return new TileStreamer({ limits: { maxTextureArrayLayers: 2048 } }, null, quadtreeGPU, {
        tileTextureSize: 128,
        tilePoolSize: 64,
        requiredTypes: ['height', 'normal', 'tile', 'splatData'],
        textureFormats: { height: 'r32float', normal: 'rgba8unorm', tile: 'r8unorm', splatData: 'rgba8unorm' },
        enableSplat: true,
        solidTierStartLod: 5,
        streamerFlags: flags,
        flatTierRefinementSkip: { shaderConfig: SHADER_CONFIG, minLod: 4, minSurfaceRadius: R - 7500 }
    });
}

// Pretend a tile is resident (what _commitTile records).
function makeResident(ts, tile, lastUsed = 0) {
    const key = tile.toString();
    ts._tileInfo.set(key, {
        layer: ts._tileInfo.size, face: tile.face, depth: tile.depth, x: tile.x, y: tile.y,
        keyLo: 0, keyHi: 0, slot: -1, lastUsed
    });
    ts._tileState.set(key, 'RESIDENT');
    return key;
}

// Camera `altitude` metres above the centre of a tile.
function cameraAboveTile(tile, altitude) {
    const grid = 1 << tile.depth;
    const s = ((tile.x + 0.5) / grid) * 2 - 1;
    const t = ((tile.y + 0.5) / grid) * 2 - 1;
    // face 4: (s, t, 1)
    const len = Math.hypot(s, t, 1);
    const r = R + altitude;
    return { x: (s / len) * r, y: (t / len) * r, z: (1 / len) * r };
}

describe('AsyncGenerationQueue.tick', () => {
    it('returns how many tasks it started', () => {
        const queue = new AsyncGenerationQueue({ maxInFlight: 10, maxPerFrame: 2 });
        for (let i = 0; i < 3; i++) queue.request(`k${i}`, i, async () => true);
        expect(queue.tick()).toBe(2);
        expect(queue.tick()).toBe(1);
        expect(queue.tick()).toBe(0);
    });
});

describe('TileStreamer visibility index', () => {
    it('answers demand questions exactly like the visible-list scan', () => {
        const ts = makeStreamer();
        const visible = [];
        for (let i = 0; i < 40; i++) {
            visible.push(new TileAddress(4, 9, 300 + (i % 8), 200 + Math.floor(i / 8)));
        }
        visible.push(new TileAddress(4, 6, 30, 30), new TileAddress(2, 3, 1, 6));
        ts.markTilesVisible(visible);
        const queries = [
            ...visible,
            new TileAddress(4, 8, 150, 100), new TileAddress(4, 2, 2, 1), new TileAddress(4, 0, 0, 0),
            new TileAddress(4, 10, 601, 401), new TileAddress(4, 11, 1203, 803), new TileAddress(4, 9, 0, 0),
            new TileAddress(4, 8, 241, 241), new TileAddress(5, 9, 300, 200), new TileAddress(2, 5, 4, 25)
        ];
        for (const q of queries) {
            expect(ts._describeTileDemandState(q)).toEqual(ts._describeTileDemandStateScan(q));
        }
    });
});

describe('TileStreamer parked refinements', () => {
    it('re-queues a parked refinement when its tile shows up in a readback, without a per-frame scan', () => {
        const ts = makeStreamer();
        const near = new TileAddress(4, 10, 512, 512);    // LOD1, needs material
        const elsewhere = new TileAddress(4, 10, 100, 100);
        ts.setCameraContext({ position: cameraAboveTile(near, 300), planetConfig: PLANET });
        const nearKey = makeResident(ts, near);
        const elsewhereKey = makeResident(ts, elsewhere);
        ts._refinementVisibleDropRetryMap.set(nearKey, near);
        ts._refinementVisibleDropRetryMap.set(elsewhereKey, elsewhere);

        const scan = vi.spyOn(ts, '_describeTileDemandState');
        ts._retryVisibleDroppedRefinements();
        expect(scan).not.toHaveBeenCalled();

        ts.markTilesVisible([near]);
        expect(ts._refinementVisibleDropRetryMap.has(nearKey)).toBe(false);
        expect(ts._refinementQueue.pending.has(nearKey)).toBe(true);
        // Not visible: stays parked, not queued.
        expect(ts._refinementVisibleDropRetryMap.has(elsewhereKey)).toBe(true);
        expect(ts._refinementQueue.pending.has(elsewhereKey)).toBe(false);
    });

    it('keeps the old per-frame scan when indexedVisibility is off', () => {
        const ts = makeStreamer({ indexedVisibility: false });
        const tile = new TileAddress(4, 10, 512, 512);
        ts.setCameraContext({ position: cameraAboveTile(tile, 300), planetConfig: PLANET });
        const key = makeResident(ts, tile);
        ts.markTilesVisible([tile]);
        ts._refinementVisibleDropRetryMap.set(key, tile);
        ts._retryVisibleDroppedRefinements();
        expect(ts._refinementQueue.pending.has(key)).toBe(true);
    });

    it('forgets parked and deferred refinements of evicted tiles', () => {
        const ts = makeStreamer();
        ts.hashTable = { remove: () => -1 };
        ts.arrayPool = { releaseLayer: () => {} };
        const tile = new TileAddress(4, 7, 70, 64);
        const key = makeResident(ts, tile);
        ts._refinementVisibleDropRetryMap.set(key, tile);
        ts._refinementDeferredMap.set(key, tile);
        ts._evictTile(key);
        expect(ts._refinementVisibleDropRetryMap.has(key)).toBe(false);
        expect(ts._refinementDeferredMap.has(key)).toBe(false);
        expect(ts._tileInfo.has(key)).toBe(false);
    });
});

describe('TileStreamer flat-fade refinement skip', () => {
    // Depth 7 = LOD4 (2048 m tiles at the face centre); the fade ends at
    // ~7.8 km, plus the 10 % margin.
    const centre = new TileAddress(4, 7, 64, 64);
    const far = new TileAddress(4, 7, 70, 64);      // ~12 km from centre

    it('defers a LOD4 tile drawn entirely past the fade end, then queues it once in range', () => {
        const ts = makeStreamer();
        ts.setCameraContext({ position: cameraAboveTile(centre, 2000), planetConfig: PLANET });
        const key = makeResident(ts, far);
        ts._queueRefinement(far);
        expect(ts._tileState.get(key)).toBe('DEFERRED');
        expect(ts._refinementDeferredMap.has(key)).toBe(true);
        expect(ts._refinementQueue.pending.has(key)).toBe(false);

        // Still far: a readback leaves it deferred.
        ts.markTilesVisible([far]);
        expect(ts._refinementDeferredMap.has(key)).toBe(true);

        // Camera moves next to it: the next readback queues it.
        ts.setCameraContext({ position: cameraAboveTile(new TileAddress(4, 7, 68, 64), 2000), planetConfig: PLANET });
        ts.markTilesVisible([far]);
        expect(ts._refinementDeferredMap.has(key)).toBe(false);
        expect(ts._refinementQueue.pending.has(key)).toBe(true);
    });

    it('never defers below minLod (terrain AO reads material there)', () => {
        const ts = makeStreamer();
        ts.setCameraContext({ position: cameraAboveTile(centre, 2000), planetConfig: PLANET });
        const lod3Far = new TileAddress(4, 8, 140, 128);   // ~12 km away, LOD3
        const key = makeResident(ts, lod3Far);
        ts._queueRefinement(lod3Far);
        expect(ts._refinementQueue.pending.has(key)).toBe(true);
    });

    it('is disabled by the flag, and turning it off releases deferred tiles', () => {
        const off = makeStreamer({ skipRefinementBeyondFlatFade: false });
        off.setCameraContext({ position: cameraAboveTile(centre, 2000), planetConfig: PLANET });
        const offKey = makeResident(off, far);
        off._queueRefinement(far);
        expect(off._refinementQueue.pending.has(offKey)).toBe(true);

        const ts = makeStreamer();
        ts.setCameraContext({ position: cameraAboveTile(centre, 2000), planetConfig: PLANET });
        const key = makeResident(ts, far);
        ts._queueRefinement(far);
        expect(ts._refinementDeferredMap.has(key)).toBe(true);
        ts.setStreamerFlags({ skipRefinementBeyondFlatFade: false });
        expect(ts._refinementDeferredMap.size).toBe(0);
        expect(ts._refinementQueue.pending.has(key)).toBe(true);
    });
});

describe('TileStreamer LRU stamping', () => {
    it('stamps every visible tile and all of its resident ancestors, and nothing else', () => {
        const ts = makeStreamer();
        const visible = [new TileAddress(4, 9, 300, 200), new TileAddress(4, 9, 301, 200), new TileAddress(4, 9, 302, 203)];
        const chainKeys = [];
        for (const tile of visible) {
            chainKeys.push(makeResident(ts, tile, 0));
            let { depth, x, y } = tile;
            while (depth > 0) {
                depth--; x >>= 1; y >>= 1;
                const ancestor = new TileAddress(4, depth, x, y);
                if (!ts._tileInfo.has(ancestor.toString())) chainKeys.push(makeResident(ts, ancestor, 0));
            }
        }
        const unrelated = makeResident(ts, new TileAddress(4, 9, 10, 10), 0);
        ts.markTilesVisible(visible);
        for (const key of chainKeys) expect(ts._tileInfo.get(key).lastUsed).toBeGreaterThan(0);
        expect(ts._tileInfo.get(unrelated).lastUsed).toBe(0);
    });
});
