# Volumetric clouds: performance plan

2026-11-20, branch `volumetric-clouds`.

**Baseline:** the Shift+P look pick runs at 2.5–3.5 fps in the game (user's screenshots, MacBook, 1.5× canvas pixel ratio, cloud target at full canvas resolution). The look is now right, so this plan is about getting the speed back without losing it.

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
