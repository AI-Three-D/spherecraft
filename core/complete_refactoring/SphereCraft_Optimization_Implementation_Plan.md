# SphereCraft — Terrain Streaming & Generation Optimization Plan

## Goal

Improve rapid-camera-movement performance without sacrificing the existing terrain appearance.

Current behavior:

- good steady-state performance
- significant frame-time degradation during rapid movement
- large numbers of tile requests during traversal
- expensive GPU terrain generation
- optional refinement work
- GPU fences and copy work

The optimization strategy is:

```text
instrument
    ↓
control admission
    ↓
geometry-first residency
    ↓
deferred refinement
    ↓
adaptive quality
    ↓
adaptive resolution
    ↓
predictive streaming
    ↓
surgical shader optimization
    ↓
Whitewater integration design
    ↓
coupled simulation
    ↓
erosion
```

Do not skip directly to terrain-noise rewriting.

---

# Phase 0 — Instrumentation

## Objective

Determine exactly what causes frame-time spikes during rapid movement.

Do not label the problem "noise cost" until measurements support that conclusion.

## 0.1 Instrument Every Tile

Every generation request should carry:

```text
tileId
face
level
x
y

requestReason
priority

distanceToCamera
velocityAlignment

generationTier
outputMask
resolution

requestTime
queueTime
generationStart
computeSubmitted
gpuFenceComplete
copyStart
copyComplete
residentTime
```

Possible request reasons:

```text
VISIBLE
IMMINENT_VISIBLE
PREDICTIVE
REFINEMENT
FEEDBACK
SIMULATION
```

## 0.2 Measure Request Amplification

Track:

```text
requestedTiles / newlyVisibleTiles
```

Also track:

```text
wastedGenerations
```

A wasted generation is a tile that finished generation after it was no longer needed.

## 0.3 Measure GPU Pressure

Track:

```text
gpuFencesInFlight
maxGpuFencesObserved

generationQueueDepth
refinementQueueDepth

pendingCopyCount
copiesPerFrame

tilesStartedPerFrame
computeSubmissionsPerFrame

tilePoolUsed
tilePoolCapacity
tilePoolFree
```

## 0.4 Measure Latency

Calculate:

```text
request → generation start
generation start → compute submission
compute submission → GPU completion
GPU completion → copy complete
copy complete → resident
request → resident
```

Report:

```text
p50
p95
p99
```

## 0.5 Test Matrix

Run the same tests after each major optimization.

### Test A — stationary

Camera stationary.

### Test B — slow movement

Normal exploration speed.

### Test C — fast movement

Maximum normal travel speed.

### Test D — reverse direction

Move rapidly forward, then immediately reverse.

### Test E — 90-degree turn

Move rapidly, then rotate 90 degrees.

### Test F — stop

Move rapidly, then stop immediately.

The reverse/turn/stop tests are particularly useful for detecting wasted predictive generation.

---

# Phase 1 — Generation Admission Control

## Objective

Prevent bursts of work from entering the GPU faster than the GPU can consume them.

This should happen before simply increasing concurrency.

## 1.1 Add Hard Per-Frame Budgets

Introduce explicit budgets such as:

```text
maxNewTilesPerFrame
maxRefinementsPerFrame
maxComputeSubmissionsPerFrame
maxCopyOperationsPerFrame
maxCpuGenerationTimeMs
maxGpuFencesInFlight
```

Initial values should be measured/tuned rather than guessed.

## 1.2 Priority Ordering

Use:

```text
1. visible geometry
2. imminent visible geometry
3. visible refinement
4. forward predictive geometry
5. behind-camera predictive geometry
6. speculative refinement
```

Predictive work must never starve visible geometry.

## 1.3 Admission Control

When the system is under GPU pressure:

```text
visible geometry
    continues

optional refinement
    slows/stops

predictive work
    slows/stops

speculative work
    stops
```

Do not block rendering.

Use ancestor fallback instead.

## 1.4 GPU Backpressure

Use GPU fence completion as a pressure signal.

Do not synchronously wait for the GPU.

Conceptually:

```text
if gpuPressureHigh:
    reduce new work
else:
    allow normal admission
```

---

# Phase 2 — Geometry-First Residency

## Objective

Make terrain useful before optional material/refinement work completes.

## 2.1 Explicit Output Masks

Define:

```text
HEIGHT
NORMAL
CLASSIFICATION
SPLAT
CLIMATE
SCATTER
COLOR
```

Use output masks rather than hard-coded generation types.

## 2.2 Generation Presets

Initial presets:

```text
EMERGENCY:
    HEIGHT

GEOMETRY:
    HEIGHT
    NORMAL
    CLASSIFICATION

MATERIAL:
    HEIGHT
    NORMAL
    CLASSIFICATION
    SPLAT

FULL:
    HEIGHT
    NORMAL
    CLASSIFICATION
    SPLAT
    CLIMATE
    SCATTER
    COLOR
```

These are starting points, not immutable requirements.

## 2.3 Tile State Machine

Implement:

```text
REQUESTED
    ↓
QUEUED
    ↓
GENERATING
    ↓
GEOMETRY_READY
    ↓
RESIDENT
    ↓
REFINING
    ↓
REFINED
```

A tile should become usable once the minimum geometry requirements are satisfied.

## 2.4 Ancestor Fallback

While a child tile is:

```text
GENERATING
REFINING
```

render its ancestor where necessary.

The visual requirement is:

> Rapid movement may temporarily show lower-detail ancestors, but should not produce missing terrain or major frame stalls.

---

# Phase 3 — Deferred Refinement

## Objective

Prevent optional outputs from competing with urgent geometry.

After geometry becomes resident:

```text
background refinement
```

can produce:

```text
NORMAL
SPLAT
CLIMATE
SCATTER
COLOR
```

depending on distance/LOD.

## Refinement Cancellation

If a tile becomes irrelevant before refinement begins:

```text
cancel/deprioritize refinement
```

If refinement is already submitted to the GPU, allow it to complete but do not allow more refinement work for irrelevant tiles.

This is particularly important during:

- rapid movement
- camera reversal
- large turns

---

# Phase 4 — Velocity-Dependent Quality

## Objective

Change generation policy based on camera motion.

The terrain does not need the same generation quality while moving at maximum speed as it does while stationary.

## Suggested Policy

### Stationary

```text
Full refinement
Normal resolution
Aggressive material refinement
```

### Slow movement

```text
Normal generation
Normal refinement
```

### Fast movement

```text
Geometry-first
Reduced refinement
Prioritize forward visible tiles
```

### Very fast movement

```text
Emergency/geometry generation
Minimal optional refinement
Strong ancestor fallback
```

Velocity-dependent quality should be implemented at the scheduling/output-mask level before changing terrain algorithms.

---

# Phase 5 — Adaptive Texture Resolution

## Objective

Reduce the number of processed texels where high resolution is unnecessary.

Remember:

```text
1024 × 1024 = 1,048,576 texels

128 × 128 = 16,384 texels
```

That is a 64× difference in texel count.

Resolution therefore needs to be measured carefully.

## Do Not Change Everything At Once

Benchmark resolution separately for:

```text
height
normal
splat
climate
scatter
color
```

And by LOD.

Example policy:

```text
far:
    low resolution

mid:
    medium resolution

near:
    high resolution
```

Do not reduce near-camera quality without visual testing.

---

# Phase 6 — Predictive Streaming Corridor

## Objective

Predict where the camera will move rather than treating the future as isotropic.

The prediction region should be velocity-aligned.

Conceptually:

```text
             forward
                ↑
              █████
            █████████
          █████████████
        camera
```

Weight:

```text
ahead > sides > behind
```

## Important

Prediction is opportunistic.

If visible work exceeds the budget:

```text
prediction stops
```

Do not let prediction starve actual visible terrain.

## Cancellation

When velocity changes:

```text
old prediction becomes lower priority
new prediction gets priority
```

---

# Phase 7 — Surgical Terrain Shader Optimization

Only after the scheduler and generation system are under control.

Do NOT replace the existing terrain stack.

## 7.1 Profile Existing Noise Layers

Measure individual terrain components.

For each layer record:

```text
cost
visual contribution
LOD usage
frequency
```

Classify as:

```text
KEEP
REDUCE
LOD-GATE
CACHE
REMOVE
```

## 7.2 Investigate Expensive Domain Warping

Pay particular attention to:

```text
warpMultiscale3D()
```

because it contains multiple FBM calls and can become expensive when evaluated:

```text
per texel
× per tile
× per pass
× many streamed tiles
```

Do not optimize it blindly.

First establish whether it is actually a significant contributor.

## 7.3 Reuse Existing Intermediate Data

The existing terrain implementation already demonstrates this pattern.

For example:

```text
heightBase
    R = height
    G = stable slope
```

Later passes can reuse the cached slope rather than recomputing finite-difference terrain information.

Look for additional opportunities of the same kind.

## 7.4 Preserve Visual Baseline

The original terrain stack is the visual reference.

Every shader optimization should be evaluated against it.

No large terrain-function rewrite should be accepted merely because it is faster.

---

# Phase 8 — Whitewater Integration Design

This phase should NOT attempt full planetary water simulation yet.

The purpose is to design the correct coupling.

## 8.1 Treat Whitewater as a Reference Implementation

Whitewater provides useful technology and architectural ideas for:

- water-state representation
- GPU simulation
- advection
- water height
- momentum
- terrain interaction
- thermal erosion
- river/channel geometry
- simulation windows

But it was not designed as a drop-in planetary subsystem.

Do not simply copy the entire Whitewater world model into SphereCraft.

## 8.2 Identify Reusable Whitewater Components

Separate Whitewater into conceptual pieces:

```text
REUSABLE SOLVER LOGIC
    advect
    height
    momentum
    water state
    thermal erosion (talus relaxation)

COUPLING LOGIC
    terrain interaction
    channel interaction
    event-driven terrain modification
        (e.g. landslide-boulder bed carving + splash injection)

WORLD-SPECIFIC LOGIC
    river construction
    Cartesian terrain setup
    fixed simulation domain
```

> **Correction:** thermal erosion was originally listed under COUPLING
> LOGIC. Verified against the local Whitewater checkout
> (`js/river.js:4`, single call site `js/river.js:271`): it's a one-time,
> CPU-side, talus-angle relaxation pass over the static bed array, run
> once at bed-construction time, with no dependency on live simulation
> state. It needs *no coupling at all* to reuse — it belongs with
> REUSABLE SOLVER LOGIC (or could even be prototyped as a standalone
> procedural-terrain technique independent of this whole plan; see
> `SphereCraft_Architecture_Direction.md` §9.1). The actual live,
> simulation-coupled terrain modification in Whitewater is narrower:
> scripted landslide boulders that carve the bed and inject a splash on
> impact (`js/landslides.js`), not general hydraulic erosion — see §9.2-9.3
> of the Architecture Direction doc. Whitewater has no continuous,
> flow-driven sediment-transport/erosion model; do not assume Phase 11.2
> below can "integrate Whitewater's hydraulic erosion" — that capability
> doesn't exist there to integrate.

The first two categories are potentially reusable.

The third category must be adapted to SphereCraft.

## 8.3 Define a Simulation Patch

SphereCraft should not simulate the whole planet.

Define a local simulation patch/window:

```text
Planetary coordinates
        ↓
Local tangent / simulation coordinates
        ↓
Simulation grid
```

The patch should contain:

```text
terrain elevation
water depth
velocity / momentum
sediment
simulation parameters
```

Additional state can be added later.

## 8.4 Terrain Interface

Define a clear interface between terrain generation and simulation.

Conceptually:

```text
Terrain
    |
    | elevation / slope / classification
    v
Simulation Patch
    |
    +--> water
    +--> momentum
    +--> sediment
    +--> erosion
```

But the interface must support persistent simulation state.

The simulation must not recreate water from scratch every frame from procedural terrain.

## 8.5 Persistent Water State

Water state should eventually persist independently of terrain generation.

Example:

```text
waterPatchId
terrainVersion
waterState
simulationTime
lastUpdated
boundaryState
```

If the player leaves an area:

```text
simulation pauses
state persists
```

When returning:

```text
state resumes
```

## 8.6 Simulation Boundary Conditions

A planetary simulation patch needs explicit boundary handling.

Possible approaches include:

```text
neighbor patch
ancestor patch
downsampled neighbor state
open boundary
closed boundary
inflow/outflow boundary
```

Do not leave this implicit.

## 8.7 LOD Relationship

Water simulation resolution does not necessarily need to equal terrain rendering resolution.

Define separately:

```text
terrain LOD
simulation resolution
water visual resolution
```

The exact relationship should be experimentally determined.

## 8.8 Shared GPU Budget

Whitewater simulation must participate in the same GPU workload budget as terrain.

Conceptually:

```text
GPU Scheduler
│
├── urgent terrain geometry
├── terrain refinement
├── water simulation
├── erosion
└── copies
```

During rapid camera movement:

```text
terrain geometry priority increases
water simulation may reduce substeps
optional refinement decreases
```

When stationary:

```text
terrain refinement increases
water simulation can run normally
```

---

# Phase 9 — Coupled Terrain + Water Prototype

Build the smallest useful integration.

Do NOT begin with:

```text
entire planet
multiple LODs
global rivers
persistent ocean
full erosion
```

Start with:

```text
one SphereCraft terrain region
+
one Whitewater-style simulation patch
+
shared terrain elevation
+
persistent water state
```

## Prototype Requirements

The prototype should demonstrate:

1. SphereCraft generates terrain.
2. Simulation patch obtains the same terrain elevation.
3. Water simulation runs on the patch.
4. Water interacts with terrain.
5. Water state persists.
6. Terrain and water use the same coordinate mapping.
7. GPU scheduling remains responsive.

Only after this works should the system expand.

---

# Phase 10 — Hydrology Scaling

After the single-patch prototype works:

```text
one patch
    ↓
multiple neighboring patches
    ↓
moving simulation window
    ↓
streamed simulation state
    ↓
terrain LOD transitions
    ↓
persistent planetary water regions
```

Important problems to solve:

- patch boundaries
- water conservation
- state persistence
- neighboring patches
- LOD transitions
- simulation-window movement
- GPU scheduling
- terrain updates
- erosion feedback

---

# Phase 11 — Erosion

Only after the coupled terrain/water architecture is working.

## 11.1 Procedural Terrain Erosion

Runevision-style erosion/filtering can improve generated terrain. This is
also where Whitewater's own thermal-erosion technique (talus-angle
relaxation, `js/river.js` — see the correction in §8.2 above) actually
fits: it's a one-time procedural pass with no simulation dependency, and a
candidate worth prototyping independently, possibly well before this
phase, since it doesn't need the coupled architecture to exist first.

Its role:

```text
procedural terrain generation
```

It should replace selected high-frequency terrain noise where it produces a better visual result at acceptable cost.

It should NOT simply be stacked on top of every existing detail layer.

## 11.2 Dynamic Hydraulic Erosion

**Correction:** this is not "Whitewater-style hydraulic erosion" in the
sense of an existing capability to port — verified against the local
Whitewater checkout, it has no continuous, flow-driven sediment-transport
model at all. What it has is narrower: scripted landslide boulders that
carve the bed and inject a splash on impact
(`carveBoulderIntoBed()`/`injectSplash()` in `js/landslides.js`) — a
one-shot event, not ongoing erosion driven by live flow. That mechanism is
a useful reference for *event-driven* terrain modification (§8.2's
"COUPLING LOGIC"), but general hydraulic erosion as described below is new
design and implementation work for SphereCraft, not integration of
something Whitewater already does. Scope and estimate it accordingly —
it's a bigger, more open-ended task than the rest of this phase implies.

Conceptually:

```text
water
  ↓
flow
  ↓
sediment transport
  ↓
erosion/deposition
  ↓
terrain modification
  ↓
updated water flow
```

This is stateful.

It should not be confused with procedural erosion.

---

# Phase 12 — Final Optimization Loop

After every major phase:

```text
run benchmark
compare against baseline
inspect visual quality
inspect p95/p99 frame time
inspect GPU pressure
inspect residency behavior
```

Track at minimum:

```text
FPS
frame time
p95 frame time
p99 frame time

visible tiles
resident tiles
ancestor fallback count

generation queue depth
refinement queue depth

tiles started/frame
tiles completed/frame

GPU fences in flight
GPU fence peak

copy operations/frame

request amplification
wasted generation

generation latency p50
generation latency p95
generation latency p99
```

---

# Acceptance Criteria

The optimization effort is successful if rapid movement can produce:

```text
temporary lower-detail terrain
```

instead of:

```text
major frame-time spikes
GPU saturation
large generation bursts
excessive refinement backlog
```

The visual fallback should be:

```text
lower detail
```

not:

```text
stalled rendering
```

---

# Final Development Order

Implement in this exact order unless profiling provides evidence for a change:

```text
PHASE 0
Instrumentation

PHASE 1
Generation admission control

PHASE 2
Geometry-first residency

PHASE 3
Deferred refinement

PHASE 4
Velocity-dependent generation quality

PHASE 5
Adaptive texture resolution

PHASE 6
Velocity-aligned predictive streaming

PHASE 7
Surgical terrain shader optimization

PHASE 8
Whitewater integration design

PHASE 9
Single coupled terrain/water prototype

PHASE 10
Multi-patch / planetary hydrology scaling

PHASE 11
Procedural + dynamic erosion integration
```

Do not implement later phases prematurely.

In particular:

```text
Do not rewrite terrain noise before Phase 7.
Do not integrate full Whitewater before Phase 8.
Do not add hydraulic erosion before the coupled simulation architecture exists.
Do not add Runevision erosion before the existing generation/streaming system is measured and stable.
```

---

# Core Principle

The engine should evolve toward:

> **A demand-driven planetary environment system where terrain, water, and erosion are coupled where physically necessary, but where expensive GPU work is admitted according to visibility, camera velocity, simulation importance, and available GPU budget.**

The goal is not to make every operation cheap.

The goal is to make sure the engine only performs expensive operations when they are actually necessary.
