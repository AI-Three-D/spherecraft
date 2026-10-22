# Fixed final-height lake coverage: review checkpoint

2026-10-17. **The cached source is independent of render LOD; shoreline contact
is not yet stable across LODs. Do not enable this as the production lake fix.**
This checkpoint tests o4-star only. River banks, outlet holds and water levels
have not changed. The user's accepted river direction is recorded in
[WATER_RIVER_BANK_CONSTRAINTS.md](WATER_RIVER_BANK_CONSTRAINTS.md).

## What changed

- Added [WaterPageCache.js](core/world/water/WaterPageCache.js): byte-bounded CPU
  storage, revisioned keys, coalesced requests, LRU/selective eviction, and
  invalidation of in-flight publication on clear. It does not depend on global
  hydrology or selected render tiles. It is not yet wired into the game loop.
- Added an opt-in [final-height producer](tools/perf/waterStepReview/finalHeightLake.js).
  It generates height-only pages through the production terrain passes,
  including carving and micro detail. Source depth follows physical spacing
  (approximately 1 m here), independent of drawing LOD. It acquires pages near
  the coarse shore in a bounded camera region, not across the planet.
- Coverage uses the existing cached 4 m mask with 0.5 m refinement where
  needed. Cloned lake and terrain materials read the same immutable buffer.
  There are no per-fragment triangle queries. Normal game rendering is unchanged.

## Measured result

Same camera, lake 633, hydrology version 987, three settled terrain selections.
The rebuild run clears both caches and repeats the fine setting. Higher LOD
error thresholds select coarser terrain; the configured default is 512.

| Terrain setting | Visible tiles | Baseline flags | Candidate flags | Candidate edges with minimum drop >25 cm | Largest mean span drop |
|---|---:|---:|---:|---:|---:|
| Default, threshold 512 | 148 | 1,330 | 52 | 0 | 0.525 m |
| Coarser, threshold 768 | 76 | 1,266 | 516 | 331 | 1.359 m |
| Finer, threshold 256 | 509 | 1,313 | 21 | 0 | 0.513 m |
| Fine after cache clear/rebuild | 509 | 1,313 | 21 | 0 | 0.513 m |

Flags are visible render-grid edges with a fully submerged span whose minimum
drop exceeds 5 cm, measured against the actual drawn terrain triangles,
including stitching. They are not surveyed shoreline segments. The last
column is the largest **mean** drop along a flagged span, not its minimum;
therefore a 0.525 m value does not imply an edge wholly above 25 cm.

The mask SHA-256 is identical in all four runs:
`491dbb6a18340e177355cd21c6c51669fdddfc70a29403a270a719e7f28bbbe8`.
The two LOD changes were cache hits with no source-page rebuild. Clearing and
rebuilding all 124 height pages produced the identical mask and identical
contact measurements. All 81,204 duplicate source vertex comparisons agree
exactly in height. These establish repeatability for this region, not all lakes.

Screenshots:

- [Default before](tools/perf/structured-terrain-results/water-final-height-2026-10-17/final/o4-star-before.png)
  and [default candidate](tools/perf/structured-terrain-results/water-final-height-2026-10-17/final/o4-star-after.png).
- [Coarse candidate with flags](tools/perf/structured-terrain-results/water-final-height-2026-10-17/final/o4-star-lod-coarse-contact.png):
  the substantial remaining defects cluster along the left peninsula, with
  the largest drop at the marked right-bank point A.
- [Fine candidate with flags](tools/perf/structured-terrain-results/water-final-height-2026-10-17/final/o4-star-lod-fine-contact.png).

## Critical assessment of the remaining flags

The coarse failure is substantive. At 485 of its 516 flagged neighbours the
mask rejects water. At the worst neighbour the independent unclipped water
probe is 1.294 m above rendered ground; terrain is behind it, not occluding it.
The unchanged mask therefore cannot rely on this coarser rendered ground to
hide its boundary. Depth testing alone does not solve that mismatch.

At the default setting, eight flagged neighbours are rejected by the mask;
44 are allowed by it. Eight baseline water pixels are removed, all rejected
by the mask, with probed ground drops of approximately 0.019–0.196 m. At the
fine setting there are no removed baseline water pixels and all 21 flagged
neighbours are allowed by the mask. No foreground occlusion was identified
by that probe. These remaining allowed-but-not-visible samples still need a
raster/depth investigation; I am not dismissing them as noise or claiming
pixel-perfect contact. The probe uses planet-coordinate float interpolation,
so its small differences also need care.

The finer result supports retaining the fixed source. The coarse result
rejects the claim that a fixed source plus a conservative mask is sufficient
for production. It does not justify widening the mask indiscriminately: that
could cross a real fine-terrain ridge into a disconnected dip.

## Cost

| Work | Measurement |
|---|---:|
| First local build and publication | 1,578 ms wall time |
| Height generation/readback within that build | 892 ms |
| Cache-hit publication, each LOD change | 5 ms |
| Full rebuild and publication after clear | 1,376 ms |
| Stored height payload, 124 pages | 7.75 MiB |
| Stored mask payload / uploaded buffer | 5.72 MiB each |
| Configured CPU payload budgets: heights / masks | 32 / 16 MiB |

This is a 2.2 km square request region with a nominal 64 m shore band. Fine
height acquisition follows the shore, but the mask directory is still a dense
bounded rectangle. The cold build is too long to run synchronously during
play. CPU payload budgets exclude temporary build allocations, JS overhead,
GPU generation resources and the uploaded mask copy.

Fenced render medians, baseline / candidate / restored, in ms per frame:

| Setting | Before | Candidate | Restored |
|---|---:|---:|---:|
| Default | 10.75 | 11.75 | 10.75 |
| Coarse | 9.50 | 10.50 | 9.50 |
| Fine | 18.25 | 19.75 | 18.50 |
| Fine rebuild | 18.50 | 19.75 | 18.50 |

These measure the complete candidate, including changed visible water and
prototype binding work, not isolated mask sampling. The earlier same-image
lookup-only test measured approximately +0.75 ms. This round does not replace
that with a more precise sampling claim. Globally increasing terrain detail
is costly: the fine baseline itself is about 7.5 ms slower than default.
Background generation, sparse publication and localized containment detail
must be measured before accepting production performance.

## Validation and limits

All four captures pass [validation.json](tools/perf/structured-terrain-results/water-final-height-2026-10-17/final/validation.json):
unchanged source/residency within each A/B/A, no browser/GPU errors, exact
baseline/replay images, terrain cross-check maximum 3.06 cm and water-position
cross-check maximum 2.49 mm. Fine versus rebuilt fine screenshots differ by at
most one channel value in 134,465 of 5,184,000 pixels; the mask and contact data
are identical. This inter-capture shading drift is not an A/B/A replay failure.

The relevant seven test files pass: **41 tests**, including the closed-pocket
connectivity fixture, the internal dry-ridge fixture, cache reuse/eviction and
in-flight invalidation. The closed-pocket fixture is not a new shot-5 test.
No public typed contracts changed.

One source assumption was corrected before this final capture: the active
terrain vertex sampler maps UV to texels 0–127. The repeated-border remap in
an older research probe follows a disabled shader branch. The new producer
uses the active mapping. The contact metric executes the actual vertex
function and was not based on that old probe.

Remaining integration limits are explicit:

- Seeds come from wet fine shore components touching the inner half of the
  coarse band. This region has one seed component, but unsampled interior
  connectivity is not certified for arbitrary lakes. Unknown mask cells keep
  the old coverage. The fixed band must eventually expand when insufficient.
- The cache class supports local keys; this diagnostic still supplies the
  existing global hydrology revision. Regional revision providers, cross-face
  component links and multiple-body publication are not implemented.
- There is no background scheduler, camera-driven prefetch/distance eviction,
  sparse GPU page publication or near/far transition test. A selective eviction
  method and bounded LRU storage are foundations, not that complete service.
- Shot 5, river-bank filling and the new outlet hold are outside this checkpoint.
  No new claim is made about them, or about centimetre accuracy at 5,000 km radius.

## Next small step

Test a local shoreline containment policy against the fixed mask: identify
where the drawn terrain falls below a mask boundary and retain/refine only
the required shore geometry. Measure its tile and frame cost at the same
three settings. Separately classify the 21 allowed-but-not-visible fine-view
flags before accepting a zero-gap claim. Do not introduce a blended water
surface, globally force finer terrain, or hide failures with mask dilation.

After that review, integrate budgeted sparse lake pages and proceed to the
agreed narrow river-bank experiment: fill only deficient banks to water +
approximately 0.3 m; measure height and length; prefer local level reduction
where the necessary fill would exceed roughly 1–1.5 m.

Raw evidence: [report.json](tools/perf/structured-terrain-results/water-final-height-2026-10-17/final/report.json).
Reproduce with the `final-lake` command in the [capture README](tools/perf/waterStepReview/README.md).
