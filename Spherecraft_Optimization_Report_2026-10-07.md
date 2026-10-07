# Spherecraft rendering and tile generation optimizations

Date: 7 October 2026. Baseline: `58f6f42065aa0e5254e745871fc5c8fc61feb42a`.

Three targets were implemented and checked in sequence: queue admission, terrain shadow sampling, and material source generation. The GPU comparisons produced identical output bytes in the tested cases. Queue changes alter which tiles get work first during movement; they preserve current visible demand, its fallback ancestors, coarse tiles and explicit prewarm requests.

## Measurements

CPU measurements used Node.js. GPU measurements used native Dawn/WebGPU on an Apple M1 Pro with Metal. These are controlled component benchmarks, **not measurements of full-game FPS or a recorded fast flight**.

| Work measured | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| Enqueue 1,024 requests and order them for admission | 7.45 ms CPU | 0.30 ms CPU | 96% |
| 1080p terrain shadow sampling, nine PCF taps | 1.57 ms GPU | 0.39 ms GPU | 75% |
| Smooth material source weights and IDs, 128 × 128 | 1.05 ms GPU | 0.52 ms GPU | 50% |

A separate saturation benchmark filled the real streamer with 1,024 distant predictive requests, then offered 1,024 nearer feedback requests. All new requests replaced less urgent work, the queue stayed at its 1,024 limit, and the burst took **1.92 ms CPU**. The original queue rejected new requests at capacity, so this is a new behavior benchmark rather than a directly comparable throughput number.

The shadow benchmark renders the production sampling functions over a full 1920 × 1080 image, with distinct patterned depth maps and three cascade regions. The actual game also has four-tap shadows at LOD1, single-tap shadows at LOD2, and unshadowed farther terrain. Its saving depends on screen coverage and other GPU work. Increasing 50–80 FPS by ten requires saving roughly 1.4–3.3 ms from the frame's limiting work; these measurements do not establish that full-game gain.

Queue timing is the median of 30 samples after five warmups. GPU timing is the median of ten samples after warmup, with reference and optimized variants interleaved. Native timestamps are quantized, so the rounded numbers should be treated as approximate. An earlier run measured the shadow variants at 3.21/0.79 ms; absolute timings varied, while the relative improvement stayed similar.

Raw results: `tools/perf/terrainQueueResults.json` and `tools/perf/terrainOptimizationResults.json`.

## 1. Queue admission and moving-camera priorities

Files: `core/world/asyncGenerationQueue.js`, `core/world/quadtree/tileStreamer.js`, `core/EngineConfig.js`, `wizard_game/runtimeConfigs.js`.

The old queue sorted its entire backlog on every new request and every priority promotion. It now marks ordering dirty and sorts when admission or a head inspection needs it. The refinement reserve uses `peek()` so it still sees the most urgent entry.

Geometry pruning previously ran inside the admission tick. When GPU fence pressure exhausted the start budget, the streamer returned before that tick, leaving obsolete requests occupying the queue. Geometry, refinement and regeneration now prune even during GPU saturation. Dropped geometry also releases its timestamps, telemetry and state records; the old bulk drop only removed the queue entry.

Geometry freshness retains the existing 200 ms default. Fresh visibility protects visible tiles and their ancestors even if feedback arrives late. Visibility older than one second stops protecting obsolete work. Prewarm and depth < 5 fallback tiles remain protected. Already submitted GPU jobs run to completion.

At capacity, stale work is reclaimed first. A more urgent request can then replace the least urgent unprotected request. Replacement candidates are ordered once and reused across a burst, with protection checked again before removal. Candidate lists are invalidated when priorities, visibility or queue membership change. Capacity-triggered pruning is limited to once per 16 ms; regular frame pruning still runs.

A stress check caught an expensive first implementation that scanned the whole backlog on every replacement: a burst took 144 ms. Reusing candidates reduced the tested burst to 1.92 ms. A regression test checks that admission does not repeat a full scan for every offer.

Queued geometry and refinement priorities refresh every 100 ms using the current camera. Old priorities can decrease. Geometry adds a bounded proximity preference alongside the existing depth, visibility, feedback and travel-direction preferences. Refinement's near-distance reserve consequently follows the player instead of using its original request location.

Obsolete refinements are parked before admission instead of consuming start slots. Their resident geometry stays available, and visibility readbacks requeue their materials when they are visible again.

Tuning in `generationQueue`: `staleRequestAgeMs`, `staleRequestMinDepth`, `priorityRefreshIntervalMs`, and `replaceLowerPriority`. Replacement can be disabled independently. The queue can still reject requests when all candidates are protected; it cannot create generation throughput beyond the GPU's capacity.

## 2. Terrain shadow sampling

File: `core/renderer/terrain/shaders/webgpu/terrainChunkFragmentShaderBuilder.js`.

Each PCF tap previously sampled all three cascade maps and used `select()` to choose one result. It now branches to the selected map. The explicit-level comparison function permits this varying control flow in WGSL. Nine-tap shadows use nine comparisons instead of 27; four-tap shadows use four instead of twelve.

Fragments outside the selected shadow map return fully lit before sampling. They previously sampled PCF and then masked the result to fully lit. Cascade selection, offsets, weights, biases and fades are preserved.

The 1080p GPU comparison found **zero differing output bytes**. Full terrain fragment shaders also validate at representative LODs, and all seven LOD variants were checked directly with Naga.

## 3. Combine smooth material source generation

Files: `core/world/shaders/webgpu/advancedTerrainCompute.wgsl.js`, `core/world/terrain-generator/webgpuTerrainGeneratorPipelines.js`, `core/world/terrain-generator/webgpuTerrainGeneratorBatching.js`, `templates/configs/terrainGenerationConfig.js`.

The padded smooth source passes independently computed the same biome/noise scores and sorted top-four payload: one wrote weights, the other wrote IDs. One compute pass now writes both textures from that payload. This removes the second evaluation, dispatch, bind group and uniform upload.

Texture formats, padded neighbor coverage, normalization, palette construction, splat smoothing and validity remain the same. The paired pipeline has its own layout and cache key. The separate path is available with `planetConfig.terrainGeneration.fuseSmoothSplatSource = false`; the default is enabled. The existing fallback without shared padded height continues to use separate passes.

The benchmark compares against the original shader factory. Final `splatData`, `splatIndex` and `splatValid` textures were read back for six depth-11 tiles, one on every cube face: **zero differing bytes**, with no GPU validation errors. The 50% timing reduction applies to material source evaluation; expensive base-height generation, palette reduction and the remaining refinement stages still run.

## Validation and reproduction

- Complete Vitest suite: 218 tests pass across 26 files.
- WGSL checks include the paired output layout, river carve and valley variants, and terrain fragment cascade branching.
- Changed JavaScript passes ESLint with existing unused-variable warnings and no errors.
- `git diff --check` passes.

CPU benchmark, from the repository root:

```sh
QUEUE_ONLY=1 node tools/perf/terrainOptimizationBench.mjs '' 58f6f42065aa0e5254e745871fc5c8fc61feb42a
```

GPU benchmark uses the optional `webgpu` package already present in the neighboring terrain lab. No dependency was added to Spherecraft:

```sh
node tools/perf/terrainOptimizationBench.mjs ../terrain-lab/node_modules/webgpu/index.js 58f6f42065aa0e5254e745871fc5c8fc61feb42a
```

For the next full-game comparison, use a fixed camera, resolution and planet, then repeat `await window.runFastFlightTestMatrix({ phaseMs: 4000 })`. Its output now includes queue capacity, drops, replacements and rejections. `[QTLight]` diagnostics also show queue depth/capacity and replacements. Check request-to-resident p95/p99, wasted generations, GPU fence pressure and recovery after stopping. Both the matrix and regular diagnostics consume pressure windows, so counters can cover less than an entire phase when their sampling overlaps.

## Further options

| Option | Potential saving | Visual or engineering tradeoff |
| --- | --- | --- |
| Reuse padded base height and stable slope between geometry and refinement | Avoid another expensive terrain evaluation over the padded tile | Can preserve pixels, but retaining the RGBA32F data increases memory substantially; needs ownership and eviction rules |
| Combine padded tile classification with material payload evaluation | Reuse biome scores across another pair of passes | Can preserve pixels, but discrete classification and smooth weights need a carefully shared result and extra output bindings |
| Use fewer erosion/noise octaves for distant tiles | Reduce the expensive base-height work | Alters small landforms and normals; needs continuous LOD fades and seam checks |
| Generate distant tiles at 64 × 64 instead of 128 × 128 | Four times fewer texels for those compute passes and outputs | Thin rivers/material boundaries and normals lose detail; requires resolution tiers and correct ancestor sampling |
| Use four PCF taps for the nearest terrain instead of nine | About 56% fewer shadow comparisons in that tier | Shadow edges become less smooth; requires a new quality setting in the shader builder |
| Refresh distant shadow cascades less often | Reduce shadow-map rendering cost | Moving objects and sun shadows can lag; keep nearby cascades current |
| Hierarchical depth culling of hidden terrain tiles | Avoid shading terrain fully hidden by closer geometry | Can preserve the image with conservative bounds; needs depth history, motion guards and GPU compaction |

The best next measurement is full-game terrain GPU time while stationary and during the same fast-flight route. That will show how much of the frame is terrain shading, how much is generation, and whether the remaining delay comes from GPU compute, residency or the copy budget.
