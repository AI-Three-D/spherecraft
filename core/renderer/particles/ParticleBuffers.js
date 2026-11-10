// core/renderer/particles/ParticleBuffers.js
//
// Owns every GPU buffer the particle system needs:
//   - particlesA / particlesB  (ping-pong storage buffers)
//   - globalsUBO               (per-frame uniform)
//   - typeDefUBO               (uploaded once from particleConfig)
//   - indirectAdditive/Alpha/Bloom (GPU-written drawIndirect args)
//   - liveListAdditive/Alpha/Bloom (slot indices published by sim)
//   - spawnScratch             (atomic spawn claim counter)
//   - emitterData              (per-frame compact emitter spawn table)
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
export const EMITTER_DEF_STRIDE   = 80;   // matches WGSL EmitterSpawnDef (5 vec4s)
export const EMITTER_CAPACITY     = 96;
export const GLOBALS_UBO_SIZE     = 256;  // padded conservatively for uniform binding
export const INDIRECT_ARGS_SIZE   = 16;   // 4 u32
export const SPAWN_SCRATCH_SIZE   = 16;   // 1 atomic + pad

// Offsets inside GLOBALS_UBO (byte offsets). Kept in one place so the JS
// writer and the WGSL shader stay aligned.
export const GLOBALS_OFFSETS = {
    viewProj:                      0,    // mat4x4<f32>
    cameraRight_dt:                64,   // vec3 + f32
    cameraUp_time:                 80,
    planetOrigin_totalSpawnBudget: 96,   // vec3 + u32
    emitterCount:                  112,  // u32
    maxParticles:                  116,  // u32
    debugMode:                     120,  // u32 — 1 = oversized magenta debug particles
    flatWorld:                     124,  // u32 — 1 = use +Y up instead of planet origin
    fireflyGlow:                   128,  // f32 — daylight-relative firefly intensity scalar
    windDirX:                      132,  // f32 — world-space wind direction X
    windDirY:                      136,  // f32 — world-space wind direction Y (mapped from 2D)
    windSpeed:                     140,  // f32 — wind speed (m/s)
    leafLight:                     144,  // f32 — direct daylight visibility for non-emissive leaf particles
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
        this.indirectBloom = device.createBuffer({
            label: 'ParticleIndirect-Bloom',
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
        this.liveListBloom = device.createBuffer({
            label: 'ParticleLiveList-Bloom',
            size: liveListBytes,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        // ── spawn scratch (atomic claim counter) ──────────────────
        this.spawnScratch = device.createBuffer({
            label: 'ParticleSpawnScratch',
            size: SPAWN_SCRATCH_SIZE,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        // ── per-frame emitter spawn table ─────────────────────────
        this.emitterData = device.createBuffer({
            label: 'ParticleEmitterData',
            size: EMITTER_CAPACITY * EMITTER_DEF_STRIDE,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this._emitterStaging = new ArrayBuffer(EMITTER_CAPACITY * EMITTER_DEF_STRIDE);
        this._emitterF32 = new Float32Array(this._emitterStaging);
        this._emitterU32 = new Uint32Array(this._emitterStaging);

        // Pre-built "reset" templates for indirect args + scratch.
        this._indirectResetTemplate = new Uint32Array([6, 0, 0, 0]);
        this._spawnScratchResetTemplate = new Uint32Array([0, 0, 0, 0]);
    }

    // Reset only the live-list indirect draw counters. Called once per frame
    // before the single simulation dispatch.
    resetLiveLists() {
        const q = this.device.queue;
        q.writeBuffer(this.indirectAdditive, 0, this._indirectResetTemplate);
        q.writeBuffer(this.indirectAlpha,    0, this._indirectResetTemplate);
        q.writeBuffer(this.indirectBloom,    0, this._indirectResetTemplate);
    }

    // Reset the spawn-scratch atomic in the GPU command stream before the
    // per-frame simulation dispatch.
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
            if (entry.flags?.leaf)            flags |= PARTICLE_FLAGS.LEAF;
            const defaultBloomWeight = entry.bloomWeight ??
                (((entry.emissive ?? 1.0) > 1.0) ? 1.0 : 0.0);
            const bloomEnabled = entry.bloomEnabled ?? entry.bloom ?? (defaultBloomWeight > 0);
            const bloomWeight = bloomEnabled ? defaultBloomWeight : 0.0;
            if (bloomWeight > 1e-5) flags |= PARTICLE_FLAGS.BLOOM;
            u32[base + 23] = flags;

            // vec4 #6 — initial velocity ranges (X and Y)
            f32[base + 24] = entry.velocity?.x?.[0] ?? -0.1;
            f32[base + 25] = entry.velocity?.x?.[1] ??  0.1;
            f32[base + 26] = entry.velocity?.y?.[0] ??  0.1;
            f32[base + 27] = entry.velocity?.y?.[1] ??  0.5;

            // vec4 #7 — initial velocity range (Z) + emissive/bloom controls
            f32[base + 28] = entry.velocity?.z?.[0] ?? -0.1;
            f32[base + 29] = entry.velocity?.z?.[1] ??  0.1;
            f32[base + 30] = entry.emissive ?? 1.0;
            f32[base + 31] = bloomWeight;
        }

        this.device.queue.writeBuffer(this.typeDefUBO, 0, buf);
    }

    uploadEmitterData(emitters) {
        this._emitterF32.fill(0);
        this._emitterU32.fill(0);

        const count = Math.min(emitters.length, EMITTER_CAPACITY);
        for (let i = 0; i < count; i++) {
            const emitter = emitters[i];
            const base = (i * EMITTER_DEF_STRIDE) / 4;
            const position = emitter.position ?? [0, 0, 0];
            const weights = emitter.typeWeightsCumulative ?? [0, 0, 0, 0];
            const typeIds = emitter.typeIds ?? [0, 0, 0, 0];
            const localUp = emitter.localUp ?? [0, 1, 0];

            this._emitterF32[base + 0] = position[0] ?? 0;
            this._emitterF32[base + 1] = position[1] ?? 0;
            this._emitterF32[base + 2] = position[2] ?? 0;
            this._emitterU32[base + 3] = (emitter.spawnBudget ?? 0) >>> 0;

            this._emitterF32[base + 4] = weights[0] ?? 0;
            this._emitterF32[base + 5] = weights[1] ?? 0;
            this._emitterF32[base + 6] = weights[2] ?? 0;
            this._emitterF32[base + 7] = weights[3] ?? 0;

            this._emitterU32[base + 8]  = (typeIds[0] ?? 0) >>> 0;
            this._emitterU32[base + 9]  = (typeIds[1] ?? 0) >>> 0;
            this._emitterU32[base + 10] = (typeIds[2] ?? 0) >>> 0;
            this._emitterU32[base + 11] = (typeIds[3] ?? 0) >>> 0;

            this._emitterU32[base + 12] = (emitter.rngSeed ?? 0) >>> 0;
            this._emitterU32[base + 13] = (emitter.activeTypeCount ?? 0) >>> 0;
            const tint = emitter.foliageColor ?? [0, 0, 0];
            this._emitterF32[base + 14] = tint[0] ?? 0;
            this._emitterF32[base + 15] = tint[1] ?? 0;

            this._emitterF32[base + 16] = localUp[0] ?? 0;
            this._emitterF32[base + 17] = localUp[1] ?? 1;
            this._emitterF32[base + 18] = localUp[2] ?? 0;
            this._emitterF32[base + 19] = tint[2] ?? 0;
        }

        this.device.queue.writeBuffer(this.emitterData, 0, this._emitterF32.buffer);
    }

    // Writes a prepared globals block for the current frame.
    writeGlobals({
        viewProjMatrix,
        cameraRight, cameraUp,
        dt, time,
        planetOrigin = [0, 0, 0],
        totalSpawnBudget = 0,
        emitterCount = 0,
        debugMode = 0,
        flatWorld = 0,
        fireflyGlow = 1.0,
        leafLight = 1.0,
        windDirection = [0, 0],
        windSpeed = 0,
    }) {
        const f32 = this._globalsF32;
        const u32 = this._globalsU32;

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

        // planetOrigin + totalSpawnBudget
        f32[GLOBALS_OFFSETS.planetOrigin_totalSpawnBudget / 4 + 0] = planetOrigin[0] ?? 0;
        f32[GLOBALS_OFFSETS.planetOrigin_totalSpawnBudget / 4 + 1] = planetOrigin[1] ?? 0;
        f32[GLOBALS_OFFSETS.planetOrigin_totalSpawnBudget / 4 + 2] = planetOrigin[2] ?? 0;
        u32[GLOBALS_OFFSETS.planetOrigin_totalSpawnBudget / 4 + 3] = totalSpawnBudget >>> 0;

        u32[GLOBALS_OFFSETS.emitterCount / 4] = emitterCount >>> 0;
        u32[GLOBALS_OFFSETS.maxParticles / 4] = this.maxParticles >>> 0;
        u32[GLOBALS_OFFSETS.debugMode / 4] = debugMode >>> 0;
        u32[GLOBALS_OFFSETS.flatWorld / 4] = flatWorld >>> 0;
        f32[GLOBALS_OFFSETS.fireflyGlow / 4] = fireflyGlow;
        f32[GLOBALS_OFFSETS.windDirX / 4]   = windDirection[0] ?? 0;
        f32[GLOBALS_OFFSETS.windDirY / 4]   = windDirection[1] ?? 0;
        f32[GLOBALS_OFFSETS.windSpeed / 4]  = windSpeed;
        f32[GLOBALS_OFFSETS.leafLight / 4]  = leafLight;

        this.device.queue.writeBuffer(this.globalsUBO, 0, f32.buffer);
    }

    dispose() {
        this.particlesA?.destroy();
        this.particlesB?.destroy();
        this.globalsUBO?.destroy();
        this.typeDefUBO?.destroy();
        this.indirectAdditive?.destroy();
        this.indirectAlpha?.destroy();
        this.indirectBloom?.destroy();
        this.liveListAdditive?.destroy();
        this.liveListAlpha?.destroy();
        this.liveListBloom?.destroy();
        this.spawnScratch?.destroy();
        this.emitterData?.destroy();
    }
}
