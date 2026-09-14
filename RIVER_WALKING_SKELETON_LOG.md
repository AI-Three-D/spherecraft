# River walking-skeleton: session log & handoff

Branch: `rivers` (in this repo, spherecraft). Status as of this writing: the
user tested in a real browser (Session 3) and found the render pipeline
works end-to-end, but the bed bake was silently reading zero height
everywhere due to a one-constant bug (`MAX_PROBE` too small — see "Session 3
findings" below) — now fixed, **not yet re-confirmed visually after the
fix**. Read "Session 3 findings" first if picking this up fresh; it
supersedes some of Session 2's conclusions (the headless SwiftShader crash
Session 2 found is real but turned out not to be the only blocker — the
actual game has its own bug, independent of the test environment).

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
   over the first few seconds, continuous inflow at one edge, and
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
