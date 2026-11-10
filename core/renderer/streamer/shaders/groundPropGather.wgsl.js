import { buildAssetSelectionWGSL } from '../AssetSelectionBuffer.js';

export function buildGroundPropGatherShader(config = {}) {
    const WORKGROUP_SIZE = Math.max(32, Math.floor(config.workgroupSize ?? 64));
    const TOTAL_BANDS = Math.max(1, Math.floor(config.totalBands ?? 1));
    const LODS_PER_CATEGORY = Math.max(1, Math.floor(config.lodsPerCategory ?? 5));
    const MAX_SCATTER_DISTANCE = Number.isFinite(config.maxScatterDistance)
        ? config.maxScatterDistance
        : 12000.0;
    const PER_LAYER_CAPACITY = Math.max(1, Math.floor(config.perLayerCapacity ?? 1024));
    const assetSelectionWGSL = buildAssetSelectionWGSL({
        assetDefFloats: config.assetDefFloats,
        lodsPerCategory: LODS_PER_CATEGORY,
    });

    return /* wgsl */`
const WORKGROUP_SIZE: u32 = ${WORKGROUP_SIZE}u;
const BAND_COUNT: u32 = ${TOTAL_BANDS}u;
const LODS_PER_ARCHETYPE: u32 = ${LODS_PER_CATEGORY}u;
const MAX_SCATTER_DISTANCE: f32 = ${MAX_SCATTER_DISTANCE.toFixed(1)};
const PER_LAYER_CAPACITY: u32 = ${PER_LAYER_CAPACITY}u;
const ACTIVE_PROP_FLAG: u32 = 1u;

${assetSelectionWGSL}

struct ScatterParams {
    cameraPosition: vec3<f32>,
    _pad0: f32,
    planetOrigin: vec3<f32>,
    planetRadius: f32,
    heightScale: f32,
    maxDensity: f32,
    faceSize: f32,
    seed: u32,
    time: f32,
    tileCount: u32,
    _pad1: f32,
    _pad2: f32,
    viewProjection: mat4x4<f32>,
}

struct BandMeta {
    baseOffset: u32,
    capacity: u32,
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

struct LayerMeta {
    face: u32,
    depth: u32,
    tileX: u32,
    tileY: u32,
    flags: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
}

struct TileCullData {
    shouldProcess: u32,
    layer: u32,
}

var<workgroup> td: TileCullData;

@group(0) @binding(0) var<uniform> params: ScatterParams;
@group(0) @binding(1) var<storage, read> activeLayers: array<u32>;
@group(0) @binding(2) var<storage, read> layerMeta: array<LayerMeta>;
@group(0) @binding(3) var<storage, read> bakedInstances: array<AssetInstance>;
@group(0) @binding(4) var<storage, read> bakedCounts: array<u32>;
@group(0) @binding(5) var<storage, read_write> instances: array<AssetInstance>;
@group(0) @binding(6) var<storage, read_write> bandCounters: array<atomic<u32>, BAND_COUNT>;
@group(0) @binding(7) var<uniform> bandMeta: array<BandMeta, BAND_COUNT>;
@group(0) @binding(8) var<storage, read> assetDefs: array<f32>;

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

fn isLayerBeyondScatterRange(layerInfo: LayerMeta) -> bool {
    let gridSize = f32(1u << layerInfo.depth);
    let cu = (f32(layerInfo.tileX) + 0.5) / gridSize;
    let cv = (f32(layerInfo.tileY) + 0.5) / gridSize;
    let centerWorld = params.planetOrigin + normalize(getCubePoint(layerInfo.face, cu, cv)) * params.planetRadius;
    let tileDist = length(params.cameraPosition - centerWorld);
    let tileWS = params.faceSize / gridSize;
    let margin = tileWS * 0.75 + 1.8 * params.heightScale;
    return (tileDist - margin) > MAX_SCATTER_DISTANCE;
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn main(
    @builtin(workgroup_id) workgroupId: vec3<u32>,
    @builtin(local_invocation_index) threadIdx: u32
) {
    if (threadIdx == 0u) {
        td.shouldProcess = 0u;
        td.layer = 0u;

        let layer = activeLayers[workgroupId.x];
        let info = layerMeta[layer];
        if ((info.flags & ACTIVE_PROP_FLAG) != 0u && !isLayerBeyondScatterRange(info)) {
            td.layer = layer;
            td.shouldProcess = 1u;
        }
    }

    workgroupBarrier();
    if (td.shouldProcess == 0u) { return; }

    let layer = td.layer;
    let layerBase = layer * PER_LAYER_CAPACITY;
    let instanceCount = min(bakedCounts[layer], PER_LAYER_CAPACITY);

    for (var localIndex = threadIdx; localIndex < instanceCount; localIndex += WORKGROUP_SIZE) {
        var baked = bakedInstances[layerBase + localIndex];
        let dist = distance(params.cameraPosition, vec3<f32>(baked.posX, baked.posY, baked.posZ));
        let def = loadAssetDef(&assetDefs, baked.tileTypeId);
        let lodInfo = getAssetLODInfo(def, dist);
        if (lodInfo.lodLevel == 0xFFFFFFFFu) { continue; }

        let bandInfo = bandMeta[lodInfo.bandIndex];
        let outIdx = atomicAdd(&bandCounters[lodInfo.bandIndex], 1u);
        if (outIdx >= bandInfo.capacity) { continue; }

        let globalIdx = bandInfo.baseOffset + outIdx;
        baked.bandIndex = lodInfo.bandIndex;
        instances[globalIdx] = baked;
    }
}
`;
}
