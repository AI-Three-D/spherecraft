# Connected water coverage — review checkpoint

2026-10-16. **The prototype is rejected as a production fix.** It substantially
improves the pure lake shore at o4-star, but a constant-level connected fill
floods shot 5's descending outlet valley. Production files remain unchanged.
This checkpoint stops for review before another implementation step.

Claude's request to test both places was useful: the pure lake result alone
would have given a misleading impression of success. The missing requirement
is now concrete: connectivity must use a coherent water surface that changes
height along an outlet. Sharing a binary mask at one lake level is insufficient.

## Verify o4-star's original point A

The approximately 15 m separation is real. A close camera on the opposite
side of the edge measures **14.935 m at the original point A's planet
coordinates**, against that camera's selected terrain triangles. The earlier
camera measured 14.975 m. These are separate selected meshes and samples;
the difference should not be interpreted as a change in lake level.

See the [close marked normal image](tools/perf/structured-terrain-results/water-connected-2026-10-16/point-a/o4-star-A-close-contact.png)
and [actual visible surface identities](tools/perf/structured-terrain-results/water-connected-2026-10-16/point-a/o4-star-A-close-surface-ids.png).
In the identity image, **blue is lake geometry and brown is terrain**. It
comes directly from the captured float surface-ID pass, using the production
fragment discards. No height-based water recolouring is used to classify it.

The sheet ends near the upper third of this image. Much of the area below
it looks cyan in the normal rendering but is actually terrain. This explains
why judging the gap from the normal colour boundary alone is unreliable.
The yellow line in the normal overlay connects the original water point to
its original ground point. The new exact-anchor sample is recorded separately
as `anchorSample`; the overlay's A label is the largest current raster-edge
sample, **14.875 m**, not that exact anchor.

This close capture has 1,968 terrain cross-check samples, maximum disagreement
**3.11 cm**, and 957 water-neighbour samples, maximum **0.377 mm**. It reports
zero unknown or occluded shoreline spans, zero page/GPU errors and exact
normal replay. Its [validation passes](tools/perf/structured-terrain-results/water-connected-2026-10-16/point-a/validation.json).
Two earlier [side and overhead captures](tools/perf/structured-terrain-results/water-connected-2026-10-15/verification/validation.json)
also pass their controls, with maximum edge drops of 14.82 and 14.84 m.
The close identity image is the clearer visual explanation.

## Where the prototype data lives

The experiment publishes one immutable, versioned
`WaterGpuData.connectedCoveragePatch`: planet-space lake frame, body ID,
existing water level, source version, bounds and a shared GPU storage buffer.
Cloned lake, river and terrain materials switch to that buffer together.

The lake sheet expands to the available patch and uses its connectivity.
Terrain body shading and the river's lake-overlap query read the same result.
Outside available geometry the old coverage remains the explicit fallback.
Original materials and data are restored for the replay. There are no
production imports of this tooling and no changes to terrain generation.

The producer joins submerged regions of the **actual frozen terrain
triangles**, including the selected diagonal and stitching. A single
submerged seed must lie inside a 3×3 neighbourhood of solved lake-interior
cells. The old coarse mask supplies that interior seed, not the new shore.
Only the seed's connected component gets lake coverage. The level is unchanged:
627.45294 m at o4-star and 1,312.32349 m at shot 5.

Spatial bins are 8 m, but store candidate triangle IDs for exact triangle
footprint queries. They do **not** impose an 8 m shoreline raster. Terrain
depth clips the water against the ground inside a connected footprint.
The shader integration and producer are about 200 lines combined in
[connectedPrototype.js](tools/perf/waterStepReview/connectedPrototype.js) and
[connectedTriangles.js](tools/perf/waterStepReview/connectedTriangles.js).

This deliberately tests geometric coverage before committing to a runtime
solver. The producer depends on the current selected mesh; it is not yet
stable across camera movement or LOD. A future world-owned producer can retain
the shared publication/consumer design without retaining this CPU exporter.

## Paired results on the two requested views

These compare the same frozen scene before, during and after the prototype.
Counts are internal **2160×1350 render-grid edges**, at the existing 5 cm
minimum-separation threshold. Lengths sum projected raster edges, not smooth
shoreline contours. Both baselines reproduce the previous checkpoint exactly.

| Measurement | o4-star before | o4-star prototype | Shot 5 before | Shot 5 prototype* |
|---|---:|---:|---:|---:|
| Hanging lake grid edges | 1,330 | 60 | 275 | 308 |
| Hanging lake grid-edge length, m | 878.36 | 73.42 | 47.57 | 14.34 |
| Largest lake drop, m | 14.975 | 1.447 | 2.177 | 2.440 |
| Lake edges still flagged above 25 cm | 1,280 | 13 | 253 | 283 |
| Hanging river grid edges | 0 | 0 | 405 | 0 |

**O4-star:** hanging lake edges decrease by **95.5%**, and projected hanging
length by **91.6%**. Coverage adds 26,045 lake pixels and removes 13; no river
or other-lake pixels are replaced. Its complete capture controls pass.
However, 13 edges still exceed 25 cm and two exceed 1 m. The largest remaining
flag is on the left shore. The 13 removed pixels and remaining flags need
classification before acceptance; this checkpoint does not establish their
causes. This is a useful improvement, not a nearly perfect fix.

[O4-star before](tools/perf/structured-terrain-results/water-connected-2026-10-16/final/o4-star-before.png),
[prototype](tools/perf/structured-terrain-results/water-connected-2026-10-16/final/o4-star-after.png),
[remaining contact flags](tools/perf/structured-terrain-results/water-connected-2026-10-16/final/o4-star-contact.png).

**Shot 5:** the lake adds **1,477,195 pixels** and replaces **48,545 river
pixels**. Of those, 48,334 are covered by lake water more than 25 cm higher
than the previously visible river. The replacement surface is up to
**40.93 m higher**, with P95 **38.21 m**. These compare radial elevations of
the before/after visible surfaces along the same screen rays; they are not
a volume estimate or a survey of the same horizontal location.

The valley is visibly flooded. Zero remaining river boundaries results from
covering the river. It is not an improvement in river correctness. This
failure is not resolved by the closed-pocket test: the downhill valley is
connected to the lake, whereas that fixture's pocket is separated by a sill.

[Shot 5 before](tools/perf/structured-terrain-results/water-connected-2026-10-16/final/shot5-sheets-before.png),
[rejected flooded result](tools/perf/structured-terrain-results/water-connected-2026-10-16/final/shot5-sheets-after.png),
[contact overlay](tools/perf/structured-terrain-results/water-connected-2026-10-16/final/shot5-sheets-contact.png).

*Shot 5's candidate contact counts are **provisional**: its water-neighbour
cross-check has a maximum disagreement of 9.37 mm, exceeding the unchanged
5 mm acceptance gate. Its P95 is 0.0082 mm. The check can compare neighbouring
primitives of the same lake; that is a possible explanation for the outlier,
not an established diagnosis. The validator correctly rejects the capture
for contact certification. Pixel identity/replacement counts come directly
from the position pass and do not use derivative extrapolation. The flooding
is also visible in the ordinary image; the failed cross-check cannot explain
a 41 m elevation difference.

## Controls and tests

All three final experiment poses complete their river traces, retain exactly
the recorded source/residency/regeneration state, replay the original normal
image pixel-for-pixel, and report zero page/GPU errors. Both main views have
zero unresolved in-range contact spans. Terrain cross-check maxima are 3.06 cm
at o4-star and 2.98 cm at shot 5, before and after. These are sampled checks,
not rigorous bounds for all pixels. See [raw metadata](tools/perf/structured-terrain-results/water-connected-2026-10-16/final/report.json)
and [validation, including failures](tools/perf/structured-terrain-results/water-connected-2026-10-16/final/validation.json).

The third prototype pose, the close o4-star camera, becomes entirely water.
It has no visible shoreline and no visible-terrain cross-check samples after
the change. Its zero edge count is **not** accepted as a contact pass. The
separate unchanged-production close capture above supplies the point-A
verification instead.

**25 focused tests pass:** ten contact tests, seven image-analysis tests,
three retained profile fixtures and five new connectivity tests. The new
producer connects all 120 triangles sampled in the naturally low-bank test
region, while leaving **all 118 submerged triangles in the closed-pocket
region disconnected**. These use the real production river-section functions.
The alternate saddle diagonals produce connected versus separate wet regions
as required. These are CPU topology tests; they do not prove correctness of
every GPU lookup or every real-world pocket.

Remaining topology limitations are explicit. The two components have 5,283
and 1,196 wet edges with no identical paired edge in the exported mesh. These
can include window cuts and unmatched/transition edges; they are not proven
closed basins. Vertex matching uses 1 mm rounding. Connectivity through
unseen terrain, T-junctions, small cracks and changing LOD still needs a
stable world representation. Neither an unknown boundary nor successful
fixtures establishes global hydrologic correctness.

## Measured cost

System Chrome on the same M1 Pro workstation. Six batches of four rendered
frames, each batch fenced for GPU completion, at the same frozen pose.
The following are end-to-end wall-clock medians, **not GPU timestamp costs
or live-game FPS**. Shader compilation is outside these measured batches;
the raw first batches still show warmup variation.

| Cost | o4-star | Shot 5 |
|---|---:|---:|
| CPU connectivity, packing and publication | 184 ms | 81 ms |
| Published GPU buffer allocation | 2.22 MiB | 0.90 MiB |
| Exported patch triangles | 40,089 | 18,829 |
| Maximum triangles in one lookup bin | 24 | 35 |
| Before, median ms/frame | 10.75 | 12.00 |
| Prototype, median ms/frame | 13.50 | 15.50 |
| Restored original, median ms/frame | 10.75 | 12.00 |
| Observed median increase | **2.75 ms / 25.6%** | **3.50 ms / 29.2%** |

The CPU build excludes the diagnostic GPU geometry export/readback. The
complete baseline contact capture took 1.28 and 1.41 seconds; this exporter
is not a viable runtime acquisition path. The buffer sizes are allocations,
not total process-memory peaks, and exclude the existing diagnostic arrays.
No terrain regeneration occurs during the frozen comparisons.

There is already measurable rendering overhead from per-fragment triangle
queries and changed coverage. One cannot budget only the connectivity solve.
Conversely, this small buffer experiment does not need a fresh 3,200²-cell
camera flood. The previous [coverage cost review](WATER_COVERAGE_COST_REVIEW.md)
still describes that different workload; its GPU times are not directly
comparable to these whole-render wall-clock samples.

## Recommended next bounded step

Keep the shared body/coverage publication and the opposing fixtures. Replace
the constant-level outlet experiment with a **continuous lake-to-river water
surface**, using the existing lake level and downstream river elevations.
Then compute connectivity below that surface. The handover must meet in both
height and coverage; cutting off a flat lake at another arbitrary line would
recreate the hanging edge.

First test that handover on shot 5 and a small descending-outlet fixture:
connected low banks get water, the closed pocket stays dry, and downstream
water keeps its prescribed elevation instead of becoming an enlarged flat
lake. Include a direct water-to-water height/continuity check, since the
current union-boundary contact metric intentionally omits those junctions.
Retain o4-star as the pure-lake regression and classify its remaining flags.
Do not optimize or integrate the current rejected fill into production.

The four requested old development directories (`pilot`, `pilot2`, `baseline`,
`verified`) were deleted; the previous `water-contact-2026-10-15/final` evidence
is retained. This experiment's primary directory is about 27 MiB. Failed
development captures are not acceptance evidence. Reproduction commands are
in the [tool README](tools/perf/waterStepReview/README.md).
