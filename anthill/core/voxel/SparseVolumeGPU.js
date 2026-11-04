import { growStorageBuffer } from './growStorageBuffer.js';

/** GPU mirror of the full 3D volume: procedural columns plus packed, edited chunks.
 * No density is generated for untouched chunks. Existing slots survive edits and plane turns.
 * Owns its buffers; the region and CPU arrays remain application-owned.
 */
export class SparseVolumeGPU {
    constructor(volume, device) {
        this.volume = volume;
        this.device = device;
        this.slots = new Map();
        this.capacity = 0;
        this.revision = -1;
        this.wordsPerChunk = Math.ceil(volume.chunkSize ** 3 / 4);
        this.map = new Uint32Array(volume.totalChunks);
        this.dirtyChunks = new Set();
        this.dirtyFine = new Set();
        this.dirtyCoarse = new Set();
        this.dirtyNormals = new Set();
        this.changedChunks = [];
        const columns = volume.copySurfaceColumns();
        this.columns = this._buffer('Voxel surface columns', columns);
        // Component-wise Lipschitz bounds of the untouched bilinear height field.
        // Columns are in voxel units, so adjacent differences are metres/metre.
        this.surfaceSlopeX=0;this.surfaceSlopeZ=0;
        for(let z=0;z<volume.countZ;z++)for(let x=0;x<volume.countX;x++) {
            const i=z*volume.countX+x;
            if(x+1<volume.countX)this.surfaceSlopeX=Math.max(this.surfaceSlopeX,Math.abs(columns[i+1]-columns[i]));
            if(z+1<volume.countZ)this.surfaceSlopeZ=Math.max(this.surfaceSlopeZ,Math.abs(columns[i+volume.countX]-columns[i]));
        }
        // Each bound includes the block's positive one-sample interpolation halo.
        // Traversal needs one bound, rather than the maxima of eight entire blocks.
        // Use smaller acceleration blocks than edit chunks. Large edit chunks
        // would force fine ray steps through a thick band of air above the hill.
        this.boundsSize = volume.chunkSize % 8 === 0 ? 8 : volume.chunkSize;
        const dimensions = n => [volume.countX,volume.countY,volume.countZ].map(c=>Math.ceil(c/n));
        let dims = dimensions(this.boundsSize);
        if (dims[0]*dims[1]*dims[2]*4 > Math.min(32*1024*1024,device.limits.maxStorageBufferBindingSize)) {
            this.boundsSize = volume.chunkSize;
            dims = dimensions(this.boundsSize);
        }
        [this.boundsX,this.boundsY,this.boundsZ] = dims;
        this.maxima = this._baselineMaxima(columns);
        this.chunkMaxima = this._buffer('Voxel fine density maxima', this.maxima);
        this.coarseMaxima = this._baselineMaxima(columns,volume.chunkSize,volume.chunksX,volume.chunksY,volume.chunksZ);
        this.coarseBounds = this._buffer('Voxel coarse density maxima',this.coarseMaxima);
        this.chunkMap = this._buffer('Voxel chunk map', this.map);
        this.density = null;
        volume.forEachChunk(chunk => {
            this.dirtyChunks.add((chunk.cz*volume.chunksY+chunk.cy)*volume.chunksX+chunk.cx);
            const min = [chunk.cx,chunk.cy,chunk.cz].map(c=>c*volume.chunkSize);
            this._markBounds(min,min.map(c=>c+volume.chunkSize-1));
        });
        this.unsubscribe = volume.subscribe(edit => {
            const n = volume.chunkSize;
            for (let z = Math.floor(edit.min[2]/n); z <= Math.floor(edit.max[2]/n); z++)
                for (let y = Math.floor(edit.min[1]/n); y <= Math.floor(edit.max[1]/n); y++)
                    for (let x = Math.floor(edit.min[0]/n); x <= Math.floor(edit.max[0]/n); x++)
                        this.dirtyChunks.add((z*volume.chunksY+y)*volume.chunksX+x);
            this._markBounds(edit.min,edit.max);
        });
        this.sync();
    }

    _baselineMaxima(columns, n = this.boundsSize, nx = this.boundsX, ny = this.boundsY, nz = this.boundsZ) {
        const v = this.volume;
        const out = new Float32Array(nx*ny*nz);
        for (let cz = 0; cz < nz; cz++) for (let cx = 0; cx < nx; cx++) {
            let highest = -Infinity;
            for (let z = cz*n; z < Math.min((cz+1)*n+1,v.countZ); z++)
                for (let x = cx*n; x < Math.min((cx+1)*n+1,v.countX); x++)
                    highest = Math.max(highest, columns[z*v.countX+x]);
            // One code of slack covers f32 baseline rounding in WGSL, including halos.
            for (let cy = 0; cy < ny; cy++) {
                out[(cz*ny+cy)*nx+cx] = Math.max(-127,
                    Math.min(127,Math.floor((highest-cy*n)*(127/v.densityRange)+0.5)+1));
            }
        }
        return out;
    }

    _markBounds(min, max) {
        const v=this.volume,n=v.chunkSize;
        // Two cached halo samples plus the central-gradient stencil's neighbour.
        for(let z=Math.max(0,Math.floor((min[2]-3)/n));z<=Math.min(v.chunksZ-1,Math.floor((max[2]+3)/n));z++)
            for(let y=Math.max(0,Math.floor((min[1]-3)/n));y<=Math.min(v.chunksY-1,Math.floor((max[1]+3)/n));y++)
                for(let x=Math.max(0,Math.floor((min[0]-3)/n));x<=Math.min(v.chunksX-1,Math.floor((max[0]+3)/n));x++)
                    this.dirtyNormals.add((z*v.chunksY+y)*v.chunksX+x);
        for (const [n,nx,ny,nz,dirty] of [
            [this.boundsSize,this.boundsX,this.boundsY,this.boundsZ,this.dirtyFine],
            [this.volume.chunkSize,this.volume.chunksX,this.volume.chunksY,this.volume.chunksZ,this.dirtyCoarse],
        ]) {
            // A changed boundary sample also belongs to the preceding block's halo.
            for (let z=Math.max(0,Math.floor((min[2]-1)/n));z<=Math.min(nz-1,Math.floor(max[2]/n));z++)
                for (let y=Math.max(0,Math.floor((min[1]-1)/n));y<=Math.min(ny-1,Math.floor(max[1]/n));y++)
                    for (let x=Math.max(0,Math.floor((min[0]-1)/n));x<=Math.min(nx-1,Math.floor(max[0]/n));x++)
                        dirty.add((z*ny+y)*nx+x);
        }
    }

    _refreshBounds(data, buffer, dirty, n, nx, ny) {
        const v = this.volume;
        const changed = [];
        for (const index of dirty) {
            const bx=index%nx, by=Math.floor(index/nx)%ny, bz=Math.floor(index/(nx*ny));
            let maximum=-127;
            scan: for (let z=bz*n;z<Math.min((bz+1)*n+1,v.countZ);z++)
                for (let y=by*n;y<Math.min((by+1)*n+1,v.countY);y++)
                    for (let x=bx*n;x<Math.min((bx+1)*n+1,v.countX);x++) {
                        maximum=Math.max(maximum,v.quantized(x,y,z));
                        if (maximum>=126) break scan;
                    }
            // Cover f32 rounding of any procedural samples in the halo.
            maximum=Math.min(127,maximum+1);
            if (data[index]!==maximum) { data[index]=maximum;changed.push(index); }
        }
        this._uploadRanges(buffer,data,changed);
        dirty.clear();
    }

    _uploadRanges(buffer, data, indices) {
        indices.sort((a,b)=>a-b);
        for (let i=0;i<indices.length;) {
            const start=indices[i++];
            let end=start+1;
            while (i<indices.length && indices[i]===end) { end++;i++; }
            this.device.queue.writeBuffer(buffer,start*4,data.subarray(start,end));
        }
    }

    _buffer(label, data) {
        // STORAGE | COPY_DST; numeric flags also let this packer be tested under node.
        const buffer = this.device.createBuffer({ label, size: Math.max(4, data.byteLength), usage: 128 | 8 });
        this.device.queue.writeBuffer(buffer, 0, data);
        return buffer;
    }

    sync() {
        const v = this.volume;
        if (this.revision === v.revision) return false;
        const required = Math.max(1, v.allocatedChunks);
        if (required > this.capacity) {
            const maxCapacity = Math.floor(this.device.limits.maxStorageBufferBindingSize/(this.wordsPerChunk*4));
            if (required>maxCapacity) throw new RangeError('Voxel GPU edits exceed storage buffer limit');
            const capacity = Math.min(2 ** Math.ceil(Math.log2(required)),maxCapacity);
            const size = capacity * this.wordsPerChunk * 4;
            this.density = growStorageBuffer(this.device,this.density,this.slots.size*this.wordsPerChunk*4,size,'Voxel edited density');
            this.capacity = capacity;
        }
        const mapChanged = [];
        this.changedChunks = [];
        for (const index of this.dirtyChunks) {
            const chunk = v.chunkAt(index%v.chunksX,Math.floor(index/v.chunksX)%v.chunksY,Math.floor(index/(v.chunksX*v.chunksY)));
            if (!chunk) continue;
            let slot = this.slots.get(index);
            if (!slot) {
                slot = { index: this.slots.size, revision: -1 };
                this.slots.set(index, slot);
                this.map[index] = slot.index + 1; // zero means procedural baseline
                mapChanged.push(index);
            }
            if (slot.revision === chunk.revision) continue;
            const packed = new Uint32Array(this.wordsPerChunk);
            for (let i = 0; i < chunk.density.length; i++) {
                packed[i >>> 2] |= (chunk.density[i] + 128) << ((i & 3) * 8);
            }
            this.device.queue.writeBuffer(this.density, slot.index * this.wordsPerChunk * 4, packed);
            slot.revision = chunk.revision;
            this.changedChunks.push(index);
        }
        this.dirtyChunks.clear();
        this._uploadRanges(this.chunkMap,this.map,mapChanged);
        this._refreshBounds(this.maxima,this.chunkMaxima,this.dirtyFine,this.boundsSize,this.boundsX,this.boundsY);
        this._refreshBounds(this.coarseMaxima,this.coarseBounds,this.dirtyCoarse,v.chunkSize,v.chunksX,v.chunksY);
        this.previousRevision = this.revision;
        this.changedNormalChunks = [...this.dirtyNormals];
        this.dirtyNormals.clear();
        this.revision = v.revision;
        return true;
    }

    dispose() {
        this.unsubscribe();
        this.columns.destroy();
        this.chunkMaxima.destroy();
        this.coarseBounds.destroy();
        this.chunkMap.destroy();
        this.density.destroy();
    }
}
