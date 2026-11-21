// core/renderer/clouds/cloudNoiseGenerator.js
// Generates tileable 3D noise textures for cirrus cloud rendering.

import { Vector3 } from '../../../shared/math/index.js';
import { createCloudNoiseComputeShader } from './shaders/cloudNoiseCompute.wgsl.js';
import { DOWNSAMPLE_3D_WGSL } from '../volumetricClouds/shaders/cloudNoise.wgsl.js';

const mipCount = (size) => Math.floor(Math.log2(size)) + 1;

export class CloudNoiseGenerator {
    constructor(backend, options = {}) {
        this.backend = backend;

        this.noiseTextures = { base: null, detail: null, erosion: null };
        this.textureViews  = { base: null, detail: null, erosion: null };
        this.dimensions    = { base: 64,   detail: 96,   erosion: 128 };

        this.uniformBuffers = {};
        this.bindGroups     = {};

        this._initialized    = false;
        this._noiseGenerated = false;
        this._lastSeed       = null;
        this._dispatchList   = [];
    }

    async initialize() {
        if (this._initialized) return;
        const device = this.backend.device;
        if (!device) return;

        for (const [name, size] of Object.entries(this.dimensions)) {
            // Mipmapped: distant cirrus sampled level 0 only aliased into speckles that flickered with
            // every camera move.
            this.noiseTextures[name] = device.createTexture({
                label: `CloudNoise_${name}_${size}`,
                size: [size, size, size],
                dimension: '3d',
                format: 'rgba8unorm',
                mipLevelCount: mipCount(size),
                usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
            });
            this.textureViews[name] = this.noiseTextures[name].createView({ dimension: '3d' });
            this.uniformBuffers[name] = device.createBuffer({
                size: 64,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
            });
        }

        const shaderCode   = createCloudNoiseComputeShader();
        const shaderModule = device.createShaderModule({ code: shaderCode });

        const bindGroupLayout = device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE,
                    storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '3d' } }
            ]
        });

        this.computePipeline = device.createComputePipeline({
            layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
            compute: { module: shaderModule, entryPoint: 'main' }
        });

        this._downsampleLayout = device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float', viewDimension: '3d' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE,
                    storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '3d' } }
            ]
        });
        this._downsamplePipeline = device.createComputePipeline({
            layout: device.createPipelineLayout({ bindGroupLayouts: [this._downsampleLayout] }),
            compute: { module: device.createShaderModule({ code: DOWNSAMPLE_3D_WGSL }), entryPoint: 'main' }
        });
        const mipView = (tex, level) => tex.createView({ dimension: '3d', baseMipLevel: level, mipLevelCount: 1 });
        this._mipSteps = [];
        for (const [name, size] of Object.entries(this.dimensions)) {
            const tex = this.noiseTextures[name];
            for (let level = 1; level < tex.mipLevelCount; level++) {
                this._mipSteps.push({
                    bindGroup: device.createBindGroup({
                        layout: this._downsampleLayout,
                        entries: [
                            { binding: 0, resource: mipView(tex, level - 1) },
                            { binding: 1, resource: mipView(tex, level) }
                        ]
                    }),
                    size: Math.max(1, size >> level)
                });
            }
        }

        for (const name of Object.keys(this.dimensions)) {
            this.bindGroups[name] = device.createBindGroup({
                layout: bindGroupLayout,
                entries: [
                    { binding: 0, resource: { buffer: this.uniformBuffers[name] } },
                    { binding: 1, resource: this.noiseTextures[name].createView({ dimension: '3d', baseMipLevel: 0, mipLevelCount: 1 }) }
                ]
            });
        }

        this._initialized = true;
    }

    getBaseTextureView()    { return this.textureViews.base; }
    getDetailTextureView()  { return this.textureViews.detail; }
    getErosionTextureView() { return this.textureViews.erosion; }
    get needsDispatch() { return this._needsDispatch; }

    update(camera, environmentState, uniformManager, planetConfig) {
        if (!this._initialized) return;
        const seed = planetConfig?.seed || 1337;
        if (!this._noiseGenerated || this._lastSeed !== seed) {
            this._prepareNoiseGeneration(seed);
            this._lastSeed = seed;
        }
    }

    _prepareNoiseGeneration(seed) {
        const device = this.backend.device;
        if (!device) return;

        this._dispatchList = [];
        // noise type: 0 = base (Perlin-Worley), 1 = detail (multi-octave Worley), 2 = erosion (high-freq Worley)
        const noiseTypes = { base: 0, detail: 1, erosion: 2 };

        for (const [name, size] of Object.entries(this.dimensions)) {
            const data = new ArrayBuffer(64);
            const view = new DataView(data);
            view.setUint32(0, size, true);
            view.setUint32(4, size, true);
            view.setUint32(8, size, true);
            view.setInt32(12, seed, true);
            view.setUint32(16, noiseTypes[name], true);
            view.setUint32(20, 1, true); // period > 0 = tileable
            view.setFloat32(32, 0, true);
            view.setFloat32(36, 0, true);
            view.setFloat32(40, 0, true);
            view.setFloat32(48, 1.0, true);
            view.setFloat32(52, 1.0, true);
            device.queue.writeBuffer(this.uniformBuffers[name], 0, data);
            this._dispatchList.push({ bindGroup: this.bindGroups[name], size });
        }
        this._needsDispatch = this._dispatchList.length > 0;
    }

    dispatch(commandEncoder) {
        if (!this._initialized || !this._needsDispatch || this._dispatchList.length === 0) return;

        const computePass = commandEncoder.beginComputePass();
        computePass.setPipeline(this.computePipeline);
        for (const entry of this._dispatchList) {
            computePass.setBindGroup(0, entry.bindGroup);
            const wg = Math.ceil(entry.size / 4);
            computePass.dispatchWorkgroups(wg, wg, wg);
        }
        computePass.setPipeline(this._downsamplePipeline);
        for (const step of this._mipSteps) {
            computePass.setBindGroup(0, step.bindGroup);
            const wg = Math.ceil(step.size / 4);
            computePass.dispatchWorkgroups(wg, wg, wg);
        }
        computePass.end();

        this._needsDispatch = false;
        this._noiseGenerated = true;
        this._dispatchList = [];
    }

    getCoverageForWeather(weather, intensity) {
        const clamped = Math.min(Math.max(intensity || 0, 0), 1);
        let cirrus = 0.3;
        switch (weather) {
            case 'storm': cirrus = 0.5 + clamped * 0.2; break;
            case 'rain':  cirrus = 0.4; break;
            case 'foggy': cirrus = 0.3; break;
            case 'clear':
            default:      cirrus = 0.2 + clamped * 0.1; break;
        }
        return { cirrus };
    }

    dispose() {
        for (const tex of Object.values(this.noiseTextures)) { if (tex) tex.destroy(); }
        for (const buf of Object.values(this.uniformBuffers)) { if (buf) buf.destroy(); }
        this.noiseTextures = { base: null, detail: null, erosion: null };
        this.textureViews  = { base: null, detail: null, erosion: null };
        this._initialized  = false;
        this._noiseGenerated = false;
    }
}
