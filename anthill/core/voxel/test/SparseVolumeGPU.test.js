import test from 'node:test';
import assert from 'node:assert/strict';
import { CapturedHeightfield } from '../CapturedHeightfield.js';
import { VoxelVolume } from '../VoxelVolume.js';
import { SparseVolumeGPU } from '../SparseVolumeGPU.js';
import { fakeDevice } from './fakeDevice.js';

function scene(chunkSize = 5) {
    const surface = new CapturedHeightfield({
        frame: { origin: { x: 0, y: 131072.337, z: 0 }, up: { x: 0, y: 1, z: 0 }, heading: { x: 1, y: 0, z: 0 } },
        corner: { x: 0, z: 0 }, spacing: 1, countX: 9, countZ: 9, heights: new Float32Array(81).fill(4),
    });
    const volume = new VoxelVolume({ surface, minY: -4, maxY: 8, voxelSize: 0.25, chunkSize });
    const device = fakeDevice();
    const gpu = new SparseVolumeGPU(volume, device);
    return { volume, device, gpu };
}

// Decode the actual uploaded bytes using the shader's addressing (including odd chunk sizes).
function verify({ volume: v, gpu }) {
    const map = new Uint32Array(gpu.chunkMap.data.buffer);
    const words = new Uint32Array(gpu.density.data.buffer);
    const columns = new Float32Array(gpu.columns.data.buffer);
    const N = v.chunkSize;
    for (let k = 0; k < v.countZ; k++) for (let j = 0; j < v.countY; j++) for (let i = 0; i < v.countX; i++) {
        const cx = Math.floor(i / N), cy = Math.floor(j / N), cz = Math.floor(k / N);
        const slot = map[(cz * v.chunksY + cy) * v.chunksX + cx];
        let q;
        if (!slot) q = Math.max(-127, Math.min(127, Math.floor((columns[k * v.countX + i] - j) * 127 / v.densityRange + 0.5)));
        else {
            const index = ((k % N) * N + (j % N)) * N + (i % N);
            q = ((words[(slot - 1) * gpu.wordsPerChunk + (index >>> 2)] >>> ((index & 3) * 8)) & 255) - 128;
        }
        assert.equal(q, v.quantized(i, j, k), `lattice ${i},${j},${k}`);
        const maximum = new Float32Array(gpu.chunkMaxima.data.buffer)[(Math.floor(k/gpu.boundsSize)*gpu.boundsY+Math.floor(j/gpu.boundsSize))*gpu.boundsX+Math.floor(i/gpu.boundsSize)];
        assert.ok(maximum >= q, `maximum bounds lattice ${i},${j},${k}`);
        assert.ok(gpu.coarseMaxima[(cz*v.chunksY+cy)*v.chunksX+cx]>=q, `coarse maximum bounds lattice ${i},${j},${k}`);
        for(const [n,nx,ny,data] of [[gpu.boundsSize,gpu.boundsX,gpu.boundsY,gpu.maxima],[N,v.chunksX,v.chunksY,gpu.coarseMaxima]]) {
            for(let z=Math.floor(Math.max(0,k-1)/n);z<=Math.floor(k/n);z++)
                for(let y=Math.floor(Math.max(0,j-1)/n);y<=Math.floor(j/n);y++)
                    for(let x=Math.floor(Math.max(0,i-1)/n);x<=Math.floor(i/n);x++)
                        assert.ok(data[(z*ny+y)*nx+x]>=q,`interpolation halo at ${i},${j},${k}, size ${n}`);
        }
    }
}

test('GPU mirror matches every density sample, including baseline, edits and chunk borders', () => {
    const s = scene();
    verify(s);
    s.volume.apply({ shape: { type: 'sphere', center: [4, 0, 4], radius: 1.5 } });
    s.gpu.sync();
    verify(s);
    const before = s.gpu.density;
    s.volume.apply({ shape: { type: 'capsule', a: [1, 0, 1], b: [7, -2, 7], radius: 1 } });
    s.gpu.sync();
    verify(s);
    if (before !== s.gpu.density) assert.ok(before.destroyed);
    s.volume.apply({ mode: 'fill', shape: { type: 'sphere', center: [4, 0, 4], radius: 0.5 } });
    s.gpu.sync();
    verify(s);
    const count = s.device.writes.length;
    assert.equal(s.gpu.sync(), false);
    assert.equal(s.device.writes.length, count);
    s.gpu.dispose();
    assert.ok(s.device.buffers.every(buffer => buffer.destroyed));
});


test('maxima follow carvings and above-surface fills without uploading unchanged bounds', () => {
    const s = scene(), {volume:v,gpu,device} = s;
    const index = (cx,cy,cz) => (cz*v.chunksY+cy)*v.chunksX+cx;
    assert.ok(gpu.maxima[index(2,7,2)] <= 0); // baseline air, just above y=4
    v.apply({mode:'fill',shape:{type:'sphere',center:[3,6,3],radius:0.8}});
    gpu.sync();
    assert.ok(gpu.maxima[index(2,7,2)] > 0);
    verify(s);
    v.apply({mode:'carve',shape:{type:'sphere',center:[3,6,3],radius:2}});
    gpu.sync();
    assert.ok(gpu.maxima[index(2,7,2)] <= 0);
    verify(s);
    const writes = device.writes.length;
    gpu.sync();
    assert.equal(device.writes.length,writes);
    const boundWrites = device.writes.filter(w=>w.buffer===gpu.chunkMaxima);
    assert.ok(boundWrites.slice(1).every(w=>w.bytes<gpu.maxima.byteLength));
    gpu.dispose();
});

test('one-sample halos prevent skipping rock across interpolation chunk borders', () => {
    const {volume:v,gpu} = scene();
    // Fill begins at x=2.5, the first lattice sample in chunk x=2.
    v.apply({mode:'fill',shape:{type:'sphere',center:[2.75,6,3],radius:0.5}});
    gpu.sync();
    assert.ok(v.sample(2.49,6,3) > 0); // trilinear rock extends into chunk x=1
    assert.ok(gpu.maxima[(2*v.chunksY+7)*v.chunksX+1]>0);
    v.apply({shape:{type:'sphere',center:[2.75,6,3],radius:1}});
    gpu.sync();
    assert.ok(gpu.maxima[(2*v.chunksY+7)*v.chunksX+1]<=0);
    gpu.dispose();
});

test('buffer growth preserves old density and uploads only newly changed chunks and map ranges', () => {
    const {volume:v,gpu,device} = scene(8);
    v.apply({shape:{type:'sphere',center:[2,0,2],radius:0.5}});
    gpu.sync();
    const resident=gpu.slots.size, old=gpu.density, writes=device.writes.length;
    // Fail if a local sync attempts to visit the whole volume's chunk table.
    v.forEachChunk=()=>{throw Error('full volume scan');};
    v.apply({mode:'fill',shape:{type:'sphere',center:[6,6,6],radius:0.6}});
    gpu.sync();
    assert.ok(gpu.slots.size>resident);
    const densityWrites=device.writes.slice(writes).filter(w=>w.buffer===gpu.density);
    assert.equal(densityWrites.length,gpu.changedChunks.length);
    assert.ok(device.writes.slice(writes).filter(w=>w.buffer===gpu.chunkMap).every(w=>w.bytes<gpu.map.byteLength));
    if (gpu.density!==old) {
        const copy=device.copies.find(c=>c.source===old);
        assert.equal(copy.size,resident*gpu.wordsPerChunk*4);
        assert.ok(old.destroyed);
    }
    verify({volume:v,gpu});
    gpu.dispose();
});

test('tight bounds skip an excavated block even when rock remains further into its neighbour', () => {
    const {volume:v,gpu}=scene(8);
    v.apply({shape:{type:'sphere',center:[3,1,3],radius:2.1}});
    gpu.sync();
    // Block x=1 covers [2,4] plus its interpolation endpoint. Its neighbour
    // includes x=5.75, which must not prevent skipping the cleared block.
    const cy=2,cz=1,index=(x)=>(cz*v.chunksY+cy)*v.chunksX+x;
    assert.ok(gpu.coarseMaxima[index(1)]<=0);
    assert.ok(gpu.coarseMaxima[index(2)]>0);
    gpu.dispose();
});

test('density growth uses a non-power-of-two device limit when all required chunks still fit', () => {
    const {volume:v,gpu,device}=scene(8);
    device.limits.maxStorageBufferBindingSize=3*gpu.wordsPerChunk*4;
    for(const x of [3,5,7]) {
        v.apply({shape:{type:'sphere',center:[x,1,3],radius:0.1}});
        gpu.sync();
    }
    assert.equal(gpu.slots.size,3);
    assert.equal(gpu.capacity,3);
    verify({volume:v,gpu});gpu.dispose();
});


test('fine bounds remain conservative across edited sub-blocks and partial chunk edges', () => {
    const s = scene(32), {volume:v,gpu} = s;
    assert.equal(gpu.boundsSize,8);
    assert.deepEqual([gpu.boundsX,gpu.boundsY,gpu.boundsZ],[5,7,5]);
    verify(s);
    v.apply({mode:'fill',shape:{type:'sphere',center:[3.9,6,4],radius:1}});
    gpu.sync(); verify(s);
    v.apply({mode:'carve',shape:{type:'sphere',center:[3.9,6,4],radius:1.8}});
    gpu.sync(); verify(s);
    v.apply({mode:'fill',shape:{type:'sphere',center:[7,5.8,7],radius:0.6}});
    gpu.sync(); verify(s);
    gpu.dispose();
});
