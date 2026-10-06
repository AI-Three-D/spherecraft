import { describe, expect, it } from 'vitest';
import { corridorMask, fitNonIncreasingQuantile, RIVER_LEVEL_DEFAULTS, riverCrestAbove, riverShape, riverValleyLevels, riverValleyShape, segmentCells, smoothRiverPath, traceRiverPatch } from './riverRefine.js';

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

describe('river levels for the valley', () => {
    it('fitNonIncreasingQuantile: never rises; tau sets how much lies below', () => {
        const w = [1, 1, 1, 1, 1, 1];
        const med = Array.from(fitNonIncreasingQuantile([5, 4, 6, 2, 3, 1], w, 0.5));
        for (let k = 1; k < med.length; k++) expect(med[k]).toBeLessThanOrEqual(med[k - 1]);
        expect(Array.from(fitNonIncreasingQuantile([3, 2, 1], [1, 1, 1], 0.1))).toEqual([3, 2, 1]);
        // A rise is pooled at the low quantile: the block takes its lower value.
        expect(Array.from(fitNonIncreasingQuantile([1, 2], [1, 1], 0.1))).toEqual([1, 1]);
        expect(Array.from(fitNonIncreasingQuantile([1, 2], [1, 1], 0.9))).toEqual([2, 2]);
    });

    // Ground along a river: a rim, a deep hollow, bumps, then down to a lake at 80.
    const s = [], ground = [], free = [];
    for (let k = 0; k <= 150; k++) {
        s.push(k * 20);
        const g = 100 - k * 0.12 + (k >= 50 && k < 60 ? -10 : 0) + (k >= 30 && k < 40 ? 6 : 0) + 2 * Math.sin(k * 0.7);
        ground.push(Math.max(78, g));
        free.push(riverCrestAbove(1.8));
    }
    const P = { ...RIVER_LEVEL_DEFAULTS };

    it('falls strictly and smoothly from the source level to the destination level', () => {
        const { eta, minSlope } = riverValleyLevels({ s, ground, free, srcLevel: 100, destLevel: 80 }, P);
        expect(minSlope).toBe(P.minSlope);
        expect(eta[0]).toBeCloseTo(100, 9);
        expect(eta[eta.length - 1]).toBeCloseTo(80, 6);
        let maxDrop = 0;
        for (let k = 1; k < eta.length; k++) {
            const drop = eta[k - 1] - eta[k];
            expect(drop).toBeGreaterThanOrEqual(P.minSlope * 20 - 1e-9);   // never flat, never rising
            maxDrop = Math.max(maxDrop, drop);
        }
        // Drops are spread (no steps): at most a few metres per 20 m point.
        expect(maxDrop).toBeLessThan(3);
    });

    it('stays under the ground beside the river (the floor is cut in), filling only a small share', () => {
        const { eta } = riverValleyLevels({ s, ground, free, srcLevel: 100, destLevel: 80 }, P);
        let fill = 0, n = 0;
        for (let k = 10; k < eta.length - 10; k++) {
            n++;
            if (eta[k] + free[k] > ground[k] - P.marginM + 1e-6) fill++;
        }
        expect(fill / n).toBeLessThan(0.2);
    });

    it('valley shape: floor = level + freeboard; no fill at the sill, at the end or in lakes', () => {
        const { eta } = riverValleyLevels({ s, ground, free, srcLevel: 100, destLevel: 80 }, P);
        const n = s.length, wc = new Array(n).fill(45), rise = ground.map(g => g + 20);
        const inLake = s.map((_, k) => k > n - 3);
        const fr = s.map(x => riverCrestAbove(1.8) * Math.min(1, x / P.outletRampM));
        const { F, wFill, sWall } = riverValleyShape({ s, eta, free: fr, wc, rise, inLake }, P);
        expect(F[0]).toBeCloseTo(100, 9);
        expect(wFill[0]).toBe(0);
        for (let k = 0; k < n; k++) {
            expect(F[k]).toBeCloseTo(eta[k] + fr[k], 9);
            expect(sWall[k]).toBeGreaterThanOrEqual(P.wallMin);
            expect(sWall[k]).toBeLessThanOrEqual(P.wallMax);
            if (inLake[k]) expect(wFill[k]).toBe(0);
        }
        expect(wFill[Math.floor(n / 2)]).toBe(1);
        expect(wFill[n - 1]).toBe(0);
    });

    it('segmentCells covers every cell the segment capsule touches', () => {
        // Rotated square cells of 50 m, a 40 m segment with reach 60 m.
        const th = 0.37, cs = Math.cos(th), sn = Math.sin(th);
        const cellAt = (x, y) => {
            const u = x * cs + y * sn, v = -x * sn + y * cs;
            return Math.floor(u / 50) * 1000 + Math.floor(v / 50);
        };
        for (const [ax, ay, bx, by] of [[3, 7, 43, 7], [10, 10, 30, 45], [0, 0, 0.5, 0]]) {
            const got = segmentCells(ax, ay, bx, by, 60, cellAt);
            const len = Math.hypot(bx - ax, by - ay);
            let missed = 0;
            for (let x = Math.min(ax, bx) - 62; x <= Math.max(ax, bx) + 62; x += 0.5) {
                for (let y = Math.min(ay, by) - 62; y <= Math.max(ay, by) + 62; y += 0.5) {
                    const t = len > 0 ? Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / (len * len))) : 0;
                    if (Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay)) <= 60 && !got.has(cellAt(x, y))) missed++;
                }
            }
            expect(missed).toBe(0);
        }
    });
});
