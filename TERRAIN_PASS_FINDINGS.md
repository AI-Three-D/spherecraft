# A cheaper terrain pass

2026-11-25, branch `terrain/render-cost`, against 3b0ebe6. M1 Pro, Chrome WebGPU, high 2592×1350, medium 1728×900. Pictures: `screenshots/terrain_render_cost_2026-11-25/` (before left, now right).

## Result

Whole GPU frame, ms, committed code against this, alternating sessions with a steady GPU load before each frame. Clouds off: their state differs by 0.3 ms from session to session.

| View | High before | High now | Saved | Medium before | Medium now | Saved |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Ground | 6.68 | 4.85 | 1.8 | 3.32 | 2.55 | 0.8 |
| Slope | 5.62 | 4.19 | 1.4 | 2.93 | 2.39 | 0.6 |
| Mountains | 6.06 | 3.40 | 2.7 | 3.01 | 2.19 | 0.8 |
| Eye level | 7.83 | 5.36 | 2.5 | 3.78 | 2.77 | 1.0 |
| From 3 km | 4.67 | 3.63 | 1.1 | 2.47 | 2.22 | 0.3 |
| Shore | 6.88 | 4.98 | 1.9 | 3.16 | 2.64 | 0.5 |
| Sea | 5.98 | 5.29 | 0.7 | 3.13 | 2.91 | 0.2 |
| Valley | 4.41 | 3.16 | 1.3 | 2.27 | 1.97 | 0.3 |
| **Mean** | **6.02** | **4.36** | **1.7** | **3.01** | **2.45** | **0.6** |

- With clouds on high: 9.48 → 7.27 on average, 1.5–3.1 saved per view.
- The terrain pass alone: high 3.62 → 2.03, medium 1.62 → 0.97.
- The target was 2–3 ms on high. Clouds off, two of eight views reach it (mountains, eye level); from 3 km, over the sea and in the valley the whole terrain cost 2.2–3.1 ms, so it cannot be reached there. Were terrain shading free, a frame would drop by another 0.6–1.3 ms.

## Main's biome landscape (2026-11-26)

Main (PR #28) was merged in and its ground ported into the pass: twelve layers, the tiles' climate texture, tundra, marsh, sand, glacier ice and bedrock tones. `groundSurface.wgsl.js` and `terrainPass.wgsl.js` hold the same ground rules twice: a change to one must go into the other. Pictures: `screenshots/terrain_render_cost_2026-11-26/` (old renderer left, pass right).

The poses of `tools/perf/biomeLandscape/poses.json` (`terrainPassBench.mjs --biome --no-clouds`), main's renderer against the pass in the same build and session, whole GPU frame, ms:

| View | High before | High now | Medium before | Medium now |
| --- | ---: | ---: | ---: | ---: |
| Dunes | 10.34 | 5.73 | 5.02 | 3.02 |
| Dunes west | 7.65 | 4.42 | 3.95 | 2.56 |
| Grassland | 7.13 | 4.58 | 3.91 | 2.47 |
| Forest floor | 8.55 | 5.40 | 4.57 | 3.08 |
| Tundra | 9.56 | 5.85 | 4.37 | 2.98 |
| Granite | 6.90 | 4.60 | 3.12 | 2.47 |
| Sandstone | 7.78 | 4.38 | 3.58 | 2.46 |
| Basalt | 7.92 | 4.53 | 4.28 | 2.58 |
| Marsh | 10.54 | 6.22 | 5.53 | 3.76 |
| Snow | 5.73 | 3.85 | 2.39 | 2.13 |
| Glacier | 9.42 | 4.26 | 4.50 | 2.45 |
| Glacier close | 10.15 | 5.75 | 4.77 | 2.79 |
| **Mean** | **8.47** | **4.96** | **4.16** | **2.73** |

- Same picture: 0.2–0.9 grey levels on average for dunes, grass, forest, snow and glacier; rock faces 1–2 (drawn from one side, as above). Close marsh mud is 2.2 off with fine grain in its relief shading, not from half floats or the air table; cause not found.
- The landscape rules cost the shaders about 300 instructions and 4–12 registers. They run in half floats, far tiles no longer read the tile colour, and near tiles skip the families texture (it only gated the bed, whose weight never exceeds the soil's).
- Not measured: the eight poses above against main checked out on its own.

## What changed, and what each is worth

- **A shader of its own** (`terrainPass.wgsl.js`, `draw/TerrainPass.js`) beside the old one. The compiler's own count for this GPU: near 2,210 → 1,348 instructions and 36 → 19 texture reads, far 1,149 → 795.
- **Dry and wet tiles** (`draw/terrainDrawList.wgsl.js`, `WaterCoverage.js`): the far water was 6,400 of 8,500 instructions, also on dry land. Up to 0.8 ms.
- **True height ranges** (`tileBounds.js`): tiles were culled with a 9 km sphere, so the ground all around and behind the camera was drawn. Now 43–53 % fewer triangles on average, 0.15–0.5 ms. Tile loading is unchanged.
- **The instance builder in parallel** (`instanceBufferBuilder.wgsl.js`): about 0.6 → 0.33 ms in both tiers. One of 128 threads did the hash table alone.
- **The air as a table** of ground height and distance (`draw/TerrainAir.js`) instead of 277 instructions a pixel: up to 0.3 ms. At most about 1 display step off for 99 % of samples, up to 8 in rare horizon cases.
- **The sea where it can be**: it was shaded on every pixel of every frame. It is now the rectangle that can hold sea, and nothing at all inland or with the camera under the ground. 0.1–0.2 ms.
- **Half floats** where they are enough: 0–0.2 ms.

## Same picture

- Culling: 576 views, depth of every pixel identical with it on and off.
- Old against new, clouds off: 0.2–1.6 grey levels of 255 on average at noon, dusk, night, low sun, rain, sea. Close rock 3.5 (p99 19): it is drawn from the side it faces most, as the cliffs already were, not a blend of three.
- Motion (16 steps of 4 cm or 1 m, five views): second difference 0–5 % lower than before, per fine detail within 2.5 %.
- Geometry: about 99 % of pixels have bit-identical depth; the rest is rounding of planet coordinates (about 1 cm).

## Occlusion culling

All on the GPU. The lowest ground of each tile's blocks makes a horizon around the camera (512 directions, 48 rings, front to back); a tile whose top lies under it is left out. No depth readback, no frame of delay. Off by default: `terrainShader.occlusion`, or `gameEngine.renderer.quadtreeTerrainRenderer.pass.options.occlusion = true`.

- Triangles −22 to −32 % among hills (up to −81 %), 0–2 % elsewhere.
- Costs 0.12 ms, saves 0.04–0.16 in the terrain: break-even among hills, 0.1 ms lost elsewhere. The GPU never shades hidden terrain anyway, so only vertices are saved.
- 572 of 576 views identical; in four, one pixel differs. Probably a hairline between tiles that showed the one behind; not proven.
- For trees it should pay: they cost vertices, and a simulation hid 22–29 % of tree land at eye level. Not measured with trees.

## Tried and left out

- **Networks.** By the compiler's count, per pixel: material rules 363–706 instructions against 240, air 256 against 83, parallax 272 against 104. Approximate as well, so no lab run.
- **Caching the blended material**: sharp enough close by it needs some 670 MB; at 170 MB it is up to twice as soft. Estimated, not built.
- **A depth pre-pass**: this GPU already skips hidden opaque pixels.
- **Coarser near meshes, and sky and terrain in one pass**: built, measured 0, removed.
- **The air in a screen-space table**: up to 18 display steps off at the horizon. Per vertex: too coarse from level 5 on.

## Not done, not checked

- Underground the sea is gone; under the horizon it is black there, as the sky draws nothing. A camera in a cave will not see the sea outside.
- Other GPUs. Without `shader-f16` full floats are used; without 10 storage buffers a stage, or with shadows, clustered lights or a debug view, the old materials draw.
- Long fast flights, the cube faces' edges, and the editor's hover overlay over the new pass.

## Measuring

`tools/perf/terrainDetail/terrainPassBench.mjs` (`--parts`, `--no-clouds`, `--root DIR` for another checkout) and `occlusionCheck.mjs OUT.json occlusion|cull|pass`. `rendering.terrainShader.terrainPass: false` brings the old renderer back.
