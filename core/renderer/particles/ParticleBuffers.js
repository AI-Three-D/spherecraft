// core/renderer/particles/ParticleBuffers.js
//
// Owns every GPU buffer the particle system needs:
//   - particlesA / particlesB  (ping-pong storage buffers)
//   - globalsUBO               (per-frame uniform)
//   - typeDefUBO               (uploaded once from particleConfig)
//   - indirectAdditive/Alpha   (GPU-written drawIndirect args)
//   - liveListAdditive/Alpha   (slot indices published by sim)
//   - spawnScratch             (atomic spawn claim counter)
//
// Also exposes matching bind-group-layout slot sizes so the pass classes
// can build their own layouts consistently.

import {
    PARTICLE_TYPES,
    PARTICLE_TYPE_CAPACITY,
    PARTICLE_FLAGS,
} from './ParticleTypes.js';

// ─── GPU-visible struct sizes (bytes) ───────────────────────────────
export const PARTICLE_STRIDE      = 64;   // matches WGSL Particle
export const TYPE_DEF_STRIDE      = 128;  // matches WGSL ParticleTypeDef (8 vec4s)
export const GLOBALS_UBO_SIZE     = 256;  // padded: mat4 (64) + 6*vec4 (96) = 160 -> 256
export const INDIRECT_ARGS_SIZE   = 16;   // 4 u32
export const SPAWN_SCRATCH_SIZE   = 16;   // 1 atomic + pad

// Offsets inside GLOBALS_UBO (byte offsets). Kept in one place so the JS
// writer and the WGSL shader stay aligned.
export const GLOBALS_OFFSETS = {
    viewProj:              0,    // mat4x4<f32>
    cameraRight_dt:        64,   // vec3 + f32
    cameraUp_time:         80,
    emitterPos_budget:     96,
    typeWeightsCumulative: 112,  // vec4<f32>
    typeIds:               128,  // vec4<u32>
    rngSeed:               144,  // u32
    maxParticles:          148,  // u32
    activeTypeCount:       152,  // u32
    debugMode:             156,  // u32 — 1 = oversized magenta debug particles
    localUp:               160,  // vec3<f32> — emitter's local "up" on planet
    _pad6:                 172,  // f32 — pad to 176
};

export class ParticleBuffers {
    constructor(device, { maxParticles }) {
        this.device = device;
        this.maxParticles = maxParticles;
        this.frameIndex = 0;   // ping-pong counter

        // ── ping-pong particle storage ────────────────────────────
        const particleBytes = maxParticles * PARTICLE_STRIDE;

        this.particlesA = device.createBuffer({
            label: 'ParticleBuffer-A',
            size: particleBytes,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true,
        });
        new Uint8Array(this.particlesA.getMappedRange()).fill(0);
        this.particlesA.unmap();

        this.particlesB = device.createBuffer({
            label: 'ParticleBuffer-B',
            size: particleBytes,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true,
        });
        new Uint8Array(this.particlesB.getMappedRange()).fill(0);
        this.particlesB.unmap();

        // ── per-frame globals UBO ─────────────────────────────────
        this.globalsUBO = device.createBuffer({
            label: 'ParticleGlobalsUBO',
            size: GLOBALS_UBO_SIZE,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this._globalsStaging = new ArrayBuffer(GLOBALS_UBO_SIZE);
        this._globalsF32 = new Float32Array(this._globalsStaging);
        this._globalsU32 = new Uint32Array(this._globalsStaging);

        // ── type-def UBO (fixed capacity, uploaded once) ──────────
        this.typeDefUBO = device.createBuffer({
            label: 'ParticleTypeDefUBO',
            size: PARTICLE_TYPE_CAPACITY * TYPE_DEF_STRIDE,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        // ── indirect draw args (GPU-written) ──────────────────────
        // Layout: [vertexCount, instanceCount, firstVertex, firstInstance]
        // vertexCount = 6 (two triangles per quad)
        this.indirectAdditive = device.createBuffer({
            label: 'ParticleIndirect-Additive',
            size: INDIRECT_ARGS_SIZE,
            usage: GPUBufferUsage.STORAGE
                 | GPUBufferUsage.INDIRECT
                 | GPUBufferUsage.COPY_DST,
        });
        this.indirectAlpha = device.createBuffer({
            label: 'ParticleIndirect-Alpha',
            size: INDIRECT_ARGS_SIZE,
            usage: GPUBufferUsage.STORAGE
                 | GPUBufferUsage.INDIRECT
                 | GPUBufferUsage.COPY_DST,
        });

        // ── live-list index buffers (slot indices) ────────────────
        const liveListBytes = maxParticles * 4;
        this.liveListAdditive = device.createBuffer({
            label: 'ParticleLiveList-Additive',
            size: liveListBytes,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this.liveListAlpha = device.createBuffer({
            label: 'ParticleLiveList-Alpha',
            size: liveListBytes,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        // ── spawn scratch (atomic claim counter) ──────────────────
        this.spawnScratch = device.createBuffer({
            label: 'ParticleSpawnScratch',
            size: SPAWN_SCRATCH_SIZE,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        // Pre-built "reset" templates for indirect args + scratch.
        this._indirectResetTemplate = new Uint32Array([6, 0, 0, 0]);
        this._spawnScratchResetTemplate = new Uint32Array([0, 0, 0, 0]);
    }

    // Reset only the live-list indirect draw counters. Called ONCE per frame,
    // before any emitter dispatches, via CPU-side writeBuffer.
    resetLiveLists() {
        const q = this.device.queue;
        q.writeBuffer(this.indirectAdditive, 0, this._indirectResetTemplate);
        q.writeBuffer(this.indirectAlpha,    0, this._indirectResetTemplate);
    }

    // Reset the spawn-scratch atomic in the GPU command stream so that each
    // emitter dispatch gets a fresh claim counter regardless of execution order.
    // Must be called with the command encoder BEFORE each emitter's dispatch.
    clearSpawnScratch(commandEncoder) {
        commandEncoder.clearBuffer(this.spawnScratch, 0, SPAWN_SCRATCH_SIZE);
    }

    // Legacy single-emitter helper kept for backward compatibility.
    resetPerFrameCounters() {
        this.resetLiveLists();
        const q = this.device.queue;
        q.writeBuffer(this.spawnScratch, 0, this._spawnScratchResetTemplate);
    }

    // Returns { read, write } for this frame's ping-pong orientation.
    getPingPong() {
        return (this.frameIndex & 1) === 0
            ? { read: this.particlesA, write: this.particlesB }
            : { read: this.particlesB, write: this.particlesA };
    }

    advancePingPong() { this.frameIndex++; }

    // Uploads the type-def table from particleConfig.js in the order implied
    // by the numeric IDs of PARTICLE_TYPES.
    uploadTypeDefs(config) {
        const buf = new ArrayBuffer(PARTICLE_TYPE_CAPACITY * TYPE_DEF_STRIDE);
        const f32 = new Float32Array(buf);
        const u32 = new Uint32Array(buf);

        for (const [/* name */, id] of Object.entries(PARTICLE_TYPES)) {
            const entry = config[id];
            if (!entry) continue;

            const base = (id * TYPE_DEF_STRIDE) / 4; // stride in f32 words

            // vec4 #0 — kinematics
            f32[base + 0] = entry.gravity ?? 0;
            f32[base + 1] = entry.drag ?? 0;
            f32[base + 2] = entry.upwardBias ?? 0;
            f32[base + 3] = entry.lateralNoise ?? 0;

            // vec4 #1 — life + size
            f32[base + 4] = entry.lifetime?.min ?? 1.0;
            f32[base + 5] = entry.lifetime?.max ?? 1.0;
            f32[base + 6] = entry.size?.start   ?? 0.1;
            f32[base + 7] = entry.size?.end     ?? 0.1;

            // vec4 #2..#4 — gradient
            const cS = entry.colorStart ?? [1,1,1,1];
            const cM = entry.colorMid   ?? cS;
            const cE = entry.colorEnd   ?? [0,0,0,0];
            f32.set(cS, base +  8);
            f32.set(cM, base + 12);
            f32.set(cE, base + 16);

            // vec4 #5 — spawn offset + flags
            f32[base + 20] = entry.spawnOffset?.radius    ?? 0;
            f32[base + 21] = entry.spawnOffset?.heightMin ?? 0;
            f32[base + 22] = entry.spawnOffset?.heightMax ?? 0;

            let flags = 0;
            if (entry.blend === 'additive')   flags |= PARTICLE_FLAGS.ADDITIVE;
            if (entry.flags?.stretchAlongVel) flags |= PARTICLE_FLAGS.STRETCH_VEL;
            if (entry.flags?.rotate)          flags |= PARTICLE_FLAGS.ROTATE;
            u32[base + 23] = flags;

            // vec4 #6 — initial velocity ranges (X and Y)
            f32[base + 24] = entry.velocity?.x?.[0] ?? -0.1;
            f32[base + 25] = entry.velocity?.x?.[1] ??  0.1;
            f32[base + 26] = entry.velocity?.y?.[0] ??  0.1;
            f32[base + 27] = entry.velocity?.y?.[1] ??  0.5;

            // vec4 #7 — initial velocity range (Z) + emissive
            f32[base + 28] = entry.velocity?.z?.[0] ?? -0.1;
            f32[base + 29] = entry.velocity?.z?.[1] ??  0.1;
            f32[base + 30] = entry.emissive ?? 1.0;
            f32[base + 31] = 0;
        }

        this.device.queue.writeBuffer(this.typeDefUBO, 0, buf);
    }

    // Creates a per-emitter globals UBO (256 B) with its own staging arrays.
    // Store the returned object on the emitter; pass it as `target` to writeGlobals.
    createEmitterGlobalsTarget(label = 'emitter') {
        const ubo = this.device.createBuffer({
            label: `ParticleGlobalsUBO-${label}`,
            size: GLOBALS_UBO_SIZE,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        const staging = new ArrayBuffer(GLOBALS_UBO_SIZE);
        return { ubo, f32: new Float32Array(staging), u32: new Uint32Array(staging) };
    }

    // Writes a prepared globals block for the current frame.
    // `target` is an optional { ubo, f32, u32 } created by createEmitterGlobalsTarget.
    // When omitted, writes to the shared globalsUBO.
    writeGlobals({
        viewProjMatrix,
        cameraRight, cameraUp,
        dt, time,
        emitterPos,
        spawnBudget,
        typeWeightsCumulative,
        typeIds,
        rngSeed,
        activeTypeCount,
        debugMode = 0,
        localUp = [0, 1, 0],
    }, target = null) {
        const f32 = target ? target.f32 : this._globalsF32;
        const u32 = target ? target.u32 : this._globalsU32;
        const ubo = target ? target.ubo : this.globalsUBO;

        // mat4 view*proj (column-major, 16 floats)
        f32.set(viewProjMatrix, GLOBALS_OFFSETS.viewProj / 4);

        // cameraRight + dt
        f32[GLOBALS_OFFSETS.cameraRight_dt / 4 + 0] = cameraRight[0];
        f32[GLOBALS_OFFSETS.cameraRight_dt / 4 + 1] = cameraRight[1];
        f32[GLOBALS_OFFSETS.cameraRight_dt / 4 + 2] = cameraRight[2];
        f32[GLOBALS_OFFSETS.cameraRight_dt / 4 + 3] = dt;

        // cameraUp + time
        f32[GLOBALS_OFFSETS.cameraUp_time / 4 + 0] = cameraUp[0];
        f32[GLOBALS_OFFSETS.cameraUp_time / 4 + 1] = cameraUp[1];
        f32[GLOBALS_OFFSETS.cameraUp_time / 4 + 2] = cameraUp[2];
        f32[GLOBALS_OFFSETS.cameraUp_time / 4 + 3] = time;

        // emitterPos + spawnBudget (u32)
        f32[GLOBALS_OFFSETS.emitterPos_budget / 4 + 0] = emitterPos[0];
        f32[GLOBALS_OFFSETS.emitterPos_budget / 4 + 1] = emitterPos[1];
        f32[GLOBALS_OFFSETS.emitterPos_budget / 4 + 2] = emitterPos[2];
        u32[GLOBALS_OFFSETS.emitterPos_budget / 4 + 3] = spawnBudget >>> 0;

        // cumulative weights vec4
        const w = typeWeightsCumulative;
        f32[GLOBALS_OFFSETS.typeWeightsCumulative / 4 + 0] = w[0] ?? 0;
        f32[GLOBALS_OFFSETS.typeWeightsCumulative / 4 + 1] = w[1] ?? 0;
        f32[GLOBALS_OFFSETS.typeWeightsCumulative / 4 + 2] = w[2] ?? 0;
        f32[GLOBALS_OFFSETS.typeWeightsCumulative / 4 + 3] = w[3] ?? 0;

        // type IDs vec4<u32>
        u32[GLOBALS_OFFSETS.typeIds / 4 + 0] = (typeIds[0] ?? 0) >>> 0;
        u32[GLOBALS_OFFSETS.typeIds / 4 + 1] = (typeIds[1] ?? 0) >>> 0;
        u32[GLOBALS_OFFSETS.typeIds / 4 + 2] = (typeIds[2] ?? 0) >>> 0;
        u32[GLOBALS_OFFSETS.typeIds / 4 + 3] = (typeIds[3] ?? 0) >>> 0;

        // scalars
        u32[GLOBALS_OFFSETS.rngSeed        / 4] = rngSeed >>> 0;
        u32[GLOBALS_OFFSETS.maxParticles   / 4] = this.maxParticles >>> 0;
        u32[GLOBALS_OFFSETS.activeTypeCount/ 4] = activeTypeCount >>> 0;
        u32[GLOBALS_OFFSETS.debugMode      / 4] = debugMode >>> 0;

        // localUp vec3
        f32[GLOBALS_OFFSETS.localUp / 4 + 0] = localUp[0];
        f32[GLOBALS_OFFSETS.localUp / 4 + 1] = localUp[1];
        f32[GLOBALS_OFFSETS.localUp / 4 + 2] = localUp[2];
        f32[GLOBALS_OFFSETS._pad6   / 4]     = 0;

        this.device.queue.writeBuffer(ubo, 0, f32.buffer);
    }

    dispose() {
        this.particlesA?.destroy();
        this.particlesB?.destroy();
        this.globalsUBO?.destroy();
        this.typeDefUBO?.destroy();
        this.indirectAdditive?.destroy();
        this.indirectAlpha?.destroy();
        this.liveListAdditive?.destroy();
        this.liveListAlpha?.destroy();
        this.spawnScratch?.destroy();
    }
}
