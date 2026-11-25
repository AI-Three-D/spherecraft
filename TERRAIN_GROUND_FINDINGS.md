# Ground surfaces, land light and a cheaper terrain draw

2026-11-25, on `terrain/material-lighting`, after Codex's round (dca1dbf). M1 Pro, Chrome WebGPU, high 2592×1350, medium 1728×900.

## Result

Full GPU frame, median, same poses and weather, Codex's commit against this:

| View | High, Codex | High, now | Medium, Codex | Medium, now |
| --- | ---: | ---: | ---: | ---: |
| Ground | 12.3 | 9.4 | 8.0 | 4.3 |
| Slope | 12.6 | 8.2 | 6.4 | 3.9 |
| Mountains | 12.3 | 9.1 | 7.6 | 4.9 |
| Eye level | 13.9 | 10.3 | 6.3 | 5.8 |
| Cliff | 12.7 | 9.5 | 7.7 | 5.0 |
| Vista | 13.3 | 8.9 | 7.8 | 4.5 |
| Meadow | 11.5 | 8.0 | 6.4 | 6.1 |
| River | 16.1 | 10.3 | 8.0 | 4.7 |
| From 3 km | 11.8 | 8.4 | 7.7 | 3.9 |

Targets: under 10 ms high, 6–7 ms medium. High still misses by 0.3 ms in the eye-level and river views. Medium frames are short enough for the GPU to lower its clock between them: single runs read up to 7.5–10.8 ms, and Codex's medium numbers have the same error. The table holds the steady runs. Pictures: `screenshots/terrain_ground_2026-11-25/` (Codex left, now right).

## What was slow

- **An unreachable `discard` in the terrain shader**: 1.9 ms. Its presence alone turns off hidden-surface removal on Apple GPUs.
- **`discard` used as an early exit in the water shaders**: 3.0 ms inland and 5 ms at a river. WGSL's `discard` does not stop the shader; every pixel ran the whole sea. They now return zero, which blends to the same picture (the passes are premultiplied and write no depth).
- **Passes that draw nothing**: 0.5–0.7 ms. A resumed render pass loaded and stored the full HDR target; it now begins at its first use.
- **Code that never runs still costs registers**: clustered lights without lights, far water in the nearest tiles, rain in dry weather. These are shader variants now, compiled beside the one in use, so a change of weather does not stall (worst frame 23 ms, was 173).
- Sky rays well under the horizon: one step instead of sixteen.

## What is new

- **Nine ground surfaces** (`groundMaterials.js`, `groundMaterialGenerator.wgsl.js`): grass, dry grass, forest floor, earth, gravel, rock, sand, snow, mud. Blades, leaves, twigs and stones are real small shapes drawn from above into a height field; slope, cavity and colour come from it. 1024², 0.8–1.1 s at load; about 155 MB with the wide patterns. `terrain_lab/index.html` shows them all.
- **A mosaic** (`groundSurface.wgsl.js`): the splat's four families become a mix of those surfaces by slope and a wide pattern (hummocks, worn patches, trails, stones). The two strongest interlock by height. Rock is drawn from three sides, with a cliff pattern that grows with distance. Stones and rock have parallax depth within 16 m (three samples, no measurable cost).
- **The far tiers take the same colours**: each surface's mean is exact, and the field patches go on in them.
- **Light over the land** (`light/TerrainLightMap.js`): heights of the loaded tiles in four maps around the camera (1.5 to 98 km), marched for open sky and for the sun. Mountains shade valleys at any distance as the sun moves. 0.3 ms; read per vertex. Daylight is now sun, sky share and bounce; the 30 % floor stays at night only.
- **Rain** darkens the ground and leaves puddles in hollows, and dries off.

## Repetition

The wide patterns were plain repeating textures: the mosaic every 128 m, broad fields every 670 m, the cliff every 40, 184, 840 m. From a few hundred metres up they stood in rows.

- **Variants with one border.** The mosaic (240 m) and the cliff (80 m and up) come in three variants whose borders are the same, also when turned around by 180°. The shader hashes each cell to one of six looks. One sample as before. The blending is done once, when the textures are made: slopes are blended, not heights (heights would leave a crease).
- **Fields in one layer.** 8 m per texel over 8 km instead of 0.65 m over 670 m, plus the same layer at 43 km. The second one also bends the mosaic's cells, so their borders are never straight.
- **The noise itself.** All octaves had a grid line on the texture's edge, and were aligned with its axes; this showed as faint bands. Octaves now have turned integer grids, which still wrap.
- The far tiers take the mosaic too, up to 9 km.

Strongest match of a straight-down picture with itself at any other place (70–520 pixels away), same build with one variant and unbent cells → as it is: 0.57 → 0.24 at 400 m, 0.39 → 0.26 at 1.2 km, 0.30 → 0.28 at 3 km, where the mosaic is grain and the terrain's own sand patches match. The old textures were not measured this way; the pictures show them.

Cost, old and new shader interleaved in one session, whole frame on high: 0 to 0.4 ms, typically 0.2. Ground 9.0 → 9.1, slope 7.8 → 8.0, mountains 9.2 → 9.4, eye 10.3 → 10.5, cliff 9.2 → 9.5, vista 8.9 → 9.2, river 10.5 → 10.5, 3 km 8.5 → 8.7. About 40 MB more.

Tried first: cells placed by a hash in the shader (hex tiling). It looks as good and costs 1–3 ms. The second samples are nearly free; the code for them in the shader is what costs, whether it runs or not.

Pictures: `screenshots/terrain_ground_2026-11-25/repeat_*.jpg` (before left).

## The line on the mountain (hand-over to the far tier)

Only the close tiers drew the cliff pattern; from LOD 5 on rock was one flat colour with the mesh normal. Between 1.8 and 3.9 km the pattern faded out, which on a wall showed as a line that moved with the camera.

- The wide patterns and the cliff are now computed the same in all tiers (`shadeGround`); `far` blends only what differs, the materials (splat families against the tile's own colour). Close and far rock also have the same colour, tint, openness and snow line.
- The cliff is drawn from one side, not three; borders between sides are ragged. This pays for the rest, and reads crisper.
- LOD 0 and 1 cannot reach the hand-over (their tiles end at 0.7 and 1.4 km), so their shader leaves the far part out (variant key `far`).
- The cliff's filter is 1.4 times softer than the footprint. At 1.0 a far cliff flickered: per unit of fine detail 0.095, now 0.073, before 0.077 (flat far rock). In absolute terms the wall changes more than before (0.76 against 0.41 grey levels a step), as it has twice the fine detail. Measured over 32 m of straight flight only. (The picture below has clouds on the left and a clear sky on the right: the weather was changed for this measurement.)

Cost, whole frame on high, interleaved, before → now: your two views 9.44 → 9.49 and 9.43 → 9.48, eye 10.8 → 10.0, near cliff 10.5 → 9.9, vista 9.3 → 9.3, far vista 8.8 → 9.0, from 3 km 8.9 → 9.3 (terrain pass 3.4 → 3.5). Before the softer filter: ground 9.4 → 8.9, mountains, cliff, river, meadow within 0.1.

Picture: `screenshots/terrain_ground_2026-11-25/handover_line2.jpg` (before left).

## Switches

`rendering.terrainShader.groundMaterials`, `landLight`, `groundFineEndMeters`, `groundDeepEndMeters`. In the game Shift+G: generated / without land light / the atlas textures of before. `?terrainSurface=atlas` at start. Benchmark: `tools/perf/terrainDetail/materialReview.mjs`.

## Not done, not checked

- **No network yet.** Bounce is one formula. NEURAL_BEYOND_CLOUDS_REPORT.md says to build the light map first and then measure the gap; that measurement is the next step.
- The mesh is unchanged (1 m vertices at best).
- Motion was judged by sub-pixel camera shifts only: no aliasing found, but near grass is contrasty. Not checked: a long fast flight with the sun moving, the cube faces' edges (the patterns meet unblended there, as the atlas did), all weathers.
- The prebaked `resolvedColor` per tile is no longer drawn and could be left out of refinement.
- The sea views cost 12 ms; that is water shading.
