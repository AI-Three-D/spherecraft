import fs from 'node:fs';
import {createRequire} from 'node:module';
import {createConnectivityBench,syntheticMask,summarize} from './gpuConnectivity.js';
import {flood,correctnessChecks} from './topologyChecks.mjs';
const req=createRequire('/Users/okkokauhanen/work/DATrain/feature/proj/terrain-lab/package.json');
const {create,globals}=await import(req.resolve('webgpu'));
Object.assign(globalThis,globals);globalThis.__researchGpu=create([]);
const adapter=await globalThis.__researchGpu.requestAdapter();
const device=await adapter.requestDevice({requiredFeatures:adapter.features.has('timestamp-query')?['timestamp-query']:[],requiredLimits:{maxStorageBufferBindingSize:adapter.limits.maxStorageBufferBindingSize,maxBufferSize:adapter.limits.maxBufferSize}});
const out=process.argv[2]??'/tmp/water-connectivity-bench.json';
const report={startedAt:new Date().toISOString(),adapter:adapter.info,backend:'Node Dawn/Metal',scope:'single water level, binary wet mask, four-neighbour connectivity; excludes gathering heights, water level/ownership evaluation, geometry and rendering',limits:{maxStorageBufferBindingSize:device.limits.maxStorageBufferBindingSize,maxBufferSize:device.limits.maxBufferSize},checks:correctnessChecks(),correctness:[],cases:[]};
const save=()=>fs.writeFileSync(out,JSON.stringify(report,null,2));
try {
const bench=await createConnectivityBench(device);report.compileMs=bench.compileMs;report.timestamp=bench.timestamp;
let rng=0x12345;const random=()=>{rng=(Math.imul(rng,1664525)+1013904223)>>>0;return rng/2**32;};
for(let q=0;q<12;q++){
 const n=q%2?64:128,kind=['open','snake','split','shore'][q%4],mask=syntheticMask(n,kind);
 if(q>=4)for(let k=0;k<mask.length;k++)mask[k]=random()>(q%2?.2:.55)?1:0;
 let seed=mask.findIndex(x=>x!==0);const job=await bench.job(mask,n,seed);await job.run();const actual=await job.read(),expected=flood(mask,n,seed);let mismatch=0;for(let k=0;k<mask.length;k++)if(actual[k]!==expected[k])mismatch++;
 report.correctness.push({n,kind:q>=4?'random':kind,mismatch});job.dispose();if(mismatch)throw new Error(`union correctness mismatch ${mismatch}`);
}
save();
for(const n of [512,1024,2048,3200]){
 for(const kind of ['open','shore','snake']){
  const mask=syntheticMask(n,kind),job=await bench.job(mask,n,0);await job.run();await job.run();const samples=[];
  for(let q=0;q<7;q++)samples.push(await job.run());
  const actual=await job.read(),expected=flood(mask,n,0);let mismatch=0,wet=0;for(let k=0;k<actual.length;k++){if(actual[k]!==expected[k])mismatch++;wet+=mask[k];}
  const rec={n,kind,method:'blocked union-find',cells:n*n,wetCells:wet,bufferBytes:job.bytes,mismatch,...summarize(samples),samples};report.cases.push(rec);save();console.log(JSON.stringify({n,kind,gpuMs:rec.gpuMs?.median,wallMs:rec.fenceWallMs.median,mismatch}));job.dispose();if(mismatch)throw new Error(`large mismatch ${n} ${kind}`);
 }
 for(const iterations of [16,64]){
  const mask=syntheticMask(n,'open'),job=await bench.job(mask,n,0,'dense',iterations);await job.run();const samples=[];for(let q=0;q<5;q++)samples.push(await job.run());
  const rec={n,kind:'open',method:'dense flood',iterations,cells:n*n,bufferBytes:job.bytes,...summarize(samples),samples};report.cases.push(rec);save();console.log(JSON.stringify({n,method:rec.method,iterations,gpuMs:rec.gpuMs?.median}));job.dispose();
 }
}
report.errors=bench.errors;bench.dispose();
}catch(e){report.failure=String(e.stack??e);console.error(report.failure);}
finally{report.finishedAt=new Date().toISOString();save();device.destroy();}
process.exitCode=report.failure||report.errors?.length?1:0;
