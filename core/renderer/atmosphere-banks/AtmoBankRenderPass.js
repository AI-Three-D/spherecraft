import { buildAtmoBankRenderWGSL } from './shaders/atmoBankRender.wgsl.js';
import { ATMO_TYPE_CAPACITY, ATMO_VOLUME_SLICE_COUNT } from './AtmoBankTypes.js';
import { fullscreenQuadVertexWGSL } from '../postprocessing/shaders/fullscreenQuad.wgsl.js';

const RENDER_PARAMS_SIZE = 16;

function resolveOffscreenConfig(renderConfig = {}) {
    const offscreen = renderConfig?.offscreen ?? {};
    return {
        enabled: offscreen.enabled !== false,
        resolutionScale: Math.max(
            0.25,
            Math.min(1.0, Number.isFinite(offscreen.resolutionScale) ? offscreen.resolutionScale : 0.5)
        ),
    };
}

function buildAtmoBankCompositeWGSL() {
    return /* wgsl */`
${fullscreenQuadVertexWGSL}

@group(0) @binding(0) var atmoTexture: texture_2d<f32>;
@group(0) @binding(1) var atmoSampler: sampler;

@fragment
fn fs_composite(in: FullscreenVsOut) -> @location(0) vec4<f32> {
    let color = textureSample(atmoTexture, atmoSampler, in.uv);
    if (color.a < 0.001) { discard; }
    return color;
}
`;
}

export class AtmoBankRenderPass {
    constructor(device, buffers, { colorFormat, depthFormat = 'depth24plus', renderConfig = {} }) {
        this.device = device;
        this.buffers = buffers;
        this.colorFormat = colorFormat;
        this.depthFormat = depthFormat;
        this.offscreenConfig = resolveOffscreenConfig(renderConfig);

        this.pipeline = null;
        this.offscreenPipeline = null;
        this.compositePipeline = null;
        this._bufferBGL = null;
        this._textureBGL = null;
        this._compositeBGL = null;
        this._bufferBG_A = null;
        this._bufferBG_B = null;
        this._textureBG = null;
        this._compositeBG = null;

        this._renderParamsUBO = null;
        this._renderParamsData = new Float32Array(4);
        this._noiseBaseView = null;
        this._noiseDetailView = null;
        this._depthView = null;
        this._noiseSampler = null;
        this._compositeSampler = null;
        this._textureBGDirty = true;
        this._compositeBGDirty = true;

        this._offscreenTexture = null;
        this._offscreenView = null;
        this._offscreenWidth = 0;
        this._offscreenHeight = 0;
        this._lastRenderInfo = {
            rendered: false,
            reason: 'not-initialized',
        };
    }

    initialize() {
        const device = this.device;

        this._renderParamsUBO = device.createBuffer({
            label: 'AtmoBankRenderParams',
            size: RENDER_PARAMS_SIZE,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this._bufferBGL = device.createBindGroupLayout({
            label: 'AtmoBankRender-BufferBGL',
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
                { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
                { binding: 3, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
                { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
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

        const src = buildAtmoBankRenderWGSL({
            typeCapacity: ATMO_TYPE_CAPACITY,
            sliceCount: ATMO_VOLUME_SLICE_COUNT,
        });
        const module = device.createShaderModule({ label: 'AtmoBankRender-Shader', code: src });

        this.pipeline = this._createParticlePipeline(module, {
            label: 'AtmoBankRender-Pipeline',
            depthStencil: {
                format: this.depthFormat,
                depthWriteEnabled: false,
                depthCompare: 'less',
            },
        });

        this.offscreenPipeline = this._createParticlePipeline(module, {
            label: 'AtmoBankRender-OffscreenPipeline',
            depthStencil: null,
        });

        this._initializeCompositePipeline();

        this._noiseSampler = device.createSampler({
            label: 'AtmoBankNoiseSampler',
            magFilter: 'linear',
            minFilter: 'linear',
            mipmapFilter: 'linear',
            addressModeU: 'repeat',
            addressModeV: 'repeat',
            addressModeW: 'repeat',
        });
        this._compositeSampler = device.createSampler({
            label: 'AtmoBankCompositeSampler',
            magFilter: 'linear',
            minFilter: 'linear',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
        });

        this._rebuildBufferBindGroups();
    }

    _createParticlePipeline(module, { label, depthStencil }) {
        const descriptor = {
            label,
            layout: this.device.createPipelineLayout({
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
        };
        if (depthStencil) {
            descriptor.depthStencil = depthStencil;
        }
        return this.device.createRenderPipeline(descriptor);
    }

    _initializeCompositePipeline() {
        this._compositeBGL = this.device.createBindGroupLayout({
            label: 'AtmoBankComposite-BGL',
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
            ],
        });

        const module = this.device.createShaderModule({
            label: 'AtmoBankComposite-Shader',
            code: buildAtmoBankCompositeWGSL(),
        });
        this.compositePipeline = this.device.createRenderPipeline({
            label: 'AtmoBankComposite-Pipeline',
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [this._compositeBGL] }),
            vertex: { module, entryPoint: 'vs_fullscreen' },
            fragment: {
                module,
                entryPoint: 'fs_composite',
                targets: [{
                    format: this.colorFormat,
                    blend: {
                        color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                    },
                    writeMask: GPUColorWrite.ALL,
                }],
            },
            primitive: { topology: 'triangle-list' },
        });
    }

    _rebuildBufferBindGroups() {
        const b = this.buffers;
        const mk = (particleBuf, label) => this.device.createBindGroup({
            label,
            layout: this._bufferBGL,
            entries: [
                { binding: 0, resource: { buffer: b.globalsUBO } },
                { binding: 1, resource: { buffer: particleBuf } },
                { binding: 2, resource: { buffer: b.liveList } },
                { binding: 3, resource: { buffer: b.typeDefUBO } },
                { binding: 4, resource: { buffer: this._renderParamsUBO } },
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

    getDiagnostics() {
        return {
            hasPipeline: !!this.pipeline,
            hasOffscreenPipeline: !!this.offscreenPipeline,
            hasCompositePipeline: !!this.compositePipeline,
            hasBufferBG: !!this._bufferBG_A && !!this._bufferBG_B,
            hasTextureBG: !!this._textureBG,
            textureBGDirty: this._textureBGDirty,
            hasNoiseBase: !!this._noiseBaseView,
            hasNoiseDetail: !!this._noiseDetailView,
            hasDepth: !!this._depthView,
            offscreen: {
                enabled: this.offscreenConfig.enabled,
                resolutionScale: this.offscreenConfig.resolutionScale,
                hasTexture: !!this._offscreenTexture,
                width: this._offscreenWidth,
                height: this._offscreenHeight,
            },
            lastRender: this._lastRenderInfo,
        };
    }

    _writeRenderParams(targetWidth, targetHeight, sceneWidth = targetWidth, sceneHeight = targetHeight) {
        const w = Math.max(1, Number.isFinite(targetWidth) ? targetWidth : 1);
        const h = Math.max(1, Number.isFinite(targetHeight) ? targetHeight : 1);
        const sw = Math.max(1, Number.isFinite(sceneWidth) ? sceneWidth : w);
        const sh = Math.max(1, Number.isFinite(sceneHeight) ? sceneHeight : h);
        this._renderParamsData[0] = w;
        this._renderParamsData[1] = h;
        this._renderParamsData[2] = sw;
        this._renderParamsData[3] = sh;
        this.device.queue.writeBuffer(this._renderParamsUBO, 0, this._renderParamsData);
    }

    _rebuildTextureBG() {
        if (!this._noiseBaseView || !this._noiseDetailView || !this._depthView || !this._noiseSampler) {
            this._lastRenderInfo = {
                rendered: false,
                reason: 'missing-render-resource',
                hasNoiseBase: !!this._noiseBaseView,
                hasNoiseDetail: !!this._noiseDetailView,
                hasDepth: !!this._depthView,
                hasSampler: !!this._noiseSampler,
            };
            return false;
        }
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

    _ensureOffscreenTarget(sceneWidth, sceneHeight) {
        const scale = this.offscreenConfig.resolutionScale;
        const width = Math.max(1, Math.ceil(sceneWidth * scale));
        const height = Math.max(1, Math.ceil(sceneHeight * scale));
        if (this._offscreenTexture && this._offscreenWidth === width && this._offscreenHeight === height) {
            return true;
        }

        this._destroyOffscreenTarget();
        this._offscreenTexture = this.device.createTexture({
            label: 'AtmoBank-Offscreen-Color',
            size: [width, height],
            format: this.colorFormat,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        this._offscreenView = this._offscreenTexture.createView();
        this._offscreenWidth = width;
        this._offscreenHeight = height;
        this._compositeBGDirty = true;
        return true;
    }

    _destroyOffscreenTarget() {
        this._offscreenTexture?.destroy();
        this._offscreenTexture = null;
        this._offscreenView = null;
        this._offscreenWidth = 0;
        this._offscreenHeight = 0;
        this._compositeBG = null;
        this._compositeBGDirty = true;
    }

    _ensureCompositeBG() {
        if (!this._offscreenView || !this._compositeSampler) return false;
        if (!this._compositeBGDirty && this._compositeBG) return true;
        this._compositeBG = this.device.createBindGroup({
            label: 'AtmoBankComposite-BG',
            layout: this._compositeBGL,
            entries: [
                { binding: 0, resource: this._offscreenView },
                { binding: 1, resource: this._compositeSampler },
            ],
        });
        this._compositeBGDirty = false;
        return true;
    }

    _drawParticles(renderPassEncoder, readBuffer, pipeline) {
        const bufBG = (readBuffer === this.buffers.particlesA) ? this._bufferBG_A : this._bufferBG_B;
        renderPassEncoder.setPipeline(pipeline);
        renderPassEncoder.setBindGroup(0, bufBG);
        renderPassEncoder.setBindGroup(1, this._textureBG);
        renderPassEncoder.drawIndirect(this.buffers.indirect, 0);
    }

    _canRenderParticles() {
        if (this._textureBGDirty) {
            if (!this._rebuildTextureBG()) return false;
        }
        if (!this._textureBG) {
            this._lastRenderInfo = {
                rendered: false,
                reason: 'missing-texture-bind-group',
            };
            return false;
        }
        return true;
    }

    render(renderPassEncoder, readBuffer, options = {}) {
        if (!this._canRenderParticles()) return;
        const targetWidth = options.targetWidth ?? options.sceneWidth ?? 1;
        const targetHeight = options.targetHeight ?? options.sceneHeight ?? 1;
        const sceneWidth = options.sceneWidth ?? targetWidth;
        const sceneHeight = options.sceneHeight ?? targetHeight;
        this._writeRenderParams(targetWidth, targetHeight, sceneWidth, sceneHeight);
        this._drawParticles(renderPassEncoder, readBuffer, this.pipeline);
        this._lastRenderInfo = {
            rendered: true,
            mode: 'full-resolution',
            reason: 'draw-indirect-submitted',
            readBuffer: readBuffer?.label || null,
            targetWidth,
            targetHeight,
        };
    }

    renderOffscreen(commandEncoder, readBuffer, {
        sceneColorView,
        sceneDepthView,
        sceneWidth,
        sceneHeight,
    } = {}) {
        const width = Math.floor(sceneWidth ?? 0);
        const height = Math.floor(sceneHeight ?? 0);
        if (
            !this.offscreenConfig.enabled ||
            this.offscreenConfig.resolutionScale >= 0.999 ||
            !commandEncoder ||
            !sceneColorView ||
            !sceneDepthView ||
            width <= 0 ||
            height <= 0 ||
            !this.offscreenPipeline ||
            !this.compositePipeline
        ) {
            return false;
        }

        this.setDepthTexture(sceneDepthView);
        if (!this._canRenderParticles()) return false;
        if (!this._ensureOffscreenTarget(width, height)) return false;
        if (!this._ensureCompositeBG()) return false;

        this._writeRenderParams(this._offscreenWidth, this._offscreenHeight, width, height);

        const particlePass = commandEncoder.beginRenderPass({
            label: 'AtmoBank-Offscreen',
            colorAttachments: [{
                view: this._offscreenView,
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
                loadOp: 'clear',
                storeOp: 'store',
            }],
        });
        particlePass.setViewport(0, 0, this._offscreenWidth, this._offscreenHeight, 0, 1);
        this._drawParticles(particlePass, readBuffer, this.offscreenPipeline);
        particlePass.end();

        const compositePass = commandEncoder.beginRenderPass({
            label: 'AtmoBank-Composite',
            colorAttachments: [{
                view: sceneColorView,
                loadOp: 'load',
                storeOp: 'store',
            }],
        });
        compositePass.setViewport(0, 0, width, height, 0, 1);
        compositePass.setPipeline(this.compositePipeline);
        compositePass.setBindGroup(0, this._compositeBG);
        compositePass.draw(3);
        compositePass.end();

        this._lastRenderInfo = {
            rendered: true,
            mode: 'offscreen',
            reason: 'draw-indirect-composited',
            readBuffer: readBuffer?.label || null,
            sceneWidth: width,
            sceneHeight: height,
            targetWidth: this._offscreenWidth,
            targetHeight: this._offscreenHeight,
            resolutionScale: this.offscreenConfig.resolutionScale,
        };
        return true;
    }

    dispose() {
        this.pipeline = null;
        this.offscreenPipeline = null;
        this.compositePipeline = null;
        this._bufferBGL = null;
        this._textureBGL = null;
        this._compositeBGL = null;
        this._bufferBG_A = null;
        this._bufferBG_B = null;
        this._textureBG = null;
        this._compositeBG = null;
        this._renderParamsUBO?.destroy();
        this._renderParamsUBO = null;
        this._destroyOffscreenTarget();
    }
}
