// templates/configs/particleConfig.js
//
// Per-type parameter tables for the GPU particle system.
// The engine-side enum lives in core/renderer/particles/ParticleTypes.js.
//
// These values are uploaded once at init into a uniform buffer consumed by
// the particle compute shader. Tweak values here to change visuals — no
// shader edit required.
//
// Each entry defines:
//   blend        : 'additive' | 'alpha'
//   lifetime     : [min, max] seconds
//   size         : { start, end }     world units (half-size of billboard)
//   velocity     : initial velocity range, local to the emitter
//   gravity      : downward accel (m/s^2)
//   drag         : exponential drag coefficient (1/s). 0 = no drag.
//   upwardBias   : constant upward accel (m/s^2)
//   lateralNoise : per-second random lateral accel (m/s^2)
//   spawnOffset  : { radius, heightMin, heightMax } local to emitter
//   colorStart   : rgba at age 0
//   colorMid     : rgba at age 0.5
//   colorEnd     : rgba at age 1
//   flags        : { stretchAlongVel, rotate }
//   spawnWeight  : relative spawn probability within an emitter that uses
//                  this type (weights are normalized per-emitter)

import { PARTICLE_TYPES } from '../../core/renderer/particles/ParticleTypes.js';

export const PARTICLE_CONFIG = {
    [PARTICLE_TYPES.FIRE_CORE]: {
        blend: 'additive',
        lifetime: { min: 0.45, max: 0.75 },
        size: { start: 0.10, end: 0.01 },
        velocity: {
            x: [-0.05, 0.05],
            y: [ 0.10, 0.25],
            z: [-0.05, 0.05],
        },
        gravity: 0.0,
        drag: 6.0,           // very heavy drag -> barely moves
        upwardBias: 0.4,
        lateralNoise: 0.0,
        spawnOffset: {
            radius: 0.06,
            heightMin: 0.00,
            heightMax: 0.04,
        },
        // White-orange heat blob, fades as it dies.
        colorStart: [1.00, 0.92, 0.55, 0.95],
        colorMid:   [1.00, 0.45, 0.08, 0.7],
        colorEnd:   [0.50, 0.08, 0.00, 0.0],
        flags: { stretchAlongVel: false, rotate: false },
        spawnWeight: 0.55,
    },

    [PARTICLE_TYPES.FLAME]: {
        blend: 'additive',
        lifetime: { min: 0.40, max: 0.80 },
        size: { start: 0.07, end: 0.02 },
        velocity: {
            x: [-0.30, 0.30],   // moderate outward spread
            y: [ 0.15, 0.45],   // gentle initial upward push
            z: [-0.30, 0.30],
        },
        gravity: 0.0,
        drag: 1.8,           // stronger drag keeps them from rocketing
        upwardBias: 0.9,     // gentle steady rise
        lateralNoise: 0.35,  // subtle flicker, not violent
        spawnOffset: {
            radius: 0.10,
            heightMin: 0.05,
            heightMax: 0.15,
        },
        // Bright yellow-white -> orange -> deep red -> transparent.
        colorStart: [1.00, 0.90, 0.55, 0.9],
        colorMid:   [1.00, 0.40, 0.05, 0.6],
        colorEnd:   [0.35, 0.02, 0.00, 0.0],
        flags: { stretchAlongVel: true, rotate: false },
        spawnWeight: 0.40,
    },

    [PARTICLE_TYPES.SMOKE]: {
        blend: 'alpha',
        lifetime: { min: 1.50, max: 2.50 },
        size: { start: 0.06, end: 0.18 },   // grows -> billowing
        velocity: {
            x: [-0.04, 0.04],
            y: [ 0.30, 0.55],
            z: [-0.04, 0.04],
        },
        gravity: -0.10,       // very slight negative gravity (float effect)
        drag: 1.2,            // strong drag
        upwardBias: 0.25,
        lateralNoise: 0.10,
        spawnOffset: {
            radius: 0.05,
            heightMin: 0.50,
            heightMax: 0.70,
        },
        // Near-black -> dark grey -> light grey -> transparent.
        colorStart: [0.08, 0.08, 0.08, 0.18],
        colorMid:   [0.25, 0.25, 0.25, 0.10],
        colorEnd:   [0.55, 0.55, 0.55, 0.0],
        // Note: rotate flag is a no-op with the current radially-symmetric
        // soft-disc fragment; re-enable when we add a non-symmetric texture.
        flags: { stretchAlongVel: false, rotate: false },
        spawnWeight: 0.01,
    },

    [PARTICLE_TYPES.EMBER]: {
        blend: 'additive',
        lifetime: { min: 0.6, max: 1.8 },
        size: { start: 0.035, end: 0.008 },
        velocity: {
            x: [-0.55, 0.55],   // fly outward in all directions
            y: [ 0.60, 1.80],   // launched upward
            z: [-0.55, 0.55],
        },
        gravity: 0.0,
        drag: 0.8,
        upwardBias: 0.6,
        lateralNoise: 0.5,      // small random drift
        spawnOffset: {
            radius: 0.08,
            heightMin: 0.10,
            heightMax: 0.25,
        },
        // Bright white-orange -> orange -> deep red -> transparent.
        colorStart: [1.00, 0.85, 0.40, 1.0],
        colorMid:   [1.00, 0.35, 0.02, 0.7],
        colorEnd:   [0.30, 0.02, 0.00, 0.0],
        flags: { stretchAlongVel: false, rotate: false },
        spawnWeight: 0.05,
    },

    [PARTICLE_TYPES.COAL]: {
        blend: 'additive',
        lifetime: { min: 1.20, max: 2.40 },
        size: { start: 0.035, end: 0.025 },
        velocity: {
            x: [-0.01, 0.01],   // essentially stationary
            y: [ 0.00, 0.01],
            z: [-0.01, 0.01],
        },
        gravity: 0.0,
        drag: 10.0,             // immediately kills any velocity
        upwardBias: 0.0,
        lateralNoise: 0.0,
        spawnOffset: {
            radius: 0.18,       // spread across the coal bed
            heightMin: 0.00,
            heightMax: 0.04,
        },
        // Deep red -> orange glow -> dim red -> transparent (one "pulse" per life).
        colorStart: [0.80, 0.10, 0.00, 0.7],
        colorMid:   [1.00, 0.45, 0.05, 0.9],
        colorEnd:   [0.40, 0.04, 0.00, 0.0],
        flags: { stretchAlongVel: false, rotate: false },
        spawnWeight: 1.0,
    },
};

// Per-emitter presets.
export const PARTICLE_EMITTER_PRESETS = {
    campfire: {
        // 4 types = vec4 limit per emitter. COAL uses campfire_coals.
        types: [
            PARTICLE_TYPES.FIRE_CORE,
            PARTICLE_TYPES.FLAME,
            PARTICLE_TYPES.SMOKE,
            PARTICLE_TYPES.EMBER,
        ],
        weights: {
            [PARTICLE_TYPES.FIRE_CORE]: 0.50,
            [PARTICLE_TYPES.FLAME]:     0.44,
            [PARTICLE_TYPES.SMOKE]:     0.01,
            [PARTICLE_TYPES.EMBER]:     0.05,
        },
        spawnBudgetPerFrame: 32,     // ~1900 spawns/sec at 60 Hz
        distanceCutoff: 1000.0,
    },

    campfire_coals: {
        types: [
            PARTICLE_TYPES.COAL,
        ],
        weights: {
            [PARTICLE_TYPES.COAL]: 1.0,
        },
        spawnBudgetPerFrame: 3,      // ~180 coal glows/sec at 60 Hz — sparse
        distanceCutoff: 500.0,
    },
};

// Global particle-system caps. Chosen conservatively for first bring-up.
export const PARTICLE_GLOBALS = {
    maxParticles: 8192,
    workgroupSize: 64,
};
