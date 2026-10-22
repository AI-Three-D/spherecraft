import {describe,it,expect} from 'vitest';
import {buildBodyMask,clipWet,connectDepths,lakeRemainder} from './bodyMask.js';
import {profileCoverageFixture,PROFILE_FIXTURE as P} from './profileCoverage.js';
const square=(x0,y0,x1,y1)=>[[x0,y0],[x1,y0],[x1,y1],[x0,y1]];
const lake={at:()=>({level:10})};
describe('cached conservative body masks',()=>{
    it('may extend a connected shoreline into dry bank',()=>{
        const m=buildBodyMask({polygons:[{p:square(0,0,1,4),body:0,connected:true}],bodies:[lake],bounds:[0,0,4,4]});
        expect(m.at([3,2])[0]).toBe(2);expect(m.stats.refinedCells).toBe(0);
    });
    it('refines a coarse cell rather than flooding a disconnected dip over a ridge',()=>{
        const m=buildBodyMask({polygons:[{p:square(0,0,1,4),body:0,connected:true},{p:square(3,0,4,4),body:0,connected:false}],bodies:[lake],bounds:[0,0,4,4]});
        expect(m.stats.refinedCells).toBe(1);expect(m.at([.25,2])[0]).toBe(2);expect(m.at([3.75,2])[0]).toBe(1);
    });
    it('reports unresolved subcells when even the finest cell straddles two wet components',()=>{
        const m=buildBodyMask({polygons:[{p:square(0,0,.1,4),body:0,connected:true},{p:square(.2,0,.4,4),body:0,connected:false}],bodies:[lake],bounds:[0,0,4,4]});
        expect(m.stats.unresolvedCells).toBeGreaterThan(0);expect(m.at([.3,2])[0]).toBe(0);
    });
    it('assigns overlapping wet areas to the lower river, retaining lake ownership at equal levels',()=>{
        const polygons=[{p:square(0,0,4,4),body:0,connected:true},{p:square(0,0,4,4),body:1,connected:true}];
        const m=buildBodyMask({polygons,bodies:[lake,{river:7,at:xy=>({level:10-xy[1],segment:{index:0}})}],bounds:[0,0,4,4]});
        expect(m.at([2,3])[0]).toBe(10);
        const equal=buildBodyMask({polygons,bodies:[lake,{river:7,at:()=>({level:10})}],bounds:[0,0,4,4]});
        expect(equal.at([2,2])[0]).toBe(2);
    });
    it('cuts only the lower river wet region, keeping bank ground between the two levels available to the lake',()=>{
        const tr=[[0,0,0],[4,0,4],[0,4,0]],h=[0,4,0];
        const pieces=lakeRemainder(tr,h,10,[[2,-2,2]]);
        expect(pieces.length).toBeGreaterThan(0);
        for(const p of pieces.flat())expect(p[2]).toBeGreaterThanOrEqual(2-1e-8);
        // This is precisely why lower ownership alone does not prove that
        // a higher lake cannot continue down a connected valley bank.
        expect(Math.max(...pieces.flat().map(p=>p[2]))).toBe(4);
    });
    it('preserves the closed-pocket production section fixture under per-body depth connectivity',()=>{
        const f=profileCoverageFixture('closedPocket'),triangles=[],depths=[],seeds=[];
        const point=(x,y)=>[x*f.spacingM,P.sMinM+y*f.spacingM,f.heights[y*f.nx+x]];
        for(let y=0;y<f.ny-1;y++)for(let x=0;x<f.nx-1;x++) {
            const a=point(x,y),b=point(x+1,y),c=point(x+1,y+1),d=point(x,y+1);
            if(x===0)seeds.push(triangles.length,triangles.length+1);
            triangles.push([a,b,c],[a,c,d]);depths.push([a,b,c].map(p=>1.5-p[2]),[a,c,d].map(p=>1.5-p[2]));
        }
        const result=connectDepths(triangles,depths,seeds);let pocket=0;
        triangles.forEach((tr,i)=>{const x=tr.reduce((s,p)=>s+p[0],0)/3,y=tr.reduce((s,p)=>s+p[1],0)/3;
            if(x>18.25&&x<19.75&&y>-1.25&&y<1.25&&result.wet[i]){pocket++;expect(result.connected[i]).toBe(0);}});
        expect(pocket).toBeGreaterThan(45);
    });
    it('clips wet polygons without dropping a sliver that must receive coverage',()=>{
        const p=clipWet([[0,0],[4,0],[0,4]],[.01,-10,-10]);expect(p.length).toBe(3);
        const m=buildBodyMask({polygons:[{p,body:0,connected:true}],bodies:[lake],bounds:[0,0,4,4]});expect(m.at([0,0])[0]).toBe(2);
    });
    it('does not certify unavailable ground as dry bank or extend water into it',()=>{
        const m=buildBodyMask({polygons:[{p:square(0,0,2,4),known:true},
            {p:square(0,0,1,4),body:0,connected:true}],bodies:[lake],bounds:[0,0,4,4]});
        expect(m.at([.25,2])[0]).toBe(2);expect(m.at([3,2])[0]).toBe(0);
        expect(m.stats.unresolvedCells).toBeGreaterThan(0);
    });
});
