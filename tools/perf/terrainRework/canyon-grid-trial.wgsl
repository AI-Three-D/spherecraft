// TERRAIN_REWORK_CANYON_TRIAL
// Parked 2026-11-20: wide smooth walls, but the layout still reads as a stamp.
// Review-only; not selected by the normal game or default comparison server.
// A bounded, low plateau with explicitly wide canyon walls. All distances
// are analytic duals; there are no noise-isoline distance approximations.
fn canyonCompose_d(p: vec3<f32>, seed: i32, regional: RegionalInfoD, input: LandBands) -> LandBands {
    var out = input;
    let site = mtnSite(mtnFacePos(p), 72000.0, 0.00022e-6, 0x5c35a293u);
    if (!site.ok) { return out; }
    var h = site.h;
    let lengthM = mix(24000.0, 34000.0, mtnRand(&h));
    let unused = mtnRand(&h);
    let depthM = mix(360.0, 440.0, mtnRand(&h));
    let angle = mtnRand(&h) * 6.2831853;
    let phase0 = mtnRand(&h) * 6.2831853;
    let phase1 = mtnRand(&h) * 6.2831853;
    let footprint = sqrt(0.25 * lengthM * lengthM + 11500.0 * 11500.0);
    let s = mtnPlace(site, &h, footprint / noiseReferenceRadiusM());
    if (!s.ok || dot(p, s.c) < cos(footprint / noiseReferenceRadiusM())) { return out; }
    if (mtnHighland(s.c, seed) < 0.2) { return out; }
    let l = mtnLocal(p, s.c, angle);
    let t = l.X * (2.0 / lengthM);
    let land = dSmoothstep(0.50, 0.64, regional.landMask);
    let coverX = dConst(1.0) - dSmoothstep(0.55, 1.0, dAbs(t));
    let coverY = dConst(1.0) - dSmoothstep(6500.0, 10800.0, dAbs(l.Y));
    var cover = dMul(dMul(land, coverX), coverY);
    if (cover.x <= 0.0) { return out; }
    let spine = dSin(l.X * (1.0 / 4500.0) + dConst(phase0)) * 1050.0
        + dSin(l.X * (1.0 / 2200.0) + dConst(phase1)) * 170.0;
    let across = l.Y - spine;
    let width = (dConst(1.0) + dSin(l.X * (1.0 / 6000.0) + dConst(phase1)) * 0.12) * 1400.0;
    var cut = dConst(1.0) - dSmoothstep(0.0, 1.0, dDiv(dAbs(across) - dConst(170.0), width));
    // Only three staggered tributaries, each meeting the trunk downstream.
    // Their wall widths exceed their depth; the deepest cut wins smoothly.
    for (var i = 0; i < 3; i++) {
        let side = select(-1.0, 1.0, (i % 2) == 0);
        let join = (-0.48 + f32(i) * 0.37 + mtnRand(&h) * 0.12) * lengthM * 0.5;
        let branchY = across * side;
        let branchL = mix(4300.0, 5900.0, mtnRand(&h));
        let branchX = l.X - dConst(join) - branchY * 0.65
            - dSin(branchY * (1.0 / 1700.0) + dConst(phase1)) * 200.0;
        let branch = dMul(dConst(1.0) - dSmoothstep(80.0, 1250.0, dAbs(branchX)),
            dMul(dSmoothstep(-600.0, 700.0, branchY), dConst(1.0) - dSmoothstep(2300.0, branchL, branchY))) * 0.8;
        cut = dSmoothMax(cut, branch, 0.08);
    }
    let large = featureBigHillsHeight_d(p, seed, getTerrainAmplitudes(getTerrainProfile())) + featureMountainsHeight_d(p, seed);
    cover = dMul(cover, dConst(1.0) - dSmoothstep(250.0, 850.0, large * maxTerrainHeightM()));
    let base = input.b0 - large;
    let lowDetail = fbmAuto_d(p, 2.8, 2, seed + 31950, 2.0, 0.5) * 18.0;
    let shape = dConst(depthM) - cut * (depthM * 0.93) + lowDetail;
    let original = input.b0 + input.b1 + input.b2 + input.b3;
    let surface = base + shape * (1.0 / maxTerrainHeightM());
    out.b0 += dMul(surface - original, cover);
    return out;
}
