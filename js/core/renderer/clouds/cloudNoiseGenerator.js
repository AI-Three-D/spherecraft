// js/renderer/clouds/cloudNoiseGenerator.js
// Generates tileable 3D noise textures for volumetric cloud rendering
// Creates multiple resolutions for different detail levels

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.178.0/build/three.module.js';
import { createCloudNoiseComputeShader } from './shaders/cloudNoiseCompute.wgsl.js';

export class CloudNoiseGenerator {
    constructor(backend, options = {}) {
        this.backend = backend;
        this.enableVolumetric = options.enableVolumetric ?? true;

        this.noiseTextures = {
            base: null,
            detail: null,
            erosion: null
        };

        this.textureViews = {
            base: null,
            detail: null,
            erosion: null
        };

        this.dimensions = {
            base: 64,
            detail: 96,
            erosion: 128
        };

        if (this.enableVolumetric) {
            // High-resolution textures for volumetric tier
            this.noiseTextures.volBase = null;
            this.noiseTextures.volDetail = null;
            this.textureViews.volBase = null;
            this.textureViews.volDetail = null;
            this.dimensions.volBase = 128;
            this.dimensions.volDetail = 64;
        }

        this.uniformBuffers = {};
        this.bindGroups = {};

        this._initialized = false;
        this._noiseGenerated = false;
        this._lastSeed = null;
        this._lastTileSizes = { base: null, detail: null };
        this._dispatchList = [];
        this._smoothedCamPos = new THREE.Vector3();
        this._smoothedCamInit = false;
        this._snapBlend = 0.08;
    }

    async initialize() {
        if (this._initialized) return;

        const device = this.backend.device;
        if (!device) return;

        // Create periodic noise textures (including new volumetric ones)
        for (const [name, size] of Object.entries(this.dimensions)) {
            this.noiseTextures[name] = device.createTexture({
                label: `CloudNoise_${name}_${size}`,
                size: [size, size, size],
                dimension: '3d',
                format: 'rgba8unorm',
                usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
            });

            this.textureViews[name] = this.noiseTextures[name].createView({ dimension: '3d' });

            this.uniformBuffers[name] = device.createBuffer({
                size: 64,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
            });
        }

        // Create compute pipeline (shared for all resolutions)
        const shaderCode = createCloudNoiseComputeShader();
        const shaderModule = device.createShaderModule({ code: shaderCode });

        const bindGroupLayout = device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE,
                    storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '3d' } }
            ]
        });

        const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });

        this.computePipeline = device.createComputePipeline({
            layout: pipelineLayout,
            compute: { module: shaderModule, entryPoint: 'main' }
        });

        // Create bind groups for each texture
        for (const name of Object.keys(this.dimensions)) {
            this.bindGroups[name] = device.createBindGroup({
                layout: bindGroupLayout,
                entries: [
                    { binding: 0, resource: { buffer: this.uniformBuffers[name] } },
                    { binding: 1, resource: this.textureViews[name] }
                ]
            });
        }

        this._initialized = true;
    }

    // Existing getters
    getBaseTexture() { return this.noiseTextures.base; }
    getDetailTexture() { return this.noiseTextures.detail; }
    getErosionTexture() { return this.noiseTextures.erosion; }

    getBaseTextureView() { return this.textureViews.base; }
    getDetailTextureView() { return this.textureViews.detail; }
    getErosionTextureView() { return this.textureViews.erosion; }

    // Volumetric texture getters
    getVolBaseTexture() { return this.enableVolumetric ? this.noiseTextures.volBase : null; }
    getVolDetailTexture() { return this.enableVolumetric ? this.noiseTextures.volDetail : null; }
    
    getVolBaseTextureView() { return this.enableVolumetric ? this.textureViews.volBase : null; }
    getVolDetailTextureView() { return this.enableVolumetric ? this.textureViews.volDetail : null; }

    // Legacy compatibility
    getTexture() { return this.noiseTextures.detail; }
    getTextureView() { return this.textureViews.detail; }
    getDimensions() { return { x: this.dimensions.detail, y: this.dimensions.detail, z: this.dimensions.detail }; }

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
        const regenerateAll = !this._noiseGenerated || this._lastSeed !== seed;

        // Noise type mapping:
        // 0 = base shape (Perlin-Worley hybrid)
        // 1 = detail (multi-octave Worley)
        // 2 = erosion (high-frequency Worley)
        // 3 = volumetric base (same as 0, but higher res)
        // 4 = volumetric detail (same as 1, but different params)
        const noiseTypes = { 
            base: 0, 
            detail: 1, 
            erosion: 2
        };
        if (this.enableVolumetric) {
            noiseTypes.volBase = 0;   // Same algorithm as base, higher resolution
            noiseTypes.volDetail = 1; // Same algorithm as detail
        }

        const writeParams = (buffer, {
            size,
            seedValue,
            noiseType,
            period,
            origin,
            voxelSize,
            noiseScale
        }) => {
            const data = new ArrayBuffer(64);
            const view = new DataView(data);
            view.setUint32(0, size, true);
            view.setUint32(4, size, true);
            view.setUint32(8, size, true);
            view.setInt32(12, seedValue, true);
            view.setUint32(16, noiseType, true);
            view.setUint32(20, period, true);
            view.setUint32(24, 0, true);
            view.setUint32(28, 0, true);
            view.setFloat32(32, origin.x, true);
            view.setFloat32(36, origin.y, true);
            view.setFloat32(40, origin.z, true);
            view.setFloat32(48, voxelSize, true);
            view.setFloat32(52, noiseScale, true);
            device.queue.writeBuffer(buffer, 0, data);
        };

        if (regenerateAll) {
            for (const [name, size] of Object.entries(this.dimensions)) {
                // Use different seed offsets for volumetric textures to get variety
                const seedOffset = (name === 'volBase' || name === 'volDetail') ? 12345 : 0;
                
                writeParams(this.uniformBuffers[name], {
                    size,
                    seedValue: seed + seedOffset,
                    noiseType: noiseTypes[name],
                    period: 1,
                    origin: new THREE.Vector3(),
                    voxelSize: 1.0,
                    noiseScale: 1.0
                });
                this._dispatchList.push({ bindGroup: this.bindGroups[name], size });
            }
        }

        this._needsDispatch = this._dispatchList.length > 0;
    }

    dispatch(commandEncoder) {
        if (!this._initialized || !this._needsDispatch || this._dispatchList.length === 0) return;

        const computePass = commandEncoder.beginComputePass();
        computePass.setPipeline(this.computePipeline);

        for (const entry of this._dispatchList) {
            computePass.setBindGroup(0, entry.bindGroup);
            const workgroups = Math.ceil(entry.size / 4);
            computePass.dispatchWorkgroups(workgroups, workgroups, workgroups);
        }

        computePass.end();

        this._needsDispatch = false;
        this._noiseGenerated = true;
        this._dispatchList = [];
    }

    _computeCoverage(weather, intensity) {
        const clamped = Math.min(Math.max(intensity || 0, 0), 1);
        let cumulus = 0.4;
        let cirrus = 0.3;

        switch (weather) {
            case 'storm':
                cumulus = 0.8 + clamped * 0.2;
                cirrus = 0.5 + clamped * 0.2;
                break;
            case 'rain':
                cumulus = 0.7 + clamped * 0.2;
                cirrus = 0.4;
                break;
            case 'foggy':
                cumulus = 0.5;
                cirrus = 0.3;
                break;
            case 'clear':
            default:
                cumulus = 0.3 + clamped * 0.2;
                cirrus = 0.2 + clamped * 0.1;
                break;
        }
        return { cumulus, cirrus };
    }

    getCoverageForWeather(weather, intensity) {
        return this._computeCoverage(weather, intensity);
    }

    dispose() {
        for (const tex of Object.values(this.noiseTextures)) {
            if (tex) tex.destroy();
        }
        for (const buf of Object.values(this.uniformBuffers)) {
            if (buf) buf.destroy();
        }
        this.noiseTextures = { base: null, detail: null, erosion: null };
        this.textureViews = { base: null, detail: null, erosion: null };
        if (this.enableVolumetric) {
            this.noiseTextures.volBase = null;
            this.noiseTextures.volDetail = null;
            this.textureViews.volBase = null;
            this.textureViews.volDetail = null;
        }
        this._initialized = false;
        this._noiseGenerated = false;
    }
}
