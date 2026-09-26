// core/renderer/lakes/lakeHeightProbe.js
//
// Checkpoint-1 diagnostic (see CODEX_RIVER_LAKE_HANDOFF.md): resolves a
// small set of arbitrary world-space query points against the resident
// final height texture, the same way RiverBedBake resolves its per-cell
// grid — one dispatch, non-blocking, read-only. Not the production
// lake-height sampler; that lands at the resident-level/shoreline
// checkpoint once this diagnostic's numbers are reviewed.

import { Logger } from '../../../shared/Logger.js';
import {
    buildLakeHeightProbeShader,
    LAKE_HEIGHT_PROBE_RECORD_U32,
    LAKE_HEIGHT_PROBE_NOT_FOUND_DEPTH,
    LAKE_HEIGHT_PROBE_NOT_FOUND_LAYER,
} from './shaders/lakeHeightProbeShader.wgsl.js';
import { gpuFormatSampleType } from '../resources/texture.js';

const PARAMS_BYTES = 48;
const QUERY_BYTES_PER_ENTRY = 16; // vec4<f32>
const RESULT_BYTES_PER_ENTRY = LAKE_HEIGHT_PROBE_RECORD_U32 * 4;

export class LakeHeightProbe {
    constructor(device, { maxQueries }) {
        this.device = device;
        this.maxQueries = maxQueries;

        this._pipeline = null;
        this._bgl = null;
        this._paramsBuffer = null;
        this._queryBuffer = null;
        this._resultsBuffer = null;
        this._readbackBuffer = null;
        this._readbackState = 'idle';
        this._initialized = false;
        this._loggedMissing = false;
    }

    initialize({ tileStreamer } = {}) {
        const code = buildLakeHeightProbeShader();
        const module = this.device.createShaderModule({ label: 'LakeHeightProbe-SM', code });
        this._shaderModule = module;

        const heightFormat = tileStreamer?.textureFormats?.height || 'r32float';
        const heightSampleType = gpuFormatSampleType(heightFormat);

        this._bgl = this.device.createBindGroupLayout({
            label: 'LakeHeightProbe-BGL',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE,
                  texture: { sampleType: heightSampleType, viewDimension: '2d-array' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
            ],
        });

        this._pipeline = this.device.createComputePipeline({
            label: 'LakeHeightProbe-Pipeline',
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [this._bgl] }),
            compute: { module, entryPoint: 'main' },
        });

        this._paramsBuffer = this.device.createBuffer({
            label: 'LakeHeightProbe-Params',
            size: PARAMS_BYTES,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this._paramsArrayBuffer = new ArrayBuffer(PARAMS_BYTES);
        this._paramsF32 = new Float32Array(this._paramsArrayBuffer);
        this._paramsU32 = new Uint32Array(this._paramsArrayBuffer);

        this._queryBuffer = this.device.createBuffer({
            label: 'LakeHeightProbe-Query',
            size: this.maxQueries * QUERY_BYTES_PER_ENTRY,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this._queryArrayBuffer = new Float32Array(this.maxQueries * 4);

        this._resultsByteLength = this.maxQueries * RESULT_BYTES_PER_ENTRY;
        this._resultsBuffer = this.device.createBuffer({
            label: 'LakeHeightProbe-Results',
            size: this._resultsByteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        });
        this._readbackBuffer = this.device.createBuffer({
            label: 'LakeHeightProbe-Readback',
            size: this._resultsByteLength,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });

        this._initialized = true;
    }

    /**
     * WebGPU shader/pipeline creation errors are async and silent (a
     * pipeline can be created successfully and still never produce real
     * output — see RIVER_WALKING_SKELETON_LOG.md gotcha #2). Must be
     * awaited and checked before trusting any dispatch from this module.
     * @returns {Promise<{messages: Array<{type:string,message:string,lineNum:number,linePos:number}>, hasErrors: boolean}>}
     */
    async getShaderCompilationInfo() {
        if (!this._shaderModule?.getCompilationInfo) return { messages: [], hasErrors: false };
        const info = await this._shaderModule.getCompilationInfo();
        const messages = Array.from(info.messages).map((m) => ({
            type: m.type, message: m.message, lineNum: m.lineNum, linePos: m.linePos,
        }));
        return { messages, hasErrors: messages.some((m) => m.type === 'error') };
    }

    /**
     * Dispatch a one-off probe for `queryWorldPositions` (array of
     * {x,y,z}, length <= maxQueries). Non-blocking.
     * @returns {boolean} true if dispatched.
     */
    dispatch(encoder, { queryWorldPositions, origin, heightScale, quadtreeGPU, tileStreamer }) {
        if (!this._initialized) return false;
        if (this._readbackState !== 'idle') return false;
        const numQueries = queryWorldPositions.length;
        if (numQueries === 0 || numQueries > this.maxQueries) return false;

        const heightTex = tileStreamer?.getArrayTextures?.()?.height;
        const hashBuf = quadtreeGPU?.getLoadedTileTableBuffer?.();
        const tView = this._getTextureView(heightTex);
        const hBuf = this._getGPUBuffer(hashBuf);
        if (!tView || !hBuf) {
            if (!this._loggedMissing) {
                const missing = [!tView ? 'height texture' : null, !hBuf ? 'hash table' : null].filter(Boolean).join(', ');
                Logger.warn(`[LakeHeightProbe] waiting on resources: ${missing}`);
                this._loggedMissing = true;
            }
            return false;
        }
        this._loggedMissing = false;

        const f32 = this._paramsF32; const u32 = this._paramsU32;
        f32[0] = origin.x; f32[1] = origin.y; f32[2] = origin.z; f32[3] = heightScale;
        u32[4] = quadtreeGPU?.loadedTableMask ?? 0;
        u32[5] = quadtreeGPU?.loadedTableCapacity ?? 0;
        u32[6] = tileStreamer?.tileTextureSize ?? 1024;
        u32[7] = quadtreeGPU?.maxDepth ?? 12;
        u32[8] = numQueries;
        u32[9] = 0; u32[10] = 0; u32[11] = 0;
        this.device.queue.writeBuffer(this._paramsBuffer, 0, this._paramsArrayBuffer);

        const qArr = this._queryArrayBuffer;
        for (let i = 0; i < numQueries; i++) {
            const p = queryWorldPositions[i];
            qArr[i * 4] = p.x; qArr[i * 4 + 1] = p.y; qArr[i * 4 + 2] = p.z; qArr[i * 4 + 3] = 0;
        }
        this.device.queue.writeBuffer(this._queryBuffer, 0, qArr, 0, numQueries * 4);

        const bindGroup = this.device.createBindGroup({
            label: 'LakeHeightProbe-BG',
            layout: this._bgl,
            entries: [
                { binding: 0, resource: { buffer: this._paramsBuffer } },
                { binding: 1, resource: tView },
                { binding: 2, resource: { buffer: hBuf } },
                { binding: 3, resource: { buffer: this._queryBuffer } },
                { binding: 4, resource: { buffer: this._resultsBuffer } },
            ],
        });

        const pass = encoder.beginComputePass({ label: 'LakeHeightProbe' });
        pass.setPipeline(this._pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(Math.ceil(numQueries / 32));
        pass.end();

        this._lastNumQueries = numQueries;
        encoder.copyBufferToBuffer(this._resultsBuffer, 0, this._readbackBuffer, 0, this._resultsByteLength);
        this._readbackState = 'copied';
        return true;
    }

    /**
     * Resolve the last dispatched probe.
     * @returns {Promise<Array<object>|null>} one parsed record per query.
     */
    resolve() {
        if (this._readbackState !== 'copied') return Promise.resolve(null);
        this._readbackState = 'mapping';
        const numQueries = this._lastNumQueries;
        return this._readbackBuffer.mapAsync(GPUMapMode.READ).then(() => {
            const range = this._readbackBuffer.getMappedRange(0, numQueries * RESULT_BYTES_PER_ENTRY).slice(0);
            this._readbackBuffer.unmap();
            const u32 = new Uint32Array(range);
            const f32 = new Float32Array(range);
            const stride = LAKE_HEIGHT_PROBE_RECORD_U32;

            const out = [];
            for (let i = 0; i < numQueries; i++) {
                const base = i * stride;
                const found = u32[base + 21] === 1;
                const depthRaw = u32[base + 9];
                const layerRaw = u32[base + 12];
                out.push({
                    found,
                    worldPos: { x: f32[base + 0], y: f32[base + 1], z: f32[base + 2] },
                    dir: { x: f32[base + 3], y: f32[base + 4], z: f32[base + 5] },
                    face: u32[base + 6],
                    u: f32[base + 7],
                    v: f32[base + 8],
                    depth: depthRaw === LAKE_HEIGHT_PROBE_NOT_FOUND_DEPTH ? null : depthRaw,
                    tileX: u32[base + 10],
                    tileY: u32[base + 11],
                    layer: layerRaw === LAKE_HEIGHT_PROBE_NOT_FOUND_LAYER ? null : layerRaw,
                    localUV: { u: f32[base + 13], v: f32[base + 14] },
                    texels: { t00: f32[base + 15], t10: f32[base + 16], t01: f32[base + 17], t11: f32[base + 18] },
                    bilinearHeightNorm: f32[base + 19],
                    bilinearHeightM: f32[base + 20],
                });
            }

            this._readbackState = 'idle';
            return out;
        }).catch((err) => {
            Logger.warn(`[LakeHeightProbe] resolve failed: ${err?.message || err}`);
            this._readbackState = 'idle';
            return null;
        });
    }

    _getTextureView(texture) {
        const gpuTexture = texture?._gpuTexture?.texture ?? texture;
        if (!gpuTexture?.createView) return null;
        return gpuTexture.createView({ dimension: '2d-array' });
    }

    _getGPUBuffer(buffer) {
        if (!buffer) return null;
        if (typeof buffer.mapAsync === 'function' || typeof buffer.destroy === 'function') return buffer;
        return buffer.buffer ?? null;
    }

    dispose() {
        this._paramsBuffer?.destroy();
        this._queryBuffer?.destroy();
        this._resultsBuffer?.destroy();
        this._readbackBuffer?.destroy();
    }
}
