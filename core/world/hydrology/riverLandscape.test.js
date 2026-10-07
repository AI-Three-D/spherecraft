import { describe, expect, it } from 'vitest';
import { bakeRiverIncision, riverHills, riverHillAt, riverHillPlaneSampler, riverIncisionSampler } from './riverLandscape.js';
import { dirToPlane, planeToDir } from './lakeRefine.js';

const R = 131072, stride = 20;
const frame = { c: [0, 0, 1], e1: [1, 0, 0], e2: [0, 1, 0], x0: -100, y0: -100, nx: 51, ny: 51, spacing: 4 };
const shape = { waterFrac: 0.75, widthVar: 0, wobble: 0, bankVar: 0 };
function fixture() {
    const heights = new Float32Array(frame.nx * frame.ny).fill(50);
    const points = new Float32Array(21 * stride), arc = new Float64Array(21);
    for (let k = 0; k < 21; k++) {
        const x = -80 + 8 * k, dir = planeToDir(x, 0, frame, R);
        points.set([...dir, 49 - k * 0.03, 12, 2, 1, 10, 50, 0, 0, 0, 50, 30, 0, 0.2, 49 - k * 0.03, 2], k * stride);
        arc[k] = k * 8;
    }
    return { frame, heights, points, stride, arc, R, river: 17, shape };
}

describe('river landscape bake', () => {
    it('excavates banks without raising the surrounding flat terrain', () => {
        const f = fixture(), out = bakeRiverIncision(f), at = riverIncisionSampler(out, R);
        expect(out.cells.length).toBeGreaterThan(0);
        expect(out.cells.length).toBeLessThan(f.heights.length / 2);
        for (const v of out.cuts) expect(v).toBeGreaterThanOrEqual(0);
        for (let i = 0; i < out.cells.length; i++) {
            expect(out.bankReferences[i] + out.cuts[i]).toBeCloseTo(50, 4);
            expect(out.bankClearances[i]).toBeGreaterThanOrEqual(0);
        }
        expect(at(planeToDir(0, 0, frame, R))).toBeGreaterThan(2);
        expect(at(planeToDir(0, 90, frame, R))).toBe(0);
        expect(f.heights.every(v => v === 50)).toBe(true);
    });

    it('leaves an existing low depression untouched instead of damming it', () => {
        const f = fixture(), k = 25 * frame.nx + 25;
        f.heights[k] = 40;
        const out = bakeRiverIncision(f);
        expect([...out.cells]).not.toContain(k);
        expect(f.heights[k]).toBe(40);
    });

    it('independent hills have finite footprints and some have no added erosion', () => {
        const dirs = Array.from({ length: 1501 }, (_, k) => planeToDir(k * 20, 0, frame, R));
        const hills = riverHills(dirs, R, 17, { hillDensity: 0.6 });
        expect(hills.length).toBeGreaterThan(5);
        expect(new Set(hills.map(h => h.id)).size).toBe(hills.length);
        expect(hills.some(h => h.erosion === 0)).toBe(true);
        expect(Math.max(...hills.map(h => h.a)) / Math.min(...hills.map(h => h.a))).toBeGreaterThan(3);
        for (const h of hills) {
            expect(riverHillAt(h.c, h, R)).toBeGreaterThan(0);
            const d = h.c.map((v, i) => v + h.e1[i] * 3 * h.a / R), len = Math.hypot(...d);
            expect(riverHillAt(d.map(v => v / len), h, R)).toBe(0);
        }
        expect(riverHills(dirs, R, 17, { hillDensity: 0 })).toEqual([]);
    });

    it('preserves the sparse field through cache serialization', () => {
        const out = bakeRiverIncision(fixture()), restored = structuredClone(out);
        const a = riverIncisionSampler(out, R), b = riverIncisionSampler(restored, R);
        for (let x = -70; x < 70; x += 7) {
            const dir = planeToDir(x, 10, frame, R);
            expect(b(dir)).toBe(a(dir)); expect(b(dir, true)).toBe(a(dir, true));
        }
    });

    it('projects hills once without changing their spherical footprints or heights', () => {
        const dirs = Array.from({ length: 1001 }, (_, k) => planeToDir(k * 20, 0, frame, R));
        for (const hill of riverHills(dirs, R, 17)) {
            const sample = riverHillPlaneSampler(hill, frame, R), [cx, cy] = dirToPlane(hill.c, frame, R);
            for (const x of [-1.5, -0.5, 0, 0.5, 1.5]) for (const y of [-1.5, -0.5, 0, 0.5, 1.5]) {
                const px = cx + x * hill.a, py = cy + y * hill.b;
                expect(sample(px, py)).toBeCloseTo(riverHillAt(planeToDir(px, py, frame, R), hill, R), 7);
            }
        }
    });

    it('gives most river sides noticeable relief while leaving natural gaps', () => {
        const dirs = Array.from({ length: 1501 }, (_, k) => planeToDir(k * 20, 0, frame, R));
        for (const river of [12, 17, 25, 28]) {
            const hills = riverHills(dirs, R, river);
            let raised = 0, samples = 0;
            for (let x = 0; x < 30000; x += 100) for (const y of [-100, 100]) {
                const d = planeToDir(x, y, frame, R);
                raised += hills.reduce((sum, h) => sum + riverHillAt(d, h, R), 0) > 5;
                samples++;
            }
            expect(raised / samples).toBeGreaterThan(0.55);
            expect(raised / samples).toBeLessThan(0.8);
        }
    });

    it('keeps hill footprints off an existing lake rather than clipping them into a shore wall', () => {
        const dirs = Array.from({ length: 1001 }, (_, k) => planeToDir(k * 20, 0, frame, R));
        const lakeAt = d => d[1] > 500 / R ? 50 : NaN;
        const hills = riverHills(dirs, R, 17, {}, lakeAt);
        expect(hills.length).toBeGreaterThan(0);
        for (let x = 0; x < 20000; x += 100) for (let y = 600; y < 2000; y += 100) {
            const d = planeToDir(x, y, frame, R);
            expect(hills.reduce((sum, h) => sum + riverHillAt(d, h, R), 0)).toBe(0);
        }
    });
});
