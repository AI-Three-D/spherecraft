# Water attempt handoff — 2026-10-22

## Disposition

Stopped at the user's request. This attempt has **not delivered the requested water quality**. None of the five visual requirements below is claimed complete. This document supersedes any implication of production readiness in earlier WATER_* checkpoint reports.

The working tree is uncommitted WIP on HEAD `c6bf6a2` (`Water checkpoint: river redesign R1-R4, lake/river junctions, reviews`). Preserve it for review; do not assume every change should ship. No commit was made during this wrap-up. Temporary browser material, mask, and terrain-detail overrides have been restored; the final cleanup reported no running overrides and no GPU errors. The diagnostic browser and local server were left available.

## Accountability

I concentrated on narrow coverage, routing, and terrain-consistency defects, and allowed the diagnostic work to displace the full visual task. I repeatedly used local numerical improvements as checkpoints without making the user's original checklist the acceptance gate. I also spent too much effort on capture/prototype infrastructure and did not close the loop between measurement and the actual nearby appearance.

Most seriously, I did not establish the alpine / plateau / steep-river / gentle-river / underwater test matrix early. Later work kept returning to the same gentle-terrain area. Width, pools, constrictions, and bank variety were left untouched. Discussing integration before those requirements were demonstrated was premature. These were prioritization and verification failures, not missing user authorization or unclear requirements.

| Requested outcome | Actual status at handoff |
| --- | --- |
| Width variation, pools, constrictions, twists and varied banks | Not implemented in this attempt. Existing procedural shapes do not meet the requested richness. |
| Sound river ends, mouths and middle sections | Still visibly broken in the supplied area. Local fixes remove some causes, but gaps, pointed/artificial mouths and abrupt shapes remain. |
| No visible shoreline dithering | Not verified fixed. Continuous alpha and depth handling were changed; that does not establish that all speckling or intersection artifacts are gone. |
| Transparent shallows, convincing bottom, ability to dive | Partial rendering changes only. The bottom can show through, but its appearance remains pale and repetitive. Underwater viewing was not validated across the required cases. |
| Alpine, plateau, steep and gentle terrain verification | Incomplete. Earlier isolated lake experiments are not a current end-to-end acceptance run. The latest seven-pose survey is in the user's gentle-terrain area. |

## Reproduction and evidence

Use the user's exact configuration:

`/wizard_game/standalone.html?regionalTerrain=0&regionalBanks=organic&riverSim=off&waterPrecompute=1`

All seven supplied camera poses are in [userFailures.json](tools/perf/waterStepReview/userFailures.json). The diagnostic session used port 8220 and Chrome CDP 9226, fixed lighting/weather, a hidden HUD, viewport 1440×900, and internal canvas 2160×1350. Those capture conditions differ from ordinary interactive play.

Evidence root: [water-quality-2026-10-22](tools/perf/structured-terrain-results/water-quality-2026-10-22/).

| Directory | What it represents |
| --- | --- |
| `solved-levels/` | Authoritative river-level fix and narrowed bed materials. |
| `complete-lake-index/` | Additional overlapping lake candidates visible to the GPU query. |
| `fine-channel-over-valley/` | Fine channel precedence over coarse valley cuts; seven images inspected, with bank and contact measurements. Many failures remain. |
| `lower-lake-destinations/` | **Rejected intermediate variant.** It also changed flood seed heights, moved other routes, and worsened contact. Its results do not describe the final code. |
| `lower-lake-destinations-isolated/` | Latest routing code, with the seed-height change removed. All seven captures completed without reported GPU errors. No complete contact survey or full visual acceptance review was run on this final variant. |
| `diagnostics/` | Mask, detail and cost experiments; see limitations below. |

The contact checker uses drawn terrain triangles including stitching. It is useful evidence, but its roughly centimetre-scale sampling uncertainty makes small flags ambiguous. It does not certify visual quality, river variety, underwater rendering, or cases that were never captured.

## Uncommitted changes to review

### Surface rendering and bed appearance

Files: `core/renderer/backend/webgpuBackend.*`, `contracts.d.ts`, `resources/material.js`, `water/NearWaterRenderer.js`, `WaterSimRenderer.js`, both water surface shaders, `core/world/water/waterWgsl.js`, and terrain material/carve shaders.

The water pass can read scene depth while using read-only depth attachment handling. Near-water shading computes absorption/contact alpha from depth, uses premultiplied blending and two-sided normals, and performs opaque occlusion in the shader. Nearby terrain returns its bed material instead of painting it with the far water-body colour. Cached organic bed/bank splats were added, then narrowed after an overly pale sand version failed visually.

This is an approximation, without a complete underwater fog/refraction treatment. The simulation surface path was edited but was not runtime-verified: the user's configuration disables simulation. The visible gravel-road appearance remains a failure. The profile discard now compares to the queried segment's level (`hit.etaM`), but the guard remains: simply deleting it floods disconnected pockets. A production connected-coverage replacement for rivers was not delivered.

### Lake identity, river invalidation and intermediate destinations

Files: `WaterService.js`, `lakeRefine.js`, `riverRefine.js`, `waterWorkerCore.js`, their tests, and `WaterGpuData.js`.

Fine lake seeds are preserved instead of replacing them with displaced coarse cell centres. Lake changes/merges invalidate dependent rivers and remove obsolete incision data. Cache identity includes refined lake information. Current versions are `WATER_ALGO_VERSION = 'water-v20'` and `RIVER_SOLVE_VERSION = 16`.

The latest change allows a river to terminate in an intervening refined lower lake instead of continuing toward an obsolete coarse destination. A dependency frame and lake identities are recorded for cache validation/invalidation. In the measured case, river 2576 changes from a 1041.129 m reach toward lake 2848 to a 196.609 m reach ending in lake 2851. Four other compared river point arrays remain identical to the preceding capture. Spatial invalidation breadth and behaviour at scale still need review.

An accompanying experiment that raised flood seed heights to lake levels was rejected and removed. Do not reintroduce it based on the rejected evidence directory.

### River levels, lake lookup and terrain consistency

`riverRibbon.js` now uses solved level field P[16] for modern records; legacy records keep their old handling. The previous re-anchoring raised one measured ribbon 7.638 m above its solved surface. This fixes a concrete disagreement, not all river ends.

`WaterGpuData.js` and `waterWgsl.js` now support sparse overflow beyond three overlapping lake candidates per index cell. Previously a fourth lake sheet could draw while the river lookup missed it. Four cells used overflow in this scene (80 bytes of entries, with 512 KB buffer capacity reserved). Candidate packing, shrinking and overflow tests exist.

`riverCarve.wgsl.js` and `earthLikeBase.wgsl.js` give the fine channel precedence over a coarser valley cut near the channel, blending back outside it. This restores over-excavated ground without raising it above the original terrain. It is **not** the user's requested selective raised-bank implementation.

For river 2569, the measured worst bank deficit to water level +0.3 m fell from 3.365 m to 0.447 m; length needing more than 1.5 m fell from 188.55 m to zero. At `user-stepped-bank`, flagged river contacts fell from 3526 to 2062 and maximum drop from 3.009 m to 0.285 m. Those remaining flags and screenshots prevent a completion claim. Another audited reach, river 467, still had a 4.0915 m worst deficit and 53.109 m exceeding 1.5 m.

## Experiments that are not production fixes

- A lake-only fine mask at lake 628 filled shoreline gaps but flooded down the outlet into lower basins. It was restored. Lower-body ownership is still necessary; do not integrate that mask alone at outlets.
- The fixed-height lake mask/cache prototypes are in `tools/perf/waterStepReview/`; `WaterPageCache.js` is also untracked. They are not a completed camera-driven production lake system. They have limited-region/face handling and do not solve general outlet ownership.
- Narrow rivers can disappear under coarse drawn terrain even when their fine heights are correct. Non-regional LOD distance is based on the sea-level tile centre rather than the local elevated surface. Global detail changes cost about +4.87 ms in an earlier experiment and were rejected.
- A local river-detail browser experiment improved one broken reach, increasing visible tiles from 161 to 173 and measured frame time by about +0.41 ms. It was restored and is not integrated.
- A separate composition comparison measured about 7.575 ms for current transparency plus local detail versus 10.16 ms for restored older composition in one view. This used fenced whole-frame wall time, **not GPU timestamps**, and retained other current fixes on both sides. It is not an untouched-HEAD benchmark or evidence of a general performance budget being met.
- The lake-index overflow ABBA comparison showed no regression in its one measured view (about 7.69 versus 7.81 ms). This also is not a global performance result.

The earlier dense per-fragment triangle-query prototypes, broad pale-bank material, blanket guard removal, seed-height routing variant, and lake-only outlet mask must not be mistaken for accepted solutions.

## Validation limits and handoff constraints

Relevant hydrology/ribbon suites passed 34 tests across four files during this round. After removing the seed-height experiment, the two affected service/worker suites passed again (11 tests). Typecheck passed before that final small removal. Earlier shader and packing checks passed. `git diff --check` was clean at wrap-up. No final comprehensive test run was performed after the user asked to stop; these checks do not establish the visual requirements.

Preserve the user's constraints for the next attempt: negligible added frame cost, distance-dependent accuracy, no nearby exposed gaps, no planet-wide fine data, lazy regional cached coverage, and lower water bodies owning overlaps. The user authorized narrow bank raising only where needed, to water level + roughly 0.3 m, blending over a few metres; measure raised height/length and lower river levels locally where correction would exceed roughly 1–1.5 m. That bank work remains outstanding.

The next owner should judge changes individually against the original visual checklist. No part of this handoff is a claim that the current branch meets that checklist.
