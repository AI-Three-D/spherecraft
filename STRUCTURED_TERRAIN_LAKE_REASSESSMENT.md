# Lake placement reassessment — 2026-10-09

This is an architecture assessment, not a terrain increment. Runtime terrain,
water, and quadtree code are unchanged in this assessment. The owner now
authorizes changes anywhere in the engine when justified by visual quality,
complete generation cost, memory, and regeneration. Earlier restrictions on
changing the compute stack are no longer a fixed boundary. Preserve the
uncommitted rollback and unrelated changes; no commits or pushes.

## Decision

Stop developing the independent raised-hill enclosure. Keep its optional
prototype as evidence, but its earlier proof-of-concept acceptance is
superseded by the owner's assessment that it looks artificial. It establishes
that terrain can publish a known basin; it does not establish a convincing
mountain lake or an architecture we should generalize.

Use **one depression/containment pipeline** for plains, plateaus, and mountains.
Adapt lake level, extent, and sampling effort to local morphology rather than
implementing a separate alpine lake maker. Small, partially filled natural
depressions are promising. Large lakes require a correspondingly suitable
floor/enclosure, not a larger radius forced onto a slope. Gentle underwater
deepening can make an existing basin useful without constructing its scenery.
The owner's later steering adds an explicit frequency compromise: common cheap
plateau lakes and rarer sites needing additional analysis. Algorithmic fast
paths are appropriate; distinct lake-type systems are not necessary.

The strongest architectural candidate is an **authoritative regional shape
field**, including the important existing landforms and erosion, consumed by
both fine height generation and hydrology. The current reusable continental
macro fields do not contain that shape. Before adopting this larger change,
measure preservation of actual terrain character and complete equivalent
content costs. A sampled discovery map alone is useful for investigation but
does not satisfy the final integral terrain architecture or height guarantee.

## What nature tells us to omit

Tarns occupy glacially carved cirques and are often retained by moraines.
The Mammoth Lakes example includes both moraine depressions lower in the basin
and bedrock depressions scooped out by glaciers higher up. These are landform
relationships, not a circular bowl surrounded by three unrelated hills.
[NPS: Tarns](https://www.nps.gov/articles/tarns.htm),
[USGS: Mammoth Lakes Basin](https://www.usgs.gov/volcanoes/mammoth-mountain/science/mammoth-lakes-basin-california).

The useful engineering inference is **size follows available basin geometry**.
Rugged terrain can contain small shelf/cirque depressions without accommodating
a broad lake. A wide valley floor can support larger water even at altitude;
a long narrow basin can also have substantial area. Altitude alone is therefore
the wrong hard size limit. A flat plateau by itself is not an enclosure.

We can omit efforts to place a lake on every mountain flank, extend every
small pond to its maximum spill level, reproduce every tiny depression, or
manufacture enclosing hills whenever an arbitrary candidate fails. Sparse
good sites are preferable to many cheap but implausible holes. Small lakes
still need adequate spatial resolution: shrinking a patch is useful; sampling
a 30 m lake at 150 m intervals is not.

Closed ponds do not require finding their entire downstream drainage. Lakes
that feed rivers do require a real or deliberately carved outlet. That work
cannot be removed by choosing a lower water level. We should also evaluate
whether the network should admit headwater sources without requiring a lake
for every river; no such behavior change is implemented here.

## Why the current mountain result is artificial

The optional feature first evaluates the established terrain stack, including
mountains and Runevision erosion. It then blends toward a different local
recipe: a macro-anchored floor, two side bumps, and a head wall. The old local
residual is compressed to ±1.5 m and material micro to ±0.5 m in its interior.
The new hills are added **after erosion**. The sampled maximum lift versus
original terrain is about 113 m. This is substantial replacement of the local
shape, not simply a gently deepened natural valley.

The walls and floor have no shared origin with the surrounding mountain
features. Their smooth shape is partly unpolished, but the discontinuity in
landform construction is structural. Adding noise or eroding these hills might
improve them, yet would not establish that the approach generalizes. I optimized
for an easy containment proof too early and treated that proof as stronger
evidence of a good placement architecture than it was.

A terrain-owned valley remains a valid alternative if it is generated as part
of the **parent mountain/valley system**, with its floor, headwall, sills, and
erosion sharing that structure. That is a more significant terrain change and
must be assessed as such. It should not become a collection of separate lake
styles, each with its own placement/search/carving code.

## Why the plateau algorithm cannot simply be reused unchanged

The existing planner ranks candidates, certifies a continuous outer rim, then
applies a shallow irregular radial cut in height generation. Its mathematical
guarantee is useful and the plateau result is close enough to defer polish.
However, two aspects select against actual mountain pockets:

1. The conservative certificate minimizes over unknown positive relief and
   worst possible erosion/detail. Its tighter slope allowance requires proving
   that all eroded mountain/hill relief is absent. A naturally sheltered floor
   within a mountain feature does not necessarily satisfy that condition.
2. The morphology score explicitly penalizes positive relief and input slope.
   Its 150 m local samples favor broad quiet land between distant peaks and can
   miss small pockets. Remote enclosing peaks do not establish a local sill.

Previous rugged-site certificates required roughly 202–206 m of cutting even
when the proposed radius shrank from 60 to 30 m. Shrinking the basin does not
remove an erosion/detail uncertainty allowance that remains hundreds of metres.

The circular/radial rim is also restrictive. A natural lake follows the
connected valley contour; an elongated or concave shore may not be adequately
represented by sixteen angular controls. Keep the accepted lowland form, but
make the common representation upgradeable to a local signed distance field
or contour with islands/branches where those earn their cost.

Minima are necessary regional data but insufficient for placement. We also
need enclosure, narrow escape/saddle information, available floor area, and
uncertainty. A low point on a steep downhill slope is not a lake basin.

## Read-only experiment on the existing terrain

`tools/perf/structuredLakeReassessment.mjs` uses the native production hydrology
height sampler with the current six shared macro roots, without basin cuts,
the valley feature, or water publication. Four existing sites each receive the
same 2,048 m patch at 64/32/16/8 m spacing. For each patch there are four complete
GPU sampling/readback/fence rounds and six calls to the existing CPU
`solveLakePatch`, including its allocations. The seed is the lowest sampled
local minimum within 400 m of the site. This is **one diagnostic seed per site,
not a measurement of world placement yield**. Final material micro is absent.

Raw data:
[first use](tools/perf/structured-terrain-results/lake-reassessment/first-diagnostic.json),
[second process](tools/perf/structured-terrain-results/lake-reassessment/diagnostic.json).
The [interactive height-map diagnostic](http://localhost:8181/tools/perf/structured-terrain-results/lake-reassessment/index.html)
shows connected footprints at different levels. These are actual sampled
original heights, but not game screenshots or proof of visual quality.

| Original site, 8 m samples | Sampled basin observation |
| --- | --- |
| Accepted lowland site | Natural depression about 357 m in equivalent diameter, 1.17 m deep to spill. A plausible opportunity for gentle bed deepening already exists. |
| Earlier surveyed highland plain | Only a 43 m equivalent diameter, 0.19 m deep local depression. Raising water by even 1 m escapes the patch. Surrounding high peaks do not make this a useful local alpine enclosure. |
| Rugged site rejected by current certificate | At 1/2/4/8 m above its sampled low point, closed footprints have equivalent diameters about 56/79/108/153 m. Following the solver toward its full spill expands the basin to the patch limit, where that spill is unconfirmed. |
| Existing natural basin 17 | About 1.29 km equivalent diameter and 11.40 m deep to spill at 8 m spacing. At lower levels it also offers smaller connected footprints. |

“Equivalent diameter” derives from area; it is not a measured width or a claim
that the shore is circular. No terrain was deepened to obtain these results.
The rugged observation is a promising counterexample to our current placement
filter, not yet a certified lake.

Resolution matters beyond level convergence: natural basin 17 has similar
spill levels at 32/16/8 m spacing, yet the existing solver reports its spill
unconfirmed at 32/16 m and confirmed only at 8 m. Sampled levels agreeing is
not sufficient evidence of correct containment or outlet connectivity.

| Patch | Sample/readback/fence medians, second process across four sites | Existing whole CPU flood medians | Typed solve allocation lower bound, excluding input |
| --- | ---: | ---: | ---: |
| 64², 32 m spacing | 0.685–0.819 ms | 0.510–0.925 ms | 104 KiB |
| 128², 16 m spacing | 1.237–1.413 ms | 2.148–2.367 ms | 416 KiB |
| 256², 8 m spacing | 2.848–4.067 ms | 8.988–9.675 ms | 1,664 KiB |

Timings retain all raw rounds. First process 128² lowland flood median was
4.714 ms; the first 64² lowland flood had a 5.868 ms round. Do not report only
the fastest/JIT-warm values. The simple chosen-level connectivity checks have
single-call timings and are not a robust performance benchmark.

The **complete investigation**, including setup, roots, sampler compilation,
all sixteen patches, repetitions, file output, and second-run threshold checks,
took **2,819.453 ms first / 962.422 ms second**. Inside those totals: setup
353.253/368.398 ms, roots88.203/69.679 ms, sampler compilation1898.981/61.444 ms.
This is not a complete production placement/river/generation workload and not
a controlled shader-cache comparison: the second run includes extra threshold
checks. It is evidence that a bounded flood is not inherently a seconds-long
substage on this machine. It establishes neither low-end performance nor the
50 ms per-river target.

Shared root payload is 14,452,608 B (13.78 MiB). Height input ranges from 4 KiB
at 32² to 256 KiB at 256². Flood typed allocations are 26 bytes/cell, excluding
input, JS stack/outflow/results, worker transfer, driver and rendering storage.
The chosen-level BFS allocates 5 bytes/cell, excluding input/results metadata.
Process endpoint RSS is 258.88/290.07 MiB; these include the native runtime and
are neither incremental lake memory nor peaks. Full runtime regeneration was
not performed because no runtime increment was made. Previous complete
generation/replacement evidence remains in the measurements; no improvement
over it is claimed by this investigation.

## Reassessing the cost of flood fill

The old expensive path is a pipeline, not just a traversal. It samples a global
six-face 512² graph, produces heights/climate, builds graph topology, samples
local patches, solves source and receiving lakes, routes/refines rivers, and
may reroute after receiving levels change. Local lake patches start with a
1,500 m margin, grow by 1.6 up to three times, and allow up to four million
cells. Dependencies and repeated height evaluation/readback add further cost.

A 3 km by 3 km patch at 16 m spacing is already about 35,000 samples before
adding the actual lake extent. Three growths multiply area by approximately
16.8. Four million cells would need roughly 99 MiB of the measured solver's
typed arrays alone. That is a very different workload from one bounded 64² or
128² regional patch serving several small sites.

The current solver places every cell in a heap. Priority-Flood research shows
that already discovered depressions can use a plain queue, reducing priority
queue work. This is a possible incremental optimization after useful patch
bounds are established; no published speedup is claimed for this engine.
[Barnes, Lehman and Mulla: Priority-Flood](https://arxiv.org/abs/1511.04463).

Compute shared topology once per generation region, not a fresh entire flood
for each candidate. A simple implementation can reuse fill levels and parent
paths across selected seeds. Nested basin merging can later use a depression
hierarchy, also shared with outlet/drainage records; full runoff simulation is
unnecessary for static placement.
[Barnes, Callaghan and Wickert: Fill–Spill–Merge](https://esurf.copernicus.org/articles/9/105/2021/).

Start with batched GPU terrain generation/readback and a bounded CPU worker
solve. The fixed cost of thousands of GPU dispatches/readbacks is an obvious
concern; a GPU flood implementation is not automatically the best return on
effort for a few thousand cells. Use deterministic cell/work caps, with
frame scheduling controlling when work runs rather than hardware-dependent
timeouts controlling which lakes exist.

## One pipeline, with size adapting to morphology

The common sequence should be:

1. Generate regional terrain shape and its height/error intervals. A cheap
   minimum/curvature/roughness pass ranks regions; humidity and marine
   connectivity filter water occurrence.
2. Obtain local depression candidates from the shared shape. A known footprint
   that already passes a cheap containment certificate can bypass flood/search;
   use that fast path more often. Do not require
   the region's lowest point: a small high shelf may be above its main valley.
3. Select an admissible connected footprint and level within size/depth/cut
   budgets. A steep exterior is fine when the local floor is sheltered. A
   broad floor may support a larger lake; a narrow floor gives a small or
   elongated one. Reject rather than repeatedly expand an unsuitable patch.
4. Refine ambiguous boundary/saddle cells and certify containment against the
   actual final height model. Broad steep walls well above water need less
   effort than a nearly level escape sill.
5. Gently deepen the bed within that footprint, preserving the dry slopes.
   Reuse the accepted lowland cut where its radial form is sufficient;
   support contour/SDF footprints through the same record and shader stage.
6. Publish level, footprint, bed contract, and any verified/carved outlet to
   both coarse water and fine terrain. Closed lakes omit outlet routing.

Thus the algorithm changes; it is not merely the existing fixed-radius
plateau planner with a flag for mountains. The **same algorithm and records**
operate on different available basin shapes. Terrain-generated known basins
can feed the same validation stage without a separate water system.

Below-spill levels are a useful compromise for small closed lakes. They do
not require finding the maximum connected basin, and avoid enormous patch
growth. For a river-fed/source lake, either use a verified natural saddle or
incise a feasible exit to its chosen level. Check the complete exit corridor
and excavation cost, not just an “exit direction” hint. The sampled rugged
site's small low-level pond does not yet demonstrate a cheap river outlet.

## The important engine overhaul: shared shape, not just shared base height

Three alternatives deserve separate treatment:

| Alternative | Benefit | Main limitation | Assessment |
| --- | --- | --- | --- |
| Keep analytic terrain, sample small local patches | Least terrain change; quickly measures natural basin opportunities | Samples do not bound intersample erosion/detail; fine compute still repeats old work | Useful investigation/first discovery prototype, not the final guarantee |
| Bake an authoritative regional shape and add bounded fine residual | Shared exact height model for fine terrain, basin topology, routes, bounds; may remove repeated landform/erosion work | Interpolation may soften cliffs/gullies; shared generation and residency may outweigh savings | Preferred architectural experiment |
| Generate parent mountain/valley systems with known floors and sills | Coherent high-quality basin settings; fewer discovery failures | Larger landform rewrite, uncertain visual preservation and cost | Use if natural terrain lacks enough convincing sites, not decorative hills around selected water |

For the second option, bake the established important relief and erosion at a
fixed physical resolution into a canonical meso generation field. Fine tiles
consume its continuous shape and add the remaining bounded micro work. Bake
only terms actually removed from fine evaluation; otherwise this simply adds
work. Do not increase macro richness until equivalent-content savings exist.

```text
existing global macro inputs
             |
regional meso shape + conservative interpolation/detail intervals
       |                       |
shared depression/saddle data   fine height generation + bounded residual
       |                       |
lake records and river exits --+--> intentional bed/channel cuts
       |                              |
early coarse water             height/material/normal textures
```

Meso generation must be independent of visible render LOD, with quadtree
addressing, canonical halo/boundary samples, stable feature ownership and
cross-region drainage records. Fine terrain and hydrology consume the same
versioned inputs. Pin resident fields while descendants/network/in-flight
work depend on them; replace them through fences and scoped invalidation.
This is generation data, not a water-only cache of observed final tiles.

Audit every consumer of height, not only the visible terrain shader: hydrology,
CPU/GPU queries, normals, materials, ground placement, and LOD/error proxies must
agree on the authoritative shape and intentional cuts. Otherwise a fast new
field merely introduces a second conflicting world model. A regional min/max
pyramid can accelerate rejection and LOD decisions; it cannot replace saddle
connectivity. Ordinary averaged mipmaps can erase exactly the floor or narrow
escape relevant to a lake.

Retain always-available global macro roots, with bounded regional refinement.
Do not generate a planet-wide 8–16 m height texture: using surface area alone,
R=131,072 m at 16 m spacing needs about **3.14 GiB for one R32F height channel**,
before cube-grid overhead, intervals, halos or topology. Canonical paging is
necessary. Cold far regions cannot be promised tiny mountain ponds before
their shape data exist; publish a coarse network/visible coarse water early
and refine it under a stable generation contract.

Illustrative regional payloads before halo/topology/CPU mirrors:

| Shape field | R32F height | Optional RG32F lower/upper intervals | Combined |
| --- | ---: | ---: | ---: |
| 64² | 16 KiB | 32 KiB | 48 KiB |
| 128² | 64 KiB | 128 KiB | 192 KiB |

Thirty-two 128² combined fields would be 6 MiB. Intervals may be derived from
control footprints instead of stored everywhere; choose after profiling.
A 64² local footprint needs 8 KiB in R16F or16 KiB in R32F. R16F absolute
heights have inadequate precision for small shoreline margins at kilometre
altitudes; use R32F initially and consider bounded base-relative encoding only
if its memory benefit matters. These are payload arithmetic, not measured
whole-game memory. Existing water/render buffers and compiler stalls can be
larger costs and also deserve measurement under the new engine-wide scope.

## What makes the guarantee usable

Let final natural height be `H = S + δ`, with `S` the authoritative continuous
shape and `δ` a proven local fine-detail interval `[-eMinus, ePlus]`.
Interpolation, quantization, biome/material transitions and numerical error
belong in that interval. Then:

```text
entire retaining boundary: lower(S) - eMinus >= waterLevel + margin
guaranteed wet core:        upper(S) + ePlus - allowedBedCut <= waterLevel - depth
```

A tightly bounded residual near a lake can make this feasible without damping an entire
valley. Keep ordinary mountain relief outside the wet core/shore transition;
do not repeat the prototype's compression of its full enclosure. A material
micro range of 24.4 m cannot protect a 1 m natural sill unchanged: locally
bound that fine residual, certify a stronger sill, or reject the site.
Two-to-four metres of permitted bed deepening is an experiment parameter, not
an adopted universal limit.

Interpolation is part of the terrain model, not an implementation detail.
Bilinear cells give tight vertex extrema but have derivative discontinuities
and saddle connectivity ambiguities. Smooth nonnegative splines have useful
control-point bounds but may soften existing ridges and change basin topology.
Overshooting cubic reconstruction needs polynomial/interval bounds. Test
visuals and final height/material/normal costs for the actual chosen model.

Flooding the sampled controls with eight-neighbour adjacency does not prove
the connectivity of a bilinear/spline surface. Refine ambiguous cells or use
the interpolant's actual contour/saddle topology. Sampled gradients, dense
tests, and agreement between two resolutions are diagnostics, not continuous
derivative or height proofs. The existing erosion dual gradient is not by
itself a certified Lipschitz bound. Any new authoritative interpolation model
needs its own updated regional bounds; do not silently reuse old bounds
derived for the analytic model.

Ordinary terrain minima remain distinct from intentional lake/river cuts.
Cut records must expose their final minima/bed envelopes to dependent LOD,
queries and water. Joining several regions or carving an outlet must preserve
those contracts across halos and source versions.

## Return on investment and the next experiment

The relevant comparison is the **same resulting content**: same terrain sites,
lake/river coverage, complete height/material/normal outputs, active regions,
camera itinerary and regeneration. Measure cold setup/compile, shared field
generation, topology/certification, publication, first visible distant water,
all dependent fine tiles, and final fence. Then measure actual shared consumer
counts and regeneration, CPU/GPU retained and peak/transient storage. A fast
flood substage or faster warmed compiler cache is not the desired result.

For a reused region, the benefit must exceed:

```text
extra shared shape/topology generation + transfer/residency/regen cost
    versus
actual dependent tile/query count * saved repeated work
```

Report shared and complete costs, and marginal lake/river costs separately.
Do not divide all shared work by a hypothetical large number of rivers. The
50 ms preference, or60–80 ms for substantial quality, applies to useful complete
river work; low-end performance remains unmeasured. Version changes must test
both full regeneration and local replacement with overlapping live resources.

The next implementation experiment should be a bounded regional shape input
and **one common natural-depression planner**, first at a representative
rugged site and an accepted lowland control. Use the old stack to build the
shape, compare16/32 m or other justified spacings, and avoid simultaneously
redesigning noise. First quantify natural basin yield across several alpine
settings; this four-site investigation is not that survey. Keep rejected
sites and excavation budgets in the report rather than picking only successes.

The resulting actual-game comparison must show original versus shared shape,
then gently deepened wet basin, at near shore, valley-setting and distant
views. Obtain the owner's visual assessment before further terrain-changing
increments. The still-missing early distant water must be explicitly tested;
a texture footprint remains an authorized fallback. Alpine descending rivers
then need real headwater/exit/receiving geometry, and drop profiles suited to
later Whitewater SWE visuals and displacement. SWE is not a placement solver
and remains deferred.

If useful natural basins remain rare, or interpolation cannot preserve the
old terrain at acceptable cost, change the parent landform generation rather
than spending indefinitely on searches or decorating arbitrary lake points.
Generated basin hints should still feed the same common containment/carving
pipeline. A larger rewrite is authorized, but its benefit must be demonstrated.

## Frequency and fast-motion streaming are part of the architecture

The owner explicitly permits common cheap plateau lakes and rarer mountain
lakes when they need extra processing. Use a common candidate/contract/record
format with an inexpensive known-footprint certificate fast path and a bounded
depression-analysis path. This is an algorithmic optimization, not a separate
terrain feature for each named lake type. Do not flood every plateau region
merely to make the implementation look uniform. Conversely, not every mountain
site should be expensive if its generation data already provide a proven floor
and sill.

Set occurrence and escalation limits deterministically from seed, morphology
and a quality configuration. Select, for example, a small fixed shortlist per
region rather than processing every possible mountain pocket. The exact density,
sample count and shortlist limit need yield/cost evidence. Rarity saves work
only if expensive rejection attempts are also bounded; finding one lake after
hundreds of failed searches is not a cheap rare-lake policy.

Coarse render terrain must publish from the available stable generation inputs
without waiting for optional detailed lake analysis. Queue regional inputs ahead
of dependent fine tiles, batch shared work, prefetch along camera motion, and
discard obsolete render requests without discarding generation inputs still
needed by other dependants. Bound active regional work, worker queues, GPU
readbacks and replacement memory. Avoid head-of-line blocking when one rugged
region needs boundary refinement. Hardware changes may affect when results
appear, but must not change where lakes exist.

Late basin publication also needs a deliberate stability contract. A coarse
base preview can precede local hydrology, but newly arriving water/carving
must not silently invalidate completed fine terrain or pop a new hole under
the player. Final local terrain and water should share a published regional
version, with its cuts known before fine descendants are treated as final.
Prefetch and finite dependency work should make this happen before arrival;
when it cannot, retain an explicit coarse fallback rather than render a
mismatched terrain/water pair. First-visible distant water must not wait for
near-resolution terrain. This dependency/latency tradeoff is a test case,
not a solved property of the current prototype.

The coarse river network should reuse regional basin exits and boundary
connections, with optional terrain-aware corridor search on the same shape
field. It need not flood the entire world at fine resolution or require every
channel to follow an existing natural stream: a bounded canyon cut is allowed.
Keep source/receiving levels, descending surface profiles and independent bed
profiles consistent across versions. Large drops can remain opportunities for
later rapids/waterfalls rather than be flattened to make routing easier. Rarer
mountain lakes must still leave enough convincing high-to-low routes; frequency
is a compromise to validate visually, not a reason to remove that goal.

Benchmark both stationary refinement and scripted fast travel through **new**
regions with the same accepted lake/river content. Record time to first coarse
terrain, time to complete visible fine tiles, worst sustained/p95 frame delay,
queue depth, travelled distance before content catches up, early water,
regeneration, and memory peaks. Include cold pipeline compilation separately:
the existing tens-of-seconds stalls overwhelm millisecond solver savings and
cannot be dismissed as warm-cache behavior. A meso tier is worthwhile only if
these complete streaming results improve, not merely a fine-tile kernel timer.

The next prototype should instrument those waits and shared consumer counts
before adding more features. The engine-wide permission includes generation
dependency handling, quadtree priorities, pipeline reuse and resource capacity;
use it where measured costs identify the largest return. Do not spend a saved
millisecond automatically: keep savings toward the owner's latency goal.

## Hypotheses, confidence and disproof

| Hypothesis | Current confidence | What would disprove it |
| --- | --- | --- |
| Morphology-adaptive connected basins can unify plateau and mountain placement without independent enclosing hills | Moderate; the rugged original-terrain pocket is direct supporting evidence | Representative highland regions lack convincing sites, need excessive cuts, or certification removes almost all candidates |
| Bounded shared depression analysis is affordable | Moderate on this machine, unestablished on low-end hardware | Complete shared/candidate/refinement costs grow beyond budget, particularly ambiguous sills or patch growth; transfers dominate |
| An authoritative meso shape can give useful bounds and reduce repeated terrain cost while retaining visual character | Moderate for the contract, low-to-moderate for preservation/performance | Gullies/ridges soften, normal artifacts appear, nearshore residual suppression is conspicuous, memory/first-use/regeneration costs exceed real savings |
| Small closed lakes reduce work in rugged settings | Moderate; sampled footprints support it | They are mostly visually insignificant puddles, shallow false closures, or all useful river sources require expensive long outlet cuts |
| A parent mountain/valley rewrite is required | Undetermined; a contingency, not the current conclusion | Existing terrain already yields enough good natural basins with tight shared contracts and acceptable total costs |

No runtime representation or new terrain model has been adopted by this
assessment. Diagnostic code and records are uncommitted. Full visual quality,
usable continuous mountain bounds, early distant water and alpine descending
connections remain open requirements.

## 2026-10-09 follow-up: basin and escape topology

Measured increments21/22 restore distant river coverage without extra GPU data
and bound receiver readback to its existing regional window (complete137.727
to135.286ms; aligned receiver transfer8.34MB to20.7KB). No terrain equations
change. Actual comparisons and complete costs are in the main handoff.

Read-only increment23 disproves assuming that the best-looking mountain pond
is automatically a cheap river source. In a capped local graph, the steep
0/7/102/114 pocket has a provisional20.2m incision requirement for a74.5m
descent. Another accepted field4/7/88/97 suggests4.7m for a22.2m descent over
536m. Both remain preliminary estimates without a corridor/bank certificate
or actual river visuals. Two controls have no lower exit within their current
field; neighbouring-region data is needed before drawing global conclusions.

Prefer rarer connected mountain lakes, closed ponds elsewhere, and terrain-owned
escape/portal properties alongside basin minima. Bounded refinement of the same
eroded regional input fits both quiet and rugged land and avoids a second
mountain placement system. Do not build synthetic surrounding hills or a river
ending at an arbitrary prototype boundary. World paging/region connections and
cold/fast-motion readiness still need implementation and complete measurement.

Visual follow-up on4/7/88/97: actual source remains rolling upland, despite
numerically acceptable placement and cheaper outlet. Opposing rise14.9m at120m
and43.1m at240m explains why the present30m preference permits a weak alpine
setting. Keep this as a quiet-upland case rather than calling an eventual
connection a mountain success. Terrain unchanged; actual comparisons and
complete generation costs are recorded in increment23 of the main handoff.


October10, increments24–25: see the detailed handoff record for adjacent authoritative basin fields, bounded monotone mountain descent with one localized fall, rejected excessive-cut/periodic-fall trials, sampled height checks, actual LOD correction and complete/shared/memory/regeneration costs. Native complete10-output regeneration140/139ms typical; first cold compiler stall48.9s remains. Actual paired close water continuity improves, distant river visibility remains unresolved. Extra visible depth11 tiles are not charged by the fixed-output native comparison. Large organically shaped plains lakes are now explicit owner scope and the next bounded prototype; small pond screenshots do not satisfy it.


October10 increment26: regional cut-only depression supplies a known anchor to the SAME spline cell-hull basin proof; no raised hills. Actual617×538m plains lake, estimated0.187km²,881 connected certified-wet cells; potential-radius-only predecessor produced scattered blips and was rejected. Eight-metre control cut cap plus1.5m underwater polish; final262144 texels0 failures, observed core3.997/rim.899m. Complete23-output generation includes the whole lake and halo, regeneration243–266ms in first run; GPU field536712B/typed CPU366692B/water213424B. Known-anchor redundant-scan removal measured across four alternating complete runs (242.295 vs256.444ms medians, overlapping ranges; no full-gap attribution), identities and final height hash preserved. Detailed failed/successful/shared/cold/actual browser records are in the handoff and large-lakes/index.html. Default small-pocket behavior is retained. No50ms/river or low-end/cold readiness claim.


Increment27: distant constructed-river body colour uses the existing near-water body instead of transmitting dry coarse terrain. Continuous2600m-altitude coverage confirmed by ownership tint; no extra allocations. Four alternating real full-render rounds (480/mode): old14.5ms/p95 20.5, corrected14.4/p95 20.9, no measurable penalty. Complete native10-output regeneration medians old137.592/corrected134.095ms (4/mode); native workload does not render the colour, no attributed speedup. Same2568 river/49152 final-texel sampled contract checks pass, max incision22.964m/min final depth0.129m. Live32818544B/peak48087936B,0 GPU errors. Runtime300 tests/44 files. See handoff and mountain-river/distant-body-game|distant-body-cost|body-native. Whole-game low-end pools, streaming, cold compilation and global regional paging remain unsolved.


Increment28 retained: immutable macro-generation foundation shared only from the current generation with exact device/version/source/uniform/cells/seam/budget equality. Reference-counted ownership and final fences preserve failed/old inputs. Explicit regenerate:true remains FULL; regenerate:true,reuseFoundation:true rebuilds dependent features. Versionv12 keys change intentionally. Eight alternating equivalent complete10-output rounds: mountain full median146.038/shared131.979ms, all requested complete output textures per round byte-identical SHA88c5f6834e4331f2c08aad891a4b655ac6abea715b9740a4abe36b1f8becb537. Hash readback/audit is outside measured cost. Regional-rebuild peak48087936→33635520B (-13.78MiB); whole-workload peak48087936→45621728B (-2.35MiB), steady residency unchanged. Native gentle regression full135.621/shared113.643ms, byte-identical outputs/previous river records,0 errors. Real failed feature replacement preserves18496 old samples; changed terrain feature rebuilds and stale sampler rejects. Preatlas single-field sampler difference quantified max0.000366m (0 above1mm), not old/new SHA identity. Runtime305 tests/45 files. See handoff increment28 and mountain-river/foundation-cost|foundation-safety, coarse-river/foundation-regression. Cold compilation, streaming, global paging, low-end pools and50ms complete target remain unfinished.
