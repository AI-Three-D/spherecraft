import { describe, expect, it } from 'vitest';
import { parseWgsl, validate } from 'naga-wasm';
import * as noise from './shaders/cloudNoise.wgsl.js';
import * as passes from './shaders/cloudPasses.wgsl.js';
import { buildCloudCompositeShader } from './CloudCompositePass.js';

// WGSL check without a GPU (naga). Dispatched by VolumetricCloudsModule.js and CloudCompositePass.js.
describe('volumetric cloud WGSL', () => {
    const composite = { CLOUD_COMPOSITE_WGSL: buildCloudCompositeShader() };
    for (const [name, code] of Object.entries({ ...noise, ...passes, ...composite })) {
        it(`${name} validates`, () => {
            expect(() => validate(parseWgsl(code))).not.toThrow();
        });
    }
});
