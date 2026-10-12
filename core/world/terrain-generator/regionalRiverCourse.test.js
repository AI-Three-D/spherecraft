import {describe,it,expect} from 'vitest';
import {regionalRiverCourse} from './regionalRiverCourse.js';
const options={line:[[0,0],[500,0],[1000,0],[1500,0]],frame:{x0:-200,y0:-200,nx:65,ny:16,spacing:32},
    heights:new Float32Array(65*16).fill(100),halfWidthM:8,sourceLevelM:103,targetLevelM:99,
    sourceRadiusM:80,targetRadiusM:80,stepM:16};
describe('coarse-guided visible course',()=>{
    it('retains both lake anchors, makes deterministic sustained bends and stays in its bounded corridor',()=>{
        const a=regionalRiverCourse(options),b=regionalRiverCourse(options);
        expect(a.x).toEqual(b.x);expect(a.y).toEqual(b.y);
        expect(a.x[0]).toBe(0);expect(a.y[0]).toBe(0);
        expect(a.x.at(-1)).toBe(1500);expect(a.y.at(-1)).toBe(0);
        expect(Math.max(...a.y.map(Math.abs))).toBeGreaterThan(3);
        expect(Math.max(...a.y.map(Math.abs))).toBeLessThan(15);
        expect(a.s.every((s,k)=>k===0||s>a.s[k-1])).toBe(true);
        expect(a.x.every((x,k)=>k===0||x>a.x[k-1])).toBe(true);
    });
    it('reduces lateral bend scale on a steep descent through the same model',()=>{
        const quiet=regionalRiverCourse(options),steep=regionalRiverCourse({...options,sourceLevelM:300});
        expect(steep.maximumOffsetM).toBeLessThan(quiet.maximumOffsetM);
    });
    it('rejects a folded route that would connect different reaches',()=>{
        const corners=[[0,0],[600,200],[0,200],[600,0]],line=[corners[0]];
        for(let k=1;k<corners.length;k++)for(let j=1;j<=10;j++)line.push([
            corners[k-1][0]+(corners[k][0]-corners[k-1][0])*j/10,
            corners[k-1][1]+(corners[k][1]-corners[k-1][1])*j/10]);
        expect(()=>regionalRiverCourse({...options,line})).toThrow('self-intersects');
    });
    it('rejects excessive refinement before searching lateral alternatives',()=>{
        expect(()=>regionalRiverCourse({...options,maxPoints:32})).toThrow('sampling budget');
    });
});
