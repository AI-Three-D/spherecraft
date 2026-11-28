import { describe, expect, it } from 'vitest';
import { parseWgsl, validate } from 'naga-wasm';
import {
    ECO_FACES, cellAreaM2, cellAxesM, cellsWithin, directionToFace, ecoBefore, ecoCellHash, ecoId, faceDirection, hash3,
    latticeFor, latticeLevel, latticeRank, neighbourCell, pcg,
} from './ecologyLattice.js';
import { ECOLOGY_LATTICE_WGSL } from './ecologyLattice.wgsl.js';

const R = 131072;

describe('ecology lattice', () => {
    it('validates as WGSL', () => {
        expect(() => validate(parseWgsl(`${ECOLOGY_LATTICE_WGSL}\n@compute @workgroup_size(1) fn main() {}`))).not.toThrow();
    });

    it('hashes as the grass always has (pcg, hash3 of x, y, face)', () => {
        // Known answers, worked out apart from this code in Python's unbounded integers masked to 32 bits.
        expect(pcg(0)).toBe(129708002);
        expect(pcg(1)).toBe(2831084092);
        expect(pcg(123456789)).toBe(4272394698);
        expect(hash3(1234, 5678, 3)).toBe(1827298604);
        expect(ecoCellHash(3, 1234, 5678, 0, 0)).toBe(hash3(1234, 5678, 3));
        expect(ecoCellHash(3, 1234, 5678, 1, 0)).not.toBe(hash3(1234, 5678, 3));
        expect(ecoCellHash(3, 1234, 5678, 0, 1)).not.toBe(ecoCellHash(3, 1234, 5678, 0, 0));
    });

    it('ranks nested lattice points coarse first', () => {
        expect(latticeLevel(16, 32)).toBe(4);
        expect(latticeLevel(2, 6)).toBe(1);
        expect(latticeLevel(3, 5)).toBe(0);
        expect(latticeRank(4, 0.99)).toBeLessThan(latticeRank(3, 0.01));
        expect(latticeRank(1, 0.5)).toBeGreaterThan(latticeRank(2, 0.5));
    });

    it('orders candidates by priority, then id', () => {
        const a = ecoId(2, 14, 100, 200, 0), b = ecoId(2, 14, 101, 200, 0);
        expect(ecoBefore(1, a, 0, b)).toBe(true);
        expect(ecoBefore(0, a, 0, b)).toBe(true);
        expect(ecoBefore(0, b, 0, a)).toBe(false);
    });

    it('maps directions to faces and back for every face', () => {
        for (let face = 0; face < 6; face++) {
            for (const [u, v] of [[0.1, 0.2], [0.5, 0.5], [0.93, 0.07]]) {
                const back = directionToFace(faceDirection(face, u, v));
                expect(back.face).toBe(face);
                expect(back.u).toBeCloseTo(u, 12);
                expect(back.v).toBeCloseTo(v, 12);
            }
        }
    });

    it('measures cells on the sphere: a face is a sixth of it, and corner cells are about a fifth of middle ones', () => {
        const level = 6, n = 2 ** level;
        let sum = 0;
        for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) sum += cellAreaM2(0, level, ix, iy, R);
        expect(sum / (4 * Math.PI * R * R / 6)).toBeCloseTo(1, 10);
        const ratio = cellAreaM2(0, 12, 0, 0, R) / cellAreaM2(0, 12, 2048, 2048, R);
        expect(ratio).toBeGreaterThan(0.18);
        expect(ratio).toBeLessThan(0.21);
        const [au, av] = cellAxesM(0, 12, 2048, 2048, R);
        expect(au * av / cellAreaM2(0, 12, 2048, 2048, R)).toBeCloseTo(1, 3);
        expect(latticeFor(128, R)).toBe(11);
    });

    it('finds the neighbour across a face edge, and comes back', () => {
        const level = 8, n = 2 ** level;
        for (let face = 0; face < 6; face++) {
            for (const [ix, iy, dx, dy] of [[n - 1, 40, 1, 0], [0, 77, -1, 0], [12, n - 1, 0, 1], [200, 0, 0, -1]]) {
                const there = neighbourCell(face, level, ix, iy, dx, dy);
                expect(there.face).not.toBe(face);
                // Stepping back toward the first face from there lands where we began.
                const centre = faceDirection(face, (ix + 0.5) / n, (iy + 0.5) / n);
                const back = directionToFace(centre);
                expect(back.face).toBe(face);
                const candidates = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([ex, ey]) => neighbourCell(there.face, level, there.ix, there.iy, ex, ey));
                expect(candidates.some(c => c.face === face && c.ix === ix && c.iy === iy)).toBe(true);
            }
        }
    });

    it('lists the cells about a three-face corner from each face, the same set in the same order', () => {
        const level = 14, n = 2 ** level;
        // The corner where faces 0 (+x), 2 (+y) and 4 (+z) meet: (u, v) = (0, 1) on face 0.
        const fromFace0 = cellsWithin(0, level, 0, n - 1, 40, R);
        const faces = new Set(fromFace0.map(c => c.face));
        expect(faces.size).toBe(3);
        const corner = cellsWithin(0, level, 0, n - 1, 40, R).map(c => `${c.face}/${c.ix}/${c.iy}`);
        expect(cellsWithin(0, level, 0, n - 1, 40, R).map(c => `${c.face}/${c.ix}/${c.iy}`)).toEqual(corner);
        // Each listed cell, asked about the corner cell, lists it back (owned once, found from every side).
        for (const c of fromFace0) {
            const back = cellsWithin(c.face, level, c.ix, c.iy, 40, R);
            expect(back.some(b => b.face === 0 && b.ix === 0 && b.iy === n - 1)).toBe(true);
        }
        expect(ECO_FACES.length).toBe(6);
    });
});
