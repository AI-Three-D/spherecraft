export function buildAtmoBankScatterWGSL({ maxEmitters = 32 } = {}) {
    return /* wgsl */`

const MAX_EMITTERS: u32 = ${maxEmitters}u;
const GRID_RES: u32 = 8u;
const CELLS_PER_TILE: u32 = GRID_RES * GRID_RES;

const TYPE_VALLEY_MIST: u32 = 0u;
const TYPE_FOG_POCKET:  u32 = 1u;
const TYPE_LOW_CLOUD:   u32 = 2u;

struct ScatterParams {
    cameraPos: vec3<f32>, maxEmitters: u32,
    planetOrigin: vec3<f32>, planetRadius: f32,
    heightScale: f32, weatherIntensity: f32, fogDensity: f32, frameSeed: u32,
};

struct LayerMeta {
    face: u32, depth: u32, tileX: u32, tileY: u32,
    layer: i32, _p0: u32, _p1: u32, _p2: u32,
};

struct EmitterOut {
    posX: f32, posY: f32, posZ: f32, spawnBudget: u32,
    upX: f32, upY: f32, upZ: f32, typeId: u32,
    rngSeed: u32, _p0: u32, _p1: u32, _p2: u32,
    _p3: f32, _p4: f32, _p5: f32, _p6: f32,
    _p7: f32, _p8: f32, _p9: f32, _p10: f32,
};

struct EmitterCounter { count: atomic<u32>, _p0: u32, _p1: u32, _p2: u32 };

@group(0) @binding(0) var<uniform> params: ScatterParams;
@group(0) @binding(1) var<storage, read> activeLayers: array<u32>;
@group(0) @binding(2) var<storage, read_write> emitterOutput: array<EmitterOut>;
@group(0) @binding(3) var<storage, read_write> counter: EmitterCounter;
@group(0) @binding(4) var<storage, read> layerMeta: array<LayerMeta>;
@group(0) @binding(5) var heightTex: texture_2d_array<f32>;
@group(0) @binding(6) var tileTex: texture_2d_array<f32>;
@group(0) @binding(7) var normalTex: texture_2d_array<f32>;

fn hash1u(x: u32) -> u32 {
    var v = x;
    v = (v ^ 61u) ^ (v >> 16u);
    v = v + (v << 3u);
    v = v ^ (v >> 4u);
    v = v * 0x27d4eb2du;
    v = v ^ (v >> 15u);
    return v;
}

fn hashToFloat(seed: u32) -> f32 {
    return f32(hash1u(seed) & 0x00FFFFFFu) / f32(0x01000000u);
}

fn getCubePoint(face: u32, u: f32, v: f32) -> vec3<f32> {
    let s = u * 2.0 - 1.0;
    let t = v * 2.0 - 1.0;
    switch (face) {
        case 0u { return vec3<f32>( 1.0,  t, -s); }
        case 1u { return vec3<f32>(-1.0,  t,  s); }
        case 2u { return vec3<f32>( s,  1.0, -t); }
        case 3u { return vec3<f32>( s, -1.0,  t); }
        case 4u { return vec3<f32>( s,  t,  1.0); }
        default { return vec3<f32>(-s,  t, -1.0); }
    }
}

fn sampleHeight(uv: vec2<f32>, layer: i32) -> f32 {
    let dims = vec2<i32>(textureDimensions(heightTex));
    let coord = clamp(vec2<i32>(uv * vec2<f32>(dims)), vec2<i32>(0), dims - vec2<i32>(1));
    return textureLoad(heightTex, coord, layer, 0).r;
}

fn sampleTileType(uv: vec2<f32>, layer: i32) -> u32 {
    let dims = vec2<i32>(textureDimensions(tileTex));
    let coord = clamp(vec2<i32>(uv * vec2<f32>(dims)), vec2<i32>(0), dims - vec2<i32>(1));
    let s = textureLoad(tileTex, coord, layer, 0).r;
    return u32(s * 255.0 + 0.5);
}

fn sampleSlope(uv: vec2<f32>, layer: i32) -> f32 {
    let dims = vec2<i32>(textureDimensions(heightTex));
    let texel = 1.0 / vec2<f32>(dims);
    let hL = sampleHeight(vec2<f32>(max(uv.x - texel.x, 0.0), uv.y), layer) * params.heightScale;
    let hR = sampleHeight(vec2<f32>(min(uv.x + texel.x, 1.0), uv.y), layer) * params.heightScale;
    let hD = sampleHeight(vec2<f32>(uv.x, max(uv.y - texel.y, 0.0)), layer) * params.heightScale;
    let hU = sampleHeight(vec2<f32>(uv.x, min(uv.y + texel.y, 1.0)), layer) * params.heightScale;
    let relief = max(abs(hR - hL), abs(hU - hD));
    return clamp(relief * 0.02, 0.0, 1.0);
}

fn isForestTile(tileId: u32) -> bool {
    return (tileId >= 66u && tileId <= 81u) || (tileId >= 142u && tileId <= 149u);
}

fn isSwampTile(tileId: u32) -> bool {
    return tileId >= 82u && tileId <= 93u;
}

fn isWaterOrDesert(tileId: u32) -> bool {
    return (tileId <= 3u) || (tileId >= 30u && tileId <= 41u) || (tileId >= 150u && tileId <= 165u);
}

@compute @workgroup_size(64)
fn main(
    @builtin(workgroup_id) wgId: vec3<u32>,
    @builtin(local_invocation_index) tid: u32
) {
    if (tid >= CELLS_PER_TILE) { return; }

    let layerIdx = activeLayers[wgId.x];
    let tileInfo = layerMeta[layerIdx];
    let layer = tileInfo.layer;
    if (layer < 0) { return; }

    let gridSize = f32(1u << tileInfo.depth);
    let tileUMin = f32(tileInfo.tileX) / gridSize;
    let tileVMin = f32(tileInfo.tileY) / gridSize;
    let tileUVSize = 1.0 / gridSize;

    let cellX = tid % GRID_RES;
    let cellY = tid / GRID_RES;

    let cellHash = hash1u(cellX * 73856093u + cellY * 19349663u + tileInfo.face * 83492791u +
                          tileInfo.depth * 37u + tileInfo.tileX * 127u + tileInfo.tileY * 311u + params.frameSeed);
    let jitterX = hashToFloat(cellHash) * 0.8 + 0.1;
    let jitterY = hashToFloat(cellHash ^ 0xABCDu) * 0.8 + 0.1;

    let localU = (f32(cellX) + jitterX) / f32(GRID_RES);
    let localV = (f32(cellY) + jitterY) / f32(GRID_RES);
    let faceU = tileUMin + localU * tileUVSize;
    let faceV = tileVMin + localV * tileUVSize;
    let texUv = vec2<f32>(localU, localV);

    let height = sampleHeight(texUv, layer);
    let elevation = height * params.heightScale;
    let tileId = sampleTileType(texUv, layer);

    if (isWaterOrDesert(tileId)) { return; }

    let cubePoint = getCubePoint(tileInfo.face, faceU, faceV);
    let sphereDir = normalize(cubePoint);
    let worldPos = params.planetOrigin + sphereDir * (params.planetRadius + elevation);

    let dx = worldPos.x - params.cameraPos.x;
    let dy = worldPos.y - params.cameraPos.y;
    let dz = worldPos.z - params.cameraPos.z;
    let camDist = sqrt(dx * dx + dy * dy + dz * dz);
    if (camDist > 2000.0) { return; }

    let slope = sampleSlope(texUv, layer);
    let weatherMod = max(0.32, clamp(params.fogDensity * 1.6 + params.weatherIntensity * 0.45, 0.0, 1.25));
    let roll = hashToFloat(cellHash ^ 0x12345678u);

    var typeId = 0xFFFFFFFFu;
    var budget = 2u;

    if (isForestTile(tileId) && slope < 0.25) {
        let prob = 0.26 * weatherMod;
        if (roll < prob) {
            typeId = TYPE_FOG_POCKET;
            budget = 4u;
        }
    }

    if (typeId == 0xFFFFFFFFu && isSwampTile(tileId)) {
        let prob = 0.32 * weatherMod;
        if (roll < prob) {
            typeId = TYPE_FOG_POCKET;
            budget = 4u;
        }
    }

    if (typeId == 0xFFFFFFFFu && slope < 0.15) {
        let texelSize = 1.0 / f32(GRID_RES);
        let hL = sampleHeight(vec2<f32>(max(localU - texelSize * 3.0, 0.0), localV), layer) * params.heightScale;
        let hR = sampleHeight(vec2<f32>(min(localU + texelSize * 3.0, 1.0), localV), layer) * params.heightScale;
        let hD = sampleHeight(vec2<f32>(localU, max(localV - texelSize * 3.0, 0.0)), layer) * params.heightScale;
        let hU = sampleHeight(vec2<f32>(localU, min(localV + texelSize * 3.0, 1.0)), layer) * params.heightScale;
        let avgNeighbor = (hL + hR + hD + hU) * 0.25;
        let depression = avgNeighbor - elevation;

        if (depression > 3.0) {
            let prob = 0.18 * weatherMod * min(depression / 10.0, 1.0);
            if (roll < prob) {
                typeId = TYPE_VALLEY_MIST;
                budget = 3u;
            }
        }
    }

    if (typeId == 0xFFFFFFFFu && elevation > params.heightScale * 0.55 && slope < 0.3) {
        let altFactor = clamp((elevation - params.heightScale * 0.55) / (params.heightScale * 0.2), 0.0, 1.0);
        let prob = 0.10 * weatherMod * altFactor;
        if (roll < prob) {
            typeId = TYPE_LOW_CLOUD;
            budget = 2u;
        }
    }

    if (typeId == 0xFFFFFFFFu) { return; }

    let idx = atomicAdd(&counter.count, 1u);
    if (idx >= MAX_EMITTERS) { return; }

    var em: EmitterOut;
    em.posX = worldPos.x; em.posY = worldPos.y; em.posZ = worldPos.z;
    em.spawnBudget = budget;
    em.upX = sphereDir.x; em.upY = sphereDir.y; em.upZ = sphereDir.z;
    em.typeId = typeId;
    em.rngSeed = cellHash;
    emitterOutput[idx] = em;
}
`;
}
