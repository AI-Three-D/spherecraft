// core/renderer/particles/shaders/particleSimulate.wgsl.js
//
// Compute shader: integrates live particles, classifies them into the
// additive/alpha live-lists (writing indirect-args counts), and overwrites
// dead slots with freshly spawned particles as long as the per-frame
// spawn budget allows.
//
// One invocation per particle slot; ping-pong between two particle buffers
// (read and write) prevents in-flight data races.

import { buildParticleCommonWGSL } from './particleCommon.wgsl.js';

export function buildParticleSimulateWGSL({
    workgroupSize = 64,
    typeCapacity = 8,
} = {}) {
    const common = buildParticleCommonWGSL({ typeCapacity });

    return /* wgsl */`
${common}

@group(0) @binding(0) var<uniform>            globals   : ParticleGlobals;
@group(0) @binding(1) var<uniform>            typeDefs  : array<ParticleTypeDef, PARTICLE_TYPE_CAPACITY>;
@group(0) @binding(2) var<storage, read>      particlesIn  : array<Particle>;
@group(0) @binding(3) var<storage, read_write> particlesOut: array<Particle>;
@group(0) @binding(4) var<storage, read_write> indirectAdditive: DrawIndirect;
@group(0) @binding(5) var<storage, read_write> indirectAlpha   : DrawIndirect;
@group(0) @binding(6) var<storage, read_write> liveListAdditive: array<u32>;
@group(0) @binding(7) var<storage, read_write> liveListAlpha   : array<u32>;
@group(0) @binding(8) var<storage, read_write> spawnScratch    : SpawnScratch;

// ─── deterministic hash helpers ──────────────────────────────────
fn hash1u(x: u32) -> u32 {
    var v = x;
    v = (v ^ 61u) ^ (v >> 16u);
    v = v + (v << 3u);
    v = v ^ (v >> 4u);
    v = v * 0x27d4eb2du;
    v = v ^ (v >> 15u);
    return v;
}

fn hashToFloat(seed: u32) -> f32 {
    // 24-bit mantissa noise in [0,1)
    return f32(hash1u(seed) & 0x00FFFFFFu) / f32(0x01000000u);
}

fn rand01(index: u32, salt: u32) -> f32 {
    return hashToFloat(index * 2246822519u + salt * 3266489917u + globals.rngSeed);
}

fn randRange(index: u32, salt: u32, lo: f32, hi: f32) -> f32 {
    return lo + (hi - lo) * rand01(index, salt);
}

// Sample the 3-point gradient stored in a ParticleTypeDef.
fn sampleGradient(td: ParticleTypeDef, t: f32) -> vec4<f32> {
    let tt = clamp(t, 0.0, 1.0);
    if (tt < 0.5) {
        return mix(td.colorStart, td.colorMid, tt * 2.0);
    }
    return mix(td.colorMid, td.colorEnd, (tt - 0.5) * 2.0);
}

// Choose a particle type id by sampling cumulative weights with a uniform
// in [0,1). Up to 4 types per emitter (PARTICLE_TYPE_CAPACITY for runtime
// storage, but per-emitter we cap at 4 here to keep the weight vec4 simple).
fn pickType(index: u32) -> u32 {
    let u = rand01(index, 0x9E3779B9u);
    let w = globals.typeWeightsCumulative;
    let n = globals.activeTypeCount;
    if (n >= 1u && u < w.x) { return globals.typeIds.x; }
    if (n >= 2u && u < w.y) { return globals.typeIds.y; }
    if (n >= 3u && u < w.z) { return globals.typeIds.z; }
    if (n >= 4u && u < w.w) { return globals.typeIds.w; }
    return globals.typeIds.x;
}

// Build an orthonormal basis where Y aligns with the given up vector.
fn buildLocalBasis(up: vec3<f32>) -> mat3x3<f32> {
    let u = normalize(up);
    // Pick a reference axis least parallel to u.
    var refAxis = vec3<f32>(0.0, 0.0, 1.0);
    if (abs(u.z) > 0.9) { refAxis = vec3<f32>(1.0, 0.0, 0.0); }
    let r = normalize(cross(u, refAxis));
    let fwd = cross(r, u);
    return mat3x3<f32>(r, u, fwd);
}

// Build a brand-new particle for a freshly claimed dead slot.
fn spawnParticle(index: u32) -> Particle {
    let typeId = pickType(index);
    let td = typeDefs[typeId];

    // Local-space disc + height offset, then rotate into world via the
    // planet-up basis at the emitter.
    let basis = buildLocalBasis(globals.localUp);

    let angle = rand01(index, 11u) * 6.2831853;
    let r     = sqrt(rand01(index, 12u)) * td.spawnRadius;
    let lx    = cos(angle) * r;
    let lz    = sin(angle) * r;
    let ly    = mix(td.spawnHeightMin, td.spawnHeightMax, rand01(index, 13u));
    let localOffset = basis * vec3<f32>(lx, ly, lz);

    // Initial velocity in local space using per-type ranges, then rotate into world.
    let lvx = randRange(index, 21u, td.velXMin, td.velXMax);
    let lvy = randRange(index, 22u, td.velYMin, td.velYMax);
    let lvz = randRange(index, 23u, td.velZMin, td.velZMax);
    let localVel = basis * vec3<f32>(lvx, lvy, lvz);

    let life = randRange(index, 31u, td.lifeMin, td.lifeMax);

    var p: Particle;
    p.position    = globals.emitterPos + localOffset;
    p.lifetime    = life;
    p.velocity    = localVel;
    p.maxLifetime = life;
    p.color       = td.colorStart;
    p.size        = td.sizeStart;
    p.rotation    = rand01(index, 41u) * 6.2831853;
    p.ptype       = typeId;
    // Promote the type's persistent flags (additive/stretch/rotate) and mark alive.
    p.flags       = td.typeFlags | FLAG_ALIVE;

    if (globals.debugMode == 1u) {
        p.size  = 2.0;
        p.color = vec4<f32>(1.0, 0.0, 1.0, 1.0);
        // Force long lifetime so we don't have to wait for spawns.
        p.lifetime    = 30.0;
        p.maxLifetime = 30.0;
    }
    return p;
}

// Publish a live particle's slot index into the correct live-list bucket.
fn publishLive(slot: u32, flags: u32) {
    if ((flags & FLAG_ADDITIVE) != 0u) {
        let idx = atomicAdd(&indirectAdditive.instanceCount, 1u);
        liveListAdditive[idx] = slot;
    } else {
        let idx = atomicAdd(&indirectAlpha.instanceCount, 1u);
        liveListAlpha[idx] = slot;
    }
}

@compute @workgroup_size(${workgroupSize})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x;
    if (i >= globals.maxParticles) { return; }

    var p = particlesIn[i];
    let dt = globals.dt;

    if (p.lifetime > 0.0 && (p.flags & FLAG_ALIVE) != 0u) {
        // ── simulate ──
        let td = typeDefs[p.ptype];
        let up = normalize(globals.localUp);

        // Gravity (positive gravity pulls toward -up)
        p.velocity = p.velocity - up * (td.gravity * dt);

        // Exponential drag
        let dragFactor = exp(-td.drag * dt);
        p.velocity = p.velocity * dragFactor;

        // Constant upward bias along the local up axis
        p.velocity = p.velocity + up * (td.upwardBias * dt);

        // Lateral flicker (FLAME) — apply in the plane perpendicular to up.
        if (td.lateralNoise > 0.0) {
            // Build two perpendicular axes in the tangent plane.
            var refAxis = vec3<f32>(0.0, 0.0, 1.0);
            if (abs(up.z) > 0.9) { refAxis = vec3<f32>(1.0, 0.0, 0.0); }
            let tangentR = normalize(cross(up, refAxis));
            let tangentF = cross(tangentR, up);
            let nr = rand01(i, u32(globals.time * 97.0) + 1u) * 2.0 - 1.0;
            let nf = rand01(i, u32(globals.time * 97.0) + 2u) * 2.0 - 1.0;
            p.velocity = p.velocity + (tangentR * nr + tangentF * nf) * (td.lateralNoise * dt);
        }

        p.position = p.position + p.velocity * dt;
        p.lifetime = p.lifetime - dt;

        // Age-based size and color
        let age01 = clamp(1.0 - p.lifetime / max(p.maxLifetime, 0.0001), 0.0, 1.0);
        p.size = mix(td.sizeStart, td.sizeEnd, age01);
        p.color = sampleGradient(td, age01);

        // Debug override: oversized magenta blobs visible from anywhere.
        if (globals.debugMode == 1u) {
            p.size  = 2.0;
            p.color = vec4<f32>(1.0, 0.0, 1.0, 1.0);
        }

        // Subtle rotation over lifetime for SMOKE.
        if ((p.flags & FLAG_ROTATE) != 0u) {
            p.rotation = p.rotation + dt * 0.4;
        }

        if (p.lifetime > 0.0) {
            publishLive(i, p.flags);
        } else {
            p.flags = p.flags & (~FLAG_ALIVE);
        }
    } else {
        // Dead slot: attempt to claim a spawn.
        let claim = atomicAdd(&spawnScratch.claimed, 1u);
        if (claim < globals.spawnBudget) {
            p = spawnParticle(i + claim * 7919u);
            publishLive(i, p.flags);
        } else {
            // Stay dead; make sure output is a cleanly dead slot.
            p.flags = 0u;
            p.lifetime = 0.0;
            p.color = vec4<f32>(0.0, 0.0, 0.0, 0.0);
        }
    }

    particlesOut[i] = p;
}
`;
}
