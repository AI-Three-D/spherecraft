import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import os from 'node:os';
const root=path.resolve('.'),out=path.resolve(process.argv[2]??'/tmp/water-cost-browser');fs.mkdirSync(out,{recursive:true});
const req=createRequire('/Users/okkokauhanen/work/DATrain/feature/proj/terrain-lab/package.json');const {default:puppeteer}=await import(req.resolve('puppeteer-core'));
const port=8198,server=spawn('python3',[path.join(root,'tools/perf/lakeRecovery/noCacheServer.py'),String(port),root],{stdio:'ignore'});
await new Promise(r=>setTimeout(r,500));
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'spherecraft-water-cost-'));
const browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,userDataDir:profile,defaultViewport:{width:1440,height:900,deviceScaleFactor:2},protocolTimeout:900000,args:['--enable-unsafe-webgpu','--enable-gpu','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
const page=await browser.newPage(),report={startedAt:new Date().toISOString(),errors:[],views:[],gpuErrors:[],scope:'read-only terrain probes and isolated experimental GPU connectivity, no production source changes'};
const save=()=>fs.writeFileSync(path.join(out,'browser.json'),JSON.stringify(report,null,2));
page.on('pageerror',e=>report.errors.push(String(e)));
await page.evaluateOnNewDocument(fs.readFileSync('tools/perf/lakeRecovery/pageInstrument.js','utf8'));
await page.evaluateOnNewDocument(()=>{const original=GPUAdapter.prototype.requestDevice;GPUAdapter.prototype.requestDevice=function(desc={}){return original.call(this,{...desc,requiredFeatures:[...new Set([...(desc.requiredFeatures??[]),...(this.features.has('timestamp-query')?['timestamp-query']:[])])]});};});
try{
 await page.goto(`http://127.0.0.1:${port}/wizard_game/standalone.html?regionalTerrain=0&regionalBanks=organic&riverSim=off&waterPrecompute=1`,{waitUntil:'domcontentloaded',timeout:180000});
 await page.waitForFunction(()=>window.gameEngine?.waterService?.precomputed===true&&window.gameEngine?.getLoadingStatus?.()?.complete,{timeout:600000});
 const all=JSON.parse(fs.readFileSync('tools/perf/structured-terrain-results/water-look-2026-10-12/views-hold-all.json','utf8'));
 for(const name of ['o4-star','owner-s3-shore','o4-mouth']){
  const v=all.find(v=>v.name===name),l=Math.hypot(...v.pos);
  await page.evaluate(v=>window.qtDiag.regional.useCamera(v),{position:{x:v.pos[0],y:v.pos[1],z:v.pos[2]},target:{x:v.look[0],y:v.look[1],z:v.look[2]},up:{x:v.pos[0]/l,y:v.pos[1]/l,z:v.pos[2]/l},fov:75});
  await page.waitForFunction(()=>{const r=window.__lr.residency(),g=window.gameEngine;return r?.visibleTiles>0&&r.exactVisibleRatio===1&&r.pendingGenerations===0&&r.activeGenerations===0&&r.pendingCopies===0&&!g.waterService._busy&&g.waterService._client._pending.size===0&&g.renderer.quadtreeTileManager.tileStreamer.getRegenerationStats().pending===0;},{timeout:240000});
  await new Promise(r=>setTimeout(r,1500));
  const probe=await page.evaluate(async()=>{const {probeTerrain}=await import('/tools/perf/waterCoverageResearch/terrainProbe.js');return probeTerrain();});
  report.views.push({name,...probe});save();console.log(JSON.stringify({view:name,fineAvailableShare:probe.finestAvailableShare,missingFineTiles:probe.distinctMissingFineTiles,interpolation:probe.interpolationComparison.map(x=>({segments:x.segments,p99:x.heightErrorM.p99,max:x.heightErrorM.max}))}));
 }
 report.connectivity=await page.evaluate(async()=>{
  const g=window.gameEngine,device=g.renderer.backend.device;
  const {createConnectivityBench,syntheticMask,summarize}=await import('/tools/perf/waterCoverageResearch/gpuConnectivity.js');
  const saved={update:g.update,render:g.render};g.update=()=>{};g.render=()=>{};await device.queue.onSubmittedWorkDone();
  try{const bench=await createConnectivityBench(device),cases=[];
   for(const n of [1024,3200]){const job=await bench.job(syntheticMask(n,'shore'),n,0);await job.run();await job.run();const samples=[];for(let i=0;i<9;i++)samples.push(await job.run());cases.push({n,...summarize(samples),samples});job.dispose();}
   const result={timestamp:bench.timestamp,compileMs:bench.compileMs,errors:bench.errors,cases};bench.dispose();return result;
  }finally{g.update=saved.update;g.render=saved.render;}
 });
 report.fieldProbe=await page.evaluate(async()=>{const {probeGameField}=await import('/tools/perf/waterCoverageResearch/gameFieldProbe.js');return probeGameField();});save();console.log(JSON.stringify({fieldProbe:report.fieldProbe.cases.map(x=>({n:x.n,stages:x.stages.map(s=>({name:s.name,gpuMs:s.gpuMs?.median})),connectivityGpuMs:x.connectivity.gpuMs?.median}))}));
 report.fineHeight=await page.evaluate(async()=>{const {probeFineHeightCost}=await import('/tools/perf/waterCoverageResearch/fineHeightCost.js');return probeFineHeightCost();});save();console.log(JSON.stringify({fineHeight:report.fineHeight.samples.map(x=>({count:x.count,gpuMs:x.gpuMs,wallMs:x.fenceWallMs}))}));
 report.gpuErrors=await page.evaluate(()=>window.__lr.gpuErrors);report.browserVersion=await browser.version();
}catch(e){report.failure=String(e.stack??e);console.error(report.failure);}
finally{report.finishedAt=new Date().toISOString();save();await browser.close();server.kill();fs.rmSync(profile,{recursive:true,force:true});}
process.exitCode=report.failure||report.errors.length||report.gpuErrors.length?1:0;
