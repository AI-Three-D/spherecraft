import {createRequire} from 'node:module';
import fs from 'node:fs';
const req=createRequire(new URL('../../../../terrain-lab/package.json',import.meta.url));
const {default:puppeteer}=await import(req.resolve('puppeteer-core'));
const browser=await puppeteer.connect({browserURL:'http://127.0.0.1:9226',defaultViewport:null,protocolTimeout:900000});
try{
 const pages=await browser.pages();
 const page=pages.find(p=>p.url().includes('standalone.html'))??pages.find(p=>p.url()!=='about:blank')??await browser.newPage();
 await page.evaluateOnNewDocument(fs.readFileSync(new URL('../lakeRecovery/pageInstrument.js',import.meta.url),'utf8'));
 if(process.argv[2]==='default')await page.goto('http://127.0.0.1:8220/wizard_game/standalone.html',{waitUntil:'domcontentloaded',timeout:180000});
 else if(page.url().includes('standalone.html'))await page.reload({waitUntil:'domcontentloaded',timeout:180000});
 else await page.goto('http://127.0.0.1:8220/wizard_game/standalone.html?regionalTerrain=0&regionalBanks=organic&riverSim=off&waterPrecompute=1',{waitUntil:'domcontentloaded',timeout:180000});
 await page.waitForFunction(()=>window.gameEngine?.waterService?.state==='ready'&&window.gameEngine?.getLoadingStatus?.()?.complete,{timeout:600000});
 await page.evaluate(()=>{
  const g=window.gameEngine,w=g.renderer.weatherController;w._pickNewWeatherTarget=()=>{};w.setWeather('clear',true);window.__lr.daylightAt([-1,0,0],.75);
  const st=document.createElement('style');st.textContent='body > *:not(#gameCanvas){visibility:hidden !important}';document.head.appendChild(st);
 });
 console.log(JSON.stringify(await page.evaluate(()=>({ready:true,errors:window.__lr.gpuErrors}))));
}finally{await browser.disconnect();}
