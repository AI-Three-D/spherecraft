import { expect, it } from 'vitest';
import { bakeJunctionSamples } from './junctionFieldBake.js';

it.each([undefined,[NaN,NaN,NaN]])('keeps lake levels fixed without usable preferred-seed metadata (%s)',seedDir=>{
    const width=33,height=17,spacingM=4,radiusM=100000,n=width*height;
    const frame={c:[1,0,0],e1:[0,0,1],e2:[0,1,0],x0:-64,y0:-32,width,height,spacingM};
    const natural=new Float32Array(n),oldBed=new Float32Array(n),dirs=new Float32Array(n*4);
    const data=new Float32Array(n*8),mask=new Uint8Array(n);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
        const i=y*width+x,px=frame.x0+x*spacingM,py=frame.y0+y*spacingM;
        const v=[1,py/radiusM,px/radiusM],len=Math.hypot(...v);
        dirs.set(v.map(a=>a/len),4*i);natural[i]=px<0?8:14;
        oldBed[i]=Math.abs(py)<8?Math.min(natural[i],9.5):natural[i];mask[i]=px<0?2:1;
        data.set([13,2,5-Math.abs(py),10,0,1,10,px<0?1:0],8*i);
    }
    const r=bakeJunctionSamples({frame,radiusM,natural,oldBed,dirs,data,
        basins:[{record:{frame:{...frame,nx:width,ny:height,spacing:spacingM},mask},levelM:10,seedDir}],
        referenceLevelM:10,lakewardSign:-1,blendRadiusM:16,
        influenceSites:[[1,0,0]],influenceCoreM:16,influenceFadeM:16,
        solveOptions:{iterations:4000,bedScreening:.04}});
    expect(r.converged).toBe(true);
    let lakeCells=0;
    for(let i=0;i<n;i++)if(r.basinDistance[i]>0){expect(r.field[4*i]).toBe(10);lakeCells++;}
    expect(lakeCells).toBeGreaterThan(100);
    expect(Math.max(...Array.from({length:n},(_,i)=>r.field[4*i]))).toBeGreaterThan(10);
    const influence=x=>r.field[4*(8*width+x)+2];
    // Land 4 m above the lake (x >= 16): the low-ground fade halves it.
    expect(influence(15)).toBe(1);expect(influence(16)).toBeCloseTo(.5,6);
    expect(influence(1)).toBe(0);
    expect(influence(22)).toBeCloseTo(.25,4);
});

it('connects two basins while retaining both prescribed lake levels',()=>{
    const width=33,height=17,spacingM=4,radiusM=100000,n=width*height;
    const frame={c:[1,0,0],e1:[0,0,1],e2:[0,1,0],x0:-64,y0:-32,width,height,spacingM};
    const natural=new Float32Array(n),oldBed=new Float32Array(n),dirs=new Float32Array(n*4),data=new Float32Array(n*8);
    const left=new Uint8Array(n),right=new Uint8Array(n);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
        const i=y*width+x,px=frame.x0+x*spacingM,py=frame.y0+y*spacingM;
        const v=[1,py/radiusM,px/radiusM],len=Math.hypot(...v),eta=10-2*Math.max(0,Math.min(1,(x-8)/16));
        dirs.set(v.map(a=>a/len),4*i);natural[i]=x<8?6:x>24?4:14;
        oldBed[i]=Math.abs(py)<8?Math.min(natural[i],eta-2):natural[i];left[i]=x<8?2:1;right[i]=x>24?2:1;
        data.set([eta,2,5-Math.abs(py),10,0,1,10,1],8*i);
    }
    const record=mask=>({frame:{...frame,nx:width,ny:height,spacing:spacingM},mask});
    const r=bakeJunctionSamples({frame,radiusM,natural,oldBed,dirs,data,
        basins:[{record:record(left),levelM:10,seedDir:[1,0,-.001]},{record:record(right),levelM:8,seedDir:[1,0,.001]}],
        referenceLevelM:10,blendRadiusM:16,solveOptions:{iterations:4000,bedScreening:.04}});
    expect(r.converged).toBe(true);
    const level=x=>r.field[4*(8*width+x)];
    expect(level(4)).toBe(10);expect(level(28)).toBe(8);
    expect(level(16)).toBeGreaterThan(8);expect(level(16)).toBeLessThan(10);
});
