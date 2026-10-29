# River work handoff — 2026-10-29 (to Codex)

You are taking over the river/lake look on branch `water-ponds` (pushed to
`origin`), at commit `194d09c`. The owner wants fresh angles: three sessions
of local fixes have made the seams rarer but not gone. This file is the entry
point; `RIVER_HANDOFF_2026-10-28.md` has the owner's working rules (read its
first section, they are non-negotiable), the tool reference and the history
of sessions 1–3. `IMPLEMENTATION_PLAN.md` is the long-term roadmap.

## The goal, in the owner's words

Rivers and lakes should read as one natural body of water. Recurring
complaints: muddy seams and rims where a river meets a lake, the river's side
mud lines running on into the lake, bank "walls" running past the point where
the river crosses the lake's rim, a faint mud line at the end of the river
bed, abrupt moats, muddy shallow deltas. Owner on 2026-10-28: "good progress
… there are some more issues in addition to this one, but we are getting
closer". The owner judges by eye, in the browser; numbers support a claim,
they don't replace looking.

## State at 194d09c

The pipeline is described in the 10-28 handoff ("Where things are"). Changes
since it was written:

- `riverHeldDepth` and `outletDeepenM` are deleted. `RIVER_SOLVE_VERSION` is 47
  (`core/world/hydrology/riverRefine.js`). Versions 44–46 were used by
  experiments: use 48 or higher for the next trace change.
- Near a river's end, `riverCarveSegment_d` (`core/world/water/riverCarve.wgsl.js`)
  lowers ground under the lake's water into a **basin**: flat at the
  channel's bed, at least 1.5 m of water, sides rising over max(30 m,
  1.5 half-widths), setting in over 16 m from the waterline (natural depth /
  slope) and 8 m inside the drawn water's edge (`BASIN_*`).
- The carve's lake lookups ignore the lake's **give-way**, the rule that
  lets a river's water surface be drawn instead of the lake's where the
  river falls below the lake (`waterLakeHitView(..., giveWay)` in
  `core/world/water/waterWgsl.js`). Gated by it, the channel's edges stood as
  ridges 0.5–1 m high, 10–18 m into the lake.
- The cut fade for undrawn lakes (sea, unsolved lakes) applies only where
  the river is in the lake (`pool` < 0); beside a drawn lake it filled an
  outlet into a 0.9 m sill.
- The valley field returns over 60 m beyond the channel (`VALLEY_RETURN_M`).
  Bank blends rise at most 0.3 (`riverSection.js blendSlope`). Deltas flare
  only over low ground (`riverDeltaHalfWidth`).

The owner has not yet looked at 194d09c in the browser.

## Open, with what is known

1. **The lake's own shallow edge reads as mud** near junctions. The water is
   transparent (about 0.5/m absorption) over the same mud as the river bed.
   Lake shore mud is a band set by distance from the waterline
   (`riverCarveLakeBed`, 0–4 m onto the shore). River mud is set by distance
   from the river's line (`riverCarveRiverShore`, half-width + 0–8 m). Both
   are combined in `riverCarveShoreWeights`. A rule that made the river's
   mud yield to the lake's band changed nothing visible once the geometry
   was fixed, so it was reverted.
2. **The outlet's water falls before it leaves the lake.** At o28b-seam-a,
   river 2566 starts falling about 18 m before the natural rim. At
   o28b-seam-b, river 2563 falls about 33 m before it. This is the trace's
   level, not the shader. Lead, not verified: `riverLakeHold`
   (waterWorkerCore.js) holds only points whose banks lie within the drawn
   water, and the drawn water ends before the natural rim. It is why the
   give-way zone exists at all.
3. **Creases on the inner side of bends** of steep, incised streams.
   `o28-delta-sides` shows them (upstream reach): faint light streaks 5–9
   luminance units. They come from the carve's own far field (8–60 m out)
   and persist with the valley field off. They run along the joints'
   bisector planes. Far out on a bend's inside, the joint blend (nearest
   segment + its two neighbours) is not a partition of unity.
4. Narrow mouths meet the lake's shore in a sharp corner (o26b-stairs,
   o28-delta-sides).
5. Older items: 37 of 354 river ends meet their lake under 30°; sawtooth
   mud edges on tan ground (o26-tan-saw, a splat-weight staircase); the tall
   black cut bank at o26-scales; the mud spike at o26-mouth-blur.

## Observations that may help (not prescriptions)

**There is no single "edge of the lake".** Almost every seam found so far
was geometry or material gated by one definition while another one is what
you see. The definitions:

| Edge | Where | Notes |
|---|---|---|
| Solved region | Lake record `region`, solve spacing | Its signed distance `F` is on the GPU (`lakeMaskSdf.js`) |
| Drawn water | `F > -spacing/2` and ground below level (`waterLakeHitIn`) | `insideM` = metres inside this edge |
| Natural waterline | Ground at the level, 1 m terrain | On flat shelves it can lie far from both edges above |
| River's `pool` flag | Centre point in the worker's 16 m patch `lakeMask` (includes sea and unsolved lakes' graph cells) | Per record point |
| River's `lakeGuard` / `guardW` | Lake cells within 2 half-widths + extra of the line | Per record point |
| Give-way | River below the lake, channel's last metre | Rendering only |
| Shader distance from shore | Depth / max(slope, 0.02) | Meaningless on flat shallow shelves: 0.3 m depth reads as 15 m |

Measured along the two seam rivers:

- **o28b-seam-a** (lake 2825, level 746.31): the river starts falling at
  s ≈ 118 m. The CPU mask ends at about 122 m. The natural rim is at 136 m.
- **o28b-seam-b** (lake 2822, level 756.81): falling from 152 m, drawn edge
  157–160 m, natural rim 185 m. Between 160 m and 185 m the ground is below
  the lake's level but nothing draws lake water there.

Consequences seen this session:

- A width-based funnel for the basin made steep 1 m sides along a narrow
  arm's shore, because neither depth/slope nor `insideM` measures the
  distance to the visible shore.
- No reliable distance-to-visible-shoreline exists on the GPU today. A baked
  one, or a lake edge everything agrees on, would remove a whole class of
  seams. Weigh it against the performance bar below.

**The look is mostly materials over shallow water.** Dry views (debug `w10`)
of the seams are now clean. What remains in wet views is shallow transparent
water over mud, and mud bands. A different angle on shallow-water shading,
or on what the lake's shore and bed are made of, may pay more than further
geometry.

## Working method that found causes

- **Map, then A/B one term.** `tools/perf/riverBanks/mouthDepth.js depthMap`
  shows depth below a level in plan view, in a river's frame. Use
  `{ id, atS, alongM, acrossM, stepM: 2, mode: 'below', ref: <lake level> }`;
  `alongEnd` gives carved/natural/lake/level along the line. Run several in
  one page load via `probeBatch.js`. Then switch exactly one term off (edit
  the WGSL temporarily, re-probe) and compare maps. Each cause this session
  took one A/B. Each guess before it was wrong.
- **Captures:** `tools/perf/riverBanks/capture.mjs`, as in the 10-28
  handoff. Poses are in the repo:
  - `ownerViews-2026-10-28.json` (o28-*);
  - `ownerViews-2026-10-28b.json` (o28b-seam-a, -b);
  - `sweepPoses-2026-10-27.json` (sweep); the sweep also uses the built-in
    `steep-453-middle` and `plateau-2562-middle`;
  - `deltaPoses-2026-10-28.json`.

  Before/after results of this session are in
  `tools/perf/structured-terrain-results/river-2026-10-28/` (untracked; e.g.
  `seam-base` vs `seam-final`, `v47*` vs `v48*`; the `v48*` captures still
  had the reverted mud rule, which changed nothing visible).
- **Performance:** for every shader change, measure frame time (capture
  `gpuSpanMs`) and tile generation (`regenTiming.js regenGpu`, 80 tiles).
  Compare against a worktree of the base commit, interleaving base and new
  runs. Last values: about 11.1 ms over the six o28 views, and
  265 / 252–264 ms per 80 tiles.

## Pitfalls

- **Lighting drifts between captures** taken far apart: the sun highlight on
  water moves and haze changes. Before calling a wet-view difference a
  regression, compare sky and far-water pixels (`colPx.mjs`) or diff the dry
  views.
- **Probes must pose the camera over the river** (`qualityScene.js
  riverView`). Only rivers near the camera are on the GPU; otherwise the
  carve reads as zero.
- **Traces are cached by `RIVER_SOLVE_VERSION`.** A trace A/B needs a fresh
  number per arm. After a bump, run one warm-up capture before the real one.
- **The hydrology sampler binds group 1 itself** (`HydrologyGrid.js`). New
  carve bindings need entries there too.
- **Headless setup:** use system Chrome
  (`/Applications/Google Chrome.app`, not Puppeteer's bundled one).
  `puppeteer-core` comes from the sibling `../terrain-lab`. Run one browser
  per profile directory at a time. Reuse a `--profile` directory: a fresh one
  runs the full precompute, which takes minutes. The Mac crashed once during
  a long run of back-to-back captures, so keep runs lean.
- This machine's git has no `git worktree remove`. Delete the directory, then
  run `git worktree prune`.
