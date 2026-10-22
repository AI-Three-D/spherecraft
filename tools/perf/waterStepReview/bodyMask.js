// Bounded diagnostic producer. The published mask has no per-pixel triangle lists.
import {dot,sub,triangleInterval} from './contactGeometry.js';

export function clipWet(points,depths) {
    let result=[];
    for(let i=0;i<points.length;i++) {
        const j=(i+1)%points.length,a=points[i],b=points[j],da=depths[i],db=depths[j];
        if(da>0)result.push(a);
        if((da>0)!==(db>0)){const t=da/(da-db);result.push(a.map((v,k)=>v+(b[k]-v)*t));}
    }
    return result;
}

// Cut a lake's wet region by lower connected river regions, retaining both
// pieces around a cut. Coordinates are barycentric, so every cut is on the
// supplied terrain triangle and no whole bank triangle is thrown away.
export function lakeRemainder(triangle,heights,lakeLevel,lower) {
    const clip=(poly,values)=>clipWet(poly,poly.map(p=>dot(p,values)));
    let pieces=[clip([[1,0,0],[0,1,0],[0,0,1]],heights.map(h=>lakeLevel-h))];
    for(const riverDepth of lower) {
        const above=riverDepth.map((d,k)=>d+heights[k]-lakeLevel+.02),next=[];
        for(const p of pieces) {
            next.push(clip(p,above));
            next.push(clip(clip(p,above.map(x=>-x)),riverDepth.map(x=>-x)));
        }
        pieces=next.filter(p=>p.length>=3);
    }
    return pieces.filter(p=>p.length>=3).flatMap(p=>{
        const world=p.map(v=>[0,1,2].map(k=>v.reduce((s,b,i)=>s+b*triangle[i][k],0)));
        return world.slice(1,-1).map((v,i)=>[world[0],v,world[i+2]]);
    });
}

export function clipBox(poly,box) {
    for(const [axis,value,sign] of [[0,box[0],1],[1,box[1],1],[0,box[2],-1],[1,box[3],-1]]) {
        const out=[];
        for(let i=0;i<poly.length;i++) {
            const a=poly[i],b=poly[(i+1)%poly.length],da=(a[axis]-value)*sign,db=(b[axis]-value)*sign;
            if(da>=0)out.push(a);
            if((da>=0)!==(db>=0)){const t=da/(da-db);out.push(a.map((v,k)=>v+(b[k]-v)*t));}
        }
        poly=out;if(!poly.length)break;
    }
    return poly;
}
const area=p=>Math.abs(p.reduce((s,a,i)=>{const b=p[(i+1)%p.length];return s+a[0]*b[1]-a[1]*b[0];},0))/2;

// Piecewise-linear depth on the supplied source triangles. No raster diagonal
// joins. Seeds are centre-line intersections, not every submerged triangle.
export function connectDepths(triangles,depths,seeds,blocked=new Uint8Array(triangles.length)) {
    const wet=Uint8Array.from(depths,(d,i)=>!blocked[i]&&Math.max(...d)>0?1:0),parent=Int32Array.from(triangles,(_,i)=>i);
    const root=i=>{while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i];}return i;};
    const join=(a,b)=>{a=root(a);b=root(b);if(a!==b)parent[b]=a;},vertices=new Map(),edges=new Map();
    triangles.forEach((v,i)=>{
        if(!wet[i])return;const keys=v.map(p=>p.map(x=>Math.round(x*1000)).join(','));
        for(let k=0;k<3;k++) {
            if(depths[i][k]>0){if(vertices.has(keys[k]))join(i,vertices.get(keys[k]));else vertices.set(keys[k],i);}
            const j=(k+1)%3;if(Math.max(depths[i][k],depths[i][j])<=0)continue;
            const key=[keys[k],keys[j]].sort().join('|');
            if(edges.has(key))join(i,edges.get(key));else edges.set(key,i);
        }
    });
    const roots=new Set(seeds.filter(i=>wet[i]).map(root));
    return {wet,connected:Uint8Array.from(wet,(v,i)=>v&&roots.has(root(i))?1:0),seedComponents:roots.size};
}

export function nearestCurve(dir,segments) {
    let best=null,dist=Infinity;
    for(const s of segments) {
        const ab=sub(s.b,s.a),raw=dot(sub(dir,s.a),ab)/dot(ab,ab),t=Math.max(0,Math.min(1,raw));
        const d=dot(sub(dir,s.a.map((v,k)=>v+ab[k]*t)),sub(dir,s.a.map((v,k)=>v+ab[k]*t)));
        if(d<dist){dist=d;best={segment:s,level:s.l0+(s.l1-s.l0)*t,raw,distanceRadians:Math.sqrt(d)};}
    }
    return best;
}

export function riverSeeds(projectedTriangles,segments,project,depths) {
    const line=segments.map(s=>[project(s.a),project(s.b)]),seeds=[];
    projectedTriangles.forEach((p,i)=>{
        if(Math.max(...depths[i])<=0)return;
        for(const [a,b] of line) {
            const span=triangleInterval(a,b,...p);if(!span)continue;
            const t=(span[0]+span[1])/2,q=a.map((v,k)=>v+(b[k]-v)*t);
            const det=(p[1][0]-p[0][0])*(p[2][1]-p[0][1])-(p[1][1]-p[0][1])*(p[2][0]-p[0][0]);
            if(Math.abs(det)<1e-12)continue;
            const u=((q[0]-p[0][0])*(p[2][1]-p[0][1])-(q[1]-p[0][1])*(p[2][0]-p[0][0]))/det;
            const v=((p[1][0]-p[0][0])*(q[1]-p[0][1])-(p[1][1]-p[0][1])*(q[0]-p[0][0]))/det;
            if(depths[i][0]*(1-u-v)+depths[i][1]*u+depths[i][2]*v>0){seeds.push(i);break;}
        }
    });return seeds;
}

// Conservative cell coverage: connected wet polygons may overdraw dry ground.
// A cell also intersecting excluded wet ground is refined, never blindly filled.
// At the refinement limit a conflict is explicit unresolved coverage (owner 0).
export function buildBodyMask({polygons,bodies,bounds,cellM=4,subdivisions=8}) {
    const x0=Math.floor(bounds[0]/cellM)*cellM,y0=Math.floor(bounds[1]/cellM)*cellM;
    const nx=Math.ceil((bounds[2]-x0)/cellM),ny=Math.ceil((bounds[3]-y0)/cellM),bins=Array.from({length:nx*ny},()=>[]);
    for(const poly of polygons) {
        const box=[Math.min(...poly.p.map(p=>p[0])),Math.min(...poly.p.map(p=>p[1])),Math.max(...poly.p.map(p=>p[0])),Math.max(...poly.p.map(p=>p[1]))];
        for(let y=Math.max(0,Math.floor((box[1]-y0)/cellM));y<=Math.min(ny-1,Math.floor((box[3]-y0)/cellM));y++)
            for(let x=Math.max(0,Math.floor((box[0]-x0)/cellM));x<=Math.min(nx-1,Math.floor((box[2]-x0)/cellM));x++)bins[y*nx+x].push(poly);
    }
    const records=Array.from({length:nx*ny},()=>[1,0,0,0]),leaves=[];
    let refinedCells=0,unresolvedCells=0;const explicitKnown=polygons.some(p=>p.known);
    function classify(list,box) {
        const clipped=list.map(p=>({poly:p,area:area(clipBox(p.p,box))})).filter(p=>p.area>1e-10);
        const hits=clipped.map(p=>p.poly),active=new Set(hits.filter(p=>!p.known&&p.connected).map(p=>p.body));
        const conflicts=hits.some(p=>!p.known&&!p.connected&&active.has(p.body));
        const unknown=explicitKnown&&clipped.filter(p=>p.poly.known).reduce((s,p)=>s+p.area,0)<(box[2]-box[0])*(box[3]-box[1])-1e-5;
        const centre=[(box[0]+box[2])/2,(box[1]+box[3])/2];
        const candidates=[...active].map(id=>({id,...bodies[id].at(centre)})).sort((a,b)=>a.level-b.level||a.id-b.id);
        const mixed=candidates.length>1&&candidates.at(-1).level-candidates[0].level>.02;
        if(!candidates.length)return {record:[unknown?0:1,0,0,0],hits,refine:false,unknown};
        const c=candidates.find(c=>c.id===0&&c.level-candidates[0].level<=.02)??candidates[0],owner=c.id===0?2:bodies[c.id].river+3;
        return {record:[owner,(c.segment?.index??-1)+1,c.level,0],hits,refine:conflicts||mixed||unknown,conflicts,unknown};
    }
    for(let y=0;y<ny;y++)for(let x=0;x<nx;x++) {
        const i=y*nx+x,box=[x0+x*cellM,y0+y*cellM,x0+(x+1)*cellM,y0+(y+1)*cellM];
        const c=classify(bins[i],box);
        if(!c.refine){records[i]=c.record;leaves.push({box,record:c.record});if(c.unknown)unresolvedCells++;continue;}
        refinedCells++;const start=records.length;records[i]=[0,0,0,start];
        for(let sy=0;sy<subdivisions;sy++)for(let sx=0;sx<subdivisions;sx++) {
            const size=cellM/subdivisions,b=[box[0]+sx*size,box[1]+sy*size,box[0]+(sx+1)*size,box[1]+(sy+1)*size];
            const s=classify(c.hits,b);if(s.conflicts||s.unknown){s.record=[0,0,0,0];unresolvedCells++;}
            records.push(s.record);leaves.push({box:b,record:s.record});
        }
    }
    const at=xy=>{
        const x=Math.floor((xy[0]-x0)/cellM),y=Math.floor((xy[1]-y0)/cellM);if(x<0||y<0||x>=nx||y>=ny)return [0,0,0,0];
        let r=records[y*nx+x];if(r[3])r=records[r[3]+Math.floor(((xy[1]-y0)/cellM-y)*subdivisions)*subdivisions+Math.floor(((xy[0]-x0)/cellM-x)*subdivisions)];return r;
    };
    return {records,leaves,at,bounds:[x0,y0,x0+nx*cellM,y0+ny*cellM],nx,ny,cellM,subdivisions,
        stats:{baseCells:nx*ny,refinedCells,unresolvedCells,bytes:records.length*16,cellM,minimumCellM:cellM/subdivisions}};
}

export function packBodyMask(mask,frame,R,lakeId,level,segments) {
    const segAt=5+mask.records.length,data=new Float32Array((segAt+segments.length*2)*4);
    data.set([...frame.c,R,...frame.e1,level,...frame.e2,lakeId,...mask.bounds.slice(0,2),mask.cellM,mask.nx,mask.ny,segAt,mask.subdivisions,0]);
    mask.records.forEach((r,i)=>data.set(r,(5+i)*4));
    segments.forEach((s,i)=>data.set([...s.a,s.l0,...s.b,s.l1],(segAt+2*i)*4));return data;
}

export function bodyMaskWgsl(group,binding) {return `
@group(${group}) @binding(${binding}) var<storage,read> connectedPatch:array<vec4<f32>>;
fn connectedRecord(dir:vec3<f32>)->vec4<f32> {
    let k=dot(dir,connectedPatch[0].xyz);if(k<=0.0){return vec4<f32>(0.0);}
    let p=vec2<f32>(dot(dir,connectedPatch[1].xyz),dot(dir,connectedPatch[2].xyz))/k*connectedPatch[0].w;
    let g=(p-connectedPatch[3].xy)/connectedPatch[3].z;let ij=vec2<i32>(floor(g));
    let nx=i32(connectedPatch[3].w);if(any(ij<vec2<i32>(0))||ij.x>=nx||ij.y>=i32(connectedPatch[4].x)){return vec4<f32>(0.0);}
    var r=connectedPatch[5u+u32(ij.y*nx+ij.x)];
    if(r.w>0.0){let n=u32(connectedPatch[4].z);let uv=min(vec2<u32>(fract(g)*f32(n)),vec2<u32>(n-1u));r=connectedPatch[5u+u32(r.w)+uv.y*n+uv.x];}
    return r;
}
fn connectedCoverage(dir:vec3<f32>)->i32 {
    let r=connectedRecord(dir);if(r.x==0.0){return 0;}if(r.x==2.0){return 1;}return -1;
}
fn connectedRiverLevel(dir:vec3<f32>,r:vec4<f32>)->f32 {
    if(r.y<1.0){return r.z;}let i=u32(connectedPatch[4].y)+2u*(u32(r.y)-1u);
    let a=connectedPatch[i];let b=connectedPatch[i+1u];let ab=b.xyz-a.xyz;
    return mix(a.w,b.w,clamp(dot(dir-a.xyz,ab)/max(dot(ab,ab),1e-20),0.0,1.0));
}
`;}
