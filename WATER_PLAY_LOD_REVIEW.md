# Water shores in play: LOD and depth checkpoint

2026-10-17 measurements; budget updated 2026-10-18. **Coarse shore geometry
occurs in play, but neither tested detail floor meets the user's frame budget.** Adaptive resolution does not coarsen
terrain in the current defaults. Smaller windows and temporary streaming
fallback do expose coarser terrain near the shore. This round answers that
question, classifies the 21 fine-view flags, and measures two local detail
floors. It does not change normal production rendering.

## Does coarse terrain actually appear?

Yes, for reasons beyond the manual 768 setting:

- The live camera test kept traversal threshold **512** and reference screen
  height **1,350** throughout. During smooth fast movement, adaptive pixel
  ratio fell to **0.70** and the speed diagnostic scale reached **1.34**, but
  visible selection stayed at scale **1.0**. Settled near-shore tiles did not
  fall back during this short route. This confirms the current code's policy.
- On initial arrival, resident parent data was used at shore samples as close
  as **365.8 m**. The deepest requested tiles were depth 9, temporarily backed
  by depth-6/7 data. This is a loading/residency issue, not adaptive resolution.
  A slower GPU could prolong it; this round did not simulate a slower GPU.
- A normal **960 × 600 CSS-pixel window**, still at threshold **512**, selects
  the same 76-tile terrain set as the previous 1440 × 900 window at threshold
  768. Terrain selection scales with actual window height. The mask stays
  identical, but substantial gaps appear at **550–909 m**, not only beyond 1 km.

The small-window diagnostic flags 301 edges, including 191 with minimum span
drop above 25 cm. At those 191 neighbours, an independent unclipped-water
probe measures **0.256–1.117 m** above the rendered terrain; all reject water
through the mask. These are substantial coverage/terrain mismatches. Numerical
limits on the precise edge count are noted below.

Code references: `_getLodScreenHeight` and `_updateAdaptiveLodScale` in
[GPUQuadtreeTerrain.js](core/world/quadtree/GPUQuadtreeTerrain.js),
[AdaptiveQuality.js](core/AdaptiveQuality.js), and the runtime's
`gpuQuadtree.adaptiveLod` defaults. The adaptive controller responds to motion,
not measured GPU frame time. The older runtime comment saying speed increases
the visible threshold omits the current visible-selection cap.

## The 21 fine-view flags

The same original 21 flags were reproduced. Two diagnostic depth tests changed
neither coverage nor terrain:

| Test | Original flags recovered |
|---|---:|
| Allow equal depth (`less-equal`) | 19 of 21 |
| Keep strict depth, increase near plane 16× | 21 of 21 |

The remaining two flags share **one non-water pixel**. Their minimum span
drops are 5.023–5.035 cm, barely above the 5 cm threshold; the independent
water probe at that pixel measures 3.295 cm. They disappear with better depth
precision. The near plane in this view was 0.554 m; the diagnostic raises it
to about 8.86 m. This is a depth-precision classification, not a proposal to
clip nearby objects in production. Nor is it a new missing-mask defect.

At default terrain detail, the corresponding classification is 38 depth ties,
six additional flags recovered by the near-plane test, and eight actual mask
rejections. All 44 depth-related flags recover with the precision test.

## Local shore detail: effect and cost

The bounded experiment takes the already acquired shore height pages, requests
their relevant terrain ancestors within approximately 1.1 km, and patches the
traversal compute pipeline in browser memory. It retains detail only in those
tiles and the siblings required by the quadtree. It never widens the mask.
Literal packed keys are diagnostic wiring for this planet, not a proposed
production page format or a global-water dependency.

| Small-window candidate | Visible terrain tiles | Flags | Mask-rejected flagged neighbours | Full render median |
|---|---:|---:|---:|---:|
| Mask, normal terrain | 76 | 301 | 289 | 6.25–6.50 ms |
| Shore floor at depth 9 | 88 | 14 | 2, at one pixel | 8.00 ms |
| Shore floor at depth 10 | 130 | 8 | 0 | 11.25 ms |

Both detail floors eliminate flags whose whole span exceeds 25 cm. Depth 9
leaves one mask-rejected pixel with a probed **14.9 cm** drop. Its other 12
flags are depth ties. Depth 10's eight flags are all depth ties.

All mask hashes match the prior checkpoint:
`491dbb6a18340e177355cd21c6c51669fdddfc70a29403a270a719e7f28bbbe8`.

The depth-10 request covers 40 shore tiles and adds 54 visible tiles, including
siblings. It costs about **4.75 ms/frame** over mask-only rendering in its
paired run; I reject it as the default policy. Depth 9 requests 14 shore tiles,
adds 12 visible tiles and costs about **1.75 ms/frame** over mask-only in its
paired run. The user's subsequent requirement of negligible added frame time
rejects this option too. Assess visible pixel width and whether water-coloured
terrain conceals the gap before requesting more geometry. One tested region
is not enough to establish a universal detail policy.

Timings are fenced render medians from the existing frozen A/B/A capture,
with live streaming settled beforehand. They include all drawing work, not
isolated shader sampling. The depth-9 run's original-coverage baseline/replay
varies by up to 0.5 ms, so treat its incremental cost as approximate. New
traversal compilation is excluded from steady-frame timings and must be
scheduled before publication in a runtime implementation.

Screenshots:

- [Normal small-window mask](tools/perf/structured-terrain-results/water-play-2026-10-17/final/o4-star-small-window-contact.png).
- [Local depth-9 floor](tools/perf/structured-terrain-results/water-play-2026-10-17/final/shore-depth9/o4-star-small-window-shore9-contact.png).
- [Local depth-10 floor](tools/perf/structured-terrain-results/water-play-2026-10-17/final/shore-detail/o4-star-small-window-shore-contact.png).

## Live review and remaining integration

[preview.html](tools/perf/waterStepReview/preview.html) provides visible controls
for jumping to o4-star, toggling the cached mask and retaining shore detail
in the running game. It keeps normal game updates and camera movement active.
The preview deliberately identifies its current scope: one cached region.
It is not the completed background streaming service.

```sh
node tools/perf/waterStepReview/preview.mjs --open
```

The next production step still needs sparse shore pages, background generation,
camera-driven prefetch/eviction, atomic publication and handling of unavailable
terrain detail. It must reuse the stable source, preserve dry ridges, and avoid
showing a cached fine boundary over temporarily coarse parent terrain. The
preview does not claim these requirements are finished. River terrain and
levels remain unchanged; the accepted narrow-bank constraints still apply.

## Validation and self-review

The normal and fine 900-pixel-high captures pass all existing checks. The
600-pixel-high captures pass replay/source/terrain checks and have no browser
or GPU errors, but their largest water-position cross-check is **5.686 mm**,
above the existing **5 mm** gate. The identical discrepancy occurs in both
baseline and candidate. The strict validator therefore marks those captures
invalid; I have not silently relaxed it. Treat exact span counts as provisional.
The independent actual-water probe confirms the metre-scale small-window
failure and separates mask rejections from depth failures, so the decision
that coarse shore terrain needs attention does not rely on that small excess.

The live route sampled 181 coarse shore points, including points outside the
final visible shoreline. Its residency check follows the existing loaded-layer
lookup; it is not a per-pixel reconstruction of material fallback throughout
motion. It demonstrates nearby coarse residency, not the visual duration of
every transient gap. A long flight, cache eviction and return remain untested.

The 24 relevant adaptive-quality, LOD-reference and contact-geometry tests pass.
Both modified traversal pipelines compile and render without GPU errors. Raw
results are in [final/report.json](tools/perf/structured-terrain-results/water-play-2026-10-17/final/report.json),
[depth-9 report](tools/perf/structured-terrain-results/water-play-2026-10-17/final/shore-depth9/report.json)
and [depth-10 report](tools/perf/structured-terrain-results/water-play-2026-10-17/final/shore-detail/report.json).
