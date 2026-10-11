import { MinHeap, dirToCell, dirToCellSub, dirToFaceUV,faceUVToDir } from '../hydrology/waterGraph.js';
import { tangentBasis, planeToDir, dirToPlane } from '../hydrology/lakeRefine.js';
import { smoothRiverPath, segmentCells, RIVER_POINT_STRIDE } from '../hydrology/riverRefine.js';
import { riverNoise, RIVER_CARVE_DEFAULTS, riverShapeMaxScale } from '../water/riverShapeNoise.js';
import { planRegionalBasins } from './regionalBasins.js';
import {regionalRiverProfile} from './regionalRiverProfile.js';
import {regionalRiverCourse} from './regionalRiverCourse.js';
import {regionalLakePortal} from './regionalLakePortal.js';

const neighbours=[[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];

// Terrain-aware coarse search. Height is a cost, not a hard flow constraint:
// intended canyon cuts can connect otherwise obstructed regional water levels.
export function routeRegionalHeightGrid({heights,nx,ny,spacing,sourceIndex,targetIndex,sourceLevelM,targetLevelM,
    terrainFollowing=false,maxChannelCutM=24,sourceRadiusM=0,targetRadiusM=0}) {
    if(!(sourceLevelM>targetLevelM)||heights.length!==nx*ny||!heights.every(Number.isFinite)) throw new Error('Invalid regional route height contract');
    const n=heights.length,cost=new Float64Array(n).fill(Infinity),parent=new Int32Array(n).fill(-1),closed=new Uint8Array(n),levels=new Float64Array(n);
    const heap=new MinHeap(n*8),sx=sourceIndex%nx,sy=Math.floor(sourceIndex/nx),tx=targetIndex%nx,ty=Math.floor(targetIndex/nx);
    const length2=(tx-sx)**2+(ty-sy)**2;
    const heuristic=k=>Math.hypot(k%nx-tx,Math.floor(k/nx)-ty)*spacing;
    cost[sourceIndex]=0;levels[sourceIndex]=sourceLevelM;heap.push(heuristic(sourceIndex),sourceIndex);let visited=0;
    while(heap.size) {
        const k=heap.pop();if(closed[k]) continue;closed[k]=1;visited++;
        if(k===targetIndex) break;
        const x=k%nx,y=Math.floor(k/nx);
        for(const [dx,dy] of neighbours) {
            const i=x+dx,j=y+dy;if(i<0||j<0||i>=nx||j>=ny) continue;
            const next=j*nx+i;if(closed[next]) continue;
            const t=Math.min(1,Math.max(0,((i-sx)*(tx-sx)+(j-sy)*(ty-sy))/Math.max(1,length2)));
            let level=sourceLevelM+(targetLevelM-sourceLevelM)*t;
            if(terrainFollowing) {
                level=Math.max(targetLevelM,Math.min(levels[k],heights[next]+.2));
                if(Math.hypot(i-sx,j-sy)*spacing<=sourceRadiusM)level=sourceLevelM;
                if(Math.hypot(i-tx,j-ty)*spacing<=targetRadiusM)level=targetLevelM;
            }
            const excavation=Math.max(0,(terrainFollowing?heights[next]:(heights[k]+heights[next])*.5)-level);
            if(terrainFollowing&&excavation+1.8>maxChannelCutM) continue;
            const slope=Math.abs(heights[next]-heights[k])/spacing;
            const edge=Math.hypot(dx,dy)*spacing*(1+Math.min(36,(excavation/12)**2)+Math.min(8,slope*8));
            const candidate=cost[k]+edge;
            if(candidate<cost[next]) {cost[next]=candidate;parent[next]=k;levels[next]=level;heap.push(candidate+heuristic(next),next);}
        }
    }
    if(!closed[targetIndex]) throw new Error('Regional receiver is unreachable');
    const path=[];for(let k=targetIndex;k>=0;k=parent[k]) {path.push(k);if(k===sourceIndex) break;}
    path.reverse();return {path:Uint32Array.from(path),cost:cost[targetIndex],visited};
}

export async function planRegionalDrainage({device,gen,data,uniformBytes,basinOptions,source,options,certifier,receiver:existingReceiver=null}) {
    const started=performance.now(),R=gen.planetConfig.radius,{face,u,v}=dirToFaceUV(source.centre),cells=data.cells;
    // The existing analytic annulus certificate is used only OUTSIDE the
    // authoritative shape domain. It cannot certify a replacement spline
    // by evaluating the old analytic intervals inside that domain.
    if(data.shapeData&&!data.shapeData.regions&&!data.shapeData.worldwide) {
        const o=data.shapeData.options,grid=2**o.depth;
        const reach=Math.max(...[0,1].flatMap(dx=>[0,1].map(dy=>{
            const d=faceUVToDir(o.face,(o.x+dx)/grid,(o.y+dy)/grid),dot=d.reduce((s,v,i)=>s+v*source.centre[i],0);
            return R*Math.hypot(...d.map((v,i)=>v-source.centre[i]*dot))/dot;
        })))+basinOptions.radiusM+6;
        if(options.minDistanceM<=reach) throw new Error('Receiver certificate search overlaps authoritative shape support');
    }
    const search={face,x:Math.floor(u*cells),y:Math.floor(v*cells),extent:Math.ceil(options.maxDistanceM*cells/R/1.2)+2,
        centre:source.centre,minDistanceM:options.minDistanceM,maxDistanceM:options.maxDistanceM,maxLevelM:source.levelM-options.minimumDropM};
    const receiverPlan=existingReceiver?{basins:[existingReceiver],timings:{totalMs:0,uploadBytes:0,readbackBytes:0}}
        :data.shapeData?.regions?{basins:[data.shapeData.basins[1]],timings:{totalMs:0,uploadBytes:0,readbackBytes:0}}
        :await planRegionalBasins({device,gen,data,uniformBytes,certifier,search,options:{...basinOptions,candidates:64,rimCandidates:16}});
    if(!receiverPlan.basins.length) throw new Error('No nearby certified receiver meets the excavation/descending-level budget');
    const receiver={...receiverPlan.basins[0],id:existingReceiver?.id??options.receiverId??1},frame={c:source.centre,...tangentBasis(source.centre)};
    const end=dirToPlane(receiver.centre,frame,R),spacing=options.spacingM,margin=spacing*6;
    Object.assign(frame,{x0:Math.floor((Math.min(0,end[0])-margin)/spacing)*spacing,
        y0:Math.floor((Math.min(0,end[1])-margin)/spacing)*spacing,spacing});
    frame.nx=Math.ceil((Math.max(0,end[0])+margin-frame.x0)/spacing)+1;
    frame.ny=Math.ceil((Math.max(0,end[1])+margin-frame.y0)/spacing)+1;
    if(frame.nx*frame.ny>4096) throw new Error('Coarse regional route exceeds the initial 4096-node budget');
    const sites=[];for(let j=0;j<frame.ny;j++) for(let i=0;i<frame.nx;i++) sites.push({centre:planeToDir(frame.x0+i*spacing,frame.y0+j*spacing,frame,R),radiusM:0});
    const sampled=await certifier(sites,true),heights=Float32Array.from(sites,(_,i)=>sampled.output[i*4]);
    const cellAt=(x,y)=>Math.round((y-frame.y0)/spacing)*frame.nx+Math.round((x-frame.x0)/spacing);
    const routeStart=performance.now(),routed=routeRegionalHeightGrid({heights,nx:frame.nx,ny:frame.ny,spacing,
        sourceIndex:cellAt(0,0),targetIndex:cellAt(...end),sourceLevelM:source.levelM,targetLevelM:receiver.levelM,
        terrainFollowing:options.profile==='terrain',maxChannelCutM:options.maxChannelCutM,
        sourceRadiusM:source.radiusM+8,targetRadiusM:receiver.radiusM+8});
    const line=[[0,0],...Array.from(routed.path,k=>[frame.x0+(k%frame.nx)*spacing,frame.y0+Math.floor(k/frame.nx)*spacing]),end];
    const preliminary=options.course==='organic'?smoothRiverPath(line.map(p=>p[0]),line.map(p=>p[1]),line.map(()=>source.levelM),{stepM:32,passes:3}):null;
    const sourcePortal=options.course==='organic'?regionalLakePortal({course:preliminary,basin:source,planetRadius:R,planeToDir,frame}):null;
    const sm=options.course==='organic'?regionalRiverCourse({line,frame,heights,halfWidthM:options.halfWidthM,
        sourceLevelM:source.levelM,targetLevelM:receiver.levelM,sourceRadiusM:sourcePortal.arcM,targetRadiusM:receiver.radiusM+8,
        maxChannelCutM:options.maxChannelCutM,stepM:options.profile==='terrain'?options.profileStepM:32,
        maxPoints:options.maxProfilePoints})
        :smoothRiverPath(line.map(p=>p[0]),line.map(p=>p[1]),line.map(()=>source.levelM),{stepM:options.profile==='terrain'?options.profileStepM:64,passes:3});
    let profile=null,profileSampled=null,rows=null;
    const lengthM=sm.s.at(-1);
    const portals=options.course==='organic'?{
        source:regionalLakePortal({course:sm,basin:source,planetRadius:R,planeToDir,frame}),
        receiver:regionalLakePortal({course:sm,basin:receiver,planetRadius:R,planeToDir,frame,fromStart:false})}:null;
    const sourceEndM=portals?.source.arcM??source.radiusM+8,targetStartM=portals?.receiver.arcM??lengthM-receiver.radiusM-8;
    if(targetStartM-sourceEndM<options.halfWidthM*4)throw new Error('Regional course has insufficient dry reach between lake portals');
    if(options.profile==='terrain') {
        if(sm.x.length>options.maxProfilePoints) throw new Error('Regional river profile sampling budget exceeded');
        const sites=[];
        for(let k=0;k<sm.x.length;k++) {
            const a=Math.max(0,k-1),b=Math.min(sm.x.length-1,k+1),dx=sm.x[b]-sm.x[a],dy=sm.y[b]-sm.y[a],len=Math.hypot(dx,dy)||1;
            for(const side of [0,-1,1]) sites.push({centre:planeToDir(sm.x[k]-dy/len*options.halfWidthM*1.5*side,
                sm.y[k]+dx/len*options.halfWidthM*1.5*side,frame,R),radiusM:0});
        }
        profileSampled=await certifier(sites,true);
        profile=regionalRiverProfile({x:sm.x,y:sm.y,s:sm.s,
            heights:Float32Array.from(sites,(_,k)=>profileSampled.output[k*4]),sourceLevelM:source.levelM,targetLevelM:receiver.levelM,
            sourceEndM,targetStartM,
            maxChannelCutM:options.maxChannelCutM,fallExtraCutM:options.fallExtraCutM,fallRunM:options.fallRunM,maxPoints:options.maxProfilePoints});
        rows=profile.rows;
    }
    // Hide both caps inside actual wet coverage, rather than carving a trench
    // through each lake to its centre. A continuous flare meets the shoreline.
    const fullRows=rows??Array.from(sm.s,(s,k)=>({s,x:sm.x[k],y:sm.y[k]}));
    const overlap=options.halfWidthM*6;
    const packedRows=portals?fullRows.filter(p=>p.s>=sourceEndM-Math.min(overlap,sourceEndM*.6)
        &&p.s<=targetStartM+Math.min(overlap,(lengthM-targetStartM)*.6)):fullRows;
    if(packedRows.length<2)throw new Error('Regional course has insufficient dry reach between lake portals');
    const count=packedRows.length,points=new Float32Array(count*RIVER_POINT_STRIDE);
    let maxWidth=0;
    for(let k=0;k<count;k++) {
        const row=packedRows[k],arc=row.s,px=row.x,py=row.y;
        const t=Math.min(1,Math.max(0,portals?(arc-sourceEndM)/(targetStartM-sourceEndM)
            :(arc-source.radiusM-32)/(lengthM-source.radiusM-receiver.radiusM-64)));
        const level=row.levelM??(source.levelM+(receiver.levelM-source.levelM)*(t*t*(3-2*t)));
        const depth=row.depthM??1.8*(1+.3*riverNoise(arc,0,'depth').v),d=planeToDir(px,py,frame,R);
        const inLake=profile?(arc<=sourceEndM||arc>=targetStartM)
            :(arc<=source.radiusM+32||lengthM-arc<=receiver.radiusM+32);
        const mouthDistance=Math.min(Math.abs(arc-sourceEndM),Math.abs(arc-targetStartM));
        const mouthT=portals?Math.max(0,1-mouthDistance/(options.halfWidthM*10)):0;
        const flare=mouthT*mouthT*(3-2*mouthT);
        const width=options.halfWidthM*(options.course==='organic'?1+.2*riverNoise(arc*.4,0,'width').v:1)*(1+.8*flare);
        maxWidth=Math.max(maxWidth,width);
        points.set([...d,level,width,depth,.4*(1-.8*flare),2,level,inLake?-1:0,0,0,0,0,0,0,level,depth,
            arc<=sourceEndM?source.levelM:arc>=targetStartM?receiver.levelM:-1e20,0],k*RIVER_POINT_STRIDE);
    }
    const routeMs=performance.now()-routeStart,indexStart=performance.now(),gridN=gen.terrainConfig.waterGraph?.gridN??512;
    const segCellStart=new Int32Array(count),ids=[],coarseCells=new Set(),
        C={...RIVER_CARVE_DEFAULTS,...gen.terrainConfig.waterGraph?.carve};
    const reach=maxWidth*riverShapeMaxScale(C)+C.bankW+C.blendW+1;
    for(let k=0;k<count-1;k++) {
        segCellStart[k]=ids.length;
        for(const id of segmentCells(packedRows[k].x,packedRows[k].y,packedRows[k+1].x,packedRows[k+1].y,reach,
            (x,y)=>dirToCellSub(planeToDir(x,y,frame,R),gridN,4),{stepM:20,marginM:20})) ids.push(id);
        coarseCells.add(dirToCell(planeToDir(packedRows[k].x,packedRows[k].y,frame,R),gridN));
    }
    segCellStart[count-1]=ids.length;
    const packedLengthM=packedRows.at(-1).s-packedRows[0].s;
    const river={id:options.riverId??0,riverId:options.riverId??0,fromLake:source.id,dest:{kind:'lake',id:receiver.id},lengthM:packedLengthM,points,stride:RIVER_POINT_STRIDE,
        segCellStart,segCells:Int32Array.from(ids),cells:Int32Array.from(coarseCells).sort(),gridN,
        structured:true,representation:'coarse-regional-route-v1',...(options.course==='organic'?{course:{kind:sm.kind,
            maximumOffsetM:sm.maximumOffsetM,wavelengthM:sm.wavelengthM,heightSource:options.heightSource,
            portals:portals?Object.fromEntries(Object.entries(portals).map(([k,p])=>[k,{...p,arcM:p.arcM-packedRows[0].s}])):null}}:{}),...(profile?{profile:{kind:profile.kind,
            falls:profile.falls.map(f=>({...f,startM:f.startM-packedRows[0].s,endM:f.endM-packedRows[0].s})),
            maxCutM:profile.maxCutM,maxSlope:profile.maxSlope,descentM:profile.descentM,sampled:true}}:{})};
    return {receiver,receiverPlan,rivers:[river],topology:{frame,heights,path:routed.path,cost:routed.cost,visited:routed.visited},
        cpuBytes:heights.byteLength+routed.path.byteLength+points.byteLength+segCellStart.byteLength+river.segCells.byteLength+river.cells.byteLength,
        timings:{totalMs:performance.now()-started,receiverMs:receiverPlan.timings.totalMs,receiverPlanning:receiverPlan.timings,
            heightSamplingMs:sampled.wallMs,heightSamples:sites.length,
            profileSamplingMs:profileSampled?.wallMs??0,profileSamples:profileSampled?profileSampled.output.length/4:0,
            uploadBytes:receiverPlan.timings.uploadBytes+sampled.uploadBytes+(profileSampled?.uploadBytes??0),
            readbackBytes:receiverPlan.timings.readbackBytes+sampled.output.byteLength+(profileSampled?.output.byteLength??0),routeMs,indexMs:performance.now()-indexStart}};
}
