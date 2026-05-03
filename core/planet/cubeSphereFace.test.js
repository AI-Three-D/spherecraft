import { describe, it, expect } from 'vitest';
import {
    CubeSphereFace,
    CubeSphereFaceNames,
    getFaceName,
    getFaceNormal,
    getFaceUp,
    getFaceRight,
} from './cubeSphereFace.js';

describe('CubeSphereFace enum', () => {
    it('defines six faces with unique indices 0-5', () => {
        const values = Object.values(CubeSphereFace);
        expect(values).toHaveLength(6);
        expect(new Set(values).size).toBe(6);
        values.forEach(v => {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(5);
        });
    });
});

describe('getFaceName', () => {
    it('returns correct name for each face index', () => {
        expect(getFaceName(CubeSphereFace.POSITIVE_X)).toBe('POSITIVE_X');
        expect(getFaceName(CubeSphereFace.NEGATIVE_X)).toBe('NEGATIVE_X');
        expect(getFaceName(CubeSphereFace.POSITIVE_Y)).toBe('POSITIVE_Y');
        expect(getFaceName(CubeSphereFace.NEGATIVE_Y)).toBe('NEGATIVE_Y');
        expect(getFaceName(CubeSphereFace.POSITIVE_Z)).toBe('POSITIVE_Z');
        expect(getFaceName(CubeSphereFace.NEGATIVE_Z)).toBe('NEGATIVE_Z');
    });
    it('returns UNKNOWN for out-of-range index', () => {
        expect(getFaceName(99)).toBe('UNKNOWN');
        expect(getFaceName(-1)).toBe('UNKNOWN');
    });
});

describe('getFaceNormal', () => {
    it('returns unit vectors pointing along the correct axis', () => {
        expect(getFaceNormal(CubeSphereFace.POSITIVE_X)).toEqual([1, 0, 0]);
        expect(getFaceNormal(CubeSphereFace.NEGATIVE_X)).toEqual([-1, 0, 0]);
        expect(getFaceNormal(CubeSphereFace.POSITIVE_Y)).toEqual([0, 1, 0]);
        expect(getFaceNormal(CubeSphereFace.NEGATIVE_Y)).toEqual([0, -1, 0]);
        expect(getFaceNormal(CubeSphereFace.POSITIVE_Z)).toEqual([0, 0, 1]);
        expect(getFaceNormal(CubeSphereFace.NEGATIVE_Z)).toEqual([0, 0, -1]);
    });
    it('opposing faces have negated normals', () => {
        const px = getFaceNormal(CubeSphereFace.POSITIVE_X);
        const nx = getFaceNormal(CubeSphereFace.NEGATIVE_X);
        expect(px.map((v, i) => v + nx[i])).toEqual([0, 0, 0]);
    });
});

describe('getFaceUp', () => {
    it('returns a non-zero vector for every face', () => {
        for (let face = 0; face < 6; face++) {
            const up = getFaceUp(face);
            const len = Math.sqrt(up[0] ** 2 + up[1] ** 2 + up[2] ** 2);
            expect(len).toBe(1);
        }
    });
    it('up vector is perpendicular to face normal', () => {
        for (let face = 0; face < 6; face++) {
            const n = getFaceNormal(face);
            const u = getFaceUp(face);
            const dot = n[0] * u[0] + n[1] * u[1] + n[2] * u[2];
            expect(dot).toBe(0);
        }
    });
});

describe('getFaceRight', () => {
    it('returns a non-zero vector for every face', () => {
        for (let face = 0; face < 6; face++) {
            const r = getFaceRight(face);
            const len = Math.sqrt(r[0] ** 2 + r[1] ** 2 + r[2] ** 2);
            expect(len).toBe(1);
        }
    });
    it('right vector is perpendicular to face normal', () => {
        for (let face = 0; face < 6; face++) {
            const n = getFaceNormal(face);
            const r = getFaceRight(face);
            const dot = n[0] * r[0] + n[1] * r[1] + n[2] * r[2];
            expect(dot).toBe(0);
        }
    });
    it('right vector is perpendicular to up vector', () => {
        for (let face = 0; face < 6; face++) {
            const u = getFaceUp(face);
            const r = getFaceRight(face);
            const dot = u[0] * r[0] + u[1] * r[1] + u[2] * r[2];
            expect(dot).toBe(0);
        }
    });
});
