import {it,expect} from 'vitest';
import {finalHeightGrid,heightBlocks} from './finalHeightBlocks.js';
import {connectDepths} from './bodyMask.js';
it('matches the active normalized texture mapping, including both borders',()=>{
    const g=finalHeightGrid(new Float32Array([0,2,4,6]),2,10);
    expect(Array.from(g)).toEqual([0,10,20,20,30,40,40,50,60]);
});
it('preserves a narrow dry ridge even when all corners of the source page are wet',()=>{
    const n=8,grid=new Float64Array((n+1)**2),triangles=[],depths=[],seeds=[];
    // Ridge connects two dry page edges, separating the wet regions.
    for(let y=0;y<=n;y++)grid[y*(n+1)+4]=2;
    heightBlocks(grid,n,1,(i,j,size)=>{
        const p=(x,y)=>[x,y,grid[y*(n+1)+x]],v=[p(i,j),p(i+size,j),p(i,j+size),p(i+size,j+size)];
        for(const ids of[[0,2,1],[1,2,3]]){const tr=ids.map(k=>v[k]);if(i===0)seeds.push(triangles.length);triangles.push(tr);depths.push(tr.map(p=>1-p[2]));}
    });
    const top=connectDepths(triangles,depths,seeds);let right=0;
    triangles.forEach((tr,i)=>{if(tr.every(v=>v[0]>4)){right++;expect(top.connected[i]).toBe(0);}});
    expect(right).toBeGreaterThan(0);expect(triangles.length).toBeLessThan(n*n*2);
});
