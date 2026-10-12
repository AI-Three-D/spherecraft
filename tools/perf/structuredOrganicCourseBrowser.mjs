/* global process */
import fs from 'node:fs';
import {createRequire} from 'node:module';
const req=createRequire(new URL('../../../terrain-lab/package.json',import.meta.url));
const {default:puppeteer}=await import(req.resolve('puppeteer-core'));
const output=process.env.RIVER_OUTPUT??'tools/perf/structured-terrain-results/organic-course/game';
fs.mkdirSync(output,{recursive:true});
const browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless:'new',defaultViewport:{width:1280,height:900},protocolTimeout:120000,
    args:['--enable-gpu','--no-first-run','--no-default-browser-check']});
const page=await browser.newPage(),report={browser:await browser.version(),runs:[],views:[],errors:[],events:[],consoleTail:[],notes:[
    'Actual production captures. Fixed world camera positions and sun across height-source variants.',
    'Feature data is ready before terrain tile generation. No dry-first tile reconstruction is introduced.',
    'Sequential startup/driver caches/residency uncontrolled; timings are observations, not causal startup speedups.',
]};
const coarseOnly=process.argv.includes('--coarse-only');
const naturalAndCoarse=process.argv.includes('--natural-and-coarse');
let mode,lighting,poses,phase;
if(coarseOnly||naturalAndCoarse){
    const previous=JSON.parse(fs.readFileSync('tools/perf/structured-terrain-results/organic-course/game/browser.json','utf8'));
    ({lighting,poses}=previous);
    report.notes.push('Legacy comparison reuses the saved world camera positions and daylight rotation. Residency is not identical.');
}
page.on('pageerror',e=>report.errors.push({mode,message:String(e)}));
page.on('console',m=>{
    report.consoleTail.push({mode,type:m.type(),message:m.text()});
    if(report.consoleTail.length>100)report.consoleTail.shift();
    if(m.type()==='error'||m.text().startsWith('[CourseProbe]'))report.events.push({mode,message:m.text()});
});
await page.evaluateOnNewDocument(()=>{
    const request=GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice=async function(...args){
        const device=await request.apply(this,args);
        device.lost.then(i=>console.log('[CourseProbe]',JSON.stringify({event:'lost',reason:i.reason,message:i.message})));
        device.addEventListener('uncapturederror',e=>console.log('[CourseProbe]',JSON.stringify({event:'validation',message:e.error.message})));
        return device;
    };
});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try{
    for(mode of (coarseOnly?['coarse']:naturalAndCoarse?['coarse','natural']:['foundation','natural','coarse'])){
        phase='navigation';
        await page.goto(`http://localhost:8181/wizard_game/standalone.html?regionalLargeLake=organic&regionalOrganicRiver=1&regionalRouteHeight=${mode==='coarse'?'natural':mode}&regionalRiverCourse=${mode==='coarse'?'coarse':'organic'}`,
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
            for(const [label,args] of [['outlet',[.08,55,150]],['channel',[.45,65,200]],['network',[.5,3200,2200]]]){
                const pose=await page.evaluate(a=>window.qtDiag.regional.river(...a),args);poses.push({label,...pose});
            }
        }else await page.evaluate(rotation=>{
            const s=window.gameEngine.starSystem;s.paused=true;s.useGameTimeRotation=false;s.currentBody.currentRotation=rotation;
        },lighting.rotation);
        phase='camera';
        await page.evaluate(()=>{document.getElementById('game-ui').style.visibility='hidden';});
        for(const pose of poses){
            phase=pose.label;
            await page.evaluate(p=>window.qtDiag.regional.useCamera(p),pose);await sleep(6000);
            await page.screenshot({path:`${output}/${pose.label}-${mode}.png`});
            const state=await page.evaluate(()=>({atMs:performance.now(),pose:window.qtDiag.regional.camera(),
                terrainReady:window.gameEngine.isInitialLoadComplete()}));
            report.views.push({mode,label:pose.label,...state});console.log(JSON.stringify({mode,label:pose.label}));
        }
    }
}catch(error){
    report.failure={mode,phase,message:String(error)};
    report.lastState=await page.evaluate(()=>({engine:!!window.gameEngine,
        loading:window.gameEngine?.getLoadingStatus?.(),waterReady:window.gameEngine?.waterGpuData?._ready,
        loadingText:document.getElementById('loading-screen')?.innerText})).catch(()=>null);
}finally{fs.writeFileSync(`${output}/browser.json`,JSON.stringify({...report,lighting,poses},null,2));await browser.close();}
process.exit(report.failure||report.errors.length||report.events.some(e=>/"event":"(lost|validation)"/.test(e.message))?1:0);
