import { Logger } from '../../config/Logger.js';
import { Texture, TextureFormat, TextureFilter, TextureWrap, gpuFormatSampleType } from '../resources/texture.js';
import { buildGroundFieldBakeShader } from './shaders/groundFieldBake.wgsl.js';
import { GROUND_FIELD_BAKE_CONFIG } from './streamerConfig.js';

const ACTIVE_FIELD_FLAG = 1;

export class GroundFieldBaker {
    constructor(device, opts = {}) {
        this.device = device;
        this._logTag = '[GroundFieldBaker]';
        this._assetRegistry = opts.assetRegistry || null;
        this._tilePoolSize = opts.tilePoolSize;
        this._tileTypeCount = Math.max(1, opts.tileTypeCount ?? 1);
        this._seed = (opts.seed ?? 0) >>> 0;
        this._textureFormats = opts.textureFormats || {};
        this._logDispatches = opts.logDispatches !== false;
        this._logEveryNth = opts.logEveryNth ?? 4;
        this._dispatchCount = 0;
        this._fieldTexture = null;
        this._fieldTextureWrapper = null;
        this._paramBuffer = null;
        this._tileBuffer = null;
        this._tileStaging = null;
        this._channelScaleBuffer = null;
        this._bakeBGL = null;
        this._bakePipe = null;
        this._bakeBG = null;
        this._clearPipe = null;
        this._clearBG = null;
        this._bgCache = { climate: null, tile: null };
        this._queue = [];
        this._initialized = false;

        const cfg = { ...GROUND_FIELD_BAKE_CONFIG, ...(opts.fieldConfig || {}) };
        const configuredChannels = Array.isArray(cfg.channels) ? cfg.channels.slice(0, 2) : [];
        this._cfg = {
            enabled: cfg.enabled !== false,
            resolution: Math.max(8, cfg.resolution | 0),
            maxBakesPerFrame: Math.max(1, Math.min(32, cfg.maxBakesPerFrame | 0)),
            channels: configuredChannels,
        };

        this._maxBatch = this._cfg.maxBakesPerFrame;
        this._channelDescriptors = [];
        this._channelScaleData = null;
    }

    get enabled() { return this._cfg.enabled; }
    get pendingBakes() { return this._queue.length; }
    get resolution() { return this._cfg.resolution; }

    getFieldTextureWrapper() {
        return this._fieldTextureWrapper;
    }

    getChannelDescriptors() {
        return this._channelDescriptors.map((channel) => ({ ...channel }));
    }

    initialize() {
        if (this._initialized || !this._cfg.enabled) return;
        if (!this._assetRegistry) {
            Logger.warn(`${this._logTag} missing assetRegistry; disabling`);
            this._cfg.enabled = false;
            return;
        }
        if (!Number.isFinite(this._tilePoolSize) || this._tilePoolSize < 1) {
            Logger.warn(`${this._logTag} invalid tilePoolSize; disabling`);
            this._cfg.enabled = false;
            return;
        }

        this._channelDescriptors = this._resolveChannels();
        if (this._channelDescriptors.length === 0) {
            Logger.warn(`${this._logTag} no field channels resolved; disabling`);
            this._cfg.enabled = false;
            return;
        }

        this._createFieldTexture();
        this._createBuffers();
        this._createBakePipeline();
        this._createClearPipelineAndRun();

        this._initialized = true;
        const channelSummary = this._channelDescriptors
            .map((channel) => `${channel.name}:${channel.sourceName}`)
            .join(', ');
        Logger.info(
            `${this._logTag} ready — res=${this._cfg.resolution} ` +
            `layers=${this._tilePoolSize} mem=${this._memMB().toFixed(2)}MB ` +
            `channels=[${channelSummary}] batch=${this._maxBatch}`
        );
    }

    enqueueBake(face, depth, tileX, tileY, layer, enabled = true) {
        if (!this._initialized) return;
        for (let i = this._queue.length - 1; i >= 0; i--) {
            if (this._queue[i].layer === layer) {
                this._queue.splice(i, 1);
            }
        }
        this._queue.push({
            face,
            depth,
            tileX,
            tileY,
            layer,
            flags: enabled ? ACTIVE_FIELD_FLAG : 0,
        });
    }

    update(encoder, climateGPU, tileGPU) {
        if (!this._initialized || !encoder) return;
        if (this._queue.length === 0) return;
        if (!climateGPU || !tileGPU) {
            if (this._logDispatches && this._dispatchCount === 0) {
                Logger.info(
                    `${this._logTag} bake deferred — pool textures not yet available ` +
                    `(queue=${this._queue.length})`
                );
            }
            return;
        }

        this._rebuildBindGroupIfStale(climateGPU, tileGPU);
        if (!this._bakeBG) return;

        const batch = this._queue.splice(0, this._maxBatch);
        this._dispatchCount++;

        if (
            this._logDispatches &&
            (this._dispatchCount === 1 || (this._dispatchCount % this._logEveryNth) === 0)
        ) {
            const activeCount = batch.reduce((count, tile) => count + ((tile.flags & ACTIVE_FIELD_FLAG) ? 1 : 0), 0);
            const depths = batch.map((tile) => tile.depth);
            const dMin = Math.min(...depths);
            const dMax = Math.max(...depths);
            Logger.info(
                `${this._logTag} bake #${this._dispatchCount}: ` +
                `batch=${batch.length} active=${activeCount} depth=[${dMin}..${dMax}] ` +
                `pending=${this._queue.length}`
            );
        }

        this._uploadParams(batch.length);
        this._uploadTiles(batch);

        const wg = Math.ceil(this._cfg.resolution / 8);
        const pass = encoder.beginComputePass({ label: 'GroundField-Bake' });
        pass.setPipeline(this._bakePipe);
        pass.setBindGroup(0, this._bakeBG);
        pass.dispatchWorkgroups(wg, wg, batch.length);
        pass.end();
    }

    dispose() {
        this._fieldTexture?.destroy();
        this._paramBuffer?.destroy();
        this._tileBuffer?.destroy();
        this._channelScaleBuffer?.destroy();
        this._fieldTextureWrapper = null;
        this._bakeBG = null;
        this._clearBG = null;
        this._initialized = false;
    }

    _memMB() {
        const r = this._cfg.resolution;
        return (r * r * 4 * this._tilePoolSize) / (1024 * 1024);
    }

    _resolveChannels() {
        const descriptors = [];
        const variants = this._assetRegistry.getAllVariants?.() || [];
        const scaleData = new Float32Array(this._cfg.channels.length * this._tileTypeCount);

        for (let channelIndex = 0; channelIndex < this._cfg.channels.length; channelIndex++) {
            const channel = this._cfg.channels[channelIndex];
            if (!channel) continue;

            const family = channel.familyName
                ? this._assetRegistry.getFamily?.(channel.familyName)
                : null;
            const archetype = channel.archetypeName
                ? this._assetRegistry.getArchetype?.(channel.archetypeName)
                : null;

            const matchingVariants = variants.filter((variant) => {
                if (!variant?.archetype?.isActive) return false;
                if (family && variant.family?.name === family.name) return true;
                if (!family && archetype && variant.archetype?.name === archetype.name) return true;
                return false;
            });

            if (matchingVariants.length === 0) {
                Logger.warn(
                    `${this._logTag} channel "${channel.name || channel.familyName || channel.archetypeName}" ` +
                    `did not resolve any active variants`
                );
                continue;
            }

            const rowBase = channelIndex * this._tileTypeCount;
            let supportedTiles = 0;
            for (const variant of matchingVariants) {
                let tileTypes = variant.tileTypes;
                if ((!tileTypes || tileTypes.length === 0) && variant.family?.tileTypes) {
                    tileTypes = variant.family.tileTypes;
                }
                if (!tileTypes || tileTypes.length === 0) continue;

                const densityScale = variant.family?.perTileDensityScale || null;
                for (const tileId of tileTypes) {
                    if (!Number.isInteger(tileId) || tileId < 0 || tileId >= this._tileTypeCount) {
                        continue;
                    }
                    const scale = Math.max(0, densityScale?.[tileId] ?? 1.0);
                    if (scale > scaleData[rowBase + tileId]) {
                        if (scaleData[rowBase + tileId] === 0) {
                            supportedTiles++;
                        }
                        scaleData[rowBase + tileId] = scale;
                    }
                }
            }

            if (supportedTiles === 0) {
                Logger.warn(
                    `${this._logTag} channel "${channel.name || family?.name || archetype?.name}" ` +
                    `resolved variants but no supported tile IDs`
                );
                continue;
            }

            descriptors.push({
                index: descriptors.length,
                rowIndex: channelIndex,
                name: channel.name || family?.name || archetype?.name || `channel${channelIndex}`,
                familyName: family?.name ?? null,
                archetypeName: archetype?.name ?? null,
                sourceName: family?.name ?? archetype?.name ?? 'unknown',
                supportedTiles,
            });
        }

        if (descriptors.length === 0) {
            this._channelScaleData = null;
            return [];
        }

        const compactScaleData = new Float32Array(descriptors.length * this._tileTypeCount);
        for (let i = 0; i < descriptors.length; i++) {
            const srcOffset = descriptors[i].rowIndex * this._tileTypeCount;
            const dstOffset = i * this._tileTypeCount;
            compactScaleData.set(scaleData.subarray(srcOffset, srcOffset + this._tileTypeCount), dstOffset);
            descriptors[i].rowIndex = i;
        }

        this._channelScaleData = compactScaleData;
        return descriptors;
    }

    _createFieldTexture() {
        const res = this._cfg.resolution;
        this._fieldTexture = this.device.createTexture({
            label: 'GroundField-Texture',
            size: [res, res, this._tilePoolSize],
            format: 'rgba8unorm',
            dimension: '2d',
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
        });

        const wrapper = new Texture({
            width: res,
            height: res,
            depth: this._tilePoolSize,
            format: TextureFormat.RGBA8,
            minFilter: TextureFilter.NEAREST,
            magFilter: TextureFilter.NEAREST,
            wrapS: TextureWrap.CLAMP,
            wrapT: TextureWrap.CLAMP,
            generateMipmaps: false,
        });
        wrapper._gpuTexture = {
            texture: this._fieldTexture,
            view: this._fieldTexture.createView({ dimension: '2d-array' }),
            format: 'rgba8unorm',
        };
        wrapper._gpuFormat = 'rgba8unorm';
        wrapper._isFilterable = true;
        wrapper._needsUpload = false;
        wrapper._isArray = true;
        wrapper._isGPUOnly = true;
        this._fieldTextureWrapper = wrapper;
    }

    _createBuffers() {
        this._paramBuffer = this.device.createBuffer({
            label: 'GroundField-Params',
            size: 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this._tileBuffer = this.device.createBuffer({
            label: 'GroundField-TileList',
            size: this._maxBatch * 8 * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this._tileStaging = new Uint32Array(this._maxBatch * 8);

        this._channelScaleBuffer = this.device.createBuffer({
            label: 'GroundField-ChannelScaleLUT',
            size: Math.max(16, this._channelScaleData.byteLength),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(this._channelScaleBuffer, 0, this._channelScaleData);
    }

    _createBakePipeline() {
        const climateSampleType = gpuFormatSampleType(this._textureFormats.climate || 'rgba8unorm');
        const tileSampleType = gpuFormatSampleType(this._textureFormats.tile || 'r32float');
        const code = buildGroundFieldBakeShader({
            resolution: this._cfg.resolution,
            maxBatchSize: this._maxBatch,
            densityChannels: this._channelDescriptors.length,
        });
        const module = this.device.createShaderModule({
            label: 'GroundField-BakeShader',
            code,
        });

        this._bakeBGL = this.device.createBindGroupLayout({
            label: 'GroundField-BakeBGL',
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: 'uniform' },
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: 'read-only-storage' },
                },
                {
                    binding: 2,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: 'read-only-storage' },
                },
                {
                    binding: 3,
                    visibility: GPUShaderStage.COMPUTE,
                    texture: { sampleType: climateSampleType, viewDimension: '2d-array' },
                },
                {
                    binding: 4,
                    visibility: GPUShaderStage.COMPUTE,
                    texture: { sampleType: tileSampleType, viewDimension: '2d-array' },
                },
                {
                    binding: 5,
                    visibility: GPUShaderStage.COMPUTE,
                    storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d-array' },
                },
            ],
        });

        this._bakePipe = this.device.createComputePipeline({
            label: 'GroundField-BakePipe',
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [this._bakeBGL],
            }),
            compute: { module, entryPoint: 'bake' },
        });
    }

    _createClearPipelineAndRun() {
        const res = this._cfg.resolution;
        const mod = this.device.createShaderModule({
            label: 'GroundField-ClearShader',
            code: /* wgsl */`
                @group(0) @binding(0)
                var fieldOut: texture_storage_2d_array<rgba8unorm, write>;

                @compute @workgroup_size(8, 8, 1)
                fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
                    if (gid.x >= ${res}u || gid.y >= ${res}u) { return; }
                    textureStore(
                        fieldOut,
                        vec2<i32>(i32(gid.x), i32(gid.y)),
                        i32(gid.z),
                        vec4<f32>(0.0, 0.0, 0.0, 0.0)
                    );
                }
            `,
        });

        const bgl = this.device.createBindGroupLayout({
            label: 'GroundField-ClearBGL',
            entries: [{
                binding: 0,
                visibility: GPUShaderStage.COMPUTE,
                storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d-array' },
            }],
        });

        this._clearPipe = this.device.createComputePipeline({
            label: 'GroundField-ClearPipe',
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
            compute: { module: mod, entryPoint: 'main' },
        });

        this._clearBG = this.device.createBindGroup({
            label: 'GroundField-ClearBG',
            layout: bgl,
            entries: [{
                binding: 0,
                resource: this._fieldTexture.createView({ dimension: '2d-array' }),
            }],
        });

        const wg = Math.ceil(res / 8);
        const encoder = this.device.createCommandEncoder({ label: 'GroundField-InitClear' });
        const pass = encoder.beginComputePass();
        pass.setPipeline(this._clearPipe);
        pass.setBindGroup(0, this._clearBG);
        pass.dispatchWorkgroups(wg, wg, this._tilePoolSize);
        pass.end();
        this.device.queue.submit([encoder.finish()]);
    }

    _rebuildBindGroupIfStale(climateGPU, tileGPU) {
        if (
            this._bakeBG &&
            this._bgCache.climate === climateGPU &&
            this._bgCache.tile === tileGPU
        ) {
            return;
        }

        this._bakeBG = this.device.createBindGroup({
            label: 'GroundField-BakeBG',
            layout: this._bakeBGL,
            entries: [
                { binding: 0, resource: { buffer: this._paramBuffer } },
                { binding: 1, resource: { buffer: this._tileBuffer } },
                { binding: 2, resource: { buffer: this._channelScaleBuffer } },
                { binding: 3, resource: climateGPU.createView({ dimension: '2d-array' }) },
                { binding: 4, resource: tileGPU.createView({ dimension: '2d-array' }) },
                { binding: 5, resource: this._fieldTexture.createView({ dimension: '2d-array' }) },
            ],
        });
        this._bgCache.climate = climateGPU;
        this._bgCache.tile = tileGPU;
    }

    _uploadParams(batchCount) {
        const data = new Uint32Array(64);
        data[0] = batchCount >>> 0;
        data[1] = this._tileTypeCount >>> 0;
        data[2] = this._seed;
        this.device.queue.writeBuffer(this._paramBuffer, 0, data);
    }

    _uploadTiles(batch) {
        const staging = this._tileStaging;
        staging.fill(0);
        for (let i = 0; i < batch.length; i++) {
            const base = i * 8;
            const tile = batch[i];
            staging[base] = tile.face >>> 0;
            staging[base + 1] = tile.depth >>> 0;
            staging[base + 2] = tile.tileX >>> 0;
            staging[base + 3] = tile.tileY >>> 0;
            staging[base + 4] = tile.layer >>> 0;
            staging[base + 5] = tile.flags >>> 0;
        }
        this.device.queue.writeBuffer(this._tileBuffer, 0, staging);
    }
}
