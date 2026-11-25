import { describe, expect, it } from 'vitest';
import { parseWgsl, validate } from 'naga-wasm';
import { TERRAIN_LIGHT_HEIGHT_WGSL, TERRAIN_LIGHT_SKY_WGSL, TERRAIN_LIGHT_SUN_WGSL } from './terrainLight.wgsl.js';
import {
    GROUND_MIP_WGSL, buildReliefShader, buildResolveShader, buildStoreShader, buildWideResolveShader, buildWideShader,
} from '../materials/groundMaterialGenerator.wgsl.js';
import { GROUND_LAYERS, groundCategoryColors } from '../materials/groundMaterials.js';

describe('terrain light and ground material shaders', () => {
    it.each([
        ['height', TERRAIN_LIGHT_HEIGHT_WGSL], ['sky', TERRAIN_LIGHT_SKY_WGSL], ['sun', TERRAIN_LIGHT_SUN_WGSL],
        ['relief', buildReliefShader()], ['resolve', buildResolveShader()], ['mip', GROUND_MIP_WGSL], ['store', buildStoreShader()],
        ['wide', buildWideShader()], ['wide resolve', buildWideResolveShader()],
    ])('%s validates', (_, code) => { expect(() => validate(parseWgsl(code))).not.toThrow(); });

    it('gives every far colour as a mix of the surfaces drawn close by', () => {
        const colors = groundCategoryColors();
        const bounds = [0, 1, 2].map(i => [Math.min(...GROUND_LAYERS.map(l => l.mean[i])), Math.max(...GROUND_LAYERS.map(l => l.mean[i]))]);
        for (const color of Object.values(colors)) color.forEach((c, i) => {
            expect(c).toBeGreaterThanOrEqual(bounds[i][0] - 1e-9);
            expect(c).toBeLessThanOrEqual(bounds[i][1] + 1e-9);
        });
    });
});
