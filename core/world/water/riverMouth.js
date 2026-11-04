// Shared river/lake transition coordinates. The terrain cut and both water
// surfaces use this same station, level and footprint.
import { RIVER_SECTION } from './riverSection.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const smooth = (a, b, x) => { const t = clamp((x-a)/(b-a), 0, 1); return t*t*(3-2*t); };

const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export function riverMouths(rec, arc) {
    const P=rec.points, st=rec.stride, n=P.length/st, out=[];
    if (st<20 || n<2 || rec.src == null || rec.structured===true) return out;
    if (rec.mouths) return rec.mouths;
    // Compatibility for old records: use the endpoint lake-mask crossing.
    // New traces carry a station measured on the natural terrain below.
    for (const sign of [-1,1]) {
        const end=sign<0?0:n-1;
        if (sign>0 && rec.dest?.type!=='lake') continue;
        if (P[end*st+9]>=0) continue;
        const level=P[end*st+16];
        let k=end;
        while(k-sign>=0 && k-sign<n && P[(k-sign)*st+9]<0) k-=sign;
        const q=clamp(k-sign,0,n-1), hw=.5*(P[k*st+4]+P[q*st+4]);
        out.push({s:.5*(arc[k]+arc[q]),level,hw,sign,landM:clamp(hw*8,64,144)});
    }
    if(out.length===2)for(const m of out)m.landM=Math.min(m.landM,Math.max(1,.45*Math.abs(out[1].s-out[0].s)));
    return out;
}

export function riverMouthAt(mouths, s) {
    let best=null;
    for(const m of mouths)if(!best||Math.abs(m.s-s)<Math.abs(best.s-s))best=m;
    return best;
}

export function riverMouthShape(m, s, hw) {
    if(!m)return {width:hw,influence:0,lakeFade:0,x:-1e20};
    const x=(s-m.s)*m.sign, C=RIVER_SECTION.mouth;
    return {x,width:hw+(m.hw*C.widthScale+C.widthExtraM)*smooth(-m.landM,C.lakeM*.65,x),
        influence:smooth(-m.landM,-.15*m.landM,x),lakeFade:smooth(0,C.lakeM,x)};
}

// Conservative segment support, including the submerged fan beyond a
// record's endpoint. Used by the spatial index and mirrored in the carve.
export function riverMouthIndexReach(m,s0,s1,hw,depth,baseReach) {
    if(!m)return baseReach;
    const C=RIVER_SECTION.mouth,x0=(s0-m.s)*m.sign,x1=(s1-m.s)*m.sign;
    if(Math.max(x0,x1)<=-m.landM||Math.min(x0,x1)>=C.lakeM)return baseReach;
    const width=hw+m.hw*C.widthScale+C.widthExtraM;
    const wet=width*Math.sqrt(1+.5*C.bankSoftM/Math.max(depth,.6));
    return Math.max(baseReach,Math.hypot(wet+C.bankBlendM,C.lakeM));
}

export function riverMouthLevels(rec, arc, levels) {
    if(rec.mouthLevelsBaked)return levels;
    const mouths=riverMouths(rec,arc);
    if(!mouths.length)return levels;
    const out=Float64Array.from(levels);
    for(let k=0;k<out.length;k++) {
        const m=riverMouthAt(mouths,arc[k]), shape=riverMouthShape(m,arc[k],0);
        out[k]+= (m.level-out[k])*shape.influence;
    }
    return out;
}

export function riverMouthsFromTerrain(rec,R,groundAt) {
    const P=rec.points,st=rec.stride,n=P.length/st,arc=new Float64Array(n);
    const at=k=>Array.from(P.subarray(k*st,k*st+3));
    for(let k=1;k<n;k++)arc[k]=arc[k-1]+Math.hypot(...at(k).map((v,i)=>v-at(k-1)[i]))*R;
    const mouths=riverMouths(rec,arc),heights=Array.from({length:n},(_,k)=>groundAt(at(k)));
    for(const m of mouths) {
        let best=null;
        for(let k=0;k+1<n;k++) {
            const a=heights[k]-m.level,b=heights[k+1]-m.level;
            if(a*b>0 || (b-a)*m.sign>=0 || Math.abs(.5*(arc[k]+arc[k+1])-m.s)>160)continue;
            const score=Math.abs(.5*(arc[k]+arc[k+1])-m.s);
            if(!best||score<best.score)best={k,score};
        }
        if(!best)continue;
        const k=best.k,A=at(k),B=at(k+1);
        let lo=0,hi=1;
        for(let q=0;q<14;q++) {
            const t=.5*(lo+hi),d=A.map((v,i)=>v+(B[i]-v)*t),len=Math.hypot(...d);
            const above=groundAt(d.map(v=>v/len))>m.level;
            if(above===(m.sign<0))hi=t;else lo=t;
        }
        const t=.5*(lo+hi);
        m.s=arc[k]+(arc[k+1]-arc[k])*t;
        m.hw=P[k*st+4]+(P[(k+1)*st+4]-P[k*st+4])*t;
        m.landM=clamp(m.hw*8,64,144);
        m.shoreResolved=true;
    }
    if(mouths.length===2)for(const m of mouths)m.landM=Math.min(m.landM,Math.max(1,.45*Math.abs(mouths[1].s-mouths[0].s)));
    return {mouths,arc};
}

// A mouth station within this share of its segment (at most maxM) of an
// existing point moves to that point instead of adding one. The points are
// float32 unit directions (~8 mm on a 131 km planet): a 0.2-2 m segment's
// direction was off by up to ~2 degrees, and where the carve blended its
// section 100 m from the river the ground stepped along a line up the
// hillside (owner 2026-11-02, "zipper").
export const MOUTH_ANCHOR_SNAP = Object.freeze({ share: 0.3, maxM: 5 });
export function insertRiverMouthAnchors(rec, mouths, arc, R) {
    const P=rec.points,st=rec.stride,stations=[...arc];
    for(const m of mouths) {
        let k=0;while(k+2<arc.length&&arc[k+1]<m.s)k++;
        const snap=Math.min(MOUTH_ANCHOR_SNAP.maxM,MOUTH_ANCHOR_SNAP.share*(arc[k+1]-arc[k]));
        const near=[k,k+1].reduce((a,i)=>Math.abs(arc[i]-m.s)<Math.abs(arc[a]-m.s)?i:a,k);
        if(Math.abs(arc[near]-m.s)<=Math.max(snap,.001)) m.s=arc[near];
        else stations.push(m.s);
    }
    stations.sort((a,b)=>a-b);
    const points=new Float32Array(stations.length*st),nextArc=new Float64Array(stations.length);
    let k=0;
    for(let q=0;q<stations.length;q++) {
        const s=stations[q];while(k+2<arc.length&&arc[k+1]<s)k++;
        const t=clamp((s-arc[k])/Math.max(arc[k+1]-arc[k],.001),0,1),o=q*st;
        for(let j=0;j<st;j++)points[o+j]=P[k*st+j]+(P[(k+1)*st+j]-P[k*st+j])*t;
        const len=Math.hypot(points[o],points[o+1],points[o+2]);
        for(let j=0;j<3;j++)points[o+j]/=len;
        points[o+18]=Math.max(P[k*st+18],P[(k+1)*st+18]);
        if(q)nextArc[q]=nextArc[q-1]+Math.hypot(...[0,1,2].map(j=>points[o+j]-points[o-st+j]))*R;
    }
    for(const m of mouths) {
        const index=stations.reduce((a,s,i)=>Math.abs(s-m.s)<Math.abs(stations[a]-m.s)?i:a,0);
        m.s=nextArc[index];m.index=index;
    }
    return {points,arc:nextArc};
}

/**
 * Water level (m) at each point of a traced river (points 16, or the design
 * level 3 on older records), eased to the level of a lake whose mask covers
 * a point over easeM of arc from it, so river and lake surfaces meet.
 * @param {(dir: number[]) => ({ level: number } | null)} lakeAt
 */
export function riverWaterLevels(rec, arc, lakeAt, easeM = 80) {
    const P = rec.points, st = rec.stride, n = P.length / st;
    // Modern traces already contain the surface used to design their bed.
    // Re-anchoring that solution to render masks can select a neighbouring
    // lake, then propagate its level upstream. River 2576 was lifted by
    // 7.64 m this way while its bed stayed at the solved height. Changes to
    // an actual endpoint lake must invalidate/re-solve the trace instead.
    if (st >= 20) return riverMouthLevels(rec, arc, Float64Array.from({ length: n }, (_, k) => P[k * st + 16]));
    const out = new Float64Array(n), toLake = new Float64Array(n).fill(Infinity), lakeLevel = new Float64Array(n);
    for (let k = 0; k < n; k++) {
        out[k] = P[k * st + 3];
        const l = lakeAt([P[k * st], P[k * st + 1], P[k * st + 2]]);
        if (l) { toLake[k] = 0; lakeLevel[k] = l.level; }
    }
    for (let k = 1; k < n; k++) {
        const d = toLake[k - 1] + arc[k] - arc[k - 1];
        if (d < toLake[k]) { toLake[k] = d; lakeLevel[k] = lakeLevel[k - 1]; }
    }
    for (let k = n - 2; k >= 0; k--) {
        const d = toLake[k + 1] + arc[k + 1] - arc[k];
        if (d < toLake[k]) { toLake[k] = d; lakeLevel[k] = lakeLevel[k + 1]; }
    }
    for (let k = 0; k < n; k++) {
        if (Number.isFinite(toLake[k])) {
            out[k] = lakeLevel[k] + (out[k] - lakeLevel[k]) * smoothstep(0, easeM, toLake[k]);
        }
    }
    // Easing toward a lake must never introduce a local upstream slope.
    // First respect downstream lake anchors, then impose the upstream
    // ceiling. This also handles a winding outlet passing near its lake twice.
    let floor = -Infinity;
    for (let k = n - 1; k >= 0; k--) {
        if (toLake[k] === 0) floor = Math.max(floor, lakeLevel[k]);
        out[k] = Math.max(out[k], floor);
    }
    for (let k = 1; k < n; k++) out[k] = Math.min(out[k], out[k - 1]);
    return out;
}
