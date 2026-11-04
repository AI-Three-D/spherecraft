Anthill remodeling follow-up, 30 October 2026.

The previous implementation simplified meshes, but its maintenance and rasterization
could cost more than the density traversal they replaced. In particular, every mesh
publication, reveal step and eviction invalidated stationary hit images. A mine could
keep retracing its entire viewport while the camera and authoritative density were
unchanged. This follow-up removes that invalidation and reduces background work.

Changes:

- Valid stationary intersections survive background mesh changes. Camera, density,
  cut, visibility, viewport and explicit rendering-path changes still retrace before
  shading. Live lighting and shadows continue updating every frame.
- Local edits wait for 750 ms of quiet. Maintenance runs at most once per 100 ms,
  targeting 0.35 ms of main-thread work. Worker submissions are at least 150 ms apart,
  with only one outstanding job. These are cooperative budgets; individual calls and
  garbage collection can exceed the time target.
- Uploads are capped at 32 KiB per maintenance tick in segments of at most 16 KiB.
  Existing uploads and snapshots take precedence over initial discovery. Discovery
  and view scans reserve time for selecting work, so loading a large mine does not
  consume every batch before useful work can finish.
- Job selection examines at most 64 pending entries and rotates through the queue.
  Removing a selected job takes constant time. The previous implementation scanned
  the entire queue and shifted the remainder of its array when selecting a job.
- Extraction stops as soon as interpolation error exceeds the current view's
  allowance. The cache retains an error lower bound instead of uploading unusable
  geometry. A wider zoom can retry; edits reset the bound. This does not relax the
  existing 0.2-pixel selection target, pinned borders or continuous LOD morphs.
- Settled draw lists are reused until the view, enabled state, residency or reveal
  changes. Turning off LOD retains the original density path.

What this improves, and what it does not:

Remodeling really produces fewer triangles. The existing flat-patch test still
reduces 2,048 triangles to 224 without displacing the surface. Rough nearby cave
patches often cannot simplify much within the visual tolerance, or cannot use a
mesh at all. Fewer triangles do not automatically reduce total frame time: this
renderer uses meshes to accelerate intersection, while density remains authoritative
for collision, materials, normals, shadows and exact cut faces. Long visible tunnel
paths can remain GPU-bound.

The bounded maintenance batches and early rejection reduce the overhead of large
networks. They do not compact or stream density, remove its GPU binding limit, or
make arbitrary tunnel networks fit in memory. Density storage and the normal-cache
startup costs remain separate limits. Discovering and remodeling an entire large
mine intentionally takes longer; density rendering stays available throughout.

Reproduction uses the unmodified starting snapshot at
`/private/tmp/anthill-remodel-before-20261030`, served on port 8028, and the working
Anthill directory served on 8026:

```sh
npm test
node dev_harness/remodelBenchmark.mjs --puppeteer /absolute/path/to/puppeteer-core.js \
  --rounds 12 --out /tmp/anthill-remodel-comparison.json
node dev_harness/meshSmoke.mjs --puppeteer /absolute/path/to/puppeteer-core.js \
  --warm-seconds 7 --out /tmp/anthill-remodel-visuals.json
```

The paired benchmark keeps maintenance active, freezes lighting and alternates
500 ms slices in one browser at 1,000 × 700 pixels, waiting for GPU completion per
frame. Each scene starts with fresh mesh caches. Twelve rounds give approximately
six measured seconds per version and mode. Still and moving views exercise normal
hit reuse; moving cameras follow the same time-based path. The large-mine fixture
adds 1,024 remote digs, for 2,270 density chunks and approximately 70.9 MiB of CPU
density in both versions. These are startup/ongoing-maintenance comparisons,
not comparisons after both versions have finished building identical meshes.

On Apple M1 Pro / Metal, headless Chrome 156, the final paired run measured:

| View | Frame median before → after | Main-thread CPU p95 before → after |
| --- | ---: | ---: |
| Still overview | 11.8 → 5.0 ms | 3.3 → 0.6 ms |
| Moving overview | 11.5 → 8.3 ms | 3.9 → 0.6 ms |
| Still 208 m tunnel | 12.9 → 10.4 ms | 2.9 → 0.6 ms |
| Moving 208 m tunnel | 21.8 → 20.3 ms | 4.6 → 0.7 ms |
| Still overview after 1,024 digs | 11.3 → 4.8 ms | 3.9 → 0.5 ms |
| Moving overview after 1,024 digs | 18.3 → 14.9 ms | 3.6 → 0.9 ms |

The still overview issued 319 terrain traces before this change and one afterward.
The large-mine still view issued 189 before and one afterward. The moving long
tunnel's GPU median was 18.42 ms before and 18.64 ms afterward: its improvement
comes from CPU overhead, with essentially unchanged GPU cost. Absolute timings vary
with other system activity, compilation and garbage collection; this is not a
guaranteed FPS multiplier. Both large-mine versions also had a substantial initial
frame outlier (542 ms before, 225 ms after). This change does not eliminate the
initial density/normal upload cost.

After both modes, the large-mine cache held 43 completed patches / 5.06 MiB before,
versus 18 completed patches / 0.54 MiB afterward. This is deliberately less aggressive
maintenance, not evidence that an identical finished network needs ten times less
mesh storage. The unchanged 64 MiB residency cap still applies. See the
[raw paired measurements](remodeling-comparison-2026-10-30.json).

Validation includes **156 passing CPU tests**, with checks for worker submission
spacing, edit quiet periods, segmented uploads, bounded queue selection, progress
during discovery, deferred-error retries, stable draw-list reuse, stationary hit
reuse, generation races, eviction and disposal. The real WebGPU geometry check
exercises five scenes, zoom reversals, reveal transitions, immediate edits and stale
worker results; its [raw results](remodeling-validation-2026-10-30.json) are saved
alongside the paired benchmark.

All five WebGPU scenes passed without browser/GPU errors. The chamber matches density
exactly; cutaway, anthill and long-tunnel comparisons differ by at most one RGB channel
value. The overview retains the previously observed isolated pixel with a larger
difference. Reveal/zoom comparisons have at most one pixel differing by more than
eight channel values out of 700,000; consecutive settled frames match exactly.
Immediate filled terrain matches the density-only centre hit within 0.000000025 m,
and an edit during a worker job rejects the obsolete result. Overview and anthill
screenshots were also inspected for visible surface defects.
