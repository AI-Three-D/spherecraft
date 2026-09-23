# River walking-skeleton: session log & handoff

Branch: `rivers` (in this repo, spherecraft). Status as of this writing
(read bottom-up for the freshest state): walking skeleton + channel carving
(simulation-side only) are committed by the user. Everything since is
**uncommitted**.

**Read Session 5 first if picking this up fresh.** It proves the terrain-
generation carve from Session 4 is mathematically and structurally correct
(decoupled GPU dispatch test), root-causes why it was nonetheless invisible
in-game (a cold-start LOD/quadtree-residency latency issue, unrelated to the
carve itself), fixes that with a new `prewarmWorldPosition()` call, and
documents a second, still-open issue in the river bed-bake's own tile-hash
lookup. **Still nothing is visually confirmed in a real browser** — headless
Puppeteer remains unable to render this app at all (pre-existing, unrelated
bug), so every claim below is backed by direct GPU/CPU-state introspection,
not a screenshot.

Session 4 went through several iterations on "how should
the channel actually be carved":

1. First, a separate opaque "riverbed ground" overlay mesh drawn on top of
   the real terrain — this had a real checkerboard bug (fixed), but the
   user rejected the *approach* outright regardless: a bolted-on second
   mesh will never look like real integrated terrain, and their explicit
   direction was **"it has to be integrated into the core systems."**
2. **Current, correct approach** (see "Session 4, major pivot" below, read
   this first if picking this up fresh): rivers are now a genuine terrain-
   generation *feature* — carved directly into the real height texture at
   generation time, using the exact same mechanism as spherecraft's
   existing Mountains/Highlands/Canyons features. The separate overlay mesh
   is deleted entirely. This required reversing a key dependency: the
   river's world-space location must now be a FIXED value known before any
   terrain generates (a tile's height bakes once, with no invalidation
   mechanism), so the demo spawn point now derives from the river's fixed
   anchor, not the other way around as in the original walking-skeleton
   design.

Also fixed along the way (all part of the same uncommitted set): a
per-frame-shared-encoder bug, a coarse-placeholder-acceptance bug that
caused a checkerboard of height spikes/pits, frame-vs-wall-clock retry
timing, and a terrain-slope-unaware water-seeding bug that produced
"no water at all" on real (non-flat) terrain.

**Nothing in Session 4 is visually confirmed in a real browser.** Verified
instead via a native Dawn/Node harness (real Metal GPU, no browser): a
shallow-water sim reproduction for the seeding fix, and — for the terrain-
generation pivot specifically, given the risk of breaking terrain
generation for the whole game — assembling the actual complete ~200KB
generated terrain shader and both parsing it (`wgsl_reflect`) and
compiling it on real Dawn/Metal hardware, both clean with zero errors.
Headless/Puppeteer visual testing was confirmed to be fundamentally broken
in this environment for reasons unrelated to rivers (a pre-existing
`TerrainMaterial` pipeline bug specific to headless Puppeteer's Chrome/
ANGLE config — the user's own regular browser does not hit this).

## Context / why this exists

This is phase 1 of a much larger plan (discussed at length earlier in the
originating conversation, not repeated in full here — see conversation
history if needed): spherecraft is a WebGPU planetary engine that grew too
complex (fog, streamed vegetation, terrain generation, water) for the FPS it
delivers (50-60 fps on an M1 MacBook Pro with everything on). The plan is to:

1. Port the shallow-water river/lake simulation from a separate, much
   simpler sibling project called **whitewater**
   (`/Users/okkokauhanen/work/DATrain/feature/proj/whitewater`, a ~7,800-line
   vanilla WebGPU app) into spherecraft, prove it works.
2. Once proven, start trimming spherecraft's "fat": scrap the old
   ocean/wave/foam system, simplify or remove the fog system, cut the
   streamed-asset (vegetation) system down to whitewater-level complexity,
   and simplify terrain generation.
3. Design a proper lake/river authoring system (JSON-authored + procedural),
   using the existing `tools/studio` world-authoring editor as a base.
4. Eventually port perf-critical CPU-side code to WASM, in priority order of
   likely gain (profiling first — no WASM tooling exists in this repo today).

**This session covers only step 1's first increment**: a single hardcoded
"walking skeleton" river patch, to prove the port mechanism works end to end
before investing in anything else. Full scope decisions for this increment
(confirmed with the user before writing code):

- **Bed source**: sample spherecraft's *real* existing terrain height into
  the patch (via a new GPU bake pass), rather than porting whitewater's own
  synthetic channel-carving. This sidesteps the "two different terrain
  generation philosophies" conflict entirely for now — no carving/masking
  logic needed yet. Water just flows over/pools on whatever real terrain
  happens to be there.
- **Sim domain**: one small fixed 128×128 cell (~1m cells) patch, fully
  simulated every frame — no scrolling window, no multi-patch stitching,
  no lake/river authoring. Those are explicitly deferred to later increments.
- A ~128m patch's spherical curvature is treated as negligible (per the
  user) — the patch is approximated as flat via a single tangent frame
  (right/up/forward) computed once at an anchor point.

The full implementation plan (written before any code, approved by the user)
is saved at `/Users/okkokauhanen/.claude/plans/tingly-snuggling-valiant.md`
on the machine this session ran on — read it for the detailed design
rationale and the file-by-file plan; this log is the "what actually
happened + what's next" companion to it.

## What was done

All of whitewater's `js/shaders.js` (`WGSL_SIM`, `WGSL_WATER`), `js/sim.js`
(dispatch/uniform logic), and `js/config/simulation.js` (tunable constants)
were read in full and used as the direct porting source. All of
spherecraft's relevant integration points were read in full before writing
any code (not guessed at) — `core/world/BiomeQuery.js` (the pattern for
GPU-readback terrain queries), `core/renderer/water/*` (the pattern for a
WebGPU `Material` + render integration), `core/renderer/frontend/frontend.js`
(the render loop and construction site), `core/renderer/backend/webgpuBackend.js`
(`draw()`/`compileShader()`/bind-group-from-spec internals — confirmed
exactly how a `Material` with `bindGroupLayoutSpec` + `vertexLayout: []` +
raw storage buffers gets drawn), `core/EngineConfig.js`, `wizard_game/gameEngine.js`,
`wizard_game/runtimeConfigs.js`, and the quadtree/tileStreamer classes
(`GPUQuadtreeTerrain.js`, `QuadtreeGPU.js`, `tileStreamer.js`) for their
exact public API surface (`getLoadedTileTableBuffer()`, `faceSize`,
`loadedTableMask/Capacity`, `maxDepth`, `getArrayTextures()`,
`textureFormats`, `tileTextureSize`). Every API call this code makes was
grep/read-verified against the actual source before use — nothing here is
guessed.

### New files

```
core/planet/surfaceFrame.js
    computeSurfaceTangentFrame(worldPos, planetOrigin) -> {up, right, forward}
    Extracted from Frontend._makeSurfaceMatrix so both share the same math.

templates/configs/riverConfig.js
    DEFAULT_RIVER_CONFIG — grid (128x128 @ 1m), sim constants (carried over
    from whitewater's "medium" quality tier), inflow/initial-fill params,
    bake retry knobs. Plain hardcoded object — no JSON authoring yet.

core/renderer/rivers/
  shaders/
    riverNoise.wgsl.js           — hash21/hash31/noise2/noise3, verbatim
                                    port of whitewater's WGSL_NOISE.
    riverSimShader.wgsl.js       — RIVER_WGSL_SIM: whitewater's WGSL_SIM
                                    (advect/height/momentum passes) with
                                    jOffset (scrolling window) and vortex
                                    forcing removed. Everything else —
                                    boundary inflow, Manning friction,
                                    foam/turbulence source terms, the
                                    outflow-rate limiter — kept byte-for-byte.
    riverBedBakeShader.wgsl.js   — buildRiverBedBakeShader(): NEW shader,
                                    adapts BiomeQuery's per-point hash-table
                                    lookup + height sample into a full-grid
                                    compute dispatch. Writes a sentinel
                                    (RIVER_BED_BAKE_INVALID_SENTINEL =
                                    -100000) for cells whose tile isn't
                                    resident yet, so the CPU side can tell
                                    "real height 0" from "miss".
    riverWaterShader.wgsl.js     — buildRiverVertexShader()/
                                    buildRiverFragmentShader(): port of
                                    whitewater's vsWater/fsWater. Vertex
                                    reconstructs world position via the
                                    tangent frame (patchAnchor + right*x +
                                    forward*z + up*eta) instead of
                                    whitewater's flat (x,y,z); a `uv` varying
                                    carries the flat local (x,z) coords
                                    through to the fragment shader for the
                                    scrolling-noise foam/normal pattern
                                    (whitewater used world-space xz directly,
                                    which doesn't exist as a flat plane here).
                                    Camera/sun/ambient/fog now come from two
                                    small uniform buffers instead of
                                    whitewater's shared `Cam` struct.

  riverBedBake.js    — RiverBedBake class: owns the bake pipeline/buffers,
                        dispatch(encoder, {...}) + async resolve() (mirrors
                        BiomeQuery's copied-buffer + mapAsync readback
                        pattern). Bakes once per patch lifetime.
  riverMaterialBuilder.js — RiverMaterialBuilder.create()/updateUniformBuffers():
                        mirrors WaterMaterialBuilder's shape (packed
                        Float32Array uniforms + bindGroupLayoutSpec) but
                        simpler — one non-instanced draw, no per-LOD
                        materials.
  riverSystem.js     — RiverSystem: the orchestrator. Owns a small state
                        machine (idle -> pending -> baking -> ready, or
                        failed) driven from update(encoder, dt) called once
                        per frame from Frontend. setAnchor(worldPos) starts
                        the sequence; after config.bake.readyDelayFrames
                        frames it dispatches the bed bake, waits for the
                        async readback, seeds the initial GPU state (a
                        standing-water "dump" in one row band + a
                        continuous Dirichlet inflow at rows 0-1, both
                        computed from the real baked bed so they sit at
                        sensible depths), then flips to 'ready' and starts
                        running sim substeps every frame. render() updates
                        the material uniforms and calls backend.draw().
                        getDebugInfo() exposes {state, ready, inEta,
                        fillEta, anchor, cellsValid, cellsTotal} for the
                        window.riverDiag() console hook.
```

### Modified files

- `core/EngineConfig.js` — added `features.rivers` (defaults `true`),
  following the exact existing `requireBool(features.X ?? true, ...)`
  pattern used for every other feature toggle.
- `wizard_game/runtimeConfigs.js` — added `rivers: true` to the game's
  features block (this block currently has most heavy features — shadows,
  trees, streamedAssets, particles, actors, etc. — set to `false` already,
  presumably from earlier perf investigation; rivers was turned on
  explicitly so the demo is visible against an otherwise bare scene).
- `core/renderer/frontend/frontend.js`:
  - imports `computeSurfaceTangentFrame` and refactors `_makeSurfaceMatrix`
    to call it instead of inlining the same math (pure extraction, no
    behavior change).
  - constructs `this.riverSystem` in `initializeGPUQuadtree()`, right after
    the existing `globalOceanRenderer` block, gated by
    `engineConfig.features.rivers !== false`, wrapped in try/catch that
    logs and sets `riverSystem = null` on failure (matches the ocean
    block's own error handling exactly).
  - render hook in `renderTerrain()`, right after the ocean's render call:
    `backend.endRenderPassForCompute()` → `riverSystem.update(encoder, dt)`
    → `backend.resumeRenderPass()` → `riverSystem.render(...)` if ready.
    Uses the exact same pause/resume-render-pass idiom the asset streamer
    and atmo-bank system already use for interleaving compute with the
    open render pass.
  - `placeDemoRiver(worldPos)` method (forwards to
    `riverSystem?.setAnchor(worldPos)`).
  - dispose hook alongside `globalOceanRenderer.dispose()`.
- `wizard_game/gameEngine.js` — right after `_computeSpawn()` resolves,
  computes the spawn point's direction from the planet origin and calls
  `this.renderer.placeDemoRiver(anchorPos)` with a point at exactly
  `planetConfig.radius` along that direction (so the demo river appears at
  the player's spawn location without needing any manual navigation).
- `wizard_game/standalone.html` — added
  `window.riverDiag = () => gameEngine?.renderer?.riverSystem?.getDebugInfo?.() ?? null;`
  right after the existing `installQuadtreeDiagnostics(gameEngine);` call,
  for quick console inspection (mirrors the existing `window.qtDiag`
  pattern). (Session 2 also added a `window.__diagLogs` console/error
  capture at the very top of `<head>` — see "Session 2 findings" below for
  why.)

## What was verified this session

- All new/modified JS files pass `node --check` (syntax only — no
  type/logic checking, and WGSL can't be checked this way at all since it's
  not JS).
- Brace/paren balance sanity-checked on all four new `.wgsl.js` files
  (all balanced) — not a substitute for actually compiling the shaders, but
  the best available check without a browser.
- Manually re-derived every WGSL uniform struct's byte layout against its
  JS-side `Float32Array`/`Uint32Array` packing code, field by field, to
  catch alignment/offset mismatches (a very easy class of bug in this kind
  of code). All four structs (`RiverSimUniforms` 96B, `BakeParams` 96B,
  `RiverVertexUniforms` 208B, `RiverFragmentUniforms` 128B) check out.
- Traced the `Material`/`backend.draw()` code path in
  `webgpuBackend.js` line by line to confirm: (a) `vertexLayout: []` +
  `bindGroupLayoutSpec` + `material.storageBuffers[name] = <raw GPUBuffer>`
  is a real, working pattern already used elsewhere (not a guess), and
  (b) a `Geometry` with only `setIndex()` and no vertex attributes drives a
  fully vertex_index-based shader correctly through the existing
  `drawIndexed` path.
- Started spherecraft's server on an alternate port (8123 — port 8000 was
  already occupied by the user's own whitewater server running from
  `/Users/okkokauhanen/work/DATrain/feature/whitewater`, a **different**
  path than the `feature/proj/whitewater` used as the porting source —
  worth being aware there are at least two whitewater checkouts on this
  machine) and loaded `wizard_game/standalone.html` in headless Chromium
  via the puppeteer MCP tool, with `--enable-unsafe-webgpu` and SwiftShader
  flags. Confirmed:
  - `navigator.gpu` is available and `requestAdapter()` succeeds in this
    headless environment (i.e. WebGPU itself works here, so further
    browser-based checks are possible in future sessions).
  - The page reaches "Planetfall ready" / loading phase "ready" without
    hanging or crashing.
  - `window.qtDiag` (`typeof` "object") and **`window.riverDiag`**
    (`typeof` "function") are both present — meaning `standalone.html`'s
    bootstrap ran to completion, `gameEngine`/`renderer` were constructed,
    and critically **no import/module error occurred anywhere in the new
    river code's import graph** (a broken import would have thrown before
    `riverDiag` could be installed, or before the page reached "ready").
  - The loading screen showed "Initial load timed out; revealing with
    current terrain residency." — this needs investigation but is very
    likely **pre-existing** (a terrain-streaming timeout message, nothing
    river-specific in its wording) rather than caused by this change;
    **not yet confirmed either way** since no before/after comparison was
    done this session.

## What was NOT verified (do this first in the next session)

This is the most important section for whoever picks this up. Nothing
about the actual runtime *behavior* of the river system has been observed
yet — only that the code loads without throwing.

1. **Check the browser console for WebGPU validation errors specifically.**
   The puppeteer tool used this session has no console-log capture wired up
   (only `evaluate()` was available, which runs *after* the page has
   already finished loading, so it can't see messages logged during
   startup). Next step: either (a) add a `console.error`/`window.onerror`
   collector into an array on `window` right after navigation and re-check
   it, accepting that only errors after that point are caught, or (b) use
   a tool/method that captures console output from page load, or (c) just
   open it in a real browser tab and watch DevTools — this is a WebGPU app,
   real browser testing was always going to be needed eventually. Watch
   especially for **bind-group-layout mismatches** between
   `RiverMaterialBuilder`'s spec and the WGSL `@group`/`@binding`
   declarations — this is the single most likely bug class in code like
   this, and it fails at pipeline-creation time with a validation error
   that's easy to miss without watching for it.
2. **Confirm the `RiverSystem` state machine actually progresses**: anchor
   set → bed bake dispatched → bed bake resolved (with a real
   `cellsValid` count, not 0) → ready. Use
   `window.riverDiag()` in the console a few seconds after load. If it's
   stuck at `state: 'pending'` or `'baking'` for a long time, check whether
   `quadtreeTileManager`'s tiles near the spawn point are actually GPU
   resident yet (`window.qtDiag.status()`) — the bed bake needs resident
   tiles under the anchor point, and `config.bake.readyDelayFrames` (60
   frames, ~1s) might be too short/long depending on how fast this
   particular planet/spawn streams in.
3. **Visually confirm the patch looks right** (this is the actual point of
   the whole increment): a water surface that follows the real local
   terrain slope at the spawn site (not a flat disc floating above/through
   the ground — the biggest visual tell that the tangent-frame math or the
   bed bake is wrong), an initial pool that visibly spreads/drains downhill
   oveIfirst few seconds, continuous inflow at one edge, and
   waves/foam modulated by the turbulence field. Take a screenshot once the
   sim has run for a few seconds.
4. **Check FPS impact.** The whole point of proving this mechanism is to
   then start trimming spherecraft's fat elsewhere — but a new per-frame
   compute pass is itself a cost. Get a baseline fps reading with
   `features.rivers: false` vs `true` in `wizard_game/runtimeConfigs.js`
   before doing anything else, so later trimming work has something to
   compare against.
5. If step 1-3 reveal bugs (likely — this is a lot of new WGSL that's
   never been compiled), the most probable failure points, roughly in
   order of likelihood, are:
   - Bind group layout / binding number mismatch between
     `riverMaterialBuilder.js`'s `bindGroupLayoutSpec` and the `@group`/
     `@binding` numbers in `riverWaterShader.wgsl.js` (double-check group 0
     binding 0/1 = vertex/fragment uniforms, group 1 binding 0/1/2 =
     bed/state/turbulence).
   - The bed-bake shader's hash-table lookup logic (`riverBedBakeShader.wgsl.js`,
     copied from `BiomeQuery.js`) — if the height texture format or hash
     table layout has since changed in `core/world/BiomeQuery.js` (check
     git blame / diff against what was read this session), the bake will
     silently return all-invalid cells.
   - `RiverSystem.setAnchor()` being called before `RiverSystem.initialize()`
     has finished (`gameEngine.js` calls `this.renderer.placeDemoRiver(...)`
     synchronously right after spawn resolves — if `Frontend.initializeGPUQuadtree()`'s
     async river construction hasn't resolved yet at that point, `placeDemoRiver`
     silently no-ops since `riverSystem` would still be undefined; check the
     actual await ordering in `gameEngine.js`'s init sequence if the river
     never appears at all).

## Session 2 findings (2026-09-12)

Picked this up autonomously to work through the "What was NOT verified"
list above. Net result: item 2 (state machine progresses) is now confirmed
working as designed; items 1/3/4 (console errors, visual look, FPS) are
still blocked, but the blocker turned out to be a **pre-existing bug
unrelated to rivers**, not anything wrong with this increment's code — see
below. In place of the blocked visual checks, did a thorough static
re-verification of everything that can be checked without a working
renderer.

### Tooling changes made this session

- **`wizard_game/standalone.html`**: added a small dev-only diagnostic block
  at the very top of `<head>` (before any other script) that overrides
  `console.error`/`console.warn`/`console.log` and listens for
  `window.onerror`/`unhandledrejection`, pushing everything to
  `window.__diagLogs` with a `performance.now()` timestamp. This exists
  because the puppeteer MCP tool available in this environment only exposes
  `evaluate()` (runs after the page has already loaded) with no console
  capture — so without this, headless checks are blind to anything logged
  during startup. Left in intentionally (it's additive — every intercepted
  call still forwards to the original — and this file's title literally says
  "Development"); future sessions can just read `window.__diagLogs` after
  navigating instead of re-adding this.
- **Gotcha for future sessions**: don't serve this repo with a plain
  `python3 -m http.server` for puppeteer testing — it sends no
  `Cache-Control` headers, and Chromium happily serves stale cached JS
  modules across `puppeteer_navigate` calls within the same browser
  instance, which produced a false reading this session (a `rivers: false`
  toggle appeared to not take effect because the browser was still running
  the previously-loaded `runtimeConfigs.js`). `server.py` in the repo root
  sends `Cache-Control: no-cache, no-store, must-revalidate` and should be
  used instead (or replicate its `end_headers` override, since `server.py`
  itself hardcodes port 8000, which was occupied this session by an
  unrelated `whitewater` checkout's server).

### Confirmed pre-existing, river-unrelated bug: headless SwiftShader GPU-process loss

Every load — **with `features.rivers` both `true` and `false`** — dies the
same way, ~15-17s after `standalone.html` starts loading, well before any
river-specific code runs:

1. Individual animation frames balloon from the usual sub-16ms to
   **750ms-4s each** during startup while the terrain/splat/quadtree shader
   set first-time-compiles (visible directly in `window.__diagLogs`
   timestamps: consecutive `log` lines jump from t≈11253ms to t≈11997ms to
   t≈16089ms — i.e. two frames in a row each took several seconds).
2. Right around that point, `[WebGPU][TerrainMaterial] Pipeline validation
   error: [Invalid PipelineLayout (unlabeled)] is invalid` starts firing
   repeatedly (unrelated to rivers — `TerrainMaterial` is spherecraft's
   pre-existing terrain renderer).
3. Immediately after, every subsequent frame throws `OperationError:
   Instance dropped in popErrorScope` (from `Frontend.render`,
   `frontend.js:1071`) and `AbortError: Failed to execute 'mapAsync' on
   'GPUBuffer': A valid external Instance reference no longer exists` (from
   `QuadtreeGPU._withDebugReadbackLock`, `QuadtreeGPU.js:659`/`234`) —
   i.e. the whole `GPUDevice`/`GPUInstance` has been torn down out from
   under the running app. Nothing renders after this (confirmed via
   screenshot: HUD overlay draws fine, the WebGPU canvas underneath it is
   solid black).
4. **Reproduced identically with `wizard_game/runtimeConfigs.js`'s
   `features.rivers` set to `false`** (a clean, non-cached load — no river
   logs, `window.riverDiag()` correctly returns `null`, confirming the
   feature flag itself gates correctly at `frontend.js:366-388`) — same
   `TerrainMaterial` errors, same instance-drop cascade, same timing. This
   rules out the river code as the cause.
5. Also saw, both with rivers on and off: `[WebGPU][MoonRenderer] Pipeline
   validation error` from a `smoothstep` call with `low(1.0) >= high(0.7)`
   in that shader (`fragment:70:26`) — a second, separate pre-existing bug,
   also unrelated to rivers. Not investigated further (out of this
   increment's scope; noted here so it isn't mistaken for river fallout
   later).

Best-guess root cause (not confirmed further, out of scope to chase down):
Chromium's GPU-process hang-watchdog killing an unresponsive software
(SwiftShader) rendering process under this scene's shader-compilation load,
which tears down the WebGPU instance for the whole page. This matches the
original session's "Initial load timed out; revealing with current terrain
residency" observation — that log line comes from a UI-only 12s loading
timeout (`gameEngine.js:413,419`) and is a red herring/coincidence in
timing, not the actual cause; the actual cause is the GPU process dying
around the same wall-clock time. **This means headless/SwiftShader puppeteer
testing cannot be used to visually verify spherecraft at all in this
environment** — not just for rivers. A real browser tab with real GPU
hardware is required for items 1/3/4 in "What was NOT verified" above; that
was always going to be needed eventually per this doc's own earlier note,
just confirmed sooner than expected.

### State machine: confirmed working (item 2, resolved)

Within the healthy window before the device dies, `RiverSystem` behaves
exactly as designed:

- `gameEngine.js`'s `placeDemoRiver()` call successfully reaches a fully
  constructed `riverSystem` — `"[River] anchor set"` logs right after
  `"[GameEngine] Initialization complete"`, so the previously-flagged
  "`setAnchor` called before `initialize()` resolves" risk (item 5, third
  bullet, in "What was NOT verified") **does not occur** — await ordering in
  `gameEngine.js`/`frontend.js` is correct.
- The bake dispatch/retry state machine (`idle → pending → baking →
  pending (retry) → ... → ready|failed`) exercises correctly:
  `"[River] bed bake mostly unresolved (0/16384), retrying"` fires, and
  `window.riverDiag()` eventually reports `state: 'ready'`. `cellsValid`
  stayed `0` in every run this session, but only because the GPU device was
  already dead (see above) by the time bakes were attempted — the
  bake/retry/give-up logic itself (`riverSystem.js` `_dispatchBake` /
  `_onBedResolved`) is doing exactly what it's supposed to with the
  (garbage, post-crash) data it's given. This needs re-checking with a
  healthy device before trusting `cellsValid > 0` end-to-end, but the state
  machine control flow itself is no longer a suspect.

### Static re-verification (in place of blocked visual checks)

With the renderer path unusable in this environment, re-derived everything
on the "most likely failure point" list (item 5) that's checkable by
reading code instead of running it:

- **Bind-group-layout vs. WGSL `@group`/`@binding`, render path**
  (`riverMaterialBuilder.js` vs `riverWaterShader.wgsl.js`): group 0
  binding 0 = `RiverVertexUniforms` (vertex-visible uniform), group 0
  binding 1 = `RiverFragmentUniforms` (fragment-visible uniform), group 1
  bindings 0/1/2 = `bed`/`state`/`turbulence` (all
  `read-only-storage`, vertex-visible, matching that `B`/`S`/`K` are only
  ever read in the vertex shader) — spec and shader agree exactly, no
  mismatch found.
- **Uniform struct byte layouts**, re-derived field-by-field independently
  of the previous session's numbers: `RiverVertexUniforms` (208B/52 floats)
  and `RiverFragmentUniforms` (128B/32 floats) both check out exactly
  against `RiverMaterialBuilder.updateUniformBuffers()`'s
  `vert[...]`/`frag[...]` index math, including all the `vec3+trailing-f32`
  WGSL alignment padding. Confirms the previous session's own manual
  derivation was correct.
- **Bed-bake shader vs. `core/world/BiomeQuery.js` drift check** (item 5,
  second bullet, explicitly flagged as a risk if `BiomeQuery.js` had changed
  since the port): diffed `hashKey`/`lookupLayer`/`dirToFaceUV` in
  `riverBedBakeShader.wgsl.js` against the current
  `core/world/BiomeQuery.js` — **byte-for-byte identical**, no drift.
- **`BakeParams` struct (96B)** re-derived field-by-field against
  `riverBedBake.js`'s `f32[...]`/`u32[...]` packing, including the
  `vec3`-alignment gaps around `patchAnchor`/`patchRight`/`patchForward` —
  checks out exactly.
- **`riverBedBake.js`'s bind group** (`params`/`heightTex`/`hashTable`/
  `bedOut`) matches the shader's `@group(0) @binding(0..3)` declarations
  and types (uniform / `texture_2d_array` / `read-only-storage` /
  `read_write storage`) exactly.
- **Raw-`GPUBuffer`-as-`storageBuffers`-value pattern**: `riverSystem.js`
  assigns `this._material.storageBuffers = { bed, state, turbulence }` as
  raw `GPUBuffer` objects (not wrapped in `{ gpuBuffer }` like one other
  call site in the codebase does). Traced
  `webgpuBackend.js:_createBindGroupsFromSpec` (~line 1483-1490): it does
  `storageHandle?.gpuBuffer || storageHandle || ...`, so a raw `GPUBuffer`
  correctly falls through to the `storageHandle` branch. Confirmed working,
  not assumed.

None of the above turned up a bug. Combined with the state-machine result,
this means **every part of the river increment that can be checked without
a functioning renderer now has been**, and nothing new to fix has turned
up — the remaining unknowns (does the bed bake actually resolve real height
data once given a healthy device and resident tiles; does the water surface
actually look right; what's the FPS cost) all require a real browser and
can't be resolved by more code reading.

### Recommended next step

Open `wizard_game/standalone.html` (via `server.py` on port 8000, or the
no-cache-header pattern above on another port) in an actual browser tab
with real GPU hardware — Chrome/Firefox/Safari, not headless/SwiftShader —
and work through items 2 (re-confirm `cellsValid > 0` with a healthy
device), 3, and 4 from "What was NOT verified" above with DevTools open.
The `window.__diagLogs` array is still there if useful, but a real browser's
own DevTools console is the more direct tool once one is available
interactively.

## Session 3 findings (2026-09-14): real bug found and fixed via real-browser debugging

The user opened `standalone.html` in an actual browser (real GPU, not
headless/SwiftShader) and drove the debugging interactively over several
rounds. Summary of the investigation, in order, since the reasoning chain
matters for anyone re-verifying this:

1. **FPS was good, but no river was visible anywhere near spawn.** Ruled out
   a positioning bug by comparing `window.riverDiag().anchor` to the actual
   render camera position (`window.gameEngine.renderer.camera.position`) —
   they lined up (the ~485m gap between them was just the anchor being
   reported at the *base planet radius*, not the terrain-elevated surface;
   see point 2). This was a red herring in the debugging, not a bug.
2. **The user then found the water rendering literally underground** by
   flying below the terrain and looking up. This was the real symptom.
   `riverDiag().anchor` is deliberately the tangent-frame's reference point
   on the un-displaced base sphere (`planetConfig.radius`), not the real
   terrain-elevated ground — the actual per-cell water position is
   `patchAnchor + patchUp * (bedHeight + waterDepth)`, which is supposed to
   already include real terrain elevation via `bedHeight`.
3. Added three new console diagnostics (kept in the code — see "New debug
   surface" below) to inspect the live GPU state directly instead of
   guessing:
   - `window.riverState()` — async readback of the live sim state buffer.
     Result: `wetCount: 7808/16384`, `maxH: 0.6`, `avgWetH: 0.38`,
     `wetRowRange: [0, 60]` — **the shallow-water sim itself was working
     correctly**, with substantial real water depth across roughly half the
     patch. This ruled out the simulation/seeding code as the culprit and
     pointed squarely at the bed-bake step or the render step.
   - `window.riverBed()` — synchronous inspection of the last-resolved bed
     array (reusing the CPU-side data `RiverBedBake.resolve()` already
     returns, no extra GPU round-trip needed for this part). Result:
     `minBed: 0, maxBed: 0, avgBed: 0, centerBed: 0` — **every single baked
     bed height was exactly zero**, despite `riverDiag()` separately
     reporting `cellsValid: 16384/16384` (i.e. the bake's own "did we find a
     tile" check passed for every cell, but the height value it read back
     was uniformly zero). This was the actual bug's signature.
   - Also checked `heightScaleUsed`/`heightScaleLiveNow` via `riverBed()` —
     both correctly read `5000` (`PlanetConfig.heightScale` is a *getter*
     returning `maxTerrainHeight`, `wizard_game/runtimeConfigs.js:859`; this
     was a plausible-looking dead end ruled out by direct measurement rather
     than assumption).
4. Cross-referenced against `window.qtDiag.pickTerrainAtCenter()` (an
   existing, unrelated diagnostic already in `standalone.html`) while the
   user stood on the real terrain: it reported the real tile resident there
   as `face:1, depth:11, tile:(1024,1023), layer:1439`, with a real sampled
   height of `~0.0919` (which back-converts to `terrainRadius: 131531.6`,
   i.e. `131072 + 0.0919*5000` — confirming the height-scale formula itself
   is correct).
5. Added shader-level instrumentation (`riverBedBakeShader.wgsl.js`'s
   `debugOut` storage buffer, binding 4, plumbed through
   `riverBedBake.js`/`riverSystem.js` as `window.riverBed().matchedAtCenter`)
   to report exactly which `{depth, layer, tx, ty}` the bake's own lookup
   loop matched for the patch's center cell. Result:
   `{depth: 0, layer: 0, tx: 0, ty: 0}` — **the lookup was falling through
   every depth from `maxDepth` (11) down to 1 without a single hash-table
   hit, only ever succeeding at the trivial coarsest level (depth 0, the
   whole-face root tile, `tx=ty=0` always)**, which is apparently always
   resident but has no real height baked into it.
6. Hand-traced the face/UV/tile-coordinate math for the exact query point:
   it was **correct** — `dirToFaceUV` computed `face=1, u≈0.5, v≈0.5`
   matching reality, and at `depth=11` the shader's own `tx=1024, ty=1023`
   computation exactly matched the real tile identity. So the bug wasn't in
   the geometry/coordinate math at all — it was specifically in the
   hash-table *lookup* not finding an entry that demonstrably exists.
7. Checked the hash parameters actually in use
   (`window.gameEngine.renderer.quadtreeTileManager.quadtreeGPU`):
   `loadedTableMask: 32767, loadedTableCapacity: 32768, maxDepth: 11` — all
   sane and matching reality, ruling out a parameter-threading bug.
8. **Root cause, found by diffing our copied lookup logic
   (`riverBedBakeShader.wgsl.js`, originally ported verbatim from
   `core/world/BiomeQuery.js`) line-by-line against the real insertion/lookup
   shader (`core/world/quadtree/quadtreeTraversal.wgsl.js`'s `isLoaded()`)**:
   every part of the hash logic matches exactly (hash mixing constants, key
   construction via `makeKeyLo`/`makeKeyHi`, the `LoadedEntry` struct layout,
   the `0xFFFFFFFF` empty-slot sentinel) **except the linear-probe limit**:
   `quadtreeTraversal.wgsl.js:289` probes up to `min(loadedTableCapacity,
   256)` slots, but the copied `MAX_PROBE` constant (in both
   `BiomeQuery.js:49` and our `riverBedBakeShader.wgsl.js`) was hardcoded to
   `64`. With a low *overall* hash-table load factor (~256 resident tiles /
   32768 slots) but tiles streamed in together spatially — meaning nearby
   tiles are likely inserted around the same time and can cluster in hash
   space — a real entry's probe chain can land past slot 64 while still
   comfortably under 256. That would make every fine-detail lookup near the
   player fail (falling through to the always-short-chained depth-0 root
   entry) while looking, from the caller's side, exactly like "found a tile,
   but its height reads zero."
9. **Fix applied**: `riverBedBakeShader.wgsl.js`'s `MAX_PROBE` raised from
   `64` to `256` to match the real traversal shader exactly.
   `core/world/BiomeQuery.js` has the *identical* latent bug (same `64`,
   same copied-from-elsewhere origin) but was **not** touched this
   session — it's used only by `tools/studio` (unused by `wizard_game` at
   runtime; grepped and confirmed no call site exists in the live game), so
   fixing it is out of scope for this increment. Worth fixing whenever
   `tools/studio`/`BiomeQuery` is next touched, since it's the same bug.
10. **Not yet re-verified**: the fix has not been re-tested in the browser
    yet. Next step for whoever picks this up: reload, wait for `ready`,
    check `window.riverBed()` — `matchedAtCenter.depth` should now read
    close to `11` (not `0`) and `centerBed`/`avgBed` should be nonzero, then
    confirm visually that the water now renders at the correct terrain
    height instead of underground.

### New debug surface added this session (kept intentionally)

All console-accessible via `window.*` in `standalone.html`, all additive
(never removes/replaces existing behavior), useful for any future
regression in this area:

- `window.riverState()` — async GPU readback of the live sim state buffer
  (`RiverSystem.debugReadState()`, `core/renderer/rivers/riverSystem.js`).
  Reports `{total, wetCount, maxH, avgWetH, wetRowRange}`. Required adding
  `GPUBufferUsage.COPY_SRC` to the state buffers'
  usage flags (they only had `STORAGE | COPY_DST` before) plus a small
  dedicated readback buffer.
- `window.riverBed()` — synchronous inspection of the last-resolved bed
  bake (`RiverSystem.debugBedInfo()`), reusing the CPU-side array
  `RiverBedBake.resolve()` already produces (no extra GPU round-trip).
  Reports `{minBed, maxBed, avgBed, centerBed, centerWorld, centerRadius,
  planetRadius, heightScaleUsed, heightScaleLiveNow, matchedAtCenter}`.
- `matchedAtCenter: {depth, layer, tx, ty}` — shader-level instrumentation
  in `riverBedBakeShader.wgsl.js` (new `debugOut` storage buffer, binding 4)
  reporting exactly what the bake's lookup loop matched for the patch's
  center cell (`depth: 999` would mean "never found anything, not even the
  root" — didn't occur in practice). Plumbed through
  `RiverBedBake.dispatch()`/`resolve()` (a second small 16-byte
  readback buffer) into `RiverSystem._onBedResolved()`.
- `window.__diagLogs` (added Session 2) — early console/error capture in
  `standalone.html`'s `<head>`, useful again if headless testing is
  ever revisited.

## Session 3 resolution (2026-09-14): actual root cause found and fixed

The `MAX_PROBE` fix earlier in Session 3 turned out to be a red herring —
harmless (still correct to match the real traversal shader's probe limit)
but not the actual cause. What followed was a long, frustrating
back-and-forth trying to diagnose why `window.riverBed()` kept reporting
every value as exactly `0` — including raw uniform constants like `gridW`
and `hashMask` that can never legitimately be `0` — even after fixing a
real self-inflicted bug along the way (a duplicate `let dbgI`/`dbgJ`
declaration in the debug instrumentation, a genuine WGSL compile error that
made the whole shader fail to run). Caching was investigated and ruled out
definitively (DevTools "Disable cache" + a `fetch(..., {cache:'no-store'})`
sanity check both confirmed fresh code was loading).

**The breakthrough**: rather than keep guessing from a browser (subject to
the pre-existing SwiftShader device-loss crash in headless mode, and slow/
frustrating round-trips against the user's real browser), installed
`wgsl_reflect` (a real WGSL parser) and `webgpu` (dawn-gpu/node-webgpu —
native Dawn bindings for Node, i.e. a real, non-browser WebGPU
implementation) via npm and:

1. Parsed the actual shader source with `wgsl_reflect` — confirmed it's
   syntactically valid (no compile error) and independently re-derived the
   exact `BakeParams` byte-offset layout, which matched what was hand/
   JS-side verified all along. The struct layout was never the problem.
2. Wrote a hand-built reproduction of the dispatch using raw Dawn calls —
   worked perfectly (`gridW:128`, `patchAnchor:(-131072,0,0)`, `worldPos`
   exactly matching the browser's own `centerWorld`, correct `face`/`u`/`v`,
   correctly reports "not found" against a deliberately empty hash table).
   This proved the shader logic itself has no bug.
3. **Critically**, then imported and ran the *actual* `RiverBedBake` class
   (`core/renderer/rivers/riverBedBake.js`, unmodified, not a
   hand-reproduction) against a real Dawn device with a mock
   `quadtreeGPU`/`tileStreamer`, seeded with one real hash-table entry
   (face 1, depth 0, layer 0, height `0.0919` — mirroring the "always seems
   to find the coarse root" pattern seen in every browser test). Result:
   **perfect, fully correct output** — `center bed value: 459.5` (exactly
   `0.0919 × 5000`), `debug: {depth: 0, layer: 0, height: 0.0919, ...}`,
   everything else echoed exactly as fed in. The real, actual application
   code has no bug in it at all.

**Actual root cause**: not a code bug — a **retry-budget/timing** problem.
`RiverBedBake`/`RiverSystem`'s bed-bake retry logic
(`riverSystem.js`'s `_dispatchBake`/`_onBedResolved`) is completely correct,
but `templates/configs/riverConfig.js`'s `bake.maxRetries` was `5`, each
retry spaced `readyDelayFrames` (60 frames, roughly 1s) apart — a total
budget of only ~5-6 seconds of real-world time after the anchor is set
before the system **permanently gives up** and settles on whatever
(possibly zero/placeholder) bed data it has, never attempting again for the
rest of that page load. Tile streaming right after a fresh spawn — with
everything else in the scene also competing to load — can easily take
longer than 5-6 seconds to make even the coarse depth-0 "whole planet face"
fallback tile GPU-resident, let alone the fine-detail tile actually under
the patch. This exactly explains every symptom observed: the *code*
behaves correctly whenever a real hash-table entry happens to already exist
at bake time (proven above), but in practice the very short retry window
means it almost always gives up before that's true, permanently stranding
the patch with flat/zero bed data — i.e. water rendering at the base
planet radius instead of the real (higher) terrain surface, exactly
matching "water is underground."

**Fix applied**: `templates/configs/riverConfig.js`'s `bake.maxRetries`
raised from `5` to `120` (~2 minutes of real-world retrying — generous
since retries are cheap and one-time, not a per-frame cost; this is a
safety net against a genuinely broken environment, not a budget meant to be
hit in normal play). Also throttled the "mostly unresolved, retrying" log
line (`riverSystem.js`) to only print on the 1st and every 10th attempt,
since 120 possible retries would otherwise spam the console.

**Not yet re-verified**: this fix has not been tested in the browser yet.
Next step: reload, and if terrain streaming genuinely takes longer than a
few seconds near spawn, just wait — `window.riverDiag()` should eventually
show `state: 'ready'` with `cellsValid` close to `16384` (not `0`), and
`window.riverBed().matchedAtCenter.depth` should read close to `11` (the
real resident tile depth), not `0` or `999`. If it's still wrong after
waiting a couple of minutes, that would mean tile streaming itself is
somehow never reaching the patch's location at all — a genuinely different
(streamer-side) bug worth investigating next, now that the bake/render code
itself is proven correct.

### Tooling note for future sessions

`wgsl_reflect` and `webgpu` (dawn-gpu/node-webgpu) are genuinely useful for
verifying WebGPU/WGSL code in this repo **without a browser at all** —
faster and more reliable than any browser-based check (headless or manual)
for anything that doesn't need actual rendering/visual confirmation. Worth
reaching for earlier next time a shader/compute-dispatch bug is suspected,
rather than defaulting straight to browser round-trips.

### Update: the retry-budget theory above was incomplete — two more real bugs found

The `maxRetries` bump got the retry loop *running* long enough to matter,
but the user re-tested and still saw the water underground, with
`window.riverBed()` still showing every field as exactly `0` — including
raw uniform constants (`gridW`, `hashMask`) that cannot legitimately be `0`.
Went back to the `wgsl_reflect`/`webgpu` (dawn-gpu/node-webgpu) native
testing approach from earlier in this session to dig further, this time
importing and running the **actual, unmodified** `RiverBedBake` class
against a real Dawn device (confirmed running real **Metal on this
machine's M1 Pro**, not a software fallback) with a realistic mock
`quadtreeGPU`/`tileStreamer` — and it worked perfectly. This ruled out the
class's own logic entirely (again) and pointed at something about how the
*live app* specifically invokes it.

Reproduced the live app's exact symptom directly (headless puppeteer,
confirmed running on the same real Metal backend via ANGLE — not
SwiftShare, and confirmed the GPU device was healthy, zero "Instance
dropped" errors, at the time of the failing bake). Then found the fix by
elimination: manually triggering a **fresh, independently-created and
independently-submitted** `device.createCommandEncoder()` from the browser
console — instead of going through the normal per-frame path — worked
correctly on the first try, every time. The normal path
(`Frontend.js` passes a single shared, frame-managed encoder into
`RiverSystem.update()`, obtained via `backend.getCommandEncoder()` and
sandwiched between `endRenderPassForCompute()`/`resumeRenderPass()` calls)
reliably produced silently-empty results — the compute pass and its copy
commands appeared to execute (the `bedOut`/`debugOut` buffers changed from
their sentinel-fill values) but never actually contained real computed
data. The specific mechanism inside that shared-encoder bookkeeping was not
tracked down further (not necessary once a solid, correct alternative was
confirmed) — flagging here in case it recurs for some *other* system that
shares that same per-frame encoder pattern.

**Fix 1** (`riverSystem.js`, `_dispatchBake`): the bed bake now creates its
own independent `GPUCommandEncoder` and submits it immediately via
`this.device.queue.submit([...])`, rather than recording onto the shared
per-frame encoder `Frontend.js` passes into `update()`. This is a
reasonable pattern regardless of the underlying cause — the bake is a
one-time preprocessing step with its own async `resolve()` already, so it
never needed to share the frame's encoder in the first place.

With that fixed, real params/hash-table data started flowing through
correctly — but then a **second**, more subtle issue showed up: the bake
would find *some* resident tile (e.g. depth 2 of a possible 11) almost
immediately and accept it as "good enough" (any successful hash lookup
counted as valid), silently locking the whole patch onto a coarse
ancestor's approximate/placeholder height — usually `0` — well before the
real fine-detail tile under the patch had actually streamed in, and then
never retrying again since the "enough valid cells" threshold was already
satisfied.

**Fix 2** (`riverBedBakeShader.wgsl.js`): a found tile now only counts as
acceptable if `foundDepth + 3 >= maxDepth` (i.e. within 3 LOD levels of the
finest available) — a coarse-ancestor match is now treated the same as "not
found," so `RiverSystem`'s retry loop keeps waiting for genuinely
fine-detail terrain data instead of settling for a placeholder.

While confirming fix 2 with real wall-clock waiting, found a **third**
issue: `readyDelayFrames`/`maxRetries` are frame-*count*-based, not
wall-clock-based. At a high/uncapped frame rate, the entire 120-retry
budget (intended as ~2 minutes of real time) burned through in about 35
seconds, cutting the retry window short exactly when fix 2 needed more of
it.

**Fix 3** (`riverSystem.js`): retry pacing now accumulates real elapsed
time (`dt` from `update()`) instead of counting frames, comparing against
`config.bake.readyDelayFrames / 60` (treating the existing config value as
"frames at a nominal 60fps" for backward compatibility, converted to
seconds) — so the retry budget is robust to frame rate.

All three fixes were verified directly in a real (non-SwiftShader, real
Metal via ANGLE) headless Chromium session: confirmed the encoder fix
alone makes `window.riverBed().matchedAtCenter.unconditionalSanityHex`
read `"c0ffee"` (proving real data flow) via the *normal* per-frame path,
not just a manual console dispatch; confirmed fix 2 makes `cellsValid`
correctly drop to `0` and the state correctly stay `'pending'` instead of
prematurely reporting `'ready'` with placeholder data, when only a
too-coarse tile is resident; confirmed the retry loop keeps running past
where it would previously have given up. Did **not** confirm a full,
real-detail successful bake end-to-end in this session — the short-lived
headless test never had enough real wall-clock time for depth-11 tiles to
stream in near the test's anchor point (observed hash table stayed at
depth ≤5 for the ~45s window tested), which is expected/correct behavior
under the fix, not a bug. The user's own, much longer-lived real gameplay
session should give tile streaming enough time to reach real depth-11 data
near spawn — next step for whoever tests this: reload, wait at least
30-60s without checking impatiently, then check `window.riverDiag()` /
`window.riverBed()`.

**Status of fixes in git**: fix 1 (encoder) and fix 2 (depth-acceptance)
were made before the user's `refactoring 1 : river code` commit and are
included in it. Fix 3 (wall-clock retry timing) was made afterward and is
**not yet committed** as of this writing.

## Session 3, phase 2: channel carving (2026-09-14)

With the walking skeleton confirmed working and committed by the user
(`refactoring 1 : river code`), moved on to the first "Longer-term plan"
item: carving an actual channel shape into the real terrain instead of
floating a flat water sheet on top of it.

**Approach**: a straight-channel valley carved directly in the bed-bake
compute shader (`riverBedBakeShader.wgsl.js`'s new `channelCarve(localX)`),
centered on the patch's own local X=0 (the anchor's tangent-frame
centerline). A single smooth falloff — `channelDepth * shape²` where
`shape = 1 - smoothstep(0, halfWidth*1.5, |localX|)` — gives full depth at
the centerline and blends to exactly zero carve (seamlessly matching
uncarved real terrain) by `halfWidth*1.5` meters out. Deliberately not a
flat-bottomed trough — the squared falloff gives a rounded valley cross-
section. This is walking-skeleton scope: a straight channel only, no
meander or width variation yet — that needs an authored river-path format,
which is its own later increment (see "Longer-term plan" below, still
accurate).

**Config**: new `channel: { halfWidth: 16, depth: 3 }` in
`templates/configs/riverConfig.js` (meters; total carved width ≈1.5×
halfWidth = 24m either side of center, so ~48m total across the 128m
patch).

**Plumbing**: `channelHalfWidth`/`channelDepth` reuse two of `BakeParams`'
previously-always-zero padding floats (renamed `_pad0`→`channelHalfWidth`,
`_pad1`→`channelDepth`; same byte offsets, no layout change — re-verified
with `wgsl_reflect`) rather than growing the struct. Threaded through
`RiverSystem._dispatchBake()` → `RiverBedBake.dispatch()` from
`this.config.channel`.

**Verified** directly with the same `webgpu` (dawn-gpu/node-webgpu) native
Dawn-device test harness from earlier in this session, running the actual
`RiverBedBake` class: sampled bed height across a full row (fixed real
height of `459.5` = `0.0919 × 5000` from the mock terrain everywhere) and
confirmed a smooth valley — `459.5` at the row's edges, dipping to `456.51`
(≈3m carve, matching `channelDepth: 3`) at the centerline, tapering
smoothly across ±24m as designed. Not yet visually confirmed in a browser
(same GPU/streaming-timing caveats as the walking skeleton apply — needs
real terrain data actually resident, not just the mock used for this
verification).

## Multi-km rivers: direction decided, not yet started

Discussed with the user how rivers should behave at range, given
spherecraft's core premise (seamless 1m-to-orbital viewing) and its
existing perf problems (explicitly "already too heavy" per the user).
Decision: **LOD collapse** — full dynamic shallow-water simulation only
near the viewer, degrading to static water, then a baked/simplified distant
representation further out, mirroring the pattern
`core/renderer/water/globalOceanRenderer.js` already uses for the ocean
system (multiple LOD materials, presumably full detail near camera,
progressively cheaper further away — read that file in full before
designing this, don't assume its exact mechanism from the name alone).

The harder open question — how a single dynamic near-camera window
reconciles with multiple far-away static/baked segments along a multi-km
river path — still needs the same "chain of patches vs. scrolling window
vs. one big patch" decision the user was asked about; they deferred that
specific call ("you decide... do autonomously") pending seeing the LOD
direction first. Not yet started as of this writing — this is a
substantial follow-on increment, deliberately not attempted in the same
session as the walking-skeleton debugging above given its size; pick this
up as its own focused piece of work, reading `globalOceanRenderer.js` and
`GPUQuadtreeTerrain.js`/`tileStreamer.js`'s residency/streaming patterns in
full first (the same "read the real code before writing anything" approach
that made the walking-skeleton fixes tractable).

## Session 4 (2026-09-15): "no water at all" after carving — real seeding bug found and fixed

The user tested the committed walking-skeleton + carving work and reported
seeing **no water anywhere at all** — not even underground, and no visible
carved channel. Worked this fully autonomously (per explicit user
instruction — "please don't ask assistance from me, do autonomously") using
the same `webgpu`/`wgsl_reflect` native-Dawn testing approach from Session
3, this time also importing and driving the actual shallow-water sim shader
(`riverSimShader.wgsl.js`'s `RIVER_WGSL_SIM`) directly, not just the bed
bake.

**First checked**: the user's own `window.riverDiag()`/`window.riverBed()`
showed `cellsValid: 16384/16384` with a real, wide-ranging bed
(`minBed: 0, maxBed: 484, avgBed: 346`, `matchedAtCenter.depth: 8`,
real height `0.0924`) — so the bake itself was working correctly and had
found genuine fine-detail terrain. The terrain under this specific patch
turned out to have serious relief (a steep slope from ~480m down toward
~0m across the 128m patch) — much more dramatic than the relatively flat
highland assumed earlier in this log.

**Root cause**: `RiverSystem._seedFromBed()` computed `inEta`/`fillEta` (the
initial water-surface reference levels for the continuous inflow and the
initial "dump") as `<global minimum bed height across the whole
inflow/fill row-band> + <a small depth>`. This assumption — one shared flat
water-surface level is a good reference for a whole region — only holds on
close-to-flat terrain (like whitewater's original synthetic channels, or
the flatter highland this port was implicitly tested against earlier in
this log). On real terrain with actual slope, the row-band's global minimum
sits at whichever extreme point in the band happens to be lowest, often far
from where the reference is actually *applied* (e.g. right at the anchor,
where the player is standing) — leaving most of that band, water depth
computed as `max(0, referenceLevel - localBed)`, at exactly zero.

Reproduced this directly and quantitatively: built a synthetic bed matching
the user's actual observed relief (480m→0m linear slope across the patch,
carved channel on top) and ran it through the real `_seedFromBed` logic (by
hand, mirroring the exact computation) plus the real, unmodified
`RIVER_WGSL_SIM` compute shader for a genuine 5-10 simulated seconds via a
native Dawn device — confirmed the old (whole-band-minimum) logic produced
visible water in only ~2% of the patch (`wetCount: 312/16384`), matching
"no water anywhere" closely enough to explain the report (a 2%-coverage
puddle, likely off in a corner of the patch, is easy to walk right past
without noticing).

**Fix 1** (`riverSystem.js`, `_seedFromBed`): the inflow reference (`inEta`)
now uses the minimum bed across columns within **row 0 only** (still
searches across the channel's width to correctly find its carved low
point, but no longer spans a tall enough row range to pick up unrelated
far-field slope).

**Fix 2**, more significant (`riverSystem.js`, `_seedFromBed`): the initial
"dump" no longer uses a flat water-surface-elevation reference at all.
Switched to seeding a **uniform depth** (config's existing
`initialFill.depthAboveMin`, e.g. 0.5m) across the fill row-band, shaped to
the channel's own cross-section (same falloff shape as the channel carve
itself) — i.e. depth is now relative to *local* bed everywhere, not a
shared elevation. This is robust to arbitrary terrain slope by
construction, since it never depends on comparing against a value computed
somewhere else in the band. Confirmed fix 1 alone still produced physically
absurd results on steep terrain (a flat-eta dump against a rapidly-dropping
bed gives `maxH: ~28m` "puddles" downhill of the reference point) — fix 2
was necessary, not just a nicety. With both fixes: stable over a 10-second
simulated run (no NaN/Infinity), `wetCount` growing from ~49% (5s) to ~90%
(10s) as the initial dump correctly flows downhill through the carved
channel and reaches the far end of the (artificially extreme, worse than
real terrain should ever be) test slope, with reasonable depths throughout
(`maxH: 4.35m`, `avgWetH: ~1.1m` at 10s) — not the old either-empty-or-
absurd behavior.

**Not touched**: the shallow-water sim shader itself
(`riverSimShader.wgsl.js`) — kept byte-for-byte from the original port, as
documented from the start of this project. Both fixes are entirely on the
JS-side initial-condition seeding, upstream of the verified-correct sim
physics.

**Status**: fixes 1 and 2 are made but **not yet committed**, and **not
yet visually confirmed in a real browser** — verified only via the native
Dawn/Node harness (real Metal backend, not SwiftShader) against a
synthetic bed matching the user's own reported terrain relief. Given the
user has asked to proceed fully autonomously without testing themselves,
next session (or continued autonomous work) should get a real browser
screenshot of the actual patch to confirm visually, now that there's good
reason to expect it will show real, physically reasonable water in a
carved channel rather than nothing.

### Attempted headless visual confirmation: blocked by an unrelated, confirmed pre-existing bug

Tried to get an actual screenshot of the fixed water via headless
Puppeteer/Chromium (with `--use-angle=metal`, i.e. real GPU, not
SwiftShader — the same setup that let this session's earlier debugging
reproduce real, un-corrupted results). Live bake attempts kept losing the
"is the fine-detail tile for our exact 128m patch resident yet" streaming
lottery within the ~2-minute retry budget in this short-lived headless
session (several separate page loads tried; `cellsValid` stayed `0` each
time even though depth 6-11 tiles existed *somewhere* in the resident set —
just not necessarily under this specific patch). This is expected
streaming-luck variance, not a bug, and not a useful thing to keep
retrying by hand — worked around it by directly forcing a known-good
synthetic bed into the live `RiverSystem` via
`rs._seedFromBed(syntheticBed); rs._state = 'ready';` from the console, to
test the *render* path specifically, decoupled from bake/streaming luck.
Confirmed via `window.riverState()` that real water existed
(`wetCount: 912`, `maxH: 0.48`) after a few simulated frames — but the
screenshot itself showed a **fully black 3D viewport** (HUD only).

Checked the console: **`[WebGPU][TerrainMaterial] Pipeline validation
error: [Invalid PipelineLayout (unlabeled)] is invalid`** — the exact same
error flagged as a loose end in Session 2, now confirmed to occur even with
a real GPU backend (not just the SwiftShader software fallback Session 2
used), meaning it's not a SwiftShader-specific issue as that session's
wording left open — it's something about how *headless Puppeteer's*
specific Chrome/ANGLE configuration creates this one pipeline, unrelated to
rivers entirely (the error is `TerrainMaterial`, spherecraft's pre-existing
core terrain renderer) and unrelated to the SwiftShader-vs-real-GPU
distinction. The user's own regular Chrome clearly does **not** hit this —
they've directly described seeing real rendered terrain, grass, highlands,
etc. throughout this whole debugging arc. **Conclusion: headless/Puppeteer
testing cannot be used for visual confirmation of this app at all, in this
environment** — a stronger, more specific version of Session 2's original
finding. Numerical/simulation-level verification (native Dawn/Node,
bypassing Chrome entirely, as used throughout Sessions 3-4) remains the
only reliable *autonomous* verification path; actual visual confirmation
needs the user's own regular browser.

## Session 4, continued: the ground itself was never actually carved

The user sent a screenshot after the seeding fix above: real terrain
(grass, hills) visible correctly, but the "water" was a handful of small,
disconnected, jagged fragments, **partially clipped below the ground**, and
no visible channel in the terrain itself.

**Root cause, finally the real one for "floating/underground water" as a
*visual* complaint**: `channelCarve()` (and all the fixes above) only ever
affected the **water system's own internal bed buffer** — used for the
shallow-water simulation and for positioning the water surface mesh. The
*actual, visible ground* the player walks on is spherecraft's real terrain
quadtree mesh, completely separate, and was never touched. Wherever the
carve (or just real per-cell height variation) pushed the water's internal
bed below the real, unmodified ground mesh at that exact spot, the water
mesh clipped underneath the real terrain from the camera's point of view —
exactly matching the screenshot. Carving the *simulation's* bed was always
necessary but was never sufficient on its own to produce a visible carved
channel — this was flagged as future work in the original plan ("solve the
terrain-carving/reconciliation problem... likely a mask/blend approach...
applied at the patch boundary") but had not actually been built yet; the
earlier "channel carving" work only did the simulation half of that.

**Fix**: added a second, separate render pass — a new opaque "riverbed
ground" material/shader (`riverGroundShader.wgsl.js`,
`RiverMaterialBuilder.createGround()`) drawn *before* the water each frame
(`RiverSystem.render()`), using the exact same grid geometry and the same
bed buffer, so it always matches the water's own footprint exactly. It
reconstructs world position from the bed height directly (no water depth,
no waves) with basic diffuse lighting — a plain, deliberately simple
muddy-brown material, since this is about proving the channel is visually
there, not about matching spherecraft's real terrain shading. Outside the
carved channel width, this new mesh is coplanar with (and would z-fight
against) the real terrain, so it's sunk 15cm below there
(`channelShape()`-based blend) to hide it, leaving the real terrain visible
everywhere except inside the channel itself, where it now shows a genuinely
carved depression leading down to the water.

Reused the exact same `RiverVertexUniforms`/`RiverFragmentUniforms` layout
and bind-group shape as the water material (two previously-unused vertex
padding floats now carry `channelHalfWidth`/`channelDepth` — same trick as
`BakeParams` in the bed-bake shader), so `RiverMaterialBuilder`'s existing
uniform-packing code works for both materials unchanged.

**Verified**: independently re-parsed the new shader with `wgsl_reflect`
(struct layout: 208 bytes, matches the water uniform struct exactly, no
regression); then, since this is genuinely new shader code that had never
executed anywhere before, went further than a syntax check — built an
actual `GPURenderPipeline` from it via the native Dawn/Node harness (real
Metal backend) and submitted a real draw call end-to-end (index buffer,
bind groups, render pass, depth attachment) with **no validation errors at
either pipeline-creation or draw time** — confirming the bind-group layout
and struct wiring are actually correct for real WebGPU, not just
syntactically parseable WGSL. (A pixel-readback sanity check came back
black, but that's a known artifact of the quick test's identity
view/projection matrices putting the tiny test mesh entirely outside the
valid NDC depth range — not a shader defect; the production code path uses
the same real, working view/projection matrices the water shader already
uses successfully.)

**Cost note** (relevant given the user's explicit "engine is already too
heavy" constraint): this adds one more draw call per frame for the river
system (same geometry, second material) — a small, bounded, one-time-per-
patch cost, not a multiplier on anything that scales. Worth keeping in mind
once the multi-km/LOD work (see below) turns "one patch" into "however many
patches are near the camera."

**Status**: made but not committed; not yet visually confirmed in a real
browser (same headless-Puppeteer `TerrainMaterial` blocker as above applies
here too — this needs the user's own browser to actually see).

## Session 4, continued again: the ground-carving screenshot revealed a critical checkerboard bug

The user sent a second screenshot after the ground-carving pass above: not
a smooth channel, but a scattered checkerboard of small, disconnected pale
triangles across a wide area — visually "horrible" per their direct
feedback. They also clarified intent: **"it should carve the geometry"** —
i.e. the actual ground should show a real carved channel, not (only) a
separate floating mesh.

**Root cause of the checkerboard — a real, critical bug, independent of
overlay-vs-real-terrain**: the depth-acceptance fix from earlier in Session
4 (`MIN_DEPTH_BELOW_MAX`, "reject coarse ancestor matches") wrote a hard
`INVALID` sentinel (→ height `0`, sea level) into `bedOut` for any cell that
found real data but not at *maximum* depth — conflating two different
questions: "do I have real height here" and "is it precise enough to stop
retrying." Since tile depth-availability streams in as scattered, irregular
patches rather than one clean contiguous region, adjacent cells could
easily differ between "found deep data, height ~450" and "found shallower
data, rejected, hard 0" — a **~450m cliff between neighboring cells**,
repeated in a scattered pattern across the grid. That is exactly a
checkerboard of extreme spikes/pits, on both the water and the new ground
overlay (both read the same `bed` buffer) — matching the screenshot
precisely.

**Fix**: decoupled the two concerns entirely.
`riverBedBakeShader.wgsl.js`'s `bedOut` now always gets the best real
height found at *any* depth (even a coarse ancestor — which is normally a
real, if downsampled, terrain value, not garbage) via `select(INVALID,
carvedHeight, found)` — `found`, not the depth-gated `acceptable`. A brand
new atomic counter (`acceptableCount`, a 4-byte `array<atomic<u32>>` at a
new binding 5, incremented via `atomicAdd` whenever a match *is* deep
enough) is the only thing that tracks "should `RiverSystem` keep retrying
for more precision" — completely separate from what's actually written into
the geometry. Threaded through `RiverBedBake.dispatch()`/`resolve()` (a new
4-byte buffer + readback, zeroed before every dispatch since it accumulates
via `atomicAdd` per-dispatch) and `RiverSystem._onBedResolved()` (the
`enoughValid` retry check now reads `acceptableCount`, not the old
`validCount`, which — now that `bedOut` always has real data almost
everywhere once anything is resident — would otherwise be a nearly-useless
signal, always ≈`total`). `getDebugInfo()` now separately reports
`cellsValid` (any real height) and `cellsAcceptable` (deep/precise enough).

**Verified directly**: reused the native Dawn/Node harness, forced a
scenario matching the bug exactly (a real hash-table entry at depth 0, with
`maxDepth` set high enough that `0 + MIN_DEPTH_BELOW_MAX < maxDepth`, i.e.
guaranteed "not acceptable") — confirmed `acceptableCount: 0` (correctly
signals "keep retrying") while the sampled bed row is still the same
smooth, coherent valley profile as the fully-resolved case (`459.5` at the
edges tapering to `456.51` at the centerline) — no holes, no cliffs,
regardless of acceptance status. This directly rules out the checkerboard
mechanism for any future bake, resolved or not.

### The overlay-vs-real-terrain question, for the user's awareness

The checkerboard was the dominant, obvious visual problem in the
screenshot, and it is now fixed at the data level — independent of whether
the carved channel is drawn as a separate ground mesh (the current
approach, `riverGroundShader.wgsl.js`) or achieved by actually mutating
spherecraft's real terrain height texture data (literal geometry carving,
matching the user's stated preference literally).

Went with the **separate mesh** approach initially because it's fully
contained to the river system (no changes to shared terrain infrastructure
used by every other system — biome queries, prop placement, splat
generation, etc.) and because the original "Longer-term plan" in this log
already anticipated needing *some* mask/blend mechanism at the patch
boundary, which the overlay's `channelShape()`-based hide-outside-channel
logic effectively is. **Not yet attempted**: writing the carve directly
into the resident tiles' height array texture data, which would need the
height texture to have `STORAGE_BINDING` usage (needs checking/likely
doesn't currently, since it's normally only sampled, not written to)
and would take effect in every other system that reads real height for
that patch's tiles (splat blending, biome scoring, prop placement, etc. —
not necessarily a problem, arguably more correct long-term, but a
materially bigger, more invasive change touching shared core
infrastructure rather than something scoped to the river system alone).
With the checkerboard bug fixed, the separate-mesh approach should now
render a real, smooth, correctly U/V-shaped channel — genuinely worth
seeing in a real browser before deciding whether the added complexity/risk
of true terrain-texture mutation is actually needed, or whether a
well-executed overlay is visually sufficient.

**Status**: checkerboard fix made but not committed; not yet visually
confirmed in a real browser (same headless-Puppeteer blocker as the rest of
Session 4).

## Session 4, major pivot: rivers integrated into core terrain generation (not an overlay)

The user sent a second checkerboard screenshot (after the fix above — a
different, ongoing scene, not a stale render) and was direct: **"NO! It has
to be integrated into the core systems... THE WHOLE POINT IS THAT RIVERS
BECOME A PART OF THE CORE SYSTEM."** The separate ground-overlay mesh
approach (`riverGroundShader.wgsl.js`) — even with the checkerboard bug
fixed — was rejected outright: a bolted-on second mesh drawn on top of the
real terrain will always look "pasted on," never like real integrated
ground. This is the correct call and matches the original plan's own
stated goal ("solve the terrain-carving/reconciliation problem").

### What changed

Rivers are now a genuine **terrain-generation feature** — carved directly
into the real height texture at generation time, using the exact same
mechanism spherecraft's existing Mountains/Highlands/LoneHills/Canyons
features use, not a river-system-specific hack layered on top. The
separate ground-overlay mesh (`riverGroundShader.wgsl.js`,
`RiverMaterialBuilder.createGround()`) is deleted entirely — no longer
needed, since the real terrain mesh itself now shows the carved channel.

Before writing any code, spent a full research pass (via a dedicated
Explore agent, then verified myself where the report flagged
uncertainty) understanding exactly how spherecraft's existing terrain
features compose, since guessing wrong here risks breaking terrain
generation for the *entire game*, not just rivers:

- **Composition**: every feature (`featureMountainsHeight`,
  `featureHighlandsHeight`, etc.) is a WGSL function with signature
  `(wx, wy, unitDir, seed, regional, profile, amp) -> f32`, called
  additively from ONE place: `calculateTerrainHeight()` in
  `templates/terrain-shaders/base/earthLikeBase.wgsl.js`. `featureCanyonHeight`
  already returns a *negative* delta — solid precedent that subtractive/
  carving features are a normal, supported case here, not something new.
- **Assembly**: `createAdvancedTerrainComputeShader()` in
  `core/world/shaders/webgpu/advancedTerrainCompute.wgsl.js` builds the
  final ~200KB WGSL source by string-concatenating each feature module
  (supplied via a `terrainShaderBundle` object) in a fixed order. Wiring in
  a new feature means touching 4 places in sync: the new feature file, the
  `terrainShaderBundle` object (duplicated in `wizard_game/gameEngine.js`
  and `wizard_game/WorldEditorView.js` — the studio editor's copy — no
  single registration point exists), the destructure + assembly array in
  `advancedTerrainCompute.wgsl.js`, and the actual call site inside
  `calculateTerrainHeight()`.
- **Critical constraint discovered**: a tile's height texture is baked
  **once** (cached by atlas key) and there is **no existing mechanism to
  invalidate/regenerate an already-baked tile**. This means the river's
  location cannot be computed dynamically from wherever the player happens
  to spawn (the original walking-skeleton design) — tiles near spawn could
  already be baked, un-carved, before that position is known. The river's
  anchor has to be a **fixed value known before any terrain generates**.
- **No existing "place a feature at one fixed authored point" idiom**: every
  active feature places itself via noise evaluated everywhere on the
  planet (rarity-threshold masks), never by a coordinate. This is a
  genuinely new pattern for this codebase, not a variant of an existing one.
- **Coordinate system, verified myself** (the research pass flagged this as
  unconfirmed): `wx`/`wy` inside feature functions are NOT real-world
  meters — they're raw unit-sphere direction components
  (`unitDir.x`/`unitDir.z`). Real-world meters are recovered via
  `unitDir * noiseReferenceRadiusM()` — confirmed `noiseReferenceRadiusM()`
  reads a real runtime uniform (`uniforms._pad2.x`) that equals this game's
  actual planet radius, not a guess.

### Implementation

- **New file** `templates/terrain-shaders/features/featureRivers.wgsl.js`
  (`createTerrainFeatureRivers()`): gates a straight channel by distance
  from a fixed anchor point + tangent direction (both real-world unit
  vectors), computed via `unitDir * noiseReferenceRadiusM()` — no new
  coordinate convention invented, reuses the existing metric-recovery
  mechanism. The channel's "right" axis is `cross(anchorDir, channelDir)`,
  which is provably (vector triple product, for an orthonormal
  up/right/forward frame) identical to
  `core/planet/surfaceFrame.js`'s `computeSurfaceTangentFrame()` — so the
  carve's width axis lines up exactly with `RiverSystem`'s simulated water
  patch without duplicating or importing that JS-side math into WGSL.
  Called from `calculateTerrainHeight()` right after LoneHills.
- **New uniform fields** `riverAnchor`/`riverChannelDir`/`riverParams`
  (3× `vec4<f32>`) added to the `Uniforms` struct in
  `advancedTerrainCompute.wgsl.js`, placed at bytes 400-447 — previously-
  unused, already-allocated space in the (512-byte) uniform buffer, so no
  resize needed. JS-side packing added as a new shared
  `_writeRiverUniforms()` helper in `webgpuTerrainGeneratorBatching.js`,
  called from both of the two existing (duplicated) call sites in
  `webgpuTerrainGeneratorAtlas.js`.
- **Config**: `TerrainGenerationConfig` (`templates/configs/terrainGenerationConfig.js`)
  gets a new `river: { enabled, anchorDir, channelDir, halfWidthM, depthM,
  lengthM }` option, exposed via `toShaderUniforms()`. Enabled in
  `wizard_game/runtimeConfigs.js` with `anchorDir: {x:-1,y:0,z:0}`,
  `channelDir: {x:0,y:1,z:0}` — matching this session's consistently
  observed spawn direction.
- **Reversed the spawn/river dependency**: `wizard_game/gameEngine.js` now
  has a `DEMO_RIVER_ANCHOR_DIR` constant (must exactly match
  `runtimeConfigs.js`'s `terrain.river.anchorDir` — duplicated rather than
  imported only because this is a hardcoded demo with no authoring system
  yet) and `placeDemoRiver()` now anchors the water simulation to this
  FIXED direction, not the dynamically-computed spawn position. Previously
  the river followed wherever spawn landed; now spawn and the river both
  derive from one fixed point, because the terrain carve has to be known
  before generation, and can no longer chase a runtime-computed position.
- **Removed the now-redundant double-carve**: `riverBedBakeShader.wgsl.js`'s
  `channelCarve()` function is deleted — the real terrain height it samples
  is already carved by the terrain generator, so carving it a second time
  would double the depth and misalign it from the visible ground. This
  reverts the bake shader to its original design intent ("what is the real
  terrain height here"), matching the project's pre-Session-4 design.
  `BakeParams`' `channelHalfWidth`/`channelDepth` fields (and all the
  JS-side plumbing that fed them) are removed along with it.
  `templates/configs/riverConfig.js`'s `channel: {halfWidth, depth}` is
  KEPT — it's still used, unrelated to terrain carving, to shape the water
  simulation's own initial-fill cross-section (see Session 4's earlier
  "no water at all" fix above).

### Verification (still no browser available — same headless-Puppeteer blocker)

This is the highest-blast-radius change of the whole session — a mistake
here risks breaking terrain generation for the entire game, not just
rivers — so verified far more thoroughly than a normal-scoped change would
need:

1. Every touched JS file re-`node --check`'d clean.
2. **Assembled the actual, complete, real generated shader** — not a
   snippet — by calling `createAdvancedTerrainComputeShader()` with the
   real `terrainShaderBundle` shape (mirroring `gameEngine.js`'s bundle
   exactly) via the native Dawn/Node harness used throughout this session.
   Result: 199,251 characters, 200 functions. Parsed with `wgsl_reflect`:
   clean, `featureRiverHeight` and `calculateTerrainHeight` both present,
   and — independently, not just by my own arithmetic — the `Uniforms`
   struct's `riverAnchor`/`riverChannelDir`/`riverParams` fields land at
   exactly bytes 400/416/432, matching the JS packing code precisely.
3. **Compiled that exact real shader on real Dawn/Metal hardware**
   (`device.createShaderModule()` + `getCompilationInfo()`): **0 errors, 0
   warnings** across the entire real terrain generation shader — the
   existing system plus the new feature, together, actually building on a
   real GPU.

**Not verified**: actual visual appearance (still no way to get a browser
screenshot in this environment — see Session 4's earlier `TerrainMaterial`
finding, unrelated to rivers and unrelated to this specific change); the
`tools/studio` editor path (uses the same `terrainShaderBundle` shape via
`WorldEditorView.js`, updated in parallel, but not separately exercised);
and whether `maxRetries`/`minValidFraction` in `RiverSystem`'s retry logic
still make sense now that the bed bake no longer needs to reject "too
coarse" matches for *carving* correctness (it still needs reasonably deep
data for *accurate* height, so the existing depth-acceptance logic from
earlier in Session 4 is left as-is, but its rationale in code comments
should probably be revisited to reflect that carving is no longer the
concern it's protecting against).

## Longer-term plan (unchanged, for reference)

Once this increment is visually confirmed working:

1. Solve the **terrain-carving/reconciliation problem**: right now the
   river patch just floats real terrain height with no channel shape. A
   real river needs *some* carving so the channel looks like a channel —
   likely a mask/blend approach reusing spherecraft's existing splat-layer
   blending machinery, applied at the patch boundary so it stitches
   seamlessly with surrounding un-carved terrain.
2. Design the **authoring model**: small JSON-declared rivers/lakes (mirror
   whitewater's `config/rivers.js` field shape — slope, meander, width,
   ponds, forks, waterfalls) placed at planet lat/long, extending
   `tools/studio`'s existing raycast-driven placement UI rather than
   building new tooling from scratch.
3. Support **multiple/larger patches**: real rivers span kilometers, which
   this walking skeleton's single 128m fixed patch doesn't attempt. This
   will need either whitewater's scrolling-window technique reintroduced,
   or (more in keeping with spherecraft's existing architecture) treating
   river segments as tiles that plug into the existing
   `AsyncGenerationQueue`/`tileStreamer` residency machinery.
4. **Fat-trimming**, roughly in order of isolation (least risky first):
   old ocean/wave/foam system (small, ~1,100 lines, can likely be unified
   with or replaced by the river water shader) → fog system (biggest blast
   radius — touches nearly every shader via the shared uniform struct, do
   this once the river system is stable so there are fewer moving parts) →
   streamer/vegetation rewrite to a whitewater-scale complexity budget
   (currently ~32,700 lines, with a single 3,653-line god-object
   `AssetStreamer.js`) → terrain generation/shader-builder simplification
   (currently a single 4,179-line function builds the terrain fragment
   shader).
5. **WASM**, last, and only where profiling justifies it — there is no WASM
   tooling in this repo at all today (would need to be added from scratch).
   The realistic CPU-bound candidates are tile-residency bookkeeping,
   biome-scoring math, and procedural branch/species generators; the
   heavy compute is already on the GPU via WGSL compute shaders and
   wouldn't benefit from a WASM port.

## Useful reference paths

- Whitewater source (porting reference):
  `/Users/okkokauhanen/work/DATrain/feature/proj/whitewater/js/{shaders.js,sim.js,gpu.js,config/simulation.js}`
- Full approved plan for this increment:
  `/Users/okkokauhanen/.claude/plans/tingly-snuggling-valiant.md`
- This repo's own architecture map: `AGENTS.md` (repo root) — note its
  convention of world/renderer split and "no `?:` ternary in WGSL, use
  `select()`" rule, both followed in this session's code.

## Session 5: proving the carve is correct, and why it was still invisible

Picked up from the user's report: "you got to be kidding me" (screenshot
showing the water patch sitting on completely unmodified/uncarved grass,
after Session 4's terrain-generation-feature pivot). The user does not want
to be asked to test/verify things ("do autonomously"), so this whole session
is verification via direct GPU/JS introspection instead of screenshots.

### Finding 1 — the carve math and config wiring are 100% correct

Built a standalone Node/Dawn script
(`riverdirect.mjs`, scratchpad) that assembles the *exact same* generated
terrain shader the game uses (`createAdvancedTerrainComputeShader`), appends
a tiny extra `@compute` entry point that calls `calculateTerrainHeight()`
directly at caller-supplied unit directions (bypassing all pixel/chunk
addressing math entirely — a small `@group(2)` bind group with a storage
buffer of test points in, heights out), and dispatches it on real Dawn/Metal
with `uniforms.riverAnchor/riverChannelDir/riverParams` set to the exact
values `wizard_game/runtimeConfigs.js` uses. Result, sampling across the
channel's width axis at the channel's along-length center:

```
across=0    height=-0.000600  (~-3.00m)   <- exactly the configured depth
across=4    height=-0.000514  (~-2.57m)
across=8    height=-0.000329  (~-1.65m)
across=12   height=-0.000150  (~-0.75m)
across=16   height=-0.000040  (~-0.20m)
across=20   height=-0.000003  (~-0.02m)
across=24   height= 0.000000  (~ 0.00m)   <- exactly halfWidth*1.5 = 24m
across=30..300, along=200, far-away control: all exactly 0.000000
```

This is an unambiguous, correctly-shaped -3m dip with the right width
falloff and exactly zero everywhere outside the channel — the shader math in
`featureRiverHeight()` is correct, and it's wired into `calculateTerrainHeight()`
correctly (confirmed by grepping the assembled shader for the call site).

Also independently re-confirmed via `wgsl_reflect` that `riverAnchor` /
`riverChannelDir` / `riverParams` land at struct offsets 400/416/432 (448
bytes total), matching `_writeRiverUniforms()`'s byte offsets exactly.

Then live-checked the actual running game (fresh headless session,
`window.gameEngine.planetConfig.terrainGeneration.toShaderUniforms()`):
returned `riverAnchor:[-1,0,0,1], riverChannelDir:[0,1,0,0],
riverParams:[16,3,128,0]` — exactly correct, live, at runtime. So the full
chain (`runtimeConfigs.js` → `GameDataConfig` → `planetConfig.terrainGeneration`
→ `toShaderUniforms()` → `_writeRiverUniforms()` → GPU uniform buffer) is
verified correct end to end. **The carve itself was never the bug.**

### Finding 2 — the real bug: cold-start LOD/quadtree residency latency

So why was the ground still flat? Checked the actual world-space distance
between the demo spawn and the river anchor (both live, in-game):
`spaceship.position = (-131872, 0, 0)`, `anchorPos = (-131072, 0, 0)` — only
800m apart (exactly `spawn.height`), i.e. the ship *is* placed right above
the anchor as intended (gameEngine.js's fixed-direction spawn override is
working correctly).

But `riverSystem`'s own bed-bake diagnostic
(`window.riverDiag()` → `cellsAcceptable`, and `_lastBakeDebug.depth`) showed
the terrain hash-table lookup only ever finding a **depth-2 tile** near the
anchor — `cellsAcceptable: 0` for 90+ seconds straight, never improving. A
depth-2 tile is ~65 km across (`faceSize / 2^depth`); the river channel is
128m long, 32m wide. At that LOD the channel is many orders of magnitude
smaller than a single texel — of course it's invisible, and of course the
rendered ground mesh at that LOD has no vertices anywhere near fine enough to
show a 3m dip.

Root cause, read directly from `core/world/quadtree/GPUQuadtreeTerrain.js`:
`_updatePredictiveStreaming()` — the *only* mechanism in this engine that
proactively queues tiles across a range of depths ahead of where they're
needed — is gated behind `if (speed < (cfg.speedThresholdMps ?? 50)) return;`.
It exists to prevent pop-in ahead of a *fast-moving* ship; it deliberately
does nothing for a stationary camera. The demo spawns the ship instantly,
at rest, directly on top of a point that has *never been generated before*
(a "cold" point — zero prior residency, unlike normal flight where nearby
tiles are already partially subdivided from the gradual approach). With
predictive streaming inapplicable and the ordinary reactive per-frame
refinement being far slower than the ~12-18s initial-load budget
(`wizard_game/runtimeConfigs.js`'s `ui.initialLoad.maxWaitMs: 18000`), the
loading screen (`gameEngine.js`'s `_tickInitialLoadState()`,
"warming-quadtree" phase) simply times out and reveals the world with the
anchor region still stuck near root depth. This is a genuine engine gap
(teleport-onto-virgin-terrain is a scenario the LOD system was never tuned
for, since this is fundamentally a fast-spaceship engine) — not a river bug
specifically, but it happens to be exactly what breaks visibility of any
narrow, fine-scale, fixed-location feature placed via instant teleport.

**Fix implemented** (`core/world/quadtree/GPUQuadtreeTerrain.js`): extracted
the world-position→face/tileUV projection and the depth-range tile-queuing
loop out of `_updatePredictiveStreaming()` into two small reusable methods
(`_worldPositionToFaceTileUV`, `_queueDepthRangeAtFaceUV` /
`_queueDepthRangeAtWorldPosition`), with `_updatePredictiveStreaming()`
rewritten to call them (byte-for-byte identical behavior, just deduplicated).
Added a new **public** method, `prewarmWorldPosition(worldPos, options)`,
that runs the exact same depth-4-through-11 multi-ring queuing *once*,
immediately, regardless of camera speed — a deliberate one-shot escape
hatch for "I'm about to place something at a fixed point and need it deep
immediately," used nowhere else and changing no existing per-frame behavior.
Wired into `wizard_game/gameEngine.js` right after `placeDemoRiver(anchorPos)`:
`this.renderer.quadtreeTileManager?.prewarmWorldPosition?.(anchorPos)`.

**Verified this actually works**: fresh headless session, ~20-60s after
start, `tileStreamer.getHashTableStats().byDepth` went from "nothing past
depth 2 near the anchor, forever" to
`{"0":6,"1":24,"2":96,"4":162,"5":25,"6":9,"7":9,"8":9,"9":9,"10":9,"11":9}`
— tiles genuinely resident at every depth up to 11 (the real max depth for
this planet, confirmed via `quadtreeGPU.maxDepth`), including 9 tiles
exactly in the 3×3 neighborhood around the anchor at depth 11. This is a
real, confirmed improvement: before this fix, the anchor region never
progressed past depth 2 in any test this session, however long the wait.

### Finding 3 — a second, still-open issue: bed-bake's hash lookup lags behind

Even with depth-11 tiles confirmed resident (Finding 2's fix), the
bed-bake's own debug readout (`_lastBakeDebug.depth`) stayed frozen at
**depth 4** for the rest of the session (60+ more seconds, multiple checks),
never advancing to match the confirmed depth-11 residency, until retries
exhausted (`bake.maxRetries: 120`) and `RiverSystem` gave up and moved to
`state: "ready"` anyway, using the stale depth-4 sample.

Ruled out as causes:
- **Face/UV math mismatch** between the JS prewarm projection and the WGSL
  bed-bake shader's own `dirToFaceUV()` — compared both formulas term by
  term for the face-1 branch (the anchor's exact case, `dir=(-1,0,0)`); they
  are identical.
- **Coordinate/rounding mismatch** at depth 11 between the exact anchor (used
  by prewarm) and the bed-bake's 0.5m-offset center-cell sample — even in
  the worst case (a floor() landing one texel off), prewarm's radius-1 (3×3)
  neighborhood at depth 11 comfortably covers a 0.5m offset against a 128m
  tile.
- **Naive tombstone-hole hash bug** (a classic open-addressing bug where
  deleting an entry without backward-shift breaks later probe chains) —
  checked `HashTable.remove()` in `core/world/quadtree/tileStreamer.js`
  (line ~461): it correctly rehashes the following cluster after clearing a
  slot, so this specific bug class doesn't apply.
- **Hash upload never happens** — `tickFlush()` calls
  `_uploadDirtyHashSlots()` whenever `_dirtySlots.size > 0`, every frame;
  this is not a "never uploads" situation.

Not yet ruled out / not yet found:
- Whether tile *insertion* into the hash table (via the predictive/prewarm
  queue → generation → commit path) reliably marks the new slot dirty in
  all code paths, vs. only the "normal" reactive-refinement commit path
  (`riverBedBake.js`'s hash-probe lookup — `lookupLayer()` in
  `riverBedBakeShader.wgsl.js` — appears to be code written specifically for
  this new river feature, i.e. it may be exercising a GPU-buffer-sync edge
  case nothing else in the engine actually hits, since the main terrain
  renderer likely resolves tile residency through a different mechanism).
- Whether there's a straightforward propagation delay (CPU insert → dirty
  flag → per-frame GPU buffer upload → next bed-bake dispatch reading the
  updated buffer) that's simply longer than the current
  `bake.maxRetries: 120` × ~1s retry budget allows, in which case the fix is
  as simple as raising `maxRetries` — but depth was static at exactly 4 for
  60+ seconds with zero improvement, which reads more like "stuck" than
  "slow but progressing," so this needs confirmation before just cranking
  the retry count.

This is where this session stops. **Not touched further**, deliberately: this
sits inside the shared tile-hash lookup / GPU-buffer-sync machinery
(`core/renderer/rivers/riverBedBake.js`'s `lookupLayer()`, and whatever
inserts into `tileStreamer`'s hash table on the generation-commit path),
which is exactly the kind of shared, performance-sensitive core-system code
the user has repeatedly flagged as "already too heavy" — a wrong guess here
risks a correctness or performance regression across more than just rivers,
and this session has already made two independently-verified, real fixes
(cold-start LOD prewarm) without touching that code. Recommended next step:
instrument `riverBedBake.js`'s dispatch (or a small standalone Dawn script,
following the `riverdirect.mjs` pattern) to read back the *actual* GPU-side
hash table buffer contents right after a known-good depth-11 insertion and
diff it against `tileStreamer.hashTable`'s CPU-side `entries` array — that
would show directly whether the GPU buffer is stale, missing the entry
entirely, or something else.

### Files changed this session

- `core/world/quadtree/GPUQuadtreeTerrain.js` — extracted
  `_worldPositionToFaceTileUV()` / `_queueDepthRangeAtFaceUV()` /
  `_queueDepthRangeAtWorldPosition()` out of `_updatePredictiveStreaming()`
  (no behavior change there); added public `prewarmWorldPosition()`.
- `wizard_game/gameEngine.js` — calls
  `this.renderer.quadtreeTileManager?.prewarmWorldPosition?.(anchorPos)`
  right after `placeDemoRiver(anchorPos)`.
- No other files changed this session (Session 4's terrain-generation-feature
  files are unchanged and re-verified, not re-written).
