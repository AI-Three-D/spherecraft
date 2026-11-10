/* global process */
// Bounded read-only investigation. Context samples suggest sites; only the
// existing continuous certificates can establish containment at those sites.
import fs from 'node:fs';
import { setupLab } from '../../../terrain-lab/labsetup.mjs';
import { HIGHLAND_BASIN_CASE } from './structuredBasinCases.mjs';

const start=performance.now();
const {device,gen,imp,planetConfig}=await setupLab(process.argv[2]??'.');
const errors=[];device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
const {regionalTerrainOptions}=await imp('core/world/terrain-generator/regionalTerrain.js');
const {tangentBasis,planeToDir}=await imp('core/world/hydrology/lakeRefine.js');
const {createAdvancedTerrainComputeShader}=await imp('core/world/shaders/webgpu/advancedTerrainCompute.wgsl.js');
const {createRegionalBasinCertificateWgsl}=await imp('core/world/terrain-generator/regionalBasins.wgsl.js');
const R=planetConfig.radius,output='tools/perf/structured-terrain-results/basin-valleys';fs.mkdirSync(output,{recursive:true});
const setupMs=performance.now()-start,rootsStart=performance.now();
const regional=await gen.prepareRegionalTerrain({cells:256,seamCells:4});
const rootsMs=performance.now()-rootsStart;
gen._fillTerrainUniformScratch(0,0,128,1,0);const uniformBytes=gen._terrainUniformScratch.slice(0);
const options=regionalTerrainOptions({basins:{enabled:true,...HIGHLAND_BASIN_CASE}}).basins;
const sites=JSON.parse(fs.readFileSync('tools/perf/structured-terrain-results/basin-pocket/placement-audit.json')).cases[0].sites;
const compileStart=performance.now();
const code=createAdvancedTerrainComputeShader(gen._getAdvancedTerrainShaderOptions({regionalTerrain:true,waterCarve:false,riverValley:false}))
    +createRegionalBasinCertificateWgsl(gen.erosionFilter,regional.budgets,{slopeAware:true});
const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:device.createShaderModule({code}),entryPoint:'basinCertificateMain'}});
const certificateCompileMs=performance.now()-compileStart;
async function certify(points) {
    if(!points.length) return new Float32Array();
    const inputs=new Float32Array(points.flatMap(p=>[...p.centre,p.radiusM]));
    const ub=device.createBuffer({size:uniformBytes.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    const ib=device.createBuffer({size:inputs.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
    const ob=device.createBuffer({size:inputs.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
    const rb=device.createBuffer({size:inputs.byteLength,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    try {
        device.queue.writeBuffer(ub,0,uniformBytes);device.queue.writeBuffer(ib,0,inputs);
        const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass({label:'Pocket rim audit'});
        pass.setPipeline(pipeline);
        pass.setBindGroup(0,device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
            {binding:0,resource:{buffer:ub}},{binding:6,resource:{buffer:ib}},{binding:7,resource:{buffer:ob}}]}));
        pass.setBindGroup(1,device.createBindGroup({layout:pipeline.getBindGroupLayout(1),entries:[]}));
        pass.setBindGroup(2,device.createBindGroup({layout:pipeline.getBindGroupLayout(2),entries:regional.bindGroupEntries.filter(e=>e.binding<3)}));
        pass.dispatchWorkgroups(points.length);pass.end();encoder.copyBufferToBuffer(ob,0,rb,0,inputs.byteLength);
        device.queue.submit([encoder.finish()]);await rb.mapAsync(GPUMapMode.READ);
        return new Float32Array(rb.getMappedRange()).slice();
    } finally {if(rb.mapState==='mapped') rb.unmap();for(const buffer of [ub,ib,ob,rb]) buffer.destroy();}
}
const certificateStart=performance.now(),cases=[];
for(const radiusM of [60,30]) {
    const capRadiusM=Math.ceil(2*(radiusM+6)*Math.sin(Math.PI/128)*1.001+6),points=[];
    for(const s of sites) {
        const frame={c:s.centre,...tangentBasis(s.centre)};
        for(let a=0;a<64;a++) points.push({centre:planeToDir(Math.cos(a*Math.PI/32)*radiusM,Math.sin(a*Math.PI/32)*radiusM,frame,R),radiusM:capRadiusM});
    }
    const values=await certify(points);
    cases.push({radiusM,capRadiusM,sites:sites.map((s,k)=>{
        const lowerM=Math.min(...Array.from({length:64},(_,a)=>values[(k*64+a)*4]));
        const levelM=lowerM-options.rimM,cutM=s.naturalCentreM-(levelM-options.depthM);
        return {...s,lowerM,levelM,cutM,eligible:levelM>=options.minLevelM&&cutM<=options.maxCentreCutM};
    })});
}
const report={notes:['Read-only: no water/basin record or terrain change. Context samples rank morphology; original continuous annulus certificates decide eligibility.',
    'Only 128 existing regional candidates, one 21x21 context patch each, at most 32 recentered proposals, two radii. Not exhaustive alpine coverage.',
    'Audit cost excludes constructed water, fine generation and regeneration. Driver caches uncontrolled.'],
    completeAuditMs:performance.now()-start,setupMs,rootsMs,certificateCompileMs,certificateMs:performance.now()-certificateStart,
    cases,rootPayloadBytes:regional.byteLength,processMemory:process.memoryUsage(),gpuErrors:errors};
fs.writeFileSync(`${output}/rim-feasibility.json`,JSON.stringify(report,null,2));
console.log(JSON.stringify({auditMs:report.completeAuditMs,cases:cases.map(c=>({radiusM:c.radiusM,eligible:c.sites.filter(s=>s.eligible),best:c.sites.toSorted((a,b)=>a.cutM-b.cutM).slice(0,4)})),gpuErrors:errors},null,2));
process.exit(errors.length?1:0);
