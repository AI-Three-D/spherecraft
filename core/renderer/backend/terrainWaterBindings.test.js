import {describe,it,expect} from 'vitest';
import {WebGPUBackend} from './webgpuBackend.js';
import {terrainBindingAdapter} from '../terrain/materials/terrainBindings.js';

describe('terrain water resource replacement',()=>{
    it('reuses stable bindings and replaces each changed water resource after regeneration',()=>{
        const b=Object.create(WebGPUBackend.prototype),materialCache=new Map(),geometryCache=new Map(),uniforms=new Map();
        const storage={},texture={},array={},depth={},sampler={};let groupsCreated=0;
        Object.assign(b,{
            device:{createBindGroup:d=>({...d,id:++groupsCreated})},_chunkTextureNames:[],_atlasTextureNames:[],
            _samplerCache:new Map(['linear','linear-repeat','nearest','shadow-comparison'].map(k=>[k,sampler])),
            _getMaterialBindGroupCache:()=>materialCache,_getGeometryBindGroupCache:()=>geometryCache,
            _packVertexUniforms:()=>new Float32Array(4),_packFragmentUniforms:()=>new Float32Array(4),
            _getOrCreateUniformBuffer:key=>{if(!uniforms.has(key))uniforms.set(key,{});return uniforms.get(key);},
            _buildTextureKey:()=>'',_getOrCreateDummyTextureView:()=>texture,_getOrCreateDummyArrayTextureView:()=>array,
            _getOrCreateDummyDepthTextureView:()=>depth,_getOrCreateDummyStorageBuffer:()=>storage,
        });
        const resources={index:{},lakes:{},masks:{},params:{}},field={pages:{},texels:{},params:{}};
        const u={_waterData:{value:{resources,riverField:{resources:field}}},heightScale:{value:2000},chunksPerFace:{value:64}},m={id:1,bindingAdapter:terrainBindingAdapter,_gpuPipeline:{bindGroupLayouts:[{},{},{},{}]}};
        const first=b._createBindGroups(m,u,{});
        expect(b._createBindGroups(m,u,{})[3]).toBe(first[3]);expect(groupsCreated).toBe(4);
        let previous=first[3];
        for(const [from,key,binding] of [[resources,'index',12],[resources,'lakes',13],[resources,'masks',14],[resources,'params',15],
            [field,'pages',17],[field,'texels',18],[field,'params',19]]) {
            from[key]={};const next=b._createBindGroups(m,u,{})[3];
            expect(next).not.toBe(previous);
            const entry=next.entries.find(e=>e.binding===binding);
            expect(binding===14?entry.resource:entry.resource.buffer).toBe(from[key]);
            expect(b._createBindGroups(m,u,{})[3]).toBe(next);previous=next;
        }
        expect(groupsCreated).toBe(11);
    });
});
