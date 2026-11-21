export const fellsWgsl = /* wgsl */ `
// Connected upland summits and shorter shoulders, with broad saddles.
fn fellDome_d(x: vec4<f32>, y: vec4<f32>, halfX: f32, halfY: f32, skew: f32) -> vec4<f32> {
    let u = x * (1.0 / halfX);
    let v = (y - x * skew) * (1.0 / halfY);
    return dConst(1.0) - dSmoothstep(0.0, 1.0, dMul(u, u) + dMul(v, v));
}

fn fellRelief_d(p: vec3<f32>, seed: i32, landMask: vec4<f32>, mountains: vec4<f32>) -> vec4<f32> {
    if (landMask.x <= 0.57) { return dConst(0.0); }
    let site = mtnSite(mtnFacePos(p), 48000.0, 2.35e-10, 0x4eb12bd7u);
    if (!site.ok) { return dConst(0.0); }
    var hash = site.h;
    let scale = mix(0.85, 1.2, mtnRand(&hash));
    let angle = mtnRand(&hash) * 6.2831853;
    let phase = mtnRand(&hash) * 6.2831853;
    let height = mix(680.0, 1030.0, mtnRand(&hash)) * scale;
    let cap = 11100.0 * scale / noiseReferenceRadiusM();
    let placed = mtnPlace(site, &hash, cap);
    if (!placed.ok || dot(p, placed.c) < cos(cap)) { return dConst(0.0); }

    let l = mtnLocal(p, placed.c, angle);
    let x = l.X * (1.0 / scale);
    let y = l.Y * (1.0 / scale) + dSin(x * (1.0 / 2300.0) + dConst(phase)) * 575.0;
    let base = fellDome_d(x, y, 8400.0, 4900.0, 0.19);
    let main = fellDome_d(x + dConst(2500.0), y, 4300.0, 3050.0, -0.35);
    let sister = fellDome_d(x - dConst(2450.0), y - dConst(640.0), 3900.0, 2850.0, 0.41);
    let spur = fellDome_d(x - dConst(530.0), y + dConst(1950.0), 3150.0, 3400.0, -0.63);
    let envelope = base * 0.45 + main * 0.56 + sister * 0.36 + spur * 0.22;
    if (envelope.x <= 0.0) { return dConst(0.0); }
    let localRelief = fbmAuto_d(p, 2.2, 2, seed + 49117, 2.0, 0.5) * 46.0;
    let maxH = maxTerrainHeightM();
    let shape = dMul(envelope, dConst(height) + localRelief);
    let weight = dMul(dSmoothstep(0.57, 0.77, landMask), dSmoothstep(0.0, 90.0, shape));
    // A fell takes over from lower hills without stacking onto nearby peaks.
    let joined = dSmoothMax(mountains, shape * (1.0 / maxH), 60.0 / maxH);
    return dMul(weight, joined - mountains);
}
`;
