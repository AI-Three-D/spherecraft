/* global process */
import fs from 'node:fs';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const req=createRequire(new URL('../../../terrain-lab/package.json',import.meta.url));
const {default:puppeteer}=await import(req.resolve('puppeteer-core'));
const output=process.env.RIVER_OUTPUT??'tools/perf/structured-terrain-results/organic-banks/game';
fs.mkdirSync(output,{recursive:true});
const browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless:'new',defaultViewport:{width:1280,height:900},protocolTimeout:120000,
    args:['--enable-gpu','--no-first-run','--no-default-browser-check']});
const page=await browser.newPage(),report={browser:await browser.version(),browserPid:browser.process().pid,runs:[],views:[],sources:[],errors:[],events:[],consoleTail:[],notes:[
    'Actual production captures. Fixed world camera positions and sun across height-source variants.',
    'Feature data is ready before terrain tile generation. No dry-first tile reconstruction is introduced.',
    'Sequential startup/driver caches/residency uncontrolled; timings are observations, not causal startup speedups.',
]};
const baselineOnly=process.argv.includes('--baseline-only');
const candidateOnly=process.argv.includes('--candidate-only');
const mountain=process.argv.includes('--mountain');
const channelOnly=process.argv.includes('--channel-only');
const frameCost=process.argv.includes('--frame-cost');
let mode,lighting,poses,phase;
const sourceReads=[];
page.on('response',response=>{
    const path=new URL(response.url()).pathname;
    if(!/\/(riverShapeNoise|riverCarve\.wgsl|waterWgsl|regionalTerrain\.wgsl|surfaceCommon\.wgsl|advancedTerrainCompute\.wgsl|webgpuTerrainGeneratorPipelines|WaterGpuData|regionalDrainage)\.js$/.test(path))return;
    const sourceMode=mode;
    sourceReads.push(response.text().then(source=>report.sources.push({mode:sourceMode,path,
        sha256:crypto.createHash('sha256').update(source).digest('hex')})).catch(error=>{
        (report.sourceReadErrors??=[]).push({mode:sourceMode,path,message:String(error)});
    }));
});
const cameraReference=process.env.RIVER_CAMERA_REFERENCE;
if(candidateOnly||cameraReference){
    ({lighting,poses}=JSON.parse(fs.readFileSync(cameraReference??`${output}/baseline/browser.json`,'utf8')));
}
page.on('pageerror',e=>report.errors.push({mode,message:String(e)}));
page.on('console',m=>{
    report.consoleTail.push({mode,type:m.type(),message:m.text()});
    if(report.consoleTail.length>100)report.consoleTail.shift();
    if(m.type()==='error'||m.text().startsWith('[CourseProbe]'))report.events.push({mode,message:m.text()});
});
await page.evaluateOnNewDocument(()=>{
    window.__bankSampling=false;window.__bankFences=[];
    const request=GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice=async function(...args){
        const device=await request.apply(this,args);
        const submit=device.queue.submit.bind(device.queue);
        device.queue.submit=(...args)=>{
            const start=performance.now(),result=submit(...args);
            if(window.__bankSampling)device.queue.onSubmittedWorkDone().then(()=>window.__bankFences.push(performance.now()-start));
            return result;
        };
        device.lost.then(i=>console.log('[CourseProbe]',JSON.stringify({event:'lost',reason:i.reason,message:i.message})));
        device.addEventListener('uncapturederror',e=>console.log('[CourseProbe]',JSON.stringify({event:'validation',message:e.error.message})));
        return device;
    };
});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try{
    for(mode of (baselineOnly?['baseline']:candidateOnly?['banks']:['baseline','banks'])){
        phase='navigation';
        const prefix=mountain?'regionalWhitewater=1&regionalRiverCourse=organic':'regionalLargeLake=organic&regionalOrganicRiver=1';
        await page.goto(`http://localhost:8181/wizard_game/standalone.html?${prefix}&regionalBanks=${mode==='banks'?'organic':'legacy'}`,
            {waitUntil:'domcontentloaded',timeout:120000});
        phase='water-publication';
        await page.waitForFunction(()=>window.gameEngine?.waterGpuData?._ready,{timeout:120000});
        const run=await page.evaluate(()=>{
            const g=window.gameEngine,r=g.terrainGenerator.regionalTerrain;
            return {waterReadyAtMs:performance.now(),root:r.timings,river:r.drainagePlan.rivers[0],basins:r.basins};
        });
        run.mode=mode;report.runs.push(run);
        phase='initial-terrain';
        await page.waitForFunction(()=>window.gameEngine?.getLoadingStatus?.()?.complete===true,{timeout:120000});
        run.initialLoadAtMs=await page.evaluate(()=>performance.now());
        if(!lighting){
            lighting=await page.evaluate(()=>window.qtDiag.regional.daylight());
            poses=[];
            for(const [label,args] of (mountain
                ?[['outlet',[.15,130,110]],['channel',[.45,180,170]],['close',[.45,60,65]],['mouth',[.1,100,70]]]
                :[['outlet',[.08,55,150]],['channel',[.45,65,200]],['close',[.45,12,65]],['mouth',[.055,40,100]]])){
                const pose=await page.evaluate(a=>window.qtDiag.regional.river(...a),args);poses.push({label,...pose});
            }
        }else await page.evaluate(rotation=>{
            const s=window.gameEngine.starSystem;s.paused=true;s.useGameTimeRotation=false;s.currentBody.currentRotation=rotation;
        },lighting.rotation);
        phase='camera';
        await page.evaluate(()=>{document.getElementById('game-ui').style.visibility='hidden';});
        for(const pose of poses){
            if(channelOnly&&!['channel','close'].includes(pose.label))continue;
            phase=pose.label;
            await page.evaluate(p=>window.qtDiag.regional.useCamera(p),pose);await sleep(6000);
            await page.waitForFunction(()=>{
                const s=window.gameEngine.renderer.quadtreeTileManager.getInitialLoadStatus();
                return s.pendingGenerations===0&&s.activeGenerations===0&&s.pendingCopies===0&&s.exactVisibleRatio===1;
            },{timeout:90000});
            fs.mkdirSync(`${output}/${mode}`,{recursive:true});
            await page.screenshot({path:`${output}/${mode}/${pose.label}${frameCost?'-live':''}.png`});
            const state=await page.evaluate(()=>({atMs:performance.now(),pose:window.qtDiag.regional.camera(),
                terrainReady:window.gameEngine.isInitialLoadComplete(),
                coverage:window.gameEngine.renderer.quadtreeTileManager.getInitialLoadStatus()}));
            state.steadyFrameObservation=await page.evaluate(async()=>{
                window.__bankFences=[];window.__bankSampling=true;
                const frames=[];let previous;
                await new Promise(resolve=>{
                    const tick=t=>{if(previous!==undefined)frames.push(t-previous);previous=t;
                        if(frames.length===120)resolve();else requestAnimationFrame(tick);};requestAnimationFrame(tick);
                });
                window.__bankSampling=false;await new Promise(resolve=>setTimeout(resolve,100));
                return {frameIntervalsMs:frames,submitToFenceMs:window.__bankFences};
            });
            if(frameCost)state.renderCost=await page.evaluate(async()=>{
                const g=window.gameEngine,device=g.renderer.backend.device,render=g.render,update=g.update;
                while(g._renderInFlight)await new Promise(requestAnimationFrame);
                g.render=()=>{};g.update=()=>{};
                let completed=false;
                try{
                    await device.queue.onSubmittedWorkDone();
                    const manager=g.renderer.quadtreeTileManager;
                    const residency=()=>({coverage:manager.getInitialLoadStatus(),
                        visibleAddresses:manager._lastVisibleTiles.map(t=>`f${t.face}:d${t.depth}:${t.x},${t.y}`).sort(),
                        loadedAddresses:[...manager.tileStreamer._tileInfo.keys()].sort(),
                        simulationState:g.waterRiverSim?.state??null});
                    const before=residency(),rounds=[];
                    const draw=async()=>{const start=performance.now();await render.call(g,0);
                        await device.queue.onSubmittedWorkDone();return performance.now()-start;};
                    for(let i=0;i<30;i++)await draw();
                    for(let round=0;round<3;round++){
                        const samples=[];for(let i=0;i<60;i++)samples.push(await draw());
                        rounds.push({round,completeRenderFenceMs:samples});
                    }
                    const result={before,after:residency(),rounds,notes:[
                        'Full production render through queue completion, fixed camera/daylight and paused game update; excludes streaming catch-up and fast movement.',
                        'Wall time includes CPU submission and GPU queue, not isolated GPU timestamps. Check actual address inventories before interpreting mode differences.',
                        'RAF/submit observations above include additional diagnostic fences and are distinct from these serialized render measurements.',
                    ]};
                    completed=true;return result;
                }finally{
                    if(completed)window.__bankResumeView=()=>{g.render=render;g.update=update;delete window.__bankResumeView;};
                    else {g.render=render;g.update=update;}
                }
            });
            if(frameCost){
                state.captureState=await page.evaluate(()=>window.gameEngine.renderer.quadtreeTileManager.getInitialLoadStatus());
                state.captureFrozen=true;
                await page.screenshot({path:`${output}/${mode}/${pose.label}.png`});
                await page.evaluate(()=>window.__bankResumeView());
            }
            report.views.push({mode,label:pose.label,...state});console.log(JSON.stringify({mode,label:pose.label}));
        }
    }
}catch(error){
    report.failure={mode,phase,message:String(error)};
    report.lastState=await page.evaluate(()=>({engine:!!window.gameEngine,
        loading:window.gameEngine?.getLoadingStatus?.(),waterReady:window.gameEngine?.waterGpuData?._ready,
        loadingText:document.getElementById('loading-screen')?.innerText})).catch(()=>null);
}finally{await Promise.all(sourceReads);fs.mkdirSync(`${output}/${mode}`,{recursive:true});fs.writeFileSync(`${output}/${mode}/browser.json`,JSON.stringify({...report,lighting,poses},null,2));await browser.close();}
process.exit(report.failure||report.errors.length||report.events.some(e=>/"event":"(lost|validation)"/.test(e.message))?1:0);
