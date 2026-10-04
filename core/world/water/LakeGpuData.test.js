import { beforeAll, describe, expect, it } from 'vitest';
import { LakeGpuData } from './LakeGpuData.js';

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
        riverOf, refined: new Map(), mergedInto: new Map(),
        rep(id) { while (this.mergedInto.has(id)) id = this.mergedInto.get(id); return id; },
    };
    return svc;
}
const slots = (gpu, c) => [gpu.index[c] & 0x7fff, (gpu.index[c] >>> 15) & 0x7fff, (gpu.index[c] >>> 30) & 1];
const cam = { x: 0, y: 0, z: 200000 };

describe('LakeGpuData', () => {
    it('builds the index from graph cells and river bits', () => {
        const gpu = new LakeGpuData(stubDevice(), { gridN: 4, planetRadius: 131072, maxMaskLayers: 2 });
        gpu.update(fakeService(), cam, 0);
        expect(slots(gpu, 1)).toEqual([1, 0, 0]);
        expect(slots(gpu, 10)).toEqual([2, 0, 0]);
        expect(slots(gpu, 50)).toEqual([3, 0, 0]);
        expect(slots(gpu, 3)).toEqual([0, 0, 1]);
    });

    it('a refined lake moves to its mask cells; a merged lake leaves the index', () => {
        const dev = stubDevice();
        const gpu = new LakeGpuData(dev, { gridN: 4, planetRadius: 131072, maxMaskLayers: 2 });
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
        const gpu = new LakeGpuData(dev, { gridN: 4, planetRadius: 131072, maxMaskLayers: 1 });
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
});
