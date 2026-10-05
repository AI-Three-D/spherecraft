import { describe, expect, it } from 'vitest';
import { corridorMask, fitNonIncreasing, riverLevels, riverPools, riverShape, segmentCells, smoothRiverPath, traceRiverPatch } from './riverRefine.js';

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

describe('river levels for the carve', () => {
    it('fitNonIncreasing: the least-squares fit that never rises', () => {
        expect(Array.from(fitNonIncreasing([5, 4, 6, 2, 3, 1]))).toEqual([5, 5, 5, 2.5, 2.5, 1]);
        expect(Array.from(fitNonIncreasing([1, 2, 3]))).toEqual([2, 2, 2]);
        expect(Array.from(fitNonIncreasing([3, 2, 1]))).toEqual([3, 2, 1]);
    });

    it('cut into the ground, never above the source or below the destination; the level never rises', () => {
        // Ground along a river: a rim, a deep hollow, then down to a lake at 80.
        const s = [], ground = [], depth = [];
        for (let k = 0; k <= 60; k++) {
            s.push(k * 40);
            const g = 100 - k * 0.3 + (k >= 20 && k < 26 ? -12 : 0) + (k >= 14 && k < 18 ? 4 : 0);
            ground.push(Math.max(78, g));
            depth.push(k % 7 === 3 ? 1.4 : 1.6 + k * 0.01);   // depth not monotone
        }
        const P = { waterFrac: 0.75, bankH: 1.5, rampM: 60 };
        const { eta, bed } = riverLevels(ground, s, depth, { srcLevel: 100, destLevel: 80 }, P);
        expect(eta[0]).toBe(100);                                   // no step at the outlet
        let cut = 0, fill = 0;
        for (let k = 0; k < eta.length; k++) {
            expect(eta[k]).toBeLessThanOrEqual(100);
            expect(eta[k]).toBeGreaterThanOrEqual(80);
            expect(eta[k] - bed[k]).toBeCloseTo(0.75 * depth[k], 9);
            if (k) expect(eta[k]).toBeLessThanOrEqual(eta[k - 1]);
            const crest = eta[k] + 0.25 * depth[k] + 1.5;
            if (s[k] >= 60 && eta[k] > 80) { cut = Math.max(cut, ground[k] - crest); fill = Math.max(fill, crest - ground[k]); }
        }
        // The rim is cut and the hollow filled, both by less than the hollow's depth.
        expect(cut).toBeGreaterThan(1);
        expect(fill).toBeGreaterThan(1);
        expect(Math.max(cut, fill)).toBeLessThan(12);
        expect(eta[eta.length - 1]).toBe(80);                       // meets the destination's level
    });

    it('riverPools: a hollow the river crosses is found, a valley falling downstream is not', () => {
        const nx = 80, ny = 40, spacing = 4, x0 = 0, y0 = 0;
        const corridor = new Uint8Array(nx * ny).fill(1);
        const px = [], py = [], eta = [];
        for (let k = 0; k <= 8; k++) { px.push(10 + k * 37.5); py.push(80); }
        // Flat ground at 10 with a bowl (radius 50 m, 5 m deep) at x = 160; level 9.
        const bowl = new Float32Array(nx * ny);
        for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
            const r = Math.hypot((i + 0.5) * spacing - 160, (j + 0.5) * spacing - 80);
            bowl[j * nx + i] = 10 - 5 * Math.max(0, 1 - (r / 50) ** 2);
        }
        for (let k = 0; k <= 8; k++) eta.push(9);
        const reach = riverPools({ heights: bowl, corridor, nx, ny, x0, y0, spacing, px, py, eta });
        // Beyond maxReachM of the line it is not counted.
        expect(Math.max(...riverPools({ heights: bowl, corridor, nx, ny, x0, y0, spacing, px, py, eta, maxReachM: 20 }))).toBeLessThan(30);
        // Below 8.75 m inside r < 43.3 m: the points near x = 160 see it.
        const mid = 4;   // x = 160
        expect(reach[mid]).toBeGreaterThan(38);
        expect(reach[mid]).toBeLessThan(52);
        expect(reach[0]).toBe(0);
        expect(reach[8]).toBe(0);
        // A valley falling along the river, the level 1 m below the ground at
        // every point: lower ground downstream is not water.
        const valley = new Float32Array(nx * ny), eta2 = [];
        for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) valley[j * nx + i] = 20 - 0.03 * (i + 0.5) * spacing;
        for (let k = 0; k <= 8; k++) eta2.push(20 - 0.03 * px[k] - 1);
        const none = riverPools({ heights: valley, corridor, nx, ny, x0, y0, spacing, px, py, eta: eta2 });
        expect(Math.max(...none)).toBe(0);
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
