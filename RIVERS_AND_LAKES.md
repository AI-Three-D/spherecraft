# Rivers and lakes: what was done, what failed, and the plan

2026-11-03. This replaces every earlier water, river, lake and structured-terrain
handoff and experiment report (2026-10-05 .. 11-03; all in git history up to
5ad0fe9). Read it completely before touching water code.

**Status in one line:** closer than ever before, still far from visually
acceptable; section 10 ends with the latest. The owner's screenshots of 11-04 (`tools/perf/riverBanks/ownerViews-2026-11-04.json`)
showed edge walls along rivers, straight-edged water polygons and pointed
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

## 9. Whitewater (2026-11-04, a6038d6 and after)

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

**Warm-up.** (Corrected 2026-11-05: the balance below was not true at the time; see section 10.)
Whitewater runs 900 hidden steps because it starts from a state that
is not a solution. Here friction is solved so that the baked state is one along the
river. From a cold reset of every block (`wwWarmup`, river 2553, mid reach): level RMS
0.008 m at 0.1 s, speed 2.713 against 2.712 baked, 132 blocks full in 0.25 s. What
grows is local detail and foam, over seconds. Each block eases in over 1 + 1.5 s (the
mid tier stays until then) stepping one extra step a frame, and blocks fill well beyond
the drawn radius, so walking never reaches cold water.

River ends are the exception, and were a real surge until lakes held their level: the
baked flow stops inside a lake, so the start state is not mass-consistent there. Water
piled up at the mouth and ran back up the river on arrival (owner; `surge.mjs` at
o-mouth-surge: +0.27 / -0.29 m over ~10 s, front steepness 0.15). A lake is a reservoir,
so lake texels (flow word's n = 0) hold their level (`lakeHold`) and take a river's
momentum and foam away (`lakeDrag`). Level movement in still water, top 1 %: 0.154 -> 0.002 m,
0.143 -> 0.008, 0.179 -> 0.014. Rivers leaving lakes were as bad (src-2551: white across the
reach, gone). `wwWarmup` could not have seen any of it: it measured mid-river.

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
poses, run to run noise ~0.5 ms): close +1.6 to +1.9 ms (10-11 -> 11.6-13.3 ms), mid +1.0 ms, gentle
river +0.8 ms, far +0.4 ms. Fading octaves by pixel size saved more than the rest of the polish cost.
Those were on a free GPU, before lakes held their level. After it, with the owner's game open on
the same GPU (off itself rose to 15.6-19.4 ms), on against off back to back: far +0.26 ms, close
+3.7 to +5.4 ms, and flight at 30 m/s p50 33 ms: not comparable, and low FPS also buys extra solver
steps by design. Measure again on a free GPU before trusting either; check `uptime` and Chrome first.
Parts at one close pose, measured early, before the single solver step and the smaller spray:
surface 1.9, solver 0.9, spray 0.8, rocks ~0.4. Flight at 30 m/s: no frame over 16.8 ms, same as
off. Memory (from the buffer sizes): 55 MB of simulation buffers; flow texels 4 bytes each, ~25 MB
at 4782 pages. Bake: +76 ms in the worker. Steps follow real time, so at the idle 30 FPS the solver
takes two steps a frame.

**Flicker, measured** (`flicker.mjs`, o-flicker, 30 FPS): a6038d6 hf 3.00, blinks 0.67 %, coverage
beat at 0.4 s, by image rows far to near 1.51, 1.92, 1.25, 3.84. Now hf 1.45, blinks 0.22 %, no beat at
the cycle's rate, rows 0.47, 0.58, 1.20, 2.10. At 60 FPS: hf 0.63, blinks 0.06 %. With the pattern held
still hf is ~0.3, the solver's own floor; the near rows' rest is largely foam edges really moving.

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
- Flicker (owner, seen from above at the idle 30 FPS): all in the surface pattern, not the
  solver (`flicker.mjs`, pattern held still: hf 2.96 -> 0.34). Foam coverage beat at exactly half
  the flow cycle: mixing two noises loses contrast half way, and a threshold turns that into
  coverage; `contrast` holds the variance through the fade. Then a hard foam edge at 11 cm pixels
  (`soft` now grows with the pixel), octaves left in past pixel size (ridged filaments are a
  fraction of their lattice), and an octave moving half its size a frame at 30 FPS.
- The game idles at 30 FPS by design: a fixed step a frame ran the water at half speed. Steps
  follow real time now. Test what the owner sees, at 30 as well as 60.
- The beach line (owner): a standing line of foam, not a wave (lake level RMS flat over 6 s).
  My first suspect, the "rock" term for dry neighbours, was the smallest source; `wwFoamSources`
  showed the Froude term, in water 0.16 m deep half a metre outside the baked shore: thin water
  is supercritical at any speed. Foam now needs depth and a baked current. Foam cells in the
  lake zone: 1264 -> 146, river unchanged.
- Ridged noise on one lattice shows it: a maze of rounded squares from above. Two lattices at
  unrelated angles do not line up; a second ridged octave drew cracks in glass, plain noise wisps.
- A level off the baked one is not a surge: the level beside a river near a mouth is the
  lake's, so the river's own surface reads 0.6-0.9 m "high" for ever. `moved99` (how far cells move
  between samples) tells them apart. Holding lakes left foam gathering in a line where the
  flow stalls at the stepped blocks' edge: foam decays in lake water.
- Deleting `core/renderer/rivers` broke the live lake shader's noise import; tests did
  not catch it (lakes have none). After deletions, check every relative import.

**Open:** near tier not in the loading gate (fills after the reveal, ~1 s, then eases in). No
readback for floating things (Whitewater's band copy). Rocks are placeholders: one
lumpy shape, one colour, no collision. Density and sizes (`riverFlow.js`: 0.01 per m2, radius
0.4-3.8 m long-tailed, half under 0.65 m) were set by the owner's eye: 0.03 and 0.9-2.7 m read as a field of equal stones. On the steepest
reaches water runs narrower than the channel, so the mud bed shows beside it. With fewer rocks
steep reaches settle ~20 % faster than baked (3.1 against 2.5 m/s): rocks were part of the drag. Surface
fragments are the largest cost; a noise texture instead of hashes and half-density far blocks
are the next savings. Far brown stretches are the older far-water gap (same with it off).

**Tools:** `tools/perf/whitewater/wwProbe.js` (`wwRiverStats`, `wwStatus`, `wwReadback`,
`wwWarmup`, `wwFlight`, `wwCost`, `wwFoamSources`, `wwLakeWave`, `wwSurge`), `surge.mjs` (arrive at
poses on a virtual clock, level series, arms over `whitewater.config`), `flicker.mjs` (exact frames on a
virtual clock: second differences, blinks, coverage beat, a heat map; its score includes foam edges
really moving, so read it by image rows), `views.json`, `ownerViews-2026-11-05.json`;
`w.debugOff = { rocks, spray, surface, solver, pattern }`.
Poses by `river`/`fraction`: on steep rivers use negative `back` (from downstream),
or the camera lands inside the hill. Evidence: `tools/perf/structured-terrain-results/whitewater-2026-11-04/`.

## 10. Distant water (2026-11-05, uncommitted, waiting for the owner's look)

Owner: lakes turn an ugly flat colour at a short distance; distant water first, waves close by
later. Evidence: `tools/perf/structured-terrain-results/lake-look-2026-11-05/` (`before-after.png`
first; `baseline/`, `final/`, `checks-final/` for mouths and sun heights).

**Why it was flat.** Four causes, each measured:
- Lake ripples never existed. `waterSurfaceTerms` took tangent coordinates from the world position,
  and on a planet at the origin that has no tangential part: every pixel of a lake got one tilt that
  only changed with time. Ripple detail with the coordinates fixed rose from 0.5-1.0 to 1.1-1.7
  codes close by and did nothing past 600 m, so this alone was never the answer.
- A flat mirror: Fresnel is already 0.6 at 300 m from 30 m up, and from there one colour takes the lake.
- That colour was the lighting's ambient, not the sky: R/G 0.91 against the sky's 0.59 (the purple
  band), a third of its level, and it does not change from noon to dusk.
- From above the water was one teal body. With reflection off the far band went black and the teal
  stayed: two flat colours, one per viewing angle.

**What it is now** (`waterWgsl.js`). Past a few hundred metres no wave is a pixel, so the surface is
the statistics of its slopes. `waterWind` is gusts drifting over the water (twelve phase-modulated
sines in space, no tangent frame, so no seams; bands leave before a pixel reaches them). Wind sets
sigma, sigma keeps Fresnel from saturating, and its change from gust to gust is what shows.
`waterSkyColor` is the sky measured on screen by sun height, with a dusk term. Sun glitter is a
Gaussian in slope, not `pow 600`. `waterBodyLight` is teal in the shallows, slate in open water;
past 1 km distance alone decides, since depth there is coarse triangles (owner 2026-10-12).
Tuning: `qtDiag.water.look({ openColor, skyColor, wind, reflection })`.

**Measured** (`tools/perf/lakeLook/`): detail along an image row, sRGB codes, 12 views of 3 lakes
(spawn 2814, alpine 639, plateau 180): 0.04-2.1 before, 1.3-16 after, median about 5. Hue of the far
band now follows the sky. Flicker at 30 FPS (`flicker.mjs`, `minTop: 0`): hf 0.022 against 0.015,
blinks 0 %; foam scores 0.6-1.5 on the same measure.

**Cost**, in the same page, old surface against new, taken in turn (`costAB.js`), 6 rounds:
-0.1, +0.35, +0.7, +1.7 ms (`lake2814-shore`, `-high`, `-low`, `lake180-shore`), spread within one
state 1-3 ms. The ripple's hashed gradient is the next saving; the wave work will replace it.

**Found the hard way:**
- **Compare cost in one page.** Across page loads the same code moved 2 ms and more, and a patch to
  code that cannot run on those pixels moved `lake180-shore` by 2.1 ms. Across loads this view read
  +3.9 ms, most of it not the water.
- **The tiers must agree.** The solver's blocks and the field's pages end in straight lines across
  lakes (debug view 15). Lake water drawn by `whiteSurface` showed one (owner's views at mouths, not
  the lake views). Still water is now the lakes' surface in every tier, by flow speed.
- A term that exists only in one branch steps at that branch's edge: `waterWindNow` stayed at its
  default past the `still` test and drew a curved contour along a speed line.
- The brown band across lakes at 1-1.6 km was the bed: the terrain kept a share of it and the near mesh
  covers only its own share, leaking about a fifth mid-handover. The far body now turns opaque by
  1.2 km. Red through the band: 70 74 73 65 -> 68 64 61 59.
- Do not extrapolate the sky: my first level curve went to black at sun -0.3 under a bright tan sky.
- Hashed 3D noise for the wind was four bands of 8 hashes; sines look as good for gusts.
- `flicker.mjs` hangs on a second view (the page's clock is taken over): one view per run.
  There is no `timeout` on macOS, and zsh does not split `$VAR` in a `for`.

**Open:**
- No terrain in the reflection: real lakes show a dark band under their far shore. The largest
  thing still missing. Beyond 2.5 km there is no mask, so it needs a new idea there.
- `skyColor` is measured for this atmosphere in clear weather: it does not follow weather or another
  planet's sky. Wind is one fixed field, not tied to weather either.
- Close by the water changed too: the waves are still to do.

### Rivers against the baked state (2026-11-05, same day, uncommitted)

Owner's views: `tools/perf/lakeLook/ownerViews-2026-11-05b.json` (far dots, seams at both ends,
cyan, slow steep water, flow stopping at the lake, an upstream wave on arrival, a triangle in the
glare). Before/after: `rivers-before-after.png` in the same results folder.

**The upstream wave.** Measured with a distance-time map (`wwAlong`, `surge.mjs` with `along`):
level against baked along the river, one row a second; a wave going up is a diagonal. Three causes,
found in this order, each proved by the map:
- Friction used the hydraulic depth; the raster's speed and the solver's friction meet at the depth.
  n^2 V^2 / D^(4/3) came to 57 % of gravity, so the river ran away from its baked state (+10 %,
  still climbing at 30 s). The test had the same Rh in it, so it passed. Section 9's "level RMS
  0.008 m at 0.1 s" could not see this: it looked at 0.1 s.
- Rocks are in the solver's bed and not in W: a ledge at s = 416 of river 2557 held +52 cm and sent
  a 15-20 cm step up the river at ~3 m/s. With rocks out of the bed it was gone. Now solid only where
  Froude >= 1.2: in supercritical water nothing goes upstream. Elsewhere they are drawn, wake included.
- The design discharge was more than the outlet can pass (Q from the wide middle, a narrow neck on
  flat water): a jet of 5.4 m/s on lake water, then a bulge, or once capped, 0.3 m draining down the
  river. Q is now what the outlet passes on the fall available.
Arrival at the owner's spot: rise 0.70 -> 0.003 m, front steepness 0.19 -> 0.04, lake level movement
0.10 -> 0, river's 0.34 -> 0.16 m, solver speed against baked +10 % -> -4 %. Rivers 453 and 2560: rise
0.07 and 0.007 m, no stripe. Left: a sag of 0.2-0.3 m near outlets, stable; a slow even rise of
~1 cm/s on river 2560.

**Wrong turns, do not repeat.** A longer hidden warm-up changes nothing: the level has nowhere
steady to go. Releasing blocks from the baked state over 10 s delays the wave and makes it bigger
(river movement 0.48 m at 14 s): when solver and baked disagree, hiding moves the problem. The fake
jet looked like the cause and was not: old and new code had the same wave. The centroid of
moving cells mixes rapids into it: use the map.

**Speed at river ends.** One discharge through a section 2.7x wider made 1.9 m/s down a 44 % fall,
n 0.34 holding it there. Steep channels are now filled to the normal depth of a rough bed (Manning
0.1): the bed rises, same discharge, 3.9 m/s there, n 0.10.

**Into lakes.** Speed came from the faded channel's area, so it rose to the limit on flat lake
water, then stopped on straight lines (the owner's triangle): now the river's own section, faded
past the shore and on water at the lake's level, and fading sideways. `riverPlumes`: flow only,
stamped on lake water after the bake, 4 m/s for 80 m at river 453, gone by ~190 m; pages end about
200 m past a shore, so longer needs more pages. Its foam starts as the river's and falls away over
`plumeFoamM` of its length. Lake water
used to have no baked foam, and the solver's last word held foam or the lake's share, so plume foam
stopped in a zigzag at the blocks, and with none the white stopped dead at the shore: the word now
holds both (`bakedWord`, `bakedFoam`, `bakedLake`) and lake water decays toward its baked foam.

**Eye height.** Water falling toward the camera stands above its eye. Three things took that for
the water's underside, each drawing a straight line level on the owner's screen: Fresnel in
`whiteSurface`; `above` in `nearWaterCompose`, which every river tier fed the planet's up; and the sky,
which judged the sun's height from a flipped up and went black. Each tier now passes its surface's
plane, `above` is a ramp past edge-on, and `waterSurfaceTerms` takes the planet's up and turns the
surface over itself. Capture poses with `up` [0, 1, 0] are
rolled here: the same line runs diagonally in them, so look for it there too.

**Fast water is not clear** (`nearWaterAerated`): through clear water each cross-wave of fast
shallow flow, a step in depth, drew a line against the bed. Probably oblique standing waves: straight,
changing with time, only in the fast water. That reading is not proved.

**Cost** (old against new, 2 rounds, across loads): GPU +0.1-0.4 ms, bake +90 ms in the worker,
main thread the same; stepped blocks 56 -> 132 at o-steep-red, 85 -> 106 at o-plume-green. Measured
before the last shading changes.

**Shores.** Removed (owner's fourth look, below). Lake outlines are the terrain's contours again.
Do not repeat:
- A fragment shoreline (`waterShoreM`, water starting at a noise depth, a wet film, a soft fade). It
  blurred ground into water, showed the terrain's grid in blocks close up, and exposed ground at river
  ends as land bridges. The owner expected geometry.
- Shores as geometry in the height function (`lakeShoreDelta_d`: ground raised by noise near a lake's
  level, in bands from 430 to 13 m). Ribs and waffles on every shore, and it stood a river's bed above
  its water wherever it passed a lake's level: a land bridge of 300 m at `o-bridge`, beyond the last
  160 m of river it was kept clear of. A term that moves ground near a level cannot know what else is
  near that level.

**Far rivers:** foam fades with distance the same way in every tier (`waterFoamFar`), or it steps at
the handover.

**Open:** faint straight lines remain in fast water close by. No vortices yet: the plume gives
the solver moving water, but lake drag (0.8/s) damps eddies in about a second. Gentle reaches run
slower than before (2.6 -> 2.0 m/s on river 2557), and a rapid there lost its white. Rocks in
subcritical water stand in it without moving it. The mud bank beside steep water shows more
now the cyan has gone.

### Near water by distance, wider rivers (2026-11-05, fourth look, uncommitted)

Owner's views: `tools/perf/lakeLook/ownerViews-2026-11-05c.json`. Evidence:
`tools/perf/structured-terrain-results/water-lod-2026-11-05/` (`baseline`, `fin`, `fin2`, `cmp-base`, `costab`,
`flicker-new`, `surge-*`).

**One surface, the camera decides.** The owner had asked for a level of detail; I had extended the fine area
at river ends. What they saw at the purple star is `whiteSurface`, and it stopped there because everything under
0.6 m/s was handed to the distant model, by flow and not by distance. Now all near tiers (lake sheets, field pages,
solver mesh) draw `whiteSurface` in one frame on one clock, so nothing changes at a tier's edge. The lake sheets bind
`whiteU` for it. `lakeDetailM` (900 m, fade from 55 %, under the near meshes' `fadeStartM`) is the only handover:
`waterSurfaceTerms` is the distant model alone now. With `whitewater=off` lakes keep the distant model.
- Still water has no flow to carry a pattern, and the two phases boil on the spot at its speeds, so each scale drifts
  its own way, at half the noise (`whiteFineSlope`, `whiteCoarseSlope`, `whiteFineLace`, `whiteCoarseLace`).
- Close water that moves has at least still water's ruffle and lace, and calm water its coarse scales, moving or
  not. Gated on still alone, the slow rim of a plume was a smooth patch beside the camera, and from higher up a dark blob.
- A web three times coarser takes over as the fine one goes, or the web ends in a ring around the camera. Each web
  keeps plain noise of its own size: bare ridges read as a jigsaw from above.
- From above the sky's reflection is weak, so slopes shade the body as well (`nearWaterRelief`).
- `qtDiag.water.look({ closeLace, closeRuffle, lakeDetailM })` tunes it. Lace is by my eye against the star.

Cost, in one page, `lakeDetailM` 1 against 900 (`costAB.js`, 6 rounds, owner's game open): o-star +0.90, o-waffles +0.78,
lake2814-low +0.61, lake180-low +0.36 ms. Flicker at 30 FPS (lake180-low, `minTop: 0`): hf 0.064, blinks 0 %, no beat.

**Width.** The traces' discharge is so small that nearly every river sat on `minWidthM`, and steep rivers get nothing
from the bake's widening, so the usual river was thin. `minWidthM` 12 -> 36 (`streamShape` too), constrictions 8 -> 24 at
least, `minDepthM` 1.6 -> 2.6. Thin rivers are the exception: `thinShare` 12 %, by hash, take `thinScale` 0.34 of width,
12 m and 8 m at least (narrower beds drew as beads). The width noise's wide side goes by its root in `riverReachShape`
(up to 5 x made reaches of 180 m), the bake's widening came down (`widenMax` 6 -> 2), so the widest reaches stay what they
were, and `meanderAmp` 1.5 -> 1 (still twice the old swing, and pages reach by it). The owner judged the result sufficient.
Same poses, old against new (`bakedWidths`): typical river 18 -> 36 m, along rivers 20 -> 34 m, under 16 m 31 -> 12 %, top 1 %
108 -> 116 m. Traced, all rivers: typical 12.6 -> 34.6 m, thinnest tenth 9.2 -> 24 m.
What those numbers are: the bake's data, weighted to the short rivers between lakes, which were the thin ones. In drawn
pixels (`drawnWidths.mjs`, straight down, water = frame against dry frame; agrees with the trace at the 24 m floor), the long
rivers, away from their ends, went 38 -> 42 m at the median: they were wide already. Their thin end is what moved: thinnest
tenth 10 -> 25 m, under 16 m 19 -> 3 %. Do not quote a width without saying which of these it is.

**Banks do not climb** (`bankCutM`, `bankLeast`, `bankLeastM`). Width alone raised cuts everywhere: 13 m walls on a hill.
Where natural ground at a bank's edge stands over 3 m above the water that bank comes in, to 40 % at the least. Cuts at
the real water's edge (`bankCuts.js`): along rivers p90 3.1 -> 3.3 m, p99 6.1 -> 5.9 m, worst 14 -> 9 m. It also took away the point
of land and dark face at outlets.

**The neck at mouths** (owner's blue arrow). A steep stream's channel under the 32 m mask took the lake's level, so only
the tip of its cut was under water. A channel still above the lake keeps its own level until it reaches it
(`keeps a steep stream its full width`, fails on the old bake). `bakedWidths` also counts pinches now: 8 -> 4, none missing water.

**Outlets.** `n` came from the speed capped by the fall, too much friction where the solver must carry Q / area: from the
uncapped speed now. Measured at `o-upstream-black`, 14 s after arrival, against the accepted state: no diagonal in the map (no wave
going upstream), river movement 0.20 -> 0.23, speed 2.0 -> 2.1 m/s, sag under baked 33 -> 40-46 cm, 18 -> 20 % of the depth.

**Wrong turns, do not repeat.**
- Flaring mouths to round the points of land: it dug further into the hill, black slits and straight-edged trumpets.
- `wwSurge` `rise` of 1.5 m looked like the wave back. Its top cells were thin sheets over banks baked dry (`hb` < 0), not
  still water: `wwRiseCells` says where. Find the cells before believing the number.
- Reading that sag three times: an energy limit (`0.7 sqrt(2 g fall)`), the drop missing from W, then depth. Each moved it
  little. The map plus baked against solver depth and speed along the river (`wwAlong` `vb`, `hb`) showed a sill: a lake's exit is a
  weir, q = 1.705 E^1.5. A wider river needs a deeper exit.
- Capping Q at that sill: same water through three times the width is a third of the speed, and rivers stopped at 0.3 m/s.
- Keeping the old depth: the exit is then too shallow for the width (sag -50 to -65 cm).
- Do not read frame cost across page loads with the owner's game open: one run read everything double.

**Cost of the width:** same poses: field pages +41 % (6512 -> 9164), 101 -> 143 MB, worker bake 6.2 -> 8.5 s, main thread 154 -> 218 ms
per bake, solver blocks 129 -> 155 at o-upstream-black. Pages reach by half-width times about five: the next saving if memory matters.

### Fifth look (2026-11-05, same day, uncommitted)

Owner's views: `tools/perf/lakeLook/ownerViews-2026-11-05d.json`. Evidence: the same folder (`g-base`, `g-new`, `plan`, `fin3`,
`cmp-base` against `cmp-fin`, `flicker-foam`, `px-*`).

**A white patch far off, calm close by** (green stars). Foam heat view (water debug 12), same spot: 0.7-1.0 from afar, 0.1-0.3 close.
The far tiers' foam comes from the fall, the solver's from the Froude number, and on a wide deep reach that falls fast water
is not supercritical. The difference also drew the stepped white edge along solver blocks. The near mesh now takes the far
tiers' foam as a floor (`whitewaterSurface.wgsl.js`). Flicker on heavy foam at 30 FPS: hf 1.10, blinks 0.07 %.

**Slots of water, points of land, black cuts, ghost bands** (green arrows). From low down they look huge: from above (poses
`plan-*`) they are slivers. A river's end is wide, and it runs on past the shore: its centre is under the lake, but where the shore
curves away its side cut on through the land at the lake's level. Past a shore a channel now cuts no ground over the lake's level
(`mouthHoldM`, `mouthHoldRiseM`, test `cuts no land past a lake shore`, fails on the old bake).

**A dark line across the foam** just before a lake: the channel rule above took a river's last metres off lake water, and plumes
stamped on lake water only, so the speed died before the plume began. A plume now covers its own river's last channel too.

**Wrong turns, do not repeat.**
- Reading those shapes from a low oblique view. Holes in the water, then floods, then deltas: all wrong. `w7` said it was ground, a
  view straight down said how big. Look from above before explaining a shape.
- Scaling mouth flares and deltas down with the width: no visible change at the poses it was for. Reverted.
- Trusting `bakedWidths` for what the eye gets, and reporting "2 x" from it.

**Open:** the sag near outlets (20 % of depth), which needs exits deep enough for their flow. A dip of 16 cm going up from a river's
end on arrival, gone in 6 s, since plumes cover their channel. Thin sheets over banks on steep bends (`rise` 0.6 m in `wwSurge`,
h 0.3-0.5 m), not visible in the settled frame at o-upstream-black. Close by at eye height the lace is soft flecks. Lake outlines are
plain contours again: the owner's "blobs" stand until they decide.
