// Carve broad, bounded channels from the selected mountain range profile.
export const mountainValleysWgsl = `
fn valleyRange_d(p: vec3<f32>, site: MtnSite, seed: i32) -> vec4<f32> {
    var h = site.h;
    let L = mix(MTN_RANGE_LEN_MIN, MTN_RANGE_LEN_MAX, mtnRand(&h));
    let W = mix(MTN_RANGE_HALF_W_MIN, MTN_RANGE_HALF_W_MAX, mtnRand(&h));
    // Consume the height draw to keep the same site geometry as the range.
    _ = mtnRand(&h);
    let bend = (mtnRand(&h) - 0.5) * 0.5 * L;
    let wig = (mtnRand(&h) - 0.5) * 0.12 * L;
    let maxSlope = (4.0 * abs(bend) + 9.43 * abs(wig)) / L;
    let lateral = abs(bend) + abs(wig) + 2.75 * W * sqrt(1.0 + maxSlope * maxSlope) + 0.1 * W;
    let ang = sqrt(0.25 * L * L + lateral * lateral) / noiseReferenceRadiusM();
    let s = mtnPlace(site, &h, ang);
    if (!s.ok || dot(p, s.c) < cos(ang)) { return dConst(0.0); }
    let hl = mtnHighland(s.c, seed);
    if (mtnRand(&h) >= mix(MTN_RANGE_LOWLAND_CHANCE, 1.0, hl)) { return dConst(0.0); }
    let l0 = mtnLocal(p, s.c, mtnRand(&h) * 3.1415927);
    let l = mtnWarp(l0, 0.04 * W, 1.5 * W, mtnRand(&h) * 6.2831853, mtnRand(&h) * 6.2831853);
    let phase = mtnRand(&h) * 6.2831853;
    let t = l.X * (2.0 / L);
    if (abs(t.x) >= 1.0) { return dConst(0.0); }
    let t2 = dMul(t, t);
    let arg = t * 4.712389 + dConst(phase);
    let centre = (dConst(1.0) - t2) * bend + dSin(arg) * wig;
    let slope = (t * (-2.0 * bend) + dCos(arg) * (wig * 4.712389)) * (2.0 / L);
    let lateralPos = dDiv(l.Y - centre, dSqrt(dConst(1.0) + dMul(slope, slope)));
    // Site-seeded curvature varies on a kilometre scale. Keep it a function
    // of the along-range coordinate so the cross section stays coherent.
    let meanderSeed = bitcast<i32>(site.h ^ bitcast<u32>(seed) ^ 0x81a44cfdu);
    let along = l.X * (1.0 / 11000.0);
    let n0 = perlin3D_d(vec3<f32>(along.x, 0.31, 1.17), meanderSeed);
    let n1 = perlin3D_d(vec3<f32>(along.x * 2.0, 0.31, 1.17), meanderSeed + 1);
    let meander = vec4<f32>(n0.x + 0.35 * n1.x, along.yzw * (n0.y + 0.70 * n1.y));
    let cross = lateralPos - meander * (0.48 * W);
    var widthHash = site.h ^ 0xa14e672bu;
    let widthPhase = mtnRand(&widthHash) * 6.2831853;
    let widthPhase2 = mtnRand(&widthHash) * 6.2831853;
    let widthWave = dSin(t * 4.1 + dConst(widthPhase));
    let widthWave2 = dSin(t * 8.3 + dConst(widthPhase2));
    let widthBase = dConst(0.50) + widthWave * 0.12 + widthWave2 * 0.05;
    let sideMix = dSmoothstep(-0.25, 0.25, cross * (1.0 / W));
    let sideWidth = dMix(dConst(0.82), dConst(1.18), sideMix);
    let across = dDiv(cross, dMul(widthBase,sideWidth) * W);
    let distance = dClamp(dAbs(across), 0.0, 1.0);
    let rounded = dConst(1.0) - dQuintic(dMul(distance,distance));
    let vshape = dConst(1.0) - dQuintic(distance);
    let valley = dMix(rounded, vshape, dConst(0.2) + dSmoothstep(-0.7, 0.7, widthWave) * 0.4);
    var field = valley;
    for (var i = 0; i < 3; i++) {
        let side = select(-1.0, 1.0, mtnRand(&h) > 0.5);
        let join = mix(-0.65, 0.0, mtnRand(&h));
        let spread = mix(1.5, 2.3, mtnRand(&h));
        let branchWidth = mix(0.18, 0.30, mtnRand(&h));
        let end = mix(0.55, 0.93, mtnRand(&h));
        let progress = dClamp((t - dConst(join)) * (1.0 / (end - join)), 0.0, 1.0);
        let branchPhase = mtnRand(&h) * 6.2831853;
        let branchWave = dSin(progress * 4.712389 + dConst(branchPhase)) * (0.22 * W);
        let branchCentre = progress * (side * spread * W) + dMul(dSin(progress * 3.1415927), branchWave);
        let branchPos = (cross - branchCentre) * (1.0 / (W * branchWidth));
        let branchProfile = dConst(1.0) - dQuintic(dClamp(dMul(branchPos, branchPos), 0.0, 1.0));
        let startFade = dSmoothstep(0.02, 0.25, progress);
        let endFade = dConst(1.0) - dSmoothstep(0.72, 1.0, progress);
        let branch = dMul(dMul(branchProfile, startFade), endFade) * 0.45;
        field += dMul(branch, dConst(1.0) - field);
    }
    let ends = dConst(1.0) - dQuintic(dClamp((t2 - dConst(0.25)) * (1.0 / 0.75), 0.0, 1.0));
    let depthWave = dSin(t * 3.3 + dConst(widthPhase2));
    let depth = dConst(0.94) + depthWave * 0.06;
    return dMul(dMul(field, ends), depth);
}

`;
