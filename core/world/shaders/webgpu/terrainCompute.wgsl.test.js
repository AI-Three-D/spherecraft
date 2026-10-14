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
import { createTerrainFeatureRivers } from '../../../../templates/terrain-shaders/features/featureRivers.wgsl.js';
import { createTerrainFeatureErosionSeeds } from '../../../../templates/terrain-shaders/features/featureErosionSeeds.wgsl.js';
import { createTerrainFeatureErosionFilter } from '../../../../templates/terrain-shaders/features/featureErosionFilter.wgsl.js';
import { createEarthlikeConstants, createEarthlikeBase } from '../../../../templates/terrain-shaders/base/earthLikeBase.wgsl.js';
import { TILE_TYPES, TILE_CATEGORIES } from '../../../../templates/configs/tileTypes.js';
import { TerrainGenerationConfig } from '../../../../templates/configs/terrainGenerationConfig.js';
import { createRegionalTerrainBakeWgsl, createRegionalTerrainBoundsWgsl } from '../../terrain-generator/regionalTerrain.wgsl.js';
import {createRegionalValleyAnchorWgsl} from '../../terrain-generator/regionalValleyFeature.wgsl.js';
import {createRegionalShapeBakeWgsl} from '../../terrain-generator/regionalShape.wgsl.js';
import { terrainDisplacementBudgets } from '../../terrain-generator/terrainHeightContract.js';
import { createRegionalBasinCertificateWgsl, createRegionalRouteHeightWgsl, createRegionalPlacementSurveyWgsl } from '../../terrain-generator/regionalBasins.wgsl.js';

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
    it('compiles the river cross-section, and the shore materials only when selected',()=>{
        for(const shape of [false,true])for(const inputs of [{},{hasHeightBindings:true},{hasHeightBindings:true,hasTileBindings:true}]) {
            const src=createAdvancedTerrainComputeShader({...base,waterCarve:true,riverBankDetail:true,
                regionalTerrain:true,regionalShape:shape,...inputs});
            expect(compile(src)).toBeNull();
            expect(src).toContain('riverSection_d(nD, hwD, bed, D');
            expect(src).toContain('let shoreNoise = waterBankNoise');
        }
        const plain=createAdvancedTerrainComputeShader({...base,waterCarve:true});
        expect(compile(plain)).toBeNull();
        expect(plain).toContain('riverSection_d(nD, hwD, bed, D');
        expect(plain).not.toContain('let shoreNoise = waterBankNoise');
    });
    const base = {
        baseGenerator: 'earthLike',
        maxBiomes: 16,
        terrainShaderBundle: TERRAIN_SHADER_BUNDLE,
        tileCategories: TILE_CATEGORIES,
        tileTypes: TILE_TYPES,
        fixedMaterialFamiliesEnabled: true,
        erosionFilter: new TerrainGenerationConfig({}).erosionFilter
    };
    // The three modules initializePipelines builds.
    const variants = {
        terrain: {},
        heightInput: { hasHeightBindings: true },
        micro: { hasHeightBindings: true, hasTileBindings: true },
        heightInputBaseHeight: { hasHeightBindings: true, hasBaseHeightBinding: true },
        smoothSplatPair: { hasHeightBindings: true, hasSmoothSplatIdsBinding: true, outputFormat: 'rgba8unorm' }
    };
    for (const [name, extra] of Object.entries(variants)) {
        it(`${name} variant compiles with persistent regional input`, () => {
            const code = createAdvancedTerrainComputeShader({ ...base, ...extra,
                regionalTerrain: true, waterCarve: true, riverValley: true });
            expect(compile(code)).toBeNull();
        });
        it(`${name} variant compiles`, () => {
            const code = createAdvancedTerrainComputeShader({ ...base, ...extra });
            expect(compile(code)).toBeNull();
        });
        // With the river carve (riverCarve.wgsl.js, group 1 bindings 1-3).
        it(`${name} variant compiles with the river carve`, () => {
            const code = createAdvancedTerrainComputeShader({ ...base, ...extra, waterCarve: true });
            expect(code).toContain('fn riverCarve_d');
            expect(code).toMatch(/@group\(1\) @binding\(3\) var<storage, read> waterRivers/);
            expect(compile(code)).toBeNull();
        });
        // With the river valleys (riverValley.wgsl.js, group 1 bindings 4-7).
        it(`${name} variant compiles with the river valleys`, () => {
            const code = createAdvancedTerrainComputeShader({ ...base, ...extra, waterCarve: true, riverValley: true });
            expect(code).toContain('fn valleyShapeAt');
            expect(code).toMatch(/@group\(1\) @binding\(5\) var<storage, read> valleyTexels/);
            expect(compile(code)).toBeNull();
        });
    }
    it('macro controls and conservative bounds generation compile', () => {
        const budgets = terrainDisplacementBudgets({ erosionFilter: base.erosionFilter });
        const code = createAdvancedTerrainComputeShader(base) + createRegionalTerrainBakeWgsl()
            + createRegionalTerrainBoundsWgsl(budgets, 4);
        expect(compile(code)).toBeNull();
    });
    it('valley survey and slope-aware local certificates compile', () => {
        const budgets=terrainDisplacementBudgets({erosionFilter:base.erosionFilter});
        expect(compile(createAdvancedTerrainComputeShader({...base,regionalTerrain:true})
            +createRegionalBasinCertificateWgsl(base.erosionFilter,budgets,{slopeAware:true})
            +createRegionalPlacementSurveyWgsl())).toBeNull();
    });
    it('generation-owned valley terrain and macro-only anchor compile',()=>{
        expect(compile(createAdvancedTerrainComputeShader({...base,regionalTerrain:true,regionalValleyFeature:true}))).toBeNull();
        expect(compile(createAdvancedTerrainComputeShader({...base,regionalTerrain:true})+createRegionalValleyAnchorWgsl())).toBeNull();
    });
    it('authoritative eroded shape generation and all fine consumers compile',()=>{
        expect(compile(createAdvancedTerrainComputeShader({...base,regionalTerrain:true})+createRegionalShapeBakeWgsl())).toBeNull();
        for(const extra of Object.values(variants)) expect(compile(createAdvancedTerrainComputeShader({...base,...extra,regionalTerrain:true,regionalShape:true}))).toBeNull();
    });
    it('local basin certificates compile against the existing terrain equations', () => {
        const budgets=terrainDisplacementBudgets({erosionFilter:base.erosionFilter});
        expect(compile(createAdvancedTerrainComputeShader({...base,regionalTerrain:true})
            +createRegionalBasinCertificateWgsl(base.erosionFilter,budgets)+createRegionalRouteHeightWgsl())).toBeNull();
    });
    it('light route sampling compiles with macro inputs and optional reused authoritative shape',()=>{
        const budgets=terrainDisplacementBudgets({erosionFilter:base.erosionFilter});
        for(const shape of [false,true])expect(compile(createAdvancedTerrainComputeShader({...base,
            regionalTerrain:true,regionalShape:shape})+createRegionalBasinCertificateWgsl(base.erosionFilter,budgets)
            +createRegionalRouteHeightWgsl({source:'foundation',shape}))).toBeNull();
    });
});
