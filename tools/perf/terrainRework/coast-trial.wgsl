// TERRAIN_REWORK_COAST_RELIEF_TRIAL
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
    b0 += dMul(dMul(coastalBelt, coastalShapes), coastalPresence) * (900.0 / maxTerrainHeightM());
}
