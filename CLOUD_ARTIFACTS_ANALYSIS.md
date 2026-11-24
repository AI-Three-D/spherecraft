# Cloud preview artifacts: slices, the moving band and the ridge line (2026-11-23)

These are code-reading findings for the three artifacts in the overcast screenshots taken in the
Neural lighting preview (Shift+K). Nothing has been changed. The density march is shared by
Conventional and Neural lighting, so all three should look the same in Conventional; only lighting
differs between them.

## Red arrow: stacked white streaks above a cloud top (slicing)

What it is: copies of one cloud top's outline, one per march sample, stacked at different heights.

- The march takes 64 samples per ray, spaced evenly in log(t + 0.9 km) between where the ray enters
  and leaves the cloud layer ([cloudConventional.wgsl.js:146-152](core/renderer/volumetricClouds/shaders/cloudConventional.wgsl.js#L146-L152)).
  The gap between samples is about 3–8% of the distance, so roughly 0.3–0.8 km at 10 km.
- Each sample's density is applied to its whole interval: `exp(-density·σ·(b−a))`
  ([line 199](core/renderer/volumetricClouds/shaders/cloudConventional.wgsl.js#L199)). If one sample lands
  just inside a dome top, the full interval becomes an opaque slab.
- The only thing that softens this is the "refine" path, which takes an extra sample on the visible
  surface and moves the sample point. It is switched off in deck weather. `refineStrength` is
  `1 − smoothstep(0.12, 0.62, deck)`, and it is 0 in the Dense variant
  ([line 154](core/renderer/volumetricClouds/shaders/cloudConventional.wgsl.js#L154)). The Dense variant
  is used at deck ≥ 0.62 ([VolumetricCloudsModule.js:533](core/renderer/volumetricClouds/VolumetricCloudsModule.js#L533)).
- The footprint widening ([line 134](core/renderer/volumetricClouds/shaders/cloudConventional.wgsl.js#L134))
  blurs the noise lookups but not the height profile, so the top edge of a dome stays sharp in
  height.
- A ray that grazes a dome top is inside it for only one or two samples. Each neighbouring
  sample paints the dome's cross-section at a slightly different height, which gives a stack of white
  streaks with sky between them.
- Sample positions are tied to each ray's entry and exit distance, so they slide whenever the camera
  moves. That makes the slices swim.

This is the cost of 64 samples without per-frame jitter. The fix belongs with recommendation 3 in
CLOUD_VISUAL_REVIEW.md: jitter the samples per frame and blend with history. A cheaper partial fix
is to keep the surface refinement on for decks near the layer top.

## Blue arrow: smeared band that moves vertically with altitude (far averaging at grazing angles)

What it is: a region where individual clouds are faded into a flat, height-only average density.

- `farAverageWeight` ([cloudViewFields.wgsl.js:2-6](core/renderer/volumetricClouds/shaders/cloudViewFields.wgsl.js#L2-L6))
  is `smoothstep(1 km, 4 km, footprint / max(|rd·up|, 0.06))`. Two things make it fire much earlier
  than the setting's comment implies:
  - The footprint here is the sample-spacing footprint (spacing × 0.42–0.72), not the pixel
    footprint.
  - Dividing by the grazing cosine inflates it up to 16.7× for near-horizontal rays.
- Where that weight is high, density becomes `meanCloudDensity(weather, h)`
  ([lines 11-19](core/renderer/volumetricClouds/shaders/cloudViewFields.wgsl.js#L11-L19)). That depends
  only on height, so it reads as a featureless, horizontally streaked sheet. In the transition zone
  the detail is half faded, which is the smeared look in screenshots 2–3.
- Why it moves: the weight depends on how far a ray travels before it reaches the layer and how
  steeply it enters. Rough numbers for the 4–12 km layer:

  | Camera distance to the layer | Band edge sits near |
  | --- | --- |
  | 3 km | 8° elevation |
  | 1 km | 5° |
  | Inside the layer | the horizon |

  So the band sweeps up or down the screen as you climb or descend near the layer.
- Why it warps: sample spacing comes from the ray's total path through the layer. Near horizontal,
  that path is tens of kilometres long and very sensitive to altitude. A small climb respaces all 64
  samples along those rays, so whatever is left of the detail slides and distorts inside the band.

Two other effects create a distance-based band and could add to it:

- **Distant banks.** The game sets `distantBanks: 1`, fading between 20 and 30 km
  ([runtimeConfigs.js:42-45](wizard_game/runtimeConfigs.js#L42-L45)). The bank weight is also scaled by
  `(1 − deck)` and only applies while the camera is in the lower 45% of the layer, below about 7.6 km
  ([cloudViewFields.wgsl.js:21-25](core/renderer/volumetricClouds/shaders/cloudViewFields.wgsl.js#L21-L25)).
  The bank shape field is stretched (0.58 in x), so the clouds change shape across a ring at 20–30 km.
  That also fits "only in a certain altitude band", but deck weather weakens it.
- **Neural cache edge.** The 48 km light patch fades to the analytic lighting between 0.38 and 0.49
  of its width (`sampleLightPatch`). That changes brightness, not shape, so it is unlikely to be the
  distortion.

## Green arrow: grey line along the ridge, continuing behind the cloud (silhouette upsample gap)

What it is: sky pixels just above a ridge receive the cloud values computed for terrain pixels, and
the background shows through.

- The cloud target is at most 576×360, about 4× smaller than your 1.5× frame on each axis. Each cloud
  ray stops at the nearest scene depth among the corners of its screen block
  ([cloudCommon.wgsl.js:145-155, 316-323](core/renderer/volumetricClouds/shaders/cloudCommon.wgsl.js#L145-L155)).
  So every cloud texel touching the ridge is a terrain texel: it stores a negative depth and holds only
  the cloud in front of the terrain.
- `upsampleCloud` ([CloudCompositePass.js:342-372](core/renderer/volumetricClouds/CloudCompositePass.js#L342-L372))
  separates terrain and sky texels only when the 2×2 neighbours disagree. Take a sky pixel in the
  lower half of a terrain texel: all four of its neighbours are terrain texels. Then `matching == 0`
  and it falls through to a plain Catmull-Rom of terrain texels. That pixel gets the thin "cloud in
  front of terrain" instead of the full cloud along a sky ray, and whatever the host draws behind
  the clouds shows through. The result is a strip about one cloud texel wide (roughly 4–8 screen
  pixels) along every ridge.
- The line continues to the right where the ridge itself is hidden by cloud. That points to this gap
  rather than to terrain showing through.
- The haze distance in the composite reads the nearest texel without the terrain/sky check
  ([line 421](core/renderer/volumetricClouds/CloudCompositePass.js#L421)), so the same strip also gets the
  terrain's haze distance.

Fix direction: when no 2×2 neighbour matches the pixel's kind, look one texel further for a matching
texel instead of falling back to the mixed filter. The code comment at line 343 describes this bug
as fixed, but the fix only covers the mixed case.

## Checks you can run (browser console, live, no reload)

| Artifact | Command | If this is the cause |
| --- | --- | --- |
| Blue | `volumetricClouds.settings.farAverageEndKm = 0` | The band disappears and individual clouds stay all the way to the horizon, with more distant flicker. |
| Blue | `volumetricClouds.settings.distantBanks = 0` | The remaining ring at 20–30 km disappears. |
| Red, blue | Shift+K back to Conventional | Both artifacts stay the same. That confirms they come from the density march, not neural lighting. |
| Green | Lower "Resolution when still" to 1.0 | The ridge line gets thinner in screen pixels, because it scales with the screen-to-cloud-target ratio. |

Set `farAverageEndKm` back to 4 and `distantBanks` back to 1 afterwards. Both are read from settings
every frame ([VolumetricCloudsModule.js:1309](core/renderer/volumetricClouds/VolumetricCloudsModule.js#L1309)).
