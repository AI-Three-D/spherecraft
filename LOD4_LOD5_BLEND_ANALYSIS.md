# LOD4 → LOD5 material blend: analysis

**Date:** 2026-10-02 · **Branch:** `codex-restart` @ `e41950c`
**Scope:** only the transition between LOD4 and LOD5. The LOD5 → LOD6 simplification is a separate, later task.
**Evidence base:** `TILE_SEAM_FLICKER_LOADING_EVIDENCE.md` §2 (live runs, screenshots in `screenshots/tile_analysis_2026-10-02/`) plus the code trace below. Tags: **[USER]** your observation, **[RUN]** measured in a live run, **[CODE]** read in source, **[MATH]** derived from code and config.

---

## 1. Goal

**[USER]** The highest-resolution texturing reaches all the way to the LOD4/5 line (confirmed with mode 100's magenta band and with mode 0). Right at that line, LOD5 shows a different material, and that change is the visible gap. We need LOD4's material to blend into LOD5's material across that line. The further simplification farther out is less disturbing and is not in scope.

---

## 2. What each tier draws today

| Tier | Material it computes | Blend compiled into it | Where that blend runs | Net result on screen |
|---|---|---|---|---|
| LOD0–3 | Live splat: atlas textures weighted by the splat maps | none | – | Live splat |
| LOD4 | Prebaked colour, with live splat compiled in as well | Live splat → prebake (`lod0ResolvedColorFade`) | 128–179 m from the camera | **Prebake only.** No LOD4 pixel is that close, so the blend is always finished. |
| LOD5 | Prebaked colour | Prebake → flat per-category colour (`lodEdgeToSolidColor*`) | 3–6 km from the camera | Flat, partly or fully, depending on canvas size (§3) |
| LOD6 | Flat per-category colour (solid tier) | none | – | Flat |

**Neither blend is tied to the tile.** Both depend only on camera distance with fixed windows; they don't know where a tile's edges or its neighbours are. This is not the in-tile gradient model you expected; see §6.

- **[CODE]** LOD4 takes the prebake branch whenever the fade is above 0.999 (`terrainChunkFragmentShaderBuilder.js:3644`). The fade window is `chunkWidth × 1.0 … 1.4`, and `chunkWidth` is the constant 128 m (`terrainMaterialBuilder.js:344`, `runtimeConfigs.js:226-227`).
- **[CODE]** The LOD5-only fade is compiled only for `lod === solidColorStartLod − 1` (`terrainMaterialBuilder.js:203-207`). It mixes toward `sampleChunkAverageCoarseColor`, which averages category colours from the geometry-stage tile ids (`:1271`, `:4291-4305`; config `runtimeConfigs.js:183-185`).
- **[RUN]** In mode 46, LOD4 renders yellow (prebake branch, valid data) and LOD5 red (prebake branch, valid data) (`seam_3_mode46_path.png`). LOD1–3 render the live-splat colours in the same mode.
- **The prebake is splat texturing.** It is baked per 16-m texel (LOD4) or 32-m texel (LOD5) from the same splat maps and atlas textures. Each texel samples the atlas at mip 1 (`tileGenerator.js`, `resolvedColorAtlasSampleLod`). That is why LOD4 still reads as full, splat-patterned texturing at the distances where it appears.
- **Consequence:** the switch from live splat to prebake already happens at the **LOD3/4** line, as a hard switch. You have not reported a gap there; this analysis has not examined that line either.

---

## 3. Where the gap comes from

Before any late shader step, LOD4 and LOD5 show the same material: the prebaked colour, at 16-m and 32-m texels. The gap is made by the one extra step that only LOD5 runs, the fade toward the flat colour.

**[RUN]** Evidence at one viewpoint (2.5 km altitude, 1280×800 canvas):

| Capture | Gap at the LOD4/5 line? | Image |
|---|---|---|
| Mode 43: base colour before the late steps | No | `seam_4_mode43_basecolor_before_fades.png` |
| Mode 45: base colour after the late steps | Yes, LOD5 flattened | `seam_5_mode45_basecolor_after_fades.png` |
| Mode 45 with the LOD5 fade strength set to 0 | No. The file is **byte-identical** to mode 43. | `seam_6_mode45_solidfade_off.png` |
| Mode 0 with the LOD5 fade strength set to 0 | No; LOD4 pixels unchanged | `seam_7_mode0_solidfade_off.png`, diff `seam_8_diff_solidfade_on_vs_off_red.png` |

**[MATH]** How much of LOD5 is flattened at the line depends on canvas height. The traversal splits a tile when `tileSize × lodFactor / distance ≥ 514`, with `lodFactor = canvasHeight / 1.5346`. Distances are to tile centres at sea level, so the pixel values in the table are approximate.

| Canvas height | LOD4 tile centres | LOD5 tile centres | LOD4 pixels reach out to | LOD5 pixels start at | LOD5 flat fade where LOD5 starts |
|---|---|---|---|---|---|
| 800 px | 2.1–4.2 km | 4.2–8.3 km | ≈ 5.6 km | ≈ 1.3 km | 0 near the camera, rising to about 0.9 along the line |
| 1800 px (Retina) | 4.7–9.3 km | 9.3–18.7 km | ≈ 10.8 km | ≈ 6.5 km | **1.0 everywhere**: LOD5 is completely flat |

On a Retina-height canvas, LOD5 never shows its own prebaked material; it shows the LOD6-style flat colour from its first pixel. That is the "different material" at the line, and it is why the gap is so strong on your display.

---

## 4. What still differs between LOD4 and LOD5 once the flat fade is out of the way

**[CODE]** These are all the compile-time differences between the two shader variants, with the current config values.

| Difference | LOD4 | LOD5 | Effect at the LOD4/5 line |
|---|---|---|---|
| Base material | Prebake, 16-m texels | Prebake, 32-m texels | Resolution step only; same colours |
| Flat fade (`ENABLE_LOD_EDGE_TO_SOLID_COLOR`) | absent | 3–6 km | **The gap** (§3) |
| Live splat sampled (`enableSplat = lod ≤ nearMaxLOD`) | yes, but unused for colour | no | AO only, see next row |
| AO neutralised at splat boundaries | yes | no | Small lighting difference |
| AO neutralised near coarser neighbours (`lodEdgeAOFade`, `lodEdgeFadeMaxLod: 4`) | yes, in the mode-100 band | no | Small lighting difference, by design |
| Normal maps, aerial perspective, shadows, ground field, clustered lights | same | same | none |

The micro-pattern value that LOD4 derives from the splat feeds only a commented-out line (`applyNearProceduralDetail`), so it has no effect.

So once LOD5 stops flattening near LOD4, the only colour difference left is prebake resolution. In the A/B capture that resolution step was not visible.

---

## 5. Constraints on any blend

1. **Each tile can only read its own layer.** An instance carries one array layer (`instanceBufferBuilder.wgsl.js:470-497`). LOD5 cannot read LOD4's finer prebake, and LOD4 cannot read its LOD5 parent's layer. A blend must therefore be either a function both tiers evaluate identically, or done entirely on one side so that it matches what the other side shows at the line.
2. **The LOD lines move with canvas height and field of view** (§3 table: about 2.25× farther on 1800 px than on 800 px). Any distance window must be derived from `lodFactor` and the split threshold, not fixed in metres. The current 3–6 km and 128–179 m windows are each correct for at most one display size.
3. **The tiers overlap in distance.** On 800 px, LOD5 pixels start at about 1.3 km while LOD4 pixels reach about 5.6 km. A distance fade that one tier applies and the other does not will always produce a step somewhere along the line.
4. **An edge signal already exists.** `lodEdgeAmount` (the mode-100 magenta band) marks LOD4 pixels near an edge shared with a coarser neighbour. You confirmed it lines up with the LOD4/5 line. Its width is `lodEdgeFadeWidth: 0.08` of the tile, about 160 m on a 2-km LOD4 tile. It is capped at 0.30 and compiled only for LOD0–4 (§6).
5. **The prebaked-colour array has no mip levels.** The pool excludes `resolvedColor` from mipmapping (`tileStreamer.js:262-264`). Matching LOD5's 32-m texel size from LOD4 data would need a manual 2×2 filter in the shader.

---

## 6. Your model: gradients inside the tile (not how it works now)

**[USER] Intended model.** Each tile carries its own transition. A LOD4 tile blends from LOD4 material to LOD5 material across its own extent, and reaches LOD5's material exactly at the edge it shares with LOD5. A LOD5 tile does the same toward LOD6. If the gradient spans the whole tile, or half of it, both sides match at the shared edge by construction, so there is no gap on any canvas size.

**[CODE] Current behaviour.** No material gradient is tied to the tile.

- Both material blends depend only on camera distance with fixed windows: 128–179 m in LOD4 and 3–6 km in LOD5 (§2).
- The only tile-relative signal is the edge fade behind the mode-100 band (`computeLodEdgeFade`, `terrainChunkVertexShaderBuilder.js:266`). For each vertex it takes `smoothstep(0, width, distance from each edge that borders a coarser neighbour)` in tile UV. It is 0 at such an edge and 1 beyond `width`.
  - `width` comes from `lodEdgeFadeWidth: 0.08`, and the builder clamps it to at most 0.30 of the tile (`terrainChunkVertexShaderBuilder.js:14`).
  - It is compiled only for LOD ≤ `lodEdgeFadeMaxLod` (4), so LOD5 tiles have no such signal toward their LOD6 neighbours.
  - Today it only sets AO to neutral (`lodEdgeAOFadeEnabled: true`). Its colour use is switched off (`lodEdgeResolvedColorEnabled: false`, `lodEdgeColorStrength: 0`). If switched on, it would blend toward the prebaked colour, which LOD4 already shows, so it would change nothing.

**What the in-tile model needs:**

| Need | Today | Change |
|---|---|---|
| Gradient across half or the whole tile | width capped at 0.30 | Raise the clamp at `terrainChunkVertexShaderBuilder.js:14`; set `lodEdgeFadeWidth` to 0.5–1.0 |
| LOD5 → LOD6 gradient inside LOD5 tiles | edge signal not compiled for LOD5 | `lodEdgeFadeMaxLod: 5`; drive the LOD5 flat fade by the edge signal instead of the 3–6 km window |
| LOD4 → LOD5 gradient that ends at LOD5's material | none | Blend LOD4 toward LOD5's material at the shared edge. While LOD5 shows the prebake there, that is the prebake at LOD5's 32-m texel size, made with a 2×2 filter of LOD4's own prebake. |
| LOD4 interior with live-splat detail, if wanted | LOD4 is prebake everywhere | Run the LOD4 gradient from live splat in the interior to prebake at the LOD5 edge. Live splat costs more per pixel. |

**Known trade-offs of tile-relative gradients:**

- **The shape follows the tile grid.** The comment at the LOD5 flat fade (`terrainChunkFragmentShaderBuilder.js:4284-4285`) gives exactly that as the reason a distance fade was chosen there. A gradient across half or all of the tile is far softer than today's 8 % band.
- **Corners are not covered.** The edge mask has only the four sides, so a tile that touches a coarser tile only at a corner gets no gradient there.
- **Gradients pop when a neighbour changes LOD.** The gradient depends on the neighbour's current LOD. When a neighbouring tile splits or merges as you move, the gradient switches on or off in one frame. A distance function that both tiers evaluate identically has no such pop, but its window must be recomputed per canvas size (§5).

---

## 7. Proposed approach (not implemented)

1. **Confirm on your display first** (about 1 minute).
   - Mode 46 at your gap: expect LOD4 yellow and LOD5 red.
   - Then this A/B: expect the gap to disappear and LOD4 to stay exactly as it is.

   ```js
   const ge = gameEngine;
   ge.engineConfig.rendering.terrainShader.lodEdgeToSolidColorStrength = 0; // 1 restores it
   await ge.renderer.quadtreeTerrainRenderer.rebuildMaterials();
   ```

2. **Stop LOD5 from showing the flat colour where it meets LOD4.** Two ways:

| | A. Distance window from the LOD factor | B. Gradient inside the LOD5 tile (your model) |
|---|---|---|
| Change | Compute the LOD5 flat fade's window each frame from the split distances. Start it beyond the farthest possible LOD4 pixel and end it at the LOD5/6 line; pass both as uniforms. | Make the LOD5 flat fade follow the edge signal: flat at edges shared with LOD6, prebake elsewhere. Needs the signal compiled for LOD5 and the width clamp raised. |
| LOD4/5 line | Prebake on both sides; gap gone | Prebake on both sides; gap gone (except where a LOD6 corner meets the LOD4 edge) |
| LOD5/6 line | May keep a softer step on small canvases, where LOD6 pixels can be nearer than the window's end | Gapless by construction |
| Different canvas sizes | Window recomputed per size | Works unchanged |
| Over time | No pops | Gradient switches when a neighbour changes LOD |
| Look | A shell around the camera | Follows the tile grid; soft if the gradient is wide |

   B fits your model, and one mechanism covers the LOD4/5 line now and the LOD5/6 line later. A is the smaller change if you only want the LOD4/5 gap gone first.

3. **Only if a resolution step remains at the LOD4/5 line:** add the LOD4 in-tile gradient toward a 2×2-filtered prebake at the LOD5 edge, using the same edge signal widened per your model.

4. **Verify each step at the same camera position**, before and after, with modes 43, 45 and 0 and the mode-100 band, on two canvas sizes: a normal window and your Retina full screen.

### Rejected alternatives

- **Blend LOD4 into LOD5's current flat look.** It closes the gap, but flattens LOD4's outer area into the LOD6 simplification, which is the opposite of the goal.
- **Compile the same distance fade into LOD4 as well.** That is continuous by construction, but on small canvases it flattens far LOD4 pixels too, and `sampleChunkAverageCoarseColor` costs 64 texture reads per pixel.

---

## 8. Confidence and open points

- **Verified:** the gap disappears when only the LOD5 flat fade is disabled, with mode 45 byte-identical to mode 43 and LOD4 pixels unchanged. This was at one viewpoint on an 800-px canvas. The code path is the same on any canvas, but it has not been captured on your display; that is step 1.
- **Verified:** LOD4's prebaked colour is valid (mode 46 and a texel read with alpha 1.0).
- **Verified in code:** no blend today is tile-relative; the edge signal exists only for LOD0–4, is capped at 30 % of the tile, and currently affects AO only.
- **Not verified:** whether the 16-m versus 32-m prebake resolution step is visible on a Retina display at the LOD4/5 line (decides step 3). Also not verified: how visible option B's grid shape and neighbour-change pops would be.
- **Not examined:** the LOD3/4 live-splat → prebake switch and the LOD5/6 transition.
