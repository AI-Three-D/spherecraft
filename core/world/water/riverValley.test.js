import { describe, expect, it } from 'vitest';
import { bakeValleyPages, fromHalfBits, RIVER_VALLEY_DEFAULTS, toHalfBits, valleyLayout, valleyPageCells, valleyPagesNear } from './riverValley.js';
import { faceUVToDir } from '../hydrology/waterGraph.js';

const R = 131072;
const opts = { ...RIVER_VALLEY_DEFAULTS };

// A straight river across face 0 near u = 0.5 (a page boundary at PE / 2).
function river() {
    const dirs = [], s = [], F = [], wc = [], wFill = [], sWall = [];
    for (let k = 0; k <= 200; k++) {
        dirs.push(faceUVToDir(0, 0.47 + k * 0.0003, 0.5));
        s.push(k ? s[k - 1] + Math.acos(Math.min(1, dirs[k][0] * dirs[k - 1][0] + dirs[k][1] * dirs[k - 1][1] + dirs[k][2] * dirs[k - 1][2])) * R : 0);
        F.push(500 - k * 0.1); wc.push(40); wFill.push(1); sWall.push(0.2);
    }
    return { dirs, s, F, wc, wFill, sWall };
}
const unpack = (u) => [fromHalfBits(u & 0xffff), fromHalfBits(u >>> 16)];
const asF32 = (u) => new Float32Array(Uint32Array.of(u).buffer)[0];
// Texel: F (f32), (d, wc), (wFill, sWall), (wRim, rim - F).
const texel = (texels, w) => {
    const [d, wc] = unpack(texels[w + 1]), [fill, wall] = unpack(texels[w + 2]), [wRim, rimRel] = unpack(texels[w + 3]);
    const F = asF32(texels[w]);
    return { F, d, wc, fill, wall, wRim, rim: F + rimRel };
};

describe('river valley field', () => {
    it('half floats round-trip within their precision', () => {
        for (const x of [0, 1, -1, 0.1, 37.25, 1999.9, -120.3, 65504]) {
            const y = fromHalfBits(toHalfBits(x));
            expect(Math.abs(y - x)).toBeLessThanOrEqual(Math.max(1e-7, Math.abs(x) / 1024));
        }
    });

    it('bakes pages near the river: distance, floor relative to the page base, fill and wall', () => {
        const rv = river();
        const ids = [...valleyPagesNear(rv.dirs, rv.s, R, opts)].sort((a, b) => a - b);
        expect(ids.length).toBeGreaterThan(0);
        const { texels } = bakeValleyPages(ids, [rv], { R }, opts);
        const L = valleyLayout(opts);
        expect(texels.length).toBe(ids.length * L.TEX * 4);
        // The texel nearest the river's middle has a small distance and the floor there.
        let best = { d: Infinity };
        ids.forEach((pid, slot) => {
            for (let t = 0; t < L.TEX; t++) {
                const v = texel(texels, (slot * L.TEX + t) * 4);
                if (v.d < best.d) best = v;
            }
        });
        expect(best.d).toBeLessThan(70);   // texels ~128 m apart at the face centre
        expect(best.F).toBeGreaterThan(479);
        expect(best.F).toBeLessThan(501);
        expect(best.wc).toBeCloseTo(40, 1);
        expect(best.fill).toBeCloseTo(1, 2);
        expect(best.wall).toBeCloseTo(0.2, 2);
    });

    it('pages agree on the texels they share (apron): no seams', () => {
        const rv = river();
        const ids = [...valleyPagesNear(rv.dirs, rv.s, R, opts)].sort((a, b) => a - b);
        const { texels } = bakeValleyPages(ids, [rv], { R }, opts);
        const L = valleyLayout(opts);
        const at = new Map();   // global texel key -> packed words
        let checked = 0, differ = 0;
        ids.forEach((pid, slot) => {
            const face = Math.floor(pid / (L.PE * L.PE)), pj = Math.floor((pid % (L.PE * L.PE)) / L.PE), pi = pid % L.PE;
            for (let jj = 0; jj < L.ST; jj++) for (let ii = 0; ii < L.ST; ii++) {
                const key = `${face}:${pi * L.P - 2 + ii}:${pj * L.P - 2 + jj}`, w = (slot * L.TEX + jj * L.ST + ii) * 4;
                const words = Array.from(texels.subarray(w, w + 4)).join(',');
                const prev = at.get(key);
                if (prev) { checked++; if (prev !== words) differ++; } else at.set(key, words);
            }
        });
        expect(checked).toBeGreaterThan(100);
        expect(differ).toBe(0);   // bit-identical
    });

    it('lake water nearby: the cut stops at its level; no fill on the water itself', () => {
        const rv = river();
        const L0 = valleyLayout(opts);
        // The pages the river runs through (v = 0.5: page rows PE / 2 - 1 and PE / 2).
        const ids = [...valleyPagesNear(rv.dirs, rv.s, R, opts)].filter(pid => Math.abs(Math.floor(pid / L0.PE) % L0.PE - L0.PE / 2 + 0.5) < 1).slice(0, 4);
        const lakeLevelAt = (d) => (d[1] > 0.0 ? 520 : NaN);   // water on one side
        const { texels } = bakeValleyPages(ids, [rv], { R, lakeLevelAt }, opts);
        const L = valleyLayout(opts);
        let rimTexels = 0;
        ids.forEach((pid, slot) => {
            for (let t = 0; t < L.TEX; t++) {
                const v = texel(texels, (slot * L.TEX + t) * 4);
                if (v.wRim > 0.5) {
                    rimTexels++;
                    expect(v.rim).toBeCloseTo(520 + opts.rimMarginM, 0);
                }
            }
        });
        expect(rimTexels).toBeGreaterThan(0);
    });

    it('page cells cover the page with a margin', () => {
        const L = valleyLayout(opts), N = 512;
        const pid = 0 * L.PE * L.PE + 10 * L.PE + 20;
        const cells = valleyPageCells(pid, N, opts);
        const per = N / L.PE;
        expect(cells).toContain(10 * per * N + 20 * per);
        expect(cells.length).toBeGreaterThanOrEqual(per * per);
    });
});
