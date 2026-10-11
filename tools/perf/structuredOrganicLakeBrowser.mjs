/* global process */
import fs from 'node:fs';
import {createRequire} from 'node:module';
const req=createRequire(new URL('../../../terrain-lab/package.json',import.meta.url));
const {default:puppeteer}=await import(req.resolve('puppeteer-core'));
const output=process.env.SHAPE_OUTPUT??'tools/perf/structured-terrain-results/organic-lake/game';
fs.mkdirSync(output,{recursive:true});
const browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless:'new',defaultViewport:{width:1280,height:900},protocolTimeout:120000,
    args:['--enable-gpu','--no-first-run','--no-default-browser-check']});
const page=await browser.newPage(),report={runs:[],views:[],errors:[],events:[],notes:[
    'Production game captures. Fixed world camera positions, targets and sun rotation across baseline/candidate.',
    'Sequential startup with uncontrolled driver caches; readiness times do not establish cold performance.',
    'Rendering, queue tuning and shallow water simulation are unchanged.',
]};
let mode,lighting,poses;
page.on('pageerror',e=>report.errors.push({mode,message:String(e)}));
page.on('console',m=>{if(m.type()==='error'||m.text().startsWith('[OrganicProbe]'))report.events.push({mode,message:m.text()});});
await page.evaluateOnNewDocument(()=>{
    const request=GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice=async function(...args){
        const device=await request.apply(this,args);
        device.lost.then(info=>console.log('[OrganicProbe]',JSON.stringify({event:'lost',reason:info.reason,message:info.message})));
        device.addEventListener('uncapturederror',e=>console.log('[OrganicProbe]',JSON.stringify({event:'validation',message:e.error.message})));
        return device;
    };
});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try{
    for(mode of ['baseline','organic']){
        await page.goto(`http://localhost:8181/wizard_game/standalone.html?regionalLargeLake=${mode==='organic'?'organic':'1'}`,
            {waitUntil:'domcontentloaded',timeout:120000});
        await page.waitForFunction(()=>window.gameEngine?.waterGpuData?._ready,{timeout:120000});
        const run=await page.evaluate(()=>({waterReadyAtMs:performance.now(),root:window.gameEngine.terrainGenerator.regionalTerrain.timings}));
        run.mode=mode;report.runs.push(run);
        await page.waitForFunction(()=>window.gameEngine?.isInitialLoadComplete(),{timeout:120000});
        run.initialLoadAtMs=await page.evaluate(()=>performance.now());
        if(!lighting){
            lighting=await page.evaluate(()=>window.qtDiag.regional.daylight());
            poses=await page.evaluate(async()=>{
                const g=window.gameEngine,s=g.terrainGenerator.regionalTerrain.shapeData,c=s.depression.centre;
                const {tangentBasis}=await import('/core/world/hydrology/lakeRefine.js');
                const b=tangentBasis(c),R=g.planetConfig.radius,o=g.planetConfig.origin??{x:0,y:0,z:0};
                const position=(x,y,z)=>Object.fromEntries(['x','y','z'].map((a,k)=>[a,o[a]+c[k]*(R+580.2+z)+b.e1[k]*x+b.e2[k]*y]));
                return [
                    {label:'overview',position:position(0,-700,1000),target:position(0,0,0)},
                    {label:'oblique',position:position(0,-850,170),target:position(0,0,0)},
                    {label:'bank',position:position(-625,180,35),target:position(-300,100,0)},
                    {label:'distant',position:position(0,-100,2100),target:position(0,0,0)},
                ].map(p=>({...p,up:{x:c[0],y:c[1],z:c[2]},fov:75}));
            });
        }else await page.evaluate(rotation=>{
            const s=window.gameEngine.starSystem;s.paused=true;s.useGameTimeRotation=false;s.currentBody.currentRotation=rotation;
        },lighting.rotation);
        await page.evaluate(()=>{document.getElementById('game-ui').style.visibility='hidden';});
        for(const pose of (process.argv.includes('--frame-cost')?[poses[0]]:poses)){
            await page.evaluate(p=>window.qtDiag.regional.useCamera(p),pose);await sleep(5000);
            await page.screenshot({path:`${output}/${pose.label}-${mode}.png`});
            const state=await page.evaluate(()=>{
                const g=window.gameEngine,s=g.terrainGenerator.regionalTerrain.shapeData;
                return {atMs:performance.now(),levelM:s.lakePlan.levelM,proof:s.lakePlan.proof,
                    depression:s.depression,regionalBytes:g.terrainGenerator.regionalTerrain.byteLength,
                    pose:window.qtDiag.regional.camera()};
            });
            report.views.push({mode,label:pose.label,...state});
            console.log(JSON.stringify({mode,label:pose.label,atMs:state.atMs}));
        }
        if(process.argv.includes('--frame-cost')) {
            run.renderCost=await page.evaluate(async()=>{
                const g=window.gameEngine,device=g.renderer.backend.device,render=g.render,update=g.update;
                while(g._renderInFlight)await new Promise(requestAnimationFrame);
                g.render=()=>{};g.update=()=>{};
                try{
                    await device.queue.onSubmittedWorkDone();
                    const snapshot=g.renderer.getTerrainManualDiagnosticState(),rounds=[];
                    const draw=async()=>{const start=performance.now();await render.call(g,0);
                        await device.queue.onSubmittedWorkDone();return performance.now()-start;};
                    for(let j=0;j<30;j++)await draw();
                    for(let round=0;round<3;round++){
                        const samples=[];for(let j=0;j<60;j++)samples.push(await draw());
                        rounds.push({round,completeRenderFenceMs:samples});
                    }
                    return {snapshot,rounds,notes:[
                        'Full render through completion fence, fixed camera/lighting and resident state within each mode; excludes game update/streaming.',
                        'Wall time is not an isolated GPU timestamp. Separate sequential page loads can change residency; inspect snapshots before comparing.',
                    ]};
                }finally{g.render=render;g.update=update;}
            });
        }
        // Show actual coverage with existing diagnostic materials. Keep it
        // separate from shaded game visuals and restore the ordinary mode.
        await page.evaluate(p=>{window.qtDiag.regional.useCamera(p);window.qtDiag.water.tint(4);},poses[0]);
        await sleep(1000);await page.screenshot({path:`${output}/ownership-${mode}.png`});
        await page.evaluate(()=>window.qtDiag.water.tint(0));
    }
}finally{
    fs.writeFileSync(`${output}/browser.json`,JSON.stringify({...report,lighting,poses},null,2));await browser.close();
}
process.exit(report.errors.length||report.events.some(e=>/"event":"(lost|validation)"/.test(e.message))?1:0);
