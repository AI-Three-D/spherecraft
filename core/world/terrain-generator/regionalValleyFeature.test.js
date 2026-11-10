import {describe,it,expect} from 'vitest';
import {regionalTerrainOptions} from './regionalTerrain.js';
import {regionalValleySeed,regionalValleyContract} from './regionalValleyFeature.js';

const opts=()=>regionalTerrainOptions({cells:256,basins:{enabled:true,radiusM:120,minLevelM:900},valley:{enabled:true}});
describe('terrain-owned valley feature contract',()=>{
    it('publishes the same site and shape from its address and seed without terrain search',()=>{
        const {valley:options}=opts();
        const a=regionalValleySeed({seed:12345,cells:256,options}),b=regionalValleySeed({seed:12345,cells:256,options});
        expect(a).toEqual(b);
        expect(regionalValleySeed({seed:12346,cells:256,options})).not.toEqual(a);
        expect(Math.hypot(...a.centre)).toBeCloseTo(1,12);
        expect(a.centre.reduce((s,v,i)=>s+v*a.axis[i],0)).toBeCloseTo(0,12);
    });
    it('provides a nonempty water interval after both residual and micro budgets',()=>{
        const {valley:options,basins:basinOptions}=opts();
        const c=regionalValleyContract({anchorM:1250,options,basinOptions,globalMicroM:24.4,existingLowerM:800,maxHeightM:5000});
        expect(c.floorUpperM+basinOptions.depthM).toBeLessThanOrEqual(c.levelM);
        expect(c.levelM+basinOptions.rimM).toBeLessThanOrEqual(c.lowerM);
        expect(c.waterIntervalM[0]).toBeLessThan(c.waterIntervalM[1]);
        expect(()=>regionalValleyContract({anchorM:1250,options,basinOptions,globalMicroM:24.4,existingLowerM:1300,maxHeightM:5000})).toThrow('invalidate');
    });
    it('refuses overlapping discovery/network modes or a footprint extending outside its full-weight core',()=>{
        expect(()=>regionalTerrainOptions({cells:256,basins:{enabled:true},valley:{enabled:true},placement:{enabled:true}})).toThrow('valley');
        expect(()=>regionalTerrainOptions({cells:256,basins:{enabled:true,radiusM:200},valley:{enabled:true,halfWidthM:350}})).toThrow('valley');
        expect(()=>regionalTerrainOptions({cells:256,basins:{enabled:true},valley:{enabled:true,terrain:false}})).toThrow('valley');
    });
});
