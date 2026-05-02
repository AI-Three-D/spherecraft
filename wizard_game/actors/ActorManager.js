// js/actors/ActorManager.js

import { Vector3, Matrix4, clamp } from '../../shared/math/index.js';
import { Logger } from '../../shared/Logger.js';
import { CharacterActor } from './CharacterActor.js';
import { CharacterController } from './CharacterController.js';
import { CharacterCameraController } from './CharacterCameraController.js';
import { ActorGPUBuffers } from './ActorGPUBuffers.js';
import { MovementResolverPipeline } from './MovementResolverPipeline.js';
import { AnimationPlayer } from '../../shared/gltf/AnimationPlayer.js';
import { CharacterDescriptor } from './config/CharacterDescriptor.js';
// Navigation imports
import { TerrainRaycaster } from './nav/TerrainRaycaster.js';
import { ObjectPicker } from './nav/ObjectPicker.js';
import { LocalPathfinder } from './nav/LocalPathfinder.js';
import { NavigationController } from './nav/NavigationController.js';
import { DestinationMarker } from './nav/DestinationMarker.js';
import {
    ActorType, MovementState, AnimationId,
    AnimationPolicy, DEFAULT_ANIMATION_POLICY,
    IntentFlags,
} from './ActorState.js';

export class ActorManager {
    constructor(options) {
        this._modelCache = new Map();  
        this.treeDetailSystem = options.treeDetailSystem;
        this.device = options.device;
        this.planetConfig = options.planetConfig;
        this.quadtreeGPU = options.quadtreeGPU;
        this.tileStreamer = options.tileStreamer;
        this.engineConfig = options.engineConfig;
        this.skinnedMeshRenderer = options.skinnedMeshRenderer;
        this.assetStreamer = options.assetStreamer;
        this.backend = options.backend;
        this._actors = [];
        this._playerActor = null;
        this._playerController = null;
        this._cameraController = null;
        this._navController = null;
        this._npcManager = null;

        this._buffers = null;
        this._resolver = null;
        this._initialized = false;

        this._tmpMat = new Matrix4();
    }


    async initialize() {
        this._buffers = new ActorGPUBuffers(this.device, 64);
        this._resolver = new MovementResolverPipeline(
            this.device, this.tileStreamer?.textureFormats ?? {}
        );
        this._resolver.initialize();

        const cameraFollowConfig = this.engineConfig?.camera?.characterFollow ?? {};
        this._cameraController = new CharacterCameraController({
            followHeight: cameraFollowConfig.followHeight,
            followDistance: cameraFollowConfig.followDistance,
            snapBackOnRelease: cameraFollowConfig.snapBackOnRelease,
            snapBackSpeed: cameraFollowConfig.snapBackSpeed,
            orbitSensitivity: cameraFollowConfig.orbitSensitivity,
            smoothing: cameraFollowConfig.smoothing,
            walkFollowPitch: (cameraFollowConfig.walkFollowPitchDeg ?? 30) * Math.PI / 180,
            walkPitchApproachSpeed: cameraFollowConfig.walkPitchApproachSpeed,
            stopPitchApproachSpeed: cameraFollowConfig.stopPitchApproachSpeed,
            stopPitchReturnFraction: cameraFollowConfig.stopPitchReturnFraction,
            maxTotalPitch: (cameraFollowConfig.maxTotalPitchDeg ?? 75) * Math.PI / 180,
        });
        if (this.planetConfig?.origin) {
            this._cameraController.setPlanetCenter(this.planetConfig.origin);
        }

        // ── Initialize navigation subsystems ─────────────────────────
        const terrainRaycaster = new TerrainRaycaster(this.device, this.tileStreamer);
        terrainRaycaster.initialize();

        const objectPicker = new ObjectPicker(this.device);
        objectPicker.initialize();

        const pathfinder = new LocalPathfinder(this.device);
        pathfinder.initialize();

        let marker = null;
        if (this.backend) {
            marker = new DestinationMarker(this.device, this.backend);
            await marker.initialize();
        }

        this._navController = new NavigationController({
            device: this.device,
            planetConfig: this.planetConfig,
            quadtreeGPU: this.quadtreeGPU,
            tileStreamer: this.tileStreamer,
            treeDetailSystem: this.treeDetailSystem,
            terrainRaycaster,
            objectPicker,
            pathfinder,
            marker,
        });

        this._initialized = true;
        Logger.info('[ActorManager] initialized with navigation');
    }

    get playerActor() { return this._playerActor; }
    get cameraController() { return this._cameraController; }
    get navController() { return this._navController; }
    get destinationMarker() { return this._navController?.marker; }
    get npcManager() { return this._npcManager; }

    setNPCManager(npcManager) {
        this._npcManager = npcManager;
    }

    async createPlayer(charDescriptorUrl, spawnPos) {
        const { GLTFLoader } = await import('../../shared/gltf/GLTFLoader.js');
        const loader = new GLTFLoader({ verbose: false });
    
        const desc = await CharacterDescriptor.load(charDescriptorUrl, loader, this._modelCache);
        const model = desc.model;
    
        const actor = new CharacterActor({
            name: 'Player',
            modelScale:       desc.scale,
            modelYawOffset:   model.yawOffset,
            moveSpeed:        desc.moveSpeed,
            sprintMultiplier: desc.sprintMultiplier,
            collisionRadius:  desc.collisionRadius,
            maxSlopeDeg:      desc.maxSlopeDeg,
            health:           desc.health,
            maxHealth:        desc.maxHealth,
            // engineConfig-sourced vitals stay the same:
            stamina:            this.engineConfig?.player?.staminaMax ?? 100,
            maxStamina:         this.engineConfig?.player?.staminaMax ?? 100,
            hunger:             this.engineConfig?.player?.hungerMax ?? 100,
            maxHunger:          this.engineConfig?.player?.hungerMax ?? 100,
            temperature:        this.engineConfig?.player?.temperatureNeutral ?? 50,
            minTemperature:     this.engineConfig?.player?.temperatureMin ?? 0,
            maxTemperature:     this.engineConfig?.player?.temperatureMax ?? 100,
            temperatureNeutral: this.engineConfig?.player?.temperatureNeutral ?? 50,
            statusText: 'Ready',
        });
        actor.setPosition(spawnPos.x, spawnPos.y, spawnPos.z);
    
        actor.modelDescriptor = model;
        actor.animPlayer = new AnimationPlayer(model.asset, model);
    
        const wm = this._buildWorldMatrix(actor);
        actor.renderInstance = this.skinnedMeshRenderer
            ? await this.skinnedMeshRenderer.addInstance(model.asset, wm, { modelDescriptor: model })
            : null;

        actor.gpuSlot = this._actors.length;
        this._actors.push(actor);
        this._buffers.activeCount = this._actors.length;
        this._buffers.seedState(actor.gpuSlot, spawnPos.x, spawnPos.y, spawnPos.z, 0);
    
        this._playerActor = actor;
        this._playerController = new CharacterController(actor);
    
        this._syncLocomotionAnimation(actor);
        Logger.info(`[ActorManager] Player created (${model.glbUrl})`);
        return actor;
    }

    /**
     * Handle a screen click for navigation/interaction.
     * Must be called during the compute encoder phase.
     */
    handleScreenClick(screenX, screenY, camera, canvasW, canvasH, encoder) {
        if (this._playerActor?.isDown) return;
        if (!this._navController) return;
        this._navController.handleClick(screenX, screenY, camera, canvasW, canvasH, encoder);
    }

    // CPU: process input, write intent, upload.
    update(dt, inputState) {
        if (!this._initialized || !this._playerController) return;

        this._updateAnimationActions(dt);

        const playerCanAct = !!this._playerActor && !this._playerActor.isDown;
        if (playerCanAct) {
            this._playerController.processInput(
                inputState.keys,
                inputState.mouseDelta,
                inputState.isRightDragging,
                inputState.clickTarget
            );

            // ── Navigation update (click-to-move steering) ──────────
            if (this._navController && this._playerActor) {
                const hasWASD = inputState.keys['w'] || inputState.keys['s'] ||
                                inputState.keys['a'] || inputState.keys['d'];
                const a = this._playerActor;
                if (hasWASD) {
                    this._navController.clearDestination();
                }

                const navResult = this._navController.update(dt, a, null);
                if (navResult?.arrived) {
                    a.moveTarget = null;
                } else if (navResult?.target && !hasWASD) {
                    a.moveTarget = { ...navResult.target };
                }

                if (!hasWASD && a.moveTarget) {
                    this._steerActorTowardTarget(a, dt);
                }
            }

            this._updatePlayerVitals(dt);
        } else {
            this._playerController.reset();
            this._navController?.clearDestination();
            if (this._playerActor) {
                this._playerActor.moveTarget = null;
                this._playerActor.moveSpeed = 0;
            }
        }

        // ── NPC Manager tick (synchronous) ───────────────────────────
        if (this._npcManager && this._playerActor) {
            this._npcManager.update(dt, this._playerActor);
        }

        // ── Write intents for ALL actors (player + NPCs) ────────────
        for (const a of this._actors) {
            const ctrl = a === this._playerActor ? this._playerController : null;
            const intent = this._resolveActorIntent(a, ctrl, playerCanAct);
            this._buffers.writeIntent(
                a.gpuSlot,
                intent.flags,
                a.facingYaw,
                intent.speed,
                dt,
                intent.target,
                a.maxSlope,
                a.collisionRadius,
                intent.jumpVelocity ?? 0,
                intent.gravityScale ?? 1
            );
        }
        this._buffers.uploadIntents();

        const tileTexSize = this.engineConfig?.gpuQuadtree?.tileTextureSize ?? 128;
        this._buffers.uploadParams(this.planetConfig, this.quadtreeGPU, tileTexSize, {
            maxColliders: this.treeDetailSystem?.maxCloseTrees ?? 0,
            trunkRadiusScale: 0.08,
            trunkRadiusMin: 0.35,
            gravity: this.engineConfig?.physics?.gravity ?? 9.81,
            maxPlatforms: this.platformColliderSystem?.maxColliders ?? 0,
            groundStickSpeed: this.engineConfig?.physics?.groundStickSpeed ?? 0.05,
        });
    }

    /**
     * Process any queued NPC spawns. Call from an async-friendly context
     * (e.g. after render submit).
     */
    async processNPCSpawns() {
        if (this._npcManager) {
            await this._npcManager.processSpawnQueue();
        }
    }

    dispatchCompute(encoder) {
        if (!this._initialized || this._actors.length === 0) return;
        const textures = this.tileStreamer?.getArrayTextures?.() ?? {};
        const hashBuf = this.quadtreeGPU?.getLoadedTileTableBuffer?.();
        const ctBuf  = this.treeDetailSystem?.getCloseTreeBuffer?.();
        const ctcBuf = this.treeDetailSystem?.getCloseTreeCountBuffer?.();

        // Optional platform top-surface colliders. Games that provide
        // a PlatformColliderSystem expose these buffers; otherwise the
        // resolver falls back to dummies (zero-count).
        const pcs = this.platformColliderSystem ?? null;
        const cpBuf  = pcs?.getColliderBuffer?.() ?? null;
        const cpcBuf = pcs?.getColliderCountBuffer?.() ?? null;

        this._resolver.dispatch(
            encoder, this._actors.length, this._buffers,
            textures, hashBuf, ctBuf, ctcBuf, cpBuf, cpcBuf
        );

        // Dispatch pathfinder if navigation is active
        if (this._navController?._navActive && this._playerActor) {
            const nav = this._navController;
            if (nav._pathfindTimer >= nav._pathfindInterval && !nav._pathfindPending) {
                nav.pathfinder.dispatch(
                    encoder, this._playerActor.position, nav.destination,
                    this.planetConfig, ctBuf, ctcBuf,
                    this.treeDetailSystem?.maxCloseTrees ?? 0,
                    this._playerActor.collisionRadius ?? 0.4
                );
                nav._pathfindPending = true;
                nav._pathfindTimer = 0;
            }
        }

        this._buffers.beginReadback(encoder);
    }


async createNPC(charDesc, npcTypeId, spawnPos, options = {}) {
    if (this._actors.length >= this._buffers.maxActors) {
        Logger.warn('[ActorManager] Max actor slots reached, cannot spawn NPC');
        return null;
    }
    const model = charDesc.model;

    const actor = new CharacterActor({
        type: ActorType.NPC,
        name: options.name || `${npcTypeId}-${this._actors.length}`,
        modelScale:      options.modelScale      ?? charDesc.scale,
        modelYawOffset:  model.yawOffset,
        moveSpeed:       options.moveSpeed       ?? charDesc.moveSpeed,
        maxSlopeDeg:     options.maxSlopeDeg     ?? charDesc.maxSlopeDeg,
        collisionRadius: options.collisionRadius ?? charDesc.collisionRadius,
        health:          options.health          ?? charDesc.health,
        maxHealth:       options.maxHealth       ?? charDesc.maxHealth,
        locomotionRunThresholdMultiplier:
            options.locomotionRunThresholdMultiplier ?? 1.15,
        // NPC-specific — no charDesc default:
        hostility:       options.hostility ?? 0.0,
        braveness:       options.braveness ?? 0.5,
        npcTypeId,
        groupId:         options.groupId ?? 0,
        variant:         options.variant ?? null,
        isBoss:          options.isBoss  ?? false,
    });
    actor.setPosition(spawnPos.x, spawnPos.y, spawnPos.z);
    actor.facingYaw = Math.random() * Math.PI * 2 - Math.PI;

    actor.modelDescriptor = model;
    actor.animPlayer = new AnimationPlayer(model.asset, model);

    const wm = this._buildWorldMatrix(actor);
    actor.renderInstance = this.skinnedMeshRenderer
        ? await this.skinnedMeshRenderer.addInstance(model.asset, wm, { modelDescriptor: model })
        : null;

    actor.gpuSlot = this._actors.length;
    this._actors.push(actor);
    this._buffers.activeCount = this._actors.length;
    this._buffers.seedState(actor.gpuSlot, spawnPos.x, spawnPos.y, spawnPos.z, actor.facingYaw);

    this._syncLocomotionAnimation(actor);
    Logger.info(
        `[ActorManager] NPC "${actor.name}" slot ${actor.gpuSlot}, scale=${actor.modelScale.toFixed(2)}`
    );
    return actor;
}

    /**
     * Remove an actor (player or NPC) and free its GPU slot.
     * Uses swap-and-compact to keep GPU slots contiguous.
     */
    removeActor(actor) {
        if (!actor || actor.gpuSlot < 0) return;

        const slot    = actor.gpuSlot;
        const lastIdx = this._actors.length - 1;

        // Sanity check
        if (slot > lastIdx || this._actors[slot] !== actor) {
            Logger.warn(`[ActorManager] removeActor: slot mismatch for "${actor.name}"`);
            return;
        }

        // Remove render instance
        if (actor.renderInstance) {
            this.skinnedMeshRenderer.removeInstance(actor.renderInstance);
            actor.renderInstance = null;
        }

        // Swap-and-compact: move last actor into the freed slot
        if (slot < lastIdx) {
            const lastActor = this._actors[lastIdx];
            this._actors[slot] = lastActor;
            lastActor.gpuSlot = slot;

            // Re-seed GPU state from CPU mirror of the swapped actor
            this._buffers.seedState(
                slot,
                lastActor.position.x, lastActor.position.y, lastActor.position.z,
                lastActor.facingYaw
            );
        }

        this._actors.length = lastIdx;
        this._buffers.activeCount = this._actors.length;
        actor.gpuSlot = -1;

        // Guard against removing the player
        if (actor === this._playerActor) {
            Logger.warn('[ActorManager] Player actor was removed!');
            this._playerActor = null;
            this._playerController = null;
        }
    }


    resolveReadback() {
        this._buffers.resolveReadback((results) => {
            for (let i = 0; i < results.length && i < this._actors.length; i++) {
                const a = this._actors[i];
                const r = results[i];

                const prevPos = { x: a.position.x, y: a.position.y, z: a.position.z };
                a.position.x = r.x;
                a.position.y = r.y;
                a.position.z = r.z;
                a.grounded = r.grounded;
                a.vertVel = r.vertVel ?? 0;
                a.airTime = r.airTime ?? 0;
                a.altitude = r.altitude ?? 0;
                a.lastImpactSpeed = r.lastImpactSpeed ?? 0;

                const ms = Math.round(r.moveState);
                const newState = ms === 1 ? MovementState.WALKING
                    : ms === 2 ? MovementState.BLOCKED
                    : MovementState.IDLE;
                a.movementState = newState;
                this._syncLocomotionAnimation(a);

                if (newState === MovementState.WALKING) {
                    if (a.moveTarget) {
                        // Click-to-move: rotate to face the destination.
                        // turnBlend 0.35 + maxTurnStep 0.25 rad gives ~14 deg/frame
                        // at 60 fps — snappy but visibly smooth.
                        this._steerActorTowardWorldDirection(a, {
                            x: a.moveTarget.x - a.position.x,
                            y: a.moveTarget.y - a.position.y,
                            z: a.moveTarget.z - a.position.z,
                        }, 0.35, 0.25);
                    } else {
                        // WASD: face the actual movement direction.
                        this._steerActorTowardWorldDirection(a, {
                            x: a.position.x - prevPos.x,
                            y: a.position.y - prevPos.y,
                            z: a.position.z - prevPos.z,
                        }, 0.45, 0.45);
                    }
                }

                if (a.isNPC && a.moveTarget) {
                    const arriveRadius = Math.max(1.25, a.collisionRadius * 2.5);
                    if (_distanceSquared(a.position, a.moveTarget) <= arriveRadius * arriveRadius) {
                        a.moveTarget = null;
                    }
                }

                if (a.renderInstance) {
                    const wm = this._buildWorldMatrix(a);
                    this.skinnedMeshRenderer.setInstanceTransform(a.renderInstance, wm);
                }
            }
        });

        // Resolve nav readbacks
        if (this._navController) {
            this._navController.resolveClicks((objectHit) => {
                Logger.info(`[ActorManager] Object interaction: ${objectHit.type} idx=${objectHit.objectIndex}`);
                // Future: trigger pickup, examine, etc.
            });
            this._navController.resolvePathfind();
        }
    }

    getCameraState(dt, isLeftDragging, mouseDelta, wheelDelta) {
        if (!this._playerActor) return null;
        this._cameraController.handleOrbit(mouseDelta, isLeftDragging);
        if (wheelDelta) this._cameraController.zoom(wheelDelta);
        return this._cameraController.update(this._playerActor, dt);
    }

    /**
     * Render the destination marker during the active render pass.
     * Call from Frontend after terrain/assets are drawn.
     */
    renderOverlays(passEncoder, camera, dt) {
        this._navController?.marker?.render(passEncoder, camera, dt);
    }

    beginActionAnimation(actor, animId, options = {}) {
        if (!actor?.animPlayer) return false;
        const clip = actor.modelDescriptor?.clip(animId);
        if (!clip) return false;
    
        // Resolve policy: explicit option > per-anim default > INTERRUPTIBLE
        const policy = options.policy
            ?? DEFAULT_ANIMATION_POLICY[animId]
            ?? AnimationPolicy.INTERRUPTIBLE;
    
        // TERMINAL state is permanent — nothing interrupts it.
        if (actor.animationAction?.policy === AnimationPolicy.TERMINAL) return false;
    
        // COMMITTED actions must finish before another non-TERMINAL anim starts.
        if (actor.animationAction?.policy === AnimationPolicy.COMMITTED
            && actor.animationAction?.state === 'playing'
            && policy !== AnimationPolicy.TERMINAL) {
            return false;
        }
    
        const speed = options.speed ?? 1.0;
        const realDuration = clip.anim.duration / Math.max(Math.abs(speed), 1e-4);
        const isTerminal = policy === AnimationPolicy.TERMINAL;
    
        actor.animationAction = {
            animId,
            policy,
            state: 'playing',
            elapsed: 0,
            duration: realDuration,
            speed,
            // lockMovement: COMMITTED and TERMINAL lock movement
            lockMovement: options.lockMovement
                ?? (policy === AnimationPolicy.COMMITTED || isTerminal),
            // holdLastFrame: only TERMINAL holds
            holdLastFrame: options.holdLastFrame ?? isTerminal,
        };
    
        actor.animPlayer.play(animId, {
            speed,
            loop: false,
            force: true,
            startTime: options.startTime ?? 0,
            blendTime: options.blendTime,
        });
        actor.currentAnimation = animId;
        actor.currentAnimationSpeed = speed;
        return true;
    }
    damageActor(actor, amount, options = {}) {
        if (!actor || actor.isDown || !(amount > 0)) {
            return { applied: false, defeated: !!actor?.isDown, health: actor?.health ?? 0 };
        }

        actor.health = Math.max(0, actor.health - amount);
        actor.statusText = actor.health > 0
            ? (options.statusText ?? 'Under attack')
            : (options.deathStatus ?? 'Down');

        const defeated = actor.health <= 0;
        if (defeated) {
            actor.isAlive = false;
            actor.isDown = true;
            actor.moveTarget = null;

            if (actor === this._playerActor) {
                this._playerController?.reset();
                this._navController?.clearDestination();
            }

            this.beginActionAnimation(actor, AnimationId.DEAD, {
                speed: options.deathAnimationSpeed ?? 1.0,
                policy: AnimationPolicy.TERMINAL,  
            });
        } else if (actor === this._playerActor) {
            this._triggerHitReaction(actor, amount, options.heavy === true);
        }

        Logger.info(
            `[ActorManager] ${actor.name || `actor#${actor.id}`} took ${amount.toFixed(1)} damage ` +
            `(${actor.health.toFixed(1)}/${actor.maxHealth.toFixed(1)})`
        );

        return {
            applied: true,
            defeated,
            health: actor.health,
            maxHealth: actor.maxHealth,
        };
    }

    _triggerHitReaction(actor, amount, isHeavyAttack) {
        // Clear any pending chained animation from a previous hit
        actor.pendingAnimationAction = null;

        // Navigation cleared by _updatePlayerVitals via lockMovement, but clear immediately too
        this._navController?.clearDestination();
        this._playerController?.clearMovementIntent();

        const isHeavy = isHeavyAttack || amount >= 18;

        if (isHeavy) {
            // Heavy knockback: FALLING then chain GETTING_UP
            actor.pendingAnimationAction = { animId: AnimationId.GETTING_UP, lockMovement: true };
            const started = this.beginActionAnimation(actor, AnimationId.FALLING, { lockMovement: true });
            if (!started) {
                // FALLING not in GLB — fallback to a long stagger hold
                actor.pendingAnimationAction = null;
                const hitAnim = AnimationId.HIT_FROM_FRONT_3;
                const fallbackDur = 1.2;
                if (!this.beginActionAnimation(actor, hitAnim, { lockMovement: true })) {
                    actor.animationAction = {
                        animId: hitAnim, state: 'playing', elapsed: 0,
                        duration: fallbackDur, speed: 1.0,
                        lockMovement: true, holdLastFrame: false,
                    };
                }
            }
        } else {
            // Light stagger: random hit animation
            const r = Math.random();
            const hitAnim = r < 0.4
                ? AnimationId.HIT_FROM_FRONT_1
                : r < 0.75
                    ? AnimationId.HIT_FROM_FRONT_3
                    : AnimationId.HIT_FROM_SIDE;
            if (!this.beginActionAnimation(actor, hitAnim, { lockMovement: true })) {
                // Fallback: brief movement lock with whatever anim is already playing
                actor.animationAction = {
                    animId: hitAnim, state: 'playing', elapsed: 0,
                    duration: 0.4 + amount * 0.015,
                    speed: 1.0, lockMovement: true, holdLastFrame: false,
                };
            }
        }
    }

    faceActorTowardPosition(actor, target, options = {}) {
        if (!actor || !target) return false;
        return this._steerActorTowardWorldDirection(actor, {
            x: target.x - actor.position.x,
            y: target.y - actor.position.y,
            z: target.z - actor.position.z,
        }, options.turnBlend ?? 1.0, options.maxTurnStep ?? Infinity);
    }

    getPlayerCombatState() {
        if (!this._playerActor) return null;
        const actor = this._playerActor;
        const activeThreats = this._npcManager?.activeNPCCount ?? 0;
        const temperatureState = this._getTemperatureState(actor);
        const statusParts = [];
        if (actor.conditionText) statusParts.push(actor.conditionText);
        if (actor.statusText) statusParts.push(actor.statusText);
        return {
            health: actor.health,
            maxHealth: actor.maxHealth,
            healthRatio: actor.maxHealth > 0 ? actor.health / actor.maxHealth : 0,
            stamina: actor.stamina,
            maxStamina: actor.maxStamina,
            staminaRatio: actor.maxStamina > 0 ? actor.stamina / actor.maxStamina : 0,
            hunger: actor.hunger,
            maxHunger: actor.maxHunger,
            hungerRatio: actor.maxHunger > 0 ? actor.hunger / actor.maxHunger : 0,
            temperature: actor.temperature,
            minTemperature: actor.minTemperature,
            maxTemperature: actor.maxTemperature,
            temperatureRatio: actor.maxTemperature > actor.minTemperature
                ? (actor.temperature - actor.minTemperature) / (actor.maxTemperature - actor.minTemperature)
                : 0.5,
            temperatureState,
            isSprinting: actor.moveSpeed > actor.baseMoveSpeed * 1.05,
            isExhausted: actor.isExhausted === true,
            isDown: actor.isDown,
            statusText: statusParts.filter(Boolean).join(' | ')
                || (actor.isDown ? 'Down' : (activeThreats > 0 ? 'Threat nearby' : 'Clear')),
            activeThreats,
        };
    }

    isPlayerDefeated() {
        return this._playerActor?.isDown === true;
    }


    _updatePlayerVitals(dt) {
        const actor = this._playerActor;
        const controller = this._playerController;
        const cfg = this.engineConfig?.player;
        if (!actor || !controller || !cfg) return;

        const exhaustedActionPlaying = actor.animationAction?.animId === AnimationId.EXHAUSTED
            && (actor.animationAction.state === 'playing' || actor.animationAction.state === 'holding');
        const movementLocked = actor.animationAction?.lockMovement === true;

        actor.hunger = clamp(actor.hunger - cfg.hungerDrainPerSec * dt, 0, actor.maxHunger);
        actor.temperature = clamp(
            _approach(actor.temperature, actor.temperatureNeutral, cfg.temperatureRecoverPerSec * dt),
            actor.minTemperature,
            actor.maxTemperature
        );

        if (actor.isExhausted && !exhaustedActionPlaying && actor.stamina >= cfg.sprintResumeThreshold) {
            actor.isExhausted = false;
        }

        const intendsMovement = (controller.intentFlags & (
            IntentFlags.MOVE_FORWARD
            | IntentFlags.MOVE_BACKWARD
            | IntentFlags.MOVE_LEFT
            | IntentFlags.MOVE_RIGHT
            | IntentFlags.MOVE_TO_TARGET
        )) !== 0;
        const canSprint = !actor.isExhausted && !movementLocked && actor.stamina > 1e-3;
        const sprinting = intendsMovement && controller.wantsSprint && canSprint;

        if (movementLocked) {
            actor.moveSpeed = 0;
            actor.stamina = clamp(
                actor.stamina + cfg.staminaRegenPerSec * (cfg.exhaustedRegenMultiplier ?? 2.5) * dt,
                0,
                actor.maxStamina
            );
            controller.clearMovementIntent();
            this._navController?.clearDestination();
        } else if (sprinting) {
            actor.moveSpeed = actor.baseMoveSpeed * actor.sprintMultiplier;
            actor.stamina = clamp(
                actor.stamina - cfg.staminaSprintDrainPerSec * this._getTemperaturePenaltyMultiplier(actor) * dt,
                0,
                actor.maxStamina
            );
        } else {
            actor.moveSpeed = actor.baseMoveSpeed;
            actor.stamina = clamp(actor.stamina + cfg.staminaRegenPerSec * dt, 0, actor.maxStamina);
        }

        if (sprinting && actor.stamina <= 1e-3) {
            this._triggerExhaustion(actor, controller, cfg);
            return;
        }

        const temperatureState = this._getTemperatureState(actor);
        if (actor.isExhausted) {
            actor.conditionText = 'Exhausted';
        } else if (temperatureState.key === 'cold') {
            actor.conditionText = temperatureState.severity === 'danger' ? 'Freezing' : 'Cold';
        } else if (temperatureState.key === 'hot') {
            actor.conditionText = temperatureState.severity === 'danger' ? 'Heat stroke risk' : 'Hot';
        } else if (sprinting) {
            actor.conditionText = 'Running';
        } else {
            actor.conditionText = '';
        }
    }

    _triggerExhaustion(actor, controller, cfg) {
        actor.stamina = 0;
        actor.isExhausted = true;
        actor.conditionText = 'Exhausted';
        actor.moveSpeed = 0;
        controller.clearMovementIntent();
        this._navController?.clearDestination();

        const started = this.beginActionAnimation(actor, AnimationId.EXHAUSTED, {
            speed: cfg.exhaustedAnimationSpeed ?? 1.0,
            holdLastFrame: false,
            lockMovement: true,
        });
        if (started) {
            return;
        }

        // Fallback lock even if the clip is missing, so exhaustion still halts the player.
        actor.animationAction = {
            animId: AnimationId.EXHAUSTED,
            state: 'playing',
            elapsed: 0,
            duration: cfg.exhaustedFallbackDurationSec ?? 1.6,
            speed: 1.0,
            lockMovement: true,
            holdLastFrame: false,
        };
    }

    _getTemperaturePenaltyMultiplier(actor) {
        const cfg = this.engineConfig?.player;
        const state = this._getTemperatureState(actor);
        if (!cfg || state.key === 'neutral') return 1.0;

        return 1.0 + (Math.max(1.0, cfg.staminaTemperaturePenaltyMax ?? 1.0) - 1.0)
            * clamp(state.intensity, 0, 1);
    }

    _getTemperatureState(actor) {
        const cfg = this.engineConfig?.player;
        if (!cfg || !actor) {
            return { key: 'neutral', severity: 'normal', intensity: 0 };
        }

        const temp = actor.temperature;
        if (temp <= cfg.temperatureColdWarn) {
            const intensity = cfg.temperatureColdWarn > cfg.temperatureColdDanger
                ? 1.0 - clamp(
                    (temp - cfg.temperatureColdDanger) / (cfg.temperatureColdWarn - cfg.temperatureColdDanger),
                    0,
                    1
                )
                : 1.0;
            return {
                key: 'cold',
                severity: temp <= cfg.temperatureColdDanger ? 'danger' : 'warn',
                intensity,
            };
        }
        if (temp >= cfg.temperatureHotWarn) {
            const intensity = cfg.temperatureHotDanger > cfg.temperatureHotWarn
                ? clamp(
                    (temp - cfg.temperatureHotWarn) / (cfg.temperatureHotDanger - cfg.temperatureHotWarn),
                    0,
                    1
                )
                : 1.0;
            return {
                key: 'hot',
                severity: temp >= cfg.temperatureHotDanger ? 'danger' : 'warn',
                intensity,
            };
        }
        return { key: 'neutral', severity: 'normal', intensity: 0 };
    }


    _resolveActorIntent(actor, controller, playerCanAct) {
        // Physics-capable actors carry these on the actor itself; legacy
        // terrain-snap actors leave them undefined → gravityScale=0.
        const jumpVelocity = actor?.jumpVelocity ?? 0;
        const gravityScale = actor?.gravityScale ?? 0;

        if (!actor || this._isMovementLocked(actor)) {
            return { flags: IntentFlags.NONE, target: null, speed: 0,
                     jumpVelocity, gravityScale };
        }

        if (actor === this._playerActor) {
            let flags = playerCanAct ? (controller?.intentFlags ?? IntentFlags.NONE) : IntentFlags.NONE;
            // Edge-triggered jump: controller.consumeJumpRequest() clears
            // the bit once it's been routed to the GPU this frame.
            if (playerCanAct && controller?.consumeJumpRequest?.()) {
                flags |= IntentFlags.JUMP;
            }
            return {
                flags,
                target: actor.moveTarget,
                speed: actor.moveSpeed,
                jumpVelocity,
                gravityScale,
            };
        }

        const flags = actor.moveTarget ? IntentFlags.MOVE_TO_TARGET : IntentFlags.NONE;
        return {
            flags,
            target: actor.moveTarget,
            speed: actor.moveSpeed,
            jumpVelocity,
            gravityScale,
        };
    }
    _updateAnimationActions(dt) {
        for (const actor of this._actors) {
            if (!actor.animPlayer) continue;
    
            const { pose, finished } = actor.animPlayer.tick(dt);
    
            if (actor.renderInstance) {
                this.skinnedMeshRenderer.setInstancePose(actor.renderInstance, pose);
            }
    
            if (finished && actor.animationAction?.state === 'playing') {
                this._onActionFinished(actor);
            }
        }
    }
    _onActionFinished(actor) {
        const action = actor.animationAction;
        if (!action) return;
    
        // TERMINAL: hold last frame, no further transitions ever.
        if (action.policy === AnimationPolicy.TERMINAL) {
            action.state = 'holding';
            return;
        }
    
        // COMMITTED with holdLastFrame (e.g. a custom hold): hold, don't chain.
        if (action.holdLastFrame) {
            action.state = 'holding';
            return;
        }
    
        actor.animationAction = null;
    
        if (!actor.isDown && actor.pendingAnimationAction) {
            const next = actor.pendingAnimationAction;
            actor.pendingAnimationAction = null;
            this.beginActionAnimation(actor, next.animId, {
                lockMovement: next.lockMovement ?? false,
            });
        } else {
            this._syncLocomotionAnimation(actor);
        }
    }
    
    _applyRootDelta(actor, delta) {
        const scale = actor.modelScale ?? 1;
        const dx = delta[0] * scale;
        const dz = delta[2] * scale;
        // delta[1] ignored — terrain height is GPU's job.
        if (Math.abs(dx) < 1e-5 && Math.abs(dz) < 1e-5) return;
    
        const o = this.planetConfig.origin, p = actor.position;
        const radial = Math.hypot(p.x-o.x, p.y-o.y, p.z-o.z);
        const up = new Vector3(p.x-o.x, p.y-o.y, p.z-o.z).normalize();
        const ref = Math.abs(up.y) > 0.99 ? new Vector3(0,0,1) : new Vector3(0,1,0);
        const right = new Vector3().crossVectors(up, ref).normalize();
        const fwd = new Vector3().crossVectors(right, up);
    
        const yaw = actor.facingYaw + (actor.modelYawOffset ?? 0);
        const c = Math.cos(yaw), s = Math.sin(yaw);
        // Model +X → tangent-right, +Z → tangent-forward, rotated by facing.
        const wdx = (right.x*c - fwd.x*s)*dx + (right.x*s + fwd.x*c)*dz;
        const wdy = (right.y*c - fwd.y*s)*dx + (right.y*s + fwd.y*c)*dz;
        const wdz = (right.z*c - fwd.z*s)*dx + (right.z*s + fwd.z*c)*dz;
    
        // Reproject onto sphere at same radial distance. The resolver will
        // terrain-snap on the next dispatch; we hold CPU-authoritative
        // position for the duration of the locked action (readback skipped).
        const nx = p.x+wdx-o.x, ny = p.y+wdy-o.y, nz = p.z+wdz-o.z;
        const nl = Math.hypot(nx,ny,nz) || 1;
        actor.position.x = o.x + nx/nl * radial;
        actor.position.y = o.y + ny/nl * radial;
        actor.position.z = o.z + nz/nl * radial;
    
        this._buffers.seedState(actor.gpuSlot,
            actor.position.x, actor.position.y, actor.position.z, actor.facingYaw);
    
        if (actor.renderInstance) {
            const wm = this._buildWorldMatrix(actor);
            this.skinnedMeshRenderer.setInstanceTransform(actor.renderInstance, wm);
        }
    }
    
    _shouldApplyRootDelta(actor) {
        // Action animations: CPU-authoritative position (resolver gets NONE intent).
        // Locomotion: GPU-authoritative, discard the delta.
        return actor.animationAction?.lockMovement === true;
    }


    _syncLocomotionAnimation(actor) {
        if (!actor?.animPlayer || this._isLocomotionAnimationLocked(actor)) return;
        const loco = this._resolveLocomotionPlayback(actor);
        actor.animPlayer.play(loco.animId, { speed: loco.speed, loop: true });
        actor.currentAnimation = loco.animId;
        actor.currentAnimationSpeed = loco.speed;
    }
    
    _isMovementLocked(actor) {
        const action = actor?.animationAction;
        if (!action) return actor?.isDown === true;
        if (actor?.isDown) return true;
        if (action.lockMovement && action.state === 'playing') return true;
        if (action.policy === AnimationPolicy.TERMINAL) return true;
        return false;
    }

    _isLocomotionAnimationLocked(actor) {
        const action = actor?.animationAction;
        if (!action) return false;
        if (actor?.isDown) return true;
        if (action.state === 'playing') return true;
        // TERMINAL holds forever — locomotion must never override it.
        if (action.state === 'holding' && action.policy === AnimationPolicy.TERMINAL) return true;
        return false;
    }

    _resolveLocomotionPlayback(actor) {
        if (actor?.movementState !== MovementState.WALKING) {
            return { animId: AnimationId.IDLE, speed: 1.0 };
        }
    
        const baseSpeed = Math.max(actor?.baseMoveSpeed ?? 0, 0.1);
        const moveSpeed = Math.max(actor?.moveSpeed ?? baseSpeed, 0);
        const runThresholdMultiplier = Math.max(
            actor?.locomotionRunThresholdMultiplier ?? 1.15, 1.01
        );
        const runThresholdSpeed = baseSpeed * runThresholdMultiplier;
        const hasRun = actor?.modelDescriptor?.has(AnimationId.RUNNING) === true;
    
        if (hasRun && moveSpeed >= runThresholdSpeed) {
            return {
                animId: AnimationId.RUNNING,
                speed: clamp(moveSpeed / runThresholdSpeed, 0.92, 1.35),
            };
        }
        return {
            animId: AnimationId.WALKING,
            speed: clamp(moveSpeed / baseSpeed, 0.75, 1.25),
        };
    }

    _buildWorldMatrix(actor) {
        const p = actor.position;
        const o = this.planetConfig.origin;
        const s = actor.modelScale;

        const up = new Vector3(p.x - o.x, p.y - o.y, p.z - o.z).normalize();
        const ref = Math.abs(up.y) > 0.99
            ? new Vector3(0, 0, 1) : new Vector3(0, 1, 0);
        const right = new Vector3().crossVectors(up, ref).normalize();
        const fwd = new Vector3().crossVectors(right, up);

        const visualYaw = actor.facingYaw + (actor.modelYawOffset ?? 0);
        const c = Math.cos(visualYaw), si = Math.sin(visualYaw);
        const rRot = new Vector3(
            right.x * c - fwd.x * si, right.y * c - fwd.y * si, right.z * c - fwd.z * si
        );
        const fRot = new Vector3(
            right.x * si + fwd.x * c, right.y * si + fwd.y * c, right.z * si + fwd.z * c
        );

        const e = this._tmpMat.elements;
        e[0] = rRot.x * s; e[1] = rRot.y * s; e[2] = rRot.z * s; e[3] = 0;
        e[4] = up.x * s;   e[5] = up.y * s;   e[6] = up.z * s;   e[7] = 0;
        e[8] = fRot.x * s; e[9] = fRot.y * s; e[10] = fRot.z * s; e[11] = 0;
        e[12] = p.x;       e[13] = p.y;       e[14] = p.z;        e[15] = 1;
        return this._tmpMat;
    }

    _steerActorTowardTarget(actor, dt) {
        const pos = actor.position;
        const target = actor.moveTarget;
        if (!target || dt <= 0) return false;
        return this._steerActorTowardWorldDirection(actor, {
            x: target.x - pos.x,
            y: target.y - pos.y,
            z: target.z - pos.z,
        }, Math.min(1, dt * 15), 7 * dt);
    }

    _steerActorTowardWorldDirection(actor, worldDir, turnBlend = 1, maxTurnStep = Infinity) {
        if (!worldDir) return false;

        const o = this.planetConfig.origin;
        const pos = actor.position;
        const up = new Vector3(pos.x - o.x, pos.y - o.y, pos.z - o.z).normalize();
        const ref = Math.abs(up.y) > 0.99
            ? new Vector3(0, 0, 1) : new Vector3(0, 1, 0);
        const right = new Vector3().crossVectors(up, ref).normalize();
        const fwd = new Vector3().crossVectors(right, up).normalize();

        const tangentDir = new Vector3(
            worldDir.x,
            worldDir.y,
            worldDir.z
        );
        const radial = up.clone().multiplyScalar(tangentDir.dot(up));
        tangentDir.sub(radial);

        const len = tangentDir.length();
        if (len < 1e-4) return false;
        tangentDir.multiplyScalar(1 / len);

        // facingYaw is the shared logical yaw for movement and camera follow.
        // modelYawOffset only corrects the rendered mesh's authored forward axis.
        const desiredYaw = Math.atan2(tangentDir.dot(right), tangentDir.dot(fwd));
        const delta = _wrapAngle(desiredYaw - actor.facingYaw);

        const step = clamp(delta * turnBlend, -maxTurnStep, maxTurnStep);
        if (Math.abs(step) < 1e-4) return false;
        actor.facingYaw = _wrapAngle(actor.facingYaw + step);
        if (actor.renderInstance) {
            const wm = this._buildWorldMatrix(actor);
            this.skinnedMeshRenderer.setInstanceTransform(actor.renderInstance, wm);
        }
        return true;
    }

    dispose() {
        this._navController?.dispose();
        this._buffers?.dispose();
        for (const a of this._actors) {
            if (a.renderInstance) this.skinnedMeshRenderer.removeInstance(a.renderInstance);
        }
    }
}

function _wrapAngle(angle) {
    const tau = Math.PI * 2;
    let wrapped = ((angle % tau) + tau) % tau;
    if (wrapped > Math.PI) wrapped -= tau;
    return wrapped;
}

function _distanceSquared(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return dx * dx + dy * dy + dz * dz;
}

function _approach(current, target, maxStep) {
    if (current < target) return Math.min(target, current + maxStep);
    if (current > target) return Math.max(target, current - maxStep);
    return current;
}
