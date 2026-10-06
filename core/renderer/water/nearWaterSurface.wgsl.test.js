import { describe, expect, it } from 'vitest';
import { parseWgsl, validate } from 'naga-wasm';
import {
    buildNearRiverFragmentShader, buildNearRiverVertexShader, buildNearWaterFragmentShader, buildNearWaterVertexShader,
} from './nearWaterSurface.wgsl.js';

// WGSL check without a GPU (naga). Drawn by NearWaterRenderer.js.
describe('near water surface WGSL', () => {
    it('lake vertex shader validates', () => {
        expect(() => validate(parseWgsl(buildNearWaterVertexShader()))).not.toThrow();
    });
    it('lake fragment shader validates', () => {
        expect(() => validate(parseWgsl(buildNearWaterFragmentShader()))).not.toThrow();
    });
    it('river vertex shader validates', () => {
        expect(() => validate(parseWgsl(buildNearRiverVertexShader()))).not.toThrow();
    });
    it('river fragment shader validates', () => {
        expect(() => validate(parseWgsl(buildNearRiverFragmentShader()))).not.toThrow();
    });
});
