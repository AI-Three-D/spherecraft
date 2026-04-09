// core/renderer/particles/ParticleRenderPass.js
//
// Owns the two render pipelines (additive and alpha) that consume the
// live-lists produced by the sim compute. Draw calls are indirect — the
// instance count comes from GPU-written buffers, never from CPU.

import { buildParticleRenderWGSL } from './shaders/particleRender.wgsl.js';

export class ParticleRenderPass {
    constructor(device, buffers, {
        colorFormat,
        depthFormat = 'depth24plus',
        typeCapacity = 8,
    }) {
        this.device = device;
        this.buffers = buffers;
        this.colorFormat = colorFormat;
        this.depthFormat = depthFormat;
        this.typeCapacity = typeCapacity;

        this.pipelineAdditive = null;
        this.pipelineAlpha = null;
        this.pipelineBloom = null;
        this.bindGroupLayout = null;
        this.bindGroupAdditiveFromA = null;
        this.bindGroupAdditiveFromB = null;
        this.bindGroupAlphaFromA = null;
        this.bindGroupAlphaFromB = null;
        this.bindGroupBloomFromA = null;
        this.bindGroupBloomFromB = null;
    }

    initialize() {
        const device = this.device;

        // One bind group layout, shared by both pipelines.
        this.bindGroupLayout = device.createBindGroupLayout({
            label: 'ParticleRender-BindGroupLayout',
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: { type: 'uniform' },
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.VERTEX,
                    buffer: { type: 'read-only-storage' },
                },
                {
                    binding: 2,
                    visibility: GPUShaderStage.VERTEX,
                    buffer: { type: 'read-only-storage' },
                },
                {
                    binding: 3,
                    visibility: GPUShaderStage.FRAGMENT,
                    buffer: { type: 'uniform' },
                },
            ],
        });

        const pipelineLayout = device.createPipelineLayout({
            label: 'ParticleRender-PipelineLayout',
            bindGroupLayouts: [this.bindGroupLayout],
        });

        const src = buildParticleRenderWGSL({ typeCapacity: this.typeCapacity });
        const module = device.createShaderModule({
            label: 'ParticleRender-Shader',
            code: src,
        });

        const primitive = { topology: 'triangle-list', cullMode: 'none' };
        const depthStencil = {
            format: this.depthFormat,
            depthWriteEnabled: false,
            depthCompare: 'less',
        };

        const additiveTarget = {
            format: this.colorFormat,
            blend: {
                color: { srcFactor: 'src-alpha', dstFactor: 'one',                 operation: 'add' },
                alpha: { srcFactor: 'zero',      dstFactor: 'one',                 operation: 'add' },
            },
            writeMask: GPUColorWrite.ALL,
        };

        const alphaTarget = {
            format: this.colorFormat,
            blend: {
                color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                alpha: { srcFactor: 'one',       dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
            writeMask: GPUColorWrite.ALL,
        };

        this.pipelineAdditive = device.createRenderPipeline({
            label: 'ParticleRender-Additive',
            layout: pipelineLayout,
            vertex:   { module, entryPoint: 'vs_main' },
            fragment: { module, entryPoint: 'fs_main', targets: [additiveTarget] },
            primitive,
            depthStencil,
        });

        this.pipelineAlpha = device.createRenderPipeline({
            label: 'ParticleRender-Alpha',
            layout: pipelineLayout,
            vertex:   { module, entryPoint: 'vs_main' },
            fragment: { module, entryPoint: 'fs_main', targets: [alphaTarget] },
            primitive,
            depthStencil,
        });

        this.pipelineBloom = device.createRenderPipeline({
            label: 'ParticleRender-Bloom',
            layout: pipelineLayout,
            vertex: { module, entryPoint: 'vs_main' },
            fragment: { module, entryPoint: 'fs_bloom', targets: [additiveTarget] },
            primitive,
            depthStencil,
        });

        this._rebuildBindGroups();
    }

    _rebuildBindGroups() {
        const b = this.buffers;
        const make = (particleBuf, liveList, label) => this.device.createBindGroup({
            label,
            layout: this.bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: b.globalsUBO } },
                { binding: 1, resource: { buffer: particleBuf } },
                { binding: 2, resource: { buffer: liveList } },
                { binding: 3, resource: { buffer: b.typeDefUBO } },
            ],
        });

        this.bindGroupAdditiveFromA = make(b.particlesA, b.liveListAdditive, 'ParticleRender-Additive-A');
        this.bindGroupAdditiveFromB = make(b.particlesB, b.liveListAdditive, 'ParticleRender-Additive-B');
        this.bindGroupAlphaFromA    = make(b.particlesA, b.liveListAlpha,    'ParticleRender-Alpha-A');
        this.bindGroupAlphaFromB    = make(b.particlesB, b.liveListAlpha,    'ParticleRender-Alpha-B');
        this.bindGroupBloomFromA    = make(b.particlesA, b.liveListBloom,    'ParticleRender-Bloom-A');
        this.bindGroupBloomFromB    = make(b.particlesB, b.liveListBloom,    'ParticleRender-Bloom-B');
    }

    // `renderPassEncoder` must already be in a render pass for the main color
    // target. We issue two draw calls against GPU-written indirect args.
    //
    // `readBuffer` is the particle buffer the sim shader WROTE to this frame —
    // i.e. the side the render pass should READ from.
    render(renderPassEncoder, readBuffer) {
        const bgAdd = (readBuffer === this.buffers.particlesA)
            ? this.bindGroupAdditiveFromA
            : this.bindGroupAdditiveFromB;
        const bgAlpha = (readBuffer === this.buffers.particlesA)
            ? this.bindGroupAlphaFromA
            : this.bindGroupAlphaFromB;

        // Additive pass first — doesn't matter for order since neither writes depth.
        renderPassEncoder.setPipeline(this.pipelineAdditive);
        renderPassEncoder.setBindGroup(0, bgAdd);
        renderPassEncoder.drawIndirect(this.buffers.indirectAdditive, 0);

        renderPassEncoder.setPipeline(this.pipelineAlpha);
        renderPassEncoder.setBindGroup(0, bgAlpha);
        renderPassEncoder.drawIndirect(this.buffers.indirectAlpha, 0);
    }

    renderBloom(renderPassEncoder, readBuffer) {
        const bgBloom = (readBuffer === this.buffers.particlesA)
            ? this.bindGroupBloomFromA
            : this.bindGroupBloomFromB;

        renderPassEncoder.setPipeline(this.pipelineBloom);
        renderPassEncoder.setBindGroup(0, bgBloom);
        renderPassEncoder.drawIndirect(this.buffers.indirectBloom, 0);
    }

    dispose() {
        this.pipelineAdditive = null;
        this.pipelineAlpha = null;
        this.pipelineBloom = null;
        this.bindGroupLayout = null;
        this.bindGroupAdditiveFromA = null;
        this.bindGroupAdditiveFromB = null;
        this.bindGroupAlphaFromA = null;
        this.bindGroupAlphaFromB = null;
        this.bindGroupBloomFromA = null;
        this.bindGroupBloomFromB = null;
    }
}
