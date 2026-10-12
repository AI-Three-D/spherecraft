# SphereCraft Terrain Streaming & Generation Performance Audit

**Repository:** https://github.com/AI-Three-D/spherecraft  
**Branch inspected:** `main`  
**Audit date:** 2026-09-28

## Executive summary

SphereCraft already has a surprisingly good foundation for fast planetary terrain streaming:

- GPU-driven quadtree traversal and instance building.
- GPU terrain generation.
- Predictive streaming.
- An asynchronous generation queue.
- GPU backpressure.
- Dirty-slot hash-table uploads instead of always uploading the whole residency table.
- A tile pool / array-texture residency model.
- Diagnostics for visible tiles, queue depth, copies, fences, etc.

The current symptom — **80–100+ FPS when moving slowly, dropping to ~40 FPS or worse during rapid movement** — points much more strongly toward **bursty terrain streaming/generation pressure** than a steady-state rendering bottleneck.

The main objective should therefore be:

> **Get newly needed terrain geometry on screen with the minimum possible GPU work, and defer everything that does not affect immediate geometry.**

Do **not** add the Runevision-style procedural erosion filter yet. First make the terrain streaming path cheap and predictable. The erosion system can later replace some high-frequency noise rather than being stacked on top of an already expensive generator.

---

# 1. Current architecture observed

The active path is approximately:

```text
GPU quadtree traversal
        │
        ▼
visible / feedback information
        │
        ▼
TileStreamer
        │
        ▼
AsyncGenerationQueue
        │
        ▼
TileGenerator
        │
        ├── advanced terrain compute
        ├── normal generation
        ├── tile / biome data
        ├── splat generation
        ├── climate
        ├── scatter
        └── optional resolved color
        │
        ▼
generated GPU textures
        │
        ▼
array-texture copy
        │
        ▼
residency hash table
        │
        ▼
GPU terrain renderer
```

The main relevant files are:

- `core/world/quadtree/GPUQuadtreeTerrain.js`
- `core/world/quadtree/tileStreamer.js`
- `core/world/quadtree/tileGenerator.js`
- `core/world/asyncGenerationQueue.js`
- `core/world/terrain-generator/webgpuTerrainGeneratorBatching.js`
- `core/world/terrain-generator/webgpuTerrainGeneratorPipelines.js`
- `core/world/shaders/webgpu/advancedTerrainCompute.wgsl.js`
- `core/world/shaders/webgpu/noiseLibrary.wgsl.js`

---

# 2. Most important finding: one "tile generation" is not one operation

`TileGenerator.generateTile()` creates a chain of GPU work and intermediate resources.

The current advanced terrain path includes output types for things such as:

- height
- discrete terrain/tile classification
- smooth splat sources
- representative splat IDs
- climate
- scatter
- and potentially resolved color

The repository's `splatmaps.md` documents the current production path as:

```text
advancedTerrainCompute outputType=2
        ↓
advancedTerrainCompute outputType=7
        ↓
advancedTerrainCompute outputType=8
        ↓
splatCompute
        ↓
splatValidityCompute
```

This is visually useful, but it is not something every freshly requested tile necessarily needs before it becomes visible.

### Recommended architectural change

Split generation into:

```text
FAST PATH
    height
    minimum classification
    geometry-ready data

DEFERRED PATH
    normal
    splat
    climate
    scatter
    resolved color
    other beauty/authoring data
```

The fast path should be allowed to make a tile visible.

The deferred path can improve it after the tile is already resident.

---

# 3. Highest-priority change: make generation quality LOD-dependent

Currently `GPUQuadtreeTerrain.initialize()` builds a common `requiredTypes` set:

```text
height
normal
tile
splatData
scatter
climate
[resolvedColor]
```

with splat enabled.

That means a newly streamed tile can carry substantially more work than is required simply to establish terrain geometry.

Instead, generation should have explicit quality tiers.

## Proposed tiers

### Tier 0 — emergency / very fast

```text
height
```

Use this when the camera is outrunning the streamer.

### Tier 1 — geometry

```text
height
normal
tile
```

Enough for normal terrain rendering.

### Tier 2 — material

```text
height
normal
tile
splatData
splatIndex
splatValid
```

### Tier 3 — full

```text
height
normal
tile
splatData
splatIndex
splatValid
climate
scatter
resolvedColor
```

The exact combinations should be determined by what the renderer actually requires at each distance.

---

# 4. Do not generate expensive auxiliary data for distant tiles

The quadtree already knows LOD.

Use it.

A possible policy:

```text
distance / LOD
│
├── orbital / far
│     └── height only
│
├── medium
│     ├── height
│     ├── normal
│     └── coarse terrain class
│
├── near
│     ├── height
│     ├── normal
│     └── splat
│
└── very near
      ├── full splat
      ├── climate
      ├── scatter
      └── optional resolved color
```

This should also interact with camera velocity.

When travelling rapidly, temporarily reduce generation quality.

When stationary or moving slowly, allow the quality to converge.

---

# 5. Fast-flight mode should be a first-class concept

The current `GPUQuadtreeTerrain` already contains:

- adaptive LOD scaling
- camera velocity measurement
- predictive streaming
- GPU backpressure
- look-ahead prediction

That is exactly the right direction.

However, the system should explicitly distinguish:

```text
NORMAL MODE
    quality > latency

FAST TRAVEL MODE
    latency > quality
```

For example:

```text
speed
  │
  ├── slow
  │     └── full generation
  │
  ├── medium
  │     └── normal + limited material
  │
  └── fast
        └── geometry-first generation
```

Do not wait for the queue to become overloaded before switching modes.

---

# 6. Predictive streaming should prioritize a corridor, not a large sphere

The current predictive streamer projects the camera forward and queues neighbors around predicted tile locations.

That is good.

But a fast camera does not need equal priority in all directions.

Use a velocity-aligned corridor:

```text
              future
                ↓
          ┌───────────┐
         /             \
        /               \
camera ●=================>
        \               /
         \_____________/
```

Priority should be approximately:

```text
ahead of camera       highest
slightly ahead        high
sideways              medium
behind camera         low
far behind            don't generate
```

This reduces wasted generation when flying quickly.

---

# 7. Queue policy

The current queue defaults in `TileStreamer` are approximately:

```text
maxConcurrentTasks = 12
maxStartsPerFrame  = 6
timeBudgetMs       = 6
```

The generic `AsyncGenerationQueue` has larger defaults, but the terrain streamer supplies its own limits.

The important point is that **concurrency is not the same thing as throughput**.

For GPU terrain generation, starting 12 expensive GPU jobs can be worse than starting 3–4 jobs and keeping the frame-time budget stable.

The current code already has a GPU fence/backpressure mechanism. Keep that.

### Recommended policy

```text
GPU fences low
    → allow another generation

GPU fences moderate
    → maintain low generation rate

GPU fences high
    → stop starting new terrain work

queue very deep
    → increase predictive priority
    → lower generation quality
    → don't simply increase concurrency
```

Avoid solving backlog by increasing `maxConcurrentTasks`.

---

# 8. The GPU fence diagnostics are extremely valuable

`TileGenerator` tracks:

```text
_gpuFencesInFlight
_maxGpuFencesObserved
```

and `TileStreamer` already uses the fence count for backpressure.

Expose these in the normal debug HUD.

Recommended live counters:

```text
FPS
Frame time

Visible tiles
Resident visible tiles
Exact visible tiles
Ancestor fallback tiles

Generation queue:
    pending
    active

GPU generation:
    fences in flight
    max fences
    tiles started/frame

Copies:
    pending copies
    copies/frame

Tile pool:
    used
    capacity
    free layers
```

This will tell us exactly what is happening during a hitch.

---

# 9. Add timing telemetry per generation phase

This is the most important instrumentation I'd add before changing the algorithms.

For every tile, measure:

```text
request → generation start
generation start → compute submitted
compute submitted → GPU fence complete
fence complete → array copy
array copy → residency visible
```

Then report:

```text
generation latency:
    p50
    p95
    p99

request latency:
    p50
    p95
    p99
```

Also measure each GPU phase:

```text
height
normal
tile classification
splat source
splat
climate
scatter
resolved color
copy
mipmap
```

Without this, optimization becomes guesswork.

---

# 10. Texture resolution needs to become adaptive

This is potentially a huge lever.

A `1024 × 1024` texture contains:

```text
1,048,576 texels
```

A `128 × 128` texture contains:

```text
16,384 texels
```

That is a **64× difference in texel count**.

If 1024 is ever being used for streamed terrain generation, verify whether that resolution is really needed for every LOD.

A reasonable starting policy to benchmark could be:

```text
far       64–128
medium    128–256
near      256–512
very near 512+
```

Do not assume these exact values are correct. Benchmark them.

The important architectural point is:

> Tile texture resolution should not automatically equal the maximum visual quality of the entire planet.

---

# 11. Consider separating logical tile resolution from physical texture resolution

This would be even better.

For example:

```text
LOD 5
    logical tile = large area
    physical height = 128²

LOD 8
    logical tile = smaller area
    physical height = 256²

LOD 11
    logical tile = close
    physical height = 512²
```

The same procedural terrain function can produce all of these.

This is especially appropriate for SphereCraft because the terrain is deterministic and generated procedurally.

---

# 12. Important optimization already present: cached slope

The current terrain shader has already made a smart optimization.

`heightBase` is an `rgba32float` scratch texture where:

```text
R = height
G = stable slope
```

Later passes reuse the cached slope instead of recomputing it.

The shader comments explicitly indicate that the previous implementation could calculate terrain height four times for a finite-difference slope, whereas the current path computes stable slope once and reuses it.

**Keep this architecture.**

It is also exactly the kind of infrastructure that could eventually support a Runevision-style erosion filter.

---

# 13. Noise is probably the second major compute cost

The noise library is substantial.

It contains:

- Perlin 2D/3D
- FBM 2D/3D
- ridged multifractal
- Voronoi
- billow
- turbulence
- domain warping
- multiscale domain warping
- metric sphere sampling
- metric flat sampling

Some of the domain-warp helpers themselves call multiple FBMs.

For example, `warpMultiscale3D()` contains multiple 4-octave FBM calls.

That can become extremely expensive when multiplied by:

```text
tile texels
×
terrain passes
×
number of streamed tiles
```

### Recommendation

Do not remove these immediately.

Instead classify terrain noise into:

```text
macro
regional
mountain
erosion
micro
material
```

and establish an explicit **per-LOD noise budget**.

Example:

```text
far:
    2–3 macro evaluations

medium:
    macro + mountain

near:
    macro + mountain + micro

very near:
    full detail
```

The goal is not "fewer octaves everywhere."

The goal is:

> **No expensive noise evaluation unless its spatial frequency can actually be seen at the current LOD.**

---

# 14. Runevision erosion should eventually replace noise, not stack on top of it

Once the fast path is stable, introduce the procedural erosion filter carefully.

Do NOT do:

```text
existing expensive FBM
+
existing ridged noise
+
domain warp
+
Runevision erosion
```

Instead aim for:

```text
macro terrain
+
mountain structure
+
Runevision erosion
+
small micro detail
```

The erosion filter can provide the directional drainage/gully structure that some of the current high-frequency noise is trying to fake.

This could improve both visual quality and compute efficiency.

---

# 15. Splat generation is a prime candidate for deferral

The repository's `splatmaps.md` documents several stages:

```text
outputType 7
outputType 8
splatCompute
splatValidityCompute
```

The splat system is valuable for close terrain, but it should not block initial geometry residency.

Recommended lifecycle:

```text
tile requested
      ↓
generate height
      ↓
generate geometry-ready data
      ↓
tile becomes resident
      ↓
enqueue material refinement
      ↓
splat generated
      ↓
enqueue optional climate/scatter refinement
```

This is probably one of the largest opportunities for reducing visible hitching.

---

# 16. Avoid making array-texture copying the critical path

`TileArrayPool.flushPendingCopies()` batches tile copies into a command encoder, which is good.

Keep that batching.

But the architectural goal should be:

```text
generation
    ↓
copy
    ↓
residency
```

without requiring all optional textures to be complete.

A tile should be able to become resident with only the minimum required texture set.

Then additional array layers/data can be filled asynchronously.

---

# 17. Be careful with mip generation

The array pool can generate mipmaps for filterable texture types.

Mip generation is currently deliberately batched into the same command buffer after tile copies.

That's correct for ordering, but it adds work whenever a tile is copied.

For terrain streaming, verify whether each streamed texture actually needs mipmaps.

Do not generate mip chains for:

```text
discrete tile IDs
scatter masks
splat IDs
validity maps
```

The code already avoids mips for several discrete types. Preserve that behavior.

For any remaining mipped texture, benchmark:

```text
copy only
vs
copy + mip generation
```

during high-speed traversal.

---

# 18. The tile pool is another constraint

The current GPU quadtree configuration commonly uses a tile pool around:

```text
2048 layers
```

with:

```text
maxVisibleTiles ≈ 2048
```

depending on the active configuration.

This is large enough to support useful residency, but a fast-moving camera can still cause churn if the working set changes rapidly.

Monitor:

```text
free layers
evictions
new allocations
replacements
```

If free layers repeatedly approach zero during fast flight, the problem may be residency churn rather than pure generation cost.

---

# 19. Do not solve hitches by increasing the tile pool blindly

A larger pool can help if the issue is cache churn.

It does not help if:

```text
tile generation = expensive
```

and the GPU is saturated.

So measure:

```text
pool pressure
+
generation latency
```

before changing pool size.

---

# 20. Recommended new terrain architecture

I would refactor toward this:

```text
                        TERRAIN REQUEST
                              │
                              ▼
                    ┌──────────────────┐
                    │ Tile Scheduler   │
                    │                  │
                    │ priority         │
                    │ velocity         │
                    │ LOD               │
                    │ visibility       │
                    └────────┬─────────┘
                             │
                ┌────────────┴────────────┐
                │                         │
          FAST GEOMETRY              REFINEMENT
                │                         │
                ▼                         ▼
          height / tile              normal
                │                    splat
                │                    climate
                │                    scatter
                │                    color
                ▼                         │
             resident ◄──────────────────┘
                │
                ▼
             renderer
```

This should be the core design.

---

# 21. Proposed module boundaries after the refactor

Instead of making one large terrain system responsible for everything:

```text
TerrainSystem
```

split it conceptually into:

```text
TerrainScheduler
TerrainGenerator
TerrainResidency
TerrainRefinement
TerrainRenderer
```

### TerrainScheduler

Responsible for:

- requested tiles
- priority
- camera prediction
- velocity
- LOD
- cancellation
- fast-travel mode

### TerrainGenerator

Responsible for:

- procedural terrain evaluation
- compute pipelines
- terrain outputs

### TerrainResidency

Responsible for:

- tile pool
- array textures
- hash table
- layer allocation
- copies

### TerrainRefinement

Responsible for:

- splat
- climate
- scatter
- resolved color
- other optional data

### TerrainRenderer

Responsible for:

- drawing terrain
- material lookup
- LOD rendering
- stitching

This would also make your upcoming hydrology system much cleaner.

---

# 22. Hydrology should not be coupled to terrain tile generation

Since you're implementing a shallow-water solver and lakes, use a separate simulation layer:

```text
Terrain
    ↓
elevation field
    ↓
Hydrology
    ├── rainfall
    ├── water depth
    ├── velocity
    ├── sediment
    ├── rivers
    └── lakes
```

Terrain generation should provide elevation.

Hydrology should consume elevation.

The renderer consumes both.

Do not make the terrain generator responsible for the water simulation.

---

# 23. Recommended order of implementation

## Phase 0 — instrumentation

Before changing behavior:

- generation phase timers
- queue metrics
- GPU fence metrics
- copy metrics
- pool pressure
- tile latency p50/p95/p99
- visible fallback ratio
- tiles started/frame

### Goal

Produce a reproducible fast-flight profile.

---

## Phase 1 — geometry-first streaming

Implement:

```text
height/tile → resident
```

and defer:

```text
splat
climate
scatter
resolved color
```

### Goal

Fast camera movement should stop causing large generation bursts.

---

## Phase 2 — adaptive generation quality

Add:

```text
slow → high quality
fast → low quality
```

### Goal

Generation cost should automatically decrease when the camera is moving quickly.

---

## Phase 3 — adaptive texture resolution

Benchmark:

```text
128
256
512
```

for different LOD ranges.

### Goal

Find the lowest resolution that maintains visual quality.

---

## Phase 4 — improve predictive streaming

Change the predictor from a roughly radial neighborhood to a velocity-aligned corridor.

### Goal

Generate what the camera is going to see rather than everything around it.

---

## Phase 5 — optimize noise

Profile the actual shader.

Then remove/reduce expensive noise evaluations that are invisible at each LOD.

### Goal

Reduce ALU cost without damaging terrain appearance.

---

## Phase 6 — hydrology

Implement:

```text
elevation → shallow water → rivers/lakes
```

as a separate subsystem.

### Goal

Dynamic water should not interfere with terrain residency.

---

## Phase 7 — procedural erosion

Only after the above is stable.

Use Runevision-style erosion as a replacement for some high-frequency procedural detail.

### Goal

Better-looking terrain at equal or lower terrain-generation cost.

---

# 24. Performance targets

For the MacBook baseline, I'd aim for:

### Steady state

```text
80–100+ FPS
```

as you already achieve.

### Fast traversal

Rather than trying to maintain exactly the same FPS at all costs, the important target is:

```text
no long stalls
no multi-frame generation spikes
no visible terrain starvation
```

A stable 60 FPS with asynchronous refinement is much better than:

```text
100
100
100
42
18
75
100
```

even if the average FPS looks similar.

### Terrain generation

Aim for:

```text
p95 tile request latency < 100 ms
```

and ideally much lower for geometry-only tiles.

More importantly:

```text
no unbounded queue growth
```

during sustained fast travel.

---

# 25. The most important measurements to capture

Do a test where you:

1. Start stationary.
2. Fly at normal speed.
3. Fly at maximum speed.
4. Reverse direction quickly.
5. Turn 90° while moving fast.
6. Stop suddenly.

Record:

```text
FPS
frame time
pending generation
active generation
GPU fences
pending copies
free tile layers
visible tiles
resident visible tiles
ancestor fallback count
```

For each scenario.

This will tell us whether the dominant issue is:

```text
A. terrain compute
B. queue saturation
C. GPU command backlog
D. residency churn
E. feedback latency
F. CPU scheduling
G. excessive tile requests
```

---

# 26. Specific changes I would NOT make yet

Avoid these until profiling proves they are needed:

### Don't

- increase generation concurrency dramatically
- increase tile pool size blindly
- add more predictive tiles everywhere
- add Runevision erosion on top of the current noise
- increase texture resolution
- generate all auxiliary data eagerly
- move hydrology into terrain generation
- rewrite the GPU quadtree

The existing GPU quadtree architecture is not the first thing I'd replace.

---

# 27. What I think is most likely happening

Based on the current code structure and the reported behavior, my working hypothesis is:

```text
fast camera
    ↓
many new visible tiles
    ↓
predictive + feedback requests
    ↓
generation queue fills
    ↓
multiple expensive terrain passes/tile
    ↓
GPU fences accumulate
    ↓
copy/refinement work accumulates
    ↓
GPU becomes temporarily saturated
    ↓
frame time spikes
```

The repository itself contains comments indicating that movement bursts had previously pushed the GPU command queue very deep and caused latency to climb dramatically. The current backpressure system is already trying to prevent that.

That is strong evidence that **burst control is a central problem worth attacking first**, rather than assuming the core terrain shader alone is the culprit.

---

# 28. Final recommended architecture

The end state I'd aim for is:

```text
                         CAMERA
                           │
                           ▼
                    TerrainScheduler
                           │
                ┌──────────┴──────────┐
                │                     │
             visible               predicted
                │                     │
                └──────────┬──────────┘
                           │
                           ▼
                   priority queue
                           │
                ┌──────────┴──────────┐
                │                     │
             FAST PATH            REFINEMENT
                │                     │
                ▼                     ▼
             height                normal
             terrain               splat
             geometry              climate
                │                  scatter
                │                  color
                ▼                     │
             RESIDENT ◄───────────────┘
                │
        ┌───────┴────────┐
        │                │
     Renderer         Hydrology
                         │
                 ┌───────┼───────┐
                 │       │       │
               water   rivers   lakes
```

And eventually:

```text
Terrain:
    macro noise
    mountain structure
    procedural erosion
    micro detail

Hydrology:
    shallow water
    rivers
    lakes
    sediment

Rendering:
    consumes state from both
```

That is the architecture I'd use to keep SphereCraft from becoming bloated again.

---

# 29. Immediate action list

If implementing this incrementally, I would do these **in this exact order**:

1. **Add phase timing to `TileGenerator`.**
2. **Expose GPU fence count and queue depth in the normal HUD.**
3. **Measure one fast-flight run.**
4. **Make height/geometry generation capable of completing without splat/climate/scatter.**
5. **Make refinement asynchronous.**
6. **Add fast-travel generation-quality reduction.**
7. **Benchmark 128/256/512 tile texture sizes.**
8. **Tune predictive streaming around a forward corridor.**
9. **Only then optimize the noise shader.**
10. **Then integrate hydrology cleanly as a separate subsystem.**
11. **Finally investigate Runevision erosion as a replacement for some high-frequency terrain detail.**

The first milestone should be:

> **Fast flight produces temporary lower-quality terrain rather than a frame-time spike.**

Once that works, the rest of the engine becomes much easier to optimize.

---

## Relevant repository files

- `core/world/quadtree/GPUQuadtreeTerrain.js`
- `core/world/quadtree/tileStreamer.js`
- `core/world/quadtree/tileGenerator.js`
- `core/world/asyncGenerationQueue.js`
- `core/world/terrain-generator/webgpuTerrainGeneratorBatching.js`
- `core/world/terrain-generator/webgpuTerrainGeneratorPipelines.js`
- `core/world/shaders/webgpu/advancedTerrainCompute.wgsl.js`
- `core/world/shaders/webgpu/noiseLibrary.wgsl.js`
- `splatmaps.md`

## Related documentation in the repository

- `README.md`
- `splatmaps.md`
- `biomes.md`
- `terrain_splat_visual_track.md`

