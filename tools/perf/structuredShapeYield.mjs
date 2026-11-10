/* global process */
import fs from 'node:fs';
import {setupLab} from '../../../terrain-lab/labsetup.mjs';
const output=process.env.SHAPE_OUTPUT??'tools/perf/structured-terrain-results/natural-yield';
fs.mkdirSync(output,{recursive:true});
const started=performance.now(),{device,gen,imp,planetConfig}=await setupLab('.');
const setupMs=performance.now()-started,errors=[];
device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
const {createRegionalShapeData}=await imp('core/world/terrain-generator/regionalShape.js');
const {createHydrologySampler}=await imp('core/world/hydrology/HydrologyGrid.js');
const {faceUVToDir}=await imp('core/world/hydrology/waterGraph.js');
const memory={liveBytes:0,peakBytes:0,createdBytes:0};
for(const method of ['createBuffer','createTexture']) {
    const create=device[method].bind(device);
    device[method]=d=>{
        const r=create(d),s=d.size,a=Array.isArray(s)?s:[s.width,s.height??1,s.depthOrArrayLayers??1];
        const bpp={r8unorm:1,rgba8unorm:4,rgba8uint:4,r32float:4,rg32float:8,rgba32float:16,rgba16float:8,r16float:2}[d.format];
        const bytes=method==='createBuffer'?s:a.reduce((x,y)=>x*y,1)*bpp;
        if(!Number.isFinite(bytes))throw new Error('Unknown allocation format');
        memory.liveBytes+=bytes;memory.createdBytes+=bytes;memory.peakBytes=Math.max(memory.peakBytes,memory.liveBytes);
        const destroy=r.destroy.bind(r);let freed=false;
        r.destroy=()=>{if(!freed){memory.liveBytes-=bytes;freed=true;}destroy();};return r;
    };
}
const rootStart=performance.now(),roots=await gen.prepareRegionalTerrain({cells:256,seamCells:4});
const rootsMs=performance.now()-rootStart;
const compileStart=performance.now(),sampler=await createHydrologySampler({device,terrainGenerator:gen});
const hintCompileMs=performance.now()-compileStart;
// 64 deterministic canonical regions per face; seed independent of terrain,
// no repeated candidate refinement or evidence-directed search enlargement.
const candidates=[];let random=0x9e3779b9;
const next=()=>{random^=random<<13;random^=random>>>17;random^=random<<5;return random>>>0;};
for(let face=0;face<6;face++) {
    const used=new Set();
    while(used.size<64) {
        const x=4+next()%120,y=4+next()%120,key=y*128+x;
        if(used.has(key))continue;used.add(key);
        candidates.push({face,depth:7,x,y,centre:faceUVToDir(face,(x+.5)/128,(y+.5)/128)});
    }
}
const dirs=new Float32Array(candidates.length*4);candidates.forEach((s,i)=>dirs.set([...s.centre,0],i*4));
const hintStart=performance.now(),heights=await sampler.sampleDirsNatural(dirs);
const hintMs=performance.now()-hintStart;
const eligible=candidates.map((s,i)=>({...s,hintHeightM:heights[i]})).filter(s=>s.hintHeightM>=500&&s.hintHeightM<=2000);
const selected=[];for(let face=0;face<6;face++) selected.push(...eligible.filter(s=>s.face===face).slice(0,4));
const control={face:3,depth:7,x:108,y:69,control:true};
const cases=[];
gen._fillTerrainUniformScratch(0,0,128,1,0);const uniformBytes=gen._terrainUniformScratch.slice(0);
for(const site of [...selected,control]) {
    const o={enabled:true,cells:128,...site};delete o.centre;delete o.hintHeightM;delete o.control;
    if(process.env.SHAPE_ENCLOSURE!=null)o.minimumEnclosureM=Number(process.env.SHAPE_ENCLOSURE);
    const t=performance.now();
    const shape=await createRegionalShapeData({device,gen,data:roots,uniformBytes,options:o,waterEnabled:true});
    await device.queue.onSubmittedWorkDone();
    const p=shape.lakePlan;
    const record={...site,completeShapeMs:performance.now()-t,timings:shape.timings,
        controlRangeM:[shape.minimumControlM,shape.maximumControlM],gpuBytes:shape.byteLength,cpuBytes:shape.cpuBytes,
        accepted:!p.rejected,attempts:p.attempts,proof:p.proof,levelM:p.levelM,radiusM:p.radiusM,
        settingContext:p.context,
        scratchLowerBoundBytes:p.scratchLowerBoundBytes};
    cases.push(record);
    const id=site.face+'-'+site.x+'-'+site.y;
    fs.writeFileSync(output+'/'+id+'.f32',new Uint8Array(shape.controls.buffer));
    fs.writeFileSync(output+'/'+id+'.json',JSON.stringify({options:shape.options,plan:p},null,2));
    shape.destroy();
}
await device.queue.onSubmittedWorkDone();
const report={completeMs:performance.now()-started,setupMs,rootsMs,rootTimings:roots.timings,
    hintCompileMs,hintMs,candidateRegions:384,eligibleRegions:eligible.length,selectedRegions:selected.length,
    eligiblePerFace:Array.from({length:6},(_,face)=>eligible.filter(s=>s.face===face).length),
    acceptedRegions:cases.filter(c=>!c.control&&c.accepted).length,cases,memory,planetRadiusM:planetConfig.radius,gpuErrors:errors,
    notes:['Read-only fixed-budget yield diagnostic.384 deterministic region-centre hints, at most4 eligible regions perface, plus one previously selected control excluded from yield.',
        'Centre height is a cheap eligibility hint, not a basin guarantee. No morphology-directed reranking or expanding search.',
        'Each generated eroded regional shape uses the production planner and records all failed/successful capped attempts.',
        'Complete survey includes roots, sampler compilation/hints, region shape generation/bounds/planning/mask publication and fences; does not include full terrain output, render water pools or flight.',
        'Fields are destroyed between cases; resident-world paging, density and humidity remain unimplemented. Native allocations exclude generator setup and pipeline/driver memory.']};
fs.writeFileSync(output+'/survey.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({completeMs:report.completeMs,rootsMs,hintCompileMs,hintMs,eligible:eligible.length,selected:selected.length,
    accepted:report.acceptedRegions,cases:cases.map(c=>({face:c.face,x:c.x,y:c.y,control:c.control,ms:c.completeShapeMs,accepted:c.accepted,radius:c.radiusM,range:c.controlRangeM})),errors},null,2));
sampler.destroy();process.exit(errors.length?1:0);
