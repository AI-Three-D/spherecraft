export const fjordsWgsl = /* wgsl */ `
struct FjordProfile {
    cut: vec4<f32>,
    shoulders: vec4<f32>,
}

fn fjordCoastMask(dir: vec3<f32>, seed: i32, profile: TerrainProfile) -> vec4<f32> {
    return getRegionalCharacter_d(dir, seed, profile).landMask;
}

fn fjordProfile_d(p: vec3<f32>, seed: i32, profile: TerrainProfile, landMask: vec4<f32>) -> FjordProfile {
    var result: FjordProfile;
    let site = mtnSite(mtnFacePos(p), 69000.0, 3.1e-10, 0x3c95f971u);
    if (!site.ok) { return result; }
    var hash = site.h;
    let scale = mix(0.88, 1.18, mtnRand(&hash));
    let phase = mtnRand(&hash) * 6.2831853;
    let radius = noiseReferenceRadiusM();
    let cap = 17400.0 * scale / radius;
    let placed = mtnPlace(site, &hash, cap);
    if (!placed.ok || dot(p, placed.c) < cos(cap)) { return result; }

    // Orient each inlet across the coast. Require open water at the mouth
    // and rising land toward the head, so a coast-parallel cut cannot qualify.
    let coast = fjordCoastMask(placed.c, seed, profile);
    let gradient = coast.yzw - placed.c * dot(placed.c, coast.yzw);
    if (coast.x < 0.16 || coast.x > 0.73 || length(gradient) < 0.001) { return result; }
    let inland = normalize(gradient);
    let mouth = normalize(placed.c - inland * (10000.0 * scale / radius));
    let head = normalize(placed.c + inland * (8700.0 * scale / radius));
    if (fjordCoastMask(mouth, seed, profile).x >= 0.24 || fjordCoastMask(head, seed, profile).x < 0.57) {
        return result;
    }

    let up = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), abs(placed.c.y) > 0.9);
    let b1 = normalize(cross(placed.c, up));
    let b2 = cross(placed.c, b1);
    let frame = mtnLocal(p, placed.c, atan2(dot(inland, b2), dot(inland, b1)));
    let x = frame.X * (1.0 / scale);
    let y = frame.Y * (1.0 / scale);
    let bend = dSin(x * (1.0 / 2900.0) + dConst(phase)) * 1120.0
        + dSin(x * (1.0 / 1750.0) - dConst(phase)) * 380.0;
    let across = dAbs(y - bend);
    let width = dConst(1.0) + dSin(x * (1.0 / 4700.0) + dConst(phase)) * 0.20;
    let q = dDiv(across, width);
    let ends = dMul(dSmoothstep(-14700.0, -9700.0, x), dConst(1.0) - dSmoothstep(6200.0, 14300.0, x));
    result.cut = dMul(ends, dConst(1.0) - dSmoothstep(640.0, 3220.0, q));

    // A broad, asymmetric glacial trough. The outer walls roll back into
    // the previous coastal relief rather than resetting the coastal belt.
    let wall = dMul(dSmoothstep(1050.0, 3240.0, q), dConst(1.0) - dSmoothstep(3390.0, 5600.0, q));
    let variation = dConst(0.76) + dSin(x * (1.0 / 1880.0) + y * (1.0 / 2400.0)) * 0.24;
    result.shoulders = dMul(dMul(dMul(wall, ends), variation), dSmoothstep(0.40, 0.68, landMask))
        * (810.0 * scale / maxTerrainHeightM());
    // The outer cap is guaranteed to fade to zero even at the largest bend.
    let edge = dSmoothstep(cos(cap), cos(cap * 0.90), vec4<f32>(dot(p, placed.c), placed.c));
    result.cut = dMul(result.cut, edge);
    result.shoulders = dMul(result.shoulders, edge);
    return result;
}

fn fjordFloor() -> vec4<f32> {
    return dConst(uniforms.waterParams.y - 235.0 / maxTerrainHeightM());
}

fn fjordCutWeight_d(ground: vec4<f32>, floor: vec4<f32>) -> vec4<f32> {
    return dSmoothstep(0.0, 40.0 / maxTerrainHeightM(), ground - floor);
}
`;
