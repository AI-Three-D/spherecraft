import { describe, expect, it } from 'vitest';
import { bakeRiverWaterfalls } from './riverFeatures.js';

const R = 131072, ST = 20;
function river(slope) {
    const arc = Float64Array.from({ length: 151 }, (_, k) => k * 20);
    const points = new Float32Array(arc.length * ST);
    for (let k = 0; k < arc.length; k++) {
        const s = arc[k], level = 500 - slope * s;
        points.set([Math.sin(s / R), 0, Math.cos(s / R), level, 20, 2, 1, 10, level, 0, 0, 0, level + 1, 50, 1, 0.1, level, 2, -1e20, 0], k * ST);
    }
    return { points, arc };
}

describe('baked river waterfalls', () => {
    it('leaves gentle rivers alone', () => {
        for (const slope of [0.0003, 0.04]) {
            const r = river(slope), out = bakeRiverWaterfalls(r.points, ST, r.arc);
            expect(out.waterfalls).toEqual([]);
            expect(out.points).toBe(r.points);
        }
    });

    it('concentrates an existing drop without changing endpoints or creating an uphill surface', () => {
        const r = river(0.12), out = bakeRiverWaterfalls(r.points, ST, r.arc);
        expect(out.waterfalls.length).toBeGreaterThan(0);
        expect(out.points[16]).toBe(r.points[16]);
        expect(out.points[out.points.length - ST + 16]).toBe(r.points[r.points.length - ST + 16]);
        let steep = false, pool = false;
        for (let k = 1; k < out.arc.length; k++) {
            const o = k * ST, prev = o - ST;
            expect(out.points[o + 16]).toBeLessThanOrEqual(out.points[prev + 16]);
            expect(out.points[o + 5]).toBeGreaterThan(0);
            if ((out.points[prev + 16] - out.points[o + 16]) / (out.arc[k] - out.arc[k - 1]) > 0.5) steep = true;
            if (out.points[o + 5] > 2.5) pool = true;
        }
        expect(steep).toBe(true); expect(pool).toBe(true);
        expect(out.points.length).toBeLessThan(r.points.length * 1.15);
    });

    it('does not put a waterfall through lake water', () => {
        const r = river(0.12);
        for (let o = 0; o < r.points.length; o += ST) r.points[o + 9] = -1;
        expect(bakeRiverWaterfalls(r.points, ST, r.arc).waterfalls).toEqual([]);
    });
});
