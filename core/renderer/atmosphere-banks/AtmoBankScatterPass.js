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
        this._readbackMapStarted = false;
        this._readbackReady = false;
        this._readbackGeneration = 0;
        this._textureViewsValid = false;
        this._heightView = null;
        this._tileView = null;
        this._normalView = null;
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
        const textures = this.tileStreamer?.getArrayTextures?.();
        const heightWrap  = textures?.height;
        const tileWrap    = textures?.tile;
        const normalWrap  = textures?.normal;

        const heightView  = heightWrap?._gpuTexture?.view;
        const tileView    = tileWrap?._gpuTexture?.view;
        const normalView  = normalWrap?._gpuTexture?.view;
        if (!heightView || !tileView || !normalView) return false;

        if (this._bindGroup &&
            this._heightView === heightView &&
            this._tileView === tileView &&
            this._normalView === normalView) {
            return true;
        }

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
        this._heightView = heightView;
        this._tileView = tileView;
        this._normalView = normalView;
        this._textureViewsValid = true;
        return true;
    }

    shouldDispatch(camera) {
        if (!this._initialized || this._readbackPending) return false;
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

    _cubePoint(face, u, v) {
        const s = u * 2 - 1;
        const t = v * 2 - 1;
        switch (face >>> 0) {
            case 0: return [ 1,  t, -s];
            case 1: return [-1,  t,  s];
            case 2: return [ s,  1, -t];
            case 3: return [ s, -1,  t];
            case 4: return [ s,  t,  1];
            default: return [-s,  t, -1];
        }
    }

    _estimateTileDistanceSq(info, camera, planetConfig) {
        const depth = Math.max(0, info.depth ?? 0);
        const grid = Math.max(1, 2 ** depth);
        const u = ((info.x ?? 0) + 0.5) / grid;
        const v = ((info.y ?? 0) + 0.5) / grid;
        const p = this._cubePoint(info.face ?? 0, u, v);
        const invLen = 1 / Math.max(Math.hypot(p[0], p[1], p[2]), 1e-6);
        const origin = planetConfig?.origin || { x: 0, y: 0, z: 0 };
        const radius = (planetConfig?.radius || 100000) + (planetConfig?.heightScale || 2000) * 0.25;
        const wx = origin.x + p[0] * invLen * radius;
        const wy = origin.y + p[1] * invLen * radius;
        const wz = origin.z + p[2] * invLen * radius;
        const dx = wx - camera.position.x;
        const dy = wy - camera.position.y;
        const dz = wz - camera.position.z;
        return dx * dx + dy * dy + dz * dz;
    }

    _stableSeed(planetConfig) {
        const raw = planetConfig?.seed ?? planetConfig?.terrainSeed ?? planetConfig?.terrain?.seed;
        if (Number.isFinite(raw)) return raw >>> 0;
        if (typeof raw === 'string') {
            let h = 2166136261 >>> 0;
            for (let i = 0; i < raw.length; i++) {
                h ^= raw.charCodeAt(i);
                h = Math.imul(h, 16777619) >>> 0;
            }
            return h || 0x9E3779B9;
        }
        return 0x9E3779B9;
    }

    dispatch(commandEncoder, camera, planetConfig, environmentState) {
        if (!this._initialized || this._readbackPending) return false;
        if (!this._ensureBindGroup()) return false;

        const tileInfo = this.tileStreamer._tileInfo;
        if (!tileInfo || tileInfo.size === 0) return false;

        const activeLayers = new Uint32Array(MAX_LAYERS);
        const layerMeta = new Uint32Array(MAX_LAYERS * (LAYER_META_STRIDE / 4));
        const layers = [];

        for (const info of tileInfo.values()) {
            if (info.layer == null) continue;
            layers.push({
                info,
                distSq: this._estimateTileDistanceSq(info, camera, planetConfig),
            });
        }

        layers.sort((a, b) =>
            (a.distSq - b.distSq) ||
            ((a.info.face ?? 0) - (b.info.face ?? 0)) ||
            ((b.info.depth ?? 0) - (a.info.depth ?? 0)) ||
            ((a.info.x ?? 0) - (b.info.x ?? 0)) ||
            ((a.info.y ?? 0) - (b.info.y ?? 0)) ||
            ((a.info.layer ?? 0) - (b.info.layer ?? 0))
        );

        let layerCount = 0;

        for (const { info } of layers) {
            if (layerCount >= MAX_LAYERS) break;
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

        if (layerCount === 0) return false;

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
        paramU32[11] = this._stableSeed(planetConfig);

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
        this._readbackMapStarted = false;
        this._readbackReady = false;
        this._readbackGeneration++;
        this._framesSinceScatter = 0;
        this._lastCamX = camera.position.x;
        this._lastCamY = camera.position.y;
        this._lastCamZ = camera.position.z;
        return true;
    }

    beginReadbackAfterSubmit() {
        if (!this._initialized ||
            !this._readbackPending ||
            this._readbackMapStarted ||
            this._readbackReady ||
            !this._readbackBuf) {
            return;
        }

        this._readbackMapStarted = true;
        const generation = this._readbackGeneration;
        this._readbackBuf.mapAsync(GPUMapMode.READ).then(() => {
            if (generation !== this._readbackGeneration) return;
            this._readbackReady = true;
        }).catch(() => {
            if (generation !== this._readbackGeneration) return;
            this._readbackPending = false;
            this._readbackMapStarted = false;
            this._readbackReady = false;
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
        this._readbackMapStarted = false;
        this._readbackReady = false;
        this._cachedEmitters = emitters;
        return emitters;
    }

    getEmitters() {
        return this._cachedEmitters;
    }

    dispose() {
        this._readbackGeneration++;
        if (this._readbackReady) {
            try { this._readbackBuf?.unmap(); } catch {}
        }
        for (const k of ['_emitterOutputBuf','_counterBuf','_readbackBuf',
                          '_paramBuf','_activeLayerBuf','_layerMetaBuf']) {
            this[k]?.destroy();
        }
        this._readbackPending = false;
        this._readbackMapStarted = false;
        this._readbackReady = false;
        this._initialized = false;
    }
}
