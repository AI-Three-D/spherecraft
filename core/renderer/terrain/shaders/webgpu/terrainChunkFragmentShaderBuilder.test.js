import { describe, expect, it } from 'vitest';
import { parseWgsl, validate } from 'naga-wasm';
import { buildTerrainChunkFragmentShader } from './terrainChunkFragmentShaderBuilder.js';
import { TILE_CATEGORIES } from '../../../../../templates/configs/tileTypes.js';

describe('terrain fragment shader', () => {
    for (const lod of [0, 2, 6]) for (const fixedMaterialFamiliesEnabled of [false, true]) {
        it(`validates cascade branching and explicit comparisons at LOD${lod}, families ${fixedMaterialFamiliesEnabled}`, () => {
            const code = buildTerrainChunkFragmentShader({ lod, useArrayTextures: true,
                normalTextureFilterable: true, tileCategories: TILE_CATEGORIES, fixedMaterialFamiliesEnabled });
            expect(() => validate(parseWgsl(code))).not.toThrow();
            if (fixedMaterialFamiliesEnabled) expect(code).toContain('FIXED_MATERIAL_BED_TILE: f32 = 106.0');
        });
    }
});

describe('terrain fragment shader, flat-tier color', () => {
    // LOD4: detail tier with the distance ramp into the flat color; LOD6: the
    // flat tier itself. Both read the baked coarseColor texture.
    for (const lod of [4, 6]) {
        it(`validates LOD${lod} with the baked flat color`, () => {
            const code = buildTerrainChunkFragmentShader({
                lod, useArrayTextures: true, normalTextureFilterable: true, tileCategories: TILE_CATEGORIES,
                fixedMaterialFamiliesEnabled: true, hasCoarseColorTexture: true,
                enableSolidColorTier: lod >= 5, enableTierDistanceFade: lod < 5, enableIncompleteSourceFlat: lod < 5,
                solidColorAverageWindowMeters: 1434, faceSizeMeters: 262144,
            });
            expect(() => validate(parseWgsl(code))).not.toThrow();
            expect(code).toContain('debugMode == 107');
        });
    }
});
