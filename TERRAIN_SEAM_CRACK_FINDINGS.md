# Terrain seam cracks: findings (2026-11-10, not fixed)

Owner's report (2026-11-09): a thin crack across a river bank, black over land
and blue over the water, plus faint light dashes along other lines in the
distance. Owner: not lake work, record and leave for a later session.

## Reproduce

Headless, `?lakeCells=1` (server: `python3 server.py`, from spherecraft/):

    node tools/perf/lakeCells/poseShots.mjs OUT "-131764.0,-5131.3,-2650.7" "-131657.0,-5437.2,-2737.2" "-0.9991,-0.0376,-0.0206"

`OUT-lod90.png` is the tile LOD view (terrain debug 90). Terms can be switched
off before the shot with a console line:

    LAKE_SHOTS_EVAL="qtDiag.setTerrainFeatures({ waterCarve: false, microDetail: false })" node tools/perf/lakeCells/poseShots.mjs ...

(The rivers near this pose moved after the lake changes of 2026-11-10; the
crack is still there without them.)

## What it is

- A see-through gap on a tile boundary between two geometry LODs (exactly
  the yellow/orange boundary in the LOD view). Through it: the background
  (black or sky) on land, the near water mesh where a river lies behind.
- Not the rivers: with `waterCarve: false` the crack and the dashes remain
  (smaller where the carved bank was).
- Not the lakes: with `lakeBasins: false` it remains.
- **Micro detail**: with `microDetail: false` the crack is gone and only
  faint dotted traces of the dashes remain. This is the term.

## Mechanism (most likely, not fully proven)

- Tiles have 128 height texels spanning the tile edge to edge (texel k at
  local UV k / 127, advancedTerrainCompute.wgsl.js), but their vertices sit
  at k / 128 (128 segments). Every vertex height is a bilinear blend of the
  texels around it (terrainChunkVertexShaderBuilder.js sampleHeightChunkLocal;
  `DEBUG_SAMPLE_FIX` is true, so `remapToTexelGrid` is not the live path).
- A neighbour one depth coarser is twice the size with the same 128 texels:
  its texels are twice as far apart. At the same shared edge point the two
  tiles interpolate the terrain from different texel grids.
- The base terrain is smooth at that scale (centimetres: the faint dashes).
  The per-tile micro detail is not: displacement up to 6 m (grass) and 10 m
  (forest) times the micro noise and gain, with bumps of a few metres. The
  two tiles' edges then differ by much more, which opens the crack.
- Transition topology (`useTransitionTopology: true`,
  QuadtreeTerrainRenderer.js) keeps every LOD's edge at the full 128
  segments, so a coarser neighbour also leaves T-junctions at every second
  vertex (also curvature-sized, so small without micro).

## Tried and reverted (no effect or wrong path)

1. Old vertex stitch path (`computeEdgeSnappedUV`, `sampleStitchedHeight`):
   its step `1 / segments[neighbourLOD]` ignores that the neighbour is twice
   the size (should be `2^dLod / segments`). Corrected it: no change,
   because that path only runs with transition topology off.
2. Transition topology off (A/B): the crack got bigger, on the same line.
3. Stitch for transition topology (odd edge vertices = linear between the
   coarser neighbour's vertices, step `2^dLod / 128`): no change. Expected
   in hindsight: the mismatch is already at the shared vertices (different
   texel grids), not only between them.

## Fix options for later

- **Micro off at LOD seams**: fade the micro height to 0 near edges whose
  neighbour has another LOD, on both sides (the instance's edge mask has
  bits for coarser and finer neighbours: instanceBufferBuilder.wgsl.js
  computeEdgeMask). Needs micro stored apart from the final height: the
  height texture is `r32float`, so a second channel or format change. Or,
  simpler and cruder, fade micro to 0 in the last ~3 texels of every tile at
  generation (outputType 4 in advancedTerrainCompute.wgsl.js), which also
  touches same-LOD seams that are fine today.
- **Skirts**: a strip hanging down from every tile edge hides any gap of any
  cause. Robust; costs triangles (about +3 % on LOD 0, much more on the
  far, coarse tiles).
- **Aligned grids**: vertices on texels (129 texels or 127 segments), so
  shared vertices sample exactly the same points, plus the transition-edge
  stitch. Most correct, most invasive (texture sizes everywhere).

The seam diagnostics in gpuQuadtreeTerrainSeamDiagnostics.js exist but are
switched off (`_shouldRunStitchDiag` returns false).
