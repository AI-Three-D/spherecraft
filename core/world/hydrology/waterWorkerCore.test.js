import { describe, expect, it } from 'vitest';
import { cellDir } from './waterGraph.js';
import { planeToDir } from './lakeRefine.js';
import { createWaterWorkerCore } from './waterWorkerCore.js';

// Synthetic planet (metres): a continent around +Z, ocean elsewhere; a
// valley sloping to the coast with two bowls on its floor (upper at
// s = -0.3, lower at s = 0.3), as in waterGraph.test.js. Evaluated
// analytically, so the fine patches see the same terrain as the grid.
const R = 131072;
function terrain(d) {
    if (d[2] <= 0) return -200;
    const s = d[0] / d[2], t = d[1] / d[2];
    if (s > 0.8 || Math.abs(t) > 0.9) return -200;
    const bowlAt = (s0) => {
        const r2 = ((s - s0) / 0.18) ** 2 + (t / 0.18) ** 2;
        return r2 < 1 ? -90 * (1 - r2) : 0;
    };
    return 300 * (0.8 - s) + 10 + 400 * t * t + bowlAt(-0.3) + bowlAt(0.3);
}
const N = 24;
function buildCore() {
    const heights = new Float32Array(6 * N * N);
    for (let id = 0; id < heights.length; id++) heights[id] = terrain(cellDir(id, N));
    const core = createWaterWorkerCore();
    const built = core.handle({
        type: 'build', N, heights, precip: null, seaLevelM: 0, radius: R, spacing: 400,
        params: { minLakeDepthM: 3, minLakeCells: 2, minRiverQ: 1 },
    }).reply;
    return { core, built };
}
function patchHeights(frame) {
    const h = new Float32Array(frame.nx * frame.ny);
    for (let j = 0; j < frame.ny; j++) {
        for (let i = 0; i < frame.nx; i++) {
            h[j * frame.nx + i] = terrain(planeToDir(frame.x0 + (i + 0.5) * frame.spacing, frame.y0 + (j + 0.5) * frame.spacing, frame, R));
        }
    }
    return h;
}

describe('water worker core', () => {
    it('builds the graph and solves both lakes; the upper drains into the lower', () => {
        const { core, built } = buildCore();
        expect(built.lakes.length).toBe(2);
        const upper = built.lakes.reduce((a, b) => (a.level > b.level ? a : b));
        const lower = built.lakes.find(l => l !== upper);
        const solved = {};
        for (const lake of [lower, upper]) {
            const r = core.handle({ type: 'solveLake', lakeId: lake.id, frame: lake.frame, heights: patchHeights(lake.frame), bandM: 6 }).reply;
            expect(r.status).toBe('ok');
            // Fine level within the grid's sampling error of the graph level.
            expect(Math.abs(r.level - lake.level)).toBeLessThan(40);
            expect(r.mask.includes(2)).toBe(true);
            expect(r.mask.includes(1)).toBe(true);
            solved[lake.id] = r;
        }
        const last = solved[upper.id];
        expect(last.downstream[upper.id]).toEqual({ type: 'lake', id: lower.id });
        expect(last.downstream[lower.id]).toEqual({ type: 'sea' });
    });

    it('never routes into a lake that is not lower (passes through instead)', () => {
        const { core, built } = buildCore();
        const upper = built.lakes.reduce((a, b) => (a.level > b.level ? a : b));
        const lower = built.lakes.find(l => l !== upper);
        const solved = core.handle({ type: 'solveLake', lakeId: upper.id, frame: upper.frame, heights: patchHeights(upper.frame), bandM: 6 }).reply;
        // Pretend the lower lake's fine level came out above the upper one's.
        const r = core.handle({ type: 'restoreLake', lakeId: lower.id, level: solved.level + 1, exitDir: cellDir(0, N) }).reply;
        expect(r.downstream[upper.id]).toEqual({ type: 'sea' });
    });

    it('restoring a cached solve gives the same routes as solving', () => {
        const a = buildCore(), b = buildCore();
        const lake = a.built.lakes[0];
        const solved = a.core.handle({ type: 'solveLake', lakeId: lake.id, frame: lake.frame, heights: patchHeights(lake.frame), bandM: 6 }).reply;
        const restored = b.core.handle({ type: 'restoreLake', lakeId: lake.id, level: solved.level, exitDir: solved.exitDir, merged: solved.merged }).reply;
        expect(restored.downstream).toEqual(solved.downstream);
    });
});
