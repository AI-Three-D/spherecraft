/* global process */
// Read-only architecture investigation. No basin/feature/water edits are
// published. Sampling costs and existing CPU flood costs are kept separate.
import fs from 'node:fs';
import {setupLab} from '../../../terrain-lab/labsetup.mjs';

const output='tools/perf/structured-terrain-results/lake-reassessment';
fs.mkdirSync(output,{recursive:true});
const load=file=>JSON.parse(fs.readFileSync(`tools/perf/structured-terrain-results/${file}`));
const sites=[
    {name:'accepted-lowland',centre:load('basin-bank-reach/benchmark.json').basin.centre},
    {name:'surveyed-highland-plain',centre:load('basin-valleys/benchmark.json').basin.centre},
    {name:'rugged-rejected-certificate',centre:load('basin-pocket/placement-audit.json').cases[0].sites[0].centre},
    {name:'legacy-natural-basin-17',centre:load('benchmark-256.json').water[0].rivers[0].dir},
];
const started=performance.now(),{device,gen,imp,planetConfig}=await setupLab(process.argv[2]??'.');
const setupMs=performance.now()-started,errors=[];
device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
const {createHydrologySampler}=await imp('core/world/hydrology/HydrologyGrid.js');
const {solveLakePatch,tangentBasis}=await imp('core/world/hydrology/lakeRefine.js');
let t=performance.now();const roots=await gen.prepareRegionalTerrain({cells:256,seamCells:4});
const rootsMs=performance.now()-t;
t=performance.now();const sampler=await createHydrologySampler({device,terrainGenerator:gen});
const samplerCompileMs=performance.now()-t;
const summary=values=>{const sorted=values.toSorted((a,b)=>a-b),mid=Math.floor(sorted.length/2);
    return {min:sorted[0],median:(sorted[mid-1]+sorted[mid])/2,upperMedian:sorted[mid],max:sorted.at(-1),values};};
// Diagnostic threshold connectivity below a deliberately chosen water level.
// It does not discover the maximum spill level or prove continuous containment.
function partialFootprint(heights,n,seed,level) {
    const region=new Uint8Array(n*n),queue=new Int32Array(n*n);let head=0,tail=1,touchesBorder=false;
    queue[0]=seed;region[seed]=1;
    while(head<tail) {
        const k=queue[head++],x=k%n,y=Math.floor(k/n);
        if(x===0||y===0||x===n-1||y===n-1) touchesBorder=true;
        for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++) {
            if(dx===0&&dy===0) continue;
            const i=x+dx,j=y+dy;if(i<0||j<0||i>=n||j>=n) continue;
            const p=j*n+i;if(region[p]||heights[p]>=level) continue;
            region[p]=1;queue[tail++]=p;
        }
    }
    return {cells:tail,touchesBorder,region};
}
const cases=[];
for(const site of sites) for(const n of [32,64,128,256]) {
    const extentM=2048,spacing=extentM/n,frame={c:site.centre,...tangentBasis(site.centre),x0:-extentM/2,y0:-extentM/2,spacing,nx:n,ny:n};
    const samples=[];let heights;
    for(let round=0;round<4;round++) {
        const sampleStarted=performance.now();heights=await sampler.samplePatch(frame,planetConfig.radius);
        await device.queue.onSubmittedWorkDone();samples.push(performance.now()-sampleStarted);
    }
    let seed=-1,localMinima=0;
    for(let j=1;j<n-1;j++) for(let i=1;i<n-1;i++) {
        const x=frame.x0+(i+.5)*spacing,y=frame.y0+(j+.5)*spacing,k=j*n+i;
        if(Math.hypot(x,y)>400) continue;
        let lower=true;
        for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++) {
            if(dx===0&&dy===0) continue;
            if(heights[(j+dy)*n+i+dx]<heights[k]) lower=false;
        }
        if(!lower) continue;localMinima++;
        if(seed===-1||heights[k]<heights[seed]) seed=k;
    }
    if(seed===-1) seed=Math.floor(n/2)*n+Math.floor(n/2);
    const solves=[];let solved;
    for(let round=0;round<6;round++) {
        const solveStarted=performance.now();solved=solveLakePatch({heights,nx:n,ny:n,seed});
        solves.push(performance.now()-solveStarted);
    }
    const partialLevels=[];
    if(n===256) for(const riseM of [1,2,4,8]) {
        const floodStarted=performance.now(),p=partialFootprint(heights,n,seed,heights[seed]+riseM);
        partialLevels.push({riseM,levelM:heights[seed]+riseM,cells:p.cells,areaM2:p.cells*spacing*spacing,
            equivalentRadiusM:Math.sqrt(p.cells*spacing*spacing/Math.PI),touchesBorder:p.touchesBorder,
            connectivityWallMs:performance.now()-floodStarted});
        if(riseM===4) fs.writeFileSync(`${output}/${site.name}-partial-mask.u8`,p.region);
    }
    const record={site:site.name,centre:site.centre,n,spacingM:spacing,extentM,points:n*n,heightPayloadBytes:heights.byteLength,
        heightSampleWallMs:summary(samples),existingFloodWallMs:summary(solves),localMinima,
        seed,seedHeightM:heights[seed],minimumHeightM:Math.min(...heights),maximumHeightM:Math.max(...heights),partialLevels,
        result:solved?{levelM:solved.level,cells:solved.cells,areaM2:solved.cells*spacing*spacing,maxDepthM:solved.maxDepth,
            equivalentRadiusM:Math.sqrt(solved.cells*spacing*spacing/Math.PI),touchesBorder:solved.touchesBorder,outlet:solved.outlet,exit:solved.exit}:null,
        allocationLowerBoundBytesPerSolve:(8+4+1+8+4)*n*n+(solved?1*n*n:0)};
    cases.push(record);
    if(n===256) {
        fs.writeFileSync(`${output}/${site.name}-heights.f32`,new Uint8Array(heights.buffer,heights.byteOffset,heights.byteLength));
        if(solved) fs.writeFileSync(`${output}/${site.name}-mask.u8`,solved.region);
    }
}
const report={completeReadOnlyInvestigationMs:performance.now()-started,setupMs,rootsMs,samplerCompileMs,
    rootTimings:roots.timings,rootPayloadBytes:roots.byteLength,cases,processMemory:process.memoryUsage(),gpuErrors:errors,
    notes:['Diagnostic only: original terrain, existing shared macro controls, no constructed basin, new valley feature, water publication or terrain retuning.',
        'Warm sampling includes dispatch/readback/fence; flood includes allocations and existing JS heap algorithm. First-call and warm values are retained.',
        'A fixed 2048m patch and lowest local minimum within400m select one diagnostic seed, not a complete or production placement search.',
        'Sampled-grid basins are not certified continuous terrain lakes; final material micro is absent.',
        'This workload is not a complete production lake/river benchmark or a low-end hardware measurement.',
        'Solve allocation lower bound includes typed fill/parent/closed/heap/region arrays; height input, JS stack/outflow/results, render pools and driver memory are excluded.']};
fs.writeFileSync(`${output}/diagnostic.json`,JSON.stringify(report,null,2));
console.log(JSON.stringify({setupMs,rootsMs,samplerCompileMs,completeMs:report.completeReadOnlyInvestigationMs,
    cases:cases.map(c=>({site:c.site,n:c.n,sampleMs:c.heightSampleWallMs.median,floodMs:c.existingFloodWallMs.median,result:c.result})),gpuErrors:errors},null,2));
sampler.destroy();process.exit(errors.length?1:0);
