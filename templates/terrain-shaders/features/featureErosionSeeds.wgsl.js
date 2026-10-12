// templates/terrain-shaders/features/featureErosionSeeds.wgsl.js
//
// Stage 1 of the river/lake system: deterministic, always-on, stateless
// placement of small "erosion seed" pits across the planet — no precompute,
// no CPU involvement, just a per-pixel hash + a crude land/ruggedness gate +
// a small radial carve. This is the level-1 heuristic from the river/lake
// design:
// crude, cheap, and — importantly — its own output *is* the permanent
// fallback shape for a seed that never gets upgraded to a real lake/river
// by a later (not yet built) verification pass. Nothing extra is needed for
// that fallback case; this feature already produces it.
//
// Not modeled on featureLoneHillsHeight()'s continuous-noise-threshold
// scatter, even though that's this codebase's existing convention for
// scattered features: a later verification pass needs to enumerate and walk
// from *specific points* (to check a lake basin, trace a river's spillway),
// which a continuous field can't give you. A discrete, hashed grid of
// candidate positions is what makes that possible later, so that's what
// this uses even though it departs from the LoneHills pattern.
//
// Region size, gate thresholds, and the nudge's own size all come from
// core/world/hydrology/erosionSeedShared.js — the single source of truth
// shared with ErosionSeedVerifier.js and LakeWaterSystem.js, interpolated
// into this WGSL text at bundle-assembly time so the shader, the Stage-2
// verifier, and the water mesh generator can never silently drift apart.
// Rough, early proof-of-concept numbers — meant to be tuned once visible.

import {
  EROSION_REGION_SIZE_M, EROSION_NUDGE_RADIUS_M, EROSION_NUDGE_DEPTH_M,
  EROSION_WALL_RADIUS_FRACTION, EROSION_RIM_BOOST_FRACTION,
  EROSION_RUGGEDNESS_MAX, EROSION_SIZE_FACTOR_MIN, EROSION_SIZE_FACTOR_MAX,
  EROSION_BLOB_NOISE_SCALE_FACTOR, EROSION_BLOB_NOISE_AMPLITUDE_FACTOR,
  EROSION_BLOB_AMP_FACTOR_MIN, EROSION_BLOB_AMP_FACTOR_MAX,
  EROSION_BLOB_REJECT_MARGIN, EROSION_HASH_SALT_POSITION, EROSION_HASH_SALT_SHAPE,
  EROSION_BLOB_NOISE_SEED_OFFSET,
} from '../../../core/world/hydrology/erosionSeedShared.js';

export function createTerrainFeatureErosionSeeds() {
  return `
// ==================== Feature: Erosion Seeds (stage 1: nudge only) ========

const EROSION_REGION_SIZE_M: f32 = ${EROSION_REGION_SIZE_M.toFixed(1)};
const EROSION_NUDGE_RADIUS_M: f32 = ${EROSION_NUDGE_RADIUS_M.toFixed(1)};
const EROSION_NUDGE_DEPTH_M: f32 = ${EROSION_NUDGE_DEPTH_M.toFixed(1)};
const EROSION_WALL_RADIUS_FRACTION: f32 = ${EROSION_WALL_RADIUS_FRACTION.toFixed(2)};
const EROSION_RIM_BOOST_FRACTION: f32 = ${EROSION_RIM_BOOST_FRACTION.toFixed(2)};

// Crude, level-1 admissibility: not "would this hold water" (that's the
// refined, humidity-aware retention check in ErosionSeedVerifier.js/
// erosionSeedVerify.wgsl.js) — just "is this a physically sane place to
// even try a nudge at all". No hard humidity cutoff here anymore: a dry
// area can still get a small fallback pit (real deserts have arroyos/
// playas), it just won't clear the refined retention margin to become a
// real lake.
const EROSION_RUGGEDNESS_MAX: f32 = ${EROSION_RUGGEDNESS_MAX.toFixed(2)};

// Per-candidate random size variety (level-1 idea: some nudges are wider/
// deeper than others even before any Stage-2 upgrade), independent of
// whether Stage 2 later confirms and further upgrades this candidate.
const EROSION_SIZE_FACTOR_MIN: f32 = ${EROSION_SIZE_FACTOR_MIN.toFixed(2)};
const EROSION_SIZE_FACTOR_MAX: f32 = ${EROSION_SIZE_FACTOR_MAX.toFixed(2)};

// Outline irregularity via real spatial noise (fbmAuto — the same domain-
// warping noise primitive the rest of terrain generation uses), NOT a
// function of angle around the candidate center. An angle-based sine-
// harmonic version was tried first and produced a rotationally-symmetric
// "flower/clover" outline (confirmed live — low integer harmonics like
// sin(3*angle) are inherently periodic-symmetric no matter how they're
// phase/amplitude-randomized); spatial noise sampled at each pixel's own
// world position doesn't have that problem.
const EROSION_BLOB_NOISE_SCALE_FACTOR: f32 = ${EROSION_BLOB_NOISE_SCALE_FACTOR.toFixed(3)};
const EROSION_BLOB_NOISE_AMPLITUDE_FACTOR: f32 = ${EROSION_BLOB_NOISE_AMPLITUDE_FACTOR.toFixed(3)};
const EROSION_BLOB_AMP_FACTOR_MIN: f32 = ${EROSION_BLOB_AMP_FACTOR_MIN.toFixed(2)};
const EROSION_BLOB_AMP_FACTOR_MAX: f32 = ${EROSION_BLOB_AMP_FACTOR_MAX.toFixed(2)};

// Cheap integer hash (PCG-style mix), four independent-ish outputs per
// (regionX, regionY, salt) — deterministic, no external state, same
// reproducibility guarantee the rest of procedural generation relies on.
fn erosionSeedHash4(ix: i32, iy: i32, salt: i32) -> vec4<f32> {
    // bitcast, not u32(...): the latter is a *value* conversion in WGSL
    // (unspecified/clamped for negative inputs, confirmed live — it throws
    // a shader-creation error for a literal negative, and silently produces
    // wrong results for a runtime negative i32), not the two's-complement
    // bit-reinterpretation a hash function needs. Region coordinates are
    // negative on roughly half the planet, including the area around the
    // demo spawn, so this wasn't an edge case.
    var x = bitcast<u32>(ix) * 374761393u + bitcast<u32>(iy) * 668265263u + bitcast<u32>(salt) * 2246822519u;
    x = (x ^ (x >> 13u)) * 1274126177u;
    x = x ^ (x >> 16u);
    let a = f32(x & 0xFFFFu) / 65535.0;
    x = x * 747796405u + 2891336453u;
    x = (x ^ (x >> 13u)) * 1274126177u;
    x = x ^ (x >> 16u);
    let b = f32(x & 0xFFFFu) / 65535.0;
    x = x * 747796405u + 2891336453u;
    x = (x ^ (x >> 13u)) * 1274126177u;
    x = x ^ (x >> 16u);
    let c = f32(x & 0xFFFFu) / 65535.0;
    x = x * 747796405u + 2891336453u;
    x = (x ^ (x >> 13u)) * 1274126177u;
    x = x ^ (x >> 16u);
    let d = f32(x & 0xFFFFu) / 65535.0;
    return vec4<f32>(a, b, c, d);
}

// Height and gradient (dual) of the erosion-seed pits (sphere). Candidate
// selection uses value-only regional gating; the gradient follows the
// distance to the chosen candidate and the boundary noise.
fn featureErosionSeedsHeight_d(
    unitDir: vec3<f32>, seed: i32,
    regional: RegionalInfoD, profile: TerrainProfile, amp: TerrainAmplitudes
) -> vec4<f32> {
    if (uniforms.riverAnchor.w < 0.5) { return dConst(0.0); }

    let R = noiseReferenceRadiusM();
    let refDir = normalize(uniforms.riverAnchor.xyz);
    let refForward = normalize(uniforms.riverChannelDir.xyz);
    let refRight = cross(refDir, refForward);

    let refPos = refDir * R;
    let realPos = unitDir * R;
    let delta = realPos - refPos;
    let localX = dot(delta, refRight);
    let localZ = dot(delta, refForward);

    let regionX = i32(floor(localX / EROSION_REGION_SIZE_M));
    let regionY = i32(floor(localZ / EROSION_REGION_SIZE_M));

    var bestDist: f32 = 1e18;
    var found = false;
    var bestRadiusScale: f32 = 1.0;
    var bestDepthScale: f32 = 1.0;
    var bestBlobAmpFactor: f32 = 1.0;
    var bestJx: f32 = 0.0;
    var bestJy: f32 = 0.0;

    const BLOB_REJECT_MARGIN: f32 = ${EROSION_BLOB_REJECT_MARGIN.toFixed(2)};

    for (var dy = -1; dy <= 1; dy = dy + 1) {
        for (var dx = -1; dx <= 1; dx = dx + 1) {
            let rx = regionX + dx;
            let ry = regionY + dy;
            let h = erosionSeedHash4(rx, ry, seed + ${EROSION_HASH_SALT_POSITION});
            let hShape = erosionSeedHash4(rx, ry, seed + ${EROSION_HASH_SALT_SHAPE});
            let blobAmpFactor = mix(EROSION_BLOB_AMP_FACTOR_MIN, EROSION_BLOB_AMP_FACTOR_MAX, hShape.y);
            let jx = (f32(rx) + 0.25 + h.x * 0.5) * EROSION_REGION_SIZE_M;
            let jy = (f32(ry) + 0.25 + h.y * 0.5) * EROSION_REGION_SIZE_M;
            let sizeFactor = mix(EROSION_SIZE_FACTOR_MIN, EROSION_SIZE_FACTOR_MAX, h.z);
            var radiusScale: f32 = sizeFactor;
            var depthScale: f32 = sizeFactor;
            for (var ci = 0; ci < uniforms.erosionConfirmedCount; ci = ci + 1) {
                let entry = uniforms.erosionConfirmed[ci];
                if (i32(entry.x) == rx && i32(entry.y) == ry) {
                    radiusScale = radiusScale * entry.z;
                    depthScale = depthScale * entry.w;
                }
            }
            let dist = distance(vec2<f32>(localX, localZ), vec2<f32>(jx, jy));
            if (dist > EROSION_NUDGE_RADIUS_M * radiusScale * BLOB_REJECT_MARGIN) { continue; }
            let candPos = refPos + refRight * jx + refForward * jy;
            let candDir = normalize(candPos);
            let candRegional = getRegionalCharacter(candDir.x, candDir.z, candDir, seed, profile);
            if (!candRegional.isLand) { continue; }
            if (candRegional.ruggedness > EROSION_RUGGEDNESS_MAX) { continue; }
            if (dist < bestDist) {
                bestDist = dist;
                found = true;
                bestRadiusScale = radiusScale;
                bestDepthScale = depthScale;
                bestBlobAmpFactor = blobAmpFactor;
                bestJx = jx;
                bestJy = jy;
            }
        }
    }

    if (!found) { return dConst(0.0); }

    // d(localX)/d(unitDir) = R refRight, d(localZ)/d(unitDir) = R refForward.
    let distGrad = ((localX - bestJx) * refRight + (localZ - bestJy) * refForward) * (R / max(bestDist, 1e-3));
    let bestDistD = vec4<f32>(bestDist, distGrad);

    let effRadius = EROSION_NUDGE_RADIUS_M * bestRadiusScale;
    let noiseScaleKm = max(effRadius * EROSION_BLOB_NOISE_SCALE_FACTOR, 1.0) / 1000.0;
    let boundaryNoise = fbmAuto_d(unitDir, noiseScaleKm, 3, seed + ${EROSION_BLOB_NOISE_SEED_OFFSET}, 2.0, 0.5);
    let warpedDist = bestDistD - boundaryNoise * effRadius * EROSION_BLOB_NOISE_AMPLITUDE_FACTOR * bestBlobAmpFactor;

    let wallRadius = effRadius * EROSION_WALL_RADIUS_FRACTION;
    let basinT = dClamp(warpedDist / wallRadius, 0.0, 1.0);
    let basinShape = dConst(1.0) - dMul(basinT, basinT);
    let normalizedDepth = (EROSION_NUDGE_DEPTH_M * bestDepthScale) / max(maxTerrainHeightM(), 1.0);
    var h = basinShape * (-normalizedDepth);

    let rimT = dClamp((warpedDist - dConst(wallRadius)) / max(effRadius - wallRadius, 1.0), 0.0, 1.0);
    let rimShape = dSin(rimT * 3.14159265);
    h = h + rimShape * (normalizedDepth * EROSION_RIM_BOOST_FRACTION);

    return h;
}
`;
}
