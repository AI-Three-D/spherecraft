# SphereCraft implementation plan

This file holds two self-contained parts, meant for different agents and batches:

- **Part A: performance regressions, tile streaming, renderer (Phases 0–3).** Verify first, then implement.
- **Part B: tiered terrain, RuneVision erosion, lakes and rivers (Phases 4–8).** A later batch.

To split the file, cut at the `✂ PART B` marker. Neither part relies on the other's text: shared context is repeated in each.

Written 2026-10-03 against `spherecraft`, branch `codex-restart`, local HEAD `a96731a`. Line numbers refer to that commit.

Revision 3 adds amendments from an external review of revision 2. The decision log is in `IMPLEMENTATION_PLAN_SUPPLEMENT.md`.

<!-- ✂ ═══════════════════════════ PART A ═══════════════════════════ -->

# Part A: performance regressions, tile streaming and renderer (Phases 0–3)

## A0. Briefing

**Task, in order**

1. **Verify.** Check every numbered claim in A2–A4 against the code at `a96731a`. Spot-check the factual statements inside the increments (A6–A9) too. This document comes from reading code; almost none of it has been run.
2. **Report before changing any code.** For each claim ID, give:
   - a verdict: Confirmed / Partly / Refuted / Needs a runtime check;
   - the evidence: file:line, or a measurement;
   - a corrected statement where needed.

   Also list anything important that is missing, and propose a new order for the increments if the evidence calls for one. Report table format:

   | ID | Verdict | Evidence | Correction |
   |---|---|---|---|
3. **Implement** the increments in order after the owner approves the verified plan.

Temporary instrumentation for verification is fine in a separate `git worktree` or scratch branch. Remove it afterwards.

**Ground truth.** The owner's observations (A1) outrank this document, older documents and earlier AI reviews.

**Repository state**

- Repo `spherecraft/`, branch `codex-restart`, HEAD `a96731a` (2026-10-03).
- The five newest commits exist only locally; `origin/codex-restart` is still `e41950c`:
  - `075b08c` docs
  - `33de8b1` blending
  - `6794716` terrain detail optimizations
  - `82dcf94` flicker fix
  - `a96731a` terrain compute work
- `AGENTS.md` maps the code. `CLAUDE.md` is an outdated task prompt; ignore it.
- The older `*_ANALYSIS.md` / `*_FINDINGS.md` work logs are outdated. One exception: `TILE_SEAM_FLICKER_LOADING_EVIDENCE.md` has runtime measurements from 2026-10-02 at `e41950c` and reusable console snippets: §6.2 (flash tracker) and §6.3 (GPU cost per tile). Its numbers describe `e41950c`, not HEAD.

**Running the app**

- **Start:** `python3 server.py` in the repo root, then open `http://localhost:8000/wizard_game/standalone.html`.
- **Console handles:**
  - `gameEngine`
  - `window.qtDiag` (`qtDiag.setTerrainDebugMode(n)`, 0 = normal)
  - streamer: `gameEngine.renderer.quadtreeTileManager.tileStreamer`
  - terrain renderer: `gameEngine.renderer.quadtreeTerrainRenderer`. Run `await …rebuildMaterials()` after editing `gameEngine.engineConfig.rendering.terrainShader.*`.
- **Quiet logs:** `(await import('/shared/Logger.js')).Logger.setLevel(2)`.
- **Tests:** `npm test` (vitest). **Lint:** `npm run lint`.
- **Headless:**
  - Use puppeteer-core with the system Chrome: `executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`, `headless: "new"`, args `--enable-unsafe-webgpu`.
  - Viewport 1440×900 at `deviceScaleFactor: 2`, matching the owner's 2880×1800 canvas.
  - Puppeteer's bundled Chrome 131 cannot render this app.
  - Camera: `gameEngine.toggleCameraMode()` to manual, then set `gameEngine.camera.position/target/up` from a `requestAnimationFrame` loop.
  - Read visible tiles from `tileStreamer._lastVisibleTilesList`. Calling `readVisibleTiles()` collides with the engine's own staging buffer.
  - Navigate to `about:blank` when done.
- **Headless runs share the owner's GPU and disturb the owner's own session. Ask the owner before running them.**

**Rules for implementation**

1. **Measure before fixing.** Fix a suspect once its test shows it matters, unless the fix is trivial and safe.
2. **One increment ≈ one commit.** Anything that changes behaviour goes behind a config flag. Log before/after numbers from the same scenario in A10.
3. **Phases 0–3 must not change the image.** Check with fixed-camera screenshot diffs (0.2).
4. **Keep the two recent fixes.**
   - Material comes only from a layer flagged material-complete (own or ancestor). The flag is raised only after the copy that completes the material has been submitted ([`_markMaterialCompleteForFlushedCopies`](core/world/quadtree/tileStreamer.js#L1384)).
   - The LOD4→LOD5 colour ramp (distance fade + edge safety net) and the baked `coarseColor` stay.
   - After any change to streaming, the instance builder or the terrain shader:
     - re-check debug modes 90 (LOD) and 104 (tier blend) on the fixed cameras;
     - run the flash tracker (evidence doc §6.2) while flying. It must report zero flashes.
5. **Healthy streaming means every visible tile has an adequate material source.** That source may be the tile's own material or a finished ancestor's. A tile does not need its own material when that material would not change any pixel (2.3).

## A1. What the owner reports (2026-10-03)

- **Steady-state FPS dropped.** It was 50–80+ before the last 1–3 commits. It is now often single digits or low double digits, even once tiles look stable.
- **Tile loading got slower.**
- **Fixed, and must stay fixed:**
  - **Shuffling** (fixed by `82dcf94`): a tile with high-res material briefly showed lower-res material, then high-res again.
  - **LOD4/LOD5 seam** (fixed by `33de8b1` and `6794716`): a visible seam between the two LODs' materials.

## A2. How the pipeline works at HEAD (claims F1–F8)

**F1. Frame loop.** [`QuadtreeTileManager.update`](core/world/quadtree/GPUQuadtreeTerrain.js#L698) runs, in order:
1. `tickFlush`: flushes up to 8 pending layer copies, regenerates mips, raises material-complete flags, and uploads dirty hash slots.
2. `tickGeneration`:
   - admits geometry jobs while fewer than 8 GPU fences are in flight (plus 1 urgent slot);
   - then `_tickRefinement` runs two retry scans and admits up to 4 refinements per frame with the leftover fence headroom.
3. Predictive streaming.
4. Uniforms.
5. GPU traversal.
6. Instance builder.
7. Feedback readback initiation.

**F2. Refinement can be skipped entirely.** When geometry has zero fence budget, `tickGeneration` returns before `_tickRefinement` runs ([tileStreamer.js:1446](core/world/quadtree/tileStreamer.js#L1446)).

**F3. The spawn count is lost.**
- `AsyncGenerationQueue.tick()` ([asyncGenerationQueue.js:105](core/world/asyncGenerationQueue.js#L105)) has no return statement, so `spawned` at [tileStreamer.js:1457](core/world/quadtree/tileStreamer.js#L1457) is always 0.
- As a result, `[QTLight] started=` always reads 0.
- Refinement's budget never subtracts the geometry jobs started in the same frame.

**F4. GPU passes.**
- The traversal ([QuadtreeGPU.js:559](core/world/quadtree/QuadtreeGPU.js#L559)) and the instance builder ([:631](core/world/quadtree/QuadtreeGPU.js#L631)) each run as a single workgroup.
- The instance builder takes geometry from the nearest resident layer and material from the nearest material-complete layer ([instanceBufferBuilder.wgsl.js:245](core/world/quadtree/instanceBufferBuilder.wgsl.js#L245)).
- It fills one indirect draw per LOD and a feedback list of missing tiles.

**F5. Readbacks.**
- Feedback is read back every frame and feeds `_queueTile`.
- The visible list is read back every second frame and feeds [`markTilesVisible`](core/world/quadtree/tileStreamer.js#L2476): protection, LRU and demand state.

**F6. Planet and pool.**
- Radius 131,072 m, max quadtree depth 11, LOD = 11 − depth.
- LOD0 is a 128 m tile with ~1 m texels. LOD6 is depth 5: 8 km tiles with ~64 m texels. Tiles are 128×128 texels.
- With `features.streamedAssets: false`, the pool holds 2048 layers × 8 types = 29 B/texel, about 1 GB. The types are height, normal, tile, splatData, splatIndex, splatValid, resolvedColor and coarseColor.

**F7. Jobs.**
- **Geometry job:**
  - base height plus a 4-tap "stable slope", i.e. 5 full `calculateTerrainHeight` evaluations per texel ([advancedTerrainCompute.wgsl.js:976–1030](core/world/shaders/webgpu/advancedTerrainCompute.wgsl.js#L976));
  - tile ids;
  - micro height;
  - normal;
  - coarse-colour bake.
- **Refinement job** (detail LODs 0–4 only):
  - the padded splat chain ([webgpuTerrainGeneratorBatching.js:424](core/world/terrain-generator/webgpuTerrainGeneratorBatching.js#L424)):
    - padded base height computed once, another 5 evaluations per texel over 136² ([:649](core/world/terrain-generator/webgpuTerrainGeneratorBatching.js#L649));
    - padded tile ids;
    - two smooth-splat passes;
    - palette, splat, validity;
  - then resolved colour.
- Since `a96731a`, refinement copies the resident height and tile-id layers instead of recomputing them.
- Solid-tier tiles (LOD5+) skip refinement.

**F8. Throughput depends on FPS.** Admission is counted per frame: 16 geometry starts (capped by fences) and 4 refinements. When FPS falls, loading throughput falls with it, refinement most of all.

## A3. Regression suspects (claims R0–R9; none measured at HEAD)

### Steady-state suspects inside the owner's window

**R0. The flat solid-tier colour now runs on far more pixels.**
- **Per-pixel cost.** In its legacy form, `sampleChunkAverageCoarseColor` ([fragment shader :1434](core/renderer/terrain/shaders/webgpu/terrainChunkFragmentShaderBuilder.js#L1434)) costs, per pixel:
  - 64 tile-id loads;
  - 64 sin-hash jitters;
  - 64 category-colour lookups.
- **History:**
  - `e41950c`: it ran on LOD6 (the solid tier) and on every LOD5 pixel, through LOD5's old 3–6 km fade. LOD5 starts at about 6.5 km on a 1800 px canvas, so that fade was always fully on.
  - `33de8b1`: LOD5 became the solid tier (`solidColorStartLod` 6 → 5). The old LOD5 fade was replaced by an in-tile ramp over half of each LOD4 tile that borders LOD5.
  - `6794716`: added a distance fade into the solid tier, compiled into every LOD0–4 shader. It starts at about 5.0 km and is fully on at about 7.8 km on a 1800 px canvas ([`_computeTierFadeDistances`](core/renderer/terrain/QuadtreeTerrainRenderer.js#L390)). Every LOD0–4 pixel beyond about 5 km therefore pays the cost. The edge ramp narrowed to 15 %.
  - `82dcf94`: every detail tile without finished material is drawn fully flat through the same function.
- **Where:**
  - solid tier: [:3775](core/renderer/terrain/shaders/webgpu/terrainChunkFragmentShaderBuilder.js#L3775);
  - fade, edge net and incomplete source: [:4466–4477](core/renderer/terrain/shaders/webgpu/terrainChunkFragmentShaderBuilder.js#L4466).
- **Mitigation in `a96731a`.** It swaps the average for one sample of a baked `coarseColor` texture when `USE_COARSE_COLOR_TEXTURE` is set. From the code, this should hold at HEAD:
  - tile categories reach `QuadtreeTileManager`;
  - the pool gets a `coarseColor` type;
  - the material builder sees `_isArray`.
- **Confidence.** High that `6794716` and `82dcf94` made this a large GPU cost. Unknown whether HEAD still pays it. If the bake is active and FPS is still low, R0 is not the whole story.
- **Verify:**
  - statically, `enableCoarseColor` in `GPUQuadtreeTerrain.js` and `hasCoarseColorTexture` in `terrainMaterialBuilder.js`;
  - at runtime, 0.0b steps 2–3.

**R0b. Detail material is computed, then thrown away.**
- Where the flat weight is 1 (beyond the fade end, or no finished material), the shader still runs the whole splat and micro-texture path. It then replaces the result with `mix(…, 1.0)` ([:4466–4477](core/renderer/terrain/shaders/webgpu/terrainChunkFragmentShaderBuilder.js#L4466)).
- **Related claim, to verify.** After that mix, the tile's material is read again only in the terrain-AO block. Since `a96731a`, AO is off for LOD > 3 (`terrainAO.maxLod`). So refining a LOD4 tile that lies entirely beyond the fade end changes no pixels (2.3).
- **Since:** `6794716`, `82dcf94`.
- **Confidence:** medium-high that the waste is real; its size is unknown.
- **Verify:** read the order of operations in `main()`, then measure with an early-out (1.0b).

**R9. The GPU may still be draining refinement after the image looks finished.**
- Since `82dcf94`, an unrefined detail tile draws the flat colour instead of flickering. The view therefore looks stable while refinements are still queued, at 17.5 ms of GPU time each at `e41950c` (evidence doc §4.1).
- F2, F3 and F8 make draining slow at low FPS, and the backlog keeps FPS low.
- Eviction churn is not the suspect: the 2026-10-02 runs measured zero evictions, and no tile changed while stationary.
- **Confidence:** medium.
- **Verify:** 0.0b step 1.

### Older or streaming-only suspects

**R1. Refinement retry scan** (since `e41950c`).
- Every frame with GPU headroom, including while standing still, each entry of `_refinementVisibleDropRetryMap` calls `_describeTileDemandState` ([tileStreamer.js:2413](core/world/quadtree/tileStreamer.js#L2413), [:2824](core/world/quadtree/tileStreamer.js#L2824)).
- That function walks the whole visible list with an ancestor walk and builds string keys. Entries stay until the tile is visible again or evicted.
- **Cost:** O(entries × visible × depth) per frame.
- **Confidence:** high on the cost shape. Low that it explains the owner's drop, because it predates the window.
- **Verify:** `[QTLight] visibleDropRetryMap=` gives the map size; kill switch 0.1.

**R2. Queue sorting.**
- `AsyncGenerationQueue.request` re-sorts the whole array (up to 1024 entries):
  - on every new request ([:70](core/world/asyncGenerationQueue.js#L70), since the first commit);
  - on every priority promotion ([:37](core/world/asyncGenerationQueue.js#L37), since `9a5267c`).
- The `shouldDrop` callback re-parses every queued key string on each tick ([tileStreamer.js:905](core/world/quadtree/tileStreamer.js#L905)).
- Matters while moving. Low as a regression cause.

**R3. Eviction diagnostics.**
- `_evictTile` ([:1939](core/world/quadtree/tileStreamer.js#L1939)) does diagnostic work on every eviction:
  - scans the visible list with ancestor walks;
  - scans all resident tiles for an age spread;
  - splits key strings;
  - calls `Logger.warn` with no rate limit.
- `_selectEvictionCandidate` ([:2462](core/world/quadtree/tileStreamer.js#L2462)) iterates a Map with string-Set lookups.
- Runs on every commit once the pool is full. Old code.

**R4. String churn in `markTilesVisible`** ([:2476](core/world/quadtree/tileStreamer.js#L2476)).
- On every readback it does three passes that build string keys for each visible tile and its ancestors.
- It also copies a Set, scans all resident tiles for "D3" stats, and logs at INFO.
- Old code. The cost is GC pressure.

**R5. Generation GPU load.**
- Admission counts fences, not milliseconds (F1).
- Measured at `e41950c` with a batch-slope method under render load (evidence doc §4.1): geometry 4.9 ms and refinement 17.5 ms per tile, of which about 12 ms is the splat step.
- HEAD should be lower after `a96731a`. Verify with the evidence doc's §6.3 snippet.

**R6. Loading looks slower, partly by design** (since `82dcf94`).
- Until a tile's own refinement copy flushes, it shows its nearest refined ancestor's material.
- With no refined ancestor it shows the flat colour, which is the usual case for LOD4 because its ancestors are solid-tier.
- **Verify:** metric 0.4.

**R8. Serial instance builder.**
- One thread inserts every visible tile into the visible hash ([instanceBufferBuilder.wgsl.js:451](core/world/quadtree/instanceBufferBuilder.wgsl.js#L451)).
- `82dcf94` added a material walk per tile.
- **Verify:** GPU timestamp (0.3).

**Also always on:**
- Log level INFO ([runtimeConfigs.js:64](wizard_game/runtimeConfigs.js#L64)).
- A `[QT-Traverse]` log every 120 frames that triggers a GPU readback.
- The walking-skeleton river sim: 128², 2 substeps × 3 passes per frame, `features.rivers: true`.
- A reachable `discard` in the production terrain fragment shader ([:4323](core/renderer/terrain/shaders/webgpu/terrainChunkFragmentShaderBuilder.js#L4323), present since the first commit). On Apple GPUs it disables hidden-surface removal for the whole pipeline.

**Most likely, given the owner's report:**
- **Steady state:** R0 + R0b, or R9.
- **Loading:** FPS-bound admission (F8) plus R6.

## A4. Earlier AI review, claim by claim (C1–C25)

The review is `../chatgpt-review.md`, written against `e41950c`. The verdicts are my check at HEAD; re-verify them.

| ID | Review claim | Verdict | Note |
|---|---|---|---|
| C1 | Retry healing costs retries × visible × ancestors | Confirmed | Same as R1; it predates the owner's window. |
| C2 | Geometry is recomputed during refinement | Partly stale | `a96731a` copies resident height/tile ids for the inner passes. The splat chain still recomputes the padded base height (2.4). |
| C3 | Geometry commits zero-fill all material types | Confirmed, small | 4–6 copies of 64 KB per commit. Probably redundant since `82dcf94` (2.7). |
| C4 | Geometry commits trigger mip generation for material textures | Partly wrong | Material types are never mipped. Normals are re-mipped even on refinement-only copies (2.6). |
| C5 | Layer release scans the pending-copy queue | Confirmed, minor | Bounded by the pending-copy count. R3 costs more. |
| C6 | Refinement should read geometry through single-layer views, not copies | Agree | `a96731a` copies into scratch textures (2.5). |
| C7 | The 64-sample coarse-colour path only matters in debug mode 99 | True at `e41950c`, wrong after | See R0. |
| C8 | Typed arrays and integer tile IDs | Confirmed need | String keys in every hot path (1.5). |
| C9 | Adaptive ms budgets | Adopt | Needs 0.3 (2.1–2.2). |
| C10 | Geometry-first backpressure, priority classes | Partly exists | Make explicit (2.2–2.3). |
| C11 | Layer epochs | Low priority | |
| C12 | Parent material fallback | Already done | `82dcf94` |
| C13 | Partial material stages | Not needed now | |
| C14 | Screen-space-error LOD | Already done | [quadtreeTraversal.wgsl.js:251](core/world/quadtree/quadtreeTraversal.wgsl.js#L251) compares tileSize·lodFactor/distance against 514. It ignores roughness (3.8). |
| C15 | LOD hysteresis | Partial | The 4-px quantization is mathematically a fixed threshold (evidence doc §3.3). |
| C16 | GPU-driven visibility, traversal, indirect draws | Already done | The real problem is single-workgroup passes (3.3–3.4). |
| C17 | Velocity-aware streaming | Exists | Throttle instead (1.8). |
| C18 | Fewer readbacks | Minor | Feedback copies the full 64 KB every frame. The visible list takes two round trips (2.9). |
| C19 | R16F far heights | Reject | f16 resolution near the top of the normalised range is ≈ 0.001, about 5 m at the 5000 m scale. |
| C20 | Type-specific mips | Confirmed, small | 2.6 |
| C21 | Strip debug paths from hot shaders | Confirmed | About 100 runtime `debugMode` branches in the production terrain fragment shader (3.2). |
| C22 | Batched multi-tile compute | Unproven | Pool resources first (2.5). |
| C23 | Teleport bootstrap | Partly exists | `prewarmWorldPosition` |
| C24 | Stress harness, A/B flags, CPU scheduler benchmark | Adopt | Phase 0; vitest in 1.2 and 1.5. |
| C25 | Perf HUD, queue-age histograms | Partly exists | `[QTLight]` already has p50/p95/p99 stage latencies. GPU times and material latency are missing (0.3, 0.4). |

## A5. Targets (proposal; owner to confirm)

| Scenario | Target |
|---|---|
| Idle (S1, S2) | First back to 50–80+ FPS (the `33de8b1` level), then p95 frame ≤ 10 ms. |
| Streaming at 150 m/s (S3) | p95 frame ≤ 16.7 ms, with generation inside its GPU budget. |
| Fast flight, teleport (S4, S5) | p99 ≤ 33 ms, and no frame over 100 ms. |
| Tile latency | Visible geometry p95 ≤ 300 ms in S3. Material that affects pixels, for near visible tiles: p95 ≤ 1.5 s. |
| Terrain CPU per frame | p95 ≤ 1 ms in S3. |

## A6. Phase 0: measure and attribute

**0.0 Housekeeping (tiny).**
- Replace `CLAUDE.md`, an old flicker-diagnosis prompt that every new Claude session loads as instructions. Its replacement is a short pointer to `AGENTS.md`, this plan, how to run the app, and the rules in A0.
- Ask the owner before moving the outdated analysis `.md` files to `docs/archive/`.

**0.0b Runtime triage, no code changes.** Run at HEAD, standing still at a view that is slow. The owner can do this in two minutes; the agent can do it headless with the owner's go-ahead.
1. **Background work (R9, R1).** Watch `[QTLight]` for about 10 s.
   - When the view is truly idle, `commits=`, the refinement `queueDepth=`/`queueActive=` line and `gpuInFlight=` should all reach 0.
   - Ignore `started=` (F3).
   - `visibleDropRetryMap=` is R1's map size.
2. **Bake active (R0).** `gameEngine.renderer.quadtreeTerrainRenderer._materials.get(4)?.defines?.USE_COARSE_COLOR_TEXTURE` should be `true`.
3. **Shader A/B (R0, R0b):**
   ```js
   const ts = gameEngine.engineConfig.rendering.terrainShader;
   ts.solidColorTierDistanceFadeEnabled = false;
   ts.solidColorTierEdgeBlendEnabled = false;
   await gameEngine.renderer.quadtreeTerrainRenderer.rebuildMaterials();
   // compare FPS; then force the old 64-sample path to see its cost:
   ts.solidColorBakedTexture = false;
   await gameEngine.renderer.quadtreeTerrainRenderer.rebuildMaterials();
   ```
4. **CPU or GPU?** Record 5 s in the DevTools Performance panel. A mostly idle main thread with long frames means the GPU is the bottleneck.

The four results decide whether Phase 1 starts with 1.0 (steady-state shader and refinement work) or 1.1 (CPU).

**0.1 Kill switches and a CPU phase timer.**
- Add `gpuQuadtree.streamerFlags`, with every default matching current behaviour:
  - `retryVisibleScan`
  - `queuePromoteSort`
  - `evictDiagnostics`
  - `visibilityDiagnostics`
  - `predictiveStreaming`
  - `hotPathLogging`
- Toggle them at runtime with `qtDiag.setStreamerFlags({...})`.
- Accumulate `performance.now()` per phase:
  - `tickFlush`
  - `tickGeneration`
  - each retry scan
  - the refinement tick
  - feedback processing
  - `markTilesVisible`
  - predictive streaming
- Show p50/p95 in the HUD and in `[QTLight]`.
- **Done when:** each flag's effect on CPU ms and FPS is visible in one stationary scene and one moving scene.

**0.2 Headless perf harness with fixed cameras.**
- Build `tools/perf/run.mjs` (puppeteer-core) with the recipe in A0, plus the flags `--enable-webgpu-developer-features --disable-gpu-vsync --disable-frame-rate-limit`.
- Scenarios:
  - **S1** stationary at 4 km, facing the LOD4/5 band
  - **S2** ground level near spawn
  - **S3** 150 m/s at 400 m for 60 s
  - **S4** 600 m/s for 30 s
  - **S5** teleport 40 km, then settle for 20 s
  - **S6** high altitude
- Output JSON per commit and scenario to `tools/perf/results/`: frame times, phase ms, GPU ms, tile counters and latency percentiles.
- Save PNGs at fixed frames for `tools/perf/diff.mjs`.
- **Done when:** two runs of the same commit agree within ±5 % on p50 frame time. The owner's own browser runs stay the ground truth.

**0.3 GPU timestamps.**
- Request `timestamp-query` when the adapter offers it.
- Add a `GpuTimer` that attaches `timestampWrites` to named passes:
  - traversal and instance build;
  - terrain, ocean, clouds, sky/atmosphere, fog particles;
  - river sim;
  - tile copies + mips;
  - generation submits: geometry, refinement, coarse bake.
- Resolve into a ring of readback buffers so it never stalls. Chrome quantizes timestamps unless `--enable-webgpu-developer-features` is set.
- **Done when:** per-pass sums roughly match the frame's GPU time.

**0.4 Material latency and coverage.**
- Stamp the moment a tile's material-complete flag is raised, giving request → own-material p50/p95 per depth.
- In the instance builder, count visible tiles drawn with ancestor material, and how many levels up that material comes from (atomics in `metaData`).
- Also count visible tiles whose own material would change pixels but is missing. That needs the per-tile flat-weight range from 2.3.
- Show these in `[QTLight]` and the HUD.

**0.5 Bisect.**
- **First:** steady-state S1 and S2 on `33de8b1` → `6794716` → `82dcf94` → `a96731a`, one `git worktree` each. `33de8b1` is the last good state per the owner. Add `075b08c` if `33de8b1` is already slow.
- **Then:** S3 and S5 on those commits plus `e41950c~1`, `e41950c`, `9a5267c~1` and `9a5267c`, for the streaming costs.
- Commits without the 0.1–0.4 tools record only frame time and the existing `[QTLight]` lines.

**0.6 Baseline and reorder.**
- Record HEAD numbers in A10.
- Mark R0–R9 confirmed or refuted.
- Reorder Phase 1 by measured impact.

## A7. Phase 1: fix the regressions

1.0 targets the owner's steady-state drop. 1.1 onwards are CPU costs, mostly older. 0.0b and 0.6 may change the order.

**1.0 Steady-state frame cost (R0, R0b, R9).** Do the sub-steps that 0.0b points to.
- **(a) R0.** Make the baked `coarseColor` sample the only production path for the flat colour. The 64-sample legacy average moves to a debug variant.
- **(b) R0b.** Compute the flat-tier weight (distance fade, edge net, incomplete source) before the detail material.
  - Where the weight is ≥ 0.999, skip splat and micro-texture sampling and use the flat colour directly.
  - Lighting, AO and fog still run.
  - Flag: `terrainShader.flatEarlyOut`.
- **(c) R9.** When the view is stationary, refinement should drain quickly and then stop:
  - admit refinement even in frames where geometry has no fence budget (F2);
  - make `AsyncGenerationQueue.tick()` return its spawn count (F3);
  - skip refinement for tiles whose material changes no pixels (2.3, first part).

  The full fix comes with millisecond budgets in 2.2.
- **(d)** If FPS is still low after (a)–(c), run the bisect (0.5) and decide from data.
- **Done when:**
  - steady-state frame time is at or below the `33de8b1` level;
  - the image diff is unchanged for (a) and (b);
  - the flash tracker still reports zero flashes.

**1.1 Visibility-driven refinement healing (R1).**
- **Ancestor set.** Once per visibility readback, build an integer-keyed set of tiles that are visible or ancestors of a visible tile. Each visible tile walks up its ancestors and stops at the first one already in the set, so this is O(visible).
- **Demand check.** `_describeTileDemandState` becomes O(depth): visible? ancestor (one set lookup)? descendant (walk its own ancestors)?
- **Replace the retry map.** Remove `_refinementVisibleDropRetryMap` and its per-frame scan. Instead, at each readback, queue refinement (capped per readback) for tiles that are all of:
  - newly visible;
  - resident and in state `RESIDENT`;
  - not already queued;
  - in need of material (2.3).

  The queue-full retry (`_retryDroppedRefinements`) can fold into the same check.
- Flag: `streamerFlags.eventRetry`.
- **Done when:**
  - this work costs under 0.05 ms per frame;
  - after 30 s stationary in S1, no visible tile is starved: every tile whose own material would change pixels has it, measured with 0.4;
  - no refinement keeps running for tiles whose current material source is already sufficient. Not every tile needs its own material.

**1.2 Generation queue (R2). Measurement-gated.**
- **Always:** `tick()` returns its spawn count (F3), and `depth` is stored on each entry instead of being parsed from its key.
- **Only if 0.1 shows the queue costing about ≥ 0.5 ms per frame while moving:**
  - replace array + sort with a binary heap (priority, then FIFO sequence);
  - promotion pushes a new node and invalidates the old one with a version stamp;
  - `shouldDrop` runs on pop, plus an occasional sweep;
  - `canStart` deferrals go to a side list.
- Vitest covers ordering, promotion, dedupe, cancel, drop, deferral and `clearPending`.
- Flag: `queueImpl: 'heap' | 'array'`.

**1.3 Eviction without diagnostics (R3).**
- Move these behind `debug.streamerDiagnostics` (default off):
  - the fallback-dependency scan;
  - the age-spread scan;
  - the `_recentEvictions` bookkeeping;
  - the eviction logs.
- **Done when:** one eviction costs under 20 µs in S3.

**1.4 Log hygiene.**
- Demote per-frame, per-readback and per-eviction logs to `Logger.debug`, and build their strings only when debug logging is on.
- Put the `[QT-Traverse]` periodic GPU readback behind diagnostics. Startup logs stay at INFO.
- **Done when:** the console is silent at INFO in steady state.

**1.5 Integer tile keys.**
- `TileKey = ((face·32 + depth)·2¹⁶ + y)·2¹⁶ + x`: a safe integer below 2⁴⁰, with `encode`/`decode`.
- Migrate in three commits, each with tests:
  - **(a)** visibility, protection and retry sets;
  - **(b)** `_tileInfo`, `_tileState`, telemetry, freshness, request timestamps, and `_layerToKey` as a typed array indexed by layer;
  - **(c)** queue keys and `TileGenerator._inProgress`.
- `TileAddress.toString()` stays for logs only.
- **Done when:** a CPU profile of S3 shows no string keys built per frame.

**1.6 Visibility pass rewrite (R4).**
- One pass over the readback using epoch stamps. It:
  - marks visible tiles;
  - marks protected tiles (own + nearest resident ancestor);
  - updates `lastUsed` (the ancestor walk stops at the first tile already stamped);
  - computes entered/exited tiles from the epochs;
  - builds the ancestor set for 1.1.
- D3 stats and the copy-state summary run only with diagnostics on.
- **Done when:** under 0.3 ms at about 2000 visible tiles.

**1.7 Typed-array LRU.**
- Keep `lastUsed`, depth and protection epoch in per-layer typed arrays.
- `_selectEvictionCandidate` becomes a tight scan over 2048 entries.

**1.8 Predictive streaming throttle.**
- Run predictive queueing every 4th frame, or when the predicted depth-4 tile changes.
- Check the pending map with integer keys before creating any objects.
- Cap PREDICTIVE requests per call.

**1.9 Phase gate.**
- Run all scenarios against `33de8b1`.
- If idle FPS is still low, the remaining cost is on the GPU: take the timestamp data to 2.1 and 3.1.

## A8. Phase 2: tile loading and generation

**2.1 GPU cost model.**
- From the 0.3 timestamps, keep an EWMA (exponentially weighted moving average) of GPU ms per job type (geometry, refinement, coarse bake) and depth bucket.
- Show it in the HUD.

**2.2 Millisecond admission.**
- Replace "fences in flight" as the main limit with a per-frame GPU budget for generation. Derive it from measurements rather than constants:
  `generationBudget = targetFrameMs − measuredNonGenerationGpuMs − safetyMargin`
  - clamp it to a minimum, so streaming never stops completely;
  - allow a larger value while the initial-load overlay is up.
- The fence limit stays as a hard cap.
- Admission order:
  1. geometry for visible tiles;
  2. refinement of near visible tiles that need material (2.3);
  3. predictive geometry;
  4. far refinement.
- Refinement is considered every frame (F2).
- Flag: `admission: 'ms' | 'fences'`.
- **Done when:** S3 p95 frame time meets the target, and geometry latency is no worse than baseline.

**2.3 Refinement only where material changes pixels, ordered by visual benefit (R6, R0b).**
- **Skip rule.** A detail tile needs its own material only if some of its pixels can have a flat-tier weight below 1, i.e. its nearest point is closer than the fade end. A tile drawing terrain AO (LOD ≤ 3) also needs it.
  - Tiles lying entirely beyond the fade end get no refinement.
  - They are queued when they come within range, using the per-frame fade distances.
  - First verify the R0b related claim: after the flat mix, material is read only by AO.
- **Ordering.** At each visibility readback, re-score queued refinements:
  - visible tiles that need material first;
  - then by projected size × number of levels between the tile and its current material source;
  - stale far entries sink.
- **Done when:**
  - own-material latency p95 for near visible tiles that need it is roughly halved;
  - refinement GPU time in S1 drops by the share of skipped tiles.

**2.4 Compute the padded base height once.** No visual change intended.
- **(a)** Measure the share of refinement GPU time spent in `GenPaddedHeightBase` and the padded tile ids ([webgpuTerrainGeneratorBatching.js:649](core/world/terrain-generator/webgpuTerrainGeneratorBatching.js#L649)).
- **(b) Fused job.** When a tile is visible and within refinement distance at request time, run geometry and refinement as one job:
  - compute the padded base height once;
  - take the inner geometry passes from its interior (padded texel i+pad has the same UV as inner texel i);
  - run the splat chain on the same texture.
- **(c)** For tiles refined later, keep the padded base height in a small LRU: 64 entries × 136² × 16 B ≈ 19 MB.
- **Check:**
  - the inner-vs-padded tile-id mismatch counter in `_debugAnalyzeQuadtreeSplatPass` stays 0;
  - the image diff passes.

**2.5 Pool scratch resources.**
- Pool textures by (size, format, usage) for every per-tile temporary and every output waiting for its copy.
- Return each texture to the pool after the fence of the copy that consumed it. Cache views and bind groups.
- Read the resident height/tile layers through single-layer views (`baseArrayLayer`) instead of copying them into scratch textures as `a96731a` does.
- Today a tile (geometry + refinement) creates and destroys well over ten textures and builds a similar number of bind groups.

**2.6 Mips only for what changed.**
- In `flushPendingCopies` ([tileStreamer.js:476](core/world/quadtree/tileStreamer.js#L476)), regenerate mips only for the mip types present in each flushed entry. Refinement copies never touch normals.

**2.7 Drop zero-fill copies made redundant by the material flag.**
- First check every reader of the material types:
  - the terrain shader, through the material layer;
  - the asset streamer, which reads scatter only after `_commitRefinement`;
  - some debug modes, which read the geometry layer.
- Then copy only the generated types. Keep the `splatIndex` sentinel only if something still reads incomplete layers.

**2.8 Copy queue priority and budget.**
- Visible geometry copies go first.
- Adapt `maxCopyOperationsPerFrame` to the backlog. One copy is 64 KB at 128².

**2.9 Cheaper readbacks.**
- Read the visible-tile count and list from one buffer with one `mapAsync`; today that takes two round trips.
- Copy about 1.5× the previous feedback count (minimum 256) instead of the full 64 KB.

**2.10 Phase gate.**
- S3–S5 meet the latency targets.
- Generation stays inside its GPU budget.

## A9. Phase 3: renderer

**3.1 Idle GPU breakdown.**
- Measure per-pass GPU ms and CPU encode ms for S1, S2 and S6.
- Terrain may not be the biggest pass; clouds, fog particles and atmosphere get measured too.

**3.2 Production shader without debug branches.**
- Compile the roughly 100 `debugMode` branches into a debug variant only, rebuilt when the debug mode changes.
- Measure the GPU ms difference.

**3.3 Parallel instance builder (R8).**
- Insert into the visible hash in parallel. With max depth 11, face/depth/x/y pack into one u32 key (3 + 4 + 11 + 11 bits), so `atomicCompareExchangeWeak` works.
- Spread the per-tile resolve over several workgroups.

**3.4 Traversal.**
- If the single-workgroup BFS costs more than about 0.3 ms, switch to per-level dispatches with indirect args.

**3.5 Per-LOD fragment cost.**
- Add a measurement mode that splits the terrain pass per LOD.
- A/B the expensive terms: splat filtering, normal-map distance, ground field, AO, aerial perspective, clustered lights.

**3.6 Early-z / hidden-surface removal.**
- Find out when `microSample.a` can go negative ([:4323](core/renderer/terrain/shaders/webgpu/terrainChunkFragmentShaderBuilder.js#L4323)).
- Handle that case without `discard`.
- Confidence: medium, Apple-specific. A/B on S2.

**3.7 Memory audit.**
- The pool is about 1 GB, on unified memory.
- Options:
  - separate layer sets per tier, since solid-tier tiles need neither splat nor resolved colour;
  - narrower formats.
- Act only if 3.1 shows memory pressure.

**3.8 Optional: roughness-aware LOD.**
- Store each tile's maximum height deviation and let traversal use it.
- This changes the image, so it needs the owner's sign-off.

**3.9 Phase gate.**
- S1 and S2 meet the idle target, or a list explains what remains.

## A10. Measurement log

Append one row per measured increment. Raw JSON goes to `tools/perf/results/`.

| Date | Commit | Increment | Scenario | Frame ms p50/p95/p99 | Terrain CPU ms p95 | GPU ms p95 | Geometry latency p95 | Own-material latency p95 | Notes |
|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | |

## A11. Open questions for the owner

1. Are the A5 targets for the owner's Mac at 2880×1800?
2. May agents run headless measurements on the owner's machine? They share the GPU.
3. May the outdated analysis `.md` files be archived and `CLAUDE.md` replaced (0.0)?

<!-- ✂ ═══════════════════════════ PART B ═══════════════════════════ -->

# Part B: tiered terrain, RuneVision erosion, lakes and rivers (Phases 4–8)

## B0. Briefing

**Task, in order**

1. **Verify.** Check every numbered claim in B2–B4 against the code at `a96731a` and the cited external sources. Spot-check the factual statements inside the increments (B6–B10).
2. **Report before changing any code.** For each claim ID, give:
   - a verdict: Confirmed / Partly / Refuted / Needs a runtime check;
   - the evidence;
   - a correction where needed.

   Also list risks this plan misses. Report table format:

   | ID | Verdict | Evidence | Correction |
   |---|---|---|---|
3. **Implement** in the milestone order of B12, after the owner approves the verified plan.

**Prerequisites and overlap with Part A**

- Part A (performance, Phases 0–3) may be done by another agent. Part B needs two of its outputs:
  - the perf harness (fixed cameras, screenshot diffs);
  - GPU timestamp queries.

  If they don't exist yet, build a minimal compute-kernel benchmark with timestamps first (4.1) and tell the owner.
- Part A may have changed files Part B edits, especially:
  - the padded splat chain in `core/world/terrain-generator/webgpuTerrainGeneratorBatching.js`;
  - the base-height pass in `core/world/shaders/webgpu/advancedTerrainCompute.wgsl.js`.

  Re-read them first; line numbers below are for `a96731a`.
- Part A's goal comes first: a cheap steady state before spending compute on a smarter terrain function. Otherwise terrain changes can't be told apart from unrelated renderer costs.

**Repository state.**
- Repo `spherecraft/`, branch `codex-restart`.
- `AGENTS.md` maps the code.
- `CLAUDE.md` and the older `*_ANALYSIS.md` / `*_FINDINGS.md` files are outdated; ignore them.
- Whitewater, a kayaking game whose solver is reused here, sits next to it in `../whitewater` (plain JS + WebGPU).

**Running the app**

- **Start:** `python3 server.py` in the repo root, then open `http://localhost:8000/wizard_game/standalone.html`.
- **Console:** `gameEngine` and `window.qtDiag` (`qtDiag.setTerrainDebugMode(n)`).
- **Tests:** `npm test` (vitest).
- **Headless:**
  - Use puppeteer-core with the system Chrome (`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`), `headless: "new"`, `--enable-unsafe-webgpu`, viewport 1440×900 at `deviceScaleFactor: 2`.
  - Puppeteer's bundled Chrome cannot render the app.
  - Headless runs share the owner's GPU. **Ask the owner first.**

**Rules for implementation**

1. **Measure GPU cost per tile by depth** before and after every terrain-function change, using the kernel benchmark (4.1) and the perf harness.
2. **Visual changes are allowed here,** each behind a flag, with A/B screenshots at fixed cameras for the owner's sign-off.
3. **World determinism is tested, not assumed.** The same seed must give identical terrain, water graph and water initial state, regardless of:
   - tile traversal order;
   - streaming speed;
   - which tiles happen to be resident;
   - water-site activation order.

   Add a test that generates the same areas in different orders and compares the results.
4. **LOD continuity is validated on several signals** at every LOD boundary (4.4): height, normals, material classification, water shoreline, and popping during camera motion.
5. **Keep the recent fixes:**
   - material comes only from material-complete layers;
   - the LOD4→LOD5 colour ramp stays;
   - the flash tracker (`TILE_SEAM_FLICKER_LOADING_EVIDENCE.md` §6.2) reports zero flashes after streaming-related changes.

**Guardrails: do not**

- replace the whole terrain function with an interpolated lattice (4.6 limits the lattice to selected smooth terms);
- remove the current stable slope before an A/B shows equivalent material classification (4.5);
- accept tiering on a height-error bound alone (4.4);
- commit to one cube-sphere adaptation of the erosion filter before the standalone prototype comparison (5.2);
- let water carving change watershed membership, outlets, lake spill levels or flow direction (B5 invariant);
- block first terrain rendering on the global hydrology build (6.3);
- put visual micro detail into the simulation bed (B5);
- assume a sim-grid size's GPU cost (8.2);
- delete the old water prototypes before the parity suite passes (7.6);
- treat D8 grid paths as final river geometry (6.5);
- store simulation state in the water graph (B5).

## B1. What the owner wants

- **Tiered noise.** The terrain generator evaluates only what can change the rendered result at a tile's LOD.
- **Erosion.** RuneVision-style erosion replaces the noise octaves that currently fake erosion detail.
- **Rivers.** Lifelike rivers using Whitewater's shallow-water solver.
- **Lakes.** Whitewater has none. Lakes sit at different altitudes, rivers connect them, and rivers also run to the sea.
- **Order.** Tiered noise and erosion come first; the water system joins during that work.

## B2. Terrain generation facts (claims G1–G9)

**G1. Planet.**
- Radius 131,072 m: the face is 2048 chunks × 128 m = 262,144 m = 2R.
- `maxTerrainHeight` = 5000 m.
- Heights are normalised and soft-clamped to about −1.1…1.8.

**G2. Tiles.**
- Max quadtree depth 11. LOD = 11 − depth.
- Tiles are 128×128 texels, vertex-aligned: texel i sits at tile UV i/127.
- LOD0 is a 128 m tile with ~1 m texels. LOD6 is depth ≤ 5: tiles of 8 km and up, with texels of 64 m and up.

**G3. Height function.** [`calculateTerrainHeight`](templates/terrain-shaders/base/earthLikeBase.wgsl.js#L173) sums these terms:
- regional character;
- mountains, gated by "mountainness";
- meso detail:

  | Layer | Amplitude | Wavelength |
  |---|---|---|
  | micro2 | 0 m (disabled) | – |
  | meso1 | 25 m | 80 m |
  | meso2 | 135 m | 750 m |
  | meso3 | 150 m | 4 km |
- highlands;
- lone hills;
- a river carve driven by uniforms;
- erosion seeds;
- inland uplift;
- ocean-floor noise ([:231](templates/terrain-shaders/base/earthLikeBase.wgsl.js#L231)): three fbm calls of 4 + 4 + 3 octaves, evaluated everywhere and then blended by the land mask.

**G4. Noise domain.** All noise is 3-D on the sphere (`fbmMetricSphere3D`, using unitDir × R / wavelength), so there are no cube-face seams.

**G5. Geometry passes** ([advancedTerrainCompute.wgsl.js:976–1030](core/world/shaders/webgpu/advancedTerrainCompute.wgsl.js#L976)):

| Output type | What it computes |
|---|---|
| 0 | Base height plus a "stable slope" from 4 extra full evaluations at a fixed step of 1/8192 face UV (≈ 32 m), so 5 evaluations per texel |
| 2 | Tile ids, from height and slope |
| 4 | Final height = base + micro detail by tile type |
| 1 | Normal, from the height texture |

**G6. Refinement repeats the base height.** The splat chain evaluates a padded (136²) base height again ([webgpuTerrainGeneratorBatching.js:649](core/world/terrain-generator/webgpuTerrainGeneratorBatching.js#L649)).

**G7. Seams.**
- Tiles use transition-topology index buffers and sample their own height texture. A coarser-neighbour mask per instance is available in the instance data.
- Edges between LODs are crack-free only because both tiles evaluate the same function at the shared vertices.
- If octaves are dropped differently per LOD, the crack equals the dropped amplitude at the edge. Normals, materials and shorelines also differ.

**G8. LOD metric.**
- A tile splits when tileSize × lodFactor / distance ≥ 514, where lodFactor = canvasHeight / (2·tan 37.5°) = 1173 at 1800 px ([quadtreeTraversal.wgsl.js:251](core/world/quadtree/quadtreeTraversal.wgsl.js#L251)).
- At a tile's split distance, one pixel spans about tileSize / 514: 0.25 m at LOD0, 4 m at LOD4, 16 m at LOD6.

**G9. Materials depend on height and slope.** Classification (tile type, splat, biome) takes height and the stable slope as inputs. If either changes with LOD, materials change between LODs.

## B3. Earlier AI discussion, claim by claim (D1–D9)

The discussion is `../chatgpt-discussion.md`. The verdicts are mine; re-verify them.

| ID | Claim | Verdict |
|---|---|---|
| D1 | RuneVision erosion is a per-point, GPU-friendly filter on top of any height function, and needs the gradient. | **Confirmed** (E1). |
| D2 | The erosion filter gives terrain "convincing drainage structure" that Whitewater can use. | **Wrong as stated.** The author writes that its gullies "cannot consistently produce unbroken lines" and can stop halfway down a slope. River and lake placement needs a separate flow-routing pass (Phase 6). |
| D3 | Tier octaves by amplitude and footprint, not by a fixed LOD table. | **Agree.** It needs an explicit LOD-continuity strategy (4.4) and stable classification (4.5). |
| D4 | Whitewater details. **(a)** Outside a 32-row GPU readback band it falls back to a 1-D channel profile. **(b)** The sim runs only in a window. **(c)** 3 passes per substep with 8×8 workgroups. **(d)** High quality is 256×1024 at 0.5 m, 2 substeps, dt = 1/120. **(e)** State is `vec4(h,u,v,foam)` plus `k`. **(f)** Momentum uses η = b + h. **(g)** Foam and turbulence come from Froude number, divergence, shear, slope and rocks. | **Confirmed** (W1–W4). |
| D5 | Whitewater's river is handcrafted: centreline, width, slope, ponds, forks, falls, Manning. | **Confirmed** (W5). The "pond" is a widened calm reach, not a lake. |
| D6 | One procedural hierarchy can serve rendering and water at different resolutions. | **Agree.** Implemented as the tier stack in B5. The sim bed is H_simBed, which excludes visual micro detail; the visual terrain also drops that detail inside wetted areas, so shorelines agree. |
| D7 | Water lifecycle: STATIC → INITIALIZING → SIMULATED → BAKING → STATIC. | **Mostly agree.** BAKING is unnecessary when static water comes analytically from the water graph. State persistence is versioned (8.6). |
| D8 | Port the solver, not Whitewater's world. | **Agree.** The solver is already ported (P4); its boundaries are hardcoded to Whitewater's layout (8.1). |
| D9 | Make tier selection a first-class part of the tile-generation API. | **Agree** (4.3). |

## B4. External and existing facts

### Whitewater, verified in `../whitewater`

- **W1.** [`js/shaders.js`](../whitewater/js/shaders.js#L31) `WGSL_SIM` uses a staggered grid and 8×8 workgroups. Each substep runs three entry points:
  - `advect`: semi-Lagrangian, with a MacCormack option;
  - `height`: flux form, with outflow limiting;
  - `momentum`: pressure from η = b + h, Manning friction, wet/dry handling, turbulence `k` and foam.
- **W2.** [`js/config/simulation.js`](../whitewater/js/config/simulation.js) defines the quality tiers. High is 256×1024 at 0.5 m, 2 substeps, dt = 1/120.
- **W3.** [`js/sim.js`](../whitewater/js/sim.js) `computeWindow()` limits the simulated rows to a window around the boat.
- **W4.** [`js/sampling.js`](../whitewater/js/sampling.js) reads back a 32-row band per frame.
  - Outside the band, `waterAt` falls back to the 1-D channel profile.
  - `surfaceAt` blends the two near the band edge.
- **W5.** [`js/river.js`](../whitewater/js/river.js#L167) `generateRiver` builds the river by hand:
  - channel rows (centre, half-width, bed, η);
  - pond, forks, waterfalls, rocks, thermal erosion;
  - Manning-based inflow;
  - a mass-consistent initial state matched per row.

  It has no lakes.

### RuneVision erosion filter

Sources: [blog.runevision.com, March 2026](https://blog.runevision.com/2026/03/) and [blog.runevision.com, 2026 (Phacelle)](https://blog.runevision.com/2026).

- **E1.** Inputs are height and gradient. Outputs are height and approximate derivatives. Every point is evaluated on its own.
- **E2.** Each octave lays gradient-aligned stripes with Phacelle noise: a 4×4-cell neighbourhood, so 16 kernels per octave.
  - "Stacked fading" keeps small gullies off the ridges of larger ones.
  - Parameters: octaves, strength, detail mask, gully weight, and ridge/crease rounding.
- **E3.** No drainage connectivity: the author states that gullies can stop halfway down a slope.
- **E4.** It is 2-D, with cells in a plane. This terrain is a cube-sphere with 3-D noise (G4).
  - The gradient direction is continuous in 3-D. The cell lattice is what breaks at cube-face edges.
  - Cross-fading two height deformations across a seam can create its own artifacts.
- **E5.** Licence: MPL-2.0, file-level. Keep the port in its own file with the MPL header; the project stays MIT.

### Existing water prototypes (P1–P4)

Keep these until parity (7.6).

- **P1.** [`featureRivers.wgsl.js`](templates/terrain-shaders/features/featureRivers.wgsl.js) carves one channel from uniforms: a straight line, or a 16-point polyline from [`HydrologyPrecompute.js`](core/world/hydrology/HydrologyPrecompute.js), which runs a single-region valley search.
- **P2.** Erosion-seed lakes:
  - [`featureErosionSeeds.wgsl.js`](templates/terrain-shaders/features/featureErosionSeeds.wgsl.js) carves hashed pits;
  - [`ErosionSeedVerifier.js`](core/world/hydrology/ErosionSeedVerifier.js) confirms them;
  - [`lakeWaterSystem.js`](core/renderer/lakes/lakeWaterSystem.js) draws static blob meshes, with water levels probed from resident tiles.
- **P3.** [`riverSystem.js`](core/renderer/rivers/riverSystem.js) + `RiverBedBake`: one fixed 128×128 patch at 1 m. Its bed comes from resident tiles, and it simulates every frame.
- **P4.** [`riverSimShader.wgsl.js`](core/renderer/rivers/shaders/riverSimShader.wgsl.js) is the Whitewater solver port, without the scrolling window or the vortex. Its inflow is hardcoded to rows j ≤ 1.
- These are wired up at startup in `wizard_game/gameEngine.js`: hydrology precompute, the erosion-seed verifier, and `setLakes`.

## B5. Target design

### Tier stack

```
H0      = continents + regional + mountain envelope + basins          (LOD-independent)
H1      = H0 + coarse erosion octaves (λ ≥ λ_split)                   → hydrology routing input
graph   = WaterGraph(H1 sampled on the topology grid)                 (deterministic, cached)
H2      = topology-preserving water carving(H1, graph)                (valleys, channels, lake beds)
H3      = H2 + fine erosion octaves (λ < λ_split), suppressed in water
H4      = H3 + visual micro detail, suppressed in water               (what tiles render)
H_simBed = H3 at the sim cell size                                    (water solver bed; no visual micro detail)
Classification = current stable-slope inputs, until an A/B approves a replacement (4.5)
```

### Invariants

- **Topology-preserving carving.** Carving (H1 → H2) may deepen and shape channels and lake beds, but must not change:
  - watershed membership;
  - outlets or lake spill levels;
  - the order in which lakes spill;
  - river flow direction.

  Test: re-run routing on H2 sampled at the topology-grid resolution and compare with the graph.
- **Shorelines agree.** Inside wetted areas H4 = H3, so the visual terrain and H_simBed agree where water touches the terrain.
- **Nested tiers.** Every finer LOD evaluates a superset of its parent's octaves (4.4).

### Data model

Keep these as separate objects:

- **WaterGraph** (topology): lakes, reaches, junctions, outlets, spill levels and Q_proxy.
- **WaterGeometry**: refined reach polylines and widths, lake SDFs, and per-tile corridor lists.
- **WaterSimulation**: the state of active sites only.

The graph never holds simulation state.

### Resolutions

- **Topology grid.** The global 6 × 512² grid (~512 m cells) answers "what connects to what".
- **Local refinement.** Refinement near the camera (6.5) answers "where exactly the river runs".

### Lakes

- Lakes are depressions found by priority-flood.
- A lake's level is its spill elevation, and its outlet is the spill cell.
- Chains at different altitudes come out naturally. Example: lake A at 1200 m spills into a river ending in lake B at 800 m, whose outlet river reaches the sea.
- Small or shallow depressions are breached instead.
- Lakes below their spill level (seasonal or closed basins) are deferred.

### Rivers

- A cell is a river where Q_proxy ≥ threshold, with Q_proxy = accumulated area × precipitation from the climate field. It is a proxy, calibrated against the desired river widths and depths; it is not physical discharge.
- Width ≈ a·Q_proxy^0.5, depth ≈ c·Q_proxy^0.4.
- The bed profile never rises downstream.

### Scale

- At radius 131 km, the topology grid is 1.6 M cells: seconds in a worker, then cached.
- Planets with R ≳ 500 km need a hierarchical graph.

## B6. Phase 4: tiered terrain evaluator

**4.1 Terrain kernel benchmark.**
- A compute harness times `calculateTerrainHeight`, and each term in isolation, over a fixed point set at chosen footprints. It uses GPU timestamps.
- Terms to time:
  - regional;
  - mountains;
  - meso1–3 and micro2;
  - highlands;
  - lone hills;
  - ocean floor;
  - erosion seeds;
  - river carve;
  - stable slope.
- Output: a cost table.

**4.2 Spectral inventory.**
- For every term, record:
  - wavelength range;
  - octaves;
  - amplitude in metres;
  - cost;
  - whether it is smooth enough to interpolate (masks, ridged and warped terms are not).
- Fill the table in B14.

**4.3 `TerrainEvalSpec` in the generation uniforms.**
- Fields:
  - `footprintMeters`: the texel spacing;
  - `purpose`: geometry | classification | hydrology | simBed.
- This becomes the single place that decides how much work a tile does.

**4.4 LOD continuity, then footprint culling.** The cull rule alone is not enough (G7).
- **Nested octave sets.** With footprint f, octave k of wavelength λ_k is evaluated when λ_k ≥ 2f, faded by smoothstep(2f, 4f, λ_k). Because the rule depends only on depth, every finer depth evaluates a superset of its parent's octaves.
- **Morph toward the parent:**
  - near an edge shared with a coarser neighbour (the mask is already in the instance data), vertex heights and normals blend toward the parent layer's values, reaching them exactly at the edge;
  - a camera-distance morph in the interior hides pops when tiles split or merge.

  The instance builder supplies the parent layer. Parent and coarse neighbour sample identical edge positions from the same octave set, so edges match by construction.
- **Validation at every LOD boundary**, with debug modes and a moving camera:
  - |Δheight|;
  - normal angle;
  - material classification flips;
  - shoreline position;
  - popping.

  The one-pixel bound (tileSize / 514) is one check among these, not the acceptance criterion.
- **Start with** the ocean floor, meso and micro terms.
- **Expected visual change:** far terrain loses its aliasing shimmer.

**4.5 Classification stays stable.**
- Keep the current stable slope as the classification input.
- A replacement must win an A/B on rock, biome, snow and riverbank boundaries before the stable slope is removed. Candidates:
  - an analytic slope from a shared landform field;
  - the lattice gradient from 4.6.
- Keep classification inputs LOD-independent.

**4.6 Landform lattice prototype (selected terms only).**
- Back only the smooth low-frequency terms with a world-aligned padded lattice: continental, regional, and the mountain envelope.
- Prefer monotone interpolation where overshoot would move coastlines or extrema.
- Keep masks, ridged terms and nonlinear gates per texel until A/B proves otherwise.
- Accept only if the A/B screenshots and the 4.4 checks pass and 4.1 shows a real saving.

**4.7 Cheap branches.**
- Skip the ocean-floor noise on land.
- Skip land features over deep ocean.

**4.8 Phase gate.**
- GPU ms per tile by depth, before and after.
- Streaming latency.
- A/B screenshots for the owner.

## B7. Phase 5: RuneVision erosion filter

**5.0 Cost/benefit benchmark (before any production work).**
- In the 4.1 harness, compare three setups:
  1. the current erosion-like stack (meso1/meso2, mountain detail);
  2. the RuneVision filter;
  3. the RuneVision filter plus the retained macro terrain.
- Measure for each:
  - GPU ns per sample;
  - register pressure and occupancy, where tools allow;
  - visual quality;
  - gradient quality.
- **Decision rule:** go ahead only if the filter replaces enough existing octaves to cost the same or less for equal or better appearance.

**5.1 Port and test on a plane.**
- Port Phacelle noise and the erosion filter to WGSL in `templates/terrain-shaders/features/featureErosionFilter.wgsl.js`, with the MPL-2.0 header and source links.
- Compare against the Shadertoy on a flat test heightfield in a standalone debug page.

**5.2 Cube-sphere domain: a standalone research prototype.** Not wired into production terrain. Compare:
- **(a)** face-local 2-D cells, cross-faded near face edges;
- **(b)** a 3-D cell lattice, with stripes in the tangent plane.

Measure cost (no estimate assumed), seam visibility, and stripe-orientation continuity across face edges. Use a debug mode that highlights the face edges.

**5.3 Integrate as tiers.**
- Coarse octaves (λ ≥ λ_split, around 1 km) go into H1.
- Fine octaves go into H3, with the footprint culling and morphing from 4.4.

**5.4 Replace the noise that fakes erosion.**
- Remove meso1/meso2 and the mountain-detail octaves one step at a time.
- Capture A/B screenshots and GPU ms at each step.

**5.5 Material hooks.**
- Feed ridge and crease signals into classification: rock on ridges, sediment in creases. Each change needs its own A/B (4.5).

**5.6 Biome tuning.**
- Strength follows ruggedness and mountainness.
- No erosion on plains or the sea floor.

## B8. Phase 6: water graph (topology)

**6.0 Topology prototype on the current terrain.**
- Run 6.1–6.2 on H0 as it exists today: no tiers or erosion needed.
- This proves the graph architecture early. The graph is deterministic, so it can be re-run when H1 changes.

**6.1 Topology grid sample.**
- A GPU pass evaluates the hydrology input and precipitation on 6 × 512² cells, then reads them back (about 13 MB).
- This generalises `HydrologyPrecompute`'s sampling (P1).

**6.2 Graph builder (worker).**
- Priority-flood depression filling with ε-resolved flats, across cube-face adjacency (`core/planet/cubeSphereFace.js`). Ocean cells seed the flood.
- Flow directions: D8 is enough for topology. Multi-flow accumulation (D∞/MFD) is an optional experiment for smoother Q_proxy.
- Extract lakes, rivers and reaches with Q_proxy.
- Vitest on synthetic heightfields:
  - a bowl gives a lake;
  - two bowls at different heights give chained lakes;
  - a slope gives a river to the sea;
  - a flat area gives no loops;
  - the same input in a different traversal order gives an identical graph.

**6.3 Asynchronous build, cache, load order.**
- Start the build in a worker at launch. Basic terrain must not wait for it.
- Terrain features that depend on water activate once the graph is ready. Regenerate only the tiles whose corridor list (7.1) is non-empty.
- Cache the graph in IndexedDB. The key includes:
  - seed;
  - terrain-parameter hash;
  - hydrology algorithm version;
  - water constants version;
  - planet radius;
  - grid resolution;
  - climate/precipitation version.
- Debug map overlay, plus a terrain debug mode that tints lakes and rivers.

**6.4 Showcase finder.**
- A graph query finds a lake → river → lake → river → sea chain near spawn. `qtDiag.gotoWaterShowcase()` teleports there.
- If no such chain exists, tune thresholds (open question B13.2).

**6.5 Local river refinement (geometry, not topology).**
- Near the camera, re-trace each reach inside a corridor on a finer grid (32 m, then 8 m).
- Add deterministic meanders, scaled by how flat the valley is.
- Cache the result per region. D8 grid paths never become final river geometry.

## B9. Phase 7: carving and static water

**7.1 Water data on the GPU, bounded per tile.**
- Storage buffers:
  - WaterGeometry reaches: points, bed elevation, width, depth, flags;
  - lakes: level, bounding box, outlet, SDF atlas slot.
- **Per-tile corridor lists.** When a terrain tile is requested, look up the water features that intersect it: none, river corridor IDs, or lake IDs. Pass only those to the generation job, so tiles with no water pay nothing.
- Lake SDFs come from smoothed coarse masks; SDF = 0 is the shoreline.

**7.2 Topology-preserving carving (H1 → H2).**
- Replaces P1's carve and P2's pits, behind a flag; the prototypes stay until 7.6.
- What gets carved:
  - valley floors at every LOD, slightly below the water surface;
  - channels only where footprint < width / 2;
  - lake beds below the lake level, with the shore rising above it just outside.
- Carving constraints:
  - bed profiles never rise downstream;
  - no saddle may drop below a lake's spill level;
  - lake levels are fixed.
- Fine erosion and micro detail are suppressed inside wetted areas.
- **Checks:**
  - the re-routing test from B5;
  - a debug mode showing the sign of (water surface − terrain) along rivers and shores.

**7.3 River-aware erosion.**
- Distance to water feeds the erosion fade target and mask: calm valley floors, gullies running into channels.

**7.4 Static lakes.**
- A flat surface at the lake level over the lake's bounding box, clipped by the SDF. Terrain depth draws the shoreline.
- Shading is shared with the ocean and river shaders.

**7.5 Static rivers.**
- Ribbon meshes per visible region, built from the refined reaches.
- Surface height η(s) from Manning's equation.
- Flow-aligned UVs, scrolling normals, and foam from slope and Froude estimates.
- Falls as steep ribbon sections. Far reaches fade into a water tint in the terrain material.

**7.6 Parity suite, then retire P1–P3.**
- Retire the prototypes only after the new WaterGraph + static water + simulation site pass a feature and parity suite covering:
  - a river;
  - a lake;
  - lake → river;
  - river → sea;
  - simulation near the camera;
  - far rendering.

## B10. Phase 8: near-field simulation (Whitewater's solver)

**8.1 Solver module.**
- Turn P4 into a `ShallowWaterSim` with a per-cell type mask instead of the hardcoded inflow rows. Cell types:
  - fluid;
  - wall;
  - inflow (η, q);
  - outflow (open, zero gradient);
  - fixed level (lake, sea).
- Bring back Whitewater's row window (W3).
- Tests:
  - a still lake stays still;
  - a sloped channel reaches the expected steady discharge;
  - mass is conserved with closed boundaries.
- This step has no dependencies and can run in parallel with anything.

**8.2 `WaterSimulationSite`.**
- Camera-centred, with:
  - a local tangent frame;
  - a list of active water bodies;
  - an optional preferred flow axis for rivers.

  A lake has no meaningful river axis.
- Choose the grid size and resolution from the desired visible water wavelength, camera distance and the measured GPU budget. Start at 128² with 1 m cells, then measure; no fixed design point is assumed.
- Start with one active site.

**8.3 Bed = H_simBed.**
- A compute pass evaluates H3 at each sim cell, with footprint = cell size. No visual micro detail; see B5.
- Independent of tile residency, unlike P3's `RiverBedBake`.

**8.4 Initial state and boundaries from the graph.**
- A mass-consistent initial state, using W5's per-row discharge matching along the reach.
- Boundaries: inflow where the reach enters the site, outflow where it leaves, and fixed level for lake and sea cells.
- A short warm-up spread over a few frames.

**8.5 Rendering.**
- Draw the simulated surface with Whitewater's foam and turbulence shading.
- Blend into static water near the site edge (W4 `surfaceAt`). Hide static water inside the site.

**8.6 Lifecycle, persistence, budget.**
- Lifecycle: STATIC → INITIALIZING (bed + warm-up) → SIMULATED → FADING → STATIC.
- Persistence, version 1 only for now. When a site leaves, keep only what the static representation already holds: water level, mean discharge and mean velocity. Transient state such as waves and foam is dropped.
- Persistence versions 2–3 (spatially varying level, more dynamic state) are deferred until gameplay needs them.
- Measure the site's GPU cost and set its budget from data.

**8.7 Optional gameplay readback.**
- A 32-row band as in W4, if something needs water queries on the CPU.

## B11. Deferred (only if measurements or gameplay call for it)

- Batched multi-tile generation dispatches.
- GPU-side work compaction.
- Hierarchical hydrology for larger planets.
- Lakes below their spill level (seasonal, closed or evaporation-balanced).
- Water-state persistence versions 2–3.

## B12. Milestone order

**Status 2026-10-04 (HEAD `deed28a`; details in the supplement):** M2 and M8's erosion part are done differently from this plan: the filter runs inside the single height function on a C1/C2 landform (no H0–H4 tier stack; M1/M3 not done). M4's prototype (6.0–6.2) exists as `waterGraph.js` + `HydrologyGrid.js`, not wired in. Next: water, from 6.3.

| Milestone | Steps | Notes |
|---|---|---|
| M1 | 4.1–4.3: kernel benchmark, spectral inventory, `TerrainEvalSpec` | |
| M2 | 5.0–5.2: RuneVision cost/benefit benchmark, plane port, cube-sphere research prototype | Ends in a go/no-go decision with the owner. |
| M3 | 4.4–4.8: LOD continuity, classification A/B, lattice prototype, cheap branches | |
| M4 | 6.0–6.4: water graph topology prototype on today's H0, then the full graph | Can start right after M1, in parallel with M2–M3. |
| M5 | 7.1–7.2: per-tile corridor lists, topology-preserving carving | |
| M6 | 7.4–7.5: static lakes and rivers | |
| M7 | 8.1, then 8.2–8.6: solver module, then dynamic sites | 8.1 can be done any time. |
| M8 | 5.3–5.6, 7.3: erosion in production, river-aware erosion | Only if M2 said go. Re-run the graph on the new H1. |
| M9 | 6.5, 7.6: local river refinement, parity suite, retire prototypes | |

## B13. Open questions for the owner

1. Phase 4 makes far terrain smoother because it removes aliasing. Is that acceptable in principle?
2. Showcase lake chain: procedural only (6.4), or an authored override that guarantees one near spawn?
3. If the RuneVision cube-sphere options all show seams or cost too much, is a simplified erosion (fewer octaves, or face-local with visible but subtle seams) acceptable?
4. Will the planet grow well beyond R = 131 km? That decides whether the global graph is enough.
5. Is a multi-second hydrology build on first launch acceptable if it is cached afterwards, with water appearing a little after the terrain?

## B14. Appendix: spectral inventory

To be filled by 4.1–4.2.
