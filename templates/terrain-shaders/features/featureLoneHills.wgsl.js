// js/world/shaders/webgpu/terrain/features/featureLoneHills.wgsl.js
//
// Isolated hill features placed additively on any land terrain: the very
// rare irregular dome (10 km), the two-peak landmark massif (18 km), and
// rolling hill chains.
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

  // Quintic ramp (C2): the erosion filter orients its gullies along the
  // landform's gradient, so a curvature jump in the landform (smoothstep is
  // only C1) becomes a crease in the eroded terrain - here a seam around the
  // landmark's lower slopes, where the two peaks' heights differ by k.
  fn twoPeakBlend_d(a: vec4<f32>, b: vec4<f32>) -> vec4<f32> {
      let k = 0.10;
      let m = dMax(a, b);
      let d = dAbs(a - b);
      let t = dQuintic(dClamp(d * (1.0 / k), 0.0, 1.0));
      return dMix((a + b) * 0.5, m, t);
  }

  // Regional size modulation, 0.7 .. 1.3 (very rare dome, rolling chains).
  fn loneHillSizeMod_d(unitDir: vec3<f32>, seed: i32) -> vec4<f32> {
      let sizeNoise = fbmAuto_d(unitDir, clampMacroScaleToPlanet(SCALE_LONE_HILL_SIZE_VAR), 3, seed + 4050, 2.0, 0.5);
      return dConst(0.7) + dSmoothstep(-0.3, 0.4, sizeNoise) * 0.6;
  }

  // Big lone hills, part of the eroded landform: the very rare dome and the
  // landmark.
  fn featureBigHillsHeight_d(unitDir: vec3<f32>, seed: i32, amp: TerrainAmplitudes) -> vec4<f32> {
      let hillAmp = amp.loneHillsHeight;
      if (hillAmp < 0.001) { return dConst(0.0); }

      let maxH = maxTerrainHeightM();
      var totalHeight = dConst(0.0);

      // Very rare irregular dome with cuts
      if (terrainFeatureOn(TF_LONE_HILLS_VERY_RARE)) {
          let n = fbmAuto_d(unitDir, SCALE_LONE_HILL_HUGE, 1, seed + 4400, 2.0, 0.5);
          let presence = dSmoothstep(0.28, 0.42, n);
          if (presence.x > 0.001) {
              let edgeN = fbmAuto_d(unitDir, SCALE_LONE_HILL_HUGE * 0.22, 2, seed + 4413, 2.0, 0.5);
              let n2 = irregularizeNoiseNearBase_d(n, 0.42, edgeN, 0.10);
              let h = loneHillDome_d(n2, 0.42);
              let presenceW = dGateRamp(presence, 0.001);
              totalHeight += dMul(dMul(h, presenceW) * (HEIGHT_LONE_HILL_VERY_RARE / maxH), loneHillSizeMod_d(unitDir, seed)) * hillAmp;
          }
      }

      // Exceptional two-peak landmark
      if (terrainFeatureOn(TF_LONE_HILLS_LANDMARK)) {
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
      return totalHeight;
  }

  // Rolling hill chains (added after erosion).
  fn featureRollingHillsHeight_d(
      unitDir: vec3<f32>, seed: i32,
      regional: RegionalInfoD, profile: TerrainProfile, amp: TerrainAmplitudes
  ) -> vec4<f32> {
      let hillAmp = amp.loneHillsHeight;
      if (hillAmp < 0.001 || !terrainFeatureOn(TF_ROLLING_HILLS)) { return dConst(0.0); }

      let rollMask = rarityMaskAuto_d(
          unitDir,
          clampMacroScaleToPlanet(SCALE_ROLLING_HILL_DENSITY),
          seed + 5000,
          RARITY_UNCOMMON,
          profile.rareBoost
      );
      let rollTerrainMod = dSmoothstep(0.03, 0.18, regional.terrainType);
      let rollingPresence = dMul(rollMask, rollTerrainMod);
      if (rollingPresence.x <= 0.01) { return dConst(0.0); }

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
      return dMul(dMul(h, presenceW) * (HEIGHT_ROLLING_HILLS / maxTerrainHeightM()), loneHillSizeMod_d(unitDir, seed)) * hillAmp;
  }

  // ==================== Lone Hills Surface ====================

  `;
  }
