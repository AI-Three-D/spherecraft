Investigation and optimization results, 29 October 2026.

Update, 30 October: geometry LOD and local background mesh remodeling are now implemented. See [the implementation and validation report](LOD-2026-10-30.md). The investigation below describes the renderer before that addition.

Anthill renders its edited 3D density field directly with camera rays and shadow rays. There is currently no extracted terrain triangle mesh to simplify or rebuild. `VolumeViewModule` traces a hit texture in compute and shades those hits in a render pass. The small fullscreen quad is independent of the amount dug.

Dig count alone does not determine frame time. Each edit is baked into indexed density chunks; neither rendering nor collision replays a growing list of brush operations. Editing an already empty area is a no-op. A fixed-size brush visits its local lattice samples. However, exploring more chunks increases CPU/GPU density storage, the old normal cache grew with those chunks, buffer growth caused large rebuilds, and longer visible passages or shadow paths can require more ray work. Surface detail, pixel count and installed lights also matter. Hidden tunnels do not automatically add per-frame drawing work.

The corrected stress test adds 0, 256 and 1,024 underground sphere edits while holding the overview camera and lighting fixed. The original overview GPU medians were 9.41, 9.32 and 9.31 ms; the optimized trace-every-frame medians were 8.62, 8.61 and 8.65 ms. The optimized chamber medians were 17.50, 17.52 and 17.66 ms. Thus this workload does **not** demonstrate rendering slowdown proportional to hidden dig count. An initial stress script accidentally changed overview framing after returning from first person; that was corrected before saving the final stress results.

There is no distance-based geometry LOD in the active volume renderer. Orthographic tracing can coarsen its probe spacing with pixel footprint, materials filter detail with footprint, and the harness reduces resolution during motion. The original CPU slice renderer also has zoom-dependent sampling. These are useful screen-dependent controls, but perspective rays do not select progressively simplified distant terrain meshes or a multiresolution density hierarchy. The new distance-prioritized normal cache is a memory cache, not geometry LOD.

The implemented batch preserves the density field and surface positions:

- Reuse the compute hit texture when camera uniforms, clipping, viewport and density are unchanged. Sun movement, flicker, moving lights and body shadows still shade every frame. Digging invalidates intersections for the next rendered frame. `reuseHits = false` remains available for comparisons.
- Track edited chunk ranges through volume subscriptions. Upload changed density chunks and contiguous changed map ranges instead of scanning the whole chunk table and rewriting the complete map. Coalesce acceleration-bound writes.
- Grow density and normal buffers with GPU copies of their resident contents. Existing chunks are neither repacked nor recomputed merely because capacity doubled. Density capacity can also use a device limit that is not a power of two.
- Bound each acceleration block including its one-sample interpolation halo. The former union of eight whole neighbouring blocks was unnecessarily pessimistic for open space. Both camera and shadow traversal use the tighter bounds, retaining the original sampling lattice and conservative density checks.
- Retain conservative heightfield air skipping over carve-only edits. Carving cannot raise density above the original field. Fills that exceed the baseline permanently disable this global shortcut and restore the edited-neighbour check; this is deliberately conservative.
- Invalidate normal chunks from changed lattice samples plus the gradient/normal halo, rather than automatically rebuilding every adjacent chunk.
- Limit the normal payload to 64 MiB by default, independently of a device's potentially much larger storage-buffer limit. A separate density-to-normal slot map lets nearby or inspected chunks occupy the cache even when they were dug late. Cache contents survive small camera movement; selection changes at chunk-sized focus intervals. Nonresident chunks use the existing filtered-density normal fallback. `new VolumeViewModule({ ..., normalCacheMaxBytes })` configures the budget; zero disables cached normals.

The interleaved A/B run alternated batches of original and optimized frames in the same Chrome instance, with identical 1264 × 791 cameras and fixed lighting. Each frame waited for GPU completion. Hardware: Apple M1 Pro / Metal, Chrome 156. Other system/GPU activity affects absolute times; use this paired run for comparisons rather than comparing unrelated FPS runs.

| Workload after 1,024 remote digs | Original completed frame | Optimized completed frame | Change |
| --- | ---: | ---: | ---: |
| Overview, trace every frame | 17.26 ms | 15.69 ms | 9% lower |
| Stationary overview, allow hit reuse | 18.37 ms | 9.69 ms | 47% lower |
| Chamber, trace every frame | 39.33 ms | 26.51 ms | 33% lower |
| 16 m tunnel, trace every frame | 31.67 ms | 31.91 ms | Approximately unchanged |
| 192 m tunnel, trace every frame | 34.60 ms | 33.38 ms | Approximately unchanged |

In the separate fixed-camera stress runs, average local upload/normal-bookkeeping CPU time after 1,024 digs fell from 0.91 to 0.35 ms. Brush execution itself remained about 0.2 ms. These numbers exclude GPU normal construction and are not end-to-end dig latency. A normal rebuild or a cold cache can still add work to the edited frame.

At 1,024 synthetic digs, both versions held 2,274 density chunks: 71.1 MiB of CPU density and a 128 MiB GPU density allocation. The original normal payload allocated 729 MiB; the new payload allocated 63.9 MiB, about 91% less. The slot map is additional small metadata. Density chunks still remain resident and are not reclaimed, compressed, or streamed by this batch. Large mines can still reach the device's density-buffer binding limit. Cache selection in a large mine and rebuilding newly resident normal chunks can also cause transition costs; maintenance spread over frames is a possible follow-up.

Periodically remodeling surfaces is feasible, but it would require a new mesh rendering path. A useful next step is to extract meshes per dirty voxel chunk, keep the authoritative density for collision/editing/shadows, and simplify flat or gently curved walls within a geometric error bound. Error-based mesh simplification is established; [Garland and Heckbert's quadric-error method](https://publications.ri.cmu.edu/surface-simplification-using-quadric-error-metrics) is one candidate to evaluate. This is a proposal for Anthill, not an implemented mesher or a guarantee that unrestricted simplification preserves narrow tunnels.

My proposed scheduling policy is to update gameplay density immediately, mark affected mesh chunks and border neighbours dirty, and coalesce repeated brush edits into a worker job after approximately 150–300 ms of quiet. That delay is a starting point for measurement. Prioritize the current view, then nearby hidden chunks. Retain a ray-rendered fallback for newly dirty visible chunks so players see the actual dig while a replacement mesh is pending. Publish a completed replacement only if its density revision still matches, and swap compatible chunk borders together. Keep full detail at small passages, thin roofs and silhouettes. Use screen-space error and hysteresis for later LOD changes; offscreen visibility alone is insufficient because geometry also affects shadows and future views.

Neighbouring mesh resolutions need explicit crack handling. [Transvoxel](https://transvoxel.org/) provides transition cells for dynamically updated voxel meshes with different resolutions. A chunk mesh plus such transitions could support the requested delayed/background remodeling and distance LOD, but neither is implemented in this batch. This is an engineering direction inferred from the current renderer and these algorithms; it still needs a prototype and visual/performance comparisons. Simplifying a derived mesh also does not by itself reduce authoritative voxel storage.

All 134 CPU tests pass, covering cache invalidation, interpolation halos, carve/fill bounds, buffer preservation and limits, precise normal invalidation, bounded cache relocation, resource disposal and existing camera/physics behavior. Real WebGPU checks cover shader compilation, 8,192 numerical density/gradient/material comparisons, acceleration on/off image comparisons, compute/reference rendering, perspective controls and lighting/shadow behavior. Acceleration on/off images match exactly at all four benchmark angles. The camera smoke check also exposed pointer capture being requested while pointer lock was active in Chrome 156; the harness now avoids that invalid capture and explicitly releases lock/input on Escape. The raw measurements are [the paired comparison](comparison-2026-10-29.json), [original digging stress](digging-before-2026-10-29.json), [optimized digging stress](digging-after-2026-10-29.json), and [final image/numerical benchmark](performance-after-2026-10-29.json).

Reproduce the stress run with an existing Puppeteer Core installation and Anthill served on port 8026:

```sh
node dev_harness/voxelBenchmark.mjs --puppeteer /path/to/puppeteer-core.js --dig-stress --seconds 1 --out /tmp/digging.json
node dev_harness/voxelBenchmark.mjs --puppeteer /path/to/puppeteer-core.js --verify-images --out /tmp/rendering.json
```

`voxelCompare.mjs` additionally accepts `--before-url`, `--url` and `--out` and requires an unmodified original checkout/copy served separately. Its default original URL uses port 8027. The original source for this session was preserved at `/private/tmp/anthill-before-20261029`; the temporary comparison server need not remain running. All implementation changes are confined to Anthill; Spherecraft integration remains separate work.
