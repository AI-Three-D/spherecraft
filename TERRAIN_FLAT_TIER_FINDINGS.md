# Far terrain: tile checkerboard, furrows, grain, shuffling (lab-measured)

**Date:** 2026-11-10 · **Branch:** `terrain-flat-tier-fixes` (from `fix-terrain-seam-cracks` @ `6d4b7f5`)

Everything below was measured with the lab in §2, headless on this machine's GPU, at the owner's camera poses. Earlier rounds on this branch reasoned from the code without rendering. Two of their fixes did not work; see §6.

---

## 1. Result

**Prototype 2** (the branch default): the flat colour is baked as the expected colour of the dithered tile draw and sampled at mip 0. The detail-to-flat blend is by camera distance only.

| Pose | Seam step at tile edges (final image), baseline → prototype 2 | Change when every tile goes one LOD finer (final image), baseline → prototype 2 |
|---|---|---|
| 10.7 km (first screenshots) | 1.58 → **0.02** | 4.52 → **1.68** |
| 8.4 km (latest screenshots) | 2.16 → **0.17** | 5.13 → **1.96** |
| 2 km (detail tiers + blend zone) | 0.97 → **0.15** | 1.57 → **1.01** |

Units are mean RGB step, 0–255. "Seam step" is the colour step across tile-edge pixel pairs minus the step 2–3 px beside them along the same line. "LOD change" is the mean difference where a pixel's LOD changed, with the blend zone pinned at the same distances (as in flight).

- **Baseline:** the LOD-change difference fills **whole tiles**: each tile's grain changes as a block when it splits (the "shuffle").
- **Prototype 2:** only **thin outlines along sand/grass borders** change: the border is drawn at a different texel size. No tile-shaped change remains. That is the slight distant pop the owner accepted.
- **No furrows, grain or tile edges** remain in the 10.7 km and 8.4 km views.

The detail-to-flat colour handover also matches better. Mean 32-px block difference between the detail tiers' own colour and the flat colour at 2 km, with the blend off:

| Band | Baseline | Prototype 2 |
|---|---|---|
| LOD0–3 | 6.7 | 5.3 |
| LOD4 | 5.0 | 2.6 |

---

## 2. The lab

```
python3 server.py        # or any static server of this checkout; --url for another port
node tools/perf/flatTierLab/flatTierLab.mjs OUT_DIR --pose alt8k|alt10k|alt2k [--fix 0,2] [--override '{"key":value}'] [--no-lod-test]
```

**Setup:**
- Loads `standalone.html?labNoClouds=1&terrainFix=N` in the system Chrome, headless. Needs the `puppeteer-core` and `pngjs` dev dependencies.
- Holds the pose and fixes the sun, then waits until every visible tile has its own layer and all queues are empty.

**Captures per prototype:**
- Final image (debug mode 0).
- LOD view (90).
- Tile mask (new mode 107: one colour per tile).
- Flat colour, unlit (105).
- Base colour, unlit (45).
- Lighting alone (91, N·L).

**Repeat run:** then everything again with `lodErrorThreshold / 2` (every tile one LOD finer, blend zone pinned).

**Output:** PNGs and `results.json`. Metrics are in `metrics.mjs`, unit-tested with synthetic images.

---

## 3. Causes (measured)

**At 8–11 km, every tile is the flat tier.** Mode 90: LOD5 near, LOD6/7 far. The detail-to-flat zone only exists below about 7 km on this window.

**Seams, grain and furrows are all in the flat colour, not the lighting.**
- Mode 105 (flat colour, unlit) shows all three.
- Mode 91 (lighting) shows none: seam step 0.06, LOD change 0.3, against 2–5 for the colour.

The old bake (`TileGenerator._runCoarseColorPass`, window mode) explains them:
- **Seams:** it averages 64 tile ids in a 1434 m window that is clamped at the tile's own edge, so neighbouring tiles average different ground at their shared edge.
- **Grain:** the ids are a deliberate dither. Each cell draws one of two competing surface families at random, so 64 jittered samples per texel leave noise.
- **Shuffle:** that noise is different for every LOD, so a tile's grain changes as a block when it splits.
- **Furrows:** structured noise from the same bake. Removing the micro relief (round 1) did not remove them; replacing the bake did.

---

## 4. The fix

**The expected colour of the draw.** The fallback classifier (`resolveTileTypeFromWeights`, `surfaceCommon.wgsl.js`) keeps the two strongest surface families and draws one with a dithered threshold. It now records both candidate tile ids and the first one's weight (`gTileDraw`).
- The tile pass writes them into the spare `.gba` of its rgba8 staging texture. Every tile id reader decodes `.r` only, and the resident r8 copy keeps `.r` only.
- The bake writes wA·colour(A) + (1−wA)·colour(B) per texel: no window, no samples, no hash. It is a function of position only, so it is the same on both sides of every tile edge and at every LOD.
- Cost: 1 texture load per texel instead of 64, plus one extra family selector call per texel in the tile pass.
- The authored-biome path does the same with its two most probable biomes (`gBiomeTop2`), for when it is active (§5).

**Mip 0.** The bake output is sampled at mip 0, as before.

**Distance-only blend** (prototypes 2–3).
- The in-tile edge ramp is off: it switches whenever a neighbour tile splits or merges.
- The distance ramp ends before the first flat tile can appear (safety 1.0).
- Measured: slightly better than the old blend (1.01 vs 1.11 LOD change at 2 km).

---

## 5. Found on the way, not changed

- **The authored biomes in `wizard_game/world/biomes.json` are not used on the GPU.**
  - The `WebGPUTerrainGenerator` constructor calls `setPlanetConfig()`, which packs them, then sets `this._packedBiomeUniforms = null` (`webgpuTerrainGenerator.js:174` then `:181`). The GPU biome buffer is uploaded from that field, so it stays zero.
  - Read back from the GPU: `biomeCount = 0` while 4 biomes are authored. Every tile is classified by the legacy fallback.
  - Fixing it would change the whole world's look, so it is left for the owner to decide.
- **The biome hash uses (x, z) of the sphere point,** so near the equator its 8 m cells stretch north–south. This shapes the near-ground dither, not the flat colour.
- **Remaining LOD change at 2 km (≈1.0)** is in the detail tiers' own base colour: live splat at LOD0–3, prebake at LOD4. It is mostly fine grain, not tile blocks.
- **The flat colour is 3–7 levels darker than the detail tiers' average** (category average colours). A global tweak, not yet done.
- **Sand/grass borders are stepped at the texel size.** This is the remaining outline pop. A small, LOD-independent softening of the weights is the candidate if it shows.

---

## 6. What did not work (and why)

| Tried | Lab / owner result | Reason |
|---|---|---|
| Round 1: micro relief removed from LOD3+ | Furrows stayed, new pop at LOD2/3 | Furrows are in the colour; per-LOD switch |
| Round 1: 3-/7-texel box bake + mip sampling | "Grainy as anything", shuffles | Exposes the per-texel dither; differs per LOD |
| Round 2: authored-biome expected colour | Never ran: bake fell back to the old window | `_packedBiomeUniforms` is null (§5) |
| Mip-filtered sampling of the flat colour | Worse: LOD change 6.0 vs 2.6 at 8 km | Mip level follows the tile's texel size, so blur changes at every LOD boundary |

---

## 7. Prototypes (G in `standalone.html`, or `?terrainFix=N`)

| G | Flat colour | Near blend |
|---|---|---|
| 0 | baseline: 1434 m jittered window | distance ramp (safety 0.5) + in-tile edge ramp |
| 1 | expected colour of the draw | as 0 |
| 2 | **expected colour of the draw** (default) | distance only, ends before the first flat tile |
| 3 | expected colour of the draw | as 2, zone ≈ 1.7× longer |

---

## 8. Files

| File | Change |
|---|---|
| `templates/terrain-shaders/surfaceCommon.wgsl.js` | `gTileDraw`, `surfaceFamilyTileId`; the fallback classifier records its two candidates |
| `core/world/shaders/webgpu/biomeScoring.wgsl.js` | `gBiomeTop2` (authored path) |
| `core/world/shaders/webgpu/advancedTerrainCompute.wgsl.js` | Tile pass writes the draw to `.gba`; micro pass `select` → `if` (same output) |
| `core/world/quadtree/tileGenerator.js` | `buildCoarseColorBakeWGSL` (exported) with the draw mode; the bake reads the staging texture; `coarseColorSource` |
| `core/world/quadtree/tileStreamer.js`, `GPUQuadtreeTerrain.js` | `coarseColorSource` passed through |
| `core/renderer/terrain/shaders/webgpu/terrainChunkFragmentShaderBuilder.js` | Debug mode 107 (tile mask) |
| `core/EngineConfig.js`, `wizard_game/runtimeConfigs.js` | `coarseColorSource`; defaults = prototype 2 |
| `wizard_game/terrainFixPrototypes.js`, `standalone.html` | Prototypes, G key, `?terrainFix=N`, `?labNoClouds=1` |
| `tools/perf/flatTierLab/` | The lab and its metrics (+ tests); `package.json`: `puppeteer-core`, `pngjs` |
