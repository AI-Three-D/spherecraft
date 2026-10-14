# Floating water at lake and river edges: problem brief for review

SphereCraft, branch `water-ponds`, working tree (nothing committed). State as of 2026-10-14, evidence runs v100–v115 in `tools/perf/structured-terrain-results/water-look-2026-10-12/` (README rows per run).

## 1. The problem

The owner's bar is **no floating water anywhere**. Today, in several places, a flat water surface ends in mid-air above ground that is lower than the water. Looking at that edge from the side, you see:

- the surface's cut edge;
- under it, either bare ground or a darker cyan (section 2 explains the colour).

Where rivers start or end at lakes, the same faults read as:

- hard, straight lake edges;
- land strips where lake and river water should meet.

The owner's poses (HUD camera position → look target):

| Name | Position | Look | What it shows |
|---|---|---|---|
| o4-floating | −131693.3, −3490.8, 4774.2 | −131689.8, −3486.9, 4769.5 | lake 2825's outlet, river 2566 (mechanism A, fixed) |
| o4-wedge | −131609.5, −4108.6, 4832.7 | −131605.2, −4104.3, 4829.1 | river entering a lake |
| o4-mouth | −131590.1, −3759.3, 6381.4 | −131584.8, −3762.3, 6377.8 | straight lake edge at a river mouth (B) |
| o4-band | −131601.9, −4643.5, 4611.3 | −131597.9, −4643.0, 4605.5 | river entering a lake, strip and holes near the shore |
| o4-star | −131763.1, −4899.2, 6874.8 | −131757.8, −4902.3, 6878.4 | lake 633, straight right bank (B) |
| shot 5 | −104245.0, −72685.2, 37202.7 | −104238.8, −72686.7, 37205.8 | lake outlet, formerly a floating wedge |
| s1 | −131611.7, 405.9, 6204.1 | −131606.3, 402.5, 6206.9 | river 2568 leaving lake 2827 |
| s3 | −131438.0, 3800.6, 7725.2 | −131435.0, 3806.4, 7727.7 | river 2575 leaving lake 2835 |

## 2. How water is drawn today

Three surfaces are drawn independently. Each decides its own coverage from its own data.

1. **Terrain shading**
   - Code: `applyWater` in `core/world/water/waterWgsl.js`, run per terrain fragment.
   - Lake water: `waterLakeHitView` → `waterLakeHitIn`, using the lake's mask and the rendered height below the lake's level.
   - River water: `waterRiverAtView`.
   - Within roughly 1 km of the camera it draws only the water's *body* colour (no reflection or glint), because the near meshes are meant to draw the surface over it.
   - **This body colour is the "darker cyan".** It shows wherever terrain shading decides "water" and no near mesh covers it. One case is looking under a floating sheet's edge at the body-shaded ground beneath.

2. **Near lake sheets**
   - Code: `core/renderer/water/NearWaterRenderer.js`, `nearWaterSurface.wgsl.js`.
   - One flat grid per lake, at the lake's level, around the camera.
   - It is clipped by the lake's 2-D mask. The terrain's depth test hides it where the ground rises above the level.
   - **The sheet does not know the ground height under it.**

3. **River ribbons**
   - Code: `core/world/water/riverRibbon.js`, built on the CPU; fragment code in `nearWaterSurface.wgsl.js`.
   - Flat across at the river's level at each traced point (about 20 m apart).
   - The fragment shader discards it where:
     - the distance from the river line is ≥ the half-width `hw`;
     - the *analytic* channel profile (`waterRiverProfile`) is at or above the water;
     - any lake's mask covers the point;
     - another river is nearer.

### Lake masks

- **Solve.** Lakes are solved on a 32 m grid of natural (uncarved) heights; the region is the cells below the lake's spill level (`lakeRefine.js`).
- **Upload.** Each mask is uploaded as a signed distance `F` (metres, + inside) to that region (`lakeMaskSdf.js`).
  - It goes into an atlas whose texels are 7–64 m depending on lake size (`WaterGpuData.lakeMaskAtlasPlan`, slot sizes 512/256/128/64, pool 2).
  - Examples: pond 2825 at 7 m texels, lake 633 at 32.3 m.
  - It is sampled with a cubic B-spline.
- **Draw rule.** A lake draws where `F > −16 m` (half a solve cell, "the band") and the ground is below its level.
- **River exception.** In the band (`−16 < F < 0`) the lake gives way to a river that is lower than the lake, within the river's half-width.

### Rivers

- **Trace and level.** Rivers are traced records, stride 20 (`waterWorkerCore.js solveRiver`, `riverRefine.js`). The level is fitted per point, non-increasing, below the natural ground within 4 m of the channel edge.
- **Carve.** The terrain is carved, cut-only, by a cross-section function (`riverSection.js`, `riverCarve.wgsl.js`). Next to a lake, a bank keeps the lake's rim (level + 0.3 m; `riverLakeRims`, `riverBankRim`).

### The core issue

Every surface ends at a boundary computed from coarse data:

- a lake at the 32 m solve's −16 m contour;
- a river at `hw` or its analytic profile.

None of them ends where the *rendered* ground actually rises above its level. Wherever such a boundary lies over lower ground, that surface floats. The rendered ground differs from the solve's heights in two ways:

- it is finer (per-tile micro detail on top of the height function);
- it is carved by the rivers.

## 3. Mechanisms proven so far

I used debug view `qtDiag.water.tint(9)` (terrain shading only), which shows why a signed-distance lake draws or not at each pixel:

| Colour | Meaning |
|---|---|
| white | ground above the level |
| red | ground below the level but outside the band (`F ≤ −16`) |
| blue | the lake gives way to a lower river |
| magenta | drawn in the band |
| cyan | drawn in the solved water |

Views 6 and 7 classify who draws inside a river's zone (`tools/perf/riverMetrics/ownership.js`). Their "gap" class means the ground is below that river's water and nothing draws water there.

### A. Outlet strips (fixed in the working tree, v115)

At o4-floating:

- River 2566 leaves lake 2825 (level 746.31 m). Its level stays at 746.31 m to point k5, then drops to 745.81 m at k6.
- At k6 the ground beside the channel is still 745.96 m, under the lake's level and inside its band (F ≈ −15 m). The ground first rises above the lake at k7 (746.70 m).
- So the lake gave way over the river's half-width (blue in view 9), but the ribbon and the terrain-shaded river draw only out to the analytic profile's waterline. That waterline is narrower than `hw`.
- The strip in between was ground below both waters that nobody drew. It showed as bare walls under the hanging edges of both surfaces.

The fix: a river keeps its source lake's level past the lake's cells, but only under two conditions:

- the ground beside its channel that lies below the level is inside the lake's band;
- no such ground lies outside the band.

Downstream the level fit is unchanged (`riverLakeHold`, `RIVER_SOLVE_VERSION` 15).

| Pose | Gap before | Gap after |
|---|---|---|
| o4-floating | 3.66 % | 0.01 % |
| o4-outlet-down (from the lake, looking downstream) | 0.38 % | 0.03 % |
| shot 5 | 10.2 % | 10.9 % |

At shot 5 its floating wedge is gone. The other seven poses are pixel-identical.

**Limitation:** the worker decides "inside the band" from the 32 m region's distance field read bilinearly. The GPU reads a B-spline over an atlas, so the two can disagree right at the band's edge.

### B. Straight band edges over ground below the level (open)

At o4-mouth, o4-star and s1, view 9 shows red directly against the drawn lake, along straight lines.

**Why:**

- `F = −16 m` falls exactly at the centres of the outside neighbour cells, whose 32 m height samples are at or above the level.
- Between two such centres the contour is a straight line.
- The real ground between them dips below the level for a few metres.

So the lake ends with a straight edge over lower ground. **Bilinear 32 m heights cannot see these dips.** Only finer heights can. For big lakes the atlas texel (32–64 m) is a second limit.

### C. River edges over lower ground (measured, not yet analysed)

The "gap" share of the wet river area (v115) is:

| Pose | Gap |
|---|---|
| s3 | 10.7 % |
| start-2591 | 10.3 % |
| o4-mouth | 13.1 % |
| shot 5 | 10.9 % |
| s1 | 1.3 % |
| o4-wedge | 1.1 % |
| o4-band | 0.8 % |

These pixels are inside a river's zone, below that river's water, with nothing drawing water. Most are thin fringes along the banks: the ribbon is clipped to `hw` and the analytic profile, while the actual ground beside it is lower. At mouths, part of this overlaps B.

### D. The darker cyan

This is not a separate fault. It is terrain shading drawing the water body where no near surface covers it. Two cases are known:

- under floating sheet or ribbon edges, seen from the side;
- where terrain shading and a near mesh disagree about coverage.

## 4. What has been tried

| Run | Change | Result | Status |
|---|---|---|---|
| older | binary 32 m mask with a 3-cell band | water in every dip on a 96 m rim, sheets over ground beyond sills | replaced by signed-distance masks |
| v82 | "lake floor" in the carve (banks kept above the lake) | terraces where the floor met the cut | reverted |
| v84–v93 | lake band gives way near rivers below the lake (`waterLakeBandYield`) | straight edges and dry strips at every mouth | removed v101 |
| v86–v103 | lake rims: banks keep the lake's level + 0.3 m | s1 fragments mostly gone, bank spill at starts 3,167 → 2,879 m² | kept |
| v92 | third lake slot per index cell | 161 dropped pond cells → 3 | kept |
| v105 | B-spline sampling of the distance field | the star's 32 m scallops ("sine wave") gone | kept |
| v106 | band gives way to a river 0.3–1 m below the lake | no effect at its target | removed |
| v111–v115 | source lake hold (A) | see above; two variants failed: a 32 m cap on ground alone flooded land outside the band, and restarting the fit kept the water 0.5 m higher for 120 m | kept (v115) |

## 5. Questions for review

1. **Is the architecture the problem?** Three independently clipped flat surfaces, each with its own coarse boundary, plus terrain shading that guesses coverage again. Is there a sound way to guarantee "a surface ends only where the rendered ground reaches its level, or where it meets another surface at the same level"?
   - One option: a single water-level field per terrain point (the highest connected water level), drawn as one surface.
   - Another: coverage baked during terrain tile generation, at tile resolution.
2. **For B, my plan is a fine lake shore.** Near the camera, flood-fill each lake's shore ring at 8 m from its solved region over ground below the level. Build the distance field from that region and point-sample it into the atlas (a distance field reproduces straight shores even at 32–64 m texels). Use a band of −4 m.
   - Is this right, or is it treating a symptom?
   - The trace's lake cells (used for the hold and the rims) would still be the 32 m region. How should the two be kept consistent?
3. **For C,** should the ribbon's width come from the actual ground (draw wherever the ground is below the river's water and connected), instead of `hw` and the analytic profile?
4. **Lake–river handover:** levels and coverage are decided in three places (the worker's level fit, the lake's band rule, the ribbon's discard). Is there a simpler single rule?
5. **Pockets beyond sills:** any of the above must not put water in dips beyond a sill, which was the original reason for the narrow band.

## 6. Reproducing and measuring

- **Views:**
  - `qtDiag.water.tint(9)`: why a lake draws or not;
  - `tint(6)` and `tint(7)`: who draws, combined offline by `tools/perf/riverMetrics/ownership.js`;
  - `tint(0)`: normal rendering.
- **Captures:** `node tools/perf/lakeRecovery/waterViews.mjs --out=DIR --views=FILE.json`. It runs its own server on :8193 and system Chrome; the poses are in `views-hold-all.json` in the evidence directory.
- **Metrics:**
  - `owners_<pose>.shares` in `report.json` (gap, lake, ribbon, …);
  - `tools/perf/riverMetrics/startPatches.mjs`: bank spill near river starts;
  - `carveSeams.js`: seams in the carve.

## 7. Constraints

- **Performance:** water must not add terrain regeneration. Precompute time is measured and kept low.
- **Carve:** cuts only.
- **River simulation:** stays off (`riverSim=off`).
- **Pruned code:** deleted outright, with no toggles kept.
- **Process:** each change gets a metric and a baseline, and an A/B that proves the cause.

## 8. Files

- **Shading:**
  - `core/world/water/waterWgsl.js`: `applyWater`, `waterLakeHitIn`, `waterRiverAtView`, `waterLakeMaskSampleSmooth`, debug view 9 (`waterLakeDebugWhy`);
  - `core/renderer/water/nearWaterSurface.wgsl.js`: lake sheet and ribbon fragments.
- **Masks:** `core/world/water/lakeMaskSdf.js`, `core/world/water/WaterGpuData.js` (`_uploadMask`, atlas plan, lake index).
- **Lake solve:** `core/world/hydrology/lakeRefine.js`.
- **Rivers:**
  - `core/world/hydrology/waterWorkerCore.js` (`solveRiver`);
  - `core/world/hydrology/riverRefine.js` (`riverValleyLevels`, `riverLakeHold`, `riverLakeRims`);
  - `core/world/water/riverSection.js`, `core/world/water/riverCarve.wgsl.js`;
  - `core/world/water/riverRibbon.js`.
- **History:** `CLAUDE_LAKE_RIVER_HANDOFF.md`, section 10.
