> **Latest state, 2026-10-11:** The owner rejected live planet quality and requested a final attempt followed by Claude taking over. Read [CLAUDE_TERRAIN_WATER_HANDOFF.md](CLAUDE_TERRAIN_WATER_HANDOFF.md) first. Earlier isolated-preview approvals are superseded. Native fine timings using the nonexistent `gpu.carveResources` property omitted river carving bindings; use the corrected final-attempt measurements for production fine performance. Historical reports remain preserved.

# SphereCraft: structured terrain, guaranteed basins, and coarse drainage

Handoff and working plan, updated 2026-10-11 through increment 35. Start with the background below, then the current position, proposed alternatives, screenshots and measurement ledger. The chronological session records preserve the experiments; their earlier approvals apply only to those revisions and prototype scopes.

SphereCraft generates a procedural planet through a WebGPU terrain stack and streamed quadtree LODs. The owner has already spent substantial effort getting the terrain's appearance and generation costs into a workable state. Water now needs to fit that landscape: convincing large lakes on suitable gentle terrain, smaller lakes in mountain pockets, and rivers descending from high elevations through channels, rapids and waterfalls. The goal is excellent terrain/water placement and geometry on lower-end machines, with coarse terrain appearing almost immediately and detailed tiles catching up quickly even during fast travel. Preserving the established terrain features and visual character is part of that goal.

This work began because the existing water pipeline discovers suitable terrain by sampling heights, solving lake extents and refining river routes, then supplying carving data. Its complete cost can be much larger than the final carve or bank stage suggests. In the recorded 256-cell baseline survey, two complete river-refinement calls took about **3.09 and 3.78 seconds**, including their required lake work; these are historical measurements of that workload, not timings of the latest prototypes. Repeated expensive terrain queries and subsequent terrain invalidations work against streaming latency. The task is therefore architectural as well as visual: make useful regional knowledge available to terrain generation and water placement together. Those complete timings do not establish that every terrain probe or flood is intrinsically too expensive. Later fixed-patch diagnostics measured sampling/readback and bounded floods in milliseconds on this machine, keeping local supporting-height approaches worth comparing; those substage measurements are not complete production placement costs. [Baseline data](tools/perf/structured-terrain-results/benchmark-256.json), [bounded-patch investigation](tools/perf/structured-terrain-results/lake-reassessment/diagnostic.json), [complete-cost ledger](#measurement-and-comparison-evidence-ledger).

The owner's central idea is to generate persistent coarse terrain inputs with regional properties already attached. Those inputs can describe base elevation, relief, conservative height bounds and eventually basin suitability, spill levels, outlets and drainage connections. Finer terrain consumes the same regional data when it generates heights, materials and normals; water uses it to choose and describe features. A basin can then be formed as part of the height field, as other terrain features are. This is an integral terrain hierarchy: an observational cache of finished render tiles or an unrelated water-placement system would leave the central dependency problem unresolved. Generation inputs need stable ownership and lifetime even when ordinary render tiles change LOD or leave memory.

Conservative minima were proposed because a lake should not require a blind, expensive search followed by an arbitrarily deep hole. But a low point alone does not establish a basin: water may escape along a slope, and later erosion or detail may change the shore or retaining ground. We need enough information to establish a substantial connected wet interior, a retaining boundary and any explicit outlet, including the effects of fine terrain. Bounds that are mathematically safe but excessively loose can force visually destructive cuts or reject useful natural pockets. The engineering problem is to tighten or structure that information at a reasonable cost while retaining natural terrain variation. A correct containment proof is necessary where claimed, but it is not proof of a good-looking lake. [Height-contract derivations](STRUCTURED_TERRAIN_HEIGHT_AUDIT.md).

The intended model should work across terrain types rather than accumulate a separate generator for each lake style. Lake size and placement effort should follow the available floor, enclosure and relief. Broad gentle areas and wide valley floors can support larger lakes; rugged areas can favour small ponds and rarer accepted sites. Cheap plateau lakes can be more common, and expensive mountain cases can be less frequent. Humidity and other suitability traits may help choose among usable sites. These compromises are deliberate ways to spend less work for better overall scenery; we do not need a lake on every mountain flank or a river leaving every pond. Manufactured hills around an arbitrary lake location have already been tried and rejected. [Placement reassessment and its diagnostic data](STRUCTURED_TERRAIN_LAKE_REASSESSMENT.md).

The owner's old game screenshot establishes the plains-lake visual target: a broad water body with bays, narrow peninsulas, islands and irregular smaller inlets, with existing terrain detail reaching the shore. Large bounding radii and smooth blobs do not meet it. Rivers likewise need changing direction and width, independent irregular banks and detail at several spatial scales. The current straight strips, smooth deep trenches, bulb-like lake joins and visible surface transitions fail that target. A coarse drainage route should guide the visible course, and carving may make a canyon where natural flow alone would not connect regions. Downstream water elevation must descend coherently; the bed may have pools and local rises independently. Steep drops should come from a plausible descent and stay local to the watercourse.

One terrain-generation chain after coarse planning is the owner's **preference, not an absolute requirement**. A specialized or simplified supporting height pass, a fuller natural-height field, or additional height generation can be the better choice if it produces substantially better placement and visuals for an acceptable complete cost. That permission applies to plains as well as mountains. Reusing macro or meso data in finer tiles is another possible benefit: preliminary work might replace repeated noise evaluation instead of merely adding to it. Interpolation, texture reads, gradients, halos, residency and synchronization can also erase the saving or alter terrain character. All such choices remain open; neither fewer passes nor a shared field is inherently the winner. Compare equivalent visual content before adopting tiers or spending supposed savings on richer terrain.

Water also needs a practical distance split. Simplified terrain-shader water is acceptable far away and should become visible early; near the camera, proper surface geometry must align with the generated bed, shore and lake/river junctions. Both representations need consistent levels and ownership so refinement does not expose gaps, floating sheets or abrupt joins. The owner intends to use the Whitewater game's shallow water equations later for water motion and geometry displacement. Current work must first solve placement, carving, downhill slope and surface coverage; foam, simulation and water textures cannot repair incorrect banks or disconnected geometry. Broader terrain richness and erosion-quality improvements are deferred, although necessary changes anywhere in the engine, compute pipeline or quadtree are allowed.

The guiding decision rule is return on compute: spend milliseconds only when they buy a notable visual or architectural benefit. The preferred complete generation cost is around or below **50 ms per river**, with **60–80 ms** potentially acceptable for substantial quality. Charge shared preparation, unsuccessful placement attempts, height sampling, water publication, fine terrain and queue waits; report regeneration and memory overlap as well. First visible coarse water, detailed catch-up and actual fast-motion behaviour matter alongside warm benchmark medians. Every experiment needs its hypothesis, confidence, disproof criteria, complete measurements and actual before/after renders recorded here, including failed or inconclusive results. The next agent should challenge the present approach when evidence warrants it, rather than continue it because many increments have already been invested.

## Current position and how to use this handoff

**Latest issue (increment 35):** owner saw a blank game before any terrain with WebGPU instance loss. A controlled shutdown of an owned browser GPU process reproduces the exact error; shared loss state now stops render/terrain work and handles pending promise failures, with a tested reload control. Lake-atlas publication uses bounded uploads (148.80 MB single upload →4.39 MB batch inputs), destroys61.12 MB accepted regional GPU images earlier, and removes the full CPU atlas allocation.1200 lakes/320 rivers, published atlas texels and sampled heights are unchanged.344 tests pass; startup/forced-loss/reload and five visual cases pass. **The cause of the original spontaneous browser/driver shutdown is unconfirmed**; complete-game estimated GPU payload remains about1.66 GB. [Increment35 evidence and limits](tools/perf/structured-terrain-results/planet-water-device-loss/README.md).

**Latest owner instruction (increment 34):** the live planet is too sparse; the owner wants roughly 1000+ lakes and hundreds of rivers. Normal defaults now produce **1200 certified lakes and 320 organic river connections** across six faces (alternate seed7:1133/320). Multiple basins reuse each supporting eroded field and cell hulls. A geometry-only farthest-site order spreads the fields; river receivers are existing lower certified lakes. All lake masks are resident in tiled array layers, and placement respects the two-lake coarse lookup capacity. Native regional preparation is about7.3s, with no water-triggered terrain regeneration during travel. This remains bounded startup population, without global paging, ocean routing or proof of <50ms movement readiness. [Increment34 evidence and limits](tools/perf/structured-terrain-results/planet-water-density/README.md).


**The owner rejected comparisons through increment 28, accepted increment 29's broad organic lake, accepted increment 31's bank direction as sufficient, and now authorizes nearby Whitewater flow/displacement.** Work through increment 28 provides integral macro inputs/bounds, experimental regional shape and basin proofs, opt-in plains/mountain cases, a descending channel/fall profile, LOD/render fixes and safer input sharing. These establish useful pieces and comparison baselines; general feature paging, realistic close riverbanks and lower-end streaming readiness remain unfinished. The unchanged-foundation experiment measured complete ten-output warm medians **146.0 -> 132.0 ms** with identical outputs; that is a regeneration improvement, not proof that the overall placement architecture or cold startup is solved. [Detailed measurements and limits](#measurement-and-comparison-evidence-ledger).

The current dense eroded-shape prepass is one candidate to compare with coarse-only and specialized supporting fields. Its existence is allowed; it has not established a universal winning quality/cost tradeoff. The [latest direction and alternatives](#latest-direction-october-10-quality-rejection-generation-preference-and-measured-alternatives) distinguish implemented behaviour from proposed replacements. The documentation-only phase below is historical: **the latest owner explicitly authorizes deep analysis followed by small measured implementation increments.** [Increment 29](#increment-29-first-organic-lake-potential-and-preview-module-repair) adds the now-accepted spatial basin potential at the existing plains site. Estimated wet area grows 0.187 → 0.527 km²; two alternating complete 23-output comparisons observe +2.6–5.6 ms, with unchanged tracked GPU peak. Close shoreline still needs polishing. [Increment 30](#increment-30-common-course-light-height-comparison-and-first-tile-water-publication) adds a bounded curved course, variable nominal width, wet-mask source portals and a startup publication repair. Complete matched 11-output medians coarse/natural-organic/light-organic are 161.795/162.066/161.255 ms with overlapping ranges; no speedup is established. Light heights fail the mountain incision budget, so natural guidance remains default. [Increment 31](#increment-31-independent-banks-shoreline-materials-and-measured-cleanup) adds independent shore displacement, variable 1–45 m bank footprints, bounded spatial relief and existing shore splat materials; the post-lighting brown strip is removed in the new mode. Final fine-output medians add 1.93 ms gentle / 4.24 ms mountain per ten tiles. Complete warm medians are 157.958→165.106 / 135.419→139.551 ms with overlapping ranges; no speedup or 50 ms moving-view result follows. Close rock repetition and some smooth faces remain. [Current bank gallery](http://localhost:8181/tools/perf/structured-terrain-results/organic-banks/index.html), [bank measurements/limits](tools/perf/structured-terrain-results/organic-banks/README.md). [Current flow/height analysis](STRUCTURED_TERRAIN_REGIONAL_FLOW_ANALYSIS.md), [actual river gallery](http://localhost:8181/tools/perf/structured-terrain-results/organic-course/index.html).

**Latest generation constraint:** the earlier normal-tiles-then-water-tiles workflow caused rivers to arrive one or two seconds late. Do not run the complete terrain-tile stack twice for placement. Prefer no repeated height work, or a lighter bounded supporting compute where complete ROI justifies it. Supporting heights are allowed; finished terrain outputs must consume water on their first generation. Increment 30's actual startup probe found four coarse calls with empty water buffers and a following invalidation; early structured GPU publication now gives zero unready calls or river invalidations in the gentle and mountain probes. This is a necessary ordering fix, not a 50 ms view result.

The owner's latest latency requirement is **the whole coarse view in less than 50 ms during fast movement**, with high-resolution tiles following quickly. Earlier per-river budgets below are historical planning targets and do not substitute for this view-level requirement. Tile queuing is explicitly outside this session. No fast-motion readiness result has been established. The latest owner preview failed with a missing `setRegionalTerrain` method; controlled mixed-module reproduction and versioned imports now verify the exact candidate URL without page/GPU errors. This fixes the reproducible module mismatch, not placement quality or streaming.

Start visual review with [the 31-image screenshot collection and source notes](tools/perf/structured-terrain-results/handoff-screenshots/README.md) or [its local gallery](http://localhost:8181/tools/perf/structured-terrain-results/handoff-screenshots/index.html). The [evidence ledger](#measurement-and-comparison-evidence-ledger) links decisions to complete-cost records, and the full catalogue retains all measurements, images and failure cases. The original broad-lake and concept references supplied only in chat are described here but are not local image files. Earlier prototype acceptance and passing tests must not be read as acceptance of the current results.

Continue from the current **uncommitted working tree**, including its rollback and unrelated edits. HEAD alone is not the accepted baseline. The normal game now enables bounded planet-wide structured placement and organic banks; the rejected enclosing-hill/global terrain experiments remain off. Preserve an independently usable baseline, work in small increments, and obtain the owner's visual assessment before building the next terrain-changing increment on a new result. Do not reset, stage, commit or push prematurely. The scope and evidence below should help a fresh agent reconsider the design, not lock them into a particular noise layout, grid size or pass count.

## Read this first

The owner's discussion is ground truth. Older water notes contain outdated scope limits and visual success claims. This document supersedes their "no terrain-stack changes / banks only" scope: the owner now authorizes restructuring generation to support **guaranteed regional minima, guaranteed lake basins, and a coarse river network**. Preserve the established terrain features as far as possible. Broad terrain-quality work comes later.

Proceed in small increments. Measure each increment, show actual generated results, and keep an independently usable baseline. Do not implement the entire roadmap in one turn. Correctness tests, shader compilation, and attractive isolated diagnostic images do not establish acceptable live visual quality.

**Latest owner scope supersedes earlier restrictions:** any part of the whole engine, terrain compute or quadtree may be reworked when it improves realistic placement, visual quality, complete cost, memory and streaming latency. Preserve existing terrain character as far as possible; this permission is not a decision to adopt a noise/erosion rewrite and never authorizes restoring the rejected experiment. The owner wants unified placement with minimal lake-type special cases, and allows small lakes in rugged terrain, common cheap plateau lakes and rarer sites needing extra processing. Low-resolution terrain should appear virtually immediately and fine terrain should catch up quickly even in fast motion. Spend compute only for substantial visual return. Whitewater game's shallow water equations remain the chosen later water visuals/displacement, after placement/carving. The latest owner explicitly brought bank/lake-shore texturing and splat mapping into current scope; water simulation, foam and new near-water geometry are not implemented in this bank increment.

The owner's selected initial option ("2." in the discussion) is a starting point, not a permanent quality ceiling. Start with a lean structured representation, retain refinement and representation upgrades, and judge them through measurements and visuals. Exact grid sizes and tier counts remain experimental choices rather than settled requirements.

## Latest direction: October 10 quality rejection, generation preference and measured alternatives

### Owner feedback and visual target

The owner supplied an old actual-game plains lake as the scale/shape reference: a broad connected water body with substantial bays, narrow peninsulas, smaller inlets and islands, and existing terrain detail reaching the waterline. Do not infer its world-space dimensions from the screenshot alone; recover a comparable old scene/records if available, or label the chosen prototype dimensions explicitly. The current approximately 617 x 538 m / 0.187 km2 three-lobed lake does not satisfy the visual target merely because it is larger than earlier blips.

The river reference has changing direction and width along its length, different left/right shores and local jagged detail. The owner explicitly rejects extended straight reaches, uniform canals, and repeating sine-wave-looking shorelines. Variation must be deterministic and spatially coherent, with broad shape and smaller irregularity, rather than a regular wave or per-vertex random zigzag. Preserve downstream water slope and plausible steep mountain descent; SWE is still later work.

The supplied current comparison images show smooth deep trenches, straight strips, bulb-like lakes/mouths, abrupt joins/bands and possible coverage/clipping glitches. **The owner says none meets the needed standard.** Screenshots establish that these views fail visually, but do not by themselves establish the exact cause of every glitch. Diagnose height/depth/ownership/LOD/mesh coverage before choosing a fix. Do not dismiss these defects as deferred water texturing or claim a sampled wetness audit proves visual correctness.

New explicit rendering direction: **distant water can remain simplified terrain-shader water; near water needs proper surface geometry.** A new standalone water mesh for every distant reach is not required. Near/far representations must agree on feature identity, levels, shoreline/wetness and junction ownership. Proper geometry/coverage and bank shape are current scope; simulation, foam and water texturing are not a remedy for those defects.

The owner asks: "Tell me how you will improve it before you start." This section preserves the read-only analysis and proposed approach. The handoff request authorizes documentation, not silently starting the new implementation in the same turn.

**Latest clarification, superseding the previous strict interpretation:** "I told I would prefer to run terrain compute once, but this is not an absolute requirement. If it is necessary for better visuals and justified in terms of compute, we can run some form of height generation first for lake generation (or a specialized / simplified version). All options are on the table." The owner also explicitly requires **all measurement and comparison results to be recorded in the handoff, with data supporting decisions**. Extra height work is not a failure by itself and is not restricted to mountain exceptions. The agent's previous categorical single-generation rule was too strong and has been corrected below and in the fresh-session prompt.

### What exists, and where it diverged

- The six-face macro foundation really is a persistent terrain-generation input. Its exact input matching, lifetime/fence handling, failed-publication preservation and equivalent regeneration measurements are useful work to retain provisionally.
- `regionalShape.js` / `regionalShape.wgsl.js` additionally bake a dense 128- or 256-control-per-side field by invoking the existing natural base-height stack, including its erosion, before planning/producing fine tiles. CPU readback, spline hulls and bounded connected-component proofs then make this sampled field authoritative. This is not an observational minimum masquerading as a proof. It adds preliminary natural-height work and may amortize it across fine descendants. That tradeoff is allowed under the latest clarification; its visual quality, complete cost and streaming benefit still need to earn adoption.
- Inside that field, `calculateTerrainHeightBaseD` substitutes the spline instead of rerunning the full analytic natural base at every fine pixel. Therefore do **not** inaccurately describe the implementation as two complete identical fine-tile generations. The actual issue is the additional full-natural-shape prepass and replacement of the natural eroded field, plus subsequent fine micro/material/normal output work. Foundation sharing in increment 28 does not eliminate that first-use prepass.
- `regionalDepression.js` modifies the already-baked shape using three smooth Gaussian-like lobes with a small warp. This produces a simple rounded footprint, not the topology/detail in the reference. Increasing its radius or warp alone is not a credible complete fix.
- The original terrain already has `featureLakeBasinsHeight_d` in `templates/terrain-shaders/features/featureContinents.wgsl.js`: a two-octave approximately 6 km noise hollow, up to 25 m deep, gated by land-region character. This is a useful existing terrain-owned basin signal to investigate/reuse. It currently supplies neither a complete lake ownership/outlet network nor a tight basin guarantee on its own.
- `regionalDrainage.js` routes an eight-neighbour height grid using distance/incision/slope costs, smooths/resamples it and records a constant nominal half-width. The grid is additionally height-sampled with the production certifier; the mountain case used 868 route and 321 profile samples. This is a coarse route corridor, not yet a convincing visible river course. Source/receiver level anchors use bounding radii rather than actual shoreline portals.
- `riverShapeNoise.js` already has seeded nonperiodic width/wobble/bank noise. It is not literally a sine wave. Its small lateral amplitude and long scales on an approximately 8 m-wide river cannot by themselves hide a straight route or create the requested shore character; left/right bank variation also shares one opposed signal.
- The common `riverCarve.wgsl.js` cross-section can impose broad smooth bank/hillside profiles. `riverCarveMicroKeep` suppresses detail in the channel and bank zone. The authoritative lake field also caps micro over potential water and its enclosing ring. These are confirmed sources of missing detail; restoring noise everywhere without maintaining the wet/rim contract would be an invalid fix.
- Near lake masks, near river ribbons, lake ownership and terrain-shader water have several clipping/coverage rules. Continuity is not established merely by a correct sampled centreline. Inspect `nearWaterSurface.wgsl.js`, `lakeSurfaceField.js`, `WaterGpuData.js` and `waterWgsl.js` with actual final terrain depth and ownership diagnostics. Do not assume the exact source of a coloured band or gap until isolated.
- Global feature paging, cross-region portal ownership and demonstrated fast-motion/low-end streaming do not exist as a finished system. Increment 33 now provides bounded procedural world population; fixed opt-in previews remain historical comparison cases.

### Proposed architecture: shared terrain inputs and water boundary; benchmark generation alternatives

Preferred lean candidate, not a mandatory pass count:

```text
Persistent coarse terrain traits + bounded basin potential
    -> coarse basin/spill/outlet/drainage records
    -> one fine terrain-generation chain using those records
    -> generated height + wetness/depth for aligned near/far rendering
```

"One generation" means one ordinary terrain-generation chain per requested tile, including its existing classification/micro/normal passes and border work. It does not mean every output must be written in one compute dispatch. A preliminary height field or additional generation is allowed when it demonstrably earns its cost. Count full-height evaluations, reuse across actual consumers, extra dispatches/readbacks and terrain invalidations, including work hidden in helpers. Diagnostic readbacks/checks are separate from runtime placement costs. Prefer a prepass whose outputs remain integral, reusable terrain inputs over discarded speculative work; do not assume either reuse or fewer passes necessarily wins.

Compare these alternatives using the same representative substantial lake, shoreline-detail target, complete output coverage and rendering:

| Candidate | Height work before lake planning | Potential return | Main risk / evidence needed |
| --- | --- | --- | --- |
| A. Coarse traits/potential only | Existing macro inputs plus the minimum supporting basin metadata | Least preliminary work and early coarse water; retain direct fine terrain | Bounds may be too loose or topology too weak, causing rejected sites or artificial guaranteed carving |
| B. Specialized supporting height field | Bounded local macro/selected meso or another simplified height evaluator, omitting unrelated full output work | Better basin/spill/shore information at moderate shared cost; possibly reused by descendants | Simplification/interpolation may lose real depressions or detail; derive residual erosion/micro bounds and measure fine fetch costs |
| C. Fuller natural height field / preliminary height generation | Existing eroded-field prototype or another bounded fuller evaluation before lake planning | Follow real existing terrain and amortize costly natural evaluation across fine tiles | Upfront compute, waiting/readback, memory, smoothing and regeneration amplification; current visually rejected version is a baseline, not proof this entire class fails |

These are architectural candidates, not three new lake-type special cases. A common basin/outlet/river record and rendering contract should serve them. Do not implement three entire pipelines before measuring: audit the existing C costs/content, make the smallest A/B comparison that can resolve the uncertainty, then continue the winner in a small increment. If a second generation gives clearly better results within the complete budget, it can win. No fresh measurements currently rank A/B/C, and pass count alone cannot disprove C.

1. **Make the existing basin-producing terrain signals first-class regional inputs.** Investigate exposing the current lake-hollow/plateau fields, gradients, relief limits and humidity alongside the accepted macro inputs. Choose bounded basin components and spill/outlet levels on the selected shared representation. A small bounded coarse component/flood/priority-flood computation is allowed. The six-face 256-cell foundation is not automatically detailed enough to locate local basins: measure physical cell size and compare the supporting local macro/meso/full-height resolution actually needed. Label a dense natural-height bake honestly and charge its cost; do not relabel it as cheap macro metadata. Retain it if its measured visual/performance return is best.
2. **Use one terrain/water feature contract.** A basin record needs a substantial connected wet core, a shoreline transition band, a dry retaining boundary (except an explicit outlet), level, allowed cut and residual erosion/detail budgets. A regional minimum alone cannot prove these: an upper envelope is needed to keep the core submerged, a lower envelope to retain the rim. Keep the natural fine stack inside declared allowances and make a bounded local cut part of height generation. Reject sites whose bounds imply excessive excavation instead of solving them with deep bowls or raised enclosing hills. Decide the feature's stage from cost/contract evidence; do not automatically reevaluate a complex new lake/river function in every internal erosion octave.
3. **Let the final terrain/water intersection supply the shore.** Replace the radial/three-lobe visual footprint with a coherent two-dimensional basin potential that can support bays, peninsulas and islands. Retain existing erosion/meso/micro detail in the shoreline band and above water; constrain only the interior where needed for guaranteed depth. Combine broad features and smaller bounded spatial variation, at scales measured in metres rather than uniform angular oscillations. The shore is the final generated height crossing the water level, inside the basin's support/ownership. Do not flatten banks to a smooth fixed profile merely to make a mask easy to prove. A broad connected wet core must be checked, so a large bounding region with scattered puddles is not counted as a large lake.
4. **Derive near water from shared or already-produced terrain.** Prefer reusing generated height/depth textures or adding a compact wetness/depth output over rerunning procedural terrain just for a lake mask. A cheap rendering-data pass over existing heights may be justified; it is not another terrain generation. Decide direct texture sampling versus an extra channel/pass after auditing atlas mappings, available bindings, residency and cost. Lake plane patches and river surface geometry can be clipped to the same wet boundary. Lake/river ownership must follow actual wet coverage and shared outlet data, not an enclosing circle that discards a valid neighbouring river. Bound and measure any necessary placement/refinement/regeneration cycle rather than assuming it is forbidden or free.
5. **Use the coarse drainage path as a corridor, then construct the visible course.** Give the centreline sustained terrain-aware curvature, spatially varying width, independent bank variation and finer shoreline irregularity. Adapt bend scale to width and slope: steep channels still change direction but should not receive exaggerated plains meanders. Keep curvature/self-intersection, support/incision and monotone surface constraints; do not add high-frequency random zigzags. Place lake joins at actual wet shoreline portals, with shared levels/bed/coverage. Cut a varying submerged bed while retaining natural bank terrain wherever it already contains the water. Broad uniform trench walls are not the default. Localized rapid/fall geometry follows justified terrain descent rather than repetitive stairs or arbitrary ramps. Route/profile sampling should use regional inputs normally; any extra full-terrain probes must be explicit, bounded and justified in complete cost.
6. **Keep distance rendering cheap.** Publish a simplified coarse water representation as soon as its regional records are ready, independently of near geometry and every refined tile. If the chosen prepass gates initial placement, measure that latency and consider whether a consistent coarse first stage can publish earlier. Reuse feature levels/support/ownership for both terrain-shader water and near geometry. Detail lost with distance must be filtered consistently; changing representations must not shift the shoreline, introduce gaps or paint a dry bank as the near water surface. Audit the real transition rather than adding a global higher LOD as a coverage workaround.

This keeps the core model unified: lake size, relief, allowable cuts and available confidence vary by region; the terrain/water evaluator and outputs do not need a bespoke terrain generator for each lake type. Any engine/atlas/quadtree changes necessary for correct shared inputs and near clipping are in scope, but each must earn its cost.

**Rugged terrain policy:** prefer smaller, rarer ponds and naturally broader valley floors when that offers better return. A limited meso/probe/refinement or fuller supporting field can be justified for rugged sites; it is also allowed for plateau lakes if the same benefit holds there. Reading a finished fine tile and changing its carve afterwards requires another generation, so label and measure it. Reject expensive/visually unsuitable sites or reduce their frequency rather than forcing every location through heavy processing. Keep a common architecture where possible; rarity, work caps and supporting resolution are parameters, not excuses for endless bespoke generators.

### Next increments and decision criteria — proposed, not implemented

**Current progress supersedes the earlier sequence below:** broad organic lake shape is accepted. Increment 30 measures one connected gentle course and the same model on a mountain reach; the next visual gap is bank asymmetry/micro. Increment 33 adds bounded automatic world placement/yield; global paging, a connected drainage DAG and shared ownership remain unfinished. The new clarification rejects complete dry-first tile regeneration; bounded supporting-height comparisons still remain valid.

**First:** recover a representative old plains-lake baseline and isolate the current coverage/join failures with height/depth/ownership views. Specify physical lake scale, output coverage and a same-seed camera set. Audit existing C and make the smallest useful A/B supporting-field comparison, then implement one substantial plains lake using the best evidenced path, preserving detailed natural shore terrain and matching near/far water. Do not begin by adding another valley decoration or merely increasing the same three-lobe warp. A bounded fine-height search/prepass is an option if its measured return beats cheaper alternatives. The old renderer/baseline remains independently usable. Record unsuccessful candidates and inconclusive comparisons as well as improvements.

**Second, after visual assessment:** one gentle connected river with an organic course, variable width, irregular/asymmetric banks and a continuous real shoreline junction. Then apply the same model to a rare small mountain lake/downhill reach and a localized fall. Do not extend a visually rejected flat canal into more elaborate waterfall cases. Whole-world feature paging and richer noise tiers come after these local contracts and visuals work, unless the first experiment exposes a required dependency.

Hypothesis A: coarse basin-potential/topology records plus a bounded feature in fine height generation may recover larger organic lakes without the dense natural-shape prepass. Hypothesis B/C: a suitably scoped supporting height field may instead provide better natural shape/placement and enough fine-stage reuse to justify extra preliminary work. Shared hypothesis: retaining fine terrain at the coast and using one wet-boundary source can remove manufactured shores and representation joins. **Confidence:** high in the diagnosed missing-detail/simple-footprint causes; moderate in these architectural benefits; no established ranking of A/B/C. Performance, terrain preservation, shoreline containment and fast streaming remain experiments, not promises.

Disprove A's no-prepass hypothesis if it cannot deliver the required natural shape/containment without extra height information at acceptable complete cost. Disprove B/C's return if extra preparation/reuse fails to buy enough actual visual benefit or saves less than it adds in complete work, memory or readiness latency. Reject any candidate if guarantees require wiping shoreline detail, excessive cuts or raised artificial rims; if the final coast is still smooth/repetitive or glitches persist; or if matched-quality complete cost/memory/streaming is unacceptable. Extra generation alone is not a rejection criterion. Compare another layout/representation when evidence warrants it instead of repeatedly tuning a failed shape; never claim an efficiency win based on less detailed/less visible output.

Required evidence per implemented increment:

- Actual engine before/after at matching location, lighting and cameras: broad lake overview, close oblique shoreline, waterline, outlet, near/far and LOD transitions. Add wireframe/height/depth/ownership diagnostics for defects. New visuals require the owner's assessment before building the next terrain-changing increment.
- Full cold first use, warm complete generation, shared regional cost, failed candidates, water publication/near geometry, fine outputs, queue fences, and both full/feature regeneration. Count procedural height sampling, supporting data generation and duplicate/invalidated tile work explicitly. Aim around/below 50 ms per complete river; 60–80 ms only for demonstrated worthwhile quality. No such result exists yet.
- Same actual output coverage/content for a cost comparison, then real fast-motion streaming: first low-resolution terrain/water, near catch-up latency, queue pressure, visible coverage and frame cost. Do not compare equal tile counts that depict unequal geometry/content and call them equivalent.
- GPU live/peak payload, old/new overlap, persistent/temporary typed CPU data, atlas/binding/read costs and declared whole-game pools; label driver/process estimates and unsupported GPU timestamps. Strong local timings do not establish lower-end readiness.
- Continuous guarantees where derived; sampled audits labelled as samples. Closed rim/connected area, water-level/bed junctions, downstream monotonicity, exterior preservation, deterministic cross-region data and safe regeneration/lifetime.

### Useful current evidence and restart map

Latest simulation validation: 326 tests / 51 files; original GPU still/mass/channel tests plus a driven steep-reference fixed-point and bounded perturbation check. Two-step isolated GPU medians are 0.328 ms gentle /0.197 ms mountain, four-step medians 0.590 /0.393 ms. Native construction plus first bed/solver placement through the fence is about 131–132 ms with uncontrolled caches; repeat placement about 4–6 ms. Warm normal-range visible activation includes a 0.6 s fade (~643–650 ms total) while static water remains present. Full render comparisons have stable identical inventories and zero water-triggered regeneration; signs change between repeated runs, so no speedup is claimed. No whole fast-moving-view <50 ms guarantee. [Raw records](tools/perf/structured-terrain-results/whitewater-near/measurements.json).


Historical measurements to retain, with their limits:

| Workload | Existing measurement | Limitation |
| --- | --- | --- |
| Mountain, 10 complete terrain outputs + shared inputs/water | Full warm median 146.038 ms; unchanged-foundation feature regeneration 131.979 ms | Rejected visual prototype; not a complete 50 ms river result or a faster first build |
| Larger plains lake, 23 complete outputs covering basin/rim/halo | Warm regeneration roughly 243–266 ms in initial run; known-anchor comparison median 242.295 ms | Three-lobed coast now rejected; no one-pass adoption or general population/yield claim |
| Foundation memory | 14,452,416 B shared macro payload; whole mountain peak 48,087,936 -> 45,621,728 B on feature regeneration | Steady residency unchanged; smaller whole-peak saving than regional-stage saving |
| Actual game pools in large-lake preview | Approximately 1.35 GiB declared GPU peak | Low-end memory/streaming unresolved; driver allocations excluded |
| Latest validation, increment 31 | 322 tests / 49 files; shader compilation, bounded bank/gradient/uniform checks; complete native wet/dry audits, source/texture regressions and actual matched production views | Broad lake and improved bank direction accepted as progress; close material limits and cold compilation remain, no fast-motion readiness claim; full logs in organic-banks archive |

Existing comparison pages are **failure/baseline evidence**, not an endorsed visual target:

- `http://localhost:8181/tools/perf/structured-terrain-results/large-lakes/index.html`
- `http://localhost:8181/tools/perf/structured-terrain-results/mountain-river/index.html`
- Direct opt-in game previews: `wizard_game/standalone.html?regionalLargeLake=1&regionalView=basin` and `?regionalWhitewater=1&regionalView=river`.

Primary source map: `regionalTerrainFoundation.js` / `regionalTerrain.js` for coarse ownership/publication; `regionalShape.js|Model.js|.wgsl.js` for the dense prepass/current basin proof; `regionalDepression.js` for the three-lobe large lake; `regionalDrainage.js` / `regionalRiverProfile.js` for sampled routes/profiles; `featureContinents.wgsl.js` / `earthLikeBase.wgsl.js` for existing terrain basin signals/stage order; `advancedTerrainCompute.wgsl.js` and `riverCarve.wgsl.js` for micro suppression; `nearWaterSurface.wgsl.js`, `WaterGpuData.js`, `waterWgsl.js`, `lakeSurfaceField.js` for actual geometry/ownership/depth; quadtree modules for selection/streaming. Paths below the world directory are `core/world/terrain-generator`, not `core/world/terrain`. Terrain templates are at repository `templates/terrain-shaders`, not under `terrain-generator`.

The old reference images were supplied in chat, not saved as new repo artifacts in this documentation session. A fresh agent must not claim to have viewed them if absent from its context. Written targets above preserve their implications; existing screenshot artifacts are actual runtime captures. No synthetic art substitutes for a real acceptance comparison.

Preservation: current branch/worktree remains the starting point, not HEAD. Protected earlier rollback files include `WATER_STATUS_HANDOFF.md`, `riverLandscape.js|.test.js`, `waterWorkerCore.js`, and `riverValley.js|.test.js|.wgsl.js`. Prior exact-byte baseline manifest is `/tmp/spherecraft-natural-basin-start-20261009/source-manifest.json`; foundation start snapshot is `/tmp/spherecraft-foundation-start-20261010`. Temporary files may not survive a fresh environment. Reinspect status/diffs and use snapshots as evidence only, never blindly restore the entire tree. Do not reset, stage, commit, push or restore the rejected enclosing-hill/spiky experiments. The existing local server on port 8181 belongs to this workspace; leave it and unrelated browser sessions alone. Run native/browser GPU diagnostics sequentially to avoid contention.

## Screenshot review collection

The owner requested a screenshot folder for the next agent/fresh session. [Handoff screenshot folder and source notes](tools/perf/structured-terrain-results/handoff-screenshots/README.md) contains **31 representative actual-game images**, copied without alteration from the existing archive. [Open the local gallery](http://localhost:8181/tools/perf/structured-terrain-results/handoff-screenshots/index.html), or open [its HTML file](tools/perf/structured-terrain-results/handoff-screenshots/index.html) directly. All copies retain original resolution and bytes; [capture provenance](tools/perf/structured-terrain-results/handoff-screenshots/sources.json) includes the archived source, full SHA256 and saved camera/LOD metadata for each image. No fresh render was performed.

| Collection | What the next agent should inspect | Example images |
| --- | --- | --- |
| Plains lake, 12 images | Same four views of original terrain / dry depression / wet lake. Current simple footprint and smooth shoreline are rejected; these are not the old broad-lake target. | [Lake setting](tools/perf/structured-terrain-results/handoff-screenshots/plain-lake/setting-wet.png), [shore](tools/perf/structured-terrain-results/handoff-screenshots/plain-lake/shore-wet.png), [original terrain](tools/perf/structured-terrain-results/handoff-screenshots/plain-lake/setting-original.png) |
| Mountain river, 10 images | Outlet/channel/fall/inlet/network, previous versus regional-height LOD selection. Both use the same rejected experimental river; this is not old versus new river placement. Visible geometry differs between LOD variants. | [Straight channel](tools/perf/structured-terrain-results/handoff-screenshots/mountain-river/channel-regional-lod.png), [fall/colour transition](tools/perf/structured-terrain-results/handoff-screenshots/mountain-river/fall-regional-lod.png), [outlet](tools/perf/structured-terrain-results/handoff-screenshots/mountain-river/outlet-regional-lod.png) |
| Distant water, 2 images | Earlier versus consistent body colour at the same distant camera. An appearance improvement does not establish natural route/shore geometry. | [Earlier](tools/perf/structured-terrain-results/handoff-screenshots/distant-water/network-earlier-colour.png), [consistent colour](tools/perf/structured-terrain-results/handoff-screenshots/distant-water/network-consistent-colour.png) |
| Small natural pond, 4 images | Original/wet setting and shore; judge scale/enclosure rather than equating altitude/containment with good alpine visuals. | [Pond setting](tools/perf/structured-terrain-results/handoff-screenshots/natural-pond/setting-wet.png), [shore](tools/perf/structured-terrain-results/handoff-screenshots/natural-pond/shore-wet.png) |
| Rejected enclosing feature, 3 images | Original / dry feature / lake. Historical artificial enclosure is failure evidence and remains off; do not restore it. | [Dry enclosing feature](tools/perf/structured-terrain-results/handoff-screenshots/rejected-enclosure/context-dry-feature.png), [feature with lake](tools/perf/structured-terrain-results/handoff-screenshots/rejected-enclosure/context-lake-feature.png) |

This collection is a convenient subset, not a new experiment or visual approval. The full catalogue retains all original 350 screenshots; the extra 31 are byte-identical review copies. The old lake reference and external river concept supplied only in chat are **not available as local image files**; their desired shape/detail is described near the top. Do not label an existing prototype capture as that reference. Use source browser reports and the measurement ledger for costs/configuration; screenshots alone do not establish the exact cause of a glitch or a performance result.

## Measurement and comparison evidence ledger

**Owner requirement: record every measurement and comparison result, including failed, rejected, invalid and inconclusive runs. Decisions need data.** Detailed numbers through increments 0–29 remain in this handoff's chronological records, [MEASUREMENTS.md](tools/perf/structured-terrain-results/MEASUREMENTS.md) and the [organic-lake evidence notes](tools/perf/structured-terrain-results/organic-lake/README.md). The table below consolidates the principal results and points to raw evidence; it does not replace or truncate those detailed records.

The [complete evidence index](tools/perf/structured-terrain-results/EVIDENCE_INDEX.md) catalogues **all 891 saved result artifacts** through increment 29: 372 comparison image, 31 comparison image (review copy), 26 diagnostic source, 2 documentation, 10 log, 1 measurement narrative, 132 raw controls/mask, 291 report, 1 screenshot provenance, 25 viewer. The [machine-readable manifest](tools/perf/structured-terrain-results/EVIDENCE_MANIFEST.json) records path, byte count, full SHA256 and JSON top-level fields. All 292 JSON files parse; all earlier 801 artifacts remain byte-identical. This verifies evidence traceability, not visual acceptance or validity of every run. Catalogue files exclude themselves.

| Increment / experiment | Reported result and decision limits | Numerical evidence / actual comparison |
| --- | --- | --- |
| 29: organic lake potential and preview API repair | Estimated connected lake area 0.187 → 0.527 km²; alternating complete 23-output medians +2.6–5.6 ms; no new persistent GPU payload. Shore micro/rivers unfinished, shape not owner-accepted. Mixed-module TypeError reproduced and fixed preview validated. | [All runs and limitations](tools/perf/structured-terrain-results/organic-lake/README.md), [actual gallery](tools/perf/structured-terrain-results/organic-lake/index.html), [analysis](STRUCTURED_TERRAIN_ORGANIC_WATER_ANALYSIS.md) |
| 0–1: baseline, coarse foundation and old network | 256-cell seven-output fine medians direct 58.75 / regional 59.68 ms; roots + seven outputs 96.75 ms; roots + old water reconstruction + outputs 9,600.83 ms. Macro layout did not establish net speed savings. Original fidelity accepted for that scope; not new lake/river acceptance. Existing full river refinements remain 394–2,959 ms in that survey. | [128 raw](tools/perf/structured-terrain-results/benchmark-128.json), [256 raw](tools/perf/structured-terrain-results/benchmark-256.json), [comparison](tools/perf/structured-terrain-results/index.html), [all regeneration/health/render reports](tools/perf/structured-terrain-results/EVIDENCE_INDEX.md#root-reports-and-comparisons) |
| 2–3: original bowl, local bound/placement | Original complete regeneration 217.31 / 190.07 / 177.22 ms; first-use 43.731 s retained. Original maximum cut 72.498 m. Both deep/uniform banks rejected; local certificates/sample checks did not make them visually acceptable. All local-placement costs and trials remain in the session records. | [original benchmark](tools/perf/structured-terrain-results/basin-preview/benchmark.json), [first-use](tools/perf/structured-terrain-results/basin-preview/benchmark-first-use-summary.json), [original comparison](tools/perf/structured-terrain-results/basin-preview/index.html), [local benchmark](tools/perf/structured-terrain-results/basin-local/benchmark.json), [local comparison](tools/perf/structured-terrain-results/basin-local/index.html) |
| 4–6: shallow banks, varying reach and small highland | Shallow banks/reach accepted for the earlier placement prototype. Same-field reach refinement did not demonstrate fine savings; seven-output medians 78.02 / 77.73 ms. Highland 60 m radius / level 1,286.852 m / sampled maximum cut 14.020 m; actual wide plain was insufficient as an alpine pocket. Later owner standards supersede prototype acceptance. | [banks](tools/perf/structured-terrain-results/basin-banks/index.html), [reach](tools/perf/structured-terrain-results/basin-bank-reach/index.html), [highland](tools/perf/structured-terrain-results/basin-highland/index.html); every benchmark/planning/LOD/preservation report in [the catalogue](tools/perf/structured-terrain-results/EVIDENCE_INDEX.md) |
| 7: first lowland connection | First complete 10-output workload 1,205.531 ms; regeneration 341.067 / 350.928 / 319.484 ms. Near placement/joins accepted for initial scope; distant water failed, including a rejected temporary 10 km ribbon-range trial. 20.554 ms connection planning is not a complete river result. | [benchmark](tools/perf/structured-terrain-results/coarse-river/benchmark.json), [comparison](tools/perf/structured-terrain-results/coarse-river/index.html), [browser](tools/perf/structured-terrain-results/coarse-river/browser.json) |
| 8–9: valley metadata and terrain-owned enclosing feature | Additional placement/certification costs, rejected tighter caps and actual comparisons recorded. Valley site remained a tiny plateau pond. Terrain-owned hill enclosure was briefly accepted as a proof of concept, then explicitly rejected as artificial. The enclosing feature remains off. | [valley comparison](tools/perf/structured-terrain-results/basin-valleys/index.html), [enclosing-feature comparison](tools/perf/structured-terrain-results/valley-feature/index.html), [feature benchmark](tools/perf/structured-terrain-results/valley-feature/benchmark.json), [reassessment](tools/perf/structured-terrain-results/lake-reassessment/diagnostic.json) |
| 10: root pipeline reuse | Complete seven-output regeneration medians 190.08 -> 163.41 ms; root compilation about 22–23 -> 0.07–0.20 ms. Separate native processes/caches uncontrolled; 46.777 s old first-use stall is retained, not claimed fixed. GPU live/peak unchanged. | [before](tools/perf/structured-terrain-results/pipeline-reuse/before/benchmark.json), [after](tools/perf/structured-terrain-results/pipeline-reuse/after/benchmark.json) |
| 11: authoritative natural shape | Complete 16-output regeneration 159.658 / 156.139 / 158.229 ms; shared shape 8.165–14.454 ms. Equivalent nine fine-output medians original 75.608 / dry 61.893 / wet 61.927 ms, excluding full shared cost. First 46.621 s compiler stall retained. This supports testing amortized height work, not automatic adoption or excellent shore detail. | [benchmark](tools/perf/structured-terrain-results/natural-basin/benchmark.json), [comparison](tools/perf/structured-terrain-results/natural-basin/index.html), [all 64/128/256 and bound-optimization trials](tools/perf/structured-terrain-results/EVIDENCE_INDEX.md#natural-basin) |
| 12: lake surface/depth | Complete 16-output OFF/ON medians 146.661 / 146.491 ms; no measurable overall penalty/speedup. Extra typed CPU 4,096 B, GPU unchanged. Distant pond restored; prior near white-patch interpretation corrected to shading after coverage checks. | [interleaved cost](tools/perf/structured-terrain-results/natural-surface/cost-interleaved/benchmark.json), [comparison](tools/perf/structured-terrain-results/natural-surface/index.html) |
| 13: water capacity | Owned GPU water 140,116,208 -> 12,587,440 B; complete 16-output medians 145.943 -> 136.753 ms. Mixed peak includes old large pools; compact-only and whole-game memory separately recorded. Smaller 64-cell shape and unmatched flight runs did not establish equivalent-quality streaming improvements. | [benchmark](tools/perf/structured-terrain-results/structured-pools/benchmark.json), [compact-only](tools/perf/structured-terrain-results/structured-pools/compact-only/benchmark.json), [comparison](tools/perf/structured-terrain-results/structured-pools/index.html) |
| 14: certificate pipeline reuse | Complete 10-output alternating medians 220.593 -> 136.671 ms; certificate compilation 54.643 -> 0.260 ms. Content/contracts unchanged, bounded source/device reuse. Not a 50 ms complete river or cold readiness result. | [benchmark](tools/perf/structured-terrain-results/certificate-reuse/benchmark.json) |
| 15: fixed regional yield | 15/24 certified fields before setting filter; complete survey 789.498 ms includes roots/hints/all failures, but excludes fine outputs/water/paging. Complete successful 16-output regens approximately 155–174 ms. Altitude/containment alone did not establish alpine visual quality. | [survey](tools/perf/structured-terrain-results/natural-yield/survey.json), [comparison](tools/perf/structured-terrain-results/natural-yield/index.html), [per-field successes/failures](tools/perf/structured-terrain-results/EVIDENCE_INDEX.md#natural-yield) |
| 16: candidate allocation | Complete medians 164.911 -> 133.211 ms; selection 25.566 -> 14.707 ms. Separate processes/GC prevent attributing the whole 31.7 ms gap. Source/records/content checks unchanged; no speculative JS byte saving claim. | [before](tools/perf/structured-terrain-results/selection-allocation/before/benchmark.json), [after](tools/perf/structured-terrain-results/selection-allocation/after/benchmark.json) |
| 17–18: setting preference | Threshold 20 m retained 6/24; complete survey 729.966 ms, but accepted highland still visually a plain. Threshold 30 m retained 3/24; complete survey 830.597 ms, including 466 attempts/fences. Setting metrics are not visual proof. Stricter selected sites, negative controls and full successful/failed costs retained. | [threshold-30 survey](tools/perf/structured-terrain-results/natural-context/threshold-30/survey.json), [comparison](tools/perf/structured-terrain-results/natural-context/index.html), [all threshold/cost controls](tools/perf/structured-terrain-results/EVIDENCE_INDEX.md#natural-context) |
| 19: direct ownership fetch | Candidate rejected: same-process complete medians existing 143.693 / candidate 146.638 ms, despite misleading separate-process apparent improvement and exact content checks. Candidate first-use 49.074 s retained. Runtime restored to prior shader; experiment archived only. | [interleaved](tools/perf/structured-terrain-results/shape-access/interleaved/benchmark.json), [all before/after/archived sources](tools/perf/structured-terrain-results/EVIDENCE_INDEX.md#shape-access) |
| 20: smaller lake index | Complete 16-output medians 149.720 -> 141.902 ms; publication 7.866 -> 1.186 ms. Owned GPU water 12,587,440 -> 201,136 B; same sampled heights/depth detail. Networks retain larger index. Whole-game pools still about 1.35 GiB. | [interleaved](tools/perf/structured-terrain-results/lake-index/interleaved/benchmark.json), [comparison](tools/perf/structured-terrain-results/lake-index/index.html), [river control](tools/perf/structured-terrain-results/lake-index/river-control/benchmark.json) |
| 21: distant structured river depth | Complete 10-output OFF/ON medians 135.909 / 137.262 ms. Frozen render medians 15.7 / 15.4 ms; no measurable penalty/speedup. Early coarse river visibly present while fine tiles queued, but initial publication 8.575 s is not immediate startup. Invalid manual texture audit excluded and retained. | [generation](tools/perf/structured-terrain-results/river-surface/interleaved/benchmark.json), [render](tools/perf/structured-terrain-results/river-surface/render-cost/browser.json), [comparison](tools/perf/structured-terrain-results/river-surface/index.html), [all early/invalid evidence](tools/perf/structured-terrain-results/EVIDENCE_INDEX.md#river-surface) |
| 22: local receiver readback | Complete medians 137.727 -> 135.286 ms; receiver planning 6.474 -> 4.335 ms. Aligned field-copy bytes 8,335,872 -> 20,736; whole peak unchanged. Same basin/river/height audits; global initial readbacks still exist. | [interleaved](tools/perf/structured-terrain-results/local-readback/interleaved/benchmark.json), [comparison](tools/perf/structured-terrain-results/local-readback/index.html) |
| 23: outlet audit and inexpensive source | Whole CPU audit 33.262 ms includes four cases and repeated coarse/refined routes, not complete generation. Steep exit crest/cut 18.584 / 20.209 m; gentler case 3.038 / 4.663 m. No local boundary exit does not prove a globally closed watershed. Actual cheap case remained a rounded upland pond; complete 16-output regens 163.083 / 148.690 / 137.959 ms. | [audit](tools/perf/structured-terrain-results/natural-outlets/audit.json), [source benchmark](tools/perf/structured-terrain-results/natural-outlets/source/benchmark.json), [comparison](tools/perf/structured-terrain-results/natural-outlets/index.html), [coarse-only and upper-corridor failures](tools/perf/structured-terrain-results/EVIDENCE_INDEX.md#natural-outlets) |
| 24–25: mountain channel/fall and LOD | About 844 m course / 435 m descent, one localized 4.928 m fall; sampled maximum cut 22.964 m. Complete native 10-output regeneration around 139–177 ms; first compiler stall 48.926 s retained. Actual frozen close render median 18.0 -> 23.6 ms / p95 30.7 -> 37.3 with more visible geometry: a material cost, not free improvement. Current visuals rejected. | [validated generation](tools/perf/structured-terrain-results/mountain-river/validated/benchmark.json), [LOD cost](tools/perf/structured-terrain-results/mountain-river/lod-cost/benchmark.json), [corrected render](tools/perf/structured-terrain-results/mountain-river/lod-render-validated/browser.json), [comparison](tools/perf/structured-terrain-results/mountain-river/index.html), [all rejected profile/LOD runs](tools/perf/structured-terrain-results/EVIDENCE_INDEX.md#mountain-river) |
| 26: larger three-lobe plains lake | Approximately 617 x 538 m / estimated 0.187 km2; 881 connected certified-wet cells. Initial full 23-output regens 266.088 / 246.104 / 243.203 ms. Known-anchor complete medians 256.444 -> 242.295 ms with overlapping ranges and identical final height hash; full gap not attributed to scan removal. Shore shape/detail now rejected. Large-radius/scattered-puddle and excessive-cut trials retained. | [full benchmark](tools/perf/structured-terrain-results/large-lakes/depression-full/benchmark.json), [paired known-anchor cost](tools/perf/structured-terrain-results/large-lakes/seed-cost/benchmark.json), [comparison](tools/perf/structured-terrain-results/large-lakes/index.html), [all failed proposals/controls](tools/perf/structured-terrain-results/EVIDENCE_INDEX.md#large-lakes) |
| 27: distant body colour | Frozen actual render medians 14.5 / 14.4 ms, p95 20.5 / 20.9, no measurable penalty. Complete native medians 137.592 / 134.095 ms, but native workload does not render colour: no colour-driven speedup. Existing coarse coverage confirmed with owner tint; earlier assumed missing distant lookup corrected. This does not fix the owner's current geometry/shore objections. | [native](tools/perf/structured-terrain-results/mountain-river/body-native/benchmark.json), [render](tools/perf/structured-terrain-results/mountain-river/distant-body-cost/browser.json), [actual body pair](tools/perf/structured-terrain-results/mountain-river/distant-body-game/browser.json), [coverage diagnostic](tools/perf/structured-terrain-results/mountain-river/distant-diagnostic/browser.json) |
| 28: unchanged foundation sharing | Complete mountain medians full 146.038 / feature-only 131.979 ms; gentle 135.621 / 113.643 ms. All requested outputs identical within each full/shared comparison. Regional peak saves 13.78 MiB; whole mountain peak only 2.35 MiB, steady unchanged. Explicit full regeneration remains full. Failed publication/stale sampler/lifetime evidence retained; no cold/first-build/visual solution claim. | [mountain](tools/perf/structured-terrain-results/mountain-river/foundation-cost/benchmark.json), [gentle](tools/perf/structured-terrain-results/coarse-river/foundation-regression/benchmark.json), [safety](tools/perf/structured-terrain-results/mountain-river/foundation-safety/probe.json), [preview smoke](tools/perf/structured-terrain-results/preview-smoke/browser.json) |

| 29: organic lake potential | Owner subsequently accepts broad shape. Estimated wet area 0.187→0.527 km²; complete same-address 23-output medians add 2.6–5.6 ms, peak unchanged. Close micro unfinished; mixed-module preview failure repaired. | [analysis](STRUCTURED_TERRAIN_ORGANIC_WATER_ANALYSIS.md), [complete comparisons and failures](tools/perf/structured-terrain-results/organic-lake/README.md), [actual images](tools/perf/structured-terrain-results/organic-lake/index.html) |
| 30: common course, height backend and first publication | Complete matched 11-output medians coarse/natural-organic/light-organic 161.795/162.066/161.255 ms; no resolved speedup. Light sampling saves about0.4 ms but fails mountain cut at41.1m>24m. Natural gentle/mountain finite audits pass. Startup race four unready calls/one river invalidation→zero in corrected gentle/mountain probes. Smooth banks remain unfinished. | [current analysis](STRUCTURED_TERRAIN_REGIONAL_FLOW_ANALYSIS.md), [raw evidence](tools/perf/structured-terrain-results/organic-course/README.md), [actual comparisons](tools/perf/structured-terrain-results/organic-course/index.html) |

| 31: independent banks and shore materials | Common gentle/mountain model, 1–45 m independent bank extents, ±0.45 m spatial relief, 6 m dry-bank cut cap and existing splat textures. Final complete warm medians 157.958→165.106 / 135.419→139.551 ms; fine increments 1.93 / 4.24 ms per ten tiles. Cache-sensitive first-use 51–77 s vs cached ~1.4 s; no cold speedup or 50 ms view claim. Owner says bank direction is better, authorizes cleanup. | [full experiment/attempts](tools/perf/structured-terrain-results/organic-banks/README.md), [all native rows](tools/perf/structured-terrain-results/organic-banks/measurements.json), [actual gallery](tools/perf/structured-terrain-results/organic-banks/index.html), [regressions](tools/perf/structured-terrain-results/organic-banks/output-regression.json) |
| 32: close Whitewater flow/displacement | Bounded 256 m strip, prescribed base flow plus SWE disturbances, current lighting/ownership, asynchronous compute/render pipeline readiness. GPU two/four steps 0.328/0.590 ms gentle and 0.197/0.393 ms mountain; first native complete simulation request ~131–132 ms, warm placement 4–6 ms. Six stable production views, 326 tests, original/new GPU physics. Global hydraulics and <50 ms moving-view readiness not claimed. | [diagnosis/all attempts](tools/perf/structured-terrain-results/whitewater-near/README.md), [actual views/motion](tools/perf/structured-terrain-results/whitewater-near/index.html), [all measurements](tools/perf/structured-terrain-results/whitewater-near/measurements.json) |

**Important historical corrections/exclusions:** centreline/texel audits are finite samples, not continuous proofs of every river at every LOD. Early white-gap claims were corrected by coverage diagnostics. Old `pairedFine` blocks that toggled water but not carve do not establish river-off content equivalence. The rejected direct ownership-fetch optimization, invalid close cameras/manual texture audit and incomplete render capture are preserved, not used as winning measurements. Driver-cache stalls, jitter, unsuccessful basin trials, threshold surveys and oversized legacy capacities remain in raw records. Follow the detailed session entry before using a table value as a causal speedup claim.

**Required record for every future measurement/comparison:** append its script/command and revision/source key, seed/config/options, device/runtime, physical feature and sampled region, tile addresses/LOD/output types, workload count, cold/warm/reuse mode, complete timer boundary, CPU/GPU/queue/readback measurement method, all paired observations and summary statistics, excluded work/reason, shared costs and actual consumers, failed candidates, GPU live/peak/old-new overlap and CPU memory limits, sampled versus derived correctness, actual matched before/after images/viewer, owner assessment, and the resulting adopt/reject/inconclusive decision. Retain invalid attempts with reasons rather than overwriting them. Unsupported or missing data must be marked unmeasured; a hypothesis stays a hypothesis. New results must enter this ledger/session record and catalogue before an increment is treated as complete.

Evidence gaps remain explicit: no new A/B/C comparison, no controlled low-end hardware run, no comparable fast-motion trajectory proving readiness, no guaranteed whole-world feature paging, no isolated GPU timestamps for recent browser render pairs, and no locally saved copy of the old/concept images supplied only in chat. Latest owner rejection is qualitative evidence and must remain attached to the current prototype measurements. Existing actual captures are linked individually in the screenshot review collection above.

## Desired outcome and boundaries

- A smooth regional terrain foundation with true conservative lower bounds, including erosion and later negative-displacement allowances.
- Deliberately constructible basins, including high-elevation/alpine lakes. Some lakes have no outlet.
- Rivers connect higher water elevations to lower receiving water, with a cheap coarse network available before expensive local refinement.
- Placement considers existing terrain contours; carving then polishes the route through hills and mountains. Prefer improving placement and carving over placing hills specifically to decorate a river.
- Water surface descends downstream; bed height is independent and may rise after a deep pool.
- Gentle rivers, steep whitewater reaches, mountain descent, and possible waterfalls need different profiles. Waterfalls belong on genuinely steep/highland descents, not as arbitrary straight walls on otherwise gentle rivers.
- Natural lake outlets, variable widths and asymmetric banks, plausible canyons, and no continuous artificial embankments.
- Keep existing terrain landforms, features, noise character, and Runevision erosion wherever compatible with the new guarantees. Do not restore the rejected spiky terrain experiment.
- Simulation and water texturing remain out of scope. Water geometry/levels must be correct where they affect basin and channel continuity.
- A simple distant representation must appear as soon as coarse regional/network data are available. Near-detail generation must not gate it.

Performance preference: stay lean and aim around or below **50 ms per river** for generation. The owner said **60–80 ms** could be acceptable for substantial quality gains, possibly with fewer rivers. This is not authorization to spend that budget on one hidden substage. Report complete costs and amortized/shared costs separately. No measured result currently establishes these targets for the proposed architecture.

The landscape still lacks richness and variation. This is a reason to retain architectural room for a heavier reusable macro stack; it is not a request to redesign all landforms during the first hydrology increments.

## Visual lessons that must survive the session reset

The owner rejected continuous raised borders around rivers, moat-like walls, smooth repetitive banks, spiky or striped terrain, and waterfall cuts extending as straight walls beyond the river. Noise alone did not provide erosion-quality structure. The close riverbanks in one rejected experiment were comparatively acceptable; the wider terrain was not.

Other observed failures: lake outlets stopping short, floating/overflowing wedges, terrain "sheets" crossing the outlet, abrupt surface geometry transitions, and water appearing to go uphill. These remain acceptance cases even if individual numerical checks passed on an earlier revision. A texture seam is known but cosmetic texturing is deferred.

Reference repo: `../whitewater`, especially `js/river.js` and `js/config/rivers.js`. Use its width, pool/rapid, bank, and waterfall ideas as references; its small, specialized terrain architecture is not directly suitable for planet-scale streaming. Whitewater and external canyon screenshots were shown in the old conversation. A fresh session may not receive those images; do not claim to have inspected screenshots absent from its context. The written requirements above preserve their main implications.

## Current working tree: preserve it

At this handoff the repository is `/Users/okkokauhanen/work/DATrain/feature/proj/spherecraft`, branch `codex-restart`, HEAD `0d0587a` (`river erosion`). Previous commit `a4abdd3` is `optimizations`.

The uncommitted rollback restores the established global terrain stack and removes the failed river-added hills/global erosion changes. **HEAD alone is not the accepted starting state.** Do not reset to HEAD or overwrite the working tree as a shortcut. Re-read `git status` and the relevant diffs at session start; the user may have changed them meanwhile.

Existing modified files before this documentation handoff:

```text
WATER_STATUS_HANDOFF.md
core/world/hydrology/WaterService.js
core/world/hydrology/riverLandscape.js
core/world/hydrology/riverLandscape.test.js
core/world/hydrology/waterWorkerCore.js
core/world/shaders/webgpu/advancedTerrainCompute.wgsl.js
core/world/water/riverValley.js
core/world/water/riverValley.test.js
core/world/water/riverValley.wgsl.js
templates/terrain-shaders/base/earthLikeBase.wgsl.js
```

The current cache algorithm version is `water-v18`. Current bank landscaping is sparse **cut-only retreat** from sampled natural terrain, applied after existing erosion/detail and before the final channel cut. It adds no hills and currently does not feed the Runevision pass. `bankReachM` is still **900 m** in code; the earlier user preference for terrain lifting only within a few hundred metres is not an implemented parameter change. Do not conflate cut reach with permission for broad lifting. No terrain lifting is active in this bank pass.

The retained river work includes width variation, lake-mouth overlap/flare, independently fitted descending surface levels, varying depth, ribbon/segment coverage fixes, and lake ownership. Preserve these unless measurements identify a specific defect. SWE, automatic waterfalls, and synthetic islands remain off.

Prior rollback validation, not rerun when this document was written: 230 tests / 28 files, 15 terrain shader variants, targeted lint and diff checks passed. A native Dawn/Metal check sampled 34,233 river positions across IDs 17, 12, 25, and 28 without downstream rises above 2 cm or missing channel samples. This does not prove every river, every LOD, or visual acceptance.

Read `AGENTS.md`, then this document, then the active October 8 section of `WATER_STATUS_HANDOFF.md`. Use `WATER_HANDOFF.md`, `WATER_GEOMETRY_HANDOFF.md`, and other historical notes for code context, not as instructions overriding this plan or the owner.

## Proposed architecture: authoritative regional feature data

Introduce compact **terrain feature tiles** using the quadtree's addressing conventions. The owner explicitly clarified that these must be integral generation inputs: always-available coarse tiles feed fine compute, and regional basin/drainage properties come from the same terrain stack. An observational cache or attached water-placement feature does not satisfy this. A larger compute/quadtree overhaul is authorized when measurements justify it. Keep generation storage and lifetime separate from ordinary render-tile texture layers.

Potential contents, added only when needed:

| Data | Purpose |
| --- | --- |
| Smooth regional base/control heights | Shared elevation foundation and bounded interpolation |
| Conservative cell/region bounds and displacement budgets | Basin containment and river feasibility |
| Relief/geology/erodibility parameters | Preserve existing feature character; later local tuning |
| Humidity/runoff and marine connectivity | Placement suitability and coarse drainage |
| Basin records | Shape, level, bed envelope, islands, outlets, ownership |
| River records and shared boundary crossings | Deterministic routes, levels, widths, profiles |
| Stable IDs, seed, source/config versions | Reuse, reproducibility, scoped invalidation |

Continuous fields can use texture arrays; variable feature/network records can use buffers. Measure binding counts, memory, fetch costs, and dispatch overhead before fixing a layout. Do not allocate every speculative field in the first increment.

A fine tile reads its owning regional feature tile and the required halo/neighbours. It need not wait for every intervening **render** LOD. Feature resolution and render resolution serve different purposes. Render fallbacks are not a safe substitute for pinned generation inputs.

Generate regional data deterministically. Canonical edge/corner ownership and shared river-crossing records must work across tiles and cube-sphere faces. Features spanning several regions need shared ownership/support. Do not let generation order or camera position change the world.

Regional data remain resident while visible descendants, in-flight compute, or active hydrology depend on them. Queue dependencies before children; do not consume every generation slot with children waiting for unavailable inputs. Keep handles/layers alive through GPU completion, and invalidate descendants by source-region version rather than a planet-wide counter.

Illustrative sizing only: a 16 km region sampled on a 64-by-64 grid has approximately 250 m spacing. Two RGBA32F grids occupy 128 KiB before halos/records; 64 such regions occupy approximately 8 MiB for those grids. This is not a selected configuration or total memory estimate. Resolve actual planet scale and runtime tile sizes first.

## True minima: define the contract before reshaping terrain

Use metres relative to the planet's sea-level reference. State exactly which generation stage each bound covers. A sampled minimum is not a conservative bound on terrain between samples or after later erosion/detail.

For ordinary land, a useful starting model is:

```text
H_natural(p) = B(p) + R(p) + D(p) + E(p)

L_cell <= min(B over interpolation support)
          + minimum guaranteed relief contribution
          - maximum negative detail contribution
          - maximum erosion lowering
          - quantization/interpolation/numerical allowance

Therefore H_natural(p) >= L_cell throughout the cell.
```

`R` need not become an entirely new positive-only noise stack. First classify and bound the existing terms. Preserve their appearance where possible, while giving the regional foundation and each later stage explicit displacement contracts. Ocean blending, clamps, meso terms, rolling hills, pits/seeds, and final micro displacement all matter; bounding only the headline mountain function is insufficient.

The owner explicitly accepts an erosion margin in the minimum. Derive the margin from the actual filter equations/configuration, including local strength/relief/style bounds and accumulated octaves. Keep the existing erosion character initially. Measured minima validate a bound; they do not replace its derivation.

A worst-case planet-wide margin may be so loose that it makes useful high lakes impossible or forces unnecessarily deep basins. Report bound tightness. Use local bounds or subdivision when justified before increasing excavation or flattening the terrain. Revisit the margin when parameters change.

Interpolation must provide continuous heights and suitable gradients without invalidating the bound. Nonnegative partition-of-unity weights keep an interpolated value within its contributing control values; overshooting interpolation needs a separate envelope. Ordinary averaged mipmaps are not minimum bounds. Store or derive conservative reductions separately. Include unresolved variation between samples and the entire interpolation footprint/halo.

Avoid hard per-box height platforms and grid-edge ledges. Geo-hashes define ownership/seeds/features, not abrupt constant-elevation patches. Avoid a global hard floor clamp that flattens established terrain. If a guarantee requires changing the terrain model, make that change explicit, scoped, and visually checked.

Intentional basin/channel excavation is an exception to the ordinary-land bound. It needs its own bounds and containment contract; otherwise subtracting water features invalidates the very guarantee being advertised.

## Constructed basins and outlets

Choose candidates from regional elevation/geology, humidity, footprint clearance, and marine connectivity. Humidity is a useful placement bias, not proof of a basin. Exclude accidental overlap with oceans; isolated low inland ground must not automatically become an ocean merely because it is below sea level.

Construct a basin with a bounded shape and explicit level `L`. Two guarantees are needed:

1. A connected intended wet interior lies below `L` by a useful depth margin.
2. A closed surrounding contour stays above `L` by a containment margin, except at explicitly declared outlets.

An ordinary-land **lower** bound helps guarantee the rim. It cannot guarantee a wet interior: high existing relief may still occupy it. Interior construction therefore needs a smooth excavation envelope/cap or controlled relief attenuation within the basin. Purely subtracting a small noise depression from a high mountain does not guarantee a lake. Account for later **positive** detail as well as erosion so the wet interior remains connected. A smooth transition must meet both height and gradient requirements.

Keep the irregular outline, depth variation, and optional islands independently refinable. Start without synthetic islands. Islands, when introduced, must not sever the required wet connectivity. An alpine lake on a regional upland is straightforward; a lake partway up a steep massif may require a local shelf/cirque feature with its own guarantees. Do not promise that regional minima alone solve every placement case.

Closed lakes are valid. For draining lakes, solve the basin and its outlet together: shared level, submerged overlap, natural shoreline flare, and an initial descending reach. A coarse rim search/flood fill can choose plausible outlet locations and detect unwanted gaps. Selectively plugging a small gap remains an option, not a default raised ring around the lake. Prefer adjusting level/site/shape before large fill.

Fine flood fills should validate or refine a bounded known basin rather than repeatedly search/grow huge full-terrain patches to discover one. Bound the fallback work and expose failure explicitly instead of silently producing floating water or containment walls.

## Coarse drainage and finer placement

Create lake/catchment nodes and shared cross-region connections. Connect higher **actual water elevations** to lower receiving lakes, trunks, or sea; coarse minimum/average ordering alone is not sufficient. Strict descent across directed edges prevents cycles. A feature region may have multiple catchments/ports; do not force one river or one water level per square.

Route on a small coarse grid/graph first. Consider terrain barriers, approximate excavation, lateral containment, path length, and curvature. Existing downhill terrain is a preference, not a requirement: it is acceptable to carve through higher ground. Prefer a route needing a modest canyon over one bulldozing an enormous ridge.

Low ground beside a designed elevated water surface is a different problem: excavation cannot contain it. The route/profile must descend sooner, reroute, widen into a basin, or explicitly justify limited local fill. Do not solve it with a continuous embankment. Endpoint elevation order alone does not prove containment along the whole route.

Represent the surface and bed separately:

```text
eta(s) = L_source - (L_source - L_receiver) * F(s)
F is monotone increasing; reaches inherit fixed/shared endpoint levels.
bed(s) = eta(s) - depth(s)
depth(s) varies independently and remains positive in the wet core.
```

Use regional bounds to constrain/validate a route's surface profile, with local refinement where a coarse bound is too loose. Gentle rivers may have very small slopes. Steep reaches may allocate real drops to rapids or waterfalls while remaining descending. Do not insist the bed itself is monotone.

Publish a simple far representation from the coarse graph/basin descriptors, using the existing distant-water path where practical. Refinement improves the same stable features; it must not invent a different network at each render LOD. Local route optimization may inspect higher-resolution terrain in a bounded corridor. Avoid uniform large fine grids over an entire basin/river length.

## Carving and existing erosion: later measured increments

Keep carving predominantly subtractive. Give different river types different cross-sections, bank retreat, bend asymmetry, pools/riffles, and steep-reach treatment. Good carving must work through existing plains, hills, and mountains without requiring decorative river-side hill placement.

Explore feeding **broad basin/canyon shape** and local river/geology parameters into the existing Runevision evaluation before erosion, then applying a final guaranteed wet-channel carve after erosion/detail. This is a proposed ordering, not an established solution. The present bank atlas is applied after erosion, so it does not already provide that interaction.

A single existing erosion pass is preferred if it produces useful gullies running into the canyon without losing basin/channel guarantees. Retain the existing erosion strength/scale first; consider a light smoothly varying local multiplier only after proving why it helps. A separate local erosion pass remains an option if measured visual benefits justify its complete cost. Never reintroduce spiky noise, repetitive stripes, or broad uncontrolled amplitude changes under the label of erosion.

Preserve a small, explicit optional landscaping interface if needed later, but leave it off initially. If lifting is ever necessary, keep it local (the owner suggested a few hundred metres), sparse, and naturally integrated. No fixed-width raised river corridor.

Waterfall refinement must be confined to the wet reach and local geology, with irregular lip/abutments and a plunge pool where appropriate. Do not turn a whole terrain strip into a hard step. Cosmetic falling-water rendering is a later task.

## Experiment: reuse coarse generation for macro/meso/micro

The owner asks whether coarse generation can also amortize expensive terrain work. Explore this with measurements, after the regional contract is clear. Do not assume that render parent heights are suitable inputs or that caching automatically saves time.

Compare these candidates against the current independently evaluated stack:

| Candidate | What is retained/read | Main tradeoff |
| --- | --- | --- |
| Regional feature/control data only | Base and geology/feature parameters | Low storage, fine terrain still evaluates most noise |
| Macro + local detail | One resident coarse macro field; finer tiles add meso/micro | Simpler dependency/lifetime model, possible reuse of costly macro work |
| Macro + meso + micro | Regional macro; intermediate meso consumes macro; fine consumes meso | More reuse, but extra memory, fetches, dependencies and versions |

The first candidate is the lean starting point, not a permanent visual limit. Benchmark the other candidates before adopting a tier count.

Partition by **world-space wavelength/support**, not by render LOD labels. A coarse sampling grid can only represent sufficiently broad features. Keep shorter-scale features procedural or in a finer tier. Do not bake the entire erosion result into a very coarse grid and then magnify its gullies into smooth blocks. A promising hybrid caches macro elevation and geology, while the existing erosion evaluates finer relief locally.

Between-sample values are feasible through interpolation, but error and gradients are part of the cost/quality comparison. Match halo width, cube-face transitions, feature support, and curvature requirements. Smoothness alone does not restore missing sub-grid detail. Coarse samples of one analytic height field and interpolated coarse data are different surfaces; quantify the difference before switching generation over.

Adding local detail to cached macro data should represent a bounded residual. When meso/fine values deviate, their declared displacement budgets must preserve ancestor guarantees. Hydrology and final fine terrain must use the same base/contract. Keep feature identity and final world height independent of which render LOD happened to generate first.

Measure:

- Macro generation cost amortized across the number of actual consumers.
- Fine-tile ALU savings versus added texture/buffer reads and interpolation work.
- Extra dispatches, synchronization, queue latency, residency and cache-miss costs.
- Memory, halo duplication, seam handling, and regeneration amplification.
- Height/gradient error versus direct evaluation, visible LOD transitions, and loss of landform richness.

First benchmark equivalent visual content with caching on/off. Only after demonstrated net savings should saved budget fund a heavier macro stack. Architectural room for richer regional landforms is valuable; their actual redesign belongs to later terrain-quality work.

## Implementation sequence and gates

Each increment is independently reviewable. Record what changed, the hypothesis/confidence, what would disprove it, measured costs, and actual visual results. Stop between terrain-changing increments for the owner's visual review; an approval for one step is not evidence that the whole roadmap looks good.

| Increment | Scope | Required evidence before building further |
| --- | --- | --- |
| 0. Baseline and contract audit | Inspect current diffs/config/path; inventory existing height terms and costs; select repeatable sites | Reproducible current measurements; written bound/stage contract; baseline visual views |
| 1. Regional data prototype | Small persistent coarse generation payload consumed by fine tiles and hydrology; regional bounds from the same inputs | Seam/ownership/lifetime checks; explain interpolation changes; measured complete cost/memory; owner visual assessment |
| 2. Guaranteed regional foundation | Preserve old terms; implement explicit bounded foundation/refinement on a limited region | Derived conservative bounds, stress validation, continuous boundaries; existing terrain character retained |
| 3. One guaranteed closed basin | Controlled local basin with no river, including a high-elevation case | Connected wet area; protected rim; no ledges, skirts, floating sheets; bounded generation cost |
| 4. One outlet and coarse river | Connect basin to a lower receiver, terrain-aware coarse route/profile, immediate far proxy | Continuous wet junction; descending surface; lateral containment; full cost and far visibility |
| 5. Local route/carve refinement | Gentle through-hill and steep mountain cases; width/depth/bank profiles | Natural cross-sections/canyons, no border effect; acceptable outlet and LOD views |
| 6. Existing-erosion integration | One scoped ordering/parameter experiment | Visible improvement over current bank-only carve, stable guarantees, modest incremental cost |
| 7. Reuse experiment | Compare feature-only, macro-detail, and three-tier generation | Same-content cost/quality comparison; choose simplest winning option |
| 8. Wider coverage | Cross-region/cube-face cases, mixed lake types, network streaming | Stable graph, acceptable tails/memory, repeated live visual acceptance |

This order is adjustable when measurements expose a dependency. Do not bundle erosion tuning, tier caching, richer landforms, simulation, and water materials into the regional-data prototype. Basin construction must not wait for a global river rewrite; prototype locally first.

This table records the original roadmap, not instructions to restart completed increments 0/1. For a fresh session, read the latest owner feedback and replacement proposal near the top first, inspect the current diffs, and identify the actual next increment. The latest owner explicitly requested an explanation before further implementation. That request supersedes earlier autonomous continuation for this new direction; routine read-only investigation and documentation can continue. After subsequent owner direction, keep terrain-changing increments reviewable and obtain their visual assessment before building further on them.

## Measurement protocol

Use a fixed seed/config/device and a small repeatable case set: lowland closed basin, highland closed basin, gentle lake outlet through relief, steep alpine descent, and at least one tile/cube-face crossing. River IDs 17/12/25/28 are historical diagnostic cases, not guaranteed stable IDs after a network change. Re-select by stable feature/location descriptors when necessary.

Report cold startup, cold region generation, warm regional reuse, per-basin and per-river latency, and time to first distant water separately. Separate CPU active work, GPU execution when timestamp queries are supported, queue waiting, dispatch/upload/readback, and terrain regeneration. Label wall-clock measurements accurately when GPU timestamps are unavailable. Show workload dimensions, sample/segment counts, and cache mode with every timing result.

Use enough repetitions to characterize variation without making routine checks expensive. Report median and tail/range only when sample count supports them. Exclude warm-up/compilation explicitly; measure them separately. Do not double-count nested stages. Include amortized regional/network cost rather than hiding it outside a per-river timer.

Historical evidence from `../terrain-lab/out/river-phase-final-cost.log`:

| River | Reported bank stage | Complete refine call |
| --- | --- | --- |
| 17 | 29.9 ms | 3334.4 ms |
| 12 | 31.8 ms | 4034.7 ms |
| 25 | 40.1 ms | 411.3 ms |
| 28 | 45.9 ms | 668.9 ms |

These are **historical, pre-rollback measurements**, not a fresh `water-v18` baseline. The refine timer included lake work and excluded earlier global graph startup; the bank stage was nested within river work. This table exists to prevent reporting ~30 ms as the cost of an entire river. Re-measure before making current performance claims.

Track structural correctness: actual bound violations (with maximum deficit), bound slack, unwanted wet rim/corridor locations, wet connectivity, shared levels at junctions, downstream surface rises in metres, depth failures, continuity of gradients, deterministic boundary records, dependency races, and regeneration counts.

Track visual acceptance with actual engine/lab output: aerial overview, close bank cross-section, lake outlet, downstream/upstream view, steep reach, and LOD transition. Compare at identical locations/cameras. No synthetic/generated imagery may substitute for renders of the real terrain. Repeating spikes/stripes, raised borders, terrain sheets, and sudden walls are rollback criteria even if timings and mathematical checks pass.

## Code map and practical constraints

- `templates/terrain-shaders/base/earthLikeBase.wgsl.js`: existing natural terrain; currently natural height -> bank/valley cut -> final channel cut.
- `templates/terrain-shaders/features/featureErosionFilter.wgsl.js`: Runevision equations; derive displacement budgets here.
- `core/world/shaders/webgpu/advancedTerrainCompute.wgsl.js`: erosion wrapper, base gradients, micro detail in multiple paths. Preserve all relevant paths.
- `templates/configs/terrainGenerationConfig.js`: generation/filter parameters; verify active runtime overrides too.
- `core/world/quadtree/tileAddress.js`: quadtree addressing/parents/cube-face domains.
- `core/world/quadtree/tileGenerator.js`, `tileStreamer.js`, `GPUQuadtreeTerrain.js`: generation, texture layers, scheduling and residency. The default path remains independent; the experimental path now waits for pinned generation roots. Existing render refinement copies are not the regional hierarchy.
- `core/world/terrain-generator/webgpuTerrainGeneratorBatching.js`: base/classification/micro/normals pass chain consumes generated texture inputs. The prototype also binds coarse inputs to the terrain shader through group 2.
- `core/world/terrain-generator/regionalTerrain.js`, `regionalTerrain.wgsl.js`, `terrainHeightContract.js`: immutable six-root generation, bounded interpolation/gradients, regional lower bounds and displacement budgets.
- `core/world/terrain-generator/webgpuTerrainGeneratorPipelines.js`: layouts and current water/valley bindings; audit device limits before adding resources.
- `core/world/hydrology/HydrologyGrid.js`, `lakeRefine.js`, `riverRefine.js`, `waterGraph.js`, `waterWorkerCore.js`, `WaterService.js`: sampling, priority floods, routing/refinement, cache/publication. Verify filenames and active calls before editing.
- `core/world/hydrology/riverLandscape.js`, `core/world/water/riverValley.js`, `riverValley.wgsl.js`, `riverCarve.wgsl.js`: existing bank/valley/channel carve.
- `core/world/water/riverRibbon.js`, `WaterGpuData.js`, `waterWgsl.js`: shared water geometry/data and distant representation.
- `../terrain-lab`: native Dawn/Metal compute diagnostics using real production code. Useful scripts include `river-phase-cost.mjs`, `water-tile-cost.mjs`, `river-surface-gradient-check.mjs`, and `labsetup.mjs`. Inspect scripts before reusing them; some measure obsolete experimental paths.

The streamer currently seeds render tiles at depths 0–2 on all six faces and protects them from ordinary eviction. This is useful infrastructure, not proof that regional generation dependencies are already handled. The existing cache/layer reuse must be audited rather than assumed safe for parent-as-input generation.

Keep world data/generation/residency in `core/world`; render passes/materials in renderer modules. Keep parameters config-driven. WGSL has no `?:`; respect reserved names and bind/control-flow constraints.

Serve on the owner's port 8181; port 8000 belongs to the owner. Live visuals are the owner's decision. Historical notes allow native compute lab runs but require permission for headless browser runs; respect any newer explicit session authorization and sandbox requirements. No commits before visual acceptance and no pushes unless asked. Never commit `IMPLEMENTATION_PLAN*.md`; this new document is a handoff, and was not committed. Preserve unrelated user changes and inspect staged content before any future commit.

## Fresh-session prompt

```text
Continue SphereCraft from STRUCTURED_TERRAIN_WATER_HANDOFF.md. Read AGENTS.md, the full handoff, current position, increments 29–33, STRUCTURED_TERRAIN_REGIONAL_FLOW_ANALYSIS.md, whitewater-near/README.md and placement-defaults/README.md. Latest owner directions override historical restrictions. Preserve the uncommitted rollback/unrelated edits; HEAD alone is not the baseline. Do not restore rejected terrain/enclosing-hill experiments or reset/stage/commit/push prematurely.

Comparisons through 28 were rejected. I accepted increment 29's broad organic lake shape and asked not to get stuck reopening it. Increment 30 improves one local river course with sustained bends, varying nominal width and depth-mask source portals. I then rejected equal-width brown bank strips and asked for bank/lake shoreline textures and splat mapping. Increment 31's bank direction is better; I authorized improving/cleaning it up before we move on to water simulation. Final minor rock-blend polish and mountain captures are automatic checks, not new owner endorsement of every view or concept-art equivalence.

Use organic-banks/index.html for current actual production views, README.md/measurements.json for complete native and frame boundaries, and session.json/validation.json for source/evidence identity. Historical rejected visuals remain in handoff-screenshots/index.html and earlier galleries. References supplied only in chat are not local files. The common bank model supplies independent 23/7 m shore displacement, 1–45 m variable bank extents, bounded ±0.45 m spatial relief, a 6 m dry-bank cut cap and existing pre-lighting splat materials. New mode omits the uniform brown tint. The final rock mix reuses existing spatial noise; no added height/erosion/material pass. Short shore fields and physical limits share CPU/WGSL data, optional bank calls are omitted in legacy compute, and cache keys distinguish variants. The normal game now enables bounded planet-wide structured placement and organic banks. Historical fixed preview flags retain their original input scope.

Keep coarse terrain traits integral to generation and placement. My old normal-tiles-then-water-tiles workflow delayed rivers by one or two seconds. Publish water before first render tiles; do not repeat the complete terrain-tile stack for placement. Avoid repeated heights where possible, or use bounded lighter/supporting heights when complete measured return warrants them. One common contract with adaptive supporting data is preferred over independent mountain/plateau systems. Increment 30's foundation guidance saves only ~0.4 ms sampling on the gentle case and fails the mountain 24 m cut budget at 41.1 m; natural guidance remains default. Coarse region descent supplies a network skeleton, but a global drainage DAG/shared crossings/paging system is not implemented. Increment 33 supplies bounded distributed automatic site selection across six faces.

Simplified distant terrain-shader water is acceptable; nearby water needs geometry aligned to the same levels, shore and ownership. I now authorize Whitewater nearby flow and water geometry displacement. Increment 32 implements the first opt-in local reference-flow/SWE integration; use whitewater-near/index.html and README.md for actual motion, raw native/render costs and failed attempts. The unrestricted mountain solve is a measured failure; the adopted model balances the prescribed level and discrete base-flow defects. It intentionally has external sources/driving and derives visual discharge separately from placeholder regional Q. Preserve that distinction and the independent static fallback. No global hydraulics, obstacle wakes, spray, refraction or full fine-bed agreement is claimed. Close texture repetition, smooth faces, the old analytic gentle receiver and LOD/material boundaries remain explicit limits. Natural terrain already includes erosion; a new Runevision bank pass has not earned its cost. Consider bounded localized erosion only through measured visual return.

Final bank comparisons use ten identical addresses/types within each terrain case. Complete medians legacy→organic are 157.958→165.106 ms gentle and 135.419→139.551 ms mountain; fine adds 1.93/4.24 ms per ten tiles. Ranges overlap and first-round outliers remain: no speedup. First-use changed programs observed 51–77 seconds versus cached ~1.4 seconds; cold compilation is unresolved. The whole coarse moving view under 50 ms is still required and unproven; queue tuning remains outside this session. Finite channel/bank/texel checks pass. All 8,100 gentle and 2,220 mountain point floats match increment 30. Cleanup preserved 100 gentle base-mip outputs exactly; final material polish changes three classification/splat/scatter outputs, with all ten gentle height/normal outputs unchanged. Tests: 322 / 49 files.

Continue in small already-authorized increments. State hypothesis/confidence/disproof criteria; charge supporting fields, failed candidates, full fine outputs, publication, queue/fences, regeneration and overlapping memory. Use actual matched game visuals, shader/error checks, complete first-use/warm/reuse timings and comparable content. No synthetic picture substitutes for a render. Record all observations/failures/invalid attempts, revision/source identity, raw data, visual assessment and limits in the handoff/evidence catalogue before treating an increment as complete. Do not infer acceptance from tests or a good-looking isolated image, and do not repeatedly ask permission for already-authorized work.
```

## Session record

### 2026-10-08 — handoff only

- Captured the new architecture direction and preservation/measurement/visual requirements.
- Recorded coarse terrain reuse as a benchmarked option, with representation upgrades available.
- Checked current status, active notes, relevant code entry points, and historical timing logs.
- No generation, erosion, carving, rendering, or simulation code changed in this session.
- Next: fresh-session increment 0, then the smallest regional-data prototype.

### 2026-10-08 — increment 0: preserved baseline and height-contract audit

- Read the starting rollback, active configuration, terrain compute/quadtree and water paths; saved the independent source snapshot and binary working-tree diff before implementation.
- Identified the 131,072 m small-planet branch and actual height terms. Derived erosion/detail/micro/ocean/clamp envelopes in [STRUCTURED_TERRAIN_HEIGHT_AUDIT.md](STRUCTURED_TERRAIN_HEIGHT_AUDIT.md).
- Re-measured complete existing graph/river work. The main costs remain lake discovery/refinement, rather than the nested bank stage.
- Revised the prototype scope to the owner's clarification: authoritative coarse generation inputs consumed by fine compute and hydrology, rather than observational cached terrain.

### 2026-10-08 — increment 1: integral coarse inputs; original visual gate

**Owner clarification and scope.** Persistent coarse generation tiles must be the actual foundation consumed by refined LODs and regional water planning. This first experiment moves only the existing broad regional fields/land-region properties into six pinned depth-0 generation tiles. It does not reshape landforms, add hills, retune erosion, construct basins, or replace the existing river network. All work remains uncommitted; the rejected terrain experiment was not restored.

**Baseline preservation.** Saved the pre-edit working-tree source snapshot at `/tmp/spherecraft-structured-baseline-20261008` and binary diff at `/tmp/spherecraft-structured-start.patch`. The existing WaterService, worker, riverLandscape, riverValley and their tests remain byte-identical to that snapshot. Terrain shader changes were applied on top of the uncommitted rollback, not HEAD. Disabled-prototype GPU samples exactly match the independent rollback snapshot: 16,384 heights, zero unequal values.

**Hypothesis stated before implementation.** Reusing one resident tier for the established broad fields can preserve terrain character, supply conservative cell envelopes and reduce repeated macro evaluation. Confidence was moderate. Disproof criteria: visible smoothing/coast movement, grid-driven erosion, bound deficits, seam/dependency failures, or complete dispatch/fetch/regeneration costs exceeding savings. The current results disprove the performance-saving part for this layout. Visual suitability remains the owner's decision.

**Implementation.** Two RGBA32F texture arrays hold eight established regional values; an R32F array holds conservative ordinary-land bounds. GPU generation uses the analytic old fields, with a one-before/two-after control halo. Fine terrain and all hydrology paths use the same nonnegative 4x4 cubic B-spline controls and analytic gradients. Existing smaller features and erosion remain procedural at their original scales. A C2 guard returns to the analytic field at cube-face boundaries; its weaker global bound and extra compute are explicit prototype limitations. No render texture-pool layers are borrowed. All six roots complete before publication; concurrent requests coalesce, replacement is fenced, and a config/feature change during generation discards the stale result. Hydrology rejects dirty/mismatched sources; runtime source changes require rebuilding water records and regenerating affected descendants. Startup-only preview avoids mixing worlds.

**Height contract.** Current allowances: erosion 415.594 m, meso 270 m, micro 24.4 m, existing hollow 25 m and numerical allowance 1 m. Bound includes ocean blending and BOTH soft clamps, before intentional water excavation. Bounds on the new interpolated foundation are derived, not sampled minima of the old analytic terrain. The contract does not guarantee a wet interior. Zero deficits in 32,768 broad natural samples and 131,072 final tile samples per resolution. Same-face adjacent tile edges match exactly in the tested pair. Bounds are too loose for small mountain-flank lakes: 256-cell median slack ~817 m and highest bound ~524 m. Tighten local erosion/meso and positive-relief envelopes or subdivide before attempting alpine construction; do not compensate with deep excavation.

**Complete measurements.** Seed 12345, radius 131,072 m, max height 5,000 m, native Dawn/Metal, no IndexedDB cache; driver caches were not reset. Seven production 128² tiles at identical addresses, with height/normals/classification/micro/material/splat/scatter/climate/coarse-color outputs. Three warm rounds; cold/first-use work reported separately. 128-cell roots use 3.52 MiB, cold ~57 ms, root regeneration ~25–28 ms. 256-cell roots use 13.78 MiB, cold ~60 ms, root regeneration ~30–32 ms. Seven warm fine tiles take ~59–60 ms direct versus ~60–61 ms regional: no net saving. First regional seven-tile use at 128 cells took **42.15 s** (GPU compute ~83 ms), a serious first-use pipeline/driver stall; later 256 run reused driver caches. Do not advertise the warm numbers as cold startup.

One timer for rebuilding six roots plus seven full tiles measured 94–135 ms at 128 and 89–105 ms at 256, three rounds. One timer including roots, sampler, N=512 graph reconstruction, four river/lake solves, GPU water publication and seven tiles measured ~9.69 s / ~9.60 s respectively (one run each; no tail claim). Existing complete river calls remain ~0.4–3.8 s plus shared graph startup ~1.2 s, not the ~15–35 ms nested bank stage. Target 50–80 ms/river is not achieved. Existing water GPU capacity is ~133.63 MiB; seven returned fine-tile payloads total 3.72 MiB. Coarse replacement peak is 7.03/27.57 MiB, excluding other resources. Native process memory is GC/driver/profiler sensitive; raw observations are recorded rather than called production peak memory. Actual first-visible distant water is unmeasured; new coarse river surfaces remain increment 4.

**Visual evidence.** [Interactive comparisons](http://localhost:8181/tools/perf/structured-terrain-results/index.html) show actual production carved heights and lake/river shaders at matching cameras, plain diagnostic terrain material, with final tile micro omitted by hydrology sampling. The same baseline water records are frozen on both sides to isolate terrain changes. Cases: close banks, lake outlet, downstream reach, river overview, highland overview and a steep erosion patch. River 12 comparisons are also saved. The broad survey's maximum changes are ~101.5 m / 25.9 m for 128/256; the targeted steep patch reaches ~104.6 m / 26.7 m. Small bank-site differences alone would conceal that. Old network topology is sensitive: 128 changes one matching river from ~16.4 km to ~13.1 km; 256 keeps that route's length close but still changes lake IDs/counts. These images do not validate a new basin/network or live LOD transitions.

Live startup comparisons: [baseline](http://localhost:8181/wizard_game/standalone.html?regionalTerrain=0), [256-cell](http://localhost:8181/wizard_game/standalone.html?regionalTerrain=256), [128-cell](http://localhost:8181/wizard_game/standalone.html?regionalTerrain=128). Port 8181 was already serving the tree; port 8000 was untouched. No headless browser run. Query options override only in-memory enabled-planet config; default terrain remains unchanged.

**Validation.** 244 tests / 30 files, all 21 terrain shader variants; targeted lint and diff check pass. Valid final native benchmarks/regeneration/render runs report zero GPU validation errors. Earlier development runs exposed/fixed an exclusive auto-layout group-2 mismatch and a lab-only output-disposal race with optional splat probes; they are not acceptance evidence. Native benchmark scripts require the existing sibling `../terrain-lab` Dawn setup; JSON and PNG evidence is under `tools/perf/structured-terrain-results`.

**Original next step, superseded by the follow-up below.** Await owner visual assessment, then make the regional data useful for basin placement. Keep default off, preserve coarse-to-fine data flow, and avoid noise/tier/river rewrites bundled into this step.

### 2026-10-08 — owner assessment, GPU validation and placement feasibility

**Owner assessment and priorities.** The comparison viewer was "quite faithful," with slight changes at the lake outlet and steep erosion patch. After roaming, the owner said the visuals are "very much sufficient and very close to what they were before," with "no pathological behavior like increased load times." Initial browser startup was already slow; do not attribute that pre-existing delay to this prototype. This clears increment 1's visual gate. The owner then reiterated: keep the terrain compute stack largely as it is, demonstrate placement with regional base-height variation, and improve terrain features after lakes/rivers work. No basin/network visual gate has been cleared yet.

**GPU failure investigation.** The owner explicitly authorized fresh-profile headless Chrome diagnostics. The original 256 preview subsequently reached water-ready in a 120-second fresh-profile probe without a page error or device loss. That did not reproduce or establish the cause of the reported `Instance dropped`/`valid external Instance reference` failure. Two concrete pre-existing validation problems did reproduce: RiverBedBake sentinel uploads lacked COPY_DST usage, and asynchronous first-three splat diagnostics read caller-owned textures after disposal.

**Verified fixes, no terrain changes.** Added COPY_DST to the two uploaded river-bed buffers. The first three splat diagnostic submissions now snapshot their tile/splat outputs into diagnostic-owned textures and destroy them after readback; warm generation adds no copies. The additional transient copy payload is 80 KiB per 128² R8+RGBA8 diagnostic, at most 240 KiB for three outstanding probes (384 KiB if both source formats are RGBA8). Device-loss reason/message now logs in WebGPUBackend. No recovery or watchdog suppression was added. The original cause of intermittent instance loss remains unproven.

`structuredTerrainGpuHealth.mjs` delays the real diagnostic callback until returned outputs have been destroyed, reproducing six texture-use-after-destroy errors plus two invalid uploads before the fixes. The same test after the fixes reports zero GPU errors for both disabled and 256-cell paths; all three diagnostics run. Separate fresh-profile Chrome 154 checks exercised W/D/Q/E movement: baseline ~47 seconds, prototype ~92 seconds, both water-ready with zero page errors, validation events or device losses. These finite probes establish clean tested paths, not permanent recovery or a controlled cold-start speedup. Results: [native baseline](tools/perf/structured-terrain-results/gpu-health-direct.json), [native regional](tools/perf/structured-terrain-results/gpu-health-regional.json), [browser baseline](tools/perf/structured-terrain-results/browser-health-0.json), [browser regional](tools/perf/structured-terrain-results/browser-health-256.json). Roaming screenshots are saved beside them; their timed movement is not an exact matched-camera visual comparison.

**Repeatable camera review.** Added `qtDiag.regional.camera()` and `qtDiag.regional.useCamera(pose)` to copy a useful live view between configurations. Removed the earlier south-pole/planet-centre camera recipe from the review instructions. WASD moves along the surface; Q/E changes altitude. The helpers change only the camera.

**Placement hypothesis and result.** Hypothesis: the accepted coarse minima can directly support small highland basins without excessive excavation; this was checked before carving. [Placement check](tools/perf/structured-terrain-results/placement-check-256.json) chooses 16 separated highland cells deterministically from the highest authoritative bounds, then measures 33² natural heights per candidate on the unchanged production stack (17,424 samples). A ~102 m radius candidate, 8 m rim clearance, 8 m intended water depth and final-micro allowance require centre cuts of **755–2,508 m**. None meets the 100 m inspection ceiling. The ceiling is a feasibility rejection criterion, not an adopted terrain parameter; this finite highland sample does not exhaust all possible sites. Measured heights were never substituted for conservative bounds. No basin was carved and no deeper cut was adopted to conceal weak bounds.

The JSON reports one timer from lab setup through coarse generation, bound readback, candidate selection, sampler compilation, inspection and seven complete fine tiles/final fence; substage times and readback payloads are explicit. Coarse resident payload remains 13.78 MiB, with a 1.5 MiB diagnostic bound readback. Existing complete water/root/fine regeneration evidence remains unchanged; no new river performance claim is made.

**Preservation and checks.** All seven rollback WaterService/worker/bank/valley source/test files remain byte-identical to the saved starting working tree. The unfinished analytic mountain-envelope code and its proposed benchmark were deleted; regional generation/height equations returned to the visually assessed prototype. 244 tests / 30 files and 21 shader variants pass. Targeted lint has zero errors (two pre-existing WebGPUBackend unused-variable warnings); diff check passes. Everything remains uncommitted; no push.

**Exact next increment.** Demonstrate basin placement on the existing terrain. The broad root bound is insufficient to guarantee shallow small highland basins: derive the minimum additional basin-local accounting of existing relief/erosion/detail needed for the chosen candidate, or choose a demonstrably suitable existing low-relief region. This is planning metadata, not permission to improve terrain features. Do not blindly turn a bound into a lake level, substitute sampled minima for guarantees, or dig the failed candidate depths. Then show one actual guaranteed closed basin with wet-interior and rim contracts and obtain owner assessment before adding river carving or additional basins. Keep alpine lakes, early distant water, complete costs and representation upgrades in scope. Do not commit/push.

### 2026-10-08 — increment 2: one constructed basin on the existing terrain

**Owner steering.** The owner confirmed the game runs and looks unchanged and instructed continued work. No clarification was pending. Proceeded with the smallest basin increment; broad terrain-feature work remains deferred. Increment 1's acceptance does not accept this new cut. A visual assessment question is now pending with the comparison link below; do not add river carving or additional terrain-changing increments until the owner responds.

**Hypothesis, confidence and disproof.** Basin-local accounting of existing relief/erosion/detail can find a useful certified level without changing landforms. Initial confidence moderate. A violated envelope, excessive required excavation, terrain lifting, changes outside the footprint, or an uncontained/disconnected wet interior disproves it. Numerical feasibility is demonstrated for one upland candidate; visual confidence remains low/moderate because its outline is round and excavation is fairly deep. Do not call it production-quality or a mountain-flank/alpine success.

**Bound changes, no natural-height changes.** Account for positive relief jointly with the erosion strength it controls. Current joint lower contribution is -83.11875 m versus subtracting 415.59375 m after discarding relief. Bound existing meso/hollow modulations by the coarse interpolation controls. Repeated complete benchmark has identical direct-versus-regional height-difference statistics to the accepted prototype, zero broad/final deficits and exact disabled-rollback equality. Highest root minimum rises from ~524 to ~867 m. A planning-only local certificate then bounds the spline foundation and existing Perlin/FBM style, variation and meso over each candidate footprint; includes mountain's variation floor, existing uplift, both clamps, micro and numerical allowances. Derivation and limits are in the height audit. No mountain-envelope experiment, noise changes, erosion tuning or new terrain tiers were introduced.

**Integral feature publication.** `regionalBasins.js/.wgsl.js` select 32 separated low-relief candidates and publish one 32-byte basin record atomically with the root controls. Source/version keys include planning configuration and basin identity/level. Fine base-height compute applies its cut-only bowl after the existing natural stack; final micro is suppressed in the guaranteed wet core. WaterService consumes those same authoritative basin records through the existing lake table/mask/render interface, bypassing full-world discovery/refinement only in the opt-in structured preview. The normal old water path is retained. No lake physics, new textures, river placement or richer landforms were bundled into this step. Render-root texture-pool layers are not used for generation inputs. Planning mode/config changes rebuild roots rather than silently reuse incompatible records.

**Actual basin and contracts.** Radius 100 m, level 528.483 m, 8 m nominal depth, certified natural-final lower 531.483 m, 3 m uncut rim clearance. Connected <=50 m disk is at least ~3.266 m below water, with no later positive micro. Centre-cut estimate 72.449 m; maximum dense measured cut 72.498 m. Smooth excavation restores the original terrain by 100 m, with no lifted ring. 102,400 dense natural/constructed samples: zero deficits, raised points, outside changes or wet-core failures; measured outer clearance after subtracting worst final micro ~38.989 m. Nine full production final-height tiles: 147,456 texels including micro, 2,501 wet-core samples, zero wet/rim failures. The certificate is derived, not a sampled terrain minimum. First planner is intentionally limited to one-cell, non-seam, low-relief sites and equal physical/noise radii; later alpine placement must extend the same representation rather than become a separate terrain feature.

**Complete costs and memory.** Final isolated native run: setup through root generation/planning, GPU water publication and seven full-output fine tiles ~1.089 s with already used driver caches; roots+planning ~168.6 ms, water allocation/publication ~15.0 ms, first seven tiles ~573.4 ms. Three full regenerations (six roots, planning/readback, replacement water GPU data, seven tiles and final fence) **177.2–217.3 ms**, with shared root/planning 100.5–137.1 ms. Warm seven tiles ~62.5 ms with the basin versus ~62.3 ms with the same inputs/count zero: no meaningful terrain-cost saving. Planning readback 8,013,152 bytes, resident roots ~13.78 MiB including the new 32-byte record. Complete monitored workload live payload ~147.46 MiB; replacement peak **281.08 MiB** while old water remains alive until the replacement is ready. This is declared GPU payload after lab setup, not driver allocation size or the whole live game's render-pool/asset memory. Existing WaterGpuData's valley buffers were leaked on destruction; the destructor now releases all three, with repeated-allocation validation. Full old river costs still remain seconds; no 50–80 ms river claim.

**First-use warning backed by measurements.** First native use of the changed shaders took **43.731 s** through seven tiles (43.243 s fine wall time versus 88.5 ms fine GPU); this repeats the earlier serious pipeline/driver first-use stall. Saved first-use summary and later full measurements, without mixing them into a warm speedup claim. First fresh-profile browser preview reached water-ready at ~69.38 s; root compilation alone ~22.81 s. Subsequent reference reached ~10.54 s. Driver caches were uncontrolled; this is a material first-use limitation, not the owner's already existing loading delay being blamed on new code. No watchdog suppression or browser cache workaround was introduced.

**Early coarse publication and visual evidence.** The loading update path now publishes structured water before fine terrain is complete. Final fresh-profile health run: service ready ~8.317 s, GPU data published ~8.320 s with `initialLoadComplete=false`; initial load complete ~11.829 s. Service work ~1.3 ms after the regional plan. This establishes early metadata/GPU availability, not first visible water at a distant camera. Tiny basins can still be occluded by unresolved coarse terrain; a distinct far representation/visibility measurement remains necessary with the coarse river increment. Final finite browser probes have no page errors, GPU validation events or device losses; a resource 404 was logged.

[Actual game comparison viewer](http://localhost:8181/tools/perf/structured-terrain-results/basin-preview/index.html): matching closer/overhead cameras, complete production materials/detail/water. Lighting was not frozen. The bowl is plainly round and deep; show that honestly and wait for the owner assessment. [Live preview](http://localhost:8181/wizard_game/standalone.html?regionalTerrain=256&regionalBasins=1), then console `qtDiag.regional.basin()` reaches a safe review camera. `regionalBasins=reference` plans the same candidate but applies no cut/water, useful with a copied camera pose. Both preview choices are startup-only; defaults remain off. No new camera teleport into the planet.

**Validation/preservation.** 249 tests / 31 files, including 22 terrain/certificate shader variants, pass. Native complete/basin validation has zero GPU errors. Targeted lint has zero errors (two pre-existing GameEngine unused-variable warnings); diff check passes. Final independent rollback comparison: 16,384 disabled-path GPU heights exactly equal, all six retained worker/bank/valley source/test files byte-identical to the starting tree. WaterService changes are the explicit structured-data branch. No commits, staging, reset or push.

**Exact next step.** Await the pending basin visual assessment. If the depth/roundness is rejected, first tighten candidate placement/local containment enough to avoid a deep symmetric bowl; keep the natural terrain stack. If the owner accepts this as a placement proof, extend regional records to terrain-aware descending coarse drainage, keeping canyon carving possible and alpine sites in the same model. Measure complete shared/per-feature/network/regeneration costs and actual distant-water visibility. Preserve the initial representation's upgrade path; do not claim macro-tier savings or spend them on richer terrain. Do not restore rejected terrain work or commit/push.

### 2026-10-08 — basin visual assessment and bound audit

**Owner assessment received.** "the bowl is really ugly. However, I guess it's just a prototype..." The pending visual question has been answered. This recognizes the prototype while rejecting its appearance as a lake design; it does not reject the integral coarse-to-fine architecture or explicitly request broader terrain-feature work. Do not claim that the numerical containment result establishes acceptable lake visuals, and do not treat the round/deep bowl as an accepted basis for river carving.

**Diagnosed depth.** Selected natural centre 592.932 m versus certified natural-final minimum 531.483 m: **61.449 m of conservative slack** before the 3 m rim margin and 8 m nominal water depth. Thus the 72.449 m centre cut is mostly conservatism, not an intended deep lake. The symmetric radial cut makes that excessive excavation look like a manufactured crater. Improving the outline alone would leave the central problem.

**Small read-only audit, no new terrain increment.** `tools/perf/structuredBasinBoundAudit.mjs` derives a tighter universal sphere-Perlin envelope from the existing gradient table and convex fade interpolation. Corner gradient L1 norm <=2 gives a weighted maximum-distance bound; a degree-6 Bernstein enclosure of `fade(t)*(.5-t)` on [0,.5], subdivided once, proves <=5/128. Hence |Perlin|<=79/64 rather than the older loose allowance 2. Positive normalized FBM weights preserve it. This is a polynomial enclosure, not an observed noise range. It does not alter any noise equation.

Even provisionally reducing the largest linear micro allowance from 24.4 to 15.059 m would only lower this candidate's centre cut to **63.108 m**. That audit disproves tighter global detail accounting *alone* as a sufficient fix for this crater. The production allowance remains unchanged; before adopting any reduction, recheck all material envelopes (especially nonlinear sand) and final-height/containment validation. Evidence: [bound audit](tools/perf/structured-terrain-results/basin-preview/bound-audit.json). No natural heights, basin level, shader stack or preview geometry changed during this feedback turn. No commits/push.

**Next hypothesis and disproof.** Tighter *local rim* accounting and broader candidate selection on existing terrain can substantially reduce required excavation. Confidence moderate; if derived certificates still require deep cuts, or actual replacement visuals still read as manufactured pits, the approach is insufficient. Proceed with planning first, including the existing erosion/detail terms and suitable terrain depressions; do not replace guarantees with sampled minima. Then construct a basin shape that follows the terrain and show a fresh actual comparison for assessment before building further terrain changes. Keep noise/erosion/landforms intact and broader terrain quality deferred. The existing bowl stays off by default and remains diagnostic evidence only. This supersedes the previous "await pending assessment" next-step paragraph.

### 2026-10-08 — increment 3: local rim bounds and shallower placement

**Authorization and hypothesis.** Owner: "ok please proceed." Continued the placement/containment increment after the ugly-bowl feedback, preserving the natural terrain stack. Hypothesis: tighter local accounting and a broader elevation search permit substantially shallower excavation. Confidence moderate; persistent deep cuts or a manufactured-looking replacement disprove visual sufficiency. Required excavation improves numerically, but the captures still show a pronounced excavated bank. Do not describe this appearance as accepted.

**Planning on the existing terrain.** The finite certificate pool is now 64 separated candidates spread over the available elevation range, rather than only the highest flat plateau. Existing local meso sign/quiet/region masks, lake-hollow activation, and material micro masks are included in conservative interval accounting. The audited 79/64 Perlin envelope is used only in the planner, with padding; broad global displacement budgets remain unchanged. Forest, grass, nonlinear sand and generic material envelopes are all covered. No noise equation, erosion setting, natural height function, terrain feature or extra tier was introduced.

The best eight candidates receive 24 overlapping cap certificates each around their enclosing contour. The union covers the continuous 100–106 m annulus, including between sample directions. At this radius each cap is 20 m; its interval minimum, not its sampled centre height, determines containment. A low interior is allowed: the record's `lowerM` is now a **rim** certificate, not a minimum over the entire disk. Planner centre/rim samples rank excavation and orient the descriptor only. Source version is `regional-macro-v4-local-basin`; publication/regeneration still atomically bind the same records into fine terrain and water.

**Shape and numerical result.** One 48-byte paired-ellipse descriptor is oriented along the lowest opposing surrounding heights. It is cut-only at base-height level, restores the original base outside its compact support, and fits strictly inside the certified 100 m circle. Material micro is suppressed in its wet core as in increment 2. The selected site is different from the rejected bowl: cell 102878, level **513.119 m**, certified rim lower **516.119 m**, nominal depth 8 m, 3 m guaranteed enclosing rim, 33 m guaranteed connected wet disk. Natural centre 532.821 m versus the rim certificate leaves 16.703 m of slack, compared with 61.449 m previously. Estimated centre cut **27.703 m**, dense measured maximum **27.709 m** versus the old **72.498 m**. The 35 m selection ceiling constrains centre excavation only, not all conceivable footprint heights.

Dense inspection: 102,400 natural/base-cut samples, zero rim deficits, raised base samples, outside-footprint changes or wet-core failures. Nine complete production final-height tiles: 147,456 texels, 1,743 core texels, zero wet/rim failures; minimum observed final wet depth **3.347 m** and rim clearance **18.211 m**. The loose *global* 24.4 m micro subtraction gives -5.588 m clearance here; that diagnostic is intentionally retained and is not the new local proof. Guarantees use the derived local material envelope; actual final textures include their real material micro. These checks do not claim all final micro texels equal the uncut reference inside the intended footprint.

**Complete costs, shared costs and memory.** Final isolated native run with previously used driver caches: setup through roots/planning, water allocation/publication and seven complete tiles **1.171 s**, with shared roots/planning **198.5 ms**, first seven tiles **622.0 ms**, water **17.9 ms**. Three complete regenerations including replacement roots, readback/planning, replacement water data, seven tiles and final fence: **176.0–225.1 ms**; shared roots **95.0–123.8 ms**, planning **65.9–94.7 ms**. Planning readback **8,016,736 bytes**. Matched nine-tile workloads at the actual lake, interleaved: basin 72.7/72.8 ms, reference 78.7/73.3 ms. Earlier repeat was ~71.7 ms both ways. No credible net fine-compute saving or new per-river performance claim.

Root payload **13.78 MiB**, complete monitored GPU payload **147.48 MiB** live and **281.08 MiB** peak while the old water allocation remains alive until replacement. The ~133.6 MiB default water capacity still dominates. Native process RSS sampled after setup/end: ~190.8/~778.1 MiB, including driver/unified allocations and the verification workload. This is not whole-game memory or a continuously sampled RSS peak; the separate macOS resource counter reported ~726.9 MiB, below the end RSS. Do not add process RSS to declared GPU payload. The readback arrays and candidate sorting are included in process measurements; planning still spends ~35–46 ms on CPU selection in several runs.

**First-use cost retained.** First use of the changed fine shaders: **43.383 s** complete, **42.869 s** first-fine wall versus **71.9 ms** GPU. Saved full `benchmark-first-use.json` separately. First fresh-profile browser preview published water at ~9.393 s but finished initial terrain at **46.356 s**; local certificate compilation ~1.018 s. This is the repeated real first-use limitation, not a warm speedup and not the owner's pre-existing loading delay. No watchdog or recovery changes were added.

**Actual visuals and early publication.** [New matching daylight comparisons](http://localhost:8181/tools/perf/structured-terrain-results/basin-local/index.html) preserve the old rejected captures separately. Pausing existing planet rotation gives the same ~0.749 sun/up dot for both views; it does not replace production shading. The first dark captures/timings are retained under `basin-local/first-use-dark`. Daylight browser run: water service ready ~8.321 s and GPU data ~8.323 s while initial load was incomplete; load complete ~11.416 s. Zero page errors, validation events or device losses; a resource 404 remains. Early data publication still does **not** prove first visible distant water before refined terrain; that measurement/representation remains pending.

Live preview: `standalone.html?regionalTerrain=256&regionalBasins=1`, then `qtDiag.regional.basin(); qtDiag.regional.daylight()`. `daylight(false)` restores planet rotation. Reference mode plans the same site without cut/water. Defaults remain off. Owner assessment requested: bank depth/shoreline sufficient for the placement prototype, or improve placement/carving before alpine sites and rivers. **Wait for that assessment before another terrain-changing increment.** Do not ask whether the authorization to work was received; this is the specifically required visual gate.

**Validation and preservation.** 250 tests / 31 files, including 22 terrain/certificate shader variants, pass. Targeted lint and diff checks pass. Native and browser diagnostics have zero GPU validation errors/device losses. Independent disabled-path comparison: 16,384 exact-equal rollback heights; the six retained worker/bank/valley source/test files remain byte-identical to the independent starting snapshot. GPU readback buffers now release in `finally`, including failed mapping; invalid/odd rim-fit and unsupported footprint settings are rejected. No staging, commits, reset or push.

**Next work after the gate.** If accepted as a placement prototype, extend this same regional-data model to alpine/mountain-flank sites and terrain-aware descending drainage, with canyon cuts permitted. The current low-relief candidate filter does not establish alpine coverage; it must be extended with justified local relief accounting, without redesigning the natural compute stack. If the bank is still rejected, improve placement/containment/carving first. Keep first-use compilation, full shared and regeneration costs, host/GPU memory, and early distant-water visibility measurable. Broad terrain richness, extra tiers, simulation and water texturing remain deferred. The rejected global terrain experiment remains removed.

### 2026-10-08 — increment 4: shallow depression and varying natural banks

**Owner assessment and scope.** Increment 3's visual gate was answered **"Improve placement/carving first"**. The owner said: "It has still too uniform basin edge over the waterline. And it still carves too deep. The edge should be more irregular and have more varying gradient." Follow-up: "but it looks almost same like the one I just posted there. Minor change if any". The paired-ellipse cap reduced measured excavation but retained the steep, manufactured collar. Increment 3 is rejected as a visual basis for alpine sites or rivers; its captures remain historical evidence. Continue fixing placement/carving within the current natural terrain stack.

**Hypothesis, confidence and disproof.** A higher locally certified water level, shallower excavation, and a terrain-fitted depression that preserves existing bank detail can address both excessive depth and uniform banks. Confidence moderate for appearance, high for the scoped numerical contracts. The hypothesis is disproved if the owner still sees a deep pit/uniform collar, if preserving local detail creates disconnected/poor shorelines, or if the continuous certificates or final-height checks fail. Numerical improvements alone do not pass this gate.

**Tighter planning without changing landforms.** The planner can now prove zero existing erosion over a cap when all eroded relief is absent and the entire regional-foundation slope is below the existing erosion onset. Relief absence uses the original feature activation thresholds and deterministic massif/range placement, including exact parameter draw order and hard footprint guards. Whole-cap cell membership and interval guards fail closed. The spline derivative is a convex sum of neighbouring control differences; the gnomonic chain rule yields a conservative slope envelope. If any proof fails, the previous coupled relief/erosion allowance remains. Rolling hills, meso and hollows occur after this erosion input and retain their existing separate allowances. This is a certificate improvement only: no terrain noise, feature equations, erosion settings, global budgets, or extra tiers changed. It does not restore the rejected mountain-envelope experiment.

The search now considers **128 separated candidates**, then **16 candidates × 64 overlapping 12 m cap certificates**, covering the same continuous uncut 100–106 m annulus. Centre heights rank candidates; certificate minima determine levels. Planning readback is **8,031,072 bytes**. Source version is `regional-macro-v5-basin-banks`.

**Different carving representation.** A **176-byte descriptor** carries 16 periodic radial start/outer-radius pairs fitted from existing surrounding terrain, with a plane trend removed for the shape fit. Positive cubic-spline weights preserve the support/width constraints. A varying quintic depression is subtracted from natural terrain; dry banks retain the existing meso/erosion and material detail instead of being replaced with one bowl surface. Cuts finish inside 96 m, leaving the certified 100 m contour untouched. A small cap guarantees a **12 m connected wet disk**, with final micro suppressed there and fully restored by 24 m. This is deliberately a smaller guaranteed core, not a claim that the whole visible lake outline is analytically connected. Refinable radial records remain an initial representation, not a final shoreline model.

Default preview depth changes **8 → 3 m**, rim allowance **3 → 1.5 m**, and centre-cut selection ceiling **35 → 12 m**. The ceiling is a candidate-selection estimate, not a universal maximum cut over arbitrary footprint heights. Current site: cell **86179**, face 1, regional x/y **163/80**, water level **576.266 m**, certified rim lower **577.766 m**, natural centre **581.467 m**. Centre-to-rim slack is **3.701 m** versus increment 3's 16.703 m. Estimated centre cut **8.201 m**, dense measured maximum **8.406 m** versus **27.709 m** previously. Sites differ between increments; the new prototype/reference images use the same new location and poses.

Dense verification: **102,400 samples**, zero rim deficits, raised base samples, outside changes or wet-core failures; 448 checked core samples. Nine complete production tiles including material micro: **147,456 texels**, 172 core texels, zero wet/rim failures, minimum final wet depth **3.050 m**, minimum rim clearance **4.954 m**. The retained loose global-micro diagnostic is negative and is not the tighter local proof. A base-height shape diagnostic uses 128 rays at 0.5 m spacing: shoreline radius **39–67.5 m**, dry-bank grades at 3/8/15 m beyond shore about **7.3° / 18.4° / 26.0°** at the 10th/50th/90th percentiles. These observations support more variable geometry but do not establish visual acceptance or final-micro slope bounds.

**Complete costs and memory.** Final isolated native run, previously used driver caches: setup through six roots/planning, water publication and seven full-output tiles **1,175.23 ms**. Shared roots/planning **186.55 ms**; planning **113.81 ms**, including **41.72 ms CPU selection**, **59.62 ms certificate compilation**, **7.09 ms certificate dispatch/fences**, and readback. Water allocation/publication **15.03 ms**; first seven tiles **607.92 ms**. Complete replacement/regeneration, including water, seven tiles and final fence: **226.71 / 209.06 / 185.70 ms**. Shared roots/planning within these: **137.65 / 106.09 / 97.64 ms**; planning within shared work: **97.63 / 71.34 / 67.87 ms**. Do not sum nested timings. Equivalent nine lake tiles with the same inputs/locations, interleaved: basin **75.03 / 76.01 ms**, uncut reference **82.05 / 75.14 ms**; no demonstrated fine-compute saving.

Root payload **14,452,608 bytes (13.78 MiB)**; monitored live/peak declared GPU payload **154,644,912 / 294,732,736 bytes (147.48 / 281.08 MiB)**, including replacement overlap and existing default water capacities. Sampled native RSS setup/end **167.05 / 741.95 MiB**; separate OS max-RSS counter **690.91 MiB**, below the end sample on this macOS run. RSS includes driver/unified memory and verification work; it is not continuously measured whole-game peak memory and must not be added to the GPU payload. No new river exists in this increment; the 50–80 ms per-river goal is still unmeasured.

**First use remains expensive.** Retained first changed-shader native run: **48,025.10 ms** complete, **46,925.38 ms** first-fine wall versus **83.89 ms** GPU. First fresh-profile browser completed initial terrain at **50.116 s**, with water GPU data ready at **10.012 s** and certificate compilation **1.271 s**. Subsequent browser run: initial load **11.875 s**, water GPU data **8.382 s**; uncut reference **10.875 s / 7.813 s**. Driver caches are uncontrolled, and the large first-use stall remains unresolved. Do not conflate it with the owner's pre-existing startup delay or hide it behind cached timings. Data readiness before initial completion still does not prove first visible distant water before refinement.

**New actual visual gate.** [Current three-view game comparison](http://localhost:8181/tools/perf/structured-terrain-results/basin-banks/index.html): closer banks, overhead, and at the shoreline, using the production renderer, materials, micro and LOD. Same poses and paused daylight rotation (~0.752 sun/up dot) for prototype/reference. The optional "Compare rejected banks" mode compares old/new captures at **different sites**, explicitly labelled; there is no old low-shoreline capture. Historical captures in `basin-local/` and `basin-preview/` remain untouched. Live preview: `standalone.html?regionalTerrain=256&regionalBasins=1&basinReview=4`, then `qtDiag.regional.basin(); qtDiag.regional.daylight()`. The new asynchronous question asks whether depth, outline and varying slopes are sufficient to proceed. **Wait for this assessment before another terrain-changing increment.** It is a visual gate, not a request to repeat implementation authorization.

**Validation/preservation.** 250 tests / 31 files including 22 terrain/certificate shader variants, targeted lint, and diff check pass. Native checks and both browser runs have zero GPU validation errors/device losses/page exceptions; a resource 404 remains. Disabled-path preservation: **16,384 exact-equal rollback heights**, six retained worker/bank/valley source/test files byte-identical to the independent starting tree. Browser profiles were separate and GPU workloads sequential. No staging, commits, reset or push; default features remain off.

**Exact next work.** If the owner accepts these banks for the placement prototype, extend the same regional model to alpine/mountain-flank sites and then descending coarse drainage with canyon cuts allowed. The low-relief filter currently does not establish alpine coverage. If rejected, continue local placement/carving fixes first, preserving the natural compute stack. Measure full shared/feature/regeneration costs, total memory and actual early distant-water visibility; preserve first-use evidence. Broader terrain quality, macro/meso tier adoption, simulation and water texturing remain later work.

### 2026-10-08 — increment 5: seeded reach variation in selected bank arcs

**Owner acceptance and refinement.** The increment 4 gate is answered: **"now it looks quite good"**. The owner requested longer descent above water in randomly selected portions to vary bank angles: "extending the boundary randomly bit further in some parts ... a longer range where the descent happens and a more shallow gradient". Increment 4 is an accepted visual baseline. Do not continue treating its assessment as pending. This small refinement is authorized; it does not authorize changes to the natural terrain stack.

**Hypothesis/confidence/disproof.** Extending only the fitted outer transition in a few seeded arcs can produce gentler stretches while retaining steeper stretches. Confidence moderate for visible effect; a uniform collar, excessive shoreline movement, failed containment or measurable extra fine cost would disprove sufficiency. Initial broad four-anchor interpolation softened too much of the bank and narrowed the slope distribution, so the final fit uses two compact patches; preliminary evidence is retained in `basin-bank-reach/benchmark-initial-pattern.json`. The final pooled slope range is also narrower than the accepted basin's; do not claim increased statistical variance. The intended benefit is selected wider transitions with other arcs unchanged, subject to visual assessment.

**Small integral-record change.** `bankReachM` is a validated basin-planning option: default **18 m** at the 100 m preview footprint, limited to 30% of radius and scaled down for smaller footprints; **0** reproduces the accepted fit. A seed mixed with the basin cell produces two separated circular patches. Compact cubic weights extend outer-radius nodes by a nonnegative amount, clamped at the existing .96r support limit. The current periodic spline then smooths the same 16 pairs. Start radii, site ranking, rim certificates, water level, inner wet cap and micro policy remain unchanged. No WGSL, terrain feature, erosion, refinement tier or GPU representation change: the same **176-byte basin record** drives fine terrain and water. Source version `regional-macro-v6-bank-reach` invalidates the dependent data coherently. Shape changes remain deterministic across LOD, camera position and regeneration. Pre-change regional source snapshot: `/tmp/spherecraft-basin-increment4`; accepted actual captures remain in `basin-banks/`.

**Geometry/contract.** Same cell 86179, water 576.266 m, depth/rim 3/1.5 m and connected 12 m wet core. Added outer reach at the 16 controls is **0–16.578 m**, with seven controls exactly unchanged. Across 128 dense radial probes, shoreline movement is **0–6 m**, mean **1.590 m**; this refinement can move the shore, rather than preserving it exactly. Measured dry-bank grade p10/median/p90 is **9.8° / 17.7° / 23.1°**, overall **5.3–29.2°**; these are base-height diagnostics after re-evaluating the shoreline, not final-micro slope bounds. Maximum base cut remains **8.406 m**. 102,400 dense samples and 147,456 complete production final texels retain zero rim/core failures, raised base samples or outside changes; checked final depth/rim minima remain **3.050 / 4.954 m**. The mathematical support/core/contour proofs are unchanged.

**Complete measured costs.** Final isolated native run with used shader/driver caches: setup through roots/planning, water publication and seven complete tiles **1,165.06 ms**; shared roots/planning **183.05 ms**, water **18.53 ms**, first seven complete tiles **610.26 ms**. Three complete replacement/regenerations: **261.27 / 226.90 / 204.96 ms**, including root rebuild, full planning/readback, water replacement/publication, seven tiles and final fence. Shared roots within these **153.58 / 114.07 / 111.57 ms**; planning within shared work **110.63 / 76.72 / 72.01 ms**. Equivalent nine full-output tiles at the same accepted/new basin: accepted **74.85 / 77.57 ms**, added reach **78.02 / 77.73 ms** (two interleaved rounds). This has no demonstrated net fine savings and no clear added steady fine cost. No new per-river result exists.

Root payload remains **14,452,608 bytes (13.78 MiB)**, record 176 bytes and planning readback **8,031,072 bytes**. Monitored live/peak declared GPU payload **154,662,192 / 294,732,736 bytes (147.50 / 281.08 MiB)**; the small live increase includes extra paired diagnostic/profiler work, not a larger regional layout. Native sampled RSS setup/end **205.58 / 775.88 MiB**, separate OS max-RSS **724.22 MiB**, with the same sampling/unified-memory caveats as increment 4. Complete GPU peak is not whole-game peak memory; do not add RSS to it. Fine WGSL is byte-identical to increment 4, and this used-cache measurement does not establish that the unresolved ~48 s first-shader-use stall is fixed.

**Current review.** [New same-site accepted-versus-extended game comparison](http://localhost:8181/tools/perf/structured-terrain-results/basin-bank-reach/index.html), captured with `structuredBasinBrowser.mjs --bank-comparison`. Both sides contain the lake; reference uses `regionalBankReach=0`, prototype `18`. Assess whether selected gentler banks and retained steeper banks provide sufficient angle variation before building further terrain-changing increments. Live preview adds `regionalBankReach=18&basinReview=5`; existing basin/daylight diagnostics still apply. Measurements and browser evidence are in `basin-bank-reach/`.

Browser prototype: initial load **12.096 s**, water GPU data ready **8.673 s**, shared regional wall **403.0 ms**, planning **108.8 ms**. Accepted reference: initial load **10.405 s**, water ready **7.733 s**, shared regional **66.4 ms**, planning **37.8 ms**. Prototype runs first; caches are uncontrolled, so these startup differences do not isolate bank-fitting cost. Water readiness still is not a measurement of first visible distant water before fine terrain. Both contain the same basin cell/level and all three camera poses match exactly. Zero page exceptions, GPU validation events or device loss; the resource 404 remains.

**Validation/preservation.** Final suite **250 tests / 31 files** passes, including 22 terrain/certificate shader variants. Targeted lint and diff checks pass. Both regional/certificate WGSL files are byte-identical to the accepted increment 4 snapshot. Independent disabled-path check: 16,384 exactly equal rollback heights and six retained worker/bank/valley files byte-identical to the saved starting tree. Native GPU checks and browser validation have no errors. No staging, commit or push.

**Next work.** Obtain the new visual assessment, then proceed with alpine coverage and descending terrain-aware coarse drainage in the same regional model if sufficient. Do not redesign natural terrain noise/erosion or spend unproved macro savings. Keep first-use cost, shared/regeneration cost, total memory and actual distant-water visibility measurable. Preserve the uncommitted rollback and unrelated work; no staging, commits, reset or push. Simulation, texturing and broader terrain quality remain later work.

### 2026-10-08 — bank-reach acceptance; advance placement coverage

The owner answered the increment 5 gate: **"it's sufficient now. We can revisit this later to polish it further. No need to go through extra effort now though"**. Both the shallow basin and its reach variation are accepted for this placement prototype. Stop polishing these banks; leave that for later. No visual question from increment 5 remains pending. Continue the original structured-generation objective with alpine/highland placement, then the coarse descending river network. Use the same terrain/basin model and preserve the natural compute stack. Audit placement/bound feasibility before constructing the next case, and show that case before further terrain-changing increments. The earlier unresolved first-use cost and distant visibility requirements remain in scope.


### 2026-10-08 — increment 6: small highland basin and integral LOD input

**Scope and hypothesis.** The owner accepted increment 5 and deferred bank polish. This increment leaves the accepted shape, terrain features, noise and erosion unchanged. Hypothesis: smaller elevated footprints can pass the same regional/final-height certificates when candidate selection considers the requested altitude. Confidence moderate; no certified mountain setting, excessive excavation, failed containment, or insufficient actual representation would disprove this case. This is coverage work before the coarse network, not terrain-quality work.

**Generic planner options.** `candidateMinM` separates coarse-pool admission from the final certified `minLevelM`; `maxRoughness` replaces the fixed lowland admission ceiling. The shortlist ranks the deficit to the requested level before centre-cut cost, then retains the original certificate and cut-budget checks. Without this, lowland candidates occupy all 16 detailed certificate slots even for an elevated request. Default values retain the accepted lowland result **exactly**, including all 176 record bytes/shape values. Source version `regional-macro-v7-basin-coverage`. Standalone preview exposes radius/min-level/roughness/cut-ceiling overrides; `structuredBasinCases.mjs` contains a diagnostic preset, not an alpine-special terrain branch. The same records, fine shader and water path handle either size/altitude.

**Read-only audit first.** `structuredBasinPlacementAudit.mjs` tested smaller footprints and sampled the existing setting. The strict 12 m excavation ceiling did not admit the tested 60/40 m highland cases. The 60 m preset uses `minLevelM=900`, `maxRoughness=1`, `maxCentreCutM=16`. Only this preview raises the selection ceiling; normal lowland defaults remain 12 m. Initial failed-shortlist and 12 m audit evidence is retained in `basin-highland/`. Do not call the read-only audit's cost a complete constructed-water cost.

**Selected case and proof.** Cell **146254**, face 2, x78/y59; water **1286.852295 m**, radius 60 m, certified enclosing-annulus lower **1288.352295 m**, depth/rim 3/1.5 m, connected wet core 7.2 m. Natural centre **1297.752075 m**, estimated centre cut **13.899780 m**, dense maximum **14.019653 m**. Surrounding existing terrain reaches **3009.356 m** about 4.5 km away. This is a snowy lake at a mountain foot, not proof of placement on arbitrary steep mountain flanks. The accepted varying radial profile scales with radius; its default added reach becomes 10.8 m. The same final-height certificate includes erosion/detail/material micro, retains fail-closed guards, leaves the enclosing 60–66 m annulus uncut, and cuts only inside .96r. 102,400 dense base samples: zero bound deficits, lifting, outside changes or core failures. Nine complete final tiles: **147,456 texels**, 88 checked core texels, zero wet/rim failures, minimum depth/rim clearance **3.050054 / 9.881472 m**. No sampled minima are substituted for the continuous certificate.

**Actual visual failure and representation correction.** The initial game capture rendered the small lake as an angular/star-like shape despite passing height-texture checks. Quadtree selection measured distance to tile centres on the sea-level sphere. Near 1.3 km-high ground this selected depth 8 at the lake, producing large triangles. Existing coarse terrain controls now also inform the quadtree's LOD distance: the same nonnegative cubic spline estimates continental shelf plus regional foundation elevation, blended toward sea level at coasts. It is a selection proxy, **not** final height or a minimum. Local peaks/erosion/detail and the face-seam analytic guard are not evaluated there, so this is not a general peak-aware LOD guarantee. Frustum/horizon culling retain their existing sea-level centres and height envelope. Fine terrain equations, mesh formats, renderer and basin shader are unchanged. The close lake now selects depth 11 and resolves its shore.

`QuadtreeGPU` uses an optional pipeline with only the two existing macro textures; no extra storage binding, field, readback or GPU buffer. Coefficients use spare space in the existing 256-byte traversal uniform, derived from the same immutable profile/features as the controls. The terrain generator owns/fences roots; `GPUQuadtreeTerrain` binds each newly published version before submitting traversal. Native regeneration verified the replacement after old-root destruction. Default-off startup uses the original sea-level pipeline. Runtime enabling after a startup without regional inputs does not create this optional pipeline; use the preview URL for that case. The initial coarse failure captures remain in `basin-highland/first-coarse-lod/`; the low review camera was also raised above natural ground for the final shoreline capture.

**Complete cost and memory.** Final isolated used-cache native workload includes generator setup, roots/full planning, quadtree allocation/compilation/first selection, water allocation/publication, seven fixed complete fine-output tiles and a final fence: **1157.360 ms**. Setup **305.556 ms**; shared roots **205.294 ms**, of which planning **144.868 ms** (readback 2.849, CPU selection 75.342, certificate compile 56.878, dispatch/fence 7.831). Quadtree setup/first selection **17.906 ms**, water **15.283 ms**, first seven complete tiles **609.177 ms** wall / **79.823 ms GPU**. Three complete replacement/regenerations, including rebinding/traversal and water/seven tiles: **266.770 / 280.764 / 279.870 ms**; roots within these **174.978 / 154.678 / 182.832 ms**, planning **143.506 / 127.937 / 127.211 ms**. No per-river result yet.

Equivalent nine-address full-output fine generation, natural versus carved with identical controls: natural **74.448 / 72.444 ms**, carved **72.813 / 72.427 ms**. No established fine saving. Full-sphere paired traversal diagnostic at four matching poses, with culling disabled for both: regional **.209–.385 ms GPU**, **.540–.718 ms submit/fence**, sea-level **.061–.193 ms GPU**, **.351–.615 ms submit/fence**. Regional selection increases visible leaves from 165–174 to 207–243; this is added visual content/work, not a speedup. No queue/visible overflows. Actual browser captures exercise normal culling/streaming.

Root payload remains **14,452,608 B (13.78 MiB)**, basin record 176 B, planning readback **8,031,072 B**. Existing quadtree buffers **4,981,676 B (4.75 MiB)** are included in the final workload monitor. Declared GPU live/peak payload **159,626,732 / 299,714,556 B (152.23 / 285.83 MiB)**, including water capacities, quadtree and transient replacement/fine/readback work. This is not whole-game render-pool/asset memory or physical driver residency. The LOD option itself adds texture views/bindings and a pipeline, not a field/buffer allocation; pipeline/driver memory is unmeasured. Native RSS setup/end **166.57 / 691.44 MiB**, separate OS max-RSS **639.56 MiB**; sampled/unified-memory caveats remain. Do not add RSS to GPU payload.

**Review and browser evidence.** [Actual highland comparison](http://localhost:8181/tools/perf/structured-terrain-results/basin-highland/index.html) provides closer, overhead, shoreline and mountain-setting views. Reference is natural terrain at the same site; both sides use the new LOD selection, identical poses and paused planet rotation. Small orbital/time drift gives sun/up dot .550286 versus .550328; sun directions are not exactly equal. Ask whether the **small-lake placement and representation** are sufficient to proceed to coarse routing, not for more bank polish. Live preset: `regionalTerrain=256&regionalBasins=1&regionalBasinRadius=60&regionalMinLevel=900&regionalMaxRoughness=1&regionalMaxCut=16`, then `qtDiag.regional.basin(); qtDiag.regional.daylight()`.

Prototype browser water GPU publication **8.737 s** while initial load remains incomplete; initial load **12.258 s**, shared roots **423.4 ms**, planning **143.4 ms**. Natural reference GPU publication **7.731 s**, initial load **10.779 s**, roots **116.7 ms**, planning **88.6 ms**. Prototype runs first and driver caches are uncontrolled; these differences do not isolate planner/LOD cost or solve the earlier first-shader-use stall. Zero page exceptions, GPU validation or device loss; one resource 404. Coarse publication precedes initial fine-load completion, but first *visible* distant-water time remains unmeasured. Context screenshot proves visibility after settling, not early visibility.

**Validation and next step.** **254 tests / 32 files** pass: 22 terrain/certificate variants plus four traversal parses/selection-helper validations. Naga-wasm rejects the existing storage-pointer queue helper accepted by Tint/Dawn; the full traversal variants are compiled/run by the native diagnostic and actual browser. Targeted lint/diff checks pass. Disabled terrain: **16,384 exactly equal** rollback heights; six retained worker/bank/valley files are byte-identical to the saved starting tree. Accepted lowland descriptor exactly unchanged. Both regional/basin WGSL files remain byte-identical to increment 5. No staging, reset, commit or push.

Obtain this placement/representation assessment before further terrain-changing increments. Then build the smallest terrain-aware coarse descending network, permitting canyon cuts and smaller mountain descents in the same regional model. Keep strict elevation/proof failures explicit; broad mountain-flank coverage is not established by this single mountain-foot site. Measure complete shared/network/local refinement/regeneration, total memory and actual early distant visibility. Preserve the existing compute stack; broader quality, tiers, simulation and water texturing remain later work.


### 2026-10-08 — mountain-pocket assessment and bounded audit

The owner says the increment 6 lake sits on a wide plain, rather than in an
alpine valley/pocket. This is **not accepted as alpine-pocket coverage**. They
explicitly authorize either improving that placement or deferring it to move
forward; no increment 6 visual question remains pending. Keep the accepted
lowland bank shape and the regional LOD correction; do not claim the highland
plain demonstrates valley placement.

Hypothesis: recentering within existing regional candidates might find a
natural pocket that passes the same 16 m excavation ceiling. Confidence low
to moderate; an isolated distant peak or deep required cuts disprove this
bounded attempt. `structuredBasinPocketAudit.mjs` reads 128 regional candidates,
samples 21x21 natural-height contexts at 150 m spacing (56,448 points), ranks
opposing rises >=50 m within 600–850 m with at least three raised sides, and
certifies up to 32 recentered proposals at 60/30 m radii with the existing
continuous 64-cap rim proof. Final ranking limits each parent region to two
proposals, covering 19 parent regions. Samples rank morphology only; none
replace certificate minima. No basin/water/terrain is changed by this audit.

395 proposals met the context filter. No tested site met both >=900 m water
and <=16 m centre-cut estimate. Best above 900 m required **76.24 / 73.74 m**
for 60/30 m radii; the least estimated cut at any tested elevation was
48.06 / 46.72 m, below the requested water elevation. This is a bounded failure,
not proof that no suitable natural site exists. Do not relax the guarantees,
raise surrounding mountains or reintroduce deep bowls to pass it. Tighter
local relief/erosion accounting and broader candidate discovery remain later
alpine-coverage work.

Audit only: final used-cache wall **663.02 ms**, context sample/readback
**26.19 ms**, rim dispatch/readback **17.06 ms**. First use **1620.79 ms**, with
context **846.65 ms**, retained in `basin-pocket/placement-first-ranking.json`.
Context input/readback payloads **903,168 / 225,792 B**; roots remain 13.78 MiB.
No water allocation, fine generation or world regeneration is included: these
are not complete generation/per-river figures. No GPU errors. Evidence:
`basin-pocket/placement-audit.json`. No terrain feature, bank or shader change.

Decision: defer mountain-pocket coverage and proceed to the smallest coarse
terrain-aware drainage connection using the accepted lowland basin model.
A read-only local recipient check found a second certified basin within 6 km:
cell 85918, water **571.262 m**, estimated centre cut **10.081 m**, below source
cell 86179 at **576.266 m**. That uses the same certificates/carve/shape with a
local regional-cell search, not a new lake type. Recipient audit **37.51 ms**
including 2.80 ms readback, .74 ms selection, 25.85 ms pipeline compilation
and 6.89 ms certificate dispatch/readback. `recipient-audit.json` retains this
preliminary result; full network/shared/publication/fine/regeneration costs
must be measured before any performance claim. Preserve all uncommitted work;
no staging/commit/push. Broader quality, simulation and water textures remain
out of scope.


### 2026-10-09 — increment 7: one generation-owned drainage connection

Hypothesis: a local certified receiver and a bounded terrain survey can produce
one shallow descending connection with cheap planning. Confidence moderate;
wet gaps, bad mouths, excessive cuts or complete costs would disprove it.
The accepted source remains cell 86179 / 576.266479 m. The same planner and
continuous certificates find receiver 85918 / 571.262268 m, 100 m footprint,
10.081299 m centre-cut estimate. A 128 m original-terrain survey (1,176 nodes)
feeds deterministic eight-neighbour A*; terrain height/grade penalize paths but
do not prohibit canyon cuts. Existing smoothing gives 76 points / 4,773.587 m.
Water descends independently of the natural bed and meets both lake levels.
Existing width/wobble, cut-only channel shader, water upload and near ribbons
are retained. No noise/erosion, feature or bank/valley algorithm changes.

Roots own both 176 B basins, survey/topology and canonical river/index records.
They publish atomically under `regional-macro-v8-coarse-drainage`; shared
certifier/survey compilation is charged explicitly. Fine terrain and water
consume the same records. Optional local basin search is bounded to one face,
rejects seam windows, and shares the original excavation/rim/core checks.
This is one lowland connection, not general alpine descent or a complete
planet network. Both enclosing basin annuli are deliberately opened at their
connecting mouths; `closed` means no outgoing river, not an intact rim after
channel excavation. Wet-core cut-only guarantees remain. No river simulation
or expensive legacy tracing/flood fill is triggered for these published data.

Final native workload: generator setup + six roots + two basin certificates +
route + quadtree init/select + water allocation/upload + ten full-output tiles
(seven prior fixed addresses plus source/middle/recipient) + final fence:
**1205.531 ms**. Setup **307.991**, shared roots **223.691**, quadtree **19.837**,
water **29.808**, first ten tiles **620.999 ms**. Root work includes macro
compile **40.292**, shared certifier/survey compile **80.198**, source planning
**64.258** and connection planning **20.554 ms** (receiver 11.235, heights .641,
route 3.001, index 4.589). Do not quote the connection planning as total cost.
Complete regenerations **341.067 / 350.928 / 319.484 ms**, including replacement
roots, rebind/select, water and ten tiles. Roots **203.934 / 199.637 / 197.201**,
shared certifier compiles **76.939 / 77.245 / 75.298**, connection planning
**15.077 / 17.267 / 19.570**, water **25.927 / 44.272 / 20.499**, ten tiles
**110.589 / 106.549 / 101.352 ms**. The ~50 ms complete/amortized per-river target
is not established. No multiple-river amortization benchmark exists.

Three identical river-site addresses/outputs interleaved with the same two
basins: channel disabled **42.733 / 25.014**, enabled **31.120 / 24.968 ms**.
Retain variance; no macro-tier/fine saving is demonstrated. GPU root payload
**14,452,784 B (13.78 MiB)**; extra basin 176 B; retained topology/route typed
arrays **15,112 B**, not total CPU memory. Logical planning readback
**16,079,936 B** and uploads **61,280 B** include both basin passes plus survey;
padded texture staging can be larger. GPU allocation live/peak
**160,090,320 / 299,702,732 B (152.67 / 285.82 MiB)** includes water capacities,
quadtree and transient replacements/fine/readbacks, excludes pre-monitor setup,
whole-game assets/render pool and driver/pipeline overhead. RSS setup/end
**175.87 / 622.49 MiB**, OS max **681.81 MiB**; do not add RSS to GPU payload.

1,800 dense segment/interior/central-ribbon base samples: no dry/lifted samples,
no downstream rises, minimum depth **.982239 m**, maximum sampled cut
**11.292786 m**. Three complete final tiles: **49,152 texels**, **624** central
wet checks, no failures, minimum final depth **1.507036 m**. These are sampled
validations, not a new continuous river-height proof. Natural regional minima
remain pre-excavation certificates. Regeneration identity is unchanged.

[Actual four-view river comparison](http://localhost:8181/tools/perf/structured-terrain-results/coarse-river/index.html):
reference retains both lakes, prototype adds river; exact matching poses and
paused rotation, small sun/up drift .752291 vs .752255. Browser: water GPU
publication **9.357 s** before initial-load completion **13.155 s**; reference
**7.735 / 10.705 s**. Prototype first; uncontrolled caches (certifier first
compile **946 ms**) prevent attributing startup difference to route planning.
Zero page exceptions/validation/loss; resource 404 persists. Existing ~48 s
first-fine-shader-use issue remains unproved fixed. Native first route-provider
smoke compiled **887.670 ms**; do not hide that behind used-cache numbers.

**Distant representation failed.** Settled high view shows disconnected water
strips from coarse terrain triangles; extending existing ribbons to 8–10 km
still hides most water behind the mesh. Separate early diagnostic hides only
its browser's startup overlay: data at **8.343 s**, first screenshot over
8.344–9.161 s shows a channel cut without reliable water, with refinement
pending. Further 10.165–10.420 and 12.430–12.794 s frames remain initial-load
incomplete. This disproves sufficient early distant rendering. Preserve
`early-browser.json`, the early captures, and `network-extended-ribbons.png`.
No extended range or renderer change is adopted. The owner accepts **near
placement/joins** and says to fix distant water next; a texture footprint is
explicitly acceptable if necessary. The later steering below takes priority.

**Validation:** 258 tests / 33 files, WGSL/native/browser checks and targeted
lint/diff checks pass. 16,384 disabled heights equal rollback exactly; six
worker/bank/valley files byte-identical to starting snapshot; accepted lowland
record exact. Regional/fine WGSL unchanged (certificate file adds only a
planning height entry). Snapshot `/tmp/spherecraft-basin-increment7`. Everything
uncommitted, default off. No stage/reset/commit/push.

**Latest steering:** owner is going to sleep and asks to take alpine placement
next. They propose extra regional data and somewhat costlier local search only
in promising valleys, with little increase in overall planning. This authorizes
one bounded placement experiment for morning review. Keep the accepted near
river and defer its distant fix temporarily, not silently drop it. Preserve
terrain equations and guarantees; measure whole pipeline/regeneration/memory.


### 2026-10-09 — increment 8: regional valley metadata, visual review pending

Hypothesis: a small generation-owned survey can identify promising valleys,
then spend local search only there, finding a small elevated basin without
changing landforms or making overall generation much more expensive.
Confidence moderate for one demonstrated site, low for broad coverage.
An unchanged plain setting, excessive excavation, invalid rim/core, or a
material complete-cost regression would disprove the useful prototype.
The owner also asks to analyze terrain features that publish their own
lake-ready sites after this increment; see the following section.

**Integral data and bounded work.** Optional `placement` configuration adds a
64x64 survey on each of the six pinned generation roots, using the original
terrain functions and shared macro inputs. Four floats store natural base
height, positive relief entering erosion, input landform slope and foundation
height. These samples rank morphology, never replace minima. Select at most
24 separated promising regions, then sample only their 17x17 contexts at 150 m
spacing. Opposing rises >=50 m and at least three raised directions nominate
up to 64 sites, maximum four per context. This run surveys 24,576 root points
and 6,936 context points, producing 401 proposals and 57 separated candidates.
Only 16 candidates receive full rim certificates. The source version is
`regional-macro-v9-valley-placement`. Roots own the retained survey GPU buffer,
CPU copy, candidates and resulting basin; publication/replacement/fenced
destruction follow the existing generation lifetime. Fine terrain and water
consume the same 176 B basin record. No new fine binding or noise/erosion,
feature, carving profile, mesh, renderer or tier changes.

**Useful conservative bounds.** Retain all previous fail-closed seam/cell,
ocean, feature-footprint and height-clamp guards. For this optional planner,
when the entire cap is proved to contain no positive relief entering erosion,
the existing cubic foundation derivative bound supplies `slopeMax`. The same
existing erosion steepness ramp gives a continuous lowering allowance
`-erosionA * variationMax * lowReliefAmount * smoothstep(start,full,slopeMax)`.
Both this and the previous coupled allowance are lower bounds; take their
maximum only under that guard. Generated erosion is unchanged. At the selected
site, the old general erosion margin rejects all tested 60/45/30 m cases;
the selected 60 m case would require a **40.87 m** centre cut. The tighter
slope bound admits **15.22 m**. The old 32-site pocket audit still fails even
with this extension; broader candidate discovery is also needed. Evidence in
`rim-feasibility.json`, `survey-original-bounds.json`, `survey-tight-caps.json`.

Rim caps now use the exact planar annulus distance under the optional planner:
`ceil(1.001 * sqrt(6² + 4*r*(r+6)*sin²(pi/(2*n))))`. Nearest-node angle is
<=pi/n; the maximum is at outer radius r+6, and gnomonic normalization is
1/R-Lipschitz. Ceil/margin and existing chord-padding remain. A 60 m radius,
64-node annulus needs **7 m** caps instead of the previous 10 m triangle bound.
This tightens coverage without omitting angular gaps. Default lowland/river
certificate behavior remains identical. Recentered sites can share one regional
cell; shape fitting now associates the selected centre, rather than the first
site with the same cell. Default unique-cell results are unchanged.

**Selected case.** Cell **233189**, face 3 x229/y142; centre
`[.6176532908520574,-.7813531162550992,.08939642061105856]`.
Water **1235.082886 m**, radius 60 m, certified natural-final annulus lower
**1236.582886 m**, unchanged 3 m depth / 1.5 m rim / 7.2 m connected core.
Natural centre 1247.306641 m; estimate **15.223755 m**, dense maximum
**15.608521 m** excavation. Context has opposing rise **323.809 m** within
600–850 m, five raised directions and up to 428.756 m rise. This is a valley
floor near existing mountains, not proof of a narrow cirque, arbitrary steep
flanks or world-wide alpine coverage. It uses the existing diagnostic highland
16 m ceiling; default lowland ceiling remains 12 m. No surrounding hills added.
102,400 base samples: no bound deficits, lifting, outside changes or core
failures. Nine final production tiles / 147,456 texels / 85 wet checks: no
wet/rim failures, minimum final depth **3.049961 m**, rim **8.360380 m**.
These observations validate the continuous proof; they are not its source.

**Complete measurement.** Final native setup + six roots + survey/search/full
basin planning + quadtree init/selection + water allocation/upload + seven
fixed complete terrain output tiles + fence: **1157.038 ms**. Setup **318.026**,
roots **177.522**, quadtree **20.322**, water **14.570**, first seven tiles
**622.216 ms**. Root work includes macro compilation **42.090**, shared planning
compilation **82.253**, survey/input construction/selection **22.675** (survey
dispatch/readback 5.819, local contexts 1.830, CPU coarse selection 3.092,
proposal selection 2.380) and basin planning **10.020 ms**. Logical root uploads
**526,912 B**, readback **521,488 B**. Supplied candidates avoid the former
8 MB coarse-field host readback and full-cell sort. Do not present the 23 ms
survey as total cost or claim a speedup over the different highland-plain site.

Full regenerations including replacement roots, survey/proof, quadtree rebind/
selection, water and seven outputs: **275.530 / 268.195 / 254.251 ms**.
Roots **169.926 / 160.752 / 151.437**, shared compiles **79.475 / 78.034 /
76.052**, surveys **26.624 / 17.814 / 17.162**, basin planning **10.649 /
6.286 / 5.343 ms**. Equivalent nine actual site addresses and outputs, natural
vs carved with identical controls: **80.470 / 78.048**, then **77.472 / 77.095
ms**. No fine savings established; no new tiers/heavier terrain adopted.
This lake increment does not establish the complete/amortized per-river target.

Root GPU payload **14,845,824 B (14.16 MiB)**. Survey adds **393,216 B
(0.375 MiB)** GPU and the same retained CPU copy, plus uncounted small JS
metadata/temporary objects. Complete workload GPU live/peak declared payload
**160,020,204 / 300,108,028 B (152.61 / 286.21 MiB)**. Includes water capacities,
quadtree and replacement/readback/fine transients; excludes setup before the
monitor, whole-game pools/assets, and driver/pipeline allocations. Native RSS
setup/end **169.18 / 687.63 MiB**; separate OS max **635.42 MiB**, peak footprint
**691.47 MiB**. Do not add RSS/footprint to GPU payload or call this whole-game
memory. Detailed raw memory counters are in `benchmark.json` and the native log.

**Real visuals and first-use caveat.**
[Four-view game comparison](http://localhost:8181/tools/perf/structured-terrain-results/basin-valleys/index.html):
natural reference vs constructed lake at exactly matching poses. Review
“Valley setting” then closer/shoreline views. The first context camera hides
the lake behind a hill; the second wide camera does not reliably resolve it.
Both failed poses remain under `first-context-occluded/` and
`second-context-wide/`. Final context views from the low side resolve the lake
with existing mountains nearby. No terrain was changed to fix a camera.
Paused rotation matches; sun/up drift .624781 versus .624685 remains.

Final browser GPU publication **8.261 s**, before initial completion
**11.905 s**; natural reference **7.572 / 10.389 s**. Roots **398.7 / 61.1 ms**,
shared compile **86.6 / 7.1**, survey **19.1 / 16.6**, planning **8.4 / 8.2**.
Uncontrolled cache/order prevents attributing startup differences to placement.
The earlier first browser run spent **2530 ms** in shared planning compilation
and **2819.5 ms** in roots (data 11.384 s, initial completion 14.897 s), retained
with the first capture. First read-only native survey compiled **1200.769 ms**.
Used-cache results do not fix the earlier ~48 s fine-first-use issue. Zero page
exceptions, GPU validation or device loss; one resource 404 persists. Settled
images are not proof of early visible distant water. River far rendering is
still required and unchanged; do not silently drop it.

**Preservation and gate.** 264 tests / 34 files pass, including survey/certificate
WGSL compilation, annulus coverage, invalid slope/config rejection, generation
replacement and cleanup on failed context dispatch. Targeted lint/diff checks
pass. 16,384 disabled heights exactly match rollback; six saved worker/bank/
valley files remain byte-identical. Accepted lowland descriptor, both accepted
river basins, all river point bytes and segment/cell indexing match increment 7.
Fine regional/basin WGSL is byte-identical to increment 7.
`basin-valleys/preservation.json` records these checks. No staging, reset, commit
or push. Snapshot before this increment: `/tmp/spherecraft-basin-increment7`.
Stop further terrain-changing increments for the owner's visual assessment.
The analysis below is authorized and does not implement another landform.


### Latest owner idea — have terrain features publish suitable lake sites

The owner asks whether discovery is becoming unnecessarily complicated, and
proposes terrain-generated valleys/other suitable features which already know
their lake spot, with water activation gated by humidity/other parameters.
**Recommended direction: yes.** The current discovery is a bounded bridge for
finding sites in unchanged terrain; do not keep expanding it into the final
generation model. Root ownership makes today's survey integral, but it still
discovers a site after natural features are evaluated. Creating a feature and
publishing its known usable interior together would remove that search.

Existing code supports this conclusion: `featureLakeBasinsHeight_d` adds
continuous FBM hollows with no enumerable canonical centres or enclosing-rim
contract; its own comment says inclined sites spill. Seeded mountains/ranges
already have discrete `mtnSite`/`mtnPlace` ownership and parameters, showing a
compatible deterministic feature pattern. Historical erosion seeds have
enumerable centres, but their nudge/verification design lacks the required
final guarantee and was not re-enabled. Their old pits/verifier are not a
shortcut to the desired feature generation. The shared `getClimate` model
already provides precipitation; no new humidity noise stack is needed.

A future regional **terrain feature descriptor** can carry the seed/type,
parent mountain/valley, centre/axis/support, foundation-relative floor/rim
envelopes, erosion/detail allowances, potential water-level interval, and any
outlet/connection. The same descriptor shapes terrain in fine compute and
publishes a water node if precipitation/retention policy permits. Dry features
remain meaningful terrain. Broad lowland depressions and alpine pockets use
the same feature/height-contract mechanism with differing shape parameters,
rather than separate alpine water placement. Keep ordinary terrain outside
each support and preserve the original surrounding features. A valley is not
automatically a closed basin: its floor/rim/sill or declared outlet must make
the usable water interval explicit. Humidity decides presence; it cannot prove
containment or depth.

Known locations eliminate morphology surveying, recentering and global
candidate sorting. They do **not** eliminate feature computation or accounting
for later erosion/detail. Begin with bounded per-feature certification or
reject an incompatible feature; do not reintroduce a wide search loop when a
recipe fails. When a closed-form recipe and displacement envelopes establish
both rim and wet floor, those certificates can become direct algebra rather
than sampled/discovered heights. Shared crossing ownership and river route/
canyon fitting still need work; a lake centre alone does not solve a network.

The measured removable discovery work is currently about 23 ms plus a 0.375
MiB GPU field/CPU copy. Proof/compilation/publication/fine costs remain; no
feature-first implementation or complete saving is measured yet. Confidence
high that explicit feature ownership simplifies discovery, moderate that it
can preserve visual character while giving shallow alpine basins. Artificial
repeated bowls, broad landform changes, unbounded repair searches, deep cuts,
or no complete equivalent-content saving would disprove the useful version.

After the current visual gate and the owner's direction, a proposed next
terrain experiment is one optional feature recipe publishing one known candidate, comparing
equivalent lake/context content and complete generation/regeneration/memory
against this survey. It must not become a broad terrain-quality rewrite or
spend speculative savings on richer noise. Distant river representation remains
an independent unfinished requirement; the owner's earlier acceptance permits
a texture footprint if appropriate. No implementation of this newer feature
idea has been started, and no new approval/permission request is pending.


### Session record — increment 9: terrain-owned valley and known basin

**Owner steering and assessment.** Increment 8 was hard to assess and then
explicitly criticized as a tiny blip on a plateau. The owner authorized pivoting
without stopping to a single terrain-generated valley feature, including
surrounding hills, with its own known lake-ready spot. Alpine/cirque reference
images emphasize enclosure and high-to-low river descents. After the new
[original / dry valley / wet valley game comparison](http://localhost:8181/tools/perf/structured-terrain-results/valley-feature/index.html),
the owner said **“It looks qutie ok now”** and requested an architectural
explanation. The enclosure is sufficient for this proof of concept; rounded
hills are not final terrain quality. The owner chooses Whitewater game's SWE
for later visuals/displacement once placement and carving are done. No SWE,
whitewater, waterfall or broader noise/erosion work was implemented here.

**Hypothesis/confidence/disproof.** A generation-owned valley recipe can publish
a known basin and explicit water interval without morphology discovery, while
providing visible enclosure and keeping the surrounding original terrain.
Confidence was moderate before captures; the accepted enclosure and analytic
contract support the single-feature hypothesis. Invalid bounds, deep/repetitive
bowls, external changes, expensive repair searches or worse complete equivalent
content costs would disprove the useful generalization. World coverage and
equivalent-content savings over discovery remain unestablished. No noise tiers
or richer macro stack are adopted from this result.

**Implemented data flow.** `regionalValleyFeature.js/.wgsl.js` builds one optional
96-byte terrain descriptor during generation of the existing six pinned roots.
Feature identity comes from world seed and configured regional face/cell, with
seeded subcell offset, axis, three hill parameters and irregular basin controls.
The proof-of-concept address is face 3, x229/y142 of 256 cells; automatic density,
multiple feature types and parent mountain ownership are future work. This is
not an automatically discovered natural valley. One macro/climate/root-bound
dispatch evaluates an anchor and precipitation and rejects incompatible land,
seam, height-clamp or lower-bound cases. It reads back **16 B**, evaluates no
detailed terrain heights for placement, and performs no search/repair loop.
The existing climate's precipitation activates water at threshold .25; dry
features remain terrain. The old lowland planner still searches/certifies
existing terrain and currently has no humidity gate. Both paths coexist; this
increment does not migrate all plateau lakes to the new recipe.

Fine compute first evaluates the original terrain/features/erosion. Within a
compact 500-by-350 m half-axis ellipse, the feature blends toward a macro-anchored
floor, two side hills and a head wall. Its old eroded/detail residual is bounded
smoothly to ±1.5 m with `tanh`, and later material micro to ±.5 m in the full-weight
part. This is an explicit local terrain modification, including relief damping
and intentional lifting, not preservation of every original interior landform.
Outside the ellipse, the original height is returned exactly. New hill shapes
are added after the existing erosion; they do not yet receive Runevision
erosion. Their rounded appearance is therefore expected. The old fine stack is
still evaluated: **no fine-noise skipping or savings is claimed**.

The feature's irregular depression shares the existing basin radial controls.
Its floor/rim budgets directly publish a valid level interval, before water is
enabled. The potential basin record remains available when dry so geometry
does not depend on water presence. When wet, the normal regional-water adapter
publishes its lake level/mask. Every detailed tile evaluates the same recipe
in world coordinates; no mesh-edit pass or per-tile site search occurs. Ordinary
lowland cuts remain the original cut-only basin stage after erosion and before
material micro. Feature buffer/layout and all pipeline keys distinguish the
optional variant. Existing versioning, replacement fences and cleanup apply.

Source water is **1243.096924 m**, radius **120 m**, connected guaranteed core
**14.4 m**, required depth **3 m**, required rim margin **1.5 m**. Macro anchor
**1247.596924 m**, precipitation **.259847641**, depression amplitude **9.7 m**.
Algebraic interval **[1242.901900,1243.096924] m** after erosion/detail/micro
allowances. Side hills add ~108/116 m and head wall ~90 m. The convex blend and
new-recipe global lower bound preserve existing cell lower textures; creation
rejects a recipe that could invalidate any bound in its support. See the height
audit for the stage and proof. Exit direction and higher-ground hints accompany
the record for future connections/canyon carving; these are **not** an alpine
route or a guarantee of natural downhill flow outside the feature. Quadtree
LOD proxy still samples the original foundation rather than local new hills.

**Complete costs, not just the anchor.** First native setup → roots/feature →
quadtree → water → seven fixed complete terrain outputs/fence: **50964.972 ms**.
Fine first use took **50459.104 ms**, retaining the unresolved ~50 s compiler
stall. Roots **138.950 ms**, feature setup inside roots **46.826 ms** (compile
45.213, sample/readback1.074). Full replacements including roots, quadtree
selection, water and seven outputs: **210.934 / 203.365 / 208.226 ms**. A second
used-cache process measured total **1097.497 ms**, roots **120.439**, first seven
outputs **617.827**, full replacements **212.826 / 207.275 / 209.431 ms**. Raw
first and second runs are retained separately; warm results are not a startup
fix. Nine actual feature-site outputs, dry versus wet with identical recipe
and addresses, measured **96.240 / 88.889**, then **89.158 / 88.234 ms**.
No per-river target is established. The preceding survey has different radius,
site/geometry and visual content, so total differences do not prove equivalent
content speedup. Structurally the new path omits its 31,512 discovery samples,
field/candidate sort and certification pipelines. Do not spend that potential
saving on richer terrain without a matched-content experiment.

Roots **14,452,704 B (13.78 MiB)**; one feature adds 96 B over normal basin roots,
retained typed parameters96 B plus uncounted JS metadata. No .375 MiB survey or
CPU copy in this path. Complete workload declared GPU live/peak
**159,626,700 / 299,714,524 B (152.23 / 285.83 MiB)**, including water capacity,
quadtree and replacement/fine/readback transients. Excludes pre-monitor setup,
whole-game assets/pools and driver/pipeline allocations. First process RSS
setup/end **184.52 / 397.89 MiB**, separate OS max **642.64 MiB**, OS peak
footprint **606.81 MiB**. Figures overlap; do not sum them or call them whole-game
memory. Root logical upload/readback **2464 / 16 B**.

First browser water GPU publication **37.875 s**, initial completion **86.951 s**:
root compile24.166 s and later fine compilation stalls. Original-reference
**7.706 / 10.899 s**, dry valley **7.702 / 10.631 s**, with warmed caches. A
fresh-profile used-cache health run: **8.397 / 11.975 s**, roots350.3 ms, feature
53.6 ms inside roots. Data publishes before refinement, but settled screenshots
do not prove first-visible distant water. Zero page exceptions, GPU validation
errors or device loss; existing resource404 persists. Four poses match across
all three states; small sun/up drift .625364/.625931/.625909 remains.

**Validation/preservation.** 269 tests /35 files, 24 terrain/certificate WGSL
variants, native actual Metal generation, targeted lint/diff checks pass.
102,400 dense basin samples and147,456 production final texels: no scoped wet
or rim failures; minimum final depth **3.703794 m**, rim **3.283957 m**. Dry/wet
base geometry is identical; zero extra cut from water activation. Separate
25,921-point whole-feature audit: **20,458 exterior samples exactly equal**
original; no old-cell bound deficit; maximum sampled lowering/lifting versus
original **18.263916 /112.887451 m**. This intentional new geometry must not be
misreported as “zero excavation” based on the dry/wet toggle. Threshold1 dry
climate publishes no water and keeps every sampled height exactly equal.
16,384 fully disabled heights exactly match saved rollback; six retained files
byte-identical; accepted lowland/both river basins exact; river point bytes and
segment/cell topology exact. Old basin apply/micro functions match increment7;
old certificate module matches increment8. An initial preservation check
compared the planning-only module to7 and failed because8 already extended its
proof; the corrected comparison checks the actual carving functions separately.
One initial native compile failed on reserved WGSL variable `target`; renamed
`recipeHeight` and reran validation. No staging, commit, push or reset.

**Next work.** Owner accepts enclosure and currently asks how plateau versus
alpine placement/carving is integrated. Explain both coexisting paths candidly.
Then build a measured high-to-low connection from a generation-owned feature,
with terrain-aware/canyon routing and independent surface/bed profiles. Still
fix reliable early distant river coverage (texture fallback authorized), rather
than dropping that requirement. World enumeration, feature types, hill erosion,
noise richness and Whitewater SWE/visual displacement follow placement/carving.
Snapshot before this increment: `/tmp/spherecraft-basin-increment8`.


### Session record — lake architecture reassessment, no terrain increment

**Superseding owner assessment/scope.** The owner says the raised surrounding
hills still feel artificial and asks for independent engineering judgment,
realistic natural placement, visual return per millisecond, and a unified
approach rather than special lake-type implementations. Earlier increment9
proof-of-concept acceptance does not establish satisfactory mountain quality.
Any engine/compute/quadtree component may now be reworked if beneficial. The
owner grounds size in natural basin geometry: small pockets in rugged terrain,
larger lakes on suitable valley floors; altitude alone is not a hard size cap.
Cheap plateau lakes can be common and expensive mountain sites rarer. Low-res
terrain must appear very quickly; fine streaming must keep up in fast motion.
Plateau polish is deferred. Whitewater SWE remains later visuals/displacement.

**Assessment and recommendation.** See
[full reassessment](STRUCTURED_TERRAIN_LAKE_REASSESSMENT.md). Stop polishing the
independent after-erosion enclosing hills. Use one connected-basin/containment
pipeline with a cheap known-footprint certificate fast path and bounded natural
basin analysis when needed. Adapt size/level to existing floor and enclosure;
small closed ponds can avoid finding a whole maximum-spill basin. A pond below
its sill does not feed a river until a natural/carved exit is verified. Minima
alone do not establish enclosure. Current mountain certificates deliberately
ignore usable positive relief and retain loose erosion/detail uncertainty;
shrinking radius alone did not fix the ~200m certification deficit.

The preferred architecture experiment is a generation-owned regional meso
shape field containing the important existing landforms/erosion, feeding BOTH
fine height generation and basin/drainage analysis, plus bounded fine residual.
This requires actual interpolation/connectivity/error contracts and updated
regional bounds, not sampled minima or observed slopes. It is a hypothesis,
not an adopted noise tier. Test equivalent existing visual content and complete
cost before adopting it. If good natural sites remain too rare, rework parent
mountain/valley generation coherently before erosion rather than adding hills
around arbitrary lake points. Generated hints must feed the same water records
and validation/carving pipeline.

**Read-only evidence.** New `tools/perf/structuredLakeReassessment.mjs` samples
original terrain with shared roots, no basin/valley/water modification, at four
existing sites, each with a fixed2048m patch and32/64/128/256² samples. Four GPU
sample/readback/fence rounds and six existing CPU flood solves per patch. No
complete world-yield measurement. At8m spacing, a rugged candidate rejected by
our certificate already contains closed sampled footprints with equivalent
diameters56/79/108/153m at1/2/4/8m above its low point. Its full-spill solve
reaches the patch limit and is unconfirmed. The former highland plain has only
0.19m depth to spill; raising water1m escapes. Accepted lowland original terrain
has a natural1.17m depression with357m equivalent diameter. These are promising
sampled candidates, not continuous/final-micro proofs or live lake visuals.
Natural basin17 shows that spill-level convergence at32/16/8m does not establish
outlet containment: only the8m solve reports a confirmed spill in this patch.

Second-process64² medians: sampling0.685–0.819ms, existing full flood0.510–0.925ms.
128²: sampling1.237–1.413ms, flood2.148–2.367ms.256²:2.848–4.067/8.988–9.675ms.
First-use/JIT rounds are retained. Complete diagnostic work2,819.453/962.422ms,
including all16patches, repeats, setup, roots and sampler compilation
1898.981/61.444ms. Secondrun adds chosen-level connectivity checks; this is not
a controlled cold/warm comparison. NOT complete production generation, NOT a
low-end measurement, NOT a50ms river claim. Roots13.78MiB; flood typed scratch
104/416/1664KiB for64/128/256², excluding height, JS/worker/driver/render memory.
EndpointRSS258.88/290.07MiB is neither incremental nor peak. No new runtime
regeneration; previous complete generation/replacement measurements stand.

[Height-map diagnostic](http://localhost:8181/tools/perf/structured-terrain-results/lake-reassessment/index.html)
uses actual sampled original heights and adjustable water levels, not game
materials or a proposed terrain change. First/second raw diagnostic reports and
binary height/footprint data are retained in `lake-reassessment/`. Viewer
browser check has no page exceptions. Targeted tool lint and diff checks pass.
No runtime modifications, staging, reset, commit or push in this assessment.

**Hypotheses/confidence/disproof.** Unified adaptive natural basins: moderate,
disproved by insufficient representative yield, excessive cuts or unusable
continuous certificates. Bounded shared flood affordability: moderate on this
machine, unproven low-end, disproved by complete refinement/transfer growth.
Authoritative meso input: moderate for the contract, low-to-moderate for visual
preservation/savings, disproved by softened ridges/gullies, normal artifacts,
visible residual suppression or worse total memory/startup/regeneration/streaming.

**Next increment and visual gate.** Instrument generation
waits/consumer counts and natural basin yield; prototype ONE bounded shared
shape input/common planner at a rugged site with a lowland control, keeping old
noise content. Compare interpolation/resolutions and final height/material/
normal outputs, cold use, shared and total costs, real fast travel and scoped
regeneration. Show actual original/shared/wet game views and obtain owner visual
assessment before another terrain-changing increment. Use deterministic density
and work caps; cheap certificates bypass flood. Bound rejection attempts as
well as accepted lakes. Coarse terrain cannot wait for optional detailed search;
final fine terrain and water need consistent source/cut versions. Preserve early
distant water as an unfinished mandatory requirement (texture fallback allowed),
then verify a real alpine exit/descending connection before SWE. Do not spend
savings automatically on richer noise. Keep engine-wide alternatives open.


### Increment 10 — compiled root pipeline reuse, terrain unchanged

Owner authorizes autonomous small increments toward rare small mountain lakes,
using own visual judgment, tight work bounds and ROI in architecture/visuals/
compute. This supersedes waiting for owner input at every prototype step;
continue showing actual comparisons and keep the owner able to assess them.
Preserve rollback/unrelated changes and do not commit or push.

First measured cost reduction: `regionalPipelines.js` reuses exact source/entry
pipeline sets per GPU device, bounded to four variants. No terrain or bind group
values are cached; every regeneration still rebuilds/uploads/generates current
resources. Changed shader contracts/devices remain separate. Failed compilation
is evicted and retryable; matching concurrent compilation is coalesced. Root
code now uses this helper; source equations and terrain version are unchanged.

Complete seven-output/water/basin workloadbefore firstuse46776.565ms,after1123.024ms.
This first-use difference is uncontrolled driver warming, NOT a startup fix;
~46s compiler stall retained. Complete regenerationbefore190.08/192.50/184.43ms,
after163.41/169.42/162.58ms: median190.08→163.41ms (about27ms improvement).
Rootcompile23.49/22.24/22.65→0.20/0.09/0.07ms with reuse. Fullroot generation
109.64/108.43/100.29→84.36/86.11/77.50ms. Same basin record and every reported
102400base/147456final contract measure; no deficit/wet/rim/exterior failures.
Declared workload GPUlive/peak154644912/294732736B equalbefore/after, excluding
pipeline/driver storage. Up tofour compiled sets retained perdevice; shader
source strings/driver pipeline memory are not in those GPU payload counters.
Rawbefore/after`pipeline-reuse/*/benchmark.json`. Ten targeted cache/lifecycle
tests pass; separate devices/source/entrychanges,failure retry and eviction tested.
Snapshot`/tmp/spherecraft-natural-basin-start-20261009`. No terrain visual change.
Next: one authoritative bounded regional shape input and natural basin planner,
with no enclosing hill recipe and a same-model lowland control.

### Increment 11 — original eroded shape as an authoritative terrain input

Hypothesis: one bounded regional shape can preserve existing eroded terrain,
provide continuous basin certificates, and avoid repeating that terrain stack
in nearby fine tiles. Confidence moderate for the tested pocket; low for world
coverage and lower-end hardware. Disproof: lost ridges/gullies/material detail,
visible interpolation boundaries, continuous/final-height failures, expensive
rejected searches, or worse complete generation/streaming/memory.

The optional `shape` input is one canonical quadtree generation region, currently
face3/depth7/x108/y69,128² cells plus cubic halo. The baker evaluates the ORIGINAL
natural eroded stack using the shared macro roots. Fine terrain and hydrology
consume the same C2 nonnegative cubic spline; inside its guard they skip the
old procedural stack. Outside they retain it; a C2 edge guard blends both.
No new mountain/valley/hill equation or global terrain retuning. Final material
micro remains procedural, capped to ±0.25m in the potential wet cells and their
retaining ring. Dry comparison retains original micro. New RG32F field packs
height, micro controls and cell ownership; uniform64B. 137352B GPU/89188B retained
CPU in the accepted case, plus bounded temporary planning/bake/readback storage.

Common morphology planner finds at most4 local minima and tries7 fixed rises,
with at most512 connected cells PER attempt, including rejection. Early rejection
on guard contact; no expanding search. Each spline cell has tight tensor Bezier
hull bounds, not sampled minima. Flood deliberately overconnects potential wet
cells, including diagonal ambiguity, at water+rim+micro+numerical threshold.
The enclosing full dry-cell ring and one wholly submerged core cell are proven.
Final scalar f32 allowance0.125m is restricted to controls within±10000m;
certificate coordinates are the SAME shader cell address used for ownership,
not approximate geographic sample bounds. Ordinary root bounds are checked
against the shape's convex global minimum and old micro allowance before
publication. The bed cut is monotone, at most1.5m, transitions over0.5m entirely
BELOW water; dry banks and surrounding terrain receive no excavation. This
does not invent a basin at an arbitrary point.

Accepted natural pond level860.619m, potential footprint bound76.984m radius,
65 potential cells; full core depth bound2.922m, full retaining-ring margin
0.583m. Visible pond is smaller than that conservative footprint. Native audit
10000 positions: interpolation/coordinate discrepancy max0.02569m, original vs
shared dry height max0.73145m, no raising/exterior changes, max cut1.500061m.
Production final textures147456 samples:49 core samples, zero core/rim failures,
minimum observed core depth3.368m/rim1.094m. Those observations supplement the
continuous proof; sampled error alone is not a guarantee.

Complete workload includes setup, roots/shape/planning, quadtree initialization,
water publication, seven fixed plus nine lake-area complete height/material/
normal/splat outputs and fence. First46621.355ms includes46112.656ms first fine
work: existing~46s compiler stall remains. Complete regeneration159.658/156.139/
158.229ms. Shared shape regeneration8.908/8.165/14.454ms including compile lookup,
bake/readback, bounds/search, contour upload and fence; CPU planning3.509/2.688/
9.548ms (jitter retained). Root total33.776/28.003/30.946ms. Water publication
13.738/17.733/16.214ms, not only service CPU publication. Interleaved identical
nine-address full output medians: original75.608ms/dry shared61.893ms/wet61.927ms.
Original bypass uses the same shape-enabled pipeline; tiny bypass overhead is
not isolated. Dry game views preserve nearby features in these poses, so local
reuse has promising ROI; this is NOT universal noise-tier adoption. No spending
savings on richer terrain. Declared GPU live159724724B/peak299839908B includes
this workload's pools/resources, excludes pre-monitor setup and driver/pipelines;
endpoint process RSS is not peak or incremental. Different prior workloads
cannot establish total-memory savings. CPU hull optimization3.703→0.807ms median
in20 interleaved calls (last15), exactly same bounds; complete workload jitter
does not establish a regeneration gain from that optimization alone.

The same natural planner rejects the accepted lowland control:28 capped attempts,
mostly512-cell budget or open boundary; do NOT expand work to force acceptance.
Retain cheap constructed plateau placement. 64/256² shape-only probes find the
same pocket at levels861.132/860.515m with20/229 potential cells. These change
interpolation/footprint and are NOT adopted on those stage-only costs; complete
outputs and actual visual comparisons would be needed. The128² prototype is
still one configured region, no world paging/density/humidity gate and no scoped
streaming regeneration. Coarse roots currently await shape preparation. Those
production architecture tasks and representative yield remain required.

Actual [original/dry/wet game comparison](http://localhost:8181/tools/perf/structured-terrain-results/natural-basin/index.html)
has four identical poses, daylight rotation, production LOD/material/water/micro.
Shore shows a pond in the existing mountain terrain; no artificial hill ring.
Dry/original landforms look preserved. Initial interpretation was a white near gap; increment12 coverage diagnostics
show it is shading, not a hole. Distant water is absent in this first capture;
coarse geometry can miss a small basin. The setting pose is occluded;
this capture is NOT a finished distant-water result. Next increment should
reuse a compact generation-owned bed/depth field for coarse shading without
changing terrain, before more placement changes. Browser wet/original/dry
water-ready9.321/8.890/7.596s, load-complete48.035/48.099/10.648s (uncontrolled
compiler warming); do not attribute that difference to terrain. No page/GPU
errors; one resource404. Raw `natural-basin/benchmark.json`, browser.json,
controls, plans, pre-optimization report and rejected lowland evidence retained.
79 relevant tests pass (12files), including shader variants, final contracts,
rejected-work cap, configuration replacement and custom contour publication.
Targeted lint passes. Rollback/unrelated changes preserved; no stage/commit/push.

### Increment 12 — generation-owned coarse lake coverage/depth

Hypothesis: a compact bed/depth description of the same regional terrain will
keep a small pond visible when coarse triangles miss the depression, without
raising memory or changing placement/height. Confidence moderate, supported at
this site. Disproof: false water on dry ridges, poor near/far continuity,
meaningful complete cost/memory regression, or inconsistent absolute levels.

Generate64² conservative scalar depths from the SAME spline and underwater cut,
allowing positive micro and numerical error. Store signed depths/coverage in the
EXISTING R8 mask bytes:0 outside,64..127 dry coverage,128 zero depth,129..255 wet;
positive range16m in the lake table's previous padding float. Quantization rounds
depth down;≤0.126m positive-depth loss. The sampled/bilinear render field does
NOT replace continuous basin certification. Renderer records carry actual lake
level separately from sampled bed depth. Near geometry uses potential coverage
and actual terrain depth; terrain shading uses the shared depth so coarse
geometry cannot erase the pond. No extra GPU texture/buffer/atlas dimension.
4096B more retained CPU (128² shape case total93284B). Common refined-water
interface accepts the field; ordinary masks retain their old path. Terrain,
water elevation and carving audits are EXACTLY the same as increment11.

Actual before/after game captures: Shore preserved, Distant now has a small bright
water reflection where the previous path loses the pond. Debug depth coverage
with near geometry disabled confirms a complete pond near and far. My initial
"white hole" interpretation was incorrect: the near bright patch is shading,
not missing water. Setting pose is occluded from its low angle. Water texturing,
reflection polish and simulation remain deferred. [Actual water comparison](http://localhost:8181/tools/perf/structured-terrain-results/natural-surface/index.html)
includes both coverage diagnostics; do not confuse those debug colours with
final water appearance. No page/GPU errors; one resource404.

Same-process alternating complete16-output/roots/shape/quadtree/water regeneration:
field OFF155.920/146.661/145.731ms; ON145.468/149.145/146.491ms. Medians146.661/
146.491ms: no measurable total regression, NOT a speedup claim. Shared contour
preparation medians1.903/2.706ms (includes frame/mask/fence, about0.803ms more).
Water publication medians15.230/11.290ms, new upload path avoids the old boolean
max-pooling loop. Whole declared GPU live159724724B/peak299839908B identical to
increment11, driver/pipelines excluded. First1146.117ms vs previous46621.355ms is
uncontrolled compiler warming, not a startup fix. Raw `natural-surface/` including
`cost-interleaved/benchmark.json`, browser.json, coverage-probe.json and images.

Also fix terrain render bind-group reuse: replacing water buffers/mask during
regeneration must compare all FIVE water resources, not only whether water
exists. Stable resources still reuse the group. A focused backend test replaces
each independently and verifies the actual bound resource.111 relevant tests
pass (21files), including shaders, compact-depth quantization/clipped coverage,
publication format reset, lifecycle, root contracts and final terrain consumers.
Targeted lint/diff checks pass. Guard against division by zero when global micro
is disabled; the micro fraction then stays1. No other noise changes.

Still one configured region; world density/humidity, generation scheduling,
early cold visibility, regional paging and a real descending mountain river are
unfinished. This fixes this pond's distant representation, not every river's.
A64² equivalent-content/visual/flight comparison is in progress; stage-only
probes do not justify adopting it. A newly noticed ROI opportunity is water
pool allocation: the diagnostic currently allocates legacy full-world pools
(including unused valley pages) even for one fixed structured pond. Correct and
measure publication capacities against the actual renderer configuration.

### Increment 13 — immutable structured water capacity

Hypothesis: allocate from actual lake frames and indexed river segments, rather
than legacy full-world reserves, to reduce memory/publication cost without
affecting water. Confidence high for this immutable publication; disproof is
missing masks/segments, obsolete regeneration bindings, or visible changes.
Legacy asynchronous refinement retains existing pools. Future streamed regional
generations must grow/replace resources; fixed pools do not solve world paging.

Centralize capacity defaults. Structured publication sizes slots, mask layers/
resolution, repeated segment references and distinct cell blocks from its records.
Disable unused legacy valley pages: structured terrain owns carving. Keep the
existing global water index. Fix its partial last upload row for small auxiliary
pools. `waterPools=legacy` retains comparison. The64² signed field uses a64² layer
instead of upscaling to512². No height/noise/level changes or new GPU representation.

Same-process alternating COMPLETE16-output/roots/shape/quadtree/water regeneration:
legacy143.642/149.349/145.943ms; compact139.698/135.671/136.753ms, medians145.943→
136.753ms. Water publication medians14.003→6.408ms. Owned water payload140116208→
12587440B (133.625→12.005MiB). Mixed-run peak174748660B includes legacy pools.
Separate compact-only workload live32195956/peak47219892B; complete regeneration
222.822/205.255/147.744ms, retaining process jitter. First1175.461ms; driver caches
uncontrolled, no cold-start claim.10000/147456-point height/cut/rim audits unchanged.

Actual [compact/legacy game comparison](http://localhost:8181/tools/perf/structured-terrain-results/structured-pools/index.html)
shows unchanged shore and distant pond. No page/GPU errors; one404. Browser-wide
declared payload compact live1453772196/peak1464892788B vs legacy1581300964/
1591323828B; all allocated formats recognized. Includes game render/assets,
excludes driver/pipelines; depth24 backing is estimated, not physical VRAM.
Full-game memory remains substantial (~1.35GiB compact live); no low-end success.
Native monitor excludes pre-install setup; do not combine it with browser counts.

Compact existing lowland river:76points/4773.6m, owned water12709104B,
workloadlive32683216/peak53395212B;1800channel and49152final texture samples,
zero wet/raising/downstream failures (624final centre samples). Complete ten-output
regeneration285.026/292.703/265.309ms; repeated certificate compilation76.8–104.1ms
dominates and motivates the next increment. Raw `structured-pools/`, including
browser, interleaved, compact-only and river reports.17 focused capacity/upload
tests pass; broader156tests/29files also pass after certificate-reuse integration.

Retain128² shape. Equivalent64² original/dry/wet views are close, but max original
height change1.885m vs128²0.731m; nine-output times do not establish a gain (64²
dry62.684ms vs previous128²61.893ms across processes). Saving101376B perfield is
small next to12MiB global water index/full-game pools.64² flight probe is not
comparable: wet/original mostly zero generated tiles vs dry churn, without matching
actual trajectories. Fast-motion behavior remains unproven.

### Increment 14 — reuse compiled basin/route certificates

Hypothesis: the remaining repeated shader compilation is redundant generation
work. Reuse the existing exact-source/entry-point, bounded four-set device cache;
keep uniforms, bindings, samples and plans fresh. Confidence high. Changed basin/
river identity, stale contract specialization, or no complete-cost gain disproves
the benefit. No terrain representation or placement algorithm changed.

Same-process alternating COMPLETE roots/two-lakes/route/quadtree/water/ten full
terrain outputs and fence: reuseOFF222.466/220.593/218.734ms; ON136.671/140.019/
134.926ms. Medians220.593→136.671ms. Shared certificate compile54.643→0.260ms
median; roots112–115→51–55ms. Not all84ms reduction is isolated compilation time:
retain full samples and do not assign the difference to a hidden substage.
Initial setup+complete1151.591ms (driver warm), ordinary regeneration152.492/
156.151/192.212ms. Source-key identity checked on every replacement;1800channel/
49152final samples match prior depth/cut results exactly, zero failures/GPU errors.
958indexed segment copies,19river cell blocks, zero dropped rivers. Owned water
12709104B; workloadlive32683216/peak53395212B unchanged. Driver/pipeline cache
memory is excluded; atmostfour exact source/entry sets are retained per device.

Raw `certificate-reuse/benchmark.json`.156 relevant tests/29files pass; lint has
zero errors and two existing unused-variable warnings in gameEngine. No terrain
visual change; increment13's matched actual game comparisons remain applicable.
This136.7ms complete workload includes shared world roots/selection and ten terrain
outputs; it does NOT establish≤50ms complete per-river cost or cold readiness.
Next: fixed-budget multi-region yield evidence, including unsuccessful placement.

### Increment 15 — fixed multi-region yield and independent visual controls

Hypothesis: the natural bounded planner works beyond the one selected pond.
Confidence moderate; disproof is low yield at bounded failed cost, visible
landform changes, weak setting, or sampled final-contract deficits. Diagnostic
only:384 deterministic canonical region centres, atmost4 height-eligible regions
perface (500–2000m), plus the old selected control excluded from yield. No morphology
reranking, expanded search or hand-picked successful-only cost. All25 fields use
the production generation/planner and are destroyed between cases. This is not
production global placement or an observational terrain cache.

15/24 selected regions certified, across allsix faces. Complete read-only survey
789.498ms includes setup, roots59.815ms, sampler compile60.521ms, hints22.393ms,
all region generation/bounds/planning/contour preparation/fences. First shape
70.979ms includes49.067ms compile; remaining region median6.075ms,4.277–17.495ms.
World/readback sampler setup is NOT free shared cost. No full fine outputs/water
GPU pools/flight in survey total. Peak declared post-setup14729840B, one region
resident at a time; not a world-paging memory claim. Failed attempts cap512cells;
control excluded from15/24. Raw `natural-yield/survey.json`, all fields/plans and
`context-diagnostic.json` retain both successes and failures.

Full16-output native audits at steep region0/7/102/114 and higher region5/7/31/65:
first1133.800/1168.129ms; regen steep162.355/174.324/155.130ms, higher168.880/
171.976/174.317ms. Same required output/address count, each9 actual lake-area tiles.
147456finalpoints,49core each; zero rim/core failures. Steep mincore2.638m/rim1.777m,
higher3.258/1.035m. Max underwater cut1.5m, raising/exterior change0. Original/shared
height deviation2.856m/.286m; coordinate/interpolation error.02430/.00273m.
Steep proofdepth1.606m/rim1.107m, higher2.754/.554m. Field137352B GPU/93284B typed
CPU data (bounded JS metadata excluded); workloadlive32698728/peak47219892B.

[Actual independent-site game comparisons](http://localhost:8181/tools/perf/structured-terrain-results/natural-yield/index.html):
steep pond sits in existing erosion relief with no added enclosure. Original/dry
slopes closely preserved. The higher pond still looks like elevated rolling
ground; do NOT count altitude/containment as a convincing alpine setting.
This motivates a cheap setting criterion in increment17. Initial shoreline
camera was inside the steep mountain; invalid images retained separately.
Corrected poses clear terrain using the existing regional field, with identical
poses across modes. Shallow-angle distant view is occluded; separate overhead
distance captures show the small pond. Camera correction never changes terrain.
No page/GPU errors; one404 per browser. Terrain richness/texturing/SWE deferred.

### Increment 16 — remove rejected plateau candidate allocations

Hypothesis: allocating an object for every global cell before eligibility filtering
wastes CPU/GC time. Confidence high; changed ordered basin/river results or complete
regression disproves the benefit. Apply identical height/16control roughness tests
before constructing candidate objects; local receiver distance tests unchanged.
No new placement heuristic or terrain equation.

Sequential before/after COMPLETE ten-output/QT/roots/two basins/route/water/fence:
before164.911/203.496/147.561ms, after146.961/132.192/133.211ms. Medians164.911→
133.211ms; process/GC jitter prevents assigning all31.7ms to this pass. Source
selection25.566→14.707ms median. Source keys, every basin record and all1520 river
record floats EXACTLY equal.1800channel/49152final samples match previous audits,
zero failures/GPU errors. GPUlive32683216/peak53395212B unchanged. Avoid393216
temporary initial cell objects plus rejected intermediate arrays; no invented
object-byte estimate. Raw `selection-allocation/before|after/benchmark.json`.
287tests/41files passed before increment17; lint zeroerrors. No visual change.

### Increment 17 — bounded setting preference; first threshold is insufficient

Hypothesis: existing regional shape samples can distinguish a mountain pocket
from a contained depression on an upland plain, without extra noise or a new
lake-type algorithm. Confidence moderate. A weak setting surviving the filter,
lost good pockets, increased complete cost, or relaxed containment disproves
the benefit. The actual highland captures disprove the initial 20 m threshold's
visual sufficiency; tighten the preference in the next small increment.

Eight directions at each of 120/240 m use existing authoritative spline data.
A ring requires at least six available samples, four sectors above 15 m, and
an opposing pair above 20 m. Outside the full-weight region is unavailable:
reject rather than enlarge the field/search. This is a sampled setting
preference, separate from the continuous wet-core/dry-ring certificate. No
new GPU pass, texture, height equation or surrounding hills. Setting zero
skips context sampling entirely. Same four candidates, seven levels, and
512 cells per failed or successful connectivity attempt.

The identical fixed 24-region survey now accepts 6/24 instead of 15/24, plus
the old control excluded from yield. Complete 729.966 ms includes setup
301.911 ms, roots 65.163 ms, hint compilation 78.023 ms, hints 22.979 ms, and
all fields/plans/contours/fences. First field 67.156 ms; remaining median
6.452 ms, range 4.678–19.224 ms. 385 bounded attempts include all failures.
Post-setup declared GPU peak 14729840 B, one shape resident at a time.
Raw `natural-context/survey.json`; this is not production world paging.

Same-process complete 16-output regeneration, context OFF 138.112/144.026/
139.346 ms, ON 144.113/138.957/139.270 ms; medians 139.346/139.270 ms show
no measurable total regression or speedup. Control identity and all 10000/
147456 height samples match increment 11. Live/peak 32698728/47219892 B,
excluding pre-monitor setup, driver/pipelines. Correct baseline is
`natural-context/interleaved-no-probe-baseline/benchmark.json`; earlier
`interleaved` still sampled context while disabled and is not that baseline.

The elevated-plain case 5/7/31/65 is rejected. Full rejected-case work costs
162.365/161.958/155.974 ms, first 1098.221 ms with driver warm; 147456 final
height points, no cut (max exactly zero), raising/exterior changes zero.
Live/peak 32695656/47216820 B. No wet-core claim for an empty plan.

New case 3/7/10/96 passes 20 m: water 1355.565 m, potential radius 102.152 m,
proof depth/rim 3.039/.530 m. Final 147456 texels, 56 core points: observed
depth/rim 3.433/1.010 m, no failures; max cut 1.5 m, original/shared deviation
.12146 m, interpolation error .004586 m, raising/exterior changes zero.
Complete first 1140.348 ms; regeneration 161.154/185.144/142.409 ms; live/peak
32698728/47219892 B. Its actual game setting still resembles a pond on a broad
plain. Do not count this as a convincing alpine success. Preserve the captures
and report as a negative visual control. The steep 0/7/102/114 pocket remains
the convincing existing-relief case. Tests: 288 passed / 41 files.

### Increment 18 — prefer rarer settings after the negative visual control

Hypothesis: tightening opposing rise to 30 m and sector rise to 22.5 m rejects
the two broad-plain controls while retaining useful natural pockets. Confidence
moderate; lost steep settings, another weak setting, or increased complete cost
disproves its sufficiency. This is a preference, not a realism guarantee. No
search-domain growth, noise, carving change or extra lake-type algorithm.
Browser diagnostics use the production default unless explicitly overridden;
`shapeEnclosure=0|20|30` reproduces all earlier trials.

Same fixed survey: 3/24 retained (0/7/102/114, 2/7/10/9, 4/7/88/97), plus the
old control excluded from yield. Both high-plain examples now reject. Complete
830.597 ms includes setup 383.580 ms, roots 72.087 ms, hint compilation
64.199 ms, hints 24.112 ms and every field/failure/fence. First field 71.568 ms;
remaining median 7.043 ms, range 4.601–21.385 ms. 466 finite attempts, unchanged
14729840 B post-setup GPU peak. Different process timings do not establish
that the stricter preference itself costs the whole survey difference.

Steep complete 16-output same-process regeneration: preference OFF 160.932/
156.201/159.353 ms vs ON 154.990/147.532/154.308 ms. Medians 159.353/154.308 ms;
no measurable total regression, no isolated speedup attributed to a filter
that only adds work. Ordinary regeneration 165.163/156.747/157.767 ms; first
1243.646 ms. All 10000/147456 height audit results EXACTLY match increment 15.
Live/peak 32698728/47219892 B. Raw `natural-context/threshold-30/`.

[Actual comparison with positive and negative controls](http://localhost:8181/tools/perf/structured-terrain-results/natural-context/index.html).
The steep pocket is the strongest natural setting. Independent 2/7/10/9 has
more surrounding relief than the rejected high plain, but remains a modest
rounded pond; do not promise excellent mountain visuals from this preference.
Original/dry slopes are closely preserved. Water is 728.133 m, potential radius
72.478 m, proof depth/rim 3.020/.518 m; complete final texture audit has 147456
points, 49 core samples, observed depth/rim 3.428/1.010 m, zero failures.
Max cut 1.500061 m, original/shared deviation .18262 m, interpolation error
.008694 m, raising/exterior changes zero. Complete first 1269.952 ms;
regen 177.215/155.118/181.252 ms. Workload live/peak 32698728/47219892 B.
Raw `shape-access/before/benchmark.json` precedes the next shader experiment.
Actual browser water ready 8.570/7.893/7.741 s, load complete 12.695/11.424/
10.773 s; uncontrolled caches, no startup speedup claim. Zero page/GPU errors,
one missing-resource 404. Full browser GPU declarations around 1.35 GiB live
still prevent a low-end readiness claim. Shape remains one explicitly
configured canonical region; automatic world paging is not implemented.

### Increment 19 — reject the direct ownership-read optimization

Hypothesis: replacing a whole spline evaluation used only for ownership with
one cell-bit fetch reduces complete terrain cost. Confidence high in semantic
equivalence, low/moderate in cost benefit because compiler elimination may
already do the work. Disproof is changed height bytes or no complete gain.

Natural samples and all 147456 final height texels have IDENTICAL SHA256
before/after; all depth/rim/cut audit results match increment 18. Separate
process warm medians initially suggest 161.617→148.803 ms, but that is not
reliable attribution. Candidate first work 49074.394 ms includes a new-source
compiler stall; compare with warm source first 1241.755 ms cautiously.

Same-process complete interleaving uses separately warmed fine pipeline maps,
both compiled expressions, fresh roots/shape/QT/water/16 outputs/fence each
sample, and alternating order. Existing 157.847/144.646/142.740/140.027 ms;
candidate 148.150/147.971/145.304/142.812 ms. Medians 143.693/146.638 ms.
No useful gain; the runtime change is REMOVED. `regionalShape.wgsl.js` is
byte-identical to the saved pre-experiment file. No extra production flag,
uniform or variant remains. Declared workload peak 47219892 B unchanged;
interleaved live 32698728 B. Driver/pipeline memory excluded. Reference warmup
683.934 ms and candidate first-stall evidence are charged and retained.

Raw `shape-access/before-hashed|after|interleaved/benchmark.json`; candidate
shader and experimental runner are archived in `shape-access/`, separate
from the maintained benchmark. To reproduce, temporarily use the archived
candidate shader with the archived runner's `--ownership-cost`, then restore
the existing shader. Do not infer cold readiness or low-end performance.
Height checksums remain in the maintained benchmark as useful evidence.

### Increment 20 — shrink the immutable lake lookup grid

Hypothesis: the global lake lookup grid need not use 512² cells for at most
two immutable lakes. It selects records; unchanged 64² masks carry shoreline
and depth detail. Two records cannot overflow two slots even in one cell.
Confidence high for this bounded case. Lost near/distant coverage, changed
level/contour/height, network-index mismatch or complete regression disproves
the benefit. Publications with rivers or more than two lakes keep their
existing resolution; legacy asynchronous services are unchanged. Central knob:
`WaterService.config.gpu.structuredLakeGridN=64`, range 16–512 powers of two.
`waterIndex=512` reproduces the previous structured lookup; `waterPools=legacy`
also disables this policy. No extra shader, texture, binding or terrain equation.

Complete 16-output roots/shape/plan/QT/water/fence, warmed alternating order:
512² 182.323/147.212/152.229/142.474 ms, 64² 144.405/144.766/139.399/137.556 ms.
Medians 149.720→141.902 ms. Water publication medians 7.866→1.186 ms.
Owned water GPU payload 12587440→201136 B, saving 12386304 B (11.8125 MiB).
The retained CPU index and riverOf typed arrays also shrink, by 18579456 B
combined; this is declared array payload, not measured process peak memory.
Mixed index run peak 47219892 B includes the old grid and is not a compact-only
claim. Compact-only live/peak 19809652/34833588 B; first 1266.694 ms, ordinary
regen 151.106/157.936/137.684 ms retains jitter. Shared roots 22.871–40.659 ms,
shape 8.830–20.431 ms, water .958–2.826 ms. All 10000 natural probes and 147456
final texture bytes have identical SHA256 to increment 18; no core/rim/cut deficits.

[Actual near and distant grid comparison](http://localhost:8181/tools/perf/structured-terrain-results/lake-index/index.html):
shoreline, water coverage and distant pond match. Zero page/GPU errors, one404.
Whole browser declared GPU live 1441387156 B (64) / 1453773332 B (512), peak
1451885156/1465051496 B. Different streamed tile sets prevent attributing all
peak differences; owned water saving above is exact. Water ready 8.634/7.948 s,
load complete 12.245/11.013 s, sequential/uncontrolled caches; no startup gain.
Full game remains about 1.34 GiB declared live; low-end readiness not established.

Existing river control retains 512²: water 12709104 B, live/peak 32683216/
53395212 B, complete ten-output regen 154.003/140.081/147.150 ms; first
1245.975 ms. Same 1800 channel / 49152 final points, 624 centre samples,
zero wet failures/raising/downstream rises, final depth at least 1.507 m;
958 segment copies, 19 river blocks, zero drops. This is not a ≤50 ms per-river
claim. Raw `lake-index/interleaved|compact-only|river-control`, `browser.json`.
289 tests / 41 files, targeted lint and diff checks pass. Retain this change.




### Increment 21 — distant water from the generation-owned river bed

Hypothesis: the same channel profile used for final terrain incision can supply
render depth when coarse triangles miss a narrow river. Confidence high for
island-free carved structured reaches, moderate for actual distant coverage.
Dry-bank spill, changed close water/height, extra allocations or complete/render
regression would disprove the benefit. Retain after actual comparison.

One formerly unused segment float marks structured, carved, bounded-height,
island-free reaches. One existing parameter lane enables distant coverage;
no segment-layout, binding, texture, buffer, terrain shader or pipeline-source
change. Only beyond both near-mesh fade end and 1600 m does terrain shading
use profile depth, and only inside .85 of variable channel half-width, where
the terrain incision has full weight and final micro is suppressed. Subtract
.25 m scalar allowance; preserve the first point's backward-cap exclusion.
Legacy reaches, islands and close rendering retain actual terrain clipping.
Knob `WaterService.config.gpu.structuredRiverSurface`, diagnostic query
`regionalRiverSurface=0`. This is render coverage, not geometry displacement
or a new continuous river proof. SWE and water textures remain deferred.

[Actual comparison](http://localhost:8181/tools/perf/structured-terrain-results/river-surface/index.html):
the frozen distant pair has identical resident terrain/camera/lighting and
restores continuous water instead of intermittent dry-looking gaps. Close
outlet/channel/receiving-lake join match. Separate streamed screenshots have
different resident tile sets; use the frozen pair to assess the change.

Complete ten-output regeneration, alternating four rounds, off
148.329/137.267/134.551/130.986 ms; on 138.748/139.201/135.776/131.202 ms.
Medians135.909/137.262 ms; no material regression or speedup. Initial1275.508 ms;
ordinary regen159.171/171.916/141.007 ms. Shared route planning20.837 ms incl
receiver11.261, height sampling.729, route3.129, index4.461; global root/shared
certification and outputs are charged in complete figures. Not a <=50 ms
complete per-river claim. GPU water12709104 B unchanged; workload peak53395212 B
unchanged (live32180444 B, transient state differs across runs). Same sourceKey,
all1520 river floats and contract results as increment20:1800 channel/49152
final samples,624 wet centre samples,min final depth1.507 m,no wet/raise/rise
failures,958 indexed segment copies/19 blocks/zero drops.

Actual complete render+queue fence, four alternating120-frame samples per flag,
same frozen resident draw/pose/light and zero time delta: pooled medians off15.7 /
on15.4 ms,p95 20.0/19.8 ms. No measurable whole-render penalty; no shader-speedup
claim. Excludes game update/streaming, includes browser/queue/presentation
scheduling and does NOT isolate GPU execution. First diagnostic accidentally
ran the unrelated manual texture audit (invalid row pitch for current texture
format) and called a nonexistent parameter helper; archived under
`render-cost/invalid-manual-audit`, EXCLUDED. Corrected probe freezes the draw
without running that audit, updates parameters through the real service API,
and has zero page/GPU errors. Regular visual and early probes also zero errors;
each has one404. The manual audit issue remains outside this increment.

Early GPU publication8.575 s; first screenshot already shows river water on
coarse terrain, with existing LOD seams. At10.506 s 8/87 visible tiles still use
ancestors,252 generations queued; water is visible. Initial load complete12.416 s.
These are uncontrolled startup measurements, not immediate-startup success.
Product loading overlay is unchanged; hidden only in the early diagnostic.
Raw `river-surface/{interleaved,render-cost,early}` and browser.json.
290 tests/41 files, targeted lint (two pre-existing gameEngine warnings), diff
checks pass. Rollback and unrelated changes preserved; no commit/push.

Diagnostic correction: older `structuredRiverBench.pairedFine` blocks toggled
water enabled but not carve enabled; they do NOT prove equivalent river-off
content. Maintained runner now also toggles the carve parameter. Earlier raw
blocks remain archived and must not be used for that claim. Complete workloads
and final audits above were carved in both flags and are unaffected.

### Increment 22 — limit receiver reads to their regional window

Hypothesis: a nearby recipient search can read its existing candidate window
and spline halo rather than both fields across six faces. Confidence high in
content equivalence; changed candidates, certificates, river/height data or
no useful complete saving disproves the benefit. Retain after measurements.

`regionalFieldReadback.js` copies explicit origin/extent/layers, strips GPU
row padding and releases staging memory on success/failure. Receiver reads
25x25 lower bounds plus28x28 four-channel controls on face1, preserving its
4x4 support at EVERY candidate. Global initial selection still reads six faces.
Seam validation precedes copies; no expanded search, retained CPU cache,
new terrain equations or new GPU data. Generic window reads are reusable for
future generation/placement queries. Internal `_regionalFullReadback=true`
exists only for diagnostics; no product flag for transfer implementation.

Same-process four alternating complete ten-output roots/plan/QT/water/fine/fence:
full150.544/139.892/135.562/130.920 ms; window137.573/137.716/132.999/126.743 ms.
Medians137.727/135.286 ms, saving2.441 ms (~1.8%). Receiver planning medians
6.474/4.335 ms; aligned field-copy bytes8335872/20736 (99.75% reduction).
Dense returned payload+certificate readback8030048/32452 B. Global generation
still reads its initial fields; this is not a world-wide zero-readback claim.
First1348.657 ms; normal regen153.754/137.587/137.480 ms. Root resident14452784 B,
retained CPU planning15112 B, GPU water12709104 B unchanged. Workload live/peak
32683216/53395212 B unchanged: no claim of peak reduction dominated elsewhere.
Staging/copy volume and temporary returned arrays are reduced; process RSS/GC
and driver memory are not attributed to this change.

SourceKey, every basin record, all1520 river floats and complete channel audit
match increment21 exactly. 1800 channel/49152 final points,624 centre wet,min
final depth1.507 m; no wet/raise/downstream rise failures or dropped segments.
[Actual close/distant comparison](http://localhost:8181/tools/perf/structured-terrain-results/local-readback/index.html)
retains the same placement, bank and coverage. Reference page intercepts ONLY
the planner module to select full reads; terrain shader/options are unchanged.
Browser reports25x25 versusfull scope, identical basin records, no page/GPU
errors, one404. Separate runs have slightly different streamed resident sets.

Native raw `local-readback/interleaved/benchmark.json`; actualbrowser.json.
292 tests/42 files (padded row/face/halo equivalence and failed-map cleanup),
targeted lint and diff checks pass. No commit/push, rollback preserved.

### Increment 23 — read-only outlet feasibility, no terrain change

Hypothesis: existing authoritative regional controls can cheaply identify
rare inexpensive exits, while unsuitable lakes stay closed. Confidence moderate;
coarse blockers, excessive refined incision or no lower exits disprove a
universal cheap-connection assumption. This audit supports selective connection,
not a production alpine route or new visual success claim.

`structuredShapeOutletAudit.mjs` reads the three independently accepted fields
plus the earlier control. Full-weight interior only: a2x2-cell coarse graph
has2916 nodes, no boundary/seam expansion. Both lower/upper Bezier hulls guide minimum-crest routing; the optimistic
lower-hull path supplies an eight-cell-wide corridor refined on original cells,
hard cap4096 nodes. Only298/473 fine nodes are needed in the two connected cases.
The refined routes still use the same terrain input, with no noise sampling or
new GPU height probe. No sufficiently lower LOWER boundary hull => skip routing;
this avoids2916-node failed searches in each of the other two fields.

Independent steep0/7/102/114: coarse/refined crest18.772/18.584m above lake,
refined path243.504m, provisional descent74.532m and bed cut20.209m. Maximum
provisional surface grade1.052; blindly connecting this visual favourite with
a cheap/shallow profile would be a bad assumption. Highland4/7/88/97: coarse/
refined crest3.929/3.038m, path536.200m, descent22.167m and cut4.663m, grade.175.
This is a promising connection candidate, not visually assessed as an alpine
source. Independent2/7/10/9 and original3/7/108/69 lack a certified coarse
boundary cell20m below the lake IN THIS FIELD. That does NOT prove a globally
closed watershed; adjacent-region data is absent.

The provisional profile uses a running minimum of natural cell centres minus
.5m outside lake ownership, preserving lake level inside, with1.5m bed depth.
Costs use cell upper hulls+numeric allowance. Width, lateral support, diagonal
corridor coverage, smoothing, safe banks and near/far surface geometry are NOT
certified by this diagnostic. Do not publish it as a river solver or override
an existing lake containment proof with these samples.

Whole CPU audit33.262ms incl file IO,four hull builds,projection graphs,TEN
upper/TEN lower routes per case and TEN refinements where available. Per-case
complete13.813/6.747/8.671/3.936ms. Refined preparation+tenroutes2.079/2.368ms;
warm routes roughly.09–.25ms, first.476/.381ms. These are NOT complete generation or per-river
numbers. Baseline complete/shared/failed regional and output costs remain in
increments15–22; no new GPU generation, regeneration or visual changes occur.
Declared coarse scratch up to874356B plus68444B captured controls; additional
refinement scratch107554/132229B. JS objects, GC retention and process peak are
excluded. First coarse-only audit130.589ms (ten unsuccessful full searches and
cold JS stalls) retained under `natural-outlets/coarse-only`; do not hide it.
The upper-only corridor trial31.886ms is retained in `upper-corridor`. Coarse
upper maxima alone cannot prove minimum escape cost: lower-hull optimistic
crest bounds are16.838m for the steep case and2.670m for4/88/97, versus refined
upper crests18.584/3.038m. These bounds concern20m descent WITHIN this field,
not escape to unseen neighbours. Raw `natural-outlets/audit.json`.
Diagnostic lint passes; runtime tests remain
292/42 from increment22. No runtime code added for this audit.

Architectural decision: keep basin acceptance and outlet suitability as separate
regional properties. Minima alone cannot describe drainage; boundary/escape
connections must belong to the same terrain-owned canonical regions. A regional
portal graph and bounded refinement can reuse the same eroded field for plateau
and rugged settings, avoiding a separate mountain-lake search stack. Keep
closed ponds common among rugged accepted sites, connected sites rarer, and
reject excessive excavation rather than adding enclosing hills. Next terrain-
changing increment should first select a viable natural source and neighbouring
regional connection, then audit/compare the actual cut and surface. Do not add a
stream that simply terminates at this prototype field's edge. Automatic regional
paging and mountain-descending connections remain unfinished; this does not
exhaust architecture/streaming improvements or establish low-end readiness.


Increment23 visual gate: tested the cheaper candidate4/7/88/97 in the actual
game. [Actual original/dry/lake and outlet costs](http://localhost:8181/tools/perf/structured-terrain-results/natural-outlets/index.html).
It remains a shallow, rounded pond in rolling upland, NOT a convincing alpine
setting. The30m preference can still accept this because opposite rise is only
14.9m at120m, but43.1m at240m. Height alone, a distant enclosing-rise threshold,
and low routing cost are insufficient visual criteria. Do not connect this as
an "alpine success" just because its route is cheap. Retain as a quiet-upland
routing case; the steep pocket remains the stronger mountain visual. This does
not invalidate the unified basin solver or call for adding fake surrounding hills.

Complete16-output first1305.646ms; regeneration163.083/148.690/137.959ms.
Equivalent nine outputs, median original76.706/dry67.345/wet65.822ms; the regional
input is visually faithful here, but total first/regeneration includes its
preparation. Shared roots23.137–44.195ms, shape5.958–12.082ms (incl all candidate
work and mask publication), water1.046–2.040ms. Field137352B GPU/93284B typed CPU,
water201136B; workload live/peak20312424/34833588B. Final147456/49core:zero core/rim
failures,min observed depth3.433/rim.914m; proof3.016/.509m. Max old/shared
difference.21356m, interpolation error.004113m,max cut1.500061m,raising/exterior0.
Actual browser water ready8.610/7.985/7.783s, load12.722/11.422/10.922s; caches
uncontrolled. GPU declarations~1.34GiB, no low-end/cold-readiness claim. Zero
page/GPU errors, one404. Raw `natural-outlets/source/benchmark.json|browser.json`.
No terrain function or selection policy was changed for this comparison.


## Increments 24–25: bounded mountain descent and authoritative LOD height (October 10)

Owner now requests downhill whitewater/waterfall geometry, without SWE, and **large organically shaped plains lakes**. Small mountain ponds remain appropriate; small round plains blips do not satisfy that scope. Work remains opt-in and uncommitted. Large plains lakes are the next measured increment, not implemented by the records below.

Hypothesis: two adjacent canonical natural-generation fields can supply both real lake basins and a bounded downhill connection without synthetic surrounding hills. Confidence moderate; disprove by excessive complete cost, invalid shared/height contracts, excessive excavation or interrupted actual geometry. Add one derived seed-height trial AFTER existing fixed levels; it closes a proof-depth gap, not a relaxed guarantee. Adjacent west region uses the SAME spline/hull/containment planner, with a lower altitude eligibility and no mountain-setting preference. Both fields become a bounded RGBA32F generation-input atlas with per-cell lake ownership/level; fine terrain and hydrology read the same input, with original per-region C2 guards. No camera-selected cached terrain supplies the field. Paging/boundary portals are still unfinished.

Source remains steep natural pocket0/7/102/114, WL868.007m/radius32.733m. Adjacent receiver0/7/101/114 WL433.459m/radius57.858m has 36 potential cells, proof depth1.761m/rim0.510m. Fixed seven levels fail there; derived rise1.692m passes unchanged continuous cell-hull proof. Terrain-following A* uses a bounded32m/4096-node frame; 107 path samples at8m, each centre and two banks, supply a monotone running-minimum profile with 24m incision limit. Common point/carve/ribbon records, not a separate mountain renderer. 843.663m route descends434.548m, 108 points/107 segments. One localized pre-existing gradient peak permits a4.928m drop over1.5m; extra incision capped4m. Uniform steep reaches remain rapids. Existing lake anchors are constant. No fluids or new water textures.

Rejected trials remain evidence: analytic receiver certification overlapped authoritative shape support, so reject it rather than claim an invalid certificate; farther analytic receiver search found none. Initial128m route required33.841m incision and was rejected. Periodic9-fall profile was rejected as artificial. Revised one-fall profile samples max22.748m incision; actual centre probes max22.964m. First diagnostic side probes compared water at the wrong longitudinal position on a steep reach (285 false failures); corrected perpendicular, wobble-adjusted centre ribbon yields2568 samples with0 wet/raising/downstream-rise failures, min depth1.691m.49152 final micro-inclusive terrain texels/583 channel samples also pass, min channel depth0.129m. These sampled audits DO NOT prove the continuous entire river corridor or every LOD mesh.

Complete10-output native costs include both fields, all rejected basin trials, route/profile samples/index, shared roots, quadtree traversal, water publication, ten full height/material/normal outputs and fence. Corrected run first1280.716ms, regeneration176.867/140.144/138.544ms. Shared roots39.001–67.424ms, shape12.872–34.728ms, route4.804–5.842ms including profile sampling/index, water8.969–12.706ms, fine89.338–96.079ms. Do NOT report route5ms as a complete-per-river result. First archived cold run48926.206ms included48304.598ms first fine compiler stall; caching is uncontrolled and cold readiness is not solved. Root inputs14995712B, typed CPU planning205896B, water12804208B, workload live32818476B/peak48087868B. Broader game retains much larger pools.

Actual game first showed interruptions despite height audits. Quadtree LOD distance used the older broad foundation, hundreds of metres below actual mountain height. Use the same persistent natural spline input for traversal centre height; empty fallback owns68B, live inputs borrowed from generation. This selects depth11 geometry near the channel instead of mostly depth9 and visibly removes interruptions. Local sloped water visibility uses geometric surface normal, because a downstream observer below upstream water elevation is not necessarily underwater. Lakes retain their existing radial visibility rule. No change to landscape noise/erosion. Native paired complete10-output medians old LOD138.748/new135.957ms (4 alternating runs each): no generation regression established, no attributed speedup. Actual game visible238 vs187 at channel, including36 depth11 tiles vs0: **additional visible terrain/render/stream cost still needs accounting**, fixed native output comparison does not measure that difference.

[Actual paired LOD comparison](http://localhost:8181/tools/perf/structured-terrain-results/mountain-river/index.html), raw validated/lod-cost/benchmark.json and lod-validated-game/browser.json. Same cameras/daylight,0 page/GPU errors, one favicon404. Coarse water8.570/7.798s, full initial load12.111/10.780s, uncontrolled caches. Close continuity improved; distant overview still hides much of the river: unresolved, not accepted as a complete water solution. Waterfall geometry remains provisional with flat water materials. Earlier diagnostic-only shared visible-list read raced automatic diagnostics; runner now owns a separate staging buffer, validated pair completes.


## Increment 26: substantial irregular plains lake from one common regional field

Latest owner explicitly rejects the repeated small round plains blips and wants **big organically shaped lakes**. Do not call a large candidate bounding radius a large lake. Hypothesis: enlarging the existing natural field plus the same component proof might suffice. Confidence moderate. Actual comparison disproved this at the established gentle site1/6/40/20: radius575.453m/potential884 cells still yielded only scattered small wet patches; only41 connected cells can be certified wet. Retained `large-lakes/plain-region|plain-game`. Larger snow-valley field3/6/54/34 yielded a genuine curved lake (radius543.272m/1214 potential cells at a32m rise), but that is not the requested plains case. It adds no terrain hills and remains separate diagnostic evidence, not a world-yield claim.

Pivot: add a bounded, cut-only **regional depression landform** BEFORE authoritative-field bounds/planning/upload. This is a generation input, including when dry; fine height generation reads those controls as with other regional terrain. It is not a cached render height or a water-renderer feature. Three overlapping smooth lobes with a small deterministic warp make a broad non-circular footprint. The existing natural shape supplies varying bank gradients; no raised rim or hills. Nine fixed eligibility positions use16 shape-boundary and5 inner height probes each from the SAME original field, no extra GPU search/readback. Reject high incision/support failures. One accepted proposal changes1525 control heights with at most8m cut. Floored bed depth2.5m; common underwater polish still ≤1.5m. Earlier3m feature-floor proposal required too much cut and was rejected rather than increasing the8m budget. Circular eligibility rings were unnecessarily pessimistic; use the intended irregular feature boundary as a preliminary proposal, then perform the exact same full cell-hull containment proof. These probes are not a separate guarantee.

The landform supplies a known anchor and water-level proposal. One common planner supports existing natural minima OR supplied terrain anchors; fixed candidate/level/cell-work bounds still apply. Add an optional **minimum connected certified-wet-cell count**, using four-connected full-cell upper bounds with fine-micro/numerical allowance and at least0.25m depth. Large potential regions with only a small core are rejected. Small rugged pond defaults remain unchanged. For supplied anchors there is no need to rescan the entire field for unrelated minima. Both approaches use the same closed component, full dry retaining ring, bounded underwater deepening, and production height inputs.

Accepted gentle case1/6/40/20,256 controls per side (same physical sampling density as128/depth7, larger domain), WL580.1866455m/radius390.947954m.1135 potential cells, **881 connected guaranteed-wet cells**,180 dry-rim cells. Proof core depth3.62479m/rim0.50505m. Conservative render-depth texel estimate:617×538m,186834m² (0.187km²); an estimate, not an exact coastline-area certificate. Only four candidates, ≤9 level proposals each, ≤8192 component cells, maximum footprint1200m. Surface128² only for this explicit large prototype; small/default64² unchanged. New configuration stays opt-in, generation source/options/version aware.

[Actual original / dry depression / lake comparison](http://localhost:8181/tools/perf/structured-terrain-results/large-lakes/index.html). This meaningfully improves scale and outline compared with small blips, without the rejected enclosing-hill recipe. Shape is still provisional; it is not a finished natural coastline or user visual acceptance. Same real game, materials, lighting and cameras. Zero page/GPU errors, one favicon404. Water8.616/7.754/7.768s, initial load12.222/10.961/10.889s with uncontrolled caches; no cold improvement claim. Declared whole-game peaks1450558904/1450194480/1451058872B: low-end pools/streaming remain a broader unsolved engine cost.

Complete **23-output** workload includes seven fixed outputs plus sixteen depth8 tiles covering the ENTIRE potential basin, retaining ring and a tile halo (not just its small core), all height/material/normal outputs, roots, field/depression, rejected eligibility trials, proof, quadtree, water and final fence. First1367.586ms; regeneration266.088/246.104/243.203ms. Shared roots45.014–72.093ms; shape21.503–37.512ms includes feature3.746–6.102ms, complete proof/bounds8.815–16.879ms and mask/upload/readback. Water2.363–2.626ms. Sixteen-output medians original135.563/dry126.937/wet127.099ms are equal output WORK, but dry/wet deliberately alter local terrain; do not claim visual equivalence/no-cost adoption. Field536712B GPU/366692B persistent typed CPU; water213424B; workload live20724140B/peak41575012B. Process endpoint is not CPU peak, GPU driver/pipeline allocations excluded.

Known-anchor optimization: four alternating complete23-output runs each, same generation key, controls, level and proof. Known-only median242.295ms vs unnecessary minimum-scan256.444ms; complete trial ranges overlap238.879–257.092 vs240.520–282.625, so do not attribute the entire14.15ms median gap to the scan. Planning medians8.214 vs13.590ms support the bounded work reduction. Final terrain SHA256 identical across the complete before/after runs, `326e074fba5c4d5a972b4bfadc200ed0a5eb02b61e1486b4ee1274b5ae972155`; no visual change from skipping the redundant scan. Final262144 micro-inclusive texels /4 full-core samples:0 core/rim/raising/exterior failures, observed depth3.99734/rim0.89874m. Maximum original/shared8.0250m includes intentional8m landform plus interpolation difference; same-field CPU/GPU spline error0.001364m, underwater cut1.5m. This does not establish whole-frame streaming or50ms per river.

Source implementation `regionalDepression.js`, `regionalShape.js|Model.js`; bounded config tests and synthetic cut-only/connected-area/steep-rejection tests added. Raw `large-lakes/depression-full|seed-cost/benchmark.json`. Persistent regional paging, distant mountain river coverage and cold compilation remain required. Larger lakes beyond this ~0.2km² prototype need measured scale/shoreline variation and multi-region ownership; do not silently expand search budgets.


Increment25 actual-render follow-up: previous/native fixed-output comparison missed added visible geometry cost. Sequential frozen real-game close channel,360 full-render-to-fence samples per mode, same camera/daylight: authoritative height selection median23.6ms/p95 37.3 vs older18.0ms/p95 30.7. No isolated GPU timestamps; cache/thermal/browser scheduling uncontrolled, streaming excluded. Visible238 vs187 (36 depth11 vs0). This is a material quality/cost tradeoff, not a free generation optimization; do not claim its full5.6ms delta as isolated shader overhead. Native complete output cost remains independent of the changed resident set. First render diagnostic mistakenly reused a missing pose after reducing capture count; rejected run preserved in lod-render-cost, corrected full pair in lod-render-validated.

Distant follow-up corrects the early inference: an actual2600m-altitude view with ownership tint shows continuous river coverage. The1700m relative-altitude overview mixed near/far ownership across a434m head loss; source water could still be within1600m of the camera. The problem is coarse water appearance, not a demonstrated missing route lookup. Its shallow colour transmitted DRY coarse terrain rather than a submerged bed, making the water look brown/green. Raw distant-diagnostic/browser.json and network-owner.png prove flags1659/1659 and coherent coverage.

## Increment 27: consistent distant constructed-river body colour

Match the near ribbon's existing water body colour for marked distant structured river segments, using an unused uniform scalar. No new geometry/texture/data allocation or near/lake/legacy change. Actual2600m-altitude paired view in `mountain-river/distant-body-game` shows a continuous turquoise course instead of the earlier brown/green line. At this distance an8m-wide river is still thin; do not claim detailed whitewater, finished waterfall visuals, or fluids.

Four alternating frozen-camera full-render rounds,480 samples per mode: old colour median14.5ms/p95 20.5, consistent body14.4ms/p95 20.9. Same resident geometry, manual render-to-fence wall time; no isolated GPU timestamps, no measurable penalty or attributed speedup. Native four alternating COMPLETE10-output regeneration rounds: old median137.592ms (120.404–153.194), body134.095ms (132.230–137.775). Shader colour is not rendered by this native generation workload; it establishes no generation regression, not a colour-driven speedup. Independent current full regenerations163.060/143.295/141.560ms, cold1398.147ms, route/profile3.2–9.4ms. All shared/failure/proof/index/publication/fine-output/fence work remains included. Workload live32818544B/peak48087936B, no increase over the68B LOD fallback state.2568 wet-centre samples and49152 final texels pass the same sampled contracts, minimum final channel depth0.129m, maximum observed incision22.964m.0 GPU errors; browser has only favicon404. Runtime suite300 tests/44 files passes. Raw `body-native/benchmark.json`, `distant-body-cost/browser.json`.

Convenient opt-in previews now move to the demonstrated feature after readiness: `?regionalLargeLake=1&regionalView=basin` and `?regionalWhitewater=1&regionalView=river`. Ordinary spawn/default remain unchanged. Preview smoke and any subsequent architecture work are recorded separately. Keep true full regeneration distinct from reuse of unchanged generation dependencies.


Preview smoke: both automatic camera URLs reach the intended617×538m plains lake and mountain channel without page/GPU errors; one favicon404. Raw preview-smoke/browser.json and screenshots. This is a functional smoke, not new visual acceptance or a cold-loading comparison.

Increment28 hypothesis: separate immutable macro generation-phase ownership from dependent basin/river/shape versions, sharing only the current published foundation when exact terrain source, uniforms, resolution, seam and bounds budgets match. Confidence moderate; reject on changed complete texture bytes, premature resource destruction, stale input reuse or no complete-cost/memory benefit. Default explicit regenerate:true still rebuilds all inputs; reuseFoundation:true explicitly regenerates features over unchanged inputs. Feature configuration changes can share the same terrain phase. No terrain samples, noise/erosion/LOD shaders change. Full cost/memory comparison and adoption decision are recorded below.


## Increment 28: immutable terrain-generation phase shared across feature versions

Retain the prototype. `regionalTerrainFoundation.js` owns the original six-face macro A/B fields and conservative root bounds as one immutable generation phase. Basin/shape/river revisions acquire an ownership share from ONLY the current published generation when device, contract version, complete WGSL, all1024 uniform bytes, cells, seam and complete budgets match exactly. The hash is a generation identity, never the equality test. There is no global terrain-value map, camera/render cache, new terrain interpolation or altered noise/erosion. Foundation publication happens after its fence; generation teardown releases its share after all submitted use. Last release closes the input before waiting for its final fence. Failed/discarded replacements release their own share; old published inputs survive. Generation destroy calls coalesce onto the same promise.

`prepareRegionalTerrain` distinguishes operations: ordinary feature-configuration changes share unchanged foundation inputs; explicit `regenerate:true` STILL recreates the foundation and every dependent feature. Explicit `regenerate:true,reuseFoundation:true` recreates all basin/shape/proof/profile/index/publication dependencies over the existing immutable foundation. This is NOT a faster cold/full rebuild. Changed terrain source/uniforms/bounds/resolution/device force new foundation even when sharing is requested. Separate foundation and complete feature keys, versionv12; keys intentionally change to reflect ownership schema (mountain00a2176f vs previousd742cc60), while source/receiver levels, all river point records and terrain content remain unchanged. Stale samplers still reject a changed published source.

Four alternating rounds per mode, equivalent COMPLETE ten terrain outputs (height, normal, material/splat, climate and other requested textures), both basins, every trial/proof, quadtree traversal, route/profile/index, water allocation/upload, final fence:

| Mountain workload | Full regeneration | Feature regeneration, same foundation |
| --- | ---: | ---: |
| Complete median |146.038ms |131.979ms |
| Complete range |133.251–161.606ms |122.421–136.036ms |
| Macro foundation phase |15.025–16.341ms |0.065–0.178ms |
| All regional generation median |45.758ms |32.630ms |
| Regional-rebuild peak payload |48087936B |33635520B |
| Whole-workload peak payload |48087936B |45621728B |

Regional rebuild avoids14452416B (14.45MB/**13.78MiB**) duplicate persistent macro inputs plus1120B temporary uniforms. Whole-workload peak saves only2466208B (**2.35MiB**) because old/new water allocations overlap. Steady residency remains32818544B, regional14995712B, persistent typed CPU206920B (+1024B foundation uniform snapshot). The retained full source has254898 UTF-16 code units and budget metadata171; actual JS string storage/deduplication is engine dependent and excluded from typed-byte accounting. Explicit full regeneration first1372.262ms, then171.702/137.416/137.837ms. Shader/driver compilation remains uncontrolled; initial loading is not improved by this reuse. Native fine outputs still cost~91–100ms. Route/profile remains a few milliseconds and must not be presented as the complete result or meeting50ms.

All requested unique GPU texture outputs for each of the ten tiles per round were read back OUTSIDE timed generation and hashed without row padding: all eight full/shared rounds SHA256 `88c5f6834e4331f2c08aad891a4b655ac6abea715b9740a4abe36b1f8becb537`. Diagnostic extra output generation/readback is excluded from generation times, explicitly identical for both modes. Existing2568 centre-ribbon and49152 final-texel sampled audits remain unchanged,0 GPU errors. The earlier gentle-river regression also passes: same previous point records,1800 centre/49152 final-texel samples,0 errors, eight complete-output hashes identical (`f2e6e208d66b2a6abaf912db05c0c79a781613c361b5ea55e7eb113080f0a7b0`). Complete medians full135.621/shared113.643ms; full range133.354–139.535, shared110.187–124.165. Gentle workload peak53395280→44888592B. These are workload/host-specific warm results, not low-end frame guarantees. Raw `mountain-river/foundation-cost/benchmark.json`, `coarse-river/foundation-regression/benchmark.json`.

Safety: four new ownership tests plus publication-mode test; full runtime305 tests/45 files. Real native failed high-minimum mountain placement returns “No certified source in regional connection”, preserves the exact published object, ownership count1 and all18496 sampled old heights bit-for-bit. Changing meso2 forces a new foundation and old sampler rejects continuation. Existing sampler rebinds through both full and shared equivalent regenerations,18496 samples bit-identical in each mode. Reproducible diagnostic `tools/perf/structuredFoundationAudit.mjs`, raw `foundation-safety/probe.json`. A separate read-only sampler substitutes only the pre-atlas single-field shape module to resolve increment24's changed old SHA concern:18496 directions through core, guard and exterior, max height difference0.000366m, mean0.000025m, no difference above1mm. Controls/level/proof were already identical; old/new final-output SHA is NOT identical and this sample comparison is not a full final-material equivalence proof. The reference module is archived as diagnostic source only, never restored in runtime.

At increment 28 close, new large/steep visuals still awaited owner assessment. **Subsequent owner feedback rejects them; see the latest direction near the top.** Baseline/rollback and seven protected water/landscape files matched the pre-natural-basin snapshot byte-for-byte; no staging/commit/push. Global region paging, boundary portal ownership, broad lake size/yield diversity, realistic bank refinement, stream scheduling, whole-game1.35GiB pools and cold compilation remain required. This increment reduced regeneration work without expanding terrain-changing scope or establishing that the broader design is complete.


Final increment28 verification:305 tests/45 files pass, targeted lint and diff whitespace checks pass. Both direct game preview URLs still work with v12 generation keys and the exact previous basin levels/radii and camera poses,0 page/GPU errors (one favicon404). Final sampler rebinding/safety diagnostic0 GPU errors. No GPU jobs left running.

### 2026-10-10 — latest owner rejection, read-only audit and handoff only

The owner supplied a broad old plains lake, an organic river concept and several unacceptable current comparison captures; they expressed a preference for one fine generation after coarse placement, allowed simplified distant terrain-shader water with proper near geometry, and requested a plan before implementation plus a restart handoff. The agent initially interpreted the generation preference too strictly; the subsequent clarification and correction are recorded below and near the top. Read-only source inspection confirmed the dense full-natural eroded-shape prepass, three-lobe depression, sampled route/constant nominal width, radius-based anchors and shoreline micro suppression. Exact causes of individual rendering glitches were not proven from the screenshots.

This update replaces the stale current-status/next-session guidance and records the proposed coarse basin-potential -> feature records -> single fine-generation -> shared wet-boundary direction near the top. Historical numerical/visual claims are retained as history, with the new quality rejection taking precedence. **No runtime files changed, no new implementation or terrain experiment started, no performance/GPU/browser/test run in this documentation session, and no agent spawned.** No staging, commit, push or reset. The next code increment remains a proposal pending the owner's response to the requested explanation.

### 2026-10-10 — generation preference clarified; all-results evidence catalogue

Owner: one terrain generation is preferred but is **not an absolute requirement**; preliminary full/simplified/specialized height work for lake generation is allowed whenever better visuals justify complete compute. All options remain on the table, including for plateau lakes. The previous plan's categorical no-prepass rejection criterion and mountain-only exception restriction were corrected. Proposed candidates A (coarse traits only), B (specialized supporting height), and C (fuller preliminary height) share a common basin/water contract; none is newly implemented or ranked by fresh measurements. Compare matched visual content, complete shared/fine/failed/regeneration cost, memory and early streaming before choosing.

Owner also requires every measurement and comparison result in the handoff with data backing conclusions. Added the evidence ledger near the top, corrected the stale measurement-summary status, and catalogued all 767 existing artifact files: 267 JSON reports, 4 logs, 350 comparison images, 21 viewers, 121 raw control/mask arrays, 3 diagnostic sources and 1 measurement narrative. The index links every file; the manifest records exact bytes/SHA256/JSON schema fields. Reports, invalid/failed attempts and their existing values were preserved. This is documentation and artifact verification only, not a new terrain/GPU/browser performance run; runtime files and the uncommitted rollback remain untouched. No staging, commit, push or reset.

Documentation verification: all 767 catalogued file hashes/byte counts match the saved artifacts, all 267 JSON reports parse, all 874 relative file links across the three documentation files resolve, code fences/whitespace checks pass, and staged content is empty. This verifies evidence traceability, not the validity or visual quality of every archived experiment. No new runtime test suite was run.

### 2026-10-10 — representative screenshot folder for restart review

Owner requested available screenshots collected in a folder and referenced from this handoff. Created `tools/perf/structured-terrain-results/handoff-screenshots/` with 31 byte-identical existing actual-game captures: 12 plains-lake original/dry/wet views, 10 mountain-river LOD comparisons, 2 distant body-colour comparisons, 4 original/wet natural-pond views and 3 rejected enclosure views. `README.md` and `index.html` label scenes/limitations; `sources.json` records original paths, exact hashes and saved camera/LOD metadata for all 31. Current rejected channel/fall/smooth-shore examples were inspected directly. No image edits, new captures, GPU/browser run, terrain implementation or synthetic illustration.

The original 767 archived artifacts remained byte-identical. Updated the evidence catalogue to 801 files, including the 31 review copies plus the gallery, source notes and provenance. Original unique screenshot count remains 350; review copies are identified separately and must not be counted as new experiments. The old broad-lake reference and river concept supplied only in chat still have no local image files in this archive. Runtime files and rollback remain untouched; no staging, commit, push or reset.

### 2026-10-10 — introductory background and engineering reasoning

Owner found the handoff's opening inadequate for explaining the project's reasoning, requirements and background. Replaced the status-first opening with connected introductory paragraphs covering the original expensive placement pipeline, the rationale for integral coarse terrain inputs, why minima alone do not establish useful basins, unified placement and frequency/size compromises, the plains/river visual target, pass-count/reuse alternatives, near/far rendering and deferred SWE, and complete-cost/streaming/ROI requirements. The introduction distinguishes expensive historical whole calls from potentially useful bounded floods, links the supporting data, and states that the next agent may challenge the current design. Current prototype status, evidence navigation and working-tree preservation follow the background. Updated the fresh-session prompt accordingly. Only this handoff changed; no new benchmark, image or runtime implementation.

## Increment 29: first organic lake potential and preview module repair

Latest owner authorizes deep reading/analysis and small implementation increments for realistic lake/river placement, with visual and complete compute measurements. Reference rows show unacceptable smooth lake blobs/canals and desired organic banks and larger lakes. Whole coarse view must appear within 50 ms during fast movement; tile queuing is explicitly out of this session. Rendering and Whitewater shallow water equations follow accepted placement. Uniform terrain-type architecture is preferred, with freedom to challenge the current prepass and use Runevision erosion only when its return warrants the cost. No agent was spawned.

The full handoff was read before implementation. [Detailed analysis and next increments](STRUCTURED_TERRAIN_ORGANIC_WATER_ANALYSIS.md) explain source-confirmed causes and proposed architecture. Retain the persistent foundation ownership and common bounded basin contract provisionally; the dense natural-height prepass has not earned universal adoption or established a coarse/specialized/full-field ranking. Use one feature/portal/wetness contract with relief-dependent resolution, size, rarity and work limits instead of separate plateau/mountain generators. Current spline controls are roughly 13–14 m apart at the demonstration site; the lake's 0.25 m micro allowance divided by global 24.4 m budget retains only about 1.02% amplitude. River corridor costs omit sustained curvature, nominal width remains constant, small wobble cannot correct long straight reaches, banks share an opposed signal, material micro is suppressed, and joins use enclosing radii. These need separate measured increments. Existing Runevision erosion precedes the new depression; no new erosion pass is justified or implemented here.

Hypothesis: a compact two-dimensional spatial basin potential can buy a larger irregular connected lake, retaining natural high points, without another GPU pass or persistent allocation. Confidence moderate. Reject if the common rim/depth/connected-area proof fails, cuts exceed the existing budget, exterior changes/raised rim appear, actual broad shape remains unsuitable or complete cost becomes unacceptable. This first experiment deliberately keeps the current supporting-height backend for a controlled shape comparison; it does not claim to solve fine micro, world placement/yield or rivers.

`regionalBasinPotential.js` provides deterministic quintic lattice noise at radius-relative scales plus a 20 m minimum finest scale, compact support and retained central anchor. `regionalDepression.js` opts into it with `profile:'organic'`; old lobes remain default. The CPU bakes weights once into the existing controls. Controls are cut only, ≤8 m, with no raised hills. Existing underwater polish ≤1.5 m and 0.25 m micro/0.125 m numerical proof allowances stay intact. Organic eligibility brackets the outermost support crossing and checks a feasible central floor rather than flattening all interior high points. Candidate ranking uses the maximum interior probe, preserving the original `(0.3,0.3)` site. The common full spline-hull proof remains the only acceptance gate.

Rejected stages: [first potential audit](tools/perf/structured-terrain-results/organic-lake/potential-audit/audit.json) rejected all nine candidates, lowest required cut 8.034 m >8 m. [Second audit](tools/perf/structured-terrain-results/organic-lake/potential-audit-v2/audit.json) accepts 2,277 wet cells / about0.481 km² but selects `(0.7,0.3)`, so it is not a matched-site comparison. [Final audit](tools/perf/structured-terrain-results/organic-lake/potential-audit-v3/audit.json) returns to `(0.3,0.3)`, accepted level579.576469 m,2,524 certified wet cells/3,044 potential/348 rim, core depth3.124704 m/rim0.509650 m. The first proposed level580.076355 m fails containment and the unchanged planner accepts a lower trial; budgets were not widened. 3,393 controls modified, maximum cut8 m. CPU-only timings/images exclude GPU roots/fine/publication and are not complete placement measurements. Earliest two rejected source revisions were not separately snapshotted; raw reports/masks/controls remain preserved.

Complete native runs use the SAME23 tile addresses/types: seven historical full outputs plus sixteen lake/rim/halo outputs. Charge roots, full local natural-height field/readback, every rejected proposal/proof, selection, water publication, all requested terrain textures and completion fence. [Baseline](tools/perf/structured-terrain-results/organic-lake/baseline/benchmark.json) first1401.624 ms, regenerations267.110/239.980/249.089; [first candidate](tools/perf/structured-terrain-results/organic-lake/candidate-first/benchmark.json) first1320.943 ms,269.534/239.189/242.474. No cold speedup attribution. Conservative render-depth estimate grows186,833.8→526,625.6 m² /616.965×537.553→1090.372×935.983 m; not an exact continuous area integral, and the depth texture spacing differs with extent. Certified connected wet cells grow881→2524. Actual matched-camera renders confirm the larger footprint.

[First alternating comparison](tools/perf/structured-terrain-results/organic-lake/interleaved/benchmark.json), four complete rounds each: lobes267.895/235.926/234.439/236.369 ms, median236.148; organic242.621/238.286/249.900/240.910 ms, median241.766 (+5.618). Organic regional generation45.148–50.139 ms, local shape21.285–26.312, potential CPU5.365–6.234, water publication1.345–1.570 ms. Potential time alone is not the complete result. Median sixteen-output original-base136.802 vs shared dry-shape127.796 ms does not pay the entire shape phase by itself or establish equal visual fidelity.

[Second comparison and final audit](tools/perf/structured-terrain-results/organic-lake/final-contract/benchmark.json): lobes254.706/238.964/241.643/241.356 ms, median241.499; organic244.733/240.873/243.533/247.125 ms, median244.133 (+2.634). First2444.740 ms overlapped CPU tests and is not isolated cold evidence; ordinary full regens319.016/244.765/260.791. Observed complete penalty2.6–5.6 ms is modest and ranges overlap; no fixed per-tile penalty or generation speedup claimed. Read262,144 final micro-inclusive texels;10,108 samples in certified-wet cells,0 wet/core/rim failures, observed minimum certified depth1.046337 m, core3.499477/rim0.932202. Continuous certificate remains the hull derivation, not the finite audit. Maximum sampled interpolation error0.002147 m<0.125 allowance; underwater polish1.5 m;0 sampled raising/exterior changes. Independent candidate final height SHA256 `846c60e4692b7c8b7d3658bbbb79b755fcea6d53d0fc32cc792c8fc8c027ad06`; baseline hash matches the established prior lake output. Persistent field536,712 B, typed CPU366,692 B, water213,424 B. Native workload peak41,575,012 B unchanged by the potential; diagnostic sampler changes some live endpoint values. Driver/pipeline storage, pre-monitor setup and whole-game pools excluded.

[Actual production comparison](http://localhost:8181/tools/perf/structured-terrain-results/organic-lake/index.html), [browser data](tools/perf/structured-terrain-results/organic-lake/game/browser.json): overview/oblique/bank/distant/ownership at same world cameras/sun. Broader connected body, bay/peninsula and small high points visible. Close banks remain angular and lack proper micro; distant terrain LOD/material boundaries remain.0 page/GPU errors, one favicon404. Water readiness9.059/7.949 s, first initial-load12.947/11.071 s with uncontrolled sequential caches. [Render observations](tools/perf/structured-terrain-results/organic-lake/render-cost/browser.json):30 warm then3×60 complete render/fence samples per page, medians15.2/13.4 ms,p95about21 ms. Stored manual-diagnostic snapshot is idle and does not inventory actual residency; modes have unmatched resident geometry, so this does NOT establish causal frame-cost improvement/regression. No whole-view fast-motion or queue benchmark performed. 50 ms readiness is not achieved or claimed.

Owner could not assess the preview because `GPUQuadtreeTerrain.js:812` repeatedly threw `this.quadtreeGPU.setRegionalTerrain is not a function`. HTTP source matched disk and contained the method; old HEAD class lacks it. A [controlled stale-module response](tools/perf/structured-terrain-results/organic-lake/cache-preview/browser.json) reproduces exactly that TypeError. Versioned imports in the manager and quadtree now pair regional API/shader dependencies; the actual `?regionalLargeLake=organic&regionalView=basin` URL reaches the automatic basin camera and terrain readiness without page/GPU errors when the same old bare URL response is still offered. This does not prove direct contents of the owner's cache. [First cache test](tools/perf/structured-terrain-results/organic-lake/cache-preview/invalid-readiness/browser.json) had an invalid readiness predicate: manual camera existed at startup and capture preceded automatic basin pose. It remains failure evidence; corrected test waits actual basin direction/water/terrain readiness. No shader contents or generation algorithm changed in this repair.

[Post-fix full/shared regeneration](tools/perf/structured-terrain-results/organic-lake/foundation-cost/benchmark.json): first1405.626 ms; warm272.781/242.007/245.928. Three alternating full rounds280.149/245.156/244.163, median245.156; unchanged-foundation feature rounds240.921/228.225/227.381, median228.225. Foundation14.299–14.743→0.060–0.146 ms; controls/source keys identical all six rounds. This is not a complete every-output hash audit in each round, or faster cold placement. Both observed workload peaks41,575,012 B; no peak reduction established here. Final height/wet audits still pass with identical candidate hash,0 GPU errors.

Full final runtime suite307 tests/46 files passes, including shader compilation; targeted lint and diff whitespace checks pass. [All raw runs, commands, limitations and source provenance](tools/perf/structured-terrain-results/organic-lake/README.md) are retained and catalogued. Starting649-source snapshot `/tmp/spherecraft-organic-start-20261010` and before/after changed-source archives preserve reviewability. Prior rollback/protected files remain byte-identical. No new noise/erosion shader, river course/carve, rendering, SWE or queue implementation. Runtime defaults stay off; old `regionalLargeLake=1` remains available. No staging/commit/push/reset, no GPU jobs left running.

Next: owner assessment of broad shape; then bounded fine shoreline detail with proof retained; then one gentle joined river with sustained curvature/variable independent banks and actual wet portals; then one rugged case using the same contract. Do not extend this first lake candidate into further terrain changes merely because tests pass. The preview error response is not shape approval. Scope remains realistic placement first; water visuals/simulation later.

## Increment 30: common course, light-height comparison and first-tile water publication

Owner subsequently reports the organic lake looks much better, its broad shape is acceptable and passes the quality bar; polishing should not block progress. They authorize proceeding, including challenging separate mountain placement and evaluating river flow between coarse higher/lower regions. A further clarification records the old normal-tile generation followed by water-tile regeneration failure: rivers arrived one or two seconds late. **Complete dry-first tile regeneration for placement is unacceptable.** Prefer avoiding repeated height work or using bounded lighter supporting heights where their measured complete return warrants them. Supporting heights remain allowed; this is not permission to restore the old delayed reconstruction.

[Detailed analysis and decisions](STRUCTURED_TERRAIN_REGIONAL_FLOW_ANALYSIS.md), [actual production gallery](tools/perf/structured-terrain-results/organic-course/index.html), [all raw runs/commands/limits](tools/perf/structured-terrain-results/organic-course/README.md). Accepted lake shape code and budgets remain unchanged. No agents spawned.

Hypothesis: persistent coarse data can guide one local descending connection, with a bounded organic course and real source portal computed before tiles. A lighter height entry might reduce preparation. Reject the lighter backend when it misses relief/violates the existing 24m incision budget or saves too little complete cost. Retain one common representation with varying effort rather than adding a biome-specific placement pipeline. Confidence moderate for the course/data direction; automatic world placement and backend selection remain unimplemented.

Implementation: `regionalRiverCourse.js` refines the existing bounded eight-neighbour corridor using smooth deterministic lateral structure and bilinear terrain/incision costs. Requested bend scale follows width/coarse spacing and decreases with descent. End anchors retained; maximum profile-point budget checked before lateral search/intersection work; proper self-crossings rejected. `regionalDrainage.js` bakes nominal width variation into existing records and expands indexing conservatively. `regionalLakePortal.js` anchors at the first contiguous wet exit from existing conservative depth data, avoiding an additional height solve. Old analytic basins retain a radius fallback. `regionalBasins.wgsl.js` exposes opt-in foundation-only sampling; default remains natural, including shared authoritative shape where present. No new fine-terrain shader octave/binding, full render-tile pass, bank erosion, simulation or queue implementation.

Gentle source level579.576469m, receiver574.099121m. Natural course6,404.273m/405points, requested offset≤36m/wavelength256m, nominal half-width10.455–13.802m. Source wet portal527.165m instead of enclosing radius617.556m; source mask spacing9.649m. Receiver remains an older analytic100m basin with radius anchor. Light course6,309.474m/399points and different portal399.693m. Both sample1,098 coarse grid sites; profile1,215natural/1,197light. These courses intentionally differ; compare equal full output coverage, not identical output bytes.

[Four interleaved forward/reverse rounds](tools/perf/structured-terrain-results/organic-course/interleaved/benchmark.json) rebuild foundation, shape/proof, receiver, routing/profile/index, quadtree traversal, water publication and all requested outputs at the **same11addresses**, including both course middle tiles, then await completion. Warm complete medians coarse-natural161.795ms (153.853–186.406), organic-natural162.066ms (157.001–174.715), organic-foundation161.255ms (158.227–161.656). Paired natural-organic minus coarse differences−23.354/−0.055/+3.148/+12.263ms; light minus natural−1.804/−2.854/+4.261/−13.060ms. No causal speedup or fixed penalty established. Combined supporting sampling median1.292/1.535/1.123ms; route including profile waits1.928/2.695/2.948ms; index5.851/6.049/6.493ms. Maximum per-mode tracked comparison payload48,717,640/48,715,400/48,717,640B. Root/fine medians and every observation are in the analysis. Generator/quadtree setup excluded only in warm regeneration; discovery of the matched address union is diagnostic work outside timed comparisons.

Standalone complete ten-output natural gentle first2,400.688ms/warm207.642/226.851/168.104ms; light first1,386.212ms/warm189.580/222.554/157.740ms. These processes have uncontrolled compiler/driver caches and different middle addresses; they are not the matched comparison or evidence for a cold backend ranking. [Old small analytic-lake baseline](tools/perf/structured-terrain-results/organic-course/baseline/benchmark.json) has different feature content and is not a performance comparator for the accepted large-lake scene. [Legacy regression](tools/perf/structured-terrain-results/organic-course/legacy-regression/topology.json) reproduces all1,520 old point-record floats exactly; new default option fields change identity serialization without changing the route. Timings use native Dawn/Metal wall time through a fence on AppleM1Pro32GiB/macOS26.6.2/Node26.10.0. Declared payload excludes pre-monitor generator setup, driver/pipeline storage and whole-game pools. GPU diagnostics run sequentially; browser observations are not controlled startup or render-cost comparisons.

[Natural gentle audit](tools/perf/structured-terrain-results/organic-course/large-natural-native/benchmark.json):9,696 route samples,0dry/raised/uphill,maxobservedcut9.027m/mindepth1.781m.49,152 production final-height texels across3tiles,786 tested river-wet texels,0failures/mindepth1.234m. [Light gentle audit](tools/perf/structured-terrain-results/organic-course/large-light-native/benchmark.json) also passes sampled checks, maxcut11.628m. Finite samples do not establish a continuous whole-river proof.

[Light mountain failure](tools/perf/structured-terrain-results/organic-course/mountain-light/rejected.json): requiredprofilecut41.098m>24m. Completefailedattempt605.748ms includes381.816mssetup; trackedlivepayloadreturns0,0GPUerrors. [Natural mountain full run](tools/perf/structured-terrain-results/organic-course/mountain-natural-native/benchmark.json) succeeds through the same course model:859.371m/111points/434.548mdescent, requestedlateraloffset1.645m, two≈4.93mfalls, bothdepthmaskportals.2,640 routesamples,0wet/raised/uphillfailures,maxcut20.584m/mindepth1.670m;49,152finaltexels/599testedwet,0failures/mindepth0.300m. First1,351.857ms,warm169.874/147.130/144.248ms,peak48,099,392B. Its plan-only predecessor is retained separately. Do not read a successful sampled mountain connection as accepted mountain visuals, a global placement policy or an automatic height-backend selector.

**Publication repair:** production-page JS hooks after dependency preparation found four root-tile calls with water buffers bound but water not ready, followed by a river invalidation. Feature planning was early, but first GPU upload was one game update late. `GameEngine` now starts/updates structured GPU water after generator preparation and before quadtree initialization. Initial changed cells are cleared only before any tile streamer exists; subsequent real changes retain existing invalidation. No new fence/height pass or queue change. [Before](tools/perf/structured-terrain-results/organic-course/startup-before/browser.json):828calls,4unready/0unbound/1invalidation. [Gentle after](tools/perf/structured-terrain-results/organic-course/startup-after/browser.json):542calls,0unready/0unbound/0invalidations. [Mountain after](tools/perf/structured-terrain-results/organic-course/mountain-startup-after/browser.json):633calls,all0. Counts/residency differ and do not measure a speedup. The instrumented harness checks this ordering directly; ordinary geometry/material refinement and future genuine terrain edits are distinct.

Matched actual engine captures use the same world poses/daylight for coarse, natural-organic and light-organic guidance. Post-publication-fix comparisons retain the same camera/light for coarse/natural-organic. The course bends and source lake join improve; bank strips remain broad/smooth, and distant terrain material/LOD boundaries remain. Old gentle receiver shape and proper independent close bank micro are unresolved. Zero page/GPU errors in completed captures/probes, one recorded favicon404 per fresh browser process. Startup observations are many seconds with uncontrolled assets/caches; **no50msmoving-view result is established**. Lake broad shape acceptance is carried forward; new river/mountain results have no owner assessment yet.

Runtime suite314tests/48files passes, including new foundation shader variants, course determinism/anchors/slope/budget/proper-crossing rejection and depth portal failures. An initial unfiltered test run mistakenly collected partial archived source-copy suites; `vitest.config.mjs` now excludes the evidence archive while retaining default exclusions. A four-corner crossing fixture was smoothed into a noncrossing route; the corrected sufficiently sampled fixture exercises an actual fold. Targeted lint and diff checks pass. [Source/environment/validation provenance](tools/perf/structured-terrain-results/organic-course/session.json) preserves touched sources against `/tmp/spherecraft-course-start-20261010`. Historical evidence and unrelated rollback/protected sources remain byte-identical. No staging, commit, push or reset.

Capture corrections/failures retained: [first post-repair rerun](tools/perf/structured-terrain-results/organic-course/comparison-after/browser.json) times out120s waiting for water readiness, no captured page/GPUerror/cause established; [second attempt](tools/perf/structured-terrain-results/organic-course/comparison-after-validated/browser.json) exposes a diagnostic readiness bug (missing load state treated as complete, UI not constructed). The initial after-repair startup call-state counts remain valid, but their early screenshot/readiness helper is not a completed-load guarantee. [Final comparison](tools/perf/structured-terrain-results/organic-course/comparison-final/browser.json) waits actual load-state complete and produces6same-pose/daylight captures,0page/GPUerrors. Observed water/initial times8.468/12.732s and7.813/11.113s, no causal startup comparison. [Corrected mountain startup](tools/perf/structured-terrain-results/organic-course/mountain-startup-final/browser.json) waits completed load and observes979calls/0unready/0unbound/0invalidations; its final image has full local residency, retaining overly smooth banks. [Final course regression](tools/perf/structured-terrain-results/organic-course/final-course-regression/topology.json) reproduces all8,100 organic-natural point floats exactly after the point-budget/diagnostic-identity corrections. Successful measurements preceded those no-output-change guards; final archives identify this revision limit.

Next measured visual work: bounded bank asymmetry and waterline micro through the common course/lake contracts, preserving incision, wetness and source/receiver continuity. Use existing erosion/detail where it earns its complete cost; no fresh evidence supports another whole-field Runevision bank pass. Then regional placement/yield, shared drainage crossings and eventual feature paging. Global drainage DAG/confluences, close water geometry and Whitewater SWE remain subsequent work. Keep opt-in preview `?regionalLargeLake=organic&regionalOrganicRiver=1&regionalView=river`; explicit `regionalRouteHeight=foundation` is experimental. Mountain opt-in `?regionalWhitewater=1&regionalRiverCourse=organic&regionalView=river`. Ordinary structured mode stays off; old course and accepted-lake-only previews remain available.

## Increment 31: independent banks, shoreline materials and measured cleanup

The owner identified the equal-width brown river-bank strip as a rope and explicitly requested variable terrain-facing width, textures/splat mapping and lake-shore material changes. After seeing the new bank comparison, the owner said “it is better now” and authorized improvement and cleanup before introducing simulation. This assessment accepts the bank direction as useful progress; it does not certify concept-art quality, all mountain views or completed world placement.

Hypothesis: independent bounded shore displacement and bank footprints, spatial relief and existing terrain texture blends can produce the required visible variation without a second terrain-tile stack or bank erosion pass. Moderate initial confidence; disprove through continued rope/uniform-face appearance, wet-channel or cut-budget failures, lost terrain character, or fine costs over roughly 5 ms per ten matched outputs without sufficient visual return. Retain the accepted lake and course; use one model for gentle and mountain banks.

[Actual game gallery](http://localhost:8181/tools/perf/structured-terrain-results/organic-banks/index.html), [full implementation/ROI/failure record](tools/perf/structured-terrain-results/organic-banks/README.md), [all raw timing rows](tools/perf/structured-terrain-results/organic-banks/measurements.json), [source/environment manifest](tools/perf/structured-terrain-results/organic-banks/session.json), [validation](tools/perf/structured-terrain-results/organic-banks/validation.json).

**Final implementation.** Independent 23 m / 7 m left/right fields displace each wet edge by up to 12% of nominal half-width. Longer existing fields independently choose 1–45 m dry-bank extents and low shelves versus steep faces. A configured 6 m dry-bank cut cap prevents broad shelves bulldozing uphill walls; the carve never raises its incoming base height. Existing halo/indexing bounds the new reach. Bounded ±0.45 m, 3 m spatial noise supplies analytic bank gradients while global tile micro remains masked where it could close the wet core. Existing rock/sand/dirt/small wet-mud textures blend by distance, slope, above-water height and patches in classification/smooth splat before lighting. The old post-lighting brown colour override remains only in legacy mode. Lake shore material changes reuse current ownership/level and one shape-field texel, without another height pass or mask. No added atlas, tile output, erosion pass, tile regeneration/queue change, global network or SWE.

**Cleanup and final polish.** Shared CPU/WGSL physical limits and shore octaves avoid divergent indexing/geometry; a shared dual extent helper removes duplicated math, small halos clamp to a valid minimum, and uniform-slot comments/tests preserve simulation fade. Compile-time optional geometry/material calls and cache keys preserve separate legacy/organic variants. Separating noise helpers/static emission did not demonstrate a causal first-use speedup. The mountain close view exposed a broad grey face; final rock strength now varies with the existing sediment field, adding arithmetic but no noise lookup or texture fetch. Its automatic captures are a final polish check, without new owner assessment. Close atlas repetition and some smooth faces remain; Runevision natural erosion is already in supporting terrain, and a separate bank pass has not earned its cost.

**Complete measured costs.** Apple M1 Pro / 32 GiB, macOS 26.6.2, Node 26.10.0, Dawn/Metal; Chrome 155 actual renders. Five alternating forward/reverse bank 0/1 rounds use the same ten addresses and requested output types within each gentle/mountain case. Warm complete timer charges six-face foundation, shape/depression/lake and receiver attempts/proofs, grid/profile heights, course/index, quadtree traversal, water allocation/upload, all fine outputs and a completion fence. Initial setup, both shader prewarms and diagnostic audits/hashes are outside warm comparisons; first-use includes initial setup and all initial outputs. Wall time includes CPU/GPU queue; no isolated GPU timestamps. Different terrain cases/revisions are not interchangeable causal rankings. Native jobs and final browser jobs are sequential; early browser trials overlapped and one orphan capture contaminated a frame trial, both retained/excluded.

| Saved native revision | Complete warm median legacy→organic (ms) | Ten fine median legacy→organic (ms) | First-use/setup (ms) |
| --- | ---: | ---: | ---: |
| [native-cleanup-gentle](tools/perf/structured-terrain-results/organic-banks/native-cleanup-gentle/benchmark.json) | 160.625→164.237 | 85.716→87.755 | 51035.332/358.503 |
| [native-final-gentle](tools/perf/structured-terrain-results/organic-banks/native-final-gentle/benchmark.json) | 161.770→164.335 | 85.971→87.905 | 52375.938/368.980 |
| [native-material-gentle](tools/perf/structured-terrain-results/organic-banks/native-material-gentle/benchmark.json) | 161.262→162.790 | 84.933→86.988 | 76565.467/25568.466 |
| [native-mountain](tools/perf/structured-terrain-results/organic-banks/native-mountain/benchmark.json) | 134.706→132.764 | 88.670→90.326 | 1386.819/423.470 |
| [native-polish-gentle](tools/perf/structured-terrain-results/organic-banks/native-polish-gentle/benchmark.json) | 157.958→165.106 | 84.275→86.202 | 1412.990/342.597 |
| [native-polish-mountain](tools/perf/structured-terrain-results/organic-banks/native-polish-mountain/benchmark.json) | 135.419→139.551 | 91.181→95.421 | 51203.229/335.861 |
| [native-static-gentle](tools/perf/structured-terrain-results/organic-banks/native-static-gentle/benchmark.json) | 162.797→161.090 | 85.693→87.818 | 1346.415/341.892 |
| [trial-1/native-gentle](tools/perf/structured-terrain-results/organic-banks/trial-1/native-gentle/benchmark.json) | 162.751→168.540 | 88.315→87.549 | 75009.432/24928.203 |
| [trial-2/native-gentle](tools/perf/structured-terrain-results/organic-banks/trial-2/native-gentle/benchmark.json) | 167.815→159.202 | 86.279→84.915 | 76638.087/25694.674 |

Final fine overhead is 1.927 ms gentle / 4.241 ms mountain per ten tiles. Complete ranges overlap: gentle legacy150.762–362.674 / organic152.232–294.349 ms, mountain133.397–218.442 /135.683–143.265 ms. All first-round outliers remain; no speedup. Changed programs observed roughly51–77 s first-use through outputs, cached subsequent processes~1.3–1.4 s. Setup/compile probes observe~25 s when needed versus~0.34–0.46 s cached. Cold compilation remains unresolved and its regression attribution is not established. This does not satisfy the less-than50 ms moving-view requirement. Final organic tracked peaks48,727,624 B gentle /48,101,696 B mountain; legacy first-round peaks56,695,376 /56,327,256 B have unexplained extra overlap, later peaks largelymatch. No memory-saving claim; setup/driver/pipeline/whole-game pools excluded.

**Finite correctness/preservation.** Gentle: 9,696 channel samples and mountain: 2,640 have zero dry/raised/uphill failures, maximum cuts9.026/20.552 m and minimum depths1.780/1.655 m. Each case reads49,152 final-height texels; tested wet786/599 have zero failures, minimum depth1.198/0.105 m. Bank samples1,608/432 have zero raising/dry-cap failures, maximum dry cuts4.205/5.529 m, extents1–45 /1.027–45 m. The dry-bank audit uses the height evaluator and final-height texels check wetness; these are finite audits, not continuous final dry-bank incision/wetness proofs or bounds on every later material-micro contribution. All 8,100 gentle and 2,220 mountain course-point floats match increment 30. Helper/static/physical-limit cleanup reproduces100 gentle base-mip outputs exactly; final material polish changes only three middle classification/splat/scatter outputs, all ten gentle height/normal outputs unchanged. No mountain pre-polish digest baseline is available. [Exact regression records](tools/perf/structured-terrain-results/organic-banks/output-regression.json). Tests322 tests / 49 files pass, shader variants compile, targeted lint/diff checks pass. All 997 prior evidence artifacts remain byte-identical; source snapshots/validation retain the initial540-source baseline, final copies and protected edits. No staging/commit/push/reset/serverrestart.

**Visual attempts and failures.** Trial1 short-displacement/shelves lacked spatial detail and retained brown tint; fixed-six-second readiness permits holes and mountain close cameras enter ground, so these are limited/failed comparisons. Trial2 adds spatial relief but still paints brown. Trial3/native-material add real splat/dry-cap structure. An invalid WGSL reserved identifier `patch` is corrected, all failed/then-corrected Naga logs retained. A material browser times out waiting water readiness with no page/GPU exception, cause unknown. An interrupted mountain capture retains three partial images/no final report; its orphan Chrome was identified and closed. The four completed `mountain-final-game` images show the grey face but frame observations overlap that orphan and are not causal evidence. Final probes reuse exact saved cameras/daylight, wait zero pending/active/copies and exactVisibleRatio1, retain actual served source hashes and serialize complete production render/fence samples. Full actual records, compiler probes, attempts and logs are linked in README and the catalogue. Favicon404 is separate from page/GPU exceptions.

Final full production render/fence medians legacy→organic (180 observations/view after30 warm) are gentle channel23.500→26.050 ms, close22.300→24.200 ms; mountain channel25.150→23.700 ms, close25.900→24.450 ms. Corresponding p95:30.200→35.100,29.200→35.900,38.500→28.300,37.500→33.000 ms. Visible address inventories match all pairs and remain stable; gentle background loaded inventories differ (648→598 /676→635), mountainmatch (743/770). Sequential order/external GPU activity remain uncontrolled; repeated mountain live observations change sign (23.150→23.300 /23.900→25.900 ms), so no causal shader speedup. Serialized work pauses game update and excludes catch-up/motion. The live mountain attempt has 3/1 pending material copies after its channel screenshots; retained as limited image timing. The corrected helper takes final mountain images while updates are paused after render/fence draining; all final capture states have zero pending/active/copies and exact visible ratio 1. Both final reports have zero page/GPU errors and18 served-source hashes matching current code. Final gentle water/initial-load8.484/26.688 s legacy versus33.051/75.979 s organic; mountain8.416/12.160 versus8.086/11.428 s. These uncontrolled startup observations neither isolate bank cost nor show fast-travel readiness. [Render summary/all observations](tools/perf/structured-terrain-results/organic-banks/render-measurements.json), [gentle](tools/perf/structured-terrain-results/organic-banks/gentle-polish-game/banks/browser.json), [mountain](tools/perf/structured-terrain-results/organic-banks/mountain-polish-game/banks/browser.json). Final rock variation reduces imposed rock strength but leaves naturally rock-classified faces uniform; it is modest polish, not a complete texture-quality solution. General placement/yield/paging/shared region crossings remain unfinished; no new near geometry or structured SWE integration is added. Existing legacy WaterRiverSim/ShallowWaterSim modules are preserved and inactive in these previews; audit their reuse for the later simulation stage. The owner authorizes this cleanup; do not reopen broad lake topology or silently roll into simulation.


## Increment 32: nearby Whitewater equations and water displacement

The owner accepts placement/banks as sufficient to proceed and explicitly asks to inspect Whitewater and prior disabled attempts. The local Whitewater staggered-grid solver was already ported; integration and the mismatch between a geometric river level and hydraulic equilibrium are the problems. Full diagnosis, stage failures, source snapshots, dimensions, sampling/compilation boundaries and reproducible commands are in [whitewater-near/README.md](tools/perf/structured-terrain-results/whitewater-near/README.md).

The new path (enabled by default at the owner’s October 11 request) lazily creates only carved-direction sampling for a close simulation; structured placement still needs no sampled hydrology grid. It simulates a 256 m strip, shifts entering rows, initializes already wet, bounds elapsed-time catch-up, and renders solved bed-plus-depth with turbulence displacement, flow normals/ripples and moderated foam. It uses current lake/river ownership and premultiplied water/atmosphere treatment; the accepted level/body and static ribbon remain available while compute and surface pipelines compile asynchronously. The optional asynchronous material backend path is tested and only enabled for this new material. No complete terrain outputs are rebuilt for simulation; the production captures report zero queued/done/pending water regenerations.

Unrestricted mountain SWE starts with up to 12.04 m water columns on a steep prescribed gradient and only placeholder 2 m³/s regional inflow. At 30 seconds it deviates by 13.49 m, wets 661 cells above the original level by >10 cm and nearly saturates foam. Reference trials identify and correct residual wet/dry pressure, foam-slope, advection/flux/momentum defects and the upstream ghost-face boundary. The adopted local model balances those base defects and evolves disturbances; it is deliberately externally driven rather than a global conservative hydraulic solve. Its visual reference discharge is selected from the window area/slope instead of modifying accepted placement records. The low-level unrestricted ShallowWaterSim mode remains available. Do not erase these differences by describing this as a complete physical river system.

Final native gentle/mountain initial CPU construction requests take 0.877/0.900 ms; first complete construction+placement through a GPU fence takes 131.056/132.279 ms, repeated placement 5.673/4.294 ms. Two/four/eight solver substeps measure isolated GPU medians 0.328/0.590/1.180 ms and 0.197/0.393/0.819 ms (timestamps quantized near 65.536 µs). These include the three compute passes, not production rendering. Simulation buffers declare 1,323,216/667,856 B; surface indices add 385,560/189,720 B plus small uniforms. Transient bed sampling, driver allocations and whole-game pools are separate. First-use caches remain uncontrolled, so asynchronous compilation is not claimed as a measured cold speedup. The actual numerical bed/row frames and three state snapshots remain byte-identical across the compilation change in both cases.

At saved 2/10/30 second native checks there are no negative/nonfinite depths or wet cells above the original level by more than 10 cm. Largest sampled surface deviation is 2.57 cm gentle /9.56 cm mountain; mean foam at 30 seconds 1.94% /11.22%. These finite checks are not continuous bank/final per-tile micro-height proofs. The default physical GPU suite still passes still-lake, closed-bowl mass, uniform flow and film spin-up checks. The new driven steep/curved reference remains a fixed point with zero depth/volume drift and <5e-7 m/s velocity error over 8.33 s without turbulence; a 20 cm perturbation evolves and stays bounded to about 4.4 cm. All 326 repository tests /51 files pass. Lint has zero errors and two pre-existing backend warnings.

Final real Chrome captures compare regular water, frozen simulation mesh and advancing simulation within each page. All six fixed views have full visible residency, stable identical selected/loaded inventories, zero generation/copy queues and zero water-triggered regeneration. Complete render/fence medians are around 22–25 ms; differences change sign between runs, so no speedup is claimed. Native and browser GPU jobs ran sequentially. Normal activation at 150 m altitude /120 m distance is checked, with a warm visible fade around 643–650 ms; static water remains visible. Fast-movement whole-view readiness below 50 ms remains unproven. Tile queuing is untouched.

The gallery includes actual motion and retained invalid/harsh initial comparisons. The first browser trial deactivated before capture and cannot validate simulation visuals; the harness now rejects inactive captures. Source/validation inventories identify final runs and distinguish initial trials lacking full archived source identity. Visual limits remain simple opaque body/reflection, procedural patch foam, current bank texture repetition/smoothness, no explicit boulder/wake/spray/underwater/refraction system and omitted strip curvature metrics. Continue improving those by measured return without reopening the accepted lake shape or reintroducing dry-first terrain regeneration.

### October 11: enabled for owner testing

The owner explicitly requested the new close flow/displacement to be on by default. `runtimeConfigs.js` now enables `waterGraph.sim`; the JSON world loader retains this setting. Existing `riverSim=whitewater` links remain compatible and `riverSim=off` is an explicit comparison override. Nearby activation thresholds and the 256 m strip are unchanged. A fresh actual-browser default-path check uses no enable flag, no widened thresholds and no forced placement: the simulation automatically runs with finite state and zero page/WebGPU errors. See [default-path report and motion](tools/perf/structured-terrain-results/whitewater-near/default-on-game/browser.json). One resource 404 is retained in console events. This does not turn experimental regional terrain generation on globally.

## Increment 33: placement across the actual game planet

The owner corrected the simulation-only default and explicitly requested general placement for live gameplay testing. One persistent macro foundation supplies distributed candidate regions on all six faces; quiet regions use the accepted bounded organic potential, rough regions smaller natural spline basins. The common planner/certificates/cut budgets remain unchanged. A direct-indexed atlas carries accepted patches, halos, levels and micro/ownership controls to fine terrain, carved-bed sampling and LOD proxies. A sparse three-slot receiver index prevents per-sample scans of all lakes. Candidate/region/river work is bounded and unsuitable sites are recorded. River and lake IDs are unique; receiver certification avoids other authoritative patches and existing lakes. Device/programming errors propagate.

World placement and carve publication finish before first tile generation. Travel reuses the same placement key and records; all five final actual-game views report zero water-triggered regeneration. Main runtime defaults now enable this system, organic banks and Whitewater; world JSON supports nested overrides. Historical explicit regional preview presets disable world placement to retain their original scopes; `regionalTerrain=0&regionalBanks=legacy&riverSim=off` provides the older configuration.

Default results: **48 source lakes (18 rugged pockets), 13 analytic receiver lakes, 13 rivers**, across six faces. Receiver lake shapes still need polish. Default budgets: max48 sources/192 candidates/24 rivers. Alternate seed7, diagnostic12-source/8-river budget:17 lakes/5 rivers on five faces, zero GPU errors. This is useful finite planet population, not unlimited paging or connected global drainage. Owner visual approval of the rollout is pending.

Complete native regional preparation **4.79 s first trial /3.00 s final**; final water allocation/publication/fence **49.74 ms**. Six final tile outputs cost **52.22 s first-use**, then **7.79–12.52 ms**, with corrected decoded core depths **3.50–4.00 m** and finite heights. Initial normalized-height labelling error is preserved with correction; six samples are not an all-shore proof. Default browser regional preparation3.31s; initial water11.39s/terrain15.66s after navigation (earlier first-use57.37s retained). Settled render/fence medians **10.85–23.45 ms**, exact coverage1 and no queues/regen at capture. First-visit detailed settling **2.1–8.2s**, not a coarse-view latency result. The <50ms movement goal is unproven; no queue changes in this increment. Persistent generation GPU inputs **91,477,264B**, declared typed CPU planning18,269,140B; excludes rendering pools, driver and transient peaks.

**333 tests/53files pass**, targeted lint0errors/one inherited warning, final browser0page/GPU errors. The first travel audit used stale pre-teleport coverage and is marked limited; corrected measurements wait for selection advancement and residency stability. Final runtime/code/source provenance and actual images are in [the increment 33 gallery](tools/perf/structured-terrain-results/placement-defaults/index.html) and [full measurements/limits](tools/perf/structured-terrain-results/placement-defaults/README.md). No reset/stage/commit/push.


## Increment 34: lake and river population for exploration

The owner found the live world too sparse and requested roughly1000+ lakes and hundreds of rivers. Default budgets now allow448 supporting fields/2048 candidate sites,1200 lakes and320 rivers. Actual default:1200 certified lakes/320 connections from445 fields, across all six faces. Full seed7:1133/320. Up to8 lakes reuse each128-cell supporting eroded field and its prepared spline hulls. Quiet terrain uses varied, jittered disjoint bounded organic depressions; rough terrain natural minima. Every basin retains the common wet-cell and retaining-ring proof. A geometry-only farthest-site order improves distribution without another height pass; sample-land nearest lake median6.60km/p9512.62km. Rivers route to already-certified lower lakes rather than separately generating analytic receiver lakes. Placement enforces the existing two-lake-per-cell lookup capacity, and tiled masks keep all1200 lake masks resident before first terrain generation. No travel-time dry-first regeneration is introduced.

Final native regional preparation7318.68ms; publication/fence289.96ms. Generation GPU inputs163,519,248B; separate water buffers/masks60,822,000B; declared retained typed planning arrays21,718,276B, excluding service/rendering/driver/transient peaks. Generation-only CPU fields are released after atlas publication. Binary mask hashing removes multi-second JSON serialization. Six final nine-output128px tiles take51923.59ms first-use then8.57–17.71ms, with2.00–4.78m decoded core depths and no nonfinite samples. All1200 pre-channel certificates have minimum rim0.50000079m and core depth1.50044m. Six final tile probes are not all-shore proofs.

The smaller supporting grid exposed blocky material coverage at lake shores. A material-only interpolated coverage channel softens that boundary and extends dry-bank texture blending. Before/after lake/river descriptors and sampled normalized core heights are identical; all five browser camera poses and selected inventories match. Actual comparison images remain, including the blocky earlier material edge. Further shoreline relief, glints and texture polish are still needed.

The final first-use browser records regional32.49s (24.95s foundation first-use), water ready40.83s/initial detail84.68s. The warm fresh-default run is regional8.02s, water16.40s/initial terrain20.61s after navigation. Settled complete render/fence medians13.30–23.20ms, with exact residency1, no generation/copy queues and zero water-triggered regeneration in all five views. Whitewater runs automatically in both river views. First-visit detailed settling1.85–12.13s and compilation remain real costs; these measurements do not establish<50ms coarse-view movement readiness. No queue changes, unlimited paging, ocean routing or physically conservative junctions in this increment.

338 tests/53files pass; lint0errors/one inherited warning. Final browser0page/WebGPU errors, one favicon404.322 served JS/HTML hashes match the final working tree. All2148 previous evidence artifacts are byte-identical. [Gallery](tools/perf/structured-terrain-results/planet-water-density/index.html), [costs and limitations](tools/perf/structured-terrain-results/planet-water-density/README.md), [native report](tools/perf/structured-terrain-results/planet-water-density/native-shore/report.json), [validation](tools/perf/structured-terrain-results/planet-water-density/validation.json). No reset/stage/commit/push. Owner visual approval of the new global population is pending.


### 2026-10-11 — increment 35: startup device-loss handling and bounded atlas upload

The owner reported a white blank game before any terrain appeared, then device loss, rejected mapping/scopes/compilation diagnostics and repeated failed copy fences. Strong adapter/device references already exist. No spontaneous loss was reproduced; terminating an owned browser GPU process produces the exact external-Instance message. Root cause of the owner's shutdown remains unresolved.

One shared terminal device state now stops foreground/background GPU work, handles pending diagnostics/counter-readback failures and preserves unrelated error reporting. The game shows an explicit reload action. A startup injection with no visible tiles, four pending copies and282 generation requests stops at frame19 without unhandled rejections; reload restores1200 lakes/320 rivers and full exact initial terrain residency. Post-load injections also recover.

A confirmed memory spike was removed: accepted supporting GPU images are destroyed as soon as their readback/CPU planning is done. An iterator uploads unchanged atlas texels, skipping zero padding and fencing each ~4 MB batch. Largest queued inputs4,393,216 B vs148,799,232 B;61,121,640 B of accepted regional images are no longer retained at atlas allocation, and the full CPU packed-image allocation is removed. Persistent generation input stays163,519,248 B; measured estimated complete-game peak payload is still about1.66 GB. Resource-pressure mitigation is not proof that memory caused the original browser fault.

Native regional preparation7425.42 ms, warm fine tiles7.07–18.38 ms after first590.78 ms. All1200 lake/320 river records and six core samples match increment34. Independent52 MB atlas hashing is identical. Default browser water ready16183.5 ms/initial terrain20138 ms, five settled visuals complete with no water regeneration or page/GPU errors.344 tests/54 files pass. Shader-disk-cache-disabled tests leave system caches intact; truly cold startup and<50 ms coarse movement are unproven. [Complete evidence](tools/perf/structured-terrain-results/planet-water-device-loss/README.md).
