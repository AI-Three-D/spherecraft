import { beforeAll, describe, expect, it } from 'vitest';
import { WaterGpuData, tilesTouchingCells } from './WaterGpuData.js';
import { RIVER_SEG_FLOATS } from './waterWgsl.js';

// Stub device: records uploads; no GPU in vitest.
beforeAll(() => {
    globalThis.GPUBufferUsage ??= { STORAGE: 1, COPY_DST: 2, UNIFORM: 4, COPY_SRC: 8, MAP_READ: 16 };
    globalThis.GPUTextureUsage ??= { TEXTURE_BINDING: 1, COPY_DST: 2 };
});
function stubDevice() {
    const log = { buffers: [], textures: [] };
    return {
        log,
        createBuffer: (d) => ({ ...d, destroy() {} }),
        createTexture: (d) => ({ ...d, createView: () => ({}), destroy() {} }),
        queue: {
            writeBuffer: (buf, offset, data, dataOffset = 0, size) => log.buffers.push({ label: buf.label, offset, dataOffset, size }),
            writeTexture: (dst) => log.textures.push(dst.origin.z),
        },
    };
}
// Fake service: N = 4 grid (96 cells); lake 0 on cells 1,2; lake 1 on cells
// 10,11; lake 2 on 50; a river on cell 3.
function fakeService() {
    const N = 4, cells = 6 * N * N;
    // Unit frame centres (as lakePatchFrame makes them), spread along +x.
    const frame = (cx) => { const l = Math.hypot(cx, 1); return { c: [cx / l, 0, 1 / l], e1: [1, 0, 0], e2: [0, 1, 0], x0: 0, y0: 0, spacing: 16, nx: 8, ny: 8 }; };
    const riverOf = new Int32Array(cells).fill(-1); riverOf[3] = 0;
    const svc = {
        state: 'ready', version: 1, N,
        lakes: [0, 1, 2].map(id => ({ id, level: 100 + id, frame: frame(id) })),
        lakeCells: Int32Array.from([1, 2, 10, 11, 50]), lakeCellStart: Int32Array.from([0, 2, 4, 5]),
        riverOf, refined: new Map(), mergedInto: new Map(), riverRecs: new Map(),
        rivers: [{ id: 0, fromLake: 0, cells: Int32Array.from([1, 3, 10]) }],
        rep(id) { while (this.mergedInto.has(id)) id = this.mergedInto.get(id); return id; },
    };
    return svc;
}
const slots = (gpu, c) => [gpu.index[c] & 0x7fff, (gpu.index[c] >>> 15) & 0x7fff, (gpu.index[c] >>> 30) & 1];
const cam = { x: 0, y: 0, z: 200000 };

describe('WaterGpuData', () => {
    it('builds the index from graph cells and river bits', () => {
        const gpu = new WaterGpuData(stubDevice(), { gridN: 4, planetRadius: 131072, maxMaskLayers: 2 });
        gpu.update(fakeService(), cam, 0);
        expect(slots(gpu, 1)).toEqual([1, 0, 0]);
        expect(slots(gpu, 10)).toEqual([2, 0, 0]);
        expect(slots(gpu, 50)).toEqual([3, 0, 0]);
        expect(slots(gpu, 3)).toEqual([0, 0, 1]);
    });

    it('a refined lake moves to its mask cells; a merged lake leaves the index', () => {
        const dev = stubDevice();
        const gpu = new WaterGpuData(dev, { gridN: 4, planetRadius: 131072, maxMaskLayers: 2 });
        const svc = fakeService();
        gpu.update(svc, cam, 0);
        svc.refined.set(0, { level: 99, frame: svc.lakes[0].frame, mask: new Uint8Array(64).fill(2), maskCells: Int32Array.from([2, 3, 11]), merged: [1] });
        svc.mergedInto.set(1, 0);
        svc.version++;
        gpu.update(svc, cam, 0);
        expect(slots(gpu, 1)).toEqual([0, 0, 0]);      // graph cell no longer under the lake
        expect(slots(gpu, 2)).toEqual([1, 0, 0]);
        expect(slots(gpu, 3)).toEqual([1, 0, 1]);      // river bit kept
        expect(slots(gpu, 10)).toEqual([0, 0, 0]);     // merged lake 1 cleared
        expect(slots(gpu, 11)).toEqual([1, 0, 0]);     // now lake 0's mask cell
        expect(dev.log.textures).toEqual([0]);         // one mask layer uploaded
    });

    it('when the atlas is full the farthest lake gives its layer up', () => {
        const dev = stubDevice();
        const gpu = new WaterGpuData(dev, { gridN: 4, planetRadius: 131072, maxMaskLayers: 1 });
        const svc = fakeService();
        gpu.update(svc, cam, 0);
        const refine = (id, cells) => svc.refined.set(id, { level: 90 + id, frame: svc.lakes[id].frame, mask: new Uint8Array(64).fill(2), maskCells: Int32Array.from(cells), merged: [] });
        refine(2, [50]); svc.version++; gpu.update(svc, cam, 0);
        // Lake 0 (frame centre [0, 0, 1], straight under the camera) is nearer than lake 2.
        refine(0, [1, 2]); svc.version++; gpu.update(svc, cam, 0);
        expect(gpu._layerOf.get(0)).toBe(0);
        expect(gpu._layerOf.has(2)).toBe(false);
        expect(slots(gpu, 50)).toEqual([3, 0, 0]);     // lake 2 stays indexed, level-only
    });

    it('a traced river lists its segments in its cells and replaces the graph river cell', () => {
        const dev = stubDevice();
        const gpu = new WaterGpuData(dev, { gridN: 4, planetRadius: 131072, maxMaskLayers: 2 });
        const svc = fakeService();
        gpu.update(svc, cam, 0);
        expect(slots(gpu, 3)[2]).toBe(1);
        // Three points (stride 8): segment 0 in sub-cell 5 of cell 3 and sub-cell
        // 0 of cell 4, segment 1 in sub-cell 0 of cell 4 (ids cell * 16 + sub).
        const points = new Float32Array(24);
        points.set([0, 0, 1, 105, 6, 1, 1.2, 3], 0);
        points.set([0.001, 0, 1, 104, 6, 1, 1.2, 3], 8);
        points.set([0.002, 0, 1, 103, 7, 1.2, 1.4, 4], 16);
        svc.riverRecs.set(0, { points, stride: 8, segCellStart: Int32Array.from([0, 2, 3]), segCells: Int32Array.from([53, 64, 64]) });
        svc.version++;
        gpu.update(svc, cam, 0);
        const cells = gpu.cells;
        expect(slots(gpu, 3)[2]).toBe(0);                       // graph river bit cleared
        const sub = (c, s) => gpu.index[2 * cells + (gpu.index[cells + c] - 1) * 16 + s];
        expect(gpu.index[cells + 3]).toBeGreaterThan(0);
        expect(gpu.index[cells + 4]).toBeGreaterThan(0);
        expect(gpu.index[cells + 5]).toBe(0);
        expect(sub(3, 5) & 0xff).toBe(1);
        expect(sub(3, 0)).toBe(0);
        const e4 = sub(4, 0);
        expect(e4 & 0xff).toBe(2);
        expect(gpu.riverSegCount).toBe(3);
        // Sub-cell 0 of cell 4: its second entry is segment 1, from point 1 to point 2; bed = level - depth.
        const o = ((e4 >>> 8) + 1) * RIVER_SEG_FLOATS;
        expect(Array.from(gpu._segs.slice(o, o + 4))).toEqual([0.001, 0, 1, 104].map(Math.fround));
        expect(gpu._segs[o + 7]).toBe(103);
        expect(gpu._segs[o + 10]).toBe(103);
        expect(gpu._segs[o + 11]).toBeCloseTo(101.8, 4);
    });

    it('packs the stride-12 river points: hollows reach, skew, speed and foam at both ends', () => {
        const dev = stubDevice();
        const gpu = new WaterGpuData(dev, { gridN: 4, planetRadius: 131072, maxMaskLayers: 2 });
        const svc = fakeService();
        gpu.update(svc, cam, 0);
        // dir.xyz, level, half-width, depth, speed, Q, fill, pool, skew, foam
        const points = new Float32Array(24);
        points.set([0, 0, 1, 105, 15, 1.05, 0.8, 3, 106, 40, 0.1, 0.2], 0);
        points.set([0.001, 0, 1, 104, 16, 1.2, 0.9, 3, 105, -1, -0.2, 0.4], 12);
        svc.riverRecs.set(0, { points, stride: 12, segCellStart: Int32Array.from([0, 1]), segCells: Int32Array.from([64]) });
        svc.version++;
        gpu.update(svc, cam, 0);
        const e = gpu.index[2 * gpu.cells + (gpu.index[gpu.cells + 4] - 1) * 16];
        const o = (e >>> 8) * RIVER_SEG_FLOATS;
        expect(Array.from(gpu._segs.slice(o + 8, o + 20)).map(v => +v.toFixed(4)))
            .toEqual([15, 16, 103.95, 102.8, 40, -1, 0.1, -0.2, 0.8, 0.9, 0.2, 0.4]);
    });

    it('tilesTouchingCells picks the tiles over (or next to) changed cells', () => {
        const N = 8, cell = 2 * N * N + 5 * N + 3;            // face 2, i 3, j 5
        const touches = tilesTouchingCells(new Set([cell]), N);
        expect(touches(2, 3, 3, 5)).toBe(true);                 // the same square
        expect(touches(2, 3, 4, 5)).toBe(true);                 // neighbour (normals' border)
        expect(touches(2, 3, 5, 5)).toBe(false);
        expect(touches(2, 0, 0, 0)).toBe(true);                 // the whole face
        expect(touches(1, 0, 0, 0)).toBe(false);                // another face
        expect(touches(2, 5, 13, 21)).toBe(true);               // a small tile inside the cell
        expect(touches(2, 5, 21, 21)).toBe(false);              // two cells away
    });
});
