// js/actors/movementResolver.wgsl.js

export function buildMovementResolverShader() {
    return /* wgsl */`
const INTENT_STRIDE: u32 = 16u;
const STATE_STRIDE: u32 = 16u;
const MAX_PROBE: u32 = 64u;

// CloseTreeInfo stride: 128 bytes = 32 f32
const CLOSE_TREE_STRIDE: u32 = 32u;

const F_FWD: u32 = 1u;
const F_BACK: u32 = 2u;
const F_LEFT: u32 = 4u;
const F_RIGHT: u32 = 8u;
const F_TARGET: u32 = 16u;

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
    maxColliders: u32,        // clamp for closeTreeCount (tracker atomic can overshoot)
    trunkRadiusScale: f32,    // collision radius = tree.width * this (visual ≈ 0.025)
    trunkRadiusMin: f32,      // floor so tiny trees still block
}

@group(0) @binding(0) var<storage, read> intents: array<f32>;
@group(0) @binding(1) var<storage, read_write> states: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;
@group(0) @binding(3) var heightTex: texture_2d_array<f32>;
@group(0) @binding(4) var normalTex: texture_2d_array<f32>;
@group(0) @binding(5) var<storage, read> hashTable: array<u32>;
// Close-tree buffer from TreeDetailSystem. Camera-centric cull
// (detailRange ≈ 80m, cap 512). Layout per CloseTreeInfo struct:
//   [0-2] worldPos.xyz  [4] scaleX (tree width)  [5] scaleY (height)
@group(0) @binding(6) var<storage, read> closeTrees: array<f32>;
@group(0) @binding(7) var<storage, read> closeTreeCount: array<u32>;

// ── Hash table (matches TileHashTable on CPU) ───────────────────────
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

// ── Cube-sphere mapping ─────────────────────────────────────────────
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
    out.found = false;
    out.height = 0.0;
    out.slope = 0.0;

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
// Pushes the candidate position out of any penetrating tree trunk.
// The push is along the tangent-plane separation vector, so forward
// motion at an angle slides around the trunk naturally.
//
// Future-proof hooks:
//   - height gate: skip if |dot(diff, up)| > tree.scaleY (cliff edge case)
//   - climbable flag: replace hard push with vertical lift
//   - multi-archetype: replace width-based radius with per-archetype
//     collider table (radius, height, response flags)
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

        let trunkR = max(
            treeWidth * params.trunkRadiusScale,
            params.trunkRadiusMin
        );
        let minSep = trunkR + actorRadius;

        // Separation in the local tangent plane (remove radial component).
        let diff = pos - treePos;
        let horiz = diff - up * dot(diff, up);
        let hLen = length(horiz);

        if (hLen < minSep && hLen > 0.001) {
            let pushDir = horiz / hLen;
            pos = pos + pushDir * (minSep - hLen);
        }
    }
    // Single pass: with dense clusters, push from tree A can re-penetrate
    // tree B. Two iterations would fix most cases. Deferred until needed.
    return pos;
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

    let sb = idx * STATE_STRIDE;
    var pos = vec3<f32>(states[sb + 0u], states[sb + 1u], states[sb + 2u]);

    let up = normalize(pos - params.origin);
    let frame = tangentFrame(up, yaw);

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

    if (mlen > 0.01) {
        moveDir = moveDir / mlen;
        var cand = pos + moveDir * speed * dt;

        // Tree trunks — slide around cylinders.
        cand = resolveTreeCollision(cand, up, actorRadius);

        let cUp = normalize(cand - params.origin);
        let ts = sampleTerrain(cand);
        if (ts.found) {
            cand = params.origin + cUp * (params.radius + ts.height);
            if (ts.slope <= maxSlope) {
                pos = cand;
                moveState = 1.0;
            } else {
                moveState = 2.0;
            }
        } else {
            let curR = length(pos - params.origin);
            pos = params.origin + cUp * curR;
            moveState = 1.0;
        }
    }

    let here = sampleTerrain(pos);
    var grounded = 0.0;
    var slope = here.slope;
    if (here.found) {
        let pu = normalize(pos - params.origin);
        pos = params.origin + pu * (params.radius + here.height);
        grounded = 1.0;
    }

    states[sb + 0u] = pos.x;
    states[sb + 1u] = pos.y;
    states[sb + 2u] = pos.z;
    states[sb + 3u] = yaw;
    states[sb + 4u] = moveState;
    states[sb + 5u] = grounded;
    states[sb + 6u] = slope;
    states[sb + 7u] = 0.0;
}
`;
}