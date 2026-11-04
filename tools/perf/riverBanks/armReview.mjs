// Headless capture runner (node armReview.mjs CONFIG.json): see RIVERS_AND_LAKES.md section 8.

import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const root=config.root;
const req=createRequire('/Users/okkokauhanen/work/DATrain/feature/proj/terrain-lab/package.json');
const {default:puppeteer}=await import(req.resolve('puppeteer-core'));
const server=spawn('python3',[path.join(root,'tools/perf/lakeRecovery/noCacheServer.py'),'8232',root],{stdio:'ignore'});
let browser;
let sharedGenerationTiles=config.tileKeys??null;
for (const signal of ["SIGINT","SIGTERM"]) process.once(signal,()=>{ void browser?.close(); });
try{
 await new Promise(r=>setTimeout(r,600));
 browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,
  defaultViewport:{width:1440,height:900,deviceScaleFactor:1},protocolTimeout:900000,userDataDir:'/private/tmp/spherecraft-river-20261029',
  args:['--enable-unsafe-webgpu','--enable-gpu','--enable-webgpu-developer-features','--no-first-run','--no-default-browser-check',
   '--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
 for(const arm of config.arms){
  const out=path.join(config.out,arm.name);fs.mkdirSync(out,{recursive:true});
  const report={arm:arm.name,root,started:new Date().toISOString(),patches:arm.patches,poses:[],probes:{},errors:[]};
  const save=()=>fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
  save();
  const page=await browser.newPage();
  try{
   page.on('pageerror',e=>report.errors.push(String(e)));
   page.on('console',m=>{if(m.type()==='error')report.errors.push(m.text().slice(0,600));});
   const originals=new Map();
   for(const patch of arm.patches??[]){
    if(!root.startsWith('/private/tmp/spherecraft-river-experiment'))throw new Error('Patches require isolated experiment worktree');
    const file=path.join(root,patch.file);
    if(!originals.has(file))originals.set(file,fs.readFileSync(file,'utf8'));
    let source=fs.readFileSync(file,'utf8');
    if(!source.includes(patch.from))throw new Error('Patch missing: '+patch.from);
    fs.writeFileSync(file,source.replace(patch.from,patch.to));
   }
   report.restoreFiles=[...originals.keys()];
   page.__restore=()=>{for(const [file,source] of originals)fs.writeFileSync(file,source);};
   for(const f of ['lakeRecovery/pageInstrument.js','terrainDetail/gpuTimer.js'])
    await page.evaluateOnNewDocument(fs.readFileSync(path.join(root,'tools/perf',f),'utf8'));
   if(arm.preload)await page.evaluateOnNewDocument(arm.preload);
   await page.goto('http://127.0.0.1:8232/wizard_game/standalone.html'+(arm.query??'?regionalTerrain=0&regionalBanks=organic&riverSim=off&waterPrecompute=1&lodHeight=ground'+(arm.urlExtra??config.urlExtra??'')),{waitUntil:'domcontentloaded',timeout:180000});
   // arm.query: another world (the default one is not precomputed).
   await page.waitForFunction(pre=>(!pre||window.gameEngine?.waterService?.precomputed===true)&&window.gameEngine?.getLoadingStatus?.()?.complete,{timeout:900000,polling:500},arm.query==null);
   await page.evaluate(()=>{const g=window.gameEngine,w=g.renderer.weatherController;w._pickNewWeatherTarget=()=>{};w.setWeather('clear',true);
    window.__lr.daylightAt([-1,0,0],.75);const st=document.createElement('style');st.textContent='body > *:not(#gameCanvas){visibility:hidden !important}';document.head.appendChild(st);});
   if(config.fixedQuality)await page.evaluate(()=>{const g=gameEngine;g.engineConfig.rendering.adaptive.enabled=false;g.engineConfig.rendering.pixelRatio=1.5;g.engineConfig.rendering.maxFps=0;g.adaptiveQuality.pixelRatio=1.5;g.adaptiveQuality.reset();g.handleResize();});
   if(arm.eval)report.evalResult=await page.evaluate(async code=>await (0,eval)(code),arm.eval);
   console.log(JSON.stringify({arm:arm.name,loaded:true}));
   for(const view of arm.views??config.views??[]){
    await page.evaluate(async v=>{const q=await import('/tools/perf/waterStepReview/qualityScene.js');
     if(v.river!=null)await q.riverView(v.river,v.fraction,{height:v.height??30,back:v.back??45});else await q.poseView(v);
     await new Promise(r=>setTimeout(r,1000));},view);
    await page.screenshot({path:path.join(out,view.name+'.png')});
    if (arm.looks?.length) {
     const originalLook=await page.evaluate(()=>({...gameEngine.waterGpuData.look}));
     for (const look of arm.looks) {
      if(look.eval)await page.evaluate(async code=>await (0,eval)(code),look.eval);
      await page.evaluate(v=>qtDiag.water.look(v),look.value??{});
      await new Promise(r=>setTimeout(r,400));
      await page.screenshot({path:path.join(out,view.name+'-look-'+look.name+'.png')});
      if(look.restore)await page.evaluate(async code=>await (0,eval)(code),look.restore);
     }
     await page.evaluate(v=>qtDiag.water.look(v),originalLook);
    }

    // view.eval: run after posing (e.g. regenerate tiles), then capture again under view.name+'-'+view.tag.
    if(view.eval){await page.evaluate(async code=>await (0,eval)(code),view.eval);}
    if(view.tag)await page.screenshot({path:path.join(out,view.name+'-'+view.tag+'.png')});
    const shotName=view.tag?view.name+'-'+view.tag:view.name;
    // Modes: 'wN' water debug, 'N' terrain debug, 'N+wM' both (91+w10: dry lighting).
    for(const mode of arm.modes??config.modes??['w10']){
     const parts=mode.split('+');
     await page.evaluate(ps=>{for(const m of ps)m.startsWith('w')?window.gameEngine.setWaterDebugMode(Number(m.slice(1))):window.gameEngine.renderer.setTerrainDebugMode(Number(m));},parts);
     await new Promise(r=>setTimeout(r,700));
     await page.screenshot({path:path.join(out,shotName+'-dbg'+mode.replace('+','')+'.png')});
     await page.evaluate(ps=>{for(const m of ps)m.startsWith('w')?window.gameEngine.setWaterDebugMode(0):window.gameEngine.renderer.setTerrainDebugMode(0);},parts);
    }
    // arm.viewProbes: run at each view with { ...p.a, pos, look } (results under probes[label/view]).
    for(const p of arm.viewProbes??[]){
     report.probes[(p.label??p.e)+'/'+(view.name+(view.tag?'-'+view.tag:''))]=await page.evaluate(async(p,v)=>(await import(p.m))[p.e]({...p.a,pos:v.pos,look:v.look}),p,view);
    }
    const timing=await page.evaluate(async()=>(await import('/tools/perf/terrainDetail/scene.js')).fencedFrames(30,5));
    report.poses.push({name:view.name,timing,render:await page.evaluate(()=>({width:gameEngine.canvas.width,height:gameEngine.canvas.height,quality:gameEngine.adaptiveQuality.state}))});save();console.log(JSON.stringify({arm:arm.name,view:view.name,gpu:timing.gpuSpanMs?.median}));
   }
   for(const p of arm.probes??config.probes??[]){
    const request=p.e==='fixedTilesGpu'&&sharedGenerationTiles?{...p,a:{...p.a,tileKeys:sharedGenerationTiles}}:p;
    report.probes[p.label??p.e]=await page.evaluate(async p=>(await import(p.m))[p.e](p.a),request);
    if(p.e==='fixedTilesGpu')sharedGenerationTiles??=report.probes[p.label??p.e].tileKeys;
    save();console.log(JSON.stringify({arm:arm.name,probe:p.label??p.e,result:JSON.stringify(report.probes[p.label??p.e]).slice(0,300)}));
   }
   report.gpuErrors=await page.evaluate(()=>window.__lr.gpuErrors);report.finished=new Date().toISOString();save();
   if(config.keepAlive){fs.writeFileSync('/private/tmp/river-live-connection.json',JSON.stringify({ws:browser.wsEndpoint(),arm:arm.name,out}));console.log('LIVE_READY');await new Promise(r=>browser.once('disconnected',r));break;}
   await page.goto('about:blank');
  }catch(error){report.failure=String(error);save();throw error;}finally{page.__restore?.();if(!page.isClosed())await page.close().catch(()=>{});}
 }
}finally{await browser?.close();server.kill();}
