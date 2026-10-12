/* global process */
import fs from 'node:fs';
import {Buffer} from 'node:buffer';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const req=createRequire(new URL('../../../terrain-lab/package.json',import.meta.url));
const {default:puppeteer}=await import(req.resolve('puppeteer-core'));
const mountain=process.argv.includes('--mountain');
const videoOnly=process.argv.includes('--video-only');
const recordVideo=videoOnly||process.argv.includes('--record');
const flowPreview=process.argv.includes('--flow-preview');
const defaultOn=process.argv.includes('--default-on');
const output=process.env.WATER_OUTPUT??'tools/perf/structured-terrain-results/whitewater-near/game';
fs.mkdirSync(output,{recursive:true});
const reference=JSON.parse(fs.readFileSync(`tools/perf/structured-terrain-results/organic-banks/${mountain?'mountain-polish-game':'gentle-polish-game'}/banks/browser.json`,'utf8'));
const browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:'new',
    defaultViewport:{width:1280,height:900},protocolTimeout:120000,args:['--enable-gpu','--no-first-run','--no-default-browser-check']});
const page=await browser.newPage(),report={mountain,browser:await browser.version(),browserPid:browser.process().pid,
    errors:[],events:[],sources:[],views:[],notes:[
        'Same-page baseline / frozen simulated mesh / advancing simulation, fixed camera and daylight.',
        'Full render and queue fence wall cost includes CPU, GPU and submission; not an isolated GPU timestamp.',
        'Advancing mode uses four fixed substeps per measured frame (30 fps budget), not queue catch-up.',
        'Startup is observed with uncontrolled driver caches; no fast-moving-view claim.',
    ]};
const reads=[];
page.on('response',res=>{
    const pathname=new URL(res.url()).pathname;
    if(pathname!=='/wizard_game/standalone.html'&&!/\/(runtimeConfigs|WaterRiverSim|ShallowWaterSim|shallowWaterSim\.wgsl|waterSimClock|WaterSimRenderer|waterSimSurface\.wgsl|NearWaterRenderer|nearWaterSurface\.wgsl|nearWaterUniforms|waterGrid|WaterService|HydrologyGrid|waterWgsl|webgpuBackend|frontend|gameEngine|WaterGpuData|riverStrip|riverShapeNoise|riverCarve\.wgsl)\.js$/.test(pathname))return;
    reads.push(res.text().then(source=>report.sources.push({pathname,sha256:crypto.createHash('sha256').update(source).digest('hex')})));
});
page.on('pageerror',error=>report.errors.push(String(error)));
page.on('console',m=>{if(m.type()==='error'||m.text().startsWith('[WaterProbe]'))report.events.push(m.text());});
await page.evaluateOnNewDocument(()=>{
    const request=GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice=async function(...args){
        const device=await request.apply(this,args);
        device.addEventListener('uncapturederror',e=>console.log('[WaterProbe]',JSON.stringify({event:'validation',message:e.error.message})));
        device.lost.then(e=>console.log('[WaterProbe]',JSON.stringify({event:'lost',reason:e.reason,message:e.message})));
        return device;
    };
});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try{
    const prefix=mountain?'regionalWhitewater=1&regionalRiverCourse=organic':'regionalLargeLake=organic&regionalOrganicRiver=1';
    report.url=`http://localhost:8181/wizard_game/standalone.html?${prefix}&regionalBanks=organic${defaultOn?'':'&riverSim=whitewater'}${flowPreview?'&regionalView=flow':''}`;
    await page.goto(report.url,{waitUntil:'domcontentloaded',timeout:120000});
    await page.waitForFunction(()=>window.gameEngine?.waterGpuData?._ready,{timeout:120000});
    report.effectiveSimConfig=await page.evaluate(()=>window.gameEngine.planetConfig.terrainGeneration.waterGraph.sim);
    if(defaultOn&&report.effectiveSimConfig.enabled!==true)throw new Error('Default river simulation is disabled');
    report.waterReadyAtMs=await page.evaluate(()=>performance.now());
    await page.waitForFunction(()=>window.gameEngine?.getLoadingStatus?.()?.complete,{timeout:120000});
    report.initialTerrainAtMs=await page.evaluate(()=>performance.now());
    await page.evaluate(({rotation,widen})=>{
        const g=window.gameEngine,s=g.starSystem;s.paused=true;s.useGameTimeRotation=false;s.currentBody.currentRotation=rotation;
        // Higher channel view is an ownership audit; widen activation only
        // in this diagnostic page so it cannot deactivate during residency.
        if(widen)Object.assign(g.planetConfig.terrainGeneration.waterGraph.sim,{activateAltitudeM:500,activateDistanceM:500});
        document.getElementById('game-ui').style.visibility='hidden';
    },{rotation:reference.lighting.rotation,widen:!flowPreview});
    const waterPose=await page.evaluate(isMountain=>window.qtDiag.regional.river(.45,isMountain?40:5,isMountain?25:35),mountain);
    for(const pose of [...(videoOnly?[]:reference.poses.filter(p=>['channel','close'].includes(p.label))),{label:'water',...waterPose}]){
        await page.evaluate(p=>window.qtDiag.regional.useCamera(p),pose);await sleep(3000);
        // Aerial channel views need not activate; force a placement for an
        // ownership audit there, then retain the same low-range solver.
        await page.evaluate(async autoOnly=>{
            const g=window.gameEngine,water=g.waterGpuData,o=g.planetConfig.origin??{x:0,y:0,z:0},cam=g.camera.position;
            const rel={x:cam.x-o.x,y:cam.y-o.y,z:cam.z-o.z};g._tickWaterSim(rel);
            const sim=g.waterRiverSim;
            if(sim.state==='idle'&&!autoOnly){
                const rid=[...g.waterService.riverRecs.keys()][0],rec=g.waterService.riverRecs.get(rid);
                await sim.place(rid,rec,rec.lengthM*.45);
            }
            water.update(g.waterService,rel,performance.now()/1000);
        },defaultOn);
        await page.waitForFunction(()=>window.gameEngine.waterRiverSim?.state==='running'&&window.gameEngine.waterRiverSim?.fade>=.999&&window.gameEngine.waterRiverSim?.surfaceReady,{timeout:60000});
        await page.waitForFunction(()=>{
            const s=window.gameEngine.renderer.quadtreeTileManager.getInitialLoadStatus();
            return s.pendingGenerations===0&&s.activeGenerations===0&&s.pendingCopies===0&&s.exactVisibleRatio===1;
        },{timeout:90000});
        const view={label:pose.label,pose,sim:await page.evaluate(()=>window.qtDiag.water.sim()),captures:[]};
        if(view.sim.state!=='running'||view.sim.fade<.999)throw new Error('Simulation deactivated before capture; reject this view');
        await page.evaluate(async()=>{
            const g=window.gameEngine;while(g._renderInFlight)await new Promise(requestAnimationFrame);
            window.__waterRestore={update:g.update,render:g.render};g.update=()=>{};g.render=()=>{};
            await g.renderer.backend.device.queue.onSubmittedWorkDone();
        });
        for(const mode of (videoOnly?[]:['baseline','mesh','advancing'])){
            const measurement=await page.evaluate(async mode=>{
                const g=window.gameEngine,device=g.renderer.backend.device,sim=g.waterRiverSim,water=g.waterGpuData;
                const o=g.planetConfig.origin??{x:0,y:0,z:0},cam=g.camera.position,rel={x:cam.x-o.x,y:cam.y-o.y,z:cam.z-o.z};
                sim.fade=mode==='baseline'?0:1;water.site=sim.coverage;water.update(g.waterService,rel,performance.now()/1000);
                const manager=g.renderer.quadtreeTileManager;
                const state=()=>({coverage:manager.getInitialLoadStatus(),
                    visible:manager._lastVisibleTiles.map(t=>`f${t.face}:d${t.depth}:${t.x},${t.y}`).sort(),
                    loaded:[...manager.tileStreamer._tileInfo.keys()].sort(),simTime:sim.sim.time,
                    carveVersion:g.terrainGenerator.waterCarveVersion,waterVersion:water._appliedVersion,
                    regeneration:manager.tileStreamer.getRegenerationStats?.()});
                const before=state(),rounds=[];
                const draw=async()=>{
                    const started=performance.now();
                    if(mode==='advancing'){
                        const enc=device.createCommandEncoder();sim.sim.encode(enc,4);device.queue.submit([enc.finish()]);
                    }
                    await window.__waterRestore.render.call(g,0);await device.queue.onSubmittedWorkDone();return performance.now()-started;
                };
                for(let i=0;i<20;i++)await draw();
                for(let r=0;r<3;r++){
                    const samples=[];for(let i=0;i<40;i++)samples.push(await draw());rounds.push(samples);
                }
                return {mode,before,after:state(),rounds};
            },mode);
            await page.screenshot({path:`${output}/${pose.label}-${mode}.png`});view.captures.push(measurement);
            console.log(JSON.stringify({label:pose.label,mode}));
        }
        const state=await page.evaluate(async()=>{
            const sim=window.gameEngine.waterRiverSim,st=await sim.sim.readState();
            let wet=0,maxH=0,maxV=0,foam=0,nonfinite=0;
            for(let k=0;k<st.length;k+=4){
                if(![st[k],st[k+1],st[k+2],st[k+3]].every(Number.isFinite))nonfinite++;
                if(st[k]>.02){wet++;maxH=Math.max(maxH,st[k]);maxV=Math.max(maxV,Math.hypot(st[k+1],st[k+2]));foam+=st[k+3];}
            }
            return {wet,maxH,maxV,meanFoam:foam/Math.max(wet,1),nonfinite,timeS:sim.sim.time};
        });
        view.state=state;report.views.push(view);
        await page.evaluate(()=>{
            const g=window.gameEngine;g.waterRiverSim._lastNow=performance.now()/1000;
            g.update=window.__waterRestore.update;g.render=window.__waterRestore.render;delete window.__waterRestore;
        });
        if(recordVideo&&pose.label==='water'){
            const video=await page.evaluate(async()=>{
                const stream=window.gameEngine.canvas.captureStream(20),chunks=[];
                const mimeType=MediaRecorder.isTypeSupported('video/webm;codecs=vp9')?'video/webm;codecs=vp9':'video/webm';
                const recorder=new MediaRecorder(stream,{mimeType,videoBitsPerSecond:4000000});
                recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
                const stopped=new Promise(resolve=>recorder.onstop=resolve);
                recorder.start();await new Promise(resolve=>setTimeout(resolve,4000));recorder.stop();await stopped;
                stream.getTracks().forEach(t=>t.stop());
                const blob=new Blob(chunks,{type:mimeType});
                const data=await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.readAsDataURL(blob);});
                return {mimeType,bytes:blob.size,data};
            });
            fs.writeFileSync(`${output}/flow.webm`,Buffer.from(video.data.split(',')[1],'base64'));
            report.video={mimeType:video.mimeType,bytes:video.bytes,durationS:4};
            await page.screenshot({path:`${output}/flow.png`});
        }
    }
    await page.evaluate(p=>window.qtDiag.regional.useCamera(p),waterPose);
    await page.evaluate(()=>{
        const g=window.gameEngine;Object.assign(g.planetConfig.terrainGeneration.waterGraph.sim,{activateAltitudeM:150,activateDistanceM:120});
        g.waterRiverSim.stop();window.__waterActivationStart=performance.now();
    });
    await page.waitForFunction(()=>window.gameEngine.waterRiverSim?.state==='running'&&window.gameEngine.waterRiverSim.fade>=.999&&window.gameEngine.waterRiverSim.surfaceReady,{timeout:30000});
    report.normalActivation=await page.evaluate(()=>({wallMs:performance.now()-window.__waterActivationStart,status:window.qtDiag.water.sim()}));
}catch(error){report.failure=String(error);report.lastState=await page.evaluate(()=>({water:window.qtDiag?.water?.sim?.(),loading:window.gameEngine?.getLoadingStatus?.()})).catch(()=>null);}
finally{await Promise.all(reads);fs.writeFileSync(`${output}/browser.json`,JSON.stringify(report,null,2));await browser.close();}
process.exit(report.failure||report.errors.length||report.events.some(e=>/"event":"(lost|validation)"/.test(e))?1:0);
