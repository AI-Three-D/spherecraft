# River & lake system — status log

Consolidated 2026-09-26 (replaces the old, much longer session-by-session
log and the separate `RIVER_CARVE_ZERO_HEIGHT_BUG.md`, which is now
deleted — its content is folded into "Known gotchas" below). Past failed
attempts and dead-end investigations are intentionally not preserved in
detail; only things worth knowing before touching this code again are.

## Why this exists

Phase 1 of a larger plan: spherecraft (this WebGPU planetary engine) grew
too complex — fog, streamed vegetation, terrain generation, water — for
the frame rate it delivers. The plan is (1) get rivers/lakes working as a
genuine terrain-generation feature, not a bolted-on overlay mesh — an
earlier overlay-mesh approach was explicitly rejected by the user for
exactly that reason — then (2) use that as the wedge to simplify
everything else (see "Terrain generation simplification" TODOs below).
The end goal is a small number of shared config knobs (humidity is one)
driving both biome and hydrology together, not today's large stack of
independently-layered height features.

## Current status

- **Stage 1** (always-on, per-pixel, no precompute): erosion-seed pits
  scattered via a hashed 500m region grid, gated by a crude land/
  ruggedness check (not humidity — see below), shaped as an irregular
  blob via `fbmAuto` domain-warped noise sampled at world position.
  (An earlier angle-based sine-harmonic version made a rotationally-
  symmetric "flower/clover" shape — don't go back to that approach.)
  Visually confirmed working.
- **Stage 2** (per-reference-point GPU verification,
  `ErosionSeedVerifier.js`): confirms/upgrades a subset of Stage-1
  candidates into real lakes by checking whether that candidate's own
  nudge would retain water against the natural terrain's lowest
  surrounding rim point, with the required margin scaled by local
  humidity (dry areas need a much deeper natural depression; wet areas
  need almost none) — this is the "shared knob" mechanism, not a
  separate hard precipitation cutoff. Confirmed working (9/9 near the
  demo point).
- **Lake water rendering** (`core/renderer/lakes/`): `LakeWaterSystem`
  builds one static blob-shaped mesh per confirmed lake, ripple strength
  fading with camera distance. Render pipeline itself is confirmed
  working. **Height placement is currently a debug placeholder, not the
  real value — see Known gotchas #1, must fix before this looks right.**
- **River channel tracing** (`HydrologyPrecompute.js`): more robust now
  (falls back to manual steepest-neighbor stepping when the D8 flow
  field has no answer for a cell). At the current fixed demo point the
  terrain is genuinely flat for 1km+ in every direction — correctly
  reports "no channel found" and places nothing, rather than the old
  disconnected fallback patch.
- All erosion-seed size constants are **still at temporary debug values**
  (`core/world/hydrology/erosionSeedShared.js`: 90m radius / 40m depth;
  real target ~30m/2m) for visibility during testing.

## Known gotchas (could bite us again)

1. **Lake water height is wrong, root cause not found.** The natural-
   elevation sample used for water height (`calculateTerrainHeight()`,
   probed via a standalone compute dispatch) reads a plausible, flat
   value, but placing water relative to it renders the disc *below* the
   real rendered terrain surface — confirmed empirically (descending
   until backface-culled terrain disappears is exactly where the disc
   becomes visible). A flat, arbitrary height (ignoring the natural-
   elevation calc entirely) floats correctly. So the bug is specifically
   in that elevation sample not matching what's actually baked into the
   real per-tile-generated height texture — coordinate frame, radius, and
   heightScale were all independently double-checked and are correct.
   Suspect: the standalone probe dispatch (`_fillTerrainUniformScratch()`
   + a one-off shader) may not be exercising an identical code path to
   the real per-tile batched generator. Needs to sample the real,
   resident height texture directly to confirm.
2. **WebGPU shader/pipeline creation errors are async and silent.**
   `device.createShaderModule()` / `createRenderPipeline()` return
   successfully even when compilation ultimately fails — the pipeline
   object exists and looks valid (`material._gpuPipeline` is truthy) but
   every draw using it silently no-ops. Always call
   `module.getCompilationInfo()` on new/changed WGSL before trusting it.
   A real instance of this: a stray `MoonRenderer` pipeline (unrelated to
   rivers) fails validation and appears to poison the rest of that
   frame's command buffer — reproduced only in headless Puppeteer, not
   the user's real browser; still unfixed, low priority.
3. **`ref` is a reserved WGSL keyword** — using it as a local variable
   name breaks shader compilation with no error surfaced through the
   normal creation path (see gotcha #2 on why that's easy to miss).
4. **`u32(x)` is a value conversion in WGSL, not bit-reinterpretation** —
   it's unspecified/clamped for negative inputs and a compile error for
   a negative literal. Use `bitcast<u32>()` for hashing on region
   coordinates, which are negative on half the planet.
5. **`smoothstep(hi, lo, x)` with swapped arguments silently inverts**
   instead of erroring. This exact bug once made an entire terrain
   shader read flat 0.0 everywhere. Use `1.0 - smoothstep(lo, hi, x)`.
6. **Headless Puppeteer cannot render real pixels in this environment**
   (separate from gotcha #2's specific cause) — screenshots are
   unreliable; all visual confirmation depends on the user's own browser
   testing, not automated screenshots.
7. `_fillTerrainUniformScratch()` is the correct way to build a real,
   fully-populated uniform buffer for a standalone GPU probe.
   `terrainGenerator.terrainUniformBuffer` is stale/unused by the actual
   per-tile batched generation path — don't read from it.
8. The user verifies things thoroughly before reporting them — trust a
   reported observation as ground truth and go find the root cause in
   code, rather than proposing alternative explanations that question
   whether the observation itself is accurate.

## TODO — lake/river placement (resume here)

- [ ] Root-cause and fix the lake water height bug (gotcha #1).
- [ ] Once fixed and confirmed to look right, revert all debug-only
      constants: `erosionSeedShared.js`'s radius/depth (90→30m, 40→2m),
      and `LakeWaterSystem.js`'s debug float height / bright color /
      radius multiplier.
- [ ] Add real size variance for lakes — currently they read as roughly
      uniform size. Want a wider range, including large lakes with
      elongated, irregular "ink-splash" shapes, not just noise-perturbed
      circles.
- [ ] Reduce candidate density — the 500m region grid currently produces
      far more level-1 pits than intended.
- [ ] Stage 3 (not built): river spillway — bounded downhill walk from a
      confirmed lake's lowest rim point; a dead-end walk should leave a
      small "bay" stub rather than nothing.
- [ ] Stage 4 (not built): wire confirmed lakes/rivers into one system —
      the confirmed-lake water and the single fixed-anchor demo river are
      currently two separate, unconnected systems.
- [ ] Near-field real water simulation tier for lakes (reusing
      `RiverBedBake`+shallow-water sim for whichever lake is closest to
      the camera) — not built; all lakes currently use the same static
      mesh regardless of distance.
- [ ] Generalize beyond the single fixed demo reference point to real
      planet-wide placement.

## TODO — terrain generation simplification (larger, deferred)

- [ ] Replace or heavily simplify the old global ocean system
      (`GlobalOceanRenderer` / `WaterMaterialBuilder`) — explicitly called
      "terrible looking"; consider extending the new lake-water approach
      to oceans if cost allows, otherwise redesign separately.
- [ ] Simplify or remove the fog particle system.
- [ ] Cut the streamed-vegetation/asset system down significantly.
- [ ] Reduce the terrain height-generation feature stack generally toward
      the "small number of shared knobs" end goal.
- [ ] Investigate general tile-streaming performance (reported jerky fast
      movement from slow tile loads) — separate from anything river/lake
      specific.
- [ ] Eventually profile and port perf-critical CPU-side code to WASM (no
      WASM tooling exists in this repo yet).
