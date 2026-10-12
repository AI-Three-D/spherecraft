import {describe,it,expect} from 'vitest';
import {regionalWaterModel,regionalWaterGridN} from './regionalWater.js';
import {dirToCell} from './waterGraph.js';
import {planeToDir} from './lakeRefine.js';

describe('published regional basin water',()=>{
    it('keeps contour and level detail when a two-lake lookup is coarse, and retains network resolution',()=>{
        const basins=[{id:0,centre:[1,0,0],radiusM:100,levelM:530},
            {id:1,centre:[1,0,0],radiusM:60,levelM:520}];
        const regional={sourceKey:'two-pools',basins};
        const N=regionalWaterGridN(regional,512),coarse=regionalWaterModel(regional,131072,N),fine=regionalWaterModel(regional,131072,512);
        expect(N).toBe(64);
        for(const l of coarse.lakes) {
            const a=coarse.refined.get(l.id),b=fine.refined.get(l.id);
            expect(a.frame).toEqual(b.frame);expect(a.mask).toEqual(b.mask);expect(a.level).toBe(b.level);
            const owned=new Set(a.maskCells);
            for(let j=0;j<360;j++) {
                const t=j*Math.PI/180,r=basins[l.id].radiusM-1;
                expect(owned.has(dirToCell(planeToDir(r*Math.cos(t),r*Math.sin(t),a.frame,131072),N))).toBe(true);
            }
        }
        expect(regionalWaterGridN({...regional,basins:[...basins,{...basins[0],id:2}]},512)).toBe(512);
        expect(regionalWaterGridN({...regional,drainageConfig:{carve:true},drainagePlan:{rivers:[{gridN:512}]}},512)).toBe(512);
    });
    it('uses the certified level, covers footprint cell boundaries and owns no rivers',()=>{
        const R=131072,N=512;
        const centre=[1,0,0],levelM=530;
        const model=regionalWaterModel({sourceKey:'generation-2',basins:[{id:0,centre,radiusM:100,levelM}]},R,N);
        expect(model.lakes[0].level).toBe(levelM);
        expect(model.lakes[0].regionalSourceKey).toBe('generation-2');
        const rec=model.refined.get(0),owned=new Set(rec.maskCells);
        for(let a=0;a<360;a++) {
            const angle=a*Math.PI/180;
            expect(owned.has(dirToCell(planeToDir(99*Math.cos(angle),99*Math.sin(angle),rec.frame,R),N))).toBe(true);
        }
        expect(rec.mask[16*32+16]).toBe(2);
        expect(rec.mask[0]).toBe(0);
        expect([...model.riverOf].every(id=>id===-1)).toBe(true);
        expect(model.rivers).toEqual([]);
    });
    it('publishes the generation-owned river and opens only its source lake',()=>{
        const basins=[{id:0,centre:[1,0,0],radiusM:100,levelM:530},
            {id:1,centre:[.999,0,.04],radiusM:60,levelM:520}];
        const river={id:0,fromLake:0,dest:{kind:'lake',id:1},gridN:16,cells:new Int32Array([3,4])};
        const regional={sourceKey:'network-2',basins,drainageConfig:{carve:true},drainagePlan:{rivers:[river]}};
        const model=regionalWaterModel(regional,131072,16);
        expect(model.riverRecs.get(0)).toBe(river);
        expect(model.riverOf[3]).toBe(0);
        expect(model.lakes.map(l=>l.closed)).toEqual([false,true]);
        expect(model.lakes.every(l=>l.regionalSourceKey==='network-2')).toBe(true);
        expect(()=>regionalWaterModel(regional,131072,32)).toThrow('resolution');
        regional.drainageConfig.carve=false;
        expect(regionalWaterModel(regional,131072,16).rivers).toEqual([]);
    });
    it('preserves a terrain-owned contour instead of replacing it with a radial footprint',()=>{
        const frame={c:[1,0,0],e1:[0,0,1],e2:[0,1,0],x0:-8,y0:-8,spacing:4,nx:4,ny:4};
        const mask=new Uint8Array(16);mask[5]=mask[6]=mask[10]=2;
        const basin={id:0,centre:frame.c,radiusM:100,levelM:860,frame,mask};
        const model=regionalWaterModel({sourceKey:'shape-1',basins:[basin]},131072,512);
        expect(model.refined.get(0).frame).toBe(frame);expect(model.refined.get(0).mask).toBe(mask);
        expect([...mask].filter(x=>x===2)).toHaveLength(3);
    });
});
