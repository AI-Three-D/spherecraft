// Real WebGPU image, edit-race and timing checks for derived geometry.
import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {installGpuTiming} from './gpuTiming.js';
const arg=(name,fallback)=>{const i=process.argv.indexOf(`--${name}`);return i<0?fallback:process.argv[i+1];};
const modulePath=arg('puppeteer','puppeteer-core');
const puppeteer=(await import(modulePath.startsWith('/')?pathToFileURL(modulePath).href:modulePath)).default;
const browser=await puppeteer.launch({executablePath:arg('chrome','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),headless:true,
    args:['--enable-unsafe-webgpu','--enable-webgpu-developer-features','--use-angle=metal','--disable-gpu-sandbox','--disable-gpu-vsync','--disable-frame-rate-limit']});
const results={date:new Date().toISOString(),method:'Frozen lighting, alternating density/mesh batches, GPU completion and timestamps; 1000 × 700 pixels',cases:[]};
try {
    const page=await browser.newPage();await page.setViewport({width:1000,height:700,deviceScaleFactor:1});
    await page.evaluateOnNewDocument(installGpuTiming);
    const errors=[];
    page.on('pageerror',e=>errors.push(String(e)));
    page.on('console',m=>{if(m.type()==='error'||m.type()==='warn')errors.push(m.text());});
    await page.goto(arg('url','http://127.0.0.1:8026/dev_harness/voxel.html'));
    await page.waitForFunction(()=>window.harnessFrameCount>10||window.harnessError,{timeout:60000});
    if(await page.evaluate(()=>window.harnessError))throw Error(await page.evaluate(()=>window.harnessError));
    await page.evaluate(()=>{
        const h=window.harness;h.frameLoop.stop();h.lighting.running=false;h.lighting.setTimeOfDay(12);
        h.lighting.setOccluder(null);h.lighting.setCarriedLight([54,12,10],false);h.view.showGround=false;
        h.lighting.carried.flicker=0;
        h.view.reuseHits=false;document.querySelector('aside').style.display='none';
    });
    results.device=await page.evaluate(()=>{const i=window.harness.renderer.backend.adapter.info;return {vendor:i.vendor,architecture:i.architecture,description:i.description,userAgent:navigator.userAgent,timestamps:window.hasGpuTimestamps};});
    for(const [name,setup] of [
        ['overview',()=>{
            const h=window.harness;h.setCameraMode('inspection');
            Object.assign(h.inspectionCamera,{metersPerPixel:.42,pitch:.65,yaw:.45,target:{x:-18,y:8.5,z:10}});h.view.clipEnabled=false;
        }],
        ['cutaway',()=>{
            const h=window.harness;h.view.clipEnabled=true;h.plane.set(.45,10);
        }],
        ['anthill',()=>{
            const h=window.harness;h.setCameraMode('anthill');h.plane.set(0,10);
            Object.assign(h.camera,{metersPerPixel:.16,center:{s:0,y:-5}});h.view.clipEnabled=true;
            h.lighting.setCarriedLight([-18,8.5,10],true);
        }],
        ['chamber',()=>{
            const h=window.harness;h.setCameraMode('first-person');
            Object.assign(h.character.position,{x:-18,y:7,z:10});h.character.heading=Math.PI;h.character.pitch=0;
            h.lighting.setCarriedLight([-17,8.5,10],true);
        }],
        ['long-tunnel',()=>{
            const h=window.harness;
            h.region.apply({shape:{type:'capsule',a:[-108,-35,0],b:[100,-35,0],radius:3.25}});
            h.setCameraMode('first-person');
            Object.assign(h.character.position,{x:98,y:-36.62,z:0});h.character.heading=Math.PI;h.character.pitch=0;
            h.lighting.setCarriedLight([97,-34,0],true);
        }],
    ]) {
        await page.evaluate(setup);
        const row=await page.evaluate(async({name,warmSeconds})=>{
            const h=window.harness,v=h.view,cache=v.meshCache,canvas=document.querySelector('canvas'),q=h.renderer.backend.device.queue;
            const camera=()=>['first-person','third-person'].includes(h.cameraMode)?h.characterCamera:h.inspectionCamera??h.camera;
            const frame=async()=>{const c=camera();c.update(canvas.width,canvas.height);h.renderer.renderFrame({camera:c,deltaTime:1/120});await q.onSubmittedWorkDone();};
            const maintenance=[],started=performance.now();
            while(performance.now()-started<warmSeconds*1000) {
                await frame();maintenance.push(cache.stats.maintenanceMs);await new Promise(r=>setTimeout(r,2));
            }
            const warmed=performance.now()-started,stats={...cache.stats},levels={};
            for(const r of cache.draws)levels[r.level]=(levels[r.level]??0)+1;
            const budget=cache.budgetMs;cache.budgetMs=0;
            const capture=async enabled=>{
                v.meshLOD=enabled;await frame();
                // Dither reveal completes while the simulation remains paused.
                if(enabled){await new Promise(r=>setTimeout(r,400));await frame();}
                return canvas.toDataURL();
            };
            const off=await capture(false),on=await capture(true);
            const decode=async data=>{
                const image=await createImageBitmap(await(await fetch(data)).blob());
                const c=document.createElement('canvas');c.width=image.width;c.height=image.height;
                const ctx=c.getContext('2d');ctx.drawImage(image,0,0);image.close();
                return ctx.getImageData(0,0,c.width,c.height).data;
            };
            const a=await decode(off),b=await decode(on);let different=0,large=0,sum=0,max=0;
            for(let i=0;i<a.length;i+=4){let delta=0;for(let c=0;c<3;c++)delta=Math.max(delta,Math.abs(a[i+c]-b[i+c]));
                if(delta)different++;if(delta>8)large++;sum+=delta;max=Math.max(max,delta);}
            const timings={},gpuTimings={},cpuTimings={},passes={};
            for(const enabled of [false,true,false,true]){
                v.meshLOD=enabled;
                for(let i=0;i<5;i++)await frame();
                if(enabled){await new Promise(r=>setTimeout(r,400));await frame();}
                const samples=[],cpu=[];window.gpuSamples=[];window.gpuPassSamples=[];window.profileGpu=true;
                for(let i=0;i<40;i++){
                    const cam=camera();cam.update(canvas.width,canvas.height);
                    const s=performance.now();h.renderer.renderFrame({camera:cam,deltaTime:1/120});cpu.push(performance.now()-s);
                    await q.onSubmittedWorkDone();samples.push(performance.now()-s);
                }
                window.profileGpu=false;await new Promise(r=>setTimeout(r,10));
                (timings[enabled?'mesh':'density']??=[]).push(...samples);
                (gpuTimings[enabled?'mesh':'density']??=[]).push(...window.gpuSamples);
                (cpuTimings[enabled?'mesh':'density']??=[]).push(...cpu);
                for(const frame of window.gpuPassSamples)for(const p of frame)(passes[`${enabled?'mesh':'density'} ${p.label}`]??=[]).push(p.ms);
            }
            const summary=a=>{a.sort((x,y)=>x-y);return {p50:a[Math.floor(a.length*.5)],p95:a[Math.floor(a.length*.95)],max:a.at(-1)};};
            v.meshLOD=true;cache.budgetMs=budget;
            return {name,warmedMs:warmed,stats,levels,image:{pixels:a.length/4,different,large,max,meanMaximumChannel:sum/(a.length/4)},
                maintenance:summary(maintenance),densityMs:summary(timings.density),meshMs:summary(timings.mesh),
                gpuMs:Object.fromEntries(Object.entries(gpuTimings).map(([k,v])=>[k,summary(v)])),
                cpuMs:Object.fromEntries(Object.entries(cpuTimings).map(([k,v])=>[k,summary(v)])),
                passes:Object.fromEntries(Object.entries(passes).map(([k,v])=>[k,summary(v)]))};
        },{name,warmSeconds:Number(arg('warm-seconds','7'))});
        results.cases.push(row);console.log(JSON.stringify(row));
        if(arg('capture-prefix',null))await page.screenshot({path:`${arg('capture-prefix')}-${name}.png`});
    }
    results.editVisibility=await page.evaluate(async()=>{
        const h=window.harness,v=h.view,d=h.renderer.backend.device,camera=h.characterCamera,canvas=document.querySelector('canvas');
        const frame=async()=>{camera.update(canvas.width,canvas.height);h.renderer.renderFrame({camera,deltaTime:0});await d.queue.onSubmittedWorkDone();};
        const center=async()=>{
            const buffer=d.createBuffer({size:256,usage:1|8}),encoder=d.createCommandEncoder();
            encoder.copyTextureToBuffer({texture:v.hitTexture,origin:[Math.floor(canvas.width/2),Math.floor(canvas.height/2)]},
                {buffer,bytesPerRow:256},[1,1]);
            d.queue.submit([encoder.finish()]);await buffer.mapAsync(1);
            const result=Array.from(new Float32Array(buffer.getMappedRange()).slice(0,4));
            buffer.unmap();buffer.destroy();return result;
        };
        v.meshLOD=true;await frame();const before=await center();
        const edit=h.region.apply({mode:'fill',shape:{type:'sphere',center:[64,-35,0],radius:2.8}});
        await frame();const immediate=await center();v.meshLOD=false;await frame();const reference=await center();
        const error=Math.hypot(...immediate.slice(0,3).map((x,i)=>x-reference[i]));
        h.region.apply({shape:{type:'capsule',a:[-108,-35,0],b:[100,-35,0],radius:3.25}});v.meshLOD=true;
        return {changed:edit?.changed??0,before,immediate,reference,error,
            passed:!!edit&&before[0]<0&&immediate[0]>64&&error<.002};
    });
    console.log('edit visibility',results.editVisibility);
    results.transitions=await page.evaluate(async()=>{
        const h=window.harness,c=h.view.meshCache,v=h.view,q=h.renderer.backend.device.queue,canvas=document.querySelector('canvas');
        h.setCameraMode('inspection');v.clipEnabled=false;h.lighting.setCarriedLight([54,12,10],false);
        const camera=h.inspectionCamera;
        Object.assign(camera,{metersPerPixel:.42,pitch:.65,yaw:.45,target:{x:-18,y:8.5,z:10}});
        const frame=async()=>{camera.update(canvas.width,canvas.height);h.renderer.renderFrame({camera,deltaTime:0});await q.onSubmittedWorkDone();};
        const pixels=async()=>{
            const image=await createImageBitmap(await(await fetch(canvas.toDataURL())).blob()),surface=document.createElement('canvas');
            surface.width=image.width;surface.height=image.height;const ctx=surface.getContext('2d');ctx.drawImage(image,0,0);image.close();
            return ctx.getImageData(0,0,surface.width,surface.height).data;
        };
        const compare=(a,b)=>{
            let different=0,large=0,max=0;
            for(let i=0;i<a.length;i+=4){let d=0;for(let j=0;j<3;j++)d=Math.max(d,Math.abs(a[i+j]-b[i+j]));
                if(d)different++;if(d>8)large++;max=Math.max(max,d);}
            return {pixels:a.length/4,different,large,max};
        };
        const budget=c.budgetMs,clock=c.now;let time=performance.now();c.budgetMs=0;c.now=()=>time;
        v.meshLOD=false;await frame();const reference=await pixels();v.meshLOD=true;
        const reveal=[];
        for(const fraction of [0,.25,.5,.75,1]) {
            time+=fraction===0?0:c.fadeMs*.25;await frame();
            reveal.push({fraction,...compare(reference,await pixels()),active:c.draws.length,
                maxCoverage:Math.max(0,...c.coverage.values())});
        }
        const settled=await pixels();await frame();const stable=compare(settled,await pixels());
        const zoom=[];
        for(const mpp of [.21,.42,.84,1.68,.84,.42,.21]) {
            camera.metersPerPixel=mpp;v.meshLOD=false;await frame();const baseline=await pixels();
            v.meshLOD=true;time+=c.fadeMs;await frame();
            zoom.push({mpp,...compare(baseline,await pixels()),levels:[...new Set(c.draws.map(r=>r.level))],active:c.draws.length});
        }
        c.budgetMs=budget;c.now=clock;c.previousTime=clock();
        return {reveal,stable,zoom};
    });
    console.log('transitions',JSON.stringify(results.transitions));
    results.races=await page.evaluate(async()=>{
        const h=window.harness,c=h.view.meshCache,q=h.renderer.backend.device.queue;
        h.setCameraMode('inspection');h.view.clipEnabled=false;
        Object.assign(h.inspectionCamera,{metersPerPixel:.42,pitch:.65,yaw:.45,target:{x:-18,y:8.5,z:10}});
        const frame=async()=>{const cam=h.inspectionCamera,canvas=document.querySelector('canvas');cam.update(canvas.width,canvas.height);h.renderer.renderFrame({camera:cam,deltaTime:1/120});await q.onSubmittedWorkDone();};
        const before=c.stats.discarded;let raced=false;
        await frame();
        const target=c.draws.find(r=>r.fullTriangles>0);
        if(target)c.invalidate({min:target.c.map(x=>x*c.cells+1),max:target.c.map(x=>x*c.cells+2)});
        const post=c.worker.postMessage.bind(c.worker);
        c.worker.postMessage=(data,transfer)=>{
            post(data,transfer);
            if(raced)return;
            const r=c.records.get(data.id),p=r.origin.map((x,i)=>x+r.size[i]*h.region.volume.voxelSize*.5);
            h.region.apply({mode:'fill',shape:{type:'sphere',center:p,radius:.8}});
            h.region.apply({shape:{type:'sphere',center:p,radius:1.1}});
            c.invalidate({min:r.c.map(x=>x*c.cells),max:r.c.map(x=>x*c.cells)});
            raced=true;
        };
        for(let i=0;i<400;i++){
            await frame();
            if(raced)break;
            await new Promise(r=>setTimeout(r,2));
        }
        for(let i=0;i<120&&c.stats.discarded===before;i++){await frame();await new Promise(r=>setTimeout(r,2));}
        c.worker.postMessage=post;
        return {raced,discarded:c.stats.discarded-before,error:c.stats.error,bytes:c.bytes,budget:c.maxBytes};
    });
    results.errors=errors;console.log('races',results.races);console.log('errors',errors);
    if(arg('out',null))await writeFile(arg('out'),JSON.stringify(results,null,2)+'\n');
    const transitions=[...results.transitions.reveal,...results.transitions.zoom];
    if(errors.length||results.cases.some(r=>r.stats.error||r.image.large>r.image.pixels*.0002)
        ||transitions.some(r=>r.large>r.pixels*.0002)||results.transitions.stable.different
        ||!results.editVisibility.passed
        ||!results.races.raced||!results.races.discarded)process.exitCode=1;
} finally {await browser.close();}
