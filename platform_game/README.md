# platform_game — Cloud Platform Jumper

Toy program built on the Spherecraft WebGPU engine. A ball-shaped
character traverses a cold, mountainous, snowy planet, jumping across
floating cloud platforms, collecting coins and edibles, and progressing
through levels.

## Run

```
python3 server.py
```

Then open:

- `platform_game/standalone.html` — the game
- `platform_game/studio.html` — Spherecraft Studio with the platform_game world loaded

## Layout

| Path | Purpose |
|---|---|
| `standalone.html`        | Game bootstrap (minimal HUD + engine loop) |
| `gameEngine.js`          | `PlatformGameEngine` — subclass of wizard_game's `GameEngine` |
| `runtimeConfigs.js`      | `createEngineConfig` / `createGameDataConfig` tuned for a cold, mountainous, snowy world + platform-game knobs |
| `world/*.json`           | Studio-editable world config overrides |
| `ui/PlatformGameUI.js`   | Lean HUD — no wizard vitals, no wizard debug panels |
| `actors/BallModel.js`    | Primitive-sphere player mesh (no GLTF, renders through `GenericMeshRenderer`) |
| `actors/PlatformPlayerController.js` | Game-specific controller — stamina scaling, coyote-time, jump intent, anti-grav, fall damage |
| `actors/PlatformActorManager.js` | ActorManager subclass; spawns the player as a ball + owns a `PlatformColliderSystem` |
| `game/CloudPlatformModel.js` | Flattened ellipsoid mesh for a cloud platform |
| `game/CloudField.js`     | Streams ~30 cloud platforms around the player with stable pseudorandom placement + per-cloud motion modes; publishes top-surfaces to the collider system so the ball lands on them |
| `studio.html` + `studio-entry.js` | Spherecraft Studio entry for this game |

## Turn status

- [x] **Turn 1** — Basic controls and gravity. Ball walks on the spherical planet surface.
- [x] **Turn 2** — Randomly initialized cloud platforms with working landing collision.
- [ ] Turn 3 — Spawning enemies.
- [ ] Turn 4 — Berries, fruits, coins.
- [ ] Turn 5 — JSON level descriptions + Studio integration.
- [ ] Subsequent — Polishing.

## Render-pass fix for generic meshes in GPU-quadtree mode

In GPU-quadtree mode (the engine's active path), `Frontend.renderTerrain()`
drives its own compute+render ping-pong and leaves the render pass in a
state where the outer `Frontend.render()` call at the old generic-mesh
seam (line ~846) produced no visible pixels. Custom generic meshes
(platform_game's ball + cloud platforms) were drawn, but into a pass
whose attachments were no longer wired to the visible framebuffer.

Fixed by moving the `genericMeshRenderer.update() / .render()` pair
INSIDE the quadtree-mode block of `renderTerrain()`, right next to the
skinned-mesh draw (which was already drawing correctly there). The
outer seam now only runs in non-quadtree mode, so wizard_game's legacy
paths are unaffected and there's no double draw.

Applied in: `core/renderer/frontend/frontend.js` — new block right
after `skinnedMeshRenderer.render(...)` in the GPU-quadtree branch.

## Engine-level changes in core/ (reusable, not platform_game-specific)

All of these are generic physics/actor infrastructure so future games
get them for free. The old `wizard_game/actors/` paths now re-export
these modules, so `wizard_game` is unaffected.

- **`core/actors/movementResolver.wgsl.js`** — the spherical-planet
  movement resolver. New in this turn:
  - Vertical velocity integrated from radial gravity
  - `F_JUMP` intent flag; grounded-only jump impulse (`jumpVelocity`)
  - Per-actor `gravityScale` (0 ⇒ legacy terrain-snap mode, unchanged
    behavior for wizard_game; 1 ⇒ full physics; <1 ⇒ anti-grav fruit)
  - Air state: `airTime`, `peakFallSpeed`, `lastImpactSpeed`
  - A `hasLanded` guard so the long drop from spawn doesn't deal fall
    damage
  - Platform top-surface collider list (bindings 8–9). Platforms are
    discs in their own tangent plane; the resolver picks the highest
    of terrain vs any reachable platform when snapping.
  - Slope gating, tree-trunk collision, cube-sphere terrain sampling
    all retained verbatim.
- **`core/actors/MovementResolverPipeline.js`** — 10-binding compute
  pipeline with dummy zero-count buffers when callers don't supply
  tree/platform colliders.
- **`core/actors/ActorGPUBuffers.js`** — intent and state buffer pool.
  Intent extended with `jumpVelocity` + `gravityScale`; state extended
  with `vertVel`, `airTime`, `peakFallSpeed`, `lastImpactSpeed`,
  `altitude`, `hasLanded`. Readback surfaces all of these on the CPU
  actor.
- **`core/actors/PlatformColliderSystem.js`** — new. Games call
  `beginFrame()` → `add(topPos, radius, thickness)` → `upload()` each
  frame; the system binds its buffers automatically if it's set on an
  `ActorManager` as `platformColliderSystem`.

`wizard_game/gameEngine.js` also gains a handful of overridable hooks
so games can swap in their own UI / actor manager / ambiance without
editing the base class:
  - `_createGameUI()`, `_createActorManager()`, `_registerAmbiance()`,
    `_registerNPCs()`.

## What Turn 2 delivers end-to-end

- The player is a procedural blue sphere (`BallModel`), not a wizard.
- Cold snowy world — `terrain.climate.baseTemperature = -15` forces
  the tile-picker in `surfaceCommon.wgsl` to select snow tiles across
  most of the surface.
- Gravity, jump (Space), fall damage (proportional to impact speed
  above ~14 m/s).
- Anti-grav hook in the controller for the fruit effect.
- Stamina-scaled movement speed (constant decay + sprint/move drain).
- Cloud platforms:
  - ~32 clouds visible at a time, streamed by stable pseudorandom cell
    hashing
  - per-cloud motion modes: stationary / ping-pong / erratic / breathing
    spawn-fade
  - altitude 40–220 m above the nominal surface
  - their top surfaces are published as colliders each frame, so the
    ball actually lands on them

## Known caveats flagged for later

- The stamina system and a future fall-state animation will want a
  richer `_isMovementLocked` override once the ball has animation
  states. Currently `grounded`/`airTime` only drive physics.
- Spawn-cloud particle rain and pickup burst particles need the new
  particle types called out in the plan.
- `boss`/enemy spawning is intentionally off (platform_game overrides
  `_registerNPCs` to an empty no-op). Turn 3 introduces its own
  enemies.
