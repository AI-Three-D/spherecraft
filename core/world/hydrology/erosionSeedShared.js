// core/world/hydrology/erosionSeedShared.js
//
// Single source of truth for the erosion-seed lake/pit constants and the
// PCG hash used to place and shape them — shared between the WGSL terrain
// carve (featureErosionSeeds.wgsl.js, values interpolated into the shader
// text at bundle-assembly time) and JS-side consumers that need the exact
// same candidate geometry (ErosionSeedVerifier.js's retention check,
// LakeWaterSystem's mesh generation). Previously these were duplicated by
// hand across WGSL and JS with "must match X exactly" comments — real risk
// of silent drift as more consumers get added; this removes that risk by
// construction instead of relying on comments staying accurate.

import { Vector3 } from '../../../shared/math/index.js';

export const EROSION_REGION_SIZE_M = 500.0;

// TEMP DEBUG VISIBILITY: bumped way up from the real values (30m/2m) so
// candidates are impossible to miss while confirming the system end to
// end. Revert to 30.0/2.0 once confirmed visually.
export const EROSION_NUDGE_RADIUS_M = 90.0;
export const EROSION_NUDGE_DEPTH_M = 40.0;

// Crude, level-1 admissibility — see featureErosionSeeds.wgsl.js's own
// header comment for what this is (and isn't) checking.
export const EROSION_RUGGEDNESS_MAX = 0.6;

export const EROSION_SIZE_FACTOR_MIN = 0.6;
export const EROSION_SIZE_FACTOR_MAX = 1.4;

// Outline irregularity via real spatial noise (fbmAuto, the same domain-
// warping noise primitive the rest of terrain generation uses), sampled at
// each pixel's own world position and subtracted from its distance to the
// candidate — NOT a function of angle around the candidate center. An
// angle-based sine-harmonic version was tried first and produced a
// rotationally-symmetric "flower/clover" outline (confirmed live, low
// integer harmonics like sin(3*angle) are inherently periodic-symmetric no
// matter how they're phase/amplitude-randomized) — spatial noise doesn't
// have that problem since it isn't built from a periodic function of
// angle at all.
//
// Wavelength and amplitude are both expressed as a fraction of the
// candidate's own (already-scaled) nudge radius, so the "bumpiness" scales
// naturally with lake size instead of needing separate tuning whenever
// EROSION_NUDGE_RADIUS_M's debug/real value changes.
export const EROSION_BLOB_NOISE_SCALE_FACTOR = 0.4;
export const EROSION_BLOB_NOISE_AMPLITUDE_FACTOR = 0.35;
export const EROSION_BLOB_AMP_FACTOR_MIN = 0.5;
export const EROSION_BLOB_AMP_FACTOR_MAX = 1.5;

// Cheap-reject distance margin: the noise can add up to ~AMPLITUDE_FACTOR
// extra reach in some directions, so the reject cutoff has to stay wider
// than the base radius to avoid clipping real bumps.
export const EROSION_BLOB_REJECT_MARGIN = 1.5;

export const EROSION_HASH_SALT_POSITION = 9000;
export const EROSION_HASH_SALT_SHAPE = 9500;
export const EROSION_BLOB_NOISE_SEED_OFFSET = 9600;

// PCG-style integer hash, bit-for-bit matching the WGSL erosionSeedHash4
// (bitcast<u32>, not u32() value-conversion — matters for negative region
// coordinates). Math.imul + `>>> 0` replicates WGSL's u32 wraparound
// multiplication exactly.
export function erosionSeedHash4(ix, iy, salt) {
    const imul = (a, b) => Math.imul(a, b) >>> 0;
    let x = (imul(ix, 374761393) + imul(iy, 668265263) + imul(salt, 2246822519)) >>> 0;
    x = imul((x ^ (x >>> 13)) >>> 0, 1274126177) >>> 0;
    x = (x ^ (x >>> 16)) >>> 0;
    const a = (x & 0xFFFF) / 65535;
    x = (imul(x, 747796405) + 2891336453) >>> 0;
    x = imul((x ^ (x >>> 13)) >>> 0, 1274126177) >>> 0;
    x = (x ^ (x >>> 16)) >>> 0;
    const b = (x & 0xFFFF) / 65535;
    x = (imul(x, 747796405) + 2891336453) >>> 0;
    x = imul((x ^ (x >>> 13)) >>> 0, 1274126177) >>> 0;
    x = (x ^ (x >>> 16)) >>> 0;
    const c = (x & 0xFFFF) / 65535;
    x = (imul(x, 747796405) + 2891336453) >>> 0;
    x = imul((x ^ (x >>> 13)) >>> 0, 1274126177) >>> 0;
    x = (x ^ (x >>> 16)) >>> 0;
    const d = (x & 0xFFFF) / 65535;
    return [a, b, c, d];
}

// Full per-candidate geometry for region (regionX, regionY), mirroring
// featureErosionSeedsHeight()'s WGSL exactly: jittered position, base size
// factor, and the blob-irregularity amplitude factor. Does NOT apply the
// Stage-2 confirmed upgrade multiplier — callers that need the upgraded
// size apply that scale on top themselves (it isn't known until after
// verification).
export function computeErosionCandidateGeometry({ regionX, regionY, seed, refPos, refRight, refForward }) {
    const h = erosionSeedHash4(regionX, regionY, seed + EROSION_HASH_SALT_POSITION);
    const hShape = erosionSeedHash4(regionX, regionY, seed + EROSION_HASH_SALT_SHAPE);

    const jx = (regionX + 0.25 + h[0] * 0.5) * EROSION_REGION_SIZE_M;
    const jy = (regionY + 0.25 + h[1] * 0.5) * EROSION_REGION_SIZE_M;
    const pos = new Vector3(refPos.x, refPos.y, refPos.z)
        .add(new Vector3(refRight.x, refRight.y, refRight.z).multiplyScalar(jx))
        .add(new Vector3(refForward.x, refForward.y, refForward.z).multiplyScalar(jy));

    const sizeFactor = EROSION_SIZE_FACTOR_MIN + (EROSION_SIZE_FACTOR_MAX - EROSION_SIZE_FACTOR_MIN) * h[2];
    const nudgeRadiusM = EROSION_NUDGE_RADIUS_M * sizeFactor;
    const nudgeDepthM = EROSION_NUDGE_DEPTH_M * sizeFactor;

    // How bumpy this lake's outline is, randomized per candidate (some
    // nearly round, some quite irregular) — the WGSL carve applies this on
    // top of fbmAuto's own spatial noise; the JS approximation below
    // (erosionBlobRadiusAt) applies it the same way to its own noise.
    const blobAmpFactor = EROSION_BLOB_AMP_FACTOR_MIN + (EROSION_BLOB_AMP_FACTOR_MAX - EROSION_BLOB_AMP_FACTOR_MIN) * hShape[1];

    return { regionX, regionY, pos, jx, jy, sizeFactor, nudgeRadiusM, nudgeDepthM, blobAmpFactor };
}

// Cheap 2D value noise (own small implementation — same spirit as
// RIVER_WGSL_NOISE's noise2, not a port of it) used only by
// erosionBlobRadiusAt below.
function hash2(x, y) {
    const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
    return n - Math.floor(n);
}
function valueNoise2D(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const a = hash2(xi, yi), b = hash2(xi + 1, yi);
    const c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

// Outline radius at a given angle around the candidate's own center — a JS
// approximation of the WGSL carve's shape, NOT a bit-exact match: the real
// carve (featureErosionSeedsHeight()) warps distance using fbmAuto sampled
// at each pixel's actual world position, the same domain-warping noise the
// rest of terrain generation uses, which isn't practically portable to JS
// without reimplementing that whole noise library. This samples a simple
// standalone value-noise field on a unit circle instead (avoids a seam at
// angle=0/2pi), which gives a comparably irregular, non-symmetric outline
// at roughly the right scale — close enough for the water mesh, which
// sits inset from the carve's edge anyway (see LakeWaterSystem's
// FILL_FRACTION) so an exact match was never required.
export function erosionBlobRadiusAt(geom, angle, radiusScaleMultiplier = 1.0) {
    const effRadius = geom.nudgeRadiusM * radiusScaleMultiplier;
    const noiseFreq = 1.0 / Math.max(EROSION_BLOB_NOISE_SCALE_FACTOR * effRadius, 1e-3);
    const nx = Math.cos(angle) * noiseFreq + geom.jx * 0.01;
    const ny = Math.sin(angle) * noiseFreq + geom.jy * 0.01;
    const n = valueNoise2D(nx, ny) * 2 - 1;
    const amp = EROSION_BLOB_NOISE_AMPLITUDE_FACTOR * effRadius * geom.blobAmpFactor;
    return effRadius + n * amp;
}
