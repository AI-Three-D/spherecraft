import { describe, expect, it } from 'vitest';
import { parseWgsl, validate } from 'naga-wasm';
import { createSplatComputeShader } from './splatCompute.wgsl.js';
import { createResolvedTerrainColorComputeShader } from './resolvedTerrainColorCompute.wgsl.js';
import { buildTileCategoryLookupWGSLForCategories } from '../../tileCatalogRuntime.js';

// River and lake beds in fixed material family mode (materialFamilies.js):
// the splat pass stores the bed's weight in the index texture, the resolved
// colour bake draws that share of the soil family with the bed's tile.

const WITH_MUD = [
    { id: 0, name: 'WATER', ranges: [[0, 3]] },
    { id: 1, name: 'GRASS', ranges: [[10, 29]] },
    { id: 2, name: 'ROCK', ranges: [[42, 53]] },
    { id: 3, name: 'DESERT', ranges: [[150, 165]] },
    { id: 4, name: 'MUD', ranges: [[106, 109]] },
];
const WITHOUT_MUD = WITH_MUD.slice(0, 4);

function compile(code) {
    try {
        validate(parseWgsl(code));
        return null;
    } catch (error) {
        return error?.formatted ?? String(error);
    }
}

const splat = (tileCategories) => createSplatComputeShader({ tileCategories, fixedMaterialFamiliesEnabled: true,
    buildTileCategoryLookupWGSL: () => buildTileCategoryLookupWGSLForCategories(tileCategories) });

describe('fixed material family beds', () => {
    it('splat pass stores the bed weight, with and without a MUD category', () => {
        const mud = splat(WITH_MUD);
        expect(compile(mud)).toBeNull();
        expect(mud).toContain('const FIXED_MATERIAL_BED_CATEGORY: u32 = 4u;');
        expect(mud).toContain('vec4<f32>(normalized.z * bedShare, 0.0, 0.0, 0.0)');
        const none = splat(WITHOUT_MUD);
        expect(compile(none)).toBeNull();
        expect(none).toContain('const FIXED_MATERIAL_BED_CATEGORY: u32 = INVALID_CATEGORY_ID;');
    });

    it('resolved colour bake draws the bed share of the soil with the bed tile', () => {
        const families = createResolvedTerrainColorComputeShader({ fixedMaterialFamilies: true, tileCategories: WITH_MUD });
        expect(compile(families)).toBeNull();
        expect(families).toContain('const USE_FIXED_MATERIAL_FAMILIES: bool = true;');
        expect(families).toContain('const FIXED_MATERIAL_BED_TILE: f32 = 106.0;');
        const ids = createResolvedTerrainColorComputeShader();
        expect(compile(ids)).toBeNull();
        expect(ids).toContain('const USE_FIXED_MATERIAL_FAMILIES: bool = false;');
    });
});
