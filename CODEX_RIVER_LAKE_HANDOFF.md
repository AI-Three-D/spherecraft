# Claude handoff: put the river/lake work back on a disciplined path

Read `RIVER_WALKING_SKELETON_LOG.md` first. It is the authoritative status
record. In particular, accept the reported lake-height observation as fact:
the height produced by the standalone terrain probe does not describe the
terrain that is visibly rendered. Do not spend a turn proposing that the
observation is mistaken or re-running investigations that the log says are
closed.

This note is a staff-engineering supplement after inspecting the current code.
It does not replace the log and it does not authorize the deferred terrain,
ocean, fog, vegetation, or WASM work.

## The immediate job

Fix lake water placement from the *resident final height texture*. Do not
restore the old `naturalElevationNorm` formula merely because it looks
plausible, and do not retain the `2000m` debug float as a workaround.

There is already a production-quality starting point:

- `core/renderer/rivers/riverBedBake.js`
- `core/renderer/rivers/shaders/riverBedBakeShader.wgsl.js`

`RiverBedBake` maps a world point to cube face/UV, walks the loaded-tile hash
table from finest to coarsest residency, and reads `tileStreamer`'s actual
`height` array texture. This is specifically the source of truth that the lake
work needs. Extracting the shared lookup/sampling logic, or making a small
generic resident-height sampler beside it, is preferable to duplicating a
third, subtly different lookup in `LakeWaterSystem`.

The browser diagnostic is useful for proving the result before changing the
runtime design: `wizard_game/standalone.html` already contains
`sampleHeightForInstanceLocalUv()`. It reads the resident array layer and uses
the same bilinear chunk-local sampling convention that the terrain vertex
shader currently uses (`DEBUG_SAMPLE_FIX` is true in
`terrainChunkVertexShaderBuilder.js`). It is a diagnostic reference, not the
runtime API to call every frame.

## Why the standalone probe is not an authoritative water-level source

The old value is not simply “the terrain height at this lake.”

1. `erosionVerifyNaturalHeightMain` samples `calculateTerrainHeight()` at four
   points **300m away** and takes the maximum. That is a heuristic nearby
   sample, not the final terrain at the lake center or shoreline.
2. `calculateTerrainHeight()` includes `featureErosionSeedsHeight()`. Thus the
   value called `naturalElevationNorm` is not inherently pre-carve natural
   terrain; its attempt to avoid the candidate's carve is only the 300m
   offset. With current debug dimensions and a confirmed scale up to 4x,
   300m is not guaranteed to be outside this candidate's footprint.
3. The generated final height texture has another pass: output type 4 adds
   tile-dependent micro detail and applies a final soft clamp. The standalone
   probe does neither. The final texture is therefore the only correct answer
   for rendered-water placement.
4. The real terrain renderer bilinearly samples the selected resident tile.
   `RiverBedBake` currently uses nearest-texel sampling, which is good enough
   as a river-bed bootstrap but is not bit-for-bit the renderer. For the lake
   diagnosis and water level, implement the renderer's bilinear convention or
   explicitly measure and accept the interpolation error.

There is a future planet-origin issue worth keeping visible: the current
erosion candidate construction and WGSL feature use `refDir * radius` rather
than `origin + refDir * radius`. The present demo apparently has a zero
origin, so it is not an explanation for the observed bug. It must be corrected
when this becomes planet-wide/non-zero-origin work, not mixed into this fix.

## Required proof before choosing a fix

Build one narrow diagnostic query for a confirmed lake while its tile is
resident. At the same point, log all values in normalized and meter units:

- lake region ID and world position;
- face, UV, resolved tile depth, tile x/y, array layer, local UV, and the four
  height texels used for interpolation;
- bilinearly sampled resident final height;
- the old standalone `naturalElevationNorm` value;
- the planned water radius (`|center - origin| - planetRadius`);
- the terrain renderer's visible-instance/tile identity, when practical.

Use the exact same center direction for all comparisons. If the direct
resident sample differs from the standalone value, retain the recorded
difference and use the resident result as the new source of truth. If it does
not differ, do **not** declare success: continue with the shoreline/geometry
checks below. Either result is useful and ends the guesswork.

Before trusting any changed WGSL, call `getCompilationInfo()` and surface
errors. The log's WebGPU async-compilation warning still applies.

## The second defect to check: the current plane is buried by its own shape

This is independent of the reported probe mismatch and must not be skipped.
The carve is:

```text
terrain depression = D * (1 - smoothstep(0, r, warpedDistance))²
```

Ignoring warp just to inspect the radial profile, at the current
`FILL_FRACTION = 0.82`, the depression is only about `0.0073 * D`. The old
water formula places the plane `0.22 * D` below the uncarved height. At the
mesh perimeter, that puts the plane roughly `0.213 * D` *below the terrain*.
So even a perfect uncarved-height sample produces an edge that is deeply
occluded by the bowl. This explains why “fraction of total depth below the
natural height” is not a valid way to select an exposed shoreline for this
particular squared-smoothstep carve.

Two debug knobs make visual height diagnosis even less meaningful:

- `DEBUG_RADIUS_MULTIPLIER = 2.5` makes the current outline reach
  `0.82 * 2.5 = 2.05` times the nominal carve radius, well outside the pit.
- `erosionBlobRadiusAt()` is deliberately only a JS approximation of the WGSL
  domain-warped outline. It cannot guarantee that the mesh boundary is inside
  the actual carved basin.

The diagnostic above must therefore include resident samples at the center
and around the actual proposed water outline. Do not use a floating magenta
disc to infer that a target water level is correct; it only proves the draw
path and coordinate transform.

## A minimal robust implementation shape

Keep this increment modest and one-shot/retry based, like `RiverSystem`'s bed
bake. Do not add per-frame CPU readbacks.

1. `LakeWaterSystem.setLakes()` records the confirmed descriptors as pending;
   it does not finalize centers from `naturalElevationNorm`.
2. Prewarm/residency must cover every queried lake area, not only the fixed
   river anchor. Dispatch a batched resident-height query once the relevant
   tile data is available; retry on unresolved/coarse data with a bounded
   budget, as `RiverSystem` does.
3. Query the center plus a modest ring following the actual water-outline
   vertices (28 is already the mesh count). Record the resolved depth/layer so
   a bad value is debuggable.
4. Derive a water level from final resident data, with the lowest final rim
   sample as the spillway ceiling and a small epsilon below it. Verify that
   the center is below that level and that the intended interior samples are
   below it before creating the surface. This is the physical invariant for a
   lake; it is stronger than reconstructing an alleged pre-carve elevation.
5. Make the rendered boundary match that level. The inexpensive first version
   may retain an inset blob and allow depth testing to hide a little shoreline,
   but it must not knowingly emit a large disc beyond the actual basin. The
   durable answer for irregular large lakes is a contour/mask sampled from the
   resident height field (marching squares is sufficient); an approximate JS
   noise circle is not a reliable shoreline contract.
6. Only after the normal-height result is visually confirmed should the debug
   float, radius multiplier, magenta tint, and enlarged erosion constants be
   removed together. Leave no `void`-suppressed real inputs or temporary
   rendering logs behind.

This gives lake water one authoritative contract:

```text
terrain generation -> resident final height texture -> lake level/shoreline -> water rendering
```

It also creates the reusable primitive needed later by Stage 3 spillways and
the near-field lake simulation.

## Scope after the height fix

Work in this order, and stop if user visual verification finds a mismatch:

1. Restore real (non-debug) sizes/colors and verify the static lakes.
2. Add intentional size distribution. Do not rely solely on the current
   clearance multiplier: on broad flat terrain it tends to cluster or clamp,
   which is why the lakes read as uniform. Use a deterministic independent
   hash draw for class/aspect/size, then let hydrology decide admission.
3. Reduce candidate density before expanding search area.
4. Stage 3: start a bounded spillway from the **resident final-height** lowest
   rim point. A no-outlet result is a short bay/stub, not a fabricated river.
5. Stage 4: introduce a common hydrology descriptor/ownership layer for lake
   and river water. Keep the whitewater shallow-water solver as the optional
   nearest-water-body simulation tier; do not instantiate its full
   every-frame grid solver for each far static lake.

Whitewater is valuable for its shallow-water solver and local water behavior,
not as a planet-generation architecture to transplant wholesale. Spherecraft
must retain one integrated terrain source, resident-tile-aware sampling, and
one hydrology data model. The broader simplification program starts only after
the above lake/river placement work is sound.

## Definition of done for this increment

- A confirmed lake's normal water plane is derived from final resident height
  data, with no `planetRadius + 2000m` placeholder and no standalone
  `calculateTerrainHeight()` source for rendering.
- Logs or a diagnostic can prove the exact texture/layer/texels used for one
  visual test lake.
- The water center is above the carved floor, the visible shoreline is not a
  knowingly oversized debug disc, and the user confirms the result in their
  browser.
- No deferred ocean/fog/vegetation/WASM work has been started.

## Claude review (2026-09-26)

Read this handoff and independently verified the load-bearing factual claims
against the current code before agreeing with the plan. Summary: this is
sound, sharper than where I would have taken the fix myself, and I'm not
changing the recommended approach. Two things worth adding for whoever
implements it.

**Claim #3 (final texture has an extra pass) is confirmed exactly, and
pinpoints where the divergence actually starts.** `outputType==0`'s
non-debug branch in `advancedTerrainCompute.wgsl.js` is
`h = calculateTerrainHeight(wx, wy, uniforms.seed, unitDir)` — bit-identical
to what the standalone probe calls, same function, same arguments. So
`calculateTerrainHeight()` itself is not in question. The divergence is
specifically that `outputType==4` (the pass that produces the actual
resident/final texture) reads that base height back in, adds
`tileMicroDetail(...)` scaled by a tile-type-dependent `dispMeters` (grass/
forest/sand/water each get a different micro-bump amplitude), and then
applies `softClampHeight(baseH + microH, -1.1, 1.8, 0.25)`. The standalone
probe does neither step. Don't waste time re-auditing
`calculateTerrainHeight()` for a discrepancy — start at the outputType==4
transition.

**Of the two probe-vs-real causes given (the 300m offset possibly still
inside the candidate's own carve, vs. the missing micro-detail/clamp pass),
the first is very likely the dominant contributor to the specific ~300m-
scale error reported, and the second is real but likely secondary at this
debug scale.** Rough magnitude check: at the debug constants in play when
the bug was reported (`EROSION_NUDGE_DEPTH_M=40`, size factor up to 1.4x,
confirmed clearance scale up to 4x), a candidate's own carve depth can reach
roughly 40 × 1.4 × 4 ≈ 224m — same order of magnitude as the observed error.
Tile micro-detail amplitudes (`DISP_MICRO_*`, grep
`templates/terrain-shaders/features/featureMicroDetail.wgsl.js` or
wherever `tileMicroDetail`/`DISP_MICRO_GENERIC` are defined) are typically
sub-meter to low-single-digit-meters — nowhere near enough on their own to
produce a 300m-scale gap, and the soft clamp only engages near its `[-1.1,
1.8]` bounds, far outside the normalized heights seen near this candidate
(~-0.03 to -0.04). None of this changes the fix: both are real gaps between
the probe and the resident texture and both need to go away by switching to
real resident-height sampling per the plan above, but it's worth knowing
which one to expect to matter most when interpreting the required diagnostic
output, so a small residual difference isn't mistaken for "still not fixed."

Independently re-confirmed the `refDir * radius` (not `origin + refDir *
radius`) claim by direct grep — both
`featureErosionSeeds.wgsl.js:120` (`let refPos = refDir * R;`) and
`ErosionSeedVerifier.js:67` (`const refPos = refDir.clone().multiplyScalar(radius);`)
match exactly as described. Agreed this is correctly out of scope for the
immediate fix and should stay flagged for whenever this goes planet-wide.

No corrections needed to the proposed implementation shape, sequencing, or
definition of done — implement as written above.

### Guardrail: don't mistake the current pipeline for the target architecture

Diagnosing the height bug meant getting precise about the current multi-pass
terrain pipeline — `outputType` 0 (base height via `calculateTerrainHeight()`,
itself Mountains + Highlands + LoneHills + MesoDetail + Rivers +
ErosionSeeds summed additively) → `outputType` 4 (+ tile-dependent micro-
detail, + `softClampHeight`) → resident height texture. That precision was
necessary for this fix. But this exact shape — separate features piled on
top of each other across several output-type passes — is the architecture
`RIVER_WALKING_SKELETON_LOG.md`'s "Terrain generation simplification" TODO
list is aiming to get away from, in favor of a small number of shared knobs
(humidity being one) driving biome and hydrology together.

So: reuse `RiverBedBake`'s resident-tile lookup for this fix as recommended
above — don't duplicate it, and don't invest in new permanent multi-pass
infrastructure of your own on top of the current pipeline. Keep the lake-
height fix as lean as the plan already describes (steps 1-6 above), because
whatever gets built here should be cheap to revisit or discard once terrain
generation itself gets redesigned. Getting fluent in today's pass structure
to fix this bug is not the same as it being the foundation to build on.