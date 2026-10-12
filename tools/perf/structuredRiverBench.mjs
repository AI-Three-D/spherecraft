/* global process */
import fs from 'node:fs';
import crypto from 'node:crypto';
import {setupLab} from '../../../terrain-lab/labsetup.mjs';

const started=performance.now(),{device,gen,imp,engineConfig,planetConfig}=await setupLab(process.argv[2]??'.');
const errors=[];device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
const {WaterService}=await imp('core/world/hydrology/WaterService.js');
const {WaterGpuData}=await imp('core/world/water/WaterGpuData.js');
const {structuredWaterGpuCapacity}=await imp('core/world/water/structuredWaterGpuCapacity.js');
const {createHydrologySampler}=await imp('core/world/hydrology/HydrologyGrid.js');
const {riverShapeAt,riverBankExtent}=await imp('core/world/water/riverShapeNoise.js');
const {dirToFaceUV}=await imp('core/world/hydrology/waterGraph.js');
const {TileGenerator}=await imp('core/world/quadtree/tileGenerator.js');
const {TileAddress}=await imp('core/world/quadtree/tileAddress.js');
const output=process.env.RIVER_OUTPUT??'tools/perf/structured-terrain-results/coarse-river';fs.mkdirSync(output,{recursive:true});
const prior=JSON.parse(fs.readFileSync('tools/perf/structured-terrain-results/benchmark-256.json'));
const R=planetConfig.radius,opts={cells:256,seamCells:4,basins:{enabled:true},drainage:{enabled:true}};
let bankDetail=Number(process.env.RIVER_BANK_DETAIL??0);
function setBankDetail(value) {
    bankDetail=value;
    gen.terrainConfig.waterGraph={...gen.terrainConfig.waterGraph,
        carve:{...gen.terrainConfig.waterGraph?.carve,bankDetail}};
}
setBankDetail(bankDetail);
if(process.argv.includes('--mountain')) {
    opts.shape={enabled:true,face:0,depth:7,x:102,y:114,receiverRegion:{dx:-1,dy:0,minLevelM:100}};
    Object.assign(opts.drainage,{profile:'terrain',minimumDropM:40,minDistanceM:1800,halfWidthM:4,spacingM:32});
}
if(process.env.RIVER_FALL_EXTRA!=null)opts.drainage.fallExtraCutM=Number(process.env.RIVER_FALL_EXTRA);
if(process.env.RIVER_COURSE)opts.drainage.course=process.env.RIVER_COURSE;
if(process.env.RIVER_HEIGHT_SOURCE)opts.drainage.heightSource=process.env.RIVER_HEIGHT_SOURCE;
if(process.argv.includes('--large-lake')) {
    opts.shape={enabled:true,face:1,depth:6,x:40,y:20,cells:256,minLevelM:100,
        minimumEnclosureM:0,maxRadiusM:1000,maxPotentialCells:8192,minWetCells:256,surfaceCells:128,
        depression:{radiusM:450,maxCutM:8,depthM:2.5,seed:17,profile:'organic'}};
    Object.assign(opts.drainage,{profile:'terrain',minimumDropM:2,minDistanceM:4000,maxDistanceM:8000,
        halfWidthM:12,spacingM:128,profileStepM:16});
}
const setupWallMs=performance.now()-started;
const processMemoryAfterSetup=process.memoryUsage();
// Declared allocation payloads for the COMPLETE measured workload, including
// water capacity and transient planning/fine/readback allocations. Driver
// overhead and generator setup preceding this monitor are not included.
const memory={liveBytes:0,peakBytes:0,createdBytes:0,byLabel:{}};
let allocationWindow=null;
for(const method of ['createBuffer','createTexture']) {
    const original=device[method].bind(device);
    device[method]=descriptor=>{
        const resource=original(descriptor),d=descriptor.size;
        const size=Array.isArray(d)?d:[d.width,d.height??1,d.depthOrArrayLayers??1];
        const bpp={r8unorm:1,rgba8unorm:4,rgba8uint:4,rgba32float:16,r32float:4,rg32float:8,rgba16float:8,r16float:2}[descriptor.format];
        const bytes=method==='createBuffer'?d:size.reduce((a,b)=>a*b,1)*bpp;
        if(!Number.isFinite(bytes)) throw new Error(`Memory monitor unsupported format ${descriptor.format}`);
        memory.liveBytes+=bytes;memory.createdBytes+=bytes;memory.peakBytes=Math.max(memory.peakBytes,memory.liveBytes);
        if(allocationWindow)allocationWindow.peakBytes=Math.max(allocationWindow.peakBytes,memory.liveBytes);
        const label=descriptor.label??'(unlabelled)';memory.byLabel[label]=(memory.byLabel[label]??0)+bytes;
        const destroy=resource.destroy.bind(resource);let destroyed=false;
        resource.destroy=()=>{if(!destroyed){memory.liveBytes-=bytes;destroyed=true;}destroy();};
        return resource;
    };
}
async function timed(fn) {
    const t=performance.now(),value=await fn();await device.queue.onSubmittedWorkDone();
    return {value,wallMs:performance.now()-t};
}
const cost=r=>({wallMs:r.wallMs});
let roots;
try{roots=await timed(()=>gen.prepareRegionalTerrain(opts));}
catch(error){
    fs.writeFileSync(`${output}/rejected.json`,JSON.stringify({options:opts,message:String(error),
        completeAttemptMs:performance.now()-started,setupWallMs,allocationPayload:memory,gpuErrors:errors},null,2));
    throw error;
}
const regional=roots.value,basin=regional.basins[0];
fs.writeFileSync(`${output}/topology.json`,JSON.stringify({options:opts,topology:regional.drainagePlan.topology,
    river:regional.drainagePlan.rivers[0]},(_,v)=>ArrayBuffer.isView(v)?Array.from(v):v,2));
if(process.argv.includes('--plan-only')) {
    const report={completeColdMs:performance.now()-started,setupWallMs,root:regional.timings,
        basins:regional.basins,river:regional.drainagePlan.rivers[0],rootResidentBytes:regional.byteLength,
        cpuPlanningBytes:regional.cpuPlanningBytes,allocationPayload:memory,gpuErrors:errors};
    fs.writeFileSync(`${output}/plan.json`,JSON.stringify(report,null,2));
    console.log(JSON.stringify({completeColdMs:report.completeColdMs,root:report.root,basins:report.basins.map(b=>({id:b.id,levelM:b.levelM,radiusM:b.radiusM})),
        river:report.river.profile,points:report.river.points.length/report.river.stride,gpuErrors:errors},null,2));
    await regional.destroy();process.exit(errors.length?1:0);
}
let qt=null,quadtreeInitialization=null;
const camera={position:{x:basin.centre[0]*(R+basin.levelM+200),y:basin.centre[1]*(R+basin.levelM+200),z:basin.centre[2]*(R+basin.levelM+200)}};
{
    const {QuadtreeGPU}=await imp('core/world/quadtree/QuadtreeGPU.js');
    quadtreeInitialization=await timed(async()=>{
        qt=new QuadtreeGPU(device,{...engineConfig.gpuQuadtree,planetRadius:R,planetOrigin:planetConfig.origin,
            minTileSize:engineConfig.gpuQuadtree.minTileSizeMeters,loadedTableCapacity:engineConfig.gpuQuadtree.tileHashCapacity,
            maxFeedback:engineConfig.gpuQuadtree.feedbackCapacity,screenHeight:900,regionalTerrain:regional,
            enableFrustumCulling:false,enableHorizonCulling:false});
        await qt.initialize();qt.updateUniforms(camera);qt.traverse();
    });
}

gen._quadtreeSplatDiagCount=3;gen._quadtreeSplatProbePassCount=3;gen._quadtreeSplatPrimeCount=3;
const tileGen=new TileGenerator(gen,{textureSize:128,requiredTypes:prior.tiles.types,
    textureFormats:{height:'r32float',normal:'rgba8unorm',tile:'r8unorm'},quadtreeMaxDepth:11,maxGeomLOD:6,enableSplat:true});
const initialRiver=regional.drainagePlan.rivers[0],initialCount=initialRiver.points.length/initialRiver.stride;
const routeSites=[0,Math.floor(initialCount/2),initialCount-1],addresses=[];
for(const k of routeSites) {
    const d=Array.from(initialRiver.points.slice(k*initialRiver.stride,k*initialRiver.stride+3)),{face,u,v}=dirToFaceUV(d),depth=11,n=2**depth;
    addresses.push(new TileAddress(face,depth,Math.floor(u*n),Math.floor(v*n)).toString());
}
const completeAddresses=[...new Set([...prior.tiles.addresses,...addresses])];
async function fine(addresses=completeAddresses) {
    for(const address of addresses) {
        const textures=await tileGen.generateTile(TileAddress.fromString(address));
        for(const t of new Set(Object.values(textures).map(t=>t?._gpuTexture?.texture).filter(Boolean))) t.destroy();
    }
}
let structuredRiverSurface=process.env.RIVER_SURFACE!=='0';
let structuredRiverBody=true;
async function water() {
    const svc=new WaterService({device,terrainGenerator:gen,planetConfig,useWorker:false,config:{cache:false,carve:{bankDetail}}});
    await svc.start();const before=memory.liveBytes;
    const gpu=new WaterGpuData(device,{gridN:svc.config.gridN,planetRadius:R,
        structuredRiverSurface,
        carve:gen.waterCarve?svc.config.carve:null,valley:gen.riverValley?svc.config.valley:null,
        ...(process.env.WATER_POOLS==='legacy'?{}:structuredWaterGpuCapacity(svc))});
    gpu.look.structuredRiverBody=structuredRiverBody;gpu.update(svc,camera.position,0);await device.queue.onSubmittedWorkDone();
    gen.setWaterCarveResources(gpu.resources);gen.setRiverValleyResources(gpu.valleyResources);
    return {svc,gpu,gpuBytes:memory.liveBytes-before};
}
const waterFirst=await timed(water);let liveWater=waterFirst.value;
console.log('[river] shared + water ready',performance.now()-started);
const firstFine=await timed(()=>fine());
const completeColdThroughTenFineMs=performance.now()-started;
const key=regional.sourceKey,regen=[];
for(let i=0;i<3;i++) {
    let waterStage,fineStage;
    const rec=await timed(async()=>{
        await gen.prepareRegionalTerrain(opts,{regenerate:true});
        qt.setRegionalTerrain(gen.regionalTerrain);qt.updateUniforms(camera);qt.traverse();
        const old=liveWater;waterStage=await timed(water);liveWater=waterStage.value;old.gpu.destroy();fineStage=await timed(()=>fine());
    });
    if(gen.regionalTerrain.sourceKey!==key) throw new Error('Regeneration changed basin/river identity');
    regen.push({...cost(rec),root:gen.regionalTerrain.timings,waterPublication:cost(waterStage),tenCompleteTiles:cost(fineStage)});
    console.log('[river] complete regeneration',i,rec.wallMs);
}
const certificateCosts=[];
if(process.argv.includes('--certificate-cost')) for(let round=0;round<3;round++) for(const reuse of [false,true]) {
    gen._regionalCertificateReuse=reuse;const old=liveWater;
    const r=await timed(async()=>{
        await gen.prepareRegionalTerrain(opts,{regenerate:true});qt.setRegionalTerrain(gen.regionalTerrain);qt.updateUniforms(camera);qt.traverse();
        const p=await timed(water);liveWater=p.value;old.gpu.destroy();await fine();
    });
    if(gen.regionalTerrain.sourceKey!==key) throw new Error('Certificate pipeline reuse changed basin/river identity');
    certificateCosts.push({round,reuse,completeMs:r.wallMs,root:gen.regionalTerrain.timings});
}
const surfaceCosts=[];
if(process.argv.includes('--surface-cost')||process.argv.includes('--body-cost')) for(let round=0;round<4;round++) for(const enabled of (round%2?[true,false]:[false,true])) {
    if(process.argv.includes('--body-cost'))structuredRiverBody=enabled;else structuredRiverSurface=enabled;
    const old=liveWater;
    const r=await timed(async()=>{
        await gen.prepareRegionalTerrain(opts,{regenerate:true});qt.setRegionalTerrain(gen.regionalTerrain);qt.updateUniforms(camera);qt.traverse();
        const p=await timed(water);liveWater=p.value;old.gpu.destroy();await fine();
    });
    if(gen.regionalTerrain.sourceKey!==key)throw new Error('Distant surface flag changed terrain/river identity');
    surfaceCosts.push({round,enabled,field:process.argv.includes('--body-cost')?'structuredRiverBody':'structuredRiverSurface',
        completeMs:r.wallMs,root:gen.regionalTerrain.timings});
}
const readbackCosts=[];
if(process.argv.includes('--readback-cost'))for(let round=0;round<4;round++)for(const full of (round%2?[false,true]:[true,false])) {
    gen._regionalFullReadback=full;const old=liveWater;
    const r=await timed(async()=>{
        await gen.prepareRegionalTerrain(opts,{regenerate:true});qt.setRegionalTerrain(gen.regionalTerrain);qt.updateUniforms(camera);qt.traverse();
        const p=await timed(water);liveWater=p.value;old.gpu.destroy();await fine();
    });
    if(gen.regionalTerrain.sourceKey!==key)throw new Error('Local readback changed basin/river identity');
    readbackCosts.push({round,full,completeMs:r.wallMs,root:gen.regionalTerrain.timings});
}
const lodCosts=[];
if(process.argv.includes('--lod-cost'))for(let round=0;round<4;round++)for(const enabled of (round%2?[true,false]:[false,true])) {
    qt.regionalShapeLod=enabled;const old=liveWater;
    const r=await timed(async()=>{
        await gen.prepareRegionalTerrain(opts,{regenerate:true});qt.setRegionalTerrain(gen.regionalTerrain);qt.updateUniforms(camera);qt.traverse();
        const p=await timed(water);liveWater=p.value;old.gpu.destroy();await fine();
    });
    if(gen.regionalTerrain.sourceKey!==key)throw new Error('LOD position input changed terrain/river identity');
    lodCosts.push({round,enabled,completeMs:r.wallMs,root:gen.regionalTerrain.timings});
}
const foundationCosts=[];
if(process.argv.includes('--foundation-cost'))for(let round=0;round<4;round++)for(const reuse of (round%2?[true,false]:[false,true])) {
    const old=liveWater,previous=gen.regionalTerrain.foundation;
    const stages={};
    async function stage(name,fn) {
        allocationWindow={liveBefore:memory.liveBytes,peakBytes:memory.liveBytes};const before=memory.createdBytes;
        const r=await timed(fn);stages[name]={...cost(r),...allocationWindow,liveAfter:memory.liveBytes,createdBytes:memory.createdBytes-before};
        allocationWindow=null;return r.value;
    }
    const measured=await timed(async()=>{
        await stage('foundationAndFeatures',()=>gen.prepareRegionalTerrain(opts,{regenerate:true,reuseFoundation:reuse}));
        qt.setRegionalTerrain(gen.regionalTerrain);qt.updateUniforms(camera);qt.traverse();
        liveWater=await stage('waterPublication',water);old.gpu.destroy();await stage('fineOutputs',()=>fine());
    });
    if(gen.regionalTerrain.sourceKey!==key||reuse!==(gen.regionalTerrain.foundation===previous))throw new Error('Foundation reuse changed generation identity or failed to share inputs');
    // Outside measured generation: compare every byte of the complete output
    // textures, excluding row padding. Same audit on both modes/rounds.
    const digest=crypto.createHash('sha256');
    for(const str of completeAddresses) {
        const textures=await tileGen.generateTile(TileAddress.fromString(str)),seen=new Set();digest.update(str);
        for(const [name,wrapper] of Object.entries(textures)) {
            const texture=wrapper?._gpuTexture?.texture;if(!texture||seen.has(texture))continue;seen.add(texture);
            if(!(texture.usage&GPUTextureUsage.COPY_SRC))throw new Error(`Diagnostic output ${name} cannot be read back`);
            const bpp={r8unorm:1,rgba8unorm:4,rgba8uint:4,r32float:4,rgba16float:8,rgba32float:16}[texture.format];
            if(!bpp||texture.depthOrArrayLayers!==1)throw new Error(`Unsupported diagnostic output ${name}/${texture.format}`);
            const row=texture.width*bpp,pitch=Math.ceil(row/256)*256;
            const rb=device.createBuffer({size:pitch*texture.height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
            const enc=device.createCommandEncoder();enc.copyTextureToBuffer({texture},{buffer:rb,bytesPerRow:pitch},[texture.width,texture.height]);
            device.queue.submit([enc.finish()]);await rb.mapAsync(GPUMapMode.READ);const bytes=new Uint8Array(rb.getMappedRange());
            digest.update(name);for(let y=0;y<texture.height;y++)digest.update(bytes.subarray(y*pitch,y*pitch+row));rb.unmap();rb.destroy();
        }
        for(const texture of seen)texture.destroy();
    }
    const outputSha256=digest.digest('hex');
    if(foundationCosts.length&&outputSha256!==foundationCosts[0].outputSha256)throw new Error('Foundation reuse changed complete generated texture bytes');
    foundationCosts.push({round,reuse,completeMs:measured.wallMs,root:gen.regionalTerrain.timings,stages,outputSha256,
        peakBytes:Math.max(...Object.values(stages).map(s=>s.peakBytes))});
    console.log('[river] foundation comparison',round,reuse,measured.wallMs,outputSha256);
}
const bankCosts=[];
if(process.argv.includes('--bank-cost')) {
    const original=bankDetail;
    // Compile both shader families before the warm paired comparison.
    for(const detail of [0,1]) {
        setBankDetail(detail);const old=liveWater;await gen.prepareRegionalTerrain(opts,{regenerate:true});
        qt.setRegionalTerrain(gen.regionalTerrain);liveWater=(await timed(water)).value;old.gpu.destroy();await fine();
    }
    for(let round=0;round<5;round++) for(const detail of (round%2?[1,0]:[0,1])) {
        setBankDetail(detail);
        const old=liveWater;allocationWindow={liveBefore:memory.liveBytes,peakBytes:memory.liveBytes};
        let fineStage,publication;
        const r=await timed(async()=>{
            await gen.prepareRegionalTerrain(opts,{regenerate:true});
            qt.setRegionalTerrain(gen.regionalTerrain);qt.updateUniforms(camera);qt.traverse();
            publication=await timed(water);liveWater=publication.value;old.gpu.destroy();
            fineStage=await timed(()=>fine());
        });
        if(gen.regionalTerrain.sourceKey!==key)throw new Error('Bank detail changed regional route identity');
        bankCosts.push({round,bankDetail:detail,completeMs:r.wallMs,root:gen.regionalTerrain.timings,
            publicationMs:publication.wallMs,fineMs:fineStage.wallMs,peakBytes:allocationWindow.peakBytes,
            addresses:completeAddresses,riverSegments:liveWater.gpu.riverSegCount});
        allocationWindow=null;
    }
    setBankDetail(original);
    const old=liveWater;await gen.prepareRegionalTerrain(opts,{regenerate:true});
    qt.setRegionalTerrain(gen.regionalTerrain);liveWater=(await timed(water)).value;old.gpu.destroy();
}
const routingCosts=[];
if(process.argv.includes('--routing-cost')) {
    // Discover the union OUTSIDE timed comparisons. Every measured mode then
    // produces identical tile addresses/types, including both route middles.
    const matched=new Set(completeAddresses),variants=[
        {mode:'coarse-natural',course:'coarse',heightSource:'natural'},
        {mode:'organic-natural',course:'organic',heightSource:'natural'},
        {mode:'organic-foundation',course:'organic',heightSource:'foundation'},
    ];
    for(const variant of variants) {
        const {course,heightSource}=variant;
        await gen.prepareRegionalTerrain({...opts,drainage:{...opts.drainage,course,heightSource}},{regenerate:true});
        const r=gen.regionalTerrain.drainagePlan.rivers[0],n=r.points.length/r.stride;
        for(const k of [0,Math.floor(n/2),n-1]) {
            const {face,u,v}=dirToFaceUV(Array.from(r.points.slice(k*r.stride,k*r.stride+3)));
            matched.add(new TileAddress(face,11,Math.floor(u*2048),Math.floor(v*2048)).toString());
        }
    }
    const matchedAddresses=[...matched];
    for(let round=0;round<4;round++)for(const variant of (round%2?[...variants].reverse():variants)) {
        const old=liveWater;allocationWindow={liveBefore:memory.liveBytes,peakBytes:memory.liveBytes};
        let fineStage,publication;
        const r=await timed(async()=>{
            const {course,heightSource}=variant;
            await gen.prepareRegionalTerrain({...opts,drainage:{...opts.drainage,course,heightSource}},{regenerate:true});
            qt.setRegionalTerrain(gen.regionalTerrain);qt.updateUniforms(camera);qt.traverse();
            publication=await timed(water);liveWater=publication.value;old.gpu.destroy();fineStage=await timed(()=>fine(matchedAddresses));
        });
        const current=gen.regionalTerrain,river=current.drainagePlan.rivers[0];
        routingCosts.push({round,...variant,completeMs:r.wallMs,root:current.timings,
            publicationMs:publication.wallMs,fineMs:fineStage.wallMs,peakBytes:allocationWindow.peakBytes,
            addresses:matchedAddresses,sourceKey:current.sourceKey,riverLengthM:river.lengthM,
            riverPoints:river.points.length/river.stride,courseData:river.course??null});
        allocationWindow=null;
    }
    const old=liveWater;
    await gen.prepareRegionalTerrain(opts,{regenerate:true});qt.setRegionalTerrain(gen.regionalTerrain);
    liveWater=(await timed(water)).value;old.gpu.destroy();
}
const rec=gen.regionalTerrain.drainagePlan.rivers[0],count=rec.points.length/rec.stride;
const sampler=await createHydrologySampler({device,terrainGenerator:gen});
await sampler.setWaterCarveResources(liveWater.gpu.resources);await sampler.setRiverValleyResources(liveWater.gpu.valleyResources);
const inputs=[],levels=[];
// Probe the shaped wet centre, ACROSS each segment. An arbitrary tangent
// axis also moves probes downstream on steep reaches and gives the wrong
// comparison water level; it is not a valid waterfall depth test.
const probeArc=liveWater.gpu._arcLengths(rec);
for(let k=0;k<count-1;k++) for(let j=0;j<8;j++) {
    const t=j/8,a=k*rec.stride,b=(k+1)*rec.stride,d=[0,1,2].map(i=>rec.points[a+i]*(1-t)+rec.points[b+i]*t);
    const len=Math.hypot(...d);d.forEach((v,i)=>d[i]=v/len);
    const ab=[0,1,2].map(i=>rec.points[b+i]-rec.points[a+i]);
    const left=[d[1]*ab[2]-d[2]*ab[1],d[2]*ab[0]-d[0]*ab[2],d[0]*ab[1]-d[1]*ab[0]],ll=Math.hypot(...left);
    const shape=riverShapeAt(probeArc[k]+(probeArc[k+1]-probeArc[k])*t,rec.id,rec.points[a+4],liveWater.gpu.carve);
    for(const side of [-.5,0,.5]) {
        const v=d.map((v,i)=>v+left[i]/ll*(shape.off+side)/R),l=Math.hypot(...v);
        inputs.push(...v.map(v=>v/l),0);levels.push(rec.points[a+3]*(1-t)+rec.points[b+3]*t);
    }
}
const dirs=Float32Array.from(inputs),natural=await sampler.sampleDirsNatural(dirs),carved=await sampler.sampleDirsCarved(dirs);
let wetFailures=0,raised=0,maxCutM=0,minDepthM=Infinity;
for(let i=0;i<carved.length;i++) {
    if(carved[i]>levels[i]-.05) wetFailures++;
    if(carved[i]>natural[i]+.02) raised++;
    minDepthM=Math.min(minDepthM,levels[i]-carved[i]);maxCutM=Math.max(maxCutM,natural[i]-carved[i]);
}
let downstreamRises=0;for(let k=1;k<count;k++) if(rec.points[k*rec.stride+3]>rec.points[(k-1)*rec.stride+3]) downstreamRises++;
// Separate diagnostic work: sample the dry banks, not just the wet centre.
const bankDirs=[],bankMeta=[],extents=[];
for(let k=1;k<count-2;k+=3) {
    const a=k*rec.stride,b=(k+1)*rec.stride,d=[0,1,2].map(i=>(rec.points[a+i]+rec.points[b+i])*.5);
    const dl=Math.hypot(...d);d.forEach((v,i)=>d[i]=v/dl);
    const ab=[0,1,2].map(i=>rec.points[b+i]-rec.points[a+i]);
    const left=[d[1]*ab[2]-d[2]*ab[1],d[2]*ab[0]-d[0]*ab[2],d[0]*ab[1]-d[1]*ab[0]],ll=Math.hypot(...left);
    const shape=riverShapeAt((probeArc[k]+probeArc[k+1])*.5,rec.id,(rec.points[a+4]+rec.points[b+4])*.5,liveWater.gpu.carve);
    if(bankDetail)extents.push(riverBankExtent(shape.bankMorphLeft,liveWater.gpu.carve.blendW),riverBankExtent(shape.bankMorphRight,liveWater.gpu.carve.blendW));
    for(const side of [-60,-40,-25,-15,-8,-4,4,8,15,25,40,60]) {
        const v=d.map((x,i)=>x+left[i]/ll*(shape.off+side)/R),l=Math.hypot(...v);
        bankDirs.push(...v.map(v=>v/l),0);bankMeta.push({dryCap:Math.abs(side)>shape.hw*1.45});
    }
}
const bankInputs=Float32Array.from(bankDirs),bankNatural=await sampler.sampleDirsNatural(bankInputs),bankCarved=await sampler.sampleDirsCarved(bankInputs);
const bankAudit={samples:bankMeta.length,raised:0,maxDryBankCutM:0,dryCapFailures:0,
    extentMinM:extents.length?Math.min(...extents):null,extentMaxM:extents.length?Math.max(...extents):null};
for(let i=0;i<bankMeta.length;i++) {
    const cut=bankNatural[i]-bankCarved[i];if(cut<-.02)bankAudit.raised++;
    if(bankMeta[i].dryCap) {bankAudit.maxDryBankCutM=Math.max(bankAudit.maxDryBankCutM,cut);
        if(bankDetail&&cut>6.05)bankAudit.dryCapFailures++;}
}
// Equivalent full-output content and production final-height validation at
// source, middle and receiver. Both variants retain the identical two lakes.
const pairedFine=[];
for(let i=0;i<2;i++) for(const enabled of [false,true]) {
    liveWater.gpu.enabled=enabled;liveWater.gpu.carve.enabled=enabled;liveWater.gpu.update(liveWater.svc,camera.position,0);
    pairedFine.push({enabled,...cost(await timed(()=>fine(addresses)))});
}
liveWater.gpu.enabled=true;liveWater.gpu.carve.enabled=true;liveWater.gpu.update(liveWater.svc,camera.position,0);
const {faceUVToDir}=await imp('core/world/hydrology/waterGraph.js');
let finalWetFailures=0,finalWetSamples=0,finalSamples=0,minFinalDepthM=Infinity;
for(const str of addresses) {
    const address=TileAddress.fromString(str),textures=await tileGen.generateTile(address),texture=textures.height._gpuTexture.texture;
    const rb=device.createBuffer({size:128*128*4,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    const encoder=device.createCommandEncoder();encoder.copyTextureToBuffer({texture},{buffer:rb,bytesPerRow:512},[128,128]);
    device.queue.submit([encoder.finish()]);await rb.mapAsync(GPUMapMode.READ);
    const heights=new Float32Array(rb.getMappedRange()),n=2**address.depth;
    for(let j=0;j<128;j++) for(let i=0;i<128;i++) {
        const d=faceUVToDir(address.face,(address.x+i/127)/n,(address.y+j/127)/n);finalSamples++;
        let best=Infinity,level=0;
        for(let k=0;k<count-1;k++) {
            const a=Array.from(rec.points.slice(k*rec.stride,k*rec.stride+3)),b=Array.from(rec.points.slice((k+1)*rec.stride,(k+1)*rec.stride+3));
            const ab=b.map((v,i)=>v-a[i]),t=Math.max(0,Math.min(1,d.reduce((s,v,i)=>s+(v-a[i])*ab[i],0)/ab.reduce((s,v)=>s+v*v,0)));
            const distance=R*Math.hypot(...d.map((v,i)=>v-a[i]-t*ab[i]));
            if(distance<best) {best=distance;level=rec.points[k*rec.stride+3]*(1-t)+rec.points[(k+1)*rec.stride+3]*t;}
        }
        if(best<=2) {
            const depth=level-heights[j*128+i]*planetConfig.maxTerrainHeight;
            finalWetSamples++;minFinalDepthM=Math.min(minFinalDepthM,depth);if(depth<.05) finalWetFailures++;
        }
    }
    rb.unmap();rb.destroy();for(const t of new Set(Object.values(textures).map(t=>t?._gpuTexture?.texture).filter(Boolean))) t.destroy();
}
const processMemoryFinal=process.memoryUsage();
const outputDigests=[];
if(process.argv.includes('--output-digests'))for(const str of completeAddresses) {
    const textures=await tileGen.generateTile(TileAddress.fromString(str)),seen=new Set();
    for(const [name,wrapper] of Object.entries(textures)) {
        const texture=wrapper?._gpuTexture?.texture;if(!texture||seen.has(texture))continue;seen.add(texture);
        const bpp={r8unorm:1,rgba8unorm:4,rgba8uint:4,r32float:4,rgba16float:8,rgba32float:16}[texture.format];
        if(!bpp||!(texture.usage&GPUTextureUsage.COPY_SRC))throw new Error('Output digest requires readable texture');
        const row=texture.width*bpp,pitch=Math.ceil(row/256)*256;
        const rb=device.createBuffer({size:pitch*texture.height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
        const enc=device.createCommandEncoder();enc.copyTextureToBuffer({texture},{buffer:rb,bytesPerRow:pitch},[texture.width,texture.height]);
        device.queue.submit([enc.finish()]);await rb.mapAsync(GPUMapMode.READ);
        const bytes=new Uint8Array(rb.getMappedRange()),digest=crypto.createHash('sha256');
        for(let y=0;y<texture.height;y++)digest.update(bytes.subarray(y*pitch,y*pitch+row));
        outputDigests.push({address:str,name,baseMipBytes:row*texture.height,sha256:digest.digest('hex')});
        rb.unmap();rb.destroy();
    }
    for(const texture of seen)texture.destroy();
}
const report={setupWallMs,completeColdThroughTenFineMs,roots:cost(roots),rootTimings:regional.timings,
    sourceKey:gen.regionalTerrain.sourceKey,riverRecordPoints:Array.from(rec.points),
    quadtreeInitialization:cost(quadtreeInitialization),quadtreeBufferBytes:qt.getStats().gpuMemoryBytes,
    waterPublication:cost(waterFirst),firstTenCompleteTiles:cost(firstFine),completeRegeneration:regen,
    publication:{compactPools:process.env.WATER_POOLS!=='legacy',waterGpuBytes:liveWater.gpuBytes,
        waterCarve:gen.waterCarve,riverValley:gen.riverValley,droppedRivers:liveWater.gpu._droppedRivers,
        listedRiverCells:liveWater.gpu._riverCells.size,structuredRiverSurface,bankDetail},certificateCosts,surfaceCosts,readbackCosts,lodCosts,foundationCosts,routingCosts,bankCosts,
    basins:regional.basins,river:{points:count,lengthM:rec.lengthM,segments:liveWater.gpu.riverSegCount,gridN:rec.gridN,profile:rec.profile},
    outputDigests,bankAudit,contract:{samples:carved.length,wetFailures,raised,maxCutM,minDepthM,downstreamRises,
        finalSamples,finalWetSamples,finalWetFailures,minFinalDepthM},pairedFine,addresses,completeAddresses,
    rootResidentBytes:regional.byteLength,cpuPlanningBytes:regional.cpuPlanningBytes,
    allocationPayload:memory,processMemory:{afterSetup:processMemoryAfterSetup,final:processMemoryFinal,resourceUsageMaxRssBytes:process.resourceUsage().maxRSS*1024},
    gpuErrors:errors,notes:['Complete workload: setup, six regional roots, both certified basins, route survey/search/index, quadtree setup/select, water allocation/upload, ten full-output tiles (seven fixed benchmark addresses plus source/middle/receiver) and fence. Regeneration repeats all except generator/quadtree setup.',
        'Shared certifier compilation is charged separately, not hidden inside the incremental connection time. Driver caches uncontrolled.',
        'Paired fine content uses identical roots, basins, addresses and outputs; only the river is disabled. It is not a macro reuse saving.',
        'Dense route and final-height texels are sampled validation, not a continuous river proof. Source rim is intentionally opened at its outlet.',
        'GPU allocation payload excludes generator allocations before monitor installation and whole-game assets/render atlases/driver pipeline overhead. RSS is sampled/unified memory; do not add it to GPU payload.']};
fs.writeFileSync(`${output}/benchmark.json`,JSON.stringify(report,null,2));
console.log(JSON.stringify({completeColdThroughTenFineMs,root:regional.timings,regen:regen.map(r=>r.wallMs),contract:report.contract,gpuErrors:errors},null,2));
sampler.destroy();liveWater.gpu.destroy();qt.dispose();process.exit(errors.length||wetFailures||raised||downstreamRises||finalWetFailures||bankAudit.raised||bankAudit.dryCapFailures?1:0);
