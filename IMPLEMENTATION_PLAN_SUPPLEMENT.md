# Supplement to IMPLEMENTATION_PLAN.md: session hand-off

Written 2026-10-03, updated in session 3 (2026-10-05, HEAD `33915bf`) for the agent that starts the next work session (and readable by the owner). This file holds what the plan itself doesn't: status, working agreements, why the plan looks the way it does, and traps already found. Read it together with `IMPLEMENTATION_PLAN.md`.

## Status (session 3, 2026-10-05)

- **HEAD `33915bf`, not pushed** (11 water commits on top of `deed28a`; push only when the owner asks).
- **Part A:** the steady-state regression is fixed (`a96731a`, `ceade51`). Streaming catch-up after fast flight: owner parked it until after water.
- **Part B, terrain:** RuneVision erosion in production (single height function, no B5 tier stack). Mountain terrainType remap: owner wants it **after lakes exist**, then re-tune lake density.
- **Part B, water:** lakes (1160) and rivers (traced at 16 m, lake to lake/sea) drawn in the terrain shading; the shallow-water simulation runs in a 256 m site around the camera when low near water. Owner saw lakes in the browser (2026-10-05); **rivers and the simulation await the owner's browser check**.
- **Before trusting line numbers,** run `git log --oneline -10`. Plan line numbers refer to `a96731a`.

## Session 3: water (2026-10-04/05)

**Owner decisions:** ~1,700 lakes (8 m / 12 cells, counted as whole water bodies); lakes first, solver alongside; **natural shores** (lake level from a 16 m fine solve, terrain not reshaped; only micro detail to be removed in a band at the waterline, not done yet); erosion-seed pits off now (old lake verifier skipped; delete the code later with the old lake system); far water simplified for performance: **"water in terrain shading" chosen, "reversed-Z + tile water" kept open** (be ready to switch). Old ocean's problems were waves and seams, not shore flicker.

| Commit | What |
|---|---|
| `c82165b` | Erosion-seed pits off (`terrain.features.erosionSeeds: false`); startup skips ErosionSeedVerifier/setLakes. Pits never registered on the 512 m grid (0 cells change). |
| `1c083d5` | waterGraph: lakes = whole water bodies holding a deep core (554 of 2061 "lakes" were fragments; 53 "rivers" ran inside one lake); exact spill levels (second flood, no epsilon); confluences (tributary ends on the trunk). Planet: 1699 lakes, 414 rivers (302 to a lake, 92 to sea, 20 confluences), chain of 10 lakes to the sea. |
| `6cd9217` | lakeRefine.js: fine solve per lake on a 16 m tangent-plane patch (border-seeded priority flood); HydrologyGrid sampler (grid + patches, chunked dispatches, terrainKey). |
| `e58cdf0` | WaterService: after the initial load, grid sampled on GPU (one dispatch per frame) or from IndexedDB, graph built in a module worker, lakes refined nearest-first within 40 km, merges, routing rule (a lake drains only into a strictly lower lake). `terrain.waterGraph.enabled` (on in runtimeConfigs). |
| `9019167` | ShallowWaterSim (core/world/water): Whitewater's numerics rebuilt; per-edge open/closed boundaries + per-cell relaxation (inflow, fixed level, sponge); depth clamp optional; rock turbulence scaled by speed (Whitewater's stirred still lakes: 1.3 m/s after 50 s). |
| `10e7945` | Lake GPU data (LakeGpuData: cube-grid index with two lake slots + river bit, lake table, 96-layer mask atlas) and shared lake WGSL (lookup + water shading). |
| `05d28ea` | Terrain shader draws lake water before aerial perspective (bind group 3, bindings 12-15; dummies when off). `terrainShader.lakeWater: false` removes it. |
| `ad4e93d` | Owner: a third fewer lakes: `minLakeCells` 18 (1160 lakes, 349 rivers). |
| `6073c9b` | Rivers (owner: "always connect lakes or lake to ocean"; graph river cells ended on dry ground): riverRefine.js traces each river at 16 m from the source lake's fine outflow (lake solve's drainage out of the sill) down the graph's route in a 1 km corridor, flood-seeded only from the destination's water as drawn; level never rises, never above the source lake; a start above the source lake → 2.5 km corridor retry → lake re-solved past the river's high point (closed depression backing up: lake 527 +6 m). Drawn in the terrain shading (segments per grid cell, binding 16; channel + low-ground spread; flow ripples). Lab: 22/22 rivers, shader lookup along every river 0 dry samples. |
| `33915bf` | River channels carved into the terrain height function (core/world/water/riverCarve.wgsl.js, last step of calculateTerrainHeightD: every LOD, normals and the sim bed share it). Owner: carve in terrain generation, same at every LOD; hollows "pond if deep, fill if shallow" (≤ 2× depth); flow rule "the river cannot flow backwards": water level never rises, the bed may rise after a pool. Levels below the banks (freeboard ramped from the source), never above the source / below the destination. One combined profile over nearby segments (cut + fill against it; per-segment fill made 1.8 % of the centre line channel-less). Segment lists per 4×4 sub-cells (~100 m). Generator group 1 bindings 1-3; sampler traces uncarved, sim bed carved. Tiles touching cells whose rivers changed regenerate in place (TileStreamer.regenerateTiles, own queue on spare budget; version check for tiles generated across a change). Lab: channel on 100 % of 110 km of centre lines, CPU mirror within 1 mm; tiles +3.5 % GPU with the carve compiled in, +5 % on river tiles (first-batch timings are cold: +50 % was an artefact; warm up and interleave). |
| `19b8fe3` | Near-field SWE: WaterSimSite (256² × 1 m at the camera's nadir, bed from the height function, start from the static water via the shader lookup, border band relaxed to static water, warm-up then fade-in), WaterSimRenderer (Whitewater's look), terrain shader hides static water under the site. Active within 400 m altitude and 300 m of water (`terrain.waterGraph.sim`). ~0.5 ms/frame in the lab. |

**Lab facts (keep):**
- Grid lake levels do not hold water at full detail: fine level − grid level p5 −14 m … p95 +13 m, area ×0.38 … ×1.89 (survey of all 1699 lakes, 216 s in Node). 16 m and 4 m solves agree within 0.2 m. All 1683 solvable lakes survive at fine scale; 15 giants exceed the 9 M cell cap at 16 m (production: limitPatchCells coarsens the spacing).
- Routing from fine exits through the graph's drainage made 11 two-lake cycles and 64 uphill routes; the strictly-lower rule removes them by construction.
- Depth buffer: depth24, non-reversed, near 0.5 m on the ground: depth error ≈ z² / 8.4e6 m (0.12 m at 1 km, 12 m at 10 km). A separate water surface would flicker in a shallow band at distance; the terrain-shading water has no depth test.
- Solver (terrain-lab/swe-tests.mjs): still lake exactly still; closed bowl conserves volume to 5e-8 over 50 s; Manning channel uniform flow kept to 0.01 % and reached from a 0.1 m film (0.1 % after 900 s; friction time scale V/(gS) ≈ 85 s); 0.21 ms per substep at 256².
- Micro detail (final height pass) adds up to ~10 m × gain in forests: not in the 16 m solve, so shores get micro puddles inside the mask band until micro is suppressed at the waterline.

**Owner's browser check (pending):** see the end-of-session message: `[Water] graph ready` line, `qtDiag.water.stats() / near() / goto(id)`, lakes visible as water, `qtDiag.water.tint(1..3)` debug views, `qtDiag.water.look({...})` to tune, reload → `grid from cache`, no frame hitches after load.

**Known v1 limits (sim):** re-centring every 64 m of travel restarts the site (static water shows for ~1 s); bed has no micro detail; the hand-over at the site edge is a 12 m cross-fade. Pending sim fixes (proposed to the owner): inflow only at the upstream edge, free outflow downstream, lakes held; no thin-film start; foam only in fast or steep water.

**Open after the carve (2026-10-05):** pools. 37 % of traced river length crosses hollows deeper than the fill rule (median 6 m, p90 21 m, max 36 m below the bed): sub-grid lakes the river passes through. They hold water (owner: fine), but the static water draws them with the sloped spread (river level − 0.15 × distance), so their shore is a polygonal distance contour, not the terrain contour (seen in terrain-lab/out/water-sim-site.png at river 901's middle). Proposed fix, not started: per river point a pool reach from the trace's fill grid (connected cells below the water level), and inside it a flat surface (shore = terrain contour). Also: cuts up to 16 m (p99 12 m) where the trace crosses a rise; two rivers sharing a path after a confluence still trace separately (the carve takes the lower profile).

**Next steps (owner-approved order):** fix what the browser check shows; micro detail suppressed in a band at the waterline (needs per-tile lake data in terrain generation, tiles regenerate when a lake is refined); rivers (fine path from each lake's fine exit, channel carve, static rendering); near-field water surface (SWE site, plan 8.2-8.5) for objects in water and the camera underwater; then the mountain remap and lake re-tuning; then the old lake/pit code removal and the ocean rework.

**Lab tools added (terrain-lab/):** `water-carve-run.mjs` (carve along every traced river: channel/pond/cut stats, CPU mirror vs GPU, tile GPU cost interleaved, pictures; LAB_TERRAIN_JSON='{"waterGraph":{"enabled":true}}' to compile the carve in), `water-analyze.mjs` (fragments, extent, cuts, confluences; LAB_TERRAIN_JSON for feature A/B), `water-density-panels.mjs`, `lake-fine.mjs`, `lake-refine-survey.mjs` (all lakes), `water-service-run.mjs` (service + Map cache, restore check), `lake-gpu-run.mjs` (LakeGpuData on Dawn, index readback), `swe-tests.mjs` (solver physics), `tint-frag-check.mjs` (terrain fragment variants through Tint).

## Verification pass, session 2 (2026-10-03, static code trace at `a96731a`)

No runtime measurements: the owner declined headless runs for this pass. Everything below is read from the code. The owner's observation that same afternoon: unchanged HEAD runs "much smoother, only small FPS drops during movement, no stuttering" (fresh page load, plain `python -m http.server`).

**Per-commit trace of the steady-state cost (R0/R9):**

| Commit | What it changed for steady-state cost | Evidence |
|---|---|---|
| `33de8b1` (good baseline) | Every LOD5+ pixel already ran the 64-sample flat-colour average (64 × textureLoad + 2 `sin` + range lookup + ≈12 compares). LOD4 ran it on a half-tile edge ramp. | solid-tier branch, fragment shader :3765 |
| `6794716` | LOD0–4 distance fade (≈5.0–7.8 km): almost every LOD4 pixel now runs the 64-sample average *on top of* full detail. | :4469–4478, `_computeTierFadeDistances` |
| `82dcf94` | (a) Every detail tile without complete material is drawn through the same 64-sample average. (b) That makes unrefined tiles look finished while refinement still drains at ≈17.5 ms GPU each (R9 becomes invisible). (c) Pre-existing: with `streamedAssets:false` solid-tier tiles still refined scatter+climate (≈ a geometry job each, output unused), and refinement priority `-distanceInTileWidths` runs those coarse tiles *first*. | instance builder :587–595, tileStreamer :2286, `requiredTypes` at 82dcf94 |
| `a96731a` | Baked `coarseColor`: one bilinear sample replaces the average in **every** production variant (LOD5+ included, so cheaper than `33de8b1`). Refinement much cheaper (64-thread palette reduce, shared padded height, resident height/tile reuse). No scatter/climate when `streamedAssets:false`, so solid-tier tiles need no refinement. | material builder :265–268 (wiring complete: pool has `coarseColor` before materials build, wrapper `_isArray`), fragment :1441–1449 |

**Claim verdicts (F/R):**

| ID | Verdict | Evidence / correction |
|---|---|---|
| F1 | Confirmed | `GPUQuadtreeTerrain.update` :765–803. Order is flush → generation(+refinement) → adaptive LOD → camera ctx → predictive → uniforms → traversal → instances → feedback → visible readback → `[QTLight]`. |
| F2 | Confirmed as code, **no admission effect** | tileStreamer.js:1446–1450 returns before `_tickRefinement`. But geometry's effective budget is 0 only when fences overshoot by ≥ `urgentReserveSlots` (1), which also exhausts refinement's own reserve, so refinement could not have started anyway. Only the two retry scans were skipped. |
| F3 | Confirmed | asyncGenerationQueue.js:105–162 has no `return`. Refinement's budget therefore ignores same-frame geometry starts, allowing up to 8 + 1 + 4 fences in one frame. |
| F4 | Partly | Both passes are one workgroup. The visible-hash insert is single-threaded, but the per-tile resolve is spread over 128 threads (instanceBufferBuilder :495), so the material walk added in `82dcf94` is roughly 0.1 ms, not a frame. |
| F5 | Confirmed | feedback interval 1, visible interval 2; visible list = two serialized `mapAsync` round trips (QuadtreeGPU :905). |
| F6 | Confirmed | 8 types (`streamedAssets:false`), 29 B/texel, 2048 layers, ≈1 GB incl. normal mips. |
| F8 | Confirmed | per-frame admission: 16 starts / 8 fences (+1 urgent) geometry, 4 (+1 near) refinement. |
| R0 | Confirmed for `6794716`/`82dcf94`; **not present at HEAD** | see trace. Runtime check still worth doing: `_materials.get(4).defines.USE_COARSE_COLOR_TEXTURE === true`. |
| R0b | Partly | At HEAD the waste is small on LOD4: its micro colour already comes from one prebaked `resolvedColor` sample (LOD4 fade is 128–179 m, so always 1); only the splat-weight sample is thrown away. It is larger on incomplete LOD0–3 tiles (full splat path), transient. **Related claim confirmed:** after the flat mix nothing reads LOD4 material (AO off in `world/engine.json` and `maxLod 3`, ground field absent without streamed assets), so refining a LOD4 tile entirely beyond the fade end changes no pixels. |
| R1 | Confirmed, grows with flight history | :2413–2426 + :2824–2864. Entries leave only on eviction or strict visibility, so the map can approach the pool size. Each entry costs a scan of the visible list plus ≈depth template-string keys, every frame with fence headroom. Predates the window. |
| R2 | Confirmed | sort on every request (:70) and promotion (:37); `shouldDrop` re-parses every key each tick (:905). |
| R3 | Confirmed | `_evictTile` :1939–2080: visible scan with `key.split` inside the loop, full-pool age scan, `Logger.warn`. |
| R4 | Confirmed, plus | :2476–2680. Also: the D3 scan walks all 2048 entries **and logs `[QT-VisMarkD3]` at INFO on every readback** (≈30 lines/s), :2579–2594. |
| R5 | Needs runtime | |
| R6 | Confirmed (by design) | |
| R8 | Partly | see F4. |
| R9 | Confirmed mechanism; smaller at HEAD | flat placeholders hide the drain; fence (not ms) admission saturates the GPU while it lasts. |
| `discard` | Confirmed present | fragment :4322–4324. |

**New findings:**
- N1. `standalone.html` :9–39 pushes every `console.log/warn/error` into `window.__diagLogs`, which is never trimmed (since `aad8bac`, 2026-09-14). At INFO this grows by ≈30+ entries/s, so GC load grows with session length.
- N2. A refinement whose `generateTile` throws leaves the tile `RESIDENT` and never re-queues it (:2349–2353): permanently flat. Rare.
- N3. Stale refinement entries are discovered at dequeue and still consume the frame's start slots.
- N4. Testing caveat: plain `python -m http.server` sends no `Cache-Control`, so Chrome may reuse cached ES modules after an edit (heuristic freshness). `server.py` sends `no-store`; use it when testing changes.

**ChatGPT's O(N×M) claim (the R1 retry scan), checked:**
- The hot path is real: parked entries × visible tiles × ancestor walk, plus ≈depth string keys per entry, every frame with fence headroom.
- "Unbounded map" is wrong: entries leave on eviction, so the map is bounded by resident tiles (pool 2048).
- "2000 × 2000" is the cap. The measured visible count at 1800 px was 256–272 (2026-10-02), so a realistic worst case is ≈2000 × 270 per frame: several ms to ~10+ ms of main thread, growing with flight history, reset by a reload.
- "Direct cause of the regression in the last commits" is wrong: the scan was already in `33de8b1` (the good baseline) and none of the three commits grew it; `a96731a` shrinks its population.
- "Explains the 20–30 s latency in `TILE_STREAMING_PERFORMANCE_FINDINGS.md`" is wrong: that telemetry was captured before the retry path existed (the doc's drop site is "drop as not relevant, don't retry"), and it measured the geometry queue backlog (pendingGen 684).

**Conclusion.** The window's steady-state regression is the 64-sample flat average spread to many more pixels (`6794716`, `82dcf94`), plus the refinement drain becoming invisible behind flat placeholders (`82dcf94`). `a96731a` removes the first entirely and shrinks the second, which matches the owner's smooth re-test. What still costs at HEAD, conditionally: the R9 drain during and after movement (fence-based admission; F3 adds up to one extra refinement fence per frame), R1/R4/N1 (grow with session length), R3 (while streaming).

## Implemented in session 2 (owner approved "all four", 2026-10-03)

All behind `gpuQuadtree.streamerFlags` (EngineConfig, runtimeConfigs), runtime toggle `qtDiag.setStreamerFlags({...})`. Defaults are the new behaviour.

| Flag | Change |
|---|---|
| `indexedVisibility` | `TileVisibilityIndex` (integer keys, visible + ancestor sets) rebuilt per readback; demand checks O(depth); parked refinements re-queued from the readback (O(visible)) instead of scanning the retry map every frame; evicted tiles leave the retry maps. |
| `refinementBudgetCountsGeometryStarts` | `AsyncGenerationQueue.tick()` returns its spawn count (F3); refinement's budget subtracts same-frame geometry starts. `[QTLight] started=` is meaningful now. |
| `refinementTickWhenGeometryBlocked` | `_tickRefinement(0)` in geometry-saturated frames (only the queue-full retry runs; see F2). |
| `skipRefinementBeyondFlatFade` | Detail tiles whose nearest possible pixel lies past the flat-tier fade end (+10 %) are `DEFERRED`, not refined; re-checked per readback. Only when `streamedAssets` is off and the LOD has no terrain AO. Image unchanged by construction (those pixels are flat at weight 1). Expected saving is modest: only the outer part of the LOD4 band qualifies. `[QTLight] refinement ... deferred=`. |
| `diagnostics` (off) | `[QT-VisMarkD3]` pool scan, oscillation tracking, visible-copy-state samples/logs, and all eviction diagnostics (visible scan, pool age scan, `_recentEvictions`, warnings). |
| (no flag) | `window.__diagLogs` keeps the first 500 + newest 1500 entries. LRU stamping in `markTilesVisible` stops at already-visited ancestors. Fade formula moved to `core/world/quadtree/solidTierFade.js`, shared by renderer and streamer. |

Tests: `tileVisibilityIndex.test.js` (index = old scan on 16k random queries), `solidTierFade.test.js` (fade numbers, nearest-pixel bound vs brute force), `tileStreamer.refinement.test.js` (requeue, eviction, deferral, flag toggles, LRU stamps, queue spawn count).

Owner's test checklist (no headless runs):
- Serve with `python3 server.py` (plain `http.server` can serve cached modules).
- Fly for several minutes, then stand still: FPS should no longer decay with session length (A/B: `qtDiag.setStreamerFlags({ indexedVisibility: false })`).
- Flash tracker (evidence doc §6.2) still zero; modes 90/104 unchanged at the LOD4/5 band.

## Part B started in session 2 (2026-10-03)

Commits after `ceade51`: `6c1e4d1` (skip work that cannot change the result: ocean floor on full land, land features on full ocean, micro2/climate when `DISP_MICRO2` is 0, the stub crater tier; WGSL compile test), `57b9b1d` (analytic derivatives, opt-in `slopeMode`), `a34e8a7` (RuneVision port, not wired in). Lab scripts now live in `proj/terrain-lab/` (see the facts list): Dawn-node harness on the real generator, timestamp profiles, probes. Compute-only Node GPU runs are pre-approved; headless browser runs are not.

**Analytic derivatives (`57b9b1d`).** Every term of `calculateTerrainHeight` has a `_d` twin (value + gradient w.r.t. unitDir); `calculateTerrainHeightD` mirrors the term order. `terrain.slopeMode` = `'stencil'` (default, bitwise identical to before) | `'analytic'` (also settable in `world/terrain.json`). Measured: base pass 1.48 → 0.66 ms/tile, padded refinement base 1.37 → 0.60 ms, geometry tile 2.40 → 1.82 ms wall; 0.07–0.56 % of land texels change tile type (grass/forest/desert boundaries); cold compile +0.35 s. Gradient checked by path integration (p99 3e-3 of the path variation). Guardrail 4.5 respected: stencil stays the default until the owner's A/B. **Maintenance rule:** a change to a terrain feature must be mirrored in its `_d` twin (the probes catch drift).

**4.1 cost table** (full GPU occupancy, ns per sample; one Perlin octave ≈ 0.10):

| Term | ns | Term | ns |
|---|---|---|---|
| regional | 0.75 | ocean floor (coast/ocean only now) | 1.8 |
| mountains | 3.6 | erosion seeds | 0.8 |
| lone hills | 3.3 | river carve | 0.6 |
| meso1 / meso2 / meso3 / all | 0.56 / 1.06 / 0.69 / 1.3 | **height (plain)** | **8.1** |
| highlands | 1.3 | **height dual** / **height + stencil slope** | **19.3 / 40.2** |

Per-tile dispatches reach only ≈45 % of full-occupancy throughput (base pass 0.66 ms/tile measured vs 0.32 ms at full occupancy): batching several tiles per dispatch (B11) now has a measured case.

**Part B claim check** (code at `6c1e4d1`): G1, G2, G4, G6, G7, G9, W1–W5, P1, P4, E1, E2, E4, E5 confirmed. Corrections: G3 the ocean floor is no longer evaluated on full land (`6c1e4d1`), and the in-code meso comments (150 m, 8 km, ±6 m…) are stale; the plan's table is right. G4 the mountain and lone-hill domain warps are planar-only and are no-ops on the sphere. G5 now has `slopeMode`. G8 the split threshold is 512 px, not 514. E3/D2 (author's "gullies stop halfway") not re-checked against the blog.

**Terrain defects found (pre-existing, not fixed; visual changes need the owner):**
- `smoothMax` in terrainCommon is a smooth *min*, so mountain cores are clipped to foothill height (the `_d` twins mirror it bug-for-bug).
- Lone hills: hard gates leave vertical steps: rolling hills at `rollingPresence > 0.01` (500 m scale → up to ≈6 m, typically ≈2 m), tiers 4/5 at `presence > 0.001` (≈1–2 m). Erosion seeds jump ≈5 cm when the nearest seed changes. Fix: ramp the presence from the gate (`(p - gate) / (1 - gate)`).

**M2 / RuneVision (5.0–5.2), lab only:**
- 5.1 plane port matches a JS port of the GLSL to 2e-7; images reproduce the demo's dendritic gullies.
- 5.2 cube-face edge, 12 km and 40 km patches: (a) face charts + 3 km cross-fade show a smeared double-gully band ≈6 km wide; (b) 3-D lattice is seamless, a little curvier than 2-D; (b') `normalSquash` 2.5 restores the 2-D crispness without artifacts (8 tears holes where no cell reaches the surface).
- Cost, 5 octaves: (b) ≈ 11 ns/sample, (a) ≈ 2.2 ns per chart (×2 in the band). Meso1+2, which erosion would replace, cost ≈ 1.6 ns.
- On real terrain (face 0, u 0.48, v 0.245, 16 km): fed the full height's gradient, the gullies follow meso/ridge noise and the result is grainy chaos. Fed a low-passed slope (±400 m differences of the meso-free height) it gives convincing radial drainage. **Production needs a smooth landform gradient (H0) as the erosion input**, which is the plan's tier stack; the cheapest source is a `_d` evaluation of only the smooth terms.
- Go/no-go is the owner's (B12 M2). Net cost vs today's `stencil` base pass is still lower (≈ 19 dual + 11 erosion < 40), but higher than `analytic` alone.

## Session 2, continued (2026-10-04): owner decisions and what followed

Owner: analytic slope looks the same (speed not verified by eye), "fix" the smoothMax and lone-hill steps, **go** on RuneVision erosion. Owner will prune terrain features one by one; the old terrain compute stays for now. Owner's view: from orbit the planet looks like "a ball with warts".

| Commit | Change |
|---|---|
| `bcb8145` | `smoothMax` fixed (+ `smoothMaxLegacy`), lone-hill gates ramped; `terrain.fixes` toggles; `slopeMode` default `analytic`. Planet survey: land height distribution unchanged, largest rise 536 m (mountain ranges are rare on this planet). |
| `decc75c` | Erosion in the height function, **on by default** (`terrain.erosionFilter`). Erodes the large landforms only (regional base, mountains, meso3, highlands, lone-hill tiers 4/5); small domes, rolling hills, river carve and seed pits are added after. Strength from relief (summed large-landform height): 0 below 150 m, full from 600 m; filter skipped where 0. Replaces meso1/meso2, cuts, landmark detail. Normal pass now reads heightBase for border samples (across-edge neighbours of edge texels still evaluated, at the neighbour tile's own UV arithmetic, so shared-edge normals stay bit-identical; the base pass is a different module and rounds differently). Cost per depth-9 tile: +12 % plains, +22 % mountains; normal pass with erosion off 0.58 → 0.39 ms. |
| `3dd3f8d` | Feature toggles: `terrainFeatureToggles.js` table (20 terms), config `terrain.features`, runtime `qtDiag.setTerrainFeatures({...})` / `qtDiag.terrainFeatures()`; uniform `featureDisableMask` (was `_pad_i`). |

Observations for the pruning pass (120 km patch, face 0 u 0.53 v 0.5): the continental base is nearly flat; relief comes from isolated domes (lone-hill tiers 4/5 move up to 2.8 km) and highlands (1.2 km); mountains touch 0.2 % of the patch. A straight diagonal terrain edge exists at face 0 u≈0.55 v≈0.83 (visible before and after erosion), probably a cell boundary of a rarity/cell mask; not traced yet.

Lab scripts added (scratchpad `perf/`): `ab-erosion.mjs` (A/B patch renders), `fix-survey.mjs`, `feature-toggle-check.mjs`, `erosion-terrain.mjs`, `terrainlab.mjs` modes `dumpn` and `seams` (shared-edge normal agreement); env `LAB_TERRAIN_JSON`, `LAB_REGIONS`.

## Session 2, day 2 (2026-10-04): erosion made permanent

Owner: erosion level on mountains is good; erosion is permanent; remove the code that only ran without it; owner is collecting data on which features matter visually (feature toggles) and the dev server on port 8000 is theirs.

| Commit | Change |
|---|---|
| `60af80f` | Seams found by 1 m transect scans + toggle attribution: mountain gates (~25 m steps) and slope kinks in the erosion input (the filter turns a kink into a step of up to the gully depth, because its stripes follow the slope direction). Gates use `gateRamp` (C1); blends are C1; erosion reads a slope-continuous landform (`MountainHeightD.smoothed`) and its change is added to the full terrain. Erosion amount = variation (15 km noise) x relief ramp, light base amount everywhere; meso1/meso2 back on top, faded by amount. |
| `cb1aac6` | Low-amount erosion rounded (thin etched lines and star patterns on gentle terrain were sharp crease defaults at low strength). Foothills: 3 km hills over terrainType 0.45-0.56. |
| `9f7a62c` | Erosion-off code removed (enabled flag, stub, erosionFilter/loneHillCuts toggles, slope cuts, `terrain.fixes` legacy variants). |
| `2bc3445` | Hydrology precompute and erosion-seed verifier used face -1 (flat-world noise at unit-vector coordinates, not the planet) since `32c159a`; now face 0. Demo river now found (16-point path), 1 confirmed lake (was 9 on the wrong terrain). Plain height implementation deleted (single dual-number implementation); `slopeMode` removed. |
| `fa7f0a2` | heightBase apron (130^2): normal pass reads all border samples (0.97 -> 0.13 ms/tile); shared-edge normals exact. |

**Open question for the owner:** terrainType on land is p10 0.34 / p50 0.40 / p90 0.50; mountains need 0.55 (3.8 % of land) and are full only at 0.8 (no land). Mountains therefore never exceed ~20-30 % of their designed height. Remapping the mountain thresholds to the distribution (e.g. 0.48 -> 0.60) would give many more and taller mountains. Not done.

**Lab tools added:** `jump-scan.mjs` (1 m transects in eroded areas, jump attribution by toggles, input-slope check), `jump-profile.mjs`, `ab-erosion.mjs` (A_FEATURES/B_FEATURES), `tt-dist.mjs`, `hydro-run.mjs` (startup hydrology in Node), `hydro-compile.mjs`.

## Session 2, days 2–3 (2026-10-04): terrain look, owner-driven

The owner flew the terrain and reported defects one by one; each fix was found by a lab scan or variant, not by eye.

| Commit | Change |
|---|---|
| `6bbfe8f` | **Water graph prototype** (see "Next session: water"). |
| `f04aa6d` | Rolling hill chains: wider, lower corridors (were trench-like). |
| `b4b02b0` | Erosion: subtract the initial fade target's exact contribution (`initialFadeWeight`), not `magnitude·(1−mask)` (that over-cancelled: rings/moats around hilltops). |
| `7f5b345` | Gentler onset near flat ground (`rounding.z` 1.0, `onset.x` 0.9), strength 0.22: pinch points and hilltop rings. |
| `bb293ff` | Demo river off by default (`runtimeConfigs` `river.enabled: false`, `gameEngine` `demoRiverEnabled`). |
| `8c60fae` | Erosion amount x steepness (`sharpSlopeStart/Full` 0.05/0.45): bowties and pinches at summits/saddles where the gully direction spins. |
| `a153fa6` | Small domes (common/uncommon lone hills) fade with `(1 − relief ramp)²`: on mountains their flanks eroded while their flat tops did not, leaving sunken tops. |
| `b003c37`, `db06444` | Rounding: crease ≥ 0.1 (zero-width V creases alias on the tile grid), ridge 0.2+ (at 0.1 every spur carried a ~60 m raised cap: the owner's "spinal cord"). |
| `899c2a6` | `qtDiag.pickTerrainOnClick()` logs `faceUV=face,u,v`. These equal the lab's `getSpherePoint(face, u, v)` (checked on all faces). **Ask the owner to pick a spot instead of hunting for it.** |
| `dec5cc2` | **Mountain style by location**: noise field (40 km) from rounded to jagged sets erosion strength, octave ridge/crease rounding, mountain range shape (smooth vs ridged) and height. Config pairs `style*` in `terrainGenerationConfig.js`, `styleBias` −1/+1 forces either end. Land: 35 % rounded, 28 % mixed, 38 % jagged. New `ErosionParams.inputRounding` (first-octave onset decoupled from octave rounding). |
| `deed28a` | Creases from C1 breaks: the landmark's two-peak blend made C2 (quintic), Phacelle normalization `max` made smooth, per-octave rounding blend smooth. |

**Lessons (keep):**
- **The erosion input must be C2, not just C1.** The filter orients gullies along the input gradient; a curvature jump becomes a crease, a slope kink becomes a step. Gates/blends with large amplitude inside the erosion input need quintic (C2) ramps. Proven on the landmark ring seam; adding C2 to the lone-hill presence/irregularization gates showed no effect and was reverted.
- **Remaining small stuff:** `meso1` has its own kinks (exist with erosion off); centimetre jitter in strongly eroded jagged areas (≈2° normal wobble, likely f32 phase precision). Neither reported by the owner.
- **Mountain ranges are rare** (terrainType threshold, see the open question above). Most "mountains" the owner sees are big lone hills (landmark tier). The owner was asked whether to remap; no answer yet.

## Open: streaming catch-up after fast flight

Owner (2026-10-04): after ~100 km at low-medium altitude, tiles took long to refine and even geometry to load. Proposal made, **not approved or implemented yet**; check the conversation outcome with the owner. Facts found:
- Queue priority is static at enqueue: depth dominates (`100000 − depth·500`), visible +3000. Geometry entries not seen in feedback for 200 ms are dropped (depth ≥ 5).
- The long tail is refinement (≈17.5 ms GPU per tile at `e41950c`; HUD showed "refinement 192 pending / 1 active", resident p95 6.8 s).
- `GPUQuadtreeTerrain` already computes a speed LOD scale (`adaptiveLod`, up to 3x) but applies at most `visibleSelectionMaxScale` (1.0) to the visible traversal, by an earlier choice (pop while moving).
- `AsyncGenerationQueue.request()` sorts the whole queue on every request (R2, CPU cost in bursts).

## Water as handed over after session 2 (superseded by "Session 3: water" above)

**Requirement, verbatim from the owner:** "networks of lake-river-sea systems. Not all lakes connect to a river. All rivers connect to a lake at upstream and all connect to another lake or sea downstream. No dead ends."

**What exists (`6bbfe8f`, not wired into the game):**
- `core/world/hydrology/HydrologyGrid.js`: `sampleHydrologyGrid({ device, terrainGenerator, N = 512 })` evaluates the real height (2x2 supersampled, metres) and precipitation on a 6 x N² cube grid; reads `maxH` from uniform offset 184 and sea level from 116.
- `core/world/hydrology/waterGraph.js`: `buildWaterGraph({ N, heights, seaLevelM, precip, params })` → `{ lakes, rivers, lakeOf, parent, filled, Q, stats }`. Priority-flood (Barnes) from the ocean across cube-face neighbours; lakes = fill-depth components (`minLakeDepthM` 8, `minLakeCells` 12); rivers only from lake outlets to a lake or the sea (`minRiverQ` 400, Q = area x precipitation). Helpers `faceUVToDir`, `dirToFaceUV`, `cellDir`, `dirToCell`, `makeNeighbors`, `MinHeap`.
- `waterGraph.test.js`: 8 tests incl. the valley chain lake → river → lake → river → sea, no dead ends, determinism.
- Measured at `deed28a` (N = 512, Node lab): sample 0.86 s, build 0.66 s; 2061 lakes, 294 rivers (227 end in a lake, 67 in the sea); longest chain 7 lakes to the sea.
- Old prototypes P1–P4 (plan B4) still exist. `HydrologyPrecompute`/`ErosionSeedVerifier` were fixed to sample the real planet (`2bc3445`). Demo river is off; erosion seed pits (P2) are still on by default.

**Decisions waiting for the owner (asked, unanswered):**
1. Lake density: thresholds 8 m deep / 12 cells (≈ 512 m cells) give ~2000 lakes. More or fewer?
2. Order of the next steps (my proposal): (a) build at startup in a worker + IndexedDB cache (plan 6.3); (b) debug tint view of lakes/rivers (6.3); (c) static lakes + lake-bed shaping (7.1, 7.2, 7.4); (d) rivers (6.5, 7.5); simulation (Phase 8) after.
3. Whether erosion-seed pits (P2) and the old lake system go away once static lakes exist.

**How to begin:**
1. Read this section, then plan Part B sections B4 (P1–P4), B5 (design), B8–B10 (Phases 6–8). The tier stack in B5 is not built; the hydrology input today is the full eroded height.
2. Get the owner's answers to the three decisions.
3. Re-run the graph in the lab (`terrain-lab/water-graph-run.mjs`) to see current numbers and the map.
4. Implement in small flag-guarded steps, each verified in the lab first.

## Working agreements with the owner

These come from previous sessions and the owner's explicit instructions:

- **The owner's observations are ground truth.** They test thoroughly before reporting. Don't re-argue a report; find the cause.
- **State confidence out loud before implementing.**
  - For rendering or performance problems you can't observe, isolate the cause first: debug modes, A/B toggles, measurement.
  - After one miss, don't ship a second unverified guess.
- **Treat older agent docs and AI reviews (ChatGPT) as leads, not facts.**
  - Verify them against the code.
  - Check which commit they looked at: the ChatGPT reviews saw `origin` at `e41950c`.
  - Old `*_ANALYSIS.md` / `*_FINDINGS.md` files are outdated. `TILE_SEAM_FLICKER_LOADING_EVIDENCE.md` is the exception: real measurements, but from `e41950c`.
- **Ask before headless runs.** End them on `about:blank`. Compute-only Node lab runs (`terrain-lab/`) are pre-approved. The owner tests in their own browser.
- **Commits (session 2 agreement):** commit each completed, verified step. **Review each file's diff before staging**; the owner edits the working tree at the same time (a whole-file `git add` once swept their edit into a commit). Never stage the owner's `prompt.txt` deletion; never commit `IMPLEMENTATION_PLAN*.md`. Push only when asked (`git -c http.postBuffer=524288000 push` if HTTPS hangs up on large packs).
- **Dev server:** the owner serves the app at `localhost:8181`. Port 8000 is theirs for something else; don't start servers there.
- **Keep changes config-driven** (`wizard_game/runtimeConfigs.js`, `core/EngineConfig.js`).
- **WGSL:** no `?:`; use `select()` (see `AGENTS.md`).
- **The shuffle fix and the LOD4/5 blend must stay intact.** Check with the flash tracker and debug modes 90/104.

## Decision log

1. **Order of work** is the owner's: regressions → tile loading and generation → renderer → tiered noise and RuneVision erosion. Water joins during that last stage.
2. **The regression window is the last 1–3 commits.** Steady state went from 50–80+ FPS to single digits (the owner's report).
   - That moved the lead suspects to R0, R0b and R9.
   - It demoted R1 (the `e41950c` retry scan), which ChatGPT and revision 1 had blamed.
3. **R0 history, corrected in revision 2:**
   - LOD5 became the solid tier in `33de8b1`, not `6794716`.
   - LOD5 already paid the 64-sample flat-colour cost at `e41950c`, through its old fade.
   - `6794716` added the LOD0–4 distance fade (≈ 5–7.8 km).
   - `82dcf94` added flat drawing of unrefined tiles.
   - `a96731a` baked the flat colour, which should be active, but unverified.
4. **RuneVision gullies don't form connected drainage** (the author says so). River and lake topology therefore comes from a separate hydrology pass, not from the erosion filter.
5. **External review of revision 2:**
   - **Adopted in revision 3:**
     - **Material completeness:** "adequate material source" replaces "own material for every tile".
     - **Adaptive generation budget:** GPU-ms based, `target − measured non-generation − margin`.
     - **Heap queue:** only if measurement shows it matters.
     - **LOD continuity:** multi-signal checks instead of a one-pixel height bound.
     - **Stable slope:** kept until an A/B approves a replacement.
     - **Lattice:** limited to smooth low-frequency terms.
     - **RuneVision:** a cost/benefit benchmark (5.0), and a standalone cube-sphere research prototype with no assumed cost.
     - **Terrain tier stack:** H0–H4, plus H_simBed for the water bed.
     - **Carving:** topology-preserving, checked with a re-routing test.
     - **Water graph build:** asynchronous; must not block terrain.
     - **Graph cache:** a stronger cache key.
     - **Per-tile corridor lists**, so tiles without water pay nothing.
     - **Old prototypes:** kept until a parity suite passes.
     - **Simulation sites:** camera-centred, with an optional flow axis.
     - **State persistence:** version 1 only.
     - **Sim cost:** measured, not assumed.
     - **Data model:** WaterGraph / WaterGeometry / WaterSimulation as separate objects.
     - **Discharge:** called Q_proxy.
     - **Ordering:** the revised milestone order, with the hydrology prototype early.
   - **Adopted with my additions:**
     - **Material criterion → skip rule (2.3).** LOD4 tiles lying entirely beyond the fade end don't need their own material. After the flat mix, material only feeds AO, and AO is off above LOD3. This claim still needs verifying. If it holds, a whole class of 17.5 ms refinements disappears.
     - **LOD continuity mechanism.** The review only said "morph". The plan specifies nested octave sets, plus morphing toward the parent layer at edges shared with a coarser neighbour and with camera distance in the interior. The coarser-neighbour mask already exists in the instance data.
     - **H_simBed without micro detail.** The visual terrain must also drop micro detail inside wetted areas, otherwise visual shorelines and simulated ones disagree.
     - **Asynchronous graph.** Tiles whose corridor list is non-empty get regenerated once the graph lands.
   - **Rejected:** nothing outright.

## Facts not worth rediscovering

- **LOD numbering.** LOD = 11 − depth. LOD0 = 128 m tiles with ~1 m texels. The solid (flat-colour) tier is LOD5+. On the owner's 1800 px-tall canvas (Retina, 2880×1800), LOD4 spans about 4.7–9.3 km.
- **`[QTLight] started=` is always 0,** because `AsyncGenerationQueue.tick()` returns nothing. Use `commits=` and the refinement queue line instead.
- **Headless:** Puppeteer's bundled Chrome 131 can't render the app; use the system Chrome. Read visible tiles from `tileStreamer._lastVisibleTilesList`.
- **Measured at `e41950c`** (2026-10-02, headless, shared GPU):
  - GPU cost per tile: geometry 4.9 ms, refinement 17.5 ms.
  - Cold 40 km jump: everything settled in 15–26 s.
  - Stationary: zero evictions, zero tile changes.
- **The walking-skeleton river sim** (`features.rivers: true`) runs every frame. Count it in GPU budgets.
- **Persistent memory may be missing.** Claude's memory notes live under the directory a session starts in (`proj/` so far). If the next session starts in `spherecraft/` instead, those notes won't load, which is why the essentials are repeated here.
- **Terrain lab** (`proj/terrain-lab/`, outside git; `node_modules` included): Node + Dawn (`webgpu` npm) running the real generator. Every script takes the spherecraft root as its first argument (a `git archive` export works for A/B against a commit). Keep the GPU instance reachable (`labsetup.mjs` does) or Dawn segfaults. Main scripts:
  - `water-graph-run.mjs <root> [N] [paramsJSON]`, `water-sweep.mjs`: water graph stats + map PNG in `out/`.
  - `hydro-run.mjs`: the startup hydrology (old prototypes) as `gameEngine` runs it.
  - `ab-erosion.mjs`, `shader-variants.mjs` (`VARIANTS` JSON of shader-text replacements and erosion overrides), `persp-variants.mjs` (low-angle perspective views): visual A/B.
  - `jump-scan.mjs` (height steps), `kink-scan.mjs` / `kink-transect.mjs` (slope kinks, attribution by feature toggles), `sunken-scan.mjs`: defect scans.
  - `terrainlab.mjs <root> bench 7 24 height`: GPU ms per tile.
  - `faceuv-check.mjs`: picker face/u/v = generator face/u/v.
