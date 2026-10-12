import { beforeAll, describe, expect, it } from 'vitest';
import { WaterGpuData, tilesTouchingCells } from './WaterGpuData.js';
import { RIVER_SEG_FLOATS } from './waterWgsl.js';
import { dirToCell } from '../hydrology/waterGraph.js';

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
    it('publishes more than 96 immutable masks together without eviction and keeps tile addresses inside their layers',()=>{
        const dev=stubDevice(),uploads=[];dev.queue.writeTexture=(dst)=>uploads.push(dst.origin);
        const gpu=new WaterGpuData(dev,{gridN:16,planetRadius:131072,maxLakes:112,maxMaskLayers:112,maskTilesPerAxis:4,maskLayerSize:8,
            maxRiverCells:1,maxRiverSegs:1});
        const svc=fakeService(),frame=svc.lakes[0].frame;
        svc.riverOf=new Int32Array(6*16*16).fill(-1);svc.rivers=[];
        svc.lakes=Array.from({length:112},(_,id)=>({id,level:100+id,frame}));
        svc.lakeCells=Int32Array.from({length:112},(_,i)=>i);svc.lakeCellStart=Int32Array.from({length:113},(_,i)=>i);
        svc.refined=new Map(svc.lakes.map(l=>[l.id,{level:l.level,frame,mask:new Uint8Array(64).fill(2),maskCells:new Int32Array([l.id])}]));
        gpu.update(svc,cam,0);
        expect(gpu._layerOf.size).toBe(112);expect(gpu.masksTexture.size).toEqual([32,32,7]);
        for(const id of [0,3,4,15,16,95,96,111]) {
            const code=gpu._tableI32[id*16+1];
            expect(uploads[id]).toEqual({x:((code>>8)&15)*8,y:((code>>12)&15)*8,z:code&255});
            expect(code>>16).toBe(4);
        }
        gpu.update(svc,{x:200000,y:0,z:0},1);expect(gpu._layerOf.size).toBe(112);expect(uploads).toHaveLength(112);
    });
    it('shares bank detail and cut limits without overwriting the simulation fade',()=>{
        const gpu=new WaterGpuData(stubDevice(),{gridN:4,planetRadius:131072,maxMaskLayers:2,
            carve:{enabled:true,bankDetail:1,bankCutM:6}});
        gpu.site={river:0,s0:10,s1:100,halfM:5,endFadeM:8,sideFadeM:1,fade:.7};
        gpu.update(fakeService(),cam,0);
        const values=new Float32Array(gpu.paramsData);
        expect(values[22]).toBe(6);expect(values[23]).toBeCloseTo(.7);expect(values[35]).toBe(1);
    });
    it('marks distant bed coverage for carved reaches without islands, traced or structured',()=>{
        const gpu=new WaterGpuData(stubDevice(),{gridN:4,planetRadius:131072,maxMaskLayers:2,carve:{enabled:true}});
        const svc=fakeService(),points=new Float32Array(40);
        points.set([0,0,1,105,15,1.5,.8,3,0,0,0,0,0,0,0,0,105,1.5,-1e20,0]);
        points.set([.001,0,1,104,15,1.5,.8,3,0,0,0,0,0,0,0,0,104,1.5,-1e20,0],20);
        const publish=structured=>{
            svc.riverRecs.set(0,{structured,points:points.slice(),stride:20,segCellStart:Int32Array.from([0,1]),segCells:Int32Array.from([64])});
            svc.version++;gpu.update(svc,cam,0);return gpu._segs[23];
        };
        // Traced rivers too: the carve cuts every listed wet core to the profile.
        expect(publish(true)).toBe(2);expect(publish(false)).toBe(1);
        points[19]=.4;expect(publish(true)).toBe(0);
        points[19]=.4;expect(publish(false)).toBe(0);
        points[19]=0;gpu.carve.enabled=false;expect(publish(true)).toBe(0);expect(publish(false)).toBe(0);
    });
    it('uploads only the valid tail when a compact river-cell pool ends partway through a row',()=>{
        const dev=stubDevice(),gpu=new WaterGpuData(dev,{gridN:32,planetRadius:131072,maxRiverCells:1,maxRiverSegs:1,maxLakes:1,maskLayerSize:32,maxMaskLayers:1});
        gpu._dirtyRows.add(2*gpu.cells/gpu.N);gpu._flushRows();
        const u=dev.log.buffers.at(-1);expect(u.size).toBe(16);expect(u.dataOffset+u.size).toBe(gpu.index.length);
    });
    it('publishes packed bed depth using the existing mask allocation and clears its format when replaced',()=>{
        const dev=stubDevice(),uploads=[];
        dev.queue.writeTexture=(_dst,data)=>uploads.push(data.slice());
        const gpu=new WaterGpuData(dev,{gridN:4,planetRadius:131072,maskLayerSize:8,maxMaskLayers:2});
        const svc=fakeService(),frame=svc.lakes[0].frame;
        const rec={level:100,frame,mask:new Uint8Array(64).fill(2),maskCells:new Int32Array([1,2]),
            surfaceDepthMask:new Uint8Array(64).fill(160),surfaceDepthRangeM:16};
        svc.refined.set(0,rec);gpu.update(svc,cam,0);
        expect([...uploads[0]]).toEqual(new Array(64).fill(160));
        expect(gpu._table[15]).toBe(16);expect(gpu._table[0]).toBe(100);
        const replacement={...rec,surfaceDepthMask:undefined,surfaceDepthRangeM:0};
        svc.refined.set(0,replacement);svc.version++;gpu.update(svc,cam,0);
        expect(gpu._table[15]).toBe(0);expect([...uploads.at(-1)]).toEqual(new Array(64).fill(255));
    });
    it('repeated water publication releases its valley allocations as well as lake/river data', () => {
        const dev=stubDevice();let liveBytes=0;
        for(const method of ['createBuffer','createTexture']) {
            const original=dev[method];
            dev[method]=d=>{
                const resource=original(d),bytes=typeof d.size==='number'?d.size:d.size.reduce((a,b)=>a*b,1);
                liveBytes+=bytes;let destroyed=false;
                resource.destroy=()=>{if(!destroyed) {liveBytes-=bytes;destroyed=true;}};
                return resource;
            };
        }
        for(let i=0;i<3;i++) {
            const gpu=new WaterGpuData(dev,{gridN:4,planetRadius:131072,valley:{enabled:true},maxValleyPages:3});
            expect(liveBytes).toBeGreaterThan(0);gpu.destroy();expect(liveBytes).toBe(0);
        }
    });
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

    it('retains more than 128 nearby segments at wide junctions', () => {
        const gpu = new WaterGpuData(stubDevice(), { gridN: 4, planetRadius: 131072, maxMaskLayers: 2 });
        const svc = fakeService(), count = 200, points = new Float32Array((count + 1) * 8);
        for (let k = 0; k <= count; k++) points.set([k * 0.00001, 0, 1, 105 - k * 0.01, 30, 1, 1, 3], k * 8);
        svc.riverRecs.set(0, { points, stride: 8, segCellStart: Int32Array.from({ length: count + 1 }, (_, k) => k), segCells: new Int32Array(count).fill(64) });
        gpu.update(svc, cam, 0);
        const block = gpu.index[gpu.cells + 4] - 1;
        const entry = gpu.index[2 * gpu.cells + block * 16];
        expect(entry & 0xff).toBe(count);
        expect(gpu.riverSegCount).toBe(count);
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
        // Arc length (m) at both ends and the river's id.
        expect(gpu._segs[o + 20]).toBe(0);
        expect(gpu._segs[o + 21]).toBeCloseTo(131072 * 0.001, 1);
        expect(gpu._segs[o + 22]).toBe(0);
    });

    it('full buffer: rivers nearest the camera (by their nearest point) win; one leaving marks its cells changed', () => {
        const dev = stubDevice();
        const gpu = new WaterGpuData(dev, { gridN: 4, planetRadius: 131072, maxMaskLayers: 2, maxRiverSegs: 2 });
        const svc = fakeService();
        svc.rivers.push({ id: 1, fromLake: 1, cells: Int32Array.from([]) });
        gpu.update(svc, cam, 0);
        // River 0: source far (x = 1), but its second point right under the camera (z axis).
        // River 1: both points at 45 degrees. Each needs 2 list entries; the buffer holds 2.
        const pts = (a, b) => { const P = new Float32Array(24); P.set([...a, 100, 15, 1, 0.5, 3, 101, 0, 0, 0], 0); P.set([...b, 99, 15, 1, 0.5, 3, 100, 0, 0, 0], 12); return P; };
        const r = Math.SQRT1_2;
        svc.riverRecs.set(0, { points: pts([1, 0, 0], [0, 0, 1]), stride: 12, segCellStart: Int32Array.from([0, 2]), segCells: Int32Array.from([16 * 7, 16 * 8]) });
        svc.riverRecs.set(1, { points: pts([r, 0, r], [r, 0.01, r]), stride: 12, segCellStart: Int32Array.from([0, 2]), segCells: Int32Array.from([16 * 20, 16 * 21]) });
        svc.version++;
        gpu.update(svc, cam, 0);
        expect(gpu.isRiverDrawn(0)).toBe(true);
        expect(gpu.isRiverDrawn(1)).toBe(false);
        gpu.takeChangedCells();
        // The camera moves over river 1 (> 2 km): layout again, river 0 leaves.
        gpu.update(svc, { x: 200000 * r, y: 0, z: 200000 * r }, 0);
        expect(gpu.isRiverDrawn(1)).toBe(true);
        expect(gpu.isRiverDrawn(0)).toBe(false);
        const changed = gpu.takeChangedCells();
        expect([...changed].sort((a, b) => a - b)).toEqual([7, 8, 20, 21]);
    });

    it('narrow streams are listed only within their draw radius; crossing it regenerates nothing', () => {
        const dev = stubDevice();
        const gpu = new WaterGpuData(dev, { gridN: 4, planetRadius: 131072, maxMaskLayers: 2, maxRiverSegs: 8 });
        const svc = fakeService();
        svc.rivers.push({ id: 1, fromLake: 1, cells: Int32Array.from([]) });
        gpu.update(svc, cam, 0);
        // Half-width 4 m (a mountain lake's stream), 45 degrees from the camera.
        const pts = (a, b) => { const P = new Float32Array(24); P.set([...a, 100, 4, 1, 0.5, 3, 101, 0, 0, 0], 0); P.set([...b, 99, 4, 1, 0.5, 3, 100, 0, 0, 0], 12); return P; };
        const r = Math.SQRT1_2;
        svc.riverRecs.set(0, { points: pts([r, 0, r], [r, 0.01, r]), stride: 12, segCellStart: Int32Array.from([0, 2]), segCells: Int32Array.from([16 * 20, 16 * 21]) });
        svc.version++;
        gpu.update(svc, cam, 0);
        expect(gpu.isRiverDrawn(0)).toBe(false);
        gpu.takeChangedCells();
        // Over it: listed, without regenerating its cells; and away again.
        gpu.update(svc, { x: 200000 * r, y: 0, z: 200000 * r }, 0);
        expect(gpu.isRiverDrawn(0)).toBe(true);
        expect(gpu.takeChangedCells()).toBe(null);
        // Away again: it leaves at the next layout (here a new river's), and
        // only the new river's cells change.
        const wide = pts([0, 0, 1], [0, 0.01, 1]).map((v, i) => (i % 12 === 4 ? 15 : v));
        svc.riverRecs.set(1, { points: wide, stride: 12, segCellStart: Int32Array.from([0, 2]), segCells: Int32Array.from([16 * 7, 16 * 8]) });
        svc.version++;
        gpu.update(svc, cam, 0);
        expect(gpu.isRiverDrawn(0)).toBe(false);
        expect(gpu.isRiverDrawn(1)).toBe(true);
        expect([...gpu.takeChangedCells()].sort((a, b) => a - b)).toEqual([7, 8]);
    });

    it('lakesNear: lakes with a mask layer whose patch comes within range, nearest first', () => {
        const gpu = new WaterGpuData(stubDevice(), { gridN: 4, planetRadius: 131072, maxMaskLayers: 2 });
        const svc = fakeService();
        gpu.update(svc, cam, 0);
        const frame = (x0) => ({ c: [0, 0, 1], e1: [1, 0, 0], e2: [0, 1, 0], x0, y0: -64, spacing: 16, nx: 8, ny: 8 });
        const refine = (id, x0, cells) => svc.refined.set(id, { level: 100, frame: frame(x0), mask: new Uint8Array(64).fill(2), maskCells: Int32Array.from(cells), merged: [] });
        refine(0, 200, [1, 2]);    // patch 200 m off to the side
        refine(2, -64, [50]);      // patch under the camera
        svc.version++;
        gpu.update(svc, cam, 0);
        const eye = { x: 0, y: 0, z: 131072 + 130 };   // 30 m above the level
        expect(gpu.lakesNear(eye, 400)).toEqual([2, 0]);
        expect(gpu.lakesNear(eye, 150)).toEqual([2]);
        expect(gpu.lakesNear(eye, 400, 1)).toEqual([2]);
        gpu._layerOf.delete(2);    // gave its mask layer up: level-only, no mesh
        expect(gpu.lakesNear(eye, 400)).toEqual([0]);
    });

    it('a river traced beside a lake clears its shore band there (mask re-uploaded, lakeAt agrees)', () => {
        const dev = stubDevice();
        const gpu = new WaterGpuData(dev, { gridN: 4, planetRadius: 131072, maxMaskLayers: 2, carve: { bankW: 12, blendW: 30 } });
        const svc = fakeService();
        gpu.update(svc, cam, 0);
        // Lake 2 under (0, 0, 1): water in columns 0..3 (x < 0), band in 4 and 5.
        const mask = new Uint8Array(64);
        for (let j = 0; j < 8; j++) for (let i = 0; i < 6; i++) mask[j * 8 + i] = i < 4 ? 2 : 1;
        const frame = { c: [0, 0, 1], e1: [1, 0, 0], e2: [0, 1, 0], x0: -64, y0: -64, spacing: 16, nx: 8, ny: 8 };
        svc.refined.set(2, { level: 100, frame, mask, maskCells: Int32Array.from([50]), merged: [] });
        svc.version++;
        gpu.update(svc, cam, 0);
        const at = (xM) => gpu.lakeAt([xM / 131072, 0, 1].map((v, _, a) => v / Math.hypot(...a)))?.id ?? null;
        // lakeAt reads the index (cell of the direction): put lake 2 in the
        // cells either side of x = 0 (a cell boundary at this grid size).
        for (const xM of [-8, 8]) gpu._setSlot(dirToCell([xM / 131072, 0, 1], 4), 3);
        expect(at(8)).toBe(2);                         // band
        const uploads = dev.log.textures.length;
        // A river along x = 60 m on open land (pool 0).
        const P = new Float32Array(9 * 12);
        for (let k = 0; k < 9; k++) { const d = [60 / 131072, (-64 + 16 * k) / 131072, 1], l = Math.hypot(...d); P.set([d[0] / l, d[1] / l, d[2] / l, 100, 5, 2, 1, 0, 0, 0, 0, 0], k * 12); }
        svc.riverRecs.set(0, { points: P, stride: 12, segCellStart: Int32Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0]), segCells: new Int32Array(0) });
        svc.version++;
        gpu.update(svc, cam, 0);
        expect(dev.log.textures.length).toBe(uploads + 1);   // lake 2's layer again
        expect(at(8)).toBe(null);                      // band cleared beside the river
        expect(at(-8)).toBe(2);                        // water kept
    });

    it('near water: switch and fade distances go to the params', () => {
        const gpu = new WaterGpuData(stubDevice(), { gridN: 4, planetRadius: 131072 });
        const svc = fakeService();
        gpu.update(svc, cam, 0);
        expect([...new Float32Array(gpu.paramsData, 160, 4)]).toEqual([1000, 1600, 1, 0]);
        gpu.near.enabled = false;
        gpu.update(svc, cam, 0);
        expect([...new Float32Array(gpu.paramsData, 160, 4)]).toEqual([0, 0, 0, 0]);
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
