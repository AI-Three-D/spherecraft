// core/renderer/postprocessing/PostProcessingPipeline.js
//
// Owns the HDR off-screen render target and orchestrates post-processing
// passes (bloom, distortion, tone mapping, etc.).
//
// Usage from frontend.js:
//   1. pipeline.beginScenePass(backend)  — sets HDR render target, clears
//   2. ... render scene ...
//   3. pipeline.execute(backend)         — runs all post-process passes
//                                           and blits to swap chain

import { ToneMappingPass } from './ToneMappingPass.js';
import { BloomPass } from './BloomPass.js';
import { DistortionPass } from './DistortionPass.js';
import { ExposurePass } from './ExposurePass.js';

export const HDR_FORMAT = 'rgba16float';

export class PostProcessingPipeline {
    constructor(device, { width, height, outputFormat }) {
        this.device = device;
        this.width = width;
        this.height = height;
        this.outputFormat = outputFormat;

        // HDR scene color + depth
        this.hdrTexture = null;
        this.hdrTextureView = null;
        this.bloomSourceTexture = null;
        this.bloomSourceTextureView = null;
        this.depthTexture = null;
        this.depthTextureView = null;

        // Passes (populated during initialize)
        this.toneMappingPass = null;
        this.bloomPass = null;
        this.distortionPass = null;
        this.exposurePass = null;

        // Per-frame bind group for tone mapping (recreated when HDR view changes)
        this._tmBindGroup = null;
        this._frameDeltaTime = 1 / 60;
        this._initialized = false;
    }

    initialize() {
        this._createTextures();

        this.toneMappingPass = new ToneMappingPass(this.device, {
            outputFormat: this.outputFormat,
        });
        this.toneMappingPass.initialize();

        this.exposurePass = new ExposurePass(this.device, {
            width: this.width,
            height: this.height,
        });
        this.exposurePass.initialize();
        this.toneMappingPass.autoExposureEnabled = this.exposurePass.enabled;

        this.bloomPass = new BloomPass(this.device, {
            width: this.width,
            height: this.height,
        });
        this.bloomPass.initialize();

        this.distortionPass = new DistortionPass(this.device, {
            width: this.width,
            height: this.height,
        });
        this.distortionPass.initialize();

        this._rebuildBindGroups();
        this._initialized = true;
    }

    // --- Scene pass management ---

    // Sets the HDR render target on the backend and clears it.
    // After this call the backend's render pass encoder writes to our
    // HDR texture + shared depth.
    beginScenePass(backend) {
        if (!this._initialized) return;

        // End any existing render pass so we can switch targets.
        backend._endCurrentRenderPass();
        backend._ensureCommandEncoder();

        const rpDesc = {
            colorAttachments: [{
                view: this.hdrTextureView,
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
                loadOp: 'clear',
                storeOp: 'store',
            }],
            depthStencilAttachment: {
                view: this.depthTextureView,
                depthClearValue: 1.0,
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
            },
        };

        backend._renderPassEncoder = backend._commandEncoder.beginRenderPass(rpDesc);
        backend._renderPassEncoder.setViewport(
            0, 0, this.width, this.height, 0, 1
        );

        // Mark the backend so resumeRenderPass() and setRenderTarget(null)
        // both reattach to our HDR target instead of the swap chain.
        const fakeRT = this._fakeRenderTarget();
        backend._currentRenderTarget = fakeRT;
        backend._defaultRenderTarget = fakeRT;
    }

    // Resumes the HDR render pass (e.g. after a compute interlude).
    // Mirrors backend.resumeRenderPass() but targets our HDR texture.
    resumeScenePass(backend) {
        if (!this._initialized) return;
        if (backend._renderPassEncoder) return;

        backend._ensureCommandEncoder();

        const rpDesc = {
            colorAttachments: [{
                view: this.hdrTextureView,
                loadOp: 'load',
                storeOp: 'store',
            }],
            depthStencilAttachment: {
                view: this.depthTextureView,
                depthClearValue: 1.0,
                depthLoadOp: 'load',
                depthStoreOp: 'store',
            },
        };

        backend._renderPassEncoder = backend._commandEncoder.beginRenderPass(rpDesc);
        backend._renderPassEncoder.setViewport(
            0, 0, this.width, this.height, 0, 1
        );
    }

    // Starts a second pass that captures only authored emissive/bloom inputs.
    // The depth buffer is preserved from the main scene so only visible
    // emissive surfaces and particles contribute.
    beginBloomSourcePass(backend) {
        if (!this._initialized) return;

        backend._endCurrentRenderPass();
        backend._ensureCommandEncoder();

        backend._renderPassEncoder = backend._commandEncoder.beginRenderPass({
            colorAttachments: [{
                view: this.bloomSourceTextureView,
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
                loadOp: 'clear',
                storeOp: 'store',
            }],
            depthStencilAttachment: {
                view: this.depthTextureView,
                depthClearValue: 1.0,
                depthLoadOp: 'load',
                depthStoreOp: 'store',
            },
        });
        backend._renderPassEncoder.setViewport(
            0, 0, this.width, this.height, 0, 1
        );
    }

    // --- Post-process execution ---

    // Ends the scene render pass and runs all post-process passes, finishing
    // with tone mapping into the swap chain.
    execute(backend) {
        if (!this._initialized) return;

        // End the scene render pass (writes to HDR texture are now available).
        backend._endCurrentRenderPass();
        // Clear the default render target so the backend no longer redirects
        // setRenderTarget(null) to our HDR texture.
        backend._defaultRenderTarget = null;
        backend._currentRenderTarget = null;
        backend._ensureCommandEncoder();
        const encoder = backend._commandEncoder;

        // Run bloom (if enabled) — operates on the HDR texture in-place or
        // produces a bloom texture that gets composited. The bloom input is a
        // dedicated authored-emissive source, not the full HDR scene.
        if (this.exposurePass) {
            this.exposurePass.render(
                encoder,
                this.hdrTextureView,
                this.width,
                this.height,
                this._frameDeltaTime
            );
            this._rebuildBindGroups();
        }
        if (this.bloomPass) {
            this.bloomPass.render(
                encoder,
                this.bloomSourceTextureView,
                this.hdrTextureView,
                this.width,
                this.height
            );
        }

        // Run distortion (if enabled) — warps the HDR image. Added in iteration 4.
        if (this.distortionPass) {
            this.distortionPass.render(encoder, this.hdrTexture, this.hdrTextureView, this.width, this.height);
        }

        // Final pass: tone mapping → swap chain.
        const canvasView = backend.context.getCurrentTexture().createView();
        const passEncoder = encoder.beginRenderPass({
            colorAttachments: [{
                view: canvasView,
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
            }],
        });
        passEncoder.setViewport(0, 0, this.width, this.height, 0, 1);

        this.toneMappingPass.render(passEncoder, this._tmBindGroup);

        passEncoder.end();

        // Restore backend state so submitCommands() doesn't try to end a pass.
        backend._renderPassEncoder = null;
        backend._currentRenderTarget = null;
    }

    // --- Resize ---

    handleResize(width, height) {
        if (width === this.width && height === this.height) return;
        this.width = width;
        this.height = height;

        this._destroyTextures();
        this._createTextures();
        this._rebuildBindGroups();

        if (this.bloomPass?.handleResize) {
            this.bloomPass.handleResize(width, height);
        }
        if (this.exposurePass?.handleResize) {
            this.exposurePass.handleResize(width, height);
        }
        if (this.distortionPass?.handleResize) {
            this.distortionPass.handleResize(width, height);
        }
    }

    // --- Accessors ---

    get hdrFormat() { return HDR_FORMAT; }

    get exposure() { return this.toneMappingPass?.exposure ?? 1.0; }
    set exposure(v) { if (this.toneMappingPass) this.toneMappingPass.exposure = v; }
    get autoExposureEnabled() { return this.exposurePass?.enabled ?? false; }
    set autoExposureEnabled(v) {
        if (this.exposurePass) this.exposurePass.enabled = !!v;
        if (this.toneMappingPass) this.toneMappingPass.autoExposureEnabled = !!v;
    }

    setFrameDeltaTime(dt) {
        this._frameDeltaTime = Number.isFinite(dt) ? Math.max(0, dt) : this._frameDeltaTime;
    }

    // --- Internal ---

    _createTextures() {
        this.hdrTexture = this.device.createTexture({
            label: 'PostProcess-HDR-Color',
            size: [this.width, this.height],
            format: HDR_FORMAT,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        this.hdrTextureView = this.hdrTexture.createView();

        this.bloomSourceTexture = this.device.createTexture({
            label: 'PostProcess-Bloom-Source',
            size: [this.width, this.height],
            format: HDR_FORMAT,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        this.bloomSourceTextureView = this.bloomSourceTexture.createView();

        this.depthTexture = this.device.createTexture({
            label: 'PostProcess-Depth',
            size: [this.width, this.height],
            format: 'depth24plus',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        this.depthTextureView = this.depthTexture.createView();
    }

    _destroyTextures() {
        this.hdrTexture?.destroy();
        this.bloomSourceTexture?.destroy();
        this.depthTexture?.destroy();
        this.hdrTexture = null;
        this.hdrTextureView = null;
        this.bloomSourceTexture = null;
        this.bloomSourceTextureView = null;
        this.depthTexture = null;
        this.depthTextureView = null;
    }

    _rebuildBindGroups() {
        if (!this.toneMappingPass || !this.hdrTextureView) return;
        this._tmBindGroup = this.toneMappingPass.createBindGroup(
            this.hdrTextureView,
            this.exposurePass?.getExposureTextureView?.()
        );
    }

    // Minimal object that satisfies the backend's render-target checks so that
    // resumeRenderPass() re-enters our HDR pass instead of the swap chain.
    _fakeRenderTarget() {
        return {
            _gpuRenderTarget: {
                colorViews: [this.hdrTextureView],
                depthView: this.depthTextureView,
            },
        };
    }

    dispose() {
        this.toneMappingPass?.dispose();
        this.exposurePass?.dispose();
        this.bloomPass?.dispose();
        this.distortionPass?.dispose();
        this._destroyTextures();
        this._initialized = false;
    }
}
