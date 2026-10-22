// Offline diagnostic geometry. Intersect rays with the triangles selected for
// the actual frame, including transition indices and vertex-stage stitching.
export const dot = (a, b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
export const sub = (a, b) => a.map((v, i) => v-b[i]);
export const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
export const norm = a => { const l=Math.hypot(...a); return a.map(x=>x/l); };

export function makeFrame(centre, radius) {
    const c=norm(centre), e=norm(cross(Math.abs(c[1])<0.9?[0,1,0]:[1,0,0],c)), n=cross(c,e);
    return {c,e,n,radius, project:p=>[dot(p,e)/dot(p,c)*radius,dot(p,n)/dot(p,c)*radius],
        ray:p=>c.map((v,i)=>v*radius+e[i]*p[0]+n[i]*p[1])};
}

function barycentric(p,a,b,c) {
    const det=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1]);
    if(Math.abs(det)<1e-12)return null;
    const u=((b[1]-c[1])*(p[0]-c[0])+(c[0]-b[0])*(p[1]-c[1]))/det;
    const v=((c[1]-a[1])*(p[0]-c[0])+(a[0]-c[0])*(p[1]-c[1]))/det;
    return [u,v,1-u-v];
}

// Exact interval of a projected line segment inside a projected triangle.
export function triangleInterval(p,q,a,b,c) {
    const s=barycentric(p,a,b,c), t=barycentric(q,a,b,c);
    if(!s)return null;
    let lo=0,hi=1;
    for(let k=0;k<3;k++) {
        const delta=t[k]-s[k];
        if(Math.abs(delta)<1e-14) {if(s[k]<-1e-9)return null;}
        else if(delta>0)lo=Math.max(lo,(-1e-9-s[k])/delta);
        else hi=Math.min(hi,(-1e-9-s[k])/delta);
    }
    return lo<=hi?[lo,hi]:null;
}

export class GroundTriangles {
    constructor(frame, bounds, cellM=8) {
        this.frame=frame;this.bounds=bounds;this.cellM=cellM;
        this.triangles=[];this.cells=new Map();this.large=[];this.rejected=0;
    }
    key(x,y) {return (x+32768)+(y+32768)*65536;}
    add(a,b,c) {
        const F=this.frame;
        if([a,b,c].some(v=>dot(v,F.c)<=0))return;
        const p=[a,b,c].map(F.project), box=[Math.min(...p.map(v=>v[0])),Math.min(...p.map(v=>v[1])),Math.max(...p.map(v=>v[0])),Math.max(...p.map(v=>v[1]))];
        const B=this.bounds;
        if(box[2]<B[0]||box[3]<B[1]||box[0]>B[2]||box[1]>B[3]){this.rejected++;return;}
        const normal=cross(sub(b,a),sub(c,a)), d=dot(normal,a);
        if(Math.hypot(...normal)<1e-10)return;
        const id=this.triangles.length;this.triangles.push({p,normal,d});
        const x0=Math.floor(Math.max(box[0],B[0])/this.cellM),x1=Math.floor(Math.min(box[2],B[2])/this.cellM);
        const y0=Math.floor(Math.max(box[1],B[1])/this.cellM),y1=Math.floor(Math.min(box[3],B[3])/this.cellM);
        if((x1-x0+1)*(y1-y0+1)>64){this.large.push(id);return;}
        for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++) {
            const key=this.key(x,y);if(!this.cells.has(key))this.cells.set(key,[]);this.cells.get(key).push(id);
        }
    }
    // The span straddles a raster boundary. Checking every intersected triangle
    // catches a narrow dry sill between pixel centres, unlike two height samples.
    span(p,q,waterPlane) {
        const ids=new Set(this.large), C=this.cellM;
        for(let y=Math.floor(Math.min(p[1],q[1])/C);y<=Math.floor(Math.max(p[1],q[1])/C);y++)
            for(let x=Math.floor(Math.min(p[0],q[0])/C);x<=Math.floor(Math.max(p[0],q[0])/C);x++)
                for(const id of this.cells.get(this.key(x,y))??[])ids.add(id);
        const intervals=[];let min=Infinity,max=-Infinity,mid=null,midGround=null;
        for(const id of ids) {
            const t=this.triangles[id], interval=triangleInterval(p,q,...t.p);
            if(!interval)continue;
            intervals.push(interval);
            for(const u of [interval[0],interval[1],0.5]) {
                if(u<interval[0]||u>interval[1])continue;
                const r=this.frame.ray(p.map((v,k)=>v+(q[k]-v)*u)), len=Math.hypot(...r);
                const gt=t.d/dot(t.normal,r),wt=waterPlane.d/dot(waterPlane.normal,r),drop=(wt-gt)*len;
                if(!Number.isFinite(drop))continue;
                min=Math.min(min,drop);max=Math.max(max,drop);
                if(u===0.5&&(mid===null||drop<mid)){mid=drop;midGround=r.map(v=>v*gt);}
            }
            // A conservative lower bound over the WHOLE triangle interval,
            // not just sampled drops. For positive ray denominators, the
            // water/ground difference has a linear numerator. Bound that
            // numerator from below, both denominators from above, and |ray|
            // by the frame radius. This also covers a shallow interior dip.
            const rays=interval.map(u=>this.frame.ray(p.map((v,k)=>v+(q[k]-v)*u)));
            const wa=rays.map(r=>dot(waterPlane.normal,r)*Math.sign(waterPlane.d));
            const ga=rays.map(r=>dot(t.normal,r)*Math.sign(t.d));
            if(Math.min(...wa,...ga)>0) {
                const numerator=wa.map((v,k)=>Math.abs(waterPlane.d)*ga[k]-Math.abs(t.d)*v);
                if(Math.min(...numerator)>0)min=Math.min(min,
                    Math.min(...numerator)*this.frame.radius/(Math.max(...wa)*Math.max(...ga)));
            }
        }
        intervals.sort((a,b)=>a[0]-b[0]);let end=0;
        for(const i of intervals){if(i[0]>end+1e-7)break;end=Math.max(end,i[1]);}
        return {covered:end>=1-1e-7&&mid!==null,minDropM:min,maxDropM:max,dropM:mid,ground:midGround};
    }
}

export function screenRay(x,y,w,h,inverseViewProjection,camera) {
    const p=[2*x/w-1,1-2*y/h,1,1],o=[0,0,0,0];
    for(let row=0;row<4;row++)for(let k=0;k<4;k++)o[row]+=inverseViewProjection[k*4+row]*p[k];
    return norm(o.slice(0,3).map((v,k)=>v/o[3]-camera[k]));
}

export function planePoint(ray,camera,plane) {
    const denominator=dot(plane.normal,ray);
    if(Math.abs(denominator)<1e-8)return null;
    const distance=(plane.d-dot(plane.normal,camera))/denominator;
    return distance>0?camera.map((v,k)=>v+ray[k]*distance):null;
}

// A separate diagnostic for adjacent visible lake/river surfaces. Screen
// adjacency alone is insufficient: distant projected overlaps are separated.
export function measureWaterJunctions({positions,dxField,dyField,width,height,camera,origin,nearM,maxSeparationM=10}) {
    const rows=[];let projectedSeparatedPairs=0,visibleAdjacencies=0;
    const point=(i,dx,dy)=>{
        const p=[0,1,2].map(k=>positions[4*i+k]+camera[k]-origin[k]),X=dxField.subarray(4*i,4*i+4),Y=dyField.subarray(4*i,4*i+4);
        const b=1+dx*X[3]+dy*Y[3];if(b<=1e-6)return null;
        const n=norm(cross(X,Y));return {p:p.map((v,k)=>v+(dx*X[k]+dy*Y[k])/b),n,d:dot(n,p)};
    };
    for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
        const i=y*width+x,a=positions[4*i+3];if(!(a<0||a>=2))continue;
        if(Math.hypot(...positions.subarray(4*i,4*i+3))>nearM)continue;
        for(const [dx,dy] of [[1,0],[0,1]]) {
            if(x+dx>=width||y+dy>=height)continue;const j=i+dx+dy*width,b=positions[4*j+3];
            if(!((a>=2&&b<0)||(a<0&&b>=2)))continue;visibleAdjacencies++;
            const A=point(i,dx/2,dy/2),B=point(j,-dx/2,-dy/2);if(!A||!B){projectedSeparatedPairs++;continue;}
            const ua=norm(A.p),ub=norm(B.p),separation=Math.hypot(...sub(ua,ub))*(Math.hypot(...A.p)+Math.hypot(...B.p))/2;
            if(separation>maxSeparationM){projectedSeparatedPairs++;continue;}
            const dir=norm(ua.map((v,k)=>v+ub[k])),delta=A.d/dot(A.n,dir)-B.d/dot(B.n,dir);
            if(!Number.isFinite(delta))continue;
            rows.push({x:x+.5+dx/2,y:y+.5+dy/2,lakeAboveRiverM:a>=2?delta:-delta,separationM:separation});
        }
    }
    const drops=rows.map(r=>Math.abs(r.lakeAboveRiverM)).sort((a,b)=>a-b);
    return {visibleAdjacencies,locallyAdjacentPairs:rows.length,projectedSeparatedPairs,maxSeparationM,
        over25cm:rows.filter(r=>Math.abs(r.lakeAboveRiverM)>.25).length,maxAbsoluteStepM:drops.at(-1)??null,
        p95AbsoluteStepM:drops[Math.floor(drops.length*.95)]??null,largest:rows.sort((a,b)=>Math.abs(b.lakeAboveRiverM)-Math.abs(a.lakeAboveRiverM)).slice(0,12)};
}

export function measureContacts({positions,dxField,dyField,width,height,ground,camera,origin,nearM,toleranceM=0.05}) {
    const water=k=>k<0||k>=2, at=(a,i)=>[a[4*i]+camera[0]-origin[0],a[4*i+1]+camera[1]-origin[1],a[4*i+2]+camera[2]-origin[2]];
    const cam=sub(camera,origin), rows=[], examples={},neighbourErrors=[], counts={contact:0,hanging:0,occluded:0,unknown:0,fade:0,viewport:0};
    for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
        const i=y*width+x,kind=positions[4*i+3];if(!water(kind))continue;
        for(const [dx,dy]of[[1,0],[-1,0],[0,1],[0,-1]]) {
            const xx=x+dx,yy=y+dy;
            if(xx<0||yy<0||xx>=width||yy>=height){counts.viewport++;continue;}
            const j=yy*width+xx;if(water(positions[4*j+3]))continue;
            const wp=at(positions,i), X=Array.from(dxField.subarray(4*i,4*i+4)),Y=Array.from(dyField.subarray(4*i,4*i+4));
            const normal=norm(cross(X,Y)),plane={normal,d:dot(normal,wp)};
            const point=(sx,sy)=>{const b=1+sx*X[3]+sy*Y[3];return b>1e-6?wp.map((v,k)=>v+(sx*X[k]+sy*Y[k])/b):null;};
            const pixel=[x+0.5+dx/2,y+0.5+dy/2];
            if(Math.hypot(...sub(wp,cam))>nearM){counts.fade++;continue;}
            const outside=point(dx,dy);
            let status='unknown',m=null,lengthM=null;
            if(outside) {
                // A foreground object/terrain silhouette is not an exposed
                // water truncation. Only terrain is drawn in this diagnostic.
                const terrain=positions[4*j+3]===1?at(positions,j):null;
                if(terrain&&Math.hypot(...sub(terrain,cam))+toleranceM<Math.hypot(...sub(outside,cam)))status='occluded';
                else {
                    const p=ground.frame.project(wp),q=ground.frame.project(outside);
                    // Avoid enormous grazing spans; those need a different view.
                    if(Math.hypot(p[0]-q[0],p[1]-q[1])<100) {
                        m=ground.span(p,q,plane);
                        if(m.covered)status=m.minDropM>toleranceM?'hanging':'contact';
                    }
                }
                const ends=[-0.5,0.5].map(t=>point(dx/2+dy*t,dy/2-dx*t));
                if(ends.every(Boolean))lengthM=Math.hypot(...sub(ends[0],ends[1]));
            }
            counts[status]++;
            rows.push({x:pixel[0],y:pixel[1],waterIndex:i,neighbourIndex:j,kind:kind>=2?'lake':'river',body:kind>=2?kind-2:-kind-1,status,lengthM,
                dropM:m?.dropM??null,minDropM:m?.minDropM??null,maxDropM:m?.maxDropM??null});
            const type=kind>=2?'lake':'river';
            if(status==='hanging'&&m.dropM>(examples[type]?.dropM??-Infinity))examples[type]={...rows.at(-1),
                groundPlanetRelative:m.ground,waterPlanetRelative:m.ground.map((v,k)=>v+norm(m.ground)[k]*m.dropM)};
        }
    }
    const summary={};
    for(const kind of ['lake','river']) {
        const group=rows.filter(e=>e.kind===kind),hang=group.filter(e=>e.status==='hanging'), drops=hang.map(e=>e.dropM).sort((a,b)=>a-b);
        summary[kind]={boundaryGridEdges:group.length,hangingGridEdges:hang.length,hangingWorldGridLengthM:hang.reduce((s,e)=>s+(e.lengthM??0),0),
            dropP50M:drops.length?drops[Math.floor(drops.length/2)]:null,dropP95M:drops.length?drops[Math.floor(.95*(drops.length-1))]:null,maxDropM:drops.at(-1)??null};
    }
    // Validate extrapolation against a visible neighbour in the same GPU quad.
    // Different primitives can occupy those pixels, so report outliers too.
    for(let i=0;i<width*height;i+=997) {
        if(!water(positions[4*i+3]) || i%width>=width-1)continue;
        const sign=(i%width)%2===0?1:-1,j=i+sign;
        if(positions[4*j+3]!==positions[4*i+3])continue;
        const p=at(positions,i),q=at(positions,j),b=1+sign*dxField[4*i+3];
        const prediction=p.map((v,k)=>v+sign*dxField[4*i+k]/b);
        neighbourErrors.push(Math.hypot(...sub(prediction,q)));
    }
    neighbourErrors.sort((a,b)=>a-b);
    return {width,height,toleranceM,nearM,counts,summary,examples,
        waterPixelCrossCheck:{samples:neighbourErrors.length,p50M:neighbourErrors[Math.floor(neighbourErrors.length*.5)],p95M:neighbourErrors[Math.floor(neighbourErrors.length*.95)],maxM:neighbourErrors.at(-1)},edges:rows};
}
