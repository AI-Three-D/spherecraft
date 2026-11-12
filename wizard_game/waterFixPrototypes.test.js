import { describe, expect, it } from 'vitest';
import { WATER_FIX_DEFAULT, WATER_FIX_PROTOTYPES, applyWaterFixLive, waterFixIndexOf } from './waterFixPrototypes.js';
import { WATER_LOOK_DEFAULTS } from '../core/world/water/WaterGpuData.js';
import { SeaControl } from '../core/world/PlanetTerrainModule.js';

function fakeEngine() {
    const water = { look: { ...WATER_LOOK_DEFAULTS }, sea: { available: true, enabled: true, levelM: -50 } };
    const module = { options: { planetConfig: { terrainGeneration: { water: { hasOceans: true } } } }, waterData: water,
        initializeLegacyOcean: async () => {} };
    module._applySea = () => { water.sea.enabled = water.sea.available && module.ocean.enabled && !module.ocean.legacy; };
    module.ocean = new SeaControl(module);
    return { waterGpuData: water, renderer: { terrainModule: module } };
}

describe('water fix prototypes', () => {
    it('the runtime defaults are the default prototype', () => {
        expect(waterFixIndexOf(fakeEngine())).toBe(WATER_FIX_DEFAULT);
    });

    it('reads -1 until the water data exists', () => {
        expect(waterFixIndexOf({ renderer: {} })).toBe(-1);
        expect(() => applyWaterFixLive({ renderer: {} }, 0)).toThrow(/not ready/);
    });

    it('every prototype applies and reads back; the legacy sea turns the new one off', () => {
        const engine = fakeEngine();
        WATER_FIX_PROTOTYPES.forEach((p, i) => {
            applyWaterFixLive(engine, i);
            expect(waterFixIndexOf(engine)).toBe(i);
            expect(engine.waterGpuData.sea.enabled).toBe(p.settings.sea === 'lakes');
        });
    });

    it('the o key (enabled) turns the sea off and on', () => {
        const engine = fakeEngine(), sea = engine.renderer.terrainModule.ocean;
        sea.enabled = false;
        expect(engine.waterGpuData.sea.enabled).toBe(false);
        sea.enabled = true;
        expect(engine.waterGpuData.sea.enabled).toBe(true);
    });
});
