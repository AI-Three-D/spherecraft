// Experimental single-level, four-neighbour connectivity benchmark.
// No production imports or mutations. Input heights/levels/ownership must
// already have been classified into a binary wet mask; those costs are excluded.
const COMMON = `
struct Params { n: u32, seed: u32, spare0: u32, spare1: u32 }
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> wet: array<u32>;
const NONE: u32 = 0xffffffffu;
`;

const UNION = COMMON + `
@group(0) @binding(2) var<storage, read_write> parent: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> covered: array<u32>;
@group(0) @binding(4) var<storage, read_write> seedRoot: array<u32>;
var<workgroup> localParent: array<atomic<u32>, 256>;
fn localRoot(start: u32) -> u32 {
    var x = start;
    loop {
        let y = atomicLoad(&localParent[x]);
        if (y == x) { return x; }
        let z = atomicLoad(&localParent[y]);
        atomicMin(&localParent[x], z); x = y;
    }
}
fn localJoin(a0: u32, b0: u32) {
    loop {
        let a = localRoot(a0); let b = localRoot(b0);
        if (a == b) { return; }
        let lo = min(a,b); let hi = max(a,b);
        let changed = atomicCompareExchangeWeak(&localParent[hi], hi, lo);
        if (changed.exchanged) { return; }
    }
}
fn globalRoot(start: u32) -> u32 {
    var x = start;
    loop {
        let y = atomicLoad(&parent[x]);
        if (y == x || y == NONE) { return y; }
        let z = atomicLoad(&parent[y]);
        atomicMin(&parent[x], z); x = y;
    }
}
fn globalJoin(a0: u32, b0: u32) {
    loop {
        let a = globalRoot(a0); let b = globalRoot(b0);
        if (a == b || a == NONE || b == NONE) { return; }
        let lo = min(a,b); let hi = max(a,b);
        let changed = atomicCompareExchangeWeak(&parent[hi], hi, lo);
        if (changed.exchanged) { return; }
    }
}
@compute @workgroup_size(16,16)
fn localComponents(@builtin(global_invocation_id) g: vec3<u32>, @builtin(local_invocation_index) li: u32, @builtin(workgroup_id) block: vec3<u32>) {
    let valid = g.x < P.n && g.y < P.n;
    let k = min(g.y,P.n-1u)*P.n+min(g.x,P.n-1u);
    atomicStore(&localParent[li], select(NONE,li,valid && wet[k] != 0u));
    workgroupBarrier();
    if (valid && wet[k] != 0u) {
        if (li%16u < 15u && g.x+1u < P.n && atomicLoad(&localParent[li+1u]) != NONE) { localJoin(li,li+1u); }
        if (li/16u < 15u && g.y+1u < P.n && atomicLoad(&localParent[li+16u]) != NONE) { localJoin(li,li+16u); }
    }
    workgroupBarrier();
    if (valid) {
        var root = NONE;
        if (wet[k] != 0u) { let r=localRoot(li); root=(block.y*16u+r/16u)*P.n+block.x*16u+r%16u; }
        atomicStore(&parent[k],root);
    }
}
@compute @workgroup_size(16,16)
fn mergeBoundaries(@builtin(global_invocation_id) g: vec3<u32>) {
    if (g.x >= P.n || g.y >= P.n) { return; }
    let k=g.y*P.n+g.x;
    if (wet[k] == 0u) { return; }
    if (g.x%16u == 15u && g.x+1u < P.n && wet[k+1u] != 0u) { globalJoin(k,k+1u); }
    if (g.y%16u == 15u && g.y+1u < P.n && wet[k+P.n] != 0u) { globalJoin(k,k+P.n); }
}
@compute @workgroup_size(1)
fn markSeed() { seedRoot[0]=globalRoot(P.seed); }
@compute @workgroup_size(16,16)
fn resolveCoverage(@builtin(global_invocation_id) g: vec3<u32>) {
    if (g.x >= P.n || g.y >= P.n) { return; }
    let k=g.y*P.n+g.x;
    var value=0u;
    if (wet[k] != 0u) { value=select(0u,1u,globalRoot(k)==seedRoot[0] && seedRoot[0]!=NONE); }
    covered[k]=value;
}
`;

const DENSE = COMMON + `
@group(0) @binding(2) var<storage, read> before: array<u32>;
@group(0) @binding(3) var<storage, read_write> after: array<u32>;
@compute @workgroup_size(8,8)
fn step(@builtin(global_invocation_id) g: vec3<u32>) {
    if (g.x >= P.n || g.y >= P.n) { return; }
    let k=g.y*P.n+g.x;
    var value=before[k];
    if (wet[k] != 0u) {
        if (g.x > 0u) { value=max(value,before[k-1u]); }
        if (g.x+1u < P.n) { value=max(value,before[k+1u]); }
        if (g.y > 0u) { value=max(value,before[k-P.n]); }
        if (g.y+1u < P.n) { value=max(value,before[k+P.n]); }
    } else { value=0u; }
    after[k]=value;
}
`;

export async function createConnectivityBench(device) {
    const errors=[]; device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
    const timestamp=device.features.has('timestamp-query');
    const t0=performance.now();
    const unionModule=device.createShaderModule({label:'Water coverage research: blocked union-find',code:UNION});
    const denseModule=device.createShaderModule({label:'Water coverage research: dense flood',code:DENSE});
    const [local,merge,seed,resolve,dense]=await Promise.all([
        ...['localComponents','mergeBoundaries','markSeed','resolveCoverage'].map(entryPoint=>device.createComputePipelineAsync({layout:'auto',compute:{module:unionModule,entryPoint}})),
        device.createComputePipelineAsync({layout:'auto',compute:{module:denseModule,entryPoint:'step'}}),
    ]);
    const compileMs=performance.now()-t0;
    const make=(size,usage)=>device.createBuffer({size:Math.max(4,size),usage});
    const storageUsage=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC;
    const qs=timestamp?device.createQuerySet({type:'timestamp',count:8}):null;
    const qr=timestamp?make(64,GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC):null;
    const readTime=timestamp?make(64,GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST):null;
    async function execute(stages) {
        const wallStart=performance.now(), enc=device.createCommandEncoder();
        for (let i=0;i<stages.length;i++) {
            const s=stages[i], p=enc.beginComputePass(timestamp?{timestampWrites:{querySet:qs,beginningOfPassWriteIndex:i*2,endOfPassWriteIndex:i*2+1}}:{});
            p.setPipeline(s.pipeline);
            for (let j=0;j<(s.iterations??1);j++) { p.setBindGroup(0,Array.isArray(s.group)?s.group[j%2]:s.group); p.dispatchWorkgroups(s.x,s.y??1); }
            p.end();
        }
        if (timestamp) {enc.resolveQuerySet(qs,0,stages.length*2,qr,0);enc.copyBufferToBuffer(qr,0,readTime,0,stages.length*16);}
        const encodingMs=performance.now()-wallStart;
        device.queue.submit([enc.finish()]);await device.queue.onSubmittedWorkDone();
        const fenceWallMs=performance.now()-wallStart;
        let gpuMs=null,passes=[];
        if(timestamp){await readTime.mapAsync(GPUMapMode.READ);const t=new BigUint64Array(readTime.getMappedRange());passes=stages.map((s,i)=>({name:s.name,ms:Number(t[2*i+1]-t[2*i])/1e6}));gpuMs=passes.reduce((a,b)=>a+b.ms,0);readTime.unmap();}
        return {gpuMs,encodingMs,fenceWallMs,passes};
    }
    const group=(pipeline,uniform,input,buffers)=>device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:uniform}},{binding:1,resource:{buffer:input}},...buffers.map(([binding,buffer])=>({binding,resource:{buffer}}))]});
    async function job(mask,n,seedIndex,kind='union',iterations=64) {
        const bytes=n*n*4,uniform=make(16,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST),input=make(bytes,storageUsage),a=make(bytes,storageUsage),b=make(bytes,storageUsage),root=make(4,storageUsage);
        device.queue.writeBuffer(uniform,0,Uint32Array.of(n,seedIndex,0,0));device.queue.writeBuffer(input,0,mask);
        let stages;
        if(kind==='union'){
            stages=[
                {name:'localComponents',pipeline:local,group:group(local,uniform,input,[[2,a]]),x:Math.ceil(n/16),y:Math.ceil(n/16)},
                {name:'mergeBoundaries',pipeline:merge,group:group(merge,uniform,input,[[2,a]]),x:Math.ceil(n/16),y:Math.ceil(n/16)},
                {name:'markSeed',pipeline:seed,group:device.createBindGroup({layout:seed.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:uniform}},{binding:2,resource:{buffer:a}},{binding:4,resource:{buffer:root}}]}),x:1},
                {name:'resolveCoverage',pipeline:resolve,group:group(resolve,uniform,input,[[2,a],[3,b],[4,root]]),x:Math.ceil(n/16),y:Math.ceil(n/16)},
            ];
        }else{
            const init=new Uint32Array(n*n);init[seedIndex]=mask[seedIndex]?1:0;device.queue.writeBuffer(a,0,init);
            stages=[{name:`dense-${iterations}-passes`,pipeline:dense,group:[group(dense,uniform,input,[[2,a],[3,b]]),group(dense,uniform,input,[[2,b],[3,a]])],iterations,x:Math.ceil(n/8),y:Math.ceil(n/8)}];
        }
        const buffer=kind==='union'||iterations%2?b:a;
        return {
            run:()=>execute(stages),
            async read(){const rb=make(bytes,GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST);const enc=device.createCommandEncoder();enc.copyBufferToBuffer(buffer,0,rb,0,bytes);device.queue.submit([enc.finish()]);await rb.mapAsync(GPUMapMode.READ);const result=new Uint32Array(rb.getMappedRange()).slice();rb.unmap();rb.destroy();return result;},
            input, covered:buffer, bytes:bytes*3+20,
            dispose(){[uniform,input,a,b,root].forEach(x=>x.destroy());},
        };
    }
    return {job,compileMs,timestamp,errors,dispose(){qs?.destroy();qr?.destroy();readTime?.destroy();}};
}

export function syntheticMask(n,kind='open') {
    const mask=new Uint32Array(n*n);
    for(let y=0;y<n;y++)for(let x=0;x<n;x++){
        let wet=true;
        if(kind==='snake')wet=y%2===0||x===((Math.floor(y/2)%2===0)?n-1:0);
        if(kind==='split')wet=x!==Math.floor(n/2);
        if(kind==='shore')wet=x<n*.7+Math.sin(y*.02)*n*.1 && !(x>n*.15&&x<n*.25&&y>n*.2&&y<n*.4);
        mask[y*n+x]=wet?1:0;
    }
    return mask;
}

export function summarize(samples) {
    const stats=k=>{const a=samples.map(x=>x[k]).filter(x=>x!=null).sort((a,b)=>a-b);return a.length?{median:a[Math.floor(a.length/2)],p95:a[Math.min(a.length-1,Math.ceil(a.length*.95)-1)],min:a[0],max:a.at(-1)}:null;};
    return {gpuMs:stats('gpuMs'),fenceWallMs:stats('fenceWallMs'),encodingMs:stats('encodingMs')};
}
