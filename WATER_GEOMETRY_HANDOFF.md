# Near-water geometry: hand-off (2026-10-06)

Your task is one piece of SphereCraft's water work: **surface geometry for nearby lakes and rivers**.

> **Status and decisions so far: see "Session log" at the end.** They change parts of "Recommended design" below.

Another session is reshaping the terrain around the water (valleys, banks, water levels). Don't change any of that.

## Setup

- Repo: AI-Three-D/spherecraft, branch codex-restart.
- Local path: /Users/okkokauhanen/work/DATrain/feature/proj/spherecraft.
- To run: `python3 server.py`, then open http://localhost:8181/wizard_game/standalone.html.
- Port 8000 belongs to the owner. Don't start servers on it.
- Console helpers:
  - `qtDiag.water.goto(lakeId, 300)` places the camera 300 m from a lake.
  - `qtDiag.water.near(n)` lists nearby lakes.
  - `qtDiag.water.stats()`
  - `qtDiag.water.sim()`
  - `qtDiag.water.look({...})`
  - `qtDiag.water.tint(mode)` selects debug views 1–3.

## What the owner wants

**Nearby water gets its own geometry.** Today the terrain fragment shader paints every lake and river. Near the camera this shows three problems:
- Water forms a bowl that follows the slope of the terrain.
- Edges are blocky, with spikes, until the tiles refine.
- Water appears in gullies.

The owner on an earlier version: lakes were drawn as a plane that "would just intersect into the ground around the shoreline and it worked perfect."

**Far water stays in the terrain shader.** The owner: "If these terrain shader ones are cheaper, we could use this for anything beyond few hundred meters. Perhaps from lod 2 or even lod 1. It looks decent enough." Approximate LOD ranges on the owner's canvas (they scale with canvas size):

| LOD | Distance |
|---|---|
| LOD0 | under ~0.6 km |
| LOD1 | ~0.6–1.2 km |
| LOD2 | ~1.2–2.3 km |

**As cheap as possible.**
- Budget for all water: about 1.5 ms of GPU time per frame on the owner's MacBook (IMPLEMENTATION_PLAN_WATER.md).
- The river simulation strip is allowed up to 0.7 ms of that.

**Out of scope:**
- The terrain around the water.
- Water levels, the lake shore solve and river tracing.
- The simulation's physics.
- Tuning foam, colours or widths.

## How water is drawn today (facts, checked 2026-10-06)

### Terrain-shader water

`applyWater` (core/world/water/waterWgsl.js) runs in the terrain fragment shader. It is called at terrainChunkFragmentShaderBuilder.js:4749, before aerial perspective (line 4759).

It recolours terrain pixels whose height is below the water level:
- **Lakes:** where `waterLakeLevelIn` finds the mask at 0.5 or more and the height is below the lake level.
- **Rivers:** where `waterRiverAt` finds the pixel inside the channel and below the river's water level.

So what you see as the "surface" is really the bed. That causes the bowl look. The edges follow each tile's interpolated height, which is why they look blocky before tiles refine.

### Water data on the GPU

`WaterGpuData.resources` holds `{ index, lakes, masks, params, rivers }`.
- The terrain shader binds them in group 3, bindings 12–16 (`WATER_BINDINGS`).
- `createWaterWgsl({ group })` adds the same lookups to any shader, under any group.

### Lakes

**GPU record** (`WaterLake`): level, maskLayer, sizeX, sizeY, c, x0, e1, y0, e2. The frame is a gnomonic tangent plane:
- px = dot(dir, e1) / dot(dir, c) · R, and py the same with e2.
- Mask uv = ((px − x0) / sizeX, (py − y0) / sizeY).
- To go back from plane to direction: dir = normalize(c + (e1·px + e2·py) / R).

**Mask texture:**
- r8unorm array of 512² layers, up to 96 layers.
- A value of 1 means water may show: the lake's water plus a band of up to 3 cells (16 m each) around it.
- `maskLayer < 0` means the lake has no shore solve yet. Near the camera such lakes are hidden: within `riverLook.w`, set by `unsolvedLakeHideM`.

**CPU side:**
- `svc.refined.get(id)` → `{ level, frame, mask (2 = water, 1 = band), areaM2, … }`
- `svc.lakes[k]` holds the graph's lakes.

### Rivers

**CPU side:** `svc.riverRecs`. Each record holds points with a stride of 20:

| Index | Field |
|---|---|
| 0–2 | dir |
| 3 | design level |
| 4 | half-width (hw) |
| 5 | design depth |
| 6 | speed |
| 7 | Q |
| 9 | pool (−1 = inside a lake) |
| 10 | skew |
| 11 | foam |
| 16 | **water level** |
| 17 | water depth at the thalweg |

**GPU segments:** 28 floats each (`WaterRiverSeg`, carrying wl0 and wl1).

**Per-pixel lookup:** `waterRiverAt(dir, heightM)` returns a `WaterRiverHit` with: found, near, depthM, distM, halfWidthM, etaM (the water level), flow, speed, foam, sM, nM and river (the river's id).

**Shape noise:** `riverShapeAt` (riverShapeNoise.js, JS) and `waterRiverNoise` (WGSL) give bit-identical width, wobble and bank values.

**Wetted half-width:** hw·sqrt(1 − (1 − h/D)^(2/3)). This is the waterline used by `waterRiverAt`.

### Simulation strip

`WaterSimRenderer` (core/renderer/water/WaterSimRenderer.js) draws the simulated stretch of the river near the camera, at frontend.js:1325.
- It is a transparent mesh with depthWrite off, drawn after the opaque meshes.
- Static water gives way to it through `waterSimCover(river)`, using `waterParams.simRiver` and `simFade` (from `WaterGpuData.site`).

### Sea

`globalOceanRenderer` (frontend.js:1258) is not part of this task. It draws a sea surface on every visible tile, reusing the quadtree's instance and indirect buffers, and discards pixels where the terrain is above sea level.

### Shading

- Lakes use `waterSurfaceColor`; rivers use `waterRiverColor`.
- Both take the bed colour and the depth (depthM), and both are **affine in the bed colour**: out = bed·A + B, where A is per channel.
- In the river case the bed colour is `ground`: the bank's soil tint, applied in `applyWater`.
- Ripples use worldPos and `waterParams.time`.

### Aerial perspective

- The terrain shader applies aerial perspective after the water: `getAerialPerspectiveWGSL`, in core/renderer/atmosphere/shaders/aerialPerspectiveCommon.js.
- waterSimSurface.wgsl.js does not apply it.

### Old systems, probably dead (ask the owner before reusing or deleting them)

- **LakeWaterSystem** (core/renderer/lakes/*): erosion-seed lake blobs. Nothing feeds it, because `frontend.setLakes` has no callers.
- **RiverSystem** (core/renderer/rivers/): the walking-skeleton demo. Its river is switched off in runtimeConfigs.js.

## Constraints

**Depth precision.**
- Setup: `depth24plus`, forward-Z, depthCompare `'less'`. The near plane is 0.5 m at ground level (frontend.js:1499).
- Depth error is about z²/8.4e6 m:

  | Distance | Depth error |
  |---|---|
  | 300 m | 1 cm |
  | 600 m | 4 cm |
  | 1 km | 12 cm |

- Where a water mesh meets a gentle shore (2 % slope), it z-fights over a band of width error/slope: 2 m wide at 600 m, 6 m at 1 km.
- So a mesh is only good near the camera. The shore must also fade in by water depth over at least about twice the depth error at the handover distance (`shoreSoftM` in `WATER_LOOK_DEFAULTS`).

**The owner's GPU is a MacBook (Apple, tile-based).**
- The scene renders into PostProcessingPipeline's HDR target: rgba16float plus depth24plus.
- Every extra render pass break stores and reloads the full colour and depth targets, a full-screen bandwidth cost on this GPU. The frame already has several breaks (`endRenderPassForCompute` / `resumeRenderPass`).
- So draw inside the main scene pass, as WaterSimRenderer does.
- Sampling the scene depth texture would need its own read-only depth pass, so avoid it unless measurements say otherwise.

## Recommended design

This is a recommendation. Verify it; don't take it as given.

### 1. Near/far split by distance, set in config

- Config fields: something like `near { enabled, fadeStartM, fadeEndM }`, kept next to `WATER_LOOK_DEFAULTS`.
- Start with defaults of about 400–600 m.
- `applyWater` multiplies its water by smoothstep(fadeStartM, fadeEndM, dist), and the mesh uses the complement.
- With `near.enabled` off, the result is exactly what is drawn today.
- The bank soil tint (`ground` in `applyWater`) stays in the terrain shader at all distances, because it is terrain colour.

### 2. One renderer (e.g. core/renderer/water/NearWaterRenderer.js)

- Draw it inside the main pass, just before `waterSimRenderer.render` (frontend.js:1325).
- Transparent, depth test on, depth write off.
- Bind the same WaterGpuData buffers and include `createWaterWgsl`.

**Lakes.** One shared grid mesh (32² to 64² quads), drawn instanced: one instance per refined lake near the camera.
- The CPU list comes from `svc.refined`. Update it when the camera moves about 50 m, or when the lake table changes.
- **Vertex shader:**
  1. Read `waterLakes[slot]`.
  2. Map uv into the frame: px = x0 + u·sizeX, py = y0 + v·sizeY.
  3. dir = normalize(c + (e1·px + e2·py)/R); position = origin + dir·(R + level).
- **Grid area:** each instance gets a uv sub-rectangle: the lake's bounding box clipped to a square around the camera that covers fadeEndM. Grid density then goes where it is seen, and large lakes don't spend fragments far away.
- **Fragment shader:**
  - Discard where the mask is below 0.5. This is the same test as `waterLakeLevelIn`; use a linear sampler so the edge is smooth.
  - The terrain's depth test hides everything else, so the shoreline is wherever the flat surface meets the ground, at any tile LOD. This is the method the owner liked.

**Rivers.** One ribbon per river, built on the CPU once when the river is traced or restored from cache:
- Centre: the points plus the `riverShapeAt` offset.
- Half-width: the waterline times (1 + margin). The banks hide the excess.
- Height: the water level (index 16) per vertex, flat across the river.
- Put all rivers in one vertex buffer and draw only the pieces near the camera (for example, chunks of 64 points).
- In tight bends, clamp the inner offset so the ribbon doesn't fold over itself, which would blend the water twice.

**Which surface owns a pixel.** Use the same order as `applyWater`:
- A lake owns a point where its mask is 0.5 or more.
- A ribbon fragment draws only where no lake covers the point and `waterRiverAt(...).river` is its own river. This settles outlets and confluences.
- Both give way to the simulation strip (`waterSimCover`).
- Keep the debug views (`tint` modes 1–3) working near the camera too.

**Depth for colour and the soft shore.** Use the vertical depth: level minus the resident terrain height at the fragment.
- Get the height from the resident tile lookup (core/renderer/shaders/residentTileHeightLookupWgsl.js).
  - Today only the old lake probe and the old river bed bake use it. The actors (movementResolver.wgsl.js) and BiomeQuery have their own copies of the same walk.
- The walk starts at the finest depth, so near the camera it should hit within a level or two.
- Each level is a hash lookup with linear probing, and its comment says probe chains can run past 64. Measure the cost per fragment before relying on it.
- This gives the same depthM as `applyWater`, so:
  - the colour matches,
  - the depth reaches 0 at the shore, which gives the soft edge,
  - the soft edge hides the z-fighting from depth precision.

**Colour.** Keep the maths of `waterSurfaceColor` and `waterRiverColor` unchanged; only restructure them into the form out = bed·A + B.
- **Exact match:** use dual-source blending (WebGPU feature `'dual-source-blending'`, WGSL `enable dual_source_blending;`, srcFactor `one`, dstFactor `src1`). It reproduces the terrain-shader water per channel, in one draw.
  - Check `adapter.features` in the owner's Chrome first.
  - The backend's Material blending will need this mode added.
- **Fallback:** premultiplied scalar alpha, with A replaced by its mean.
- **Fog:** the framebuffer already holds the fogged bed. With fog transmittance F and in-scatter S at the surface: out = fb·A + B·F + S·(1 − A). Check that the aerial perspective really has the form c·F + S.

### 3. Rough cost

- **Vertices:**
  - one instance per lake of the 32²–64² grid;
  - 2 vertices per river point.
- **Draws:** one instanced draw for lakes, plus one draw per nearby river piece.
- **Fragments:** work happens only on visible water. The depth test drops the band hidden under the shore, and inside fadeStartM the terrain shader skips the water shading.
- **Target:** at most about 0.3 ms GPU while standing at a lake shore on the owner's MacBook. Measure it.

## What would prove this design wrong (check before building)

**The owner's browser lacks dual-source blending.**
- The scalar fallback then tints shallow water differently from the far water, and the handover may show.
- In that case, compare in the browser before choosing.

**The resident height lookup is too expensive per fragment.** Alternatives:
- Store a per-lake depth layer at 16 m in the mask atlas. The shore gets blurrier, and rivers would use their channel profile.
- Use a read-only depth pass. Measure the pass break on the MacBook first.

**The shoreline still z-fights at fadeEndM despite the soft shore.**
- Shorten the near range.
- Reversed-Z with depth32float would also fix it, but it touches every material, so ask the owner first.

**The lake band.**
- Inside the band (up to 48 m beyond the water), wherever the terrain dips below the lake level, the flat sheet shows water. Today's terrain-shader water does the same.
- At outlets the sheet covers the first ~48 m of the river channel at lake level, which is a few centimetres above the river's water level.
- Check the seam where the sheet meets the ribbon at the band's edge.

## Steps

After each visible step: ask the owner to check in the browser and say exactly where to look, for example `qtDiag.water.goto(<lake id>, 300)`, which shore, and what to compare. Then commit.

1. **Measure; no code changes.**
   - Frame GPU time with water on and off: timestamp queries if the backend has them, otherwise the owner's FPS readout.
   - Adapter features.
   - The cost of the resident height lookup.
   - The LOD distances on the owner's canvas.
2. **Near/far fade in `applyWater`, behind the config flag.**
   - Add a debug view that shows only near or only far water.
3. **Lake sheets in a flat debug colour.**
   - The owner checks the shoreline at a lake while coarse tiles refine, and checks that the bowl is gone.
4. **Lake shading:** depth lookup, colour functions, blending, fog.
   - The owner compares the handover zone (fadeStartM to fadeEndM).
5. **River ribbons and ownership rules.**
   - Check outlets, confluences and the ends of the simulation strip.
6. **Cost check.**
   - Then set the fade distances with the owner.

## Owner's rules

- **Before implementing:** state your confidence and what would prove you wrong.
- **Proof:** prove causes with measurements or debug views. Never ship a second unverified guess. Numbers are not visual success; the owner judges in the browser.
- **Headless browsers:** runs need the owner's permission. If allowed, use system Chrome 154, not Puppeteer's bundled Chrome 131.
- **Config:** keep features config-driven and behind flags. When a feature is removed, its code, toggles and config go too; no options are kept.
- **WGSL:** there is no `?:` operator; use `select()`. `active` and `target` are reserved words.
- **Committing:**
  - Commit each verified step.
  - Review each file's diff before staging; the owner edits the working tree at the same time.
  - Stage your own hunks only, with `git apply --cached` on a filtered patch, since interactive `git add -p` isn't available.
  - Never stage other sessions' changes or the owner's.
  - Never commit IMPLEMENTATION_PLAN*.md.
  - Push only when asked.
- **Style:** don't tune foam, colours or widths until the architecture is right. Keep replies short and concrete, and give the owner a recommendation, not a survey.

## Working with the river-terrain session

**That session owns:**
- the terrain around water: riverValley.js, riverValley.wgsl.js, riverCarve.wgsl.js, earthLikeBase.wgsl.js;
- hydrology: waterWorkerCore.js, riverRefine.js, lakeRefine.js, WaterService.js, HydrologyGrid.js;
- the simulation: WaterRiverSim.js, riverStrip.js;
- the terrain generator files.

**Shared files.** waterWgsl.js and WaterGpuData.js may carry that session's uncommitted changes, and gameEngine.js also carries the owner's. Make additive changes there and keep the existing lookups' meaning and buffer layouts.

**git status.** Unless it has been committed by then, `git status` will show work from that session and from the owner's Session 4. Don't stage it and don't revert it.

**WATER_ALGO_VERSION.** Rendering-only changes don't need a bump.

## Session log

### 2026-10-06, session 1: decisions, steps 2–3 built (uncommitted, waiting for the owner's browser check)

New owner requirements: the player can go under water, and the near water gets waves.

**Decision: far water stays in the terrain shader. Near water only gets a mesh.** Reasons:
- The terrain shader does the water lookups on every terrain pixel anyway: the river lookup for the bank tint, and (below) the lake lookup for the near water's body. Far water then costs only its surface shading, once per water pixel.
- A far mesh would shade every far water pixel twice (bed, then surface). It would also add vertices for every lake and river in view, and need the bed depth from somewhere.
- A far mesh z-fights with depth24 forward-Z: about 0.5 m of depth error at 2 km, 3 m at 5 km. It would need reversed-Z first, which touches every material.
- Removing the lake lookup from far terrain pixels would save about 2 storage reads and ~50 ALU per pixel, a few % of the terrain fragment shader at most.

**Decision: hand over at 1000–1600 m (config).**
- First default was 250–400 m. The owner saw the debug sheet and asked for the mesh to reach about 4x as far.
- Aerial perspective starts at 400 m (rendering.terrainShader.aerialFadeStartMeters), so the mesh's shading (step 4) must apply it: out = fb·(1 − a) + src·T + S·a, with the transmittance LUT and atmosphere uniforms bound.
- Depth error at the shore is 0.12 m at 1 km and 0.3 m at 1.6 km: a band of up to 6–15 m on a 2 % shore where the sheet and the ground tie. The owner checks for shimmer there with the debug sheet. If it shows: a depth bias (stable, the sheet reaches a little up the shore), or reversed-Z (ask first).
- Lakes listed: at most 16 nearest by their patch. A lake left out would lose its surface inside the range, since the terrain shader's switch is by distance only.

**Change to "Recommended design": split the colour instead of dual-source blending plus a per-fragment height lookup.**
- `waterSurfaceColor` = body + surface, where the body is the bed seen through the water column (`waterBodyColor`, unchanged maths).
- Near the camera the terrain shader keeps the body. It knows the exact depth (level − height) at its own pixel.
- The mesh adds only the surface terms (ripples, Fresnel sky reflection, glint, later foam) with premultiplied scalar alpha: out = body·(1 − F) + sky·refl·F + spec.
- This is the same formula. It differs only where depth < shoreSoftM (15 cm), where the mesh's reflection starts sharply where the plane meets the ground instead of fading in.
- So no `'dual-source-blending'` feature, no resident-tile hash walk per fragment, and no colour mismatch at the handover.
- Known gap: objects standing in water (actors) get the surface overlay but no absorption. The handoff's design had the same problem in another form.

**Mesh: camera-centred grid per lake, not a uniform grid over the lake's box.**
- One 97² grid, drawn instanced once per nearby lake (max 16).
- It lies in the lake's tangent plane around the camera, at offset sign(g)·g²·extent: about 0.7 m apart at the camera, 70 m at 1.6 km. That leaves room for vertex waves later.
- It is clamped to the lake's patch, so triangles outside it collapse to nothing.
- Same position arithmetic as the terrain vertices: origin + dir·(R + level).

**Built (all behind `WaterGpuData.near.enabled`, default off; off = exactly today's image):**
- `waterWgsl.js`:
  - `WaterParams.near` (appended vec4, LAKE_PARAMS_FLOATS 40 → 44);
  - `waterBodyColor` split out of `waterSurfaceColor`;
  - `waterNearWeight`;
  - lake branch of `applyWater`: body only near, today's colour far, blended in the fade band;
  - debug view `tint(4)`: cyan = terrain shader draws the surface, magenta = near mesh.
- `WaterGpuData.js`: `WATER_NEAR_DEFAULTS` { enabled, fadeStartM 1000, fadeEndM 1600 }, `paramsData`, `lakesNear()`.
- `core/renderer/water/NearWaterRenderer.js` and `nearWaterSurface.wgsl.js`.
  - For now a debug look: translucent blue with white lines every 10 m.
  - It is drawn just before `waterSimRenderer.render`.
- `frontend.js` wiring; `qtDiag.water.nearMesh({...})`; `gridIndices` exported from WaterSimRenderer.js.
- Rivers are unchanged so far: the fade applies to lakes only until the ribbons exist (step 5).

**Checks:**
- vitest: 193/193 passed, including new tests for `lakesNear` and the params slot.
- naga validates both shaders.
- Dawn/Tint (compile only, terrain-lab node_modules) accepts the render pipeline with its bind-group layout and the changed `applyWater`.
- Not yet seen in a browser.

**Owner check for steps 2–3:**
1. `qtDiag.water.near(5)`, then `qtDiag.water.goto(<id>, 60)`, then `qtDiag.water.nearMesh({ enabled: true })`.
2. Expected: a flat, translucent blue sheet with a 10 m grid out to ~1.6 km. It meets the ground at the shore, with no bowl on slopes.
3. Fly in fast while tiles refine and watch the shoreline.
4. At 1–1.6 km, look for shimmer where the sheet meets the shore.
5. `qtDiag.water.tint(4)` shows the handover. `qtDiag.water.tint(0)` returns to normal.
6. Cost A/B at a fixed camera, by FPS: `qtDiag.water.look({ enabled: false })` against `true`, and `nearMesh({ enabled: false })` against `true`.

**Owner, after seeing the sheet:** "it looks like there is nothing under the water geometry". Likely cause (not proven): Whitewater's absorption [1.6, 0.8, 0.6] per m leaves 4/20/30 % of the bed's light at 2 m depth, and the 55 % debug sheet sits on top. Checks: `look({ enabled: false })` shows the bare bed; `look({ absorption: [0.2, 0.08, 0.05] })` shows clear water with the sheet.

### 2026-10-06, session 1 (cont.): step 4, the real surface (uncommitted)

The owner asked for the real look instead of the debug views, with a master switch: `qtDiag.water.nearMesh(true)` (or `false`; the default stays off).
- The debug sheet is gone. The mesh draws `waterSurfaceTerms` (split out of `waterSurfaceColor`, same maths): ripples, Fresnel sky reflection, sun glint.
- Hand-over is exact: the terrain draws X = mix(full, body, w) under the mesh. The mesh blends with a = F·w / (1 − F + F·w) and adds S·(1 − (1 − w)(1 − a)), so X·(1 − a) + add = full for every w (checked numerically, with haze: error 1e-15).
- Aerial perspective (or the fog when it's off): the same `ap_computeSimple` call, inputs and fade (`aerialFadeRange`, now shared with the terrain shader builder) as the terrain. The mesh adds add·T + S·a over the framebuffer.
- The surface gives way to the simulation strip (`waterSimCover`, only while it runs).
- With the camera below a lake's level, its mesh is discarded until the underside exists (diving step).
- `absorption` default changed to [0.45, 0.2, 0.15] (clear water; the owner wants to see the bed). Whitewater's [1.6, 0.8, 0.6] was murky. This applies to all water: lakes, rivers and the simulation strip's alpha.
- Checks: vitest 193/193, naga, Dawn/Tint pipeline compile. Not yet seen in a browser.

### 2026-10-06, session 1 (cont.): lakes committed (38e71ae); rivers get the lakes' approach (uncommitted)

The owner: "Should we just have the lake's approach everywhere? ... the same texture everywhere and no need to displace geometry according to water flow (this only later). Then once the river looks ok, we would slowly start bringing in the simulation there." Then: "you decide and move forward".

Decided and built:
- **Rivers use the lakes' look everywhere.** Far, `applyWater` gives rivers `waterNearFarColor` (shared with lakes) over the bank's soil tint. `waterRiverColor` (flow-carried ripples, foam) is deleted, along with its settings (riverAnimNearM, riverAnimFarM, riverFoamGain; `riverLook.xyz` now unused) and the unused flow branch of `waterSurfaceTerms`.
- **Near rivers: ribbons** (`core/world/water/riverRibbon.js`, drawn by `NearWaterRenderer`).
  - Flat across at the water level (point field 16; the design level on older records).
  - Along the channel's centre: the traced line plus the shape noise's wobble, the same as `waterRiverPoint`.
  - Width: the shaped half-width + 2 m. The banks hide the rest by depth, as at lake shores.
  - The inner edge in tight bends is limited to 0.8 × the bend radius (no fold).
  - Rebuilt on the CPU when the camera moves 10 m. Rivers far from the camera are skipped by a bounding cap.
- **Seams with lakes.**
  - The ribbon gives way where a lake mask covers the point (`waterLakeLevelView(up, -1e30, ..., false)`), and to a nearer river at confluences (`waterRiverAt(...).river`).
  - Its level eases to the lake's level over 80 m from the lake mask (`WaterGpuData.lakeAt`, the CPU mirror of the mask test), so the surfaces meet without a step.
  - The terrain's river body near a mouth still uses the record's own level, so they can differ there by however far the record's level is from the lake's.
- **Simulation off** (`runtimeConfigs.js` `waterGraph.sim.enabled: false`). The owner saw its white froth strip again: the first version paused it only while `nearMesh` was on, and that switch was off. The coupling is gone; the config switch is the only one. The near meshes' sim-cover code is gone. The simulation comes back later on the ribbons.
- **Near water on by default** (`WATER_NEAR_DEFAULTS.enabled: true`; `qtDiag.water.nearMesh(false)` turns it off).
- **Lake shore band trimmed beside rivers** (`core/world/water/lakeBand.js`). The owner saw water polygons outside the river channel, cut by straight 16 m edges.
  - Cause (lab, terrain-lab/near-band-check.mjs, outlets 12 and 17): lakes are solved before the carve. The carve and valley lower the ground beside the channel, so the lake's band cells (mask 1) show lake water in hollows there.
  - Fix: band cells within the carve's reach (hw × shape scale + bankW + blendW + 8) of a river point outside lakes (pool ≥ 0) are cleared, in `WaterGpuData` (mask upload, `lakeAt`). Lakes near a changed river are re-trimmed and re-uploaded.
  - Lab: band spill beside the river 11184 → 5356 px at outlet 17. The rest is the lake's own water cells near the outlet. Water cells lost: 0. The channel mouth's band blocks are gone, so the river's water reaches the lake.
  - This is a stopgap until lakes and carving are solved together (carving phase).
- One shared fragment function `nearWaterShade` for lakes and rivers: surface terms, the exact hand-over blend, aerial perspective.
- Checks: vitest 203/203 (new: riverRibbon.test.js, lakeBand.test.js, river shaders in nearWaterSurface.wgsl.test.js, band re-trim in WaterGpuData.test.js); Dawn/Tint compile of both pipelines and `applyWater`. Not yet seen in a browser.

Known limits:
- Where the carved bed lies above the river's water level (the dry channel by the lake in the owner's screenshot), the ground covers the ribbon. That's the carving phase.
- Rivers ending at the sea: the ribbon's last stretch overlaps the ocean surface.

### 2026-10-06, session 1 (cont.): junction round, cost of water for tile loading (uncommitted)

The owner: only minor overflow is left, but the river still doesn't join the lake well in places. One river end stayed green ("Maybe the ocean?"). Tiles have become slow to refine (15+ s when flying fast). "Do a final round of improvements at the lake-river junction, then we move to the carving."

Junction changes:
- `riverWaterLevels` (riverRibbon.js) is the one place where a river's level eases to the lake's. The ribbons and the terrain shading's river segments (`WaterGpuData._rebuildRivers`, `wl0`/`wl1`) both use it, so the water's depth, and so its colour, match across the lake's edge. The carve doesn't read `wl`: no tile regeneration.
- The bank soil tint now also lies under a lake's water at a river mouth, fading out where the river runs inside a lake (`WaterRiverHit.pool`). Before, the river side was soil-tinted and the lake side grass, giving a straight colour seam at the mask edge.
- Ribbon caps: the ribbon runs on by the half-width past a river's ends, over the round end of the terrain's river water. Before, a lighter half-disc showed the body without a surface.
- Lab (near-band-check.mjs): at outlets 12 and 17 the river starts exactly at the lake's level (508.35, 492.69), so there's no level step there. The outlets drop fast: 2 m in 39 m and 9.6 m in 98 m at outlet 17. That's the carving's to fix.
- The flat green area at a river's end in the owner's screenshot (long straight edges) looks like the old ocean renderer (`globalOceanRenderer`, out of scope). Check: `qtDiag.water.tint(1)` colours lakes by id; the ocean stays as it is.

Cost of lakes and rivers for tile loading (lab, terrain-lab/water-tile-cost.mjs, owner's MacBook GPU via Dawn; 14 lakes, 5 rivers around the biggest lake):
- **Terrain function per tile** (128², height+normal+tile, depth 11):
  - carve and valley compiled out: 2.30 ms (away from rivers), 2.37 ms (on rivers);
  - compiled in: 2.46 ms away (+7 % on every tile) and 2.82 ms on rivers with data (+19 %).
- **Water service GPU sampling:** about 30 ms per dispatch (max 124 ms), about 1 per lake and 3 per river (with the valley bake). 14 lakes + 5 rivers took 27 dispatches, about 0.9 s of GPU. In the browser it's one dispatch per frame while new water comes into range, sharing the queue with tile generation.
- **Regeneration (likely the biggest multiplier in fast flight; not measured in the browser):**
  - Each traced river regenerates every resident tile touching its grid cells (a 30 km river: about 200 cells of 400 m).
  - Every river trace also bumps the global `waterCarveVersion`. So every tile generating or refining at that moment is queued again, anywhere (tileStreamer.js 2062, 2529).
  - Regeneration uses only leftover fence budget, but each one is a full tile.
- To confirm in the browser: `qtDiag.water.carve()` after a fast flight (regeneration queued/done/pending). The definitive A/B: `waterGraph.enabled: false` in runtimeConfigs.js, then the same flight.

**Next steps (owner's order, 2026-10-06; one thing at a time):**
1. ~~Rivers, geometry~~ (built, above; owner check pending).
2. Rivers, look and simulation: both working properly (the simulation strip is drawn across lakes today).
3. Rivers, carving: rivers that connect to their lakes, and a natural channel instead of the "man-made moat". These are the river-terrain session's files.
4. Lakes, last: weather-dependent geometric waves and the look. Today the sun glint (×3, power 600, on ripples) makes white blobs and speckles against the sun.
5. Optimization where needed.
- Not placed by the owner yet: diving (plan: item 7 of the earlier list below).

Earlier list, kept for the diving plan:
4. ~~Surface shading on the mesh~~ (done, above).
5. River ribbons and ownership (as planned above). Their surface terms use the same split.
6. Waves: vertex displacement in the near grid, with amplitude fading by distance.
7. Under water (owner: the water must be see-through close up, the bed must keep its real shape under the water, and the player can dive):
   - A "camera under water" state: the lake under the camera (mask) with the camera below its level. Computed on the CPU and passed as a uniform.
   - The mesh's underside: the sky and shore through Snell's window, total internal reflection outside it.
   - Fog for everything under water (terrain, actors, particles), in the tone-mapping pass. That pass already reads the scene as a texture in its own pass, and the depth texture already has TEXTURE_BINDING, so this adds no pass break. It runs only while the camera is under water.
   - While under water, the mesh writes depth, so the fog for things seen up through the surface covers only the path to the surface. The terrain shader's tint seen from above switches off, so the water isn't counted twice.
   - Facts checked 2026-10-06: no post pass reads depth today; the terrain generator doesn't change lake beds (no lake data in the terrain shaders).
8. Cost check, then set the fade distances with the owner.
