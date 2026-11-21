# Terrain rework review

The recovered work continues on `feature/terrain-rework`; see
[STATUS.md](STATUS.md) for the session reference, current decisions and next work.

Serve this checkout with `python3 server.py`, then use system Chrome and WebGPU:

```sh
node tools/perf/terrainRework/views.mjs /tmp/terrain-review http://127.0.0.1:8000
```

Open `wizard_game/standalone.html` for the unified stack. The demo world's
`terrain.json` selects tectonic relief, directional mountain ranges, regional
foothills and the other landforms described below. Terrain tiles, the lake table and
river planning use the same startup settings. For a pre-rework comparison,
append `?terrainRework=&calderas=0&fjords=0&fells=0` to keep the lake and river
system while restoring the earlier landforms.

World authoring can choose `mountainRangeModel` and `foothills.model` and
tune the foothill scale, coverage and strength. The `landformDetails` flags
enable range valleys, regional rolling hills, coastal hills and coves.
With the local server running, `node tools/perf/terrainRework/checkWater.mjs`
compares terrain lake-table heights with the river-planning sampler at several
directions and verifies that the two mountain models have different water
cache keys. It is a targeted smoke check, not a complete hydrology validation.

On systems where Chrome is elsewhere, set `CHROME_PATH` to its executable.

The optional arguments after the URL are JSON objects for terrain feature
switches, a camera pose, and terrain generation overrides, respectively. For
example, to compare erosion at the mountain reference site:

```sh
node tools/perf/terrainRework/views.mjs /tmp/terrain-erosion-off http://127.0.0.1:8000 \
  '{}' '{"position":[-94858.1,52664.2,77207.7],"target":[-94856.4,52657.4,77208.5]}' \
  '{"erosionFilter":{"strength":0}}'
```

Overrides are applied to the world configuration before initialization, so
the terrain and separate water processes start with the same settings. Each
run fixes the sun, hides the HUD, captures the supplied reference pose, samples
the natural terrain at that direction, and captures views from 8 m above that
surface through 46 km above it. The altitude poses share a location and viewing direction, not an identical
composition. Micro displacement and water can differ from the sampled natural
height. The tool also probes the visible height layer, but the probe can use a
coarser tile than the ground view, so check the ground image for camera clipping.

The report records the effective terrain configuration, tile-settling status,
and water planning status. Tile settling does not imply lake or river planning
has finished; check the recorded water status before evaluating water. A run
with an unsettled terrain view, a requested feature switch that did not apply,
or an uncaught page error exits unsuccessfully. These are visual review tools,
not image-quality or performance tests.

To test a local replacement for `mtnRange_d` without editing the runtime shader,
set `TERRAIN_REWORK_RANGE_SOURCE` to a WGSL file containing the replacement
function (and any helpers). The tool applies it before startup and copies the
exact source into the output directory. This is an experimental facility, not
a supported runtime option. The report contains the source hash and the
effective feature switches. The unfinished `range-directional.wgsl` candidate
can be reviewed as follows:

```sh
TERRAIN_REWORK_RANGE_SOURCE=tools/perf/terrainRework/range-directional.wgsl \
  node tools/perf/terrainRework/views.mjs /tmp/range-preview http://127.0.0.1:8000 \
  '{}' '{"position":[46179.1189,-24430.3862,-134034.4821],"target":[32912.0007,-32417.0834,-123729.3259]}'
```

Run the same command with `TERRAIN_REWORK_SELECTION=` in place of
`TERRAIN_REWORK_RANGE_SOURCE` for the original range. To isolate the range shape, use the feature and terrain overrides in
`FINDINGS.md`; compare it both in isolation and in the complete stack. Startup
overrides also change the terrain seen by hydrology, so they should not be
mixed with cached results from a different terrain configuration.

For an interactive preview of the second iteration, start the local preview
server from the repository root:

```sh
python3 tools/perf/terrainRework/preview_server.py tools/perf/terrainRework/range-iteration-2.wgsl
```

Open the URL printed by the server. It starts the free camera at the first
range after initialization; the normal controls are available after a few
seconds. At these sites the preview holds the sun above the terrain for
visibility. Change `terrainPreviewSite=1` to `terrainPreviewSite=2` for the second
range, or remove it to start at the normal location. The preview is served on a
separate local port with the replacement fixed at startup, so the terrain and
water processes receive the same function. This is still an experimental
preview, and does not change the game's regular server or default shader.

For foothill experiments, `TERRAIN_REWORK_FOOTHILLS_SOURCE` can point to a
WGSL snippet replacing the existing local hill calculation in both base
generators. The snippet receives `unitDir`, `seed`, `footBand`, and `amp` and
must assign `foothillsH`. The report records its hash and the output directory
contains a copy. It is injected before startup, including for water planning.
Optionally set `TERRAIN_REWORK_FOOTHILLS_BAND` to a JSON pair such as
`[0.36,0.50]` to compare a different regional coverage mask; the report records
the pair.

`foothills-multiscale.wgsl` is an unfinished trial; use it with that band and
the altitude tool to reproduce the current experiments. In full-stack tests
it materially changed water placement, so it is not a runtime option.
`foothills-regional.wgsl` is the review source for the now-selectable regional
model. It keeps the existing foothills and adds locally varied relief rather
than lifting whole regions. To inspect that review source interactively with
the range trial:

```sh
python3 tools/perf/terrainRework/preview_server.py \
  tools/perf/terrainRework/range-iteration-2.wgsl \
  --foothills tools/perf/terrainRework/foothills-regional.wgsl --band 0.36 0.50
```

Use `terrainPreviewSite=3` in the printed URL for the green upland comparison.

The exploratory mountain-valley trial can be reviewed separately from the
runtime range model:

```sh
python3 tools/perf/terrainRework/preview_server.py \
  tools/perf/terrainRework/range-valley-trial.wgsl --port 8774
```

Use `terrainPreviewSite=4&terrainRework=foothills` for the overlap site. The
server substitutes the trial into the legacy range slot, so do not add
`mountainRangeModel=directional` to this preview URL. The trial remains work in
progress; see `FINDINGS.md` for its limitations and measurements.

For a fixed comparison of any subset of the developed
changes, start:

```sh
python3 tools/perf/terrainRework/preview_server.py --compare --port 8775
```

Open the printed URL for the unified stack at the fjord in site 24. To bring up
the checkboxes, add `&terrainRework=mountains,foothills,valleys,rolling,coast,coves`.
The checkboxes update the shareable `terrainRework`
parameter and reload at exactly the same position and orientation. Values are
`mountains` (directional range), `foothills` (regional model), `valleys`
(the range modifier), `rolling` (regional rolling hills),
`coast` (coastal hills), `coves` (shoreline variation), `canyon`
(an unfinished canyon experiment), and `dunes` (an unfinished sand-sea experiment);
omit any to use its earlier behavior. An empty
`terrainRework=` selects none. The original range and foothill models remain
active when their new versions are not selected. The valley trial modifies
whichever range model is selected, so it can be compared independently of the
new mountain model. All settings are applied before lake and river planning.
Select site 7 for a view of the mountain valley, site 9 for
the rolling-hills review, site 10 for the valley, or site 4 for
an elevated view or 6 for a closer view of the valley floor. Site 6 may be
inside terrain with some feature combinations. At site 7, the natural terrain
height at the camera was sampled for all eight combinations; it is roughly
50–100 m below the camera at the tested point, before local render displacement.

`node tools/perf/terrainRework/checkPreview.mjs` smoke-tests all 256
combinations and compares the lake and river-planning samplers at that point.
These checks do not establish water correctness across the planet.
Pass `--canyon-smoke` after the server URL for six selections: baseline,
canyon alone, the other six trials, those six with canyon, dunes alone, and
all eight together.

To regenerate the matched valley comparison views, start the `--compare` server
and run:

```sh
node tools/perf/terrainRework/captureComparison.mjs /tmp/valley-review \
  tools/perf/terrainRework/valley-review-poses.json http://127.0.0.1:8775
```

The capture waits for terrain and water planning to settle, fixes the same sun
and camera for each pair, and selects only the valley trial. The root images
`valley-comparison-before/after.png` use the `closer` pose; the pair named
`valley-close-before/after.png` uses the `shallow` pose. On the interactive
preview, `terrainPreviewSite=8` uses the latter camera.


The valley varies its centerline, width, cross-section and depth along the
mountain range. To compare rolling hills at matching camera positions, run:

```sh
node tools/perf/terrainRework/captureComparison.mjs /tmp/rolling-review \
  tools/perf/terrainRework/rolling-review-poses.json http://127.0.0.1:8775 \
  mountains,foothills,valleys rolling
```

For an altitude sweep against the comparison server, set
`TERRAIN_REWORK_SELECTION=mountains,foothills,valleys,rolling` before running
`views.mjs`. A standalone WGSL replacement for rolling hills may be passed as
`TERRAIN_REWORK_ROLLING_SOURCE` when testing against the regular server.
The sampler agreement check is local; it is not a comprehensive water test.

A further valley-wall experiment is kept separate for comparison with the
previous valley trial:

```sh
python3 tools/perf/terrainRework/preview_server.py --compare \
  --compare-variant tools/perf/terrainRework/range-valley-wall-trial.wgsl --port 8788
```

Use `terrainPreviewSite=11` for a view across the wall, site 12 to look along
the valley, or site 10 for the earlier camera. The usual `terrainRework`
checkboxes remain independent. `valley-wall-review-poses.json` contains the
four camera views supplied in the review. This is an experiment, not the
runtime default or a replacement for the prior comparison trial.

The two coastal features are separately selectable and operate on terrain
before lake and river planning. `coast` adds hill relief within the regional
coastal band, while `coves` varies that band's continental edge. Coves are
approximate where the regional field and the actual waterline diverge.

For the coast review, start the valley-wall variant as above and open
`terrainPreviewSite=14&lakeCells=1&terrainRework=mountains,foothills,valleys,rolling,coast,coves`.
Use the checkboxes to compare the same view. Site 13 is a higher view of the
same coast, and `coastal-review-poses.json` includes both and an orbital view.
`node tools/perf/terrainRework/checkCoastWater.mjs http://127.0.0.1:8788`
compares the lake-table and river-planning heights at 25 points on this coast
with each of the two features alone and together. This is a local check, not a
guarantee for every coastline.

### Canyon country (rejected)

A regional canyon-country replacement was tried and rejected on review (it
looked broken at ground level away from its chosen cameras); see
`FINDINGS.md`. `canyon-trial.wgsl` is again the earlier stamped canyon. The
rejected source is kept as `canyon-country-rejected.wgsl`; the server still
accepts it through `--canyon-variant` for reference.

### Sand seas (dunes)

`dunes` selects `dunes-trial.wgsl` (`duneField_d`): sparse ergs in the
subtropical latitude band, inland, each with one dune type (crescentic or
barchanoid ridges, linear seif ridges, or star dunes) plus smaller crescentic
dunes at an angle, patches of large dunes and interdune flats. Dunes are added
after erosion, and sand calms only the fine meso band beneath.

Not ready: in review the sites fell on hilly ground, where the dunes read as
ripples on green hills. Scaling the rolling or erosion bands to flatten the
ground sank whole regions (those bands carry mean offsets), and gating to the
flat plains left almost no sites in the dry latitudes. A sand-fill model
(raise the ground to a fill level, hills stand out) and placement from a
shared province/climate assignment are needed first.

### Review tools added for these features

- `shoot.mjs spec.json outDir`: one page load per run; any `terrainRework`
  selection, terrain overrides, camera poses (absolute, or relative to the
  sampled ground: `{dir, alt, look}`), hillshaded height maps with slope
  statistics (`maps`, optionally `dump: true`), and a whole-planet
  equirectangular height sample (`globe`).
- `globeDiff.mjs off.i16 on.i16 out.png`: difference of two globe samples,
  the changed share of land and the strongest sites (directions) of a feature.
- `valleyViews.mjs map.json`: finds valley or canyon floors in a dumped map
  and prints poses looking along them (low and elevated), for `shoot.mjs` or
  `captureComparison.mjs`.

## Landform roadmap

### Completed caldera landform (2026-11-20)

Caldera volcanoes are part of both production base generators. The demo world
enables them in `wizard_game/world/terrain.json`; the reusable configuration
defaults to disabled. `?calderas=0` and `?calderas=1` select the startup state
on the regular game server. Use `calderas=0` when reproducing historical
comparisons from before this feature.

On the comparison server, open
`/wizard_game/standalone.html?lakeCells=1&terrainPreviewSite=16&terrainRework=&calderas=1`.
Site 16 is an aerial view of an isolated caldera, 18 looks into its bowl, and
17 shows a snowy example. The **Caldera volcanoes** checkbox preserves the
camera on reload. It is independent of the eight `terrainRework` switches.

The landform has a broad volcanic apron, asymmetric rim, rounded bowl,
shallow radial drainage and occasional low rim saddles. It fills up to its
surface with a smooth maximum. Each terrain band participates in that blend,
so lake planning can omit finer bands without exposing inverse detail in the
macro band. Existing material and climate rules still colour the volcano;
there is no new volcanic biome or guaranteed crater lake.

Authoring options under `calderas`:

| Setting | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Startup selection; enabled in the demo world |
| `cellSizeM` | `60000` | Placement cell size |
| `densityPerKm2` | `0.00018` | Candidate density before land/footprint rejection |
| `minRadiusM`, `maxRadiusM` | `8000`, `10500` | Nominal apron radii |
| `minHeightM`, `maxHeightM` | `1200`, `1600` | Nominal relief above the regional foundation |
| `craterDepth` | `0.72` | Bowl depth as a fraction of nominal relief |

The configuration rejects height/radius ratios above 0.2 and cells too small
to contain the footprint. These checks do not bound the combined terrain's
slope; see the measured limits in `FINDINGS.md`.

Reproduce the matched views (same camera and sun with calderas off/on):

```sh
TERRAIN_REWORK_SUN_ELEVATION=0.4 node tools/perf/terrainRework/captureComparison.mjs \
  /tmp/caldera-review tools/perf/terrainRework/caldera-review-poses.json \
  http://127.0.0.1:8775 '' calderas
node tools/perf/terrainRework/checkCalderas.mjs http://127.0.0.1:8775 /tmp/caldera-water.json
```

`caldera-isolate-spec.json` disables competing relief and erosion for
`shoot.mjs`. `caldera-ground-spec.json` uses deterministic unselected ground
views, spawn and a snowy aerial view with the six earlier trials active.

`landformLab.mjs` is an optional native-WebGPU diagnostic. Its third argument
is the path to an installed `webgpu` package's `index.js`; it adds no game
dependency. `caldera-lab-spec.json` samples the 19 surveyed sites and spawn,
`caldera-gradient-spec.json` checks the isolated shape's derivatives, and
`caldera-bench-compare.json` alternates both startup choices on the same GPU
over warmed production tile output (the individual off/on specs are also
kept). Run the benchmark with other GPU workloads stopped. `compareLandformMaps.mjs`
compares matching baseline and modified map directories; the lab samples
natural land before lakes, river carving and render micro detail.

### Disabled mesa and cuesta trials

The two trials are disabled by default. Enable
them with `"inlandLandforms": { "mesas": true, "cuestas": true }` in world terrain
JSON, or use `mesas=1` and `cuestas=1` on the game URL. Review found the cuesta
groups too rounded and the mesa silhouettes too soft. Revisit the shapes if
the renderer gains a way to place cliff faces or overhangs as local meshes.

- **Mesas and buttes.** A flat-topped massif and detached remnants, with
  rounded rims and broad talus ramps. Comparison sites 19 and 20 show the
  same group from the air and from a lower approach.
- **Cuesta ridges.** Staggered ridges with a long dip slope on one side and a
  shorter escarpment on the other. Sites 21 and 22 show the group from the
  air and across the slopes.

Start `preview_server.py --compare --port 8775`. Include
`terrainRework=&terrainPreviewSite=19&mesas=1` or
`terrainRework=&terrainPreviewSite=21&cuestas=1` in the URL. The comparison
checkboxes keep the same camera when they reload. To review both with the
previous trials, use
`terrainRework=mountains,foothills,valleys,rolling,coast,coves&mesas=1&cuestas=1`.
The camera poses are stored in `inland-review-poses.json`. The `review/`
directory contains the aerial and lower views for both landforms.

### Fjords and fells

- **Fjords** follow the coastal gradient, from a sampled sea entrance toward
  higher land. A curved trough drops below the configured sea level and broad
  slopes blend its sides back into the coast. Sites 23 and 24 show two inlets.
- **Fells** are connected rounded uplands with uneven summits, broad saddles,
  and shorter spurs. Their relief blends with neighbouring hills, while higher
  peaks retain their shape. Sites 25 and 26 show the same group at two altitudes.

Both are enabled in the demo world. Use `fjords=0` or `fells=0` on the URL
for a matched comparison. The fixed camera
poses are in `fjord-fell-review-poses.json`. The fjords use the existing sea
surface and the same terrain bands for rendering and water planning. The
fells receive the current climate and surface materials. Screenshots are
in `review/`.

### Initial combined pass

The first unified stack runs on the current continents, drainage and ocean.
It includes directional ranges, regional foothills, mountain valleys, rolling
hills, coastal hills and coves, calderas, fjords and fells. Canyon, dunes, mesas
and cuestas remain opt-in trials. Biome work can later assign deserts, glacial
landforms and surface materials by region.

### Tectonic belts and interior relief

The demo world uses 18 seeded spherical plates. Relative motion across their
shared edges selects convergent mountain belts. The belts vary along their
length, with foothills, higher massifs and lower passes. Between belts, broad
valleys, dissected uplands, rounded hills and smaller knolls vary the relief.
The added relief fades toward the shore. Terrain tiles, lake generation and
river planning evaluate the same shapes.

Use `tectonicRelief=0` to review the previous unified stack at the same
camera. The comparison server has fixed views at sites 27–29. Site 27 shows
the western mountain belt, site 28 shows an eastern upland and site 29 shows
the western lowlands. The camera poses are in `tectonic-review-poses.json`.
The `tectonicRelief` object in the world terrain JSON controls the plate
count and the height of the mountain and interior relief.

On a 720 × 360 global height sample, roughly two-thirds of the previously
flattest inland areas crossed 100 m of local relief over a 10 km span. The
same sample moved the land fraction by about 0.02 percentage points.
Chrome's lake and river-planning samplers agreed at 11 sites across inland
terrain and the north coast. A paired 24-tile WebGPU run measured 17.5 ms
per warmed tile with the layer disabled and 19.4 ms with it enabled.

### Remaining catalogue

One landform at a time, each reviewed alone and in the stack, with a preview
site and before/after images. Proposed order and catalogue:

1. Review the unified stack in ordinary travel. Canyon country is parked and
   sand seas still need work.
2. Arid: badlands (dense rill networks, banded slopes, hoodoos at the grid
   limit), mesa-and-butte escarpment lands at plains edges, salt flats and
   playas, alluvial fans and bajadas at mountain fronts, inselbergs.
3. Tectonic: rift valleys (graben between fault-block escarpments, chained
   lakes), cuestas and hogbacks (tilted strata), fold belts (parallel ridges).
4. Volcanic: stratovolcanoes, calderas with lakes, shield volcanoes and lava
   plateaus, cinder cone fields.
5. Glacial: inland U-shaped troughs, cirques and aretes in high ranges,
   drumlin and kettle-lake plains (fit the lake cells).
6. Coastal: sea cliffs and wave-cut platforms, beaches and barrier islands,
   rias, archipelagos and skerries, tropical atolls.
7. Karst: tower karst and sinkhole fields.

Planet structure needs its own pass before the landforms are spread
everywhere: the continent field is a single thresholded noise (one large
continent with inland seas), and each trial has its own placement field.
Proposed: a small set of plates (spherical Voronoi with motion vectors),
continental or oceanic, with boundaries classified as convergent (ranges,
trenches, volcanic arcs), divergent (rifts, mid-ocean ridges) or transform.
Provinces are then assigned from plate context and climate (latitude belts,
rain shadows behind ranges) and each landform takes a province weight instead
of its own mask: ranges and foothills at convergent margins, canyon country on
uplifted interiors, sand seas in subtropical interiors and rain shadows, fjords
on high-latitude mountainous coasts, rifts along divergent continental
boundaries. The same province weights should drive the biome and material
classification so geometry and colour agree.
