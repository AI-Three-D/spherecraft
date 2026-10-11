# Structured terrain: baseline and height contract audit

2026-10-08. The baseline is the uncommitted `water-v18` rollback, not HEAD.
The original global-budget derivation below is retained for comparison. The
current tighter regional and basin-local contracts are described at the end.
Increment 4 replaces the rejected paired-ellipse cap with a shallow depression
and adds a conditional zero-erosion certificate; its appearance is accepted.
Increment 5 varies outer-bank reach in seeded arcs; its appearance is accepted.
Further bank polish is deferred. Increment 8 adds optional root-owned valley
placement metadata and a guarded slope-dependent erosion certificate, with
unchanged generated height/erosion equations; the owner found its lake setting
insufficient. Increment 9's optional terrain-owned valley has a valid scoped
contract described below, but the owner now rejects its artificial enclosure
as a direction. The [latest lake reassessment](STRUCTURED_TERRAIN_LAKE_REASSESSMENT.md)
examines unified morphology-based placement and authoritative regional shape
inputs. No runtime height contract changed in that read-only assessment.
Increment 6 tests a smaller highland lake
and regional foundation-aware LOD. The owner identifies its broad plain as insufficient alpine-pocket coverage and authorizes deferral. Increment 7 adds one lowland drainage connection, with near placement/joins accepted and distant representation insufficient.
An independent source snapshot and starting diff were saved at
`/tmp/spherecraft-structured-baseline-20261008` before implementation.
No bank/valley/river algorithms from the rejected experiment are restored.

## Integral generation path

The owner's clarification requires persistent coarse **generation inputs**
feeding fine terrain compute, with regional properties derived from those
same inputs. An observational cache of completed terrain is insufficient.
The first prototype uses six depth-0 generation tiles, separate from render
texture-pool layers, feeding every render depth and hydrology sampler. This
single tier is an initial layout, not a decision against finer regional or
macro/meso tiers. Basins, outlets and rivers will consume the same foundation.

Runtime seed is 12345. The planet's 2048 chunks per face at 128 m give a
131,072 m radius; noise reference radius is 131,072 m. It uses the shader's
**small-planet** regional branch (threshold 500,000 m). Maximum normalized
height scale is 5,000 m. Render tile textures are 128 by 128; maximum render
depth is 11. World authoring raises mountainBias to 2.65 and hillBias to 2.3.
Read active configuration rather than assuming Earth-sized continents.

## Existing stage inventory

Heights are metres relative to the planet reference radius. The engine sea
level is `uniforms.waterParams.y * maxTerrainHeightM()`; it must remain a
separate level in basin/network records.

| Stage/term | Height range or role | Contract implication |
| --- | --- | --- |
| Regional mask/character | Small-planet mask 0..1; baseElevation -0.8..0.8; terrainType clamped 0..1.2 | Continental base can be negative. Land/ocean blend is smoothstep(.15,.45,mask). |
| Continental elevation | baseElevation * .14 * baseBias * maxH | Do not assume positive land base in this active world. |
| Land regions | Two 350 m highland ramps; roughness .15..1 | Broad 100 km FBM field plus inland lean. Keep coord/height/roughness coherent with the generation inputs. |
| Foothills | Nonnegative 165 m shapes times mountainBias and erosion-rate amplitude | Existing 3 km relief remains procedural, before erosion. |
| Big lone hills | Nonnegative domes and two-peak blend; existing hillBias/size modulation | Preserve feature locations/shape equations. |
| Mountains/ranges | Nonnegative analytic massifs, spurs and ranges | Preserve placement hashes and analytic highland test at feature centres. Local minima on mountain flanks need a later analytic/local relief envelope. |
| Runevision erosion | Signed lowering/raising; derived margin below | Counts input slope, variation, relief and style, all octaves and exact initial-fade cancellation. |
| Rolling hills | Nonnegative, after erosion; region.rough attenuates | No new river-side hills. |
| Meso2 | Signed 135 m FBM times roughness, quiet/region patches, microGain and erosion fade | Proven noise bound is 2, not the empirical range stated in a comment. |
| Existing lake hollows | -25..0 m | Shallow noise hollows do not guarantee lakes or containment. |
| Demo river / seed pits | Uniform-dependent; currently disabled | Arbitrary confirmed pit/path scales need their own budgets. Prototype falls back to the existing soft-clamp floor if these are enabled. |
| Inland uplift | Nonnegative with supported profile | Retained; contributes no lowering allowance. |
| Ocean floor | ocean base + .05*n500 + .02*n100 + .005*n20 | Conservatively signed variation <= .15 normalized. Ocean connectivity remains unresolved by height alone. |
| Base soft clamp | Monotone to [-1.1,1.8] with .25 knee | Its lower limit is a true, extremely loose global bound. No new global hard floor is introduced. |
| Cut-only bank retreat and final river channel | After natural erosion/detail | Intentional excavation is excluded from the ordinary-land minimum; basin/channel records need independent contracts. |
| Final per-tile micro | Material-dependent signed FBM; disabled in wet river core | Must budget both signs. Final height is soft-clamped again. Hydrology's base sampling omits this tile micro. |
| Boundary normals | Existing border band reads base-height apron | Preserve this path; it must use the same foundation as tile interior compute. |

Old plains, hills, highlands and canyon feature modules are still assembled
into the shader, but not all their functions contribute to the active height
function. Module presence is not evidence of a terrain-height term.

## Derived displacement budgets

Phacelle's weighted cosine/sine average is divided by a smoothed maximum at
least its vector length, so the cosine magnitude is <= 1. Octave masks are
0..1. Subtracting `fadeTarget * initialFadeWeight` removes the initial fade's
complete propagated contribution. The remaining height recurrence is
`q_i = (1-mask_i)*q_(i-1) + mask_i*gullyWeight*cos_i`, starting at zero.
Thus `|q_i| <= gullyWeight` and

```text
max erosion displacement
  = strength * scale * maxAmount * gullyWeight * sum(gain^i)
maxAmount
  = max(1, variationMin) * max(1, lowReliefAmount) * max(styleStrength)
```

Current values: `.22 * 1500 * 1.3 * .5 * 1.9375 = 415.59375 m`.
This is a global worst case. A later local bound must enclose local relief,
style and variation over the entire region, not just sample their maxima.

The actual Perlin implementation's corner gradient sums two signed coordinate components (sometimes the same coordinate twice).
Corner dot products are bounded by 2; nonnegative fade weights and normalized
positive FBM weights preserve that envelope. Meso lowering is therefore at
most `135 * 2 * microGain * max(1, abs(1-maxAmount*(1-mesoKeep)))`, currently
270 m. The largest final micro envelope is forest: `(.6+.3+.2+.12)*2*10`,
currently 24.4 m. Grass, generic and both sand variants, including the sand
dune envelope's possible overshoot, have smaller envelopes. Lake hollows add
25 m lowering. One metre is reserved for numerical/quantization allowance;
stress samples must report deficits rather than redefine this allowance.

These conservative budgets are already **735.99375 m** including numerical
allowance. Bounds can be too loose for high lakes even when valid. Report
slack and usable elevation, then tighten spatial bounds or subdivide; do not
deepen basins to conceal a weak contract.

## Prototype bound and interpolation contract

Two RGBA32F fields store the existing broad regional properties and region
coord/height/roughness. A 4x4 nonnegative cubic B-spline footprint defines the
new macro foundation between controls. The support minimum of the linear
combination `continental shelf + regional height` bounds this **generated
foundation** everywhere inside that cell. It does not bound the old analytic
terrain between its samples. Analytic spline derivatives feed the original
erosion filter. No erosion gullies or 750 m meso are baked into coarse data.

GPU-generated R32F lower bounds subtract erosion, meso and hollows from that
foundation minimum. A mask support entirely >= .45 proves full land blending;
otherwise the ocean envelope is included. Apply the existing base soft clamp,
subtract the final micro envelope, apply the second soft clamp, and reserve
numerical allowance. Bound stage is natural final height **before intentional
water excavation**. A lower bound does not provide a wet-interior guarantee.

Across cube faces, the prototype smoothly returns to the established analytic
field over a C2 seam guard. Direct values there are outside the spline control
envelope, so guard cells use the analytic global bound. This explicitly costs
extra analytic work and weaker bounds near cube edges. It is a prototype
limitation to measure, not a final face-seam solution. Within a face, all LODs
read one immutable field; no separate render-parent interpolation is used.

The current contract assumes finite supported parameters and nonnegative
strength/gain/style. Unsupported erosion configurations fail explicitly.
Changing inputs requires a new source version and regenerated descendants;
runtime hydrology must be rebuilt with the same version before adopting such
a change. The current prototype is startup-configured and off by default.

## Hypothesis and next gate

Hypothesis: a single resident tier for the existing broad fields can preserve
terrain character while providing conservative cell envelopes and reducing
repeated macro evaluation. Confidence: moderate. Disproof: visible smoothing
or coast movement, erosion responding to grid boundaries, any bound deficit,
face/tile mismatches, or added dispatch/fetch/regeneration costs outweighing
the saved work. Basin construction and additional tiers wait for matched
visual assessment and complete cost measurements.

## First-prototype result

The data-flow and supported-config envelope passed native checks; the
performance-saving hypothesis did not. Seven complete fine tiles are about
1–2% slower before adding shared root generation. No macro/meso/micro tier
or richer noise stack has been adopted. The prototype remains off by default.

256-cell roots reduce broad mean/RMS height differences to .764/1.810 m,
maximum 25.88 m; a targeted steep patch reaches 26.71 m. 128-cell roots give
2.932/6.938 m, maximum 101.49 m, and 104.60 m on that patch. Interpolated
gradients alter erosion even when the broad elevation field looks close.
The owner has accepted the prototype's visual fidelity while roaming, with
loading behavior unchanged. This does not approve new basin/network visuals.

No lower-bound violations were found in 32,768 broad natural and 131,072
final tile samples per resolution. Sampling is validation of the derivation,
not proof between arbitrary points. Median bound slack at 256 is ~817 m;
the highest bound is only ~524 m. This is insufficient for mountain-flank
alpine lakes without tighter local relief/displacement envelopes or regional
subdivision. A basin's wet-interior upper envelope is still unimplemented.

See [complete cost/memory/regeneration evidence](tools/perf/structured-terrain-results/MEASUREMENTS.md)
and the latest handoff session record for the visual gate and next increment.

## Placement follow-up

The owner clarified that lake/river placement should proceed on the current
terrain stack; improvements to terrain features come afterward. The unfinished
mountain-envelope experiment was removed. No new noise, erosion or relief
equation is retained.

The first placement feasibility check tests 16 separated highland candidates
from the current highest conservative bounds. On the real unchanged terrain,
~102 m radius basins with 8 m water depth and 8 m rim clearance would require
755–2,508 m centre cuts, including the final-micro allowance. None meets the
100 m diagnostic cut ceiling. This disproves direct use of the present broad
bound for these small highland basins; it does not establish that every lake
site is unsuitable. Sampled heights measure excavation and validate the
contract; they do not replace a conservative minimum.

No basins were carved. Next: the minimum basin-local accounting of existing
terms, or a suitable existing low-relief region, before constructing one
closed basin. Keep guarantees explicit and terrain features intact.

## Increment 2: coupled regional bound and one local basin certificate

This section supersedes the previous placement conclusion. No noise,
landform, erosion or amplitude equation was changed. The only new height
effect is the intentional, opt-in basin excavation described below.

The positive relief `r` also controls erosion strength. Discarding `r` while
subtracting the full 415.594 m erosion budget lost useful information. The
correct joint global bound is

```text
min(r >= 0) [r - A * mix(lowReliefAmount, 1, smoothstep(start, full, r))]
```

Endpoint and quadratic derivative roots give the minimum analytically. With
the active configuration it is -83.11875 m. The old absolute erosion budget
remains valid and is reported separately. Convex control maxima also bound
the EXISTING meso multiplier and hollow modulation; they are not new terrain
parameters. Current root bounds have zero deficits in the repeated broad and
final-tile surveys; highest bound 867.039 m. These remain ordinary-natural
bounds, excluding intentional water cuts.

For a proposed footprint entirely within one non-seam coarse cell, interval
gnomonic coordinates enclose its chord ball. Each spline weight is monotone
on [0,1]. Subtracting a reference control uses partition of unity to bound
the foundation tightly over this smaller footprint, without changing the
interpolation. Perlin corner dot products are linear; their interval bounds,
monotone fade intervals and nested convex interpolation enclose every
intersected lattice cell. Wide boxes fall back to +/-2. Positive normalized
FBM octave weights preserve the intervals. These planning-only functions use
the existing hashes, gradients, rotation, seeds and wavelengths.

Local style/variation intervals narrow erosion. The mountain variation floor
is also included: mountain height <= total positive relief. A 256-bin interval
minimization of relief minus erosion uses each bin's lower relief and upper
erosion amount; the remaining infinite tail cannot lower the result. Meso
uses its local noise absolute envelope and existing control maxima; its other
patch factors remain conservatively bounded by one. The existing inland
uplift contributes its provable minimum from the land-mask controls. Hollows,
both soft clamps, the full 24.4 m micro envelope and the original 1 m numerical
allowance are included. No sampled minimum becomes the certificate.

The first deterministic planner examines 32 separated low-relief candidates,
then publishes one basin record with the immutable root generation. Selected
cell 92588, centre [-.9317904733, -.1637912941, .3239427817], 100 m footprint
radius, certified natural-final lower 531.483094 m, level 528.483094 m, depth
8 m, uncut rim clearance 3 m. Centre excavation estimate 72.449 m. The 100 m
centre-cut ceiling is an explicit feasibility criterion, not a guarantee on
all possible footprint cuts. Dense inspection measures maximum 72.498 m here.

Construction applies a cut-only smooth minimum with a radial bowl after the
existing natural stack, then a C2 return to the original height by 100 m.
Nothing raises the rim. At <=50 m radius the connected disk is at least
3.266 m below level; final micro is suppressed through the 65 m core and
smoothly restored by the outer radius. Levels must remain in the existing
clamps' linear interval. The uncut 100 m contour retains the certified 3 m
clearance. Planning rejects seams/multiple-cell footprints, demo edits,
unsupported variationMin >1, and unequal noise/physical radii in this preview.

Dense check: 102,400 natural/constructed samples; zero natural-bound deficits,
raised samples, outside-footprint changes or wet-core failures. Actual nine
production tiles include final micro: 147,456 texels, 2,501 wet-core samples,
zero wet-core/rim failures. The check reports containment margins, not just
negative counts. The round, deep bowl still needs owner visual assessment.
This upland candidate does not establish mountain-flank/alpine placement;
that must use the same regional-record contract with improved candidate
coverage/tightness after this gate. A coarse river network is still pending.

## Increment 3: continuous local rim certificates

The old whole-footprint certificate unnecessarily limited water level by low
interior terrain. The current `lowerM` is a natural-final **rim** minimum.
Twenty-four cap centres lie on the enclosing 100 m tangent-plane circle.
Every point in the continuous 100–106 m annulus has a nearest centre with
planar separation <=6+2*106*sin(pi/48). Projecting to a local gnomonic frame
costs <1.001 for the supported `(radius+6)/R <= .01`. Rounding
`6+1.001*2*106*sin(pi/48)` up gives a 20 m cap. The pre-existing chord-box
padding also remains. Each cap is bounded over its full domain, including
noise lattice crossings; no sampled rim minimum is substituted. Taking the
minimum certificate over the cap union certifies an uncut closed contour.

Local noise intervals retain the same fade/corner equations. Wide boxes and
tighter local intervals now also use the proven |Perlin|<=79/64 envelope,
plus .0001 padding, from `structuredBasinBoundAudit.mjs`. Normalized positive
FBM preserves this bound. The rotated micro FBM helper reproduces the existing
per-octave rotation; orthonormal rotations preserve the enclosing chord ball.

Meso lower accounting uses its negative interval tail when erosion's meso
coefficient is nonnegative; unsupported signed coefficients keep the older
absolute envelope. Existing 1.5 km quiet and 10 km region masks are bounded
locally. The 6 km hollow activation is likewise bounded instead of always
subtracting its full 25 m allowance. None of these changes alter heights.

Micro is bounded independently of the material chosen by the production
tile classifier. With B=79/64+.0001, nonnegative masks and normalized FBM:

- Forest: B*(.9*wBumpMax+.2*wGentleMax+.12*wRoughMax)*intensityMax*10.
  Bounds use the selector's +200 seed offset and existing broad masks;
  the unresolved short-scale rough patch is safely <=1.
- Grass: .7625*B*6. This includes the .5 fine and .25 gentle factors.
- Sand: max((.65*B+.25)*(.5*B+.5),B)*3. This includes dune overshoot,
  sine magnitude <=1, and the maximum displacement across slopes.
- Generic: .5*B*2.5.

Take the maximum across materials and multiply the locally bounded existing
2/8 km modulation and profile gain. Feature-off/global-budget guards remain;
both soft clamps and the 1 m numerical margin remain. Broad root budgets still
use their original +/-2 noise and 24.4 m micro allowances. Consequently the
old global-budget rim diagnostic can be negative while the tighter derived
local certificate and actual final tile checks remain valid. Do not use that
negative diagnostic as the local proof, or silently discard it.

The paired-ellipse distance is a smooth minimum (k=.08) of two positive
quadratic distances. Its value is <= either distance and >=min-.02. The main
semiaxes are .88r and .88*aspect*r (aspect<=.9); the second has semiaxes
.58r/.48r and offset (.28r,.14r). Therefore any support point fits in the
enclosing circle: .88*sqrt(1.02)<1, and
sqrt(.28^2+.14^2)+.58*sqrt(1.02)<1. Directions are fitted from sampled
surrounding heights for orientation only. The ellipse union is connected.

The centre disk of radius .5*.88*aspect*r has main distance <=.25, so the
cut cap lies at least depth*(1-.25/.65^2) below level, with final micro fully
suppressed there. For the current depth 8 m this is >=3.266 m. Outer support
vanishes before the certified circle, without raising the base-height rim.
The final terrain uses the same existing clamps and downstream cut passes.

Selected cell 102878: lower rim 516.118530 m, level 513.118530 m, 33 m
guaranteed core, dense maximum base cut 27.709015 m. 102,400 dense samples
have no rim deficits/base lifting/outside changes/core failures. Nine full
production final tiles: 147,456 texels, minimum checked wet depth 3.346602 m,
minimum checked rim clearance 18.211057 m, no wet/rim failures. These are
validation observations alongside the derived guarantee, not its source.
Final micro changes inside the intended footprint are not claimed identical
to the uncut reference. Mountain-flank/alpine coverage remains unproved.

## Increment 4: conditional zero erosion and a shallow natural depression

Increment 3's numerical improvement did not pass the owner visual gate: the
bank remained too deep and uniform. The following changes affect certificates
and the intended local basin cut, not natural noise, relief, erosion settings
or global height budgets. `regional-macro-v5-basin-banks` is the current source.

The rim is still a continuous 100–106 m annulus. With 64 cap centres, its
nearest-centre planar separation is <=6+2*106*sin(pi/128). The existing
gnomonic/chord padding remains; rounding `6+1.001*2*106*sin(pi/128)` up gives
a **12 m cap**, covering the intervening directions as well as sampled ones.
128 stratified broad candidates and the best 16 × 64 rim caps are certified.
Samples used to rank/orient/fill shape records never replace these bounds.

### Conditional erosion allowance

The existing coupled relief-minus-erosion minimum remains the fallback. It
can be replaced by zero only when the whole cap proves both:

1. **All relief entering that erosion pass is absent.** Existing foothill
   activation is bounded below its onset; the huge/landmark hill intervals
   remain below their existing activation thresholds. Massif/range tests
   reproduce original `mtnSite`, parameter draw order, footprint angle and
   `mtnPlace`. The cap must remain in one feature cell and outside the hard
   footprint guard, or the original placement must fail. A chord radius rho
   bounds the change in the dot product by rho; an extra 1e-6 guard is used.
   Unproved absence fails closed. Rolling hills, meso and hollows are added
   later and retain their separate bounds.
2. **The complete foundation slope is below existing `sharpSlopeStart`.**
   For tensor cubic B-splines the derivative is a convex sum of neighbouring
   control differences. Let dx/dy be the largest adjacent height differences
   among the 4 × 4 controls, u/v the bounded gnomonic ratios, d the face-axis
   dot product, N the grid cell count and R the noise radius. A slope envelope
   is `(dx*sqrt(1+maxAbsU²)+dy*sqrt(1+maxAbsV²))*N/(2*(d-rho)*R)+.0001`.
   This applies the chain rule and triangle inequality over the whole cap.
   Existing all-land, no-seam, no-demo and single-spline-cell guards remain.

Thus relief=0 and the original erosion slope activation is exactly zero.
No erosion computation is skipped or changed for terrain consumers. If either
proof fails, the existing conservative allowance is retained. This conditional
proof does not establish alpine/mountain-flank coverage. Existing local meso,
hollow, material-micro and soft-clamp accounting is unchanged.

### Basin support and wet core

The 176-byte record contains 16 periodic radial start/outer-radius pairs. The
planner fits them from existing surrounding heights after removing the first
harmonic plane trend. Positive cubic weights preserve start >=.20r, outer
<=.96r and transition width >=.12r. Periodic spline values/derivatives match at
the angular wrap. Quintic transitions have vanishing endpoint derivatives.
The angular evaluation is bypassed near the origin and outside compact support.
Analytical coordinate and spline derivatives feed the existing normal path.

The broad cut is `naturalHeight - centreCut*W`, with `0<=W<=1`. This preserves
natural dry-bank undulations instead of replacing them with a cap surface.
Only the inner 12 m disk uses a bed cap: height <=level-depth-.05 m, smoothly
blended back out by 20 m. Its smooth minimum is cut-only. Final micro is zero
through 12 m and fully restored by 24 m. This establishes a connected wet disk
with the existing final clamp contract; it does not prove the entire visible
shoreline is connected or that every dry-bank texel equals its old height.
All intended cuts vanish before 96 m, leaving the certified contour uncut.

Preview depth/rim are now 3/1.5 m rather than 8/3 m; guaranteed core shrinks
from 33 to 12 m. The 12 m centre-cut selection ceiling is not a general bound
over all footprint heights; the inner cap can cut more if natural heights rise.
Selected cell 86179: natural centre 581.467163 m, rim lower 577.766479 m,
water level 576.266479 m, estimated centre cut 8.200684 m. Dense maximum cut
8.406372 m, against rejected increment 3's 27.709015 m at its different site.

102,400 dense base samples: no rim deficits, base lifting, outside changes or
wet-core failures. Nine final production tiles include micro: 147,456 texels,
172 core texels, no wet/rim failures, minimum wet depth 3.049952 m and rim
clearance 4.953648 m. These validate the scoped derived guarantees; measured
minima are not their mathematical source. The old loose global-micro margin
remains as a negative diagnostic rather than being passed off as the local
proof. Base-only shore radii/grades vary; actual bank appearance remains an
owner decision before alpine coverage or drainage changes.

## Increment 5: selected bank-reach extensions

The owner accepted increment 4 and requested additional angle variation by
extending selected portions of the outer bank. Two compact seeded circular
patches produce nonnegative outer-node extensions, bounded by `bankReachM`
(18 m default at this 100 m footprint). Start radii do not move. Each outer
radius is clamped at .96r; positive periodic spline weights retain the existing
support and minimum-width guarantees. The compact patch weight
`(1-distance²/halfWidth²)^3` vanishes with its first two derivatives at its
support edge. Fine computation still reads the same 16 radial pairs and uses
the same WGSL; no new runtime noise or feature stack is introduced.

The natural-final rim certificate, 100–106 m uncut annulus, cut-only depression,
12 m guaranteed wet disk, wet-core cap and final micro policy are unchanged.
Water level and candidate selection are independent of reach fitting. Source
version `regional-macro-v6-bank-reach` includes the configured reach and the
resulting records in source identity; repeated complete regenerations retain
the same basin identity and shape. `bankReachM=0` recovers the accepted fit.

Current node extensions: 0–16.578 m; seven of 16 nodes are unchanged. Fine spline
support means unchanged nodes alone do not imply an entire nearby arc is
unchanged. Measured shoreline movement: 0–6 m, mean 1.590 m over 128 base-height
rays. This modifies shore position as well as dry-bank angle. Pooled grades are
narrower than the accepted fit; statistical variance is not the acceptance
claim. Final bank appearance and the amount of movement require owner review.

The final native checks retain the exact increment 4 maxima/margins: dense
maximum cut 8.406372 m, minimum final wet depth 3.049952 m and rim clearance
4.953648 m. 102,400 dense samples and nine complete production tiles (147,456
texels) have no scoped failures. These observations validate the existing
proofs rather than replacing them. Broader alpine coverage remains unproved.


## Increment 6: altitude-aware selection, smaller footprint, selection proxy

The owner accepted the bank-reach refinement and deferred further bank polish.
No height equation, erosion, local material-micro budget, certificate shader
or basin shader changes in this increment. Both regional WGSL files match the
increment 5 snapshot. The generic planner separates coarse candidate admission
(`candidateMinM`, `maxRoughness`) from the final certified minimum water level,
and ranks the deficit to the requested elevation before centre-cut cost. The
accepted lowland record is exactly unchanged. This does not add a special
alpine height function or lift the terrain to make a site.

The read-only audit first failed the highland shortlist, then failed its 12 m
cut ceiling. A diagnostic 60 m footprint with minimum level 900 m, roughness
admission up to 1 and a 16 m centre-cut ceiling selects face 2 cell 146254.
Water 1286.852295 m; certified natural-final enclosing lower 1288.352295 m;
uncut annulus 60–66 m; intended support below .96r; connected 7.2 m core with
at least 3 m final depth. Same interval/noise, erosion, clamp and micro proof,
including the existing guarded conditional zero-erosion case. A nearby 3009 m
mountain is outside the lake footprint. This is mountain-foot coverage; it
does not establish tight useful minima on arbitrary steep mountain flanks.

Dense base inspection: 102,400 samples, no bound deficits/lifting/outside or
core failures, maximum cut 14.019653 m. Nine final production tiles: 147,456
texels, 88 core texels, no wet/rim failures; minimum final wet depth 3.050054 m
and enclosing rim clearance 9.881472 m. These are validations of the proof,
not the proof's source. The default lowland 12 m selection ceiling is retained.

The initial actual game mesh failed visually despite these valid textures.
Regional foundation height now supplies a quadtree **selection-distance
proxy**: shelf coefficient and regional-height coefficient come from the
same immutable feature mask/profile, and the same cubic controls are read
through two shared textures. Sea-level distance selected depth 8 near 1.3 km
terrain; the proxy selects depth 11 at the close lake. Culling retains its
sea-level centres and existing displacement envelope. No new field, GPU
buffer, terrain sample/readback or basin-specific LOD hint is introduced.
The optional traversal pipeline is initialized when regional data are present
at startup; publication replaces its texture views before traversal submission.
Coefficients occupy spare existing traversal-uniform space.

The proxy omits positive local peaks, erosion, detail and the analytic seam
fallback. It is neither a conservative minimum nor final terrain height; no
contract may use it as either. Residual peak/seam selection errors remain
possible. Pipeline/driver allocation overhead is unmeasured. Complete native
costs, live-game screenshots and the pending placement/representation gate
are recorded in the latest handoff and measurements. Further bank polish,
terrain-quality changes and tier adoption remain deferred.


## Increment 7 — local receiver, coarse survey, intentional rim openings

The same basin contracts certify receiver cell 85918 at 571.262268 m, 100 m
radius, 10.081299 m centre-cut estimate. Source cell/shape/level unchanged.
Natural regional lower bounds still describe final terrain **before** water
excavation. Root-owned 128 m survey values rank a coarse route; they are neither
regional minima nor a continuous excavation bound. Original terrain equations
remain unchanged. Existing cut-only channel acts on the published 76-point
route at every terrain LOD; its surface descends 5.004211 m over 4,773.587 m.

The incoming/outgoing channels intentionally open both enclosing basin annuli
at the mouths. Do not reuse the original uncut-annulus proof as a closed-rim
proof of the connected result. Water `closed` means no outgoing connection.
Wet-core depth remains safe under additional subtraction. 1,800 route samples
and 624 final wet texels show no scoped failure; they do not replace a
continuous bound. Distant mesh rendering nonetheless fails visually; see the
actual comparison and early diagnostics. Near placement/joins are accepted.
Targeted alpine metadata/search is now authorized; natural terrain retuning
and relaxing guarantees remain out of scope.


## Increment 8 — valley ranking and slope-dependent erosion allowance

Generated height, erosion, detail, feature and basin-carving functions are
unchanged. Optional placement metadata belongs to the same generation roots;
its natural-height/relief/input-slope/foundation samples rank candidates only.
No sampled value is used as a lower bound or permission to reduce a margin.
The selected recentered footprint still passes every continuous certificate.

The existing `basinReliefAbsent` interval/feature-footprint guards prove that
foothills, large lone hills and mountains are identically absent over a cap.
Under that guard, the erosion input is exactly the continental-plus-regional
cubic foundation. Its physical gradient bound is already derived from adjacent
control differences and the gnomonic chain rule:

```
slopeMax = cells * (dxMax * sqrt(1+maxU²) + dyMax * sqrt(1+maxV²))
           / (2 * (faceDenominator-rho) * R) + numerical slope padding
```

Cubic-spline derivatives are convex sums of neighbouring control differences;
the triangle inequality bounds the combined world gradient. The cap remains
inside one non-seam cell, and the ocean blend is identically land. Thus no
omitted seam/land-blend derivative enters this slope estimate. With zero relief,
the original relief ramp is zero and mountain variation floor is zero. The
existing erosion equation therefore has the continuous lower bound

```
E >= -strength * scale * gullyWeight * octaveSum
     * styleStrengthMax * variationMax * lowReliefAmount
     * smoothstep(sharpSlopeStart, sharpSlopeFull, slopeMax)
```

The existing gully-mask magnitude proof and finite/nonnegative parameter
contracts still apply. Validate the slope ramp endpoints/order. Take the maximum
of this lower bound and the previous general relief/erosion lower bound only
when relief absence is proved. Zero erosion below the old onset remains valid.
All later meso/hollow/material-micro and two-clamp accounting remain unchanged.
This extension is planning-only and optional; it does not tune actual erosion.
On the selected 60 m valley site, the old bound implies a 40.871704 m centre cut;
the tighter bound implies 15.223755 m. Both are conservative, with different
tightness. The original 32-site audit still admits no highland site, so this
proof extension alone is not sufficient candidate discovery.

Optional tighter rim-cap coverage follows the law of cosines. A nearest node
on planning radius r is at angle <=pi/n from every annulus point. The worst
point is at radius r+6; squared planar distance is
`6² + 4*r*(r+6)*sin²(pi/(2*n))`. Normalize the gnomonic plane: its derivative
norm is <=1/R, so this distance/R also encloses spherical chord displacement.
Ceil, 1.001 margin and the certificate's existing chord/numerical padding
remain. At r=60, n=64, the cap is 7 m; the old triangle inequality used 10 m.
Coverage is continuous, including angular gaps and both annulus endpoints.
Default lowland and existing river basin options retain the old caps/bounds.

Cell 233189 at 1235.082886 m water, planning radius 60 m: enclosing natural-final
lower 1236.582886 m, uncut 60–66 m annulus, compact support below .96r, 7.2 m wet
core and 3 m depth. Same accepted irregular radial/bank recipe. Dense maximum
cut 15.608521 m; 102,400 base samples and 147,456 production texels have no scoped
deficit/lifting/outside/core/rim failure. Minimum checked final depth/rim
clearance 3.049961 / 8.360380 m. The sampled context's opposing 323.809 m rise
suggests a valley floor; it is not a cirque guarantee. Actual visual review is
pending. Accepted lowland/river records and fine basin WGSL match increment 7.

The owner's feature-first idea is analyzed in the handoff. A future terrain
feature could publish a known site and interval
`floorUpper + depth <= waterLevel <= rimLower - containmentMargin`, accounting
for its foundation and every later displacement. A wet-core construction cap
can establish the floor bound. Humidity can activate water only when that
interval is valid; it cannot substitute for the bounds. No such new terrain
feature is implemented in this increment.


## Increment 9 — bounded terrain-owned valley recipe

The owner authorized one terrain feature with raised enclosure and a known
basin, then visually accepted its proof-of-concept enclosure. This is a scoped
new height-model component. It does not retune the global noise/erosion stack.
Inside its ellipse, original post-erosion detail is bounded and partially
replaced; outside, original height is exactly retained. New hills are evaluated
after the original erosion, so their initial smooth shapes are not yet eroded.
The original stack is still evaluated; no fine-noise skipping is implemented.

The optional recipe is created with a canonical seeded regional address, axis,
shape/support parameters, macro foundation anchor A, existing precipitation,
and a 16-byte macro/climate/old-bound check. There is no alpine valley search.
Old lowland placement still searches and continuously certifies existing
terrain. Both generate root-owned records consumed by height generation.

In the full-weight part of the ellipse, in metres:

```
H_base = A + nonnegativeHills + 6*u² - D*basinWeight
         + detailLimit*tanh((H_old - B_old)/detailLimit)
H_final = H_base + bounded materialMicro
```

Here u is tangent distance divided by halfLength, B_old is the original coarse
foundation including inland uplift, detailLimit=1.5 m and microLimit=.5 m.
The original eroded/features/detail result is inside tanh; no statistical or
sampled erosion allowance is substituted for that bound. A compact C2 window
is1 for normalized squared ellipse radius<=.16 and0 at>=1. Both base height
and material micro blend smoothly back to original terrain over the remainder.
Hills are nonnegative compact cubic bumps: two side hills and a head wall.
The wet core cannot intersect any hill support. The basinWeight is the same
bounded periodic radial spline used for ordinary cuts:1 over the connected
inner core and0 outside .96r. No global hard floor or per-region step is added.

The full enclosing r..r+6 annulus lies inside the feature's full-weight window,
as enforced by the half-axis/radius config contract. There basinWeight=0 and
hills/6*u² cannot lower the rim. Numerical padding1 m gives:

```
rimLower = A - detailLimit - microLimit - 1
floorUpper = A - D + detailLimit + microLimit
             + 6*(.12*r/halfLength)²
floorUpper + requiredDepth <= waterLevel <= rimLower - requiredRim
```

D is chosen to make this interval nonempty, with .2 m core margin. In the
measured120 m feature: A1247.596924, D9.7, rimLower1244.596924,
floorUpper1239.901900, interval[1242.901900,1243.096924], water1243.096924 m.
Both soft clamps are proved in their linear range for the recipe, including
all hill and global material-micro allowances. Incompatible inputs are
rejected; no local repair search runs. Precipitation determines water activation
after the geometric interval is valid; it cannot establish that interval.

Existing coarse minimum textures remain valid for this new component. The
recipe's all-support lower bound is
`A - D - detailLimit - globalMicroBudget - 1`. Creation checks it against the
maximum of all existing cell bounds over a conservative whole-support UV box.
The same complete macro control footprints prove landBlend identically1.
Seam/ocean or nonlinear-clamp cases are rejected. A convex mix of the original
height (already above each old bound) and recipe (also above that bound) stays
above it, including the mixed material micro budget. This is a conservative
acceptance guard, not a sampled-minimum proof or redefinition of old bounds.
Intentional later basin/river cuts still require their own contracts.

The feature alone already guarantees its wet core. Its ordinary basin record
has centreCutM0; enabling water adds no base-height excavation. Core micro is
suppressed by the existing basin stage when wet, and bounded when dry. The
feature geometry exists independently of basinCount or precipitation.
Dry/wet base samples and dry-climate sampled geometry match exactly. New water
activation therefore does not supply or create the enclosing hills.

Production final-height checks:147,456 texels,338 core samples, no wet/rim
failures; minimum core depth3.703794 m, enclosing rim3.283957 m. Whole-support
base audit:25,921 points,20,458 exterior heights exactly equal original, no old
bound deficits after subtracting the global micro budget. Maximum sampled
lowering/lifting from original18.263916/112.887451 m; these are diagnostic,
not global bounds on terrain change. The potential feature has an exit-direction
and higher-ground hint but no routed alpine connection. No existing closed-rim
claim can survive a future undeclared outlet; record and certify it explicitly.

## Increment 11: authoritative eroded regional shape

Optional local spline controls contain old natural eroded base, not a sampled
minimum masquerading as an analytic bound. This field defines the height used
by all fine LODs and hydrology in its interior. Tensor B-spline→Bezier cell
control hulls enclose every interior point and saddle. A conservatively
8-connected threshold component has an entire dry cell ring. All16 micro-mask
controls are one in potential wet cells AND ring; final material detail there
is bounded±0.25m. Scalar evaluation allowance0.125m is restricted to controls
within±10000m. Geographic CPU/GPU coordinate discrepancies do not select a
weaker certificate: shader ownership, cut, spline controls and micro mask all
use the same shader cell coordinates. The observed0.02569m interpolation error
is a diagnostic, not the definition of the bound. Publication also checks the
convex global shape minimum minus ordinary old micro allowance against ALL
covered root lower bounds; exterior/guard blend retains ordinary root proof.

Bed h−cut(h) is monotone, cut≤1.5m, zero at/above water, full below water−0.5m.
Core proof evaluates this function at the whole-cell upper hull; retaining
ring uses the lower hull minus micro/evaluation allowance. Numeric near-mask
normalization and scalar arithmetic are included in the allowance. No dry-bank
lowering or invented surrounding relief. Native final texture audit covers
147456 samples:zero core/rim failures, observed core≥3.368m/rim≥1.094m vs certified
2.922m/.583m. Real render geometry can still miss the pond at coarse LOD; this
is a separate representation failure, not evidence that texture guarantees
ensure lake visibility. Actual original/dry/wet screenshots retain that failure.

## Increment 17: landscape preference is separate from the height contract

The optional enclosure preference samples eight directions at 120 and 240 m
from the certified core, using the same authoritative spline. A ring needs
at least six available samples, four sectors at least 15 m above water, and
an opposing pair at least 20 m above water. Samples outside the full-weight
regional interior are unavailable; no domain expansion or extra terrain probe
is allowed. The zero setting skips these computations entirely. Increment 18
tightens the default to 30 m opposing rise and 22.5 m sector rise after the
20 m trial still admitted a visibly weak highland plain. This affects candidate
acceptance, not any height equation or containment bound.

These samples select a landscape setting. They do not prove enclosure, replace
the continuous cell hulls, or weaken the core/rim certificate. The candidate,
level and flood-cell budgets are unchanged. Rejected settings publish no lake
and perform no underwater cut. Existing shape interpolation is still generation
input, even in a region where placement fails. No artificial hills are added.

The independent highland case 3/7/10/96 has certified whole-cell depth 3.039 m
and rim 0.530 m. Its 147456 production height texels include 56 core samples;
observed core depth is at least 3.433 m and rim 1.010 m, with zero deficits.
The old elevated-plain case 5/7/31/65 is rejected; its measured maximum cut is
exactly zero. Both retain the 1.5 m cut limit and unchanged exterior terrain.

## Increment 21: distant river depth is a representation

Terrain equations, shared shader source, river points and tested height results
are unchanged. Beyond the near surface range, island-free carved structured
segments can shade water using their existing profile minus0.25m, restricted
to the full-weight .85-width incision interior and first-point cap exclusion.
No assumed profile floods legacy or island-bearing reaches. The profile bounds
the cut terrain from above within this domain; final micro is suppressed there.
This restores coarse visual coverage and does not claim a continuous river
certificate, geometric water surface or simulation. The sampled49152 production
height values retain624 wet centre points and min depth1.507m with no deficits.


October10, increments24–25: see the detailed handoff record for adjacent authoritative basin fields, bounded monotone mountain descent with one localized fall, rejected excessive-cut/periodic-fall trials, sampled height checks, actual LOD correction and complete/shared/memory/regeneration costs. Native complete10-output regeneration140/139ms typical; first cold compiler stall48.9s remains. Actual paired close water continuity improves, distant river visibility remains unresolved. Extra visible depth11 tiles are not charged by the fixed-output native comparison. Large organically shaped plains lakes are now explicit owner scope and the next bounded prototype; small pond screenshots do not satisfy it.


October10 increment26: regional cut-only depression supplies a known anchor to the SAME spline cell-hull basin proof; no raised hills. Actual617×538m plains lake, estimated0.187km²,881 connected certified-wet cells; potential-radius-only predecessor produced scattered blips and was rejected. Eight-metre control cut cap plus1.5m underwater polish; final262144 texels0 failures, observed core3.997/rim.899m. Complete23-output generation includes the whole lake and halo, regeneration243–266ms in first run; GPU field536712B/typed CPU366692B/water213424B. Known-anchor redundant-scan removal measured across four alternating complete runs (242.295 vs256.444ms medians, overlapping ranges; no full-gap attribution), identities and final height hash preserved. Detailed failed/successful/shared/cold/actual browser records are in the handoff and large-lakes/index.html. Default small-pocket behavior is retained. No50ms/river or low-end/cold readiness claim.


Increment27: distant constructed-river body colour uses the existing near-water body instead of transmitting dry coarse terrain. Continuous2600m-altitude coverage confirmed by ownership tint; no extra allocations. Four alternating real full-render rounds (480/mode): old14.5ms/p95 20.5, corrected14.4/p95 20.9, no measurable penalty. Complete native10-output regeneration medians old137.592/corrected134.095ms (4/mode); native workload does not render the colour, no attributed speedup. Same2568 river/49152 final-texel sampled contract checks pass, max incision22.964m/min final depth0.129m. Live32818544B/peak48087936B,0 GPU errors. Runtime300 tests/44 files. See handoff and mountain-river/distant-body-game|distant-body-cost|body-native. Whole-game low-end pools, streaming, cold compilation and global regional paging remain unsolved.


Increment28 retained: immutable macro-generation foundation shared only from the current generation with exact device/version/source/uniform/cells/seam/budget equality. Reference-counted ownership and final fences preserve failed/old inputs. Explicit regenerate:true remains FULL; regenerate:true,reuseFoundation:true rebuilds dependent features. Versionv12 keys change intentionally. Eight alternating equivalent complete10-output rounds: mountain full median146.038/shared131.979ms, all requested complete output textures per round byte-identical SHA88c5f6834e4331f2c08aad891a4b655ac6abea715b9740a4abe36b1f8becb537. Hash readback/audit is outside measured cost. Regional-rebuild peak48087936→33635520B (-13.78MiB); whole-workload peak48087936→45621728B (-2.35MiB), steady residency unchanged. Native gentle regression full135.621/shared113.643ms, byte-identical outputs/previous river records,0 errors. Real failed feature replacement preserves18496 old samples; changed terrain feature rebuilds and stale sampler rejects. Preatlas single-field sampler difference quantified max0.000366m (0 above1mm), not old/new SHA identity. Runtime305 tests/45 files. See handoff increment28 and mountain-river/foundation-cost|foundation-safety, coarse-river/foundation-regression. Cold compilation, streaming, global paging, low-end pools and50ms complete target remain unfinished.
