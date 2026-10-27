import { describe, expect, it } from 'vitest';
import { buildRiverRibbons, RIBBON_POINT_FLOATS, RIBBON_SUB_ROWS, riverJointValue, riverWaterLevels } from './riverRibbon.js';

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
// Rows: a river point, then RIBBON_SUB_ROWS rows to the next one.
const ROW = RIBBON_SUB_ROWS + 1;
const rowOf = (k, cap = 1) => cap + k * ROW;
const rows = (pointCount, caps) => pointCount + RIBBON_SUB_ROWS * (pointCount - 1) + caps;
const legacy = rec => {
    const points = new Float32Array(rec.points.length / ST * 12);
    for (let k = 0; k < points.length / 12; k++) {
        points.set(rec.points.subarray(k * ST, k * ST + 12), k * 12);
        points[k * 12 + 3] = rec.points[k * ST + 16];
    }
    return { points, stride: 12 };
};

describe('river ribbons', () => {
    it('flat across at the water level, channel width plus the margin', () => {
        const { points, quads } = buildRiverRibbons({ ...base, rivers: [[7, straightRiver(10)]], camera: { x: 0, y: 0, z: R + 60 }, rangeM: 1000 });
        expect(points.length / RIBBON_POINT_FLOATS).toBe(rows(10, 2)); // 10 points and a cap at each end
        expect([...quads]).toEqual(Array.from({ length: rows(10, 2) - 1 }, (_, i) => i));
        const p = point(points, rowOf(4));                             // river point 4
        expect(p[3]).toBe(7);                                          // river id
        expect(p[7]).toBeCloseTo(52, 5);                               // level
        expect(Math.hypot(p[0], p[1], p[2])).toBeCloseTo(R + 52, 2);   // left edge on the level
        expect(Math.hypot(p[4], p[5], p[6])).toBeCloseTo(R + 52, 2);
        expect(Math.hypot(p[0] - p[4], p[1] - p[5], p[2] - p[6])).toBeCloseTo(2 * (10 + 2), 1);
    });

    it('only the stretches within range, one more point at each end', () => {
        const { points, quads } = buildRiverRibbons({ ...base, rivers: [[1, straightRiver(200)]], camera: { x: 0, y: 0, z: R + 60 }, rangeM: 160 });
        const n = points.length / RIBBON_POINT_FLOATS, pointCount = (n - 1 + RIBBON_SUB_ROWS) / ROW;   // a cap at the start (point 0 in range)
        expect(Number.isInteger(pointCount)).toBe(true);
        expect(pointCount).toBeGreaterThan(9);
        expect(pointCount).toBeLessThan(15);
        expect(quads.length).toBe(n - 1);
    });

    it('caps run on past the river\'s ends by the half-width (round end of the water)', () => {
        const { points } = buildRiverRibbons({ ...base, rivers: [[1, straightRiver(4)]], camera: { x: 0, y: 0, z: R + 60 }, rangeM: 1000 });
        const mid = (i) => { const p = point(points, i); return [(p[0] + p[4]) / 2, (p[1] + p[5]) / 2, (p[2] + p[6]) / 2]; };
        const gap = (i, j) => Math.hypot(...mid(i).map((v, c) => v - mid(j)[c])) * R / (R + 52);
        expect(points.length / RIBBON_POINT_FLOATS).toBe(rows(4, 2));
        expect(gap(0, 1)).toBeCloseTo(12, 1);                          // before point 0
        expect(gap(rowOf(3), rowOf(3) + 1)).toBeCloseTo(12, 1);        // after the last point
        expect(mid(0)[0]).toBeLessThan(mid(1)[0]);                      // behind the start, along -x
    });

    it('does not extend a source cap backwards across the lake shore', () => {
        const rec = straightRiver(10);
        rec.points[9] = -1;
        const { points } = buildRiverRibbons({ ...base, rivers: [[1, rec]], camera: { x: 0, y: 0, z: R + 60 }, rangeM: 1000 });
        expect(points.length / RIBBON_POINT_FLOATS).toBe(rows(10, 1));
        const p = point(points, 0);
        expect((p[0] + p[4]) / 2).toBeCloseTo(0, 2);
    });

    it('legacy design levels meet the source lake without an upstream gradient', () => {
        // A design above its source lake must be clamped, never eased uphill.
        const lakeAt = (d) => (Math.asin(d[0]) * R < 16 * 4 + 1 ? { level: 50 } : null);
        const rec = straightRiver(20);
        for (let k = 0; k <= 4; k++) rec.points[k * ST + 9] = -1;
        const levels = riverWaterLevels(legacy(rec), arcOf(rec), lakeAt);
        const level = (k) => levels[k];
        expect(level(2)).toBeCloseTo(50, 5);
        expect(level(4)).toBeCloseTo(50, 5);
        expect(level(5)).toBe(50);
        for (let k = 1; k < 20; k++) expect(level(k)).toBeLessThanOrEqual(level(k - 1));
    });

    it('legacy lake easing preserves downstream descent and both lake levels', () => {
        const rec = straightRiver(40, k => 60 - k * 0.25);
        // The path passes near the source again mid-reach, then enters the
        // destination. Nearest-lake easing used to create a bump here.
        const lakeAt = d => {
            const x = Math.asin(d[0]) * R;
            if (x < 40 || (x > 170 && x < 190)) return { level: 60 };
            if (x > 570) return { level: 50 };
            return null;
        };
        for (let k = 0; k < 40; k++) {
            if (lakeAt(Array.from(rec.points.slice(k * ST, k * ST + 3)))) rec.points[k * ST + 9] = -1;
        }
        const levels = riverWaterLevels(legacy(rec), arcOf(rec), lakeAt);
        expect(levels[0]).toBe(60);
        expect(levels[39]).toBe(50);
        for (let k = 1; k < levels.length; k++) expect(levels[k]).toBeLessThanOrEqual(levels[k - 1]);
    });

    it('keeps the solved outlet surface below the bank-full edge on steep rivers', () => {
        const rec = straightRiver(20, k => 60 - 0.6 * k);
        rec.points[9] = -1;
        const levels = riverWaterLevels(rec, arcOf(rec), d => Math.asin(d[0]) * R < 1 ? { level: 60 } : null);
        for (let k = 0; k < 20; k++) expect(levels[k]).toBeCloseTo(rec.points[k * ST + 16], 6);
    });

    it('does not lift a solved reach when a coarse mask overlaps a higher neighbouring lake', () => {
        const rec = straightRiver(30, k => 548 - k * 0.5);
        for (let k = 8; k < 26; k++) rec.points[k * ST + 9] = -1;
        const levels = riverWaterLevels(rec, arcOf(rec), () => ({ level: 543.2 }));
        for (let k = 0; k < levels.length; k++) expect(levels[k]).toBe(rec.points[k * ST + 16]);
        const mesh = buildRiverRibbons({ ...base, lakeAt: () => ({ level: 543.2 }),
            rivers: [[1, rec]], camera: { x: 0, y: 0, z: R + 550 }, rangeM: 1000 });
        for (let k = 0; k < levels.length; k++) expect(point(mesh.points, rowOf(k))[7]).toBe(levels[k]);
    });

    it('rows between points follow the joints\' window average: slopes change monotonically', () => {
        // Level falling 0.5 m, then 3 m per 16 m segment: a kink at point 5.
        const lv = Array.from({ length: 10 }, (_, k) => 100 - (k <= 5 ? 0.5 * k : 2.5 + 3 * (k - 5)));
        const arc = Array.from({ length: 10 }, (_, k) => 16 * k);
        const at = (s) => { const k = Math.min(8, Math.floor(s / 16)); return riverJointValue(lv, arc, k, (s - 16 * k) / 16); };
        const m1 = -0.5 / 16, m2 = -3 / 16, b = 8;
        expect(at(16 * 2.5)).toBeCloseTo((lv[2] + lv[3]) / 2, 9);       // straight mid-segment
        expect(at(16 * 5)).toBeCloseTo(lv[5] + (m2 - m1) * b / 4, 9);   // the corner cut at the joint
        const slope = (s) => (at(s + 0.001) - at(s - 0.001)) / 0.002;
        expect(slope(16 * 5 - 0.01)).toBeCloseTo(slope(16 * 5 + 0.01), 3);   // no kink at the joint
        expect(slope(16 * 5)).toBeCloseTo((m1 + m2) / 2, 3);
        // From one mid-segment to the next the slope only falls (a curve
        // through the points overshot: stairs on steep beds).
        for (let s = 16 * 4.5 + 0.25; s < 16 * 5.5; s += 0.25) expect(slope(s)).toBeLessThanOrEqual(slope(s - 0.25) + 1e-6);
        const mesh = buildRiverRibbons({ ...base, rivers: [[1, straightRiver(10, k => lv[k])]], camera: { x: 0, y: 0, z: R + 60 }, rangeM: 1000 });
        const arc16 = arcOf(straightRiver(10));
        expect(point(mesh.points, rowOf(4) + 2)[7]).toBeCloseTo(riverJointValue(lv, arc16, 4, 0.5), 3);
        expect(point(mesh.points, rowOf(5))[7]).toBeCloseTo(riverJointValue(lv, arc16, 5, 0), 3);
    });

    it('a tight bend keeps the inner edge inside the bend (no fold)', () => {
        // A 90 degree turn to the left over two 16 m segments: radius ~20 m < width 12 + 12.
        const P = new Float32Array(3 * ST);
        const pts = [[0, 0], [16, 0], [16, 16]];
        pts.forEach(([x, y], k) => { const d = [x / R, y / R, 1], l = Math.hypot(...d); P.set([d[0] / l, d[1] / l, d[2] / l, 53, 10, 3], k * ST); P[k * ST + 16] = 52; });
        const { points } = buildRiverRibbons({ ...base, marginM: 2, rivers: [[1, { points: P, stride: ST }]], camera: { x: 0, y: 0, z: R + 60 }, rangeM: 1000 });
        const p = point(points, rowOf(1));                             // river point 1 (after the start cap)
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
