import { describe, expect, it } from 'vitest';
import { createRiverStrip } from './riverStrip.js';

// A straight river along a great circle (y = 0 plane), 2 km, points every
// 40 m: level falling 1 m per km, half-width 15 m.
const R = 131072;
function straightRiver() {
    const n = 51, st = 12, P = new Float32Array(n * st);
    for (let k = 0; k < n; k++) {
        const a = (k * 40) / R;
        P.set([Math.sin(a), 0, Math.cos(a), 100 - k * 0.04, 15, 1.05, 0.5, 3, 101, 0, 0, 0], k * st);
    }
    return { points: P, stride: st };
}

describe('river strip geometry', () => {
    it('arc length, frame and values along the river', () => {
        const strip = createRiverStrip(straightRiver(), R);
        expect(strip.length).toBeCloseTo(2000, 0);
        const f = strip.at(1000);
        // Flowing toward +x on the sphere at (sin a, 0, cos a): along ~ (cos a, 0, -sin a), left = up x along.
        expect(f.along[0]).toBeGreaterThan(0.99);
        expect(Math.abs(f.left[1])).toBeGreaterThan(0.99);
        expect(f.eta).toBeCloseTo(99, 2);
        expect(f.hw).toBeCloseTo(15, 3);
        expect(f.eta - f.bed).toBeCloseTo(1.05, 3);
        // Past the ends: straight on, level as at the end.
        const e = strip.at(2100);
        const a = 2100 / R;
        expect(e.c[0]).toBeCloseTo(Math.sin(a), 6);
        expect(e.eta).toBeCloseTo(100 - 50 * 0.04, 3);
    });

    it('nearest arc length and distance from a point beside the river', () => {
        const strip = createRiverStrip(straightRiver(), R);
        const a = 777 / R, off = 30 / R;
        const d = [Math.sin(a), off, Math.cos(a)];
        const l = Math.hypot(...d);
        const near = strip.nearest(d.map(v => v / l));
        expect(near.s).toBeCloseTo(777, 0);
        expect(near.dist).toBeCloseTo(30, 0);
        expect(strip.nearest(d.map(v => v / l), 700, 200).s).toBeCloseTo(777, 0);
    });
});
