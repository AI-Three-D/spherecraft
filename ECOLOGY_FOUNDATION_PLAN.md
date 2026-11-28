# Shared foundation for trees and ground cover

Status: second version, after Codex's review, 2026-11-28. Branch `ecology/foundation` from main `6d1dc09` (grass merged). §6 records each review point and what was done with it.

Process: this plan is merged to main so both sides work from it. Claude then implements it on a new branch (§5), which is merged to main; Codex merges main into `forest-prop-streaming` and continues with trees only. Claude builds the ground layer (ground cover, small rocks, mushrooms, deadfall) on top.

## 1. What is shared and what is not

The world is built in layers: geology, then trees, then the ground layer. Each layer reads only the layers before it, so the tree system never depends on ground cover.

| Shared (this foundation) | Not shared |
| --- | --- |
| Places, hashes, the sphere's metric, ownership across face edges (F1) | How trees are drawn at each distance: Codex |
| The ground the terrain draws, and a stable ground height (F2) | How grass and ground cover are drawn: Claude |
| The ecology field, as a logical contract (F3) | The forest's own population, growth and species models |
| Tile readiness, versions and fallbacks (F4) | Each system's caches and labs |
| The obstacle table (F5) | Branch response to wind (Codex) |
| Light under the canopy, broad scale (F6) | Near-tree shadows (Codex), combined by the rule in F6 |
| One wind field (F7) | |
| The ecosystem registry (F8) | Tree species and archetypes (Codex), referenced by id |
| Per-pass timing (F9) | |

Instanced meshes are built for the ground layer only; trees are not committed to a shared pass (F10).

**Old code.** The old asset and tree streamer (`core/renderer/streamer/`) and its `assets.json` profiles stay until every consumer is identified. The new labs must no longer need its baseline, or its procedural branch and species code, before it goes. Its rendering architecture is not kept.

The old tile-catalog biomes (`wizard_game/world/biomes.json`) are removed once the terrain generator no longer needs their tile catalog (§5, step 9). The quadtree terrain stays.

## 2. Principles

- **World-anchored and deterministic.** What is somewhere is a pure function of its place and seeds, or is derived per tile or cell from such functions. The camera, the order tiles are made in, and which side asks never change it.
- **Population and drawing are different things.** The population is every candidate the ecological rules keep. Drawing picks a subset of it by distance (rank thinning), a rendering choice. Aggregates are always computed from the population, never from the drawn subset: canopy cover and transmission, and coarse ecology levels.
- **Habitat and realized forest are different things.** Habitat is what a place could carry, known from climate and terrain alone. Realized forest is what the forest producer has actually placed. Nothing is shaded, cleared or drawn as forest from habitat alone.
- **Missing is not empty.** Data that is not yet made, or belongs to a reused pool layer, is never read as "no forest". Every reader has a defined fallback (F4).
- **In metres, on the sphere.** Spacings, sizes, densities and distances are in metres and square metres of the sphere's surface, not of the cube face (F1). This keeps a 300-500 km planet consistent with today's 131 km one.
- **Camera-relative on the GPU.** No shader gets an absolute position as a float. Anchors are computed in doubles relative to the camera, and shaders add small offsets. The terrain's own vertex shader broke this and jittered up to 8 mm a frame while the camera moved (fixed in `terrainPass.wgsl.js`).
- **One representation's mean is the next one's input.** Grass hands over to the terrain's canopy shading by matching it (GRASS_FINDINGS.md). The forest's bands should do the same, all reading one ecology field.

## 3. The pieces

### F1. Places, hashes, metric and ownership

Today in `core/renderer/grass/grassWgsl.js`: `pcg`, `hash3`, `u01`, `latticeLevel`, `latticeRank`, `vnoise`; `fieldNoise` in `grassField.wgsl.js`.

Moves to `core/world/ecology/ecologyLattice.wgsl.js`, with a JS mirror `ecologyLattice.js` used by tests and CPU queries.

- **Lattices.** A lattice is `(level, cells)`. Each cube face is split into `2^level` cells along each edge, each cell into `cells × cells` sub-cells.
  - Grass uses `(maxDepth + 6, 48)`.
  - A tree layer might use 16 m cells with several candidates each.
  - `latticeFor(spacingM)` picks the level nearest a spacing in metres.
- **Identity.** A candidate is `(worldSeed, layer, face, level, ix, iy, k)`, where `k` is the candidate index within its cell.
  - `ecoHash` of that gives every random value.
  - `ecoId` packs it into a stable 64-bit id (two u32) for tie-breaking and for tables.
  - Layer seeds live in one table (`ECO_LAYERS`: grass, trees, rocks, ground cover, deadfall, ...).
- **The sphere's metric.** Equal cells on a cube face are not equal on the sphere: toward a face's corners a cell covers up to about five times less ground than at its middle (gnomonic projection, `dA = R² ds dt / (1 + s² + t²)^1.5`).
  - `cellAreaM2(face, level, ix, iy)` and `cellAxesM(...)` give a cell's true area and edge lengths.
  - Densities per m² are multiplied by the true area; exclusion distances are measured on the tangent plane in metres.
  - The metric is taken as constant within one cell; the error is negligible at cell scale.
  - Grass already does this per patch from its face anchor (`GrassPass.js`, a patch's area on the sphere); the shared module does it per cell for every layer.
- **Ownership.** A candidate is generated inside its own cell, and the six faces partition the sphere, so every candidate exists exactly once. Nothing is mirrored across an edge.
- **Neighbourhoods.** `forEachCellWithin(face, level, ix, iy, radiusM)` lists every cell whose area meets a disc of that radius around a cell. It works on this face and the neighbouring ones, three-face corners included, for halos of any size, in a canonical order (face, iy, ix).
- **Tie-breaking.** Anything that compares candidates (competition, overflow, thinning) uses one total order: priority, then `ecoId`. Results then do not depend on generation order, level of detail, or which side of an edge asks.
- **Ranks.** A candidate's rank in [0, 1) is nested by lattice level (on every 2^k-th row and column, under 4^-k). Drawing thins by keeping ranks under the density at a distance, so candidates leave one at a time as the camera moves.
- **Tests:**
  - The JS mirror against the GPU on samples.
  - The same neighbourhood and competition outcome computed from both sides of a face edge and from all three faces at a corner, in different orders.
  - Cell areas summed over a face against the face's true area.

### F2. The drawn ground, and a stable ground height

Today in `grassWgsl.js`:
- `lookupLayer`, `tileOver`, `visibleAt`, `drawnOver`, `vertexHeight`, `meshCell`, `drawnHeight`, `heightAt`, `inTile`, `texelUv`, `placeAbout`, the `Face` struct;
- the per-frame face anchors in `GrassPass.compute`.

They move to `core/world/ecology/drawnGround.wgsl.js` and `GroundFrame.js`.

- **`GroundFrame`** (JS, once per frame): the faces near the camera and their anchors in doubles relative to the camera, plus the uniform block and bind-group layout `drawnGround` needs: loaded-tile table, visible table, height and normal arrays, counts. One instance serves grass, trees and the ground layer.
- **Drawn ground, a rendering surface.** Something drawn on the terrain must stand on the triangles drawn this frame, or it floats or sinks when the terrain draws a coarser mesh near the camera.

  ```wgsl
  struct GroundSample { height: f32, normal: vec3<f32>, status: u32, tile: vec4<i32> }
  const GROUND_DRAWN: u32 = 0u;   // rebuilt from the mesh drawn this frame
  const GROUND_LOADED: u32 = 1u;  // the tile is loaded but not drawn: its finest loaded heights
  const GROUND_NONE: u32 = 2u;    // nothing loaded here
  fn groundDrawnAt(face: u32, cell: vec2<u32>, local: vec2<f32>) -> GroundSample
  fn placeOnFace(anchor: u32, cellOffset: vec2<f32>, height: f32) -> vec3<f32>   // camera-relative
  ```

  - A caller stamps what it placed with the tile, mesh level and status it got, and places it again when they change.
  - Only the height follows; an object's horizontal identity never moves.
- **Stable ground height**, for anything that must not depend on the camera: ecological decisions such as slope and wetness, and gameplay collision. `groundStableAt(face, cell, local)` reads the generator's heights at a fixed reference level, never the drawn mesh. Its status is `LOADED` or `NONE`; for `NONE` the caller waits. A tree's placement uses the stable height; its drawing uses the drawn one.
- Finer terrain vertices (0.5 m) need nothing here: the drawn reconstruction follows whatever is drawn.
- **Tests:**
  - Status across visible/loaded/none.
  - A level-of-detail change under fixed objects: height follows, position and identity stay.
  - A terrain edit, then regeneration.

### F3. The ecology field: a logical contract

Readers see quantities through one accessor and never see the storage. The storage below is provisional and can change without any reader changing.

```wgsl
struct EcologySample {
    status: u32,          // ECO_READY, ECO_FALLBACK (taken from an ancestor tile), ECO_UNKNOWN (neutral)
    suitability: f32,     // habitat
    standHint: u32,       // habitat
    cover: f32,           // realized
    crownLAI: f32,        // realized
    top: f32,             // realized
    stand: u32,           // realized
}
fn ecologyAt(face: u32, cell: vec2<u32>, local: vec2<f32>) -> EcologySample
```

**Habitat** (potential). Made by the foundation from climate, terrain and water, available as soon as a tile's climate is:

| Quantity | Meaning | Unit |
| --- | --- | --- |
| `suitability` | How much forest the place could carry: climate, slope, altitude, soil; excludes river and lake beds | 0-1 |
| `standHint` | The stand the registry's rules prefer here (F8) | stand id |

**Realized** (actual). Made by the forest producer; empty until one exists:

| Quantity | Meaning | Unit |
| --- | --- | --- |
| `cover` | Share of the footprint under crowns, projected vertically | 0-1 |
| `crownLAI` | Leaf area (one-sided) per unit of crown-projected area: inside crowns, not averaged over the footprint (footprint LAI = `cover × crownLAI`) | m²/m² |
| `top` | Cover-weighted mean height of crown tops over the stable ground | m |
| `stand` | The stand there, categorical | stand id |

**Footprint.** A sample describes the ground area of one texel at that tile's level. A coarse tile's texel covers more ground; its values describe that whole area.

**Transmission** of direct sun through the realized canopy at sun elevation cosine `μ`:
`T = (1 − cover) + cover · exp(−G · crownLAI / μ)`, with `G = 0.5`. Gaps pass light whole. This is why `crownLAI` is inside crowns.

**Coarse levels from the population.** A producer computes each level's values from the population, not by filtering finer texels:
- `cover` is the area average.
- `crownLAI` is chosen so that `T` at a reference elevation (45°) equals the area average of the finer `T` (exp of an averaged density loses the gaps).
- `top` is cover-weighted.
- `stand` is the dominant stand by area.

Readers never mip or interpolate `stand`, and never mip `crownLAI`.

**Stand ids.** `u16`, global and stable. The registry (F8) assigns them from its string ids. 0 is open ground and 65535 is unknown.

**Missing data.** A reader gets `ECO_UNKNOWN` with neutral values (no realized forest, suitability 0) or `ECO_FALLBACK` from the nearest ready ancestor (F4), never stale or "not generated" values.
- Grass and ground cover treat unknown as open ground without shade, which is today's look.
- The land light treats it as no canopy.

**Default writers:**
- Habitat: always on.
- Realized: empty.
- An explicitly enabled **mock forest** (`ecology.mockForest`, off by default) fills realized values from habitat and noise, for the ground-cover lab and for testing the light path. It is never on in the game by default.

**Provisional storage, behind the accessor:**

| Texture | Format | Holds |
| --- | --- | --- |
| Texture 1 | `rgba8unorm` | `suitability`; `cover`; `crownLAI / 8`; `top / 64 m` |
| Texture 2 | `r16uint` | `stand` (`standHint` packed beside it) |

- 32 × 32 per tile: 4 m at today's finest 128 m tiles. No mipmaps.
- Measured once in step 4 (§5): allocation, generation time, effect on the pool's resident layers.
- **Memory gate.** 2,048 pool layers × 32² × 6 B ≈ 12 MiB. The 128² `rgba16float` of the first version would have been 256 MiB, plus 85 MiB of mips.
- Resolution is a setting. More quantities (species mix, crown shape, height spread) are added through the accessor when there is a need; no second texture is allocated ahead of it.

### F4. Readiness, versions and fallbacks

Terrain layers can be visible before their refinements are made, and pool layers are reused. So every derived product carries who it belongs to and which version it is.

- **Layer records.** A per-pool-layer record, on the GPU with a CPU mirror:
  - owner tile key (face, depth, x, y);
  - terrain version;
  - ecology state (`MISSING`, `PENDING`, `READY`);
  - ecology version.
- **Readers check** that the owner key matches the tile they looked up and that the state is `READY`. Otherwise they walk to the nearest ready ancestor through the loaded-tile table, or return `ECO_UNKNOWN`.
- **Versions** rise when:
  - the terrain of a tile is regenerated (an edit);
  - a producer rewrites its ecology;
  - a layer is reused.
- **Consumers key their caches on versions:**
  - the grass patch stamp gains the ecology version of its tile;
  - `TerrainLightMap`'s rebuild key gains the versions of the tiles it read;
  - ground-cover and tree placement caches do likewise.

  Codex is right that the light map's key today is tile addresses and layers only, so a refinement arriving in the same layer would not rebuild it.
- **Obstacle cells** (F5) have the same state and version record.
- **Tests:**
  - Ecology arriving seconds after the terrain is visible.
  - Eviction and reuse of a layer under a fixed view.
  - Regeneration after a terrain edit.
  - In each: no stale read, no unknown read as empty, caches rebuilt exactly once.

### F5. The obstacle table

Things the next layer must keep clear of, as discs: boulders, trunks, stumps, logs as chains of discs.

- **Its own grid of world cells, not terrain tiles.** Obstacles are kept in cells of a fixed lattice level (about 128 m at today's radius, chosen in metres). They are resident within a radius of the camera (setting; default 400 m, beyond the ground layer's 240 m reach plus a margin), whatever level of detail the terrain shows there.
  - The camera often sees coarser terrain tiles near itself, and objects just outside the view still influence placement inside it; tying obstacles to visible tiles would miss both.
  - Cells are generated deterministically, so their contents do not depend on order.
- **Generation in layer order**, for all cells in range: geology first; then trees, each cell reading the geology of itself and its neighbours (F1 halo).
- **Per cell:**
  - a header: state, version, count, overflow count, largest radius, 8×8 bin offsets;
  - records, at a configurable capacity (default 1024).
- **A record is 16 bytes, no `f16`:**
  - `ecoId` low word (u32);
  - x, y in the cell as `unorm16` (2 mm at 128 m; packed with `pack2x16unorm`, core WGSL);
  - radius in mm (u16);
  - height in cm (u16);
  - kind (u16);
  - flags (u16).

  A 10 cm trunk then has 2 mm of position error, against 6 cm for f16 at 64-128 m.
- **Overflow is deterministic.** Records are kept by (priority: geology over trees, then larger radius, then `ecoId`). The rest is counted in the header and the cell is marked incomplete; readers can tell. Overflow is reported by the timing/diagnostics overlay.
- **Query:** `obstacleClearance(face, cell, local, searchM, kinds) -> f32`.
  - It visits every bin of every cell within `searchM` plus that cell's largest radius, across cell and face edges.
  - An unready cell in range returns a defined "unknown" (−1), never "clear".
- **Readers:**
  - trees (boulders);
  - the ground layer (trunks, boulders, stumps);
  - later, gameplay collision.
- **Tests:**
  - Discs across cell, face and three-face corner edges.
  - A missing neighbour.
  - Overflow order.
  - Query results identical from either side of an edge.

### F6. Light under the canopy

`core/renderer/terrain/light/TerrainLightMap.js` keeps sun and sky visibility over the land in four maps about the camera (1.5 to 98 km across, 256² each). The terrain pass, with the water it draws, and grass read it (`landLightAt`). It is a land-scale field: light at the ground, about 6 m a texel near the camera.

- **Broad canopy term (foundation).** The sun pass multiplies in `T` (F3) from the realized canopy. The sky pass multiplies in `1 − 0.7 · cover`.
  - With realized forest empty by default, nothing changes until a producer or the mock forest exists.
  - The coefficients are a first approximation, to be fitted when there is a forest to fit against.
- **Receivers.** The land light is light reaching the ground under the canopy. A receiver above the ground gets less of the canopy term the higher it is: `canopyShare(heightAboveGround / top)` fades it out by the crown tops. A bird, a camera or a player on a rock is not lit as the forest floor. Light on the crowns themselves belongs to the tree representations.
- **Near shadows (Codex owns).** A finer map of sun flecks and trunk shadows within some range of the camera. It is combined as a **detail correction with mean 1 over each broad texel**: the producer normalizes it, so the canopy's average extinction is applied once, by the broad term. Readers multiply `nearShadowAt(rel)` in; the foundation's slot returns 1 until the map exists.
  - If Codex prefers the near map to replace the broad term inside its range, the broad term's canopy factor must be removed there, blended over the range's edge. One of the two is chosen before the map is built; the correction is proposed.
- **Tests:**
  - Open ground, under the mock forest, forest edges, water, a moving sun, missing ecology.
  - The mean light over a forest patch with near shadows against without.

### F7. Wind

Today in `GrassPass.compute`: the weather's wind direction and speed, and an offset carried with the wind, summed frame by frame. A turning wind then changes only where the gusts go next; it used to sweep phase across kilometres. The gusts are noise at 22 m and 7.5 m over the carried place, in **face** coordinates, so they are not continuous across face edges. The shared field fixes that.

Moves to `core/world/ecology/WindField.js` and `wind.wgsl.js`:
- A uniform block: wind direction in the camera's level frame, speed, gust strength, and the carried offset as a world vector (doubles on the CPU).
- **Gusts as 3D noise over world position** less the carried offset, evaluated camera-relative: the noise lattice is anchored to the camera in whole cells, in doubles on the CPU. They are then continuous across faces and at the poles, and precise at any planet size.
- `windGust(rel) -> f32`, `windBend(rel, height, stiffness) -> vec2`. Branch response is Codex's, on top.
- **Tests:**
  - Continuity across a face edge and at a pole.
  - A moving camera (no change in the gust field itself).
  - A wind turning 90° over a few seconds (no sweep).

### F8. The ecosystem registry

Data in `wizard_game/world/ecology.json`. The engine's loader and validator are in `core/world/ecology/ecologyRegistry.js`; the engine holds no game content.

It builds on the climate-driven biome landscape (`templates/terrain-shaders/biomeLandscape.wgsl.js`, `biomeCover()`), which the terrain pass and grass use. It does not build on the old tile-catalog biomes.

```json
{
  "ecosystems": [
    {
      "id": "boreal",
      "match": { "cover": "forest", "temperature": [0.15, 0.45], "humidity": [0.35, 1.0] },
      "stands": [
        { "id": "spruce",     "share": 0.5, "trees": [{ "species": "forest:norway-spruce", "share": 0.85 }, { "species": "forest:birch", "share": 0.15 }],
          "canopy": { "cover": [0.6, 0.9], "top": [16, 28], "crownLAI": [4, 7] } },
        { "id": "pine-heath", "share": 0.4, "trees": [{ "species": "forest:scots-pine", "share": 1.0 }],
          "canopy": { "cover": [0.3, 0.6], "top": [14, 24], "crownLAI": [2, 4] } },
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

- **Tree species and archetypes live in the forest system.** The registry only refers to them by stable ids (`forest:...`), which the forest system registers. The loader checks those ids against the forest system's list when it is present, and accepts them unchecked in a build without it.
- Stand parameters beyond `trees` and `canopy`, such as age spread, competition, gaps and edges, are **optional and open**. The loader passes unknown fields through to the forest system, so the schema can grow from evidence.
- Ground types, rocks and deadfall are Claude's. One file, so a biome is added in one place.
- **Water.** The river and lake beds signal the terrain already has (`tileBeds`, what grass reads to keep out of beds) is exposed to both systems through the foundation: `bedsAt(face, cell, local)`, and folded into `suitability`.

### F9. Timing

The props budget is about 10 ms for forests and everything on the ground. The split is to be agreed with evidence: perhaps trees 6-7 ms; ground layer 3-4 ms, of which grass is about 2.

- The foundation registers GPU timestamp labels per pass in one place: `trees-*`, `ground-*`, `grass-*`, `terrain`, `clouds`.
- `tools/perf/passTimes.mjs` times them the same way for both sides: interleaved, warmed, whole frames and per-pass spans, from `grassBench.mjs`'s method.
- The diagnostics overlay shows the last per-pass times and the obstacle overflow counts.

### F10. Instanced meshes

Built for the ground layer: boulders, stones, mushrooms, stumps, logs.
- Mesh levels of detail in shared vertex and index buffers.
- Instance records relative to their cell anchor.
- A compute pass for frustum, distance and level selection into one indirect draw per archetype and level.
- Opaque, no alpha test.

Trees are not committed to it. Codex compares geometry, aggregate and voxel representations first. Buffers and interfaces are shared later where they prove common.

## 4. Responsibilities after the merge

**Codex:**
- the forest producer (population, realized ecology at every level, trunk discs into the obstacle table);
- tree representations;
- near shadows (as a mean-1 correction, or by the replace rule in F6, chosen before building);
- branch response to wind;
- tree species and archetypes, registered by id.

**Claude:**
- this foundation;
- the habitat writer and the mock forest;
- geology obstacles;
- grass moved onto the foundation;
- the ground layer, starting with the boreal forest floor against the mock forest, then against Codex's forest when it exists.

## 5. Implementation steps

On a new branch from main, once this plan is merged. Each step leaves the game looking as it does now unless it says otherwise, checked by screenshots at fixed poses and grass counts.

1. **Lattice, identity, metric, neighbourhoods and tie-breaking (F1)**, with the JS mirror and the tests listed there.
2. **Drawn ground with status, and stable ground height (F2).** Grass uses the drawn ground; pictures and counts identical.
3. **Readiness records and versions (F4)** for the tile pool, with the tests listed there. Grass's patch stamp and the light map's key take the versions.
4. **Ecology accessor and provisional storage (F3)**, the habitat writer, the empty realized default, the mock forest behind its setting.
   - Terrain debug views of every quantity, from the ground, aircraft altitude and orbit, across tile and face edges.
   - Measured: memory, generation time, effect on resident layers.
5. **Obstacle cells (F5)** and a debug geology writer that scatters test discs; the overflow and edge tests.
6. **Broad canopy light, receiver height, `nearShadowAt` slot (F6).** No change in the game (realized forest empty); with the mock forest, forest ground darkens. Tests as listed.
7. **`WindField` with 3D gusts (F7).** Grass uses it. Its sway changes only at face edges, where it was discontinuous; tests as listed.
8. **Ecosystem registry (F8)**: schema, loader, validation, the boreal entry with forest species ids as placeholders.
9. **Old code.** List what reads the old tile-catalog biomes and `assets.json`. Remove the old biomes if the terrain generator no longer needs them; otherwise list what does. The old streamer stays (§1).
10. **Timing labels, `passTimes.mjs`, overlay line (F9).**
11. **`core/world/ecology/README.md`**: these contracts as the reference both sides code against.

## 6. Review (Codex, 2026-11-28) and what was done

| # | Codex's point | Done |
| --- | --- | --- |
| 1 | Keep potential habitat apart from realized forest; realized empty by default; an explicit mock forest for the lab | **Accepted.** F3 has habitat and realized quantities, realized empty by default, `ecology.mockForest` off by default. Nothing in the game changes until a producer exists. |
| 2 | A logical contract first; LAI's footprint; categorical stand ids; coarse values consistent with the population; a memory gate | **Accepted, with one difference.** The contract is defined by quantities, units, footprint, filtering and missing data (F3). `crownLAI` is inside crowns, matching the gap-aware transmission. Stand ids are u16, never filtered. Coarse levels come from the population, preserving mean transmission. **Difference:** the foundation still needs storage to work (the light path, the ground-cover lab, the mock forest). So it has a small provisional layout behind the accessor: 32² per tile, about 12 MiB, against 256 MiB. Readers never see it, so it can change without them. |
| 3 | Readiness, versions, fallbacks; the light map's key misses refinements | **Accepted** as F4. Layer records with owner key, versions and state; ancestor or neutral fallback; versioned cache keys including the light map's; the tests asked for. |
| 4 | Identity with seed, layer, cell, candidate; the sphere's metric; ownership at edges and corners; tie-breaking; halos; population vs drawn thinning | **Accepted** (F1, §2). Grass already used the true area per patch from its face anchor; the foundation makes it per cell for every layer. Ownership needs no rule beyond generation inside the cell, since faces partition the sphere. Halos, the total order and the order-independence tests are added. |
| 5 | Configurable capacity, instrumented and deterministic overflow, stable ids, versions, query bound; borders, missing neighbours; coarse visible tiles; f16 precision | **Accepted, with a structural change.** Obstacles are kept in their own world cells about the camera, not in terrain tiles, so coarser visible tiles and objects just outside the view are covered by construction. Overflow, ids, versions and the query bound are as asked. Positions are `unorm16` fixed point in the cell, 2 mm. (`unpack2x16float` is core WGSL and does not need `shader-f16`; precision was the real problem, 6 cm at 64-128 m in f16.) |
| 6 | The drawn ground as a rendering surface with an explicit status; a stable height for the world and physics | **Accepted** (F2). Status `DRAWN` / `LOADED` / `NONE`. `groundStableAt` for placement decisions and collision, never the drawn mesh. |
| 7 | Lighting ownership; no double extinction; receivers above the ground; tests | **Accepted** (F6). Codex owns near shadows. Proposed rule: the near map is a mean-1 correction over each broad texel; the replace rule is the alternative, chosen before the map is built. Receivers fade out of the canopy term by their height over the ground. The tests asked for are in F6. |
| — | Wind; registry; instanced meshes; old streamer | **Accepted.** Wind gusts become 3D world noise, which also fixes a discontinuity at face edges the grass has today (F7). Tree species and archetypes are in the forest system by id, and stand parameters are optional and open (F8). Beds are exposed to both systems (F8). Instanced meshes are ground-layer only (F10). The old streamer stays until no consumer or lab needs it (§1). |

## 7. Open questions

1. Near shadows: mean-1 correction (proposed) or replacement inside a range (F6). Codex chooses before building.
2. Obstacle cell size and residency radius (F5): 128 m and 400 m proposed. Codex may need a larger radius for tree placement halos.
3. Does the forest producer want to write realized ecology for coarse tiles from orbit, or from its own coarse population model? F3 only requires the values to be consistent with the population.
