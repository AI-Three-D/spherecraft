# SphereCraft water: status and next steps (hand-off, 2026-10-06)

This is for whichever agent continues the water work. Read it first, then `WATER_GEOMETRY_HANDOFF.md` (details and session log) and `WATER_HANDOFF.md` (how rivers are traced, carved and simulated).

## Active carving revision (2026-10-07, uncommitted)

The owner's screenshots and feedback override older success claims below. In particular, the original valley field produced continuous artificial embankments despite good containment metrics. Do not restore it.

- `water-v16` invalidates previous graph/river caches. Reload the page to see these changes.
- Carving remains the priority. SWE stays off; no new foam, texture patterns, or simulation work. Automatic lowland waterfall lips and synthetic islands default off: they caused transverse cuts and hide geometry problems.
- `riverLandscape.js` bakes sparse independent hills and cut-only bank retreat in the worker. World-cell hill placement varies size, shape, height, density and erodibility. Placement range selects centres; it never truncates hill footprints into a corridor border. Hills crossing existing lake footprints are rejected rather than clipped into shore walls.
- Landscape defaults live in `RIVER_LANDSCAPE_DEFAULTS`, overridden through `waterGraph.landscape` and optional `perRiver[id]`. The placement fixture gives >5 m of added relief at 64–66% of side probes. This is a placement statistic, not a promise that every rendered river has that distribution; lakes and the actual ground change it.
- The old forced valley roof/fill implementation is removed. Hills and bank excavation now enter **before the existing Runevision call**, so it reads the actual valley slope. Local material-dependent erosion amount avoids requiring mountain-sized relief on a river bank. A separate runoff experiment added 28 ms without sufficient visible gain; its code and controls were deleted. There is no second erosion pass.
- Changing slope also changes Runevision's gully pattern. The atlas therefore carries the sampled, excavated bank elevation and its clearance above the water. Smooth bounds limit erosion relative to that ground: downward changes use a fraction of the clearance; upward changes use a fraction of material already removed. This does not construct a water-level roof or lift low natural terrain into a levee. The final narrow channel correction clears the wet bed. Bounds and local amount are configurable through `waterGraph.valley.erosionStrength`, `erosionDepthFraction`, and `erosionRidgeFraction`.
- The existing four-word atlas format now holds f32 cut depth and bank elevation, half-float hill/erodible hill/cut heights, positive half-float clearance and a lake-guard bit. Absolute bank elevations keep f32 precision at high altitude. C2 interpolation supplies derivatives. Sparse field support selects pages and culls unrelated rivers per page; independent hill footprints are selected separately. Samplers/support indices are cached in the worker. Incision uses one sparse index and compact typed numeric arrays rather than six Maps per cell.
- Surface levels are independent of depth. They remain flat through full-width lake overlaps, then descend; varying bed depth may rise after a pool. Mouth widening is centred on the actual lake boundary. Source points are inset far enough to overlap the lake with the whole mouth; no backward source ribbon cap.
- Segment-list capacity now counts segments rather than the two array entries per segment. Ribbons cover width/wobble excursions between rows and discard outside the actual channel. Lake shore-band coverage yields to descending river water.
- Near water previously added only Fresnel over water-coloured terrain. Submerged bed faces appeared as green sheets and uphill water. Near meshes now draw the existing deep-water body colour on the true surface as well, fading to terrain shading with distance. This deliberately hides bed detail near the camera until proper refraction/depth rendering is addressed; it is a coverage correction, not finished water texturing. No fragment-depth rewrite.

Validation on the native Dawn/Metal lab (`../terrain-lab`, no browser):

- `river-features-check.mjs ../spherecraft`: rivers 17, 12, 25, 28, about 68 km; no dry arm pairs or >8 m gaps, zero CPU surface rises; independent bed rises remain. Latest landscape bakes: 29, 32, 46, 47 ms. Atlas coverage fell from 308 pages / 6.4 MB to 120 / 2.5 MB for the same rivers. These are populated pages, not a claim that the preallocated GPU buffer shrank.
- `river-phase-cost.mjs ../spherecraft`, final spatial-culling run: landscape 34.0 / 32.8 / 43.3 / 44.8 ms; atlas 21.9 / 30.6 / 27.9 / 36.1 ms. Combined shaping is 56 / 63 / 71 / 81 ms. The ideal 50 ms is not yet met for most rivers; it fits the owner's earlier 60–80 ms allowance closely. Existing lake refinement, route solve and GPU height sampling are separate: complete cold refinement measured 0.45–3.9 s, mostly lake solving. Do not call full generation a 50 ms operation. Allocation/GC outliers can be higher.
- Terrain height/normal/tile generation, 24 river tiles at 128² / depth 11, alternating seven-run medians: 2.875 ms bound vs 2.594 ms unbound in one run; 2.908 vs 2.589 in the final run (about 11–12% incremental generation cost). This includes the stronger same-pass bank erosion and bounds; it is not whole-frame FPS. Earlier 1–2% claims applied to the weaker revision and are superseded.
- `river-surface-gradient-check.mjs ../spherecraft`: GPU lookup including lake ownership at 2 m spacing along the shifted centres; 34,233 samples across the same rivers, no missing river samples or >2 cm downstream surface rises.
- `river-geometry-render.mjs ../spherecraft 17` and `... 12`: native offscreen renders of production terrain, lake and ribbon shaders with plain diagnostic terrain colours. Isolated bed, lake and river draws reproduced the source sheets; surface-body coverage removes that false geometry. These renders do not establish parity with the owner's canyon references. The owner judges the live visuals.
- `npx vitest run`: 235 tests pass, including hill coverage/gaps, lake clearance, sparse cache roundtrip, cut-only retreat, high-altitude bank precision, atlas apron identity/support across cube seams, monotone levels and segment capacity. Targeted lint and `git diff --check` pass.

Known limits: the physical flood diagnostic still finds about 13.11% wet samples outside the narrow channel zone, overwhelmingly in natural low terrain near the destination lake. No levees are added to conceal this. Shared lake/floodplain refinement remains unresolved. Native river 12 renders show hillside gullies reaching the river, but canyon reference parity and complete waterfall geometry remain open; the owner judges live visuals. Optional waterfall selection now requires at least an 8% local grade and 100 m total head; automatic lips remain off until geometry is validated, so the old lowland transverse walls do not return.

## Setup and owner's rules

- Repo `AI-Three-D/spherecraft`, branch `codex-restart`, local path `/Users/okkokauhanen/work/DATrain/feature/proj/spherecraft`.
- Run with `python3 server.py`, then open http://localhost:8181/wizard_game/standalone.html. Port 8000 is the owner's.
- Console:
  - `qtDiag.water.near(5)` lists lakes; `qtDiag.water.goto(id, 60)` puts the camera by a lake;
  - `qtDiag.water.nearMesh(true|false)` switches the near water;
  - `qtDiag.water.tint(0..4)` debug views (4: who draws the surface);
  - `qtDiag.water.look({...})`; `qtDiag.water.carve()` gives regeneration counts;
  - `qtDiag.water.stats()`.
- Lab: `../terrain-lab/` (outside git). The real terrain generator and water service run in Node on the GPU via Dawn. Compute-only lab runs are allowed without asking. Headless browser runs need the owner's permission (use system Chrome 154).
- Owner's rules:
  - State your confidence and what would prove you wrong before you implement.
  - Prove causes with measurements or debug views; never ship a second unverified guess.
  - Keep features config-driven. Delete removed features outright (code, toggles, config).
  - WGSL has no `?:`; `active` and `target` are reserved words.
  - One thing at a time. Short, concrete replies with a recommendation.
  - The owner judges visuals in the browser. Commit a step after the owner has checked it.
  - Never commit `IMPLEMENTATION_PLAN*.md`. Push only when asked.
- **Committing.** The working tree still holds the owner's uncommitted Session 4 terrain work (mountain/highland pruning, `earthLikeBase` restructure, land regions, lake basins), partly staged. Never sweep it in.
  - Build commits in a temporary index (`GIT_INDEX_FILE=... git read-tree HEAD`, `update-index --cacheinfo`, `write-tree`, `commit-tree`, `update-ref`).
  - Test the exported tree in isolation (`git archive`; symlink `node_modules`; `npx vitest run`).
  - Then sync the real index for the committed paths and re-apply the owner's staged patches (`git diff --cached` saved beforehand).
  - In zsh, unquoted variables don't word-split: feed path lists through `xargs`.

## Done (commits on codex-restart)

- **38e71ae** Lake surface mesh near the camera, body/surface colour split.
- **d9def8f** River valleys baked into the terrain, and the water level of the discharge (the river-terrain session's work, committed as it ran). Its height-function hooks are placed on the pre-Session-4 landforms; the owner runs them on Session 4's.
- **b3fb1ba** Rivers in the lakes' approach (near ribbons), lake band trimmed beside rivers, simulation off.

### Architecture now

- **Far water (terrain shader):**
  - `applyWater` in `core/world/water/waterWgsl.js` recolours terrain below a lake's level (inside its mask) or a river's level (inside its channel).
  - Kept for far water on purpose: it's cheaper, the lookups are paid anyway, and a far mesh would z-fight with depth24 forward-Z.
- **Near water (meshes), 0–1.6 km:** `core/renderer/water/NearWaterRenderer.js` and `nearWaterSurface.wgsl.js`.
  - Lakes: one camera-centred grid (97², finest at the camera) instanced per lake, flat at the lake's level and clamped to its patch; the lake mask discards the rest.
  - Rivers: ribbons from `core/world/water/riverRibbon.js`, flat across at the water level and 2 m wider than the channel, with caps at a river's ends and no fold in bends.
  - The terrain's depth hides both where the ground rises above the level, so the shoreline is where the water meets the ground.
- **Colour split:** near the camera the terrain shader draws only the water's body (`waterBodyColor`: the bed through the water column). The mesh adds the surface (`waterSurfaceTerms`: ripples, Fresnel sky, glint) with premultiplied alpha. The hand-over band (`WaterGpuData.near`: fadeStartM 1000, fadeEndM 1600) blends exactly to the full far water, aerial perspective included (`aerialFadeRange`, shared with the terrain shader builder).
- **Rivers look like lakes everywhere** (owner: "same texture everywhere first"). The old flow look (`waterRiverColor`) is deleted.
- **Simulation strip off** (`runtimeConfigs.js` `waterGraph.sim.enabled: false`). It is to come back driving the river ribbons.
- **Junctions:**
  - The ribbon gives way inside a lake's mask and to a nearer river.
  - River levels ease to the lake level over 80 m (`riverWaterLevels`, used by the ribbons and the terrain's river segments alike).
  - The bank soil tint continues under lake water at a mouth (`WaterRiverHit.pool`).
- **Lake band trim** (`core/world/water/lakeBand.js`, applied in `WaterGpuData`): band cells within the carve's reach of a river outside lakes are cleared.
  - Why: lakes are solved before the carve, which lowered the ground beside channels, so band water showed in hollows.
  - It's a stopgap until carving and lakes are solved together.
- Absorption default `[0.45, 0.2, 0.15]` (clear water).
- Tests: `npx vitest run`, 204/204.

### Measured cost of water for tile loading (lab `terrain-lab/water-tile-cost.mjs`)

- **Terrain function per tile:**
  - carve + valley compiled out: 2.30 ms;
  - compiled in: 2.46 ms (+7 %, every tile);
  - on river tiles with data: 2.82 ms (+19 %).
- **Water service GPU sampling:** about 30 ms per dispatch (max 124 ms), about 1 per lake and 3 per river.
- **Regeneration (browser, owner's flight):** `qtDiag.water.carve()` gave version 36, queued 935, done 638, pending 100 for 17 rivers.
  - Each river trace bumps the global `waterCarveVersion`. That re-queues every tile generating or refining at that moment, anywhere (`tileStreamer.js` around lines 2062 and 2529).
  - It also re-queues every resident tile touching the river's grid cells (`gameEngine._tickWater` → `regenerateTiles`).

## What comes next (owner's order)

1. **Carving (next).** The owner: rivers don't always connect to their lakes, and the channel looks like a "terrible man-made moat".
   - Seen in the browser and the lab:
     - a river channel ending in a round cap short of its lake, with grass between;
     - dry channel stretches where the carved bed is above the water level;
     - outlets dropping steeply (lab outlet 17: 9.6 m in the first 100 m);
     - hollows beside the channel below the lake level (hidden now by the band trim);
     - uniform-width, steep-banked channels.
   - Code: `core/world/water/riverCarve.wgsl.js` (channel cross-section in the height function), `riverValley.js` / `riverValley.wgsl.js` (valley field, defaults in `RIVER_VALLEY_DEFAULTS`), `core/world/hydrology/riverRefine.js` and `waterWorkerCore.js` (tracing, levels), `WaterService.js` (refine and bake order; lakes are solved on the natural terrain, not the final one).
   - Lab scripts: `valley-outlet-check.mjs`, `near-band-check.mjs`, `valley-prod-run.mjs`, `valley-bed-check.mjs`, `valley-proto.mjs`.
   - Earlier attempts and their outcomes are in `WATER_HANDOFF.md` §4–5 and in the session notes. Carving into a finished terrain failed ("moat"). The valley bake (network first, terrain second) is the current approach.
   - **Also in this phase (owner agreed):** cut the regeneration cost.
     - On a river change, re-queue only tiles that touch the changed cells, not every tile in flight (track a per-cell or per-region version instead of the global `waterCarveVersion`).
     - Batch river changes, so a burst of traces costs one regeneration round.
     - Measure before and after with `qtDiag.water.carve()`.
2. **River look and simulation:** bring the simulation back on the ribbons (texturing and geometry animation).
3. **Lakes, last:** weather-dependent geometric waves, and the look. Today the sun glint (×3, power 600, on ripples) makes white blobs and speckles toward a low sun.
4. **Diving:** not placed by the owner yet. Plan in `WATER_GEOMETRY_HANDOFF.md`, earlier list item 7:
   - a camera-under-water state;
   - the mesh's underside (Snell's window);
   - underwater fog in the tone-mapping pass (it already reads the scene; depth is sampleable);
   - no from-above tint while under water.
5. **Optimization** where needed.

## Known open items

- River ends at the sea: the old ocean renderer (`globalOceanRenderer`, out of scope; to be reworked later) draws a flat green sea. Check: `qtDiag.water.tint(1)` leaves it unchanged.
- Objects standing in water get the surface overlay but no absorption.
- The terrain-shader body near a mouth uses the eased level. The carve itself doesn't read the water level, so easing never regenerates tiles.
- Lake mesh: at most 16 lakes listed near the camera. A lake left out would lose its surface inside the near range.
