// js/world/quadtree/quadtreeTraversal.wgsl.js
//
// WGSL compute shader for implicit quadtree traversal over a cube-mapped sphere.
//
// Architecture:
//   - Single workgroup, BFS level-by-level traversal
//   - Ping-pong between two storage-buffer work queues (queueA / queueB)
//   - workgroup + storage barriers between levels so all children are visible before the
//     next level reads them
//   - LOD decision based on screen-space error (tile world size vs camera distance)
//   - No frustum or horizon culling yet (added in iteration 6)
//
// Inputs:
//   binding 0: TraversalParams uniform
//   binding 1: queueA   (storage, read_write) — node work queue A
//   binding 2: queueB   (storage, read_write) — node work queue B
//   binding 3: visibleTiles (storage, read_write) — output visible tile list
//   binding 4: counters (storage, read_write) — atomic counters
//   binding 5: loadedTable (storage, read) — tile residency hash table
//   binding 6: debugSeeds (storage, read_write) — first N seeded nodes (debug)
//   binding 7: debugParams (storage, read_write) — params captured on GPU (debug)
//   binding 8: debugCounters (storage, read_write) — overflow counters (debug)
//
// Counters layout:
//   [0] queueA count
//   [1] queueB count
//   [2] visible tile count
//   [3] reserved
//
// Each tile node is a vec4<u32>: (face, depth, x, y)

/**
 * Build the WGSL source for the quadtree traversal compute shader.
 *
 * @param {object} [config]
 * @param {number}   [config.workgroupSize=64]  Threads per workgroup
 * @returns {string} Complete WGSL shader source
 */
export function buildTraversalShaderSource(config = {}) {
    const WG = config.workgroupSize ?? 64;
    const disableCulling = config.disableCulling === true;

    return /* wgsl */`
// ─── Quadtree Traversal Compute Shader ────────────────────────────────────
// Single-workgroup BFS over 6 cube faces.
// Iteration 5: LOD decision only, no culling.
const DISABLE_CULLING : bool = ${disableCulling ? 'true' : 'false'};

struct TraversalParams {
    cameraPosition : vec3<f32>,
    _pad0          : f32,
    planetOrigin   : vec3<f32>,
    planetRadius   : f32,
    // viewProjection reserved for iteration 6 (frustum culling)
    viewProjection : mat4x4<f32>,
    faceSize       : f32,
    maxDepth       : u32,
    screenHeight   : f32,
    tanHalfFov     : f32,
    lodFactor         : f32,    // screenHeight / (2 * tan(fov/2))
    lodErrorThreshold : f32,    // screen pixels that trigger subdivision
    maxVisibleTiles   : u32,
    queueCapacity     : u32,
    // Extended params for GPU quadtree integration
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

struct LoadedEntry {
    keyLo : u32,
    keyHi : u32,
    layer : u32,
    _pad  : u32,
};

@group(0) @binding(0) var<uniform> params : TraversalParams;
@group(0) @binding(1) var<storage, read_write> queueA : array<vec4<u32>>;
@group(0) @binding(2) var<storage, read_write> queueB : array<vec4<u32>>;
@group(0) @binding(3) var<storage, read_write> visibleTiles : array<vec4<u32>>;
@group(0) @binding(4) var<storage, read_write> counters : array<atomic<u32>, 4>;
@group(0) @binding(5) var<storage, read> loadedTable : array<LoadedEntry>;
@group(0) @binding(6) var<storage, read_write> debugSeeds : array<vec4<u32>>;
@group(0) @binding(7) var<storage, read_write> debugParams : array<u32>;
@group(0) @binding(8) var<storage, read_write> debugCounters : array<atomic<u32>, 8>;

const WORKGROUP_SIZE : u32 = ${WG}u;
const EMPTY_KEY : u32 = 0xFFFFFFFFu;
const DEBUG_SEED_COUNT : u32 = 16u;
const DEBUG_PARAM_COUNT : u32 = 24u;
const DEBUG_COUNTER_COUNT : u32 = 8u;

const DC_QUEUE_OVERFLOW : u32 = 0u;
const DC_NODES_PROCESSED : u32 = 1u;
const DC_CULLED_FRUSTUM : u32 = 2u;
const DC_CULLED_HORIZON : u32 = 3u;
const DC_EMITTED : u32 = 4u;
const DC_SUBDIVIDED : u32 = 5u;
const DC_VISIBLE_OVERFLOW : u32 = 6u;
const DC_ENQUEUED : u32 = 7u;

const DP_QUEUE_CAPACITY : u32 = 0u;
const DP_MAX_VISIBLE    : u32 = 1u;
const DP_MAX_DEPTH      : u32 = 2u;
const DP_FLAGS          : u32 = 3u;
const DP_FACE_SIZE_BITS : u32 = 4u;
const DP_PLANET_RADIUS_BITS : u32 = 5u;
const DP_LOD_FACTOR_BITS : u32 = 6u;
const DP_LOD_THRESHOLD_BITS : u32 = 7u;
const DP_SCREEN_HEIGHT_BITS : u32 = 8u;
const DP_TAN_HALF_FOV_BITS : u32 = 9u;
const DP_SAMPLE0_DIST_BITS : u32 = 10u;
const DP_SAMPLE0_ERR_BITS  : u32 = 11u;
const DP_SAMPLE1_DIST_BITS : u32 = 12u;
const DP_SAMPLE1_ERR_BITS  : u32 = 13u;
const DP_SAMPLE2_DIST_BITS : u32 = 14u;
const DP_SAMPLE2_ERR_BITS  : u32 = 15u;
const DP_CAM_FACE          : u32 = 16u;
const DP_CAM_U_BITS        : u32 = 17u;
const DP_CAM_V_BITS        : u32 = 18u;
const DP_CAM_DIST_BITS     : u32 = 19u;
const DP_CAM_D3_X          : u32 = 20u;
const DP_CAM_D3_Y          : u32 = 21u;
const DP_CAM_D3_ERR_BITS   : u32 = 22u;
const DP_CAM_D6_ERR_BITS   : u32 = 23u;

// ─── Cube-face mapping ────────────────────────────────────────────────────
// Matches LODManager._getCubePoint and TileAddress convention:
//   Face 0 = +X,  Face 1 = −X,  Face 2 = +Y,
//   Face 3 = −Y,  Face 4 = +Z,  Face 5 = −Z

fn getCubePoint(face : u32, u : f32, v : f32) -> vec3<f32> {
    let s = u * 2.0 - 1.0;
    let t = v * 2.0 - 1.0;
    switch (face) {
        case 0u { return vec3<f32>( 1.0,   t,  -s); }
        case 1u { return vec3<f32>(-1.0,   t,   s); }
        case 2u { return vec3<f32>(  s,   1.0,  -t); }
        case 3u { return vec3<f32>(  s,  -1.0,   t); }
        case 4u { return vec3<f32>(  s,    t,  1.0); }
        case 5u { return vec3<f32>( -s,    t, -1.0); }
        default { return vec3<f32>(0.0, 1.0, 0.0); }
    }
}

// ─── Tile world-space center ──────────────────────────────────────────────
// Projects the tile center onto the planet sphere surface.

fn getTileWorldCenter(face : u32, depth : u32, x : u32, y : u32) -> vec3<f32> {
    let gridSize = f32(1u << depth);
    let u = (f32(x) + 0.5) / gridSize;
    let v = (f32(y) + 0.5) / gridSize;
    let cubePoint = getCubePoint(face, u, v);
    let sphereDir = normalize(cubePoint);
    return params.planetOrigin + sphereDir * params.planetRadius;
}

// ─── Culling helpers ──────────────────────────────────────────────────────

fn getRow(m : mat4x4<f32>, r : u32) -> vec4<f32> {
    return vec4<f32>(m[0][r], m[1][r], m[2][r], m[3][r]);
}
// In sphereInFrustum() — replace the planes array construction:
fn sphereInFrustum(center : vec3<f32>, radius : f32) -> bool {
    let row0 = getRow(params.viewProjection, 0u);
    let row1 = getRow(params.viewProjection, 1u);
    let row2 = getRow(params.viewProjection, 2u);
    let row3 = getRow(params.viewProjection, 3u);

    // Forward-Z WebGPU frustum planes.
    // WebGPU NDC: x in [-1,1], y in [-1,1], z in [0,1].
    // Plane equations derived from: -1 <= x/w <= 1, -1 <= y/w <= 1, 0 <= z/w <= 1
    //
    //   left:   row3 + row0  (x/w >= -1  =>  x + w >= 0)
    //   right:  row3 - row0  (x/w <=  1  =>  w - x >= 0)
    //   bottom: row3 + row1  (y/w >= -1)
    //   top:    row3 - row1  (y/w <=  1)
    //   near:   row2         (z/w >=  0  =>  z     >= 0)  ← WebGPU differs from OpenGL here
    //   far:    row3 - row2  (z/w <=  1  =>  w - z >= 0)
    let planes = array<vec4<f32>, 6>(
        row3 + row0,  // left
        row3 - row0,  // right
        row3 + row1,  // bottom
        row3 - row1,  // top
        row2,         // near  (WebGPU forward-Z: z >= 0)
        row3 - row2   // far   (WebGPU forward-Z: w - z >= 0)
    );

    for (var i = 0u; i < 6u; i++) {
        let p = planes[i];
        let n = p.xyz;
        let nLen = length(n);
        if (nLen < 0.0001) {
            continue;
        }
        let dist = (dot(n, center) + p.w) / nLen;
        if (dist < -radius) {
            return false;
        }
    }
    return true;
}

fn isBelowHorizon(center : vec3<f32>, radius : f32) -> bool {
    let camVec = params.cameraPosition - params.planetOrigin;
    let camDist = length(camVec);
    if (camDist <= params.planetRadius * 1.001) {
        return false;
    }
    let camDir = camVec / camDist;
    let centerDir = normalize(center - params.planetOrigin);
    let cosAngle = dot(camDir, centerDir);
    let angularRadius = radius / max(params.planetRadius, 0.001);

    // Geometric horizon (tight — correct at orbital altitude)
    let cosGeoHorizon = params.planetRadius / camDist;

    // At low altitude the geometric horizon is very close, but we still want
    // a small buffer to avoid popping. Tighten the near-ground threshold and
    // blend faster toward the true geometric horizon.
    // Surface: cos ≈ −0.05 (~93° visible), higher altitudes approach cosGeoHorizon.
    let altRatio = (camDist - params.planetRadius) / params.planetRadius;
    let t = clamp(altRatio * params.horizonBlendScale, 0.0, 1.0);
    let cosHorizon = mix(params.horizonGroundCos, cosGeoHorizon, t * t);

    return (cosAngle + angularRadius) < cosHorizon;
}

// ─── LOD decision ─────────────────────────────────────────────────────────
// Screen-space error: how many pixels the tile subtends on screen.
// If the tile covers more pixels than the threshold, it should be subdivided
// to provide finer detail.
//
// Formula:
//   screenError = (tileWorldSize / distance) * lodFactor
//   lodFactor   = screenHeight / (2 * tan(fov/2))
//
// This matches LODManager.computeScreenSpaceError on the CPU side.

fn shouldSubdivideWithCenter(depth : u32, worldCenter : vec3<f32>) -> bool {
    if (depth >= params.maxDepth) {
        return false;
    }

    let toCamera    = params.cameraPosition - worldCenter;
    let distance    = length(toCamera);

    // Tile side length in world units
    let tileWorldSize = params.faceSize / f32(1u << depth);

    // Approximate screen-space error in pixels
    let screenError = tileWorldSize * params.lodFactor / max(distance, 0.001);

    return screenError > params.lodErrorThreshold;
}

// ─── Hash table helpers (match instanceBufferBuilder key encoding) ────────

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

fn isLoaded(face : u32, depth : u32, x : u32, y : u32) -> bool {
    let keyLo = makeKeyLo(x, y);
    let keyHi = makeKeyHi(face, depth);
    var idx = hashKey(keyLo, keyHi, params.loadedTableMask);
    for (var i = 0u; i < min(params.loadedTableCapacity, 256u); i++) {
        let entry = loadedTable[idx];
        if (entry.keyHi == EMPTY_KEY) {
            return false;
        }
        if (entry.keyHi == keyHi && entry.keyLo == keyLo) {
            return true;
        }
        idx = (idx + 1u) & params.loadedTableMask;
    }
    return false;
}

fn allChildrenLoaded(face : u32, depth : u32, x : u32, y : u32) -> bool {
    let cd = depth + 1u;
    let cx = x << 1u;
    let cy = y << 1u;
    return isLoaded(face, cd, cx, cy) &&
           isLoaded(face, cd, cx + 1u, cy) &&
           isLoaded(face, cd, cx, cy + 1u) &&
           isLoaded(face, cd, cx + 1u, cy + 1u);
}

fn reserveQueue(counter: ptr<storage, atomic<u32>, read_write>, count: u32, capacity: u32) -> i32 {
    loop {
        let old = atomicLoad(counter);
        if (old + count > capacity) {
            atomicAdd(&debugCounters[0], 1u);
            return -1;
        }
        let res = atomicCompareExchangeWeak(counter, old, old + count);
        if (res.exchanged) {
            return i32(old);
        }
    }
}

// ─── Main entry point ─────────────────────────────────────────────────────
@compute @workgroup_size(${WG})
fn main(@builtin(local_invocation_id) lid : vec3<u32>) {
    let threadId = lid.x;

    // ── Initialise: seed 6 root tiles into queueA ──────────────────────
    if (threadId == 0u) {
        atomicStore(&counters[0], 6u);   // queueA count
        atomicStore(&counters[1], 0u);   // queueB count
        atomicStore(&counters[2], 0u);   // visible tile count
        atomicStore(&counters[3], 0u);

        // Reset debug counters
        for (var i = 0u; i < DEBUG_COUNTER_COUNT; i = i + 1u) {
            atomicStore(&debugCounters[i], 0u);
        }

        // Capture params as seen by the GPU (bitcast floats to u32)
        var flags : u32 = 0u;
        if (params.useFrustumCulling != 0u) { flags = flags | 0x1u; }
        if (params.useHorizonCulling != 0u) { flags = flags | 0x2u; }
        if (DISABLE_CULLING) { flags = flags | 0x4u; }

        debugParams[DP_QUEUE_CAPACITY] = params.queueCapacity;
        debugParams[DP_MAX_VISIBLE] = params.maxVisibleTiles;
        debugParams[DP_MAX_DEPTH] = params.maxDepth;
        debugParams[DP_FLAGS] = flags;
        debugParams[DP_FACE_SIZE_BITS] = bitcast<u32>(params.faceSize);
        debugParams[DP_PLANET_RADIUS_BITS] = bitcast<u32>(params.planetRadius);
        debugParams[DP_LOD_FACTOR_BITS] = bitcast<u32>(params.lodFactor);
        debugParams[DP_LOD_THRESHOLD_BITS] = bitcast<u32>(params.lodErrorThreshold);
        debugParams[DP_SCREEN_HEIGHT_BITS] = bitcast<u32>(params.screenHeight);
        debugParams[DP_TAN_HALF_FOV_BITS] = bitcast<u32>(params.tanHalfFov);

        // Clear the rest to a known value (optional, avoids stale reads)
        for (var i = 10u; i < DEBUG_PARAM_COUNT; i = i + 1u) {
            debugParams[i] = 0u;
        }

        // Sample LOD metrics for fixed tiles (debug)
        // S0: face=1 depth=3 (0,0)
        let s0 = getTileWorldCenter(1u, 3u, 0u, 0u);
        let d0 = length(params.cameraPosition - s0);
        let ts0 = params.faceSize / f32(1u << 3u);
        let se0 = ts0 * params.lodFactor / max(d0, 0.001);
        debugParams[DP_SAMPLE0_DIST_BITS] = bitcast<u32>(d0);
        debugParams[DP_SAMPLE0_ERR_BITS]  = bitcast<u32>(se0);

        // S1: face=1 depth=3 (7,7)
        let s1 = getTileWorldCenter(1u, 3u, 7u, 7u);
        let d1 = length(params.cameraPosition - s1);
        let ts1 = params.faceSize / f32(1u << 3u);
        let se1 = ts1 * params.lodFactor / max(d1, 0.001);
        debugParams[DP_SAMPLE1_DIST_BITS] = bitcast<u32>(d1);
        debugParams[DP_SAMPLE1_ERR_BITS]  = bitcast<u32>(se1);

        // S2: face=0 depth=2 (0,0)
        let s2 = getTileWorldCenter(0u, 2u, 0u, 0u);
        let d2 = length(params.cameraPosition - s2);
        let ts2 = params.faceSize / f32(1u << 2u);
        let se2 = ts2 * params.lodFactor / max(d2, 0.001);
        debugParams[DP_SAMPLE2_DIST_BITS] = bitcast<u32>(d2);
        debugParams[DP_SAMPLE2_ERR_BITS]  = bitcast<u32>(se2);

        // Camera-derived face/uv + LOD samples at camera location
        let camVec = params.cameraPosition - params.planetOrigin;
        let camDist = length(camVec);
        let camDir = camVec / max(camDist, 0.001);

        let ax = abs(camDir.x);
        let ay = abs(camDir.y);
        let az = abs(camDir.z);

        var camFace : u32 = 0u;
        var camU : f32 = 0.5;
        var camV : f32 = 0.5;

        if (ax >= ay && ax >= az) {
            if (camDir.x > 0.0) {
                camFace = 0u;
                camU = (-camDir.z / ax + 1.0) * 0.5;
                camV = ( camDir.y / ax + 1.0) * 0.5;
            } else {
                camFace = 1u;
                camU = ( camDir.z / ax + 1.0) * 0.5;
                camV = ( camDir.y / ax + 1.0) * 0.5;
            }
        } else if (ay >= ax && ay >= az) {
            if (camDir.y > 0.0) {
                camFace = 2u;
                camU = ( camDir.x / ay + 1.0) * 0.5;
                camV = (-camDir.z / ay + 1.0) * 0.5;
            } else {
                camFace = 3u;
                camU = ( camDir.x / ay + 1.0) * 0.5;
                camV = ( camDir.z / ay + 1.0) * 0.5;
            }
        } else {
            if (camDir.z > 0.0) {
                camFace = 4u;
                camU = ( camDir.x / az + 1.0) * 0.5;
                camV = ( camDir.y / az + 1.0) * 0.5;
            } else {
                camFace = 5u;
                camU = ( camDir.x / az + 1.0) * 0.5;
                camV = (-camDir.y / az + 1.0) * 0.5;
            }
        }

        debugParams[DP_CAM_FACE] = camFace;
        debugParams[DP_CAM_U_BITS] = bitcast<u32>(camU);
        debugParams[DP_CAM_V_BITS] = bitcast<u32>(camV);
        debugParams[DP_CAM_DIST_BITS] = bitcast<u32>(camDist);

        // Depth-3 tile at camera uv
        let grid3 = f32(1u << 3u);
        let x3 = u32(clamp(floor(camU * grid3), 0.0, grid3 - 1.0));
        let y3 = u32(clamp(floor(camV * grid3), 0.0, grid3 - 1.0));
        let c3 = getTileWorldCenter(camFace, 3u, x3, y3);
        let d3 = length(params.cameraPosition - c3);
        let ts3 = params.faceSize / f32(1u << 3u);
        let se3 = ts3 * params.lodFactor / max(d3, 0.001);
        debugParams[DP_CAM_D3_X] = x3;
        debugParams[DP_CAM_D3_Y] = y3;
        debugParams[DP_CAM_D3_ERR_BITS] = bitcast<u32>(se3);

        // Depth-6 tile at camera uv (higher detail)
        let grid6 = f32(1u << 6u);
        let x6 = u32(clamp(floor(camU * grid6), 0.0, grid6 - 1.0));
        let y6 = u32(clamp(floor(camV * grid6), 0.0, grid6 - 1.0));
        let c6 = getTileWorldCenter(camFace, 6u, x6, y6);
        let d6 = length(params.cameraPosition - c6);
        let ts6 = params.faceSize / f32(1u << 6u);
        let se6 = ts6 * params.lodFactor / max(d6, 0.001);
        debugParams[DP_CAM_D6_ERR_BITS] = bitcast<u32>(se6);
    }

    if (threadId < 6u) {
        queueA[threadId] = vec4<u32>(threadId, 0u, 0u, 0u);
    }

    workgroupBarrier();
    storageBarrier();

    // ── Debug: capture the seeded queue entries (GPU-visible) ──────────
    if (threadId == 0u) {
        let count = atomicLoad(&counters[0]);
        var i = 0u;
        loop {
            if (i >= DEBUG_SEED_COUNT) { break; }
            if (i < count) {
                debugSeeds[i] = queueA[i];
            } else {
                debugSeeds[i] = vec4<u32>(EMPTY_KEY, EMPTY_KEY, EMPTY_KEY, EMPTY_KEY);
            }
            i = i + 1u;
        }
    }

    // ── BFS over depth levels ──────────────────────────────────────────
    for (var level = 0u; level <= params.maxDepth; level++) {
        let readFromA = (level & 1u) == 0u;

        var currentCount : u32;
        if (readFromA) {
            currentCount = atomicLoad(&counters[0]);
        } else {
            currentCount = atomicLoad(&counters[1]);
        }

        // Track max queue usage (debug) + reset write queue
        if (threadId == 0u) {
            let prevMax = atomicLoad(&counters[3]);
            if (currentCount > prevMax) {
                atomicStore(&counters[3], currentCount);
            }
            if (readFromA) {
                atomicStore(&counters[1], 0u);
            } else {
                atomicStore(&counters[0], 0u);
            }
        }

        workgroupBarrier();
        storageBarrier();

        // ── Process tiles at this depth ────────────────────────────────
        for (var i = threadId; i < currentCount; i += WORKGROUP_SIZE) {
            var tile : vec4<u32>;
            if (readFromA) {
                tile = queueA[i];
            } else {
                tile = queueB[i];
            }

            let face  = tile.x;
            let depth = tile.y;
            let x     = tile.z;
            let y     = tile.w;

            atomicAdd(&debugCounters[DC_NODES_PROCESSED], 1u);

            let worldCenter   = getTileWorldCenter(face, depth, x, y);
            let tileWorldSize = params.faceSize / f32(1u << depth);
            let maxHeightDisplacement = params.maxHeightDisplacement;
            let boundRadius = sqrt(tileWorldSize * tileWorldSize * 0.5 + maxHeightDisplacement * maxHeightDisplacement);
            let skipFrustumCull = depth <= 3u;

            if (!DISABLE_CULLING) {
                if (!skipFrustumCull &&
                    params.useFrustumCulling != 0u &&
                    !sphereInFrustum(worldCenter, boundRadius)) {
                    atomicAdd(&debugCounters[DC_CULLED_FRUSTUM], 1u);
                    continue;
                }
                if (params.useHorizonCulling != 0u &&
                    isBelowHorizon(worldCenter, boundRadius)) {
                    atomicAdd(&debugCounters[DC_CULLED_HORIZON], 1u);
                    continue;
                }
            }

            // ── Cover-set: only emit leaves (tiles that don't subdivide) ──
            // The BFS continues into children for feedback/streaming, but
            // only the LOD-appropriate leaves enter the visible list.
            // The instance builder handles texture fallback for unloaded leaves
            // (walks up the quadtree to the nearest loaded ancestor).
            let wantSubdivide = shouldSubdivideWithCenter(depth, worldCenter);

            if (!wantSubdivide) {
                atomicAdd(&debugCounters[DC_EMITTED], 1u);
                let visIdx = atomicAdd(&counters[2], 1u);
                if (visIdx < params.maxVisibleTiles) {
                    visibleTiles[visIdx] = tile;
                } else {
                    atomicAdd(&debugCounters[DC_VISIBLE_OVERFLOW], 1u);
                }
            }

            // ── Continue BFS when subdividing ───────────────────────────
            // Children are enqueued even though the parent wasn't emitted.
            // This drives feedback requests so the tile streamer loads them.
            if (wantSubdivide) {
                atomicAdd(&debugCounters[DC_SUBDIVIDED], 1u);
                let childDepth = depth + 1u;
                let cx = x << 1u;
                let cy = y << 1u;

                if (readFromA) {
                    let base = reserveQueue(&counters[1], 4u, params.queueCapacity);
                    if (base >= 0) {
                        let b = u32(base);
                        queueB[b + 0u] = vec4<u32>(face, childDepth, cx,     cy);
                        queueB[b + 1u] = vec4<u32>(face, childDepth, cx + 1u, cy);
                        queueB[b + 2u] = vec4<u32>(face, childDepth, cx,     cy + 1u);
                        queueB[b + 3u] = vec4<u32>(face, childDepth, cx + 1u, cy + 1u);
                        atomicAdd(&debugCounters[DC_ENQUEUED], 4u);
                    }
                } else {
                    let base = reserveQueue(&counters[0], 4u, params.queueCapacity);
                    if (base >= 0) {
                        let b = u32(base);
                        queueA[b + 0u] = vec4<u32>(face, childDepth, cx,     cy);
                        queueA[b + 1u] = vec4<u32>(face, childDepth, cx + 1u, cy);
                        queueA[b + 2u] = vec4<u32>(face, childDepth, cx,     cy + 1u);
                        queueA[b + 3u] = vec4<u32>(face, childDepth, cx + 1u, cy + 1u);
                        atomicAdd(&debugCounters[DC_ENQUEUED], 4u);
                    }
                }
            }
        }

        workgroupBarrier();
        storageBarrier();
    }
}
`;
}
