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
  // Height and gradient as dual numbers vec4(value, d/d unitDir) (sphere).

  fn loneHillDome_d(noise: vec4<f32>, threshold: f32) -> vec4<f32> {
      let extend = 0.08;
      let base = threshold - extend;
      let t = (noise - dConst(base)) / max(1.0 - base, 0.001);
      if (t.x <= 0.0) { return dConst(0.0); }
      return dQuintic(dClamp(t, 0.0, 1.0));
  }

  fn irregularizeNoiseNearBase_d(n: vec4<f32>, threshold: f32, edgeN: vec4<f32>, strength: f32) -> vec4<f32> {
      let band = dConst(1.0) - dSmoothstep(0.0, 0.20, dAbs(n - dConst(threshold)));
      return n + dMul(edgeN * strength, band);
  }

  fn twoPeakBlend_d(a: vec4<f32>, b: vec4<f32>) -> vec4<f32> {
      let k = 0.10;
      let m = dMax(a, b);
      let d = dAbs(a - b);
      let t = dSmoothstep(0.0, k, d);
      return dMix((a + b) * 0.5, m, t);
  }

  // Tier groups for featureLoneHillsHeight_d's parts mask. (Tier 3, the
  // crater, was never implemented.)
  const LONE_HILLS_SMALL: u32 = 1u;    // tiers 1-2: common and uncommon domes
  const LONE_HILLS_BIG: u32 = 2u;      // tiers 4-5: very rare dome, landmark
  const LONE_HILLS_ROLLING: u32 = 4u;  // rolling hill chains
  const LONE_HILLS_ALL: u32 = 7u;

  fn featureLoneHillsHeight_d(
      unitDir: vec3<f32>, seed: i32,
      regional: RegionalInfoD, profile: TerrainProfile, amp: TerrainAmplitudes,
      parts: u32
  ) -> vec4<f32> {
      let hillAmp = amp.loneHillsHeight;
      if (hillAmp < 0.001) { return dConst(0.0); }

      let maxH = maxTerrainHeightM();

      let densityNoise = fbmAuto_d(unitDir, clampMacroScaleToPlanet(SCALE_LONE_HILL_DENSITY), 3, seed + 4000, 2.0, 0.5);
      let densityMod = dSmoothstep(-0.35, 0.35, densityNoise);
      let sizeNoise = fbmAuto_d(unitDir, clampMacroScaleToPlanet(SCALE_LONE_HILL_SIZE_VAR), 3, seed + 4050, 2.0, 0.5);
      let sizeMod = dConst(0.7) + dSmoothstep(-0.3, 0.4, sizeNoise) * 0.6;

      let flatSuppression = dSmoothstep(0.06, 0.22, regional.terrainType);
      let commonMod = dMul(dMix(dConst(0.08), dConst(1.0), flatSuppression), dMix(dConst(0.25), dConst(1.0), densityMod));

      var totalHeight = dConst(0.0);

      // Tier 1 — common domes
      if ((parts & LONE_HILLS_SMALL) != 0u && terrainFeatureOn(TF_LONE_HILLS_COMMON)) {
          let n1 = fbmAuto_d(unitDir, SCALE_LONE_HILL_SMALL, 1, seed + 4100, 2.0, 0.5);
          let bump1 = loneHillDome_d(n1, 0.15);
          let n2 = fbmAuto_d(unitDir, SCALE_LONE_HILL_SMALL * 2.0, 1, seed + 4120, 2.0, 0.5);
          let bump2 = loneHillDome_d(n2, 0.12);
          let bump = bump1 * 0.7 + bump2 * 0.3;
          totalHeight += dMul(dMul(bump * (HEIGHT_LONE_HILL_COMMON / maxH), sizeMod), commonMod) * hillAmp;
      }

      // Tier 2 — uncommon domes
      if ((parts & LONE_HILLS_SMALL) != 0u && terrainFeatureOn(TF_LONE_HILLS_UNCOMMON)) {
          let n = fbmAuto_d(unitDir, SCALE_LONE_HILL_MEDIUM, 1, seed + 4200, 2.0, 0.5);
          let bump = loneHillDome_d(n, 0.30);
          totalHeight += dMul(dMul(bump * (HEIGHT_LONE_HILL_UNCOMMON / maxH), sizeMod), commonMod) * hillAmp;
      }

      // Tier 4 — very rare irregular dome with cuts
      if ((parts & LONE_HILLS_BIG) != 0u && terrainFeatureOn(TF_LONE_HILLS_VERY_RARE)) {
          let n = fbmAuto_d(unitDir, SCALE_LONE_HILL_HUGE, 1, seed + 4400, 2.0, 0.5);
          let presence = dSmoothstep(0.28, 0.42, n);
          if (presence.x > 0.001) {
              let edgeN = fbmAuto_d(unitDir, SCALE_LONE_HILL_HUGE * 0.22, 2, seed + 4413, 2.0, 0.5);
              let n2 = irregularizeNoiseNearBase_d(n, 0.42, edgeN, 0.10);
              let h = loneHillDome_d(n2, 0.42);
              let presenceW = dGateRamp(presence, 0.001);
              totalHeight += dMul(dMul(h, presenceW) * (HEIGHT_LONE_HILL_VERY_RARE / maxH), sizeMod) * hillAmp;
          }
      }

      // Tier 5 — exceptional two-peak landmark
      if ((parts & LONE_HILLS_BIG) != 0u && terrainFeatureOn(TF_LONE_HILLS_LANDMARK)) {
          let nA = fbmAuto_d(unitDir, SCALE_LONE_HILL_LANDMARK, 1, seed + 4500, 2.0, 0.5);
          let nB = fbmAuto_d(unitDir, SCALE_LONE_HILL_LANDMARK, 1, seed + 4501, 2.0, 0.5);
          let nMax = dSmoothMax(nA, nB, 0.03);
          let presence = dSmoothstep(0.34, 0.48, nMax);
          if (presence.x > 0.001) {
              let edgeA = fbmAuto_d(unitDir, SCALE_LONE_HILL_LANDMARK * 0.20, 2, seed + 4513, 2.0, 0.5);
              let edgeB = fbmAuto_d(unitDir, SCALE_LONE_HILL_LANDMARK * 0.20, 2, seed + 4514, 2.0, 0.5);
              let nA2 = irregularizeNoiseNearBase_d(nA, 0.48, edgeA, 0.12);
              let nB2 = irregularizeNoiseNearBase_d(nB, 0.48, edgeB, 0.12);
              let hA = loneHillDome_d(nA2, 0.48);
              let hB = loneHillDome_d(nB2, 0.48);
              let h = twoPeakBlend_d(hA, hB);
              let presenceW = dGateRamp(presence, 0.001);
              totalHeight += dMul(h, presenceW) * (HEIGHT_LONE_HILL_EXCEPTIONAL / maxH) * hillAmp;
          }
      }

      // Rolling hill chains
      if ((parts & LONE_HILLS_ROLLING) != 0u && terrainFeatureOn(TF_ROLLING_HILLS)) {
          let rollMask = rarityMaskAuto_d(
              unitDir,
              clampMacroScaleToPlanet(SCALE_ROLLING_HILL_DENSITY),
              seed + 5000,
              RARITY_UNCOMMON,
              profile.rareBoost
          );
          let rollTerrainMod = dSmoothstep(0.03, 0.18, regional.terrainType);
          let rollingPresence = dMul(rollMask, rollTerrainMod);
          if (rollingPresence.x > 0.01) {
              let pathN1 = fbmAuto_d(unitDir, SCALE_ROLLING_HILL_PATH, 2, seed + 5050, 2.0, 0.5);
              let pathN2 = fbmAuto_d(unitDir, SCALE_ROLLING_HILL_PATH * 0.70, 2, seed + 5060, 2.0, 0.5);
              let d1 = dSmoothAbs(pathN1, 0.02);
              let d2 = dSmoothAbs(pathN2, 0.02);
              let pathDist = dSmoothMin(d1, d2, 0.04);
              let widthN = fbmAuto_d(unitDir, SCALE_ROLLING_HILL_PATH * 0.35, 2, seed + 5067, 2.0, 0.5);
              // Corridor width in path-noise units. 0.16-0.30 made chains a few
              // hundred metres wide but up to ~300 m tall: steep walls and
              // narrow gaps between parallel chains that read as trenches.
              let width = dMix(dConst(0.35), dConst(0.60), dSmoothstep(-0.4, 0.4, widthN));
              let r = dConst(1.0) - dDiv(pathDist, vec4<f32>(max(width.x, 1e-4), width.yzw));
              let envelope = dQuintic(dClamp(r, 0.0, 1.0));
              let beadN = fbmAuto_d(unitDir, SCALE_ROLLING_HILL_BUMP * 1.35, 2, seed + 5108, 2.0, 0.5);
              let beads = dSmoothstep(-0.15, 0.65, beadN);
              let bumpN = fbmAuto_d(unitDir, SCALE_ROLLING_HILL_BUMP, 2, seed + 5100, 2.0, 0.5);
              let bumps = dSmoothstep(-0.2, 0.7, bumpN);
              let lump = dMul(dConst(0.30) + beads * 0.70, dConst(0.55) + bumps * 0.45);
              let corridor = dPow(envelope, 1.25);
              let h = dMul(corridor, lump);
              let presenceW = dGateRamp(rollingPresence, 0.01);
              totalHeight += dMul(dMul(h, presenceW) * (HEIGHT_ROLLING_HILLS / maxH), sizeMod) * hillAmp;
          }
      }
      return totalHeight;
  }

  // ==================== Lone Hills Surface ====================
  
  `;
  }
  