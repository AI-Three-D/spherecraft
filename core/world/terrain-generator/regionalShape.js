import {createAdvancedTerrainComputeShader} from '../shaders/webgpu/advancedTerrainCompute.wgsl.js';
import {createRegionalShapeBakeWgsl} from './regionalShape.wgsl.js';
import {regionalComputePipelines} from './regionalPipelines.js';
import {planRegionalShapeLake,sampleRegionalShape,regionalShapeBounds} from './regionalShapeModel.js';
import {encodeLakeSurfaceDepth} from '../water/lakeSurfaceField.js';
import {faceUVToDir,dirToFaceUV} from '../hydrology/waterGraph.js';
import {tangentBasis,planeToDir} from '../hydrology/lakeRefine.js';
import {regionalDepression} from './regionalDepression.js';

// Explicit canonical address for reproducible diagnostic comparisons. The
// same bounded options validation applies to browser and native workloads.
export function regionalShapeAddress(value) {
    if(value==null) return {};
    if(!/^\d+,\d+,\d+,\d+$/.test(value)) throw new Error('shapeRegion must be face,depth,x,y');
    const [face,depth,x,y]=value.split(',').map(Number),address={face,depth,x,y};
    regionalShapeOptions({enabled:true,...address});return address;
}

export function regionalShapeOptions(options) {
    if(options?.enabled!==true) return null;
    const out={enabled:true,cells:128,face:3,depth:7,x:108,y:69,guardCells:8,minLevelM:500,surfaceDepth:true,minimumEnclosureM:30,
        maxRadiusM:140,maxCandidates:4,maxPotentialCells:512,risesM:[2,4,6,8,.5,.75,1],surfaceCells:64,minWetCells:0,
        multipleLakes:1,bedCutM:1.5,bedTransitionM:.5,depthM:1.5,rimM:.5,microLimitM:.25,numericalM:.125,...options};
    const grid=2**out.depth;
    if(![64,128,256].includes(out.cells)||![3,4,5,6,7,8].includes(out.depth)||!Number.isInteger(out.face)||out.face<0||out.face>5
        ||['x','y'].some(k=>!Number.isInteger(out[k])||out[k]<1||out[k]>=grid-1)
        ||!Number.isInteger(out.multipleLakes)||out.multipleLakes<1||out.multipleLakes>16
        ||out.guardCells!==8||!Number.isInteger(out.maxCandidates)||out.maxCandidates<1||out.maxCandidates>8
        ||!Number.isInteger(out.maxPotentialCells)||out.maxPotentialCells<64||out.maxPotentialCells>65536
        ||![64,128,256].includes(out.surfaceCells)||!Array.isArray(out.risesM)||out.risesM.length<1||out.risesM.length>8
        ||out.risesM.some(h=>!Number.isFinite(h)||h<=0||h>40)
        ||!Number.isInteger(out.minWetCells)||out.minWetCells<0||out.minWetCells>out.maxPotentialCells
        ||['minLevelM','maxRadiusM','bedCutM','bedTransitionM','depthM','rimM','microLimitM','numericalM'].some(k=>!Number.isFinite(out[k])||out[k]<=0)
        ||!Number.isFinite(out.minimumEnclosureM)||out.minimumEnclosureM<0||out.minimumEnclosureM>100
        ||typeof out.surfaceDepth!=='boolean'||out.maxRadiusM>18000||out.bedCutM>3||out.bedTransitionM<.25||out.bedTransitionM>2
        ||out.microLimitM>.5||out.numericalM<.125) throw new Error('Invalid bounded regional shape options');
    if(out.receiverRegion) {
        const r=out.receiverRegion;
        if(!Number.isInteger(r.dx)||!Number.isInteger(r.dy)||Math.abs(r.dx)+Math.abs(r.dy)!==1
            ||out.x+r.dx<1||out.x+r.dx>=grid-1||out.y+r.dy<1||out.y+r.dy>=grid-1
            ||!Number.isFinite(r.minLevelM)||r.minLevelM<=0||r.minLevelM>out.minLevelM) {
            throw new Error('Invalid adjacent regional receiver address');
        }
    }
    if(out.depression) {
        const f=out.depression;
        if(out.receiverRegion||!Number.isFinite(f.radiusM)||f.radiusM<60||f.radiusM>11000
            ||!Number.isFinite(f.maxCutM)||f.maxCutM<=0||f.maxCutM>80||!Number.isFinite(f.depthM)||f.depthM<2||f.depthM>10
            ||!Number.isInteger(f.seed)||f.seed<0||f.seed>65535
            ||!['lobes','organic'].includes(f.profile??'lobes')
            ||!['current','previous'].includes(f.potentialVersion??'current'))throw new Error('Invalid bounded regional depression');
    }
    return out;
}

export async function createRegionalShapeData({device,gen,data,uniformBytes,options,waterEnabled}) {
    const o=regionalShapeOptions(options);
    if(!o.receiverRegion) return createSingleRegionalShapeData({device,gen,data,uniformBytes,options:o,waterEnabled});
    const started=performance.now(),regions=[];let texture,params;
    try {
        const source=await createSingleRegionalShapeData({device,gen,data,uniformBytes,options:{...o,receiverRegion:null},waterEnabled});
        regions.push(source);
        if(!source.basin) throw new Error('No certified source in regional connection');
        const r=o.receiverRegion;
        const receiver=await createSingleRegionalShapeData({device,gen,data,uniformBytes,options:{...o,receiverRegion:null,
            x:o.x+r.dx,y:o.y+r.dy,minLevelM:r.minLevelM,minimumEnclosureM:0},waterEnabled});
        regions.push(receiver);
        if(!receiver.basin) throw new Error('No certified receiver in adjacent regional field');
        receiver.basin.id=1;
        // Two canonical regions in one bounded generation-input atlas. Their
        // controls/halos and per-tile C2 guards stay identical to independent
        // generation. No render tile or camera cache supplies these heights.
        const x0=Math.min(o.x,receiver.options.x),y0=Math.min(o.y,receiver.options.y);
        const width=o.cells*(r.dx?2:1)+3,height=o.cells*(r.dy?2:1)+3;
        const packed=new Float32Array(width*height*4);
        for(const region of regions) {
            const plan=region.lakePlan,stride=o.cells+3,micro=new Uint8Array(stride*stride);
            for(let k=0;k<plan.region.length;k++) if(plan.region[k]) {
                const x=k%o.cells,y=Math.floor(k/o.cells);
                for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)for(let b=0;b<4;b++)for(let a=0;a<4;a++) {
                    micro[(y+dy+b)*stride+x+dx+a]=1;
                }
            }
            const ox=(region.options.x-x0)*o.cells,oy=(region.options.y-y0)*o.cells;
            for(let y=0;y<stride;y++)for(let x=0;x<stride;x++) {
                const k=y*stride+x,z=((y+oy)*width+x+ox)*4;
                packed[z]=region.controls[k];
                packed[z+1]=micro[k]+(x<o.cells&&y<o.cells&&plan.region[y*o.cells+x]?2:0);
                packed[z+2]=plan.levelM;
            }
        }
        texture=device.createTexture({label:'Adjacent authoritative regional shapes',size:[width,height],format:'rgba32float',
            usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.COPY_SRC});
        params=device.createBuffer({label:'Regional shape connection params',size:64,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
        const parameters=source.parameters.slice();parameters[2]=x0;parameters[3]=y0;
        parameters[12]=width-3;parameters[13]=height-3;parameters[14]=-1;
        device.queue.writeTexture({texture},packed,{bytesPerRow:width*16},[width,height]);device.queue.writeBuffer(params,0,parameters);
        await device.queue.onSubmittedWorkDone();
        for(const region of regions) region.destroy();
        const descriptors=regions.map(({options,parameters,controls,lakePlan,basin,minimumControlM,maximumControlM,
            maximumRootLower,cpuBytes,timings})=>({options,parameters,controls,lakePlan,basin,minimumControlM,maximumControlM,
            maximumRootLower,cpuBytes,timings}));
        return {...source,options:o,texture,params,parameters,regions:descriptors,basins:regions.map(r=>r.basin),
            byteLength:packed.byteLength+64,cpuBytes:regions.reduce((s,r)=>s+r.cpuBytes,0),
            timings:{totalMs:performance.now()-started,regions:regions.map(r=>r.timings),
                uploadBytes:regions.reduce((s,r)=>s+r.timings.uploadBytes,0)+packed.byteLength+64,
                readbackBytes:regions.reduce((s,r)=>s+r.timings.readbackBytes,0)},
            destroy(){texture.destroy();params.destroy();}};
    } catch(error) {for(const r of regions)r.destroy();texture?.destroy();params?.destroy();throw error;}
}

export async function createSingleRegionalShapeData({device,gen,data,uniformBytes,options,waterEnabled}) {
    const started=performance.now(),o=regionalShapeOptions(options),grid=2**o.depth,size=o.cells+3;
    const frameDir=(x,y)=>faceUVToDir(o.face,(o.x+x/o.cells)/grid,(o.y+y/o.cells)/grid);
    const texture=device.createTexture({label:'Authoritative regional eroded shape',size:[size,size],format:'rg32float',
        usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.COPY_SRC});
    const params=device.createBuffer({label:'Regional shape input params',size:64,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    const scratch=[];
    const buffer=(label,size,usage)=>{const b=device.createBuffer({label,size,usage});scratch.push(b);return b;};
    try {
        const source=createAdvancedTerrainComputeShader(gen._getAdvancedTerrainShaderOptions({regionalTerrain:true,
            regionalShape:false,regionalValleyFeature:false,waterCarve:false,riverValley:false}))+createRegionalShapeBakeWgsl();
        const compileStarted=performance.now();
        const {pipelines:[pipeline],cacheHit}=await regionalComputePipelines(device,source,['regionalShapeBakeMain']);
        const compileMs=performance.now()-compileStarted;
        const uniform=buffer('Shape source uniforms',uniformBytes.byteLength,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
        const bake=buffer('Shape bake address',32,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
        const output=buffer('Shape control output',size*size*4,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC);
        const readback=buffer('Shape control readback',size*size*4,GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ);
        device.queue.writeBuffer(uniform,0,uniformBytes);device.queue.writeBuffer(bake,0,new Float32Array([o.face,grid,o.x,o.y,o.cells,0,0,0]));
        const bakeStarted=performance.now(),enc=device.createCommandEncoder({label:'Regional shape generation'});
        const pass=enc.beginComputePass({label:'Regional eroded shape'});pass.setPipeline(pipeline);
        pass.setBindGroup(0,device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
            {binding:0,resource:{buffer:uniform}},{binding:6,resource:{buffer:bake}},
            {binding:7,resource:texture.createView()},{binding:8,resource:{buffer:output}},
        ]}));
        pass.setBindGroup(1,device.createBindGroup({layout:pipeline.getBindGroupLayout(1),entries:[]}));
        pass.setBindGroup(2,device.createBindGroup({layout:pipeline.getBindGroupLayout(2),entries:data.bindGroupEntries.filter(e=>e.binding<3)}));
        pass.dispatchWorkgroups(Math.ceil(size/8),Math.ceil(size/8));pass.end();
        enc.copyBufferToBuffer(output,0,readback,0,size*size*4);device.queue.submit([enc.finish()]);
        await readback.mapAsync(GPUMapMode.READ);const controls=new Float32Array(readback.getMappedRange()).slice();readback.unmap();
        const bakeReadbackMs=performance.now()-bakeStarted;
        // Convex blending/interpolation must also preserve the old ordinary
        // root bounds. Reject an incompatible field rather than silently
        // invalidating those contracts for unrelated terrain consumers.
        const x0=Math.floor(o.x/grid*data.cells),y0=Math.floor(o.y/grid*data.cells);
        const w=Math.ceil((o.x+1)/grid*data.cells)-x0,h=Math.ceil((o.y+1)/grid*data.cells)-y0;
        const rb=buffer('Shape root contract readback',256*h,GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ);
        const check=device.createCommandEncoder();check.copyTextureToBuffer({texture:data.lowerBounds,origin:[x0,y0,o.face]},
            {buffer:rb,bytesPerRow:256},[w,h,1]);device.queue.submit([check.finish()]);await rb.mapAsync(GPUMapMode.READ);
        const oldBounds=new Float32Array(rb.getMappedRange());let maximumRootLower=-Infinity;
        for(let j=0;j<h;j++) for(let i=0;i<w;i++) maximumRootLower=Math.max(maximumRootLower,oldBounds[j*64+i]);rb.unmap();
        const depressionInputs={controls,cells:o.cells,frameDir,tangentBasis,planeToDir,dirToFaceUV,
            face:o.face,grid,tileX:o.x,tileY:o.y,planetRadius:gen.planetConfig.radius,guardCells:o.guardCells,...o.depression};
        const depressions=[];
        if(o.depression&&o.multipleLakes===1)depressions.push(regionalDepression(depressionInputs));
        if(o.depression&&o.multipleLakes>1) {
            // Reuse one eroded supporting field. Individual bounded landforms
            // have disjoint support; their cut budgets never accumulate.
            const accepted=[];
            const proposals=[[.5,.5],...[.18,.39,.61,.82].flatMap(y=>[.18,.39,.61,.82].map(x=>[x,y]))];
            for(let i=0;i<proposals.length;i++) {
                const [x,y]=proposals[i],jitter=(phase)=>Math.sin(o.depression.seed*1.731+i*7.119+phase)*.035;
                const cx=x+jitter(0),cy=y+jitter(2.3);
                const radiusM=i===0?380+o.depression.seed%140:200+((o.depression.seed+i*53)%4)*35;
                const centre=frameDir(cx*o.cells,cy*o.cells);
                if(accepted.some(d=>gen.planetConfig.radius*Math.hypot(...d.centre.map((v,k)=>v-centre[k]))<1.65*(radiusM+d.radiusM)+70))continue;
                const d=regionalDepression({...depressionInputs,radiusM,seed:(o.depression.seed+depressions.length*331)%65536,centres:[[cx,cy]]});
                depressions.push(d);if(!d.rejected)accepted.push(d);
            }
        }
        const depression=depressions[0]??null;
        const minimumControlM=Math.min(...controls),maximumControlM=Math.max(...controls);
        if(!Number.isFinite(minimumControlM)||!Number.isFinite(maximumControlM)||Math.max(Math.abs(minimumControlM),Math.abs(maximumControlM))>10000)
            throw new Error('Invalid regional shape height range');
        if(minimumControlM-data.budgets.microM-(waterEnabled?o.bedCutM:0)-1<maximumRootLower) {
            const error=new Error('Regional shape cannot preserve existing root height bounds');
            error.timings={totalMs:performance.now()-started,compileMs,cacheHit,bakeReadbackMs,
                uploadBytes:uniformBytes.byteLength+32,readbackBytes:controls.byteLength+256*h};
            throw error;
        }
        const R=gen.planetConfig.radius;
        const radiusOfCells=(ids,core)=>{
            const c=frameDir(core%o.cells+.5,Math.floor(core/o.cells)+.5);let radius=0;
            for(const k of ids) for(const dx of [0,1]) for(const dy of [0,1]) {
                const d=frameDir(k%o.cells+dx,Math.floor(k/o.cells)+dy),dot=d.reduce((s,v,i)=>s+v*c[i],0);
                radius=Math.max(radius,R*Math.hypot(...d.map((v,i)=>v-c[i]*dot))/dot);
            }
            return radius+4;
        };
        const contextOfCells=(core,levelM,minimumEnclosureM)=>{
            const c=frameDir(core%o.cells+.5,Math.floor(core/o.cells)+.5),frame={c,...tangentBasis(c)},rings=[];
            for(const radiusM of [120,240]) {
                const riseM=[];
                for(let j=0;j<8;j++) {
                    const p=dirToFaceUV(planeToDir(Math.cos(j*Math.PI/4)*radiusM,Math.sin(j*Math.PI/4)*radiusM,frame,R));
                    const x=(p.u*grid-o.x)*o.cells,y=(p.v*grid-o.y)*o.cells;
                    riseM.push(p.face===o.face&&Math.min(x,y,o.cells-x,o.cells-y)>=o.guardCells
                        ?sampleRegionalShape(controls,o.cells,x,y)-levelM:null);
                }
                const valid=riseM.filter(h=>h!==null),opposing=[];
                for(let j=0;j<4;j++) if(riseM[j]!==null&&riseM[j+4]!==null) opposing.push(Math.min(riseM[j],riseM[j+4]));
                rings.push({radiusM,riseM,validSamples:valid.length,enclosingSectors:valid.filter(h=>h>=minimumEnclosureM*.75).length,
                    opposingRiseM:opposing.length?Math.max(...opposing):null});
            }
            return {kind:'sampled-regional-setting',rings};
        };
        const plans=[];
        if(o.multipleLakes===1)plans.push(planRegionalShapeLake({...o,controls,cells:o.cells,guardCells:o.guardCells+2,radiusOfCells,contextOfCells,
            levelsM:depression&&!depression.rejected?[depression.levelM]:[],
            candidateSeeds:depression&&!depression.rejected?[depression.seedCell]:[],candidateSeedsOnly:!!depression&&gen._regionalNaturalSeedScan!==true}));
        else {
            const boundsStarted=performance.now(),preparedBounds=regionalShapeBounds(controls,o.cells),boundsMs=performance.now()-boundsStarted;
            const excludedCells=new Uint8Array(o.cells*o.cells),seeds=depressions.filter(d=>!d.rejected).map(d=>({seed:d.seedCell,level:d.levelM}));
            const natural=[];
            for(let y=12;y<o.cells-12;y++)for(let x=12;x<o.cells-12;x++) {
                const k=y*o.cells+x,h=preparedBounds.centre[k];if(h<o.minLevelM)continue;
                let minimum=true;
                for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)if(preparedBounds.centre[k+dy*o.cells+dx]<h)minimum=false;
                if(minimum)natural.push(k);
            }
            natural.sort((a,b)=>preparedBounds.centre[a]-preparedBounds.centre[b]||a-b);
            seeds.push(...natural.slice(0,64).map(seed=>({seed})));
            let accepted=0;
            for(const {seed,level} of seeds) {
                if(accepted>=o.multipleLakes)break;if(excludedCells[seed])continue;
                const p=planRegionalShapeLake({...o,controls,preparedBounds,excludedCells,cells:o.cells,guardCells:o.guardCells+2,
                    maxCandidates:1,radiusOfCells,contextOfCells,candidateSeeds:[seed],candidateSeedsOnly:true,levelsM:level===undefined?[]:[level]});
                plans.push(p);if(p.rejected)continue;accepted++;
                for(let k=0;k<p.region.length;k++)if(p.region[k])for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++)excludedCells[k+dy*o.cells+dx]=1;
            }
            if(!plans.length)plans.push({rejected:true,attempts:[],timings:{totalMs:boundsMs,boundsMs}});
            plans[0].timings.boundsMs+=boundsMs;plans[0].timings.totalMs+=boundsMs;
        }
        const plan=plans.find(p=>!p.rejected)??plans[0],successful=plans.filter(p=>!p.rejected);
        const parameters=new Float32Array([o.face,grid,o.x,o.y,o.cells,o.guardCells,waterEnabled&&!plan.rejected?1:0,
            data.budgets.microM>0?Math.min(1,o.microLimitM/data.budgets.microM):1,plan.levelM??0,o.bedCutM,o.microLimitM,o.numericalM,
            minimumControlM,maximumControlM,o.depthM,o.bedTransitionM]);
        const ownership=new Uint8Array(o.cells*o.cells),levels=new Float32Array(o.cells*o.cells),micro=new Uint8Array(size*size);
        for(const p of successful) {
            for(let k=0;k<p.region.length;k++)if(p.region[k]){ownership[k]=1;levels[k]=p.levelM;}
            for(let k=0;k<micro.length;k++)if(p.microMask[k])micro[k]=1;
        }
        if(o.multipleLakes>1)parameters.set([o.cells,o.cells,-1,o.bedTransitionM],12);
        const packed=new Float32Array(size*size*2);
        for(let y=0;y<size;y++)for(let x=0;x<size;x++) {
            const k=y*size+x;packed[k*2]=controls[k];packed[k*2+1]=micro[k]+(x<o.cells&&y<o.cells&&ownership[y*o.cells+x]?2:0);
        }
        device.queue.writeTexture({texture},packed,{bytesPerRow:size*8},[size,size]);device.queue.writeBuffer(params,0,parameters);
        const basins=[];const surfaceStarted=performance.now();
        for(const plan of successful) {
            const centre=frameDir(plan.core%o.cells+.5,Math.floor(plan.core/o.cells)+.5),basis=tangentBasis(centre);
            const nx=o.surfaceCells,spacing=plan.radiusM*2/nx,frame={c:centre,...basis,x0:-plan.radiusM,y0:-plan.radiusM,spacing,nx,ny:nx};
            const mask=new Uint8Array(nx*nx);
            const surfaceDepthMask=o.surfaceDepth?new Uint8Array(nx*nx):null,surfaceDepthRangeM=16;
            for(let j=0;j<nx;j++) for(let i=0;i<nx;i++) {
                const d=planeToDir(frame.x0+(i+.5)*spacing,frame.y0+(j+.5)*spacing,frame,R),p=dirToFaceUV(d);
                const x=Math.floor((p.u*grid-o.x)*o.cells),y=Math.floor((p.v*grid-o.y)*o.cells);
                if(p.face===o.face&&x>=0&&y>=0&&x<o.cells&&y<o.cells&&plan.region[y*o.cells+x]) {
                    const k=j*nx+i;mask[k]=2;
                    if(surfaceDepthMask) {
                        const h=sampleRegionalShape(controls,o.cells,(p.u*grid-o.x)*o.cells,(p.v*grid-o.y)*o.cells);
                        const t=Math.max(0,Math.min(1,(plan.levelM-h)/o.bedTransitionM));
                        const cut=o.bedCutM*t*t*t*(t*(t*6-15)+10);
                        // Conservative scalar depth at this texel, allowing
                        // positive fine micro and numerical evaluation error.
                        surfaceDepthMask[k]=encodeLakeSurfaceDepth(plan.levelM-h+cut-o.microLimitM-o.numericalM,surfaceDepthRangeM);
                    }
                }
            }
            const basin={id:basins.length,centre,axis:basis.e1,radiusM:plan.radiusM,levelM:plan.levelM,depthM:o.depthM,rimM:o.rimM,
                lowerM:plan.levelM+plan.proof.minimumRimM,centreCutM:0,coreRadiusM:0,
                radialControls:Array.from({length:16},()=>[.2,.8]),frame,mask,surfaceDepthMask,surfaceDepthRangeM:surfaceDepthMask?surfaceDepthRangeM:0,
                shapeProof:plan.proof,shapeCore:plan.core,shapeSeed:plan.seed,settingContext:plan.context,closed:true};
            basins.push(basin);
        }
        await device.queue.onSubmittedWorkDone();
        const {microMask:_microMask,...lakePlan}=plan;
        const basin=basins[0]??null;
        const lakePlans=successful.map(({microMask:_mask,...p})=>p);
        return {options:o,texture,params,parameters,controls,lakePlan,lakePlans,basin,basins,ownership,levels,micro,depression,depressions,minimumControlM,maximumControlM,maximumRootLower,
            byteLength:size*size*8+64,cpuBytes:controls.byteLength+ownership.byteLength+levels.byteLength+micro.byteLength+successful.reduce((s,p)=>s+p.region.byteLength,0)+basins.reduce((s,b)=>s+b.mask.byteLength+(b.surfaceDepthMask?.byteLength??0),0)+64,
            timings:{totalMs:performance.now()-started,compileMs,cacheHit,bakeReadbackMs,planning:{totalMs:plans.reduce((s,p)=>s+p.timings.totalMs,0),boundsMs:plans.reduce((s,p)=>s+p.timings.boundsMs,0),trials:plans.length,accepted:successful.length},
                depression,depressions,surfacePublicationMs:performance.now()-surfaceStarted,
                uploadBytes:uniformBytes.byteLength+32+packed.byteLength+64,readbackBytes:controls.byteLength+256*h},
            destroy(){texture.destroy();params.destroy();}};
    } catch(error) {texture.destroy();params.destroy();throw error;}
    finally {for(const b of scratch) {if(b.mapState==='mapped') b.unmap();b.destroy();}}
}
