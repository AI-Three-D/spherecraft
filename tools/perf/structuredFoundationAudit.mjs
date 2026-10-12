/* global process, Buffer */
import fs from 'node:fs';
import {setupLab} from '../../../terrain-lab/labsetup.mjs';
const out=process.env.REGIONAL_AUDIT_OUTPUT??'tools/perf/structured-terrain-results/mountain-river/foundation-safety';fs.mkdirSync(out,{recursive:true});
const {device,gen,imp}=await setupLab('.'),errors=[];device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
const {createHydrologySampler}=await imp('core/world/hydrology/HydrologyGrid.js');
const {faceUVToDir}=await imp('core/world/hydrology/waterGraph.js');
const {createRegionalShapeWgsl}=await imp('core/world/terrain-generator/regionalShape.wgsl.js');
const oldCode=fs.readFileSync(process.env.SHAPE_REFERENCE??'tools/perf/structured-terrain-results/mountain-river/foundation-safety/reference-shape.wgsl.js','utf8');
fs.writeFileSync(out+'/reference-shape.wgsl.js',oldCode);
const {createRegionalShapeWgsl:oldWgsl}=await import('data:text/javascript;base64,'+Buffer.from(oldCode).toString('base64'));
const opts={cells:256,basins:{enabled:true},shape:{enabled:true,face:2,depth:7,x:10,y:9,minLevelM:100,minimumEnclosureM:0}};
await gen.prepareRegionalTerrain(opts);const dirs=[];
for(let y=-4;y<132;y++)for(let x=-4;x<132;x++)dirs.push(...faceUVToDir(2,(10+(x+.375)/128)/128,(9+(y+.625)/128)/128),0);
const input=Float32Array.from(dirs),current=await createHydrologySampler({device,terrainGenerator:gen});
const original=device.createShaderModule.bind(device);let substitutions=0;
device.createShaderModule=d=>{
 if(d.label==='HydrologySampler') {
  if(!d.code.includes(createRegionalShapeWgsl()))throw new Error('Reference sampler did not find the complete shape module');
  substitutions++;return original({...d,code:d.code.replace(createRegionalShapeWgsl(),oldWgsl())});
 }
 return original(d);
};
const reference=await createHydrologySampler({device,terrainGenerator:gen});device.createShaderModule=original;
const a=await current.sampleDirsNatural(input),b=await reference.sampleDirsNatural(input);
let maxDifferenceM=0,sumDifferenceM=0,different=0,overOneMm=0;
for(let i=0;i<a.length;i++){const delta=Math.abs(a[i]-b[i]);maxDifferenceM=Math.max(maxDifferenceM,delta);sumDifferenceM+=delta;if(delta>0)different++;if(delta>.001)overOneMm++;}
const samplerRebinding=[];
for(const reuseFoundation of [false,true]) {
 const before=gen.regionalTerrain.foundation;
 await gen.prepareRegionalTerrain(opts,{regenerate:true,reuseFoundation});
 const resampled=await current.sampleDirsNatural(input);
 if(resampled.some((v,i)=>v!==a[i]))throw new Error('Existing sampler did not rebind equivalent regenerated inputs');
 samplerRebinding.push({reuseFoundation,shared:gen.regionalTerrain.foundation===before,heightsIdentical:true});
}
const published=gen.regionalTerrain,foundation=published.foundation;
let failureMessage=null;
try {await gen.prepareRegionalTerrain({...opts,shape:{...opts.shape,minLevelM:100000,receiverRegion:{dx:-1,dy:0,minLevelM:100}}});}
catch(e){failureMessage=e.message;}
if(!failureMessage||gen.regionalTerrain!==published||foundation.users!==1)throw new Error('Failed feature replacement altered published generation');
const after=await current.sampleDirsNatural(input);
if(after.some((v,i)=>v!==a[i]))throw new Error('Failed replacement changed existing height inputs');
gen.setTerrainFeatures({meso2:false});const changed=await gen.prepareRegionalTerrain({cells:256});
if(changed.foundation===foundation)throw new Error('Changed terrain feature reused old foundation');
let staleMessage=null;try {await current.sampleDirsNatural(input);}catch(e){staleMessage=e.message;}
if(!staleMessage)throw new Error('Old sampler accepted changed terrain inputs');
const report={samples:a.length,substitutions,maxDifferenceM,meanDifferenceM:sumDifferenceM/a.length,different,overOneMm,
    samplerRebinding,failedFeatureReplacement:{message:failureMessage,publishedInputsUnchanged:true},changedFeatureInvalidation:true,staleMessage,
    foundationCpuPayload:{typedBytes:foundation.cpuBytes,sourceCodeUnits:foundation.sourceCodeUnits,budgetCodeUnits:foundation.budgetCodeUnits},gpuErrors:errors};
fs.writeFileSync(out+'/probe.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
current.destroy();reference.destroy();await changed.destroy();process.exit(errors.length||maxDifferenceM>.01?1:0);
