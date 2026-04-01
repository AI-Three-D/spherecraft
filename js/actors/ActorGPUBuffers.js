// js/actors/ActorGPUBuffers.js
//
// GPU buffer pool for actors. Intent (CPU→GPU), state (GPU-resident,
// CPU-seeded), and a small readback ring for camera/anim feedback.

import { Logger } from '../config/Logger.js';

// Stride units are f32 indices (4 bytes each).
export const INTENT_STRIDE_F32 = 16;   // 64 bytes/actor
export const STATE_STRIDE_F32 = 16;    // 64 bytes/actor

// READBACK_STRIDE_F32 was 8, but readback must copy at STATE_STRIDE
// intervals since that's how the GPU shader writes the data. We keep
// this constant for documentation but don't use it for buffer sizing.
export const READBACK_STRIDE_F32 = 8;  // (pos.xyz, yaw, moveState, grounded, slope, pad)

export class ActorGPUBuffers {
    constructor(device, maxActors = 64) {
        this.device = device;
        this.maxActors = maxActors;
        this.activeCount = 0;

        // CPU staging
        this._intentF32 = new Float32Array(maxActors * INTENT_STRIDE_F32);
        this._intentU32 = new Uint32Array(this._intentF32.buffer);

        const intentBytes = Math.max(256, this._intentF32.byteLength);
        const stateBytes = Math.max(256, maxActors * STATE_STRIDE_F32 * 4);
        
        // FIX: Readback buffer must match state buffer stride, not the
        // smaller READBACK_STRIDE, because we copy directly from stateBuffer
        // which has actors spaced at STATE_STRIDE_F32 intervals.
        const readbackBytes = Math.max(256, maxActors * STATE_STRIDE_F32 * 4);

        this.intentBuffer = device.createBuffer({
            label: 'Actor-Intent',
            size: intentBytes,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        // GPU reads/writes; CPU seeds initial spawn; readback copies from it.
        this.stateBuffer = device.createBuffer({
            label: 'Actor-State',
            size: stateBytes,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });

        this.paramsBuffer = device.createBuffer({
            label: 'Actor-Params',
            size: 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        // Readback ring
        this._ring = [];
        this._ringIdx = 0;
        for (let i = 0; i < 3; i++) {
            this._ring.push({
                buffer: device.createBuffer({
                    label: `Actor-Readback-${i}`,
                    size: readbackBytes,
                    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
                }),
                state: 'idle',       // idle | copied | mapping
                copiedCount: 0,      // FIX: track count at copy time
            });
        }

        Logger.info(`[ActorGPUBuffers] created for ${maxActors} actors`);
    }

    writeIntent(slot, flags, yaw, speed, dt, target, maxSlope, collisionRadius) {
        const b = slot * INTENT_STRIDE_F32;
        this._intentU32[b + 0] = flags >>> 0;
        this._intentF32[b + 1] = yaw;
        this._intentF32[b + 2] = speed;
        this._intentF32[b + 3] = dt;
        this._intentF32[b + 4] = target?.x ?? 0;
        this._intentF32[b + 5] = target?.y ?? 0;
        this._intentF32[b + 6] = target?.z ?? 0;
        this._intentF32[b + 7] = maxSlope;
        this._intentF32[b + 8] = collisionRadius;
    }

    uploadIntents() {
        if (this.activeCount <= 0) return;
        this.device.queue.writeBuffer(
            this.intentBuffer, 0,
            this._intentF32.buffer, 0,
            this.activeCount * INTENT_STRIDE_F32 * 4
        );
    }

    seedState(slot, x, y, z, yaw) {
        const d = new Float32Array(STATE_STRIDE_F32);
        d[0] = x; d[1] = y; d[2] = z; d[3] = yaw;
        d[5] = 0; // grounded = 0 (not yet resolved)
        this.device.queue.writeBuffer(this.stateBuffer, slot * STATE_STRIDE_F32 * 4, d);
    }

    uploadParams(planetConfig, quadtreeGPU, tileTexSize, collisionCfg = {}) {
        const buf = new ArrayBuffer(256);
        const f32 = new Float32Array(buf);
        const u32 = new Uint32Array(buf);
        const o = planetConfig.origin || { x: 0, y: 0, z: 0 };
        f32[0] = o.x; f32[1] = o.y; f32[2] = o.z;
        f32[3] = planetConfig.radius;
        f32[4] = planetConfig.heightScale ?? planetConfig.maxTerrainHeight ?? 1000;
        f32[5] = quadtreeGPU?.faceSize ?? (planetConfig.radius * 2);
        u32[6] = quadtreeGPU?.loadedTableMask ?? 0;
        u32[7] = quadtreeGPU?.loadedTableCapacity ?? 0;
        u32[8] = tileTexSize >>> 0;
        u32[9] = this.activeCount >>> 0;
        u32[10] = (quadtreeGPU?.maxDepth ?? 12) >>> 0;
        u32[11] = (collisionCfg.maxColliders ?? 0) >>> 0;
        f32[12] = collisionCfg.trunkRadiusScale ?? 0.08;
        f32[13] = collisionCfg.trunkRadiusMin ?? 0.35;

        this.device.queue.writeBuffer(this.paramsBuffer, 0, buf);
    }

    beginReadback(encoder) {
        if (this.activeCount <= 0) return;
        // Find an idle slot
        for (let i = 0; i < this._ring.length; i++) {
            const idx = (this._ringIdx + i) % this._ring.length;
            if (this._ring[idx].state === 'idle') {
                const slot = this._ring[idx];
                this._ringIdx = (idx + 1) % this._ring.length;
                
                // FIX: Copy at STATE_STRIDE intervals (how GPU wrote the data)
                const bytes = this.activeCount * STATE_STRIDE_F32 * 4;
                encoder.copyBufferToBuffer(this.stateBuffer, 0, slot.buffer, 0, bytes);
                
                slot.copiedCount = this.activeCount;  // FIX: remember count at copy time
                slot.state = 'copied';
                return;
            }
        }
    }

    resolveReadback(callback) {
        for (const slot of this._ring) {
            if (slot.state !== 'copied') continue;
            slot.state = 'mapping';
            
            const countAtCopy = slot.copiedCount;  // FIX: use count from copy time
            
            slot.buffer.mapAsync(GPUMapMode.READ).then(() => {
                try {
                    // FIX: Read at STATE_STRIDE intervals to match GPU layout
                    const bytes = countAtCopy * STATE_STRIDE_F32 * 4;
                    const view = new Float32Array(slot.buffer.getMappedRange(0, bytes));
                    const out = [];
                    for (let i = 0; i < countAtCopy; i++) {
                        const b = i * STATE_STRIDE_F32;  // FIX: was READBACK_STRIDE_F32
                        out.push({
                            x: view[b], y: view[b + 1], z: view[b + 2],
                            yaw: view[b + 3],
                            moveState: view[b + 4],
                            grounded: view[b + 5] > 0.5,
                            slope: view[b + 6],
                        });
                    }
                    slot.buffer.unmap();
                    slot.state = 'idle';
                    callback(out);
                } catch (e) {
                    try { slot.buffer.unmap(); } catch (_) {}
                    slot.state = 'idle';
                }
            }).catch(() => { slot.state = 'idle'; });
        }
    }

    dispose() {
        this.intentBuffer?.destroy();
        this.stateBuffer?.destroy();
        this.paramsBuffer?.destroy();
        for (const s of this._ring) s.buffer?.destroy();
    }
}