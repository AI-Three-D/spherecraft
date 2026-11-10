import {describe,it,expect,vi} from 'vitest';
import {WebGPUBackend} from './webgpuBackend.js';

function fixture(){
    let resolve,reject;
    const pending=new Promise((yes,no)=>{resolve=yes;reject=no;});
    const backend=Object.create(WebGPUBackend.prototype),create=vi.fn(()=>pending);
    Object.assign(backend,{_pipelineCache:new Map(),sceneFormat:'rgba16float',
        _createBindGroupLayouts:()=>[],device:{createShaderModule:()=>({}),createPipelineLayout:()=>({}),createRenderPipelineAsync:create},
        _renderPassEncoder:{setPipeline:vi.fn()}});
    const material={name:'WaterSimSurface',vertexShader:'vertex',fragmentShader:'fragment',vertexLayout:[],asyncCompile:true,
        transparent:true,blending:'premultiplied',side:'double',depthTest:true,depthWrite:false,_needsCompile:true};
    return {backend,material,create,resolve,reject};
}
describe('optional asynchronous material pipeline',()=>{
    it('keeps pipelines distinct when modules use different render state with the same shaders',()=>{
        const f=fixture();
        f.material.asyncCompile=false;
        f.backend.device.createRenderPipeline=vi.fn(()=>({}));
        f.backend.device.pushErrorScope=vi.fn();
        f.backend.device.popErrorScope=vi.fn(()=>Promise.resolve(null));
        f.backend.compileShader(f.material);
        const opaque={...f.material,transparent:false,depthWrite:true,_gpuPipeline:null};
        f.backend.compileShader(opaque);
        expect(f.backend.device.createRenderPipeline).toHaveBeenCalledTimes(2);
        f.backend.compileShader({...opaque,_gpuPipeline:null});
        expect(f.backend.device.createRenderPipeline).toHaveBeenCalledTimes(2);
    });
    it('skips an unready draw, then makes the compiled pipeline reusable',async()=>{
        const f=fixture();
        expect(f.backend.compileShader(f.material)).toBeNull();
        expect(()=>f.backend.draw({},f.material)).not.toThrow();
        expect(f.backend._renderPassEncoder.setPipeline).not.toHaveBeenCalled();
        expect(f.create).toHaveBeenCalledTimes(1);
        const pipeline={};f.resolve(pipeline);await f.material._pipelinePromise;
        expect(f.backend.compileShader(f.material).pipeline).toBe(pipeline);
        expect(f.material._needsCompile).toBe(false);
        const duplicate={...f.material,_gpuPipeline:null,_pipelinePromise:null};
        expect(f.backend.compileShader(duplicate).pipeline).toBe(pipeline);
        expect(f.create).toHaveBeenCalledTimes(1);
    });
    it('keeps the fallback drawable if asynchronous compilation fails',async()=>{
        const f=fixture(),log=vi.spyOn(console,'error').mockImplementation(()=>{});
        try{
            f.backend.compileShader(f.material);f.reject(new Error('shader unavailable'));
            expect(await f.material._pipelinePromise).toBeNull();
            expect(()=>f.backend.draw({},f.material)).not.toThrow();
            expect(f.backend._renderPassEncoder.setPipeline).not.toHaveBeenCalled();
            expect(log).toHaveBeenCalledTimes(1);expect(f.create).toHaveBeenCalledTimes(1);
        }finally{log.mockRestore();}
    });
    it('handles rejected compilation diagnostics and scopes after browser instance loss',async()=>{
        const f=fixture(),log=vi.spyOn(console,'error').mockImplementation(()=>{});
        Object.assign(f.backend.device,{
            createShaderModule:()=>({getCompilationInfo:()=>Promise.reject(new Error('Instance dropped error in getCompilationInfo'))}),
            pushErrorScope:vi.fn(),popErrorScope:vi.fn(()=>Promise.reject(new Error('Instance dropped in popErrorScope'))),
            createRenderPipeline:vi.fn(()=>({})),
        });
        f.material.asyncCompile=false;
        try {
            f.backend.compileShader(f.material);await new Promise(resolve=>setTimeout(resolve,0));
            expect(f.backend.device.popErrorScope).toHaveBeenCalledTimes(2);
            expect(f.backend.deviceLoss?.reason).toBe('unknown');
            expect(f.backend.compileShader({...f.material,_gpuPipeline:null})).toBeNull();
            expect(log).not.toHaveBeenCalled();
        } finally {log.mockRestore();}
    });
    it('drains synchronous error scopes even if creation throws',()=>{
        const f=fixture(),log=vi.spyOn(console,'error').mockImplementation(()=>{});
        Object.assign(f.backend.device,{pushErrorScope:vi.fn(),popErrorScope:vi.fn(()=>Promise.resolve(null)),
            createRenderPipeline:()=>{throw new Error('invalid pipeline');}});
        f.material.asyncCompile=false;
        try {
            expect(()=>f.backend.compileShader(f.material)).toThrow('invalid pipeline');
            expect(f.backend.device.popErrorScope).toHaveBeenCalledTimes(2);
        } finally {log.mockRestore();}
    });
});
