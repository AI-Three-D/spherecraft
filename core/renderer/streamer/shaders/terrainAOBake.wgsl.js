// js/renderer/streamer/shaders/terrainAOBake.wgsl.js
//
// Compute shader that bakes a per-tile contact-AO mask.
//
// For every AO texel we:
//   1. Enumerate nearby tree hash-grid cells (same PCG seeds as scatter).
//   2. For each cell: cluster roll → tree count → per-tree jittered
//      position → eligibility sample → density thin. IDENTICAL logic to
//      assetScatterClimate.wgsl pass 1. If and only if scatter would
//      emit this tree, we accumulate occlusion.
//   3. Optionally enumerate nearby ground-cover grid cells and add a
//      smaller contribution gated by a configured keep probability.
//   4. Write 1 − clamp(occlusion) to the AO mask.
//
// The per-texel gather is redundant (many texels re-hash the same cells)
// but the work per texel is tiny and we only bake on tile commit, so
// this is far cheaper than an atomic splat approach and needs no barriers.

export function buildTerrainAOBakeShader(cfg = {}) {
    const AO_RES          = cfg.aoResolution           ?? 64;
    const MAX_BATCH       = cfg.maxBatchSize           ?? 8;
    const TREE_CELL_SIZE  = cfg.treeCellSize           ?? 50.0;
    const TREE_MAX        = cfg.treeMaxPerCell         ?? 4;
    const TREE_CLUSTER_P  = cfg.treeClusterProbability ?? 0.25;
    const TREE_JITTER     = cfg.treeJitterScale        ?? 0.8;
    const TREE_DENS_SCALE = cfg.treeDensityScale       ?? 1.0;
    const TREE_SEARCH     = cfg.treeCellSearchRadius   ?? 1;
    const GC_SEARCH       = cfg.gcCellSearchRadius     ?? 2;

    return /* wgsl */`
// ═══════════════════════════════════════════════════════════════════════════
//  Terrain Contact AO Bake
// ═══════════════════════════════════════════════════════════════════════════

const AO_RES:              u32 = ${AO_RES}u;
const MAX_BATCH:           u32 = ${MAX_BATCH}u;
const TREE_CELL_SIZE:      f32 = ${TREE_CELL_SIZE.toFixed(4)};
const TREE_MAX_PER_CELL:   u32 = ${TREE_MAX}u;
const TREE_CLUSTER_PROB:   f32 = ${TREE_CLUSTER_P.toFixed(6)};
const TREE_JITTER_SCALE:   f32 = ${TREE_JITTER.toFixed(4)};
const TREE_DENSITY_SCALE:  f32 = ${TREE_DENS_SCALE.toFixed(4)};
const TREE_SEARCH:         i32 = ${TREE_SEARCH};
const GC_SEARCH:           i32 = ${GC_SEARCH};

// ── Uniforms ────────────────────────────────────────────────────────────────

struct BakeParams {
    planetOrigin:   vec3<f32>,   //  0
    planetRadius:   f32,         // 12
    heightScale:    f32,         // 16
    faceSize:       f32,         // 20
    seed:           u32,         // 24
    tileCount:      u32,         // 28

    treeRadiusM:    f32,         // 32
    treeStrength:   f32,         // 36
    treeInnerRatio: f32,         // 40
    aoFloor:        f32,         // 44

    gcEnable:       u32,         // 48
    gcRadiusM:      f32,         // 52
    gcStrength:     f32,         // 56
    gcKeepProb:     f32,         // 60

    gcCellWorldSize: f32,        // 64
    _pad0:          f32,
    _pad1:          f32,
    _pad2:          f32,
}

struct BakeTile {
    face:  u32,
    depth: u32,
    tileX: u32,
    tileY: u32,
    layer: u32,
    uvBiasX: f32,
    uvBiasY: f32,
    uvScale: f32,
    leftLayer: u32,
    leftBiasX: f32,
    leftBiasY: f32,
    leftScale: f32,
    rightLayer: u32,
    rightBiasX: f32,
    rightBiasY: f32,
    rightScale: f32,
    bottomLayer: u32,
    bottomBiasX: f32,
    bottomBiasY: f32,
    bottomScale: f32,
    topLayer: u32,
    topBiasX: f32,
    topBiasY: f32,
    topScale: f32,
    bottomLeftLayer: u32,
    bottomLeftBiasX: f32,
    bottomLeftBiasY: f32,
    bottomLeftScale: f32,
    bottomRightLayer: u32,
    bottomRightBiasX: f32,
    bottomRightBiasY: f32,
    bottomRightScale: f32,
    topLeftLayer: u32,
    topLeftBiasX: f32,
    topLeftBiasY: f32,
    topLeftScale: f32,
    topRightLayer: u32,
    topRightBiasX: f32,
    topRightBiasY: f32,
    topRightScale: f32,
}

@group(0) @binding(0) var<uniform>             P:          BakeParams;
@group(0) @binding(1) var<storage, read>       bakeTiles:  array<BakeTile, MAX_BATCH>;
@group(0) @binding(2) var                      scatterTex: texture_2d_array<f32>;
@group(0) @binding(3) var                      tileTex:    texture_2d_array<f32>;
@group(0) @binding(4) var                      aoOut:      texture_storage_2d_array<r32float, write>;

// ── PCG hash (must match assetScatterClimate.wgsl EXACTLY) ──────────────────

fn pcg(v: u32) -> u32 {
    var s = v * 747796405u + 2891336453u;
    let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
    return (w >> 22u) ^ w;
}
fn pcgF(v: u32) -> f32 { return f32(pcg(v)) / 4294967296.0; }
fn pcg2(a: u32, b: u32) -> u32 { return pcg(a ^ (b * 1664525u + 1013904223u)); }
fn pcg3(a: u32, b: u32, c: u32) -> u32 { return pcg(pcg2(a, b) ^ (c * 2654435761u)); }
fn pcg4(a: u32, b: u32, c: u32, d: u32) -> u32 {
    return pcg(pcg3(a, b, c) ^ (d * 2246822519u));
}
fn pcg2F(seed: u32) -> vec2<f32> {
    let h1 = pcg(seed);
    let h2 = pcg(h1);
    return vec2<f32>(f32(h1) / 4294967296.0, f32(h2) / 4294967296.0);
}

// ── Texture helpers ─────────────────────────────────────────────────────────

// Sample tree eligibility at an arbitrary face-UV position.
// If the point lies outside this tile's UV footprint we clamp to the
// nearest edge texel. The scatter eligibility is derived from world-
// continuous climate data, so edge values are a close proxy for the
// neighbour's — this avoids a hash-table lookup per tree per texel.
const INVALID_LAYER: u32 = 0xFFFFFFFFu;

struct ResolvedLayer {
    uMin: f32,
    vMin: f32,
    layer: u32,
    uvBiasX: f32,
    uvBiasY: f32,
    uvScale: f32,
}

fn resolveLayerAndOrigin(
    faceU: f32, faceV: f32,
    bt: BakeTile,
    uMin: f32, vMin: f32, uvSize: f32
) -> ResolvedLayer {
    let uMax = uMin + uvSize;
    let vMax = vMin + uvSize;
    let dx = select(select(0, -1, faceU < uMin), 1, faceU >= uMax);
    let dy = select(select(0, -1, faceV < vMin), 1, faceV >= vMax);

    var layer = bt.layer;
    var bX = bt.uvBiasX;
    var bY = bt.uvBiasY;
    var sc = bt.uvScale;

    if (dx == -1 && dy == 0) { layer = bt.leftLayer; bX = bt.leftBiasX; bY = bt.leftBiasY; sc = bt.leftScale; }
    if (dx == 1 && dy == 0) { layer = bt.rightLayer; bX = bt.rightBiasX; bY = bt.rightBiasY; sc = bt.rightScale; }
    if (dx == 0 && dy == -1) { layer = bt.bottomLayer; bX = bt.bottomBiasX; bY = bt.bottomBiasY; sc = bt.bottomScale; }
    if (dx == 0 && dy == 1) { layer = bt.topLayer; bX = bt.topBiasX; bY = bt.topBiasY; sc = bt.topScale; }
    if (dx == -1 && dy == -1) { layer = bt.bottomLeftLayer; bX = bt.bottomLeftBiasX; bY = bt.bottomLeftBiasY; sc = bt.bottomLeftScale; }
    if (dx == 1 && dy == -1) { layer = bt.bottomRightLayer; bX = bt.bottomRightBiasX; bY = bt.bottomRightBiasY; sc = bt.bottomRightScale; }
    if (dx == -1 && dy == 1) { layer = bt.topLeftLayer; bX = bt.topLeftBiasX; bY = bt.topLeftBiasY; sc = bt.topLeftScale; }
    if (dx == 1 && dy == 1) { layer = bt.topRightLayer; bX = bt.topRightBiasX; bY = bt.topRightBiasY; sc = bt.topRightScale; }

    // If neighbor is missing, fall back to current tile and clamp.
    if (layer == INVALID_LAYER) {
        layer = bt.layer;
        bX = bt.uvBiasX;
        bY = bt.uvBiasY;
        sc = bt.uvScale;
    }

    let uN = uMin + f32(dx) * uvSize;
    let vN = vMin + f32(dy) * uvSize;
    return ResolvedLayer(uN, vN, layer, bX, bY, sc);
}

fn sampleElig(faceU: f32, faceV: f32, bt: BakeTile,
              uMin: f32, vMin: f32, uvSize: f32) -> f32 {
    let info = resolveLayerAndOrigin(faceU, faceV, bt, uMin, vMin, uvSize);
    let ru = clamp((faceU - info.uMin) / uvSize, 0.0, 1.0);
    let rv = clamp((faceV - info.vMin) / uvSize, 0.0, 1.0);
    let texU = info.uvBiasX + ru * info.uvScale;
    let texV = info.uvBiasY + rv * info.uvScale;
    let sz = vec2<i32>(textureDimensions(scatterTex));
    let mc = sz - vec2<i32>(1);
    let c  = clamp(vec2<i32>(vec2<f32>(texU, texV) * vec2<f32>(sz)), vec2<i32>(0), mc);
    return textureLoad(scatterTex, c, i32(info.layer), 0).r;
}

fn sampleTileId(faceU: f32, faceV: f32, bt: BakeTile,
                uMin: f32, vMin: f32, uvSize: f32) -> u32 {
    let info = resolveLayerAndOrigin(faceU, faceV, bt, uMin, vMin, uvSize);
    let ru = clamp((faceU - info.uMin) / uvSize, 0.0, 1.0);
    let rv = clamp((faceV - info.vMin) / uvSize, 0.0, 1.0);
    let texU = info.uvBiasX + ru * info.uvScale;
    let texV = info.uvBiasY + rv * info.uvScale;
    let sz = vec2<i32>(textureDimensions(tileTex));
    let mc = sz - vec2<i32>(1);
    let c  = clamp(vec2<i32>(vec2<f32>(texU, texV) * vec2<f32>(sz)), vec2<i32>(0), mc);
    let r  = textureLoad(tileTex, c, i32(info.layer), 0).r;
    return u32(select(r * 255.0, r, r > 1.0) + 0.5);
}

// Multiplicative occlusion accumulation: each occluder attenuates the
// remaining unoccluded fraction independently. Converges gracefully
// under many overlapping assets instead of blowing past 1.
fn accum(occ: f32, contribution: f32) -> f32 {
    return 1.0 - (1.0 - occ) * (1.0 - clamp(contribution, 0.0, 1.0));
}

// ── Tree contribution ───────────────────────────────────────────────────────
// Loop body is a byte-for-byte replication of scatter pass-1 tree placement
// MINUS the frustum cull, distance cull, LOD band, and tile-bounds reject.
// Those are view-dependent; AO is not.

fn accumTrees(
    faceU: f32, faceV: f32,
    face: u32, bt: BakeTile,
    uMin: f32, vMin: f32, uvSize: f32,
    occIn: f32
) -> f32 {
    var occ = occIn;

    let treeCellScale = P.faceSize / TREE_CELL_SIZE;   // cells per face-UV unit
    let tcX0 = i32(floor(faceU * treeCellScale));
    let tcY0 = i32(floor(faceV * treeCellScale));

    let innerR = P.treeRadiusM * P.treeInnerRatio;

    for (var dy = -TREE_SEARCH; dy <= TREE_SEARCH; dy++) {
    for (var dx = -TREE_SEARCH; dx <= TREE_SEARCH; dx++) {
        let cx = tcX0 + dx;
        let cy = tcY0 + dy;

        // ── cell seed: MUST match scatter ──
        let cellSeed = pcg4(
            u32(cx + 100000),
            u32(cy + 100000),
            face,
            P.seed
        );

        // cluster probability
        if (pcgF(cellSeed) > TREE_CLUSTER_PROB) { continue; }

        // tree count in cluster
        let treeCount = 1u + (pcg2(cellSeed, 1u) % TREE_MAX_PER_CELL);

        for (var t = 0u; t < TREE_MAX_PER_CELL; t++) {
            if (t >= treeCount) { break; }

            // sub-cell position (same grid+jitter as scatter)
            let subSeed = pcg3(cellSeed, t, 42u);
            let grid = select(1u, 2u, treeCount > 1u);
            let subX = t % grid;
            let subY = t / grid;
            let baseOff = (vec2<f32>(f32(subX) + 0.5, f32(subY) + 0.5) / f32(grid))
                        - vec2<f32>(0.5);
            let jitter = (pcg2F(subSeed) - vec2<f32>(0.5))
                       * (TREE_JITTER_SCALE / f32(grid));
            let off = baseOff + jitter;

            let tFaceU = (f32(cx) + 0.5 + off.x) / treeCellScale;
            let tFaceV = (f32(cy) + 0.5 + off.y) / treeCellScale;

            // eligibility gate
            let elig = sampleElig(tFaceU, tFaceV, bt, uMin, vMin, uvSize);
            if (elig < 0.1) { continue; }

            // density thin
            let scaledElig = min(1.0, elig * TREE_DENSITY_SCALE);
            if (pcgF(pcg2(subSeed, 3u)) > scaledElig) { continue; }

            // ── tree confirmed; distance → AO ──
            let dU = tFaceU - faceU;
            let dV = tFaceV - faceV;
            let distM = sqrt(dU * dU + dV * dV) * P.faceSize;

            let fall = 1.0 - smoothstep(innerR, P.treeRadiusM, distM);
            occ = accum(occ, fall * P.treeStrength);
        }
    }}

    return occ;
}

// ── Ground-cover contribution ───────────────────────────────────────────────
// Replicates the scatter GC grid seed + jitter. Skips full climate eval and
// asset selection; uses a single configured keep probability instead.
// Reject water (tileId == 0) so seabeds don't darken.

fn accumGC(
    faceU: f32, faceV: f32,
    face: u32, bt: BakeTile,
    uMin: f32, vMin: f32, uvSize: f32,
    occIn: f32
) -> f32 {
    var occ = occIn;

    let gcScale = P.faceSize / P.gcCellWorldSize;   // cells per face-UV unit
    let gx0 = i32(floor(faceU * gcScale));
    let gy0 = i32(floor(faceV * gcScale));

    for (var dy = -GC_SEARCH; dy <= GC_SEARCH; dy++) {
    for (var dx = -GC_SEARCH; dx <= GC_SEARCH; dx++) {
        let gx = gx0 + dx;
        let gy = gy0 + dy;

        // ── seed: MUST match scatter pass 2 ──
        let worldSeed = pcg2(
            u32(gx) ^ (face * 2654435761u),
            u32(gy) ^ P.seed
        );

        // approximate thin (same PRN slot as scatter's thinRng)
        if (pcgF(worldSeed ^ 0xB5297A4Du) >= P.gcKeepProb) { continue; }

        // jittered position (same as scatter)
        let j = pcg2F(worldSeed);
        let gFaceU = (f32(gx) + j.x) / gcScale;
        let gFaceV = (f32(gy) + j.y) / gcScale;

        // reject water / empty
        let tid = sampleTileId(gFaceU, gFaceV, bt, uMin, vMin, uvSize);
        if (tid == 0u) { continue; }

        let dU = gFaceU - faceU;
        let dV = gFaceV - faceV;
        let distM = sqrt(dU * dU + dV * dV) * P.faceSize;

        let fall = 1.0 - smoothstep(0.0, P.gcRadiusM, distM);
        occ = accum(occ, fall * P.gcStrength);
    }}

    return occ;
}

// ── Main: one thread == one AO texel ────────────────────────────────────────

@compute @workgroup_size(8, 8, 1)
fn bake(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= AO_RES || gid.y >= AO_RES) { return; }
    if (gid.z >= P.tileCount) { return; }

    let bt       = bakeTiles[gid.z];
    let gridSize = f32(1u << bt.depth);
    let uvSize   = 1.0 / gridSize;
    let uMin     = f32(bt.tileX) / gridSize;
    let vMin     = f32(bt.tileY) / gridSize;

    // texel → face UV.
    // Border texels (k=0 and k=AO_RES-1) are placed at the exact tile
    // boundary (tu=0 / tu=1) rather than the usual centre-of-texel offset.
    // Adjacent tiles then share the same world position for their facing
    // border texels, so the smoothstep distance is identical and no seam
    // is baked in. Interior texels keep the standard centre-of-texel mapping.
    var tu = (f32(gid.x) + 0.5) / f32(AO_RES);
    if (gid.x == 0u)           { tu = 0.0; }
    if (gid.x == AO_RES - 1u) { tu = 1.0; }
    var tv = (f32(gid.y) + 0.5) / f32(AO_RES);
    if (gid.y == 0u)           { tv = 0.0; }
    if (gid.y == AO_RES - 1u) { tv = 1.0; }
    let faceU = uMin + tu * uvSize;
    let faceV = vMin + tv * uvSize;

    let tileWorldM = P.faceSize / gridSize;
    let texelM     = tileWorldM / f32(AO_RES);

    var occ: f32 = 0.0;

    occ = accumTrees(faceU, faceV, bt.face, bt, uMin, vMin, uvSize, occ);

    if (P.gcEnable != 0u && texelM <= P.gcRadiusM * 2.0) {
        occ = accumGC(faceU, faceV, bt.face, bt, uMin, vMin, uvSize, occ);
    }

    let ao = max(1.0 - occ, P.aoFloor);
    textureStore(aoOut, vec2<i32>(gid.xy), i32(bt.layer), vec4<f32>(ao, 0.0, 0.0, 0.0));
}
`;
}
