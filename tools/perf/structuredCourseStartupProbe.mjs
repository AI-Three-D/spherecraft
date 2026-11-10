/* global process */
import fs from 'node:fs';
import {createRequire} from 'node:module';
const req=createRequire(new URL('../../../terrain-lab/package.json',import.meta.url));
const {default:puppeteer}=await import(req.resolve('puppeteer-core'));
const output=process.env.RIVER_OUTPUT??'tools/perf/structured-terrain-results/organic-course/startup';
fs.mkdirSync(output,{recursive:true});
const report={errors:[],events:[],notes:[
    'Production page with diagnostic-only JS hooks after regional dependency preparation and at terrain invalidation.',
    'Checks water publication before first render-tile work. This is not a fast-motion or causal timing comparison.',
]};
const browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless:'new',defaultViewport:{width:1280,height:900},protocolTimeout:120000,
    args:['--enable-gpu','--no-first-run','--no-default-browser-check']});
const page=await browser.newPage();
page.on('pageerror',e=>report.errors.push(String(e)));
page.on('console',m=>{if(m.type()==='error'||m.text().startsWith('[CourseProbe]'))report.events.push(m.text());});
await page.evaluateOnNewDocument(()=>{
    window.__courseTiles=[];window.__courseInvalidations=[];
    const request=GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice=async function(...args){
        const device=await request.apply(this,args);
        device.lost.then(i=>console.log('[CourseProbe]',JSON.stringify({event:'lost',reason:i.reason,message:i.message})));
        device.addEventListener('uncapturederror',e=>console.log('[CourseProbe]',JSON.stringify({event:'validation',message:e.error.message})));
        return device;
    };
});
await page.setRequestInterception(true);
page.on('request',r=>{
    const path=new URL(r.url()).pathname;
    if(path==='/core/world/quadtree/tileGenerator.js'){
        const source=fs.readFileSync('.'+path,'utf8').replace('const includeBaseHeight = options?.includeBaseHeight === true;',
            `window.__courseTiles.push({atMs:performance.now(),address:tileAddr.toString(),
                bound:this.terrainGen.waterCarveBound,waterReady:window.gameEngine?.waterGpuData?._ready??false,
                version:this.terrainGen.waterCarveVersion,types:options?.requiredTypes??this.requiredTypes,
                geometryReuse:!!options?.geometrySource});
            const includeBaseHeight = options?.includeBaseHeight === true;`);
        r.respond({status:200,contentType:'text/javascript',body:source});
    }else if(path==='/core/world/quadtree/GPUQuadtreeTerrain.js'){
        const source=fs.readFileSync('.'+path,'utf8').replace('regenerateTiles(predicate) {',
            'regenerateTiles(predicate) { window.__courseInvalidations.push({atMs:performance.now(),stack:new Error().stack});');
        r.respond({status:200,contentType:'text/javascript',body:source});
    }else r.continue();
});
try{
    const mountain=process.argv.includes('--mountain');
    const query=mountain?'regionalWhitewater=1&regionalRiverCourse=organic&regionalView=river'
        :'regionalLargeLake=organic&regionalOrganicRiver=1&regionalView=river';
    report.url=`http://localhost:8181/wizard_game/standalone.html?${query}`;
    await page.goto(report.url,{waitUntil:'domcontentloaded',timeout:120000});
    await page.waitForFunction(()=>window.gameEngine?.waterGpuData?._ready,{timeout:120000});
    await page.waitForFunction(()=>window.gameEngine?.getLoadingStatus?.()?.complete===true,{timeout:120000});
    await new Promise(resolve=>setTimeout(resolve,6000));
    report.state=await page.evaluate(()=>({atMs:performance.now(),tiles:window.__courseTiles,
        invalidations:window.__courseInvalidations,pose:window.qtDiag.regional.camera(),loading:window.gameEngine.getLoadingStatus(),
        river:window.gameEngine.terrainGenerator.regionalTerrain.drainagePlan.rivers[0]}));
    report.publicationCheck={tileCalls:report.state.tiles.length,
        unready:report.state.tiles.filter(t=>!t.waterReady).length,
        unbound:report.state.tiles.filter(t=>!t.bound).length,
        invalidations:report.state.invalidations.length};
    await page.screenshot({path:`${output}/automatic-preview.png`});
}finally{fs.writeFileSync(`${output}/browser.json`,JSON.stringify(report,null,2));await browser.close();}
const failedPublication=!process.argv.includes('--allow-unready')&&(!report.publicationCheck?.tileCalls
    ||report.publicationCheck.unready||report.publicationCheck.unbound||report.publicationCheck.invalidations);
process.exit(failedPublication||report.errors.length||report.events.some(e=>/"event":"(lost|validation)"/.test(e))?1:0);
