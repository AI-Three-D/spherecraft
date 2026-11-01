# River session recovery — 2026-10-29

**Superseded visual acceptance:** owner rejected this result. Continue from
`RIVER_REBUILD_2026-10-30.md`; the current rebuild is NOT accepted or done.

## Active continuation (supersedes material state below)

Latest owner priority: the even brown rim and regular sawteeth are the biggest
problems. Mud should be underwater, at most a tiny peek above it. Bring grass
to the visible waterline, vary the transition, use judgment and iterate. Also
continue fixing the recovered geometry issues; do not stop at another handoff.

Production changes as of 21:00 local:

- Shore weights are now mud/rock/grass. Grass replaces the old exposed mud
  band, fading into the biome. Mud begins 0.05–0.35 m underwater and becomes
  full at 0.4–1.1 m; existing broad noise varies those depths. Steep slopes
  retain their biome rock. No new texture/noise fetches. The exact latest
  owner pose is `o29-owner-waterline` in `ownerViews-2026-10-29.json`.
- Splat kernel 1 → 3 softens diagonal material staircases. Fixed material
  families skip their unused sparse-ID support halo. Padding stays at three
  texels, as before, so the larger filter does not expand source generation.
- Valley handover distance/gradient now uses the same joint blend as section
  heights. Isolated worst sampled jump 0.1843 → 0.0394 m, mean 0.01116 →
  0.00573 m; the old 0.167 m joint is 0.0062 m. Smaller-epsilon checks pending.
- Mouths round the union of natural lake shore and channel wet-edge distance.
  Radius 32 m, slope 0.15, near-water-level only, with a shore-height envelope
  fading at 1–2.5 m before the 3 m lookup cutoff. Config in RIVER_SECTION.mouth.
  Uses the existing lake query, ignoring the lagging guard weight for lookup.
- The first rounded-mouth trial exposed the river ribbon's straight edge.
  `nearRiverOverLake` now hands over to the lake sheet over 0.1–0.3 m above
  its level (previously 0–0.1 m). `mouth-join-gentle-handover` wet/dry views
  show the prominent tips rounded and the newly exposed straight seam gone.
- Absorption defaults are 3×, [2.7,1.2,0.9]. Same-scene 2×/3× comparisons
  showed broad shallow beds reading as water, while the wet toe still shows.

Evidence: `tools/perf/structured-terrain-results/river-2026-10-29/`.
`underwater-mud-new` has the exact owner waterline, with the exposed brown
stripe gone. `mouth-join-gentle-handover` has the accepted geometry treatment.
Earlier linear/cubic/sixth-power dry mud and unenveloped mouth union trials
are superseded. Global joint normalization and increased section softness
were rejected. Subtle triangular hillside shading still needs final review;
do not claim every crease is gone.

Final sweep completed (`final-base-a` → `final-grass-mouth` → `final-base-b`):
all 16 owner views, wet/dry, fixed 2160×1350 canvas / 1440×900 screenshots,
no GPU errors. Reports include full source replacements applied only in
`/private/tmp/spherecraft-river-experiment`; main worktree never patched by the
controller. Reproducible sweep config `/private/tmp/river-final-sweep.json`.

Verified numerical results:

- All 653 dry samples in three cross-sections have mud weight 0. Shore
  coverage stays ≤1 within float roundoff (~3e-8).
- 80 bend-bank samples (river453 points16–25): max extrapolated jump at
  epsilon 0.125 m falls 0.19531 → 0.00812 m (natural max 0.00946 m).
  At the old worst key, it is 0.19531 → 0.00421 m. Epsilon 0.5 max
  0.18427 → 0.03937; epsilon 0.25 max 0.19336 → 0.00977. The residual
  decreases with sample spacing; the old jump did not.
- River2564 mouth: 253/1656 sampled cells lowered by >1cm, max 1.36 m;
  no ground raised. Wet/dry captures confirm the rounded corner.
- Exact owner's waterline: brown pixels in ROI x350–1199,y150–849 (R/G>.90,
  B<G, 45<G<140) fall 180781 → 0. This is a visual heuristic, not a geometry
  measurement. See `final-owner-waterline-before-after.png` (old left).
- The temporary rounded-mouth seam at x625 is removed by the gentler surface
  handover: mean RGB step in y700–849 falls 15.96 → 0.70 levels.
- Exact same 80 addresses, warm-up plus three GPU rounds: base A 501.90 ms,
  new 499.12 ms, base B 501.46 ms (medians). Within repeat spread.
- Median paired frame change over seven shared views is -2.5%. One close
  view (`o29-wide-rim`) is +0.49 ms / +5.2%, so do NOT yet claim every view
  has unchanged performance. All other shared views are faster or nearly
  equal. Base A tan-saw has a 28 ms outlier vs base B/new ~12.5 ms.

Focused frame repeat completed (`frame-repeat-final`): three 120-frame
rounds after 30 warm frames give medians 9.2449 / 9.2711 / 9.2791 ms at
wide-rim, versus base A/B 9.3193 / 9.3022 ms. The initial +0.49 ms did not
repeat. No repeatable frame or generation cost increase in these checks.
Raw timings and metrics: `final-metrics.json`. Controller config for the
long repeat is `/private/tmp/river-final-review.json`; full sweep saved as
`/private/tmp/river-final-sweep.json`. Controller exited successfully,
all eight isolated source files restored, temporary Chrome/server confirmed
closed by process check. No production changes after the full test run.

Before/after images (old left, final right):

- `final-owner-waterline-before-after.png`: exact owner's latest position.
- `final-mouth-corners-before-after.png`, `final-mouth-bottom-before-after.png`.
- `final-wide-rim-before-after.png`, `final-hillside-before-after.png`.

Visual review: main uniform brown rim is gone; grass reaches the water.
Prominent corners in o29-mouth-bottom and o29-mouth-corners are rounded.
Broader triangular hillside creases and corners at some descending outlets
(e.g. o28b-seam-a/b, o26-mouth-blur) remain; do not claim all geometry is fixed.
The tan-ground material line is softened but still detectable in o26-tan-saw.
No broad extra geometry changes were adopted to hide those remaining issues.

Latest full tests after combined production changes: 524 pass, 1 failure of
525 (82 files). Failure `wizard_game/WorldConfigLoader.test.js:7` expects
pixelRatio 1, but unchanged HEAD already configures 1.5. Confirmed independently
on base457ef72 in `/private/tmp/spherecraft-river-base-457ef72`. No test changes.
`git diff --check` passes. No commits; leave the owner's unrelated edits alone.

Final verification complete for this set of changes. No commits. The owner
should judge the new shoreline in the game after reload; remaining broader
geometry issues are described above so they are not mistaken for fixed.

Recovered session: **Analyze river and lake seams**, thread
`01a187c6-6e1e-7463-b36b-f2571047d86f`. Its intact JSONL is at
`~/.codex/sessions/2026/10/29/rollout-2026-10-29T15-08-10-01a187c6-6e1e-7463-b36b-f2571047d86f.jsonl`.
It contains 308 records (about 60 MB, mostly capture images). Do not edit it.
The session ended during a water-absorption comparison, after implementing
the shore-material change below. The newer **Recover spherecraft lake seams**
thread was an interrupted recovery attempt, not further river implementation.

Read `RIVER_HANDOFF_2026-10-29.md` and the owner rules in
`RIVER_HANDOFF_2026-10-28.md` before continuing. Base commit is `457ef72`,
branch `water-ponds`. Commit only when asked; preserve the owner's concurrent
edits listed in the handoff. No commits were made during recovery.

## Recovered request and implementation

The owner wants river/lake junctions to read as one natural water body:
remove inward bank corners, muddy mouth shelves, bank walls continuing into
lakes, sawtooth material edges and hillside pinching. Diagnose with one-term
A/Bs before fixing, inspect wet and dry captures critically, and keep frame
and tile generation cost within measurement noise.

The specific material request is a delayed terrain-to-mud blend: start at
the existing outer rim, retain mostly terrain through the first three
quarters, then reach full mud at the waterline or a varying 1–2 m inland.

Current uncommitted production change: `core/world/water/riverCarve.wgsl.js`.
`riverCarveShoreMud` supplies the delayed curve to both river and lake
materials. The river profile is inverted to anchor mud to the waterline
rather than the wider bank-full half-width. Terrain heights, trace output,
water ownership and resource bindings are unchanged by this material work.
The original session also added `tools/perf/riverBanks/shoreProbe.js` and
`ownerViews-2026-10-29.json` (untracked).

## Evidence already recovered and checked

All evidence paths below are relative to
`tools/perf/structured-terrain-results/river-2026-10-29/` (untracked).

- `baseline-extra`, `baseline-o28-run`: original wet/dry/material captures.
- `candidate-shore`: 15 saved views with water, without water (`dbgw10`),
  and material weights (`dbg106`), plus bank transects and tile timings.
  `*-before-after.png` comparisons put the baseline on the left.
- `baseline-shore` versus `candidate-shore`: integrated mud weight on dry
  bank samples drops **41.55%, 53.89%, 48.64%** at mouth-corners,
  hillside-pinch and wide-rim respectively. Sampled heights are identical.
  This measures material weight, not a percentage reduction of image pixels.
  Full-mud reach at the six sampled water edges is about **1.29–1.93 m**
  inland, estimated by interpolating height crossings at 0.5 m spacing.
- Nine matched views in `base-perf-repeat` and `candidate-shore` average
  **10.867 ms** and **10.829 ms** GPU span. Maximum absolute per-view
  difference is **0.136 ms**. GPU generation of 80 tiles: baseline
  **265.5 / 261.7 / 255.2 ms**, candidate **261.3 / 256.0 / 260.0 ms**.
  These runs are consistent with no measurable cost increase, not a speedup.
- Recovery validation: **49 tests pass** across `riverSection.test.js`,
  `waterWgsl.test.js`, `terrainCompute.wgsl.test.js`, and
  `fixedMaterialBed.wgsl.test.js`, including generated WGSL validation.
- The visual improvement is narrower dry mud bands. The muddy shallow lake
  shelf, pointed mouth corners, tan material teeth and hillside creases
  remain visible. Do not describe the junction geometry as fixed.

## Absorption experiment completed after recovery

The crash left a headless Chrome using `/private/tmp/spherecraft-river-20261029`
running without its controller. It was closed before restarting captures.
Run only one headless browser at a time and close it afterwards.

`recovered-optics-default` and `recovered-optics-four` compare current
`[0.9, 0.4, 0.3]` absorption with `[3.6, 1.6, 1.2]` at four owner poses.
Both reports finished with no page or GPU errors. The doubled absorption
arm from the original session is also complete (`absorption2`).

The fourfold setting reduces the brown bed visible underwater and makes the
mouth shelf more uniformly turquoise. The dry rim and pointed bank tips
remain. A fixed mouth-shelf patch (x 700–899, y 500–599) averages RGB
`[98.72,117.41,105.28]` at default and `[64.47,130.20,119.81]` at fourfold;
this is a colour measurement, not a geometry or shoreline metric.
`recovered-optics-four/o29-mouth-bottom-before-after.png` shows default left,
fourfold right. The production absorption default has not been changed.
The owner previously requested see-through water, so a global opacity
increase carries a real appearance tradeoff.

## Geometry verification after recovery

The original `baseline-depth` / `no-lake-rims` numerical comparison sampled
river **453, point 22**, while `o29-mouth-corners` is on river **2564,
point 16**. Original no-rim screenshots do cover the correct poses, but the
old height-map identity must not be cited as a numerical mouth-corner check.

An isolated checkout at `/private/tmp/spherecraft-river-experiment` now
contains the recovered material change. `/private/tmp/river-review.mjs`
with `/private/tmp/river-geometry-recovery.json` captures the actual mouth
and hillside, then samples river 2564 in an 80 × 120 m area at 2 m spacing
and a cross-section at river 453 point 25 at 0.5 m spacing. Arms:
`recovered-geometry-base`, `recovered-no-lake-rims`,
`recovered-no-containment`. Each removes one geometry term only and restores
the isolated source afterwards. No geometry term has been removed in the
owner's checkout.

The corrected no-rim comparison leaves all **2,501 mouth samples identical
at 0.01 m reporting precision**. The hillside cross-section changes by at
most **0.000122 m** (float precision). This supports retaining lake-rim
protection; it does not explain or fix the corners.

The no-containment arm also finished without page/GPU errors. It changes
only **4 of 2,501 mouth samples by more than 0.01 m**, by at most **0.03 m**,
and leaves the hillside cross-section identical. The pointed bank tips
remain in the images. No rim or containment removal was kept. Diagnostic
arm frame times are not used as a performance comparison: these are
different shader variants and their scene rendering times shifted markedly.
The unchanged-height shore comparison above remains the performance check.

All recovery captures completed and their headless Chrome closed. Remaining
cause-level work is the shoreline/cross-section junction and the far-field
blend across segment joints (see the handoff); both remain hypotheses for
the unresolved geometry. The sawtooth boundary also remains visible. The
verified material change should be reviewed independently of those items.

Copies of `river-review.mjs`, `river-geometry-recovery.json`, and
`river-optics-recovery.json` are saved beside the evidence directories. The
JSON configs specify absolute local checkout paths; recreate or update the
isolated root before re-running them. `recovery-summary.json` contains the
bank and performance metrics. The harness restores experimental source in
`finally` and closes Chrome on normal completion; an abruptly killed
controller can leave Chrome behind, as the recovered crash did. Check its
profile before relaunching. Continue from these reports rather than
re-reading image-heavy transcript tool output.
