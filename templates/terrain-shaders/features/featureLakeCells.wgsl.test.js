import { describe, it, expect } from 'vitest';
import { LAKE_CELL_TIERS, createLakeCellsWgsl, lakeCellTierLimits } from './featureLakeCells.wgsl.js';
import { createLakeLandBase } from '../base/lakeLandBase.wgsl.js';

describe('lake cells', () => {
    it('keeps every tier inside the reach of its searches', () => {
        for (const t of LAKE_CELL_TIERS) {
            // A point finds its candidates in the 27 cells around it, a
            // candidate its overlapping neighbours in the 125 around it.
            const { reach, rbMax } = lakeCellTierLimits(t);
            expect(reach).toBeLessThanOrEqual(rbMax);
            expect(rbMax).toBeLessThanOrEqual(0.95 * t.cellM);
        }
    });

    it('rejects tiers whose rings do not fit or are out of order', () => {
        const [giant, large] = LAKE_CELL_TIERS;
        expect(() => createLakeCellsWgsl([{ ...large, lenMax: large.cellM }])).toThrow(/support too large/);
        expect(() => createLakeCellsWgsl([large, giant])).toThrow(/largest first/);
        expect(() => createLakeCellsWgsl([{ ...large, coarseBands: 4 }])).toThrow(/coarseBands/);
    });

    it('emits one tier case per tier into the lakeLand base', () => {
        const wgsl = createLakeLandBase();
        expect(wgsl).toContain(`const LAKE_TIER_COUNT: i32 = ${LAKE_CELL_TIERS.length};`);
        expect(wgsl.match(/t = LakeTier\(/g)).toHaveLength(LAKE_CELL_TIERS.length);
        for (const fn of ['fn landBands_d', 'fn calculateTerrainHeightBaseD', 'fn lakeCellFind', 'fn lakeCellQuery'])
            expect(wgsl).toContain(fn);
    });
});
