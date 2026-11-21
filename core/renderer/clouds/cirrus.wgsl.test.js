import { describe, expect, it } from 'vitest';
import { parseWgsl, validate } from 'naga-wasm';
import { WebGPUCloudRenderer } from './webgpuCloudRenderer.js';

// WGSL check without a GPU (naga) for every cirrus quality preset.
describe('cirrus WGSL', () => {
    for (const quality of ['low', 'medium', 'high', 'ultra']) {
        it(`${quality} fragment shader validates`, () => {
            const renderer = Object.create(WebGPUCloudRenderer.prototype);
            renderer.config = { cirrusQuality: quality };
            renderer._cirrusQualitySettings = null;
            expect(() => validate(parseWgsl(renderer._getCirrusFragmentShader()))).not.toThrow();
        });
    }
});
