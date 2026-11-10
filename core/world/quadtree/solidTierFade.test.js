import { describe, expect, it } from 'vitest';
import { computeSolidTierFadeDistances, tileNearestDistanceLowerBound } from './solidTierFade.js';

const SHADER_CONFIG = {
    solidColorTierEnabled: true,
    solidColorTierDistanceFadeEnabled: true,
    solidColorStartLod: 5,
    solidColorTierDistanceFadeBandFraction: 0.3,
    solidColorTierDistanceFadeHeightMarginMeters: 1000,
    solidColorTierDistanceFadeEndSafety: 0.5
};

describe('computeSolidTierFadeDistances', () => {
    it('reproduces the ramp the renderer used at 1800 px (lodFactor 1173)', () => {
        const fade = computeSolidTierFadeDistances({
            lodFactor: 1173,
            faceSize: 262144,
            maxDepth: 11,
            lodErrorThreshold: 512,
            shaderConfig: SHADER_CONFIG
        });
        // LOD5 tiles are 4096 m; threshold 512 quantizes to 514.
        const split = 4096 * 1173 / 514;
        const reach = Math.hypot(4096 * Math.SQRT1_2, 1000);
        expect(fade.splitDistance).toBeCloseTo(split, 6);
        expect(fade.end).toBeCloseTo(split - 0.5 * reach, 6);
        expect(fade.start).toBeCloseTo(fade.end - 0.3 * split, 6);
        expect(fade.end).toBeGreaterThan(7700);
        expect(fade.end).toBeLessThan(7900);
    });

    it('is off when the tier or its distance fade is disabled', () => {
        const base = { lodFactor: 1173, faceSize: 262144, maxDepth: 11, lodErrorThreshold: 512 };
        expect(computeSolidTierFadeDistances({ ...base, shaderConfig: { ...SHADER_CONFIG, solidColorTierEnabled: false } })).toBeNull();
        expect(computeSolidTierFadeDistances({ ...base, shaderConfig: { ...SHADER_CONFIG, solidColorTierDistanceFadeEnabled: false } })).toBeNull();
        expect(computeSolidTierFadeDistances({ ...base, lodFactor: undefined, shaderConfig: SHADER_CONFIG })).toBeNull();
    });
});

function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function facePoint(face, u, v) {
    const s = u * 2 - 1;
    const t = v * 2 - 1;
    const p = [
        [1, t, -s], [-1, t, s], [s, 1, -t], [s, -1, t], [s, t, 1], [-s, t, -1]
    ][face];
    const len = Math.hypot(p[0], p[1], p[2]);
    return [p[0] / len, p[1] / len, p[2] / len];
}

describe('tileNearestDistanceLowerBound', () => {
    it('never exceeds the true distance to any point of the tile at any height', () => {
        const rand = mulberry32(777);
        const R = 131072;
        const minRadius = R - 7500;
        const maxRadius = R + 9000;
        const origin = { x: 10, y: -20, z: 30 };
        let tight = 0;
        for (let trial = 0; trial < 300; trial++) {
            const face = Math.floor(rand() * 6);
            const depth = 3 + Math.floor(rand() * 9);
            const grid = 1 << depth;
            const tile = { face, depth, x: Math.floor(rand() * grid), y: Math.floor(rand() * grid) };
            // Camera above a point near the tile, 0-20 km up.
            const cu = Math.min(1, Math.max(0, (tile.x + 0.5 + (rand() - 0.5) * 12) / grid));
            const cv = Math.min(1, Math.max(0, (tile.y + 0.5 + (rand() - 0.5) * 12) / grid));
            const camDir = facePoint(face, cu, cv);
            const camRadius = R + rand() * 20000;
            const camera = {
                x: origin.x + camDir[0] * camRadius,
                y: origin.y + camDir[1] * camRadius,
                z: origin.z + camDir[2] * camRadius
            };
            const bound = tileNearestDistanceLowerBound(tile, camera, origin, minRadius);
            let nearest = Infinity;
            for (let s = 0; s < 400; s++) {
                const u = (tile.x + rand()) / grid;
                const v = (tile.y + rand()) / grid;
                const dir = facePoint(face, u, v);
                const r = minRadius + rand() * (maxRadius - minRadius);
                const d = Math.hypot(
                    origin.x + dir[0] * r - camera.x,
                    origin.y + dir[1] * r - camera.y,
                    origin.z + dir[2] * r - camera.z
                );
                nearest = Math.min(nearest, d);
            }
            expect(bound).toBeLessThanOrEqual(nearest + 1e-6);
            if (bound > 0.5 * nearest) tight++;
        }
        // Not trivially zero: most far-enough tiles get a useful bound.
        expect(tight).toBeGreaterThan(50);
    });

    it('is zero when the camera is above the tile', () => {
        const tile = { face: 4, depth: 6, x: 31, y: 17 };
        const dir = facePoint(4, 31.5 / 64, 17.5 / 64);
        const camera = { x: dir[0] * 135000, y: dir[1] * 135000, z: dir[2] * 135000 };
        expect(tileNearestDistanceLowerBound(tile, camera, { x: 0, y: 0, z: 0 }, 125000)).toBe(0);
    });
});
