# Grass

2026-11-26, branch `grass/biome-grass` from main 70b83fe. M1 Pro, Chrome WebGPU, 2400×1350. Pictures: `screenshots/grass_2026-11-26/`.

**Profiled 2026-11-27:** grass costs 6–8 ms at high, 4–6 ms at medium (section Profiling).

## Fourth round (2026-11-27): toward the references

After the user's Skyrim and GrassWorks references and Codex's review (`GRASS_REVIEW_FOR_CLAUDE.md`).

**Colour and light:**
- Muted, cooler greens. The hue is shared with the ground, so far fields lost their lime too.
- Light through the blades and the highlight are restrained.

**Body and shapes:**
- Most blades form a low, darker body; fewer stand up out of it.
- Fallen straw lies lower and is darker.
- Low broadleaf rosettes grow among the grass.
- Rare rusty dock spikes in patches (a plant or two per m² where they grow), and more purple spikes.
- Flowers sit among the grass, not on stalks above it.
- Seed heads are slim and tan.

**Far off:**
- Flower and seed stems are never widened (they stood as dark sticks), and their heads at most twice (wider, they stood as strokes).
- Flowers end by ~72 m and seed heads by ~38 m, before they turn to confetti.
- **The grain.** The far field wears a grain made at load from the blades' own rules: tufts, gaps, straw, clumps; 256², mean 1, at two scales (4 m and 21 m). It is warped by the ground's mosaic, so its repeats never stand in rows (they did, on a far hill, before the warp). Far blades take their colour from the same grain where they stand.

Pictures `17`–`22`.

## Profiling (2026-11-27, after the fourth visual round)

M1 Pro, Chrome WebGPU (Metal), `shader-f16`. Whole GPU frame from GPU timestamps, median of 96 frames per arm. Each frame follows a steady load, because the GPU lowers its clock between short frames. Arms are interleaved in one session; clouds are on but frozen. The GPU was otherwise idle (`ioreg` utilisation 0–9 %); no leftover agent processes were on it. Scripts: `tools/perf/grass/grassBench.mjs` (views and arms), `tools/perf/grass/scatterParts.mjs` (shader variants with parts left out). Raw results: `tools/perf/grass/results-2026-11-27*/`.

Arms:
- `none`: the terrain shader without any grass terms, as before grass.
- `ground`: the ground's grass look (hue, canopy past the blades, grain).
- `scatter`: that, plus the blades made but not drawn.
- `full`: the game.

### Where it stands (after the scatter changes below), ms

| View | High: none | + ground | + scatter | full | grass in all | Medium: none | full | grass in all |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Meadow, root height | 6.45 | 6.81 | 10.96 | 14.74 | **8.3** | 3.41 | 9.48 | **6.1** |
| Meadow, standing | 6.71 | 7.08 | 11.28 | 15.03 | **8.3** | 3.46 | 9.58 | **6.1** |
| Meadow, toward the sun | 7.15 | 7.55 | 11.65 | 14.70 | 7.6 | 3.78 | 9.30 | 5.5 |
| Meadow from 8 m | 6.63 | 7.09 | 10.89 | 13.57 | 6.9 | 3.41 | 8.35 | 4.9 |
| Meadow from 15 m | 6.65 | 7.26 | 10.54 | 12.63 | 6.0 | 3.45 | 7.64 | 4.2 |
| Meadow, walking 3 m/s | 7.08 | 7.44 | 11.63 | 15.34 | 8.3 | 3.70 | 9.84 | 6.1 |
| Forest floor | 7.71 | 8.18 | 12.01 | 14.37 | 6.7 | 4.06 | 9.16 | 5.1 |
| Tundra | 7.86 | 8.05 | 11.44 | 14.37 | 6.5 | 4.07 | 9.12 | 5.1 |
| Marsh | 8.33 | 8.89 | 13.12 | 14.67 | 6.3 | 4.49 | 9.59 | 5.1 |
| Dry grass | 7.79 | 8.21 | 11.61 | 13.86 | 6.1 | 3.98 | 8.35 | 4.4 |

- **Spread.** p90 lies 0.15–0.4 ms over the median throughout.
- **Grain.** The grain alone is 0.05–0.35 ms (`full` against `full-nograin`).
- **Over budget.** Grass costs 6–8 ms at high and 4–6 ms at medium. That is 3–4 times the 2 ms budget.
- **Parts at high:**
  - the ground's look: 0.2–0.6 ms;
  - the scatter compute: 3.3–4.3 ms, almost the same at medium, as it does not depend on resolution;
  - drawing: 1.5–3.9 ms, a third less at medium.
- **No overflow.** No buffer ran full: blades used at most 37 % of a band, and patches 5,008 of 65,536.
- **Memory.** About 32 MB: 29.4 MB blade records, 2.1 MB patch list, 0.7 MB grain. Making the grain takes ~70 ms at load.

### What the scatter's time was, and what was done

Before, the scatter took 6.5 ms. Meadow standing, blade step of the scatter:

| Variant | ms |
| --- | ---: |
| The game | 6.46 |
| Rank test only, per lattice point | 0.03 |
| No value noise | 4.87 |
| Finest heights instead of drawn triangles | 5.09 |
| Fixed growth | 5.62 |
| No atomic counters (writes scattered) | 6.48 |
| No clumps | 6.42 |
| Patch step | 0.07 |

- **What it was.** Neither memory traffic nor atomics: the per-tuft arithmetic, in a kernel of 4,815 instructions using 124 registers (the Metal compiler's own statistics).
- **Why it ran badly.** Far patches held a few tufts each, so most of each 64-thread workgroup sat idle.
- **The first test was loose.** It assumed the worst case, so in a meadow ~7× more lattice points than became tufts went through the expensive part.

Changes:
- **The ground rules and slow noises** are worked out once per patch, at its 4 corners in workgroup memory. Tufts interpolate them, against a conservative per-patch bound.
- **The exact drawn height** is computed only for kept tufts.
- **Far patches are grouped.** One workgroup takes a 2×2 block from 41 m and a 4×4 block from 91 m, aligned on the cube face. The lattice points are the same, so nothing pops when a block changes size.
- **Result:**
  - workgroups 15.7k → 1.9k;
  - scatter 6.5 → 4.2 ms;
  - whole frame at standing height 17.5 → 15.0 ms.

### Tried, did not pay

| Change | Frame, ms | Why it does not pay |
| --- | --- | --- |
| Far blades as single triangles (3 vertices, not 5) | 17.66 against 17.52 | Far vertex count is not the limit. |
| Far blades shaded by the canopy formula alone | 17.57 | Within noise. |
| Far and mid bands lit per vertex, flat fragment | **+1.3** | The vertex stage is already costly. |
| Flat shading everywhere (to price the fragment) | −1.7 | The blade fragment is half the draw. |
| One blade per tuft (to price the blade loop) | scatter 4.1 → 3.3 | The per-tuft body, not the blades, is the rest. |
| Range 160 / 120 m | −0.9 / −1.2 | — |
| Density × 0.6 | −2.4 | Fewer blades everywhere: a visible change. |

### The way to the budget

The remaining scatter (~3.3 ms of per-tuft work plus ~0.9 ms of blade loop) is redone every frame for tufts that rarely change.
- **Make tufts once per patch, keep them.** Remake a patch only when it enters the range, when its detail level steps (the nested lattice ranks make that a superset or a subset), or when the terrain under it changes its mesh. Each frame, only cull patches and draw.
- **Animate in the vertex shader.** Wind and the fade by distance move there; they are cheap there.
- **Estimate.** This should take the scatter from ~4 ms to well under 0.5 ms, standing or walking, with no visible change. It needs a GPU patch pool and its invalidation; it is the largest single item.
- **After that, the draw (1.5–3.9 ms).** Halve the fragment by reusing the shading of a blade's lower and upper half, and judge with you whether the far ring (120–240 m: ~0.5 ms with its scatter) earns its cost against the canopy alone.

## Third round (2026-11-27): the shaking was the wind turning, and a third further

**Shaking while standing still** ("most of the time violent, now and then a gentle sway"):
- **Cause.** The gusts' pattern and the sway's phase were taken as the wind's direction times the place on the cube face, which is up to ~150 km from the face's corner. The weather turns the wind at up to 0.1 rad/s and picks a new way every few seconds. At that distance even a slow turn swept the gust pattern past each blade at ~15 km/s, and moved the sway phase thousands of radians a second. Only when the wind had finished turning did the gentle sway show. A changing wind speed did the same through `speed × time`. The test rig had held the wind fixed, so it never showed.
- **Fix.** The gust field is fixed to the ground and carried by the wind's travel, summed frame by frame (`GrassPass._carried`). A turn changes only where it drifts next. Each sway is a whole number of turns in an hour, so time wraps there with no jump and its phase stays exact however long the game runs (`wave()`).
- **Measured.** Your pose at 45 cm above the ground, with the game's own wind turning to a new way about every second. Change per frame over the lower 70 % of the picture, in grey levels:
  - previous commit: 32–35;
  - now: 11–13, as much as a steady wind of that speed (8.9 at 6 m/s, 12.4 at 15 m/s).

**A third further.**
- Range 180 → 240 m.
- Detail bands 7 / 18 → 9.5 / 24 m.
- Flowers and seed heads to 35–50 m.
- Full density to ~21 m instead of 16 m: `thinPixels` 0.6.
- The patch grid is now 512 wide, so the range also holds near cube-face corners, where patches shrink to ~1.2 m.
- At your view: 27k / 59k / 141k blades, ~1.6 M vertices, 16k patches.

Pictures `15` (your view, grass to 240 m) and `16` (grass-root height).

## Second round (2026-11-27): flicker, blades in the ground, and range

Three problems reported from the game, each fixed at its cause:

| Report | Cause | Fix |
| --- | --- | --- |
| Grass partly under the ground | The terrain draws coarse meshes even next to the camera on high ground (`lodHeightSource: 'sea'`). At the reported lake bank (1616 m) the tile under the camera drew 4 m triangles, and on the slope (654 m) 2 m ones. Blades stood on the finest loaded heights, so they sat up to decimetres under or over the drawn surface. | Blades stand on the drawn triangles. Each patch finds the tile drawn over it this frame (the quadtree's visible table), its mesh level and the layer its geometry comes from (own or an ancestor's part). It rebuilds that mesh's adaptive cells and fan (`terrainGeometryBuilder.js` transition topology) and interpolates the triangle that holds each tuft. |
| Violent flicker close by | The sway's phase ran with the gusts' travel: at 22 m/s blades whipped at about 3 Hz, plus a fast flutter. | Sway at the tuft's own pace (0.5–0.8 Hz), smaller and less far off; gusts in broader waves; flutter only within 6–25 m. With time frozen the picture does not change at all, so motion comes only from wind. |
| Grass ends too close, and its edge shows | 46 m range. | 180 m. Past where a blade is under 0.8 px (about 16 m here), density falls as 1/d² while blades widen as d, so each pixel holds the same share of grass. The lattice ranks its points in nested sets, so a far patch visits only the coarse set it needs (down to every 16th row and column) and the kept set still changes one tuft at a time. |

Frame-to-frame change of a still view in wind, lower 70 % of the picture, grey levels:

| Wind | Before | After |
| --- | ---: | ---: |
| 0 m/s | 5.8 | 4.2 |
| 6 m/s | 12.0 | 6.9 |
| 15 m/s | 19.3 | 8.7 |
| 22 m/s | 22.5 | 8.0 |

**The edge at 180 m.** Far blades take the colour the ground past them has, and the ground's own light formula (`GROUND_LIGHT_WGSL`, now shared by both), keeping a third of their own differences. This happens from a sixth to half the range, and also from above, where the ground between blades shows. The ground between blades stops being shaded from 18 m to 54 m, and from above. Blades against the canopy without them, meadow, linear: 80–120 m +1 %, 120–150 m +2 %, with about +2 % exposure offset even where no blades stand; before this, the far blades measured 6–10 % darker than the ground beyond them.

**Counts.** The meadow with flowers at eye level, now to 180 m, draws 47k / 64k / 135k blades (near / mid / far band), about 1.9 M vertices, in 8,600 patches: about what the 46 m version drew. From 15 m up, 141k blades, all in the far band.

**Motion flicker is not measured.** A camera stepped 1 cm a frame gives the terrain alone a second-to-first difference ratio of 1.6: its vertices are placed in 32-bit planet coordinates and jitter by about a centimetre. That hides what the grass adds (1.74 with grass).

## What it is

Grass blades within 240 m of the camera, made on the GPU every frame from the ground the terrain draws. Past them, the ground itself takes the grass canopy's look. Both are tuned so that they meet without a visible line. There is nothing to stream or store: blades are a function of the world position and the tile data already resident.

- `core/renderer/grass/grassWgsl.js`: the scatter (compute) and the blades (vertex and fragment).
- `core/renderer/grass/GrassPass.js`: the driver, owned by `QuadtreeTerrainRenderer` and drawn right after the terrain pass.
- `core/renderer/grass/grassHue.wgsl.js`: the grass hue by climate, shared by blades and ground.
- `terrainPass.wgsl.js` adds:
  - the climate hue on grass ground;
  - shade under the blades;
  - the canopy past the blades.

## Sources and what was taken from each

| Source | Taken |
| --- | --- |
| Ghost of Tsushima, Wohllaib GDC 2021 | Voronoi clumps set height, facing and colour; several blades per instance; blades turned to the camera when seen edge-on; rounded normals; one scrolling-noise wind field shared everywhere |
| AMD GPUOpen mesh-shader grass, 2024 | Bézier blades with length kept, L = (2·L0 + L1)/3; fewer and wider blades far off; grow-in instead of pop |
| Pesce, Black Ops 4 grass, 2024 | Translucency is what makes grass; a height ramp is its occlusion; thin highlights from a V-shaped normal; velvet-like far shading; every fake fades near and far |
| Remote sensing canopy models (Beer–Lambert gap fraction, Ross–Li hotspot) | The ground's canopy past the blades: coverage at a slant, light through, hotspot |
| Weier et al., SIGGRAPH 2023, neural prefiltering for LOD | The plan for the learned part (below) |

## How many: the numbers

A sight line from eye height e reaches the ground at distance d. It runs through a canopy of height H over about H·d/e of horizontal distance. The ground stays hidden (optical depth ~2.5) when blades/m² × blade width ≳ 38/d per metre, for H = 35 cm. This gives:

| Distance | Blades/m² needed | Set (`density` 1500, `thinFrom` 2, `thinPower` 1) |
| ---: | ---: | ---: |
| 2 m | ~1460 | 1500 |
| 10 m | ~290 | 300 |
| 20 m | ~150 | 150 |
| 46 m | 40–75 (blades widened to ≥0.7 px) | 65 (round 1); now about 18: past ~16 m it falls as 1/d², widened blades |

- **Height and clumping.** Density scales with 0.35/H, capped to 0.5–1.6, because tall grass hides the ground sooner. Bunchgrass and thin grass gather into clumps with gaps between them.
- **Counts read back per view (blades, near/mid/far band):**

  | View | Blades | Vertices | Notes |
  | --- | --- | ---: | --- |
  | Meadow with flowers | 46k / 70k / 136k | ~2.0 M | 15 / 9 / 5 vertices per blade |
  | Forest floor | 18k / 33k / 96k | ~1.05 M | |
  | Tundra | 22k / 43k / 105k | ~1.2 M | |
  | Marsh | 13k / 18k / 60k | ~0.6 M | |
  | Dry grass | 14k / 33k / 95k | ~1.0 M | |

- **First thing to measure.** The meadow at 2 M vertices is the worst case. Whether it fits 2 ms is unknown until profiled.

## The near field: tufts

- **A world-fixed lattice per cube face.** Patches are 2 m (64 per 128 m tile) with 48×48 lattice points each. A point is a tuft: 1–12 blades, plus sometimes a seed stem or a flower.
  - Per tuft, the compute reads the same rules the terrain draws: climate, slope, the wide fields and the mosaic, `biomeCover`, dryness, bare and gravel patches, river and lake beds. So blades stand exactly where the ground is grass, golden where it is dry grass, and nowhere on rock, sand, snow, ice or beds.
- **Positions about the camera.** Planet coordinates are 131 km long and step by 1.5 cm in floats, which is wider than a blade. Each face has an anchor whose cube point is exact in floats, and the difference of two sphere directions is computed without subtracting large numbers. A test replays this in 32 bits against 64: under 0.1 mm at 60 m near a face corner (`grassWgsl.test.js`).
- **Kinds:**

  | Kind | Tuft | Notes |
  | --- | --- | --- |
  | Meadow | ~4.5 blades | |
  | Dry bunchgrass | ~12 blades, arching | |
  | Woodland | ~2.5 blades | |
  | Tundra sedge tussocks | ~8 blades | olive-gold to rust |
  | Marsh reeds | ~5 blades, 0.75–1.3 m | 28 % dead leaves |
  | Seed stems | | golden or red-brown heads |
  | Flowers | | round heads with a centre: buttercup, hawkweed, daisy, cornflower, poppy; lupine and pink spikes in wet ground |

- **Variety at three scales.**
  - Tens of metres: the climate hue (blue-green where cool, deep green where warm and wet, yellow-green where drying), shared with the ground.
  - Metres: zones within one meadow — taller and shorter stands, yellower and deeper greens, more or less straw.
  - ~0.6 m: clumps.
  - Flowers come in patches a few metres wide, one or two kinds per patch, where the fields are lively and moist.
- **Shape.**
  - A quadratic Bézier with its length kept.
  - Outer blades of a tuft arch out, inner ones stand.
  - Long blades droop.
  - Blades turn toward the camera when seen edge-on.
  - No blade is drawn under 0.7 px wide, but flower heads are exempt: widened, they stood as sticks.
- **Shading.**
  - Height ramp (the canopy's occlusion), light through from behind, glow toward the sun, a thin waxy highlight.
  - The sun reaches low parts less, more so with a low sun.
  - The hotspot: with the sun behind the viewer, shadows hide behind the blades that cast them.
  - The land's light map, so mountain shadows fall on grass.
  - Cloud shadows come from the composite: blades write depth.
- **Wind.**
  - Gusts are value noise travelling with the wind (11 m and 3.7 m scales), so waves roll across a field.
  - Each tuft sways; each blade flutters.
  - A lasting comb leans whole areas one way.
  - It follows `environmentState.windDirection/windSpeed`. Between frames, pixel change in the lower half of the frame is 20 levels calm and 32 at 12 m/s.

## Past the blades: the canopy, fitted to the blades

In the first round (46 m range) the blades sank into the ground over the last 40 % of their range. The ground beyond must look like what they were. Measured first, it did not:
- a 6–8 % brightness step;
- bare litter beyond sparse grass, which at a slant the blades had hidden.

Three terms were added to the terrain pass, on its grass share:
- **Coverage at a slant**, 1 − exp(−2·share/cos θ_view). The share it hides of the ground between tufts takes the blades' colour, keeping half the ground's detail.
- **Velvet light.** The canopy's normal leans halfway toward the viewer from the ground's own slope normal, as the blades' far normals do. A low sun behind the viewer lights a field more than bare ground.
- **Light through and hotspot**, the same terms as the far blades.
- These apply from where the blades start to sink, and fade out from 300 m to 1.5 km, where the far tiers' tuned colours take over.

The constants were fitted by measurement: blades (the teacher) against the ground drawn without them (the student). The linear ratio was taken at 30–44 m over 3 sun heights × 4 view turns × 2 eye heights (`grassRig.js teacher()`). Results:
- From 6 m up: 0.83–1.2.
- At eye level: 0.85–1.7 in the worst case, a low sun toward the camera. There the band on screen is mostly nearer blades standing up into it.

## The learned part, next

Per-blade networks would not pay: a blade's shading is a few terms, and on this GPU a per-pixel network loses to exact rules (terrain round: 363–706 against 240 instructions). Where learning pays is the aggregate.
- **Hand-fitted today.** A field of blades seen from 40 m to 2 km, with self-shadowing, hotspot, light through and grazing brightening, is what the analytic canopy above approximates with a few constants. It is the residual that remains at eye level.
- **The step.** The teacher is our own blades rendered over view, sun, density, height and kind. Fit a small network, then bake it to a lookup texture that the terrain reads per grass pixel. This is the clouds' recipe with near-zero runtime cost, and the hand-over matches by construction rather than by fit.
- **Weier et al. 2023** do this kind of correlation-aware aggregate learning for vegetation LOD offline.

## Optimizations built in

- **No `discard`, opaque blades.** Apple's hidden-surface removal stays on, so about one blade fragment is shaded per pixel. `discard` alone cost 1.9 ms in the terrain round.
- **Three distance bands** of 7, 4 and 2 segments per blade.
- **Density by coverage need (1/d)**, widening to a minimum pixel width, instead of a fixed density.
- **The ground rules read once per tuft**, not per blade: 6 texture reads and the cover rules shared by up to 12 blades.
- **Patch culling before any texture read:** level distance, then one tile lookup, one height, and a frustum ball per 2 m patch. The land light is read per patch.
- **Cheap rejection per lattice point** by rank before reading anything.
- **Flowers and seed heads stop at 26–38 m**, where they are under a pixel.
- **No grass work at all** when the camera is higher than the highest land plus the blade range.

Candidates once measured:
- Reuse the terrain draw list's horizon (occlusion) for patches behind hills.
- Orientation culling of thin edge-on blades (Jahrmann & Wimmer 2017).
- Cache tufts across frames while the camera stands still.
- Workgroup-level appends in place of one global atomic per tuft.
- Half floats in the blade fragment.
- 5 segments instead of 7 near.
- The blade range as a quality setting.

## Not done, not checked

- **Profiling.** None.
- **`groundSurface.wgsl.js`.** The older materials, drawn for debug views and without the terrain pass, did not get the climate hue or the canopy. Grass needs the terrain pass anyway.
- **Lake surfaces.** River and lake beds are left bare. A lake whose surface lies above ground that is not its bed was not checked; one lake visited sat on dry gravel.
- **Night, rain and snow.** Night uses the terrain's floor; there is no moonlight term, no wet look, and no snow cover on blades.
- **Interaction:** none yet — no trampling and no bending around the player.
- **Wind waves in the far canopy.** The blades have them; the ground past the blades (180 m) does not. The same gust field should modulate the canopy's light there.
- **Cube-face edges** were not checked. Flicker under camera motion is only judged by eye: the metric is dominated by the terrain's own vertex jitter (see the second round).
- **Tree shadows.** Blades write depth like any opaque surface, so shadows applied at composite time (as cloud shadows are) or a shadow term in the blade fragment shade grass as in the Skyrim reference.

## Switches

- `rendering.grass` (`enabled`, `distance` 240, `density` 1500, `thinFrom` 2, `bands` [9.5, 24], `minPixels` 0.8, `maxWiden` 16, `thinPixels` 0.6). Engine default off; the game turns it on.
- `B` in the game, or the "Grass blades" button: blades off, leaving the ground with the canopy alone.
- `GRASS_CANOPY` in `terrainPass.wgsl.js`: the canopy's depth, gain, glow and hotspot.
- `tools/perf/grass/grassRig.js` drives the camera and sun, and runs the hand-over measurement (`handover`, `teacher`).

## Pictures

`01` before (no blades); `02` first blades; `03` meadow with flowers, sun behind; `04` the same with blades off (canopy alone); `05` toward the sun; `06` close in tall grass; `07` forest floor; `08` marsh reeds; `09` dry grass under cloud; `10` tundra tussocks. Second round: `11` the reported lake bank, blades on the drawn ground; `12` the reported slope view; `13` meadow, grass to 180 m; `14` from 15 m up.
