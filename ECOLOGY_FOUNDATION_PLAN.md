# Shared foundation for trees and ground cover (proposal)

Status: proposal for Codex's review, 2026-11-28. Branch `ecology/foundation` from main `6d1dc09` (grass merged).

Process: Codex reviews and asks for changes. Claude implements on `ecology/foundation`; it is merged to main; Codex merges main into `forest-prop-streaming` and continues with trees only. Claude then builds the ground layer (ground cover, small rocks, mushrooms, deadfall) on top.

## 1. What is shared and what is not

Trees and the ground layer live in one ecological world, built in layers: geology, then trees, then the ground layer. Each layer reads only the layers before it. The tree system never needs to know about ground cover.

| Shared (this foundation) | Not shared |
| --- | --- |
| How a place is named and hashed, and how points thin with distance (F1) | How trees are drawn at each distance (near geometry, mid voxels, canopy shell, orbit shading): Codex |
| Standing on the ground the terrain actually draws (F2) | How grass and ground cover are drawn (strips, strokes, the terrain's grass canopy): Claude |
| The ecology field: per-tile canopy and stand data (F3) | Each system's caches, budgets inside its share, its own labs |
| The obstacle table: trunks and boulders as discs, per near tile (F4) | Tree growth, species models, archetype baking |
| Light under the canopy at the land-light scale (F5) | Sun flecks and near tree shadows (later, see F5) |
| One wind field (F6) | |
| One registry of ecosystems, as data (F7) | |
| Per-pass timing labels (F8) | |

The foundation is contracts plus small shared modules. Most of it is extracted from the grass system, which already solves these problems for its own case. An instanced mesh renderer is a candidate for sharing but is left for Codex to decide (F9).

The old asset and tree streamer (`core/renderer/streamer/`), the `assets.json` profiles that feed it, and the old tile-catalog biomes (`wizard_game/world/biomes.json`) are not part of this. The user has said old code may go. The streamer and `assets.json` are removed once nothing reads them. The old biomes are removed once the terrain generator no longer needs their tile catalog for its ground types (checked in step 7 of §4). The quadtree terrain stays.

## 2. Principles

- **World-anchored and deterministic.** Everything that grows, stands or lies somewhere is a pure function of its place and seeds, or is derived once per tile from such functions. Moving the camera, turning, or a tile changing its level of detail never changes what is there, only how it is drawn.
- **In metres, not in fractions of the planet.** Spacing, sizes and distances are given in metres, so a 300-500 km planet keeps 2 km lakes and 20 m trees. Lattices are powers of two of the cube face, so their cells line up with tiles; each layer picks the level nearest the spacing it asks for.
- **Camera-relative on the GPU.** No shader gets an absolute position (about 131 km from the centre today, more later) as a float. The CPU computes anchors in doubles relative to the camera; shaders add small offsets. The terrain's own vertex shader broke this and jittered up to 8 mm a frame while the camera moved (fixed in `terrainPass.wgsl.js`, ninth grass round). Trees with millions of leaves would show it worse.
- **One representation's mean is the next one's input.** Grass hands over to the terrain's canopy shading by matching it (GRASS_FINDINGS.md). Trees hand over between their bands the same way, and their far bands use the same ecology field the ground layer reads, so open ground and forest floor agree at every distance.

## 3. The pieces

### F1. Places, hashes and thinning

Today in `core/renderer/grass/grassWgsl.js`: `pcg`, `hash3`, `u01`, `latticeLevel`, `latticeRank`, `vnoise`; `fieldNoise` in `grassField.wgsl.js`.

Moves to `core/world/ecology/ecologyLattice.wgsl.js`, with a JS mirror `ecologyLattice.js` for tests and CPU queries.

- **A place** is `(face, ix, iy)` on a lattice. A lattice is `(level, cells)`: the face is split into `2^level` cells along each edge, each into `cells × cells` points.
  - Grass uses `(maxDepth + 6, 48)`: 2 m patches of 4.2 cm points at today's radius.
  - A tree layer might use `(maxDepth + 3, 1)`: 16 m cells, several ranked candidates each.
  - `latticeFor(spacingM)` gives the level for a spacing in metres on the current planet.
- **A hash** is `ecoHash(face, ix, iy, layerSeed)`. Every layer has its own seed in one table (`ECO_SEEDS`: grass, trees, rocks, ground cover, deadfall, ...), so layers never correlate by accident and nobody reuses another's stream.
- **Ranks.** Every candidate point carries a rank in [0, 1), nested by lattice level (a point on every 2^k-th row and column ranks under 4^-k). A layer thins with distance by keeping ranks under its density there. Points then drop out one at a time as the camera moves, never in rows.
- **Cube-face seams.** A point belongs to the face whose cell holds it. A query near a face edge (a disc that might reach over, an exclusion radius) checks the neighbouring face's cells too: `ecoNeighbourCell(face, ix, iy, dx, dy)`.

### F2. Standing on the drawn ground

Today in `grassWgsl.js`:
- `lookupLayer`, `tileOver`, `visibleAt`, `drawnOver`, `vertexHeight`, `meshCell`, `drawnHeight`, `heightAt`, `inTile`, `texelUv`, `placeAbout`, the `Face` struct;
- the per-frame face anchors built in `GrassPass.compute`.

They move to `core/world/ecology/drawnGround.wgsl.js` and `GroundFrame.js`.

- **Why it matters.** Near the camera on high ground, the terrain draws coarser meshes than its finest heights. Grass placed on the finest heights stood in the air or under the ground. It now stands on the triangles actually drawn this frame, rebuilt from the visible-tile table and the edge-stitching rule. Tree trunks, rocks and logs need the same, or they float when the terrain's level of detail changes under them.
- **`GroundFrame`** (JS, once per frame): the faces near the camera and their anchor points, computed in doubles relative to the camera. It also exposes the uniform block and bind-group layout that `drawnGround` needs: loaded-tile table, visible table, height and normal arrays, and the counts. Grass, trees and the ground layer all use the same instance.
- **WGSL API:**

  ```wgsl
  fn groundTileAt(face: u32, cell: vec2<u32>) -> vec4<i32>
  fn groundHeightAt(tile: vec4<i32>, cell: vec2<u32>, local: vec2<f32>) -> f32
  fn groundNormalAt(...) -> vec3<f32>
  fn placeOnFace(anchor: u32, cellOffset: vec2<f32>, height: f32) -> vec3<f32>   // camera-relative
  ```

  `groundTileAt` gives the drawn tile and its mesh level; `groundHeightAt` the height of the drawn triangles there.
- **Rule.** Anything resting on terrain takes its base height from `groundHeightAt`. When the drawn tile or its mesh level changes, it is placed again; the grass stamps its patches with both. Nothing here needs finer terrain vertices. If the terrain later moves to 0.5 m vertices, this follows by itself, since it rebuilds whatever is drawn.

### F3. The ecology field

A new per-tile output `ecology`, in the terrain's tile pool:
- same layer index and resolution as the tile's height;
- a background refinement type in `core/world/quadtree/terrainOutputs.js`, like `climate`;
- generated for tiles at every level, so orbit and ground read the same field.

| Channel (`rgba16float`) | Meaning | Unit |
| --- | --- | --- |
| R `canopyCover` | Share of the ground under crowns, seen from above | 0-1 |
| G `canopyTop` | Mean height of the crown tops over the ground | m |
| B `canopyLAI` | Leaf area per ground area. Sun through the canopy: `exp(-0.5 · LAI / cos θ)` | m²/m² |
| A `stand` | Index into the ecosystem's stand list (F7); 0 is open ground | integer |

- **Writer.** The foundation ships a default writer, so everything downstream works before the forest exists. It is a compute step after the tile's climate, using `biomeCover()` (forest share) and noise:
  - cover from the forest share;
  - top 18 m;
  - LAI 3;
  - the stand picked by the registry's rules.

  Codex replaces it with the forest field from his design log (Decision 1), keeping the format.
- **Readers:**
  - TerrainLightMap (F5);
  - the terrain pass: forest floor instead of the grass canopy where `canopyCover` is high, and a cheaper material where nothing of the ground is seen;
  - the ground layer (what grows, how much light);
  - Codex's far bands: the canopy shell, and orbit shading from cover and LAI.
- **WGSL:** `ecologyAt(layer, local) -> Ecology` in `core/world/ecology/ecologyField.wgsl.js`, and a terrain debug mode showing each channel.
- **Question for Codex:** more channels? Stand age, deadfall, crown shape. A second texture `ecology2` costs little.

### F4. The obstacle table

Things the next layer must stay clear of, as discs, kept for the near tiles only (the finest two terrain levels about the camera).

- **Storage.** One storage buffer pool, indexed by the tile's pool layer: a header (count, 4×4 bin offsets) and up to 512 discs per tile.
- **A disc is 16 bytes:**
  - x, y in tile metres (f16 each);
  - radius (f16);
  - height (f16);
  - kind (u16: a tree species, a boulder, a stump);
  - flags (u16).
- **Writers, in layer order, in the same submission as the tile's refinement:**
  1. Geology (boulders, Claude).
  2. Trees (trunks, Codex). The tree pass reads the boulders first.
- **Readers:**
  - trees (to avoid boulders);
  - the ground layer (no fern inside a trunk; moss and mushrooms at its foot);
  - later, gameplay collision.
- **WGSL:** `obstacleClearance(layer, local, kinds) -> f32`, the distance to the nearest disc's edge among the kinds asked for, crossing tile and face edges.
- **Not a raster.** At 1 m tile texels a raster cannot place a fern 10 cm from a 30 cm trunk; the discs are exact.
- **Question for Codex:** do his near trees already produce such a list (for their own instances)? Then this is that list, in an agreed layout, with boulders put in first.

### F5. Light under the canopy

`core/renderer/terrain/light/TerrainLightMap.js` keeps sun and sky visibility over the land in four maps about the camera (1.5 to 98 km across, 256² each). The terrain pass (with the water it draws) and grass already read it (`landLightAt`).

- The sun pass multiplies in the canopy: `sun *= mix(1, exp(-0.5 · LAI / max(sinElevation, 0.1)), cover)`.
- The sky pass: `sky *= 1 - 0.7 · cover`.
- Both are read from `ecology`. Every reader of the land light then gets forest shade with no change of its own.

This is broad shade: about 6 m a texel near the camera. Sun flecks and trunk shadows need a finer, near map. Codex will own it with his near trees. The foundation reserves its slot in the land-light read, `nearShadowAt(rel)`, returning 1 until then, so grass and ground cover read it from the start.

### F6. Wind

Today in `GrassPass.compute`: the weather's wind direction and speed, and the gusts' offset carried with the wind, summed frame by frame (a turning wind then only changes where gusts go next; it used to sweep phase across kilometres and shake everything). Gusts are noise at 22 m and 7.5 m scales over the carried place.

Moves to `core/world/ecology/WindField.js` and `wind.wgsl.js`:
- a uniform block (direction east/north, speed, gust strength, the carried offset per face);
- `windGust(face, faceMetres) -> f32`;
- `windBend(height, stiffness, gust) -> vec2`.

Grass, trees and anything that sways read the same field, so a gust crosses meadow and forest together. Codex's per-branch hierarchy sits on top of it.

### F7. The ecosystem registry

Data in `wizard_game/world/ecology.json`. The engine's loader and validator are `core/world/ecology/ecologyRegistry.js`; the engine holds no game content. It builds on the climate-driven biome landscape (`templates/terrain-shaders/biomeLandscape.wgsl.js`, `biomeCover()`: grass, forest, marsh, tundra, snow, sand, rock), which the terrain pass and grass use now. Not on the old tile-catalog biomes.

```json
{
  "ecosystems": [
    {
      "id": "boreal",
      "match": { "cover": "forest", "temperature": [0.15, 0.45], "humidity": [0.35, 1.0] },
      "stands": [
        { "id": "spruce",     "share": 0.5, "trees": [{ "species": "norway-spruce", "share": 0.85 }, { "species": "birch", "share": 0.15 }],
          "canopy": { "cover": [0.6, 0.9], "top": [16, 28], "lai": [3, 6] } },
        { "id": "pine-heath", "share": 0.4, "trees": [{ "species": "scots-pine", "share": 1.0 }],
          "canopy": { "cover": [0.3, 0.6], "top": [14, 24], "lai": [1.5, 3] } },
        { "id": "clearing",   "share": 0.1, "trees": [] }
      ],
      "ground": [
        { "type": "moss",        "where": "under", "cover": 0.8 },
        { "type": "bilberry",    "where": "under", "stands": ["spruce", "pine-heath"], "weight": 0.5 },
        { "type": "lingonberry", "where": "under", "stands": ["pine-heath"], "weight": 0.4 },
        { "type": "fern",        "where": "under", "stands": ["spruce"], "light": [0.1, 0.5] },
        { "type": "grass",       "where": "open" }
      ],
      "rocks":    { "boulders": 0.02, "stones": 0.3 },
      "deadfall": { "logs": 0.01, "stumps": 0.02 }
    }
  ]
}
```

- **Ownership.** The tree species and stands are Codex's; the ground types, rocks and deadfall are Claude's. One file, so a biome is added in one place.
- **Validation.** The loader checks the references both ways: a stand naming a species no tree archetype provides, or a ground type naming a stand that does not exist, is an error at load.
- **Questions for Codex:** the stand fields he needs (age spread, competition, gaps, edges), and whether species definitions belong here or in his own archetype files referenced by id.

### F8. Timing

The props budget the user set is about 10 ms for forests and everything on the ground. The split is to be agreed: perhaps trees 6-7 ms; ground layer 3-4 ms, of which grass is about 2.

The foundation registers GPU timestamp labels per pass (`trees-*`, `ground-*`, `grass-*`, `terrain`, `clouds`) in one place. One tool, `tools/perf/passTimes.mjs` (from `grassBench.mjs`'s method), times them the same way: interleaved, warmed, whole frames plus per-pass spans.

### F9. Instanced meshes (for Codex to decide)

Near trees, boulders, stones, mushrooms, stumps and logs are all instanced meshes. The proposal: one GPU-driven pass for both.
- An archetype registry: mesh levels of detail packed in shared vertex and index buffers.
- Instance records relative to their patch or tile anchor.
- A compute pass: frustum, distance and level selection into one indirect draw per archetype and level.
- Opaque only, no alpha test (Apple's hidden-surface removal stays on).
- The shared ground light.

Claude would build it for rocks and mushrooms right after the foundation. If Codex wants his near trees on it, the trees' needs (per-vertex wind pivots, leaf variants, a visibility buffer) shape it from the start. If not, trees keep their own path and this is ground-layer only. Not in the foundation branch either way.

## 4. Implementation steps (`ecology/foundation`)

Each step leaves the game as it was unless it says otherwise, checked by screenshots at fixed poses and grass blade counts.

1. **Lattice and hashes (F1)** out of grass into `core/world/ecology/`, with the JS mirror. Tests: WGSL validates (naga), and the JS mirror gives the same hashes and ranks as the GPU on a sample.
2. **Drawn ground and `GroundFrame` (F2)** out of grass. Grass uses them; pictures and counts are identical.
3. **`WindField` (F6)**; grass uses it. Pictures identical with the wind held still; same sway with the game's own turning wind.
4. **The `ecology` tile output (F3)**: pool texture, default writer, `ecologyAt`, terrain debug views of the four channels. Checked from the ground, from aircraft altitude and from orbit; across tile and face edges.
5. **Obstacle table (F4)**: pool, layout, `obstacleClearance`. A debug writer scatters test discs to check bins, tile edges and face edges; the default writes nothing.
6. **Canopy light (F5)**: TerrainLightMap reads `ecology`; the `nearShadowAt` slot returns 1. Forested ground darker under the default canopy, at 6 m texels; nothing else changes.
7. **Ecosystem registry (F7)**: schema, loader, validation, the boreal entry with placeholder tree species for Codex to fill.
   - Then check what still reads the old `biomes.json` tile catalog and `assets.json`. Remove what nothing needs; list what still does.
8. **Timing labels and `passTimes.mjs` (F8).**
9. **`core/world/ecology/README.md`**: the contracts above, as the reference both sides code against.

After the merge, Codex:
- replaces the default ecology writer with his forest field;
- writes trunks into the obstacle table;
- stands trees on `groundHeightAt`;
- sways them with `WindField`;
- fills the near-shadow slot when his near trees exist.

Claude builds the ground layer: grass generalized to ecosystem ground types, then the boreal forest floor.

## 5. Questions for Codex

1. Does the ecology field's format (F3) fit the forest field in your design log? What would you add or change before it is fixed?
2. Is an obstacle list (F4) what your near trees would produce anyway? Is 512 discs per finest tile enough for your densest stands?
3. Lattice for tree candidates: is a power-of-two cell with ranked candidates (F1) compatible with your planned placement? Poisson-like spacing, competition and self-thinning need neighbour cells, which F1 provides, but not a global solve.
4. Near shadows (F5): do you want to own them with the near trees, as proposed?
5. Instanced meshes (F9): shared, or your own path for trees?
6. Anything in the old streamer you want kept, before it is removed?
