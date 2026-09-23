# Bug report: river channel carve never manifests — terrain height reads flat 0.0 everywhere sampled

Status: **RESOLVED** (same session, immediately after this report was
written). Two independent, unrelated root causes were found and fixed —
see "Resolution" at the bottom. Read `RIVER_WALKING_SKELETON_LOG.md` first
for full history/context; this file only covers what happened after that
log's last entry.

## One-line summary

With tile residency now fixed (see "What was fixed first" below), the
demo river's carved channel still does not appear in-game — visually
confirmed by the user in a real (non-headless) browser. Direct GPU
readback of the real, resident, full-depth terrain height at the river
anchor is **bit-exact 0.0 across the entire 128×128m patch**, and — more
suspiciously — bit-exact 0.0 at several other unrelated tiles checked
elsewhere on the same planet too. That second fact means this may not be
a river-specific bug at all; it needs to be re-scoped before fixing.

## User-visible symptom (confirmed, this session)

User opened `wizard_game/standalone.html` in a real browser and flew to
the spawn point. Screenshot: same flat, pale/white translucent water
patch sitting on top of un-carved rolling terrain as in every prior
screenshot in the log — no depression, no channel, no bank, water
appears to float/pool over whatever terrain happens to be there. This is
**after** the residency fix below, so residency was not the (or not the
only) blocker.

## What was fixed first (context, already done, not the bug this file is about)

Prior session's Finding 3 (`RIVER_WALKING_SKELETON_LOG.md`, "still-open"
at end of log) guessed the bed-bake's hash lookup was somehow lagging
behind confirmed tile residency. That guess was wrong. The actual root
cause, found and fixed this session:

- `GPUQuadtreeTerrain.prewarmWorldPosition()` queues tiles via
  `TileStreamer._queueTile()`, which is shared with the normal per-frame
  camera-feedback request path.
- That path's generation queue (`AsyncGenerationQueue`, via
  `tileStreamer.js`'s `shouldDrop` closure, originally ~line 600) drops
  any queued-but-unstarted tile at depth ≥ `_freshnessMinDepth` (5) once
  it's been waiting more than `_freshnessSkipThresholdMs` (200ms) without
  being "seen" in camera feedback (`_requestFreshness`).
- Normal tiles get that freshness timestamp refreshed every frame by the
  camera/feedback system. Prewarm's one-shot batch never touches that
  path, so its deepest tiles (lowest priority: `depthPriority = 100000 -
  depth*500`) starve behind other queue traffic and get silently dropped
  before they ever start generating.
- Confirmed live: after manually re-triggering `prewarmWorldPosition()`,
  `_generationQueue.droppedCount` went from 0 to 86, and depth 10/11
  residency near the anchor never completed no matter how long the
  session ran.

Fix applied: prewarm-sourced tile requests are now tagged (`TileStreamer
._prewarmKeys`, a `Set`) and exempted from the freshness drop, exactly
like the existing "never drop coarse tiles" exemption right above it in
the same `shouldDrop` closure. Scoped narrowly — only
`prewarmWorldPosition()` passes `{ prewarm: true }` through
`_queueDepthRangeAtWorldPosition()` → `_queueDepthRangeAtFaceUV()` →
`_queueTile()`; `_updatePredictiveStreaming()`'s existing (working)
behavior is untouched.

Files touched: `core/world/quadtree/tileStreamer.js` (constructor ~line
577-590, `shouldDrop` ~611-613, `_queueTile` ~1207-1282),
`core/world/quadtree/GPUQuadtreeTerrain.js` (`_queueDepthRangeAtFaceUV`
~387/417, `_queueDepthRangeAtWorldPosition` ~423-430, `prewarmWorldPosition`
~443-460).

Verified live (headless, real GPU via `--use-angle=metal`), fresh cold
start, no manual intervention: `tileStreamer.getHashTableStats().byDepth`
reached `{"11": 9}` (full 3×3 neighborhood at max depth) on the first
attempt, and `riverDiag()` reported `state: "ready"`,
`cellsAcceptable: 16384/16384` (previously always 0/16384). **This part
of the fix is solid — residency is no longer the blocker.**

## The actual bug this file is about

Once residency was fixed, direct readback of the real generated height
data showed the carve isn't landing.

### Data collected (this session, live headless GPU, real values, no rounding)

Raw `RiverSystem._lastBedArray` (the 128×128 Float32Array read back
straight off the GPU bed-bake buffer, full precision, for the resolved,
`ready`-state bake):

```js
min: 0, max: 0, center: 0
sampleRow64: [0,0,0,0,0,0,0,0,0,0]   // first 10 cells of the center row
```

The **entire patch is bit-exact 0.0**, not "small" or "near sea level" —
exactly `0`. This was checked with no diagnostic-function rounding in
the way (bypassed `window.riverBed()`'s own summary, which itself also
reported `minBed:0, maxBed:0, avgBed:0, centerBed:0` — consistent).

`RiverSystem._lastBakeDebug` for the center cell:
```json
{
  "face": 1, "depth": 11, "layer": 1662,
  "u": 0.4999980926513672, "v": 0.5000019073486328,
  "height": 0
}
```
`depth: 11` confirms this is reading the finest, fully-resident,
already-carved-in-theory tile — not a coarse fallback.

Live-verified river uniforms (`window.gameEngine.planetConfig
.terrainGeneration.toShaderUniforms()`), confirming the carve *should* be
enabled and parameterized correctly at generation time:
```json
{ "riverAnchor": [-1,0,0,1], "riverChannelDir": [0,1,0,0], "riverParams": [16,3,128,0] }
```
(`riverAnchor.w = 1` ≥ 0.5, so `featureRiverHeight()`'s early-out guard
at `templates/terrain-shaders/features/featureRivers.wgsl.js:42` does
NOT trigger — the feature should be active.)

**The suspicious part**: `window.qtDiag.heightSignature(face, depth, x,
y)` was also run against several tiles with **no relation to the river**
(different faces, different depths, e.g. `[0,4,8,8]`, `[2,4,8,8]`,
`[1,4,7,8]`, `[1,2,1,2]`) — every single one came back
`{nw:0, ne:0, sw:0, se:0, c:0}`. Every corner and center, everywhere
checked, bit-exact zero.

That last fact means the flat-0 reading at the river anchor **might not
be a river bug specifically** — it's consistent with either:

1. The river carve genuinely isn't landing (e.g. suppressed by something
   else — see hypotheses below) AND the terrain generally happens to be
   very flat/low-relief near sea level in this demo world, OR
2. `qtDiag.heightSignature()` / the height-texture readback path itself
   is unreliable or reading the wrong thing in this environment, OR
3. Something dispatch-order/timing related returns pre-generation /
   zero-initialized texture contents for `heightSignature`'s ad-hoc query
   specifically (as opposed to the bed-bake's own dedicated read path,
   which uses a different lookup mechanism).

The user's real-browser screenshot (not headless) still shows a flat,
un-carved water patch — so whatever this is, it is **not** purely the
documented pre-existing headless-canvas rendering bug (that bug is about
the canvas swap chain never presenting frames in headless Chromium/
SwiftShader; it doesn't explain a real, non-headless browser also
showing no carve). This makes explanation (1) more likely than (2)/(3),
but none of the three has been ruled in or out with certainty.

### Leading hypothesis: ocean/land height blend suppresses the carve

`templates/terrain-shaders/base/earthLikeBase.wgsl.js`,
`calculateTerrainHeight()`:

```wgsl
// ...
landHeight += featureRiverHeight(wx, wy, unitDir, seed, regional, profile, amp);  // line 221
// ...
var height = mix(oceanHeight, landHeight, landBlend);   // line 237
return softClampHeight(height, -1.1, 1.8, 0.25);
```

`landBlend = smoothstep(0.15, 0.45, regional.landMask)` (line 179). The
river carve is only ever added into `landHeight`. If
`regional.landMask` at the demo anchor is below ~0.45 (or, worse, below
0.15 → `landBlend = 0` exactly), the final blended `height` is partly or
entirely `oceanHeight` — which has **no river contribution at all** —
regardless of whether `featureRiverHeight()` computed a correct -3m dip
into `landHeight`. This would explain a flat/near-flat result at the
river specifically without needing anything to be "broken" in the carve
math itself (which the log's Session 5 already verified correct in
isolation, log:1394-1433, "-3.00m at centerline tapering to 0 by 24m" —
that was checked by directly re-evaluating `featureRiverHeight()`'s own
math standalone, not through the full blended pipeline).

This does **not** explain the zero readings at the unrelated,
non-river tiles from `heightSignature`, though — unless this whole demo
planet/config is mostly ocean-classified at low landMask nearly
everywhere, which would be a separate, bigger finding worth checking
directly (e.g. by querying `regional.landMask` — no existing JS
diagnostic exposes it directly; would need one added, or an isolated
shader re-assembly script in the `riverdirect.mjs` style the log used
for Session 5's math verification).

### Other hypotheses not yet checked

- Depth-11 tiles might be generated via a "micro-detail refinement" pass
  layered on top of a coarser parent's height (see the `isMicroPass`
  branch in `core/world/terrain-generator/webgpuTerrainGeneratorAtlas.js`,
  around the `type === 4/5/6` checks) rather than by calling
  `calculateTerrainHeight()` (and hence `featureRiverHeight()`) directly.
  If so, the carve — which only exists inside `calculateTerrainHeight()`
  — would never apply to fine tiles at all, only to whatever coarser
  "macro" pass seeds them, and micro-refinement would just add detail
  noise on top of an already-uncarved parent height. **Not yet
  confirmed** which pass actually produced the depth-11 tile at the
  anchor (`layer: 1662`, per `_lastBakeDebug`) or whether that pass calls
  `calculateTerrainHeight()`.
- `qtDiag.heightSignature()`'s own read path was not code-reviewed this
  session — worth checking it samples the same texture/layer/format the
  bed-bake does, and isn't itself the bug (would explain the suspicious
  "even unrelated tiles read 0" result independent of rivers entirely).
- `softClampHeight(height, -1.1, 1.8, 0.25)` (line 239) — ruled out as
  the direct cause of losing the carve specifically (a -0.0006 normalized
  perturbation, `depthM/maxTerrainHeightM = 3/5000`, is nowhere near
  this clamp's -1.1/1.8 range), but the *base* height feeding into it
  being suspiciously exactly 0 everywhere was not traced further upstream
  than `landHeight`/`oceanHeight`/`landBlend`.

## Suggested next steps, in order of cheapest-to-most-invasive

1. Add a diagnostic that exposes `regional.landMask` (and `landBlend`,
   `oceanHeight`, `landHeight` separately, pre-`mix`) for a given
   face/depth/tile/pixel, or extend the existing debug-buffer pattern in
   `riverBedBakeShader.wgsl.js` to also dump these intermediate values —
   this would immediately confirm or rule out the ocean/land-blend
   hypothesis without guessing.
2. Independently verify whether `heightSignature()`'s read path and the
   bed-bake's read path agree on a tile that's *expected* to have visible
   relief (e.g. near the mountain silhouette visible in the user's own
   reference screenshots) — if `heightSignature` also reads 0 there, the
   diagnostic itself is the bug, not terrain generation.
3. Trace which generation pass (`isMicroPass` vs the full
   `calculateTerrainHeight()` pass) actually produced the resident
   depth-11 tile at the anchor, to rule in/out the micro-refinement
   hypothesis.
4. Only after 1-3: decide whether the fix is (a) moving the demo river
   anchor to a location with higher `landMask`, or (b) changing the
   land/ocean blend so `featureRiverHeight()`'s contribution isn't
   suppressed near the coast/sea-level — (b) touches shared terrain-blend
   logic used by every biome, so treat it as an architectural decision,
   not a quick patch.

## Repro

`python3 server.py` (serves on :8000, no-cache headers already set), open
`wizard_game/standalone.html`. Console diagnostics used this session,
all still available: `window.riverDiag()`, `window.riverBed()`,
`window.gameEngine.renderer.riverSystem._lastBedArray` /
`_lastBakeDebug`, `window.gameEngine.renderer.riverSystem.tileStreamer
.getHashTableStats()`, `window.qtDiag.heightSignature(face, depth, x, y)`.

## Resolution

Two completely separate, unrelated bugs were causing this, found via live
headless-GPU probing (real Dawn/Metal backend, `--use-angle=metal`) against
the actual running game — no standalone/isolated re-assembly this time,
direct introspection of the live `terrainGenerator` instance.

### Root cause 1 — the entire terrain-height shader had a fatal WGSL compile error

`tg.terrainShaderModule.getCompilationInfo()` (called live, against the
exact module object the real game dispatches every frame) returned a real
`error`, not a warning:

```
3983:19 smoothstep called with 'low' (0.6) not less than 'high' (0.3)
    let gentleW = smoothstep(0.6, 0.3, charA);
```

Per the WGSL spec, `smoothstep(low, high, x)` is a shader-creation error
when `low`/`high` are both const-expressions and `low >= high`. Several
places in the terrain shaders used `smoothstep(high, low, x)` as a
shorthand for an *inverted* transition (a common GLSL-era idiom) — WGSL
doesn't allow it. A scripted scan
(`grep`-equivalent over every `templates/terrain-shaders/**/*.wgsl.js` and
`core/world/shaders/**/*.wgsl.js` file for literal `smoothstep(a, b, ...)`
with `a >= b`) found **5 instances**, all now fixed via the exact algebraic
identity `smoothstep(hi, lo, x) ≡ 1 - smoothstep(lo, hi, x)` (verified:
`s(t) + s(1-t) = 1` for the standard cubic smoothstep, so this is not an
approximation):

- `templates/terrain-shaders/features/featureMesoDetail.wgsl.js:186,187,219`
- `templates/terrain-shaders/base/earthLikeBase.wgsl.js:182,184`

**This is why terrain read as bit-exact 0.0 everywhere, river-related or
not**: a shader module with a creation error still gets returned as a JS
object (WebGPU's deferred-validation model), and pipelines/dispatches built
from it silently no-op instead of throwing — so every `type: 0` (height
base) compute pass was producing nothing, leaving the height array texture
at whatever it was zero-initialized to. Confirmed via
`getCompilationInfo()` on the live module going from 1 error → 0 errors
after the fix, and via `window.qtDiag.heightSignature()` on several
unrelated tiles going from all-zero to genuinely varied real values
(e.g. `-0.607`, `0.150`, `-0.175`) immediately after.

This explains hypothesis (2)/(3) from the section above being partially
right for the wrong reason — it wasn't the micro-pass architecture or the
diagnostic tooling, it was that *nothing* was computing real height at
all, anywhere, this whole session.

### Root cause 2 — river uniforms were never written on the actual tile-generation code path

With root cause 1 fixed, terrain height was real and varied again, but the
river channel still didn't show up — confirmed by directly bumping the
demo river's configured depth from 3m to 60m (and halfWidth 16m→20m) via
`gameEngine.planetConfig.terrainGeneration.river`, evicting the resident
anchor tiles, forcing real regeneration through the production pipeline
(`prewarmWorldPosition`), and finding **zero measurable change** in the
regenerated bed — a 60m channel would have been impossible to miss, so the
carve wasn't landing at all, regardless of magnitude.

Traced by monkey-patching `tg._writeRiverUniforms` to log every call while
forcing a real regeneration of the anchor's tiles: **zero calls**, across
79 regenerated tiles. `_writeRiverUniforms(v, uniforms)` (which packs
`riverAnchor`/`riverChannelDir`/`riverParams` into uniform buffer bytes
400-447) is only ever called from `webgpuTerrainGeneratorAtlas.js` (a
single-tile-dispatch path). The actual path that generates every real,
resident gameplay tile is the *batched/chunked* one —
`webgpuTerrainGeneratorBatching.js`'s `_writeBatchedTerrainUniforms()` →
`_fillTerrainUniformScratch()` — which independently packs the same
uniform buffer layout but, at
`webgpuTerrainGeneratorBatching.js:362-363`, only called
`_writeTerrainPaddingUniforms()` and `_writeClimateZoneUniforms()` —
never `_writeRiverUniforms()`. The scratch buffer's river bytes were
therefore always left at their zero-initialized default,
`riverAnchor.w = 0`, which trips `featureRiverHeight()`'s own early-out
guard (`templates/terrain-shaders/features/featureRivers.wgsl.js:42`,
`if (uniforms.riverAnchor.w < 0.5) { return 0.0; }`) on every real tile,
unconditionally, regardless of config.

Fix: added the missing call, matching the single-tile path exactly —
`webgpuTerrainGeneratorBatching.js`, `_fillTerrainUniformScratch()`, right
after `_writeClimateZoneUniforms(v, uniforms)`:
```js
this._writeRiverUniforms(v, uniforms);
```

Verified live: evicted the anchor's resident tiles, forced regeneration,
re-baked the river bed, and read the center-row cross-section. Before the
fix (both with this fix reverted and with root cause 1 alone fixed), the
row was purely monotonic — no local minimum anywhere near the channel.
After the fix, the same row shows a clear, real V-shaped dip centered at
the anchor: 463.36 (across=-24m) → down to 459.02 (across=-2/0, the
row's actual minimum) → back up to 460.60 (across=+12m) → natural slope
resumes toward the edge. That rise-then-natural-slope shape on the
positive side does not happen on unmodified terrain (confirmed: the
pre-fix row never rises anywhere) — this is the channel.

### Not yet done

- The user has not yet re-verified visually in a real (non-headless)
  browser since this fix — the headless canvas-rendering blocker
  documented in `RIVER_WALKING_SKELETON_LOG.md` still applies to this
  session's own screenshot attempts, so this fix is verified via direct
  GPU/JS introspection only, the same standard Session 5 used.
- Placement is still a single hardcoded straight-line anchor (see the
  original conversation's broader plan) — flow-accumulation-based
  placement is unrelated follow-on work, not part of this bug.
- Worth a quick check whether any other `_fillTerrainUniformScratch()`
  caller/pass type has a similar "only reachable via the other code path"
  gap for some other uniform group — this session only checked rivers.
