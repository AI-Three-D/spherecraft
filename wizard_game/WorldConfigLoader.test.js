import {describe,it,expect} from 'vitest';
import {WorldConfigLoader} from './WorldConfigLoader.js';
describe('rendering power settings', () => {
 it('defaults to one canvas pixel per CSS pixel and 60 FPS, with validated world overrides', () => {
  const loader = new WorldConfigLoader();
  const defaults = loader._buildEngineConfig({}, {});
  expect(defaults.rendering.pixelRatio).toBe(1);
  expect(defaults.rendering.maxFps).toBe(60);
  expect(defaults.rendering.adaptive.enabled).toBe(true);
  expect(defaults.rendering.adaptive.stationaryFps).toBe(30);
  const overridden = loader._buildEngineConfig({}, {}, { rendering: { pixelRatio: 1.25, maxFps: 0 } });
  expect(overridden.rendering.pixelRatio).toBe(1.25);
  expect(overridden.rendering.maxFps).toBe(0);
  expect(loader._buildEngineConfig({}, {}).rendering.maxFps).toBe(60);
  const adaptive = loader._buildEngineConfig({}, {}, { rendering: { adaptive: { stationaryFps: 24, motionPixelRatio: 0.8 } } });
  expect(adaptive.rendering.adaptive.stationaryFps).toBe(24);
  expect(adaptive.rendering.adaptive.motionPixelRatio).toBe(0.8);
  expect(adaptive.rendering.adaptive.fastMotionPixelRatio).toBe(0.7);
 });
 it('rejects invalid pixel ratios and FPS limits from world JSON', () => {
  const loader = new WorldConfigLoader();
  for (const pixelRatio of [0, -1, Infinity, 'retina']) {
   expect(() => loader._buildEngineConfig({}, {}, { rendering: { pixelRatio } })).toThrow();
  }
  for (const maxFps of [-1, Infinity, '60']) {
   expect(() => loader._buildEngineConfig({}, {}, { rendering: { maxFps } })).toThrow();
  }
 });
});
describe('world water authoring configuration',()=>{
 it('merges partial world placement and water changes without discarding nested defaults',()=>{
  const cfg=new WorldConfigLoader()._buildGameDataConfig({regionalTerrain:{world:{maxRegions:24}},waterGraph:{sim:{lengthM:128},carve:{bankCutM:3}}},{},{});
  const t=cfg.planets[0].terrain;
  expect(t.regionalTerrain.world.enabled).toBe(true);expect(t.regionalTerrain.world.maxRegions).toBe(24);
  expect(t.waterGraph.sim.enabled).toBe(true);expect(t.waterGraph.sim.lengthM).toBe(128);expect(t.waterGraph.carve.bankDetail).toBe(1);expect(t.waterGraph.carve.bankCutM).toBe(3);
 });
 it('honours explicit opt-outs without mutating subsequent worlds',()=>{
  const loader=new WorldConfigLoader(),off=loader._buildGameDataConfig({regionalTerrain:{enabled:false,world:{enabled:false}},waterGraph:{sim:{enabled:false},carve:{bankDetail:0}}},{},{}).planets[0].terrain;
  expect(off.regionalTerrain.enabled).toBe(false);expect(off.waterGraph.sim.enabled).toBe(false);expect(off.waterGraph.carve.bankDetail).toBe(0);
  const next=loader._buildGameDataConfig({}, {}, {}).planets[0].terrain;
  expect(next.regionalTerrain.enabled).toBe(true);expect(next.waterGraph.sim.enabled).toBe(true);expect(next.waterGraph.carve.bankDetail).toBe(1);
 });
});
