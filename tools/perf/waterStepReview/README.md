# Water step 1: profile-discard acceptance experiment

The proposed change is deletion of the single river-fragment predicate
`if (hit.profileM >= in.level) { discard; }`. The capture tool applies it to
a cloned material in browser memory, then restores the original. Production
source is untouched.

The predicate rejects some valid water, but unconditional deletion also
admits disconnected low pockets. The two production-math fixtures preserve
both cases as requirements for the eventual coverage replacement. Passing
these tests means the counterexamples are reproduced; it does **not** mean
the renderer meets the user's shoreline requirement.

```sh
npx vitest run tools/perf/waterStepReview/profileCoverage.test.js tools/perf/waterStepReview/analyze.test.js
node tools/perf/waterStepReview/capture.mjs /tmp/water-step1-new
node tools/perf/waterStepReview/analyze.mjs /tmp/water-step1-new
```

Use an empty capture directory. An optional comma-separated second argument
selects names in `views.json`. The harness uses system Chrome, WebGPU,
`terrain-lab`'s existing Puppeteer dependency, and its own no-cache server
on port 8199. It requires permission to launch Chrome where sandboxed.

Each pose waits for resident terrain, hydrology and regeneration to settle.
It then stops game updates and terrain selection, holds shader time, and
captures guard-on, guard-off and guard-on replay against the same data.
The report records camera, source versions, residency, regeneration,
requested river traces, git revision and fragment hashes. Historical river
names in the pose list identify viewpoints, not a guarantee that river IDs
remain identical across generated worlds.

The analyzer allows normal replay drift of at most one channel value in at
most 10 pixels per million. It still requires exact unchanged debug view 7,
no removed green ribbon pixels, and unchanged recorded source state. It writes images
even if a comparison fails those controls, but exits unsuccessfully. A failed
capture report is rejected. Debug views hide non-terrain overlays as in the
existing ownership harness; normal screenshots retain normal rendering.

`*-before-after.png` puts the original at left and candidate at right.
`*-ribbon-changes.png` highlights added ribbon pixels in magenta and removed
pixels in orange. The normal candidate image underneath is dimmed. Original
screenshots and separate debug captures are retained unmodified.

Limitations:

- The old ownership gap is a river-zone diagnostic. It excludes pure lake
  edges and counts terrain water colour as an owner.
- Connected image components are screen-space evidence only: occlusion can
  separate globally connected water, and projection can join separate water.
- The controlled geometry fixture establishes a disconnected-pocket
  counterexample. It does not reconstruct an actual camera's terrain.
- A static A/B is not a movement, LOD-transition, shoreline-contact, or
  integrated performance test. Those remain acceptance requirements for the
  eventual shared coverage implementation.

## Lake-inclusive shoreline contact (next review checkpoint)

```sh
npx vitest run tools/perf/waterStepReview/contactGeometry.test.js
node tools/perf/waterStepReview/capture.mjs /tmp/water-contact-new o4-star,shot5-sheets,owner-s3-shore,o4-mouth contact
node tools/perf/waterStepReview/reviewContact.mjs /tmp/water-contact-new
```

The optional `contact` argument keeps production coverage and captures only
normal, marked-contact and replay images, plus contact data. The browser
diagnostic reconstructs the selected terrain triangles by executing the
existing vertex function in compute with the same uniforms, UVs, height
textures, instance range and transition indices. This includes micro detail
and vertex stitching. It cross-checks that mesh against visible terrain
pixels. It does not substitute CPU base heights or a bilinear height lookup.

Separate float raster passes retain the water fragment discards and record
water positions and perspective-correct screen derivatives. At each water
boundary, those derivatives extend the actual triangle across the adjacent
pixel. All terrain triangles along that span are tested, including any dry
sill between the two pixel centres. Foreground terrain occlusion is excluded.
A fully submerged span with a minimum radial drop greater than 5 cm is marked
red. Missing terrain is unresolved (yellow), never silently accepted.

Counts refer to **internal render-grid edges**, not final upscaled screenshot
pixels. Lengths in metres sum the projected horizontal/vertical raster edges;
they are view-dependent staircase lengths, not surveyed contour lengths.
Even the screen-grid staircase can exceed a straight diagonal by about 41%;
projection into world space adds further distortion. The JSON includes internal resolution, thresholds, separate
lake/river summaries, per-edge measurements and marked world coordinates.

This is an offline visible-shore diagnostic. It excludes near-water fade,
viewport cuts, water-water level discontinuities, non-terrain occluders and
hidden shores; it is not a global connectivity or false-flooding test. Small
values near the threshold need the recorded numerical checks and threshold
sensitivity to interpret them. The closed-pocket fixture remains necessary.

## Connected lake coverage experiment

```sh
npx vitest run tools/perf/waterStepReview/connectedTriangles.test.js
node tools/perf/waterStepReview/capture.mjs /tmp/water-connected-new o4-star,shot5-sheets connected
node tools/perf/waterStepReview/reviewContact.mjs /tmp/water-connected-new
```

The `connected` mode retains the baseline terrain mesh, identifies one
submerged seed inside the eroded lake interior, and joins submerged triangle
regions through wet shared vertices/edges. It publishes one immutable
planet-coordinate buffer through `WaterGpuData.connectedCoveragePatch`.
Cloned lake, river and terrain materials consume it together. The original
materials and state are restored for the replay. No production import or
terrain generation change is made.

The 8 m bins only accelerate exact projected-triangle queries; they do not
quantize the shoreline to 8 m. Depth testing against the actual terrain
clips connected triangle footprints to their wet regions. Outside available
geometry the old coverage is the explicit fallback. Open mesh edges are
reported, not treated as proof of a closed basin.

This producer depends on the frozen selected terrain mesh. It is a geometry
experiment, not a stable runtime connectivity solver. A constant-level lake
can spread down a connected outlet valley: the report counts replacement
of river/other lake pixels as well as shoreline changes. Eliminating gaps
through downstream flooding is a failed result.

Timing uses six batches of four rendered frames with a GPU completion fence,
before, during and after the patch. These are end-to-end wall-clock samples,
not GPU timestamps or live-game FPS. CPU build time excludes the expensive
diagnostic geometry export. `*-before-contact.json` retains the baseline
measurement; `*-contact.json` describes the candidate. Validator success
means capture controls passed, not that the prototype is an acceptable fix.

## Cached body mask experiment

```sh
npx vitest run tools/perf/waterStepReview
node tools/perf/waterStepReview/capture.mjs /tmp/water-mask-new o4-star,shot5-sheets mask
node tools/perf/waterStepReview/reviewContact.mjs /tmp/water-mask-new
```

`mask` uses the frozen terrain export as a bounded diagnostic producer. Each
river floods from centre-line seeds below its existing level curve. Connected
lower river regions are excluded before lake connectivity is computed. A
4 m ownership mask allows overdraw onto known dry bank. Cells containing both
connected and excluded wet regions refine to 0.5 m. Conflicts and missing
source terrain remain explicit unavailable records; those use the existing
coverage fallback. This is not a proof that those fallback areas are correct.

Terrain shading, lake sheets and added river geometry read the same immutable
mask. Normal cells require one record fetch, refined cells two; river levels
also read a segment reference. The shader does not search triangle lists.
This producer covers a bounded rectangle, not the eventual sparse shore cache.
The stable finest-height producer, runtime caching/eviction, LOD transition
checks and regional hydrology provider are still unimplemented.

An additional timing control fetches mask records without changing geometry
or coverage. Its canvas pixels are compared with the original. This isolates
record lookup more closely than timings of scenes with different water area;
it excludes river segment lookup and additional geometry. Timings are fenced
whole-render wall times, not GPU timestamps. Mask runs now warm up eight frames
and measure twelve batches of four frames per condition.

Contact capture additionally reports visible lake/river adjacency height steps.
These screen neighbours can still be different nearby surfaces, so they are
not an exact survey of the ownership boundary. The mask producer separately
samples its lake/river boundaries in world coordinates at 0.5 m intervals.
Neither check silently treats adjacent water of different heights as joined.

The o4-star audit replays the previous triangle prototype. An unclipped lake
pass reports whether its rejected pixels were covered, occluded by terrain,
or above submerged ground. CPU component IDs and unmatched wet edges help
separate closed pockets from connectivity errors. A component with unmatched
wet edges is not certified closed. The audit is not part of timed rendering.

## Fixed final-height lake source and cache

```sh
npx vitest run tools/perf/waterStepReview core/world/water/WaterPageCache.test.js
node tools/perf/waterStepReview/capture.mjs /tmp/water-final-height-new o4-star,o4-star-lod-coarse,o4-star-lod-fine,o4-star-cache-rebuild final-lake
node tools/perf/waterStepReview/reviewContact.mjs /tmp/water-final-height-new
```

These four captures keep the camera fixed, draw progressively different
terrain LODs, and finally evict/rebuild cached source pages and the mask.
The source uses the production final-height generator (carving, classification
and micro detail), fixed approximately 1 m sampling, and the active UV mapping.
Its input does not include exported rendered terrain; the export remains only
an independent contact reference. The mask SHA-256 and cache counts establish
whether LOD changes trigger a rebuild. Selected tile depths establish that the
drawn LOD really changed. This tests settled LOD states, not every intermediate
streaming frame or camera motion.

Fully wet/dry source blocks may collapse only after checking every fine grid
sample. Mixed blocks retain the finest diagonal; the narrow-ridge test guards
against accepting four wet corners as evidence that the whole block is wet.
Fine acquisition is limited to tiles near the coarse shore within a bounded
world-space region. Interior connections are still assumed from coarse water;
unavailable mask regions retain existing coverage. The experimental producer
and default renderer are not wired together in the game loop.

`coverageAudit.edgesHanging` probes the actual lake coverage at the non-water
neighbour of every remaining flagged edge. It helps distinguish mask rejection
from raster/depth contact; it is not a replacement for the contact check.

## Live LOD and screen-cost review

```sh
node tools/perf/waterStepReview/preview.mjs --open
WATER_PLAY_AUDIT=1 node tools/perf/waterStepReview/capture.mjs /tmp/water-play-new o4-star,o4-star-lod-fine,o4-star-small-window final-lake
WATER_INDEXED_LOOKUP=1 WATER_TIMING_FRAMES=32 node tools/perf/waterStepReview/capture.mjs /tmp/water-pixels-new o4-star,o4-star-bank-45m,o4-star-bank-12m,o4-star-small-window final-lake
WATER_INDEXED_LOOKUP=1 WATER_SPARSE_MASK=1 WATER_TIMING_FRAMES=32 node tools/perf/waterStepReview/capture.mjs /tmp/water-sparse-new o4-star,o4-star-bank-45m,o4-star-small-window final-lake
node tools/perf/waterStepReview/reviewContact.mjs /tmp/water-pixels-new
```

The preview is a visible, reversible switch for one cached region. It does
not implement background streaming. Its optional shore-detail button is a
cost experiment; neither tested detail floor meets the latest frame budget.
Do not leave a second live preview rendering while measuring performance.

`WATER_INDEXED_LOOKUP` compares the original broad-query mask prototype with
one that consults the existing lake index first. It records their normal-image
comparison, timings and the candidate's contact checks. Index misses must not
be accepted as an optimization. It does not modify the production index.

`WATER_SPARSE_MASK` encodes lake-only pages losslessly, checks every distinct
stored state against the dense input, and records bytes and image equality.
The preview uses this variant. Smaller storage has not met the frame-cost
target; it still uses cloned materials and the separate prototype binding.

`screenGaps` follows cardinal raster runs out of mask-rejected hanging edges
until contact, another surface, unknown coverage or 32 pixels. It records
render pixels, CSS pixels and whether the terrain pass actually shades every
pixel as lake water (debug view 7, with sheets omitted). Oblique contours can
overestimate perpendicular width; runs hitting the cap remain unresolved.
This diagnostic does not prove connectivity or certify distant visual quality.
Saved screenshots use device-scale pixels, distinct from CSS/render pixels.
The close-bank poses inspect the left-shore defect of the small-window view.
The nearest-ground-contact search additionally reports Euclidean pixel-centre
distance within 32 render pixels, avoiding treating long oblique raster runs
as perpendicular gap width. A null distance means no contact was found in range.

`depthAudit` changes only the diagnostic depth test or projection: equal-depth
acceptance, depth bypass, and a 16× near plane. Recovery classifies precision
failures; increasing the near plane is not a proposed production solution.
