// Static prototype topology over the selected terrain mesh. No raster flood.
import {dot,sub,cross} from './contactGeometry.js';

function segmentMinRadius(a,b) {
    const ab=sub(b,a),t=Math.max(0,Math.min(1,-dot(a,ab)/Math.max(dot(ab,ab),1e-30)));
    return Math.hypot(...a.map((v,k)=>v+t*ab[k]));
}

export function triangleMinRadius(v) {
    let result=Math.min(...v.map((a,i)=>segmentMinRadius(a,v[(i+1)%3])));
    const n=cross(sub(v[1],v[0]),sub(v[2],v[0])),nn=dot(n,n);
    if(nn>1e-20) {
        const p=n.map(x=>x*dot(n,v[0])/nn);
        if(v.every((a,i)=>dot(cross(sub(v[(i+1)%3],a),sub(p,a)),n)>=-1e-9))result=Math.min(result,Math.hypot(...p));
    }
    return result;
}

export function connectTriangles(triangles,waterRadius,seedTriangle,{weldM=.001,wetToleranceM=.001}={}) {
    const parent=Int32Array.from(triangles,(_,i)=>i),wet=Uint8Array.from(triangles,v=>triangleMinRadius(v)<waterRadius-wetToleranceM);
    const root=i=>{while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i];}return i;};
    const join=(a,b)=>{a=root(a);b=root(b);if(a!==b)parent[b]=a;};
    const key=p=>p.map(x=>Math.round(x/weldM)).join(',');
    const vertices=new Map(),edges=new Map();
    triangles.forEach((v,i)=>{
        const keys=v.map(key);
        for(let k=0;k<3;k++) {
            if(wet[i]&&Math.hypot(...v[k])<waterRadius-wetToleranceM) {
                if(vertices.has(keys[k]))join(i,vertices.get(keys[k]));else vertices.set(keys[k],i);
            }
            const next=(k+1)%3,ek=[keys[k],keys[next]].sort().join('|');
            let edge=edges.get(ek);if(!edge){edge={triangles:[],wet:segmentMinRadius(v[k],v[next])<waterRadius-wetToleranceM};edges.set(ek,edge);}
            if(edge.wet&&wet[i])for(const j of edge.triangles)if(wet[j])join(i,j);
            edge.triangles.push(i);
        }
    });
    if(!wet[seedTriangle])throw new Error('Coverage seed must lie in submerged terrain');
    const seedRoot=root(seedTriangle),connected=Uint8Array.from(parent,(_,i)=>wet[i]&&root(i)===seedRoot?1:0);
    let openWetEdges=0;const components=new Map(),component=Int32Array.from(parent,(_,i)=>wet[i]?root(i):-1);
    for(let i=0;i<triangles.length;i++)if(wet[i]) {
        const id=component[i];if(!components.has(id))components.set(id,{triangles:0,openWetEdges:0,connected:!!connected[i]});
        components.get(id).triangles++;
    }
    for(const e of edges.values())if(e.wet&&e.triangles.length===1&&wet[e.triangles[0]]) {
        components.get(component[e.triangles[0]]).openWetEdges++;
        if(connected[e.triangles[0]])openWetEdges++;
    }
    return {connected,wet,component,components,stats:{triangles:triangles.length,wetTriangles:wet.reduce((a,b)=>a+b,0),connectedTriangles:connected.reduce((a,b)=>a+b,0),
        wetComponents:new Set(Array.from(parent,(_,i)=>wet[i]?root(i):-1).filter(x=>x>=0)).size,openWetEdges,weldM,wetToleranceM}};
}

export function packCoverage(triangles,connected,frame,level,lakeId,R,patchBounds,cellM=8) {
    const project=p=>{const k=dot(p,frame.c);return [dot(p,frame.e1)/k*R,dot(p,frame.e2)/k*R];};
    const xy=triangles.map(t=>t.map(project));
    const x0=Math.floor(patchBounds[0]/cellM)*cellM,y0=Math.floor(patchBounds[1]/cellM)*cellM;
    const nx=Math.ceil((patchBounds[2]-x0)/cellM)+1,ny=Math.ceil((patchBounds[3]-y0)/cellM)+1;
    if(nx*ny>1000000)throw new Error('Prototype patch exceeds one million spatial bins');
    const bins=Array.from({length:nx*ny},()=>[]);
    xy.forEach((t,i)=>{
        const lo=[0,1].map(k=>Math.floor((Math.min(...t.map(p=>p[k]))-[x0,y0][k])/cellM));
        const hi=[0,1].map(k=>Math.floor((Math.max(...t.map(p=>p[k]))-[x0,y0][k])/cellM));
        for(let y=Math.max(0,lo[1]);y<=Math.min(ny-1,hi[1]);y++)for(let x=Math.max(0,lo[0]);x<=Math.min(nx-1,hi[0]);x++)bins[y*nx+x].push(i);
    });
    const refs=bins.reduce((s,b)=>s+b.length,0),idsAt=5+bins.length,trisAt=idsAt+Math.ceil(refs/4),data=new Float32Array((trisAt+2*triangles.length)*4);
    data.set([...frame.c,R,...frame.e1,level,...frame.e2,lakeId,x0,y0,cellM,nx,ny,5,idsAt,trisAt]);
    let at=0;bins.forEach((list,i)=>{data.set([at,list.length,0,0],(5+i)*4);for(const id of list)data[idsAt*4+at++]=id;});
    xy.forEach((t,i)=>data.set([...t[0],...t[1],...t[2],connected[i],0],(trisAt+2*i)*4));
    return {data,bounds:[x0,y0,x0+nx*cellM,y0+ny*cellM],stats:{bins:bins.length,references:refs,bytes:data.byteLength,maxBinTriangles:bins.reduce((m,b)=>Math.max(m,b.length),0),cellM}};
}

export function coverageWgsl(group,binding) {return `
@group(${group}) @binding(${binding}) var<storage,read> connectedPatch:array<vec4<f32>>;
// 0 = unavailable; -1 = resolved but not connected; 1 = lake component.
fn connectedCoverage(dir:vec3<f32>)->i32 {
    let k=dot(dir,connectedPatch[0].xyz);
    if(k<=0.0){return 0;}
    let p=vec2<f32>(dot(dir,connectedPatch[1].xyz),dot(dir,connectedPatch[2].xyz))/k*connectedPatch[0].w;
    let grid=connectedPatch[3];let ij=vec2<i32>(floor((p-grid.xy)/grid.z));
    let nx=i32(grid.w);let ny=i32(connectedPatch[4].x);
    if(any(ij<vec2<i32>(0))||ij.x>=nx||ij.y>=ny){return 0;}
    let bin=connectedPatch[u32(connectedPatch[4].y)+u32(ij.y*nx+ij.x)];
    var answer=0;
    for(var j=0u;j<u32(bin.y);j++) {
        let refIndex=u32(bin.x)+j;let id=u32(connectedPatch[u32(connectedPatch[4].z)+refIndex/4u][refIndex%4u]);
        let a=connectedPatch[u32(connectedPatch[4].w)+2u*id];let b=connectedPatch[u32(connectedPatch[4].w)+2u*id+1u];
        let v0=a.zw-a.xy;let v1=b.xy-a.xy;let q=p-a.xy;
        let det=v0.x*v1.y-v0.y*v1.x;
        if(abs(det)<1e-8){continue;}
        let u=(q.x*v1.y-q.y*v1.x)/det;let v=(v0.x*q.y-v0.y*q.x)/det;
        if(u>=-0.00001&&v>=-0.00001&&u+v<=1.00001){if(b.z>0.5){return 1;}answer=-1;}
    }
    return answer;
}
`;}
