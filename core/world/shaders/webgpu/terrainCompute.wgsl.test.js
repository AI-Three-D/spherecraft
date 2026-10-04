import { describe, expect, it } from 'vitest';
import { parseWgsl, validate } from 'naga-wasm';
import { createAdvancedTerrainComputeShader } from './advancedTerrainCompute.wgsl.js';
import { createTerrainCommon } from '../../../../templates/terrain-shaders/terrainCommon.wgsl.js';
import { createSurfaceCommon } from '../../../../templates/terrain-shaders/surfaceCommon.wgsl.js';
import { createTerrainFeatureContinents } from '../../../../templates/terrain-shaders/features/featureContinents.wgsl.js';
import { createTerrainFeaturePlains } from '../../../../templates/terrain-shaders/features/featurePlains.wgsl.js';
import { createTerrainFeatureHills } from '../../../../templates/terrain-shaders/features/featureHills.wgsl.js';
import { createTerrainFeatureMountains } from '../../../../templates/terrain-shaders/features/featureMountains.wgsl.js';
import { createTerrainFeatureCanyons } from '../../../../templates/terrain-shaders/features/featureCanyons.wgsl.js';
import { createTerrainFeatureLoneHills } from '../../../../templates/terrain-shaders/features/featureLoneHills.wgsl.js';
import { createTerrainFeatureMicro } from '../../../../templates/terrain-shaders/features/featureMicro.wgsl.js';
import { createTerrainFeatureMesoDetail } from '../../../../templates/terrain-shaders/features/featureMesoDetail.wgsl.js';
import { createTerrainFeatureHighlands } from '../../../../templates/terrain-shaders/features/featureHighlands.wgsl.js';
import { createTerrainFeatureRivers } from '../../../../templates/terrain-shaders/features/featureRivers.wgsl.js';
import { createTerrainFeatureErosionSeeds } from '../../../../templates/terrain-shaders/features/featureErosionSeeds.wgsl.js';
import { createTerrainFeatureErosionFilter } from '../../../../templates/terrain-shaders/features/featureErosionFilter.wgsl.js';
import { createEarthlikeConstants, createEarthlikeBase } from '../../../../templates/terrain-shaders/base/earthLikeBase.wgsl.js';
import { TILE_TYPES, TILE_CATEGORIES } from '../../../../templates/configs/tileTypes.js';

// Compiles the terrain generation shader the way
// WebGPUTerrainGenerator.initializePipelines assembles it, and validates it
// with naga (wgpu's shader compiler, as WebAssembly): catches WGSL syntax,
// scope and type errors without a GPU.

// Same bundle as wizard_game/gameEngine.js TERRAIN_SHADER_BUNDLE.
const TERRAIN_SHADER_BUNDLE = {
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
    baseGenerators: {
        earthLike: { constants: createEarthlikeConstants, base: createEarthlikeBase }
    }
};

function compile(code) {
    try {
        validate(parseWgsl(code));
        return null;
    } catch (error) {
        return error?.formatted ?? String(error);
    }
}

describe('terrain generation compute shader', () => {
    const base = {
        baseGenerator: 'earthLike',
        maxBiomes: 16,
        terrainShaderBundle: TERRAIN_SHADER_BUNDLE,
        tileCategories: TILE_CATEGORIES,
        tileTypes: TILE_TYPES,
        fixedMaterialFamiliesEnabled: true
    };
    // The three modules initializePipelines builds.
    const variants = {
        terrain: {},
        heightInput: { hasHeightBindings: true },
        micro: { hasHeightBindings: true, hasTileBindings: true },
        terrainAnalyticSlope: { analyticSlope: true },
        heightInputAnalyticSlope: { hasHeightBindings: true, analyticSlope: true },
        heightInputBaseHeight: { hasHeightBindings: true, hasBaseHeightBinding: true },
        erosionFilter: { analyticSlope: true, erosionFilter: { enabled: true, scale: 1500, strength: 0.22, gullyWeight: 0.5, detail: 1.5, rounding: [0.1, 0, 0.1, 2], onset: [1.25, 1.25, 2.8, 1.5], assumedSlope: [0.7, 1], octaves: 5, lacunarity: 2, gain: 0.5, cellScale: 0.7, normalization: 0.5, normalSquash: 2.5, fadeRangeM: 1200, reliefStartM: 150, reliefFullM: 600, lowReliefAmount: 0.2, variationScaleM: 15000, variationMin: 0.15, mesoKeep: 0.35, seed: 7 } },
        microErosionFilter: { hasHeightBindings: true, hasTileBindings: true, erosionFilter: { enabled: true, scale: 1500, strength: 0.22, gullyWeight: 0.5, detail: 1.5, rounding: [0.1, 0, 0.1, 2], onset: [1.25, 1.25, 2.8, 1.5], assumedSlope: [0.7, 1], octaves: 5, lacunarity: 2, gain: 0.5, cellScale: 0.7, normalization: 0.5, normalSquash: 2.5, fadeRangeM: 1200, reliefStartM: 150, reliefFullM: 600, lowReliefAmount: 0.2, variationScaleM: 15000, variationMin: 0.15, mesoKeep: 0.35, seed: 7 } }
    };
    for (const [name, extra] of Object.entries(variants)) {
        it(`${name} variant compiles`, () => {
            const code = createAdvancedTerrainComputeShader({ ...base, ...extra });
            expect(compile(code)).toBeNull();
        });
    }
});
