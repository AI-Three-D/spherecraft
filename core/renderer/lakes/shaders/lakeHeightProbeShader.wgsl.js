// core/renderer/lakes/shaders/lakeHeightProbeShader.wgsl.js
//
// Checkpoint-1 diagnostic (see CODEX_RIVER_LAKE_HANDOFF.md): for a small set
// of arbitrary world-space query points (a lake's center plus a ring of
// rim samples), resolves each to its resident tile via the same hash-table
// walk RiverBedBake uses (see residentTileHeightLookupWgsl.js), then
// bilinearly samples the resident final height texture using the
// terrain renderer's own chunk-local convention
// (terrainChunkVertexShaderBuilder.js's sampleHeightChunkLocal, the
// DEBUG_SAMPLE_FIX path) instead of RiverBedBake's nearest-texel sample.
//
// This is a read-only lookup against already-baked tile data — it does NOT
// invoke calculateTerrainHeight() or any terrain-generation compute pass,
// so it reads the real, final, resident height (post tile-micro-detail,
// post softClampHeight — see advancedTerrainCompute.wgsl.js outputType 4),
// not the pre-tile-detail probe value the old naturalElevationNorm used.
//
// Diagnostic only: not the production lake-height sampler. RiverBedBake's
// own nearest-sample behavior is untouched by this file.

import { buildResidentTileHeightLookupWGSL } from '../../shaders/residentTileHeightLookupWgsl.js';

// Must match LakeHeightProbe.js's RECORD_U32 exactly.
export const LAKE_HEIGHT_PROBE_RECORD_U32 = 24;
export const LAKE_HEIGHT_PROBE_NOT_FOUND_DEPTH = 999;
export const LAKE_HEIGHT_PROBE_NOT_FOUND_LAYER = 0xFFFFFFFF;

export function buildLakeHeightProbeShader() {
    return /* wgsl */`
struct ProbeParams {
    origin:       vec3<f32>,
    heightScale:  f32,
    hashMask:     u32,
    hashCapacity: u32,
    tileTexSize:  u32,
    maxDepth:     u32,
    numQueries:   u32,
    _pad0:        u32,
    _pad1:        u32,
    _pad2:        u32,
}

@group(0) @binding(0) var<uniform>             params:    ProbeParams;
@group(0) @binding(1) var                      heightTex: texture_2d_array<f32>;
@group(0) @binding(2) var<storage, read>       hashTable: array<u32>;
@group(0) @binding(3) var<storage, read>       queryPos:  array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> results:   array<u32>;

const RECORD_U32: u32 = ${LAKE_HEIGHT_PROBE_RECORD_U32}u;
const NOT_FOUND_DEPTH: u32 = ${LAKE_HEIGHT_PROBE_NOT_FOUND_DEPTH}u;
const NOT_FOUND_LAYER: u32 = ${LAKE_HEIGHT_PROBE_NOT_FOUND_LAYER}u;

// hashKey / lookupLayer / dirToFaceUV: shared with RiverBedBake — see
// residentTileHeightLookupWgsl.js.
${buildResidentTileHeightLookupWGSL()}

@compute @workgroup_size(32)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let qi = gid.x;
    if (qi >= params.numQueries) { return; }
    let base = qi * RECORD_U32;

    let worldPos = queryPos[qi].xyz;
    let dir = normalize(worldPos - params.origin);
    let fuv = dirToFaceUV(dir);
    let face = u32(fuv.x);
    let u = clamp(fuv.y, 0.0, 0.999999);
    let v = clamp(fuv.z, 0.0, 0.999999);
    let texSizeI = i32(params.tileTexSize);

    var d = params.maxDepth;
    var found = false;
    var foundTx = 0u; var foundTy = 0u; var foundLayer = -1;
    var lu = 0.0; var lv = 0.0;
    var t00 = 0.0; var t10 = 0.0; var t01 = 0.0; var t11 = 0.0;
    var bilinearHeight = 0.0;
    loop {
        let grid = 1u << d;
        let tx = min(u32(u * f32(grid)), grid - 1u);
        let ty = min(u32(v * f32(grid)), grid - 1u);
        let layer = lookupLayer(face, d, tx, ty);
        if (layer >= 0) {
            let tileSize = 1.0 / f32(grid);
            lu = (u - f32(tx) * tileSize) / tileSize;
            lv = (v - f32(ty) * tileSize) / tileSize;

            // Bilinear, chunk-local convention (matches
            // terrainChunkVertexShaderBuilder.js's sampleHeightChunkLocal /
            // DEBUG_SAMPLE_FIX path): local UV -> texel-space coordinate ->
            // floor/frac -> 4-tap fetch clamped to this tile's own texture
            // bounds -> bilinear mix. RiverBedBake's own main() keeps its
            // separate nearest-texel sample untouched; this is intentionally
            // a distinct sampling path for lake-height diagnosis.
            let coord = vec2<f32>(lu, lv) * f32(texSizeI - 1);
            let baseCoord = floor(coord);
            let f = coord - baseCoord;
            let maxC = texSizeI - 1;
            let c00 = vec2<i32>(baseCoord);
            let c10 = vec2<i32>(min(c00.x + 1, maxC), c00.y);
            let c01 = vec2<i32>(c00.x, min(c00.y + 1, maxC));
            let c11 = vec2<i32>(min(c00.x + 1, maxC), min(c00.y + 1, maxC));
            t00 = textureLoad(heightTex, c00, layer, 0).r;
            t10 = textureLoad(heightTex, c10, layer, 0).r;
            t01 = textureLoad(heightTex, c01, layer, 0).r;
            t11 = textureLoad(heightTex, c11, layer, 0).r;
            let h0 = mix(t00, t10, f.x);
            let h1 = mix(t01, t11, f.x);
            bilinearHeight = mix(h0, h1, f.y);

            found = true;
            foundTx = tx; foundTy = ty; foundLayer = layer;
            break;
        }
        if (d == 0u) { break; }
        d = d - 1u;
    }

    results[base + 0u]  = bitcast<u32>(worldPos.x);
    results[base + 1u]  = bitcast<u32>(worldPos.y);
    results[base + 2u]  = bitcast<u32>(worldPos.z);
    results[base + 3u]  = bitcast<u32>(dir.x);
    results[base + 4u]  = bitcast<u32>(dir.y);
    results[base + 5u]  = bitcast<u32>(dir.z);
    results[base + 6u]  = face;
    results[base + 7u]  = bitcast<u32>(u);
    results[base + 8u]  = bitcast<u32>(v);
    results[base + 9u]  = select(NOT_FOUND_DEPTH, d, found);
    results[base + 10u] = foundTx;
    results[base + 11u] = foundTy;
    results[base + 12u] = select(NOT_FOUND_LAYER, u32(foundLayer), found);
    results[base + 13u] = bitcast<u32>(lu);
    results[base + 14u] = bitcast<u32>(lv);
    results[base + 15u] = bitcast<u32>(t00);
    results[base + 16u] = bitcast<u32>(t10);
    results[base + 17u] = bitcast<u32>(t01);
    results[base + 18u] = bitcast<u32>(t11);
    results[base + 19u] = bitcast<u32>(bilinearHeight);
    results[base + 20u] = bitcast<u32>(bilinearHeight * params.heightScale);
    results[base + 21u] = select(0u, 1u, found);
    results[base + 22u] = 0u;
    results[base + 23u] = 0u;
}
`;
}
