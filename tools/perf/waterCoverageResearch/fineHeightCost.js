// Generate transient finest-level height tiles with the production generator.
// Nothing is installed in terrain residency, and existing tiles are not regenerated.
export async function probeFineHeightCost() {
 const g=window.gameEngine,tm=g.renderer.quadtreeTileManager,s=tm.tileStreamer,d=g.renderer.backend.device;
 const {TileGenerator}=await import('/core/world/quadtree/tileGenerator.js'),{TileAddress}=await import('/core/world/quadtree/tileAddress.js'),{dirToFaceUV}=await import('/core/world/hydrology/waterGraph.js');
 const o=g.planetConfig.origin,c=g.camera.position,rel=[c.x-o.x,c.y-o.y,c.z-o.z],l=Math.hypot(...rel),f=dirToFaceUV(rel.map(x=>x/l)),depth=tm.quadtreeGPU.maxDepth,D=2**depth,x=Math.floor(f.u*D),y=Math.floor(f.v*D);
 const gen=new TileGenerator(g.terrainGenerator,{textureSize:s.tileTextureSize,requiredTypes:['height'],textureFormats:s.textureFormats,quadtreeMaxDepth:depth,maxGeomLOD:tm.maxGeomLOD,enableSplat:false});
 const saved={update:g.update,render:g.render};g.update=()=>{};g.render=()=>{};await d.queue.onSubmittedWorkDone();
 const before=s.getRegenerationStats?.(),original=d.createCommandEncoder.bind(d),entries=[];
 d.createCommandEncoder=desc=>{
  const enc=original(desc),begin=enc.beginComputePass.bind(enc),finish=enc.finish.bind(enc),pending=[];
  enc.beginComputePass=pdesc=>{
   const qs=d.createQuerySet({type:'timestamp',count:2}),resolve=d.createBuffer({size:16,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC}),read=d.createBuffer({size:16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
   const p={qs,resolve,read,label:pdesc?.label??desc?.label};pending.push(p);
   return begin({...pdesc,timestampWrites:{querySet:qs,beginningOfPassWriteIndex:0,endOfPassWriteIndex:1}});
  };
  enc.finish=arg=>{for(const p of pending){enc.resolveQuerySet(p.qs,0,2,p.resolve,0);enc.copyBufferToBuffer(p.resolve,0,p.read,0,16);entries.push(p);}return finish(arg);};return enc;
 };
 const drain=async()=>{let ns=0;for(const e of entries){await e.read.mapAsync(GPUMapMode.READ);const t=new BigUint64Array(e.read.getMappedRange());ns+=Number(t[1]-t[0]);e.read.unmap();e.read.destroy();e.resolve.destroy();e.qs.destroy();}entries.length=0;return ns/1e6;};
 const batch=async(count)=>{const textures=[],t=performance.now();for(let i=0;i<count;i++)textures.push(await gen.generateTile(new TileAddress(f.face,depth,x+i%4,y+Math.floor(i/4))));await d.queue.onSubmittedWorkDone();const fenceWallMs=performance.now()-t,gpuMs=await drain();textures.forEach(tx=>Object.values(tx).forEach(t=>t?._gpuTexture?.texture?.destroy()));return {count,fenceWallMs,gpuMs,perTileGpuMs:gpuMs/count,perTileWallMs:fenceWallMs/count};};
 try{const cold=await batch(1),samples=[];for(let i=0;i<5;i++)samples.push(await batch(16));return {depth,tileSize:s.tileTextureSize,cold,samples,regenerationBefore:before,regenerationAfter:s.getRegenerationStats?.(),scope:'production base height, tile classification and final micro height, transient textures; excludes normal/material/splat generation, pool copies, scheduling and residency'};}
 finally{d.createCommandEncoder=original;await drain();g.update=saved.update;g.render=saved.render;}
}
