// js/actors/NPCSpawnConfig.js
//
// Default configuration for NPC spawning rules.
// Game state and area-specific overrides can merge on top of these defaults.


import { AnimationId } from './ActorState.js';
import { TILE_TYPES } from '../../shared/types.js';

export const DEFAULT_NPC_SPAWN_CONFIG = Object.freeze({

    npcTypes: {
        goblin: {
            characterDescriptorUrl: '/assets/characters/goblin.char.json',

            // Variant scales the descriptor's base scale/radius.
            variants: [
                { name: 'small', scaleMultiplier: 0.6, spawnWeight: 0.85 },
                { name: 'chief', scaleMultiplier: 0.9, spawnWeight: 0.15 },
            ],

            // NPC-only — not in descriptor:
            hostility: 0.7,
            braveness: 0.3,

            ai: {
                observeDistance: { min: 30, max: 42 },
                observeHoldSec: { min: 0.35, max: 0.8 },
                observeOrbitSpeed: { min: 0.16, max: 0.26 },
                runAnimationThresholdMultiplier: 1.18,
                approachSpeedMultiplier: 0.92,
                observeSpeedMultiplier: 0.7,
                pressureChargeDistance: 10.0,
                retreatTriggerDistance: 2.5,
                approachSlack: 5.0,
                observeSlack: 5.0,
                chargeTimeoutSec: 18.0,
                retreatDurationSec: 1.0,
                retreatDistance: { min: 4, max: 7 },
                retreatLateralDistance: { min: 1.5, max: 3.0 },
                chargeSpeedMultiplier: 1.2,
                retreatSpeedMultiplier: 0.92,
                maxConcurrentAttackersPerGroup: 3,
                spawnAttackDelaySec: { min: 0.15, max: 0.45 },
            },

            attackProfiles: {
                small: {
                    animationId: AnimationId.ATTACK_LIGHT,
                    animationSpeed: 1.05,
                    fallbackDurationSec: 0.8,
                    strikeFraction: 0.38,
                    attackRange: 0.0,
                    engageRange: 0.2,
                    hitRange: 2.5,
                    damage: 10,
                    damageVariance: 0.35,
                    attackCooldownSec: 0.9,
                    attackCooldownJitterSec: 0.3,
                },
                chief: {
                    animationId: AnimationId.ATTACK_HEAVY,
                    animationSpeed: 0.88,
                    fallbackDurationSec: 1.15,
                    strikeFraction: 0.44,
                    attackRange: 0.1,
                    engageRange: 0.2,
                    hitRange: 3.2,
                    damage: 20,
                    damageVariance: 0.4,
                    attackCooldownSec: 1.6,
                    attackCooldownJitterSec: 0.4,
                },
            },
        },
    },

    spawnRules: {
        enabled: true,
        requiresLivingPlayer: true,
        spawnIntervalSec: 4.0,
        spawnChancePerInterval: 0.18,
        minSpawnDistance: 100,
        maxSpawnDistance: 200,
        despawnDistance: 320,
        maxActiveNPCs: 12,
        groupSize: { min: 2, max: 5 },
        maxBossesPerGroup: 1,
        bossMinGroupSize: 3,
        bossChance: 0.2,
        spreadRadius: 18,
        spawnSearchAttempts: 6,
        tileSampleMaxDepth: 8,
        allowedTileIdRanges: [
            [TILE_TYPES.GRASS_SHORT_1, TILE_TYPES.GRASS_FLOWER_FIELD_4],
        ],
    },

    debug: {
        enabled: false,
        defaultTypeId: 'goblin',
        defaultGroupSize: 3,
        allowChief: true,
        minSpawnDistance: 35,
        maxSpawnDistance: 60,
    },
});