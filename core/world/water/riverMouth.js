// Shared river/lake transition coordinates. The terrain cut and both water
// surfaces use this same station, level and footprint.
import { RIVER_SECTION } from './riverSection.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const smooth = (a, b, x) => { const t = clamp((x-a)/(b-a), 0, 1); return t*t*(3-2*t); };

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

export function insertRiverMouthAnchors(rec, mouths, arc, R) {
    const P=rec.points,st=rec.stride,stations=[...arc];
    for(const m of mouths)if(!stations.some(s=>Math.abs(s-m.s)<.001))stations.push(m.s);
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

// Publish the fan in the existing lake distance-field atlas. The lake mesh,
// terrain material and ribbon handover then share one footprint; no extra
// river search is needed in a lake fragment.
export function lakeMouthSurface(lake, lakeId, rivers, R, arcOf, baseMask=lake.mask) {
    if(lake.surfaceDepthMask)return {...lake,mask:baseMask};
    const fr=lake.frame, step=fr.spacing, strips=[];
    const plane=d=>{const k=d[0]*fr.c[0]+d[1]*fr.c[1]+d[2]*fr.c[2];return [
        (d[0]*fr.e1[0]+d[1]*fr.e1[1]+d[2]*fr.e1[2])*R/k,
        (d[0]*fr.e2[0]+d[1]*fr.e2[1]+d[2]*fr.e2[2])*R/k];};
    for(const rec of rivers) {
        if(rec.src!==lakeId && !(rec.dest?.type==='lake'&&rec.dest.id===lakeId))continue;
        const arc=arcOf(rec),P=rec.points,st=rec.stride,n=arc.length;
        for(const m of riverMouths(rec,arc)) {
            if(Math.abs(m.level-lake.level)>.05)continue;
            if((m.sign<0?rec.src:rec.dest?.id)!==lakeId)continue;
            const sample=x=>{
                const s=m.s+m.sign*x;
                let k=0;while(k+2<n&&arc[k+1]<s)k++;
                const t=(s-arc[k])/Math.max(arc[k+1]-arc[k],.001),a=k*st,b=a+st;
                const d=[0,1,2].map(i=>P[a+i]+(P[b+i]-P[a+i])*t);
                const hw=P[a+4]+(P[b+4]-P[a+4])*clamp(t,0,1);
                const depth=Math.max(.6,P[a+5]+(P[b+5]-P[a+5])*clamp(t,0,1));
                const width=riverMouthShape(m,s,hw).width*Math.sqrt(1+.5*RIVER_SECTION.mouth.bankSoftM/depth)+step*.75;
                return {p:plane(d),width};
            };
            const x0=0,x1=RIVER_SECTION.mouth.lakeM*1.2;
            const count=Math.ceil((x1-x0)/(step*.5));
            let a=sample(x0);
            for(let q=1;q<=count;q++) {
                const b=sample(x0+(x1-x0)*q/count);strips.push({a,b});a=b;
            }
        }
    }
    if(!strips.length)return {...lake,mask:baseMask};
    let loX=fr.x0,loY=fr.y0,hiX=fr.x0+fr.nx*step,hiY=fr.y0+fr.ny*step;
    for(const {a,b} of strips)for(const z of [a,b]) {
        loX=Math.min(loX,z.p[0]-z.width-step);hiX=Math.max(hiX,z.p[0]+z.width+step);
        loY=Math.min(loY,z.p[1]-z.width-step);hiY=Math.max(hiY,z.p[1]+z.width+step);
    }
    const dx=Math.ceil((fr.x0-loX)/step),dy=Math.ceil((fr.y0-loY)/step);
    const nx=fr.nx+dx+Math.ceil((hiX-fr.x0-fr.nx*step)/step);
    const ny=fr.ny+dy+Math.ceil((hiY-fr.y0-fr.ny*step)/step);
    const frame={...fr,x0:fr.x0-dx*step,y0:fr.y0-dy*step,nx,ny};
    const mask=new Uint8Array(nx*ny),mouthCells=[];
    for(let j=0;j<fr.ny;j++)mask.set(baseMask.subarray(j*fr.nx,(j+1)*fr.nx),(j+dy)*nx+dx);
    for(const {a,b} of strips) {
        const vx=b.p[0]-a.p[0],vy=b.p[1]-a.p[1],len2=vx*vx+vy*vy;
        if(len2<1e-8)continue;
        const radius=Math.max(a.width,b.width);
        const i0=Math.max(0,Math.floor((Math.min(a.p[0],b.p[0])-radius-frame.x0)/step));
        const i1=Math.min(nx-1,Math.ceil((Math.max(a.p[0],b.p[0])+radius-frame.x0)/step));
        const j0=Math.max(0,Math.floor((Math.min(a.p[1],b.p[1])-radius-frame.y0)/step));
        const j1=Math.min(ny-1,Math.ceil((Math.max(a.p[1],b.p[1])+radius-frame.y0)/step));
        for(let j=j0;j<=j1;j++)for(let i=i0;i<=i1;i++) {
            const x=frame.x0+(i+.5)*step-a.p[0],y=frame.y0+(j+.5)*step-a.p[1];
            const t=(x*vx+y*vy)/len2;
            if(t<0||t>1)continue;
            const width=a.width+(b.width-a.width)*t;
            if(Math.abs(x*vy-y*vx)>width*Math.sqrt(len2))continue;
            const k=j*nx+i;
            if(mask[k]!==2){mouthCells.push(k);mask[k]=2;}
        }
    }
    return {...lake,frame,mask,mouthCells};
}
