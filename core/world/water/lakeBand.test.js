import { describe, expect, it } from 'vitest';
import { riverCarveReach, trimLakeBand } from './lakeBand.js';

const R = 100000;
// Lake patch around (0, 0, 1): 8 x 8 cells of 16 m from x, y = -64; water
// (2) in columns 0..3 (x < 0), shore band (1) in columns 4 and 5.
function lake() {
    const mask = new Uint8Array(64);
    for (let j = 0; j < 8; j++) for (let i = 0; i < 6; i++) mask[j * 8 + i] = i < 4 ? 2 : 1;
    return { frame: { c: [0, 0, 1], e1: [1, 0, 0], e2: [0, 1, 0], x0: -64, y0: -64, spacing: 16, nx: 8, ny: 8 }, mask };
}
// A river along x = xM (m), points every 16 m in y; pool -1 (in a lake) or 0.
function river(xM, pool) {
    const st = 12, P = new Float32Array(9 * st);
    for (let k = 0; k < 9; k++) {
        const d = [xM / R, (-64 + 16 * k) / R, 1], l = Math.hypot(...d);
        P.set([d[0] / l, d[1] / l, d[2] / l, 100, 5, 2, 1, 0, 0, pool, 0, 0], k * st);
    }
    return { points: P, stride: st };
}
const reach = riverCarveReach({ bankW: 12, blendW: 30, widthVar: 0.2, wobble: 0.15 });
const cols = (mask) => Array.from({ length: 8 }, (_, i) => mask[3 * 8 + i]);

describe('lake shore band beside rivers', () => {
    it('clears band cells within the carve reach of a river outside lakes, keeps water', () => {
        const L = lake();
        const out = trimLakeBand(L, [river(60, 0)], R, reach);
        expect(cols(out)).toEqual([2, 2, 2, 2, 0, 0, 0, 0]);
        expect(cols(L.mask)).toEqual([2, 2, 2, 2, 1, 1, 0, 0]);   // the record's mask untouched
    });

    it('keeps the band beside a river inside the lake and far from rivers', () => {
        const L = lake();
        expect(trimLakeBand(L, [river(60, -1)], R, reach)).toBe(L.mask);
        expect(trimLakeBand(L, [river(400, 0)], R, reach)).toBe(L.mask);
    });

    it('the reach grows with the half-width and the shape noise', () => {
        expect(reach(10) - reach(0)).toBeCloseTo(10 * 1.35, 6);
        expect(reach(0)).toBe(12 + 30 + 8);
    });
});
