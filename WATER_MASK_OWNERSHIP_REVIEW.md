# Cached water masks and outlet ownership — review checkpoint

2026-10-17. **Keep the cached-mask direction; reject this candidate as a fix.**
The pure lake improves substantially and mask sampling is cheaper than the
previous triangle searches. Shot 5 still has visible gaps. Lower-body ownership
has not made the ownership boundary coincide with equal water heights.
Production source is unchanged. This checkpoint stops for Claude's review.

The latest constraints are recorded in [the data-path plan](WATER_MASK_DATA_PATH.md):
local, world-anchored pages; lazy shore refinement near the camera; byte-bounded
caching and eviction; implicit interiors and coarse distant coverage; no
planet-wide fine data, including on planets of 5,000 km or greater radius.
High-altitude river visibility can be reduced. Runtime scheduling, caching,
fixed-resolution height acquisition and LOD stability are **not implemented**
by this experiment.

## What was tested

The opt-in prototype builds a cached 4 m ownership mask. It permits overdraw
into known dry bank. Cells that intersect connected water and excluded wet
pockets refine to 0.5 m; missing terrain or unresolved component conflicts
remain unavailable and fall back to existing coverage. Each river uses its
existing `riverWaterLevels` curve and centre-line seeds. Connected lower river
regions are removed before flooding the lake from its interior seed. Equal
levels retain lake ownership, within the existing 2 cm tolerance.

Lake sheets, terrain body shading and river geometry read the same published
buffer. Ordinary cells require one record fetch; refined cells require two.
River cells also reference the existing curve segment. There are no
per-fragment triangle searches. This experiment uses a storage buffer;
compact integer texture pages remain a suitable production representation.

The producer still uses the frozen selected terrain mesh to isolate ownership
and rendering cost. It builds a bounded rectangle, not the proposed sparse
shore cache. Added river quads use the existing levels, with no blended surface.
The actual rendered triangles remain the independent contact reference.

## Captured results

Counts are boundaries on the internal **2160 × 1350 render grid**, with a
minimum ground separation of 5 cm. Lengths are projected raster-edge sums,
not surveyed shoreline lengths. Both baselines reproduce the prior checkpoint.

| Measurement | o4-star before | Cached mask | Shot 5 before | Cached mask* |
|---|---:|---:|---:|---:|
| Hanging lake edges | 1,330 | 56 | 275 | 210 |
| Hanging lake edge length, m | 878.36 | 65.90 | 47.57 | 62.26 |
| Largest lake drop, m | 14.975 | 0.542 | 2.177 | 3.734 |
| Lake edges with minimum drop above 25 cm | 1,280 | 2 | 253 | 200 |
| Hanging river edges | 0 | 0 | 405 | 345 |
| Hanging river edge length, m | 0 | 0 | 54.49 | 82.17 |
| Largest river drop, m | — | — | 0.933 | 3.671 |

**O4-star:** 95.8% fewer hanging lake edges and 92.5% less flagged raster-edge
length. The mask adds 26,037 lake pixels and removes four. Forty-nine of the
56 remaining flags disappear at a 10 cm threshold, but two remain above
25 cm. This is an improvement, not nearly perfect contact. The four newly
removed pixels and the two remaining larger flags have not been individually
classified. The capture controls pass.

[O4-star before](tools/perf/structured-terrain-results/water-mask-2026-10-16/final/o4-star-before.png),
[after](tools/perf/structured-terrain-results/water-mask-2026-10-16/final/o4-star-after.png),
[marked remaining edges](tools/perf/structured-terrain-results/water-mask-2026-10-16/final/o4-star-contact.png).

**Shot 5:** no baseline river pixels are replaced by the lake, compared with
48,545 in the rejected flat-fill experiment. However, 14,939 lake pixels are
removed, there are visible holes, and flagged lengths increase. Fewer boundary
edges alone would give the wrong verdict. Do not accept this candidate.

[Shot 5 before](tools/perf/structured-terrain-results/water-mask-2026-10-16/final/shot5-sheets-before.png),
[rejected after image](tools/perf/structured-terrain-results/water-mask-2026-10-16/final/shot5-sheets-after.png),
[marked gaps](tools/perf/structured-terrain-results/water-mask-2026-10-16/final/shot5-sheets-contact.png).

*Shot 5's candidate contact counts are **provisional**. Its water-neighbour
cross-check reaches 8.71 cm, exceeding the unchanged 5 mm gate; P95 is
0.150 mm. Neighbouring primitives and the new river tessellation need diagnosis.
I have not relaxed that gate or certified the reported drops. Both baselines
pass, both normal replays are pixel-identical, recorded source and regeneration
state are unchanged, and there are zero page/GPU errors. Terrain cross-check
maxima remain 3.06 cm and 2.98 cm. [Validation includes the failure](tools/perf/structured-terrain-results/water-mask-2026-10-16/final/validation.json).

## The outlet assumption does not hold in this candidate

A separate test samples the **published mask's lake/river interfaces in world
coordinates**, every 0.5 m. It does not use screen derivatives or silhouette
classification. At shot 5, **47 of 219 samples differ in water level by more
than 25 cm; the maximum is 1.849 m**. At that maximum, the lake is 1.116 m
above the rendered ground, while the river is approximately 0.733 m below it.
That is an exposed higher-water cut beside a buried lower surface. Depth
testing cannot join those surfaces.

These numbers describe this quantized candidate boundary, not the ideal
continuous boundary or the baseline outlet. They establish that this
implementation fails the proposed junction rule. They do not establish that
an appropriate outlet partition cannot work with the existing curve.

The code explains why the existing hold cannot simply be assumed to cover a
new boundary: [waterWorkerCore.js](core/world/hydrology/waterWorkerCore.js#L659)
derives held samples from the old source-lake SDF and selected bank samples.
It does not inspect the new connected coverage. Furthermore, ground can be
above the river surface but below the lake surface. Excluding only the river's
wet region leaves such bank ground available to the higher lake. A focused
fixture demonstrates this opposing case.

A screen-adjacency diagnostic also finds 17 lake/river pairs above 25 cm after
the change, versus zero before, but that diagnostic inherits the water-plane
cross-check limitation. The world-coordinate boundary test is the stronger
reason to reject the equal-height assumption here.

The next correction should explicitly place the lake-to-reach handover where
the two existing surfaces meet, with a reach domain that prevents lake water
routing around that handover along lower banks. First test whether the current
hold supplies a suitable section. If it does not, measure the required hold
change against final bank heights. **This is a proposal for the next checkpoint,
not a tested solution.** There is no evidence here that an arbitrary blended
surface is needed.

## Classification of the previous 13 edges and 13 removed pixels

The audit reproduces the earlier triangle prototype exactly: 60 hanging edges,
13 above 25 cm and 13 removed lake pixels. Every one of those 13 removed pixels
was explicitly rejected by its coverage query; none was hidden by foreground
terrain. Candidate water would lie 0.032–1.120 m above the ground at their
screen rays. Changing the lake grid moves its radial surface by at most
2.78 cm there, which cannot explain the largest gaps.

All rejected pixels lie in **two single-triangle components**: source triangle
32781 accounts for three pixels and 33445 for ten. Each has **two unmatched
wet edges**. The 13 larger edge flags surround these same rejected regions.
These are holes at unresolved mesh connectivity, not certified closed pockets.
The precise cause of the unmatched edges—stitching/T-junctions versus coordinate
matching—has not been isolated. They must not be called intentional dry areas.
[The audit records every pixel, component and foreground test](tools/perf/structured-terrain-results/water-mask-2026-10-16/final/o4-star-previous-prototype-audit.json).

This supports replacing selected-mesh adjacency with a stable world-owned
source. It does not justify increasing a weld tolerance until the holes vanish,
because that could connect a real narrow dry barrier.

## Cost and scaling

M1 Pro, system Chrome, frozen scene. Each condition warms up eight frames,
then measures twelve batches of four frames, fenced for GPU completion.
These are **whole-render wall-clock timings**, not GPU timestamps or live FPS.
The reported median is the seventh ordered sample of twelve. Quarter-millisecond
batch resolution limits interpretation of small differences.

| Cost | o4-star | Shot 5 |
|---|---:|---:|
| Original, ms/frame | 10.75 | 12.00 |
| Original plus mask-record lookup only | 11.50 | 12.00 |
| Complete candidate | 11.75 | 11.75 |
| Restored original | 10.75 | 12.00 |
| Mask and segment buffer | 1.758 MiB | 0.459 MiB |
| Additional river quads | 0 | 3,896 |
| Total experimental river buffers | 1.94 KiB | 262.47 KiB |
| CPU build/publication, excluding geometry export | 708 ms | 897 ms |

The lookup-only control keeps original geometry and coverage. Both images are
identical across all 2,916,000 internal pixels. Its observed overhead is
**0.75 ms at o4-star and not resolved at shot 5**. The latter is not proof of
zero cost. This control excludes river segment evaluation and additional
geometry; the complete candidate changes pixel workload and cannot isolate
lookup cost. The earlier triangle-query prototype added 2.75–3.50 ms/frame.
Caching removes that search burden, but the current lookup still has a material
cost on the lake-heavy view.

CPU builds are too expensive for synchronous gameplay and include diagnostic
work and an initial triangle-prototype build. They are neither optimized
production build times nor the cost of acquiring missing fine heights.
The current patches contain 93,100 / 23,520 base cells, with 345 / 102 refined
parents. They retain 9,930 / 4,019 unavailable leaf records, including missing
source terrain near patch limits. These mix coarse and fine cells and are
**not area percentages**. Existing fallback coverage remains unproven there.

For scale, a 1 km shoreline strip 64 m wide contains 4,000 cells at 4 m:
62.5 KiB using this prototype's 16-byte records, or 15.6 KiB with a proposed
4-byte format, before refinement and metadata. Fine 1 m scalar heights for
that strip alone are 250 KiB. These are storage arithmetic, not measured
production allocations. Actual height-tile footprints, halos and temporary
solver data add cost. No amount scales with the whole planet by design.

The [earlier height-acquisition benchmark](WATER_COVERAGE_COST_REVIEW.md)
measured 2.69 ms GPU per transient 128×128 final-height tile at its controlled
median. Caching and shore-only acquisition matter because missing fine data
is expensive. This round does not repeat or replace that benchmark.

## Self-review and next acceptance gate

**35 focused tests pass**, including the closed-pocket production-section
fixture, connected low bank, thin-ridge refinement, missing-source handling,
lower ownership, equal levels and mismatched-junction detection. Fixtures do
not prove that every real pocket or variable-level reach is handled correctly.

I also fixed a bug in my previous material adapter: its `storageBuffers`
getter returned a fresh copy, losing dynamic ribbon-buffer assignments. It
now returns persistent resources. The previous missing-river result must not
be treated as independent evidence of correct overlap handling. The new
captures preserve and restore actual ribbon buffers and counts.

Important remaining implementation limits are the selected-mesh producer,
piecewise-linear river classification, nearest-segment level extension outside
the centre line, quantized ownership transitions, unresolved source boundaries,
and the candidate river tessellation. The shot 5 failure cannot all be blamed
on the production hold. These are opt-in diagnostic files, with no production
imports. The report's inherited `shaderHashes.after` is the unused guard-removal
control hash; it is not the mask-candidate shader hash. A separate source
manifest accompanies this checkpoint.

Before integration: resolve the outlet and river-geometry defects on shot 5;
retain o4-star and closed-pocket regressions; replace the producer with cached
fixed-resolution final heights including micro detail; then measure the same
published mask across actual LOD transitions. A fixed mask does not prevent a
coarse terrain LOD from erasing its containment ridge. Preserve or refine that
geometry where required. Large-radius precision also needs testing: float32
planet-relative components near 5,000,000 m have 0.5 m spacing, so existing
vertex arithmetic cannot be assumed to provide centimetre contact there.

[Raw capture metadata and timing samples](tools/perf/structured-terrain-results/water-mask-2026-10-16/final/report.json).
