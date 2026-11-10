/* global process */
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {HIGHLAND_BASIN_CASE,VALLEY_FEATURE_CASE} from './structuredBasinCases.mjs';
const req=createRequire(new URL('../../../terrain-lab/package.json',import.meta.url));
const {default:puppeteer}=await import(req.resolve('puppeteer-core'));
const feature=process.argv.includes('--feature'),valleys=process.argv.includes('--valleys'),highland=process.argv.includes('--highland')||valleys||feature;
const output=process.env.BASIN_OUTPUT??`tools/perf/structured-terrain-results/${feature?'valley-feature':valleys?'basin-valleys':highland?'basin-highland':'basin-bank-reach'}`;fs.mkdirSync(output,{recursive:true});
const queryNames={radiusM:'regionalBasinRadius',minLevelM:'regionalMinLevel',maxRoughness:'regionalMaxRoughness',maxCentreCutM:'regionalMaxCut'};
const extra=(highland?Object.entries(feature?VALLEY_FEATURE_CASE:HIGHLAND_BASIN_CASE).map(([key,value])=>`&${queryNames[key]}=${value}`).join(''):'')+(valleys?'&regionalValleys=1':'');
const context=feature?null:valleys?{maximumOffsetM:[-600,0]}:highland?JSON.parse(fs.readFileSync(`${output}/placement-audit.json`)).contexts.find(c=>c.radiusM===HIGHLAND_BASIN_CASE.radiusM):null;
const report={events:[],errors:[],views:[],notes:['Actual game screenshots, production materials/micro/water/LOD. Same poses and paused daylight rotation; driver caches are not frozen.']};
const browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:'new',
    defaultViewport:{width:1280,height:900},protocolTimeout:120000,args:['--enable-gpu','--no-first-run','--no-default-browser-check']});
const page=await browser.newPage();let mode='prototype';
page.on('pageerror',e=>report.errors.push({mode,message:String(e)}));
page.on('console',m=>{if(m.text().startsWith('[BasinProbe]')||m.type()==='error') report.events.push({mode,type:m.type(),message:m.text()});});
await page.evaluateOnNewDocument(()=>{
    const old=GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice=async function(...args){
        const device=await old.apply(this,args);
        device.lost.then(info=>console.log('[BasinProbe]',JSON.stringify({event:'lost',reason:info.reason,message:info.message,atMs:performance.now()})));
        device.addEventListener('uncapturederror',e=>console.log('[BasinProbe]',JSON.stringify({event:'validation',message:e.error.message,atMs:performance.now()})));
        return device;
    };
});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const poses=[];
try {
    const queries=feature?['1&regionalFeature=1','reference&regionalFeature=reference','reference&regionalFeature=dry']:process.argv.includes('--bank-comparison')?['1&regionalBankReach=18','1&regionalBankReach=0']:['1','reference'];
    if(process.argv.includes('--bank-comparison')) report.notes.push('Reference retains the accepted basin with bankReachM=0; prototype extends its outer transition in seeded patches. Site, level and wet-core contract match.');
    for(const query of process.argv.includes('--health-only')?queries.slice(0,1):queries) {
        mode=query===queries[0]?'prototype':query.includes('regionalFeature=dry')?'dry':'reference';
        await page.goto(`http://localhost:8181/wizard_game/standalone.html?regionalTerrain=256&regionalBasins=${query}${extra}`,{waitUntil:'domcontentloaded',timeout:120000});
        await page.waitForFunction(()=>window.gameEngine?.waterService?.state==='ready',{timeout:120000});
        report[mode]=await page.evaluate(()=>{
            const g=window.gameEngine,t=g.renderer.quadtreeTileManager.tileStreamer.terrainGenerator;
            return {coarseWaterReadyAtMs:performance.now(),initialLoadComplete:g.isInitialLoadComplete(),
                regional:t.regionalTerrain.timings,basins:t.regionalTerrain.basins,water:g.waterService.timings};
        });
        await page.waitForFunction(()=>window.gameEngine?.waterGpuData?._ready,{timeout:120000});
        report[mode].gpuPublication=await page.evaluate(()=>({atMs:performance.now(),initialLoadComplete:window.gameEngine.isInitialLoadComplete()}));
        await page.waitForFunction(()=>window.gameEngine?.isInitialLoadComplete(),{timeout:120000});
        report[mode].initialLoadCompleteAtMs=await page.evaluate(()=>performance.now());
        if(process.argv.includes('--health-only')) {await sleep(3000);continue;}
        report[mode].lighting=await page.evaluate(()=>window.qtDiag.regional.daylight());
        if(mode==='prototype') await page.evaluate(()=>window.qtDiag.regional.basin());
        else await page.evaluate(p=>window.qtDiag.regional.useCamera(p),poses[0]);
        await sleep(18000);
        for(let i=0;i<(highland?4:3);i++) {
            if(mode==='prototype') {
                if(i>0) await page.evaluate(({view,peak,valley,feature})=>{
                    const g=window.gameEngine,l=g.waterService.lakes[0],R=g.planetConfig.radius,o=g.planetConfig.origin??{x:0,y:0,z:0};
                    const p=window.qtDiag.regional.camera(),axes=['x','y','z'];
                    const r=l.frame.spacing*16;
                    const basin=g.terrainGenerator.regionalTerrain.basinPlan.basins[0];
                    const altitude=view===1?r*4.5:(view===3?r*(feature?1.8:valley?8:7.5):Math.max(r*.15,basin.centreCutM+6)),back=view===1?r*2:(view===3?r*(feature?4.5:valley?12:20):r*.9);
                    let direction=l.frame.e2;
                    if(view===3&&peak) {
                        const length=Math.hypot(...peak);
                        direction=l.frame.e1.map((v,k)=>(v*peak[0]+l.frame.e2[k]*peak[1])/length);
                    }
                    if(view===3&&feature) direction=g.terrainGenerator.regionalTerrain.valleyFeature.seed.axis;
                    axes.forEach((a,k)=>{p.position[a]=o[a]+l.frame.c[k]*(R+l.level+altitude)-direction[k]*back;p.target[a]=o[a]+l.frame.c[k]*(R+l.level);});
                    window.qtDiag.regional.useCamera(p);
                },{view:i,peak:context?.maximumOffsetM,valley:valleys,feature});
                poses[i]=await page.evaluate(()=>window.qtDiag.regional.camera());
            } else await page.evaluate(p=>window.qtDiag.regional.useCamera(p),poses[i]);
            await sleep(7000);
            const label=['banks','overview','shore','context'][i];
            await page.screenshot({path:`${output}/${label}-${mode}.png`});
            report.views.push({mode,label,pose:poses[i],atMs:await page.evaluate(()=>performance.now())});
        }
    }
} finally {
    fs.writeFileSync(`${output}/${process.argv.includes('--health-only')?'browser-publication':'browser'}.json`,JSON.stringify(report,null,2));await browser.close();
}
console.log(JSON.stringify({errors:report.errors,events:report.events,prototype:report.prototype,reference:report.reference},null,2));
process.exit(report.errors.length||report.events.some(e=>/"event":"(lost|validation)"/.test(e.message))?1:0);
