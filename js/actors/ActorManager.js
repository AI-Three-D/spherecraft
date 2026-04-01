// js/actors/ActorManager.js
//
// UPDATED — integrates NavigationController for click-to-move pathfinding.

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.178.0/build/three.module.js';
import { Logger } from '../config/Logger.js';
import { CharacterActor } from './CharacterActor.js';
import { CharacterController } from './CharacterController.js';
import { CharacterCameraController } from './CharacterCameraController.js';
import { ActorGPUBuffers } from './ActorGPUBuffers.js';
import { MovementResolverPipeline } from './MovementResolverPipeline.js';
import { AnimationSampler } from '../assets/gltf/AnimationSampler.js';


// Navigation imports
import { TerrainRaycaster } from './nav/TerrainRaycaster.js';
import { ObjectPicker } from './nav/ObjectPicker.js';
import { LocalPathfinder } from './nav/LocalPathfinder.js';
import { NavigationController } from './nav/NavigationController.js';
import { DestinationMarker } from './nav/DestinationMarker.js';
import {
    ActorType,
    MovementState,
    AnimationId,
    IntentFlags,
    ANIMATION_NAME_PATTERNS
} from './ActorState.js';

export class ActorManager {
    constructor(options) {
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

        this._tmpMat = new THREE.Matrix4();
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


    async createPlayer(glbUrl, spawnPos, modelScale = 1.0) {
        const actor = new CharacterActor({
            name: 'Player',
            modelScale,
            moveSpeed: this.engineConfig?.player?.baseMoveSpeed ?? 4.0,
            maxSlopeDeg: 45,
            health: 100,
            maxHealth: 100,
            stamina: this.engineConfig?.player?.staminaMax ?? 100,
            maxStamina: this.engineConfig?.player?.staminaMax ?? 100,
            hunger: this.engineConfig?.player?.hungerMax ?? 100,
            maxHunger: this.engineConfig?.player?.hungerMax ?? 100,
            temperature: this.engineConfig?.player?.temperatureNeutral ?? 50,
            minTemperature: this.engineConfig?.player?.temperatureMin ?? 0,
            maxTemperature: this.engineConfig?.player?.temperatureMax ?? 100,
            temperatureNeutral: this.engineConfig?.player?.temperatureNeutral ?? 50,
            sprintMultiplier: this.engineConfig?.player?.sprintMultiplier ?? 1.75,
            statusText: 'Ready',
        });
        actor.setPosition(spawnPos.x, spawnPos.y, spawnPos.z);

        const { GLTFLoader } = await import('../assets/gltf/GLTFLoader.js');
        const loader = new GLTFLoader({ verbose: false });
        const asset = await loader.loadFromURL(glbUrl);

        this._buildAnimationMap(actor, asset);

        const wm = this._buildWorldMatrix(actor);
        actor.renderInstance = await this.skinnedMeshRenderer.addInstance(asset, wm);

        actor.gpuSlot = this._actors.length;
        this._actors.push(actor);
        this._buffers.activeCount = this._actors.length;
        this._buffers.seedState(actor.gpuSlot, spawnPos.x, spawnPos.y, spawnPos.z, 0);

        this._playerActor = actor;
        this._playerController = new CharacterController(actor);

        this._syncLocomotionAnimation(actor);
        Logger.info(`[ActorManager] Player created, ${actor.animationMap.size} anims mapped`);
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
                a.collisionRadius
            );
        }
        this._buffers.uploadIntents();

        const tileTexSize = this.engineConfig?.gpuQuadtree?.tileTextureSize ?? 128;
        this._buffers.uploadParams(this.planetConfig, this.quadtreeGPU, tileTexSize, {
            maxColliders: this.treeDetailSystem?.maxCloseTrees ?? 0,
            trunkRadiusScale: 0.08,
            trunkRadiusMin: 0.35,
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

        this._resolver.dispatch(
            encoder, this._actors.length, this._buffers,
            textures, hashBuf, ctBuf, ctcBuf
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

       /**
     * Create an NPC actor from a pre-loaded GLTF asset.
     * Called by NPCManager during spawn processing.
     *
     * @param {object}  asset      Parsed GLTF asset (from GLTFLoader)
     * @param {string}  npcTypeId  Registry key (e.g. 'goblin')
     * @param {{x,y,z}} spawnPos   Approximate world position (GPU will snap to terrain)
     * @param {object}  [options]  CharacterActor constructor overrides + NPC metadata
     * @returns {Promise<CharacterActor|null>}
     */
       async createNPC(asset, npcTypeId, spawnPos, options = {}) {
        if (this._actors.length >= this._buffers.maxActors) {
            Logger.warn('[ActorManager] Max actor slots reached, cannot spawn NPC');
            return null;
        }

        const actor = new CharacterActor({
            type: ActorType.NPC,
            name: options.name || `${npcTypeId}-${this._actors.length}`,
            modelScale:      options.modelScale ?? 1.0,
            moveSpeed:       options.moveSpeed ?? 3.0,
            locomotionRunThresholdMultiplier:
                options.locomotionRunThresholdMultiplier ?? 1.15,
            maxSlopeDeg:     options.maxSlopeDeg ?? 45,
            collisionRadius: options.collisionRadius ?? 0.3,
            health:          options.health ?? 100,
            maxHealth:       options.maxHealth ?? 100,
            hostility:       options.hostility ?? 0.0,
            braveness:       options.braveness ?? 0.5,
            npcTypeId,
            groupId:         options.groupId ?? 0,
            variant:         options.variant ?? null,
            isBoss:          options.isBoss ?? false,
        });

        actor.setPosition(spawnPos.x, spawnPos.y, spawnPos.z);

        // Random initial facing for visual variety
        actor.facingYaw = Math.random() * Math.PI * 2 - Math.PI;

        this._buildAnimationMap(actor, asset);

        const wm = this._buildWorldMatrix(actor);
        actor.renderInstance = await this.skinnedMeshRenderer.addInstance(asset, wm);

        actor.gpuSlot = this._actors.length;
        this._actors.push(actor);
        this._buffers.activeCount = this._actors.length;
        this._buffers.seedState(
            actor.gpuSlot,
            spawnPos.x, spawnPos.y, spawnPos.z,
            actor.facingYaw
        );

        this._syncLocomotionAnimation(actor);

        Logger.info(
            `[ActorManager] NPC "${actor.name}" (${options.variant ?? 'default'}) ` +
            `created at slot ${actor.gpuSlot}, scale=${actor.modelScale.toFixed(2)}`
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
                if (a.animationAction?.animId === AnimationId.EXHAUSTED
                    && a.animationAction?.lockMovement === true) {
                    continue;
                }
                const prevPos = { x: a.position.x, y: a.position.y, z: a.position.z };
                a.position.x = r.x;
                a.position.y = r.y;
                a.position.z = r.z;
                a.grounded = r.grounded;

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
        if (!actor?.renderInstance) return false;

        const speed = options.speed ?? 1.0;
        const clipDuration = this._getAnimationDuration(actor, animId);
        if (!(clipDuration > 0)) {
            return false;
        }

        const realDuration = clipDuration / Math.max(Math.abs(speed), 1e-4);
        actor.animationAction = {
            animId,
            state: 'playing',
            elapsed: 0,
            duration: realDuration,
            speed,
            lockMovement: options.lockMovement ?? true,
            holdLastFrame: options.holdLastFrame ?? false,
        };

        this._playAnimation(actor, animId, {
            speed,
            startTime: options.startTime ?? 0,
            forceRestart: true,
        });
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
                holdLastFrame: true,
                lockMovement: true,
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

    // ── private ──────────────────────────────────────────────────────
    _buildAnimationMap(actor, asset) {
        const idName = {};
        for (const [k, v] of Object.entries(AnimationId)) idName[v] = k;

        Logger.info(`[ActorManager] GLB contains ${asset.animations.length} animation(s):`);
        for (let i = 0; i < asset.animations.length; i++) {
            const name = asset.animations[i].name || '';
            const dur = asset.animations[i].duration.toFixed(2);
            let matchedAs = null;
            for (const pat of ANIMATION_NAME_PATTERNS) {
                if (pat.re.test(name)) {
                    if (!actor.animationMap.has(pat.id)) {
                        actor.animationMap.set(pat.id, i);
                        matchedAs = idName[pat.id];
                    } else {
                        matchedAs = `${idName[pat.id]} (already mapped, skipped)`;
                    }
                    break;
                }
            }
            Logger.info(
                `[ActorManager]   [${i}] "${name}" (${dur}s) → ${matchedAs ?? 'UNMATCHED'}`
            );
        }

        Logger.info('[ActorManager] Resolved animation map:');
        for (const [id, idx] of actor.animationMap) {
            Logger.info(
                `[ActorManager]   ${idName[id]} = glb[${idx}] "${asset.animations[idx].name}"`
            );
        }

        if (!actor.animationMap.has(AnimationId.IDLE))
            Logger.warn('[ActorManager] No IDLE animation matched!');
        if (!actor.animationMap.has(AnimationId.WALKING))
            Logger.warn('[ActorManager] No WALKING animation matched!');
    }

    _updatePlayerVitals(dt) {
        const actor = this._playerActor;
        const controller = this._playerController;
        const cfg = this.engineConfig?.player;
        if (!actor || !controller || !cfg) return;

        const exhaustedActionPlaying = actor.animationAction?.animId === AnimationId.EXHAUSTED
            && (actor.animationAction.state === 'playing' || actor.animationAction.state === 'holding');
        const movementLocked = actor.animationAction?.lockMovement === true;

        actor.hunger = _clamp(actor.hunger - cfg.hungerDrainPerSec * dt, 0, actor.maxHunger);
        actor.temperature = _clamp(
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
            actor.stamina = _clamp(
                actor.stamina + cfg.staminaRegenPerSec * (cfg.exhaustedRegenMultiplier ?? 2.5) * dt,
                0,
                actor.maxStamina
            );
            controller.clearMovementIntent();
            this._navController?.clearDestination();
        } else if (sprinting) {
            actor.moveSpeed = actor.baseMoveSpeed * actor.sprintMultiplier;
            actor.stamina = _clamp(
                actor.stamina - cfg.staminaSprintDrainPerSec * this._getTemperaturePenaltyMultiplier(actor) * dt,
                0,
                actor.maxStamina
            );
        } else {
            actor.moveSpeed = actor.baseMoveSpeed;
            actor.stamina = _clamp(actor.stamina + cfg.staminaRegenPerSec * dt, 0, actor.maxStamina);
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
            * _clamp(state.intensity, 0, 1);
    }

    _getTemperatureState(actor) {
        const cfg = this.engineConfig?.player;
        if (!cfg || !actor) {
            return { key: 'neutral', severity: 'normal', intensity: 0 };
        }

        const temp = actor.temperature;
        if (temp <= cfg.temperatureColdWarn) {
            const intensity = cfg.temperatureColdWarn > cfg.temperatureColdDanger
                ? 1.0 - _clamp(
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
                ? _clamp(
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

    _playAnimation(actor, animId, options = {}) {
        if (!actor.renderInstance) return;
        const glbIdx = actor.animationMap.get(animId);
        if (glbIdx === undefined) return;
        const speed = options.speed ?? 1.0;
        if (!options.forceRestart && actor.currentAnimation === animId) {
            if (Math.abs((actor.currentAnimationSpeed ?? 1.0) - speed) > 1e-3) {
                this.skinnedMeshRenderer.setAnimationSpeed?.(actor.renderInstance, speed);
                actor.currentAnimationSpeed = speed;
            }
            return;
        }
        this.skinnedMeshRenderer.playAnimation(actor.renderInstance, glbIdx, {
            speed,
            startTime: options.startTime ?? 0,
        });
        actor.currentAnimation = animId;
        actor.currentAnimationSpeed = speed;
    }

    _resolveActorIntent(actor, controller, playerCanAct) {
        if (!actor || this._isMovementLocked(actor)) {
            return { flags: IntentFlags.NONE, target: null, speed: 0 };
        }

        if (actor === this._playerActor) {
            return {
                flags: playerCanAct ? (controller?.intentFlags ?? IntentFlags.NONE) : IntentFlags.NONE,
                target: actor.moveTarget,
                speed: actor.moveSpeed,
            };
        }

        const flags = actor.moveTarget ? IntentFlags.MOVE_TO_TARGET : IntentFlags.NONE;
        return {
            flags,
            target: actor.moveTarget,
            speed: actor.moveSpeed,
        };
    }

    _updateAnimationActions(dt) {
        for (const actor of this._actors) {
            const action = actor.animationAction;
            if (!action || action.state !== 'playing') continue;

            const prevElapsed = action.elapsed;
            action.elapsed += dt;
            this._applyActionRootMotion(actor, action, prevElapsed, action.elapsed);
            if (action.elapsed + 1e-5 < action.duration) continue;

            if (action.holdLastFrame) {
                action.state = 'holding';
                const clipDuration = this._getAnimationDuration(actor, action.animId);
                this._playAnimation(actor, action.animId, {
                    speed: 0,
                    startTime: Math.max(0, clipDuration - (1 / 60)),
                    forceRestart: true,
                });
                continue;
            }

            actor.animationAction = null;
            if (!actor.isDown && actor.pendingAnimationAction) {
                const next = actor.pendingAnimationAction;
                actor.pendingAnimationAction = null;
                this.beginActionAnimation(actor, next.animId, { lockMovement: next.lockMovement ?? false });
            } else {
                this._syncLocomotionAnimation(actor);
            }
        }
    }

    _applyActionRootMotion(actor, action, prevElapsed, nextElapsed) {
        if (action?.animId !== AnimationId.EXHAUSTED) return;
        if (!actor?.renderInstance?.asset) return;

        const glbIdx = actor.animationMap.get(action.animId);
        const anim = glbIdx === undefined
            ? null
            : actor.renderInstance.asset.animations?.[glbIdx];
        if (!anim || !(anim.duration > 0)) return;

        const channel = this._getRootMotionChannel(actor.renderInstance.asset, anim);
        if (!channel) return;

        const t0 = _clamp(prevElapsed * (action.speed ?? 1.0), 0, anim.duration);
        const t1 = _clamp(nextElapsed * (action.speed ?? 1.0), 0, anim.duration);
        const p0 = AnimationSampler._sampleChannel(channel, t0);
        const p1 = AnimationSampler._sampleChannel(channel, t1);
        if (!p0 || !p1) return;

        const dx = (p1[0] - p0[0]) * (actor.modelScale ?? 1);
        const dz = (p1[2] - p0[2]) * (actor.modelScale ?? 1);
        if (Math.abs(dx) < 1e-5 && Math.abs(dz) < 1e-5) return;

        const o = this.planetConfig.origin;
        const radialDistance = Math.hypot(
            actor.position.x - o.x,
            actor.position.y - o.y,
            actor.position.z - o.z
        );
        const up = new THREE.Vector3(
            actor.position.x - o.x,
            actor.position.y - o.y,
            actor.position.z - o.z
        ).normalize();
        const ref = Math.abs(up.y) > 0.99
            ? new THREE.Vector3(0, 0, 1)
            : new THREE.Vector3(0, 1, 0);
        const right = new THREE.Vector3().crossVectors(up, ref).normalize();
        const fwd = new THREE.Vector3().crossVectors(right, up);
        const visualYaw = actor.facingYaw + (actor.modelYawOffset ?? 0);
        const c = Math.cos(visualYaw);
        const s = Math.sin(visualYaw);
        const rightRot = new THREE.Vector3(
            right.x * c - fwd.x * s,
            right.y * c - fwd.y * s,
            right.z * c - fwd.z * s
        );
        const fwdRot = new THREE.Vector3(
            right.x * s + fwd.x * c,
            right.y * s + fwd.y * c,
            right.z * s + fwd.z * c
        );
        const moved = new THREE.Vector3(
            actor.position.x,
            actor.position.y,
            actor.position.z
        )
            .addScaledVector(rightRot, dx)
            .addScaledVector(fwdRot, dz);

        const movedDir = new THREE.Vector3(
            moved.x - o.x,
            moved.y - o.y,
            moved.z - o.z
        ).normalize();
        actor.position.x = o.x + movedDir.x * radialDistance;
        actor.position.y = o.y + movedDir.y * radialDistance;
        actor.position.z = o.z + movedDir.z * radialDistance;

        this._buffers.seedState(
            actor.gpuSlot,
            actor.position.x,
            actor.position.y,
            actor.position.z,
            actor.facingYaw
        );
        if (actor.renderInstance) {
            const wm = this._buildWorldMatrix(actor);
            this.skinnedMeshRenderer.setInstanceTransform(actor.renderInstance, wm);
        }
    }

    _getRootMotionChannel(asset, animation) {
        if (!animation) return null;
        if (animation._rootMotionChannel !== undefined) {
            return animation._rootMotionChannel;
        }

        let best = null;
        let bestDepth = Number.POSITIVE_INFINITY;
        let bestDispSq = -1;
        for (const ch of animation.channels) {
            if (ch.targetPath !== 'translation' || ch.targetNodeIndex < 0) continue;
            const node = asset?.nodes?.[ch.targetNodeIndex];
            let depth = 0;
            let cursor = node;
            while (cursor && cursor.parentIndex >= 0 && depth < 64) {
                depth++;
                cursor = asset.nodes[cursor.parentIndex];
            }
            const values = ch.values;
            const last = values ? values.length - 3 : -1;
            const dispSq = last >= 0
                ? ((values[last] - values[0]) ** 2 + (values[last + 2] - values[2]) ** 2)
                : 0;
            if (depth < bestDepth || (depth === bestDepth && dispSq > bestDispSq)) {
                best = ch;
                bestDepth = depth;
                bestDispSq = dispSq;
            }
        }

        animation._rootMotionChannel = best || null;
        return animation._rootMotionChannel;
    }

    _syncLocomotionAnimation(actor) {
        if (!actor || this._isLocomotionAnimationLocked(actor)) return;

        const locomotion = this._resolveLocomotionPlayback(actor);
        this._playAnimation(actor, locomotion.animId, {
            speed: locomotion.speed,
        });
    }

    _isMovementLocked(actor) {
        return actor?.isDown === true
            || actor?.animationAction?.lockMovement === true;
    }

    _isLocomotionAnimationLocked(actor) {
        const action = actor?.animationAction;
        return actor?.isDown === true
            || action?.state === 'playing'
            || action?.state === 'holding';
    }

    _getAnimationDuration(actor, animId) {
        const glbIdx = actor?.animationMap?.get(animId);
        if (glbIdx === undefined) return 0;
        return actor?.renderInstance?.asset?.animations?.[glbIdx]?.duration ?? 0;
    }

    _resolveLocomotionPlayback(actor) {
        if (actor?.movementState !== MovementState.WALKING) {
            return { animId: AnimationId.IDLE, speed: 1.0 };
        }

        const baseSpeed = Math.max(actor?.baseMoveSpeed ?? 0, 0.1);
        const moveSpeed = Math.max(actor?.moveSpeed ?? baseSpeed, 0);
        const runThresholdMultiplier = Math.max(
            actor?.locomotionRunThresholdMultiplier ?? 1.15,
            1.01
        );
        const runThresholdSpeed = baseSpeed * runThresholdMultiplier;
        const hasRunAnimation = actor?.animationMap?.has(AnimationId.RUNNING) === true;

        if (hasRunAnimation && moveSpeed >= runThresholdSpeed) {
            return {
                animId: AnimationId.RUNNING,
                speed: _clamp(moveSpeed / runThresholdSpeed, 0.92, 1.35),
            };
        }

        return {
            animId: AnimationId.WALKING,
            speed: _clamp(moveSpeed / baseSpeed, 0.75, 1.25),
        };
    }

    _buildWorldMatrix(actor) {
        const p = actor.position;
        const o = this.planetConfig.origin;
        const s = actor.modelScale;

        const up = new THREE.Vector3(p.x - o.x, p.y - o.y, p.z - o.z).normalize();
        const ref = Math.abs(up.y) > 0.99
            ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
        const right = new THREE.Vector3().crossVectors(up, ref).normalize();
        const fwd = new THREE.Vector3().crossVectors(right, up);

        const visualYaw = actor.facingYaw + (actor.modelYawOffset ?? 0);
        const c = Math.cos(visualYaw), si = Math.sin(visualYaw);
        const rRot = new THREE.Vector3(
            right.x * c - fwd.x * si, right.y * c - fwd.y * si, right.z * c - fwd.z * si
        );
        const fRot = new THREE.Vector3(
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
        const up = new THREE.Vector3(pos.x - o.x, pos.y - o.y, pos.z - o.z).normalize();
        const ref = Math.abs(up.y) > 0.99
            ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
        const right = new THREE.Vector3().crossVectors(up, ref).normalize();
        const fwd = new THREE.Vector3().crossVectors(right, up).normalize();

        const tangentDir = new THREE.Vector3(
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

        const step = THREE.MathUtils.clamp(delta * turnBlend, -maxTurnStep, maxTurnStep);
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

function _clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function _approach(current, target, maxStep) {
    if (current < target) return Math.min(target, current + maxStep);
    if (current > target) return Math.max(target, current - maxStep);
    return current;
}
