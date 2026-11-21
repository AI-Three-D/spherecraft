// TERRAIN_REWORK_CANYON_TRIAL
// Canyon country: a raised tableland ending in an escarpment, dissected by
// meandering trunk canyons and shallower tributaries.
// - Every cut is a function of the distance (metres) to a zero isoline of a
//   warped noise field (|n| / |grad n|), so a wall has the same designed
//   profile at any orientation: flat floor, concave talus, caprock cliff,
//   rim (peak slope about 1, within the grid's budget).
// - Trunk canyons keep only isoline stretches running along the regional
//   drainage (outward, toward the escarpment): no closed loops, and each
//   canyon ends upstream in a valley head.
// - Floors reach the surrounding lowland, so canyons drain out through the
//   escarpment. Tributaries are deep near a trunk, shallow draws far away.
// - Hills and foothills combine by a smooth maximum (buttes rise out of the
//   tableland, no moats); rolling and meso relief are calmed on top.
// - The tableland counts as erosion relief: the gully filter carves walls.

struct CanyonLand {
    h: vec4<f32>,       // height to add (normalized, dual)
    relief: vec4<f32>,  // erosion relief (normalized, dual)
    calm: vec4<f32>,    // multiplier for rolling and meso relief
}

const CANYON_PROV_T: f32 = 0.22;
// Mean wall slope (depth / horizontal extent) of the designed profile.
const CANYON_WALL_SLOPE: f32 = 0.85;

fn canyonTangent(g: vec3<f32>, unitDir: vec3<f32>) -> vec3<f32> {
    return (g - unitDir * dot(unitDir, g)) * (1.0 / noiseReferenceRadiusM());
}

// Distance (m) to the zero isoline of n; n's gradient is w.r.t. unitDir.
// gRef (per metre, ~0.8 / wavelength) is a soft floor on |grad n|: where
// the field is flat the estimate shrinks (wider cut) instead of compressing
// the wall. The gradient of the distance treats |grad n| as constant.
fn canyonIsoDist_d(n: vec4<f32>, unitDir: vec3<f32>, gRef: f32) -> vec4<f32> {
    let gt = length(canyonTangent(n.yzw, unitDir));
    let g = sqrt(gt * gt + gRef * gRef);
    return vec4<f32>(abs(n.x) / g, n.yzw * (sign(n.x) / g));
}

fn canyonSignedDist_d(n: vec4<f32>, unitDir: vec3<f32>, gRef: f32) -> vec4<f32> {
    let gt = length(canyonTangent(n.yzw, unitDir));
    return n * (1.0 / sqrt(gt * gt + gRef * gRef));
}

// Wall profile: s 0 (foot) .. 1 (rim) -> height fraction 0 .. 1. A ramp
// with C1 fillets of width r at foot and rim (near-constant wall slope,
// peak 1 / (1 - r) x mean; no crease for the vertex grid to alias), plus
// benches as a smooth modulation in height: slope x (1 + bench cos(2 pi N u)).
fn canyonWall_d(s: vec4<f32>, bench: f32) -> vec4<f32> {
    let r = 0.2;
    var f: vec4<f32>;
    if (s.x < r) {
        f = dMul(s, s) * (0.5 / r);
    } else if (s.x > 1.0 - r) {
        let q = dConst(1.0) - s;
        f = dConst(1.0 - r) - dMul(q, q) * (0.5 / r);
    } else {
        f = s - dConst(0.5 * r);
    }
    let u = f * (1.0 / (1.0 - r));
    let k = 6.2831853 * 2.0;
    return u + dSin(u * k) * (bench / k);
}

// One shared domain warp (single octave, shear ~0.55) for the canyon
// fields; a field read at the warped position has its gradient pulled back
// to unitDir.
fn canyonWarp(unitDir: vec3<f32>, seed: i32) -> WarpedDir {
    let wa = fbmAuto_d(unitDir, 2.0, 1, seed, 2.0, 0.5);
    let wb = fbmAuto_d(unitDir, 2.0, 1, seed + 11, 2.0, 0.5);
    let wc = fbmAuto_d(unitDir, 2.0, 1, seed + 23, 2.0, 0.5);
    return makeWarpedDir(unitDir, wa, wb, wc, 700.0 / noiseReferenceRadiusM());
}

fn canyonWarpedField_d(w: WarpedDir, fieldKm: f32, seed: i32) -> vec4<f32> {
    let n = fbmAuto_d(w.d, fieldKm, 1, seed, 2.0, 0.5);
    return vec4<f32>(n.x, pullbackWarp(w, n.yzw));
}

fn canyonLand_d(unitDir: vec3<f32>, seed: i32, regional: RegionalInfoD, largeRelief: vec4<f32>) -> CanyonLand {
    var o: CanyonLand;
    o.h = dConst(0.0);
    o.relief = dConst(0.0);
    o.calm = dConst(1.0);
    let maxH = maxTerrainHeightM();
    // Province: a broad field on interior land.
    let prov = fbmAuto_d(unitDir, 70.0, 2, seed + 31000, 2.0, 0.5);
    if (prov.x < CANYON_PROV_T - 0.10) { return o; }
    let inland = dSmoothstep(0.52, 0.64, regional.landMask);
    if (inland.x <= 0.0) { return o; }
    // Escarpment line: province plus lobes, promontories and outliers.
    let lobes = fbmAuto_d(unitDir, 8.0, 2, seed + 31050, 2.0, 0.5);
    let edgeN = prov - dConst(CANYON_PROV_T) + lobes * 0.13;
    if (edgeN.x <= 0.0) { return o; }
    // Scallops: the rim line wanders (alcoves and buttresses).
    let scallop = fbmAuto_d(unitDir, 1.2, 2, seed + 31060, 2.0, 0.5) * 210.0;
    let dEdge = canyonSignedDist_d(edgeN, unitDir, 2.5e-5) + scallop;
    // Tableland height above the surrounding lowland.
    let pVar = fbmAuto_d(unitDir, 24.0, 1, seed + 31070, 2.0, 0.5);
    let P = dConst(300.0) + dSmoothstep(-0.3, 0.3, pVar) * 320.0;
    let wallW = P.x / CANYON_WALL_SLOPE;
    let charV = smoothstep(-0.3, 0.3, fbmAuto_d(unitDir, 30.0, 1, seed + 31080, 2.0, 0.5).x);
    let bench = mix(0.0, 0.25, charV);
    let uEdge = canyonWall_d(dClamp(dEdge * (1.0 / wallW), 0.0, 1.0), bench);
    // Trunk canyons: meandering isolines, broken into separate canyons by
    // a presence field (its ramps are the valley heads: >= 2 km long).
    let warp = canyonWarp(unitDir, seed + 31100);
    let n1 = canyonWarpedField_d(warp, 10.0, seed + 31140);
    let along = dSmoothstep(-0.12, 0.18, fbmAuto_d(unitDir, 14.0, 1, seed + 31150, 2.0, 0.5));
    let d1 = canyonIsoDist_d(n1, unitDir, 8.0e-5);
    let floor1 = 90.0 + 110.0 * charV;
    let s1 = dClamp((d1 + scallop - dConst(floor1)) * (1.0 / wallW), 0.0, 1.0);
    let u1 = dConst(1.0) - dMul(dConst(1.0) - canyonWall_d(s1, bench), along);
    // Tributaries: deep where they join a trunk, shallow draws far away.
    let n2 = canyonWarpedField_d(warp, 3.2, seed + 31240);
    let d2 = canyonIsoDist_d(n2, unitDir, 2.5e-4);
    let reach = dMul(dConst(1.0) - dSmoothstep(600.0, 4000.0, d1), along);
    let k2 = dConst(0.25) + reach * 0.70;
    let s2 = dClamp((d2 + scallop * 0.6 - dConst(35.0)) * (1.0 / max(k2.x * wallW, 120.0)), 0.0, 1.0);
    let u2 = dConst(1.0) - dMul(k2, dConst(1.0) - canyonWall_d(s2, bench));
    // Side gullies: short, cut back into the rims beside larger canyons.
    let n3 = fbmAuto_d(unitDir, 1.4, 1, seed + 31300, 2.0, 0.5);
    let d3 = canyonIsoDist_d(n3, unitDir, 5.7e-4);
    let near = dConst(1.0) - dSmoothstep(250.0, 1400.0, dSmoothMin(d1, d2, 150.0));
    let k3 = near * 0.30;
    let s3 = dClamp((d3 - dConst(15.0)) * (1.0 / max(k3.x * wallW * 1.4, 120.0)), 0.0, 1.0);
    let u3 = dConst(1.0) - dMul(k3, dConst(1.0) - canyonWall_d(s3, bench));
    // Remaining fraction of the tableland: the deepest cut wins.
    let cuts = dSmoothMin(u1, dSmoothMin(u2, u3, 0.04), 0.04);
    let u = dMax(dSmoothMin(uEdge, cuts, 0.04), dConst(0.0));
    let top = dMul(dMul(P, u), inland);
    // Hills and foothills: smooth maximum with the tableland (buttes).
    let R = largeRelief * maxH;
    let comb = dSmoothMax(R, top + R * 0.15, 60.0);
    let addM = comb - R;
    o.h = addM * (1.0 / maxH);
    o.relief = top * (1.0 / maxH);
    o.calm = dConst(1.0) - dMul(dSmoothstep(0.0, 0.3, uEdge), inland) * 0.85;
    return o;
}
