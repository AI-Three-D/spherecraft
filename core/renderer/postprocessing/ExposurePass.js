// core/renderer/postprocessing/ExposurePass.js
//
// GPU-side auto exposure. Builds a log-luminance mip chain from the HDR scene
// and adapts toward a target exposure value in a persistent 1x1 texture.

import { HDR_FORMAT } from './PostProcessingPipeline.js';
import { buildExposureDownsampleWGSL } from './shaders/exposureDownsample.wgsl.js';
import { buildExposureAdaptWGSL } from './shaders/exposureAdapt.wgsl.js';

export class ExposurePass {
    constructor(device, { width, height }) {
        this.device = device;
        this.width = width;
        this.height = height;

        this.enabled = true;
        this.exposureCompensation = 0.75;
        this.minExposure = 0.1;
        this.maxExposure = 16.0;
        this.middleGray = 0.22;
        this.speedUp = 3.5;
        this.speedDown = 5.0;

        this._sampler = null;
        this._downsampleParamsBuffer = null;
        this._adaptParamsBuffer = null;
        this._downsampleBindGroupLayout = null;
        this._adaptBindGroupLayout = null;
        this._downsamplePipeline = null;
        this._adaptPipeline = null;
        this._mipTextures = [];
        this._mipViews = [];
        this._mipSizes = [];
        this._exposureTextures = [];
        this._exposureViews = [];
        this._readExposureIndex = 0;
        this._writeExposureIndex = 1;
        this._historyValid = false;
        this._initialized = false;
    }

    initialize() {
        const device = this.device;

        this._sampler = device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
        });

        this._downsampleParamsBuffer = device.createBuffer({
            label: 'Exposure-Downsample-Params',
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this._adaptParamsBuffer = device.createBuffer({
            label: 'Exposure-Adapt-Params',
            size: 32,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this._createPipelines();
        this._createMipChain();
        this._createExposureTextures();
        this._initialized = true;
    }

    _createPipelines() {
        const device = this.device;

        this._downsampleBindGroupLayout = device.createBindGroupLayout({
            label: 'Exposure-Downsample-BGL',
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            ],
        });

        this._adaptBindGroupLayout = device.createBindGroupLayout({
            label: 'Exposure-Adapt-BGL',
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
                { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            ],
        });

        const downsampleModule = device.createShaderModule({
            label: 'Exposure-Downsample-Shader',
            code: buildExposureDownsampleWGSL(),
        });
        const adaptModule = device.createShaderModule({
            label: 'Exposure-Adapt-Shader',
            code: buildExposureAdaptWGSL(),
        });

        this._downsamplePipeline = device.createRenderPipeline({
            label: 'Exposure-Downsample-Pipeline',
            layout: device.createPipelineLayout({ bindGroupLayouts: [this._downsampleBindGroupLayout] }),
            vertex: { module: downsampleModule, entryPoint: 'vs_fullscreen' },
            fragment: {
                module: downsampleModule,
                entryPoint: 'fs_downsample',
                targets: [{ format: HDR_FORMAT }],
            },
            primitive: { topology: 'triangle-list' },
        });

        this._adaptPipeline = device.createRenderPipeline({
            label: 'Exposure-Adapt-Pipeline',
            layout: device.createPipelineLayout({ bindGroupLayouts: [this._adaptBindGroupLayout] }),
            vertex: { module: adaptModule, entryPoint: 'vs_fullscreen' },
            fragment: {
                module: adaptModule,
                entryPoint: 'fs_adapt',
                targets: [{ format: HDR_FORMAT }],
            },
            primitive: { topology: 'triangle-list' },
        });
    }

    _createMipChain() {
        this._destroyMipChain();

        let w = Math.max(1, Math.floor(this.width / 2));
        let h = Math.max(1, Math.floor(this.height / 2));

        while (true) {
            const tex = this.device.createTexture({
                label: `Exposure-Mip-${this._mipTextures.length}`,
                size: [w, h],
                format: HDR_FORMAT,
                usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
            });
            this._mipTextures.push(tex);
            this._mipViews.push(tex.createView());
            this._mipSizes.push([w, h]);
            if (w === 1 && h === 1) break;
            w = Math.max(1, Math.floor(w / 2));
            h = Math.max(1, Math.floor(h / 2));
        }
    }

    _createExposureTextures() {
        this._destroyExposureTextures();
        for (let i = 0; i < 2; i++) {
            const tex = this.device.createTexture({
                label: `Exposure-Adapted-${i}`,
                size: [1, 1],
                format: HDR_FORMAT,
                usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
            });
            this._exposureTextures.push(tex);
            this._exposureViews.push(tex.createView());
        }
        this._readExposureIndex = 0;
        this._writeExposureIndex = 1;
        this._historyValid = false;
    }

    _destroyMipChain() {
        for (const tex of this._mipTextures) tex.destroy();
        this._mipTextures = [];
        this._mipViews = [];
        this._mipSizes = [];
    }

    _destroyExposureTextures() {
        for (const tex of this._exposureTextures) tex.destroy();
        this._exposureTextures = [];
        this._exposureViews = [];
    }

    handleResize(width, height) {
        this.width = width;
        this.height = height;
        this._createMipChain();
        this._createExposureTextures();
    }

    render(commandEncoder, hdrView, sceneWidth, sceneHeight, deltaTime) {
        if (!this._initialized || !this.enabled || this._mipTextures.length === 0) return;

        const mipCount = this._mipTextures.length;

        for (let i = 0; i < mipCount; i++) {
            const srcView = (i === 0) ? hdrView : this._mipViews[i - 1];
            const srcW = (i === 0) ? sceneWidth : this._mipSizes[i - 1][0];
            const srcH = (i === 0) ? sceneHeight : this._mipSizes[i - 1][1];
            const dstView = this._mipViews[i];
            const [dstW, dstH] = this._mipSizes[i];

            const paramsData = new ArrayBuffer(16);
            const f32 = new Float32Array(paramsData);
            const u32 = new Uint32Array(paramsData);
            f32[0] = 1.0 / srcW;
            f32[1] = 1.0 / srcH;
            u32[2] = (i === 0) ? 1 : 0;
            this.device.queue.writeBuffer(this._downsampleParamsBuffer, 0, paramsData);

            const bindGroup = this.device.createBindGroup({
                layout: this._downsampleBindGroupLayout,
                entries: [
                    { binding: 0, resource: srcView },
                    { binding: 1, resource: this._sampler },
                    { binding: 2, resource: { buffer: this._downsampleParamsBuffer } },
                ],
            });

            const pass = commandEncoder.beginRenderPass({
                colorAttachments: [{
                    view: dstView,
                    loadOp: 'clear',
                    storeOp: 'store',
                    clearValue: { r: 0, g: 0, b: 0, a: 1 },
                }],
            });
            pass.setViewport(0, 0, dstW, dstH, 0, 1);
            pass.setPipeline(this._downsamplePipeline);
            pass.setBindGroup(0, bindGroup);
            pass.draw(3);
            pass.end();
        }

        const adaptParams = new Float32Array([
            Math.max(0, deltaTime || 0),
            this.middleGray,
            this.minExposure,
            this.maxExposure,
            this.exposureCompensation,
            this.speedUp,
            this.speedDown,
            this._historyValid ? 0.0 : 1.0,
        ]);
        this.device.queue.writeBuffer(this._adaptParamsBuffer, 0, adaptParams);

        const adaptBindGroup = this.device.createBindGroup({
            layout: this._adaptBindGroupLayout,
            entries: [
                { binding: 0, resource: this._mipViews[mipCount - 1] },
                { binding: 1, resource: this._exposureViews[this._readExposureIndex] },
                { binding: 2, resource: this._sampler },
                { binding: 3, resource: { buffer: this._adaptParamsBuffer } },
            ],
        });

        const pass = commandEncoder.beginRenderPass({
            colorAttachments: [{
                view: this._exposureViews[this._writeExposureIndex],
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: { r: 1, g: 1, b: 1, a: 1 },
            }],
        });
        pass.setViewport(0, 0, 1, 1, 0, 1);
        pass.setPipeline(this._adaptPipeline);
        pass.setBindGroup(0, adaptBindGroup);
        pass.draw(3);
        pass.end();

        this._historyValid = true;
        const prevRead = this._readExposureIndex;
        this._readExposureIndex = this._writeExposureIndex;
        this._writeExposureIndex = prevRead;
    }

    getExposureTextureView() {
        return this._exposureViews[this._readExposureIndex] ?? null;
    }

    dispose() {
        this._destroyMipChain();
        this._destroyExposureTextures();
        this._downsampleParamsBuffer?.destroy();
        this._adaptParamsBuffer?.destroy();
        this._downsamplePipeline = null;
        this._adaptPipeline = null;
        this._downsampleBindGroupLayout = null;
        this._adaptBindGroupLayout = null;
        this._sampler = null;
        this._initialized = false;
    }
}
