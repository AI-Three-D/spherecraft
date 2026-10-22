import {describe,it,expect,vi} from 'vitest';
import {WebGPUBackend} from './webgpuBackend.js';

function fixture() {
    const backend=Object.create(WebGPUBackend.prototype),depth={},color={};
    const begin=vi.fn(()=>({setViewport:vi.fn(),end:vi.fn()}));
    Object.assign(backend,{_currentRenderTarget:{_gpuRenderTarget:{depthView:depth,colorViews:[color]}},
        _commandEncoder:{beginRenderPass:begin},_renderPassEncoder:null,_viewport:{x:0,y:0,width:800,height:600},
        _depthTextureView:{},_ensureCommandEncoder:()=>{}});
    return {backend,begin,depth};
}
describe('opaque depth reused by transparent geometry',()=>{
    it('borrows the active HDR target depth, with no depth writes or load/store operations',()=>{
        const {backend,begin,depth}=fixture();
        expect(backend.getDepthTextureView()).toBe(depth);
        backend.resumeRenderPass({depthReadOnly:true});
        expect(begin.mock.calls[0][0].depthStencilAttachment).toEqual({view:depth,depthReadOnly:true});
        expect(begin.mock.calls[0][0].colorAttachments[0].loadOp).toBe('load');
    });
    it('restores the ordinary depth-writing pass for subsequent draws',()=>{
        const {backend,begin,depth}=fixture();
        backend.resumeRenderPass({depthReadOnly:true});backend.endRenderPassForCompute();backend.resumeRenderPass();
        expect(begin.mock.calls[1][0].depthStencilAttachment).toEqual({view:depth,depthClearValue:1,depthLoadOp:'load',depthStoreOp:'store'});
    });
});
