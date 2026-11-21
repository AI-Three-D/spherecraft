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

Main cost levers: `Pixel ratio` (canvas pixels; 1× default, Retina 2× is ~4× the work), `Resolution scale`
(cloud target relative to canvas), `Interleave` (2×2 marches a quarter of the cloud pixels per frame and
reconstructs the rest temporally) and `Light steps`.

`Far layer proxy` (off by default) is a distance LOD for views well above the layer. Between `Proxy from` and
`Proxy full` (km above the cloud tops) the raymarch crossfades into a 4-slab model: one weather lookup and four
density samples per pixel, analytic sunlight through the slab column plus one sample towards the sun, no light
march. At 166 km it costs about a fifth of the raymarch and looks close to it, slightly grainier in dense areas.
The step heatmap shows proxy pixels in purple.

## What is where

- `VolumetricCloudsModule.js`: engine `RenderModule`. It generates tileable 3D noise (Perlin-Worley shape,
  Worley detail, weather) and atmosphere LUTs once, then each frame computes a cloud shadow map, raymarches
  the spherical cloud shell at `resolutionScale`, and accumulates temporally with depth reprojection.
  `getOutputs()` returns premultiplied cloud radiance + transmittance, mean cloud depth (km), the shadow map
  and the LUTs.
- `shaders/cloudCommon.wgsl.js`: uniforms, atmosphere, and the density function (weather systems → coverage
  and type → height profile → shape → detail erosion).
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

Temporal reconstruction: each frame marches one pixel per 2×2 block (`interleave`), reprojects the history
through the cloud depth, clamps it to the fresh neighbourhood (`historyClip` standard deviations) and blends
(`temporalBlend` per sample). With `fullRateOnMotion`, frames where the clouds move more than
`motionThresholdPx` on screen (and 8 after) march every pixel instead, since fast motion rejects most history.
`temporal: false` drops reconstruction entirely: every pixel marched every frame with a fixed jitter and a
3×3 tent filter. Proxy slabs then sit at their midpoints, and raymarch steps end on planes across the ray at
fixed world offsets (`dot(p, rd) = n·dq`, dq a power-of-two multiple of the minimum step), so moving the camera
slides samples within those planes instead of dragging step slices through the cloud. A screen-space jitter with
nothing to average it swam over the clouds; camera-relative steps showed as slices up close and crawled when
climbing. In the lab that raised the raymarch from 1.3 to 2.5 ms at a 600×400 cloud target; spherecraft
uses it, because reprojection artefacts (smear, shimmer, interleave blocks) were worse than the cost.
The weather pattern evolves (`weatherEvolveKmS`) and cloud shapes rise (`boilKmS`), so cover changes over time
and not only by drifting with the wind.

History is resampled with a Catmull-Rom filter and composited with a Catmull-Rom upsample; bilinear blurred
the clouds a little more every frame. Ray-start jitter is per-pixel white noise stepped by the golden ratio
(interleaved gradient noise left horizontal streaks while moving). `twilightSoftness` widens the planet-shadow
edge so dusk dims the deck gradually, and `ambientFloor` adds host light (night sky, moon) to the ambient.

When the coarse march steps from air into cloud (`refineEntry`), it bisects for the surface and marches quarter
steps from there for one coarse step, so a deck's top is not terraced along the step planes. Sky light is
attenuated by two upward density samples, so crevices and undersides stay darker than tops even under ambient
light alone, and the moon (`moonDirection`, `moonIlluminance`) lights the clouds as a second directional light
while the sun is down. Cloud bases drift by up to a quarter of the layer across regions, and clusters of taller
towers stand among shallower fields.

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

## Not done yet (by design for this first look pass)

- No distance LOD beyond mip-selected noise, empty-space skipping and 2×2 interleaving.
- Temporal history is resampled bilinearly, so fast turns soften clouds; Catmull-Rom history sampling would help.
- Ground shadows in spherecraft are applied in the composite to the whole pixel (direct and ambient alike, with
  a floor), not in the terrain shader's sun term.
- Full-rate marching while moving costs about 4× the raymarch on those frames.
- Wind is a single world-space translation, so on the far side of the planet clouds drift the opposite way.
