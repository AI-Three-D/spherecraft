# Rivers and lakes: what was done, what failed, and the plan

2026-11-03. This replaces every earlier water, river, lake and structured-terrain
handoff and experiment report (2026-10-05 .. 11-03; all in git history up to
5ad0fe9). Read it completely before touching water code.

**Status in one line:** closer than ever before, still far from visually
acceptable. The owner's latest screenshots (`tools/perf/riverBanks/ownerViews-2026-11-04.json`)
show edge walls along rivers, straight-edged water polygons and pointed
corners at mouths, a pale shelf at mouths, a straight-edged band on a
hillside, and a river drawn only as a dotted line of puddles.

## 1. The owner's bar and working rules

**Visual target for the whole planet:** [docs/reference/visual-target-2026-11-03.png](docs/reference/visual-target-2026-11-03.png)
(described in [docs/reference/README.md](docs/reference/README.md)): rugged
snow-dusted ranges, green lowland with many lakes of varied size chained by
meandering rivers, vast conifer forests. The owner: "just about the bare
minimum ... preferably much much better". Rivers and lakes are one part of it.

- Rivers and lakes read as **one natural body of water**: no seams, rims,
  moats, walls, wedges, floating water, straight water edges, puddles.
- At least as rich as the owner's Whitewater game (`../whitewater`): width
  varying 2-3x, pools, constrictions, twists, varied banks per side (cut bank
  to no bank, blends of 50 m+). Big rivers must exist (50-100 m+).
- Mouths: organic, rounded banks blending into the lake shore over a long
  distance; the bed blends into the lake bed (no moat, no trench end); small,
  rare deltas only where the terrain suits them.
- Transparent shallows, visible bed, diving close up; far water may be the
  terrain shader's.
- Verified on alpine lakes and steep streams, plateau lakes and gentle
  terrain, not one area.
- Performance: no visible frame cost; water must not cause tile
  regeneration or pop in after load (startup is the place for water work);
  coarse tiles near-instant; stable FPS in fast flight.
- The owner's eye decides (they asked for 8/10; the 10-29 state got 3/10).
  Numbers support claims, never replace looking at the owner's own views.
- Rules from the owner: don't report partial fixes; don't repeat failed
  attempts (section 4); don't commit without the owner's OK; the owner
  edits the working tree concurrently (stage only your own hunks); removed
  features lose their code and switches.

## 2. The system today (branch `water-ponds`; field rework uncommitted on 5ad0fe9)

Game URL: `wizard_game/standalone.html?regionalTerrain=0&regionalBanks=organic&waterPrecompute=1&lodHeight=ground`
(whitewater is on: `&whitewater=off` for without it, section 9).

| Stage | Where | What it does |
|---|---|---|
| Lakes | `core/world/hydrology/` (waterGraph, waterWorkerCore solveLake, HydrologyPrecompute) | Original terrain-sampled lakes, solved at 32 m and precomputed (`waterPrecompute=1`); signed-distance masks in an atlas (`lakeMaskSdf.js`, `WaterGpuData.js`). The owner chose these lake shapes as the reference. |
| River traces | `waterWorkerCore.js` solveRiver, `riverRefine.js` (RIVER_SOLVE_VERSION 53) | Graph route refined on a 16 m natural-terrain patch near the camera; levels fitted to ground, monotone; shape noise (width, wobble, islands), mouth stations (`riverMouth.js`). |
| Ground and water | `core/world/water/riverField.js` (bake), `riverField.wgsl.js` (lookup), `RiverFieldService.js` + `riverFieldWorker.js` | One baked field per area: 2 m paged raster on the cube faces holding water level W, ground change Δ and signed distance. Rivers within 6 km of the camera, kept to 8.4 km; the reveal waits for it. |
| Terrain | `core/world/water/riverCarve.wgsl.js` | Last step of the height function: natural + Δ, so tiles, normals and the simulation's bed agree. Micro detail is held against W. |
| Water drawing | `waterWgsl.js` applyWater (terrain shader, far: field first, then lakes), `NearWaterRenderer.js` + `nearWaterSurface.wgsl.js` (lake sheets), `fieldWaterSurface.wgsl.js` (per-wet-page meshes at W) | Rivers draw from the field; a lake sheet gives way wherever a field page exists; the depth test draws the shoreline. The segment lists now serve nothing (the old simulation was the last user): dead weight to delete. |
| Bed material | `riverCarveShoreWeights`, splat passes, MUD tiles in `wizard_game/world/biomes.json` | In field pages, mud by depth under W; elsewhere the lakes' rule. Grass to the waterline; splat filter 5 (engine.json). |

## 3. What helped (keep unless the new foundation replaces it)

- The original terrain-sampled lakes at 32 m (shape reference) and their
  signed-distance masks; precompute at startup.
- One MUD tile for river and lake beds (owner's idea, 10-25); mud by
  submerged depth, grass to the waterline (Codex 10-29/30); splat filter 5
  (the world JSON had pinned 1).
- Rivers meeting lakes head-on (riverLakeApproach, 10-27); mouth stations at
  the real shoreline.
- Continuous water level along the river (accordion bands fixed, Codex).
- Station blend over joints (no "scales"/stripes); mouth anchors snapped to
  points (no float32 micro segments, 249a062).
- Micro detail kept beside water but never crossing its level (10be9d0).
- Valley cut tapering toward lakes at bake time (415e859).
- 2D fields at mouths (Codex): first representation that rounds mouths and
  blends the bed into the lake bed; showed that 2D baked fields work where
  1D sections cannot. Its weaknesses were wiring: inputs that differ from the
  tiles (natural vs valley-shaped ground), lazy baking with regeneration.
- Method: one-term A/B with the dry lighting view (terrain debug 91 with
  water debug 10) separates shape from colour; water owner views w6/w7
  show which surface draws; pixel diff before trusting "no change".

## 4. What failed (do not repeat)

Architecture-level:
- Regional/structured placement of lakes and coarse drainage (10-07..11,
  v17): lakes too small/simple; rejected. Artificial enclosing landforms
  around lakes: rejected as artificial. Rivers as an overlay mesh without
  terrain carving: rejected.
- Camera-window flood fills for coverage (connectivity changes as the
  window moves); per-pixel triangle connectivity (+3 ms); widening masks
  (crosses ridges); global finer terrain LOD by ground height (+2.9 ms,
  deferred by the owner).
- Codex's single regular-grid water mesh at junctions: clipped domain drew
  polygon cut-outs, unclipped flooded unrelated hollows.
- Near-river shallow-water simulation along a straightened strip
  (WaterRiverSim) and the earlier demo patch (RiverSystem): broken, deleted.
  Section 9 replaced them.

Local patches that did not fix their target (each was a one-term change):
- Mouths: longer transition radius (canals, triangles), field wet domain =
  fan width, deposited fan deltas (spit + hooked channel), designed outline
  (trumpet + fillet), round fillet between river and lake water, width taper
  toward the mouth, fan blended by width, river surface ownership in the
  basin, field reach by distance from the basin (pale shelves), flare by
  backwater or ground height, lowering ground outside drawn water, lake
  drawn wherever the field's bed is below its level (floods grass), flat
  delta shelf, ending the channel past the shore, bank fade near mouths,
  smaller blend radius (20 m: wings gone but pale shelves back).
- Banks/hillsides: every joint blended, sub-run station, neighbour segments
  in cell lists (L-shaped crack), wider/growing joint bands (zipper lines),
  softer valley lake guard (scallops), gentler cut bank (no visible change),
  soft cut 3 m, rim off, skew 0, end fade off, containment off, micro off:
  none removed the shore line/gash at mouths (round 5).
- Shore look: grass fringe, mud strip widths, 4x absorption, wet toe; the
  owner preferred neither the uniform mud rim nor the painted grass rims.
- Earlier (Astra, 10-14..22): diagnostics displaced the visible checklist;
  tested one gentle area only; reported metrics that could not see defects.

## 5. Why the same problems keep coming back

1. **Many definitions of where water is**: lake mask, drawn lake water,
   natural waterline, river pool/guard flags, give-way, ribbon width,
   analytic fan footprint, field basin distance, terrain-shader river zone.
   Every visible seam is two of them disagreeing; aligning two exposes a
   third.
2. **1D cross-sections for 2D places**: the carve evaluates the nearest
   segment's profile; mouths, confluences, bends' insides and banks are 2D.
   Joints, nearest switches, caps and straight fan edges follow.
3. **Containment by raising banks**: the banks are lifted to hold water
   fitted against ground within 4 m of the line; that draws levees ("edge
   walls").
4. **Lazy publication**: fields and traces arrive after tiles; tiles that
   miss a regeneration keep stale ground (likely the puddle river: water
   drawn, channel not carved; unverified).
5. **Verification gaps**: the hydrology sampler's ground differs from the
   tiles at mouths (fields, micro detail), so probe maps can say "no
   trench" where the tiles have one.

## 6. Remaining issues (owner, 2026-11-03) and known causes

Poses: `tools/perf/riverBanks/ownerViews-2026-11-04.json` (8),
`-11-03.json` (7), `-10-29c.json`, `acceptanceViews.json` (15 earlier views).

| Issue | Pose | Known cause |
|---|---|---|
| Edge walls along both banks | o04-walls, o04-hill-facet | Containment fill crest and steep cut-bank faces (all banks "none": much softer). |
| Straight-edged water polygons, pointed corners at mouths | o04-mouth-poly, o04-lake-poly, o04-mouth-corner | Ribbon and river zone drawn over the analytic fan footprint (segment-based polygon); w6/w7 show it. |
| Pale shelf / edge at mouths | o04-mouth-yellow, o03-thalweg | Shallow fan over mud + lake/river hand-over; a dark line along the waterline survives every carve term (cause not found). |
| Straight-edged band on hillside | o04-hill-facet, o04-mouth-yellow | Ground shape (lighting view); suspected the valley field (sparse incision cells defaulting to 0 in `riverIncisionSampler`, 50 m texels). Unverified. |
| Dotted line of puddles | o04-puddles | The river's channel is not carved there; water shows where ground dips below its level. Suspected stale tiles after the trace version bump (53) or a missed regeneration. Unverified. |
| Wings, crease line in the lake, stepped water outline | o03-corner-wing, o03-ribbon-steps | Lake mask edges inside field patches; ground beside the channel below the river level near mouths shows the ribbon's edge. |

## 7. The plan: one baked field per river owns ground and water

**Idea.** For every traced river, bake once a fine field (2 m texels) over
its corridor and its mouths holding: the ground change Δ (relative to the
natural ground), the water surface W, and the wet coverage (signed distance
to the connected water). Terrain generation, water drawing and bed
materials read only this field near rivers. It generalises Codex's mouth
fields to whole rivers and replaces: cross-sections and bank types,
containment fill, joint blends, the analytic fan, mouth fields, the valley
field near rivers, ribbons, and every river/lake hand-over rule.

**Why it removes the classes in section 5.**
- One coverage rule: water exists where the field's connected flood says
  so (seeded at the channel and the lake, ground below W). No ribbon edges,
  fan polygons, mask cell edges or puddles; the shoreline itself comes from
  the depth test against the terrain.
- Shaping is an image computation, then smoothed (Δ blurred over 2-6 m):
  no nearest-segment discontinuities, joints, caps or creases.
- Containment by **lowering W** where the ground beside the channel is low
  (rim minus margin, kept monotone downstream), never by raising banks: no
  levees. Banks are smooth profiles with per-side slope variety (no stepped
  cut banks).
- Mouths are 2D in the same field: the channel widens, its bed blends into
  the lake bed, corners round with a radius; deltas are a deposition term
  applied only on low ground.

**Layout.** A planet-global paged raster on the cube faces (the valley
field's face mapping, `valleyFaceUV` / `waterGraph.js` faceUVToDir) at
2 m texels; pages of 32×32 texels with a 2-texel apron (bicubic within a
page); a GPU hash table (face, page i, page j) → slot. Texel: (Δ, W,
wet signed distance, owner id). Coarse LODs need a prefiltered level (mip
of Δ) to avoid aliasing on far tiles.

**Bake** (worker; natural ground sampled on the GPU in large batches, as
JunctionFieldService does):
1. Pages within the corridor (half-width + bank reach ~80 m) and around
   mouths.
2. Per texel: nearest point on the river record → arc s, lateral offset n
   (with the existing shape noise: width, wobble).
3. Level: W(s) = min(trace level, min ground on both sides at hw+1..8 m −
   0.3 m), monotone downstream; at mouths W → lake level.
4. Ground target: channel profile from bed (W − depth) to the edge, bank
   rising to natural ground with per-side slope 0.15-0.6 and long blends;
   smooth minimum with the natural ground (cut only, except deltas).
5. Lakes at mouths: lake region = flood from the solved lake's cells below
   its level; W = lake level; channel bed fades into the lake bed.
6. Smooth Δ and W; wet = connected (ground < W) from the seeds; signed
   distance for soft edges and materials.
7. Several rivers in one texel (confluences): lowest ground wins; W of the
   river owning the wet texel.

**Use.**
- Terrain: `riverCarveTerrain_d` becomes natural + Δ (bicubic with
  gradient for normals). The micro-detail clamp reads W.
- Water: a grid mesh per page at W (4 m vertices); fragments discard
  outside wet (soft by signed distance); lake sheets discard inside pages
  where the field owns the water (same shading, so the boundary inside a
  lake is invisible). Terrain-shader water keeps far distances.
- Materials: mud by depth below W and wet distance with broad noise; grass
  on dry ground.

**Publication.** Bake the rivers near the spawn during the loading screen
(the game already waits for `getLoadingStatus().complete`); later rivers
bake before their fine tiles are requested, or their tiles regenerate once.
Measure: bake ms per km of river, memory, tile generation ms, frame ms.

**Phases and gates** (owner poses, dry and wet, lighting view 91 dry):
0. One hour: confirm the three unverified causes in section 6 (puddles,
   hillside band, mouth dark line) with one A/B each, so the field covers
   them.
1. Field bake, store and terrain lookup for one river behind a URL switch;
   dry views of that river free of walls, creases, steps.
2. All traced rivers and their mouths; all owner poses dry; costs measured.
3. Water drawn from the field; all owner poses wet; no straight edges,
   puddles, shelves, wedges.
4. Materials from the field.
5. Startup baking (no pop); performance against the bar.
6. Delete the replaced code and switches; full sweep; then the owner looks.

**Risks to watch.** Bake time and memory (estimate: ~1.5 M texels per
50 km of river); cube-face edges; confluences and rivers through lakes;
far-LOD consistency with the terrain-shader water; the micro detail must
not dip below W in the dry ring around wet texels (the clamp exists).

## 7b. Field status (uncommitted; replaces the carve, valley, junction fields and ribbons)

**Phase 0 results** (owner poses, dry lighting = terrain debug 91 + water debug 10
together, `91+w10` in armReview):
- Puddle river: regenerating every resident tile changed nothing (pixel diff 0),
  so not stale tiles; river 2608's channel is never cut below its level.
- Hillside band (o04-hill-facet), bench (o05-hill-terrace), mouth dark line
  (o03-thalweg), side trench: unchanged with the valley field off, gone with
  the carve off. They are the carve's (section 6's valley suspicion was wrong).
- All polygon/wedge/triangle cases (ownerViews-2026-11-05.json) are river
  mouths: ribbon + fan footprint + lake hand-over (w6/w7).

**Where the design could hit the failed list, and what was done:**
- Bank meeting a hillside draws a band parallel to the river (the carve's
  band): banks are a C2 lateral ramp to the natural ground, per-side width from
  bank type and incision (`bankB0`, `bankC`), no height-band smooth min.
- Connected flood = "floods grass": river water may spill only `spillM` beyond
  the channel, on texels a river owns; lakes only inside their masks.
- Regular-grid water at mouths (Codex's cut-outs): one grid per wet page, every
  page's neighbours agree at edges; coverage is the field's, lake sheets give
  way by page; the shoreline is the depth test.
- Level steps at mouths: a river's level eases to its lake's over `lakeEaseM`
  from actual lake water, and containment relaxes over the last 20-80 m.

**Built:** `core/world/water/riverField.js` (bake; 8-byte texels: W f32, Δ and
signed distance f16), `riverField.wgsl.js` (hash lookup, B-spline),
`RiverFieldService.js` + `riverFieldWorker.js` (rivers within 6 km, kept to
1.4x; main thread ~0.15 s per bake, rest in the worker; loading waits for it),
`core/renderer/water/fieldWaterSurface.wgsl.js` (near water), terrain shading
water and bed mud read the field. The field binds in group 1 (bindings 4-6);
the terrain shading has it at bindings 17-19. Tools:
`tools/perf/riverBanks/fieldArms.mjs` (capture configs per area), `fieldPlan.js`
+ `fieldPlanPng.mjs` (plan views of the bake), `fieldDiag.js` (watch a pose:
bake stage, worker progress, near rivers), `riverMetrics/crop.mjs`.

**Pitfalls found:** hydrology sampler dispatches over 4.19 M directions never
read back (chunk 2^21); river 2587 is a zero-length trace (infinite smoothing
windows; skipped); per-segment station lists blew up on wide rivers (grouped
index with box rejection); W per texel must not flood where no river reaches.

**Found in the last sweep (each proved with a probe or an A/B, not by reasoning):**
- Hairline L across lakes (o03-tip-sliver, the owner's "pale sliver"; o29c-rim-west):
  the lake sheet gave way by the lookup's page, which is the stencil's and sits
  half a texel below the mesh's page: a 1 m gap on two sides of every page.
  `riverFieldHas` now uses the mesh's page. A sub-pixel gap remained (world
  positions round to 1-2 cm at this radius), closed by a small grazing-scaled
  overlap under the mesh edge.
- Overlapping lakes: `lakeEdgeAt` broke ties on a saturated `inside`, so W flipped
  by 16.8 m between neighbouring blocks. Invisible from above (water shading
  ignores mesh slope). Past 16 m inside, the higher lake wins.
- The accordion (o29c-accordion): levels are linear between trace points, each
  segment's slope drew a band across the bed, seen through the water too. W and
  depth are smoothed along the river before containment. Smoothing the bed alone
  does not work: at concave joints it meets the least depth and follows W again.
- Black wall beside steep streams: not natural shade, as this doc once said. HEAD
  at the same pose has none. Three causes: meanders on a stream straight down a
  hillside (it has no cross slope, so it counted as flat; now the river's own fall
  gates them, and offsets use a smoothed normal); bank widths searching to reachM
  on hillsides steeper than the bank (the hill is the bank from there; banks also
  open at most `bankOpen`); and banks ramping to a level, which on the outside of
  a bend cut a shelf into the slope (they now follow the hill, by a depth at the
  water's edge). The low side keeps its level.
- Water sheets and thin second channels beside rivers: `spillM` was 24 m. Now 3 m,
  the fringe at the waterline. Containment was not at fault: it binds at about
  0.6 % of stations, and 0 of 816 on river 458.

**Lessons for this code.** Compare with HEAD at the same pose before calling
anything natural. Look at the wet image of every run: the metrics passed while a
second arm of water appeared. Check a theory with a count before building on it:
at o29c-accordion six in a row were wrong (level steps, bank width alone, a
tributary, stale tiles, averaging in the level fit, the notch filter).

**Costs against committed HEAD** (`git archive` copy, same poses, fixed quality):
GPU span median -1.78 ms, faster at all 8 poses (near -1.4 to -2.4, far -0.2 to
-0.8); 80 tiles 403 ms against 515 ms (-22 %). A re-bake: the worst frame gap
150 ms before (one blocking stretch of 250 ms of directions and 115 ms of lake
lookups, plus an unmeasured page-by-page compare), about 20 ms now, longest main
thread stretch 4.5 ms: pages and directions moved to the worker, the lake pass
runs in 3 ms slices, page hashes and wet flags come from the worker. A bake is
about 3 s in all. Field memory 35-58 MB.

**Far views changed.** Hills at far-o04 show large black faces that HEAD does not.
They are the natural terrain: gone with HEAD's valley field, same with the river
field off, and HEAD with only the valley off matches the field exactly. The valley
reshaped hills far beyond any river; deleting it removed that too.

**Tools added:** `riverMetrics/waterCracks.mjs` (thin gaps in the water, needs
`w10` captures), `fieldProbe.js` `fieldLakeEdges`, `fieldWaterSteps`, `fieldCliffs`
(slope the bake adds; top pages and steepest), `fieldAlong`, `fieldRiversNear`,
`fieldGrid`, `fieldHitch` (frame gaps during a forced bake), `fieldMouthProfile`,
`fieldSills` (bars at river ends, all rivers); bake stats `spilled`, `widest`,
`ms.longest`.

**After d7ee2a0 (uncommitted, for the owner's look):**
- Muddy rim at river ends: a real bar of ground across the mouth. Traces stop at the
  shore, the channel's depth faded by distance, and the lake's shelf stood in front
  of it (depth 2.9 -> 1.6 -> 6.7 m). Rivers are now carried on into their lakes
  (`extendRiverEnds`) and the channel fades by the lake's depth (`mouthFadeDepth`).
  The last station now lies in real water, so level easing runs at ends where it
  never did (rim-fan: 3.3 m drop in 6 m). Poses: `ownerViews-mouth-rim.json`.
- Width: `riverWidthFactor` (river's own factor x reaches, at most 6x), each bank
  limited by the ground so the level is not dragged down, steep rivers unchanged.
  Depth grows with the root of the width; the bed flattens with width (`widenFlat`),
  as a parabola's shallow margin grows with it and wide and shallow reads as mud.
- Micro detail hold never ended: it reached past the signed distance's clamp
  (`sdfM`), so it held across every page and flattened patches along W's contour.

**Next (owner):** visual simplifications so coarse lakes and rivers load instantly and rendering costs a fraction of today.

**Open:** rivers beyond the field radius have neither cut nor water. The default
world (no `regionalTerrain=0`) has 234 regional rivers and no terrain sampler, so
the field cannot bake them: their channels are cut but hold no water (owner's
decision: that placement is on the failed list). Small leftovers on the owner's
poses: o29c-accordion (faint streaks across the bed, a small pale shard at the
lower bank, hill shade darker than HEAD's); o03-ribbon-steps (a small sharp tip on
the left bank); o29-tan-saw (a dark green strip along the river: banks that follow
the hill are narrower and steeper, and the steeper face takes grass).
`WorldConfigLoader.test.js` fails at HEAD too (`pixelRatio: 1.5` in
`runtimeConfigs.js`, not water).

## 8. Tools and pitfalls

Whitewater's own tools are in section 9.

- Capture runner: `tools/perf/riverBanks/armReview.mjs CONFIG.json`
  (system Chrome, own server on :8232, arms with source patches applied to
  an experiment copy of the repo, modes `w10` dry, `91` lighting, `43` base
  colour, `106` material families, `w6`/`w7` water owners; probes; bracket
  timing with `regenTiming.js fixedTilesGpu`). Config example:
  `tools/perf/riverBanks/acceptanceViews.json`. Sync the copy first:
  `rsync -a --delete --exclude .git --exclude node_modules --exclude
  tools/perf/structured-terrain-results ./ /private/tmp/spherecraft-river-experiment/`.
- Run one patched arm per invocation: the second arm often loses its page
  (Chrome "frame detached"). Reuse the browser profile dir (a fresh one
  recomputes everything for minutes). A version bump re-traces rivers:
  run a warm-up first.
- `tools/perf/riverMetrics/grid.mjs` (several captures in one image),
  `pngDiff.mjs`.
- Cost against the last commit: `git archive HEAD . | tar -x -C
  /private/tmp/spherecraft-river-head`, then the `cost-head` and
  `cost-field` configs from `fieldArms.mjs`. `arm.query` loads another URL
  (`""` is the default world).
- Lighting drifts between captures (sun highlight): compare dry views.
- The headless GPU run permission was given for this task; keep runs lean
  (the Mac crashed once on back-to-back long runs); close browsers after.
- `tools/perf/structured-terrain-results/` (untracked, large) holds all
  earlier captures.

## 9. Whitewater (2026-11-04, uncommitted, for the owner's look)

Whitewater (`../whitewater`) is the bare minimum for the look. Three tiers, one
baked flow state, so they agree where they hand over. **Switch:** `&whitewater=off`
(nothing is created), or at any time `qtDiag.water.whitewater(false)` (foam, flow,
simulation, rocks, spray all go at once; tiles never hold any of it).

| Tier | Range | What draws it |
|---|---|---|
| Far | beyond ~1.6 km | still foam in the terrain shading (`waterWgsl.js` applyWater, field branch), from the fall of W |
| Mid | to ~150 m | field page mesh, still geometry, foam and ripples moving with the baked flow (`whitewaterLook.wgsl.js`) |
| Near | under ~150 m | the solver on 0.5 m cells: moving geometry, foam, turbulence, spray, rocks (`WhitewaterSim.js`, `whitewaterSim.wgsl.js`, `whitewaterSurface.wgsl.js`, `whitewaterProps.wgsl.js`) |

**What the world's rivers are like (measured, `wwRiverStats`):** median slopes 4-17 %,
peaks 30-67 % (Whitewater: 3 %). The traces' discharge is 0.005-0.3 m3/s and their
speed sits at its 0.05 m/s clamp, against channels 1-3 m deep and 8-30 m wide: a
solver fed by them just drains. So `riverFlow.js` designs the flow from the baked
channel: speed from Jarrett's high-gradient law, one discharge per river (speed
follows the section), and a Manning n per station that puts exactly that flow in
balance at W.

**Warm-up.** Whitewater runs 900 hidden steps because it starts from a state that
is not a solution. Here friction is solved so that the baked state is one. From a
cold reset of every block (`wwWarmup`, river 2553): level RMS 0.008 m at 0.1 s,
speed 2.713 against 2.712 baked, 132 blocks full in 0.25 s. There is no wave to
hide; what grows is local detail and foam, over seconds. Each block eases in over
1 + 1.5 s (the mid tier stays until then) stepping one extra step a frame, and
blocks fill well beyond the drawn radius, so walking never reaches cold water.

**Handover.** Blocks have a weight, 0 at the edge of what steps, 1 inside, fading
with distance. The solver pulls to the baked state where it is low (sponge: inflow
and outflow in one, no walls or inflow rows, any river angle), and the mesh mixes
height, foam and speed to the mid tier's, so where it ends it already matches the
field mesh, which discards exactly on stepped blocks (`whiteCover`). Debug water
views: 11 speed, 12 foam, 13 turbulence, 14 Froude, 15 who draws (magenta near, green mid).

**Window.** A ring of 768 x 768 cells on a tangent plane (frame re-anchors after 8 km),
blocks of 32 cells. Only flowing blocks near the camera, and the wet ones beside
them, step, so lakes in the window cost nothing. Rocks are in the solver's bed and
drawn as meshes, never in tiles. The bed is the terrain itself: `HydrologyGrid.js`
`carvedDirsEncoder` (no readback), roughened under falling water.

**Costs** (M1 Pro, 2160 x 1350, fenced GPU span, on against `whitewater=off`, same
poses, run to run noise ~0.5 ms): close +1.8 to +3.9 ms (10-11 -> 12-15 ms), mid +2 to +2.9 ms,
gentle river +1.1 ms, far +0.3 ms. Parts at one close pose, measured before the single
solver step and the smaller spray: surface 1.9, solver 0.9, spray 0.8, rocks ~0.4; not
measured again after them. Flight at 30 m/s: no frame over 16.8 ms, same as off (8 frames at
33 ms before the fill budget). At 120 m/s: none, measured before the last changes. Memory
(from the buffer sizes): 55 MB of simulation buffers; flow texels 4 bytes each, ~25 MB at 4782
pages (field total 74.5 MB there). Bake: +76 ms in the worker.

**Found the hard way:**
- Foam mean baked vs settled is close (0.80/0.82, 0.32/0.26), but simulated foam is
  patchy where baked is even; coverage is nonlinear, so they differ by eye a little.
- Same buffer read and written in one dispatch is invalid even on disjoint ranges:
  three state buffers, plus a `spread` kernel so the fill stays under 10 storage bindings.
- `queue.writeBuffer` lands before a later submit: one params write a frame.
- Screen derivatives of world positions are noise at 131 km: rocks use local metres.
- `HydroPatch-carve` was invalid since the field rework ('auto' layout had dropped the old
  carve bindings): a carved GPU sample had not worked since. Fixed.
- A wet but slow bank block left out of the step set zeroed every neighbour: straight cuts.
- Hard shoreline: the solver's bed is not the rendered ground to the centimetre. Thin
  water fades by the solver's depth (Whitewater's `present`).
- Rocks at a bank drew lines over the grass; on a 60 % slope they hung in the air until
  their base went down by the fall across their radius.
- Deleting `core/renderer/rivers` broke the live lake shader's noise import; tests did
  not catch it (lakes have none). After deletions, check every relative import.

**Open:** near tier not in the loading gate (fills after the reveal, ~1 s, then eases in). No
readback for floating things (Whitewater's band copy). Rocks are placeholders: one
lumpy shape, one colour, no collision. Density and sizes (`riverFlow.js`: 0.01 per m2, radius
0.4-3.8 m long-tailed, half under 0.65 m) were set by the owner's eye: 0.03 and 0.9-2.7 m read as a field of equal stones. On the steepest
reaches water runs narrower than the channel, so the mud bed shows beside it. Surface
fragments are the largest cost; a noise texture instead of hashes and half-density far blocks
are the next savings. Far brown stretches are the older far-water gap (same with it off).

**Tools:** `tools/perf/whitewater/wwProbe.js` (`wwRiverStats`, `wwStatus`, `wwReadback`,
`wwWarmup`, `wwFlight`, `wwCost`), `views.json`; `w.debugOff = { rocks, spray, surface, solver }`.
Poses by `river`/`fraction`: on steep rivers use negative `back` (from downstream),
or the camera lands inside the hill. Evidence: `tools/perf/structured-terrain-results/whitewater-2026-11-04/`.
