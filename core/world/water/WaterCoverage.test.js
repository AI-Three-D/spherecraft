import { describe, expect, it } from 'vitest';
import { coarser, lakeCellListed, riverPageCells } from './WaterCoverage.js';
import { fieldCoords, fieldDir, riverFieldLayout } from './riverField.js';
import { dirToCell } from '../hydrology/waterGraph.js';

describe('water coverage', () => {
    it('covers every cell a page of the river field touches', () => {
        const L = riverFieldLayout(131072), N = 512;
        for (const [face, pi, pj] of [[0, 3, 5], [2, 1600, 1700], [5, L.PE - 1, 0], [4, 900, 17]]) {
            const [f, i0, j0, i1, j1] = riverPageCells({ face, pi, pj }, L, N);
            for (const fx of [-0.04, 0, 0.3, 1, 1.04]) for (const fy of [-0.04, 0, 0.6, 1, 1.04]) {
                const x = (pi + fx) * L.P, y = (pj + fy) * L.P;
                if (x < 0 || y < 0 || x > L.T || y > L.T) continue;
                const dir = fieldDir(face, x, y, L);
                if (fieldCoords(dir, L).face !== face) continue;
                const cell = dirToCell(dir, N) - f * N * N;
                expect(cell % N).toBeGreaterThanOrEqual(i0);
                expect(cell % N).toBeLessThanOrEqual(i1);
                expect(Math.floor(cell / N)).toBeGreaterThanOrEqual(j0);
                expect(Math.floor(cell / N)).toBeLessThanOrEqual(j1);
            }
        }
    });
    it('finds lakes in either word, not the river bit', () => {
        const cells = 4, index = new Uint32Array(8);
        index[1] = 1 << 30;
        index[2] = 7;
        index[cells + 3] = 5 << 17;
        index[cells + 1] = 99;
        expect([0, 1, 2, 3].map(c => lakeCellListed(index, cells, c))).toEqual([false, false, true, true]);
        index[0] = 0x80000001;
        expect(lakeCellListed(index, cells, 0)).toBe(true);
    });
    it('sets a coarser cell where any of its four is', () => {
        const fine = new Uint8Array(16);
        fine[5] = 1;
        fine[10] = 1;
        expect([...coarser(fine, 4)]).toEqual([1, 0, 0, 1]);
    });
});
