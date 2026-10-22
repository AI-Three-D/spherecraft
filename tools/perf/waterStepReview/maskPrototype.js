import {installConnectedCoverage,terrainClone,nearClone,patchQueries} from './connectedPrototype.js';
import {dot,norm,triangleInterval} from './contactGeometry.js';
import {connectTriangles} from './connectedTriangles.js';
import {riverWaterLevels,buildRiverRibbons} from '../../../core/world/water/riverRibbon.js';
import {connectDepths,clipWet,nearestCurve,riverSeeds,buildBodyMask,packBodyMask,bodyMaskWgsl,lakeRemainder} from './bodyMask.js';

function queries(code) {
    code=patchQueries(code);
    const marker='fn waterRiverAtView(dir: vec3<f32>, heightM: f32, coarseSurface: bool) -> WaterRiverHit {';
    if(!code.includes(marker))throw new Error('River query signature changed');
    return code.replace(marker,marker+`
    let r=connectedRecord(dir);
    if(r.x>=3.0) {
        var owned:WaterRiverHit;let level=connectedRiverLevel(dir,r);
        owned.near=true;owned.found=heightM<level;owned.etaM=level;owned.depthM=max(0.0,level-heightM);
        owned.river=r.x-3.0;owned.profileM=level-owned.depthM;owned.halfWidthM=1.0;owned.speed=1.0;
        owned.flow=normalize(cross(dir,vec3<f32>(0.0,1.0,0.0001)));return owned;
    }
    if(r.x==1.0){var dry:WaterRiverHit;return dry;}
`);
}

export async function installMaskCoverage(lakeId) {
    const start=Date.now(),old=await installConnectedCoverage(lakeId),debug=window.__connectedPrototype.debug;
    await window.__connectedPrototype.restore();
    const g=window.gameEngine,f=g.renderer,b=f.backend,w=g.waterGpuData,n=f.nearWaterRenderer,t=f.quadtreeTerrainRenderer;
    const {triangles,project,frame}=debug,R=w.R,level=old.level,bounds=old.bounds;
    const projected=triangles.map(tr=>tr.map(project)),heights=triangles.map(tr=>tr.map(p=>Math.hypot(...p)-R));
    const ray=xy=>norm(frame.c.map((v,k)=>v+(frame.e1[k]*xy[0]+frame.e2[k]*xy[1])/R));
    const segments=[],bodies=[{at:()=>({level}),river:null}],riverData=[];
    for(const [river,rec] of w._appliedRivers) {
        if(!w.isRiverDrawn(river))continue;
        const P=rec.points,st=rec.stride,levels=riverWaterLevels(rec,w._arcLengths(rec),d=>w.lakeAt(d)),local=[];
        for(let k=0;k+1<levels.length;k++) {
            const a=Array.from(P.subarray(k*st,k*st+3)),bb=Array.from(P.subarray((k+1)*st,(k+1)*st+3)),pa=project(a),pb=project(bb);
            if(Math.max(pa[0],pb[0])<bounds[0]-100||Math.max(pa[1],pb[1])<bounds[1]-100||Math.min(pa[0],pb[0])>bounds[2]+100||Math.min(pa[1],pb[1])>bounds[3]+100)continue;
            local.push({a,b:bb,l0:levels[k],l1:levels[k+1],river,sourcePoint:k});
        }
        if(!local.length)continue;
        const depths=triangles.map((tr,i)=>tr.map((p,k)=>nearestCurve(norm(p),local).level-heights[i][k]));
        const seeds=riverSeeds(projected,local,project,depths);if(!seeds.length)continue;
        const topology=connectDepths(triangles,depths,seeds);
        local.forEach(s=>{s.index=segments.length;segments.push(s);});
        const body=bodies.length;bodies.push({river,at:xy=>nearestCurve(ray(xy),local)});
        riverData.push({river,body,local,depths,topology,seeds,src:rec.src});
    }
    const lakePieces=triangles.flatMap((tr,i)=>lakeRemainder(tr,heights[i],level,
        riverData.filter(r=>r.topology.connected[i]).map(r=>r.depths[i])));
    const seedXY=project(old.seedPlanetRelative),seed=lakePieces.findIndex(tr=>triangleInterval(seedXY,seedXY,...tr.map(project)));
    if(seed<0)throw new Error('Lower-body exclusion removed the lake seed');
    const lakeTopology=connectTriangles(lakePieces,R+level,seed);
    const polygons=projected.map(p=>({p,known:true}));
    const add=(body,depths,topology)=>projected.forEach((p,i)=>{
        const poly=clipWet(p,depths[i]);if(poly.length>=3)polygons.push({p:poly,body,connected:!!topology.connected[i]});
    });
    lakePieces.forEach((tr,i)=>polygons.push({p:tr.map(project),body:0,connected:!!lakeTopology.connected[i]}));
    riverData.forEach(r=>add(r.body,r.depths,r.topology));
    const mask=buildBodyMask({polygons,bodies,bounds}),data=packBodyMask(mask,frame,R,lakeId,level,segments);
    // Test the published ownership boundary in world coordinates as well as
    // screen pixels. Adjacent different levels can be hidden in a water union.
    const interfaces=[],step=mask.cellM/mask.subdivisions,ground=window.__waterContactSource.ground;
    for(const leaf of mask.leaves) {
        if(leaf.record[0]<3)continue;const box=leaf.box;
        for(const [axis,side,sign]of[[0,box[0],-1],[0,box[2],1],[1,box[1],-1],[1,box[3],1]]) {
            const other=1-axis;
            for(let q=box[other]+step/2;q<box[other+2];q+=step) {
                const xy=[];xy[axis]=side;xy[other]=q;const outside=[...xy];outside[axis]+=sign*.01;
                if(mask.at(outside)[0]!==2)continue;
                const dir=ray(xy),h=nearestCurve(dir,[segments[leaf.record[1]-1]]).level,p=dir.map(v=>v*(R+level)),gp=ground.frame.project(p);
                const sample=ground.span(gp,gp,{normal:dir,d:R+level});
                interfaces.push({xy,lakeAboveRiverM:level-h,lakeAboveGroundM:sample.covered?sample.dropM:null,
                    pointPlanetRelative:p});
            }
        }
    }
    const buffer=b.device.createBuffer({size:data.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});b.device.queue.writeBuffer(buffer,0,data);
    const options={wgsl:bodyMaskWgsl,patch:queries};
    const previous={terrain:t._materials,lake:n._lakeMaterial,river:n._riverMaterial,patch:w.connectedCoveragePatch,buffers:n._riverBuffers,quads:n._quadCount};
    const materials=new Map([...t._materials].map(([lod,m])=>[lod,terrainClone(b,m,buffer,options)]));
    const lake=nearClone(n._lakeMaterial,buffer,true,options),river=nearClone(n._riverMaterial,buffer,false,options);
    const guard='    // A lake\'s mask covers the point: the lake\'s surface is drawn there.';
    const begin=river.fragmentShader.indexOf(guard),end=river.fragmentShader.indexOf('    // A downstream observer',begin);
    if(begin<0||end<0)throw new Error('River clipping markers changed');
    const oldClipping=river.fragmentShader.slice(begin,end).replace('    let hit = waterRiverAt(up, in.level);','');
    river.fragmentShader=river.fragmentShader.slice(0,begin)+`
    let hit=waterRiverAt(up,in.level);let owner=connectedRecord(up);
    if(owner.x>0.0){if(in.coverageNew==0u||owner.x<3.0||abs(owner.x-3.0-in.river)>.5){discard;}}
    else {${oldClipping}}
`+river.fragmentShader.slice(end);
    // Retain old geometry outside the patch; add grids at each river's own curve.
    // Existing fragments inside the patch are suppressed to avoid doubled water.
    const cam=window.__waterContactSource.camera,origin=g.planetConfig.origin,rel={x:cam[0]-origin.x,y:cam[1]-origin.y,z:cam[2]-origin.z};
    const original=buildRiverRibbons({rivers:[...w._appliedRivers].filter(([id])=>w.isRiverDrawn(id)),arcOf:r=>w._arcLengths(r),camera:rel,
        rangeM:w.near.fadeEndM+10,R,origin,shape:w.carve??{},lakeAt:d=>w.lakeAt(d)});
    const points=Array.from(original.points),quads=Array.from(original.quads),basePoints=original.points.length/8;
    const riverOf=new Map(riverData.map(r=>[r.river,r]));
    const pushPoint=(xy,r)=>{const d=ray(xy),h=nearestCurve(d,r.local).level;return [...d.map((v,k)=>[origin.x,origin.y,origin.z][k]+v*(R+h)),h];};
    for(const leaf of mask.leaves) {
        if(leaf.record[0]<3)continue;const r=riverOf.get(leaf.record[0]-3),box=leaf.box,id=points.length/8;
        const a=pushPoint([box[0],box[1]],r),bb=pushPoint([box[2],box[1]],r),c=pushPoint([box[0],box[3]],r),dd=pushPoint([box[2],box[3]],r);
        points.push(...a.slice(0,3),r.river,...bb.slice(0,3),bb[3],...c.slice(0,3),r.river,...dd.slice(0,3),dd[3]);quads.push(id);
    }
    const member='@location(2) @interpolate(flat) river: f32,';
    const extra=member+'\n    @location(4) @interpolate(flat) coverageNew:u32,';
    river.fragmentShader=river.fragmentShader.replace(member,extra);
    river.vertexShader=bodyMaskWgsl(2,2)+river.vertexShader.replace(member,extra).replace('    o.level = b.w;',`
    o.level=b.w;
    let owner=connectedRecord(normalize(wp-U.origin));
    if(owner.x>=3.0){o.level=connectedRiverLevel(normalize(wp-U.origin),owner);}
    o.coverageNew=select(0u,1u,p>=${basePoints}u);
`);
    const buffers={};for(const [key,values]of[['points',new Float32Array(points)],['quads',new Uint32Array(quads)]]){
        buffers[key]=b.device.createBuffer({size:Math.max(256,values.byteLength),usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});if(values.byteLength)b.device.queue.writeBuffer(buffers[key],0,values);
    }
    const metadata={...old,mode:'cached-body-mask',buildMs:Date.now()-start,mask:mask.stats,upload:{bytes:data.byteLength},
        source:'frozen selected terrain; stable finest-height producer not integrated',lakePieces:lakePieces.length,
        interfaces:{sampleSpacingM:step,samples:interfaces.length,over25cm:interfaces.filter(x=>Math.abs(x.lakeAboveRiverM)>.25).length,
            maxStepM:interfaces.length?Math.max(...interfaces.map(x=>Math.abs(x.lakeAboveRiverM))):null,
            largest:interfaces.sort((a,b)=>Math.abs(b.lakeAboveRiverM)-Math.abs(a.lakeAboveRiverM)).slice(0,10)},
        rivers:riverData.map(r=>({id:r.river,src:r.src,segments:r.local.length,seeds:r.seeds.length,connectedTriangles:r.topology.connected.reduce((a,b)=>a+b,0)})),
        addedRiverQuads:quads.length-original.quads.length,riverGeometryBytes:buffers.points.size+buffers.quads.size};
    w.connectedCoveragePatch={...metadata,buffer};t._materials=materials;n._lakeMaterial=lake;n._riverMaterial=river;n._riverBuffers=buffers;n._quadCount=quads.length;
    window.__connectedPrototype={metadata,debug:{...debug,mask,bodies,riverData},lookupOnly:async measure=>{
        // Fetch the same records with the original geometry/coverage. The
        // dynamic branch keeps the fetch live; valid records are nonnegative.
        const patch=code=>code.replace(/(@fragment\s+fn main\((input|in): (?:FragmentInput|NearWaterVOut|NearRiverVOut)\) -> @location\(0\) vec4<f32> \{)/,
            (_,head,arg)=>head+`\n if(connectedRecord(normalize(${arg==='input'?'input.vWorldPosition - fragUniforms.planetCenter':'in.wp-U.origin'})).x<0.0){discard;}\n`);
        const opts={wgsl:bodyMaskWgsl,patch},probeMaterials=new Map([...previous.terrain].map(([lod,m])=>[lod,terrainClone(b,m,buffer,opts)]));
        const probeLake=nearClone(previous.lake,buffer,false,opts),probeRiver=nearClone(previous.river,buffer,false,opts);
        t._materials=probeMaterials;n._lakeMaterial=probeLake;n._riverMaterial=probeRiver;n._riverBuffers=previous.buffers;n._quadCount=previous.quads;
        try{return await measure();}finally{
            t._materials=materials;n._lakeMaterial=lake;n._riverMaterial=river;n._riverBuffers=buffers;n._quadCount=quads.length;
            await b.device.queue.onSubmittedWorkDone();for(const m of [...probeMaterials.values(),probeLake,probeRiver])b.destroyMaterial(m);
        }
    },restore:async()=>{
        t._materials=previous.terrain;n._lakeMaterial=previous.lake;n._riverMaterial=previous.river;n._riverBuffers=previous.buffers;n._quadCount=previous.quads;
        if(previous.patch===undefined)delete w.connectedCoveragePatch;else w.connectedCoveragePatch=previous.patch;
        await b.device.queue.onSubmittedWorkDone();for(const m of [...materials.values(),lake,river])b.destroyMaterial(m);buffer.destroy();Object.values(buffers).forEach(b=>b.destroy());delete window.__connectedPrototype;
    }};
    return metadata;
}
