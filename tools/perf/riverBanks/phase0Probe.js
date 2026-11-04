// Phase 0 probes (RIVERS_AND_LAKES.md section 7): which rivers are near a
// point, whether the GPU lists hold them, and how stale the resident tiles are.
export function riversAt({pos,look,radiusM=400}) {
    const g=window.gameEngine,s=g.waterService,w=g.waterGpuData;
    const p=look??pos,len=Math.hypot(...p),dir=p.map(v=>v/len);
    const out=[];
    for(const [rid,rec] of s.riverRecs) {
        const P=rec.points,st=rec.stride,n=P.length/st;
        let best=-2,k0=0;
        for(let k=0;k<n;k++){const c=P[k*st]*dir[0]+P[k*st+1]*dir[1]+P[k*st+2]*dir[2];if(c>best){best=c;k0=k;}}
        const m=Math.acos(Math.min(1,best))*w.R;
        if(m>radiusM)continue;
        out.push({rid,m:+m.toFixed(1),k:k0,n,drawn:w.isRiverDrawn(rid),narrow:w._isNarrow(rec),
            applied:w._appliedRivers.get(rid)===rec,hw:+P[k0*st+4].toFixed(2),eta:+P[k0*st+3].toFixed(2),
            depth:+P[k0*st+5].toFixed(2),ground:+P[k0*st+13].toFixed(2),pool:P[k0*st+9]});
    }
    return out.sort((a,b)=>a.m-b.m);
}
export function tileStaleness() {
    const ts=gameEngine.renderer.quadtreeTileManager.tileStreamer,cur=ts._terrainCarveVersion();
    let total=0,stale=0,missing=0;const byDepth={};
    for(const info of ts._tileInfo.values()){
        total++;const v=info.carveVersion;
        if(v===undefined){missing++;continue;}
        if(v<cur){stale++;byDepth[info.depth]=(byDepth[info.depth]??0)+1;}
    }
    return {current:cur,total,stale,missing,byDepth,regen:ts.getRegenerationStats()};
}
