import { describe, expect, it } from 'vitest';
import { bakeValleyPages, RIVER_VALLEY_DEFAULTS, valleyIncisionPages, valleyLayout, valleyPageCells, valleyPagesNear } from './riverValley.js';
import { planeToDir, tangentBasis } from '../hydrology/lakeRefine.js';

const R = 131072, opts = { ...RIVER_VALLEY_DEFAULTS };
function river() {
    const frame = { c: [1, 0, 0], e1: [0, 0, -1], e2: [0, 1, 0], x0: -2048, y0: -2048, spacing: 16, nx: 256, ny: 256 };
    const dirs = [], s = [];
    for (let k = 0; k <= 200; k++) { dirs.push(planeToDir(-2000 + k * 20, 0, frame, R)); s.push(k * 20); }
    const cells = [], cuts = [];
    for (let j = 110; j < 146; j++) for (let i = 32; i < 224; i++) { cells.push(j * frame.nx + i); cuts.push(8 + 2 * Math.sin(i / 20)); }
    return { dirs, s, landscape: { frame, cells: Uint32Array.from(cells), cuts: Float32Array.from(cuts) } };
}
const asF32 = u => new Float32Array(Uint32Array.of(u).buffer)[0];
const texel = (t, o) => ({ cut: asF32(t[o]), lake: t[o + 2] >>> 31 });

describe('river landscape pages', () => {
    it('preserves cut-only excavation and leaves unused terrain fields zero', () => {
        const rv = river(), ids = [...valleyPagesNear(rv.dirs, rv.s, R, opts)];
        const { texels } = bakeValleyPages(ids, [rv], { R }, opts);
        expect(texels.length).toBe(ids.length * valleyLayout(opts).TEX * 4);
        let cut = 0, flat = 0;
        for (let o = 0; o < texels.length; o += 4) {
            const v = texel(texels, o);
            expect(v.cut).toBeGreaterThanOrEqual(0);
            expect(v.cut).toBeLessThanOrEqual(10);
            expect(texels[o + 1]).toBe(0); expect(texels[o + 3]).toBe(0);
            if (v.cut > 5) cut++; if (v.cut === 0) flat++;
        }
        expect(cut).toBeGreaterThan(10); expect(flat).toBeGreaterThan(100);
        // A record without bank cuts must never resurrect a fill corridor.
        expect(bakeValleyPages(ids, [{ dirs: rv.dirs, s: rv.s }], { R }, opts).texels.every(v => v === 0)).toBe(true);
    });
    it('page aprons agree bit-for-bit', () => {
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
    it('protects existing lake terrain from bank excavation', () => {
        const rv = river(), ids = [...valleyPagesNear(rv.dirs, rv.s, R, opts)];
        const { texels } = bakeValleyPages(ids, [rv], { R, lakeLevelAt: d => d[1] > 0 ? 520 : NaN }, opts);
        let wet = 0;
        for (let o = 0; o < texels.length; o += 4) { const v = texel(texels, o); if (v.lake) { wet++; expect(v.cut).toBe(0); } }
        expect(wet).toBeGreaterThan(100);
    });
    it('page cells cover the page with a margin', () => {
        const L = valleyLayout(opts), N = 512, pid = 10 * L.PE + 20, cells = valleyPageCells(pid, N, opts), per = N / L.PE;
        expect(cells).toContain(10 * per * N + 20 * per); expect(cells.length).toBeGreaterThanOrEqual(per * per);
    });
    it('selects excavation pages without dropping interpolation support, including cube seams', () => {
        for (const c of [[1, 0, 0], [Math.SQRT1_2, 0, Math.SQRT1_2]]) {
            const rv = river();
            Object.assign(rv.landscape.frame, { c, ...tangentBasis(c) });
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
