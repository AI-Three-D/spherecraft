import {describe,it,expect} from 'vitest';
import {regionalRiverProfile} from './regionalRiverProfile.js';

const inputs=levels=>({x:Float64Array.from(levels,(_,i)=>i*8),y:new Float64Array(levels.length),
    s:Float64Array.from(levels,(_,i)=>i*8),heights:Float32Array.from(levels.flatMap(h=>[h,h+1,h+1])),
    sourceLevelM:levels[0]+.2,targetLevelM:levels.at(-1)+.2,sourceEndM:0,targetStartM:(levels.length-1)*8});

describe('regional downhill geometry profile',()=>{
    it('anchors both lakes, descends through local rises and rejects excessive incision',()=>{
        const p=regionalRiverProfile(inputs([100,99,97,98,95,90,88,85]));
        expect(p.rows[0].levelM).toBeCloseTo(100.2);expect(p.rows.at(-1).levelM).toBeCloseTo(85.2);
        expect(p.rows.every((r,k)=>k===0||r.levelM<=p.rows[k-1].levelM)).toBe(true);
        expect(p.maxCutM).toBeLessThan(4);expect(p.falls).toHaveLength(0);
        expect(()=>regionalRiverProfile({...inputs([100,99,80,120,75,70]),maxChannelCutM:24})).toThrow('incision budget');
    });
    it('keeps a uniform steep hillside as a rapid without periodic waterfall steps',()=>{
        const p=regionalRiverProfile(inputs(Array.from({length:40},(_,k)=>500-k*6)));
        expect(p.falls).toHaveLength(0);expect(p.maxSlope).toBeCloseTo(.75);expect(p.maxCutM).toBeLessThan(2);
    });
    it('localizes a drop at a strong gradient peak, with bounded extra cut and continuous downhill rows',()=>{
        const heights=Array.from({length:22},(_,i)=>300-i*.4);
        for(let i=11;i<heights.length;i++)heights[i]-=8;
        const raw=regionalRiverProfile({...inputs(heights),fallExtraCutM:0}),p=regionalRiverProfile(inputs(heights));
        expect(p.falls).toHaveLength(1);expect(p.falls[0].dropM).toBeGreaterThan(3);
        expect(p.falls[0].endM-p.falls[0].startM).toBe(1.5);
        expect(p.maxCutM-raw.maxCutM).toBeLessThanOrEqual(4.0001);
        expect(p.rows.every((r,k)=>k===0||(r.levelM<=p.rows[k-1].levelM&&r.s>p.rows[k-1].s))).toBe(true);
        expect(()=>regionalRiverProfile({...inputs(heights),maxPoints:heights.length})).toThrow('point budget');
    });
});
