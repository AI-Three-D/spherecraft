# Water plan v2: rivers that hold their water (2026-10-05)

Written after the owner's browser check of `33915bf` (carved rivers + square simulation site). Status of each phase is at the end; update it as work lands. Local file, not committed (like `IMPLEMENTATION_PLAN*.md`).

## What the owner saw, and the targets

Defects in `33915bf` (screenshots 2026-10-05):
1. Water flows sideways toward a river edge, and spills out over the land in sheets, which show up white with foam.
2. The carved edges look unnatural; Whitewater's smooth brown banks are the reference.
3. The simulation starts only very close to the camera and drops out again just as easily (foam, then still water, then foam).
4. A hard cut a few hundred metres away: simulated water next to still static water. Water spills out of the small simulated square.
5. Water takes 1–3 s to refine; hard water edges show meanwhile.
6. Rivers are too narrow: at least 3× wider.

Owner's targets:
- At least Whitewater's look: the close-up and the higher view screenshots.
- At least 90 fps on the owner's MacBook with that look (terrain alone is 60–90 fps now; Whitewater runs 110+). Rendering optimisation is a separate task; the water itself must cost little.
- Static water only very far away; animated water (no simulation) at medium distance.
- Owner, 2026-10-05: "even whitewater would have had that same spilling without proper river carving … water flows where it has a route". Confining the water is a terrain job.

## Why it failed (from the code and lab numbers)

- **The channel does not confine.**
  - 0.6 m deep, about 0.5 m of bank above the water, and banks only where the ground was higher anyway.
  - Where the ground beside the river is lower than the water there is no bank: 37 % of the traced length ("pools").
- **The site feeds water outside the channel.**
  - Its start state and its 12 m border band take the static river's water. That includes the "spread" beside the channel: the level falls 0.15 m per metre, so on low ground the static river draws water over land.
  - Those cells also get the river's along-stream velocity, so at bends water is pushed straight out of the channel.
  - The band keeps injecting water, which floods the land inside the square.
- **The static river and the simulation disagree.** Depth and speed come from Manning's equation on an assumed shape. Forcing both ends of the site to those values makes a source/sink pair.
- **The site restarts every 64 m of camera travel** (re-sample, 0.5 s warm-up, 1 s fade), and switches off at 400 m altitude with no hysteresis.
- **Outside the 256 m square there is only flat static water.**

## What Whitewater does (js/river.js, sim.js, render.js, config/)

- **The terrain is built from the river.** Across the channel, u = d / hw:
  - Bed T + D (1 − (1 − u²)^1.5), with the thalweg pushed toward the outer bank of bends.
  - Water at T + 0.75 D.
  - Outside the channel: bank 1.8 (1 − e^(−m/2.5)) + 0.06 m, then valley hills vH (1 − e^(−m/vS)).
  - Relief noise faded in from the bank outward, and thermal erosion outside the channel.
  - Every cross-section rises on both sides, so water cannot leave.
  - Meadow Run: 24 m wide, 1.6 m bank-full, valley 12 m.
- **Inflow:** Q from Manning's equation on the real cross-section of a reference row; inflow velocity Q / Σ h^(5/3) × h^(2/3) per column.
- **The grid covers the whole course** (128 × 512 m at 0.5 m) and is pre-warmed for 900 steps at load. Each frame only rows 60 m behind to 220 m ahead of the boat are stepped; the rest stays plausible frozen water.
- **The view ends at 170 m in fog,** so everything visible is simulation data.
- **Mesh detail:** full / half / quarter resolution at 80 / 140 m.

SphereCraft sees kilometres, so beyond the simulated stretch it needs animated water that looks like the simulation.

## Plan

### W1: river corridor terrain, Whitewater's cross-section, carved in the height function

**Width and depth (riverShape):**
- Width 3× wider: min 30 m, 12 × Q^0.5.
- Bank-full depth D: min 1.4 m, 0.6 × Q^0.4.
- Water at waterFrac 0.75 of D.
- All config (`terrain.waterGraph.rivers.shape`).

**Level and incision (worker):**
- The bank crest sits at the natural terrain, so the river is cut into the ground, not set on a berm.
- eta = min(src, max(dest, fill − ramp × incision)), with incision = (1 − waterFrac) D + bankH, ramped in from the source.
- Thalweg T = eta − waterFrac × D.
- The level never rises downstream (owner's rule); the bed may.

**Cross-section** (d = distance from the centre line, signed for the bend skew; x = d − hw):
- Channel: T + D (1 − (1 − u²)^1.5), with u skewed toward the outer bank of bends.
- Bank: T + D + (bankH (1 − e^(−x/bankSoft)) + 0.06 x) × smoothstep(0, bankSoft, x). Slope 0 at the edge, so no crease.
- Zone A (x < bankW): the terrain is the profile. Cut where higher, fill (levee) where lower, except in pools.
- Zone B (bankW … bankW + blendW): cut and fill fade out to the natural terrain.
- Smooth min + smooth max with weights, so zone A equals the profile exactly.
- A wall at the reach edge keeps neighbouring segments continuous.
- Several segments: the lowest profile; weights are the maximum.

**Pools** (closed hollows the river crosses):
- The worker floods from the river line over corridor cells below the water level and records a pool reach per point.
- Inside pools there is no levee, and water is drawn flat at the river level out to the pool reach, so the shore follows the terrain contour.
- The 0.15 m/m "spread" water is removed.

**Centre line:** smoothing window scales with width (bends of radius ≥ about 2–3 half-widths).

**Data:**
- River segment 80 B: p0, eta0, p1, eta1, hw0, hw1, bed0, bed1, pool0, pool1, skew0, skew1, speed0, speed1, foam0, foam1.
- Params get a second carve vec4.
- Segment lists reach max(hw + bankW + blendW, pool reach).

**Shading:**
- Brown wet bank colour between the waterline and the bank crest.
- No micro detail in zone A.

**Lab check:**
- Cross-sections along every traced river: crest ≥ water + 1 m on both sides outside pools and lakes.
- Water drawn only in channel and pools.
- Cost per tile; pictures.

### W2: simulation along the river, scrolling, never restarting (replaces the square site)

**Strip grid:**
- Columns across the river: channel plus banks, 1 m (2 m for very wide rivers).
- Rows along the centre line: a window of about 1 km of river around the camera's projection onto the nearest river.
- Cell (i, j) sits at C(s_j) + n_i N(s_j) on the sphere. The solver runs on the straightened strip, the same kernels as now, with no curvature terms.

**Scrolling:**
- Rows form a ring buffer (row offset, like Whitewater's jOffset).
- Rows entering the window get their bed sampled from the carved height function (one GPU pass, about 100 samples per row) and a steady flow: level from the river, velocity along the channel faster mid-stream.
- No warm-up, and no restarts while the camera moves.

**Boundaries:**
- Banks are walls (closed sides).
- Inflow at the upstream end: Manning's equation on the real cross-section (Whitewater's method).
- Free outflow downstream.
- Pools and lakes beyond the strip edge stay static flat water at the same level.

**Activation:**
- The nearest river within about 1.5 km, with hysteresis.
- Switching rivers fades one strip out over the medium tier and the other in.

**Rendering:**
- Strip mesh with full / half / quarter detail by distance.
- Whitewater's look (already ported in WaterSimRenderer).
- The ends fade into the medium tier.

**Budget:** about 100k cells × 2 substeps ≤ 0.7 ms. Today: 65k cells, 0.21 ms per substep.

**Lab check:**
- Volume in = out; no wet cells outside channel and pools.
- Scrolling 2 km along a river without restarts.
- Cost.

### W3: medium distance, animated water without simulation (terrain shading)

- Rivers out to about 2–3 km: ripples and foam carried by the flow, in Whitewater's colours.
- Flow speed per segment; foam from steepness, bends and narrowing (foam0/foam1). The simulation surface uses the same pattern, so the hand-over doesn't show.
- Further out: plain colour plus sky reflection.
- Lakes: slow wind ripples near, plain far.

### W4: no visible refinement delay

1. Measure first. `qtDiag.water.pending()`: lakes, rivers and tiles waiting, and the simulation state with timestamps. This shows which of these the owner saw:
   - lake shoreline solve,
   - river trace,
   - tile re-carve,
   - simulation start.
2. Fix:
   - Trace and solve eagerly around the camera and in the direction of travel, not only lazily.
   - Re-carved tiles near the camera get their own GPU reserve.
   - No hard-edged placeholder water near the camera.

### Performance budget (owner: 90 fps with the look)

All water ≤ ~1.5 ms GPU per frame on the owner's MacBook:
- Strip simulation ≤ 0.7 ms.
- Strip mesh draw ~0.2 ms.
- Medium tier: only pixels in river cells pay.
- Carve: measured +3.5 % per tile generated, +5 % on river tiles.

## Status

| Phase | State |
|---|---|
| W1 corridor terrain + 3× width + hollows | done `4c87c7a` (2026-10-05). Hollows along rivers are filled to a floodplain instead of drawn as pools (they covered most of the length on this terrain); river level = monotone least-squares fit of the ground, pinned to lakes it crosses; per-segment shapes blended by distance. Lab: 0 escapes on 7 of 8 rivers (1.2 % overall, beside a giant lake); crest ≥ 2 m above water in 95 % of sections. Cost +10 % on river tiles, +6 % elsewhere (two shader variants would remove the latter). Known: giant lakes' coarse regions leave lake-level hollows outside them. |
| W2 river-following scrolling simulation | done `4df8cbf` (2026-10-05). Strip 56 x 768 cells at 1 m, 0.31 ms/frame; scrolls in 64 m steps through a row ring (no restarts); banks closed, inflow upstream, open outflow; static water fades along the strip's river stretch. Lab: no spill on a calm river, 0.25 % on a steep one (rapid with white water). Not yet in a browser. |
| W3 medium-distance animated water | in progress |
| W4 refinement latency | planned |
