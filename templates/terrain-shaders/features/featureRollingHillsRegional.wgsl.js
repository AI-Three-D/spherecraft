export const regionalRollingHillsWgsl = `
// Broad, regionally gated rolling relief.
fn featureRollingHillsHeight_d(
    unitDir: vec3<f32>, seed: i32,
    regional: RegionalInfoD, profile: TerrainProfile, amp: TerrainAmplitudes
) -> vec4<f32> {
    if (amp.loneHillsHeight < 0.001 || !terrainFeatureOn(TF_ROLLING_HILLS)) { return dConst(0.0); }
    let regionN = fbmAuto_d(unitDir, 30.0, 2, seed + 5000, 2.0, 0.5);
    let presence = dSmoothstep(-0.40, -0.05, regionN);
    if (presence.x <= 0.0) { return dConst(0.0); }
    let broad = fbmAuto_d(unitDir, 3.8, 2, seed + 5070, 2.0, 0.48);
    let detail = fbmAuto_d(unitDir, 1.25, 2, seed + 5091, 2.0, 0.5);
    let form = broad * 0.80 + detail * 0.20 + dConst(0.28);
    return dMul(presence, form) * (HEIGHT_ROLLING_HILLS * 1.4 / maxTerrainHeightM()) * amp.loneHillsHeight;
}
`;
