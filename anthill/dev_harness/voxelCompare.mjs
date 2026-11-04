// Interleaved A/B timings reduce drift from other GPU work and clock/thermal changes.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { installGpuTiming } from './gpuTiming.js';
const arg=(name,fallback)=>{const i=process.argv.indexOf(`--${name}`);return i<0?fallback:process.argv[i+1];};
const modulePath=arg('puppeteer','puppeteer-core');
const puppeteer=(await import(modulePath.startsWith('/')?pathToFileURL(modulePath).href:modulePath)).default;
const browser=await puppeteer.launch({executablePath:arg('chrome','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),headless:true,
    args:['--enable-unsafe-webgpu','--enable-webgpu-developer-features','--use-angle=metal','--disable-gpu-sandbox','--disable-gpu-vsync','--disable-frame-rate-limit']});
const results={date:new Date().toISOString(),method:'Interleaved original/optimized batches; completed frames and GPU timestamps; fixed cameras and lighting',cases:[],errors:[]};
try {
    const pages=[];
    for(const url of [arg('before-url','http://127.0.0.1:8027/dev_harness/voxel.html'),arg('url','http://127.0.0.1:8026/dev_harness/voxel.html')]) {
        const page=await browser.newPage();pages.push(page);
        await page.setViewport({width:1264,height:791,deviceScaleFactor:1});
        await page.evaluateOnNewDocument(installGpuTiming);
        page.on('pageerror',e=>results.errors.push(String(e)));
        page.on('console',m=>{if(m.type()==='error')results.errors.push(m.text());});
        await page.goto(url);
        await page.waitForFunction(()=>window.harnessFrameCount>15||window.harnessError,{timeout:60000});
        await page.evaluate(async()=>{
            if(window.harnessError)throw Error(window.harnessError);
            const h=window.harness;h.frameLoop.stop();await h.renderer.backend.device.queue.onSubmittedWorkDone();
            document.querySelector('aside').style.display='none';
            h.lighting.running=false;h.lighting.setTimeOfDay(12);h.lighting.setCarriedLight([54,12,10],false);h.lighting.setOccluder(null);
        });
    }
    results.device=await pages[1].evaluate(()=>({description:window.harness.renderer.backend.adapter.info.description,timestamps:window.hasGpuTimestamps}));
    const setup=async({digs,mode,reuse=false,length=0})=>{
        for(const page of pages)await page.evaluate(({digs,mode,reuse,length})=>{
            const h=window.harness,v=h.region.volume;
            for(let i=window.benchmarkDigs??0;i<digs;i++)h.region.apply({shape:{type:'sphere',
                center:[-112+(i%24)*9,v.minY+24+Math.floor(i/576)*8,-112+(Math.floor(i/24)%24)*9],radius:1.15}});
            window.benchmarkDigs=digs;h.view.reuseHits=reuse;
            h.setCameraMode(mode==='overview'?'inspection':'first-person');
            h.view.clipEnabled=false;
            h.lighting.setCarriedLight([54,12,10],false);
            if(mode==='overview')Object.assign(h.inspectionCamera,{metersPerPixel:450/document.querySelector('canvas').width,
                pitch:0.65,yaw:0.45,target:{x:-18,y:8.5,z:10}});
            else {
                if(mode==='tunnel')h.region.apply({shape:{type:'capsule',a:[96-length,-16,80],b:[96,-16,80],radius:2}});
                Object.assign(h.character.position,mode==='tunnel'?{x:94,y:-17.62,z:80}:{x:-18,y:7,z:10});
                h.character.heading=Math.PI;h.character.pitch=0;
                h.lighting.setCarriedLight(mode==='tunnel'?[94,-15.7,80]:[-17,8.5,10],true);
            }
        },{digs,mode,reuse,length});
    };
    const batch=async(page,count,profile)=>page.evaluate(async({count,profile})=>{
        const h=window.harness,c=h.cameraMode==='inspection'?h.inspectionCamera:h.characterCamera;
        c.update(1264,791);h.view.showGround=false;
        window.gpuSamples=[];window.gpuPassSamples=[];window.profileGpu=profile;
        const start=performance.now();
        for(let i=0;i<count;i++) {h.renderer.renderFrame({camera:c,deltaTime:0});await h.renderer.backend.device.queue.onSubmittedWorkDone();}
        const elapsed=performance.now()-start;window.profileGpu=false;
        while(window.gpuPending)await new Promise(r=>setTimeout(r,0));
        return {elapsed,gpu:window.gpuSamples.slice(),passes:window.gpuPassSamples.slice()};
    },{count,profile});
    for(const scenario of [
        {digs:0,mode:'overview'},{digs:1024,mode:'overview'},
        {digs:1024,mode:'overview',reuse:true},{digs:1024,mode:'chamber'},
        {digs:1024,mode:'tunnel',length:16},{digs:1024,mode:'tunnel',length:192},
    ]) {
        await setup(scenario);
        for(const page of pages)await batch(page,15,false);
        const samples=[{elapsed:0,gpu:[],passes:[]},{elapsed:0,gpu:[],passes:[]}];
        for(let round=0;round<8;round++)for(const i of round%2?[1,0]:[0,1]) {
            const row=await batch(pages[i],8,true);samples[i].elapsed+=row.elapsed;samples[i].gpu.push(...row.gpu);samples[i].passes.push(...row.passes.flat());
        }
        const median=a=>a.sort((a,b)=>a-b)[Math.floor(a.length/2)];
        const rows=samples.map(s=>({frameMs:s.elapsed/64,gpuP50:median(s.gpu),gpuPassP50:Object.fromEntries([...new Set(s.passes.map(p=>p.label))].map(label=>[label,median(s.passes.filter(p=>p.label===label).map(p=>p.ms))]))}));
        const state=await pages[1].evaluate(()=>({hasAdditions:window.harness.region.volume.hasAdditions,baselineSafe:window.harness.view.rayData[27],
            normalBytes:window.harness.view.normalGPU.buffer.size,densityBytes:window.harness.view.volumeGPU.density.size}));
        const row={...scenario,before:rows[0],after:rows[1],state};results.cases.push(row);console.log(JSON.stringify(row));
    }
    assert.deepEqual(results.errors,[]);
    if(arg('out',null))await writeFile(arg('out'),JSON.stringify(results,null,2)+'\n');
} finally {await browser.close();}
