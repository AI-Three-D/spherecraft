fn rangeDirectionalNoise_d(l: MtnLocal, seed: i32) -> vec4<f32> {
    let u = l.X * (1.0 / 18000.0);
    let v = l.Y * (1.0 / 7000.0);
    let n0 = perlin3D_d(vec3<f32>(u.x, v.x, 0.37), seed);
    let n1 = perlin3D_d(vec3<f32>(u.x * 2.0, v.x * 2.0, 0.37), seed + 1);
    let n2 = perlin3D_d(vec3<f32>(u.x * 4.0, v.x * 4.0, 0.37), seed + 2);
    let value = (n0.x + n1.x * 0.5 + n2.x * 0.25) / 1.75;
    let gu = (n0.y + n1.y + n2.y) / 1.75;
    let gv = (n0.z + n1.z + n2.z) / 1.75;
    return vec4<f32>(value, u.yzw * gu + v.yzw * gv);
}

fn mtnRange_d(p: vec3<f32>, site: MtnSite, seed: i32) -> vec4<f32> {
    var h = site.h;
    let L = mix(MTN_RANGE_LEN_MIN, MTN_RANGE_LEN_MAX, mtnRand(&h));
    let W = mix(MTN_RANGE_HALF_W_MIN, MTN_RANGE_HALF_W_MAX, mtnRand(&h));
    let H0 = mix(MTN_RANGE_H_MIN, MTN_RANGE_H_MAX, mtnRand(&h));
    let bend = (mtnRand(&h) - 0.5) * 0.5 * L;
    let wig = (mtnRand(&h) - 0.5) * 0.12 * L;
    let maxSlope = (4.0 * abs(bend) + 9.43 * abs(wig)) / L;
    let lateral = abs(bend) + abs(wig) + 2.75 * W * sqrt(1.0 + maxSlope * maxSlope) + 0.1 * W;
    let ang = sqrt(0.25 * L * L + lateral * lateral) / noiseReferenceRadiusM();
    let s = mtnPlace(site, &h, ang);
    if (!s.ok || dot(p, s.c) < cos(ang)) { return dConst(0.0); }
    let hl = mtnHighland(s.c, seed);
    if (mtnRand(&h) >= mix(MTN_RANGE_LOWLAND_CHANCE, 1.0, hl)) { return dConst(0.0); }
    let H = H0 * mix(0.85, 1.0, hl);
    let l0 = mtnLocal(p, s.c, mtnRand(&h) * 3.1415927);
    let l = mtnWarp(l0, 0.04 * W, 1.5 * W, mtnRand(&h) * 6.2831853, mtnRand(&h) * 6.2831853);
    let wigPhase = mtnRand(&h) * 6.2831853;
    let t = l.X * (2.0 / L);
    if (abs(t.x) >= 1.0) { return dConst(0.0); }
    let t2 = dMul(t, t);
    let arg = t * 4.712389 + dConst(wigPhase);
    let ys = (dConst(1.0) - t2) * bend + dSin(arg) * wig;
    let dys = (t * (-2.0 * bend) + dCos(arg) * (wig * 4.712389)) * (2.0 / L);
    let across = dDiv(l.Y - ys, dSqrt(dConst(1.0) + dMul(dys, dys)));
    let distance = across * (1.0 / (2.2 * W));
    let skirt = dConst(1.0) - dQuintic(dClamp(dMul(distance,distance), 0.0, 1.0));
    let field = rangeDirectionalNoise_d(l, bitcast<i32>(site.h ^ bitcast<u32>(seed) ^ 0x749ce12du));
    let detailP = vec3<f32>(l.X.x * (1.0 / 3800.0), l.Y.x * (1.0 / 2700.0), 1.43);
    let noise = perlin3D_d(detailP, bitcast<i32>(site.h ^ bitcast<u32>(seed) ^ 0x78522e9du));
    let detail = vec4<f32>(noise.x, noise.y * l.X.yzw * (1.0 / 3800.0) + noise.z * l.Y.yzw * (1.0 / 2700.0));
    let ridges = dSmoothstep(-0.36, 0.36, field + detail * 0.42);
    let top = dConst(0.10) + ridges * 0.90;
    let ends = dConst(1.0) - dQuintic(dClamp((t2 - dConst(0.3)) * (1.0 / 0.7), 0.0, 1.0));
    return dMul(dMul(skirt,top),ends) * H;
}
