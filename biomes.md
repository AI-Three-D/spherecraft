# Biome System Reference

## Overview

Biome selection runs inside `advancedTerrainCompute` (outputTypes 7 and 8) and determines which materials appear where. The pipeline has two distinct shaping stages:

1. **Signal scoring** (`scoreBiomeSignal` in `biomeScoring.wgsl.js`): each biome's climate range is scored against per-point `temperature`, `humidity`, `elevation`, and `slope` values. Produces a raw `score` per biome.
2. **Probability sharpening** (`computeAuthoredSmoothSplatPayload` in `advancedTerrainCompute.wgsl.js`): raw scores are normalized to probabilities, then shaped by `blendWidth` before being stored as smooth splat source weights for `splatCompute`.

These two stages are independent. `transitionMeters` / `transitionWidth` affect stage 1; `blendWidth` affects stage 2.

---

## Biome-Level Parameters (`biomes.json → biomes[]`)

### `baseWeight: float`
Scales this biome's raw score before probability normalization. Higher means the biome appears more often. Default `1.0`. Range `0–8`.

### `blendWidth: float`  *(probability half-width, stage 2)*
Controls how sharply this biome transitions against competing biomes. Uses `smoothstep(0.5 - blendWidth, 0.5 + blendWidth, probability)` in stage 2.

- Output is exactly **0** when this biome's normalized probability is below `0.5 - blendWidth`.
- Output is exactly **1** when above `0.5 + blendWidth`.
- Smooth S-curve in between.

| Value | Blend zone | Character |
|---|---|---|
| 0.03 | p ∈ [0.47, 0.53] | Very snappy |
| 0.06 | p ∈ [0.44, 0.56] | Snappy |
| 0.10 | p ∈ [0.40, 0.60] | Moderate |
| 0.20 | p ∈ [0.30, 0.70] | Gradual — biome survives at lower probability |

**Small patch preservation:** biomes that appear as isolated patches (e.g. desert specks in grassland) should have a *wider* `blendWidth`. If the biome only reaches 0.35 probability at the patch centre, it needs `blendWidth ≥ 0.15` to survive. Narrower values make transitions snappier but delete low-probability patches.

Default if omitted: `0.12` (moderate).

### `regionalVariation`
Adds spatial noise to the biome's score, creating non-uniform regions.

| Field | Type | Description |
|---|---|---|
| `noiseType` | `"simplex"` / `"perlin"` / `"fbm"` / `"ridged_fbm"` | Noise algorithm |
| `noiseScale` | float | Spatial frequency. `0.001` ≈ 1 km period. Higher = smaller, more frequent patches. |
| `noiseStrength` | float | How much the noise modulates the base score. `0.2` = ±20%. |
| `seedOffset` | int | Per-biome seed so biomes don't share identical patterns. |

---

## Signal Rules (`signals.elevation / humidity / temperature / slope`)

Each signal rule defines the climate range where this biome can appear and how it fades at the edges.

### `min`, `max: float`
The core climate range where this biome scores at full suitability. Outside this range the score fades to zero over `transitionWidth` or `transitionMeters`. Units are normalized signal values (0–1).

### `transitionMeters: float`  *(preferred authoring knob)*
Fade distance expressed in approximate world metres. Converts to `transitionWidth` at pack time:

```
transitionWidth = transitionMeters × biomeScale
```

With `biomeScale = 0.001` (from `engine.json macroConfig.biomeScale`): `transitionMeters: 10` → `transitionWidth: 0.01`.

The actual visible fade width in world space also depends on how fast the climate signal changes at the boundary. At a typical signal gradient the correspondence is approximate, not exact. Use as a relative control knob rather than a precise metre measurement.

### `transitionWidth: float`  *(signal-space fallback)*
Direct signal-space fade width. Used when `transitionMeters` is absent. Range `0.001–1.0`. If `transitionMeters` is also present, `transitionMeters` overrides this.

### `preference: "low"` / `"mid"` / `"high"`
Tilts the biome's suitability score toward one end of its valid range. `"low"` = biome prefers the lower part of `[min, max]` and fades toward `max`. Adds a gentle gradient inside the range without affecting the fade at the edges.

### `ditherScale: float`
Spatial frequency of the per-signal dithering noise (0–1). Controls how fine-grained the stochastic boundary breakup is. Larger values = finer noise.

### `ditherStrength: float`
How strongly dithering displaces the signal boundary. At `0.1`, the boundary wiggles by ±10% of `transitionWidth`. Set to `0.0` for a mathematically clean boundary; increase for organic-looking edges. Dithering is applied in stage 1 (signal scoring), so it affects all biomes uniformly regardless of `blendWidth`.

### `weight: float`
Relative importance of this signal versus the others when computing the combined biome score. All signal weights are normalized; `weight: 0.4` on humidity and `weight: 0.3` on temperature means humidity drives 4/10 and temperature drives 3/10 of the score (with remaining weight on elevation/slope).

---

## splatConfig Parameters (runtimeConfigs.js)

These affect `splatCompute`, which runs after `advancedTerrainCompute`.

| Parameter | Description |
|---|---|
| `splatDensity` | Splat texels per tile texel. `8` = 1024×1024 splat for a 128-texel tile. Higher = finer material detail. Increases compute cost quadratically. |
| `splatKernelSize` | Neighbourhood radius (in tile texels) that each splat texel samples from. `1` = essentially point-sample. `5` = 5×5 neighbourhood, 25× more work. Currently `1`. |
| `slotSupportExpansionTexels` | Extends the ID-slot bake radius beyond `kernelRadius` to ensure neighbouring splat texels agree on material IDs. Keeps `bilinearValid == true` over a larger area. `1.5` is the active value. |
| `transitionSharpness` | Additional `pow(weight, exponent)` sharpening applied inside `splatCompute` at boundary pixels (where dominance < `transitionDominanceEnd`). Higher = crisper stored weights. |
| `transitionDominanceEnd` | Threshold above which `transitionSharpness` stops applying. `0.75` means sharpening fires when the dominant weight is below 75%. |
| `transitionBreakupStrength` | Adds stochastic noise to the stored weight ratio at boundaries. `0.10` = subtle; `0.30+` = strong island-like penetrations. The main knob for organic patch scatter at transitions. |
| `transitionBreakupScale` | Spatial frequency of the breakup noise. |
| `sourceWinnerSnapStart/End` | Global winner-snap gate. When the winning biome's probability exceeds `Start`, minority biomes begin to fade. Fully suppressed at `End`. Currently `0.51/0.58`. |
| `sourceMinorityCutoff` | Floor probability below which a biome is removed entirely. `0.18` means any biome with probability < 18% globally disappears. Does not apply to the top biome. |

---

## Pipeline Data Flow

```
getClimate(wx, wy) → temperature, humidity, elevation, slope
       ↓
scoreBiomeEnv(climate, def)   ← transitionMeters/Width, ditherStrength act here
       ↓ raw score per biome
normalize → probability per biome
       ↓
authoredSmoothSourceGate()    ← sourceWinnerSnapStart/End, sourceMinorityCutoff act here
authoredSmoothSharpenedScore(p, blendHalfWidth)  ← blendWidth acts here (smoothstep)
       ↓ smoothScores[]
splatCompute (kernel accumulation + transitionSharpness + breakup noise)
       ↓
splatDataMap / splatIndexMap  (stored splat weights and tile IDs)
       ↓
fragment shader (sampleSplatData → sampleMicroTextureWithSplat)
```

---

## Tuning Guide

**Wide, gradual transition → snappy:**
1. Reduce `blendWidth` on both competing biomes (e.g. `0.20` → `0.06`).
2. Reduce signal `transitionMeters` on the relevant signals (e.g. `12` → `4`).
3. If still not snappy enough, reduce global `sourceWinnerSnapEnd`.

**Small patches disappearing:**
1. Increase `blendWidth` on the small-patch biome so it survives at lower probability.
2. Increase `transitionBreakupStrength` to scatter islands stochastically at boundaries.
3. Increase `baseWeight` of the small-patch biome.

**Organic, dithered edges:**
- `ditherStrength` on the climate signals controls boundary wigglyness.
- `transitionBreakupScale/Strength` in splatConfig controls the scattered-patch character at the generated splat level.
- These are independent: signal dithering affects the raw score; breakup noise affects the stored weights.
