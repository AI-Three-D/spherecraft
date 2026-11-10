import {describe,it,expect} from 'vitest';
import {regionalShapeBounds,sampleRegionalShape,planRegionalShapeLake,shapeThresholdRegion} from './regionalShapeModel.js';

describe('authoritative shape containment',()=>{
    it('reuses one field hull for separate lakes and rejects a second owner of its retaining ring',()=>{
        const n=128,controls=new Float32Array((n+3)**2);
        for(let y=0;y<n+3;y++)for(let x=0;x<n+3;x++)controls[y*(n+3)+x]=Math.min(1000+((x-34)**2+(y-34)**2)*.07,1010+((x-95)**2+(y-95)**2)*.07);
        const preparedBounds=regionalShapeBounds(controls,n),excludedCells=new Uint8Array(n*n),args={controls,cells:n,preparedBounds,excludedCells,maxCandidates:1,radiusOfCells:()=>100};
        const a=planRegionalShapeLake({...args,candidateSeeds:[33*n+33]}),b=planRegionalShapeLake({...args,candidateSeeds:[94*n+94]});
        expect(a.rejected).toBeUndefined();expect(b.rejected).toBeUndefined();expect(b.levelM).toBeGreaterThan(a.levelM);
        for(let k=0;k<a.region.length;k++)if(a.region[k])excludedCells[k]=1;
        expect(planRegionalShapeLake({...args,candidateSeeds:[33*n+33]}).rejected).toBe(true);
        expect(planRegionalShapeLake({...args,candidateSeeds:[94*n+94]}).proof.minimumRimM).toBeGreaterThan(.5);
    });
    it('encloses saddle/extrema interiors with tighter Bezier hulls than raw controls',()=>{
        const n=16,a=new Float32Array((n+3)**2);
        for(let y=0;y<n+3;y++) for(let x=0;x<n+3;x++) a[y*(n+3)+x]=800+Math.sin(x*1.7)*17+Math.cos(y*.9)*23+x*y*.7;
        const b=regionalShapeBounds(a,n);
        for(let y=0;y<n;y++) for(let x=0;x<n;x++) for(const u of [0,.13,.5,.81,.999999]) for(const v of [0,.21,.5,.79,.999999]) {
            const h=sampleRegionalShape(a,n,x+u,y+v),k=y*n+x;
            expect(h).toBeGreaterThanOrEqual(b.lower[k]-1e-9);expect(h).toBeLessThanOrEqual(b.upper[k]+1e-9);
        }
    });
    it('finds a bounded depression and proves its full wet cell and retaining ring',()=>{
        const n=64,a=new Float32Array((n+3)**2);
        for(let y=0;y<n+3;y++) for(let x=0;x<n+3;x++) a[y*(n+3)+x]=1000+Math.hypot(x-33,y-33)**2*.025;
        const p=planRegionalShapeLake({controls:a,cells:n,radiusOfCells:(ids,c)=>Math.max(...Array.from(ids,k=>Math.hypot(k%n-c%n,Math.floor(k/n)-Math.floor(c/n))))*4+6});
        expect(p.rejected).toBeUndefined();expect(p.proof.minimumRimM).toBeGreaterThan(.5);
        expect(p.proof.guaranteedDepthM).toBeGreaterThanOrEqual(1.5);
        const b=regionalShapeBounds(a,n);
        for(let k=0;k<n*n;k++) if(p.region[k]) {
            const x=k%n,y=Math.floor(k/n);
            for(let j=0;j<4;j++) for(let i=0;i<4;i++) expect(p.microMask[(y+j)*(n+3)+x+i]).toBe(1);
        }
        expect(b.upper[p.core]+.25+.125-1.5).toBeLessThanOrEqual(p.levelM-1.5);
    });
    it('rejects open depressions instead of growing the work domain',()=>{
        const n=64,a=new Float32Array((n+3)**2).fill(1000);
        const p=planRegionalShapeLake({controls:a,cells:n,radiusOfCells:()=>100});
        expect(p.rejected).toBe(true);expect(p.attempts.length).toBeLessThanOrEqual(64);
        expect(p.attempts.every(a=>a.rejected==='open-or-region-boundary')).toBe(true);
    });
    it('uses one bound-derived level when coarse fixed trials are too shallow or overflow the cell budget',()=>{
        const n=64,a=new Float32Array((n+3)**2);
        for(let y=0;y<n+3;y++)for(let x=0;x<n+3;x++)a[y*(n+3)+x]=1000+((x-33)**2+(y-33)**2)*.025;
        const p=planRegionalShapeLake({controls:a,cells:n,risesM:[.1,8],maxCandidates:1,maxPotentialCells:256,radiusOfCells:()=>100});
        expect(p.rejected).toBeUndefined();expect(p.attempts).toHaveLength(3);
        expect(p.attempts[0].rejected).toBe('no-certified-wet-cell');
        expect(p.attempts[1].rejected).toBe('cell-work-budget');
        expect(p.proof.guaranteedDepthM).toBeGreaterThanOrEqual(1.5);expect(p.proof.minimumRimM).toBeGreaterThanOrEqual(.5);
    });
    it('stops rejected connectivity work at the configured cell limit',()=>{
        const n=128,lower=new Float64Array(n*n);
        const p=shapeThresholdRegion(lower,n,64*n+64,1,8,null,64);
        expect(p.exceededBudget).toBe(true);expect(p.cells).toBe(64);
        expect(p.touchesGuard).toBe(false);
    });
    it('rejects a valid small wet core when a large connected lake was requested',()=>{
        const n=64,a=new Float32Array((n+3)**2);
        for(let y=0;y<n+3;y++)for(let x=0;x<n+3;x++)a[y*(n+3)+x]=1000+((x-33)**2+(y-33)**2)*.2;
        const common={controls:a,cells:n,risesM:[2],maxCandidates:1,radiusOfCells:()=>100};
        expect(planRegionalShapeLake(common).rejected).toBeUndefined();
        const large=planRegionalShapeLake({...common,minWetCells:200});
        expect(large.rejected).toBe(true);expect(large.attempts.every(a=>a.rejected==='connected-wet-area')).toBe(true);
    });
    it('distinguishes a shallow upland depression from enclosure without relaxing containment',()=>{
        const n=128;
        const make=curvature=>{
            const a=new Float32Array((n+3)**2);
            for(let y=0;y<n+3;y++) for(let x=0;x<n+3;x++) a[y*(n+3)+x]=1000+((x-65)**2+(y-65)**2)*curvature;
            const contextOfCells=(core,level,minimum)=>({rings:[120,240].map(radius=>{
                const riseM=Array.from({length:8},(_,j)=>sampleRegionalShape(a,n,core%n+.5+Math.cos(j*Math.PI/4)*radius/8,
                    Math.floor(core/n)+.5+Math.sin(j*Math.PI/4)*radius/8)-level);
                return {validSamples:8,enclosingSectors:riseM.filter(h=>h>=minimum*.75).length,
                    opposingRiseM:Math.max(...riseM.slice(0,4).map((h,j)=>Math.min(h,riseM[j+4])))};
            })});
            return {controls:a,cells:n,radiusOfCells:()=>100,contextOfCells,minimumEnclosureM:20};
        };
        const shallow=make(.02);
        expect(planRegionalShapeLake({...shallow,minimumEnclosureM:0}).rejected).toBeUndefined();
        expect(planRegionalShapeLake(shallow).rejected).toBe(true);
        const enclosed=planRegionalShapeLake(make(.2));
        expect(enclosed.rejected).toBeUndefined();expect(enclosed.proof.kind).toBe('continuous-spline-cell-hulls');
        expect(enclosed.proof.guaranteedDepthM).toBeGreaterThanOrEqual(1.5);
        expect(enclosed.proof.minimumRimM).toBeGreaterThanOrEqual(.5);
    });
});
