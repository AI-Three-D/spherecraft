// core/renderer/particles/ParticleTypes.js
//
// Engine-side enum of particle type IDs.
// Numeric values are stable and are used directly by the GPU shaders
// (as indices into the type-definition UBO array).
//
// Actual per-type parameters (colors, lifetimes, drag, etc.) live in
// templates/configs/particleConfig.js and are uploaded to the GPU from there.
//
// To add a new type:
//   1. Add a new ID below (keeping numeric values contiguous).
//   2. Add a matching entry in templates/configs/particleConfig.js.
//   3. Make sure PARTICLE_TYPE_COUNT stays in sync.

export const PARTICLE_TYPES = Object.freeze({
    FIRE_CORE: 0,
    FLAME:     1,
    SMOKE:     2,
    EMBER:     3,
    COAL:      4,
    FIREFLY:   5,
    LEAF:      6,
    RAIN_DROP: 7,
});

export const PARTICLE_TYPE_COUNT = 8;

// Upper bound on how many type slots the GPU buffer reserves. Keeps the
// shader's fixed-size `array<ParticleTypeDef, N>` stable while still giving
// headroom for adding types without touching the shader.
export const PARTICLE_TYPE_CAPACITY = 12;

// Render blend modes. Each particle type is routed to exactly one of these.
export const PARTICLE_BLEND = Object.freeze({
    ADDITIVE: 0,
    ALPHA:    1,
});

// GPU-visible particle flags. Packed into Particle.flags (u32).
export const PARTICLE_FLAGS = Object.freeze({
    ALIVE:       1 << 0,
    ADDITIVE:    1 << 1,  // 0 -> alpha blend, 1 -> additive blend
    STRETCH_VEL: 1 << 2,  // stretch billboard along velocity (teardrop flames)
    ROTATE:      1 << 3,  // apply in-plane rotation from Particle.rotation
    BLOOM:       1 << 4,  // include in the authored-emissive bloom source pass
    LEAF:        1 << 5,  // wind-responsive leaf physics in compute shader
});
