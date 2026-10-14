# Independent review of floating lake and river edges

Reviewed 2026-10-14 on `water-ponds`, HEAD `639e5a9`, including the existing uncommitted work. This review reads the implementation, the handoff and v100–v115 evidence; independently reproduces current rendering; and runs a browser A/B and numerical counterexamples. It changes no production code.

Follow-up: [WATER_COVERAGE_COST_REVIEW.md](WATER_COVERAGE_COST_REVIEW.md) adds measured GPU/memory/input-acquisition costs and corrects the original proposal by separating stable world connectivity from contact with the current rendered triangles. Read that follow-up for the refined implementation recommendation.

**Verdict:** the complaint is justified. The implementation still permits water surfaces to end above submerged ground by construction. Claude has made useful local improvements, particularly the source-lake hold, but has not established the boundary rule needed to fix the general problem. More band sizes, smoothing and outlet exceptions will keep moving the defects around.

The fundamental problem is multiple authorities for water coverage and terrain height. Having separate lake meshes, river meshes and distant shading is not inherently wrong. Those passes can remain if they consume a consistent definition of connected water and its level.

**1. High priority: the new river profile discard assumes something the carve explicitly does not guarantee.**

At `core/renderer/water/nearWaterSurface.wgsl.js:239`, the comment says that where the channel profile is above water, the ground “always is.” The following line discards the ribbon on that assumption.

The carve is cut-only. `riverSectionHeight` (`core/world/water/riverSection.js:153`) preserves or lowers natural ground; it cannot raise low natural terrain up to the assumed bank profile. Consequently, a profile above the water does not prove actual ground is above it. Another river's cut can lower that ground too.

A counterexample using the actual exported functions: half-width 20 m, offset 19 m, bed 0 m, full depth 2 m, ledge banks, natural ground 1 m, water 1.5 m. The analytic profile is 1.9391 m, but the final terrain is 1 m. The ribbon shader discards a surface over ground half a metre below the water. This is a logical error, independent of lake resolution.

I also tested this in Chrome by removing only that discard from a cloned material in browser memory. All terrain, widths, levels, masks and other clip rules remained unchanged:

| Pose | Current gap | Without profile discard | Gap pixels before → after |
|---|---:|---:|---:|
| s3 | 10.7156% | 9.7365% | 43,704 → 39,725 |
| o4-mouth | 13.0777% | 10.9788% | 10,215 → 8,638 |

This proves the guard rejects some valid coverage. It also proves removing it alone does not solve the problem. The half-width cutoff and lake boundary still apply. The guard was introduced to suppress shards caused by terrain approximation; replacing it requires checking those earlier cases, rather than simply deleting it and calling the work finished.

**2. High priority: lake masks are being used as shorelines without proof that their edges meet terrain. There is also an additional dilation absent from the brief.**

The lake fragment ends at `F <= surfaceDepthRangeM` (`nearWaterSurface.wgsl.js:164`). `WaterGpuData.js:410` sets that range to minus half the solve spacing. Depth testing hides water behind dry terrain, but it cannot fill missing water where the mask already discarded the sheet.

The brief correctly identifies dips between 32 m samples. However, its description of the resulting boundary as the solve's -16 m contour is incomplete. `resampleLakeMaskSdf` (`core/world/water/lakeMaskSdf.js:97`) takes the **largest** signed distance under a coarse atlas texel. That is a conservative expansion intended to preserve narrow channels. It is not sampling the distance at the texel centre.

A numerical check with a perfectly straight shore at x=512 m, a 32 m solve and 64 m atlas texels gives:

| Atlas sample x | Correct signed distance | Uploaded signed distance |
|---|---:|---:|
| 480 m | +32 m | +48 m |
| 544 m | -32 m | -16 m |

The reconstructed -16 m crossing moves from x=528 to x=544: **another 16 m of expansion beyond the nominal band**, even before considering curved shores. This is a counterexample, not a claim that every reported lake has exactly this displacement. Pond 2825's finer atlas need not use the pooling path.

Thus there are at least three separate errors to audit: coarse source heights, biased atlas resampling, and smoothing/filtering of the resulting field. B-spline smoothing can make an erroneous boundary look smoother; it cannot establish where the ground actually contains water. The comments in `lakeMaskSdf.js:11` and the lake fragment assert that the band ends under ground without providing that guarantee.

**3. High priority: the headline gap metric does not test “no floating water.”**

`tools/perf/riverMetrics/ownership.js:43` limits the measured area to river zones or drawn river water. It treats terrain water colouring as a water owner. Both choices are useful for diagnosing coverage, but insufficient for the user's visual requirement.

- A lake shore outside a river zone is excluded. The freshly reproduced o4-star reports **0% gap**, with only 220 pixels in the wet denominator, while tint 9 visibly shows red submerged ground along its problematic right shore.
- Terrain coloured as water can count as owned even if the raised water mesh is missing above it. That is precisely one way the dark cyan can remain visible without increasing the gap class.
- Percentages are projected screen pixels for a particular view, not a percentage of a river's physical area. The denominator changes when levels or coverage change. Absolute counts and physical boundary measurements are needed alongside the shares.

The v115 outlet improvement is real, but “0.01% gap” cannot establish no floating edge. Equally, a river-zone gap may include an isolated depression that should remain dry because a sill separates it from water. Connectivity must be measured before interpreting every below-level pixel as missing water.

There is a second measurement mismatch: the cross-section tools label sampled carved heights “as drawn,” but the hydrology sampler calls `calculateTerrainHeight` (`HydrologyGrid.js:70,82`). The production tile shader adds micro displacement separately (`advancedTerrainCompute.wgsl.js:1547`), and the terrain vertex shader samples/stitches the actual height textures (`terrainChunkVertexShaderBuilder.js:598`). Even `{carved:true}` is not the complete rendered surface. Some existing geometry metrics therefore measure the underlying height function rather than the final triangles.

**4. High priority: the proposed 8 m lake-shore refinement is useful work, but is not a complete fix as specified.**

A seeded flood-fill is the right way to distinguish water connected to the lake from isolated dips beyond a sill. Refining only a shoreline region is also sensible for cost. However:

- An 8 m grid can still miss smaller ridges and dips. Sampling the natural height function more finely still omits river carving and tile micro displacement unless explicitly included.
- Sending that finer result back into 32–64 m atlas texels loses information again. Point-sampled signed distances reproduce an unsaturated straight boundary well; they do not generally preserve curved shores, narrow passages or sub-texel connectivity. The brief overgeneralizes the straight-line property.
- A fixed -4 m band remains an arbitrary cutoff. It has no guarantee that its edge is dry.
- Leaving the worker's lake cells, level holds and rims based on a different 32 m region creates another disagreement at mouths.

Refine the connected shoreline and retain sufficient local detail through rendering. Do not approve “8 m flood-fill + -4 m band” as satisfying no floating water without testing its final boundary against rendered terrain.

**5. Medium priority: junction ownership and CPU/GPU lake queries still disagree.**

`waterRiverAtView` (`waterWgsl.js:421`) selects the nearest traced centreline before checking whether that river actually covers the point. The ribbon fragment rejects the other river there. But `riverCarve_d` (`riverCarve.wgsl.js:98`) takes the lowest cut across all nearby rivers. A narrower or dry nearest river can therefore suppress a wider wet river whose carve lowered the terrain. This is a structural failure mode visible from the code; this review does not quantify its contribution at a particular confluence.

`WaterGpuData.lakeAt` (`WaterGpuData.js:535`) documents equivalence to the near shaders but actually tests discrete, nonzero mask cells. The shader uses the atlas, smoothing, signed-distance threshold and river-yield rule. The worker's source hold uses another bilinear SDF query (`waterWorkerCore.js:682`). The brief mentions the worker/GPU mismatch but not all of these distinct queries.

Also, tint 9 is not strictly “terrain shading only” in current rendering. `NearWaterRenderer.js:118` suppresses near meshes for modes 1–5, but not 9. My o4-star tint capture shows ordinary water meshes obscuring some terrain classifications. Exposed red regions remain useful evidence; the whole image should not be interpreted as an unobscured classification map.

**Why the work has stalled, and whether it is overcomplicated.**

Based on the code and recorded experiments, the work has repeatedly treated the assumed boundaries as correct and patched the consequences: band yielding, lake rims, hold rules, profile clipping and smoothing. Several comments promote an approximation into a guarantee. The profile discard demonstrates that directly.

The source hold fixes one disagreement by adapting river levels to the lake's rendering band. That is a reasonable local repair with measured benefits. It still ties hydrologic decisions to a display approximation. Keeping coarse, pooled, smoothed, worker-side and CPU-side meanings of “inside the lake” synchronized through exceptions gets progressively harder.

The diagnostics and A/B history are valuable. Sharing the cross-section definition between JavaScript and WGSL is valuable too. The unnecessary complexity is the accumulating collection of competing coverage rules. Bank types, curvature, freeboard, rim allowances and aesthetic smoothing have received extensive attention while the simpler boundary requirement remains unenforced. I would change that priority now. This is an assessment of the implementation and process, not a claim about Claude's private reasoning.

The darker cyan explanation is broadly correct: body shading exposes the coverage/geometry mismatch. Changing its colour would conceal evidence without repairing the hanging surface.

**Recommended design and order of work.**

Start with one explicit contract: every visible side boundary of connected water must intersect the rendered ground at its level, or join another water surface continuously. A mesh or mask ending over submerged connected ground fails that contract. Artificial patch bounds must lie beyond verified dry terrain, not at a chosen number of metres from coarse cells.

The owner's clarified acceptance bar is pixel-perfect or nearly so, with an overhaul required if necessary. Under that bar, finer fixed-resolution masks alone are insufficient. I recommend replacing the authoritative near-water coverage path, not continuing to tune its band constants.

1. **Measure that contract directly.** Keep the current owner metric as a diagnostic, but add separate actual-surface coverage, water-to-ground height at exposed boundaries, connected submerged area left uncovered, and disconnected area falsely flooded. Include pure lake edges. Use final tile heights and triangle interpolation, including micro and stitched edges, for rendering checks. Keep fixed low side views as well as top views and report absolute lengths/counts.
2. **Correct river coverage locally first.** Use the existing river level curve and actual connected wet cross-section to find each bank's waterline. Let the ribbon cover those waterlines with margin and let terrain depth hide excess geometry. The channel's `hw` is a carve/design input, not proof of the wetted width. Replace the profile discard once its former shard cases are handled consistently with the real terrain. Do not blindly extend to the entire carve zone: that repeats the disconnected-pocket failure.
3. **Correct lake coverage through the whole data path.** Retain the coarse solve for large-scale topology and an initial spill level. Derive near-water connectivity and boundaries from the final rendered terrain mesh, preserving ridges and excluding isolated hollows. Replace max-pooled distance values as geometric boundary data. Place any broad candidate-mesh boundary on proven dry terrain; depth testing then supplies the visible intersection. A local atlas or contour representation is acceptable only if its approximation error is demonstrated to be subpixel and it preserves connectivity.
4. **Make lake/river handover explicit and shared.** Store connected coverage, surface levels and the transition region once. Equal-level surfaces can share a boundary. Descending reaches must join through an explicit continuous river/fall surface at a known outlet. Choose among candidates that actually cover the point, instead of letting an invalid nearest-centreline candidate suppress another. All renderer and worker queries should consume that definition.
5. **Then remove exceptions and retune appearance.** Retire redundant band/hold/yield rules only after the shared data replaces their responsibilities. Recheck the earlier shard, terrace, outlet and pocket cases. Keep the source hold as an interim repair until the general handover takes over.

This does not require a shallow-water simulation, a full planet re-solve or one giant replacement renderer. A tile-associated water field or local contours could provide shared data while keeping the existing rendering passes. Water-only refinement should read already generated terrain data and update water buffers/textures; it need not regenerate terrain. If computed alongside initial tile generation, its added cost still needs measurement. Connectivity across tile borders must be propagated from established lake/river seeds, not independently flood-filled per tile.

**What the overhaul must contain to meet the pixel requirement.**

Use the selected terrain tiles' final height buffers and actual draw triangulation, including border stitching and fallback LODs. For each candidate water body/reach, intersect the proposed water surface with those terrain triangles. Establish connectivity from known lake/river seeds across wet portions of triangles and their shared edges; a triangle touching water at one isolated point must not automatically connect two basins. Retain the connected wet region and form its water geometry/coverage from those intersections. This approach can make a visible water boundary coincide with the rendered terrain, rather than merely approach a separately sampled height function.

Lake meshes and river meshes may remain separate draws, but their geometry, ownership and junction levels must come from this shared result. Terrain body shading should use the same connected coverage. The lake's SDF and river half-width can remain candidate-search accelerators and distant approximations; they must not override a confirmed connected waterline near the camera.

Cache water results with the terrain tile/data version. Recompute water data when selected terrain, stitching, water levels or connectivity changes, without re-running terrain generation merely to fix coverage. Stitch water results across tile boundaries and publish coherent updates so residency changes do not create temporary hanging edges. Benchmark those water-only updates and their memory use. This is substantial implementation work, but addresses the actual mismatch.

For distant rendering, choose approximations by projected error, not merely a fixed 1 km switch. A surface-height or shoreline discrepancy can be several pixels even far away when seen at a grazing angle. Near/far handover must remain below a stated pixel error budget across the test cameras and movement. If that cannot be demonstrated, keep the geometric surface farther out.

Acceptance should include all existing owner poses, additional views moving along the shore at low height, river confluences and waterfall joins, isolated depressions beyond thin sills, and tile/LOD transitions. Require no measurable exposed boundary above connected submerged ground, no falsely filled disconnected pockets, and no visible near/far gap. Suggested rendering tolerance: at most a half-pixel discrepancy in the tested views, with any persistent hanging edge a failure regardless of the overall ownership percentage. Passing a few static screenshots or reducing a gap percentage is insufficient.

There is one unavoidable physical condition: if final terrain opens a lower escape route through a lake rim, cut-only carving cannot build a retaining wall there. The lake level/outlet or connected water extent must change. A render mask cannot keep a higher lake physically contained merely by ending its sheet at that escape route. Likewise, a blanket “highest water level” field can extend high lake water above a descending river unless it respects the actual spill and connectivity. A shared field is useful only if those decisions are sound.

**Verification and limits.**

The independent Chrome run exactly reproduced the existing s3 and o4-mouth baseline owner shares, then ran the isolated profile-discard A/B. All five views settled; no page errors were recorded. Six focused test files passed, 46 tests total. Those tests currently do not establish the shoreline contract. The two numerical counterexamples are reproducible with the saved script.

Evidence is in [water-review-2026-10-14](tools/perf/structured-terrain-results/water-review-2026-10-14/README.md), including the capture report, baseline/variant images, view definitions and numerical checks. The implementation recommendations are design proposals, not completed fixes or performance measurements. No production source was modified during this review.
