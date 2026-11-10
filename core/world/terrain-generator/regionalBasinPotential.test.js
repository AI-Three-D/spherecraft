import {describe,it,expect} from 'vitest';
import {createRegionalBasinPotential} from './regionalBasinPotential.js';

describe('spatial basin potential',()=>{
    it('has bounded compact support, a retained core, and continuous crossings of noise cells',()=>{
        const radiusM=450,potential=createRegionalBasinPotential({radiusM,seed:17});
        expect(potential(0,0)).toBe(1);
        for(let j=0;j<100;j++){
            const a=j*Math.PI/50,x=Math.cos(a)*radiusM*1.4,y=Math.sin(a)*radiusM*1.4;
            expect(potential(x*1.001,y*1.001)).toBe(0);
            const value=potential(x*.55,y*.55);expect(value).toBeGreaterThanOrEqual(0);expect(value).toBeLessThanOrEqual(1);
        }
        for(const scale of [292.5,112.5,40.5,20]){
            // These x values straddle the integer hash lattice. A discontinuity
            // here would create an artificial seam in the baked landform.
            const x=(14-13.7)*scale;
            expect(Math.abs(potential(x-.0001,170)-potential(x+.0001,170))).toBeLessThan(.0001);
        }
    });
});
