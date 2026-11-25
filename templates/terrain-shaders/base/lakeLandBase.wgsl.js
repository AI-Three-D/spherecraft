// templates/terrain-shaders/base/lakeLandBase.wgsl.js
//
// The lakeLand generator groups the land terms into size bands so lakes
// can sit between them (features/featureLakeCells.wgsl.js). Plan and
// results: LAKE_CELLS_PLAN.md.
//
// Bands (normalized heights, duals):
//   b0  macro: continental relief, land regions, inland uplift, lone hills,
//       mountains and tectonic uplift, lowland relief
//   b1  foothills and the erosion filter's change (eroded from b0 + foothills,
//       exactly as earthLike)
//   b2  rolling hills, local knolls and meso2's first octave (750 m)
//   b3  meso2's other octaves (375 m, 187 m)
// Same terms, inputs and order as earthLike except: the 25 m lake-basin
// hollows, the demo river channel and the erosion-seed pits are left out
// (lake cells replace them), and the regional valley step is not applied.
// The lakeBasins feature switch turns the lake cells on and off.

import { createEarthlikeConstants } from './earthLikeBase.wgsl.js';
import { createLakeCellsWgsl } from '../features/featureLakeCells.wgsl.js';
import { createFoothillWgsl } from '../features/featureFoothills.wgsl.js';
import { createTerrainFeatureCalderas } from '../features/featureCalderas.wgsl.js';
import { createInlandLandformWgsl } from '../features/featureInlandLandforms.wgsl.js';
import { fellsWgsl } from '../features/featureFells.wgsl.js';
import { fjordsWgsl } from '../features/featureFjords.wgsl.js';
import { coastalCovesWgsl, coastalHillsWgsl } from '../features/featureCoast.wgsl.js';
import { createTectonicReliefWgsl } from '../features/featureTectonicRelief.wgsl.js';
import { createOceanFloorWgsl } from '../features/featureOceanFloor.wgsl.js';

export function createLakeLandConstants() {
    return createEarthlikeConstants();
}

// options.lakeTable: null, 'build' or 'read' (featureLakeCells: the lake table).
export function createLakeLandBase(options = {}) {
    const foothill = createFoothillWgsl(options.foothills);
    const inlandWgsl = createInlandLandformWgsl(options.inlandLandforms);
    const { coastalHills, coves, oceanShelves } = options.landformDetails ?? {};
    const tectonicWgsl = createTectonicReliefWgsl(options.tectonicRelief, options.terrainSeed);
    const lowland = tectonicWgsl && options.tectonicRelief.lowlandReliefM > 0;
    return `
// ==================== Base: lakeLand ====================

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
    ${oceanShelves ? 'landMask: vec4<f32>,' : ''}
}

${createTerrainFeatureCalderas(options.calderas)}
${inlandWgsl}
${options.inlandLandforms?.fells === true ? fellsWgsl : ''}
${options.fjords === true ? fjordsWgsl : ''}
${coastalHills ? coastalHillsWgsl : ''}
${coves ? coastalCovesWgsl : ''}
${tectonicWgsl}
${createOceanFloorWgsl(oceanShelves)}

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
    let regional = ${coves ? 'coastalCoves_d(unitDir, seed, foundationData.regional)' : 'foundationData.regional'};
    out.landBlend = dSmoothstep(0.15, 0.45, regional.landMask);
    if (out.landBlend.x > 0.0) {
        var b0 = select(dConst(0.0), regional.baseElevation * amp.continentalShelf, terrainFeatureOn(TF_CONTINENT_RELIEF));
        ${coastalHills ? 'b0 += coastalHillsHeight_d(unitDir, seed, regional);' : ''}
        var region: LandRegionD;
        region.coord = dConst(REGION_HIGHLAND_START);
        region.height = dConst(0.0);
        region.rough = dConst(1.0);
        if (terrainFeatureOn(TF_LAND_REGIONS)) {
            region = foundationData.region;
            b0 += region.height;
        }
        let mountainsH = featureMountainsHeight_d(unitDir, seed);
        ${tectonicWgsl ? `let tectonic = tectonicRelief_d(unitDir, seed, regional.landMask, mountainsH, region.coord);
        b0 += tectonic.upland;` : ''}
        let calderaFoundation = b0${lowland ? ' + tectonic.lowland' : ''};
        var foothillsH = dConst(0.0);
        if (terrainFeatureOn(TF_FOOTHILLS)) {
            let footBand = ${foothill.band};
            if (footBand.x > 0.0) {
                ${foothill.calculation}
            }
        }
        let bigHillsH = featureBigHillsHeight_d(unitDir, seed, amp);
        ${tectonicWgsl ? 'b0 += tectonic.mountains;' : ''}
        b0 += bigHillsH + mountainsH;
        let relief = foothillsH + bigHillsH + mountainsH${tectonicWgsl ? ' + tectonic.upland + tectonic.mountains' : ''};
        let mountainRelief = mountainsH${tectonicWgsl ? ' + tectonic.mountains' : ''};
        let mtnCarve = dQuintic(dClamp((mountainRelief * maxTerrainHeightM() - dConst(MTN_EROSION_START_M)) * (1.0 / (MTN_EROSION_FULL_M - MTN_EROSION_START_M)), 0.0, 1.0));
        let er = erosionFilterLand_d(unitDir, b0 + foothillsH, relief, mtnCarve);
        ${lowland ? 'b0 += tectonic.lowland;' : ''}
        ${options.inlandLandforms?.fells === true ? 'b0 += fellRelief_d(unitDir, seed, regional.landMask, bigHillsH + mountainRelief);' : ''}
        out.b1 = foothillsH + er.delta;
        var b2 = dMul(featureRollingHillsHeight_d(unitDir, seed, regional, profile, amp), region.rough);
        ${tectonicWgsl ? 'b2 += tectonic.localHills;' : ''}
        if (terrainFeatureOn(TF_MESO2)) {
            let mesoRoughness = dSmoothMax(regional.terrainType, regional.ruggedness * 0.5, 0.02);
            let meso = lakeLandMeso_d(unitDir, seed, profile, mesoRoughness);
            let mesoW = dMul(dConst(1.0) - er.amount * (1.0 - EROSION_MESO_KEEP), region.rough) * (DISP_MESO2 / maxTerrainHeightM());
            b2 += dMul(meso.first, mesoW);
            out.b3 = dMul(meso.rest, mesoW);
        }
        out.b2 = b2;
        // Distribute the fill blend across the bands: lake planning can omit
        // the finer bands without exposing their inverse in the macro band.
        let caldera = calderaBlend_d(unitDir, seed, b0 + out.b1 + out.b2 + out.b3, calderaFoundation);
        let calderaKeep = dConst(1.0) - caldera.weight;
        b0 = dMix(b0, caldera.surface, caldera.weight) + caldera.rounding;
        out.b1 = dMul(out.b1, calderaKeep);
        out.b2 = dMul(out.b2, calderaKeep);
        out.b3 = dMul(out.b3, calderaKeep);
        ${inlandWgsl ? `
        let inland = inlandLandformBlend_d(unitDir, seed, regional.landMask, b0 + out.b1 + out.b2 + out.b3, calderaFoundation);
        let inlandKeep = dConst(1.0) - inland.weight;
        b0 = dMix(b0, inland.surface, inland.weight) + inland.rounding;
        out.b1 = dMul(out.b1, inlandKeep);
        out.b2 = dMul(out.b2, inlandKeep);
        out.b3 = dMul(out.b3, inlandKeep);
        ` : ''}
        if (terrainFeatureOn(TF_INLAND_UPLIFT)) {
            let interior = dSmoothstep(0.55, 0.85, regional.landMask);
            b0 += interior * (amp.microGain + 0.005);
        }
        ${options.fjords === true ? `
        let fjord = fjordProfile_d(unitDir, seed, profile, regional.landMask);
        b0 += fjord.shoulders;
        let floor = fjordFloor();
        let fjordWeight = dMul(fjord.cut, fjordCutWeight_d(b0 + out.b1 + out.b2 + out.b3, floor));
        let fjordKeep = dConst(1.0) - fjordWeight;
        // Use the same cut in lake assessment and visible terrain.
        b0 = dMix(b0, floor, fjordWeight);
        out.b1 = dMul(out.b1, fjordKeep);
        out.b2 = dMul(out.b2, fjordKeep);
        out.b3 = dMul(out.b3, fjordKeep);
        ` : ''}
        out.b0 = b0;
    }
    if (out.landBlend.x < 1.0) {
        out.ocean = oceanFloorHeight_d(unitDir, seed, amp.oceanDepth);
        ${oceanShelves ? 'out.landMask = regional.landMask;' : ''}
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
    let ground = dMix(B.ocean, land, B.landBlend);
    return softClampHeight_d(${oceanShelves ? 'oceanShelfHeight_d(ground, B.landMask)' : 'ground'}, -1.1, 1.8, 0.25);
}

fn terrainSurfaceGradient(hd: vec4<f32>, unitDir: vec3<f32>) -> vec3<f32> {
    let g = hd.yzw;
    return (g - unitDir * dot(unitDir, g)) / noiseReferenceRadiusM();
}
${createLakeCellsWgsl(undefined, { table: options?.lakeTable ?? null })}
`;
}
