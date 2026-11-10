import { describe, expect, it } from 'vitest';
import { dirToPlane, growPatchFrame, planeToDir, solveLakePatch, tangentBasis } from './lakeRefine.js';

// Patch heights from fn(i, j).
function patch(nx, ny, fn) {
    const h = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) h[j * nx + i] = fn(i, j);
    return h;
}
const NX = 40, NY = 30;
// Bowl centred at (20, 15): floor 0 m at the centre rising to 30 m at
// radius 10, a 50 m rim three cells thick (8-connected flow can't slip
// through diagonally), then a plain below 20 m sloping to the border. A
// channel at 35 m cuts the rim at j = 15 (i = 30..32): the spill point.
function bowlWithNotch(i, j) {
    const r = Math.hypot(i - 20, j - 15);
    if (r < 10) return 3 * r;
    if (r < 13) return j === 15 && i > 20 ? 35 : 50;
    return 20 - 0.5 * (r - 13);
}

describe('lake patch solve', () => {
    it('fills the bowl to the notch; the exit is the notch', () => {
        const h = patch(NX, NY, bowlWithNotch);
        const s = solveLakePatch({ heights: h, nx: NX, ny: NY, seed: 15 * NX + 20 });
        expect(s.level).toBe(35);
        expect(s.exit).toBe(15 * NX + 30);
        expect(Math.hypot((s.outlet % NX) - 30, Math.floor(s.outlet / NX) - 15)).toBeLessThan(1.5);
        expect(s.maxDepth).toBe(35);
        expect(s.touchesBorder).toBe(false);
        // Region = the whole bowl floor (r < 10, all below 30 m).
        let expected = 0;
        for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
            const inside = Math.hypot(i - 20, j - 15) < 10;
            if (inside) expected++;
            expect(s.region[j * NX + i]).toBe(inside ? 1 : 0);
        }
        expect(s.cells).toBe(expected);
    });

    it('any seed in the basin gives the same lake (nested pits fill to the basin level)', () => {
        const h = patch(NX, NY, (i, j) => bowlWithNotch(i, j) - ((i === 17 && j === 15) || (i === 23 && j === 14) ? 12 : 0));
        const a = solveLakePatch({ heights: h, nx: NX, ny: NY, seed: 15 * NX + 17 });
        const b = solveLakePatch({ heights: h, nx: NX, ny: NY, seed: 14 * NX + 23 });
        expect(a.level).toBe(35);
        expect(b.level).toBe(35);
        expect(Array.from(b.region)).toEqual(Array.from(a.region));
    });

    it('a seed on a slope has no lake', () => {
        const h = patch(NX, NY, (i) => 100 - 2 * i);
        expect(solveLakePatch({ heights: h, nx: NX, ny: NY, seed: 15 * NX + 20 })).toBeNull();
    });

    it('flags a lake that reaches the patch border', () => {
        // The same bowl, but the patch is cut through the bowl at i = 25.
        const nx = 26;
        const h = patch(nx, NY, (i, j) => bowlWithNotch(i, j));
        const s = solveLakePatch({ heights: h, nx, ny: NY, seed: 15 * nx + 20 });
        expect(s.touchesBorder).toBe(true);
    });
});

describe('tangent-plane frame', () => {
    it('maps plane points to directions and back', () => {
        const c = [0.3, -0.5, 0.81];
        const l = Math.hypot(...c);
        const frame = { c: c.map(v => v / l), ...tangentBasis(c.map(v => v / l)) };
        const R = 131072;
        for (const [x, y] of [[0, 0], [1234.5, -987.25], [-20000, 15000]]) {
            const [x2, y2] = dirToPlane(planeToDir(x, y, frame, R), frame, R);
            expect(x2).toBeCloseTo(x, 6);
            expect(y2).toBeCloseTo(y, 6);
        }
    });

    it('grows a frame around its centre', () => {
        const f = { c: [0, 0, 1], e1: [1, 0, 0], e2: [0, 1, 0], x0: -100, y0: -50, spacing: 10, nx: 20, ny: 10 };
        const g = growPatchFrame(f, 2);
        expect(g.nx).toBe(40);
        expect(g.ny).toBe(20);
        expect(g.x0 + g.nx * g.spacing / 2).toBeCloseTo(f.x0 + f.nx * f.spacing / 2, 9);
        expect(g.y0 + g.ny * g.spacing / 2).toBeCloseTo(f.y0 + f.ny * f.spacing / 2, 9);
    });
});
