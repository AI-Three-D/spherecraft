export async function frameRepeat({view,rounds=3,frames=120}) {
    await (await import('/tools/perf/waterStepReview/qualityScene.js')).poseView(view);
    const {fencedFrames}=await import('/tools/perf/terrainDetail/scene.js');
    const result=[];
    for(let n=0;n<rounds;n++) {
        const timing=await fencedFrames(frames,30),gen=window.gameEngine.terrainGenerator;
        result.push({...timing,material:{kernel:gen.splatKernelSize,fixedFamilies:gen.splatFixedMaterialFamiliesEnabled}});
    }
    return result;
}

export async function passBreakdown({view,frames=30}) {
    await(await import('/tools/perf/waterStepReview/qualityScene.js')).poseView(view);
    const {fencedFrames}=await import('/tools/perf/terrainDetail/scene.js');
    const rows=[];
    await fencedFrames(5,10);
    for(let n=0;n<frames;n++) {
        const timing=await fencedFrames(1,0);
        rows.push({span:timing.gpuSpanMs.median,passes:window.__gpuTimer.passes.map(p=>({label:p.label,ms:(p.end-p.begin)/1e6}))});
    }
    const labels=[...new Set(rows.flatMap(r=>r.passes.map(p=>p.label)))];
    const median=a=>[...a].sort((a,b)=>a-b)[a.length>>1];
    const g=window.gameEngine,r=g.renderer.nearWaterRenderer,b=g.renderer.backend,draw=b.draw,drawCosts={};
    try {
        for(const skip of ['lake','river','both']) {
            b.draw=function(geom,mat,...args) {
                if((skip==='lake'||skip==='both')&&mat===r._lakeMaterial)return;
                if((skip==='river'||skip==='both')&&mat===r._riverMaterial)return;
                return draw.call(this,geom,mat,...args);
            };
            drawCosts[skip]=await fencedFrames(40,10);
        }
    } finally {b.draw=draw;}
    return {span:median(rows.map(r=>r.span)),byLabel:labels.map(label=>({label,ms:median(rows.map(r=>r.passes.filter(p=>p.label===label).reduce((s,p)=>s+p.ms,0)))})),last:rows.at(-1),drawCosts};
}

export async function lookupStats({view}) {
    await(await import('/tools/perf/waterStepReview/qualityScene.js')).poseView(view);
    const {dirToCellSub}=await import('/core/world/hydrology/waterGraph.js');
    const w=gameEngine.waterGpuData,rows=[];
    for(const rid of [456,2562,458]) {
        const r=w._appliedRivers.get(rid);if(!r)continue;
        const counts=[];
        for(let i=0;i<r.points.length;i+=r.stride) {
            const d=Array.from(r.points.subarray(i,i+3)),cs=dirToCellSub(d,w.N),b=w.index[w.cells+Math.floor(cs/w.subPerCell)]&0x1ffff;
            counts.push(b?w.index[2*w.cells+(b-1)*w.subPerCell+(cs%w.subPerCell)]&255:0);
        }
        rows.push({rid,counts});
    }
    return rows;
}
