import { buildAtmoBankCommonWGSL } from './atmoBankCommon.wgsl.js';

export function buildAtmoBankSimulateWGSL({
    workgroupSize = 64,
    typeCapacity = 4,
    emitterCapacity = 32,
} = {}) {
    const common = buildAtmoBankCommonWGSL({ typeCapacity, emitterCapacity });

    return /* wgsl */`
${common}

@group(0) @binding(0)  var<uniform>            globals      : AtmoGlobals;
@group(0) @binding(1)  var<uniform>            typeDefs     : array<AtmoTypeDef, ATMO_TYPE_CAPACITY>;
@group(0) @binding(2)  var<storage, read>      particlesIn  : array<AtmoParticle>;
@group(0) @binding(3)  var<storage, read_write> particlesOut : array<AtmoParticle>;
@group(0) @binding(4)  var<storage, read_write> indirect     : AtmoDrawIndirect;
@group(0) @binding(5)  var<storage, read_write> liveList     : array<u32>;
@group(0) @binding(6)  var<storage, read_write> spawnScratch : AtmoSpawnScratch;
@group(0) @binding(7)  var<storage, read>       emitters     : array<AtmoEmitterDef, ATMO_EMITTER_CAPACITY>;
@group(0) @binding(8)  var<storage, read_write> emitterCounter : AtmoEmitterCounter;

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
    return f32(hash1u(seed) & 0x00FFFFFFu) / f32(0x01000000u);
}

fn rand01(index: u32, salt: u32, seed: u32) -> f32 {
    return hashToFloat(index * 2246822519u + salt * 3266489917u + seed);
}

fn randRange(index: u32, salt: u32, seed: u32, lo: f32, hi: f32) -> f32 {
    return lo + (hi - lo) * rand01(index, salt, seed);
}

fn buildLocalBasis(up: vec3<f32>) -> mat3x3<f32> {
    let u = normalize(up);
    var refAxis = vec3<f32>(0.0, 0.0, 1.0);
    if (abs(u.z) > 0.9) { refAxis = vec3<f32>(1.0, 0.0, 0.0); }
    let r = normalize(cross(u, refAxis));
    let fwd = cross(r, u);
    return mat3x3<f32>(r, u, fwd);
}

fn resolveLocalUp(position: vec3<f32>) -> vec3<f32> {
    let local = position - globals.planetOrigin;
    let lenSq = dot(local, local);
    if (lenSq > 1e-8) { return normalize(local); }
    return vec3<f32>(0.0, 1.0, 0.0);
}

struct EmitterSelection {
    idx: u32,
    valid: u32,
};

fn selectEmitterIndex(claim: u32, emitterCount: u32) -> EmitterSelection {
    var accum = 0u;
    var selection: EmitterSelection;
    selection.idx = 0u;
    selection.valid = 0u;

    for (var idx = 0u; idx < ATMO_EMITTER_CAPACITY; idx++) {
        if (idx >= emitterCount) { break; }
        let nextAccum = accum + emitters[idx].spawnBudget;
        if (claim < nextAccum) {
            selection.idx = idx;
            selection.valid = 1u;
            return selection;
        }
        accum = nextAccum;
    }
    return selection;
}

fn spawnParticle(slot: u32, claim: u32, emIdx: u32) -> AtmoParticle {
    let emitter = emitters[emIdx];
    let seedBase = slot ^ (claim * 7919u) ^ emitter.rngSeed;
    let td = typeDefs[emitter.typeId];

    let basis = buildLocalBasis(emitter.localUp);

    let angle = rand01(seedBase, 11u, emitter.rngSeed) * 6.2831853;
    let r = sqrt(rand01(seedBase, 12u, emitter.rngSeed));
    let spawnRadius = mix(td.sizeMin * 0.3, td.sizeMax * 0.5, r);
    let lx = cos(angle) * spawnRadius;
    let lz = sin(angle) * spawnRadius;
    var minUp = td.sizeMin * 0.02;
    var maxUp = td.sizeMax * 0.10;
    if (emitter.typeId == 1u) {
        minUp = td.sizeMin * 0.02;
        maxUp = td.sizeMax * 0.08;
    }
    if (emitter.typeId == 2u) {
        minUp = td.sizeMin * 0.05;
        maxUp = td.sizeMax * 0.14;
    }
    let ly = randRange(seedBase, 13u, emitter.rngSeed, minUp, maxUp);
    let localOffset = basis * vec3<f32>(lx, ly, lz);

    let windX = globals.windDirX * globals.windSpeed * td.windResponse;
    let windZ = globals.windDirY * globals.windSpeed * td.windResponse;
    let vx = windX + randRange(seedBase, 21u, emitter.rngSeed, -0.3, 0.3);
    let vy = randRange(seedBase, 22u, emitter.rngSeed, -0.05, 0.05);
    let vz = windZ + randRange(seedBase, 23u, emitter.rngSeed, -0.3, 0.3);

    let life = randRange(seedBase, 31u, emitter.rngSeed, td.lifeMin, td.lifeMax);

    var p: AtmoParticle;
    p.position    = emitter.position + localOffset;
    p.lifetime    = life;
    p.velocity    = vec3<f32>(vx, vy, vz);
    p.maxLifetime = life;
    p.noisePhase  = vec3<f32>(
        rand01(seedBase, 41u, emitter.rngSeed) * 100.0,
        rand01(seedBase, 42u, emitter.rngSeed) * 100.0,
        rand01(seedBase, 43u, emitter.rngSeed) * 100.0,
    );
    p.size     = randRange(seedBase, 51u, emitter.rngSeed, td.sizeMin, td.sizeMax);
    p.color    = td.color;
    p.ptype    = emitter.typeId;
    p.flags    = ATMO_FLAG_ALIVE;
    p.opacity  = 0.0;
    p._pad     = 0.0;
    return p;
}

@compute @workgroup_size(${workgroupSize})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x;
    if (i >= globals.maxParticles) { return; }

    var p = particlesIn[i];
    let dt = globals.dt;

    if (p.lifetime > 0.0 && (p.flags & ATMO_FLAG_ALIVE) != 0u) {
        let td = typeDefs[p.ptype];

        let windForce = vec3<f32>(
            globals.windDirX * globals.windSpeed * td.windResponse,
            0.0,
            globals.windDirY * globals.windSpeed * td.windResponse
        );
        p.velocity = p.velocity + windForce * dt;
        p.velocity = p.velocity * exp(-0.5 * dt);

        p.position = p.position + p.velocity * dt;
        p.lifetime = p.lifetime - dt;

        let cameraDist = length(p.position - globals.cameraPos);
        let fadeNear = smoothstep(0.0, td.fadeNearStart, cameraDist);
        let fadeFar  = smoothstep(td.fadeFarEnd, td.fadeFarStart, cameraDist);
        let ageFade  = smoothstep(0.0, 5.0, p.maxLifetime - p.lifetime) *
                       smoothstep(0.0, 5.0, p.lifetime);
        p.opacity = fadeNear * fadeFar * ageFade * td.densityBase;

        if (p.lifetime > 0.0 && cameraDist < globals.maxRenderDist) {
            let idx = atomicAdd(&indirect.instanceCount, 1u);
            liveList[idx] = i;
        } else if (p.lifetime <= 0.0) {
            p.flags = 0u;
        }
    } else {
        let emitterCount = min(atomicLoad(&emitterCounter.count), ATMO_EMITTER_CAPACITY);
        if (emitterCount > 0u) {
            let claim = atomicAdd(&spawnScratch.claimed, 1u);
            let selection = selectEmitterIndex(claim, emitterCount);
            if (selection.valid != 0u) {
                p = spawnParticle(i, claim, selection.idx);
                let idx = atomicAdd(&indirect.instanceCount, 1u);
                liveList[idx] = i;
            } else {
                p.flags = 0u; p.lifetime = 0.0; p.opacity = 0.0;
            }
        } else {
            p.flags = 0u; p.lifetime = 0.0; p.opacity = 0.0;
        }
    }

    particlesOut[i] = p;
}
`;
}
