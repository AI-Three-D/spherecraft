import { describe, expect, it } from 'vitest';
import { channelTest, lakeSpill } from './lakeSpill.js';

describe('lakeSpill', () => {
    it('counts banks lowered below the level, not channels or the lake itself', () => {
        // 4 samples: lake bed, a channel cut, a bank cut below the level, a bank left above it.
        const h0 = Float32Array.from([9, 12, 12, 12]), h = Float32Array.from([9, 8, 9.5, 10.5]);
        const r = lakeSpill(h, h0, 10, (i) => i === 1, 2, { nx: 4, spacing: 1 });
        expect(r).toEqual({ spillM2: 2, channelM2: 2, naturalM2: 2 });
    });

    it('counts only ground near the lake', () => {
        // A row of 60 samples at 1 m: the lake at x = 0, banks cut below its level everywhere.
        const h0 = new Float32Array(60).fill(12), h = new Float32Array(60).fill(9);
        h0[0] = 5; h[0] = 5;
        expect(lakeSpill(h, h0, 10, () => false, 1, { nx: 60, spacing: 1, nearM: 20 }).spillM2).toBe(20);
    });

    it('tests the channel by distance to the traced line', () => {
        const inside = channelTest([{ xy: Float64Array.from([0, 0, 100, 0]), hw: Float64Array.from([5, 15]) }]);
        expect(inside(50, 9)).toBe(true);    // half-width 10 at x = 50
        expect(inside(50, 11)).toBe(false);
        expect(inside(-4, 0)).toBe(true);    // round end
    });
});
