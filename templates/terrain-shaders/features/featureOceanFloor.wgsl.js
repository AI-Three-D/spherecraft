export function createOceanFloorWgsl(oceanShelves) {
    return `
fn oceanFloorHeight_d(dir: vec3<f32>, seed: i32, oceanDepth: f32) -> vec4<f32> {
    let basin = dConst(uniforms.waterParams.y + oceanDepth);
    if (!terrainFeatureOn(TF_OCEAN_FLOOR)) { return basin; }
    ${oceanShelves ? `
    // Broad abyssal hills, with smaller relief along the floor.
    let abyss = fbmAuto_d(dir, 32.0, 2, seed + 1000, 2.0, 0.5);
    let hills = fbmAuto_d(dir, 4.8, 2, seed + 2000, 2.0, 0.5);
    let detail = fbmAuto_d(dir, 0.75, 1, seed + 3000, 2.0, 0.5);
    // Keep the same amplitude envelope as the legacy floor for terrain bounds.
    return basin + (abyss * 0.055 + hills * 0.017 + detail * 0.003);
    ` : `
    let n500m = fbmAuto_d(dir, 0.5, 4, seed + 1000, 2.0, 0.5);
    let n100m = fbmAuto_d(dir, 0.1, 4, seed + 2000, 2.0, 0.5);
    let n20m = fbmAuto_d(dir, 0.02, 3, seed + 3000, 2.0, 0.5);
    return basin + (n500m * 0.05 + n100m * 0.02 + n20m * 0.005);
    `}
}

${oceanShelves ? `
fn oceanShelfHeight_d(ground: vec4<f32>, landMask: vec4<f32>) -> vec4<f32> {
    let depth = dConst(uniforms.waterParams.y) - ground;
    if (depth.x <= 0.0 || landMask.x <= 0.015 || !terrainFeatureOn(TF_OCEAN_FLOOR)) { return ground; }
    // A continental rise leads up to the shallower shelf. Ease into the
    // lift with zero first derivative at sea level so it cannot move the
    // height field's shoreline or introduce a crease there.
    let rise = dSmoothstep(0.015, 0.14, landMask) * 0.28;
    let shelf = dSmoothstep(0.14, 0.32, landMask) * 0.47;
    let knee = 140.0 / maxTerrainHeightM();
    let transition = dClamp(depth, 0.0, knee);
    let liftableDepth = depth - transition + dMul(transition, transition) * (0.5 / knee);
    return ground + dMul(liftableDepth, rise + shelf);
}
` : ''}
`;
}
