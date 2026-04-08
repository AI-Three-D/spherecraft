// core/renderer/postprocessing/BloomPass.js
//
// Physically-motivated bloom: threshold extraction, progressive downsample,
// progressive upsample, and additive composite back into the HDR buffer.
//
// Uses separate render passes for each mip level so we can read one mip
// and write to another without read-write hazards.

import { HDR_FORMAT } from './PostProcessingPipeline.js';
import { buildBloomDownsampleWGSL } from './shaders/bloomDownsample.wgsl.js';
import { buildBloomUpsampleWGSL } from './shaders/bloomUpsample.wgsl.js';
import { buildBloomCompositeWGSL } from './shaders/bloomComposite.wgsl.js';

const MAX_MIP_LEVELS = 4;

export class BloomPass {
    constructor(device, { width, height }) {
        this.device = device;
        this.width = width;
        this.height = height;

        // Tunable parameters.
        this.threshold = 2.2;
        this.knee = 0.25;
        this.intensity = 0.06;
        this.blendFactor = 0.35;

        // GPU resources.
        this._mipTextures = [];      // One texture per mip, each with a single view.
        this._mipViews = [];
        this._mipSizes = [];
        this._downsamplePipeline = null;
        this._upsamplePipeline = null;
        this._compositePipeline = null;
        this._sampler = null;
        this._downsampleBindGroupLayout = null;
        this._upsampleBindGroupLayout = null;
        this._compositeBindGroupLayout = null;
        this._downsampleParamsBuffer = null;
        this._upsampleParamsBuffer = null;
        this._compositeParamsBuffer = null;
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

        // Downsample params: texelSize(2f), threshold(f), knee(f), isFirstPass(u32), pad(3u32) = 32 bytes
        this._downsampleParamsBuffer = device.createBuffer({
            label: 'Bloom-Downsample-Params',
            size: 32,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        // Upsample params: texelSize(2f), blendFactor(f), pad(f) = 16 bytes
        this._upsampleParamsBuffer = device.createBuffer({
            label: 'Bloom-Upsample-Params',
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        // Composite params: intensity(f), pad(3f) = 16 bytes
        this._compositeParamsBuffer = device.createBuffer({
            label: 'Bloom-Composite-Params',
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this._createPipelines();
        this._createMipChain();
        this._initialized = true;
    }

    _createPipelines() {
        const device = this.device;

        // --- Downsample pipeline ---
        this._downsampleBindGroupLayout = device.createBindGroupLayout({
            label: 'Bloom-Downsample-BGL',
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            ],
        });

        const dsModule = device.createShaderModule({
            label: 'Bloom-Downsample-Shader',
            code: buildBloomDownsampleWGSL(),
        });

        this._downsamplePipeline = device.createRenderPipeline({
            label: 'Bloom-Downsample-Pipeline',
            layout: device.createPipelineLayout({ bindGroupLayouts: [this._downsampleBindGroupLayout] }),
            vertex: { module: dsModule, entryPoint: 'vs_fullscreen' },
            fragment: {
                module: dsModule,
                entryPoint: 'fs_downsample',
                targets: [{ format: HDR_FORMAT }],
            },
            primitive: { topology: 'triangle-list' },
        });

        // --- Upsample pipeline (additive blend into the target) ---
        this._upsampleBindGroupLayout = device.createBindGroupLayout({
            label: 'Bloom-Upsample-BGL',
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            ],
        });

        const usModule = device.createShaderModule({
            label: 'Bloom-Upsample-Shader',
            code: buildBloomUpsampleWGSL(),
        });

        this._upsamplePipeline = device.createRenderPipeline({
            label: 'Bloom-Upsample-Pipeline',
            layout: device.createPipelineLayout({ bindGroupLayouts: [this._upsampleBindGroupLayout] }),
            vertex: { module: usModule, entryPoint: 'vs_fullscreen' },
            fragment: {
                module: usModule,
                entryPoint: 'fs_upsample',
                targets: [{
                    format: HDR_FORMAT,
                    blend: {
                        color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
                        alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
                    },
                }],
            },
            primitive: { topology: 'triangle-list' },
        });

        // --- Composite pipeline ---
        this._compositeBindGroupLayout = device.createBindGroupLayout({
            label: 'Bloom-Composite-BGL',
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
                { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            ],
        });

        const compModule = device.createShaderModule({
            label: 'Bloom-Composite-Shader',
            code: buildBloomCompositeWGSL(),
        });

        this._compositePipeline = device.createRenderPipeline({
            label: 'Bloom-Composite-Pipeline',
            layout: device.createPipelineLayout({ bindGroupLayouts: [this._compositeBindGroupLayout] }),
            vertex: { module: compModule, entryPoint: 'vs_fullscreen' },
            fragment: {
                module: compModule,
                entryPoint: 'fs_composite',
                targets: [{ format: HDR_FORMAT }],
            },
            primitive: { topology: 'triangle-list' },
        });
    }

    _createMipChain() {
        this._destroyMipChain();

        let w = Math.max(1, Math.floor(this.width / 2));
        let h = Math.max(1, Math.floor(this.height / 2));

        for (let i = 0; i < MAX_MIP_LEVELS; i++) {
            if (w < 2 && h < 2) break;

            const tex = this.device.createTexture({
                label: `Bloom-Mip-${i}`,
                size: [w, h],
                format: HDR_FORMAT,
                usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
            });
            this._mipTextures.push(tex);
            this._mipViews.push(tex.createView());
            this._mipSizes.push([w, h]);

            w = Math.max(1, Math.floor(w / 2));
            h = Math.max(1, Math.floor(h / 2));
        }
    }

    _destroyMipChain() {
        for (const tex of this._mipTextures) tex.destroy();
        this._mipTextures = [];
        this._mipViews = [];
        this._mipSizes = [];
    }

    handleResize(width, height) {
        this.width = width;
        this.height = height;
        this._createMipChain();
    }

    // Runs the full bloom pass chain. `hdrView` is the HDR scene texture view.
    // This method creates its own render passes via the command encoder.
    // After this call, `hdrView`'s texture contents are modified (bloom composited in).
    render(commandEncoder, hdrView, sceneWidth, sceneHeight) {
        if (!this._initialized || this._mipTextures.length === 0) return;

        const mipCount = this._mipTextures.length;

        // --- Downsample chain ---
        for (let i = 0; i < mipCount; i++) {
            const srcView = (i === 0) ? hdrView : this._mipViews[i - 1];
            const srcW = (i === 0) ? sceneWidth : this._mipSizes[i - 1][0];
            const srcH = (i === 0) ? sceneHeight : this._mipSizes[i - 1][1];
            const dstView = this._mipViews[i];
            const [dstW, dstH] = this._mipSizes[i];

            // Upload downsample params.
            const dsData = new ArrayBuffer(32);
            const dsF32 = new Float32Array(dsData);
            const dsU32 = new Uint32Array(dsData);
            dsF32[0] = 1.0 / srcW;
            dsF32[1] = 1.0 / srcH;
            dsF32[2] = this.threshold;
            dsF32[3] = this.knee;
            dsU32[4] = (i === 0) ? 1 : 0;  // isFirstPass
            this.device.queue.writeBuffer(this._downsampleParamsBuffer, 0, dsData);

            const bg = this.device.createBindGroup({
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
            pass.setBindGroup(0, bg);
            pass.draw(3);
            pass.end();
        }

        // --- Upsample chain (from smallest mip back up) ---
        // Each pass blends the upsampled lower mip into the next higher mip
        // using additive blending.
        for (let i = mipCount - 2; i >= 0; i--) {
            const srcView = this._mipViews[i + 1];
            const srcW = this._mipSizes[i + 1][0];
            const srcH = this._mipSizes[i + 1][1];
            const dstView = this._mipViews[i];
            const [dstW, dstH] = this._mipSizes[i];

            const usData = new Float32Array([1.0 / srcW, 1.0 / srcH, this.blendFactor, 0]);
            this.device.queue.writeBuffer(this._upsampleParamsBuffer, 0, usData);

            const bg = this.device.createBindGroup({
                layout: this._upsampleBindGroupLayout,
                entries: [
                    { binding: 0, resource: srcView },
                    { binding: 1, resource: this._sampler },
                    { binding: 2, resource: { buffer: this._upsampleParamsBuffer } },
                ],
            });

            const pass = commandEncoder.beginRenderPass({
                colorAttachments: [{
                    view: dstView,
                    loadOp: 'load',     // preserve downsample content, blend on top
                    storeOp: 'store',
                }],
            });
            pass.setViewport(0, 0, dstW, dstH, 0, 1);
            pass.setPipeline(this._upsamplePipeline);
            pass.setBindGroup(0, bg);
            pass.draw(3);
            pass.end();
        }

        // --- Composite bloom mip 0 back into the HDR scene ---
        // The additive upsample pipeline reads from bloom mip0 (a separate
        // texture) and blends into the HDR target. No copy needed.
        this._compositeBloomIntoHDR(commandEncoder, hdrView, sceneWidth, sceneHeight);
    }

    // Composites bloom mip0 into the HDR texture using additive blending.
    // This is safe because mip0 is a separate texture from the HDR target.
    _compositeBloomIntoHDR(commandEncoder, hdrView, w, h) {
        const usData = new Float32Array([1.0 / this._mipSizes[0][0], 1.0 / this._mipSizes[0][1], this.intensity, 0]);
        this.device.queue.writeBuffer(this._upsampleParamsBuffer, 0, usData);

        const bg = this.device.createBindGroup({
            layout: this._upsampleBindGroupLayout,
            entries: [
                { binding: 0, resource: this._mipViews[0] },
                { binding: 1, resource: this._sampler },
                { binding: 2, resource: { buffer: this._upsampleParamsBuffer } },
            ],
        });

        const pass = commandEncoder.beginRenderPass({
            colorAttachments: [{
                view: hdrView,
                loadOp: 'load',
                storeOp: 'store',
            }],
        });
        pass.setViewport(0, 0, w, h, 0, 1);
        pass.setPipeline(this._upsamplePipeline);
        pass.setBindGroup(0, bg);
        pass.draw(3);
        pass.end();
    }

    dispose() {
        this._destroyMipChain();
        this._downsampleParamsBuffer?.destroy();
        this._upsampleParamsBuffer?.destroy();
        this._compositeParamsBuffer?.destroy();
        this._downsamplePipeline = null;
        this._upsamplePipeline = null;
        this._compositePipeline = null;
        this._initialized = false;
    }
}
