// Ground truth through the whole junction, including the lake beyond a
// river record's endpoint. x increases lakeward at either end.
export async function mouthSections({id,sign=1,stepM=4,across=[0,-20,20,-40,40,-60,60]}) {
    const g=window.gameEngine,s=g.waterService,w=g.waterGpuData,R=w.R;
    const q=await import('/tools/perf/waterStepReview/qualityScene.js');
    await q.riverView(id,sign<0?.05:.95,{height:160,back:100});
    const rec=s.riverRecs.get(id),P=rec.points,st=rec.stride,arc=w._arcLengths(rec);
    const {riverMouths,riverMouthShape}=await import('/core/world/water/riverMouth.js');
    const mouth=riverMouths(rec,arc).find(m=>m.sign===sign);
    if(!mouth)return {id,sign,missing:true};
    const norm=a=>a.map(v=>v/Math.hypot(...a));
    const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
    const dirs=[],samples=[];
    for(let x=-Math.ceil(mouth.landM/stepM)*stepM;x<=144;x+=stepM) {
        const a=mouth.s+x*sign;let k=0;while(k+2<arc.length&&arc[k+1]<a)k++;
        const t=(a-arc[k])/Math.max(.001,arc[k+1]-arc[k]),u=Math.max(0,Math.min(1,t));
        const A=Array.from(P.subarray(k*st,k*st+3)),B=Array.from(P.subarray((k+1)*st,(k+1)*st+3));
        const d=norm(A.map((v,j)=>v+(B[j]-v)*t)),left=norm(cross(d,B.map((v,j)=>v-A[j])));
        const level=P[k*st+16]+(P[(k+1)*st+16]-P[k*st+16])*u;
        const hw=P[k*st+4]+(P[(k+1)*st+4]-P[k*st+4])*u;
        for(const c of across) {
            const dir=norm(d.map((v,j)=>v+left[j]*c/R));dirs.push(...dir,0);
            samples.push({x,c,k,level,width:riverMouthShape(mouth,a,hw).width,dir});
        }
    }
    const D=Float32Array.from(dirs),h=await s._sampler.sampleDirsCarved(D),natural=await s._sampler.sampleDirsNatural(D);
    const rows=samples.map((p,i)=>({...p,dir:undefined,carved:h[i],natural:natural[i],cut:natural[i]-h[i]}));
    return {id,sign,mouth,baked:rec.mouthLevelsBaked,rows,points:Array.from({length:arc.length},(_,k)=>({s:arc[k],level:P[k*st+16],ground:P[k*st+13],hw:P[k*st+4],depth:P[k*st+5]}))};
}

export async function surfaceState({id}) {
    const g=window.gameEngine,w=g.waterGpuData,s=g.waterService;
    await (await import('/tools/perf/waterStepReview/qualityScene.js')).riverView(id,.08,{height:160,back:100});
    const rec=s.riverRecs.get(id),ids=[rec.src,rec.dest?.id].filter(x=>x!=null);
    const {lakeSdfAt}=await import('/core/world/water/lakeMaskSdf.js');
    const at=k=>Array.from(rec.points.subarray(k*rec.stride,k*rec.stride+3));
    return {id,mouths:rec.mouths,lakes:ids.map(id=>{
        const orig=w._applied.get(id),v=w._surfaceOf.get(id),slot=w._layerOf.get(id),F=w._sdfCache.get(v);
        if(!v)return {id,missing:true};
        const f=v.frame,R=w.R;
        const xy=d=>{const q=d.reduce((a,z,j)=>a+z*f.c[j],0);return [d.reduce((a,z,j)=>a+z*f.e1[j],0)*R/q,d.reduce((a,z,j)=>a+z*f.e2[j],0)*R/q];};
        return {id,slot,frame:f,oldFrame:orig.frame,level:v.level,depthMask:!!v.surfaceDepthMask,added:v.mouthCells?.length,
            stations:Array.from({length:Math.min(rec.points.length/rec.stride,24)},(_,k)=>{const d=at(k),p=xy(d);return {k,xy:p,F:F?lakeSdfAt(F,f,...p):null,lakeAt:w.lakeAt(d)};})};
    })};
}

export function riversHere() {
    const g=window.gameEngine,s=g.waterService,p=g.camera.position;
    const d=[p.x,p.y,p.z].map(x=>x/Math.hypot(p.x,p.y,p.z));
    return s.rivers.map(r=>({id:r.id,distance:s._riverDistance(r.id,d)})).sort((a,b)=>a.distance-b.distance).slice(0,5).map(v=>{
        const rec=s.riverRecs.get(v.id);
        return {...v,src:rec?.src,dest:rec?.dest,mouths:rec?.mouths,stride:rec?.stride,points:rec?Array.from(rec.points):null};
    });
}

export async function riversAtView({view}) {
    await(await import('/tools/perf/waterStepReview/qualityScene.js')).poseView(view);
    return riversHere();
}
