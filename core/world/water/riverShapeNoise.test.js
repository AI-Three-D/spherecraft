import {describe,expect,it} from 'vitest';
import {riverNoise,riverBankNoise,riverBankExtent,riverShapeAt,riverShapeMaxScale,RIVER_CARVE_DEFAULTS} from './riverShapeNoise.js';

describe('bounded independent river shores',()=>{
    const legacy=RIVER_CARVE_DEFAULTS,detail={...legacy,bankDetail:1};
    it('keeps both shores inside the indexed reach across widths and seeds',()=>{
        for(const width of [4,12,30])for(let seed=0;seed<5;seed++)for(let s=0;s<8000;s+=7.3) {
            const shape=riverShapeAt(s,seed,width,detail);
            expect(shape.hw+Math.abs(shape.off)).toBeLessThanOrEqual(width*riverShapeMaxScale(detail));
            expect(shape.hw).toBeGreaterThan(0);
        }
    });
    it('retreats the left and right wet edges independently',()=>{
        let leftEnergy=0,rightEnergy=0,difference=0;
        for(let s=0;s<2000;s+=2) {
            const a=riverShapeAt(s,0,12,legacy),b=riverShapeAt(s,0,12,detail);
            const l=b.off+b.hw-a.off-a.hw,r=b.hw-b.off-a.hw+a.off;
            expect(l).toBeCloseTo(12*.12*riverNoise(s,0,'shoreLeft').v,9);
            expect(r).toBeCloseTo(12*.12*riverNoise(s,0,'shoreRight').v,9);
            leftEnergy+=l*l;rightEnergy+=r*r;difference+=(l-r)**2;
        }
        expect(Math.min(leftEnergy,rightEnergy,difference)).toBeGreaterThan(10);
    });
    it('has continuous derivatives across noise lattice and segment positions',()=>{
        for(const s of [0,3.5,11.5,23,34.5,128,999.9,4000]) {
            const p=riverShapeAt(s,3,12,detail),a=riverShapeAt(s-.0001,3,12,detail),b=riverShapeAt(s+.0001,3,12,detail);
            expect((b.hw-a.hw)/.0002).toBeCloseTo(p.dhw,6);
            expect((b.off-a.off)/.0002).toBeCloseTo(p.doff,6);
        }
    });
    it('preserves legacy shape when the option is absent or zero',()=>{
        const {bankDetail,...old}=legacy;
        expect(bankDetail).toBe(0);
        for(let s=0;s<1000;s+=17)expect(riverShapeAt(s,2,4,old)).toEqual(riverShapeAt(s,2,4,legacy));
        expect(riverShapeMaxScale(old)).toBe(riverShapeMaxScale(legacy));
    });
    it('bounds spatial relief and matches both analytic metre derivatives',()=>{
        for(let i=0;i<1000;i++) {
            const s=i*1.783,n=i*.439-200,p=riverBankNoise(s,n,3),e=.0001;
            expect(Math.abs(p.v)).toBeLessThanOrEqual(1);
            expect((riverBankNoise(s+e,n,3).v-riverBankNoise(s-e,n,3).v)/(2*e)).toBeCloseTo(p.ds,6);
            expect((riverBankNoise(s,n+e,3).v-riverBankNoise(s,n-e,3).v)/(2*e)).toBeCloseTo(p.dn,6);
        }
    });
    it('keeps dry-bank extent within physical limits for small or oversized blend halos',()=>{
        for(const blendW of [0,0.5,1,10,65,1000])for(const morph of [0,0.1,0.5,0.9,1]) {
            const extent=riverBankExtent(morph,blendW);
            expect(extent).toBeGreaterThanOrEqual(1);
            expect(extent).toBeLessThanOrEqual(45);
        }
        expect(riverBankExtent(0,65)).toBe(45);
        expect(riverBankExtent(1,65)).toBe(1);
    });
});
