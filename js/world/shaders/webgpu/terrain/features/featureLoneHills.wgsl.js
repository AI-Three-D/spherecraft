// js/world/shaders/webgpu/terrain/features/featureLoneHills.wgsl.js
//
// Isolated hill features placed additively on any land terrain.
// Five rarity tiers with shape variety (not just size scaling).
//
// CRITICAL: Single-noise approach — the SAME noise value drives both
// placement (threshold) and height (dome shape).  This prevents the
// ring / snake artifacts caused by multiplying two uncorrelated noise fields.
//
// Heights defined in METERS, converted at runtime via maxTerrainHeightM().

export function createTerrainFeatureLoneHills() {
    return `
  // ==================== Feature: Lone Hills & Rolling Hills ====================
  
  // ---- Shape profiles ----
  
  fn loneHillDome(noise: f32, threshold: f32) -> f32 {

      // Smooth dome from thresholded noise.  Returns 0..1 height.
      // Extended base starts 0.08 noise-units below threshold for gentle foothills.
      // Quintic smoothstep (C2 continuous) eliminates normal seams at the hill base.
      let extend = 0.08;
      let base = threshold - extend;
      let t = (noise - base) / max(1.0 - base, 0.001);
      if (t <= 0.0) { return 0.0; }
      let c = clamp(t, 0.0, 1.0);
      return c * c * c * (c * (c * 6.0 - 15.0) + 10.0);
  }
  
  fn loneHillWithCrater(noise: f32, threshold: f32, craterNoise: f32) -> f32 {
      return 0.0; // THIS METHOD IS BROKEN. WE WILL FIX LATER!
  
  }
  fn loneHillMesa01(x: f32, threshold01: f32) -> f32 {
    // x in 0..1. Mesa: steep sides + flat top.
    let extend = 0.25; // in 0..1 space
    let base = threshold01 - extend;
    let t = (x - base) / max(1.0 - base, 1e-4);
    if (t <= 0.0) { return 0.0; }
    let c = clamp(t, 0.0, 1.0);
    let q = c * c * c * (c * (c * 6.0 - 15.0) + 10.0);
    return pow(q, 0.55);
}

fn loneHillMesaOrganic01(x01: f32, edgeJitter: f32, skirtJitter: f32) -> f32 {
    // Jitters are in 0..1-ish space; keep small.
    let core = loneHillMesa01(clamp(x01 + edgeJitter, 0.0, 1.0), 0.40);

    // Skirt: subtle foothills; helps blend into surrounding terrain.
    let skirt = loneHillDome(clamp(x01 + skirtJitter * 0.6, 0.0, 1.0), 0.28) * 0.22;

    // Smooth union prevents the ring/ledge at blend boundary.
    return smoothMax(core, skirt, 0.08);
}

  
  // ---- Main height function ----
  
  fn featureLoneHillsHeight(
      wx: f32, wy: f32, unitDir: vec3<f32>, seed: i32,
      regional: RegionalInfo, profile: TerrainProfile, amp: TerrainAmplitudes
  ) -> f32 {
      let hillAmp = amp.loneHillsHeight;
      if (hillAmp < 0.001) { return 0.0; }
  
      let maxH = maxTerrainHeightM();
  
      // === Regional modulation ===
      let densityNoise = fbmAuto(wx, wy, unitDir,
          clampMacroScaleToPlanet(SCALE_LONE_HILL_DENSITY), 3, seed + 4000, 2.0, 0.5);
      let densityMod = smoothstep(-0.35, 0.35, densityNoise);
  
      let sizeNoise = fbmAuto(wx, wy, unitDir,
          clampMacroScaleToPlanet(SCALE_LONE_HILL_SIZE_VAR), 3, seed + 4050, 2.0, 0.5);
      let sizeMod = 0.7 + 0.6 * smoothstep(-0.3, 0.4, sizeNoise);
  
      let flatSuppression = smoothstep(0.06, 0.22, regional.terrainType);
      let commonMod = mix(0.08, 1.0, flatSuppression) * mix(0.25, 1.0, densityMod);
  
      var totalHeight: f32 = 0.0;
  
      // ================================================================
      //  Tier 1 — COMMON  (round domes, ~20–60 m visible)
      // ================================================================
      {
          // A) Primary domes (800 m wavelength)
          let n1 = fbmAuto(wx, wy, unitDir, SCALE_LONE_HILL_SMALL, 1, seed + 4100, 2.0, 0.5);
          let bump1 = loneHillDome(n1, 0.15);
  
          // B) Wider gentle rolls (1.6 km wavelength, subdued)
          let n2 = fbmAuto(wx, wy, unitDir, SCALE_LONE_HILL_SMALL * 2.0, 1, seed + 4120, 2.0, 0.5);
          let bump2 = loneHillDome(n2, 0.12);
  
          let bump = bump1 * 0.7 + bump2 * 0.3;
          totalHeight += bump * (HEIGHT_LONE_HILL_COMMON / maxH) * sizeMod * commonMod * hillAmp;
      }
  
      // ================================================================
      //  Tier 2 — UNCOMMON  (round domes, ~50–120 m visible)
      // ================================================================
      {
          let n = fbmAuto(wx, wy, unitDir, SCALE_LONE_HILL_MEDIUM, 1, seed + 4200, 2.0, 0.5);
          let bump = loneHillDome(n, 0.30);
          totalHeight += bump * (HEIGHT_LONE_HILL_UNCOMMON / maxH) * sizeMod * commonMod * hillAmp;
      }
  
      // ================================================================
      //  Tier 3 — RARE  (mini volcano, ~100–250 m visible)
      // ================================================================
      {
          let n = fbmAuto(wx, wy, unitDir, SCALE_LONE_HILL_LARGE, 1, seed + 4300, 2.0, 0.5);
          if (n > 0.30) {
              let craterN = fbmAuto(wx, wy, unitDir,
                  SCALE_LONE_HILL_LARGE * 0.15, 2, seed + 4320, 2.0, 0.5);
              let bump = loneHillWithCrater(n, 0.45, craterN * 0.5 + 0.5);
              let rareMod = mix(0.3, 1.0, flatSuppression) * sizeMod;
              totalHeight += bump * (HEIGHT_LONE_HILL_RARE / maxH) * rareMod * hillAmp;
          }
      }
// ================================================================
//  Tier 4 — VERY RARE  (irregular round dome + cuts, ~200–500 m visible)
// ================================================================
{
    // Use the SAME noise field for placement+shape (like your other tiers),
    // but warp the domain so the hill footprint isn't a clean blob.
    let w = wavelength_m(SCALE_LONE_HILL_HUGE, GEOLOGY_SCALE);
    let p = warpFlatAuto(wx, wy, unitDir, SCALE_LONE_HILL_HUGE * 0.45, w * 0.08, seed + 4390);

    // Base hill noise (single octave keeps it round-ish)
    let n = fbmAuto(p.x, p.y, unitDir, SCALE_LONE_HILL_HUGE, 1, seed + 4400, 2.0, 0.5);

    // Presence mask (smooth, no seams)
    let presence = smoothstep(0.28, 0.42, n);

    if (presence > 0.001) {
        // Edge irregularity: only influences near the base / threshold zone
        let edgeN = fbmAuto(p.x, p.y, unitDir, SCALE_LONE_HILL_HUGE * 0.22, 2, seed + 4413, 2.0, 0.5);
        let n2 = irregularizeNoiseNearBase(n, 0.42, edgeN, 0.10);

        // Main dome (slightly higher threshold than common tiers)
        var h = loneHillDome(n2, 0.42);

        // Cuts/crevices: ridged-ish noise on slope band
        let cutN = fbmAuto(p.x, p.y, unitDir, SCALE_LONE_HILL_HUGE * 0.10, 3, seed + 4421, 2.2, 0.55);
        h = applySlopeCuts(h, cutN, 0.18);

        totalHeight += h * presence
            * (HEIGHT_LONE_HILL_VERY_RARE / maxH) * sizeMod * hillAmp;
    }
}

  // ================================================================
//  Tier 5 — EXCEPTIONAL  (two-peak landmark, rough edges + cuts)
// ================================================================
{
    let w = wavelength_m(SCALE_LONE_HILL_LANDMARK, GEOLOGY_SCALE);

    // Two slightly different warps -> two nearby lobes/peaks, still coherent
    let pA = warpFlatAuto(wx, wy, unitDir, SCALE_LONE_HILL_LANDMARK * 0.40, w * 0.09, seed + 4490);
    let pB = warpFlatAuto(wx, wy, unitDir, SCALE_LONE_HILL_LANDMARK * 0.40, w * 0.09, seed + 4491);

    // Same octave count (1) keeps each lobe round
    let nA = fbmAuto(pA.x, pA.y, unitDir, SCALE_LONE_HILL_LANDMARK, 1, seed + 4500, 2.0, 0.5);
    let nB = fbmAuto(pB.x, pB.y, unitDir, SCALE_LONE_HILL_LANDMARK, 1, seed + 4501, 2.0, 0.5);

    // Very rare presence based on the *stronger* lobe (still single-field-ish)
    let nMax = max(nA, nB);
    let presence = smoothstep(0.34, 0.48, nMax);

    if (presence > 0.001) {
        // Irregularize both lobes near their base thresholds (different edge noise seeds)
        let edgeA = fbmAuto(pA.x, pA.y, unitDir, SCALE_LONE_HILL_LANDMARK * 0.20, 2, seed + 4513, 2.0, 0.5);
        let edgeB = fbmAuto(pB.x, pB.y, unitDir, SCALE_LONE_HILL_LANDMARK * 0.20, 2, seed + 4514, 2.0, 0.5);

        let nA2 = irregularizeNoiseNearBase(nA, 0.48, edgeA, 0.12);
        let nB2 = irregularizeNoiseNearBase(nB, 0.48, edgeB, 0.12);

        let hA = loneHillDome(nA2, 0.48);
        let hB = loneHillDome(nB2, 0.48);

        // Two-peak blend creates a saddle sometimes, but still looks like one feature
        var h = twoPeakBlend(hA, hB);

        // Cuts on mid-slope (shared cut noise so cuts "flow" across both lobes)
        let cutN = fbmAuto(wx, wy, unitDir, SCALE_LONE_HILL_LANDMARK * 0.09, 3, seed + 4521, 2.2, 0.55);
        h = applySlopeCuts(h, cutN, 0.22);

        // Optional subtle roughness (kept from your old code idea)
        let detail = fbmAuto(wx, wy, unitDir, SCALE_LONE_HILL_LANDMARK * 0.07, 3, seed + 4570, 2.0, 0.5);
        h *= (1.0 + detail * 0.10);

        totalHeight += h * presence
            * (HEIGHT_LONE_HILL_EXCEPTIONAL / maxH) * hillAmp;
    }
}


{


    // 1) Make rolling hills less common (event-like regions)
    let rollMask = rarityMaskAuto(
        wx, wy, unitDir,
        clampMacroScaleToPlanet(SCALE_ROLLING_HILL_DENSITY),
        seed + 5000,
        RARITY_UNCOMMON,      // change to RARITY_RARE if still too common
        profile.rareBoost
    );

    // Prefer moderately hilly terrain, suppress on ultra-flat
    let rollTerrainMod = smoothstep(0.03, 0.18, regional.terrainType);

    let rollingPresence = rollMask * rollTerrainMod;

    if (rollingPresence > 0.01) {
        // 2) Slight warp so paths aren't clean isolines
        let wPath = wavelength_m(SCALE_ROLLING_HILL_PATH, GEOLOGY_SCALE);
        let pw = warpFlatAuto(wx, wy, unitDir, SCALE_ROLLING_HILL_PATH * 0.7, wPath * 0.06, seed + 5057);

        // 3) Build a smooth distance-to-path field (NO abs/min seams)
        let pathN1 = fbmAuto(pw.x, pw.y, unitDir, SCALE_ROLLING_HILL_PATH, 2, seed + 5050, 2.0, 0.5);
        let pathN2 = fbmAuto(pw.x, pw.y, unitDir, SCALE_ROLLING_HILL_PATH * 0.70, 2, seed + 5060, 2.0, 0.5);

        let kAbs = 0.02; // smoothing in noise-value space (0.01..0.04)
        let d1 = smoothAbs(pathN1, kAbs);
        let d2 = smoothAbs(pathN2, kAbs);

        let kMin = 0.04; // smooth switch between the two path layers (0.02..0.06)
        let pathDist = smoothMin(d1, d2, kMin);

        // 4) Vary chain width along the path so it isn't a uniform ribbon
        let widthN = fbmAuto(pw.x, pw.y, unitDir, SCALE_ROLLING_HILL_PATH * 0.35, 2, seed + 5067, 2.0, 0.5);
        let width = mix(0.16, 0.30, smoothstep(-0.4, 0.4, widthN)); // noise-space width

        // 5) Rounded ridge envelope (C2 smooth), everywhere continuous
        let r = 1.0 - pathDist / max(width, 1e-4);
        let c = clamp(r, 0.0, 1.0);
        let envelope = c * c * c * (c * (c * 6.0 - 15.0) + 10.0);

        // 6) "Beads on a string": break the ridge into rounded lumps
        // Use a low-frequency modulation that does NOT use a hard threshold.
        let beadN = fbmAuto(pw.x, pw.y, unitDir, SCALE_ROLLING_HILL_BUMP * 1.35, 2, seed + 5108, 2.0, 0.5);
        let beads = smoothstep(-0.15, 0.65, beadN); // 0..1

        // Additional smaller modulation for variety (still smooth)
        let bumpN = fbmAuto(wx, wy, unitDir, SCALE_ROLLING_HILL_BUMP, 2, seed + 5100, 2.0, 0.5);
        let bumps = smoothstep(-0.2, 0.7, bumpN); // 0..1

        // Combine: envelope defines the corridor; beads define the hill lumps.
        // Keep a baseline so it's not a flat ridge with holes.
        let lump = (0.30 + 0.70 * beads) * (0.55 + 0.45 * bumps);

        // Slightly tighten the core so it reads as a sequence of hills, not a berm
        let corridor = pow(envelope, 1.25);

        let h = corridor * lump;

        totalHeight += h * rollingPresence
            * (HEIGHT_ROLLING_HILLS / maxH) * sizeMod * hillAmp;
    }
}
      return totalHeight;
  }
  
  // ==================== Lone Hills Surface ====================
  
  fn featureLoneHillsSurface(
      wx: f32, wy: f32, unitDir: vec3<f32>, seed: i32,
      slope: f32, elevation: f32,
      profile: TerrainProfile,
      featureWeight: f32
  ) -> SurfaceWeights {
      var weights = zeroSurfaceWeights();
      if (featureWeight < 0.01) { return weights; }
  
      let grassBase = slopeGrassWeight(slope);
      let grassNoise = fbmAuto(wx, wy, unitDir, SCALE_LONE_HILL_SMALL * 0.4, 2, seed + 4800, 2.0, 0.5);
      weights.grass = grassBase * (0.8 + 0.2 * smoothstep(0.3, 0.6, grassNoise)) * featureWeight;
  
      let rockChance = smoothstep(0.35, 0.6, slope);
      let rockNoise = fbmAuto(wx, wy, unitDir, SCALE_LONE_HILL_MEDIUM * 0.3, 2, seed + 4810, 2.0, 0.5);
      weights.rock = rockChance * smoothstep(0.4, 0.7, rockNoise) * featureWeight * 0.6;
  
      let dirtBase = slopeDirtWeight(slope);
      weights.dirt = dirtBase * featureWeight * 0.3;
  
      return weights;
  }
  `;
  }
  