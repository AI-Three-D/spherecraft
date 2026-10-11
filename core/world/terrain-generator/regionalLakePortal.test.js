import {describe,it,expect} from 'vitest';
import {regionalLakePortal} from './regionalLakePortal.js';
import {planeToDir,tangentBasis} from '../hydrology/lakeRefine.js';
describe('lake-depth course portals',()=>{
    const c=[1,0,0],frame={c,...tangentBasis(c)},nx=40,spacing=10,
        basin={radiusM:180,frame:{...frame,x0:-200,y0:-200,nx,ny:nx,spacing},surfaceDepthMask:new Uint8Array(nx*nx)},
        course={x:[0,20,40,60,80,100,120],y:[0,0,0,0,0,0,0],s:[0,20,40,60,80,100,120]};
    for(let j=0;j<nx;j++)for(let i=0;i<nx;i++)if(i<27&&i>10&&j>10&&j<30)basin.surfaceDepthMask[j*nx+i]=150;
    const input={course,basin,planetRadius:131072,planeToDir,frame};
    it('uses actual wet coverage rather than the enclosing radius',()=>{
        const p=regionalLakePortal(input);
        expect(p.arcM).toBe(60);expect(p.arcM).toBeLessThan(basin.radiusM);
        expect(p.kind).toBe('conservative-lake-depth-portal');
    });
    it('rejects a dry anchor or a course that never leaves the water',()=>{
        expect(()=>regionalLakePortal({...input,course:{x:[100,120],y:[0,0],s:[0,20]}})).toThrow('outside');
        expect(()=>regionalLakePortal({...input,course:{x:[0,20],y:[0,0],s:[0,20]}})).toThrow('never exits');
    });
});
