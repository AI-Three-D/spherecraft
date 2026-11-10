import { describe, expect, it } from 'vitest';
import { TerrainGenerationConfig } from '../../../templates/configs/terrainGenerationConfig.js';
import { naturalFinalLowerBound, reliefErosionLowerBound, softClampTerrainMeters, terrainDisplacementBudgets } from './terrainHeightContract.js';
import { regionalTerrainOptions } from './regionalTerrain.js';

describe('ordinary terrain height contract', () => {
    const ef = new TerrainGenerationConfig().erosionFilter;
    const budgets = terrainDisplacementBudgets({ erosionFilter: ef });
    it('includes style, every erosion octave, meso overshoot and final micro', () => {
        expect(budgets.erosionM).toBeCloseTo(415.59375, 8);
        expect(budgets.reliefErosionLowerM).toBeCloseTo(-83.11875, 8);
        expect(budgets.mesoM).toBe(270);
        expect(budgets.microM).toBe(24.4);
        expect(budgets.lakeHollowM).toBe(25);
        expect(terrainDisplacementBudgets({ erosionFilter: { ...ef, gain: 1, octaves: 8 } }).erosionM)
            .toBeCloseTo(1716, 8);
    });
    it('bounds fade-target cancellation for masks that close after the first octave', () => {
        // Closing later masks caused the old initial-mask-only cancellation
        // bug. Verify the actual accumulated initial fade coefficient.
        for (const initialFade of [-1, 0.3, 1]) {
            for (const masks of [[0, 0, 0, 0, 0], [1, 0, 0, 0, 0], [0.1, 0.8, 0.2, 0, 1]]) {
                let fade = initialFade, product = 1, keep = 0, height = 0;
                let strength = ef.strength * ef.scale * budgets.maxAmount;
                for (let i = 0; i < masks.length; i++) {
                    fade = fade * (1 - masks[i]) - ef.gullyWeight * masks[i];
                    product *= 1 - masks[i];
                    keep += strength * product;
                    height += strength * fade;
                    strength *= ef.gain;
                }
                expect(Math.abs(height - initialFade * keep)).toBeLessThanOrEqual(budgets.erosionM + 1e-9);
            }
        }
    });
    it('covers the soft clamps and ocean blend rather than treating a land bound as universal', () => {
        const input = { foundationMinM: 1000, oceanMinM: -3750, maxH: 5000, budgets };
        const land = naturalFinalLowerBound({ ...input, fullyLand: true });
        const coast = naturalFinalLowerBound({ ...input, fullyLand: false });
        expect(land).toBeCloseTo(596.48125, 7);
        expect(coast).toBeCloseTo(-3775.4, 7);
        expect(softClampTerrainMeters(-100000, 5000)).toBeCloseTo(-5500, 7);
    });
    it('fails explicitly for unsupported erosion configurations', () => {
        expect(() => terrainDisplacementBudgets({ erosionFilter: { ...ef, gain: -0.5 } })).toThrow();
        expect(() => terrainDisplacementBudgets({ erosionFilter: { ...ef, detail: 0 } })).toThrow();
        expect(() => regionalTerrainOptions({ cells: 127 })).toThrow();
        expect(() => regionalTerrainOptions({ seamCells: 0 })).toThrow();
    });
    it('rejects basin parameters that invalidate shape or opposing-rim fitting', () => {
        expect(() => regionalTerrainOptions({basins:{enabled:true,rimSegments:23}})).toThrow();
        expect(() => regionalTerrainOptions({basins:{enabled:true,rimSegments:24}})).toThrow();
        expect(() => regionalTerrainOptions({basins:{enabled:true,rimCandidates:129}})).toThrow();
        expect(() => regionalTerrainOptions({basins:{enabled:true,bankReachM:-1}})).toThrow();
        expect(() => regionalTerrainOptions({basins:{enabled:true,bankReachM:31}})).toThrow();
        expect(regionalTerrainOptions({basins:{enabled:true,bankReachM:0}}).basins.bankReachM).toBe(0);
        expect(() => regionalTerrainOptions({basins:{enabled:true,maxRoughness:1.01}})).toThrow();
        expect(() => regionalTerrainOptions({basins:{enabled:true,candidateMinM:101}})).toThrow();
        expect(regionalTerrainOptions({basins:{enabled:true,minLevelM:900}}).basins.candidateMinM).toBe(100);
        expect(regionalTerrainOptions({basins:{enabled:true,candidates:1}}).basins.rimCandidates).toBe(1);
    });
    it('finds interior minima for a stronger erosion ramp and includes every relief value', () => {
        for (const allowanceM of [0, 415.59375, 2000]) for (const lowAmount of [0, .2, 1, 1.4]) {
            const lower = reliefErosionLowerBound({ allowanceM, lowAmount, startM: 150, fullM: 600 });
            for (let r = 0; r <= 3000; r += .25) {
                const t = Math.min(1, Math.max(0, (r - 150) / 450));
                const value = r - allowanceM * (lowAmount + (1 - lowAmount) * t*t*(3 - 2*t));
                expect(value + 1e-9).toBeGreaterThanOrEqual(lower);
            }
        }
        expect(reliefErosionLowerBound({ allowanceM: 2000, lowAmount: .2, startM: 150, fullM: 600 })).toBeLessThan(-1400);
    });
});
