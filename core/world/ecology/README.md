# core/world/ecology: the shared ground under trees and ground cover

The reference both the forest (Codex) and the ground layer (Claude) code against. The design and its review are in
`ECOLOGY_FOUNDATION_PLAN.md` at the repository root; this file is what was built and how to use it. Grass uses all of it.

The world is built in layers: geology, then trees, then the ground layer. Each reads only the layers before it.

## Places, hashes, metric (`ecologyLattice.js`, `ecologyLattice.wgsl.js`)

A place is `(face, ix, iy)` on a lattice level: the cube face cut into `2^level` cells along each edge. Faces follow the
terrain's `getCubePoint`: `ECO_FACES[face]`, or `ecoFaceDirection` in WGSL.

**Picking random values:**
- `ecoCellHash(face, ix, iy, layer, worldSeed)` hashes a cell for one layer; `ecoDraw(cellHash, k)` gives its k-th draw.
- Layers: `ECO_LAYERS` = grass 0, trees 1, rocks 2, ground cover 3, deadfall 4, habitat 5, obstacles 6. Use your own layer, so streams never correlate.
- Grass (layer 0, world seed 0) keeps its old `hash3(x, y, face)`.

**Candidate ids and order:**
- `ecoId(face, level, ix, iy, k)` gives a stable 64-bit id (lo, hi).
- `ecoBefore(prioA, idA, prioB, idB)` is the one order everyone uses (higher priority, then the smaller id), for competition, overflow and thinning.

**Thinning with distance:** `latticeLevel` and `latticeRank` rank nested lattice points coarse-first. A layer keeps ranks under its density, so points leave one at a time as the camera moves.

**The sphere's metric:**
- `cellAreaM2` / `ecoCellArea` give a cell's exact area (gnomonic solid angle). A corner cell is about a fifth of a middle one, so scale densities per m² by it.
- `cellAxesM` / `ecoCellAxes` give its edge lengths.
- `latticeFor(spacingM, R)` gives the level for a spacing.

**Across face edges:**
- `neighbourCell` / `ecoNeighbourCell` step across face edges and three-face corners.
- `ecoUvOnFace(face, dir)` gives a direction's (u, v) on a face's plane.
- `cellsWithin(face, level, ix, iy, radiusM, R)` (JS) lists the cells meeting a disc, in canonical order (face, iy, ix).

**Noise:** `ecoNoise3(p, seed)` is 3D value noise over world positions, continuous across faces and at the poles.

A candidate is generated inside its own cell and the faces partition the sphere, so every candidate exists exactly once.

## Standing on the ground (`GroundFrame.js`, `drawnGround.wgsl.js`)

`GroundFrame` is updated once a frame with `update({ camRel, radius, heightScale, quadtree, reach })`. It holds:
- the faces within `reach` of the camera, each with an anchor patch worked out in doubles relative to the camera;
- the loaded and drawn tiles' tables.

Make one per reach. Grass uses 240 m; the forest makes its own. Bind it with `resources(quadtree, heightView)`.

Points are given as patch `p` (whole, on the lattice `GROUND_LEVELS` = 6 below the deepest terrain level: 2 m patches at a 131 km radius) plus `f` within the patch.

`buildDrawnGroundWGSL({ frame, loaded, visible, height })` declares:

| Function | What |
| --- | --- |
| `groundDrawnAt(face, p, f)` | The surface drawn this frame, with a status: `GROUND_DRAWN` (rebuilt from the drawn mesh), `GROUND_LOADED` (beside the view: finest loaded heights), `GROUND_NONE`. Keep the tile and status with what you placed, and place it again when they change; only the height moves. |
| `groundStableAt(face, p, f)` | The generator's heights, whatever the camera sees: for where things grow and for collision. |
| `groundPlace(F, d, h)` | A point `d` patches from face `F`'s anchor at height `h`, camera-relative, good to a tenth of a millimetre at 60 m. |
| `groundTileOver`, `groundDrawnOver`, `groundLookupLayer`, `groundTileKey`, `groundInTile`, `groundHeightAt`, `groundDrawnHeight` | The pieces. |

Never send an absolute position (about 131 km from the centre) to a shader as a float. The terrain's vertex shader did, and the ground jittered up to 8 mm a frame. It is now camera-relative (`terrainPass.wgsl.js`).

## The ecology field (`EcologyField.js`, `ecologyField.wgsl.js`, `ecologyWriter.wgsl.js`)

Per terrain pool layer, behind one accessor (`buildEcologyReadWGSL({ a, b, layers, withPatch })`):

```wgsl
struct EcologySample { status, suitability, standHint, cover, crownLAI, top, stand }
fn ecologyAtLayer(layer: i32, local: vec2<f32>) -> EcologySample       // by pool layer (the terrain pass)
fn ecologyAtPatch(face: u32, p: vec2<u32>, f: vec2<f32>) -> EcologySample // by place (needs drawnGround)
```

**Status:**
- `ECO_READY`.
- `ECO_FALLBACK`: from an ancestor tile, because a finer loaded tile's field is not made yet.
- `ECO_UNKNOWN`: neutral, no forest. A reader never takes a missing field, or another tile's, as an empty forest.

**Habitat** (always made, from climate, slope, elevation, ice, and river and lake beds once the tile's material is made):
- `suitability`: how much forest the place could carry, 0..1.
- `standHint`: the stand the registry's rules prefer here.

**Realized** (empty until a producer writes it):

| Quantity | Meaning |
| --- | --- |
| `cover` | Share of the footprint under crowns |
| `crownLAI` | Leaf area per unit of crown-projected area, inside crowns |
| `top` | Cover-weighted crown tops over the ground (m) |
| `stand` | The stand there, categorical |

A sample describes one texel's footprint at its tile's level.

**Coarse levels:** a producer writes each level from its population, not by filtering finer texels:
- cover: the area average;
- crownLAI: chosen so the transmission at 45° equals the area average of the finer transmission;
- top: cover-weighted;
- stand: the dominant one.

Never filter or mip `stand`, nor mip `crownLAI`. The foundation's habitat writer samples coarse tiles at texel middles.

**Storage (provisional, behind the accessor):**
- `rgba8unorm`: suitability, cover, crownLAI / 8, top / 64 m.
- `r32uint`: stand | standHint << 16.
- 32² a layer, no mips: 16 MiB for 2048 layers.

**Readiness:**
- Each layer's record (`ecologyLayers`) holds: owner tile key, state | version << 2, and the pool's layer version it was made from.
- `TileArrayPool.layerVersions` rises when a copy into a layer is submitted and when the layer is released. The field is made again on that, on a new owner, when the tile's beds arrive, and when the realized source changes.
- `EcologyField.version()` rises whenever anything changes; cache on it.

**For a forest producer (Codex):**
- After `EcologyField.update` in a frame, write `cover`, `crownLAI`, `top` and `stand` into `viewA` / `viewB` for the layers you have made, keeping the format.
- Raise `version()`. A hook to register a producer and replace the realized half of the writer is the first thing to add once the forest exists. Today only the mock forest writes realized values.
- `mockForest = true` makes realized values from habitat and noise. It is for labs and tests (it shows the light path), never on in the game by default.

**Debug views:**
- Set `quadtreeTerrainRenderer.pass.ecologyDebug`: 1 suitability, 2 cover, 3 stand hint, 4 stand, 5 crownLAI, 6 crown tops, 7 status.
- From the console: `gameEngine.renderer.quadtreeTerrainRenderer._ecology`.

## Light under the canopy (`ecologyField.wgsl.js`)

`canopyLight(e, sunUp, heightAboveGround)` gives the land light's (sun, sky) factors under the realized canopy:
- **Sun:** `T = (1 - cover) + cover · exp(-0.5 · crownLAI / sunUp)`. Gaps pass light whole.
- **Sky:** `1 - 0.7 cover`.
- **Raised receivers:** a receiver above the ground leaves the shade by the crown tops (`canopyShare`).

It is applied where the land light is read (the terrain pass per pixel, grass per patch), not inside `TerrainLightMap`. That is finer (4 m against 6 m), needs no change to the light map's rebuild key, and every reader takes the same function.

`nearShadowAt(rel)` returns 1. The forest's near shadows (sun flecks, trunks) go there, as a correction of mean 1 over each broad texel, so the canopy's mean extinction is applied once.

With realized forest empty, nothing changes in the game.

## Wind (`WindField.js`, `wind.wgsl.js`)

- The weather's way and speed, and an offset carried with the wind, summed frame by frame. A turning wind only changes where the gusts go next.
- `windGust(rel)` is 3D noise over world position, continuous across faces and at the poles.
- Grass bends and sways on it. Branch response is the forest's own, on top.

## The ecosystem registry (`ecologyRegistry.js`, `wizard_game/world/ecology.json`)

**Ecosystems:**
- Each matches a landscape cover class (`biomeCover`) within a band of temperature (°C) and humidity.
- It holds stands (tree species by the forest system's ids, canopy ranges), ground types, rocks and deadfall.
- The game's file has boreal, temperate and tropical (the test planet's forests are tropical).

**Stand ids:** FNV-1a of `ecosystem/stand` into 1..65534 (0 open, 65535 unknown), so adding stands never changes the others'.

**Checks and extras:**
- Stand fields beyond `trees` and `canopy` are optional and passed through (`stand.extra`).
- Unknown species (when the forest's list is given), ground types naming missing stands, and bad ranges are errors.
- River and lake beds are folded into `suitability`.

## The obstacle table (`ObstacleCells.js`, `obstacles.wgsl.js`)

**Cells:**
- Discs (boulders, trunks, stumps; logs as chains) are kept in world cells on a fixed level (about 128 m), within `radiusM` (400 m) of the camera, whatever level of detail the terrain shows.
- A cell is made when it comes in, by writers in priority order (geology 15, trees 10, deadfall 5).
- A finalize pass sorts the cell's records into one order (priority, then the record's words, id first). It keeps `capacity` (1024), counts the rest as `overflow`, and bins them 8×8. Contents do not depend on order.

**Records:** 4 u32, no f16:
- id (low word of `ecoId`);
- x, y in the cell as unorm16 (2 mm);
- radius mm | height cm << 16;
- kind | flags << 16, the top 4 bits of flags being the priority.

**Writers:**
- `addWriter({ name, priority, encode(encoder, ctx) })`. Your shader includes `buildObstacleAppendWGSL()`, binds `ctx.appendGroup`, and calls `obstacleAppend(slot, obstacleRecord(...))`.
- `ctx.cells` lists the cells to make. `invalidate()` makes every resident cell again (call it when your trees change).

**Query:** `buildObstacleReadWGSL(...)` gives `obstacleClearance(face, p, f, searchM, kindMask)`:
- the distance from a point to the nearest disc's edge, across cell and face edges;
- `searchM` when none is that near;
- `-1` when a cell that could hold one is not ready.

**Tested in the browser:** `ObstacleCells.selfTest({ quadtree })` (with `config.debugDiscs`) runs the query on the GPU against a reference worked out in doubles.
- 600 points: within 0.05 mm.
- Overflow: a 32-disc capacity, filled with 64 a cell and made twice, kept the same 32 both times.

## Not done in this foundation

- **Per-pass timing tool and overlay (plan F9).** New passes are labelled (`Ecology habitat`, `Obstacles finalize`, `Grass scatter`); `tools/perf/grass/grassBench.mjs` remains the timing method.
- **A producer hook for realized ecology** (see above).
- **Shared instanced meshes (F10).** These come with the ground layer.
- **The old code.** The tile-catalog biomes (`biomes.json`) are still read throughout terrain generation (tile categories, textures). The `assets.json` profiles feed the old streamer and the terrain's tree weights. The old streamer is still made by the frontend, shadows and game. None of them was removed.
- **`TerrainLightMap.js` `faceDirection`** has faces 2 and 3 with v mirrored against the terrain's `getCubePoint`. That looks like a bug in its tile selection near the poles; it was left alone.
