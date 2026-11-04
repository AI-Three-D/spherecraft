import { volumeDeclarationsWGSL, volumeFunctionsWGSL } from './volumeShader.wgsl.js';
import { growStorageBuffer } from './growStorageBuffer.js';

export const normalDeclarationsWGSL = /* wgsl */ `
@group(0) @binding(12) var<storage,read> shadingNormals: array<u32>;
@group(0) @binding(14) var<storage,read> normalSlots: array<u32>;
`;
export const normalFunctionsWGSL = /* wgsl */ `
fn cachedNormal(index: u32) -> vec3<f32> {
    return unpack4x8snorm(shadingNormals[index]).xyz;
}
fn volumeShadingNormal(p: vec3<f32>) -> vec3<f32> {
    let g = clamp((p-volume.origin.xyz)/volume.origin.w,vec3<f32>(0),
        vec3<f32>(volume.counts.xyz-vec3<u32>(1)));
    let i = min(vec3<u32>(floor(g)),volume.counts.xyz-vec3<u32>(2));
    let n = volume.counts.w;
    let chunk = divideByBlock(i,n);
    let local = i-chunk*n;
    var owner = vec3<i32>(chunk);
    var slot = chunkMap[(chunk.z*volume.chunks.y+chunk.y)*volume.chunks.x+chunk.x];
    if (slot == 0u) {
        // Cached chunks include a gradient halo. An untouched interpolation cell
        // at an edit boundary can borrow the neighbouring edited chunk's normals.
        let first = -vec3<i32>(local == vec3<u32>(0));
        let last = vec3<i32>(local >= vec3<u32>(n-2u));
        for (var z = first.z; z <= last.z; z++) {
            for (var y = first.y; y <= last.y; y++) {
                for (var x = first.x; x <= last.x; x++) {
                    let candidate = vec3<i32>(chunk)+vec3<i32>(x,y,z);
                    if (any(candidate < vec3<i32>(0)) || any(candidate >= vec3<i32>(volume.chunks.xyz))) { continue; }
                    let index = (u32(candidate.z)*volume.chunks.y+u32(candidate.y))*volume.chunks.x+u32(candidate.x);
                    let candidateSlot = chunkMap[index];
                    if (candidateSlot != 0u) { owner = candidate; slot = candidateSlot; }
                }
            }
        }
    }
    if (slot == 0u) {
        // Smooth untouched heightfield directly, without density probes or a dense cache.
        let c = i.z*volume.counts.x+i.x;
        let a = columns[c]; let b = columns[c+1u];
        let d = columns[c+volume.counts.x]; let e = columns[c+volume.counts.x+1u];
        let t = g-vec3<f32>(i);
        return normalize(vec3<f32>(-mix(b-a,e-d,t.z),1.0,-mix(d-a,e-b,t.x)));
    }
    let side = n+4u;
    let perChunk = side*side*side;
    let normalSlot = normalSlots[slot-1u];
    if (normalSlot == 0u) {
        // Keep rendering if the optional cache reaches the device's binding limit.
        let gradient = volumeFilteredGradient(p);
        return -gradient/max(length(gradient),0.00001);
    }
    let j = vec3<u32>(vec3<i32>(i)-owner*i32(n)+vec3<i32>(2));
    let base = (normalSlot-1u)*perChunk+(j.z*side+j.y)*side+j.x;
    let t = g-vec3<f32>(i);
    let a = mix(cachedNormal(base),cachedNormal(base+1u),t.x);
    let b = mix(cachedNormal(base+side),cachedNormal(base+side+1u),t.x);
    let c = mix(cachedNormal(base+side*side),cachedNormal(base+side*side+1u),t.x);
    let d = mix(cachedNormal(base+side*side+side),cachedNormal(base+side*side+side+1u),t.x);
    let normal = mix(mix(a,b,t.y),mix(c,d,t.y),t.z);
    return normal/max(length(normal),0.00001);
}
`;

const buildShader = /* wgsl */ `
struct View { cutSize: vec4<f32> }
@group(0) @binding(0) var<uniform> view: View;
${volumeDeclarationsWGSL}
${volumeFunctionsWGSL.split('// A bounded search')[0]}
@group(0) @binding(11) var<storage,read> dirtyChunks: array<vec4<u32>>;
@group(0) @binding(12) var<storage,read_write> normals: array<u32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let n = volume.counts.w;
    let side = n+4u;
    let perChunk = side*side*side;
    if (id.x >= perChunk) { return; }
    let entry = dirtyChunks[id.y];
    let local = vec3<u32>(id.x%side,(id.x/side)%side,id.x/(side*side));
    let p = vec3<i32>(entry.xyz*n)+vec3<i32>(local)-vec3<i32>(2);
    let end = vec3<i32>(volume.counts.xyz)-vec3<i32>(1);
    let lower = vec3<u32>(clamp(p-vec3<i32>(1),vec3<i32>(0),end));
    let upper = vec3<u32>(clamp(p+vec3<i32>(1),vec3<i32>(0),end));
    let q = vec3<u32>(clamp(p,vec3<i32>(0),end));
    let gradient = vec3<f32>(
        latticeDensity(vec3<u32>(upper.x,q.y,q.z))-latticeDensity(vec3<u32>(lower.x,q.y,q.z)),
        latticeDensity(vec3<u32>(q.x,upper.y,q.z))-latticeDensity(vec3<u32>(q.x,lower.y,q.z)),
        latticeDensity(vec3<u32>(q.x,q.y,upper.z))-latticeDensity(vec3<u32>(q.x,q.y,lower.z)));
    let normal = -gradient/max(length(gradient),0.00001);
    normals[entry.w*perChunk+id.x] = pack4x8snorm(vec4<f32>(normal,0));
}
`;

/** Bounded, camera-local cache of packed smooth normals for edited chunks.
 * Halos share global lattice gradients, including across untouched chunk borders.
 * Resident chunks survive camera motion. Distant chunks use the density fallback.
 */
export class SparseVolumeNormalsGPU {
    constructor(mirror, { maxBytes = 64*1024*1024 } = {}) {
        if (!Number.isFinite(maxBytes) || maxBytes < 0) throw new RangeError('Normal cache maxBytes must be nonnegative and finite');
        this.mirror = mirror;
        this.maxBytes = maxBytes;
        this.device = mirror.device;
        this.perChunk = (mirror.volume.chunkSize+4)**3;
        this.capacity = 0;
        this.revisions = new Map();
        this.revision = -1;
        this.pending = new Set();
        this.residents = new Map();
        this.freeSlots = [];
        this.slotMap = new Uint32Array(1);
        this.mapBuffer = this.device.createBuffer({label:'Voxel normal slot map',size:4,usage:128|8});
        this.buffer = this.device.createBuffer({label:'Voxel smooth normals',size:4,usage:128|8});
        this.params = this.device.createBuffer({size:16,usage:64|8});
        this.volume = this.device.createBuffer({size:64,usage:64|8});
        this.device.queue.writeBuffer(this.params,0,new Float32Array([0,0,mirror.volume.densityRange,0]));
        this.pipeline = this.device.createComputePipeline({layout:'auto',compute:{
            module:this.device.createShaderModule({code:buildShader}),entryPoint:'main'}});
    }

    _selectResidents(focus, grew) {
        const {mirror}=this,v=mirror.volume;
        const metres=v.chunkSize*v.voxelSize;
        const key=focus ? [focus.x,focus.y,focus.z].map(p=>Math.floor(p/metres)).join(',') : '';
        const moved=key!==this.focusKey;
        if (!grew && !moved && this.revision===v.revision) return;
        if(moved || !this.focus) this.focus=focus && {...focus};
        this.focusKey=key;
        const distance=index=>{
            if(!this.focus)return mirror.slots.get(index).index;
            const center=[index%v.chunksX,Math.floor(index/v.chunksX)%v.chunksY,Math.floor(index/(v.chunksX*v.chunksY))];
            return center.reduce((sum,c,axis)=>sum+((c+0.5)*metres+[v.minX,v.minY,v.minZ][axis]-[this.focus.x,this.focus.y,this.focus.z][axis])**2,0);
        };
        // Most edits touch existing residents or add remote chunks. Neither needs
        // a traversal/sort of the whole mine while the focus stays in this chunk.
        if (!grew && !moved && this.residents.size===this.capacity && this.revision===mirror.previousRevision
            && mirror.changedChunks?.every(index=>this.residents.has(index)||distance(index)>=this.cutoff)) return;
        const ranked=[...mirror.slots.keys()].map(index=>({index,distance:distance(index)}));
        ranked.sort((a,b)=>a.distance-b.distance||a.index-b.index);
        const desired=new Set(ranked.slice(0,this.capacity).map(c=>c.index));
        this.cutoff=ranked[Math.min(this.capacity,ranked.length)-1]?.distance??Infinity;
        let changed=false;
        for(const [index,slot] of this.residents) if(!desired.has(index)) {
            this.slotMap[mirror.slots.get(index).index]=0;
            this.freeSlots.push(slot);this.residents.delete(index);this.pending.delete(index);changed=true;
        }
        this.freeSlots.sort((a,b)=>b-a);
        for(const index of desired) if(!this.residents.has(index)) {
            const slot=this.freeSlots.pop();
            this.residents.set(index,slot);this.slotMap[mirror.slots.get(index).index]=slot+1;
            this.pending.add(index);changed=true;
        }
        if(changed)this.device.queue.writeBuffer(this.mapBuffer,0,this.slotMap);
    }

    sync(focus) {
        const {mirror} = this, v = mirror.volume;
        // Even remote, nonresident density slots need an explicit zero entry.
        // Never rely on out-of-range storage-buffer reads returning zero.
        if(this.slotMap.length<mirror.slots.size) {
            const next=new Uint32Array(2**Math.ceil(Math.log2(mirror.slots.size)));
            next.set(this.slotMap);this.slotMap=next;
            this.mapBuffer.destroy();
            this.mapBuffer=this.device.createBuffer({label:'Voxel normal slot map',size:next.byteLength,usage:128|8});
            this.device.queue.writeBuffer(this.mapBuffer,0,next);
        }
        const maxSlots = Math.floor(Math.min(this.maxBytes,this.device.limits.maxStorageBufferBindingSize)/(this.perChunk*4));
        const required = Math.min(mirror.slots.size,maxSlots);
        const grew = required > this.capacity;
        if (grew) {
            const oldCapacity = this.capacity;
            this.capacity = Math.min(2**Math.ceil(Math.log2(required)),maxSlots);
            this.buffer = growStorageBuffer(this.device,this.buffer,oldCapacity*this.perChunk*4,
                this.capacity*this.perChunk*4,'Voxel smooth normals');
            for(let slot=oldCapacity;slot<this.capacity;slot++)this.freeSlots.push(slot);
        }
        this._selectResidents(focus,grew);
        if (this.revision === v.revision) return;
        if (this.revision === mirror.previousRevision && mirror.changedNormalChunks) {
            for (const index of mirror.changedNormalChunks) if (this.residents.has(index)) this.pending.add(index);
            for (const index of mirror.changedChunks) this.revisions.set(index,mirror.slots.get(index).revision);
            this.revision=v.revision;
            return;
        }
        const reach = Math.ceil(3/v.chunkSize);
        // Fall back to all slots if this cache missed a mirror sync (or is new).
        const indices = this.revision === mirror.previousRevision ? mirror.changedChunks : mirror.slots.keys();
        for (const index of indices) {
            const slot = mirror.slots.get(index);
            if (this.revisions.get(index) === slot.revision) continue;
            const cx = index%v.chunksX, cy = Math.floor(index/v.chunksX)%v.chunksY;
            const cz = Math.floor(index/(v.chunksX*v.chunksY));
            for (let z = Math.max(0,cz-reach); z <= Math.min(v.chunksZ-1,cz+reach); z++)
                for (let y = Math.max(0,cy-reach); y <= Math.min(v.chunksY-1,cy+reach); y++)
                    for (let x = Math.max(0,cx-reach); x <= Math.min(v.chunksX-1,cx+reach); x++) {
                        const neighbour = (z*v.chunksY+y)*v.chunksX+x;
                        if (this.residents.has(neighbour)) this.pending.add(neighbour);
                    }
            this.revisions.set(index,slot.revision);
        }
        this.revision = v.revision;
    }

    compute(encoder, volumeData) {
        if (!this.pending.size) return;
        const {mirror} = this, v = mirror.volume, chunks = [];
        for (const index of this.pending) {
            const slot = this.residents.get(index);
            if (slot === undefined) continue;
            chunks.push(index%v.chunksX,Math.floor(index/v.chunksX)%v.chunksY,
                Math.floor(index/(v.chunksX*v.chunksY)),slot);
        }
        this.pending.clear();
        if (!chunks.length) return;
        const data = new Uint32Array(chunks);
        if (!this.dirty || this.dirtyCapacity < data.byteLength) {
            this.dirty?.destroy();
            this.dirty = this.device.createBuffer({label:'Voxel dirty normal chunks',size:data.byteLength,usage:128|8});
            this.dirtyCapacity = data.byteLength;
        }
        this.device.queue.writeBuffer(this.dirty,0,data);
        this.device.queue.writeBuffer(this.volume,0,volumeData);
        const group = this.device.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:
            [[0,this.params],[4,this.volume],[5,mirror.columns],[6,mirror.chunkMap],[7,mirror.density],
                [11,this.dirty],[12,this.buffer]].map(([binding,buffer])=>({binding,resource:{buffer}}))});
        const pass = encoder.beginComputePass({label:'Voxel edited surface normals'});
        pass.setPipeline(this.pipeline);pass.setBindGroup(0,group);
        pass.dispatchWorkgroups(Math.ceil(this.perChunk/64),chunks.length/4);pass.end();
    }

    dispose() {
        this.buffer.destroy();this.mapBuffer.destroy();this.params.destroy();this.volume.destroy();this.dirty?.destroy();
    }
}
