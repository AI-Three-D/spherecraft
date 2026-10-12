/* global process */
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {setupLab} from '../../../terrain-lab/labsetup.mjs';
const output=process.env.SHAPE_OUTPUT??'tools/perf/structured-terrain-results/natural-basin';fs.mkdirSync(output,{recursive:true});
const started=performance.now(),{device,gen,imp,planetConfig,engineConfig}=await setupLab(process.argv[2]??'.');
const setupMs=performance.now()-started,errors=[];device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
const {TileGenerator}=await imp('core/world/quadtree/tileGenerator.js'),{TileAddress}=await imp('core/world/quadtree/tileAddress.js');
const {WaterService,WATER_SERVICE_DEFAULTS}=await imp('core/world/hydrology/WaterService.js'),{WaterGpuData}=await imp('core/world/water/WaterGpuData.js');
const {structuredWaterGpuCapacity}=await imp('core/world/water/structuredWaterGpuCapacity.js');
const {createHydrologySampler}=await imp('core/world/hydrology/HydrologyGrid.js');
const {faceUVToDir,dirToFaceUV}=await imp('core/world/hydrology/waterGraph.js');
const {sampleRegionalShape,regionalShapeBounds}=await imp('core/world/terrain-generator/regionalShapeModel.js');
const {regionalShapeAddress,regionalShapeOptions}=await imp('core/world/terrain-generator/regionalShape.js');
const memory={liveBytes:0,peakBytes:0,createdBytes:0};
for(const method of ['createBuffer','createTexture']) {
    const original=device[method].bind(device);device[method]=d=>{
        const r=original(d),s=d.size,size=Array.isArray(s)?s:[s.width,s.height??1,s.depthOrArrayLayers??1];
        const bpp={r8unorm:1,rgba8unorm:4,rgba8uint:4,rgba32float:16,r32float:4,rg32float:8,rgba16float:8,r16float:2}[d.format];
        const bytes=method==='createBuffer'?s:size.reduce((a,b)=>a*b,1)*bpp;
        if(!Number.isFinite(bytes)) throw new Error('Unknown allocation format');
        memory.liveBytes+=bytes;memory.createdBytes+=bytes;memory.peakBytes=Math.max(memory.peakBytes,memory.liveBytes);
        const destroy=r.destroy.bind(r);let destroyed=false;r.destroy=()=>{if(!destroyed){memory.liveBytes-=bytes;destroyed=true;}destroy();};return r;
    };
}
const timed=async fn=>{const t=performance.now(),value=await fn();await device.queue.onSubmittedWorkDone();return {value,wallMs:performance.now()-t};};
const opts={cells:256,seamCells:4,basins:{enabled:true},shape:{enabled:true,
    cells:Number(process.env.SHAPE_CELLS??128),surfaceDepth:process.env.SURFACE_DEPTH!=='0',...(process.argv.includes('--lowland')?{face:1,x:81,y:40,minLevelM:100}:{}),
    ...regionalShapeAddress(process.env.SHAPE_REGION)}};
if(process.env.SHAPE_ENCLOSURE!=null)opts.shape.minimumEnclosureM=Number(process.env.SHAPE_ENCLOSURE);
for(const [env,key] of Object.entries({SHAPE_RADIUS:'maxRadiusM',SHAPE_MIN_LEVEL:'minLevelM',SHAPE_POTENTIAL:'maxPotentialCells',SHAPE_SURFACE:'surfaceCells',SHAPE_MIN_WET:'minWetCells'})) {
    if(process.env[env]!=null)opts.shape[key]=Number(process.env[env]);
}
if(process.env.SHAPE_RISES)opts.shape.risesM=process.env.SHAPE_RISES.split(',').map(Number);
if(process.argv.includes('--depression'))opts.shape.depression={radiusM:450,maxCutM:8,depthM:2.5,seed:17};
if(process.env.SHAPE_DEPRESSION_PROFILE)opts.shape.depression.profile=process.env.SHAPE_DEPRESSION_PROFILE;
const root=await timed(()=>gen.prepareRegionalTerrain(opts));let d=root.value;
fs.writeFileSync(`${output}/shape-controls.f32`,new Uint8Array(d.shapeData.controls.buffer));
fs.writeFileSync(`${output}/shape-plan.json`,JSON.stringify({options:d.shapeData.options,plan:d.shapeData.lakePlan,timings:d.timings},null,2));
if(process.argv.includes('--plan-only')) { console.log(JSON.stringify({completeMs:performance.now()-started,plan:d.shapeData.lakePlan}));d.destroy();process.exit(0); }
if(!d.basins.length&&!process.argv.includes('--allow-dry')) throw new Error('No certified natural basin in this region');
const so=d.shapeData.options;
const b=d.basins[0]??{centre:faceUVToDir(so.face,(so.x+.5)/2**so.depth,(so.y+.5)/2**so.depth),
    levelM:(d.shapeData.minimumControlM+d.shapeData.maximumControlM)*.5};
const R=planetConfig.radius,actualDepth=process.argv.includes('--large')?8:10,grid=2**actualDepth,
    p=dirToFaceUV(b.centre),x=Math.floor(p.u*grid),y=Math.floor(p.v*grid);
const actual=[];
if(process.argv.includes('--large')) {
    const keys=Object.keys(d.shapeData.lakePlan.region).map(Number).filter(k=>d.shapeData.lakePlan.region[k]);
    const uv=(cell,base)=>(base+cell/so.cells)/2**so.depth*grid;
    const x0=Math.floor(uv(Math.min(...keys.map(k=>k%so.cells))-1,so.x));
    const x1=Math.floor(uv(Math.max(...keys.map(k=>k%so.cells))+2,so.x));
    const y0=Math.floor(uv(Math.min(...keys.map(k=>Math.floor(k/so.cells)))-1,so.y));
    const y1=Math.floor(uv(Math.max(...keys.map(k=>Math.floor(k/so.cells)))+2,so.y));
    for(let j=y0-1;j<=y1+1;j++)for(let i=x0-1;i<=x1+1;i++)actual.push(new TileAddress(p.face,actualDepth,i,j));
} else for(let j=y-1;j<=y+1;j++) for(let i=x-1;i<=x+1;i++)actual.push(new TileAddress(p.face,actualDepth,i,j));
const prior=JSON.parse(fs.readFileSync('tools/perf/structured-terrain-results/benchmark-256.json'));
const addresses=[...prior.tiles.addresses.map(TileAddress.fromString),...actual];
gen._quadtreeSplatDiagCount=3;gen._quadtreeSplatProbePassCount=3;gen._quadtreeSplatPrimeCount=3;
const tileGen=new TileGenerator(gen,{textureSize:128,requiredTypes:prior.tiles.types,textureFormats:{height:'r32float',normal:'rgba8unorm',tile:'r8unorm'},quadtreeMaxDepth:11,maxGeomLOD:6,enableSplat:true});
const fine=async list=>{for(const a of list){const t=await tileGen.generateTile(a);for(const v of new Set(Object.values(t).map(v=>v?._gpuTexture?.texture).filter(Boolean))) v.destroy();}};
const {QuadtreeGPU}=await imp('core/world/quadtree/QuadtreeGPU.js');
const camera={position:{x:b.centre[0]*(R+b.levelM+200),y:b.centre[1]*(R+b.levelM+200),z:b.centre[2]*(R+b.levelM+200)}};
const qt=new QuadtreeGPU(device,{...engineConfig.gpuQuadtree,planetRadius:R,planetOrigin:planetConfig.origin,
    minTileSize:engineConfig.gpuQuadtree.minTileSizeMeters,loadedTableCapacity:engineConfig.gpuQuadtree.tileHashCapacity,
    maxFeedback:engineConfig.gpuQuadtree.feedbackCapacity,screenHeight:900,regionalTerrain:d,enableFrustumCulling:false,enableHorizonCulling:false});
const qtInit=await timed(async()=>{await qt.initialize();qt.updateUniforms(camera);qt.traverse();});
let compactPools=process.env.WATER_POOLS!=='legacy';
let lakeGridN=Number(process.env.WATER_INDEX??WATER_SERVICE_DEFAULTS.gpu.structuredLakeGridN);
const publish=async()=>{const service=new WaterService({device,terrainGenerator:gen,planetConfig,useWorker:false,
    config:{cache:false,gpu:{structuredCapacity:compactPools,structuredLakeGridN:lakeGridN}}});
    await service.start();const before=memory.liveBytes;
    const gpu=new WaterGpuData(device,{gridN:service.config.gridN,planetRadius:R,
        carve:gen.waterCarve?service.config.carve:null,valley:gen.riverValley?service.config.valley:null,
        ...(compactPools?structuredWaterGpuCapacity(service):{})});
    gpu.update(service,camera.position,0);await device.queue.onSubmittedWorkDone();return {service,gpu,gpuBytes:memory.liveBytes-before};};
let water=(await timed(publish));const firstWaterMs=water.wallMs,firstWaterTimings=water.value.service.timings;
const firstFine=await timed(()=>fine(addresses));
const completeFirstMs=performance.now()-started,regen=[];
for(let i=0;i<3;i++) {
    const old=water.value;
    const r=await timed(async()=>{await gen.prepareRegionalTerrain(opts,{regenerate:true});d=gen.regionalTerrain;
        qt.setRegionalTerrain(d);qt.updateUniforms(camera);qt.traverse();water=await timed(publish);old.gpu.destroy();await fine(addresses);});
    regen.push({completeMs:r.wallMs,root:d.timings,waterPublicationMs:water.wallMs,waterTimings:water.value.service.timings,waterGpuBytes:water.value.gpuBytes});
}
const setMode=mode=>{const a=d.shapeData.parameters.slice();if(mode==='original')a[4]=0;a[6]=mode==='wet'?1:0;device.queue.writeBuffer(d.shapeData.params,0,a);};
const surfaceCosts=[];
if(process.argv.includes('--surface-cost')) for(let round=0;round<3;round++) for(const surfaceDepth of [false,true]) {
    const oldWater=water.value;
    const r=await timed(async()=>{
        await gen.prepareRegionalTerrain({...opts,shape:{...opts.shape,surfaceDepth}},{regenerate:true});d=gen.regionalTerrain;
        qt.setRegionalTerrain(d);qt.updateUniforms(camera);qt.traverse();water=await timed(publish);oldWater.gpu.destroy();await fine(addresses);
    });
    surfaceCosts.push({round,surfaceDepth,completeMs:r.wallMs,root:d.timings,waterPublicationMs:water.wallMs});
}
const poolCosts=[];
if(process.argv.includes('--pool-cost')) for(let round=0;round<3;round++) for(const compact of [false,true]) {
    compactPools=compact;const oldWater=water.value;
    const r=await timed(async()=>{
        await gen.prepareRegionalTerrain(opts,{regenerate:true});d=gen.regionalTerrain;
        qt.setRegionalTerrain(d);qt.updateUniforms(camera);qt.traverse();water=await timed(publish);oldWater.gpu.destroy();await fine(addresses);
    });
    poolCosts.push({round,compact,completeMs:r.wallMs,root:d.timings,waterPublicationMs:water.wallMs,waterGpuBytes:water.value.gpuBytes});
}
const contextCosts=[];
if(process.argv.includes('--context-cost')) for(let round=0;round<3;round++) for(const minimumEnclosureM of [0,regionalShapeOptions(opts.shape).minimumEnclosureM]) {
    const oldWater=water.value;
    const r=await timed(async()=>{
        await gen.prepareRegionalTerrain({...opts,shape:{...opts.shape,minimumEnclosureM}},{regenerate:true});d=gen.regionalTerrain;
        qt.setRegionalTerrain(d);qt.updateUniforms(camera);qt.traverse();water=await timed(publish);oldWater.gpu.destroy();await fine(addresses);
    });
    contextCosts.push({round,minimumEnclosureM,completeMs:r.wallMs,root:d.timings,waterPublicationMs:water.wallMs,
        accepted:!!d.basins.length,proof:d.shapeData.lakePlan.proof});
}
const gridCosts=[];
if(process.argv.includes('--grid-cost')) for(let round=0;round<4;round++) for(const N of (round%2?[64,512]:[512,64])) {
    lakeGridN=N;const oldWater=water.value;
    const r=await timed(async()=>{
        await gen.prepareRegionalTerrain(opts,{regenerate:true});d=gen.regionalTerrain;
        qt.setRegionalTerrain(d);qt.updateUniforms(camera);qt.traverse();water=await timed(publish);oldWater.gpu.destroy();await fine(addresses);
    });
    gridCosts.push({round,gridN:water.value.service.N,completeMs:r.wallMs,root:d.timings,
        waterPublicationMs:water.wallMs,waterGpuBytes:water.value.gpuBytes});
}
const seedCosts=[];
if(process.argv.includes('--seed-cost'))for(let round=0;round<4;round++)for(const scan of (round%2?[true,false]:[false,true])) {
    gen._regionalNaturalSeedScan=scan;const oldWater=water.value;
    const r=await timed(async()=>{
        await gen.prepareRegionalTerrain(opts,{regenerate:true});d=gen.regionalTerrain;
        qt.setRegionalTerrain(d);qt.updateUniforms(camera);qt.traverse();water=await timed(publish);oldWater.gpu.destroy();await fine(addresses);
    });
    const proof=d.shapeData.lakePlan.proof;
    seedCosts.push({round,scan,completeMs:r.wallMs,root:d.timings,waterPublicationMs:water.wallMs,
        sourceKey:d.sourceKey,levelM:d.shapeData.lakePlan.levelM,proof,
        controlsSha256:createHash('sha256').update(d.shapeData.controls).digest('hex')});
}
gen._regionalNaturalSeedScan=false;
const potentialCosts=[];
if(process.argv.includes('--potential-cost'))for(let round=0;round<4;round++)for(const profile of (round%2?['organic','lobes']:['lobes','organic'])) {
    const oldWater=water.value;
    const r=await timed(async()=>{
        await gen.prepareRegionalTerrain({...opts,shape:{...opts.shape,depression:{...opts.shape.depression,profile}}},{regenerate:true});d=gen.regionalTerrain;
        qt.setRegionalTerrain(d);qt.updateUniforms(camera);qt.traverse();water=await timed(publish);oldWater.gpu.destroy();await fine(addresses);
    });
    potentialCosts.push({round,profile,completeMs:r.wallMs,root:d.timings,waterPublicationMs:water.wallMs,
        sourceKey:d.sourceKey,proof:d.shapeData.lakePlan.proof,levelM:d.shapeData.lakePlan.levelM,
        controlsSha256:createHash('sha256').update(d.shapeData.controls).digest('hex')});
}
if(potentialCosts.length) {
    await gen.prepareRegionalTerrain(opts,{regenerate:true});d=gen.regionalTerrain;
    qt.setRegionalTerrain(d);const oldWater=water.value;water=await timed(publish);oldWater.gpu.destroy();
}
const foundationCosts=[];
if(process.argv.includes('--foundation-cost'))for(let round=0;round<3;round++)for(const reuseFoundation of (round%2?[true,false]:[false,true])) {
    const oldWater=water.value,previousPeak=memory.peakBytes;memory.peakBytes=memory.liveBytes;
    const r=await timed(async()=>{
        await gen.prepareRegionalTerrain(opts,{regenerate:true,reuseFoundation});d=gen.regionalTerrain;
        qt.setRegionalTerrain(d);qt.updateUniforms(camera);qt.traverse();water=await timed(publish);oldWater.gpu.destroy();await fine(addresses);
    });
    foundationCosts.push({round,reuseFoundation,completeMs:r.wallMs,root:d.timings,waterPublicationMs:water.wallMs,
        liveBytes:memory.liveBytes,peakBytes:memory.peakBytes,sourceKey:d.sourceKey,
        controlsSha256:createHash('sha256').update(d.shapeData.controls).digest('hex')});
    memory.peakBytes=Math.max(previousPeak,memory.peakBytes);
}
const comparisons=[];
for(let round=0;round<3;round++) for(const mode of ['original','shared','wet']) {
    setMode(mode);comparisons.push({round,mode,completeNineFineMs:(await timed(()=>fine(actual))).wallMs});
}
setMode('wet');
const sampler=await createHydrologySampler({device,terrainGenerator:gen});
const o=d.shapeData.options,N=o.cells,G=2**o.depth,points=10000,dirs=new Float32Array(points*4),positions=[];
for(let k=0;k<points;k++) {
    const sx=((k*0.61803398875)%1)*N,sy=((k*0.41421356237+.123)%1)*N;
    const dir=faceUVToDir(o.face,(o.x+sx/N)/G,(o.y+sy/N)/G);dirs.set([...dir,0],k*4);positions.push([sx,sy]);
}
setMode('original');const old=await sampler.sampleDirsNatural(dirs);
setMode('shared');const shared=await sampler.sampleDirsNatural(dirs);
setMode('wet');const wet=await sampler.sampleDirsNatural(dirs);
let maxInterpolationErrorM=0,maxShapeDifferenceM=0,maxBedCutM=0,raised=0,exteriorChanges=0;
for(let k=0;k<points;k++) {
    const [sx,sy]=positions[k];maxShapeDifferenceM=Math.max(maxShapeDifferenceM,Math.abs(shared[k]-old[k]));
    const full=Math.min(sx,sy,N-sx,N-sy)>=o.guardCells;
    if(full) maxInterpolationErrorM=Math.max(maxInterpolationErrorM,Math.abs(shared[k]-sampleRegionalShape(d.shapeData.controls,N,sx,sy)));
    if(wet[k]>shared[k]+.005)raised++;maxBedCutM=Math.max(maxBedCutM,shared[k]-wet[k]);
    if(Math.min(sx,sy,N-sx,N-sy)<.01&&Math.abs(shared[k]-old[k])>.005) exteriorChanges++;
}
// Actual final micro-inclusive textures: audit the entire proven wet cell and
// retaining ring in canonical shape coordinates, across the real lake tiles.
let finalSamples=0,coreSamples=0,coreFailures=0,rimFailures=0,minCoreDepthM=Infinity,minRimM=Infinity;
const finalBounds=regionalShapeBounds(d.shapeData.controls,N);
let certifiedWetSamples=0,certifiedWetFailures=0,minCertifiedWetDepthM=Infinity;
const finalHeightHash=createHash('sha256');
const core=d.shapeData.lakePlan.core,cx=core%N,cy=Math.floor(core/N),region=d.shapeData.lakePlan.region??new Uint8Array(N*N);
for(const a of actual) {
    const textures=await tileGen.generateTile(a),height=textures.height._gpuTexture.texture;
    const rb=device.createBuffer({size:128*128*4,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    const enc=device.createCommandEncoder();enc.copyTextureToBuffer({texture:height},{buffer:rb,bytesPerRow:512},[128,128]);device.queue.submit([enc.finish()]);await rb.mapAsync(GPUMapMode.READ);
    const hs=new Float32Array(rb.getMappedRange());
    finalHeightHash.update(new Uint8Array(hs.buffer,hs.byteOffset,hs.byteLength));
    for(let j=0;j<128;j++) for(let i=0;i<128;i++) {
        const sx=(((a.x+i/127)/grid)*G-o.x)*N,sy=(((a.y+j/127)/grid)*G-o.y)*N;
        const ix=Math.floor(sx),iy=Math.floor(sy),h=hs[j*128+i]*planetConfig.maxTerrainHeight;finalSamples++;
        if(sx>cx+.05&&sx<cx+.95&&sy>cy+.05&&sy<cy+.95){coreSamples++;minCoreDepthM=Math.min(minCoreDepthM,b.levelM-h);if(h>b.levelM-o.depthM)coreFailures++;}
        if(ix>=0&&iy>=0&&ix<N&&iy<N&&region[iy*N+ix]) {
            const upper=finalBounds.upper[iy*N+ix],t=Math.max(0,Math.min(1,(b.levelM-upper)/o.bedTransitionM));
            const cut=o.bedCutM*t*t*t*(t*(t*6-15)+10);
            if(upper+o.microLimitM+o.numericalM-cut<=b.levelM-.25) {
                certifiedWetSamples++;minCertifiedWetDepthM=Math.min(minCertifiedWetDepthM,b.levelM-h);
                if(h>b.levelM-.25)certifiedWetFailures++;
            }
        }
        if(ix<1||iy<1||ix>=N-1||iy>=N-1||region[iy*N+ix])continue;
        let rim=false;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)if(region[(iy+dy)*N+ix+dx])rim=true;
        if(rim){minRimM=Math.min(minRimM,h-b.levelM);if(h<b.levelM+o.rimM)rimFailures++;}
    }
    rb.unmap();rb.destroy();for(const v of new Set(Object.values(textures).map(v=>v?._gpuTexture?.texture).filter(Boolean)))v.destroy();
}
const pixels=b.surfaceDepthMask?Array.from(b.surfaceDepthMask.keys()).filter(k=>b.surfaceDepthMask[k]>128):[];
const surfaceEstimate=pixels.length?{kind:'conservative-render-depth-texel-estimate',wetPixels:pixels.length,
    areaM2:pixels.length*b.frame.spacing**2,
    widthM:(Math.max(...pixels.map(k=>k%b.frame.nx))-Math.min(...pixels.map(k=>k%b.frame.nx))+1)*b.frame.spacing,
    lengthM:(Math.max(...pixels.map(k=>Math.floor(k/b.frame.nx)))-Math.min(...pixels.map(k=>Math.floor(k/b.frame.nx)))+1)*b.frame.spacing}:null;
const report={setupMs,completeFirstMs,firstRootMs:root.wallMs,firstRootTimings:root.value.timings,quadtreeInitMs:qtInit.wallMs,
    firstFineMs:firstFine.wallMs,firstWaterMs,firstWaterTimings,regeneration:regen,surfaceCosts,poolCosts,contextCosts,gridCosts,seedCosts,potentialCosts,foundationCosts,surfaceEstimate,
    publication:{compactPools,gridN:water.value.service.N,waterCarve:gen.waterCarve,riverValley:gen.riverValley,waterGpuBytes:water.value.gpuBytes},
    equivalentNineFine:comparisons,addresses:addresses.map(a=>a.toString()),
    shape:{options:o,bytes:d.shapeData.byteLength,cpuBytes:d.shapeData.cpuBytes,plan:d.shapeData.lakePlan,basin:d.basins[0]??null},
    audit:{points,maxInterpolationErrorM,maxShapeDifferenceM,maxBedCutM,raised,exteriorChanges,finalSamples,coreSamples,coreFailures,rimFailures,minCoreDepthM,minRimM,
        certifiedWetSamples,certifiedWetFailures,minCertifiedWetDepthM,
        finalHeightSha256:finalHeightHash.digest('hex'),naturalHeightSha256:createHash('sha256').update(old).update(shared).update(wet).digest('hex')},
    memory,processMemory:process.memoryUsage(),gpuErrors:errors,
    notes:[`Complete first/regeneration includes roots, authoritative region generation/planning, quadtree selection, water publication, seven fixed plus ${actual.length} actual complete terrain outputs, final fence. Large mode covers the entire potential-water region plus retaining ring and one tile halo at depth8.`,
        'Equivalent nine outputs use the same source/bindings: original bypasses the shape, shared uses dry shape, wet also applies the bounded lake cut/micro mask.',
        'The original/shared pair compares intended existing terrain content; interpolation changes must pass actual visual assessment before claiming equivalent-content savings.',
        'Declared payload excludes pre-monitor setup, pipeline/driver allocations and whole-game pools. Process endpoint RSS is not peak.']};
fs.writeFileSync(`${output}/benchmark.json`,JSON.stringify(report,null,2));
console.log(JSON.stringify({completeFirstMs,regen:regen.map(r=>r.completeMs),comparisons,audit:report.audit,errors}));
sampler.destroy();water.value.gpu.destroy();qt.dispose();process.exit(errors.length||coreFailures||certifiedWetFailures||rimFailures||raised||maxInterpolationErrorM>o.numericalM||maxBedCutM>o.bedCutM+.01?1:0);
