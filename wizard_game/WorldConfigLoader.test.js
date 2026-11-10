import {describe,it,expect} from 'vitest';
import {WorldConfigLoader} from './WorldConfigLoader.js';
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
