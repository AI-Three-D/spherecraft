/* global process */
import fs from 'node:fs';
import {setupLab} from '../../../terrain-lab/labsetup.mjs';
import {WorldConfigLoader} from '../../wizard_game/WorldConfigLoader.js';
const output=process.env.WATER_OUTPUT??'tools/perf/structured-terrain-results/placement-defaults/native';fs.mkdirSync(output,{recursive:true});
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
const report={setupAndPlacementMs:performance.now()-started,seed:engineConfig.seed,heightScale:planetConfig.heightScale,worldConfig:r.worldConfig,regionCount:r.shapeData.basins.length,
 lakeCount:r.basins.length,riverCount:r.drainagePlan.rivers.length,faces:[...new Set(r.shapeData.patches.map(p=>p.options.face))],
 bytes:r.byteLength,cpuBytes:r.cpuPlanningBytes,timings:r.timings,
 lakes:r.basins.map(b=>({id:b.id,centre:b.centre,radiusM:b.radiusM,levelM:b.levelM,shape:!!b.shapeProof})),
 rivers:r.drainagePlan.rivers.map(v=>({id:v.id,fromLake:v.fromLake,dest:v.dest,lengthM:v.lengthM,profile:v.profile})),errors};
const {WaterService}=await imp('core/world/hydrology/WaterService.js');const {WaterGpuData}=await imp('core/world/water/WaterGpuData.js');
const {structuredWaterGpuCapacity}=await imp('core/world/water/structuredWaterGpuCapacity.js');
const service=new WaterService({device,terrainGenerator:gen,planetConfig,useWorker:false});service.start();
const pubStart=performance.now(),gpu=new WaterGpuData(device,{gridN:service.config.gridN,planetRadius:planetConfig.radius,
 carve:service.config.carve,...structuredWaterGpuCapacity(service)});
const b=r.basins[0];if(!b)throw new Error('Planet placement produced no lakes');
gpu.update(service,{x:b.centre[0]*planetConfig.radius,y:b.centre[1]*planetConfig.radius,z:b.centre[2]*planetConfig.radius},0);
gen.setWaterCarveResources(gpu.carveResources);await device.queue.onSubmittedWorkDone();report.publicationMs=performance.now()-pubStart;
report.service={state:service.state,stats:service.stats,gpuReady:gpu._ready};
if(process.argv.includes('--fine')) {
 const {TileGenerator}=await imp('core/world/quadtree/tileGenerator.js'),{TileAddress}=await imp('core/world/quadtree/tileAddress.js');
 const {dirToFaceUV}=await imp('core/world/hydrology/waterGraph.js');
 const tileGen=new TileGenerator(gen,{textureSize:128,requiredTypes:['height','normal','tile','macro','splatData','splatIndex','splatValid','resolvedColor','scatter'],
  textureFormats:{height:'r32float',normal:'rgba8unorm',tile:'r8unorm'},quadtreeMaxDepth:11,maxGeomLOD:6,enableSplat:true});
 gen._quadtreeSplatDiagCount=3;gen._quadtreeSplatProbePassCount=3;gen._quadtreeSplatPrimeCount=3;
 report.fine=[];
 for(const face of report.faces){
  const b=r.shapeData.patches.find(p=>p.options.face===face).basin,p=dirToFaceUV(b.centre),n=2048,x=Math.floor(p.u*n),y=Math.floor(p.v*n),address=new TileAddress(face,11,x,y);
  const t=performance.now(),textures=await tileGen.generateTile(address);await device.queue.onSubmittedWorkDone();const generationMs=performance.now()-t;
  const rb=device.createBuffer({size:128*128*4,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),enc=device.createCommandEncoder();
  enc.copyTextureToBuffer({texture:textures.height._gpuTexture.texture},{buffer:rb,bytesPerRow:512},[128,128]);device.queue.submit([enc.finish()]);await rb.mapAsync(GPUMapMode.READ);
  const heights=new Float32Array(rb.getMappedRange()),i=Math.round((p.u*n-x)*127),j=Math.round((p.v*n-y)*127),raw=heights[j*128+i],h=raw*planetConfig.heightScale;
  report.fine.push({lakeId:b.id,face,address:address.toString(),generationMs,coreHeightNormalized:raw,coreHeightM:h,levelM:b.levelM,depthM:b.levelM-h,
   nonfinite:Array.from(heights).filter(v=>!Number.isFinite(v)).length});rb.unmap();rb.destroy();
  for(const tex of new Set(Object.values(textures).map(t=>t?._gpuTexture?.texture).filter(Boolean)))tex.destroy();
  if(!Number.isFinite(h)||h>b.levelM-.2)throw new Error(`Final fine core is dry for lake ${b.id}`);
 }
}
fs.writeFileSync(`${output}/report.json`,JSON.stringify(report,null,2));
console.log(JSON.stringify({placementMs:report.timings.totalMs,setupAndPlacementMs:report.setupAndPlacementMs,lakes:report.lakeCount,rivers:report.riverCount,faces:report.faces,bytes:report.bytes,errors}));
process.exit(errors.length?1:0);
