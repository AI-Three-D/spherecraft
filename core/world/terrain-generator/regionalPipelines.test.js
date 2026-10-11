import {describe,it,expect,vi} from 'vitest';
import {regionalComputePipelines} from './regionalPipelines.js';
const device=()=>({createShaderModule:vi.fn(o=>o),createComputePipelineAsync:vi.fn(async o=>({entry:o.compute.entryPoint}))});
describe('regional compiled pipeline lifetime',()=>{
    it('coalesces compilation while keeping different devices and source contracts separate',async()=>{
        const d=device(),other=device();
        const [a,b]=await Promise.all([regionalComputePipelines(d,'a',['height','bounds']),regionalComputePipelines(d,'a',['height','bounds'])]);
        expect(a.pipelines).toBe(b.pipelines);expect(d.createComputePipelineAsync).toHaveBeenCalledTimes(2);
        expect((await regionalComputePipelines(other,'a',['height','bounds'])).cacheHit).toBe(false);
        expect((await regionalComputePipelines(d,'changed budget',['height','bounds'])).cacheHit).toBe(false);
        expect((await regionalComputePipelines(d,'a',['other entry'])).cacheHit).toBe(false);
    });
    it('retries failed compilation and bounds retained variants',async()=>{
        const d=device();d.createComputePipelineAsync.mockRejectedValueOnce(new Error('compile failed'));
        await expect(regionalComputePipelines(d,'a',['height'])).rejects.toThrow('compile failed');
        expect((await regionalComputePipelines(d,'a',['height'])).cacheHit).toBe(false);
        for(const source of ['b','c','d','e']) await regionalComputePipelines(d,source,['height']);
        expect((await regionalComputePipelines(d,'a',['height'])).cacheHit).toBe(false);
    });
});
