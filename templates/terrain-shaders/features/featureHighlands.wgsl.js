// js/world/shaders/webgpu/terrain/features/featureHighlands.wgsl.js
//
// Highland / plateau features: irregular elevated regions that rise
// gradually to a higher altitude.  The transition steepness is modulated
// by terrain roughness — steeper in rough areas, gentler in smooth ones.
//
// Five rarity tiers from common (40–60 m, 2–10 km) to exceptional
// (800 m, 50+ km).  Heights in METERS, planet-independent.

export function createTerrainFeatureHighlands() {
  return `
// ==================== Feature: Highlands ====================

// Height and gradient as dual numbers vec4(value, d/d unitDir) (sphere).

fn highlandProfile_d(noise: vec4<f32>, threshold: f32, roughness: vec4<f32>) -> vec4<f32> {
    let t = (noise - dConst(threshold)) / max(1.0 - threshold, 0.001);
    if (t.x <= 0.0) { return dConst(0.0); }
    let c = dClamp(t, 0.0, 1.0);
    let transWidth = dMix(dConst(0.50), dConst(0.12), dClamp(roughness, 0.0, 1.0));
    let x = dClamp(dDiv(c, transWidth), 0.0, 1.0);
    return dQuintic(x);
}

// One highland tier: gated noise, plateau rise, plateau undulation.
fn highlandTier_d(
    unitDir: vec3<f32>, scale: f32, seed: i32, gate: f32, threshold: f32,
    plateauScale: f32, plateauOctaves: i32, base: f32, wobble: f32,
    roughness: vec4<f32>, heightNorm: f32
) -> vec4<f32> {
    let n = fbmAuto_d(unitDir, scale, 2, seed, 2.0, 0.5);
    if (n.x <= gate) { return dConst(0.0); }
    let rise = highlandProfile_d(n, threshold, roughness);
    let plateauNoise = fbmAuto_d(unitDir, plateauScale, plateauOctaves, seed + 20, 2.0, 0.5);
    let h = dMul(rise, dConst(base) + plateauNoise * wobble);
    return h * heightNorm;
}

// Highland plateaus, five rarity tiers (sphere).
fn featureHighlandsHeight_d(
    unitDir: vec3<f32>, seed: i32,
    regional: RegionalInfoD, profile: TerrainProfile, amp: TerrainAmplitudes
) -> vec4<f32> {
    let highAmp = amp.highlandsHeight;
    if (highAmp < 0.001) { return dConst(0.0); }

    let maxH = maxTerrainHeightM();
    let roughness = dSmoothMax(regional.terrainType, regional.ruggedness * 0.5, 0.02);

    var totalHeight = dConst(0.0);
    totalHeight += highlandTier_d(unitDir, SCALE_HIGHLAND_COMMON, seed + 6000, 0.0, 0.15,
        SCALE_HIGHLAND_COMMON * 0.2, 2, 0.9, 0.1, roughness, HEIGHT_HIGHLAND_COMMON / maxH) * highAmp;
    totalHeight += highlandTier_d(unitDir, SCALE_HIGHLAND_UNCOMMON, seed + 6100, 0.10, 0.30,
        SCALE_HIGHLAND_UNCOMMON * 0.15, 2, 0.92, 0.08, roughness, HEIGHT_HIGHLAND_UNCOMMON / maxH) * highAmp;
    totalHeight += highlandTier_d(unitDir, clampMacroScaleToPlanet(SCALE_HIGHLAND_RARE), seed + 6200, 0.25, 0.45,
        SCALE_HIGHLAND_RARE * 0.12, 2, 0.93, 0.07, roughness, HEIGHT_HIGHLAND_RARE / maxH) * highAmp;
    totalHeight += highlandTier_d(unitDir, clampMacroScaleToPlanet(SCALE_HIGHLAND_VERY_RARE), seed + 6300, 0.35, 0.55,
        SCALE_HIGHLAND_VERY_RARE * 0.10, 2, 0.94, 0.06, roughness, HEIGHT_HIGHLAND_VERY_RARE / maxH) * highAmp;
    totalHeight += highlandTier_d(unitDir, clampMacroScaleToPlanet(SCALE_HIGHLAND_EXCEPTIONAL), seed + 6400, 0.45, 0.65,
        SCALE_HIGHLAND_EXCEPTIONAL * 0.08, 3, 0.95, 0.05, roughness, HEIGHT_HIGHLAND_EXCEPTIONAL / maxH) * highAmp;
    return totalHeight;
}
`;
}
