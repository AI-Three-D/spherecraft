# SphereCraft water: status and next steps (hand-off, 2026-10-06)

This is for whichever agent continues the water work. Read it first, then `WATER_GEOMETRY_HANDOFF.md` (details and session log) and `WATER_HANDOFF.md` (how rivers are traced, carved and simulated).

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
