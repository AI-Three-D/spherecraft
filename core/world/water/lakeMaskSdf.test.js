import { describe, expect, it } from 'vitest';
import { lakeMaskSdf, resampleLakeMaskSdf } from './lakeMaskSdf.js';

// Region (2) cells x in [3, 6], all rows, on a 12 x 4 grid at 32 m; a shore band (1) beside it.
function strip(nx = 12, ny = 4) {
    const mask = new Uint8Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) mask[j * nx + i] = i >= 3 && i <= 6 ? 2 : (i === 2 || i === 7 ? 1 : 0);
    return mask;
}

describe('lake mask signed distance', () => {
    it('is +-half a cell next to the boundary and grows by a cell per cell away, ignoring the band', () => {
        const F = lakeMaskSdf(strip(), 12, 4, 32);
        const row = Array.from(F.slice(12, 24));
        expect(row[3]).toBeCloseTo(16, 5);
        expect(row[4]).toBeCloseTo(48, 5);
        expect(row[2]).toBeCloseTo(-16, 5);   // the band cell is outside the solved water
        expect(row[1]).toBeCloseTo(-48, 5);
        expect(row[0]).toBeCloseTo(-80, 5);
        expect(row[8]).toBeCloseTo(-48, 5);
    });

    it('measures across diagonals and caps far cells', () => {
        const nx = 9, ny = 9, mask = new Uint8Array(nx * ny);
        mask[4 * nx + 4] = 2;
        const F = lakeMaskSdf(mask, nx, ny, 10);
        expect(F[4 * nx + 4]).toBeCloseTo(5, 5);
        expect(F[3 * nx + 3]).toBeCloseTo(-(Math.SQRT2 * 10 - 5), 4);
        expect(F[0]).toBeCloseTo(-(Math.hypot(4, 4) * 10 - 5), 4);
        const none = lakeMaskSdf(new Uint8Array(4), 2, 2, 32);
        expect(Array.from(none)).toEqual([-127, -127, -127, -127]);
    });

    it('upsampled bilinearly: the boundary (128) falls between the region and its neighbours', () => {
        const F = lakeMaskSdf(strip(), 12, 4, 32);
        // 48 x 48 texels over 12 x 4 cells: 4 texels per cell across.
        const out = resampleLakeMaskSdf(F, 12, 4, 48);
        const row = Array.from(out.slice(24 * 48, 25 * 48)).map(v => v - 128);
        // Region cells 3..6 span texels 12..27; the zero crossing lies between texels 11 and 12.
        expect(row[11]).toBeLessThan(0);
        expect(row[12]).toBeGreaterThan(0);
        expect(row[27]).toBeGreaterThan(0);
        expect(row[28]).toBeLessThan(0);
        // Half a cell beyond (texel 9.5 ~ cell 2's centre) it is -16.
        expect(Math.abs((row[9] + row[10]) / 2 + 16)).toBeLessThan(2);
    });

    it('downsampled by the largest value: a one-cell channel stays water', () => {
        const nx = 64, ny = 64, mask = new Uint8Array(nx * ny);
        for (let j = 0; j < ny; j++) mask[j * nx + 30] = 2;
        const F = lakeMaskSdf(mask, nx, ny, 32);
        const out = resampleLakeMaskSdf(F, nx, ny, 16);
        // Texel column 7 covers cells 28..31.
        expect(out[8 * 16 + 7]).toBe(128 + 16);
        expect(out[8 * 16 + 3]).toBeLessThan(128);
    });
});
