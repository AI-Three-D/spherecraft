// Sample across traced-segment bisectors. Extrapolating from either side
// separates a height discontinuity from the ordinary slope of the bank.
export async function jointSeams({ id, k0 = 1, k1 = 1e9, offsets = [-60,-40,-25,-15,15,25,40,60], eps = 0.5 }) {
    const g = window.gameEngine, svc = g.waterService, w = g.waterGpuData, R = w.R;
    const q = await import('/tools/perf/waterStepReview/qualityScene.js');
    await q.riverView(id, 0.7, {height:150,back:100});
    const rec = svc.riverRecs.get(id), P = rec.points, st = rec.stride, n = P.length / st;
    const at = k => Array.from(P.slice(k*st,k*st+3));
    const add = (a,b) => a.map((v,i)=>v+b[i]);
    const sub = (a,b) => a.map((v,i)=>v-b[i]);
    const mul = (a,b) => a.map(v=>v*b);
    const dot = (a,b) => a.reduce((s,v,i)=>s+v*b[i],0);
    const norm = a => mul(a,1/Math.hypot(...a));
    const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
    const dirs = [], rows = [];
    for (let k=Math.max(1,k0);k<=Math.min(n-2,k1);k++) {
        const p = at(k), u = norm(sub(p,at(k-1))), v = norm(sub(at(k+1),p));
        const b = norm(add(u,v)), left = norm(cross(p,b));
        for (const offset of offsets) {
            const c = add(p,mul(left,offset/R));
            for (const x of [-2,-1,0,1,2]) dirs.push(...norm(add(c,mul(b,x*eps/R))),0);
            rows.push({k,offset,turnDeg:Math.acos(Math.min(1,dot(u,v)))*180/Math.PI});
        }
    }
    const h = await svc._sampler.sampleDirsCarved(Float32Array.from(dirs));
    const natural = await svc._sampler.sampleDirsNatural(Float32Array.from(dirs));
    const discontinuity = a => Math.abs((2*a[3]-a[4])-(2*a[1]-a[0]));
    const result = rows.map((r,i)=>{
        const a=Array.from(h.slice(5*i,5*i+5)), b=Array.from(natural.slice(5*i,5*i+5));
        return {...r,heights:a,natural:b,jumpM:discontinuity(a),naturalJumpM:discontinuity(b),
            slopeJump:Math.abs((a[4]-a[3])-(a[1]-a[0]))/eps};
    });
    return {id,eps,rows:result,largest:[...result].sort((a,b)=>b.jumpM-a.jumpM).slice(0,15)};
}
