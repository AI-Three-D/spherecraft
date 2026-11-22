import { describe, expect, it } from 'vitest';
import { parseWgsl, validate } from 'naga-wasm';
import * as noise from './shaders/cloudNoise.wgsl.js';
import * as passes from './shaders/cloudPasses.wgsl.js';
import * as caches from './shaders/cloudCaches.wgsl.js';
import * as towers from './shaders/cloudTowerExperiments.wgsl.js';
import { buildCloudCompositeShader } from './CloudCompositePass.js';

// WGSL check without a GPU (naga). Dispatched by VolumetricCloudsModule.js and CloudCompositePass.js.
describe('volumetric cloud WGSL', () => {
    const composite = { CLOUD_COMPOSITE_WGSL: buildCloudCompositeShader(), CLOUD_BUDGET_COMPOSITE_WGSL: buildCloudCompositeShader(true) };
    const shaders = Object.entries({ ...noise, ...passes, ...caches, ...towers, ...composite })
        .filter(([name]) => name.endsWith('_WGSL'));
    for (const [name, code] of shaders) {
        it(`${name} validates`, () => {
            expect(() => validate(parseWgsl(code))).not.toThrow();
        });
    }
});
