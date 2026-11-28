# Ground cover: findings

The forest floor, built on the ecology foundation (`core/world/ecology`, `ECOLOGY_FOUNDATION_PLAN.md`). Branch
`ground/boreal-floor`. The first biome is the boreal forest: spruce and pine heath.

## How the floor is drawn

A stand's floor comes from the ground types its ecosystem lists in `wizard_game/world/ecology.json`. These are entries with `"where": "under"`, optionally limited to some `stands`. Two systems draw them:

- **Plants** are built by the grass system (`core/renderer/grass/floorPlants.js`, `grassWgsl.js` FLOOR).
  - Types: `bilberry`, `lingonberry`, `fern`, `broadleaf-understory`, `forest-grass`.
  - Each entry has a `weight` and an optional `light` band (the share of the noon sun the canopy lets through).
  - They take the place of the landscape's grass wherever the stand's trees stand at all (`floorPresence`: canopy cover 0.05 to 0.3). An open pine heath's floor is the heath's between its crowns too.
- **Surfaces** are drawn by the terrain (`core/renderer/terrain/materials/forestFloor.js`, `terrainPass.wgsl.js floorSurfaceOf`).
  - Types: `moss`, `lichen`, `leaf-litter` / `needle-litter`.
  - Each entry has a `cover` share. Litter takes the rest, and a stand with none listed is all litter.
  - The shares are baked into the terrain shader as a switch on the stand id when it is built. No binding is added.

Plants are built from parts:

- A dwarf shrub is a few shoots (STEM records). Bilberry shoots branch into two side twigs. Leaves (LEAF) lie on the shoots' curves, and berries (BERRY) appear where light reaches the floor.
- A fern is a crown of arching fronds with leaflets in pairs.
- Far off, a plant becomes one stroke.

The moss surface is a new ground layer, `moss` (`groundMaterials.js`, `groundMaterialGenerator.wgsl.js` bed 12). It has:

- feather-moss cushions over hummocks, with frond pieces lying over them;
- spruce needles where the moss is thin, over warm humus;
- twigs and a few birch leaves.

Lichen uses the tundra layer for now.

Under a canopy the grass system's blades also bend less: each patch stores a shelter factor (`1 - 0.75 * step3(0.1, 0.7, cover)`) and the blades' bend is multiplied by it.

## Budgets

Each plant writes many records: a bilberry plant writes about 50 near the camera, against the 13 its tuft budget (`perTuft`) assumed. Two limits overflowed:

- Band 1 (9.5 to 24 m) went over its capacity of 262,144. Blades were then dropped in whatever order the GPU wrote them, which flickers.
- In the pine heath the tuft store went over its capacity of 1,572,864, at 2.18 M records. Whole patches were then left incomplete, which showed as blocky holes in the floor.

Three changes fixed this:

1. **Leaves thin out by their own rank (chooseBlade, rule 3).**
   - All leaves are kept while one is 3.5 pixels long. Fewer are kept further out, down to 3 in 10.
   - The leaves left are enlarged by `1 / sqrt(share)`, so the plant keeps its cover. This is stochastic simplification.
   - A fern's leaflets are ranked in pairs.
2. **Only the leaves the patch can show are made.**
   - generateMain makes a leaf only if its rank is below the share at `reachD`, using the plant's largest leaf as the bound.
   - A patch is made again when it comes 15 % nearer, so the leaves drawn are always among the leaves made.
3. **Stems and twigs are made only near the camera.**
   - They are made to `STEMS_TO` = 0.5 of `frame.dist.w`, and narrowed out before that distance.
   - They are 2 to 3 mm thick, so further out they were under a pixel and only cost records.

Counts after the fixes, at the lab's 2400 × 1350 canvas:

| View | Band 0 | Band 1 | Band 2 | Kept |
| --- | ---: | ---: | ---: | ---: |
| Spruce, standing (eye 1.7 m) | 109,752 | 56,506 | 30,937 | 731 k |
| Spruce, from 6 m up, 30° down | 65,913 | 205,207 | 29,886 | 1.08 M |
| Pine heath, standing | 119,164 | 59,095 | 33,733 | 798 k |
| Pine heath, from 6 m up | 67,785 | 218,800 | 32,595 | 1.18 M |

There is about a fifth of band 1 and a quarter of the store left. A denser stand or a larger screen can still overflow. Dropping by rank rather than at random when a band fills would be the robust fix, and it is not done yet.

A bug found on the way: the block bound took the floor's most weight at light 0 and at light 1 only. An entry with a middle light band, such as ferns at 0.1 to 0.5, was missed, which capped those spots below their intended density. It is now the sum of all the stand's entries (`floorMost`).

## The lab

1. Start the dev server and open `wizard_game/standalone.html`.
2. Import `tools/perf/grass/grassRig.js` and call `boot()`.
3. Use the `forest-floor` pose from `tools/perf/biomeLandscape/poses.json`.
4. On `qtr._ecology`, set `mockStand = 'boreal/spruce'` (or `'boreal/pine-heath'`) and `mockForest = true`.

The mock stand applies wherever the landscape is vegetated, whatever the climate. No natural boreal stand with forest was found near the spawn.

Set the stand once per page load: changing it between shots did not remake the field before the next shot.

## Not done yet

- Mushrooms, stones and deadfall. These need the shared instanced-mesh path (F10).
- A lichen surface of its own (pale reindeer lichen). The tundra layer stands in for it.
- Floor-plant strokes at middle distance are still plain round blobs.
- The leaves do not follow the stems in wind: the leaves are placed on the stems' curves without wind, and each bends by itself.
- Dropping by rank when a band fills.
