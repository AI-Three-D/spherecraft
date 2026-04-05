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

fn highlandProfile(noise: f32, threshold: f32, roughness: f32) -> f32 {
    // Plateau shape: flat base → gradual rise → flat top.
    // Transition width depends on roughness:
    //   smooth (0) → wide transition (gentle slope)
    //   rough  (1) → narrow transition (steep escarpment)
    let t = (noise - threshold) / max(1.0 - threshold, 0.001);
    if (t <= 0.0) { return 0.0; }
    let c = clamp(t, 0.0, 1.0);
    let transWidth = mix(0.50, 0.12, clamp(roughness, 0.0, 1.0));
    let x = clamp(c / transWidth, 0.0, 1.0);
    // Quintic smoothstep for C2 continuity (no normal seam at plateau edge).
    return x * x * x * (x * (x * 6.0 - 15.0) + 10.0);
}

fn featureHighlandsHeight(
    wx: f32, wy: f32, unitDir: vec3<f32>, seed: i32,
    regional: RegionalInfo, profile: TerrainProfile, amp: TerrainAmplitudes
) -> f32 {
    let highAmp = amp.highlandsHeight;
    if (highAmp < 0.001) { return 0.0; }

    let maxH = maxTerrainHeightM();
    let roughness = max(regional.terrainType, regional.ruggedness * 0.5);

    var totalHeight: f32 = 0.0;

    // ================================================================
    //  Tier 1 — COMMON  (40–60 m elevation, 2–10 km spread)
    //  2-octave noise for irregular borders, threshold 0.15 → ~25 % coverage.
    // ================================================================
    {
        let n = fbmAuto(wx, wy, unitDir, SCALE_HIGHLAND_COMMON, 2, seed + 6000, 2.0, 0.5);
        if (n > 0.0) {
            let rise = highlandProfile(n, 0.15, roughness);
            // Slight undulation on the plateau so it's not perfectly flat
            let plateauNoise = fbmAuto(wx, wy, unitDir,
                SCALE_HIGHLAND_COMMON * 0.2, 2, seed + 6020, 2.0, 0.5);
            let h = rise * (0.9 + 0.1 * plateauNoise);
            totalHeight += h * (HEIGHT_HIGHLAND_COMMON / maxH) * highAmp;
        }
    }

    // ================================================================
    //  Tier 2 — UNCOMMON  (120 m elevation, ~12 km spread)
    // ================================================================
    {
        let n = fbmAuto(wx, wy, unitDir, SCALE_HIGHLAND_UNCOMMON, 2, seed + 6100, 2.0, 0.5);
        if (n > 0.10) {
            let rise = highlandProfile(n, 0.30, roughness);
            let plateauNoise = fbmAuto(wx, wy, unitDir,
                SCALE_HIGHLAND_UNCOMMON * 0.15, 2, seed + 6120, 2.0, 0.5);
            let h = rise * (0.92 + 0.08 * plateauNoise);
            totalHeight += h * (HEIGHT_HIGHLAND_UNCOMMON / maxH) * highAmp;
        }
    }

    // ================================================================
    //  Tier 3 — RARE  (250 m elevation, ~25 km spread)
    // ================================================================
    {
        let n = fbmAuto(wx, wy, unitDir,
            clampMacroScaleToPlanet(SCALE_HIGHLAND_RARE), 2, seed + 6200, 2.0, 0.5);
        if (n > 0.25) {
            let rise = highlandProfile(n, 0.45, roughness);
            let plateauNoise = fbmAuto(wx, wy, unitDir,
                SCALE_HIGHLAND_RARE * 0.12, 2, seed + 6220, 2.0, 0.5);
            let h = rise * (0.93 + 0.07 * plateauNoise);
            totalHeight += h * (HEIGHT_HIGHLAND_RARE / maxH) * highAmp;
        }
    }

    // ================================================================
    //  Tier 4 — VERY RARE  (500 m elevation, ~45 km spread)
    // ================================================================
    {
        let n = fbmAuto(wx, wy, unitDir,
            clampMacroScaleToPlanet(SCALE_HIGHLAND_VERY_RARE), 2, seed + 6300, 2.0, 0.5);
        if (n > 0.35) {
            let rise = highlandProfile(n, 0.55, roughness);
            let plateauNoise = fbmAuto(wx, wy, unitDir,
                SCALE_HIGHLAND_VERY_RARE * 0.10, 2, seed + 6320, 2.0, 0.5);
            let h = rise * (0.94 + 0.06 * plateauNoise);
            totalHeight += h * (HEIGHT_HIGHLAND_VERY_RARE / maxH) * highAmp;
        }
    }

    // ================================================================
    //  Tier 5 — EXCEPTIONAL  (800 m elevation, ~70 km spread)
    //  Massive elevated regions, rare on the planet.
    // ================================================================
    {
        let n = fbmAuto(wx, wy, unitDir,
            clampMacroScaleToPlanet(SCALE_HIGHLAND_EXCEPTIONAL), 2, seed + 6400, 2.0, 0.5);
        if (n > 0.45) {
            let rise = highlandProfile(n, 0.65, roughness);
            let plateauNoise = fbmAuto(wx, wy, unitDir,
                SCALE_HIGHLAND_EXCEPTIONAL * 0.08, 3, seed + 6420, 2.0, 0.5);
            let h = rise * (0.95 + 0.05 * plateauNoise);
            totalHeight += h * (HEIGHT_HIGHLAND_EXCEPTIONAL / maxH) * highAmp;
        }
    }

    return totalHeight;
}
`;
}
