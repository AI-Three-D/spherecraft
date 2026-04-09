// core/renderer/postprocessing/DistortionPass.js
//
// Screen-space distortion that warps the HDR scene image using a
// 2-channel distortion map. The distortion map is populated by
// HeatHazeEmitter (or any future distortion source) before this pass runs.
//
// Because we need to read the scene texture and write a warped version,
// we use a ping-pong approach: read from HDR-A, write warped result to
// HDR-B, then the pipeline swaps the active texture.

import { HDR_FORMAT } from './PostProcessingPipeline.js';
import { buildDistortionWGSL } from './shaders/distortion.wgsl.js';

export class DistortionPass {
    constructor(device, { width, height }) {
        this.device = device;
        this.width = width;
        this.height = height;

        this.strength = 0.2;
        this.enabled = true;
        this._hasActiveSources = false;

        // Distortion map (rg16float, same res as scene).
        this.distortionTexture = null;
        this.distortionTextureView = null;

        // Scratch texture for ping-pong.
        this._scratchTexture = null;
        this._scratchTextureView = null;

        this._pipeline = null;
        this._bindGroupLayout = null;
        this._sampler = null;
        this._paramsBuffer = null;
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

        this._paramsBuffer = device.createBuffer({
            label: 'Distortion-Params',
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this._bindGroupLayout = device.createBindGroupLayout({
            label: 'Distortion-BGL',
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
                { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            ],
        });

        const module = device.createShaderModule({
            label: 'Distortion-Shader',
            code: buildDistortionWGSL(),
        });

        this._pipeline = device.createRenderPipeline({
            label: 'Distortion-Pipeline',
            layout: device.createPipelineLayout({ bindGroupLayouts: [this._bindGroupLayout] }),
            vertex: { module, entryPoint: 'vs_fullscreen' },
            fragment: {
                module,
                entryPoint: 'fs_distortion',
                targets: [{ format: HDR_FORMAT }],
            },
            primitive: { topology: 'triangle-list' },
        });

        this._createTextures();
        this._initialized = true;
    }

    _createTextures() {
        this._destroyTextures();

        this.distortionTexture = this.device.createTexture({
            label: 'Distortion-Map',
            size: [this.width, this.height],
            format: 'rg16float',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        this.distortionTextureView = this.distortionTexture.createView();

        this._scratchTexture = this.device.createTexture({
            label: 'Distortion-Scratch',
            size: [this.width, this.height],
            format: HDR_FORMAT,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
        });
        this._scratchTextureView = this._scratchTexture.createView();
    }

    _destroyTextures() {
        this.distortionTexture?.destroy();
        this._scratchTexture?.destroy();
        this.distortionTexture = null;
        this.distortionTextureView = null;
        this._scratchTexture = null;
        this._scratchTextureView = null;
    }

    handleResize(width, height) {
        this.width = width;
        this.height = height;
        this._createTextures();
    }

    // Clears the distortion map before sources render into it.
    clearDistortionMap(commandEncoder) {
        if (!this._initialized) return;
        const pass = commandEncoder.beginRenderPass({
            colorAttachments: [{
                view: this.distortionTextureView,
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
            }],
        });
        pass.end();
    }

    // Applies distortion to the HDR scene.
    // `hdrTexture` is the GPUTexture object, `hdrView` is its GPUTextureView.
    render(commandEncoder, hdrTexture, hdrView, sceneWidth, sceneHeight) {
        if (!this._initialized || !this.enabled || !this._hasActiveSources) return;

        const params = new Float32Array([this.strength, 0, 0, 0]);
        this.device.queue.writeBuffer(this._paramsBuffer, 0, params);

        const bg = this.device.createBindGroup({
            layout: this._bindGroupLayout,
            entries: [
                { binding: 0, resource: hdrView },
                { binding: 1, resource: this.distortionTextureView },
                { binding: 2, resource: this._sampler },
                { binding: 3, resource: { buffer: this._paramsBuffer } },
            ],
        });

        // Render warped scene into scratch texture.
        const pass = commandEncoder.beginRenderPass({
            colorAttachments: [{
                view: this._scratchTextureView,
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
            }],
        });
        pass.setViewport(0, 0, sceneWidth, sceneHeight, 0, 1);
        pass.setPipeline(this._pipeline);
        pass.setBindGroup(0, bg);
        pass.draw(3);
        pass.end();

        // Copy scratch back to HDR texture.
        commandEncoder.copyTextureToTexture(
            { texture: this._scratchTexture },
            { texture: hdrTexture },
            [sceneWidth, sceneHeight]
        );
    }

    // Mark whether any distortion sources were rendered this frame.
    set hasActiveSources(v) { this._hasActiveSources = !!v; }

    // Returns the bind group layout for the distortion map render target,
    // so HeatHazeEmitter can render into it.
    getDistortionMapView() {
        return this.distortionTextureView;
    }

    getDistortionMapSize() {
        return [this.width, this.height];
    }

    dispose() {
        this._destroyTextures();
        this._paramsBuffer?.destroy();
        this._pipeline = null;
        this._bindGroupLayout = null;
        this._initialized = false;
    }
}
