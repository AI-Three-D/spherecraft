# River work handoff — 2026-10-28

For the next session (Claude or Astra) continuing the river/lake work on
branch `water-ponds`. Read this first, then `IMPLEMENTATION_PLAN.md` (the live
roadmap). The older `WATER_ATTEMPT_HANDOFF_2026-10-22.md` describes Astra's
state before this work; parts of it are superseded below.

## How the owner works with you (non-negotiable)

- The owner's eye is the gate. Before saying something is fixed, look at the
  screenshots **critically and objectively** and say what is actually there,
  not what you hoped. Owner, 2026-10-27: "I do not want to hear an
  explanation … that you told me what you hoped to see in the pictures."
  Measure (pixel rows/columns, height profiles) before claiming.
- Isolate before fixing: when a visual artifact has several candidate
  causes, switch one term off (A/B) and measure. Every cause found in the
  last session came from such an A/B in one step; the three guesses made
  before each of them were wrong.
- Say your confidence before implementing. Small measurable increments:
  metric + baseline before a change, re-measure after.
- Performance bar: water must not add per-frame cost or tile regeneration
  cost beyond noise. Measure frame time (capture report `gpuSpanMs`) and
  tile generation (`regenTiming.js regenGpu`, 80 tiles) for every shader change.
- The owner edits the working tree concurrently. Never stage whole folders;
  stage your own files by name after reading their diff. Owner's files left
  alone: `docs/renderer-modules.md`, deletions of `docs/image.png`,
  `results*.txt`, `screenshots/…`, `tools/perf/terrain*Results.json`,
  `INTERIORS_*`, `VOXEL_*`, `vookseli.md`, `dev_harness/`.
- Commit only when asked. Delete removed code outright (no toggles kept).

## Where things are

URL the owner uses (dry view: add `&water=off`):

```
http://localhost:8000/wizard_game/standalone.html?regionalTerrain=0&regionalBanks=organic&riverSim=off&waterPrecompute=1&lodHeight=ground
```

Commits of this work on `water-ponds`: `55d6741` (mud beds, widths),
`6445886` (joint blend, in-lake cut fade, lake-bed mud, deltas), `35eb06f`
(water follows the joint blend, deeper rivers, rims relative to water),
`5f7a383` (rivers meet lakes head-on, held outlets, clean handovers).

Pipeline (per river):

1. **Trace** — `core/world/hydrology/waterWorkerCore.js` `solveRiver`:
   `traceRiverPatch` (priority flood on a 16 m patch) →
   `riverLakeApproach` (re-routes both ends to meet the lake head-on) →
   `smoothRiverPath` → shapes (`riverShape`, `riverReachShape`: width/depth
   noise, junction flare, **delta** via `riverDeltaProgress`) → delta
   deepening (`delta.frontDepthM`, 3 m) → levels (`riverValleyLevels`,
   `riverLakeHold`) → `riverHeldDepth` (outlet held at its lake's level:
   channel only between dry banks or into deep water within 24 m) →
   `outletDeepenM` ramp (0.4 m/point) → record (`RIVER_POINT_STRIDE`) →
   valley incision (`riverLandscape.js bakeRiverIncision`).
   All in `core/world/hydrology/riverRefine.js` + `waterWorkerCore.js`.
   **Bump `RIVER_SOLVE_VERSION`** (riverRefine.js, now 39) whenever trace
   output changes; caches are keyed by it.
2. **Carve** (tile generation, WGSL) — `core/world/water/riverCarve.wgsl.js`:
   `riverCarveTerrain_d` (per-segment sections, joint blend, containment
   floors = raised banks, `riverCarveUnderLake` gate), `riverCarveSegment_d`
   (section `riverSection_d` from `riverSection.js`, **in-lake cut fade**:
   `byShore` 12 m / `byDepth`, end fade past the last point),
   `riverCarveMicroKeep`, bed materials `riverCarveShoreWeights` (river mud
   + lake-bed mud by distance from the waterline).
3. **Water surfaces** (per frame) — `core/renderer/water/nearWaterSurface.wgsl.js`
   (river ribbons + lake sheets, cross-fade `nearRiverShare`,
   `waterLakeHitOnRay`), lookups in `core/world/water/waterWgsl.js`
   (`waterLakeHitIn`, `waterLakeEdgeCover`, `waterLakeGiveWay`, `waterRiverAt`).
4. The hydrology sampler (`core/world/hydrology/HydrologyGrid.js`) compiles
   its own copy of the terrain shader and binds group 1 itself: any new
   binding the carve uses must be added there too (garbage heights otherwise).

## Measuring (tools in the repo)

All headless, own server on :8233, system Chrome (see memory/reference on
headless WebGPU). A fresh `--profile DIR` needs the full precompute on first
load (minutes); reuse one profile directory between runs.

- Captures: `node tools/perf/riverBanks/capture.mjs OUT --profile DIR --poses tools/perf/riverBanks/sweepPoses-2026-10-27.json --only name1,name2 --url-extra '&lodHeight=ground' --debug-modes w10`
  - `w10` dry (no water), `106` material family weights (red mineral + soil
    bed share, green grass, blue soil), `w6`/`w7` who draws the water.
  - `--eval "<js>"` runs code after load (e.g. switch the valley off, then
    `tileStreamer.regenerateTiles(() => true)`), `--regenerate` adds `-regen.png`.
  - Report: `report.json` per pose `timing.gpuSpanMs.median` (frame), `gpuErrors`.
  - Always pass `&lodHeight=ground` (the owner's URL).
  - After a `RIVER_SOLVE_VERSION` bump rivers re-trace in the background:
    run the capture once as a warm-up, then again for the real images.
  - Poses: `sweepPoses-2026-10-27.json` (the 15-pose sweep + older owner
    views), `ownerViews-2026-10-28.json` (the five views below). Poses made
    by river fraction (`steep-453-middle` etc.) move when a river's length
    changes — don't compare those across trace versions.
- Page probes: `node tools/perf/riverBanks/pageProbe.mjs /tools/perf/riverBanks/<module>.js <export> '<json args>' --profile DIR --url-extra '&lodHeight=ground'`
  - `mouthProbe.js`: `lakeApproach` (angle metric over all river ends:
    sine of the meeting angle, metres within 30 m of the water; waits for
    tracing to settle), `riversAtViews`, `heightMap` (terrain relative to a
    level, lake `~`, river `#`), `junctionColumn` (per-pixel ground, lake
    signed distance, river), `riverPoints`, `riverTurns`, `riverSolveStatus`,
    `gpuErrors`.
  - `transectProbe.js`: `transectAt`/`transectNoValley`/`transectValleyOnly`
    (cross-sections), `profileAlong` (along a river through its lake end:
    carved vs natural, cut, lake level).
  - `regenTiming.js`: `regenGpu` (tile generation GPU ms, 80 tiles).
- Pixel tools (`tools/perf/riverMetrics/`): `sideBySide.mjs`, `rowPx.mjs`,
  `colPx.mjs` (mean RGB along a row/column), `diffMap.mjs` (amplified
  difference image), `stretchG.mjs` (contrast-stretch one channel to see
  2–3 level lines), `pngDiff.mjs`.
- Temporary debug views are a good tool: e.g. a water debug mode writing
  the ribbon's weight to red and the lake sheet's to green proved the outlet
  seam in one capture. Remove them before committing.

Last full sweep: `tools/perf/structured-terrain-results/river-bed-2026-10-26/sweep11/`
(`*-vs4.png`: left = before this round, right = now). Frame times
8.1–13.1 ms, same as before. Angle metric (354 ends): ends meeting their lake
under 30° 49 → 37; ends with > 60 m of their first 120 m near the water 69 → 44.

## Open problems (owner, 2026-10-28) — with what is known

Screenshots of these come with the new session. Their poses are in
`tools/perf/riverBanks/ownerViews-2026-10-28.json`; rivers identified with
`riversAtViews`. Causes below are leads, **not verified** unless stated.

1. **Muddy borders where rivers meet lakes** (`o28-muddy-border`: river 2551
   point 8, the outlet at the tip of lake 2808's shallow bay; also
   `o26-mouth-band`, river 455's outlet). Water there is only 0.1–0.6 m deep
   over mud, so it reads as mud. Leads: the lake's shallow edge itself
   (transparent water over the mud lake bed); the in-lake cut fade
   (`riverCarveSegment_d`, `byShore` over 12 m) ends a channel before the
   lake is as deep as the channel, leaving a shallow band
   (measured at river 455: water 1.43 m at the shore → 0.72 m at 16–20 m →
   1.07 m at 32 m); `riverHeldDepth` removes the channel on held outlet
   points with the lake on both banks. The owner wants neither a mud border
   nor a groove running into the lake.
2. **Unblended geometry / abrupt moat at river ends** (`o28-moat-end`: river
   454 point 18 of 21, the delta into lake 2808: half-width 27.5 m, water
   **2.87 m** deep). The delta deepening (`frontDepthM` 3 m, waterWorkerCore
   "The delta's bed deepens to the lake's depth") makes the bed deeper than
   the lake's shallow edge; the in-lake fade then ends it within ~12 m —
   a deep moat ending abruptly. The carved bed must meet the lake bed
   smoothly (C1 along the axis), never deeper than the lake around it.
3. **Walls around rivers** (`o28-wall`: river 458 point 34 of 84, mid-river;
   "many rivers"). Leads: containment floors (`riverContainFill_d`,
   `RIVER_SECTION.contain`: bank-full ≥ water + 0.3 m, crest, out slope)
   raising banks where the river's level sits above the ground beside it;
   `riverLakeRims`; the valley incision. Isolate with
   `transectNoValley`/`transectValleyOnly` and by zeroing the floor fill.
4. **Deltas muddy and too shallow** (`o28-muddy-delta`: river 2563 point 5
   of 19 is an *outlet's* held run in its source lake's shallow arm, water
   0.42 m; true deltas e.g. river 453/454 ends). Owner: deltas must be
   neither muddy nor shallow. The delta flare (`delta.scale` 1.6–2.4, a third
   3–4×) widens without enough depth across its width.
5. **Unnatural geometry at a delta's sides** (`o28-delta-sides`: river 453
   point 22 of 27, flare half-width 9 → 39 m into lake 2814; red arrow).
   Smooth dark troughs on both sides of the river and a patch with a
   different texture at the trough's edge. Seen from above (top-down at the
   end of 453): curved dark grooves beside the river remain with the valley
   field switched off, so they are not the valley incision; candidates: the
   carve's reach around the wide flare (`riverCarveReach`, joint blend of a
   39 m half-width), containment floors, micro-detail keep boundary
   (`riverCarveMicroKeep`, texture difference strip).
6. From the 2026-10-27 report, still open: 37 of 354 river ends still meet
   their lake under 30° (worst sine 0.11, river 461 start); sawtooth along
   mud edges on tan (desert) ground (`o26-tan-saw`, pre-existing: splat
   weight staircase); the scales view's uphill cut bank is a tall black band
   with a jagged top edge (`o26-scales`, river 453); a small mud-edge spike
   at `o26-mouth-blur` (mud rims, deferred by the owner); the delta at
   `o26b-delta` now meets the lake straight on and reads less like a delta.

## Lessons from the last session

- A river held at its lake's level is part of the lake: give it a channel
  only between dry banks or into deep water nearby, and count only the
  lake's mask as water (the outlet's own valley below the level is not lake).
- The flood path follows valley floors; any re-route must cost climbing
  against the *old path's* local level, not one global level (a global one
  let a steep river run across a hillside).
- Things that draw lines: a binary switch anywhere (gate at a mask edge,
  give-way switched at the solved water, micro-detail removal starting
  abruptly, depth jumping from 0 to full in one point). Fix with a ramp of
  several metres and make both sides compute the same weight from the same
  sample point (river ribbon and lake sheet now test the mask on the same
  view ray).
- When pixels don't change between versions, the cause isn't what you just
  changed — diff the images (`diffMap.mjs`) to find what did change.
