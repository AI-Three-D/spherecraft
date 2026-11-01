# River junction review — 2026-10-31

The production game now uses shared two-dimensional terrain fields at nearby
river–lake connections. Banks and submerged beds are solved together around
the original connected basin, rather than ending a segment-shaped trench at a
lake shelf. Nearby connections share one disjoint patch, including different
lake levels. The transition returns gradually to the existing river and natural
terrain away from each mouth. Geometry details are in RIVER_FOUNDATION_2026-10-31.md.

Grass reaches the visible waterline. The material transition to mud is based
on submerged depth, with broad variation. The active splat filter is 5 in both
the default configuration and the world JSON. Continuous river surface levels
and analytic ripple gradients remove the repeated accordion bands.

## Visual evidence

The fresh production run is [junction-production-cold](tools/perf/structured-terrain-results/river-mouth-rebuild-2026-10-29/junction-production-cold/).
It contains 14 saved owner views in wet and dry modes. The first six were also
recaptured with their original Y-up camera orientation; their PNG sidecars
record the exact camera, resolution and GPU error list. The original per-pose
timings for those six used radial up. The source/moat/accordion timing probes
use the original supplied Y-up cameras throughout.

- [Source opening](tools/perf/structured-terrain-results/river-mouth-rebuild-2026-10-29/junction-production-cold/o29c-mouth-both-banks.png)
- [Corner join](tools/perf/structured-terrain-results/river-mouth-rebuild-2026-10-29/junction-production-cold/o29c-mouth-corner.png)
- [Former moat](tools/perf/structured-terrain-results/river-mouth-rebuild-2026-10-29/junction-production-cold/o29c-mouth-moat.png)
- [Accordion reach](tools/perf/structured-terrain-results/river-mouth-rebuild-2026-10-29/junction-production-cold/o29c-accordion.png)
- Below-surface corner/moat views and their dry counterparts are in the same folder.

The reviewed checks are rounded bank openings, a continuous submerged floor,
no trench end wall, no polygon water cutouts at the reported connections, and
no repeating segment banding in the top-down reach. The conservative lake and
ribbon water meshes remain in use; the rejected regular-grid water experiment
is isolated under tools/perf/riverBanks.

## Validation and cost

552 tests pass. The sole failure is the existing WorldConfigLoader test which
expects pixelRatio 1 although the unchanged default is 1.5. Typechecking,
full junction-enabled WGSL validation, and git diff --check pass.

The cold run published 16 patches from 23 CPU-cached fields, with no bake
failures and no WebGPU errors. The initial production-first capture published
zero fields and is not evidence for the new geometry. The seed metadata bug
and the false lake endpoint on river 468 were fixed before the cold run.

At 2160x1350, adaptive quality off, repeated GPU frame medians are:

| View | Shared junction field | Reviewed analytic version | Original reference |
| --- | ---: | ---: | ---: |
| Source | 12.82–12.84 ms | 12.38 ms | about 10.0 ms |
| Former moat | 11.54–11.55 ms | 12.56–12.58 ms | about 10.1 ms |
| Accordion | 10.50 ms | about 10.08 ms | about 10.1 ms |

The latest draw masks reduce the source cost from 13.54–13.59 ms without
changing geometry. Fixed 80-tile generation before that rendering-only change
measured 507–512 ms at the source and 526–541 ms at the moat, versus 498–502 ms
with the field disabled. Generation remains a few percent more expensive;
the original-reference performance target has not been met. These costs must
not be described as an optimization over the original game.

No commits were made. Unrelated user edits are preserved. A source checkpoint
is saved at /private/tmp/river-junction-production-sources.json; the previous
analytic checkpoint is /private/tmp/river-reviewed-final-sources.json.
