// js/actors/CharacterActor.js
//
// CPU-side data model for a game actor.
// Position is GPU-authoritative; this holds a CPU mirror updated
// via a low-frequency ring-buffered readback for camera following
// and animation selection.

import { ActorType, MovementState, AnimationId } from './ActorState.js';

let _nextActorId = 1;

export class CharacterActor {
    constructor(options = {}) {
        this.id = _nextActorId++;
        this.type = options.type ?? ActorType.PLAYER;
        this.name = options.name ?? '';

        // Physical params
        this.modelScale = options.modelScale ?? 1.0;
        this.modelYawOffset = options.modelYawOffset ?? 0;
        this.baseMoveSpeed = options.moveSpeed ?? 4.0;  // m/s
        this.moveSpeed = this.baseMoveSpeed;
        this.collisionRadius = options.collisionRadius ?? 0.4;

        // Slope in normal.b is sin(angle). 45° → ~0.707.
        this.maxSlope = options.maxSlope ?? Math.sin((options.maxSlopeDeg ?? 45) * Math.PI / 180);

        // Attributes (foundation for NPC extensions)
        this.health = options.health ?? 100;
        this.maxHealth = options.maxHealth ?? 100;
        this.stamina = options.stamina ?? 100;
        this.maxStamina = options.maxStamina ?? this.stamina;
        this.hunger = options.hunger ?? 100;
        this.maxHunger = options.maxHunger ?? this.hunger;
        this.temperature = options.temperature ?? 50;
        this.minTemperature = options.minTemperature ?? 0;
        this.maxTemperature = options.maxTemperature ?? 100;
        this.temperatureNeutral = options.temperatureNeutral ?? 50;
        this.braveness = options.braveness ?? 0.5;
        this.hostility = options.hostility ?? 0.0;
        this.isAlive = options.isAlive ?? true;
        this.isDown = options.isDown ?? false;
        this.statusText = options.statusText ?? '';
        this.conditionText = options.conditionText ?? '';
        this.isExhausted = options.isExhausted ?? false;
        this.sprintMultiplier = options.sprintMultiplier ?? 1.75;

        // Spatial state — CPU mirror of GPU-resolved values
        this.position = { x: 0, y: 0, z: 0 };
        this.facingYaw = 0;
        this.movementState = MovementState.IDLE;
        this.grounded = false;

        // Move-to-target state
        this.moveTarget = null;

        // Animation
        this.currentAnimation = -1;
        this.currentAnimationSpeed = 1.0;
        this.animationMap = new Map();   // AnimationId → glb anim index
        this.animationAction = null;
        this.locomotionRunThresholdMultiplier =
            options.locomotionRunThresholdMultiplier ?? 1.15;

        // Renderer binding
        this.renderInstance = null;

        this.npcTypeId = options.npcTypeId ?? null;
        this.groupId   = options.groupId   ?? 0;
        this.variant   = options.variant   ?? null;
        this.isBoss    = options.isBoss    ?? false;
        // GPU pool slot
        this.gpuSlot = -1;
    }

    get isNPC() { return this.type === ActorType.NPC; }

    setPosition(x, y, z) {
        this.position.x = x;
        this.position.y = y;
        this.position.z = z;
    }
}
