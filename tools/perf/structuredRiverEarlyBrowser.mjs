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
const frames=[];
try {
    await page.goto('http://localhost:8181/wizard_game/standalone.html?regionalTerrain=256&regionalBasins=1&regionalRivers=1',{waitUntil:'domcontentloaded',timeout:120000});
    await page.waitForFunction(()=>window.gameEngine?.waterGpuData?._ready,{timeout:120000});
    report.publication=await page.evaluate(()=>{
        // Diagnostic-only: inspect rendering behind the normal startup overlay.
        document.getElementById('loading-screen').style.display='none';
        window.qtDiag.regional.daylight();window.qtDiag.regional.river(.5,1700,2200);
        return {atMs:performance.now(),loading:window.gameEngine.getLoadingStatus()};
    });
    for(const label of ['first','one-second','three-seconds']) {
        if(label!=='first') await sleep(label==='one-second'?1000:2000);
        const before=await page.evaluate(()=>({atMs:performance.now(),loading:window.gameEngine.getLoadingStatus()}));
        await page.screenshot({path:`${output}/early-${label}.png`});
        frames.push({label,before,afterMs:await page.evaluate(()=>performance.now())});
    }
    if(!process.argv.includes('--coarse-only')) {
        await sleep(16000);
        await page.evaluate(()=>window.qtDiag.water.nearMesh({enabled:true,fadeStartM:8000,fadeEndM:10000}));
        // Invalidate the existing relist for this temporary range diagnostic.
        await page.evaluate(()=>{window.gameEngine.renderer.nearWaterRenderer._listedAt=null;});
        await sleep(5000);
        await page.screenshot({path:`${output}/network-extended-ribbons.png`});
        report.extendedRibbons=await page.evaluate(()=>({atMs:performance.now(),quadCount:window.gameEngine.renderer.nearWaterRenderer._quadCount,
            loading:window.gameEngine.getLoadingStatus(),near:window.gameEngine.waterGpuData.near}));
    }
} finally {
    report.frames=frames;report.notes.push('Startup overlay hidden only in this diagnostic; product overlay unchanged. An extended 8–10km range, when requested, is a temporary renderer probe, not an adopted setting.');
    fs.writeFileSync(`${output}/early-browser.json`,JSON.stringify(report,null,2));await browser.close();
}
console.log(JSON.stringify(report,null,2));
process.exit(report.errors.length||report.events.some(e=>/"event":"(lost|validation)"/.test(e.message))?1:0);
