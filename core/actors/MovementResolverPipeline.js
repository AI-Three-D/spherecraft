// core/actors/MovementResolverPipeline.js
//
// GPU compute pipeline that runs the spherical-planet actor movement
// resolver shader. Bindings 6/7 are tree-trunk colliders (from
// TreeDetailSystem); bindings 8/9 are platform top-surface colliders
// (from games that want "stand-on-me" geometry like cloud platforms).
// Both are optional — when not wired, dummy zero-count buffers are used.

import { Logger } from '../../shared/Logger.js';
import { buildMovementResolverShader } from './movementResolver.wgsl.js';
import { gpuFormatSampleType } from '../renderer/resources/texture.js';

export class MovementResolverPipeline {
    constructor(device, textureFormats = {}) {
        this.device = device;
        this._formats = textureFormats;
        this._pipeline = null;
        this._bgLayout = null;
        this._bindGroup = null;
        this._cache = { h: null, n: null, hash: null, ct: null, ctc: null, cp: null, cpc: null };

        this._dummyTreeBuf = null;
        this._dummyTreeCountBuf = null;
        this._dummyPlatformBuf = null;
        this._dummyPlatformCountBuf = null;
    }

    initialize() {
        const heightST = gpuFormatSampleType(this._formats.height || 'r32float');
        const normalST = gpuFormatSampleType(this._formats.normal || 'rgba8unorm');

        this._bgLayout = this.device.createBindGroupLayout({
            label: 'ActorResolver-BGL',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE,
                  texture: { sampleType: heightST, viewDimension: '2d-array' } },
                { binding: 4, visibility: GPUShaderStage.COMPUTE,
                  texture: { sampleType: normalST, viewDimension: '2d-array' } },
                { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 9, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
            ],
        });

        const module = this.device.createShaderModule({
            label: 'ActorResolver-Shader',
            code: buildMovementResolverShader(),
        });

        this._pipeline = this.device.createComputePipeline({
            label: 'ActorResolver-Pipeline',
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [this._bgLayout] }),
            compute: { module, entryPoint: 'main' },
        });

        this._dummyTreeBuf = this.device.createBuffer({
            label: 'ActorResolver-DummyTrees',
            size: 256, usage: GPUBufferUsage.STORAGE,
        });
        this._dummyTreeCountBuf = this.device.createBuffer({
            label: 'ActorResolver-DummyTreeCount',
            size: 256, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(this._dummyTreeCountBuf, 0, new Uint32Array([0]));

        this._dummyPlatformBuf = this.device.createBuffer({
            label: 'ActorResolver-DummyPlatforms',
            size: 256, usage: GPUBufferUsage.STORAGE,
        });
        this._dummyPlatformCountBuf = this.device.createBuffer({
            label: 'ActorResolver-DummyPlatformCount',
            size: 256, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(this._dummyPlatformCountBuf, 0, new Uint32Array([0]));

        Logger.info('[MovementResolverPipeline] initialized (vertical physics + platforms)');
    }

    dispatch(encoder, actorCount, buffers, textures, hashTableBuffer,
             closeTreeBuf, closeTreeCountBuf,
             closePlatformBuf = null, closePlatformCountBuf = null) {
        if (!this._pipeline || actorCount <= 0) return;

        const hTex = textures?.height?._gpuTexture?.texture;
        const nTex = textures?.normal?._gpuTexture?.texture;
        if (!hTex || !nTex || !hashTableBuffer) return;

        const ctBuf  = closeTreeBuf      ?? this._dummyTreeBuf;
        const ctcBuf = closeTreeCountBuf ?? this._dummyTreeCountBuf;
        const cpBuf  = closePlatformBuf  ?? this._dummyPlatformBuf;
        const cpcBuf = closePlatformCountBuf ?? this._dummyPlatformCountBuf;

        if (this._cache.h !== hTex || this._cache.n !== nTex
            || this._cache.hash !== hashTableBuffer
            || this._cache.ct !== ctBuf || this._cache.ctc !== ctcBuf
            || this._cache.cp !== cpBuf || this._cache.cpc !== cpcBuf) {
            this._bindGroup = this.device.createBindGroup({
                label: 'ActorResolver-BG',
                layout: this._bgLayout,
                entries: [
                    { binding: 0, resource: { buffer: buffers.intentBuffer } },
                    { binding: 1, resource: { buffer: buffers.stateBuffer } },
                    { binding: 2, resource: { buffer: buffers.paramsBuffer } },
                    { binding: 3, resource: hTex.createView({ dimension: '2d-array' }) },
                    { binding: 4, resource: nTex.createView({ dimension: '2d-array' }) },
                    { binding: 5, resource: { buffer: hashTableBuffer } },
                    { binding: 6, resource: { buffer: ctBuf } },
                    { binding: 7, resource: { buffer: ctcBuf } },
                    { binding: 8, resource: { buffer: cpBuf } },
                    { binding: 9, resource: { buffer: cpcBuf } },
                ],
            });
            this._cache = { h: hTex, n: nTex, hash: hashTableBuffer,
                            ct: ctBuf, ctc: ctcBuf, cp: cpBuf, cpc: cpcBuf };
        }

        const pass = encoder.beginComputePass({ label: 'ActorResolver' });
        pass.setPipeline(this._pipeline);
        pass.setBindGroup(0, this._bindGroup);
        pass.dispatchWorkgroups(Math.ceil(actorCount / 64));
        pass.end();
    }

    dispose() {
        this._dummyTreeBuf?.destroy();
        this._dummyTreeCountBuf?.destroy();
        this._dummyPlatformBuf?.destroy();
        this._dummyPlatformCountBuf?.destroy();
    }
}
