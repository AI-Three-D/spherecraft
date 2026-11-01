import { createWaterWgsl, WATER_BINDINGS } from './waterWgsl.js';

const normalize = v => { const n=Math.hypot(...v);return v.map(x=>x/n); };

async function bakeJunctionSamplesAsync(input) {
    if(typeof Worker==='undefined') {
        return (await import('./junctionFieldBake.js')).bakeJunctionSamples(input);
    }
    const worker=new Worker(new URL('./junctionFieldWorker.js',import.meta.url),{type:'module'});
    try {
        return await new Promise((resolve,reject)=>{
            worker.onmessage=({data})=>data.error?reject(new Error(data.error)):resolve(data.result);
            worker.onerror=e=>reject(new Error(e.message));
            worker.postMessage(input,[input.natural.buffer,input.oldBed.buffer,input.dirs.buffer,input.data.buffer]);
        });
    } finally {worker.terminate();}
}
// One-time sampling only. The resulting spatial field is independent of
// segment lists, ribbon tessellation and view-dependent ownership tests.
export async function buildJunctionField({ device, resources, sampler, radiusM,
    frame, lakeId, lakeBasin, basins=null,influenceSites=null,influenceCoreM=128,influenceFadeM=48,referenceLevelM,sampleNatural,sampleCarved,
    blendRadiusM=32, lakewardSign=-1, solveOptions={},yieldBetween=null,guideRowsPerBatch=16 }) {
    const {c,e1,e2,width,height,spacingM,x0,y0}=frame,n=width*height;
    const dirs=new Float32Array(n*4);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
        const px=x0+x*spacingM,py=y0+y*spacingM;
        dirs.set(normalize(c.map((v,j)=>v+(e1[j]*px+e2[j]*py)/radiusM)),(y*width+x)*4);
    }
    const natural=await sampleNatural(dirs),oldBed=await sampleCarved(dirs);
    if(!natural||!oldBed)throw new Error('Junction terrain samples unavailable');
    const terrain=new Float32Array(n*4);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
        const i=y*width+x,l=y*width+Math.max(0,x-1),r=y*width+Math.min(width-1,x+1);
        const d=Math.max(0,y-1)*width+x,u=Math.min(height-1,y+1)*width+x;
        const slope=Math.max(.02,Math.hypot((natural[r]-natural[l])/((r-l)*spacingM||1),
            (natural[u]-natural[d])/(((u-d)/width)*spacingM||1)));
        terrain.set([natural[i],oldBed[i],slope,0],4*i);
    }
    const input=new Float32Array(20);
    input.set([...c,radiusM,...e1,x0,...e2,y0,spacingM,width,height,lakeId+1,referenceLevelM,0,0,0]);
    const source=createJunctionGuideWgsl();
    const allocated=[];
    const buffer=(size,usage)=>{const b=device.createBuffer({size,usage});allocated.push(b);return b;};
    let data;
    try {
        const module=device.createShaderModule({label:'JunctionFieldGuides',code:source});
        const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'junctionGuideMain'}});
        const uniform=buffer(input.byteLength,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
        const terrainBuffer=buffer(terrain.byteLength,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST);
        const size=n*32,out=buffer(size,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC);
        const read=buffer(size,GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST);
        device.queue.writeBuffer(uniform,0,input);device.queue.writeBuffer(terrainBuffer,0,terrain);
        const group0=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
            {binding:0,resource:{buffer:uniform}},{binding:1,resource:{buffer:terrainBuffer}},{binding:2,resource:{buffer:out}},
        ]});
        const B=WATER_BINDINGS;
        const group1=device.createBindGroup({layout:pipeline.getBindGroupLayout(1),entries:[
            {binding:B.index,resource:{buffer:resources.index}},{binding:B.lakes,resource:{buffer:resources.lakes}},
            {binding:B.masks,resource:resources.masks},{binding:B.params,resource:{buffer:resources.params}},
            {binding:B.rivers,resource:{buffer:resources.rivers}},{binding:17,resource:sampler},
        ]});
        const rows=yieldBetween?Math.max(8,Math.floor(guideRowsPerBatch/8)*8):height;
        for(let row=0;row<height;row+=rows) {
            input[17]=row;device.queue.writeBuffer(uniform,0,input);
            const enc=device.createCommandEncoder(),pass=enc.beginComputePass();
            pass.setPipeline(pipeline);pass.setBindGroup(0,group0);pass.setBindGroup(1,group1);
            pass.dispatchWorkgroups(Math.ceil(width/8),Math.ceil(Math.min(rows,height-row)/8));pass.end();
            device.queue.submit([enc.finish()]);
            if(yieldBetween){await device.queue.onSubmittedWorkDone();await yieldBetween();}
        }
        const enc=device.createCommandEncoder();enc.copyBufferToBuffer(out,0,read,0,size);device.queue.submit([enc.finish()]);
        await read.mapAsync(GPUMapMode.READ);data=new Float32Array(read.getMappedRange().slice(0));read.unmap();
    } finally {allocated.forEach(b=>b.destroy());}
    const compact=record=>({frame:record.frame,mask:record.mask});
    const baked=await bakeJunctionSamplesAsync({frame,radiusM,natural,oldBed,dirs,data,
        lakeBasin:lakeBasin?compact(lakeBasin):null,
        basins:basins?.map(b=>({...b,record:compact(b.record)}))??null,
        referenceLevelM,lakewardSign,blendRadiusM,solveOptions,influenceSites,influenceCoreM,influenceFadeM});
    return {...baked,lakeId:basins?.length>1?-1:lakeId};
}

export function createJunctionGuideWgsl() {
    return createWaterWgsl({group:1})+`
struct JunctionU { c:vec3<f32>,R:f32,e1:vec3<f32>,x0:f32,e2:vec3<f32>,y0:f32,grid:vec4<f32>,reference:vec4<f32>, }
@group(0) @binding(0) var<uniform> J:JunctionU;
@group(0) @binding(1) var<storage,read> terrain:array<vec4<f32>>;
@group(0) @binding(2) var<storage,read_write> guide:array<vec4<f32>>;
@group(1) @binding(17) var junctionSampler:sampler;
@compute @workgroup_size(8,8)
fn junctionGuideMain(@builtin(global_invocation_id) gid:vec3<u32>) {
 let w=u32(J.grid.y);let h=u32(J.grid.z);let row=gid.y+u32(J.reference.y);if(gid.x>=w||row>=h){return;}
 let i=row*w+gid.x;let xy=vec2<f32>(J.x0,J.y0)+vec2<f32>(vec2<u32>(gid.x,row))*J.grid.x;
 let dir=normalize(J.c+(J.e1*xy.x+J.e2*xy.y)/J.R);
 let q=waterRiverNearest(dir);
 var eta=J.reference.x;var depth=1.0;var halfWidth=1.0;var riverD=-1000.0;var riverKnown=0.0;
 if(q.z>q.y) {
  let p=waterRiverPointAt(q.x,q.y,q.z,dir,false);
  // Only an ordinary channel enters the solve. The old flared mouth and
  // its cap are not input geometry for this representation.
  if(p.d<p.hw+110.0) {
   eta=p.wl;halfWidth=p.hw;depth=max(p.wl-p.bed,clamp(p.hw*.25,1.25,3.0));riverD=p.hw*.8-p.d;riverKnown=1.0;
  }
 }
 let lk=waterLakeHitIn(u32(J.grid.w),dir,-1.0e30,junctionSampler,true,false);
 var lakeD=-1000.0;var lakeEta=J.reference.x;var lakeSeed=0.0;
 if(lk.level>WATER_NO_LAKE) {
  lakeEta=lk.level;
  // The terrain waterline, bounded by the actual basin mask, defines the
  // lake domain. An expanded render-mask fan cannot dictate this shoreline.
  lakeD=min(lk.insideM,(lk.level-terrain[i].x)/terrain[i].z);
  if(lk.insideM>4.0&&terrain[i].x<lk.level-.05){lakeSeed=1.0;}
 }
 guide[2u*i]=vec4<f32>(eta,depth,riverD,lakeEta);
 guide[2u*i+1u]=vec4<f32>(lakeD,riverKnown,halfWidth,lakeSeed);
}`;
}
