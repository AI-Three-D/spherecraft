// js/renderer/streamer/shaders/groundFieldBake.wgsl.js
//
// Compact per-tile ground-field bake. This is the first persistent dense
// ground-cover product: instead of baking explicit instances, we bake a
// small suitability field per tile layer. Density comes from the terrain
// climate bake's vegetation-suitability channel, while the spare channels pack
// temperature/precipitation for later field-instance synthesis.

export function buildGroundFieldBakeShader(cfg = {}) {
    const FIELD_RES = Math.max(8, Math.floor(cfg.resolution ?? 32));
    const MAX_BATCH = Math.max(1, Math.floor(cfg.maxBatchSize ?? 8));
    const DENSITY_CHANNELS = Math.max(0, Math.min(2, Math.floor(cfg.densityChannels ?? 2)));

    const densityDecls = [];
    for (let i = 0; i < 2; i++) {
        if (i < DENSITY_CHANNELS) {
            densityDecls.push(`let density${i} = computeChannelDensity(tileId, ${i}u, suitability);`);
        } else {
            densityDecls.push(`let density${i} = 0.0;`);
        }
    }

    return /* wgsl */`
const FIELD_RES: u32 = ${FIELD_RES}u;
const MAX_BATCH: u32 = ${MAX_BATCH}u;

struct BakeParams {
    tileCount: u32,
    tileTypeCount: u32,
    seed: u32,
    _pad0: u32,
}

struct BakeTile {
    face: u32,
    depth: u32,
    tileX: u32,
    tileY: u32,
    layer: u32,
    flags: u32,
    _p0: u32,
    _p1: u32,
}

@group(0) @binding(0) var<uniform> P: BakeParams;
@group(0) @binding(1) var<storage, read> bakeTiles: array<BakeTile, MAX_BATCH>;
@group(0) @binding(2) var<storage, read> channelTileScales: array<f32>;
@group(0) @binding(3) var climateTex: texture_2d_array<f32>;
@group(0) @binding(4) var tileTex: texture_2d_array<f32>;
@group(0) @binding(5) var fieldOut: texture_storage_2d_array<rgba8unorm, write>;

fn sampleClimateSuitability(uv: vec2<f32>, layer: i32) -> f32 {
    let dims = vec2<i32>(textureDimensions(climateTex));
    let maxCoord = dims - vec2<i32>(1);
    let clampedUv = clamp(uv, vec2<f32>(0.0), vec2<f32>(0.999999));
    let pos = clampedUv * vec2<f32>(dims) - vec2<f32>(0.5);
    let base = vec2<i32>(floor(pos));
    let frac = fract(pos);

    let c00 = clamp(base, vec2<i32>(0), maxCoord);
    let c10 = clamp(base + vec2<i32>(1, 0), vec2<i32>(0), maxCoord);
    let c01 = clamp(base + vec2<i32>(0, 1), vec2<i32>(0), maxCoord);
    let c11 = clamp(base + vec2<i32>(1, 1), vec2<i32>(0), maxCoord);

    let s00 = textureLoad(climateTex, c00, layer, 0).b;
    let s10 = textureLoad(climateTex, c10, layer, 0).b;
    let s01 = textureLoad(climateTex, c01, layer, 0).b;
    let s11 = textureLoad(climateTex, c11, layer, 0).b;

    let sx0 = mix(s00, s10, frac.x);
    let sx1 = mix(s01, s11, frac.x);
    return mix(sx0, sx1, frac.y);
}

fn sampleClimate(uv: vec2<f32>, layer: i32) -> vec4<f32> {
    let dims = vec2<i32>(textureDimensions(climateTex));
    let maxCoord = dims - vec2<i32>(1);
    let clampedUv = clamp(uv, vec2<f32>(0.0), vec2<f32>(0.999999));
    let coord = clamp(vec2<i32>(clampedUv * vec2<f32>(dims)), vec2<i32>(0), maxCoord);
    return textureLoad(climateTex, coord, layer, 0);
}

fn sampleTileId(uv: vec2<f32>, layer: i32) -> u32 {
    let dims = vec2<i32>(textureDimensions(tileTex));
    let maxCoord = dims - vec2<i32>(1);
    let clampedUv = clamp(uv, vec2<f32>(0.0), vec2<f32>(0.999999));
    let coord = clamp(vec2<i32>(clampedUv * vec2<f32>(dims)), vec2<i32>(0), maxCoord);
    let raw = textureLoad(tileTex, coord, layer, 0).r;
    let tileIdF = select(raw * 255.0, raw, raw > 1.0);
    return u32(tileIdF + 0.5);
}

fn computeChannelDensity(tileId: u32, channelIdx: u32, suitability: f32) -> f32 {
    if (tileId >= P.tileTypeCount) {
        return 0.0;
    }
    let idx = channelIdx * P.tileTypeCount + tileId;
    let tileScale = channelTileScales[idx];
    if (channelIdx == 0u) {
        // Grass previously used tile/climate selection without an extra
        // vegetation-suitability multiplier in the keep probability path.
        // Keeping full tile support here restores visible ground cover while
        // climate still comes from the packed B/A channels during selection.
        return clamp(tileScale, 0.0, 1.0);
    }
    // Ferns benefit from some climate shaping, but keep a floor so the
    // field path does not collapse to nothing in mildly marginal biomes.
    return clamp(tileScale * max(0.35, suitability), 0.0, 1.0);
}

@compute @workgroup_size(8, 8, 1)
fn bake(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= FIELD_RES || gid.y >= FIELD_RES || gid.z >= P.tileCount) {
        return;
    }

    let tile = bakeTiles[gid.z];
    let layer = i32(tile.layer);
    let outCoord = vec2<i32>(i32(gid.x), i32(gid.y));

    if ((tile.flags & 1u) == 0u) {
        textureStore(fieldOut, outCoord, layer, vec4<f32>(0.0, 0.0, 0.0, 0.0));
        return;
    }

    let uv = (vec2<f32>(f32(gid.x) + 0.5, f32(gid.y) + 0.5) / f32(FIELD_RES));
    let suitability = clamp(sampleClimateSuitability(uv, layer), 0.0, 1.0);
    let tileId = sampleTileId(uv, layer);

    ${densityDecls.join('\n    ')}

    let climate = sampleClimate(uv, layer);

    textureStore(fieldOut, outCoord, layer, vec4<f32>(density0, density1, climate.r, climate.g));
}
`;
}
