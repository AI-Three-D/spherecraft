// Read-only probes of final terrain textures and availability in a live game.
export async function probeTerrain(windowWidthM=3200) {
 const g=window.gameEngine,tm=g.renderer.quadtreeTileManager,s=tm.tileStreamer,device=g.renderer.backend.device,R=g.planetConfig.radius,maxH=g.planetConfig.maxTerrainHeight;
 const {dirToFaceUV}=await import('/core/world/hydrology/waterGraph.js');
 const c=g.camera.position,o=g.planetConfig.origin,rel=[c.x-o.x,c.y-o.y,c.z-o.z],l=Math.hypot(...rel),up=rel.map(x=>x/l);
 const normal=a=>{const q=Math.hypot(...a);return a.map(x=>x/q);},cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
 const east=normal(cross(up,Math.abs(up[1])<.9?[0,1,0]:[1,0,0])),north=cross(up,east),depth=tm.quadtreeGPU.maxDepth,probeN=64;
 let fine=0,any=0;const depths={},missing=new Set();
 for(let y=0;y<probeN;y++)for(let x=0;x<probeN;x++){
  const px=((x+.5)/probeN-.5)*windowWidthM,py=((y+.5)/probeN-.5)*windowWidthM,d=normal(up.map((v,i)=>v+(east[i]*px+north[i]*py)/R)),f=dirToFaceUV(d);
  const tx=Math.min(2**depth-1,Math.floor(f.u*2**depth)),ty=Math.min(2**depth-1,Math.floor(f.v*2**depth));
  let found=-1;
  for(let z=depth;z>=0;z--){const layer=s.getLoadedLayer(f.face,z,tx>>(depth-z),ty>>(depth-z));if(Number.isInteger(layer)&&layer>=0){found=z;break;}}
  if(found===depth)fine++;else missing.add(`${f.face}/${depth}/${tx}/${ty}`);
  if(found>=0)any++;depths[found]=(depths[found]??0)+1;
 }
 const tiles=(tm._lastVisibleTiles??[]).map(t=>({...t,layer:s.getLoadedLayer(t.face,t.depth,t.x,t.y)})).filter(t=>Number.isInteger(t.layer)&&t.layer>=0);
 const unique=new Map(tiles.map(t=>[t.layer,t]));
 const picked=[...unique.values()].sort((a,b)=>b.depth-a.depth).slice(0,32),texture=s.arrayPool.textures.get('height'),size=s.tileTextureSize??128;
 const row=Math.ceil(size*4/256)*256,block=row*size,rb=device.createBuffer({size:block*picked.length,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
 const e=device.createCommandEncoder();picked.forEach((t,i)=>e.copyTextureToBuffer({texture,origin:{x:0,y:0,z:t.layer}},{buffer:rb,offset:block*i,bytesPerRow:row,rowsPerImage:size},[size,size,1]));
 const start=performance.now();device.queue.submit([e.finish()]);await rb.mapAsync(GPUMapMode.READ);const a=new Float32Array(rb.getMappedRange());
 const hAt=(tile,u,v)=>{const x=Math.max(0,Math.min(size-1,u*(size-1))),y=Math.max(0,Math.min(size-1,v*(size-1))),i=Math.floor(x),j=Math.floor(y),fx=x-i,fy=y-j;
  const at=(x,y)=>a[tile*block/4+Math.min(size-1,y)*row/4+Math.min(size-1,x)]*maxH;
  return (at(i,j)*(1-fx)+at(i+1,j)*fx)*(1-fy)+(at(i,j+1)*(1-fx)+at(i+1,j+1)*fx)*fy;
 };
 const result=[];
 // Compare the bilinear texture surface with triangle interpolation through
 // the same shader-remapped grid vertices. Interior cells only, no border seams.
 for(const segments of [128,64,32,16]){
  const deltas=[],wetMismatch={};let heightMaximum=0;
  const lakes=[...g.waterService.refined.entries()].filter(([id,r])=>Math.acos(Math.min(1,r.frame.c.reduce((a,x,i)=>a+x*up[i],0)))*R<16000).map(([id,r])=>({id,level:r.level}));
  for(let t=0;t<picked.length;t++)for(let y=1;y<segments-2;y++)for(let x=1;x<segments-2;x++){
   const scale=segments/(segments-1),u0=x/segments*scale,v0=y/segments*scale,u1=(x+1)/segments*scale,v1=(y+1)/segments*scale;
   const h10=hAt(t,u1,v0),h01=hAt(t,u0,v1),draw=(h10+h01)/2,tex=hAt(t,(u0+u1)/2,(v0+v1)/2),d=Math.abs(draw-tex);deltas.push(d);heightMaximum=Math.max(heightMaximum,d);
   for(const lake of lakes)if((draw<lake.level)!==(tex<lake.level))wetMismatch[lake.id]=(wetMismatch[lake.id]??0)+1;
  }
  deltas.sort((a,b)=>a-b);result.push({segments,samples:deltas.length,heightErrorM:{median:deltas[Math.floor(deltas.length*.5)],p95:deltas[Math.floor(deltas.length*.95)],p99:deltas[Math.floor(deltas.length*.99)],max:heightMaximum},wetClassificationDisagreements:wetMismatch});
 }
 const elapsedMs=performance.now()-start;rb.unmap();rb.destroy();
 return {windowWidthM,availabilityProbePoints:probeN**2,finestDepth:depth,finestAvailableShare:fine/(probeN**2),anyAvailableShare:any/(probeN**2),availableDepthCounts:depths,distinctMissingFineTiles:missing.size,tileTextureSize:size,selectedVisibleCount:tiles.length,selectedVisibleDepths:tiles.reduce((a,t)=>(a[t.depth]=(a[t.depth]??0)+1,a),{}),visibleTileExample:tiles[0],textureTilesRead:picked.map(t=>({face:t.face,depth:t.depth,x:t.x,y:t.y,layer:t.layer})),readAndAnalysisMs:elapsedMs,interpolationComparison:result,regeneration:s.getRegenerationStats?.(),near:g.waterGpuData.near};
}
