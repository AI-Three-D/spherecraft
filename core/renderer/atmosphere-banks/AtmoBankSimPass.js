import { buildAtmoBankSimulateWGSL } from './shaders/atmoBankSimulate.wgsl.js';
import { ATMO_WORKGROUP_SIZE, ATMO_TYPE_CAPACITY, ATMO_EMITTER_CAPACITY } from './AtmoBankTypes.js';

export class AtmoBankSimPass {
    constructor(device, buffers) {
        this.device = device;
        this.buffers = buffers;
        this.pipeline = null;
        this.bindGroupAB = null;
        this.bindGroupBA = null;
    }

    initialize() {
        const device = this.device;

        const layout = device.createBindGroupLayout({
            label: 'AtmoBankSim-BGL',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
            ],
        });

        const src = buildAtmoBankSimulateWGSL({
            workgroupSize: ATMO_WORKGROUP_SIZE,
            typeCapacity: ATMO_TYPE_CAPACITY,
            emitterCapacity: ATMO_EMITTER_CAPACITY,
        });

        this.pipeline = device.createComputePipeline({
            label: 'AtmoBankSim-Pipeline',
            layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
            compute: {
                module: device.createShaderModule({ label: 'AtmoBankSim-Shader', code: src }),
                entryPoint: 'main',
            },
        });

        const b = this.buffers;
        const mk = (readBuf, writeBuf, tag) => device.createBindGroup({
            label: `AtmoBankSim-BG-${tag}`,
            layout,
            entries: [
                { binding: 0, resource: { buffer: b.globalsUBO } },
                { binding: 1, resource: { buffer: b.typeDefUBO } },
                { binding: 2, resource: { buffer: readBuf } },
                { binding: 3, resource: { buffer: writeBuf } },
                { binding: 4, resource: { buffer: b.indirect } },
                { binding: 5, resource: { buffer: b.liveList } },
                { binding: 6, resource: { buffer: b.spawnScratch } },
                { binding: 7, resource: { buffer: b.emitterData } },
            ],
        });

        this.bindGroupAB = mk(b.particlesA, b.particlesB, 'AB');
        this.bindGroupBA = mk(b.particlesB, b.particlesA, 'BA');
    }

    dispatch(commandEncoder) {
        const { read } = this.buffers.getPingPong();
        const bg = (read === this.buffers.particlesA) ? this.bindGroupAB : this.bindGroupBA;

        const pass = commandEncoder.beginComputePass({ label: 'AtmoBankSim' });
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, bg);
        pass.dispatchWorkgroups(Math.ceil(this.buffers.maxParticles / ATMO_WORKGROUP_SIZE));
        pass.end();
    }

    dispose() {
        this.pipeline = null;
        this.bindGroupAB = null;
        this.bindGroupBA = null;
    }
}
