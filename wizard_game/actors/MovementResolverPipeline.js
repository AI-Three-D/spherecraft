// js/actors/MovementResolverPipeline.js

import { Logger } from '../../shared/Logger.js';
import { buildMovementResolverShader } from './movementResolver.wgsl.js';
import { gpuFormatSampleType } from '../../core/renderer/resources/texture.js';

export class MovementResolverPipeline {
    constructor(device, textureFormats = {}) {
        this.device = device;
        this._formats = textureFormats;
        this._pipeline = null;
        this._bgLayout = null;
        this._bindGroup = null;
        this._cache = { h: null, n: null, hash: null, ct: null, ctc: null };

        // Fallback buffers when TreeDetailSystem isn't available.
        this._dummyTreeBuf = null;
        this._dummyTreeCountBuf = null;
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

        // Dummy collision buffers: count=0, so the loop is a no-op.
        this._dummyTreeBuf = this.device.createBuffer({
            label: 'ActorResolver-DummyTrees',
            size: 256,
            usage: GPUBufferUsage.STORAGE,
        });
        this._dummyTreeCountBuf = this.device.createBuffer({
            label: 'ActorResolver-DummyTreeCount',
            size: 256,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(this._dummyTreeCountBuf, 0, new Uint32Array([0]));

        Logger.info('[MovementResolverPipeline] initialized');
    }

    dispatch(encoder, actorCount, buffers, textures, hashTableBuffer,
             closeTreeBuf, closeTreeCountBuf) {
        if (!this._pipeline || actorCount <= 0) return;

        const hTex = textures?.height?._gpuTexture?.texture;
        const nTex = textures?.normal?._gpuTexture?.texture;
        if (!hTex || !nTex || !hashTableBuffer) return;

        const ctBuf  = closeTreeBuf      ?? this._dummyTreeBuf;
        const ctcBuf = closeTreeCountBuf ?? this._dummyTreeCountBuf;

        if (this._cache.h !== hTex || this._cache.n !== nTex
            || this._cache.hash !== hashTableBuffer
            || this._cache.ct !== ctBuf || this._cache.ctc !== ctcBuf) {
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
                ],
            });
            this._cache = { h: hTex, n: nTex, hash: hashTableBuffer, ct: ctBuf, ctc: ctcBuf };
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
    }
}