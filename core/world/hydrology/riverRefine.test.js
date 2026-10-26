import { describe, expect, it } from 'vitest';
import { RIVER_SECTION } from '../water/riverSection.js';
import { corridorMask, fitNonIncreasingQuantile, RIVER_LEVEL_DEFAULTS, riverCrestAbove, riverDelta, riverLakeHold, riverReachShape, riverShape, RIVER_SHAPE_DEFAULTS, riverValleyLevels, riverLakeRims, segmentCells, smoothRiverPath, traceRiverPatch, trunkLevelAt } from './riverRefine.js';

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
    it('has pools and constrictions while only the surface is constrained downhill', () => {
        const widths = [], depths = [], beds = [];
        for (let s = 500; s < 5000; s += 10) {
            const shape = riverReachShape({ width: 40, depth: 3, speed: 1 }, s, 6000, 17);
            widths.push(shape.width); depths.push(shape.depth);
            beds.push(100 - s * 0.0003 - 0.75 * shape.depth);
        }
        expect(Math.max(...widths) / Math.min(...widths)).toBeGreaterThan(1.8);
        expect(Math.max(...depths) / Math.min(...depths)).toBeGreaterThan(1.6);
        expect(beds.some((b, k) => k > 0 && b > beds[k - 1])).toBe(true);
        const mouth = riverReachShape({ width: 40, depth: 3 }, 0, 6000, 17);
        expect(mouth.width).toBeGreaterThan(60);
    });

    it('widens into a lake as a delta, 1.6-4 x, a third of the rivers 3-4 x', () => {
        const scales = [];
        for (let river = 0; river < 300; river++) {
            expect(riverDelta(1000 - 400, 1000, river, 12)).toBe(1);
            const at = riverDelta(1000, 1000, river, 12);
            expect(riverDelta(1000 - 30, 1000, river, 12)).toBeLessThan(at);
            scales.push(at);
        }
        expect(Math.min(...scales)).toBeGreaterThanOrEqual(1.6);
        expect(Math.max(...scales)).toBeLessThanOrEqual(4);
        const big = scales.filter(x => x >= 3).length / scales.length;
        expect(big).toBeGreaterThan(0.25);
        expect(big).toBeLessThan(0.45);
        const small = riverShape(0, 0.001), P = { ...RIVER_SHAPE_DEFAULTS, junctionEndM: 3000, typicalWidthM: 12, deltaLake: true };
        const mouth = riverReachShape(small, 3000, 3100, 5, P), up = riverReachShape(small, 2000, 3100, 5, P);
        expect(mouth.depth).toBeLessThan(up.depth);
    });

    it('narrows the smallest rivers to minReachWidthM at most', () => {
        const small = riverShape(0, 0.001);
        expect(small.width).toBe(12);
        const widths = [];
        for (let s = 500; s < 5000; s += 10) widths.push(riverReachShape(small, s, 6000, 17).width);
        expect(Math.min(...widths)).toBe(8);
        expect(Math.max(...widths)).toBeGreaterThan(12);
    });

    it('keeps lake overlaps flat and a positive slope even with a tiny total drop', () => {
        const s = Array.from({ length: 51 }, (_, k) => k * 20);
        const { eta, minSlope } = riverValleyLevels({ s, ground: s.map(() => 100), free: s.map(() => 1), srcLevel: 100, destLevel: 99.98, sourceEnd: 5, destStart: 46 });
        expect(eta[0]).toBe(100); expect(eta[5]).toBe(100);
        expect(eta[46]).toBeCloseTo(99.98, 10); expect(eta[50]).toBeCloseTo(99.98, 10);
        expect(minSlope).toBeGreaterThan(0);
        for (let k = 6; k <= 46; k++) expect(eta[k]).toBeLessThan(eta[k - 1]);
    });
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
        // Small drops are spread into rapids; the 10 m hollow stays a fall.
        expect(maxDrop).toBeLessThan(10);
    });

    it('follows a steep mountain stream: no slot below the fit, no water above the falling ground', () => {
        // 12 % slope with bumps, from a lake at 500 m, a 6 m step at 1 km.
        const s2 = [], g2 = [], f2 = [];
        for (let k = 0; k <= 100; k++) {
            s2.push(k * 20);
            g2.push(500 - 0.12 * k * 20 - (k >= 50 ? 6 : 0) + 1.5 * Math.sin(k * 0.9));
            f2.push(riverCrestAbove(0.8));
        }
        const { eta } = riverValleyLevels({ s: s2, ground: g2, free: f2, srcLevel: 500, destLevel: g2[100] - 2 }, P);
        for (let k = 1; k < 95; k++) {
            const surface = g2[k] - f2[k] - P.marginM;
            // Never held above the ground's surface (allowing the ramp's rise),
            expect(eta[k]).toBeLessThanOrEqual(surface + P.rampRiseM + 1e-9);
            // and at its running minimum (the fit through the bumps), not
            // lowered further: averaging downstream put steep streams 2 m deeper.
            let lowUp = Infinity;
            for (let j = 0; j <= k; j++) lowUp = Math.min(lowUp, g2[j] - f2[j] - P.marginM);
            expect(eta[k]).toBeGreaterThan(lowUp - 0.5);
        }
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

describe('source lake hold', () => {
    const hold = (held, sourceEnd, destStart) => {
        const eta = Float64Array.from([100, 100, 99.5, 99, 98.5, 98, 97]);
        return { end: riverLakeHold({ eta, held, srcLevel: 100, sourceEnd, destStart }), eta: Array.from(eta) };
    };
    it('holds the lake level while the lake water lies beside the channel, the fit beyond', () => {
        expect(hold([0, 0, 1, 1, 0, 1, 1], 1, 6)).toEqual({ end: 3, eta: [100, 100, 100, 100, 98.5, 98, 97] });
        expect(hold([0, 0, 0, 1, 1, 1, 1], 1, 6)).toEqual({ end: 1, eta: [100, 100, 99.5, 99, 98.5, 98, 97] });
        expect(hold([1, 1, 1, 1, 1, 1, 1], 1, 4).end).toBe(3);
    });
});

describe('trunk level', () => {
    it('takes the trunk\'s level where the tributary meets it, along its nearest segment', () => {
        // A trunk descending 2 m per 20 m point along x, bending north at x = 60.
        const pts = [[0, 0], [20, 0], [40, 0], [60, 0], [60, 20], [60, 40]];
        const etas = [110, 108, 106, 104, 102, 100];
        expect(trunkLevelAt(pts, etas, 30, 3).level).toBeCloseTo(107, 9);
        expect(trunkLevelAt(pts, etas, 30, 3).distM).toBeCloseTo(3, 9);
        expect(trunkLevelAt(pts, etas, 64, 30).level).toBeCloseTo(101, 9);
        // Beyond the ends: the end points' levels.
        expect(trunkLevelAt(pts, etas, -15, 0).level).toBe(110);
        expect(trunkLevelAt(pts, etas, 60, 55).level).toBe(100);
    });
});

describe('lake rims', () => {
    it('raise the bank on the side the water is on, near it, falling off along the river', () => {
        // A river along x (y = 0) through a 2 km patch at 16 m; a lake (level 50) north of it at y > 40 m, x < 0.
        const nx = 125, ny = 125, spacing = 16, x0 = -1000, y0 = -1000;
        const water = new Uint8Array(nx * ny), level = new Float32Array(nx * ny);
        for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
            const x = x0 + (i + 0.5) * spacing, y = y0 + (j + 0.5) * spacing;
            if (y > 40 && x < 0) { water[j * nx + i] = 1; level[j * nx + i] = 50; }
        }
        const n = 41, xs = Float64Array.from({ length: n }, (_, k) => -400 + 20 * k), ys = new Float64Array(n), s = Float64Array.from(xs, x => x + 400);
        const hw = new Float64Array(n).fill(5);
        const { left, right } = riverLakeRims({ x: xs, y: ys, s, hw, reach: new Float64Array(n).fill(120), water, level, nx, ny, x0, y0, spacing });
        const P = RIVER_SECTION, at = (x) => xs.indexOf(x);
        // Left (north): its bank 20 m out (y = 25) within the band of the water (y > 40): the full rim.
        expect(left[at(-200)]).toBeCloseTo(50 + P.lakeMarginM, 6);
        // Right: its nearest bank point 10 m south, the water's cell centres 58 m from it.
        expect(right[at(-200)]).toBeCloseTo(50 + P.lakeMarginM - P.lakeSlope * (Math.hypot(8, 58) - P.lakeBandM), 6);
        expect(right[at(-200)]).toBeLessThan(left[at(-200)]);
        for (let k = 1; k < n; k++) expect(Math.abs(left[k] - left[k - 1])).toBeLessThanOrEqual(P.lakeSlope * 20 + 1e-9);
        // 400 m past the lake: far below the ground near it.
        expect(left[at(400)]).toBeLessThan(0);
    });
});
