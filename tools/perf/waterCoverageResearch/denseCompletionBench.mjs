import fs from 'node:fs';
import {createRequire} from 'node:module';
import {createConnectivityBench,syntheticMask,summarize} from './gpuConnectivity.js';
import {flood} from './topologyChecks.mjs';
const req=createRequire('/Users/okkokauhanen/work/DATrain/feature/proj/terrain-lab/package.json'),{create,globals}=await import(req.resolve('webgpu'));
Object.assign(globalThis,globals);globalThis.__denseGpu=create([]);const adapter=await globalThis.__denseGpu.requestAdapter(),device=await adapter.requestDevice({requiredFeatures:['timestamp-query']});
const bench=await createConnectivityBench(device),report={cases:[],scope:'completed dense four-neighbour flood, checked against CPU BFS'};
try{for(const [n,kind] of [[512,'open'],[1024,'open'],[64,'snake']]){
 const mask=syntheticMask(n,kind),iterations=kind==='open'?2*(n-1):mask.reduce((a,b)=>a+b,0)-1,job=await bench.job(mask,n,0,'dense',iterations);
 await job.run();const samples=[];for(let i=0;i<5;i++)samples.push(await job.run());const actual=await job.read(),expected=flood(mask,n,0);let mismatch=0;for(let i=0;i<actual.length;i++)if(actual[i]!==expected[i])mismatch++;
 const c={n,kind,iterations,mismatch,...summarize(samples),samples};report.cases.push(c);console.log(JSON.stringify({n,kind,iterations,mismatch,gpuMs:c.gpuMs.median}));job.dispose();if(mismatch)throw new Error('Dense fill incorrect');
}report.errors=bench.errors;}catch(e){report.failure=String(e.stack??e);}finally{fs.writeFileSync(process.argv[2]??'/tmp/water-dense-completion.json',JSON.stringify(report,null,2));bench.dispose();device.destroy();}
process.exitCode=report.failure||report.errors?.length?1:0;
