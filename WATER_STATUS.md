# Water: where it stands (2026-11-11)

How water works in SphereCraft today, and what is missing. Lakes and rivers run
in the terrain function; the sea is drawn as the lakes are (since 2026-11-11). Day-by-day notes
and measurements: `LAKE_CELLS_PLAN.md`. Open terrain issue found on the way:
`TERRAIN_SEAM_CRACK_FINDINGS.md`.

Test: `http://localhost:8000/wizard_game/standalone.html` (lake cells are the
default since 2026-11-10; `?lakeCells=0` brings back the older terrain and
water; `python3 server.py`). R: next river site (Shift+R: new sites here), Y: rock
mode in the near simulation, T: freeze day and night, H: sea and far water
prototypes (`wizard_game/waterFixPrototypes.js`; `?waterFix=N`), O: sea off/on.

## Lakes (lake cells)

- Lakes are part of the terrain height function
  (`templates/terrain-shaders/features/featureLakeCells.wgsl.js`, base generator
  `lakeLand`): six size tiers (giant .. small) on jittered lattices, each
  candidate assessed once. The lake lowers its tier's coarse land bands to a bank
  surface, so it holds its water by construction, without dams.
- An assessment rejects sites over the ocean, too rough, too close to sea level,
  needing too long a fade, too much relief inside, or (since 2026-11-10) with
  under 75 % of the interior under the level.
- A GPU lake table (`core/world/terrain-generator/lakeTable.js`) holds the
  records near the tiles being generated; heights read it.
- Water: WaterService publishes the lakes to WaterGpuData; the terrain shading
  draws far water, near lake sheets the surface close up.
- Tools: `lakeWetCensus.mjs` (how full lakes are), `lakeProbe.mjs` (one place),
  `lakeRiverMap.mjs`, `lakeCellsLab.mjs` (all in `tools/perf/lakeCells/`).

## Rivers

- Planned per lake by a priority flood over a lazily sampled 128 m grid
  (`core/world/hydrology/lakeCellRivers.js`): to a lower lake, the sea or another
  river, within 40 km of the camera, sized by discharge. Rivers start only from
  lakes large enough, end only in lakes large enough for them, and some take
  part of their fall in a rapid.
- A baked river field (`core/world/water/riverField.js`, worker) carves the
  channel and banks into the terrain, holds the water level, its edge and the
  baked flow (`riverFlow.js`: speed by a slope law, one discharge per river, foam
  from the fall, rocks placed by slope).
- Drawing: the field's pages near the camera as a mesh (4 m vertices), coarse
  tile triangles standing in the river covered past the rocks' draw distance,
  the terrain shading beyond about 1 km.

## Near water simulation (whitewater)

- A shallow-water solver from the owner's Whitewater game
  (`core/world/water/WhitewaterSim.js`, `whitewaterSim.wgsl.js`) on 0.5 m cells
  in blocks around the camera: stepped where the water moves, drawn within
  96-144 m, a mesh per cell moving with the solver's height. Blocks start from
  the baked flow and fade in over a few seconds.
- Before 2026-11-10 it never ran in lake-cell mode (its bed sampler was never
  ready). It runs now: moving surface, spray particles, rocks in the flow.
- Rocks (`rockMode`, `?rocks=`, Y): **wall** (default: every rock a dome in the
  solver's bed, dry above the water), drag (soft damping zones), steer (the
  older behaviour: solid only in supercritical water).
- Foam is drawn as a noise pattern (ridged noise plus cellular bubble walls)
  carried in two phases 1.2 s along the flow; how much shows is the solver's
  foam, with part of the baked foam as a floor.
- Containment (branch `river-containment`, 2026-11-10; owner: water over the
  banks, a pit in a river's surface; "the surface may be flat, but the water
  must never flow backwards"). Causes, measured at the owner's poses with
  `tools/perf/whitewater/containment.mjs` (`wwContain`, `wwAlong`):
  - The bake leaves low ground beside a river dry on purpose (past `spillM`
    from its channel: no flooded bays). The solver had no walls: river water ran
    into such a basin 1.3-3.6 m under its level, the sponge emptied it again, and
    the river's surface sank up to 1.65 m into a pit. Now every cell the bake
    keeps dry (signed distance under `WHITE_DRY_SDF`, -1.5 m, where blocks
    already started dry) is a wall: no flow crosses its faces.
  - The baked state is not the solver's steady state everywhere: on a reach held
    flat at its lake's level, with rocks in the bed, the solver gained 13 % water
    in 40 s and stood 0.25-0.35 m over the baked level (wall rocks about double
    it; bed roughness and turbulence play no part), rising along the river and
    over the 0.25 m bank margin.
  - Now (`whitewaterSim.wgsl.js`, switches in `WHITEWATER_DEFAULTS`): walls as
    above, and each 16 m block's mean level over the baked one drains at
    `levelHold` (1/s; `WHITE_MEAN_WGSL` measures the means once a frame, each cell
    counted within +-0.5 m). A rock's pile-up and wake hardly move a block's mean; a
    reach's rise does. A deficit stays: rapids run shallower and faster than baked
    (21 % less water after 40 s, still falling), their rocks out of the water; filled
    to the baked level those rocks sank to dark discs, which the owner did not want.
    Both off is the free solver of before.
  - Tried and removed the same day: a band around the baked level per cell, a
    monotone cap along the flow and a backflow clamp. They held the surface to the
    rule cell by cell and flattened what the solver is for: water piling on rocks,
    flowing round them, wakes, foam forming at rocks (owner: "WAAY better" before).
    The rule is about the river's profile, not a rock's wake.
  - Measured 40 s from a cold start, free -> now (final, 2026-11-10): owner's spill
    pose water past the start-dry line 2,250 -> 0 cells, water gained +13.9 ->
    -0.8 %, block-mean drift 0.27 -> 0.09 m, rises along the river (8.5 m means) 5
    (10 cm) -> 1 (4 cm), foam unchanged, wakes kept; pit site 11,443 -> 0 (with the
    bank below even the free solver leaks only 198); rapids unchanged from free.
    Solver step +9 % (Node Dawn, 120 blocks), plus one mean pass a frame.
- The chop drawn on turbulent water (`whitewaterSurface.wgsl.js` `whiteChop`) was three
  fixed sines (2.5, 2.4, 1.2 m) whose lattice repeated (owner, 2026-11-10); now three
  octaves of value noise at unrelated angles, matched to the sines' height (RMS
  1.08 / 1.09) and slope (3.1 / 3.3).
- The baked water's strip past its edge (`KEEP_M`, 1.5 m, so the terrain cuts the
  shoreline) stood in the air beyond a low crest: a see-through sheet beside a
  river, solver on or off (owner's spill pose: a crest 5 cm over a lake's level, a
  hollow 1.8 m deep behind it). The bake now gives dry ground under the level it
  inherits (behind a crest, past a river's reach) a level `dryUnderM` (0.1 m)
  under that ground and a signed distance of far outside (riverField.js `leftDry`,
  tests in riverField.test.js): no strip is kept there, and the near simulation
  takes it for a wall. With the level lowered alone, the solver flooded such a
  strip 4.6 m deep from the river, and those cells skewed the block means until
  the hold drained the river 0.25-0.3 m under its level.
- Banks were tried and removed the same day: raising the ground where the water meets
  ground under its level made an embankment however it was shaped (a 4 m dike, a flat
  bank ending on a cliff, a wide shouldered bank: owner, "horrible" from the air). The
  river at the owner's site runs along a hillside, not in a valley: over 350 m the land
  on one side lies 2-6 m under its water 80 m out, and past its mouth its level is held
  flat at its lake's (327 m) for over 700 m with the land on the other side 5-20 m under
  it (`perchProbe.js` measure, 2026-11-10). That is where the river is laid (the planner's
  128 m grid route, the bake's hold at the lake's level), not something banks can hide.
  Open: lay such rivers in the valley, or carve them into the slope.
- Wide-bank preview (J): a broader, gently rising fill supports perched reaches,
  with slow variation along each side. It remains opt-in because it costs more
  to bake and has not been assessed across all river and lake configurations.
  Separate shoreline and wider upland smoothing reduces streaks without
  spreading the fill into submerged lake ground. Half-float rounding carries
  correctly at powers of two, avoiding pits in large terrain fills.
- With containment walls enabled, the near water uses the continuous baked
  shoreline distance for clipping instead of the solver's binary wet/dry grid.
  The free solver retains its own wet boundary. The intermittent stepped edge
  reported by the owner could not be reproduced exactly and needs further review.

## What is missing

### Ocean

Since 2026-11-11 the sea is drawn as the lakes are (`?waterFix=0` or H brings
back the old renderer to compare):

- Everything under sea level is ocean (`WaterGpuData.sea`, level from the
  planet's `oceanLevel`; the lake assessment and the river planner already
  treated it so). Its look is the lakes': the same body, sky, glitter, wind and,
  close by, the same close surface (`whitewaterLook.wgsl.js`).
- Close by, `NearWaterRenderer` draws it in a sea pass (`seaSurface.wgsl.js`):
  one triangle over the screen, each pixel's ray meeting the sea's sphere, so the
  surface is exact to the horizon with no mesh or LOD seams. Depth of water and
  shoreline come from the opaque depth, as for the lake sheets.
- Past the near meshes' handover the terrain shading draws it
  (`waterWgsl.js applyWater`), with the shore from the ground's own height; the
  depth buffer is metres coarse there. The pass still adds water that is clearly
  deep (past a few depth steps) and water with nothing behind it: a ray into the
  sea at a low angle can leave the 2 km deep sea shell without meeting the bed.
- Rivers' water near their mouths stays the river field's; past it, the sea.
- 'o' turns the sea off and on (`PlanetTerrainModule.ocean`, `SeaControl`).
- The old renderer (`globalOceanRenderer.js`, `waterShader.wgsl.js`) is kept
  only for that comparison: it drew the bays as pale seabed and left a black
  band along the horizon.
- Still missing: beaches and surf, waves or swell you can see in the geometry,
  tides, estuaries and plumes where rivers meet the sea, an underwater view.
  Water at night is near black (lakes and sea alike: no night floor such as the
  terrain's).

### Far water from orbit (lake beds' mud)

Far tiles have a few triangles over a hundred texels (geometry LOD 5-6: 4
segments a tile; from orbit vertices about 1 km apart, texels a few tens of
metres; from the config, not measured). Lake water was
placed where those triangles are under the level, while the bed's mud is
painted from the texels, so from high up lakes showed mud and polygon shapes.
Past the near meshes' handover (1-1.6 km) the terrain shading now reads the
ground's height for water from the tile's height texture
(`waterWgsl.js waterCoverHeight`, `WATER_LOOK_DEFAULTS.farTexelCover`): lakes
and the sea cover the texels under their level, as the mud does. `?waterFix=2`
or H shows the old triangle cover beside the new sea. Rivers keep their own
far cover (the river field's wet area).

### Rivers and near water

- Foam does not travel with the water: the pattern resets every 1.2 s, so it
  reads as a short repeating cycle and still slides through rocks. Needed: foam
  owned by the solver and drawn with detail that is carried along (advected
  texture coordinates or particles), and no baked foam floor in the simulated
  area.
- The solver covers only the water near the camera; beyond it the baked flow is
  animated, without eddies. Blocks lose their state when they leave the window.
- 0.5 m cells are coarse for small rocks; the riverbed's own relief does not
  reach the solver's bed (owner: later).
- Spray and mist are sparse (the solver's foam rarely reaches the spawn
  threshold); not tuned against the old look.
- Each rock shows a dark disc with a hard edge under the water (its mesh's base
  seen through shallow water).
- Rivers narrower than the terrain tiles' vertex spacing need the coarse-triangle
  cover; it starts past the rocks' draw distance, so very narrow pinches nearby
  can still show teeth. If the terrain LOD bands move closer to the camera, the
  cover should follow the LOD settings instead.
- Water speed follows a gentle slope law: rapids are not much faster than calm
  reaches (owner's call).
- The junction wall where two rivers meet: to look at again.

### Lakes

- Fewer ponds since the dry-lake fix (76 against 91 in a 30 km census; the
  lost ones were dry). Lakes in rough hills are rejected rather than shaped to
  them.
- Lakes never evict from the water data (`WaterGpuData`); the first publication
  costs 50-75 ms.

### Terrain issues seen through the water

- Cracks along tile seams between geometry LODs, from the per-tile micro detail
  (`TERRAIN_SEAM_CRACK_FINDINGS.md`): not water, left for a terrain session.
