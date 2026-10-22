# Water: distance tolerance, sparse storage and frame cost

2026-10-18. **Sparse storage is verified; negligible frame cost is not.** The
GPU mask shrank from **5.72 MiB to 0.325 MiB**, with no changed image pixels or
coverage states. Normal terrain refinement handles the tested close bank.
The small-window distant shore still exceeds the proposed pixel allowance.
Neither blanket shore refinement nor the current mask shader is accepted for
production under the user's latest frame budget.

## What changed

The first variant moves the fine-mask query behind the existing lake index
and above-water rejection. The previous prototype queried it unconditionally
at the start of terrain lake lookup. Four frozen views produced **zero image
differences** between these two implementations. This verifies the index for
these captures, not every possible refined shoreline; production publication
must index the refined extent too.

The second variant encodes the same lake mask in **64 m pages**. Uniform pages
are implicit; mixed pages retain 4 m cell states and pointers to existing
0.5 m subcells. Refined states use two bits. Nothing is widened, resampled,
reconnected or assigned a new water level.

At o4-star the sparse publication has a 4.9 kB directory, 310 mixed pages and
915 implicit pages. It checks **373,501 distinct stored states**, with **zero
mismatches**, including every refined subcell. GPU allocation falls from
5,994,128 to 340,464 bytes: **94.3% less**. Three GPU captures are pixel-identical
to the dense reference. The close-bank region checks 377,659 states with zero
mismatches and occupies 357,904 bytes.

This is an encoding and shader experiment in `tools/perf/waterStepReview`.
The producer still builds the dense intermediate, retained for comparison,
then encodes on installation. Cached-source installation plus encoding,
verification and publication took 32–39 ms. Sparse production caching,
background construction and automatic camera-driven loading are unfinished.
Normal game rendering and river terrain/levels remain unchanged.

## Visible error, with normal terrain detail

| View | Original contact flags → candidate | Result |
|---|---:|---|
| o4-star, 1440 × 900 CSS pixels | 1,330 → 52 | Eight mask-rejected edges; the other 44 were classified as depth precision in the previous check. |
| Same bank, camera 45 m along the shore / 12 m above the target | 114 → 0 | No contact flags or unresolved spans. |
| Same bank, camera 12 m along the shore / 3 m above the target | 108 → 4 | All four are at a different shore about 224 m away; see the false-positive audit below. |
| o4-star, 960 × 600 CSS pixels | 838 → 301 | 289 mask-rejected edges; coarse terrain still exposes the fixed boundary. |

The camera distances name the offset from the inspected point, not the
distance to every shoreline pixel in the image. These are settled views,
not a proof for streaming transitions or every lake. No shore-detail override
was used. The normal/default and small-window mask hash remains
`491dbb6a18340e177355cd21c6c51669fdddfc70a29403a270a719e7f28bbbe8`.
The closer cameras request another fixed region; both share its hash
`f987032700d89122aba97a5a618d5c1f52a9599746abb104e7ab4e39ca6f296e`.

I measured the rejected sheet against the **actual rasterized water and
terrain**, and rendered terrain ownership separately with sheets omitted.
At the default view, the eight mask-rejected edge runs are only one or two
internal render pixels long. Their nearest ground contact is at most **1.20
CSS pixels** away. None is completely backed by lake-coloured terrain.

At the small-window view, nearest ground contact is up to **5.43 CSS pixels**
away, or **8.14 internal render pixels**. Ninety-four of the 289 flagged edges
are more than three CSS pixels from ground contact. Only nine outward runs
are entirely backed by lake-coloured terrain. These do not generally qualify
for the user's conditional allowance for a small, water-coloured distant gap.

The longest horizontal/vertical run is 16.67 CSS pixels, but that overstates
perpendicular width on oblique banks. The nearest-contact measurement avoids
presenting that long run as the gap thickness. It still samples pixel centres,
has roughly pixel-scale positional uncertainty, and only investigates flagged
edges. Saved screenshots have two device pixels per CSS pixel; internal
rendering here uses 1.5. These units must not be mixed.

Screenshots, inspected before this handoff:

- [Close bank, original](tools/perf/structured-terrain-results/water-pixel-budget-2026-10-18/final/o4-star-bank-12m-before.png) and [candidate](tools/perf/structured-terrain-results/water-pixel-budget-2026-10-18/final/o4-star-bank-12m-after.png).
- [45 m candidate](tools/perf/structured-terrain-results/water-pixel-budget-2026-10-18/final/sparse/o4-star-bank-45m-after.png).
- [Small-window marked shore](tools/perf/structured-terrain-results/water-pixel-budget-2026-10-18/final/sparse/o4-star-small-window-contact.png).

### Four false contact flags in the closest view

The raw check reports 1.74–1.85 m mean drops at four neighbouring pixels near
the left edge of the image, approximately 224 m away. Those values must **not**
be treated as real hanging water:

- The actual unclipped lake geometry covers all four pixels.
- Its sampled height is **1.6–15.2 cm below** the ground there, not metres above.
- The visible terrain is in front of that geometry; accepting equal depth or
  improving near-plane precision does not reveal water. Bypassing depth does.

The extrapolation of the preceding water triangle does not represent the
actual neighbouring water geometry here. Its within-triangle cross-check
does not catch this case. The last pixel's centimetre-scale sign lies within
the terrain reconstruction uncertainty; it likewise supplies no evidence for
a metre-scale gap. Raw flags remain in the evidence. Future classification
should use actual neighbouring lake geometry before accepting such a flag.
This round does not claim universal pixel-perfect contact from this metric.

## Frame cost: still a failed requirement

Twelve batches of 32 frames per condition, with GPU completion fences, measure
the whole frozen render. Baseline and replay bracket each candidate. These
are wall-clock render timings, not isolated GPU shader timestamps.

| View | Original before / replay | Sparse candidate | Extra versus baseline midpoint |
|---|---:|---:|---:|
| o4-star | 15.94 / 15.88 ms | 16.97 ms | +1.06 ms |
| Close bank, 45 m | 13.19 / 13.81 ms | 13.97 ms | +0.47 ms |
| Small window | 7.28 / 7.16 ms | 7.78 ms | +0.56 ms |

The close-bank baseline drifts by 0.63 ms, so its incremental figure is not
precise. The earlier dense indexed variant was also inconsistent: it improved
the overview, but one close-bank run was slower. **Neither experiment proves
negligible overhead.** Sparse storage did not produce a useful rendering speedup
over the broad-query dense reference: the paired differences were 0, +0.25 and
−0.125 ms. Reduced memory is a verified benefit; reduced frame time is not.

The next cost experiment should substitute cached coverage at the existing
lake-mask lookup, reusing its body coordinates and resources. The current
clone still adds a second coverage path and bind-group work. Measure that
replacement before committing to the production service. Do not solve the
budget failure by simply labelling a millisecond negligible.

## Validation and next checkpoint

All image replays, frozen-source comparisons and GPU/browser error checks pass.
The standard and close views pass the numerical capture gates. The small
window again has a **5.686 mm** worst water-extrapolation cross-check against a
5 mm gate, identically in baseline and candidate, so its strict validation
remains failed. Its exact flag count is provisional. The separate raster
probe and ownership pass support the pixel-gap finding without relying on
that extrapolated position. No gate has been silently relaxed.

Fifty-five relevant tests pass across the targeted runs, including connected
low banks, the closed pocket, cache invalidation, fine-height ridge retention,
contact geometry, LOD policy, raster runs and lossless sparse encoding. Rivers
and shot 5 were not modified or recaptured in this lake-storage checkpoint.

The previous [play/LOD report](WATER_PLAY_LOD_REVIEW.md) establishes that adaptive
resolution does not coarsen visible selection under current defaults, but
smaller windows and initial parent-tile residency do expose coarse nearby
terrain. Both tested blanket shore-detail floors are rejected on cost.

Next: make the existing coverage lookup cheap, then use measured screen error
to decide whether any limited shoreline refinement is actually needed. Keep
the local sparse pages, stable final-height source and large-planet constraints.
Complete background/camera-driven lake loading before the agreed river-bank
work. The rivers still require their separate outlet/level/bank fixes.

The review browser offers overview and close-bank viewpoints, reversible
original/sparse coverage, and an explicitly costly detail experiment. It is
a one-region preview, not the production streaming switch. Run:

```sh
WATER_PREVIEW_OUT=/tmp/water-live-review node tools/perf/waterStepReview/preview.mjs --open
```

The updated visible browser passed the toggle/restore check, advanced 31
terrain frames during the one-second liveness sample, and reported no browser
or GPU errors. It was left open with sparse coverage on and **normal terrain
detail**, at [the local review page](http://127.0.0.1:8201/tools/perf/waterStepReview/preview.html).
Its [live report](tools/perf/structured-terrain-results/water-pixel-budget-2026-10-18/final/live-preview/report.json)
is separate from the frozen cost measurements.

Evidence: [indexed report](tools/perf/structured-terrain-results/water-pixel-budget-2026-10-18/final/report.json),
[sparse report](tools/perf/structured-terrain-results/water-pixel-budget-2026-10-18/final/sparse/report.json),
[validation](tools/perf/structured-terrain-results/water-pixel-budget-2026-10-18/final/sparse/validation.json)
and [source manifest](tools/perf/structured-terrain-results/water-pixel-budget-2026-10-18/final/source-manifest.json).
