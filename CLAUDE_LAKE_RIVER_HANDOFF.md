# Lakes and rivers: decision, evidence and next step (Claude, 2026-10-11)

Read after [CLAUDE_LAKE_RIVER_REASSESSMENT.md](CLAUDE_LAKE_RIVER_REASSESSMENT.md). This records what this session measured, what it changed (uncommitted, opt-in), and what comes next. Raw evidence: [tools/perf/structured-terrain-results/lake-recovery-2026-10-11/](tools/perf/structured-terrain-results/lake-recovery-2026-10-11/README.md).

## 1. Decision

**Keep the original terrain-derived lakes. Solve every lake at 32 m right after the water graph, and draw a lake only once it is solved.** The regional placement is not repaired or reused for lakes.

The owner's reference shape is not produced by a flood algorithm or a constructed basin. It is the **real terrain's level set at the basin's spill level**, clipped to the basin. The terrain shader draws water wherever the rendered height is below the lake level inside the lake's footprint (`waterWgsl.js waterLakeHitIn`); no terrain is changed. Any approach that keeps the terrain unchanged under the lake, picks the level the terrain actually holds and restricts it to the connected basin reproduces the bays, peninsulas and islands. The regional path cannot: inside an accepted support it returns the spline height instead of the terrain (`earthLikeBase.wgsl.js calculateTerrainHeightBaseD`), so its level set is the spline's.

What was wrong with the original was not shape but **timing and an intermediate representation**:

- Until a lake's 16 m solve landed, it was drawn from its 512-cell graph footprint at the coarse level: square cut-outs, straight cell edges, fake water in merged pockets. Refinement then changed 12.6 % of the visible water pixels at one matched pose (IoU 0.874, run 3), and moved the level by more than 5 m for 29 % of lakes (lab 2).
- Lakes were refined one at a time, nearest first, within 40 km, behind the same single busy flag as rivers. In 3 minutes the original path refined 22 of 614 lakes (run 3); everywhere else stayed coarse and would pop when visited.
- The service started only after the loader, sampled the grid one dispatch per frame, and eagerly compiled a second full terrain pipeline (the carved sampler, ~21 s cold in run 1) that only the river simulation uses.

## 2. What changed (opt-in, uncommitted)

URL: `standalone.html?regionalTerrain=0&regionalBanks=legacy&riverSim=off&waterPrecompute=1` (the owner's reference URL plus `waterPrecompute=1`). Without it the reference path behaves as before, apart from the lazy carved compile when the simulation is off. Normal game defaults are unchanged (the regional path); switching them is the owner's call.

| File | Change |
| --- | --- |
| `core/world/hydrology/WaterService.js` | `refine.precompute`: starts with the terrain; after the graph, every lake is solved nearest to the camera first by a pool of workers (one solve at a time while the initial terrain loads), adopted by the graph worker in dispatch order, cached in IndexedDB (`lake:<key>:32:6:crop:<id>`), routes computed once at the end. Larger, time-sliced sampling dispatches. `_resolveLakeIncluding` uses the solved patch frame. |
| `core/world/hydrology/waterWorkerCore.js` | `solveLake` options `crop` (mask and frame cropped to the water plus band; `patchFrame` kept) and `skipDownstream`; new messages `downstream`, `adoptLake`, and the stateless `solvePatchLake` (pool workers). |
| `core/world/hydrology/HydrologyGrid.js` | `eagerCarved` option: the carved sampler compiles on first carved use (or `warmCarved()`), not when river data arrives. |
| `core/world/water/WaterGpuData.js` | `maskAtlas` option: resident masks for every lake in 2048² layers with 512²/256²/128² tiles (the shader's existing per-lake tile code), and `lakeMaskAtlasPlan()` sizing from the graph. River segments of traced (original) rivers now carry the distant-coverage flag too (1 traced, 2 structured), affecting every mode with traced rivers. |
| `core/world/water/waterWgsl.js` | `WaterRiverHit.opaqueBody`; beyond the near/far switch (1.6 km) traced rivers draw water from their channel profile (as structured rivers already did) and blend from their near colour model into the opaque body by 4 km. Fixes rivers that read as a brown strip with cyan spots from the air. |
| `wizard_game/gameEngine.js` | Precompute mode: service starts at startup; GPU water data created once the graph exists (atlas sized from it); unsolved lakes never drawn (`unsolvedLakeHideM` 1e12). |
| `wizard_game/standalone.html` | `waterPrecompute=1` switch (refine.precompute, spacingM 32). |
| `core/world/hydrology/waterPrecompute.test.js` | Crop/route equivalence, pool-vs-`solveLake` equivalence (record, mask, merges, routes), atlas sizing and shader tile encoding. |
| `tools/perf/lakeRecovery/` | Owned server, browser harness (crash/memory diagnostics), offline graph analysis, lab resolution and river-cost scripts, rendered-water diff. |

All 100 water/hydrology unit tests pass (three consecutive runs).

## 3. Evidence (M1 Pro, owned processes, GPU jobs sequential)

Provenance and exclusions are in the evidence README. Metal keeps a system-wide shader cache across Chrome profiles, so "cold" below means cold IndexedDB and Chrome profile, not cold driver caches (run 1 compiled the base sampler in 4.3 s, later runs in ~0.1 s).

**Reference recovered.** The owner's 4 km screenshot (free camera, ship at the spawn −X face centre) matches the giant lakes near the spawn: lake 166 (224 km² fine, level 500.5 m) and lake 175 (331 km², 537 m) are the candidates; lake 159 (92 km², 571 m) has the same dendritic character. Poses are in `run1-original-cold/report.json` (`poses`) and the extra-lake poses in later reports. The exact screenshot camera is not recoverable from the HUD.

**Original population (exact offline reproduction of the browser graph: 614 lakes, 106 rivers, 0 mismatches).** Fine (16 m) wet area 12,841 km²; median 7.9 km², p90 35 km², max 418 km²; 44 lakes > 50 km², 22 > 100 km², 4 < 1 km². Medium lakes have shoreline development 5.6–7.7 and 36–69 islands; the largest 2.7–3.0. The regional v17 median was 0.0156 km².

**Resolution (lab 2, all 614 lakes, identical terrain: lab grid equals the browser grid bit for bit).**

| vs production 16 m | level p5..p95 | lakes with level change > 1 m | visible-water IoU (area-weighted) | flood CPU, all lakes | GPU sampling |
| --- | --- | --- | --- | --- | --- |
| 32 m | −0.23..+0.14 m | 2 | 0.994 | 29.4 s | 5.3 s |
| 64 m | −1.05..+0.51 m | 43 | 0.981 | 7.2 s | 2.2 s |
| 16 m itself | — | — | — | 97.5 s | 14.0 s |
| coarse graph footprint at graph level (unrefined look) | −9.6..+15.1 m vs fine | 180 (> 5 m) | 0.848 (1,175 km² fake, 1,573 km² missing water) | — | — |

The twelve 32 m lakes below IoU 0.98 are multi-pocket coarse lakes where the 16 m and 32 m seeds fall in different pockets (lake 460: IoU 0), not resolution errors.

**Rendered agreement, matched poses (runs 3 vs 4/5, weather held clear).** Precompute vs the original's refined state: rendered water IoU 0.994 (lake 166 close), 0.999 (lake 175), 0.998 (top over lake 159), 0.990 (broad, many lakes). The original's own coarse→refined change at its close pose: 0.874.

**Timeline, cold.**

| Run | Graph ready | Loader | Lake 159 drawn final | All lakes final | Notes |
| --- | --- | --- | --- | --- | --- |
| 1 original (eager carved compile) | 69.4 s | 27.4 s, timeout | 80.8 s | never (20 refined in 4 min) | grid 31 s, carved compile 21 s |
| 3 original | 17.7 s | 14.5 s | 28.6 s (coarse before) | never (22 in 3 min) | lazy carved compile |
| 4 precompute, sequential | 11.1 s | 15.1 s | 23.5 s | 66.4 s | 55 s precompute |
| 5, 8, 9 precompute, 6-worker pool | 11–12 s | 18.0–18.6 s | ~28 s | ~33 s | 20.5–21.0 s precompute; loader delayed ~3.5 s |
| **11, 12 load-aware pool (final)** | 11.1 s | 15.8 s | ~25 s | **32.1–32.3 s** | one solve at a time while loading, then 6 |
| 6, 7 precompute, warm cache | 8.7–8.8 s | 14.8–15.2 s | | 11.4 s (restore 2.6 s) | |

Frames in the same 11–32 s window, excluding the harness's screenshot stalls: original p95 21.5 / p99 27.3 ms (it does its own water work then), 6-worker pool 30.0 / 35.4 ms, load-aware pool 22–24 / 28 ms. Warm restore windows: max 22–27 ms. The 2.0–2.5 s frames at 4–8 s occur in every run before any water work. Settle times at matched poses are within noise.

**Memory.** Mask atlas 46 MB for all lakes (781 slots, 605 used: the plan over-provisions 256² and 512² slots; 32 MB is reachable with tighter slack). Previous original path: up to 96 × 512² = 24 MB for the nearest lakes only. Renderer RSS peaks 1.44–1.57 GB with the precompute vs 1.32 GB original; the browser process tree 2.95–3.29 GB vs 2.97 GB. IndexedDB (whole origin, all water records incl. the 12.6 MB grid): 25.9 MB (run 17).

## 4. Critique summary

Rejected after measurement:
- *Terrain-based discovery is too expensive.* The whole 6 × 512² grid samples in 0.33 s of GPU in the lab; the 31 s browser figure was one dispatch per frame plus contention with a 21 s pipeline compile. The flood build is ~1 s.
- *Flood fill is not the bottleneck.* Half right: for discovery it is negligible; for solving every lake at 16 m the CPU flood (97.5 s) dominates GPU sampling (14 s). Coarser solves (32 m) and a worker pool, not GPU work, were the levers.
- *Lakes need early regional publication before tiles.* Lakes have no tile dependency (only the river carve and valley pages enter terrain generation). Publication order matters for rivers.
- *Noise, stamped depressions or one lake per region can recover the shape.* The shape is the terrain's level set; constructing the depression replaces exactly the structure that makes it.
- *Repairing the original unmodified fixes the timing.* It does not: without precompute, lakes stay coarse until visited and then pop; precompute is the fix.

Kept: river data must exist before the tiles that depend on it; a common lake/outlet record (`refined` records are already that); deterministic caching keyed by the terrain source.

## 5. Limitations and risks

- **Unexplained page detach.** One of five pooled cold runs (run 8) lost its page frame ~30 s in, during the precompute, with no page error (crash listener not yet installed). Runs 5, 9, 11 and 12 did not reproduce it (11 and 12 with crash listeners and memory sampling). Treat as an open risk until more runs are clean; the pool's transient memory (+0.1–0.25 GB renderer peak) is the first suspect.
- **Multi-pocket coarse lakes** keep one pocket (the one the lowest seed lands in), as the original did. The other pockets' water, at their own lower levels, is dropped. A single flood already gives every pocket's spill level; extracting all pockets is the next lake step and also a natural source of small lakes (the coarse 2.5 km² core threshold excludes them today).
- **Merge outcomes depend on the camera path** (nearest-first order), as in the original. Which graph lake becomes the representative decides which rivers survive (`planRiver` drops rivers of merged sources).
- **Small mountain lakes are still missing (owner requirement, restated 2026-10-11).** The owner wants smaller mountain lakes in addition to the big ones, so rivers between them get a good hill gradient to run down (good for the shallow-water simulation). The coarse graph cannot see them: a lake needs a deep core of 18 cells deeper than 8 m (~2.5 km²) on the ~400 m grid. Next experiment: a pocket census in high-relief areas only (relief from the 512 grid), sampled at 32–64 m, priority-flooded, closed depressions histogrammed by depth, area and altitude. Cheap: mountain land is a fraction of 141,564 km² of land, ~4–30 M cells. If natural pockets exist, add them as lakes with the same records (a separate discovery strategy, shared lake/outlet records) and give high-gradient lake-to-lake streams a lower river discharge threshold. If they are too rare, shape cirques and sills as part of the mountain system (parent landform), not decorative enclosing hills (rejected before).
- **Mask tiles pool big lakes** (a 40 km lake in 512² has ~78 m texels). The per-pixel shoreline still comes from terrain; only clip edges (outlets, neighbouring pockets) can show texels. The previous 16 m path pooled big lakes to ~70 m too.
- **Not measured:** low-end machines, IndexedDB size, multiple seeds/planet sizes, fast-flight first coverage (< 50 ms target; untouched by this work).

## 6. Rivers

**Far view fixed (owner, 2026-10-11: "rivers become mostly brown with few cyan spots when viewed a bit further from the air").** Cause: traced rivers drew water only where the rendered mesh is below the river level; coarse LOD vertices miss a 30–60 m channel, so the bank tint showed along the river with water only where the mesh dipped. Every listed segment's wet core is cut to the channel profile by the carve (`riverCarveSegment_d`, full weight within 0.85 half-width), so distant water can come from that profile, as the regional path already did. Runs 13–17 (rivers 37 and 6 at 1, 3 and 8 km, both bank modes, old/new rendering on identical frames): continuous water from lake to lake/sea; river 6 at 8 km doubles the visible water; no colour step at 1.6 km (run 17). No GPU or page errors.

**Brown "rope".** It is `regionalBanks=legacy` (`bankDetail 0`): a fixed 80 % soil tint over the channel plus 16 m each side. With the fix the water covers the channel core, but the tinted edges remain and tint the water's ground near the switch. The game's default `bankDetail 1` (organic; omit `regionalBanks` or use `regionalBanks=organic`) has no flat tint: scalloped shores, shelf/steep bank variation and splat materials. Recommended for the owner's comparison URL.

**Bank variation (owner: steeper ledges in places, varying land rise).** Not changed. Controls today: organic bank profile in `riverCarve.wgsl.js` (`shelf`, `soft`, `rise = 1.5 + 2.5 x morph + D/2` m, so banks rise 1.5–4 m plus half the depth) and the bank-retreat bake in `riverLandscape.js` (`bankSlope` 0.28 to `canyonSlope` 0.75 by erodibility). Widening the rise range and the steep/shelf contrast is a small, geometry-only change, but it changes terrain under every river and needs the owner's eye.

### Measured, not yet changed

In precompute mode rivers still trace lazily (nearest first, after the lakes) and still regenerate tiles when published (runs 3–5: 11–21 regeneration events, 149–254 tiles in a few minutes). Lab 3 traced all 106 graph rivers after the 32 m lakes: 105 ok, 1 merged; **48.6 s single-thread worker time**, of which the bank-incision bake is only 1.8 s and valley pages 1.8 s; corridor sampling 2.7 s GPU. The bulk is per-cell loops in `solveRiver` (lake-mask lookups with `planeToDir`/`dirToCell` per cell) over each corridor's whole bounding rectangle (86.8 M cells), not the corridor.

**Next experiment (smallest discriminating step):** restrict `solveRiver`'s per-cell loops to corridor cells and parallelise rivers like lakes (a trunk before its tributaries), then measure whether all rivers can be published before the tiles that need them: (a) at world creation behind the loading screen, warm and cold; (b) count regenerated tiles and first-visible river latency on a short flight. If all rivers fit within the loading screen cold, the dry-first/regenerate workflow disappears without a tile-queue change; if not, the specific dependency change is to hold back tiles that intersect unpublished river corridors (known from the graph at ~11 s). River look (moats, rope banks) comes after placement and publication are right.
