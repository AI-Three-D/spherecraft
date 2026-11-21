// core/renderer/postprocessing/ToneMappingPass.js
//
// Full-screen pass that reads an HDR texture and writes ACES-tonemapped
// sRGB output. Intended as the final pass in the postprocessing chain,
// targeting the swap chain format.

import { buildTonemapWGSL } from './shaders/tonemap.wgsl.js';

export class ToneMappingPass {
    constructor(device, { outputFormat }) {
        this.device = device;
        this.outputFormat = outputFormat;

        this.pipeline = null;
        this.bindGroupLayout = null;
        this.sampler = null;
        this.paramsBuffer = null;

        this._exposure = 0.75;
        this._night = 0;
        this._nightGrade = 0;
        this._nightExposure = 0;
        this._paramsDirty = true;
    }

    get exposure() { return this._exposure; }
    set exposure(v) {
        if (v !== this._exposure) {
            this._exposure = v;
            this._paramsDirty = true;
        }
    }

    /**
     * Night look: amount (0 day .. 1 full night), grade (how far colour moves toward night vision at
     * full night, 0..1) and exposure change at full night (+1 doubles, -0.2 is 20 % darker).
     */
    setNight(amount, grade = 0, exposure = 0) {
        const a = Math.max(0, Math.min(1, amount || 0));
        const g = Math.max(0, Math.min(1, grade || 0));
        const e = Math.max(-0.9, exposure || 0);
        if (a !== this._night || g !== this._nightGrade || e !== this._nightExposure) {
            this._night = a;
            this._nightGrade = g;
            this._nightExposure = e;
            this._paramsDirty = true;
        }
    }

    initialize() {
        const device = this.device;

        this.sampler = device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
        });

        this.paramsBuffer = device.createBuffer({
            label: 'ToneMap-Params',
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this._uploadParams();

        this.bindGroupLayout = device.createBindGroupLayout({
            label: 'ToneMap-BindGroupLayout',
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            ],
        });

        const src = buildTonemapWGSL();
        const module = device.createShaderModule({ label: 'ToneMap-Shader', code: src });

        this.pipeline = device.createRenderPipeline({
            label: 'ToneMap-Pipeline',
            layout: device.createPipelineLayout({
                bindGroupLayouts: [this.bindGroupLayout],
            }),
            vertex: { module, entryPoint: 'vs_fullscreen' },
            fragment: {
                module,
                entryPoint: 'fs_tonemap',
                targets: [{ format: this.outputFormat }],
            },
            primitive: { topology: 'triangle-list' },
        });
    }

    // Call each frame before render(). `hdrTextureView` is the GPUTextureView
    // of the HDR scene color texture.
    createBindGroup(hdrTextureView) {
        return this.device.createBindGroup({
            label: 'ToneMap-BindGroup',
            layout: this.bindGroupLayout,
            entries: [
                { binding: 0, resource: hdrTextureView },
                { binding: 1, resource: this.sampler },
                { binding: 2, resource: { buffer: this.paramsBuffer } },
            ],
        });
    }

    render(passEncoder, bindGroup) {
        if (this._paramsDirty) this._uploadParams();

        passEncoder.setPipeline(this.pipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.draw(3); // full-screen triangle
    }

    _uploadParams() {
        const data = new Float32Array([this._exposure, this._night, this._nightGrade, this._nightExposure]);
        this.device.queue.writeBuffer(this.paramsBuffer, 0, data);
        this._paramsDirty = false;
    }

    dispose() {
        this.paramsBuffer?.destroy();
        this.pipeline = null;
        this.bindGroupLayout = null;
        this.sampler = null;
        this.paramsBuffer = null;
    }
}
