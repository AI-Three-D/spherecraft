// core/actors/PlatformColliderSystem.js
//
// CPU-managed GPU buffer of "platform" top-surface colliders consumed
// by MovementResolverPipeline (bindings 8 & 9). Generic — any game can
// use it for floating platforms, moving crates, etc. Not specific to
// the cloud platforms in platform_game.
//
// Layout (matches CLOSE_PLATFORM_STRIDE = 16 f32 in the WGSL):
//   [0..2] pos.xyz       — world position of the platform TOP-surface center
//   [3]    radius        — disc radius in the platform's tangent plane (m)
//   [4]    thickness     — vertical band below the top surface that still
//                          counts as "on top" (prevents jitter)
//   [5..7] velocity.xyz  — optional drift velocity (reserved; not yet consumed)
//   [8..15] reserved     — room to grow without changing the stride
//
// The buffer is written in full each frame from a JS Float32Array; only
// the first `count` entries are read by the GPU.

import { Logger } from '../../shared/Logger.js';

export const PLATFORM_COLLIDER_STRIDE_F32 = 16;

export class PlatformColliderSystem {
    /**
     * @param {GPUDevice} device
     * @param {number} maxColliders
     */
    constructor(device, maxColliders = 128) {
        this.device = device;
        this.maxColliders = maxColliders;
        this._count = 0;

        this._cpu = new Float32Array(maxColliders * PLATFORM_COLLIDER_STRIDE_F32);

        this._buffer = device.createBuffer({
            label: 'PlatformColliders',
            size: Math.max(256, this._cpu.byteLength),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this._countBuffer = device.createBuffer({
            label: 'PlatformColliders-Count',
            size: 16,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(this._countBuffer, 0, new Uint32Array([0]));

        Logger.info(`[PlatformColliderSystem] created (cap=${maxColliders})`);
    }

    beginFrame() { this._count = 0; }

    /**
     * Add one platform for the current frame. Caller should call
     * beginFrame() at the start of each frame and upload() after.
     *
     * @param {{x:number,y:number,z:number}} topPos  — top-surface center
     * @param {number} radius
     * @param {number} [thickness=1.5]
     * @param {{x:number,y:number,z:number}} [velocity]
     */
    add(topPos, radius, thickness = 1.5, velocity = null) {
        if (this._count >= this.maxColliders) return false;
        const b = this._count * PLATFORM_COLLIDER_STRIDE_F32;
        this._cpu[b + 0] = topPos.x;
        this._cpu[b + 1] = topPos.y;
        this._cpu[b + 2] = topPos.z;
        this._cpu[b + 3] = radius;
        this._cpu[b + 4] = thickness;
        this._cpu[b + 5] = velocity?.x ?? 0;
        this._cpu[b + 6] = velocity?.y ?? 0;
        this._cpu[b + 7] = velocity?.z ?? 0;
        this._count++;
        return true;
    }

    /** Upload the frame's colliders to the GPU. */
    upload() {
        const bytes = this._count * PLATFORM_COLLIDER_STRIDE_F32 * 4;
        if (bytes > 0) {
            this.device.queue.writeBuffer(this._buffer, 0, this._cpu.buffer, 0, bytes);
        }
        this.device.queue.writeBuffer(this._countBuffer, 0, new Uint32Array([this._count]));
    }

    get count() { return this._count; }
    getColliderBuffer() { return this._buffer; }
    getColliderCountBuffer() { return this._countBuffer; }

    dispose() {
        this._buffer?.destroy();
        this._countBuffer?.destroy();
    }
}
