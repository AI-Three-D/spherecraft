/* global process */
import fs from 'node:fs';
import {setupLab} from '../../../terrain-lab/labsetup.mjs';
import {HIGHLAND_BASIN_CASE,VALLEY_FEATURE_CASE} from './structuredBasinCases.mjs';

const started=performance.now(),{device,gen,imp,engineConfig,planetConfig,profiler,collectProfile}=await setupLab(process.argv[2]??'.');
const errors=[];device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
const {WaterService}=await imp('core/world/hydrology/WaterService.js');
const {WaterGpuData}=await imp('core/world/water/WaterGpuData.js');
const {createHydrologySampler}=await imp('core/world/hydrology/HydrologyGrid.js');
const {tangentBasis}=await imp('core/world/hydrology/lakeRefine.js');
const {dirToFaceUV}=await imp('core/world/hydrology/waterGraph.js');
const {TileGenerator}=await imp('core/world/quadtree/tileGenerator.js');
const {TileAddress}=await imp('core/world/quadtree/tileAddress.js');
const feature=process.argv.includes('--feature'),valleys=process.argv.includes('--valleys'),highland=process.argv.includes('--highland')||valleys||feature;
const output=process.env.BASIN_OUTPUT??`tools/perf/structured-terrain-results/${feature?'valley-feature':valleys?'basin-valleys':highland?'basin-highland':'basin-bank-reach'}`;fs.mkdirSync(output,{recursive:true});
const prior=JSON.parse(fs.readFileSync('tools/perf/structured-terrain-results/benchmark-256.json'));
const R=planetConfig.radius,opts={cells:256,seamCells:4,basins:{enabled:true,...(feature?VALLEY_FEATURE_CASE:highland?HIGHLAND_BASIN_CASE:{})},...(valleys?{placement:{enabled:true}}:{}),...(feature?{valley:{enabled:true}}:{})};
const setupWallMs=performance.now()-started;
const processMemoryAfterSetup=process.memoryUsage();
// Declared allocation payloads for the COMPLETE measured workload, including
// water capacity and transient planning/fine/readback allocations. Driver
// overhead and generator setup preceding this monitor are not included.
const memory={liveBytes:0,peakBytes:0,createdBytes:0,byLabel:{}};
for(const method of ['createBuffer','createTexture']) {
    const original=device[method].bind(device);
    device[method]=descriptor=>{
        const resource=original(descriptor),d=descriptor.size;
        const size=Array.isArray(d)?d:[d.width,d.height??1,d.depthOrArrayLayers??1];
        const bpp={r8unorm:1,rgba8unorm:4,rgba8uint:4,rgba32float:16,r32float:4,rg32float:8,rgba16float:8,r16float:2}[descriptor.format];
        const bytes=method==='createBuffer'?d:size.reduce((a,b)=>a*b,1)*bpp;
        if(!Number.isFinite(bytes)) throw new Error(`Memory monitor unsupported format ${descriptor.format}`);
        memory.liveBytes+=bytes;memory.createdBytes+=bytes;memory.peakBytes=Math.max(memory.peakBytes,memory.liveBytes);
        const label=descriptor.label??'(unlabelled)';memory.byLabel[label]=(memory.byLabel[label]??0)+bytes;
        const destroy=resource.destroy.bind(resource);let destroyed=false;
        resource.destroy=()=>{if(!destroyed){memory.liveBytes-=bytes;destroyed=true;}destroy();};
        return resource;
    };
}
async function timed(fn) {
    profiler.enabled=true;const t=performance.now(),value=await fn();await device.queue.onSubmittedWorkDone();
    const wallMs=performance.now()-t;profiler.enabled=false;
    const passes=[...await collectProfile()].map(([label,v])=>({label,n:v.n,ms:v.ns/1e6}));
    return {value,wallMs,gpuMs:passes.reduce((a,p)=>a+p.ms,0),passes};
}
const cost=r=>{const {value:_value,...rest}=r;return rest;};
const roots=await timed(()=>gen.prepareRegionalTerrain(opts));
const regional=roots.value,basin=regional.basins[0];
let qt=null,quadtreeInitialization=null;
const camera={position:{x:basin.centre[0]*(R+basin.levelM+200),y:basin.centre[1]*(R+basin.levelM+200),z:basin.centre[2]*(R+basin.levelM+200)}};
if(highland) {
    const {QuadtreeGPU}=await imp('core/world/quadtree/QuadtreeGPU.js');
    quadtreeInitialization=await timed(async()=>{
        qt=new QuadtreeGPU(device,{...engineConfig.gpuQuadtree,planetRadius:R,planetOrigin:planetConfig.origin,
            minTileSize:engineConfig.gpuQuadtree.minTileSizeMeters,loadedTableCapacity:engineConfig.gpuQuadtree.tileHashCapacity,
            maxFeedback:engineConfig.gpuQuadtree.feedbackCapacity,screenHeight:900,regionalTerrain:regional,
            enableFrustumCulling:false,enableHorizonCulling:false});
        await qt.initialize();qt.updateUniforms(camera);qt.traverse();
    });
}
const compareAccepted=process.argv.includes('--bank-comparison');
const acceptedBasin=compareAccepted?JSON.parse(fs.readFileSync('tools/perf/structured-terrain-results/basin-banks/benchmark.json')).basin:null;
if(acceptedBasin&&(acceptedBasin.cell!==basin.cell||acceptedBasin.levelM!==basin.levelM
    || acceptedBasin.radiusM!==basin.radiusM||JSON.stringify(acceptedBasin.axis)!==JSON.stringify(basin.axis))) {
    throw new Error('Accepted-bank comparison must retain the same site, water level, radius and orientation');
}
gen._quadtreeSplatDiagCount=3;gen._quadtreeSplatProbePassCount=3;gen._quadtreeSplatPrimeCount=3;
const tileGen=new TileGenerator(gen,{textureSize:128,requiredTypes:prior.tiles.types,
    textureFormats:{height:'r32float',normal:'rgba8unorm',tile:'r8unorm'},quadtreeMaxDepth:11,maxGeomLOD:6,enableSplat:true});
async function fine(addresses=prior.tiles.addresses) {
    for(const address of addresses) {
        const textures=await tileGen.generateTile(TileAddress.fromString(address));
        for(const t of new Set(Object.values(textures).map(t=>t?._gpuTexture?.texture).filter(Boolean))) t.destroy();
    }
}
async function water() {
    const svc=new WaterService({device,terrainGenerator:gen,planetConfig,useWorker:false,config:{cache:false}});
    const gpu=new WaterGpuData(device,{gridN:svc.config.gridN,planetRadius:R,carve:svc.config.carve,valley:svc.config.valley});
    await svc.start();
    const b=gen.regionalTerrain.basins[0],cam={x:b.centre[0]*(R+b.levelM+200),y:b.centre[1]*(R+b.levelM+200),z:b.centre[2]*(R+b.levelM+200)};
    gpu.update(svc,cam,0);await device.queue.onSubmittedWorkDone();return {svc,gpu};
}
const waterCold=await timed(water),firstFine=await timed(()=>fine());
const completeColdThroughSevenFineMs=performance.now()-started;
const key=regional.sourceKey,regen=[];
for(let i=0;i<3;i++) {
    const oldWater=waterCold.value;
    const rec=await timed(async()=>{
        await gen.prepareRegionalTerrain(opts,{regenerate:true});
        if(qt) {qt.setRegionalTerrain(gen.regionalTerrain);qt.updateUniforms(camera);qt.traverse();}
        waterCold.value=await water();oldWater.gpu.destroy();await fine();
    });
    if(gen.regionalTerrain.sourceKey!==key) throw new Error('Regeneration changed basin identity/level');
    regen.push({...cost(rec),root:gen.regionalTerrain.timings});
}
const fineWarm=await timed(()=>fine());
// Dense natural and constructed inspection, using the exact same coarse
// controls. The lab count toggle isolates the intentional basin cut.
const sampler=await createHydrologySampler({device,terrainGenerator:gen});
const inputParams=gen.regionalTerrain.bindGroupEntries.find(e=>e.binding===2).resource.buffer;
const basinBuffer=gen.regionalTerrain.bindGroupEntries.find(e=>e.binding===3).resource.buffer;
const featureCount=feature?1:0;
const writeBasin=b=>device.queue.writeBuffer(basinBuffer,0,new Float32Array([...b.centre,b.radiusM,
    b.levelM,b.depthM,b.rimM,b.lowerM,...b.axis,b.centreCutM,...b.radialControls.flat()]));
const frame={c:basin.centre,...tangentBasis(basin.centre),x0:-160,y0:-160,spacing:1,nx:320,ny:320};
device.queue.writeBuffer(inputParams,0,new Float32Array([256,4,0,featureCount]));
const natural=await sampler.samplePatch(frame,R);
const fineWithoutBasin=await timed(()=>fine());
device.queue.writeBuffer(inputParams,0,new Float32Array([256,4,1,featureCount]));
const carved=await sampler.samplePatch(frame,R);
let acceptedCarved=null;
if(acceptedBasin) {
    writeBasin(acceptedBasin);acceptedCarved=await sampler.samplePatch(frame,R);writeBasin(basin);
}
let raised=0,changedOutside=0,wetFailures=0,deficits=0,wetSamples=0,rimSamples=0,minRim=Infinity,maxCut=0;
for(let j=0;j<320;j++) for(let i=0;i<320;i++) {
    const k=j*320+i,r=Math.hypot(frame.x0+(i+.5),frame.y0+(j+.5));
    if(r>=basin.radiusM&&r<=basin.radiusM+6&&natural[k]<basin.lowerM) deficits++;
    if(carved[k]>natural[k]+.02) raised++;
    if(r>basin.radiusM+1&&Math.abs(carved[k]-natural[k])>.02) changedOutside++;
    if(r<=basin.coreRadiusM) {wetSamples++;if(carved[k]>basin.levelM-basin.depthM) wetFailures++;}
    if(r>=basin.radiusM+2&&r<=basin.radiusM+6) {rimSamples++;minRim=Math.min(minRim,carved[k]-gen.regionalTerrain.budgets.microM-basin.levelM);}
    maxCut=Math.max(maxCut,natural[k]-carved[k]);
}
// Diagnostic shoreline extent and dry-bank grades from the same dense base
// samples. These describe shape, not the continuous containment proof.
const bilinear=(field,x,y)=>{
    const u=x-frame.x0-.5,v=y-frame.y0-.5,i=Math.floor(u),j=Math.floor(v),tx=u-i,ty=v-j;
    const a=field[j*320+i]*(1-tx)+field[j*320+i+1]*tx;
    const b=field[(j+1)*320+i]*(1-tx)+field[(j+1)*320+i+1]*tx;
    return a*(1-ty)+b*ty;
};
const measureBankShape=field=>{
const shoreRadiiM=[],bankGrades=[];
for(let a=0;a<128;a++) {
    const angle=a*2*Math.PI/128,c=Math.cos(angle),s=Math.sin(angle);
    let shore=0;
    for(let r=basin.coreRadiusM;r<=basin.radiusM;r+=.5) if(bilinear(field,c*r,s*r)<=basin.levelM) shore=r;
    shoreRadiiM.push(shore);
    for(const offset of [3,8,15]) {
        const x=c*(shore+offset),y=s*(shore+offset);
        if(Math.hypot(x,y)>basin.radiusM) continue;
        const gx=(bilinear(field,x+1,y)-bilinear(field,x-1,y))/2;
        const gy=(bilinear(field,x,y+1)-bilinear(field,x,y-1))/2;
        bankGrades.push(Math.hypot(gx,gy));
    }
}
const distribution=values=>{const v=values.toSorted((a,b)=>a-b);return {min:v[0],p10:v[Math.floor(v.length*.1)],
    median:v[Math.floor(v.length*.5)],p90:v[Math.floor(v.length*.9)],max:v.at(-1)};};
return {shoreRadiusM:distribution(shoreRadiiM),dryBankGrade:distribution(bankGrades),shoreRadiiM,
    notes:'128 radial base-height probes, 0.5m spacing; grades at 3/8/15m beyond the last wet sample. Final micro is assessed in production images/tiles.'};
};
const bankShape=measureBankShape(carved);
const acceptedBankShape=acceptedCarved?measureBankShape(acceptedCarved):null;
const bankComparison=acceptedBankShape?{
    acceptedBankShape,
    outerReachExtensionsM:basin.radialControls.map((p,j)=>(p[1]-acceptedBasin.radialControls[j][1])*basin.radiusM),
    shoreRadiusChangesM:bankShape.shoreRadiiM.map((r,j)=>r-acceptedBankShape.shoreRadiiM[j]),
}:null;
// Inspect complete production final-height textures (including tile micro)
// over the actual basin, covering several refined quadtree descendants.
const {face,u,v}=dirToFaceUV(basin.centre),depth=10,grid=2**depth,tx=Math.floor(u*grid),ty=Math.floor(v*grid);
let finalWetFailures=0,finalWetSamples=0,finalRimFailures=0,finalSamples=0;
let minimumFinalRimClearanceM=Infinity,minimumFinalWetDepthM=Infinity;
const actualAddresses=[];
const finalStarted=performance.now();
for(let y=ty-1;y<=ty+1;y++) for(let x=tx-1;x<=tx+1;x++) {
    const address=new TileAddress(face,depth,x,y);actualAddresses.push(address.toString());
    const textures=await tileGen.generateTile(address),texture=textures.height._gpuTexture.texture;
    const row=128*4,rb=device.createBuffer({size:row*128,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    const encoder=device.createCommandEncoder();encoder.copyTextureToBuffer({texture},{buffer:rb,bytesPerRow:row},[128,128]);
    device.queue.submit([encoder.finish()]);await rb.mapAsync(GPUMapMode.READ);
    const heights=new Float32Array(rb.getMappedRange());
    const {faceUVToDir}=await imp('core/world/hydrology/waterGraph.js');
    for(let j=0;j<128;j++) for(let i=0;i<128;i++) {
        const d=faceUVToDir(face,(x+i/127)/grid,(y+j/127)/grid);
        const dot=d.reduce((s,a,k)=>s+a*basin.centre[k],0);
        const tangent=d.map((a,k)=>a-basin.centre[k]*dot),distance=R*Math.hypot(...tangent)/dot;
        const h=heights[j*128+i]*planetConfig.maxTerrainHeight;finalSamples++;
        if(distance<=basin.coreRadiusM) {finalWetSamples++;minimumFinalWetDepthM=Math.min(minimumFinalWetDepthM,basin.levelM-h);if(h>basin.levelM-basin.depthM) finalWetFailures++;}
        if(distance>=basin.radiusM+2&&distance<=basin.radiusM+6) {minimumFinalRimClearanceM=Math.min(minimumFinalRimClearanceM,h-basin.levelM);if(h<basin.levelM+basin.rimM) finalRimFailures++;}
    }
    rb.unmap();rb.destroy();
    for(const t of new Set(Object.values(textures).map(t=>t?._gpuTexture?.texture).filter(Boolean))) t.destroy();
}
const finalTilesAndReadbackMs=performance.now()-finalStarted;
// Equivalent addresses/outputs over the lake itself, interleaved to expose
// warm workload variance. Earlier seven-tile timings mainly cover spawn.
const equivalentBasinFine=[];
for(let i=0;i<2;i++) {
    for(const enabled of [false,true]) {
        device.queue.writeBuffer(inputParams,0,new Float32Array([256,4,enabled?1:0,featureCount]));
        equivalentBasinFine.push({enabled,...cost(await timed(()=>fine(actualAddresses)))});
    }
}
const equivalentAcceptedBankFine=[];
if(acceptedBasin) {
    for(let i=0;i<2;i++) for(const reference of [true,false]) {
        writeBasin(reference?acceptedBasin:basin);
        equivalentAcceptedBankFine.push({reference,...cost(await timed(()=>fine(actualAddresses)))});
    }
}
const processMemoryFinal=process.memoryUsage();
const report={setupWallMs,completeColdThroughSevenFineMs,roots:cost(roots),rootTimings:regional.timings,
    quadtreeInitialization:quadtreeInitialization?cost(quadtreeInitialization):null,quadtreeBufferBytes:qt?.getStats().gpuMemoryBytes??0,
    waterPublication:cost(waterCold),firstSevenCompleteTiles:cost(firstFine),completeRegeneration:regen,
    sevenFineWarm:cost(fineWarm),sevenFineBasinDisabledSameInputs:cost(fineWithoutBasin),basin,basinPlan:regional.basinPlan,
    contract:{naturalSamples:natural.length,deficits,raised,changedOutside,wetSamples,wetFailures,rimSamples,
        minimumRimBaseClearanceM:minRim+gen.regionalTerrain.budgets.microM,
        looseGlobalMicroRimClearanceM:minRim,maxCutM:maxCut,finalSamples,finalWetSamples,finalWetFailures,finalRimFailures,
        minimumFinalRimClearanceM,minimumFinalWetDepthM},bankShape,bankComparison,equivalentBasinFine,equivalentAcceptedBankFine,
    finalTilesAndReadbackMs,actualAddresses,rootResidentBytes:regional.byteLength,placementSurvey:regional.placementData?{cells:regional.placementData.cells,byteLength:regional.placementData.byteLength,candidateCount:regional.placementData.candidates.length,proposals:regional.placementData.proposals,timings:regional.placementData.timings}:null,
    valleyFeature:regional.valleyFeature,allocationPayload:memory,processMemory:{afterSetup:processMemoryAfterSetup,final:processMemoryFinal,
        largestObservedRssBytes:Math.max(processMemoryAfterSetup.rss,processMemoryFinal.rss),
        resourceUsageMaxRssBytes:process.resourceUsage().maxRSS*1024},gpuErrors:errors,notes:['Complete regeneration includes six roots, local planning/readback, water allocation/publication, seven full-output tiles and the final queue fence.',
        'First-use driver caches are uncontrolled. No river is generated in this one-basin visual increment.',
        'The lower certificate covers the continuous outer annulus, not the interior. Final tile inspection includes production tile micro. Dense natural inspection omits micro; its loose global-budget clearance is diagnostic only because the proof uses tighter local material envelopes.',
        'Process RSS includes native driver/unified allocations and is sampled at setup/end, not continuously. The OS resource counter is reported separately. Do not add RSS to the declared GPU payload.',
        'The highland workload also includes quadtree allocation/compilation/first selection and a selection after each replacement. The seven complete output tiles are fixed benchmark addresses; live streaming/culling costs are measured by the browser.',
        'Whole live-game peak memory and first visible water need browser evidence; root payload is not total memory.']};
fs.writeFileSync(`${output}/benchmark.json`,JSON.stringify(report,null,2));
console.log(JSON.stringify({completeColdThroughSevenFineMs,rootsMs:roots.wallMs,regenMs:regen.map(r=>r.wallMs),
    waterMs:waterCold.wallMs,basin,contract:report.contract,gpuErrors:errors},null,2));
sampler.destroy();waterCold.value.gpu.destroy();
qt?.dispose();
process.exit(errors.length||deficits||raised||changedOutside||wetFailures||finalWetFailures||finalRimFailures?1:0);
