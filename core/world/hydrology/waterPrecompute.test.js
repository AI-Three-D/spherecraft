import { beforeAll, describe, expect, it } from 'vitest';
import { cellDir } from './waterGraph.js';
import { dirToPlane, planeToDir } from './lakeRefine.js';
import { createWaterWorkerCore } from './waterWorkerCore.js';
import { WaterGpuData, lakeMaskAtlasPlan } from '../water/WaterGpuData.js';
import { WaterService } from './WaterService.js';
import { MOUNTAIN_LAKE_DEFAULTS } from './mountainLakes.js';

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

describe('lake precompute: lakes added to the graph', () => {
    it('routes a stream from an added upper lake down to the graph lake below it', () => {
        const { core, built } = buildCore();
        const lake = built.lakes[0];
        const solved = core.handle({ type: 'solveLake', lakeId: lake.id, frame: lake.frame, heights: patchHeights(lake.frame), bandM: 6, crop: true, skipDownstream: true }).reply;
        expect(solved.status).toBe('ok');
        // An upper pocket up the valley (the terrain falls to +s): a lake 40 m
        // above the graph lake, spilling down the valley toward it.
        const d = lake.centreDir;   // the deepest cell's direction
        // Exit well above the lake's grid cells, so the route has a length.
        const s0 = d[0] / d[2], up = [s0 - 0.22, 0, 1], l = Math.hypot(...up), dir = up.map(v => v / l);
        const exit = [s0 - 0.2, 0, 1].map((v, i, a) => v / Math.hypot(...a));
        const frame = { ...solved.frame };
        const added = core.handle({ type: 'addLakes', maxRouteM: 1e6, lakes: [{ level: solved.level + 40, maxDepth: 5, exitDir: exit,
            outflowDirs: [exit], frame, mask: new Uint8Array(frame.nx * frame.ny), maskCells: Int32Array.from([0]), deepestDir: dir }] }).reply;
        expect(added.base).toBe(built.lakes.length);
        expect(added.rivers).toHaveLength(1);
        expect(added.rivers[0].fromLake).toBe(built.lakes.length);
        expect(added.rivers[0].to).toEqual({ type: 'lake', id: lake.id });
        // A route longer than the limit gives no stream.
        const none = core.handle({ type: 'addLakes', maxRouteM: 1, lakes: [{ level: solved.level + 60, maxDepth: 5, exitDir: exit,
            outflowDirs: [exit], frame, mask: new Uint8Array(frame.nx * frame.ny), maskCells: Int32Array.from([1]), deepestDir: dir }] }).reply;
        expect(none.rivers).toHaveLength(0);
    });
});

describe('lake precompute: streams on fine routes', () => {
    it('takes a stream along its given route and traces it inside a narrow corridor', () => {
        const { core, built } = buildCore();
        const lake = built.lakes[0];
        const solved = core.handle({ type: 'solveLake', lakeId: lake.id, frame: lake.frame, heights: patchHeights(lake.frame), bandM: 6, crop: true, skipDownstream: true }).reply;
        const s0 = lake.centreDir[0] / lake.centreDir[2];
        const at = (s, t) => { const l = Math.hypot(s, t, 1); return [s / l, t / l, 1 / l]; };
        // Down the valley from above the lake's uphill shore (s0 - 0.126),
        // with a bend off the straight line (t = 0.015, ~2 km), into its water.
        const route = [at(s0 - 0.2, 0), at(s0 - 0.17, 0.015), at(s0 - 0.14, 0.015), at(s0 - 0.11, 0), at(s0 - 0.08, 0)];
        const frame = { ...solved.frame };
        const added = core.handle({ type: 'addLakes', maxRouteM: 1e6, streamCorridorM: 300,
            streams: [{ lake: 0, dirs: route, to: { type: 'lake', id: lake.id }, lengthM: 11000 }],
            lakes: [{ level: solved.level + 40, maxDepth: 5, exitDir: route[0], outflowDirs: [route[0]], frame,
                mask: new Uint8Array(frame.nx * frame.ny), maskCells: Int32Array.from([0]), deepestDir: at(s0 - 0.21, 0) }] }).reply;
        expect(added.rivers).toHaveLength(1);
        const rid = added.rivers[0].id;
        expect(added.rivers[0].to).toEqual({ type: 'lake', id: lake.id });
        // A wider retry corridor scales the stream's own (1500 / 1000).
        const wide = core.handle({ type: 'planRiver', riverId: rid, spacing: 64, corridorM: 1500, baseCorridorM: 1000 }).reply;
        const plan = core.handle({ type: 'planRiver', riverId: rid, spacing: 64, corridorM: 1000, baseCorridorM: 1000 }).reply;
        expect(plan.status).toBe('ok');
        expect(plan.dest).toEqual({ type: 'lake', id: lake.id });
        expect((wide.frame.ny - plan.frame.ny) * 64).toBeGreaterThan(250);
        const rec = core.handle({ type: 'solveRiver', riverId: rid, frame: plan.frame, heights: patchHeights(plan.frame), stepM: 20 }).reply;
        expect(rec.status).toBe('ok');
        // Every traced point within the corridor (300 m, plus a cell) of the route.
        const f = plan.frame, poly = route.map(d => dirToPlane(d, f, R));
        const P = rec.points, st = rec.stride;
        let off = 0;
        for (let o = 0; o < P.length; o += st) {
            const [x, y] = dirToPlane([P[o], P[o + 1], P[o + 2]], f, R);
            let best = Infinity;
            for (let k = 0; k + 1 < poly.length; k++) {
                const [ax, ay] = poly[k], [bx, by] = poly[k + 1], ux = bx - ax, uy = by - ay, L2 = ux * ux + uy * uy || 1e-9;
                const t = Math.max(0, Math.min(1, ((x - ax) * ux + (y - ay) * uy) / L2));
                best = Math.min(best, Math.hypot(x - ax - t * ux, y - ay - t * uy));
            }
            off = Math.max(off, best);
        }
        expect(off).toBeLessThan(300 + 64);
        // The bend is followed: some point sits well off the straight line.
        let maxT = 0;
        for (let o = 0; o < P.length; o += st) maxT = Math.max(maxT, P[o + 1] / P[o + 2]);
        expect(maxT).toBeGreaterThan(0.01);
    });
});

describe('lake precompute: mountain streams that meet', () => {
    it('a stream reaching the route of an earlier stream joins it as a tributary there', () => {
        const at = (xM, yM) => { const l = Math.hypot(xM / R, yM / R, 1); return [xM / R / l, yM / R / l, 1 / l]; };
        // Stream A down the valley (x = 0); stream B from the side, meeting A at y = 600 m.
        const A = Array.from({ length: 12 }, (_, k) => at(0, k * 128));
        const B = [...Array.from({ length: 5 }, (_, k) => at(640 - k * 128, 600)), ...A.slice(5)];
        const walk = (k) => ({ stream: { lake: k, dirs: k ? B : A, to: { type: 'lake', id: 7 }, lengthM: 1 } });
        const streams = WaterService.prototype._joinMountainStreams.call({ N: 512, radius: R }, [{}, {}], walk, MOUNTAIN_LAKE_DEFAULTS, 100);
        expect(streams[0].to).toEqual({ type: 'lake', id: 7 });
        expect(streams[1].to.type).toBe('river');
        expect(streams[1].to.id).toBe(100);
        // It ends at its first point within 64 m of A's route (A's point at
        // y = 640; (128, 600) is 128 m off), not running on beside it.
        expect(streams[1].dirs.length).toBe(6);
        expect(Math.hypot(streams[1].to.dir[0] * R, streams[1].to.dir[1] * R - 640)).toBeLessThan(1);
        expect(Math.abs(streams[1].lengthM - 646)).toBeLessThan(2);
    });

    it('streams running side by side between their route points still join', () => {
        const at = (xM, yM) => { const l = Math.hypot(xM / R, yM / R, 1); return [xM / R / l, yM / R / l, 1 / l]; };
        // A every 128 m along x = 0; B comes in from the side, then runs 40 m
        // beside it with points offset by 64 m along: 75 m from A's points,
        // 40 m from its route.
        const A = Array.from({ length: 12 }, (_, k) => at(0, k * 128));
        const B = [at(300, 64), at(200, 192), at(100, 320), ...Array.from({ length: 6 }, (_, k) => at(40, 448 + k * 128))];
        const walk = (k) => ({ stream: { lake: k, dirs: k ? B : A, to: { type: 'lake', id: 7 }, lengthM: 1 } });
        const streams = WaterService.prototype._joinMountainStreams.call({ N: 512, radius: R }, [{}, {}], walk, MOUNTAIN_LAKE_DEFAULTS, 100);
        expect(streams[1].to.type).toBe('river');
        expect(streams[1].dirs.length).toBe(4);
        expect(Math.abs(streams[1].to.dir[0] * R)).toBeLessThan(1);
    });
});

describe('lake precompute: mask atlas', () => {
    beforeAll(() => {
        globalThis.GPUBufferUsage ??= { STORAGE: 1, COPY_DST: 2, UNIFORM: 4, COPY_SRC: 8, MAP_READ: 16 };
        globalThis.GPUTextureUsage ??= { TEXTURE_BINDING: 1, COPY_DST: 2 };
    });
    const frameOf = (nx, ny = nx, spacing = 32) => ({ c: [0, 0, 1], e1: [1, 0, 0], e2: [0, 1, 0], x0: 0, y0: 0, spacing, nx, ny });

    it('sizes classes from the graph frames less their solve margins, plus a reserve', () => {
        // 5 km wide: extent 2 km (margins 1.5 km) -> 64^2; 80 km: extent 50 km -> pooled into 512^2.
        const plan = lakeMaskAtlasPlan([{ frame: frameOf(160) }, { frame: frameOf(2500) }], { slack: 1 });
        expect(plan.classes).toEqual([{ size: 512, slots: 5 }, { size: 256, slots: 4 }, { size: 128, slots: 4 }, { size: 64, slots: 5 }]);
        // 1024^2 layers: 4 / 16 / 64 / 256 tiles each.
        expect(plan.bytes).toBe(5 * 1024 * 1024);
        const reserved = lakeMaskAtlasPlan([{ frame: frameOf(160) }], { slack: 1, reserve: 300 });
        expect(reserved.classes.at(-1)).toEqual({ size: 64, slots: 305 });
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
