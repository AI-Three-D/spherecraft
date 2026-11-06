import { expect, it } from 'vitest';
import { faceUVToDir } from '../hydrology/waterGraph.js';
import { fieldCoords, pageKey, riverFieldLayout } from './riverField.js';
import { tilesTouchingRiverFieldPages } from './riverFieldTiles.js';

it('includes every changed page sampled inside a padded tile on all faces', () => {
    const L = riverFieldLayout(131000), size = 128, padding = 6;
    for (let face = 0; face < 6; face++) for (const depth of [0, 3, 8, 11]) {
        const grid = 2 ** depth;
        for (const [x, y] of [[0, 0], [grid - 1, grid - 1], [grid >> 1, grid >> 1]]) {
            for (const [sx, sy] of [[-padding, -padding], [0, 0], [size >> 1, size >> 1], [size - 1 + padding, size - 1 + padding]]) {
                const u = (x + sx / (size - 1)) / grid, v = (y + sy / (size - 1)) / grid;
                const q = fieldCoords(faceUVToDir(face, u, v), L);
                const pi = Math.max(0, Math.min(L.PE - 1, Math.floor(q.x / L.P))), pj = Math.max(0, Math.min(L.PE - 1, Math.floor(q.y / L.P)));
                const predicate = tilesTouchingRiverFieldPages([pageKey(q.face, pi, pj, L)], L, size, padding);
                expect(predicate(face, depth, x, y), `face ${face}, depth ${depth}, tile ${x},${y}, sample ${sx},${sy}`).toBe(true);
            }
        }
    }
});

it('does not select an interior tile far from the changed field page', () => {
    const L = riverFieldLayout(131000), depth = 11, grid = 2 ** depth, x = grid >> 1, y = grid >> 1;
    const close = fieldCoords(faceUVToDir(1, (x + 0.5) / grid, (y + 0.5) / grid), L);
    const pi = Math.floor(close.x / L.P), pj = Math.floor(close.y / L.P);
    expect(tilesTouchingRiverFieldPages([pageKey(1, pi, pj, L)], L, 128, 6)(1, depth, x, y)).toBe(true);
    expect(tilesTouchingRiverFieldPages([pageKey(1, pi + 50, pj, L)], L, 128, 6)(1, depth, x, y)).toBe(false);
});

it('conservatively covers varied padded sample positions at two planet scales', () => {
    let seed = 421;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (const radius of [131000, 1_000_000]) {
        const L = riverFieldLayout(radius), size = 128, padding = 7;
        for (let n = 0; n < 150; n++) {
            const face = Math.floor(random() * 6), depth = 1 + Math.floor(random() * 12), grid = 2 ** depth;
            const x = Math.floor(random() * grid), y = Math.floor(random() * grid);
            const sx = -padding + random() * (size - 1 + 2 * padding), sy = -padding + random() * (size - 1 + 2 * padding);
            const q = fieldCoords(faceUVToDir(face, (x + sx / (size - 1)) / grid, (y + sy / (size - 1)) / grid), L);
            const pi = Math.max(0, Math.min(L.PE - 1, Math.floor(q.x / L.P))), pj = Math.max(0, Math.min(L.PE - 1, Math.floor(q.y / L.P)));
            expect(tilesTouchingRiverFieldPages([pageKey(q.face, pi, pj, L)], L, size, padding)(face, depth, x, y)).toBe(true);
        }
    }
});
