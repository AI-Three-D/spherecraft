// Exercise the same visible controls offered to the reviewer. --open leaves
// the browser and local server running for hands-on inspection.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../../',import.meta.url)),open=process.argv.includes('--open');
const req=createRequire(path.join(root,'../terrain-lab/package.json'));
const {default:puppeteer}=await import(req.resolve('puppeteer-core'));
const out=path.resolve(process.env.WATER_PREVIEW_OUT??'tools/perf/structured-terrain-results/water-play-2026-10-17/final/live-preview');fs.mkdirSync(out,{recursive:true});
const server=spawn('python3',[path.join(root,'tools/perf/lakeRecovery/noCacheServer.py'),'8201',root],{stdio:'ignore'});
let browser;
try {
    await new Promise(r=>setTimeout(r,600));
    browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:!open,
        defaultViewport:{width:1440,height:960,deviceScaleFactor:1},protocolTimeout:300000,
        args:['--enable-unsafe-webgpu','--enable-gpu','--no-first-run','--no-default-browser-check','--disable-background-timer-throttling','--disable-renderer-backgrounding']});
    const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')console.log(m.text());});
    await page.evaluateOnNewDocument(fs.readFileSync(path.join(root,'tools/perf/lakeRecovery/pageInstrument.js'),'utf8'));
    await page.goto('http://127.0.0.1:8201/tools/perf/waterStepReview/preview.html',{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>!document.querySelector('#jump').disabled,{timeout:300000});
    await page.click('#jump');await page.waitForFunction(()=>!document.querySelector('#toggle').disabled,{timeout:30000});
    await page.screenshot({path:path.join(out,'original.png')});
    await page.click('#toggle');await page.waitForFunction(()=>!document.querySelector('#toggle').disabled,{timeout:60000});
    const game=page.frames().find(f=>f.url().includes('standalone.html'));
    const metadata=await game.evaluate(()=>window.__connectedPrototype?.metadata??null);
    if(!metadata){await page.screenshot({path:path.join(out,'failure.png')});throw new Error('Mask toggle failed: '+await page.$eval('#status',e=>e.textContent));}
    await new Promise(r=>setTimeout(r,1000));await page.screenshot({path:path.join(out,'cached-mask.png')});
    await page.click('#detail');await page.waitForFunction(()=>!document.querySelector('#detail').disabled,{timeout:60000});
    await new Promise(r=>setTimeout(r,8000));await page.screenshot({path:path.join(out,'retained-shore.png')});
    await page.click('#detail');await page.waitForFunction(()=>!document.querySelector('#detail').disabled,{timeout:60000});
    await new Promise(r=>setTimeout(r,5000));
    await page.click('#toggle');await page.waitForFunction(()=>!document.querySelector('#toggle').disabled,{timeout:30000});
    const restored=await game.evaluate(()=>!window.__connectedPrototype);if(!restored)throw new Error('Original coverage was not restored');
    await page.click('#toggle');await page.waitForFunction(()=>!document.querySelector('#toggle').disabled,{timeout:60000});
    const frames=await game.evaluate(()=>window.gameEngine.renderer.quadtreeTileManager.quadtreeGPU._frameCount);await new Promise(r=>setTimeout(r,1000));
    const result=await game.evaluate(()=>({frames:window.gameEngine.renderer.quadtreeTileManager.quadtreeGPU._frameCount,gpuErrors:window.__lr.gpuErrors,metadata:window.__connectedPrototype?.metadata,
        resident:window.__lr.residency(),shoreOverride:!!window.__restoreShoreLod}));
    const summary={errors,framesBefore:frames,...result,restored,url:page.url()};fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(summary,null,2));
    if(errors.length||result.gpuErrors.length||result.frames<=frames||result.shoreOverride)throw new Error('Live preview validation failed');
    console.log(JSON.stringify({url:page.url(),framesAdvanced:result.frames-frames,restored,maskHash:result.metadata.maskSha256,open}));
    if(open)await new Promise(resolve=>browser.on('disconnected',resolve));
} finally {await browser?.close();server.kill();}
