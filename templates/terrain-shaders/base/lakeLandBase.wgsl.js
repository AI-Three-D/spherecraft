// templates/terrain-shaders/base/lakeLandBase.wgsl.js
//
// Experimental base generator 'lakeLand' (planet terrainGeneration
// baseGenerator): the earthLike land terms, grouped into size bands so lakes
// can sit between them (features/featureLakeCells.wgsl.js). Plan and
// results: LAKE_CELLS_PLAN.md.
//
// Bands (normalized heights, duals):
//   b0  macro: continental relief, land regions, inland uplift, lone hills,
//       mountains
//   b1  foothills and the erosion filter's change (eroded from b0 + foothills,
//       exactly as earthLike)
//   b2  rolling hill chains and meso2's first octave (750 m)
//   b3  meso2's other octaves (375 m, 187 m)
// Same terms, inputs and order as earthLike except: the 25 m lake-basin
// hollows, the demo river channel and the erosion-seed pits are left out
// (lake cells replace them), and the regional valley step is not applied.
// The lakeBasins feature switch turns the lake cells on and off.

import { createEarthlikeConstants } from './earthLikeBase.wgsl.js';
import { createLakeCellsWgsl } from '../features/featureLakeCells.wgsl.js';

export function createLakeLandConstants() {
    return createEarthlikeConstants();
}

// options.lakeTable: null, 'build' or 'read' (featureLakeCells: the lake table).
export function createLakeLandBase(options = {}) {
    return `
// ==================== Base: lakeLand (experiment) ====================

fn getTerrainAmplitudes(profile: TerrainProfile) -> TerrainAmplitudes {
    var amp: TerrainAmplitudes;
    amp.oceanDepth = AMP_OCEAN_DEPTH;
    amp.continentalShelf = AMP_CONTINENT_SHELF * profile.baseBias;
    amp.plainsVariation = AMP_PLAINS * profile.baseBias;
    amp.hillsHeight = AMP_HILLS * profile.hillBias;
    amp.mountainHeight = profile.mountainBias;
    amp.canyonDepth = AMP_CANYON_DEPTH * profile.canyonBias;
    amp.microGain = MICRO_HEIGHT_GAIN * profile.microGain;
    let erosion = clamp(uniforms.erosionParams.y, 0.0, 1.0);
    amp.mountainHeight *= (1.0 - erosion * 0.2);
    amp.hillsHeight *= (1.0 - erosion * 0.1);
    amp.canyonDepth *= (1.0 + erosion * 0.25);
    amp.loneHillsHeight = 1.0 * profile.hillBias;
    amp.loneHillsHeight *= (1.0 - erosion * 0.15);
    return amp;
}

fn calculateTerrainHeight(wx: f32, wy: f32, seed: i32, unitDir: vec3<f32>) -> f32 {
    return calculateTerrainHeightD(seed, unitDir).x;
}

fn calculateTerrainHeightD(seed: i32, unitDir: vec3<f32>) -> vec4<f32> {
    let natural = calculateTerrainHeightBaseD(seed, unitDir);
    return riverCarveTerrain_d(regionalBasinApply_d(natural, unitDir), unitDir);
}

struct LandBands {
    b0: vec4<f32>, b1: vec4<f32>, b2: vec4<f32>, b3: vec4<f32>,
    landBlend: vec4<f32>, ocean: vec4<f32>,
}

// featureMesoDetail_d with its fbm split into the first octave and the other
// two (the same terms and sum as fbm3D_d: 3 octaves, gain 0.5, lacunarity 2).
struct MesoSplit { first: vec4<f32>, rest: vec4<f32>, }
fn lakeLandMeso_d(unitDir: vec3<f32>, seed: i32, profile: TerrainProfile, roughness: vec4<f32>) -> MesoSplit {
    let roughMod = dSmoothstep(0.05, 0.40, roughness);
    let localVar = fbmAuto_d(unitDir, 1.5, 2, seed + 9500, 2.0, 0.5);
    let quietPatch = dMix(dConst(0.20), dConst(1.0), dSmoothstep(-0.4, 0.2, localVar));
    let regionVar = fbmAuto_d(unitDir, 10.0, 2, seed + 9550, 2.0, 0.5);
    let regionMod = dMix(dConst(0.35), dConst(1.0), dSmoothstep(-0.3, 0.3, regionVar));
    let modulation = dMul(dMul(roughMod, quietPatch), regionMod) * clamp(profile.microGain, 0.0, 5.0);
    let R = max(noiseReferenceRadiusM(), 1.0);
    let w = wavelength_m(SCALE_MESO2, GEOLOGY_SCALE);
    let p = rotateDomain3(sphereDomainPos(unitDir, R) / w);
    let n0 = perlin3D_d(p, seed + 9800);
    let n1 = perlin3D_d(p * 2.0, seed + 9801);
    let n2 = perlin3D_d(p * 4.0, seed + 9802);
    let k = (R / w) / 1.75;
    var out: MesoSplit;
    out.first = dMul(vec4<f32>(n0.x / 1.75, rotateDomain3Transpose(n0.yzw) * k), modulation);
    out.rest = dMul(vec4<f32>((n1.x * 0.5 + n2.x * 0.25) / 1.75,
        rotateDomain3Transpose(n1.yzw * 1.0 + n2.yzw * 1.0) * k), modulation);
    return out;
}

fn landBands_d(seed: i32, unitDir: vec3<f32>) -> LandBands {
    var out: LandBands;
    let profile = getTerrainProfile();
    let amp = getTerrainAmplitudes(profile);
    let foundationData = terrainMacro_d(unitDir, seed, profile);
    let regional = foundationData.regional;
    out.landBlend = dSmoothstep(0.15, 0.45, regional.landMask);
    if (out.landBlend.x > 0.0) {
        var b0 = select(dConst(0.0), regional.baseElevation * amp.continentalShelf, terrainFeatureOn(TF_CONTINENT_RELIEF));
        var region: LandRegionD;
        region.coord = dConst(REGION_HIGHLAND_START);
        region.height = dConst(0.0);
        region.rough = dConst(1.0);
        if (terrainFeatureOn(TF_LAND_REGIONS)) {
            region = foundationData.region;
            b0 += region.height;
        }
        let style = terrainStyle_d(unitDir);
        var foothillsH = dConst(0.0);
        if (terrainFeatureOn(TF_FOOTHILLS)) {
            let footBand = dSmoothstep(FOOTHILL_TT_START, FOOTHILL_TT_FULL, regional.terrainType);
            if (footBand.x > 0.0) {
                let hillN = fbmAuto_d(unitDir, SCALE_FOOTHILLS, 3, seed + 1950, 2.0, 0.5);
                foothillsH = dMul(footBand, dSmoothstep(-0.3, 0.6, hillN)) * ((HEIGHT_FOOTHILLS / maxTerrainHeightM()) * amp.mountainHeight);
            }
        }
        let bigHillsH = featureBigHillsHeight_d(unitDir, seed, amp);
        let mountainsH = featureMountainsHeight_d(unitDir, seed);
        b0 += bigHillsH + mountainsH;
        let relief = foothillsH + bigHillsH + mountainsH;
        let mtnCarve = dQuintic(dClamp((mountainsH * maxTerrainHeightM() - dConst(MTN_EROSION_START_M)) * (1.0 / (MTN_EROSION_FULL_M - MTN_EROSION_START_M)), 0.0, 1.0));
        let er = erosionFilterLand_d(unitDir, b0 + foothillsH, relief, style, mtnCarve);
        out.b1 = foothillsH + er.delta;
        var b2 = dMul(featureRollingHillsHeight_d(unitDir, seed, regional, profile, amp), region.rough);
        if (terrainFeatureOn(TF_MESO2)) {
            let mesoRoughness = dSmoothMax(regional.terrainType, regional.ruggedness * 0.5, 0.02);
            let meso = lakeLandMeso_d(unitDir, seed, profile, mesoRoughness);
            let mesoW = dMul(dConst(1.0) - er.amount * (1.0 - EROSION_MESO_KEEP), region.rough) * (DISP_MESO2 / maxTerrainHeightM());
            b2 += dMul(meso.first, mesoW);
            out.b3 = dMul(meso.rest, mesoW);
        }
        out.b2 = b2;
        if (terrainFeatureOn(TF_INLAND_UPLIFT)) {
            let interior = dSmoothstep(0.55, 0.85, regional.landMask);
            b0 += interior * (amp.microGain + 0.005);
        }
        out.b0 = b0;
    }
    if (out.landBlend.x < 1.0) {
        var oceanVariation = dConst(0.0);
        if (terrainFeatureOn(TF_OCEAN_FLOOR)) {
            let n500m = fbmAuto_d(unitDir, 0.5, 4, seed + 1000, 2.0, 0.5);
            let n100m = fbmAuto_d(unitDir, 0.1, 4, seed + 2000, 2.0, 0.5);
            let n20m = fbmAuto_d(unitDir, 0.02, 3, seed + 3000, 2.0, 0.5);
            oceanVariation = n500m * 0.05 + n100m * 0.02 + n20m * 0.005;
        }
        out.ocean = dConst(uniforms.waterParams.y + amp.oceanDepth) + oceanVariation;
    }
    return out;
}

// The terrain before the river carve: land bands, the lake cells, the ocean.
fn calculateTerrainHeightBaseD(seed: i32, unitDir: vec3<f32>) -> vec4<f32> {
    let B = landBands_d(seed, unitDir);
    var land = B.b0 + B.b1 + B.b2 + B.b3;
    if (B.landBlend.x > 0.0 && terrainFeatureOn(TF_LAKE_BASINS)) {
        let lake = lakeFind(seed, unitDir, B);
        if (lake.any) { land = lakeCellsApply_d(land, B, lake); }
    }
    if (B.landBlend.x >= 1.0) {
        return softClampHeight_d(land, -1.1, 1.8, 0.25);
    }
    return softClampHeight_d(dMix(B.ocean, land, B.landBlend), -1.1, 1.8, 0.25);
}

fn terrainSurfaceGradient(hd: vec4<f32>, unitDir: vec3<f32>) -> vec3<f32> {
    let g = hd.yzw;
    return (g - unitDir * dot(unitDir, g)) / noiseReferenceRadiusM();
}
${createLakeCellsWgsl(undefined, { table: options?.lakeTable ?? null })}
`;
}
