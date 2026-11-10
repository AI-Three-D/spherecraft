# Terrain Streaming & Generation Optimization Plan (v3)

## Context

A prior session attempted a from-scratch rewrite of the terrain height noise
stack (`calculateTerrainHeight()` / `getRegionalCharacter()` in
`templates/terrain-shaders/base/earthLikeBase.wgsl.js` and
`templates/terrain-shaders/features/featureContinents.wgsl.js`), replacing
the layered mountains/highlands/lone-hills/meso-detail/plains/hills/canyons
feature stack with a single warped ridged-noise field, aiming to cut compute
cost from ~160-220 noise octaves per call to ~10-15.

That attempt was reverted (`git reset --hard`) because it visually regressed
the terrain (a non-spherical "pyramid" horizon from altitude, a uniform
"golf ball" bump texture at ground level) and needed real art/tuning work to
look right — work the *original* stack had already had.

An independent performance audit
(`core/SphereCraft_Terrain_Performance_Audit.md`) was done in parallel and
reached a different, better-supported conclusion: the reported symptom
(80-100+ FPS when moving slowly, dropping to ~40 FPS or worse during rapid
movement) points to **bursty terrain streaming/generation pressure**, not
raw per-tile noise cost. The audit explicitly recommends against touching
the noise stack or adding erosion until burst control and tiered generation
are fixed first — noise optimization is step 9 of 11 in its own recommended
order, not step 1.

**Lesson learned:** a full rewrite of the noise stack is a high-risk,
low-leverage first move. Prefer the audit's own ordering: instrument first,
fix streaming/generation admission and tiering, then adaptive
quality/resolution, then corridor-based prediction, and only then do
*surgical* noise trimming (classify existing layers by cost vs. visual
contribution per LOD, cut the expensive-and-low-contribution ones) rather
than replacing the stack wholesale. Hydrology (lakes/rivers) and
Runevision-style erosion both come after that, as separate, later phases —
not folded into the noise rewrite.

This version (v3) folds in two follow-up architectural corrections (see
"Revisions" below); a third suggested revision was evaluated and rejected —
also documented below, so the reasoning isn't lost.

## Starting point for the next session

- The repo has been reset to the last commit before the terrain-
  simplification attempt, so the original (heavier but visually good)
  terrain stack is back in place.
- Read `core/SphereCraft_Terrain_Performance_Audit.md` in full before
  starting anything. It is the primary source of truth for ordering and
  specific recommendations (section numbers referenced below are from it).

## Priority order

1. **Phase 0 — Instrumentation.** Without this, optimization is guesswork.
2. **Phase 1 — Hard generation/admission budgets.** *(new, before tiering —
   see Revisions)*
3. **Phase 2 — Geometry-first generation, built on output masks + residency
   states** *(reframed from "tiered generation" — see Revisions)*: minimum
   drawable output resident immediately; everything else deferred and async
   (§2-4, §15, §16 of the audit). Likely the single biggest fix for the
   reported symptom, independent of the noise stack.
4. **Phase 3 — Adaptive generation quality** tied to camera velocity (§5).
5. **Phase 4 — Adaptive texture resolution** per LOD (§10, §11).
6. **Phase 5 — Velocity-aligned corridor predictive streaming** (§6).
7. **Phase 6 — Surgical noise trimming**, not a rewrite (§13-14): classify
   existing noise layers (macro/regional/mountain/erosion/micro/material) by
   cost *and* by actual visual contribution at each LOD; cut the
   expensive-and-low-contribution ones. The audit names
   `warpMultiscale3D()`'s multiple 4-octave FBM calls as a concrete thing to
   check. Prefer trimming/cheapening pieces of the *existing* stack over
   replacing it.
8. **Phase 7 — Hydrology as a separate internal subsystem** consuming
   elevation, not coupled into tile generation (§22; see Revisions for the
   Whitewater-framing correction).
9. **Phase 8 — Runevision-style procedural erosion**, replacing some
   high-frequency noise rather than stacking on top of it (§14). Only after
   the above is stable.

## Revisions from a second-opinion pass (ChatGPT), evaluated this session

1. **Accepted — hard admission budgets before the tiering refactor.**
   Tiering reduces cost *per tile*; it doesn't cap how many tiles get
   admitted into generation per frame. A fast camera requesting many
   cheap-tier tiles can still burst the queue/GPU fences the same way many
   expensive-tier tiles would. So before splitting output into tiers
   (former Phase 1), first add a hard ceiling — e.g. max GPU-ms of terrain
   generation admitted per frame, max concurrent in-flight generations,
   max new admissions per frame — that gates *any* generation request
   regardless of which outputs it asks for. This becomes the new Phase 1;
   tiering (now Phase 2) then decides what gets admitted first when the
   budget is tight, rather than being the only thing limiting burst size.

2. **Accepted — output masks + explicit residency states, not hard-coded
   Tier 0-3 semantics.** The audit's Tier 0-3 language (§3) is useful as
   *illustrative presets*, but shouldn't become the literal data model.
   Instead:
   - Each output type (height, normal, tile classification, splat source,
     splat data/index/valid, climate, scatter, resolved color) is an
     independent bit in a per-tile output mask — what's been requested and
     what's actually been produced, tracked separately.
   - Each tile has an explicit residency state (e.g. `Empty → Requested →
     FastGenerating → MinimallyResident → RefinementQueued → Refining →
     FullyResident`), driven by which mask bits are satisfied, not by which
     numbered "tier" it was assigned.
   - "Minimally resident" is defined as whatever mask the renderer actually
     needs to draw a tile at all (audit's Tier 1 content) — that's the one
     hard requirement; everything above it is just more bits filled in
     asynchronously.
   - This is more flexible (any combination of outputs can be requested,
     not just 4 canned bundles) and maps naturally onto the existing
     residency hash-table / array-texture-pool architecture, which already
     tracks per-tile state — it extends that model instead of adding a
     parallel Tier concept next to it.
   - Practical effect on Phase 2 below: implement it as mask + state
     machine from the start, with Tier 0-3 kept only as named presets for
     convenience (e.g. `TIER_1_MASK = HEIGHT | NORMAL | TILE`).

3. **Rejected — "treat Whitewater as an existing external subsystem, define
   an interface."** Checked this against the actual repo before accepting
   it, and it doesn't hold up: "Whitewater" here isn't a live external
   system SphereCraft talks to. `core/renderer/rivers/riverSystem.js`'s own
   header says its solver is "a port of whitewater's GPU shallow-water
   solver" — i.e. an *algorithm* that was already selectively ported
   in-house, not a running system on the other side of a boundary. More
   importantly, `CODEX_RIVER_LAKE_HANDOFF.md` already has an explicit prior
   decision on exactly this question: *"Whitewater is valuable for its
   shallow-water solver and local water behavior, not as a
   planet-generation architecture to transplant wholesale. Spherecraft must
   retain one integrated terrain source, resident-tile-aware sampling..."*
   Defining an "interface to Whitewater" would contradict that existing
   decision and invent an integration boundary that doesn't exist. Phase 7
   below keeps the audit's original framing instead: hydrology as a
   subsystem *within* SphereCraft, decoupled from tile generation, which
   may keep selectively reusing pieces of Whitewater's shallow-water-solver
   *technique* (as `riverSystem.js` already does for its per-frame grid
   sim) as one simulation tier — not a separate product to integrate with.

## Explicit non-goals for the next session (unless it revisits this later)

- No wholesale rewrite of `calculateTerrainHeight()` / `getRegionalCharacter()`
  from scratch.
- No adding erosion yet.
- No increasing generation concurrency, tile pool size, or texture
  resolution blindly (§26).
- No coupling hydrology into terrain tile generation.
- No treating Whitewater as an external system requiring an integration
  interface (see Revisions §3) — it's a reference algorithm, already
  partially ported into `riverSystem.js`.

## First session's actual task: Phase 0 + Phase 1 + Phase 2

### Phase 0 — Instrumentation

- Add per-phase timing to `TileGenerator.generateTile()` covering: request →
  generation start, generation start → compute submitted, compute submitted
  → GPU fence complete, fence complete → array copy, array copy → residency
  visible. Also per-GPU-phase timings (height / normal / tile classification
  / splat source / splat / climate / scatter / resolved color / copy / mip).
- Expose GPU fence count (`_gpuFencesInFlight`, `_maxGpuFencesObserved`),
  queue depth (pending/active), copy queue depth, and tile-pool pressure
  (free layers) in the existing debug HUD.
- Add p50/p95/p99 tile-request-latency and generation-latency reporting.
- Run the audit's own test protocol (§25): stationary → normal speed → max
  speed → reverse direction quickly → turn 90° while moving fast → stop
  suddenly. Record the full metrics list from §25 for each scenario to get a
  reproducible fast-flight profile, and use it to determine whether the
  dominant cause is (A) terrain compute, (B) queue saturation, (C) GPU
  command backlog, (D) residency churn, (E) feedback latency, (F) CPU
  scheduling, or (G) excessive tile requests.

### Phase 1 — Hard generation/admission budgets

- Add a hard per-frame ceiling on terrain-generation admission, independent
  of tiering: a max GPU-ms budget for newly-admitted terrain generation
  work, a max count of new admissions per frame, and a max concurrent
  in-flight count — enforced *before* any tier/mask decision, not as a
  side effect of it.
- Wire this into the existing GPU fence backpressure
  (`_gpuFencesInFlight`/`_maxGpuFencesObserved`) so the budget tightens
  automatically as fences pile up, per the audit's §7 policy (fences low →
  allow more; fences high → stop admitting).
- Verify with Phase 0's instrumentation that a burst of tile requests
  (e.g. the fast-turn/reverse-direction test) now produces a flat,
  predictable admission rate rather than an unbounded spike, *before*
  Phase 2's tiering changes anything about what those admitted tiles cost.

### Phase 2 — Geometry-first generation via output masks + residency states

- Introduce the output-mask + residency-state model described in Revisions
  §2, extending the existing residency hash-table/array-pool rather than
  adding a parallel concept.
- Define the "minimally resident" mask as whatever the renderer needs to
  draw a tile at all (height + normal + tile classification); everything
  else (splat, climate, scatter, resolved color) is requested as a
  follow-up mask on an already-resident tile.
- Make generation of the minimally-resident mask able to complete and mark
  a tile resident *without* waiting on the rest of the mask.
- Enqueue the remaining mask bits as an async "refinement" pass on
  already-resident tiles (§15, §16 of the audit).
- Milestone (the audit's stated first milestone): fast camera movement
  should stop producing large generation bursts / frame-time spikes.

## Verification

- Re-run the audit's test protocol before/after, comparing p95 tile
  latency, GPU fence peaks, and frame-time spike *frequency* during fast
  movement — not just steady-state FPS (§24: a stable 60 FPS with async
  refinement beats a spiky 100/100/100/42/18/75/100).
- Visual check in a real browser, not headless — headless screenshots are
  not reliable evidence for this project (established this session).
