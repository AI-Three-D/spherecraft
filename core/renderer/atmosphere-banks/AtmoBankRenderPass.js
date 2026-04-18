import { buildAtmoBankRenderWGSL } from './shaders/atmoBankRender.wgsl.js';
import { ATMO_TYPE_CAPACITY } from './AtmoBankTypes.js';

export class AtmoBankRenderPass {
    constructor(device, buffers, { colorFormat, depthFormat = 'depth24plus' }) {
        this.device = device;
        this.buffers = buffers;
        this.colorFormat = colorFormat;
        this.depthFormat = depthFormat;

        this.pipeline = null;
        this._bufferBGL = null;
        this._textureBGL = null;
        this._bufferBG_A = null;
        this._bufferBG_B = null;
        this._textureBG = null;

        this._noiseBaseView = null;
        this._noiseDetailView = null;
        this._depthView = null;
        this._noiseSampler = null;
        this._textureBGDirty = true;
    }

    initialize() {
        const device = this.device;

        this._bufferBGL = device.createBindGroupLayout({
            label: 'AtmoBankRender-BufferBGL',
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
                { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
                { binding: 3, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            ],
        });

        this._textureBGL = device.createBindGroupLayout({
            label: 'AtmoBankRender-TextureBGL',
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '3d' } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '3d' } },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
                { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth', viewDimension: '2d' } },
            ],
        });

        const src = buildAtmoBankRenderWGSL({ typeCapacity: ATMO_TYPE_CAPACITY });
        const module = device.createShaderModule({ label: 'AtmoBankRender-Shader', code: src });

        this.pipeline = device.createRenderPipeline({
            label: 'AtmoBankRender-Pipeline',
            layout: device.createPipelineLayout({
                bindGroupLayouts: [this._bufferBGL, this._textureBGL],
            }),
            vertex: { module, entryPoint: 'vs_main' },
            fragment: {
                module,
                entryPoint: 'fs_main',
                targets: [{
                    format: this.colorFormat,
                    blend: {
                        color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                    },
                    writeMask: GPUColorWrite.ALL,
                }],
            },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: {
                format: this.depthFormat,
                depthWriteEnabled: false,
                depthCompare: 'less',
            },
        });

        this._noiseSampler = device.createSampler({
            label: 'AtmoBankNoiseSampler',
            magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
            addressModeU: 'repeat', addressModeV: 'repeat', addressModeW: 'repeat',
        });

        this._rebuildBufferBindGroups();
    }

    _rebuildBufferBindGroups() {
        const b = this.buffers;
        const mk = (particleBuf, label) => this.device.createBindGroup({
            label, layout: this._bufferBGL,
            entries: [
                { binding: 0, resource: { buffer: b.globalsUBO } },
                { binding: 1, resource: { buffer: particleBuf } },
                { binding: 2, resource: { buffer: b.liveList } },
                { binding: 3, resource: { buffer: b.typeDefUBO } },
            ],
        });
        this._bufferBG_A = mk(b.particlesA, 'AtmoBankRender-BufBG-A');
        this._bufferBG_B = mk(b.particlesB, 'AtmoBankRender-BufBG-B');
    }

    setNoiseTextures(baseView, detailView) {
        if (baseView !== this._noiseBaseView || detailView !== this._noiseDetailView) {
            this._noiseBaseView = baseView;
            this._noiseDetailView = detailView;
            this._textureBGDirty = true;
        }
    }

    setDepthTexture(depthView) {
        if (depthView !== this._depthView) {
            this._depthView = depthView;
            this._textureBGDirty = true;
        }
    }

    _rebuildTextureBG() {
        if (!this._noiseBaseView || !this._noiseDetailView || !this._depthView || !this._noiseSampler) return false;
        this._textureBG = this.device.createBindGroup({
            label: 'AtmoBankRender-TexBG',
            layout: this._textureBGL,
            entries: [
                { binding: 0, resource: this._noiseBaseView },
                { binding: 1, resource: this._noiseDetailView },
                { binding: 2, resource: this._noiseSampler },
                { binding: 3, resource: this._depthView },
            ],
        });
        this._textureBGDirty = false;
        return true;
    }

    render(renderPassEncoder, readBuffer) {
        if (this._textureBGDirty) {
            if (!this._rebuildTextureBG()) return;
        }
        if (!this._textureBG) return;

        const bufBG = (readBuffer === this.buffers.particlesA) ? this._bufferBG_A : this._bufferBG_B;

        renderPassEncoder.setPipeline(this.pipeline);
        renderPassEncoder.setBindGroup(0, bufBG);
        renderPassEncoder.setBindGroup(1, this._textureBG);
        renderPassEncoder.drawIndirect(this.buffers.indirect, 0);
    }

    dispose() {
        this.pipeline = null;
        this._bufferBGL = null;
        this._textureBGL = null;
        this._bufferBG_A = null;
        this._bufferBG_B = null;
        this._textureBG = null;
    }
}
