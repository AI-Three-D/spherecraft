/* global process */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
const req=createRequire(new URL('../../../terrain-lab/package.json',import.meta.url));
const {default:puppeteer}=await import(req.resolve('puppeteer-core'));
const output=process.env.WATER_OUTPUT??'tools/perf/structured-terrain-results/planet-water-device-loss/game';
fs.mkdirSync(output,{recursive:true});
const baseline=process.argv.includes('--before'),crash=process.argv.includes('--crash-gpu'),cold=process.argv.includes('--cold-shaders');
const early=process.argv.includes('--early-crash');
const browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless:'new',defaultViewport:{width:1280,height:900},protocolTimeout:180000,
    args:['--enable-gpu','--no-first-run','--no-default-browser-check',...(cold?['--disable-gpu-shader-disk-cache']:[])]});
const page=await browser.newPage(),report={baseline,crash,cold,early,browser:await browser.version(),errors:[],messages:[],sources:[]},reads=[];
page.on('pageerror',e=>report.errors.push(String(e)));
page.on('console',m=>{if(['error','warn'].includes(m.type()))report.messages.push({type:m.type(),text:m.text()});});
page.on('response',r=>{const pathname=new URL(r.url()).pathname;if(/\.(js|html)$/.test(pathname))reads.push(r.text().then(v=>{
    report.sources.push({pathname,sha256:crypto.createHash('sha256').update(v).digest('hex')});
    const p=`${output}/served${pathname}`;fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,v);
}).catch(()=>{}));});
if(baseline){
    await page.setRequestInterception(true);
    page.on('request',r=>{const p='tools/perf/structured-terrain-results/planet-water-device-loss/sources/before'+new URL(r.url()).pathname;
        if(fs.existsSync(p)&&fs.statSync(p).isFile())r.respond({status:200,contentType:p.endsWith('.html')?'text/html':'text/javascript',body:fs.readFileSync(p)});
        else r.continue();});
}
await page.evaluateOnNewDocument(()=>{
    window.gpuAudit={live:0,peak:0,allocations:0,losses:[],uncaptured:[],rejections:[],textureBytesByLabel:{},milestones:{}};
    addEventListener('unhandledrejection',e=>window.gpuAudit.rejections.push(String(e.reason)));
    const request=GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice=async function(...args){
        const d=await request.apply(this,args),a=window.gpuAudit;
        d.lost.then(info=>a.losses.push({reason:info.reason,message:info.message,timeMs:performance.now()}));
        d.addEventListener('uncapturederror',e=>a.uncaptured.push(e.error.message));
        const sizes={r8unorm:1,rg8unorm:2,r16float:2,rgba8unorm:4,bgra8unorm:4,r32float:4,rg16float:4,
            depth24plus:4,depth32float:4,rgba16float:8,rg32float:8,rgba32float:16,rgba32uint:16};
        function allocated(resource,bytes){
            a.live+=bytes;a.peak=Math.max(a.peak,a.live);a.allocations++;
            const destroy=resource.destroy.bind(resource);let released=false;
            resource.destroy=()=>{if(!released){a.live-=bytes;released=true;}return destroy();};
            return resource;
        }
        const texture=d.createTexture.bind(d),buffer=d.createBuffer.bind(d);
        d.createTexture=desc=>{
            const s=desc.size,w=s.width??s[0],h=s.height??s[1]??1,z=s.depthOrArrayLayers??s[2]??1;
            let texels=0;for(let i=0;i<(desc.mipLevelCount??1);i++)texels+=Math.max(1,w>>i)*Math.max(1,h>>i)*z;
            const bytes=texels*(sizes[desc.format]??4)*(desc.sampleCount??1);
            const label=desc.label??'(unlabelled)';a.textureBytesByLabel[label]=(a.textureBytesByLabel[label]??0)+bytes;
            if(label==='Planet water generation atlas')a.milestones.beforeAtlasBytes=a.live;
            return allocated(texture(desc),bytes);
        };
        d.createBuffer=desc=>allocated(buffer(desc),desc.size);
        return d;
    };
});
try {
    await page.goto('http://localhost:8181/wizard_game/standalone.html',{waitUntil:'domcontentloaded',timeout:180000});
    await page.waitForFunction(()=>window.gameEngine?.waterGpuData?._ready,{timeout:180000});
    report.waterReadyMs=await page.evaluate(()=>performance.now());
    if(early) {
        await page.waitForFunction(()=>window.gameEngine?.isGameActive&&window.gameEngine.renderer.quadtreeTileManager.quadtreeGPU._frameCount>=1,{timeout:180000});
    } else {
        await page.waitForFunction(()=>window.gameEngine?.getLoadingStatus?.()?.complete,{timeout:180000});
        report.terrainReadyMs=await page.evaluate(()=>performance.now());
        await page.waitForFunction(()=>getComputedStyle(document.getElementById('loading-screen')).display==='none',{timeout:30000});
        await page.waitForFunction(()=>!window.gameEngine._renderInFlight,{timeout:30000});
    }
    report.initial=await page.evaluate(()=>{
        const g=window.gameEngine,r=g.terrainGenerator.regionalTerrain;
        return{lakes:r.basins.length,rivers:r.drainagePlan.rivers.length,regions:r.shapeData.patches.length,
            masks:g.waterGpuData._layerOf.size,residentRivers:g.waterGpuData._inGpu.size,
            timings:r.timings,atlasBytes:r.shapeData.byteLength,atlasTimings:r.shapeData.timings,
            coverage:g.renderer.quadtreeTileManager.getInitialLoadStatus(),gpu:window.gpuAudit};
    });
    await page.screenshot({path:`${output}/terrain.png`});
    if(report.initial.lakes!==1200||report.initial.rivers!==320)throw new Error('Placement changed');
    if(early&&report.initial.coverage.exactVisibleRatio===1)throw new Error('Early loss injection arrived after terrain was ready');
    if(crash){
        // Kill only this owned browser's GPU process to exercise a real browser
        // instance disconnect. Never touch the user's browser or GPU processes.
        const cdp=await browser.target().createCDPSession(),{processInfo}=await cdp.send('SystemInfo.getProcessInfo');
        const gpu=processInfo.find(p=>p.type==='GPU');if(!gpu)throw new Error('Owned GPU process not found');
        const ppid=Number(execFileSync('ps',['-o','ppid=','-p',String(gpu.id)],{encoding:'utf8'}).trim());
        if(ppid!==browser.process().pid)throw new Error('Refuse to kill GPU process belonging to another browser');
        report.injected={gpuPid:gpu.id,browserPid:ppid};process.kill(gpu.id,'SIGKILL');
        await page.waitForFunction(()=>window.gpuAudit.losses.length,{timeout:15000});
        await new Promise(r=>setTimeout(r,1500));
        report.afterLoss=await page.evaluate(()=>({gpu:window.gpuAudit,
            frame:window.gameEngine.renderer.quadtreeTileManager.quadtreeGPU._frameCount,
            loadingText:document.getElementById('loading-screen').innerText,
            reloadButton:[...document.querySelectorAll('button')].find(b=>b.textContent==='Reload game')?.textContent}));
        await new Promise(r=>setTimeout(r,750));
        report.finalFrame=await page.evaluate(()=>window.gameEngine.renderer.quadtreeTileManager.quadtreeGPU._frameCount);
        await page.screenshot({path:`${output}/device-loss.png`});
        if(!baseline&&(report.errors.length||report.afterLoss.gpu.rejections.length||report.afterLoss.reloadButton!=='Reload game'
            ||report.afterLoss.frame!==report.finalFrame))throw new Error('Device loss did not stop cleanly');
        if(!baseline&&process.argv.includes('--reload')) {
            await Promise.all([page.waitForNavigation({waitUntil:'domcontentloaded',timeout:180000}),page.evaluate(()=>
                [...document.querySelectorAll('button')].find(b=>b.textContent==='Reload game').click())]);
            await page.waitForFunction(()=>window.gameEngine?.getLoadingStatus?.()?.complete,{timeout:180000});
            await page.waitForFunction(()=>getComputedStyle(document.getElementById('loading-screen')).display==='none',{timeout:30000});
            report.recovered=await page.evaluate(()=>({lakes:window.gameEngine.waterService.lakes.length,
                rivers:window.gameEngine.terrainGenerator.regionalTerrain.drainagePlan.rivers.length,
                gpu:window.gpuAudit,coverage:window.gameEngine.renderer.quadtreeTileManager.getInitialLoadStatus(),timeMs:performance.now()}));
            await page.screenshot({path:`${output}/recovered.png`});
            if(report.errors.length||report.recovered.gpu.losses.length||report.recovered.gpu.uncaptured.length
                ||report.recovered.lakes!==1200||report.recovered.rivers!==320)throw new Error('Reload recovery failed');
        }
    } else if(report.errors.length||report.initial.gpu.uncaptured.length)throw new Error('Normal startup had errors');
} catch(error){report.failure=String(error);}
finally {
    await Promise.all(reads);fs.writeFileSync(`${output}/browser.json`,JSON.stringify(report,null,2));
    await browser.close();
}
console.log(JSON.stringify({output,failure:report.failure,waterReadyMs:report.waterReadyMs,terrainReadyMs:report.terrainReadyMs,
    initialGpu:report.initial?.gpu,loss:report.afterLoss?.gpu.losses,errors:report.errors,reloadButton:report.afterLoss?.reloadButton}));
process.exit(report.failure?1:0);
