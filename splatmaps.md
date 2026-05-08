# Splatmaps

This renderer should treat splatmaps as blends between canonical surface
materials, not blends between individual tile variants or full biome IDs.

## Concepts

- **Biome**: ecological authoring unit. A biome owns climate/slope/elevation
  rules, asset profile eligibility, and a default visual surface reference.
- **Splat group**: visual terrain material that can be blended with other
  terrain materials. In the current implementation this is represented by the
  tile catalog category, such as `GRASS`, `SAND`, `ROCK`, `FOREST`, or `SNOW`.
- **Tile variant**: a discrete texture/metadata variant inside a splat group,
  such as `GRASS_SHORT_1`, `GRASS_SHORT_2`, or `SAND_COARSE_1`.

Splatmaps operate at the splat-group level. Tile variants may still exist for
local visual variation and asset placement, but variants must not compete as
separate splat channels.

## Why Categories Are Used

The old tile protocol allowed many variants under one surface family. If a
splat kernel blended raw tile IDs, a border between grass and sand could be
misrepresented as a blend between multiple grass variants. That wastes channels
and can hide the real neighboring material.

The current splat pass avoids that by mapping each source tile ID through the
data-driven tile catalog category lookup, accumulating category scores, and
writing the top four categories as sparse splat channels.

Correct:

```text
GRASS_SHORT_1 + GRASS_SHORT_2 + SAND_COARSE_1
=> GRASS weight + SAND weight
```

Incorrect:

```text
GRASS_SHORT_1 + GRASS_SHORT_2 + SAND_COARSE_1
=> three independent tile-ID weights
```

## Runtime Flow

1. Biome authoring selects or influences a discrete tile ID for the generated
   tile map.
2. The splat compute pass samples a neighborhood of tile IDs.
3. Each tile ID is collapsed to its tile catalog category.
4. The pass accumulates category weights and stores the strongest four.
5. The terrain material samples those splat weights and blends the corresponding
   material textures.

The current payload still stores representative tile IDs for compatibility with
the texture lookup path. Conceptually those IDs are canonical splat-group
material IDs, not arbitrary tile variants.

## Current Policy

- Close terrain should preserve weighted splat blending.
- LOD0/LOD1 should stay on live splat sampling through near-ground inspection.
- Prebaked `resolvedColor` is for distance and performance, not for validating
  close splat behavior.
- The chunk palette path should not override local top-four category selection
  when debugging or tuning category transitions.
- Top-2/dominant shortcuts are optimization paths. They must not be enabled in
  close terrain while they hide visible category blends.
- Raw tile-ID fallbacks must not be mixed back into close splat color. They
  carry the original discrete biome/category mask and will redraw hard borders.
- Tile-baked masks such as contact AO may still be useful, but they must back
  off inside active splat transitions so they do not add dark contours on top
  of otherwise blended material edges.

## Tuning Notes

- Blend width should mainly come from `splatKernelSize`.
- `transitionSharpness` is a sharpening control. `1.0` means linear category
  weights. Values below `1.0` are not allowed because they boost small minority
  weights and can create visible rims around biome islands.
- Only near-zero tail weights are ignored in shading. A cutoff that is too high
  creates a hard outer contour where a minority material first becomes visible.

## Asset Placement

Asset streaming should not depend on visual splat channels except as a coarse
fallback. Asset placement should use biome/profile data, tags, authored
eligibility, or a dedicated placement field.

Examples:

- Grass length, forest density, and tree species are biome/profile decisions.
- `GRASS` vs `SAND` is a splat/material decision.
- `GRASS_SHORT_1` vs `GRASS_SHORT_2` is a variant/material-detail decision.

This separation keeps terrain blending stable while preserving room for rich
asset authoring.

## Direction

The next clean-up step is to make the implicit category-as-splat-group model
explicit in the catalog schema:

```json
{
  "name": "GRASS_SHORT_1",
  "id": 10,
  "category": "GRASS",
  "splatGroup": "GRASS"
}
```

If `splatGroup` is omitted, `category` should be used. Rendering should resolve
top-four splat groups to material definitions. Variant tile IDs should remain
available for procedural variation and asset systems, but not as independent
splat weights.
