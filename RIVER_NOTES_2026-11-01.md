# Rivers and lakes — what has been tried (2026-10-13 .. 10-31), and where to go

Sources: the owner's messages in every river transcript (Claude Code
a7836513, 60c66f9c, dfb52ce5; Codex/Astra 10-14..22; Codex 10-29..31), the
handoffs (WATER_ATTEMPT_HANDOFF_2026-10-22, RIVER_HANDOFF_2026-10-28/-29) and
Codex's notes (RIVER_RECOVERY_2026-10-29, RIVER_REBUILD_2026-10-30,
RIVER_FOUNDATION_2026-10-31, RIVER_REVIEW_2026-10-31). Codex's work is
committed as c0c1db0 (WIP); the state before it is 457ef72.

## The owner's bar (unchanged since 10-13)

- One natural body of water: no seams, rims, moats, walls, floating water.
- Rivers at least as rich as Whitewater: width 2–3x along a river, pools,
  constrictions, twists, varied banks (cut bank .. no bank, 50 m+ blends).
- River ends join lakes organically: rounded banks blending into the lake
  rim over a long distance, the bed blending into the lake bed, small deltas
  where the terrain suits them (narrow and rare is fine).
- Transparent shallows, visible bed, diving at close range.
- Verified on alpine lakes + steep rivers, plateau lakes and gentle terrain.
- Performance: no added frame cost to speak of; water must not add tile
  regeneration or pop in after load (startup is the place for water work).
- The owner's eye is the gate (8/10 needed; the 10-29 state got 3/10).

## What was tried, by theme, and how it ended

| Theme | Tried | Outcome |
|---|---|---|
| Coverage (10-13..18, Claude + Astra) | Three surfaces each deciding coverage (terrain water shading, lake sheets, river ribbons); profile-discard guard; per-pixel triangle connectivity (+3 ms); cached connected shore masks (+0.75–1 ms) | Floating lake water mostly fixed; outlets failed because the levels didn't fit the ground. Masks stayed; per-pixel connectivity rejected (cost). |
| Levels vs ground (10-17..22) | River level fitted within 4 m of the line flooded cross-slopes; option "narrow raised banks ≤ 0.3 m" (owner's choice) | Built 10-22 (riverSection contain). Stair steps gone. |
| Terrain detail (10-22) | Detail by ground height (`lodHeight=ground`) | +2.9 ms; owner deferred. Width variation was not hidden by detail after all. |
| Bed material (10-24..26) | Rock/grass bed ("tiled road"); 4th splat slot swap (seam); final-colour mix (cream rim); per-pixel river/lake lookups (3.3 ms) | Replaced by one MUD tile for river and lake beds (owner's idea). Lesson: sub-metre material edges and 3–6 m noise lobes draw teeth on the splat grid. |
| Shape (10-25..27) | Wider (12 m; a third 3–4x), deeper (1.6 m), segment-joint blend ("scales"), wl-relative lake rims (hillside facets), head-on approach to lakes | Kept. Distance-difference joint weights made creases (rejected). |
| Mouths, analytic (10-27..29) | Held outlets, basins under lake water, valley return 60 m, give-way fixes, sill removal, deltas on low ground | Each fixed one seam; new ones appeared elsewhere. Rejected: funnel by width, lateral onset, side-mud handover, height floors/clamps. |
| Shore look (Codex 10-29) | Grass to the waterline, mud only underwater, wider smoothing, 4x absorption | Owner: "crap now… the muddy rim looked nicer"; rims looked unnatural everywhere; 3/10. |
| Mouths, analytic fan (Codex 10-30..31) | Wide analytic fan (riverMouth.js), lake mask widened, continuous river level (accordion fixed), smoothed hand-over level (cyan wedge), splat filter 1 → 5 | Better shapes, but ~+2 ms at mouths; many perf attempts failed (split draws, local segment search, skipping covered quads, shared shading). |
| Shared grid water (Codex 10-31) | One regular-grid water mesh per junction | Rejected: clipped domain drew polygon cut-outs; unclipped flooded unrelated hollows. |
| Junction fields (Codex 10-31) | 2D bed/bank solve per mouth on a 2 m grid, baked in a worker, sampled by terrain generation; existing water meshes kept | Rounded mouths, no trench end, bed rolls into the lake. Not yet seen by the owner. Costs and defects below. |

## Why the same problems keep coming back

1. **Many definitions of "where the water is".** Lake mask, drawn lake
   water, natural waterline, the river's pool/guard flags, give-way, ribbon
   coverage, terrain water shading. Most seams were one rule gating geometry
   or material while another decided what is drawn. Fixing one pair exposed
   the next.
2. **1D cross-sections for 2D places.** The carve is a profile across the
   nearest traced segment. A mouth, delta, confluence or the inside of a bend
   is a 2D shape; built from segment profiles it gets joints, creases,
   nearest-segment switches and caps.
3. **Painted bands.** Materials set by thin analytic bands (distance from a
   line, from a waterline) on a 1 m splat grid read as uniform rims and draw
   sawteeth.
4. **Verification.** Captures of one gentle area, and metrics that could not
   see the defect, let several "fixed" claims through.

Junction fields address 1 and 2 at the mouths: one 2D field defines the bed,
banks and wet area there, and terrain and water read it.

## Codex's junction fields: evaluation (2026-11-01)

What they are: per river–lake connection, a 2 m grid patch (up to 513²)
around the mouth. A GPU pass samples natural and carved terrain plus the
river and lake data; a worker floods the lake basin, builds a smooth union
of river and basin, and relaxes bed and water level (screened Poisson,
cut-only). Terrain generation samples the result within 128 m of the mouth
(fading over 48 m); the water shaders use its basin distance to pick the
lake as owner inside the patch. JunctionFieldService bakes patches within
1.8 km of the camera, one at a time, publishes the nearest 16 and
regenerates the tiles under each.

Measured against the analytic fan alone (riverMouth.js, Codex 10-30), on
the owner's views:

- Most of the "new mouth" look (the rounded, widening opening) comes from
  the analytic fan; with fields off the corner view is nearly the same.
  The fields add a smoother, more gradual flare at narrow mouths (moat
  view), a continuous bed into the basin, and lake ownership that makes
  some views cheaper (moat 11.5 vs 12.6 ms, corner 12.5 vs 13.2 ms).
- Mouths now stack three mechanisms: the segment carve (basins under lake
  water), the analytic fan, and the field over both near the mouth.
- Costs: a bake per patch (2.0–4.3 s before today, 0.6–1.6 s now), then
  tile regeneration under it: mouths reshape after load. As the camera
  moves, patches beyond the nearest 16 are unpublished and their tiles
  regenerate again.

Verdict: worth continuing. A 2D field is the first mouth representation
that can hold one definition of bed, banks and wet area, which is what the
1D cross-sections kept failing at. Its defects so far were in how it was
wired, not in the idea: the two found today were both inputs that did not
match the terrain the tiles draw. What it needs next:

1. Bake before the tiles need it. Fields should be ready when the rivers
   are published (same pipeline, startup for the spawn area), so tiles
   are generated once with them. Owner rule: water must not pop in.
2. One mouth mechanism. Where a field exists, the analytic fan and the
   segment carve's mouth terms should not also shape the ground; the
   field's reference should be the terrain without them.
3. A correct "natural" reference. The hydrology sampler's natural terrain
   has no river valleys; tiles have them. Any field value built on
   natural samples differs from the tiles by the valley (today's arc).
   Sample a valley-shaped, uncarved reference, or store the field as a
   change against the carved samples (tried today as an A/B: works for the
   unchanged cells, but the core path then has to run the full carve).
4. Frame cost: the fan's wide river ribbon still costs ~1.5–2.8 ms at
   mouths against 457ef72 (Codex measured it; unchanged today).

## This session's changes (2026-11-01)

| Commit | Change | Evidence |
|---|---|---|
| c0c1db0 | Codex's work committed as WIP (revert target 457ef72) | — |
| 10be9d0 | Micro detail kept at mouths, never crossing the drawn water's level | `river-2026-11-01/micro-level-v4`, `micro-perf` |
| 92eaa66 | Field bake 2–3x faster (batches, active-cell solve; same output) | `bake-timing*` |
| 7d5ab7a | Field cells start at their target; cells away from the river stay carved | `arc-probe`, `init-target-carved`, `final-sweep` |

How each cause was found (one-term A/B each; guesses that failed are
listed so nobody repeats them):

- Plastic banks: micro detail off over the analytic fan's footprint
  (`mouthKeep`). Field off, collar relaxation off and "cut" representation
  changed nothing visible; micro on restored the relief and brought back
  puddles. The clamp first used the highest nearby level (lake beside an
  outlet) and kept the puddles; the water debug view (w6) showed the river
  ribbon draws them, so the clamp follows the drawn water's owner.
- Hillside arc (o29-hillside-pinch): collar relaxation off, the core
  shortcut off, full influence, and !known cells carved each changed
  nothing alone. `tools/perf/riverBanks/fieldCreases.js` (step map next to
  rule categories) showed cells beyond the 40 m collar kept their initial
  value, the valley-less natural ground. Fix needed both that and the
  !known cells at 110 m.

Open: frame cost at mouths; startup baking and the 16-patch churn; the
analytic fan + field overlap; owner's look at the mouths (8/10 gate).

## Round 2 (owner on the hillside capture: "not sufficient")

Owner marked a pinch where the river opens into the mouth fan, and stripes
on the hillside inside the bend.

**Pinch.** Lighting-only (debug 91) and base-colour (43) views: the ground
at the neck is smooth; the pinch is the water's outline. The river surface
stays narrow at its level down the slope; the lake's flat water floods
where the field cut below lake level; the result is a bottle with hard
shoulders. Tried and rejected (captures under `river-2026-11-01/`):

- Longer transition (`blend-radius`, 96 m / 128 m): a straight-sided
  triangle, then a canal with near-vertical walls cut into the hill.
- Field wet domain = the fan width the river surface is drawn over
  (`fan-domain`): the same view unchanged; the moat mouth got a wide flat
  trumpet with patchy edges.
- Deposited fan deltas (`delta-fans`, patch `delta-fan-attempt.patch`):
  built ground into the lake beside the mouth, but the river's channel
  follows the shore there and the fan formed a land spit and a hooked
  channel (top-down `pinch-top`); not visible from the owner's camera.

Conclusion: at a mouth three things decide where water is drawn (river
ribbon width, lake sheet over ground below its level, the field's level),
and any widening shows where they disagree. Reshaping the ground does
not fix that. Proper fix: the field owns the water at a mouth (outline and
a level falling from river to lake), the ribbon and the lake sheet take
their extent from it, the analytic fan goes. Not built yet.

**Stripes.** Not shore mud (lake and river shore materials off: unchanged).
Carve off: gone. Joint blend off: one stripe per joint, much stronger. They
are the carve's steps where its nearest segment switches on the inside of
a bend: there both neighbours' joint weights are non-zero, so the blend
depends on which segment is nearest (10-29 handoff, open item 3). The
steps are small (lighting view smooth) but tip the slope-driven rock
weight: bands of rock, the owner's 10-25 "tiger stripes".
Fix (riverCarveStation): every joint of the run near the point gives its
share; their sum is a continuous station along the run; the two segments
it lies between are blended. With one joint in play it is exactly the old
joint blend (channel, water and earlier fixes unchanged).

Result: the station blend alone changed nothing on the hillside (pixel-
identical: no switching step there). Joint blend off showed one stripe per
joint, so the stripes are the joints themselves: each turns the hillside's
slope over a band only half a segment long. Wider bands (3x, 6x) removed
them, and the station blend is what lets a band exceed a segment without
steps. Kept: the band is unchanged within the channel + 8 m (where the
water's joint blend uses it: the 10-26 "stairs" were the two disagreeing)
and widens by 0.5 m per m beyond. Sweep `station-sweep` (15 views + top
view, wet and dry): dry views within 0.5 mean difference of HEAD, no pixel
over 24; stripes gone; tile generation 511-519 ms vs 501-546 ms (base/new/
base); no GPU errors.
