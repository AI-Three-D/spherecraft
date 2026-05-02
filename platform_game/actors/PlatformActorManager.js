// platform_game/actors/PlatformActorManager.js
//
// ActorManager subclass for the platform jumper. Overrides player
// creation so the character is an unskinned primitive sphere rendered
// through GenericMeshRenderer — no GLTF, no animation pipeline.
// Movement still runs through the shared GPU MovementResolverPipeline
// (gravity-to-surface + terrain walk), so controls and gravity behave
// identically to the wizard build.

import { ActorManager } from '../../wizard_game/actors/ActorManager.js';
import { CharacterActor } from '../../wizard_game/actors/CharacterActor.js';
import { ActorType } from '../../wizard_game/actors/ActorState.js';
import { PlatformColliderSystem } from '../../core/actors/PlatformColliderSystem.js';
import { Logger } from '../../shared/Logger.js';
import { BallModel } from './BallModel.js';
import { PlatformPlayerController } from './PlatformPlayerController.js';

export class PlatformActorManager extends ActorManager {
    constructor(options) {
        super(options);
        this.genericMeshRenderer = options.genericMeshRenderer ?? null;
        this._ballModel = null;

        // Platform top-surface colliders consumed by the movement resolver.
        // `platformColliderSystem` is the convention the base ActorManager
        // reads in dispatchCompute() to pick up bindings 8 & 9.
        this.platformColliderSystem = new PlatformColliderSystem(
            options.device, options.maxPlatformColliders ?? 128
        );
    }

    /**
     * Platform_game player: a plain sphere. No GLTF, no skeleton.
     * The MovementResolverPipeline reads only actor.position / yaw /
     * collisionRadius / maxSlope, so it's blissfully unaware of visuals.
     */
    async createPlayer(_charDescriptorUrl, spawnPos) {
        const cfg = this.engineConfig?.player ?? {};
        const ballOpts = this.engineConfig?.platformGame?.ball ?? {};

        const radius = ballOpts.radius ?? 0.55;
        const collisionRadius = ballOpts.collisionRadius ?? radius;

        const physics = this.engineConfig?.physics ?? {};
        const actor = new CharacterActor({
            type: ActorType.PLAYER,
            name: 'Ball',
            modelScale: 1.0,
            modelYawOffset: 0,
            moveSpeed: ballOpts.moveSpeed ?? 6.0,
            sprintMultiplier: ballOpts.sprintMultiplier ?? 1.5,
            collisionRadius,
            maxSlopeDeg: ballOpts.maxSlopeDeg ?? 55,
            health:    ballOpts.health    ?? 100,
            maxHealth: ballOpts.maxHealth ?? 100,
            stamina:           cfg.staminaMax ?? 100,
            maxStamina:        cfg.staminaMax ?? 100,
            hunger:            cfg.hungerMax  ?? 100,
            maxHunger:         cfg.hungerMax  ?? 100,
            temperature:       cfg.temperatureNeutral ?? 50,
            minTemperature:    cfg.temperatureMin ?? 0,
            maxTemperature:    cfg.temperatureMax ?? 100,
            temperatureNeutral:cfg.temperatureNeutral ?? 50,
            statusText: 'Ready',
        });
        // Opt into the resolver's physics mode (gravity + jump impulses).
        actor.gravityScale = physics.gravityScale ?? 1.0;
        actor.jumpVelocity = ballOpts.jumpVelocity ?? physics.jumpVelocity ?? 8.5;

        actor.setPosition(spawnPos.x, spawnPos.y, spawnPos.z);

        // No GLTF, no skeleton, no animPlayer, no renderInstance.
        actor.modelDescriptor = null;
        actor.animPlayer = null;
        actor.renderInstance = null;

        // Register the ball mesh with GenericMeshRenderer. It's kept at
        // actor position each frame via syncBallToActor().
        const ball = new BallModel({
            name: 'PlayerBall',
            radius,
            color: ballOpts.color ?? { r: 0.28, g: 0.60, b: 1.0 },
            emissive: ballOpts.emissive ?? { r: 0.08, g: 0.18, b: 0.38 },
            emissiveIntensity: ballOpts.emissiveIntensity ?? 0.25
        });
        // Position BEFORE registration — addModel awaits the async backend
        // initialize and a render frame can fire during that await.
        ball.syncToActor(actor, this.planetConfig?.origin);
        if (this.genericMeshRenderer) {
            await this.genericMeshRenderer.addModel('player-ball', ball);
        } else {
            Logger.warn('[PlatformActorManager] no GenericMeshRenderer provided — ball invisible');
        }
        this._ballModel = ball;

        actor.gpuSlot = this._actors.length;
        this._actors.push(actor);
        this._buffers.activeCount = this._actors.length;
        this._buffers.seedState(actor.gpuSlot, spawnPos.x, spawnPos.y, spawnPos.z, 0);

        this._playerActor = actor;
        this._playerController = new PlatformPlayerController(actor);

        Logger.info(`[PlatformActorManager] Ball player created at (${spawnPos.x.toFixed(1)}, ${spawnPos.y.toFixed(1)}, ${spawnPos.z.toFixed(1)})`);
        return actor;
    }

    /** Push the latest post-readback actor state onto the ball mesh. */
    resolveReadback() {
        super.resolveReadback();
        if (this._ballModel && this._playerActor) {
            this._ballModel.syncToActor(this._playerActor, this.planetConfig?.origin);
            this._logFrame = (this._logFrame ?? 0) + 1;
            if (this._logFrame % 120 === 1) {
                const p = this._playerActor.position;
                Logger.info(
                    `[PlatformActorManager] ball pos=(${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}) ` +
                    `alt=${(this._playerActor.altitude ?? 0).toFixed(1)} ` +
                    `vertVel=${(this._playerActor.vertVel ?? 0).toFixed(2)} ` +
                    `grounded=${this._playerActor.grounded}`
                );
            }
        }
    }

    /** Platform-specific per-frame bookkeeping (stamina, coyote-timer). */
    update(dt, inputState) {
        super.update(dt, inputState);
        if (this._playerController?.tick) {
            this._playerController.tick(dt);
        }
    }
}
