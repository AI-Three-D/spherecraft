// js/world/shaders/webgpu/advancedTerrainCompute.wgsl.js
import { createNoiseLibrary } from "./noiseLibrary.wgsl.js";
import { createTerrainFeatureToggleWgsl } from '../../terrain-generator/terrainFeatureToggles.js';
import { createBiomeScoringWGSL } from "./biomeScoring.wgsl.js";

function wgslFloat(value, fallback) {
  const n = Number.isFinite(value) ? value : fallback;
  return Number(n).toFixed(6);
}

const wgslNum = (v) => {
  const s = String(Number(v));
  return /[.eE]/.test(s) ? s : `${s}.0`;
};
const wgslVec = (arr) => `vec${arr.length}<f32>(${arr.map(wgslNum).join(', ')})`;

// terrain.erosionFilter: the RuneVision filter applied to the land height in
// calculateTerrainHeightD (sphere). Always on; cfg holds its parameters
// (TerrainGenerationConfig.erosionFilter).
function createErosionFilterLandWgsl(cfg, createFeature) {
  if (!cfg || !Number.isFinite(cfg.strength)) {
    throw new Error('createAdvancedTerrainComputeShader requires options.erosionFilter (TerrainGenerationConfig.erosionFilter)');
  }
  return createFeature() + `
fn erosionConfiguredParams() -> ErosionParams {
    var prm: ErosionParams;
    prm.strength = ${wgslNum(cfg.strength)};
    prm.gullyWeight = ${wgslNum(cfg.gullyWeight)};
    prm.detail = ${wgslNum(cfg.detail)};
    prm.rounding = ${wgslVec(cfg.rounding)};
    prm.onset = ${wgslVec(cfg.onset)};
    prm.assumedSlope = ${wgslVec(cfg.assumedSlope)};
    prm.scale = ${wgslNum(cfg.scale)};
    prm.octaves = ${Math.round(cfg.octaves)};
    prm.lacunarity = ${wgslNum(cfg.lacunarity)};
    prm.gain = ${wgslNum(cfg.gain)};
    prm.cellScale = ${wgslNum(cfg.cellScale)};
    prm.normalization = ${wgslNum(cfg.normalization)};
    prm.normalSquash = ${wgslNum(cfg.normalSquash)};
    prm.seed = ${Math.round(cfg.seed)};
    return prm;
}

// Fraction of meso1/meso2 kept where erosion runs at full amount.
const EROSION_MESO_KEEP: f32 = ${wgslNum(cfg.mesoKeep)};

struct ErosionLandResult {
    // Height change (dual, normalized) to add to the terrain.
    delta: vec4<f32>,
    // Local erosion amount 0..1 (dual): regional variation x relief.
    amount: vec4<f32>,
}

// Erodes a slope-continuous landform (dual: normalized height + gradient
// w.r.t. unitDir) and returns the height change. reliefNorm: the summed
// height of the large landforms (mountains, highlands, big lone hills).
// - Amount = variation x mix(lowReliefAmount, 1, relief ramp) x steepness:
//   variation is a noise field (wavelength variationScaleM) between
//   variationMin and 1, so some regions erode hard and others stay smooth;
//   the relief ramp goes from reliefStartM to reliefFullM; steepness ramps
//   with the input slope from sharpSlopeStart to sharpSlopeFull.
//   Strength = strength x amount.
// - Rounding: ridges and creases blend to lowAmountRounding as the amount
//   falls from softAmountNone to softAmountFull.
// - Fade target: relief over fadeRangeM, mapped to [-1, 1].
// - Height offset -fadeTarget * initialFadeWeight removes the initial fade
//   target's whole contribution (it reaches every octave through the stacked
//   masks), leaving the gully structure: flat ground keeps its height and the
//   landform is not reshaped. (Cancelling only (1 - initialMask) * magnitude
//   over-cancelled where later masks were partly open: rings around flat
//   hilltops and valley floors.)
// Slope deltas are the filter's approximate derivatives (as in the
// original), plus the first-order terms of the amount and the offset.
fn erosionFilterLand_d(unitDir: vec3<f32>, land: vec4<f32>, reliefNorm: vec4<f32>) -> ErosionLandResult {
    var r: ErosionLandResult;
    r.delta = vec4<f32>(0.0);
    r.amount = vec4<f32>(0.0);
    let maxH = maxTerrainHeightM();
    let R = noiseReferenceRadiusM();
    let relief = reliefNorm * maxH;
    let reliefRamp = dSmoothstep(${wgslNum(cfg.reliefStartM)}, ${wgslNum(cfg.reliefFullM)}, relief);
    let varN = fbmAuto_d(unitDir, ${wgslNum(cfg.variationScaleM / 1000)}, 3, uniforms.seed + 7100, 2.0, 0.5);
    let variation = dConst(${wgslNum(cfg.variationMin)}) + dSmoothstep(-0.35, 0.35, varN) * (1.0 - ${wgslNum(cfg.variationMin)});
    let reliefAmount = dMul(variation, dConst(${wgslNum(cfg.lowReliefAmount)}) + reliefRamp * (1.0 - ${wgslNum(cfg.lowReliefAmount)}));
    // Steepness: full erosion on steep ground, fading out toward flat ground.
    // Summits, saddles and valley floors are where the gully direction spins
    // around a point (pinches, bowties); this keeps gullies away from them
    // and makes erosion lighter on gentle hills. Its gradient (a second
    // derivative of the landform) is not tracked.
    let slope = terrainSurfaceGradient(land, unitDir) * maxH;
    let steepness = smoothstep(${wgslNum(cfg.sharpSlopeStart)}, ${wgslNum(cfg.sharpSlopeFull)}, length(slope));
    let amount = reliefAmount * steepness;
    r.amount = amount;
    if (amount.x <= 0.001) { return r; }
    var prm = erosionConfiguredParams();
    prm.strength *= amount.x;
    // Light erosion gets rounded ridges and creases: with the default sharp
    // creases, shallow gullies read as thin etched lines on gentle terrain.
    let soft = 1.0 - smoothstep(${wgslNum(cfg.softAmountFull)}, ${wgslNum(cfg.softAmountNone)}, amount.x);
    prm.rounding.x = mix(prm.rounding.x, ${wgslNum(cfg.lowAmountRounding)}, soft);
    prm.rounding.y = mix(prm.rounding.y, ${wgslNum(cfg.lowAmountRounding)}, soft);
    let fadeRaw = relief.x / ${wgslNum(cfg.fadeRangeM)} * 2.0 - 1.0;
    let fadeTarget = clamp(fadeRaw, -1.0, 1.0);
    let e = erosionFilterSphere(unitDir * R, unitDir, land.x * maxH, slope, fadeTarget, prm);
    let keep = e.initialFadeWeight;
    let dh = e.heightDelta - fadeTarget * keep;
    // d(fadeTarget)/d(unitDir) where unclamped.
    let fadeGrad = select(vec3<f32>(0.0), relief.yzw * (2.0 / ${wgslNum(cfg.fadeRangeM)}), abs(fadeRaw) < 1.0);
    // The output scales ~linearly with strength: d(dh)/dx += dh / amount * d(amount)/dx.
    let amountGrad = amount.yzw * (dh / max(amount.x, 1e-3));
    let dGrad = e.slopeDelta * (R / maxH) - fadeGrad * (keep / maxH) + amountGrad / maxH;
    r.delta = vec4<f32>(dh / maxH, dGrad);
    return r;
}
`;
}

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
    createTerrainFeatureRivers,
    createTerrainFeatureErosionSeeds,
    createTerrainFeatureErosionFilter,
  } = shaderBundle;
  // Every feature module is part of the shader source (the height function
  // calls them). To switch a feature off use terrain.features or
  // qtDiag.setTerrainFeatures (terrainFeatureToggles.js), not the bundle.
  const missing = [
    'createTerrainCommon', 'createSurfaceCommon', 'createTerrainFeatureContinents',
    'createTerrainFeaturePlains', 'createTerrainFeatureHills', 'createTerrainFeatureMountains',
    'createTerrainFeatureCanyons', 'createTerrainFeatureLoneHills', 'createTerrainFeatureMicro',
    'createTerrainFeatureMesoDetail', 'createTerrainFeatureHighlands', 'createTerrainFeatureRivers',
    'createTerrainFeatureErosionSeeds', 'createTerrainFeatureErosionFilter',
  ].filter(name => typeof shaderBundle[name] !== 'function');
  if (missing.length) {
    throw new Error(
      `terrainShaderBundle is missing ${missing.join(', ')}. All feature modules are required; ` +
      'switch features off with terrain.features or qtDiag.setTerrainFeatures instead.'
    );
  }
  const outputFormat = options?.outputFormat ?? 'rgba32float';
  const hasHeightBindings = options?.hasHeightBindings ?? false;
  const hasTileBindings = options?.hasTileBindings ?? false;
  const hasBaseHeightBinding = hasHeightBindings && options?.hasBaseHeightBinding === true;
  const maxBiomes = options?.maxBiomes ?? 16;
  const useFixedMaterialFamilySplats = options?.fixedMaterialFamiliesEnabled === true;
  const erosionFilterWgsl = createErosionFilterLandWgsl(options?.erosionFilter, createTerrainFeatureErosionFilter);
  const authoredSplatSourceMinProbability = Math.max(
    0.0,
    Math.min(1.0, Number.isFinite(options?.authoredSplatSourceMinProbability)
      ? options.authoredSplatSourceMinProbability
      : 0.18)
  );
  const authoredSplatSourceMinProbabilityFade = Math.max(
    0.001,
    Number.isFinite(options?.authoredSplatSourceMinProbabilityFade)
      ? options.authoredSplatSourceMinProbabilityFade
      : 0.10
  );
  const authoredSplatSourceWinnerSnapStart = Math.max(
    0.0,
    Math.min(1.0, Number.isFinite(options?.authoredSplatSourceWinnerSnapStart)
      ? options.authoredSplatSourceWinnerSnapStart
      : 0.55)
  );
  const authoredSplatSourceWinnerSnapEnd = Math.max(
    authoredSplatSourceWinnerSnapStart + 0.001,
    Math.min(1.0, Number.isFinite(options?.authoredSplatSourceWinnerSnapEnd)
      ? options.authoredSplatSourceWinnerSnapEnd
      : 0.70)
  );

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
    // Bit set = terrain feature off (terrainFeatureToggles.js, TF_*).
    featureDisableMask: u32,
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

    // River channel (walking-skeleton scope: one fixed straight channel).
    // riverAnchor.xyz = unit direction from planet origin to the channel's
    // centerline anchor point; .w = enabled (0/1).
    // riverChannelDir.xyz = unit tangent direction the channel runs along
    // (must be perpendicular to riverAnchor.xyz); .w unused.
    // riverParams = (halfWidth meters, depth meters, length meters, unused).
    // See templates/terrain-shaders/features/featureRivers.wgsl.js.
    riverAnchor: vec4<f32>,
    riverChannelDir: vec4<f32>,
    riverParams: vec4<f32>,

    // Traced river path (HydrologyPrecompute.js): a polyline in the same
    // (along, across) coordinate space riverAnchor/riverChannelDir define,
    // found by steepest-descent flow routing over the real terrain instead
    // of authored as a straight line. Each point is
    // (along, across, widthScale, depthScale) — widthScale/depthScale scale
    // riverParams.x/.y by how much drainage area passes through that point.
    // riverPathCount == 0 means no path was found; featureRiverHeight()
    // falls back to a straight line through riverAnchor/riverChannelDir in
    // that case. See templates/terrain-shaders/features/featureRivers.wgsl.js.
    riverPathCount: i32,
    _riverPathPad0: i32,
    _riverPathPad1: i32,
    _riverPathPad2: i32,
    riverPath: array<vec4<f32>, 16>,

    // Stage-2 confirmed erosion-seed basins (ErosionSeedVerifier.js): of
    // the (up to 9) level-1 candidates featureErosionSeedsHeight() places
    // near the reference point, the ones verified to actually sit in a
    // real basin get upgraded here instead of staying at the level-1
    // nudge's own small size. Each entry is
    // (regionX, regionY, radiusScale, depthScale); regionX/Y are the same
    // integer region coordinates featureErosionSeedsHeight() computes
    // internally, stored as f32 (exact for the small integers involved).
    // erosionConfirmedCount == 0 means nothing survived verification yet
    // (or it hasn't run) — every candidate stays at level-1 nudge size in
    // that case, which is the correct, self-consistent fallback, not an
    // error state. See templates/terrain-shaders/features/featureErosionSeeds.wgsl.js.
    erosionConfirmedCount: i32,
    _erosionConfirmedPad0: i32,
    _erosionConfirmedPad1: i32,
    _erosionConfirmedPad2: i32,
    erosionConfirmed: array<vec4<f32>, 9>,
};

${createBiomeScoringWGSL({ maxBiomes })}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var outputTexture: texture_storage_2d<${outputFormat}, write>;
${hasHeightBindings ? '@group(0) @binding(2) var heightMap: texture_2d<f32>;' : ''}
${hasTileBindings ? '@group(0) @binding(3) var tileMap: texture_2d<f32>;' : ''}
${hasBaseHeightBinding ? '@group(0) @binding(4) var baseHeightMap: texture_2d<f32>;' : ''}
@group(1) @binding(0) var<uniform> biomeConfigUniforms: BiomeUniforms;

const AUTHORED_SPLAT_SOURCE_MIN_PROBABILITY: f32 = ${wgslFloat(authoredSplatSourceMinProbability, 0.18)};
const AUTHORED_SPLAT_SOURCE_MIN_PROBABILITY_FADE: f32 = ${wgslFloat(authoredSplatSourceMinProbabilityFade, 0.10)};
const AUTHORED_SPLAT_SOURCE_WINNER_SNAP_START: f32 = ${wgslFloat(authoredSplatSourceWinnerSnapStart, 0.55)};
const AUTHORED_SPLAT_SOURCE_WINNER_SNAP_END: f32 = ${wgslFloat(authoredSplatSourceWinnerSnapEnd, 0.70)};
const USE_FIXED_MATERIAL_FAMILY_SPLATS: bool = ${useFixedMaterialFamilySplats ? 'true' : 'false'};

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

// Slope (sine of the tilt from local up) of the displaced sphere
// dir * (1 + h * nd) given the height's tangential surface gradient.
fn slopeFromSurfaceGradient(gSurf: vec3<f32>, h: f32) -> f32 {
    let a = 1.0 + h * normalDisplacementScale();
    let b = length(gSurf) * maxTerrainHeightM();
    return b / max(sqrt(a * a + b * b), 1e-12);
}

struct BaseHeightSlope {
    h: f32,
    slope: f32,
}

// Base height and the slope that drives tile classification and micro detail
// (cached in heightBase.g), from one dual-number evaluation: the exact
// surface gradient, independent of texel size, so the same at every LOD.
fn baseHeightSlopeSphere(face: i32, u: f32, v: f32, unitDir: vec3<f32>) -> BaseHeightSlope {
    var r: BaseHeightSlope;
    let hd = calculateTerrainHeightD(uniforms.seed, unitDir);
    r.h = hd.x;
    r.slope = slopeFromSurfaceGradient(terrainSurfaceGradient(hd, unitDir), hd.x);
    return r;
}

${hasHeightBindings ? `
fn sampleHeightAt(coord: vec2<i32>) -> f32 {
    return textureLoad(heightMap, coord, 0).r;
}

// heightMap may be the base-height target with its 1-texel apron (2 texels
// larger than this pass's output, unpadded passes only): this tile's texel
// coord is then at +1.
fn heightInputCoord(coord: vec2<i32>) -> vec2<i32> {
    let d = vec2<i32>(textureDimensions(heightMap)) - vec2<i32>(textureDimensions(outputTexture));
    let padded = abs(uniforms.uvOffset.x) > 0.0 || abs(uniforms.uvOffset.y) > 0.0;
    return coord + select(vec2<i32>(0), vec2<i32>(1), (d == vec2<i32>(2)) & vec2<bool>(!padded));
}

fn sampleMicroHeightProcedural(face: i32, u: f32, v: f32, du: f32, dv: f32) -> f32 {
    let dir = getSpherePoint(face, u, v);
    let wx = dir.x;
    let wy = dir.z;

    let hs = baseHeightSlopeSphere(face, u, v, dir);
    let baseH = hs.h;
    let slope = hs.slope;

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
        dispMeters > 0.0 && terrainFeatureOn(TF_MICRO_DETAIL)
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

// Base height (no micro) at a border-band neighbour of the normal pass.
// - heightBase with the apron (tile generation): always read from it.
// Without the apron (heightBase requested as an output, diagnostics):
// - preferTexture and inside the tile: read heightBase (written by the base
//   pass for this very texel).
// - otherwise evaluate the terrain function at the texel's face UV, rebuilt
//   with main's chunk + pixel / (size - 1) arithmetic for the tile that owns
//   it (this tile, or the adjacent one beyond the edge).
// Shared-edge agreement: an edge texel and the adjacent tile's edge texel
// must see identical values for the two neighbours across the edge, so the
// caller passes preferTexture = false for those; both tiles then evaluate
// the same points in the same shader module. (The base pass is a different
// module and may round the terrain function differently.) Across a face edge
// it falls back to the caller's clamped u, v.
fn borderBaseHeight(face: i32, u: f32, v: f32, coord: vec2<i32>, maxC: vec2<i32>, preferTexture: bool) -> f32 {
${hasBaseHeightBinding ? `    // heightBase with its 1-texel apron holds every neighbour, including the
    // adjacent tiles' texels (written by the same base-pass module on both
    // sides of an edge, so shared-edge normals agree exactly).
    if (all(vec2<i32>(textureDimensions(baseHeightMap)) == maxC + vec2<i32>(3))) {
        return softClampHeight(textureLoad(baseHeightMap, coord + vec2<i32>(1), 0).r, -1.1, 1.8, 0.25);
    }
    let inside = all(coord >= vec2<i32>(0)) && all(coord <= maxC);
    if (preferTexture && inside) {
        return softClampHeight(textureLoad(baseHeightMap, coord, 0).r, -1.1, 1.8, 0.25);
    }
    let usesPaddedSingleChunk = abs(uniforms.uvOffset.x) > 0.0 || abs(uniforms.uvOffset.y) > 0.0;
    let chunks = max(uniforms.chunkGridSize, 1);
    if (uniforms.chunkSize > 1 && !usesPaddedSingleChunk && maxC.x == uniforms.chunkSize - 1 && maxC.y == uniforms.chunkSize - 1) {
        let below = coord < vec2<i32>(0);
        let above = coord > maxC;
        let chunkShift = select(vec2<i32>(0), vec2<i32>(-1), below) + select(vec2<i32>(0), vec2<i32>(1), above);
        let local = select(select(coord, vec2<i32>(1), above), maxC - vec2<i32>(1), below);
        let chunk = uniforms.chunkCoord + chunkShift;
        if (all(chunk >= vec2<i32>(0)) && all(chunk < vec2<i32>(chunks))) {
            let chunkSizePx = vec2<f32>(f32(uniforms.chunkSize));
            let localUV = vec2<f32>(local) / max(chunkSizePx - vec2<f32>(1.0), vec2<f32>(1.0));
            let totalChunks = f32(chunks);
            let uvN = (vec2<f32>(f32(chunk.x), f32(chunk.y)) + localUV) / totalChunks + uniforms.uvOffset;
            return sampleBaseHeightProcedural(face, uvN.x, uvN.y);
        }
    }
` : ''}    return sampleBaseHeightProcedural(face, u, v);
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
    // blendT reaches 1 at edgeDist 2: those texels use the height map only.
    if (edgeDist < 2) {
        let blendT = clamp(f32(edgeDist) / 2.0, 0.0, 1.0);
        // On an edge column (row), the across-edge neighbours are evaluated,
        // not read, so the adjacent tile computes the same values (see
        // borderBaseHeight).
        let readX = coordC.x != 0 && coordC.x != maxC.x;
        let readY = coordC.y != 0 && coordC.y != maxC.y;
        let bR = borderBaseHeight(face, uR, v, coordC + vec2<i32>(1, 0), maxC, readX);
        let bL = borderBaseHeight(face, uL, v, coordC - vec2<i32>(1, 0), maxC, readX);
        let bU = borderBaseHeight(face, u, vU, coordC + vec2<i32>(0, 1), maxC, readY);
        let bD = borderBaseHeight(face, u, vD, coordC - vec2<i32>(0, 1), maxC, readY);
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
    createTerrainFeatureToggleWgsl(),
    erosionFilterWgsl,
    createTerrainCommon(),
    createSurfaceCommon({
        tileCategories: options.tileCategories,
        tileTypes: options.tileTypes,
    }),
    createTerrainFeatureContinents(),
    createTerrainFeaturePlains(),
    createTerrainFeatureHills(),
    createTerrainFeatureMountains(),
    createTerrainFeatureCanyons(),
    createTerrainFeatureLoneHills(),
    createTerrainFeatureMicro(),
    createTerrainFeatureMesoDetail(),
    createTerrainFeatureHighlands(),
    createTerrainFeatureRivers(),
    createTerrainFeatureErosionSeeds(),
    base.base(),
    `
const WATER_1: u32 = SURFACE_WATER;
const GRASS_SHORT_1: u32 = SURFACE_GRASS_BASE;
const ROCK_OUTCROP_1: u32 = SURFACE_ROCK_BASE;

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


fn resolveAuthoredBiomeTileType(
    tileId: u32,
    variant: u32
) -> u32 {
    return resolveCatalogTileVariant(tileId, variant);
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

fn authoredBiomeSpatialCoords(
    wx: f32, wy: f32, unitDir: vec3<f32>
) -> vec2<f32> {
    if (uniforms.face < 0) {
        return vec2<f32>(wx, wy);
    }

    // Feed authored biome scoring with planet-scale metric coordinates instead of
    // near-unit sphere axes, otherwise the deterministic selector collapses into a
    // handful of global cells on large planets.
    let refRadiusM = max(noiseReferenceRadiusM(), 1.0);
    let metricPos = unitDir * refRadiusM;
    return vec2<f32>(metricPos.x, metricPos.z);
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
    let biomeSpatial = authoredBiomeSpatialCoords(wx, wy, unitDir);
    let biome = selectBiomeFromDefs(
        h,
        climate.precipitation,
        climate.temperature,
        slope,
        biomeSpatial.x,
        biomeSpatial.y,
        biomeConfigUniforms
    );
    if (biome.score <= 0.0) {
        // This re-enters the legacy path, which currently re-evaluates climate inside
        // computeSurfaceWeights(). Keep that in mind if authored biomes become sparse.
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

fn legacyTreeTileEligibility(tileId: u32) -> f32 {
    if (isForestFloorTile(tileId)) {
        return 1.0;
    }
    if (isGrassTile(tileId)) {
        return 0.001;
    }
    if (isDirtTile(tileId)) {
        return 0.0002;
    }
    return 0.0;
}

fn legacyClimateTreeEligibility(
    h: f32, wx: f32, wy: f32, unitDir: vec3<f32>, seed: i32
) -> f32 {
    let climate = getClimate(wx, wy, unitDir, h, seed);
    let coldFade = smoothstep(-0.3, 0.0, climate.temperature);
    let dryFade = smoothstep(0.05, 0.25, climate.precipitation);
    let desertFade = 1.0 - smoothstep(0.7, 0.9, climate.temperature)
                         * (1.0 - smoothstep(0.0, 0.15, climate.precipitation));
    return coldFade * dryFade * desertFade;
}

fn authoredTreeEligibility(
    h: f32, slope: f32, wx: f32, wy: f32, unitDir: vec3<f32>, seed: i32
) -> f32 {
    if (biomeConfigUniforms.biomeCount == 0u) {
        return -1.0;
    }

    let climate = getClimate(wx, wy, unitDir, h, seed);
    let biomeSpatial = authoredBiomeSpatialCoords(wx, wy, unitDir);
    let biome = selectBiomeFromDefs(
        h,
        climate.precipitation,
        climate.temperature,
        slope,
        biomeSpatial.x,
        biomeSpatial.y,
        biomeConfigUniforms
    );
    if (biome.score <= 0.0) {
        return -1.0;
    }
    return clamp(biome.treeWeight, 0.0, 1.0);
}

fn debugForcedTileType() -> u32 {
    if (uniforms.debugMode == 20) { return SURFACE_GRASS_BASE; }
    if (uniforms.debugMode == 21) { return SURFACE_SAND_BASE; }
    if (uniforms.debugMode == 22) { return SURFACE_FOREST_FLOOR_BASE; }
    if (uniforms.debugMode == 23) { return SURFACE_DIRT_BASE; }
    return 0xffffffffu;
}

const SMOOTH_SPLAT_WEIGHT_COUNT: u32 = 10u;
const AUTHORED_SMOOTH_MINORITY_FLOOR_MAX: f32 = 0.34;
const AUTHORED_SMOOTH_MINORITY_FLOOR_START: f32 = 0.12;
const AUTHORED_SMOOTH_MINORITY_FLOOR_FULL: f32 = 0.28;
const AUTHORED_SMOOTH_MINORITY_TIE_FADE_START: f32 = 0.36;
const AUTHORED_SMOOTH_MINORITY_TIE_FADE_END: f32 = 0.46;

fn smoothSplatRepresentativeTileId(weightIndex: u32) -> u32 {
    if (weightIndex == 0u) { return SURFACE_GRASS_BASE; }
    if (weightIndex == 1u) { return SURFACE_FOREST_FLOOR_BASE; }
    if (weightIndex == 2u) { return SURFACE_ROCK_BASE; }
    if (weightIndex == 3u) { return SURFACE_SAND_BASE; }
    if (weightIndex == 4u) { return SURFACE_DIRT_BASE; }
    if (weightIndex == 5u) { return SURFACE_SNOW_BASE; }
    if (weightIndex == 6u) { return SURFACE_TUNDRA_BASE; }
    if (weightIndex == 7u) { return SURFACE_MUD_BASE; }
    if (weightIndex == 8u) { return SURFACE_SWAMP_BASE; }
    if (weightIndex == 9u) { return SURFACE_VOLCANIC_BASE; }
    return 255u;
}

fn authoredSmoothSharpenedScore(probability: f32, halfWidth: f32) -> f32 {
    // Smoothstep over the probability range [0.5 - halfWidth, 0.5 + halfWidth].
    // Output is exactly 0 below the low edge and exactly 1 above the high edge.
    // halfWidth = 0.03 is snappy, 0.20 is gradual.
    // Biomes with isolated small patches need wider halfWidth to survive at low probability.
    let hw = clamp(halfWidth, 0.005, 0.5);
    return smoothstep(0.5 - hw, 0.5 + hw, clamp(probability, 0.0, 1.0));
}

fn authoredSmoothSourceGate(probability: f32, topProbability: f32) -> f32 {
    let p = clamp(probability, 0.0, 1.0);
    let floorEnd = min(
        1.0,
        AUTHORED_SPLAT_SOURCE_MIN_PROBABILITY + max(AUTHORED_SPLAT_SOURCE_MIN_PROBABILITY_FADE, 0.001)
    );
    let floorGate = smoothstep(AUTHORED_SPLAT_SOURCE_MIN_PROBABILITY, floorEnd, p);

    let winnerSnap = smoothstep(
        AUTHORED_SPLAT_SOURCE_WINNER_SNAP_START,
        AUTHORED_SPLAT_SOURCE_WINNER_SNAP_END,
        clamp(topProbability, 0.0, 1.0)
    );
    let loserDistance = clamp((topProbability - p) / max(topProbability, 0.0001), 0.0, 1.0);
    let loserGate = 1.0 - winnerSnap * smoothstep(0.20, 0.55, loserDistance);

    return clamp(floorGate * loserGate, 0.0, 1.0);
}

fn encodeSmoothSplatTileId(tileId: u32) -> f32 {
    if (tileId >= 255u) {
        return 1.0;
    }
    return f32(tileId) / 255.0;
}

fn insertSmoothSplatTop4(
    weightIndex: u32,
    weight: f32,
    topIndices: ptr<function, array<u32, 4>>,
    topWeights: ptr<function, array<f32, 4>>
) {
    if (weight <= 0.00001) {
        return;
    }

    var insertAt = 4u;
    for (var i = 0u; i < 4u; i = i + 1u) {
        let currentWeight = (*topWeights)[i];
        let currentIndex = (*topIndices)[i];
        if (
            weight > currentWeight ||
            (abs(weight - currentWeight) <= 0.000001 && weightIndex < currentIndex)
        ) {
            insertAt = i;
            break;
        }
    }
    if (insertAt >= 4u) {
        return;
    }

    var i = 3u;
    loop {
        if (i <= insertAt) {
            break;
        }
        (*topWeights)[i] = (*topWeights)[i - 1u];
        (*topIndices)[i] = (*topIndices)[i - 1u];
        i = i - 1u;
    }
    (*topWeights)[insertAt] = weight;
    (*topIndices)[insertAt] = weightIndex;
}

struct SmoothSplatPayload {
    tileIds: array<u32, 4>,
    weights: array<f32, 4>,
};

fn insertSmoothSplatTileTop4(
    tileId: u32,
    weight: f32,
    payload: ptr<function, SmoothSplatPayload>
) {
    if (weight <= 0.00001 || !isCatalogTile(tileId)) {
        return;
    }

    for (var i = 0u; i < 4u; i = i + 1u) {
        if ((*payload).tileIds[i] == tileId) {
            (*payload).weights[i] = (*payload).weights[i] + weight;
            return;
        }
    }

    var insertAt = 4u;
    for (var i = 0u; i < 4u; i = i + 1u) {
        let currentWeight = (*payload).weights[i];
        let currentTileId = (*payload).tileIds[i];
        if (
            weight > currentWeight ||
            (abs(weight - currentWeight) <= 0.000001 && tileId < currentTileId)
        ) {
            insertAt = i;
            break;
        }
    }
    if (insertAt >= 4u) {
        return;
    }

    var i = 3u;
    loop {
        if (i <= insertAt) {
            break;
        }
        (*payload).weights[i] = (*payload).weights[i - 1u];
        (*payload).tileIds[i] = (*payload).tileIds[i - 1u];
        i = i - 1u;
    }
    (*payload).weights[insertAt] = weight;
    (*payload).tileIds[insertAt] = tileId;
}

fn computeAuthoredSmoothSplatPayload(
    slope: f32,
    elevation: f32,
    wx: f32, wy: f32, unitDir: vec3<f32>,
    seed: i32
) -> SmoothSplatPayload {
    var payload = SmoothSplatPayload(
        array<u32, 4>(255u, 255u, 255u, 255u),
        array<f32, 4>(0.0, 0.0, 0.0, 0.0)
    );

    let count = min(biomeConfigUniforms.biomeCount, MAX_BIOMES);
    if (count == 0u) {
        return payload;
    }

    let climate = getClimate(wx, wy, unitDir, elevation, seed);
    let biomeSpatial = authoredBiomeSpatialCoords(wx, wy, unitDir);
    let biomeSeed = biomeConfigUniforms.worldSeed;
    var scores: array<f32, MAX_BIOMES>;
    var totalScore = 0.0;

    for (var i = 0u; i < count; i = i + 1u) {
        let def = biomeConfigUniforms.biomes[i];
        let envScore = scoreBiomeEnv(
            elevation,
            climate.precipitation,
            climate.temperature,
            slope,
            def,
            biomeSpatial.x,
            biomeSpatial.y,
            biomeSeed
        );
        let noise = biomeRegionalNoise(biomeSpatial.x, biomeSpatial.y, def, biomeSeed);
        let regional = max(0.0, 1.0 + noise * def.noiseStrength);
        let score = envScore * def.baseWeight * regional;
        scores[i] = score;
        totalScore = totalScore + score;
    }

    if (totalScore <= 0.00001) {
        return payload;
    }

    var topProbability = 0.0;
    var topIndex = 0u;
    for (var i = 0u; i < count; i = i + 1u) {
        let probability = scores[i] / totalScore;
        if (probability > topProbability) {
            topProbability = probability;
            topIndex = i;
        }
    }

    // Use only continuous sharpened scores — no per-cell stochastic selection
    // and no minority floor boost. Both introduced discrete spatial boundaries
    // at the biomeSelectionHash cell scale (8m) that appeared as blocky rims.
    var smoothScores: array<f32, MAX_BIOMES>;
    for (var i = 0u; i < count; i = i + 1u) {
        let probability = scores[i] / totalScore;
        if (USE_FIXED_MATERIAL_FAMILY_SPLATS) {
            smoothScores[i] = probability;
        } else {
            var sourceGate = authoredSmoothSourceGate(probability, topProbability);
            if (i == topIndex) {
                sourceGate = 1.0;
            }
            let biomeHalfWidth = biomeConfigUniforms.biomes[i].blendHalfWidth;
            smoothScores[i] = authoredSmoothSharpenedScore(probability, biomeHalfWidth) * sourceGate;
        }
    }

    for (var i = 0u; i < count; i = i + 1u) {
        insertSmoothSplatTileTop4(
            biomeConfigUniforms.biomes[i].tileId,
            smoothScores[i],
            &payload
        );
    }

    return payload;
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
            if (
                uniforms.chunkGridSize > 1 &&
                uniforms.outputType != 2 &&
                uniforms.outputType != 4 &&
                uniforms.outputType != 7 &&
                uniforms.outputType != 8
            ) {
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
                // Base-height apron: a base-pass target 2 texels larger than
                // the chunk (tileGenerator) also holds, around the tile, the
                // adjacent tiles' edge-adjacent texels (index -1 is the
                // previous tile's texel n-2, index n the next tile's texel
                // 1), computed with that tile's own arithmetic so both tiles
                // get bit-identical values. Beyond the face edge it repeats
                // this tile's edge texel. The normal pass reads its border
                // samples from it instead of evaluating the terrain.
                let n = max(uniforms.chunkSize, 1);
                let hasApron = uniforms.outputType == 0 && n > 2
                    && i32(texSize.x) == n + 2 && i32(texSize.y) == n + 2;
                var px = pixelCoord;
                var chunkShift = vec2<i32>(0);
                if (hasApron) {
                    let idx = vec2<i32>(global_id.xy) - vec2<i32>(1);
                    let grid = max(uniforms.chunkGridSize, 1);
                    let below = idx < vec2<i32>(0);
                    let above = idx > vec2<i32>(n - 1);
                    chunkShift = select(vec2<i32>(0), vec2<i32>(-1), below) + select(vec2<i32>(0), vec2<i32>(1), above);
                    var local = select(select(idx, vec2<i32>(1), above), vec2<i32>(n - 2), below);
                    let c = uniforms.chunkCoord + chunkShift;
                    let offFace = vec2<bool>(c.x < 0 || c.x >= grid, c.y < 0 || c.y >= grid);
                    local = select(local, clamp(idx, vec2<i32>(0), vec2<i32>(n - 1)), offFace);
                    chunkShift = select(chunkShift, vec2<i32>(0), offFace);
                    px = vec2<f32>(local);
                }
                let localChunk = floor(px / chunkSizePx);
                let localPixel = px - localChunk * chunkSizePx;

                if (chunkSizePx.x < 2.0) {
                    localUV = vec2<f32>(0.5, 0.5);
                } else {
                    localUV = localPixel / max(chunkSizePx - vec2<f32>(1.0), vec2<f32>(1.0));
                }

                let chunkCoord =
                    vec2<f32>(f32(uniforms.chunkCoord.x + chunkShift.x), f32(uniforms.chunkCoord.y + chunkShift.y))
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
    } else if (uniforms.face >= 0) {
        // ── Compute LOD-stable slope ONCE here ───────────────────────
        // Passes 2 (tile) and 4 (micro) read this from heightBase.g
        // instead of each calling calculateTerrainHeight 4× for finite
        // differences. This is the single biggest win in the pipeline.
        let hs = baseHeightSlopeSphere(uniforms.face, u, v, unitDir);
        h = hs.h;
        stableSlope = hs.slope;
    } else {
        h = calculateTerrainHeight(wx, wy, uniforms.seed, unitDir);
        let ns = computeNormalSlopeFlat(wx, wy);
        stableSlope = ns.slope;
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
    let heightSample = textureLoad(heightMap, heightInputCoord(coordC), 0);
    let h = heightSample.r;
    let slope = heightSample.g;
    ` : `
    var h: f32;
    var slope: f32;
    if (uniforms.face >= 0) {
        let hs = baseHeightSlopeSphere(uniforms.face, u, v, unitDir);
        h = hs.h;
        slope = hs.slope;
    } else {
        h = calculateTerrainHeight(wx, wy, uniforms.seed, unitDir);
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

else if (uniforms.outputType == 7 || uniforms.outputType == 8) {
    let oceanLevel = uniforms.waterParams.y;

    ${hasHeightBindings ? `
    let coordC = vec2<i32>(global_id.xy);
    let heightSample = textureLoad(heightMap, heightInputCoord(coordC), 0);
    let h = heightSample.r;
    let slope = heightSample.g;
    ` : `
    var h: f32;
    var slope: f32;
    if (uniforms.face >= 0) {
        let hs = baseHeightSlopeSphere(uniforms.face, u, v, unitDir);
        h = hs.h;
        slope = hs.slope;
    } else {
        h = calculateTerrainHeight(wx, wy, uniforms.seed, unitDir);
        let ns = computeNormalSlopeFlat(wx, wy);
        slope = ns.slope;
    }
    `}

    if (h <= oceanLevel) {
        if (uniforms.outputType == 7) {
            output = vec4<f32>(1.0, 0.0, 0.0, 0.0);
        } else {
            output = vec4<f32>(
                encodeSmoothSplatTileId(SURFACE_WATER),
                encodeSmoothSplatTileId(255u),
                encodeSmoothSplatTileId(255u),
                encodeSmoothSplatTileId(255u)
            );
        }
    } else if (biomeConfigUniforms.biomeCount > 0u) {
        let payload = computeAuthoredSmoothSplatPayload(slope, h, wx, wy, unitDir, uniforms.seed);
        let totalTop = payload.weights[0] + payload.weights[1] + payload.weights[2] + payload.weights[3];

        if (totalTop <= 0.00001) {
            if (uniforms.outputType == 7) {
                output = vec4<f32>(0.0, 0.0, 0.0, 0.0);
            } else {
                output = vec4<f32>(
                    encodeSmoothSplatTileId(255u),
                    encodeSmoothSplatTileId(255u),
                    encodeSmoothSplatTileId(255u),
                    encodeSmoothSplatTileId(255u)
                );
            }
        } else if (uniforms.outputType == 7) {
            output = vec4<f32>(
                payload.weights[0] / totalTop,
                payload.weights[1] / totalTop,
                payload.weights[2] / totalTop,
                payload.weights[3] / totalTop
            );
        } else {
            output = vec4<f32>(
                encodeSmoothSplatTileId(payload.tileIds[0]),
                encodeSmoothSplatTileId(payload.tileIds[1]),
                encodeSmoothSplatTileId(payload.tileIds[2]),
                encodeSmoothSplatTileId(payload.tileIds[3])
            );
        }
    } else {
        let weights = normalizeSurfaceWeights(
            computeSmoothSplatWeights(slope, h, wx, wy, unitDir, uniforms.seed)
        );

        var topIndices = array<u32, 4>(
            0xffffffffu,
            0xffffffffu,
            0xffffffffu,
            0xffffffffu
        );
        var topWeights = array<f32, 4>(0.0, 0.0, 0.0, 0.0);

        for (var i = 0u; i < SMOOTH_SPLAT_WEIGHT_COUNT; i = i + 1u) {
            insertSmoothSplatTop4(i, surfaceWeightAt(weights, i), &topIndices, &topWeights);
        }

        let totalTop = topWeights[0] + topWeights[1] + topWeights[2] + topWeights[3];
        if (totalTop <= 0.00001) {
            if (uniforms.outputType == 7) {
                output = vec4<f32>(1.0, 0.0, 0.0, 0.0);
            } else {
                output = vec4<f32>(
                    encodeSmoothSplatTileId(SURFACE_GRASS_BASE),
                    encodeSmoothSplatTileId(255u),
                    encodeSmoothSplatTileId(255u),
                    encodeSmoothSplatTileId(255u)
                );
            }
        } else if (uniforms.outputType == 7) {
            output = vec4<f32>(
                topWeights[0] / totalTop,
                topWeights[1] / totalTop,
                topWeights[2] / totalTop,
                topWeights[3] / totalTop
            );
        } else {
            output = vec4<f32>(
                encodeSmoothSplatTileId(smoothSplatRepresentativeTileId(topIndices[0])),
                encodeSmoothSplatTileId(smoothSplatRepresentativeTileId(topIndices[1])),
                encodeSmoothSplatTileId(smoothSplatRepresentativeTileId(topIndices[2])),
                encodeSmoothSplatTileId(smoothSplatRepresentativeTileId(topIndices[3]))
            );
        }
    }
}

${hasTileBindings ? `
else if (uniforms.outputType == 4) {
    let coordC = vec2<i32>(global_id.xy);
    // heightMap here is heightBase: .r = base height, .g = cached stable slope.
    let heightSample = textureLoad(heightMap, heightInputCoord(coordC), 0);
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
        dispMeters > 0.0 && terrainFeatureOn(TF_MICRO_DETAIL)
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
        let authoredEligibility = authoredTreeEligibility(h, slope, wx, wy, unitDir, uniforms.seed);
        if (authoredEligibility >= 0.0) {
            eligibility *= authoredEligibility;
        } else {
            eligibility *= legacyTreeTileEligibility(tileId);
            if (eligibility > 0.0) {
                eligibility *= legacyClimateTreeEligibility(h, wx, wy, unitDir, uniforms.seed);
            }
        }
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
