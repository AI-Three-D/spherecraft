# Volumetric clouds: performance plan

2026-11-20, branch `volumetric-clouds`.

**Baseline:** the Shift+P look pick runs at 2.5–3.5 fps in the game (user's screenshots, MacBook, 1.5× canvas pixel ratio, cloud target at full canvas resolution). The look is now right, so this plan is about getting the speed back without losing it.

See [section 9](#9-general-optimization-pass-2026-11-20) for the current implementation, before-and-after timings and browser comparisons.

The cost analysis in section 2 comes from reading the shaders. Section 1 is how to measure it, and the measured numbers go in section 1.5.

---

## 1. Profiling plan

### 1.1 Tools we already have

- **`GpuPassTimer`** (`core/renderer/profiling/gpuPassTimer.js`): WebGPU timestamp queries per pass.
  - `VolumetricCloudsModule` already brackets each of its compute passes when `clouds.gpuTimer` is set (`_dispatch`, `timestampWrites`). The passes are `shadow`, `raymarch` and `temporal`; with `temporal: false`, the `temporal` pass is the 3×3 tent filter.
- **The cloud lab** (`cloud_lab/index.html`) requests `timestamp-query` and installs the timer.
  - Its panel shows per-pass GPU ms.
  - `cloudLab.runProfile()` visits every preset and returns a table.
- **`debugSteps`** (march2.w): colours each pixel by the number of march steps used. This is the cost heatmap for the raymarch.

The game itself does not request `timestamp-query`. So the plan profiles the cloud module in the lab with the game's settings, and checks in the game with frame times (FPS, uncapped).

### 1.2 Conditions (Apple GPU / Chrome / Metal)

- **Make the GPU the bottleneck.** At a vsync cap the GPU down-clocks and per-pass ms inflate.
  - Lab: use a 2560×1440 window or `Pixel ratio` 2.
  - Game: set `rendering.maxFps 0` and freeze time (T).
- **Plug the laptop in** and turn off Chrome Energy Saver (it caps pages at 30 fps on battery).
- **Freeze the clouds:** `windSpeedKmS 0`, `weatherEvolveKmS 0`, `boilKmS 0`, so every A/B run sees the same clouds.
- **Settle first:** wait about 3 s after any change, then average about 120 frames (`timer.stats()` gives avg and p95).
- **Treat pass ms as indicative only.** Passes without a dependency can overlap, so compare `raymarch` ms against the total.

### 1.3 Fixed benchmark views

Use the game's planet in the lab (`?radius=131`), with the game's atmosphere and cloud settings: the `T.look` object in `.claude/tmp/cloudShots.js` holds them. Add a `systemOffset` that gives scattered cumulus (2.0 at the start site).

| # | View | Why |
|---|---|---|
| V1 | Ground, 1 km, pitch +14°, sun 35° | Typical player view, mostly clear air above |
| V2 | 3 km, looking along the layer at the horizon | Longest rays: the far band and `maxSteps` |
| V3 | 6 km, inside the layer among the towers | Inside cloud, near detail, light march heavy |
| V4 | 10 km, pitch −35° (your screenshot) | From above: `layerStepFit` and the cirrus volume |
| V5 | Same as V1 at dusk (sun 5°) | Moon is off; the dusk fill branch is on |
| V6 | Same as V1 at night (sun −35°) | Moon light march (a second `directLight`) |

### 1.4 Measurements

**A. Pass breakdown.** Measure `shadow`, `raymarch`, `temporal`/filter and `composite` in the lab, and cirrus in the game. Compare the game's FPS with Shift+P off versus on, and with cirrus on versus off (`features.clouds`).

**B. One knob at a time.** Measure raymarch ms per view against the look pick. Each row answers "what does this cost, and what does it buy":

| Knob | Values | Expectation |
|---|---|---|
| `resolutionScale` | 1.0 → 0.67 → 0.5 | ~Pixel count. 0.67 is one cloud texel per CSS pixel at ratio 1.5. |
| `lightReuseSteps` | 1, 4, 8 (sharing only behind the skin now) | Cost of lighting |
| `lightSteps` | 6, 4 | Light march length |
| `aoSide` | 1 → 0 | 3 base samples per lit sample |
| `giantShare` | 0.6 → 0 | 1 extra shape fetch per sample, plus the 12 km layer |
| `cloudTopKm` | 12 → 7 (no giants) | Ray length through the layer |
| `layerStepFit` | 0.5 → 0.25 → 0 | Forced fine steps on rays from above |
| `maxSteps` | 256 → 160 | Step budget (watch the far band) |
| `stepFootprint` | 1.0 vs 0.35 | Mip level, i.e. cache behaviour |
| `detailErosion` | 0.75 → 0 | Removes the detail fetch (cost of detail) |
| `shapeOffset` | regional / slow | One extra weather fetch per sample when `slow` |
| `farAverageEndKm` | 4 → 2 | Far band switches to the cheap average sooner |

**C. Heatmaps.**
- `debugSteps` per view shows where the step budget goes: the far band, rays from above, clear air.
- Add a debug mode that writes *lit samples per pixel* (calls to `cloudSource`) next to steps, to see how much lighting work there is.

**D. Noise format.** Compare 8-bit against 16-bit shape and detail volumes (just changed for the rings). 16-bit doubles the texture bandwidth, so measure whether it costs real time.

**E. Record** every measurement in section 1.5 as `view, knob, raymarch ms, total ms, fps, visual note`.

### 1.5 Results (2026-11-20)

**Method**
- Cloud lab at `?radius=131&dpr=1.5`: canvas 2100×1230, about the game's canvas for this window.
- Look-pick settings; the cloud field is frozen and reset, so every session sees the same clouds.
- GPU timestamps.
- Helper: `.claude/tmp/labProfile.js` (gitignored).
  - `P.ab(view, sunElev, { name: settings })` measures each variant between two baselines and reports its ratio to their mean.
  - Every setting a variant changes must also be in `P.base`, or it sticks for the following runs.

**Measurement pitfalls found**
1. **Absolute ms are not comparable across runs.** The laptop GPU's clock state changes the baseline by up to 2× (V1 at half res: 53 ms in one run, 27 ms in a later one). Use interleaved ratios, never ms from different runs.
2. **At under about 5 fps the timings go flat.** At full resolution, four different variants all read 480.5 ms: throttling or time-slicing. Profile at `resolutionScale 0.5` (0.65 M rays, about 15 fps) and scale up.
3. **The cloud field must be reset per session.** Wind and evolution run for a few seconds before the freeze, and that alone moved the V1 cost by 2×.
4. **Correction:** the earlier "318 → 84 ms" from the polish fixes compared sessions with different cloud fields. The measured saving of those changes is **about 23 %**, shown below.

**Pass breakdown.**
- The raymarch is 97–99 % of the cloud GPU time.
- Shadow map: 0.4–0.5 ms. 3×3 filter: 0.2–0.7 ms. Composite: 0.9–2 ms (more when much of the screen is cloud).
- The lab's 2.6 ms "atmosphere" pass is its own sky, not part of the game.
- The non-raymarch passes total about 1.5–3 ms in the game.

**Views (ultra look at half res, one run):** V1 53 ms, V2 68, V3 98, V4 102. Full resolution (1.0) costs 3.36× half res, so pixel count dominates.

**Settings, each relative to the ultra look (ratio, 1.0 = same cost):**

| Setting | V1 (ground) | V4 (above) | Visual effect |
|---|---|---|---|
| Old light march (weather re-sampled, `T < 0.003`) | 1.22 | — | Same picture: those two changes saved 18 % |
| Old ungated heads | 1.07 | — | Dust: that fix saved 6 % |
| `giantShare` 0 | **0.66** | **0.62** | No towers |
| `aoSide` 0 | 0.87 | 0.86 | Slightly flatter folds |
| `layerStepFit` 0 | 0.85 | 0.94 | Stripes come back from 40 km |
| `lightSteps` 4 | 0.94 | 0.93 | Small: thinner self-shadow at depth |
| `lightReuseSteps` 8 | 0.98 | — | Small |
| `domeHeads` 0 | 0.89 | — | Loses the cauliflower |
| `maxSteps` 128 | 0.87 | **0.38** | **Broken:** dust and a grey band where in-layer rays run out of steps. Not a usable knob. |
| `resolutionScale` 1.0 | 3.36 | — | Ultra sharpness |

**Tier candidates (relative to ultra at full res):**

| Tier candidate | Settings | Cost vs ultra | Visual |
|---|---|---|---|
| Ultra | Look pick, `resolutionScale` 1.0 | 1.00 | Reference |
| High | 0.67 res, `aoSide` 0, `lightSteps` 5 | **0.41** | Nearly the same, slightly softer (screenshot checked) |
| Medium A | 0.33 res, no giants, top 7 km, 96 steps, 4 light steps | 0.05 | **Rejected:** a hazy slab and the step-budget grey band (`maxSteps` 160 alone already breaks it: screenshot 23) |
| Medium B | 0.33 res, no giants, `aoSide` 0, 4 light steps, `layerStepFit` 0.25 | **0.07** | Checked in the game: a soft popcorn field with no band or dust (screenshot 21) |

**Medium B in milliseconds** (fast-clock run, raymarch only): V1 6.2 ms, V4 11.7 ms. Add about 1.5–3 ms for the other passes.
- From the ground, that just meets the 5–8 ms medium target.
- From above it does not, and in the slow clock state neither view does.
- So **medium needs the structural work** (sections 3.2 #1–#4) to hold 5–8 ms everywhere; settings alone bottom out around there.

### 1.6 Analysis

1. **Pixels first.** Cost is linear in rays, and the 3×3 filter with stratified steps keeps 0.67 resolution almost indistinguishable from 1.0 on Retina. The resolution step between tiers is the biggest lever, and it is free to implement.
2. **Giants are the most expensive feature** (34–38 %). They cost an extra 3D fetch per sample, and towers mean long paths through dense cloud with lighting on every skin sample. That makes them a tier feature: ultra and high only.
3. **Lighting is the next biggest share.**
   - The light march and sky occlusion together are about 25–30 % (old-light +22 %, `aoSide` 13 %, `lightSteps` 6 %).
   - The deep shadow map (3.2 #2) replaces most of it for every tier at once.
4. **Rays from above (V4) are the worst case**, at 2× V1. The cause is steps through clear air (`layerStepFit`, the 12 km layer).
   - Empty-space skipping with the baked weather map (3.2 #1, #3) is the fix.
   - Cutting `maxSteps` is not: it breaks in-layer views.
5. **The non-raymarch passes (about 1.5–3 ms)** matter only for medium.
   - The composite's 8-step haze per pixel is the biggest of them. It could run at cloud resolution, or reuse the sky's aerial-perspective LUT.
   - The shadow map can update every 2–4 frames.
6. **Cirrus is still unmeasured in the game.** Its full-resolution 24-shell volume above 7 km is the next suspect; profile it with the game FPS (cirrus on/off).

### 1.7 Tier plan

Budgets are for the whole cloud work on this MacBook at the game's canvas.

| Tier | Content | Budget | Status |
|---|---|---|---|
| **Ultra** | Current look, full res, giants; then optimized with the baked weather map and deep shadow map | As fast as achievable | Look done; optimizations pending |
| **High** | Ultra at 0.67 res, `aoSide` 0, 5 light steps | About 0.4× ultra | Settings validated in screenshots |
| **Medium** | 0.33 res, popcorn only (no giants), `aoSide` 0, 4 light steps, `layerStepFit` 0.25; plus the baked weather map and empty-space skipping; composite haze at low res | **5–8 ms** | Settings reach about 6–12 ms; needs 3.2 #1, #3 |
| **Low** | No volumetric cumulus; the cirrus shell only (the original renderer) | About 1 ms | Needs a "shell only" switch: the cirrus volume turns on by altitude today |
| **Lowest** | Cirrus shell at low quality (half res, no flow passes), or a static sky dome texture | Well under 1 ms | `setCirrusQuality('low')` exists; dome not built |

Rules from the measurements:
- **Never cut `maxSteps`** below what in-layer rays need: it breaks the look. Instead, save steps where there is no cloud (empty-space skipping).
- **Never change the layer height per tier.** The popcorn and lift heights are fractions of the layer, so a thinner layer makes different clouds. To remove towers, set `giantShare` 0.

---|---|---|
| `resolutionScale` 0.67 | 155 | −51 % |
| `resolutionScale` 0.5 | 92 | −71 % |
| `lightReuseSteps` 1 (no sharing) | 349 | +10 % |
| `lightReuseSteps` 8 | 309 | −3 % |
| `aoSide` 0 | 277 | −13 % |
| `lightSteps` 4 | 280 | −12 % |
| `giantShare` 0 (12 km layer kept) | 206 | −35 % |
| `layerStepFit` 0 | 274 | −14 % (V4: −6 %) |
| `maxSteps` 160 | 279 | −12 % |
| `stepFootprint` 0.35 | 322 | ±0 (mip choice does not matter) |
| `detailErosion` 0 | 463 | +45 % (more cloud volume to light; not a cost of detail) |

V4 (10 km, looking down) was 555 ms (`giantShare` 0: 347); V2 (horizon from 3 km) 394 ms.

**After quick wins 3.1 #2 and #4** (weather reused in the light march, `T < 0.01`): V1 249, V2 301, V4 423 ms, so −22 to −24 % with no visible change.

~~After the polish fixes~~ (superseded by the corrected 1.5 above) (`heads` only inside cloud, giant rims faded by erosion, coherent coarse step grid, far detail fade): **V1 84 ms (11.7 fps), V4 157 ms (6.3 fps).**
- `resolutionScale` 0.67 at V1: 42 ms (22 fps).
- `aoSide` 0 at V1: 72 ms (−14 %).

Why the polish fixes were so large:
- The cauliflower `heads` term added density in clear air around every cloud. The detail erosion hid those blobs, but each one still triggered a surface search, fine steps and full lighting.
- So invisible work in clear air was most of the cost. That is also why the "dust" existed.

**Where this leaves us:** from about 3 fps to about 12 fps at full resolution in the lab, and about 22 fps at `resolutionScale` 0.67, with no visible loss in A/B screenshots. The game adds terrain, cirrus and the rest, so confirm there.

---

## 2. Where the time goes (code analysis)

### 2.1 Pixels

- The game canvas is CSS × 1.5. The look pick renders clouds at `resolutionScale 1.0`, so one ray per canvas pixel: about 3.5 M rays at 1550×1040 CSS.
- The previous default (0.5) was 4× fewer rays. Most of the drop from about 10–12 fps to about 3 fps is this one setting.

### 2.2 Texture fetches per sample (raymarch)

| Work | Fetches | When |
|---|---|---|
| `sampleWeather` | 4 (+1 with `shapeOffset: 'slow'`) | Every density sample |
| `cloudBaseWithWeather` | 1 shape + 1 giant shape | Every density sample |
| `cloudDetail` | 1 | Samples inside cloud |
| **Density sample total** | **about 7** | |
| Surface bisection | 5 × 2 = 10 | Each air → cloud entry |
| `lightOpticalDepth` | steps 0–2: 3 × 2, plus detail on 0–1: 2; steps 3–5 call `cloudBase` and re-sample weather: 3 × 6 | Each lit sample: **26** |
| `skyVisibility` | 2 up (4) plus 3 side (6, `aoSide`) | Each lit sample: **10** |
| LUTs (sun transmittance, 2 ambient) | 3 | Each lit sample |
| **Lit sample total** | **about 39**, plus about 30 more at night (moon) | |

**Lighting is about 5× a density sample.** It is shared every 4th sample behind the visible skin, but on the skin itself it runs every step.

### 2.3 Step counts

- `maxSteps` is 256, and the 12 km giant layer roughly doubles path lengths compared with 4–7 km.
- `layerStepFit 0.5` forces up to 128 steps through the layer for rays from above, **clear air included**. It fixed the stripes from 40 km, but at V4 it is probably the biggest step consumer.
- Horizon rays inside the layer (V2) run to the 256 budget, plus a 6-step tail.

### 2.4 Other passes

- **Cirrus volume (`webgpuCloudRenderer.js`).**
  - From about 7.2 km to 61 km altitude, the cirrus switches from a 1-sample shell to a 24-shell volume.
  - It runs up to 48 `cirrusAt` calls per pixel, about 9 fetches each (warp, 2 flow passes, 3 noise octaves, 2 breakup, LUT), at **full resolution** (`renderScale 1.0` on `high`).
  - Since the depth-order fix it is drawn in two parts, each walking all 24 shells.
  - At your 10 km screenshots this may cost as much as the cumulus. Measure it before anything else (A).
- **Composite:** 8 haze steps, a 5-tap Catmull-Rom, a 4-tap cloud shadow and a 2×2 kind-aware tap, per screen pixel. Modest.
- **Shadow map:** 256² × 24 density samples, about 1.6 M samples. Cheap compared with the raymarch.
- **3×3 tent filter:** 9 loads per cloud texel. Cheap.

---

## 3. Optimizations

Ordered by expected gain per effort. Each keeps the current look unless marked.

### 3.1 Quick wins (hours)

1. **Clouds at one texel per CSS pixel.** `resolutionScale ≈ 0.67` at the 1.5 canvas ratio is 2.25× fewer rays than 1.0. With the tent filter and stratified steps it may look the same on Retina. A/B it in screenshots first; this is the largest single lever.
2. **(Done, −22 % with #4.) Light march: reuse the primary sample's weather for all 6 light steps.**
   - Steps 3–5 currently call `cloudBase`, which re-samples the 4-fetch weather for points 0.4–3 km away. Weather varies over 90+ km, so that buys nothing.
   - Saves 12 fetches per lit sample, about 30 % of lighting. No visual change expected.
3. **Skip the giant shape fetch where there are no giants.**
   - Fetch `nG` only if the weather says this region can hold a giant.
   - That needs a cheap 2D giant-mask channel (see 3.2 #6). Before then, a coarse test such as `coverage > x`.
4. **(Done, `T < 0.01`.) Raise the termination threshold** from `T < 0.003` to about 0.01–0.02. Behind a dense skin the remaining 1 % is invisible, and dense giants march many samples past that point.
5. **Detail only near the visible skin.** Once `T < ~0.1`, use base density only. The detail of samples you cannot see costs a fetch and its remaps for nothing.
6. **Pipeline variants (override constants).**
   - Compile the raymarch without the moon branch by day, without giants when `giantShare` is 0, and without the far proxy.
   - The shader is large, so register pressure and occupancy improve.
7. **Cirrus: render the volume at half resolution.**
   - Use `renderScale 0.5` on `high` above 7 km; the cirrus is soft anyway.
   - Or cap the shells to those within about 10 km of the camera, plus the shell for the rest.
   - Measure first (it may be the hidden big cost at 10 km).

### 3.2 Medium (a day or two each)

1. **Baked local weather map: "pregenerate expensive noise".**
   - Every density sample evaluates 4–5 weather lookups plus their domain warps and rotations. Weather is height-invariant and smooth (tens of km).
   - Bake it once per frame (or every few frames: wind is slow) into a camera-centred 2D texture: e.g. 512² over about 200 km, 0.4 km texels, `rgba16float`. Channels: coverage, kind, lift, and the giant mask `coreG`. The `shift` offset goes in a second texture or packs into two channels.
   - A density sample then does 1 weather fetch instead of 4–5, and the giant mask decides whether `nG` is needed at all.
   - This is the same idea as the existing cloud shadow map (camera-centred, sun-independent). Expected saving: 30–45 % of density-sample fetches.
2. **Sun optical depth from a deep shadow map: "pregenerate lighting".**
   - The light march (6 steps, 26 fetches) is the biggest per-sample cost.
   - The shadow pass already integrates density along the sun on a 256² plane. Extend it to store optical depth at 4 depths through the layer in RGBA (a deep shadow map).
   - A lit sample then needs 1 bilinear fetch plus interpolation by its depth along the sun for the far part of the light path. Keep the first 1–2 real steps (≤ 150 m) for local self-shadowing and the crisp lit/dark edges.
   - The map is 0.6 km per texel today; raise it to 512² or shrink its extent to the near clouds.
   - Expected: lighting from about 39 to about 12 fetches. This is the "something on top of the light sample knob".
3. **Empty-space skipping from the weather map.** With the baked weather (1), store the per-column max coverage, or "any cloud within this texel's 2×2 neighbourhood". In clear columns the ray can jump to the next texel boundary instead of stepping through air. Biggest for V1, V2 and V4 (most rays are mostly air).
4. **Adaptive `layerStepFit`.** Apply the forced fine steps only where there is cloud: inside cloud, or within one coarse step of an entry. In clear air, step at the distance rate. This keeps the 40 km fix and drops most of its cost.
5. **Cheaper sky occlusion.**
   - Fold `aoSide`'s 3 base samples, and the 2 up samples, into one lookup of a coarse 3D occlusion volume.
   - Alternatively take it from the deep shadow map with the sun replaced by the zenith (a second plane).
   - Measure what `aoSide` buys at the current look first (see 4).

### 3.3 Bigger (several days)

1. **Two-resolution march.**
   - March the far field (beyond about 15–20 km, where detail is sub-pixel anyway) at half resolution in a separate dispatch.
   - March the near field at full resolution, and composite by depth with the existing kind-aware upsample.
   - Most of the screen at V2 and V4 is far field.
2. **Variable-rate tiles.** An 8×8 prepass marks tiles that are all sky or all cloud-free (from the weather map and the scene depth) or far, and those tiles are marched at quarter rate. Cloud edges and near cloud stay full rate.
3. **Noise texture bandwidth.**
   - Shape is 128³ `rgba16float` (16 MB plus mips) since the ring fix.
   - Options: keep 16-bit only for the channels the dome shape amplifies (R and the Worley used for heads), or pack them into `rg16float` and leave the rest 8-bit.
   - Only if measurement D shows bandwidth matters.
4. **World-space lighting cache.** Store lit radiance or optical depth in a camera-centred 3D clipmap that is updated a slice per frame. This is stable (no screen-space history, so no smear), but the update lags when the sun moves fast. Only if 3.2 #2 is not enough.

---

## 4. Expensive but low visual gain (cut candidates)

| Feature | Cost | Gain at the current look | Verdict |
|---|---|---|---|
| Light steps 3–5 re-sampling weather | 12 fetches per lit sample | None (weather is constant over 3 km) | **Cut** (3.1 #2) |
| Detail behind the skin | 1 fetch + remaps per hidden sample | None (not visible) | **Cut** (3.1 #5) |
| March to T = 0.003 | Many samples in dense giants | Under 1 % of the pixel | **Raise** (3.1 #4) |
| `layerStepFit` in clear air | Up to 128 steps per ray from above | None in air | **Restrict** (3.2 #4) |
| `aoSide` | 6 fetches per lit sample | Folds a little darker; heads already come from direct light | **Measure**, likely cut or bake |
| Cirrus volume at full res | Possibly the largest pass above 7 km | Soft wisps that do not need full res | **Half res** |
| Moon light march at night | +30 fetches per lit sample | Moonlit relief (needed) | Keep; use the deep shadow map |
| Full-res cloud target | 2.25× rays vs 0.67 | Little on Retina with the tent filter | **A/B, likely 0.67** |

---

## 5. Pre-generated noise: what can be baked

| Field | Today | Bake into | Valid while |
|---|---|---|---|
| Weather (coverage, kind, lift, shift) | 4–5 fetches + warps per sample | 2D camera-centred map, per frame or slower | Wind moves the pattern; re-bake every frame (cheap: 512² × 5 fetches) or scroll |
| Giant mask (`coreG`) | 1 3D fetch per sample | Same 2D map (one channel) | Same |
| Sun optical depth | 26 fetches per lit sample | Deep shadow map (4 depths), per frame | Sun moves slowly; can update every 2–4 frames |
| Sky occlusion | 10 fetches per lit sample | Coarse 3D occlusion volume or a zenith deep shadow map | Every few frames |
| Shape and detail noise | Already 3D textures | — | — |
| Per-pixel cloud start (first possible hit) | Implicit in empty-air marching | From the weather map's max coverage | Per frame |

Not worth baking: the shape and detail noise themselves (already textures), and the transmittance and ambient LUTs (already LUTs).

---

## 6. Suggested order

1. **Measure** section 1.4 A and B in V1–V4. The cirrus and `resolutionScale` numbers decide the first steps. *(Lab part done, section 1.5; still to measure: cirrus and the full frame in the game.)*
2. **3.1 #1–#5** (quick wins). Re-measure, and screenshot-compare V1–V6.
3. **3.2 #1** (weather map), then **3.2 #3** (empty-space skipping on top of it).
4. **3.2 #2** (deep shadow map lighting).
5. Re-evaluate: if fps is still too low, **3.3 #1** (two-resolution march).

A target to aim for: 30 fps at 1.5× on the MacBook from the ground (V1), and 20 fps from above (V4). Most of the gap should close with steps 1–3.

---

## 7. In-game tier switch (2026-11-20)

Shift+P in `wizard_game/standalone.html` cycles: game settings, ULTRA, HIGH, MEDIUM (draft), LOW (volumetric clouds off, cirrus only). The presets are `CLOUD_SHAPE_MODES` and `LOOK_PICK` there. Screenshots: `screenshots/cloud_look_2026-11-20/` 21–23.

Next steps, by measured value:
1. **Game frame times per tier, with cirrus on and off.** The cirrus volume above 7 km is still unmeasured.
2. **Baked weather map plus empty-space skipping** (3.2 #1, #3). This is what medium needs for 5–8 ms everywhere, and it helps V4 in every tier.
3. **Deep shadow map** (3.2 #2). It takes most of the remaining 25–30 % lighting cost in every tier.
4. **Low tier:** a "shell only" switch for the cirrus renderer.

---

## 8. Cross-cutting optimizations done (all tiers, 2026-11-20)

These are **directional** results: one interleaved A/B per view (`P.ab`, half res, 0.65 M rays, look-pick settings). The ratio is the raymarch time with the change switched off, relative to with it on.

| Change | Setting (default) | V1 ground | V4 above | Visual | Status |
|---|---|---|---|---|---|
| Light march reuses the primary sample's weather in all 6 steps; rays stop at `T < 0.01` | Built in (profiling switch `_profileOldLight` restores the old) | Off = 1.22 (**−18 %**) | — | None | **On** |
| `heads` only inside existing cloud | Built in (`_profileOldHeads`) | Off = 1.07 (**−6 %**) | — | Removes dust | **On** |
| Weather re-sampled along a ray only every 0.3 km, or when the footprint doubles | `weatherReuseKm` 0.3 (0 = every sample) | Off = 1.20 (**−17 %**) | Off = 1.16 (**−14 %**) | None seen (game screenshot 24, ultra) | **On** |
| Detail noise skipped once T < 0.1 | `detailMinTransmittance` (0 = never) | Off = 1.03 (−3 %) | Off = 0.92 (**+8 % slower**) | Behind the skin only | **Off by default** |

Why the detail skip lost from above: uneroded base density fills the holes the erosion carved, so more samples behind the skin carry density and get lit. Lighting costs more than the detail fetch it saved. It would only pay off if lighting were also skipped or shared there; try again once the deep shadow map makes lighting cheap.

**Combined, against the start of this round:** about −35 % raymarch at V1 (1.22 × 1.07 × 1.20 ≈ 1.57× before, so 0.64× now), and about −14 % or more at V4 (the light-march switch was not measured there separately). These multiply into every tier, because they are per-sample savings independent of resolution, giants or step settings.

**For the next agent**
- Use `P.ab` in `.claude/tmp/labProfile.js` (interleaved baselines; ratios only).
- Add every new setting to `P.base`, or it sticks for the following runs.
- Absolute ms move up to 2× with the GPU clock.
- Next per-sample candidates, in order:
  1. Giant fetch only where the weather allows giants (needs the baked weather map's giant-mask channel).
  2. Deep shadow map for the far light steps.
  3. Detail skip retried once lighting behind the skin is cheap.

---

## 9. General optimization pass (2026-11-20)

Compared against `787e912` on a 16-core Apple M1 Pro on AC power, Chrome 157 with WebGPU on Metal. The browser rendered both revisions at the same viewport, sun position, camera path, and weather phase. This pass kept the authored Ultra, High, Medium, and Low settings. It retained the existing maximum step counts, shape and detail volumes, cloud layer heights, giant towers, light steps, and sky occlusion.

### Changes

- The spatially filtered cumulus path now shades a checkerboard or one ray per 2×2 or 3×3 block. The renderer chooses the largest square grid with a nominal angular spacing at most 0.00325 radians, up to 3×3. The spatial pass reconstructs colour and signed cloud depth at the original target size. Terrain and sky taps are filtered by the current pixel's scene-depth class. Raw samples, temporal accumulation, the step heatmap, and the distant orbital proxy use their original sampling modes.
- Dedicated shader variants remove the unused shell-proxy or march path outside the crossfade and specialize the cut, dome and giant shapes. Full-resolution scene depth takes one fetch. Terrain-occluded rays and explicitly clear weather can finish early. Fully averaged, distant samples use the existing mean density directly when individual local height is irrelevant.
- The atmosphere bake also produces the direct cloud-light LUT. It evaluates the dusk tint and brightness compensation once per atmosphere change. The ground shadow map reuses valid data when the sun, field and projection plane are static and skips the pass below the shadow horizon. A full-size cloud composite reads the centre texel directly. At smaller sizes it loads colour for the blend across terrain silhouettes only where the depth classes disagree.
- The cirrus volume keeps all 24 radial shells and the existing depth ordering at half linear resolution. It reuses radial intersections between shells and clips to the requested half of the ray before sampling. The shell uses the existing preset resolution. The Low preset's tent uses four equivalent bilinear taps. The offscreen pass preserves the scene depth and avoids reallocating the canvas depth texture as its viewport changes. Noise generation only interrupts the frame when it has work.

### Measurement and review method

The [benchmark runner](tools/perf/cloudBenchmark.mjs) alternates before/after, then after/before, with one tab drawing at a time. The main lab matrix uses a 1536×960 canvas (1024×640 CSS at 1.5×), eight warm-up frames and 16 sampled frames per run. Static views freeze wind, boiling and weather evolution. The scripted flight translates, climbs and turns while moving the cloud field. The direct raymarch timestamps are the primary measure. Total GPU spans can vary with GPU scheduling, and end-to-end game FPS also includes terrain and CPU work.

Screenshots come from Chrome after the same warm-up and sample count. Pixel differences use the largest absolute RGB channel difference at each pixel on an 8-bit scale. The image sheets show baseline, optimized, and the difference amplified 8×. Terrain streaming and stars can differ slightly between game runs, so the lab comparisons are the reference for cloud-edge differences.

To rerun, serve a clean checkout of `787e912` and the working tree on separate ports. Install this repository's development dependencies, then run:

```sh
node tools/perf/cloudBenchmark.mjs http://127.0.0.1:8765 http://127.0.0.1:8766 /tmp/cloud-ab
CLOUD_BENCH_GAME=1 node tools/perf/cloudBenchmark.mjs http://127.0.0.1:8765 http://127.0.0.1:8766 /tmp/cloud-game-ab
```

`CLOUD_BENCH_CASES` selects names by regular expression. `CLOUD_BENCH_TIER=high` or `medium` uses the corresponding look-pick preset. `CLOUD_BENCH_SCALE`, `CLOUD_BENCH_WIDTH` and `CLOUD_BENCH_HEIGHT` control the cloud scale and CSS viewport. `CLOUD_BENCH_CHECKER=0` renders the optimized shaders with every ray for a direct comparison. `CLOUD_BENCH_CHECKER=1` limits spatial sampling to the checkerboard. `CLOUD_BENCH_HEADFUL=1` opens Chrome on the desktop. `CLOUD_BENCH_FLIGHT_FRAMES` captures additional frames of the flight.

### Experiments and decisions

| Experiment | Result | Decision |
|---|---|---|
| March 2×2 anchors, then march every disagreeing pixel | Half-scale lab total 38.1 → 40.1 ms on the ground and 71.7 → 81.7 ms above. Refinement left sparse active lanes in expensive workgroups. | Removed |
| Hoist the ray lighting coefficients and split density math behind more early-outs | Half-scale total 38.4 → 40.4 ms on the ground and 71.3 → 77.8 ms above. | Removed |
| Bake nearby mip-zero weather into two 512×512 textures over 48 km | Raymarch 25.9 → 24.2 ms on the ground and 51.5 → 49.3 ms above, but 9.9 → 10.3 ms in stratus. Dusk shifted enough outline pixels to put 4.7% of the image above five RGB levels even against the already optimized renderer. | Removed |
| 8×4 vs. 8×8 workgroups | 8×8 was 2–3% faster for towers and faster for popcorn on this GPU. 8×4 was faster for stratus and dense cut decks. | Use the measured shape-specific sizes |
| Lower the internal target to 0.707× and also shade the checkerboard | About 4.7× faster raymarch on the ground and above. It slightly softened edges and changed the target's sampling grid. | Use a 2×2 spatial ray grid and reconstruct to the full target instead |

### Lab results

At 1536×960, the Ultra target reconstructed from 2×2 blocks. The raymarch was **4.0–5.4× faster** across the lit volumetric shapes and **4.7× faster** on the moving dusk path. At 2100×1230, 3×3 blocks brought the five matched ground and above-cloud views to **9.6–10.0× faster**. The raw-ray check isolated a **1.4–1.7×** improvement from the shader and pass changes with the original ray grid. Its 99th-percentile image differences were at most one RGB level.

#### Ultra at 1536×960

Each row averages the two runs on each side. The raymarch column is a direct pass timestamp. GPU frame time includes the lab's own atmosphere and composite. RGB values are the p95 and p99 display differences.

| View | Raymarch GPU ms | Raymarch speedup | GPU frame ms | Completed FPS | RGB p95 / p99 |
|---|---:|---:|---:|---:|---:|
| Ground day | 116.3 → 25.5 | 4.57× | 133.1 → 29.7 | 8.4 → 35.7 | 5 / 12 |
| Ground dawn | 115.9 → 25.4 | 4.56× | 131.1 → 29.6 | 8.4 → 35.7 | 6 / 22 |
| Ground dusk | 115.8 → 25.4 | 4.57× | 130.6 → 31.8 | 8.4 → 35.8 | 4 / 11 |
| Ground night | 116.6 → 25.2 | 4.62× | 136.6 → 28.4 | 8.4 → 36.2 | 3 / 8 |
| Ground moonless | 88.3 → 19.0 | 4.65× | 96.8 → 21.8 | 11.0 → 45.0 | 0 / 0 |
| Horizon day | 145.1 → 31.6 | 4.59× | 168.7 → 35.2 | 6.8 → 29.2 | 5 / 12 |
| Inside day | 213.7 → 45.0 | 4.75× | 256.9 → 52.2 | 4.6 → 21.0 | 3 / 10 |
| Inside night | 214.6 → 44.5 | 4.82× | 249.4 → 48.3 | 4.6 → 21.3 | 1 / 4 |
| Above day | 232.8 → 48.9 | 4.76× | 279.8 → 53.6 | 4.2 → 19.2 | 4 / 9 |
| Above dawn | 233.2 → 49.2 | 4.74× | 280.5 → 55.5 | 4.2 → 19.1 | 5 / 12 |
| Above dusk | 231.9 → 48.9 | 4.75× | 259.9 → 55.4 | 4.2 → 19.2 | 4 / 10 |
| Above night | 235.8 → 48.8 | 4.83× | 274.1 → 57.3 | 4.2 → 19.3 | 1 / 4 |
| Popcorn day | 58.6 → 11.5 | 5.11× | 63.3 → 13.8 | 16.2 → 58.2 | 5 / 11 |
| Popcorn dawn | 58.7 → 11.5 | 5.13× | 70.1 → 13.8 | 16.3 → 60.3 | 6 / 22 |
| Popcorn dusk | 117.5 → 22.4 | 5.24× | 137.5 → 28.0 | 8.3 → 39.1 | 3 / 10 |
| Popcorn night | 58.9 → 11.6 | 5.08× | 63.4 → 13.8 | 16.3 → 59.7 | 2 / 7 |
| Stratus day | 52.6 → 10.5 | 5.00× | 65.2 → 12.9 | 18.1 → 60.1 | 4 / 9 |
| Stratus dawn | 52.8 → 10.5 | 5.02× | 63.2 → 12.9 | 18.0 → 60.3 | 7 / 21 |
| Stratus dusk | 52.4 → 10.5 | 5.01× | 54.9 → 12.8 | 18.1 → 59.6 | 3 / 8 |
| Stratus night | 52.7 → 10.9 | 4.85× | 60.5 → 13.1 | 18.1 → 59.8 | 2 / 5 |
| Stratocumulus day | 145.3 → 27.1 | 5.36× | 170.2 → 31.9 | 6.7 → 33.0 | 2 / 3 |
| Stratocumulus dawn | 145.4 → 27.2 | 5.34× | 172.1 → 31.2 | 6.7 → 32.9 | 2 / 3 |
| Stratocumulus dusk | 67.2 → 13.5 | 4.99× | 79.6 → 15.9 | 14.3 → 58.1 | 2 / 5 |
| Stratocumulus night | 70.8 → 14.8 | 4.79× | 75.7 → 17.1 | 13.6 → 57.3 | 1 / 2 |
| Nimbostratus day | 36.5 → 8.4 | 4.33× | 42.9 → 11.4 | 25.4 → 59.8 | 2 / 3 |
| Nimbostratus dawn | 36.3 → 8.7 | 4.19× | 44.1 → 11.4 | 25.6 → 59.6 | 2 / 4 |
| Nimbostratus dusk | 35.9 → 8.7 | 4.13× | 42.5 → 11.6 | 25.8 → 59.9 | 2 / 5 |
| Nimbostratus night | 36.6 → 9.1 | 4.04× | 44.2 → 11.7 | 25.4 → 59.7 | 1 / 1 |
| Storm day | 297.5 → 61.0 | 4.88× | 369.7 → 66.0 | 3.3 → 15.6 | 4 / 9 |
| Storm dawn | 297.5 → 61.0 | 4.88× | 345.1 → 66.0 | 3.3 → 15.6 | 3 / 7 |
| Storm dusk | 297.5 → 60.9 | 4.89× | 332.0 → 73.0 | 3.3 → 15.6 | 4 / 9 |
| Storm night | 301.1 → 60.6 | 4.97× | 340.5 → 67.5 | 3.3 → 15.7 | 1 / 3 |
| Ground proxy | 19.7 → 6.9 | 2.83× | 22.9 → 10.1 | 44.4 → 60.5 | 6 / 15 |
| Orbit proxy | 4.3 → 3.5 | 1.22× | 7.7 → 6.6 | 61.3 → 60.0 | 1 / 1 |
| Temporal day | 38.4 → 27.1 | 1.42× | 42.7 → 31.7 | 24.1 → 33.5 | 1 / 1 |
| Flight dusk | 207.5 → 43.8 | 4.73× | 243.5 → 51.4 | 4.7 → 21.4 | 2 / 8 |
| Clear day | 45.9 → 0.1 | 336.53× | 54.2 → 7.1 | 20.3 → 59.8 | 2 / 2 |

[Raw Ultra measurements](tools/perf/cloud-results/2026-11-20/lab-ultra.json), [lighting A/B](tools/perf/cloud-results/2026-11-20/lab-lighting.jpg), [cloud-type A/B](tools/perf/cloud-results/2026-11-20/lab-cloud-types.jpg), [2× detail crops](tools/perf/cloud-results/2026-11-20/lab-crops.jpg).

#### Ultra at 2100×1230

| View | Raymarch GPU ms | Raymarch speedup | GPU frame ms | Completed FPS | RGB p95 / p99 |
|---|---:|---:|---:|---:|---:|
| Ground day | 195.1 → 20.3 | 9.63× | 228.3 → 24.2 | 5.0 → 40.5 | 6 / 16 |
| Ground dawn | 194.9 → 20.1 | 9.67× | 217.2 → 25.1 | 5.0 → 41.1 | 7 / 29 |
| Above day | 397.3 → 40.0 | 9.93× | 461.2 → 45.0 | 2.5 → 22.1 | 4 / 11 |
| Above dusk | 393.3 → 39.9 | 9.85× | 434.6 → 49.1 | 2.5 → 22.1 | 5 / 13 |
| Above night | 402.1 → 40.8 | 9.87× | 444.2 → 49.5 | 2.5 → 21.9 | 2 / 5 |

[Raw 2100×1230 measurements](tools/perf/cloud-results/2026-11-20/lab-native.json), [full-frame A/B](tools/perf/cloud-results/2026-11-20/native.jpg), [2× detail crops](tools/perf/cloud-results/2026-11-20/native-crops.jpg).

#### High, Medium and original ray-grid controls

High and Medium use their authored 0.67× and 0.33× cloud targets on the same 1536×960 canvas. The original-ray-grid control uses the Ultra look at 0.5× with spatial ray reduction disabled on the optimized side.

| Preset | View | Raymarch GPU ms | Raymarch speedup | GPU frame ms | Completed FPS | RGB p95 / p99 |
|---|---|---:|---:|---:|---:|---:|
| High | Ground day | 49.1 → 19.3 | 2.55× | 56.3 → 22.0 | 19.3 → 44.8 | 3 / 6 |
| High | Ground dawn | 49.4 → 19.1 | 2.58× | 56.4 → 21.3 | 19.2 → 46.4 | 4 / 11 |
| High | Above dusk | 93.0 → 37.4 | 2.49× | 101.7 → 42.5 | 10.4 → 24.7 | 2 / 5 |
| High | Above night | 94.8 → 37.6 | 2.52× | 103.5 → 41.4 | 10.2 → 24.7 | 1 / 2 |
| Medium | Ground day | 9.4 → 6.2 | 1.50× | 11.8 → 10.6 | 58.8 → 59.9 | 3 / 9 |
| Medium | Ground dawn | 8.7 → 5.4 | 1.60× | 10.9 → 9.3 | 60.1 → 60.3 | 6 / 19 |
| Medium | Above dusk | 16.5 → 6.8 | 2.43× | 19.8 → 9.8 | 51.2 → 60.0 | 3 / 8 |
| Medium | Above night | 16.9 → 6.7 | 2.52× | 20.0 → 9.4 | 49.4 → 59.8 | 1 / 3 |
| Original grid | Ground day | 35.7 → 24.0 | 1.49× | 41.9 → 26.9 | 26.1 → 38.1 | 0 / 0 |
| Original grid | Ground dawn | 35.7 → 24.2 | 1.48× | 39.1 → 28.4 | 26.2 → 37.9 | 0 / 1 |
| Original grid | Above day | 68.4 → 48.0 | 1.43× | 75.8 → 55.3 | 14.0 → 19.6 | 0 / 0 |
| Original grid | Above dusk | 67.8 → 47.8 | 1.42× | 79.8 → 56.7 | 14.1 → 19.7 | 0 / 1 |
| Original grid | Above night | 70.2 → 49.2 | 1.43× | 77.9 → 54.8 | 13.6 → 19.2 | 0 / 0 |
| Original grid | Stratus day | 16.1 → 9.6 | 1.68× | 18.4 → 11.6 | 53.6 → 59.9 | 0 / 0 |

[High measurements](tools/perf/cloud-results/2026-11-20/lab-high.json), [Medium measurements](tools/perf/cloud-results/2026-11-20/lab-medium.json), [Original grid measurements](tools/perf/cloud-results/2026-11-20/lab-full-rays.json), [tier A/B](tools/perf/cloud-results/2026-11-20/tiers.jpg).

#### Visual review

The most visible differences were thin, backlit rims, small isolated wisps, and a few distant frayed edges. At 2×, the larger block grid softens some rims and shifts the internal detail of a few small patches. The larger formations, internal folds, dusk colour and moonlit relief read the same in the full frames. Dawn is the hardest comparison. At 2100×1230 its ground frame reached p95 7 and p99 29 RGB levels. The above-cloud dusk view reached 5 and 13. The moonless control in the lab is fully dark, so moonlit rows carry the useful night-quality comparison.

### Game results

The production HDR composite, terrain and cirrus were active here. The 1536×960 game camera has a 75° field of view. The final angular limit selected 2×2 blocks throughout this matrix. The earlier checkerboard run is included in the cirrus file. These are completed frame rates, which include terrain streaming, browser cadence and CPU work.

| Ultra view | Raymarch GPU ms | Raymarch speedup | Completed FPS |
|---|---:|---:|---:|
| Ground day | 56.7 → 12.0 | 4.73× | 13.8 → 32.2 |
| Ground dawn | 53.1 → 11.9 | 4.46× | 13.8 → 31.2 |
| Ground dusk | 51.6 → 11.8 | 4.39× | 15.4 → 29.3 |
| Ground night | 51.7 → 10.9 | 4.75× | 16.4 → 30.2 |
| Above day | 147.0 → 31.1 | 4.73× | 6.4 → 26.6 |
| Above dusk | 144.7 → 30.6 | 4.73× | 6.5 → 27.0 |
| Above night | 148.1 → 30.7 | 4.82× | 6.3 → 26.9 |

[Raw game measurements](tools/perf/cloud-results/2026-11-20/game-ultra.json), [game A/B](tools/perf/cloud-results/2026-11-20/game.jpg). The game sheet uses a separate ground-day capture with 110 warm-up frames so the terrain could settle. That run measured 14.4 → 34.3 completed FPS and p95 3 / p99 14 RGB levels. [Ground-day settling run](tools/perf/cloud-results/2026-11-20/game-ground-settled.json).

#### Cirrus volume in the game

The lower and mid legacy deck flags were at their game defaults. The captures cover the cirrus surface from ground and orbit, the volume from below, inside and above, the low, medium, high and ultra cirrus shaders, and separately authored cirrocumulus and cirrostratus profiles. The isolated draw timings submit the renderer's real far and near passes and wait for the GPU before the next sample. GPU spans reflect tile-pass overlap. Submit-to-complete time includes the small overhead of preparing and submitting the isolated draw.

| View | Isolated GPU span (ms) | Submit to complete (ms) | RGB p95 / p99 |
|---|---:|---:|---:|
| Below dawn | 6.01 → 2.47 | 6.85 → 3.26 | 1 / 1 |
| Volume day | 5.87 → 2.29 | 6.75 → 3.18 | 1 / 2 |
| Volume low | 3.05 → 2.67 | 4.10 → 3.57 | 0 / 1 |
| Volume medium | 5.79 → 2.25 | 6.56 → 3.14 | 1 / 1 |
| Volume ultra | 6.08 → 2.11 | 6.87 → 2.96 | 1 / 2 |
| Volume dusk | 5.92 → 2.09 | 6.74 → 2.88 | 1 / 1 |
| Volume night | 5.94 → 1.94 | 6.78 → 2.69 | 0 / 1 |
| Above day | 4.90 → 1.91 | 5.71 → 2.69 | 1 / 2 |
| Cirrocumulus day | 6.50 → 2.74 | 7.40 → 3.64 | 0 / 1 |
| Cirrostratus dusk | 6.33 → 2.23 | 7.26 → 3.04 | 1 / 2 |

The half-resolution volume is slightly softer along the bright limb. The radial extent and near/far ordering match in the below-layer, through-layer and above-layer captures. The no-cirrus control was p99 0. [Raw cirrus data and 75° checkerboard control](tools/perf/cloud-results/2026-11-20/game-cirrus-and-checker.json), [cirrus A/B](tools/perf/cloud-results/2026-11-20/cirrus.jpg).

#### Cirrus surface shader

The shell uses its own shader variant outside the volume transition. The settled daytime draw fell from about 0.39 to 0.31 ms of GPU time. The direct pass timestamps are more stable in these light scenes than GPU frame markers and queue waits. Raw data retains all three measures. [Surface lighting matrix](tools/perf/cloud-results/2026-11-20/game-cirrus-shell.json), [settled daytime control](tools/perf/cloud-results/2026-11-20/game-cirrus-shell-settled.json).

| View | Far shell draw (ms) | Near shell draw (ms) | RGB p95 / p99 |
|---|---:|---:|---:|
| Shell day | 0.39 → 0.31 | 0.00 → 0.00 | 0 / 2 |
| Shell dawn | 0.38 → 0.58 | 0.00 → 0.00 | 0 / 0 |
| Shell dusk | 0.80 → 0.56 | 0.00 → 0.00 | 0 / 0 |
| Shell night | 0.90 → 0.65 | 0.00 → 0.00 | 0 / 0 |
| Orbit day | 0.29 → 0.24 | 0.70 → 0.55 | 0 / 0 |

### Flight and verification

The headed Chrome flight check used an odd-sized 1539×963 target. Four paired images show the moving dusk scene at the reference frame and 3, 9 and 15 frames later. The camera and cloud movement matched in the captures, including the distant red rims and the blue shadowed edges. The first image pair measured p95 2 and p99 8. [Flight A/B sequence](tools/perf/cloud-results/2026-11-20/flight.jpg), [flight timings](tools/perf/cloud-results/2026-11-20/lab-flight.json).

All 642 tests passed with a 20-second test timeout and the TypeScript checks passed. The first default-timeout run reached the five-second cap in the unrelated river-bank prototype test.

Raw exploratory measurements are available for the [adaptive anchor pass](tools/perf/cloud-results/2026-11-20/experiment-adaptive.json), [lighting and density refactor](tools/perf/cloud-results/2026-11-20/experiment-exact.json), [weather texture](tools/perf/cloud-results/2026-11-20/experiment-weather.json), [workgroup sizes](tools/perf/cloud-results/2026-11-20/experiment-groups.json) and [0.707× target probe](tools/perf/cloud-results/2026-11-20/experiment-quarter-probe.json).

---

## 10. Puffier, wispier look (2026-11-20, after section 9)

**First attempt, a mistake:** an "edge feather" with softer settings only blurred the outline. The user saw it as more blurry and less detailed but just as solid. That comparison used shots from different sessions, so it was not like for like. The feather is removed.

**Why the clouds look solid:**
- At cumulus extinction (40–50 per km), a ray grazing even the outer 20 m of a 1 km cloud is already opaque, so the translucent fringe is only metres wide.
- With a sharp edge ramp, the detail erosion only touches a thin shell, so the surface has no deep billows.
- Translucent fringes need lower extinction and a wider ramp. Puffiness needs full erosion carving into that wider ramp, plus sharper detail.
- Both move the visible outline inward, so the size has to be given back with coverage.

**New settings:**
- `edgeWisps` (look4.w): the outer shell is eroded with the wispy fbm instead of round billows.
- `coverageGain`: a multiplier on the weather's coverage (also in the shadow-map cache key).

**Variants, compared on frozen clouds in one game session** (Shift+F in the game; screenshots 25–27 are 2× crops against A):

| Variant | Settings | Look |
|---|---|---|
| A (previous) | sharpness 1.5, ext 50, erosion 0.75, detail px 2, step fp 1.0 | Crisp, solid bodies |
| E | 0.8, ext 20, erosion 0.95, wisps 1, detail px 0.75, step fp 0.5, cov ×1.6 | Very translucent and wispy, but a flat grey body |
| G | 1.1, ext 30, erosion 0.9, wisps 1, 0.75, 0.5, cov ×1.4 | Mass kept, translucent fringes |
| H (previous default) | 0.9, ext 32, erosion 1.0, wisps 0.4, heads 1.5, detail px 0.5, step fp 0.5, cov ×1.45 | Puffiest: small clouds become cauliflower; large bodies still fairly uniform grey |

**Cost** (directional, `P.ab` at half res in the lab):
- G is +35 % at V1 and +18 % at V4.
- Without the coverage gain, G costs **0.99×**. The extra coverage is the entire cost; the look changes are free.
- Sharper detail adds about 5 %.
- The cheap way to fill the sky would be bigger clouds, not more of them. Not tried yet.

**Honest gap to the HZD reference:** in large bodies, the reference's bright sunlit puffs against blue-grey shaded ones (strong contrast between billows) is still missing. That is the lighting: the self-shadowing between billows and blue sky ambient in the folds. It is not the density.

## 11. Grouped cumulus visual pass

The supplied Horizon screenshots favor broad cumulus masses separated by clear sky, with small wisps around the edges. The puffy H look scattered many similarly sized low domes between the larger forms. Claude's later interior-density experiment showed that aggressive thinning also fragments the good bodies, so the grouped look starts with the same extinction and keeps H's interior density.

The cumulus shader raises the density threshold for fine peaks whose surrounding shape field is weak. It reads the existing 3D shape volume at a fixed coarse mip, about 1.4 km per texel for the 8 km shape tile. The fade also applies to the outer margins of tall towers and leaves their broad cores on the original profile. The fine shape and detail still supply the edges. The same density feeds direct-light occlusion, the proxies and ground shadows. This setting applies to domed cumulus and defaults to zero in the shared module.

In the game, Shift+P selects the tuned Ultra, High and Medium presets. They use the grouped look at 0.5 suppression and the slow planet-scale shape offset used in the user's comparison. Shift+F still cycles through the previous H, G, E and A looks for a live comparison. The selected look uses slightly more wispy fringe erosion and reduced round head strength, with modestly brighter bounced light and less powder darkening. The existing sampling, history and reconstruction settings are the same in the comparison.

### Frozen game comparison

One Chrome WebGPU session, full-size 1575×975 Ultra cloud target, same camera, weather seed and sun or moon for each pair. Coverage was pinned at 0.28 before the look gain, wind and evolution were frozen, cirrus was disabled to expose the cumulus, and the moonlit case used the bright night look. The ground examples use the shell proxy. The flight examples use the raymarch at 4.85 km and the above-layer example looks down from 11 km. [Daylight A/B](screenshots/cloud_look_2026-11-20/28_grouped_cumulus_day.jpg), [dawn, dusk and moonlight A/B](screenshots/cloud_look_2026-11-20/28_grouped_cumulus_low-light.jpg).

The component count comes from the 8-connected opacity mask at 25% opacity. Small islands are 10–614 pixels at this target size. It is a screen-space measure, so overlapping clouds count together and opening gaps can split a large component. GPU timings are short, single-order samples from the capture session. A small change in cloud visibility can expose more of the expensive cloud behind it. These readings are kept for the next performance pass.

| Scene | Small islands H → grouped | Frame area at ≥25% opacity H → grouped | Cloud pass ms H → grouped |
|---|---:|---:|---:|
| Ground day | 72 → 30 | 22.7% → 16.2% | 9.3 → 14.6 |
| Flight day | 31 → 31 | 19.6% → 14.8% | 97.7 → 126.3 |
| Above layer day | 18 → 0 | 19.5% → 18.1% | 110.3 → 114.7 |
| Ground dawn | 22 → 8 | 8.8% → 6.2% | 10.1 → 7.4 |
| Flight dusk | 33 → 34 | 19.6% → 14.7% | 99.9 → 113.8 |
| Flight moonlight | 26 → 40 | 19.5% → 14.6% | 95.7 → 110.9 |

From the ground and above the layer, the mask confirms fewer detached puffs. In flight, the near layer breaks into larger visible groups, exposing portions of the farther layer. The night image still has some small fragments between those groups. A weak threshold and filtering the tower margins alone barely touched the scatter. Changing the shape tile from 8 to 11 km moved the major clouds, and higher suppression could empty too much sky. Stronger bounce lighting flattened shaded faces, so the preset uses a smaller lighting adjustment.

The white average-density band is still visible from above when looking along the layer. Reducing its density to 0.018 had little effect in that composition, and zero visibly removed a strip of distant cloud. The selected look uses 0.1 with the existing distance blend. The shell proxy can still show horizontal sampling lines from below, especially at dawn. Both features are visible in the saved pairs.

### Camera motion

The game rendered 17 matched frames per side at 1425×885 for a 0.07°/frame pan from the ground at dawn, a 0.07°/frame turn in daylight flight, a 1.5°/frame turn in daylight flight, and a translating dusk climb at 75 m/frame and 0.85°/frame. I reviewed the paired frames, including the same large edges during the slow and fast turns. I saw no new blur or flicker in those sequences. Rotation-corrected max-channel RGB residuals below include the reconstructed sky and some foreground. The dusk climb was compared visually because translation changes the view through the cloud volume.

| Rotation | p95 H → grouped | p99 H → grouped | Pixels with residual >4 |
|---|---:|---:|---:|
| Slow, ground dawn | 1 → 1 | 2 → 2 | 0.36% → 0.27% |
| Slow, flight day | 1 → 1 | 6 → 6 | 1.46% → 1.46% |
| Fast, flight day | 1 → 1 | 8 → 8 | 1.81% → 1.85% |

Chrome also verified the look and tier controls, including switching back to the game's original settings. All 642 tests and TypeScript checks passed.

## 12. Cloud lighting on the E look

The 2015 Guerrilla slides separate direct solar color, height-weighted sky fill, and atmospheric attenuation over distance. They also use directional scattering for backlit rims. Our atmosphere already attenuates clouds by depth. The tuned clouds looked too grey where the weak local sky and direct terms were both dim, and the former sunset preset drove the direct term strongly red. [Guerrilla's presentation, slides 52–69 and 88](https://www.guerrilla-games.com/read/the-real-time-volumetric-cloudscapes-of-horizon-zero-dawn).

The game now uses a slightly warm direct sun boost (1.42 gain, reduced near the forward-scattering peak) and a cool sky fill (0.05 radiance per unit sun illuminance). The fill increases with cloud height and uses the existing occlusion, which preserves shaded relief. Both fade near the terminator. The tuned tiers use sunset depth 7 and dusk fill 1.18 for peach highlights at low sun. Shift+N still exposes the previous redder depth-10 preset. This pass changes radiance only. It uses the existing density and light samples on both cloud paths. The cloud lab has both daylight controls. [Full-sky proposal](CLOUD_QUALITY_ANALYSIS.md#full-sky-cloudscape-proposal).

### Browser comparison

Chrome WebGPU, same camera and frozen E weather within each pair at 1590×960 Ultra with cirrus enabled. The matched-pixel statistic uses the upper 73% of the frame and selects pixels with at least 70% cumulus opacity in both captures. Luma is display-space RGB weighted by Rec.709 coefficients, on a 0–255 scale. These GPU readings are five-frame samples in fixed order with other desktop workloads present, suitable only as capture conditions.

| View | Median cloud luma before → after | 90th percentile cloud luma before → after | Cloud pass ms before → after |
|---|---:|---:|---:|
| From below, daylight | 142 → 166 | 156 → 179 | 400 → 358 |
| Cloud-layer edge, daylight | 153 → 176 | 171 → 190 | 210 → 196 |
| Ground proxy, daylight | 182 → 195 | 191 → 206 | 18.1 → 15.5 |
| Above the layer, daylight | 184 → 210 | 203 → 226 | 128 → 134 |
| Dawn with backlighting | 197 → 208 | 217 → 223 | 134 → 135 |
| Cloud-layer edge, dusk | 52 → 64 | 83 → 100 | 197 → 184 |
| Flight, late dusk | 46 → 59 | 188 → 200 | 176 → 141 |
| Flight, moonlight | 28 → 28 | 41 → 41 | 143 → 128 |

A brighter fill and stronger multiple scattering flattened some shaded faces. The chosen balance retains contrast around the billows and gives the fringes more light. Near-facing undersides still read relatively grey, and the distant grazing band remains. [Daylight crops](screenshots/cloud_look_2026-11-20/29_cumulus_lighting_day.jpg), [dawn, dusk and moonlight crops](screenshots/cloud_look_2026-11-20/29_cumulus_lighting_twilight.jpg).

Readback with camera, volume and scene depth locked produced byte-identical 8-bit opacity in daylight raymarch, ground proxy, dusk and moonlight. The 14-frame slow and fast turns each retained p99 1 in rotation-compensated RGB residual. I reviewed the dusk climb frames and saw no additional blur or shimmer. The High tier was also checked with E in two daylight views and at dusk. All 642 tests and the TypeScript checks passed.
