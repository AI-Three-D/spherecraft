// core/actors/ActorGPUBuffers.js
//
// GPU buffer pool for spherical-planet actors. Intent (CPU→GPU),
// state (GPU-resident, CPU-seeded), and a small readback ring so the
// CPU can drive camera follow + animation state + fall-damage events.
//
// The stride of each pool is 16 f32s (64 bytes). New fields appended
// at the tail so older games still work without changes.

import { Logger } from '../../shared/Logger.js';

export const INTENT_STRIDE_F32 = 16;
export const STATE_STRIDE_F32  = 16;
// READBACK_STRIDE is historical; the copy uses STATE_STRIDE so the GPU
// layout and CPU view match.
export const READBACK_STRIDE_F32 = STATE_STRIDE_F32;

export class ActorGPUBuffers {
    constructor(device, maxActors = 64) {
        this.device = device;
        this.maxActors = maxActors;
        this.activeCount = 0;

        this._intentF32 = new Float32Array(maxActors * INTENT_STRIDE_F32);
        this._intentU32 = new Uint32Array(this._intentF32.buffer);

        const intentBytes = Math.max(256, this._intentF32.byteLength);
        const stateBytes = Math.max(256, maxActors * STATE_STRIDE_F32 * 4);
        const readbackBytes = Math.max(256, maxActors * STATE_STRIDE_F32 * 4);

        this.intentBuffer = device.createBuffer({
            label: 'Actor-Intent',
            size: intentBytes,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

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

        this._ring = [];
        this._ringIdx = 0;
        for (let i = 0; i < 3; i++) {
            this._ring.push({
                buffer: device.createBuffer({
                    label: `Actor-Readback-${i}`,
                    size: readbackBytes,
                    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
                }),
                state: 'idle',
                copiedCount: 0,
            });
        }

        Logger.info(`[ActorGPUBuffers] created for ${maxActors} actors`);
    }

    /**
     * Write an actor's per-frame intent. Extra physics fields are
     * optional; sensible defaults let legacy callers keep working.
     */
    // jumpVelocity: m/s applied on F_JUMP edge when grounded.
    // gravityScale: 0 = legacy terrain-snap mode (no vertical physics);
    //               1 = full physics; <1 = anti-gravity fruit effect.
    writeIntent(slot, flags, yaw, speed, dt, target, maxSlope, collisionRadius,
                jumpVelocity = 0, gravityScale = 0) {
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
        this._intentF32[b + 9] = jumpVelocity;
        this._intentF32[b + 10] = gravityScale;
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
        d[5] = 0;  // grounded=0 until resolver confirms
        // vertVel, airTime, peakFall, lastImpact, altitude all start 0
        this.device.queue.writeBuffer(this.stateBuffer, slot * STATE_STRIDE_F32 * 4, d);
    }

    /**
     * Upload per-frame params. collisionCfg fields:
     *   maxColliders, trunkRadiusScale, trunkRadiusMin,
     *   gravity (m/s²), maxPlatforms, groundStickSpeed
     */
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
        f32[14] = collisionCfg.gravity ?? 9.81;
        u32[15] = (collisionCfg.maxPlatforms ?? 0) >>> 0;
        f32[16] = collisionCfg.groundStickSpeed ?? 0.05;

        this.device.queue.writeBuffer(this.paramsBuffer, 0, buf);
    }

    beginReadback(encoder) {
        if (this.activeCount <= 0) return;
        for (let i = 0; i < this._ring.length; i++) {
            const idx = (this._ringIdx + i) % this._ring.length;
            if (this._ring[idx].state === 'idle') {
                const slot = this._ring[idx];
                this._ringIdx = (idx + 1) % this._ring.length;
                const bytes = this.activeCount * STATE_STRIDE_F32 * 4;
                encoder.copyBufferToBuffer(this.stateBuffer, 0, slot.buffer, 0, bytes);
                slot.copiedCount = this.activeCount;
                slot.state = 'copied';
                return;
            }
        }
    }

    resolveReadback(callback) {
        for (const slot of this._ring) {
            if (slot.state !== 'copied') continue;
            slot.state = 'mapping';
            const countAtCopy = slot.copiedCount;
            slot.buffer.mapAsync(GPUMapMode.READ).then(() => {
                try {
                    const bytes = countAtCopy * STATE_STRIDE_F32 * 4;
                    const view = new Float32Array(slot.buffer.getMappedRange(0, bytes));
                    const out = [];
                    for (let i = 0; i < countAtCopy; i++) {
                        const b = i * STATE_STRIDE_F32;
                        out.push({
                            x: view[b], y: view[b + 1], z: view[b + 2],
                            yaw: view[b + 3],
                            moveState: view[b + 4],
                            grounded: view[b + 5] > 0.5,
                            slope: view[b + 6],
                            vertVel:       view[b + 7],
                            airTime:       view[b + 8],
                            peakFallSpeed: view[b + 9],
                            lastImpactSpeed: view[b + 10],
                            altitude:      view[b + 11],
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
