# Cached water coverage data path

2026-10-16. Design constraints for the next prototype and eventual production
integration. This is a local data path; it does not require planet-wide fine
heights or permanent planet-wide lake/river arrays.

## Publication and rendering

World-owned coverage pages belong to a lake shore or a bounded river reach.
They publish body ownership, coverage and references to the existing surface
level/curve through `WaterGpuData`. Lake geometry, river geometry and terrain
body shading read the same publication. Equal-level overlap can remain with
the lake; a lower connected body wins overlap. River geometry uses its own
existing level curve. No blended surface is being introduced in this step.

The base mask uses approximately 4 m cells in a stable local frame. A connected
wet region may conservatively include dry bank; terrain depth testing then
draws its visible shoreline. A cell that also contains excluded wet ground
must not be filled wholesale. Use a finer submask for such cells, and report
unresolved coverage if the available resolution cannot separate components.
A fixed 4 m binary raster alone cannot promise both complete coverage and no
leak over arbitrarily thin ridges. Linear filtering of categorical ownership
is likewise unsuitable.

The current bounded experiment publishes a packed mask with one record lookup
for ordinary cells and a second lookup for refined cells. River cells also
load the referenced segment endpoints to evaluate the existing level curve.
It uses a GPU storage buffer as a cached mask, not per-fragment triangle lists.
The same layout can be stored in integer texture pages; choosing that API is
secondary to precomputing coverage and bounding shader work.

Production pages should use compact local body/segment indices, mapped to
regional stable keys, rather than encoding arbitrarily large global IDs as
floats. The diagnostic currently uses the small IDs of this test world.

## Stable input and lifetime

The production source must be final generated heights at a fixed physical
resolution, including river/lake carving and tile micro detail. It must be
independent of which terrain triangles happen to be selected for drawing.
Existing finest-resolution height pages can be reused; missing shore pages
can be generated with the height-only production passes. That generation is
real work and must be scheduled and measured, even when it does not regenerate
already displayed terrain.

Cache keys include world-generation revision, regional hydrology/body revision,
stable page coordinates and resolution. Render LOD is not a key. Camera motion
requests additional pages; it does not move the grid or resample an existing
page. Publish complete versions atomically. A source edit invalidates affected
pages and their component links. An unexplored page boundary is not a proven
shore or a proof of connection to a lake seed.

Request pages near the camera, with a prefetch distance based on speed and
build latency. Keep a byte-bounded cache with distance/LRU eviction and
hysteresis. Refine outer shores, island shores, narrow sills and outlet
junctions. Coarse interior regions already known to belong to the body can
remain implicit; do not generate a fine square covering dry hills or the
whole lake merely to service a visible shore. Reuse local component links
across pages. Do not silently close a component at the camera window.

Distant water can retain coarse masks. Rivers may fade out at high altitude,
using a configured projected-size/distance policy. This does not require fine
river masks everywhere visible from orbit. The near/far transition still
needs a measured visual check.

## LOD limitation that caching alone cannot solve

Holding the mask fixed prevents mask-boundary popping. It does not guarantee
shore contact if a coarser terrain mesh removes the dry ridge on which that
mask ends. Before integration, compare the stable fine source against the
actual drawn terrain through LOD transitions. Preserve/refine containment
geometry or bound its error where a ridge could disappear. Otherwise the
same fixed mask can either hang over the coarse mesh or expose a false pool.
Depth testing clips geometry that exists; it cannot restore a missing ridge.

The 2026-10-16 ownership experiment used the frozen selected mesh as its
producer to isolate ownership and mask-render cost. The 2026-10-17 checkpoint
below replaces that producer with fixed-resolution final height pages. Its
mask remains identical across tested render LODs, but shore contact does not:
the coarser rendered terrain exposes gaps. See `WATER_FINAL_HEIGHT_REVIEW.md`.

## Large planets

For radii of 5,000 km and above, page dimensions and acquisition budgets remain
local and measured in metres. Choose fine-source depth from physical spacing,
not from an assumed global quadtree depth inherited from the 131 km planet.
Keep precision-sensitive mask coordinates local; validate the existing
planet-scale float vertex path separately before claiming centimetre accuracy
on a larger planet.

The current global coarse lake solve and river precompute also need regional,
on-demand replacement at that scale. This is separate work. A coverage service
should request regional body/reach descriptions and revisions through a local
provider, rather than scan or own a permanent global array. The prototype's
use of the currently loaded water records is test wiring, not that future API.

## 2026-10-18 quality and frame-cost constraint

The user clarified that geometric precision should decrease with distance.
Close shores must meet cleanly. A distant strip of two or three pixels may
be acceptable when water-coloured terrain conceals it; an exposed hole or
unshaded bank gap does not automatically qualify. Measure visible pixel width
and backing colour as well as world-space drop. Keep render, CSS and saved-image
pixels distinct when resolution scaling is active. This is a conditional visual
tolerance, not permission to grow masks across ridges or admit false pools.

Added steady-frame cost must be negligible. The measured 0.75–1 ms mask
prototype and 1.75–4.75 ms shore-detail overheads are not accepted budgets.
Before production integration, use the existing body index to select a nearby
coverage page, substitute its coverage for the old lookup, and measure the full
render. Check that the index includes the refined extent; a fast lookup that
misses newly connected shoreline is incorrect. Avoid an unconditional fine
mask query for every terrain fragment. Loading and connectivity remain cached
background work, never recurring frame work.

The proposed blanket local detail floors are rejected under this budget.
Any later shoreline refinement needs a measured visible error, a bounded
affected area and a negligible total cost. Metre-scale error alone is not a
sufficient reason to refine distant terrain.

## 2026-10-17 implementation checkpoint

`core/world/water/WaterPageCache.js` now provides byte-bounded, revisioned CPU
page storage, coalesced requests, LRU eviction, explicit far-page eviction and
in-flight invalidation. It has no dependency on a global lake array or renderer
LOD. The application must still supply regional revisions and schedule work.

`tools/perf/waterStepReview/finalHeightLake.js` exercises it with real final
height pages and cached lake coverage. Source spacing is chosen in metres
(approximately 1 m maximum nominal spacing), rather than from the selected
mesh. The active renderer maps normalized tile UV to texels 0 through 127;
the source uses that mapping and the regular grid's diagonal. The previous
research probe's repeated-border remap was a disabled shader branch and must
not be used as the active mapping.

This is still an opt-in integration experiment. It requests tiles near a
coarse shoreline band, retains unsampled interiors, and seeds fine wet shore
components from the interior half of that band. It does not certify those
interior connections for arbitrary lakes. Its mask publication still allocates
a bounded rectangular directory. Sparse publication, adaptive acquisition at
unresolved shores, regional invalidation, background scheduling, multiple-body
publication and moving-camera transitions remain production work.

## 2026-10-18 sparse encoding checkpoint

`sparseLakeMask.js` now encodes the same lake result into a bounded directory
of 64 m pages. Uniform pages are implicit; mixed pages store 4 m cell states
and pointers to two-bit 0.5 m subcells. At o4-star, GPU storage drops from
5.72 MiB to 0.325 MiB with exhaustive state equality and identical images.
The index-first terrain lookup also preserves all tested pixels.

This does not yet replace the production mask lookup. The shader still adds
roughly 0.5–1.1 ms to the measured whole render, which fails the latest budget.
The sparse encoder still consumes a dense CPU intermediate and is not a
background streaming service. See `WATER_PIXEL_BUDGET_REVIEW.md` before treating
either the memory saving or clean close-up captures as production acceptance.
