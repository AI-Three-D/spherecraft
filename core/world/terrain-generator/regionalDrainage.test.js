import {describe,it,expect} from 'vitest';
import {routeRegionalHeightGrid} from './regionalDrainage.js';

describe('terrain-aware regional routing',()=>{
    const grid={nx:9,ny:9,spacing:128,sourceIndex:36,targetIndex:44,sourceLevelM:20,targetLevelM:10};
    it('detours around a high obstacle, remains deterministic and reaches the receiver',()=>{
        const heights=new Float32Array(81).fill(21);
        for(let y=2;y<=6;y++) for(let x=3;x<=5;x++) heights[y*9+x]=180;
        const a=routeRegionalHeightGrid({...grid,heights}),b=routeRegionalHeightGrid({...grid,heights});
        expect(a.path[0]).toBe(36);expect(a.path.at(-1)).toBe(44);
        expect([...a.path]).toEqual([...b.path]);
        expect([...a.path].every(k=>heights[k]<180)).toBe(true);
        expect(new Set(a.path).size).toBe(a.path.length);
    });
    it('rejects non-descending endpoints and invalid sampled heights',()=>{
        expect(()=>routeRegionalHeightGrid({...grid,heights:new Float32Array(81),targetLevelM:21})).toThrow();
        expect(()=>routeRegionalHeightGrid({...grid,heights:new Float32Array(81).fill(NaN)})).toThrow();
    });
});
