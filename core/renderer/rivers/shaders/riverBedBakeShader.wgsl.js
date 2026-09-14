// core/renderer/rivers/shaders/riverBedBakeShader.wgsl.js
//
// Bakes a river patch's bed heightfield by sampling spherecraft's *real*
// terrain height at each grid cell. Adapts core/world/BiomeQuery.js's
// per-point hash-table lookup + height sample into a full-grid dispatch,
// dropping the tile/normal/climate texture lookups BiomeQuery also does
// (only height is needed for the shallow-water solver's bed).
//
// Cells whose world position doesn't resolve to a resident tile (streaming
// hasn't caught up yet) are written as a sentinel below RIVER_BED_BAKE_INVALID
// so the CPU side can tell real (possibly zero) heights apart from misses.

export const RIVER_BED_BAKE_INVALID_SENTINEL = -100000.0;

export function buildRiverBedBakeShader() {
    return /* wgsl */`
struct BakeParams {
    origin:       vec3<f32>,
    radius:       f32,
    heightScale:  f32,
    hashMask:     u32,
    hashCapacity: u32,
    tileTexSize:  u32,
    maxDepth:     u32,
    gridW:        u32,
    gridL:        u32,
    dx:           f32,
    patchAnchor:  vec3<f32>,
    _pad0:        f32,
    patchRight:   vec3<f32>,
    _pad1:        f32,
    patchForward: vec3<f32>,
    _pad2:        f32,
}

@group(0) @binding(0) var<uniform>             params:    BakeParams;
@group(0) @binding(1) var                      heightTex: texture_2d_array<f32>;
@group(0) @binding(2) var<storage, read>       hashTable: array<u32>;
@group(0) @binding(3) var<storage, read_write> bedOut:    array<f32>;
// Debug-only: [depth, layer (0xFFFFFFFF if never found), tx, ty] for the
// patch's center cell, written by whichever invocation happens to own it.
// See RiverSystem.debugBedInfo() / window.riverBedDebug() in standalone.html.
@group(0) @binding(4) var<storage, read_write> debugOut:  array<u32>;

// Must match the real loaded-tile hash table's own probe limit
// (core/world/quadtree/quadtreeTraversal.wgsl.js's isLoaded()), not the
// smaller value BiomeQuery.js happens to use — a real, populated tile's
// probe chain can run past 64 while comfortably under 256, especially for
// tiles streamed in together (spatial locality clusters in hash space).
const MAX_PROBE: u32 = 256u;
const INVALID: f32 = ${RIVER_BED_BAKE_INVALID_SENTINEL.toFixed(1)};

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

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    // Unconditional sanity write: every single invocation (whole workgroup
    // grid, not just the intended bounds) writes here, before anything else
    // — including before the gridW/gridL bounds check, and to a dedicated
    // slot nothing else ever touches. If this doesn't read back as exactly
    // 0xC0FFEE, the debug buffer's bind/copy/readback path itself is broken,
    // independent of any other logic in this shader.
    debugOut[32] = 0xC0FFEEu;

    let i = gid.x; let j = gid.y;
    if (i >= params.gridW || j >= params.gridL) { return; }
    let outIdx = j * params.gridW + i;

    let localX = (f32(i) + 0.5) * params.dx - 0.5 * f32(params.gridW) * params.dx;
    let localZ = (f32(j) + 0.5) * params.dx - 0.5 * f32(params.gridL) * params.dx;
    let worldPos = params.patchAnchor + params.patchRight * localX + params.patchForward * localZ;
    let dir = normalize(worldPos - params.origin);
    let fuv = dirToFaceUV(dir);
    let face = u32(fuv.x);
    let u = clamp(fuv.y, 0.0, 0.999999);
    let v = clamp(fuv.z, 0.0, 0.999999);
    let texSize = i32(params.tileTexSize);

    let dbgI = params.gridW / 2u; let dbgJ = params.gridL / 2u;

    var d = params.maxDepth;
    var found = false;
    var height = 0.0;
    var foundTx = 0u; var foundTy = 0u; var foundLayer = -1;
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
            height = textureLoad(heightTex, vec2<i32>(px, py), layer, 0).r;
            found = true;
            foundTx = tx; foundTy = ty; foundLayer = layer;
            break;
        }
        if (d == 0u) { break; }
        d = d - 1u;
    }

    // A coarse ancestor tile (found at a much lower depth than maxDepth) is
    // typically a still-loading placeholder, not real terrain detail — using
    // it would silently lock the whole patch onto approximate/near-zero
    // heights the first time ANY tile happens to be resident, well before
    // the fine-detail tile actually under the patch streams in. Require the
    // match to be reasonably close to maxDepth; otherwise treat the cell as
    // unresolved so RiverSystem's retry loop keeps waiting for real detail.
    const MIN_DEPTH_BELOW_MAX: u32 = 3u;
    let acceptable = found && (d + MIN_DEPTH_BELOW_MAX >= params.maxDepth);
    bedOut[outIdx] = select(INVALID, height * params.heightScale, acceptable);

    if (i == dbgI && j == dbgJ) {
        // Comprehensive raw dump for the center cell: every intermediate
        // value, not just derived conclusions, so a wiring/offset bug shows
        // up directly instead of needing another round of guessing.
        debugOut[0] = params.gridW;
        debugOut[1] = params.gridL;
        debugOut[2] = params.maxDepth;
        debugOut[3] = params.hashMask;
        debugOut[4] = params.hashCapacity;
        debugOut[5] = params.tileTexSize;
        debugOut[6] = bitcast<u32>(params.origin.x);
        debugOut[7] = bitcast<u32>(params.origin.y);
        debugOut[8] = bitcast<u32>(params.origin.z);
        debugOut[9] = bitcast<u32>(params.heightScale);
        debugOut[10] = bitcast<u32>(params.dx);
        debugOut[11] = bitcast<u32>(params.patchAnchor.x);
        debugOut[12] = bitcast<u32>(params.patchAnchor.y);
        debugOut[13] = bitcast<u32>(params.patchAnchor.z);
        debugOut[14] = bitcast<u32>(params.patchRight.x);
        debugOut[15] = bitcast<u32>(params.patchRight.y);
        debugOut[16] = bitcast<u32>(params.patchRight.z);
        debugOut[17] = bitcast<u32>(params.patchForward.x);
        debugOut[18] = bitcast<u32>(params.patchForward.y);
        debugOut[19] = bitcast<u32>(params.patchForward.z);
        debugOut[20] = bitcast<u32>(worldPos.x);
        debugOut[21] = bitcast<u32>(worldPos.y);
        debugOut[22] = bitcast<u32>(worldPos.z);
        debugOut[23] = bitcast<u32>(dir.x);
        debugOut[24] = bitcast<u32>(dir.y);
        debugOut[25] = bitcast<u32>(dir.z);
        debugOut[26] = face;
        debugOut[27] = bitcast<u32>(u);
        debugOut[28] = bitcast<u32>(v);
        debugOut[29] = select(999u, d, found);
        debugOut[30] = select(0xFFFFFFFFu, u32(foundLayer), found);
        debugOut[31] = bitcast<u32>(height);
    }
}
`;
}
