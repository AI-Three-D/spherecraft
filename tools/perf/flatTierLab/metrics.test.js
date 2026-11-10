import { describe, expect, it } from 'vitest';
import { lodMap, tileEdges, seamScore, lodChangeDiff } from './metrics.mjs';

const W = 40, H = 20;
function img(fn) {
    const data = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const [r, g, b] = fn(x, y); const p = (y * W + x) * 4;
        data[p] = r; data[p + 1] = g; data[p + 2] = b; data[p + 3] = 255;
    }
    return { width: W, height: H, data };
}
// Two tiles split at x = 20: LOD5 left, LOD6 right; instance colours differ.
const img90 = img(x => (x < 20 ? [0, 0, 255] : [255, 0, 255]));
const img13 = img(x => (x < 20 ? [10, 20, 30] : [200, 100, 50]));

describe('flat-tier lab metrics', () => {
    const lods = lodMap(img90);
    const edges = tileEdges(img13, lods);
    it('finds the LODs and the one vertical tile edge', () => {
        expect(lods[0]).toBe(5);
        expect(lods[W - 1]).toBe(6);
        expect(edges.right.reduce((a, b) => a + b, 0)).toBe(H);
        expect(edges.down.reduce((a, b) => a + b, 0)).toBe(0);
    });
    it('scores a step at the edge, and nothing for a smooth ramp', () => {
        const stepImg = img(x => (x < 20 ? [100, 100, 100] : [130, 130, 130]));
        const ramp = img(x => [100 + x, 100 + x, 100 + x]);
        expect(seamScore(stepImg, edges, lods).all.meanExcess).toBeCloseTo(30);
        expect(seamScore(stepImg, edges, lods).crossLod.pairs).toBeGreaterThan(0);
        expect(seamScore(ramp, edges, lods).all.meanExcess).toBeCloseTo(0);
    });
    it('measures the difference where the LOD changed', () => {
        const a = img(() => [100, 100, 100]), b = img(x => (x < 20 ? [100, 100, 100] : [120, 120, 120]));
        const lodsB = lodMap(img(() => [0, 0, 255]));
        const d = lodChangeDiff(a, b, lods, lodsB);
        expect(d.lodChangedPixels).toBe(W * H / 2);
        expect(d.meanDiffWhereLodChanged).toBeCloseTo(20);
    });
});
