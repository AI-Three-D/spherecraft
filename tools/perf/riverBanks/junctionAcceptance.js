// Page-side acceptance checks for the production junction field.
export async function underwaterJunction({riverId=456,sign=1}={}) {
    const g=window.gameEngine,w=g.waterGpuData,r=w._appliedRivers.get(riverId);
    if(!r)throw new Error(`Missing river ${riverId}`);
    const m=r.mouths.find(m=>m.sign===sign),arc=w._arcLengths(r),P=r.points,st=r.stride;
    const at=station=>{
        let k=0;while(k+2<arc.length&&arc[k+1]<station)k++;
        const t=(station-arc[k])/Math.max(.001,arc[k+1]-arc[k]);
        const d=[0,1,2].map(j=>P[k*st+j]+(P[(k+1)*st+j]-P[k*st+j])*t),len=Math.hypot(...d);
        return d.map(v=>v/len);
    };
    const camera=at(m.s+sign*20),target=at(m.s+sign*65),R=w.R;
    const h=(await g.waterService._sampler.sampleDirsCarved(Float32Array.from([...camera,0])))[0];
    const eye=Math.min(m.level-.5,h+1.2),origin=g.planetConfig.origin;
    const world=(dir,height)=>dir.map((v,j)=>v*(R+height)+[origin.x,origin.y,origin.z][j]);
    const view={name:`underwater-${riverId}-${sign}`,pos:world(camera,eye),look:world(target,eye-.5),up:camera};
    g.setWaterDebugMode(0);
    await(await import('../waterStepReview/qualityScene.js')).poseView(view);
    return {view,bedM:h,eyeM:eye,levelM:m.level,gpuErrors:window.__lr.gpuErrors};
}

export async function junctionPerformance({views,tileKeys,frames=90,rounds=2}) {
    const g=window.gameEngine,driver=g.junctionFieldService,store=g.terrainGenerator.junctionFields;
    const q=await import('../waterStepReview/qualityScene.js');
    const {fencedFrames}=await import('../terrainDetail/scene.js');
    const {fixedTilesGpu}=await import('./regenTiming.js');
    const update=driver.update,rows=[];
    const regenerate=async()=>{
        const {TileAddress}=await import('../../../core/world/quadtree/tileAddress.js');
        const ts=g.renderer.quadtreeTileManager.tileStreamer;
        const visible=new Set(ts._lastVisibleTilesList.map(t=>new TileAddress(t.face??t[0],t.depth??t[1],t.x??t[2],t.y??t[3]).toString()));
        g.terrainGenerator.markWaterCarveChanged();
        ts.regenerateTiles((...args)=>visible.has(new TileAddress(...args).toString()));
        await new Promise(r=>setTimeout(r,100));await q.settle(300000);
    };
    try {
        for(const view of views) {
            driver.update=update;await q.poseView(view);g.setWaterDebugMode(0);
            driver.update=()=>{};
            const resources=store.resources,row={name:view.name,arms:[]};
            try {
                for(const enabled of [true,false,true]) {
                    store.resources=enabled?resources:store.empty;
                    await regenerate();
                    const timings=[];
                    for(let n=0;n<rounds;n++)timings.push(await fencedFrames(frames,20));
                    const generation=await fixedTilesGpu({view,tiles:tileKeys.length,tileKeys});
                    row.arms.push({enabled,timings,generation});
                }
            } finally {store.resources=resources;await regenerate();}
            rows.push(row);
        }
    } finally {driver.update=update;}
    return {rows,gpuErrors:window.__lr.gpuErrors};
}
