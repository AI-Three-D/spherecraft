import { expect, it } from 'vitest';
import { removeSubmergedPonds } from './submergedPonds.js';

const frame = { c: [1, 0, 0], e1: [0, 1, 0], e2: [0, 0, 1], x0: -100, y0: -100, nx: 10, ny: 10, spacing: 20 };
const pond = (level, mask) => ({ rec: { level, frame, mask: Uint8Array.from(mask) } });

it('removes a fully submerged lower pond regardless of input order', () => {
    const higher = pond(20, Array(100).fill(2)), lower = pond(10, Array.from({ length: 100 }, (_, i) => i % 10 >= 3 && i % 10 <= 6 && Math.floor(i / 10) >= 3 && Math.floor(i / 10) <= 6 ? 2 : 0));
    expect(removeSubmergedPonds([lower, higher], 131000)).toEqual([higher]);
    expect(removeSubmergedPonds([higher, lower], 131000)).toEqual([higher]);
});

it('retains a lower pond when any of its water lies outside the higher one', () => {
    const higher = pond(20, Array.from({ length: 100 }, (_, i) => i % 10 < 5 ? 2 : 0));
    const lower = pond(10, Array.from({ length: 100 }, (_, i) => i % 10 >= 3 && i % 10 <= 6 ? 2 : 0));
    expect(removeSubmergedPonds([lower, higher], 131000)).toEqual([lower, higher]);
});
