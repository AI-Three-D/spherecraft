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
import { PARTICLE_TYPES } from '../ParticleTypes.js';

export function buildParticleSimulateWGSL({
    workgroupSize = 64,
    typeCapacity = 8,
    emitterCapacity = 16,
} = {}) {
    const common = buildParticleCommonWGSL({ typeCapacity, emitterCapacity });
    const fireflyTypeId = PARTICLE_TYPES.FIREFLY;

    return /* wgsl */`
${common}

@group(0) @binding(0) var<uniform>            globals   : ParticleGlobals;
@group(0) @binding(1) var<uniform>            typeDefs  : array<ParticleTypeDef, PARTICLE_TYPE_CAPACITY>;
@group(0) @binding(2) var<storage, read>      particlesIn  : array<Particle>;
@group(0) @binding(3) var<storage, read_write> particlesOut: array<Particle>;
@group(0) @binding(4) var<storage, read_write> indirectAdditive: DrawIndirect;
@group(0) @binding(5) var<storage, read_write> indirectAlpha   : DrawIndirect;
@group(0) @binding(6) var<storage, read_write> indirectBloom   : DrawIndirect;
@group(0) @binding(7) var<storage, read_write> liveListAdditive: array<u32>;
@group(0) @binding(8) var<storage, read_write> liveListAlpha   : array<u32>;
@group(0) @binding(9) var<storage, read_write> liveListBloom   : array<u32>;
@group(0) @binding(10) var<storage, read_write> spawnScratch   : SpawnScratch;
@group(0) @binding(11) var<storage, read>      emitters        : array<EmitterSpawnDef, PARTICLE_EMITTER_CAPACITY>;

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

fn rand01(index: u32, salt: u32, seed: u32) -> f32 {
    return hashToFloat(index * 2246822519u + salt * 3266489917u + seed);
}

fn randRange(index: u32, salt: u32, seed: u32, lo: f32, hi: f32) -> f32 {
    return lo + (hi - lo) * rand01(index, salt, seed);
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
fn pickType(index: u32, emitter: EmitterSpawnDef) -> u32 {
    let u = rand01(index, 0x9E3779B9u, emitter.rngSeed);
    let w = emitter.typeWeightsCumulative;
    let n = emitter.activeTypeCount;
    if (n >= 1u && u < w.x) { return emitter.typeIds.x; }
    if (n >= 2u && u < w.y) { return emitter.typeIds.y; }
    if (n >= 3u && u < w.z) { return emitter.typeIds.z; }
    if (n >= 4u && u < w.w) { return emitter.typeIds.w; }
    return emitter.typeIds.x;
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
fn resolveLocalUp(position: vec3<f32>) -> vec3<f32> {
    if (globals.flatWorld != 0u) {
        return vec3<f32>(0.0, 1.0, 0.0);
    }

    let local = position - globals.planetOrigin;
    let localLenSq = dot(local, local);
    if (localLenSq > 1e-8) {
        return normalize(local);
    }
    return vec3<f32>(0.0, 1.0, 0.0);
}

fn selectEmitterIndex(claim: u32) -> u32 {
    var accum = 0u;
    var selected = 0u;
    for (var idx = 0u; idx < PARTICLE_EMITTER_CAPACITY; idx = idx + 1u) {
        if (idx >= globals.emitterCount) {
            break;
        }

        let nextAccum = accum + emitters[idx].spawnBudget;
        if (claim < nextAccum) {
            selected = idx;
            break;
        }
        accum = nextAccum;
    }
    return selected;
}

fn remapSpawnClaim(slot: u32, claim: u32) -> u32 {
    if (globals.totalSpawnBudget <= 1u) {
        return 0u;
    }

    let frameSalt = u32(globals.time * 60.0) * 747796405u;
    let mixed = hash1u(claim ^ (slot * 2246822519u) ^ frameSalt);
    return mixed % globals.totalSpawnBudget;
}

fn spawnParticle(slot: u32, claim: u32) -> Particle {
    let emitter = emitters[selectEmitterIndex(claim)];
    let seedBase = slot ^ (claim * 7919u) ^ emitter.rngSeed;
    let typeId = pickType(seedBase, emitter);
    let td = typeDefs[typeId];

    // Local-space disc + height offset, then rotate into world via the
    // planet-up basis at the emitter.
    let basis = buildLocalBasis(emitter.localUp);

    let angle = rand01(seedBase, 11u, emitter.rngSeed) * 6.2831853;
    let r     = sqrt(rand01(seedBase, 12u, emitter.rngSeed)) * td.spawnRadius;
    let lx    = cos(angle) * r;
    let lz    = sin(angle) * r;
    let ly    = mix(td.spawnHeightMin, td.spawnHeightMax, rand01(seedBase, 13u, emitter.rngSeed));
    let localOffset = basis * vec3<f32>(lx, ly, lz);

    // Initial velocity in local space using per-type ranges, then rotate into world.
    let lvx = randRange(seedBase, 21u, emitter.rngSeed, td.velXMin, td.velXMax);
    let lvy = randRange(seedBase, 22u, emitter.rngSeed, td.velYMin, td.velYMax);
    let lvz = randRange(seedBase, 23u, emitter.rngSeed, td.velZMin, td.velZMax);
    let localVel = basis * vec3<f32>(lvx, lvy, lvz);

    let life = randRange(seedBase, 31u, emitter.rngSeed, td.lifeMin, td.lifeMax);

    var p: Particle;
    p.position    = emitter.position + localOffset;
    p.lifetime    = life;
    p.velocity    = localVel;
    p.maxLifetime = life;
    p.color       = td.colorStart;
    p.size        = td.sizeStart;
    p.rotation    = rand01(seedBase, 41u, emitter.rngSeed) * 6.2831853;
    p.ptype       = typeId;
    // Promote the type's persistent flags (additive/stretch/rotate) and mark alive.
    p.flags       = td.typeFlags | FLAG_ALIVE;

    if ((p.flags & FLAG_LEAF) != 0u) {
        p.color = td.colorStart;
    }

    if (typeId == ${fireflyTypeId}u) {
        let stablePhase = hashToFloat(emitter.rngSeed ^ 0x9E3779B9u) * 6.2831853;
        p.rotation = stablePhase;
        let fireflyGlow = clamp(globals.fireflyGlow, 0.0, 1.0);
        let visualGlow = pow(fireflyGlow, 4.0);
        let sizeScale = 0.18 + fireflyGlow * (1.8 - 0.18);
        p.size = p.size * sizeScale;
        p.color = vec4<f32>(
            p.color.rgb * visualGlow,
            p.color.a * visualGlow
        );
    }

    if (globals.debugMode == 1u) {
        p.size  = 2.0;
        p.color = vec4<f32>(1.0, 0.0, 1.0, 1.0);
        // Force long lifetime so we don't have to wait for spawns.
        p.lifetime    = 30.0;
        p.maxLifetime = 30.0;
    }
    if (globals.debugMode == 2u && (p.flags & FLAG_LEAF) != 0u) {
        p.color = vec4<f32>(0.05, 0.95, 1.0, 1.0);
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

    if ((flags & FLAG_BLOOM) != 0u) {
        let bloomIdx = atomicAdd(&indirectBloom.instanceCount, 1u);
        liveListBloom[bloomIdx] = slot;
    }
}

fn killParticle(p: ptr<function, Particle>) {
    (*p).flags = 0u;
    (*p).lifetime = 0.0;
    (*p).maxLifetime = max((*p).maxLifetime, 0.0);
    (*p).color = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    (*p).size = 0.0;
    (*p).rotation = 0.0;
    (*p).velocity = vec3<f32>(0.0, 0.0, 0.0);
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
        let up = resolveLocalUp(p.position);

        // Gravity (positive gravity pulls toward -up)
        p.velocity = p.velocity - up * (td.gravity * dt);

        // Exponential drag
        let dragFactor = exp(-td.drag * dt);
        p.velocity = p.velocity * dragFactor;

        // Constant upward bias along the local up axis
        p.velocity = p.velocity + up * (td.upwardBias * dt);

        var refAxis = vec3<f32>(0.0, 0.0, 1.0);
        if (abs(up.z) > 0.9) { refAxis = vec3<f32>(1.0, 0.0, 0.0); }
        let tangentR = normalize(cross(up, refAxis));
        let tangentF = cross(tangentR, up);

        // Lateral flicker (FLAME) — apply in the plane perpendicular to up.
        if (td.lateralNoise > 0.0) {
            let noiseSeed = p.ptype * 1664525u + 1013904223u;
            let timeSalt = u32(globals.time * 97.0);
            let nr = rand01(i, timeSalt + 1u, noiseSeed) * 2.0 - 1.0;
            let nf = rand01(i, timeSalt + 2u, noiseSeed) * 2.0 - 1.0;
            p.velocity = p.velocity + (tangentR * nr + tangentF * nf) * (td.lateralNoise * dt);
        }

        // Wind-responsive leaf physics: coherent wind drift + sinusoidal flutter.
        if ((p.flags & FLAG_LEAF) != 0u) {
            let leafHash = hashToFloat(i * 3571u + 7919u);
            var wind2 = vec2<f32>(globals.windDirX, globals.windDirY);
            if (length(wind2) < 0.001) {
                wind2 = normalize(vec2<f32>(0.62, 0.38));
            }
            let baseWindSpeed = max(globals.windSpeed, 1.4);
            let gustPeriod = 5.5;
            let gustPhase = fract(globals.time / gustPeriod + leafHash * 3.7);
            let gustPulse = smoothstep(0.02, 0.18, gustPhase) * (1.0 - smoothstep(0.18, 0.48, gustPhase));
            let gustWobble = sin(globals.time * (4.0 + leafHash * 3.0) + leafHash * 19.1);
            let windForce = vec3<f32>(wind2.x, 0.0, wind2.y) * (baseWindSpeed * (0.16 + gustPulse * 1.25));
            let crossGust = vec3<f32>(-wind2.y, 0.0, wind2.x) * (gustWobble * gustPulse * 0.85);
            p.velocity = p.velocity + (windForce + crossGust) * dt;

            let flutter = sin(globals.time * 2.3 + leafHash * 6.28) * 0.16;
            let bob     = sin(globals.time * 1.7 + leafHash * 19.1) * 0.08;
            p.velocity = p.velocity + (tangentR * flutter + up * bob) * dt;
        }

        p.position = p.position + p.velocity * dt;
        p.lifetime = p.lifetime - dt;

        // Age-based size and color
        let age01 = clamp(1.0 - p.lifetime / max(p.maxLifetime, 0.0001), 0.0, 1.0);
        p.size = mix(td.sizeStart, td.sizeEnd, age01);
        let gradientColor = sampleGradient(td, age01);
        if ((p.flags & FLAG_LEAF) != 0u) {
            let warmLeaf = mix(td.colorStart.rgb, gradientColor.rgb, 0.45);
            let leafAmbient = 0.18 + clamp(globals.leafLight, 0.0, 1.0) * 0.82;
            p.color = vec4<f32>(warmLeaf * leafAmbient, max(gradientColor.a, 0.72));
        } else {
            p.color = gradientColor;
        }
        if (p.ptype == ${fireflyTypeId}u) {
            let fireflyGlow = clamp(globals.fireflyGlow, 0.0, 1.0);
            let visualGlow = pow(fireflyGlow, 2.2);
            let sizeScale = 0.24 + fireflyGlow * (1.8 - 0.24);
            p.size = p.size * sizeScale;
            p.color = vec4<f32>(
                p.color.rgb * visualGlow,
                p.color.a * visualGlow
            );
        }
        // Apply HDR emissive multiplier (values > 1.0 bloom via postprocessing).
        if (td.emissive > 1.0) {
            p.color = vec4<f32>(p.color.rgb * td.emissive, p.color.a);
        }

        // Debug override: oversized magenta blobs visible from anywhere.
        if (globals.debugMode == 1u) {
            p.size  = 2.0;
            p.color = vec4<f32>(1.0, 0.0, 1.0, 1.0);
        }
        if (globals.debugMode == 2u && (p.flags & FLAG_LEAF) != 0u) {
            p.color = vec4<f32>(0.05, 0.95, 1.0, 1.0);
        }

        if ((p.flags & FLAG_ROTATE) != 0u) {
            if ((p.flags & FLAG_LEAF) != 0u) {
                let leafSpinHash = hashToFloat(i * 9151u + 1237u);
                let spinSign = select(-1.0, 1.0, leafSpinHash > 0.5);
                let gustSpin = 1.0 + abs(sin(globals.time * 1.1 + leafSpinHash * 12.7)) * 2.8;
                p.rotation = p.rotation + dt * spinSign * (0.8 + gustSpin);
            } else {
                p.rotation = p.rotation + dt * 0.4;
            }
        }

        if (p.lifetime > 0.0) {
            publishLive(i, p.flags);
        } else {
            p.flags = p.flags & (~FLAG_ALIVE);
        }
    } else {
        if (globals.totalSpawnBudget > 0u && globals.emitterCount > 0u) {
            let claim = atomicAdd(&spawnScratch.claimed, 1u);
            if (claim < globals.totalSpawnBudget) {
                p = spawnParticle(i, remapSpawnClaim(i, claim));
                publishLive(i, p.flags);
            } else {
                killParticle(&p);
            }
        } else {
            killParticle(&p);
        }
    }

    particlesOut[i] = p;
}
`;
}
