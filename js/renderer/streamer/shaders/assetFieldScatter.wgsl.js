import { buildAssetSelectionWGSL } from '../AssetSelectionBuffer.js';

export function buildAssetFieldScatterShader(config = {}) {
    const WORKGROUP_SIZE = config.workgroupSize ?? 64;
    const TOTAL_BANDS = config.totalBands ?? 9;
    const LODS_PER_CATEGORY = config.lodsPerCategory ?? 5;
    const MAX_SCATTER_DISTANCE = config.maxScatterDistance ?? 12000;
    const FIELD_RESOLUTION = Math.max(8, Math.floor(config.fieldResolution ?? 32));
    const MAX_SCATTER_TILE_WORLD_SIZE = Math.max(8, Math.floor(config.maxScatterTileWorldSize ?? 48));
    const SCATTER_CELL_OVERSAMPLE = Math.max(1, Math.floor(config.scatterCellOversample ?? 1));
    const FIELD_CHANNEL_INDEX = Math.max(0, Math.min(1, Math.floor(config.fieldChannelIndex ?? 0)));
    const FIELD_GROUP_BIT = Math.max(0, Math.floor(config.fieldGroupBit ?? 0));
    const FIELD_DENSITY_SCALE = Number.isFinite(config.fieldDensityScale)
        ? Math.max(config.fieldDensityScale, 0.0)
        : 1.0;
    const FIXED_GRID_RES = FIELD_RESOLUTION * SCATTER_CELL_OVERSAMPLE;
    const MAX_CANDIDATES_PER_TILE = FIXED_GRID_RES * FIXED_GRID_RES;
    const assetSelectionWGSL = buildAssetSelectionWGSL({});

    return /* wgsl */`
const WORKGROUP_SIZE: u32 = ${WORKGROUP_SIZE}u;
const BAND_COUNT: u32 = ${TOTAL_BANDS}u;
const MAX_PARENT_SEARCH: u32 = 16u;
const LODS_PER_ARCHETYPE: u32 = ${LODS_PER_CATEGORY}u;
const MAX_SCATTER_DISTANCE: f32 = ${Number(MAX_SCATTER_DISTANCE).toFixed(1)};
const FIELD_RESOLUTION: u32 = ${FIELD_RESOLUTION}u;
const MAX_SCATTER_TILE_WS: f32 = ${Number(MAX_SCATTER_TILE_WORLD_SIZE).toFixed(1)};
const FIXED_GRID_RES: u32 = ${FIXED_GRID_RES}u;
const MAX_CANDIDATES_PER_TILE: u32 = ${MAX_CANDIDATES_PER_TILE}u;
const FIELD_GROUP_BIT: u32 = ${FIELD_GROUP_BIT}u;
const FIELD_CHANNEL_INDEX: u32 = ${FIELD_CHANNEL_INDEX}u;
const FIELD_DENSITY_SCALE: f32 = ${FIELD_DENSITY_SCALE.toFixed(3)};

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
    layer: i32,
    tileUMin: f32,
    tileVMin: f32,
    tileUVSize: f32,
    cellWorldArea: f32,
    globalCellScale: f32,
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

@group(0) @binding(0) var<uniform> params: ScatterParams;
@group(0) @binding(1) var<storage, read> activeLayers: array<u32>;
@group(0) @binding(2) var<storage, read_write> instances: array<AssetInstance>;
@group(0) @binding(3) var<storage, read_write> bandCounters: array<atomic<u32>, BAND_COUNT>;
@group(0) @binding(4) var<uniform> bandMeta: array<BandMeta, BAND_COUNT>;
@group(0) @binding(5) var heightTex: texture_2d_array<f32>;
@group(0) @binding(6) var tileTex: texture_2d_array<f32>;
@group(0) @binding(7) var<storage, read> layerMeta: array<LayerMeta>;
@group(0) @binding(8) var<storage, read> assetDefs: array<f32>;
@group(0) @binding(9) var<storage, read> tileAssetMap: array<u32>;
@group(0) @binding(10) var<uniform> assetConfig: AssetSelectionConfig;
@group(0) @binding(11) var fieldTex: texture_2d_array<f32>;
@group(0) @binding(12) var normalTex: texture_2d_array<f32>;
@group(0) @binding(13) var climateTex: texture_2d_array<f32>;
@group(0) @binding(14) var<storage, read> fieldRenderMasks: array<u32>;

const ACTIVE_FIELD_FLAG: u32 = 1u;

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

fn isLayerBeyondScatterRange(info: LayerMeta) -> bool {
    let gridSize = f32(1u << info.depth);
    let cu = (f32(info.tileX) + 0.5) / gridSize;
    let cv = (f32(info.tileY) + 0.5) / gridSize;
    let cWorld = params.planetOrigin + normalize(getCubePoint(info.face, cu, cv)) * params.planetRadius;
    let tileDist = length(params.cameraPosition - cWorld);
    let tileWS = params.faceSize / gridSize;
    let margin = tileWS * 0.75 + 1.8 * params.heightScale;
    return (tileDist - margin) > MAX_SCATTER_DISTANCE;
}

fn sampleFieldValue(layer: i32, uv: vec2<f32>) -> vec4<f32> {
    let dims = vec2<i32>(textureDimensions(fieldTex));
    let maxCoord = dims - vec2<i32>(1, 1);
    let clampedUv = clamp(uv, vec2<f32>(0.0), vec2<f32>(0.999999));
    let coord = clamp(vec2<i32>(clampedUv * vec2<f32>(dims)), vec2<i32>(0), maxCoord);
    return textureLoad(fieldTex, coord, layer, 0);
}

fn sampleClimateValue(layer: i32, uv: vec2<f32>) -> vec4<f32> {
    let dims = vec2<i32>(textureDimensions(climateTex));
    let maxCoord = dims - vec2<i32>(1, 1);
    let clampedUv = clamp(uv, vec2<f32>(0.0), vec2<f32>(0.999999));
    let coord = clamp(vec2<i32>(clampedUv * vec2<f32>(dims)), vec2<i32>(0), maxCoord);
    return textureLoad(climateTex, coord, layer, 0);
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn main(
    @builtin(workgroup_id) workgroupId: vec3<u32>,
    @builtin(local_invocation_index) threadIdx: u32
) {
    if (threadIdx == 0u) {
        td.shouldProcess = 0u;
        td.layer = -1;
        let layerIndex = activeLayers[workgroupId.x];
        let info = layerMeta[layerIndex];
        if ((info.flags & ACTIVE_FIELD_FLAG) != 0u && !isLayerBeyondScatterRange(info)) {
            td.face = info.face;
            td.depth = info.depth;
            td.tileX = info.tileX;
            td.tileY = info.tileY;
            td.layer = i32(layerIndex);

            let layerMask = fieldRenderMasks[layerIndex];
            if ((layerMask & FIELD_GROUP_BIT) != 0u) {
                let gridSize = f32(1u << td.depth);
                td.tileUMin = f32(td.tileX) / gridSize;
                td.tileVMin = f32(td.tileY) / gridSize;
                td.tileUVSize = 1.0 / gridSize;
                td.globalCellScale = f32(FIXED_GRID_RES) * params.faceSize / MAX_SCATTER_TILE_WS;

                let targetCellWorldSize = MAX_SCATTER_TILE_WS / f32(FIXED_GRID_RES);
                td.cellWorldArea = targetCellWorldSize * targetCellWorldSize;

                let uMax = td.tileUMin + td.tileUVSize;
                let vMax = td.tileVMin + td.tileUVSize;
                let gcMinX = i32(floor(td.tileUMin * td.globalCellScale));
                let gcMinY = i32(floor(td.tileVMin * td.globalCellScale));
                let gcMaxX = i32(ceil(uMax * td.globalCellScale));
                let gcMaxY = i32(ceil(vMax * td.globalCellScale));
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
                td.gcCellsY = (fullCellsY + td.gcStrideY - 1u) / td.gcStrideY;
                td.totalCandidates = td.gcCellsX * td.gcCellsY;
                let fullCellCount = max(1u, fullCellsX * fullCellsY);
                let sampledCellCount = max(1u, td.totalCandidates);
                td.candidateScale = f32(fullCellCount) / f32(sampledCellCount);
                td.shouldProcess = select(0u, 1u, td.totalCandidates > 0u);
            }
        }
    }

    workgroupBarrier();
    if (td.shouldProcess == 0u) { return; }

    for (var candidateIdx = threadIdx; candidateIdx < td.totalCandidates; candidateIdx += WORKGROUP_SIZE) {
        let localX = candidateIdx % td.gcCellsX;
        let localY = candidateIdx / td.gcCellsX;

        let blockSeed = pcg4(
            td.face ^ (td.depth * 2246822519u),
            td.tileX ^ localX,
            td.tileY ^ localY,
            params.seed ^ 0xA53C49E5u
        );
        let subCellX = select(0u, blockSeed % td.gcStrideX, td.gcStrideX > 1u);
        let subCellY = select(0u, (pcg(blockSeed) % td.gcStrideY), td.gcStrideY > 1u);
        let cellOffsetX = min(localX * td.gcStrideX + subCellX, td.fullCellsX - 1u);
        let cellOffsetY = min(localY * td.gcStrideY + subCellY, td.fullCellsY - 1u);
        let gcX = td.gcMinX + i32(cellOffsetX);
        let gcY = td.gcMinY + i32(cellOffsetY);

        let seed = pcg4(
            td.face ^ (td.depth * 2246822519u),
            u32(gcX),
            u32(gcY),
            params.seed
        );
        let jitter = pcg2F(seed);
        let faceU = (f32(gcX) + jitter.x) / td.globalCellScale;
        let faceV = (f32(gcY) + jitter.y) / td.globalCellScale;
        let uMax = td.tileUMin + td.tileUVSize;
        let vMax = td.tileVMin + td.tileUVSize;
        if (faceU < td.tileUMin || faceU >= uMax || faceV < td.tileVMin || faceV >= vMax) {
            continue;
        }

        let tileLocalUv = vec2<f32>(
            (faceU - td.tileUMin) / td.tileUVSize,
            (faceV - td.tileVMin) / td.tileUVSize
        );
        let clampedLocalUv = clamp(tileLocalUv, vec2<f32>(0.001), vec2<f32>(0.999));
        let texUv = clampedLocalUv;
        let faceUv = vec2<f32>(faceU, faceV);

        let field = sampleFieldValue(td.layer, texUv);
        let climate = sampleClimateValue(td.layer, texUv);
        var density = field.r;
        if (FIELD_CHANNEL_INDEX == 1u) {
            density = field.g;
        }
        density = clamp(density, 0.0, 1.0);
        if (density <= 0.001) { continue; }

        let tSize = vec2<i32>(textureDimensions(tileTex));
        let tCoord = clamp(vec2<i32>(texUv * vec2<f32>(tSize)), vec2<i32>(0), tSize - vec2<i32>(1));
        let tileSample = textureLoad(tileTex, tCoord, td.layer, 0);
        let rawTile = tileSample.r;
        let tileIdF = select(rawTile * 255.0, rawTile, rawTile > 1.0);
        let tileId = u32(tileIdF + 0.5);

        let heightSample = sampleScalarBilinear(heightTex, texUv, td.layer);

        let cubePoint = getCubePoint(td.face, faceUv.x, faceUv.y);
        let sphereDir = normalize(cubePoint);
        let radius = params.planetRadius + heightSample * params.heightScale;
        let worldPos = params.planetOrigin + sphereDir * radius;
        let dist = length(params.cameraPosition - worldPos);

        let elevation = clamp(heightSample * 0.5 + 0.5, 0.0, 1.0);
        let slope = computeSlopeFromHeight(texUv, td.layer, td.depth);
        let nSample = sampleVec4Bilinear(normalTex, texUv, td.layer);
        let tangentNormal = hemiOctDecode(nSample.rg * 2.0 - vec2<f32>(1.0, 1.0));

        let selectRng = pcgF(seed ^ 0x9E3779B9u);
        let assetIdx = selectAsset(
            &assetDefs,
            &tileAssetMap,
            tileId,
            assetConfig.maxTileType,
            climate.r,
            climate.g,
            elevation,
            slope,
            selectRng
        );
        if (assetIdx == 0xFFFFFFFFu) { continue; }

        let def = loadAssetDef(&assetDefs, assetIdx);
        let lodInfo = getAssetLODInfo(def, dist);
        if (lodInfo.lodLevel == 0xFFFFFFFFu) { continue; }
        let densityFitness = computeAssetFitness(
            def,
            climate.r,
            climate.g,
            elevation,
            slope
        );

        let keepProb = clamp(
            density * lodInfo.density * densityFitness * FIELD_DENSITY_SCALE * td.cellWorldArea * td.candidateScale,
            0.0,
            1.0
        );
        let thinRng = pcgF(seed ^ 0xB5297A4Du);
        if (thinRng >= keepProb) { continue; }

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

        let bandInfo = bandMeta[lodInfo.bandIndex];
        let idx = atomicAdd(&bandCounters[lodInfo.bandIndex], 1u);
        if (idx >= bandInfo.capacity) { continue; }

        let globalIdx = bandInfo.baseOffset + idx;
        let rot = pcgF(seed ^ 0xA341316Cu) * 6.2831853;
        let widthRnd = pcgF(seed ^ 0xC8013EA4u);
        let heightRnd = pcgF(seed ^ 0xAD90777Du);
        let w = mix(def.widthMin, def.widthMax, widthRnd);
        let h = mix(def.heightMin, def.heightMax, heightRnd);
        let colorRnd = pcgF(seed ^ 0x7E95761Eu);
        let col = mix(def.baseColor, def.tipColor, colorRnd);
        let terrainEmbed = max(0.0, assetDefs[assetIdx * FLOATS_PER_ASSET + 46u]);
        let embedDepth = terrainEmbed * max(w, h);
        let anchorPos = worldPos - groundNormal * embedDepth;

        instances[globalIdx] = AssetInstance(
            anchorPos.x, anchorPos.y, anchorPos.z,
            rot, w, h,
            assetIdx, lodInfo.bandIndex,
            col.x, col.y, col.z, 1.0,
            groundNormal.x, groundNormal.y, groundNormal.z, 0.0
        );
    }
}
`;
}
