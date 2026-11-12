# Terrain seam cracks: findings and fix (2026-11-10)

Owner's report (2026-11-09): a thin crack across a river bank, black over land
and blue over the water, plus faint light dashes along other lines in the
distance.

**Status: fixed** on branch `fix-terrain-seam-cracks`: LOD seam stitching from
the coarser neighbour's own height layer (see Fix). At the repro pose the
crack and the dashes are gone, with no pinholes left.

## Reproduce

Headless, `?lakeCells=1` (server: `python3 server.py`, from spherecraft/):

    node tools/perf/lakeCells/poseShots.mjs OUT "-131764.0,-5131.3,-2650.7" "-131657.0,-5437.2,-2737.2" "-0.9991,-0.0376,-0.0206"

`OUT-lod90.png` is the tile LOD view (terrain debug 90). Terms can be switched
off before the shot with a console line:

    LAKE_SHOTS_EVAL="qtDiag.setTerrainFeatures({ waterCarve: false, microDetail: false })" node tools/perf/lakeCells/poseShots.mjs ...

(The rivers near this pose moved after the lake changes of 2026-11-10; the
crack is still there without them. The script waits 240 s for a river field
that never bakes at this pose; the shots are still valid.)

## What it was

- A see-through gap on the tile boundary between two geometry LODs (exactly
  the yellow/orange boundary in the LOD view). Through it you see the
  background (black or sky) on land, or the near water mesh where a river
  lies behind.
- Not the rivers (`waterCarve: false`), not the lakes (`lakeBasins: false`).
  Micro detail makes it large: with `microDetail: false` only the dashes
  remain.

## Mechanism (confirmed)

- Every tile has 128 height texels spanning it edge to edge (texel k at local
  UV k / 127, advancedTerrainCompute.wgsl.js), and every LOD's geometry has
  128 segments per edge (transition topology, terrainGeometryBuilder.js).
  Vertex heights are bilinear in the tile's own texels
  (sampleHeightChunkLocal).
- A neighbour one depth coarser covers twice the length with the same 128
  texels, so the two tiles interpolate the shared edge from different texel
  grids. Micro detail (up to 6-10 m times gain, bumps of a few metres)
  between texels makes the two edges differ by metres.
- **The finer tile cannot rebuild the coarse edge from its own texels.**
  Only every other fine texel lies on a coarse texel position, and the
  coarse vertex at the fine tile's far corner (coarse texel coordinate 63.5)
  needs a coarse texel that lies in the sibling tile. This is why the three
  stitches tried earlier changed nothing.
- The edges also had T-junctions: the finer tile has two edge vertices per
  coarse segment.

## Tried and reverted earlier (and why they could not work)

1. Old vertex stitch path (`computeEdgeSnappedUV`, `sampleStitchedHeight`):
   only runs with transition topology off.
2. Transition topology off: the crack got bigger, on the same line.
3. Stitch for transition topology using the tile's own texels: the shared
   vertices already differ (see Mechanism).

## Fix

- **Instance builder** (instanceBufferBuilder.wgsl.js `edgeStitchFor`): for
  each edge of each drawn tile it decides who follows whom:
  - The finer tile follows a neighbour drawn coarser.
  - At equal depth, the tile with finer height data follows the other. This
    covers tiles drawn from an ancestor layer while their own streams in;
    with equal data depth from different layers, the higher layer follows.
  - It writes one record per instance, two `vec4<u32>`: the neighbour's
    geometry layer, levels up, data levels, face, and tile x/y. The buffer is
    `QT-EdgeStitch` (binding 9), at the same index as the instance buffer. It
    is only created when `maxStorageBuffersPerShaderStage >= 9`; otherwise a
    warning is logged and stitching is off.
- **Terrain vertex shader** (terrainChunkVertexShaderBuilder.js; record at
  bind group 3, binding 21; a zeroed dummy means no stitching):
  - A vertex on a stitched edge is computed exactly as the neighbour computes
    its own vertex there: the neighbour's layer, UV transform and
    arithmetic, sampled from the same height texture array. Shared vertices
    come out bit-identical.
  - Across a cube face, the UV is mapped exactly through the cube point
    (`cubePointToFaceUV`).
  - T-junction vertices (between two neighbour vertices) become copies of
    this tile's vertex at the neighbour vertex before them (same UV, so the
    same position, height and material). Their triangles collapse to zero
    area (`snapToStitchedVertex`).
  - A corner on two stitched edges follows the coarser neighbour.

## Verified (headless, repro pose)

- Black crack pixels along the seam: 248 before, 1 after. Light (sky)
  pixels: 168 in runs up to 55 px before, 0 after.
- A/B in one session, same tile set:
  - Stitching off brings the original crack back exactly.
  - With T-junction vertices left on the neighbour's edge line instead of
    snapped, 31 single-pixel pinholes remain: the vertex lands a rounding
    error off the line and antialiasing samples fall through.
  - Culling off and a fade of the edge change over 4 rows had no effect, so
    triangle folding is not the cause (the fade was not kept).
- A low-altitude view (`river:0:0.5:60:250`) shows no lines or texture shear
  at the near seams.
- `naga` validates the generated shaders. Lint, `tsc` and the types check
  pass. vitest: 603/604; the one failure is a timeout in
  tools/perf/riverBanks/fieldGroupsPrototype.test.js under parallel load. It
  passes alone, with and without this change.

## Still open

- **Ancestor fallback sampling (transient, while tiles stream; accepted by
  the owner 2026-11-10, not to be fixed):** sampleHeightChunkLocal maps a
  child drawn from its parent's layer to parent texels [0, 63] and [64, 127]
  (`chunkSizeI - 1`). It should map to [0, 63.5] and [63.5, 127]. Two
  siblings drawn from the same ancestor therefore disagree by a texel on
  their shared edge until their own layers arrive. The stitch does not cover
  this: both draw from the same layer, so neither follows the other. Fix, if
  it is ever wanted: `coord = (offset + localUV * scale) * (texSize - 1)` for
  array textures, keeping the stitch's neighbour sampling identical.
- The shadow renderer (GPUCascadedShadowRenderer.js) draws terrain with its
  own instance layout and no stitching. Casters may differ by the old
  mismatch at seams (not visible so far).
- Seam diagnostics in gpuQuadtreeTerrainSeamDiagnostics.js are still
  switched off (`_shouldRunStitchDiag` returns false).
