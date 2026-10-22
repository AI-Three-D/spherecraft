// Persistent local scene for iterative water verification. No production overrides.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const req=createRequire(path.join(root,'../terrain-lab/package.json'));
const {default:puppeteer}=await import(req.resolve('puppeteer-core'));
const server=spawn('python3',[path.join(root,'tools/perf/lakeRecovery/noCacheServer.py'),'8220',root],{stdio:'ignore'});
let browser;
try {
    await new Promise(r=>setTimeout(r,500));
    browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless:!process.argv.includes('--open'),defaultViewport:{width:1440,height:900,deviceScaleFactor:1},protocolTimeout:300000,
        args:['--remote-debugging-port=9226','--enable-unsafe-webgpu','--enable-gpu','--no-first-run','--no-default-browser-check',
            '--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
    const page=await browser.newPage();
    page.on('pageerror',e=>console.log('PAGE ERROR',String(e)));
    page.on('console',m=>{if(m.type()==='error'||/\[Water\].*(ready|precompute|mountain)/i.test(m.text()))console.log(m.text().slice(0,1200));});
    await page.evaluateOnNewDocument(fs.readFileSync(path.join(root,'tools/perf/lakeRecovery/pageInstrument.js'),'utf8'));
    await page.goto('http://127.0.0.1:8220/wizard_game/standalone.html?regionalTerrain=0&regionalBanks=organic&riverSim=off&waterPrecompute=1',{waitUntil:'domcontentloaded',timeout:180000});
    await page.waitForFunction(()=>window.gameEngine?.waterService?.precomputed&&window.gameEngine?.getLoadingStatus?.()?.complete,{timeout:600000});
    await page.evaluate(()=>{
        const g=window.gameEngine,w=g.renderer.weatherController;
        w._pickNewWeatherTarget=()=>{};w.setWeather('clear',true);window.__lr.daylightAt([-1,0,0],0.75);
        const st=document.createElement('style');st.textContent='body > *:not(#gameCanvas){visibility:hidden !important}';document.head.appendChild(st);
    });
    console.log('READY: CDP 9226; '+page.url());
    await new Promise(r=>browser.on('disconnected',r));
} finally {await browser?.close();server.kill();}
