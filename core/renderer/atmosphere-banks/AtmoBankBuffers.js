import {
    ATMO_BANK_TYPES, ATMO_TYPE_CAPACITY, ATMO_EMITTER_CAPACITY,
    ATMO_MAX_PARTICLES, ATMO_PARTICLE_STRIDE, ATMO_TYPE_DEF_STRIDE,
    ATMO_EMITTER_STRIDE, ATMO_GLOBALS_SIZE, ATMO_INDIRECT_SIZE, ATMO_SCRATCH_SIZE,
    ATMO_VERTICES_PER_PARTICLE,
} from './AtmoBankTypes.js';

const GLOBALS_OFFSETS = {
    viewProj:           0,
    cameraRight_dt:     64,
    cameraUp_time:      80,
    cameraPos_budget:   96,
    planetOrigin_emCnt: 112,
    maxParticles:       128,
    windDirX:           132,
    windDirY:           136,
    windSpeed:          140,
    maxRenderDist:      144,
    nearPlane:          148,
    farPlane:           152,
    sunDirection_visibility: 160,
    sunColor_ambient:        176,
    ambientColor_moon:       192,
};

export class AtmoBankBuffers {
    constructor(device, { maxParticles = ATMO_MAX_PARTICLES } = {}) {
        this.device = device;
        this.maxParticles = maxParticles;
        this.frameIndex = 0;

        const pBytes = maxParticles * ATMO_PARTICLE_STRIDE;
        const mkBuf = (label, size, usage) => {
            const b = device.createBuffer({ label, size, usage, mappedAtCreation: true });
            new Uint8Array(b.getMappedRange()).fill(0);
            b.unmap();
            return b;
        };
        const STOR = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;

        this.particlesA = mkBuf('AtmoBank-A', pBytes, STOR);
        this.particlesB = mkBuf('AtmoBank-B', pBytes, STOR);

        this.globalsUBO = device.createBuffer({
            label: 'AtmoBankGlobals', size: ATMO_GLOBALS_SIZE,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this._gF32 = new Float32Array(ATMO_GLOBALS_SIZE / 4);
        this._gU32 = new Uint32Array(this._gF32.buffer);

        this.typeDefUBO = device.createBuffer({
            label: 'AtmoBankTypeDefs', size: ATMO_TYPE_CAPACITY * ATMO_TYPE_DEF_STRIDE,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this.indirect = device.createBuffer({
            label: 'AtmoBankIndirect', size: ATMO_INDIRECT_SIZE,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
        });

        this.liveList = device.createBuffer({
            label: 'AtmoBankLiveList', size: maxParticles * 4,
            usage: STOR,
        });

        this.spawnScratch = device.createBuffer({
            label: 'AtmoBankScratch', size: ATMO_SCRATCH_SIZE,
            usage: STOR,
        });

        this.emitterData = device.createBuffer({
            label: 'AtmoBankEmitters', size: ATMO_EMITTER_CAPACITY * ATMO_EMITTER_STRIDE,
            usage: STOR,
        });
        this.emitterCounter = device.createBuffer({
            label: 'AtmoBankEmitterCounter',
            size: 16,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this._eF32 = new Float32Array(ATMO_EMITTER_CAPACITY * ATMO_EMITTER_STRIDE / 4);
        this._eU32 = new Uint32Array(this._eF32.buffer);
        this._emitterCounterData = new Uint32Array(4);

        this._indirectReset = new Uint32Array([ATMO_VERTICES_PER_PARTICLE, 0, 0, 0]);
    }

    resetLiveList() {
        this.device.queue.writeBuffer(this.indirect, 0, this._indirectReset);
    }

    clearSpawnScratch(commandEncoder) {
        commandEncoder.clearBuffer(this.spawnScratch, 0, ATMO_SCRATCH_SIZE);
    }

    getPingPong() {
        return (this.frameIndex & 1) === 0
            ? { read: this.particlesA, write: this.particlesB }
            : { read: this.particlesB, write: this.particlesA };
    }

    advancePingPong() { this.frameIndex++; }

    uploadTypeDefs(config) {
        const buf = new Float32Array(ATMO_TYPE_CAPACITY * ATMO_TYPE_DEF_STRIDE / 4);
        for (const [, id] of Object.entries(ATMO_BANK_TYPES)) {
            const e = config[id];
            if (!e) continue;
            const b = (id * ATMO_TYPE_DEF_STRIDE) / 4;
            buf[b + 0] = e.noiseScale ?? 0.01;
            buf[b + 1] = e.noiseSpeed ?? 0.02;
            buf[b + 2] = e.densityBase ?? 0.5;
            buf[b + 3] = e.windResponse ?? 0.1;
            buf[b + 4] = e.lifetime?.min ?? 30;
            buf[b + 5] = e.lifetime?.max ?? 90;
            buf[b + 6] = e.size?.min ?? 20;
            buf[b + 7] = e.size?.max ?? 80;
            const c = e.color ?? [0.8, 0.8, 0.85, 0.5];
            buf[b + 8] = c[0]; buf[b + 9] = c[1]; buf[b + 10] = c[2]; buf[b + 11] = c[3];
            buf[b + 12] = e.fadeNearStart ?? 15;
            buf[b + 13] = e.fadeFarStart ?? 1000;
            buf[b + 14] = e.fadeFarEnd ?? 2000;
            buf[b + 15] = e.densityThreshold ?? 0.35;
        }
        this.device.queue.writeBuffer(this.typeDefUBO, 0, buf);
    }

    uploadEmitterData(emitters) {
        this._eF32.fill(0);
        this._eU32.fill(0);
        const count = Math.min(emitters.length, ATMO_EMITTER_CAPACITY);
        for (let i = 0; i < count; i++) {
            const em = emitters[i];
            const b = (i * ATMO_EMITTER_STRIDE) / 4;
            this._eF32[b + 0] = em.position[0] ?? 0;
            this._eF32[b + 1] = em.position[1] ?? 0;
            this._eF32[b + 2] = em.position[2] ?? 0;
            this._eU32[b + 3] = (em.spawnBudget ?? 0) >>> 0;
            this._eF32[b + 4] = em.localUp[0] ?? 0;
            this._eF32[b + 5] = em.localUp[1] ?? 1;
            this._eF32[b + 6] = em.localUp[2] ?? 0;
            this._eU32[b + 7] = (em.typeId ?? 0) >>> 0;
            this._eU32[b + 8] = (em.rngSeed ?? 0) >>> 0;
        }
        this.device.queue.writeBuffer(this.emitterData, 0, this._eF32.buffer);
        this._emitterCounterData[0] = count >>> 0;
        this._emitterCounterData[1] = 0;
        this._emitterCounterData[2] = 0;
        this._emitterCounterData[3] = 0;
        this.device.queue.writeBuffer(this.emitterCounter, 0, this._emitterCounterData);
    }

    writeGlobals({
        viewProjMatrix, cameraRight, cameraUp, cameraPos,
        dt, time, planetOrigin, totalSpawnBudget, emitterCount,
        windDirection, windSpeed, maxRenderDist, near, far,
        sunDirection, sunVisibility, sunColor,
        ambientColor, ambientIntensity, moonIntensity,
    }) {
        const f = this._gF32;
        const u = this._gU32;
        f.set(viewProjMatrix, GLOBALS_OFFSETS.viewProj / 4);

        const cr = GLOBALS_OFFSETS.cameraRight_dt / 4;
        f[cr] = cameraRight[0]; f[cr+1] = cameraRight[1]; f[cr+2] = cameraRight[2]; f[cr+3] = dt;

        const cu = GLOBALS_OFFSETS.cameraUp_time / 4;
        f[cu] = cameraUp[0]; f[cu+1] = cameraUp[1]; f[cu+2] = cameraUp[2]; f[cu+3] = time;

        const cp = GLOBALS_OFFSETS.cameraPos_budget / 4;
        f[cp] = cameraPos[0]; f[cp+1] = cameraPos[1]; f[cp+2] = cameraPos[2];
        u[cp+3] = totalSpawnBudget >>> 0;

        const po = GLOBALS_OFFSETS.planetOrigin_emCnt / 4;
        f[po] = planetOrigin[0]; f[po+1] = planetOrigin[1]; f[po+2] = planetOrigin[2];
        u[po+3] = emitterCount >>> 0;

        u[GLOBALS_OFFSETS.maxParticles / 4] = this.maxParticles >>> 0;
        f[GLOBALS_OFFSETS.windDirX / 4]     = windDirection?.[0] ?? 0;
        f[GLOBALS_OFFSETS.windDirY / 4]     = windDirection?.[1] ?? 0;
        f[GLOBALS_OFFSETS.windSpeed / 4]    = windSpeed ?? 0;
        f[GLOBALS_OFFSETS.maxRenderDist / 4] = maxRenderDist ?? 2000;
        f[GLOBALS_OFFSETS.nearPlane / 4]    = near ?? 0.5;
        f[GLOBALS_OFFSETS.farPlane / 4]     = far ?? 100000;

        const sd = GLOBALS_OFFSETS.sunDirection_visibility / 4;
        f[sd] = sunDirection?.[0] ?? 0.5;
        f[sd+1] = sunDirection?.[1] ?? 1.0;
        f[sd+2] = sunDirection?.[2] ?? 0.3;
        f[sd+3] = sunVisibility ?? 1.0;

        const sc = GLOBALS_OFFSETS.sunColor_ambient / 4;
        f[sc] = sunColor?.[0] ?? 1.0;
        f[sc+1] = sunColor?.[1] ?? 1.0;
        f[sc+2] = sunColor?.[2] ?? 1.0;
        f[sc+3] = ambientIntensity ?? 0.12;

        const ac = GLOBALS_OFFSETS.ambientColor_moon / 4;
        f[ac] = ambientColor?.[0] ?? 0.35;
        f[ac+1] = ambientColor?.[1] ?? 0.38;
        f[ac+2] = ambientColor?.[2] ?? 0.45;
        f[ac+3] = moonIntensity ?? 0.0;

        this.device.queue.writeBuffer(this.globalsUBO, 0, f.buffer);
    }

    dispose() {
        for (const k of ['particlesA','particlesB','globalsUBO','typeDefUBO',
                          'indirect','liveList','spawnScratch','emitterData','emitterCounter']) {
            this[k]?.destroy();
        }
    }
}
