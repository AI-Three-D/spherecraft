import { describe, expect, it } from 'vitest';
import { cellDir, dirToCell } from '../../../core/world/hydrology/waterGraph.js';
import { coverage, distanceToCells } from './riverCoverage.js';

describe('distanceToCells', () => {
    it('measures distances over the cube grid, across face edges', () => {
        const N = 32, R = 1000, src = dirToCell([1, 0, 0], N);
        const d = distanceToCells(N, R, [src]);
        expect(d[src]).toBe(0);
        // The cell on the far side: at least the great-circle distance between
        // the cell centres, and not much more (grid paths zigzag a little).
        const far = dirToCell([-1, 0, 0], N), a = cellDir(src, N), b = cellDir(far, N);
        const arc = Math.acos(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) * R;
        expect(d[far]).toBeGreaterThan(arc * 0.999);
        expect(d[far]).toBeLessThan(arc * 1.15);
        // A neighbour is one cell step away.
        const c = cellDir(src, N), n = dirToCell([c[0], c[1] + 2 / N, c[2]], N);
        expect(d[n]).toBeGreaterThan(0);
        expect(d[n]).toBeLessThan(4 * R / N);
    });

    it('summarizes the masked cells', () => {
        const dist = Float32Array.from([0, 1000, 3000, 6000, 20000]);
        const r = coverage(dist, Uint8Array.from([1, 1, 1, 1, 0]), [2000, 5000]);
        expect(r.cells).toBe(4);
        expect(r.p50).toBe(1000);
        expect(r.within[2000]).toBe(0.5);
        expect(r.within[5000]).toBe(0.75);
    });
});
