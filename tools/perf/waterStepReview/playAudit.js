// Live engine movement, no frozen traversal or simulated selection output.
import {dirToFaceUV} from '../../../core/world/hydrology/waterGraph.js';
import {norm,sub} from './contactGeometry.js';

export async function auditPlay(view,{lakeId=633}={}) {
    const g=window.gameEngine,tm=g.renderer.quadtreeTileManager,w=g.waterGpuData,rec=w._applied.get(lakeId),R=w.R;
    const o=g.planetConfig.origin,origin=[o.x,o.y,o.z],base=view.pos,up=norm(sub(base,origin));
    const forward=norm(sub(view.look,base)),axis=norm([forward[1]*up[2]-forward[2]*up[1],forward[2]*up[0]-forward[0]*up[2],forward[0]*up[1]-forward[1]*up[0]]);
    const shore=[],fr=rec.frame;
    for(let y=1;y<fr.ny-1;y++)for(let x=1;x<fr.nx-1;x++) {
        if(rec.mask[y*fr.nx+x]!==2||[[-1,0],[1,0],[0,-1],[0,1]].every(([dx,dy])=>rec.mask[(y+dy)*fr.nx+x+dx]===2))continue;
        const xx=fr.x0+x*fr.spacing,yy=fr.y0+y*fr.spacing,dir=norm(fr.c.map((v,k)=>v+(fr.e1[k]*xx+fr.e2[k]*yy)/R));
        const p=dir.map(v=>v*(R+rec.level));if(Math.hypot(...sub(p,sub(base,origin)))<1500)shore.push({p,...dirToFaceUV(dir)});
    }
    const set=offset=>window.qtDiag.regional.useCamera({position:Object.fromEntries(['x','y','z'].map((k,i)=>[k,base[i]+axis[i]*offset])),
        target:Object.fromEntries(['x','y','z'].map((k,i)=>[k,view.look[i]+axis[i]*offset])),up:{x:up[0],y:up[1],z:up[2]},fov:75});
    const samples=[],savedUpdate=g.update;let offset=()=>0;
    g.update=function(...args){const result=savedUpdate.apply(this,args);set(offset());return result;};
    try {
    for(const phase of [{name:'arrival',duration:3000,amplitude:0},{name:'walk',duration:4000,amplitude:20,omega:.5},
        {name:'fast',duration:6000,amplitude:180,omega:2},{name:'settled',duration:4000,amplitude:0}]) {
        const start=performance.now();
        offset=()=>phase.amplitude*Math.sin((performance.now()-start)/1000*(phase.omega??0));
        while(performance.now()-start<phase.duration) {
            await new Promise(r=>setTimeout(r,100));
            const cam=g.camera.position,rel=[cam.x-o.x,cam.y-o.y,cam.z-o.z],tiles=tm._lastVisibleTiles??[],counts={};let nearestFallbackM=null;
            for(const s of shore) {
                const distance=Math.hypot(...sub(s.p,rel)),tile=tiles.find(t=>t.face===s.face&&Math.floor(s.u*2**t.depth)===t.x&&Math.floor(s.v*2**t.depth)===t.y);
                if(!tile)continue;let resolved=tile.depth,x=tile.x,y=tile.y;
                while(resolved>=0) {const layer=tm.tileStreamer.getLoadedLayer(tile.face,resolved,x,y);
                    if(Number.isInteger(layer)&&layer>=0)break;resolved--;x>>=1;y>>=1;}
                const bucket=distance<250?'0-250':distance<500?'250-500':distance<1000?'500-1000':'1000-1500';
                const key=`${bucket}/selected${tile.depth}/resident${resolved}`;counts[key]=(counts[key]??0)+1;
                if(resolved<tile.depth)nearestFallbackM=Math.min(nearestFallbackM??Infinity,distance);
            }
            samples.push({phase:phase.name,elapsedMs:performance.now()-start,pixelRatio:g.adaptiveQuality.pixelRatio,
                lodScreenHeight:tm._getLodScreenHeight(),threshold:tm.quadtreeGPU.lodErrorThreshold,
                speedScale:tm._lodSpeedScale,visibleScale:tm._lodVisibleScale,shore:counts,nearestFallbackM,residency:tm.getResidencySnapshot?.()??window.__lr.residency()});
        }
    }
    } finally {g.update=savedUpdate;set(0);}
    return {config:tm._adaptiveLodConfig,rendering:g.engineConfig.rendering.adaptive,shorePoints:shore.length,samples};
}
