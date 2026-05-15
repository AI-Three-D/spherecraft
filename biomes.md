# Biomes And Splatmaps

This document describes the current active terrain material path. It is written for debugging and tuning, so it separates biome scoring, splat generation, and fragment rendering.

## Current Mode

The active path is the performance-first fixed material family path:

```js
fixedMaterialFamiliesEnabled: true
```

This is set in `wizard_game/runtimeConfigs.js` under `splatConfig`.

In this mode the splat texture no longer stores arbitrary local top-4 material IDs. It stores four fixed material-family weights in RGBA:

| Channel | Family | Categories |
|---|---|---|
| R | `ORGANIC` | `GRASS`, `FOREST`, `SWAMP` |
| G | `MINERAL` | `ROCK`, `VOLCANIC` |
| B | `SOIL_ARID` | `SAND`, `DESERT`, `DIRT`, `MUD` |
| A | `COLD` | `SNOW`, `TUNDRA` |

The category-to-family mapping lives in `core/world/materialFamilies.js`.

The important consequence: every texel has the same four channels in the same order. Hardware bilinear filtering is always valid for the weights. The old sparse-ID seam class came from neighboring texels disagreeing about which material ID lived in each channel; fixed families remove that whole failure mode.

## Biome Scoring

Biome scoring runs in `advancedTerrainCompute.wgsl.js` through `scoreBiomeEnv()` from `biomeScoring.wgsl.js`.

For every terrain point:

1. The terrain generator computes climate and terrain signals:
   - elevation
   - humidity
   - temperature
   - slope
2. Each biome scores those signals using the rules in `wizard_game/world/biomes.json`.
3. The score is multiplied by the biome `baseWeight`.
4. Regional variation noise modulates the score.
5. Scores are normalized into biome probabilities.

Simplified:

```text
signal rules -> biome suitability
biome suitability * baseWeight * regionalVariation -> raw score
raw score / sum(raw scores) -> probability
```

### Signal Rules

Each biome has signal rules under:

```json
"signals": {
  "humidity": {},
  "temperature": {},
  "elevation": {},
  "slope": {}
}
```

The main fields are:

| Field | Meaning |
|---|---|
| `min`, `max` | Full-suitability signal band. |
| `transitionMeters` | Preferred authoring knob for fade width at the band edge. |
| `transitionWidth` | Normalized signal-space fallback. Used when `transitionMeters` is absent. |
| `preference` | `"low"`, `"mid"`, or `"high"` preference inside the valid band. |
| `ditherScale` | Frequency of boundary dithering. |
| `ditherStrength` | Strength of boundary dithering. |
| `weight` | Importance of this signal relative to the biome's other signals. |

`transitionMeters` is converted when biome uniforms are packed:

```text
transitionWidth = transitionMeters * biomeScale
```

With the current `biomeScale: 0.001`, `transitionMeters: 4` packs as `transitionWidth: 0.004`.

This is an authoring approximation, not a strict world-space ruler. The visible transition also depends on how fast the climate signal changes across the terrain. If humidity changes very slowly over 100 meters, a 4 meter signal fade can still be visually broader than 4 meters.

### `baseWeight`

`baseWeight` scales the biome before probabilities are normalized. Higher values make the biome more competitive everywhere its signals are valid.

Use this when a biome is consistently losing against another biome even though the signal ranges are correct.

### `regionalVariation`

`regionalVariation` adds large-scale spatial modulation to a biome score:

| Field | Meaning |
|---|---|
| `noiseType` | Noise algorithm. |
| `noiseScale` | Spatial frequency. `0.001` is roughly kilometer-scale. |
| `noiseStrength` | How strongly the noise changes the biome score. |
| `seedOffset` | Per-biome seed offset. |

Use `noiseScale` and `noiseStrength` to make patches less uniform, not to fix splat seams.

## Fixed-Family Splat Generation

The current fixed-family splat pipeline is:

```text
advancedTerrainCompute
  computes raw normalized biome probabilities
  stores top biome tile refs and probabilities as smooth source data

splatCompute
  reads the smooth source
  maps each source category to ORGANIC/MINERAL/SOIL_ARID/COLD
  sums category weights into RGBA family weights
  stores normalized RGBA weights in splatDataMap
```

In fixed-family mode, `advancedTerrainCompute` intentionally does not apply the old source snapping/gating or `blendWidth` probability sharpening. That was the cause of the new hard staircase: the fixed-family path was being fed already-snapped weights and then sharpened again.

The current rule is simple:

```text
fixed family splats use continuous biome probabilities
```

That gives the renderer one hardware-filtered RGBA weight sample with no index lookup and no `bilinearValid` decision.

## Fragment Rendering

The terrain fragment shader samples splats in `terrainChunkFragmentShaderBuilder.js`.

In fixed-family mode:

1. `sampleFixedMaterialFamilyData()` samples one filtered RGBA weight value.
2. The four channels are normalized.
3. The four tile IDs are fixed representative tiles from `materialFamilies.js`.
4. `bilinearValid` is always true.

Material sampling:

| Case | Material samples |
|---|---|
| Pure/dominant family | 1 sample |
| Boundary blend | Up to 4 samples |

The top-2 boundary shortcut is currently disabled because `splatTop2MaxLod: -1`. That is deliberate for correctness while validating the fixed-family migration. Re-enabling top-2 can make boundary pixels cheaper, but it can also create a different edge if the dropped third/fourth channel is still visually meaningful.

## Performance Notes

Compared to the brute-force sparse-ID fix:

| Path | Splat weight reads | Splat index reads | Validity check | Boundary material samples |
|---|---:|---:|---|---:|
| Brute-force sparse-ID manual path | 4 texture loads | 4 texture loads | yes | usually 2-4 |
| Current fixed-family path | 1 filtered sample | 0 | no | up to 4 |

The last correction after the staircase report does make boundary pixels slower than the first fixed-family attempt, because it disables the unconditional top-2 material shortcut. It does not go back to the brute-force splat lookup cost. The big saving remains: one splat sample, no index texture reads, no bilinear-valid branch.

## Legacy Sparse-ID Path

If `fixedMaterialFamiliesEnabled` is set to `false`, the older sparse-ID path is used:

```text
splatDataMap  = top-4 weights
splatIndexMap = top-4 local material IDs
```

That path can represent more exact material choices per texel, but it has a structural problem: hardware bilinear filtering is only correct when all four bilinear footprint corners agree on the same IDs in the same slots.

The brute-force manual bilinear fallback fixed that by reading all four corners and accumulating by ID, but it cost extra texture reads. The fixed-family migration exists to avoid that cost.

Legacy sparse-ID knobs include:

| Knob | Legacy effect |
|---|---|
| `transitionSharpness` | Sharpens stored weights at boundaries. |
| `transitionDominanceStart/End` | Controls where sharpening applies. |
| `sourceMinorityCutoff/Fade` | Removes weak minority biome source weights. |
| `sourceWinnerSnapStart/End` | Snaps winners and suppresses losers. |
| `slotSupportExpansionTexels` | Expands ID-slot support for bilinear validity. |

In the current fixed-family path, these are not the primary visible transition controls. The fixed path bypasses the source snapping/gating and does not apply the extra fixed-family weight sharpening.

## Tuning Guide

### Make Sand/Grass Transitions Snappier

Use these first:

1. Lower `transitionMeters` on the relevant humidity/temperature rules for both competing biomes.
2. Adjust `baseWeight` if one biome is too weak or too dominant.
3. Adjust signal `weight` if the wrong signal is driving the boundary.
4. Increase `regionalVariation.noiseScale` only if the boundary shape is too broad and featureless.

In fixed-family mode, do not expect `blendWidth`, `sourceWinnerSnapStart/End`, or `transitionSharpness` to fix wide visible transitions. They are intentionally out of the active fixed-family weight path because they produced hard staircases.

### Preserve Small Patches

If desert or grass patches disappear:

1. Increase that biome's `baseWeight`.
2. Broaden the relevant signal ranges with `min`/`max`.
3. Reduce the competing biome's `baseWeight` or signal weight.
4. Use regional variation to create stronger local pockets.

### Avoid New Edges

Do not add hard thresholds to fixed-family weights unless there is a debug mode proving the continuous weights are already wrong. Hard winner snapping, minority cutoffs, and top-2 dropping can all create visible family boundaries.

### Add More Visual Variety Later

Fixed families are blend dimensions, not necessarily the final number of visible textures.

The next performance-safe variety step is to choose representative tiles inside each family from slow-changing signals:

```text
ORGANIC: grass vs forest floor from humidity/biome zone
MINERAL: gravel vs cliff rock from slope
SOIL_ARID: sand vs dry dirt from humidity/temperature
COLD: snow vs tundra from temperature/elevation
```

Those choices must be stable and continuous over large areas. Do not switch tiles from high-frequency noise at family boundaries, or that will create a new seam independent of the splat weights.

## Debug Interpretation

Mode 0 is the final visual target.

Mode 43 is useful for checking whether a material/color boundary exists before lighting and fog.

Sparse-ID validity debug modes were built around the old `bilinearValid` problem. In fixed-family mode, the active path has no local ID mismatch to validate, so mode 0 and mode 43 are more useful for judging whether the current fixed-family weights are visually continuous.
