/* global process, Buffer */
import fs from 'node:fs';
import {setupLab} from '../../../terrain-lab/labsetup.mjs';
import {WorldConfigLoader} from '../../wizard_game/WorldConfigLoader.js';
const output=process.env.WATER_OUTPUT??'tools/perf/structured-terrain-results/planet-water-density/native';fs.mkdirSync(output,{recursive:true});
if(process.env.WATER_SEED){
 const build=WorldConfigLoader.prototype._buildEngineConfig;
 WorldConfigLoader.prototype._buildEngineConfig=function(...args){const cfg=build.apply(this,args);cfg.seed=Number(process.env.WATER_SEED);return cfg;};
}
if(process.env.WATER_REGIONS){
 const build=WorldConfigLoader.prototype._buildGameDataConfig;
 WorldConfigLoader.prototype._buildGameDataConfig=function(...args){const cfg=build.apply(this,args);Object.assign(cfg.planets[0].terrain.regionalTerrain.world,
  {maxRegions:Number(process.env.WATER_REGIONS),maxCandidates:Number(process.env.WATER_CANDIDATES??24),maxRivers:Number(process.env.WATER_RIVERS??4)});return cfg;};
}
const started=performance.now(),{device,gen,imp,planetConfig,engineConfig}=await setupLab(process.argv[2]??'.');
const errors=[];device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
const r=gen.regionalTerrain;
const report={setupAndPlacementMs:performance.now()-started,regionalVersion:r.version,regionalKey:r.sourceKey,seed:engineConfig.seed,heightScale:planetConfig.heightScale,worldConfig:r.worldConfig,regionCount:r.shapeData.patches.length,
 lakeCount:r.basins.length,riverCount:r.drainagePlan.rivers.length,faces:[...new Set(r.shapeData.patches.map(p=>p.options.face))],
 bytes:r.byteLength,cpuBytes:r.cpuPlanningBytes,timings:r.timings,
 lakes:r.basins.map(b=>({id:b.id,centre:b.centre,radiusM:b.radiusM,levelM:b.levelM,shape:!!b.shapeProof,footprintAreaM2:b.mask.reduce((s,v)=>s+(v>0),0)*b.frame.spacing**2,wetAreaM2:(b.surfaceDepthMask??b.mask).reduce((s,v)=>s+(b.surfaceDepthMask?v>128:v>0),0)*b.frame.spacing**2,tier:r.shapeData.patches.find(p=>p.basins.some(v=>v.id===b.id)).parent.tier??'legacy',surfaceSpacingM:b.frame.spacing})),
 rivers:r.drainagePlan.rivers.map(v=>({id:v.id,fromLake:v.fromLake,dest:v.dest,lengthM:v.lengthM,profile:v.profile})),errors};
const {WaterService}=await imp('core/world/hydrology/WaterService.js');const {WaterGpuData}=await imp('core/world/water/WaterGpuData.js');
const {structuredWaterGpuCapacity}=await imp('core/world/water/structuredWaterGpuCapacity.js');
const service=new WaterService({device,terrainGenerator:gen,planetConfig,useWorker:false});service.start();
report.capacityInput={slots:Math.max(...service.lakes.map(b=>b.id+1)),lakes:service.lakes.length,segments:[...service.riverRecs.values()].reduce((s,r)=>s+r.segCells.length,0),riverCells:new Set([...service.riverRecs.values()].flatMap(r=>Array.from(r.segCells,k=>Math.floor(k/16)))).size};
fs.writeFileSync(`${output}/placement.json`,JSON.stringify(report,null,2));
const pubStart=performance.now(),gpu=new WaterGpuData(device,{gridN:service.config.gridN,planetRadius:planetConfig.radius,
 carve:service.config.carve,...structuredWaterGpuCapacity(service)});
const b=r.basins[0];if(!b)throw new Error('Planet placement produced no lakes');
gpu.update(service,{x:b.centre[0]*planetConfig.radius,y:b.centre[1]*planetConfig.radius,z:b.centre[2]*planetConfig.radius},0);
if(!gpu.resources?.rivers)throw new Error('Missing production river carve resources');gen.setWaterCarveResources(gpu.resources);await device.queue.onSubmittedWorkDone();report.publicationMs=performance.now()-pubStart;
report.service={state:service.state,stats:service.stats,gpuReady:gpu._ready};
report.gpu={maskSlots:gpu.maxLayers,maskTilesPerAxis:gpu.maskTilesPerAxis,maskArrayLayers:gpu.masksTexture.depthOrArrayLayers,
 maskBytes:gpu.masksTexture.width*gpu.masksTexture.height*gpu.masksTexture.depthOrArrayLayers,
 buffersBytes:gpu.indexBuffer.size+gpu.lakesBuffer.size+gpu.riversBuffer.size+gpu.paramsBuffer.size,
 residentMasks:gpu._layerOf.size,residentRivers:gpu._inGpu.size,droppedRivers:gpu._droppedRivers,riverSegments:gpu.riverSegCount};
report.visibility={missingMaskIds:service.lakes.filter(b=>!gpu._layerOf.has(b.id)).map(b=>b.id),
 missingCoreIds:r.basins.filter(b=>gpu.lakeAt(b.centre)?.id!==b.id).map(b=>b.id)};
report.proofs={count:r.basins.length,minimumRimM:Math.min(...r.basins.map(b=>b.shapeProof.minimumRimM)),
 minimumCoreDepthM:Math.min(...r.basins.map(b=>b.shapeProof.guaranteedDepthM))};
const {readRegionalField}=await imp('core/world/terrain-generator/regionalFieldReadback.js');
const {faceUVToDir,dirToFaceUV}=await imp('core/world/hydrology/waterGraph.js');
const ar=await readRegionalField(device,r.fields[0],{width:r.size,channels:4}),br=await readRegionalField(device,r.fields[1],{width:r.size,channels:4});
const distances=[],byFace=[];
for(let face=0;face<6;face++) {
 let landSamples=0;
 for(let y=0;y<64;y++)for(let x=0;x<64;x++) {
  const k=(face*r.size*r.size+Math.floor((y+.5)*r.cells/64)*r.size+Math.floor((x+.5)*r.cells/64))*4;
  if(ar.values[k]<.65||ar.values[k+3]*700+br.values[k+2]*planetConfig.heightScale<120)continue;
  landSamples++;const d=faceUVToDir(face,(x+.5)/64,(y+.5)/64);let best=-1;
  for(const b of r.basins)best=Math.max(best,d[0]*b.centre[0]+d[1]*b.centre[1]+d[2]*b.centre[2]);
  distances.push(Math.acos(Math.min(1,best))*planetConfig.radius);
 }
 byFace.push({face,landSamples,lakes:r.basins.filter(b=>dirToFaceUV(b.centre).face===face).length,
 rivers:r.drainagePlan.rivers.filter(v=>dirToFaceUV(Array.from(v.points.slice(0,3))).face===face).length});
}
distances.sort((a,b)=>a-b);report.distribution={byFace,landSamples:distances.length,
 nearestLakeM:{median:distances[Math.floor(distances.length*.5)],p90:distances[Math.floor(distances.length*.9)],p95:distances[Math.floor(distances.length*.95)],maximum:distances.at(-1)},
 within5kmFraction:distances.filter(d=>d<=5000).length/distances.length};
if(report.visibility.missingMaskIds.length||report.visibility.missingCoreIds.length||report.gpu.droppedRivers){fs.writeFileSync(`${output}/report.json`,JSON.stringify(report,null,2));throw new Error('Incomplete global water publication');}
if(process.argv.includes('--no-shore-detail')){const create=device.createShaderModule.bind(device);device.createShaderModule=desc=>create({...desc,code:desc.code.replace('if(regionalShapeParams.limits.z==-2.0&&out.owned)', 'if(false)')});report.disabledShoreDetail=true;}
if(process.argv.includes('--fine')) {
 const {TileGenerator}=await imp('core/world/quadtree/tileGenerator.js'),{TileAddress}=await imp('core/world/quadtree/tileAddress.js');
 const {dirToFaceUV}=await imp('core/world/hydrology/waterGraph.js');
 const {planeToDir}=await imp('core/world/hydrology/lakeRefine.js');
 const tileGen=new TileGenerator(gen,{textureSize:128,requiredTypes:['height','normal','tile','macro','splatData','splatIndex','splatValid','resolvedColor','scatter'],
  textureFormats:{height:'r32float',normal:'rgba8unorm',tile:'r8unorm'},quadtreeMaxDepth:11,maxGeomLOD:6,enableSplat:true});
 gen._quadtreeSplatDiagCount=3;gen._quadtreeSplatProbePassCount=3;gen._quadtreeSplatPrimeCount=3;
 report.fine=[];
 const cases=report.faces.map(face=>({b:r.shapeData.patches.find(p=>p.options.face===face).basin}));
 const shore=r.shapeData.patches.filter(p=>p.parent.tier==='medium'&&Math.abs(p.basin.centre[1])<.6).map(p=>p.basin).sort((a,b)=>b.radiusM-a.radiusM)[0];
 if(shore){const m=shore.surfaceDepthMask,f=shore.frame;let k=Array.from(m).findIndex((v,k)=>v>128&&v<140&&k%f.nx>0&&k%f.nx<f.nx-1&&k>f.nx&&k<m.length-f.nx&&[k-1,k+1,k-f.nx,k+f.nx].some(q=>m[q]<128));if(k<0)throw new Error('No measurement shore');cases.push({b:shore,dir:planeToDir(f.x0+(k%f.nx+.5)*f.spacing,f.y0+(Math.floor(k/f.nx)+.5)*f.spacing,f,planetConfig.radius),shore:true});}
 cases.push({b:r.basins[409]});
 for(const {b,dir,shore:atShore} of cases){
  const p=dirToFaceUV(dir??b.centre),face=p.face,n=2048,x=Math.floor(p.u*n),y=Math.floor(p.v*n),address=new TileAddress(face,11,x,y);
  const t=performance.now(),textures=await tileGen.generateTile(address);await device.queue.onSubmittedWorkDone();const generationMs=performance.now()-t;
  const rb=device.createBuffer({size:128*128*4,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),enc=device.createCommandEncoder();
  enc.copyTextureToBuffer({texture:textures.height._gpuTexture.texture},{buffer:rb,bytesPerRow:512},[128,128]);device.queue.submit([enc.finish()]);await rb.mapAsync(GPUMapMode.READ);
  const heights=new Float32Array(rb.getMappedRange()),i=Math.round((p.u*n-x)*127),j=Math.round((p.v*n-y)*127),raw=heights[j*128+i],h=raw*planetConfig.heightScale;
  report.fine.push({shore:!!atShore,lakeId:b.id,face,address:address.toString(),generationMs,coreHeightNormalized:raw,coreHeightM:h,levelM:b.levelM,depthM:b.levelM-h,
   nonfinite:Array.from(heights).filter(v=>!Number.isFinite(v)).length});if(atShore)fs.writeFileSync(`${output}/shore-height.f32`,Buffer.from(heights.buffer,heights.byteOffset,heights.byteLength));rb.unmap();rb.destroy();
  for(const tex of new Set(Object.values(textures).map(t=>t?._gpuTexture?.texture).filter(Boolean)))tex.destroy();
  if(atShore){report.shoreWarmMs=[];for(let k=0;k<8;k++){const t=performance.now(),textures=await tileGen.generateTile(address);await device.queue.onSubmittedWorkDone();report.shoreWarmMs.push(performance.now()-t);for(const tex of new Set(Object.values(textures).map(t=>t?._gpuTexture?.texture).filter(Boolean)))tex.destroy();}}
  if(!Number.isFinite(h)||!atShore&&h>b.levelM-.2)throw new Error(`Final fine core is dry for lake ${b.id}`);
 }
}
fs.writeFileSync(`${output}/report.json`,JSON.stringify(report,null,2));
console.log(JSON.stringify({placementMs:report.timings.totalMs,setupAndPlacementMs:report.setupAndPlacementMs,lakes:report.lakeCount,rivers:report.riverCount,faces:report.faces,bytes:report.bytes,errors}));
process.exit(errors.length?1:0);
