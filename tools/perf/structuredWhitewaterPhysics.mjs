/* global process */
import fs from 'node:fs';
import {createRequire} from 'node:module';
const req=createRequire(new URL('../../../terrain-lab/package.json',import.meta.url));
const {create,globals}=await import(req.resolve('webgpu'));Object.assign(globalThis,globals);
globalThis.__waterPhysicsGpu=create([]);
const adapter=await globalThis.__waterPhysicsGpu.requestAdapter(),device=await adapter.requestDevice();
const {ShallowWaterSim}=await import('../../core/world/water/ShallowWaterSim.js');
const errors=[];device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
const output=process.env.WATER_OUTPUT??'tools/perf/structured-terrain-results/whitewater-near/physics';fs.mkdirSync(output,{recursive:true});
const tests=[];
for(const perturbation of [0,.2]){
    const W=32,L=96,n=W*L,bed=new Float32Array(n),st=new Float32Array(n*4),rx=new Float32Array(n*4);
    for(let j=0;j<L;j++)for(let i=0;i<W;i++){
        const id=j*W+i,eta=Math.fround(500-.6*j),x=(i-15.5)-2*Math.sin(j*.1);
        bed[id]=eta+(Math.abs(x)>9?2:-2+.25*Math.sin(i*.4+j*.2));
        const h=Math.max(0,eta-bed[id]),v=.8*Math.pow(h,2/3);
        const dh=h>0?perturbation*Math.exp(-((i-16)**2+(j-48)**2)/30):0;
        st.set([h+dh,0,v,0],id*4);rx.set([eta,0,v,0],id*4);
    }
    const initial=st.slice(),sim=new ShallowWaterSim(device,{W,L,referenceFlow:true,macCormack:false,turbA:0,openMask:12});
    sim.setBed(bed);sim.setState(st);sim.setRelax(rx);
    for(let k=0;k<1000;k+=20){sim.step(20);await device.queue.onSubmittedWorkDone();}
    const out=await sim.readState();let maxDepthError=0,maxVelocityError=0,minH=Infinity,nonfinite=0,mass0=0,mass1=0,maxPerturbation=0;
    for(let id=0;id<n;id++){
        minH=Math.min(minH,out[id*4]);mass0+=initial[id*4];mass1+=out[id*4];
        if(!Array.from(out.subarray(id*4,id*4+4)).every(Number.isFinite))nonfinite++;
        maxDepthError=Math.max(maxDepthError,Math.abs(out[id*4]-initial[id*4]));
        maxVelocityError=Math.max(maxVelocityError,Math.abs(out[id*4+2]-initial[id*4+2]),Math.abs(out[id*4+1]));
        maxPerturbation=Math.max(maxPerturbation,Math.abs(out[id*4]-Math.max(0,rx[id*4]-bed[id])));
    }
    const pass=nonfinite===0&&minH>=0&&(perturbation>0?maxPerturbation<.2:maxDepthError<1e-4&&maxVelocityError<1e-4);
    tests.push({name:perturbation?'steep reference perturbation propagates and remains bounded':'steep curved design flow remains a fixed point',
        pass,simTime:sim.time,maxDepthError,maxVelocityError,maxPerturbation,minH,nonfinite,relativeMassChange:(mass1-mass0)/mass0});
    sim.destroy();
}
fs.writeFileSync(`${output}/report.json`,JSON.stringify({tests,gpuErrors:errors},null,2));console.log(JSON.stringify({tests,gpuErrors:errors}));
process.exit(errors.length||tests.some(t=>!t.pass)?1:0);
