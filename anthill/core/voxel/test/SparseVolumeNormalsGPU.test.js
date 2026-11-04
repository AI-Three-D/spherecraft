import test from 'node:test';
import assert from 'node:assert/strict';
import { SparseVolumeNormalsGPU } from '../SparseVolumeNormalsGPU.js';
import { SparseVolumeGPU } from '../SparseVolumeGPU.js';
import { CapturedHeightfield } from '../CapturedHeightfield.js';
import { VoxelVolume } from '../VoxelVolume.js';
import { fakeDevice } from './fakeDevice.js';

function scene(limit = 128*1024*1024) {
    const device = fakeDevice();
    device.limits.maxStorageBufferBindingSize = limit;
    const mirror = { device, volume:{chunkSize:4,densityRange:2,chunksX:8,chunksY:1,chunksZ:1,revision:1},
        slots:new Map([[0,{index:0,revision:1}],[1,{index:1,revision:1}],[3,{index:2,revision:1}]]),
        columns:device.createBuffer({size:4}),chunkMap:device.createBuffer({size:32}),density:device.createBuffer({size:4}) };
    const cache = new SparseVolumeNormalsGPU(mirror), passes = [];
    const encoder = { beginComputePass() {
        const pass = {};
        passes.push(pass);
        return {setPipeline(){},setBindGroup(_index,group){pass.group=group;},
            dispatchWorkgroups(x,y){pass.dispatch=[x,y];},end(){}};
    } };
    const compute = () => cache.compute(encoder,new Float32Array(16));
    return {device,mirror,cache,passes,compute};
}

test('smooth normals rebuild after edits, including unchanged neighbours, and do no work on ordinary frames', () => {
    const {device,mirror,cache,passes,compute} = scene();
    cache.sync();compute();
    assert.deepEqual(passes[0].dispatch,[8,3]);
    const writes = device.writes.length, buffer = cache.buffer;
    for (let frame=0; frame<5; frame++) { cache.sync();compute(); }
    assert.equal(passes.length,1);
    assert.equal(device.writes.length,writes);
    assert.equal(cache.buffer,buffer);
    mirror.volume.revision++;
    mirror.slots.get(0).revision++;
    cache.sync();
    assert.deepEqual([...cache.pending].sort(),[0,1]);
    compute();
    assert.deepEqual(passes[1].dispatch,[8,2]);
    const entries = new Uint32Array(cache.dirty.data.buffer);
    assert.deepEqual([...entries.slice(0,8)],[0,0,0,0,1,0,0,1]);
    cache.dispose();
    for (const resource of [mirror.columns,mirror.chunkMap,mirror.density]) resource.destroy();
    assert.ok(device.buffers.every(resource=>resource.destroyed));
});

test('growing the normal cache preserves old slots and rebuilds only changed chunks and neighbours', () => {
    const {device,mirror,cache,passes,compute} = scene();
    cache.sync();compute();
    const old = cache.buffer;
    old.data.fill(17);
    mirror.slots.set(4,{index:3,revision:2});mirror.slots.set(5,{index:4,revision:2});
    mirror.volume.revision++;
    mirror.density = device.createBuffer({size:8});
    cache.sync();compute();
    assert.equal(old.destroyed,true);
    assert.equal(cache.capacity,8);
    assert.deepEqual(passes.at(-1).dispatch,[8,3]);
    assert.equal(cache.buffer.data[0],17);
    assert.equal(device.copies.at(-1).source,old);
    const bound = binding=>passes.at(-1).group.entries.find(entry=>entry.binding===binding).resource.buffer;
    assert.equal(bound(7),mirror.density);
    assert.equal(bound(12),cache.buffer);
    cache.dispose();
});

test('the optional cache respects the storage binding limit and only builds slots that fit', () => {
    const limit = 8**3*4;
    const {cache,passes,compute} = scene(limit);
    cache.sync();compute();
    assert.equal(cache.capacity,1);
    assert.equal(cache.buffer.data.byteLength,limit);
    assert.deepEqual(passes[0].dispatch,[8,1]);
    cache.dispose();
});

test('normal invalidation follows the edited sample and gradient halos rather than entire neighbouring chunks', () => {
    const surface=new CapturedHeightfield({
        frame:{origin:{x:0,y:0,z:0},up:{x:0,y:1,z:0},heading:{x:1,y:0,z:0}},
        corner:{x:0,z:0},spacing:1,countX:33,countZ:17,heights:new Float32Array(33*17).fill(12),
    });
    const v=new VoxelVolume({surface,minY:0,maxY:16,voxelSize:0.25,chunkSize:32});
    for(const x of [4,12])v.apply({shape:{type:'sphere',center:[x,4,4],radius:0.5}});
    const mirror=new SparseVolumeGPU(v,fakeDevice()),cache=new SparseVolumeNormalsGPU(mirror);
    cache.sync();cache.pending.clear();
    v.apply({shape:{type:'sphere',center:[4,4,4],radius:0.7}});mirror.sync();cache.sync();
    assert.deepEqual([...cache.pending],[0],'a chunk-interior edit does not rebuild the adjacent resident chunk');
    cache.pending.clear();
    v.apply({shape:{type:'sphere',center:[7.75,4,4],radius:0.2}});mirror.sync();cache.sync();
    assert.ok(cache.pending.has(0)&&cache.pending.has(1),'a border edit rebuilds both halo owners');
    cache.dispose();mirror.dispose();
});

test('normal cache can be disabled or budgeted independently of the device storage limit', () => {
    const {mirror}=scene();
    const cache=new SparseVolumeNormalsGPU(mirror,{maxBytes:8**3*4});
    cache.sync();assert.equal(cache.capacity,1);cache.dispose();
    const disabled=new SparseVolumeNormalsGPU(mirror,{maxBytes:0});
    disabled.sync();assert.equal(disabled.capacity,0);disabled.dispose();
    assert.throws(()=>new SparseVolumeNormalsGPU(mirror,{maxBytes:-1}),RangeError);
});

test('a bounded cache follows the focus and maps late density slots into resident normal slots', () => {
    const {mirror}=scene();
    Object.assign(mirror.volume,{voxelSize:1,minX:0,minY:0,minZ:0});
    const cache=new SparseVolumeNormalsGPU(mirror,{maxBytes:8**3*4});
    cache.sync({x:2,y:2,z:2});
    assert.deepEqual([...cache.residents.keys()],[0]);
    assert.deepEqual([...cache.slotMap.slice(0,3)],[1,0,0]);
    cache.pending.clear();
    const buffer=cache.buffer;
    cache.sync({x:14,y:2,z:2});
    assert.equal(cache.buffer,buffer,'moving reuses the bounded allocation');
    assert.deepEqual([...cache.residents.keys()],[3]);
    assert.deepEqual([...cache.slotMap.slice(0,3)],[0,0,1]);
    assert.deepEqual([...cache.pending],[3]);
    cache.pending.clear();
    cache.sync({x:15,y:2,z:2});
    assert.equal(cache.pending.size,0,'sub-chunk movement does not rebuild normals');
    mirror.previousRevision=mirror.volume.revision;
    mirror.volume.revision++;
    for(let index=4;index<8;index++)mirror.slots.set(index,{index:index-1,revision:1});
    mirror.changedChunks=[4,5,6,7];mirror.changedNormalChunks=[];
    cache.sync({x:15,y:2,z:2});
    assert.ok(cache.slotMap.length>=mirror.slots.size,'remote slots get in-range fallback entries');
    assert.equal(cache.slotMap[6],0);
    cache.dispose();
});
