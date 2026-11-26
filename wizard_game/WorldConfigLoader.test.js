import {describe,it,expect} from 'vitest';
import {WorldConfigLoader} from './WorldConfigLoader.js';
import worldPlanet from './world/planet.json';
import worldTerrain from './world/terrain.json';
describe('rendering power settings', () => {
 it('uses the configured default pixel ratio and 60 FPS, with validated world overrides', () => {
  const loader = new WorldConfigLoader();
  const defaults = loader._buildEngineConfig({}, {});
  expect(defaults.rendering.pixelRatio).toBe(1.5);
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
  // Default: no resolution drop while moving (fast motion stays at the still ratio).
  expect(adaptive.rendering.adaptive.fastMotionPixelRatio).toBe(1.5);
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
 it('loads an optional lake-cell spawn direction from the world',()=>{
  const loader=new WorldConfigLoader();
  const direction=loader._buildGameDataConfig(worldTerrain, worldPlanet, {}).spawn.lakeCellDirection;
  expect(Math.hypot(...direction)).toBeCloseTo(1);
  const expected=worldPlanet.spawn.lakeCellDirection;
  expect(direction).toEqual(expected.map(component=>component/Math.hypot(...expected)));
  expect(loader._buildGameDataConfig({}, {}, {}).spawn.lakeCellDirection).toBeUndefined();
  for (const lakeCellDirection of [[0,0,0], [1,2], [1,2,3,4], [1,2,NaN]]) {
   expect(()=>loader._buildGameDataConfig({}, {spawn:{lakeCellDirection}}, {})).toThrow('spawn.lakeCellDirection');
  }
 });
 it('selects the startup mountain model without changing subsequent worlds',()=>{
  const loader=new WorldConfigLoader();
  expect(loader._buildGameDataConfig({mountainRangeModel:'directional'}, {}, {}).planets[0].terrain.mountainRangeModel).toBe('directional');
  expect(loader._buildGameDataConfig({}, {}, {}).planets[0].terrain.mountainRangeModel).toBe('legacy');
  expect(()=>loader._buildGameDataConfig({mountainRangeModel:'invalid'}, {}, {})).toThrow('Unknown mountain range model');
 });
 it('merges and validates the startup foothill settings',()=>{
  const loader=new WorldConfigLoader();
  const chosen=loader._buildGameDataConfig({foothills:{model:'regional',strength:1.2}}, {}, {}).planets[0].terrain.foothills;
  expect(chosen.model).toBe('regional');expect(chosen.strength).toBe(1.2);expect(chosen.broadScaleKm).toBe(7);
  expect(loader._buildGameDataConfig({}, {}, {}).planets[0].terrain.foothills.model).toBe('legacy');
  expect(()=>loader._buildGameDataConfig({foothills:{model:'invalid'}}, {}, {})).toThrow('Unknown foothill model');
  expect(()=>loader._buildGameDataConfig({foothills:{coverageStart:0.7}}, {}, {})).toThrow();
  expect(()=>loader._buildGameDataConfig({foothills:{broadScaleKm:0}}, {}, {})).toThrow();
 });
 it('uses terrain-sampled water by default while allowing regional placement to be enabled explicitly',()=>{
  const loader=new WorldConfigLoader();
  expect(loader._buildGameDataConfig({}, {}, {}).planets[0].terrain.regionalTerrain.enabled).toBe(false);
  expect(loader._buildGameDataConfig({regionalTerrain:{enabled:true}}, {}, {}).planets[0].terrain.regionalTerrain.enabled).toBe(true);
  expect(loader._buildGameDataConfig({}, {}, {}).planets[0].terrain.regionalTerrain.enabled).toBe(false);
 });
 it('loads the unified world landforms and validates individual detail switches',()=>{
  const loader=new WorldConfigLoader();
  const terrain=loader._buildGameDataConfig(worldTerrain, {}, {}).planets[0].terrain;
  expect(terrain.mountainRangeModel).toBe('directional');
  expect(terrain.foothills.model).toBe('regional');
  expect(terrain.landformDetails).toEqual({
   rangeValleys:true, regionalRollingHills:true, coastalHills:true, coves:true, oceanShelves:true,
  });
  expect(terrain.calderas.enabled).toBe(true);
  expect(terrain.fjords).toBe(true);
  expect(terrain.tectonicRelief).toEqual({
   enabled:true, plateCount:18, mountainReliefM:2400, interiorReliefM:560, lowlandReliefM:220, coastalReliefM:1050,
  });
  expect(terrain.inlandLandforms).toEqual({ fells:true, mesas:false, cuestas:false });
  expect(()=>loader._buildGameDataConfig({landformDetails:[]}, {}, {})).toThrow('landformDetails must be an object');
  expect(()=>loader._buildGameDataConfig({landformDetails:{coves:1}}, {}, {})).toThrow('landformDetails.coves must be a boolean');
  expect(()=>loader._buildGameDataConfig({landformDetails:{oceanShelves:1}}, {}, {})).toThrow('landformDetails.oceanShelves must be a boolean');
  expect(()=>loader._buildGameDataConfig({tectonicRelief:{enabled:true,plateCount:0}}, {}, {})).toThrow('tectonicRelief.plateCount');
  expect(()=>loader._buildGameDataConfig({tectonicRelief:{lowlandReliefM:500}}, {}, {})).toThrow('tectonicRelief.lowlandReliefM');
  expect(()=>loader._buildGameDataConfig({tectonicRelief:{coastalReliefM:-1}}, {}, {})).toThrow('tectonicRelief.coastalReliefM');
 });
 it('authors calderas at startup and rejects terrain-grid-breaking presets',()=>{
  const loader=new WorldConfigLoader();
  const terrain=loader._buildGameDataConfig({calderas:{enabled:true,minHeightM:800,maxHeightM:1200}}, {}, {}).planets[0].terrain;
  expect(terrain.calderas.enabled).toBe(true);
  expect(terrain.calderas.maxHeightM).toBe(1200);
  expect(terrain.calderas.minRadiusM).toBe(8000);
  expect(loader._buildGameDataConfig({}, {}, {}).planets[0].terrain.calderas.enabled).toBe(false);
  for(const calderas of [[],1,{enabled:'true'},{maxHeightM:3000},{minRadiusM:12000},{densityPerKm2:NaN}]) {
   expect(()=>loader._buildGameDataConfig({calderas}, {}, {})).toThrow();
  }
 });
 it('merges partial world placement and water changes without discarding nested defaults',()=>{
  const cfg=new WorldConfigLoader()._buildGameDataConfig({regionalTerrain:{world:{maxRegions:24}},waterGraph:{sim:{lengthM:128},carve:{bankCutM:3}}},{},{});
  const t=cfg.planets[0].terrain;
  expect(t.regionalTerrain.world.enabled).toBe(true);expect(t.regionalTerrain.world.maxRegions).toBe(24);
  expect(t.waterGraph.whitewater.enabled).toBe(true);expect(t.waterGraph.sim.lengthM).toBe(128);expect(t.waterGraph.carve.bankDetail).toBe(1);expect(t.waterGraph.carve.bankCutM).toBe(3);
 });
 it('honours explicit opt-outs without mutating subsequent worlds',()=>{
  const loader=new WorldConfigLoader(),off=loader._buildGameDataConfig({regionalTerrain:{enabled:false,world:{enabled:false}},waterGraph:{sim:{enabled:false},carve:{bankDetail:0}}},{},{}).planets[0].terrain;
  expect(off.regionalTerrain.enabled).toBe(false);expect(off.waterGraph.sim.enabled).toBe(false);expect(off.waterGraph.carve.bankDetail).toBe(0);
  const next=loader._buildGameDataConfig({}, {}, {}).planets[0].terrain;
  expect(next.regionalTerrain.enabled).toBe(false);expect(next.waterGraph.sim?.enabled).toBeUndefined();expect(next.waterGraph.whitewater.enabled).toBe(true);expect(next.waterGraph.carve.bankDetail).toBe(1);
 });
});

describe('landscape authoring', () => {
    it('loads the default preset and applies authored overrides on top of another preset', () => {
        const loader = new WorldConfigLoader();
        expect(loader._buildGameDataConfig(worldTerrain, worldPlanet).planets[0].terrain.biomeLandscape)
            .toMatchObject({ enabled: true, preset: 'earth' });
        const custom = { ...worldTerrain, biomeLandscape: { preset: 'arid', duneSpacingM: 270 } };
        expect(loader._buildGameDataConfig(custom, worldPlanet).planets[0].terrain.biomeLandscape)
            .toMatchObject({ preset: 'arid', humidityOffset: -0.24, duneSpacingM: 270 });
        expect(() => loader._buildGameDataConfig({
            biomeLandscape: { preset: 'earth', duneSpacingM: 0 },
        }, worldPlanet)).toThrow(/duneSpacingM/);
    });
});
