import { describe, expect, it } from 'vitest';
import { TileVisibilityIndex, tileNumKey } from './tileVisibilityIndex.js';

// The visible-list scan TileStreamer used before the index
// (_describeTileDemandStateScan), kept verbatim as the reference.
function describeByScan(tileAddr, visibleKeySet, visibleList) {
    const makeKey = (face, depth, x, y) => `f${face}:d${depth}:${x},${y}`;
    const key = makeKey(tileAddr.face, tileAddr.depth, tileAddr.x, tileAddr.y);
    if (visibleKeySet.has(key)) return { relevant: true, reason: 'visible' };
    for (const visibleTile of visibleList) {
        if (visibleTile.face !== tileAddr.face || visibleTile.depth < tileAddr.depth) continue;
        let depth = visibleTile.depth;
        let x = visibleTile.x;
        let y = visibleTile.y;
        while (depth > tileAddr.depth) {
            depth--;
            x >>= 1;
            y >>= 1;
        }
        if (depth === tileAddr.depth && x === tileAddr.x && y === tileAddr.y) {
            return { relevant: true, reason: 'ancestor' };
        }
    }
    let d = tileAddr.depth;
    let px = tileAddr.x;
    let py = tileAddr.y;
    while (d > 0) {
        d--;
        px >>= 1;
        py >>= 1;
        if (visibleKeySet.has(makeKey(tileAddr.face, d, px, py))) {
            return { relevant: true, reason: 'descendant' };
        }
    }
    return { relevant: false, reason: 'stale' };
}

// Deterministic PRNG so failures reproduce.
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Tiles clustered under one depth-3 region per face, so ancestor and
// descendant relations actually occur.
function randomTile(rand, maxDepth = 11) {
    const face = Math.floor(rand() * 2);
    const depth = Math.floor(rand() * (maxDepth + 1));
    const grid = 1 << depth;
    if (depth <= 3) {
        return { face, depth, x: Math.floor(rand() * grid), y: Math.floor(rand() * grid) };
    }
    const span = grid >> 3;
    return {
        face,
        depth,
        x: 2 * span + Math.floor(rand() * span),
        y: 5 * span + Math.floor(rand() * span)
    };
}

describe('tileNumKey', () => {
    it('is unique across face, depth and coordinates', () => {
        const seen = new Set();
        for (let face = 0; face < 6; face++) {
            for (const depth of [0, 1, 5, 11]) {
                const grid = 1 << depth;
                for (const [x, y] of [[0, 0], [grid - 1, 0], [0, grid - 1], [grid - 1, grid - 1]]) {
                    const key = tileNumKey(face, depth, x, y);
                    expect(Number.isSafeInteger(key)).toBe(true);
                    seen.add(key);
                }
            }
        }
        // depth 0 has a single tile, so its four corner coordinates coincide.
        expect(seen.size).toBe(6 * (1 + 3 * 4));
    });
});

describe('TileVisibilityIndex', () => {
    it('reports unknown before the first readback', () => {
        const index = new TileVisibilityIndex();
        expect(index.describe(0, 5, 3, 4)).toEqual({ relevant: true, reason: 'unknown' });
    });

    it('classifies visible, ancestor, descendant and stale tiles', () => {
        const index = new TileVisibilityIndex();
        index.rebuild([{ face: 2, depth: 4, x: 5, y: 9 }]);
        expect(index.describe(2, 4, 5, 9).reason).toBe('visible');
        expect(index.describe(2, 3, 2, 4).reason).toBe('ancestor');
        expect(index.describe(2, 0, 0, 0).reason).toBe('ancestor');
        expect(index.describe(2, 6, 21, 37).reason).toBe('descendant');
        expect(index.describe(2, 4, 6, 9).reason).toBe('stale');
        expect(index.describe(3, 4, 5, 9).reason).toBe('stale');
        expect(index.describe(2, 4, 6, 9).relevant).toBe(false);
    });

    it('matches the old visible-list scan on random data', () => {
        const rand = mulberry32(12345);
        const index = new TileVisibilityIndex();
        for (let round = 0; round < 40; round++) {
            const visibleList = [];
            const count = 1 + Math.floor(rand() * 300);
            for (let i = 0; i < count; i++) visibleList.push(randomTile(rand));
            const keySet = new Set(visibleList.map(t => `f${t.face}:d${t.depth}:${t.x},${t.y}`));
            index.rebuild(visibleList);
            for (let q = 0; q < 400; q++) {
                // Half the queries are relatives of visible tiles, half random.
                let query = randomTile(rand);
                if (rand() < 0.5) {
                    const base = visibleList[Math.floor(rand() * visibleList.length)];
                    const shift = Math.floor(rand() * 4) - 2;
                    if (shift >= 0) {
                        const up = Math.min(shift, base.depth);
                        query = { face: base.face, depth: base.depth - up, x: base.x >> up, y: base.y >> up };
                    } else if (base.depth < 11) {
                        query = { face: base.face, depth: base.depth + 1, x: base.x * 2 + 1, y: base.y * 2 };
                    }
                }
                const expected = describeByScan(query, keySet, visibleList);
                const actual = index.describe(query.face, query.depth, query.x, query.y);
                expect(actual).toEqual(expected);
            }
        }
    });
});
