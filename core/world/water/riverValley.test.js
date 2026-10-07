import { describe, expect, it } from 'vitest';
import { bakeValleyPages, fromHalfBits, RIVER_VALLEY_DEFAULTS, toHalfBits, valleyIncisionPages, valleyLayout, valleyPageCells, valleyPagesNear } from './riverValley.js';
import { planeToDir, tangentBasis } from '../hydrology/lakeRefine.js';

const R = 131072, opts = { ...RIVER_VALLEY_DEFAULTS };
function river() {
    const frame = { c: [1, 0, 0], e1: [0, 0, -1], e2: [0, 1, 0], x0: -2048, y0: -2048, spacing: 16, nx: 256, ny: 256 };
    const dirs = [], s = [];
    for (let k = 0; k <= 200; k++) { dirs.push(planeToDir(-2000 + k * 20, 0, frame, R)); s.push(k * 20); }
    const cells = [], cuts = [];
    for (let j = 110; j < 146; j++) for (let i = 32; i < 224; i++) { cells.push(j * frame.nx + i); cuts.push(8 + 2 * Math.sin(i / 20)); }
    const hill = { id: 7, c: planeToDir(1000, 450, frame, R), e1: frame.e1, e2: frame.e2, angle: 0, a: 900, b: 700, height: 90, erosion: 0.4 };
    return { dirs, s, landscape: { frame, cells: Uint32Array.from(cells), cuts: Float32Array.from(cuts), erosionCuts: Float32Array.from(cuts, v => v * 0.5),
        bankReferences: Float32Array.from(cuts, v => 12345 - v), bankClearances: Float32Array.from(cuts, v => 20 - v), hills: [hill] } };
}
const unpack = u => [fromHalfBits(u & 0xffff), fromHalfBits(u >>> 16)];
const asF32 = u => new Float32Array(Uint32Array.of(u).buffer)[0];
const texel = (t, o) => ({ cut: asF32(t[o]), hill: unpack(t[o + 1])[0], erodedHill: unpack(t[o + 1])[1], erodedCut: unpack(t[o + 2])[0],
    lake: t[o + 2] >>> 31, reference: asF32(t[o + 3]), clearance: fromHalfBits((t[o + 2] >>> 16) & 0x7fff) });

describe('river landscape pages', () => {
    it('half floats round-trip within their precision', () => {
        for (const x of [0, 1, -1, 0.1, 37.25, 1999.9, -120.3, 65504]) expect(Math.abs(fromHalfBits(toHalfBits(x)) - x)).toBeLessThanOrEqual(Math.max(1e-7, Math.abs(x) / 1024));
    });
    it('preserves independent hills and cut-only excavation in separate fields', () => {
        const rv = river(), ids = [...valleyPagesNear(rv.dirs, rv.s, R, opts)];
        const { texels } = bakeValleyPages(ids, [rv], { R }, opts);
        expect(texels.length).toBe(ids.length * valleyLayout(opts).TEX * 4);
        let hill = 0, cut = 0, flat = 0;
        for (let o = 0; o < texels.length; o += 4) {
            const v = texel(texels, o);
            expect(v.cut).toBeGreaterThanOrEqual(0); expect(v.hill).toBeGreaterThanOrEqual(0);
            expect(v.erodedCut).toBeCloseTo(v.cut * 0.5, 2);
            if (v.cut > 0) {
                // Even at high altitude, the bank's original elevation and
                // small clearance survive packing without metre-sized steps.
                expect(v.reference).toBeGreaterThan(12334.99); expect(v.reference).toBeLessThan(12339.01);
                expect(v.reference + v.cut * 0.1).toBeLessThan(12345);
                expect(v.clearance).toBeCloseTo(v.reference - 12325, 1);
            }
            if (v.hill > 10) hill++; if (v.cut > 5) cut++; if (v.hill === 0 && v.cut === 0) flat++;
        }
        expect(hill).toBeGreaterThan(10); expect(cut).toBeGreaterThan(10); expect(flat).toBeGreaterThan(100);
        // A record without baked landforms must never resurrect the old fill corridor.
        expect(bakeValleyPages(ids, [{ dirs: rv.dirs, s: rv.s }], { R }, opts).texels.every(v => v === 0)).toBe(true);
    });
    it('page aprons agree bit-for-bit, including hill and erosion fields', () => {
        const rv = river(), ids = [...valleyPagesNear(rv.dirs, rv.s, R, opts)].sort((a, b) => a - b);
        const { texels } = bakeValleyPages(ids, [rv], { R }, opts), L = valleyLayout(opts), at = new Map();
        let checked = 0;
        ids.forEach((pid, slot) => {
            const face = Math.floor(pid / (L.PE * L.PE)), pj = Math.floor((pid % (L.PE * L.PE)) / L.PE), pi = pid % L.PE;
            for (let j = 0; j < L.ST; j++) for (let i = 0; i < L.ST; i++) {
                const key = `${face}:${pi * L.P - 2 + i}:${pj * L.P - 2 + j}`, o = (slot * L.TEX + j * L.ST + i) * 4;
                const words = Array.from(texels.subarray(o, o + 4));
                if (at.has(key)) { checked++; expect(words).toEqual(at.get(key)); } else at.set(key, words);
            }
        });
        expect(checked).toBeGreaterThan(100);
    });
    it('protects existing lake terrain from both hill uplift and excavation', () => {
        const rv = river(), ids = [...valleyPagesNear(rv.dirs, rv.s, R, opts)];
        const { texels } = bakeValleyPages(ids, [rv], { R, lakeLevelAt: d => d[1] > 0 ? 520 : NaN }, opts);
        let wet = 0;
        for (let o = 0; o < texels.length; o += 4) { const v = texel(texels, o); if (v.lake) { wet++; expect(v.cut + v.hill + v.erodedHill + v.erodedCut).toBe(0); } }
        expect(wet).toBeGreaterThan(100);
    });
    it('page cells cover the page with a margin', () => {
        const L = valleyLayout(opts), N = 512, pid = 10 * L.PE + 20, cells = valleyPageCells(pid, N, opts), per = N / L.PE;
        expect(cells).toContain(10 * per * N + 20 * per); expect(cells.length).toBeGreaterThanOrEqual(per * per);
    });
    it('selects excavation pages without dropping interpolation support, including cube seams', () => {
        for (const c of [[1, 0, 0], [Math.SQRT1_2, 0, Math.SQRT1_2]]) {
            const rv = river();
            Object.assign(rv.landscape.frame, { c, ...tangentBasis(c) }); rv.landscape.hills = [];
            rv.dirs = Array.from(rv.s, s => planeToDir(s - 2000, 0, rv.landscape.frame, R));
            const wide = [...valleyPagesNear(rv.dirs, rv.s, R, { ...opts, dBig: 2000 })];
            const selected = valleyIncisionPages(rv.landscape, R, opts);
            // Force the reference bake to evaluate every broad page. Otherwise
            // its own spatial culling would make this a circular coverage test.
            rv.pageSupport = new Map([[`${opts.texels}:${opts.page}`, new Set(wide)]]);
            const { texels } = bakeValleyPages(wide, [rv], { R }, opts), { TEX } = valleyLayout(opts);
            expect(selected.size).toBeLessThan(wide.length);
            for (let slot = 0; slot < wide.length; slot++) {
                let touched = false;
                for (let k = 0; k < TEX; k++) touched ||= texels[(slot * TEX + k) * 4] !== 0;
                if (touched) expect(selected.has(wide[slot])).toBe(true);
            }
        }
    });
});
