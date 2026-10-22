// Opt-in shared-coverage experiment. Production materials are cloned/restored.
import {dot,norm} from './contactGeometry.js';
import {connectTriangles,packCoverage,coverageWgsl} from './connectedTriangles.js';

export function patchQueries(code,{indexedOnly=false}={}) {
    const hit='fn waterLakeHitIn(slot: u32, dir: vec3<f32>, heightM: f32, samp: sampler, levelOnly: bool) -> WaterLakeHit {';
    const view='fn waterLakeHitView(dir: vec3<f32>, heightM: f32, samp: sampler, levelOnly: bool) -> WaterLakeHit {';
    if(!code.includes(hit)||!code.includes(view))throw new Error('Water lookup signatures changed');
    const insertion=indexedOnly?'    if (lake.surfaceDepthRangeM<=0.0 && heightM >= lake.level) { return miss; }':hit;
    if(!code.includes(insertion))throw new Error('Lake height rejection changed');
    code=code.replace(insertion,insertion+`
    if(slot==u32(connectedPatch[2].w)+1u) {
        let cc=connectedCoverage(dir);let level=connectedPatch[1].w;
        if(cc<0 || (cc>0 && heightM>=level)){return WaterLakeHit(WATER_NO_LAKE,0.0);}
        if(cc>0){return WaterLakeHit(level,level-heightM);}
    }`);
    if(indexedOnly)return code;
    return code.replace(view,view+`
    let cc=connectedCoverage(dir);let level=connectedPatch[1].w;
    if(cc>0 && heightM<level){return WaterLakeHit(level,level-heightM);}`);
}

export function terrainClone(b,original,buffer,{wgsl=coverageWgsl,patch=patchQueries}={}) {
    const m=original.clone();m._chunkTextureFormats=original._chunkTextureFormats;
    m.fragmentShader=wgsl(0,2)+patch(m.fragmentShader);
    const adapter=original.bindingAdapter;
    m.bindingAdapter={cacheKey:`connected-${original.id}`,createLayouts(backend) {
        const layouts=adapter.createLayouts(backend,original);
        layouts[0]=backend.device.createBindGroupLayout({entries:[
            {binding:0,visibility:GPUShaderStage.VERTEX,buffer:{type:'uniform'}},
            {binding:1,visibility:GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,buffer:{type:'uniform'}},
            {binding:2,visibility:GPUShaderStage.FRAGMENT,buffer:{type:'read-only-storage'}}]});return layouts;
    },createBindGroups(backend,material,uniforms,geo) {
        const groups=adapter.createBindGroups(backend,original,uniforms,geo),u=backend._getMaterialBindGroupCache(original).get('terrain_g0');
        // Diagnostic vertex export needs the same uniforms as the draw.
        // Buffer ownership remains with the original material.
        backend._getMaterialBindGroupCache(m).set('terrain_g0',u);
        groups[0]=backend.device.createBindGroup({layout:material._gpuPipeline.bindGroupLayouts[0],entries:[
            {binding:0,resource:{buffer:u.vert}},{binding:1,resource:{buffer:u.frag}},{binding:2,resource:{buffer}}]});return groups;
    }};
    return m;
}

export function nearClone(original,buffer,isLake,{wgsl=coverageWgsl,patch=patchQueries}={}) {
    const m=original.clone();
    m.bindGroupLayoutSpec=original.bindGroupLayoutSpec.map(g=>({...g,entries:[...g.entries]}));
    if(!m.bindGroupLayoutSpec[2])m.bindGroupLayoutSpec.push({label:'Connected coverage',entries:[]});
    m.bindGroupLayoutSpec[2].entries.push({binding:2,visibility:'vertex|fragment',name:'connectedCoverage',buffer:{type:'read-only-storage'}});
    let resources={...m.storageBuffers,connectedCoverage:buffer};
    Object.defineProperty(m,'storageBuffers',{get:()=>resources,set:v=>{resources={...v,connectedCoverage:buffer};}});
    m.fragmentShader=wgsl(2,2)+patch(m.fragmentShader);
    if(isLake) {
        const begin=m.fragmentShader.indexOf('    let m = select(waterLakeMaskSample(lake,in.uv,nearWaterSampler)');
        const end=m.fragmentShader.indexOf('    let c = nearWaterShade',begin);
        if(begin<0||end<0)throw new Error('Lake clipping markers changed');
        const old=m.fragmentShader.slice(begin,end);
        m.fragmentShader=m.fragmentShader.slice(0,begin)+`
    var cc=0;if(in.lake==u32(connectedPatch[2].w)){cc=connectedCoverage(normalize(in.wp-U.origin));}
    if(cc<0){discard;}
    if(cc==0){if(any(in.uv<vec2<f32>(0.0))||any(in.uv>vec2<f32>(1.0))){discard;}${old}}
`+m.fragmentShader.slice(end);
        const oldGrid='let p = clamp(cam + sign(g) * g * g * U.extentM, lo, lo + size);';
        if(!m.vertexShader.includes(oldGrid))throw new Error('Lake grid marker changed');
        m.vertexShader=wgsl(2,2)+m.vertexShader.replace(oldGrid,`
    var patchLo=lo;var patchHi=lo+size;
    if(slot==u32(connectedPatch[2].w)) {
        patchLo=min(patchLo,connectedPatch[3].xy);
        patchHi=max(patchHi,connectedPatch[3].xy+vec2<f32>(connectedPatch[3].w,connectedPatch[4].x)*connectedPatch[3].z);
    }
    let p=clamp(cam+sign(g)*g*g*U.extentM,patchLo,patchHi);`);
    }
    return m;
}

export async function installConnectedCoverage(lakeId) {
    const started=Date.now(),g=window.gameEngine,f=g.renderer,b=f.backend,w=g.waterGpuData,n=f.nearWaterRenderer,t=f.quadtreeTerrainRenderer;
    const source=window.__waterContactSource;if(!source)throw new Error('Capture retained terrain first');
    const ground=source.ground,rec=w._applied.get(lakeId),row=w._table.subarray(lakeId*16,lakeId*16+16);
    const frame={c:Array.from(row.subarray(4,7)),e1:Array.from(row.subarray(8,11)),e2:Array.from(row.subarray(12,15))},level=row[0],waterRadius=w.R+level;
    const project=p=>[dot(p,frame.e1)/dot(p,frame.c)*w.R,dot(p,frame.e2)/dot(p,frame.c)*w.R];
    const triangles=ground.triangles.map(tr=>tr.p.map(p=>{const r=ground.frame.ray(p);return r.map(v=>v*tr.d/dot(tr.normal,r));}));
    let seed=-1,bestDepth=-Infinity,seedPoint=null;
    triangles.forEach((tr,i)=>{
        const p=[0,1,2].map(k=>(tr[0][k]+tr[1][k]+tr[2][k])/3),xy=project(p),fr=rec.frame;
        const x=Math.floor((xy[0]-fr.x0)/fr.spacing),y=Math.floor((xy[1]-fr.y0)/fr.spacing);
        if(x<1||y<1||x>=fr.nx-1||y>=fr.ny-1)return;
        for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)if(rec.mask[(y+dy)*fr.nx+x+dx]!==2)return;
        const depth=waterRadius-Math.hypot(...p);
        if(depth>.1&&depth>bestDepth){seed=i;bestDepth=depth;seedPoint=p;}
    });
    if(seed<0)throw new Error('No submerged seed inside an eroded lake interior');
    const topology=connectTriangles(triangles,waterRadius,seed);
    const B=ground.bounds,corners=[[B[0],B[1]],[B[0],B[3]],[B[2],B[1]],[B[2],B[3]]].map(p=>project(ground.frame.ray(p)));
    const bounds=[Math.min(...corners.map(p=>p[0])),Math.min(...corners.map(p=>p[1])),Math.max(...corners.map(p=>p[0])),Math.max(...corners.map(p=>p[1]))];
    const packed=packCoverage(triangles,topology.connected,frame,level,lakeId,w.R,bounds);
    const buffer=b.device.createBuffer({size:packed.data.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
    b.device.queue.writeBuffer(buffer,0,packed.data);
    const previous={terrain:t._materials,lake:n._lakeMaterial,river:n._riverMaterial,patch:w.connectedCoveragePatch};
    const materials=new Map([...t._materials].map(([lod,m])=>[lod,terrainClone(b,m,buffer)]));
    const lake=nearClone(n._lakeMaterial,buffer,true),river=nearClone(n._riverMaterial,buffer,false);
    const metadata={body:lakeId,level,sourceVersion:w._appliedVersion,frame,bounds:packed.bounds,seedTriangle:seed,seedPlanetRelative:seedPoint,seedDepthM:bestDepth,
        topology:topology.stats,upload:packed.stats,buildMs:Date.now()-started};
    // One coherent publication; every consumer uses the same immutable buffer.
    w.connectedCoveragePatch={...metadata,buffer};t._materials=materials;n._lakeMaterial=lake;n._riverMaterial=river;
    window.__connectedPrototype={metadata,debug:{triangles,topology,packed,project,frame},restore:async()=>{
        t._materials=previous.terrain;n._lakeMaterial=previous.lake;n._riverMaterial=previous.river;
        if(previous.patch===undefined)delete w.connectedCoveragePatch;else w.connectedCoveragePatch=previous.patch;
        await b.device.queue.onSubmittedWorkDone();for(const m of [...materials.values(),lake,river])b.destroyMaterial(m);buffer.destroy();delete window.__connectedPrototype;
    }};
    return metadata;
}
