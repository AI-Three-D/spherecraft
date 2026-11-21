import { describe, expect, it, vi } from 'vitest';
import { parseWgsl, validate } from 'naga-wasm';

// The browser resolves engine/ through the page's import map.
vi.mock('engine/renderer/volumetricClouds/shaders/cloudCommon.wgsl.js', () =>
    import('../core/renderer/volumetricClouds/shaders/cloudCommon.wgsl.js'));

describe('cloud lab WGSL', () => {
    it('atmosphere compute validates', async () => {
        const { buildLabAtmosphereShader } = await import('./labComposite.js');
        expect(() => validate(parseWgsl(buildLabAtmosphereShader()))).not.toThrow();
    });
    for (const srgbEncode of [true, false]) {
        it(`composite validates with srgbEncode=${srgbEncode}`, async () => {
            const { buildLabCompositeShader } = await import('./labComposite.js');
            expect(() => validate(parseWgsl(buildLabCompositeShader({ srgbEncode })))).not.toThrow();
        });
    }
});
