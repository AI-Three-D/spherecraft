# SphereCraft — Architecture Direction

## Purpose

SphereCraft is evolving from a procedural planetary terrain renderer into a planetary environment system containing:

- procedural terrain generation
- cube-sphere / quadtree LOD
- GPU terrain generation
- tile streaming and residency
- predictive streaming
- procedural materials / biomes
- water simulation
- terrain-water coupling
- erosion

The goal is **not** to rewrite the existing engine.

The goal is to preserve the strong existing foundation while introducing clearer boundaries between:

1. terrain generation
2. terrain residency / streaming
3. terrain refinement
4. coupled terrain-water simulation
5. GPU scheduling

---

# 1. Preserve the Existing Foundation

Do not replace or redesign these systems unless instrumentation proves a specific problem:

- cube-sphere planetary topology
- GPU quadtree
- tile addressing
- deterministic procedural terrain
- GPU terrain generation
- tile residency
- tile array pools / texture pools
- GPU feedback
- asynchronous generation
- predictive streaming
- GPU backpressure
- ancestor fallback
- existing terrain noise stack
- existing visual terrain quality

The current terrain stack is visually valuable.

A previous attempt to replace the existing terrain function with a much simpler warped ridged-noise field caused significant visual regressions:

- pyramid-like horizon behavior at altitude
- uniform "golf ball" terrain at ground level
- loss of regional terrain character
- loss of carefully tuned existing features

Therefore:

> Do not perform a wholesale terrain-noise rewrite as a performance optimization.

Performance work should first attack scheduling, admission control, generation tiers, resolution, and unnecessary work.

---

# 2. The Current Performance Problem

Current behavior suggests:

- good steady-state performance
- significant frame-time degradation during rapid movement
- large numbers of tile requests during traversal
- expensive GPU terrain generation
- optional refinement work
- GPU fences and copy work

This strongly suggests a **streaming/generation pressure problem**, but this must be verified through instrumentation.

Do not assume that raw noise cost is the primary problem.

The important question is:

> What happens to GPU/CPU workload when camera velocity causes a large number of tiles to become necessary simultaneously?

Potential contributors include:

- request amplification
- too many tiles admitted per frame
- too many compute submissions
- excessive refinement work
- GPU fence backlog
- array texture copies
- mip generation
- CPU queue scheduling
- tile generation latency
- tiles generated after they are already irrelevant
- expensive output types being generated for tiles that only need geometry
- excessive texture resolution

---

# 3. Whitewater Changes the Architecture

Whitewater must **not** be treated as a clean standalone hydrology subsystem.

Inspection of the Whitewater repository shows that it is a tightly coupled terrain + water simulation prototype.

Important characteristics include:

- terrain buffers are directly consumed by water simulation
- terrain construction is part of the river/world setup
- water simulation uses terrain elevation directly
- channel geometry and terrain relief are coupled
- thermal erosion already modifies terrain-related geometry
- water state and terrain interact
- simulation uses multiple GPU compute passes
- the simulation operates over a finite Cartesian simulation grid/window

Therefore this architecture is insufficient:

```text
Terrain
   |
   v
Hydrology
   |
   v
Water
```

Whitewater is not simply:

```text
elevation -> hydrology
```

It is closer to:

```text
terrain geometry
       |
       +---- water state
       |
       +---- channel geometry
       |
       +---- erosion
       |
       +---- GPU simulation
```

The eventual SphereCraft architecture therefore needs a **coupled terrain-water simulation layer**.

---

# 4. Correct High-Level Architecture

The long-term structure should look more like:

```text
SPHERECRAFT
│
├── PLANET
│   ├── cube-sphere
│   ├── quadtree
│   ├── tile addressing
│   └── LOD selection
│
├── TERRAIN
│   ├── deterministic terrain function
│   ├── terrain generation
│   ├── terrain outputs
│   └── terrain refinement
│
├── STREAMING
│   ├── visibility requests
│   ├── predictive requests
│   ├── admission control
│   ├── residency
│   └── ancestor fallback
│
├── COUPLED SIMULATION
│   ├── simulation patches/windows
│   ├── terrain elevation
│   ├── water state
│   ├── velocity
│   ├── sediment
│   ├── erosion
│   ├── boundary conditions
│   └── persistent simulation state
│
└── GPU SCHEDULING
    ├── terrain compute budget
    ├── refinement budget
    ├── water simulation budget
    ├── copy budget
    └── GPU backpressure
```

The important distinction is:

> Terrain generation and water simulation are different workloads, but they share the same GPU and are coupled through terrain state.

---

# 5. Terrain Outputs Should Be Explicit

Do not hard-code generation tiers around arbitrary combinations such as:

```text
height + tile
height + normal + tile
height + normal + splat
...
```

Instead define an explicit output model.

Example:

```text
TerrainOutputs:

HEIGHT
NORMAL
CLASSIFICATION
SPLAT
CLIMATE
SCATTER
COLOR
```

Then define presets:

```text
EMERGENCY
    HEIGHT

GEOMETRY
    HEIGHT
    NORMAL
    CLASSIFICATION

MATERIAL
    HEIGHT
    NORMAL
    CLASSIFICATION
    SPLAT

FULL
    HEIGHT
    NORMAL
    CLASSIFICATION
    SPLAT
    CLIMATE
    SCATTER
    COLOR
```

The exact masks can change during implementation.

The important architectural point is:

> The terrain generator should produce the minimum data required by the current consumer/LOD state.

This also makes future water integration easier because the coupled simulation can explicitly request the terrain information it needs.

---

# 6. Explicit Tile State Machine

Avoid treating "generated" and "resident" as a single state.

Use an explicit lifecycle:

```text
REQUESTED
    |
    v
QUEUED
    |
    v
GENERATING
    |
    v
GEOMETRY_READY
    |
    v
RESIDENT
    |
    v
REFINING
    |
    v
REFINED
```

Potential cancellation/deprioritization can occur between states.

The key requirement is:

> A tile should become visually useful as soon as its minimum geometry data is ready.

Do not make the camera wait for every optional refinement pass.

Ancestor fallback remains valid while children are incomplete.

---

# 7. Coupled Simulation Is a Different Domain From Terrain LOD

Whitewater currently operates on a finite Cartesian simulation domain.

SphereCraft operates on a planetary cube-sphere with quadtree LOD.

These cannot simply be mapped one-to-one.

The future integration needs a simulation patch/window concept:

```text
SphereCraft planetary terrain
          |
          v
   simulation patch
          |
   +------+------+
   |             |
terrain       water state
elevation     velocity
              depth
              sediment
              etc.
```

The simulation patch needs:

- planetary coordinate transform
- local simulation coordinates
- terrain elevation sampling
- water state
- simulation resolution
- boundary conditions
- neighboring patch information
- persistent state
- LOD relationship
- streaming lifecycle

The simulation domain should be able to move over the planet without requiring the entire planet to be simulated.

---

# 8. Terrain and Water Must Share GPU Scheduling

Whitewater introduces another significant GPU workload.

Terrain generation may already contain:

- multiple compute passes
- noise
- domain warping
- splat generation
- classification
- climate
- scatter
- copies
- mip generation

Whitewater adds:

- advection
- height update
- momentum update
- multiple simulation substeps

Future erosion adds additional compute.

Therefore the engine needs a shared notion of GPU workload pressure.

Conceptually:

```text
GPU WORK BUDGET
│
├── terrain generation
├── terrain refinement
├── water simulation
├── erosion
├── tile copies
└── other GPU work
```

The scheduler should avoid a situation where:

```text
rapid camera movement
    +
many terrain generations
    +
water simulation
    +
erosion
    =
GPU saturation
```

The exact scheduler implementation can evolve later.

The architectural requirement should be established now.

---

# 9. Three Different Types of Erosion

Do not conflate these.

> **Correction (verified against the local Whitewater checkout,
> `js/river.js` and `js/landslides.js`):** the original draft of this
> section classified Whitewater's thermal erosion as part of the coupled
> simulation model. That's wrong. `thermalErode()` (`js/river.js:4`) is a
> plain CPU-side talus-angle relaxation function, and its **only call
> site** is `js/river.js:271`, inside `generateRiver()` — run **once**,
> over the full bed array, while the bed heightfield is first constructed,
> before the water simulation starts. It never runs again after that; it
> is not part of the per-frame/per-substep simulation loop (`sim.js`'s
> `encodeSubstep`/`encodeWaterSim`). It is a procedural terrain-shaping
> pass, full stop — grouped incorrectly below in the original draft, fixed
> here.

## 9.1 Procedural erosion

Runevision-style erosion/filtering used during terrain generation. Also
where Whitewater's own thermal erosion actually belongs (see correction
above): a one-time, CPU-side, talus-angle relaxation pass applied to the
static bed heightfield at construction time.

Purpose:

- improve terrain appearance
- replace some artificial high-frequency noise
- create more natural drainage/mountain forms
- (Whitewater's variant specifically) relax the bed to a stable
  angle-of-repose so slopes don't look artificially cliff-like

This is primarily a **terrain-generation technique**, and — unlike the
other two categories below — it needs no live simulation state at all.
That makes it a candidate that could be prototyped independently and much
earlier than Phase 7/11 if it turns out to be cheap and looks good: it's
a self-contained, few-line CPU pass, not something requiring the coupled
terrain-water architecture to exist first.

## 9.2 Event-driven terrain modification from simulation

This replaces "thermal erosion" as originally listed here — the thing
Whitewater actually does *live*, coupled to its simulation, is narrower
and different in kind. `carveBoulderIntoBed()` (`js/landslides.js:176`)
raises the bed heightfield under a landslide boulder once it settles,
called reactively when a scripted boulder-replay finishes
(`js/landslides.js:146`), and also writes a one-shot splash directly into
the live water-state buffer on impact (`injectSplash()`,
`js/landslides.js:152`, called from `js/landslides.js:132`).

Purpose:

- let a scripted terrain event (a falling boulder) permanently deform the
  bed and disturb the water state at the moment it happens

This is event-triggered and one-shot per event, not a continuous
flow-driven process — it belongs to the coupled simulation model (it does
need live water/terrain buffers to write into), but it is *not* general
hydraulic erosion. Don't over-generalize this single mechanism into "the
simulation does hydraulic erosion" — see 9.3.

## 9.3 Hydraulic erosion

Continuous, flow-driven sediment transport/deposition/erosion, modifying
terrain based on ongoing water velocity and depth.

**This does not currently exist in Whitewater.** Searching its full
source (`js/*.js`) for sediment/deposition/flow-driven-erosion logic
beyond the two mechanisms above found nothing — Whitewater has no
continuous sediment-transport model to port. If SphereCraft wants this,
it is genuinely new design and implementation work, not an integration
of an existing Whitewater capability. Treat it as such when scoping
Phase 11.2 of the implementation plan — it's a bigger and more open-ended
task than "bring in Whitewater's hydraulic erosion."

This is dynamic and stateful, and — if built — belongs to the coupled
terrain-water simulation.

These three mechanisms should not accidentally be stacked on every terrain sample.

The architecture should explicitly decide where each mechanism applies.

---

# 10. What We Should NOT Do

Do not:

- rewrite the entire terrain noise stack
- increase generation concurrency blindly
- increase tile pool size as the primary fix
- increase texture resolution everywhere
- generate all terrain outputs for every tile
- make every tile wait for all refinement
- treat Whitewater as a standalone `elevation -> hydrology` subsystem
- simulate water for the entire planet
- assume every terrain tile needs a water simulation
- add Runevision erosion before the streaming/generation system is stable
- duplicate thermal/hydraulic erosion with procedural erosion
- couple water state directly into every terrain-generation shader
- block rendering while waiting for optional GPU work

---

# 11. Desired End State

The desired system is:

```text
Camera
   |
   v
LOD / visibility
   |
   v
Streaming scheduler
   |
   +----------------------+
   |                      |
   v                      v
Terrain generation    Prediction
   |
   v
Geometry residency
   |
   v
Optional refinement
   |
   +----------------------+
                          |
                          v
                 Coupled simulation
                          |
                 +--------+--------+
                 |                 |
              terrain           water
                 |                 |
                 +--------+--------+
                          |
                       erosion
```

The engine should remain responsive even when terrain generation, refinement, and water simulation are competing for GPU time.

The core principle is:

> Generate only what is needed, when it is needed, at the quality that is appropriate for the current camera/simulation state.
