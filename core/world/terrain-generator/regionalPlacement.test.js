import {describe,it,expect,vi} from 'vitest';
import {regionalRimCapRadius} from './regionalBasins.js';
import {regionalTerrainOptions} from './regionalTerrain.js';
import {createRegionalBasinCertificateWgsl} from './regionalBasins.wgsl.js';
import {TerrainGenerationConfig} from '../../../templates/configs/terrainGenerationConfig.js';
import {terrainDisplacementBudgets} from './terrainHeightContract.js';
import {createRegionalPlacementData} from './regionalPlacement.js';

describe('valley placement proof and bounded survey',()=>{
    it('tighter caps cover every point of the enclosing annulus, including angular gaps',()=>{
        for(const radius of [30,60,100,200]) for(const count of [16,32,64]) {
            const cap=regionalRimCapRadius(radius,count,true);
            // Explicit coordinates, independent of the radius implementation:
            // include nearest-node midpoint and both radial endpoints.
            for(let a=0;a<=100;a++) for(const r of [radius,radius+3,radius+6]) {
                const theta=Math.PI/count*a/100;
                expect(Math.hypot(r*Math.cos(theta)-radius,r*Math.sin(theta))).toBeLessThan(cap);
            }
            expect(cap).toBeLessThanOrEqual(regionalRimCapRadius(radius,count));
        }
    });
    it('requires basins and bounded survey settings',()=>{
        expect(()=>regionalTerrainOptions({placement:{enabled:true}})).toThrow('placement');
        expect(()=>regionalTerrainOptions({basins:{enabled:true},placement:{enabled:true,regions:100}})).toThrow('placement');
        expect(()=>regionalTerrainOptions({basins:{enabled:true},placement:{enabled:true,patchCells:16}})).toThrow('placement');
        expect(regionalTerrainOptions({basins:{enabled:true},placement:{enabled:true}}).placement.regions).toBe(24);
    });
    it('refuses an invalid slope-ramp contract',()=>{
        const ef=new TerrainGenerationConfig({}).erosionFilter,budgets=terrainDisplacementBudgets({erosionFilter:ef});
        expect(()=>createRegionalBasinCertificateWgsl({...ef,sharpSlopeFull:ef.sharpSlopeStart},budgets,{slopeAware:true})).toThrow('slope ramp');
    });
    it('releases the retained root survey if a targeted context dispatch fails',async()=>{
        const n=32,output=new Float32Array(6*n*n*4),centre=10*n+10;
        output[centre*4]=1000;
        for(const [x,y] of [[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]]) {
            output[(centre+y*n+x)*4]=1100;
        }
        const buffer={destroy:vi.fn()},certifier=vi.fn()
            .mockResolvedValueOnce({output,buffer,wallMs:1,uploadBytes:1})
            .mockRejectedValueOnce(new Error('context GPU failed'));
        const options=regionalTerrainOptions({basins:{enabled:true,minLevelM:900},placement:{enabled:true,cells:n}});
        await expect(createRegionalPlacementData({gen:{planetConfig:{radius:131072}},data:{cells:256},
            options:options.placement,basinOptions:options.basins,certifier})).rejects.toThrow('context GPU failed');
        expect(buffer.destroy).toHaveBeenCalledOnce();
    });
});
