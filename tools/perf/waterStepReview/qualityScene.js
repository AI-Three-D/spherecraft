// Camera and settling helpers shared by live visual checks and captures.
export async function settle(timeoutMs=120000) {
    const until=performance.now()+timeoutMs;
    let idleAt=0;
    while(performance.now()<until){
        const g=window.gameEngine,r=window.__lr.residency(),s=g.waterService;
        const idle=r?.visibleTiles>0&&r.exactVisibleRatio===1&&!r.pendingGenerations&&!r.activeGenerations&&!r.pendingCopies&&!s._busy&&!s._client?._pending.size&&
            !g.renderer.quadtreeTileManager.tileStreamer.getRegenerationStats().pending;
        if(idle){idleAt||=performance.now();if(performance.now()-idleAt>1500)return r;}else idleAt=0;
        await new Promise(r=>setTimeout(r,100));
    }
    throw new Error('Scene did not settle: '+JSON.stringify(window.__lr.residency()));
}
export async function riverView(id,fraction,{height=24,back=30,side=0}={}){
    const g=window.gameEngine,s=g.waterService;
    for(let i=0;i<1800&&!s.riverRecs.has(id)&&!s._failedRivers.has(id);i++){
        if(i%20===0&&!s._busy)s.refineRiver(id);
        await new Promise(r=>setTimeout(r,100));
    }
    const rec=s.riverRecs.get(id);if(!rec)throw new Error('River missing: '+id);
    const P=rec.points,st=rec.stride,n=P.length/st,k=Math.max(1,Math.min(n-2,Math.round(fraction*(n-1))));
    const norm=a=>{const l=Math.hypot(...a);return a.map(v=>v/l);};
    const up=norm(Array.from(P.slice(k*st,k*st+3)));
    window.__lr.daylightAt(up,0.75);
    const t=norm([0,1,2].map(j=>P[(k+1)*st+j]-P[(k-1)*st+j]));
    const left=norm([up[1]*t[2]-up[2]*t[1],up[2]*t[0]-up[0]*t[2],up[0]*t[1]-up[1]*t[0]]);
    const R=g.waterGpuData.R,level=P[k*st+16],o=g.planetConfig.origin;
    const target=up.map((v,j)=>v*(R+level)+[o.x,o.y,o.z][j]);
    const pos=target.map((v,j)=>v+up[j]*height-t[j]*back+left[j]*side);
    const vector=a=>({x:a[0],y:a[1],z:a[2]});
    window.qtDiag.regional.useCamera({position:vector(pos),target:vector(target),up:vector(up),fov:75});
    const resident=await settle();
    return {id,fraction,k,height,back,side,level,width:2*P[k*st+4],pose:window.__lr.pose(),resident,gpuErrors:window.__lr.gpuErrors};
}

export async function poseView(view) {
    const g=window.gameEngine,s=g.waterService;
    const vector=a=>({x:a[0],y:a[1],z:a[2]});
    const len=Math.hypot(...view.pos),dir=view.pos.map(v=>v/len);
    window.qtDiag.regional.useCamera({position:vector(view.pos),target:vector(view.look),up:vector(view.up??dir),fov:75});
    window.__lr.daylightAt(dir,.75);
    const near=s.rivers.map(r=>({id:r.id,m:s._riverDistance(r.id,dir)})).filter(r=>r.m<2500).sort((a,b)=>a.m-b.m).slice(0,8);
    for(const r of near)for(let i=0;i<1800&&!s.riverRecs.has(r.id)&&!s._failedRivers.has(r.id);i++){
        if(i%20===0&&!s._busy)s.refineRiver(r.id);
        await new Promise(r=>setTimeout(r,100));
    }
    const resident=await settle();
    return {name:view.name,pose:window.__lr.pose(),near,resident,gpuErrors:window.__lr.gpuErrors,
        rivers:near.map(({id})=>{const r=s.riverRecs.get(id);return r?{id,from:r.src,to:r.dest,lengthM:r.lengthM,stride:r.stride,points:Array.from(r.points)}:{id,missing:true};})};
}
