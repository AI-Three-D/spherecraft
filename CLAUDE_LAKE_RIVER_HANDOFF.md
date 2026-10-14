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
- **Small mountain lakes (owner requirement, restated 2026-10-11): built 2026-10-12, see section 7.** Original notes: The owner wants smaller mountain lakes in addition to the big ones, so rivers between them get a good hill gradient to run down (good for the shallow-water simulation). The coarse graph cannot see them: a lake needs a deep core of 18 cells deeper than 8 m (~2.5 km²) on the ~400 m grid. Next experiment: a pocket census in high-relief areas only (relief from the 512 grid), sampled at 32–64 m, priority-flooded, closed depressions histogrammed by depth, area and altitude. Cheap: mountain land is a fraction of 141,564 km² of land, ~4–30 M cells. If natural pockets exist, add them as lakes with the same records (a separate discovery strategy, shared lake/outlet records) and give high-gradient lake-to-lake streams a lower river discharge threshold. If they are too rare, shape cirques and sills as part of the mountain system (parent landform), not decorative enclosing hills (rejected before).
  **Census done (lab 4–6, `tools/perf/lakeRecovery/labMountainPockets.mjs`, `labMountainPocketView.mjs`):** natural pockets are plentiful, so the work is selection, not terrain shaping. Over 19,000 km² of land with more than 300 m local relief, sampled at 32 m (204 M samples; 10.3 s GPU, 46 s single-thread flood in the lab): 42,197 closed depressions at least 3 m deep and 2 ha outside the graph lakes (2.2 per km²). Median 8 ha, p90 0.53 km², 9,080 over 0.25 km²; depth median 11.5 m, p90 48 m; 5,249 above 1,000 m. 99 % have a lower pocket or lake within 8 km: median 930 m away, 14 m lower (gradient 1.6 %, p90 6.9 %). Views: high plateaus next to ranges are riddled with 0.1–1 km² pockets (an upland lake district if all were filled); inside steep eroded ranges, drainage leaves only tiny, deep pockets. Next: select by size, spacing and setting (plateau edges and valley heads above the big lakes), solve the chosen ones at 32 m like other lakes, and route high-gradient streams from them down the range's valleys to the big lakes. Check the look in the renderer before scaling (deep narrow pits may read as holes). Some census pockets lie at or below sea level (coastal blocks) and must be excluded.
- **Mask tiles pool big lakes** (a 40 km lake in 512² has ~78 m texels). The per-pixel shoreline still comes from terrain; only clip edges (outlets, neighbouring pockets) can show texels. The previous 16 m path pooled big lakes to ~70 m too.
- **Not measured:** low-end machines, IndexedDB size, multiple seeds/planet sizes, fast-flight first coverage (< 50 ms target; untouched by this work).

## 6. Rivers

**Far view fixed (owner, 2026-10-11: "rivers become mostly brown with few cyan spots when viewed a bit further from the air").** Cause: traced rivers drew water only where the rendered mesh is below the river level; coarse LOD vertices miss a 30–60 m channel, so the bank tint showed along the river with water only where the mesh dipped. Every listed segment's wet core is cut to the channel profile by the carve (`riverCarveSegment_d`, full weight within 0.85 half-width), so distant water can come from that profile, as the regional path already did. Runs 13–17 (rivers 37 and 6 at 1, 3 and 8 km, both bank modes, old/new rendering on identical frames): continuous water from lake to lake/sea; river 6 at 8 km doubles the visible water; no colour step at 1.6 km (run 17). No GPU or page errors.

**Brown "rope".** It is `regionalBanks=legacy` (`bankDetail 0`): a fixed 80 % soil tint over the channel plus 16 m each side. With the fix the water covers the channel core, but the tinted edges remain and tint the water's ground near the switch. The game's default `bankDetail 1` (organic; omit `regionalBanks` or use `regionalBanks=organic`) has no flat tint: scalloped shores, shelf/steep bank variation and splat materials. Recommended for the owner's comparison URL.

**Bank variation (owner: steeper ledges in places, varying land rise).** Not changed. Controls today: organic bank profile in `riverCarve.wgsl.js` (`shelf`, `soft`, `rise = 1.5 + 2.5 x morph + D/2` m, so banks rise 1.5–4 m plus half the depth) and the bank-retreat bake in `riverLandscape.js` (`bankSlope` 0.28 to `canyonSlope` 0.75 by erodibility). Widening the rise range and the steep/shelf contrast is a small, geometry-only change, but it changes terrain under every river and needs the owner's eye.

### Measured, not yet changed

In precompute mode rivers still trace lazily (nearest first, after the lakes) and still regenerate tiles when published (runs 3–5: 11–21 regeneration events, 149–254 tiles in a few minutes). Lab 3 traced all 106 graph rivers after the 32 m lakes: 105 ok, 1 merged; **48.6 s single-thread worker time**, of which the bank-incision bake is only 1.8 s and valley pages 1.8 s; corridor sampling 2.7 s GPU. The bulk is per-cell loops in `solveRiver` (lake-mask lookups with `planeToDir`/`dirToCell` per cell) over each corridor's whole bounding rectangle (86.8 M cells), not the corridor.

**Next experiment (smallest discriminating step):** restrict `solveRiver`'s per-cell loops to corridor cells and parallelise rivers like lakes (a trunk before its tributaries), then measure whether all rivers can be published before the tiles that need them: (a) at world creation behind the loading screen, warm and cold; (b) count regenerated tiles and first-visible river latency on a short flight. If all rivers fit within the loading screen cold, the dry-first/regenerate workflow disappears without a tile-queue change; if not, the specific dependency change is to hold back tiles that intersect unpublished river corridors (known from the graph at ~11 s). River look (moats, rope banks) comes after placement and publication are right.

## 7. Small mountain lakes and their streams (2026-10-12, uncommitted)

The owner wants small mountain lakes besides the big ones, so rivers between them run down good hill gradients (good for the shallow-water simulation). On with `waterPrecompute=1` (`mountainLakes=0` turns them off for comparison). Code: `core/world/hydrology/mountainLakes.js` (pure JS, deterministic), `WaterService._mountainLakes`, worker messages `findPockets`, `continueDrain`, `addLakes`.

**Pipeline (inside the precompute, after the graph lakes):**

1. **Discovery.** Mountain cells: land with more than 300 m relief over 5 × 5 grid cells (~2 km). Blocks of 8 × 8 grid cells (~3.2 km) holding one: 4,747. Each block plus 1 km is sampled at 64 m and priority-flooded from its border; a pocket is a connected set of cells holding water (fill − ground > 0.5 m) at its spill level. Lab 7: 97 % of the 32 m pockets over 5 ha found, levels within 0.1 m. Pockets inside graph lakes or on graph river cells are left out.
2. **Choice.** At least 3 m deep and 3 ha, above sea level + 5 m, in a mountain setting (median rise of the ground 64–400 m beyond the shore ≥ 20 m) with a steep outflow (the drainage drops ≥ 20 m within 1.5 km of the sill), larger first, shores at least 800 m apart (lab 8). 10,297 candidates → **2,225 lakes, 951 km²**, solved at 32 m like every other lake (same records, masks and atlas).
3. **Streams.** Each lake's drainage is the steepest descent on the filled 64 m surface from the sill (flood parents only across filled hollows; flood parents alone drift sideways on plain slopes). Its stream ends at the first point in the sea, in lower lake water (any solved lake's mask) or on a graph river's cell, within 8 km. A drainage that leaves its discovery patch dry continues on 4 km patches ahead of its end (up to 4 times). The stream's 16 m trace stays within 300 m of that path (narrow shape: 8 m minimum width, 0.8 m depth). Lakes and trimmed drainages are cached as one IndexedDB record (`mlakes:<key>:<hash>`, `MOUNTAIN_LAKE_VERSION`).

**Result (runs 21–24):** 1,386 streams (62 % of the lakes): 1,229 into lower lakes, 39 into rivers, 118 to the sea; length p50 1.7 km, p90 4.9 km. No stream: 539 lakes drain more than 8 km before reaching water, 300 are still dry after four continuations. The routes follow valleys and meander (`run22-…/river-112-1500-surface-body.png`); the coarse graph's routes (run 20) were straight and right-angled over hills.

**Streams visible from the air.** An 8 m stream's cut is finer than the terrain triangles from ~0.5 km: the triangles sit above the water level and hide the near ribbon, so the stream read as a dry trench with a one-pixel water line (run 22, tint views). Narrow reaches (half-width under 10 m, `NARROW_RIVER_HW_M`) now take their water from the channel profile wherever the triangles miss the cut, at any distance, and draw an opaque water body there (`waterWgsl.js waterRiverAtView`). Wider rivers keep the terrain authoritative near the camera, as before. Streams are listed in the river segment buffer only within 12 km of the camera (`NARROW_RIVER_DRAW_M`): with ~1,400 streams solved, the full buffer dropped up to 24 distant big rivers (run 23). Crossing that radius does not regenerate tiles.

**Costs.** Cold (once per terrain): discovery 33 s while the loader runs (sampling-bound: ~7 ms per small patch), drains 13.8 s, mountain phase 58 s; the precompute finishes ~70 s after page load (run 22) instead of ~32 s. Warm: the cached record restores lakes and streams in 0.23–0.26 s; the whole precompute takes 3.2–3.4 s (runs 25–26, 3.1 s without mountain lakes). Mask atlas 54.5 MB with the reserve for mountain lakes (46 MB before). Streams are traced lazily near the camera like other rivers and regenerate tiles when published. On a warm start that now happens during loading: 820–860 tiles (77–83 events) before the loader completes, which takes 17.8–18.2 s instead of 14.9–16.2 s (runs 25–26 vs 19–22). This breaks the owner's "water must not add regeneration" bar until rivers are published before their tiles. Optimization items 3 and 8 cover these (`WATER_OPTIMIZATION_PLAN.md`).

**Open, for the owner's eye:**
- 38 % of the mountain lakes have no outflow stream, including the four largest near the spawn (they drain more than 8 km before reaching water). A longer limit (e.g. 15 km) gives more streams at more continuation and regeneration cost.
- Stream banks use the rivers' organic bank profile, whose rise (1.5–4 m) does not scale with the channel: next to an 8 m stream it reads as a ditch from 600 m. Scaling the bank rise with the width is a geometry change under every stream.
- Close up (resolved triangles) a stream shows the near ribbon over its real bed; farther out, the opaque body. No step showed in the 600 m and 1.5 km views (run 24); ground level not checked.
- After a change to the water shader code, the first load stalled 12.5 s on a cold shader compile (runs 23–24; none in runs 25–26 with the compile cached). Every first launch on a machine pays it: optimization item 15.
- The water cache never deletes records of old keys; IndexedDB grew to 35 MB in the scratch profile across key changes.


## 8. Owner's look review, 2026-10-12 (uncommitted)

Owner screenshots with poses (HUD CAMERA card, added: `wizard_game/ui/GameUI.js`) were reproduced exactly with `tools/perf/lakeRecovery/waterViews.mjs` (owned server, warm profile, per-view water tints, terrain debug modes, variants such as `nearMesh(false)`, and probes of the lakes on the view ray and the rivers near the camera). Evidence: `tools/perf/structured-terrain-results/water-look-2026-10-12/` (v1–v14).

| Issue (owner) | Cause (proven how) | Change |
| --- | --- | --- |
| Far lakes: blurred shores, "dirty spots" mid-lake | Depth from coarse triangles interpolated over hundreds of metres: the depth tint shows triangle facets in the shallow band (v2) | `applyWater`: lakes blend to an opaque body from the near/far switch (1.6 km) to 4 km, as traced rivers do. v9: crisp shores, uniform water. |
| Streams as dry trenches from the air | 8 m cut finer than the triangles from ~0.5 km; the near ribbon hidden under them (run 22 tints) | Narrow reaches (< 10 m half-width) draw from the channel profile where the triangles miss the cut, opaque body; listed within 12 km only (run 24). |
| "Zipper" banks, "man-made dam" outlets | The level fit's 400 m downstream smoothing put a steep stream's level ~20–30 m under the ground; the carve cut slots (capped at 24 m) whose walls the bank-retreat bake eroded on its 16 m grid into teeth. Proven: bake off → vertical slot walls (v11); two carve-only changes (bank rise width, blend width) changed nothing (pixel diff 0.2 vs 33 for legacy banks) and were reverted. | `riverValleyLevels`: smoothing lowers the level at most `smoothCutM` 2 m below the fit (larger drops stay falls); the source ramp holds it at most `rampRiseM` 0.5 m above (steep outlets no longer float). Test: 12 % slope, old 30.6 m below / new 2.0 m. v12/v14: outlets cascade, no slot walls at shot 5. |
| "A line in the middle of the river" | Two mountain streams from different lakes ran 20 m apart down one valley to the same lake; their ribbons met in a seam (v13 river probe) | Streams that come within 64 m of an earlier stream's route join it as tributaries (`_joinMountainStreams`, junction level read at the meeting point): 122 joins. |
| Floating water sheets, rough polygon pockets (mountain lakes) | Not fixed. The near lake mesh draws a flat sheet at the lake level wherever the mask allows water and the ground is below it; the mask (32 m, shore band, bilinear) ends where the ground is still below the level (past sills, hollows on the rim), so the sheet's edge stands in the air (v7: `nomesh` removes the walls; depth tint shows the pockets). | Proposal: store the 32 m solve's signed depth in the mask (outside cells strongly negative) and allow water only where it is above a small tolerance, so masks end where the solved ground rises above the level. |

Second round (owner, same day; v15–v19):

| Issue | Cause | Change |
| --- | --- | --- |
| Far lakes still blurred at 2.5 km (islands, shallow shore) | The opaque blend (1.6–4 km) was still mostly see-through at 2.5 km | Past the switch the water reads deeper than the coarse triangles by 0.0125 m per metre (`LAKE_FAR_DEPTH_PER_M`), so the bed fades within a few hundred metres. v16: crisp shore, no spots. |
| Wide flat water sheet beside a stream | Every river's ends flare 2.3x over 180 m (big rivers' mouths); an 8 m stream became 20–26 m wide at its outlet and junction | Mountain streams flare 1.25x over 40 m (`streamShape`). v18: a normal Y junction. |

Third round: lakes still blurred with the camera 1.2–1.9 km from the water (owner's "2000 m altitude" is above sea level; the lake is at 454 m). The near mesh hands over from 1.0 to 1.6 km and the far fade began at 1.6 km, so in between the terrain shader showed the bed through coarse-triangle depth. The fade now starts at the handover start (1 km): +0.05 m apparent depth per metre, opaque by 2.4 km (v22: crisp at 1.3–2.8 km).

Joins now measure the distance to earlier streams' route segments, not their points (streams 40 m apart between 128 m points were missed).

Still open: some cross-slope stream banks keep teeth (the cut into the uphill side, then the 16 m bank-retreat grid); a stream's ribbon can sit above under-resolved triangles on steep reaches (shot 5, two strips). Cold shader compile stall (optimization item 15).

## 9. Floating edges, slots and ponds (2026-10-12, branch `water-ponds`; most of it merged to main in 82c916d)

Evidence: `tools/perf/structured-terrain-results/water-look-2026-10-12/` v23–v36.

**Floating lake edges and rim pockets.** Lake masks are now a signed distance to the solved water (`core/world/water/lakeMaskSdf.js`, encoded 128 + metres in the r8 atlas; `surfaceDepthRangeM < 0` marks them). Water shows only where the ground is below the level and within half a solve cell (16 m) of the solved region; the near mesh discards the same. The old binary mask with its shore band (up to 3 cells where the 32 m ground is less than 6 m above the level) let water into every dip of a ~96 m rim, and big lakes' downsampling dilated it further. Cost on the main thread: 0.86 s over all lakes, at most 31 ms for one (applied a few lakes per frame). Residual: on very flat shores the cut shows as short straight segments near the camera.

**Slots under streams (the "dam", toothed banks, floating ribbons).** Three causes, each measured with the carved sampler against the river levels:
1. The level fit's downstream smoothing (fixed earlier: at most 2 m below the fit).
2. The bank-retreat bake (`riverLandscape.js`): it processed cells lowest-goal first, so low downstream channel points limited everything upstream; on a 60 % stream the cut grew to ~30 m at the outlet. Now each cell takes its limit from its nearest channel cell, and channels narrower than a bake cell (16 m) are left to the carve: the bake cannot resolve them (a 5 m stream was cut 25–30 m). Shot 5: carved ground 0–0.9 m below the water.
3. Drainages that cross closed hollows: the level cannot rise again, so the carve cut through the rim (stream 110: 13 m for 900 m). 52 % of the streams did this.

**Ponds.** Hollows at least 3 m deep (`pondMinDepthM`) that a mountain lake's drainage crosses before its stream ends fill to their spill: solved at 32 m like the lakes, the stream ends in the pond, and the pond's stream follows the rest of the drainage (`WaterService._mountainPonds`, `mountainLakes.js drainPath` pits). 3,239 ponds (p50 14 ha, 16 m deep; 546 over 50 ha), 4,686 streams on the default planet: the ranges become an upland lake district. Owner (2026-10-12): ponds and constrictions are wanted river features.

Also: `RIVER_SOLVE_VERSION` in the river cache key (level, trace or bake changes); lake holds at the river's ends only (`waterWorkerCore solveRiver`).

**Costs and limits.** Cold mountain phase 77 s (discovery 25 s, drains and ponds 40 s); warm from the cache. Mask atlas 65 MB with the reserve raised to 1.3 slots per mountain block (the atlas is sized before the mountain lakes exist; a growable atlas is optimization item 4). Streams quadrupled: more lazy traces and tile regeneration near the camera (item 8). Open: toothed uphill banks where a narrow stream runs across a slope (the carve's organic bank profile), the flat-shore cut, and whether this many ponds is the look the owner wants.

**Teeth (2026-10-12, branch `water-ponds`, uncommitted; v37–v54).** The carved height field is smooth at 0.5 m, but where a stream is cut into a cross slope its uphill wall rose 5 m within 2 m (a 4.5 m ledge over 0.5 m, cut off by a ~1.5 m fade); the 1–4 m terrain grid drew that wall as a saw-tooth. Organic banks now lay the cut back: the fade is at least 2 m wide per metre cut and the ledge above a 1 m toe at least 1.9 m wide per metre of rise (`RIVER_BANK_DETAIL` wallRunPerM, ledgeRunPerM, toeRiseM). That cuts all the way to a stream's edge, where its bank is only 0.2 m above the water, and coarse triangles dipped under the water in shards: narrow reaches (half-width under 10 m) now take their water from the channel profile at every distance (`waterRiverAtView`), and the near ribbon is clipped where the profile is above the water. Several wrong hypotheses on the way are recorded in the evidence README (v38–v53). Open: streams at the junction view look wider than before, a small T-shaped piece at one confluence; streams sit 4–5 m under the ground on their own line on cross slopes (the level fit's 25 m floor width; a narrower floor for streams was tried and set aside).


## 10. Rivers: start here for the redesign (2026-10-13, branch `water-ponds`, uncommitted)

**Owner's verdict (2026-10-13).** The rivers are far below the bar; the owner's whitewater screenshots are the minimum, and the target is higher. Four problems, then performance:
1. **One water surface.** Shallow-water equations will displace the river mesh and drive its texturing, so a river's water must be one geometry from bank to bank. A middle drawn by one path and sides by another (the "strip in the middle") cannot work.
2. **Width varies** along a river by at least 2–3x (pools, narrows), not the current near-uniform width.
3. **No sawtooth banks.** Some remain.
4. **Banks vary.** Today they have one height and gradient along the whole river and look man-made. They need varying ledges, and in places no bank at all: the ground grades smoothly into the surrounding terrain, blended over 50+ m.

**What the strip is (proven, evidence v59–v61).** Stream 1319 at the owner's pose:
- The terrain shading draws channel-profile water for narrow reaches (half-width under 10 m, the v54 change).
- The near river ribbon is drawn over that and spans wider. Beyond the terrain's water it lies on banks at about the level: its outline is cut by the bank triangles (straight edges), and the speckle there is most likely a depth fight.
- The debug tints cannot show this: the near meshes are skipped whenever a tint is on (`NearWaterRenderer.render`), so tint 4 magenta means the terrain shading's near weight, not the mesh. To tell the passes apart, use variants that patch `backend.draw` per material (`views-strip3.json`).

So the owner's reading is right. Two renderers each decide independently where the water is: the terrain shading (depth test or channel profile) and the ribbon (`profileM < level` within `hw`), and the banks' triangles decide the rest.

**State of this branch.** All uncommitted on `water-ponds` (on top of main `d840654`):
- Teeth fix: laid-back organic banks, `RIVER_BANK_DETAIL` wallRunPerM, ledgeRunPerM and toeRiseM.
- Narrow reaches drawn from the channel profile at every distance.
- The ribbon clipped where the profile is above the water.
- River ordering: mountain streams ranked at 4x their distance, within 12 km.
- Atlas reserve, and the `waterViews.mjs` variants.

These patch the current design rather than meet the bar. The owner has not approved them; review each hunk before keeping any of them.

**Also open: big rivers barely trace.**
- Cold first load: about 107 s of precompute before the first river trace.
- After that the 4,686 mountain streams starve the 106 graph rivers: 5 graph rivers traced in 3 min (v56), and 6 with the ranking change (v57).
- Each lazy trace is slow. Rivers need precomputing in the worker pool like the lakes (optimization item 8).

**How to work (owner, 2026-10-13).** Small increments, foundations first. Every increment must be a measurable step forward:
- Name the metric before changing code.
- Measure the baseline on the code as it stands.
- Change one thing, measure again, and capture the owner's poses.
- Report the numbers and stop for the owner's look before the next increment.

Nothing visible changes until the measurement tools (R1) and the cross-section function (R2) exist. An old path stays behind a switch only while the A/B is needed. Once the owner accepts the new one, delete the old code, its toggle and its config (memory: delete pruned code outright).

**Increments (proposed; the owner may reorder).**

- **R0. Starting point (no code).**
  - Ask the owner to decide on the uncommitted hunks on `water-ponds`. Each was a patch to the current design:
    - laid-back organic banks (`riverCarve.wgsl.js`, `RIVER_BANK_DETAIL` in `riverShapeNoise.js`);
    - narrow reaches drawn from the profile (`waterWgsl.js waterRiverAtView`);
    - ribbon clip (`nearWaterSurface.wgsl.js`);
    - stream ranking (`WaterService.update`);
    - atlas reserve; `waterViews.mjs` variants; docs.
  - Note, don't build on: a river simulation exists (`WaterRiverSim.js`, `ShallowWaterSim.js`, `riverStrip.js`, `WaterSimRenderer.js`; on by default, off in every capture here with `riverSim=off`). The owner (2026-10-13): it is still quite broken. It might be a starting point later, but it is far from ready. Keep `riverSim=off` until R7.
  - Output: a short status note, no metric.
- **R1. Measurement foundation.**
  - (a) A truthful ownership view. The debug tints skip the near meshes today. In debug, each pass draws its own colour: terrain-shading water, near ribbon, simulated surface, lake sheet. Overlaps show as a mix. Count the pixels per class inside the river's screen area: one owner, more than one, or none where the ground is below the water.
  - (b) River metrics along traced rivers, sampled every few metres:
    - wet width on each side;
    - bank height and slope on each side;
    - water level minus ground on the river's line (the trench);
    - the narrowest ledge, in terrain vertex spacings at LOD 0.
    - Summaries: width p90/p10, along-river variation of bank height and slope per side, trench p50/p90, count of ledges under 2 spacings.
  - (c) Baselines on the current code: the owner's poses plus 3–5 rivers (graph rivers and mountain streams).
  - Metric: the tools exist and the baselines are recorded.
- **R2. The cross-section function (foundation, not drawn yet).**
  - One definition, in JS with WGSL generated from the same constants (as `riverShapeNoise.js`). At a river's arc length s and signed offset n it gives the bed, each side's bank surface out to where it meets the natural ground, the wet edge on each side, and the water level.
  - Inputs:
    - long-wavelength (100–400 m) fields that choose each side's bank type: cut bank, low ledge, or no bank with a 50–80 m floodplain blend;
    - the width, varying by 2–3x, with pools at bends and confluences;
    - the thalweg skew.
  - Ledges are at least 2 LOD-0 vertex spacings wide by construction.
  - Unit tests: JS–WGSL parity, continuity in s and n, the ledge bound, width p90/p10 in 2–3 over long rivers.
  - Metric: R1(b) computed on the function alone (no GPU) meets the targets.
- **R3. Carve the terrain with it; water rendering unchanged.**
  - Metric: carved ground minus the function at LOD-0 probe points; R1(b) on the real terrain; zero ledges under 2 spacings (teeth); the owner's poses.
- **R4. Levels that follow the ground along the river's line.**
  - Today the level fit's 25 m floor (`floorExtraM`) puts streams 4–5 m under the ground on cross slopes.
  - Metric: trench p50/p90 from about 4–5 m to under 1 m; no lake or river records change except the intended ones.
- **R5. One water surface.**
  - Near: one river mesh spans the function's wet edge, and the terrain shading draws no river water inside its range.
  - Far: the same function, opaque body.
  - Metric: R1(a) at the owner's poses: no pixels with more than one owner, and no gaps.
- **R6. Big rivers trace and precompute in the worker pool** (optimization item 8).
  - Metric: graph rivers traced when loading ends (target 106 of 106; 6 today, v57); cold load time; tile regenerations after load.
- **R7. Near-camera simulated water (deferred until R1–R6 work; the idea itself is open).**
  - What the owner wants (2026-10-13): when a Whitewater-style simulation runs near the camera, the water's geometry may need to be finer than the terrain and move with the simulation; possibly lakes too. It matters for games where the river is the main feature (for example kayaking in this engine), so it would be switchable per game (config and `qtDiag`).
  - Open: whether finer water than terrain is a good idea at all. The shoreline is where the water meets the bank, so fine water over 1–4 m terrain triangles still gives a 1–4 m shoreline, and the two would need matching bank detail. Decide later, with the owner, once everything else works.
  - The existing simulation (`WaterRiverSim` and the rest, see R0) is broken; it might be a starting point, nothing more. Whitewater runs 0.5 m cells (256 x 1024, a 128 x 512 m window).
  - Until then: don't design for R7 beyond keeping R2's river frame (s along, n across) usable by a later simulation grid.
- **R8. Performance** (`WATER_OPTIMIZATION_PLAN.md`).

**Reference: whitewater** (`../whitewater`), the owner's river game. Its terrain is generated for rivers.
- `js/river.js` `channelProfile`: half-width with `widthVar` noise along the river, ponds 4x wide, waterfall pinches.
- Bank `1.8*(1-exp(-m/2.5)) + 0.06*m` plus valley and relief; thermal erosion outside the channel.
- `js/sim.js`: drives its GPU shallow-water simulation (Manning friction, foam) on one W x L grid.

It is not a drop-in (a fixed rectangular grid, not a planet), but it shows the level the owner expects.

**How to verify** (memory: prove a visual cause before fixing).
- `tools/perf/lakeRecovery/waterViews.mjs` with the owner's HUD poses (`{pos, look}`); owned server :8193; warm profile in the scratchpad.
- One evidence directory per run under `tools/perf/structured-terrain-results/water-look-2026-10-12/`, with a README row each.
- Owner poses on record: the strip at `[27537.2, 51504.4, -118473.7]` looking at `[27534.5, 51498.4, -118471.2]`; the others are in the `views-*.json` files.

**Progress (2026-10-13).**
- **R0 done.** The owner went with the recommendations. Kept, uncommitted, as the state R1 measures: laid-back banks, narrow reaches from the profile, the ribbon clip (delete the first when R3 is accepted, the other two when R5 is), the atlas reserve, the harness variants and the docs. Dropped: the stream ranking (v57: no gain for the graph rivers); its diff is `water-look-2026-10-12/r0-dropped-stream-ranking.patch`.
- **R1 built** (debug views and tooling only; the default rendering is unchanged):
  - Water debug views 6 and 7 (`qtDiag.water.tint(6)`, `(7)`): every pass writes a flat colour; the near meshes keep drawing and add theirs (alpha 0 under their premultiplied blend); the terrain returns before aerial perspective. 6: red the terrain shading draws river water, green a ribbon, blue the simulated surface (not wired). 7: red a river's zone (half-width + bankW), green the ground below that river's water, blue lake water.
  - `waterViews.mjs` views with `owner: true` take both with sky, clouds, particles, vegetation, meshes and post effects hidden. `tools/perf/riverMetrics/ownership.js` classes the pixels (shares of the wet pixels) and writes `<name>-owners.png`: magenta both, green ribbon only, cyan terrain only, red gap, grey dry zone, dark blue lake.
  - Views with `metrics: { river }` measure a river's cross-sections: `tools/perf/riverMetrics/` (`riverSections.js` stations every 4 m and clipping at bends, `sectionMetrics.js` the definitions, unit tests). Sections reach the widest half-width + 100 m at 0.25 m, sampled by the hydrology sampler as drawn and natural. The raw sections are stored; `recompute.mjs RUN_DIR` recomputes them without the GPU.
  - Definitions: wet edge; bank = the ground's rise above the water 2, 10 and 20 m past the wet edge, and the steepest 1 m slope within 10 m; classes by the rise at 10 m (none < 0.5 m, low < 2 m, high); blend = until the ground is back within 0.1 m of the natural terrain for 2 m; trench = natural ground on the traced line - water level; ledges = parts steeper than 45 degrees over 0.5 m that rise 0.3 m or more, measured in LOD-0 vertex spacings (about 1 m at face centres, from the cube mapping). A bank "top" (where the ground first levels off) was tried first and dropped: it flipped between a bench by the water and the whole valley side (v62, v63).
  - Gotcha: narrow streams are carved, in tiles and in the carved sampler, only while listed for the GPU (within 12 km of the camera). Metrics views stand the camera over the river first and record `listed`.
- **Baselines** (v63, README row):

| | Streams 1319 / 337 / 117 | Graph rivers 37 / 75 | Target |
| --- | --- | --- | --- |
| Width p90/p10 | 1.81 / 1.87 / 1.64 | 2.07 / 2.07 | 2–3 (R2, R3) |
| Trench p50 (p90) | 3.7 / 5.3 / 4.8 m (6.1 / 11.5 / 6.6) | 25.7 / 6.0 m (52.9 / 13.3) | < 1 m (R4) |
| Banks | high on 77–98 % of each side, in runs of 60–272 m | high 55–69 %, low 28–42 %, changing every 8–18 m | variety (R2) |
| Blend p50; share ≥ 50 m | 4–11 m; 0 % | 72–148 m (the valley bake); 93–96 % | proposed ≥ 20 % |
| Ledges < 2 spacings per km of bank | 102–153 | 72 / 44 | 0 (R3) |

  Who draws, as shares of the wet pixels: both passes 64–76 % at the stream poses (strip, river sheet 643, s112) and 99.5 % on river 37; ribbon only 19–24 % on streams; gaps 4–7 % on streams; shot 5 51 % terrain only (a narrow reach drawn from the profile where triangles hide the ribbon). R5 target: 0 % both, 0 % gaps. Where both draw on a stream, removing the ribbons changes nothing (the same colour), so the earlier on/off A/B could not see the double draw; view 6 does.
- **Found:** river 37's water stays at 504–501 m for 12.6 km under natural ground at 520–566 m, a canyon 25–60 m deep whose walls the valley bake lays back over ~150 m. The level looks capped by a dip in the natural ground at s ≈ 3.6 km (513 m) under the never-rising rule; that is inferred from the line profile, not traced in code. Relevant to R4.
- Stream ids in the warm profile (stable since v34): strip 1319, shot 5 337, s112 117, river sheet 643 163 and 2311. Graph rivers traced from the cache: 75, 62, 57, 43, 18, 66; 37 traces when asked.
- **Rivers too rare to verify (owner 2026-10-13: "it's still very hard to find rivers. They should be more common").** Census (v64, `tools/perf/riverMetrics/riverCensus.mjs`): land's median distance to the nearest graph river 17.7 km, with mountain streams 5.7 km; to a drawn river 163 km. After loading, the spawn has 192 traced rivers (6 graph, 186 narrow streams), and 3 minutes later still the same: the lazy trace only reaches 40 km, one river at a time. More lake outlets (`minRiverQ`) are capped by the 614 lakes (399 rivers at Q 100, median 7.0 km). Headwater rivers (Q ≥ 300) give 683 more, median 5.3 km, but break the rule that rivers start at lakes. By terrain (owner: "are they limited to … mountains? … plains lakes did not have any"): streams start only in 300 m relief, so plains (60 % of the land) are 14 % within 5 km of a graph river; 72 of 287 plains lakes have a river (outflow Q median 335 vs `minRiverQ` 1200). Plains within 5 km: `minRiverQ` 300 → 28 %, headwaters Q ≥ 300 → 53 %, ≥ 150 → 72 % (README v64). Awaiting the owner's choice: trace everything at load (R6 brought forward) and/or a density target.
- **Q fix and more rivers (owner 2026-10-13: fix Q, 70-80 % of lakes with a river, small rivers welcome, width variation stays in R2).** `waterGraph.js` took a lake's outflow Q at its outlet, the first cell where the deepest cell's drainage left the lake body, often its own shallow margin; 28.6 % of lake cells bypass it. Q is now read at the spill point (`spillCell`; the outlet and river starts are unchanged), `minRiverQ` 1200 → 100, graph rivers' `minWidthM` 30 → 8 and `minDepthM` 1.4 → 0.8, `WATER_ALGO_VERSION` water-v19, plus a regression test. Result: 453 of 614 lakes have a river (106 before), plains within 5 km 39 % (14 %); cold browser run (v66): no failed traces, 9 graph rivers within 40 km of the spawn (5 before). Resolved by the owner (2026-10-13): the rivers are there, they just load late. In a cold start the small lakes and their streams near the spawn appear after ~2 minutes. Requirement for the optimization (R6/R8): once optimized, lakes and rivers are computed at startup, never popping in minutes later.
- **R2 done** (owner 2026-10-13: "proven to work, proceed with the fixes and improvements; optimization comes last"). `core/world/water/riverSection.js`: one cross-section in JS with its WGSL generated from the same constants (`RIVER_SECTION`).
  - Channel: Whitewater's bed with the thalweg skew; each side's bank-full depth from its freeboard.
  - Beyond the half-width: a step, a terrace and a blend from bank-full to the natural ground. Each side's bank type τ (0 none, 1 ledge, 2 cut) comes from long-wavelength noise (320 / 130 m), the bend's curvature (cut banks outside, bars inside) and a per-river style.
  - The cut only lowers ground (soft min, C1). Ramps have a constant-slope middle and eased ends; a curvature cap (0.45 /m) sets each step's and blend's minimum width from its height, so no ledge is narrower than the grid can draw.
  - Width: `exp(σ N(s))` with σ 0.55–1.15 per river and wavelengths scaled to the river's typical width; baked into the trace's half-width (`riverRefine.js`), so the GPU carve and the water read the same width.
  - Tests (`riverSection.test.js`): only cuts, continuity, teeth under 0.15 m over bank type × height × slope, width p90/p10 median in 2–3 over 200 rivers, bank variety, naga validation. WGSL vs JS on the GPU (`tools/perf/riverMetrics/sectionParity.mjs`, Dawn): heights within 1.7e-4 m, derivatives within 2e-5.
- **R3 done (v68).** The terrain carve is the section function (`riverCarve.wgsl.js` rewritten; the trace record's field 12 is the bend curvature). Results:
  - Teeth p90 0.06–0.13 m on every measured river (0.6–2.5 m before); over 0.15 m on 0–3 % of stations (70–81 % before).
  - Bank classes mixed, in runs of 56–150 m; stream blends p50 29–61 m (7–13 m).
  - Carve minus function on streams: p99 0.09–0.27 m. Graph rivers 16 m and wider still get the valley bake on top (`riverLandscape`, p99 9–33 m); their remaining teeth (max 1.3 m on river 41) are there.
  - Open:
    - The banks look canal-like: smooth, but with straight, parallel edges. The organic banks' small-scale shore irregularity went with them. Next candidate: a smooth, curvature-capped wiggle of the wet edge and step (a few metres, 10–40 m wavelengths).
    - Gaps at shot 5 rose from 11 to 20 % of the wet pixels (cause not proven).
- **R3b (v70, v71).** Where two rivers meet, the carve took the nearest river's section, and the ground stepped along the line where the nearest river changes. At the river sheet confluence that was a 4 m step running 110 m across the land on both sides. Now every river in the cell's list gives its own section from its nearest segment, and the ground is the lowest. Junction seams 682 → 0 pairs (`carveSeams.js`: a jump in the carve's depth of 0.5 m or more and 4x its neighbours; 0 at river starts and mouths).
- **R4a (v72–v74).** A tributary took its end level from the trunk at the graph's junction, 114–386 m along the trunk from where its path actually meets it: up to 18.7 m above or 9.8 m below the trunk's water (6 tributaries). With R3b the trunk's lower banks then cut under a hanging tributary, leaving its water up to 4.9 m above the ground. It now ends at the trunk's level where its path meets it (`trunkLevelAt`; `RIVER_SOLVE_VERSION` 4): mismatch p50 0.01 m, max 0.4 m, and stream 2635's water sits 0.45–0.59 m above its own channel floor to the mouth.
- **Still open from earlier:**
  - the ribbon's speckled sides and the double draw (R5);
  - trench p50 4–6 m on streams and 26 m on river 37 (R4);
  - the segment buffer drops 1–5 far rivers since the Q fix (R6/R8);
  - slow river loading (R6).
- **Owner's look (2026-10-13 evening):** trenches; no visible width variation; artificial banks (a bit better); "very broken starts of rivers" = fragmented polygons where a river leaves a lake; one river "broken in between, does not lead anywhere" (new). "Use your own judgement how to proceed."
- **Junction shores (v76-v85).** Proven by carve on/off A/B (v81): at the owner's poses the fragments were lake water drawn on banks the carve had cut below the lake's level. The lake shore band (water on ground below the level within 16 m of the solved water) took them; `trimLakeBand` used to clear the band near rivers, but signed-distance masks ignore the trimmed mask. Fixed in the water shading, not the terrain: near the carve of a river below a lake, the lake keeps to its solved water (`waterLakeBandYield`, terrain shading and near lake sheets). The cut-off behind a river's first point (a seam up to 2.4 m) now fades out over 30 m. A carve-side "lake floor" was tried and reverted (v82: terraces where it met the cut).
- **Still open at junctions:**
  - The lake index drops a third lake in a 400 m cell (161 cells of 112 lakes; ponds go missing at river starts: river 2591).
  - The trace flags reaches as in a lake from coarse graph cells where no lake is drawn (river 2587); one record starts 10 m above its source lake (2576).
  - Thin ground strips between a lake's outline and the river band at outlets (not carve-made).
  - The water lookup takes the nearest river only, while the carve takes the lowest.
  - The owner's "river broken in between" was not found at the posed screenshots (v77: every river continuous there); screenshot 2 has no coordinates. Likely candidates are the first two items.
- **Lake rims and capacity (v86-v94).** Owner: shot 5's lake "floats" with terrain-shaded water under it.
  - **Rims:** per river point and side, the highest drawn water within the banks' reach plus 0.3 m, falling 0.2 m/m beyond 40 m (`riverLakeRims`, record 14/15). The bank's step rises to it (`riverBankRim`), so the section's own ramp and blend keep their shape. Unlike the reverted floor, no flank and no crease.
  - **Shore-band rule:** narrowed to 20-30 m from a river's channel. Over the whole reach it turned small ponds into polygons.
  - **Lake index:** a third lake per cell, in the cell's second word above its river block (161 dropped cells -> 3, counted).
  - Result: s1, s3 and river 2591's pond are clean; shot 5's gap 23 -> 8 %.
  - Left at shot 5: a thin strip where the lake sits on a natural rim narrower than its 32 m solve cells above a valley. The lake's outline reaches over the crest: a lake shore resolution problem, not the carve.
- **R4 trenches (v95-v99).** Trench (natural ground on the line - water level) broken down on the stored sections. Baseline streams p50 3.6-5.3 m:
  - **Lateral** (the lowest ground within 2 hw + 25 m beside the channel): 0.3-2.1 m.
  - **Allowance** (bank crest incl. the old banks' 0.8 m rise + 0.5 m margin): 1.4 m.
  - **Smoothing:** 1.9 m. Steep streams (6.6-24 % median slope) were always lowered by the 400 m average's 2 m cap.
  - **Changes:** levels not smoothed (the 20 m points make drops rapids, falls bake); ground within 4 m of the channel's edge (`bankBandM`); allowance (1 - waterFrac) D + 0.5 m (`RIVER_SOLVE_VERSION` 11; record 13 = the fit's ground).
  - **Result:** trench p50 strip 1.3, shot 5 1.6, s112 1.35, river 95 2.3 m; spill 0 %; teeth p90 0.09-0.14 m. River 41 still 25.7 m: a low spot upstream holds its level for 12 km (the canyon).
- **Starts and ends (v100-v115, owner 2026-10-14: "ugly starts and endings, hard edges, land strips, floating water, darker cyan").**
  - **Band yield removed (v101).** It cut the lake's shore band along every river near a lake: the straight edges and dry strips at mouths.
  - **Rims from bank points (v103).** Measured at hw + 5 and hw + 20 m (lakes behind the bank were missed from the line): bank spill at starts 3,167 -> 2,879 m².
  - **Smooth mask sampling (v105).** Cubic B-spline over the signed-distance atlas: the star's 32 m scallops ("sine wave") gone.
  - **Debug view 9** (`qtDiag.water.tint(9)`): why a signed-distance lake draws or not, per term of `waterLakeHitIn`. It separated two mechanisms (v109):
    - (A) outlet strips: a river dropped below its lake while the ground beside it was still inside the lake's band, so the lake gave way over the river's half-width and the river drew only to its profile's waterline;
    - (B) straight band edges over low ground: the lake ends at the 32 m solve's -16 m contour, straight between cell centres, where the real ground beyond dips below the level for a few metres (o4-mouth, o4-star, s1).
  - **Source lake hold (A, v115).** A river keeps its lake's level past the lake's cells while ground beside its channel is below the level inside the lake's drawn band and nowhere outside it (`riverLakeHold`, `RIVER_SOLVE_VERSION` 15); downstream the fit as before. Gap at o4-floating 3.66 -> 0.01 %, outlet-down 0.38 -> 0.03 %, shot 5 10.2 -> 10.9 % with its floating wedge gone; seven other poses identical. Attempts: a 32 m cap on ground alone flooded land outside the band (v113); restarting the fit at the hold kept the water 0.5 m higher for 120 m downstream (v114, shot 5 gap 18.5 %).
  - **B open:** needs finer heights than the 32 m solve (between two outside centres the bilinear 32 m ground is above the level too). Plan: per lake near the camera, flood-fill its shore ring at 8 m from the solved region over ground below the level; the mask's distance field from that, point-sampled at the atlas texels (distance fields interpolate straight shores exactly even at 32-64 m texels); band -4 m. Open questions: lazy near-camera vs precompute cost, and keeping the trace's lake cells (hold, rims) consistent with the finer outline.
- **Next:** B (fine lake shores); river 41's canyon (levels capped by an upstream low spot: fill it as a pond, or let the level rise); width variation that reads (pools and narrows); natural bank edges. Still open: river 2576's start 10 m above its lake, the water lookup's nearest-only river at confluences, ribbon edges (R5).
