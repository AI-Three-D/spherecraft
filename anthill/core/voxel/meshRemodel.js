// DOM-free worker implementation. All positions are region local, never planet float32.
const corners = [[0,0,0],[1,0,0],[0,1,0],[1,1,0],[0,0,1],[1,0,1],[0,1,1],[1,1,1]];
// Freudenthal tetrahedra use the same face diagonals in every adjacent cell.
const tetrahedra = [[0,1,3,7],[0,1,5,7],[0,2,3,7],[0,2,6,7],[0,4,5,7],[0,4,6,7]];
const distance = (a,b) => Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);
const cross = (a,b,c) => [(b[1]-a[1])*(c[2]-a[2])-(b[2]-a[2])*(c[1]-a[1]),
    (b[2]-a[2])*(c[0]-a[0])-(b[0]-a[0])*(c[2]-a[2]),
    (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])];

// Signed area during a linear vertex morph is quadratic. Checking only the
// destination can miss an inversion halfway through an otherwise valid collapse.
function foldsDuringMorph(from,to) {
    const normal=cross(...from),dot=n=>normal.reduce((s,x,c)=>s+x*n[c],0);
    const start=dot(normal),end=dot(cross(...to));
    const epsilon=start*1e-10;
    if(end < -epsilon) return true;
    const middle=dot(cross(...from.map((p,i)=>p.map((x,c)=>(x+to[i][c])*.5))));
    const a=2*(start+end-2*middle),b=end-start-a;
    const t=a>0?-b/(2*a):0;
    return t>0&&t<1&&start+b*t+a*t*t < -epsilon;
}

// Trilinear/tetrahedral interpolation remainder. Singular cells deliberately keep
// a whole-cell bound: those features cannot enter the mesh path at close range.
function cellError(q, spacing) {
    const e=q[3]-q[2]-q[1]+q[0], f=q[5]-q[4]-q[1]+q[0], g=q[6]-q[4]-q[2]+q[0];
    const h=q[7]-q[6]-q[5]-q[3]+q[4]+q[2]+q[1]-q[0];
    let slope=0;
    for (const axis of [1,2,4]) {
        const d=[];
        for(let c=0;c<8;c++) if(!(c&axis)) d.push(q[c|axis]-q[c]);
        if(d.every(x=>x>0)||d.every(x=>x<0)) slope=Math.max(slope,Math.min(...d.map(Math.abs)));
    }
    const residual=(Math.abs(e)+Math.abs(f)+Math.abs(g))*0.25+Math.abs(h)*0.385;
    return Math.min(Math.sqrt(3)*spacing, slope>0 ? 2*residual/slope*spacing : Math.sqrt(3)*spacing);
}

/** Extract a complete surface, then remodel its interior into progressively fewer triangles.
 * Borders are pinned. LOD stages retain the preceding topology while morphing;
 * only triangles whose vertices have converged are removed from the next stage.
 */
export function remodelMesh({ samples, size, origin, spacing, maxError=Infinity, tolerances = [0.03125,0.125,0.5] }) {
    const [nx,ny,nz]=size, sx=nx+1, sy=ny+1;
    const at=(i,j,k)=>(k*sy+j)*sx+i;
    const vertices=[], triangles=[], edgeVertices=new Map();
    let error=0;
    const vertex=(a,b,ids,points,q)=>{
        // Exact zeros are consistently air, and all incident edges share one vertex.
        const t=q[a]/(q[a]-q[b]);
        const ia=ids[a],ib=ids[b];
        const key=t===0?`v${ia}`:t===1?`v${ib}`:ia<ib?`${ia}:${ib}`:`${ib}:${ia}`;
        let id=edgeVertices.get(key);
        if(id===undefined) {
            id=vertices.length;edgeVertices.set(key,id);
            vertices.push(points[a].map((p,c)=>origin[c]+(p+(points[b][c]-p)*t)*spacing));
        }
        return id;
    };
    const add=(a,b,c)=>{
        if(a!==b&&a!==c&&b!==c && Math.hypot(...cross(vertices[a],vertices[b],vertices[c]))>1e-12) triangles.push(a,b,c);
    };
    for(let k=0;k<nz;k++) for(let j=0;j<ny;j++) for(let i=0;i<nx;i++) {
        const points=corners.map(c=>[i+c[0],j+c[1],k+c[2]]);
        const ids=points.map(p=>at(...p)), q=ids.map(id=>samples[id]);
        if(q.every(x=>x>0)||q.every(x=>x<=0)) continue;
        error=Math.max(error,cellError(q,spacing));
        // Even the finest mesh cannot satisfy this view. Keep only a lower
        // bound so the cache can retry after zooming out, without extracting
        // and simplifying thousands of triangles that cannot be displayed.
        if(error>maxError) return {stages:[],baseError:error,triangles:0,deferred:true};
        for(const tet of tetrahedra) {
            const solid=tet.filter(c=>q[c]>0), air=tet.filter(c=>q[c]<=0);
            if(!solid.length||!air.length) continue;
            if(solid.length===1||air.length===1) {
                const one=solid.length===1?solid[0]:air[0], other=solid.length===1?air:solid;
                add(...other.map(b=>vertex(one,b,ids,points,q)));
            } else {
                const a=vertex(solid[0],air[0],ids,points,q),b=vertex(solid[0],air[1],ids,points,q);
                const c=vertex(solid[1],air[0],ids,points,q),d=vertex(solid[1],air[1],ids,points,q);
                add(a,b,c);add(b,d,c);
            }
        }
    }
    const baseError=error+spacing*1e-5;
    const bounds=origin.map((x,c)=>x+size[c]*spacing);
    let positions=vertices, indices=triangles, displacement=0;
    const stages=[];
    for(const tolerance of tolerances) {
        if(!indices.length) break;
        const {targets,nextPositions,nextIndices,maxError}=cluster(positions,indices,origin,bounds,tolerance);
        if(nextIndices.length===indices.length) continue;
        stages.push(pack(positions,targets,indices,baseError+displacement,baseError+displacement+maxError));
        displacement+=maxError;
        positions=nextPositions;indices=nextIndices;
    }
    stages.push(pack(positions,positions,indices,baseError+displacement,baseError+displacement));
    return {stages,baseError,triangles:triangles.length/3};
}

function cluster(positions,indices,min,max,tolerance) {
    const parent=positions.map((_,i)=>i);
    const root=i=>{while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i];}return i;};
    const border=p=>p.some((x,c)=>Math.abs(x-min[c])<1e-6||Math.abs(x-max[c])<1e-6);
    const keys=positions.map(p=>border(p)?null:p.map((x,c)=>Math.floor((x-min[c])/(tolerance*1.1547))).join(','));
    // Only merge connected vertices in one cluster. Parallel surfaces and nearby
    // disconnected passages never join just because they occupy the same bin.
    for(let t=0;t<indices.length;t+=3) for(let e=0;e<3;e++) {
        const a=indices[t+e],b=indices[t+(e+1)%3];
        if(keys[a]!==null&&keys[a]===keys[b]) parent[root(a)]=root(b);
    }
    const groups=new Map();
    positions.forEach((p,i)=>{const id=root(i);if(!groups.has(id))groups.set(id,[]);groups.get(id).push(i);});
    const centers=new Map(),rejected=new Set();
    for(const [id,list] of groups) {
        const center=[0,0,0];
        for(const i of list) for(let c=0;c<3;c++) center[c]+=positions[i][c]/list.length;
        centers.set(id,center);
        if(list.some(i=>distance(positions[i],center)>tolerance)) rejected.add(id);
    }
    const target=i=>rejected.has(root(i))?positions[i]:centers.get(root(i));
    // Reject foldovers. A collapse to a line/point is allowed and becomes a
    // degenerate triangle at the end of the continuous transition.
    for(let pass=0;pass<3;pass++) {
        let changed=false;
        for(let t=0;t<indices.length;t+=3) {
            const ids=indices.slice(t,t+3);
            if(foldsDuringMorph(ids.map(i=>positions[i]),ids.map(target))) {
                for(const i of ids) {const r=root(i);if(!rejected.has(r)){rejected.add(r);changed=true;}}
            }
        }
        if(!changed)break;
    }
    const targets=positions.map((_,i)=>target(i));
    for(let t=0;t<indices.length;t+=3) {
        const ids=indices.slice(t,t+3);
        if(foldsDuringMorph(ids.map(i=>positions[i]),ids.map(i=>targets[i])))
            return {targets:positions,nextPositions:positions,nextIndices:indices,maxError:0};
    }
    const nextPositions=[],nextIndices=[],remap=new Map();
    for(let t=0;t<indices.length;t+=3) {
        const ids=indices.slice(t,t+3).map(i=>{
            const key=rejected.has(root(i))?i:root(i);
            if(!remap.has(key)){remap.set(key,nextPositions.length);nextPositions.push(targets[i]);}
            return remap.get(key);
        });
        if(new Set(ids).size===3) nextIndices.push(...ids);
    }
    // Vertex displacement also bounds every point of its source triangle during
    // the morph. Incident-plane distance alone underestimates curved surfaces.
    // Exactly coplanar contractions preserve the surface and cost zero error.
    let maxError=0;
    for(let t=0;t<indices.length;t+=3) {
        const ids=indices.slice(t,t+3),p=ids.map(i=>positions[i]),n=cross(...p),length=Math.hypot(...n);
        if(length<1e-12)continue;
        for(const i of ids) {
            const normalError=Math.abs(n.reduce((s,x,c)=>s+x*(targets[i][c]-positions[i][c]),0))/length;
            if(normalError>1e-10) maxError=Math.max(maxError,distance(targets[i],positions[i]));
        }
    }
    return {targets,nextPositions,nextIndices,maxError};
}

function pack(positions,targets,indices,error,targetError) {
    const data=new Float32Array(positions.length*6);
    positions.forEach((p,i)=>{data.set(p,i*6);data.set(targets[i],i*6+3);});
    return {vertices:data,indices:new Uint32Array(indices),error,targetError};
}

// Pure selection is shared by the renderer and tests. At the boundary the finer
// stage has morphed exactly onto the next stage, including on a zoom reversal.
export function selectMeshLOD(stages,metersPerPixel,pixelError=0.2) {
    if(!stages.length||stages[0].error>metersPerPixel*pixelError) return null;
    let previousEnd=0;
    for(let i=0;i<stages.length;i++) {
        const stage=stages[i];
        if(i===stages.length-1) return {level:i,morph:0};
        const start=Math.max(previousEnd,stage.targetError/pixelError), end=start*2;
        if(metersPerPixel<end) return {level:i,morph:Math.max(0,Math.min(1,(metersPerPixel-start)/(end-start)))};
        previousEnd=end;
    }
}
