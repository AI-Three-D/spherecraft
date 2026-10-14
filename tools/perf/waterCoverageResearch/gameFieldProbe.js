// Cost probe using real loaded terrain textures and existing water queries.
// The existing queries still contain the reviewed coverage defects: this is
// a representative candidate-evaluation cost, not a correct new water solve.
export async function probeGameField(widths=[1024,3200]) {
 const g=window.gameEngine,device=g.renderer.backend.device,tm=g.renderer.quadtreeTileManager,streamer=tm.tileStreamer,water=g.waterGpuData;
 const {createWaterWgsl,WATER_BINDINGS:B}=await import('/core/world/water/waterWgsl.js');
 const {dirToFaceUV}=await import('/core/world/hydrology/waterGraph.js');
 const {createConnectivityBench,summarize}=await import('/tools/perf/waterCoverageResearch/gpuConnectivity.js');
 const saved={update:g.update,render:g.render};g.update=()=>{};g.render=()=>{};await device.queue.onSubmittedWorkDone();
 const R=g.planetConfig.radius,maxH=g.planetConfig.maxTerrainHeight,c=g.camera.position,o=g.planetConfig.origin;
 const normal=a=>{const l=Math.hypot(...a);return a.map(x=>x/l);},cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
 const up=normal([c.x-o.x,c.y-o.y,c.z-o.z]),east=normal(cross(up,Math.abs(up[1])<.9?[0,1,0]:[1,0,0])),north=cross(up,east),depth=tm.quadtreeGPU.maxDepth,D=2**depth;
 const shader=createWaterWgsl({group:1})+`
 struct Window { c: vec4<f32>, e1: vec4<f32>, e2: vec4<f32>, info: vec4<f32>, rect: vec4<u32>, source: vec4<f32> }
 @group(0) @binding(0) var<uniform> W: Window;
 @group(0) @binding(1) var heightSource: texture_2d_array<f32>;
 @group(0) @binding(2) var<storage,read> directory: array<vec4<u32>>;
 @group(0) @binding(3) var<storage,read_write> heightField: array<f32>;
 @group(0) @binding(4) var<storage,read_write> levelField: array<f32>;
 @group(0) @binding(5) var<storage,read_write> wetField: array<u32>;
 @group(1) @binding(17) var fieldSampler: sampler;
 fn windowDir(g: vec3<u32>) -> vec3<f32> {
  let p=(vec2<f32>(g.xy)+0.5-vec2<f32>(W.e1.w*0.5))*W.e2.w;
  return normalize(W.c.xyz+(W.e1.xyz*p.x+W.e2.xyz*p.y)/W.c.w);
 }
 fn faceUv(d: vec3<f32>) -> vec2<f32> {
  let f=u32(W.info.z);
  if(f==0u){return vec2<f32>(-d.z,d.y)/d.x*0.5+0.5;}
  if(f==1u){return vec2<f32>(d.z,d.y)/(-d.x)*0.5+0.5;}
  if(f==2u){return vec2<f32>(d.x,-d.z)/d.y*0.5+0.5;}
  if(f==3u){return vec2<f32>(d.x,d.z)/(-d.y)*0.5+0.5;}
  if(f==4u){return vec2<f32>(d.x,d.y)/d.z*0.5+0.5;}
  return vec2<f32>(-d.x,d.y)/(-d.z)*0.5+0.5;
 }
 fn finalHeight(d: vec3<f32>) -> f32 {
  let uv=faceUv(d);let tile=vec2<u32>(floor(uv*W.info.x));
  if(any(tile<W.rect.xy)||any(tile>=W.rect.xy+W.rect.zw)){return 1.0e30;}
  let ij=tile-W.rect.xy;let rec=directory[ij.y*W.rect.z+ij.x];
  if(rec.x==0xffffffffu){return 1.0e30;}
  // Production full-resolution vertex shader maps 128 segments onto 128 texels.
  let local=uv*exp2(f32(rec.y))-vec2<f32>(rec.zw);
  let p=clamp(local*W.source.x,vec2<f32>(0.0),vec2<f32>(W.source.x-1.0));
  let a=vec2<i32>(floor(p));let b=min(a+vec2<i32>(1),vec2<i32>(i32(W.source.x)-1));let t=fract(p);let layer=i32(rec.x);
  let h00=textureLoad(heightSource,a,layer,0).r;let h10=textureLoad(heightSource,vec2<i32>(b.x,a.y),layer,0).r;
  let h01=textureLoad(heightSource,vec2<i32>(a.x,b.y),layer,0).r;let h11=textureLoad(heightSource,b,layer,0).r;
  return mix(mix(h00,h10,t.x),mix(h01,h11,t.x),t.y)*W.info.y;
 }
 fn candidateLevel(d: vec3<f32>) -> f32 {
  let lake=waterLakeLevelView(d,-1.0e30,fieldSampler,false);
  let river=waterRiverAt(d,-1.0e30);
  return max(lake,select(WATER_NO_LAKE,river.etaM,river.near));
 }
 @compute @workgroup_size(8,8)
 fn gather(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n=u32(W.e1.w);if(gid.x>=n||gid.y>=n){return;}heightField[gid.y*n+gid.x]=finalHeight(windowDir(gid));
 }
 @compute @workgroup_size(8,8)
 fn levels(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n=u32(W.e1.w);if(gid.x>=n||gid.y>=n){return;}levelField[gid.y*n+gid.x]=candidateLevel(windowDir(gid));
 }
 @compute @workgroup_size(8,8)
 fn fused(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n=u32(W.e1.w);if(gid.x>=n||gid.y>=n){return;}let k=gid.y*n+gid.x;let d=windowDir(gid);
  let h=finalHeight(d);let l=candidateLevel(d);heightField[k]=h;levelField[k]=l;wetField[k]=select(0u,1u,h<l && l>WATER_NO_LAKE);
 }
 `;
 const started=performance.now(),module=device.createShaderModule({code:shader,label:'Water field research: production texture/query cost'});
 const pipelines=await Promise.all(['gather','levels','fused'].map(entryPoint=>device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint}})));
 const result={compileMs:performance.now()-started,scope:'real terrain gathering including resident-ancestor fallback; existing defective lake/river candidate queries; binary single-level connectivity; no mesh construction or new renderer',source:{tracedRivers:g.waterService.riverRecs.size,listedSegments:water.riverSegCount,refinedLakes:g.waterService.refined.size},cases:[]};
 const timestamp=device.features.has('timestamp-query'),qs=timestamp?device.createQuerySet({type:'timestamp',count:2}):null;
 const make=(size,usage)=>device.createBuffer({size,usage});
 const qr=timestamp?make(16,GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC):null,rb=timestamp?make(16,GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST):null;
 const resources=water.resources,sampler=device.createSampler({minFilter:'linear',magFilter:'linear'}),heightTexture=streamer.arrayPool.textures.get('height');
 const uniform=make(96,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
 const bench=await createConnectivityBench(device);
 const regenBefore=streamer.getRegenerationStats?.(),versionBefore=water._appliedVersion;
 try{
 for(const n of widths){
  const corners=[[-n/2,-n/2],[n/2,-n/2],[-n/2,n/2],[n/2,n/2]].map(([x,y])=>dirToFaceUV(normal(up.map((v,i)=>v+(east[i]*x+north[i]*y)/R))));
  if(new Set(corners.map(f=>f.face)).size!==1)throw new Error('Cost probe supports one cube face only');
  const minX=Math.max(0,Math.floor(Math.min(...corners.map(x=>x.u))*D)-1),minY=Math.max(0,Math.floor(Math.min(...corners.map(x=>x.v))*D)-1);
  const dx=Math.ceil(Math.max(...corners.map(x=>x.u))*D)+1-minX,dy=Math.ceil(Math.max(...corners.map(x=>x.v))*D)+1-minY;
  const dir=new Uint32Array(dx*dy*4);let unavailable=0,fine=0;
  for(let y=0;y<dy;y++)for(let x=0;x<dx;x++){
   let found=-1,layer=-1;for(let z=depth;z>=0;z--){layer=streamer.getLoadedLayer(corners[0].face,z,(minX+x)>>(depth-z),(minY+y)>>(depth-z));if(Number.isInteger(layer)&&layer>=0){found=z;break;}}
   if(found<0){dir[(y*dx+x)*4]=0xffffffff;unavailable++;}else{if(found===depth)fine++;dir.set([layer,found,(minX+x)>>(depth-found),(minY+y)>>(depth-found)],(y*dx+x)*4);}
  }
  const data=new Float32Array(24);data.set([...up,R,...east,n,...north,1,D,maxH,corners[0].face,0],0);
  new Uint32Array(data.buffer).set([minX,minY,dx,dy],16);data.set([streamer.tileTextureSize,0,0,0],20);device.queue.writeBuffer(uniform,0,data);
  const dirBuffer=make(dir.byteLength,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST);device.queue.writeBuffer(dirBuffer,0,dir);
  const usage=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST;
  const heights=make(n*n*4,usage),levels=make(n*n*4,usage),wet=make(n*n*4,usage);
  const globals=[{binding:0,resource:{buffer:uniform}},{binding:1,resource:heightTexture.createView({dimension:'2d-array'})},{binding:2,resource:{buffer:dirBuffer}},{binding:3,resource:{buffer:heights}},{binding:4,resource:{buffer:levels}},{binding:5,resource:{buffer:wet}}];
  const waterEntries=[{binding:B.index,resource:{buffer:resources.index}},{binding:B.lakes,resource:{buffer:resources.lakes}},{binding:B.masks,resource:resources.masks},{binding:B.params,resource:{buffer:resources.params}},{binding:B.rivers,resource:{buffer:resources.rivers}},{binding:17,resource:sampler}];
  const bind=(p,which)=>{
   const use=which==='gather'?[0,1,2,3]:which==='levels'?[0,4]:[0,1,2,3,4,5];
   return [device.createBindGroup({layout:p.getBindGroupLayout(0),entries:globals.filter(e=>use.includes(e.binding))}),which==='gather'?null:device.createBindGroup({layout:p.getBindGroupLayout(1),entries:waterEntries})];
  };
  const record={n,cells:n*n,directoryCells:dx*dy,unavailableDirectoryCells:unavailable,fineDirectoryCells:fine,fieldBuffersBytes:n*n*12+dir.byteLength,stages:[]};
  for(let pi=0;pi<3;pi++){
   const p=pipelines[pi],name=['gather','levels','fused'][pi],bg=bind(p,name);
   const run=async()=>{const t=performance.now(),enc=device.createCommandEncoder(),pass=enc.beginComputePass(timestamp?{timestampWrites:{querySet:qs,beginningOfPassWriteIndex:0,endOfPassWriteIndex:1}}:{});pass.setPipeline(p);pass.setBindGroup(0,bg[0]);if(bg[1])pass.setBindGroup(1,bg[1]);pass.dispatchWorkgroups(Math.ceil(n/8),Math.ceil(n/8));pass.end();if(timestamp){enc.resolveQuerySet(qs,0,2,qr,0);enc.copyBufferToBuffer(qr,0,rb,0,16);}const encodingMs=performance.now()-t;device.queue.submit([enc.finish()]);await device.queue.onSubmittedWorkDone();const fenceWallMs=performance.now()-t;let gpuMs=null;if(timestamp){await rb.mapAsync(GPUMapMode.READ);const a=new BigUint64Array(rb.getMappedRange());gpuMs=Number(a[1]-a[0])/1e6;rb.unmap();}return {gpuMs,fenceWallMs,encodingMs};};
   await run();await run();const samples=[];for(let i=0;i<7;i++)samples.push(await run());record.stages.push({name,...summarize(samples),samples});
  }
  // GPU-to-GPU transfer of classified mask into the experimental connectivity job.
  // Readback is exclusively for correctness checking and excluded from GPU cost.
  const checkRead=device.createBuffer({size:n*n*4,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST}),readEnc=device.createCommandEncoder();readEnc.copyBufferToBuffer(wet,0,checkRead,0,n*n*4);device.queue.submit([readEnc.finish()]);await checkRead.mapAsync(GPUMapMode.READ);const mask=new Uint32Array(checkRead.getMappedRange()).slice();checkRead.unmap();checkRead.destroy();
  const seedIndex=Math.max(0,mask.findIndex(x=>x!==0));record.wetCells=mask.reduce((a,b)=>a+b,0);
  const job=await bench.job(new Uint32Array(n*n),n,seedIndex),enc=device.createCommandEncoder();enc.copyBufferToBuffer(wet,0,job.input,0,n*n*4);device.queue.submit([enc.finish()]);await device.queue.onSubmittedWorkDone();
  await job.run();await job.run();const samples=[];for(let i=0;i<7;i++)samples.push(await job.run());record.connectivity={...summarize(samples),samples,bufferBytes:job.bytes};
  const actual=await job.read(),expected=new Uint8Array(n*n),queue=new Uint32Array(n*n);let head=0,tail=0;if(mask[seedIndex]){queue[tail++]=seedIndex;expected[seedIndex]=1;}
  const add=k=>{if(mask[k]&&!expected[k]){expected[k]=1;queue[tail++]=k;}};
  while(head<tail){const k=queue[head++],x=k%n,y=Math.floor(k/n);if(x>0)add(k-1);if(x+1<n)add(k+1);if(y>0)add(k-n);if(y+1<n)add(k+n);}
  let mismatch=0;for(let i=0;i<actual.length;i++)if(actual[i]!==expected[i])mismatch++;record.correctness={seedIndex,connectedCells:tail,mismatch};if(mismatch)throw new Error('Game field binary connectivity mismatch');
  job.dispose();[dirBuffer,heights,levels,wet].forEach(x=>x.destroy());result.cases.push(record);
 }
 result.regenerationBefore=regenBefore;result.regenerationAfter=streamer.getRegenerationStats?.();result.versionBefore=versionBefore;result.versionAfter=water._appliedVersion;result.errors=bench.errors;
 if(result.regenerationBefore.pending||result.regenerationAfter.pending||result.versionBefore!==result.versionAfter)throw new Error('Field source changed or had outstanding terrain regeneration during measurement');
 return result;
 }finally{bench.dispose();uniform.destroy();qs?.destroy();qr?.destroy();rb?.destroy();g.update=saved.update;g.render=saved.render;}
}
