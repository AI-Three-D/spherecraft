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
