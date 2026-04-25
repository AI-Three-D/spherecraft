export function createSplatValidityComputeShader() {
    return /* wgsl */`
@group(0) @binding(0) var splatIndexTexture: texture_2d<f32>;
@group(0) @binding(1) var splatValidityTexture: texture_storage_2d<rgba8unorm, write>;

fn decodeSplatTileId(encoded: f32) -> u32 {
    return u32(floor(encoded * 255.0 + 0.5));
}

fn loadSplatIds(coord: vec2<i32>) -> vec4<u32> {
    let s = textureLoad(splatIndexTexture, coord, 0);
    return vec4<u32>(
        decodeSplatTileId(s.r),
        decodeSplatTileId(s.g),
        decodeSplatTileId(s.b),
        decodeSplatTileId(s.a)
    );
}

fn splatIdSetsMatch(a: vec4<u32>, b: vec4<u32>) -> bool {
    return a.x == b.x && a.y == b.y && a.z == b.z && a.w == b.w;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let texSize = textureDimensions(splatIndexTexture);
    if (global_id.x >= texSize.x || global_id.y >= texSize.y) {
        return;
    }

    let maxCoord = vec2<i32>(texSize) - vec2<i32>(1);
    let c00 = vec2<i32>(global_id.xy);
    let c10 = min(c00 + vec2<i32>(1, 0), maxCoord);
    let c01 = min(c00 + vec2<i32>(0, 1), maxCoord);
    let c11 = min(c00 + vec2<i32>(1, 1), maxCoord);

    let ids00 = loadSplatIds(c00);
    let ids10 = loadSplatIds(c10);
    let ids01 = loadSplatIds(c01);
    let ids11 = loadSplatIds(c11);

    let valid =
        splatIdSetsMatch(ids00, ids10) &&
        splatIdSetsMatch(ids00, ids01) &&
        splatIdSetsMatch(ids00, ids11);

    textureStore(
        splatValidityTexture,
        c00,
        vec4<f32>(select(0.0, 1.0, valid), 0.0, 0.0, 1.0)
    );
}
`;
}
