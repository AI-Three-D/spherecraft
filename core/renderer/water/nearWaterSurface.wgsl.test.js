import { describe, expect, it } from 'vitest';
import { parseWgsl, validate } from 'naga-wasm';
import { buildNearWaterFragmentShader, buildNearWaterVertexShader } from './nearWaterSurface.wgsl.js';
import { buildFieldWaterFragmentShader, buildFieldWaterVertexShader } from './fieldWaterSurface.wgsl.js';
import { buildWhitewaterFragmentShader, buildWhitewaterVertexShader } from './whitewaterSurface.wgsl.js';

// WGSL check without a GPU (naga). Drawn by NearWaterRenderer.js.
describe('near water surface WGSL', () => {
    it('lake vertex shader validates', () => {
        expect(() => validate(parseWgsl(buildNearWaterVertexShader()))).not.toThrow();
    });
    it('lake fragment shader validates', () => {
        expect(() => validate(parseWgsl(buildNearWaterFragmentShader()))).not.toThrow();
    });
    it('river field water vertex shader validates', () => {
        expect(() => validate(parseWgsl(buildFieldWaterVertexShader()))).not.toThrow();
    });
    it('river field water fragment shader validates', () => {
        expect(() => validate(parseWgsl(buildFieldWaterFragmentShader()))).not.toThrow();
    });
    it('near simulation water shaders validate', () => {
        expect(() => validate(parseWgsl(buildWhitewaterVertexShader()))).not.toThrow();
        expect(() => validate(parseWgsl(buildWhitewaterFragmentShader()))).not.toThrow();
    });
    it('every tier draws the same close surface', () => {
        for (const fs of [buildNearWaterFragmentShader(), buildFieldWaterFragmentShader(), buildWhitewaterFragmentShader()]) expect(fs).toMatch(/whiteSurface\(in\.wp/);
    });
});
