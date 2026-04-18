import { buildAtmoBankScatterWGSL } from './shaders/atmoBankScatter.wgsl.js';
import { ATMO_EMITTER_CAPACITY, ATMO_EMITTER_STRIDE } from './AtmoBankTypes.js';

const COUNTER_SIZE = 16;
const LAYER_META_STRIDE = 32;
const MAX_LAYERS = 256;
const SCATTER_INTERVAL = 60;
const CAMERA_MOVE_THRESHOLD = 100;

export class AtmoBankScatterPass {
    constructor(device, tileStreamer) {
        this.device = device;
        this.tileStreamer = tileStreamer;

        this._pipeline = null;
        this._bgl = null;
        this._bindGroup = null;

        this._emitterOutputBuf = null;
        this._counterBuf = null;
        this._readbackBuf = null;
        this._paramBuf = null;
        this._activeLayerBuf = null;
        this._layerMetaBuf = null;

        this._cachedEmitters = [];
        this._framesSinceScatter = SCATTER_INTERVAL;
        this._lastCamX = 0;
        this._lastCamY = 0;
        this._lastCamZ = 0;
        this._readbackPending = false;
        this._readbackReady = false;
        this._textureViewsValid = false;
        this._initialized = false;
    }

    initialize() {
        const device = this.device;
        const STOR = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
        const readbackSize = ATMO_EMITTER_CAPACITY * ATMO_EMITTER_STRIDE + COUNTER_SIZE;

        this._emitterOutputBuf = device.createBuffer({
            label: 'AtmoScatter-EmitterOutput',
            size: ATMO_EMITTER_CAPACITY * ATMO_EMITTER_STRIDE,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        });
        this._counterBuf = device.createBuffer({
            label: 'AtmoScatter-Counter',
            size: COUNTER_SIZE,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        });
        this._readbackBuf = device.createBuffer({
            label: 'AtmoScatter-Readback',
            size: readbackSize,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });
        this._paramBuf = device.createBuffer({
            label: 'AtmoScatter-Params', size: 64,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this._activeLayerBuf = device.createBuffer({
            label: 'AtmoScatter-ActiveLayers', size: MAX_LAYERS * 4,
            usage: STOR,
        });
        this._layerMetaBuf = device.createBuffer({
            label: 'AtmoScatter-LayerMeta', size: MAX_LAYERS * LAYER_META_STRIDE,
            usage: STOR,
        });

        this._bgl = device.createBindGroupLayout({
            label: 'AtmoScatter-BGL',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 5, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float', viewDimension: '2d-array' } },
                { binding: 6, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float', viewDimension: '2d-array' } },
                { binding: 7, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float', viewDimension: '2d-array' } },
            ],
        });

        const src = buildAtmoBankScatterWGSL({ maxEmitters: ATMO_EMITTER_CAPACITY });
        this._pipeline = device.createComputePipeline({
            label: 'AtmoScatter-Pipeline',
            layout: device.createPipelineLayout({ bindGroupLayouts: [this._bgl] }),
            compute: {
                module: device.createShaderModule({ label: 'AtmoScatter-Shader', code: src }),
                entryPoint: 'main',
            },
        });

        this._initialized = true;
    }

    _ensureBindGroup() {
        if (this._textureViewsValid && this._bindGroup) return true;

        const textures = this.tileStreamer?.getArrayTextures?.();
        const heightWrap  = textures?.height;
        const tileWrap    = textures?.tile;
        const normalWrap  = textures?.normal;

        const heightView  = heightWrap?._gpuTexture?.view;
        const tileView    = tileWrap?._gpuTexture?.view;
        const normalView  = normalWrap?._gpuTexture?.view;
        if (!heightView || !tileView || !normalView) return false;

        this._bindGroup = this.device.createBindGroup({
            label: 'AtmoScatter-BG',
            layout: this._bgl,
            entries: [
                { binding: 0, resource: { buffer: this._paramBuf } },
                { binding: 1, resource: { buffer: this._activeLayerBuf } },
                { binding: 2, resource: { buffer: this._emitterOutputBuf } },
                { binding: 3, resource: { buffer: this._counterBuf } },
                { binding: 4, resource: { buffer: this._layerMetaBuf } },
                { binding: 5, resource: heightView },
                { binding: 6, resource: tileView },
                { binding: 7, resource: normalView },
            ],
        });
        this._textureViewsValid = true;
        return true;
    }

    shouldDispatch(camera) {
        this._framesSinceScatter++;
        if (this._framesSinceScatter < SCATTER_INTERVAL) {
            const dx = camera.position.x - this._lastCamX;
            const dy = camera.position.y - this._lastCamY;
            const dz = camera.position.z - this._lastCamZ;
            if (dx * dx + dy * dy + dz * dz < CAMERA_MOVE_THRESHOLD * CAMERA_MOVE_THRESHOLD) {
                return false;
            }
        }
        return true;
    }

    dispatch(commandEncoder, camera, planetConfig, environmentState) {
        if (!this._initialized || this._readbackPending) return;
        if (!this._ensureBindGroup()) return;

        const tileInfo = this.tileStreamer._tileInfo;
        if (!tileInfo || tileInfo.size === 0) return;

        const activeLayers = new Uint32Array(MAX_LAYERS);
        const layerMeta = new Uint32Array(MAX_LAYERS * (LAYER_META_STRIDE / 4));
        let layerCount = 0;

        for (const info of tileInfo.values()) {
            if (layerCount >= MAX_LAYERS) break;
            if (info.layer == null) continue;
            activeLayers[layerCount] = layerCount;
            const b = layerCount * (LAYER_META_STRIDE / 4);
            layerMeta[b + 0] = info.face;
            layerMeta[b + 1] = info.depth;
            layerMeta[b + 2] = info.x;
            layerMeta[b + 3] = info.y;
            const i32View = new Int32Array(layerMeta.buffer);
            i32View[b + 4] = info.layer;
            layerCount++;
        }

        if (layerCount === 0) return;

        const origin = planetConfig?.origin || { x: 0, y: 0, z: 0 };
        const paramData = new Float32Array(16);
        const paramU32 = new Uint32Array(paramData.buffer);
        paramData[0] = camera.position.x;
        paramData[1] = camera.position.y;
        paramData[2] = camera.position.z;
        paramU32[3]  = ATMO_EMITTER_CAPACITY;
        paramData[4] = origin.x;
        paramData[5] = origin.y;
        paramData[6] = origin.z;
        paramData[7] = planetConfig?.radius || 100000;
        paramData[8] = planetConfig?.heightScale || 2000;
        paramData[9] = environmentState?.weatherIntensity ?? 0.3;
        paramData[10] = environmentState?.fogDensity ?? 0.3;
        paramU32[11] = (performance.now() * 1000) >>> 0;

        const q = this.device.queue;
        q.writeBuffer(this._paramBuf, 0, paramData);
        q.writeBuffer(this._activeLayerBuf, 0, activeLayers.buffer, 0, layerCount * 4);
        q.writeBuffer(this._layerMetaBuf, 0, layerMeta.buffer, 0, layerCount * LAYER_META_STRIDE);

        commandEncoder.clearBuffer(this._counterBuf, 0, COUNTER_SIZE);

        const pass = commandEncoder.beginComputePass({ label: 'AtmoScatter' });
        pass.setPipeline(this._pipeline);
        pass.setBindGroup(0, this._bindGroup);
        pass.dispatchWorkgroups(layerCount);
        pass.end();

        const emSize = ATMO_EMITTER_CAPACITY * ATMO_EMITTER_STRIDE;
        commandEncoder.copyBufferToBuffer(this._counterBuf, 0, this._readbackBuf, 0, COUNTER_SIZE);
        commandEncoder.copyBufferToBuffer(this._emitterOutputBuf, 0, this._readbackBuf, COUNTER_SIZE, emSize);

        this._readbackPending = true;
        this._readbackReady = false;
        this._framesSinceScatter = 0;
        this._lastCamX = camera.position.x;
        this._lastCamY = camera.position.y;
        this._lastCamZ = camera.position.z;

        this._readbackBuf.mapAsync(GPUMapMode.READ).then(() => {
            this._readbackReady = true;
        }).catch(() => {
            this._readbackPending = false;
        });
    }

    resolveReadback() {
        if (!this._readbackReady) return null;

        const mapped = this._readbackBuf.getMappedRange();
        const counterView = new Uint32Array(mapped, 0, 4);
        const count = Math.min(counterView[0], ATMO_EMITTER_CAPACITY);

        const emitters = [];
        const emView = new Float32Array(mapped, COUNTER_SIZE);
        const emU32  = new Uint32Array(mapped, COUNTER_SIZE);
        const stride = ATMO_EMITTER_STRIDE / 4;

        for (let i = 0; i < count; i++) {
            const b = i * stride;
            emitters.push({
                position: [emView[b], emView[b + 1], emView[b + 2]],
                spawnBudget: emU32[b + 3],
                localUp: [emView[b + 4], emView[b + 5], emView[b + 6]],
                typeId: emU32[b + 7],
                rngSeed: emU32[b + 8],
            });
        }

        this._readbackBuf.unmap();
        this._readbackPending = false;
        this._readbackReady = false;
        this._cachedEmitters = emitters;
        return emitters;
    }

    getEmitters() {
        return this._cachedEmitters;
    }

    dispose() {
        for (const k of ['_emitterOutputBuf','_counterBuf','_readbackBuf',
                          '_paramBuf','_activeLayerBuf','_layerMetaBuf']) {
            this[k]?.destroy();
        }
        this._initialized = false;
    }
}
