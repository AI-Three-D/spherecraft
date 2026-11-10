/* global process */
// Native Dawn/Metal, real production pipelines. Run from the repository root:
// node tools/perf/structuredTerrainBench.mjs . [cells=128] [rounds=3]
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { setupLab } from '../../../terrain-lab/labsetup.mjs';

const root = process.argv[2] ?? '.';
const cells = Number(process.argv[3] ?? 128);
const rounds = Number(process.argv[4] ?? 3);
const output = process.env.LAB_STRUCTURED_OUTPUT ?? 'tools/perf/structured-terrain-results';
fs.mkdirSync(output, { recursive: true });
const setupStarted = performance.now();
const lab = await setupLab(root);
const setupWallMs = performance.now() - setupStarted;
const { device, gen, imp, planetConfig, engineConfig, profiler, collectProfile } = lab;
const errors = [];
device.addEventListener('uncapturederror', e => errors.push(e.error.message));
const { createHydrologySampler } = await imp('core/world/hydrology/HydrologyGrid.js');
const { WaterService } = await imp('core/world/hydrology/WaterService.js');
const { WaterGpuData } = await imp('core/world/water/WaterGpuData.js');
const { TileGenerator } = await imp('core/world/quadtree/tileGenerator.js');
const { TileAddress } = await imp('core/world/quadtree/tileAddress.js');
const { cellDir, dirToFaceUV, faceUVToDir } = await imp('core/world/hydrology/waterGraph.js');
const R = planetConfig.radius;
const maxH = planetConfig.maxTerrainHeight;
const SIZE = 128;
const summary = values => ({ n: values.length, median: [...values].sort((a,b) => a-b)[Math.floor(values.length/2)],
    min: Math.min(...values), max: Math.max(...values) });
async function profile(fn) {
    profiler.enabled = true;
    const start = performance.now();
    const value = await fn();
    await device.queue.onSubmittedWorkDone();
    const wallMs = performance.now() - start;
    profiler.enabled = false;
    const entries = await collectProfile();
    const gpuPasses = [...entries].map(([label, v]) => ({ label, n: v.n, ms: v.ns / 1e6 }));
    return { value, wallMs, gpuMs: gpuPasses.reduce((a,b) => a+b.ms,0), gpuPasses };
}
async function readTexture(texture, w, h, channels = 1, layers = 1) {
    const row = Math.ceil(w * channels * 4 / 256) * 256;
    const rb = device.createBuffer({ size: row*h*layers, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = device.createCommandEncoder({ label: 'Regional diagnostics readback' });
    enc.copyTextureToBuffer({ texture }, { buffer: rb, bytesPerRow: row, rowsPerImage: h }, [w,h,layers]);
    device.queue.submit([enc.finish()]);
    await rb.mapAsync(GPUMapMode.READ);
    const mapped = new Float32Array(rb.getMappedRange());
    const values = new Float32Array(w*h*channels*layers);
    for (let j=0;j<h*layers;j++) values.set(mapped.subarray(j*row/4,j*row/4+w*channels),j*w*channels);
    rb.unmap();rb.destroy();return values;
}
const phase = rec => { const { value: _value, ...cost } = rec; return cost; };
const beforeMacro = process.memoryUsage();
const coarseCold = await profile(() => gen.prepareRegionalTerrain({ cells, seamCells: 4 }));
const data = coarseCold.value;
const coldSourceKey = data.sourceKey;
const coarseWarm = [];
for (let i=0;i<rounds;i++) coarseWarm.push(phase(await profile(() => gen.prepareRegionalTerrain({ cells, seamCells: 4 }, { regenerate: true }))));
const current = gen.regionalTerrain;
if (current.sourceKey !== coldSourceKey) throw new Error('Generation changed its deterministic source key');
const reuse = await profile(() => gen.prepareRegionalTerrain({ cells, seamCells: 4 }));
const afterMacro = process.memoryUsage();
const readStarted = performance.now();
const lower = await readTexture(current.lowerBounds,cells,cells,1,6);
const controlsA = await readTexture(current.fields[0],current.size,current.size,4,6);
const controlsB = await readTexture(current.fields[1],current.size,current.size,4,6);
const diagnosticReadbackMs = performance.now()-readStarted;

// Quantify full-world between-sample error on identical unit directions.
const count = 32768;
const dirs = new Float32Array(count*4);
for (let i=0;i<count;i++) {
    const y=1-2*(i+.5)/count, a=i*2.399963229728653, r=Math.sqrt(1-y*y);
    dirs.set([r*Math.cos(a),y,r*Math.sin(a),0],i*4);
}
gen.regionalTerrainActive=false;
const directSamplerStarted=performance.now();
const directSampler=await createHydrologySampler({device,terrainGenerator:gen});
const directSamplerCompileMs=performance.now()-directSamplerStarted;
const directFirst = await profile(()=>directSampler.sampleDirsNatural(dirs));
gen.regionalTerrainActive=true;
const regionalSamplerStarted=performance.now();
const regionalSampler=await createHydrologySampler({device,terrainGenerator:gen});
const regionalSamplerCompileMs=performance.now()-regionalSamplerStarted;
const regionalFirst=await profile(()=>regionalSampler.sampleDirsNatural(dirs));
const directSampling=[],regionalSampling=[];
for (let i=0;i<rounds;i++) {
    gen.regionalTerrainActive=false;directSampling.push(phase(await profile(()=>directSampler.sampleDirsNatural(dirs))));
    gen.regionalTerrainActive=true;regionalSampling.push(phase(await profile(()=>regionalSampler.sampleDirsNatural(dirs))));
}
const baseHeights=directFirst.value, regionalHeights=regionalFirst.value;
let absSum=0,squareSum=0,maxError=0,worstIndex=0,deficits=0,maxDeficit=0;
const slacks=[];
for (let i=0;i<count;i++) {
    const error=regionalHeights[i]-baseHeights[i];absSum+=Math.abs(error);squareSum+=error*error;
    if(Math.abs(error)>maxError){maxError=Math.abs(error);worstIndex=i;}
    const {face,u,v}=dirToFaceUV(Array.from(dirs.subarray(i*4,i*4+3)));
    const k=face*cells*cells+Math.min(cells-1,Math.floor(v*cells))*cells+Math.min(cells-1,Math.floor(u*cells));
    const slack=regionalHeights[i]-lower[k];slacks.push(slack);
    if (slack<0) {deficits++;maxDeficit=Math.max(maxDeficit,-slack);}
}

// Confirm the disabled prototype matches the independent pre-edit rollback.
const baselineRoot='/tmp/spherecraft-structured-baseline-20261008';
let rollbackComparison=null;
if (fs.existsSync(`${baselineRoot}/package.json`)) {
    const oldBase=await import(pathToFileURL(`${baselineRoot}/templates/terrain-shaders/base/earthLikeBase.wgsl.js`));
    const oldHydro=await import(pathToFileURL(`${baselineRoot}/core/world/hydrology/HydrologyGrid.js`));
    const oldGen=Object.create(gen);
    oldGen._getAdvancedTerrainShaderOptions=extra=>({...gen._getAdvancedTerrainShaderOptions(extra),regionalTerrain:false,
        terrainShaderBundle:{...gen.terrainShaderBundle,baseGenerators:{earthLike:{constants:oldBase.createEarthlikeConstants,base:oldBase.createEarthlikeBase}}}});
    gen.regionalTerrainActive=false;
    const oldSampler=await oldHydro.createHydrologySampler({device,terrainGenerator:oldGen});
    const frame={c:[1,0,0],e1:[0,0,1],e2:[0,1,0],x0:-8000,y0:-8000,spacing:125,nx:128,ny:128};
    const old=await oldSampler.samplePatch(frame,R), now=await directSampler.samplePatch(frame,R);
    let maximum=0,unequal=0;
    for(let i=0;i<old.length;i++){if(old[i]!==now[i])unequal++;maximum=Math.max(maximum,Math.abs(old[i]-now[i]));}
    rollbackComparison={samples:old.length,maxDifferenceM:maximum,unequal};oldSampler.destroy();
}

// Complete existing graph startup and river generation. The unchanged fine
// discovery architecture is intentionally measured, not credited with the
// coarse tier's isolated dispatch cost. Baseline locations drive site choice.
gen.regionalTerrainActive=false;
const services=[];
const water=[];
let baselineSources=null;
for (const mode of ['direct','regional']) {
    gen.regionalTerrainActive=mode==='regional';
    const svc=new WaterService({device,terrainGenerator:gen,planetConfig,useWorker:false,config:{cache:false}});
    const gpu=new WaterGpuData(device,{gridN:512,planetRadius:R,carve:svc.config.carve,valley:svc.config.valley});
    gen.setWaterCarveResources(gpu.resources);svc.setWaterCarveResources(gpu.resources);
    gen.setRiverValleyResources(gpu.valleyResources);svc.setRiverValleyResources(gpu.valleyResources);
    const memoryBefore=process.memoryUsage();
    const start=await profile(()=>svc.start());
    if(svc.state!=='ready')throw new Error(`Water startup ${mode} failed`);
    const proxyReady=await profile(()=>gpu.update(svc,{x:R+500,y:0,z:0},0));
    const record={mode,start:phase(start),serviceTimings:svc.timings,stats:svc.stats,
        coarseLakeGpuDataReadyWallMs:start.wallMs+proxyReady.wallMs,
        firstVisibleDistantWaterMs:null,firstVisibleNote:'GPU data readiness measured; no live browser first-visible timing. Coarse river surfaces are not yet implemented.',
        hostArrayBufferDeltaBytes:process.memoryUsage().arrayBuffers-memoryBefore.arrayBuffers,rivers:[]};
    if(mode==='direct')baselineSources=[17,12,25,28].map(id=>({id,dir:svc.lakes[svc.rivers[id].fromLake].centreDir}));
    const selected=mode==='direct'?baselineSources:baselineSources.map(source=>{
        let best=-1,cos=-Infinity;
        for(const river of svc.rivers){const d=svc.lakes[river.fromLake].centreDir;const c=d.reduce((s,v,i)=>s+v*source.dir[i],0);if(c>cos){cos=c;best=river.id;}}
        return {id:best,baselineId:source.id,sourceSeparationM:Math.acos(Math.min(1,cos))*R};
    });
    for(const site of selected){
        const rec=await profile(()=>svc.refineRiver(site.id));
        const value=rec.value;
        const warm=await profile(()=>svc.refineRiver(site.id));
        record.rivers.push({...site,total:phase(rec),warmReuse:phase(warm),landscapeMs:value?.landscapeMs,
            lengthM:value?.lengthM,points:value?value.points.length/value.stride:0,
            refinedLakesAfter:svc.refined.size,retainedRiverBytes:value?value.points.byteLength+value.segCells.byteLength+value.segCellStart.byteLength:0});
    }
    water.push(record);services.push({svc,gpu});
}

// Real 128x128 terrain tile generation INCLUDING normals, classification,
// micro, splat/material/climate/scatter. Identical addresses and outputs.
const fullTypes=['height','normal','tile','macro','splatData','splatIndex','splatValid','resolvedColor','scatter','climate','coarseColor'];
// Startup's first-three splat diagnostics asynchronously read output textures.
// Normal generation is measured here; keep those optional probes out of both
// cases rather than destroying outputs while a diagnostic still reads them.
gen._quadtreeSplatDiagCount=3;gen._quadtreeSplatProbePassCount=3;gen._quadtreeSplatPrimeCount=3;
const tileGen=new TileGenerator(gen,{textureSize:SIZE,requiredTypes:fullTypes,
    textureFormats:{height:'r32float',normal:'rgba8unorm',tile:'r8unorm'},quadtreeMaxDepth:11,maxGeomLOD:6,enableSplat:true});
const directSvc=services[0].svc;
const highest=directSvc.gridHeights.reduce((best,h,i)=>h>directSvc.gridHeights[best]?i:best,0);
const highestBound=lower.reduce((best,h,i)=>h>lower[best]?i:best,0);
const sites=[...baselineSources.map(s=>s.dir),cellDir(highest,512),faceUVToDir(0,1,.5)];
const addresses=sites.map((dir,i)=>{const {face,u,v}=dirToFaceUV(dir);return TileAddress.fromFaceUV(face,u,v,i===4?5:8);});
addresses.push(addresses[4].children[0]);
const dispose=tx=>{for(const t of Object.values(tx))t?._gpuTexture?.texture?.destroy();};
const tileRounds={direct:[],regional:[]},tileCold={};
// Keep the same frozen water resource set in both modes for equivalent work.
gen.setWaterCarveResources(null);gen.setRiverValleyResources(null);
for(const mode of ['direct','regional']){
    gen.regionalTerrainActive=mode==='regional';
    const first=await profile(async()=>{for(const a of addresses)dispose(await tileGen.generateTile(a));});
    tileCold[mode]=phase(first);
}
let tileViolations=0,tileSamples=0,tileMaxDeficit=0,edgeMaxDifferenceM=0;
const address=addresses[0],neighbor=address.getNeighbors()[1];
const seam={};
for(let round=0;round<rounds;round++)for(const mode of ['direct','regional']){
    gen.regionalTerrainActive=mode==='regional';
    const result=await profile(async()=>{for(const a of addresses)dispose(await tileGen.generateTile(a));});
    tileRounds[mode].push(phase(result));
}
gen.regionalTerrainActive=true;
for(const a of [...addresses,neighbor]){
    const tx=await tileGen.generateTile(a);
    await device.queue.onSubmittedWorkDone();
    const h=await readTexture(tx.height._gpuTexture.texture,SIZE,SIZE);
    for(let j=0;j<SIZE;j++)for(let i=0;i<SIZE;i++){
        const u=(a.x+i/(SIZE-1))/a.gridSize,v=(a.y+j/(SIZE-1))/a.gridSize;
        const k=a.face*cells*cells+Math.min(cells-1,Math.floor(v*cells))*cells+Math.min(cells-1,Math.floor(u*cells));
        const deficit=lower[k]-h[j*SIZE+i]*maxH;tileSamples++;
        if(deficit>0){tileViolations++;tileMaxDeficit=Math.max(tileMaxDeficit,deficit);}
    }
    if(a===address)seam.left=h;
    if(a===neighbor)seam.right=h;
    dispose(tx);
}
for(let j=0;j<SIZE;j++)edgeMaxDifferenceM=Math.max(edgeMaxDifferenceM,Math.abs(seam.left[j*SIZE+SIZE-1]-seam.right[j*SIZE])*maxH);

const report={seed:engineConfig.seed,radiusM:R,maxTerrainHeightM:maxH,noiseReferenceRadiusM:gen.noiseReferenceRadiusM,
    cells,seamCells:4,rootAddresses:current.regions.map(String),rounds,setupWallMs,
    deviceLimits:{maxBindGroups:device.limits.maxBindGroups,maxSampledTexturesPerShaderStage:device.limits.maxSampledTexturesPerShaderStage},
    coarse:{cold:{...phase(coarseCold),stages:data.timings},regeneration:coarseWarm,reuse:phase(reuse),
        gpuResidentBytes:current.byteLength,regenerationPeakInputBytes:current.byteLength*2,
        processArrayBufferDeltaBytes:afterMacro.arrayBuffers-beforeMacro.arrayBuffers,
        diagnosticReadbackMs,diagnosticReadbackBytes:lower.byteLength+controlsA.byteLength+controlsB.byteLength,
        sourceKey:coldSourceKey,regeneratedRoots:6,budgets:current.budgets},
    samplers:{count,directSamplerCompileMs,regionalSamplerCompileMs,directFirst:phase(directFirst),regionalFirst:phase(regionalFirst),
        directWarm:directSampling,regionalWarm:regionalSampling},
    error:{samples:count,meanAbsoluteM:absSum/count,rmsM:Math.sqrt(squareSum/count),maxM:maxError,
        worstDirection:Array.from(dirs.subarray(worstIndex*4,worstIndex*4+3))},
    bounds:{baseSamplerViolations:deficits,maxBaseDeficitM:maxDeficit,slackM:summary(slacks),
        positiveBoundCells:Array.from(lower).filter(x=>x>0).length,totalCells:lower.length,
        highestBound:{cellId:highestBound,lowerM:lower[highestBound],direction:cellDir(highestBound,cells)},
        finalTileSamples:tileSamples,finalTileViolations:tileViolations,maxFinalDeficitM:tileMaxDeficit},
    rollbackComparison,water,tiles:{addresses:addresses.map(String),types:fullTypes,size:SIZE,
        cold:tileCold,warm:tileRounds,sharedCostPerConsumerNote:'Add coarse generation cost divided by actual consumers; readback diagnostics excluded from normal generation.',
        adjacentTileHeightDifferenceM:edgeMaxDifferenceM,regenerationCountPerRound:addresses.length},
    gpuErrors:errors,notes:['GPU timestamp totals include compute passes only; wall totals include host work, queue waits, copies and readbacks.',
        'Full tile timing excludes first-three splat diagnostic probes in both modes. Driver shader caches are not forcibly cleared.',
        'Warm-up/compilation listed separately. Native in-process worker; no IndexedDB cache. Per-river totals include required lake solves and valley bake.',
        'No net savings are allocated to richer terrain in this increment. Coarse terrain is off by default pending visual assessment.']};
fs.writeFileSync(`${output}/benchmark-${cells}.json`,JSON.stringify(report,null,2));
console.log(JSON.stringify({setupWallMs,coarseColdMs:coarseCold.wallMs,coarseWarmMs:summary(coarseWarm.map(x=>x.wallMs)),
    error:report.error,bounds:report.bounds,rollbackComparison,water:water.map(x=>({mode:x.mode,startMs:x.start.wallMs,rivers:x.rivers.map(r=>({id:r.id,totalMs:r.total.wallMs}))})),
    fullTileBatchWarm:Object.fromEntries(Object.entries(tileRounds).map(([mode,v])=>[mode,{wallMs:summary(v.map(x=>x.wallMs)),gpuMs:summary(v.map(x=>x.gpuMs))}])),gpuErrors:errors.length},null,2));
if(errors.length||deficits||tileViolations)throw new Error('Native generation validation failed; inspect benchmark JSON');
process.exit(0);
