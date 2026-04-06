// core/renderer/particles/shaders/particleCommon.wgsl.js
//
// Shared WGSL struct definitions for the particle compute + render shaders.
// All layouts are 16-byte aligned.

export function buildParticleCommonWGSL({ typeCapacity = 8 } = {}) {
    return /* wgsl */`

// ─────────────────────────────────────────────────────────────────
// Particle slot: 64 bytes (4 x vec4)
// Layout is shared by read and write storage buffers (ping-pong).
// ─────────────────────────────────────────────────────────────────
struct Particle {
    // vec4 #0
    position:    vec3<f32>,
    lifetime:    f32,     // remaining seconds, <= 0 means dead
    // vec4 #1
    velocity:    vec3<f32>,
    maxLifetime: f32,
    // vec4 #2
    color:       vec4<f32>,
    // vec4 #3
    size:        f32,     // world-space half-size of billboard
    rotation:    f32,
    ptype:       u32,     // index into typeDefs[]
    flags:       u32,
};

// ─────────────────────────────────────────────────────────────────
// Per-type parameter block: 96 bytes (6 x vec4)
// Uploaded once at init into a uniform buffer.
// ─────────────────────────────────────────────────────────────────
struct ParticleTypeDef {
    // vec4 #0 — kinematics
    gravity:       f32,
    drag:          f32,
    upwardBias:    f32,
    lateralNoise:  f32,
    // vec4 #1 — life + size
    lifeMin:       f32,
    lifeMax:       f32,
    sizeStart:     f32,
    sizeEnd:       f32,
    // vec4 #2..#4 — 3-point color gradient
    colorStart:    vec4<f32>,
    colorMid:      vec4<f32>,
    colorEnd:      vec4<f32>,
    // vec4 #5 — spawn offset + flags
    spawnRadius:   f32,
    spawnHeightMin:f32,
    spawnHeightMax:f32,
    typeFlags:     u32,   // per-type flags (stretch, rotate, additive, ...)
};

// ─────────────────────────────────────────────────────────────────
// Per-frame globals: ~256 bytes, bound as uniform.
// ─────────────────────────────────────────────────────────────────
struct ParticleGlobals {
    // view + projection for the render pass (compute ignores these, but
    // using one UBO for both passes keeps bind groups simple)
    viewProj:     mat4x4<f32>,     // 64 B
    // vec4 #0
    cameraRight:  vec3<f32>,
    dt:           f32,
    // vec4 #1
    cameraUp:     vec3<f32>,
    time:         f32,
    // vec4 #2
    emitterPos:   vec3<f32>,
    spawnBudget:  u32,
    // vec4 #3 — up to 4 cumulative type weights for this emitter
    typeWeightsCumulative: vec4<f32>,
    // vec4 #4 — parallel array of type IDs (u32 packed in f32 slots is awkward,
    // so we use a dedicated vec4<u32>)
    typeIds:      vec4<u32>,
    // vec4 #5
    rngSeed:      u32,
    maxParticles: u32,
    activeTypeCount: u32,
    debugMode:    u32,   // 0 = normal, 1 = oversized magenta blobs
    // vec4 #6
    localUp:      vec3<f32>,
    _pad6:        f32,
};

// Indirect draw args layout matches GPUDrawIndirectParameters (non-indexed):
//   vertexCount, instanceCount, firstVertex, firstInstance
struct DrawIndirect {
    vertexCount:   u32,
    instanceCount: atomic<u32>,
    firstVertex:   u32,
    firstInstance: u32,
};

// Scratch counters cleared each frame before the compute dispatch.
struct SpawnScratch {
    claimed: atomic<u32>,
    _pad0:   u32,
    _pad1:   u32,
    _pad2:   u32,
};

const PARTICLE_TYPE_CAPACITY: u32 = ${typeCapacity}u;

// Flag bits (must match ParticleTypes.js PARTICLE_FLAGS).
const FLAG_ALIVE:       u32 = 1u;
const FLAG_ADDITIVE:    u32 = 2u;
const FLAG_STRETCH_VEL: u32 = 4u;
const FLAG_ROTATE:      u32 = 8u;
`;
}
