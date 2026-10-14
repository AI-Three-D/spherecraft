import { describe, expect, it } from 'vitest';
import { carveSeams } from './carveSeams.js';
import { RIVER_SECTION, riverBankParams, riverSectionHeight } from '../../../core/world/water/riverSection.js';

// A patch of nx x ny samples at 0.5 m from h0(x, y) and carved(x, y, h0).
const patch = (nx, ny, natural, carved) => {
    const h = new Float32Array(nx * ny), h0 = new Float32Array(nx * ny);
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
        const X = x * 0.5, Y = y * 0.5, i = y * nx + x;
        h0[i] = natural(X, Y);
        h[i] = carved(X, Y, h0[i]);
    }
    return { h, h0 };
};

describe('carveSeams', () => {
    it('finds the line where the carve switches between two cuts', () => {
        // Cut 4 m deep below y = 20 m, 1 m deep above: a 3 m step along a row.
        const { h, h0 } = patch(40, 80, () => 10, (X, Y, g) => g - (Y < 20 ? 4 : 1));
        const r = carveSeams(h, h0, 40, 80);
        expect(r.count).toBe(40);
        expect(r.maxJumpM).toBeCloseTo(3, 5);
    });

    it('ignores steps in uncarved ground', () => {
        const { h, h0 } = patch(40, 40, (X) => (X < 10 ? 0 : 5), (X, Y, g) => g);
        expect(carveSeams(h, h0, 40, 40).count).toBe(0);
    });

    it('does not count a cut starting on a steep natural slope', () => {
        // 60 degree slope cut flat at 5 m (with the section's soft cut).
        const { h, h0 } = patch(80, 4, (X) => 1.7 * X, (X, Y, g) => 5 - Math.log1p(Math.exp(-(g - 5) / 0.25)) * 0.25);
        expect(carveSeams(h, h0, 80, 4).count).toBe(0);
    });

    it('does not count the section\'s steepest banks', () => {
        // Cut banks on both sides of an 8 m channel in ground 6 m above the water, across x.
        const cut = riverBankParams(2, 1), P = RIVER_SECTION;
        const { h, h0 } = patch(400, 4, (X) => 106 + 0.3 * Math.sin(X / 7), (X, Y, g) =>
            riverSectionHeight({ n: X - 100, hw: 8, bed: 98, depth: 2.5, skew: 0, h0: g, left: cut, right: cut }, P));
        const r = carveSeams(h, h0, 400, 4);
        expect(r.count).toBe(0);
    });
});
