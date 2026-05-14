# Splatmaps

## Purpose

Track only the current splatmap architecture, confirmed static-analysis facts, and diagnostics that can distinguish stored-payload issues from renderer reconstruction issues.

## Current Carryover Summary

Read this first when resuming the splatmap rim investigation. This section records the latest mode sweep and readback results so the same checks do not have to be repeated.

Current visible problems:

- There are at least two visible rim types in the same area:
  - **Faint red-arrow rim**: subtle in normal rendering, visible in base albedo modes, and mostly not explained by the clicked stored/union readback.
  - **More prominent rim**: stronger, more AO-dependent, and shows a mode-`63` sand-colored forced-fast artifact.
- AO is an amplifier for at least one rim, not the sole source. A faint non-AO base seam can remain with `terrainAO.enabled = false`.

Latest click/readback status:

- `results.txt` clicked the faint red-arrow rim.
- `results2.txt` clicked the more prominent rim.
- Both clicks used the corrected terrain raycast path, not the old sphere-refine fallback.
- Both clicks had `sourceLayerMatchesRendered == true` and `terrainRaycastLayerMatchesRendered == true`.
- Raycast-vs-rendered local UV error was much smaller than one splat texel:
  - `results.txt`: about `(0.0012, -0.0061)` splat texels.
  - `results2.txt`: about `(-0.0037, -0.0022)` splat texels.
- Treat both clicks as valid samples. Do not re-open the old sphere-raycast concern unless a later diagnostic gives a concrete contradiction.
- Both clicked footprints had `runtimeOrderedValid == false` and `precomputedValid == false`, so production used fallback/union at those exact footprints.
- Both clicked footprints had `productionUnionDelta == 0`.
- Both 17x17 readback windows had uniform stored dominant category `GRASS 10 = 289/289`.
- `terrainAO` and `groundField` were `texture_unavailable` in these readbacks, so AO still cannot be classified from click data alone.

Faint rim readback, `results.txt`:

- Tile/layer: `f1:d11:1024,1024`, layer `1480`, base `46,84`, `f=(0.757919, 0.546831)`.
- Verdict: `production_matches_union`.
- Production/union payload: `GRASS 10 = 0.6104`, `ROCK 42 = 0.0257`, `FOREST 66 = 0.3639`.
- Forced-fast was effectively the same at the clicked footprint: `fastUnionDelta == 0`.
- Stored weights in 17x17 window: `GRASS 10 mean=0.6101`, `FOREST 66 mean=0.3641`, `ROCK 42 mean=0.0245`, `DESERT 150 mean=0.0021`.
- Raw tile grid was mostly `GRASS 11`, with scattered `FOREST 67`, `GRASS 19`, and `GRASS 12`.
- Classification: **Class B1**: uniform-dominance faint rim, little/no desert, no meaningful forced-fast error at the clicked footprint.

Prominent rim readback, `results2.txt`:

- Tile/layer: `f1:d11:1023,1025`, layer `1489`, base `67,9`, `f=(0.341008, 0.950642)`.
- Verdict: `forced_fast_only_differs_from_union`.
- Production/union payload: `GRASS 10 = 0.7452`, `FOREST 66 = 0.2010`, `DESERT 150 = 0.0538`.
- Forced-fast payload: `GRASS 10 = 0.7452`, `FOREST 66 = 0.1349`, `DESERT 150 = 0.1033`, `EMPTY 255 = 0.0165`; `fastUnionDelta = 0.057843`.
- Ordered-ID mismatch behind the forced-fast error:

```text
c00/c10/c01: 10,66,150,255
c11:         10,42,66,150
```

- Mode `63` sand pattern on this prominent rim is explained by forced-fast interpreting channel-filtered weights with the wrong ID slots. This is a debug-mode artifact, not proof that production normal rendering uses the bad branch.
- Stored weights in 17x17 window: `GRASS 10 mean=0.7474`, `FOREST 66 mean=0.1929`, `DESERT 150 mean=0.0580`, `ROCK 42 mean=0.0035`.
- Raw tile grid contained only grass variants: `GRASS 19 = 263`, `GRASS 18 = 26`.
- Classification: **Class B2**: uniform-dominance prominent rim with stored desert minority and a strong forced-fast-only mode-`63` artifact.

Latest visual mode sweep:

- Modes `36` and `40`: no faint rim. Close-ground resolved color is not the source.
- Mode `43`: faint rim visible. The rim is already in base micro color before macro, lighting, AO, fog, and post.
- Modes `45` and `61`: look like mode `43`. The rim remains in final pre-lighting albedo and in production full material with pure-dominant/top-2 shortcuts disabled.
- Modes `62`, `64`, `68`, `69`: no faint rim. Always-union full material, nearest stored material, union minority-luma, and union-vs-raw-tile material delta do not explain the current faint rim.
- Mode `65`: grid plus flat blue color, no rims. Production material shortcuts are not the cause.
- Mode `55`: bright red broadly with dark blue contours on both rims. Production-vs-union weight delta is active, but the rim polarity is not a simple hot-line signal.
- The user also reported a purple-gradient view with dark blue contours on both rims and called it `55` again. This is probably mode `56` based on surrounding context, but keep the ambiguity unless corrected. If it was `56`, production-vs-union material delta is spatially aligned with both rims.
- Mode `57`: bright red but no faint rim. Only a non-rim-like border remains at the more prominent rim. Forced-fast-vs-union mismatch is not the faint-rim source.
- Mode `70`: cyan grains in the faint-rim pattern only when nearly touching ground; grains disappear at greater distance. The location where these grains appear has already been clicked. Do not spend another pass trying to click the same cyan grains unless mode `70` changes to red/yellow/blue/magenta.
- Mode `80`: looked exactly like normal mode `0` in the latest pass. This does not point at LOD-edge AO fade as the faint-rim source.
- Mode `81`: flat blue with no rims. Aerial perspective/fog delta is not the source.
- Mode `82`: only a barely visible trace where the rim runs. Total lighting delta may weakly amplify the seam, but it is not the primary origin.
- Modes `83`-`86`: initially flat white and caused tile reloads. This was a test wiring bug: `_resolveTerrainDebugModes()` only mapped modes `25..82` to fragment-only mode, so `84..86` were incorrectly sent to the terrain generator. The range has been extended to `25..86`; rerun only `84`, `85`, and `86`.
- Mode `83` after the routing fix looks like normal mode `0`. This is expected because mode `83` is currently unused and falls through to the normal render path.
- Mode `84` removes the faint red-arrow rim. At the other, more prominent rim site, a residual stair-step border remains along the left edge of the screenshot, but it no longer reads as the same dark rim.
- Mode `85` looks like mode `84`.
- Mode `86` shows a purple-gradient background with dark blue contours on both rim sites.

Current diagnosis — RESOLVED to root cause:

The faint rim is a **method-switch seam** at the `bilinearValid` boundary in `sampleSplatData()`. This is now confirmed by branch-isolation modes `87`/`88`/`89` (see "Branch Isolation Round" section for full evidence and analysis).

Key facts:
- Mode `89` shows both rim sites are in the `bilinearValid == false` (fallback) region (red on green map).
- Mode `87` (union for fallback pixels): rim persists — fallback and union are byte-identical, no difference.
- Mode `88` (union for fast-path pixels): faint rim completely absent — the fast path is the seam source.
- The seam is the visual contrast between fast-path pixels (hardware `textureSampleLevel`) and adjacent fallback pixels (manual 4-corner `textureLoad` accumulation). When mode `88` makes all pixels use manual accumulation, the contrast disappears.
- AO is an amplifier only. Do not chase AO until the base seam is fixed.
- The more prominent right-side rim: mode `88` shows a staircase there, but it reads as the Class A stored dominant-category flip, not the faint Class B rim. These are different mechanisms.

Next work — pick ONE of these options and implement it after measuring:

1. **Check generation first (zero shader cost)**: verify whether `splatCompute` stores exactly unit-sum weights. If stored texels don't sum to 1.0, hardware bilinear and manual accumulation normalize from different raw sums, which is the seam source. Fix in `splatCompute` weight storage if that's the case.
2. **Replace fast path weights with manual bilinear**: in `sampleSplatData()` fast branch (line ~1646), replace `sampleSplatWeightsFiltered(uv, layer)` with explicit 4-corner `loadSplatWeights` + manual bilinear math (identical to what the fallback/union path does). This eliminates the method switch. Cost: 3 extra `textureLoad` calls per fragment for the bilinear-valid majority of terrain. Measure FPS before/after.
3. **Transition zone blending**: keep the hardware fast path but, within N texels of a `bilinearValid == false` neighbor, blend toward the manual result. Preserves fast-path savings for interior terrain. More complex to implement.

Do not implement option 2 or 3 without a FPS benchmark first. The fast path (`sampleSplatWeightsFiltered`) was a deliberate optimization.

## Concepts

- **Splat category**: visual terrain material category, such as grass, sand, forest, rock, or snow. Tile variants within one category are not independent blend channels.
- **Splat payload**: sparse top-4 `(representative tile ID, weight)` pairs per splat texel. `splatDataMap` stores weights. `splatIndexMap` stores representative tile IDs.
- **Smooth source**: output types `7` and `8` from `advancedTerrainCompute`; this is the continuous category-weight input to `splatCompute`, separate from the stochastic/discrete tile selector used for tile IDs and placement.
- **Ordered ID-set validity**: all four bilinear footprint corners have exactly the same four IDs in exactly the same slots.

## Current Generation Pipeline

1. `advancedTerrainCompute outputType=2` writes the discrete tile map.
2. `advancedTerrainCompute outputType=7` writes smooth top-4 weights. Authored biomes use continuous scores, sharpened probabilities, and no stochastic per-cell selector in this path.
3. `advancedTerrainCompute outputType=8` writes representative tile IDs matching the type-7 smooth weights.
4. `splatCompute` kernel-accumulates smooth-source category weights into `splatDataMap` and writes representative tile IDs to `splatIndexMap`.
5. `splatValidityCompute` still writes `splatValidMap`, but production fragment reconstruction no longer trusts it for branch selection.

Current runtime config has `chunkPaletteEnabled: false`, so the chunk-palette path is disabled by writing an impossible palette coverage threshold. The active splat output path is the non-palette top-category path.

## Current Fragment Reconstruction

Production `sampleSplatData()`:

- Computes the 2x2 bilinear footprint from `uv * splatTexSize - 0.5`.
- Loads IDs for `c00`, `c10`, `c01`, and `c11`.
- Sets `bilinearValid` from a runtime ordered ID-set comparison across all four corners.
- Uses fast reconstruction only when `bilinearValid == true`.
- Uses manual four-corner union accumulation when `bilinearValid == false`.

Fast reconstruction uses `c00` IDs plus hardware-filtered weight channels. Fallback reconstruction accumulates all four corners by tile ID, keeps top 4 by accumulated weight, normalizes, then sorts by tile ID.

`sampleMicroTextureWithSplat()` then samples actual tile atlas colors from the reconstructed splat payload. With the current config, top-2 fast material sampling is disabled and the pure-dominant shortcut only applies at weight `>= 1.0`.

## Static Facts

- Slot 0 is not the dominant slot. Splat output is sorted by tile ID before storage, while dominance is selected later by highest weight.
- In the current implementation, production fast reconstruction cannot run on an ordered-ID mismatch footprint. If any of the four corner ID vectors differ, production uses fallback union.
- If all four ordered ID vectors match, fast reconstruction and union reconstruction should be equivalent apart from tiny sampler/rounding differences, because both combine the same channel-aligned weights.
- Therefore, a forced-fast artifact in mode 63 is not by itself evidence that production mode 0/37 is using the same bad branch. Forced-fast deliberately ignores the runtime validity condition.
- Any claim that production currently reads only `c00` IDs while neighboring corners contain different IDs is outdated unless a diagnostic shows `bilinearValid == true` for a mismatched footprint, which would contradict the current code.
- Resident streamed tile arrays expose stored outputs such as `tile`, `height`, `climate`, `splatData`, `splatIndex`, and `splatValid`. The `advancedTerrainCompute` outputType `7/8` smooth splat source is used by the splat pass, but is not currently exposed as a resident tile-array readback target.

## Observed Problem

Current screenshots show:

- Mode `0`: visible dark/grass-only stair-step rims inside visually blended biome transition zones.
- Mode `37`: live non-resolved splat albedo still shows the rim.
- Mode `63`: forced-fast full material shows a bright stair-step rim on the same boundary.
- Mode `67`: a recent wide screenshot shows both the faint red-arrow rim and the more prominent rim visible in the same camera view. This screenshot is useful for alignment, but mode `67` must still be interpreted with readback because it is a production-vs-union material delta attribution mode with grid overlay.
- With `terrainAO.enabled = false`, the right-side stair-step rim can still be visible, but it is much subtler and may disappear below naked-eye visibility on some boundary segments.
- With `terrainAO.enabled = true`, the same right-side boundary becomes much stronger and more continuous.

Confirmed from those screenshots only: forced-fast can produce the opposite visual polarity from normal/live rendering. The screenshots do not prove which exact corner IDs or weights caused either rim.

## Confirmed Anchored Readback

Screen-anchored `QT-SPLAT-PICK` captures were taken on and around a visible rim inside the blended biome transition zone.

All captured points listed below were on rendered tile `f1:d11:1024,1028`, source layer `1417`, with `sourceLayerMatchesRendered == true`.

Confirmed for those captures:

- `productionUnionDelta == 0` for every listed point.
- No listed point showed production reconstruction differing from the always-union reference.
- Some footprints had `runtimeOrderedValid == false`; production used fallback union there.
- Some footprints had `runtimeOrderedValid == true`; fast reconstruction was safe there because ordered IDs were aligned.
- The visible rim is therefore not caused by production using unsafe c00-ID fast reconstruction at these sampled points.
- The sampled transition payloads are not simple two-channel sand/grass payloads. They are dominated by `GRASS` tile `10` or `FOREST` tile `66`, with `DESERT` tile `150` as a minority channel. `ROCK` tile `42` appears as a zero or near-zero support/ghost channel in some stored footprints.

Representative production/union payloads from the clicked area:

```text
Rim/near-rim, fallback union:
10 GRASS   0.4768
66 FOREST  0.4486
150 DESERT 0.0746
productionUnionDelta = 0

Near-rim, ordered-valid fast path:
10 GRASS   0.4812
42 ROCK    0.0000
66 FOREST  0.4557
150 DESERT 0.0630
productionUnionDelta = 0

Inside adjacent side:
10 GRASS   0.4177
66 FOREST  0.4823
150 DESERT 0.1000
productionUnionDelta = 0

Another rim/near-rim fallback:
10 GRASS   0.4369
66 FOREST  0.4958
150 DESERT 0.0673
productionUnionDelta = 0
forced-fast would incorrectly make GRASS dominant here.
```

Confirmed interpretation for this sampled rim: fragment reconstruction is working as implemented, and the visible stair-step is already present in the stored/union splat payload. The remaining investigation target is upstream of fragment reconstruction: why the stored/smooth splat payload inside this biome transition zone crosses between `GRASS` and `FOREST` dominance in a stair-stepped shape, with `DESERT` as a minority channel.

## Confirmed Generation-Window Readback

Two `QT-SPLAT-GEN` captures were taken from screen-visible rim locations with resident source-layer readback available for `splatData`, `splatIndex`, `splatValid`, `tile`, `height`, and `climate`.

Spot 1:

- Rendered/source tile: `f1:d10:512,512`, source layer `1463`, `sourceLayerMatchesRendered == true`.
- Clicked footprint: base `115,90`, `f=(0.866672, 0.046487)`.
- Footprint verdict: `fast_path_safe_for_this_footprint`.
- `runtimeOrderedValid == true`, `precomputedValid == true`, `productionUnionDelta == 0`, `fastUnionDelta == 0`.
- Footprint production payload: `GRASS 10 = 0.5151`, `FOREST 66 = 0.4849`.
- The 13x13 stored splat window contains only two stored IDs with nonzero weight: `GRASS 10` and `FOREST 66`.
- Stored dominance histogram: `GRASS 10 = 110`, `FOREST 66 = 59`.
- Stored weight stats: `GRASS 10 mean=0.5444 min=0.3725 max=0.7333`; `FOREST 66 mean=0.4556 min=0.2667 max=0.6275`.
- The stored dominance grid crosses back and forth around the 50/50 threshold in a jagged pattern inside the 13x13 readback window.
- The discrete tile grid in the same window contains both grass variants (`14`, `15`, `16`) and forest variants (`66`, `67`, `68`). Stored splat IDs are canonical representative IDs (`10`, `66`), not the raw variant IDs.
- Climate values in the shown center row/column are effectively constant at `temperature ~= 0.8745`, `precipitation ~= 0.6275`, `vegetation = 1`.

Spot 2:

- Rendered/source tile: `f1:d10:519,495`, source layer `1123`, `sourceLayerMatchesRendered == true`.
- Clicked footprint: base `26,83`, `f=(0.870372, 0.490421)`.
- Footprint verdict: `fast_path_safe_for_this_footprint`.
- `runtimeOrderedValid == true`, `precomputedValid == true`, `productionUnionDelta == 0`, `fastUnionDelta == 0`.
- Footprint production payload: `GRASS 10 = 0.8537`, `FOREST 66 = 0.1385`, `DESERT 150 = 0.0078`.
- Stored dominance histogram: `GRASS 10 = 169`; no non-grass dominant splat texel appears in the 13x13 window.
- Stored weight stats: `GRASS 10 mean=0.8571 min=0.7725 max=0.8902`; `FOREST 66 mean=0.1344 min=0.0941 max=0.2235`; `DESERT 150 mean=0.0085 min=0 max=0.0196`.
- The discrete tile grid in this window contains only grass variants (`11`, `12`, `15`, `16`).

Confirmed interpretation of these two windows:

- Spot 1 is a screen-visible rim that is also a stored GRASS/FOREST dominance-threshold region. Its jagged visible behavior is already present in stored splat weights before fragment reconstruction.
- Spot 2 is also a screen-visible rim, but it is not a stored dominant-category flip at the clicked footprint. The local 13x13 window is all `GRASS 10` dominant, with small `FOREST 66` and `DESERT 150` minority weights.
- Therefore, the visible rims are not all the same mechanism. Spot 1 can be explained at the stored dominant-category level; Spot 2 cannot.
- These captures keep fragment reconstruction cleared for the sampled spots. The unresolved target is the generation path that creates the stored splat weights, especially the path from `advancedTerrainCompute` smooth splat outputType `7/8` into `splatCompute`.

## Confirmed Multi-Rim Readback Round

`results.txt` contains five additional screen-visible rim captures, labeled `Rim 1` through `Rim 5`.

Common facts across all five captures:

- `sourceLayerMatchesRendered == true`.
- The source tile/layer was exact for every capture.
- `runtimeOrderedValid == true` and `precomputedValid == true` for every clicked footprint.
- Every clicked footprint had verdict `fast_path_safe_for_this_footprint`.
- Production reconstruction matched the always-union reference. `productionUnionDelta == 0` for Rims 2-5 and `0.000084` for Rim 1, which is tiny channel/sampler rounding.
- Therefore, none of these five sampled visible rims is caused by unsafe production fast reconstruction.

Per-rim facts:

- Rim 1: `f1:d10:511,514`, layer `1545`, base `33,47`. Footprint production payload was `GRASS 10 = 0.5036`, `FOREST 66 = 0.4886`, `DESERT 150 = 0.0078`. The 13x13 stored dominance histogram was mixed: `FOREST 66 = 87`, `GRASS 10 = 82`. This is a stored GRASS/FOREST threshold rim.
- Rim 2: `f1:d10:511,514`, layer `1545`, base `64,51`. Footprint production payload was `FOREST 66 = 0.5501`, `GRASS 10 = 0.3794`, `DESERT 150 = 0.0706`. The 13x13 stored dominance histogram was uniform: `FOREST 66 = 169`. This is a screen-visible rim without a local stored dominant-category flip.
- Rim 3: `f1:d10:514,504`, layer `1130`, base `12,48`. Footprint production payload was `GRASS 10 = 0.6980`, `FOREST 66 = 0.3020`. The 13x13 stored dominance histogram was uniform: `GRASS 10 = 169`. This is a screen-visible rim without a local stored dominant-category flip.
- Rim 4: `f1:d10:521,505`, layer `1243`, base `29,61`. Footprint production payload was `GRASS 10 = 0.7381`, `FOREST 66 = 0.1955`, `ROCK 42 = 0.0663`. The 13x13 stored dominance histogram was uniform: `GRASS 10 = 169`. This is a screen-visible rim without a local stored dominant-category flip.
- Rim 5: `f1:d11:1036,1005`, layer `1154`, base `31,59`. Footprint production payload was `GRASS 10 = 0.6865`, `FOREST 66 = 0.3135`. The 13x13 stored dominance histogram was uniform: `GRASS 10 = 169`. This is a screen-visible rim without a local stored dominant-category flip.

Confirmed interpretation of this round:

- The visible rim family has at least two confirmed classes.
- Class A: stored dominant-category threshold rims. Rim 1 and the earlier Spot 1 are in this class.
- Class B: uniform-dominance visible rims. Rims 2-5 and the earlier Spot 2 are in this class.
- Class B cannot be explained by the nearest stored dominant category changing inside the sampled 13x13 window. Its cause remains unresolved and must be somewhere else in the rendered material result: stored sub-dominant weights, category material luma, raw tile/variant usage, tile boundary rendering, or another render/input path. This is a bounded unresolved list, not a confirmed cause.

## Current Two-Rim Readback Round

Two close-range `QT-SPLAT-GEN` captures were saved after the click picker had been changed to terrain raycast. Both clicks were intentionally placed on visible screen rims: `results.txt` on the faint red-arrow rim, and `results2.txt` on the more prominent rim.

Common facts:

- Both captures used `pickMethod = terrain-raycast`, not the legacy sphere-refine fallback.
- `sourceLayerMatchesRendered == true` and `terrainRaycastLayerMatchesRendered == true` for both captures.
- Raycast lookup local UV and rendered-instance local UV agree to far less than one splat texel:
  - `results.txt`: delta ~= `(0.0012, -0.0061)` splat texels.
  - `results2.txt`: delta ~= `(-0.0037, -0.0022)` splat texels.
- These deltas are too small to explain missing a rim that is visually large on screen. Treat the captures as valid samples of the clicked rims unless a later screen-space diagnostic contradicts this.
- Both clicked footprints had `runtimeOrderedValid == false` and `precomputedValid == false`; production therefore used the fallback/union path.
- `productionUnionDelta == 0` in both captures. The clicked rims are not caused by production using unsafe c00-ID fast reconstruction.
- Both 17x17 readback windows had uniform stored dominant category `GRASS 10 = 289/289`. Neither clicked rim is a local stored dominant-category flip.
- `terrainAO` and `groundField` readback were unavailable in both captures (`texture_unavailable`), so these captures cannot classify AO as source vs amplifier.

Faint red-arrow rim, `results.txt`:

- Rendered/source tile: `f1:d11:1024,1024`, layer `1480`.
- Clicked footprint: base `46,84`, `f=(0.757919, 0.546831)`.
- Footprint verdict: `production_matches_union`.
- Footprint production/union payload: `GRASS 10 = 0.6104`, `ROCK 42 = 0.0257`, `FOREST 66 = 0.3639`.
- Forced-fast was effectively the same material mix for this footprint (`fastUnionDelta == 0`), so mode `63` does not create a strong false sand artifact here.
- Stored 17x17 weight stats: `GRASS 10 mean=0.6101 min=0.4941 max=0.7137`; `FOREST 66 mean=0.3641 min=0.2431 max=0.4863`; `ROCK 42 mean=0.0245 min=0.0039 max=0.0431`; `DESERT 150 mean=0.0021 min=0 max=0.0039`.
- Raw tile grid is mostly `GRASS 11`, with scattered `FOREST 67`, `GRASS 19`, and `GRASS 12`.
- Interpretation: this is a confirmed Class B rim. The visible faint rim is not a dominant splat flip and not a production reconstruction mismatch. Remaining suspects are sub-dominant weights, raw tile/variant material usage, resolved material luma, lighting/AO amplification, or another render-side input.

More prominent rim, `results2.txt`:

- Rendered/source tile: `f1:d11:1023,1025`, layer `1489`.
- Clicked footprint: base `67,9`, `f=(0.341008, 0.950642)`.
- Footprint verdict: `forced_fast_only_differs_from_union`.
- Production/union payload: `GRASS 10 = 0.7452`, `FOREST 66 = 0.2010`, `DESERT 150 = 0.0538`.
- Forced-fast payload: `GRASS 10 = 0.7452`, `FOREST 66 = 0.1349`, `DESERT 150 = 0.1033`, `EMPTY 255 = 0.0165`; `fastUnionDelta = 0.057843`.
- The ordered-ID mismatch causing the forced-fast error is:

```text
c00/c10/c01: 10,66,150,255
c11:         10,42,66,150
```

- Mode `63` deliberately renders this bad fast-path assumption. The visible sand-colored pattern on the prominent rim in mode `63` is therefore explained: channel-aligned filtered weights are interpreted with the wrong ID slots, shifting some forest weight into desert.
- Production is still cleared for this sampled point because production matches union exactly and uses fallback on the mismatched footprint.
- Stored 17x17 weight stats: `GRASS 10 mean=0.7474 min=0.7176 max=0.7686`; `FOREST 66 mean=0.1929 min=0.1333 max=0.2510`; `DESERT 150 mean=0.0580 min=0.0078 max=0.1059`; `ROCK 42 mean=0.0035 min=0 max=0.0196`.
- Raw tile grid contains only grass variants: `GRASS 19 = 263`, `GRASS 18 = 26`.
- Resolved-color luma range is stronger than in the faint-rim capture: `0.0389..0.0902` versus `0.0303..0.0544` in `results.txt`.
- Interpretation: this prominent rim is also a confirmed Class B rim for production, but it differs from the faint rim by having a persistent stored `DESERT 150` minority channel and a strong forced-fast-only mode `63` artifact. Mode `63` explains the weird sand pattern in debug, but not the normal production rim by itself.

Updated working split:

- Class A: stored dominant-category threshold rims. These are real stored splat payload contours where dominance crosses around 50/50.
- Class B1: uniform-dominance faint rims with little/no desert and no meaningful forced-fast error. `results.txt` is the current confirmed example.
- Class B2: uniform-dominance prominent rims with a stored desert minority channel and forced-fast-only mode `63` sand artifact. `results2.txt` is the current confirmed example.
- The latest visual mode pass narrows the faint Class B1 rim further than these readbacks alone. It is not nearest stored dominant category, not resolved color, not production shortcuts, not union minority luma, and not forced-fast debug behavior. The current target is production live splat reconstruction in `sampleSplatData()`, most likely ordered-valid fast-path behavior visible on neighboring/subpixel footprints that were not the exact clicked fallback footprint.

## Latest Visual Mode Pass

Close-ground screenshots from the same area added a stronger split for the faint red-arrow rim:

- Modes `36` and `40` do not show the faint rim. The resolved-color path is not the current source for this close-ground seam.
- Mode `43` shows the faint rim. This is base micro color before macro, lighting, AO, fog, and post-processing.
- Modes `45` and `61` look like mode `43`. Mode `45` is final albedo before lighting; mode `61` is production full material with pure-dominant and top-2 shortcuts disabled.
- Modes `62`, `64`, `68`, and `69` do not visibly show the faint rim:
  - `62`: always-union full material.
  - `64`: nearest stored splat full material.
  - `68`: union minority material luma effect.
  - `69`: union full material vs raw center tile material.
- Mode `65` shows a grid and flat blue color, with no rims. The production shortcut path is not the cause.
- Mode `55` shows broad high heat, described as bright red everywhere with dark blue contours on both rims. This means production-vs-union weight delta is active in the area, but the visual polarity is not a simple "hot rim" signal.
- A second note also described a purple-gradient view with dark blue contours on both rims. This is assumed to be mode `56` unless later corrected; if so, production-vs-union material delta is also spatially aligned with both rims.
- Mode `57` is bright red but does not show the faint rim. It only shows a non-rim-like border at the more prominent rim. Forced-fast-vs-union mismatch is therefore not the faint-rim source.
- Mode `70` shows weird cyan grains in the faint-rim pattern only when the camera is nearly touching the ground. These grains disappear at greater distance. Streamed grass assets in the screenshot give the scale: this is a very near-surface, sub-footprint/texture-scale effect.

Interpretation of this pass:

- The faint rim is already in the pre-lighting albedo path, because `43` and `45` show it.
- The force-union comparison closes the main branch: `84` removes the faint rim compared with prior `43`, and `85` looks like `84` compared with prior `45`.
- Because `61` shows it, the pure-dominant/top-2 shortcut path is not the sole cause.
- Because `36` and `40` do not show it, the close-ground resolved-color path is not the source.
- Because `62`, `64`, `68`, and `69` do not show it, the current visible faint rim is not explained by always-union stored splat material, nearest stored material, union minority luma, or union-vs-raw-tile material delta.
- Because `65` does not show it, the production material shortcuts are not the source.
- Because `57` does not show the faint rim, the unsafe forced-fast assumption is not the source of the faint rim. It remains relevant for mode-`63` and mode-`70` artifacts.
- Because `80` looked like normal `0`, `81` was flat blue, and `82` only showed a barely visible trace, LOD-edge AO fade, aerial/fog, and lighting are at most secondary amplifiers for this faint rim.
- The mode `70` cyan grains mean "production matches union, but forced-fast differs" at those pixels. That can explain close-ground forced-fast-only speckle, but it does not blame production unless modes `55`, `56`, or `67` also light the same pattern.
- Mode `86` shows a purple-gradient background with dark blue contours on both rim sites. In that mode, blue denotes current-vs-union micro delta on pixels classified as production fallback/invalid rather than the red fast-branch classification.
- This creates a tension with the earlier readback: clicked points had `productionUnionDelta == 0`, yet mode `84` removes the faint rim and mode `86` shows rim-aligned blue contours. The raycast accuracy is now good enough that this should not be treated as a sphere-pick failure. The likely explanation is that the single clicked fallback footprint did not cover the exact screen pixels/derivative state that forms the visible contour, or the CPU readback is not mirroring the shader material path exactly.
- The current pinpointed target is production live splat reconstruction and material sampling parity, specifically `sampleSplatData()` as consumed by `sampleMicroTextureWithSplat()`. Given the blue mode-`86` result, prioritize fallback/union equivalence at actual visible pixels before assuming an ordered-valid fast-branch-only bug.

## Branch Isolation Round — Modes 87/88/89 (decisive)

Three new diagnostic modes were added to isolate which reconstruction branch produces the faint rim.

New modes (routing range extended to `25..89`):

- `87`: union reconstruction for fallback pixels only (`bilinearValid == false`); fast-path pixels keep production output. Compare to mode `43`.
- `88`: union reconstruction for fast-path pixels only (`bilinearValid == true`); fallback pixels keep production output. Compare to mode `43`.
- `89`: binary branch map. Green = fast path (`bilinearValid == true`, hardware-filtered weights). Red = fallback path (`bilinearValid == false`, manual 4-corner accumulation). No terrain color; compare shape against mode `43`/`37`.

Implementation note: `sampleMicroTextureWithSplat` uses derivative-based texture sampling, so it cannot be called inside non-uniform control flow conditioned on `bilinearValid`. Modes `87`/`88` therefore compute `sampleSplatDataUnionReference` and `sampleMicroTextureWithSplat` unconditionally for all pixels, then use a `select()` data operation to choose between production and union output. This avoids non-uniform branching at the cost of running both paths per fragment in those debug modes.

Actual results:

- Mode `89`: both rim sites are fully **red** — both the faint and the more prominent rim are located in the `bilinearValid == false` (fallback/manual-accumulation) region.
- Mode `87` (union for fallback): looks essentially identical to mode `0`, slightly darker overall. The faint rim **persists**. Replacing fallback pixels with union does not remove the seam. This is expected because production fallback and union use byte-for-byte identical accumulation code.
- Mode `88` (union for fast): the faint rim is **completely absent**. A staircase transition appears at the old site of the more prominent rim, but it reads as the stored dominant-category Class A seam, not the faint rim. The faint rim (Class B) is entirely gone.

Confirmed conclusion:

The faint rim is a **method-switch seam** at the boundary of the `bilinearValid == false` region. The seam is not inside the fallback pixels themselves. It is the visual contrast between:

- **Fast-path pixels** (bilinearValid true, adjacent to the boundary): use `sampleSplatWeightsFiltered` — a single `textureSampleLevel` with hardware bilinear filtering.
- **Fallback pixels** (bilinearValid false, at the boundary): use explicit 4-corner `textureLoad` calls accumulated through ID-keyed buckets (`accumulateLoadedCornerMixture` → `buildAccumulatedTop4` → `sortTop4ByTileId`).

These two paths have a structurally different relationship to the stored weight data. When stored texel weights do not sum to exactly 1.0, hardware bilinear averages non-unit sums and then the normalization step divides by a different denominator than the manual accumulation path. The seam is wherever the method switches. Mode `88` removes it by making all pixels use manual accumulation, eliminating the method switch.

The slight global darkening in mode `87` confirms manual accumulation is systematically slightly darker than hardware bilinear filtering across the whole terrain, not just at the boundary. The boundary is where this per-pixel systematic difference becomes a visible seam.

The direct weight precision difference (hardware bilinear 8-bit blend factors) alone is too small (~0.002 per channel) to explain a visible seam. The more likely mechanism is the non-unit stored weight normalization divergence described above, but the exact magnitude is not yet measured.

**Performance note**: `sampleSplatWeightsFiltered` is one `textureSampleLevel`. The fallback uses 4 × `textureLoad`. The fast path was a deliberate optimization saving 3 memory operations per fragment for the majority (valid zone) of terrain. The FPS gain from this optimization has not been re-measured. Do not remove or replace the fast path without a before/after FPS comparison. The fix options are:

1. Replace `sampleSplatWeightsFiltered` with explicit 4-corner loads + manual bilinear in the fast path (same math as fallback). Correct and simple, but regresses the 3-read saving for all valid terrain fragments.
2. Keep the fast path but blend the result toward the manual accumulation within N texels of the bilinear-valid boundary (transition zone smoothing). More complex, preserves the fast-path savings for interior pixels.
3. Address at generation: ensure `splatCompute` stores exactly unit-sum weights per texel, so hardware bilinear and manual bilinear produce the same normalized result. If the stored sums are already ~1.0 everywhere, this is ruled out and the mechanism must be something else.

Option 3 is zero shader cost if it applies. Check `splatCompute` output weight sums before implementing option 1 or 2.

Readback gap to resolve:

- `QT-SPLAT-GEN` currently reports `terrainAO` and `groundField` as `texture_unavailable` in both latest captures. To classify AO from click data instead of screenshots, the next readback must be taken when those textures are registered and copy-readable. Until then, AO conclusions must come from modes `75`-`80` screenshots.

## Revised Albedo/AO Split

The earlier "AO-only Rim 1" interpretation is superseded. A newer comparison shows that the right-side stair-step rim can still be visible with `terrainAO.enabled = false`, but it is much weaker and can drop below naked-eye visibility in some places. Enabling terrain AO makes the same boundary stronger and more continuous.

Current implication:

- The right-side rim has a non-AO base component.
- AO is an amplifier, not the sole origin of the whole rim.
- Earlier AO-off observations likely sampled a segment where the base seam was absent or too subtle to see.
- A click/readback must classify the exact visible segment being discussed; different points on the same long boundary can have different apparent strength.

The working model is now two-layered:

- **Base seam**: a subtle stair-step in albedo/material inputs or other pre-AO rendering, visible in some AO-off views.
- **AO amplification**: terrain AO adds contrast on top of that same boundary, or adds a coincident AO boundary that makes the base seam obvious.

Post-albedo and lighting diagnostic modes:

- `43`: base micro color before macro.
- `44`: base color after macro.
- `45`: final albedo before lighting.
- `71`: full lit color before aerial perspective/fog.
- `72`: detail-normal lighting delta heat, comparing `NdotL` from the active detail normal against the sphere normal.
- `73`: lit color with normal lighting but without shadow or AO.
- `74`: shadow factor heat.
- `75`: AO factor heat.
- `81`: aerial perspective/fog delta heat.
- `82`: total lighting delta heat from final pre-fog color versus albedo.

Decision tree for the base seam with `terrainAO.enabled = false`:

- If the rim appears in `43` or `45`, it is already in the albedo/material path. Continue with `36`, `37`, `38`, `40`, `42`, `49`, `50`, `61`, `62`, `68`, `69`, and `70`.
- If `43` and `45` are clean but `71` or `82` shows the rim, continue on non-AO lighting: detail normals, shadow factor, or light-response differences.
- If only `81` or mode `0` shows it, continue on aerial perspective/fog or post-processing.
- If the rim is visible in `43`/`45` but very faint, treat AO-on comparisons as amplification evidence rather than origin evidence.

## Revised AO Amplification Result

`terrainAO.enabled = false` no longer proves the right-side rim is gone globally. It only proves AO is not required for every visible segment. The updated conclusion is:

- AO strongly increases the visual strength of the right-side stair-step boundary.
- The raw source of that amplification is still unresolved: it may be the baked `terrainAOMask`, fragment-side AO neutral/fade logic, or AO multiplication increasing contrast on an already-present albedo seam.
- Fixing only AO may reduce the strong dark rim, but it may leave a subtler non-AO material seam.
- Fixing only the base albedo/material seam may also reduce the AO-visible rim if AO is simply amplifying the same contour.

AO sub-split diagnostic modes:

- `76`: raw AO mask attenuation heat before neutral/fade.
- `77`: AO attenuation heat after neutral/fade, before ambient/direct strength scaling.
- `78`: combined AO neutral fade.
- `79`: splat-transition AO neutral fade only.
- `80`: LOD-edge AO neutral fade only.

Decision tree with `terrainAO.enabled = true`:

- If mode `76` mirrors the rim, the raw baked `terrainAOMask` contains a matching boundary. The next target is `TerrainAOBaker` / `terrainAOBake.wgsl.js`.
- If `76` is clean but `77` or `75` shows the rim, the rim is introduced by shader-side AO neutral/fade or AO application.
- If `79` lights the rim, the target is the AO transition fade that uses `hasLiveSplat`, `splatResult.hasBoundary`, and `splatDominantWeight(splatResult)`.
- If `80` lights the rim, the target is LOD-edge AO fade.
- If `76` and `77` both show the same shape, raw AO is the likely amplifier and neutral fade is only scaling or preserving it.
- If `76`/`77` do not show a matching shape but mode `0` gets darker along the base seam, AO multiplication is likely increasing contrast on an existing albedo/material boundary.

Use the same camera and same click in both AO states:

```js
window.qtDiag.pickSplatGenerationOnClick({ radius: 8 });
```

Compare:

- AO off: `43`, `45`, `61`, `62`, `68`, `69`, `70`, `71`, `81`, `82`.
- AO on: `43`, `45`, `75`, `76`, `77`, `78`, `79`, `80`, `71`.

`QT-SPLAT-GEN` now reads resident `terrainAO`, `groundField`, and `resolvedColor` when present, in addition to stored splat, tile, height, and climate textures. Terrain AO and ground-field textures are externally registered array textures, so the diagnostic readback supports those external arrays and maps 128x128 splat texel coordinates into lower-resolution auxiliary textures such as 64x64 AO.

This lets the same click compare:

- stored splat dominance and weights,
- discrete tile IDs,
- raw terrain AO and AO attenuation,
- ground-field max mask,
- resolved-color luminance.

The key evidence is alignment: determine whether `terrainAOGrid` / `terrainAOAttenuationGrid` follows the already-visible AO-off seam, or whether AO adds a separate coincident darkening layer.

## Existing Diagnostic Modes

- `37`: live non-resolved splat material path.
- `40`: resolved-color mip0 path.
- `43`: base micro color before macro/lighting/AO/fog.
- `45`: final albedo before lighting.
- `46`: path diagnostic for raw tile, resolved-color, and live-splat branches.
- `47`: production splat payload rendered as category debug colors.
- `49`: nearest stored splat texel as category debug colors, no bilinear reconstruction.
- `52`: always-union category reconstruction.
- `55`: production-vs-union ID-aware weight delta.
- `56`: production-vs-union full material delta.
- `59`: ordered vs unordered corner ID-set mismatch.
- `60`: production/forced-fast dominant-category difference from union.
- `61`: production full material with pure-dominant/top-2 shortcuts disabled.
- `62`: always-union full material.
- `63`: forced-fast full material.
- `64`: nearest stored splat full material.
- `65`: production shortcut material delta.
- `66`: precomputed validity texture vs runtime ordered validity.
- `67`: production-vs-union material delta attributed to the production branch flag.
- `68`: union minority material luma effect.
- `69`: union full material vs raw center tile material.
- `70`: reconstruction verdict, added for this investigation.
- `71`: full lit color before aerial perspective/fog.
- `72`: detail-normal lighting delta heat.
- `73`: lit color with shadow and AO disabled.
- `74`: shadow factor heat.
- `75`: AO factor heat.
- `76`: raw AO mask heat.
- `77`: post-fade AO heat.
- `78`: AO neutral fade.
- `79`: splat-transition AO fade.
- `80`: LOD-edge AO fade.
- `81`: aerial/fog delta heat.
- `82`: lighting delta heat.
- `84`: force-union base micro color, comparable to mode `43`.
- `85`: force-union pre-lighting albedo, comparable to mode `45`.
- `86`: exact current normal micro sample versus force-union micro sample, with red for fast-branch delta and blue for fallback-branch delta.
- `87`: branch isolation — union for fallback pixels, production for fast pixels. Rim persists (confirmed). Fallback and union are code-identical, no difference.
- `88`: branch isolation — union for fast pixels, production for fallback pixels. Faint rim absent (confirmed). Fast-path hardware bilinear is the seam source.
- `89`: binary branch map. Green = bilinearValid true (fast path). Red = bilinearValid false (fallback). Both rim sites are red (confirmed).
- Routing: `GameEngine._resolveTerrainDebugModes()` maps modes `25..89` to `generatorMode=0, fragmentMode=mode`. Modes `83` (unused) and above are fragment-only and do not trigger tile regeneration.

## New Diagnostic: Mode 70

Mode `70` compares production, always-union, and forced-fast full material reconstruction in one categorical view.

Color key:

- Black/dim: production and union agree.
- Red: production fast path differs from union, dominant category same.
- Yellow: production fast path differs from union, dominant category differs.
- Blue: production fallback differs from union, dominant category same.
- Magenta: production fallback differs from union, dominant category differs.
- Cyan: production matches union, but forced-fast differs. This explains mode-63-only artifacts without blaming production.
- Green: production matches union, but forced-fast dominant category differs.

Interpretation:

- If the visible mode-37 rim is black/dim or cyan/green in mode 70, the current production rim is not caused by the reconstruction branch. Look at stored payload shape, material luma, and nearest/union modes (`62`, `64`, `68`, `69`).
- If the rim is red/yellow, production fast reconstruction is involved. That points to the fast branch in `sampleSplatData()`.
- If the rim is blue/magenta, production fallback is not equivalent to the union reference. That points to a fallback/reference mismatch.

## Exact Readback Diagnostic

Use broad console helpers when a visual mode identifies an interesting tile/footprint:

```js
await window.qtDiag.findSplatFootprints(face, depth, x, y, { limit: 24 });
await window.qtDiag.splatFootprint(face, depth, x, y, {
  base: { x: splatX, y: splatY },
  f: { x: 0.5, y: 0.5 }
});
```

Filter browser console output with `QT-SPLAT`. The helpers log a collapsed group plus a `raw` object using that tag.

`splatFootprint()` reads exact `splatData`, `splatIndex`, and `splatValid` texels for `c00/c10/c01/c11`, then computes the same fast, union, and production payloads on the CPU. It reports:

- corner coordinates
- decoded IDs per corner
- stored weights per corner
- precomputed validity at `c00`
- runtime ordered validity
- production-vs-union ID-aware weight delta
- forced-fast-vs-union ID-aware weight delta
- dominant IDs/categories for production, union, and forced-fast
- verdict string

This is the diagnostic that can close the mechanism question. A screenshot can locate the area; the readback gives the actual four-corner payload.

## Screen-Anchored Pick Diagnostic

Use the picker when the important evidence is a visible pixel/area on screen rather than an already-known splat texel:

```js
window.qtDiag.pickSplatOnClick();
```

Then click the visible rim. The log tag is `QT-SPLAT-PICK`.

Other forms:

```js
await window.qtDiag.pickSplatAtCenter();
await window.qtDiag.pickSplatAtScreen(clientX, clientY);
```

`pickSplatAtScreen()` interprets coordinates as browser `clientX/clientY` by default. Pass `{ canvas: true }` only when the coordinates are framebuffer/canvas pixels.

The picker:

- casts a ray through the screen point,
- refines the hit radius from the visible tile height texture,
- rejects far-side sphere intersections during refinement and keeps the near visible hit,
- maps the hit to face UV,
- selects the visible rendered quadtree instance under that face UV,
- computes the local UV, source-layer UV, and shader-equivalent splat coordinate,
- reads the exact four splat footprint corners with `splatFootprint()`,
- logs one collapsed `[QT-SPLAT-PICK]` group containing the screen point, tile/layer, `base/f`, corner rows, payload summaries, and verdict.

This is the preferred diagnostic for screenshots with arrows or visible rims because the result is anchored to the clicked screen position instead of a tile-wide scan ranking.

## Next Readback Diagnostic: Generation Window

Use this after `QT-SPLAT-PICK` shows `productionUnionDelta == 0` on a visible rim. It keeps the same screen-anchored pick path, then reads a neighborhood around the exact splat coordinate from the resident tile-array textures.

```js
window.qtDiag.pickSplatGenerationOnClick({ radius: 6 });
```

Then click the rim. Filter the console with `QT-SPLAT-GEN`.

Other forms:

```js
await window.qtDiag.pickSplatGenerationAtCenter({ radius: 6 });
await window.qtDiag.pickSplatGenerationAtScreen(clientX, clientY, { radius: 6 });
await window.qtDiag.splatGenerationWindow(face, depth, x, y, {
  base: { x: splatX, y: splatY },
  f: { x: 0.5, y: 0.5 },
  radius: 6
});
```

`QT-SPLAT-GEN` logs:

- the same exact four-corner footprint and reconstruction verdict as `QT-SPLAT-PICK`,
- full-layer readback availability for `splatData`, `splatIndex`, `splatValid`, `tile`, `height`, `climate`, `terrainAO`, `groundField`, and `resolvedColor`,
- a stored splat dominant-category grid around the clicked base texel,
- a discrete tile-category grid for the same texel window,
- raw terrain AO and AO attenuation grids when terrain AO is enabled and resident,
- ground-field max and resolved-color luminance grids when those textures are resident,
- per-ID stored weight stats across the window,
- weight grids for the clicked footprint IDs, usually the relevant `GRASS`, `FOREST`, `DESERT`, and support/ghost IDs,
- center row, center column, and 2x2 footprint tables.

What this can prove:

- If the visible stair-step aligns with the stored splat dominant/weight grid, the artifact is already present in stored splat output before fragment reconstruction.
- If the stored splat grid is smooth but mode 0/62 still has a stair-step, the next target is material/luma sampling after reconstruction.
- If the stored splat grid jumps while the discrete tile/climate grids do not, the next target is the splat generation path between smooth source and stored splat output.
- If the stored splat grid follows discrete tile/climate steps, the next target is the upstream biome/climate/tile source that feeds smooth splat generation.
- If the AO attenuation grid follows the visible boundary while AO-off albedo already has a faint seam, AO is amplifying an existing material/albedo contour.
- If the AO attenuation grid has a boundary but AO-off albedo does not at that exact click, the raw AO bake may be the dominant visible source for that segment.

Limits:

- This diagnostic does not read transient outputType `7/8` smooth source texels directly. It reads resident stored outputs and resident auxiliary textures.
- AO and ground-field textures may have lower resolution than splat textures; the diagnostic maps the splat texel center into the auxiliary texture size before sampling.

## Code Reference Points

- `sampleSplatData()` runtime branch and fast/fallback reconstruction: `core/renderer/terrain/shaders/webgpu/terrainChunkFragmentShaderBuilder.js:1609`
- `sampleSplatDataUnionReference()` always-union reference: `core/renderer/terrain/shaders/webgpu/terrainChunkFragmentShaderBuilder.js:1726`
- `sampleSplatDataFastReference()` forced-fast reference used by mode 63: `core/renderer/terrain/shaders/webgpu/terrainChunkFragmentShaderBuilder.js:1831`
- `sampleMicroTextureWithSplat()` material sampling and pure-dominant shortcut: `core/renderer/terrain/shaders/webgpu/terrainChunkFragmentShaderBuilder.js:2437`
- Mode `70` implementation: `core/renderer/terrain/shaders/webgpu/terrainChunkFragmentShaderBuilder.js:3673`
- `advancedTerrainCompute` smooth splat representative IDs: `core/world/shaders/webgpu/advancedTerrainCompute.wgsl.js:556`
- `advancedTerrainCompute` smooth splat outputType `7/8`: `core/world/shaders/webgpu/advancedTerrainCompute.wgsl.js:1058`
- `splatCompute` smooth-source bindings: `core/world/shaders/webgpu/splatCompute.wgsl.js:62`
- `splatCompute` slot-support halo: `core/world/shaders/webgpu/splatCompute.wgsl.js:582`
- `splatCompute` chunk-palette gate: `core/world/shaders/webgpu/splatCompute.wgsl.js:697`
- `splatCompute` zero-weight slot expansion: `core/world/shaders/webgpu/splatCompute.wgsl.js:727`
- `splatCompute` tile-ID sorting: `core/world/shaders/webgpu/splatCompute.wgsl.js:775`
- `splatCompute` splat weight/index stores: `core/world/shaders/webgpu/splatCompute.wgsl.js:790`
- `splatValidityCompute` precomputed validity texture store: `core/world/shaders/webgpu/splatValidityCompute.wgsl.js:47`
- `qtDiag.splatFootprint()`: `wizard_game/standalone.html:1546`
- `qtDiag.findSplatFootprints()`: `wizard_game/standalone.html:1623`
- `qtDiag.pickSplatAtScreen()`: `wizard_game/standalone.html:1707`
- `qtDiag.pickSplatOnClick()`: `wizard_game/standalone.html:1782`
- `qtDiag.splatGenerationWindow()`: `wizard_game/standalone.html:2026`
- `qtDiag.pickSplatGenerationAtScreen()`: `wizard_game/standalone.html:2123`
- `qtDiag.pickSplatGenerationOnClick()`: `wizard_game/standalone.html:2195`
- Texture readback primitives used by the diagnostics: `core/world/quadtree/tileStreamer.js:2191` and `core/world/quadtree/tileStreamer.js:2242`
