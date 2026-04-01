// js/world/quadtree/instanceBufferBuilder.wgsl.js
//
// WGSL compute shader that builds per-frame terrain instance data from the
// visible tile list produced by the quadtree traversal pass.
//
// Responsibilities:
//   - Build a hash table of visible tiles for neighbor LOD lookups
//   - Resolve loaded tile residency (exact or nearest parent)
//   - Emit instance data into a unified storage buffer
//   - Write indirect draw args (one per geometry LOD)
//   - Emit feedback requests for missing tiles

/**
 * Build the WGSL source for the instance buffer builder.
 *
 * @param {object} [config]
 * @param {number}   [config.workgroupSize=64]
 * @param {number}   [config.maxGeomLOD=6]
 * @returns {string}
 */
export function buildInstanceBuilderShaderSource(config = {}) {
    const WG = config.workgroupSize ?? 64;
    const maxGeomLOD = config.maxGeomLOD ?? 6;
    const lodLevels = maxGeomLOD + 1;

    return /* wgsl */`
// ─── Quadtree Instance Builder ────────────────────────────────────────────

struct TraversalParams {
    cameraPosition : vec3<f32>,
    _pad0          : f32,
    planetOrigin   : vec3<f32>,
    planetRadius   : f32,
    viewProjection : mat4x4<f32>,
    faceSize       : f32,
    maxDepth       : u32,
    screenHeight   : f32,
    tanHalfFov     : f32,
    lodFactor         : f32,
    lodErrorThreshold : f32,
    maxVisibleTiles   : u32,
    queueCapacity     : u32,
    maxGeomLOD         : u32,
    visibleTableMask   : u32,
    visibleTableCapacity : u32,
    loadedTableMask    : u32,
    loadedTableCapacity : u32,
    maxFeedback        : u32,
    useFrustumCulling  : u32,
    useHorizonCulling  : u32,

    maxHeightDisplacement : f32,
    horizonGroundCos : f32,
    horizonBlendScale : f32,
    currentEpoch : u32,
    doVisibleClear : u32,
    _padEnd : f32,
};

struct VisibleEntry {
    keyLo : u32,
    keyHi : u32,
    epoch : u32,
    _pad  : u32,
};

struct LoadedEntry {
    keyLo : u32,
    keyHi : u32,
    layer : u32,
    _pad  : u32,
};

struct ChunkInstance {
    position: vec3<f32>,
    face: u32,
    chunkLocation: vec2<f32>,
    chunkSizeUV: f32,
    _pad: f32,
    uvOffset: vec2<f32>,
    uvScale: f32,
    lod: u32,
    neighborLODs: vec2<u32>,
    layer: u32,
    edgeMask: u32,
}

const MAX_LOD_LEVELS : u32 = ${lodLevels}u;
const EMPTY_KEY : u32 = 0xFFFFFFFFu;

struct MetaData {
    lodCounts: array<atomic<u32>, MAX_LOD_LEVELS>,
    lodOffsets: array<u32, MAX_LOD_LEVELS>,
    lodWrite: array<atomic<u32>, MAX_LOD_LEVELS>,
    indirectArgs: array<u32, MAX_LOD_LEVELS * 5u>,
    feedbackCount: atomic<u32>,

    parentFallbackHits: atomic<u32>,
    coveringProbeSum: atomic<u32>,
    coveringProbeCount: atomic<u32>,
    coveringProbeMisses: atomic<u32>,
}

@group(0) @binding(0) var<uniform> params : TraversalParams;
@group(0) @binding(1) var<storage, read> visibleTiles : array<vec4<u32>>;
@group(0) @binding(2) var<storage, read_write> traversalCounters : array<atomic<u32>, 4>;
@group(0) @binding(3) var<storage, read_write> visibleTable : array<VisibleEntry>;
@group(0) @binding(4) var<storage, read> loadedTable : array<LoadedEntry>;
@group(0) @binding(5) var<storage, read_write> instanceBuffer : array<ChunkInstance>;
@group(0) @binding(6) var<storage, read_write> metaData : MetaData;
@group(0) @binding(7) var<storage, read_write> feedbackBuffer : array<vec4<u32>>;
@group(0) @binding(8) var<storage, read> lodIndexCounts : array<u32>;

const WORKGROUP_SIZE : u32 = ${WG}u;

fn makeKeyLo(x : u32, y : u32) -> u32 {
    return x | (y << 16u);
}

fn makeKeyHi(face : u32, depth : u32) -> u32 {
    return (depth & 0xFFFFu) | (face << 16u);
}
fn hashKey(keyLo : u32, keyHi : u32, mask : u32) -> u32 {
    let kl = keyLo ^ (keyLo >> 16u);
    let kh = keyHi ^ (keyHi >> 16u);
    let h = (kl * 0x9E3779B1u) ^ (kh * 0x85EBCA77u);
    return h & mask;
}
fn insertVisible(face : u32, depth : u32, x : u32, y : u32) {
    let keyLo = makeKeyLo(x, y);
    let keyHi = makeKeyHi(face, depth);
    var idx = hashKey(keyLo, keyHi, params.visibleTableMask);
    for (var i = 0u; i < params.visibleTableCapacity; i++) {
        let entry = visibleTable[idx];
        // Writable if: truly empty, stale epoch, or same key
        if (entry.keyHi == EMPTY_KEY ||
            entry.epoch != params.currentEpoch ||
            (entry.keyHi == keyHi && entry.keyLo == keyLo)) {
            visibleTable[idx].keyLo = keyLo;
            visibleTable[idx].keyHi = keyHi;
            visibleTable[idx].epoch = params.currentEpoch;
            return;
        }
        idx = (idx + 1u) & params.visibleTableMask;
    }
}

fn visibleExists(face : u32, depth : u32, x : u32, y : u32) -> bool {
    let keyLo = makeKeyLo(x, y);
    let keyHi = makeKeyHi(face, depth);
    var idx = hashKey(keyLo, keyHi, params.visibleTableMask);
    for (var i = 0u; i < params.visibleTableCapacity; i++) {
        let entry = visibleTable[idx];
        if (entry.keyHi == EMPTY_KEY) {
            return false;
        }
        if (entry.epoch == params.currentEpoch &&
            entry.keyHi == keyHi && entry.keyLo == keyLo) {
            return true;
        }
        // Stale entry — skip but continue probing
        idx = (idx + 1u) & params.visibleTableMask;
    }
    return false;
}

fn lookupLoaded(face : u32, depth : u32, x : u32, y : u32) -> u32 {
    let keyLo = makeKeyLo(x, y);
    let keyHi = makeKeyHi(face, depth);
    var idx = hashKey(keyLo, keyHi, params.loadedTableMask);
    for (var i = 0u; i < params.loadedTableCapacity; i++) {
        let entry = loadedTable[idx];
        if (entry.keyHi == EMPTY_KEY) {
            return EMPTY_KEY;
        }
        if (entry.keyHi == keyHi && entry.keyLo == keyLo) {
            return entry.layer;
        }
        idx = (idx + 1u) & params.loadedTableMask;
    }
    return EMPTY_KEY;
}

fn computeGeomLOD(depth : u32) -> u32 {
    let diff = i32(params.maxDepth) - i32(depth);
    let clamped = clamp(diff, 0, i32(params.maxGeomLOD));
    return u32(clamped);
}

fn findLoadedSourceDepth(face : u32, depth : u32, x : u32, y : u32) -> u32 {
    var d = depth;
    var tx = x;
    var ty = y;
    loop {
        let layer = lookupLoaded(face, d, tx, ty);
        if (layer != EMPTY_KEY) {
            return d;
        }
        if (d == 0u) {
            break;
        }
        tx = tx >> 1u;
        ty = ty >> 1u;
        d = d - 1u;
    }
    return depth;
}

fn findRenderedDataLOD(face : u32, depth : u32, x : u32, y : u32, coverDepth : u32) -> u32 {
    let shift = depth - coverDepth;
    let coverX = select(x, x >> shift, shift > 0u);
    let coverY = select(y, y >> shift, shift > 0u);
    let dataDepth = findLoadedSourceDepth(face, coverDepth, coverX, coverY);
    return computeGeomLOD(dataDepth);
}

fn packNeighborLODs(left : u32, right : u32, bottom : u32, top : u32) -> vec2<u32> {
    let l = min(left, 15u);
    let r = min(right, 15u);
    let b = min(bottom, 15u);
    let t = min(top, 15u);
    let packed = l | (r << 4u) | (b << 8u) | (t << 12u);
    return vec2<u32>(packed, 0u);
}

fn computeEdgeMask(selfLOD : u32, left : u32, right : u32, bottom : u32, top : u32) -> u32 {
    var mask : u32 = 0u;
    if (left > selfLOD) { mask = mask | 8u; }
    if (right > selfLOD) { mask = mask | 2u; }
    if (bottom > selfLOD) { mask = mask | 4u; }
    if (top > selfLOD) { mask = mask | 1u; }
    return mask;
}

fn recordCoveringProbe(packed : u32) {
    let miss = (packed & 0x8000u) != 0u;
    let probes = packed & 0x7FFFu;
    atomicAdd(&metaData.coveringProbeSum, probes);
    atomicAdd(&metaData.coveringProbeCount, 1u);
    if (miss) {
        atomicAdd(&metaData.coveringProbeMisses, 1u);
    }
}

fn wrapNeighbor(face : u32, depth : u32, x : i32, y : i32) -> vec3<u32> {
    let gs = i32(1u << depth);
    let maxv = gs - 1;
    if (x >= 0 && x < gs && y >= 0 && y < gs) {
        return vec3<u32>(face, u32(x), u32(y));
    }

    var dir : i32 = -1;
    if (x < 0) {
        dir = 0;
    } else if (x >= gs) {
        dir = 1;
    } else if (y < 0) {
        dir = 2;
    } else if (y >= gs) {
        dir = 3;
    }

    let cx = clamp(x, 0, maxv);
    let cy = clamp(y, 0, maxv);
    let maxu = u32(maxv);
    let cux = u32(cx);
    let cuy = u32(cy);

    if (face == 0u) {
        if (dir == 0) { return vec3<u32>(4u, maxu, cuy); }
        if (dir == 1) { return vec3<u32>(5u, 0u, cuy); }
        if (dir == 2) { return vec3<u32>(3u, maxu, cux); }
        if (dir == 3) { return vec3<u32>(2u, maxu, maxu - cux); }
    }
    if (face == 1u) {
        if (dir == 0) { return vec3<u32>(5u, maxu, cuy); }
        if (dir == 1) { return vec3<u32>(4u, 0u, cuy); }
        if (dir == 2) { return vec3<u32>(3u, 0u, maxu - cux); }
        if (dir == 3) { return vec3<u32>(2u, 0u, cux); }
    }
    if (face == 2u) {
        if (dir == 0) { return vec3<u32>(1u, cuy, 0u); }
        if (dir == 1) { return vec3<u32>(0u, maxu - cuy, maxu); }
        if (dir == 2) { return vec3<u32>(4u, cux, maxu); }
        if (dir == 3) { return vec3<u32>(5u, maxu - cux, 0u); }
    }
    if (face == 3u) {
        if (dir == 0) { return vec3<u32>(1u, maxu - cuy, maxu); }
        if (dir == 1) { return vec3<u32>(0u, cuy, 0u); }
        if (dir == 2) { return vec3<u32>(5u, maxu - cux, maxu); }
        if (dir == 3) { return vec3<u32>(4u, cux, 0u); }
    }
    if (face == 4u) {
        if (dir == 0) { return vec3<u32>(1u, maxu, cuy); }
        if (dir == 1) { return vec3<u32>(0u, 0u, cuy); }
        if (dir == 2) { return vec3<u32>(3u, cux, maxu); }
        if (dir == 3) { return vec3<u32>(2u, cux, 0u); }
    }
    if (face == 5u) {
        if (dir == 0) { return vec3<u32>(0u, maxu, cuy); }
        if (dir == 1) { return vec3<u32>(1u, 0u, cuy); }
        if (dir == 2) { return vec3<u32>(3u, maxu - cux, maxu); }
        if (dir == 3) { return vec3<u32>(2u, maxu - cux, 0u); }
    }
    return vec3<u32>(face, u32(clamp(x, 0, maxv)), u32(clamp(y, 0, maxv)));
}

fn findCoveringDepthDiag(face : u32, depth : u32, x : u32, y : u32) -> vec2<u32> {
    var d = depth;
    var tx = x;
    var ty = y;
    var probeCount : u32 = 0u;
    loop {
        probeCount = probeCount + 1u;
        if (visibleExists(face, d, tx, ty)) {
            return vec2<u32>(d, probeCount);
        }
        if (d == 0u) {
            break;
        }
        tx = tx >> 1u;
        ty = ty >> 1u;
        d = d - 1u;
    }
    // Fell through to root without finding - return depth with high probe count as flag
    return vec2<u32>(depth, probeCount | 0x8000u);
}

fn findCoveringDepth(face : u32, depth : u32, x : u32, y : u32) -> u32 {
    var d = depth;
    var tx = x;
    var ty = y;
    loop {
        if (visibleExists(face, d, tx, ty)) {
            return d;
        }
        if (d == 0u) {
            break;
        }
        tx = tx >> 1u;
        ty = ty >> 1u;
        d = d - 1u;
    }
    return depth;
}

@compute @workgroup_size(${WG})
fn main(@builtin(local_invocation_id) lid : vec3<u32>) {
    let tid = lid.x;

if (tid == 0u) {
    for (var l = 0u; l < MAX_LOD_LEVELS; l++) {
        atomicStore(&metaData.lodCounts[l], 0u);
        atomicStore(&metaData.lodWrite[l], 0u);
    }
    atomicStore(&metaData.feedbackCount, 0u);
    atomicStore(&metaData.parentFallbackHits, 0u);
    atomicStore(&metaData.coveringProbeSum, 0u);
    atomicStore(&metaData.coveringProbeCount, 0u);
    atomicStore(&metaData.coveringProbeMisses, 0u);
}

    workgroupBarrier();
    storageBarrier();

    // Clear visible hash table (only every N frames; epoch handles staleness)
    if (params.doVisibleClear != 0u) {
        for (var i = tid; i < params.visibleTableCapacity; i += WORKGROUP_SIZE) {
            visibleTable[i].keyLo = EMPTY_KEY;
            visibleTable[i].keyHi = EMPTY_KEY;
            visibleTable[i].epoch = 0u;
            visibleTable[i]._pad = 0u;
        }
    }

    workgroupBarrier();
    storageBarrier();

    let visibleCountRaw = atomicLoad(&traversalCounters[2]);
    let visibleCount = min(visibleCountRaw, params.maxVisibleTiles);

    // Insert visible tiles into hash table and count per-LOD (single-threaded to avoid races)
    if (tid == 0u) {
        for (var i = 0u; i < visibleCount; i++) {
            let tile = visibleTiles[i];
            let face = tile.x;
            let depth = tile.y;
            let x = tile.z;
            let y = tile.w;
            insertVisible(face, depth, x, y);
            let lod = computeGeomLOD(depth);
            atomicAdd(&metaData.lodCounts[lod], 1u);
        }
    }

    workgroupBarrier();
    storageBarrier();

    if (tid == 0u) {
        var offset : u32 = 0u;
        for (var l = 0u; l < MAX_LOD_LEVELS; l++) {
            let rawCount = atomicLoad(&metaData.lodCounts[l]);
            var clampedCount = rawCount;
            if (offset + clampedCount > params.maxVisibleTiles) {
                if (offset < params.maxVisibleTiles) {
                    clampedCount = params.maxVisibleTiles - offset;
                } else {
                    clampedCount = 0u;
                }
            }
            metaData.lodOffsets[l] = offset;
            metaData.indirectArgs[l * 5u] = lodIndexCounts[l];
            metaData.indirectArgs[l * 5u + 1u] = clampedCount;
            metaData.indirectArgs[l * 5u + 2u] = 0u;
            metaData.indirectArgs[l * 5u + 3u] = 0u;
            metaData.indirectArgs[l * 5u + 4u] = offset;
            atomicStore(&metaData.lodWrite[l], 0u);
            offset = offset + clampedCount;
        }
    }

    workgroupBarrier();
    storageBarrier();

    // Build instances
    for (var i = tid; i < visibleCount; i += WORKGROUP_SIZE) {
        let tile = visibleTiles[i];
        let face = tile.x;
        let depth = tile.y;
        let x = tile.z;
        let y = tile.w;
        let geomLOD = computeGeomLOD(depth);

        // Neighbor LODs
        let leftCoord = wrapNeighbor(face, depth, i32(x) - 1, i32(y));
        let rightCoord = wrapNeighbor(face, depth, i32(x) + 1, i32(y));
        let bottomCoord = wrapNeighbor(face, depth, i32(x), i32(y) - 1);
        let topCoord = wrapNeighbor(face, depth, i32(x), i32(y) + 1);

        let leftDiag = findCoveringDepthDiag(leftCoord.x, depth, leftCoord.y, leftCoord.z);
        let rightDiag = findCoveringDepthDiag(rightCoord.x, depth, rightCoord.y, rightCoord.z);
        let bottomDiag = findCoveringDepthDiag(bottomCoord.x, depth, bottomCoord.y, bottomCoord.z);
        let topDiag = findCoveringDepthDiag(topCoord.x, depth, topCoord.y, topCoord.z);

        recordCoveringProbe(leftDiag.y);
        recordCoveringProbe(rightDiag.y);
        recordCoveringProbe(bottomDiag.y);
        recordCoveringProbe(topDiag.y);

        let leftDepth = leftDiag.x;
        let rightDepth = rightDiag.x;
        let bottomDepth = bottomDiag.x;
        let topDepth = topDiag.x;

        let leftLOD = findRenderedDataLOD(leftCoord.x, depth, leftCoord.y, leftCoord.z, leftDepth);
        let rightLOD = findRenderedDataLOD(rightCoord.x, depth, rightCoord.y, rightCoord.z, rightDepth);
        let bottomLOD = findRenderedDataLOD(bottomCoord.x, depth, bottomCoord.y, bottomCoord.z, bottomDepth);
        let topLOD = findRenderedDataLOD(topCoord.x, depth, topCoord.y, topCoord.z, topDepth);

        let neighborPacked = packNeighborLODs(leftLOD, rightLOD, bottomLOD, topLOD);
        let edgeMask = computeEdgeMask(geomLOD, leftLOD, rightLOD, bottomLOD, topLOD);

        // Loaded tile lookup (self or nearest parent)
        var useLayer = lookupLoaded(face, depth, x, y);
        var uvOffset = vec2<f32>(0.0);
        var uvScale = 1.0;
        if (useLayer == EMPTY_KEY) {
            // Emit feedback for missing tile
            let fbIdx = atomicAdd(&metaData.feedbackCount, 1u);
            if (fbIdx < params.maxFeedback) {
                feedbackBuffer[fbIdx] = vec4<u32>(face, depth, x, y);
            }

            // Search parents for fallback
            var tx = x;
            var ty = y;
            var d = depth;
            var scale = 1.0;
            loop {
                if (d == 0u) {
                    break;
                }
                scale = scale * 0.5;
                let bitX = tx & 1u;
                let bitY = ty & 1u;
                uvOffset = uvOffset + vec2<f32>(f32(bitX), f32(bitY)) * scale;
                tx = tx >> 1u;
                ty = ty >> 1u;
                d = d - 1u;
                let layer = lookupLoaded(face, d, tx, ty);
if (layer != EMPTY_KEY) {
    useLayer = layer;
    uvScale = scale;
    atomicAdd(&metaData.parentFallbackHits, 1u);
    break;
}
            }
        }

        if (useLayer == EMPTY_KEY) {
            continue;
        }

        let maxCount = metaData.indirectArgs[geomLOD * 5u + 1u];
        let localIndex = atomicAdd(&metaData.lodWrite[geomLOD], 1u);
        if (localIndex >= maxCount) {
            continue;
        }

        let instanceIndex = metaData.lodOffsets[geomLOD] + localIndex;
        if (instanceIndex >= params.maxVisibleTiles) {
            continue;
        }

        let gridSize = f32(1u << depth);
        let tileWorldSize = params.faceSize / gridSize;
        let chunkOffset = vec3<f32>(f32(x) * tileWorldSize, 0.0, f32(y) * tileWorldSize);
        let chunkLocation = vec2<f32>(f32(x) / gridSize, f32(y) / gridSize);
        let chunkSizeUV = 1.0 / gridSize;

        instanceBuffer[instanceIndex] = ChunkInstance(
            chunkOffset,
            face,
            chunkLocation,
            chunkSizeUV,
            0.0,
            uvOffset,
            uvScale,
            geomLOD,
            neighborPacked,
            useLayer,
            edgeMask
        );
    }

    // ── Post-build: correct instanceCount to actual written count ─────────
    // The indirectArgs.instanceCount was set to the total visible tile count
    // per LOD, but tiles without loaded data were skipped during the build.
    // Without this correction, the draw call renders stale/uninitialized
    // instance slots.
    workgroupBarrier();
    storageBarrier();
    if (tid == 0u) {
        for (var l = 0u; l < MAX_LOD_LEVELS; l++) {
            let actualCount = atomicLoad(&metaData.lodWrite[l]);
            metaData.indirectArgs[l * 5u + 1u] = actualCount;
        }
    }
}
`;
}
