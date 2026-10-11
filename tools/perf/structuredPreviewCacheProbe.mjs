/* global process */
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const req=createRequire(new URL('../../../terrain-lab/package.json',import.meta.url));
const {default:puppeteer}=await import(req.resolve('puppeteer-core'));
const output=process.env.SHAPE_OUTPUT??'tools/perf/structured-terrain-results/organic-lake/cache-preview';
fs.mkdirSync(output,{recursive:true});
const staleSource=execFileSync('git',['show','HEAD:core/world/quadtree/QuadtreeGPU.js'],{encoding:'utf8'});
if(staleSource.includes('setRegionalTerrain('))throw new Error('Reference must predate the regional traversal API');
fs.writeFileSync(`${output}/stale-quadtree-reference.js`,staleSource);
const managerSource=fs.readFileSync('core/world/quadtree/GPUQuadtreeTerrain.js','utf8');
const report={url:'http://localhost:8181/wizard_game/standalone.html?regionalLargeLake=organic&regionalView=basin',runs:[],
    notes:['Emulates an old cached unversioned quadtree response, then verifies the actual preview with versioned imports.',
        'This controlled reproduction does not establish the contents of the owner’s browser cache.']};
const browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless:'new',defaultViewport:{width:1280,height:900},protocolTimeout:120000,
    args:['--enable-gpu','--no-first-run','--no-default-browser-check']});
report.browser=await browser.version();
try{
    for(const mode of ['mixed-modules','versioned-import']){
        const page=await browser.newPage(),run={mode,errors:[],events:[],moduleRequests:[],staleResponses:0};
        report.runs.push(run);
        page.on('pageerror',e=>run.errors.push(String(e)));
        page.on('console',m=>{if(m.type()==='error'||m.text().startsWith('[CacheProbe]'))run.events.push(m.text());});
        await page.evaluateOnNewDocument(()=>{
            const request=GPUAdapter.prototype.requestDevice;
            GPUAdapter.prototype.requestDevice=async function(...args){
                const device=await request.apply(this,args);
                device.lost.then(i=>console.log('[CacheProbe]',JSON.stringify({event:'lost',reason:i.reason,message:i.message})));
                device.addEventListener('uncapturederror',e=>console.log('[CacheProbe]',JSON.stringify({event:'validation',message:e.error.message})));
                return device;
            };
        });
        await page.setRequestInterception(true);
        page.on('request',request=>{
            const url=new URL(request.url());
            if(/\/(QuadtreeGPU\.js|quadtreeTraversal\.wgsl\.js)$/.test(url.pathname))run.moduleRequests.push(url.pathname+url.search);
            if(url.pathname.endsWith('/QuadtreeGPU.js')&&!url.search){
                run.staleResponses++;
                return request.respond({status:200,contentType:'text/javascript',body:staleSource});
            }
            if(mode==='mixed-modules'&&url.pathname.endsWith('/GPUQuadtreeTerrain.js')){
                return request.respond({status:200,contentType:'text/javascript',
                    body:managerSource.replace('./QuadtreeGPU.js?regionalTerrainApi=1','./QuadtreeGPU.js')});
            }
            return request.continue();
        });
        await page.goto(report.url,{waitUntil:'domcontentloaded',timeout:120000});
        if(mode==='mixed-modules'){
            const start=Date.now();
            while(!run.errors.some(e=>e.includes('setRegionalTerrain is not a function'))&&Date.now()-start<120000){
                await new Promise(r=>setTimeout(r,100));
            }
            run.expectedFailureReproduced=run.errors.some(e=>e.includes('setRegionalTerrain is not a function'));
        }else{
            await page.waitForFunction(()=>window.gameEngine?.isInitialLoadComplete(),{timeout:120000});
            await page.waitForFunction(()=>{
                const g=window.gameEngine,c=g?.terrainGenerator?.regionalTerrain?.shapeData?.depression?.centre,t=g?.camera?.target;
                return c&&t&&g.waterService?.state==='ready'&&
                    (c[0]*t.x+c[1]*t.y+c[2]*t.z)/Math.hypot(t.x,t.y,t.z)>.999999;
            },{timeout:120000});
            await page.waitForFunction(()=>window.gameEngine?.isInitialLoadComplete(),{timeout:120000});
            await new Promise(r=>setTimeout(r,3000));
            run.state=await page.evaluate(()=>{
                const g=window.gameEngine,qt=g.renderer.quadtreeTileManager.quadtreeGPU,s=g.terrainGenerator.regionalTerrain.shapeData;
                return {ready:g.isInitialLoadComplete(),setRegionalTerrainType:typeof qt.setRegionalTerrain,
                    regionalVersion:qt._regionalTerrain?.version,profile:s.depression.kind,levelM:s.lakePlan.levelM,
                    camera:window.qtDiag.regional.camera()};
            });
            await page.screenshot({path:`${output}/preview.png`});
        }
        await page.close();
        console.log(JSON.stringify(run));
    }
}finally{fs.writeFileSync(`${output}/browser.json`,JSON.stringify(report,null,2));await browser.close();}
const fixed=report.runs[1];
process.exit(!report.runs[0].expectedFailureReproduced||!fixed?.state?.ready||fixed.errors.length||
    fixed.events.some(e=>/"event":"(lost|validation)"/.test(e))?1:0);
