// TERRAIN_REWORK_CANYON_TRIAL
// Sparse, contained drainage-shaped cuts on existing high ground.
// Distances and heights are in metres; the local basis and candidate-cell
// plumbing are shared with the existing mountain placement.
fn canyonNetwork_d(p: vec3<f32>, seed: i32, regional: RegionalInfoD) -> vec4<f32> {
    let site = mtnSite(mtnFacePos(p), 72000.0, 0.00022e-6, 0x5c35a293u);
    if (!site.ok) { return dConst(0.0); }
    var h = site.h;
    let lengthM = mix(24000.0, 34000.0, mtnRand(&h));
    let widthChoice = mtnRand(&h);
    let depthM = mix(400.0, 620.0, mtnRand(&h));
    // Wider transitions on deeper cuts keep their contribution grid-friendly.
    let widthM = max(mix(2600.0, 3800.0, widthChoice), depthM * 6.5);
    let angle = mtnRand(&h) * 6.2831853;
    let phase0 = mtnRand(&h) * 6.2831853;
    let phase1 = mtnRand(&h) * 6.2831853;
    let footprintM = sqrt(0.25 * lengthM * lengthM + 11500.0 * 11500.0);
    let s = mtnPlace(site, &h, footprintM / noiseReferenceRadiusM());
    if (!s.ok || dot(p, s.c) < cos(footprintM / noiseReferenceRadiusM())) { return dConst(0.0); }
    if (mtnHighland(s.c, seed) < 0.2) { return dConst(0.0); }
    let l = mtnLocal(p, s.c, angle);
    let t = l.X * (2.0 / lengthM);
    if (abs(t.x) >= 1.0 || abs(l.Y.x) >= 10800.0) { return dConst(0.0); }
    let spine = dSin(l.X * (1.0 / 2600.0) + dConst(phase0)) * 1500.0
        + dSin(l.X * (1.0 / 1300.0) + dConst(phase1)) * 300.0;
    let width = (dConst(0.86) + dSin(l.X * (1.0 / 5300.0) + dConst(phase1)) * 0.14) * widthM;
    let cross = dDiv(dAbs(l.Y - spine), width);
    var channel = dConst(1.0) - dSmoothstep(0.22, 1.0, cross);
    for (var i = 0; i < 6; i++) {
        let side = select(-1.0, 1.0, mtnRand(&h) > 0.5);
        let join = mix(-0.65, 0.65, mtnRand(&h)) * lengthM * 0.5;
        let skew = mix(-1.0, 1.0, mtnRand(&h));
        let branchPhase = mtnRand(&h) * 6.2831853;
        let branchW = max(mix(1500.0, 2100.0, mtnRand(&h)), depthM * 4.0);
        let branchL = mix(4500.0, 7900.0, mtnRand(&h));
        let branchY = (l.Y - spine) * side;
        let branchBend = dMul(dSin(branchY * (3.1415927 / branchL)), dSin(branchY * (1.0 / 1200.0) + dConst(branchPhase))) * 450.0;
        let branchX = dAbs(l.X - dConst(join) - branchY * skew - branchBend) * (1.0 / branchW);
        let shape = dConst(1.0) - dSmoothstep(0.12, 1.0, branchX);
        let sideFade = dSmoothstep(-400.0, 800.0, branchY);
        let endFade = dConst(1.0) - dSmoothstep(branchL * 0.65, branchL, branchY);
        let branch = dMul(dMul(shape, sideFade), endFade) * 0.60;
        channel += dMul(branch, dConst(1.0) - channel);
    }
    let endFade = dConst(1.0) - dSmoothstep(0.65, 1.0, dAbs(t));
    let land = dSmoothstep(0.50, 0.64, regional.landMask);
    let depthVariation = dConst(0.83) + dSin(l.X * (1.0 / 6900.0) + dConst(phase0)) * 0.17;
    let cut = dMul(dMul(channel, endFade), depthVariation) * (-depthM);
    return dMul(land, cut) * (1.0 / maxTerrainHeightM());
}
