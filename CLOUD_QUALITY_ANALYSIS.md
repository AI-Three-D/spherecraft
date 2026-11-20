# Volumetric clouds: quality analysis

Branch `volumetric-clouds`, base `deaaba7`. The first pass was on 2026-11-18. This revision (2026-11-19) adds the results of your in-game checks and the problems you reported after them. Everything here comes from reading the code and your screenshots; I did not run the game.

## Where things stand

| Problem | Finding | Status |
|---|---|---|
| Blur while moving | Confirmed: the adaptive pixel ratio (0.85 / 0.70 while moving) was the worst source of flicker. | **Off.** The motion ratios now equal the still ratio (`runtimeConfigs.js`). Revisit only if profiling justifies it. |
| Edge glitter while climbing | The empty-cell-skip hypothesis (old 2a) is **withdrawn**: no setting changed it. New suspect: the step-phase ring pattern (section 3.2). | **Test with P.** The original skip is restored. |
| Night glow, night looks bad | The moon lights only the clouds and terrain. Sky and air have no moonlight, there is no night grade, and the moon is set to 15 % of the sun. | Analysis and plan in section 1. |
| Dawn and dusk "solid slabs" | Grazing light shows off the cloud geometry (flat tops, vertical walls). The shaded side gets one flat sky colour. The sky timing doesn't match. | Analysis and plan in section 2. |
| Horizontal stripes and teeth on cumulus near the ground | Fixed-height shell sampling: consecutive pixel rows sample unrelated depths at low view angles (section 3.1). More samples per shell didn't remove the teeth. | **Test with I:** the raymarch with shared lighting (the proxy's saving, the raymarch's samples). |
| Ripples and comb-toothed edges on cumulus, rings and vertical bands up close; stripes from 40 km with P on | Undersampling: steps grow with distance only, to 0.56 km (1.1 km in clear air). The anchor decides whether the misses show as ripples (planet centre) or stripes (near camera). | **Fixed with F** (you confirmed the ripples from above are gone). `layerStepFit` 0.5 is now the default in `runtimeConfigs.js`. |
| Cirrus drawn over cumulus near the horizon | Above about 12.4 km, all cirrus was drawn over the scene, including the part beyond the cumulus. | **Fixed.** |
| Cirrus horizontal bands from below | The sheet's thickness profile was sampled at one height per shell, a staircase. | **Fixed.** |

The clear-air test also explains its own glitch. In "every cell" mode, rays inside the layer (about 3.9–7.6 km) ran out of the 256-step budget, and the rest of the path fell back to the averaged density. So the budget is tight inside the layer, but the skip wasn't causing the glitter.

---

## Look iteration in game (2026-11-20)

Tuned in the running game (manual camera, frozen clock), not the lab. Screenshots: `screenshots/cloud_look_2026-11-20/`. It is all in the Shift+P "look pick"; the game default is unchanged.

**What made clouds blurry, solid blobs** (your note):
1. **Soft density ramp.** The coverage threshold on km-scale noise gave a density ramp hundreds of metres wide at every edge: soft fog.
   - Fix: `domeEdgeSharpness` (gain on the core).
2. **Noise blurred to a whole march step**, plus a half-resolution target and a 3×3 tent filter.
   - Fix: `stepFootprint` 0.35, `resolutionScale` 1.0, `spatialFilter` 0. The skin's fine steps also use their own (smaller) blur.
3. **Low extinction (25).**
   - Fix: 80, so the visible surface is thin and crisp.
4. **Cone-shaped Worley bumps.** Raw Worley values are cones, which read as rock.
   - Fix: `roundBump` turns them into round heads.
   - It is used for the billowy detail erosion and for `domeHeads`, which adds 0.5–1 km heads to every cloud (cauliflower).
   - Billowy erosion now starts a quarter of the way up each cloud (it used to follow the layer height, so small clouds were all "wispy bottom" fur).

**Giants:**
- They are now a local weather region in which coverage of the popcorn noise rises to 0.9 (as in Nubis). Each tower is built from the same 3D billowy noise, not a heightfield envelope with bumps (that read as a flying mountain).
- Erosion holds off until about 60 % of the tower's height, giving a massive column with big rounded heads.
- The vertical stretch of the shape noise is reduced to 1.18× (1.6× drew rock-like ribs).

**Lighting:**
- `ambient` 0.4, `msScattering` 0.35, `msExtinction` 0.12 (deeper multi-scatter), `aoSide` on.
- Dusk deepening (`sunsetDepth` 10 at `sunsetAltitudeScale` 0.35) now only starts below about 12° sun; from 30°, clouds turned pink in mid-afternoon.
- The deepening keeps the sunset hue but restores most of the brightness (`cloudSunTransmittance`): dusk clouds had turned darker than the sky.

**Honest gaps:**
- **Cost:** a full-resolution cloud target costs about 4× the raymarch. The half-resolution step of Shift+P is softer.
- **Distant towers:** they still look craggy at 30+ km. Fine detail aliases there; this is the aliasing pass we left for last.
- **Grain:** cloud undersides show a fine woven grain (step aliasing).
- **Dusk shading, fixed:** shaded parts of clouds at dusk were brownish or black. `duskSkyBoost` (look2.z) adds a twilight-sky fill (lavender-blue, in units of the sun's illuminance) around sunset, fading out by about 17° sun and about 7° below the horizon. It is in the look pick. Screenshots 9–11.
- **Far horizon:** the far band still shows layered strips (the far average).
- **Night sky band:** the vertical light band at night is the night sky's galaxy layer (`SkyRenderer`), not the clouds.

## Hair, grain and dark seams (2026-11-20, tested in game)

These were reproduced at your camera position: 10 km up, looking down at cumulus. Screenshots 12–16 in `screenshots/cloud_look_2026-11-20/`.

| Cause | Fix |
|---|---|
| **Light sharing on the visible skin.** Lighting held for 4 samples snapped between sample depths on crisp clouds, which showed as woven stripes and hair. A thin first sample's dim lighting was also carried onto the denser samples behind it, giving dark seams. | Light is shared only behind the skin, where the transmittance to the camera is below 0.4 (`LIGHT_REUSE_MAX_T`). It stays fresh where it shows, and most of the saving is kept. |
| **Detail noise sharper than the step along the ray** (`stepFootprint` 0.35). Each pixel sampled unrelated detail, which showed as combed strands. | `stepFootprint` 1.0. It also reads coarser mips, which is cheaper. |
| **Each step nearly opaque at extinction 80.** The surface snapped to step positions, giving streaks that radiate from below the camera. | Extinction 50, so the skin spreads over a few steps. |
| **Pixel-scale aliasing** at full resolution with no filter (grain from afar). | `spatialFilter` 1 (3×3 tent) plus `stepStratify`. Neighbouring pixels use four step phases in a 2×2 ordered pattern, and the tent gives each phase exactly a quarter of the weight, so it averages four depth samples per pixel at no extra cost. |

Result: soft billows with fine detail, as in the HZD reference. Distant towers are no longer craggy.

Left over:
- Faint arc moiré in thin cloud seen at grazing angles.
- Layered strips in the far band.

## Rings, dust and grain (2026-11-20, second pass)

| Defect | Cause | Fix |
|---|---|---|
| Fingerprint rings in thin cloud near the camera, short-lived while moving | (a) 8-bit shape and detail noise: the dome shape amplifies them about 20–30×, so thin cloud showed about 10 density levels as contours. (b) A zone plate: the step phase `dot(camera, ray) mod step` changes by several fine steps per pixel near the camera. | (a) Shape and detail volumes are now `rgba16float` (`NOISE_HQ_FORMAT`; weather stays 8-bit). (b) `stepAnchorKm` 2 (look3.x): step planes anchored at the camera snapped to a 2 km lattice, with `stepStratify` for the per-pixel phases. No stripes from 40 km. |
| Dust of specks around clouds | (a) The `heads` term added density in clear air. (b) Giant rims were faded by scaling density down. (c) Stratified phases on the coarse search and on far fine steps: thin fringes were found by only some pixels. | (a) Heads only inside existing cloud. (b) Rims fade by erosion. (c) One coarse grid for all pixels; fine-step stratification fades out from 6 to 15 km. Far detail erosion also fades once its cells are sub-pixel, and `detailPixelFootprint` is 2. |

A few faint specks remain near mid-distance cloud fringes. Side effect: the raymarch got about 3× faster (see `CLOUD_PERFORMANCE_PLAN.md`, section 1.5).

## Target: Horizon Zero Dawn (2026-11-19, lab only)

The user set HZD's clouds (Schneider, SIGGRAPH 2015 and Nubis 2017) as the target. In the lab, behind settings, with the game default unchanged:

| Setting | What it does |
|---|---|
| `cloudShape: 'domes'`, `popcornTopKm`, `giantShare` / `giantScale` / `giantHeight` | Popcorn at km heights, plus giant cells 5× wider that tower to about 11 km (`cloudTopKm` 12). Top, side and base are joined by a smooth minimum (no box corners), and the base rises toward the rim. Heads of popcorn size sit on the giants. |
| `inScatter`, `inScatterGain` | HZD's in-scattering probability (`0.05 + density^(0.5..2 by height)` times a base term), measured against each cloud's own height (`CloudBase.localH`). Darkens grooves between billows and cloud bases. Gain 2.5 restores overall brightness. |
| `aoSide` | Sky-light occlusion from three sideways samples as well as above. Costs three density samples per lit sample. |
| `sunsetDepth` 10 + `sunsetAltitudeScale` 0.35 | Earth-like dusk colour. The air's scale height here is 2.6 km, so clouds at 6–12 km sit above about 97 % of it and stayed white at sunset. Their sunlight colour is now read at 0.35 of their altitude, with 10× optical depth for a low sun. |

Shift+P's lab pick sets all of these; Shift+N has the Earth-like sunset step. Screenshots: `screenshots/cloud_shape_2026-11-19/` 15–19.

Still open:
- The cirrus band (from about 9.9 km) overlaps the tallest giants.
- Speed: about 7 fps in the game with the full raymarch, to be fixed after the look is right.
- Aliasing: last.

## Night and dusk changes (2026-11-19, in code, not yet seen in game)

Your references are lit and graded the way a renderer has to treat moonlight. Moonlight is sunlight about 400,000× dimmer, with the same colour, so a moonlit scene has daytime contrast and shapes. What makes it read as night is the eye's (or camera's) adaptation: brighter than physical exposure, desaturated and shifted to blue. Our night lacked all of that.

| Change | Where | Toggle |
|---|---|---|
| **Stand-in moon.** A full moon about opposite the sun (5° off). It rises at sunset, is highest at midnight and sets at sunrise. It used to be fixed on most places' horizon, so clouds got only grazing rim light. The lighting controller now uses the camera's horizon for it. | `StarSystem._getDefaultMoonInfo`, `lightingController._updateMoonLighting` | none |
| **Moon disc draws.** The `smoothstep(1.0, 0.7, …)` shader error is fixed. | `MoonRenderer.js` | none |
| **Moonlit sky.** The sky's own scattering, run again with the moon as the light and scaled by its intensity. The sky behind moonlit clouds is now dark blue instead of black. | `SkyRenderer.js` | none |
| **Moonlit haze.** Far clouds fade into moonlit air instead of black. | `CloudCompositePass.js` `hazeTo` | none |
| **Night look.** At full night the tonemap moves colour `grade` of the way toward blue night vision, and changes exposure by `exposure`. After your review, the game uses a light grade, 0.2, and 15 % darker: a full grade washed colours out to grey. Engine default off (`rendering.nightLook`). | `tonemap.wgsl.js`, `ToneMappingPass.setNight`, `frontend.js` | Shift+M |
| **Sunset colour.** A low sun's light reaching the clouds gets extra atmospheric depth (`sunsetDepth` 4 in the game; 1 = physical). The sun from about 30° up is unchanged, so daytime is unaffected. | transmittance LUT in `cloudPasses.wgsl.js` | Shift+N |

**Why the dusk clouds were pale.**
- The scaled atmosphere: 26 km thick, Rayleigh scale height 2.6 km, coefficients ×1.14 Earth's.
- At the horizon the sunlight's optical depth in blue is about 0.6. On Earth it is about 7.
- So physically the low sun stays nearly white on this planet, while `SkyRenderer` paints a fixed orange twilight band. Clouds and sky disagreed.

**Moonless nights:** see section 1. Black cloud silhouettes against a faintly glowing sky are physically right; the sky should not be pure black. The night look now lifts both. The stand-in moon is always full, so moonless nights only occur with M ("no moon").

## 1. Night

### What night clouds really look like

| Light | Illuminance on the ground | Relative to a full moon |
|---|---|---|
| Sun (direct plus sky) | about 100,000 lux | about 400,000× |
| End of civil twilight (sun 6° down) | about 3 lux | about 10× |
| Full moon, high in the sky | 0.1–0.3 lux | 1 |
| Quarter moon | about 0.01–0.03 lux | about 1/10, not 1/2 (a full moon is extra bright) |
| Clear moonless sky (airglow, stars, zodiacal light) | about 0.002 lux | about 1/100 |
| Stars alone | well under 0.001 lux | under about 1/300 |

- **Moonlight is sunlight**, reflected and slightly redder. Everything scales down together, so a moonlit sky is a dim copy of the day sky, still blue. Moonlit clouds stand against it with about the same contrast as by day. A long-exposure photo of a moonlit landscape looks like daytime with stars.
- **What reads as "night" is the eye's night vision.** Colour drains away (blues hold up, reds go dark), and contrast and fine detail drop. Games copy this with an exposure well above the physical level, plus desaturation and a cool tint ("day for night").
- **Moonless, with no city lights, clouds are darker than the sky.** They hide the stars and airglow behind them and are lit only by the dark ground and the faint sky. Black shapes cutting holes in the starfield is the correct look. "Almost black" with the moon off is right.
- **Stars give essentially no light.** Starlight plus airglow is about 1 % of a full moon. A small ambient floor covers it; it isn't worth modelling further.

### Why night looks bad here: the moon exists only for clouds and terrain

1. **The sky has no moonlight.** `SkyRenderer.js` has no moon term; the moon appears only as the disc in `MoonRenderer.js`. At night the sky is black with stars.
2. **The air has no moonlight either.** The composite's haze is lit by the sun only, and it goes to zero at night (`CloudCompositePass.js:195`). Distant clouds fade toward black instead of into moonlit haze, so a cloud 50 km away is as crisp as one 5 km away. With no depth cue, they read as cutouts.
3. **The brightness is set by the moon's intensity, not by exposure.**
   - The moon is 15 % of the sun (`lightingController.js:33` `moonBaseIntensity`, used at `frontend.js:1036`).
   - The clouds are at 15 % of their daylight level, against a black sky. Grey shapes on black: the "solid blobs".
   - By day the same clouds sit in a blue sky, with haze that fades them over distance. That context is why daytime reads well.
4. **There is no night look.** Exposure is fixed (`ToneMappingPass.js:19`, 0.75) and there is no desaturation or cool tint. So night renders as dim daylight, and the warm tan clouds and brown terrain keep their colour. It reads as a dirty, dim day rather than night.
5. **The cirrus has its own fixed night floor**, unrelated to the moon (`webgpuCloudRenderer.js`, `cirrusAt`, `daylight`).

Turning the moon off removes the only light that exists at night, but points 1–5 all remain. That's why it "only changed it".

**There is no moon: it is a fixed placeholder** (found 2026-11-19; this replaces the first pass's "+Y pole horizon" bug).
- No moon is configured for the game's planet: no `moonConfig` anywhere, and `createTestSystem` only adds one when it gets one. So `StarSystem.getMoonInfo` always returns `_getDefaultMoonInfo()` (`StarSystem.js:331`).
- That default never changes:
  - its direction is fixed at (0, 0.5, 0.5) in planet-fixed coordinates, so it never crosses the sky;
  - its elevation is hard-coded at 0.5 rad (the "29° above you" the M toggle always showed);
  - it is always "above the horizon", and always a full moon.
- For your camera on the planet's equator at −X, that direction lies on the horizon.
- So every night a full-strength moon lights the clouds from the same point on the horizon. That is the stationary glow from the first report.
- **Separately, the moon disc never draws:** `MoonRenderer.js:246`, `smoothstep(1.0, 0.7, …)`, is a WGSL error.

**Fix**
1. Configure a moon, passed from the game config to `createTestSystem`'s `moonConfig`.
2. Put its orbit near the planet's equator.
   - Orbits are built in the XY plane while the planet spins about Y. With default orbital elements, the moon's declination would swing ±90° every lunar month, and it would sit near a celestial pole, almost still, for days.
   - Use an inclination of about 90° ± 5°.
3. The phase then follows the geometry automatically: `GameTime` is never linked, so the orbital phase mode is used.
4. Fix the smoothstep: `1.0 - smoothstep(0.7, 1.0, d)`.

**Side finding:** the planet's own orbit has the same plane problem. The sun's declination drifts through ±90° over a game year, which is about 6 real hours with 60 s days, so seasons are far too fast and extreme.

### Plan for night (in order)

1. **Moonlit air in the composite.**
   - Add a moon term to `hazeTo`: the same phase functions, the moon direction, and the moon-to-sun ratio (`u.moon`).
   - This is a small change. Distant clouds then fade into a dark blue moonlit haze.
2. **Moonlit sky.**
   - Evaluate the day sky's scattering a second time, with the moon as the light, scaled by the same ratio.
   - Do it in the sky shader, or as a low-resolution sky-view lookup table.
   - The sky behind moonlit clouds then sits at the same relative level as by day.
3. **Night grade in the tonemap.** As the scene's luminance drops, blend toward a cool, desaturated luminance. It's cheap and does the most to make night read as night.
4. **Exposure sets brightness, not the moon.**
   - Keep one moon-to-sun ratio for sky, air, clouds and terrain, low enough that the sky is clearly dark.
   - Brighten the night with exposure (a time-of-day curve or auto exposure) to the level you want.
5. **Give the game a real moon** (see above) and fix the disc, so the light has a visible source that moves, has phases and sets. Rim glow near a visible moon is then correct.

Steps 1, 2 and 4 make the frame consistent, and step 3 makes it look like night. Without 1 and 2, no moon or ambient setting will look right.

## 2. Dawn and dusk: "thick solid slabs"

What the old dusk picture shows:
- the top of the deck is a row of flat-topped blocks;
- the lit face is one even tan wall with almost no billow shading;
- a sharp line where it turns into a flat, dark blue base;
- a sky that is still full daytime blue.

Low sun lights clouds from the side, which shows off their geometry; noon light comes from above and hides it. That's why it happens only at some angles, and why the daytime pictures (small clouds, seen from below, lit from above) look good.

Causes, most important first:

1. **Shape: flat tops and vertical sides** (the "mesa" note from the first pass).
   - `cloudCommon.wgsl.js:358-360` cuts `shape × heightProfile` at `1 − coverage`, and coverage is 0.08–0.28.
   - Only where the profile is close to 1 does the shape pass, so tops are cut flat at about the same height and the sides are near-vertical.
   - Lit from the side, those are flat walls.
   - **Fix:** apply the height profile as an erosion after the coverage cut, so each cloud's height follows its core density (rounded domes of varied height).
   - Widen the edge band too, so the detail erosion has room to carve billows into the walls.
   - Try both in `cloud_lab` first; they change the look a lot.
2. **The shaded side gets one flat colour.**
   - Cloud ambient (`cloudPasses.wgsl.js:277-284`) is the average of the whole upper sky, the ambient LUT's 128 directions. A crude up/down visibility scales it.
   - So every shaded part of every cloud gets the same blue, and lit versus shaded becomes a two-tone cutout.
   - Real clouds at dusk work differently: the shaded sides facing the sunset sky get warm light, the bases stay dark, and light wraps around the corners.
   - **Fix:** split the sky ambient into a sun-side half and an away half (two more LUT rows). Blend them with the light march's optical depth toward the sun, which is already computed, so exposed sides get the warm half.
3. **Clouds and sky disagree on the time of day** (old section 4a, still valid).
   - Clouds use the physical planet shadow, so on this small planet they stay sunlit until the sun is about 20° down.
   - The sky, terrain and haze each use their own Earth-tuned ramps.
   - Make one model the source of truth. Use the same atmosphere for sky and cloud ambient, or scale the clouds' shadow dip to match the sky.
4. **The light march is short at low sun** (old 4b, still valid). It reaches 3 km, so no cloud shadows another and each is lit as if alone.

**Order:** shape (1) in the lab first, since it decides whether lighting changes can help. Then the directional ambient (2), then timing (3). Points 2 and 3 also help night, through the moon's ambient.

## 3. Striping

### 3.1 Cumulus near the ground: horizontal stripes (the proxy)

- Below 2.0 km (blending to 2.4 km), the cumulus isn't raymarched. A proxy samples 16 fixed-height shells, one sample per shell crossing (`cloudPasses.wgsl.js:484`, loop at 567).
- Toward the horizon, a ray crosses a 190 m shell over about 1 km, and that whole kilometre gets one colour. The cloud is drawn as stacked horizontal slices, brightest where a slice cuts a lit top: the moonlit stripes.
- Above 2.4 km the raymarch takes over, and its surface refinement removes them. That matches what you saw.
- **Test:** press I to switch between the proxy and the raymarch, and watch the FPS.
- **Result:** the raymarch has no teeth and is wispier. The proxy stays for performance.
- **Change:**
  - Each shell crossing now takes 4 density samples (shape and detail, sharing one weather lookup) and is lit once, at its extinction-weighted position (`PROXY_SUBSAMPLES`).
  - The noise blur now matches the raymarch's at that distance (its step × `stepFootprint`, continuous).
  - Lighting, the expensive part, stays at one evaluation per crossing, so the extra cost is 3 × 2 texture reads per crossing that has cloud.
  - The matched blur also makes the crossfade into the raymarch at 2.0–2.4 km more consistent.
- **Result:** the teeth remained, and more shells or sub-samples can't remove them.

**Why the shells cause teeth**
- Shells sample the cloud at fixed heights.
- From below at a low angle, moving up one pixel row moves a fixed-height sample about 0.14 km deeper into the scene (at 10 km distance, 5° up). So consecutive rows sample unrelated parts of the cloud, each row's edge lands somewhere else, and the outline becomes horizontal bars.
- The raymarch samples at fixed distances along the ray. Moving up a row moves each sample about 12 m higher, so its outline is smooth.

**What the proxy actually saves**
- Lighting: 16 evaluations per ray instead of one per cloud sample. Lighting (the light march, sky visibility and the ambient LUTs) is most of a cloud sample's cost.

**Candidate: light sharing in the raymarch** (`lightReuseSteps`, toggle I)
- The raymarch keeps its own sample positions and density per sample, but computes lighting only at the first cloud sample after clear air and then every 4th sample, reusing it in between.
- The visible skin is always lit fresh.
- Near the ground this replaces the shell proxy's saving with no teeth. It applies at every height, so it is also a general optimisation.
- **Compare with I:** the shell proxy, the raymarch, and the raymarch with light every 4th sample. Look at the teeth and the FPS. If the shared-light raymarch is as fast as the proxy and looks like the raymarch, it can replace the proxy.

### 3.2 Cumulus ripples, comb-toothed edges, and rings and bands up close (the raymarch)

**Mechanism**
- Steps end on planes `dot(p, ray) = n·step`, measured from the planet centre. Each pixel's grid therefore starts at `dot(camera, ray) mod step`.
- With the camera about 140 km from the centre, that offset changes by about 0.13 km per cloud pixel toward or away from the nadir, about one whole step at mid range. On a pixel grid this aliases into a ring pattern around the nadir.

**How it shows**
- Wherever the result depends on where samples land (thin cloud, edges), the pattern appears as ripples parallel to cloud edges and comb teeth pointing away from the nadir. Your 12 and 13.5 km shots show both.
- Climbing shifts every offset by `cos(view angle)` per km. Looking 40° down, that is about 5 steps per km, so the pattern scrolls as you go up and down. This is likely part of the "glitter while climbing".
- Up close (4.7 km, the red arrow), the offset is constant along a screen row, which sits at the same angle from the nadir. A near-vertical cloud wall seen edge-on then gains or loses one sample at fixed x positions, giving straight vertical bands. The small ring patterns are the same aliasing.

**Test**
- Press P to switch to "near camera": the planes are anchored at the camera position, snapped to a 2 km lattice. Offsets then line up across the screen, and the ripples and teeth should go.
- Look at cloud edges from 10–14 km, and climb or descend.
- The trade-off: the planes jump once each time the camera crosses into the next lattice cell (about every 1–2 km of travel). Check whether that jump is visible at your flying speeds.

**Result (42 km, near-camera anchor):** the clouds broke into parallel stripes. The anchor changes how the error looks but not the error itself.

**The underlying error is undersampling along the ray.**
- Steps grow with distance only (`stepGrowth` 0.012 per km). From about 40 km they are at the 0.56 km power-of-two cap, and in clear air every other cell is skipped, so empty samples are 1.1 km apart.
- A small cloud is hit only where it crosses a sampled shell.
- **Near-camera anchor:** every pixel samples the same shells, concentric around the camera, so the hits line up as stripes.
- **Planet-centre anchor:** each pixel samples different shells, so the same misses show as ripples, teeth and glitter.

**Candidate fix (toggle F): fit the step to the path through the layer.**
- A ray from above crosses the 3 km layer in about 5–15 km, which the 256-step budget could cover at 0.04–0.12 km steps; distance alone gave 0.56 km.
- With `layerStepFit` 0.5, a segment's step is capped at path length / (maxSteps × 0.5).
- Horizon rays inside the layer (long paths) are unchanged.
- The far-average switch still measures the distance-based step, so the far grazing band does not change.
- It also sharpens clouds seen from above, because the noise prefilter follows the step (it was a 0.56 km blur from 40 km up).
- The cost is more samples on those rays, so watch FPS.

**P removed (2026-11-19).** The near-camera anchor drew vertical stripes on cloud walls seen from the side, because all pixels sampled at the same distances. The planet-centre anchor (the original code) stays. F is the fix that worked.

### 3.6 Shimmering vertical curtains through cumulus (testing with P)

- **Seen:** fine vertical lines through the whole cloud thickness, most visible in the thin lower part, that shimmer and shift while moving (like aurora curtains). They are there with default settings.
- **Suspected cause:** the per-region shape-noise offset `weather.shift` (`cloudCommon.wgsl.js:329`).
  - It slides the 3D shape noise sideways by up to ±0.6 tiles (±10 km), and it is read from fast weather channels:
    - `w2.a`, Perlin at 8–64 cycles per 260 km tile, changing texel to texel at 2 km;
    - `w1.b`, Worley clumps, with creases.
  - Where those change fast, the slide outruns the shape noise's own rate (1/16 tile per km). The noise is squeezed or folded sideways but not vertically, which makes thin vertical sheets.
  - Their blur level follows the pixel footprint, so they alias and move with the camera.
  - The code comment says the offset should "vary over ~100 km"; the channels it reads don't.
- **Candidate fix (toggle P, `shapeOffset`):** `slow` reads the offset from the planet-scale lookup's smooth Perlin channels at mip 3 (about 40 km texels), so it varies over 50–200 km and never folds. `none` is a control.

### 3.4 Cirrus: straight seams (fixed in code, not yet checked)

- The sheet's height comes from `sheetCenterOffset`. It was a linear lookup on mip 3 of the 64³ base noise: a grid of about 5 km, with ±1.15 km of height.
- So the sheet's tilt broke, by up to about 25°, at every grid line. Seen nearly edge-on (from inside or just below the slab), the path through a thin sheet follows its tilt, and each break showed as a straight seam.
- It is now a smooth swell of three plane waves on the sphere (wavelengths about 16–40 km): no grid, and cheaper than the texture read.
- **If layered bands remain at very low angles**, they are shell sampling, the same mechanism as the cumulus proxy's teeth. At grazing angles, consecutive pixel rows hit each fixed-radius shell far apart in depth.
- **The fix then** is the one that worked for cumulus: steps across the ray (view-aligned), with the sheet profile integrated per step and the wisp pattern read where the ray crosses the sheet.

### 3.3 Cirrus from below: horizontal bands (fixed)

- The cirrus volume is cut into 24 fixed-radius shells (`webgpuCloudRenderer.js:911`). Each crossing used the sheet's thickness profile at one height, a staircase that showed as layers where rays cross the sheet at a shallow angle.
- Each crossing now uses the profile's exact mean over the heights it covers (`sheetProfileMean`, line 888, used at 1002).

## 4. Cirrus over the cumulus (fixed)

- **Cause**
  - From the cirrus slab upwards (above about 12.4 km for the current layer, 9.9–18.7 km with the slab from 12.4 km), the frontend drew the whole cirrus after the volumetric clouds.
  - A ray toward the horizon passes the cumulus near its lowest point, then climbs back out through the cirrus beyond. That far cirrus was painted over the cumulus.
  - The band's straight lower edge is the planet's limb: lower rays hit the ground, which ends the cirrus.
- **Fix**
  - Every ray is split at its closest approach to the planet. Before that point it descends and meets cirrus first; after it, it climbs and meets cumulus and ground first.
  - The far part is now drawn before the terrain, so the cumulus composite dims it correctly. The near part is drawn after the clouds, and only from the slab upwards (below that it is empty).
  - This is exact at every camera height, because the cirrus is entirely above the cumulus.
- **Code**
  - `frontend.js:843` and `867`; `renderCirrus(..., part)`; `inRayPart` in the cirrus shader.
  - The near part needs its own material: uniform buffers belong to a material and are written at draw time. One material drawn twice in a frame would give both draws the second draw's values.
  - The cirrus update now runs before the first cirrus draw, so both parts use this frame's camera. Previously the before-terrain cirrus used last frame's.
- **Side finding (not fixed):** the same per-material buffer means that with more than one cirrus layer active, every layer is drawn with the last layer's parameters. With only the `high` layer, which is the usual case, it doesn't matter.

## 5. Still open from the first pass

- **Prefilter jumps at step-size boundaries** (old 2b): `footprint` uses the power-of-two `dq`, so the noise mip level jumps at fixed distances. Use the continuous step length instead.
- **Catmull-Rom overshoot at bright edges** (old 2c): clamp the upsample to the 2×2 texels around it.
- **One-texel cloud-free band along terrain silhouettes** (old 2d). It showed as a bright line between clouds and ridges at night. **Fixed in code:** texels whose ray stopped at terrain store a negative depth, and where the 2×2 texels around a pixel disagree, the composite blends only texels of the pixel's own kind (sky or terrain). Not yet seen in game.
- **Cloud target tied to the canvas ratio** (old 1): moot while the adaptive drop is off.

## Suggested order

1. **Check P and I.** Keep the near-camera anchor if the ripples go and the lattice jumps are acceptable. Drop the ground proxy if the FPS allows.
2. **Night consistency:** moonlit haze, moonlit sky and a night grade (section 1, steps 1–3), plus the two moon bugs.
3. **Dusk:** cloud shape in the lab (section 2.1), then the directional ambient (2.2), then the time-of-day mismatch (2.3).
4. **Smaller items:** continuous footprint, the Catmull-Rom clamp, and a longer light march at low sun.

## In-game toggles (`wizard_game/standalone.html`, all live, reset on reload)

| Key | Toggle |
|---|---|
| N | Resolution while moving: as configured (now = still), toned down, off |
| P | Cloud shape offset: regional (current), slow planet-scale (candidate fix), none (test) |
| F | Cloud step size: fit to layer crossing (**default now**, `layerStepFit` 0.5) or by distance (old) |
| I | Near-ground clouds: shell proxy (default), raymarch, or raymarch with light every 4th, 8th or 16th sample (applies at all heights; reuse is also capped at `lightReuseMaxKm` 1 km along the ray). You found the 4th-sample version indistinguishable from the full raymarch. |
| Shift+M | Night look (`rendering.nightLook`: grade, exposure, sky = moonlit sky brightness, clouds = moonlit cloud brightness): clouds 30 % / sky 35 % (default, picked in game), very dark, 60/50, bright, off |
| Shift+P | Look: game settings (current), look pick (crisp cauliflower + giants, full-res, slow), look pick at half resolution. Earlier description:  cut (current, flat tops), fluffy domes 1.5× with an 8 km shape tile (lab pick), domes with an 11 km tile, domes with a 16 km tile. Lab screenshots: `screenshots/cloud_shape_2026-11-19/` (5–7 = fluffy). |
| Shift+N | Sunset colour on clouds: deeper 4 (default), deepest 7, physical 1 (old) |
| M | Cloud lights: sun + moon, no moon, no sun. At night it also shows the moon-gate check ("← WRONG"). |
