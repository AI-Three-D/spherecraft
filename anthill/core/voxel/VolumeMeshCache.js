import { selectMeshLOD } from './meshRemodel.js';

/** Local, revisioned, memory-bounded mesh maintenance. One worker job is in flight;
 * indexing, snapshots and uploads share a small, infrequent main-thread budget.
 * Density stays authoritative and edits immediately revoke all affected coverage.
 */
export class VolumeMeshCache {
    constructor(volume,device,{cells=16,maxBytes=64*1024*1024,budgetMs=0.35,quietMs=750,
        maintenanceIntervalMs=100,jobIntervalMs=150,maxUploadBytes=32*1024,
        pixelError=0.2,fadeMs=350,includeBaseline=false,workerFactory,now=()=>performance.now()}={}) {
        if(!Number.isInteger(cells)||cells<2||cells>64)throw new Error('Mesh cells must be an integer from 2 to 64');
        if(![maxBytes,budgetMs,quietMs,pixelError,fadeMs,maintenanceIntervalMs,jobIntervalMs,maxUploadBytes].every(Number.isFinite)
            ||maxBytes<32||budgetMs<0||quietMs<0||pixelError<=0||fadeMs<=0||maintenanceIntervalMs<0||jobIntervalMs<0
            ||!Number.isInteger(maxUploadBytes)||maxUploadBytes<4||maxUploadBytes%4)
            throw new Error('Invalid mesh cache budget, delay or error tolerance');
        this.volume=volume;this.device=device;this.cells=cells;this.maxBytes=maxBytes;
        this.budgetMs=budgetMs;this.quietMs=quietMs;this.pixelError=pixelError;this.fadeMs=fadeMs;this.now=now;
        this.includeBaseline=includeBaseline;
        this.maintenanceIntervalMs=maintenanceIntervalMs;this.jobIntervalMs=jobIntervalMs;this.maxUploadBytes=maxUploadBytes;
        this.counts=[volume.countX,volume.countY,volume.countZ].map(n=>Math.ceil((n-1)/cells));
        this.records=new Map();this.revision=0;this.bytes=0;this.disposed=false;
        this.residents=new Set();this.queue=[];
        this.coverage=new Map();
        this.stats={completed:0,discarded:0,resident:0,eligible:0,triangles:0,fullTriangles:0,bytes:0,
            workerMs:0,maxWorkerMs:0,maintenanceMs:0,maxMaintenanceMs:0,ticks:0,submitted:0,deferred:0,error:null};
        this.unsubscribe=volume.subscribe(edit=>this.invalidate(edit));
        this.indexer=this._index();
        try {
            this.worker=workerFactory?workerFactory():typeof Worker==='undefined'?null:
                new Worker(new URL('./meshWorker.js',import.meta.url),{type:'module',name:'Anthill mesh remodeling'});
            if(this.worker) {
                this.worker.onmessage=event=>this._result(event.data);
                this.worker.onerror=event=>this._fail(event.message??'Mesh worker failed');
            }
        } catch(error) {this._fail(String(error));}
    }

    _id(c) {return (c[2]*this.counts[1]+c[1])*this.counts[0]+c[0];}
    _record(c) {
        if(c.some((x,i)=>x<0||x>=this.counts[i])) return null;
        const id=this._id(c);
        let r=this.records.get(id);
        if(!r) {
            const v=this.volume,min=[v.minX,v.minY,v.minZ];
            const size=c.map((x,i)=>Math.min(this.cells,[v.countX,v.countY,v.countZ][i]-1-x*this.cells));
            r={id,c:[...c],size,origin:c.map((x,i)=>min[i]+x*this.cells*v.voxelSize),generation:0,
                dirtyAt:-Infinity,stages:null,bytes:0,fade:0,priority:Infinity};
            this.records.set(id,r);
            r.center=r.origin.map((x,c)=>x+r.size[c]*v.voxelSize*.5);
            r.extent=r.size.map(x=>x*v.voxelSize*.5);r.radius=Math.hypot(...r.extent);
            if(this.view) {r.priority=this._priority(r,this.view);this._enqueue(r);}
        }
        return r;
    }

    *_index() {
        const v=this.volume,N=this.cells;
        // Walk the sparse table in bounded steps. Filtering/sorting the entire
        // mine before the first yield defeats the maintenance budget on load.
        for(let i=0;i<v._chunks.length;i++) {
            const chunk=v._chunks[i];
            if(chunk) {
                this._affected({min:[chunk.cx,chunk.cy,chunk.cz].map(x=>x*v.chunkSize),
                    max:[chunk.cx,chunk.cy,chunk.cz].map(x=>(x+1)*v.chunkSize-1)},()=>{});
            }
            if(chunk||i%64===63) yield;
        }
        // Untouched heightfield rays already have a cheap analytic skip. Spend
        // the default rebuilding budget on edited terrain and its shared borders.
        if(!this.includeBaseline)return;
        // Scan each column tile once. Include the quantized surface's half-sample
        // uncertainty, rather than guessing surfaces from just four tile corners.
        for(let z=0;z<this.counts[2];z++)for(let x=0;x<this.counts[0];x++) {
            let lo=Infinity,hi=-Infinity;
            for(let k=z*N;k<=Math.min((z+1)*N,v.countZ-1);k++) for(let i=x*N;i<=Math.min((x+1)*N,v.countX-1);i++) {
                const h=v._columns[k*v.countX+i];lo=Math.min(lo,h);hi=Math.max(hi,h);
            }
            for(let y=Math.floor((lo-0.5)/N);y<=Math.floor((hi+0.5)/N);y++) this._record([x,y,z]);
            yield;
        }
    }

    _affected({min,max},visit) {
        const low=min.map(x=>Math.floor((x-1)/this.cells)),high=max.map(x=>Math.floor(x/this.cells));
        for(let z=low[2];z<=high[2];z++) for(let y=low[1];y<=high[1];y++) for(let x=low[0];x<=high[0];x++) {
            const r=this._record([x,y,z]);if(r) visit(r);
        }
    }

    invalidate(edit) {
        const now=this.now();
        this._affected(edit,r=>{
            r.generation++;r.dirtyAt=now;r.fade=0;r.ready=false;
            r.minMpp=0;
            this._coverage(r,0);this._release(r);
            if(this.upload?.record===r) {this._disposeUpload();}
            this._enqueue(r);
        });
        // A synchronous edit hook can run while update is copying a snapshot,
        // after the frame's draw list was assembled. Revoke that list as well.
        if(this.draws) this.draws=this.draws.filter(r=>r.stages);
        this.revision++;
    }

    _release(r) {
        this.drawDirty=true;
        if(r.stages) for(const s of r.stages) {s.vertexBuffer.destroy();s.indexBuffer.destroy();}
        if(r.uniform) r.uniform.destroy();
        this.bytes-=r.bytes;r.bytes=0;r.stages=null;r.uniform=null;r.bindGroup=null;
        this.residents.delete(r);
    }
    _enqueue(r) {
        if(!r.queued&&!r.busy&&!r.ready&&!r.stages&&Number.isFinite(r.priority)&&r.mpp>=(r.minMpp??0)) {this.queue.push(r);r.queued=true;}
    }
    _coverage(r,value) {
        value=Math.fround(value);
        if((this.coverage.get(r.id)??0)!==value) {
            if(value) this.coverage.set(r.id,value);
            else this.coverage.delete(r.id);
            this.revision++;
        }
    }

    _priority(r,view) {
        const p=r.center,e=r.extent,m=view;
        for(let plane=0;plane<6;plane++) {
            const row=plane<4?plane>>1:2,sign=plane%2===0?1:-1,w=plane===4?0:1;
            const x=w*m[3]+sign*m[row],y=w*m[7]+sign*m[4+row],z=w*m[11]+sign*m[8+row],d=w*m[15]+sign*m[12+row];
            if(x*p[0]+y*p[1]+z*p[2]+d+Math.abs(x)*e[0]+Math.abs(y)*e[1]+Math.abs(z)*e[2]<0)return Infinity;
        }
        if(view[17]>0.5) {
            const d=p[0]*view[44]+p[1]*view[45]+p[2]*view[46]-view[47]
                -Math.abs(view[44])*e[0]-Math.abs(view[45])*e[1]-Math.abs(view[46])*e[2];
            if(d>1e-6) return Infinity;
        }
        const depth=(p[0]-view[28])*view[40]+(p[1]-view[29])*view[41]+(p[2]-view[30])*view[42]-r.radius;
        r.mpp=view[16]*(view[31]>0?Math.max(view[31],depth)*0.5:1);
        // The section's near side and screen centre get rebuilt first.
        const eyeDistance=Math.hypot(p[0]-view[28],p[1]-view[29],p[2]-view[30]);
        const x=m[0]*p[0]+m[4]*p[1]+m[8]*p[2]+m[12],y=m[1]*p[0]+m[5]*p[1]+m[9]*p[2]+m[13],w=m[3]*p[0]+m[7]*p[1]+m[11]*p[2]+m[15];
        return eyeDistance*(1+Math.hypot(x,y)/Math.max(1,Math.abs(w)));
    }

    update(view,{enabled=true,focus}={}) {
        const start=this.now(),deadline=start+this.budgetMs;
        const viewChanged=!this.view||!this.view.every((x,i)=>x===view[i]);
        if(viewChanged) {
            this.view=view.slice();
            if(this.scan) this.rescan=true;
            else this.scan=this.records.values();
            this.viewRevision=(this.viewRevision??0)+1;
        }
        this.focus=focus;
        let triangles=this.stats.triangles,fullTriangles=this.stats.fullTriangles;
        if(viewChanged||enabled!==this.enabled||this.drawDirty||this.fading) {
            this.enabled=enabled;this.drawDirty=false;this.fading=false;
            this.draws=[];triangles=0;fullTriangles=0;
            for(const r of this.residents) {
                if(r.viewRevision!==this.viewRevision){r.priority=this._priority(r,view);r.viewRevision=this.viewRevision;}
                if(!r.stages) continue;
                const lod=enabled&&Number.isFinite(r.priority)?selectMeshLOD(r.stages,r.mpp,this.pixelError):null;
                if(!lod) {r.fade=0;this._coverage(r,0);continue;}
                r.fade=Math.min(1,r.fade+Math.max(0,start-(this.previousTime??start))/this.fadeMs);
                if(r.fade<1)this.fading=true;
                this._coverage(r,r.fade);
                const stage=r.stages[lod.level];
                if(r.level!==lod.level||r.morph!==lod.morph) this.revision++;
                r.level=lod.level;r.morph=lod.morph;
                if(r.fade===0) continue;
                if(r.uniformMorph!==lod.morph||r.uniformFade!==r.fade) {
                    this.device.queue.writeBuffer(r.uniform,0,new Float32Array([lod.morph,r.fade,r.id,this.cells*this.volume.voxelSize,...r.origin,0]));
                    r.uniformMorph=lod.morph;r.uniformFade=r.fade;
                }
                this.draws.push(r);triangles+=stage.indexCount/3;fullTriangles+=r.fullTriangles;
            }
        }
        this.previousTime=start;
        // No synchronous meshing fallback: lack of Worker keeps density rendering.
        if(!enabled||!this.worker||this.disposed||this.budgetMs===0
            ||start-(this.lastMaintenance??-Infinity)<this.maintenanceIntervalMs) {
            const elapsed=this.now()-start;
            Object.assign(this.stats,{resident:this.residents.size,bytes:this.bytes,eligible:this.draws.length,triangles,fullTriangles,
                maintenanceMs:elapsed,maxMaintenanceMs:Math.max(this.stats.maxMaintenanceMs,elapsed)});
            return;
        }
        this.lastMaintenance=start;this.stats.ticks++;
        // Finish useful work before discovering more patches. Otherwise a large
        // existing mine can spend every tick indexing and starve its first upload.
        if(this.inflight?.samples) this._snapshot(deadline);
        if(this.upload) this._upload(deadline);
        // Reserve time for selection/snapshots while loading a large mine.
        const indexDeadline=Math.min(deadline,this.now()+this.budgetMs*.4);
        if(this.indexer) for(let i=0;i<32&&this.now()<indexDeadline;i++) {
            if(this.indexer.next().done){this.indexer=null;break;}
        }
        const scanDeadline=Math.min(deadline,this.now()+this.budgetMs*.25);
        if(this.scan) for(let i=0;i<64&&this.now()<scanDeadline;i++) {
            const next=this.scan.next();
            if(next.done){this.scan=this.rescan?this.records.values():null;this.rescan=false;break;}
            const r=next.value;r.priority=this._priority(r,view);this._enqueue(r);
        }
        if(!this.inflight&&!this.upload&&start-(this.lastJob??-Infinity)>=this.jobIntervalMs&&this.now()<deadline) {
            let index=-1,priority=Infinity;
            // Inspect a bounded rotating window, rather than searching the whole
            // mine on every frame. Invisible and quiet patches cannot starve
            // later entries, even during continuous camera movement.
            for(let n=0;n<Math.min(64,this.queue.length)&&this.now()<deadline;n++) {
                const i=(this.queueCursor??0)%this.queue.length;this.queueCursor=i+1;
                const r=this.queue[i];
                r.priority=this._priority(r,view);
                if(r.priority<priority&&!r.busy&&!r.ready&&r.mpp>=(r.minMpp??0)&&start-r.dirtyAt>=this.quietMs) {index=i;priority=r.priority;}
            }
            const r=index<0?null:this.queue[index];
            if(r) {
                // Unordered removal is constant time even for a huge mine.
                this.queue[index]=this.queue.at(-1);this.queue.pop();
                if(index<this.queueCursor)this.queueCursor=index;
                r.queued=false;r.priority=this._priority(r,view);
                if(Number.isFinite(r.priority)) {
                    r.busy=true;
                    const samples=new Int8Array(r.size.map(x=>x+1).reduce((a,b)=>a*b,1));
                    this.inflight={record:r,generation:r.generation,samples,row:0,min:127,max:-127};
                }
            }
        }
        if(this.inflight?.samples) this._snapshot(deadline);
        const elapsed=this.now()-start;
        Object.assign(this.stats,{resident:this.residents.size,eligible:this.draws.length,
            triangles,fullTriangles,bytes:this.bytes,maintenanceMs:elapsed,maxMaintenanceMs:Math.max(this.stats.maxMaintenanceMs,elapsed)});
    }

    _snapshot(deadline) {
        const job=this.inflight,r=job.record,v=this.volume,[nx,ny,nz]=r.size;
        if(job.generation!==r.generation) {this.inflight=null;r.busy=false;this._enqueue(r);this.stats.discarded++;return;}
        while(job.row<(ny+1)*(nz+1)&&this.now()<deadline) {
            const j=job.row%(ny+1),k=Math.floor(job.row/(ny+1));
            for(let i=0;i<=nx;i++) {
                const value=v.quantized(r.c[0]*this.cells+i,r.c[1]*this.cells+j,r.c[2]*this.cells+k);
                job.samples[(k*(ny+1)+j)*(nx+1)+i]=value;
                job.min=Math.min(job.min,value);job.max=Math.max(job.max,value);
            }
            job.row++;
        }
        if(job.row===(ny+1)*(nz+1)) {
            if(job.min>0||job.max<=0) {r.ready=true;r.busy=false;this.inflight=null;return;}
            this.lastJob=this.now();this.stats.submitted++;
            this.worker.postMessage({id:r.id,generation:job.generation,snapshot:{samples:job.samples,size:r.size,origin:r.origin,spacing:v.voxelSize,maxError:r.mpp*this.pixelError,
                tolerances:[v.voxelSize*0.125,v.voxelSize*0.5,v.voxelSize*2]}},[job.samples.buffer]);
            job.samples=null;
        }
    }

    _result({id,generation,mesh,milliseconds,error}) {
        if(this.disposed) return;
        this.inflight=null;
        const record=this.records.get(id);
        if(!record||record.generation!==generation) {if(record){record.busy=false;this._enqueue(record);}this.stats.discarded++;return;}
        if(error) {this._fail(error);return;}
        this.stats.workerMs=milliseconds;this.stats.maxWorkerMs=Math.max(this.stats.maxWorkerMs,milliseconds);this.stats.completed++;
        if(mesh.deferred) {
            record.minMpp=mesh.baseError/this.pixelError;record.busy=false;this.stats.deferred++;
            // A camera change while the worker ran may already permit a retry.
            record.priority=this._priority(record,this.view);this._enqueue(record);return;
        }
        if(!mesh.triangles) {record.ready=true;record.busy=false;return;}
        const bytes=mesh.stages.reduce((s,x)=>s+x.vertices.byteLength+x.indices.byteLength,0)+32;
        if(bytes>this.maxBytes){record.ready=true;record.busy=false;return;}
        this.upload={record,generation,mesh,bytes,stages:[],stage:0,part:0,offset:0};
    }

    _upload(deadline) {
        const u=this.upload,r=u.record;
        if(r.generation!==u.generation){this._disposeUpload();return;}
        // Eviction only revokes coverage. The next trace immediately uses density.
        if(this.bytes+u.bytes>this.maxBytes) {
            const victims=[...this.residents].sort((a,b)=>b.priority-a.priority);
            const victim=victims[0];
            if(!victim||victim.priority<r.priority){this._disposeUpload();return;}
            this._coverage(victim,0);this._release(victim);victim.ready=false;victim.fade=0;
            this._enqueue(victim);
            this.draws=this.draws.filter(x=>x!==victim);
            return;
        }
        let uploaded=0;
        while(u.stage<u.mesh.stages.length&&this.now()<deadline&&uploaded<this.maxUploadBytes) {
            const source=u.mesh.stages[u.stage];
            let target=u.stages[u.stage];
            if(!target) {
                target={error:source.error,targetError:source.targetError,indexCount:source.indices.length,
                    vertexBuffer:this.device.createBuffer({label:'Voxel mesh vertices',size:Math.max(4,source.vertices.byteLength),usage:32|8}),
                    indexBuffer:this.device.createBuffer({label:'Voxel mesh indices',size:Math.max(4,source.indices.byteLength),usage:16|8})};
                u.stages.push(target);
            }
            const data=u.part===0?source.vertices:source.indices,buffer=u.part===0?target.vertexBuffer:target.indexBuffer;
            const length=Math.min(16*1024,data.byteLength-u.offset,this.maxUploadBytes-uploaded);
            if(length) this.device.queue.writeBuffer(buffer,u.offset,new Uint8Array(data.buffer,data.byteOffset+u.offset,length));
            u.offset+=length;uploaded+=length;
            if(u.offset===data.byteLength) {u.offset=0;if(++u.part===2){u.part=0;u.stage++;}}
        }
        if(u.stage===u.mesh.stages.length) {
            r.stages=u.stages;r.bytes=u.bytes;r.fullTriangles=u.mesh.triangles;r.ready=true;r.fade=0;
            r.busy=false;this.residents.add(r);
            r.uniform=this.device.createBuffer({label:'Voxel mesh morph',size:32,usage:64|8});
            r.uniformMorph=r.uniformFade=undefined;
            this.bytes+=r.bytes;this.upload=null;
            this.drawDirty=true;
        }
    }
    _disposeUpload() {
        if(!this.upload)return;
        for(const s of this.upload.stages){s.vertexBuffer.destroy();s.indexBuffer.destroy();}
        this.upload.record.busy=false;
        this.upload=null;
    }
    _fail(error) {
        this.stats.error=error;this.worker?.terminate();this.worker=null;this.inflight=null;this._disposeUpload();
    }
    dispose() {
        this.disposed=true;this.unsubscribe();this.worker?.terminate();this._disposeUpload();
        for(const r of this.records.values())this._release(r);
        this.coverage.clear();this.records.clear();
    }
}
