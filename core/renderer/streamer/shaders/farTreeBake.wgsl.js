export function buildFarTreeBakeShader(config = {}) {
    const WORKGROUP_SIZE = Math.max(1, config.workgroupSize ?? 64);
    const PER_LAYER_CAPACITY = Math.max(1, config.perLayerCapacity ?? 128);
    const TREE_CELL_SIZE = Number(config.treeCellSize ?? 16.0);
    const TREE_MAX_PER_CELL = Math.max(1, config.treeMaxPerCell ?? 4);
    const TREE_CLUSTER_PROBABILITY = Number(config.treeClusterProbability ?? 0.95);
    const TREE_JITTER_SCALE = Number(config.treeJitterScale ?? 0.85);
    const TREE_DENSITY_SCALE = Number(config.treeDensityScale ?? 1.0);
    const ASSET_DEF_FLOATS = Math.max(1, config.assetDefFloats ?? 16);

    return /* wgsl */`
struct BakeParams {
    planetOriginX: f32,
    planetOriginY: f32,
    planetOriginZ: f32,
    planetRadius:  f32,

    heightScale: f32,
    faceSize:    f32,
    seed:        u32,
    batchCount:  u32,
};

struct TileJob {
    face:  u32,
    depth: u32,
    tileX: u32,
    tileY: u32,
    layer: u32,
    flags: u32,
    _pad0: u32,
    _pad1: u32,
};

// Coarse far-tree baked record.
// Keep this compact but expressive enough for later far gather/render.
// 16 floats / 64 bytes.
struct FarTreeInstance {
    worldPosX: f32,
    worldPosY: f32,
    worldPosZ: f32,
    rotation:  f32,

    canopyCenterX: f32,
    canopyCenterY: f32,
    canopyCenterZ: f32,
    packedCount:   f32,

    canopyExtentX: f32,
    canopyExtentY: f32,
    canopyExtentZ: f32,
    scale:         f32,

    foliageR: f32,
    foliageG: f32,
    foliageB: f32,
    seedF:    f32,
};

struct AssetSelectionConfig {
    maxAssetCount: u32,
    maxTileType:   u32,
    _pad0:         u32,
    _pad1:         u32,
};

@group(0) @binding(0) var<uniform> params: BakeParams;
@group(0) @binding(1) var<storage, read> tileJobs: array<TileJob>;
@group(0) @binding(2) var<storage, read_write> outInstances: array<FarTreeInstance>;
@group(0) @binding(3) var<storage, read_write> outCounters: array<atomic<u32>>;

@group(0) @binding(4) var heightTex: texture_2d_array<f32>;
@group(0) @binding(5) var tileTex: texture_2d_array<f32>;
@group(0) @binding(6) var scatterTex: texture_2d_array<f32>;

@group(0) @binding(7) var<storage, read> assetDefs: array<f32>;
@group(0) @binding(8) var<storage, read> treeTileMap: array<u32>;
@group(0) @binding(9) var<uniform> selectionCfg: AssetSelectionConfig;

const PI: f32 = 3.141592653589793;
const TWO_PI: f32 = 6.283185307179586;
const PER_LAYER_CAPACITY_U32: u32 = ${PER_LAYER_CAPACITY}u;
const TREE_CELL_SIZE_M: f32 = ${TREE_CELL_SIZE};
const TREE_MAX_PER_CELL_U32: u32 = ${TREE_MAX_PER_CELL}u;
const TREE_CLUSTER_PROBABILITY_F: f32 = ${TREE_CLUSTER_PROBABILITY};
const TREE_JITTER_SCALE_F: f32 = ${TREE_JITTER_SCALE};
const TREE_DENSITY_SCALE_F: f32 = ${TREE_DENSITY_SCALE};
const ASSET_DEF_FLOATS_U32: u32 = ${ASSET_DEF_FLOATS}u;

// Assumed asset-def layout pieces used here:
//   [0] category
//   [1] geometryType
//   [2..6] lodDistances
//   [7..11] densities
//   [12..14] tint / color-ish fallback
// This is only a coarse baker, so we use a tiny subset.
fn assetDefBase(assetIndex: u32) -> u32 {
    return assetIndex * ASSET_DEF_FLOATS_U32;
}

fn assetDensity(assetIndex: u32) -> f32 {
    let b = assetDefBase(assetIndex);
    // Use lod0 density as a coarse source density proxy.
    return max(assetDefs[b + 7u], 0.0);
}

fn assetColor(assetIndex: u32) -> vec3<f32> {
    let b = assetDefBase(assetIndex);
    return vec3<f32>(
        clamp(assetDefs[b + 12u], 0.0, 1.0),
        clamp(assetDefs[b + 13u], 0.0, 1.0),
        clamp(assetDefs[b + 14u], 0.0, 1.0)
    );
}

fn pcg(v: u32) -> u32 {
    var s = v * 747796405u + 2891336453u;
    let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
    return (w >> 22u) ^ w;
}

fn rand01(seed: u32) -> f32 {
    return f32(pcg(seed)) / 4294967296.0;
}

fn hash2(a: u32, b: u32) -> u32 {
    return pcg(a ^ (b * 0x9E3779B9u));
}

fn hash4(a: u32, b: u32, c: u32, d: u32) -> u32 {
    return pcg(a ^ (b * 0x9E3779B9u) ^ (c * 0x85EBCA6Bu) ^ (d * 0xC2B2AE35u));
}

fn cubeFaceDir(face: u32, uv: vec2<f32>) -> vec3<f32> {
    let x = uv.x;
    let y = uv.y;

    switch face {
        case 0u: { return normalize(vec3<f32>( 1.0,  y, -x)); } // +X
        case 1u: { return normalize(vec3<f32>(-1.0,  y,  x)); } // -X
        case 2u: { return normalize(vec3<f32>( x,  1.0, -y)); } // +Y
        case 3u: { return normalize(vec3<f32>( x, -1.0,  y)); } // -Y
        case 4u: { return normalize(vec3<f32>( x,  y,  1.0)); } // +Z
        default: { return normalize(vec3<f32>(-x,  y, -1.0)); } // -Z
    }
}

fn tileWorldSize(depth: u32, faceSize: f32) -> f32 {
    return faceSize / f32(1u << depth);
}

fn tileOriginUV(tileX: u32, tileY: u32, depth: u32) -> vec2<f32> {
    let scale = 1.0 / f32(1u << depth);
    return vec2<f32>(f32(tileX), f32(tileY)) * scale;
}

fn tileSampleUV(tileOrigin: vec2<f32>, depth: u32, local01: vec2<f32>) -> vec2<f32> {
    let scale = 1.0 / f32(1u << depth);
    return tileOrigin + local01 * scale;
}

fn uv01ToCubeUV(uv01: vec2<f32>) -> vec2<f32> {
    return uv01 * 2.0 - 1.0;
}

fn sampleHeight(layer: i32, uv01: vec2<f32>) -> f32 {
    let dims = textureDimensions(heightTex);
    let px = vec2<i32>(
        clamp(i32(uv01.x * f32(dims.x)), 0, i32(dims.x) - 1),
        clamp(i32(uv01.y * f32(dims.y)), 0, i32(dims.y) - 1)
    );
    return textureLoad(heightTex, px, layer, 0).x;
}

fn sampleTileType(layer: i32, uv01: vec2<f32>) -> u32 {
    let dims = textureDimensions(tileTex);
    let px = vec2<i32>(
        clamp(i32(uv01.x * f32(dims.x)), 0, i32(dims.x) - 1),
        clamp(i32(uv01.y * f32(dims.y)), 0, i32(dims.y) - 1)
    );
    return u32(round(textureLoad(tileTex, px, layer, 0).x));
}

fn sampleScatter(layer: i32, uv01: vec2<f32>) -> f32 {
    let dims = textureDimensions(scatterTex);
    let px = vec2<i32>(
        clamp(i32(uv01.x * f32(dims.x)), 0, i32(dims.x) - 1),
        clamp(i32(uv01.y * f32(dims.y)), 0, i32(dims.y) - 1)
    );
    return textureLoad(scatterTex, px, layer, 0).x;
}

fn chooseTreeAsset(tileType: u32, seed: u32) -> u32 {
    if (tileType >= selectionCfg.maxTileType) {
        return 0xFFFFFFFFu;
    }

    let start = tileType * selectionCfg.maxAssetCount;
    let count = treeTileMap[start];
    if (count == 0u) {
        return 0xFFFFFFFFu;
    }

    let pick = pcg(seed) % count;
    return treeTileMap[start + 1u + pick];
}

fn estimateCanopy(assetIndex: u32, h: f32, seed: u32) -> vec4<f32> {
    let r0 = rand01(seed ^ 0x11111111u);
    let r1 = rand01(seed ^ 0x22222222u);
    let r2 = rand01(seed ^ 0x33333333u);

    // Very coarse generic canopy estimate.
    // Later this can become species-aware.
    let scale = mix(0.85, 1.25, r0);
    let extentXZ = mix(1.8, 3.8, r1) * scale;
    let extentY  = mix(3.0, 6.5, r2) * scale;

    // Center is above the ground around trunk top / crown mid.
    let centerY = h + extentY * 0.72;

    return vec4<f32>(extentXZ, extentY, extentXZ, centerY);
}

fn writeFarInstance(slot: u32, worldPos: vec3<f32>, rotation: f32, canopy: vec4<f32>, color: vec3<f32>, seed: u32) {
    outInstances[slot].worldPosX = worldPos.x;
    outInstances[slot].worldPosY = worldPos.y;
    outInstances[slot].worldPosZ = worldPos.z;
    outInstances[slot].rotation  = rotation;

    outInstances[slot].canopyCenterX = 0.0;
    outInstances[slot].canopyCenterY = canopy.w;
    outInstances[slot].canopyCenterZ = 0.0;
    outInstances[slot].packedCount   = 4.0;

    outInstances[slot].canopyExtentX = canopy.x;
    outInstances[slot].canopyExtentY = canopy.y;
    outInstances[slot].canopyExtentZ = canopy.z;
    outInstances[slot].scale         = 1.0;

    outInstances[slot].foliageR = color.x;
    outInstances[slot].foliageG = color.y;
    outInstances[slot].foliageB = color.z;
    outInstances[slot].seedF    = bitcast<f32>(seed);
}

@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let batchIndex = gid.x;
    if (batchIndex >= params.batchCount) {
        return;
    }

    let job = tileJobs[batchIndex];
    let layer = job.layer;
    let layerI = i32(layer);

    let worldSize = tileWorldSize(job.depth, params.faceSize);
    let cellsPerAxis = max(1u, u32(ceil(worldSize / TREE_CELL_SIZE_M)));
    let cellCount = cellsPerAxis * cellsPerAxis;
    let tileOrigin = tileOriginUV(job.tileX, job.tileY, job.depth);

    for (var cellIndex = 0u; cellIndex < cellCount; cellIndex++) {
        let cx = cellIndex % cellsPerAxis;
        let cy = cellIndex / cellsPerAxis;

        let cellSeedBase = hash4(params.seed, layer, cx, cy);
        let spawnCountRnd = rand01(cellSeedBase ^ 0xA341316Cu);
        let desiredCount = 1u + u32(floor(spawnCountRnd * f32(TREE_MAX_PER_CELL_U32)));

        for (var k = 0u; k < desiredCount; k++) {
            let seed = hash4(cellSeedBase, k, 0x1234u, 0x5678u);

            let baseLocal = (vec2<f32>(f32(cx), f32(cy)) + 0.5) / f32(cellsPerAxis);
            let jitter = (vec2<f32>(
                rand01(seed ^ 0x10u),
                rand01(seed ^ 0x20u)
            ) - vec2<f32>(0.5, 0.5)) / f32(cellsPerAxis) * TREE_JITTER_SCALE_F;

            let local01 = clamp(baseLocal + jitter, vec2<f32>(0.001), vec2<f32>(0.999));
            let uv01 = tileSampleUV(tileOrigin, job.depth, local01);

            let scatter = sampleScatter(layerI, uv01);
            if (scatter <= 0.001) {
                continue;
            }

            let tileType = sampleTileType(layerI, uv01);
            let assetIndex = chooseTreeAsset(tileType, seed);
            if (assetIndex == 0xFFFFFFFFu) {
                continue;
            }

            let density = assetDensity(assetIndex) * TREE_DENSITY_SCALE_F;
            let accept = density * scatter;
            if (rand01(seed ^ 0xDEADBEEFu) > accept) {
                continue;
            }

            let hNorm = sampleHeight(layerI, uv01);
            let h = hNorm * params.heightScale;

            let cubeUV = uv01ToCubeUV(uv01);
            let upDir = cubeFaceDir(job.face, cubeUV);
            let worldPos = vec3<f32>(
                params.planetOriginX,
                params.planetOriginY,
                params.planetOriginZ
            ) + upDir * (params.planetRadius + h);

            let canopy = estimateCanopy(assetIndex, h, seed);
            let color = assetColor(assetIndex);
            let rotation = rand01(seed ^ 0xCAFEBABEu) * TWO_PI;

            // Optional coarse cluster test. For now this only nudges appearance
            // through packedCount staying 4; later you can vary it per tree.
            if (rand01(seed ^ 0xFACE1234u) > TREE_CLUSTER_PROBABILITY_F) {
                // still write a record, just slightly smaller
                let slot = atomicAdd(&outCounters[layer], 1u);
                if (slot < PER_LAYER_CAPACITY_U32) {
                    let shrunk = vec4<f32>(canopy.x * 0.78, canopy.y * 0.82, canopy.z * 0.78, canopy.w);
                    writeFarInstance(layer * PER_LAYER_CAPACITY_U32 + slot, worldPos, rotation, shrunk, color, seed);
                }
                continue;
            }

            let slot = atomicAdd(&outCounters[layer], 1u);
            if (slot < PER_LAYER_CAPACITY_U32) {
                writeFarInstance(layer * PER_LAYER_CAPACITY_U32 + slot, worldPos, rotation, canopy, color, seed);
            }
        }
    }
}
`;
}

