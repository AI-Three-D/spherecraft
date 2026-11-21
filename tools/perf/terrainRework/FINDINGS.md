# Initial terrain review

Review date: 2026-11-12. Reference views were captured with the default world,
fixed sun and clouds disabled, with terrain tiles settled. The comparison tool
is described in [README.md](README.md). Water planning was not required to
finish for these pictures, so they are not evidence of water correctness.

- At the sandy lowland reference direction, switching off the existing
  rolling-hill feature made essentially no visible difference. The current
  feature is restricted by a sparse regional mask and is further multiplied
  by regional roughness.
- At the mountain reference direction, disabling the erosion filter at world
  startup removes most of the visible channels and leaves a smooth massif.
  The existing erosion therefore contributes important structure, even though
  some cuts and peaks look too regular or extreme from high above.
- A smaller erosion scale (700 m instead of 1500 m) added finer branching at
  the mountain site. At strength 0.28 it also made very dark, sharp cuts; at
  0.15 the shape was softer, but still fell short of the desired regional
  structure. Reducing strength and increasing rounding at the original scale
  removed useful detail without fixing the main silhouette. None of these
  settings has been adopted as a default.
- Lighting debug mode 91 showed the darkest cuts correspond to very low direct
  illumination on the slopes. The base-colour view did not contain the same
  black cuts, and the no-shadow/no-AO lighting view still showed them. The AO
  diagnostic showed no meaningful AO attenuation there. This does not
  establish whether the underlying normals match the geometry, and does not
  justify a lighting change by itself.
- A discarded prototype replaced the sparse rolling chains with a continuous
  three-octave field. It produced broad, smooth swells rather than convincing
  hills and valleys, and changed which lakes appeared at the reference site.
  Moving that candidate into the existing erosion input produced little
  visible improvement at the tested gentle site. Neither change was retained.

For a limited performance comparison, a warmed native WebGPU test generated 24
128×128 tiles across three reference directions at depths 8 and 11, five
measured rounds, with height, normal and tile output. The median sum of the
measured compute passes was approximately 2.71 ms/tile with the original
rolling feature and 2.55 ms/tile with the discarded replacement. This excludes
other generation work, including the full splat path and cold lake-table
construction. It is not an end-to-end streaming benchmark and does not make
the rejected prototype a visual success.

The next landform candidate needs actual regional hills and valleys with
variation in shape and scale, evaluated by itself before integration. It must
then be checked with water initialized from the same terrain and benchmarked
against the production tile workload; the existing erosion should be retained
where it produces useful forms.

## Range experiment

The original range has regularly spaced analytic spurs. With erosion and the
other prominent features disabled, the same spacing is visible in the base
range. It therefore contributes to the repeated rib pattern independently of
the erosion filter. A placement census for this particular planet and seed
found only two range sites whose centres have a regional land-mask value above
0.45; this is an approximation and does not imply the same count for other
seeds or planets.

`range-directional.wgsl` is a review-only candidate, not a runtime change. It
keeps the existing range placement, broad footprint, smooth boundary and
analytic height derivatives, but replaces the evenly spaced spurs with a
site-seeded, directionally stretched field. At the first site it gives a
broader connected upland with less regular ribs. In isolation its silhouette
is too smooth to read as a convincing mountain system. At the second site,
the complete stack contains broad plateau-like surfaces and steep walls.
Neither result meets the target yet. The other terrain features and erosion
remain unchanged in the full-stack comparison.

For the isolated comparison the third, fourth and fifth arguments of
`views.mjs` are:

```text
{"mountains":false,"mountainLandmark":false,"loneHillsVeryRare":false,"loneHillsLandmark":false,"foothills":false,"meso2":false,"rollingHills":false,"microDetail":false,"waterCarve":false,"lakeBasins":false}
{"position":[46179.1189,-24430.3862,-134034.4821],"target":[32912.0007,-32417.0834,-123729.3259]}
{"erosionFilter":{"strength":0}}
```

This suppresses competing features but leaves the underlying regional base;
it is not a mathematically isolated height field. A second sampled pose is
`{"position":[37046.7593,117236.5801,69169.5822],"target":[37126.3553,117156.5862,69140.1634]}`.
The full-stack runs at both sites reached idle water planning and settled
terrain at each altitude. That is a smoke check only: it does not prove that
river paths, lake shorelines, or caches remain correct after a terrain change.

On the same machine, a limited warmed GPU measurement of 24 tiles and five
rounds gave median sums of about 2.81 ms/tile for the original and 2.82
ms/tile for the candidate, for the height, normal and tile passes only. The
difference is within measurement noise; the result excludes the complete
splat pipeline, cold lake table and production river-field work. It cannot
establish that the candidate meets the overall performance budget.

A GPU finite-difference check of 8,192 slope components around the two sites
found absolute derivative error below 0.0005 in that sample. That is useful
evidence for the candidate's analytic gradients, not a proof of continuity
over the whole planet. More shape work, broader water checks, and an end-to-end
performance comparison are required before adopting it.

## Second range iteration

`range-iteration-2.wgsl` adds a shorter-scale, seeded field to the directional
range. In a feature-isolated height map it breaks up the earlier smooth forms
into a less regular network of ridges. The base still looks like rounded
uplands from some close viewpoints, rather than an independently convincing
mountain range. With the existing erosion enabled the first site has more
connected, varied relief, but the second still has flat tops and steep walls.
This remains a review candidate, not the default runtime shader.

At both sites the full-stack altitude sweep settled from ground to orbit and
water planning was idle at capture. That is a smoke check, not a test of the
correctness of individual rivers or lake boundaries. A numerical GPU check
of 8,192 slope components at the two sites had a maximum absolute error of
0.00047 in the sampled finite differences. In a warmed run of the same limited
24-tile, five-round height/normal/tile-pass measurement described above,
medians were 2.769 ms/tile for the original and 2.774 ms/tile for this
iteration. The small difference is within measurement noise and excludes the
full splat pipeline, cold lake-table setup and river-field work; it is not an
end-to-end production performance result.

The directional model is now selectable at startup. A second warmed test
generated the full set of terrain, normal, material, splat, scatter, climate
and coarse-colour outputs for the same 24 addresses over five rounds. Median
summed GPU pass time was 8.853 ms/tile for legacy and 8.839 ms/tile for the
directional model on the test machine. The differences between rounds are
larger than the model difference. These measurements use a hot lake table and
exclude production river fields, residency/copies and scheduling, so they are
not an end-to-end streaming benchmark.

In a live browser, the legacy and directional models produced different
hydrology terrain keys and different natural heights at the mountain reference
direction. At five sampled directions, after ensuring coverage in both lake
tables, the terrain lake-table height and the river planner's hydrology height
were identical. This checks the shared height source at those points; it does
not validate every generated shoreline or river route.

## Foothill experiments

The existing foothill feature contributes little at the original mountain
review direction. A first replacement with larger-scale noise remained too
subtle there, and at an active foothill location created a broad, flat-topped
rise. A less saturated variant still read mostly as smooth swells. Both were
evaluated with competing features and erosion disabled, and neither was added
to the runtime terrain.

A later trial varied hill scale and orientation across regions and gave a
more coherent rolling shape in isolated views. In a full-stack comparison at
one green upland site, both that trial and a lower-amplitude version changed
the generated terrain enough that a prominent lake from the baseline was no
longer present. Lake positions can legitimately change when terrain changes,
but the impact here is significant relative to the visual gain; the local
planner also reported fewer rivers in those runs. Those counts depend on the
loaded area and are not a planet-wide water-density measurement. The trial
has not been adopted, and its interactions with water need more work.
An isolated finite-difference GPU check of 8,192 slope components had a maximum
absolute error of 0.00079 in that sample. A warmed 24-tile, five-round test of
the full terrain outputs measured medians of 8.692 ms/tile for the current
foothills and 8.648 ms/tile for the trial with the directional range enabled.
This is within run-to-run variation; like the mountain measurement, it excludes
cold lake-table construction, production river fields and streaming overhead.

The later `foothills-regional.wgsl` trial keeps the original contribution and
adds a zero-centred, scale-varying perturbation in suitable regions. At the
green test site the prominent lake remained, with a changed shoreline; the
local planner reported 33 rivers versus 52 in the baseline. At the mountain
site its effect is subtle. The user approved this direction; it is available
as the startup-selectable `regional` foothill model while the original remains
the default. The sampled finite-difference gradient error was at most 0.00060 over
8,192 slope components. In the same warmed full-output 24-tile benchmark, the
median was 8.645 ms/tile for the baseline and 8.782 ms/tile for the trial,
about 1.6% higher in that limited sample. This excludes the same cold lake,
river-field and streaming work described above.
After moving the approved shape into the selectable configuration, the same
measurement gave medians of 8.763 ms/tile for legacy foothills and 8.888
ms/tile for regional foothills (about 1.4% in this sample). A browser check
again found matching lake-table and hydrology heights at the sampled points.

## Initial valley experiments

A test-only replacement for the range used a curved, smoothly bounded negative
height contribution to make a broad valley. At the first range site this
created a closed depression that became a large, very uniformly shaped lake.
Adding a few tributary cuts improved the height map slightly, but their spacing
and edges still looked deliberately drawn rather than geological. At the second
site the depression fell below sea level, so the altitude sweep did not give a
useful view of the valley floor. The lake is not itself evidence of a water
system bug: the negative field creates a closed basin and can legitimately
change drainage. The shape is the concern.

A second test built elevated shoulders around branching low ground. At the
first site its ground-level silhouette reads as a valley, but its overhead
shape is still a smooth, isolated stripe and the surrounding landforms lack
structure. Both experiments were examined without competing terrain features
or erosion from ground level to orbit. Neither is a production candidate, so
neither has been added to the full stack. The temporary substitution reused
range placement to make a controlled comparison; it does not establish how a
separate valley feature should be placed or how often it should occur.

Future valley work should consider the regional relationship between uplands,
drainage paths and lowlands rather than placing an isolated closed stamp. The
water system should follow the resulting terrain, and may itself need tuning;
a terrain change need not preserve existing lakes or river counts. No water
changes can be justified by these visual checks alone.

## Mountain and foothill overlap

A GPU scan of the current seed found overlapping contributions on face 5, near
u=0.309, v=0.391. A full-stack camera at position
`[35841,-29989,-133981]` looking at `[46360,-26590,-121590]` shows the range
and the surrounding lower relief. At the probe direction, the natural height
was about 2102 m with regional foothills and 1750 m with the foothill feature
disabled; this includes the downstream effect on erosion and is not a direct
measurement of foothill amplitude. Disabling foothills also changed the local
water placement, as expected from a change in terrain.

Both runs settled with water planning idle from low altitude through orbit.
The automatic ground-level camera intersected a steep slope, so that image is
not adequate evidence of the ground view. The overlap is real, but the aerial
view still reads more as a rugged range with smoother surroundings than a fully
convincing transition into foothills. The preview server exposes this camera as
`terrainPreviewSite=4` for further review.

## Mountain valley trial

Two noise-contour trials produced closed loops in overhead height maps; the
second also failed to produce a readable valley in an isolated green-upland
altitude sweep. They were discarded. An initial wide-cut trial used a
bounded valley and seeded side branches to reduce the height of the directional
mountain range. This was a range experiment, not a general valley or canyon
system, and it does not alter the runtime models.

At the mountain/foothill overlap site, the isolated trial creates a broad
low corridor between uplands. In the full stack it softens and opens the middle
of the range while retaining nearby peaks. Some flanks are still unnaturally
smooth and the branch pattern remains too obviously aligned in an overhead
height map. At the other range site, the isolated terrain is mostly a smooth
snow-covered form; it is not adequate evidence that the shape generalizes.
The full-stack sweep at the first site and isolated sweeps at both sites settled
from ground to orbit with water planning idle, although the first site's full
stack ground view was obstructed by a nearby slope. These are visual checks,
not proof of river routing or lake correctness. Terrain changes may legitimately
change the water; the water system may itself require adaptation.

A finite-difference check of 8,192 slope components around the two range sites
found maximum absolute error 0.00037 in that sample. In a warmed full-output
24-tile test over five measured rounds, median summed GPU pass time was 8.850
ms/tile for the directional range and 9.025 ms/tile for the trial, about 2%
more in that sample. This excludes cold lake-table setup, production river
fields, copies and streaming; no end-to-end performance claim follows. The
trial repeats placement calculations and has not been optimized. It should not
be promoted without improving variation and validating water and production
performance more broadly. These numbers refer to the earlier wide-cut trial.

The narrow-cut revision in `range-valley-trial.wgsl` reduces the center of the
range while leaving ridges on either side. From the marked comparison angles,
this creates a visible valley instead of simply flattening the mountain spine.
With erosion and competing terrain features disabled, the ground view shows a
recognizable valley, but its long walls are overly smooth and parallel from
above and orbit. It is still a prototype, not a finished general valley system.
The paired root screenshots use the original mountain and foothill models, with
only the valley experiment toggled; each pair uses identical camera and sun.
Terrain selection settled and lake planning was idle for the captures.

A sampled finite-difference check of 8,192 slope components gave maximum
absolute error 0.00073. The eight preview combinations started and the terrain
and water samplers agreed at the checked direction. In a warmed full-output
24-tile test over five measured rounds, the directional-range baseline median
was 8.886 ms/tile and the narrow trial median was 8.940 ms/tile, roughly 0.6%
in this run. Run-to-run variation was larger; this is not a streaming or cold
water-generation benchmark.

## Reported shoreline pockets and surface seam

The shoreline pockets at camera `[5810.9,-44177.4,-123302.6]` reproduce with
regional foothills and the original mountain range, with the valley trial off.
The reported surface seam near `[4173.5,-33568.3,-127173.2]` also reproduces
in that combination, so neither requires the directional range or valley
trial. With legacy foothills the scene at each fixed direction changes
substantially, so these comparisons cannot establish whether an identical
pocket or seam was visible there before the foothill change.

At the seam, debug mode 45 (terrain base color) shows the line, while mode 92
(final terrain normal) shows no matching abrupt line. This is evidence of a
material-color discontinuity, not evidence of a geometric valley seam; its
specific cause is not yet established. The lake-cell water coverage extends
inside a containment curve and relies on terrain depth to expose the sheet, so
isolated low patches are a plausible mechanism for the shoreline pockets, but
this has not been proven by the screenshots. Both issues remain open.

### Valley variation and rolling-hills trial

The valley preview varies its centerline, width, cross-section and depth along
individual ranges. The seeded branch sequence is unchanged. At the matched
site-10 pose the corridor remains visible, while the right-hand wall and floor
change appreciably. Some slopes are still smooth and steep; the separate erosion
work has not been addressed here.

The next trial replaces the existing rolling-hill function with regionally
gated broad and finer undulations. The isolate was inspected with erosion and
competing relief disabled, then with the complete stack from the surface to
orbit. It adds relief but remains smooth and warrants visual review. Its signed
height contribution and the underlying region mask can alter lake placement.
Both trials remain confined to the comparison server.

All sixteen comparison selections compiled in Chrome WebGPU. For each, a
single local lake-table/river-planning sampler comparison agreed within 0.5 m
and the sampler cache key was distinct. These are smoke checks, not a global
hydrology or shoreline test. GPU finite-difference checks sampled 8,192 slope
components for each trial (maximum absolute error about 0.00070 for valley and
0.00137 for rolling hills). A warmed 24-tile GPU-pass benchmark at three sample
locations, repeated in reverse order, had median totals of 11.37–11.73 ms/tile
for the previous valley and 10.80–10.88 ms/tile for both new trials together;
this is a limited hardware-specific measurement, not end-to-end streaming time.

### Valley wall experiment

`range-valley-wall-trial.wgsl` is a separate follow-up to the prior valley
preview. It broadens the main transition and increases the width and strength
of seeded side branches, which breaks up the long wall at the reported site.
The trial leaves more nearby mountain relief than a broader four-branch cut
that was also evaluated. Stronger meandering introduced new cliffs, and an
extra shoulder-noise experiment made little difference at the reported views.
An alternative with crosswise tributaries still left a continuous ridge; none
of those variants was kept. The geometry is still too smooth in isolation and a steep,
aligned ridge remains in places. This candidate does not yet solve the problem
generally and has not replaced the prior preview or production range.

Matched screenshots use all four reported camera poses; the root images
`valley-wall-previous.png` and `valley-wall-trial.png` compare the side view,
and `valley-end-previous.png` and `valley-end-trial.png` compare one end.
The isolated and full-stack sweeps at the first range were inspected from
surface to orbit; the second snowy location was also inspected from surface to
orbit in the full stack. At the isolated reference pose, the rendering and
water sampler did not agree well enough for one initial ground-camera test,
so the camera was moved to a nearby usable position for the final sweep.

All sixteen preview selections initialized and the two water height samplers
agreed at the checked location. This does not establish water behavior across
all terrain. A GPU finite-difference check of 8,192 slope components had a
maximum absolute error of 0.00115 in this sample. In a warmed 24-tile GPU-pass
benchmark, median summed pass time was 8.68 ms/tile for the prior valley and
8.56 ms/tile for this candidate. This excludes streaming, copies and cold
water generation and does not establish performance on other hardware.

## Canyon experiment (unfinished)

The preview-only `canyon-trial.wgsl` cuts a meandering main channel and six
side channels into existing high ground. It is chosen independently using
`terrainRework=canyon` on the comparison server. The result is not ready:
the low and medium altitude views still read mostly as smooth, broad valleys,
and the side drainage does not have the character of the reference gorge.
There is no claim that a river will form in the cut. The production shader has
not been changed by this experiment.

The candidate's analytic derivatives agreed with finite differences in 8,192
sampled components (maximum absolute slope error 0.00054). In three dense
sample patches, the steepest sampled contribution from the cut was 0.52, but
this is not a bound on the final terrain. In a separate 65,536-point patch,
where the candidate changed height by over 50 m, the existing terrain already
had slopes over 1; those counts rose from 44 to 50 with the trial, and the
sampled maximum rose from 1.55 to 1.68. These are local samples, not a global
guarantee, and do not include water modification. Further design must account
for existing relief instead of assuming gentle feature slopes guarantee a
safe combined surface.

At the local comparison point the terrain/lake and natural river-planning
samplers matched with the canyon alone and in the full trial stack, and each
selection used a different terrain cache key. This does not establish that a
river or lake will be placed correctly. A small 24-tile GPU timing experiment
on this machine, with five warm rounds, had a median sum of reported pass times
of 8.64 ms/tile without the canyon and 8.85 ms/tile with it. The pass sum is a
relative diagnostic, not end-to-end generation latency, and results can vary
by device and terrain.

## Canyon country (rejected)

Review date: 2026-11-16. Rejected by the owner and reverted the same day:
`canyon-trial.wgsl` is again the stamped canyon above, and this attempt is
kept as `canyon-country-rejected.wgsl`. The owner's first look, at the spawn
area (camera about `[-132482, 5596, -355]`, 1.5 km up), showed jagged
sawtooth crests and striped, crumpled walls. That location was never in the
review: every review camera had been chosen from height maps at one site, and
the slope statistics below did not catch it. Lesson for the next landform:
review at randomly chosen points inside the feature and at the spawn area,
close to the ground, not only at found or hand-picked cameras. The rest of
this section records what was tried.

The reference was the concept art of a dissected plateau: flat tableland,
steep walls, a branching network, river and lake on the floor.

Construction (all heights in metres):

- Province: a 70 km field on interior land (land mask above ~0.55). Its zero
  line, plus 8 km lobes, is the escarpment; detached mesas form where the
  lobes isolate patches.
- Tableland 300-620 m above the surrounding lowland (24 km variation).
- Every cut is a function of the distance to the zero isoline of a noise
  field, |n| / sqrt(|grad n|^2 + gRef^2), using the analytic gradients. The
  wall therefore has one designed profile at any orientation. gRef (about
  0.8 / wavelength) keeps the estimate from compressing walls where the field
  is flat; without it the walls collapsed to step lines.
- Wall profile: a ramp with C1 fillets at the foot and the rim (mean slope
  0.85, peak about 1.05), plus up to two benches as a smooth modulation in
  height. Earlier piecewise profiles with a cliff band produced creases that
  the vertex grid aliased into rows of teeth along rims and benches.
- Trunk canyons (10 km field, shared 2 km domain warp) are broken into
  separate canyons by a 14 km presence field; its ramps are the valley heads.
  An earlier attempt kept only isoline stretches aligned with the regional
  drainage; the alignment flips abruptly near saddles and produced vertical
  steps. Tributaries (3.2 km) are deep near a trunk and shallow draws far
  away; short side gullies (1.4 km) cut back into rims beside larger cuts. A
  1.2 km field shifts the rim line (alcoves and buttresses).
- Floors reach the surrounding lowland, so canyons drain out through the
  escarpment.
- Composition: hills, foothills and mountains combine with the tableland by a
  smooth maximum (buttes rise out of it; an earlier gate cut moats around
  hills). Rolling and meso relief are calmed by 85 % on the tableland. The
  tableland is erosion relief, so the gully filter runs on its walls.

Measured (sampled natural heights, not rendered geometry): in an
equirectangular planet sample the first, lower-threshold version changed 23 %
of land samples (the polar rows exaggerate the share); the threshold was then
raised. In a 6 km, 20 m-cell patch, 0.6-8 % of samples exceed slope 1
depending on the wall profile, with isolated maxima of 3.6-4.9 where cuts
intersect; the first version had 22 % above 1 and a maximum of 16. With
erosion disabled the slope statistics barely changed, so the steepness came
from the construction, not from erosion.

A warmed native-WebGPU run of 40 tiles (24 inside canyon country, depths 8
and 11, full output including splat) gave median summed pass times of 9.41
ms/tile without and 10.23 ms/tile with the canyon (+8.7 %); before sharing
the domain warp it was 10.50. Tiles outside the province pay one 2-octave
noise. This mix is deliberately canyon-heavy and is not a planet average or
streaming time.

Matched views were captured at three cameras found with `valleyViews.mjs`
at one site; they looked acceptable from there, which proved not to be
representative.

Not solved here:
- Colour: the concept's sand tops and green walls are a material question;
  the current splat makes most of the plateau green. A dashed line appears
  where a sand/green boundary follows a bench (texel-resolution splat edge).
- Wall texture: the erosion filter's 1.5 km gullies are too coarse for
  300-600 m walls; finer gullies need the erosion pass.
- Placement is its own field; it should become one province of a shared
  planet-wide landform assignment (see the roadmap in README.md).
- The trunk floors widen into broad basins where the trunk field is flat.
- Water: the planner sees the new terrain; that a river follows a particular
  canyon floor is not established.

## Caldera volcanoes — 2026-11-20

The bounded canyon retry is saved as `canyon-grid-trial.wgsl`. It replaces
the noise-isoline construction with a small plateau and explicitly wide main
and tributary cuts. Its height map still reads as a stamped corridor, so it
was parked without replacing the canyon preview or production terrain. This
does not establish that good canyons are impossible on the grid.

The next landform, caldera volcanoes, is implemented in the production
`earthLike` and `lakeLand` generators. It is enabled in the demo world's
`terrain.json`, with a validated startup configuration and `calderas=0/1`
comparison switch. See `README.md` for the settings and review commands.

The broad apron rises into an asymmetric rim and rounded bowl. Smooth local
warps, low rim saddles and shallow radial drainage vary the silhouette. The
nominal radius is 8–10.5 km and relief is 1.2–1.6 km above the regional
foundation; these are design parameters, not maximum final-world heights.
The configured height/radius ratio cannot exceed 0.2. The feature uses analytic
dual derivatives and avoids gradient-dependent distance estimates.

Composition is a smooth maximum with the existing ground, faded across a
contained footprint. It fills low ground rather than removing whole terrain
bands and their mean offsets. The blend is distributed over the lake
generator's bands, so omitting finer bands during lake planning does not leave
their negative imprint in the macro band. Existing high peaks can remain
inside or beside a caldera. The normal material and climate system still
colours it: there is no volcanic biome or forced crater lake.

Validation of the final preset:

- A 360×180 planet survey located 19 changed clusters for further inspection;
  this is a survey at that resolution, not an exact census or area estimate.
- Nineteen 32 km patches at 256×256 samples, plus a 24 km spawn patch,
  compared 1,310,720 natural land heights with the feature off/on. No point
  crossed from a central-difference slope at or below 1 to above 1, and no
  point was lowered by more than 1 m. The feature changed 381,153 heights by
  more than 1 m in this deliberately feature-heavy sample. Existing steep
  terrain remains; the spacing is about 125.5 m (94.1 m at spawn), so these
  are local sampled results before lakes, rivers and render micro detail.
- A separate 2 m finite-difference check sampled the isolated shape at 4,864
  deterministic points around the surveyed sites; 3,360 were active. The
  maximum sampled designed slope was 0.7333 and maximum tangent-gradient
  error was 0.00115. These are not global bounds on the composed surface.
- Chrome WebGPU checked 13 directions with calderas off, on, and on with the
  six earlier mountain/foothill/valley/rolling/coastal trials. Terrain/lake
  and river-planning heights matched at every checked point and all three
  terrain cache keys differed. This is not a planet-wide hydrology test.
- Matched production views use four fixed cameras from approach through
  orbit, with terrain settled and water planning idle. Three deterministic
  unselected ground views, spawn and a snowy aerial view were also captured
  with the six earlier trials active. An initial, gentler preset was viewed
  with competing relief and erosion disabled before the bowl was deepened.
- High sun and the existing grass material can make the gentle outer slopes
  hard to read. The matched final views use a fixed sun elevation of 0.4;
  no rendering or lighting defaults were changed for the landform.
- `npm test -- --maxWorkers=2`: 629 tests passed in 123 files. Typechecking,
  declaration freshness, targeted lint and WGSL compilation passed. The
  compiler tests cover both base generators, lake construction/read variants
  and all fine output consumers with the earlier selectable models.
- The live comparison checkbox was exercised on the rebuilt preview server:
  it enabled/disabled the startup configuration and preserved the exact
  camera position, target, up vector and field of view, without page errors.

The paired images `caldera-before.png` and `caldera-after.png` in the project
root use the aerial camera; `caldera-rim.png` looks into the bowl.

In a paired native-WebGPU run with both generators on the same device, 24
128×128 tiles across two caldera areas and spawn (depths 8 and 11) were
generated with height, normal, tile material, splat IDs, weights and validity.
After one warm round, five rounds alternated the off/on order per tile. Median
fenced generation latency was 12.59 ms/tile off and 12.87 ms/tile on (about
2.2% higher in this deliberately feature-heavy sample). The rounds varied from
11.64–14.29 ms off and 12.52–13.70 ms on. This includes CPU submission, GPU
completion and warm lake-table use, but excludes cold lake construction,
streaming and production river fields. It is hardware-specific diagnostic
evidence, not a planet-average performance guarantee. Earlier unpaired runs
varied substantially and were not used to attribute a cost to the feature.

`caldera-validation.json` records source hashes, the preset, map comparisons,
sampled water heights, isolated gradient checks, paired timing and check
results. The native lab specs and fixed camera files reproduce these checks.

## Mesas and cuesta ridges

The mesa group has a wide flat top, rounded rim, two-stage slopes, and
smaller detached buttes. The cuesta group has staggered crests, asymmetric
cross sections and a shared dip direction. The two features use the same
seeded inland placement grid, with one type per site. Enabling one type
leaves the other type's positions intact. The blend fades fully before the
shoreline transition and uses the existing terrain bands and water sampler.
The world author can enable each feature independently.

A 720×360 native WebGPU survey of the demo seed measured peak height gains
of 1,156 m for mesas and 696 m for cuestas in the sampled natural land.
Across all 259,200 directions, the rounded metre heights with both enabled
matched the sum of the independent changes. No sampled height was lowered.
Across eight 24 km patches per feature at 94 m grid spacing, none of the
1,048,576 samples crossed from slope at or below 1 to above 1. These
measurements precede lakes, rivers and final terrain detail.

In Chrome WebGPU, the lake-table and river-planning heights matched at
all 18 sampled directions with neither feature, each feature individually,
and both features alongside the earlier trials. The four configurations
had distinct terrain cache keys. The full suite passed with 630 tests,
along with typechecking and targeted lint.

The rendered examples retain the current grass, sand and snow materials.
Mesa faces can read as dark in low sun, and existing peaks can partly obscure
some ridge groups. The two preview cameras per feature show the overall
shape and a lower approach. The geometry is ready for the first integration
pass with the existing continental and ocean placement.

The subsequent visual review found the cuestas too rounded near mountains
and the mesas too soft. Both remain disabled trials and were dropped from
the first integration candidate.

## Fjords and fells

Fjords follow the gradient of the existing coastal field. Placement requires
a seaward sample and higher ground inland. The cut curves toward the head,
and the floor sits below the existing sea level. Fells blend a group of
rounded summits and saddles into the existing relief, with terrain-scale
texture on the slopes.

Four sampled inlets on the demo seed connected to seawater in the natural
height maps at 125 m spacing, with routes 11–17 km into the new cuts. These
maps precede lake shaping and river carving. Two inlets also showed a
continuous sea surface in the game with the earlier coastal trials enabled.
Terrain and river-planning samplers agreed at all 33 checked directions with
fjords and fells enabled alongside the earlier trials.

Widening the fjord walls brought the number of new samples crossing slope 1
down to 13 in four 40 km patches. Blending fell relief with nearby hills
after the main erosion pass brought the count down to 222 in seven 25 km
patches, mostly around existing steep relief. These counts describe the
tested patches and grid spacings. The fells use the current biome materials,
and the fjords have no latitude or glacier placement rule yet.

The final shots are in `review/`. The shader tests cover both terrain
bases and the lake build/read variants. All 631 tests, typechecking and
targeted lint passed.
