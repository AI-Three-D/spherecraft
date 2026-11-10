import {hashParts} from '../hydrology/waterCache.js';
import {regionalComputePipelines} from './regionalPipelines.js';

const VERSION='regional-generation-foundation-v1';

/**
 * Immutable first phase of terrain generation. Only the currently published
 * generation can lend its inputs to a replacement; there is no value cache.
 * Source and uniforms must match exactly, independent of hash collisions.
 * Every generation holds one ownership share until its final queue fence.
 */
export async function acquireRegionalTerrainFoundation({device,source,uniformBytes,cells,seamCells,budgets,
    previous=null,version=1,reusePipelines=true}) {
    const started=performance.now(),budgetKey=JSON.stringify(budgets);
    if(previous?.matches({device,source,uniformBytes,cells,seamCells,budgetKey,contractVersion:VERSION})) {
        previous.retain();
        return {foundation:previous,timings:{reused:true,totalMs:performance.now()-started,
            compileMs:0,pipelineCacheHit:true,encodeMs:0,completionWallMs:0,dispatches:0,uploadBytes:0}};
    }
    const key=hashParts([VERSION,source,uniformBytes,cells,seamCells,budgets]);
    const compileStarted=performance.now();
    const {pipelines:[pipeline,boundsPipeline],cacheHit:pipelineCacheHit}=await regionalComputePipelines(device,source,
        ['regionalBakeMain','regionalBoundsMain'],{reuse:reusePipelines});
    const compileMs=performance.now()-compileStarted,size=cells+3,fields=[],temporary=[];
    let lowerBounds;
    try {
        for(const field of ['A','B'])fields.push(device.createTexture({label:`Regional macro ${field} v${version}`,
            size:[size,size,6],format:'rgba32float',
            usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_SRC}));
        lowerBounds=device.createTexture({label:`Regional natural lower bounds v${version}`,size:[cells,cells,6],format:'r32float',
            usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_SRC});
        const uniform=device.createBuffer({label:'Regional macro uniforms',size:uniformBytes.byteLength,
            usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});temporary.push(uniform);
        device.queue.writeBuffer(uniform,0,uniformBytes);
        const tEncode=performance.now(),encoder=device.createCommandEncoder({label:'RegionalMacro'});
        for(let face=0;face<6;face++) {
            const p=device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});temporary.push(p);
            device.queue.writeBuffer(p,0,new Uint32Array([face,cells,0,0]));
            const pass=encoder.beginComputePass({label:`RegionalMacro-face${face}`});
            pass.setPipeline(pipeline);
            pass.setBindGroup(0,device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
                {binding:0,resource:{buffer:uniform}},{binding:6,resource:{buffer:p}},
                ...fields.map((texture,i)=>({binding:7+i,resource:texture.createView({dimension:'2d',baseArrayLayer:face,arrayLayerCount:1})})),
            ]}));
            pass.dispatchWorkgroups(Math.ceil(size/8),Math.ceil(size/8));pass.end();
            const boundsPass=encoder.beginComputePass({label:`RegionalBounds-face${face}`});
            boundsPass.setPipeline(boundsPipeline);
            boundsPass.setBindGroup(0,device.createBindGroup({layout:boundsPipeline.getBindGroupLayout(0),entries:[
                {binding:0,resource:{buffer:uniform}},{binding:6,resource:{buffer:p}},
                ...fields.map((texture,i)=>({binding:9+i,resource:texture.createView({dimension:'2d',baseArrayLayer:face,arrayLayerCount:1})})),
                {binding:11,resource:lowerBounds.createView({dimension:'2d',baseArrayLayer:face,arrayLayerCount:1})},
            ]}));
            boundsPass.dispatchWorkgroups(Math.ceil(cells/8),Math.ceil(cells/8));boundsPass.end();
        }
        device.queue.submit([encoder.finish()]);const encodeMs=performance.now()-tEncode,tFence=performance.now();
        await device.queue.onSubmittedWorkDone();const completionWallMs=performance.now()-tFence;
        const uniforms=new Uint8Array(uniformBytes.slice(0));
        let users=1,closed=false;
        const foundation={key,fields,lowerBounds,cells,seamCells,size,contractVersion:VERSION,
            byteLength:2*6*size*size*16+6*cells*cells*4,cpuBytes:uniforms.byteLength,
            // String storage is engine-dependent and may be deduplicated.
            // Expose code units separately from measured typed-array payload.
            sourceCodeUnits:source.length,budgetCodeUnits:budgetKey.length,
            matches(input) {
                const bytes=new Uint8Array(input.uniformBytes);
                return !closed&&input.contractVersion===VERSION&&device===input.device&&source===input.source&&cells===input.cells
                    &&seamCells===input.seamCells&&budgetKey===input.budgetKey&&uniforms.length===bytes.length
                    &&uniforms.every((byte,i)=>byte===bytes[i]);
            },
            retain() {if(closed)throw new Error('Regional foundation has been released');users++;},
            async release() {
                if(closed)throw new Error('Regional foundation released more than once');
                if(--users>0)return;
                closed=true;
                try {await device.queue.onSubmittedWorkDone();}
                finally {for(const texture of fields)texture.destroy();lowerBounds.destroy();}
            },
            get users(){return users;},
        };
        return {foundation,timings:{reused:false,totalMs:performance.now()-started,compileMs,pipelineCacheHit,encodeMs,
            completionWallMs,dispatches:12,uploadBytes:uniformBytes.byteLength+6*16}};
    } catch(error) {
        try {await device.queue.onSubmittedWorkDone();}
        finally {for(const texture of fields)texture.destroy();lowerBounds?.destroy();}
        throw error;
    } finally {for(const buffer of temporary)buffer.destroy();}
}
