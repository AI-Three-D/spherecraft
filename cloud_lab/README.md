# Volumetric cloud lab

Standalone harness for `core/renderer/volumetricClouds/`, built like `dev_harness`:
production `Renderer` and WebGPU backend, no terrain or game systems, no build step.

```sh
python3 server.py        # from the repo root
```

Open http://localhost:8000/cloud_lab/index.html. `?radius=1000` changes the planet radius (km).

Drag to look · WASD fly · Space/E up · Q/C down · Shift ×6 · Alt ×0.15 · wheel scales speed ·
1–7 jump between ground, cloud base, inside, above, stratosphere, low orbit and whole planet ·
H hides the UI. Flight speed scales with altitude. `window.cloudLab` exposes the renderer,
the modules and the camera; every panel value is a live property on `cloudLab.clouds.settings`.

## Performance and profiling

The bottom-left panel shows FPS, frame-interval percentiles, a frame-time graph and per-pass GPU times
(timestamp queries, via `core/renderer/profiling/gpuPassTimer.js`). **Profile all views** visits every
preset and tabulates GPU ms per pass; `cloudLab.runProfile()` returns the same data, and
`cloudLab.lastProfile` keeps the most recent run.

Under the FPS the panel shows the CPU and GPU work per frame. If the frame rate sits well above that work at
50 fps or less, something outside the renderer paces the frames, and the panel says so. A steady 30 fps on a
Mac is usually Chrome's Energy Saver, which caps pages at 30 fps on battery (chrome://settings/performance).

Reading the numbers:
- FPS is capped by vsync. Below the cap, Apple GPUs also lower their clocks, so per-pass milliseconds inflate.
  Compare costs where the GPU is saturated (e.g. a 2560×1440 window, or `Pixel ratio` 2 on Retina).
- Passes without a dependency can overlap, so a pass's span may include waiting. "GPU frame" is first pass
  start to last pass end.

Main cost levers: `Pixel ratio` (canvas pixels; 1x default, Retina 2x is ~4x the work) and `Detail` (the tiers of
`cloudDetailTiers.js`: high, medium, and low, which has no volumetric clouds).

`Slabs from orbit` (off by default in the lab) replaces the raymarch well above the layer with a few lit slabs per ray
(`cloudOrbit.wgsl.js`), crossfading between 40 and 80 km above the cloud tops.

## What is where

- `VolumetricCloudsModule.js`: engine `RenderModule`. It generates tileable 3D noise (Perlin-Worley shape, Worley detail,
  weather) and atmosphere LUTs once, then each frame draws a cloud shadow map, raymarches the spherical cloud shell, and
  accumulates jittered rays with depth-validated reprojection. `getOutputs()` returns premultiplied cloud radiance +
  transmittance, cloud distance (km), the shadow map and the LUTs.
- `CloudNeuralLighting.js`: the light inside the clouds. Small networks, trained on a path tracer (`neural_lab/`,
  `tools/neural/`), bake bounced sun, sky light and sun transmittance into a patch of 64 x 64 x 24 cells around the camera, a
  few rows per frame. Outside the patch a fitted light stands in (`fittedLight` in `cloudMarch.wgsl.js`).
- `CloudRayPairs.js`: traces every second ray and fills in the others where their neighbours agree.
- `shaders/cloudCommon.wgsl.js`: uniforms, atmosphere, and the density function (weather systems → coverage
  and type → shape → height → detail erosion, the sheet deck, altocumulus and the low clouds).
- `shaders/cloudMarch.wgsl.js`: the raymarch, the shadow map and the weather cube.
- `CloudCompositePass.js`: blends the clouds into a host's HDR scene after opaque geometry, hazed by the
  host's own transmittance LUT and scattering coefficients, and darkens shadowed ground. Spherecraft uses it.
- `cloud_lab/labComposite.js`: lab-only sky, analytic planet, aerial perspective split at the cloud depth,
  ground cloud shadows and ACES tonemap.

Cloud shadows come from a 256² map over a fixed 160 km on the ground's tangent plane at an anchor under the
camera. The plane stays fixed while the sun moves and is re-anchored only after the camera travels 15% of the
extent; a sun-facing grid rebuilt every frame made ground shadows shimmer. They fade out between
`shadowFadeStartKm` and `shadowFadeEndKm` above the cloud tops; above that the shadow pass is skipped and
`getOutputs().shadowFade` is 0. The noise lookups are rotated and the weather octaves warp each other, so
tiles do not repeat on a grid when seen from altitude. The 1 km detail tile is displaced by about a tile of
shape noise (`detailWarp`) and each cloud mixes its own billow size and erosion strength; without that, decks
seen from 10–25 km showed equal bubbles on a lattice. The weather volume is mipmapped and sampled at the pixel
footprint, so from orbit sub-pixel clouds fade instead of popping in and out as the camera drifts.

Samples lie on planes fixed in the world, with linear density between them, so nothing slices or crawls as the camera moves.
The weather pattern evolves (`weatherEvolveKmS`) and cloud shapes rise (`boilKmS`), so cover changes over time and not only
by drifting with the wind. `twilightSoftness` widens the planet-shadow edge so dusk dims the deck gradually, and
`ambientFloor` adds host light (night sky, moon) to the ambient. The moon (`moonDirection`, `moonIlluminance`) lights the
clouds as a second directional light. Cloud bases drift by up to a quarter of the layer across regions, and clusters of
taller towers stand among shallower fields.

## In spherecraft

`Frontend` creates the module and a `CloudCompositePass` when `features.volumetricClouds` is on (the cirrus
shell in `core/renderer/clouds` is separate, under `features.clouds`); options live under
`rendering.volumetricClouds` (`wizard_game/runtimeConfigs.js`). After opaque and transparent geometry it binds
the scene depth (`setSceneDepth`), runs the cloud compute and composites into the HDR target before bloom and
tonemapping. Planet size and atmosphere come from the planet's `atmosphereSettings` (metres → km), coverage
follows the weather's `cloudCoverage`, and the C key toggles clouds. The raymarch stops at the nearest
surface under each cloud pixel, so no cloud bleeds onto terrain silhouettes. At night the clouds get the
host's ambient light and scaled moonlight. `window.volumetricClouds` is the live module.

The cirrus (`core/renderer/clouds`) is a shell from the ground. Climbing towards it (from about seven slab
half-thicknesses below its middle) it crossfades into a volume slab sampled with the same pattern, which can be
flown through, and from a few slab half-thicknesses above it turns back into a shell seen from above. Its horizon
fade only applies from below; from above it had hidden the cirrus over the planet.

## Not done yet

- Ground shadows in spherecraft are applied in the composite to the whole pixel (direct and ambient alike, with
  a floor), not in the terrain shader's sun term.
- Wind is a single world-space translation, so on the far side of the planet clouds drift the opposite way.

The detailed raymarch that preceded the neural lighting, its cheaper tiers and its experiments are in git, on
`clouds/detailed-renderer-checkpoint`.
