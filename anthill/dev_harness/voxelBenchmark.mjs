// Optional browser benchmark; requires an existing Puppeteer Core installation.
// node dev_harness/voxelBenchmark.mjs --puppeteer /path/to/puppeteer-core.js --out results.json
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { installGpuTiming } from './gpuTiming.js';
const arg=(name,fallback)=>{const i=process.argv.indexOf(`--${name}`);return i<0?fallback:process.argv[i+1];};
const modulePath=arg('puppeteer','puppeteer-core');
const puppeteer=(await import(modulePath.startsWith('/')?pathToFileURL(modulePath).href:modulePath)).default;
const width=Number(arg('width','1264')),height=Number(arg('height','791'));
const seconds=Number(arg('seconds','2'));
const results={date:new Date().toISOString(),method:'GPU timestamps across compute and shading; each frame awaits GPU completion',cases:[]};
const browser=await puppeteer.launch({executablePath:arg('chrome','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),headless:true,args:['--enable-unsafe-webgpu','--enable-webgpu-developer-features','--use-angle=metal','--disable-gpu-sandbox','--disable-gpu-vsync','--disable-frame-rate-limit']});
try {
 const page=await browser.newPage(); await page.setViewport({width,height,deviceScaleFactor:1});
 await page.evaluateOnNewDocument(installGpuTiming);
 const errors=[];page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.goto(arg('url','http://127.0.0.1:8026/dev_harness/voxel.html'));
 await page.waitForFunction(()=>window.harnessFrameCount>30||window.harnessError,{timeout:60000});
 if(await page.evaluate(()=>!!window.harnessError))throw Error(await page.evaluate(()=>window.harnessError));
 await page.evaluate(async()=>{window.harness.frameLoop.stop();await window.harness.renderer.backend.device.queue.onSubmittedWorkDone();});
 const measure=(orbit=false)=>page.evaluate(async({seconds,orbit})=>{
   const h=window.harness,c=['first-person','third-person'].includes(h.cameraMode)?h.characterCamera:h.inspectionCamera??h.camera;
   const canvas=document.querySelector('canvas');
   c.update(canvas.width,canvas.height);h.view.showGround=!h.inspectionCamera;
   const queue=h.renderer.backend.device.queue;
   for(let i=0;i<20;i++){h.renderer.renderFrame({camera:c,deltaTime:1/120});await queue.onSubmittedWorkDone();}
   window.gpuSamples=[];window.profileGpu=true;
   const start=performance.now();let count=0;
   const frameTimes=[],cpuTimes=[];
   while(performance.now()-start<seconds*1000){
     const frameStart=performance.now();
     if(orbit){c.yaw+=0.004;c.pitch=0.6+0.15*Math.sin(count*0.007);}
     c.update(canvas.width,canvas.height);
     h.renderer.renderFrame({camera:c,deltaTime:1/120});
     cpuTimes.push(performance.now()-frameStart);
     await queue.onSubmittedWorkDone();frameTimes.push(performance.now()-frameStart);count++;
   }
   window.profileGpu=false;const elapsed=performance.now()-start;
   await new Promise(r=>setTimeout(r,50));
   const samples=window.gpuSamples.slice().sort((a,b)=>a-b);
   frameTimes.sort((a,b)=>a-b);cpuTimes.sort((a,b)=>a-b);
   return {fps:count*1000/elapsed,frameMs:elapsed/count,frameP95:frameTimes[Math.floor(frameTimes.length*.95)],cpuP50:cpuTimes[Math.floor(cpuTimes.length*.5)],gpuCount:samples.length,gpuP50:samples[Math.floor(samples.length*.5)],gpuP95:samples[Math.floor(samples.length*.95)],pixels:[canvas.width,canvas.height]};
 },{seconds,orbit});
 const record=async(name,orbit=false)=>{const row={name,...await measure(orbit)};results.cases.push(row);console.log(row);};
 results.device=await page.evaluate(()=>{const i=window.harness.renderer.backend.adapter.info;return {vendor:i.vendor,architecture:i.architecture,device:i.device,description:i.description,timestamps:window.hasGpuTimestamps,userAgent:navigator.userAgent};});
 console.log(results.device);
 if(process.argv.includes('--no-hit-cache'))await page.evaluate(()=>window.harness.view.reuseHits=false);
 if(process.argv.includes('--no-mesh-lod'))await page.evaluate(()=>window.harness.view.meshLOD=false);
 if(process.argv.includes('--dig-stress')) {
   results.stress=[];
   await page.evaluate(()=>{
     const h=window.harness;
     document.querySelector('aside').style.display='none';
     h.lighting.running=false;h.lighting.setTimeOfDay(12);h.lighting.setOccluder(null);
     h.setCameraMode('inspection');
     Object.assign(h.inspectionCamera,{metersPerPixel:450/document.querySelector('canvas').width,pitch:0.65,yaw:0.45,target:{x:-18,y:8.5,z:10}});
   });
   let previous=0;
   for(const digs of [0,256,1024]) {
     await page.evaluate(({previous,digs})=>{
       const h=window.harness,v=h.region.volume;
       for(let i=previous;i<digs;i++)h.region.apply({shape:{type:'sphere',
         center:[-112+(i%24)*9,v.minY+24+Math.floor(i/576)*8,-112+(Math.floor(i/24)%24)*9],radius:1.15}});
       h.setCameraMode('inspection');h.view.clipEnabled=false;h.view.reuseHits=false;
       Object.assign(h.inspectionCamera,{metersPerPixel:450/document.querySelector('canvas').width,pitch:0.65,yaw:0.45,target:{x:-18,y:8.5,z:10}});
       h.lighting.setCarriedLight([54,12,10],false);
     },{previous,digs});
     const edits=await page.evaluate(()=>{
       const h=window.harness,gpu=h.view.volumeGPU,device=h.renderer.backend.device;
       gpu.sync();h.view.normalGPU.sync(h.inspectionCamera.target);
       const editMs=[],syncMs=[];let bytes=0,writes=0;
       const write=device.queue.writeBuffer.bind(device.queue);
       device.queue.writeBuffer=function(buffer,offset,data,...args){bytes+=data.byteLength;writes++;return write(buffer,offset,data,...args);};
       try {
         for(let i=0;i<32;i++) {
           const start=performance.now();
           h.region.apply({mode:i%2?'fill':'carve',shape:{type:'sphere',center:[0,-10,0],radius:i%2?1.8:0.85}});
           const edited=performance.now();gpu.sync();h.view.normalGPU.sync(h.inspectionCamera.target);
           editMs.push(edited-start);syncMs.push(performance.now()-edited);
         }
       } finally {device.queue.writeBuffer=write;}
       const summary=a=>{a.sort((x,y)=>x-y);return {p50:a[16],p95:a[30],mean:a.reduce((s,x)=>s+x,0)/a.length};};
       const v=h.region.volume;
       return {allocatedChunks:v.allocatedChunks,cpuDensityBytes:v.memoryBytes,hasAdditions:v.hasAdditions??null,gpuDensityBytes:gpu.capacity*gpu.wordsPerChunk*4,
         gpuNormalBytes:h.view.normalGPU.capacity*h.view.normalGPU.perChunk*4,editMs:summary(editMs),syncMs:summary(syncMs),uploadedBytesPerEdit:bytes/32,writesPerEdit:writes/32};
     });
     results.stress.push({digs,...edits});console.log('stress',results.stress.at(-1));
     await record(`overview after ${digs} digs (trace every frame)`);
     await page.evaluate(()=>window.harness.view.reuseHits=true);
     await record(`overview after ${digs} digs (reuse hits)`);
     await page.evaluate(()=>{
       const h=window.harness;h.setCameraMode('first-person');
       Object.assign(h.character.position,{x:-18,y:7,z:10});h.character.heading=Math.PI;h.character.pitch=0;
       h.lighting.setCarriedLight([-17,8.5,10],true);h.view.reuseHits=false;
     });
     await record(`chamber after ${digs} offscreen digs`);
     previous=digs;
   }
   for(const length of [16,64,192]) {
     await page.evaluate(length=>{
       const h=window.harness;
       h.region.apply({shape:{type:'capsule',a:[96-length,-16,80],b:[96,-16,80],radius:2}});
       Object.assign(h.character.position,{x:94,y:-17.62,z:80});h.character.heading=Math.PI;h.character.pitch=0;
       h.lighting.setCarriedLight([94,-15.7,80],true);h.view.reuseHits=false;
     },length);
     await record(`tunnel ${length} m (trace every frame)`);
   }
   if(arg('capture',null))await page.screenshot({path:arg('capture')});
 } else {
 if(process.argv.includes('--reference'))await page.evaluate(()=>window.harness.view.useCompute=false);
 await record('anthill');
 results.numerical=await page.evaluate(async()=>{const {verifyVoxelGPU}=await import('/dev_harness/verifyVoxelGPU.js');return verifyVoxelGPU(window.harness);});
 console.log('numerical',results.numerical);
 await page.evaluate(()=>{document.querySelector('aside').style.display='none';const h=window.harness;h.toggleInspection();const c=h.inspectionCamera;c.metersPerPixel=450/document.querySelector('canvas').width;c.pitch=0.65;c.yaw=0.45;c.target={x:-18,y:8.5,z:10};});
 await record('cutaway');
 await page.evaluate(()=>window.harness.view.clipEnabled=false);
 await record('complete volume');
 if(arg('capture',null))await page.screenshot({path:arg('capture')});
 await record('complete volume orbit',true);
 await page.evaluate(async()=>{
   const {inspectionPixelRatio}=await import('/dev_harness/inspectionResolution.js');
   const h=window.harness,c=h.inspectionCamera,canvas=document.querySelector('canvas');
   const ratio=inspectionPixelRatio(canvas.clientWidth,canvas.clientHeight,1,true);
   c.setPixelRatio(ratio);h.renderer.resize(Math.round(canvas.clientWidth*ratio),Math.round(canvas.clientHeight*ratio));
 });
 await record('complete volume moving budget',true);
 if(process.argv.includes('--verify-images')) {
   results.imageChecks=[];
   const capture=async(skip,compute)=>{
     await page.evaluate(async({skip,compute})=>{const h=window.harness;h.view.emptySpaceSkipping=skip;h.view.useCompute=compute;const c=h.inspectionCamera;c.update(h.renderer.viewport.width,h.renderer.viewport.height);h.renderer.renderFrame({camera:c,deltaTime:0});await h.renderer.backend.device.queue.onSubmittedWorkDone();},{skip,compute});
     return page.screenshot({encoding:'base64'});
   };
   const compare=async(a,b)=>page.evaluate(async([a,b])=>{
     const decode=async base64=>{
       const image=await createImageBitmap(await(await fetch('data:image/png;base64,'+base64)).blob());
       const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
       const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);image.close();
       return ctx.getImageData(0,0,canvas.width,canvas.height).data;
     };
     const x=await decode(a),y=await decode(b);let different=0,maxDifference=0,largeDifferences=0;
     for(let i=0;i<x.length;i+=4){let delta=0;for(let c=0;c<3;c++)delta=Math.max(delta,Math.abs(x[i+c]-y[i+c]));if(delta)different++;if(delta>8)largeDifferences++;maxDifference=Math.max(maxDifference,delta);}
     return {pixels:x.length/4,different,maxDifference,largeDifferences};
   },[a,b]);
   await page.evaluate(()=>window.harness.region.apply({mode:'fill',shape:{type:'sphere',center:[0,58,0],radius:2.4}}));
   for(const [yaw,pitch,clip] of [[0,0,true],[0.45,0.65,false],[-1.2,-0.35,false],[2.2,0.9,false]]) {
     await page.evaluate(({yaw,pitch,clip})=>{const h=window.harness;h.inspectionCamera.yaw=yaw;h.inspectionCamera.pitch=pitch;h.view.clipEnabled=clip;},{yaw,pitch,clip});
     const baseline=await capture(false,true),accelerated=await capture(true,true),reference=await capture(true,false);
     const skip=await compare(baseline,accelerated),split=await compare(accelerated,reference);
     const row={yaw,pitch,clip,skip,split};results.imageChecks.push(row);console.log('image',row);
     if(skip.largeDifferences>skip.pixels*0.002||split.largeDifferences>split.pixels*0.002)throw Error('Voxel image regression');
   }
 }
 }
 results.errors=errors;
 if(arg('out',null))await writeFile(arg('out'),JSON.stringify(results,null,2)+'\n');
 console.log('errors',errors);if(errors.length)process.exitCode=1;
}finally{await browser.close();}
