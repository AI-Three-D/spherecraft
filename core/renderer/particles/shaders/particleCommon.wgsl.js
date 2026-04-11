// core/renderer/particles/shaders/particleCommon.wgsl.js
//
// Shared WGSL struct definitions for the particle compute + render shaders.
// All layouts are 16-byte aligned.

export function buildParticleCommonWGSL({ typeCapacity = 8, emitterCapacity = 16 } = {}) {
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
// Per-type parameter block: 128 bytes (8 x vec4)
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
    // vec4 #6 — initial velocity ranges (X and Y axes)
    velXMin:       f32,
    velXMax:       f32,
    velYMin:       f32,
    velYMax:       f32,
    // vec4 #7 — initial velocity range (Z axis) + emissive/bloom controls
    velZMin:       f32,
    velZMax:       f32,
    emissive:      f32,   // HDR multiplier applied to color.rgb (1.0 = LDR)
    bloomWeight:   f32,   // authored weight for the emissive-only bloom pass
};

// ─────────────────────────────────────────────────────────────────
// Per-frame globals. The render pass uses the camera data; the compute pass
// additionally uses spawn budgets, emitter count, and planet origin.
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
    planetOrigin: vec3<f32>,
    totalSpawnBudget: u32,
    // vec4 #3
    emitterCount: u32,
    maxParticles: u32,
    debugMode:    u32,   // 0 = normal, 1 = oversized magenta blobs
    flatWorld:    u32,   // 0 = spherical, 1 = use +Y as local up
    // vec4 #4
    fireflyGlow:  f32,
    _pad3:        vec3<f32>,
};

// Per-emitter spawn parameters, uploaded once per frame into a shared storage
// buffer and consumed only by the compute pass.
struct EmitterSpawnDef {
    position: vec3<f32>,
    spawnBudget: u32,
    typeWeightsCumulative: vec4<f32>,
    typeIds: vec4<u32>,
    rngSeed: u32,
    activeTypeCount: u32,
    _pad0: u32,
    _pad1: u32,
    localUp: vec3<f32>,
    _pad2: f32,
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
const PARTICLE_EMITTER_CAPACITY: u32 = ${emitterCapacity}u;

// Flag bits (must match ParticleTypes.js PARTICLE_FLAGS).
const FLAG_ALIVE:       u32 = 1u;
const FLAG_ADDITIVE:    u32 = 2u;
const FLAG_STRETCH_VEL: u32 = 4u;
const FLAG_ROTATE:      u32 = 8u;
const FLAG_BLOOM:       u32 = 16u;
`;
}
