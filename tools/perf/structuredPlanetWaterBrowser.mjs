/* global process */
import fs from 'node:fs';import {createRequire} from 'node:module';import crypto from 'node:crypto';
const req=createRequire(new URL('../../../terrain-lab/package.json',import.meta.url));const {default:puppeteer}=await import(req.resolve('puppeteer-core'));
const output=process.env.WATER_OUTPUT??'tools/perf/structured-terrain-results/placement-defaults/game';fs.mkdirSync(output,{recursive:true});
const browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:'new',defaultViewport:{width:1280,height:900},protocolTimeout:180000,args:['--enable-gpu','--no-first-run','--no-default-browser-check']});
const page=await browser.newPage(),report={url:'http://localhost:8181/wizard_game/standalone.html',browser:await browser.version(),errors:[],gpuErrors:[],resources:[],sources:[],views:[]},reads=[];
page.on('pageerror',e=>report.errors.push(String(e)));page.on('console',m=>{if(m.text().startsWith('[PlanetWaterGPU]'))report.gpuErrors.push(m.text());});
page.on('response',r=>{const pathname=new URL(r.url()).pathname;if(r.status()>=400)report.resources.push({pathname,status:r.status()});if(/\.(js|html)$/.test(pathname))reads.push(r.text().then(v=>{
 report.sources.push({pathname,sha256:crypto.createHash('sha256').update(v).digest('hex')});
 const p=`${output}/served${pathname}`;fs.mkdirSync(p.slice(0,p.lastIndexOf('/')),{recursive:true});fs.writeFileSync(p,v);
}));});
await page.evaluateOnNewDocument(()=>{const request=GPUAdapter.prototype.requestDevice;GPUAdapter.prototype.requestDevice=async function(...args){const d=await request.apply(this,args);d.addEventListener('uncapturederror',e=>console.log('[PlanetWaterGPU]',e.error.message));d.lost.then(e=>console.log('[PlanetWaterGPU]',e.reason,e.message));return d;};});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try{
 await page.goto(report.url,{waitUntil:'domcontentloaded',timeout:180000});
 await page.waitForFunction(()=>window.gameEngine?.waterGpuData?._ready,{timeout:180000});
 report.waterReadyMs=await page.evaluate(()=>performance.now());
 report.world=await page.evaluate(()=>{const g=window.gameEngine,r=g.terrainGenerator.regionalTerrain;return{options:r.worldConfig,lakes:r.basins.map(b=>({id:b.id,centre:b.centre,radiusM:b.radiusM,levelM:b.levelM,shape:!!b.shapeProof})),rivers:r.drainagePlan.rivers.map(v=>({id:v.id,fromLake:v.fromLake,dest:v.dest,lengthM:v.lengthM})),timings:r.timings,bytes:r.byteLength,carveVersion:g.terrainGenerator.waterCarveVersion,initialStatus:g.renderer.quadtreeTileManager?.getInitialLoadStatus?.(),service:g.waterService.stats};});
 await page.waitForFunction(()=>window.gameEngine?.getLoadingStatus?.()?.complete,{timeout:180000});
 report.initialTerrainMs=await page.evaluate(()=>performance.now());
 const cases=process.argv.includes('--config-only')?[]:await page.evaluate(()=>{const r=window.gameEngine.terrainGenerator.regionalTerrain;
  const gentle=[...r.shapeData.patches].filter(p=>p.parent.gentle&&Math.abs(p.basin.centre[1])<.6).sort((a,b)=>b.basin.radiusM-a.basin.radiusM);
  const rugged=r.shapeData.patches.filter(p=>!p.parent.gentle);return[
   {label:'broad-lake',kind:'lake',id:gentle[0].basin.id},
   {label:'rugged-lake',kind:'lake',id:rugged[0].basin.id},
   {label:'other-face-lake',kind:'lake',id:gentle.find(p=>p.options.face!==gentle[0].options.face).basin.id},
   ...r.drainagePlan.rivers.slice(0,2).map(v=>({label:`river-${v.id}`,kind:'river',id:v.id}))];});
 for(const c of cases){
  const start=Date.now(),frame=await page.evaluate(()=>window.gameEngine.renderer.quadtreeTileManager.quadtreeGPU._frameCount),pose=await page.evaluate(c=>{
   const g=window.gameEngine,r=g.terrainGenerator.regionalTerrain,R=g.planetConfig.radius,o=g.planetConfig.origin,axes=['x','y','z'];let d,h,back,alt,along;
   document.getElementById('game-ui').style.visibility='hidden';
   if(c.kind==='lake'){const b=g.waterService.lakes.find(b=>b.id===c.id);d=b.centreDir;h=b.level;back=r.basins.find(b=>b.id===c.id).radiusM*1.8;alt=back*.8;along=b.frame.e2;}
   else{const rec=r.drainagePlan.rivers.find(v=>v.id===c.id),k=Math.floor(rec.points.length/rec.stride*.45),a=k*rec.stride;d=Array.from(rec.points.slice(a,a+3));h=rec.points[a+3];const delta=d.map((_,i)=>rec.points[a+rec.stride+i]-rec.points[a-rec.stride+i]),len=Math.hypot(...delta);along=delta.map(v=>v/len);back=75;alt=65;}
   const s=g.starSystem;s.paused=true;s.useGameTimeRotation=false;let best=Infinity,rotation=0;
   for(let i=0;i<720;i++){s.currentBody.currentRotation=i*Math.PI*2/720;const sun=s.currentBody.getStarDirection(s.primaryStar).direction;const dot=sun.x*d[0]+sun.y*d[1]+sun.z*d[2],score=Math.abs(dot-.75);if(score<best){best=score;rotation=s.currentBody.currentRotation;}}
   s.currentBody.currentRotation=rotation;
   const p={position:{},target:{},up:{},fov:g.camera.fov};axes.forEach((a,i)=>{p.position[a]=o[a]+d[i]*(R+h+alt)-along[i]*back;p.target[a]=o[a]+d[i]*(R+h);p.up[a]=d[i];});window.qtDiag.regional.useCamera(p);return p;
  },c);
  await page.waitForFunction(frame=>window.gameEngine.renderer.quadtreeTileManager.quadtreeGPU._frameCount>=frame+3,{timeout:120000},frame);
  await page.waitForFunction(()=>{const s=window.gameEngine.renderer.quadtreeTileManager.getInitialLoadStatus();return s.pendingGenerations===0&&s.activeGenerations===0&&s.pendingCopies===0&&s.exactVisibleRatio===1;},{timeout:120000});
  let stable=false;
  for(let i=0;i<20&&!stable;i++){
   await sleep(250);stable=await page.evaluate(()=>{const s=window.gameEngine.renderer.quadtreeTileManager.getInitialLoadStatus();return s.pendingGenerations===0&&s.activeGenerations===0&&s.pendingCopies===0&&s.exactVisibleRatio===1;});
  }
  if(!stable)throw new Error('View did not settle');
  const readinessMs=Date.now()-start;
  const state=await page.evaluate(async()=>{
   const g=window.gameEngine,m=g.renderer.quadtreeTileManager,device=g.renderer.backend.device;while(g._renderInFlight)await new Promise(requestAnimationFrame);
   const restore={update:g.update,render:g.render};g.update=()=>{};g.render=()=>{};await device.queue.onSubmittedWorkDone();
   const wall=[];for(let i=0;i<40;i++){const t=performance.now();await restore.render.call(g,0);await device.queue.onSubmittedWorkDone();if(i>=10)wall.push(performance.now()-t);}
   g.update=restore.update;g.render=restore.render;
   return{coverage:m.getInitialLoadStatus(),selected:m._lastVisibleTiles.map(t=>`f${t.face}:d${t.depth}:${t.x},${t.y}`).sort(),regeneration:m.tileStreamer.getRegenerationStats?.(),waterVersion:g.waterGpuData._appliedVersion,regionalVersion:g.terrainGenerator.regionalTerrain.version,regionalKey:g.terrainGenerator.regionalTerrain.sourceKey,
    sim:window.qtDiag.water.sim(),fullRenderFenceMs:wall};
  });
  if(state.coverage.exactVisibleRatio!==1||state.coverage.pendingGenerations||state.coverage.activeGenerations||state.coverage.pendingCopies)throw new Error('Residency changed during render measurement; reject this view');
  await page.screenshot({path:`${output}/${c.label}.png`});report.views.push({...c,pose,readinessMs,state});console.log(JSON.stringify({view:c.label,readinessMs}));
 }
 if(report.world.lakes.length<12||new Set(report.world.lakes.map(b=>Math.sign(b.centre[0])*10+Math.sign(b.centre[1]))).size<2)throw new Error('Insufficient distributed world placement');
}catch(error){report.failure=String(error);report.last=await page.evaluate(()=>({loading:window.gameEngine?.getLoadingStatus?.(),water:window.qtDiag?.water?.stats?.()})).catch(()=>null);}
finally{await Promise.all(reads);fs.writeFileSync(`${output}/browser.json`,JSON.stringify(report,null,2));await browser.close();}
process.exit(report.failure||report.errors.length||report.gpuErrors.length?1:0);
