/* global process */
import fs from 'node:fs';
import {createRequire} from 'node:module';
const req=createRequire(new URL('../../../terrain-lab/package.json',import.meta.url));
const {default:puppeteer}=await import(req.resolve('puppeteer-core'));
const output=process.env.SHAPE_OUTPUT??'tools/perf/structured-terrain-results/natural-basin';
fs.mkdirSync(output,{recursive:true});
const report={events:[],errors:[],views:[],runs:[],notes:[
    'Actual game materials, geometry, final micro, water and streaming. Same camera poses and sun rotation in each mode.',
    'Original mode retains shared macro roots; dry mode adds only the authoritative local shape; wet adds bounded below-water deepening and micro limits.',
    'Browser startup timings are sequential processes with uncontrolled driver caches. They are not controlled cold/warm comparisons.',
]};
const browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless:'new',defaultViewport:{width:1280,height:900},protocolTimeout:120000,
    args:['--enable-gpu','--no-first-run','--no-default-browser-check']});
const page=await browser.newPage();let mode='wet';let lighting;const poses=[];
page.on('pageerror',e=>report.errors.push({mode,message:String(e)}));
page.on('console',m=>{if(m.text().startsWith('[ShapeProbe]')||m.type()==='error')report.events.push({mode,type:m.type(),message:m.text()});});
await page.evaluateOnNewDocument(()=>{
    const old=GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice=async function(...args){
        const device=await old.apply(this,args);
        const memory={liveBytes:0,peakBytes:0,createdBytes:0,unknownFormats:{}};
        const formats={r8unorm:1,r8uint:1,rg8unorm:2,rgba8unorm:4,'rgba8unorm-srgb':4,bgra8unorm:4,'bgra8unorm-srgb':4,
            r16float:2,rg16float:4,rgba16float:8,r32float:4,r32uint:4,rg32float:8,rgba32float:16,depth32float:4,
            depth24plus:4,'depth24plus-stencil8':4,rgb10a2unorm:4};
        for(const method of ['createBuffer','createTexture']) {
            const create=device[method].bind(device);
            device[method]=desc=>{
                const resource=create(desc);let bytes=desc.size;
                if(method==='createTexture') {
                    const a=Array.isArray(desc.size)?desc.size:[desc.size.width,desc.size.height??1,desc.size.depthOrArrayLayers??1];
                    bytes=0;
                    if(!formats[desc.format]) memory.unknownFormats[desc.format]=(memory.unknownFormats[desc.format]??0)+1;
                    for(let mip=0;mip<(desc.mipLevelCount??1);mip++) bytes+=Math.max(1,a[0]>>mip)*Math.max(1,(a[1]??1)>>mip)
                        *Math.max(1,desc.dimension==='3d'?(a[2]??1)>>mip:(a[2]??1))*(formats[desc.format]??0)*(desc.sampleCount??1);
                }
                memory.liveBytes+=bytes;memory.createdBytes+=bytes;memory.peakBytes=Math.max(memory.peakBytes,memory.liveBytes);
                const destroy=resource.destroy.bind(resource);let freed=false;
                resource.destroy=()=>{if(!freed){memory.liveBytes-=bytes;freed=true;}destroy();};return resource;
            };
        }
        device._structuredMemory=memory;
        device.lost.then(info=>console.log('[ShapeProbe]',JSON.stringify({event:'lost',reason:info.reason,message:info.message,atMs:performance.now()})));
        device.addEventListener('uncapturederror',e=>console.log('[ShapeProbe]',JSON.stringify({event:'validation',message:e.error.message,atMs:performance.now()})));
        return device;
    };
});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const modes=process.argv.includes('--grid-comparison')?['index64','index512']:process.argv.includes('--pool-comparison')?['compact','legacy']:process.argv.includes('--surface-comparison')?['surface','wet']:['wet','original','dry'];
const captures=process.argv.includes('--overview-only')?[[3,'distant']]:['setting','closer','shore','distant'].map((label,i)=>[i,label]);
try {
    for(mode of modes) {
        const query={index64:'regionalBasins=1&regionalShape=1&waterIndex=64',index512:'regionalBasins=1&regionalShape=1&waterIndex=512',compact:'regionalBasins=1&regionalShape=1',legacy:'regionalBasins=1&regionalShape=1&waterPools=legacy',surface:'regionalBasins=1&regionalShape=1',wet:'regionalBasins=1&regionalShape=1'+(modes[0]==='surface'?'&regionalSurface=0':''),original:'regionalBasins=reference&regionalShape=reference',dry:'regionalBasins=reference&regionalShape=dry'}[mode];
        const region=process.env.SHAPE_REGION?'&shapeRegion='+encodeURIComponent(process.env.SHAPE_REGION):'';
        const enclosure=process.env.SHAPE_ENCLOSURE!=null?'&shapeEnclosure='+encodeURIComponent(process.env.SHAPE_ENCLOSURE):'';
        const extra=Object.entries({SHAPE_RADIUS:'shapeRadius',SHAPE_POTENTIAL:'shapePotential',SHAPE_MIN_LEVEL:'shapeMinLevel',
            SHAPE_SURFACE:'shapeSurface',SHAPE_RISES:'shapeRises',SHAPE_MIN_WET:'shapeMinWet'}).filter(([key])=>process.env[key]!=null)
            .map(([key,query])=>'&'+query+'='+encodeURIComponent(process.env[key])).join('');
        await page.goto(`http://localhost:8181/wizard_game/standalone.html?regionalTerrain=256&${query}&shapeCells=${Number(process.env.SHAPE_CELLS??128)}${region}${enclosure}${extra}${process.argv.includes('--depression')?'&regionalDepression=1':''}`,{waitUntil:'domcontentloaded',timeout:120000});
        await page.waitForFunction(()=>window.gameEngine?.waterService?.state==='ready',{timeout:120000});
        const run=await page.evaluate(()=>({mode:null,waterReadyAtMs:performance.now(),initialLoadComplete:window.gameEngine.isInitialLoadComplete(),
            roots:window.gameEngine.terrainGenerator.regionalTerrain.timings,water:window.gameEngine.waterService.timings}));
        run.mode=mode;report.runs.push(run);
        await page.waitForFunction(()=>window.gameEngine?.waterGpuData?._ready,{timeout:120000});
        run.gpuPublicationAtMs=await page.evaluate(()=>performance.now());
        run.publishedSurface=await page.evaluate(()=>{
            const g=window.gameEngine,w=g.waterGpuData;
            return {depthRangeM:w._table[15],cpuFieldBytes:g.terrainGenerator.regionalTerrain.shapeData?.cpuBytes??0,
                pools:{gridN:w.N,maskSize:w.S,maskLayers:w.maxLayers,maxLakes:w.maxLakes,maxRiverSegs:w.maxRiverSegs,maxRiverCells:w.maxRiverCells,valley:!!w.valley}};
        });
        await page.waitForFunction(()=>window.gameEngine?.isInitialLoadComplete(),{timeout:120000});
        if(process.argv.includes('--large'))await page.evaluate(()=>{document.getElementById('game-ui').style.visibility='hidden';});
        run.initialLoadCompleteAtMs=await page.evaluate(()=>performance.now());
        if(mode===modes[0]) {
            lighting=await page.evaluate(()=>window.qtDiag.regional.daylight());
            run.lighting=lighting;
            await page.evaluate(()=>window.qtDiag.regional.basin());
        } else {
            await page.evaluate(rotation=>{
                const s=window.gameEngine.starSystem;s.paused=true;s.useGameTimeRotation=false;s.currentBody.currentRotation=rotation;
            },lighting.rotation);
            await page.evaluate(p=>window.qtDiag.regional.useCamera(p),poses.find(Boolean));
        }
        await sleep(12000);
        for(const [i,label] of captures) {
            if(mode===modes[0]) {
                await page.evaluate(async ({view,large})=>{
                    const g=window.gameEngine,l=g.waterService.lakes[0],R=g.planetConfig.radius;
                    const o=g.planetConfig.origin??{x:0,y:0,z:0},p=window.qtDiag.regional.camera();
                    let [altitude,back]=[[900,1000],[140,220],[12,85],[1400,2000]][view];
                    if(large)[altitude,back]=[[1000,700],[250,600],[12,85],[1900,250]][view];
                    let axis=l.frame.e2.map(v=>-v);
                    if(new URLSearchParams(location.search).has('shapeRegion')) {
                        const s=g.terrainGenerator.regionalTerrain.shapeData,so=s.options;
                        const {dirToFaceUV}=await import('/core/world/hydrology/waterGraph.js');
                        const {sampleRegionalShape}=await import('/core/world/terrain-generator/regionalShapeModel.js');
                        const heightAt=(a,distance)=>{
                            const d=l.frame.c.map((v,k)=>v+a[k]*distance/R),len=Math.hypot(...d);
                            const q=dirToFaceUV(d.map(v=>v/len)),grid=2**so.depth;
                            const x=(q.u*grid-so.x)*so.cells,y=(q.v*grid-so.y)*so.cells;
                            if(q.face!==so.face||x<0||y<0||x>=so.cells||y>=so.cells)return Infinity;
                            return sampleRegionalShape(s.controls,so.cells,x,y);
                        };
                        if(!window._shapeViewAxis) {
                            let best=Infinity;const reach=Math.max(25,Math.min(85,s.basin.radiusM*.85));
                            for(let j=0;j<8;j++) {
                                const a=l.frame.e1.map((v,k)=>v*Math.cos(j*Math.PI/4)+l.frame.e2[k]*Math.sin(j*Math.PI/4));
                                let required=12;
                                for(const t of [.25,.5,.75,1]) required=Math.max(required,(heightAt(a,reach*t)-l.level+30)/t);
                                if(required<best){best=required;window._shapeViewAxis=a;}
                            }
                        }
                        axis=window._shapeViewAxis??axis;
                        if(view===2)back=Math.max(25,Math.min(85,s.basin.radiusM*.85));
                        if(view===3)back=250; // overhead distance view clears foreground massifs
                        if(large&&view===2)back=s.basin.radiusM*.75;
                        // Keep the comparison camera and its line of sight
                        // above terrain; this changes poses, never generation.
                        if(view===1||view===2) for(const t of [.25,.5,.75,1]) {
                            const h=heightAt(axis,back*t);
                            if(Number.isFinite(h))altitude=Math.max(altitude,(h-l.level+30)/t);
                        }
                    }
                    ['x','y','z'].forEach((a,k)=>{p.position[a]=o[a]+l.frame.c[k]*(R+l.level+altitude)+axis[k]*back;
                        p.target[a]=o[a]+l.frame.c[k]*(R+l.level);p.up[a]=l.frame.c[k];});
                    window.qtDiag.regional.useCamera(p);
                },{view:i,large:process.argv.includes('--large')});
                poses[i]=await page.evaluate(()=>window.qtDiag.regional.camera());
            } else await page.evaluate(p=>window.qtDiag.regional.useCamera(p),poses[i]);
            await sleep(6500);
            await page.screenshot({path:`${output}/${label}-${mode}.png`});
            report.views.push({mode,label,pose:poses[i],atMs:await page.evaluate(()=>performance.now())});
        }
        if(process.argv.includes('--flight')) run.flight=await page.evaluate(()=>window.runFastFlightTestMatrix({phaseMs:2000}));
        run.memory=await page.evaluate(()=>window.gameEngine.renderer.backend.device._structuredMemory);
    }
} finally {fs.writeFileSync(`${output}/${process.argv.includes('--overview-only')?'overview-browser':'browser'}.json`,JSON.stringify(report,null,2));await browser.close();}
console.log(JSON.stringify({errors:report.errors,events:report.events,runs:report.runs},null,2));
process.exit(report.errors.length||report.events.some(e=>/"event":"(lost|validation)"/.test(e.message))?1:0);
