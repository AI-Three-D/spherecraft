# Lakes and rivers: independent reassessment for Claude

2026-10-11, Europe/Helsinki. This is a new, distilled handoff. Read it before the older handoffs. It incorporates the owner's latest screenshots and correction; older plans, recommendations and isolated prototype approvals are historical evidence, not an approved architecture.

## 1. The central result and the task

**The original terrain-based placement produces the lake shapes the owner wants. The newer regional placement never reproduced that combination of shape and size. The latest attempt is rejected.**

The owner supplied two new screenshots from the original path and explicitly said: “This is how lake shape is supposed to be.” Preserve that result as the visual control. Decide independently whether to repair the original pipeline, use a hybrid, or replace both approaches. Critically question every recommendation in this document, including the previous preference for authoritative regional splines and the hybrid proposed below. Do not spend another session making the rejected basin stamps slightly noisier and calling them equivalent.

The original path remains callable. The normal game still defaults to the rejected regional implementation; this documentation turn does not change runtime defaults. Near Whitewater-derived simulation is also enabled by default, but should be disabled while comparing placement.

This is a shared, heavily modified workspace. Preserve unrelated and inherited changes and historical evidence. No staging, commits, pushes, resets or broad cleanup are requested by this handoff. Follow [AGENTS.md](AGENTS.md). Use owned test processes, run GPU workloads sequentially, and leave the owner's browser and servers alone.

## 2. What the two new screenshots establish

Both screenshots show this URL:

[Original terrain-based world](http://localhost:8181/wizard_game/standalone.html?regionalTerrain=0&regionalBanks=legacy&riverSim=off)

The first shows a broad view of the planet, with prominent, geographically substantial water bodies. The large foreground lake has a long, irregular reach and a shoreline related to the surrounding terrain. Other visible lakes have different outlines and extents. These are not tiny repeated ponds clustered around a feature centre.

The second shows a large lake at a closer landscape scale. Its outline has broad bays, smaller indentations, long narrow peninsulas, projecting headlands, islands and channels around retained high ground. Different shore sections have different character. Existing ridges and roughness continue toward and into the water; the whole lake does not read as a smooth bowl with a painted perimeter. Large-scale shape and smaller shoreline structure coexist.

The first HUD reports orbital rendering at roughly 24 km altitude; the second reports terrain rendering at roughly 4 km. Do not assume every visible body in the first has completed a fine 16 m solve. Identify the active coarse/refined records, masks, orbital/terrain draw path and near/far representation for the reference bodies. The owner accepts the visible shape across those views; reproducing only one expensive fine-planning stage would miss that evidence.

Those characteristics are the shape target. The bright reflection blobs, water colour, current texture quality and every small angular edge in those screenshots are not separately endorsed. Do not attempt to reproduce the glint as part of placement. The earlier river concept additionally requires a channel integrated into a valley, varying banks, exposed stone/sediment and locally rough water, rather than a straight excavated canal.

The two images are attachments in the owner's conversation, not files available in this repository. The existing `handoff-screenshots/` gallery does **not** contain them. Its images named `plain-lake/*-original.png` are dry-terrain controls for a later constructed-lake experiment, not these original natural lakes. If Claude lacks the conversation images, reproduce the original URL and capture comparable broad and closer views before judging a replacement. The textual description here must not become a substitute for inspecting the actual original result.

The owner says the original lakes were 100+ times larger than the largest new ones he saw. Record this as owner feedback, not a measured area or diameter ratio. The exact basins and physical areas in the two screenshots have not been identified or measured. Earlier numerical size claims used a different baseline and do not answer this complaint.

## 3. Requirements that survive the architecture reset

- Preserve broad natural lake shapes, substantial large lakes and a wide size distribution. Small mountain lakes are also needed; there should not be one arbitrary size class everywhere.
- Lakes and rivers must work across the actual planet during gameplay, not just in one selected preview. The owner asked for hundreds or 1,000+ lakes and hundreds of rivers. Counts must be considered alongside wet area, geography and visual quality.
- Mountain placement needs convincing local pockets, sheltered floors and valley settings. Altitude alone does not make a plain into a mountain lake.
- River water elevation must descend coherently. The bed may have pools and local variation. Upstream/downstream joins need a shared shoreline, water level and channel geometry. Historical owner requirements include lake-to-lake/sea rivers without dead ends; any proposal for lake-free headwaters is a product-rule change to discuss explicitly, not an assumed permission.
- Banks must vary independently in width, slope and texture. A constant-width brown rope is rejected. Lake shores also need a suitable material transition.
- Coarse terrain should cover the whole moving view in less than 50 ms, with fast detailed tiles. No existing test proves that target. Tile queue policy was originally outside this session; architecture must nevertheless avoid making it impossible.
- Generating visible terrain dry and then regenerating the same area after water placement caused unacceptable one-to-two-second river arrival delays. Prefer water inputs ready before dependent tile generation.
- **One height-generation pass is a preference, not an absolute law.** A lighter prepass, bounded fuller height generation, or reuse of preliminary heights is allowed when its complete visual benefit justifies its measured cost. This applies to plains and mountains. Do not reject the original approach merely because it samples heights.
- Every change needs actual rendered evidence and complete compute cost in milliseconds, including failures, readbacks, publication, dependent tiles and regeneration. Stable FPS and passing tests do not establish appearance or arrival latency.
- Water rendering and simulation cannot rescue a bad footprint. Runevision erosion is already present; additional erosion must earn its cost. A larger engine change is allowed if justified, but broad terrain character must not be sacrificed without a convincing comparison.

## 4. What the two implementations actually do

### Original terrain-based placement: discover water in the existing landscape

This is the retained `regionalTerrain=0` path, not the obsolete erosion-seed lake-mesh system.

1. `HydrologyGrid.js` samples the existing terrain function on a six-face 512² topology grid, plus precipitation. Each global cell averages four height samples. This is coarse sampling of actual terrain, not the new regional basin-placement mechanism.
2. `waterGraph.js`, through `waterWorkerCore.js`, uses priority flood/depression connectivity, flow accumulation and drainage parents to discover lake bodies and river relationships.
3. `lakeRefine.js` samples a local tangent-plane patch, normally at 16 m spacing, and solves the connected basin and spill level. It grows a patch when needed, refines the lake/outlet and merges bodies that belong together.
4. The lake mask describes where that basin may draw water, including a narrow ambiguous shore band. The visible shore also depends on the actual rendered terrain crossing the water level. Interior high ground remains dry. Lake footprints are not fixed ellipses or radial lobe shapes.
5. Rivers are refined along the graph's downstream route and then supplied to valley/bank/channel shaping. `WaterService` schedules work in the background and caches results. Newly published river/valley data can invalidate existing tiles.

The original lake outline is therefore an interaction between the terrain, selected water level, connected basin and rendering. It is not created by flood fill alone. Preserve and verify all those parts when reusing the solve. The hydrology sampler uses `calculateTerrainHeight`; final tile micro/clamp, interpolation and later river cuts can differ. A successful sample-domain solve is not automatically an exact certificate of rendered containment.

### Latest regional placement: construct bounded water features in selected regions

The normal default uses `regional-macro-v17-scaled-water`.

1. Six persistent 256-cell macro fields provide broad terrain traits, candidate hints and bounds. Sharing immutable inputs and compiled pipelines can reduce repeated work.
2. `planetWaterPlacement.js` chooses canonical supporting regions. Within each attempted region, `regionalShape.js` runs a fuller natural/eroded height bake, reads controls back and plans a basin.
3. Gentle sites receive a bounded cut-only depression driven by `regionalBasinPotential.js`: seeded rotation/aspect/warp, four spatial noise scales and a compact central anchor. Rough sites search natural minima in a smaller field.
4. Accepted controls become a continuous spline used as authoritative terrain inside the region, blended at the boundary. Fine terrain evaluates the ordinary stack outside that support and strongly limits micro detail around the lake proof domain.
5. Spline cell hulls identify a connected guaranteed wet core and a dry retaining boundary. A mixed-resolution atlas carries height controls, ownership, shore influence and water levels.
6. Rivers connect suitable nearby lower lakes using sampled corridors, curved courses, terrain-following profiles and explicit wet shoreline portals. Placement records publish before the first quadtree tiles.

This approach is **not** coarse-data-only placement: it already adds per-candidate supporting height generation, readback and planning. It avoids the legacy dry-first tile regeneration workflow at startup, but the full world precomputation now takes seconds. Nor is its current river system a complete drainage network: it pairs nearby lakes rather than preserving a planet watershed skeleton.

## 5. Comparison: benefits and costs

| Question | Original terrain-based discovery | Latest regional construction |
| --- | --- | --- |
| Lake shape | Owner's chosen reference. Natural connected contours retain bays, branches, peninsulas and islands. | Owner rejected it. The potential/control/support choices often produce rounded or simplified bodies; giant masks and controls also become coarse. |
| Lake scale | Natural basin extent can span broad terrain and cube-face boundaries; local patch size adapts. The referenced largest areas remain unmeasured. | Scale is constrained by supporting regions, fixed control counts, cut budgets and acceptance gates. One numerically large polar lake does not demonstrate the reference distribution or shape. |
| Terrain preservation | Lake placement normally fills an existing depression without manufacturing its dry scenery. Later river shaping can still alter it. | Spline substitution and micro suppression change terrain inside accepted supports; constructed depressions can dominate the outline. |
| Drainage | Global terrain-derived parent paths, flow accumulation, merges and confluences are useful starting information. | Bounded nearby-lake routing is easier to publish, but misses a connected planet drainage skeleton and ocean outlets. |
| Computation | Full height sampling, large/growing patches and serial source/receiver work are expensive. Background work and repeated carving invalidate tiles. | Bounded work and early immutable publication help control dependencies. Many supporting fields, rejected candidates, compilation and atlas publication still cost substantial time. |
| Guarantees | Discrete sampled basin/spill solve; rendered terrain/micro/cuts may disagree. | Stronger continuous bounds for the chosen spline and reserved detail, but conservative checks reject useful sites or force destructive geometry. A proof of containment is not a visual result. |
| Streaming | Terrain can appear before water; late records and refinement can create delayed rivers or changing shores. | Records are ready before initial tiles, but world preparation blocks that startup; all-world persistent data is currently large and paging unfinished. |
| Reuse | Existing worker, solve, terrain sampling, cache and drainage logic remain reusable. | Exact-input foundation/pipeline reuse, lifetime handling, atlas plumbing and publication ordering may be reusable independently of the rejected shape generator. |

The useful question is not “coarse or not coarse.” Both approaches use coarse information. It is **how much terrain-derived basin topology and shoreline structure survives, and what must be computed to publish it early enough**.

## 6. Distilled history: attempts, failures and useful remnants

| Stage | What was tried and what happened | Lesson to carry forward |
| --- | --- | --- |
| Early lake-height/erosion-seed work | Standalone probes, displaced pits and water planes could disagree with final resident heights; some planes were buried or misplaced. That old lake subsystem is not the reference path restored by the URL above. | Use actual resident height/depth diagnostics to verify rendered placement. Do not revive retired pit/verifier code because an old handoff calls it authoritative. |
| Original water graph and natural lake refinement | Terrain samples plus local flood solves produced the broad natural lakes now shown by the owner. Rivers were slow to appear, sometimes moat-like, disconnected, excessively filled/cut, or duplicated. | Lake shape was a success; arrival latency and river construction were not. Separate those findings before abandoning the approach. |
| River/valley and terrain experiments, before October 8 | Curves, confluences, wider channels and valley fields were added. A broader terrain/erosion experiment produced repeated bumps, stripes and spiky mountains and was rolled back. Cut-only bank retreat replaced added embankments/hills. | Do not restore that rejected terrain stack. Existing river data/material and continuity work can be evaluated independently. |
| Integral macro foundation, increments 0–1 | Shared broad terrain inputs remained close enough to the existing terrain for the owner to proceed. Shader/lifetime/binding issues were investigated. | This approval concerned terrain fidelity of the foundation, not the later water architecture. |
| Certified constructed bowls, increments 2–8 | Loose erosion/relief allowances yielded deep cuts and smooth collars; tighter local bounds, shallower cuts and varying bank reach improved an isolated lowland case. Elevated cases often remained tiny ponds on plains rather than mountain pockets. | Do not confuse numerical safety, altitude or a selected prototype's approval with realistic planet placement. |
| Artificial enclosure, increment 9 and reassessment | A local floor/side-hill/headwall recipe made containment easier, but replaced the natural terrain and was rejected as artificial. Sampled lift reached about 113 m. | Parent terrain-generated valleys are a separate possible redesign; decorating arbitrary lake centres with enclosing hills already failed. |
| Eroded spline fields and natural small basins, increments 11–25 | Reused local natural height fields enabled basin proofs, some real rugged ponds, distant depth coverage and bounded audits. Yield/setting filters improved. Small round blips, weak alpine settings and interpolation/detail loss remained. Some optimization attempts were rejected when complete timings showed no gain. | Local shared fields can be useful, but their existence and successful core samples do not prove adequate coast complexity, large extent or general yield. |
| Larger local lake, increments 26–29 | Enlarging a potential region alone produced scattered puddles. Three-lobe depressions then produced a larger but simple lake. A spatial-noise potential improved it and was accepted as a useful fixed prototype. | That roughly half-square-kilometre prototype was never the large original reference shown now. Its approval should not dominate the architecture decision. |
| Organic courses/banks, increments 30–31 | Shoreline portals, curved courses, independent bank extent/noise and existing splat textures improved isolated rivers. A lighter foundation-only height backend saved little complete time and failed a mountain incision test. Equal-width brown strips and smooth geometry persisted in broader views. | Retain useful portals/contracts, but do not assume cheap route heights resolve actual mountains. More shoreline noise cannot fix missing basin topology or a canal setting. |
| Whitewater integration, increment 32 | The solver already existed. Unrestricted mountain SWE drained/spread and saturated foam. A prescribed reference flow with local SWE disturbances, proper clipping and readiness fixed a stable visual path. | This is a driven visual model, not a proven physical global flow. It does not repair bad lake or river placement. |
| Planet coverage/density, increments 33–35 | First coverage was too rare. Reusing each field for up to eight similar depressions reached 1,200 lakes/320 rivers but produced small clusters and insufficient size variation. GPU loss handling and bounded atlas upload improved robustness; the owner's initiating device-loss cause is unknown. | More counted lakes and better publication do not validate appearance. Keep shutdown handling; do not claim it explains or cures every loss. |
| Final v17 attempt | One lake per field, larger tiers, mixed-resolution atlas, warped potential, narrower shore paint, bounded shore noise, trimmed/flared mouths and reduced foam. Default seed: 1,100 lakes/234 rivers. Owner rejected the lake shapes and scale again. | This is failed visual evidence, not a nearly accepted architecture waiting for polish. A numeric giant and reduced clustering did not recover the original landscape. |

Two useful infrastructure results have more credible scope than the placement claims. Exact-source certificate pipeline reuse reduced one unchanged complete ten-output workload from a 220.59 ms median to 136.67 ms. Sharing an unchanged foundation across feature revisions reduced one mountain complete workload from 146.04 to 131.98 ms and a gentle workload from 135.62 to 113.64 ms. These are historical matched workloads, not current world startup or per-river latency. Their lesson is to reuse truly unchanged work, not to prescribe a particular lake shape representation.

Several concrete failures should not be rediscovered: river list overflow previously dropped a passing river and left simulation sampling uncarved terrain; nearest-source ordering missed nearby long reaches; coarse-to-fine lake spill levels disagreed; monotone least-squares levels became staircases; water masks solved before valley cuts flooded neighbouring lowered hollows; and asynchronous shader activation exposed water before its correct draw path was ready. Some were repaired in earlier revisions, so inspect current code before assuming they remain. Their common lesson is to check ownership, version, actual final height and downstream dependencies end to end.

## 7. Quantitative evidence, with the correct baselines

Three different things have been called “old”: the original terrain-discovered lakes, the preceding regional population, and the accepted fixed organic prototype. They are not interchangeable.

| Observation | Original non-regional path | Preceding regional population | Latest v17 regional population |
| --- | --- | --- | --- |
| Recorded default-seed population | 614 lakes, 106 graph rivers | 1,200 lakes, 320 rivers | 1,100 lakes, 234 rivers |
| Maximum positive depth-mask area | **Not established for the owner's reference lakes** | 0.70281 km² | 151.38117 km² |
| Median positive depth-mask area | Not measured in a comparable whole-world audit | 0.00742 km² | 0.01556 km² |
| Lakes with another centre within 1 km | Not measured | 877 | 0 |
| Browser water-ready observation | 51.81 s | 16.26 s | 26.44 s |
| Browser loader-complete observation | 33.60 s, timeout fallback | 20.71 s | 72.53 s, timeout fallback |

Population numbers identify one seed/run, not a universal distribution. The original path had different counts in older versions. The current original-path smoke test verifies the retained mechanism, not a controlled performance ranking. It recorded no page or uncaptured GPU errors. Its lake-0 refinement was 7.91 km². The harness incorrectly sorted a nonexistent `cells` property and labeled that lake “largest”; **that is not an original maximum**. Original records use `cellCount`. Also, a coarse `cellCount` ranking still requires refined-area verification. The nighttime image from that smoke run is not one of the owner's two reference screenshots.

The prior statement “215× larger” compares the two **regional** maximum mask areas, 0.703 to 151.381 km². It says nothing about reproducing the original natural lakes. The owner's latest images and rejection supersede any suggestion that this met the scale/shape requirement. v17 has only one accepted giant and eight large lakes; most bodies remain small/medium. The giant is snowy/polar and has no river under the current 6 km centre-distance pairing limit.

Corrected final native measurements on the local M1 Pro/32 GiB/Dawn Metal setup:

- World preparation: **16,240.92 ms**, plus **533.45 ms** water publication. No low-end-machine result exists.
- First fine tile: **568.41 ms** with existing driver caches; subsequent sampled core tiles approximately **7.56–20.76 ms**. These are wall times through completion, not a guarantee for arbitrary tiles or an isolated GPU timestamp.
- Matched shore tile, eight warm samples per variant: added lake detail **9.45 ms** median versus **8.77 ms** disabled. Observed difference about **0.68 ms**, with substantial variability. It visibly fails the overall shape target despite measurable height changes.
- Declared persistent generation/mask/water payload: about **330.85 MB**, versus **224.34 MB** for the preceding regional implementation. This excludes the rest of the game and private driver/compiler memory. One 256-pixel mask slot size is applied to every lake because of the largest bodies; mixed-size packing is unfinished.
- Eleven final settled views take **1.35–10.64 s** after camera changes. Full scene render/fence medians **13.70–24.75 ms** are settled costs, not first-visible or fast-flight costs. Different worlds/features/cameras prevent a causal speedup comparison.

Older original-path logs report lake refinement around 2.5 s and long river refinement around 2–13 s; one later baseline recorded complete river calls at 3.09/3.78 s, including dependent lake work. These are different historical workloads. Do not claim every flood takes seconds: smaller fixed-patch solves can take milliseconds, and height evaluation/dependencies may dominate.

The owner's original screenshots show roughly 57–59 FPS at their captured views, while rejected newer screenshots include much lower rates. Different altitude, visible terrain, simulation flags, loading state and lighting prevent attributing that difference to placement alone. Likewise, good static FPS does not meet the moving-view 50 ms requirement.

Important evidence exclusions:

- Earlier native fine benchmarks used nonexistent `gpu.carveResources` instead of `gpu.resources`, omitting production river bindings. Use corrected `water-final-attempt/native/` and `detail-disabled/` for the final fine comparison. Older population/publication results and actual browser captures have separate provenance.
- Early float buffers were saved as byte elements: 16,384-byte files are not valid 128² f32 height arrays. Correct arrays are 65,536 bytes. Excluded attempts remain archived.
- A 16 m world river-profile trial required about 1.178 million repeated indexed segments and exceeded capacity. The 32 m final route profile reduces this to roughly 590,000. This is not proof of acceptable route detail.
- Tests, complete residency and sampled wet-channel checks are not visual approval or continuous correctness for every river bank. Initial loader “complete” can mean timeout, not successful stable readiness.

## 8. Why the regional attempts likely lost the desired shape

Separate source-confirmed limitations from hypotheses about the screenshots.

**Confirmed design restrictions:** lake candidates and maximum supports are tied to canonical regions; gentle terrain receives a deliberately constructed compact potential; ordinary multiple-lake regions stamped several similar depressions; large supports use only fixed 256-cell controls/masks; the spline replaces finer terrain structure; local micro is strongly suppressed to fit the proof budget; continuous containment and inherited root-bound gates filter the result. The largest mask has roughly 131 m spacing. A 7 m noise function cannot restore missing 7 m geometry if the representation and mesh never resolve it.

**Likely consequence, requiring matched decomposition:** an outline dominated by a smooth potential and smoothed supporting field will have fewer terrain-correlated branches, narrow necks and retained islands than the original level-set basin. Bounded fine noise changes a contour locally but does not supply a missing broad floor/spill topology. Increasing cut depth or nominal radius can increase area while retaining a poor shape. Rendering/mask/LOD disagreement can additionally create crude edges or triangular clipping; not every bad edge is a placement algorithm failure.

**Confirmed overconservatism in some gates:** early allowances forced tens or hundreds of metres of excavation in unsuitable cases. Current `regionalShape.js` compares the minimum control height over a region against the maximum inherited root lower bound over that region; separated low and high places can reject an otherwise locally compatible field. Do not simply delete this check: it protects terrain consumers. Test spatially local bounds or regenerated bounds alongside any new representation.

**Important counterpoint:** a spline, regional hierarchy, conservative bound or coarse route is not inherently incapable of organic lakes. The failed combination and resolution policy are what the evidence rejects. Claude must investigate whether representation, constructed landform, selection, level, support, ownership or rendering is dominant before committing to an expensive replacement. Previous handoffs sometimes promoted the shared-field architecture more strongly than the visual results justified.

## 9. Alternatives to challenge before choosing

| Alternative | Potential return | Main objection / required disproof test |
| --- | --- | --- |
| Repair the original terrain-based pipeline | Keeps the demonstrated shape mechanism and existing terrain; most direct reference baseline. Batch/reuse heights, improve dependency order and precompute stable records before needed tiles. | Height sampling and large/refined patches may still be too slow; moving publication earlier may just move seconds of work into startup. Measure full readiness, not only the worker flood. |
| Hybrid: terrain-derived topology, stable early records, selective fine shoreline work | Keeps real basin contours and drainage while using coarse hints to limit expensive work. Could share boundary/saddle data and height work across nearby features. | “Hybrid” is not an algorithm. It can become two conflicting terrains, duplicate full evaluation, or change levels late. Specify final-height agreement, residual/error policy, growth limits, reuse and publication before building it. |
| Redesigned integral terrain/meso hierarchy | A genuinely shared height model could serve lake discovery, routes, bounds and fine tiles without repeating expensive terms. Adapt resolution where critical saddles and shore detail need it. | The latest spline attempt already tried this and lost the target. Demonstrate original terrain/shore fidelity and actual removed work first. Multi-page large bodies, halos, memory and lifetime may cost more than analytic terrain. |
| New parent landform/drainage generation | Terrain could generate coherent basins, sills and valleys from the outset, with water using known topology rather than blind discovery. | This is a substantial terrain redesign, not a quick lake fix. Risk of generic synthetic scenery and losing the established terrain. Do not repeat the rejected added-hill enclosure under another name. |

**Suggested first comparison, not a predetermined winner:** retain the original terrain and lake solve, isolate its expensive discovery/refinement/publication stages, and test bounded batching/reuse or a topology-preserving hybrid against it. Give Claude permission to reject this suggestion if measured bottlenecks or shape fidelity favour another design.

Possible inexpensive experiments include reusing a solved depression graph for multiple seeds, refining ambiguous boundary/saddle cells rather than an entire expanded rectangle, grouping GPU sampling/readbacks, and caching deterministic world-generation records with complete source/config keys. A queue-based depression-fill improvement may help only if heap work is actually significant. GPU flooding, huge global fine height atlases and erosion simulation are not automatic upgrades.

Precomputation during world creation or persistent caching may be a valid solution for a deterministic planet. It must have an honest cold creation/load cost and bounded storage; cache hits cannot conceal an unusable new-world path. Retaining generated heights may save repeats, but using camera-dependent render residency as the sole placement authority risks LOD-dependent lakes. Resident textures are valuable validation and possibly deliberate reuse inputs, not categorically forbidden caches.

A common basin/outlet/channel record format is a useful proposal. **Identical discovery algorithms for plains and mountains are not a requirement.** Separate candidate strategies or fast paths may be justified if they preserve common final heights, drainage ownership and rendering. Challenge the earlier architectural insistence on uniform processing rather than accepting it as doctrine.

## 10. How to recover the reference shape

First determine how the original reference basins are produced: which source terrain terms, chosen level, connected component, mask band, spill saddle and mesh/depth crossings supply each visible bay or island. Compare original terrain, potential modification, spline replacement, wet mask and actual rendered water separately. Use the original path's real lake identities and saved camera poses; do not substitute a convenient tiny control.

For a terrain-preserving experiment, treat a lake as a **connected sublevel set of the final terrain at one admissible water level**, restricted to its basin rather than every distant point below that level. Preserve its interior high ground. Discover enough enclosing/saddle topology to choose that level, and let the terrain provide broad branches and peninsulas. Fine shore noise and material variation follow that structure; they should not generate the whole lake outline independently.

Large bodies must be able to cross generation pages/regions and cube-face seams under one stable identity and level. A single region should be a work/storage unit, not the maximum possible lake shape. Resolve nested/adjacent basins and shared sills rather than scattering one guaranteed body per unrelated region. Density and maximum-area rules should select suitable basins, not force a target count of similar holes.

Avoid blindly baking the entire planet at 16 m: for radius 131,072 m, even surface-area arithmetic gives about 3.14 GiB for one f32 height channel before layout/halos/topology overhead. Adaptive or paged work is necessary. Conversely, a giant fixed 256² patch is not a universal shoreline representation. Keep enough information at narrow necks, islands and spill channels; storage compression and coarse render LOD must not silently erase them.

A broad wet footprint and level should be stable before dependent visible tiles. Fine refinement may improve representation, bed detail and near geometry within a declared error band. If it changes the actual lake level or connected component, that is a placement change: account for tile invalidation and visible popping explicitly. Do not promise both exact fine topology and zero preparation without explaining the tradeoff.

## 11. Mountain lakes, rivers and shore treatment

For mountain lakes, look for real local floor/enclosure/spill relationships in the existing terrain. A global roughly 300–400 m sampling grid can miss a small pocket, so allocate finer candidate/boundary work where there is supporting evidence. Relief or altitude labels alone are insufficient. Permit small elongated shelf/valley lakes and occasional larger wide-floor lakes. A below-spill level can reduce required basin extent for a closed pond; a lake feeding a river still needs a feasible outlet to that level. Do not generate every lake at maximum flood extent or place one on every mountain flank.

If natural pockets remain too rare, test terrain generation that creates a floor/sill/valley as part of the surrounding mountain system. Its shape and erosion must belong to that parent system. Keep the older artificial-enclosure failure as a negative control. Do not add unconnected decorative side hills simply to pass containment.

For rivers, higher-to-lower coarse regions are useful routing hints but do not describe saddles, cross slopes, exact lake exits or fine obstacles. Prefer a terrain-derived drainage skeleton, then refine only the corridors/outlets that need it. Keep explicit source/destination portals and a shared level/bed/coverage contract through lake mouths and confluences. The present giant cannot connect under centre-radius/distance exclusions; extending that radius test is not a substitute for shoreline-based topology. Ocean outlets also need actual downstream ownership.

Assess incision and fill along the entire widened mouth and bank zone, not only the centreline. A smoothly descending water profile is separate from variable bed depth. Avoid reproducing the old monotone-fit staircase, slow “lava” flow, sudden outlet drops and high embankments. Course curvature and width should respond to valley support; smoothing a shortest grid line and adding lateral noise can still yield a canal.

Once geometry and placement pass, bank materials should respond to height above water, slope, exposure/deposition, side of bend and spatially varying terrain. Some sections should have broad gravel/sediment areas, others steep rocky or vegetated banks. Neither a constant distance strip nor uniformly reduced brown opacity is sufficient. Existing splat textures, local relief and selected rocks may have higher return than another whole-field Runevision pass. Compare them in milliseconds. Geometry stones, near normals and flat colour are different interventions and should be measured separately.

## 12. Simulation and rendering: preserve useful work, question the model

The far terrain-water path and nearby level geometry already exist. They should consume the same level/ownership/depth as terrain carving. Inspect near/far handover, conservative mask clipping, resident mesh resolution and actual water/ground depth separately. Stable tile residency does not guarantee a correct shoreline.

The local Whitewater-derived solver was already ported; another wholesale port is not the immediate task. `../whitewater/js/shaders.js`, `sim.js` and `config/simulation.js` are the reference. SphereCraft's active local strip uses semi-Lagrangian velocity advection, donor-limited height flux, pressure/friction, turbulence and foam, with a prescribed reference flow and residual SWE dynamics.

Unrestricted mountain trials failed even with a sampled carved bed: the prescribed geometric surface/bed/discharge were not a hydraulic equilibrium. One trial had roughly 12 m design depth, about 13.5 m evolved surface deviation and near-saturated foam. Reference balancing/clipping made it stable, but externally driven flow, omitted strip-curvature terms, large inferred discharge and hidden wet strip areas remain reasons for scrutiny. In particular, reference depth must correspond to the **visible channel**, not just a large rectangle rendered invisible at its banks.

Historical solver GPU timestamps for two/four steps were about 0.328/0.590 ms on a gentle strip and 0.197/0.393 ms on a mountain strip. Initial native complete placement requests were about 131–132 ms versus warm 4–6 ms; shader/readiness costs matter. These are old local workloads, not new planet placement measurements. Keep the working fallback while testing placement. Physics correctness, foam aesthetics and robust activation need their own later tests.

## 13. Suggested sequence and criteria for stopping an unproductive approach

1. **Independent read-only audit and criticism.** Verify both live paths and the source map below. List strongest objections to each architecture and to this document's hypotheses. Identify what is source-confirmed, measured, owner-assessed or unknown. Do not start by optimizing the rejected default.
2. **Recover representative controls.** Identify and capture the original large lake(s), one medium lake, natural island/peninsula shore, a real mountain pocket, and gentle/steep river reaches. Save IDs, seed/config, poses, lighting, LOD and stage coverage. Measure actual wet area, extent, depth, connectivity and outlet roles. The two owner screenshots define the positive target; rejected bowls/canals are negative controls.
3. **Measure the original complete workload.** Split terrain sampling, transfer/readback, solve/topology, source/receiver dependencies, route work, publication and dependent tile regeneration. Profile cold and warm costs. Find whether flooding, terrain evaluation, patch growth or invalidation actually dominates before choosing an optimization.
4. **Run the smallest discriminating comparison.** Compare at least a repaired-original or topology-preserving candidate and one credible alternative on equivalent content. Preserve broad original contours and dry terrain. Charge failed candidates and all dependent work. If extra supporting height work wins on quality/cost, use it; if spline reuse loses detail or savings, reject it.
5. **Establish early publication on a short real-game itinerary.** Measure first coarse coverage during fast movement, first visible water, high-resolution arrival, regeneration and resource peaks. Do not count a settled screenshot as the 50 ms test. Keep queue-policy changes separate unless the chosen dependency model makes a specific change necessary and reviewable.
6. **Scale only after the representative shape survives.** Expand across pages/faces, terrain types and multiple seeds. Evaluate size distribution, maximum/reference areas, failed-site yield, lake merges, river routing and seams. Counts alone do not pass this stage.
7. **Then improve banks and local water.** Use the recovered topology/geometry as the basis for splat materials, stone detail and the existing local simulation.

Stop an approach when its representative large lake loses the original branches/islands, when mountain “success” remains a high plain, when acceptable shape requires destructive terrain replacement, or when complete preparation/arrival/memory cannot meet the game's needs. Do not spend weeks polishing around an architectural loss. A failed comparison is useful evidence and can justify restoring the original or selecting a different model.

## 14. Measurement discipline

For each comparison save the source/config key and served-source hashes; seed, planet radius and height scale; feature IDs; physical extents and resolution; tile-address/output union; camera trajectory and lighting; cold/warm/reuse state; exact timer boundaries and CPU/GPU method; all samples and failed sites; live/peak/replacement-overlap memory; actual images; and the owner's verdict.

Compare water area from connected wet coverage, not bounding circles or nominal radius. Distinguish area from linear extent. Include an aerial whole-body view, closer shore view and river joins. Match scene content and residency as far as possible; when terrain intentionally changes, say what changed and why the costs are comparable. Separate full render/fence wall time from GPU timestamps and first-visible latency from data-ready timestamps.

Validate against final resident terrain textures and mesh/depth where they render, as well as the planning model. Include islands, narrow necks, dry escape routes, junctions, fine micro and cross-LOD cases. If claiming a continuous bound, prove the specific evaluator/residual it covers; finite samples alone do not prove it. Conversely, do not force huge global safety allowances into the shape just to claim a proof stronger than the product needs.

Existing 345 tests/54 files passed in the final attempt; comparison-control changes passed 16 targeted tests. Those are historical validation, not new work in this documentation turn and not evidence that the lakes look right. Re-run checks appropriate to actual future changes, and preserve invalid reports with clear exclusion notes. Never overwrite evidence directories for a new trial.

## 15. Source and evidence map

| Responsibility | Start here |
| --- | --- |
| Original sampling, worker, natural basin solve and cache | [HydrologyGrid.js](core/world/hydrology/HydrologyGrid.js), [WaterService.js](core/world/hydrology/WaterService.js), [waterGraph.js](core/world/hydrology/waterGraph.js), [waterWorkerCore.js](core/world/hydrology/waterWorkerCore.js), [lakeRefine.js](core/world/hydrology/lakeRefine.js), [waterCache.js](core/world/hydrology/waterCache.js) |
| Original river route/refinement and shared shaping | [riverRefine.js](core/world/hydrology/riverRefine.js), [riverLandscape.js](core/world/hydrology/riverLandscape.js), [riverCarve.wgsl.js](core/world/water/riverCarve.wgsl.js), [riverValley.js](core/world/water/riverValley.js) |
| Rejected regional selection, controls, proofs and routes | [planetWaterPlacement.js](core/world/terrain-generator/planetWaterPlacement.js), [regionalShape.js](core/world/terrain-generator/regionalShape.js), [regionalShapeModel.js](core/world/terrain-generator/regionalShapeModel.js), [regionalBasinPotential.js](core/world/terrain-generator/regionalBasinPotential.js), [regionalDepression.js](core/world/terrain-generator/regionalDepression.js), [regionalDrainage.js](core/world/terrain-generator/regionalDrainage.js) |
| Shared foundation and lifetime/publication | [regionalTerrain.js](core/world/terrain-generator/regionalTerrain.js), [regionalTerrainFoundation.js](core/world/terrain-generator/regionalTerrainFoundation.js), [regionalShape.wgsl.js](core/world/terrain-generator/regionalShape.wgsl.js), [regionalWater.js](core/world/hydrology/regionalWater.js), [gameEngine.js](wizard_game/gameEngine.js) |
| Actual base-height substitution and final terrain outputs | [earthLikeBase.wgsl.js](templates/terrain-shaders/base/earthLikeBase.wgsl.js), [advancedTerrainCompute.wgsl.js](core/world/shaders/webgpu/advancedTerrainCompute.wgsl.js) |
| Water data, materials, meshes and local simulation | [WaterGpuData.js](core/world/water/WaterGpuData.js), [waterWgsl.js](core/world/water/waterWgsl.js), [surfaceCommon.wgsl.js](templates/terrain-shaders/surfaceCommon.wgsl.js), [NearWaterRenderer.js](core/renderer/water/NearWaterRenderer.js), [WaterRiverSim.js](core/world/water/WaterRiverSim.js), [ShallowWaterSim.js](core/world/water/ShallowWaterSim.js), [shallowWaterSim.wgsl.js](core/world/water/shallowWaterSim.wgsl.js) |
| Runtime switches and actual tile dependencies | [standalone.html](wizard_game/standalone.html), [runtimeConfigs.js](wizard_game/runtimeConfigs.js), [webgpuTerrainGenerator.js](core/world/webgpuTerrainGenerator.js), [tileStreamer.js](core/world/quadtree/tileStreamer.js), [GPUQuadtreeTerrain.js](core/world/quadtree/GPUQuadtreeTerrain.js) |

Useful live diagnostics after the original graph is ready:

```js
qtDiag.water.stats();
qtDiag.water.near(10);
qtDiag.water.goto(lakeId, 300); // lakeId from near() or waterService.lakes
qtDiag.water.carve();
qtDiag.water.tint(3);          // depth; restore tint(0) for visual assessment
qtDiag.regional.camera();     // capture a manual pose
```

`flyToLake()` belongs to an older ready-lake-mesh path; use the active `qtDiag.water.goto()` diagnostic here. For original lake inventories inspect `gameEngine.waterService.lakes`; `cellCount` is coarse count, not final water area. `gameEngine.waterService.refined.get(id).areaM2` describes a successful refined solve, not every unrefined lake.

Evidence to consult without inheriting its conclusions:

- [Latest rejected images and matched regional measurements](tools/perf/structured-terrain-results/water-final-attempt/index.html), [raw final measurements](tools/perf/structured-terrain-results/water-final-attempt/measurements.json), [corrected native report](tools/perf/structured-terrain-results/water-final-attempt/native/report.json).
- [Original-path smoke report](tools/perf/structured-terrain-results/water-final-attempt/original-planet-preview/browser.json): mechanism/counts verified, maximum-lake label invalid as explained above.
- [Historical evidence catalogue](tools/perf/structured-terrain-results/EVIDENCE_INDEX.md), [measurement ledger](tools/perf/structured-terrain-results/MEASUREMENTS.md), [representative rejected/control gallery](tools/perf/structured-terrain-results/handoff-screenshots/index.html).
- [Natural-basin/architecture reassessment](STRUCTURED_TERRAIN_LAKE_REASSESSMENT.md), [height-contract audit](STRUCTURED_TERRAIN_HEIGHT_AUDIT.md), [organic lake analysis](STRUCTURED_TERRAIN_ORGANIC_WATER_ANALYSIS.md), [course/height/publication analysis](STRUCTURED_TERRAIN_REGIONAL_FLOW_ANALYSIS.md).
- [All Whitewater integration failures and measurements](tools/perf/structured-terrain-results/whitewater-near/README.md), [GPU loss/atlas work](tools/perf/structured-terrain-results/planet-water-device-loss/README.md).
- [Original water history](WATER_HANDOFF.md), [rollback/status history](WATER_STATUS_HANDOFF.md), [near geometry history](WATER_GEOMETRY_HANDOFF.md), [structured chronological history](STRUCTURED_TERRAIN_WATER_HANDOFF.md), [previous final-attempt handoff](CLAUDE_TERRAIN_WATER_HANDOFF.md). Their old requirements, versions, permissions and success labels can be obsolete; latest owner direction and current code take precedence.

Partial `sources/before` archives in the final-attempt folder restore a preceding regional version, not the original non-regional terrain-based world. Do not use that archive as the original visual baseline. Normal game defaults remain rejected until deliberately changed after a demonstrated replacement. Start work with [the independent-review prompt](CLAUDE_LAKE_RIVER_START_PROMPT.md).
