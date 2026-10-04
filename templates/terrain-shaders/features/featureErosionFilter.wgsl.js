// templates/terrain-shaders/features/featureErosionFilter.wgsl.js
//
// WGSL port of Rune Skovbo Johansen's Phacelle Noise and Advanced Terrain
// Erosion Filter ("stacked faded gullies"), plus a sphere variant for this
// cube-sphere planet.
//
//   https://blog.runevision.com/2026/03/fast-and-gorgeous-erosion-filter.html
//   https://www.youtube.com/watch?v=gsJHzBTPG0Y
//
// Phacelle Noise function copyright (c) 2025 Rune Skovbo Johansen
// Advanced Terrain Erosion Filter copyright (c) 2025 Rune Skovbo Johansen
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// This file (and only this file) is MPL-2.0; the rest of the project keeps
// its own licence.
//
// Differences from the original GLSL:
// - WGSL has no out parameters, so results are returned in structs.
// - The cell hash is a PCG integer hash on integer cell coordinates
//   (the original uses the Shadertoy's float hash), plus a seed.
// - Cells whose weight is zero (distance >= 1.5) skip the cos/sin; the
//   result is unchanged.
// - erosionFilterSphere: cells live on a 3-D lattice, and the stripes run in
//   the local tangent plane (sideDir = cross(up, gully direction)). Height
//   and slope are in metres and metres per metre; the slope is a 3-D tangent
//   vector. Nothing depends on cube faces, so there are no face seams.
//   normalSquash > 0 narrows each cell's weight across the tangent plane
//   (0 = isotropic 3-D cells).
//
// Not wired into terrain generation yet: see IMPLEMENTATION_PLAN.md B7
// (5.0-5.2 research prototype, go/no-go with the owner).

export function createTerrainFeatureErosionFilter() {
  return `
// ==================== Feature: erosion filter (RuneVision, MPL-2.0) ====================
// Phacelle Noise function copyright (c) 2025 Rune Skovbo Johansen
// Advanced Terrain Erosion Filter copyright (c) 2025 Rune Skovbo Johansen
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

const EROSION_TAU: f32 = 6.28318530717959;

struct ErosionParams {
    strength: f32,
    gullyWeight: f32,
    detail: f32,
    rounding: vec4<f32>,
    onset: vec4<f32>,
    assumedSlope: vec2<f32>,
    scale: f32,
    octaves: i32,
    lacunarity: f32,
    gain: f32,
    cellScale: f32,
    normalization: f32,
    normalSquash: f32,
    seed: i32,
}

fn erosionPcg3(v0: vec3<u32>) -> vec3<u32> {
    var v = v0 * 1664525u + 1013904223u;
    v.x += v.y * v.z;
    v.y += v.z * v.x;
    v.z += v.x * v.y;
    v = v ^ (v >> vec3<u32>(16u));
    v.x += v.y * v.z;
    v.y += v.z * v.x;
    v.z += v.x * v.y;
    return v;
}

// Per-cell random vector in [-1, 1)^3.
fn erosionHash3(c: vec3<i32>, seed: i32) -> vec3<f32> {
    let h = erosionPcg3(bitcast<vec3<u32>>(c) + vec3<u32>(bitcast<u32>(seed) * 2654435769u));
    return vec3<f32>(h >> vec3<u32>(8u)) * (2.0 / 16777216.0) - 1.0;
}

fn erosionHash2(c: vec2<i32>, seed: i32) -> vec2<f32> {
    return erosionHash3(vec3<i32>(c, 0), seed).xy;
}

fn erosionClamp01(t: f32) -> f32 { return clamp(t, 0.0, 1.0); }

fn erosionPowInv(t: f32, power: f32) -> f32 {
    // Flip, raise to the specified power, and flip back.
    let x = 1.0 - erosionClamp01(t);
    return 1.0 - select(pow(x, power), 0.0, x <= 0.0);
}

fn erosionEaseOut(t: f32) -> f32 {
    let v = 1.0 - erosionClamp01(t);
    return 1.0 - v * v;
}

fn erosionSmoothStart(t: f32, smoothing: f32) -> f32 {
    if (t >= smoothing) {
        return t - 0.5 * smoothing;
    }
    return 0.5 * t * t / smoothing;
}

fn erosionSafeNormalize2(n: vec2<f32>) -> vec2<f32> {
    let l = length(n);
    return select(n, n / l, abs(l) > 1e-10);
}

fn erosionSafeNormalize3(n: vec3<f32>) -> vec3<f32> {
    let l = length(n);
    return select(n, n / l, abs(l) > 1e-10);
}

// Simple Phacelle Noise: a stripe pattern aligned with normDir, from cosine
// and sine waves interpolated over 4x4 jittered cells.
// Returns (cos, sin) normalized, and sideDir (the derivative direction of the
// cosine, to be multiplied with the sine).
fn phacelleNoise2D(p: vec2<f32>, normDir: vec2<f32>, freq: f32, offset: f32, normalization: f32, seed: i32) -> vec4<f32> {
    let sideDir = vec2<f32>(-normDir.y, normDir.x) * freq * EROSION_TAU;
    let off = offset * EROSION_TAU;
    let pInt = floor(p);
    let pFrac = p - pInt;
    let cInt = vec2<i32>(pInt);
    var phaseDir = vec2<f32>(0.0);
    var weightSum = 0.0;
    for (var i = -1; i <= 2; i++) {
        for (var j = -1; j <= 2; j++) {
            let gridOffset = vec2<f32>(f32(i), f32(j));
            let randomOffset = erosionHash2(cInt + vec2<i32>(i, j), seed) * 0.5;
            let v = pFrac - gridOffset - randomOffset;
            let sqrDist = dot(v, v);
            // Bell-shaped weight, 1 at distance 0 and 0 from distance 1.5.
            let weight = max(0.0, exp(-sqrDist * 2.0) - 0.01111);
            if (weight > 0.0) {
                weightSum += weight;
                let waveInput = dot(v, sideDir) + off;
                phaseDir += vec2<f32>(cos(waveInput), sin(waveInput)) * weight;
            }
        }
    }
    let interpolated = phaseDir / max(weightSum, 1e-20);
    let magnitude = max(1.0 - normalization, sqrt(dot(interpolated, interpolated)));
    return vec4<f32>(interpolated / magnitude, sideDir);
}

struct Phacelle3 {
    cs: vec2<f32>,
    side: vec3<f32>,
}

// Phacelle Noise on a 3-D cell lattice; the stripes run perpendicular to
// cross(up, normDir) in the tangent plane at the evaluated point.
fn phacelleNoise3D(
    p: vec3<f32>, up: vec3<f32>, normDir: vec3<f32>,
    freq: f32, offset: f32, normalization: f32, normalSquash: f32, seed: i32
) -> Phacelle3 {
    let sideDir = cross(up, normDir) * freq * EROSION_TAU;
    let off = offset * EROSION_TAU;
    let pInt = floor(p);
    let pFrac = p - pInt;
    let cInt = vec3<i32>(pInt);
    var phaseDir = vec2<f32>(0.0);
    var weightSum = 0.0;
    for (var i = -1; i <= 2; i++) {
        for (var j = -1; j <= 2; j++) {
            for (var k = -1; k <= 2; k++) {
                let gridOffset = vec3<f32>(f32(i), f32(j), f32(k));
                let randomOffset = erosionHash3(cInt + vec3<i32>(i, j, k), seed) * 0.5;
                let v = pFrac - gridOffset - randomOffset;
                let vn = dot(v, up);
                let sqrDist = dot(v, v) + normalSquash * vn * vn;
                if (sqrDist >= 2.25) { continue; }
                let weight = max(0.0, exp(-sqrDist * 2.0) - 0.01111);
                weightSum += weight;
                let waveInput = dot(v, sideDir) + off;
                phaseDir += vec2<f32>(cos(waveInput), sin(waveInput)) * weight;
            }
        }
    }
    let interpolated = phaseDir / max(weightSum, 1e-20);
    let magnitude = max(1.0 - normalization, sqrt(dot(interpolated, interpolated)));
    var r: Phacelle3;
    r.cs = interpolated / magnitude;
    r.side = sideDir;
    return r;
}

struct ErosionResult2 {
    // x: height delta, yz: slope delta, w: magnitude (sum of octave strengths)
    delta: vec4<f32>,
    ridgeMap: f32,
    fadeTarget: f32,
}

// Faithful port of ErosionFilter for a planar domain. p and heights share
// units; heightAndSlope = (height, d/dx, d/dy).
fn erosionFilter2D(p: vec2<f32>, heightAndSlopeIn: vec3<f32>, fadeTargetIn: f32, prm: ErosionParams) -> ErosionResult2 {
    var strength = prm.strength * prm.scale;
    var fadeTarget = clamp(fadeTargetIn, -1.0, 1.0);
    var heightAndSlope = heightAndSlopeIn;
    var freq = 1.0 / (prm.scale * prm.cellScale);
    let slopeLength = max(length(heightAndSlope.yz), 1e-10);
    var magnitude = 0.0;
    var roundingMult = 1.0;

    let roundingForInput = mix(prm.rounding.y, prm.rounding.x, erosionClamp01(fadeTarget + 0.5)) * prm.rounding.z;
    var combiMask = erosionEaseOut(erosionSmoothStart(slopeLength * prm.onset.x, roundingForInput * prm.onset.x));

    var ridgeMapCombiMask = erosionEaseOut(slopeLength * prm.onset.z);
    var ridgeMapFadeTarget = fadeTarget;

    var gullySlope = mix(heightAndSlope.yz, heightAndSlope.yz / slopeLength * prm.assumedSlope.x, prm.assumedSlope.y);

    for (var i = 0; i < prm.octaves; i++) {
        var phacelle = phacelleNoise2D(p * freq, erosionSafeNormalize2(gullySlope), prm.cellScale, 0.25, prm.normalization, prm.seed);
        phacelle = vec4<f32>(phacelle.xy, phacelle.zw * -freq);
        let sloping = abs(phacelle.y);

        gullySlope += sign(phacelle.y) * phacelle.zw * strength * prm.gullyWeight;

        let gullies = vec3<f32>(phacelle.x, phacelle.y * phacelle.zw);
        let fadedGullies = mix(vec3<f32>(fadeTarget, 0.0, 0.0), gullies * prm.gullyWeight, combiMask);
        heightAndSlope += fadedGullies * strength;
        magnitude += strength;

        fadeTarget = fadedGullies.x;

        let roundingForOctave = mix(prm.rounding.y, prm.rounding.x, erosionClamp01(phacelle.x + 0.5)) * roundingMult;
        let newMask = erosionEaseOut(erosionSmoothStart(sloping * prm.onset.y, roundingForOctave * prm.onset.y));
        combiMask = erosionPowInv(combiMask, prm.detail) * newMask;

        ridgeMapFadeTarget = mix(ridgeMapFadeTarget, gullies.x, ridgeMapCombiMask);
        let newRidgeMapMask = erosionEaseOut(sloping * prm.onset.w);
        ridgeMapCombiMask = ridgeMapCombiMask * newRidgeMapMask;

        strength *= prm.gain;
        freq *= prm.lacunarity;
        roundingMult *= prm.rounding.w;
    }

    var r: ErosionResult2;
    r.delta = vec4<f32>(heightAndSlope - heightAndSlopeIn, magnitude);
    r.ridgeMap = ridgeMapFadeTarget * (1.0 - ridgeMapCombiMask);
    r.fadeTarget = fadeTarget;
    return r;
}

struct ErosionResultSphere {
    heightDelta: f32,
    // Tangent-plane slope delta (metres per metre).
    slopeDelta: vec3<f32>,
    magnitude: f32,
    ridgeMap: f32,
    fadeTarget: f32,
    // The mask applied to the first octave (0 on flat input, 1 on slopes).
    initialMask: f32,
    // Coefficient of the initial fade target in heightDelta:
    // sum_i strength_i * prod_{j<=i} (1 - mask_j). heightDelta minus
    // fadeTargetIn * initialFadeWeight is the gully structure alone.
    initialFadeWeight: f32,
}

// ErosionFilter on the sphere. posM: point in metres (unitDir * radius),
// up: unitDir, slopeIn: tangent gradient of heightIn (metres per metre).
fn erosionFilterSphere(
    posM: vec3<f32>, up: vec3<f32>, heightIn: f32, slopeIn: vec3<f32>,
    fadeTargetIn: f32, prm: ErosionParams
) -> ErosionResultSphere {
    var strength = prm.strength * prm.scale;
    var fadeTarget = clamp(fadeTargetIn, -1.0, 1.0);
    var height = heightIn;
    var slope = slopeIn;
    var freq = 1.0 / (prm.scale * prm.cellScale);
    let slopeLength = max(length(slopeIn), 1e-10);
    var magnitude = 0.0;
    var roundingMult = 1.0;

    let roundingForInput = mix(prm.rounding.y, prm.rounding.x, erosionClamp01(fadeTarget + 0.5)) * prm.rounding.z;
    var combiMask = erosionEaseOut(erosionSmoothStart(slopeLength * prm.onset.x, roundingForInput * prm.onset.x));
    let initialMask = combiMask;
    var fadeProduct = 1.0;
    var initialFadeWeight = 0.0;

    var ridgeMapCombiMask = erosionEaseOut(slopeLength * prm.onset.z);
    var ridgeMapFadeTarget = fadeTarget;

    var gullySlope = mix(slopeIn, slopeIn / slopeLength * prm.assumedSlope.x, prm.assumedSlope.y);

    for (var i = 0; i < prm.octaves; i++) {
        let ph = phacelleNoise3D(posM * freq, up, erosionSafeNormalize3(gullySlope),
            prm.cellScale, 0.25, prm.normalization, prm.normalSquash, prm.seed);
        let side = ph.side * -freq;
        let sloping = abs(ph.cs.y);

        gullySlope += sign(ph.cs.y) * side * strength * prm.gullyWeight;

        let gullyH = ph.cs.x;
        let gullyS = ph.cs.y * side;
        let fadedH = mix(fadeTarget, gullyH * prm.gullyWeight, combiMask);
        let fadedS = gullyS * prm.gullyWeight * combiMask;
        fadeProduct *= 1.0 - combiMask;
        initialFadeWeight += strength * fadeProduct;
        height += fadedH * strength;
        slope += fadedS * strength;
        magnitude += strength;

        fadeTarget = fadedH;

        let roundingForOctave = mix(prm.rounding.y, prm.rounding.x, erosionClamp01(gullyH + 0.5)) * roundingMult;
        let newMask = erosionEaseOut(erosionSmoothStart(sloping * prm.onset.y, roundingForOctave * prm.onset.y));
        combiMask = erosionPowInv(combiMask, prm.detail) * newMask;

        ridgeMapFadeTarget = mix(ridgeMapFadeTarget, gullyH, ridgeMapCombiMask);
        ridgeMapCombiMask = ridgeMapCombiMask * erosionEaseOut(sloping * prm.onset.w);

        strength *= prm.gain;
        freq *= prm.lacunarity;
        roundingMult *= prm.rounding.w;
    }

    var r: ErosionResultSphere;
    r.heightDelta = height - heightIn;
    r.slopeDelta = slope - slopeIn;
    r.magnitude = magnitude;
    r.ridgeMap = ridgeMapFadeTarget * (1.0 - ridgeMapCombiMask);
    r.fadeTarget = fadeTarget;
    r.initialMask = initialMask;
    r.initialFadeWeight = initialFadeWeight;
    return r;
}

// The demo's default parameters (RuneVision Shadertoy), with scale in the
// caller's length unit.
fn erosionDefaultParams(scale: f32, seed: i32) -> ErosionParams {
    var prm: ErosionParams;
    prm.strength = 0.22;
    prm.gullyWeight = 0.5;
    prm.detail = 1.5;
    prm.rounding = vec4<f32>(0.1, 0.0, 0.1, 2.0);
    prm.onset = vec4<f32>(1.25, 1.25, 2.8, 1.5);
    prm.assumedSlope = vec2<f32>(0.7, 1.0);
    prm.scale = scale;
    prm.octaves = 5;
    prm.lacunarity = 2.0;
    prm.gain = 0.5;
    prm.cellScale = 0.7;
    prm.normalization = 0.5;
    prm.normalSquash = 0.0;
    prm.seed = seed;
    return prm;
}
`;
}
