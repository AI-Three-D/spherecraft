// js/renderer/streamer/shaders/c.wgsl.js
//
// Climate-based asset scatter shader with procedural climate evaluation.
// Trees use pre-baked eligibility texture + world-space hash grid.
// Ground cover and plants use per-frame climate evaluation.

import { createNoiseLibrary } from '../../../world/shaders/webgpu/noiseLibrary.wgsl.js';
import { createEarthlikeConstants } from '../../../world/shaders/webgpu/terrain/base/earthLikeBase.wgsl.js';
import { createClimateCommon } from '../../../world/shaders/webgpu/terrain/climateCommon.wgsl.js';
import { buildAssetSelectionWGSL } from '../AssetSelectionBuffer.js';

export function buildAssetScatterClimateShader(config = {}) {
    const WORKGROUP_SIZE = config.workgroupSize ?? 64;
    const TOTAL_BANDS = config.totalBands ?? 9;
    const LODS_PER_CATEGORY = config.lodsPerCategory ?? 3;
    const MAX_SCATTER_TILE_WORLD_SIZE = config.maxScatterTileWorldSize ?? 48;
    const SCATTER_CELL_OVERSAMPLE = Math.max(1, Math.floor(config.scatterCellOversample ?? 1));
    const maxScatterDistance = config.maxScatterDistance ?? 12000;
    const maxDensity = Number.isFinite(config.maxDensity) ? Math.max(config.maxDensity, 0.000001) : 0.000001;
    const enableTreePass = config.enableTreePass !== false;
    const enableGroundPass = config.enableGroundPass !== false;
    const scatterGroupBit = Math.max(0, Math.floor(config.scatterGroupBit ?? 0));
    const baseGridRes = Math.max(1,
        Math.ceil(Math.sqrt(maxDensity * MAX_SCATTER_TILE_WORLD_SIZE * MAX_SCATTER_TILE_WORLD_SIZE))
    );
    const FIXED_GRID_RES = baseGridRes * SCATTER_CELL_OVERSAMPLE;
    const MAX_CANDIDATES_PER_TILE = FIXED_GRID_RES * FIXED_GRID_RES * 4;

    // Tree hash grid configuration
    const TREE_CELL_SIZE = config.treeCellSize ?? 50.0;
    const TREE_VISIBILITY = config.treeVisibility ?? 6000.0;
    const TREE_MAX_PER_CELL = config.treeMaxPerCell ?? 4;
    const TREE_CLUSTER_PROBABILITY = config.treeClusterProbability ?? 0.25;
    const TREE_JITTER_SCALE = config.treeJitterScale ?? 0.8;
    const TREE_DENSITY_SCALE = Number.isFinite(config.treeDensityScale) ? config.treeDensityScale : 1.0;

    const DENSITY_LUT_TILE_COUNT = Math.max(1, Math.floor(config.densityLutTileCount ?? 1));

    const earthlikeWGSL = createEarthlikeConstants();
    const noiseWGSL = createNoiseLibrary();
    const climateWGSL = createClimateCommon();
    const assetSelectionWGSL = buildAssetSelectionWGSL({});

    return /* wgsl */`
// ─── Climate-Based Asset Scatter — Hybrid Tree Hash Grid ───────────────────
// Trees: world-space hash grid + eligibility texture (LOD-independent)
// Ground cover & plants: tile-based grid + per-frame climate (existing path)

const WORKGROUP_SIZE:           u32 = ${WORKGROUP_SIZE}u;
const MAX_SCATTER_TILE_WS:      f32 = ${MAX_SCATTER_TILE_WORLD_SIZE.toFixed(1)};
const MAX_SCATTER_DISTANCE:     f32 = ${maxScatterDistance.toFixed(1)};
const BAND_COUNT:               u32 = ${TOTAL_BANDS}u;
const MAX_PARENT_SEARCH:        u32 = 16u;
const ENABLE_TREE_PASS:         bool = ${enableTreePass ? 'true' : 'false'};
const ENABLE_GROUND_PASS:       bool = ${enableGroundPass ? 'true' : 'false'};
const SCATTER_GROUP_BIT:        u32 = ${scatterGroupBit}u;
const FIXED_GRID_RES:           u32 = ${FIXED_GRID_RES}u;
const BASE_CELL_WORLD_AREA:     f32 = ${
        (MAX_SCATTER_TILE_WORLD_SIZE * MAX_SCATTER_TILE_WORLD_SIZE /
         (FIXED_GRID_RES * FIXED_GRID_RES)).toFixed(6)
    };
const MAX_CANDIDATES_PER_TILE:  u32 = ${MAX_CANDIDATES_PER_TILE}u;

// Tree hash grid constants
const TREE_CELL_SIZE:           f32 = ${TREE_CELL_SIZE.toFixed(1)};
const TREE_VISIBILITY:          f32 = ${TREE_VISIBILITY.toFixed(1)};
const TREE_MAX_PER_CELL:        u32 = ${TREE_MAX_PER_CELL}u;
const TREE_CLUSTER_PROB:        f32 = ${TREE_CLUSTER_PROBABILITY.toFixed(4)};
const TREE_JITTER_SCALE:        f32 = ${TREE_JITTER_SCALE.toFixed(3)};
const TREE_DENSITY_SCALE:       f32 = ${TREE_DENSITY_SCALE.toFixed(3)};

const DENSITY_LUT_TILE_COUNT: u32 = ${DENSITY_LUT_TILE_COUNT}u;
// Tree bands: 0..LODS_PER_CATEGORY-1 (CAT_TREES * LODS_PER_CATEGORY + lod)

// ── Imported modules ─────────────────────────────────────────────────────────
${earthlikeWGSL}

${noiseWGSL}

${climateWGSL}

${assetSelectionWGSL}

// ── Structs ─────────────────────────────────────────────────────────────────

struct ScatterParams {
    cameraPosition:  vec3<f32>,
    _pad0:           f32,
    planetOrigin:    vec3<f32>,
    planetRadius:    f32,
    heightScale:     f32,
    maxDensity:      f32,
    faceSize:        f32,
    seed:            u32,
    time:            f32,
    tileCount:       u32,
    _pad1:           f32,
    _pad2:           f32,
    viewProjection:  mat4x4<f32>,
}

struct BandMeta {
    baseOffset: u32,
    capacity:   u32,
    _pad0:      u32,
    _pad1:      u32,
}

struct AssetInstance {
    posX: f32, posY: f32, posZ: f32, rotation: f32,
    width: f32, height: f32,
    tileTypeId: u32, bandIndex: u32,
    colorR: f32, colorG: f32, colorB: f32, colorA: f32,
    surfaceNX: f32, surfaceNY: f32, surfaceNZ: f32, _pad0: f32,
}

struct LoadedEntry {
    keyLo: u32, keyHi: u32, layer: u32, _pad: u32,
}

struct ClimateUniforms {
    climateParams: vec4<f32>,
    climateZone0: vec4<f32>,
    climateZone0Extra: vec4<f32>,
    climateZone1: vec4<f32>,
    climateZone1Extra: vec4<f32>,
    climateZone2: vec4<f32>,
    climateZone2Extra: vec4<f32>,
    climateZone3: vec4<f32>,
    climateZone3Extra: vec4<f32>,
    climateZone4: vec4<f32>,
    climateZone4Extra: vec4<f32>,
    climateRuntime: vec4<f32>,
}

struct TileData {
    face:          u32,
    depth:         u32,
    tileX:         u32,
    tileY:         u32,
    layer:         i32,
    uvBiasX:       f32,
    uvBiasY:       f32,
    uvScale:       f32,
    tileUMin:      f32,
    tileVMin:      f32,
    tileUVSize:    f32,
    gcMinX:        i32,
    gcMinY:        i32,
    gcCellsX:      u32,
    gcCellsY:      u32,
    gcStrideX:     u32,
    gcStrideY:     u32,
    totalCandidates: u32,
    globalCellScale:  f32,
    cellWorldArea:    f32,
    candidateScale:   f32,
    shouldProcess:    u32,
    // Tree hash grid bounds for this tile
    treeCellMinX:     i32,
    treeCellMinY:     i32,
    treeCellCountX:   u32,
    treeCellCountY:   u32,
    totalTreeCandidates: u32,
    treeCellScale:    f32,
    groupEligibilityMask: u32,
}

var<workgroup> td: TileData;

// ── Bindings ─────────────────────────────────────────────────────────────────
@group(0) @binding(0) var<uniform>             params:             ScatterParams;
@group(0) @binding(1) var<storage, read>       visibleTiles:       array<vec4<u32>>;
@group(0) @binding(2) var<storage, read_write> instances:          array<AssetInstance>;
@group(0) @binding(3) var<storage, read_write> bandCounters:       array<atomic<u32>, BAND_COUNT>;
@group(0) @binding(4) var<uniform>             bandMeta:           array<BandMeta, BAND_COUNT>;
@group(0) @binding(5) var                      heightTex:          texture_2d_array<f32>;
@group(0) @binding(6) var                      tileTex:            texture_2d_array<f32>;
@group(0) @binding(7) var<storage, read>       loadedTable:        array<LoadedEntry>;
@group(0) @binding(8) var<uniform>             loadedTableParams:  vec2<u32>;
@group(0) @binding(9) var<storage, read_write> traversalCounters:  array<atomic<u32>, 4>;
@group(0) @binding(10) var<storage, read>      assetDefs:          array<f32>;
@group(0) @binding(11) var<storage, read>      tileAssetMap:       array<u32>;
@group(0) @binding(12) var<uniform>            assetConfig:        AssetSelectionConfig;
@group(0) @binding(13) var<uniform>            climateUniforms:    ClimateUniforms;
@group(0) @binding(14) var                     scatterTex:         texture_2d_array<f32>;
@group(0) @binding(15) var<storage, read> densityLUT: array<f32>;
@group(0) @binding(16) var                     normalTex:          texture_2d_array<f32>;
@group(0) @binding(17) var<storage, read>      scatterGroupMasks:  array<u32>;

const EMPTY_KEY: u32 = 0xFFFFFFFFu;

// ── PCG Hash ─────────────────────────────────────────────────────────────────

fn pcg(v: u32) -> u32 {
    var s = v * 747796405u + 2891336453u;
    let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
    return (w >> 22u) ^ w;
}

fn pcgF(v: u32) -> f32 {
    return f32(pcg(v)) / 4294967296.0;
}

fn pcg2(a: u32, b: u32) -> u32 {
    return pcg(a ^ (b * 1664525u + 1013904223u));
}

fn pcg3(a: u32, b: u32, c: u32) -> u32 {
    return pcg(pcg2(a, b) ^ (c * 2654435761u));
}

fn pcg4(a: u32, b: u32, c: u32, d: u32) -> u32 {
    return pcg(pcg3(a, b, c) ^ (d * 2246822519u));
}

fn pcg2F(seed: u32) -> vec2<f32> {
    let h1 = pcg(seed);
    let h2 = pcg(h1);
    return vec2<f32>(f32(h1) / 4294967296.0, f32(h2) / 4294967296.0);
}

fn hemiOctDecode(e: vec2<f32>) -> vec3<f32> {
    let z = 1.0 - abs(e.x) - abs(e.y);
    return normalize(vec3<f32>(e, z));
}

// ── Hash Table ───────────────────────────────────────────────────────────────

fn makeKeyLo(x: u32, y: u32) -> u32 { return x | (y << 16u); }
fn makeKeyHi(face: u32, depth: u32) -> u32 { return (depth & 0xFFFFu) | (face << 16u); }

fn hashKey(keyLo: u32, keyHi: u32, mask: u32) -> u32 {
    return (keyLo * 1664525u + keyHi * 1013904223u) & mask;
}

fn lookupLayerExact(face: u32, depth: u32, x: u32, y: u32) -> i32 {
    let keyLo = makeKeyLo(x, y);
    let keyHi = makeKeyHi(face, depth);
    let mask = loadedTableParams.x;
    let cap  = loadedTableParams.y;
    var idx  = hashKey(keyLo, keyHi, mask);
    for (var i = 0u; i < cap; i++) {
        let e = loadedTable[idx];
        if (e.keyHi == EMPTY_KEY) { return -1; }
        if (e.keyHi == keyHi && e.keyLo == keyLo) { return i32(e.layer); }
        idx = (idx + 1u) & mask;
    }
    return -1;
}

struct FallbackResult { layer: i32, uvBiasX: f32, uvBiasY: f32, uvScale: f32, }

fn lookupLayerWithFallback(face: u32, depth: u32, x: u32, y: u32) -> FallbackResult {
    let exact = lookupLayerExact(face, depth, x, y);
    if (exact >= 0) { return FallbackResult(exact, 0.0, 0.0, 1.0); }
    var d = depth; var tx = x; var ty = y;
    var scale = 1.0; var biasX = 0.0; var biasY = 0.0;
    for (var step = 0u; step < MAX_PARENT_SEARCH; step++) {
        if (d == 0u) { break; }
        scale *= 0.5;
        biasX += f32(tx & 1u) * scale;
        biasY += f32(ty & 1u) * scale;
        tx >>= 1u; ty >>= 1u; d -= 1u;
        let pl = lookupLayerExact(face, d, tx, ty);
        if (pl >= 0) { return FallbackResult(pl, biasX, biasY, scale); }
    }
    return FallbackResult(-1, 0.0, 0.0, 1.0);
}

// ── Sphere projection ────────────────────────────────────────────────────────

fn getCubePoint(face: u32, u: f32, v: f32) -> vec3<f32> {
    let s = u * 2.0 - 1.0;
    let t = v * 2.0 - 1.0;
    switch (face) {
        case 0u { return vec3<f32>( 1.0,  t, -s); }
        case 1u { return vec3<f32>(-1.0,  t,  s); }
        case 2u { return vec3<f32>(  s, 1.0, -t); }
        case 3u { return vec3<f32>(  s,-1.0,  t); }
        case 4u { return vec3<f32>(  s,  t, 1.0); }
        default { return vec3<f32>( -s,  t,-1.0); }
    }
}

// Map unit-sphere direction back to (face, u, v)
fn dirToFaceUV(dir: vec3<f32>) -> vec3<f32> {
    let ax = abs(dir.x);
    let ay = abs(dir.y);
    let az = abs(dir.z);

    var face: f32 = 0.0;
    var u: f32 = 0.5;
    var v: f32 = 0.5;

    if (ax >= ay && ax >= az) {
        if (dir.x > 0.0) {
            face = 0.0;
            u = (-dir.z / ax + 1.0) * 0.5;
            v = ( dir.y / ax + 1.0) * 0.5;
        } else {
            face = 1.0;
            u = ( dir.z / ax + 1.0) * 0.5;
            v = ( dir.y / ax + 1.0) * 0.5;
        }
    } else if (ay >= ax && ay >= az) {
        if (dir.y > 0.0) {
            face = 2.0;
            u = ( dir.x / ay + 1.0) * 0.5;
            v = (-dir.z / ay + 1.0) * 0.5;
        } else {
            face = 3.0;
            u = ( dir.x / ay + 1.0) * 0.5;
            v = ( dir.z / ay + 1.0) * 0.5;
        }
    } else {
        if (dir.z > 0.0) {
            face = 4.0;
            u = ( dir.x / az + 1.0) * 0.5;
            v = ( dir.y / az + 1.0) * 0.5;
        } else {
            face = 5.0;
            u = (-dir.x / az + 1.0) * 0.5;
            v = ( dir.y / az + 1.0) * 0.5;
        }
    }

    return vec3<f32>(face, clamp(u, 0.0, 1.0), clamp(v, 0.0, 1.0));
}

fn isTileBeyondScatterRange(face: u32, depth: u32, tileX: u32, tileY: u32) -> bool {
    let gridSize   = f32(1u << depth);
    let cu         = (f32(tileX) + 0.5) / gridSize;
    let cv         = (f32(tileY) + 0.5) / gridSize;
    let cWorld     = params.planetOrigin + normalize(getCubePoint(face, cu, cv)) * params.planetRadius;
    let tileDist   = length(params.cameraPosition - cWorld);
    let tileWS     = params.faceSize / gridSize;
    let margin     = tileWS * 0.75 + 1.8 * params.heightScale;
    return (tileDist - margin) > MAX_SCATTER_DISTANCE;
}

fn getRow(m: mat4x4<f32>, r: u32) -> vec4<f32> {
    return vec4<f32>(m[0][r], m[1][r], m[2][r], m[3][r]);
}

fn isTileOutsideFrustum(face: u32, depth: u32, tileX: u32, tileY: u32) -> bool {
    let gridSize  = f32(1u << depth);
    let cu        = (f32(tileX) + 0.5) / gridSize;
    let cv        = (f32(tileY) + 0.5) / gridSize;
    let cWorld    = params.planetOrigin + normalize(getCubePoint(face, cu, cv)) * params.planetRadius;
    let tileWS    = params.faceSize / gridSize;
    let radius    = tileWS * 0.75 + 1.8 * params.heightScale;
    let row0 = getRow(params.viewProjection, 0u);
    let row1 = getRow(params.viewProjection, 1u);
    let row2 = getRow(params.viewProjection, 2u);
    let row3 = getRow(params.viewProjection, 3u);
    let planes = array<vec4<f32>, 6>(
        row3 + row0, row3 - row0,
        row3 + row1, row3 - row1,
        row3 + row2, row3 - row2
    );
    for (var i = 0u; i < 6u; i++) {
        let p = planes[i]; let n = p.xyz; let nLen = length(n);
        if (nLen < 0.0001) { continue; }
        if ((dot(n, cWorld) + p.w) / nLen < -radius) { return true; }
    }
    return false;
}

fn isTileBeyondTreeRange(face: u32, depth: u32, tileX: u32, tileY: u32) -> bool {
    let gridSize   = f32(1u << depth);
    let cu         = (f32(tileX) + 0.5) / gridSize;
    let cv         = (f32(tileY) + 0.5) / gridSize;
    let cWorld     = params.planetOrigin + normalize(getCubePoint(face, cu, cv)) * params.planetRadius;
    let tileDist   = length(params.cameraPosition - cWorld);
    let tileWS     = params.faceSize / gridSize;
    let margin     = tileWS * 0.75 + 1.8 * params.heightScale;
    return (tileDist - margin) > TREE_VISIBILITY;
}

fn computeSlopeFromHeight(coord: vec2<i32>, layer: i32, depth: u32) -> f32 {
    let hSize = vec2<i32>(textureDimensions(heightTex));
    let maxCoord = hSize - vec2<i32>(1, 1);

    let cL = clamp(coord + vec2<i32>(-1, 0), vec2<i32>(0), maxCoord);
    let cR = clamp(coord + vec2<i32>( 1, 0), vec2<i32>(0), maxCoord);
    let cD = clamp(coord + vec2<i32>( 0,-1), vec2<i32>(0), maxCoord);
    let cU = clamp(coord + vec2<i32>( 0, 1), vec2<i32>(0), maxCoord);

    let hL = textureLoad(heightTex, cL, layer, 0).r;
    let hR = textureLoad(heightTex, cR, layer, 0).r;
    let hD = textureLoad(heightTex, cD, layer, 0).r;
    let hU = textureLoad(heightTex, cU, layer, 0).r;

    let gridSize = f32(1u << depth);
    let tileWS = params.faceSize / gridSize;
    let texelWorld = tileWS / f32(max(hSize.x, 1));

    let dhdx = (hR - hL) * params.heightScale / max(2.0 * texelWorld, 0.0001);
    let dhdy = (hU - hD) * params.heightScale / max(2.0 * texelWorld, 0.0001);

    let n = normalize(vec3<f32>(-dhdx, 1.0, -dhdy));
    return clamp(1.0 - n.y, 0.0, 1.0);
}

fn sampleTreeEligibility(face: u32, faceU: f32, faceV: f32, layer: i32,
                          uvBiasX: f32, uvBiasY: f32, uvScale: f32,
                          tileUMin: f32, tileVMin: f32, tileUVSize: f32) -> f32 {
    let relU = (faceU - tileUMin) / tileUVSize;
    let relV = (faceV - tileVMin) / tileUVSize;
    let texU = uvBiasX + relU * uvScale;
    let texV = uvBiasY + relV * uvScale;

    let sSize = vec2<i32>(textureDimensions(scatterTex));
    let sCoord = clamp(vec2<i32>(vec2<f32>(texU, texV) * vec2<f32>(sSize)),
                       vec2<i32>(0), sSize - vec2<i32>(1));
    return textureLoad(scatterTex, sCoord, layer, 0).r;
}

fn sampleHeightAtFaceUV(faceU: f32, faceV: f32, layer: i32,
                         uvBiasX: f32, uvBiasY: f32, uvScale: f32,
                         tileUMin: f32, tileVMin: f32, tileUVSize: f32) -> f32 {
    let relU = (faceU - tileUMin) / tileUVSize;
    let relV = (faceV - tileVMin) / tileUVSize;
    let texU = uvBiasX + relU * uvScale;
    let texV = uvBiasY + relV * uvScale;

    let hSize = vec2<i32>(textureDimensions(heightTex));
    let hCoord = clamp(vec2<i32>(vec2<f32>(texU, texV) * vec2<f32>(hSize)),
                       vec2<i32>(0), hSize - vec2<i32>(1));
    return textureLoad(heightTex, hCoord, layer, 0).r;
}

// ── Tree: get LOD band from distance ────────────────────────────────────────

fn getTreeBand(dist: f32) -> u32 {
    // Use asset definition LOD distances for the first tree asset
    let def = loadAssetDef(&assetDefs, 0u);
    for (var i: u32 = 0u; i < LODS_PER_CATEGORY; i++) {
        if (dist < def.lodDistances[i]) { return i; }
    }
    return 0xFFFFFFFFu;
}

// ── Tree: emit one tree instance ────────────────────────────────────────────

fn emitTree(worldPos: vec3<f32>, dist: f32, worldSeed: u32, tileId: u32,
            eligibility: f32) {
    let band = getTreeBand(dist);
    if (band == 0xFFFFFFFFu) { return; }

    let metab = bandMeta[band];
    let idx = atomicAdd(&bandCounters[band], 1u);
    if (idx >= metab.capacity) { return; }

    let gIdx = metab.baseOffset + idx;

    // Select tree asset type using eligibility as weight factor
    let selectRng = pcgF(worldSeed ^ 0x9E3779B9u);
    let rawAssetIdx = selectAsset(
        &assetDefs,
        &tileAssetMap,
        tileId,
        assetConfig.maxTileType,
        0.5,  // neutral temperature (eligibility already filtered climate)
        0.5,  // neutral precipitation
        0.5,  // neutral elevation
        0.1,  // low slope (eligibility already filtered slope)
        selectRng
    );

    // Use first tree definition as fallback if selectAsset fails
    var def: AssetDef;
    var assetIdx: u32 = 0u;
    if (rawAssetIdx != 0xFFFFFFFFu) {
        assetIdx = rawAssetIdx;
        def = loadAssetDef(&assetDefs, rawAssetIdx);
    } else {
        def = loadAssetDef(&assetDefs, 0u);
    }

    let rot = pcgF(worldSeed ^ 0xA341316Cu) * 6.2831853;
    let sw = pcgF(worldSeed ^ 0xC8013EA4u);
    let sh = pcgF(worldSeed ^ 0xAD90777Du);
    let w = mix(def.widthMin, def.widthMax, sw);
    let h = mix(def.heightMin, def.heightMax, sh);
    let cj = pcgF(worldSeed ^ 0x7E95761Eu);
    let col = mix(def.baseColor, def.tipColor, cj);

    instances[gIdx] = AssetInstance(
        worldPos.x, worldPos.y, worldPos.z,
        rot, w, h,
        assetIdx, band,
        col.x, col.y, col.z, 1.0,
        normalize(worldPos - params.planetOrigin).x,
        normalize(worldPos - params.planetOrigin).y,
        normalize(worldPos - params.planetOrigin).z,
        0.0
    );
}

// ── Main ─────────────────────────────────────────────────────────────────────

@compute @workgroup_size(${WORKGROUP_SIZE}, 1, 1)
fn main(
    @builtin(workgroup_id)          wgId:      vec3<u32>,
    @builtin(local_invocation_index) threadIdx: u32
) {
    let tileIdx = wgId.x;

    // ── Thread 0: tile setup ─────────────────────────────────────────────
    if (threadIdx == 0u) {
        let actualTileCount = min(atomicLoad(&traversalCounters[2]), params.tileCount);

        if (tileIdx >= actualTileCount) {
            td.shouldProcess = 0u;
        } else {
            let tile  = visibleTiles[tileIdx];
            td.face   = tile.x;
            td.depth  = tile.y;
            td.tileX  = tile.z;
            td.tileY  = tile.w;

            // Use MAX_SCATTER_DISTANCE for general culling (covers all categories)
            if (isTileOutsideFrustum(td.face, td.depth, td.tileX, td.tileY)) {
                td.shouldProcess = 0u;
            } else {
                let fb = lookupLayerWithFallback(td.face, td.depth, td.tileX, td.tileY);
                if (fb.layer < 0) {
                    td.shouldProcess = 0u;
                } else {
                    td.layer    = fb.layer;
                    td.uvBiasX  = fb.uvBiasX;
                    td.uvBiasY  = fb.uvBiasY;
                    td.uvScale  = fb.uvScale;
                    td.groupEligibilityMask = 0xFFFFFFFFu;

                    if (ENABLE_GROUND_PASS && SCATTER_GROUP_BIT != 0u) {
                        let layerIndex = u32(max(td.layer, 0));
                        td.groupEligibilityMask = scatterGroupMasks[layerIndex];
                        if ((td.groupEligibilityMask & SCATTER_GROUP_BIT) == 0u) {
                            td.shouldProcess = 0u;
                        } else {
                            td.shouldProcess = 1u;
                        }
                    } else {
                        td.shouldProcess = 1u;
                    }

                    if (td.shouldProcess == 0u) {
                        td.totalCandidates = 0u;
                        td.totalTreeCandidates = 0u;
                    } else {

                        let gridSize    = f32(1u << td.depth);
                        td.tileUMin     = f32(td.tileX) / gridSize;
                        td.tileVMin     = f32(td.tileY) / gridSize;
                        td.tileUVSize   = 1.0 / gridSize;

                        // ── Global face-UV grid (for ground cover / plants) ──
                        let gcs = f32(FIXED_GRID_RES) * params.faceSize / MAX_SCATTER_TILE_WS;
                        td.globalCellScale = gcs;

                        let globalCellSizeM = MAX_SCATTER_TILE_WS / f32(FIXED_GRID_RES);
                        td.cellWorldArea = globalCellSizeM * globalCellSizeM;

                        let uMax  = td.tileUMin + td.tileUVSize;
                        let vMax  = td.tileVMin + td.tileUVSize;
                        let gcMinX = i32(floor(td.tileUMin * gcs));
                        let gcMinY = i32(floor(td.tileVMin * gcs));
                        let gcMaxX = i32(ceil(uMax * gcs));
                        let gcMaxY = i32(ceil(vMax * gcs));

                        let fullCellsX = u32(max(gcMaxX - gcMinX, 0));
                        let fullCellsY = u32(max(gcMaxY - gcMinY, 0));
                        let capSide = max(1u, u32(ceil(sqrt(f32(MAX_CANDIDATES_PER_TILE)))));

                        td.gcMinX        = gcMinX;
                        td.gcMinY        = gcMinY;
                        td.gcStrideX     = max(1u, (fullCellsX + capSide - 1u) / capSide);
                        td.gcStrideY     = max(1u, (fullCellsY + capSide - 1u) / capSide);
                        td.gcCellsX      = (fullCellsX + td.gcStrideX - 1u) / td.gcStrideX;
                        td.gcCellsY      = (fullCellsY + td.gcStrideY - 1u) / td.gcStrideY;
                        td.totalCandidates = td.gcCellsX * td.gcCellsY;
                        let fullCellCount = max(1u, fullCellsX * fullCellsY);
                        let sampledCellCount = max(1u, td.totalCandidates);
                        td.candidateScale = f32(fullCellCount) / f32(sampledCellCount);

                        // ── Tree hash grid bounds for this tile ──────────────
                        // Tree grid is in face-UV space with fixed cell size
                        let treeCellScale = params.faceSize / TREE_CELL_SIZE;
                        td.treeCellScale = treeCellScale;
                        let tcMinX = i32(floor(td.tileUMin * treeCellScale));
                        let tcMinY = i32(floor(td.tileVMin * treeCellScale));
                        let tcMaxX = i32(ceil(uMax * treeCellScale));
                        let tcMaxY = i32(ceil(vMax * treeCellScale));

                        td.treeCellMinX = tcMinX;
                        td.treeCellMinY = tcMinY;
                        td.treeCellCountX = u32(max(tcMaxX - tcMinX, 0));
                        td.treeCellCountY = u32(max(tcMaxY - tcMinY, 0));
                        td.totalTreeCandidates = td.treeCellCountX * td.treeCellCountY * TREE_MAX_PER_CELL;

                        td.shouldProcess = 1u;
                    }
                }
            }
        }
    }

    workgroupBarrier();
    if (td.shouldProcess == 0u) { return; }

    let layer = td.layer;
    let beyondGCRange = isTileBeyondScatterRange(td.face, td.depth, td.tileX, td.tileY);
    let beyondTreeRange = isTileBeyondTreeRange(td.face, td.depth, td.tileX, td.tileY);

    // ═══════════════════════════════════════════════════════════════════════
    // PASS 1: Trees via world-space hash grid + eligibility texture
    // ═══════════════════════════════════════════════════════════════════════
    if (ENABLE_TREE_PASS && !beyondTreeRange) {
        for (var treeIdx = threadIdx;
             treeIdx < td.totalTreeCandidates;
             treeIdx += WORKGROUP_SIZE)
        {
            let cellLinear = treeIdx / TREE_MAX_PER_CELL;
            let subIdx = treeIdx % TREE_MAX_PER_CELL;

            let localX = cellLinear % td.treeCellCountX;
            let localY = cellLinear / td.treeCellCountX;
            if (localY >= td.treeCellCountY) { continue; }

            let tcX = td.treeCellMinX + i32(localX);
            let tcY = td.treeCellMinY + i32(localY);

            // Stable world seed: depends ONLY on cell coords + face + engine seed
            let cellSeed = pcg4(
                u32(tcX + 100000),
                u32(tcY + 100000),
                td.face,
                params.seed
            );

            // Cluster probability check (only on subIdx 0, shared for all trees in cell)
            let clusterRoll = pcgF(cellSeed);
            if (clusterRoll > TREE_CLUSTER_PROB) { continue; }

            // Number of trees in this cluster
            let treeCountHash = pcg2(cellSeed, 1u);
            let treeCount = 1u + (treeCountHash % TREE_MAX_PER_CELL);
            if (subIdx >= treeCount) { continue; }

            // Sub-cell position (deterministic from cell + sub-index)
            let subSeed = pcg3(cellSeed, subIdx, 42u);
            let grid = select(1u, 2u, treeCount > 1u);
            let subX = subIdx % grid;
            let subY = subIdx / grid;
            let baseOff = (vec2<f32>(f32(subX) + 0.5, f32(subY) + 0.5) / f32(grid)) - vec2<f32>(0.5);
            let jitter = (pcg2F(subSeed) - vec2<f32>(0.5)) * (TREE_JITTER_SCALE / f32(grid));
            let off = baseOff + jitter;
            let offX = off.x;
            let offY = off.y;

            // Face UV position
            let faceU = (f32(tcX) + 0.5 + offX) / td.treeCellScale;
            let faceV = (f32(tcY) + 0.5 + offY) / td.treeCellScale;

            // Skip if outside this tile's UV bounds
            let uMax = td.tileUMin + td.tileUVSize;
            let vMax = td.tileVMin + td.tileUVSize;
            if (faceU < td.tileUMin || faceU >= uMax ||
                faceV < td.tileVMin || faceV >= vMax) {
                continue;
            }

            // Sample pre-baked eligibility (no climate re-evaluation!)
            let elig = sampleTreeEligibility(
                td.face, faceU, faceV, layer,
                td.uvBiasX, td.uvBiasY, td.uvScale,
                td.tileUMin, td.tileVMin, td.tileUVSize
            );
            if (elig < 0.1) { continue; }

            // Density thinning using eligibility as probability (scaled to preserve counts)
            let scaledElig = min(1.0, elig * TREE_DENSITY_SCALE);
            let densityRoll = pcgF(pcg2(subSeed, 3u));
            if (densityRoll > scaledElig) { continue; }

            // Sample height for altitude (LOD-dependent — matches rendered mesh)
            let heightVal = sampleHeightAtFaceUV(
                faceU, faceV, layer,
                td.uvBiasX, td.uvBiasY, td.uvScale,
                td.tileUMin, td.tileVMin, td.tileUVSize
            );

            // World position
            let cubePoint = getCubePoint(td.face, faceU, faceV);
            let sphereDir = normalize(cubePoint);
            let radius = params.planetRadius + heightVal * params.heightScale;
            let worldPos = params.planetOrigin + sphereDir * radius;
            let dist = length(params.cameraPosition - worldPos);

            if (dist > TREE_VISIBILITY) { continue; }

            // Read tile type for asset selection
            let relU = (faceU - td.tileUMin) / td.tileUVSize;
            let relV = (faceV - td.tileVMin) / td.tileUVSize;
            let texU = td.uvBiasX + relU * td.uvScale;
            let texV = td.uvBiasY + relV * td.uvScale;
            let tSize = vec2<i32>(textureDimensions(tileTex));
            let tCoord = clamp(vec2<i32>(vec2<f32>(texU, texV) * vec2<f32>(tSize)),
                               vec2<i32>(0), tSize - vec2<i32>(1));
            let tileSmp = textureLoad(tileTex, tCoord, layer, 0);
            let rawR = tileSmp.r;
            let tileIdF = select(rawR * 255.0, rawR, rawR > 1.0);
            let tileId = u32(tileIdF + 0.5);

            emitTree(worldPos, dist, subSeed, tileId, elig);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PASS 2: Ground cover + plants via existing tile-grid + climate path
    // ═══════════════════════════════════════════════════════════════════════
    if (ENABLE_GROUND_PASS && !beyondGCRange) {
        for (var candidateIdx = threadIdx;
             candidateIdx < td.totalCandidates;
             candidateIdx += WORKGROUP_SIZE)
        {
            let localX = candidateIdx % td.gcCellsX;
            let localY = candidateIdx / td.gcCellsX;
            let gcX    = td.gcMinX + i32(localX * td.gcStrideX);
            let gcY    = td.gcMinY + i32(localY * td.gcStrideY);

            let worldSeed = pcg2(
                u32(gcX) ^ (td.face * 2654435761u),
                u32(gcY) ^ params.seed
            );

            let jitter = pcg2F(worldSeed);
            let faceU  = (f32(gcX) + jitter.x) / td.globalCellScale;
            let faceV  = (f32(gcY) + jitter.y) / td.globalCellScale;

            let uMax = td.tileUMin + td.tileUVSize;
            let vMax = td.tileVMin + td.tileUVSize;
            if (faceU < td.tileUMin || faceU >= uMax ||
                faceV < td.tileVMin || faceV >= vMax) {
                continue;
            }

            let relU   = (faceU - td.tileUMin) / td.tileUVSize;
            let relV   = (faceV - td.tileVMin) / td.tileUVSize;
            let texU   = td.uvBiasX + relU * td.uvScale;
            let texV   = td.uvBiasY + relV * td.uvScale;

            let tSize   = vec2<i32>(textureDimensions(tileTex));
            let tCoord  = clamp(vec2<i32>(vec2<f32>(texU, texV) * vec2<f32>(tSize)),
                                vec2<i32>(0), tSize - vec2<i32>(1));
            let tileSmp = textureLoad(tileTex, tCoord, layer, 0);
            let rawR    = tileSmp.r;
            let tileIdF = select(rawR * 255.0, rawR, rawR > 1.0);
            let tileId  = u32(tileIdF + 0.5);

            let hSize  = vec2<i32>(textureDimensions(heightTex));
            let hCoord = clamp(vec2<i32>(vec2<f32>(texU, texV) * vec2<f32>(hSize)),
                               vec2<i32>(0), hSize - vec2<i32>(1));
            let heightSample = textureLoad(heightTex, hCoord, layer, 0).r;

            let cubePoint  = getCubePoint(td.face, faceU, faceV);
            let sphereDir  = normalize(cubePoint);
            let radius     = params.planetRadius + heightSample * params.heightScale;
            let worldPos   = params.planetOrigin + sphereDir * radius;
            let dist       = length(params.cameraPosition - worldPos);

            let elevation = clamp(heightSample * 0.5 + 0.5, 0.0, 1.0);
            let slope = computeSlopeFromHeight(hCoord, layer, td.depth);
            let nSize  = vec2<i32>(textureDimensions(normalTex));
            let nCoord = clamp(vec2<i32>(vec2<f32>(texU, texV) * vec2<f32>(nSize)),
                               vec2<i32>(0), nSize - vec2<i32>(1));
            let nSample = textureLoad(normalTex, nCoord, layer, 0);
            let tangentNormal = hemiOctDecode(nSample.rg * 2.0 - vec2<f32>(1.0, 1.0));
            var refUp = vec3<f32>(0.0, 1.0, 0.0);
            if (abs(dot(sphereDir, refUp)) > 0.99) {
                refUp = vec3<f32>(1.0, 0.0, 0.0);
            }
            let terrainTangent = normalize(cross(sphereDir, refUp));
            let terrainBitangent = normalize(cross(sphereDir, terrainTangent));
            var groundNormal = normalize(
                terrainTangent * tangentNormal.x +
                terrainBitangent * tangentNormal.y +
                sphereDir * tangentNormal.z
            );
            if (length(groundNormal) < 0.0001) {
                groundNormal = sphereDir;
            }

            let cfg = ClimateConfig(
                climateUniforms.climateParams,
                climateUniforms.climateZone0,
                climateUniforms.climateZone0Extra,
                climateUniforms.climateZone1,
                climateUniforms.climateZone1Extra,
                climateUniforms.climateZone2,
                climateUniforms.climateZone2Extra,
                climateUniforms.climateZone3,
                climateUniforms.climateZone3Extra,
                climateUniforms.climateZone4,
                climateUniforms.climateZone4Extra
            );
            let climate = getClimateWithConfig(
                worldPos.x,
                worldPos.z,
                sphereDir,
                elevation,
                i32(params.seed),
                i32(td.face),
                climateUniforms.climateRuntime.x,
                climateUniforms.climateRuntime.y,
                cfg
            );

            let selectRng = pcgF(worldSeed ^ 0x9E3779B9u);
            let assetIdx = selectAsset(
                &assetDefs,
                &tileAssetMap,
                tileId,
                assetConfig.maxTileType,
                climate.temperature,
                climate.precipitation,
                elevation,
                slope,
                selectRng
            );

            if (assetIdx == 0xFFFFFFFFu) { continue; }

            let def = loadAssetDef(&assetDefs, assetIdx);

            // Skip tree_standard in this pass — pass 1 handles it.
            // archetypeIndex 0 == tree_standard (hard invariant).
            if (def.archetypeIndex == 0u) { continue; }
            let lodInfo = getAssetLODInfo(def, dist);
            if (lodInfo.lodLevel == 0xFFFFFFFFu) { continue; }
            let densityFitness = computeAssetFitness(
                def,
                climate.temperature,
                climate.precipitation,
                elevation,
                slope
            );

            // ── Inc 5: per-family × per-tile density scaling ─────────
            // Family index lives at float [30]. AssetDef.geometryTypeIndex
            // actually reads this slot (stale field name from the legacy
            // 28-float schema) but we read raw to be explicit.
            // FLOATS_PER_ASSET is already defined by buildAssetSelectionWGSL.
            //
            // tileId clamp is defensive — selectAsset already bails on
            // tileType > maxTileType so this branch shouldn't see OOB IDs,
            // but the textured tileId path doesn't go through that gate.
            let familyIdx  = u32(assetDefs[assetIdx * FLOATS_PER_ASSET + 30u]);
            let lutTile    = min(tileId, DENSITY_LUT_TILE_COUNT - 1u);
            let densityMul = densityLUT[familyIdx * DENSITY_LUT_TILE_COUNT + lutTile];

            let keepProb = clamp(
                lodInfo.density * densityMul * densityFitness * td.cellWorldArea * td.candidateScale,
                0.0, 1.0
            );
            
            let thinRng = pcgF(worldSeed ^ 0xB5297A4Du);
            if (thinRng >= keepProb) { continue; }

            let metab = bandMeta[lodInfo.bandIndex];
            let idx  = atomicAdd(&bandCounters[lodInfo.bandIndex], 1u);
            if (idx >= metab.capacity) { continue; }

            let gIdx  = metab.baseOffset + idx;
            let rot  = pcgF(worldSeed ^ 0xA341316Cu) * 6.2831853;
            let sw   = pcgF(worldSeed ^ 0xC8013EA4u);
            let sh   = pcgF(worldSeed ^ 0xAD90777Du);
            let w    = mix(def.widthMin, def.widthMax, sw);
            let h    = mix(def.heightMin, def.heightMax, sh);
            let cj   = pcgF(worldSeed ^ 0x7E95761Eu);
            let col  = mix(def.baseColor, def.tipColor, cj);
            // Self-occlusion terrainEmbedding moved to [46] after adding
            // extra prop-texture slots to the variant trailer.
            let terrainEmbed = max(0.0, assetDefs[assetIdx * FLOATS_PER_ASSET + 46u]);
            let embedDepth = terrainEmbed * max(w, h);
            let anchorPos = worldPos - groundNormal * embedDepth;

            instances[gIdx] = AssetInstance(
                anchorPos.x, anchorPos.y, anchorPos.z,
                rot, w, h,
                assetIdx, lodInfo.bandIndex,
                col.x, col.y, col.z, 1.0,
                groundNormal.x, groundNormal.y, groundNormal.z, 0.0
            );
        }
    }
}
`;
}
