import {describe,it,expect} from 'vitest';
import {regionalShapeAddress,regionalShapeOptions} from './regionalShape.js';

describe('canonical regional diagnostic address',()=>{
    it('uses the same domain bounds as production shape generation',()=>{
        expect(regionalShapeAddress(null)).toEqual({});
        expect(regionalShapeAddress('0,7,102,114')).toEqual({face:0,depth:7,x:102,y:114});
        for(const value of ['0,7,0,114','6,7,102,114','0,9,102,114','0,7,128,114','0,7,1.5,114','0,7,102']) {
            expect(()=>regionalShapeAddress(value)).toThrow();
        }
    });
    it('bounds larger regions and level trials without changing small-pocket defaults',()=>{
        expect(regionalShapeOptions({enabled:true}).maxPotentialCells).toBe(512);
        expect(regionalShapeOptions({enabled:true}).risesM).toEqual([2,4,6,8,.5,.75,1]);
        expect(regionalShapeOptions({enabled:true,cells:256,depth:6,x:40,y:20,maxRadiusM:1000,
            maxPotentialCells:8192,risesM:[32,24,16,8,2],surfaceCells:128}).surfaceCells).toBe(128);
        for(const value of [{maxPotentialCells:65537},{risesM:Array(9).fill(1)},{risesM:[41]},
            {risesM:[NaN]},{surfaceCells:512},{maxRadiusM:18001}]) {
            expect(()=>regionalShapeOptions({enabled:true,...value})).toThrow();
        }
        expect(regionalShapeOptions({enabled:true,cells:256,depth:3,x:2,y:2,maxRadiusM:18000,maxPotentialCells:50000,surfaceCells:256}).depth).toBe(3);
        const depression={radiusM:450,maxCutM:8,depthM:2.5,seed:17};
        expect(regionalShapeOptions({enabled:true,depression:{...depression,profile:'organic'}}).depression.profile).toBe('organic');
        expect(()=>regionalShapeOptions({enabled:true,depression:{...depression,profile:'unknown'}})).toThrow();
    });
});
