# High-res → "low-res" → high-res tile flicker: code analysis

**Date:** 2026-10-02 · **Branch:** `codex-restart` @ `e41950c` · **Scope:** code reading only (no runtime testing).

## 1. Verdict

The flicker is not a classic data race. It is a **structural ordering gap in the two-stage
(geometry-first) tile commit**: a freshly committed tile is published to the GPU hash table
as soon as its *geometry* lands, and the GPU instance builder then unconditionally prefers that
tile's own array layer over the fully-refined ancestor it was rendering a frame earlier. The
tile's own layer has no material yet (splat index is the 255 sentinel, splat weights /
resolvedColor are zero-filled), so for the entire refinement latency the fragment shader renders
the **placeholder material**. Under the queue backlog that latency is seconds.

What the user perceives as "a low-res texture being shuffled in over the already-loaded high-res
one" is therefore:

```
refined ancestor (looks right, via GPU parent-fallback)
   → child's geometry-only layer published  (placeholder material: flat atlas tile / speckled raw ids)
   → child's refinement lands seconds later (real splat → "high res comes back")
```

Every detail reported matches this (section 4). There is **no separate "low-res texture" request**
per tile; both the live-splat textures and the prebaked `resolvedColor` are generated for a tile in a
single refinement pass against the same layer (section 5). The user's intuition — *"it should always
prioritize using the high res texture when available"* — is exactly the missing rule: while a tile's
material is pending, the renderer should keep using the refined ancestor's material instead of the
child's placeholder.

Two genuine secondary defects were also found by reading the code (section 6): refinement admission
is starved to 0–1 tiles/frame whenever geometry has a backlog (which stretches the placeholder
phase from ~1 frame to seconds), and hash-table publication is not tied to the copy flush (a 1-frame
stale/zero-layer glitch after bursts). The previously flagged "eviction-protection lag" remains
plausible but unproven and is secondary (section 6.D).

## 2. How the pipeline actually works (the parts that matter)

### 2.1 Two-stage residency

`TileStreamer` splits the configured output set with `splitOutputTypes()`
(`core/world/quadtree/terrainOutputs.js`): geometry = `height, normal, tile`; refinement =
everything else. With the live config (`GPUQuadtreeTerrain.js:174`) the refinement set is
`splatData, scatter, climate, resolvedColor, splatIndex, splatValid`.

Stage 1 — geometry (`_queueTile`, `tileStreamer.js:1686`):

- `generateTile(addr, telemetry, this._geometryTypes)` submits the height/normal/tile compute and
  **returns immediately after submission** (`tileGenerator.js:494-606`; the GPU fence is tracked
  separately and never awaited).
- `_commitTile` (`tileStreamer.js:1993`) allocates a pool layer (evicting LRU if full), queues one
  copy entry with `zeroFillMissing: true` (`:2025`) so every refinement type is zero-filled and
  `splatIndex` is filled with the 255 "no splat yet" sentinel (`TileArrayPool.queueCopyToLayer`,
  `:410`), then **inserts the tile into the CPU hash table and marks the slot dirty**
  (`:2037-2058`). It then calls `_queueRefinement(addr)`.

Stage 2 — refinement (`_queueRefinement`, `:2104`): a second `AsyncGenerationQueue` with its own
(smaller) budget regenerates the material types and `_commitRefinement` (`:2290`) queues a plain
copy into the *same* layer (`:2302`). No hash-table change.

### 2.2 GPU publication

`tickFlush()` (`:1119`) runs once per frame **before** traversal/instance building
(`GPUQuadtreeTerrain.js:732-760`): it flushes up to `maxCopyOperationsPerFrame` (default **8**,
`:673`, not set in config) pending copies FIFO, then uploads **all** dirty hash slots
(`:1129`). The GPU hash entry carries only `{keyLo, keyHi, layer, _pad}` — there is **no
"refined" flag** (`instanceBufferBuilder.wgsl.js:67-71`; `_pad` is always 0).

### 2.3 GPU instance builder: own layer always wins

For each visible leaf (`instanceBufferBuilder.wgsl.js:470-500`):

```wgsl
var useLayer = lookupLoaded(face, depth, x, y);          // own layer if present
if (useLayer == EMPTY_KEY) {
    feedbackBuffer[...] = vec4(face, depth, x, y);        // request it
    loop { ... walk to parent ...; layer = lookupLoaded(face, d, tx, ty);
           if (layer != EMPTY_KEY) { useLayer = layer; uvScale = scale; break; } }
}
```

The ancestor fallback is used **only** when the tile's own entry is missing. The moment the
geometry-only entry appears, the renderer switches from the (refined) ancestor's layer to the
(unrefined) own layer. The instance's `lod` is always the *visible* tile's geometry LOD, so the
fragment shader's LOD tier does not change at that switch — only the sampled layer does.

### 2.4 What the fragment shader draws for a geometry-only layer (LOD ≤ 4)

`terrainChunkFragmentShaderBuilder.js`:

- `sampleSplatData` (`:1789`) loads splat ids 255/255/255/255 and weights 0; `topSum <= 0.0001`
  (`:1874`) → weights normalise to `(1,0,0,0)`; `hasBoundary = false`.
- Main path (`:3577`, `:3662`): `hasLiveSplat` is true, so `sampleMicroTextureWithSplat` runs and
  takes the "almost-pure texel" fast path (`:2653`): `sampleTileColor(dominantId = 255, …)` **with
  no validity check**. `lookupTileLayer(255)` → `textureLookupRow` clamps to the last lookup row
  (`:2466`) → one fixed atlas layer for the whole tile. This is the **"pure green"** variant (one
  uniform grass-like atlas texture, no splat variation). (The sentinel comment in
  `TileArrayPool._getSplatIndexSentinelTexture` claims id 255 "degrades to the raw tile color";
  on this path it does not — it degrades to whatever atlas layer the last lookup row holds.)
- Any path that does fall back to `sampleTileColor(fallbackTileId)` (`fallbackTileId =
  sampleChunkTileId()` = the nearest-sampled per-texel classification id, snapped with the
  `chunkWidth`-in-meters quirk noted at `:1271`) paints each texel with a *different* single atlas
  texture → the **"speckled grainy with sand"** variant. This is also what an LOD5 tile looks like
  while its `resolvedColor` is still zero (`:3633-3640`), and what LOD4 shows beyond the
  `lod0ResolvedColorFade` distance if `resolvedColor` is invalid (`:3644-3660`).

So the "low-res" tile is not lower resolution at all; it is the **placeholder material of the
tile's own fresh layer**. "Lower-res tiles in their expected band are not grainy" is consistent:
at LOD5+ the same fallback is minified by distance (LOD5) or replaced by the flat solid-colour tier
(LOD6), so it reads as smooth.

## 3. Timeline of one flicker (camera approaching, depth D parent is REFINED)

| Step | CPU state | GPU hash | What is drawn on the child's footprint |
|---|---|---|---|
| 1. Traversal splits parent into 4 children (depth D+1) | children not resident | child miss → parent hit | Parent's refined splat via `uvScale=0.5` fallback. **Looks correct.** |
| 2. Feedback → `_queueTile(child)` → geometry generated → `_commitTile` | child in `_tileInfo`, state RESIDENT, refinement queued | **child entry uploaded** (next `tickFlush`) | Child's own layer: correct geometry, **placeholder material** (section 2.4). **Visible regression.** |
| 3. Refinement waits in `_refinementQueue` | state RESIDENT | unchanged | Placeholder persists for the whole wait (seconds under backlog, see 6.A). |
| 4. `_commitRefinement` → copy flushed | state REFINED | unchanged | Real splat / resolvedColor. **"High res comes back."** |

Because the four children (and later grandchildren at depth D+2, D+3 …) commit and refine at
different frames, the area appears to "shuffle" through variants as the camera keeps moving.

## 4. Why this matches every reported detail

| Observation | Explanation |
|---|---|
| Happens **when moving**, in areas where high-res tiles "are supposed to be loaded" | Movement is what makes the traversal split refined parents into unrefined children; the parent *was* loaded and refined, so the area looked finished before the child's geometry commit replaced it. |
| "Pure green" variant | `sampleTileColor(255)` → one fixed atlas layer across the whole tile (2.4). |
| "Speckled grainy with sand" variant | `sampleTileColor(fallbackTileId)` per-texel raw classification ids, nearest-sampled and magnified close to the camera (2.4). |
| **No geometry gap** | The child's own `height` is correct from step 2; before that the parent's height is sampled through `atlasOffset/atlasScale` (`terrainChunkVertexShaderBuilder.js:314-445`). Geometry is never wrong; only material is. |
| Lasts "a few seconds", not one frame | Refinement latency under backlog (6.A); `requestToResident` p50 of 2.8–25 s was already measured for geometry in `TILE_STREAMING_PERFORMANCE_FINDINGS.md`, and refinement is admitted *after* geometry. |
| "Sometimes cycling through multiple variants" | Each LOD level (D+1, D+2, …) repeats the cycle while approaching; siblings refine at different frames; a tile can also pass through parent-fallback → own-placeholder → refined. |
| Lower-res tiles are fine "in their expected band" | At LOD5/6 the placeholder is minified or replaced by the solid-colour tier, so it is not grainy; the regression is only objectionable at LOD ≤ 4. |

## 5. The user's hypotheses, checked against the code

1. **"It queues both the high and low res content and assigns the low res texture after the high
   res one."** — Not literally. Per tile there is exactly one geometry request and one refinement
   request. Both the "high-res" live splat (`splatData/Index/Valid`) **and** the "low-res"
   `resolvedColor` are produced in that one refinement pass (`tileGenerator.js:420-431`), written
   to the same layer by one copy (`tileStreamer.js:2302`). Nothing ever overwrites a refined layer
   with lower-res material. The real "assign low-res after high-res" event is **inter-tile**: the
   child's placeholder layer displaces the parent's refined layer (section 3).
2. **"Some mechanism sees it is too low res and reloads the high res one."** — That mechanism is
   simply the refinement queue eventually reaching the child. Nothing re-requests geometry for an
   already-resident tile: `_processFeedbackAddress` (`:1515`), the parent walk (`:1589`) and
   predictive streaming (`GPUQuadtreeTerrain.js:422-431`) all return early on a hash hit, and
   `_commitTile` rejects duplicates (`:2000`). `AsyncGenerationQueue.request` dedupes pending keys
   (`asyncGenerationQueue.js:24-41`).
3. **"At LOD 4 we need both high and low res content."** — True in the renderer (LOD4 variant
   compiles `ENABLE_LOD0_RESOLVED_COLOR`, `terrainMaterialBuilder.js:164-170`), but both come from
   the tile's **own** refinement; the LOD4 blend never reads the parent's `resolvedColor`. So there
   is no cross-tile dependency that could race.
4. **"It enqueues the loading work multiple times unnecessarily."** — Partly true, but not as
   duplicate *commits*: (a) the refinement pass **recomputes the base-height and tile passes** as
   intermediates because `needsFinalHeight` is true whenever `splatData` is requested
   (`tileGenerator.js:279-283`), so the two-stage split costs ≈1.5–2× the GPU work of a single full
   pass per tile; (b) predictive requests are re-issued every frame and re-sorted on every
   `request()` (`asyncGenerationQueue.js:68`), and are dropped after 200 ms by the freshness rule
   (`tileStreamer.js:845-866`) because predictive tiles never appear in feedback — this is the
   source of the large `queueDropped` counts, not duplicate generation.

## 6. Contributing factors found in the code

### 6.A Refinement starvation under geometry backlog (makes the placeholder phase long)

`_tickRefinement` (`tileStreamer.js:1387-1420`) runs *after* `tickGeneration` has already admitted
geometry against the shared fence budget (`maxGpuFencesInFlight = 8` from
`gpuBackpressureLimit`). Its budget is `8 − (fencesInFlight + geometrySpawnedThisFrame)`, i.e.
whatever geometry left over. Under a geometry backlog that is 0 every frame. The "near" reserve is
`max(0, 1 − overshoot)`; if geometry used its own urgent reserve (fences = 9) the overshoot is 1 and
the refinement reserve is **also 0**. Net effect: during sustained movement, refinement proceeds at
**0–1 tiles per frame**, each also paying the duplicated height/tile compute (5.4a) and two
submissions. Visible tiles stuck at state `RESIDENT` for seconds are the direct result. This is
observable in `[QTLight] refinement queueDepth=… tileStates=[RESIDENT:n REFINED:m]`.

### 6.B Hash publication is not tied to the copy flush (1-frame stale layer)

`_commitTile` inserts the hash entry and dirties the slot immediately (`:2037-2058`), but the layer
copy is only *queued*. `tickFlush` flushes at most 8 copies per frame yet uploads **every** dirty
slot (`:1129`). Since `generateTile` resolves right after submission, a frame that admits 8–9
geometry tiles plus up to 5 refinements can queue >8 copies; the overflow tiles are then published
to the GPU **one frame before their data is written**. The instance builder finds them "loaded" and
draws the layer's previous occupant (recycled layer) or zero data (fresh layer: height 0, tile id 0
= water). The `[QT-Pipeline-GenLag]` comment assumes such tiles are "GPU-invisible for ≥1 frame";
they are GPU-visible with wrong content. This is a true ordering bug, but it produces a 1–2 frame
flash, not the multi-second regression.

### 6.C The geometry-first split is applied to *all* LODs

The plan's own tuning note (`:682-700`) records that the geometry→material pop was "acceptable
twice as far away" but "too visible nearby". The code still applies the split uniformly; only the
*admission reserve* is distance-scaled. For LOD 0–4 tiles (depth ≥ maxDepth−4, i.e. tiles ≤ 2 km
wide at this planet size) the placeholder is always objectionable.

### 6.D Eviction-protection lag (plausible, unverified)

`_selectEvictionCandidate` (`:2318`) is pure LRU over non-protected tiles with depth > 2.
`_protectedKeys`/`lastUsed` are refreshed only by `markTilesVisible` (`:2332`), driven by an async
readback every 2 frames (`visibleReadbackInterval: 2`). A tile that was resident long ago and just
re-entered view (e.g. after turning around) is simultaneously *unprotected* and *the oldest*, so if
the pool is full it is the preferred victim for the next commit; it is then re-requested by feedback
and goes through geometry → placeholder → refined again. This produces the same visual cycle, but
only when the pool is full and only for a few tiles per view change. The existing logs
`[QT-VisMarkD3-EvictDetail] … wasInReadback=true` and `[QT-EvictFeedback]` will confirm or rule it
out without code changes (section 8).

### 6.E Not implicated

- Array-pool ghost write: fixed in `releaseLayer` (`:499`); correct as written.
- Hash-table rehash on remove: `TileHashTable.remove` rehashes the cluster and reports every touched
  slot; all are uploaded in the same `tickFlush`, so the GPU never sees a torn table.
- Duplicate commit / stale epoch: guarded (`:2000`, `:1790`).
- `_pendingCopies` ordering vs compute: copies are queued after the compute submission on the same
  `GPUQueue`, so WebGPU queue ordering guarantees the compute finishes first.

## 7. Recommended fixes (ranked)

### Fix 1 — Single-pass "full" generation for near LODs (smallest change, removes the regression at LOD ≤ 4)

In `_queueTile` choose the tier by depth: if `tileAddr.depth >= quadtreeGPU.maxDepth − nearMaxLOD`
(LOD 0–4), request `this.streamedTypes` in one `generateTile` call (`generationTier: 'full'`), and in
`_commitTile` for a full-tier commit: push the scatter commit (currently done in
`_commitRefinement`), set `_tileState` to `REFINED`, and **skip `_queueRefinement`**. Far tiles keep
geometry-first.

- Visual: the child only replaces the parent fallback when it is complete — no placeholder phase.
- Cost: near tiles appear slightly later (one submission ≈ geometry + splat), but the total GPU work
  per tile *drops* (no duplicated height/tile pass, one fence, one copy instead of two).
- Touch points: `tileStreamer.js:1686-1830` (`_queueTile`), `:1993-2100` (`_commitTile`),
  `terrainOutputs.js` (add a `nearFullLodThreshold` or read `nearMaxLOD` from the terrain shader
  config). Make the threshold a config knob per `AGENTS.md`.

### Fix 2 — Defer GPU publication until refinement when a refined ancestor exists (general)

In `_commitTile`, if `_refinementTypes.length > 0` and the nearest resident ancestor in `_tileInfo`
has `_tileState === 'REFINED'`, record the tile in `_tileInfo` with `published: false` and **do not**
insert into the hash table; do the insert + dirty-slot in `_commitRefinement`. Required companions:

- `_processFeedbackAddress`, `_queueMissingParentsNumeric`, predictive `_queueDepthRangeAtFaceUV`
  must treat `_tileInfo.has(key)` as resident (they currently test only `hashTable.findSlot`),
  otherwise the GPU's continued feedback for the unpublished tile triggers duplicate geometry work.
  Feedback for an unpublished tile is a good moment to **promote its refinement priority** via
  `_refinementQueue.request(key, higherPriority, …)` (promotion in place is already supported).
- If the refinement is dropped as "not relevant" (`:2176`) or rejected, publish the geometry anyway
  so a never-refined tile is not invisible when it becomes visible later.
- `_evictTile` is already safe (`hashTable.remove` returns −1 for an absent key).

Geometry detail lags by the refinement latency (parent height at half density), which is the state
the user already saw before the commit, so there is no visual regression.

### Fix 3 — Material inheritance on the GPU (proper long-term solution)

Use `LoadedEntry._pad` as a flags word (bit 0 = refined), set from `_commitRefinement`. In the
instance builder resolve two layers per instance: the geometry layer (as now) and the nearest
*refined* ancestor layer with its own `uvOffset/uvScale` (requires one more `vec4` in
`ChunkInstance` and the matching vertex-input/varyings). In the fragment shader, sample
`splatDataMap/splatIndexMap/splatValidMap/resolvedColorTexture/climate` through the material
transform and layer, everything else through the geometry transform. Result: geometry pops in at
full detail immediately, material is always the best available. Larger change (shader + instance
layout + renderer bind), so do Fix 1/2 first.

### Fix 4 — Stop starving refinement

In `tickGeneration` reserve part of the fence budget for refinement when `_refinementQueue` has
entries whose tile is strictly visible (e.g. `min(2, visibleRefinementDepth)`), and compute the
refinement reserve from the *pre-geometry* fence count so geometry's own reserve cannot zero it
(`:1405-1415`). Alternatively admit refinement **before** predictive geometry (plan §1.2 already
says visible refinement outranks predictive geometry; the code does not implement that ordering).
Also consider feeding the already-generated `height`/`tile` from the pool layer into the refinement
pass instead of recomputing them (`tileGenerator.js:279-283`).

### Fix 5 — Tie hash publication to the copy flush

Move the `hashTable.insert` + `_dirtySlots.add` for a committed tile into `_flushArrayPoolCopies`,
keyed off the entries `flushPendingCopies` actually submitted (it already returns them), or at
minimum raise `maxCopyOperationsPerFrame` to ≥ `maxGpuFencesInFlight + urgentReserveSlots +
maxRefinementsPerFrame + refinementUrgentReserveSlots` (≈ 14; 128×128 copies are cheap). Add
`maxCopyOperationsPerFrame` to `runtimeConfigs.js` — it is currently an unconfigured default.

### Fix 6 — Eviction hardening (only if 6.D is confirmed by telemetry)

Give resident tiles a short grace period in `_selectEvictionCandidate` (skip `now − lastUsed <
~300 ms`), and/or refresh `lastUsed` for tiles appearing in the *feedback* readback's ancestor walk.
Cheap, but confirm first (section 8) — LRU already makes this rare.

## 8. How to confirm without new code (cheap, in priority order)

1. **Prove the mechanism:** in the browser console set terrain debug mode 46 (`microColorPath`
   visualisation, `terrainChunkFragmentShaderBuilder.js:3573`) while moving: flickering tiles
   should show the raw-tile path (0) during the regression and the live-splat path (3) after.
   Alternatively watch `[QTLight] refinement … tileStates=[RESIDENT:n …]` — the `RESIDENT` count
   is the number of tiles currently drawing the placeholder.
2. **Prove it is refinement latency:** temporarily set `generationTier` to `'full'` for all tiles
   (make `_refinementTypes` empty by requesting `this.streamedTypes` in `_queueTile`). If the
   flicker disappears (at the cost of later pop-in), the diagnosis is confirmed; Fix 1 is the
   scoped version of this experiment.
3. **Quantify starvation:** in `[QTLight]`, compare `started=` (geometry admits) with
   `refinement queueDepth/queueActive` over a flight; `queueActive` pinned at 0–1 while
   `queueDepth` grows confirms 6.A.
4. **Check 6.B:** `[QTLight] … pendingCopies=` > 8 at the log instant, or
   `[QT-Pipeline-GenLag] maxPendingPerFlush` > 8.
5. **Check 6.D:** grep the console for `[QT-VisMarkD3-EvictDetail] … wasInReadback=true` and
   `[QT-EvictFeedback]`; nonzero counts while `pool=2048/2048` means visible tiles are being evicted.

## 9. Side notes relevant to the LOD4/LOD5 seam (not investigated further, per instructions)

- `resolvedColor` is generated for every refined tile regardless of depth
  (`tileGenerator.js:420-431`, no LOD gate), copied through the same `queueCopyToLayer`, and the
  renderer binds the pool's own array for every variant (`terrainMaterialBuilder.js:366`); the two
  external arrays registered by `AssetStreamer` are `terrainAO` and `groundField` only. So a
  deterministic "invalid on LOD4" result is unlikely to be a generation or binding gap; the next
  cheapest test is `qtDiag`'s `debugReadArrayLayerStats('resolvedColor', layer)` on a LOD4 tile's
  layer (alpha mean 1.0 ⇒ data is fine and the sampling path is at fault; 0 ⇒ the tile is still
  `RESIDENT`, i.e. the same starvation as above).
- The LOD4 blend window is `chunkWidth × [1.0, 1.4]` where `chunkWidth` is the constant
  `chunkSizeMeters` (128 m: `QuadtreeTerrainRenderer.js:271` → `terrainMaterialBuilder.js:344`),
  i.e. 128–179 m from the camera, independent of the ~2 km LOD4 tile size and of the real LOD4→5
  switch distance. That alone would make the fade look like a hard step.

## 10. Key numbers (from `wizard_game/runtimeConfigs.js` and defaults)

| Knob | Value | Where |
|---|---|---|
| `tileTextureSize` | 128 | `runtimeConfigs.js:375` |
| `tilePoolSize` / budget | 2048 layers / 2 GB (not clamped) | `:379`, `:384` |
| `maxDepth` (R≈131 km, min tile 128 m) | 11 → LOD4 = depth 7 (2048 m tiles), LOD5 = depth 6 | `TileAddress.computeMaxDepth` |
| `gpuBackpressureLimit` (fence budget) | 8 | `:393` |
| `generationQueue.maxStartsPerFrame` / `maxQueueSize` | 16 / 1024 | `:486-493` |
| `maxRefinementsPerFrame` / reserve | 4 / 1 (defaults) | `tileStreamer.js:693-694` |
| `maxCopyOperationsPerFrame` | 8 (default, unconfigured) | `tileStreamer.js:673` |
| `visibleReadbackInterval` | 2 frames | `:382` |
| Predictive streaming | depths 4–11, radius 4 at depth 4 (~160 tiles/frame when > 50 m/s) | `:464-465` |
