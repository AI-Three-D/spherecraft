import { describe, it, expect } from 'vitest';
import { clamp, clamp01, clampInt, clampByte, degToRad, radToDeg, MathUtils } from './MathUtils.js';

describe('clamp', () => {
    it('returns value when within range', () => {
        expect(clamp(5, 0, 10)).toBe(5);
    });
    it('clamps to min', () => {
        expect(clamp(-1, 0, 10)).toBe(0);
    });
    it('clamps to max', () => {
        expect(clamp(11, 0, 10)).toBe(10);
    });
    it('handles equal min and max', () => {
        expect(clamp(5, 3, 3)).toBe(3);
    });
});

describe('clamp01', () => {
    it('returns value within [0, 1]', () => {
        expect(clamp01(0.5)).toBe(0.5);
    });
    it('clamps negative to 0', () => {
        expect(clamp01(-0.1)).toBe(0);
    });
    it('clamps above 1 to 1', () => {
        expect(clamp01(1.5)).toBe(1);
    });
});

describe('clampInt', () => {
    it('floors the value before clamping', () => {
        expect(clampInt(3.9, 0, 10)).toBe(3);
    });
    it('clamps to min', () => {
        expect(clampInt(-2.5, 0, 10)).toBe(0);
    });
    it('clamps to max', () => {
        expect(clampInt(10.9, 0, 10)).toBe(10);
    });
});

describe('clampByte', () => {
    it('returns value in [0, 255]', () => {
        expect(clampByte(128)).toBe(128);
    });
    it('clamps below 0 to 0', () => {
        expect(clampByte(-1)).toBe(0);
    });
    it('clamps above 255 to 255', () => {
        expect(clampByte(300)).toBe(255);
    });
    it('floors floats', () => {
        expect(clampByte(200.9)).toBe(200);
    });
});

describe('degToRad / radToDeg', () => {
    it('converts 180 degrees to PI', () => {
        expect(degToRad(180)).toBeCloseTo(Math.PI);
    });
    it('converts 90 degrees to PI/2', () => {
        expect(degToRad(90)).toBeCloseTo(Math.PI / 2);
    });
    it('converts PI radians to 180 degrees', () => {
        expect(radToDeg(Math.PI)).toBeCloseTo(180);
    });
    it('roundtrips correctly', () => {
        expect(radToDeg(degToRad(45))).toBeCloseTo(45);
    });
});

describe('MathUtils namespace', () => {
    it('exposes the same functions as top-level exports', () => {
        expect(MathUtils.clamp).toBe(clamp);
        expect(MathUtils.clamp01).toBe(clamp01);
        expect(MathUtils.clampInt).toBe(clampInt);
        expect(MathUtils.clampByte).toBe(clampByte);
        expect(MathUtils.degToRad).toBe(degToRad);
        expect(MathUtils.radToDeg).toBe(radToDeg);
    });
    it('DEG2RAD constant matches PI/180', () => {
        expect(MathUtils.DEG2RAD).toBeCloseTo(Math.PI / 180);
    });
});
