import test from 'node:test';
import assert from 'node:assert/strict';
import { remodelMesh,selectMeshLOD } from '../meshRemodel.js';

function mesh(field,origin=[0,0,0],n=8) {
    const samples=new Int8Array((n+1)**3);
    for(let k=0;k<=n;k++)for(let j=0;j<=n;j++)for(let i=0;i<=n;i++)
        samples[(k*(n+1)+j)*(n+1)+i]=Math.max(-127,Math.min(127,Math.round(field(origin[0]+i*.25,origin[1]+j*.25,origin[2]+k*.25))));
    return remodelMesh({samples,size:[n,n,n],origin,spacing:.25});
}
const points=stage=>Array.from({length:stage.vertices.length/6},(_,i)=>Array.from(stage.vertices.slice(i*6,i*6+3)));
const targetPoints=stage=>Array.from({length:stage.vertices.length/6},(_,i)=>Array.from(stage.vertices.slice(i*6+3,i*6+6)));
const surface=(stage,target=false)=>{
    const p=target?targetPoints(stage):points(stage), result=[];
    for(let i=0;i<stage.indices.length;i+=3){
        const triangle=Array.from(stage.indices.slice(i,i+3),j=>p[j]);
        if(new Set(triangle.map(p=>p.join(','))).size<3) continue;
        result.push(triangle.map(p=>p.map(x=>x.toFixed(6)).join(',')).sort().join('/'));
    }
    return result.sort();
};

test('view error rejection stops extraction and a wider tolerance can still build the full surface',()=>{
    const n=8,samples=new Int8Array((n+1)**3);
    for(let k=0;k<=n;k++)for(let j=0;j<=n;j++)for(let i=0;i<=n;i++)
        samples[(k*(n+1)+j)*(n+1)+i]=Math.round((Math.hypot(i-4,j-4,k-4)-2.8)*30);
    const snapshot={samples,size:[n,n,n],origin:[0,0,0],spacing:.25};
    const rejected=remodelMesh({...snapshot,maxError:0});
    assert.equal(rejected.deferred,true);assert.ok(rejected.baseError>0);assert.deepEqual(rejected.stages,[]);
    const complete=remodelMesh(snapshot);
    assert.ok(complete.triangles>100);assert.ok(complete.baseError>=rejected.baseError);
});

test('remodeling extracts empty/full volumes, a plane, and an enclosed cavity without changing density',()=>{
    assert.equal(mesh(()=>127).triangles,0);assert.equal(mesh(()=>-127).triangles,0);
    const plane=mesh((x,y,z)=>(.83-y)*60);
    assert.ok(plane.triangles>0);
    for(const p of points(plane.stages[0]))assert.ok(Math.abs(p[1]-5/15*.25-.75)<1e-6);
    const cave=mesh((x,y,z)=>(Math.hypot(x-1,y-1,z-1)-.7)*127);
    assert.ok(cave.triangles>100);
    for(const s of cave.stages){assert.ok(s.vertices.every(Number.isFinite));assert.ok(s.indices.every(i=>i<s.vertices.length/6));}
});

test('all LODs pin matching border geometry and interpolate continuously to the next topology',()=>{
    const field=(x,y,z)=>(.8+.12*x+.07*z-y)*80;
    const a=mesh(field),b=mesh(field,[2,0,0]);
    const boundary=(s,x)=>points(s).filter(p=>Math.abs(p[0]-x)<1e-6).map(p=>p.map(x=>x.toFixed(6)).join(',')).sort();
    assert.deepEqual(boundary(a.stages[0],2),boundary(b.stages[0],2));
    for(const m of [a,b]) {
        assert.ok(m.stages.at(-1).indices.length<m.stages[0].indices.length);
        for(let i=0;i<m.stages.length-1;i++) {
            assert.deepEqual(surface(m.stages[i],true),surface(m.stages[i+1]));
            const from=points(m.stages[i]),to=targetPoints(m.stages[i]);
            from.forEach((p,j)=>{
                if(p.some((x,c)=>Math.abs(x-[m===a?0:2,0,0][c])<1e-6||Math.abs(x-[m===a?2:4,2,2][c])<1e-6)) assert.deepEqual(to[j],p);
            });
        }
    }
});

test('distance LOD keeps projected error under the limit and reverses without a topology jump',()=>{
    const m=mesh((x,y,z)=>(Math.hypot(x-1,y-1,z-1)-.7)*127);
    assert.equal(selectMeshLOD(m.stages,1e-6),null,'close views retain authoritative density');
    for(let mpp=.001;mpp<10;mpp*=1.01) {
        const choice=selectMeshLOD(m.stages,mpp);if(!choice)continue;
        const s=m.stages[choice.level];
        assert.ok((s.error+(s.targetError-s.error)*choice.morph)/mpp<=.200001);
    }
    let previousEnd=0;
    for(let i=0;i<m.stages.length-1;i++) {
        const end=Math.max(previousEnd,m.stages[i].targetError/.2)*2;
        previousEnd=end;
        const before=selectMeshLOD(m.stages,end*(1-1e-8)),after=selectMeshLOD(m.stages,end);
        if(after.level!==i+1)continue;
        assert.ok(before.morph>1-1e-6);assert.equal(after.morph,0);
        assert.deepEqual(surface(m.stages[i],true),surface(m.stages[i+1]));
    }
});

test('zero density at shared lattice vertices produces finite, nondegenerate triangles',()=>{
    const m=mesh((x,y,z)=>(1-y)*64);
    for(const s of m.stages)assert.ok(s.vertices.every(Number.isFinite));
    assert.ok(m.triangles>0);
});

test('flat patches shed most triangles while curved morphs retain orientation throughout the transition',()=>{
    const plane=mesh((x,y,z)=>(1.83-y)*60,[0,0,0],16);
    assert.ok(plane.stages.at(-1).indices.length<plane.stages[0].indices.length*.15);
    assert.equal(plane.stages.at(-1).error,plane.baseError,'planar remodeling has no surface displacement');
    const curved=mesh((x,y,z)=>(Math.hypot(x-1,y-1,z-1)-.7+.08*Math.sin(x*7)*Math.cos(z*5))*100);
    const normal=([a,b,c])=>[(b[1]-a[1])*(c[2]-a[2])-(b[2]-a[2])*(c[1]-a[1]),
        (b[2]-a[2])*(c[0]-a[0])-(b[0]-a[0])*(c[2]-a[2]),
        (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])];
    for(const stage of curved.stages) {
        const from=points(stage),to=targetPoints(stage);
        for(let i=0;i<stage.indices.length;i+=3) {
            const ids=Array.from(stage.indices.slice(i,i+3)),n=normal(ids.map(j=>from[j]));
            for(const t of [.1,.25,.5,.75,.9]) {
                const moved=normal(ids.map(j=>from[j].map((x,c)=>x*(1-t)+to[j][c]*t)));
                assert.ok(n.reduce((s,x,c)=>s+x*moved[c],0)>=-1e-10,'no intermediate foldover');
            }
        }
    }
});
