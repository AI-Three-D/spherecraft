import test from 'node:test';
import assert from 'node:assert/strict';
import { VolumeMeshCache } from '../VolumeMeshCache.js';
import { remodelMesh } from '../meshRemodel.js';
import { VoxelRegion } from '../VoxelRegion.js';
import { fakeDevice } from './fakeDevice.js';

function scene(options={}) {
    const region=new VoxelRegion({heightfield:{frame:{origin:{x:0,y:131072,z:0},up:{x:0,y:1,z:0},heading:{x:1,y:0,z:0}},
        corner:{x:0,z:0},spacing:1,countX:17,countZ:17,heights:new Float32Array(289).fill(5.1)},
        rock:{layers:[{color:[.5,.4,.3]}]},depth:8,voxelSize:.25});
    const worker={jobs:[],postMessage(data){this.jobs.push(data);},terminate(){this.terminated=true;}};
    const device=fakeDevice();let now=1000;
    const cache=new VolumeMeshCache(region.volume,device,{includeBaseline:true,maintenanceIntervalMs:0,jobIntervalMs:0,
        workerFactory:()=>worker,now:()=>now,...options});
    const view=new Float32Array(48);
    view.set([.05,0,0,0,0,.05,0,0,0,0,-.002,0,-.4,0,.5,1]);view[16]=.5;view.set([8,5,100,0],28);view.set([0,0,-1,1000],40);
    const update=()=>{now+=34;cache.update(view);};
    const finish=()=>{const job=worker.jobs.at(-1);worker.onmessage({data:{id:job.id,generation:job.generation,mesh:remodelMesh(job.snapshot),milliseconds:3}});return job;};
    return {region,worker,device,cache,view,update,finish};
}

test('worker snapshots are immutable, only local edits stale results, and borders invalidate both chunks',()=>{
    const {region,worker,cache,update,finish}=scene();
    for(let i=0;i<50&&!worker.jobs.length;i++)update();
    const job=worker.jobs[0],record=cache.records.get(job.id),snapshot=job.snapshot.samples.slice();
    const center=record.origin.map((x,c)=>x+record.size[c]*.125);
    region.apply({shape:{type:'sphere',center,radius:1}});
    assert.deepEqual(job.snapshot.samples,snapshot,'edits never mutate copied samples');
    finish();assert.equal(cache.stats.discarded,1);assert.ok(!cache.upload);
    const boundary=cache._record([1,2,1]),left=cache._record([0,2,1]);
    cache.invalidate({min:[16,34,20],max:[16,34,20]});
    assert.ok(boundary.generation>0);assert.ok(left.generation>0);
    assert.equal((cache.coverage.get(boundary.id)??0),0);assert.equal((cache.coverage.get(left.id)??0),0);
    cache.dispose();
});

test('publishing waits for complete uploads, shares one worker, survives unrelated digs, and disposes',()=>{
    const {worker,device,cache,update,finish}=scene();
    for(let i=0;i<50&&!worker.jobs.length;i++)update();
    update();update();assert.equal(worker.jobs.length,1);
    const job=worker.jobs[0],r=cache.records.get(job.id);
    cache.invalidate({min:[60,20,60],max:[61,21,61]});
    assert.equal(r.generation,job.generation,'unrelated digging does not cancel useful work');
    finish();assert.ok(cache.upload);assert.equal(r.stages,null);
    for(let i=0;i<20&&!r.stages;i++)update();
    assert.ok(r.stages);assert.ok(cache.bytes>0);
    for(let i=0;i<12;i++)update();
    assert.equal((cache.coverage.get(r.id)??0),1);
    const buffers=r.stages.flatMap(s=>[s.vertexBuffer,s.indexBuffer]);
    cache.invalidate({min:r.c.map(x=>x*16+1),max:r.c.map(x=>x*16+2)});
    assert.equal((cache.coverage.get(r.id)??0),0);assert.ok(buffers.every(b=>b.destroyed));
    update();
    assert.ok(!cache.draws.includes(r),'released mesh is absent from the next trace');
    cache.dispose();assert.ok(worker.terminated);assert.ok(device.buffers.every(b=>b.destroyed));
});

test('small budgets split snapshot copying across frames and reject mixed-revision snapshots',()=>{
    let ticks=0;
    const {cache,worker,update}=scene({budgetMs:.05,now:()=>ticks++*.01});
    for(let i=0;i<500&&!cache.inflight;i++)update();
    assert.ok(cache.inflight);assert.ok(cache.inflight.samples);
    const r=cache.inflight.record;
    cache.invalidate({min:r.c.map(x=>x*16+1),max:r.c.map(x=>x*16+1)});
    update();assert.equal(worker.jobs.length,0);
    assert.ok(!cache.inflight||cache.inflight.record!==r||cache.inflight.generation===r.generation,
        'the mixed-revision snapshot is discarded before another snapshot can start');
    assert.equal(cache.stats.discarded,1);
    cache.dispose();
});

test('worker failure and disabled LOD retain a functioning density fallback',()=>{
    const {cache,worker,update,view}=scene();
    update();worker.onerror({message:'test failure'});update();
    assert.equal(cache.stats.error,'test failure');assert.equal(cache.worker,null);
    assert.equal(cache.coverage.size,0);
    cache.update(view,{enabled:false});assert.deepEqual(cache.draws,[]);
    cache.dispose();
});

test('perspective LOD measures conservative distance to each patch, retaining more detail nearby',()=>{
    const {cache,view}=scene();
    const r=cache._record([1,2,1]);
    view[31]=.1;view[16]=.002;view[28]=r.center[0];view[29]=r.center[1];
    view[30]=r.center[2]+r.radius+10;
    cache._priority(r,view);const near=r.mpp;
    view[30]=r.center[2]+r.radius+100;
    cache._priority(r,view);const far=r.mpp;
    assert.ok(Math.abs(near-.01)<1e-6);assert.ok(Math.abs(far-.1)<1e-6);
    cache.dispose();
});

test('geometry residency stays inside its byte budget and late worker results cannot revive disposed resources',()=>{
    const {cache,worker,device,update,finish}=scene({cells:8,maxBytes:65000});
    let finished=0,late;
    for(let i=0;i<180;i++) {
        update();
        if(worker.jobs.length>finished){late=worker.jobs.at(-1);finish();finished=worker.jobs.length;}
        assert.ok(cache.bytes<=cache.maxBytes);
    }
    assert.ok(finished>1);
    assert.ok(device.buffers.some(b=>b.label==='Voxel mesh vertices'&&b.destroyed),'old geometry is evicted');
    cache.dispose();
    const count=device.buffers.length;
    if(late)worker.onmessage({data:{...late,mesh:remodelMesh(late.snapshot)}});
    assert.equal(device.buffers.length,count);assert.ok(device.buffers.every(b=>b.destroyed));
});

test('an edit after draw-list selection removes released geometry from the current frame',()=>{
    const {cache,worker,update,finish}=scene();
    for(let i=0;i<50&&!worker.jobs.length;i++)update();
    const r=cache.records.get(finish().id);
    for(let i=0;i<20&&!r.stages;i++)update();
    for(let i=0;i<12;i++)update();
    assert.ok(cache.draws.includes(r));
    cache.invalidate({min:r.c.map(x=>x*cache.cells+1),max:r.c.map(x=>x*cache.cells+1)});
    assert.equal(r.stages,null);
    assert.ok(!cache.draws.includes(r),'the next compute pass cannot use destroyed buffers');
    cache.dispose();
});

test('large sparse volumes allocate no dense mesh map and indexing yields after a small table segment',()=>{
    let reads=0;
    const volume={countX:8193,countY:8193,countZ:8193,voxelSize:.25,chunkSize:32,
        _chunks:new Proxy({length:1000000},{get(target,key){if(key==='length')return target.length;reads++;return null;}}),
        subscribe(){return()=>{};}};
    const device=fakeDevice(),cache=new VolumeMeshCache(volume,device,{workerFactory:()=>null});
    assert.equal(device.buffers.length,0,'geometry metadata does not scale with the entire volume grid');
    assert.equal(cache.indexer.next().done,false);
    assert.ok(reads<=64,'indexing can yield even while visiting empty table entries');
    cache.dispose();
});

test('continuous camera motion does not restart the pending-patch scan before later records are visited',()=>{
    const {cache,view,update}=scene({cells:2,includeBaseline:false});
    let last;
    for(let z=0;z<8;z++)for(let y=0;y<4;y++)for(let x=0;x<8;x++)last=cache._record([x,y,z]);
    assert.equal(last.priority,Infinity);
    for(let i=0;i<8;i++){view[12]+=.0001;update();}
    assert.ok(Number.isFinite(last.priority),'later visible patches are eventually considered while the camera moves');
    cache.dispose();
});

test('maintenance ticks, worker starts and GPU uploads have separate small batch limits',()=>{
    const {cache,worker,device,update,finish}=scene({maintenanceIntervalMs:100,jobIntervalMs:500,maxUploadBytes:4096});
    update();const ticks=cache.stats.ticks;
    update();update();assert.equal(cache.stats.ticks,ticks,'ordinary frames do no queued maintenance');
    for(let i=0;i<100&&!worker.jobs.length;i++)update();
    assert.equal(worker.jobs.length,1);const sent=cache.lastJob;
    finish();
    for(let i=0;i<100&&cache.upload;i++) {
        const first=device.writes.length;update();
        const bytes=device.writes.slice(first).filter(w=>w.buffer.label!=='Voxel mesh morph').reduce((s,w)=>s+w.bytes,0);
        assert.ok(bytes<=4096,'an upload tick cannot exceed its byte allowance');
        if(cache.now()-sent<500)assert.equal(worker.jobs.length,1,'worker starts are spaced apart');
    }
    cache.dispose();
});

test('repeated local edits postpone rebuilding until the patch has been quiet for 750 ms',()=>{
    const {cache,worker,update}=scene({includeBaseline:false});cache.indexer=null;
    const r=cache._record([1,3,1]),edit={min:r.c.map(x=>x*cache.cells+1),max:r.c.map(x=>x*cache.cells+1)};
    cache.invalidate(edit);
    for(let i=0;i<21;i++)update();
    assert.equal(worker.jobs.length,0);
    cache.invalidate(edit);
    for(let i=0;i<21;i++)update();
    assert.equal(worker.jobs.length,0,'each local edit restarts the quiet interval');
    for(let i=0;i<3;i++)update();
    assert.equal(worker.jobs.length,1,'a settled patch eventually rebuilds');
    cache.dispose();
});

test('fast worker completion does not bypass the delay between submissions',()=>{
    const {cache,worker,update}=scene({jobIntervalMs:500});
    for(let i=0;i<100&&!worker.jobs.length;i++)update();
    const job=worker.jobs[0];
    worker.onmessage({data:{id:job.id,generation:job.generation,milliseconds:.1,mesh:{triangles:0,stages:[]}}});
    for(let i=0;i<14;i++)update();
    assert.equal(worker.jobs.length,1,'a free worker cannot run another patch before 500 ms');
    update();assert.equal(worker.jobs.length,2,'remaining patches resume once the interval expires');
    cache.dispose();
});

test('initial discovery cannot starve an upload already in progress',()=>{
    let ticks=0;
    const {cache,worker,update,finish}=scene({budgetMs:.2,now:()=>ticks++*.001});
    for(let i=0;i<500&&!worker.jobs.length;i++)update();
    assert.equal(worker.jobs.length,1);finish();
    const r=cache.upload.record;
    cache.indexer={next(){ticks+=1000;return {done:false};}};
    for(let i=0;i<200&&!r.stages;i++)update();
    assert.ok(r.stages,'upload completes even while discovery always consumes its slice');
    cache.dispose();
});

test('ineligible worker results wait for a useful zoom change or local edit before retrying',()=>{
    const {cache,worker,view,update}=scene();
    for(let i=0;i<100&&!worker.jobs.length;i++)update();
    const job=worker.jobs[0],r=cache.records.get(job.id);
    worker.onmessage({data:{id:job.id,generation:job.generation,milliseconds:.1,
        mesh:{deferred:true,baseError:1,triangles:0,stages:[]}}});
    assert.equal(r.minMpp,5);assert.ok(!r.ready);assert.equal(r.queued,false);assert.equal(cache.upload,undefined);
    for(let i=0;i<20;i++)update();
    assert.ok(!worker.jobs.slice(1).some(j=>j.id===r.id),'the same rejected view never rebuilds this patch');
    view[16]=8;
    for(let i=0;i<20&&!r.queued;i++)update();
    assert.ok(r.queued,'zooming out makes the patch eligible for a future rebuild');
    cache.invalidate({min:r.c.map(x=>x*cache.cells+1),max:r.c.map(x=>x*cache.cells+1)});
    assert.equal(r.minMpp,0,'editing clears the previous surface error bound');
    cache.dispose();
});

test('pending selection visits a bounded rotating window even with a huge invisible queue',()=>{
    const {cache,view,update}=scene({includeBaseline:false,cells:2});
    // Isolate scheduling from initial indexing and view scanning.
    cache.indexer=null;cache.view=view.slice();cache.scan=null;
    cache._snapshot=()=>{};
    let visible;
    for(let z=0;z<8;z++)for(let y=0;y<4;y++)for(let x=0;x<8;x++)visible=cache._record([x,y,z]);
    const priority=cache._priority.bind(cache);let visits=0;
    cache._priority=(r,v)=>{visits++;return r===visible?priority(r,v):Infinity;};
    // Enqueue records before applying the synthetic visibility test.
    cache.queue=[...cache.records.values()];for(const r of cache.queue)r.queued=true;
    for(let i=0;i<4&&!cache.inflight;i++) {
        visits=0;update();assert.ok(visits<=65,'selection does not walk the whole queue');
    }
    assert.equal(cache.inflight?.record,visible,'later visible work cannot starve behind invisible entries');
    cache.dispose();
});
