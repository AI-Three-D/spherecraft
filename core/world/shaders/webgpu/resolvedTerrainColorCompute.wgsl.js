export function createResolvedTerrainColorComputeShader() {
    return /* wgsl */`
struct Uniforms {
    chunkCoord: vec2<i32>,
    chunkSize: i32,
    chunkGridSize: i32,

    seed: i32,
    face: i32,
    season: i32,
    _pad0: i32,

    worldScale: f32,
    _pad1: f32,
    _pad2: f32,
    _pad3: f32,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var outputColor: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var splatDataMap: texture_2d<f32>;
@group(0) @binding(3) var splatIndexMap: texture_2d<f32>;
@group(0) @binding(4) var tileMap: texture_2d<f32>;
@group(0) @binding(5) var atlasTexture: texture_2d_array<f32>;
@group(0) @binding(6) var tileTypeLookup: texture_2d<f32>;
@group(0) @binding(7) var atlasSampler: sampler;

const RESOLVED_ATLAS_SAMPLE_LOD: f32 = 1.0;

fn hash12(p: vec2<f32>) -> f32 {
    var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
    p3 = p3 + dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

fn decodeTileId(encoded: f32) -> f32 {
    return f32(i32(floor(encoded * 255.0 + 0.5)));
}

fn loadTileMapId(coord: vec2<i32>) -> f32 {
    return decodeTileId(textureLoad(tileMap, coord, 0).r);
}

fn textureLookupRow(tileId: f32, rowCount: i32) -> i32 {
    return clamp(i32(round(tileId)), 0, max(rowCount - 1, 0));
}

fn lookupTileLayer(tileId: f32, season: i32) -> i32 {
    let lookupSize = vec2<i32>(textureDimensions(tileTypeLookup));
    let maxVariants = max(lookupSize.x / 4, 1);
    let x = (season * maxVariants) % lookupSize.x;
    let y = textureLookupRow(tileId, lookupSize.y);
    let sample = textureLoad(tileTypeLookup, vec2<i32>(x, y), 0);
    return i32(round(sample.r));
}

fn calculateRotationQuarter(worldTileCoord: vec2<f32>, tileId: f32, season: i32, seed: f32) -> i32 {
    let h = hash12(worldTileCoord + vec2<f32>(tileId * 0.17, seed + f32(season) * 0.19));
    return clamp(i32(floor(h * 4.0)), 0, 3);
}

fn rotateUVQuarter(uv: vec2<f32>, quarterTurn: i32) -> vec2<f32> {
    if (quarterTurn == 1) {
        return vec2<f32>(1.0 - uv.y, uv.x);
    }
    if (quarterTurn == 2) {
        return vec2<f32>(1.0 - uv.x, 1.0 - uv.y);
    }
    if (quarterTurn == 3) {
        return vec2<f32>(uv.y, 1.0 - uv.x);
    }
    return uv;
}

fn sampleTileColor(tileId: f32, worldTileCoord: vec2<f32>, localUV: vec2<f32>, season: i32) -> vec3<f32> {
    let atlasLayer = lookupTileLayer(tileId, season);
    let r = calculateRotationQuarter(worldTileCoord, tileId, season, 9547.0);
    let rotatedLocal = rotateUVQuarter(localUV, r);
    return textureSampleLevel(atlasTexture, atlasSampler, rotatedLocal, atlasLayer, RESOLVED_ATLAS_SAMPLE_LOD).rgb;
}

fn splatChannelUsable(tileId: f32, weight: f32) -> bool {
    return tileId >= 0.0 && tileId < 255.0 && weight > 0.03;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let dims = textureDimensions(outputColor);
    if (global_id.x >= dims.x || global_id.y >= dims.y) {
        return;
    }

    let coord = vec2<i32>(global_id.xy);
    let texelUV = (vec2<f32>(global_id.xy) + vec2<f32>(0.5)) / vec2<f32>(dims);
    let faceUV = (vec2<f32>(uniforms.chunkCoord) + texelUV) / max(f32(uniforms.chunkGridSize), 1.0);
    let worldPos = faceUV * max(uniforms.worldScale, 1.0) * 2.0;
    let worldTileCoord = floor(worldPos);
    let localUV = fract(worldPos);
    let season = clamp(uniforms.season, 0, 3);

    let weights = clamp(textureLoad(splatDataMap, coord, 0), vec4<f32>(0.0), vec4<f32>(1.0));
    let encodedIds = textureLoad(splatIndexMap, coord, 0);
    let ids = vec4<f32>(
        decodeTileId(encodedIds.r),
        decodeTileId(encodedIds.g),
        decodeTileId(encodedIds.b),
        decodeTileId(encodedIds.a)
    );

    var color = vec3<f32>(0.0);
    var sum = 0.0;
    if (splatChannelUsable(ids.x, weights.x)) {
        color += sampleTileColor(ids.x, worldTileCoord, localUV, season) * weights.x;
        sum += weights.x;
    }
    if (splatChannelUsable(ids.y, weights.y)) {
        color += sampleTileColor(ids.y, worldTileCoord, localUV, season) * weights.y;
        sum += weights.y;
    }
    if (splatChannelUsable(ids.z, weights.z)) {
        color += sampleTileColor(ids.z, worldTileCoord, localUV, season) * weights.z;
        sum += weights.z;
    }
    if (splatChannelUsable(ids.w, weights.w)) {
        color += sampleTileColor(ids.w, worldTileCoord, localUV, season) * weights.w;
        sum += weights.w;
    }

    if (sum <= 0.0001) {
        let fallbackId = loadTileMapId(coord);
        color = sampleTileColor(fallbackId, worldTileCoord, localUV, season);
    } else {
        color = color / sum;
    }

    textureStore(outputColor, coord, vec4<f32>(clamp(color, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0));
}
`;
}
