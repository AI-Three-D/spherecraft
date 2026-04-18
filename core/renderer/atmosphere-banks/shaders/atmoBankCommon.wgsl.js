export function buildAtmoBankCommonWGSL({ typeCapacity = 4, emitterCapacity = 32 } = {}) {
    return /* wgsl */`

struct AtmoParticle {
    position: vec3<f32>, lifetime: f32,
    velocity: vec3<f32>, maxLifetime: f32,
    noisePhase: vec3<f32>, size: f32,
    color: vec4<f32>,
    ptype: u32, flags: u32, opacity: f32, _pad: f32,
};

struct AtmoTypeDef {
    noiseScale: f32, noiseSpeed: f32, densityBase: f32, windResponse: f32,
    lifeMin: f32, lifeMax: f32, sizeMin: f32, sizeMax: f32,
    color: vec4<f32>,
    fadeNearStart: f32, fadeFarStart: f32, fadeFarEnd: f32, densityThreshold: f32,
};

struct AtmoGlobals {
    viewProj: mat4x4<f32>,
    cameraRight: vec3<f32>, dt: f32,
    cameraUp: vec3<f32>, time: f32,
    cameraPos: vec3<f32>, totalSpawnBudget: u32,
    planetOrigin: vec3<f32>, emitterCount: u32,
    maxParticles: u32, windDirX: f32, windDirY: f32, windSpeed: f32,
    maxRenderDist: f32, nearPlane: f32, farPlane: f32, _pad0: f32,
};

struct AtmoEmitterDef {
    position: vec3<f32>, spawnBudget: u32,
    localUp: vec3<f32>, typeId: u32,
    rngSeed: u32, _pad0: u32, _pad1: u32, _pad2: u32,
    _pad3: vec4<f32>,
    _pad4: vec4<f32>,
};

struct AtmoDrawIndirect {
    vertexCount: u32,
    instanceCount: atomic<u32>,
    firstVertex: u32,
    firstInstance: u32,
};

struct AtmoSpawnScratch {
    claimed: atomic<u32>,
    _pad0: u32, _pad1: u32, _pad2: u32,
};

const ATMO_TYPE_CAPACITY: u32 = ${typeCapacity}u;
const ATMO_EMITTER_CAPACITY: u32 = ${emitterCapacity}u;
const ATMO_FLAG_ALIVE: u32 = 1u;
`;
}
