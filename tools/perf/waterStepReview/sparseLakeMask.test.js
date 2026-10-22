import {test,expect} from 'vitest';
import {packSparseLakeMask,readSparseLakeMask} from './sparseLakeMask.js';
test('preserves a narrow dry barrier, excluded pocket, unknown cells and refined wet cells across page boundaries',()=>{
    const nx=33,ny=17,n=8,base=nx*ny,source=new Float32Array((5+base+n*n)*4);
    source.set([4,nx,ny,0,n],14);
    for(let y=0;y<ny;y++)for(let x=0;x<nx;x++)source[4*(5+y*nx+x)]=x===16||x===28?1:2;
    source[4*(5+base-1)]=0;source[4*(5+16)+3]=base;
    for(let y=0;y<n;y++)for(let x=0;x<n;x++)source[4*(5+base+y*n+x)]=x===3?1:2;
    const p=packSparseLakeMask(source);expect(p.stats.mismatches).toBe(0);expect(p.stats.refinedCells).toBe(1);
    expect(readSparseLakeMask(p.data,16,0,3,4)).toBe(1);expect(readSparseLakeMask(p.data,16,0,2,4)).toBe(2);
    expect(readSparseLakeMask(p.data,28,8)).toBe(1);expect(readSparseLakeMask(p.data,32,16)).toBe(0);
    expect(readSparseLakeMask(p.data,-1,0)).toBe(0);expect(readSparseLakeMask(p.data,33,0)).toBe(0);
    expect(p.stats.implicitPages).toBeGreaterThan(0);expect(p.data.byteLength).toBeLessThan(source.byteLength);
});
