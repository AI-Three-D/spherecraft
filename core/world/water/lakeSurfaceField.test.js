import {describe,it,expect} from 'vitest';
import {encodeLakeSurfaceDepth,decodeLakeSurfaceDepth,resampleLakeSurfaceMask} from './lakeSurfaceField.js';

describe('compact generation-owned lake depth',()=>{
    it('never invents positive depth through quantization and bounds depth loss',()=>{
        const range=16;
        for(let i=-800;i<=1600;i++) {
            const h=i/100,code=encodeLakeSurfaceDepth(h,range),decoded=decodeLakeSurfaceDepth(code,range);
            expect(decoded).toBeLessThanOrEqual(h+1e-12);
            expect(h-decoded).toBeLessThan(range/127+1e-12);
            if(h<=0) expect(code).toBeLessThanOrEqual(128);
        }
    });
    it('retains depth values and clips coverage trimmed by a connecting channel',()=>{
        const rec={frame:{nx:2,ny:2},surfaceDepthMask:new Uint8Array([160,200,80,220])};
        const coverage=new Uint8Array([2,0,2,2]),out=resampleLakeSurfaceMask(rec,coverage,4);
        expect([...out]).toEqual([160,160,0,0,160,160,0,0,80,80,220,220,80,80,220,220]);
        expect(()=>resampleLakeSurfaceMask(rec,new Uint8Array(3),4)).toThrow('mismatch');
    });
});
