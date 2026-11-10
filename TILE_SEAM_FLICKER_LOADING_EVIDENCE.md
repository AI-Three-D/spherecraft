# LOD4/5 seam, tile flicker and slow tile loading: traced causes with runtime evidence

**Date:** 2026-10-02 · **Branch:** `codex-restart` @ `e41950c` (working tree unchanged except `CLAUDE.md`)
**Supersedes:** the conclusions of `TILE_FLICKER_ANALYSIS.md` §9, `../lod4_lod5_seam_findings_v2.md` §2–4 and the seam/flicker parts of `CLAUDE.md` where they disagree with this file.
**Method:** code trace, then live runs of `wizard_game/standalone.html` from this checkout, driven headless (Chrome 154, Apple GPU) with in-page instrumentation only. No repository source file was changed.

Evidence tags used below:

| Tag | Meaning |
|---|---|
| **[RUN]** | Measured in a live run of the game on this machine. |
| **[IMG]** | Screenshot from a live run, stored in `screenshots/tile_analysis_2026-10-02/`. |
| **[CODE]** | Read directly in the source at the cited line. |
| **[MATH]** | Derived from code and config values; the arithmetic is shown. |
| **[USER]** | Observation reported by the project owner in this session. |

---

## 1. Results at a glance

| Bug | Root cause | Strength of evidence |
|---|---|---|
| Hard LOD4/5 texture seam that never goes away | LOD5's shader alone fades its colour to a flat per-category colour between 3 and 6 km (`lodEdgeToSolidColor*`). LOD4 has no matching fade, so the two sides differ by up to 100 % of that fade. LOD4's prebaked `resolvedColor` is **valid**. | Runtime A/B: switching that one setting off removes the seam, and the shader's intermediate output becomes byte-identical to the pre-fade output. |
| Squares that flash a different texture, then come back | A tile is published to the GPU lookup table when its geometry lands, before its material (refinement) exists. The instance builder always draws the nearest resident layer, refined or not. The unrefined layer's placeholder material replaces the refined coarser material that was drawn a moment before. | Runtime per-tile tracking during flight, a pause-refinement experiment that reproduces both of your screenshots, before/after pixel diffs and texel reads of the placeholder data. |
| Slow loading that falls behind | GPU cost per tile is about 22 ms, and the terrain noise is evaluated five times per finished tile. A fresh view needs 500–660 tiles, so a cold view takes 15–26 s to settle. | Measured GPU cost per tile and per output type, cold-arrival timings, CPU profile of the scheduler, and code trace of the redundant passes. |

Two earlier conclusions are wrong and are corrected in §5:

- **"resolvedColor is invalid on LOD4 100 % of the time"** is false. Mode 46 renders LOD4 yellow, which means valid prebaked colour, and a texel read gives alpha 1.0.
- **"Mode 102 looks exactly like mode 0, which confirms the data is invalid"** cannot hold. Mode 102 forces the exact branch that LOD4 already executes in mode 0, so the two must look identical whatever the data contains.

---

## 2. The LOD4/5 seam

### 2.1 What LOD4 and LOD5 actually draw

- **[CODE]** LOD4 is compiled with `ENABLE_LOD0_RESOLVED_COLOR` (`terrainMaterialBuilder.js:164`). Its live-splat → prebake fade is `smoothstep(chunkWidth × 1.0, chunkWidth × 1.4, distance)` (`terrainChunkFragmentShaderBuilder.js:2598`, config `runtimeConfigs.js:226-227`). `chunkWidth` is the constant 128 m (`terrainMaterialBuilder.js:344`), so the fade runs from 128 m to 179 m.
- **[MATH]** The traversal splits a tile when `tileSize × lodFactor / distance ≥ 514`, using the distance to the tile centre at sea level. `lodFactor = canvasHeight / (2·tan 37.5°)`.

| Canvas height | lodFactor | LOD4 tile centres | LOD5 tile centres | Nearest LOD4 fragment | Nearest LOD5 fragment |
|---|---|---|---|---|---|
| 800 px | 521 | 2.1–4.2 km | 4.2–8.3 km | ≈ 0.6 km | ≈ 1.3 km |
| 1800 px (Retina, DPR 2) | 1173 | 4.7–9.3 km | 9.3–18.7 km | ≈ 3.2 km | ≈ 6.5 km |

- **[MATH]** The LOD4 fade window (128–179 m) therefore never overlaps any LOD4 fragment. The fade is pinned at 1.0, and every LOD4 pixel takes the `lod0ResolvedColorFade > 0.999` branch (`terrainChunkFragmentShaderBuilder.js:3644`): prebaked colour if alpha ≥ 0.5, raw tile colour otherwise. **No live-splat-to-prebake blend exists anywhere in LOD4 today.**
- **[CODE]** LOD5 (and only LOD5, `lod === solidColorStartLod − 1`, `terrainMaterialBuilder.js:203-207`) applies `mix(baseColor, sampleChunkAverageCoarseColor(...), smoothstep(3000, 6000, distance) × 1.0)` (`terrainChunkFragmentShaderBuilder.js:4291-4305`, config `runtimeConfigs.js:183-185`). `sampleChunkAverageCoarseColor` (`:1271`) averages 64 per-category colours looked up from the **geometry-stage tile ids**, so it is flat by design.
- **[MATH]** On a 1800-px-tall canvas, every LOD5 fragment is ≥ 6.5 km away, so the LOD5 fade is 1.0 everywhere. LOD5 is then 100 % the flat category colour, while LOD4 next to it shows the full prebaked colour. On 800 px the LOD5 side is between 0.3 and 1.0 faded.

### 2.2 Runtime proof (seam view: 2.5 km altitude, 55° down, 1280×800)

| Step | What was done | Result | Image |
|---|---|---|---|
| 1 | Mode 90 (LOD colours) | LOD4 cyan fills the view, LOD5 blue along the top. The boundary runs across the upper quarter. | `seam_1_mode90_lod.png` |
| 2 | Mode 0 | The top band (LOD5) is smooth, flat and teal, with no sand patches. That is the seam. | `seam_2_mode0_normal.png` |
| 3 | Mode 46 (colour-path diagnostic) | **LOD4 is entirely yellow** (valid prebake, path 1) and LOD5 entirely red (valid prebake, path 2). There is no blue (fallback) pixel anywhere. | `seam_3_mode46_path.png` |
| 4 | Mode 43 (base colour before the late colour steps) | **No seam.** Sand patches and texture continue across the LOD4/5 line. | `seam_4_mode43_basecolor_before_fades.png` |
| 5 | Mode 45 (base colour after the late steps, before lighting) | **The seam appears.** Above the exact LOD4/5 line the colour is flattened and the sand patches vanish. | `seam_5_mode45_basecolor_after_fades.png` |
| 6 | Set `lodEdgeToSolidColorStrength = 0`, call `rebuildMaterials()`, capture mode 45 | The image is **byte-identical** to step 4 (md5 `fac41eda…` for both files). | `seam_6_mode45_solidfade_off.png` |
| 7 | Same setting, mode 0 | The seam is gone. LOD5 shows the same sand patches and texture as LOD4. | `seam_7_mode0_solidfade_off.png` |
| 8 | Pixel difference between steps 2 and 7 | Changed pixels (red) appear **only in the LOD5 band**. Nothing in LOD4 changes. | `seam_8_diff_solidfade_on_vs_off_red.png` |

Step 6 is the decisive one. Between the mode-43 and mode-45 return points the shader runs the macro overlay (disabled in config), the LOD-edge resolved colour (disabled), the LOD5 solid fade and the ground-field tint. With only the solid fade switched off, the two outputs are identical to the byte. So at this view, the solid fade is the only step that changes the colour, and it is the step that creates the seam.

- **[RUN]** Texel read of a refined LOD4 layer (`f1:d7:120,60`): `resolvedColor = (0.20, 0.18, 0.11, 1.0)`. Alpha is 1, so the data is valid.
- **[USER]** Your mode-101/103 readings are consistent with this. The seam sits several kilometres away, and mode 101 saturates at 2 km, so red there is the expected reading. It does not explain the seam. The real distance problem is that the LOD4 fade window is 128–179 m, which never reaches LOD4.

### 2.3 Why every earlier fix attempt changed nothing

Every attempt edited the LOD4 side: fade windows, branch logic, retry of stranded refinements, layer-reuse purge. The LOD4 side was already rendering valid prebaked colour, and the LOD4 fade is always saturated. The difference comes from a LOD5-only step, which none of the attempts touched.

### 2.4 Fix direction (not applied)

A colour step that depends on the LOD variant is continuous across a LOD boundary only if both variants evaluate the **same function of distance or world position**. Today LOD4 uses f(d) = 0 and LOD5 uses f(d) = smoothstep(3 km, 6 km, d), so the jump at the boundary equals f(d_boundary).

- **Option A:** compile the same solid fade into LOD4 as well, so both tiers compute an identical value at every distance. The step becomes zero by construction.
- **Option B:** move the fade window past LOD5's near edge, so it starts no earlier than the farthest LOD4 fragment. LOD5 then matches LOD4 at the boundary and still flattens toward LOD6.
- Either way, if a live-splat → prebake blend *inside* LOD4 is still wanted, its window must be expressed in real LOD4 distances (kilometres), not `chunkWidth` multiples.

Verify with the same three captures: mode 43, mode 45 and mode 0 at the seam view. Expected result: mode 45 shows no step at the LOD4/5 line.

---

## 3. Flashing squares (the "shuffle")

### 3.1 Mechanism

1. **[CODE]** Geometry commit inserts the tile into the CPU hash table and marks the slot dirty (`tileStreamer.js:2037`, `:2058`). The next `tickFlush` uploads it, so the tile is visible to the GPU **before refinement starts** (`_queueRefinement` is called afterwards, `:1810`).
2. **[CODE]** The geometry commit zero-fills every refinement type and fills `splatIndex` with the 255 sentinel (`tileStreamer.js:2025`, `zeroFillMissing: true`).
3. **[CODE]** For each visible leaf, the instance builder uses the tile's own layer if it is resident. Otherwise it walks up to the nearest resident ancestor (`instanceBufferBuilder.wgsl.js:470-497`). Nothing checks whether that layer is refined.
4. **[CODE]** Requests are ordered coarse-first: `priority = 100000 − 500 × depth` (`tileStreamer.js:1723`). Ancestors therefore arrive before leaves, one level at a time, and each arrives geometry-only.

Result: a visible tile drawing a **refined** coarser layer switches to a **newly published, unrefined** layer, either its own or an intermediate ancestor's. It shows placeholder material until that layer's refinement lands, then switches to the real material.

### 3.2 What the placeholder looks like per LOD (matches your two screenshots)

| LOD | Placeholder data **[RUN texel read]** | Shader path **[CODE]** | Looks like |
|---|---|---|---|
| 0–3 | `splatIndex = 255,255,255,255`, `splatData = 0` (tile `f1:d8:240,122`) | Live-splat path (`:3662`), dominant id 255, one fixed atlas layer | **Uniform green square** (your 2nd image) |
| 4 | `resolvedColor = 0,0,0,0` (tile `f1:d7:120,58`) | Alpha < 0.5, so raw tile colour from nearest-sampled per-texel ids at 16 m (`:3644-3656`) | **Speckled tile with white/sand specks** (your 1st image) |
| 5 | Same zero-fill **[CODE]** (`tileStreamer.js:2025`; not read back for LOD5) | Mostly hidden: the solid fade replaces the colour with category averages computed from geometry-stage tile ids, which exist from the first frame | No visible flash, hence **"never LOD4 inside LOD5"** |

The LOD4 raw-id look and LOD5's flat look come from the same geometry-stage tile ids rather than the splat or prebake. That is why a flashing LOD4 square resembles LOD5 material.

### 3.3 Runtime proof

**Pause-refinement experiment A** (1.1 km altitude, refinement admission paused, flown 1.4 km, then stopped):

| Image | Content |
|---|---|
| `flicker_A1_mode90_lod.png` | LOD bands of the frozen frame. |
| `flicker_A2_mode0_refinement_paused.png` | Tile-shaped regions with straight edges and different material. A large uniform-green region and a sandy wedge sit at a tile boundary. The streamer reports 48 visible tiles on their own unrefined layers: LOD1 ×8, LOD2 ×24, LOD3 ×8, LOD5 ×8. |
| `flicker_A3_mode0_after_refinement.png` | Same camera after resuming refinement. 89 queued refinements drained in 2.7 s. The green region is now sand and grass, and the straight edges are gone. |
| `flicker_A4_diff_changed_pixels_red.png` | Changed pixels lie only inside the unrefined LOD1–3 tiles. **Nothing changes in the LOD5 band**, although 8 LOD5 tiles were unrefined too. |

**Pause-refinement experiment B** (2.6 km altitude, frozen while LOD4 tiles were being created):

| Image | Content |
|---|---|
| `flicker_B1_mode0_refinement_paused.png` | White speckles on the upper-left area and on far hilltops. |
| `flicker_B2_mode46_path.png` | Those regions are **blue (raw-tile fallback)** inside the LOD4 band; the refined LOD4 rows next to them are yellow. 16 LOD4 tiles were unrefined. |
| `flicker_B3_mode90_lod.png` | Confirms the blue regions are LOD4 (cyan). |
| `flicker_B4_mode0_after_refinement.png` / `flicker_B5_diff_changed_pixels_red.png` | After refinement the speckles are gone and sand patches appear. The diff marks exactly those regions. |

**Live flight with per-tile tracking** (2880×1800 canvas, about 90 m above terrain, 15° down). Every visible-tile readback (about every 2 frames) recorded, for each visible leaf, which layer it drew (own or ancestor *k* levels up) and whether that layer was refined.

| Run | Flashes (refined → unrefined → refined) | Flash duration median / max | Types seen | Evictions |
|---|---|---|---|---|
| Stationary, settled, 5 s | 0 | – | – | 0 |
| 30 m/s, 30 s | 6 | 0.21 s / 0.23 s | all "refined parent → own unrefined" | 0 |
| 120 m/s, 30 s | 37 | 0.19 s / 0.39 s | all "refined parent → own unrefined" | 0 |
| Cold arrival (40 km jump), 15 s | 344 | 0.22 s / 8.4 s | "refined ancestor → nearer unrefined ancestor → … → own unrefined" | 0 |

- The cold-arrival log shows the **cycling** you described, step by step. For LOD4 leaves alone: 8 times "LOD7 refined → LOD6 unrefined" and 25 times "LOD6 refined → own unrefined". This is literally other-LOD data with placeholder material appearing inside a LOD4 tile.
- **Flash duration = refinement latency.** Here it was 0.2–0.4 s because this headless run had a light GPU load. In your sessions it is 1–3 s, which follows from the slower throughput described in §4.
- **[RUN] Ruled out by measurement:**
  - **Eviction:** zero evictions in the stationary and forward-flight runs, where the pool stayed at or below 1,406 of 2,048 layers. Evictions were not counted during the cold-arrival runs. None of the 344 flashes there started from a refined own layer, which is the pattern an evicted visible tile would produce.
  - **Traversal flipping:** while stationary the visible set did not change at all.
  - **Hash published before its copy:** the logged `maxPendingPerFlush` was 4, below the budget of 8.
- **[MATH]** The 4-pixel "quantization dead zone" in `quadtreeTraversal.wgsl.js:281-284` is not a dead zone. `round(e/4)·4 > 512` is the same test as `e ≥ 514`, a fixed threshold without hysteresis. That explains why it changed nothing.

### 3.4 Fix direction (not applied)

The rule that is missing: **a visible tile's material must never regress from refined to unrefined.** Two code-compatible ways, both described in `TILE_FLICKER_ANALYSIS.md` §7 (Fix 1–3):

- Publish to the lookup only after refinement whenever a refined ancestor exists.
- Or carry a "refined" bit in the lookup entry, and have the instance builder take material from the nearest refined layer while geometry comes from the nearest resident one.

Verification: the console tracker in §6.2 should report zero flashes while you move.

---

## 4. Slow loading

### 4.1 GPU cost per tile [RUN]

The generator was called directly on unused tile addresses in batches of 1 and 24 and timed to GPU completion with the render loop running at about 60 fps. The slope gives wall-clock GPU time per tile under real render load (2880×1800).

| Outputs requested | ms per tile |
|---|---|
| Geometry: height + normal + tile ids | 4.9 |
| Tile ids only (still needs base height) | 3.8 |
| Scatter only (with its height/tile inputs) | 5.4 |
| Splat data/index/valid (with inputs) | 17.1 |
| … plus resolvedColor | 18.0 |
| **Full refinement set as used today** | **17.5** |
| Everything in one single pass | 19.3 |

A finished tile costs about **4.9 + 17.5 = 22.4 ms of GPU time**, more than a whole 60-fps frame. About 12 ms of that is the splat step.

### 4.2 Why the splat step is so expensive [CODE]

- `GenPaddedTileMap`, `GenPaddedSmoothSplatWeights` and `GenPaddedSmoothSplatIds` (`webgpuTerrainGeneratorBatching.js:607`, `:625`, `:643`) all use the plain terrain pipeline (`_getTerrainPipelineForFormat`, `:578-580`), which binds only a uniform buffer and an output texture. Each pass therefore evaluates the full terrain noise from scratch over 134×134 texels.
- The refinement pass also recomputes base height, tile ids and final height as inputs (`tileGenerator.js:279`).
- So the expensive base-height noise runs **five times per finished tile**: once in geometry, once for refinement inputs, and three times in the padded splat step.
- Height-input variants of passes 2, 7 and 8 already exist and are used by the LOD batch path (`isHeightInputPass`, `webgpuTerrainGeneratorBatching.js:100`).

### 4.3 What a fresh view costs [RUN]

Camera jumped 40 km to unvisited terrain, ground level, 2880×1800 canvas:

| Measure | Run 1 | Run 2 |
|---|---|---|
| Time until every visible tile is on its own refined layer | 15.0 s | 26.0 s |
| Geometry / refinement commits | 488 / 379 | 660 / 656 |
| Geometry request → resident, median / p95 | 8.4 s / 14.6 s | 13.7 s / 25.8 s |
| Generation queue peak | 1,024 (full) | full; 902 requests rejected |
| Frame rate during the load | 37–50 fps | 38.5 fps average |

- Throughput was 25–33 finished tiles per second, which matches the per-tile cost above. The GPU is the limit.
- **[RUN] The CPU is not the bottleneck.** In run 2, 208,391 tile requests cost 0.21 s of CPU in total, and the whole scheduler plus feedback processing cost under 1 s across 26 s.
- **[USER vs RUN]** Forward flight at 30 m/s and 120 m/s near the ground kept up in this headless run (2.5 and 11.5 tiles/s needed). Your sessions fall behind at 20–40 m/s, so either demand there is higher (turning the camera brings a whole new view into the frustum at once) or throughput is lower (heavier frames). This run cannot tell which. The snippets in §6 measure both in your browser.
- **[RUN]** Right after the loading screen hides on a 2880×1800 canvas, 136 tiles are still resident but unrefined and 222 are still queued. That is the "settles after a while" phase.

### 4.4 Scheduler defects found on the way [CODE + RUN]

- **`AsyncGenerationQueue.tick()` has no return statement** (`asyncGenerationQueue.js:105-162`). As a result, `spawned` in `tickGeneration` is always 0 (`tileStreamer.js:1352`). This has two effects:
  - `[QTLight] started=` always reads 0. Observed: `started=0` while `commits=152` in the same window.
  - Refinement's budget never subtracts the geometry tasks started in the same frame. This is the over-admission the comment at `:1379` warns about.
- **Refinement is skipped whenever geometry has no fence budget.** `tickGeneration` returns at `:1341` before `_tickRefinement` at `:1357`. In cold-load run 2, refinement was considered in only 343 of 992 frames. It still kept pace there only because of the over-admission above. The fences, and therefore the GPU, remain the binding limit.

### 4.5 Fix direction (not applied), in order of payoff

1. **Compute the padded base height once** and derive padded tile ids and smooth splat weights/ids from it with the existing height-input pipelines.
2. **Feed the resident height/tile layers into refinement** instead of recomputing them, or generate near tiles in a single pass (19.3 ms instead of 22.4 ms).

From the measured breakdown, these together should bring a finished tile from about 22 ms to roughly 11 ms, about 2× the throughput. That is an estimate. Verify it with the GPU-cost snippet in §6.3.

---

## 5. Corrections to earlier documents

| Earlier claim | Status | Evidence |
|---|---|---|
| resolvedColor is invalid on LOD4 tiles 100 % of the time | **False** | Mode 46 renders LOD4 yellow (`seam_3`). A refined LOD4 texel has alpha 1.0. |
| Mode 102 looking identical to mode 0 confirms the invalid data | **Test cannot discriminate** | LOD4's fade is pinned at 1, so mode 0 already runs the branch mode 102 forces. `sampleResolvedTerrainColor` and `…Level` (`:778`, `:794`) are the same `textureSampleLevel(…, 0)` call. |
| The seam is LOD4 live splat versus LOD5 prebake | **Wrong sides** | LOD4 renders the prebake (path 1). LOD5 renders mostly the flat category colour from the LOD5-only fade. |
| The LOD4 fade window "makes the fade look like a hard step" (`TILE_FLICKER_ANALYSIS.md` §9) | **Stronger than that** | The window never overlaps LOD4 at all; the blend never executes. |
| Distance values saturating at the seam stop the blend | **Expected reading** | The seam is 4–9 km away and mode 101 saturates at 2 km. The real problem is the 128–179 m window. |
| The flicker is a material-placeholder phase (`TILE_FLICKER_ANALYSIS.md` §1–4) | **Confirmed, with additions** | Measured in flight; it includes ancestor-by-ancestor cycling and LOD-specific placeholder looks. |
| Eviction-protection lag causes the flicker | **Not observed** | Zero evictions in the flight runs; no flash in the cold runs started from an evicted refined tile. Long sessions that fill the 2,048-layer pool were not tested. |
| The quantization dead zone stabilises the traversal | **Mathematically a no-op** | It is equivalent to a fixed threshold of 514. |
| Puppeteer can't frame the terrain | **Tooling problem, now solved** | Puppeteer's bundled Chrome 131 rejects the `MoonRenderer` and `TerrainMaterial` pipelines, which invalidates every frame's command buffer, so traversal and drawing never run. With system Chrome 154 (`executablePath`) everything renders. |

---

## 6. Reproduce it yourself (browser console, `wizard_game/standalone.html`)

### 6.1 Seam A/B (about 10 s)

```js
const ge = gameEngine;
ge.engineConfig.rendering.terrainShader.lodEdgeToSolidColorStrength = 0; // 1 = current default
await ge.renderer.quadtreeTerrainRenderer.rebuildMaterials();
await ge.setTerrainDebugMode(0); // compare with the same view at strength 1; modes 43 and 45 isolate it
```

### 6.2 Flash tracker: what visible tiles do while you move

```js
(() => {
  const ts = gameEngine.renderer.quadtreeTileManager.tileStreamer;
  const F = window.__flk = { t0: performance.now(), cur: new Map(), open: new Map(), closed: [], evicts: 0, evictsVisible: 0, geo: [], ref: [] };
  const key = (f, d, x, y) => ts._makeKey(f, d, x, y);
  const src = t => { let d = t.depth, x = t.x, y = t.y, k = key(t.face, d, x, y); if (ts._tileInfo.has(k)) return ['own', k];
    while (d > 0) { d--; x >>= 1; y >>= 1; k = key(t.face, d, x, y); if (ts._tileInfo.has(k)) return ['anc' + (t.depth - d), k]; } return ['none', null]; };
  const mark = ts.markTilesVisible.bind(ts);
  ts.markTilesVisible = tiles => { mark(tiles); const now = performance.now(), seen = new Set();
    for (const t of tiles || []) { const k = key(t.face, t.depth, t.x, t.y); seen.add(k); const [s, sk] = src(t);
      const sig = s + ':' + (sk && ts._tileState.get(sk) === 'REFINED' ? 'R' : 'U'); const p = F.cur.get(k);
      if (p && p !== sig) { if (p.endsWith(':R') && sig.endsWith(':U')) F.open.set(k, { t: now, lod: 11 - t.depth, from: p, to: sig });
        if (sig.endsWith(':R') && F.open.has(k)) { const o = F.open.get(k); F.closed.push({ ...o, ms: Math.round(now - o.t) }); F.open.delete(k); } }
      F.cur.set(k, sig); }
    for (const k of [...F.cur.keys()]) if (!seen.has(k)) { F.cur.delete(k); F.open.delete(k); } };
  const ev = ts._evictTile.bind(ts);
  ts._evictTile = k => { F.evicts++; if (ts._lastVisibleKeySet?.has(k)) F.evictsVisible++; return ev(k); };
  const ct = ts._commitTile.bind(ts);
  ts._commitTile = async (a, tx, tel) => { const r = await ct(a, tx, tel); if (r && tel) F.geo.push(performance.now() - tel.requestTime); return r; };
  const cr = ts._commitRefinement.bind(ts);
  ts._commitRefinement = (a, tx, tel) => { const r = cr(a, tx, tel); if (r && tel) F.ref.push(performance.now() - tel.requestTime); return r; };
  const pct = (a, p) => a.length ? Math.round(a.slice().sort((x, y) => x - y)[Math.floor(p * (a.length - 1))]) : null;
  F.report = () => { const d = F.closed.map(c => c.ms), types = {};
    for (const c of F.closed) { const t = `LOD${c.lod} ${c.from} -> ${c.to}`; types[t] = (types[t] || 0) + 1; }
    console.table({ seconds: Math.round((performance.now() - F.t0) / 1000), flashes: F.closed.length, flashMedianMs: pct(d, .5), flashP90Ms: pct(d, .9),
      flashMaxMs: pct(d, 1), evictions: F.evicts, visibleEvictions: F.evictsVisible, geometryCommits: F.geo.length,
      geometryLatencyMedianMs: pct(F.geo, .5), geometryLatencyP95Ms: pct(F.geo, .95), refinementLatencyMedianMs: pct(F.ref, .5),
      refinementLatencyP95Ms: pct(F.ref, .95), generationQueue: ts._generationQueue.queue.length });
    console.table(types); };
  F.reset = () => { F.t0 = performance.now(); F.closed = []; F.geo = []; F.ref = []; F.evicts = 0; F.evictsVisible = 0; };
  return 'installed: move around, then run __flk.report()';
})();
```

How to read it: `own:U` means the tile draws its own unrefined layer, and `ancN` means it draws an ancestor N levels up. A row such as `LOD4 anc1:R -> own:U` is one flash. Install it once per page load; reload the page to remove it.

### 6.3 GPU cost per tile (stand still, queue empty)

```js
(async () => {
  const { TileAddress } = await import('/core/world/quadtree/tileAddress.js');
  const ts = gameEngine.renderer.quadtreeTileManager.tileStreamer, gen = ts.tileGenerator, dev = gen.terrainGen.device;
  let n = 0;
  const batch = async (N, types) => { await dev.queue.onSubmittedWorkDone();
    const addrs = Array.from({ length: N }, () => { const i = n++; return new TileAddress(5, 7, 5 + (i % 100), 70 + Math.floor(i / 100)); });
    const t0 = performance.now(); const out = await Promise.all(addrs.map(a => gen.generateTile(a, null, types)));
    await dev.queue.onSubmittedWorkDone(); const ms = performance.now() - t0; out.forEach(t => ts._destroyGeneratedTextures(t)); return ms; };
  const slope = async types => ((await batch(24, types)) - (await batch(1, types))) / 23;
  console.table({ geometryMsPerTile: +(await slope(ts._geometryTypes)).toFixed(1),
    refinementMsPerTile: +(await slope(ts._refinementTypes)).toFixed(1),
    singlePassMsPerTile: +(await slope([...ts._geometryTypes, ...ts._refinementTypes])).toFixed(1) });
})();
```

### 6.4 Headless setup used here (for future agents)

- Puppeteer launch options: `executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`, `headless: "new"`, `args: ["--enable-unsafe-webgpu"]`, `defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 2 }`.
- Camera: switch to manual with `gameEngine.toggleCameraMode()`, then set `gameEngine.camera.position`, `.target` and `.up` each frame from a `requestAnimationFrame` loop.
- Read visible tiles from `tileStreamer._lastVisibleTilesList`. Calling `quadtreeGPU.readVisibleTiles()` directly collides with the engine's own staging buffer.
- `[QTLight]` logging consumes `consumePressureWindow()`, so per-phase pressure windows read empty unless you count commits yourself.

---

## 7. Raw numbers

- **Seam view:** camera 2,500 m above sea-level radius, 55° down, canvas 1280×800, lodFactor 521.3. Visible depths: 1–3 = 32, 4 = 6, 5 = 8, 6 (LOD5) = 12, 7 (LOD4) = 16.
- **Stationary baselines:** 74 visible tiles at 800 px and 256–272 at 1800 px. In every baseline, 0 tiles were unrefined, 0 drew an ancestor, and 0 changes occurred.
- **Flight runs** (1800 px, 560 m above sea-level radius):

| Run | Distance | Commits (geometry / refinement) | Geometry latency p50 / p95 | Refinement latency p50 / p95 | Frame rate |
|---|---|---|---|---|---|
| 30 m/s | 900 m | 76 / 76 | 28 / 208 ms | 102 / 246 ms | 42–61 fps |
| 120 m/s | 3.6 km | 344 / 350 | 24 / 295 ms | 61 / 264 ms | 41–58 fps |

- **Pause experiments:**
  - **A:** 224 visible tiles, 48 on their own unrefined layers; draining took 2.7 s.
  - **B:** visible tiles by LOD were LOD3 48, LOD4 48, LOD5 26, LOD6 22, LOD7 18, LOD8 4. Unrefined: LOD3 24, LOD4 16, LOD7 2. Draining took 5.9 s.
- **First headless session** (bundled Chrome 131, generation only): `submitToFence` p50 about 110 ms; `bpSkips` 77–83 per 120-frame window; `started=0` alongside `commits=152`.

---

## 8. Flicker fix and flat-tier refinement skip (2026-10-02, uncommitted)

### 8.1 Flicker fix: geometry and material resolved separately

- **Material-complete flag:** each GPU lookup entry carries it in its spare word, bit 0 of `LoadedEntry._pad`. `TileStreamer._markMaterialCompleteForFlushedCopies` sets it right after the refinement copy is submitted and before the dirty hash slots are uploaded.
- **Geometry** comes from the nearest resident layer, as before (`resolveGeometrySource`). Edge stitching uses the same rule.
- **Material** comes from the nearest layer with the flag set (`resolveMaterialSource`). The material layer and its level offset are packed into `neighborLODs.y`: bit 4 means "none", bits 8–19 hold the layer and bits 20–24 the levels. The vertex shader rebuilds the material UV transform and passes it in the former `vTileUv` slot, now `vMaterialUv`. All splat and prebaked-colour reads use it.
- **No refined material anywhere above a tile** (bit 4): detail tiers draw the flat tier colour instead of the old placeholder.
- **Second bug fixed: ancestor UV offset.** The old fallback loop summed coordinate bits in reverse order. On a cold arrival, 174 of 211 fallback instances sampled the wrong part of their ancestor; afterwards 0 of 289 did.
- **Off switch:** `gpuQuadtree.preferCompleteMaterialLayers: false` restores the old behaviour, with every resident layer counting as a material source.

A first version also took geometry from the complete layer, which opened cracks at tile edges while refinement was pending. That version was replaced; the measurements below cover the replacement.

**[RUN] Results** (headless Chrome 154, 2880×1800):

| Test | Before | After |
|---|---|---|
| Fallback instances with a wrong UV offset, cold arrival | 174 of 211 | 0 of 289 |
| Flashes, 30 m/s / 120 m/s / cold arrival | 6 / 37 / 344 | 0 / 0 / 0 (measured on the first version; material selection is unchanged in the split version) |
| Pause refinement, then resume: pixels that change | 11.6 % | 0.09 % (first version) |
| Crack pixels, frozen half-refined frame | – | first version 407, split version 5 |
| Same frozen frame, split version vs old geometry rule: terrain pixels that differ | – | 0 below the horizon, 53 edge pixels at the horizon |

### 8.2 Flat-tier tiles skip the splat and prebaked-colour outputs

Tiles drawn by the flat tier (`solidColorStartLod` and coarser) now refine only `scatter` and `climate`. The splat step is about 12 of the 17.5 ms GPU per refinement. These layers never get the material-complete flag. Switch: `gpuQuadtree.solidTierSkipsDetailMaterial`.

**[RUN] Results**
- **Vegetation inputs unchanged:** scatter and climate are byte-identical with and without the skip, on 8 tiles at depths 6–9 with real vegetation data.
- **Settle time after a 40 km jump** (same session, alternating order):

| Pair | Skip on | Skip off |
|---|---|---|
| 1 | 15.4 s | 30.3 s |
| 2 | 16.3 s | 23.9 s |

- Zero flashes and zero GPU errors in all four runs.

### 8.3 Open points

- **Not yet measured in isolation:** the flat-colour fallback costs 64 texture reads per pixel on every detail pixel without refined material. That is most of the screen during a cold load, so it may lower FPS while loading.
- **GPU sharing:** every number above came from a headless browser sharing the GPU with the user's browser. Absolute timings and FPS are therefore pessimistic, and they disturbed the user's own session while the tests ran.
