import { expect, it } from 'vitest';
import { pondOverlapGroups } from './pondOverlapGroups.js';

const frame = { c: [1, 0, 0], e1: [0, 1, 0], e2: [0, 0, 1], x0: -100, y0: -100, nx: 10, ny: 10, spacing: 20 };
const pond = (x0, x1) => ({ rec: { frame, mask: Uint8Array.from({ length: 100 }, (_, i) => i % 10 >= x0 && i % 10 < x1 ? 2 : 0) } });

it('groups overlapping ponds transitively and keeps dry or separated ponds apart', () => {
    const ponds = [pond(0, 3), pond(2, 6), pond(5, 8), pond(9, 10), pond(0, 0)];
    expect(pondOverlapGroups(ponds, 131000)).toEqual([[0, 1, 2]]);
});
