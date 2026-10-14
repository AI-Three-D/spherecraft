import { describe, expect, it } from 'vitest';
import { SECTION_DEFAULTS, quantile, sectionMetrics, summarizeRiver } from './sectionMetrics.js';
import { buildStations, clipExtents, lod0Spacing } from './riverSections.js';

const DN = 0.25;
// A section from profiles of the offset n (m, + left): h as drawn, h0 natural.
function section(f, f0, { half = 120, wl, extentL = half, extentR = half, spacing = 1 }) {
    const count = 2 * Math.round(half / DN) + 1, mid = (count - 1) / 2;
    const h = new Float64Array(count), h0 = new Float64Array(count);
    for (let i = 0; i < count; i++) { const n = (i - mid) * DN; h[i] = f(n); h0[i] = f0(n); }
    return { h, h0, dn: DN, wl, extentL, extentR, spacing };
}

describe('sectionMetrics', () => {
    // Flat bed at 0 out to 5 m, walls rising 3 m over 1 m (slope 3), flat
    // natural ground at 3; water at 1.
    const trapezoid = (n) => { const a = Math.abs(n); return a <= 5 ? 0 : a >= 6 ? 3 : 3 * (a - 5); };

    it('measures a trapezoid channel with steep walls', () => {
        const m = sectionMetrics(section(trapezoid, () => 3, { wl: 1 }));
        expect(m.lineDry).toBe(false);
        expect(m.trench).toBeCloseTo(2, 6);
        expect(m.depthLine).toBeCloseTo(1, 6);
        expect(m.edgeL).toBeCloseTo(5 + 1 / 3, 6);
        expect(m.edgeR).toBeCloseTo(-(5 + 1 / 3), 6);
        for (const b of [m.left, m.right]) {
            // The wall tops out 0.67 m past the wet edge: 2 m above the water from there.
            expect(b.rise2).toBeCloseTo(2, 6);
            expect(b.rise10).toBeCloseTo(2, 6);
            expect(b.rise20).toBeCloseTo(2, 6);
            expect(b.steep10).toBeCloseTo(3, 6);
            expect(b.cls).toBe('high');
            // The ground equals the natural terrain from 6 m out.
            expect(b.blend).toBeCloseTo(6 - (5 + 1 / 3), 6);
            expect(b.blendOpen).toBe(false);
            expect(b.pocket).toBe(0);
        }
        // One wall per side: 1.25 m of samples steeper than 1 over 0.5 m, 3 m high.
        expect(m.ledges).toHaveLength(2);
        for (const l of m.ledges) {
            expect(l.width).toBeCloseTo(1.25, 6);
            expect(l.rise).toBeCloseTo(3, 6);
            expect(l.spacings).toBeCloseTo(1.25, 6);
        }
    });

    it('finds no bank where the ground grades up at 3 % into flat natural ground', () => {
        // Bed at -1 out to 4 m, then 3 % up to the natural ground at 2 (104 m out).
        const graded = (n) => Math.min(2, Math.abs(n) <= 4 ? -1 : -1 + 0.03 * (Math.abs(n) - 4));
        const m = sectionMetrics(section(graded, () => 2, { wl: 0 }));
        const edge = 4 + 1 / 0.03;
        expect(m.edgeL).toBeCloseTo(edge, 3);
        expect(m.left.rise10).toBeCloseTo(0.3, 6);
        expect(m.left.cls).toBe('none');
        expect(m.left.steep10).toBeCloseTo(0.03, 6);
        // Back within 0.1 m of the natural ground where the grade reaches 1.9 m.
        expect(m.left.blend).toBeCloseTo(4 + 2.9 / 0.03 - edge, 0);
        expect(m.left.blend).toBeGreaterThan(50);
        expect(m.ledges).toHaveLength(0);
    });

    it('sees the bank behind a toe and its shelf', () => {
        // A 1.5 m toe (slope 3) to a 1.5 m shelf at 0.5, then 3 m up at 45 degrees
        // to the natural ground at 3.5; water at 0.
        const f = (n) => { const a = Math.abs(n); return a < 4 ? -1 : a < 4.5 ? -1 + 3 * (a - 4) : a < 6 ? 0.5 : Math.min(3.5, 0.5 + (a - 6)); };
        const m = sectionMetrics(section(f, () => 3.5, { wl: 0 }));
        expect(m.left.rise2).toBeCloseTo(0.5 + 1 / 3, 6);
        expect(m.left.rise10).toBeCloseTo(3.5, 6);
        expect(m.left.cls).toBe('high');
        expect(m.left.blend).toBeCloseTo(9 - (4 + 1 / 3), 6);
    });

    it('measures a bank cut into a hillside', () => {
        // A 2:1 wall from a bed at -1 (3 m out) until it meets a 30 % natural slope.
        const h0 = (n) => 0.5 + 0.3 * Math.abs(n);
        const f = (n) => Math.min(h0(n), Math.abs(n) < 3 ? -1 : -1 + 2 * (Math.abs(n) - 3));
        const m = sectionMetrics(section(f, h0, { wl: 0 }));
        expect(m.edgeL).toBeCloseTo(3.5, 6);
        expect(m.left.blend).toBeCloseTo(1, 6);
        expect(m.left.rise2).toBeCloseTo(h0(5.5), 6);
        expect(m.left.rise10).toBeCloseTo(h0(13.5), 6);
    });

    it('measures teeth: sharp corners have them, smooth slopes do not', () => {
        // The trapezoid's corners turn by slope 3 within a sample: a grid 1.41 m apart misses them by ~1 m.
        const sharp = sectionMetrics(section(trapezoid, () => 3, { wl: 1 }));
        expect(sharp.teeth).toBeGreaterThan(0.5);
        // A smooth bank: 3 m up over 20 m along a cosine, below the natural ground.
        const smooth = (n) => { const a = Math.abs(n); return a < 5 ? 0 : a > 25 ? 3 : 1.5 - 1.5 * Math.cos(Math.PI * (a - 5) / 20); };
        const soft = sectionMetrics(section(smooth, () => 3.2, { wl: 1 }));
        expect(soft.teeth).toBeLessThan(0.03);
    });

    it('finds the water beside a dry line', () => {
        // A channel 6 m wide centred 10 m right of the line; water at -0.5.
        const off = (n) => (Math.abs(n + 10) < 3 ? -1 : 0);
        const m = sectionMetrics(section(off, () => 0, { wl: -0.5 }));
        expect(m.lineDry).toBe(true);
        expect(m.dry).toBe(false);
        expect(m.edgeL).toBeCloseTo(-7.125, 6);
        expect(m.edgeR).toBeCloseTo(-12.875, 6);
        expect(m.left.wet).toBeCloseTo(-7.125, 6);
        expect(m.right.wet).toBeCloseTo(12.875, 6);
    });

    it('marks a side open when the water reaches the end of its section', () => {
        const lake = (n) => (n > -3 ? -1 : 1);
        const m = sectionMetrics(section(lake, () => 1, { wl: 0, extentL: 30 }));
        expect(m.left.open).toBe(true);
        expect(m.edgeL).toBeNull();
        // The step lies between -3 (dry) and -2.75 (wet): the level crosses midway.
        expect(m.edgeR).toBeCloseTo(-2.875, 6);
        expect(m.dry).toBe(false);
    });

    it('stops a side at its valid extent', () => {
        // Ground below the water again 12 m out (another reach): clipped at 10 m it is not seen.
        const two = (n) => (Math.abs(n) < 3 || (n > 12 && n < 16) ? -1 : 1);
        const free = sectionMetrics(section(two, () => 1, { wl: 0 }));
        const clipped = sectionMetrics(section(two, () => 1, { wl: 0, extentL: 10 }));
        expect(free.left.pocket).toBeCloseTo(3.75, 6);   // samples 12.25..15.75
        expect(clipped.left.pocket).toBe(0);
    });
});

describe('summarizeRiver', () => {
    it('reports width variation, bank classes and their runs', () => {
        const rows = [];
        for (let q = 0; q < 100; q++) {
            const hw = q % 2 ? 15 : 5;
            // Steep walls for the first 50 stations, a graded bank after.
            const f = q < 50
                ? (n) => (Math.abs(n) <= hw ? 0 : Math.abs(n) >= hw + 1 ? 3 : 3 * (Math.abs(n) - hw))
                : (n) => (Math.abs(n) <= hw ? 0 : 0.02 * (Math.abs(n) - hw));
            const m = sectionMetrics(section(f, f, { wl: 0.5, half: 60 }));
            rows.push({ ...m, s: 4 * q, inLake: false, spacing: 1 });
        }
        rows.push({ s: 400, inLake: true });
        const sum = summarizeRiver(rows, { stepM: 4 });
        expect(sum.stations).toBe(101);
        expect(sum.measured).toBe(100);
        expect(sum.inLake).toBe(1);
        expect(sum.width.ratio9010).toBeGreaterThan(2);
        expect(sum.sides.left.classes.high).toBeCloseTo(0.5, 6);
        expect(sum.sides.left.classes.none).toBeCloseTo(0.5, 6);
        expect(sum.sides.left.classRunMedianM.high).toBe(200);
        expect(sum.sides.left.classRunMedianM.none).toBe(200);
        expect(sum.sidesDiffer).toBe(0);
        expect(sum.params).toBe(SECTION_DEFAULTS);
    });

    it('interpolates quantiles', () => {
        expect(quantile([3, 1, 2], 0.5)).toBe(2);
        expect(quantile([0, 10], 0.9)).toBeCloseTo(9, 9);
        expect(quantile([], 0.5)).toBeNull();
    });
});

describe('riverSections', () => {
    const R = 1e6;
    // Points in the tangent plane at (1, 0, 0): x along +y, y along +z (m).
    const record = (xy) => {
        const st = 20, P = new Float32Array(xy.length * st), arc = new Float64Array(xy.length);
        xy.forEach(([x, y], k) => {
            const l = Math.hypot(R, x, y);
            P.set([R / l, x / l, y / l], k * st);
            P[k * st + 4] = 5;
            if (k) arc[k] = arc[k - 1] + Math.hypot(x - xy[k - 1][0], y - xy[k - 1][1]);
        });
        return { points: P, stride: st, arc, levels: new Float64Array(xy.length).fill(10) };
    };

    it('clips sections halfway to the other reach of a hairpin', () => {
        // 200 m along +x, a half circle of radius 20 m to the left, 200 m back at y = 40.
        const xy = [];
        for (let x = 0; x <= 200; x += 8) xy.push([x, 0]);
        for (let a = 1; a < 16; a++) xy.push([200 + 20 * Math.sin(Math.PI * a / 16), 20 - 20 * Math.cos(Math.PI * a / 16)]);
        for (let x = 200; x >= 0; x -= 8) xy.push([x, 40]);
        const st = buildStations({ ...record(xy), stepM: 4 });
        const ext = clipExtents(st, R, 120);
        const q = 25;   // 100 m along the first reach
        expect(st.s[q]).toBe(100);
        expect(st.left[3 * q + 2]).toBeCloseTo(1, 6);   // left of +x is +y
        expect(ext.left[q]).toBeCloseTo(20.5, 1);
        expect(ext.right[q]).toBe(120);
        expect(st.wl[q]).toBe(10);
    });

    it('gives the LOD-0 vertex spacing of the cube mapping', () => {
        const R2 = 131000, depth = 11, seg = 128, base = R2 * 2 / (2 ** depth * seg);
        expect(lod0Spacing([1, 0, 0], R2, depth, seg)).toBeCloseTo(base, 9);
        const e = Math.SQRT1_2;
        expect(lod0Spacing([e, e, 0], R2, depth, seg)).toBeCloseTo(base * e, 9);
        expect(base).toBeCloseTo(1, 2);
    });
});
