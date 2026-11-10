/* global process */
import fs from 'node:fs';import {createRequire} from 'node:module';import crypto from 'node:crypto';
const req=createRequire(new URL('../../../terrain-lab/package.json',import.meta.url));const {default:puppeteer}=await import(req.resolve('puppeteer-core'));
const baseline=process.argv.includes('--before');
const output=process.env.WATER_OUTPUT??'tools/perf/structured-terrain-results/water-final-attempt/game';fs.mkdirSync(output,{recursive:true});
const browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:'new',defaultViewport:{width:1280,height:900},protocolTimeout:180000,args:['--enable-gpu','--no-first-run','--no-default-browser-check']});
const page=await browser.newPage(),report={url:'http://localhost:8181/wizard_game/standalone.html',browser:await browser.version(),errors:[],gpuErrors:[],resources:[],sources:[],views:[]},reads=[];
page.on('pageerror',e=>report.errors.push(String(e)));page.on('console',m=>{if(m.text().startsWith('[PlanetWaterGPU]'))report.gpuErrors.push(m.text());});
page.on('response',r=>{const pathname=new URL(r.url()).pathname;if(r.status()>=400)report.resources.push({pathname,status:r.status()});if(/\.(js|html)$/.test(pathname))reads.push(r.text().then(v=>{
 report.sources.push({pathname,sha256:crypto.createHash('sha256').update(v).digest('hex')});
 const p=`${output}/served${pathname}`;fs.mkdirSync(p.slice(0,p.lastIndexOf('/')),{recursive:true});fs.writeFileSync(p,v);
}));});
if(baseline){await page.setRequestInterception(true);page.on('request',r=>{const p='tools/perf/structured-terrain-results/water-final-attempt/sources/before'+new URL(r.url()).pathname;if(fs.existsSync(p)&&fs.statSync(p).isFile())r.respond({status:200,contentType:'text/javascript',body:fs.readFileSync(p)});else r.continue();});}
await page.evaluateOnNewDocument(()=>{const request=GPUAdapter.prototype.requestDevice;GPUAdapter.prototype.requestDevice=async function(...args){const d=await request.apply(this,args);d.addEventListener('uncapturederror',e=>console.log('[PlanetWaterGPU]',e.error.message));d.lost.then(e=>console.log('[PlanetWaterGPU]',e.reason,e.message));return d;};});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try{
 await page.goto(report.url,{waitUntil:'domcontentloaded',timeout:180000});
 await page.waitForFunction(()=>window.gameEngine?.waterGpuData?._ready,{timeout:180000});
 report.waterReadyMs=await page.evaluate(()=>performance.now());
 report.world=await page.evaluate(()=>{const g=window.gameEngine,r=g.terrainGenerator.regionalTerrain;return{options:r.worldConfig,regions:r.shapeData.patches.length,residentMasks:g.waterGpuData._layerOf.size,residentRivers:g.waterGpuData._inGpu.size,lakes:r.basins.map(b=>({id:b.id,centre:b.centre,radiusM:b.radiusM,levelM:b.levelM,shape:!!b.shapeProof,tier:r.shapeData.patches.find(p=>p.basins.some(v=>v.id===b.id)).parent.tier??'legacy',wetAreaM2:(b.surfaceDepthMask??b.mask).reduce((s,v)=>s+(b.surfaceDepthMask?v>128:v>0),0)*b.frame.spacing**2})),rivers:r.drainagePlan.rivers.map(v=>({id:v.id,fromLake:v.fromLake,dest:v.dest,lengthM:v.lengthM})),timings:r.timings,bytes:r.byteLength,carveVersion:g.terrainGenerator.waterCarveVersion,initialStatus:g.renderer.quadtreeTileManager?.getInitialLoadStatus?.(),service:g.waterService.stats};});
 await page.waitForFunction(()=>window.gameEngine?.getLoadingStatus?.()?.complete,{timeout:180000});
 report.initialTerrainMs=await page.evaluate(()=>performance.now());
 report.bootStatus=await page.evaluate(()=>window.gameEngine.getLoadingStatus());
 const cases=process.argv.includes('--config-only')?[]:await page.evaluate(()=>{const r=window.gameEngine.terrainGenerator.regionalTerrain;
  const lakes=r.basins.slice().sort((a,b)=>{const area=v=>(v.surfaceDepthMask??v.mask).reduce((s,q)=>s+(v.surfaceDepthMask?q>128:q>0),0)*v.frame.spacing**2;return area(b)-area(a);});
  const cases=[{label:'largest-lake',kind:'lake',id:lakes[0].id},{label:'largest-shore',kind:'shore',id:lakes[0].id},{label:'small-lake',kind:'lake',id:lakes[Math.floor(lakes.length*.7)].id}];
  {const temperate=r.shapeData.patches.filter(p=>p.parent.tier==='large'&&Math.abs(p.basin.centre[1])<.6).map(p=>p.basin).sort((a,b)=>b.radiusM-a.radiusM)[0];if(temperate)cases.push({label:'temperate-large-lake',kind:'lake',id:temperate.id},{label:'temperate-large-shore',kind:'shore',id:temperate.id});const medium=r.shapeData.patches.filter(p=>p.parent.tier==='medium'&&Math.abs(p.basin.centre[1])<.6).map(p=>p.basin).sort((a,b)=>b.radiusM-a.radiusM)[0];if(medium)cases.push({label:'medium-lake',kind:'lake',id:medium.id});}
  const rugged=r.shapeData.patches.find(p=>!p.parent.gentle&&p.basin);if(rugged)cases.push({label:'rugged-lake',kind:'lake',id:rugged.basin.id});
  const river=r.drainagePlan.rivers.find(v=>v.lengthM>800&&v.course?.portals);if(river)cases.push(...[{label:'upstream-mouth',fraction:.015},{label:'downstream-mouth',fraction:.985},{label:'river-close',fraction:.45}].map(c=>({...c,kind:'river',id:river.id})));
  const steep=r.drainagePlan.rivers.slice().sort((a,b)=>b.profile.maxSlope-a.profile.maxSlope)[0];if(steep)cases.push({label:'steep-close',kind:'river',id:steep.id,fraction:.45,back:32,alt:18});return cases;});
 for(const c of cases){
  const start=Date.now(),frame=await page.evaluate(()=>window.gameEngine.renderer.quadtreeTileManager.quadtreeGPU._frameCount),pose=await page.evaluate(c=>{
   const g=window.gameEngine,r=g.terrainGenerator.regionalTerrain,R=g.planetConfig.radius,o=g.planetConfig.origin,axes=['x','y','z'];let d,h,back,alt,along;
   document.getElementById('game-ui').style.visibility='hidden';
   if(c.kind==='lake'||c.kind==='shore'){const b=g.waterService.lakes.find(b=>b.id===c.id);d=b.centreDir;h=b.level;back=r.basins.find(b=>b.id===c.id).radiusM*1.8;alt=back*.8;along=b.frame.e2;
    if(c.kind==='shore'){const v=r.basins.find(b=>b.id===c.id),f=v.frame;let pick=-1,best=Infinity;for(let j=1;j<f.ny-1;j++)for(let i=1;i<f.nx-1;i++){const k=j*f.nx+i,m=v.surfaceDepthMask;if(m[k]>130&&[k-1,k+1,k-f.nx,k+f.nx].some(q=>m[q]<128)){const score=Math.abs(i-f.nx*.5)+Math.abs(j-f.ny*.7);if(score<best){best=score;pick=k;}}}if(pick<0)throw new Error('No diagnostic shoreline');const x=f.x0+(pick%f.nx+.5)*f.spacing,y=f.y0+(Math.floor(pick/f.nx)+.5)*f.spacing;d=f.c.map((q,i)=>q+f.e1[i]*x/R+f.e2[i]*y/R);const norm=Math.hypot(...d);d=d.map(v=>v/norm);along=f.e1;back=180;alt=100;}
   }
   else{const rec=r.drainagePlan.rivers.find(v=>v.id===c.id),k=Math.max(1,Math.min(rec.points.length/rec.stride-2,Math.floor(rec.points.length/rec.stride*(c.fraction??.45)))),a=k*rec.stride;d=Array.from(rec.points.slice(a,a+3));h=rec.points[a+3];const delta=d.map((_,i)=>rec.points[a+rec.stride+i]-rec.points[a-rec.stride+i]),len=Math.hypot(...delta);along=delta.map(v=>v/len);back=c.back??75;alt=c.alt??65;}
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
  if(c.label==='river-close'||c.label==='steep-close')await sleep(10000);
  const state=await page.evaluate(async()=>{
   const g=window.gameEngine,m=g.renderer.quadtreeTileManager,device=g.renderer.backend.device;while(g._renderInFlight)await new Promise(requestAnimationFrame);
   const restore={update:g.update,render:g.render};g.update=()=>{};g.render=()=>{};await device.queue.onSubmittedWorkDone();
   const wall=[];for(let i=0;i<40;i++){const t=performance.now();await restore.render.call(g,0);await device.queue.onSubmittedWorkDone();if(i>=10)wall.push(performance.now()-t);}
   let simulation=null;const sim=g.waterRiverSim;if(sim?.state==='running'&&sim.fade>.99){const st=await sim.sim.readState();let wet=0,foam=0,negative=0,nonfinite=0;for(let k=0;k<st.length;k+=4){if(st[k]>.02){wet++;foam+=st[k+3];}if(st[k]<0)negative++;if(!Array.from(st.subarray(k,k+4)).every(Number.isFinite))nonfinite++;}simulation={wet,meanFoam:foam/Math.max(1,wet),negative,nonfinite,timeS:sim.sim.time};}
   g.update=restore.update;g.render=restore.render;
   return{simulation,coverage:m.getInitialLoadStatus(),selected:m._lastVisibleTiles.map(t=>`f${t.face}:d${t.depth}:${t.x},${t.y}`).sort(),regeneration:m.tileStreamer.getRegenerationStats?.(),waterVersion:g.waterGpuData._appliedVersion,regionalVersion:g.terrainGenerator.regionalTerrain.version,regionalKey:g.terrainGenerator.regionalTerrain.sourceKey,
    sim:window.qtDiag.water.sim(),fullRenderFenceMs:wall};
  });
  if(state.coverage.exactVisibleRatio!==1||state.coverage.pendingGenerations||state.coverage.activeGenerations||state.coverage.pendingCopies)throw new Error('Residency changed during render measurement; reject this view');
  await page.screenshot({path:`${output}/${c.label}.png`});report.views.push({...c,pose,readinessMs,state});console.log(JSON.stringify({view:c.label,readinessMs}));
 }
 if(report.world.lakes.length<1000||report.world.rivers.length<150||report.world.residentMasks!==report.world.lakes.length||report.world.residentRivers!==report.world.rivers.length||new Set(report.world.lakes.map(b=>Math.sign(b.centre[0])*10+Math.sign(b.centre[1]))).size<2)throw new Error('Insufficient distributed world placement');
}catch(error){report.failure=String(error);report.last=await page.evaluate(()=>({loading:window.gameEngine?.getLoadingStatus?.(),water:window.qtDiag?.water?.stats?.()})).catch(()=>null);}
finally{await Promise.all(reads);fs.writeFileSync(`${output}/browser.json`,JSON.stringify(report,null,2));await browser.close();}
process.exit(report.failure||report.errors.length||report.gpuErrors.length?1:0);
