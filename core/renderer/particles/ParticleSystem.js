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
import { EMITTER_CAPACITY, ParticleBuffers } from './ParticleBuffers.js';
import { ParticleSimulationPass } from './ParticleSimulationPass.js';
import { ParticleRenderPass } from './ParticleRenderPass.js';
import { ParticleEmitter } from './ParticleEmitter.js';
import { PARTICLE_TYPE_CAPACITY } from './ParticleTypes.js';
import {
    PARTICLE_GLOBALS,
} from '../../../templates/configs/particleConfig.js';
import { LightType } from '../../lighting/lightManager.js';
import { FireflySwarm } from './FireflySwarm.js';
import { buildParticleAuthoringRuntime } from './ParticleAuthoringRuntime.js';
import { LeafAnchorEmitterSource } from './LeafAnchorEmitterSource.js';

export class ParticleSystem {
    constructor({
        device,
        backend,
        colorFormat,
        depthFormat = 'depth24plus',
        maxParticles = PARTICLE_GLOBALS.maxParticles,
        workgroupSize = PARTICLE_GLOBALS.workgroupSize,
        particleAuthoring = null,
    }) {
        this.device = device;
        this.backend = backend;
        this.colorFormat = colorFormat || backend?.format;
        this.depthFormat = depthFormat;
        this.maxParticles = maxParticles;
        this.workgroupSize = workgroupSize;
        this.authoringRuntime = buildParticleAuthoringRuntime(particleAuthoring ?? {});

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
        this._planetRadius = 0;
        this._atmosphereHeight = 0;

        // Optional light manager for campfire point lights.
        this._lightManager = null;

        // Active firefly swarm (only one allowed at a time).
        this._fireflySwarm = null;
        this._fireflyEmitters = [];
        this._fireflyLight = null;
        this._fireflyFollowActorFn = null;
        this._fireflySnapSettleFrames = 0;
        this._fireflyFollowWaitFrames = 0;
        this._fireflyFollowSideOffset = 0.0;
        this._fireflyFollowHeightOffset = 0.0;
        this._fireflyGlow = 1.0;
        this._leafLight = 1.0;
        this._fireflyLightIntensity = 0.0;
        this._viewProj = new Matrix4();
        this._loggedEmitterOverflow = false;
        this._leafAnchorSource = null;
        this._leafAnchorEmitters = [];
        this._leafAnchorRevision = -1;
        this._leafAnchorConfig = null;
        this._weatherRainEmitter = null;
        this._weatherRainIdleFrames = 0;
    }

    // Call this after the frontend's lightManager is ready.
    setLightManager(lightManager) {
        this._lightManager = lightManager;
    }

    setPlanetConfig(planetConfig) {
        const o = planetConfig?.origin;
        if (o) {
            this._planetOrigin = { x: o.x ?? 0, y: o.y ?? 0, z: o.z ?? 0 };
            this._leafAnchorSource?.setPlanetOrigin?.(this._planetOrigin);
        }
        this._planetRadius = Number.isFinite(planetConfig?.radius) ? planetConfig.radius : 0;
        this._atmosphereHeight = Number.isFinite(planetConfig?.atmosphereHeight)
            ? planetConfig.atmosphereHeight
            : 0;
    }

    setAuthoringRuntime(particleAuthoring) {
        this.authoringRuntime = buildParticleAuthoringRuntime(particleAuthoring ?? {});
        if (this._initialized && this.buffers) {
            this.buffers.uploadTypeDefs(this.authoringRuntime.particleConfig);
        }
    }

    setDebugMode(mode = 0) {
        this.debugMode = Math.max(0, Math.trunc(mode) || 0);
        return this.debugMode;
    }

    setLeafAnchorSource({ treeDetailSystem = null, templateLibrary = null, config = null } = {}) {
        this._leafAnchorSource?.dispose?.();
        this._leafAnchorSource = null;
        this._removeManagedLeafAnchorEmitters();

        if (config?.source === 'spawn_offsets') {
            return;
        }
        if (!treeDetailSystem || !templateLibrary) {
            console.warn('[ParticleSystem] Leaf anchor source unavailable; falling-leaf anchors disabled');
            return;
        }

        this._leafAnchorConfig = config ?? {};
        this._leafAnchorSource = new LeafAnchorEmitterSource(this.device, {
            treeDetailSystem,
            templateLibrary,
            config: this._leafAnchorConfig,
            planetOrigin: this._planetOrigin,
        });
        this._leafAnchorRevision = -1;

        console.info(
            `[ParticleSystem] Leaf fall source=detailed_leaf_anchors ` +
            `maxEmitters=${this._leafAnchorSource.config.maxEmitters} ` +
            `interval=${this._leafAnchorSource.config.spawnIntervalSeconds.join('-')}s`
        );
    }

    async initialize() {
        if (this._initialized) return;
        if (!this.device) throw new Error('ParticleSystem: missing GPU device');
        if (!this.colorFormat) throw new Error('ParticleSystem: missing colorFormat');

        this.buffers = new ParticleBuffers(this.device, {
            maxParticles: this.maxParticles,
        });
        this.buffers.uploadTypeDefs(this.authoringRuntime.particleConfig);

        this.simPass = new ParticleSimulationPass(this.device, this.buffers, {
            workgroupSize: this.workgroupSize,
            typeCapacity: PARTICLE_TYPE_CAPACITY,
            emitterCapacity: EMITTER_CAPACITY,
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
            particleConfig: this.authoringRuntime.particleConfig,
            emitterPresets: this.authoringRuntime.emitterPresets,
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

        emitter._pointLights = [];
        emitter._baseLightIntensity = overrides.lightIntensity ?? 5.0;
        emitter._lightPhase = Math.random() * Math.PI * 2;
        if (this._lightManager) {
            const lm = this._lightManager;
            const px = emitter.position.x;
            const py = emitter.position.y;
            const pz = emitter.position.z;

            emitter._pointLights.push(lm.addLight(LightType.POINT, {
                position: new Vector3(px, py, pz),
                color: { r: 1.00, g: 0.62, b: 0.22 },
                intensity: emitter._baseLightIntensity,
                radius: overrides.lightRadius ?? 6.0,
                decay: 0.032,
                dynamic: true,
                name: 'campfire_light_core',
            }));

            emitter._pointLights.push(lm.addLight(LightType.POINT, {
                position: new Vector3(px, py, pz),
                color: { r: 1.00, g: 0.66, b: 0.32 },
                intensity: emitter._baseLightIntensity * 0.18,
                radius: overrides.fillLightRadius ?? 18.0,
                decay: 0.012,
                dynamic: true,
                name: 'campfire_light_fill',
            }));
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
            particleConfig: this.authoringRuntime.particleConfig,
            emitterPresets: this.authoringRuntime.emitterPresets,
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

    addLeafEmitter(worldPos, overrides = {}) {
        const emitter = new ParticleEmitter({
            position: worldPos,
            preset: 'leaf_fall',
            overrides,
            particleConfig: this.authoringRuntime.particleConfig,
            emitterPresets: this.authoringRuntime.emitterPresets,
        });
        emitter._snapToActorFn = typeof overrides.getActor === 'function'
            ? overrides.getActor
            : null;
        emitter._snapSettleFrames = overrides.snapSettleFrames ?? 10;
        emitter._needsActorSnap = !!emitter._snapToActorFn;
        emitter._leafSurfaceOffset = overrides.surfaceOffset || null;
        emitter._leafHeightOffset = Number.isFinite(overrides.heightOffset)
            ? overrides.heightOffset
            : null;
        this._registerEmitter(emitter);
        return emitter;
    }

    // Creates a firefly swarm at the given position. Only one swarm can
    // be active at a time. The swarm runs Boids on CPU and emits tiny
    // bright particles.
    addFireflySwarm(worldPos, overrides = {}) {
        if (this._fireflySwarm) {
            console.warn('[ParticleSystem] Only one firefly swarm at a time.');
            return null;
        }

        const swarm = new FireflySwarm({
            position: worldPos,
            swarmSize: overrides.swarmSize ?? 7,
            planetOrigin: this._planetOrigin,
        });
        this._fireflySwarm = swarm;
        this._fireflyFollowActorFn = typeof overrides.getActor === 'function'
            ? overrides.getActor
            : null;
        this._fireflySnapSettleFrames = Math.max(0, overrides.snapSettleFrames ?? 15);
        this._fireflyFollowWaitFrames = 0;
        this._fireflyFollowSideOffset = overrides.followSideOffset ?? 2.0;
        this._fireflyFollowHeightOffset = overrides.followHeightOffset ?? 2.0;

        this._fireflyEmitters = swarm.positions.map((position, index) => {
            const fireflySeed =
                (((0x9E3779B9 * (index + 1)) ^ (0x85EBCA6B + index * 0xC2B2AE35)) >>> 0) || 1;
            const emitter = new ParticleEmitter({
                position,
                preset: 'firefly_swarm',
                overrides: {
                    ...overrides,
                    baseSeed: fireflySeed,
                },
                particleConfig: this.authoringRuntime.particleConfig,
                emitterPresets: this.authoringRuntime.emitterPresets,
            });
            this._registerEmitter(emitter);
            return emitter;
        });

        // Attach a dim point light at the swarm centroid.
        if (this._lightManager) {
            this._fireflyLight = this._lightManager.addLight(LightType.POINT, {
                position: new Vector3(worldPos.x, worldPos.y + 2.5, worldPos.z),
                color: { r: 0.04, g: 1.00, b: 0.22 },
                intensity: 0.0,  // starts off — modulated per-frame
                radius: 6.0,
                decay: 0.04,
                dynamic: true,
                name: 'firefly_swarm_light',
            });
        }

        console.log(
            `[ParticleSystem] addFireflySwarm at (${worldPos.x.toFixed(2)}, ` +
            `${worldPos.y.toFixed(2)}, ${worldPos.z.toFixed(2)}) ` +
            `size=${swarm.swarmSize}`
        );
        return swarm;
    }

    _getFireflyFollowAnchor() {
        const actor = this._fireflyFollowActorFn?.();
        const p = actor?.position;
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) {
            return null;
        }

        this._fireflyFollowWaitFrames++;
        if (this._fireflyFollowWaitFrames < this._fireflySnapSettleFrames) {
            return null;
        }

        const ux = p.x - this._planetOrigin.x;
        const uy = p.y - this._planetOrigin.y;
        const uz = p.z - this._planetOrigin.z;
        const ulen = Math.sqrt(ux * ux + uy * uy + uz * uz);
        const up = ulen > 1e-6
            ? { x: ux / ulen, y: uy / ulen, z: uz / ulen }
            : { x: 0, y: 1, z: 0 };

        let ref = { x: 0, y: 1, z: 0 };
        if (Math.abs(up.y) > 0.9) {
            ref = { x: 1, y: 0, z: 0 };
        }

        const tx = up.y * ref.z - up.z * ref.y;
        const ty = up.z * ref.x - up.x * ref.z;
        const tz = up.x * ref.y - up.y * ref.x;
        const tlen = Math.sqrt(tx * tx + ty * ty + tz * tz);
        const tangent = tlen > 1e-6
            ? { x: tx / tlen, y: ty / tlen, z: tz / tlen }
            : { x: 1, y: 0, z: 0 };

        return {
            x: p.x + tangent.x * this._fireflyFollowSideOffset + up.x * this._fireflyFollowHeightOffset,
            y: p.y + tangent.y * this._fireflyFollowSideOffset + up.y * this._fireflyFollowHeightOffset,
            z: p.z + tangent.z * this._fireflyFollowSideOffset + up.z * this._fireflyFollowHeightOffset,
        };
    }

    // Sets the local daylight-driven glow factor for the firefly swarm.
    // `daylightVisibility` is 0 at local night and 1 in full local daylight.
    setFireflyTimeOfDay(daylightVisibility) {
        this._leafLight = Math.max(0.0, Math.min(1.0, daylightVisibility ?? 1.0));
        if (this._fireflySwarm) {
            const glow = FireflySwarm.computeTimeOfDayGlow(daylightVisibility);
            this._fireflySwarm.timeOfDayGlow = glow;
            this._fireflyGlow = glow;
        }
    }

    _registerEmitter(emitter) {
        this.emitters.push(emitter);
    }

    _removeEmitter(emitter) {
        const idx = this.emitters.indexOf(emitter);
        if (idx >= 0) this.emitters.splice(idx, 1);
    }

    _computeCameraAltitude(camera) {
        const p = camera?.position;
        if (!p || !Number.isFinite(this._planetRadius) || this._planetRadius <= 0) return 0;
        const dx = p.x - this._planetOrigin.x;
        const dy = p.y - this._planetOrigin.y;
        const dz = p.z - this._planetOrigin.z;
        return Math.max(0, Math.sqrt(dx * dx + dy * dy + dz * dz) - this._planetRadius);
    }

    _syncWeatherRainEmitter(camera, environmentState) {
        const rain = environmentState?.rainParticles;
        const intensity = rain?.intensity ?? environmentState?.precipitationIntensity ?? 0;
        const maxAltitude = Number.isFinite(rain?.maxCameraAltitude)
            ? rain.maxCameraAltitude
            : Math.max(12000, this._atmosphereHeight * 0.24);
        const cameraAltitude = this._computeCameraAltitude(camera);
        const enabled =
            rain?.enabled === true &&
            intensity > 0.02 &&
            cameraAltitude <= maxAltitude;

        if (!enabled) {
            if (this._weatherRainEmitter) {
                this._weatherRainEmitter.spawnBudgetPerFrame = 0;
                this._weatherRainIdleFrames++;
                if (camera?.position) {
                    this._weatherRainEmitter.position.x = camera.position.x;
                    this._weatherRainEmitter.position.y = camera.position.y;
                    this._weatherRainEmitter.position.z = camera.position.z;
                }
                if (this._weatherRainIdleFrames > 120) {
                    this._removeEmitter(this._weatherRainEmitter);
                    this._weatherRainEmitter = null;
                }
            }
            return;
        }

        this._weatherRainIdleFrames = 0;

        if (!this._weatherRainEmitter) {
            this._weatherRainEmitter = new ParticleEmitter({
                position: camera.position,
                preset: 'rain_shower',
                overrides: {
                    spawnBudgetPerFrame: rain.spawnBudgetPerFrame,
                    distanceCutoff: rain.distanceCutoff,
                    lodNearDistance: rain.lodNearDistance,
                    lodFarDistance: rain.lodFarDistance,
                    lodMinScale: rain.lodMinScale,
                    baseSeed: 0xA17E5EED,
                },
                particleConfig: this.authoringRuntime.particleConfig,
                emitterPresets: this.authoringRuntime.emitterPresets,
            });
            this._weatherRainEmitter._weatherManaged = true;
            this._registerEmitter(this._weatherRainEmitter);
        }

        const emitter = this._weatherRainEmitter;
        emitter.position.x = camera.position.x;
        emitter.position.y = camera.position.y;
        emitter.position.z = camera.position.z;
        emitter.spawnBudgetPerFrame = Math.max(0, Math.trunc(rain.spawnBudgetPerFrame ?? 0));
        emitter.distanceCutoff = rain.distanceCutoff ?? emitter.distanceCutoff;
        emitter.lodNearDistance = rain.lodNearDistance ?? emitter.lodNearDistance;
        emitter.lodFarDistance = rain.lodFarDistance ?? emitter.lodFarDistance;
        emitter.lodMinScale = rain.lodMinScale ?? emitter.lodMinScale;
    }

    _removeManagedLeafAnchorEmitters() {
        for (const emitter of this._leafAnchorEmitters) {
            this._removeEmitter(emitter);
        }
        this._leafAnchorEmitters = [];
    }

    _syncLeafAnchorEmitters() {
        if (!this._leafAnchorSource) return;
        if (this._leafAnchorRevision === this._leafAnchorSource.revision) return;

        this._leafAnchorRevision = this._leafAnchorSource.revision;
        const config = this._leafAnchorSource.config;
        const candidates = this._leafAnchorSource.candidates.slice(0, config.maxEmitters);

        while (this._leafAnchorEmitters.length > candidates.length) {
            const emitter = this._leafAnchorEmitters.pop();
            this._removeEmitter(emitter);
        }

        for (let i = 0; i < candidates.length; i++) {
            const candidate = candidates[i];
            let emitter = this._leafAnchorEmitters[i];
            if (!emitter) {
                emitter = this.addLeafEmitter(candidate.position, {
                    spawnBudgetPerFrame: candidate.spawnBudgetPerEvent,
                    distanceCutoff: config.distanceCutoff,
                    lodNearDistance: config.lodNearDistance,
                    lodFarDistance: config.lodFarDistance,
                    lodMinScale: config.lodMinScale,
                    baseSeed: candidate.seed,
                });
                emitter._leafAnchorManaged = true;
                this._leafAnchorEmitters[i] = emitter;
            }

            const seedChanged = emitter._leafAnchorSeed !== candidate.seed;
            emitter.position.x = candidate.position.x;
            emitter.position.y = candidate.position.y;
            emitter.position.z = candidate.position.z;
            emitter.baseSeed = candidate.seed >>> 0;
            emitter.spawnBudgetPerFrame = candidate.spawnBudgetPerEvent;
            emitter.distanceCutoff = config.distanceCutoff;
            emitter.lodNearDistance = config.lodNearDistance;
            emitter.lodFarDistance = config.lodFarDistance;
            emitter.lodMinScale = config.lodMinScale;
            emitter._leafAnchorManaged = true;
            emitter._leafAnchorSeed = candidate.seed;
            emitter._leafAnchorInterval = config.spawnIntervalSeconds.slice();
            emitter._leafAnchorSpawnBudget = candidate.spawnBudgetPerEvent;
            emitter._leafAnchorFoliageColor = candidate.foliageColor;
            if (seedChanged || !Number.isFinite(emitter._nextLeafAnchorSpawnTime)) {
                emitter._leafAnchorEventIndex = 0;
                const spread = this._leafAnchorRandomInterval(emitter, 0);
                emitter._nextLeafAnchorSpawnTime = this._elapsedTime + spread;
            }
        }
    }

    _leafAnchorRandomInterval(emitter, salt = 0) {
        const range = Array.isArray(emitter._leafAnchorInterval)
            ? emitter._leafAnchorInterval
            : [1.0, 4.0];
        const min = Math.min(range[0] ?? 1.0, range[1] ?? 4.0);
        const max = Math.max(range[0] ?? 1.0, range[1] ?? 4.0);
        let seed = (emitter.baseSeed ^ ((salt + 1) * 0x9E3779B9)) >>> 0;
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const u = seed / 4294967296;
        return min + (max - min) * u;
    }

    _getLeafAnchorSpawnBudget(emitter, distance) {
        if (!emitter._leafAnchorManaged) return null;
        if (emitter._needsActorSnap || distance >= emitter.distanceCutoff) return 0;
        if (this._elapsedTime < (emitter._nextLeafAnchorSpawnTime ?? 0)) return 0;

        const eventIndex = (emitter._leafAnchorEventIndex ?? 0) + 1;
        emitter._leafAnchorEventIndex = eventIndex;
        emitter._nextLeafAnchorSpawnTime =
            this._elapsedTime + this._leafAnchorRandomInterval(emitter, eventIndex);
        return Math.max(1, Math.trunc(emitter._leafAnchorSpawnBudget ?? 1));
    }

    _updateEmitterSnap(emitter) {
        if (!emitter._snapToActorFn) return;

        if (emitter._needsActorSnap) {
            if (emitter._snapWaitFrames === undefined) emitter._snapWaitFrames = 0;
            emitter._snapWaitFrames++;
            if (emitter._snapWaitFrames < emitter._snapSettleFrames) return;

            const actor = emitter._snapToActorFn?.();
            const p = actor?.position;
            if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) {
                emitter.position.x = p.x;
                emitter.position.y = p.y;
                emitter.position.z = p.z;

                this._applyLeafActorOffsets(emitter);

                emitter._needsActorSnap = false;
                // eslint-disable-next-line no-console
                console.log(
                    `[ParticleSystem] snapped to actor ` +
                    `(${emitter.position.x.toFixed(2)}, ${emitter.position.y.toFixed(2)}, ${emitter.position.z.toFixed(2)}) ` +
                    `after ${emitter._snapWaitFrames} frames`
                );
            }
            return;
        }

        if (emitter._postSnapFollowFrames === undefined) {
            emitter._postSnapFollowFrames = 45;
        }
        if (emitter._postSnapFollowFrames <= 0) return;

        const actor = emitter._snapToActorFn?.();
        const p = actor?.position;
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) {
            emitter.position.x = p.x;
            emitter.position.y = p.y;
            emitter.position.z = p.z;
            this._applyLeafActorOffsets(emitter);
        }
        emitter._postSnapFollowFrames--;
    }

    _applyLeafActorOffsets(emitter) {
        if (emitter._leafHeightOffset != null) {
            this._applyHeightOffset(emitter, emitter._leafHeightOffset);
        }
        if (emitter._leafSurfaceOffset) {
            this._applyTangentOffset(emitter, emitter._leafSurfaceOffset);
        }
    }

    _applyHeightOffset(emitter, heightOffset) {
        if (!Number.isFinite(heightOffset) || heightOffset === 0) return;

        const ox = emitter.position.x - this._planetOrigin.x;
        const oy = emitter.position.y - this._planetOrigin.y;
        const oz = emitter.position.z - this._planetOrigin.z;
        const dist = Math.sqrt(ox * ox + oy * oy + oz * oz);
        if (dist < 1) return;

        const targetDist = Math.max(1, dist + heightOffset);
        emitter.position.x = this._planetOrigin.x + (ox / dist) * targetDist;
        emitter.position.y = this._planetOrigin.y + (oy / dist) * targetDist;
        emitter.position.z = this._planetOrigin.z + (oz / dist) * targetDist;
    }

    _applyTangentOffset(emitter, offset) {
        const ox = emitter.position.x - this._planetOrigin.x;
        const oy = emitter.position.y - this._planetOrigin.y;
        const oz = emitter.position.z - this._planetOrigin.z;
        const dist = Math.sqrt(ox * ox + oy * oy + oz * oz);
        if (dist < 1) return;

        const upX = ox / dist, upY = oy / dist, upZ = oz / dist;

        let rx = 0, ry = 1, rz = 0;
        if (Math.abs(upY) > 0.9) { rx = 1; ry = 0; }
        let tx = upY * rz - upZ * ry;
        let ty = upZ * rx - upX * rz;
        let tz = upX * ry - upY * rx;
        const tlen = Math.sqrt(tx * tx + ty * ty + tz * tz);
        tx /= tlen; ty /= tlen; tz /= tlen;

        const bx = upY * tz - upZ * ty;
        const by = upZ * tx - upX * tz;
        const bz = upX * ty - upY * tx;

        const px = emitter.position.x + tx * offset.tangent + bx * offset.bitangent;
        const py = emitter.position.y + ty * offset.tangent + by * offset.bitangent;
        const pz = emitter.position.z + tz * offset.tangent + bz * offset.bitangent;

        const dx = px - this._planetOrigin.x;
        const dy = py - this._planetOrigin.y;
        const dz = pz - this._planetOrigin.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        emitter.position.x = this._planetOrigin.x + (dx / d) * dist;
        emitter.position.y = this._planetOrigin.y + (dy / d) * dist;
        emitter.position.z = this._planetOrigin.z + (dz / d) * dist;
    }

    _computeEmitterLocalUp(emitter) {
        const ux = emitter.position.x - this._planetOrigin.x;
        const uy = emitter.position.y - this._planetOrigin.y;
        const uz = emitter.position.z - this._planetOrigin.z;
        const ulen = Math.sqrt(ux * ux + uy * uy + uz * uz);
        if (ulen > 1e-6) {
            return [ux / ulen, uy / ulen, uz / ulen];
        }
        return [0, 1, 0];
    }

    _updateEmitterPointLights(emitter, localUp, enabled) {
        if (!Array.isArray(emitter._pointLights) || emitter._pointLights.length < 2) return;

        const [core, fill] = emitter._pointLights;
        const upx = localUp[0];
        const upy = localUp[1];
        const upz = localUp[2];
        const baseX = emitter.position.x;
        const baseY = emitter.position.y;
        const baseZ = emitter.position.z;

        core.position.x = baseX + upx * 1.2;
        core.position.y = baseY + upy * 1.2;
        core.position.z = baseZ + upz * 1.2;

        fill.position.x = baseX + upx * 3.6;
        fill.position.y = baseY + upy * 3.6;
        fill.position.z = baseZ + upz * 3.6;

        if (!enabled) {
            core.intensity = 0.0;
            fill.intensity = 0.0;
            return;
        }

        const t = this._elapsedTime;
        const phase = emitter._lightPhase;
        const base = emitter._baseLightIntensity;
        const coreFlicker =
            0.88 +
            0.16 * Math.sin(t * 8.7 + phase) +
            0.07 * Math.sin(t * 21.3 + phase * 1.7) +
            0.04 * Math.sin(t * 37.0 + phase * 0.6);
        const fillFlicker =
            0.94 +
            0.04 * Math.sin(t * 2.4 + phase * 0.5) +
            0.02 * Math.sin(t * 5.1 + phase * 1.1);

        core.intensity = base * coreFlicker;
        fill.intensity = base * 0.18 * fillFlicker;
    }

    _buildEmitterSpawnEntry(emitter, spawnBudget, localUp) {
        return {
            position: [emitter.position.x, emitter.position.y, emitter.position.z],
            spawnBudget,
            typeWeightsCumulative: emitter.getShaderTypeWeightsCumulative(),
            typeIds: emitter.getShaderTypeIds(),
            rngSeed: (emitter.baseSeed + this._frameCount * 2654435761) >>> 0,
            activeTypeCount: emitter.getActiveTypeCount(),
            localUp,
            foliageColor: emitter._leafAnchorFoliageColor ?? null,
        };
    }

    getDiagnostics() {
        const leafEmitters = this.emitters.filter((emitter) => emitter.preset === 'leaf_fall');
        const managedLeafEmitters = leafEmitters.filter((emitter) => emitter._leafAnchorManaged);
        return {
            initialized: this._initialized,
            debugMode: this.debugMode,
            frameCount: this._frameCount,
            elapsedTime: this._elapsedTime,
            emitterCount: this.emitters.length,
            leafEmitterCount: leafEmitters.length,
            managedLeafEmitterCount: managedLeafEmitters.length,
            leafAnchorSourceActive: !!this._leafAnchorSource,
            leafAnchorRevision: this._leafAnchorRevision,
            leafAnchorCandidateCount: this._leafAnchorSource?.candidates?.length ?? 0,
            leafAnchorStats: this._leafAnchorSource?.lastStats ?? null,
            leafAnchorConfig: this._leafAnchorSource?.config ?? null,
            leafEmitters: leafEmitters.slice(0, 12).map((emitter) => ({
                position: {
                    x: emitter.position.x,
                    y: emitter.position.y,
                    z: emitter.position.z,
                },
                managed: !!emitter._leafAnchorManaged,
                distanceCutoff: emitter.distanceCutoff,
                spawnBudgetPerFrame: emitter.spawnBudgetPerFrame,
                nextSpawnTime: emitter._nextLeafAnchorSpawnTime ?? null,
            })),
        };
    }

    // Runs the sim compute pass once per frame. `commandEncoder` must be a
    // valid WebGPU command encoder outside any active render pass.
    update(commandEncoder, camera, deltaTime, environmentState) {
        if (!this._initialized || !camera) return;
        const dt = Math.max(0, Math.min(deltaTime || 0, 0.1));
        this._elapsedTime += dt;
        this._frameCount++;

        this._syncWeatherRainEmitter(camera, environmentState);

        if (this._leafAnchorSource) {
            this._leafAnchorSource.update(commandEncoder, this._elapsedTime, camera);
            this._syncLeafAnchorEmitters();
        }

        if (this.emitters.length === 0) return;

        const te = camera.matrixWorldInverse.elements;
        const cameraRight = [te[0], te[4], te[8]];
        const cameraUp = [te[1], te[5], te[9]];
        this._viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        const viewProjArr = this._viewProj.elements;
        const cam = camera.position;

        this.buffers.resetLiveLists();

        if (this._fireflySwarm && this._fireflyEmitters.length > 0) {
            const followAnchor = this._getFireflyFollowAnchor();
            if (followAnchor) {
                this._fireflySwarm.setAnchorPosition(followAnchor);
            }
            this._fireflySwarm.update(dt);
            for (let i = 0; i < this._fireflyEmitters.length; i++) {
                const emitter = this._fireflyEmitters[i];
                const ffPos = this._fireflySwarm.positions[i];
                if (!emitter || !ffPos) continue;
                emitter.position.x = ffPos.x;
                emitter.position.y = ffPos.y;
                emitter.position.z = ffPos.z;
            }

            if (this._fireflyLight) {
                const c = this._fireflySwarm.centroid;
                this._fireflyLight.position.x = c.x;
                this._fireflyLight.position.y = c.y;
                this._fireflyLight.position.z = c.z;
                const targetIntensity = this._fireflyGlow * 1.5;
                const lightBlend = 1.0 - Math.exp(-dt * 3.0);
                this._fireflyLightIntensity +=
                    (targetIntensity - this._fireflyLightIntensity) * lightBlend;
                this._fireflyLight.intensity = this._fireflyLightIntensity;
            }
        }

        const activeEmitters = [];
        let fireflyLodScaleSum = 0.0;
        let fireflyLodScaleCount = 0;
        for (const emitter of this.emitters) {
            this._updateEmitterSnap(emitter);

            const dx = cam.x - emitter.position.x;
            const dy = cam.y - emitter.position.y;
            const dz = cam.z - emitter.position.z;
            const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
            const localUp = this._computeEmitterLocalUp(emitter);
            const leafAnchorBudget = this._getLeafAnchorSpawnBudget(emitter, distance);
            const spawnBudget = leafAnchorBudget != null
                ? leafAnchorBudget
                : (emitter._needsActorSnap ? 0 : emitter.getSpawnBudgetForDistance(distance));

            this._updateEmitterPointLights(
                emitter,
                localUp,
                spawnBudget > 0 || distance < emitter.distanceCutoff
            );

            if (this._fireflyEmitters.includes(emitter) && this._fireflyLight) {
                const lodScale = emitter.spawnBudgetPerFrame > 0
                    ? spawnBudget / emitter.spawnBudgetPerFrame
                    : 0;
                fireflyLodScaleSum += lodScale;
                fireflyLodScaleCount++;
            }

            if (spawnBudget > 0) {
                activeEmitters.push(this._buildEmitterSpawnEntry(emitter, spawnBudget, localUp));
            }

            if ((this._frameCount % 300) === 0) {
                // eslint-disable-next-line no-console
                console.log(
                    `[ParticleSystem] frame=${this._frameCount} preset=${emitter.preset} ` +
                    `dist=${distance.toFixed(1)}m budget=${spawnBudget}`
                );
            }
        }

        if (this._fireflyLight && fireflyLodScaleCount > 0) {
            this._fireflyLight.intensity *= fireflyLodScaleSum / fireflyLodScaleCount;
        }

        if (activeEmitters.length > EMITTER_CAPACITY && !this._loggedEmitterOverflow) {
            this._loggedEmitterOverflow = true;
            console.warn(
                `[ParticleSystem] active emitter count ${activeEmitters.length} exceeds ` +
                `capacity ${EMITTER_CAPACITY}; extra emitters will not spawn until capacity frees up.`
            );
        }

        const uploadedEmitters = activeEmitters.slice(0, EMITTER_CAPACITY);
        const totalSpawnBudget = uploadedEmitters.reduce(
            (sum, emitter) => sum + (emitter.spawnBudget || 0),
            0
        );

        this.buffers.uploadEmitterData(uploadedEmitters);
        const windDir = environmentState?.windDirection;
        const windSpd = environmentState?.windSpeed ?? 0;

        this.buffers.writeGlobals({
            viewProjMatrix: viewProjArr,
            cameraRight,
            cameraUp,
            dt,
            time: this._elapsedTime,
            planetOrigin: [this._planetOrigin.x, this._planetOrigin.y, this._planetOrigin.z],
            totalSpawnBudget,
            emitterCount: uploadedEmitters.length,
            debugMode: this.debugMode,
            flatWorld: 0,
            fireflyGlow: this._fireflyGlow,
            leafLight: this._leafLight,
            windDirection: [windDir?.x ?? 0, windDir?.y ?? 0],
            windSpeed: windSpd,
        });
        this.buffers.clearSpawnScratch(commandEncoder);
        this.simPass.dispatch(commandEncoder);
        this.buffers.advancePingPong();
    }

    // Issues the indirect draw calls inside an already-active render pass.
    render(renderPassEncoder) {
        if (!this._initialized || !renderPassEncoder) return;

        const { read } = this.buffers.getPingPong();
        this.renderPass.render(renderPassEncoder, read);

        if (!this._loggedFirstRender) {
            this._loggedFirstRender = true;
            // eslint-disable-next-line no-console
            console.log(
                `[ParticleSystem] first render call issued ` +
                `(read=${read === this.buffers.particlesA ? 'A' : 'B'})`
            );
        }
    }

    // Emits only authored emissive particle signal into the dedicated bloom source.
    renderBloom(renderPassEncoder) {
        if (!this._initialized || !renderPassEncoder) return;

        const { read } = this.buffers.getPingPong();
        this.renderPass.renderBloom(renderPassEncoder, read);
    }

    dispose() {
        this._leafAnchorSource?.dispose?.();
        this.simPass?.dispose();
        this.renderPass?.dispose();
        this.buffers?.dispose();
        this._leafAnchorSource = null;
        this._leafAnchorEmitters = [];
        this.simPass = null;
        this.renderPass = null;
        this.buffers = null;
        this.emitters = [];
        this._weatherRainEmitter = null;
        this._weatherRainIdleFrames = 0;
        this._initialized = false;
    }
}
