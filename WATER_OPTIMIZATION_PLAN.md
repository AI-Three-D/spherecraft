# Water optimizations: backlog and targets

2026-10-11. Agreed order: finish small mountain lakes first, then work through this list from the low-hanging fruit upward, one item at a time, each with a before/after measurement. Measured values are from `tools/perf/structured-terrain-results/lake-recovery-2026-10-11/` (M1 Pro, owned processes, cold = cold IndexedDB/Chrome profile, Metal shader cache warm) unless marked as older. Context: [CLAUDE_LAKE_RIVER_HANDOFF.md](CLAUDE_LAKE_RIVER_HANDOFF.md).

The bar the owner set: coarse tiles must eventually load almost instantly, detailed tiles must come soon after, and FPS must hold during fast flight. Water work must stay off the coarse-tile path and must never add tile regeneration. Every item below is judged by complete cost in ms (cold and warm), loader impact, frame times in the work window (p95/p99, excluding capture stalls) and memory.

## Tier 1: low-hanging fruit (local changes, low risk)

| # | Item | Now (measured) | Target | How |
| --- | --- | --- | --- | --- |
| 1 | Lake adoption on the graph worker | 4.7 s total per cold precompute (`adoptLake` builds each region with `Uint8Array.from(mask, fn)`) | < 0.5 s | Plain loop or a transferred region; skip regions not needed for routing. |
| 2 | Water-graph grid sampling | 2.2 s in the browser; GPU work 0.33 s (lab) | ≤ 0.6 s | During loading: a few large dispatches into one buffer and one readback instead of 9–66 round trips with frame yields. |
| 3 | Patch sampling throughput | 6.4 M samples/s in the browser vs 20 M/s in the lab; cold all-lake precompute 21 s, sampling-bound. Mountain lakes (2026-10-12): discovery 23–34 s for 4,747 small patches (31 M samples, ~5–7 ms per patch), drain continuation 13.8 s for 2,835 patches of 4,000 samples: per-patch overhead, not samples | ≥ 15 M samples/s; all lakes ≤ 12 s cold; mountain discovery ≤ 8 s, drains ≤ 3 s | Reuse output/params/readback buffers per sampler; queue several chunks (and several lakes or blocks) before mapping; one readback per batch of small patches. |
| 4 | Mask atlas slack | 46 MB, 605 of 781 slots used; with mountain lakes and ponds 65 MB, 6,069 of 7,021 slots (reserve guessed before the mountain lakes exist) | ~32 MB without ponds; size to the lakes that exist | Tighter class estimate, or size the atlas after the solves (or grow it). |
| 5 | Warm start | 2.6 s to restore 605 lakes (one IndexedDB read and worker message each) | < 0.5 s | One cache record per planet (all lakes, cropped masks, merges), restored in one message. |
| 6 | River solve loops | 48.6 s single-thread for all 106 rivers (lab); the bulk is per-cell lake/mask loops over each corridor's bounding rectangle (86.8 M cells), not the trace | < 10 s single-thread | Restrict `solveRiver`'s per-cell loops (lake mask, seeds, `inDest`) to corridor cells; avoid `planeToDir`/`dirToCell` per cell. |
| 16 | Lake mask distance fields on the main thread | 0.86 s over all 2,830 lakes (before ponds), at most 31 ms for one lake, a few lakes per frame while they are applied | No frame over 4 ms from it | Compute the field in the worker that solves the lake (with the mask), or cache it with the record. |
| 15 | Cold shader compile stall | After a change to the water shader code, one main-thread stall of 12.5 s at ~9.6 s, just after the water graph is ready; loader 25.9 s instead of 16–18 s, lake restore 15 s instead of 3 s (runs 23, 24). Runs 25–26 with the compiled shader cached: no stall. Every first launch on a machine (empty driver cache) pays it. Which pipeline is not identified: the terrain and near-water shaders both include the water code | No stall over 50 ms from any pipeline compile | `pageInstrument.js` now records synchronous pipeline compiles over 20 ms (label, entry): identify it on the next shader change, then compile it with `createRenderPipelineAsync` (`material.asyncCompile`, as `WaterSimRenderer` does) during loading and keep drawing without water until it is ready. |

## Tier 2: medium (new structure, measurable in isolation)

| # | Item | Now | Target | How |
| --- | --- | --- | --- | --- |
| 7 | Flood algorithm | 32 m all-lake floods 29.4 s CPU (lab, one thread); graph build 0.9 s | ≤ 12 s; build ≤ 0.4 s | Priority-Flood with a FIFO for pit cells (Barnes 2014), typed arrays reused per worker, flood limited to cells below the coarse level plus a margin (retry if the spill is not found). |
| 8 | Rivers precomputed in the pool | Lazy, one at a time after the lakes (0.3–3.3 s each); 149–254 tiles regenerated in the first minutes (runs 3–5). Mountain streams add ~1,400 more rivers: on a warm start their lazy solves near the spawn regenerate 820–860 tiles (77–83 events) before the loader completes, which then takes 17.8–18.2 s instead of 14.9–16.2 s (runs 25–26 vs 19–22) | All rivers ≤ 15 s cold, ≤ 2 s warm; 0 tiles regenerated on a warm start | Trunk before tributaries; publish with the lakes from the cache before the quadtree starts. Streams are short (p50 1.7 km): solve them in the pool in batches. |
| 9 | Worker memory | Renderer RSS +0.1–0.25 GB during the pooled precompute; one unexplained page detach in five pooled cold runs | No detach in 10 cold runs; transient ≤ +0.1 GB | Reuse flood arrays per worker; cap concurrent large patches; investigate the detach with crash listeners on. |

## Tier 3: harder (cross-cutting or needs the owner's eye)

| # | Item | Now | Target | How |
| --- | --- | --- | --- | --- |
| 10 | Cold-start river dependencies | Tiles generated before their river exists are regenerated | No regeneration on cold start either | Hold back tiles that intersect unpublished river corridors (known from the graph ~11 s after load). A tile-queue dependency change: needs the owner's OK. |
| 11 | LOD-aware river carve | +7 % per tile everywhere, +19 % on river tiles (older lab, 2026-10-06; re-measure) | ≤ +2 % on coarse tiles | Skip the channel term on coarse LODs (distant water now comes from the channel profile); keep the valley field. Must pass a crack test at LOD seams; the owner chose "same carve at every LOD" earlier. |
| 12 | Sparse lake masks | 46 MB of masks | < 8 MB | Store only exclusion cells (below the level but not lake water); interior and dry land need no mask. |
| 13 | Water shading cost | Not measured | Measure; act if > 0.5 ms per frame | GPU timestamps with water on/off; the per-pixel river segment walk is the first suspect. |
| 14 | Validation outside the M1 Pro | Not measured | — | Low-end machine runs; fast-flight first coarse coverage < 50 ms with water on must not regress. |

## Done (2026-10-11), for reference

- Lazy carved-sampler compile when the river simulation is off (about 21 s of startup compile).
- Precompute: every lake solved at 32 m in a worker pool, one solve while the terrain loads (the full pool delayed the loader by ~3.5 s).
- Routes computed once after the precompute instead of after every lake (quadratic over 614 lakes).
- Masks cropped to the water: IndexedDB 25.9 MB for the whole water cache.
