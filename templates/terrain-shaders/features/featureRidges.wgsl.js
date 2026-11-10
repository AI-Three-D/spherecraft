// js/world/shaders/webgpu/terrain/features/featureRidges.wgsl.js
//
// PLACEHOLDER — not wired up yet.
// Ridge features: elongated, snake-like terrain forms that create
// natural-looking ridge lines, hogbacks, and linear escarpments.
//
// These patterns arise naturally from multiplying a rarity mask (blob-shaped
// regions from thresholded noise) with a SEPARATE height noise at the same
// scale. The interference between the two uncorrelated noise fields produces
// ring-like and serpentine shapes that are ideal for ridges.
//
// When activated, this feature should use additive composition and
// be controlled by its own amplitude field in TerrainAmplitudes.

export function createTerrainFeatureRidges() {
  return `
// ==================== Feature: Ridges (PLACEHOLDER) ====================
// Uncomment and wire up when ready to enable ridge terrain.

// fn featureRidgesHeight(
//     wx: f32, wy: f32, unitDir: vec3<f32>, seed: i32,
//     regional: RegionalInfo, profile: TerrainProfile, amp: TerrainAmplitudes
// ) -> f32 {
//     // Ridge approach: rarity mask × separate height noise creates
//     // natural serpentine / ring patterns perfect for ridges.
//
//     var totalHeight: f32 = 0.0;
//     let maxH = maxTerrainHeightM();
//
//     // === Small ridges (2-4 km long, 50-150 m tall) ===
//     {
//         let mask = rarityMaskAuto(wx, wy, unitDir,
//             2.5, seed + 6200, RARITY_UNCOMMON, profile.rareBoost);
//         if (mask > 0.01) {
//             let n = fbmAuto(wx, wy, unitDir, 2.5, 2, seed + 6250, 2.0, 0.5);
//             let ridge = smoothstep(0.1, 0.5, n) * mask;
//             totalHeight += ridge * (200.0 / maxH);
//         }
//     }
//
//     // === Major ridges (8-15 km long, 200-500 m tall) ===
//     {
//         let mask = countBasedRarityMask(wx, wy, unitDir,
//             8.0, seed + 6300, 5000.0, profile.rareBoost);
//         if (mask > 0.01) {
//             var wDir = unitDir;
//             if (uniforms.face >= 0) {
//                 wDir = warpDirAuto(unitDir, 4.0, 0.15, seed + 6320);
//             }
//             let n = fbmAuto(wx, wy, wDir, 8.0, 3, seed + 6350, 2.0, 0.45);
//             let ridge = smoothstep(0.1, 0.5, n) * mask;
//             totalHeight += ridge * (500.0 / maxH);
//         }
//     }
//
//     return totalHeight;
// }
`;
}
