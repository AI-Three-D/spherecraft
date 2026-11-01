# Shared terrain at river–lake junctions

The production path now uses a two-dimensional terrain field around each actual
lake connection. This replaces the analytic segment cross-section in the mouth
interior. The reviewed analytic version is retained outside the influence area
and in /private/tmp/river-reviewed-final-sources.json as a source checkpoint.

## Geometry

- Original solved lake masks identify connected basins. A flood on fine natural
  terrain and an exact distance transform reconstruct each basin boundary.
- A smooth union joins the ordinary river domain to the basin. A screened bed
  solve shapes both banks and the submerged fan together. A hydraulic depth
  obstacle prevents the solve from lifting a narrow throat above its water.
- The solve cuts terrain; it does not fill over natural hills. A bank collar
  relaxes into the existing ground. A gradual approach guide prevents an
  underwater shoulder where the original channel enters the junction.
- Lake levels remain prescribed inside each connected basin. Nearby mouths
  share one patch, including connections to different basins. Their published
  rectangles are disjoint, so overlapping fields cannot compete.
- Cubic sampling carries a continuous gradient into terrain normals. Influence
  is full within 128 m of a mouth and fades over 48 m, returning to the existing
  reach and hills farther away. These distances are configuration values.

## Production ownership

JunctionFieldService selects nearby patches, samples terrain in small GPU
batches, solves in a module worker, and publishes immutable buffers through
JunctionFieldStore. Affected resident terrain regenerates after publication.
The store keeps at most 16 published patches and the service caches 32 on CPU.
The regular-grid water experiment was rejected: clipping its domain exposed
polygon cutouts, while unlimited coverage flooded unrelated depressions.
Production retains the conservative lake and river meshes. A shared basin
lookup selects lake ownership in the field interior without another river
search. Multi-basin patches keep the existing surface ownership path.

Precomputed lake records omit deepest-point metadata; seed selection falls back
to the solved lake centre and validates preferred directions. A river can stop
at another river before its nominal destination lake. Endpoints outside that
lake patch are excluded from local lake boundary conditions.

## Review status

The integrated seed-fix run published the fields and produced clean wet/dry
captures of the reported views, plus below-surface views of the corner and moat
joins. Evidence is under tools/perf/structured-terrain-results/
river-mouth-rebuild-2026-10-29/junction-production-seed-fix/.

The final cold production run, junction-production-cold, completed 14 wet/dry
views with 23 cached patches, 16 published fields, no bake failures and no GPU
errors. It includes the endpoint eligibility filter and final draw masks.
The initial production-first run published zero fields and is invalid as visual
evidence. A live shader reload mixed a cached lookup with a new caller; those
invalid images were replaced. Production cold loading does not use that hook.

Focused solver, packing, clustering and shader checks pass. The full suite has
552 passing tests and the existing WorldConfigLoader pixel-ratio mismatch.
Typechecking and diff checks pass. Final frame and fixed-tile costs, including
the remaining regression against the original baseline, are in RIVER_REVIEW_2026-10-31.md.

No commits were made.
