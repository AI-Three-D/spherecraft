# River and lake optimization plan

2026-11-06. Updated for the owner’s follow-up; implementation and measured results are recorded in [RIVERS_AND_LAKES.md](RIVERS_AND_LAKES.md).

Read [RIVERS_AND_LAKES.md](RIVERS_AND_LAKES.md) first: section 1 (the owner's bar), section 4 (what failed) and section 10 to its end (the latest work). Report results there, not in new handoff files: it is the single entry point for water.

## 1. What the owner decided

**Current direction (owner):** improve river generation and its visible arrival, then investigate lakes generated with terrain. The specific investigation and experiment plan is [LAKES_IN_TERRAIN_GENERATION_PLAN.md](LAKES_IN_TERRAIN_GENERATION_PLAN.md). Teleport implementation remains deferred.

- **Loading screen:** "we can hide a bit of work behind the loading screen, but not much."
- **Planet size:** planets can scale up a lot. No detailed planet-wide computation unless it fits in memory on larger planets too. The demo planet is 131 km; plan for 1000+ km, which is 58 times the surface.
- **Two modes:** one that precomputes more, one a bit slower that computes on demand. Both have to be very efficient.
- **Design is open:** assess foundational replacements as well as improvements to existing code. Any terrain, scheduling or LOD work that supports water is in scope. Preserve the approved appearance at normal detail, or improve it; deliberately coarser detail is acceptable in fast flight.
- **Hardware:** expose configurable quality, compute and memory limits suitable for low- and high-end GPUs. Do not assume one fixed budget fits all systems.
- **Speed and teleport:** at slow and medium speeds aim for water to appear almost immediately, roughly 100 ms or less; fast flight should automatically prioritize coarser water when generation falls behind, then refine. Teleport is possible; at startup and teleport one or two seconds may be acceptable. These are goals, not measured guarantees.
- **Selection:** choose the mode in settings, never automatically based on planet size. The old regional terrain placement is switched off by default, retained for now and likely removable later.

Earlier standing goals that still apply: coarse lakes and rivers should load nearly instantly, water must not cause tile regeneration or pop in after load, FPS must hold in fast flight, and rendering cost should come down to a fraction of today's (owner, 2026-11-04).

**Still to determine by measurement:** practical per-device compute and memory budgets, the sustained speeds and distances each quality setting supports, and the actual startup/teleport costs. Minimize both time and memory; do not treat an unmeasured proposal as a promise. The current debug free camera can reach about 12.8 km/s, but this is not a user-specified required speed.

## 2. Where things stand

- Branch `water-ponds`, HEAD `ced2946`. **Uncommitted in the tree:** intakes at river starts (`riverPlumes` and `plumeAt` in `riverFlow.js`, the plume loop in `riverField.js`, tests, doc). It is finished and tested: keep it. Check `git status` and ask the owner before assuming it is committed.
- The reviewed terrain-sampled setup is `wizard_game/standalone.html?regionalTerrain=0&regionalBanks=organic&waterPrecompute=1&lodHeight=ground`. Regional placement is now off by default; the other URL options still affect the setup, including precomputed mountain lakes. Do not assume the bare URL is identical.
- Pipeline: section 2 of `RIVERS_AND_LAKES.md`. In short: a planet-wide grid and drainage graph, lakes solved at 32 m on patches, river traces solved on 16 m patches near the camera, then one baked river field near the camera (ground change, water level, signed distance, flow) on 2 m paged texels. The field changes terrain tiles, so publishing it regenerates tiles. Lakes are drawn per pixel and never regenerate tiles.

## 3. Measured baseline

River field bake at `ced2946`, 46 rivers, 9,164 pages, on an M1 Pro **with the owner's game open on the same GPU**. Treat it as a starting point and repeat it on a free GPU.

| Stage | ms | Notes |
|---|---|---|
| dirs | 492 | page directions, prepare step |
| sample | 686 | natural ground on the GPU |
| lakes | 1516 | **wall time; about 190 ms of real work.** 3 ms slices with a `setTimeout` between them, on the main thread |
| stations | 142 | |
| texels | 1798 | worker |
| blur | 535 | worker |
| wet | 872 | worker |
| sdf | 1347 | worker |
| flow | 249 | worker |
| pack | 712 | worker |
| publish | 28 | one main-thread block |
| **total** | **8505** | the worker stages (`finish`) are 5654, on **one** worker |

Read these from `riverFieldService.summary().stats.ms`, or from `fieldSummary` in `tools/perf/riverBanks/fieldProbe.js`.

Other facts:
- 143 MB for the field: 15.5 KB a page. About 60 % of pages have no water (4,937 dry of 8,258 in one measurement). Some of those carry banks; how many are completely empty is unknown.
- The whole field is rebaked every 1.5 km of travel, at most every 3 s, within a 6 km radius kept to 8.4 km. At 8.5 s a bake, anything over roughly 700 m/s outruns the radius.
- The original reveal waited for every river within 6 km to be traced and baked. It now reveals when terrain is ready while water streams; `readyForReveal` remains a progress diagnostic and counts failed rivers as done.
- There is no cache for field pages, so every start pays the bake. The grid, lakes and river traces are cached in IndexedDB.
- A 64 m page marks its 400 m grid cells plus one cell of margin (`_cellsOf`, `tilesTouchingCells(cells, N, 1)`): about a 1.2 km square of tiles regenerates per changed page. New pages with no ground change count as changed.
- Lake solves run at most 2 jobs while loading, on a pool of up to 6 (`WaterService.js`, `this._loading?.() ? 1 : poolSize`). That is when the player is waiting. It was set to protect tile loading.

Older figures, dated, for scale only: all lakes final about 32 s cold, 11 s warm (10-11, before mountain lakes); 2,225 mountain lakes, 3,239 ponds, 4,686 streams (10-12); 0.09-3.1 s per lake solve and 0.24-0.32 s per river solve (lab log); about 5 ms a tile (80 tiles in 402 ms, 11-05); cold shader stall 12.5 s (10-12). Lab rates: whole grid 0.33 s GPU, 32 m sampling about 20M samples/s, priority flood about 0.3 µs a cell.

## 4. Targets and measurements

These are owner-stated aims, not guarantees or fixed hardware budgets. Measure a water-off floor and report cold and warm startup separately, including shader compilation and cache state.

| Situation | Target |
|---|---|
| Slow/medium movement | Water appears almost immediately, aiming for 100 ms or less. |
| Fast flight | Keep up by automatically prioritizing lower detail and visible/ahead areas; refine when capacity permits. Measure coverage, lag, artifacts, frame time and speed. |
| Startup / teleport | Aim for a short wait, potentially 1–2 s, followed by refinement. Measure terrain-only time as well as water's contribution. |
| Visual quality | Normal-detail water should match or improve the reviewed reference; temporary coarser detail at high speed is acceptable. |
| Compute and memory | Minimize both; provide configurable limits for different GPUs and report peak as well as resident memory. Bound fine data on very large planets. |

Measure ms per km of river, ms and bytes per page, queue latency, coverage and cache effects. Set realistic quantitative device profiles only after measuring, and distinguish aspirational targets from achieved results.

## 5. The two modes

Both modes should share an authoritative water definition and produce the same final detailed water for the same seed and settings. They differ in when work happens and what is retained. A temporary coarser representation may differ in detail during flight or loading. Investigate shared solvers and data formats, but do not rule out a better foundation without comparing results. Select the mode in settings, not automatically by planet size.

| | Precompute mode | On-demand mode |
|---|---|---|
| For | planets whose data fits the budget | any planet size |
| Ahead of play | lakes and river traces solved ahead and stored | only bounded coarse data |
| During play | field bake near the camera | regions solved ahead of the camera, then the field bake |
| Trade-off | more storage, faster first detail | less storage, slower first detail |

`waterPrecompute=1` is the seed of precompute mode. Do not add a second switch for the same thing.

**Why today's data cannot scale.** Arithmetic at the same density on a 1000 km planet, for scale only:

| Today, demo planet | At 1000 km |
|---|---|
| Graph arrays, about 37 B a cell over 1.57M cells: about 58 MB in the worker (my sum from `waterGraph.js`, check it) | about 3.4 GB |
| Lake mask atlas, 46 MB (10-11) | about 2.7 GB |
| River traces, about 9 KB each, about 5,000 rivers: about 45 MB | about 2.6 GB |

**One candidate, to test rather than assume.** Keep planet-wide only what is coarse and bounded: a fixed-size grid gives basins and rough discharge (at `gridN` 512 its cells would be about 3 km on a 1000 km planet). Everything per km² lives in regions that can be solved, stored and evicted. River width rarely depends on discharge now, since nearly every river sits on the width floor, so coarse discharge should do. Routing is already local (16 m patches), and streams walk at most 8 km.

Regional **computation** is fine. Regional **placement** is what the owner rejected: lakes must stay the real terrain's level sets at the spill level, solved at 32 m. Do not bring back invented lakes or coarse footprints near the camera.

**Blockers to clear first.** The modes cannot agree until these are fixed:
1. **Lake merges depend on order.** `WaterService.js` says adoption in dispatch order makes merges come out as "a one-worker precompute along the same camera path would make them". So today's result depends on the order lakes are solved, and on-demand order is different. Make it order-independent, and test it: the same area solved in two orders gives the same lakes.
2. **Mountain lake selection is planet-wide.** `mountainLakes.js` picks larger pockets first with `minSpacingM` between them, across all candidates. It needs a rule that gives the same answer from any region. Keep the demo planet's lakes as close as possible, and show the owner what changes.
3. **The planet-wide drainage flood.** Keep it at a fixed coarse size, and move fine discovery to regions.
4. **Large lakes cross regions** (331 km² near the spawn). Decide which region owns a lake, and how its neighbours wait for it.

## 6. Work order

Investigate architecture alongside low-risk wins; the owner explicitly wants significant progress before reporting, not a stop after each step. Measure candidates against the same inputs. Treat the sequence below as a guide, not a restriction on foundational work.

**Foundation investigation:** map the current cost and dependencies end to end, then compare bounded regional generation and reuse, progressive/coarse-to-fine representations, and GPU/CPU division against the present full-field bake. Account for deterministic hydrology across region boundaries, long lakes and river networks, lake/river handover, precision, memory, caching, cancellation, and terrain tile updates. Prototype risky alternatives before replacing the path; preserve the visual reference at full detail. Do not assume region ownership or fixed coarse graph alone solves global drainage.

Candidate comparisons, not decisions:
- Reuse unchanged connected groups of pages and solve only affected groups. This retains the existing output but needs exact overlap/halo and flood connectivity, bounded eviction, cancellation and stable publication.
- Progressive coarse representations with near-field refinement and speed-aware priority. This addresses latency and high-speed coverage, but needs consistent lake mouths, no visible tile/LOD cracks, and an explicit transition from coarse to final water.
- GPU-resident sampling and field construction or a different direct water representation. This may remove readback, CPU rasterization and uploads, but can compete with terrain/rendering on low-end GPUs; compare total frame/load time and memory, not just kernel time.
- Terrain-native water features (owner suggestion): evaluate a terrain height function or hybrid terrain/hydrology representation that produces basin and riverbed shapes as part of terrain compute. This could avoid a separate full river field and post-publication tile regeneration. A local noise function by itself does not establish drainage connectivity, downhill levels or lake spillways; any candidate must also handle consistent water levels, intersections, tile and LOD boundaries, and the approved visual reference. Compare against terrain-sampled water and measure the added cost per generated tile; prototype before changing the production foundation.
- Local on-demand hydrology backed by a bounded global summary. This helps large planets only if routing, mountain selection, merges and long lakes remain deterministic across region boundaries and in both modes.

For each prototype record visual differences, startup and teleport coverage, steady travel backlog at multiple speeds, tile churn, worker/GPU/main-thread time, peak/resident memory and cold/warm caches. Preserve the baseline and stop using a candidate if it fails those requirements.


### Step 0: thin baseline (small, do not build a framework)
- Timestamps from navigation to first frame to reveal, split by stage.
- The same with water off: this is the floor. If terrain alone misses a budget, no water work can meet it. I know of no URL switch for this; check the `waterGraph` config.
- Tiles regenerated per bake, and the same for a teleport.
- How many pages end completely empty (no ground change, no water, no lake).
- Scale audit: every planet-wide water structure, its bytes today, and how it grows with radius.
- Fix `terrain-lab/water-latency-run.mjs` if you use it: it counts failed features as done.

Exit: record the baseline and device/configuration in `RIVERS_AND_LAKES.md`; use it to refine configurable targets.

### Step 1: stop wasting work in the bake
In this order. Gains are estimates until measured.

1. **Lake pass.** Loading now uses 8 ms slices (3 ms in play); a same-page test saved 101 ms of lake-pass elapsed time with identical output. Measure the effect on total load and concurrent terrain. Investigate moving it off the main thread if a mask snapshot is cheap.
2. **Drop empty pages** after the bake, so they are never uploaded and never regenerate tiles. A page with lake water is not empty: lake sheets give way wherever a page exists (`riverFieldHas`), so `fieldLakeEdges` must keep `dryLake` at 0.
3. **Skip empty pages in blur, wet, sdf and pack.** Blur and SDF now skip provably empty neighbourhoods; wet and pack remain. Those four take 3.5 s of the 5.7 s. Sampling will not shrink much: bank probes need ground out to 96 m beyond the water (`bankProbeM`), so pages must exist while stations are computed.
4. **Exact regeneration.** Test tiles against the pages that really changed, not grid cells plus a margin. Tiles read ground change, level and signed distance, not flow. This serves the owner's "no regeneration" rule directly.
5. **Split the worker stages** across 2-4 workers by page groups. Blur and sdf need neighbours; the wet flood stays whole. There is no `SharedArrayBuffer` here (no COOP/COEP headers), so use transfers. Report total CPU as well as wall time.
6. **Lake pool while loading:** A/B 2 jobs against the full pool, watching tile load time.
7. **Publish** in pieces, under the 4 ms rule.

Exit: bake time, bytes and tiles regenerated, before and after, with every gate in section 8 green.

### Step 2: near water first
- Bake pages nearest the camera first and publish them first. The 2 km ring is about a ninth of the 6 km area, so roughly 1 s before step 1's savings, and hundreds of milliseconds after them may be possible. Stations need a river's whole length; they are cheap (142 ms in all).
- Reveal once the initial terrain is ready; water must stream in nearby first rather than holding the loading screen for the full near ring. Count failures as missing.
- The outer rings must not regenerate near tiles or pop in view.
- Decide with the owner whether the near solver joins the gate. It fills about 1 s after reveal today.

Exit: time to complete near water, and to reveal, against water off.

### Step 3: stop rebaking everything
- Investigate rebaking only dependent groups. A real-scene comparison of 12 candidate groups matched all 8,003 full-bake pages and flow, but this is not proof that arbitrary groups are independent: account for plume/wake reach across gaps, lake inputs, ordering, halos, and group merges/splits before enabling caching. Keep unchanged pages and slots only once invalidation is proven.
- Cancel stale work on fast moves, and scale the bake radius with speed.
- Cache field pages only if storage is justified: 143 MB is too much as it stands, so compress or cache only near pages. Measure against the bake's new cost first.

Exit: bake work per km travelled, and the highest speed water holds.

### Step 4: bounded data and the two modes
1. Clear the blockers in section 5, with order-independence tests.
2. Design the region unit from the step 0 audit. Prototype on a small area of the demo planet, comparing against today's results.
3. Bring up on-demand mode, then precompute mode on the same code.
4. Add a size check: a 1000 km planet config, or sizing arithmetic if terrain cannot run one yet.

Exit: same final detailed water in both modes on the demo planet, within a measured tolerance; bounded fine-data memory at 1000 km; report visual comparisons and remaining trade-offs.

### Rendering track (independent, any time after step 0)
- First measure water's share of the frame: on against off, same page, at the owner's poses. `o-star` read about 18 ms against 15 ms with whitewater off, across page loads, so most of the frame may not be water at all. Agree a target with the owner.
- Then try, one at a time:
  1. A noise texture instead of hashes in `whiteSurface`: up to about 12 noise evaluations per near pixel, on all near water since `ced2946`.
  2. Skip `applyWater` on tiles with no water (`terrainChunkFragmentShaderBuilder.js`, about line 4810): every terrain pixel past 1 km pays a page lookup and a lake lookup today. No false negatives at tile edges.
  3. Fewer solver blocks and lower detail by projected size, without slowing simulated time.
- Same-page A/B only (`tools/perf/lakeLook/costAB.js`).

## 7. Tools

| Tool | Use |
|---|---|
| `tools/perf/riverBanks/armReview.mjs CONFIG.json` | captures and probes at poses. Config: `{ root, out, fixedQuality: true, views, modes: ["w7"], arms: [{ name, probes, viewProbes }] }`; a probe is `{ m, e, a }` |
| `tools/perf/riverBanks/fieldProbe.js` | `fieldSummary`, `fieldLakeEdges`, `fieldLine` |
| `tools/perf/riverBanks/widthProbe.js` | `bakedWidths` (with pinch census), `widthProbe` |
| `tools/perf/lakeLook/drawnWidths.mjs` | widths in drawn pixels, straight down |
| `tools/perf/lakeLook/bankCuts.js`, `neckProbe.js` | bank heights at the water's edge; ground and level along a river at a screen point |
| `tools/perf/whitewater/surge.mjs`, `surgeMap.mjs` | arrival behaviour and the distance-time map. Config: `{ root, out, views, arms: [{ name: "as-is", config: {} }], stepMs: 33.33, times: [0.5, 1, 2, 4, 6, 8, 10, 12, 14], shownAfterS: 3, rows: true, along: { river, stepM: 8, rangeM: 190 } }` |
| `tools/perf/whitewater/flicker.mjs` | `{ root, out, views: [one view], stepsMs: [33.33], frames: 60, minTop: 0 }`, one view per run |
| `tools/perf/lakeLook/costAB.js` | frame cost, states taken in turn in one page |

Owner's poses: `tools/perf/lakeLook/ownerViews-2026-11-05b.json`, `-c.json`, `-d.json`, `-e.json`. Water debug views: 7 who draws, 10 dry, 11 speed, 12 foam, 15 tier.

## 8. Gates after every change

- Unit tests: `npx vitest run core/world/water core/world/hydrology core/renderer/water core/world/shaders/webgpu/terrainCompute.wgsl.test.js`. In the full suite, 3 failures in `wizard_game/WorldConfigLoader.test.js` predate this work.
- For visual or rendering changes, capture and inspect the owner’s poses against the prior result when a GPU run is available. Numbers do not replace looking; explicitly report if a GPU comparison was not performed.
- Anything touching width, depth, levels or flow: surge map at `o-upstream-black` (river 2557) and `u-start` (river 454). Today's sag below outlets is 10-15 cm, and a dip of about 16 cm runs up from river ends for 6 s on arrival. Neither may grow.
- Anything touching the bake: `bakedWidths` (typical river 36 m at the owner's poses, pinches 3), `bankCuts` (worst wall 9 m), `fieldLakeEdges` (`dryLake` 0).
- Any shader change: flicker, and the tiers must still agree: no lines at solver block or page edges.

## 9. Working rules and traps

- **Ask the owner before every headless browser run**, with a realistic count: it shares their GPU. Compute-only Node runs (`../terrain-lab`) need no asking.
- **Commit or push only when the owner asks.** They edit the tree concurrently: review the diff and stage your own hunks by path. Leave alone `anthill/`, `dev_harness/`, `docs/renderer-modules.md`, the interiors and voxel plans, `vookseli.md`, and the deleted tile-analysis screenshots. Never add `tools/perf/structured-terrain-results/` (9 GB).
- Removed features lose their code and switches. The two modes are a real feature; temporary comparison switches are not.
- Bump `RIVER_SOLVE_VERSION` on any change to traces, levels or bank bake, or caches return stale rivers.
- Say how sure you are before building on a theory, and prove the cause with a measurement before fixing it. Never chain a second guess onto a first.
- **Frame cost across page loads is not comparable** (2 ms and more for the same code): compare in one page.
- **Page counts and memory depend on the last pose:** compare at the same poses in the same order, or they mislead.
- Baked widths are not drawn widths, and they weight short rivers. Say which one a number is.
- **Look from above before explaining a shape.** Low oblique views turned slivers into floods three times, and each explanation was wrong.
- `wwSurge`'s `rise` can come from thin sheets over dry banks, and its still-water figures read null near outlets now: use `wwRiseCells` and the map.
- A disagreement at a boundary can have its cause on the other side. The outlet sag was four failed attempts on the river's side; the lake was giving no water.
- Harness: use system Chrome (`/Applications/Google Chrome.app`), not Puppeteer's. Machine details: no `timeout` command, zsh does not split `$VAR` in `for`, git here has no `branch --show-current`, Python has no PIL (crop with `sips`).

## 10. Reporting

When reporting, give the owner: what changed; before and after numbers for comparable workloads; what it costs; what could not be verified; and which poses to look at where relevant. Say plainly if a budget cannot be met, and why. Update `RIVERS_AND_LAKES.md` as you go.
