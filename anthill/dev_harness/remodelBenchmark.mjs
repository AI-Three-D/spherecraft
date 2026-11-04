// Compare active remodeling in two locally served snapshots, including hit reuse.
import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {installGpuTiming} from './gpuTiming.js';
const arg=(name,fallback)=>{const i=process.argv.indexOf(`--${name}`);return i<0?fallback:process.argv[i+1];};
const modulePath=arg('puppeteer','puppeteer-core');
const puppeteer=(await import(modulePath.startsWith('/')?pathToFileURL(modulePath).href:modulePath)).default;
const browser=await puppeteer.launch({executablePath:arg('chrome','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),headless:true,
    args:['--enable-unsafe-webgpu','--enable-webgpu-developer-features','--use-angle=metal','--disable-gpu-sandbox','--disable-gpu-vsync','--disable-frame-rate-limit']});
const results={date:new Date().toISOString(),method:'Alternating 500 ms slices, live maintenance and hit reuse, GPU completion per frame, 1000 × 700',cases:[],errors:[]};
try {
    for(const scene of ['overview','long-tunnel','large-network']) {
        const pages=[];
        for(const url of [arg('before-url','http://127.0.0.1:8028/dev_harness/voxel.html'),arg('url','http://127.0.0.1:8026/dev_harness/voxel.html')]) {
            const page=await browser.newPage();pages.push(page);
            await page.setViewport({width:1000,height:700,deviceScaleFactor:1});
            await page.evaluateOnNewDocument(installGpuTiming);
            page.on('pageerror',e=>results.errors.push(String(e)));
            page.on('console',m=>{if(m.type()==='error')results.errors.push(m.text());});
            await page.goto(url);await page.waitForFunction(()=>window.harnessFrameCount>10||window.harnessError);
            await page.evaluate(async scene=>{
                const h=window.harness;h.frameLoop.stop();await h.renderer.backend.device.queue.onSubmittedWorkDone();
                h.lighting.running=false;h.lighting.setTimeOfDay(12);h.lighting.setOccluder(null);
                h.lighting.setCarriedLight([54,12,10],false);h.lighting.carried.flicker=0;h.view.showGround=false;
                h.setCameraMode('inspection');h.view.clipEnabled=false;
                Object.assign(h.inspectionCamera,{metersPerPixel:.42,pitch:.65,yaw:.45,target:{x:-18,y:8.5,z:10}});
                if(scene==='large-network') {
                    const v=h.region.volume;
                    for(let i=0;i<1024;i++)h.region.apply({shape:{type:'sphere',
                        center:[-112+(i%24)*9,v.minY+24+Math.floor(i/576)*8,-112+(Math.floor(i/24)%24)*9],radius:1.15}});
                }
                if(scene==='long-tunnel') {
                    h.region.apply({shape:{type:'capsule',a:[-108,-35,0],b:[100,-35,0],radius:3.25}});
                    h.setCameraMode('first-person');
                    Object.assign(h.character.position,{x:98,y:-36.62,z:0});h.character.heading=Math.PI;h.character.pitch=0;
                    h.lighting.setCarriedLight([97,-34,0],true);
                }
                const c=h.view.meshCache;
                // Start both caches from the same fresh state, after fixture setup.
                c.dispose();const {VolumeMeshCache}=await import('/core/voxel/VolumeMeshCache.js');
                h.view.meshCache=new VolumeMeshCache(h.region.volume,h.renderer.backend.device);
                window.benchTraces=0;window.benchMeshPasses=0;window.benchWorkerMs=0;window.benchJobs=0;
                window.benchPhase=0;
                const encoder=h.renderer.backend.device.createCommandEncoder.bind(h.renderer.backend.device);
                h.renderer.backend.device.createCommandEncoder=(...args)=>{
                    const e=encoder(...args),compute=e.beginComputePass.bind(e),render=e.beginRenderPass.bind(e);
                    e.beginComputePass=(d={})=>{if(d.label==='Voxel ray search')window.benchTraces++;return compute(d);};
                    e.beginRenderPass=d=>{if(d.label==='Voxel geometry LOD hits')window.benchMeshPasses++;return render(d);};return e;
                };
                const receive=h.view.meshCache.worker.onmessage;
                h.view.meshCache.worker.onmessage=event=>{window.benchWorkerMs+=event.data.milliseconds??0;window.benchJobs++;receive(event);};
                window.benchSample=async moving=>{
                    const cam=h.cameraMode==='first-person'?h.characterCamera:h.inspectionCamera;
                    const canvas=document.querySelector('canvas'),q=h.renderer.backend.device.queue;
                    const cpu=[],frames=[],maintenance=[];window.gpuSamples=[];window.gpuPassSamples=[];window.profileGpu=true;
                    const start=performance.now(),traces=window.benchTraces,passes=window.benchMeshPasses,jobs=window.benchJobs,worker=window.benchWorkerMs;
                    while(performance.now()-start<500) {
                        if(moving) {
                            const phase=window.benchPhase+performance.now()-start;
                            if(h.cameraMode==='first-person')h.character.heading=Math.PI+phase*.00005;
                            else cam.yaw=.45+phase*.0001;
                        }
                        cam.update(canvas.width,canvas.height);
                        const t=performance.now();h.renderer.renderFrame({camera:cam,deltaTime:0});cpu.push(performance.now()-t);
                        maintenance.push(h.view.meshCache.stats.maintenanceMs);await q.onSubmittedWorkDone();frames.push(performance.now()-t);
                    }
                    if(moving)window.benchPhase+=500;
                    window.profileGpu=false;await new Promise(r=>setTimeout(r,10));
                    return {cpu,frames,maintenance,gpu:window.gpuSamples,elapsed:performance.now()-start,
                        traces:window.benchTraces-traces,meshPasses:window.benchMeshPasses-passes,jobs:window.benchJobs-jobs,workerMs:window.benchWorkerMs-worker};
                };
            },scene);
        }
        for(const moving of [false,true]) {
            const samples=[[],[]];
            const starts=[];
            for(const page of pages)starts.push(await page.evaluate(()=>({jobs:window.benchJobs,worker:window.benchWorkerMs})));
            for(let round=0;round<Number(arg('rounds','12'));round++)for(const i of round%2?[1,0]:[0,1])
                samples[i].push(await pages[i].evaluate(moving=>window.benchSample(moving),moving));
            const summary=a=>{a.sort((x,y)=>x-y);return {p50:a[Math.floor(a.length*.5)],p95:a[Math.floor(a.length*.95)],max:a.at(-1)};};
            const row={scene,moving};
            for(let i=0;i<2;i++) {
                const a=samples[i],total=k=>a.reduce((s,x)=>s+x[k],0);
                const end=await pages[i].evaluate(()=>({jobs:window.benchJobs,worker:window.benchWorkerMs}));
                row[i?'after':'before']={frameCount:a.reduce((s,x)=>s+x.frames.length,0),elapsedMs:total('elapsed'),traces:total('traces'),
                    meshPasses:total('meshPasses'),workerJobs:end.jobs-starts[i].jobs,workerMs:end.worker-starts[i].worker,
                    ...Object.fromEntries(['cpu','frames','maintenance','gpu'].map(k=>[k,summary(a.flatMap(x=>x[k]))])),
                    stats:await pages[i].evaluate(()=>({...window.harness.view.meshCache.stats,
                        densityBytes:window.harness.region.volume.memoryBytes,allocatedChunks:window.harness.region.volume.allocatedChunks}))};
            }
            results.cases.push(row);console.log(JSON.stringify(row));
        }
        for(const page of pages)await page.close();
    }
    if(arg('out',null))await writeFile(arg('out'),JSON.stringify(results,null,2)+'\n');
    if(results.errors.length)throw Error(results.errors.join('\n'));
} finally {await browser.close();}
