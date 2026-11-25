import { describe, expect, it } from 'vitest';
import { parseWgsl, validate } from 'naga-wasm';
import * as noise from './shaders/cloudNoise.wgsl.js';
import * as luts from './shaders/cloudLuts.wgsl.js';
import * as march from './shaders/cloudMarch.wgsl.js';
import * as orbit from './shaders/cloudOrbit.wgsl.js';
import { CLOUD_HISTORY_WGSL } from './shaders/cloudHistory.wgsl.js';
import { CLOUD_RAY_PAIRS_WGSL } from './shaders/cloudRayPairs.wgsl.js';
import { CLOUD_MOUNTAIN_FOG_WGSL, CLOUD_LOCAL_MIST_WGSL } from './shaders/cloudLocalVolumes.wgsl.js';
import { CLOUD_LAND_GROUND_WGSL, CLOUD_LAND_RELIEF_WGSL, CLOUD_LAND_SLOPES_WGSL, buildLandMapShader } from './shaders/cloudLandMap.wgsl.js';
import { buildLeanAirShader, buildLeanCompositeShader } from './shaders/cloudLeanComposite.wgsl.js';
import { CLOUD_RAY_VOLUME_WGSL, GOD_RAY_SIZES, buildRayFilterShader, buildRayTableShader } from './shaders/cloudGodRays.wgsl.js';
import { CLOUD_NEURAL_LIGHT_BAKE_WGSL } from './shaders/cloudNeuralLighting.wgsl.js';
import { buildCloudCompositeShader } from './CloudCompositePass.js';

// WGSL check without a GPU (naga). Dispatched by VolumetricCloudsModule.js and CloudCompositePass.js.
describe('volumetric cloud WGSL', () => {
    const composite = { CLOUD_COMPOSITE_WGSL: buildCloudCompositeShader(), CLOUD_GOD_RAY_COMPOSITE_WGSL: buildCloudCompositeShader(true),
        CLOUD_RAY_TABLE_WGSL: buildRayTableShader(GOD_RAY_SIZES.medium.table[0]), CLOUD_RAY_FILTER_WGSL: buildRayFilterShader(GOD_RAY_SIZES.medium.table[1]), CLOUD_RAY_VOLUME_WGSL,
        CLOUD_LEAN_AIR_WGSL: buildLeanAirShader(), CLOUD_LEAN_AIR_RAYS_WGSL: buildLeanAirShader(true),
        CLOUD_LEAN_COMPOSITE_WGSL: buildLeanCompositeShader(true), CLOUD_LEAN_COMPOSITE_RAYS_WGSL: buildLeanCompositeShader(true, true),
        CLOUD_CIRRUS_COMPOSITE_WGSL: buildLeanCompositeShader(false),
        CLOUD_MOUNTAIN_FOG_WGSL, CLOUD_LOCAL_MIST_WGSL, CLOUD_LAND_GROUND_WGSL, CLOUD_LAND_RELIEF_WGSL, CLOUD_LAND_SLOPES_WGSL,
        CLOUD_LAND_MAP_WGSL: buildLandMapShader({ wet: [[82, 93]], forest: [[66, 81], [142, 149]] }) };
    const passes = { CLOUD_NEURAL_LIGHT_BAKE_WGSL, CLOUD_MARCH_WGSL: march.buildCloudMarch(), CLOUD_HISTORY_WGSL, CLOUD_RAY_PAIRS_WGSL };
    const shaders = Object.entries({ ...noise, ...luts, ...march, ...orbit, ...composite, ...passes })
        .filter(([name]) => name.endsWith('_WGSL'));
    for (const [name, code] of shaders) {
        it(`${name} validates`, () => {
            expect(() => validate(parseWgsl(code))).not.toThrow();
        });
    }
});
