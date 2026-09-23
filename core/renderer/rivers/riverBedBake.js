// core/renderer/rivers/riverBedBake.js
//
// Grid-dispatch adaptation of core/world/BiomeQuery.js: instead of resolving
// one world-space point per dispatch, bakes an entire river patch's bed
// heightfield (real sampled terrain height) in a single compute pass, using
// the same tile hash-table lookup the terrain renderer itself uses.

import { gpuFormatSampleType } from '../resources/texture.js';
import { Logger } from '../../../shared/Logger.js';
import { buildRiverBedBakeShader, RIVER_BED_BAKE_INVALID_SENTINEL } from './shaders/riverBedBakeShader.wgsl.js';

const PARAMS_BYTES = 96;

export class RiverBedBake {
    constructor(device, { gridW, gridL }) {
        this.device = device;
        this.gridW = gridW;
        this.gridL = gridL;
        this._byteLength = gridW * gridL * 4;

        this._pipeline = null;
        this._bgl = null;
        this._paramsBuffer = null;
        this._bedBuffer = null;
        this._readbackBuffer = null;
        this._readbackState = 'idle';
        this._initialized = false;
        this._loggedMissing = false;
    }

    initialize({ tileStreamer } = {}) {
        const code = buildRiverBedBakeShader();
        const module = this.device.createShaderModule({ label: 'RiverBedBake-SM', code });

        const heightFormat = tileStreamer?.textureFormats?.height || 'r32float';
        const heightSampleType = gpuFormatSampleType(heightFormat);

        this._bgl = this.device.createBindGroupLayout({
            label: 'RiverBedBake-BGL',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE,
                  texture: { sampleType: heightSampleType, viewDimension: '2d-array' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
            ],
        });

        this._pipeline = this.device.createComputePipeline({
            label: 'RiverBedBake-Pipeline',
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [this._bgl] }),
            compute: { module, entryPoint: 'main' },
        });

        this._paramsBuffer = this.device.createBuffer({
            label: 'RiverBedBake-Params',
            size: PARAMS_BYTES,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this._paramsArrayBuffer = new ArrayBuffer(PARAMS_BYTES);
        this._paramsF32 = new Float32Array(this._paramsArrayBuffer);
        this._paramsU32 = new Uint32Array(this._paramsArrayBuffer);

        this._bedBuffer = this.device.createBuffer({
            label: 'RiverBedBake-Bed',
            size: this._byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        });
        // Pre-fill with the invalid sentinel (not left zero-initialized) so
        // a compute dispatch that fails to run (e.g. a shader compile error)
        // reads back as clearly invalid instead of looking like a fully
        // "valid" bake of real zero heights — a genuine miscue this session.
        const invalidFill = new Float32Array(this._byteLength / 4).fill(RIVER_BED_BAKE_INVALID_SENTINEL);
        this.device.queue.writeBuffer(this._bedBuffer, 0, invalidFill);
        this._readbackBuffer = this.device.createBuffer({
            label: 'RiverBedBake-Readback',
            size: this._byteLength,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });

        // Debug-only: comprehensive raw dump for the center cell, plus one
        // unconditional sanity slot (see riverBedBakeShader.wgsl.js).
        // 36 x u32 = 144 bytes.
        this._debugBuffer = this.device.createBuffer({
            label: 'RiverBedBake-Debug',
            size: 144,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        });
        // 0xDEAD_BEEF sentinel so "never written" is visibly distinguishable
        // from any real computed value (0 included).
        this.device.queue.writeBuffer(this._debugBuffer, 0, new Uint32Array(36).fill(0xDEADBEEF));
        this._debugReadbackBuffer = this.device.createBuffer({
            label: 'RiverBedBake-DebugReadback',
            size: 144,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });

        // Atomic count of cells whose match was deep/precise enough to stop
        // retrying for — decoupled from bedOut's actual height data (see
        // riverBedBakeShader.wgsl.js). Zeroed before every dispatch, not
        // just at init, since it accumulates via atomicAdd across a single
        // dispatch's invocations.
        this._acceptableCountBuffer = this.device.createBuffer({
            label: 'RiverBedBake-AcceptableCount',
            size: 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });
        this._acceptableCountReadback = this.device.createBuffer({
            label: 'RiverBedBake-AcceptableCountReadback',
            size: 4,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });

        this._initialized = true;
    }

    /**
     * Dispatch a full-grid bed bake. Non-blocking.
     * @returns {boolean} true if dispatched.
     */
    dispatch(encoder, { origin, radius, heightScale, dx, patchAnchor, patchRight, patchForward, quadtreeGPU, tileStreamer }) {
        if (!this._initialized) return false;
        if (this._readbackState !== 'idle') return false;

        const heightTex = tileStreamer?.getArrayTextures?.()?.height;
        const hashBuf = quadtreeGPU?.getLoadedTileTableBuffer?.();
        const tView = this._getTextureView(heightTex);
        const hBuf = this._getGPUBuffer(hashBuf);
        if (!tView || !hBuf) {
            if (!this._loggedMissing) {
                const missing = [!tView ? 'height texture' : null, !hBuf ? 'hash table' : null].filter(Boolean).join(', ');
                Logger.warn(`[River] bed bake waiting on resources: ${missing}`);
                this._loggedMissing = true;
            }
            return false;
        }
        this._loggedMissing = false;

        const f32 = this._paramsF32; const u32 = this._paramsU32;
        f32[0] = origin.x; f32[1] = origin.y; f32[2] = origin.z; f32[3] = radius;
        f32[4] = heightScale;
        u32[5] = quadtreeGPU?.loadedTableMask ?? 0;
        u32[6] = quadtreeGPU?.loadedTableCapacity ?? 0;
        u32[7] = tileStreamer?.tileTextureSize ?? 1024;
        u32[8] = quadtreeGPU?.maxDepth ?? 12;
        u32[9] = this.gridW; u32[10] = this.gridL; f32[11] = dx;
        f32[12] = patchAnchor.x; f32[13] = patchAnchor.y; f32[14] = patchAnchor.z; f32[15] = 0;
        f32[16] = patchRight.x; f32[17] = patchRight.y; f32[18] = patchRight.z; f32[19] = 0;
        f32[20] = patchForward.x; f32[21] = patchForward.y; f32[22] = patchForward.z; f32[23] = 0;
        this.device.queue.writeBuffer(this._paramsBuffer, 0, this._paramsArrayBuffer);
        // Zero the atomic counter before every dispatch — it accumulates
        // via atomicAdd across this dispatch's invocations only.
        this.device.queue.writeBuffer(this._acceptableCountBuffer, 0, new Uint32Array([0]));

        const bindGroup = this.device.createBindGroup({
            label: 'RiverBedBake-BG',
            layout: this._bgl,
            entries: [
                { binding: 0, resource: { buffer: this._paramsBuffer } },
                { binding: 1, resource: tView },
                { binding: 2, resource: { buffer: hBuf } },
                { binding: 3, resource: { buffer: this._bedBuffer } },
                { binding: 4, resource: { buffer: this._debugBuffer } },
                { binding: 5, resource: { buffer: this._acceptableCountBuffer } },
            ],
        });

        const pass = encoder.beginComputePass({ label: 'RiverBedBake' });
        pass.setPipeline(this._pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(Math.ceil(this.gridW / 8), Math.ceil(this.gridL / 8));
        pass.end();

        encoder.copyBufferToBuffer(this._bedBuffer, 0, this._readbackBuffer, 0, this._byteLength);
        encoder.copyBufferToBuffer(this._debugBuffer, 0, this._debugReadbackBuffer, 0, 144);
        encoder.copyBufferToBuffer(this._acceptableCountBuffer, 0, this._acceptableCountReadback, 0, 4);
        this._readbackState = 'copied';
        return true;
    }

    /**
     * Resolve the last dispatched bake.
     * @returns {Promise<{bed: Float32Array, validCount: number, acceptableCount: number, total: number, debug: object}|null>}
     */
    resolve() {
        if (this._readbackState !== 'copied') return Promise.resolve(null);
        this._readbackState = 'mapping';
        return Promise.all([
            this._readbackBuffer.mapAsync(GPUMapMode.READ),
            this._debugReadbackBuffer.mapAsync(GPUMapMode.READ),
            this._acceptableCountReadback.mapAsync(GPUMapMode.READ),
        ]).then(() => {
            const range = this._readbackBuffer.getMappedRange(0, this._byteLength);
            const src = new Float32Array(range);
            const bed = new Float32Array(src.length);
            // validCount: cells with ANY real height (used only to report
            // how much of the patch resolved at all). acceptableCount
            // (below) is the depth/precision-gated count RiverSystem
            // actually uses to decide whether to keep retrying — see
            // riverBedBakeShader.wgsl.js for why these are separate.
            let validCount = 0;
            for (let i = 0; i < src.length; i++) {
                const v = src[i];
                if (v > RIVER_BED_BAKE_INVALID_SENTINEL + 1) {
                    bed[i] = v;
                    validCount++;
                } else {
                    bed[i] = 0;
                }
            }
            this._readbackBuffer.unmap();

            const acceptableCount = new Uint32Array(this._acceptableCountReadback.getMappedRange(0, 4).slice(0))[0];
            this._acceptableCountReadback.unmap();

            const dbgBuf = this._debugReadbackBuffer.getMappedRange(0, 144).slice(0);
            const dbgU32 = new Uint32Array(dbgBuf);
            const dbgF32 = new Float32Array(dbgBuf);
            this._debugReadbackBuffer.unmap();
            const debug = {
                gridW: dbgU32[0], gridL: dbgU32[1], maxDepth: dbgU32[2],
                hashMask: dbgU32[3], hashCapacity: dbgU32[4], tileTexSize: dbgU32[5],
                origin: { x: dbgF32[6], y: dbgF32[7], z: dbgF32[8] },
                heightScale: dbgF32[9], dx: dbgF32[10],
                patchAnchor: { x: dbgF32[11], y: dbgF32[12], z: dbgF32[13] },
                patchRight: { x: dbgF32[14], y: dbgF32[15], z: dbgF32[16] },
                patchForward: { x: dbgF32[17], y: dbgF32[18], z: dbgF32[19] },
                worldPos: { x: dbgF32[20], y: dbgF32[21], z: dbgF32[22] },
                dir: { x: dbgF32[23], y: dbgF32[24], z: dbgF32[25] },
                face: dbgU32[26], u: dbgF32[27], v: dbgF32[28],
                depth: dbgU32[29], layer: dbgU32[30], height: dbgF32[31],
                unconditionalSanityHex: dbgU32[32].toString(16),
            };

            this._readbackState = 'idle';
            return { bed, validCount, acceptableCount, total: src.length, debug };
        }).catch(() => {
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
        this._bedBuffer?.destroy();
        this._readbackBuffer?.destroy();
        this._debugBuffer?.destroy();
        this._debugReadbackBuffer?.destroy();
        this._acceptableCountBuffer?.destroy();
        this._acceptableCountReadback?.destroy();
    }
}
