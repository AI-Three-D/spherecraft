// core/renderer/particles/ParticleSimulationPass.js
//
// Owns the compute pipeline and bind groups for the particle sim shader.
// Two bind groups are built up-front (A->B and B->A) so per-frame dispatch
// only does setPipeline + setBindGroup + dispatchWorkgroups.

import { buildParticleSimulateWGSL } from './shaders/particleSimulate.wgsl.js';

export class ParticleSimulationPass {
    constructor(device, buffers, {
        workgroupSize = 64,
        typeCapacity = 8,
        emitterCapacity = 16,
    } = {}) {
        this.device = device;
        this.buffers = buffers;
        this.workgroupSize = workgroupSize;
        this.typeCapacity = typeCapacity;
        this.emitterCapacity = emitterCapacity;
        this.pipeline = null;
        this.bindGroupLayout = null;
        this.bindGroupAB = null;   // read A, write B
        this.bindGroupBA = null;   // read B, write A
    }

    initialize() {
        const device = this.device;

        this.bindGroupLayout = device.createBindGroupLayout({
            label: 'ParticleSim-BindGroupLayout',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 9, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 10, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 11, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
            ],
        });

        const pipelineLayout = device.createPipelineLayout({
            label: 'ParticleSim-PipelineLayout',
            bindGroupLayouts: [this.bindGroupLayout],
        });

        const shaderSrc = buildParticleSimulateWGSL({
            workgroupSize: this.workgroupSize,
            typeCapacity: this.typeCapacity,
            emitterCapacity: this.emitterCapacity,
        });
        const module = device.createShaderModule({
            label: 'ParticleSim-Shader',
            code: shaderSrc,
        });

        this.pipeline = device.createComputePipeline({
            label: 'ParticleSim-Pipeline',
            layout: pipelineLayout,
            compute: { module, entryPoint: 'main' },
        });

        const b = this.buffers;
        const make = (readBuf, writeBuf, suffix) => this.device.createBindGroup({
            label: `ParticleSim-BG-${suffix}`,
            layout: this.bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: b.globalsUBO } },
                { binding: 1, resource: { buffer: b.typeDefUBO } },
                { binding: 2, resource: { buffer: readBuf } },
                { binding: 3, resource: { buffer: writeBuf } },
                { binding: 4, resource: { buffer: b.indirectAdditive } },
                { binding: 5, resource: { buffer: b.indirectAlpha } },
                { binding: 6, resource: { buffer: b.indirectBloom } },
                { binding: 7, resource: { buffer: b.liveListAdditive } },
                { binding: 8, resource: { buffer: b.liveListAlpha } },
                { binding: 9, resource: { buffer: b.liveListBloom } },
                { binding: 10, resource: { buffer: b.spawnScratch } },
                { binding: 11, resource: { buffer: b.emitterData } },
            ],
        });

        this.bindGroupAB = make(b.particlesA, b.particlesB, 'AB');
        this.bindGroupBA = make(b.particlesB, b.particlesA, 'BA');
    }

    dispatch(commandEncoder) {
        const { read } = this.buffers.getPingPong();
        const bindGroup = (read === this.buffers.particlesA)
            ? this.bindGroupAB
            : this.bindGroupBA;

        const pass = commandEncoder.beginComputePass({ label: 'ParticleSim' });
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, bindGroup);

        const groupCount = Math.ceil(this.buffers.maxParticles / this.workgroupSize);
        pass.dispatchWorkgroups(groupCount);
        pass.end();
    }

    dispose() {
        // Pipelines/bind groups are GC'd with the device. Explicit drop:
        this.pipeline = null;
        this.bindGroupLayout = null;
        this.bindGroupAB = null;
        this.bindGroupBA = null;
    }
}
