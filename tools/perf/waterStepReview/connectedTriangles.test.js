import {describe,it,expect} from 'vitest';
import {connectTriangles,triangleMinRadius,packCoverage} from './connectedTriangles.js';
import {profileCoverageFixture,PROFILE_FIXTURE as P} from './profileCoverage.js';

const R=1000000;
function fixture(kind) {
    const f=profileCoverageFixture(kind),triangles=[];
    const point=(x,y)=>[x*f.spacingM,P.sMinM+y*f.spacingM,R+f.heights[y*f.nx+x]];
    for(let y=0;y<f.ny-1;y++)for(let x=0;x<f.nx-1;x++) {
        const a=point(x,y),b=point(x+1,y),c=point(x+1,y+1),d=point(x,y+1);
        triangles.push([a,b,c],[a,c,d]);
    }
    return {f,triangles,result:connectTriangles(triangles,R+P.waterLevelM,0)};
}
describe('connected triangle coverage prototype',()=>{
    it('covers the connected low bank using the production section fixture',()=>{
        const {f,result}=fixture('connectedLowBank');
        const triangle=2*(40*(f.nx-1)+76);
        expect(result.connected[triangle]).toBe(1);
        expect(result.stats.openWetEdges).toBeGreaterThan(0);
    });
    it('leaves the entire closed pocket disconnected despite submerged ground',()=>{
        const {f,triangles,result}=fixture('closedPocket');
        let submergedPocketTriangles=0;
        triangles.forEach((t,i)=>{
            const x=t.reduce((s,p)=>s+p[0],0)/3,y=t.reduce((s,p)=>s+p[1],0)/3;
            if(x>18.25&&x<19.75&&y>-1.25&&y<1.25&&result.wet[i]) {
                submergedPocketTriangles++;expect(result.connected[i]).toBe(0);
            }
        });
        expect(submergedPocketTriangles).toBeGreaterThan(45);
        expect(result.connected[2*(40*(f.nx-1)+76)]).toBe(0);
    });
    it('finds a submerged triangle interior even when all vertices are dry',()=>{
        const t=[[-2,-2,10],[2,-2,10],[0,2,10]];
        expect(t.every(v=>Math.hypot(...v)>10.1)).toBe(true);
        expect(triangleMinRadius(t)).toBe(10);
        expect(connectTriangles([t],10.1,0).connected[0]).toBe(1);
    });
    it('preserves the selected diagonal at a saddle rather than joining raster diagonals',()=>{
        const a=[-1,-1,R],b=[1,-1,R+2],c=[1,1,R],d=[-1,1,R+2];
        const joined=connectTriangles([[a,b,c],[a,c,d]],R+.75,0);
        const split=connectTriangles([[a,b,d],[b,c,d]],R+.75,0);
        expect(Array.from(joined.connected)).toEqual([1,1]);
        expect(Array.from(split.connected)).toEqual([1,0]);
    });
    it('rejects a dry seed and packs one shared body/level with spatial bins',()=>{
        const triangle=[[0,0,R],[1,0,R],[0,1,R]];
        expect(()=>connectTriangles([triangle],R-1,0)).toThrow('submerged');
        const packed=packCoverage([triangle],new Uint8Array([1]),{c:[0,0,1],e1:[1,0,0],e2:[0,1,0]},1.5,42,R,[-1,-1,2,2]);
        expect(packed.data[7]).toBe(1.5);expect(packed.data[11]).toBe(42);
        expect(packed.stats.references).toBeGreaterThan(0);
    });
});
