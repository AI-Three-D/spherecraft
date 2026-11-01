import { buildJunctionField } from '../../../core/world/water/buildJunctionField.js';
import { JunctionFieldRenderer, junctionFieldParams, junctionFieldRegionWgsl } from './JunctionFieldRenderer.prototype.js';

const norm=v=>{const n=Math.hypot(...v);return v.map(x=>x/n);};
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];

function junctionSpec(w,{riverId,sign,spacingM,width}) {
    const rec=w._appliedRivers.get(riverId);
    if(!rec)throw new Error('Refine the prototype river before installation');
    const mouth=rec.mouths.find(m=>m.sign===sign),arc=w._arcLengths(rec),P=rec.points,st=rec.stride;
    if(!mouth)throw new Error('Missing junction anchor');
    let k=0;while(k+2<arc.length&&arc[k+1]<mouth.s)k++;
    const t=(mouth.s-arc[k])/(arc[k+1]-arc[k]);
    const c=norm([0,1,2].map(j=>P[k*st+j]+(P[(k+1)*st+j]-P[k*st+j])*t));
    const tangent=norm([0,1,2].map(j=>P[(k+1)*st+j]-P[k*st+j]));
    const e2=norm(cross(c,tangent)),e1=norm(cross(e2,c));
    const frame={c,e1,e2,width,height:width,spacingM,x0:-(width-1)*spacingM/2,y0:-(width-1)*spacingM/2};
    return {frame,lakeId:sign<0?rec.src:rec.dest.id,referenceLevelM:mouth.level,riverId,sign};
}

function clusteredSpec(w,junctions,spacingM,paddingM=192) {
    const specs=junctions.map(j=>junctionSpec(w,{...j,spacingM,width:257})),first=specs[0];
    if(specs.some(s=>s.lakeId!==first.lakeId))throw new Error('Prototype cluster requires one shared lake');
    const dot=(a,b)=>a.reduce((sum,v,i)=>sum+v*b[i],0);
    const c=norm([0,1,2].map(j=>specs.reduce((sum,s)=>sum+s.frame.c[j],0)));
    const axis=first.frame.e1,e1=norm(axis.map((v,j)=>v-c[j]*dot(axis,c))),e2=norm(cross(c,e1));
    const points=specs.map(s=>[w.R*dot(s.frame.c,e1)/dot(s.frame.c,c),w.R*dot(s.frame.c,e2)/dot(s.frame.c,c)]);
    const x0=Math.floor((Math.min(...points.map(p=>p[0]))-paddingM)/spacingM)*spacingM;
    const y0=Math.floor((Math.min(...points.map(p=>p[1]))-paddingM)/spacingM)*spacingM;
    const width=1+Math.ceil((Math.max(...points.map(p=>p[0]))+paddingM-x0)/spacingM);
    const height=1+Math.ceil((Math.max(...points.map(p=>p[1]))+paddingM-y0)/spacingM);
    return {...first,junctions,frame:{c,e1,e2,x0,y0,width,height,spacingM}};
}

export async function junctionPrototype({riverId=456,sign=-1,junctions=null,spacingM=2,width=257,blendRadiusM=64}={}) {
    const g=window.gameEngine,w=g.waterGpuData,gen=g.terrainGenerator;
    const spec=junctions?clusteredSpec(w,junctions,spacingM):junctionSpec(w,{riverId,sign,spacingM,width}),{frame,lakeId,referenceLevelM}=spec;
    const start=performance.now(),sampler=g.waterService._sampler;
    const field=await buildJunctionField({device:w.device,resources:w.resources,sampler:gen._lakeMaskSampler,
        radiusM:w.R,frame,lakeId,lakeBasin:w._applied.get(lakeId),referenceLevelM,sampleNatural:sampler.sampleDirsNatural,
        sampleCarved:sampler.sampleDirsCarved,blendRadiusM,lakewardSign:spec.sign,solveOptions:{bedScreening:.04,iterations:6000}});
    const buildMs=performance.now()-start;
    const params=junctionFieldParams(frame,w.R);
    const fieldBuffer=await window.__junctionPrototype.upload(w.device,params,field.field);
    const near=g.renderer.nearWaterRenderer;near._ensure();
    for(const m of [near._lakeMaterial,near._riverMaterial]) {
        m.fragmentShader+=junctionFieldRegionWgsl(3);
        m.fragmentShader=m.fragmentShader.replace(/(@fragment\s+fn main\([^]*?\{)/,'$1\nif(junctionFieldContains(in.wp,U.origin)){discard;}');
        while(m.bindGroupLayoutSpec.length<3)m.bindGroupLayoutSpec.push({label:'JunctionEmpty',entries:[]});
        m.bindGroupLayoutSpec.push({label:'JunctionExclusion',entries:[{binding:0,visibility:'fragment',name:'junctionFieldU',buffer:{type:'uniform'}}]});
        m.uniforms.junctionFieldU={value:params};m._needsCompile=true;
    }
    const renderer=new JunctionFieldRenderer({backend:near.backend,uniformManager:near.uniformManager,
        planetConfig:near.planetConfig,water:w,field,fieldBuffer,apFade:near.apFade});
    const render=near.render;near.render=function(...args){render.apply(this,args);renderer.render(...args);};
    window.__junctionField={field,renderer,params,spec};
    const n=g.renderer.quadtreeTileManager.tileStreamer.regenerateTiles(()=>true);
    await new Promise(r=>setTimeout(r,100));
    await(await import('../waterStepReview/qualityScene.js')).settle(300000);
    return {riverId,junctions,lakeId,frame,iterations:field.iterations,residualM:field.residualM,converged:field.converged,
        buildMs,elapsedMs:performance.now()-start,regenerated:n,level:[Math.min(...field.levelGuide),Math.max(...field.levelGuide)]};
}

export async function junctionPrototypeData() {
    const f=window.__junctionField?.field;if(!f)return null;
    const {frame}=f,R=gameEngine.waterGpuData.R,dirs=new Float32Array(f.width*f.height*4);
    for(let y=0;y<f.height;y++)for(let x=0;x<f.width;x++) {
        const px=frame.x0+x*frame.spacingM,py=frame.y0+y*frame.spacingM;
        dirs.set(norm(frame.c.map((v,j)=>v+(frame.e1[j]*px+frame.e2[j]*py)/R)),4*(y*f.width+x));
    }
    const sampled=await gameEngine.waterService._sampler.sampleDirsCarved(dirs);
    return {stats:window.__junctionStats,frame:f.frame,field:Array.from(f.field),natural:Array.from(f.natural),
        oldBed:Array.from(f.oldBed),levelGuide:Array.from(f.levelGuide),bedGuide:Array.from(f.bedGuide),
        fixedLevel:Array.from(f.fixedLevel),fixedBed:Array.from(f.fixedBed),sampled:Array.from(sampled)};
}

// Same-page comparisons avoid repeated startup solves and changing daylight.
export async function rebuildJunctionPrototype({riverId=null,sign=-1,junctions=null,lakeId=null,referenceLevelM=null,
    spacingM=2,width=257,blendRadiusM=64,bedScreening=.04}={}) {
    const g=gameEngine,w=g.waterGpuData,state=window.__junctionField,render=g.render;
    const spec=junctions?clusteredSpec(w,junctions,spacingM):riverId==null?state.spec:junctionSpec(w,{riverId,sign,spacingM,width});
    lakeId??=spec.lakeId;referenceLevelM??=spec.referenceLevelM;
    const frame=junctions?spec.frame:{...(spec.frame??state.field.frame),width,height:width,spacingM};
    const previous={field:state.field,spec:state.spec,params:state.params.slice()};
    const start=performance.now();g.render=async()=>{};
    try {
        while(g._renderInFlight)await new Promise(r=>setTimeout(r,5));
        await w.device.queue.onSubmittedWorkDone();
        const off=state.params.slice();off[15]=0;
        await window.__junctionPrototype.upload(w.device,off,state.field.field);
        const {buildJunctionField:build}=await import('../../../core/world/water/buildJunctionField.js?prototype=3');
        const sampler=g.waterService._sampler;
        const field=await build({device:w.device,resources:w.resources,sampler:g.terrainGenerator._lakeMaskSampler,
            radiusM:w.R,frame,lakeId,lakeBasin:w._applied.get(lakeId),referenceLevelM,sampleNatural:sampler.sampleDirsNatural,
            sampleCarved:sampler.sampleDirsCarved,blendRadiusM,lakewardSign:spec.sign??-1,solveOptions:{iterations:6000,bedScreening}});
        if(!field.converged)throw new Error('Prototype junction solve did not converge');
        const params=junctionFieldParams(frame,w.R);
        const buffer=await window.__junctionPrototype.upload(w.device,params,field.field);
        state.renderer.material.storageBuffers.junctionField=buffer;state.renderer.params.set(params);state.params.set(params);
        state.renderer.geometry.setIndex((await import('../../../core/renderer/water/waterGrid.js')).gridIndices(field.width,field.height));
        state.field=field;state.spec={...spec,frame,lakeId,referenceLevelM};
        window.__junctionStats={riverId:state.spec.riverId,junctions:state.spec.junctions,lakeId,referenceLevelM,frame,buildMs:performance.now()-start,
            converged:field.converged,residualM:field.residualM,iterations:field.iterations};
    } catch(error) {
        const buffer=await window.__junctionPrototype.upload(w.device,previous.params,previous.field.field);
        state.renderer.material.storageBuffers.junctionField=buffer;state.renderer.params.set(previous.params);state.params.set(previous.params);
        state.field=previous.field;state.spec=previous.spec;
        state.renderer.geometry.setIndex((await import('../../../core/renderer/water/waterGrid.js')).gridIndices(state.field.width,state.field.height));
        throw error;
    } finally {g.render=render;}
    g.renderer.quadtreeTileManager.tileStreamer.regenerateTiles(()=>true);
    await new Promise(r=>setTimeout(r,100));await(await import('../waterStepReview/qualityScene.js')).settle(300000);
    return window.__junctionStats;
}
