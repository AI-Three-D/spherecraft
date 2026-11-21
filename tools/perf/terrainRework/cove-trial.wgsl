// TERRAIN_REWORK_COAST_MASK_TRIAL
// Deform the edge itself rather than excavating isolated basins inland.
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
