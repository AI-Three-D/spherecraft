export const coastalHillsWgsl = `
fn coastalHillsHeight_d(unitDir: vec3<f32>, seed: i32, regional: RegionalInfoD) -> vec4<f32> {
    // A broken belt of coastal hills. Shapes are deliberately unsaturated so
    // peaks and shoulders stay rounded without becoming flat-topped plateaus.
    let coastalBelt = dMul(dSmoothstep(0.39, 0.50, regional.landMask),
        dConst(1.0) - dSmoothstep(0.68, 0.85, regional.landMask));
    if (coastalBelt.x > 0.0) {
        let coastalMass = fbmAuto_d(unitDir, 11.0, 2, seed + 17617, 2.0, 0.5);
        let coastalHill = fbmAuto_d(unitDir, 5.5, 2, seed + 17683, 2.0, 0.5);
        let coastalDetail = fbmAuto_d(unitDir, 1.8, 1, seed + 17771, 2.0, 0.5);
        let rawCoastalShape = dSmoothstep(-0.48, 0.55, coastalHill + coastalMass * 0.55 + coastalDetail * 0.45);
        let coastalShapes = dMul(rawCoastalShape, rawCoastalShape);
        let coastalPresence = dSmoothstep(-0.35, 0.05, coastalMass);
        return dMul(dMul(coastalBelt, coastalShapes), coastalPresence) * (900.0 / maxTerrainHeightM());
    }
    return dConst(0.0);
}
`;

export const coastalCovesWgsl = `
fn coastalCoves_d(unitDir: vec3<f32>, seed: i32, original: RegionalInfoD) -> RegionalInfoD {
    var regional = original;
    // Bend the continental shoreline within a narrow band of the land mask.
    let coveBelt = dMul(dSmoothstep(0.33, 0.43, regional.landMask),
        dConst(1.0) - dSmoothstep(0.65, 0.76, regional.landMask));
    if (coveBelt.x > 0.0) {
        let coveWide = fbmAuto_d(unitDir, 12.0, 2, seed + 22819, 2.0, 0.5);
        let coveDetail = fbmAuto_d(unitDir, 5.0, 1, seed + 22909, 2.0, 0.5);
        regional.landMask = dClamp(regional.landMask + dMul(coveBelt, coveWide * 0.75 + coveDetail * 0.25) * 0.34, 0.0, 1.0);
        if (smallPlanetMode()) {
            regional.baseElevation = (regional.landMask - dConst(0.5)) * 1.6;
        } else {
            regional.baseElevation = dClamp((regional.landMask - dConst(0.32)) * (1.0 / 0.68), 0.0, 1.0);
        }
    }
    return regional;
}
`;
