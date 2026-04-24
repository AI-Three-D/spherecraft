// core/actors/movementResolver.wgsl.js
//
// Spherical-planet actor movement resolver — the core GPU physics step
// used by every game in this engine. Moved from wizard_game/actors/
// so it can be reused by platform_game and future games.
//
// Per-actor inputs (INTENT_STRIDE = 16 f32):
//   [0]  flags (u32 bitcast) — F_FWD/BACK/LEFT/RIGHT/TARGET/JUMP
//   [1]  yaw                 — facing direction in the tangent frame
//   [2]  speed                — horizontal move speed (m/s)
//   [3]  dt                   — frame delta time (s)
//   [4-6] target (world xyz)  — move-to-target destination
//   [7]  maxSlope             — sin(maxSlopeAngle); above this, actor is blocked
//   [8]  actorRadius          — horizontal collision radius
//   [9]  jumpVelocity         — vertical velocity to apply on jump (m/s)
//   [10] gravityScale         — per-actor gravity multiplier (fruit anti-grav = ~0.25)
//
// Per-actor state (STATE_STRIDE = 16 f32):
//   [0-2] world pos
//   [3]   yaw
//   [4]   moveState (0 idle, 1 walking, 2 blocked)
//   [5]   grounded (0/1)
//   [6]   slope (last-sampled)
//   [7]   vertVel           — signed radial velocity (m/s, positive = up)
//   [8]   airTime           — seconds since last grounded
//   [9]   peakFallSpeed     — maximum downward speed recorded this airborne spell (m/s)
//   [10]  lastImpactSpeed   — set on landing with the peak fall speed, cleared when grounded resumes
//   [11]  altitude          — distance from planet origin to pos (convenience)
//
// Platform collider buffer (CLOSE_PLATFORM_STRIDE = 16 f32):
//   [0-2] pos (world xyz of the platform top-center)
//   [3]   radius (disc radius in the tangent plane)
//   [4]   thickness (how much below the top surface still counts as "inside")
//   [5-7] velocity (optional — world-space drift, used to carry the actor with the platform)
//
// Params uniform (256-byte-aligned):
//   see ActorGPUBuffers.uploadParams for exact field order.

export function buildMovementResolverShader() {
    return /* wgsl */`
const INTENT_STRIDE: u32 = 16u;
const STATE_STRIDE: u32 = 16u;
const MAX_PROBE: u32 = 64u;

const CLOSE_TREE_STRIDE: u32 = 32u;       // 128 bytes — matches TreeDetailSystem layout
const CLOSE_PLATFORM_STRIDE: u32 = 16u;   // 64 bytes — platform top-surface collider

const F_FWD: u32 = 1u;
const F_BACK: u32 = 2u;
const F_LEFT: u32 = 4u;
const F_RIGHT: u32 = 8u;
const F_TARGET: u32 = 16u;
const F_JUMP: u32 = 32u;

struct Params {
    origin: vec3<f32>,
    radius: f32,
    heightScale: f32,
    faceSize: f32,
    hashMask: u32,
    hashCapacity: u32,
    tileTexSize: u32,
    actorCount: u32,
    maxDepth: u32,
    maxColliders: u32,
    trunkRadiusScale: f32,
    trunkRadiusMin: f32,
    gravity: f32,            // m/s² (positive magnitude; applied radially inward)
    maxPlatforms: u32,       // clamp for closePlatformCount
    groundStickSpeed: f32,   // |vertVel| below which we snap to ground instead of floating
}

@group(0) @binding(0) var<storage, read> intents: array<f32>;
@group(0) @binding(1) var<storage, read_write> states: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;
@group(0) @binding(3) var heightTex: texture_2d_array<f32>;
@group(0) @binding(4) var normalTex: texture_2d_array<f32>;
@group(0) @binding(5) var<storage, read> hashTable: array<u32>;
@group(0) @binding(6) var<storage, read> closeTrees: array<f32>;
@group(0) @binding(7) var<storage, read> closeTreeCount: array<u32>;
@group(0) @binding(8) var<storage, read> closePlatforms: array<f32>;
@group(0) @binding(9) var<storage, read> closePlatformCount: array<u32>;

// ── Hash table lookup (matches TileHashTable on CPU) ───────────────
fn hashKey(keyLo: u32, keyHi: u32) -> u32 {
    let kl = keyLo ^ (keyLo >> 16u);
    let kh = keyHi ^ (keyHi >> 16u);
    let h = (kl * 0x9E3779B1u) ^ (kh * 0x85EBCA77u);
    return h & params.hashMask;
}

fn lookupLayer(face: u32, depth: u32, x: u32, y: u32) -> i32 {
    let keyLo = (x & 0xFFFFu) | ((y & 0xFFFFu) << 16u);
    let keyHi = (depth & 0xFFFFu) | ((face & 0xFFFFu) << 16u);
    var idx = hashKey(keyLo, keyHi);
    let cap = params.hashCapacity;
    for (var i = 0u; i < min(cap, MAX_PROBE); i++) {
        let base = idx * 4u;
        let hi = hashTable[base + 1u];
        if (hi == 0xFFFFFFFFu) { return -1; }
        if (hi == keyHi && hashTable[base] == keyLo) {
            return i32(hashTable[base + 2u]);
        }
        idx = (idx + 1u) & params.hashMask;
    }
    return -1;
}

fn dirToFaceUV(d: vec3<f32>) -> vec3<f32> {
    let ad = abs(d);
    var face = 0u; var s = 0.0; var t = 0.0; var inv: f32;
    if (ad.x >= ad.y && ad.x >= ad.z) {
        inv = 1.0 / ad.x;
        if (d.x > 0.0) { face = 0u; s = -d.z * inv; t = d.y * inv; }
        else           { face = 1u; s =  d.z * inv; t = d.y * inv; }
    } else if (ad.y >= ad.z) {
        inv = 1.0 / ad.y;
        if (d.y > 0.0) { face = 2u; s = d.x * inv; t = -d.z * inv; }
        else           { face = 3u; s = d.x * inv; t =  d.z * inv; }
    } else {
        inv = 1.0 / ad.z;
        if (d.z > 0.0) { face = 4u; s =  d.x * inv; t = d.y * inv; }
        else           { face = 5u; s = -d.x * inv; t = d.y * inv; }
    }
    return vec3<f32>(f32(face), s * 0.5 + 0.5, t * 0.5 + 0.5);
}

struct TerrainSample { height: f32, slope: f32, found: bool }

fn sampleTerrain(worldPos: vec3<f32>) -> TerrainSample {
    let dir = normalize(worldPos - params.origin);
    let fuv = dirToFaceUV(dir);
    let face = u32(fuv.x);
    let u = clamp(fuv.y, 0.0, 0.999999);
    let v = clamp(fuv.z, 0.0, 0.999999);

    var out: TerrainSample;
    out.found = false; out.height = 0.0; out.slope = 0.0;

    let texSize = i32(params.tileTexSize);
    var d = params.maxDepth;
    loop {
        let grid = 1u << d;
        let tx = min(u32(u * f32(grid)), grid - 1u);
        let ty = min(u32(v * f32(grid)), grid - 1u);
        let layer = lookupLayer(face, d, tx, ty);
        if (layer >= 0) {
            let tileSize = 1.0 / f32(grid);
            let lu = (u - f32(tx) * tileSize) / tileSize;
            let lv = (v - f32(ty) * tileSize) / tileSize;
            let px = clamp(i32(lu * f32(texSize - 1) + 0.5), 0, texSize - 1);
            let py = clamp(i32(lv * f32(texSize - 1) + 0.5), 0, texSize - 1);
            let h = textureLoad(heightTex, vec2<i32>(px, py), layer, 0).r;
            let n = textureLoad(normalTex, vec2<i32>(px, py), layer, 0);
            out.height = h * params.heightScale;
            out.slope = n.b;
            out.found = true;
            break;
        }
        if (d == 0u) { break; }
        d = d - 1u;
    }
    return out;
}

struct Frame { fwd: vec3<f32>, right: vec3<f32> }

fn tangentFrame(up: vec3<f32>, yaw: f32) -> Frame {
    var _ref = vec3<f32>(0.0, 1.0, 0.0);
    if (abs(up.y) > 0.99) { _ref = vec3<f32>(0.0, 0.0, 1.0); }
    var r = normalize(cross(up, _ref));
    var f = cross(r, up);

    let c = cos(yaw); let s = sin(yaw);
    let fr = f * c + cross(up, f) * s + up * dot(up, f) * (1.0 - c);
    let rr = r * c + cross(up, r) * s + up * dot(up, r) * (1.0 - c);
    var out: Frame;
    out.fwd = normalize(fr);
    out.right = normalize(rr);
    return out;
}

// ── Tree collision (cylinder, sliding response) ─────────────────────
fn resolveTreeCollision(
    candidate: vec3<f32>, up: vec3<f32>, actorRadius: f32
) -> vec3<f32> {
    let n = min(closeTreeCount[0], params.maxColliders);
    var pos = candidate;

    for (var i = 0u; i < n; i++) {
        let b = i * CLOSE_TREE_STRIDE;
        let treePos = vec3<f32>(
            closeTrees[b + 0u], closeTrees[b + 1u], closeTrees[b + 2u]
        );
        let treeWidth = closeTrees[b + 4u];
        let trunkR = max(treeWidth * params.trunkRadiusScale, params.trunkRadiusMin);
        let minSep = trunkR + actorRadius;

        let diff = pos - treePos;
        let horiz = diff - up * dot(diff, up);
        let hLen = length(horiz);
        if (hLen < minSep && hLen > 0.001) {
            pos = pos + (horiz / hLen) * (minSep - hLen);
        }
    }
    return pos;
}

// ── Platform top-surface collision ──────────────────────────────────
// Treats each platform as a disc in the tangent plane of its center.
// Returns the highest platform-top radius along the actor's radial line
// that is reachable from (pos, prevAltitude). "Reachable" means the
// actor's vertical sweep from prevAltitude down to currentAltitude
// crossed the platform's top face and the actor is within the disc
// footprint.
//
// Outputs altitude (distance from params.origin along actor up) of the
// top surface, or -1.0 if no platform applies.
fn resolvePlatformTop(
    pos: vec3<f32>, up: vec3<f32>, prevAltitude: f32, actorRadius: f32
) -> f32 {
    let n = min(closePlatformCount[0], params.maxPlatforms);
    var bestAlt: f32 = -1.0;

    for (var i = 0u; i < n; i++) {
        let b = i * CLOSE_PLATFORM_STRIDE;
        let pPos = vec3<f32>(
            closePlatforms[b + 0u], closePlatforms[b + 1u], closePlatforms[b + 2u]
        );
        let pR = closePlatforms[b + 3u];
        let pThick = closePlatforms[b + 4u];

        // Disc check: project the actor's position onto the plane through
        // the platform center with normal = platform up (≈ radial from origin).
        let platUp = normalize(pPos - params.origin);
        let diff = pos - pPos;
        // Horizontal distance within the platform's tangent plane.
        let horiz = diff - platUp * dot(diff, platUp);
        if (length(horiz) > pR + actorRadius) { continue; }

        // Altitude of the platform's top surface along the actor's radial.
        let platAlt = length(pPos - params.origin);
        let curAlt = length(pos - params.origin);

        // Only land if we were above the top surface in the previous step
        // and are now at/below it (sweep test), OR if we're within the
        // top 'pThick' band of the platform (forgiving step-on).
        let aboveThen = prevAltitude >= platAlt - 0.02;
        let atOrBelowNow = curAlt <= platAlt + pThick;
        if (aboveThen && atOrBelowNow) {
            if (platAlt > bestAlt) { bestAlt = platAlt; }
        }
    }
    return bestAlt;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    if (idx >= params.actorCount) { return; }

    let ib = idx * INTENT_STRIDE;
    let flags = bitcast<u32>(intents[ib + 0u]);
    let yaw = intents[ib + 1u];
    let speed = intents[ib + 2u];
    let dt = intents[ib + 3u];
    let tgt = vec3<f32>(intents[ib + 4u], intents[ib + 5u], intents[ib + 6u]);
    let maxSlope = intents[ib + 7u];
    let actorRadius = intents[ib + 8u];
    let jumpVelocity = intents[ib + 9u];
    let gravityScale = intents[ib + 10u];

    let sb = idx * STATE_STRIDE;
    var pos = vec3<f32>(states[sb + 0u], states[sb + 1u], states[sb + 2u]);
    var vertVel = states[sb + 7u];
    var airTime = states[sb + 8u];
    var peakFall = states[sb + 9u];
    var lastImpact = states[sb + 10u];
    // state[12] holds a "hasLandedOnce" marker that prevents the long
    // spawn-drop from generating a huge fall-damage event on first touch.
    var hasLanded = states[sb + 12u];

    let up = normalize(pos - params.origin);
    let frame = tangentFrame(up, yaw);
    let prevAlt = length(pos - params.origin);

    // ── Horizontal intent (tangent-plane motion) ────────────────────
    var moveDir = vec3<f32>(0.0);
    if ((flags & F_FWD) != 0u)   { moveDir += frame.fwd; }
    if ((flags & F_BACK) != 0u)  { moveDir -= frame.fwd; }
    if ((flags & F_LEFT) != 0u)  { moveDir -= frame.right; }
    if ((flags & F_RIGHT) != 0u) { moveDir += frame.right; }

    if ((flags & F_TARGET) != 0u && length(moveDir) < 0.01) {
        let toT = tgt - pos;
        let proj = toT - up * dot(toT, up);
        if (length(proj) > 0.5) { moveDir = normalize(proj); }
    }

    var moveState = 0.0;
    let mlen = length(moveDir);

    // Horizontal advance in the tangent plane (airborne actors have
    // reduced control, same direction but 60% speed).
    let airControlScale = select(1.0, 0.6, airTime > 0.05);
    var cand = pos;
    if (mlen > 0.01) {
        moveDir = moveDir / mlen;
        cand = pos + moveDir * speed * airControlScale * dt;
        cand = resolveTreeCollision(cand, up, actorRadius);
        moveState = 1.0;
    }

    // ── Vertical integration ────────────────────────────────────────
    // gravityScale <= 0: legacy terrain-snap mode (no vertical physics).
    // Positive: full physics with gravity (radially inward).
    let physicsOn = gravityScale > 0.001;
    if (physicsOn) {
        let gravityAccel = params.gravity * gravityScale;
        vertVel = vertVel - gravityAccel * dt;

        // Jump impulse: only honored when grounded.
        if ((flags & F_JUMP) != 0u && airTime < 0.001) {
            vertVel = max(vertVel, jumpVelocity);
        }

        cand = cand + up * vertVel * dt;
    } else {
        // Legacy: keep vertical zero, snap to terrain unconditionally.
        vertVel = 0.0;
        airTime = 0.0;
        peakFall = 0.0;
    }

    // ── Terrain vs platform resolution ──────────────────────────────
    let cUp = normalize(cand - params.origin);
    let ts = sampleTerrain(cand);
    let terrainAlt = select(params.radius, params.radius + ts.height, ts.found);
    let platTopAlt = resolvePlatformTop(cand, cUp, prevAlt, actorRadius);

    // Pick the higher of terrain and any reachable platform.
    var groundAlt = terrainAlt;
    var onPlatform = false;
    if (platTopAlt > groundAlt) { groundAlt = platTopAlt; onPlatform = true; }

    let candAlt = length(cand - params.origin);
    var grounded = 0.0;

    // Legacy terrain-snap path short-circuits the airborne branch.
    if (!physicsOn && ts.found) {
        cand = params.origin + cUp * groundAlt;
        grounded = 1.0;
        airTime = 0.0;
        hasLanded = 1.0;
        // fall through to the write-state block below; avoid the
        // double-branch by bypassing the physics-on checks with this
        // slightly inelegant early recomputation.
    } else if (candAlt <= groundAlt + 0.001) {
        // Landed on ground/platform: snap to surface and zero vertical vel.
        // Record peak fall speed as last-impact so CPU can deal damage.
        // First-ever ground contact (spawn drop) is suppressed — we don't
        // penalise the player for the unavoidable spawn fall.
        if (vertVel < 0.0) {
            let fallSpeed = -vertVel;
            if (fallSpeed > peakFall) { peakFall = fallSpeed; }
            if (hasLanded > 0.5) { lastImpact = peakFall; }
            else { lastImpact = 0.0; }
        }
        cand = params.origin + cUp * groundAlt;
        vertVel = 0.0;
        grounded = 1.0;
        airTime = 0.0;
        peakFall = 0.0;
        hasLanded = 1.0;
        // Slope gating: on raw terrain, block moves onto too-steep slopes.
        if (!onPlatform && ts.found && mlen > 0.01 && ts.slope > maxSlope) {
            // Reject horizontal motion: retain only vertical snap.
            cand = params.origin + normalize(pos - params.origin) * groundAlt;
            moveState = 2.0;
        }
    } else {
        airTime = airTime + dt;
        if (-vertVel > peakFall) { peakFall = -vertVel; }
    }

    pos = cand;

    // ── Write state ─────────────────────────────────────────────────
    let finalAlt = length(pos - params.origin);
    states[sb + 0u] = pos.x;
    states[sb + 1u] = pos.y;
    states[sb + 2u] = pos.z;
    states[sb + 3u] = yaw;
    states[sb + 4u] = moveState;
    states[sb + 5u] = grounded;
    states[sb + 6u] = ts.slope;
    states[sb + 7u] = vertVel;
    states[sb + 8u] = airTime;
    states[sb + 9u] = peakFall;
    states[sb + 10u] = lastImpact;
    states[sb + 11u] = finalAlt;
    states[sb + 12u] = hasLanded;
}
`;
}
