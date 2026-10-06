import { describe, expect, it } from 'vitest';
import { buildRiverRibbons, RIBBON_POINT_FLOATS, riverWaterLevels } from './riverRibbon.js';

const R = 100000;
const ST = 20;
// A river along a great circle from (0, 0, 1) toward +x, a point every 16 m:
// half-width 10 m, water level wl(k).
function straightRiver(n, wl = () => 52) {
    const P = new Float32Array(n * ST);
    for (let k = 0; k < n; k++) {
        const t = (16 * k) / R;
        P.set([Math.sin(t), 0, Math.cos(t), 53, 10, 3], k * ST);
        P[k * ST + 16] = wl(k);
    }
    return { points: P, stride: ST };
}
const arcOf = (rec) => {
    const P = rec.points, n = P.length / ST, arc = new Float64Array(n);
    for (let k = 1; k < n; k++) arc[k] = arc[k - 1] + Math.hypot(P[k * ST] - P[(k - 1) * ST], P[k * ST + 1] - P[(k - 1) * ST + 1], P[k * ST + 2] - P[(k - 1) * ST + 2]) * R;
    return arc;
};
const flat = { widthVar: 0, wobble: 0, bankVar: 0 };
const base = { arcOf, R, origin: { x: 0, y: 0, z: 0 }, shape: flat, lakeAt: () => null };
const point = (pts, i) => pts.slice(i * RIBBON_POINT_FLOATS, (i + 1) * RIBBON_POINT_FLOATS);

describe('river ribbons', () => {
    it('flat across at the water level, channel width plus the margin', () => {
        const { points, quads } = buildRiverRibbons({ ...base, rivers: [[7, straightRiver(10)]], camera: { x: 0, y: 0, z: R + 60 }, rangeM: 1000 });
        expect(points.length / RIBBON_POINT_FLOATS).toBe(12);          // 10 points and a cap at each end
        expect([...quads]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        const p = point(points, 5);                                    // river point 4
        expect(p[3]).toBe(7);                                          // river id
        expect(p[7]).toBeCloseTo(52, 5);                               // level
        expect(Math.hypot(p[0], p[1], p[2])).toBeCloseTo(R + 52, 2);   // left edge on the level
        expect(Math.hypot(p[4], p[5], p[6])).toBeCloseTo(R + 52, 2);
        expect(Math.hypot(p[0] - p[4], p[1] - p[5], p[2] - p[6])).toBeCloseTo(2 * (10 + 2), 1);
    });

    it('only the stretches within range, one more point at each end', () => {
        const { points, quads } = buildRiverRibbons({ ...base, rivers: [[1, straightRiver(200)]], camera: { x: 0, y: 0, z: R + 60 }, rangeM: 160 });
        const n = points.length / RIBBON_POINT_FLOATS;
        expect(n).toBeGreaterThan(9);
        expect(n).toBeLessThan(15);
        expect(quads.length).toBe(n - 1);
    });

    it('caps run on past the river\'s ends by the half-width (round end of the water)', () => {
        const { points } = buildRiverRibbons({ ...base, rivers: [[1, straightRiver(4)]], camera: { x: 0, y: 0, z: R + 60 }, rangeM: 1000 });
        const mid = (i) => { const p = point(points, i); return [(p[0] + p[4]) / 2, (p[1] + p[5]) / 2, (p[2] + p[6]) / 2]; };
        const gap = (i, j) => Math.hypot(...mid(i).map((v, c) => v - mid(j)[c])) * R / (R + 52);
        expect(points.length / RIBBON_POINT_FLOATS).toBe(6);
        expect(gap(0, 1)).toBeCloseTo(12, 1);                          // before point 0
        expect(gap(4, 5)).toBeCloseTo(12, 1);                          // after the last point
        expect(mid(0)[0]).toBeLessThan(mid(1)[0]);                      // behind the start, along -x
    });

    it('the level eases to the lake where the river enters it', () => {
        // Points 0..4 lie in the lake's mask (level 50); the river's own level is 52.
        const lakeAt = (d) => (Math.asin(d[0]) * R < 16 * 4 + 1 ? { level: 50 } : null);
        const rec = straightRiver(20);
        const levels = riverWaterLevels(rec, arcOf(rec), lakeAt);
        const level = (k) => levels[k];
        expect(level(2)).toBeCloseTo(50, 5);
        expect(level(4)).toBeCloseTo(50, 5);
        expect(level(5)).toBeGreaterThan(50);
        expect(level(5)).toBeLessThan(52);
        expect(level(5 + 80 / 16)).toBeCloseTo(52, 5);
        for (let k = 1; k < 20; k++) expect(level(k)).toBeGreaterThanOrEqual(level(k - 1) - 1e-6);
    });

    it('a tight bend keeps the inner edge inside the bend (no fold)', () => {
        // A 90 degree turn to the left over two 16 m segments: radius ~20 m < width 12 + 12.
        const P = new Float32Array(3 * ST);
        const pts = [[0, 0], [16, 0], [16, 16]];
        pts.forEach(([x, y], k) => { const d = [x / R, y / R, 1], l = Math.hypot(...d); P.set([d[0] / l, d[1] / l, d[2] / l, 53, 10, 3], k * ST); P[k * ST + 16] = 52; });
        const { points } = buildRiverRibbons({ ...base, marginM: 2, rivers: [[1, { points: P, stride: ST }]], camera: { x: 0, y: 0, z: R + 60 }, rangeM: 1000 });
        const p = point(points, 2);                                    // river point 1 (after the start cap)
        const centre = [16 / R * (R + 52), 0, R + 52];
        // Widths are metres at radius R (as the terrain's waterRiverPoint measures them).
        const atR = R / (R + 52);
        const leftW = Math.hypot(p[0] - centre[0], p[1] - centre[1]) * atR;
        const rightW = Math.hypot(p[4] - centre[0], p[5] - centre[1]) * atR;
        const radius = 16 / (Math.PI / 2);
        expect(leftW).toBeLessThanOrEqual(0.8 * radius + 1e-3);       // inner (left) side limited
        expect(rightW).toBeCloseTo(12, 1);                            // outer side full width
    });
});
