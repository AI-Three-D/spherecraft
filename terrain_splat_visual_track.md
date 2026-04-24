## Terrain Splat Visual Track

### Branch status

Implemented on this branch:

- generation-side boundary shaping in the splat compute pass
- low-frequency top-two boundary breakup in the splat compute pass
- shared splat uniform writer plumbing
- config-driven micro variant rotation up to a chosen terrain LOD

Current default posture:

- transition shaping is enabled
- center-category bias stays neutral by default (`0.0`) until visual A/B
  validation says otherwise

### What the current image shows

The starred region does not mainly show a shader seam bug. It shows that the
source splat field already looks weak:

- transition zones are too wide
- the shape language is isotropic and cloudy
- dominant regions are not visually assertive enough
- the blend reads as "mud" rather than a believable terrain boundary

This means the visual problem starts before the final fragment shader.

### Current limitations in the active approach

Observed runtime behavior:

- normal terrain shading: roughly 20-55 FPS depending on setup
- terrain debug mode 30: 110+ FPS

The normal terrain fragment path is therefore still expensive.

From recent isolation work:

- splat data sampling costs roughly 6 ms/frame
- tile atlas sampling costs roughly 6 ms/frame
- lighting, shadows, normal maps, and aerial perspective are not major
  contributors

That matters for visuals because any new "breakup" logic added to the fragment
shader will be fighting an already texture-read-heavy path.

### What the current splat source is doing

The current splat compute pass takes the generated tile/category field and
builds a top-4 sparse mixture per splat texel.

Important detail:

- `core/world/shaders/webgpu/splatCompute.wgsl.js` binds `heightMap`
- but the current splat compute logic does not actually use terrain-aware
  signals when constructing the splat mixture
- the live logic is effectively a radial smoothing / category aggregation pass

This explains why the result looks soft and muddy. It is not shaping boundaries
from a strong continuous surface field. It is blurring a categorical field into
a weighted field.

### Can noisy breakup help?

Yes, but only in the right place.

Best option:

- apply breakup during tile/splat generation
- store the result in the splat/control textures
- keep the fragment shader simple

Avoid:

- adding more per-fragment procedural breakup
- adding more texture reads in the terrain shader just to roughen edges

Reason:

- the expensive part of the terrain path is already texture read volume
- fragment-side breakup adds cost exactly where the budget is already bad

### Important sequencing constraint

On the current representation, aggressive edge breakup can make performance and
correctness worse.

Why:

- the current fragment shader depends on neighboring splat texels often sharing
  the same ID set
- when they do not, it falls back to the expensive reconciliation path
- if we add high-frequency breakup before fixing the data model, we increase the
  amount of local ID disagreement
- that risks making the expensive path trigger more often

So the visual track must respect the architecture track.

### Recommended three-track structure

#### Track 1: Representation and splat-read cost

- move toward a page-local palette
- make channel semantics stable per page
- enable hardware-filtered weight sampling
- remove the need for manual corner reconciliation

#### Track 2: Atlas-read cost

- test top-2 effective contributors per pixel
- keep richer data if needed, but avoid shading all contributors everywhere

#### Track 3: Visual quality

- improve the shape of the transition field itself
- reduce muddy, over-wide blend zones
- add organic breakup only in narrow transition bands

Track 3 should not be implemented as "sprinkle some noise in the fragment
shader." It should be implemented as better generated control data.

### Visual-track design goals

1. Preserve strong dominant regions.
2. Keep transition bands narrower and more intentional.
3. Break boundaries with low-frequency, natural-looking variation.
4. Avoid checker/square artifacts and avoid cloudy isotropic blobs.
5. Avoid adding measurable per-frame terrain shader cost.

### Proposed visual approach

#### Phase A: boundary shaping

- derive a boundary mask from the generated mixture
- only apply breakup where two or more contributors are genuinely competing
- keep solid interiors stable

#### Phase B: low-frequency breakup

- modulate boundary position with low-frequency world-space noise
- prefer domain-warped or layered noise over a single smooth noise octave
- keep breakup continuous and spatially coherent

#### Phase C: terrain-aware bias

Once the representation work is in place, consider biasing breakup by:

- slope
- altitude band
- humidity / climate field
- erosion or drainage direction when available

This can make boundaries feel more geologic and less like pure texture noise.

### Practical rule for implementation

If a breakup idea adds cost in the terrain fragment shader, treat it as suspect.

If the same breakup can be baked into generated weight/control textures, prefer
that path.

### First concrete experiment after Track 1 groundwork

1. Keep the local palette / stable weight basis.
2. Generate a narrow boundary mask from the top-two local weights.
3. Apply a low-frequency breakup offset only inside that boundary band.
4. Re-normalize weights.
5. Inspect:
   - border stability
   - muddy-region reduction
   - whether dominant zones become more legible

### Summary

The image suggests a third track is justified, but the right target is not
"more noise in shading." The right target is a better generated transition
field:

- stable
- narrower
- more organic
- and cheap at runtime
