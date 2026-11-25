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
import { createLakeLandConstants, createLakeLandBase } from '../../../../templates/terrain-shaders/base/lakeLandBase.wgsl.js';
import { TILE_TYPES, TILE_CATEGORIES } from '../../../../templates/configs/tileTypes.js';
import { TerrainGenerationConfig } from '../../../../templates/configs/terrainGenerationConfig.js';
import worldTerrain from '../../../../wizard_game/world/terrain.json';
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
        earthLike: { constants: createEarthlikeConstants, base: createEarthlikeBase },
        lakeLand: { constants: createLakeLandConstants, base: createLakeLandBase }
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
    it('compiles the river field, and the shore materials only when selected',()=>{
        for(const shape of [false,true])for(const inputs of [{},{hasHeightBindings:true},{hasHeightBindings:true,hasTileBindings:true}]) {
            const src=createAdvancedTerrainComputeShader({...base,waterCarve:true,riverBankDetail:true,
                regionalTerrain:true,regionalShape:shape,...inputs});
            expect(compile(src)).toBeNull();
            expect(src).toContain('fn riverFieldDelta_d');
            // Lake beds are mud too: the lake lookup in group 1 (bindings 7-9).
            expect(src).toMatch(/@group\(1\) @binding\(7\) var<storage, read> waterLakes/);
            expect(src).toMatch(/@group\(1\) @binding\(9\) var riverCarveLakeSampler: sampler/);
        }
        const plain=createAdvancedTerrainComputeShader({...base,waterCarve:true});
        expect(compile(plain)).toBeNull();
        expect(plain).toContain('fn riverFieldDelta_d');
        expect(plain).not.toContain('waterLakes');
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
    it('compiles glaciers, marsh and optional desert dunes in every landscape tile pipeline', () => {
        const config = new TerrainGenerationConfig({ ...worldTerrain, biomeLandscape: { preset: 'arid' } });
        for (const [baseGenerator, lakeTable] of [['earthLike', null], ['lakeLand', 'build'], ['lakeLand', 'read']]) {
            const landscapeVariants = [...Object.values(variants), { hasHeightBindings: true, hasBiomeClimateBinding: true, outputFormat: 'rgba8unorm' }];
            for (const variant of landscapeVariants) {
                const source = createAdvancedTerrainComputeShader({
                    ...base, ...config, ...variant, baseGenerator, lakeTable, waterCarve: true, riverBankDetail: true,
                });
                expect(source).toContain('fn biomeDunes_d(');
                expect(source).toContain('fn mountainGlacierValley(');
                expect(compile(source)).toBeNull();
            }
        }
    });

    it('compiles the selected mountain model for terrain and lake sampling', () => {
        for (const baseGenerator of ['earthLike', 'lakeLand']) {
            for (const lakeTable of baseGenerator === 'lakeLand' ? ['build', 'read'] : [null]) {
                const options = { ...base, baseGenerator, lakeTable, mountainRangeModel: 'directional' };
                const source = createAdvancedTerrainComputeShader(options);
                expect(source).toContain('fn rangeDirectionalNoise_d');
                expect(compile(source)).toBeNull();
            }
        }
        const oldSource = createAdvancedTerrainComputeShader(base);
        expect(oldSource).not.toContain('fn rangeDirectionalNoise_d');
        expect(createAdvancedTerrainComputeShader({ ...base, mountainRangeModel: 'directional' })).not.toBe(oldSource);
        expect(() => createAdvancedTerrainComputeShader({ ...base, mountainRangeModel: 'invalid' })).toThrow();
    });
    it('compiles regional foothills in terrain and lake-table variants', () => {
        for (const baseGenerator of ['earthLike', 'lakeLand']) {
            for (const lakeTable of baseGenerator === 'lakeLand' ? ['build', 'read'] : [null]) {
                const src = createAdvancedTerrainComputeShader({ ...base, baseGenerator, lakeTable,
                    foothills: { model: 'regional' }, mountainRangeModel: 'directional', waterCarve: true });
                expect(src).toContain('let broadStretch = vec3<f32>(0.48, 1.0, 1.0)');
                expect(compile(src)).toBeNull();
            }
        }
        expect(createAdvancedTerrainComputeShader(base)).not.toContain('let broadStretch = vec3<f32>(0.48, 1.0, 1.0)');
        expect(() => createAdvancedTerrainComputeShader({ ...base, foothills: { model: 'regional', strength: -1 } })).toThrow();
    });
    it('compiles calderas in terrain, lake construction and all fine consumers', () => {
        for (const baseGenerator of ['earthLike', 'lakeLand']) {
            for (const lakeTable of baseGenerator === 'lakeLand' ? [null, 'build', 'read'] : [null]) {
                for (const extra of Object.values(variants)) {
                    const source = createAdvancedTerrainComputeShader({ ...base, ...extra, baseGenerator, lakeTable,
                        calderas: { enabled: true }, mountainRangeModel: 'directional', foothills: { model: 'regional' }, waterCarve: true });
                    expect(compile(source)).toBeNull();
                }
            }
        }
        expect(createAdvancedTerrainComputeShader(base)).not.toContain('fn calderaShape_d(');
    });
    it('assembles inland landforms independently and compiles them with the shared water paths', () => {
        const onlyMesas = createAdvancedTerrainComputeShader({ ...base, inlandLandforms: { mesas: true } });
        const onlyCuestas = createAdvancedTerrainComputeShader({ ...base, inlandLandforms: { cuestas: true } });
        expect(onlyMesas).not.toContain('fn cuestaProvince_d');
        expect(onlyCuestas).not.toContain('fn mesaProvince_d');
        expect(compile(onlyMesas)).toBeNull();
        expect(compile(onlyCuestas)).toBeNull();
        for (const lakeTable of ['build', 'read']) {
            const source = createAdvancedTerrainComputeShader({ ...base, baseGenerator: 'lakeLand', lakeTable,
                waterCarve: true, calderas: { enabled: true }, inlandLandforms: { mesas: true, cuestas: true },
                mountainRangeModel: 'directional', foothills: { model: 'regional' } });
            expect(compile(source)).toBeNull();
        }
    });
    it('compiles the default world landforms together in terrain and lake table variants', () => {
        const options = { ...base, ...new TerrainGenerationConfig(worldTerrain), terrainSeed: 12345, waterCarve: true };
        for (const baseGenerator of ['earthLike', 'lakeLand']) {
            for (const lakeTable of baseGenerator === 'lakeLand' ? ['build', 'read'] : [null]) {
                const source = createAdvancedTerrainComputeShader({ ...options, baseGenerator, lakeTable });
                expect(compile(source)).toBeNull();
                expect(source).toContain('fn valleyRange_d(');
                expect(source).toContain('fn coastalHillsHeight_d(');
                expect(source).toContain('fn coastalCoves_d(');
                expect(source).toContain('fn tectonicConvergence_d(');
                expect(source).toContain('fn oceanShelfHeight_d(');
                expect(source).toContain('let lowlandWeight =');
                expect(source).toContain('let coastalUplift =');
                expect(source).not.toContain('fn mesaProvince_d(');
                expect(source).not.toContain('fn cuestaProvince_d(');
            }
        }
        const combined = createAdvancedTerrainComputeShader(options);
        expect(createAdvancedTerrainComputeShader({ ...options, terrainSeed: 12346 })).not.toBe(combined);
        const terrainWithoutPlates = createAdvancedTerrainComputeShader({ ...options, tectonicRelief: { enabled: false } });
        expect(terrainWithoutPlates).not.toContain('fn tectonicConvergence_d(');
        const legacyLandforms = createAdvancedTerrainComputeShader({ ...options,
            landformDetails: { ...options.landformDetails, oceanShelves: false },
            tectonicRelief: { ...options.tectonicRelief, lowlandReliefM: 0, coastalReliefM: 0 },
        });
        expect(compile(legacyLandforms)).toBeNull();
        expect(legacyLandforms).not.toContain('fn oceanShelfHeight_d(');
        expect(legacyLandforms).not.toContain('let lowlandWeight =');
        expect(legacyLandforms).not.toContain('let coastalUplift =');
    });
    it('compiles the river field and shore materials in every generation variant',()=>{
        for(const extra of Object.values(variants))expect(compile(createAdvancedTerrainComputeShader({
            ...base,...extra,waterCarve:true,riverBankDetail:true,regionalTerrain:true,
        }))).toBeNull();
    });
    for (const [name, extra] of Object.entries(variants)) {
        it(`${name} variant compiles with persistent regional input`, () => {
            const code = createAdvancedTerrainComputeShader({ ...base, ...extra,
                regionalTerrain: true, waterCarve: true });
            expect(compile(code)).toBeNull();
        });
        it(`${name} variant compiles`, () => {
            const code = createAdvancedTerrainComputeShader({ ...base, ...extra });
            expect(compile(code)).toBeNull();
        });
        // With the rivers (riverCarve.wgsl.js, the river field at group 1 bindings 4-6).
        it(`${name} variant compiles with the river field`, () => {
            const code = createAdvancedTerrainComputeShader({ ...base, ...extra, waterCarve: true });
            expect(code).toContain('fn riverFieldDelta_d');
            expect(code).toMatch(/@group\(1\) @binding\(5\) var<storage, read> riverFieldTexels/);
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
