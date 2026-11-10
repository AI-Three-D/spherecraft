import {describe,it,expect} from 'vitest';
import {structuredWaterGpuCapacity} from './structuredWaterGpuCapacity.js';

describe('immutable structured water capacity',()=>{
    const service=(lakes=[],rivers=[])=>({stats:{structured:true},lakes,riverRecs:new Map(rivers.map((r,i)=>[i,r])),refined:new Map()});
    it('preserves asynchronous legacy services and allocates valid minimum empty resources',()=>{
        expect(structuredWaterGpuCapacity({stats:{}})).toEqual({});
        const c=structuredWaterGpuCapacity(service());
        expect(c.maxLakes).toBe(1);expect(c.maxMaskLayers).toBe(1);expect(c.maxRiverSegs).toBe(1);expect(c.maxRiverCells).toBe(1);
    });
    it('sizes one known pond instead of reserving future legacy water and valley pools',()=>{
        const c=structuredWaterGpuCapacity(service([{id:0,frame:{nx:64,ny:64}}]));
        expect(c).toEqual({maxLakes:1,maxMaskLayers:1,maskLayerSize:64,maxRiverSegs:1,maxRiverCells:1,valley:null});
    });
    it('counts repeated segments and distinct cell blocks rather than just river points',()=>{
        const s=service([{id:0,frame:{nx:32,ny:32}},{id:1,frame:{nx:48,ny:40}}],
            [{segCells:new Int32Array([0,1,16,17])},{segCells:new Int32Array([0,32])}]);
        const c=structuredWaterGpuCapacity(s);
        expect(c.maxRiverSegs).toBe(6);expect(c.maxRiverCells).toBe(3);expect(c.maxMaskLayers).toBe(2);expect(c.maskLayerSize).toBe(64);
    });
    it('reserves all masks in tiled layers for a dense planet and refuses silent population loss',()=>{
        const s=service(Array.from({length:1200},(_,id)=>({id,frame:{nx:128,ny:128}})));
        const c=structuredWaterGpuCapacity(s);expect(c.maxMaskLayers).toBe(1200);expect(c.maskTilesPerAxis).toBe(4);
        expect(c.maxLakes).toBe(1200);expect(()=>structuredWaterGpuCapacity(s,{maxLakes:1024})).toThrow(/capacity/);
    });
});
