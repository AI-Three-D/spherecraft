# Water in SphereCraft: hand-off (2026-10-05)

For the next session (any agent) and the owner. It covers:
- what exists;
- what the owner saw;
- what is broken and why (measured where possible);
- what has only been verified in the lab;
- the recommended way forward, including the owner's question about running an erosion simulation at load.

Repo `AI-Three-D/spherecraft`, branch `codex-restart`.
- HEAD of the remote is `80919e8` ("river integration", the owner's commit of the whole working tree).
- One local fix sits on top of it (see the end).

**The owner's verdict:** "Looks still terrible. We have a long way to go."

**My own assessment:** the lakes work. The river approach has a structural flaw (§4), and patching on top of it will not reach Whitewater's quality.

---

## 1. Owner requirements (verbatim where possible)

- "Networks of lake-river-sea systems. Not all lakes connect to a river. All rivers connect to a lake at upstream and all connect to another lake or sea downstream. No dead ends."
- Whitewater (`AI-Three-D/whitewater`, kayaking game, hand-written shallow-water solver) is the technical reference and proof of concept. Rebuild it in SphereCraft rather than copying it.
- The minimum bar is Whitewater's look (close-up and slightly higher camera), at ≥ 90 fps on the owner's MacBook. The terrain alone runs at 60–90 fps; Whitewater runs at 110+.
- The river must never flow backwards. The bed may have deeper pools that hold water; only the water level must not rise downstream.
- Rivers should be used sparingly. Two running next to each other looks bad, and so do rivers through puddles and wetlands.
- River width: at least 3× the first version, so ≥ 30 m.
- Static water only very far away. Animated water at medium distance (no simulation needed there). Simulation near the camera, with no visible warm-up: "We cannot wait seconds for it to settle."
- Performance is very important; faking things is fine.
- Earlier decisions (still standing):
  - ~1,160 lakes, natural lake shores from a 16 m solve.
  - Erosion-seed pits off.
  - Water drawn inside the terrain shading (reversed-Z and separate water meshes kept as the alternative).
  - The old ocean has wave and seam problems and will be reworked later.

## 2. What exists (all behind `terrain.waterGraph.enabled`)

### 2.1 Pipeline

1. **Grid** (`core/world/hydrology/HydrologyGrid.js`): the terrain height function sampled on the GPU on a cube grid of 6 × 512² (~400 m cells), plus 16 m tangent-plane patches. It is cached in IndexedDB (`waterCache.js`).
2. **Water graph** (`waterGraph.js`, in a worker via `waterWorkerCore.js`):
   - Priority flood (Barnes) and depressions → lakes. A lake is a whole water body holding a deep core.
   - Flow accumulation Q.
   - Rivers from lakes whose outflow Q ≥ `minRiverQ` (now 1200 → 164 rivers, before 344). Confluences are recorded.
3. **Lake refinement** (`lakeRefine.js`, lazy within 40 km, nearest first): a 16 m flood solve per lake gives the true level, the shore region, the outflow path out of the sill, and merges.
   - **This part works and looks right** (owner saw lakes in the browser).
4. **River trace** (`riverRefine.js` + `waterWorkerCore.solveRiver`):
   - Route: from the lake's fine outflow down the graph's drainage. It ends in a strictly lower lake, the sea, or (new in `80919e8`) another river's path, as a confluence.
   - Trace: a 16 m corridor patch, flood-seeded from the destination's water.
   - The line is smoothed (moving average, then 20 m resample, then 8 binomial passes).
   - Width and depth from Q (`riverShape`): min 30 m wide, bank-full depth ≥ 1.4 m.
   - Water level (`riverLevels`): least-squares non-increasing fit of the ground along the line minus an incision, pinned to lakes the river crosses. It never rises downstream.
   - Output: points with stride 12 (`RIVER_POINT_STRIDE`).
5. **GPU water data** (`core/world/water/WaterGpuData.js`, `waterWgsl.js`):
   - Cube-grid index: two lake slots per cell. River segments are listed per 4 × 4 sub-cell (~100 m).
   - Lake table, lake mask atlas (96 × 512² r8), river segments (96 B each, up to 262,144).
   - Layout keeps the rivers nearest the camera, by each river's nearest point.
6. **River carve** (`core/world/water/riverCarve.wgsl.js`): rivers are shaped into the terrain height function as its last step, so every LOD, the normals and the simulation bed agree.
   - Cross-section after Whitewater: channel `T + D(1 − (1 − u²)^1.5)` with the thalweg toward the outer bank, then a bank rising `bankH`. Past the crest: cut toward a rising valley side, fill toward a falling natural levee.
   - Width, centre and bank height wobble along the river (`riverShapeNoise.js`, integer-hash 1D noise shared by GPU and JS).
   - Segments are blended by distance.
   - The carve is a feature toggle (`waterCarve`). The generator's bind group 1 gains bindings 1–3.
   - Resident tiles touching changed rivers are regenerated in place (`TileStreamer.regenerateTiles`).
7. **Terrain shading** (`waterWgsl.js applyWater`, called from `terrainChunkFragmentShaderBuilder.js` before aerial perspective):
   - Lakes: lookup and mask.
   - Rivers: water inside the channel only. Animated flow ripples and foam out to 1.5 km, plain colour by 3 km.
   - Brown wet banks.
   - Lakes whose shore isn't solved yet are hidden within 2.5 km.
   - The simulation strip's river stretch fades the static water out.
8. **Near simulation** (`ShallowWaterSim.js` + `shallowWaterSim.wgsl.js`: Whitewater's numerics rebuilt; `WaterRiverSim.js`, `riverStrip.js`):
   - A strip of 1 m cells (~64 × 768) along the river nearest the camera (within 1.5 km, camera below 600 m).
   - Banks are closed edges, inflow is relaxed upstream, the outflow is open.
   - The rows are a ring, so it scrolls along the river in 64 m steps without restarting. It starts in a steady state.
   - Drawn by `core/renderer/water/WaterSimRenderer.js` + `waterSimSurface.wgsl.js` (Whitewater's look).
9. **Service** (`WaterService.js`):
   - Background start after the initial terrain load.
   - Per frame it starts the nearest piece of work (lake or river) by distance from where the camera will be 3 s ahead.
   - `WATER_ALGO_VERSION` invalidates caches (now `water-v7`).

**Console tools:** `qtDiag.water.stats() / near() / goto(id) / tint(0..3) / look({...}) / sim() / carve()`.

**Config:**
- `wizard_game/runtimeConfigs.js` → `waterGraph: { enabled, sim: {...} }`.
- Service defaults are in `WaterService.js` (`WATER_SERVICE_DEFAULTS`: `rivers`, `carve`, `refine`).

### 2.2 Tests and lab

- **Unit tests:** 179 vitest tests, all passing at the local HEAD. They include WGSL validation through naga.
- **Lab:** `../terrain-lab/` (outside git; Node + Dawn running the real generator). Every script takes the spherecraft root as its first argument.
  - Set `LAB_TERRAIN_JSON='{"waterGraph":{"enabled":true}}'` to compile the carve in.
  - `LAB_WATER_JSON` overrides the service config, in the scripts that support it.
  - **Gotcha:** a script that passes `config: {cache:false}` to `WaterService` *replaces* the planet's water config.
- **Main scripts:**

| Script | What it checks |
|---|---|
| `water-scale-run.mjs` | browser-scale refinement; GPU list overflow; side-by-side rivers; water along every river via the shader's own lookup; the strip simulation |
| `water-corridor-run.mjs` | flood test for escapes; bank crest; cut/fill; CPU mirror of the carve vs GPU; pictures |
| `water-river-sim-run.mjs` | moving camera, strip shifts, spill, foam, cost |
| `water-latency-run.mjs` | refinement timing |
| `water-look-render.mjs` | `applyWater` rendered over a carved patch |
| `water-carve-cost.mjs` | GPU ms per tile |
| `tint-frag-check.mjs` | terrain fragment shader through Tint |
| `swe-tests.mjs` | solver physics |
| `lake-*.mjs` | lake solves |

- Headless browser runs need the owner's permission. The owner tests at `localhost:8181`.

## 3. What the owner saw (browser, 2026-10-05) and the diagnosis

| Owner observation | Cause (status) |
|---|---|
| Rivers look like a dug moat, ugly straight banks | **Structural (§4).** Rivers are carved into a finished terrain, often along a side slope. Lab, bank zone: cut median 2.8 m / p95 8.8 m, fill (embankment) median 2.9 m / p95 13 m. Also 40 m straight segments, constant width, uniform brown band. `80919e8` adds curves, width and centre wobble and a natural levee; these are lab-checked only and don't fix the structural part. |
| Simulated water creeps like lava; extremely white foam even on slow rivers; the simulation blinks in and out | Mostly measured: the GPU river lists **overflowed** at browser scale (326k entries wanted, 262k fit). Rivers were dropped by the distance of their *source*, so a river passing the camera could lose its carve. The simulation then ran on uncarved terrain: a thin film flowing from the inflow edge (white because Froude is high in thin water). Fixed in `80919e8`: hollow fill removed (lists 5× smaller), nearest-point priority, the simulation only on rivers in the lists. Lab: the strip starts full, volume steady, foam 0–8 %. **Not yet seen in the browser.** |
| Water areas never refine / "never settles"; straight-edged water | Same overflow, plus a river re-entering the lists didn't mark its tiles stale. River water was also drawn out to the zone edge on terrain not yet re-carved (a straight line). Fixed in `80919e8`: membership changes mark tiles; river water only inside the channel. Tile regeneration (`TileStreamer._tickRegeneration`, spare GPU budget only) **is unverified in the browser**. Check with `qtDiag.water.carve()` (queued/done/pending). |
| Two rivers side by side, one never settles | Measured: routes passing through a lake that isn't lower followed that lake's own river, so two traces went down one valley. Fixed: a route ends at another river's path (confluence), with the trunk traced first. Lab: side-by-side length 0.12 km over 15 rivers. |
| Rivers don't connect to the upstream lake | Not reproduced. Lab: 0 dry samples of 9,362 along all rivers (lake or river water at every centre-line point on the carved terrain). Likely the overflow (river not drawn). **Unverified in the browser.** |
| Refinement too slow, hard edges for 1–3 s | Lakes take ~2.5 s each; rivers take 2–13 s each (long rivers are traced as one big patch). The scheduler used to do all lakes first, then rivers; it is now nearest-first with look-ahead. Water within 2 km is done ~5 s after the graph is ready. Unsolved lakes are hidden within 2.5 km. Still slow in absolute terms (see §5). |
| Too many rivers, rivers through puddles and wetlands | `minRiverQ` 400 → 1200 (344 → 164 rivers). |

A ChatGPT review of the branch was requested. If it read GitHub before `80919e8` was pushed, it saw the code without these fixes.

## 4. Root problem (my view)

The pipeline is **terrain first, rivers traced on it, then carved into it**. The terrain function knows nothing about rivers, so a traced river lands wherever the 16 m drainage goes:
- across side slopes;
- through flood-filled depressions;
- over humps.

The carve then has to cut metres into hillsides and build embankments over hollows. Every fix (levee shapes, wobble, smoothing) works against a terrain that has no valleys for these rivers. Whitewater does the opposite: it builds the terrain *from* the river (channel, banks, valley rising 10–40 m on both sides, thermal erosion outside the channel). Its rivers always sit on a valley floor, so they look natural and the water has no way out.

**Consequence:** any fix that keeps "carve after the fact" will keep looking dug. River valleys must become part of the terrain's large-scale shape, before the RuneVision erosion filter, so the filter's gullies drain into them.

The second structural limitation is that **all of it is lazy and local.** Lakes, rivers, carving and tile regeneration happen after the terrain is already visible, so the user watches it change. Anything shaping the terrain should be done before the first tiles are shown, and cached.

## 5. Owner's question: run a water and erosion simulation at load?

> "Could we somehow run a water and erosion simulation initially on loading (for a minute or two) to do planet-wide proper geological river formation? … Or some solution that partially fakes it at startup, but then does proper real erosion around a bounded area near some preselected river network."

**Short answer: yes, and I think this is the right direction.** It fixes §4: the river network decides the terrain's valleys, and the terrain is final before it is shown. Numbers below are estimates unless marked measured.

### Scale

- Planet R = 131,072 m, so the surface is ≈ 216,000 km².
- Cube face edge ≈ 206 km.
- At 200 m cells that is 6 × 1024² ≈ 6.3 M cells; at 100 m, 6 × 2048² ≈ 25 M.

### Option A: global stream-power erosion at load (true simulation, coarse)

- **Model:** stream-power fluvial incision with uplift balance plus hillslope diffusion, run on the 200 m cube grid. Use the implicit Braun–Willett solver: O(n) per step with a drainage stack, unconditionally stable. Depressions are handled by the priority flood we already have; they become the lakes. This is the method of Cordonnier et al. 2016 ("Large scale terrain generation from tectonic uplift and fluvial erosion"). It produces dendritic valleys and natural river placement.
- **Cost:** in a JS worker roughly 0.5–1.5 s per step at 6.3 M cells, so 1–3 min for 50–150 steps (estimate). A GPU version is possible (Jain et al. 2024, "FastFlow"), but parallel flow routing is the hard part. Run once per seed, cache in IndexedDB (~13 MB as f16), so later loads are instant.
- **Use:**
  - The result is a **height delta field** on a cube texture. `calculateTerrainHeightD` samples it with a C2 bicubic B-spline (C2 is required before the erosion filter) and adds it before the RuneVision filter. LOD consistency is then automatic, and no per-river lists or tile regeneration are needed for the valleys.
  - The same run yields the **drainage network** (Q per cell, river paths) and lake levels, which replace today's graph.
- **Still needed:** 30–60 m wide channels are below 200 m resolution. Keep a procedural channel carve along the extracted network. It now sits on valley floors, so cuts are small and banks look natural.
- **Risks:**
  - It changes the planet's overall look (the owner tuned the terrain); this needs an amplitude control.
  - Implementing the drainage-stack solver well is real work.
  - 1–3 min at first load.

### Option B (recommended first): network first, procedural valleys at load, local erosion later

1. **At load (seconds; we already do most of it):**
   - Coarse drainage on the existing 512² grid; choose the trunk rivers (Q threshold); smooth and meander their paths.
   - Assign a monotone water level along each river and the lake levels.
2. **Valley field (GPU, ~seconds):**
   - Jump-flood a distance field on a 6 × 2048² cube texture (~100 m texels), storing for each texel the distance to the nearest river, that river's Q and its level.
   - The height function blends the terrain toward a valley cross-section built from these: floor at the level, width and depth growing with Q, walls easing into the terrain (Génevaux et al. 2013, "Terrain generation using procedural models based on hydrology"; the same principle as Whitewater's `river.js`).
   - Apply it before the erosion filter, so gullies feed the valleys.
   - Result: every river has a valley at every LOD from the first tile, and the channel carve becomes shallow.
3. **Local erosion near the camera (optional polish):**
   - GPU hydraulic or thermal erosion on bounded corridors (~2 km × river length, 8–16 m cells) along rivers near the camera.
   - Results go into an atlas, the way lake masks do. It adds natural banks, terraces and point bars.
   - Cost per corridor ~0.1–0.5 s GPU (estimate). It needs the existing tile-regeneration path, but only for detail, not for the main shape.

- **Why first:** it reuses the graph, the lake solve and the shading. Load-time cost is small. The visual win (rivers in valleys) is most of what's missing.
- **Risk:** the valleys can look too procedural or uniform; noise on the valley parameters helps. If it isn't good enough, move to Option A, which keeps the same consumer path: a delta field plus a network.

### Option C: purely procedural dendritic valleys (no simulation)

Locally computable river-network noise, e.g. Gaillard et al. 2019 "Dendry":
- **Pros:** zero load time, perfect LOD consistency.
- **Cons:** noise decides river placement, so guaranteeing the lake → river → lake/sea topology is hard. I would not start here.

### What carries over in any option

- The lake solve (§2.1 step 3) is good.
- The terrain-shading water (lakes, animated river surface, far colour) and the confluence logic carry over.
- So does the near simulation strip: once the bed is a real valley channel, its steady-state start is the "prewarm". The lab shows it full and steady from frame 0 when the bed is carved.
- Foam: once the strip has a real channel (no thin films), only watch foam on steep reaches.

## 6. Unverified, and known open issues

- **Not seen in a browser:**
  - `80919e8`'s fixes: overflow, confluences, `minRiverQ`, curves and wobble, levee, unsolved-lake hiding, channel-only river water, the strip only on drawn rivers.
  - The animated medium-distance water.
  - Tile regeneration.
- **Performance not measured in the browser:**
  - Fragment cost of the river shading (per pixel, one walk over the sub-cell segment list plus noise for the nearest segment).
  - The strip simulation (lab: 0.3–0.8 ms per frame wall time).
  - Tile generation: lab, +6 % per tile with the carve compiled in, +10 % on river tiles.
- **Strip:**
  - One river at a time, ~768 m. Switching rivers fades out and back in.
  - A 64 m shift injects steady-state rows that can transiently hit 3–6 m/s at the seam.
- **Long rivers** (30–55 km) are traced as one large patch: 2–13 s, with retries.
- **Lake/carve:** giant lakes' coarse regions leave lake-level hollows near their shores.
- **Tributary staleness:** a re-traced trunk does not re-trace its tributaries.
- **Old systems still present and unused:**
  - The old lake system (`core/renderer/lakes/*`, `ErosionSeedVerifier`, erosion-seed pits switched off).
  - The walking-skeleton river (`featureRivers`, `TF_RIVER_CARVE`).
  - The old ocean.

## 7. Session log (this water effort)

| Commit | What |
|---|---|
| `c82165b` … `ad4e93d` | Pits off; water graph; 16 m lake solve; WaterService (worker, cache, lazy refine); shallow-water solver; lake GPU data and terrain shading; lake count −1/3 |
| `6073c9b` | Rivers traced at 16 m lake → lake/sea, drawn in the terrain shading |
| `19b8fe3` | Near-field SWE as a 256 m square around the camera (replaced in `4df8cbf`) |
| `33915bf` | River channels carved into the height function; sub-cell segment lists; in-place tile regeneration |
| `4c87c7a` | Whitewater cross-section, 3× wider rivers, level fit, hollow fill (removed again in `80919e8`) |
| `4df8cbf` | Simulation strip along the river, scrolling ring rows, no restarts |
| `627c299` | Animated medium-distance river shading in Whitewater's colours |
| `80919e8` (owner) | Uncommitted work: confluences, `minRiverQ` 1200, list-overflow fixes, river curves and wobble, natural levee, nearest-first scheduler, unsolved-lake hiding, channel-only river water, `IMPLEMENTATION_PLAN*.md` |
| local, after `80919e8` | `WaterGpuData._rebuildRivers`: the nearest-point check always includes a river's last point (fixes the one failing test; 179/179 pass) |

**Plan files:**
- `IMPLEMENTATION_PLAN.md` (overall roadmap).
- `IMPLEMENTATION_PLAN_SUPPLEMENT.md` (working agreements, facts not worth rediscovering, terrain history).
- `IMPLEMENTATION_PLAN_WATER.md` (water plan v2; superseded by §4–5 here).

## 7b. Corrections after the ChatGPT review (verified in the code at `80919e8`)

These are real defects, and some correct §3 above:

1. **Slow, "lava-like" flow has a second cause besides the list overflow: the level fit.**
   - `riverLevels` uses `fitNonIncreasing`, a least-squares monotone fit. Its output is always a staircase: flat runs with sudden drops.
   - Since `627c299` the speed comes from that level's slope (`etaSlope`). So most of a river has slope 0 and speed at the `riverShape` floor of 0.3 m/s. The lab strip on river 135 reached a max of 0.4 m/s.
   - The flat runs also make the simulation pond and plunge, which concentrates foam at the steps.
   - Fix: the water level must be a smooth, strictly falling curve (minimum slope, e.g. ≥ 3e-4) between the source and destination levels. Speed must not come from a fitted step function.
2. **Velocities don't add up to the discharge.**
   - Width, depth and speed are estimated separately (`riverShape`).
   - The strip's start and inflow use `speed × (h/hMean)^⅔`, clamped, without normalizing to Q.
   - Whitewater normalizes: `inVelScale = Q / Σ h^(5/3)·dx` (`river.js`). Do the same, so the start state and inflow carry Q.
3. **`weakEnd` is published as a successful river** (`waterWorkerCore.solveRiver`, logged in `WaterService`). That is a dead-end path. Remove it: grow the corridor or the destination patch and retry, else fail.
4. **The scheduler gates rivers on their source lake.** In `WaterService.update` a river is a candidate only while iterating a lake within `radiusM` (40 km). A river near the camera with a farther source is never picked. Rivers need their own candidate list, by their own distance.
5. **Animation speed is tied to the physical speed** (`waterRiverColor`: `max(river.speed, 0.2)`), so it crawls too. Use a separate visual speed.
6. **Stale tiles.** Tile regeneration runs on spare GPU budget only, with no priority for visible river tiles, and water shading doesn't know whether the tile under it has the current carve. Track a carve version per tile, and give visible river tiles priority.
7. **Simulation start.** The strip starts in a steady-state guess and fades in at once. A hidden warm-up is better: the static river shows while the strip runs 100–300 substeps, and it takes over when its surface matches the static level and discharge.

What the review got wrong:
- "Remove the fill": the owner's test shows the simulation spills without confinement.
- "The coarse graph dictates the banks": the 16 m trace does.
- "Endpoints are point-based": they are seeded from the destination's solved shore region, except for `weakEnd`.

Its useful new idea: shape the bed as a constrained optimisation, the smallest smooth terrain change that keeps the river's water from escaping. The flood/escape test in `water-corridor-run.mjs` can be the objective, and it fits Option B in §5.

## 8. Suggested first steps for the next session

1. Decide between Option B and Option A (§5) with the owner.
2. Before writing code, prototype the valley field in the lab (`terrain-lab`, Dawn):
   - Build the network.
   - Run jump flooding on a cube texture.
   - Sample it in the height function.
   - Render cross-sections and pictures of a few rivers.

   Compare with today's carve using the same metrics as `water-corridor-run.mjs`: cut/fill in the bank zone, crest above the water, escapes.
3. Keep the lake solve, the shading and the strip. Retire the per-river carve lists once valleys come from a field, keeping a shallow channel carve only.
4. Get the owner's browser check after each visible step. Ask before any headless run.
