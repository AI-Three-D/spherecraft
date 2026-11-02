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

## Round 3: the pinch (2026-11-02)

Owner: "do whatever necessary to fix this" (narrow river opening into a
cone with hard shoulders at the hillside mouth, river 453 into lake 2820).

Found by one-term A/B on the owner's crop (`river-2026-11-01/neck-cause`):
both water-surface shortcuts off: pinch unchanged; the junction field's
terrain off: pinch gone (smooth funnel). The shoulders sat 63-66 m up the
river (`pixelsToRiver`), at the field's 64 m blend radius: the field cut
its flared opening into the steep hillside (27 % stream). Fix
(JUNCTION_LOW_GROUND): the field's influence fades where the natural
ground stands 2-6 m above its lake; there the carve's analytic fan shapes
the mouth, which is a smooth funnel on this slope. Gentle mouths (moat,
corner) lie low and keep the field.

Tried and rejected this round (patches in `river-2026-11-01/attempts/`):
- Designed outline (trumpet + fillet + bank, `outline-design`): canal-like
  benches across the hillside.
- Round fillet between river and lake water (`fillet2`): cut only the two
  corner tips, a few metres; pinch unchanged.
- Width taper toward the mouth (`taper`, trace v52): the trace widths were
  not the cause; pinch unchanged.
- Fan blended by width instead of heights (`width-blend`): unchanged.
- River surface discarded in the field's basin only at lake level
  (`owner-river`): unchanged; ownership was not the cause.
- Field channel at the fan's width (`fan-channel`): wider cone, worse.
- Field reach by distance from the basin (`shore-reach*`): fixed the
  hillside but brought pale shelves back at the moat and a dark cut bank
  at the corner, at 40, 52 and 64 m.
- Flare radius by the river's height above the lake (`backwater`) or by
  ground height (`low-flare`): bulge mid-way, then a pinch and a sharp tip
  at the lake.

Lesson: my plan-view probe's ground (hydrology sampler) did not include the
field's terrain at this mouth, so maps "identical" between field on and
off misled two rounds. Capture A/B decided it.

Verification (`low-ground-sweep`, 15 owner views + top view, wet and dry,
base/new/base): the hillside neck is a smooth funnel; moat, corner, both
banks, bottom, accordion, scales, reach and rims within noise of HEAD; the
wide-rim bank changed (17 % of pixels): its smoothed straight crest is now
the carve's rounded slope (the field no longer reshapes that high ground).
Frame time within noise on every view; 80-tile generation 511-523 ms vs
503-519 ms; no GPU errors. One run of the sweep lost its page (Chrome
"Target closed") after 7 views; the retry completed.

## Round 4 (2026-11-02, owner: glitches at mouths and hillsides, "moats have edges extending into the delta")

Owner poses: `tools/perf/riverBanks/ownerViews-2026-11-02.json` (o02-mouth-hill,
o02-bank-ridge, o02-close-blocks). Evidence `river-2026-11-02/`.

Fixed: **diagonal line across the water at a steep stream's mouth**
(o02-mouth-hill). It was there with the junction fields off and with their
water shortcuts off: the old river/lake hand-over, whose lake share ramps
over the mask's last 3 m (LAKE_EDGE_RAMP_M), drew a line where the river
surface meets the lake. The share now ramps over 24 m inside the lake's
drawn edge (nearShareCover, SHARE_RAMP_M). Cost ~0.3-0.4 ms at mouths
(moat measured twice, base/new/base/new); other views within noise.

Not fixed: **straight-edged "wings" beside the moat-type mouths**
(o02-close-blocks, and the owner's unposed crop). What is known:
- Junction fields off: gone. Water shortcuts off, analytic fan off,
  micro-detail clamp off, JUNCTION_LOW_GROUND off, influence radius
  64/200 m: unchanged. blendRadiusM 32: smaller detached mud patches;
  20: gone, but broad pale shelves return at the moat mouth.
- Water owner view (w7): the lake's water is drawn in the wings, ending in
  the lake mask's straight edges. So: the field's fillet (blendRadiusM)
  cuts ground below the lake's level into the coarse mask's coverage,
  shallow water shows there, and its outline is the mask's edge.
- Rejected: lowering ground back above the water outside the drawn water
  (`candidate`: spike of land at the hillside mouth, wings unchanged); the
  lake drawn wherever the field's bed is below its level
  (`candidate2/lake-by-bed`: floods grass); a flat delta shelf in the
  analytic fan (`shelf`: no change); ending the channel past the shore
  (`shore-end`: no change at the bank-ridge view, whose edge is the
  river 2557 approach 55-80 m above its mouth).
Next lead: the field's lake basin is the flood of natural ground clipped
by the coarse mask (originalBasinMembership); its straight edges become
the shoreline. A shoreline from the ground contour needs the lake sheet's
coverage inside a field patch from the field's own wet domain (stored at
bake time), not the 32 m mask.

## Round 5 (2026-11-02/03, owner: "don't report back until EVERYTHING is fixed")

Owner poses `tools/perf/riverBanks/ownerViews-2026-11-03.json` (7). Evidence
`river-2026-11-03/`. Grid tool `tools/perf/riverMetrics/grid.mjs` (one image
per pose: wet, dry, fields off / lighting 91, base colour 43, owner w7).

Causes found (one-term A/B each):
- **Zipper line up the hillside** (o03-zipper): my 81c0662 station blend's
  band growth (growth 0: gone). Mechanism: 73 micro segments (0.2-2 m) at
  mouth anchors (riverMouth.js insertRiverMouthAnchors); float32 unit
  directions (~8 mm) make their direction off by up to ~2 degrees, and a
  wide band evaluates their extended line 100 m out. Fix: mouth stations
  snap to a point within 0.3 of its segment (max 5 m) (MOUTH_ANCHOR_SNAP,
  RIVER_SOLVE_VERSION 53): 1 zero-length segment left of 20324; zipper
  much fainter, a thin line remained, and dotted straight lines on the
  scales and hillside views were also the growth (a point's station sum
  depends on joints whose segments its cell may not list). Band growth
  removed (bands half the shorter segment again): zipper and lines gone
  (`fix-sweep`, 22 views dry, last commit vs new: elsewhere unchanged,
  frame and tile generation within noise). The round-2 stripes did not
  visibly return in the hillside crop.
  Rejected: every joint blended (turnW 1), station over the joined sub-run
  only, neighbours listed in each segment's cells (made an L-shaped
  cell-edge line), uniform 3x band, growth capped at +25 m.
- **Zigzag band across the hillside** (o03-zigzag): the river valley field
  (riverValley.wgsl.js). Its lake guard (texel-centre-in-lake flag,
  ~50 m texels) multiplied by 8 cuts the valley off along the texel
  staircase. Guard x2 / x1: the band moves and turns into scallops; the
  cut is metres deep next to the lake and any texel-based cut-off shows.
  Next: taper the cut itself near lakes at bake time (distance to lake
  texels), not by a texel guard.
- **Berm / dark ridge beside the river** (o03-berm), **dark groove along the
  channel** (o03-thalweg), **groove at the point** (o03-tip-sliver): carve
  terms; not containment, not valley, not joints. Next: bank types
  (riverSection cut bank / ledge) and the thalweg skew.
- **Stepped water outline** (o03-ribbon-steps): ground beside the channel
  near the mouth lies below the river's water level (w7 yellow); the
  ribbon mesh edge then shows. A wider ribbon only moves the steps out.
  Next: the mouth level refit / banks there.
- **Straight-edged wing at a mouth corner** (o03-corner-wing): see round 4
  (lake mask edges inside field patches).
- **Thin crease line in the lake at a mouth** (o03-corner-wing lighting): not
  yet isolated.
Runs crashed twice (Chrome "frame detached" on valley-off, then a 15 min
load timeout); a fresh run worked. Seen in two later runs only: an L-shaped
dark crack on the scales hillside and a dotted line on the hillside-pinch
view; suspected stale tiles after river data changes (not yet verified).
