import {beforeEach,describe,expect,it,vi} from 'vitest';
import {acquireRegionalTerrainFoundation} from './regionalTerrainFoundation.js';

function makeDevice() {
    const resources=[];
    const resource=descriptor=>{
        const r={descriptor,destroy:vi.fn(),createView:vi.fn(()=>({}))};resources.push(r);return r;
    };
    const pass=()=>({setPipeline:vi.fn(),setBindGroup:vi.fn(),dispatchWorkgroups:vi.fn(),end:vi.fn()});
    const device={resources,queue:{writeBuffer:vi.fn(),submit:vi.fn(),onSubmittedWorkDone:vi.fn(async()=>{})},
        createTexture:vi.fn(resource),createBuffer:vi.fn(resource),createShaderModule:vi.fn(d=>d),
        createComputePipelineAsync:vi.fn(async()=>({getBindGroupLayout:()=>({})})),createBindGroup:vi.fn(()=>({})),
        createCommandEncoder:vi.fn(()=>({beginComputePass:pass,finish:()=>({})}))};
    return device;
}
const inputs=device=>({device,source:'same source and lower-height contract',uniformBytes:new Uint8Array([1,2,3,4]).buffer,
    cells:16,seamCells:4,budgets:{microM:24,numericalAllowanceM:1}});

describe('terrain generation foundation ownership',()=>{
    beforeEach(()=>{
        vi.stubGlobal('GPUTextureUsage',{STORAGE_BINDING:1,TEXTURE_BINDING:2,COPY_SRC:4});
        vi.stubGlobal('GPUBufferUsage',{UNIFORM:1,COPY_DST:2});
    });
    it('shares only the unchanged published foundation and retires it after the last fence',async()=>{
        const device=makeDevice(),input=inputs(device),a=await acquireRegionalTerrainFoundation(input);
        const b=await acquireRegionalTerrainFoundation({...input,previous:a.foundation});
        expect(b.foundation).toBe(a.foundation);expect(b.timings.dispatches).toBe(0);
        expect(device.queue.submit).toHaveBeenCalledOnce();expect(device.createTexture).toHaveBeenCalledTimes(3);
        await a.foundation.release();expect(b.foundation.users).toBe(1);
        expect(b.foundation.fields[0].destroy).not.toHaveBeenCalled();
        let resolve;device.queue.onSubmittedWorkDone.mockReturnValueOnce(new Promise(r=>{resolve=r;}));
        const retired=b.foundation.release();expect(b.foundation.fields[0].destroy).not.toHaveBeenCalled();
        expect(()=>b.foundation.retain()).toThrow('released');resolve();await retired;
        for(const texture of [...b.foundation.fields,b.foundation.lowerBounds])expect(texture.destroy).toHaveBeenCalledOnce();
        await expect(b.foundation.release()).rejects.toThrow('more than once');
    });
    it('invalidates every terrain dependency using exact inputs rather than the hash',async()=>{
        const device=makeDevice(),input=inputs(device),old=(await acquireRegionalTerrainFoundation(input)).foundation;
        for(const changed of [{source:'different WGSL'}, {uniformBytes:new Uint8Array([1,2,3,5]).buffer},
            {cells:32},{seamCells:5},{budgets:{microM:24,numericalAllowanceM:2}},{device:makeDevice()}]) {
            const next=await acquireRegionalTerrainFoundation({...input,...changed,previous:old});
            expect(next.foundation).not.toBe(old);expect(next.timings.dispatches).toBe(12);await next.foundation.release();
        }
        expect(old.users).toBe(1);expect(old.fields[0].destroy).not.toHaveBeenCalled();await old.release();
    });
    it('does not retain mutable caller uniforms or let a failed replacement destroy the old phase',async()=>{
        const device=makeDevice(),input=inputs(device),old=(await acquireRegionalTerrainFoundation(input)).foundation;
        new Uint8Array(input.uniformBytes)[0]=9;
        device.createTexture.mockImplementationOnce(()=>{throw new Error('out of memory');});
        await expect(acquireRegionalTerrainFoundation({...input,previous:old})).rejects.toThrow('out of memory');
        expect(old.users).toBe(1);expect(old.fields[0].destroy).not.toHaveBeenCalled();
        const shared=await acquireRegionalTerrainFoundation({...inputs(device),previous:old});
        expect(shared.foundation).toBe(old);await shared.foundation.release();await old.release();
    });
    it('releases transient and permanent allocations when generation fails at the fence',async()=>{
        const device=makeDevice();device.queue.onSubmittedWorkDone.mockRejectedValueOnce(new Error('GPU lost'));
        await expect(acquireRegionalTerrainFoundation(inputs(device))).rejects.toThrow('GPU lost');
        expect(device.resources).toHaveLength(10);
        for(const r of device.resources)expect(r.destroy).toHaveBeenCalledOnce();
    });
});
