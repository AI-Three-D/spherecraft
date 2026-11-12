import { describe, expect, it } from 'vitest';
import { parseWgsl, validate } from 'naga-wasm';
import { WHITE_BLOCK, WHITE_DIRS_WGSL, WHITE_INIT_WGSL, WHITE_MEAN_WGSL, WHITE_SIM_WGSL, WHITE_SPREAD_WGSL } from './whitewaterSim.wgsl.js';
import { buildWhitewaterFragmentShader, buildWhitewaterVertexShader } from '../../renderer/water/whitewaterSurface.wgsl.js';
import { buildRockFragmentShader, buildRockVertexShader, buildSprayFragmentShader, buildSprayVertexShader, WHITE_SPRAY_WGSL } from '../../renderer/water/whitewaterProps.wgsl.js';

// WGSL check without a GPU (naga).
describe('whitewater WGSL', () => {
    const shaders = {
        solver: WHITE_SIM_WGSL, 'block mean': WHITE_MEAN_WGSL, directions: WHITE_DIRS_WGSL, fill: WHITE_INIT_WGSL, spread: WHITE_SPREAD_WGSL, spray: WHITE_SPRAY_WGSL(WHITE_BLOCK),
        'surface vertex': buildWhitewaterVertexShader(), 'surface fragment': buildWhitewaterFragmentShader(),
        'rock vertex': buildRockVertexShader(), 'rock fragment': buildRockFragmentShader(),
        'spray vertex': buildSprayVertexShader(), 'spray fragment': buildSprayFragmentShader(),
    };
    for (const [name, code] of Object.entries(shaders)) {
        it(`${name} validates`, () => { expect(() => validate(parseWgsl(code))).not.toThrow(); });
    }
});
