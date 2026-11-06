# Lakes generated with terrain: investigation and implementation plan

2026-11-06. This is a proposal and experiment plan, not an implemented design or a performance guarantee. The owner wants to investigate lakes as part of terrain generation, keep the established water appearance or improve it, minimize compute and memory, and avoid detailed planet-wide work. Rivers still need to connect correctly, but a terrain-generated lake does not require replacing the river system in the first experiment.

## Visual target and scope (owner reference)

The owner supplied [an aerial screenshot](docs/reference/lake-terrain-2026-11-06/current-aerial.png), [a ground-level screenshot](docs/reference/lake-terrain-2026-11-06/current-ground.png), and [a visual target](docs/reference/lake-terrain-2026-11-06/target.png). The target illustrates the same kind of large landforms and water layout with more varied secondary relief and an irregular shoreline: coves, points and smaller bank scallops nested at different scales. It is a visual direction, not evidence that the depicted geometry or placement is already achievable or a requirement to reproduce every feature literally. Lakes should fit their valleys and have natural variation rather than reading as uniformly smooth blobs; still water should remain level.

The broader target includes improved terrain noise, but **this plan covers lakes only**. Preserve the surrounding terrain's macro shape and existing global terrain stack. Lake-specific basin and shoreline work may modify terrain within bounded lake support where justified; a general terrain-noise overhaul, global erosion system, new vegetation and general rock scattering are out of scope. The first terrain-compute integration can use existing natural terrain detail and keep the current look if that is the safest way to establish the data path. Add basin and shoreline detail as a separately measured follow-up, not as a prerequisite to moving lake generation into terrain compute. Terrain outside the affected basin/shore support must be unchanged.

Evaluate the target at both scales. From above, look for varied lake outlines and landforms that support the water shape, not only decorative noisy edges. Near the ground, check water/ground contact, readable but non-repeating shore variation, natural transitions between smooth and rough stretches, and believable bed/shore depth. Rock accents in the illustration are optional future detail, not a requirement to scatter rocks around every lake. Keep the existing approved water, river junctions and unobstructed ground-level movement in view.

## The problem to solve

The current lake pipeline discovers water *after* evaluating terrain. The hydrology sampler runs the production terrain height function, reads samples back, builds a planet-wide graph, solves lake patches and separately discovers mountain pockets, extends their drainage and solves ponds. The solved masks then reach the water renderer. The river path adds its own tracing and baked field.

At the reported view, a fresh-cache audit found 4,747 mountain discovery blocks, 2,194 mountain lakes, 2,581 drainage-continuation patches and 3,056 ponds before precomputation completed. One run under concurrent load spent about 32 s discovering pockets, 13 s continuing drainage and 23 s solving ponds. These are one-machine measurements, not budgets. Near-first scheduling helps the first few lakes but does not remove the dependency between local rivers and the global mountain/pond pass. See [RIVERS_AND_LAKES.md](RIVERS_AND_LAKES.md) for the current measurements and visual references.

The opportunity is to let terrain generation produce a lake-shaped basin **and the information needed to draw its water**, so its shape and level are available when nearby tiles are generated. This might eliminate separate terrain resampling, flooding, mask upload and later correction for constructed lakes. It could also make far water available as part of a coarse tile and improve as tiles refine. It must be measured: a more complicated height function on every terrain sample can cost more than a separate lake solve, especially on low-end GPUs.

The reported stacked ponds are also a level-consistency case: their independent patch solves gave 534.12 m and 543.39 m, while solving them together on a larger patch produced one connected basin at about 550.42 m. The current pipeline now re-solves overlapping mountain basins on a common terrain grid and follows the resulting spillways; lower mountain pockets contained by a graph lake are assigned to that graph lake. The terrain-native design must likewise resolve one authoritative basin, spill and dependent connections rather than merely hide overlapping surfaces.

## Existing work to examine, not a constraint

- [advancedTerrainCompute.wgsl.js](core/world/shaders/webgpu/advancedTerrainCompute.wgsl.js) assembles the terrain height function, its derivatives and tile passes. [HydrologyGrid.js](core/world/hydrology/HydrologyGrid.js) calls that function again for the current water graph and patch solves. Terrain and lake experiments must agree on the same height inputs, units and feature switches.
- [regionalTerrain.js](core/world/terrain-generator/regionalTerrain.js), the regional basin/shape/valley files and [regionalWater.js](core/world/hydrology/regionalWater.js) already contain experiments with constructed features and publication through the water interface. The old regional approach is disabled by default and the owner did not find older approaches satisfactory. Inspect its certificates, masks, costs and failure cases; do not assume its placement, look, fixed region size or code must be retained.
- [terrainFeatureToggles.js](core/world/terrain-generator/terrainFeatureToggles.js) includes shallow terrain hollows. A hollow alone supplies neither a water level nor proof that water stays inside it.
- [WaterGpuData.js](core/world/water/WaterGpuData.js) and [nearWaterSurface.wgsl.js](core/renderer/water/nearWaterSurface.wgsl.js) distinguish the ground, a lake's flat surface and coverage. [riverField.js](core/world/water/riverField.js) combines traced rivers, lake masks and terrain cuts. Any replacement needs a defined interface to these consumers rather than just a new noise term.

## Candidate designs to compare

1. **Procedurally constructed basins, evaluated by terrain.** A deterministic feature descriptor defines a basin, a single water level, its footprint and optionally a spill/outlet. Terrain evaluates the same descriptor as part of its height function; water consumes its level and coverage. Irregular multi-lobed boundaries, varying shores, islands, depth, surroundings and outlets must come from the recipe, not a repeated circular stamp. This is the leading prototype because the lake's existence can be known before fine tiles are ready.
2. **Hybrid natural and constructed basins.** Use the terrain's coarse landform, climate and/or bounded local samples to choose a site and shape; construct or adjust a basin there and publish its level. This may fit the terrain better, at the cost of site-selection work and a dependency between coarse terrain and the feature descriptor. The fine terrain must not be used to choose a feature that then changes the same fine terrain without a defined ordering.
3. **Discover existing natural depressions locally.** Keep terrain unchanged and solve only bounded nearby regions, ideally using GPU-resident height data. This preserves natural placement better but still needs flood/spill work, region-boundary handling and a way to publish consistent water without long waits. Compare it as a baseline rather than assuming construction is best.

Pure noise or a local height minimum cannot by itself establish a connected water body, its spill level or its downstream river. Likewise, a shallow analytic bowl is not sufficient if high-frequency terrain can raise an island, breach a rim or cut a second basin through it. The experiment must either bound those remaining height terms or explicitly account for them. These are design choices to test, not a reason to keep the current pipeline.

## Proposed prototype contract

Use a small, explicit descriptor for each selected lake: stable feature key; seed and algorithm version; planet-relative centre/frame; footprint/shape parameters; water level; bed and shoreline parameters; bounds; and, where one exists, a stable outlet and downstream connection. Specify units and numerical precision. Never use a transient camera-dependent array index as its identity or as the seed for river appearance.

For a direction, the same descriptor must provide:

1. **Terrain:** a bounded modification of the natural height and, where required, derivatives for normals. Preserve surrounding terrain outside a smooth, finite support; avoid rings, vertical cuts and repeated shapes. Bounds must include terrain micro detail and all enabled height features.
2. **Water:** the same level and a coverage/depth representation consistent with the final bed. A flat lake surface is a separate geometric/shading concept; simply colouring low terrain cannot produce correct near-water reflections, shorelines or underwater views. Far LOD may use a cheaper representation derived from the same feature.
3. **Connections:** a lake-to-river contract containing the outlet position, level, direction and any required approach area. A downstream river must meet the lake, remain downhill and not cut through the retaining shore. Define closed lakes and inflows as well. Until a connection is ready, do not publish a detached river or expose a brown channel.

Feature selection and ownership must be deterministic for a seed and world settings, independent of camera position, request order, worker completion and selected precompute/on-demand mode. Use a canonical spatial address and stable tie breakers. Neighbours must agree across regions and cube faces. A simple finite halo is **not** automatically sufficient for the current largest-first greedy selection: rejection can propagate through chains of competing lakes. Either use a bounded local selection rule with tested consequences, or explicitly resolve boundary dependencies. Handle large lakes that span many regions with an owner/descriptor or hierarchy that does not duplicate or truncate them.

Prepare descriptors before the tiles that consume them. If a descriptor genuinely changes, version the terrain, water and river inputs together and publish compatible outputs together; avoid showing new water over an old bed. A prototype may reject an unready feature instead of displaying a false provisional lake. Do not assume a late descriptor can be applied without tile regeneration.

### A concrete first recipe to test

For a canonical region, derive a bounded set of candidate feature keys from the world seed. Use the coarse landform and climate to reject unsuitable sites; apply a deterministic, bounded overlap rule before publishing the accepted descriptors. Give a descriptor a tangent frame and form an irregular signed shape from a small number of differently sized lobes with a smooth, bounded domain warp. The shape describes a candidate interior and a finite shore transition, not the final water mask. Use multiple shapes and parameter distributions so this does not become a field of similar round holes.

At each terrain sample, evaluate the natural height first. For a relevant descriptor, blend toward a varying basin floor below its proposed level, preserving controlled natural detail and fading the modification smoothly to zero outside the shore. An outlet candidate is part of the same recipe. Compute a conservative bound or run a bounded local check on the *combined* height, including fine displacement, to establish a retaining boundary and a connected wet area. If that cannot be established, reject or refine the candidate; do not simply colour every low point, which can create detached puddles or water beyond a sill. Test both a constructed rim and a shape that uses existing terrain for retention, since an artificial rim can look like a raised ring.

For the visual follow-up, compare a shoreline shaped by the existing terrain against lake-local, multiscale variation of the basin boundary and bank. Keep broad coves and promontories independent from finer scallops, with strength varying spatially so the entire shore is not uniformly rough. Any displacement must affect the **same final terrain height** used to derive water coverage and the lake's outlet; a purely cosmetic outline that disagrees with geometry will reopen seams or cause water to float. Bound the modification and verify depth, slopes, lake retention and continuity across tiles and LODs. A bank can remain smooth where the terrain calls for it; avoid contour-parallel rims, repeated motifs and an artificial ring of stones.

Build a spatial index or compact candidate list per tile/region so each terrain sample checks only nearby features. A tile's generation pass can produce coverage/depth alongside height, while the descriptor supplies its shared level and near-water surface. The same global direction and stable descriptor must yield the same answer in adjacent tiles and at different LODs. Measure the extra work in every terrain pass that invokes the height function, including hydrology sampling and normals; do not assume a descriptor lookup is free. This recipe is an experiment, not a claim that it already solves global spill routing or matches the present lakes.

## Experiments and work order

### 1. Establish comparisons and failure cases

- Capture terrain-only startup and tile-generation costs, current water-off/on, cold and warm caches, and the same camera paths on the same machine. Record GPU time, CPU/worker time, readback, main-thread stalls, resident/peak memory, shader compile, first terrain, first nearby lake and stable water. Record whether the GPU is shared with another browser.
- Preserve the owner's current approved lake/river views and the reported high-altitude lake, layered-pond and distant-river-gap views. Include close shoreline, islands, outlets, oblique and overhead views, large lakes, cube-face/LOD boundaries and travel across feature boundaries. Do not compare appearance only from one angle.
- Use the two supplied screenshots as baseline context and the supplied illustration as the lake/shore visual direction. Capture matched aerial and ground views for every candidate and show the owner the actual rendered output. Where placement changes, choose representative equivalent scenes and document the change; do not claim a pixel-identical comparison.
- Inventory which existing structured basin/shape tests and certificates are reusable; reproduce the owner's dissatisfaction before presenting the old regional implementation as a candidate. Compare visual variety as well as speed.

### 2. Build a small isolated terrain-native lake prototype

- Construct several seeded basins in one bounded test region without replacing production water. Include small and large, shallow and deep, quiet and mountainous cases, plus an irregular multi-lobed lake and an island. Use the same descriptor to evaluate terrain and to produce water coverage/level; use the current renderer as an adapter only if it does not dictate the architecture.
- First prove that a terrain-compute-generated lake and its water data agree using the current terrain and a simple basin. Do not block this first step on new global noise or a finished shoreline look. Then A/B lake-local shoreline and basin-detail candidates against the owner's reference, alongside a candidate using existing terrain detail alone. Record their incremental tile-generation, memory and streaming costs independently.
- Compare at least two shape families or parameterizations against the current reference. Record whether the basin still looks natural with all terrain detail enabled and whether it produces a credible shore and lakebed at low LOD and at close range. Check for periodicity, sharp rims, stacked surfaces, dry gaps and visible LOD transitions.
- Measure added GPU time **per generated tile** and at representative visible tile counts. Measure descriptor creation and publication separately. Compare against existing sampled/flooded lakes end to end, including hidden startup work. Count memory and any CPU/GPU readback, not just shader time.
- Check terrain height and normals at adjacent tile edges, every supported LOD and cube-face edges; exercise large coordinates and the 1,000 km planet case. A feature must be identical regardless of which tile asks first.

### 3. Prove deterministic, bounded placement

- Prototype canonical feature addressing, overlap/priority rules, neighbour discovery and a representation for large lakes. Randomize region request order and concurrency; compare precompute and on-demand results for the same seed. Include camera movement, cache eviction/reload, changed world settings and region/cube-face crossings.
- Measure bounded work and memory per active region, including border dependencies. Test how density, radius and neighbour counts scale with planet size. Do not allocate detailed 2D data for the whole planet. Include pathological dense features, wide lakes and failed/uncertain candidates.
- Decide from the results whether construction alone meets the look, whether the hybrid is needed, or whether local natural discovery wins. It is acceptable to replace current code rather than carry its assumptions forward.

### 4. Connect water and rivers

- Define an immutable lake descriptor/coverage interface for near water, far terrain shading, river tracing, materials, collision and gameplay queries. Ensure one authoritative water level and one owner in overlapping areas; no stacked or disconnected surfaces.
- Prototype one outlet and one inlet using the current river solver first. Compare lake/river junctions, bank and bed shapes, flow, water level and transitions with the reference. Then test shared lakes, confluences, ponds and large basins. If existing tracing cannot use terrain-native outlets efficiently, investigate a better river representation separately.
- Verify that both modes give the same final lake and compatible rivers for the same seed, including after eviction. Scheduling may differ; the generated water must not. Replace only the portion supported by evidence, and retain a clear fallback for worlds that cannot yet use the new system.

### 5. Streaming, quality and integration

- Prioritize visible and ahead-of-camera work. Slow and medium movement should aim for near-immediate water, around 100 ms or less when possible; startup and a future teleport may tolerate about 1–2 s. These are goals, not promised timings. During fast flight, automatically prefer coherent coarser water when behind and refine later without detached segments or brown beds.
- Expose precompute/on-demand as a world setting, not an automatic planet-size decision. Provide configurable low-/high-end compute, memory and quality budgets. Bound concurrent work, support cancellation of stale requests and deterministic cache invalidation; do not silently trade detail for speed at normal movement.
- Land only after a cold/warm A/B demonstrates improved time and memory at equivalent approved visual quality. Compare terrain tile cost and total frame time as well as water work. Test game startup, movement, river joins and existing worlds. Document what still requires the old planet-wide pass.

## Questions the experiments must answer

- Can a region determine a natural-looking basin, its retention boundary and spill from bounded local data without a global flood? What does it cost when a lake crosses that boundary?
- Can the renderer derive the same shore and water level from terrain-owned data at all LODs, without repeating full basin evaluation per pixel or generating duplicate masks?
- Can rivers obtain a stable outlet early enough without requiring all mountain ponds, and can they meet a lake before either causes terrain regeneration?
- Is the total GPU cost lower on both low- and high-end devices, including when fast travel generates many tiles? What remains resident at 131 km and 1,000 km planet radii?
- What visual or world-layout changes are inherent to a constructed-lake system? Show comparisons before choosing it; do not claim exact preservation without measuring it.
