# Water shoreline contact — review checkpoint

2026-10-15. Production terrain and water code are unchanged. This checkpoint
adds the lake-inclusive contact measurement and stops for Claude's review.
The primary evidence is the `water-contact-2026-10-15/final` directory.

**The metric now detects the defect that the old ownership score missed.**
O4-star has 1,330 hanging lake-boundary grid edges, with a median separation
of 3.91 m and a maximum of 14.97 m. Shot 5's front lake edge reaches 2.18 m
above the rendered ground. These are substantial geometry failures. They
remain when the detection threshold is raised well above numerical error.

## Shot 5: resolve the apparent narrowing

I checked the previous, retained guard-on/off images pixel by pixel:

- Exactly **3,813** normal-image pixels change.
- The ribbon ownership green channel increases at exactly those same
  **3,813** pixels, and decreases at **zero** pixels.
- **Zero** normal-image changes occur outside that added-coverage set.
- None of those changed pixels had the old terrain-water ownership red
  channel at its high-confidence threshold. Their average normal colour
  changes from brown-green to cyan. The hypothesis that these changed pixels
  were previously terrain-shaded river water is not supported.
- Both halves of the comparison sheet are exact copies of their respective
  source PNGs: **zero mismatched channels**, with no scaling or crop.

There is no measured narrowing in that comparison. The imagery can suggest
one when viewed small, but I cannot establish a particular perceptual cause
from the files. I should have supplied this exact change map with the first
comparison rather than leaving the apparent contradiction unexplained.

[Exact changed pixels, marked magenta on the old normal image](tools/perf/structured-terrain-results/water-contact-2026-10-15/review/shot5-exact-diff.png)
and [counts](tools/perf/structured-terrain-results/water-contact-2026-10-15/review/shot5-exact-diff.json).
The earlier 2,623 added-pixel count used green >= 200; 3,813 counts every
green increase, including partial/faded coverage. These are different tests.

In the new [marked shot 5 capture](tools/perf/structured-terrain-results/water-contact-2026-10-15/final/shot5-sheets-contact.png),
**A identifies the hanging front edge of the upper lake immediately above
the outlet**, corresponding to the problem in the user's pink-arrow image.
The drop at A is **2.177 m**. Its internal raster coordinate is
`(1419.5, 518)`, or approximately `(1892.7, 690.7)` in the 2880x1800 PNG.
The JSON also records its water and ground world coordinates.

## What the measurement does

The diagnostic retains the current lake and river fragment discards. It
renders terrain and near-water geometry into float position/derivative
targets. Terrain body colour cannot masquerade as a water surface here.
The nearest visible lake/river surface forms the measured water union.

For terrain, it executes the **existing generated vertex function** in a
separate compute pass with the original uniforms, final height textures,
UVs and selected instance range. It reconstructs triangles from the actual
draw's indices, including transition topology and vertex-stage stitching.
It does not use CPU base heights or bilinear texture interpolation. WebGPU
does not support exporting writable storage directly from the vertex stage;
the separate execution is checked against rendered terrain pixels below.

At each water/non-water raster boundary, perspective-correct GPU derivatives
extend the actual water triangle into the neighbouring pixel. The check
compares that span against **every intersected rendered terrain triangle**.
A narrow dry sill between the pixel centres therefore prevents a hanging
classification. Foreground terrain that occludes the extended water is
counted separately. Missing terrain would be unresolved, never a pass.

A conservative whole-interval bound flags a span when its radial water-ground separation exceeds
**5 cm** throughout. The reported drop is at the boundary midpoint. Metres
of edge length are sums along horizontal/vertical raster edges, not a fitted
smooth shoreline. These are view-dependent lengths: even a screen-grid
staircase can exceed a straight diagonal by about 41%, and its projection
into world space adds further distortion. The pixel counts below are **2160x1350 internal render-grid
edges**, not the 2880x1800 upscaled screenshot's pixel count.

## Baseline results

| Pose / surface | Hanging grid edges | Grid-edge length, m | Median drop, m | P95 drop, m | Maximum drop, m | Edges still flagged above 25 cm |
|---|---:|---:|---:|---:|---:|---:|
| s3 lake | 32 | 3.65 | 0.098 | 0.131 | 0.135 | 0 |
| s3 river | 244 | 19.48 | 0.054 | 0.068 | 0.072 | 0 |
| o4-mouth lake | 1,357 | 227.94 | 1.711 | 3.434 | 3.690 | 1,310 |
| o4-mouth river | 454 | 112.94 | 0.091 | 1.005 | 1.441 | 105 |
| o4-star lake | 1,330 | 878.36 | 3.913 | 14.306 | 14.975 | 1,280 |
| shot 5 lake | 275 | 47.57 | 1.277 | 2.064 | 2.177 | 253 |
| shot 5 river | 405 | 54.49 | 0.119 | 0.524 | 0.933 | 65 |

O4-star has no measured river boundary. Its old zero gap score was blindness
to lakes, not a successful shore. At a threshold of **1 m**, o4-star still
has 1,220 hanging lake grid edges; o4-mouth has 1,132 and shot 5 has 160.
The sensitivity results are recorded at 5 cm, 10 cm, 25 cm and 1 m.

Review the [o4-star overlay](tools/perf/structured-terrain-results/water-contact-2026-10-15/final/o4-star-contact.png),
[o4-mouth overlay](tools/perf/structured-terrain-results/water-contact-2026-10-15/final/o4-mouth-contact.png),
[shot 5 overlay](tools/perf/structured-terrain-results/water-contact-2026-10-15/final/shot5-sheets-contact.png)
and [s3 overlay](tools/perf/structured-terrain-results/water-contact-2026-10-15/final/owner-s3-shore-contact.png).
Red marks flagged edges; A marks the largest measured lake drop. The source
normal PNGs and replay PNGs are retained alongside them.

## Controls and critical self-review

All four poses completed their requested river traces, retained identical
recorded source state during measurement, and reported **zero page/GPU
errors**. Normal replay is pixel-identical for all four final poses. The
analyzer now permits bounded replay drift: at most one channel value in at
most ten pixels per million. A preceding capture had one such differing
pixel at o4-star and was accepted. This deliberately corrects the previous overly strict rejection
of start-2591's five single-value differences. It does not assert their
exact cause. The older A/B analyzer retains exact ownership-mask checks.

Two numerical checks independently constrain the reconstruction:

| Pose | Visible terrain samples | Largest terrain disagreement | Water-neighbour samples | Largest water prediction disagreement |
|---|---:|---:|---:|---:|
| s3 | 1,208 | 3.66 cm | 882 | 1.07 mm |
| o4-mouth | 2,068 | 2.92 cm | 791 | 0.65 mm |
| o4-star | 1,075 | 3.06 cm | 1,330 | 2.48 mm |
| shot 5 | 2,666 | 2.98 cm | 163 | 0.27 mm |

No terrain samples in those checks were missing. These are sampled checks,
not mathematical bounds for every pixel. The centimetre-scale terrain
disagreement reflects the precision limit of reconstructing planet-scale
float geometry and interpolated world positions. **The 5–7 cm s3 river
flags are marginal evidence.** I would not use them to accept or reject a
near-perfect fix without a tighter examination. The metre-scale lake gaps
are far outside this uncertainty, as the threshold sweep demonstrates.

I rejected two diagnostic approaches during development: writable vertex
storage is invalid in WebGPU; inverse camera-matrix extrapolation had up to
14.3 cm of sampled disagreement in shot 5. The final version uses the existing
vertex function in compute and actual GPU pixel derivatives. The development
`pilot`, `pilot2`, `baseline` and `verified` directories were deleted at the
user's request on 2026-10-15; **`final` remains the checkpoint result**. The preliminary o4-star count
was 1,335; the corrected final count is 1,330. Tightening the separation
threshold to a conservative whole-interval bound left all four final
summary tables unchanged; the interior-minimum fixture tests that bound.

This is still a bounded diagnostic, with explicit limits:

- Four baseline poses are covered here, not all twelve prior viewpoints or
  a movement/LOD-transition sweep.
- It measures visible terrain/lake/river contact inside the fully opaque
  near range, **1,000 m**. Fade boundaries and viewport cuts are excluded.
  O4-star excludes 2,110 fade edges and 2,249 viewport edges; these are not
  successful contacts. There are zero unresolved in-range sampled edges.
- Water-to-water boundaries are excluded from the union outline. A lake
  touching a lower river can still have a level discontinuity that requires
  a separate junction check. Props and other non-terrain occluders are not
  part of this diagnostic pass.
- A local submerged span establishes contact failure, not global hydrologic
  correctness. False flooding of disconnected pockets remains a separate
  requirement; the two retained opposing fixtures still apply.
- “Contact” means no exposed separation above this tolerance was established
  across that pixel span. It is not a certificate for subpixel geometry or
  every unseen shore.

Ten geometry/classification tests pass: exposed drops, real shore contact,
thin intervening sills, missing terrain, diagonal-dependent saddles, segment
intersection, an interior separation minimum missed by point samples, pure
lake versus river classification, occlusion and tolerance.
Seven analyzer tests also pass, including the new bounded replay rule.
JavaScript syntax checks pass. Public contracts and production source have
not changed.

## Cost and next bounded change

After scene settling, the complete offline diagnostic takes **1.14–1.66 s
per pose** in this run, including its GPU passes, readbacks and CPU geometry
analysis, before screenshot writing/cleanup. These are four observations,
not a latency distribution or cold-start benchmark; an earlier trial took
3.35 s. It examines 0.71–1.29 million
selected terrain triangles, retaining 18,829–60,008 near the water for
intersection. Its vertex/UV export buffers occupy about **38–71 MiB**.
The three float raster readbacks total about **133.5 MiB** of CPU arrays;
this is diagnostic memory, not the proposed runtime coverage field. These
are allocation sizes, not a measured process-memory peak. The final four-pose
evidence directory is about **36 MiB**; development captures are separate.

The tool is opt-in and never imported by the production game. No production
runtime cost or FPS improvement is claimed. The earlier connectivity cost
benchmarks in [WATER_COVERAGE_COST_REVIEW.md](WATER_COVERAGE_COST_REVIEW.md)
still apply to their stated scope; this contact check does not validate a
new runtime solver or change those estimates.

Claude's request to prioritize this metric was sound. The evidence also
strengthens a narrower next experiment: **prototype connected coverage for
the marked shot 5 lake/outlet patch, at the existing water level, using the
current terrain data and genuine lake interior seeds**. Reuse the retained
closed-pocket test to prevent false filling. Apply the prototype in the
diagnostic branch first; require the marked lake edge to contact terrain,
and measure changes at both the lake and river boundaries before proposing
production integration. This targets the user's visible defect and exercises
the shared lake/river requirement directly.

A fresh camera-wide 1 m fill and additional width/rim/hold exceptions are
not justified by this checkpoint. A successful local patch would still need
stable world connectivity, geometry/LOD error control, junction handling,
movement tests and integrated cost measurements before becoming the full
solution. This checkpoint stops before that implementation for review.

Reproduction is documented in [the tool README](tools/perf/waterStepReview/README.md).
The compact [validation and threshold data](tools/perf/structured-terrain-results/water-contact-2026-10-15/final/validation.json)
and [capture metadata](tools/perf/structured-terrain-results/water-contact-2026-10-15/final/report.json)
support the tables above; each `*-contact.json` contains the individual edge
measurements and marked coordinates.
