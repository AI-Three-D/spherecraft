import { buildAtmoBankSimulateWGSL } from './shaders/atmoBankSimulate.wgsl.js';
import { ATMO_WORKGROUP_SIZE, ATMO_TYPE_CAPACITY, ATMO_EMITTER_CAPACITY } from './AtmoBankTypes.js';

export class AtmoBankSimPass {
    constructor(device, buffers) {
        this.device = device;
        this.buffers = buffers;
        this.pipeline = null;
        this.bindGroupAB = null;
        this.bindGroupBA = null;
        this._layout = null;
        this._emitterBuffer = null;
        this._emitterCounterBuffer = null;
        this._bindGroupsDirty = true;
    }

    initialize() {
        const device = this.device;

        this._layout = device.createBindGroupLayout({
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
                { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
            ],
        });

        const src = buildAtmoBankSimulateWGSL({
            workgroupSize: ATMO_WORKGROUP_SIZE,
            typeCapacity: ATMO_TYPE_CAPACITY,
            emitterCapacity: ATMO_EMITTER_CAPACITY,
        });

        this.pipeline = device.createComputePipeline({
            label: 'AtmoBankSim-Pipeline',
            layout: device.createPipelineLayout({ bindGroupLayouts: [this._layout] }),
            compute: {
                module: device.createShaderModule({ label: 'AtmoBankSim-Shader', code: src }),
                entryPoint: 'main',
            },
        });

        this._emitterBuffer = this.buffers.emitterData;
        this._emitterCounterBuffer = this.buffers.emitterCounter;
        this._rebuildBindGroups();
    }

    setEmitterSource(emitterBuffer, counterBuffer) {
        const nextEmitter = emitterBuffer || this.buffers.emitterData;
        const nextCounter = counterBuffer || this.buffers.emitterCounter;
        if (this._emitterBuffer === nextEmitter && this._emitterCounterBuffer === nextCounter) return;
        this._emitterBuffer = nextEmitter;
        this._emitterCounterBuffer = nextCounter;
        this._bindGroupsDirty = true;
    }

    _rebuildBindGroups() {
        if (!this.pipeline || !this._layout) return;
        const b = this.buffers;
        const emitterBuffer = this._emitterBuffer || b.emitterData;
        const emitterCounterBuffer = this._emitterCounterBuffer || b.emitterCounter;
        const mk = (readBuf, writeBuf, tag) => this.device.createBindGroup({
            label: `AtmoBankSim-BG-${tag}`,
            layout: this._layout,
            entries: [
                { binding: 0, resource: { buffer: b.globalsUBO } },
                { binding: 1, resource: { buffer: b.typeDefUBO } },
                { binding: 2, resource: { buffer: readBuf } },
                { binding: 3, resource: { buffer: writeBuf } },
                { binding: 4, resource: { buffer: b.indirect } },
                { binding: 5, resource: { buffer: b.liveList } },
                { binding: 6, resource: { buffer: b.spawnScratch } },
                { binding: 7, resource: { buffer: emitterBuffer } },
                { binding: 8, resource: { buffer: emitterCounterBuffer } },
            ],
        });

        this.bindGroupAB = mk(b.particlesA, b.particlesB, 'AB');
        this.bindGroupBA = mk(b.particlesB, b.particlesA, 'BA');
        this._bindGroupsDirty = false;
    }

    dispatch(commandEncoder) {
        if (this._bindGroupsDirty) this._rebuildBindGroups();
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
        this._layout = null;
        this._emitterBuffer = null;
        this._emitterCounterBuffer = null;
        this._bindGroupsDirty = true;
    }
}
