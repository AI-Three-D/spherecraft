# Grass

2026-11-26, branch `grass/biome-grass` from main 70b83fe. M1 Pro, Chrome WebGPU, 2400×1350. Pictures: `screenshots/grass_2026-11-26/`.

**Where it stands (2026-11-27, after the seventh round):** grass costs 1.9–3.2 ms at high standing still and 3.5 ms walking; 1.4–2.0 ms at medium (2.3 walking). It was 6.7–9.0 ms at high. Budget 2 ms. Sections Seventh round and Tuft cache.

## Seventh round (2026-11-27): less work for the same picture

Written while the GPU was in other use (Codex): changes that do less work for the same picture, checked for correctness first. Timed afterwards against the sixth round (`3041d77`), the two versions run back to back.

| Change | Commit | What it saves | Checked |
| --- | --- | --- | --- |
| Blade record 48 → 32 bytes | `27b845d` | A third of the copy's and select's memory traffic. The store holds a third more blades (1,048,576 a half) in 64 MB instead of 75. | Drawn counts within 0.1 % of the 48-byte records; full remake equal to cached; pictures at root and from 8 m. |
| The select skips patches out of view | `27b845d` | Reading the second half of every record outside the view (most of the store: the patches kept for turning). | Same drawn counts with and without (`cullPatches = false`) at root, standing and 8 m. |
| Per-frame light out of the blade pixel shader | `fa2196d` | Sky light, day, bounce and the canopy's sun factor per pixel. Small powers become products; the highlight is skipped where it is faded out (past 44 m). | Algebraically the same; picture toward the sun. |
| Terrain: hotspot `pow(x, 6)` and glow `pow(x, 5)` as products; tussock grain on the 2× anisotropic sampler | `99b511d`, last | Transcendentals per grass pixel; two of four taps on a pattern 21 m across. | All 48 terrain shader variants validate. |
| The copy chooses the blades it carries | `82eaaf8` | The select read the whole store a second time each frame; now it reads only the blades just made. | Same drawn counts whether chosen in the copy (cached) or in the select (full remake), at three heights. |
| Constant divisors in the blade vertex shader | `82eaaf8` | An integer division by a run-time number on every vertex. | Shaders validate; pictures. |

**Results** (`grassBench.mjs`, `results-2026-11-27o-round6` against `-round7`). Grass = full frame minus the terrain without grass, ms:

| View | High, r6 | High, r7 | Medium, r6 | Medium, r7 |
| --- | ---: | ---: | ---: | ---: |
| Meadow, root height | 2.99 | 2.67 | 1.95 | 1.83 |
| Meadow, standing | 3.42 | 3.18 | 2.19 | 2.01 |
| Toward the sun | 2.54 | 2.36 | 1.74 | 1.60 |
| From 8 m | 3.05 | 2.89 | 1.75 | 1.63 |
| From 15 m | 2.98 | 2.77 | 1.60 | 1.44 |
| Walking 3 m/s | 3.75 | 3.46 | 2.49 | 2.32 |
| Forest floor | 2.69 | 2.58 | 1.74 | 1.63 |
| Tundra | 2.14 | 1.91 | 1.52 | 1.40 |
| Marsh | 2.35 | 2.29 | 1.50 | 1.37 |
| Dry grass | 2.54 | 2.42 | 1.59 | 1.45 |

- **Every view is faster:** 0.06–0.32 ms at high, 0.11–0.18 ms at medium.
- **Noise.** The seventh round's high views had more frame spikes than the sixth's (p90 up to 1.7 ms over the median, against 0.1–1.6). The medians hold; single views are good to about ±0.1 ms.

**Passes** (`scatterParts.mjs`, `results-2026-11-27p-*`), ms:

| | Standing, r6 | Standing, r7 | From 8 m, r6 | From 8 m, r7 |
| --- | ---: | ---: | ---: | ---: |
| Select | 0.28 | 0.01 | 0.24 | 0.01 |
| Copy (now also chooses the blades it carries) | 0.34 | 0.35 | 0.29 | 0.30 |
| Draw | 1.64 | 1.54 | 1.21 | 1.22 |
| Of it shading (against flat) | 0.89 | 0.89 | 0.45 | 0.48 |

- **Where the gain is:** the select pass is gone (0.25–0.28 ms). The copy costs the same while doing the select's work as well, because the records are a third smaller.
- **No measurable gain:** the per-frame light in the blade shader, the powers as products, the tussock grain sampler and the constant divisors. Their savings were too small to show; they stay, as they cost nothing.

**Offsets as half floats.** Each patch's corner now sits at the drawn height of the block's middle, not at sea level. Offsets from it stay within metres, about 2 mm precise in a 2 m patch and 8 mm in an 8 m far block.

**Facing and height in a byte each:** 1.4° and 8 mm steps.

**Not done, and why:**
- **Portraits on the 2× anisotropic sampler** (four taps fewer at grazing angles). This softens the far field's texture one mip sooner, so it needs pictures side by side first.
- **Rows by on-screen length instead of distance.** Short near blades would get fewer rows. At most about 0.1 ms, against a risk to near blades' curves.
- **Making only the missing tufts of a patch that comes nearer.** Walking costs 0.15–0.23 ms over standing. This would save most of that, at the cost of patch-wide tuft sets (+20–40 % of the store).
- **A store that keeps blades in place** (no copy each frame). It needs patch identities that persist across frames: a persistent table with deletion.
- **Per-vertex light for the far bands** (`perVertexFar`) was worse with one blade an instance. Worth timing again now that vertices are cheap.

## Tuft cache and a leaner draw (2026-11-27)

Profiling after the fifth round showed two costs:
- making the blades (3.4–4.5 ms), redone every frame for tufts that rarely change;
- drawing them (1.5–3.8 ms).

This round keeps the tufts and fixes how they are drawn.

**What was built** (`grassWgsl.js`, `GrassPass.js`):
- **A store of blades kept from frame to frame.** Double-buffered: this frame's half and last frame's. 786,432 blades of 48 bytes in each half, 75 MB in all. Each blade is kept as an offset from its patch's corner, so it stays right as the camera moves.
- **A table of patches** (2 × 8192 entries), keyed by face, place and block size. Its stamp is what the blades were made for: the tile, mesh level and ancestor under the patch, and the patch's distance in 15 % steps.
  - Same stamp as last frame: the patch's blades are copied on (copy pass).
  - Otherwise: they are made (generate pass, as before but only for those patches).
- **Few patches made over many workgroups.** Walking makes about 15 patches a frame: 13 a step nearer, 2 new, 0.6 a step farther.
  - One workgroup each left the GPU idle while they looped over their lattices: 1 ms for 2 % of the tufts.
  - Now each spreads over up to 16 workgroups. Splits 1, 4 and 16 make the same tufts.
- **A select pass** picks the blades drawn this frame by distance, rank and frustum. It works out each blade's wind bend, fade-in and far colour once, into a 32-byte record. The vertex shader only builds the strip.
- **16 blades an instance.** Before, each blade was an instance of 5–15 vertices: the far band alone (194k blades) cost 1.9 ms, nearly all geometry.
  - An index buffer of 16 strips per band now draws 16 blades an instance. The far band costs 0.8 ms.
  - With one blade an instance, fewer rows a blade had cost *more*: one row was 3.5 ms slower than two. Most of the GPU's vertex lanes were idle. With 16 an instance, fewer rows cost less again, and the far blades are back at two rows.
- **Vertex outputs packed**, 31 values to 17. Seven of them were never read: the blade's axis, a side sign, and the per-vertex light written as zeros when lighting is per pixel. On Apple GPUs each output is stored and read back for 2–3 million vertices a frame.

**Making sure it cannot go wrong quietly:**
- **A full rebuild draws the same blades.** Wiping the table and making everything again gave the same drawn counts (49,736 / 77,266 / 187,719). Standing still, no patch is made again.
- **After walking,** 0.1 % of near blades are missing against a full rebuild (61 of 57,515). The stamp follows the patch's nearest point, so a tuft can come a little more than 15 % nearer within one step. They are tufts at the fade-in threshold, grown in to almost nothing.
- **Store overflow.** It was 98 % full at standing height in a meadow (639,858 of 655,360). A patch that did not fit would have kept its hole until it changed.
  - Room is now 20 % larger.
  - The copy and generate passes poison the stamp of a patch that did not fit, so it is made again next frame.
  - Tested at density ×2.5 (1.29 million wanted): no GPU errors. Back at normal density, made settles to 0 again.
- **Settings and screen size.** The cache did not know about them: a density change kept the old tufts. Now a change of range, density or thinning, or a pixel size 15 % off (a resize, a zoom), makes all tufts again once.
- **Above 1440 pixels high,** far tufts widen instead of growing in number, so a 4K screen does not overflow the store.

**Results at high** (`grassBench.mjs`, 2592×1350, M1 Pro). Grass = full frame minus the terrain without grass, ms:

| View | Before (`27c`) | Cache (`27f`) | Now (`27m`, `27n`) | Making | Drawing | Ground look | of which portraits |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Meadow, root height | 8.6 | 5.1 | 3.1 | 0.73 | 1.68 | 0.71 | 0.31 |
| Meadow, standing | 9.0 | 5.5 | 3.5 | 0.75 | 1.85 | 0.91 | 0.44 |
| Toward the sun | 8.0 | 4.4 | 2.7 | 0.70 | 1.11 | 0.87 | 0.27 |
| From 8 m | 7.7 | 4.5 | 3.3 | 0.64 | 1.41 | 1.21 | 0.63 |
| From 15 m | 6.9 | 4.0 | 3.1 | 0.57 | 1.10 | 1.39 | 0.72 |
| Walking 3 m/s | 9.0 | 6.7 | 3.7 | 0.90 | 1.94 | 0.88 | 0.39 |
| Forest floor | 7.5 | 4.0 | 2.7 | 0.48 | 1.03 | 1.19 | 0.55 |
| Tundra | 6.7 | 3.7 | 2.3 | 0.59 | 1.33 | 0.34 | 0.16 |
| Marsh | 7.4 | 3.2 | 2.4 | 0.47 | 0.58 | 1.32 | 0.51 |
| Dry grass | 7.1 | 3.7 | 2.5 | 0.42 | 1.05 | 1.07 | 0.56 |

- **How measured.** Views where p90 lay more than 1 ms over the median in `27m` (from 8 m, from 15 m, forest, marsh: some other GPU use) were run again alone (`27n`). Those numbers are given; p90 there is within 0.4 ms of the median, marsh 1.5.
- **Medium** (1728×900, `27m`, p90 within 0.3 ms): 1.4–2.3 ms standing still, 2.5 walking. Before the cache: 4.7–6.4 ms.

  | Medium | Root | Standing | Sun | 8 m | 15 m | Walking | Forest | Tundra | Marsh | Dry |
  | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
  | Grass, ms | 2.1 | 2.3 | 1.8 | 1.8 | 1.7 | 2.5 | 1.8 | 1.7 | 1.4 | 1.6 |

- **Making** (0.4–0.9 ms) is now mostly the copy (0.35 ms) and the select (0.29 ms); the patch lattice is 0.06 ms.

**Steps** (`scatterParts.mjs`, game frame, standing and from 8 m, `27d`–`27l`):

| Change | Standing | From 8 m |
| --- | ---: | ---: |
| Before the cache | 16.32 | 15.08 |
| Cache | 12.41 | 11.51 |
| Per-blade work in the select pass | 12.16 | 11.16 |
| Packed vertex outputs | 11.55 | 10.91 |
| 16 blades an instance (draw 2.79 → 1.79 ms standing) | 10.13 | 10.39* |

\* That run's baseline was 0.5 ms higher; its draw fell 2.38 → 1.38 ms.

- **Each band drawn alone, standing,** ms over not drawing:

  | | Near (to 9.5 m) | Middle (to 24 m) | Far (to 240 m) |
  | --- | ---: | ---: | ---: |
  | One blade an instance | 0.63 | 0.93 | 1.89 (1.69 of it not shading) |
  | 16 an instance | 0.57 | 0.65 | 0.83 |

- **Rows per blade, 16 an instance,** standing frame: 7/4/2 10.03, 7/4/3 10.16, 7/4/4 10.30, 7/4/1 9.96 ms. Two rows far off are kept: one row is a straight triangle, and blades at 24 m are tens of pixels tall.

**Where the time is now, and next:**
- **The ground's look,** 0.7–1.4 ms: the canopy model and grain on every grass pixel of the terrain, the portraits up to 0.7 ms from above. The largest part from above.
- **Drawing,** 1.0–1.9 ms: about half of it shading.
- **The copy,** 0.35 ms: 21 MB of records moved a frame to compact the store. A store that keeps records in place and compacts now and then would save most of it.
- **The select,** 0.29 ms: it reads every kept record, most of them out of view. A test per patch first would skip them.
- **Walking,** +0.15–0.3 ms over standing: making only the missing ranks of a patch that comes nearer would save most of it.

## Profiling after the fifth round (2026-11-27)

Same method as below (`grassBench.mjs`, 96 frames per arm, interleaved). The GPU was otherwise idle (0–11 %); no leftover agent processes.

Grass in all, against the terrain without it:
- **High:** 6.7–9.0 ms, against 5.6–8.4 before the round.
- **Medium:** 4.7–6.4 ms.

Its parts at high (`results-2026-11-27c/`), ms:

| View | Without grass | All grass | Making blades | Drawing them | The ground's look | of which the portraits |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Meadow, root height | 5.92 | 8.6 | 4.5 | 3.3 | 0.7 | 0.0 |
| Meadow, standing | 6.17 | 9.0 | 4.4 | 3.8 | 0.9 | 0.4 |
| Meadow, toward the sun | 6.77 | 8.0 | 4.3 | 2.8 | 0.9 | 0.2 |
| Meadow from 8 m | 6.08 | 7.7 | 3.9 | 2.7 | 1.3 | 0.6 |
| Meadow from 15 m | 6.18 | 6.9 | 3.4 | 2.1 | 1.4 | 0.8 |
| Walking 3 m/s | 6.51 | 9.0 | 4.4 | 3.7 | 1.0 | 0.5 |
| Forest floor | 7.49 | 7.5 | 4.0 | 2.3 | 1.2 | 0.6 |
| Tundra | 7.51 | 6.7 | 3.5 | 2.9 | 0.3 | 0.1 |
| Marsh | 8.14 | 7.4 | 4.4 | 1.5 | 1.4 | 0.1 |
| Dry grass | 7.33 | 7.1 | 3.7 | 2.5 | 0.9 | 0.4 |

- **What the fifth round added:** about 0.7 ms at standing height and more from above. The canopy model costs up to 0.8 ms in the ground's look; the portraits up to 0.8 ms, the most from above.
- **Hitches:** p90 lies 0.2–0.4 ms over the median, except at root height and in the marsh (p90 up to 21 ms). Shader variants were still compiling after an arm switch: hitches to rule out in the game (variants are made at load).
- **Parts** (`scatterParts.mjs`, standing and from 8 m):
  - Drawing is 3.3–3.6 ms, about half of it blade shading.
  - Making blades: 0.1 ms is the lattice; about 3.2 ms is the per-tuft work, 1.1 ms writing its blades.
  - Range 120 m saves 1.5 ms; density ×0.6 saves 2.1 ms.
- **Where the time is:** making blades (3.4–4.5 ms, the same at medium) is the largest part, and it is redone every frame for tufts that rarely change. Next: keep each patch's tufts while the patch, its detail level and the terrain under it stay the same.

## Fifth round (2026-11-27): no zone around the player

The user's report: a hard edge (that moves with the camera) where blades end, and the grass seeming to vanish a few metres up.

**Measured cause, at the user's pose 7.7 m up.** Mean grey by distance:

| Distance | Blades on | Ground beyond them |
| --- | ---: | ---: |
| 24–40 m | 113 | 138 |
| 40–60 m | 135 | 140 |

- **A dark ring.** A rule for views from above put near blades into the far look, but left blades at 25–60 m in their own dark look: a ring unlike both sides, moving with the camera.
- **No notion of view angle.** The ground under the blades was darkened soil, so from above it read as bare earth. The far look was a flat bright canopy.

**What replaced them** (`grassHue.wgsl.js grassCanopy`, `grassPortraits.js`):

- **A physical canopy model**, shared by the terrain and the far blades: the gap-fraction and hotspot models of vegetation remote sensing (Nilson 1971; Kuusk 1985).
  - Blades fill the canopy from the ground to their tips, darker low down by the blades' own ramp. A sight line meets them by Beer–Lambert along its slant.
  - At grazing angles it sees tips (bright); from above it sees the depths and a little soil (darker).
  - The sun reaches low parts less, except along the view (the hotspot).
  - It is closed form, a few exponentials. It follows the view's slant, not the distance, so near and far agree from any height. The ground under blades shows the canopy too, not soil.
- **Portraits of the field (a BTF made from our own blades).** At load, a 4 m tile of blades made by the blades' rules is rendered from 31 view directions: 6 elevations × 6 azimuths, 256², 4× MSAA, mipmapped, 11 MB.
  - The terrain wears the portrait seen from its own elevation and way, blending the 4 nearest views, as a structure of mean 1 (the canopy model gives the mean).
  - Parallax and occlusion are in the views: from above, tuft crowns and gaps; along the ground, blades stacked as strokes standing up on screen. After Boulanger, Pattanaik and Bouatouch's grass terrains.
  - The far blades take their colour from the same portraits where they stand, and are lit by the same canopy model as they near their end (from 72 m).
- **Smaller changes:**
  - Seen from above, a blade's low part takes the canopy's light (it lies within the canopy the ground shows) instead of standing as a dark stick.
  - Flower and seed stems are green, not near black.

**Result.** Mean grey and fine contrast (mean absolute difference to neighbours) by distance, blades on against the ground alone, clouds frozen:

| | 6–12 | 24–40 | 60–90 | 130–180 | 180–240 | 240–320 m |
| --- | --- | --- | --- | --- | --- | --- |
| User's pose 7.7 m, blades | 120 / 18.3 | 133 / 14.1 | 139 / 8.5 | 154 / 10.1 | 152 / 9.6 | 153 / 8.2 |
| Same, ground only | 116 / 12.7 | 132 / 8.0 | 139 / 7.1 | 154 / 9.5 | 152 / 9.4 | 153 / 8.2 |
| Standing 1.8 m, blades | 117 / 36 | 134 / 26 | 153 / 12.9 | 153 / 11.9 | 154 / 10.7 | — |
| Same, ground only | 135 / 10 | 147 / 7 | 156 / 6.9 | 156 / 7.0 | 158 / 6.8 | — |

- **From the user's pose:** blades and ground match in brightness and texture past 60 m.
- **From standing height:** the brightness matches within 1–3 % past 40 m. The last blades carry somewhat more texture than the ground beyond (about 11 against 7–9): the one open item.
- **Not profiled.** The GPU was in other use.
- **Cost of the new parts:**
  - in the terrain shader: 4 portrait samples and the closed-form canopy per grass pixel;
  - in the scatter: 4 portrait samples per far tuft;
  - at load: the bake, about 2 million blade instances at the lowest view.

**Next.**
- Wind waves through the far field from the same gusts that bend the near blades. A gust bending blades away is the same as seeing them from lower down, so the gust shifts which portrait view is sampled.
- Then the per-patch tuft cache, and profiling.

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
