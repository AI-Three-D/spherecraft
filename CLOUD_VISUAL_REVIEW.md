# Cloud renderer review and visual pass (2026-11-23)

This reviews Codex's Conventional and Neural lighting previews (CLOUD_PERFORMANCE_PLAN.md sections 23–25)
and records a visual pass made under a 5 ms cloud-stack budget on the M1 Pro at 1536×960.

## Where things stand

The game still starts with `cloudBudgetMode: 'off'`, the detailed renderer that measured 50–390 ms
in dense weather. Conventional and Neural lighting are opt-in previews behind Shift+K. Both previews
run the whole cloud stack (cirrus, ground shadows, raymarch, haze, composite) in 2.7–4.9 ms at
median. That is the 20–100× speed-up we asked for. The remaining work is about the look.

## Review of Codex's work

What is right and should stay:

- The density traversal was rebuilt the way the budget arithmetic required. The 2D weather cube
  replaces three to five 3D weather fetches per evaluation. A fixed log-spaced knot count bounds
  work per ray, and there is one shading point per ray instead of probes at every sample. Fixed
  overcast fell from 903 M 3D samples per frame to 33 M.
- Shader specialization by cloud shape and deck weight, workgroup shape tuning, and the cooperative
  suffix sum for sky columns in the bake were each measured and kept only when they paid.
- Evidence is good: per-pass GPU timestamps, matched motion metrics, ray work counters, and an
  in-game path-traced reference check for the cached lighting.

What needs to change:

1. **No image-quality metric on the final picture.** Every gate is timing, motion residual or a
   point-sampled lighting error at cache voxels. Nothing compares the displayed image with a
   reference. As a result the Conventional preview passed while it renders overcast, rain and storm
   decks as pale, flat white. The path-traced reference shows dark, structured bases (see
   `docs/neural_lab/contact-full.png`, rows 3 and 5). Add one image-level check per weather against
   the path-traced teacher or the old ultra renderer before tuning more constants.
2. **Hand-tuned analytic light.** The Conventional source term uses unfitted constants: `0.38` on
   single scattering, `0.055 + 0.034·…` bounce, and a sky fill floor of `0.27` driven only by a
   0.45 km sun probe. It has no vertical column, so the base of a 3 km deck receives about 70% of
   open-sky fill. Measured against the in-game path tracer, its sky light is 3.1×, 6.4× and 5.0×
   too bright from the ground under overcast, rain and a dusk storm. That is why decks render pale.
   The projected shadow is faded out above about 37° sun elevation, so at midday the deck's own
   column barely attenuates direct sun.
3. **The translucent-edge fallback causes visible halos in Neural lighting.** Rays below 0.85
   opacity blend back to the analytic source to reduce motion residuals. Because the analytic is
   several times brighter than the learned terms under a deck, every hole in a dark storm deck gets
   a bright white outline (storm at dusk from the ground).
4. **Calibration on evaluation scenes.** `bouncedSunScale` was tuned on the same game scenes that
   the path-traced table reports, so its grazing-storm improvement is not a held-out result.
5. **Unexplained 21–46 ms spikes.** These still occur with the GPU otherwise idle (rain turn:
   35.8 ms p95 in one of two runs, today). They span the composite or cirrus timestamps while the
   raymarch stays near 3 ms. A frame like that is a visible hitch. Find the cause before shipping
   either preview: pipeline creation on first use, a buffer map stall, or a readback are the usual
   suspects.
6. **Detail is filtered away with the step width.** The density footprint is
   `max(t·pixelAngle, width·0.42–0.72)`. A few kilometres out, the knot width sets it at 20× the
   pixel footprint, so near clouds in rain and overcast flights look like cotton wool. That keeps the
   64-knot march free of slicing, but the real fix is temporal: jitter knots per frame and
   accumulate with reprojection. The budget has room for a history buffer. The quarter-rate trial
   failed on edge opacity because it reprojected stale rays, not because accumulation is wrong.
7. **Orbital handoff runs both paths.** 5.2–5.3 ms p95 there is over budget. Cross-fade over fewer
   frames or skip the local march where the slab weight is already near 1.

## Changes in this pass

All changes are measured in the same session with matched before/after runs (warm 16 frames,
24-frame isolated stack replays, 96-path reference at contribution-sampled points).

**1. Sky light from the column above.** The analytic source (all of Conventional, plus Neural's
fallback outside the cache and on thin edges) now computes the cloud column above the shading point
with three coarse taps. These share p's weather texel. A log-linear fit to the path-traced teacher
turns the column into sky light (`conventionalLight` in
[cloudViewFields.wgsl.js](core/renderer/volumetricClouds/shaders/cloudViewFields.wgsl.js)). Held-out
lab error is 0.22, against 0.13 for the sky network and 0.42 for the game's old term. Codex's bounce
and single-scattering terms are unchanged. A bounce fit was tried and rejected because the shadow
map, its only sun-column source, is absent at low sun. With it the fit was 48× too bright in the
grazing storm; without it the fit was worse than the hand-set term
([columns.py](tools/neural/columns.py), [results](tools/neural/results/columns.json)).
`conventionalColumnLight: false` restores the old term for A/B runs.

Analytic sky light against the in-game path tracer (relative RMSE, bias in brackets):

| View | Before | After |
| --- | ---: | ---: |
| Overcast from the ground | 1.82 (3.06) | 0.63 (1.46) |
| Rain from the ground | 3.30 (6.43) | 0.81 (2.12) |
| Storm at dusk from the ground | 2.92 (4.97) | 0.52 (1.42) |
| Fair weather from the ground | 0.82 (1.79) | 0.52 (1.18) |
| Fixed overcast, inside | 0.88 (1.90) | 0.77 (1.65) |
| Overcast at dusk, above | 0.50 (1.49) | 0.40 (1.22) |
| Rain turn, dawn storm, grazing storm | 0.33–0.44 | 0.33–0.44 (bias 1.07–1.18, was 1.28–1.41) |

Raymarch GPU median changed by −0.04 to +0.06 ms in 15 of 17 matched pairs. Fair weather from the
ground costs +0.06 to +0.16 ms across three runs, since most rays there end on cumulus and take the
extra taps. One Conventional rain-ground pair read +0.41 ms. The same case measured ±0.01 ms in two
other runs, so it is treated as noise. [Conventional before/after](docs/cloud_review/conventional-sky-fit-before-after.png) ·
[timings](docs/cloud_review/conventional-sky-fit-timings.json) ·
[Neural timings and reference errors](docs/cloud_review/neural-sky-fit-timings.json).

**2. Narrower hand-over on translucent rays in Neural lighting.** The learned light now covers rays
from 0.3 opacity instead of 0.85 (`smoothstep(0.02, 0.3, opacity)`). The thick white outline
around gaps in the dusk storm deck is gone and the rain deck's lump rims are softer. Point errors at
cached points are unchanged (hybrid bounce 0.29–0.82, sky 0.18–0.31), and so is timing.
[Before/after](docs/cloud_review/neural-edge-handover-before-after.png) ·
[timings](docs/cloud_review/neural-edge-handover-timings.json). **Not yet measured:** the
reprojected edge residual that motivated the wide hand-over. Run Codex's motion A/B (section 25)
on rain turn and grazing storm before keeping it.

**3. Neural bake at 8 rows per frame instead of 12.** Bake median fell from 0.20–0.47 to
0.11–0.45 ms. Its p95 did not improve consistently, because timestamp spans are noisy at this size.
A patch now takes 8 frames to build instead of 6.

**4. Benchmark cases for decks seen from below.** `game-weather-overcast-ground`,
`game-weather-rain-ground` and `game-weather-storm-ground-dusk` were added. The weather presets had
no ground view, which is where the old lighting was most wrong.
[cloudNeuralReference.mjs](tools/perf/cloudNeuralReference.mjs) now scores whichever analytic
term is active.

### Cloud stack after these changes (M1 Pro, 1536×960, 576×360 cloud target)

| View | Conventional p50 / p95 (ms) | Neural lighting p50 / p95 (ms) |
| --- | ---: | ---: |
| Fair weather, ground | 3.15 / 3.46 | 3.37 / 4.20 |
| Overcast, ground | 3.07 / 3.83 | 2.95 / 3.12 |
| Rain, ground | 3.41 / 3.68 | 2.81 / 2.94 |
| Storm at dusk, ground | 2.73 / 3.53 | 2.88 / 3.02 |
| Rain turn and climb | 3.74 / 3.87 | 3.95 / 5.07 |
| Fixed overcast | 4.20 / 4.22 | 4.47 / 4.62 |
| Dawn storm | 4.59 / 4.62 | 4.84 / 4.94 |
| Overcast at dusk | 3.05 / 3.10 | 3.27 / 3.39 |
| Grazing storm | — | 3.63 / 3.76 |

Every view is under 5 ms at median. The p95 tail reaches 5.07 ms in Neural rain turn, from one
6 ms frame in a 24-frame replay. The dawn storm is the tightest steady case at 4.84 ms.

## Recommendations, in order of visual gain per millisecond

1. **Make Neural lighting the in-game default** once the motion check in change 2 passes. It costs
   0.1–0.3 ms over Conventional and is the only mode with dark, structured deck bases. Its learned
   terms are 0.18–0.31 sky and 0.29–0.82 bounce error against the path tracer, versus 0.33–0.81
   and 0.42–3.5 for the analytic.
2. **Give the bounce term a sun column at all sun angles.** The analytic bounce is still 1.5–3×
   too bright from the ground and 3–5× in the grazing storm. The neural bake already integrates a
   sun column per voxel (`lightColumn`). Outside the patch, a second channel in the ground-shadow
   pass, with the map plane kept valid at low sun, would let the column fit replace the hand-set
   bounce. The lab fit with a true sun column reaches 0.33 on held-out sun light.
3. **Temporal accumulation for detail.** Jitter the 64 log knots per frame and blend with
   reprojected history. That lets the density footprint drop back to the pixel footprint, which
   removes the cotton-wool look in rain and overcast flight. Budget about 0.3 ms for the history
   pass.
4. **Find the 20–46 ms hitches** before any default changes. They reproduce in rain turn with the
   GPU otherwise idle.
5. **Image-level reference check per weather**, so later tuning is scored on the picture.

## Message for Codex

> Review of sections 23–25: the traversal rebuild is right and stays. Three things to change.
> First, your gates never compare the final image with a reference, and the Conventional analytic
> was 3–6× too bright in sky light under decks seen from the ground. I replaced its sky term with a
> fit to the path tracer that uses three coarse taps up the column (CLOUD_VISUAL_REVIEW.md), so
> please keep that and add a per-weather image check. Second, the translucent hand-over to the
> analytic drew white rims around gaps in dark decks. I narrowed it to 0.02–0.3 opacity. Rerun your
> motion A/B on rain turn and grazing storm to confirm the edge residual is acceptable. Third, the
> 20–46 ms composite/cirrus spikes still happen with the GPU idle; please find them. After that,
> give the analytic bounce a sun column that exists at low sun and look at jittered knots with
> history for detail. Neural lighting should become the default once those pass.

## Reproduce

```sh
python3 tools/neural/columns.py
CLOUD_BENCH_GAME=1 CLOUD_BENCH_RUNTIME_LOOK=1 CLOUD_BENCH_WARM=16 CLOUD_BENCH_FRAMES=8 \
CLOUD_BENCH_ROUNDS=1 CLOUD_BENCH_ISOLATED_STACK_FRAMES=24 CLOUD_BENCH_NEURAL_REFERENCE_PATHS=96 \
CLOUD_BENCH_BEFORE_SETTINGS='{"cloudBudgetMode":"neural","conventionalColumnLight":false}' \
CLOUD_BENCH_AFTER_SETTINGS='{"cloudBudgetMode":"neural"}' \
CLOUD_BENCH_CASES='^game-(history-turn|weather-(overcast-ground|rain-ground|storm-ground-dusk|overcast-fixed|storm-grazing))$' \
node tools/perf/cloudBenchmark.mjs http://127.0.0.1:8000 http://127.0.0.1:8000 /tmp/cloud-sky-fit
```
