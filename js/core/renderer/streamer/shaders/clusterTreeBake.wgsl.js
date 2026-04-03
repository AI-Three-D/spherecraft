export function buildClusterTreeBakeShader(config = {}) {
    const WORKGROUP_SIZE = Math.max(32, Math.floor(config.workgroupSize ?? 64));
    const PER_LAYER_CAPACITY = Math.max(1, Math.floor(config.perLayerCapacity ?? 80));
    const TARGET_TREE_DENSITY = config.targetTreeDensity ?? 0.00072;
    const MAX_PACKED_TREES = Math.max(1, Math.floor(config.maxPackedTrees ?? 4));
    const JITTER_SCALE = config.jitterScale ?? 0.72;
    const NEIGHBORHOOD_RADIUS = config.neighborhoodRadius ?? 1.6;
    const GRADIENT_NUDGE = config.gradientNudge ?? 0.08;
    const CANOPY_FOOTPRINT_MIN_SCALE = config.canopyFootprintMinScale ?? 0.90;
    const CANOPY_FOOTPRINT_MAX_SCALE = config.canopyFootprintMaxScale ?? 1.18;
    const GROUP_RADIUS_MIN_FRAC = config.groupRadiusMinFrac ?? 0.18;
    const GROUP_RADIUS_MAX_FRAC = config.groupRadiusMaxFrac ?? 0.38;

    const fmt = (value) => Number(value).toFixed(4);

    return /* wgsl */`
const WORKGROUP_SIZE: u32 = ${WORKGROUP_SIZE}u;
const PER_LAYER_CAPACITY: u32 = ${PER_LAYER_CAPACITY}u;
const TARGET_TREE_DENSITY: f32 = ${fmt(TARGET_TREE_DENSITY)};
const MAX_PACKED_TREES: u32 = ${MAX_PACKED_TREES}u;
const JITTER_SCALE: f32 = ${fmt(JITTER_SCALE)};
const NEIGHBORHOOD_RADIUS: f32 = ${fmt(NEIGHBORHOOD_RADIUS)};
const GRADIENT_NUDGE: f32 = ${fmt(GRADIENT_NUDGE)};
const CANOPY_FOOTPRINT_MIN_SCALE: f32 = ${fmt(CANOPY_FOOTPRINT_MIN_SCALE)};
const CANOPY_FOOTPRINT_MAX_SCALE: f32 = ${fmt(CANOPY_FOOTPRINT_MAX_SCALE)};
const GROUP_RADIUS_MIN_FRAC: f32 = ${fmt(GROUP_RADIUS_MIN_FRAC)};
const GROUP_RADIUS_MAX_FRAC: f32 = ${fmt(GROUP_RADIUS_MAX_FRAC)};

struct BakeParams {
    face: u32,
    depth: u32,
    tileX: u32,
    tileY: u32,

    planetOriginX: f32,
    planetOriginY: f32,
    planetOriginZ: f32,
    planetRadius: f32,

    faceSize: f32,
    heightScale: f32,
    tileWorldSize: f32,
    layerIndex: u32,

    gridDim: u32,
    flags: u32,
    minDensity: f32,
    eligibilityWeight: f32,

    maxAltitude: f32,
    maxSlope: f32,
    heightMin: f32,
    heightMax: f32,

    coniferWidthRatio: f32,
    deciduousWidthRatio: f32,
    _pad0: f32,
    _pad1: f32,
}

struct ClusterTree {
    posX: f32, posY: f32, posZ: f32, rotation: f32,
    footprint: f32, height: f32, coniferFrac: f32, density: f32,
    foliageR: f32, foliageG: f32, foliageB: f32, seed: u32,
    groupRadius: f32, packedCount: f32, _r0: f32, _r1: f32,
}

@group(0) @binding(0) var<uniform> params: BakeParams;
@group(0) @binding(1) var heightTex: texture_2d<f32>;
@group(0) @binding(2) var tileTex: texture_2d<f32>;
@group(0) @binding(3) var scatterTex: texture_2d<f32>;
@group(0) @binding(4) var<storage, read_write> clusterOut: array<ClusterTree>;
@group(0) @binding(5) var<storage, read_write> clusterCount: array<atomic<u32>>;

fn pcg(v: u32) -> u32 {
    var s = v * 747796405u + 2891336453u;
    let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
    return (w >> 22u) ^ w;
}

fn pcgF(v: u32) -> f32 {
    return f32(pcg(v)) / 4294967296.0;
}

fn pcg4(a: u32, b: u32, c: u32, d: u32) -> u32 {
    return pcg(pcg(pcg(a ^ (b * 1664525u + 1013904223u)) ^ (c * 2654435761u)) ^ (d * 374761393u));
}

fn tileSeed() -> u32 {
    return pcg4(params.face, params.depth, params.tileX, params.tileY);
}

fn clampCoord(coord: vec2<i32>, size: vec2<i32>) -> vec2<i32> {
    return clamp(coord, vec2<i32>(0), size - vec2<i32>(1));
}

fn sampleScalarNearest(tex: texture_2d<f32>, uv: vec2<f32>) -> f32 {
    let size = vec2<i32>(textureDimensions(tex));
    let coord = clampCoord(vec2<i32>(uv * vec2<f32>(size)), size);
    return textureLoad(tex, coord, 0).r;
}

fn sampleScalarBilinear(tex: texture_2d<f32>, uv: vec2<f32>) -> f32 {
    let sizeI = vec2<i32>(textureDimensions(tex));
    let size = vec2<f32>(sizeI);
    let texel = clamp(uv * size - vec2<f32>(0.5), vec2<f32>(0.0), size - vec2<f32>(1.0));
    let i0 = vec2<i32>(floor(texel));
    let f = fract(texel);
    let i1 = min(i0 + vec2<i32>(1), sizeI - vec2<i32>(1));

    let v00 = textureLoad(tex, clampCoord(i0, sizeI), 0).r;
    let v10 = textureLoad(tex, clampCoord(vec2<i32>(i1.x, i0.y), sizeI), 0).r;
    let v01 = textureLoad(tex, clampCoord(vec2<i32>(i0.x, i1.y), sizeI), 0).r;
    let v11 = textureLoad(tex, clampCoord(i1, sizeI), 0).r;

    let vx0 = mix(v00, v10, f.x);
    let vx1 = mix(v01, v11, f.x);
    return mix(vx0, vx1, f.y);
}

fn sampleHeight(uv: vec2<f32>) -> f32 {
    return sampleScalarBilinear(heightTex, uv);
}

fn sampleScatterEligibility(uv: vec2<f32>) -> f32 {
    return sampleScalarBilinear(scatterTex, uv);
}

fn sampleScatterNeighborhood(uv: vec2<f32>) -> f32 {
    let texDim = vec2<f32>(textureDimensions(scatterTex));
    let texel = 1.0 / max(texDim, vec2<f32>(1.0));
    var sum = 0.0;
    var taps = 0.0;
    for (var oy: i32 = -1; oy <= 1; oy++) {
        for (var ox: i32 = -1; ox <= 1; ox++) {
            let sampleUv = clamp(
                uv + vec2<f32>(f32(ox), f32(oy)) * texel * NEIGHBORHOOD_RADIUS,
                vec2<f32>(0.001),
                vec2<f32>(0.999)
            );
            sum += sampleScatterEligibility(sampleUv);
            taps += 1.0;
        }
    }
    return sum / max(taps, 1.0);
}

fn sampleScatterGradient(uv: vec2<f32>) -> vec2<f32> {
    let texDim = vec2<f32>(textureDimensions(scatterTex));
    let texel = 1.0 / max(texDim, vec2<f32>(1.0));
    let left = sampleScatterEligibility(clamp(uv - vec2<f32>(texel.x, 0.0), vec2<f32>(0.001), vec2<f32>(0.999)));
    let right = sampleScatterEligibility(clamp(uv + vec2<f32>(texel.x, 0.0), vec2<f32>(0.001), vec2<f32>(0.999)));
    let down = sampleScatterEligibility(clamp(uv - vec2<f32>(0.0, texel.y), vec2<f32>(0.001), vec2<f32>(0.999)));
    let up = sampleScatterEligibility(clamp(uv + vec2<f32>(0.0, texel.y), vec2<f32>(0.001), vec2<f32>(0.999)));
    return vec2<f32>(right - left, up - down);
}

fn sampleTileType(uv: vec2<f32>) -> u32 {
    let raw = sampleScalarNearest(tileTex, uv);
    let tileId = select(raw * 255.0, raw, raw > 1.0);
    return u32(tileId + 0.5);
}

fn computeSlope(uv: vec2<f32>) -> f32 {
    let texDim = vec2<f32>(textureDimensions(heightTex));
    let texel = 1.0 / max(texDim, vec2<f32>(1.0));
    let hC = sampleHeight(uv);
    let hX = sampleHeight(clamp(uv + vec2<f32>(texel.x, 0.0), vec2<f32>(0.001), vec2<f32>(0.999)));
    let hY = sampleHeight(clamp(uv + vec2<f32>(0.0, texel.y), vec2<f32>(0.001), vec2<f32>(0.999)));
    let texelWorld = params.tileWorldSize / max(texDim.x, 1.0);
    let dX = (hX - hC) * params.heightScale / max(texelWorld, 0.001);
    let dY = (hY - hC) * params.heightScale / max(texelWorld, 0.001);
    return length(vec2<f32>(dX, dY));
}

fn getCubePoint(face: u32, fu: f32, fv: f32) -> vec3<f32> {
    let s = fu * 2.0 - 1.0;
    let t = fv * 2.0 - 1.0;
    switch (face) {
        case 0u { return vec3<f32>( 1.0,  t, -s); }
        case 1u { return vec3<f32>(-1.0,  t,  s); }
        case 2u { return vec3<f32>( s,  1.0, -t); }
        case 3u { return vec3<f32>( s, -1.0,  t); }
        case 4u { return vec3<f32>( s,  t,  1.0); }
        default { return vec3<f32>(-s,  t, -1.0); }
    }
}

fn tileUVToWorld(uv: vec2<f32>, heightNorm: f32) -> vec3<f32> {
    let gridSize = f32(1u << params.depth);
    let fu = (f32(params.tileX) + uv.x) / gridSize;
    let fv = (f32(params.tileY) + uv.y) / gridSize;
    let dir = normalize(getCubePoint(params.face, fu, fv));
    let elevation = heightNorm * params.heightScale;
    let origin = vec3<f32>(params.planetOriginX, params.planetOriginY, params.planetOriginZ);
    return origin + dir * (params.planetRadius + elevation);
}

fn isForestTile(tileId: u32) -> bool {
    return (
        (tileId >= 66u && tileId <= 81u) ||
        (tileId >= 142u && tileId <= 149u) ||
        (tileId >= 158u && tileId <= 165u)
    );
}

fn isWetBroadleafTile(tileId: u32) -> bool {
    return (
        (tileId >= 82u && tileId <= 93u) ||
        (tileId >= 142u && tileId <= 149u)
    );
}

fn isSingleForestTile(tileId: u32) -> bool {
    return tileId >= 66u && tileId <= 73u;
}

fn isMixedForestTile(tileId: u32) -> bool {
    return tileId >= 74u && tileId <= 81u;
}

fn isDesertTreeTile(tileId: u32) -> bool {
    return tileId >= 158u && tileId <= 165u;
}

fn tileForestWeight(tileId: u32) -> f32 {
    if (isForestTile(tileId)) { return 1.0; }
    if (tileId >= 82u && tileId <= 93u) { return 0.75; }
    if (tileId >= 10u && tileId <= 29u) { return 0.25; }
    if (tileId >= 94u && tileId <= 117u) { return 0.15; }
    if (tileId >= 54u && tileId <= 65u) { return 0.10; }
    if (tileId >= 30u && tileId <= 41u) { return 0.05; }
    if (tileId >= 150u && tileId <= 157u) { return 0.04; }
    return 0.08;
}

fn estimateConiferFraction(tileId: u32, altitudeNorm: f32) -> f32 {
    var conifer = mix(0.25, 0.75, altitudeNorm);
    if (isWetBroadleafTile(tileId)) {
        conifer = 0.08;
    } else if (isDesertTreeTile(tileId)) {
        conifer = 0.14;
    } else if (isSingleForestTile(tileId)) {
        conifer = mix(0.55, 0.90, altitudeNorm);
    } else if (isMixedForestTile(tileId)) {
        conifer = mix(0.35, 0.68, altitudeNorm);
    } else if (tileId >= 54u && tileId <= 65u) {
        conifer = 0.88;
    }
    return clamp(conifer, 0.02, 0.98);
}

fn estimateFoliage(tileId: u32, coniferFrac: f32, density: f32, seed: u32) -> vec3<f32> {
    let lush = mix(0.35, 0.85, clamp(density, 0.0, 1.0));
    let coniferBase = mix(vec3<f32>(0.05, 0.15, 0.05), vec3<f32>(0.10, 0.24, 0.09), lush);
    let decidBase = mix(vec3<f32>(0.10, 0.22, 0.06), vec3<f32>(0.18, 0.35, 0.12), lush);
    var base = mix(decidBase, coniferBase, coniferFrac);
    if (isWetBroadleafTile(tileId)) {
        base = mix(vec3<f32>(0.10, 0.26, 0.08), vec3<f32>(0.16, 0.38, 0.12), lush);
    } else if (isDesertTreeTile(tileId)) {
        base = mix(vec3<f32>(0.12, 0.20, 0.08), vec3<f32>(0.18, 0.28, 0.12), lush);
    } else if (!isForestTile(tileId)) {
        base = mix(vec3<f32>(0.09, 0.19, 0.06), vec3<f32>(0.15, 0.28, 0.10), lush);
    }
    let colorVar = (pcgF(seed ^ 0x9E3779B9u) - 0.5) * 0.05;
    return vec3<f32>(
        clamp(base.r + colorVar * 0.45, 0.02, 0.32),
        clamp(base.g + colorVar, 0.05, 0.42),
        clamp(base.b + colorVar * 0.30, 0.02, 0.24)
    );
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let cellIndex = gid.x;
    let gridDim = max(params.gridDim, 1u);
    let totalCells = gridDim * gridDim;
    if (cellIndex >= totalCells) { return; }

    let cellX = cellIndex % gridDim;
    let cellY = cellIndex / gridDim;

    let baseSeed = tileSeed();
    let cellSeed = pcg4(baseSeed, cellIndex, 0xC1057EEu, params.flags);

    let jitterX = (pcgF(cellSeed) - 0.5) * JITTER_SCALE;
    let jitterY = (pcgF(pcg(cellSeed)) - 0.5) * JITTER_SCALE;
    let uv = clamp(
        vec2<f32>(
            (f32(cellX) + 0.5 + jitterX) / f32(gridDim),
            (f32(cellY) + 0.5 + jitterY) / f32(gridDim)
        ),
        vec2<f32>(0.01),
        vec2<f32>(0.99)
    );

    let scatterGrad = sampleScatterGradient(uv);
    let uvNudged = clamp(
        uv + scatterGrad * GRADIENT_NUDGE,
        vec2<f32>(0.01),
        vec2<f32>(0.99)
    );

    let densityScatter = sampleScatterNeighborhood(uvNudged);
    if (densityScatter < params.minDensity) { return; }

    let heightNorm = sampleHeight(uvNudged);
    let altitude = heightNorm * params.heightScale;
    if (altitude > params.maxAltitude) { return; }

    let slope = computeSlope(uvNudged);
    if (slope > params.maxSlope) { return; }

    let tileId = sampleTileType(uvNudged);
    let tileWeight = tileForestWeight(tileId);
    let weightedTile = max(0.55, tileWeight);
    let density = densityScatter * mix(1.0, weightedTile, clamp(params.eligibilityWeight, 0.0, 1.0));
    if (density < params.minDensity) { return; }

    let altitudeNorm = clamp(altitude / max(params.maxAltitude, 1.0), 0.0, 1.0);
    let coniferFrac = estimateConiferFraction(tileId, altitudeNorm);

    let heightBase = mix(params.heightMax, params.heightMin, altitudeNorm * 0.55);
    let heightVar = mix(0.90, 1.20, pcgF(pcg4(cellSeed, 2u, 0u, 0u)));
    let treeHeight = heightBase * heightVar;

    let widthRatio = mix(params.deciduousWidthRatio, params.coniferWidthRatio, coniferFrac);
    let treeWidth = treeHeight * widthRatio;

    let cellWorldSize = params.tileWorldSize / f32(gridDim);
    let footprint = clamp(
        treeWidth * mix(CANOPY_FOOTPRINT_MIN_SCALE, CANOPY_FOOTPRINT_MAX_SCALE, density),
        treeWidth * 0.78,
        treeWidth * 1.35
    );
    let expectedTrees = cellWorldSize * cellWorldSize * TARGET_TREE_DENSITY * mix(0.45, 1.25, density);
    let packedCount = clamp(u32(floor(expectedTrees + 0.5)), 1u, MAX_PACKED_TREES);
    let packT = f32(packedCount - 1u) / max(f32(MAX_PACKED_TREES - 1u), 1.0);
    let desiredGroupRadius = cellWorldSize * mix(GROUP_RADIUS_MIN_FRAC, GROUP_RADIUS_MAX_FRAC, density);
    // All packed trees share the same sampled ground point. If they spread
    // too far across a sloped cell, the outer trees visibly float. Keep the
    // spread tied to canopy size, not the whole cell footprint.
    let groundedGroupRadius = footprint * mix(0.35, 1.05, packT);
    let groupRadius = select(
        0.0,
        clamp(
            min(desiredGroupRadius, groundedGroupRadius),
            footprint * 0.25,
            footprint * 1.10
        ),
        packedCount > 1u
    );

    let worldPos = tileUVToWorld(uvNudged, heightNorm);
    let rotation = pcgF(pcg4(cellSeed, 4u, 0u, 0u)) * 6.2831853;
    let foliage = estimateFoliage(tileId, coniferFrac, density, cellSeed);

    let slot = atomicAdd(&clusterCount[params.layerIndex], 1u);
    if (slot >= PER_LAYER_CAPACITY) { return; }

    let outBase = params.layerIndex * PER_LAYER_CAPACITY;
    clusterOut[outBase + slot] = ClusterTree(
        worldPos.x, worldPos.y, worldPos.z, rotation,
        footprint, treeHeight, coniferFrac, density,
        foliage.r, foliage.g, foliage.b, cellSeed,
        groupRadius, f32(packedCount), 0.0, 0.0
    );
}
`;
}
