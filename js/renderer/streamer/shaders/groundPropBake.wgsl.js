import { buildAssetSelectionWGSL } from '../AssetSelectionBuffer.js';

export function buildGroundPropBakeShader(config = {}) {
    const WORKGROUP_SIZE = Math.max(32, Math.floor(config.workgroupSize ?? 64));
    const LODS_PER_CATEGORY = config.lodsPerCategory ?? 5;
    const MAX_SCATTER_TILE_WORLD_SIZE = config.maxScatterTileWorldSize ?? 48;
    const SCATTER_CELL_OVERSAMPLE = Math.max(1, Math.floor(config.scatterCellOversample ?? 1));
    const maxDensity = Number.isFinite(config.maxDensity) ? Math.max(config.maxDensity, 0.000001) : 0.000001;
    const perLayerCapacity = Math.max(1, Math.floor(config.perLayerCapacity ?? 256));
    const densityLutTileCount = Math.max(1, Math.floor(config.densityLutTileCount ?? 1));
    const baseGridRes = Math.max(1,
        Math.ceil(Math.sqrt(maxDensity * MAX_SCATTER_TILE_WORLD_SIZE * MAX_SCATTER_TILE_WORLD_SIZE))
    );
    const FIXED_GRID_RES = baseGridRes * SCATTER_CELL_OVERSAMPLE;
    const MAX_CANDIDATES_PER_TILE = FIXED_GRID_RES * FIXED_GRID_RES * 4;
    const assetSelectionWGSL = buildAssetSelectionWGSL({});

    return /* wgsl */`
const WORKGROUP_SIZE: u32 = ${WORKGROUP_SIZE}u;
const MAX_SCATTER_TILE_WS: f32 = ${MAX_SCATTER_TILE_WORLD_SIZE.toFixed(1)};
const FIXED_GRID_RES: u32 = ${FIXED_GRID_RES}u;
const MAX_CANDIDATES_PER_TILE: u32 = ${MAX_CANDIDATES_PER_TILE}u;
const LODS_PER_ARCHETYPE: u32 = ${LODS_PER_CATEGORY}u;
const PER_LAYER_CAPACITY: u32 = ${perLayerCapacity}u;
const DENSITY_LUT_TILE_COUNT: u32 = ${densityLutTileCount}u;

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
    globalCellScale: f32,
    cellWorldArea: f32,
    gcMinX: i32,
    gcMinY: i32,
    gcStrideX: u32,
    gcStrideY: u32,
    gcCellsX: u32,
    gcCellsY: u32,
    fullCellsX: u32,
    fullCellsY: u32,
    totalCandidates: u32,
    candidateScale: f32,
    shouldProcess: u32,
}

var<workgroup> td: TileData;

@group(0) @binding(0) var<uniform> params: BakeParams;
@group(0) @binding(1) var<storage, read> bakeTiles: array<BakeTile>;
@group(0) @binding(2) var<storage, read_write> bakedInstances: array<AssetInstance>;
@group(0) @binding(3) var<storage, read_write> layerCounters: array<atomic<u32>>;
@group(0) @binding(4) var heightTex: texture_2d_array<f32>;
@group(0) @binding(5) var tileTex: texture_2d_array<f32>;
@group(0) @binding(6) var normalTex: texture_2d_array<f32>;
@group(0) @binding(7) var climateTex: texture_2d_array<f32>;
@group(0) @binding(8) var<storage, read> assetDefs: array<f32>;
@group(0) @binding(9) var<storage, read> tileAssetMap: array<u32>;
@group(0) @binding(10) var<uniform> assetConfig: AssetSelectionConfig;
@group(0) @binding(11) var<storage, read> densityLUT: array<f32>;

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

fn pcg2F(seed: u32) -> vec2<f32> {
    let h1 = pcg(seed);
    let h2 = pcg(h1);
    return vec2<f32>(f32(h1) / 4294967296.0, f32(h2) / 4294967296.0);
}

fn hemiOctDecode(e: vec2<f32>) -> vec3<f32> {
    let z = 1.0 - abs(e.x) - abs(e.y);
    return normalize(vec3<f32>(e, z));
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

fn sampleScalarBilinear(tex: texture_2d_array<f32>, uv: vec2<f32>, layer: i32) -> f32 {
    let size = vec2<i32>(textureDimensions(tex));
    let maxCoord = size - vec2<i32>(1, 1);
    let sizeF = vec2<f32>(size);
    let halfTexel = 0.5 / sizeF;
    let clampedUv = clamp(uv, halfTexel, vec2<f32>(1.0) - halfTexel);
    let samplePos = clampedUv * sizeF - vec2<f32>(0.5, 0.5);
    let basePos = floor(samplePos);
    let frac = samplePos - basePos;
    let c0 = clamp(vec2<i32>(basePos), vec2<i32>(0), maxCoord);
    let c1 = min(c0 + vec2<i32>(1, 1), maxCoord);
    let h00 = textureLoad(tex, c0, layer, 0).r;
    let h10 = textureLoad(tex, vec2<i32>(c1.x, c0.y), layer, 0).r;
    let h01 = textureLoad(tex, vec2<i32>(c0.x, c1.y), layer, 0).r;
    let h11 = textureLoad(tex, c1, layer, 0).r;
    let hx0 = mix(h00, h10, frac.x);
    let hx1 = mix(h01, h11, frac.x);
    return mix(hx0, hx1, frac.y);
}

fn sampleVec4Bilinear(tex: texture_2d_array<f32>, uv: vec2<f32>, layer: i32) -> vec4<f32> {
    let size = vec2<i32>(textureDimensions(tex));
    let maxCoord = size - vec2<i32>(1, 1);
    let sizeF = vec2<f32>(size);
    let halfTexel = 0.5 / sizeF;
    let clampedUv = clamp(uv, halfTexel, vec2<f32>(1.0) - halfTexel);
    let samplePos = clampedUv * sizeF - vec2<f32>(0.5, 0.5);
    let basePos = floor(samplePos);
    let frac = samplePos - basePos;
    let c0 = clamp(vec2<i32>(basePos), vec2<i32>(0), maxCoord);
    let c1 = min(c0 + vec2<i32>(1, 1), maxCoord);
    let v00 = textureLoad(tex, c0, layer, 0);
    let v10 = textureLoad(tex, vec2<i32>(c1.x, c0.y), layer, 0);
    let v01 = textureLoad(tex, vec2<i32>(c0.x, c1.y), layer, 0);
    let v11 = textureLoad(tex, c1, layer, 0);
    let vx0 = mix(v00, v10, frac.x);
    let vx1 = mix(v01, v11, frac.x);
    return mix(vx0, vx1, frac.y);
}

fn computeSlopeFromHeight(uv: vec2<f32>, layer: i32, depth: u32) -> f32 {
    let n = computeTangentNormalFromHeight(uv, layer, depth);
    return clamp(1.0 - n.z, 0.0, 1.0);
}

fn computeTangentNormalFromHeight(uv: vec2<f32>, layer: i32, depth: u32) -> vec3<f32> {
    let hSize = vec2<i32>(textureDimensions(heightTex));
    let texelUv = 1.0 / vec2<f32>(hSize);

    let hL = sampleScalarBilinear(heightTex, uv - vec2<f32>(texelUv.x, 0.0), layer);
    let hR = sampleScalarBilinear(heightTex, uv + vec2<f32>(texelUv.x, 0.0), layer);
    let hD = sampleScalarBilinear(heightTex, uv - vec2<f32>(0.0, texelUv.y), layer);
    let hU = sampleScalarBilinear(heightTex, uv + vec2<f32>(0.0, texelUv.y), layer);

    let gridSize = f32(1u << depth);
    let tileWorldSize = params.faceSize / gridSize;
    let texelWorld = tileWorldSize / f32(max(hSize.x, 1));

    let dhdx = (hR - hL) * params.heightScale / max(2.0 * texelWorld, 0.0001);
    let dhdy = (hU - hD) * params.heightScale / max(2.0 * texelWorld, 0.0001);

    let tangentNormal = normalize(vec3<f32>(-dhdx, -dhdy, 1.0));
    if (length(tangentNormal) < 0.0001) {
        return vec3<f32>(0.0, 0.0, 1.0);
    }
    return tangentNormal;
}

fn sampleClimate(layer: i32, uv: vec2<f32>) -> vec4<f32> {
    let dims = vec2<i32>(textureDimensions(climateTex));
    let maxCoord = dims - vec2<i32>(1);
    let clampedUv = clamp(uv, vec2<f32>(0.0), vec2<f32>(0.999999));
    let coord = clamp(vec2<i32>(clampedUv * vec2<f32>(dims)), vec2<i32>(0), maxCoord);
    return textureLoad(climateTex, coord, layer, 0);
}

fn getBakeDensity(def: AssetDef) -> f32 {
    var d = 0.0;
    for (var i: u32 = 0u; i < LODS_PER_CATEGORY; i++) {
        d = max(d, def.densities[i]);
    }
    return d;
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

        if ((tile.flags & 1u) != 0u) {
            let gridSize = f32(1u << td.depth);
            td.tileUMin = f32(td.tileX) / gridSize;
            td.tileVMin = f32(td.tileY) / gridSize;
            td.tileUVSize = 1.0 / gridSize;

            let gcs = f32(FIXED_GRID_RES) * params.faceSize / MAX_SCATTER_TILE_WS;
            td.globalCellScale = gcs;

            let globalCellSizeM = MAX_SCATTER_TILE_WS / f32(FIXED_GRID_RES);
            td.cellWorldArea = globalCellSizeM * globalCellSizeM;

            let uMax = td.tileUMin + td.tileUVSize;
            let vMax = td.tileVMin + td.tileUVSize;
            let gcMinX = i32(floor(td.tileUMin * gcs));
            let gcMinY = i32(floor(td.tileVMin * gcs));
            let gcMaxX = i32(ceil(uMax * gcs));
            let gcMaxY = i32(ceil(vMax * gcs));
            let fullCellsX = u32(max(gcMaxX - gcMinX, 0));
            let fullCellsY = u32(max(gcMaxY - gcMinY, 0));
            let capSide = max(1u, u32(ceil(sqrt(f32(MAX_CANDIDATES_PER_TILE)))));

            td.gcMinX = gcMinX;
            td.gcMinY = gcMinY;
            td.gcStrideX = max(1u, (fullCellsX + capSide - 1u) / capSide);
            td.gcStrideY = max(1u, (fullCellsY + capSide - 1u) / capSide);
            td.fullCellsX = fullCellsX;
            td.fullCellsY = fullCellsY;
            td.gcCellsX = (fullCellsX + td.gcStrideX - 1u) / td.gcStrideX;
            let gcCellsY = (fullCellsY + td.gcStrideY - 1u) / td.gcStrideY;
            td.gcCellsY = gcCellsY;
            td.totalCandidates = td.gcCellsX * gcCellsY;
            let fullCellCount = max(1u, fullCellsX * fullCellsY);
            let sampledCellCount = max(1u, td.totalCandidates);
            td.candidateScale = f32(fullCellCount) / f32(sampledCellCount);
            td.shouldProcess = select(0u, 1u, td.totalCandidates > 0u);
        }
    }

    workgroupBarrier();
    if (td.shouldProcess == 0u) { return; }

    let layerBase = td.layer * PER_LAYER_CAPACITY;
    for (var candidateIdx = threadIdx; candidateIdx < td.totalCandidates; candidateIdx += WORKGROUP_SIZE) {
        let localX = candidateIdx % td.gcCellsX;
        let localY = candidateIdx / td.gcCellsX;
        let blockSeed = pcg(
            pcg2(
                td.face ^ (td.depth * 2246822519u),
                td.tileX ^ localX
            ) ^ ((td.tileY ^ localY ^ params.seed ^ 0x7F4A7C15u) * 2654435761u)
        );
        let subCellX = select(0u, blockSeed % td.gcStrideX, td.gcStrideX > 1u);
        let subCellY = select(0u, pcg(blockSeed) % td.gcStrideY, td.gcStrideY > 1u);
        let cellOffsetX = min(localX * td.gcStrideX + subCellX, td.fullCellsX - 1u);
        let cellOffsetY = min(localY * td.gcStrideY + subCellY, td.fullCellsY - 1u);
        let gcX = td.gcMinX + i32(cellOffsetX);
        let gcY = td.gcMinY + i32(cellOffsetY);

        let worldSeed = pcg2(
            u32(gcX) ^ (td.face * 2654435761u),
            u32(gcY) ^ params.seed
        );
        let jitter = pcg2F(worldSeed);
        let faceU = (f32(gcX) + jitter.x) / td.globalCellScale;
        let faceV = (f32(gcY) + jitter.y) / td.globalCellScale;

        let uMax = td.tileUMin + td.tileUVSize;
        let vMax = td.tileVMin + td.tileUVSize;
        if (faceU < td.tileUMin || faceU >= uMax || faceV < td.tileVMin || faceV >= vMax) {
            continue;
        }

        let relU = (faceU - td.tileUMin) / td.tileUVSize;
        let relV = (faceV - td.tileVMin) / td.tileUVSize;
        let texUv = vec2<f32>(relU, relV);

        let tSize = vec2<i32>(textureDimensions(tileTex));
        let tCoord = clamp(vec2<i32>(texUv * vec2<f32>(tSize)), vec2<i32>(0), tSize - vec2<i32>(1));
        let rawTile = textureLoad(tileTex, tCoord, i32(td.layer), 0).r;
        let tileIdF = select(rawTile * 255.0, rawTile, rawTile > 1.0);
        let tileId = u32(tileIdF + 0.5);

        let heightSample = sampleScalarBilinear(heightTex, texUv, i32(td.layer));

        let climate = sampleClimate(i32(td.layer), texUv);
        let elevation = clamp(heightSample * 0.5 + 0.5, 0.0, 1.0);
        let slope = computeSlopeFromHeight(texUv, i32(td.layer), td.depth);

        let nSample = sampleVec4Bilinear(normalTex, texUv, i32(td.layer));
        let tangentNormal = hemiOctDecode(nSample.rg * 2.0 - vec2<f32>(1.0, 1.0));

        let assetIdx = selectAsset(
            &assetDefs,
            &tileAssetMap,
            tileId,
            assetConfig.maxTileType,
            climate.r,
            climate.g,
            elevation,
            slope,
            pcgF(worldSeed ^ 0x9E3779B9u)
        );
        if (assetIdx == 0xFFFFFFFFu) { continue; }

        let def = loadAssetDef(&assetDefs, assetIdx);
        if (def.archetypeIndex == 0u) { continue; }
        let densityFitness = computeAssetFitness(
            def,
            climate.r,
            climate.g,
            elevation,
            slope
        );

        let familyIdx = u32(assetDefs[assetIdx * FLOATS_PER_ASSET + 30u]);
        let lutTile = min(tileId, DENSITY_LUT_TILE_COUNT - 1u);
        let densityMul = densityLUT[familyIdx * DENSITY_LUT_TILE_COUNT + lutTile];
        let keepProb = clamp(
            getBakeDensity(def) * densityMul * densityFitness * td.cellWorldArea * td.candidateScale,
            0.0,
            1.0
        );
        if (pcgF(worldSeed ^ 0xB5297A4Du) >= keepProb) { continue; }

        let cubePoint = getCubePoint(td.face, faceU, faceV);
        let sphereDir = normalize(cubePoint);
        let radius = params.planetRadius + heightSample * params.heightScale;
        let worldPos = params.planetOrigin + sphereDir * radius;

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

        let idx = atomicAdd(&layerCounters[td.layer], 1u);
        if (idx >= PER_LAYER_CAPACITY) { continue; }

        let rot = pcgF(worldSeed ^ 0xA341316Cu) * 6.2831853;
        let widthRnd = pcgF(worldSeed ^ 0xC8013EA4u);
        let heightRnd = pcgF(worldSeed ^ 0xAD90777Du);
        let w = mix(def.widthMin, def.widthMax, widthRnd);
        let h = mix(def.heightMin, def.heightMax, heightRnd);
        let colorRnd = pcgF(worldSeed ^ 0x7E95761Eu);
        let col = mix(def.baseColor, def.tipColor, colorRnd);
        let terrainEmbed = max(0.0, assetDefs[assetIdx * FLOATS_PER_ASSET + 46u]);
        let embedDepth = terrainEmbed * max(w, h);
        let anchorPos = worldPos - groundNormal * embedDepth;

        bakedInstances[layerBase + idx] = AssetInstance(
            anchorPos.x, anchorPos.y, anchorPos.z,
            rot, w, h,
            assetIdx, 0u,
            col.x, col.y, col.z, 1.0,
            groundNormal.x, groundNormal.y, groundNormal.z, 0.0
        );
    }
}
`;
}
