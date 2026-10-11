import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createData } = vi.hoisted(() => ({ createData: vi.fn() }));
vi.mock('./regionalTerrain.js', async importOriginal => ({
    ...await importOriginal(), createRegionalTerrainData: createData,
}));
import { WebGPUTerrainGenerator } from '../webgpuTerrainGenerator.js';

const data = (cells = 128, version = 1) => ({ cells, seamCells: 4, version, destroy: vi.fn(async () => {}) });
const generator = () => Object.assign(Object.create(WebGPUTerrainGenerator.prototype), {
    device: {}, terrainConfig: { regionalTerrain: { enabled: true, cells: 128 } },
});

describe('regional generation publication and regeneration', () => {
    beforeEach(() => { createData.mockReset(); });
    it('coalesces matching dependencies and reuses the completed version', async () => {
        const gen = generator(), next = data();
        let resolve;
        createData.mockReturnValue(new Promise(r => { resolve = r; }));
        const first = gen.prepareRegionalTerrain(), second = gen.prepareRegionalTerrain();
        expect(gen.regionalTerrain).toBeUndefined();
        resolve(next);
        expect(await first).toBe(next);
        expect(await second).toBe(next);
        expect(await gen.prepareRegionalTerrain()).toBe(next);
        expect(createData).toHaveBeenCalledTimes(1);
    });
    it('preserves current inputs when their replacement fails', async () => {
        const old = data(), gen = Object.assign(generator(), { regionalTerrain: old });
        createData.mockImplementation(async () => { throw new Error('GPU generation failed'); });
        await expect(gen.prepareRegionalTerrain(undefined, { regenerate: true })).rejects.toThrow('GPU generation failed');
        expect(gen.regionalTerrain).toBe(old);
        expect(old.destroy).not.toHaveBeenCalled();
        expect(gen._regionalTerrainPreparing).toBeNull();
    });
    it('shares foundation inputs for feature changes and keeps full regeneration explicit',async()=>{
        const foundation={},old={...data(),foundation},gen=Object.assign(generator(),{regionalTerrain:old});
        createData.mockImplementation(async({options})=>({...data(),foundation,basinsConfig:options.basins}));
        const opts={cells:128,basins:{enabled:true}};
        await gen.prepareRegionalTerrain(opts);
        expect(createData.mock.calls[0][0].previousFoundation).toBe(foundation);
        await gen.prepareRegionalTerrain(opts,{regenerate:true});
        expect(createData.mock.calls[1][0].previousFoundation).toBeNull();
        await gen.prepareRegionalTerrain(opts,{regenerate:true,reuseFoundation:true});
        expect(createData.mock.calls[2][0].previousFoundation).toBe(foundation);
    });
    it('discards an in-flight version if its feature inputs change', async () => {
        const old = data(), next = data(128, 2), gen = Object.assign(generator(), { regionalTerrain: old });
        let resolve;
        createData.mockReturnValue(new Promise(r => { resolve = r; }));
        const pending = gen.prepareRegionalTerrain(undefined, { regenerate: true });
        gen.setTerrainFeatures({ meso2: false });
        resolve(next);
        await expect(pending).rejects.toThrow('inputs changed during generation');
        expect(gen.regionalTerrain).toBe(old);
        expect(old.destroy).not.toHaveBeenCalled();
        expect(next.destroy).toHaveBeenCalledOnce();
        expect(gen._regionalTerrainDirty).toBe(true);
    });
    it('honours a different resolution requested while generation is pending', async () => {
        const gen = generator(), firstData = data(), secondData = data(256, 2);
        let resolve;
        createData.mockReturnValueOnce(new Promise(r => { resolve = r; })).mockResolvedValueOnce(secondData);
        const first = gen.prepareRegionalTerrain({ cells: 128 });
        const second = gen.prepareRegionalTerrain({ cells: 256 });
        resolve(firstData);
        expect(await first).toBe(firstData);
        expect(await second).toBe(secondData);
        expect(firstData.destroy).toHaveBeenCalledOnce();
        expect(createData.mock.calls[1][0].options.cells).toBe(256);
    });
    it('rebuilds rather than reusing roots when basin planning is enabled',async()=>{
        const gen=generator(),old=data();
        createData.mockImplementation(async({options})=>({...data(),basinsConfig:options.basins}));
        gen.regionalTerrain=old;
        const next=await gen.prepareRegionalTerrain({cells:128,basins:{enabled:true}});
        expect(next.basinsConfig.enabled).toBe(true);
        expect(old.destroy).toHaveBeenCalledOnce();
        expect(await gen.prepareRegionalTerrain({cells:128,basins:{enabled:true}})).toBe(next);
        expect(createData).toHaveBeenCalledOnce();
    });
    it('replaces basin-only inputs when drainage is enabled or disabled',async()=>{
        const gen=generator();
        createData.mockImplementation(async({options})=>({...data(),basinsConfig:options.basins,drainageConfig:options.drainage}));
        const opts={cells:128,basins:{enabled:true}};
        const basin=await gen.prepareRegionalTerrain(opts);
        const network=await gen.prepareRegionalTerrain({...opts,drainage:{enabled:true}});
        expect(network).not.toBe(basin);
        expect(basin.destroy).toHaveBeenCalledOnce();
        expect(await gen.prepareRegionalTerrain({...opts,drainage:{enabled:true}})).toBe(network);
        await gen.prepareRegionalTerrain(opts);
        expect(network.destroy).toHaveBeenCalledOnce();
        expect(createData).toHaveBeenCalledTimes(3);
    });
    it('replaces the generation when its placement survey settings change',async()=>{
        const gen=generator();
        createData.mockImplementation(async({options})=>({...data(),basinsConfig:options.basins,placementConfig:options.placement}));
        const opts={cells:128,basins:{enabled:true,minLevelM:900}};
        const plain=await gen.prepareRegionalTerrain(opts);
        const valleys=await gen.prepareRegionalTerrain({...opts,placement:{enabled:true}});
        expect(plain.destroy).toHaveBeenCalledOnce();
        expect(await gen.prepareRegionalTerrain({...opts,placement:{enabled:true}})).toBe(valleys);
        const denser=await gen.prepareRegionalTerrain({...opts,placement:{enabled:true,cells:128}});
        expect(denser).not.toBe(valleys);expect(valleys.destroy).toHaveBeenCalledOnce();
        expect(createData).toHaveBeenCalledTimes(3);
    });
    it('rebuilds on terrain-feature parameters and keeps its shader layout separate',async()=>{
        const gen=generator();
        createData.mockImplementation(async({options})=>({...data(256),basinsConfig:options.basins,valleyConfig:options.valley}));
        const opts={cells:256,basins:{enabled:true,radiusM:120},valley:{enabled:true}};
        const first=await gen.prepareRegionalTerrain(opts);
        expect(await gen.prepareRegionalTerrain(opts)).toBe(first);
        const changed=await gen.prepareRegionalTerrain({...opts,valley:{enabled:true,hillHeightM:150}});
        expect(changed).not.toBe(first);expect(first.destroy).toHaveBeenCalledOnce();
    });
    it('replaces and reuses authoritative shape inputs by their complete configuration',async()=>{
        const gen=generator();
        createData.mockImplementation(async({options})=>({...data(256),basinsConfig:options.basins,shapeConfig:options.shape}));
        const opts={cells:256,basins:{enabled:true},shape:{enabled:true}};
        const first=await gen.prepareRegionalTerrain(opts);
        expect(await gen.prepareRegionalTerrain(opts)).toBe(first);
        const changed=await gen.prepareRegionalTerrain({...opts,shape:{enabled:true,cells:64}});
        expect(changed).not.toBe(first);expect(first.destroy).toHaveBeenCalledOnce();
        const plain=await gen.prepareRegionalTerrain({cells:256,basins:{enabled:true}});
        expect(plain.shapeConfig).toBeNull();expect(changed.destroy).toHaveBeenCalledOnce();
    });

});
