import { buildAssetSelectionWGSL } from '../AssetSelectionBuffer.js';

export function buildTreeSourceBakeShader(config = {}) {
    const WORKGROUP_SIZE = Math.max(32, Math.floor(config.workgroupSize ?? 64));
    const PER_LAYER_CAPACITY = Math.max(1, Math.floor(config.perLayerCapacity ?? 1024));
    const TREE_CELL_SIZE = Number.isFinite(config.treeCellSize) ? Math.max(1.0, config.treeCellSize) : 16.0;
    const TREE_MAX_PER_CELL = Math.max(1, Math.floor(config.treeMaxPerCell ?? 4));
    const TREE_CLUSTER_PROBABILITY = Number.isFinite(config.treeClusterProbability)
        ? Math.min(1.0, Math.max(0.0, config.treeClusterProbability))
        : 0.95;
    const TREE_JITTER_SCALE = Number.isFinite(config.treeJitterScale)
        ? Math.max(0.0, config.treeJitterScale)
        : 0.85;
    const TREE_DENSITY_SCALE = Number.isFinite(config.treeDensityScale)
        ? Math.max(0.0, config.treeDensityScale)
        : 1.0;
    const assetSelectionWGSL = buildAssetSelectionWGSL({});

    return /* wgsl */`
const WORKGROUP_SIZE: u32 = ${WORKGROUP_SIZE}u;
const PER_LAYER_CAPACITY: u32 = ${PER_LAYER_CAPACITY}u;
const TREE_CELL_SIZE: f32 = ${TREE_CELL_SIZE.toFixed(1)};
const TREE_MAX_PER_CELL: u32 = ${TREE_MAX_PER_CELL}u;
const TREE_CLUSTER_PROB: f32 = ${TREE_CLUSTER_PROBABILITY.toFixed(4)};
const TREE_JITTER_SCALE: f32 = ${TREE_JITTER_SCALE.toFixed(3)};
const TREE_DENSITY_SCALE: f32 = ${TREE_DENSITY_SCALE.toFixed(3)};
const ACTIVE_TREE_FLAG: u32 = 1u;

${assetSelectionWGSL}

struct BakeParams {
    planetOrigin: vec3<f32>,
    planetRadius: f32,
    heightScale: f32,
    faceSize: f32,
    seed: u32,
    tileCount: u32,
    _pad0: u32,
    _pad1: u32,
}

struct BakeTile {
    face: u32,
    depth: u32,
    tileX: u32,
    tileY: u32,
    layer: u32,
    flags: u32,
    _pad0: u32,
    _pad1: u32,
}

struct AssetInstance {
    posX: f32, posY: f32, posZ: f32, rotation: f32,
    width: f32, height: f32,
    tileTypeId: u32, bandIndex: u32,
    colorR: f32, colorG: f32, colorB: f32, colorA: f32,
    surfaceNX: f32, surfaceNY: f32, surfaceNZ: f32, _pad0: f32,
}

struct TileData {
    face: u32,
    depth: u32,
    tileX: u32,
    tileY: u32,
    layer: u32,
    tileUMin: f32,
    tileVMin: f32,
    tileUVSize: f32,
    treeCellMinX: i32,
    treeCellMinY: i32,
    treeCellCountX: u32,
    treeCellCountY: u32,
    totalTreeCandidates: u32,
    treeCellScale: f32,
    shouldProcess: u32,
}

var<workgroup> td: TileData;

@group(0) @binding(0) var<uniform> params: BakeParams;
@group(0) @binding(1) var<storage, read> bakeTiles: array<BakeTile>;
@group(0) @binding(2) var<storage, read_write> bakedInstances: array<AssetInstance>;
@group(0) @binding(3) var<storage, read_write> layerCounters: array<atomic<u32>>;
@group(0) @binding(4) var heightTex: texture_2d_array<f32>;
@group(0) @binding(5) var tileTex: texture_2d_array<f32>;
@group(0) @binding(6) var scatterTex: texture_2d_array<f32>;
@group(0) @binding(7) var<storage, read> assetDefs: array<f32>;
@group(0) @binding(8) var<storage, read> tileAssetMap: array<u32>;
@group(0) @binding(9) var<uniform> assetConfig: AssetSelectionConfig;

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

fn getCubePoint(face: u32, u: f32, v: f32) -> vec3<f32> {
    let s = u * 2.0 - 1.0;
    let t = v * 2.0 - 1.0;
    switch (face) {
        case 0u { return vec3<f32>(1.0, t, -s); }
        case 1u { return vec3<f32>(-1.0, t, s); }
        case 2u { return vec3<f32>(s, 1.0, -t); }
        case 3u { return vec3<f32>(s, -1.0, t); }
        case 4u { return vec3<f32>(s, t, 1.0); }
        default { return vec3<f32>(-s, t, -1.0); }
    }
}

fn sampleTreeEligibility(texUv: vec2<f32>, layer: i32) -> f32 {
    let sSize = vec2<i32>(textureDimensions(scatterTex));
    let sCoord = clamp(
        vec2<i32>(texUv * vec2<f32>(sSize)),
        vec2<i32>(0),
        sSize - vec2<i32>(1)
    );
    return textureLoad(scatterTex, sCoord, layer, 0).r;
}

fn sampleHeightAtUV(texUv: vec2<f32>, layer: i32) -> f32 {
    let hSize = vec2<i32>(textureDimensions(heightTex));
    let hCoord = clamp(
        vec2<i32>(texUv * vec2<f32>(hSize)),
        vec2<i32>(0),
        hSize - vec2<i32>(1)
    );
    return textureLoad(heightTex, hCoord, layer, 0).r;
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn main(
    @builtin(workgroup_id) workgroupId: vec3<u32>,
    @builtin(local_invocation_index) threadIdx: u32
) {
    if (workgroupId.x >= params.tileCount) { return; }

    if (threadIdx == 0u) {
        let tile = bakeTiles[workgroupId.x];
        td.face = tile.face;
        td.depth = tile.depth;
        td.tileX = tile.tileX;
        td.tileY = tile.tileY;
        td.layer = tile.layer;
        td.shouldProcess = 0u;

        atomicStore(&layerCounters[td.layer], 0u);

        if ((tile.flags & ACTIVE_TREE_FLAG) != 0u) {
            let gridSize = f32(1u << td.depth);
            td.tileUMin = f32(td.tileX) / gridSize;
            td.tileVMin = f32(td.tileY) / gridSize;
            td.tileUVSize = 1.0 / gridSize;

            let uMax = td.tileUMin + td.tileUVSize;
            let vMax = td.tileVMin + td.tileUVSize;
            let treeCellScale = params.faceSize / TREE_CELL_SIZE;
            let tcMinX = i32(floor(td.tileUMin * treeCellScale));
            let tcMinY = i32(floor(td.tileVMin * treeCellScale));
            let tcMaxX = i32(ceil(uMax * treeCellScale));
            let tcMaxY = i32(ceil(vMax * treeCellScale));

            td.treeCellScale = treeCellScale;
            td.treeCellMinX = tcMinX;
            td.treeCellMinY = tcMinY;
            td.treeCellCountX = u32(max(tcMaxX - tcMinX, 0));
            td.treeCellCountY = u32(max(tcMaxY - tcMinY, 0));
            td.totalTreeCandidates = td.treeCellCountX * td.treeCellCountY * TREE_MAX_PER_CELL;
            td.shouldProcess = select(0u, 1u, td.totalTreeCandidates > 0u);
        }
    }

    workgroupBarrier();
    if (td.shouldProcess == 0u) { return; }

    let layerBase = td.layer * PER_LAYER_CAPACITY;
    for (var treeIdx = threadIdx; treeIdx < td.totalTreeCandidates; treeIdx += WORKGROUP_SIZE) {
        let cellLinear = treeIdx / TREE_MAX_PER_CELL;
        let subIdx = treeIdx % TREE_MAX_PER_CELL;

        let localX = cellLinear % td.treeCellCountX;
        let localY = cellLinear / td.treeCellCountX;
        if (localY >= td.treeCellCountY) { continue; }

        let tcX = td.treeCellMinX + i32(localX);
        let tcY = td.treeCellMinY + i32(localY);

        let cellSeed = pcg4(
            u32(tcX + 100000),
            u32(tcY + 100000),
            td.face,
            params.seed
        );
        let clusterRoll = pcgF(cellSeed);
        if (clusterRoll > TREE_CLUSTER_PROB) { continue; }

        let treeCountHash = pcg2(cellSeed, 1u);
        let treeCount = 1u + (treeCountHash % TREE_MAX_PER_CELL);
        if (subIdx >= treeCount) { continue; }

        let subSeed = pcg3(cellSeed, subIdx, 42u);
        let grid = select(1u, 2u, treeCount > 1u);
        let subX = subIdx % grid;
        let subY = subIdx / grid;
        let baseOff = (vec2<f32>(f32(subX) + 0.5, f32(subY) + 0.5) / f32(grid)) - vec2<f32>(0.5);
        let jitter = (pcg2F(subSeed) - vec2<f32>(0.5)) * (TREE_JITTER_SCALE / f32(grid));
        let off = baseOff + jitter;
        let faceU = (f32(tcX) + 0.5 + off.x) / td.treeCellScale;
        let faceV = (f32(tcY) + 0.5 + off.y) / td.treeCellScale;

        let uMax = td.tileUMin + td.tileUVSize;
        let vMax = td.tileVMin + td.tileUVSize;
        if (faceU < td.tileUMin || faceU >= uMax || faceV < td.tileVMin || faceV >= vMax) {
            continue;
        }

        let relU = (faceU - td.tileUMin) / td.tileUVSize;
        let relV = (faceV - td.tileVMin) / td.tileUVSize;
        let texUv = vec2<f32>(relU, relV);

        let elig = sampleTreeEligibility(texUv, i32(td.layer));
        if (elig < 0.1) { continue; }

        let scaledElig = min(1.0, elig * TREE_DENSITY_SCALE);
        let densityRoll = pcgF(pcg2(subSeed, 3u));
        if (densityRoll > scaledElig) { continue; }

        let heightVal = sampleHeightAtUV(texUv, i32(td.layer));

        let tSize = vec2<i32>(textureDimensions(tileTex));
        let tCoord = clamp(
            vec2<i32>(texUv * vec2<f32>(tSize)),
            vec2<i32>(0),
            tSize - vec2<i32>(1)
        );
        let tileSample = textureLoad(tileTex, tCoord, i32(td.layer), 0);
        let rawTile = tileSample.r;
        let tileIdF = select(rawTile * 255.0, rawTile, rawTile > 1.0);
        let tileId = u32(tileIdF + 0.5);

        let rawAssetIdx = selectAsset(
            &assetDefs,
            &tileAssetMap,
            tileId,
            assetConfig.maxTileType,
            0.5,
            0.5,
            0.5,
            0.1,
            pcgF(subSeed ^ 0x9E3779B9u)
        );

        var def: AssetDef;
        var assetIdx: u32 = 0u;
        if (rawAssetIdx != 0xFFFFFFFFu) {
            assetIdx = rawAssetIdx;
            def = loadAssetDef(&assetDefs, rawAssetIdx);
        } else {
            def = loadAssetDef(&assetDefs, 0u);
        }

        let cubePoint = getCubePoint(td.face, faceU, faceV);
        let sphereDir = normalize(cubePoint);
        let radius = params.planetRadius + heightVal * params.heightScale;
        let worldPos = params.planetOrigin + sphereDir * radius;

        let idx = atomicAdd(&layerCounters[td.layer], 1u);
        if (idx >= PER_LAYER_CAPACITY) { continue; }

        let rot = pcgF(subSeed ^ 0xA341316Cu) * 6.2831853;
        let sw = pcgF(subSeed ^ 0xC8013EA4u);
        let sh = pcgF(subSeed ^ 0xAD90777Du);
        let w = mix(def.widthMin, def.widthMax, sw);
        let h = mix(def.heightMin, def.heightMax, sh);
        let cj = pcgF(subSeed ^ 0x7E95761Eu);
        let col = mix(def.baseColor, def.tipColor, cj);

        let sourceHash = pcg3(cellSeed, subIdx, 0x31415926u);

        bakedInstances[layerBase + idx] = AssetInstance(
            worldPos.x, worldPos.y, worldPos.z,
            rot, w, h,
            assetIdx, 0u,
            col.x, col.y, col.z, 1.0,
            sphereDir.x, sphereDir.y, sphereDir.z, bitcast<f32>(sourceHash)
        );
    }
}
`;
}
