/* global process, Buffer */
import fs from 'node:fs';
import crypto from 'node:crypto';
import {setupLab} from '../../../terrain-lab/labsetup.mjs';
const started=performance.now(),{device,gen,imp,planetConfig}=await setupLab(process.argv[2]??'.');
const output=process.env.WATER_OUTPUT??'tools/perf/structured-terrain-results/whitewater-near/native';
fs.mkdirSync(output,{recursive:true});
const errors=[];device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
const mountain=process.argv.includes('--mountain'),legacy=process.argv.includes('--legacy');
gen.terrainConfig.waterGraph={...gen.terrainConfig.waterGraph,carve:{...gen.terrainConfig.waterGraph?.carve,bankDetail:1}};
const {WaterService}=await imp('core/world/hydrology/WaterService.js');
const {WaterGpuData}=await imp('core/world/water/WaterGpuData.js');
const {structuredWaterGpuCapacity}=await imp('core/world/water/structuredWaterGpuCapacity.js');
const {WaterRiverSim}=await imp('core/world/water/WaterRiverSim.js');
const svc=new WaterService({device,terrainGenerator:gen,planetConfig,useWorker:false,config:{cache:false,carve:{bankDetail:1}}});
await svc.start();
const R=planetConfig.radius,b=gen.regionalTerrain.basins[0],cam={x:b.centre[0]*(R+b.levelM+200),y:b.centre[1]*(R+b.levelM+200),z:b.centre[2]*(R+b.levelM+200)};
const gpu=new WaterGpuData(device,{gridN:svc.config.gridN,planetRadius:R,carve:svc.config.carve,...structuredWaterGpuCapacity(svc)});
gpu.update(svc,cam,0);gen.setWaterCarveResources(gpu.resources);svc.setWaterCarveResources(gpu.resources);
gen.setRiverValleyResources(gpu.valleyResources);svc.setRiverValleyResources(gpu.valleyResources);
await device.queue.onSubmittedWorkDone();
if(legacy&&!svc._sampler){
    const {createHydrologySampler}=await imp('core/world/hydrology/HydrologyGrid.js');
    svc._sampler=await createHydrologySampler({device,terrainGenerator:gen});
    await svc._sampler.setWaterCarveResources(gpu.resources);
    await svc._sampler.setRiverValleyResources(gpu.valleyResources);
}
const rec=mountain?[...svc.riverRecs.values()].sort((a,b)=>b.profile.maxSlope-a.profile.maxSlope)[0]:svc.riverRecs.values().next().value,riverId=rec.id;
const config=legacy?{shape:svc.config.carve,lengthM:768,marginM:10,warmupSubsteps:240,warmupPerFrame:48,endFadeM:48,shiftM:64,sim:{referenceFlow:false,macCormack:true}}
    :{shape:svc.config.carve};
const sampler=legacy?svc._sampler:{sampleDirsCarved:dirs=>svc.sampleSimulationBed(dirs)};
const constructionStarted=performance.now();
const sim=new WaterRiverSim({device,sampler,radius:R,config});
const constructMs=performance.now()-constructionStarted;
const t=performance.now();await sim.place(riverId,rec,rec.lengthM*.45);await device.queue.onSubmittedWorkDone();
const placeMs=performance.now()-t;
const repeatStarted=performance.now();await sim.place(riverId,rec,rec.lengthM*.45);await device.queue.onSubmittedWorkDone();
const repeatPlaceMs=performance.now()-repeatStarted;
async function read(buffer){
    const rb=device.createBuffer({size:buffer.size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    const enc=device.createCommandEncoder();enc.copyBufferToBuffer(buffer,0,rb,0,buffer.size);device.queue.submit([enc.finish()]);
    await rb.mapAsync(GPUMapMode.READ);const result=new Float32Array(rb.getMappedRange().slice(0));rb.unmap();rb.destroy();return result;
}
function rowFrames(){
    const logical=sim._buildRows(sim.jStart,sim.L).rows,physical=new Float32Array(logical.length);
    for(let j=0;j<sim.L;j++)physical.set(logical.subarray(j*12,j*12+12),((j+sim.sim.rowBase)%sim.L)*12);
    return physical;
}
let bed=await read(sim.sim.bedBuffer),rows=rowFrames();
function stats(state){
    let minDepth=Infinity,maxDepth=0,maxSpeed=0,volume=0,wet=0,foam=0,nonfinite=0,negative=0,maxDeltaEta=0,wetOutside=0;
    const fluxes=[];
    for(let j=0;j<sim.L;j++){
        const pr=(j+sim.sim.rowBase)%sim.L,eta=rows[pr*12+3];let flux=0;
        for(let i=0;i<sim.W;i++){
            const id=pr*sim.W+i,h=state[id*4],u=state[id*4+1],v=state[id*4+2];
            if(![h,u,v,state[id*4+3]].every(Number.isFinite)){nonfinite++;continue;}
            if(h<0)negative++;minDepth=Math.min(minDepth,h);maxDepth=Math.max(maxDepth,h);volume+=h*sim.dx**2;
            if(h>sim.sim.params.hmin){wet++;foam+=state[id*4+3];maxSpeed=Math.max(maxSpeed,Math.hypot(u,v));
                maxDeltaEta=Math.max(maxDeltaEta,Math.abs(bed[id]+h-eta));
                if(bed[id]>eta+.1)wetOutside++;
            }
            flux+=h*v*sim.dx;
        }fluxes.push(flux);
    }
    return {minDepth,maxDepth,maxSpeed,volume,wet,meanFoam:foam/Math.max(1,wet),nonfinite,negative,maxDeltaEta,wetOutside,
        midFlux:fluxes[Math.floor(sim.L/2)],fluxRange:[Math.min(...fluxes),Math.max(...fluxes)],simTime:sim.sim.time};
}
const report={riverId,riverProfile:rec.profile,mountain,legacy,config:sim.config,setupThroughPublicationMs:t-started,constructMs,completeFirstSimMs:constructMs+placeMs,placeMs,repeatPlaceMs,W:sim.W,L:sim.L,dx:sim.dx,
    declaredSimulationBytes:sim.W*sim.L*80+sim.L*48+208,initial:stats(await sim.sim.readState()),snapshots:[],frameCosts:[],gpuErrors:errors};
for(let frame=1;frame<=1800;frame++){
    const enc=device.createCommandEncoder(),t0=performance.now();sim.encode(enc,frame/60);device.queue.submit([enc.finish()]);
    await device.queue.onSubmittedWorkDone();
    if(frame>120&&frame<=300)report.frameCosts.push(performance.now()-t0);
    if([120,600,1800].includes(frame)){
        const state=await sim.sim.readState(),s=stats(state);report.snapshots.push({frame,...s});
        fs.writeFileSync(`${output}/state-${frame}.f32`,Buffer.from(state.buffer));console.log(JSON.stringify({frame,...s}));
    }
}
fs.writeFileSync(`${output}/bed.f32`,Buffer.from(bed.buffer));fs.writeFileSync(`${output}/rows.f32`,Buffer.from(rows.buffer));
report.finalDiagnostics=sim.diagnostics??null;
if(device.features.has('timestamp-query')){
    const qs=device.createQuerySet({type:'timestamp',count:2});
    const resolve=device.createBuffer({size:256,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC});
    const rb=device.createBuffer({size:16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    report.computeGpuCosts=[];
    for(const steps of [2,4,8]){
        const samples=[];
        for(let k=0;k<10;k++){
            const enc=device.createCommandEncoder(),begin=enc.beginComputePass.bind(enc);
            enc.beginComputePass=desc=>begin({...desc,timestampWrites:{querySet:qs,beginningOfPassWriteIndex:0,endOfPassWriteIndex:1}});
            sim.sim.encode(enc,steps);enc.resolveQuerySet(qs,0,2,resolve,0);enc.copyBufferToBuffer(resolve,0,rb,0,16);
            device.queue.submit([enc.finish()]);await rb.mapAsync(GPUMapMode.READ);
            const ts=new BigUint64Array(rb.getMappedRange());samples.push(Number(ts[1]-ts[0])/1e6);rb.unmap();
        }report.computeGpuCosts.push({substeps:steps,samplesMs:samples});
    }
    rb.destroy();resolve.destroy();qs.destroy();
}
const shiftStart=performance.now(),previousTime=sim.sim.time;
await sim._shift(Math.round(32/sim.dx));await device.queue.onSubmittedWorkDone();
bed=await read(sim.sim.bedBuffer);rows=rowFrames();
report.shift={wallMs:performance.now()-shiftStart,rowBase:sim.sim.rowBase,timePreserved:sim.sim.time===previousTime,stats:stats(await sim.sim.readState())};
report.sources=['core/world/water/WaterRiverSim.js','core/world/water/ShallowWaterSim.js','core/world/water/shallowWaterSim.wgsl.js',
    'core/world/water/waterSimClock.js','core/world/hydrology/WaterService.js','core/world/hydrology/HydrologyGrid.js',
    'core/world/water/riverStrip.js','core/world/water/riverShapeNoise.js','core/world/water/riverCarve.wgsl.js',
    'tools/perf/structuredWhitewaterBench.mjs'].map(path=>({path,sha256:crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex')}));
fs.writeFileSync(`${output}/report.json`,JSON.stringify(report,null,2));
console.log(JSON.stringify({output,placeMs,W:sim.W,L:sim.L,errors}));
sim.destroy();gpu.destroy();process.exit(errors.length?1:0);
