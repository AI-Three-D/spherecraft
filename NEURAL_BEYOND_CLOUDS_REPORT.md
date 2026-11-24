# Where else a small neural network would pay off

2026-11-24. M1 Pro, Chrome WebGPU (Metal), 2592×1350. Figures marked *measured* were taken today or in the cloud work; the rest are estimates and say so. No engine code was changed for this.

## Answer

Yes, in three places, and all of them work the way the clouds do: a slow, correct simulation teaches a tiny network whose result is **cached per texel, not evaluated per screen pixel**.

1. **Terrain lighting** (sky light, bounced light and cloud light on the ground). The biggest visual gap today, almost free to run. Most of it needs good conventional data first; the network fills in what formulas get wrong. **Start here.**
2. **Terrain detail shape** (erosion). A network that has learned from a real erosion simulation could give landforms that noise cannot, at a fraction of today's cost per point. Highest reward, highest risk.
3. **Forests seen from afar**, once trees are switched on. How a whole canopy reflects light is a problem with no good formula.

**Texturing is not a good fit on this hardware.** Drawing materials with a network per pixel costs more than it saves, and the problems there (seams, level changes, repetition) are better solved by baking.

## What the clouds taught

- **Teacher first.** The networks worked because a path tracer over the game's own density gave correct answers to copy. Without a teacher there is only taste.
- **Fix the formula first.** In the clouds the cheapest large win was conventional (multiplying by the shadow map the game already had). Networks then won only where the formula is structurally wrong.
- **Small and cached.** Networks 8 to 16 wide were enough; 32 wide was never worth its cost. Cached in a light volume they cost 0.3–0.5 ms on a third of the frames.
- **Average error hides flaws.** Thin lines, veins and flicker pass every error metric. Look at moving pictures.

## The budget that decides everything

One evaluation, *measured*: about 0.5 ns for 8–16 wide with few inputs, 0.65 ns for 16 wide with 22 inputs, 1.8 ns for 32 wide.

| Evaluated per | Count | 16 wide | 32 wide |
| --- | ---: | ---: | ---: |
| Screen pixel | 3.5 million | 1.6–2.3 ms | 6.4 ms |
| Cloud-size pixel | 0.2 million | 0.1 ms | 0.4 ms |
| Texel of one new terrain tile | 16 thousand | 0.01 ms | 0.03 ms |
| Texel of a 256×256 light map | 66 thousand | 0.04 ms | 0.12 ms |

So anything per screen pixel needs to save more than 2 ms or look much better. Anything per tile or per map texel is free.

## Where the time and the visual error are today

GPU frame time, *measured* by leaving groups of draws out (medium clouds, trees and shadows off as in the game's defaults):

| View | Frame | Terrain | Water | Sky | Clouds |
| --- | ---: | ---: | ---: | ---: | ---: |
| Ground | 14.0 ms | 4.9 | 2.2 | 0.5 | about 2.4 |
| Mountain | about 15 ms | 6.5 | 2.7 | 0.5 | about 2.4 |
| From 3 km | 15.8 ms | 7.9 | 2.3 | 1.1 | about 2.5 |

While flying over new land, each refined tile costs 2.1–4.3 ms for its height alone (about 110–240 ns per point, as much as 200–400 network evaluations), then 0.6 ms for the tile map, 0.4 for splat weights and 0.15 for the palette.

How the ground is lit (`terrainChunkFragmentShaderBuilder.js:4794`): `albedo × (one ambient colour × AO + sun × N·L × shadow)`, then never darker than 30 % of the albedo. That means:

- **No sky visibility.** A valley floor and a ridge get the same ambient light. The AO is contact shade from plants only.
- **No mountain shadows.** The shadow feature is off, and reaches 1 km when on. Mountains 5 km away never shade a valley.
- **No bounced light**, and the 30 % floor flattens night and shade.
- **Cloud light is two constants** (`shadowStrength: 0.6`, `shadowFloor: 0.45`): the ground under a storm does not know how dark the sky above it is.

## Candidates

| Idea | Teacher | Conventional rival | Run cost (estimate) | Verdict |
| --- | --- | --- | --- | --- |
| Light on the ground under clouds | The cloud path tracer, exists | One fitted curve | under 0.1 ms | **Do first** |
| Sky and bounced light in terrain | Path tracer over the height field, new but simple | Horizon maps | 0.1 ms per tile, 0.1 ms per frame | **Do, after horizon maps** |
| Erosion detail in heights | Erosion simulation, offline | The RuneVision filter already in use | 0.1–0.3 ms per tile | **Prototype** |
| Distant forests | Path-traced tree groups | Hand-tuned hull shading | 0.1–0.3 ms | When trees return |
| Fog and cirrus light | The cloud path tracer, exists | Today's constants | none | Cheap extra |
| Colour match of far terrain tiers | The near shading itself | Per-material fit | none | Fit, not network |
| Biome rules as a network | The rules themselves | – | saves up to 1 ms per tile | Later, maybe |
| Whitewater look | The solver at high resolution | Today's shading | 0.3–0.8 ms | Not now |
| Materials per pixel | – | Baking | 1.6–6 ms | **No** |
| Neural texture compression | The textures | Block compression | 1.6 ms or more | **No** |
| Neural upscaling | High-resolution frames | Temporal upscaling | 4–20 ms | **No** |
| Atmosphere | – | The existing tables | – | No need |

## 1. Terrain lighting

**Step 1, conventional.** At tile refinement, march the tile's height map (and the coarse land maps that the mountain fog now keeps) in eight directions and store the horizon angle per direction. This gives sky visibility and soft mountain shadows at any distance, for a moving sun, with no shadow map. Estimate 0.1–0.3 ms per tile and about 0.2 ms per frame to read. This alone will be the largest visible change, and it needs no network. It also lets the 30 % floor go.

**Step 2, light under clouds (network or fit).** Record from the existing cloud path tracer how much sky and sunlight arrives at the ground, in colour. Inputs: the cloud shadow map blurred over a few sizes, sun height, deck strength. Output: ground light for a 64×64 map, refreshed every frame for a few microseconds. The ground then goes dark and blue under a storm and warm at its rim, in step with the sky.

**Step 3, bounced light (network).** A path tracer over the height field and its albedo gives the answer; inputs are the eight horizon angles, slope, sun direction, and mean albedo and sunlit share around the point. Cache it per texel of a light map around the camera and refresh slowly, as the cloud light cache does. With a 60-second day that cache must refresh several times a second; the clouds already handle this.

**Stop if** the network is not at least 30 % better in image error than step 1 plus a one-bounce formula, or if the difference cannot be seen in motion.

## 2. Erosion detail

Today's detail is a large sum of noise bands plus the RuneVision filter. A simulation of running water gives branching valleys, fans and terraces that no local noise does, but takes seconds per patch. Run it offline on patches of the game's own base height, then teach a network to add the difference from local shape (height, slope and curvature at three scales).

Constraints found in this code base:

- **Rivers and lakes are placed from point evaluations of the height** (`terrainHeightContract.js`, and the size bands in LAKE_CELLS_PLAN.md). The network must stay out of the bands they read, or they stop fitting the land. Realistic scope: features below about 200 m, a few metres high, kept off banks, which also limits the gain.
- **Neighbouring tiles and levels must agree.** Inputs have to be world-space quantities with the same value in both tiles, and each level adds only its own band.
- **The owner's eye decides.** A rewrite of the noise was reverted once because it looked wrong (TERRAIN_OPTIMIZATION_PLAN.md).

A replacement of existing octaves, not only an addition, is what would save time: each point costs 110–240 ns today against about 1 ns for a network. How much can be replaced is unknown until tried.

**Prototype:** one 4 km patch in the terrain lab, three pictures side by side: today, RuneVision filter tuned as well as possible, network. **Stop** if the network is not clearly preferred.

## 3. Distant forests

Trees are off by default now. When they return, the far tiers draw hulls whose light is hand-tuned. A path tracer over a group of the game's own trees can give the canopy's reflectance for any view, sun and density; a 16-wide network or a small table would then light hulls, impostors and far grass. It costs little per hull vertex and removes the colour steps between tree tiers.

## Why not texturing

- **Cost.** The whole terrain pass is 5–8 ms. A network per pixel costs 1.6–6 ms *before* it replaces anything, and most pixels are already cheap: distant terrain uses a baked colour.
- **Stability.** Networks that generate detail shimmer unless their output is filtered over the pixel footprint. Baked textures with mips get that for free. The engine has no temporal anti-aliasing to hide it.
- **The real problems are elsewhere.** Near procedural detail was switched off for frame rate (`:4595`). The fix is to bake it per tile at higher resolution, as the far tiers already do with their colour.
- A network could help *offline*, making seamless texture variants. That is authoring, not rendering.

## Why not upscaling

The engine has no temporal anti-aliasing, so it draws at 1.5 times the page resolution, 2.25 times the pixels. A conventional temporal upscaler (estimate 1 ms) would cut the 14–16 ms frame by perhaps 5 ms *and* remove the stair-steps along ridges. A network good enough to beat it needs billions of operations per frame; WebGPU here has no access to matrix hardware, so the estimate is 4–20 ms. **This is the best non-neural speed-up found while writing this report.**

## Suggested order

1. Horizon maps (conventional). 2. Light under clouds from the existing teacher, with the fog and cirrus constants fitted in the same run. 3. Bounced light, if 1 and 2 leave a visible gap. 4. Erosion prototype. 5. Forests with the trees.

Steps 1 and 2 are small: the teacher, training scripts and land maps exist (`neural_lab/`, `tools/neural/`, `CloudLandMap.js`).

## How sure is this

- **Measured:** frame shares, per-tile generation times, network cost, and that the cloud recipe works.
- **Approximate:** the draw-group shares (without terrain, sky and clouds fill its pixels, so terrain costs a little more than shown); tile times vary with GPU clock.
- **Not tested:** every run cost and quality claim for the candidates. Each step above has a point at which to stop.
