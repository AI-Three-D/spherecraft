import { describe, expect, it } from 'vitest';
import { parseWgsl, validate } from 'naga-wasm';
import { buildNearWaterFragmentShader, buildNearWaterVertexShader } from './nearWaterSurface.wgsl.js';

// WGSL check without a GPU (naga). Drawn by NearWaterRenderer.js.
describe('near water surface WGSL', () => {
    it('vertex shader validates', () => {
        expect(() => validate(parseWgsl(buildNearWaterVertexShader()))).not.toThrow();
    });
    it('fragment shader validates', () => {
        expect(() => validate(parseWgsl(buildNearWaterFragmentShader()))).not.toThrow();
    });
});
