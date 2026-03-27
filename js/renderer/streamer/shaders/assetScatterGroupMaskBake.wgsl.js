// js/renderer/streamer/shaders/assetScatterGroupMaskBake.wgsl.js
//
// Bake conservative non-tree scatter-group eligibility per streamed tile layer.
// One workgroup handles one committed array layer and ORs together the
// per-tile-type group bits across the full tile texture footprint.

export function buildAssetScatterGroupMaskBakeShader(config = {}) {
    const WORKGROUP_SIZE = Math.max(1, Math.floor(config.workgroupSize ?? 64));

    return /* wgsl */`
const WORKGROUP_SIZE: u32 = ${WORKGROUP_SIZE}u;

struct BakeConfig {
    pendingCount: u32,
    maxTileType: u32,
    _pad0: u32,
    _pad1: u32,
}

@group(0) @binding(0) var tileTex: texture_2d_array<f32>;
@group(0) @binding(1) var<storage, read> pendingLayers: array<u32>;
@group(0) @binding(2) var<uniform> bakeConfig: BakeConfig;
@group(0) @binding(3) var<storage, read> tileTypeGroupMasks: array<u32>;
@group(0) @binding(4) var<storage, read> layerPolicyMasks: array<u32>;
@group(0) @binding(5) var<storage, read_write> layerGroupMasks: array<u32>;

var<workgroup> partialMasks: array<u32, WORKGROUP_SIZE>;

@compute @workgroup_size(${WORKGROUP_SIZE}, 1, 1)
fn main(
    @builtin(workgroup_id) wgId: vec3<u32>,
    @builtin(local_invocation_index) threadIdx: u32
) {
    if (wgId.x >= bakeConfig.pendingCount) { return; }

    let layer = pendingLayers[wgId.x];
    let dims = textureDimensions(tileTex);
    let totalTexels = dims.x * dims.y;

    var localMask: u32 = 0u;
    for (var linearIdx: u32 = threadIdx; linearIdx < totalTexels; linearIdx += WORKGROUP_SIZE) {
        let texX = linearIdx % dims.x;
        let texY = linearIdx / dims.x;
        let raw = textureLoad(tileTex, vec2<i32>(i32(texX), i32(texY)), i32(layer), 0).r;
        let tileIdF = select(raw * 255.0, raw, raw > 1.0);
        let tileId = u32(tileIdF + 0.5);
        if (tileId <= bakeConfig.maxTileType) {
            localMask = localMask | tileTypeGroupMasks[tileId];
        }
    }

    partialMasks[threadIdx] = localMask;
    workgroupBarrier();

    var stride = WORKGROUP_SIZE >> 1u;
    loop {
        if (stride == 0u) { break; }
        if (threadIdx < stride) {
            partialMasks[threadIdx] = partialMasks[threadIdx] | partialMasks[threadIdx + stride];
        }
        workgroupBarrier();
        stride = stride >> 1u;
    }

    if (threadIdx == 0u) {
        layerGroupMasks[layer] = partialMasks[0] & layerPolicyMasks[layer];
    }
}
`;
}
