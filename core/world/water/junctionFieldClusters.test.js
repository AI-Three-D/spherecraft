import {expect,it} from 'vitest';
import {clusterJunctionSites,junctionFramesOverlap,junctionTouchesBasin} from './junctionFieldClusters.js';
const site=(key,x,y,lakeId=1)=>{const d=[100000,x,y],n=Math.hypot(...d);return {key,lakeId,dir:d.map(v=>v/n)};};
it('rejects a river junction far from its nominal downstream lake',()=>{
    const record={level:10,frame:{c:[1,0,0],e1:[0,1,0],e2:[0,0,1],x0:-50,y0:-50,nx:10,ny:10,spacing:10}};
    expect(junctionTouchesBasin({...site('mouth',70,0),levelM:10},record,100000,192)).toBe(true);
    expect(junctionTouchesBasin({...site('river-join',1500,0),levelM:10},record,100000,192)).toBe(false);
    expect(junctionTouchesBasin({...site('other-level',0,0),levelM:20},record,100000,192)).toBe(false);
});
it('merges nearby lake connections and leaves disjoint fields for distant mouths',()=>{
    const clusters=clusterJunctionSites([site('a',0,0),site('b',200,0),site('c',1500,0)],100000);
    expect(clusters.map(c=>c.sites.length).sort()).toEqual([1,2]);
    expect(junctionFramesOverlap(clusters[0].frame,clusters[1].frame,100000)).toBe(false);
});
it('merges overlapping bounds across basins and caps resolution by coarsening the shared grid',()=>{
    const sites=Array.from({length:8},(_,i)=>site(String(i),i*250,i%2*100,i+1));
    const [cluster]=clusterJunctionSites(sites,100000,{maxGridSide:257});
    expect(cluster.sites.length).toBe(8);expect(cluster.lakeIds.length).toBe(8);
    expect(cluster.frame.width).toBeLessThanOrEqual(257);expect(cluster.frame.height).toBeLessThanOrEqual(257);
    expect(cluster.frame.spacingM).toBeGreaterThan(2);
});
