import { describe, expect, it } from 'vitest';
import { parseWgsl, validate } from 'naga-wasm';
import { buildWaterSimFragmentShader, buildWaterSimVertexShader } from './waterSimSurface.wgsl.js';

// WGSL check without a GPU (naga). Drawn by WaterSimRenderer.js.
describe('simulated water surface WGSL', () => {
    it('vertex shader validates', () => {
        expect(() => validate(parseWgsl(buildWaterSimVertexShader()))).not.toThrow();
    });
    it('fragment shader validates', () => {
        expect(() => validate(parseWgsl(buildWaterSimFragmentShader()))).not.toThrow();
    });
});
