// core/renderer/particles/ParticleEmitter.js
//
// CPU-side emitter descriptor. One of these is created per campfire / torch /
// etc. It holds its world anchor, the set of types it spawns, normalized
// cumulative weights, and its per-frame spawn budget + LOD cutoff.
//
// The ParticleSystem compacts active emitters into a per-frame spawn table
// consumed by a single sim dispatch.

import {
    PARTICLE_CONFIG,
    PARTICLE_EMITTER_PRESETS,
} from '../../../templates/configs/particleConfig.js';

export class ParticleEmitter {
    constructor({
        position,
        preset = 'campfire',
        overrides = {},
        particleConfig = PARTICLE_CONFIG,
        emitterPresets = PARTICLE_EMITTER_PRESETS,
    }) {
        const presetDef = emitterPresets[preset];
        if (!presetDef) {
            throw new Error(`ParticleEmitter: unknown preset "${preset}"`);
        }

        this.position = {
            x: position?.x ?? 0,
            y: position?.y ?? 0,
            z: position?.z ?? 0,
        };
        this.preset = preset;

        // Type list (capped at 4 because the shader's cumulative weight vec4
        // holds up to 4 types per emitter).
        this.typeIds = presetDef.types.slice(0, 4);

        // Resolve weights (preset overrides fall back to each type's default
        // spawnWeight from PARTICLE_CONFIG).
        const rawWeights = this.typeIds.map((id) => {
            const fromPreset = presetDef.weights?.[id];
            if (typeof fromPreset === 'number') return fromPreset;
            return particleConfig[id]?.spawnWeight ?? 1.0;
        });

        const totalWeight = rawWeights.reduce((s, v) => s + v, 0) || 1.0;

        // Cumulative normalized weights — consumed by the shader's pickType().
        this.typeWeightsCumulative = new Array(4).fill(0);
        let running = 0;
        for (let i = 0; i < rawWeights.length; i++) {
            running += rawWeights[i] / totalWeight;
            this.typeWeightsCumulative[i] = running;
        }
        // Ensure the last used slot is exactly 1.0 to handle f32 rounding.
        if (this.typeIds.length > 0) {
            this.typeWeightsCumulative[this.typeIds.length - 1] = 1.0;
        }

        // Per-frame spawn budget.
        this.spawnBudgetPerFrame = overrides.spawnBudgetPerFrame
            ?? presetDef.spawnBudgetPerFrame
            ?? 16;

        this.distanceCutoff = overrides.distanceCutoff
            ?? presetDef.distanceCutoff
            ?? 200.0;

        this.lodNearDistance = overrides.lodNearDistance
            ?? presetDef.lodNearDistance
            ?? Math.min(12.0, this.distanceCutoff);

        this.lodFarDistance = overrides.lodFarDistance
            ?? presetDef.lodFarDistance
            ?? this.distanceCutoff;

        this.lodMinScale = overrides.lodMinScale
            ?? presetDef.lodMinScale
            ?? 1.0;

        // Deterministic base seed derived from position. The system re-mixes
        // this with frame count when writing the globals UBO.
        const derivedSeed = ((Math.floor(this.position.x * 13.1) ^
                               Math.floor(this.position.y * 17.7) ^
                               Math.floor(this.position.z * 23.3)) >>> 0) || 1;
        this.baseSeed = (overrides.baseSeed >>> 0) || derivedSeed;
    }

    // Pads typeIds/weights to length 4 for the shader.
    getShaderTypeIds() {
        const ids = [0, 0, 0, 0];
        for (let i = 0; i < this.typeIds.length; i++) ids[i] = this.typeIds[i];
        return ids;
    }

    getShaderTypeWeightsCumulative() {
        const w = [0, 0, 0, 0];
        for (let i = 0; i < this.typeWeightsCumulative.length; i++) {
            w[i] = this.typeWeightsCumulative[i];
        }
        return w;
    }

    getActiveTypeCount() {
        return this.typeIds.length;
    }

    getSpawnBudgetForDistance(distance) {
        if (!Number.isFinite(distance) || distance < 0) {
            return this.spawnBudgetPerFrame;
        }
        if (distance >= this.distanceCutoff) {
            return 0;
        }

        let scale = 1.0;
        if (this.lodFarDistance > this.lodNearDistance && distance > this.lodNearDistance) {
            const t = Math.min(
                1.0,
                (distance - this.lodNearDistance) / (this.lodFarDistance - this.lodNearDistance)
            );
            scale = 1.0 + (this.lodMinScale - 1.0) * t;
        }

        const budget = Math.round(this.spawnBudgetPerFrame * scale);
        if (budget <= 0 && scale > 0 && this.spawnBudgetPerFrame > 0) {
            return 1;
        }
        return Math.max(0, budget);
    }
}
