/* global process */
import fs from 'node:fs';
import {createRequire} from 'node:module';
const req=createRequire(new URL('../../../terrain-lab/package.json',import.meta.url));
const {default:puppeteer}=await import(req.resolve('puppeteer-core'));
const output=process.env.RIVER_OUTPUT??'tools/perf/structured-terrain-results/coarse-river';fs.mkdirSync(output,{recursive:true});
const report={events:[],errors:[],views:[],notes:['Actual game screenshots, production materials/micro/water/LOD. Same poses and paused daylight rotation; driver caches are not frozen.']};
const browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:'new',
    defaultViewport:{width:1280,height:900},protocolTimeout:120000,args:['--enable-gpu','--no-first-run','--no-default-browser-check']});
const page=await browser.newPage();let mode='prototype';
const readbackComparison=process.argv.includes('--readback-comparison');
if(readbackComparison) {
    await page.setCacheEnabled(false);await page.setRequestInterception(true);
    page.on('request',request=>{
        if(mode==='reference'&&new URL(request.url()).pathname==='/core/world/terrain-generator/regionalBasins.js') {
            // Diagnostic-only full read, same planner/shaders/options/records.
            // Avoid adding a product option for a transfer implementation.
            const body=fs.readFileSync('core/world/terrain-generator/regionalBasins.js','utf8')
                .replace('search&&gen._regionalFullReadback!==true','search&&false');
            void request.respond({status:200,contentType:'text/javascript',body});
        } else void request.continue();
    });
}
page.on('pageerror',e=>report.errors.push({mode,message:String(e)}));
page.on('console',m=>{if(m.text().startsWith('[RiverProbe]')||m.type()==='error') report.events.push({mode,type:m.type(),message:m.text()});});
await page.evaluateOnNewDocument(()=>{
    const old=GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice=async function(...args){
        const device=await old.apply(this,args);
        device.lost.then(info=>console.log('[RiverProbe]',JSON.stringify({event:'lost',reason:info.reason,message:info.message,atMs:performance.now()})));
        device.addEventListener('uncapturederror',e=>console.log('[RiverProbe]',JSON.stringify({event:'validation',message:e.error.message,atMs:performance.now()})));
        return device;
    };
});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const poses=[];
const mountain=process.argv.includes('--mountain');
try {
    const surfaceComparison=process.argv.includes('--surface-comparison');
    const bodyFrameCost=process.argv.includes('--body-frame-cost');
    const frameCost=process.argv.includes('--frame-cost')||bodyFrameCost;
    const lodFrameCost=process.argv.includes('--lod-frame-cost');
    const distantDiagnostic=process.argv.includes('--distant-diagnostic');
    const bodyComparison=process.argv.includes('--body-comparison');
    const lodComparison=process.argv.includes('--lod-comparison')||lodFrameCost;
    const queries=frameCost||distantDiagnostic?['1']:surfaceComparison||lodComparison||bodyComparison?['1','0']:['1','reference'];
    for(const query of queries) {
        mode=query===queries[0]?'prototype':'reference';
        await page.goto(`http://localhost:8181/wizard_game/standalone.html?regionalTerrain=256&regionalBasins=1&regionalRivers=${surfaceComparison||readbackComparison||lodComparison||bodyComparison?'1':query}${surfaceComparison?'&regionalRiverSurface='+query:''}${mountain?'&regionalWhitewater=1':''}${lodComparison?'&shapeLod='+query:''}`,{waitUntil:'domcontentloaded',timeout:120000});
        await page.waitForFunction(()=>window.gameEngine?.waterService?.state==='ready',{timeout:120000});
        report[mode]=await page.evaluate(()=>{
            const g=window.gameEngine,t=g.renderer.quadtreeTileManager.tileStreamer.terrainGenerator;
            return {coarseWaterReadyAtMs:performance.now(),initialLoadComplete:g.isInitialLoadComplete(),
                regional:t.regionalTerrain.timings,basins:t.regionalTerrain.basins,water:g.waterService.timings,riverCount:g.waterService.rivers.length};
        });
        await page.waitForFunction(()=>window.gameEngine?.waterGpuData?._ready,{timeout:120000});
        if(bodyComparison)await page.evaluate(enabled=>{window.gameEngine.waterGpuData.look.structuredRiverBody=enabled;},query==='1');
        report[mode].gpuPublication=await page.evaluate(()=>({atMs:performance.now(),initialLoadComplete:window.gameEngine.isInitialLoadComplete()}));
        await page.waitForFunction(()=>window.gameEngine?.isInitialLoadComplete(),{timeout:120000});
        report[mode].initialLoadCompleteAtMs=await page.evaluate(()=>performance.now());
        if(mountain)await page.evaluate(()=>{document.getElementById('game-ui').style.visibility='hidden';});
        report[mode].lighting=await page.evaluate(()=>window.qtDiag.regional.daylight());
        if(mode==='prototype')await page.evaluate(readback=>window.qtDiag.regional.river(...(readback?[.5,1700,2200]:[.015,80,200])),readbackComparison);
        else await page.evaluate(p=>window.qtDiag.regional.useCamera(p),lodFrameCost?poses[1]:readbackComparison||bodyComparison?poses[3]:poses[0]);
        await sleep(18000);
        for(const i of (lodFrameCost?[1]:frameCost||distantDiagnostic||bodyComparison?[3]:readbackComparison?[1,3]:[0,1,2,3])) {
            if(mode==='prototype') {
                const views=mountain?[[.015,80,120],[.205,65,90],[.985,70,120],[.5,distantDiagnostic||bodyComparison||bodyFrameCost?2600:1700,400]]
                    :[[.015,80,200],[.5,90,260],[.985,80,200],[.5,1700,2200]];
                await page.evaluate(v=>window.qtDiag.regional.river(...v),views[i]);
                poses[i]=await page.evaluate(()=>window.qtDiag.regional.camera());
            } else await page.evaluate(p=>window.qtDiag.regional.useCamera(p),poses[i]);
            await sleep(9000);
            const label=['outlet','channel','inlet','network'][i];
            await page.screenshot({path:`${output}/${label}-${mode}.png`});
            report.views.push({mode,label,pose:poses[i],atMs:await page.evaluate(()=>performance.now()),
                lod:await page.evaluate(async()=>{
                    const g=window.gameEngine,tm=g.renderer.quadtreeTileManager,q=tm.quadtreeGPU;
                    // Own staging: automatic streamer diagnostics also read
                    // the visible list and cannot share an outstanding map.
                    const device=g.renderer.backend.device,buffer=device.createBuffer({size:4+q.maxVisibleTiles*16,
                        usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
                    try {
                        const enc=device.createCommandEncoder();enc.copyBufferToBuffer(q._counterBuffer,8,buffer,0,4);
                        enc.copyBufferToBuffer(q._visibleTileBuffer,0,buffer,4,q.maxVisibleTiles*16);
                        device.queue.submit([enc.finish()]);await buffer.mapAsync(GPUMapMode.READ);
                        const data=new Uint32Array(buffer.getMappedRange()),count=Math.min(data[0],q.maxVisibleTiles),depths={};
                        for(let k=0;k<count;k++){const d=data[1+k*4+1];depths[d]=(depths[d]??0)+1;}
                        return {visible:count,depths,shapeLod:q.regionalShapeLod,gpu:q.getStats()};
                    }finally{if(buffer.mapState==='mapped')buffer.unmap();buffer.destroy();}
                })});
        }
        if(distantDiagnostic) {
            report.distantState=await page.evaluate(()=>{
                const w=window.gameEngine.waterGpuData;
                return {near:w.near,look:w.look,carve:w.carve,flaggedSegments:Array.from({length:w.riverSegCount},(_,k)=>w._segs[k*32+23]).filter(x=>x>0).length,
                    segments:w.riverSegCount};
            });
            await page.evaluate(()=>{window.gameEngine.waterGpuData.debugMode=4;});await sleep(500);
            await page.screenshot({path:`${output}/network-owner.png`});
        }
        if(mountain&&!lodFrameCost&&!distantDiagnostic&&!bodyComparison&&!bodyFrameCost) {
            if(mode==='prototype') {
                await page.evaluate(()=>{
                    const g=window.gameEngine,rec=g.waterService.riverRecs.get(0),arc=g.waterGpuData._arcLengths(rec);
                    const fall=rec.profile.falls[0],k=Array.from(arc).reduce((best,s,i)=>Math.abs(s-fall.startM)<Math.abs(arc[best]-fall.startM)?i:best,0),st=rec.stride;
                    const a=Array.from(rec.points.slice(k*st,k*st+3)),b=Array.from(rec.points.slice((k+1)*st,(k+1)*st+3));
                    const norm=v=>{const l=Math.hypot(...v);return v.map(x=>x/l);},along=norm(b.map((v,i)=>v-a[i]));
                    const left=norm([b[1]*along[2]-b[2]*along[1],b[2]*along[0]-b[0]*along[2],b[0]*along[1]-b[1]*along[0]]);
                    const R=g.planetConfig.radius,origin=g.planetConfig.origin??{x:0,y:0,z:0},d=norm(b.map((v,i)=>v+(along[i]*30+left[i]*8)/R));
                    const target=norm(a.map((v,i)=>(v+b[i])*.5)),pose=window.qtDiag.regional.camera(),axes=['x','y','z'];
                    const bottom=rec.points[(k+1)*st+16],middle=(rec.points[k*st+16]+bottom)*.5;
                    axes.forEach((axis,i)=>{pose.position[axis]=origin[axis]+d[i]*(R+bottom+2);pose.target[axis]=origin[axis]+target[i]*(R+middle);pose.up[axis]=target[i];});
                    pose.fov=55;window.qtDiag.regional.useCamera(pose);
                });
                poses[4]=await page.evaluate(()=>window.qtDiag.regional.camera());
            } else await page.evaluate(p=>window.qtDiag.regional.useCamera(p),poses[4]);
            await sleep(9000);await page.screenshot({path:`${output}/fall-${mode}.png`});
            report.views.push({mode,label:'fall',pose:poses[4],atMs:await page.evaluate(()=>performance.now())});
        }
        if(frameCost||lodFrameCost) {
            await page.evaluate(()=>{
                const tm=window.gameEngine.renderer.quadtreeTileManager;
                tm.toggleManualDiagnosticSnapshot('river-surface-cost');
                tm._activateManualDiagnosticSnapshotFreeze();
                // This probe needs a frozen draw, not the unrelated manual
                // texture audit (which assumes a different texture format).
                tm._manualDiagRunPending=false;
            });
            const costs=await page.evaluate(async ({surfaceComparison,probeField})=>{
                const g=window.gameEngine,device=g.renderer.backend.device,render=g.render,update=g.update;
                const snapshot=g.renderer.getTerrainManualDiagnosticState();
                while(g._renderInFlight)await new Promise(requestAnimationFrame);
                // Hold automatic update/render while measuring full render submission
                // through its completion fence. This excludes streaming;
                // the frozen resident snapshot and zero delta are identical.
                g.render=()=>{};g.update=()=>{};
                const run=async()=>{const t=performance.now();await render.call(g,0);await device.queue.onSubmittedWorkDone();return performance.now()-t;};
                const rounds=[];
                try {
                    for(let j=0;j<60;j++)await run();
                    for(let round=0;round<(surfaceComparison?4:3);round++)for(const enabled of (surfaceComparison?(round%2?[true,false]:[false,true]):[true])) {
                        if(surfaceComparison){g.waterGpuData.look[probeField]=enabled;g.waterGpuData.update(g.waterService,g.camera.position,0);}
                        for(let j=0;j<10;j++)await run();
                        const samples=[];for(let j=0;j<120;j++)samples.push(await run());
                        rounds.push({round,enabled,completeRenderFenceMs:samples});
                    }
                    return {snapshot,rounds,notes:['Full production render with completion fence, same frozen resident terrain, camera, lighting and zero time delta; excludes automatic game update and streaming. No explicit RAF throttle, but browser presentation/queue scheduling may affect fence latency. Wall time is not a GPU timestamp or isolated shader cost.']};
                } finally {g.render=render;g.update=update;}
            },{surfaceComparison:frameCost,probeField:bodyFrameCost?'structuredRiverBody':'structuredRiverSurface'});
            report[mode].renderCosts=costs;if(frameCost)report.renderCosts=costs;
            if(frameCost)for(const enabled of [false,true]) {
                await page.evaluate(({enabled,probeField})=>{
                    const g=window.gameEngine,w=g.waterGpuData;w.look[probeField]=enabled;w.update(g.waterService,g.camera.position,0);
                },{enabled,probeField:bodyFrameCost?'structuredRiverBody':'structuredRiverSurface'});
                await sleep(500);
                await page.screenshot({path:`${output}/network-frozen-${enabled?'prototype':'reference'}.png`});
            }
            await page.evaluate(()=>window.gameEngine.renderer.toggleTerrainManualDiagnosticSnapshot('river-surface-cost'));
        }
    }
} finally {
    fs.writeFileSync(`${output}/browser.json`,JSON.stringify(report,null,2));await browser.close();
}
console.log(JSON.stringify({errors:report.errors,events:report.events,prototype:report.prototype,reference:report.reference},null,2));
process.exit(report.errors.length||report.events.some(e=>/"event":"(lost|validation)"/.test(e.message))?1:0);
