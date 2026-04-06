// core/renderer/particles/ParticleSimulationPass.js
//
// Owns the compute pipeline and bind groups for the particle sim shader.
// Two bind groups are built up-front (A->B and B->A) so per-frame dispatch
// only does setPipeline + setBindGroup + dispatchWorkgroups.

import { buildParticleSimulateWGSL } from './shaders/particleSimulate.wgsl.js';

export class ParticleSimulationPass {
    constructor(device, buffers, { workgroupSize = 64, typeCapacity = 8 } = {}) {
        this.device = device;
        this.buffers = buffers;
        this.workgroupSize = workgroupSize;
        this.typeCapacity = typeCapacity;
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
            ],
        });

        const pipelineLayout = device.createPipelineLayout({
            label: 'ParticleSim-PipelineLayout',
            bindGroupLayouts: [this.bindGroupLayout],
        });

        const shaderSrc = buildParticleSimulateWGSL({
            workgroupSize: this.workgroupSize,
            typeCapacity: this.typeCapacity,
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

        this._rebuildBindGroups();
    }

    _rebuildBindGroups() {
        // Build the default bind groups using the shared globalsUBO.
        const { ab, ba } = this.createEmitterBindGroups(this.buffers.globalsUBO);
        this.bindGroupAB = ab;
        this.bindGroupBA = ba;
    }

    // Creates a { ab, ba } bind-group pair that uses the given per-emitter
    // globalsUBO for binding 0. Call once per emitter at registration time.
    createEmitterBindGroups(globalsUBO) {
        const b = this.buffers;
        const label = globalsUBO.label ?? 'emitter';
        const make = (readBuf, writeBuf, suffix) => this.device.createBindGroup({
            label: `ParticleSim-BG-${label}-${suffix}`,
            layout: this.bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: globalsUBO } },
                { binding: 1, resource: { buffer: b.typeDefUBO } },
                { binding: 2, resource: { buffer: readBuf } },
                { binding: 3, resource: { buffer: writeBuf } },
                { binding: 4, resource: { buffer: b.indirectAdditive } },
                { binding: 5, resource: { buffer: b.indirectAlpha } },
                { binding: 6, resource: { buffer: b.liveListAdditive } },
                { binding: 7, resource: { buffer: b.liveListAlpha } },
                { binding: 8, resource: { buffer: b.spawnScratch } },
            ],
        });
        return {
            ab: make(b.particlesA, b.particlesB, 'AB'),
            ba: make(b.particlesB, b.particlesA, 'BA'),
        };
    }

    // `bindGroups` is an optional { ab, ba } pair. When omitted the shared
    // default bind groups (globalsUBO) are used.
    dispatch(commandEncoder, bindGroups) {
        const { read } = this.buffers.getPingPong();
        const bg = bindGroups ?? { ab: this.bindGroupAB, ba: this.bindGroupBA };
        const bindGroup = (read === this.buffers.particlesA) ? bg.ab : bg.ba;

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
