import { describe, expect, it } from 'vitest';
import { parseWgsl, validate } from 'naga-wasm';
import { buildTerrainChunkFragmentShader } from './terrainChunkFragmentShaderBuilder.js';
import { TILE_CATEGORIES } from '../../../../../templates/configs/tileTypes.js';

describe('terrain fragment shader', () => {
    for (const lod of [0, 2, 6]) {
        it(`validates cascade branching and explicit comparisons at LOD${lod}`, () => {
            const code = buildTerrainChunkFragmentShader({ lod, useArrayTextures: true,
                normalTextureFilterable: true, tileCategories: TILE_CATEGORIES });
            expect(() => validate(parseWgsl(code))).not.toThrow();
        });
    }
});
