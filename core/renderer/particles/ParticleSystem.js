// core/renderer/particles/ParticleSystem.js
//
// Top-level facade for the GPU particle system. Owned by Frontend.
//
// Lifecycle:
//   1. construct (stores config, does NOT touch GPU)
//   2. initialize()   — creates buffers, compiles shaders, builds pipelines
//   3. addCampfire(worldPos) — registers an emitter
//   4. update(commandEncoder, camera, deltaTime) — per-frame compute
//   5. render(renderPassEncoder) — per-frame draw
//   6. dispose()

import { Matrix4, Vector3 } from '../../../shared/math/index.js';
import { ParticleBuffers } from './ParticleBuffers.js';
import { ParticleSimulationPass } from './ParticleSimulationPass.js';
import { ParticleRenderPass } from './ParticleRenderPass.js';
import { ParticleEmitter } from './ParticleEmitter.js';
import { PARTICLE_TYPE_CAPACITY } from './ParticleTypes.js';
import {
    PARTICLE_CONFIG,
    PARTICLE_GLOBALS,
} from '../../../templates/configs/particleConfig.js';
import { LightType } from '../../lighting/lightManager.js';

export class ParticleSystem {
    constructor({
        device,
        backend,
        colorFormat,
        depthFormat = 'depth24plus',
        maxParticles = PARTICLE_GLOBALS.maxParticles,
        workgroupSize = PARTICLE_GLOBALS.workgroupSize,
    }) {
        this.device = device;
        this.backend = backend;
        this.colorFormat = colorFormat || backend?.format;
        this.depthFormat = depthFormat;
        this.maxParticles = maxParticles;
        this.workgroupSize = workgroupSize;

        this.buffers = null;
        this.simPass = null;
        this.renderPass = null;

        this.emitters = [];

        this._frameCount = 0;
        this._elapsedTime = 0;
        this._initialized = false;

        // Debug mode: 1 = oversized magenta blobs at the emitter that ignore
        // type configs. Use this to verify the entire pipeline is alive.
        this.debugMode = 0;

        // Planet origin used to compute the local "up" direction at the
        // emitter. Set via setPlanetConfig(); falls back to (0,0,0).
        this._planetOrigin = { x: 0, y: 0, z: 0 };

        // Optional light manager for campfire point lights.
        this._lightManager = null;
    }

    // Call this after the frontend's lightManager is ready.
    setLightManager(lightManager) {
        this._lightManager = lightManager;
    }

    setPlanetConfig(planetConfig) {
        const o = planetConfig?.origin;
        if (o) {
            this._planetOrigin = { x: o.x ?? 0, y: o.y ?? 0, z: o.z ?? 0 };
        }

        // Scratch matrix for view*proj each frame.
        this._viewProj = new Matrix4();
    }

    async initialize() {
        if (this._initialized) return;
        if (!this.device) throw new Error('ParticleSystem: missing GPU device');
        if (!this.colorFormat) throw new Error('ParticleSystem: missing colorFormat');

        this.buffers = new ParticleBuffers(this.device, {
            maxParticles: this.maxParticles,
        });
        this.buffers.uploadTypeDefs(PARTICLE_CONFIG);

        this.simPass = new ParticleSimulationPass(this.device, this.buffers, {
            workgroupSize: this.workgroupSize,
            typeCapacity: PARTICLE_TYPE_CAPACITY,
        });
        this.simPass.initialize();

        this.renderPass = new ParticleRenderPass(this.device, this.buffers, {
            colorFormat: this.colorFormat,
            depthFormat: this.depthFormat,
            typeCapacity: PARTICLE_TYPE_CAPACITY,
        });
        this.renderPass.initialize();

        this._initialized = true;
    }

    addCampfire(worldPos, overrides = {}) {
        const emitter = new ParticleEmitter({
            position: worldPos,
            preset: 'campfire',
            overrides,
        });
        // Deferred placement modes:
        //   snapToActor  — copy `getActor()` position once the actor has been
        //                  ground-snapped by the GPU movement resolver (a few
        //                  frames after spawn).
        emitter._snapToActorFn = typeof overrides.getActor === 'function'
            ? overrides.getActor
            : null;
        emitter._snapSettleFrames = overrides.snapSettleFrames ?? 10;
        emitter._needsActorSnap = !!emitter._snapToActorFn;

        // Attach a dynamic point light if a light manager is available.
        emitter._pointLight = null;
        emitter._baseLightIntensity = overrides.lightIntensity ?? 2.5;
        emitter._lightPhase = Math.random() * Math.PI * 2; // random flicker phase
        if (this._lightManager) {
            const lm = this._lightManager;
            const pos = new Vector3(emitter.position.x, emitter.position.y + 0.3, emitter.position.z);
            emitter._pointLight = lm.addLight(LightType.POINT, {
                position: pos,
                color:     { r: 1.0, g: 0.45, b: 0.08 },  // warm fire orange
                intensity: emitter._baseLightIntensity,
                radius:    overrides.lightRadius ?? 10.0,
                decay:     2.0,
                dynamic:   true,
                name:      'campfire_light',
            });
        }

        this._registerEmitter(emitter);
        // eslint-disable-next-line no-console
        console.log(
            `[ParticleSystem] addCampfire at (${emitter.position.x.toFixed(2)}, ` +
            `${emitter.position.y.toFixed(2)}, ${emitter.position.z.toFixed(2)}) ` +
            `budget=${emitter.spawnBudgetPerFrame}/frame cutoff=${emitter.distanceCutoff}m ` +
            `snapToActor=${emitter._needsActorSnap} ` +
            `types=[${emitter.typeIds.join(',')}] cumWeights=[${emitter.typeWeightsCumulative.join(',')}]`
        );
        return emitter;
    }

    // Add the ground-level coal bed emitter for a campfire.
    // Accepts the same snap options as addCampfire() so it follows the
    // actor's ground-snapped position.
    addCampfireCoals(worldPos, overrides = {}) {
        const emitter = new ParticleEmitter({
            position: worldPos,
            preset: 'campfire_coals',
            overrides,
        });
        emitter._pointLight = null;
        emitter._snapToActorFn = typeof overrides.getActor === 'function'
            ? overrides.getActor
            : null;
        emitter._snapSettleFrames = overrides.snapSettleFrames ?? 10;
        emitter._needsActorSnap = !!emitter._snapToActorFn;
        this._registerEmitter(emitter);
        return emitter;
    }

    // Allocates per-emitter GPU resources (own globalsUBO + bind group pair)
    // and pushes the emitter into the active list.
    _registerEmitter(emitter) {
        // Each emitter needs its own globals UBO so that multiple emitters
        // dispatching in the same command buffer don't clobber each other's
        // per-frame data (all writeBuffer calls execute before any dispatch).
        emitter._globalsTarget = this.buffers.createEmitterGlobalsTarget(emitter.preset);
        emitter._bindGroups   = this.simPass.createEmitterBindGroups(emitter._globalsTarget.ubo);
        this.emitters.push(emitter);
    }

    // Runs the sim compute pass. `commandEncoder` must be a valid WebGPU
    // command encoder outside any active render pass.
    update(commandEncoder, camera, deltaTime) {
        if (!this._initialized || !camera) return;
        if (this.emitters.length === 0) return;

        const dt = Math.max(0, Math.min(deltaTime || 0, 0.1));
        this._elapsedTime += dt;
        this._frameCount++;

        // Per-frame camera constants shared across all emitter dispatches.
        const te = camera.matrixWorldInverse.elements;
        const cameraRight = [te[0], te[4], te[8]];
        const cameraUp    = [te[1], te[5], te[9]];
        this._viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        const viewProjArr = this._viewProj.elements;
        const cam = camera.position;

        // Reset the live-list indirect draw counters ONCE per frame (CPU-side).
        // The spawn scratch is reset per-emitter INSIDE the command stream via
        // commandEncoder.clearBuffer() so each dispatch gets its own fresh counter.
        this.buffers.resetLiveLists();

        // The render pass reads viewProj/cameraRight/cameraUp from the SHARED
        // globalsUBO (b.globalsUBO). Per-emitter dispatches write to their own
        // UBOs, so we must update the shared one once per frame for rendering.
        // (We reuse emitters[0]'s data — camera values are identical across emitters.)
        {
            const e0 = this.emitters[0];
            const ux = e0.position.x - this._planetOrigin.x;
            const uy = e0.position.y - this._planetOrigin.y;
            const uz = e0.position.z - this._planetOrigin.z;
            const ulen = Math.sqrt(ux * ux + uy * uy + uz * uz);
            this.buffers.writeGlobals({
                viewProjMatrix: viewProjArr,
                cameraRight, cameraUp,
                dt, time: this._elapsedTime,
                emitterPos:   [e0.position.x, e0.position.y, e0.position.z],
                spawnBudget:  0,
                typeWeightsCumulative: e0.getShaderTypeWeightsCumulative(),
                typeIds:      e0.getShaderTypeIds(),
                rngSeed:      0,
                activeTypeCount: e0.getActiveTypeCount(),
                debugMode:    this.debugMode,
                localUp: (ulen > 1e-6) ? [ux / ulen, uy / ulen, uz / ulen] : [0, 1, 0],
            }); // no target → writes to shared globalsUBO used by the render pass
        }

        // Dispatch once per emitter. All emitters share the same particle pool;
        // ping-pong swaps only once at the end of the frame.
        for (const emitter of this.emitters) {
            // Deferred actor-snap placement.
            if (emitter._needsActorSnap) {
                if (emitter._snapWaitFrames === undefined) emitter._snapWaitFrames = 0;
                emitter._snapWaitFrames++;
                if (emitter._snapWaitFrames >= emitter._snapSettleFrames) {
                    const actor = emitter._snapToActorFn?.();
                    const p = actor?.position;
                    if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) {
                        emitter.position.x = p.x;
                        emitter.position.y = p.y;
                        emitter.position.z = p.z;
                        emitter._needsActorSnap = false;
                        // eslint-disable-next-line no-console
                        console.log(
                            `[ParticleSystem] snapped to actor ` +
                            `(${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}) ` +
                            `after ${emitter._snapWaitFrames} frames`
                        );
                    }
                }
            }

            // Update campfire point light position and flicker.
            if (emitter._pointLight) {
                const pl = emitter._pointLight;
                const flicker = 0.82 + 0.18 * Math.sin(this._elapsedTime * 9.1  + emitter._lightPhase)
                                     + 0.06 * Math.sin(this._elapsedTime * 23.7 + emitter._lightPhase * 1.3);
                pl.intensity = emitter._baseLightIntensity * flicker;
                pl.position.x = emitter.position.x;
                pl.position.y = emitter.position.y + 0.3;
                pl.position.z = emitter.position.z;
            }

            // LOD cutoff.
            const dx = cam.x - emitter.position.x;
            const dy = cam.y - emitter.position.y;
            const dz = cam.z - emitter.position.z;
            const distSq = dx * dx + dy * dy + dz * dz;
            const cutoffSq = emitter.distanceCutoff * emitter.distanceCutoff;
            const spawnBudget = (distSq > cutoffSq || emitter._needsActorSnap)
                ? 0 : emitter.spawnBudgetPerFrame;

            // Local "up" at this emitter's world position.
            const ux = emitter.position.x - this._planetOrigin.x;
            const uy = emitter.position.y - this._planetOrigin.y;
            const uz = emitter.position.z - this._planetOrigin.z;
            const ulen = Math.sqrt(ux * ux + uy * uy + uz * uz);
            const localUp = (ulen > 1e-6) ? [ux / ulen, uy / ulen, uz / ulen] : [0, 1, 0];

            // Write this emitter's globals into its own dedicated UBO so that
            // multiple writeBuffer calls in the same frame don't clobber each other.
            this.buffers.writeGlobals({
                viewProjMatrix: viewProjArr,
                cameraRight, cameraUp,
                dt, time: this._elapsedTime,
                emitterPos: [emitter.position.x, emitter.position.y, emitter.position.z],
                spawnBudget,
                typeWeightsCumulative: emitter.getShaderTypeWeightsCumulative(),
                typeIds: emitter.getShaderTypeIds(),
                rngSeed: (emitter.baseSeed + this._frameCount * 2654435761) >>> 0,
                activeTypeCount: emitter.getActiveTypeCount(),
                debugMode: this.debugMode,
                localUp,
            }, emitter._globalsTarget);

            // Reset spawn-scratch in the GPU command stream so each emitter
            // starts its own claim counter from zero.
            this.buffers.clearSpawnScratch(commandEncoder);

            // Dispatch using this emitter's own bind groups (which reference
            // its own globalsUBO at binding 0).
            this.simPass.dispatch(commandEncoder, emitter._bindGroups);

            // Advance ping-pong AFTER each dispatch so the next emitter reads
            // from the buffer this one just wrote — chaining A→B→A rather than
            // both dispatches clobbering the same write buffer.
            this.buffers.advancePingPong();

            if ((this._frameCount % 300) === 0) {
                // eslint-disable-next-line no-console
                console.log(
                    `[ParticleSystem] frame=${this._frameCount} preset=${emitter.preset} ` +
                    `dist=${Math.sqrt(distSq).toFixed(1)}m budget=${spawnBudget}`
                );
            }
        }
    }

    // Issues the two indirect draw calls inside an already-active render pass.
    render(renderPassEncoder) {
        if (!this._initialized || !renderPassEncoder) return;
        if (this.emitters.length === 0) return;

        // The "current" particle buffer is the one the sim just WROTE to.
        // advancePingPong() was called at the end of update(), so now
        // getPingPong().read is the buffer we want to READ from during render.
        const { read } = this.buffers.getPingPong();
        this.renderPass.render(renderPassEncoder, read);

        if (!this._loggedFirstRender) {
            this._loggedFirstRender = true;
            // eslint-disable-next-line no-console
            console.log(`[ParticleSystem] first render call issued (read=${read === this.buffers.particlesA ? 'A' : 'B'})`);
        }
    }

    dispose() {
        for (const emitter of this.emitters) {
            emitter._globalsTarget?.ubo?.destroy();
        }
        this.simPass?.dispose();
        this.renderPass?.dispose();
        this.buffers?.dispose();
        this.simPass = null;
        this.renderPass = null;
        this.buffers = null;
        this.emitters = [];
        this._initialized = false;
    }
}
