import { describe, expect, it } from 'vitest';
import { corridorMask, riverShape, smoothRiverPath, traceRiverPatch } from './riverRefine.js';

// 60 x 30 patch, 16 m cells, frame origin at (0, 0). A valley runs along
// j = 15 from a source lake (i < 10, level 50 m) down to a destination lake
// (i > 50, level 20 m). The valley floor has a pit at i = 30 (a pool the
// river must pass through) and the land beside the valley is high.
const NX = 60, NY = 30;
const frame = { x0: 0, y0: 0, spacing: 16, nx: NX, ny: NY };
function valley(i, j) {
    const across = Math.abs(j - 15);
    let floor = 50 - 0.5 * i;                 // 50 m .. 20 m
    if (i >= 28 && i <= 32) floor -= 6;       // pool
    if (i < 10) floor = 40;                   // source lake bed
    if (i > 50) floor = 10;                   // destination lake bed
    return floor + 3 * across * across;
}
const heights = new Float32Array(NX * NY);
for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) heights[j * NX + i] = valley(i, j);
const at = (i, j) => [(i + 0.5) * 16, (j + 0.5) * 16];

describe('river trace', () => {
    it('runs from the sill to the destination water, inside the corridor, never rising', () => {
        const polyline = [at(10, 15), at(30, 14), at(55, 15)];
        const corridor = corridorMask(frame, polyline, 120);
        const seeds = new Uint8Array(NX * NY);
        for (let k = 0; k < NX * NY; k++) if (heights[k] < 20 && (k % NX) > 50) seeds[k] = 1;
        const r = traceRiverPatch({ heights, nx: NX, ny: NY, corridor, seeds, source: 15 * NX + 10 });
        expect(r).not.toBeNull();
        const last = r.path[r.path.length - 1];
        expect(seeds[last]).toBe(1);
        for (const c of r.path) expect(corridor[c]).toBe(1);
        for (let k = 1; k < r.fill.length; k++) expect(r.fill[k]).toBeLessThanOrEqual(r.fill[k - 1]);
        // The path stays on the valley floor.
        for (const c of r.path) expect(Math.abs(Math.floor(c / NX) - 15)).toBeLessThanOrEqual(1);
        // Through the pool the water level is the pool's spill level, not the pit floor.
        const pool = r.path.findIndex(c => c % NX === 30);
        expect(r.fill[pool]).toBeGreaterThan(heights[r.path[pool]]);
    });

    it('returns null when the corridor does not connect the source to the seeds', () => {
        const corridor = corridorMask(frame, [at(10, 15), at(20, 15)], 60);
        const seeds = new Uint8Array(NX * NY); seeds[15 * NX + 55] = 1;
        expect(traceRiverPatch({ heights, nx: NX, ny: NY, corridor, seeds, source: 15 * NX + 10 })).toBeNull();
    });

    it('smoothing keeps the end points and a non-rising level', () => {
        const xs = Float64Array.from([0, 16, 32, 32, 48, 64, 80]);
        const ys = Float64Array.from([0, 0, 16, 32, 32, 48, 48]);
        const fill = Float64Array.from([50, 49, 49.5, 47, 47, 46, 45]);
        const out = smoothRiverPath(xs, ys, fill, { window: 2, stepM: 10 });
        expect(out.x[0]).toBe(0); expect(out.y[0]).toBe(0);
        expect(out.x[out.x.length - 1]).toBeCloseTo(80, 9); expect(out.y[out.y.length - 1]).toBeCloseTo(48, 9);
        for (let k = 1; k < out.fill.length; k++) expect(out.fill[k]).toBeLessThanOrEqual(out.fill[k - 1]);
    });

    it('river shape grows with discharge', () => {
        const a = riverShape(1, 0.002), b = riverShape(100, 0.002);
        expect(b.width).toBeGreaterThan(a.width);
        expect(b.depth).toBeGreaterThan(a.depth);
        expect(a.width).toBeGreaterThanOrEqual(10);
    });
});
