/* global process */
import fs from 'node:fs';
import {createRequire} from 'node:module';
const req=createRequire(new URL('../../../terrain-lab/package.json',import.meta.url));
const {default:puppeteer}=await import(req.resolve('puppeteer-core'));
const output='tools/perf/structured-terrain-results/natural-surface';
const prior=JSON.parse(fs.readFileSync(`${output}/browser.json`));
const browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:'new',
    defaultViewport:{width:1280,height:900},protocolTimeout:120000,args:['--enable-gpu','--no-first-run','--no-default-browser-check']});
const page=await browser.newPage(),report={errors:[],views:[]};page.on('pageerror',e=>report.errors.push(String(e)));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try {
    await page.goto('http://localhost:8181/wizard_game/standalone.html?regionalTerrain=256&regionalBasins=1&regionalShape=1',{waitUntil:'domcontentloaded',timeout:120000});
    await page.waitForFunction(()=>window.gameEngine?.waterService?.state==='ready'&&window.gameEngine.isInitialLoadComplete(),{timeout:120000});
    report.data=await page.evaluate(()=>{
        const g=window.gameEngine,w=g.waterGpuData,d=g.terrainGenerator.regionalTerrain,b=d.basins[0],rec=g.waterService.refined.get(0);
        window.qtDiag.regional.daylight();w.debugMode=3;w.near.enabled=false;
        return {options:d.shapeData.options,waterEnabled:w.enabled,table:Array.from(w._table.slice(0,16)),refined:{range:rec.surfaceDepthRangeM,
            codes:Array.from(rec.surfaceDepthMask??[]),frame:rec.frame},lake:b.centre,basinLevel:b.levelM,
            materialLakeWater:g.renderer.quadtreeTerrainRenderer?.terrainShaderConfig?.lakeWater};
    });
    for(const v of prior.views.filter(v=>v.mode==='surface'&&v.label!=='shore')) {
        await page.evaluate(p=>window.qtDiag.regional.useCamera(p),v.pose);await sleep(9000);
        await page.screenshot({path:`${output}/coverage-${v.label}.png`});report.views.push(v);
    }
} finally {fs.writeFileSync(`${output}/coverage-probe.json`,JSON.stringify(report,null,2));await browser.close();}
console.log(JSON.stringify({errors:report.errors,table:report.data?.table,range:report.data?.refined.range}));
process.exit(report.errors.length?1:0);
