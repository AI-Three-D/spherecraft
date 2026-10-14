# Water coverage: sharpened design review and measured costs

2026-10-14. Follow-up to `WATER_FLOATING_EDGES_CODEX_REVIEW.md`, responding to Claude's proposed camera-window flood fill. The acceptance bar remains pixel-perfect or nearly so. Production rendering code was not changed; the new code consists of research probes and benchmarks.

**Decision:** pursue a shared coverage/level representation, but do not commit to “a camera-centred 1 m GPU flood fill” as the complete design. It leaves correctness issues unresolved, and its cost depends heavily on the algorithm and acquisition of fine terrain data. Cached local connectivity is technically plausible. Rebuilding an entire fine window for every camera movement is a poor default.

**A correction to my earlier recommendation.**

Claude is right to worry about water topology changing with displayed terrain LOD. My original recommendation did not sufficiently separate stable hydrologic connectivity from final visual contact with the ground. Re-solving the whole water topology independently from whatever triangles happen to be selected would be unstable.

Use a stable, world-anchored representation for connectivity and levels. Use the current rendered terrain for final shore contact and validation. The height textures are the input to that rendered terrain, not an alternative to accounting for its triangulation. This distinction avoids both unnecessary topology churn and the false assumption that a filtered height texture equals the ground on screen.

**Correctness tests of Claude's adjustments.**

1. **Height textures alone do not guarantee the visible shoreline.** The production regular grid uses the diagonal between the lower-left and upper-right vertices (`TerrainGeometryBuilder.js:176`). Four corner heights `[2,0,0,2]` have a bilinear centre height of 1 m, while the drawn diagonal has height 0 m. Water at 0.75 m sees dry ground in the bilinear interpretation and wet ground in the actual triangles. Identical height data; different water connectivity and shoreline.
2. **A 1 m raster has topology errors even with correct input heights.** Four-neighbour fill misses a wet diagonal channel; eight-neighbour fill joins two wet corners across a dry diagonal in the reverse saddle. Merely switching neighbour count does not fix it. A piecewise-linear drawn ridge peaking at 1.05 m above a 1 m water level has a dry crest only 9.5 cm wide; offset 1 m samples miss it. These are counterexamples against a raster-only guarantee, not a claim that the current screenshots have that exact ridge.
3. **A camera-only solve can lose valid connections.** A U-shaped lake with its connecting section outside the window is one connected region globally and two locally. Moving the window can change which arm gets water without changing terrain or water level. Seeding every below-level cell from a coarse lake mask would avoid that particular omission by risking false filling of isolated pockets. External component connections need certified boundary links or retained global connectivity, not guessed seeds.
4. **Generated height textures are not all available at 1 m across the near range.** The live 3.2 km square probes found roughly 650 distinct finest-level tile addresses without resident data, with almost all sample locations falling back to coarser tiles. A 1 m output grid cannot recover details absent from its source. Obtaining the missing data has a material cost, measured below.
5. **A single binary flood does not resolve multiple water levels.** Adjacent lake and river pixels can belong to connected water at different elevations. A “highest level” lookup can leave a discontinuity or carry lake water down a descending reach. The solve needs body/reach identity, a compatible local level field and explicit continuous junction geometry. The benchmark's binary connectivity algorithm does not solve those hydrologic decisions.

The live texture probes also compared bilinear interpolation with the full 128-segment regular-grid triangulation of 32 resident tile textures per pose. Across those samples, full-grid differences reached roughly 0.6–0.9 m; the 99th percentile was roughly 0.16–0.34 m across runs. This is evidence that the interpretations differ on real generated data. It is **not** a measurement of floating-edge height or an exact reconstruction of every selected transition-LOD triangle. A final visual metric must include the selected geometry, its transition topology and stitched edges.

If a coarse rendered LOD erases a containment sill that stable water topology relies on, stable topology and pixel-perfect contact can conflict. Preserve/refine that shore geometry or bound its visual error. A water mask alone cannot make the missing ground barrier exist.

**Benchmark setup and scope.**

Hardware: Apple M1 Pro, 16-core GPU, 32 GB RAM. Native tests use Node Dawn/Metal; browser tests use system Chrome and the real game with river simulation off. Timings use GPU timestamp queries. Native timestamp resolution is visibly quantized, so differences of a few hundredths of a millisecond are not significant.

The experimental fast method computes local connected components in 16×16 workgroups, merges component links at block boundaries, finds the seed component, and resolves coverage. It uses atomic union-find rather than propagating a wet flag outward one cell per dispatch. The kernels follow WGSL's workgroup/storage atomic rules; no global barrier within a workgroup dispatch is assumed. See the [WGSL memory model](https://www.w3.org/TR/WGSL/#memory-model).

The reported native cases have seven measured rounds after warmup, browser synthetic cases nine. These are short-run measurements on one machine, not a robust distribution of worst-case frame latency. Allocation, shader compilation, CPU verification and diagnostic readback are outside the steady-state GPU timings unless specifically stated.

**Measured connectivity cost, before gathering terrain or evaluating water levels.**

All widths below assume 1 m cells. A 1,024-wide window covers only a 512 m half-width; the 3,200-wide window is needed just to cover the current 1,600 m near radius before adding a movement halo.

| Window | Cells | Native blocked connectivity, GPU median | Chrome synthetic shoreline, GPU median |
|---|---:|---:|---:|
| 512×512 | 262,144 | 0.66–0.79 ms | not measured |
| 1,024×1,024 | 1,048,576 | 1.31–1.51 ms | 1.07 ms |
| 2,048×2,048 | 4,194,304 | 3.47–4.52 ms | not measured |
| 3,200×3,200 | 10,240,000 | 7.01–10.29 ms | 6.97 ms |

Ranges are between the open, irregular-shore and winding-channel masks, not confidence intervals. One native 3,200 winding-channel sample reached 14.22 ms; one Chrome synthetic-shore sample reached 17.80 ms. A nearly empty real-world mask can be cheaper than these broad wet masks; do not size the budget around the easiest view.

**A simple iterative flood fill is a different, much worse cost class.**

| Completed fill | Iterations | Measured GPU median |
|---|---:|---:|
| Open 512×512, corner seed | 1,022 | 26.21 ms |
| Open 1,024×1,024, corner seed | 2,046 | 173.67 ms |
| Winding 64×64 channel | 2,079 | 6.49 ms |

A 64-pass partial fill at 3,200×3,200 took 52.95 ms and is far from complete. A corner seed requires 6,398 passes even on an open square. Applying that measured per-pass rate suggests seconds, but the completed large case was not measured; this is an extrapolation. A fixed pass cap trades correctness for speed and must not be used to certify no floating water. Claude did not specify an algorithm, so this is a warning against one implementation choice, not an assertion that he intended it.

**Costs beyond connectivity.**

The browser field probe reads actual resident terrain height textures through a directory of fine tiles and loaded ancestors, and invokes the existing lake/river queries on the GPU. It also runs the component kernels on the resulting wet mask. The old queries intentionally retain their known defects; this measures a candidate-evaluation workload, not a corrected solver.

The final controlled mouth-view run measured these GPU medians:

| Window | Gather heights only | Candidate levels only | Fused gather/classify | Connectivity | Fused + connectivity |
|---|---:|---:|---:|---:|---:|
| 1,024×1,024 | 0.076 ms | 0.297 ms | 0.345 ms | 0.235 ms | 0.580 ms |
| 3,200×3,200 | 0.862 ms | 2.380 ms | 3.043 ms | 4.172 ms | 7.215 ms |

The combined column adds independently timed stages; it is not a measured full-frame overhead. Wet fractions were 10.3% and 33.0%, respectively. Both binary component outputs matched the CPU reference exactly. The water-data version stayed at 1011 throughout measurement, pending terrain regeneration was zero, and regeneration counters did not change. Pilot mouth-view runs measured about 6.5–8.0 ms for the large field, consistent with the controlled result. These numbers exclude new geometry, correct multi-level ownership, cross-window connectivity certificates, rendering, and acquisition of missing fine heights.

The experimental field plus component buffers allocated approximately **234.4 MiB** at 3,200×3,200. There is deliberate redundancy for testing: float height, float level, uint wet mask, a duplicate mask, uint parents and uint output. An optimized solver can alias/drop buffers and pack coverage. Connectivity alone used approximately 117.2 MiB. A complete implementation must still budget levels, ownership, labels, published coverage and any second buffer set used for coherent updates; quoting only a 10 MiB byte mask would be misleading.

I separately generated transient finest-level height tiles through the production base-height, classification and final micro-height passes. No normal, material or splat outputs were generated, and the results were not installed in terrain residency. Five controlled batches of 16 tiles gave a median of **2.69 ms GPU per 128×128 height tile** and 2.96 ms wall time per tile. Batch GPU times ranged from 38.84 to 75.52 ms, showing substantial short-run variability. Pilot medians were about 2.4–2.5 ms per tile. Producing roughly 650 missing tiles would therefore be approximately **1.75 seconds of GPU work** at the controlled median, plus scheduling/copies/retention. This is an extrapolation from nearby tiles, not a measured full-window build. Their final height data alone would occupy roughly 41 MiB. Existing terrain regeneration counters remained unchanged, with no pending regeneration before or after the probe.

New fine-height acquisition is different from regenerating existing displayed tiles, but it is still terrain computation and must be counted. Reading existing coarse textures is cheap precisely because it does not produce that missing detail.

**Movement and update cost.**

Rebuilding a 6.5–10.3 ms field every frame would consume approximately 39–62% of a 60 Hz frame budget before the existing scene. At ten updates per second it averages approximately 1.1–1.7 ms per frame, but a one-frame rebuild can still stall the frames that carry it. Those averages are arithmetic estimates, not measured FPS deltas with the new renderer installed.

World-anchored pages allow reuse. Translating a 3,200 m window by 64 m exposes only 2% new cells horizontally, or about 4% for a 64 m shift in both axes. That can greatly reduce reclassification and acquisition work. It does **not** prove connectivity can be updated by solving just that strip: connections can join/split through the boundary. Cache local components and retain their world-space links, then update the component graph coherently. Neither the repeated whole-window benchmark nor this review implements that incremental graph.

Using the controlled height-tile rate, supplying a fully fine moving square would require on the order of 52 ms of new-height GPU work per second at 100 m/s horizontal movement, and about 520 ms/s at 1,000 m/s, before other work. These are area-rate estimates assuming no reused data ahead of the camera; they show why a full fine square is expensive even if its fill is optimized.

Snap pages to stable world coordinates rather than fractional camera coordinates. Add a halo sized for camera speed and solver latency. Handle teleportation explicitly. A component touching an unresolved window boundary is not proven closed or proven connected. Publish complete old/new results at a safe boundary; do not let rendering sample a half-built field.

**Recommended implementation path after these tests.**

1. Build the edge-contact metric against actual rendered geometry. Count exposed water edge length/pixels and water–ground separation, including pure lakes. Distinguish contacts with another water surface from hanging edges. Add a separate false-flooding/connectivity check. Keep the old ownership metric only as a diagnostic.
2. Replace river coverage with the real connected wetted section at its existing level. Account for naturally low banks and cuts from neighbouring rivers; remove the analytic profile's role as a final coverage authority. Preserve disconnected pockets and test the earlier shard cases. This is an initial use of the shared representation, not another permanent special rule.
3. Prototype a **world-anchored, cached component graph with locally refined shore data**, rather than a fresh full-resolution square flood on every move. Use coarse hydrology for candidate routing and distant representation, but validate/certify local connections where its approximations matter. Prioritize height refinement at shores, sills and junctions; do not acquire a fine square of dry hills merely because the camera can see them.
4. Make one level/owner/coverage result available to lake surfaces, river surfaces and terrain body shading. Connect differing levels through an explicit continuous transition. The display step must account for the current triangle surface, or use conservative validated coverage with depth clipping where that guarantees contact. Constrain shoreline LOD error when coarse geometry would destroy a certified barrier.
5. Measure the **integrated** renderer under camera movement before retiring the old band/yield/hold rules. Include solve scheduling, stale results, input acquisition, memory peaks and frame-time tails. Use the current rules only until their responsibilities are replaced; their presence is not proof that the new field is correct.

This supports an overhaul, with a credible route to controlling cost. It does not support approving Claude's original camera-window plan merely because it runs on the GPU. The unresolved acceptance test remains visible shore contact and correct connectivity across all target views, not a small average ownership percentage.

**Tests and evidence.**

Twenty-four native component datasets, including random masks, disconnected regions, open water and long winding channels, matched an independent CPU breadth-first reference exactly. Two real browser-derived binary fields also matched that reference, giving 26 verified component datasets. Three completed iterative fills matched as well. The logical counterexamples cover outside-window connections, triangle saddles and a thin drawn sill. The controlled browser run recorded no page errors or GPU errors. No production-code fixes were made.

Research code is in `tools/perf/waterCoverageResearch/`. Raw timestamp samples, texture probes and correctness records are in [water-cost-review-2026-10-14](tools/perf/structured-terrain-results/water-cost-review-2026-10-14/README.md). The performance prototypes establish algorithm costs for the measured scope; they are not a pixel-perfect water renderer and must not be mistaken for one.
