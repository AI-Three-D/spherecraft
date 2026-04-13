// js/world/shaders/webgpu/advancedTerrainCompute.wgsl.js
import { createNoiseLibrary } from "./noiseLibrary.wgsl.js";
import { createBiomeScoringWGSL } from "./biomeScoring.wgsl.js";

export function createAdvancedTerrainComputeShader(options = {}) {
  const shaderBundle = options?.terrainShaderBundle;
  if (!shaderBundle) {
    throw new Error('createAdvancedTerrainComputeShader requires options.terrainShaderBundle');
  }
  const baseGenerators = shaderBundle.baseGenerators;
  if (!baseGenerators) {
    throw new Error('createAdvancedTerrainComputeShader requires options.terrainShaderBundle.baseGenerators');
  }
  const baseId = options?.baseGenerator ?? 'earthLike';
  const base = baseGenerators[baseId] ?? baseGenerators.earthLike;
  const {
    createTerrainCommon,
    createSurfaceCommon,
    createTerrainFeatureContinents,
    createTerrainFeaturePlains,
    createTerrainFeatureHills,
    createTerrainFeatureMountains,
    createTerrainFeatureCanyons,
    createTerrainFeatureLoneHills,
    createTerrainFeatureMicro,
    createTerrainFeatureMesoDetail,
    createTerrainFeatureHighlands,
  } = shaderBundle;
  const outputFormat = options?.outputFormat ?? 'rgba32float';
  const hasHeightBindings = options?.hasHeightBindings ?? false;
  const hasTileBindings = options?.hasTileBindings ?? false;
  const maxBiomes = options?.maxBiomes ?? 16;

  return [
    base.constants(),
    `
struct Uniforms {
    chunkCoord: vec2<i32>,
    chunkSize: i32,
    chunkGridSize: i32,
    seed: i32,

    biomeScale: f32,
    regionScale: f32,
    detailScale: f32,
    ridgeScale: f32,
    valleyScale: f32,
    plateauScale: f32,

    worldScale: f32,
    outputType: i32,
    face: i32,

    debugMode: i32,
    _pad_i:    i32,
    uvOffset:  vec2<f32>,

    continentParams: vec4<f32>,
    tectonicParams: vec4<f32>,
    waterParams: vec4<f32>,
    erosionParams: vec4<f32>,
    volcanicParams: vec4<f32>,
    climateParams: vec4<f32>,

    _pad2: vec4<f32>,
    _pad3: vec4<f32>,
    _pad4: vec4<f32>,
    _pad5: vec4<f32>,

    climateZone0: vec4<f32>,
    climateZone0Extra: vec4<f32>,
    climateZone1: vec4<f32>,
    climateZone1Extra: vec4<f32>,
    climateZone2: vec4<f32>,
    climateZone2Extra: vec4<f32>,
    climateZone3: vec4<f32>,
    climateZone3Extra: vec4<f32>,
    climateZone4: vec4<f32>,
    climateZone4Extra: vec4<f32>,
};

${createBiomeScoringWGSL({ maxBiomes })}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var outputTexture: texture_storage_2d<${outputFormat}, write>;
${hasHeightBindings ? '@group(0) @binding(2) var heightMap: texture_2d<f32>;' : ''}
${hasTileBindings ? '@group(0) @binding(3) var tileMap: texture_2d<f32>;' : ''}
@group(1) @binding(0) var<uniform> biomeConfigUniforms: BiomeUniforms;

fn getSpherePoint(face: i32, u: f32, v: f32) -> vec3<f32> {
    var cubePos: vec3<f32>;
    let x = u * 2.0 - 1.0;
    let y = v * 2.0 - 1.0;

    if (face == 0) { cubePos = vec3<f32>( 1.0, y, -x); }
    else if (face == 1) { cubePos = vec3<f32>(-1.0, y,  x); }
    else if (face == 2) { cubePos = vec3<f32>( x,  1.0, -y); }
    else if (face == 3) { cubePos = vec3<f32>( x, -1.0,  y); }
    else if (face == 4) { cubePos = vec3<f32>( x,  y,  1.0); }
    else { cubePos = vec3<f32>(-x,  y, -1.0); }

    return normalize(cubePos);
}

    struct NormalSlope {
    n: vec3<f32>,
    slope: f32,
};

fn slopeFromNormal(nIn: vec3<f32>, upIn: vec3<f32>) -> f32 {
    let n = normalize(nIn);
    let up = normalize(upIn);
    let d = clamp(abs(dot(n, up)), 0.0, 1.0);
    return clamp(sqrt(max(0.0, 1.0 - d * d)), 0.0, 1.0);
}

fn hemiOctEncode(n: vec3<f32>) -> vec2<f32> {
    return n.xy * (1.0 / (abs(n.x) + abs(n.y) + n.z));
}

fn computeNormalSlopeSphere(face: i32, u: f32, v: f32, du: f32, dv: f32) -> NormalSlope {
    let epsU = max(du, 1.0 / 8192.0);
    let epsV = max(dv, 1.0 / 8192.0);

    let uR = min(u + epsU, 1.0);
    let uL = max(u - epsU, 0.0);
    let vU = min(v + epsV, 1.0);
    let vD = max(v - epsV, 0.0);

    let dirC = getSpherePoint(face, u, v);
    let dirR = getSpherePoint(face, uR, v);
    let dirL = getSpherePoint(face, uL, v);
    let dirU = getSpherePoint(face, u, vU);
    let dirD = getSpherePoint(face, u, vD);

    let hR = calculateTerrainHeight(dirR.x, dirR.z, uniforms.seed, dirR);
    let hL = calculateTerrainHeight(dirL.x, dirL.z, uniforms.seed, dirL);
    let hU = calculateTerrainHeight(dirU.x, dirU.z, uniforms.seed, dirU);
    let hD = calculateTerrainHeight(dirD.x, dirD.z, uniforms.seed, dirD);

    let nd = normalDisplacementScale();
    let pR = dirR * (1.0 + hR * nd);
    let pL = dirL * (1.0 + hL * nd);
    let pU = dirU * (1.0 + hU * nd);
    let pD = dirD * (1.0 + hD * nd);

    let dX = pR - pL;
    let dY = pU - pD;

    var n = normalize(cross(dY, dX));
    if (any(n != n) || length(n) < 0.1) {
        n = dirC;
    }

    var ns: NormalSlope;
    ns.n = n;
    ns.slope = slopeFromNormal(n, dirC);
    return ns;
}

fn computeNormalSlopeFlat(wx: f32, wy: f32) -> NormalSlope {
    let eps = 1.0;

    let hL = calculateTerrainHeight(wx - eps, wy, uniforms.seed, vec3<f32>(0.0, 1.0, 0.0));
    let hR = calculateTerrainHeight(wx + eps, wy, uniforms.seed, vec3<f32>(0.0, 1.0, 0.0));
    let hD = calculateTerrainHeight(wx, wy - eps, uniforms.seed, vec3<f32>(0.0, 1.0, 0.0));
    let hU = calculateTerrainHeight(wx, wy + eps, uniforms.seed, vec3<f32>(0.0, 1.0, 0.0));

    let dHx = (hR - hL) / (2.0 * eps);
    let dHy = (hU - hD) / (2.0 * eps);

    let heightScale = normalDisplacementScale();
    let n = normalize(vec3<f32>(-dHx * heightScale, 1.0, -dHy * heightScale));

    var ns: NormalSlope;
    ns.n = n;
    ns.slope = slopeFromNormal(n, vec3<f32>(0.0, 1.0, 0.0));
    return ns;
}

fn computeStableNormalSlopeSphere(face: i32, u: f32, v: f32) -> NormalSlope {
    let stableStep = 1.0 / 8192.0;
    return computeNormalSlopeSphere(face, u, v, stableStep, stableStep);
}

${hasHeightBindings ? `
fn sampleHeightAt(coord: vec2<i32>) -> f32 {
    return textureLoad(heightMap, coord, 0).r;
}

fn sampleMicroHeightProcedural(face: i32, u: f32, v: f32, du: f32, dv: f32) -> f32 {
    let dir = getSpherePoint(face, u, v);
    let wx = dir.x;
    let wy = dir.z;

    let baseH = calculateTerrainHeight(wx, wy, uniforms.seed, dir);
    let ns = computeStableNormalSlopeSphere(face, u, v);
    let slope = ns.slope;

    var tileType: u32 = determineTileType(baseH, slope, wx, wy, dir, uniforms.seed);
    let profile = getTerrainProfile();

    var dispMeters = DISP_MICRO_GENERIC;
    if (isForestFloorTile(tileType)) {
        dispMeters = DISP_MICRO_FOREST;
    } else if (isGrassTile(tileType)) {
        dispMeters = DISP_MICRO_GRASS;
    } else if (isSandTile(tileType)) {
        let t = smoothstep(0.25, 0.65, slope);
        dispMeters = mix(DISP_MICRO_SAND_FLAT, DISP_MICRO_SAND_STEEP, t);
    } else if (tileType == SURFACE_WATER) {
        dispMeters = 0.0;
    }

    let micro = select(
        0.0,
        tileMicroDetail(wx, wy, dir, uniforms.seed, slope, profile, tileType),
        dispMeters > 0.0
    );
    let microGain = clamp(profile.microGain, 0.0, 5.0);
    let microH = micro * (dispMeters / maxTerrainHeightM()) * microGain;
    return softClampHeight(baseH + microH, -1.1, 1.8, 0.25);
}

// Stable base-height-only boundary sampler.
// Used at chunk texture edges instead of sampleMicroHeightProcedural to avoid
// cross-chunk normal seams. The micro-detail FBM is sensitive to sub-ULP UV
// differences that arise from the two different float-arithmetic paths each
// neighboring chunk uses to compute the same boundary UV. Using only the
// low-frequency base height (no micro) eliminates that sensitivity: the base
// functions vary slowly enough that ±1 ULP in u/v causes no perceptible error.
fn sampleBaseHeightProcedural(face: i32, u: f32, v: f32) -> f32 {
    let dir = getSpherePoint(face, u, v);
    let wx = dir.x;
    let wy = dir.z;
    let baseH = calculateTerrainHeight(wx, wy, uniforms.seed, dir);
    return softClampHeight(baseH, -1.1, 1.8, 0.25);
}

fn computeNormalSlopeFromHeightMapSphere(
    face: i32, u: f32, v: f32, du: f32, dv: f32,
    coordC: vec2<i32>
) -> NormalSlope {
    let size = vec2<i32>(textureDimensions(heightMap));
    let maxC = size - vec2<i32>(1);

    let coordR = clamp(coordC + vec2<i32>(1, 0), vec2<i32>(0), maxC);
    let coordL = clamp(coordC - vec2<i32>(1, 0), vec2<i32>(0), maxC);
    let coordU = clamp(coordC + vec2<i32>(0, 1), vec2<i32>(0), maxC);
    let coordD = clamp(coordC - vec2<i32>(0, 1), vec2<i32>(0), maxC);

    let uR = min(u + du, 1.0);
    let uL = max(u - du, 0.0);
    let vU = min(v + dv, 1.0);
    let vD = max(v - dv, 0.0);

    let dirC = getSpherePoint(face, u, v);
    let dirR = getSpherePoint(face, uR, v);
    let dirL = getSpherePoint(face, uL, v);
    let dirU = getSpherePoint(face, u, vU);
    let dirD = getSpherePoint(face, u, vD);

    var hR = sampleHeightAt(coordR);
    var hL = sampleHeightAt(coordL);
    var hU = sampleHeightAt(coordU);
    var hD = sampleHeightAt(coordD);

    // Near tile borders, fade the normal computation back to the low-frequency
    // base height field. The stored micro-height is sensitive to tiny
    // cross-tile UV differences, which shows up as lighting seams exactly on
    // tile edges. A 2-texel band is enough to make the shared border normals
    // agree while keeping interior detail intact.
    let edgeDistX = min(coordC.x, maxC.x - coordC.x);
    let edgeDistY = min(coordC.y, maxC.y - coordC.y);
    let edgeDist = min(edgeDistX, edgeDistY);
    if (edgeDist <= 2) {
        let blendT = clamp(f32(edgeDist) / 2.0, 0.0, 1.0);
        let bR = sampleBaseHeightProcedural(face, uR, v);
        let bL = sampleBaseHeightProcedural(face, uL, v);
        let bU = sampleBaseHeightProcedural(face, u, vU);
        let bD = sampleBaseHeightProcedural(face, u, vD);
        hR = mix(bR, hR, blendT);
        hL = mix(bL, hL, blendT);
        hU = mix(bU, hU, blendT);
        hD = mix(bD, hD, blendT);
    }
    let nd = normalDisplacementScale();
    let pR = dirR * (1.0 + hR * nd);
    let pL = dirL * (1.0 + hL * nd);
    let pU = dirU * (1.0 + hU * nd);
    let pD = dirD * (1.0 + hD * nd);

    let dX = pR - pL;
    let dY = pU - pD;

    var n = normalize(cross(dY, dX));
    if (any(n != n) || length(n) < 0.1) {
        n = dirC;
    }

    var ns: NormalSlope;
    ns.n = n;
    ns.slope = slopeFromNormal(n, dirC);
    return ns;
}

fn computeNormalSlopeFromHeightMapFlat(coordC: vec2<i32>) -> NormalSlope {
    let size = vec2<i32>(textureDimensions(heightMap));
    let maxC = size - vec2<i32>(1);

    let coordR = clamp(coordC + vec2<i32>(1, 0), vec2<i32>(0), maxC);
    let coordL = clamp(coordC - vec2<i32>(1, 0), vec2<i32>(0), maxC);
    let coordU = clamp(coordC + vec2<i32>(0, 1), vec2<i32>(0), maxC);
    let coordD = clamp(coordC - vec2<i32>(0, 1), vec2<i32>(0), maxC);

    let hL = sampleHeightAt(coordL);
    let hR = sampleHeightAt(coordR);
    let hD = sampleHeightAt(coordD);
    let hU = sampleHeightAt(coordU);

    let nd = normalDisplacementScale();
    var n = normalize(vec3<f32>((hL - hR) * nd, 2.0, (hD - hU) * nd));
    if (any(n != n) || length(n) < 0.1) {
        n = vec3<f32>(0.0, 1.0, 0.0);
    }

    var ns: NormalSlope;
    ns.n = n;
    ns.slope = slopeFromNormal(n, vec3<f32>(0.0, 1.0, 0.0));
    return ns;
}
` : ''}
`,
    createNoiseLibrary(),
    createTerrainCommon(),
    createSurfaceCommon(),
    createTerrainFeatureContinents(),
    createTerrainFeaturePlains(),
    createTerrainFeatureHills(),
    createTerrainFeatureMountains(),
    createTerrainFeatureCanyons(),
    createTerrainFeatureLoneHills(),
    createTerrainFeatureMicro(),
    createTerrainFeatureMesoDetail(),
    createTerrainFeatureHighlands(),
    base.base(),
    `
const WATER_1: u32 = 0u;
const GRASS_SHORT_1: u32 = 10u;
const ROCK_OUTCROP_1: u32 = 42u;

const DISP_MICRO_FOREST: f32 = 10.0;
const DISP_MICRO_GRASS: f32 = 6.0;
const DISP_MICRO_SAND_FLAT: f32 = 3.0;
const DISP_MICRO_SAND_STEEP: f32 = 2.0;
const DISP_MICRO_GENERIC: f32 = 2.5;

fn decodeTileId(tileSample: vec4<f32>) -> u32 {
    let rawR = tileSample.r;
    let tileIdF = select(rawR * 255.0, rawR, rawR > 1.0);
    return u32(tileIdF + 0.5);
}

const SCALE_ROCK_LARGE: f32 = 8.0;
const SCALE_ROCK_MEDIUM: f32 = 2.0;
const SCALE_ROCK_SMALL: f32 = 0.5;

fn calculateRockProbability(
    wx: f32, wy: f32, unitDir: vec3<f32>,
    slope: f32, elevation: f32, seed: i32
) -> f32 {
    let slopeFactor = smoothstep(0.5, 0.85, slope);

    let largeNoise = fbmAuto(wx, wy, unitDir, SCALE_ROCK_LARGE, 2, seed + 7000, 2.0, 0.5);
    let largeRock = smoothstep(0.45, 0.65, largeNoise);

    let mediumNoise = fbmAuto(wx, wy, unitDir, SCALE_ROCK_MEDIUM, 2, seed + 7100, 2.0, 0.5);
    let mediumRock = smoothstep(0.5, 0.7, mediumNoise);

    let smallNoise = fbmAuto(wx, wy, unitDir, SCALE_ROCK_SMALL, 2, seed + 7200, 2.0, 0.5);
    let smallRock = smoothstep(0.55, 0.75, smallNoise);

    let steepRock = slopeFactor * mix(0.3, 1.0, largeRock * 0.5 + mediumRock * 0.3 + smallRock * 0.2);
    let flatRock = largeRock * mediumRock * 0.5;
    let result = mix(flatRock, steepRock, smoothstep(0.2, 0.5, slope));

    return clamp(result, 0.0, 1.0);
}

fn determineTileTypeAdvanced(
    h: f32, slope: f32, wx: f32, wy: f32,
    unitDir: vec3<f32>, seed: i32
) -> u32 {
    let oceanLevel = uniforms.waterParams.y;

    if (h <= oceanLevel) {
        return WATER_1;
    }

    var rockProb = calculateRockProbability(wx, wy, unitDir, slope, h, seed);

    if (rockProb > 0.5) {
        return ROCK_OUTCROP_1;
    }

    return GRASS_SHORT_1;
}


fn authoredBiomeTileVariantBase(tileId: u32) -> u32 {
    let validTileId = validateTileType(tileId);

    if (validTileId == SURFACE_WATER) {
        return SURFACE_WATER;
    }
    if (isGrassTile(validTileId)) {
        return SURFACE_GRASS_MIN + ((validTileId - SURFACE_GRASS_MIN) / 4u) * 4u;
    }
    if (isSandTile(validTileId)) {
        return SURFACE_SAND_MIN + ((validTileId - SURFACE_SAND_MIN) / 4u) * 4u;
    }
    if (isRockTile(validTileId)) {
        return SURFACE_ROCK_MIN + ((validTileId - SURFACE_ROCK_MIN) / 4u) * 4u;
    }
    if (isTundraTile(validTileId)) {
        return SURFACE_TUNDRA_MIN + ((validTileId - SURFACE_TUNDRA_MIN) / 4u) * 4u;
    }
    if (isForestFloorTile(validTileId)) {
        if (validTileId >= SURFACE_FOREST_TROPICAL_MIN) {
            return SURFACE_FOREST_TROPICAL_MIN + ((validTileId - SURFACE_FOREST_TROPICAL_MIN) / 4u) * 4u;
        }
        return SURFACE_FOREST_FLOOR_MIN + ((validTileId - SURFACE_FOREST_FLOOR_MIN) / 4u) * 4u;
    }
    if (isSwampTile(validTileId)) {
        return SURFACE_SWAMP_MIN + ((validTileId - SURFACE_SWAMP_MIN) / 4u) * 4u;
    }
    if (isDirtTile(validTileId)) {
        return SURFACE_DIRT_MIN + ((validTileId - SURFACE_DIRT_MIN) / 4u) * 4u;
    }
    if (isMudTile(validTileId)) {
        return SURFACE_MUD_MIN + ((validTileId - SURFACE_MUD_MIN) / 4u) * 4u;
    }
    if (isSnowTile(validTileId)) {
        return SURFACE_SNOW_MIN + ((validTileId - SURFACE_SNOW_MIN) / 4u) * 4u;
    }
    if (isDesertTile(validTileId)) {
        return SURFACE_DESERT_MIN + ((validTileId - SURFACE_DESERT_MIN) / 4u) * 4u;
    }
    if (isVolcanicTile(validTileId)) {
        return SURFACE_VOLCANIC_MIN + ((validTileId - SURFACE_VOLCANIC_MIN) / 4u) * 4u;
    }

    return SURFACE_GRASS_BASE;
}

fn resolveAuthoredBiomeTileType(
    tileId: u32,
    variant: u32
) -> u32 {
    let baseTile = authoredBiomeTileVariantBase(tileId);
    if (baseTile == SURFACE_WATER) {
        return SURFACE_WATER;
    }
    return validateTileType(baseTile + variant);
}

fn determineTileTypeFallback(
    h: f32, slope: f32, wx: f32, wy: f32,
    unitDir: vec3<f32>, seed: i32
) -> u32 {
    let oceanLevel = uniforms.waterParams.y;

    if (h <= oceanLevel) {
        return SURFACE_WATER;
    }

    let weights = computeSurfaceWeights(slope, h, wx, wy, unitDir, seed);
    return resolveTileTypeFromWeights(weights, wx, wy, unitDir, seed, h, slope);
}

fn determineTileType(
    h: f32, slope: f32, wx: f32, wy: f32,
    unitDir: vec3<f32>, seed: i32
) -> u32 {
    let oceanLevel = uniforms.waterParams.y;

    if (h <= oceanLevel) {
        return SURFACE_WATER;
    }

    if (biomeConfigUniforms.biomeCount == 0u) {
        return determineTileTypeFallback(h, slope, wx, wy, unitDir, seed);
    }

    let climate = getClimate(wx, wy, unitDir, h, seed);
    let biome = selectBiomeFromDefs(
        h,
        climate.precipitation,
        climate.temperature,
        slope,
        wx,
        wy,
        biomeConfigUniforms
    );
    if (biome.score <= 0.0) {
        return determineTileTypeFallback(h, slope, wx, wy, unitDir, seed);
    }

    let variant = selectTileVariant(wx, wy, unitDir, seed);
    let rockNoise = (fbmAuto(wx, wy, unitDir, 0.12, 2, seed + 7310, 2.0, 0.5) + 1.0) * 0.5;
    let rockSlope = smoothstep(0.48, 0.80, slope);
    let highland = smoothstep(oceanLevel + 0.04, oceanLevel + 0.20, h);
    let rockMask = rockSlope * mix(0.65, 1.0, highland) * mix(0.8, 1.05, rockNoise);
    let rockThreshold = select(0.72, 0.88, isSnowTile(biome.tileId));
    if (rockMask > rockThreshold) {
        return validateTileType(SURFACE_ROCK_BASE + variant);
    }

    return resolveAuthoredBiomeTileType(biome.tileId, variant);
}

fn debugForcedTileType() -> u32 {
    if (uniforms.debugMode == 20) { return SURFACE_GRASS_BASE; }
    if (uniforms.debugMode == 21) { return SURFACE_SAND_BASE; }
    if (uniforms.debugMode == 22) { return SURFACE_FOREST_FLOOR_BASE; }
    if (uniforms.debugMode == 23) { return SURFACE_DIRT_BASE; }
    return 0xffffffffu;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let texSize = textureDimensions(outputTexture);
    if (global_id.x >= texSize.x || global_id.y >= texSize.y) { return; }

    let pixelCoord = vec2<f32>(f32(global_id.x), f32(global_id.y));

    var wx: f32 = 0.0;
    var wy: f32 = 0.0;
    var unitDir: vec3<f32> = vec3<f32>(0.0, 1.0, 0.0);

    var u: f32 = 0.0;
    var v: f32 = 0.0;
    var du: f32 = 0.0;
    var dv: f32 = 0.0;

    if (uniforms.face >= 0) {
        if (uniforms.chunkSize <= 0) {
            if (uniforms.chunkGridSize > 1 && uniforms.outputType != 2 && uniforms.outputType != 4) {
                let texSize = textureDimensions(outputTexture);
                let totalChunks = f32(max(uniforms.chunkGridSize, 1));

                let chunkIdx = vec2<f32>(
                    floor((pixelCoord.x) * totalChunks / f32(texSize.x)),
                    floor((pixelCoord.y) * totalChunks / f32(texSize.y))
                );

                u = (chunkIdx.x + 0.5) / totalChunks;
                v = (chunkIdx.y + 0.5) / totalChunks;

                du = 1.0 / totalChunks;
                dv = 1.0 / totalChunks;
            } else {
                let texSize = textureDimensions(outputTexture);
                u = (pixelCoord.x + 0.5) / f32(texSize.x);
                v = (pixelCoord.y + 0.5) / f32(texSize.y);
                du = 1.0 / f32(texSize.x);
                dv = 1.0 / f32(texSize.y);
            }

            unitDir = getSpherePoint(uniforms.face, u, v);
            wx = unitDir.x;
            wy = unitDir.z;
        } else {
            let totalChunks = f32(max(uniforms.chunkGridSize, 1));
            let chunkSizePx = vec2<f32>(f32(max(uniforms.chunkSize, 1)));
            var localUV: vec2<f32>;
            let usesPaddedSingleChunk =
                abs(uniforms.uvOffset.x) > 0.0 || abs(uniforms.uvOffset.y) > 0.0;

            if (usesPaddedSingleChunk) {
                if (chunkSizePx.x < 2.0) {
                    localUV = vec2<f32>(0.5, 0.5);
                } else {
                    localUV = pixelCoord / max(chunkSizePx - vec2<f32>(1.0), vec2<f32>(1.0));
                }

                let chunkCoord = vec2<f32>(f32(uniforms.chunkCoord.x), f32(uniforms.chunkCoord.y));
                u = (chunkCoord.x + localUV.x) / totalChunks;
                v = (chunkCoord.y + localUV.y) / totalChunks;
            } else {
                let localChunk = floor(pixelCoord / chunkSizePx);
                let localPixel = pixelCoord - localChunk * chunkSizePx;

                if (chunkSizePx.x < 2.0) {
                    localUV = vec2<f32>(0.5, 0.5);
                } else {
                    localUV = localPixel / max(chunkSizePx - vec2<f32>(1.0), vec2<f32>(1.0));
                }

                let chunkCoord =
                    vec2<f32>(f32(uniforms.chunkCoord.x), f32(uniforms.chunkCoord.y))
                    + localChunk;
                u = (chunkCoord.x + localUV.x) / totalChunks;
                v = (chunkCoord.y + localUV.y) / totalChunks;
            }

            u += uniforms.uvOffset.x;
            v += uniforms.uvOffset.y;

            du = 1.0 / (totalChunks * max(chunkSizePx.x - 1.0, 1.0));
            dv = 1.0 / (totalChunks * max(chunkSizePx.y - 1.0, 1.0));

            unitDir = getSpherePoint(uniforms.face, u, v);
            wx = unitDir.x;
            wy = unitDir.z;
        }
    } else {
        if (uniforms.chunkSize > 0) {
            let chunkSizePx = vec2<f32>(f32(uniforms.chunkSize), f32(uniforms.chunkSize));
            let localChunk = floor(pixelCoord / chunkSizePx);
            let localPixel = pixelCoord - localChunk * chunkSizePx;
            let chunkStride = max(f32(uniforms.chunkSize) - 1.0, 1.0);
            let baseChunk = vec2<f32>(f32(uniforms.chunkCoord.x), f32(uniforms.chunkCoord.y));
            let worldChunk = baseChunk + localChunk;
            let worldTile = worldChunk * chunkStride + localPixel;
            wx = worldTile.x;
            wy = worldTile.y;
        } else {
            let chunkOrigin = vec2<f32>(f32(uniforms.chunkCoord.x), f32(uniforms.chunkCoord.y)) * f32(uniforms.chunkSize);
            let worldTile = chunkOrigin + pixelCoord;
            wx = worldTile.x;
            wy = worldTile.y;
        }
    }

    var output = vec4<f32>(0.0, 0.0, 0.0, 1.0);

if (uniforms.outputType == 0) {
    var h: f32;
    var stableSlope: f32 = 0.0;

    if (uniforms.debugMode == 1) {
        h = unitDir.y * 0.5;
    } else if (uniforms.debugMode == 2) {
        h = u - 0.5;
    } else if (uniforms.debugMode == 3) {
        h = v - 0.5;
    } else if (uniforms.debugMode == 4) {
        h = perlin3D(unitDir * 100.0, uniforms.seed) * 0.3;
    } else if (uniforms.debugMode == 5) {
        h = fract(u * 512.0) * 0.3;
    } else if (uniforms.debugMode == 6) {
        h = fract(v * 512.0) * 0.3;
    } else if (uniforms.debugMode == 7) {
        let chunkSizePx = vec2<f32>(f32(max(uniforms.chunkSize, 1)));
        let localPixel = pixelCoord - floor(pixelCoord / chunkSizePx) * chunkSizePx;
        if (localPixel.x < 1.5 || localPixel.y < 1.5) {
            h = 0.4;
        } else {
            h = 0.0;
        }
    } else if (uniforms.debugMode == 8) {
        let profile = getTerrainProfile();
        h = getContinentalMask(wx, wy, unitDir, uniforms.seed, profile) * 0.5;
    } else if (uniforms.debugMode == 9) {
        let profile = getTerrainProfile();
        h = rarityMaskAuto(wx, wy, unitDir, SCALE_MOUNTAIN_RANGES * 1.3, uniforms.seed + 2050, RARITY_RARE, profile.rareBoost) * 0.4;
    } else if (uniforms.debugMode == 10) {
        h = cellShapeAuto(wx, wy, unitDir, SCALE_MOUNTAIN_RANGES * 0.9, uniforms.seed + 2070, 0.5) * 0.4;
    } else if (uniforms.debugMode == 11) {
        let profile = getTerrainProfile();
        h = rarityMaskAuto(wx, wy, unitDir, SCALE_CANYON_MAIN * 1.1, uniforms.seed + 2600, RARITY_VERY_RARE, profile.rareBoost) * 0.4;
    } else if (uniforms.debugMode == 12) {
        h = cellShapeAuto(wx, wy, unitDir, SCALE_CANYON_MAIN * 0.8, uniforms.seed + 2620, 0.28) * 0.4;
    } else if (uniforms.debugMode == 13) {
        h = cellRandomAuto(wx, wy, unitDir, SCALE_MOUNTAIN_RANGES * 1.3, uniforms.seed + 2050) * 0.4;
    } else {
        h = calculateTerrainHeight(wx, wy, uniforms.seed, unitDir);

        // ── Compute LOD-stable slope ONCE here ───────────────────────
        // Passes 2 (tile) and 4 (micro) read this from heightBase.g
        // instead of each calling calculateTerrainHeight 4× for finite
        // differences. This is the single biggest win in the pipeline.
        if (uniforms.face >= 0) {
            let ns = computeStableNormalSlopeSphere(uniforms.face, u, v);
            stableSlope = ns.slope;
        } else {
            let ns = computeNormalSlopeFlat(wx, wy);
            stableSlope = ns.slope;
        }
    }
    output = vec4<f32>(h, stableSlope, 0.0, 1.0);

}  else if (uniforms.outputType == 1) {
        ${hasHeightBindings ? `
        let coordC = vec2<i32>(global_id.xy);
        var ns: NormalSlope;
        if (uniforms.face >= 0) {
            ns = computeNormalSlopeFromHeightMapSphere(uniforms.face, u, v, du, dv, coordC);
        } else {
            ns = computeNormalSlopeFromHeightMapFlat(coordC);
        }

        let n = ns.n;
        let slope = ns.slope;
        let up = select(unitDir, vec3<f32>(0.0, 1.0, 0.0), uniforms.face < 0);
        var reference = vec3<f32>(0.0, 1.0, 0.0);
        if (abs(dot(up, reference)) > 0.99) {
            reference = vec3<f32>(1.0, 0.0, 0.0);
        }
        let tangent = normalize(cross(up, reference));
        let bitangent = normalize(cross(up, tangent));
        let tangentNormal = normalize(vec3<f32>(dot(n, tangent), dot(n, bitangent), dot(n, up)));
        let tangentNormalUpper = select(-tangentNormal, tangentNormal, tangentNormal.z >= 0.0);
        let enc = hemiOctEncode(tangentNormalUpper) * 0.5 + 0.5;
        output = vec4<f32>(enc, slope, 1.0);

        ` : `
        if (uniforms.face >= 0) {
            let uR = min(u + du, 1.0);
            let uL = max(u - du, 0.0);
            let vU = min(v + dv, 1.0);
            let vD = max(v - dv, 0.0);

            let dirC = unitDir;
            let dirR = getSpherePoint(uniforms.face, uR, v);
            let dirL = getSpherePoint(uniforms.face, uL, v);
            let dirU = getSpherePoint(uniforms.face, u, vU);
            let dirD = getSpherePoint(uniforms.face, u, vD);

            let hR = calculateTerrainHeight(dirR.x, dirR.z, uniforms.seed, dirR);
            let hL = calculateTerrainHeight(dirL.x, dirL.z, uniforms.seed, dirL);
            let hU = calculateTerrainHeight(dirU.x, dirU.z, uniforms.seed, dirU);
            let hD = calculateTerrainHeight(dirD.x, dirD.z, uniforms.seed, dirD);

            let nd = normalDisplacementScale();
            let pR = dirR * (1.0 + hR * nd);
            let pL = dirL * (1.0 + hL * nd);
            let pU = dirU * (1.0 + hU * nd);
            let pD = dirD * (1.0 + hD * nd);

            let dX = pR - pL;
            let dY = pU - pD;

            var n = normalize(cross(dY, dX));
            if (any(n != n) || length(n) < 0.1) {
                n = dirC;
            }

            let slope = slopeFromNormal(n, dirC);

            let up = normalize(dirC);
            var reference = vec3<f32>(0.0, 1.0, 0.0);
            if (abs(dot(up, reference)) > 0.99) {
                reference = vec3<f32>(1.0, 0.0, 0.0);
            }
            let tangent = normalize(cross(up, reference));
            let bitangent = normalize(cross(up, tangent));
            let tangentNormal = normalize(vec3<f32>(dot(n, tangent), dot(n, bitangent), dot(n, up)));

            let tangentNormalUpper = select(-tangentNormal, tangentNormal, tangentNormal.z >= 0.0);
            let enc = hemiOctEncode(tangentNormalUpper) * 0.5 + 0.5;
            output = vec4<f32>(enc, slope, 1.0);
        } else {
            let eps = 1.0;
            let hL = calculateTerrainHeight(wx - eps, wy, uniforms.seed, unitDir);
            let hR = calculateTerrainHeight(wx + eps, wy, uniforms.seed, unitDir);
            let hD = calculateTerrainHeight(wx, wy - eps, uniforms.seed, unitDir);
            let hU = calculateTerrainHeight(wx, wy + eps, uniforms.seed, unitDir);

            let nd = normalDisplacementScale();
            var n = normalize(vec3<f32>((hL - hR) * nd, 2.0 * eps, (hD - hU) * nd));
            if (any(n != n) || length(n) < 0.1) {
                n = vec3<f32>(0.0, 1.0, 0.0);
            }

            let slope = slopeFromNormal(n, vec3<f32>(0.0, 1.0, 0.0));

            let up = normalize(unitDir);
            var reference = vec3<f32>(0.0, 1.0, 0.0);
            if (abs(dot(up, reference)) > 0.99) {
                reference = vec3<f32>(1.0, 0.0, 0.0);
            }
            let tangent = normalize(cross(up, reference));
            let bitangent = normalize(cross(up, tangent));
            let tangentNormal = normalize(vec3<f32>(dot(n, tangent), dot(n, bitangent), dot(n, up)));

            let tangentNormalUpper = select(-tangentNormal, tangentNormal, tangentNormal.z >= 0.0);
            let enc = hemiOctEncode(tangentNormalUpper) * 0.5 + 0.5;
            output = vec4<f32>(enc, slope, 1.0);
        }
        `}

} else if (uniforms.outputType == 2) {
    let oceanLevel = uniforms.waterParams.y;
    var tileType: u32 = SURFACE_GRASS_BASE;

    ${hasHeightBindings ? `
    let coordC = vec2<i32>(global_id.xy);
    // heightMap here is heightBase: .r = height, .g = cached stable slope.
    // Was: computeStableNormalSlopeSphere → 4× calculateTerrainHeight per pixel.
    let heightSample = textureLoad(heightMap, coordC, 0);
    let h = heightSample.r;
    let slope = heightSample.g;
    ` : `
    let h = calculateTerrainHeight(wx, wy, uniforms.seed, unitDir);
    var slope: f32 = 0.0;
    if (uniforms.face >= 0) {
        let ns = computeStableNormalSlopeSphere(uniforms.face, u, v);
        slope = ns.slope;
    } else {
        let ns = computeNormalSlopeFlat(wx, wy);
        slope = ns.slope;
    }
    `}

    if (uniforms.debugMode == 24) {
        let climate = getClimate(wx, wy, unitDir, h, uniforms.seed);
        output = vec4<f32>(climate.precipitation, 0.0, 0.0, 1.0);
        textureStore(outputTexture, vec2<i32>(global_id.xy), output);
        return;
    }
    if (uniforms.debugMode == 25) {
        let climate = getClimate(wx, wy, unitDir, h, uniforms.seed);
        output = vec4<f32>(climate.temperature, 0.0, 0.0, 1.0);
        textureStore(outputTexture, vec2<i32>(global_id.xy), output);
        return;
    }

    if (h <= oceanLevel) {
        tileType = SURFACE_WATER;
    } else {
        tileType = determineTileType(h, slope, wx, wy, unitDir, uniforms.seed);
    }

    let forced = debugForcedTileType();
    if (forced != 0xffffffffu) {
        tileType = forced;
    }

    output = vec4<f32>(f32(tileType) / 255.0, 0.0, 0.0, 1.0);

}

${hasTileBindings ? `
else if (uniforms.outputType == 4) {
    let coordC = vec2<i32>(global_id.xy);
    // heightMap here is heightBase: .r = base height, .g = cached stable slope.
    // Was: computeStableNormalSlopeSphere → 4× calculateTerrainHeight per pixel.
    let heightSample = textureLoad(heightMap, coordC, 0);
    let baseH = heightSample.r;
    let slope = heightSample.g;
    let tileSample = textureLoad(tileMap, coordC, 0);
    let tileId = decodeTileId(tileSample);

    let profile = getTerrainProfile();
    var dispMeters = DISP_MICRO_GENERIC;
    if (isForestFloorTile(tileId)) {
        dispMeters = DISP_MICRO_FOREST;
    } else if (isGrassTile(tileId)) {
        dispMeters = DISP_MICRO_GRASS;
    } else if (isSandTile(tileId)) {
        let t = smoothstep(0.25, 0.65, slope);
        dispMeters = mix(DISP_MICRO_SAND_FLAT, DISP_MICRO_SAND_STEEP, t);
    } else if (tileId == SURFACE_WATER) {
        dispMeters = 0.0;
    }

    var micro = select(
        0.0,
        tileMicroDetail(wx, wy, unitDir, uniforms.seed, slope, profile, tileId),
        dispMeters > 0.0
    );
    let microGain = clamp(profile.microGain, 0.0, 5.0);
    let microH = micro * (dispMeters / maxTerrainHeightM()) * microGain;
    let finalH = softClampHeight(baseH + microH, -1.1, 1.8, 0.25);
    output = vec4<f32>(finalH, 0.0, 0.0, 1.0);
}
else if (uniforms.outputType == 5) {
    let coordC = vec2<i32>(global_id.xy);
    let h = sampleHeightAt(coordC);
    let tileSample = textureLoad(tileMap, coordC, 0);
    let tileId = decodeTileId(tileSample);

    var slope: f32 = 0.0;
    if (uniforms.face >= 0) {
        let ns = computeNormalSlopeFromHeightMapSphere(
            uniforms.face, u, v, du, dv, coordC);
        slope = ns.slope;
    } else {
        let ns = computeNormalSlopeFromHeightMapFlat(coordC);
        slope = ns.slope;
    }

    var eligibility: f32 = 1.0;

    let oceanLevel = uniforms.waterParams.y;
    if (h <= oceanLevel) {
        eligibility = 0.0;
    }

    if (eligibility > 0.0) {
        eligibility *= 1.0 - smoothstep(0.4, 0.7, slope);
    }

    if (eligibility > 0.0) {
        var tileEligible: f32 = 0.0;
        if (isForestFloorTile(tileId)) {
            tileEligible = 1.0;
        } else if (isGrassTile(tileId)) {
            tileEligible = 0.001;
        } else if (isDirtTile(tileId)) {
            tileEligible = 0.0002;
        }
        eligibility *= tileEligible;
    }

    if (eligibility > 0.0) {
        let climate = getClimate(wx, wy, unitDir, h, uniforms.seed);
        let coldFade = smoothstep(-0.3, 0.0, climate.temperature);
        let dryFade = smoothstep(0.05, 0.25, climate.precipitation);
        let desertFade = 1.0 - smoothstep(0.7, 0.9, climate.temperature)
                             * (1.0 - smoothstep(0.0, 0.15,
                                      climate.precipitation));
        eligibility *= coldFade * dryFade * desertFade;
    }

    if (eligibility > 0.0) {
        let treelineFade = 1.0 - smoothstep(0.4, 0.65, h);
        eligibility *= treelineFade;
    }

    eligibility = clamp(eligibility, 0.0, 1.0);
    if (eligibility < 0.05) {
        eligibility = 0.0;
    }

    output = vec4<f32>(eligibility, 0.0, 0.0, 1.0);
} else if (uniforms.outputType == 6) {
    // ═══ Climate bake for ground-cover scatter ═══════════════════
    // Bakes temperature + precipitation + vegetation suitability
    // into rgba8unorm so the per-frame scatter shader can skip the
    // expensive getClimate() FBM evaluation.
    //
    // r = temperature   [0,1]  (normalized, same as ClimateInfo.temperature)
    // g = precipitation  [0,1]  (same as ClimateInfo.precipitation)
    // b = vegetation suitability [0,1] (coldFade * dryFade * desertFade)
    // a = 1.0 (reserved)

    let coordC = vec2<i32>(global_id.xy);
    let h = sampleHeightAt(coordC);

    var slope: f32 = 0.0;
    if (uniforms.face >= 0) {
        let ns = computeNormalSlopeFromHeightMapSphere(
            uniforms.face, u, v, du, dv, coordC);
        slope = ns.slope;
    } else {
        let ns = computeNormalSlopeFromHeightMapFlat(coordC);
        slope = ns.slope;
    }

    let climate = getClimate(wx, wy, unitDir, h, uniforms.seed);

    // Vegetation suitability: composite of the same climate gates that
    // the tree eligibility pass (outputType=5) and the scatter shader
    // use to suppress placement in hostile biomes.
    var vegSuitability: f32 = 1.0;

    let oceanLevel = uniforms.waterParams.y;
    if (h <= oceanLevel) {
        vegSuitability = 0.0;
    }

    if (vegSuitability > 0.0) {
        let coldFade    = smoothstep(-0.3, 0.0, climate.temperature);
        let dryFade     = smoothstep(0.05, 0.25, climate.precipitation);
        let desertFade  = 1.0 - smoothstep(0.7, 0.9, climate.temperature)
                              * (1.0 - smoothstep(0.0, 0.15,
                                       climate.precipitation));
        vegSuitability = coldFade * dryFade * desertFade;
    }

    vegSuitability = clamp(vegSuitability, 0.0, 1.0);

    output = vec4<f32>(
        climate.temperature,
        climate.precipitation,
        vegSuitability,
        1.0
    );
}
` : ''}

        else if (uniforms.outputType == 3) {
        let zoneScale = clampMacroScaleToPlanet(SCALE_REGIONAL_ZONES);
        let zoneNoise = fbmAuto(wx, wy, unitDir, zoneScale, 4, uniforms.seed + 400, 2.0, 0.5);
        let zoneMask = clamp(zoneNoise * 0.5 + 0.5, 0.0, 1.0);
        output = vec4<f32>(zoneMask, 0.0, 0.0, 1.0);
    }

    textureStore(outputTexture, vec2<i32>(global_id.xy), output);
}
`
  ].join('\n');
}
