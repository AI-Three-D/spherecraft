import { describe, expect, it } from 'vitest';
import { bakeRiverIncision, riverIncisionSampler } from './riverLandscape.js';
import { planeToDir } from './lakeRefine.js';

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

    it('cuts a steep stream to its own channel, not to a slope from the lowest point', () => {
        // 60 % slope along the river; the water 0.5 m under the ground, 2 m deep.
        const f = fixture(), ground = (x) => 100 - 0.6 * (x + 100);
        for (let j = 0; j < frame.ny; j++) for (let i = 0; i < frame.nx; i++) f.heights[j * frame.nx + i] = ground(frame.x0 + (i + 0.5) * frame.spacing);
        for (let k = 0; k < 21; k++) {
            const x = -80 + 8 * k, o = k * stride;
            f.points[o + 3] = f.points[o + 16] = ground(x) - 0.5;
            f.points[o + 5] = 2;
        }
        const out = bakeRiverIncision(f), at = riverIncisionSampler(out, R);
        // Every channel centre is cut by about its own depth (2.5 m), the
        // upstream end included (the slope-from-the-lowest-point order cut it
        // ~38 m; the level of a sample a cell downstream, up to 2.4 m more).
        for (let x = -76; x <= 76; x += 8) expect(at(planeToDir(x, 0, frame, R))).toBeLessThan(3.2);
        // Banks beside the channel stay above the channel's floor there.
        for (let x = -60; x <= 60; x += 20) expect(ground(x) - at(planeToDir(x, 16, frame, R))).toBeGreaterThan(ground(x) - 2.6);
    });

    it('leaves channels narrower than a cell to the carve', () => {
        const f = fixture();
        for (let k = 0; k < 21; k++) f.points[k * stride + 4] = 1.5;   // 3 m wide on 4 m cells
        expect(bakeRiverIncision(f).cells.length).toBe(0);
    });

    it('preserves the sparse field through cache serialization', () => {
        const out = bakeRiverIncision(fixture()), restored = structuredClone(out);
        const a = riverIncisionSampler(out, R), b = riverIncisionSampler(restored, R);
        for (let x = -70; x < 70; x += 7) {
            const dir = planeToDir(x, 10, frame, R);
            expect(b(dir)).toBe(a(dir));
        }
    });

});
