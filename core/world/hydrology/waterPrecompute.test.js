import { beforeAll, describe, expect, it } from 'vitest';
import { cellDir } from './waterGraph.js';
import { planeToDir } from './lakeRefine.js';
import { createWaterWorkerCore } from './waterWorkerCore.js';
import { WaterGpuData, lakeMaskAtlasPlan } from '../water/WaterGpuData.js';

// Precompute mode (WaterService refine.precompute): cropped lake masks,
// routes once at the end, and a mask atlas with several tile sizes.

const R = 131072, N = 24;
// Continent around +Z with one bowl (waterWorkerCore.test.js terrain, one bowl).
function terrain(d) {
    if (d[2] <= 0) return -200;
    const s = d[0] / d[2], t = d[1] / d[2];
    if (s > 0.8 || Math.abs(t) > 0.9) return -200;
    const r2 = ((s + 0.3) / 0.18) ** 2 + (t / 0.18) ** 2;
    return 300 * (0.8 - s) + 10 + 400 * t * t + (r2 < 1 ? -90 * (1 - r2) : 0);
}
function patchHeights(frame) {
    const h = new Float32Array(frame.nx * frame.ny);
    for (let j = 0; j < frame.ny; j++) for (let i = 0; i < frame.nx; i++) {
        h[j * frame.nx + i] = terrain(planeToDir(frame.x0 + (i + 0.5) * frame.spacing, frame.y0 + (j + 0.5) * frame.spacing, frame, R));
    }
    return h;
}
function buildCore() {
    const heights = new Float32Array(6 * N * N);
    for (let id = 0; id < heights.length; id++) heights[id] = terrain(cellDir(id, N));
    const core = createWaterWorkerCore();
    const built = core.handle({ type: 'build', N, heights, precip: null, seaLevelM: 0, radius: R, spacing: 400,
        params: { minLakeDepthM: 3, minLakeCells: 2, minRiverQ: 1 } }).reply;
    return { core, built };
}

describe('lake precompute: worker', () => {
    it('crops the mask to the water and keeps the same cells, level and routes', () => {
        const a = buildCore(), b = buildCore();
        const lake = a.built.lakes[0];
        const full = a.core.handle({ type: 'solveLake', lakeId: lake.id, frame: lake.frame, heights: patchHeights(lake.frame), bandM: 6 }).reply;
        const crop = b.core.handle({ type: 'solveLake', lakeId: lake.id, frame: lake.frame, heights: patchHeights(lake.frame), bandM: 6, crop: true, skipDownstream: true }).reply;
        expect(crop.status).toBe('ok');
        expect(crop.level).toBe(full.level);
        expect(crop.patchFrame).toEqual(lake.frame);
        expect(crop.frame.nx * crop.frame.ny).toBeLessThan(full.frame.nx * full.frame.ny);
        expect(Array.from(crop.maskCells)).toEqual(Array.from(full.maskCells));
        // Every full-mask cell is the same cell of the cropped mask (same plane, shifted origin).
        const di = Math.round((crop.frame.x0 - full.frame.x0) / full.frame.spacing), dj = Math.round((crop.frame.y0 - full.frame.y0) / full.frame.spacing);
        let wet = 0;
        for (let j = 0; j < full.frame.ny; j++) for (let i = 0; i < full.frame.nx; i++) {
            const v = full.mask[j * full.frame.nx + i];
            const ci = i - di, cj = j - dj, inside = ci >= 0 && cj >= 0 && ci < crop.frame.nx && cj < crop.frame.ny;
            if (v) { wet++; expect(inside && crop.mask[cj * crop.frame.nx + ci]).toBe(v); }
        }
        expect(wet).toBeGreaterThan(0);
        expect(crop.downstream).toBeNull();
        expect(b.core.handle({ type: 'downstream' }).reply.downstream).toEqual(full.downstream);
        // A cached cropped record restores the same route.
        const c = buildCore();
        c.core.handle({ type: 'restoreLake', lakeId: lake.id, level: crop.level, exitDir: crop.exitDir, outflowDirs: crop.outflowDirs,
            merged: crop.merged, frame: crop.frame, mask: crop.mask, skipDownstream: true });
        expect(c.core.handle({ type: 'downstream' }).reply.downstream).toEqual(full.downstream);
    });
});

describe('lake precompute: pool solve and adoption', () => {
    it('solvePatchLake + adoptLake give solveLake(crop)\'s record, merges and routes', () => {
        const a = buildCore(), b = buildCore();
        const lake = a.built.lakes[0];
        const one = a.core.handle({ type: 'solveLake', lakeId: lake.id, frame: lake.frame, heights: patchHeights(lake.frame), bandM: 6, crop: true, skipDownstream: true }).reply;
        const others = new Float64Array(b.built.lakes.length * 4);
        b.built.lakes.forEach((l, k) => others.set([l.id, ...l.centreDir], 4 * k));
        const cells = b.built.lakeCells.subarray(b.built.lakeCellStart[lake.id], b.built.lakeCellStart[lake.id + 1]);
        const pool = createWaterWorkerCore();   // no graph: the pool worker is stateless
        const p = pool.handle({ type: 'solvePatchLake', lakeId: lake.id, frame: lake.frame, heights: patchHeights(lake.frame), bandM: 6, N, R, lakeCells: cells, others }).reply;
        expect(p.status).toBe('ok');
        for (const k of ['level', 'maxDepth', 'cells', 'areaM2', 'exitDir', 'outflowDirs', 'frame', 'patchFrame']) expect(p[k]).toEqual(one[k]);
        expect(Array.from(p.mask)).toEqual(Array.from(one.mask));
        expect(Array.from(p.maskCells)).toEqual(Array.from(one.maskCells));
        const adopted = b.core.handle({ type: 'adoptLake', lakeId: lake.id, level: p.level, exitDir: p.exitDir, outflowDirs: p.outflowDirs,
            frame: p.frame, mask: p.mask, candidates: p.candidates }).reply;
        expect(adopted.status).toBe('ok');
        expect(adopted.merged).toEqual(one.merged);
        expect(b.core.handle({ type: 'downstream' }).reply.downstream).toEqual(a.core.handle({ type: 'downstream' }).reply.downstream);
        // A lake already merged into the adopted one is reported, not adopted.
        for (const m of adopted.merged) expect(b.core.handle({ type: 'adoptLake', lakeId: m, candidates: [] }).reply.status).toBe('merged');
    });
});

describe('lake precompute: mask atlas', () => {
    beforeAll(() => {
        globalThis.GPUBufferUsage ??= { STORAGE: 1, COPY_DST: 2, UNIFORM: 4, COPY_SRC: 8, MAP_READ: 16 };
        globalThis.GPUTextureUsage ??= { TEXTURE_BINDING: 1, COPY_DST: 2 };
    });
    const frameOf = (nx, ny = nx, spacing = 32) => ({ c: [0, 0, 1], e1: [1, 0, 0], e2: [0, 1, 0], x0: 0, y0: 0, spacing, nx, ny });

    it('sizes classes from the graph frames less their solve margins', () => {
        // 5 km wide: extent 2 km (margins 1.5 km) -> small; 80 km: extent 50 km -> pooled into 512.
        const plan = lakeMaskAtlasPlan([{ frame: frameOf(160) }, { frame: frameOf(2500) }], { slack: 1 });
        expect(plan.classes).toEqual([{ size: 512, slots: 5 }, { size: 256, slots: 4 }, { size: 128, slots: 5 }]);
        expect(plan.bytes).toBe(3 * 2048 * 2048);
    });

    it('gives each lake the smallest tile it fits (pooled at most 2x) and encodes it for the shader', () => {
        const uploads = [], dev = {
            createBuffer: (d) => ({ ...d, destroy() {} }),
            createTexture: (d) => ({ ...d, width: d.size[0], height: d.size[1], depthOrArrayLayers: d.size[2], createView: () => ({}), destroy() {} }),
            queue: { writeBuffer() {}, writeTexture: (dst, data, layout, size) => uploads.push({ origin: dst.origin, size }) },
        };
        const atlas = { dim: 2048, pool: 2, classes: [{ size: 512, slots: 2 }, { size: 256, slots: 2 }, { size: 128, slots: 300 }] };
        const gpu = new WaterGpuData(dev, { gridN: 4, planetRadius: R, maxLakes: 8, maxRiverCells: 1, maxRiverSegs: 1, maskAtlas: atlas });
        // 128^2 tiles: 256 a layer, so 300 slots take two layers after the 512 and 256 layers.
        expect(gpu.masksTexture.size).toEqual([2048, 2048, 4]);
        const sizes = [100, 300, 700, 1000];
        const svc = { state: 'ready', version: 1, N: 4, lakes: sizes.map((n, id) => ({ id, level: 10, frame: frameOf(n) })),
            lakeCells: Int32Array.from([0, 1, 2, 3]), lakeCellStart: Int32Array.from([0, 1, 2, 3, 4]), riverOf: new Int32Array(96).fill(-1),
            refined: new Map(sizes.map((n, id) => [id, { level: 10, frame: frameOf(n), mask: new Uint8Array(n * n).fill(2), maskCells: Int32Array.from([id]) }])),
            mergedInto: new Map(), riverRecs: new Map(), rivers: [], rep: (id) => id };
        gpu.update(svc, { x: 0, y: 0, z: 2e5 }, 0);
        expect(gpu._applied.size).toBe(4);
        // 100 -> 128 (<= 2x pooled: 64 also fits but there is none), 300 -> 256, 700 -> 512, 1000 -> 512.
        const tile = (id) => { const code = gpu._tableI32[id * 16 + 1]; return { layer: code & 255, tx: (code >> 8) & 15, ty: (code >> 12) & 15, tiles: code >> 16 }; };
        expect(tile(0).tiles).toBe(16);
        expect(tile(1).tiles).toBe(8);
        expect(tile(2).tiles).toBe(4);
        expect(tile(3).tiles).toBe(4);
        expect(tile(0).layer).toBe(2);
        for (let id = 0; id < 4; id++) {
            const t = tile(id), S = 2048 / t.tiles;
            expect(uploads[id].origin).toEqual({ x: t.tx * S, y: t.ty * S, z: t.layer });
            expect(uploads[id].size).toEqual({ width: S, height: S, depthOrArrayLayers: 1 });
        }
    });
});
