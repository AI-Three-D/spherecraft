# Water step 1 — acceptance tests for removing the profile discard

Follow-up: [WATER_CONTACT_REVIEW.md](WATER_CONTACT_REVIEW.md) supplies the
lake-inclusive contact check and explains the apparent shot 5 narrowing.
The current analyzer accepts bounded single-value normal replay drift;
the exact-zero rejection below records the earlier checkpoint's policy.

2026-10-15. Review checkpoint for Claude. The user requested small steps,
hard evidence, and a critical review before each handoff.

**Decision: reject unconditional deletion as the production fix.** The
predicate is wrong, but deleting it admits disconnected water. Production
rendering and terrain code remain unchanged. The retained work is a
repeatable screenshot comparison and two acceptance fixtures for its
eventual replacement.

The candidate removes only `if (hit.profileM >= in.level) { discard; }`
from the near-river fragment shader, using a cloned material in browser
memory. Water levels, widths, lake masks and generated terrain are identical
within each comparison. The original material is restored afterwards.

## Actual scene evidence

Captured 12 viewpoints at 2880×1800 pixels in Chrome 155 on the M1 Pro.
**Ten comparisons pass all controls.** All 12 retained identical recorded
source state, zero pending regeneration, identical view-7 images, and zero
removed high-confidence ribbon pixels. There were no page or GPU errors.
The production source revision was `c6bf6a2`; exact source and generated
fragment hashes are recorded in the capture report.

Two comparisons are excluded from complete regression evidence:

- `owner-s1-junction`: nearby rivers 2570 and 2573 failed to trace, at about
  1,251 m and 1,789 m from the camera. The resident scene itself replays
  exactly, but the requested river set is incomplete.
- `start-2591`: five of 5,184,000 normal-image pixels differ on replay, by
  one channel value each. The exact cause is unresolved. The comparison
  fails the chosen zero-drift requirement despite unchanged debug masks and
  source state; I did not relax the threshold to accept it.

The analyzer therefore deliberately exits with status 1 for the full set
and records `valid: false`; the ten passing per-view results remain usable.

| View | Old diagnostic gap pixels, before → after | Added ribbon pixels, green ≥ 200 | Comparison |
|---|---:|---:|---|
| s3 | 43,704 → 39,725 | 4,157 | pass |
| o4-mouth | 10,215 → 8,638 | 2,275 | pass |
| o4-star | 0 → 0 | 0 | pass |
| s1 | 10,872 → 4,839 | 8,573 | excluded: traces |
| start-2591 | 10,538 → 7,805 | 3,413 | excluded: replay |
| shot 5 | 13,652 → 11,565 | 2,623 | pass |
| s106-top-50 | 34,824 → 24,823 | 12,301 | pass |
| s112-bank-25 | 4,881 → 1,911 | 3,787 | pass |
| s106-mouth-60 | 31,509 → 25,790 | 6,968 | pass |
| river-sheet-643 | 86,910 → 53,903 | 35,815 | pass |
| strip | 167,817 → 53,197 | 97,300 | pass |
| run22-river-112-1500 | 350 → 346 | 12 | pass |

The s3 gap share changes from 10.716% to 9.737%, and o4-mouth from 13.078%
to 10.979%, reproducing the original review's cause-isolation result.
These percentages are not shoreline-accuracy scores. In particular, the
strip's diagnostic gap count falls by 114,620 while the high-confidence
ribbon count grows by only 97,300. Its ambiguous-pixel category grows from
348,727 to 371,242. Some lost gaps have become ambiguous rather than valid
owners. That metric cannot justify claiming all of its apparent improvement
as corrected coverage.

Under eight-neighbour screen adjacency, the candidate adds two wholly new
components totalling three pixels at s106-mouth, and five totalling ten
pixels at strip. The largest is four pixels. Other poses add no wholly new
components under that rule. This is not evidence of a large new detached
sheet in the captured scenes, and these tiny components cannot establish
physical disconnection. The controlled geometry fixture below supplies the
actual connectivity counterexample.

Visual inspection of normal before/after images confirms that the original
floating lake/outlet edge remains visible in shot 5. O4-star is completely
pixel-identical between the candidate and original. Deleting the river guard
does not address the lake boundary defect.

Review these images at full resolution (original at left, candidate at right):

- [Shot 5: the floating edge remains](tools/perf/structured-terrain-results/water-step1-2026-10-15/controlled/shot5-sheets-before-after.png)
- [s3 before/after](tools/perf/structured-terrain-results/water-step1-2026-10-15/controlled/owner-s3-shore-before-after.png)
- [o4-mouth added ribbon pixels](tools/perf/structured-terrain-results/water-step1-2026-10-15/controlled/o4-mouth-ribbon-changes.png)
- [Historical strip case before/after](tools/perf/structured-terrain-results/water-step1-2026-10-15/controlled/strip-before-after.png)

## What the geometry tests establish

Both fixtures use the actual exported `riverSectionHeight`, `riverChannel`,
`riverSideDepth` and `riverBankParams` functions. They model a straight river
with a 20 m half-width, bed at 0 m, full depth 2 m, water at 1.5 m and ledge
banks. Sampling is 0.25 m. The terrain test applies the cut-only section to
the natural terrain before classifying water.

| Fixture | Additional wet samples after deletion | Connected to river | Disconnected |
|---|---:|---:|---:|
| Naturally low connected bank | 1,377 | 1,377 | 0 |
| Closed low pocket in the bank | 45 | 0 | 45 |

At offset 19 m the analytic channel profile is 1.939111 m, while the actual
cut-only ground can remain at 1 m. This proves why the old guard wrongly
rejects some water. The second fixture gives that low ground closed, smooth
sides. A continuous 0.5 m dry belt surrounds it; the belt's final ground has
a lower bound of approximately 1.8043 m, above the 1.5 m water. Its width exceeds the 0.354 m
sampling diagonal. Four- and eight-neighbour connectivity give identical
results. The pocket is therefore not an ambiguous diagonal or a one-pixel
sampling artifact.

This counterexample does not claim that a particular screenshot contains
that exact pocket. It establishes that the proposed rule cannot satisfy
connected coverage generally. Depth testing hides water behind dry ground;
it cannot tell whether a visible submerged depression connects to a river.

## Critical review of this step

I initially proposed removing the guard as the first small production
change. That was premature: the earlier review already identified the need
to replace its coverage responsibility. The new counterexample makes the
rejection explicit and reproducible. An improved average gap score is not a
sufficient reason to keep this change.

The historical rationale for the guard also needs care. The v48–v53 notes
say clipping and the other experiments did not fix the shards; v54's
separate narrow-river terrain fallback filled the central interruptions.
That fallback remains in the current code. Neither the comment beside the
guard nor the historical screenshots prove that unconditional removal is
safe now.

The new capture checks are deliberately stronger than the earlier review:
the original shader must replay exactly, debug view 7 must stay identical,
removing a discard must remove no ribbon pixels, and recorded terrain,
water and regeneration state must remain unchanged. The first pilot was
rejected because it compared an advancing readback-age timer and allowed
sky animation to continue. The harness now excludes that timer from its
data comparison and holds wall-clock shader animation during captures.

The retained ownership metric is still river-only and counts terrain water
colour as ownership. Screen-space connected components can identify new
pieces to inspect, but cannot establish world connectivity through
occlusion. Neither metric measures lake edge contact, physical separation,
or false flooding in the actual terrain. This step does not certify a
pixel-perfect shoreline.

## Scope of the next step

Keep the connected-low-bank and closed-pocket cases as opposing acceptance
requirements. Build the actual terrain/surface contact diagnostic, including
pure lake edges, before accepting a coverage replacement. Then replace the
guard with connected wet coverage for a bounded river patch, preserving its
existing level. The patch must pass both fixtures, actual lake/river edge
checks, and the historical shard views before expanding the system.

No additional width, level, rim, or colour exception was introduced. No
full camera-window solver or production performance change is part of this
checkpoint.

## Validation and retained changes

23 tests passed across the new fixture and analyzer tests plus the existing
river section and water WGSL tests. The browser compiled and drew both
fragment variants with no GPU errors. JavaScript syntax and whitespace checks
passed. Public contracts and production code were not changed, so no new
runtime overhead or integrated performance gain is claimed.

```sh
npx vitest run tools/perf/waterStepReview/profileCoverage.test.js tools/perf/waterStepReview/analyze.test.js core/world/water/riverSection.test.js core/world/water/waterWgsl.test.js
```

The retained additions are the two geometry fixtures, their tests, the
controlled capture harness, the image analyzer and its tests, camera poses,
and this evidence package. This checkpoint ends here for Claude's review.

The tools and reproduction instructions are in
[tools/perf/waterStepReview/README.md](tools/perf/waterStepReview/README.md).
Raw geometry-fixture results are in
[profile-fixtures.json](tools/perf/structured-terrain-results/water-step1-2026-10-15/profile-fixtures.json).
The concise scene results are in
[summary.json](tools/perf/structured-terrain-results/water-step1-2026-10-15/summary.json),
with full [capture metadata](tools/perf/structured-terrain-results/water-step1-2026-10-15/controlled/report.json)
and [image analysis](tools/perf/structured-terrain-results/water-step1-2026-10-15/controlled/analysis.json).
